import assert from "node:assert/strict";
import test from "node:test";

import {
	assessSpawnResolvability,
	modelSpec,
	policyDimensions,
	resolveModelSpec,
	resolveOptimizationPolicy,
	selectModel,
	type CandidateVariant,
	type ModelCandidate,
	type OptimizationDimension,
} from "./index.ts";

function signal(value: number, confidence = 1, source = "test") {
	return { value, confidence, provenance: { source } };
}

function variant(
	thinkingLevel: CandidateVariant["thinkingLevel"],
	values: Partial<Record<OptimizationDimension, number | { value: number; confidence: number }>>,
): CandidateVariant {
	return {
		thinkingLevel,
		signals: Object.fromEntries(
			Object.entries(values).map(([dimension, entry]) => [
				dimension,
				typeof entry === "number" ? signal(entry) : signal(entry.value, entry.confidence),
			]),
		),
	};
}

function candidate(
	id: string,
	variants: CandidateVariant[],
	overrides: Partial<ModelCandidate> = {},
): ModelCandidate {
	return {
		provider: "github-copilot",
		id,
		name: id,
		family: id.startsWith("claude") ? "claude" : id.startsWith("gpt") ? "gpt" : "other",
		vendor: id.startsWith("claude") ? "anthropic" : id.startsWith("gpt") ? "openai" : "other",
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 64_000,
		reasoning: true,
		spawnResolvable: true,
		variants,
		...overrides,
	};
}

test("exposes all quality, speed, and cost policy combinations", () => {
	assert.deepEqual(policyDimensions("quality"), ["quality"]);
	assert.deepEqual(policyDimensions("quality-speed"), ["quality", "speed"]);
	assert.deepEqual(policyDimensions("quality-cost"), ["quality", "cost"]);
	assert.deepEqual(policyDimensions("speed-cost"), ["speed", "cost"]);
	assert.deepEqual(policyDimensions("balanced"), ["quality", "speed", "cost"]);
});

test("auto resolves transparently from the role", () => {
	assert.deepEqual(resolveOptimizationPolicy("auto", "scout"), {
		requested: "auto",
		resolved: "speed-cost",
	});
	assert.equal(resolveOptimizationPolicy(undefined, "planner").resolved, "quality-speed");
	assert.equal(resolveOptimizationPolicy("balanced", "reviewer").resolved, "balanced");
});

test("resolves canonical, bare, case-insensitive, and slash-containing ids", () => {
	const models = [
		candidate("shared", [variant("off", { cost: 1 })], { provider: "one" }),
		candidate("shared", [variant("off", { cost: 1 })], { provider: "two" }),
		candidate("qwen/qwen-3", [variant("off", { cost: 1 })], { provider: "openrouter" }),
	];

	const canonical = resolveModelSpec(models, "ONE/SHARED");
	assert.equal(canonical.status, "found");
	if (canonical.status === "found") assert.equal(modelSpec(canonical.model), "one/shared");

	const slashId = resolveModelSpec(models, "qwen/qwen-3");
	assert.equal(slashId.status, "found");
	if (slashId.status === "found") assert.equal(slashId.model.provider, "openrouter");

	const ambiguous = resolveModelSpec(models, "shared");
	assert.equal(ambiguous.status, "ambiguous");
	if (ambiguous.status === "ambiguous") assert.equal(ambiguous.matches.length, 2);
	assert.equal(resolveModelSpec(models, "missing").status, "not-found");
});

test("assesses child-process resolvability by canonical identity", () => {
	const model = { provider: "GitHub-Copilot", id: "GPT-5" };
	assert.equal(assessSpawnResolvability(model, [{ provider: "github-copilot", id: "gpt-5" }]), true);
	assert.equal(assessSpawnResolvability(model, [{ provider: "openai", id: "gpt-5" }]), false);
});

test("quality policy selects the best model and thinking-level pair", () => {
	const decision = selectModel(
		[
			candidate("gpt-fast", [variant("low", { quality: 0.6 }), variant("high", { quality: 0.82 })]),
			candidate("claude-strong", [variant("low", { quality: 0.75 }), variant("high", { quality: 0.95 })]),
		],
		{ policy: "quality" },
	);

	assert.equal(modelSpec(decision.selected!.model), "github-copilot/claude-strong");
	assert.equal(decision.selected!.thinkingLevel, "high");
	assert.equal(decision.error, undefined);
	assert.match(decision.reasons.join("\n"), /quality: 0\.95/);
});

