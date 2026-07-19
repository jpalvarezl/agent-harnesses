import assert from "node:assert/strict";
import test from "node:test";
import {
  getModelFamily,
  selectPeerModel,
  selectPeerModelWithFallback,
  type ModelReference,
} from "./model-selection.ts";

const available: ModelReference[] = [
  { provider: "github-copilot", id: "claude-opus-4.7" },
  { provider: "github-copilot", id: "claude-opus-4.8" },
  { provider: "github-copilot", id: "claude-sonnet-5" },
  { provider: "github-copilot", id: "gpt-5.4" },
  { provider: "github-copilot", id: "gpt-5.5" },
];

test("recognizes GPT and Claude model families", () => {
  assert.equal(getModelFamily({ id: "gpt-5.6-sol" }), "gpt");
  assert.equal(getModelFamily({ id: "claude-opus-4.8" }), "claude");
  assert.equal(getModelFamily({ id: "other", name: "Claude custom" }), "claude");
  assert.equal(getModelFamily({ id: "gemini-3.1-pro" }), "other");
});

test("selects the preferred Claude peer for a GPT parent", () => {
  assert.deepEqual(
    selectPeerModel({ provider: "github-copilot", id: "gpt-5.5" }, available),
    { provider: "github-copilot", id: "claude-opus-4.8" },
  );
});

test("selects the preferred GPT peer for a Claude parent", () => {
  assert.deepEqual(
    selectPeerModel({ provider: "github-copilot", id: "claude-opus-4.8" }, available),
    { provider: "github-copilot", id: "gpt-5.5" },
  );
});

test("defaults to Claude when the parent family is neither GPT nor Claude", () => {
  assert.equal(
    selectPeerModel({ provider: "github-copilot", id: "gemini-3.1-pro" }, available)?.id,
    "claude-opus-4.8",
  );
});

test("returns undefined when no opposite-family model is available", () => {
  assert.equal(
    selectPeerModel(
      { provider: "github-copilot", id: "gpt-5.5" },
      [{ provider: "github-copilot", id: "gpt-5.4" }],
    ),
    undefined,
  );
});

test("falls back to a different same-family model and marks the fallback", () => {
  assert.deepEqual(
    selectPeerModelWithFallback(
      { provider: "github-copilot", id: "gpt-5.5" },
      [{ provider: "github-copilot", id: "gpt-5.4" }],
    ),
    {
      model: { provider: "github-copilot", id: "gpt-5.4" },
      crossFamily: false,
    },
  );
});

test("does not fall back to the current model", () => {
  assert.equal(
    selectPeerModelWithFallback(
      { provider: "github-copilot", id: "gpt-5.5" },
      [{ provider: "github-copilot", id: "gpt-5.5" }],
    ),
    undefined,
  );
});
