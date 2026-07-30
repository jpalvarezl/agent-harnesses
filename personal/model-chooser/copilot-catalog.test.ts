import assert from "node:assert/strict";
import test from "node:test";

import {
	isCopilotCatalogSnapshot,
	lookupCopilotIdentity,
	projectCopilotCatalog,
} from "./copilot-catalog.ts";

const entries = [
	{
		id: "gpt-model",
		name: "GPT Model",
		vendor: "OpenAI",
		capabilities: { family: "gpt-frontier" },
	},
	{
		id: "claude-model",
		name: "Claude Model",
		vendor: "Anthropic",
		capabilities: { family: "claude-opus" },
	},
];

function snapshot(freshUntil = "2026-07-30T12:00:00.000Z") {
	return projectCopilotCatalog(entries, {
		fetchedAt: "2026-07-29T12:00:00.000Z",
		freshUntil,
	});
}

test("projects validated identity fields and sorts deterministically", () => {
	const projected = snapshot();
	assert.deepEqual(projected.models.map((model) => model.id), ["claude-model", "gpt-model"]);
	assert.equal(projected.models[1].vendor, "OpenAI");
	assert.equal(projected.models[1].modelFamily, "gpt-frontier");
	assert.equal(isCopilotCatalogSnapshot(projected), true);
});

test("deduplicates ids case-insensitively and rejects empty catalogs", () => {
	const projected = projectCopilotCatalog(
		[...entries, { id: "GPT-MODEL", vendor: "Updated", capabilities: { family: "updated" } }],
		{ fetchedAt: "2026-07-29T12:00:00.000Z", freshUntil: "2026-07-30T12:00:00.000Z" },
	);
	assert.equal(projected.models.length, 2);
	assert.equal(projected.models.find((model) => model.id === "GPT-MODEL")?.vendor, "Updated");
	assert.throws(
		() =>
			projectCopilotCatalog([], {
				fetchedAt: "2026-07-29T12:00:00.000Z",
				freshUntil: "2026-07-30T12:00:00.000Z",
			}),
		/no usable models/,
	);
});

test("looks up exact authenticated provider identity with provenance", () => {
	const enriched = lookupCopilotIdentity(snapshot(), {
		provider: "GITHUB-COPILOT",
		id: "GPT-MODEL",
	});
	assert.equal(enriched?.vendor, "OpenAI");
	assert.equal(enriched?.modelFamily, "gpt-frontier");
	assert.equal(enriched?.identityMetadata?.vendor?.confidence, 0.99);
	assert.equal(enriched?.identityMetadata?.vendor?.provenance.source, "github-copilot-live-catalog");
	assert.equal(enriched?.identityMetadata?.vendor?.provenance.freshness, "fresh");
});

test("does not enrich other providers or unknown models", () => {
	assert.equal(lookupCopilotIdentity(snapshot(), { provider: "openai", id: "gpt-model" }), undefined);
	assert.equal(lookupCopilotIdentity(snapshot(), { provider: "github-copilot", id: "missing" }), undefined);
});

test("marks stale identity provenance", () => {
	const enriched = lookupCopilotIdentity(
		snapshot("2026-07-29T12:30:00.000Z"),
		{ provider: "github-copilot", id: "gpt-model" },
		new Date("2026-07-29T13:00:00.000Z"),
	);
	assert.equal(enriched?.identityMetadata?.vendor?.provenance.freshness, "stale");
});

test("rejects malformed persisted snapshots", () => {
	const projected = snapshot();
	assert.equal(isCopilotCatalogSnapshot({ ...projected, fetchedAt: "invalid" }), false);
	assert.equal(isCopilotCatalogSnapshot({ ...projected, models: [{ id: "x", vendor: { unsafe: true } }] }), false);
});
