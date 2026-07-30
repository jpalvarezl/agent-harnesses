import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { CopilotCatalogCache } from "./copilot-catalog-cache.ts";
import { projectCopilotCatalog } from "./copilot-catalog.ts";

const entries = [{ id: "model", vendor: "Vendor", capabilities: { family: "family" } }];

async function tempCache(freshUntil?: string) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-catalog-"));
	const cachePath = path.join(dir, "catalog.json");
	if (freshUntil) {
		const snapshot = projectCopilotCatalog(entries, {
			fetchedAt: "2026-07-29T12:00:00.000Z",
			freshUntil,
		});
		await fs.writeFile(cachePath, JSON.stringify(snapshot), "utf8");
	}
	return { dir, cachePath };
}

test("fresh cache skips authenticated loader", async () => {
	const { dir, cachePath } = await tempCache("2026-07-30T12:00:00.000Z");
	let calls = 0;
	try {
		const cache = new CopilotCatalogCache({ cachePath, now: () => new Date("2026-07-29T13:00:00.000Z") });
		const result = await cache.refresh(async () => {
			calls += 1;
			return entries;
		});
		assert.equal(result.status, "fresh");
		assert.equal(calls, 0);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("stale refresh projects, persists, and shares concurrent loader", async () => {
	const { dir, cachePath } = await tempCache("2026-07-28T12:00:00.000Z");
	let calls = 0;
	try {
		const cache = new CopilotCatalogCache({ cachePath, now: () => new Date("2026-07-29T13:00:00.000Z") });
		const loader = async () => {
			calls += 1;
			return [...entries, { id: "other", vendor: "Other", capabilities: { family: "other" } }];
		};
		const first = cache.refresh(loader);
		const second = cache.refresh(loader);
		assert.equal(first, second);
		assert.equal((await first).status, "updated");
		assert.equal(calls, 1);
		assert.equal(cache.getSnapshot()?.models.length, 2);
		assert.equal(JSON.parse(await fs.readFile(cachePath, "utf8")).models.length, 2);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("forced refresh queued behind an in-flight refresh runs its own loader", async () => {
	const { dir, cachePath } = await tempCache("2026-07-28T12:00:00.000Z");
	let calls = 0;
	try {
		const cache = new CopilotCatalogCache({ cachePath, now: () => new Date("2026-07-29T13:00:00.000Z") });
		const loader = async () => {
			calls += 1;
			return [{ id: "model", vendor: calls === 1 ? "Background" : "Forced", capabilities: { family: "family" } }];
		};
		const background = cache.refresh(loader);
		const forced = cache.refresh(loader, { force: true });
		assert.equal((await background).status, "updated");
		assert.equal((await forced).status, "updated");
		assert.equal(calls, 2);
		assert.equal(cache.getSnapshot()?.models[0].vendor, "Forced");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("loader failure retains stale snapshot", async () => {
	const { dir, cachePath } = await tempCache("2026-07-28T12:00:00.000Z");
	try {
		const cache = new CopilotCatalogCache({ cachePath, now: () => new Date("2026-07-29T13:00:00.000Z") });
		const result = await cache.refresh(async () => {
			throw new Error("transient");
		});
		assert.equal(result.status, "error");
		assert.match(result.error ?? "", /transient/);
		assert.equal(result.snapshot?.models[0].vendor, "Vendor");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("offline and pre-aborted refreshes never call loader", async () => {
	for (const mode of ["offline", "aborted"] as const) {
		const { dir, cachePath } = await tempCache("2026-07-28T12:00:00.000Z");
		let calls = 0;
		const controller = new AbortController();
		if (mode === "aborted") controller.abort();
		try {
			const cache = new CopilotCatalogCache({ cachePath, offline: () => mode === "offline" });
			const result = await cache.refresh(
				async () => {
					calls += 1;
					return entries;
				},
				{ force: true, signal: controller.signal },
			);
			assert.equal(result.status, mode === "offline" ? "offline" : "error");
			assert.equal(calls, 0);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}
});

test("corrupt cache is ignored safely", async () => {
	const { dir, cachePath } = await tempCache();
	try {
		await fs.writeFile(cachePath, "broken", "utf8");
		const cache = new CopilotCatalogCache({ cachePath, offline: () => true });
		assert.equal(await cache.hydrate(), undefined);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
