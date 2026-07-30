import assert from "node:assert/strict";
import test from "node:test";

import {
	assessSpawnResolvability,
	modelSpec,
	policyDimensions,
	resolveModelSpec,
	resolveOptimizationPolicy,
	selectModel,
	type ModelCandidate,
	type ThinkingLevel,
} from "./index.ts";

function candidate(
	id: string,
	options: {
		provider?: string;
		cost?: number;
		family?: string;
		vendor?: string;
		spawnResolvable?: boolean | "unknown";
		levels?: ThinkingLevel[];
		input?: ("text" | "image")[];
		reasoning?: boolean;
		contextWindow?: number;
		maxTokens?: number;
	} = {},
): ModelCandidate {
	return {
		provider: options.provider ?? "github-copilot",
		id,
		name: id,
		family: options.family ?? (id.startsWith("claude") ? "claude" : "gpt"),
		vendor: options.vendor ?? (id.startsWith("claude") ? "anthropic" : "openai"),
		input: options.input ?? ["text"],
		contextWindow: options.contextWindow ?? 200_000,
		maxTokens: options.maxTokens ?? 64_000,
		reasoning: options.reasoning ?? true,
		cost: options.cost,
		spawnResolvable: options.spawnResolvable ?? true,
		variants: (options.levels ?? ["off", "minimal", "low", "medium", "high", "max"]).map((thinkingLevel) => ({ thinkingLevel })),
	};
}

test("exposes all policy combinations and role-aware auto defaults", () => {
	assert.deepEqual(policyDimensions("quality-speed"), ["quality", "speed"]);
	assert.deepEqual(policyDimensions("quality-cost"), ["quality", "cost"]);
	assert.deepEqual(policyDimensions("speed-cost"), ["speed", "cost"]);
	assert.deepEqual(policyDimensions("balanced"), ["quality", "speed", "cost"]);
	assert.equal(resolveOptimizationPolicy("auto", "scout").resolved, "speed-cost");
	assert.equal(resolveOptimizationPolicy("auto", "reviewer").resolved, "quality");
});

test("resolves canonical, unambiguous bare, case-insensitive, and slash ids", () => {
	const models = [
		candidate("shared", { provider: "one" }),
		candidate("shared", { provider: "two" }),
		candidate("qwen/qwen-3", { provider: "openrouter" }),
	];
	assert.equal(resolveModelSpec(models, "ONE/SHARED").status, "found");
	assert.equal(resolveModelSpec(models, "shared").status, "ambiguous");
	const slash = resolveModelSpec(models, "qwen/qwen-3");
	assert.equal(slash.status, "found");
	if (slash.status === "found") assert.equal(slash.model.provider, "openrouter");
});

test("assesses child-process resolvability by canonical identity", () => {
	assert.equal(
		assessSpawnResolvability(
			{ provider: "GitHub-Copilot", id: "GPT-5" },
			[{ provider: "github-copilot", id: "gpt-5" }],
		),
		true,
	);
});

test("policies are honest thinking presets when a model is pinned", () => {
	const model = candidate("pinned");
	const expected: Record<string, ThinkingLevel> = {
		quality: "max",
		speed: "off",
		cost: "off",
		"quality-speed": "medium",
		"quality-cost": "high",
		"speed-cost": "off",
		balanced: "medium",
	};
	for (const [policy, thinking] of Object.entries(expected)) {
		const decision = selectModel([model], { policy: policy as keyof typeof expected, modelOverride: "pinned" });
		assert.equal(decision.selected?.thinkingLevel, thinking, policy);
		assert.match(decision.reasons.join("\n"), /thinking/);
	}
});

test("cost-bearing policies select the cheapest known model", () => {
	for (const policy of ["cost", "quality-cost", "speed-cost", "balanced"] as const) {
		const decision = selectModel(
			[candidate("expensive", { cost: 20 }), candidate("cheap", { cost: 2 }), candidate("unknown")],
			{ policy },
		);
		assert.equal(decision.selected?.model.id, "cheap", policy);
	}
});

