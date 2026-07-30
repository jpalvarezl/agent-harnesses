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
		cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 },
		...overrides,
	};
}

test("infers coarse families and vendors needed for peer diversity", () => {
	assert.deepEqual(inferModelFamilyVendor(piModel("claude-sonnet-5")), { family: "claude", vendor: "anthropic" });
	assert.deepEqual(inferModelFamilyVendor(piModel("gpt-5.6-sol")), { family: "gpt", vendor: "openai" });
	assert.deepEqual(inferModelFamilyVendor(piModel("gemini-3.5-flash")), { family: "gemini", vendor: "google" });
	assert.deepEqual(inferModelFamilyVendor(piModel("mai-code-1-flash-picker")), { family: "mai", vendor: "microsoft" });
});

test("maps Pi thinking levels including nulls and extended-level holes", () => {
	assert.deepEqual(getSupportedThinkingLevels(piModel("plain", { reasoning: false })), ["off"]);
	assert.deepEqual(getSupportedThinkingLevels(piModel("standard")), ["off", "minimal", "low", "medium", "high"]);
	assert.deepEqual(
		getSupportedThinkingLevels(
			piModel("mapped", { thinkingLevelMap: { off: null, minimal: null, low: "low", xhigh: null, max: "max" } }),
		),
		["low", "medium", "high", "max"],
	);
});

test("adapts capabilities, cost, thinking levels, and child resolvability", () => {
	const adapted = adaptPiModels(
		[
			piModel("child-safe", { cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }),
			piModel("runtime-only", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		],
		[{ provider: "github-copilot", id: "child-safe" }],
	);
	assert.equal(adapted[0].spawnResolvable, true);
	assert.equal(adapted[1].spawnResolvable, false);
	assert.equal(adapted[0].cost, 3);
	assert.equal(adapted[1].cost, undefined);
	assert.equal(adapted[0].variants.at(-1)?.thinkingLevel, "high");
});

test("unknown child catalog remains explicit", () => {
	assert.equal(adaptPiModels([piModel("model")], undefined)[0].spawnResolvable, "unknown");
});