test("joint policies penalize lopsided candidates", () => {
	const decision = selectModel(
		[
			candidate("lopsided", [variant("low", { quality: 1, speed: 0.1 })]),
			candidate("joint", [variant("low", { quality: 0.7, speed: 0.7 })]),
		],
		{ policy: "quality-speed" },
	);

	assert.equal(decision.selected!.model.id, "joint");
	assert.ok(decision.selected!.utility > decision.alternatives[0].utility);
});

test("unknown signals are explicit and never treated as free or best", () => {
	const decision = selectModel(
		[
			candidate("unknown-cost", [variant("low", { quality: 1 })]),
			candidate("known-cost", [variant("low", { cost: 0.4 })]),
		],
		{ policy: "cost" },
	);

	assert.equal(decision.selected!.model.id, "known-cost");
	assert.equal(decision.alternatives[0].utility, 0);
	assert.equal(decision.alternatives[0].dimensionScores[0].known, false);
});

test("confidence reduces the utility of weakly sourced metadata", () => {
	const decision = selectModel(
		[
			candidate("uncertain", [variant("high", { quality: { value: 1, confidence: 0.2 } })]),
			candidate("credible", [variant("high", { quality: { value: 0.7, confidence: 1 } })]),
		],
		{ policy: "quality" },
	);

	assert.equal(decision.selected!.model.id, "credible");
});

test("categorical family diversity is applied before utility", () => {
	const decision = selectModel(
		[
			candidate("gpt-best", [variant("high", { quality: 1 })]),
			candidate("claude-peer", [variant("high", { quality: 0.7 })]),
		],
		{
			policy: "quality",
			preferences: { preferDifferentFamilyFrom: "gpt" },
		},
	);

	assert.equal(decision.selected!.model.id, "claude-peer");
	assert.equal(decision.selected!.diversityRank, 2);
	assert.match(decision.reasons.join("\n"), /categorical model-family/);
	assert.match(decision.caveats.join("\n"), /overrode higher-utility candidate.*gpt-best/);
});

test("vendor diversity is a categorical preference", () => {
	const decision = selectModel(
		[
			candidate("same-vendor", [variant("high", { quality: 1 })], { family: "other", vendor: "openai" }),
			candidate("other-vendor", [variant("high", { quality: 0.6 })], { family: "other", vendor: "google" }),
		],
		{ policy: "quality", preferences: { preferDifferentVendorFrom: "openai" } },
	);

	assert.equal(decision.selected!.model.id, "other-vendor");
	assert.equal(decision.selected!.diversityRank, 1);
});

test("an explicitly empty provider allow-list fails closed", () => {
	const decision = selectModel(
		[candidate("model", [variant("low", { quality: 1 })])],
		{ policy: "quality", constraints: { allowedProviders: [] } },
	);

	assert.equal(decision.selected, undefined);
	assert.match(decision.error ?? "", /No eligible models/);
	assert.match(decision.rejected[0].reasons.join("; "), /not allowed/);
});

test("canonical and bare exclusions are deny-oriented across providers", () => {
	const models = [
		candidate("shared", [variant("low", { quality: 1 })], { provider: "one" }),
		candidate("shared", [variant("low", { quality: 0.9 })], { provider: "two" }),
		candidate("other", [variant("low", { quality: 0.8 })], { provider: "two" }),
	];

	const canonical = selectModel(models, {
		policy: "quality",
		constraints: { excludedModels: ["one/shared", "does-not-match"] },
	});
	assert.equal(canonical.selected!.model.id, "shared");
	assert.equal(canonical.selected!.model.provider, "two");
	assert.deepEqual(canonical.rejected.map((entry) => modelSpec(entry.model)), ["one/shared"]);

	const bare = selectModel(models, {
		policy: "quality",
		constraints: { excludedModels: ["shared"] },
	});
	assert.equal(bare.selected!.model.id, "other");
	assert.deepEqual(
		bare.rejected.map((entry) => modelSpec(entry.model)),
		["one/shared", "two/shared"],
	);
});

test("remaining capability and provider constraints fail closed", () => {
	const decision = selectModel(
		[
			candidate("denied", [variant("off", { quality: 1 })], {
				provider: "denied-provider",
				reasoning: false,
				contextWindow: 100_000,
				maxTokens: 8_000,
			}),
			candidate("allowed", [variant("high", { quality: 0.8 })], {
				provider: "allowed-provider",
				contextWindow: 300_000,
				maxTokens: 64_000,
			}),
		],
		{
			policy: "quality",
			constraints: {
				deniedProviders: ["denied-provider"],
				minimumContextWindow: 200_000,
				minimumMaxTokens: 32_000,
				requireReasoning: true,
			},
		},
	);

	assert.equal(decision.selected!.model.id, "allowed");
	const denial = decision.rejected[0].reasons.join("; ");
	assert.match(denial, /provider denied-provider is denied/);
	assert.match(denial, /context window/);
	assert.match(denial, /max output/);
	assert.match(denial, /reasoning support/);
});

