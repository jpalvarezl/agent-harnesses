import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCandidate, ThinkingLevel } from "../../model-chooser/index.ts";
import { agentRole, resolveChooserModel } from "./chooser-select.ts";
import type { ModelRef } from "./model-select.ts";

function candidate(
	id: string,
	cost: number,
	options: { provider?: string; spawnResolvable?: boolean | "unknown"; levels?: ThinkingLevel[] } = {},
): ModelCandidate {
	return {
		provider: options.provider ?? "github-copilot",
		id,
		name: id,
		family: id.startsWith("claude") ? "claude" : "gpt",
		vendor: id.startsWith("claude") ? "anthropic" : "openai",
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
				cost: { value: cost * (thinkingLevel === "low" ? 1 : 0.8), confidence: 0.5, provenance: { source: "test" } },
			},
		})),
	};
}

const current: ModelRef = { provider: "github-copilot", id: "gpt-current" };
const available: ModelRef[] = [
	current,
	{ provider: "github-copilot", id: "gpt-cheap" },
	{ provider: "github-copilot", id: "claude-pin" },
	{ provider: "github-copilot", id: "runtime-only" },
];
const candidates = [
	candidate("gpt-current", 0.3),
	candidate("gpt-cheap", 1),
	candidate("claude-pin", 0.5),
	candidate("runtime-only", 1, { spawnResolvable: false }),
];

test("maps bundled agents to chooser roles and custom agents to generic", () => {
	assert.equal(agentRole("scout"), "scout");
	assert.equal(agentRole("Reviewer"), "reviewer");
	assert.equal(agentRole("custom"), "generic");
});

test("omitting chooser fields preserves the legacy selection exactly", () => {
	const resolved = resolveChooserModel({
		current,
		available,
		candidates,
		agentName: "worker",
	});
	assert.deepEqual(resolved, {
		spec: "github-copilot/gpt-current",
		source: "inherited session",
		note: undefined,
	});
});

test("quality pins the inherited model and selects its stronger thinking variant", () => {
	const resolved = resolveChooserModel({
		current,
		available,
		candidates,
		agentName: "reviewer",
		policy: "quality",
	});
	assert.equal(resolved.spec, "github-copilot/gpt-current");
	assert.equal(resolved.thinkingLevel, "high");
	assert.equal(resolved.resolvedPolicy, "quality");
});

test("cost policy can choose a cheaper child-safe model", () => {
	const resolved = resolveChooserModel({
		current,
		available,
		candidates,
		agentName: "worker",
		policy: "cost",
	});
	assert.equal(resolved.spec, "github-copilot/gpt-cheap");
	assert.equal(resolved.thinkingLevel, "low");
	assert.equal(resolved.source, "policy cost");
});

test("a cost policy plus thinking constraint can still switch models", () => {
	const resolved = resolveChooserModel({
		current,
		available,
		candidates,
		agentName: "worker",
		policy: "cost",
		thinkingLevel: "high",
	});
	assert.equal(resolved.spec, "github-copilot/gpt-cheap");
	assert.equal(resolved.thinkingLevel, "high");
});

test("task model, session pin, and frontmatter remain stronger than policy", () => {
	const task = resolveChooserModel({
		taskModel: "claude-pin",
		sessionPin: "gpt-cheap",
		agentModel: "gpt-current",
		current,
		available,
		candidates,
		agentName: "scout",
		policy: "cost",
	});
	assert.equal(task.spec, "github-copilot/claude-pin");
	assert.equal(task.source, "task");

	const session = resolveChooserModel({
		sessionPin: "claude-pin",
		agentModel: "gpt-cheap",
		current,
		available,
		candidates,
		agentName: "scout",
		policy: "cost",
	});
	assert.equal(session.spec, "github-copilot/claude-pin");
	assert.equal(session.source, "session pin");
});

test("thinking-only selection keeps the inherited model", () => {
	const resolved = resolveChooserModel({
		current,
		available,
		candidates,
		agentName: "scout",
		thinkingLevel: "high",
	});
	assert.equal(resolved.spec, "github-copilot/gpt-current");
	assert.equal(resolved.thinkingLevel, "high");
});

test("an unresolvable explicit model fails before dispatch", () => {
	const resolved = resolveChooserModel({
		taskModel: "runtime-only",
		current,
		available,
		candidates,
		agentName: "reviewer",
		policy: "quality",
	});
	assert.equal(resolved.spec, undefined);
	assert.equal(resolved.source, "chooser");
	assert.match(resolved.error ?? "", /not resolvable by a fresh child/);
});

test("unsupported thinking fails before dispatch instead of dropping the model pin", () => {
	const resolved = resolveChooserModel({
		current,
		available,
		candidates,
		agentName: "worker",
		thinkingLevel: "max",
	});
	assert.equal(resolved.spec, undefined);
	assert.equal(resolved.source, "chooser");
	assert.match(resolved.error ?? "", /supports thinking level max/);
	assert.match(resolved.note ?? "", /supports thinking level max/);
});
