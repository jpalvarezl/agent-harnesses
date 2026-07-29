import assert from "node:assert/strict";
import test from "node:test";

import {
	TOOL_POLICY_VALUES,
	TOOL_THINKING_VALUES,
	normalizeToolModel,
	normalizeToolPolicy,
	normalizeToolThinking,
	resolveToolPolicy,
	resolveToolThinking,
} from "./tool-options.ts";

test("tool enums put compatibility sentinels first", () => {
	assert.equal(TOOL_POLICY_VALUES[0], "legacy");
	assert.equal(TOOL_THINKING_VALUES[0], "auto");
	assert.equal(TOOL_POLICY_VALUES.length, 9); // sentinel + eight optimization policies
});

test("tool sentinels normalize to omitted chooser options", () => {
	assert.equal(normalizeToolPolicy(undefined), undefined);
	assert.equal(normalizeToolPolicy("legacy"), undefined);
	assert.equal(normalizeToolPolicy("quality-cost"), "quality-cost");
	assert.equal(normalizeToolThinking(undefined), undefined);
	assert.equal(normalizeToolThinking("auto"), undefined);
	assert.equal(normalizeToolThinking("high"), "high");
});

test("item chooser values override call defaults and sentinels inherit", () => {
	assert.equal(resolveToolPolicy("quality", "cost"), "quality");
	assert.equal(resolveToolPolicy("legacy", "cost"), "cost");
	assert.equal(resolveToolPolicy(undefined, "auto"), "auto");
	assert.equal(resolveToolThinking("high", "low"), "high");
	assert.equal(resolveToolThinking("auto", "low"), "low");
	assert.equal(resolveToolThinking(undefined, "auto"), undefined);
});

test("empty strict-tool string placeholders normalize away", () => {
	assert.equal(normalizeToolModel(undefined), undefined);
	assert.equal(normalizeToolModel(""), undefined);
	assert.equal(normalizeToolModel("   "), undefined);
	assert.equal(normalizeToolModel(" github-copilot/gpt-5 "), "github-copilot/gpt-5");
});