test("hard constraints filter before ranking", () => {
	const decision = selectModel(
		[
			candidate("runtime-only", [variant("high", { quality: 1 })], {
				spawnResolvable: "unknown",
				input: ["text", "image"],
			}),
			candidate("child-safe", [variant("high", { quality: 0.8 })], {
				spawnResolvable: true,
				input: ["text", "image"],
			}),
			candidate("text-only", [variant("high", { quality: 0.9 })], { input: ["text"] }),
		],
		{
			policy: "quality",
			constraints: { requireSpawnResolvable: true, requiredInput: ["image"] },
		},
	);

	assert.equal(decision.selected!.model.id, "child-safe");
	assert.equal(decision.rejected.length, 2);
	assert.match(decision.rejected.find((entry) => entry.model.id === "runtime-only")!.reasons.join("; "), /unknown/);
	assert.match(decision.rejected.find((entry) => entry.model.id === "text-only")!.reasons.join("; "), /image/);
});

test("an exact override beats ranking but cannot bypass hard constraints", () => {
	const models = [
		candidate("best", [variant("high", { quality: 1 })]),
		candidate("requested", [variant("low", { quality: 0.2 })]),
	];
	const selected = selectModel(models, { policy: "quality", modelOverride: "requested" });
	assert.equal(selected.selected!.model.id, "requested");
	assert.match(selected.reasons.join("\n"), /Exact model override/);

	const denied = selectModel(models, {
		policy: "quality",
		modelOverride: "requested",
		constraints: { deniedProviders: ["github-copilot"] },
	});
	assert.equal(denied.selected, undefined);
	assert.match(denied.error ?? "", /ineligible/);
});

test("ambiguous bare overrides fail with qualified alternatives", () => {
	const decision = selectModel(
		[
			candidate("shared", [variant("low", { quality: 1 })], { provider: "one" }),
			candidate("shared", [variant("low", { quality: 1 })], { provider: "two" }),
		],
		{ modelOverride: "shared" },
	);

	assert.equal(decision.selected, undefined);
	assert.match(decision.error ?? "", /ambiguous: one\/shared, two\/shared/);
});

test("thinking-level overrides are enforced", () => {
	const decision = selectModel(
		[
			candidate("one", [variant("low", { quality: 0.5 }), variant("high", { quality: 1 })]),
			candidate("two", [variant("low", { quality: 0.6 })]),
		],
		{ policy: "quality", thinkingLevelOverride: "low" },
	);
	assert.equal(decision.selected!.model.id, "two");
	assert.equal(decision.selected!.thinkingLevel, "low");

	const unsupported = selectModel(
		[candidate("one", [variant("low", { quality: 1 })])],
		{ thinkingLevelOverride: "max" },
	);
	assert.match(unsupported.error ?? "", /supports thinking level max/);
});

test("selection is deterministic when all requested metadata is unknown", () => {
	const decision = selectModel(
		[
			candidate("z-model", [variant("high", {})]),
			candidate("a-model", [variant("low", {})]),
		],
		{ policy: "cost" },
	);
	assert.equal(decision.selected!.model.id, "a-model");
	assert.deepEqual(decision.caveats, ["Selected candidate has no known cost signal"]);
});

test("alternatives are bounded and contain distinct models", () => {
	const decision = selectModel(
		[
			candidate("one", [variant("low", { speed: 0.9 }), variant("high", { speed: 1 })]),
			candidate("two", [variant("low", { speed: 0.8 }), variant("high", { speed: 0.7 })]),
			candidate("three", [variant("low", { speed: 0.6 })]),
		],
		{ policy: "speed", maxAlternatives: 1 },
	);
	assert.equal(decision.selected!.model.id, "one");
	assert.equal(decision.alternatives.length, 1);
	assert.equal(decision.alternatives[0].model.id, "two");

	const nonFinite = selectModel(
		[
			candidate("one", [variant("low", { speed: 1 })]),
			candidate("two", [variant("low", { speed: 0.8 })]),
		],
		{ policy: "speed", maxAlternatives: Number.NaN },
	);
	assert.equal(nonFinite.alternatives.length, 1);
});

test("invalid or duplicate candidate metadata fails early", () => {
	assert.throws(
		() => selectModel([candidate("bad", [variant("low", { quality: 1.1 })])]),
		/Invalid quality value/,
	);
	assert.throws(
		() =>
			selectModel([
				candidate("duplicate", [variant("low", { quality: 1 })]),
				candidate("duplicate", [variant("high", { quality: 1 })]),
			]),
		/Duplicate model candidate/,
	);
});
