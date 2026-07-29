import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCandidate, ThinkingLevel } from "../../model-chooser/index.ts";
import { resolvePeerChoice } from "./chooser-select.ts";
import type { ModelReference } from "./model-selection.ts";

function candidate(
	id: string,
	cost: number,
	options: { spawnResolvable?: boolean; levels?: ThinkingLevel[] } = {},
): ModelCandidate {
	const claude = id.startsWith("claude");
	return {
		provider: "github-copilot",
		id,
		name: id,
		family: claude ? "claude" : "gpt",
		vendor: claude ? "anthropic" : "openai",
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 64_000,
		reasoning: true,
		spawnResolvable: options.spawnResolvable ?? true,
		variants: (options.levels ?? ["low", "high"]).map((thinkingLevel) => ({
			thinkingLevel,
			signals: {
				quality: { value: thinkingLevel === "high" ? 1 : 0.5, confidence: 0.2, provenance: { source: "test" } },
				speed: { value: thinkingLevel === "low" ? 1 : 0.5, confidence: 0.2, provenance: { source: "test" } },
				cost: { value: cost, confidence: 0.5, provenance: { source: "test" } },
			},
		})),
	};
}

const current: ModelReference = { provider: "github-copilot", id: "gpt-5.5" };
const available: ModelReference[] = [
	current,
	{ provider: "github-copilot", id: "gpt-5.4" },
	{ provider: "github-copilot", id: "claude-opus-4.8" },
	{ provider: "github-copilot", id: "claude-haiku-4.5" },
];
const candidates = [
	candidate("gpt-5.5", 0.2),
	candidate("gpt-5.4", 0.5),
	candidate("claude-opus-4.8", 0.2),
	candidate("claude-haiku-4.5", 1),
];

test("omitting chooser fields preserves the legacy peer selector", () => {
	const result = resolvePeerChoice({ role: "rubber-duck", current, available, candidates });
	assert.equal(result.selection?.model.id, "claude-opus-4.8");
	assert.equal(result.thinkingLevel, undefined);
	assert.equal(result.decision, undefined);
});

test("auto quality preserves the preferred opposite-family peer and chooses thinking", () => {
	const result = resolvePeerChoice({ role: "rubber-duck", current, available, candidates, policy: "auto" });
	assert.equal(result.selection?.model.id, "claude-opus-4.8");
	assert.equal(result.selection?.crossFamily, true);
	assert.equal(result.thinkingLevel, "high");
	assert.equal(result.decision?.resolvedPolicy, "quality");
});

test("cost policy chooses the economical opposite-family peer", () => {
	const result = resolvePeerChoice({ role: "code-review", current, available, candidates, policy: "cost" });
	assert.equal(result.selection?.model.id, "claude-haiku-4.5");
	assert.equal(result.thinkingLevel, "low");
});

test("explicit model and thinking overrides are honored", () => {
	const result = resolvePeerChoice({
		role: "code-review",
		current,
		available,
		candidates,
		model: "github-copilot/gpt-5.4",
		thinkingLevel: "low",
	});
	assert.equal(result.selection?.model.id, "gpt-5.4");
	assert.equal(result.selection?.crossFamily, false);
	assert.equal(result.thinkingLevel, "low");
});

test("the current model cannot be selected as its own peer", () => {
	const result = resolvePeerChoice({
		role: "rubber-duck",
		current,
		available,
		candidates,
		model: "gpt-5.5",
	});
	assert.equal(result.selection, undefined);
	assert.match(result.error ?? "", /ineligible.*explicitly excluded/);
});

test("known runtime-only peers fail closed", () => {
	const runtimeOnly = candidates.map((entry) =>
		entry.id === "claude-opus-4.8" ? { ...entry, spawnResolvable: false as const } : entry,
	);
	const result = resolvePeerChoice({
		role: "rubber-duck",
		current,
		available,
		candidates: runtimeOnly,
		model: "claude-opus-4.8",
	});
	assert.equal(result.selection, undefined);
	assert.match(result.error ?? "", /not resolvable/);
});

test("selection works without an active parent model", () => {
	const result = resolvePeerChoice({
		role: "code-review",
		available,
		candidates,
		policy: "cost",
	});
	assert.equal(result.selection?.model.id, "claude-haiku-4.5");
});