test("non-cost policies do not pretend to compare model quality or speed", () => {
	const decision = selectModel(
		[candidate("z-model", { cost: 1 }), candidate("a-model", { cost: 100 })],
		{ policy: "quality" },
	);
	assert.equal(decision.selected?.model.id, "a-model");
	assert.match(decision.reasons.join("\n"), /controls thinking only/);
});

test("known cost ranks before unknown cost and unknown-only selection is caveated", () => {
	const known = selectModel([candidate("unknown"), candidate("known", { cost: 5 })], { policy: "cost" });
	assert.equal(known.selected?.model.id, "known");
	const unknown = selectModel([candidate("unknown")], { policy: "cost" });
	assert.match(unknown.caveats.join("\n"), /no known cost/);
});

test("categorical peer diversity outranks cost", () => {
	const decision = selectModel(
		[
			candidate("gpt-cheap", { cost: 1, family: "gpt", vendor: "openai" }),
			candidate("claude-costly", { cost: 20, family: "claude", vendor: "anthropic" }),
		],
		{
			policy: "cost",
			preferences: { preferDifferentFamilyFrom: "gpt", preferDifferentVendorFrom: "openai" },
		},
	);
	assert.equal(decision.selected?.model.id, "claude-costly");
	assert.equal(decision.selected?.diversityRank, 3);
});

test("hard constraints filter before selection and an empty allow-list fails closed", () => {
	const models = [
		candidate("bad", { spawnResolvable: "unknown", input: ["text"], reasoning: false, contextWindow: 10, maxTokens: 10 }),
		candidate("good", { input: ["text", "image"] }),
	];
	const decision = selectModel(models, {
		policy: "quality",
		constraints: {
			requireSpawnResolvable: true,
			requiredInput: ["image"],
			requireReasoning: true,
			minimumContextWindow: 100,
			minimumMaxTokens: 100,
		},
	});
	assert.equal(decision.selected?.model.id, "good");
	assert.equal(decision.rejected.length, 1);
	assert.equal(
		selectModel([models[1]], { constraints: { allowedProviders: [] } }).error,
		"No eligible models are available",
	);
});

test("exact overrides beat policy but cannot bypass constraints", () => {
	const models = [candidate("cheap", { cost: 1 }), candidate("requested", { cost: 50 })];
	assert.equal(selectModel(models, { policy: "cost", modelOverride: "requested" }).selected?.model.id, "requested");
	const denied = selectModel(models, {
		policy: "cost",
		modelOverride: "requested",
		constraints: { deniedProviders: ["github-copilot"] },
	});
	assert.match(denied.error ?? "", /ineligible/);
});

test("ambiguous overrides and unsupported thinking fail clearly", () => {
	const ambiguous = selectModel(
		[candidate("shared", { provider: "one" }), candidate("shared", { provider: "two" })],
		{ modelOverride: "shared" },
	);
	assert.match(ambiguous.error ?? "", /ambiguous: one\/shared, two\/shared/);
	const unsupported = selectModel([candidate("one", { levels: ["low"] })], {
		thinkingLevelOverride: "max",
	});
	assert.match(unsupported.error ?? "", /supports thinking level max/);
});

test("alternatives are distinct models and bounded", () => {
	const decision = selectModel(
		[candidate("one", { cost: 1 }), candidate("two", { cost: 2 }), candidate("three", { cost: 3 })],
		{ policy: "cost", maxAlternatives: 1 },
	);
	assert.equal(decision.selected?.model.id, "one");
	assert.deepEqual(decision.alternatives.map((entry) => entry.model.id), ["two"]);
});

test("invalid candidate metadata fails early", () => {
	assert.throws(() => selectModel([candidate("bad", { cost: -1 })]), /Invalid cost/);
	assert.throws(
		() =>
			selectModel([
				candidate("bad-thinking", { levels: ["turbo" as ThinkingLevel] }),
			]),
		/Invalid thinking level/,
	);
	assert.throws(() => selectModel([candidate("dup"), candidate("dup")]), /Duplicate model candidate/);
});

test("modelSpec formats canonical identities", () => {
	assert.equal(modelSpec({ provider: "provider", id: "model/id" }), "provider/model/id");
});
