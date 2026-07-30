import assert from "node:assert/strict";
import test from "node:test";

import {
	MODELS_DEV_CATALOG_URL,
	isModelsDevSnapshot,
	lookupModelsDevMetadata,
	projectModelsDevCatalog,
} from "./models-dev.ts";

function catalog() {
	return {
		models: {
			"openai/gpt-5-mini": { id: "openai/gpt-5-mini", name: "GPT-5 Mini", family: "gpt-mini" },
			"anthropic/claude-opus-4-8": {
				id: "anthropic/claude-opus-4-8",
				name: "Claude Opus 4.8",
				family: "claude-opus",
			},
			"microsoft/mai-code-1-flash": {
				id: "microsoft/mai-code-1-flash",
				name: "MAI-Code-1-Flash",
				family: "mai",
			},
		},
		providers: {
			"github-copilot": {
				id: "github-copilot",
				models: {
					"gpt-5-mini": {
						id: "gpt-5-mini",
						name: "GPT-5 Mini",
						family: "gpt-mini",
						description: "Small GPT model",
						release_date: "2025-08-07",
						cost: { input: 0.25, output: 2 },
					},
					"claude-opus-4.8": {
						id: "claude-opus-4.8",
						name: "Claude Opus 4.8",
						family: "claude-opus",
						cost: { input: 5, output: 25 },
					},
					"mai-code-1-flash-picker": {
						id: "mai-code-1-flash-picker",
						name: "MAI-Code-1-Flash",
						family: "mai",
						cost: { input: 0.75, output: 4.5 },
					},
					"zero-price": { id: "zero-price", family: "unknown", cost: { input: 0, output: 0 } },
				},
			},
			"other-route": {
				id: "other-route",
				models: {
					"gpt-5-mini": { id: "gpt-5-mini", family: "gpt-mini", cost: { input: 0.01, output: 0.01 } },
				},
			},
		},
	};
}

function snapshot(now = "2026-07-29T12:00:00.000Z") {
	return projectModelsDevCatalog(catalog(), {
		fetchedAt: now,
		freshUntil: "2026-07-30T12:00:00.000Z",
		etag: 'W/"test"',
	});
}

test("projects the public catalog into a validated compact snapshot", () => {
	const projected = snapshot();
	assert.equal(projected.sourceUrl, MODELS_DEV_CATALOG_URL);
	assert.equal(projected.models.length, 3);
	assert.equal(projected.routes.length, 5);
	assert.equal(projected.etag, 'W/"test"');
	assert.equal(isModelsDevSnapshot(projected), true);
	assert.equal(projected.routes.find((route) => route.id === "zero-price")?.cost, undefined);
});

test("rejects malformed projected snapshots", () => {
	const projected = snapshot();
	assert.equal(isModelsDevSnapshot({ ...projected, freshUntil: "not-a-date" }), false);
	assert.equal(
		isModelsDevSnapshot({
			...projected,
			routes: [{ ...projected.routes[0], cost: { input: -1, output: 1 } }],
		}),
		false,
	);
	assert.equal(
		isModelsDevSnapshot({
			...projected,
			routes: [{ ...projected.routes[0], family: { unsafe: true } }],
		}),
		false,
	);
});

test("rejects malformed or empty catalogs", () => {
	assert.throws(
		() => projectModelsDevCatalog({}, { fetchedAt: new Date().toISOString(), freshUntil: new Date().toISOString() }),
		/no usable models or routes/,
	);
	assert.throws(
		() => projectModelsDevCatalog([], { fetchedAt: new Date().toISOString(), freshUntil: new Date().toISOString() }),
		/root must be an object/,
	);
});

test("uses exact provider route cost and never borrows another route's price", () => {
	const enriched = lookupModelsDevMetadata(snapshot(), {
		provider: "github-copilot",
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
	});
	assert.deepEqual(enriched?.cost, { input: 0.25, output: 2 });
	assert.equal(enriched?.family, "gpt-mini");
	assert.equal(enriched?.vendor, "openai");
	assert.match(enriched?.costProvenance?.detail ?? "", /not subscription credits/);
});

test("matches punctuation aliases to a unique canonical vendor", () => {
	const enriched = lookupModelsDevMetadata(snapshot(), {
		provider: "github-copilot",
		id: "claude-opus-4.8",
		name: "Claude Opus 4.8",
	});
	assert.equal(enriched?.vendor, "anthropic");
	assert.equal(enriched?.identityMetadata?.vendor?.confidence, 0.95);
	assert.match(enriched?.identityMetadata?.vendor?.provenance.detail ?? "", /canonical id/);
});

test("matches a unique canonical name and family alias for MAI", () => {
	const enriched = lookupModelsDevMetadata(snapshot(), {
		provider: "github-copilot",
		id: "mai-code-1-flash-picker",
		name: "MAI-Code-1-Flash",
	});
	assert.equal(enriched?.family, "mai");
	assert.equal(enriched?.vendor, "microsoft");
	assert.equal(enriched?.identityMetadata?.vendor?.confidence, 0.85);
	assert.match(enriched?.identityMetadata?.vendor?.provenance.detail ?? "", /name and family/);
});

test("leaves vendor unknown when canonical matches are ambiguous", () => {
	const raw = catalog();
	raw.models = {
		...raw.models,
		"vendor-a/shared": { id: "vendor-a/shared", name: "Shared", family: "shared" },
		"vendor-b/shared": { id: "vendor-b/shared", name: "Shared", family: "shared" },
	};
	raw.providers["github-copilot"].models.shared = {
		id: "shared",
		name: "Shared",
		family: "shared",
		cost: { input: 1, output: 1 },
	};
	const projected = projectModelsDevCatalog(raw, {
		fetchedAt: "2026-07-29T12:00:00.000Z",
		freshUntil: "2026-07-30T12:00:00.000Z",
	});
	const enriched = lookupModelsDevMetadata(projected, { provider: "github-copilot", id: "shared", name: "Shared" });
	assert.equal(enriched?.family, "shared");
	assert.equal(enriched?.vendor, undefined);
});

test("marks provenance stale and cannot introduce unavailable models", () => {
	const projected = snapshot();
	const stale = lookupModelsDevMetadata(
		projected,
		{ provider: "github-copilot", id: "gpt-5-mini" },
		new Date("2026-08-01T00:00:00.000Z"),
	);
	assert.equal(stale?.costProvenance?.freshness, "stale");
	assert.equal(
		lookupModelsDevMetadata(projected, { provider: "github-copilot", id: "not-in-pi-or-models-dev" }),
		undefined,
	);
});
