import assert from "node:assert/strict";
import test from "node:test";

import {
	adaptPiModels,
	getSupportedThinkingLevels,
	inferModelFamilyVendor,
	type PiModelLike,
} from "./pi-adapter.ts";
import { projectModelsDevCatalog } from "./models-dev.ts";

function piModel(id: string, overrides: Partial<PiModelLike> = {}): PiModelLike {
	return {
		provider: "github-copilot",
		id,
		name: id,
		reasoning: true,
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 64_000,
		cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 },
		...overrides,
	};
}

function modelsDevSnapshot(options: {
	id: string;
	name: string;
	family: string;
	canonical: string;
	cost?: { input: number; output: number };
	freshUntil?: string;
}) {
	return projectModelsDevCatalog(
		{
			models: {
				[options.canonical]: {
					id: options.canonical,
					name: options.name,
					family: options.family,
				},
			},
			providers: {
				"github-copilot": {
					id: "github-copilot",
					models: {
						[options.id]: {
							id: options.id,
							name: options.name,
							family: options.family,
							cost: options.cost,
						},
					},
				},
			},
		},
		{
			fetchedAt: "2026-07-29T12:00:00.000Z",
			freshUntil: options.freshUntil ?? "2026-07-30T12:00:00.000Z",
		},
	);
}

test("infers common model families and vendors", () => {
	assert.deepEqual(inferModelFamilyVendor(piModel("claude-sonnet-5")), {
		family: "claude",
		vendor: "anthropic",
	});
	assert.deepEqual(inferModelFamilyVendor(piModel("gpt-5.6-sol")), {
		family: "gpt",
		vendor: "openai",
	});
	assert.deepEqual(inferModelFamilyVendor(piModel("gemini-3.5-flash")), {
		family: "gemini",
		vendor: "google",
	});
	assert.deepEqual(
		inferModelFamilyVendor(piModel("custom-model", { provider: "my-provider" })),
		{ family: "custom-model", vendor: "my-provider" },
	);
});

test("maps Pi thinking levels including nulls and extended-level holes", () => {
	assert.deepEqual(getSupportedThinkingLevels(piModel("plain", { reasoning: false })), ["off"]);
	assert.deepEqual(getSupportedThinkingLevels(piModel("standard")), ["off", "minimal", "low", "medium", "high"]);
	assert.deepEqual(
		getSupportedThinkingLevels(
			piModel("mapped", {
				thinkingLevelMap: { off: null, minimal: null, low: "low", xhigh: null, max: "max" },
			}),
		),
		["low", "medium", "high", "max"],
	);
});

test("adapts capabilities and child resolvability", () => {
	const adapted = adaptPiModels(
		[
			piModel("child-safe", { input: ["text", "image"] }),
			piModel("runtime-only"),
		],
		[{ provider: "github-copilot", id: "child-safe" }],
	);
	assert.equal(adapted[0].spawnResolvable, true);
	assert.equal(adapted[1].spawnResolvable, false);
	assert.deepEqual(adapted[0].input, ["text", "image"]);
	assert.equal(adapted[0].variants.at(-1)?.thinkingLevel, "high");

	const unknown = adaptPiModels([piModel("model")], undefined);
	assert.equal(unknown[0].spawnResolvable, "unknown");
});

