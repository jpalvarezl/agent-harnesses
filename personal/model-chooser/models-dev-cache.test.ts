import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { ModelsDevCache, isOfflineValue } from "./models-dev-cache.ts";
import { projectModelsDevCatalog } from "./models-dev.ts";

function rawCatalog(cost = { input: 1, output: 2 }) {
	return {
		models: { "vendor/model": { id: "vendor/model", name: "Model", family: "family" } },
		providers: {
			provider: {
				id: "provider",
				models: { model: { id: "model", name: "Model", family: "family", cost } },
			},
		},
	};
}

function cachedSnapshot(freshUntil: string) {
	return projectModelsDevCatalog(rawCatalog(), {
		fetchedAt: "2026-07-28T12:00:00.000Z",
		validatedAt: "2026-07-28T12:00:00.000Z",
		freshUntil,
		etag: 'W/"old"',
	});
}

async function tempCache(snapshot?: ReturnType<typeof cachedSnapshot>) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "models-dev-cache-"));
	const cachePath = path.join(dir, "models-dev-v1.json");
	if (snapshot) await fs.writeFile(cachePath, JSON.stringify(snapshot), "utf8");
	return { dir, cachePath };
}

test("recognizes supported PI_OFFLINE values", () => {
	assert.equal(isOfflineValue("1"), true);
	assert.equal(isOfflineValue("TRUE"), true);
	assert.equal(isOfflineValue("yes"), true);
	assert.equal(isOfflineValue("0"), false);
	assert.equal(isOfflineValue(undefined), false);
});

test("concurrent hydration shares one result", async () => {
	const { dir, cachePath } = await tempCache(cachedSnapshot("2026-07-30T12:00:00.000Z"));
	try {
		const cache = new ModelsDevCache({ cachePath });
		const first = cache.hydrate();
		const second = cache.hydrate();
		assert.equal(first, second);
		assert.equal((await first)?.etag, 'W/"old"');
		assert.equal((await second)?.etag, 'W/"old"');
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("fresh cache performs no network request", async () => {
	const { dir, cachePath } = await tempCache(cachedSnapshot("2026-07-30T12:00:00.000Z"));
	let calls = 0;
	try {
		const cache = new ModelsDevCache({
			cachePath,
			now: () => new Date("2026-07-29T12:00:00.000Z"),
			fetchImpl: async () => {
				calls += 1;
				return new Response("", { status: 500 });
			},
		});
		const result = await cache.refresh();
		assert.equal(result.status, "fresh");
		assert.equal(calls, 0);
		assert.equal(cache.getSnapshot()?.etag, 'W/"old"');
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("stale cache remains available while one shared refresh updates it", async () => {
	const { dir, cachePath } = await tempCache(cachedSnapshot("2026-07-28T13:00:00.000Z"));
	let calls = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	try {
		const cache = new ModelsDevCache({
			cachePath,
			now: () => new Date("2026-07-29T12:00:00.000Z"),
			fetchImpl: async () => {
				calls += 1;
				await gate;
				return new Response(JSON.stringify(rawCatalog({ input: 2, output: 4 })), {
					status: 200,
					headers: { "content-type": "application/json", etag: 'W/"new"' },
				});
			},
		});
		await cache.hydrate();
		const first = cache.refresh();
		const second = cache.refresh();
		assert.equal(cache.getSnapshot()?.etag, 'W/"old"');
		release();
		assert.equal((await first).status, "updated");
		assert.equal((await second).status, "updated");
		assert.equal(calls, 1);
		assert.equal(cache.getSnapshot()?.etag, 'W/"new"');
		assert.deepEqual(cache.getSnapshot()?.routes[0].cost, { input: 2, output: 4 });
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("forced refresh queued behind an in-flight background refresh still runs", async () => {
	const { dir, cachePath } = await tempCache(cachedSnapshot("2026-07-28T13:00:00.000Z"));
	let calls = 0;
	try {
		const cache = new ModelsDevCache({
			cachePath,
			now: () => new Date("2026-07-29T12:00:00.000Z"),
			fetchImpl: async () => {
				calls += 1;
				if (calls === 1) return new Response(null, { status: 304 });
				return new Response(JSON.stringify(rawCatalog({ input: 3, output: 6 })), {
					status: 200,
					headers: { "content-type": "application/json", etag: 'W/"forced"' },
				});
			},
		});
		const background = cache.refresh();
		const forced = cache.refresh({ force: true });
		assert.equal((await background).status, "not-modified");
		assert.equal((await forced).status, "updated");
		assert.equal(calls, 2);
		assert.equal(cache.getSnapshot()?.etag, 'W/"forced"');
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("304 extends freshness without replacing projected data", async () => {
	const { dir, cachePath } = await tempCache(cachedSnapshot("2026-07-28T13:00:00.000Z"));
	try {
		const cache = new ModelsDevCache({
			cachePath,
			now: () => new Date("2026-07-29T12:00:00.000Z"),
			ttlMs: 60_000,
			fetchImpl: async (_url, init) => {
				assert.equal((init?.headers as Record<string, string>)["if-none-match"], 'W/"old"');
				return new Response(null, { status: 304 });
			},
		});
		const result = await cache.refresh();
		assert.equal(result.status, "not-modified");
		assert.equal(result.snapshot?.fetchedAt, "2026-07-28T12:00:00.000Z");
		assert.equal(result.snapshot?.validatedAt, "2026-07-29T12:00:00.000Z");
		assert.equal(result.snapshot?.freshUntil, "2026-07-29T12:01:00.000Z");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("HTTP and malformed-payload failures preserve stale cache", async () => {
	for (const response of [
		new Response("nope", { status: 503 }),
		new Response(JSON.stringify({ models: {}, providers: {} }), {
			status: 200,
			headers: { "content-type": "application/json" },
		}),
	]) {
		const { dir, cachePath } = await tempCache(cachedSnapshot("2026-07-28T13:00:00.000Z"));
		try {
			const cache = new ModelsDevCache({
				cachePath,
				now: () => new Date("2026-07-29T12:00:00.000Z"),
				fetchImpl: async () => response,
			});
			const result = await cache.refresh();
			assert.equal(result.status, "error");
			assert.equal(result.snapshot?.etag, 'W/"old"');
			const onDisk = JSON.parse(await fs.readFile(cachePath, "utf8"));
			assert.equal(onDisk.etag, 'W/"old"');
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}
});

test("offline mode hydrates cache and never fetches", async () => {
	const { dir, cachePath } = await tempCache(cachedSnapshot("2026-07-28T13:00:00.000Z"));
	let calls = 0;
	try {
		const cache = new ModelsDevCache({
			cachePath,
			offline: () => true,
			fetchImpl: async () => {
				calls += 1;
				return new Response(JSON.stringify(rawCatalog()), { status: 200 });
			},
		});
		const result = await cache.refresh({ force: true });
		assert.equal(result.status, "offline");
		assert.equal(result.snapshot?.etag, 'W/"old"');
		assert.equal(calls, 0);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("corrupt disk cache is ignored safely", async () => {
	const { dir, cachePath } = await tempCache();
	try {
		await fs.writeFile(cachePath, "{broken", "utf8");
		const cache = new ModelsDevCache({ cachePath, offline: () => true });
		assert.equal(await cache.hydrate(), undefined);
		assert.equal((await cache.refresh()).status, "offline");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
