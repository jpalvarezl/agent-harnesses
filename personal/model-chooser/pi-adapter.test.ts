import assert from "node:assert/strict";
import test from "node:test";

import {
	adaptPiModels,
	getSupportedThinkingLevels,
	inferModelFamilyVendor,
	type PiModelLike,
} from "./pi-adapter.ts";

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
	assert.equal(cheapCost?.provenance.source, "pi-catalog-base-rates+thinking-effort-prior");
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
