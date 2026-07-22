import assert from "node:assert/strict";
import test from "node:test";
import { findAvailableModel, type ModelRef, resolveEffectiveModel } from "./model-select.ts";

const available: ModelRef[] = [
	{ provider: "github-copilot", id: "claude-opus-4.8" },
	{ provider: "github-copilot", id: "claude-sonnet-4.5" },
	{ provider: "anthropic", id: "claude-sonnet-4.5" },
	{ provider: "github-copilot", id: "gpt-5.5" },
];

const current: ModelRef = { provider: "github-copilot", id: "claude-opus-4.8" };

test("findAvailableModel matches exact provider/id", () => {
	const m = findAvailableModel(available, "anthropic/claude-sonnet-4.5");
	assert.equal(m?.provider, "anthropic");
	assert.equal(m?.id, "claude-sonnet-4.5");
});

test("findAvailableModel matches bare id (provider-agnostic)", () => {
	const m = findAvailableModel(available, "gpt-5.5");
	assert.equal(m?.provider, "github-copilot");
});

test("findAvailableModel returns undefined for unknown spec", () => {
	assert.equal(findAvailableModel(available, "claude-haiku-4-5"), undefined);
});

test("task model wins over session pin, frontmatter, and inherited", () => {
	const r = resolveEffectiveModel({
		taskModel: "gpt-5.5",
		sessionPin: "github-copilot/claude-sonnet-4.5",
		agentModel: "claude-opus-4.8",
		current,
		available,
	});
	assert.equal(r.spec, "github-copilot/gpt-5.5");
	assert.equal(r.source, "task");
	assert.equal(r.note, undefined);
});

test("session pin wins over frontmatter (frontmatter is a preference)", () => {
	const r = resolveEffectiveModel({
		sessionPin: "github-copilot/claude-sonnet-4.5",
		agentModel: "claude-opus-4.8",
		current,
		available,
	});
	assert.equal(r.spec, "github-copilot/claude-sonnet-4.5");
	assert.equal(r.source, "session pin");
});

test("frontmatter used when no task/pin override", () => {
	const r = resolveEffectiveModel({
		agentModel: "gpt-5.5",
		current,
		available,
	});
	assert.equal(r.spec, "github-copilot/gpt-5.5");
	assert.equal(r.source, "agent frontmatter");
});

test("inherits active session model by default", () => {
	const r = resolveEffectiveModel({ current, available });
	assert.equal(r.spec, "github-copilot/claude-opus-4.8");
	assert.equal(r.source, "inherited session");
});

test("unavailable candidate is skipped and reported, then falls back", () => {
	const r = resolveEffectiveModel({
		taskModel: "claude-haiku-4-5", // not available
		current,
		available,
	});
	assert.equal(r.spec, "github-copilot/claude-opus-4.8");
	assert.equal(r.source, "inherited session");
	assert.match(r.note ?? "", /skipped unavailable: claude-haiku-4-5/);
});

test("stale unavailable frontmatter does not defeat a valid session pin", () => {
	const r = resolveEffectiveModel({
		sessionPin: "gpt-5.5",
		agentModel: "claude-haiku-4-5", // unavailable, must be skipped, but ordered after pin anyway
		current,
		available,
	});
	assert.equal(r.spec, "github-copilot/gpt-5.5");
	assert.equal(r.source, "session pin");
});

test("no valid candidate yields undefined spec (child CLI default) with note", () => {
	const r = resolveEffectiveModel({
		taskModel: "nope-1",
		agentModel: "nope-2",
		available,
		// no current
	});
	assert.equal(r.spec, undefined);
	assert.equal(r.source, "cli default");
	assert.match(r.note ?? "", /nope-1, nope-2/);
});

test("no candidates at all yields undefined spec and no note", () => {
	const r = resolveEffectiveModel({ available });
	assert.equal(r.spec, undefined);
	assert.equal(r.note, undefined);
});
