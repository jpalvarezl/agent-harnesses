import assert from "node:assert/strict";
import test from "node:test";

import {
  getReasoningCapabilities,
  isCopilotModelEntry,
  isSelectableCopilotModel,
  resolveCopilotApi,
  shouldRestorePersistedModel,
  type CopilotModelEntry,
} from "./model-metadata.ts";

test("resolves advertised Copilot endpoints before model-name heuristics", () => {
  assert.equal(
    resolveCopilotApi({ id: "gpt-next", supported_endpoints: ["/responses"] }),
    "openai-responses"
  );
  assert.equal(
    resolveCopilotApi({ id: "claude-next", supported_endpoints: ["/chat/completions"] }),
    "openai-completions"
  );
  assert.equal(
    resolveCopilotApi({ id: "model", supported_endpoints: ["/v1/messages"] }),
    "anthropic-messages"
  );
});

test("falls back to legacy ID inference only when endpoints are absent", () => {
  assert.equal(resolveCopilotApi({ id: "claude-next" }), "anthropic-messages");
  assert.equal(resolveCopilotApi({ id: "gpt-5-next" }), "openai-responses");
  assert.equal(
    resolveCopilotApi({ id: "unknown", supported_endpoints: ["/embeddings"] }),
    undefined
  );
});

test("maps advertised reasoning levels without inventing unsupported levels", () => {
  const entry: CopilotModelEntry = {
    id: "gpt-5.6-sol",
    capabilities: {
      supports: {
        reasoning_effort: ["none", "low", "medium", "high", "xhigh", "max"],
      },
    },
  };

  assert.deepEqual(getReasoningCapabilities(entry), {
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
  });
});

test("validates persisted provider metadata used at runtime", () => {
  assert.equal(
    isCopilotModelEntry({
      id: "valid",
      supported_endpoints: ["/responses"],
      capabilities: {
        limits: { max_context_window_tokens: 200_000 },
        supports: { reasoning_effort: ["none", "high"] },
      },
    }),
    true
  );
  assert.equal(
    isCopilotModelEntry({
      id: "invalid",
      warning_message: { unexpected: true },
    }),
    false
  );
  assert.equal(
    isCopilotModelEntry({
      id: "invalid",
      capabilities: { limits: { max_output_tokens: -1 } },
    }),
    false
  );
});

test("restoration respects explicit and resumed-session model choices", () => {
  const saved = { provider: "github-copilot", modelId: "live-model" };

  assert.equal(
    shouldRestorePersistedModel({
      saved,
      hasExplicitModelArgument: true,
    }),
    false
  );
  assert.equal(
    shouldRestorePersistedModel({
      saved,
      lastSessionModel: { provider: "github-copilot", modelId: "other" },
      hasExplicitModelArgument: false,
    }),
    false
  );
  assert.equal(
    shouldRestorePersistedModel({
      saved,
      lastSessionModel: saved,
      hasExplicitModelArgument: false,
    }),
    true
  );
  assert.equal(
    shouldRestorePersistedModel({
      saved,
      current: { provider: "github-copilot", id: "live-model" },
      lastSessionModel: { provider: "github-copilot", modelId: "other" },
      hasExplicitModelArgument: false,
    }),
    true
  );
});

test("filters explicitly disabled or incompatible models", () => {
  const base: CopilotModelEntry = {
    id: "chat-model",
    supported_endpoints: ["/responses"],
    capabilities: { type: "chat", supports: { streaming: true, tool_calls: true } },
  };

  assert.equal(isSelectableCopilotModel(base), true);
  assert.equal(
    isSelectableCopilotModel({ ...base, model_picker_enabled: false }),
    false
  );
  assert.equal(
    isSelectableCopilotModel({
      ...base,
      capabilities: { ...base.capabilities, supports: { tool_calls: false } },
    }),
    false
  );
  assert.equal(
    isSelectableCopilotModel({
      ...base,
      capabilities: { ...base.capabilities, type: "embedding" },
    }),
    false
  );
});