test("normalizes known costs and keeps zero/default prices unknown", () => {
	const adapted = adaptPiModels(
		[
			piModel("cheap", { cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
			piModel("expensive", { cost: { input: 4, output: 4, cacheRead: 0, cacheWrite: 0 } }),
			piModel("unknown", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
			piModel("missing", { cost: undefined }),
		],
		[],
	);
	const cheapCost = adapted[0].variants[0].signals.cost;
	const expensiveCost = adapted[1].variants[0].signals.cost;
	assert.equal(cheapCost?.value, 1);
	assert.equal(expensiveCost?.value, 0.25);
	assert.equal(adapted[2].variants[0].signals.cost, undefined);
	assert.equal(adapted[3].variants[0].signals.cost, undefined);
	assert.equal(cheapCost?.provenance.source, "pi-catalog-base-rates");
});

test("positive Pi route cost takes precedence over models.dev", () => {
	const metadata = modelsDevSnapshot({
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		family: "gpt-mini",
		canonical: "openai/gpt-5-mini",
		cost: { input: 0.01, output: 0.01 },
	});
	const [adapted] = adaptPiModels(
		[piModel("gpt-5-mini", { name: "GPT-5 Mini", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } })],
		[],
		{ modelsDev: metadata, now: new Date("2026-07-29T13:00:00.000Z") },
	);
	assert.equal(adapted.variants[0].signals.cost?.provenance.source, "pi-catalog-base-rates");
	assert.equal(adapted.variants[0].signals.cost?.confidence, 0.55);
	assert.equal(adapted.family, "gpt");
	assert.equal(adapted.modelFamily, "gpt-mini");
	assert.equal(adapted.vendor, "openai");
	assert.equal(adapted.identityMetadata?.family?.provenance.source, "models.dev");
	assert.equal(adapted.identityMetadata?.modelFamily?.provenance.source, "models.dev");
});

test("unknown Pi cost falls back to exact-route models.dev price and canonical vendor", () => {
	const metadata = modelsDevSnapshot({
		id: "mai-code-1-flash-picker",
		name: "MAI-Code-1-Flash",
		family: "mai",
		canonical: "microsoft/mai-code-1-flash",
		cost: { input: 0.75, output: 4.5 },
	});
	const [adapted] = adaptPiModels(
		[piModel("mai-code-1-flash-picker", { name: "MAI-Code-1-Flash", cost: undefined })],
		[],
		{ modelsDev: metadata, now: new Date("2026-07-29T13:00:00.000Z") },
	);
	const cost = adapted.variants[0].signals.cost;
	assert.equal(adapted.family, "mai");
	assert.equal(adapted.vendor, "microsoft");
	assert.equal(cost?.value, 1);
	assert.equal(cost?.confidence, 0.45);
	assert.equal(cost?.provenance.source, "models.dev");
	assert.match(cost?.provenance.detail ?? "", /not subscription credits/);
});

test("granular models.dev families retain a coarse independence family", () => {
	const opus = modelsDevSnapshot({
		id: "claude-opus-4.8",
		name: "Claude Opus 4.8",
		family: "claude-opus",
		canonical: "anthropic/claude-opus-4-8",
	});
	const sonnet = modelsDevSnapshot({
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		family: "claude-sonnet",
		canonical: "anthropic/claude-sonnet-5",
	});
	const adaptedOpus = adaptPiModels(
		[piModel("claude-opus-4.8", { name: "Claude Opus 4.8" })],
		[],
		{ modelsDev: opus },
	)[0];
	const adaptedSonnet = adaptPiModels(
		[piModel("claude-sonnet-5", { name: "Claude Sonnet 5" })],
		[],
		{ modelsDev: sonnet },
	)[0];
	assert.equal(adaptedOpus.family, "claude");
	assert.equal(adaptedSonnet.family, "claude");
	assert.equal(adaptedOpus.modelFamily, "claude-opus");
	assert.equal(adaptedSonnet.modelFamily, "claude-sonnet");
	assert.equal(adaptedOpus.vendor, "anthropic");
	assert.equal(adaptedSonnet.vendor, "anthropic");
});

test("unknown external taxonomy keeps heuristic coarse-family provenance", () => {
	const metadata = modelsDevSnapshot({
		id: "custom-model",
		name: "Llama Model",
		family: "llama-large",
		canonical: "meta/llama-model",
	});
	const [adapted] = adaptPiModels(
		[piModel("custom-model", { name: "Llama Model", provider: "github-copilot" })],
		[],
		{ modelsDev: metadata },
	);
	assert.equal(adapted.family, "custom-model");
	assert.equal(adapted.modelFamily, "llama-large");
	assert.equal(adapted.vendor, "meta");
	assert.equal(adapted.identityMetadata?.family?.provenance.source, "model-id-heuristic");
	assert.equal(adapted.identityMetadata?.vendor?.provenance.source, "models.dev");
});

test("stale models.dev pricing has lower confidence", () => {
	const metadata = modelsDevSnapshot({
		id: "model",
		name: "Model",
		family: "family",
		canonical: "vendor/model",
		cost: { input: 1, output: 1 },
		freshUntil: "2026-07-29T12:30:00.000Z",
	});
	const [adapted] = adaptPiModels(
		[piModel("model", { name: "Model", cost: undefined })],
		[],
		{ modelsDev: metadata, now: new Date("2026-07-29T13:00:00.000Z") },
	);
	assert.equal(adapted.variants[0].signals.cost?.confidence, 0.3);
	assert.equal(adapted.variants[0].signals.cost?.provenance.freshness, "stale");
});

test("thinking priors favor effort for quality and low effort for speed/cost", () => {
	const [adapted] = adaptPiModels([piModel("model")], []);
	const off = adapted.variants.find((entry) => entry.thinkingLevel === "off")!;
	const high = adapted.variants.find((entry) => entry.thinkingLevel === "high")!;
	assert.ok(high.signals.quality!.value > off.signals.quality!.value);
	assert.ok(high.signals.speed!.value < off.signals.speed!.value);
	assert.ok(high.signals.cost!.value < off.signals.cost!.value);
	assert.equal(high.signals.quality!.confidence, 0.2);
});
