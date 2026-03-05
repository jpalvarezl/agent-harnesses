/**
 * Dynamic Model Selector Extension
 *
 * Registers /model_cur which queries your GitHub Copilot provider
 * for available models and lets you pick one. The selection persists
 * across sessions via ~/.pi/agent/dynamic-model-selection.json.
 *
 * Uses only the public pi extension API:
 * - pi.registerProvider() to add models dynamically
 * - ctx.modelRegistry for model lookup and API key resolution
 * - pi.setModel() to switch the active model
 */
import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";

const PROVIDER = "github-copilot";
const AGENT_DIR = path.join(process.env.HOME ?? "~", ".pi", "agent");
const PERSIST_PATH = path.join(AGENT_DIR, "dynamic-model-selection.json");

const COPILOT_HEADERS: Record<string, string> = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

interface PersistedSelection {
  provider: string;
  modelId: string;
  apiEntry?: CopilotModelEntry;
}

interface CopilotModelEntry {
  id: string;
  name?: string;
  object?: string;
  version?: string;
  capabilities?: {
    type?: string;
    family?: string;
    limits?: {
      max_context_window_tokens?: number;
      max_output_tokens?: number;
      max_prompt_tokens?: number;
    };
    supports?: {
      vision?: boolean;
      tool_calls?: boolean;
      streaming?: boolean;
    };
  };
}

// ── Persistence helpers ──────────────────────────────────────────────

function loadPersistedSelection(): PersistedSelection | null {
  try {
    return JSON.parse(fs.readFileSync(PERSIST_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function savePersistedSelection(sel: PersistedSelection) {
  fs.mkdirSync(path.dirname(PERSIST_PATH), { recursive: true });
  fs.writeFileSync(PERSIST_PATH, JSON.stringify(sel, null, 2));
}

// ── Token / inference helpers ────────────────────────────────────────

function getBaseUrlFromToken(token: string): string {
  const match = token.match(/proxy-ep=([^;]+)/);
  if (!match) return "https://api.individual.githubcopilot.com";
  return `https://${match[1].replace(/^proxy\./, "api.")}`;
}

function inferApi(
  modelId: string
): "anthropic-messages" | "openai-completions" | "openai-responses" {
  if (modelId.startsWith("claude")) return "anthropic-messages";
  if (modelId.startsWith("gpt-5") || modelId.includes("codex"))
    return "openai-responses";
  return "openai-completions";
}

function inferReasoning(modelId: string): boolean {
  if (modelId.startsWith("gpt-4o") || modelId.startsWith("gpt-4.1"))
    return false;
  return true;
}

function inferContextWindow(modelId: string): number {
  if (modelId.includes("-1m")) return 1000000;
  return 200000;
}

// ── Model registration via public API ────────────────────────────────

/**
 * Convert an existing Model from the registry to a ProviderModelConfig
 * suitable for re-registration via pi.registerProvider().
 */
function modelToConfig(m: Model<Api>): ProviderModelConfig {
  return {
    id: m.id,
    name: m.name,
    api: m.api,
    reasoning: m.reasoning,
    input: m.input as ("text" | "image")[],
    cost: m.cost,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    ...(m.headers ? { headers: m.headers } : {}),
  };
}

/**
 * Build a ProviderModelConfig for a Copilot API model entry.
 */
function buildModelConfig(modelId: string, apiEntry?: CopilotModelEntry): ProviderModelConfig {
  const limits = apiEntry?.capabilities?.limits;
  const supportsVision = apiEntry?.capabilities?.supports?.vision ?? true;

  return {
    id: modelId,
    name: modelId,
    api: inferApi(modelId),
    reasoning: inferReasoning(modelId),
    input: supportsVision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: limits?.max_context_window_tokens ?? inferContextWindow(modelId),
    maxTokens: limits?.max_output_tokens ?? 64000,
  };
}

/**
 * Register a dynamic model under the github-copilot provider using
 * pi.registerProvider(). Preserves all existing models for the provider.
 */
function registerDynamicModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  modelId: string,
  baseUrl: string,
  apiEntry?: CopilotModelEntry,
) {
  // Gather existing github-copilot models (excluding the one we're adding/updating)
  const existingModels = ctx.modelRegistry
    .getAll()
    .filter((m) => m.provider === PROVIDER && m.id !== modelId)
    .map(modelToConfig);

  const newModel = buildModelConfig(modelId, apiEntry);

  // Register all models (existing + new) under the provider.
  // The existing OAuth setup for github-copilot handles API key resolution.
  pi.registerProvider(PROVIDER, {
    baseUrl,
    apiKey: "unused", // OAuth provides the real key; satisfies schema
    headers: COPILOT_HEADERS,
    models: [...existingModels, newModel],
  });
}

// ── Extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Restore persisted model on session start ───────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const saved = loadPersistedSelection();
    if (!saved) return;

    let model = ctx.modelRegistry.find(saved.provider, saved.modelId);

    // If the model isn't in the registry yet, register it dynamically.
    if (!model) {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
      if (apiKey) {
        const baseUrl = getBaseUrlFromToken(apiKey);
        registerDynamicModel(pi, ctx, saved.modelId, baseUrl, saved.apiEntry);
        model = ctx.modelRegistry.find(saved.provider, saved.modelId);
      }
    }

    if (model) {
      const ok = await pi.setModel(model);
      if (ok) {
        ctx.ui.setStatus(
          "dynamic-model",
          `Model: ${saved.provider}/${saved.modelId}`
        );
      }
    }
  });

  // ── /model_cur command ───────────────────────────────────────────────

  pi.registerCommand("model_cur", {
    description: "Select model dynamically from provider API",
    handler: async (_args, ctx) => {
      // 1. Resolve API key
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
      if (!apiKey) {
        ctx.ui.notify(
          `No API key for ${PROVIDER}. Run /login first.`,
          "error"
        );
        return;
      }

      const baseUrl = getBaseUrlFromToken(apiKey);

      // 2. Fetch models
      ctx.ui.setStatus("dynamic-model", "Fetching models…");

      let models: CopilotModelEntry[];
      try {
        const resp = await fetch(`${baseUrl}/models`, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
            ...COPILOT_HEADERS,
          },
        });

        if (!resp.ok) {
          const text = await resp.text();
          ctx.ui.notify(
            `Failed to fetch models: ${resp.status} ${text.slice(0, 200)}`,
            "error"
          );
          ctx.ui.setStatus("dynamic-model", undefined);
          return;
        }

        const json = (await resp.json()) as { data?: CopilotModelEntry[] };
        models = json.data ?? [];
      } catch (err: any) {
        ctx.ui.notify(`Fetch error: ${err.message}`, "error");
        ctx.ui.setStatus("dynamic-model", undefined);
        return;
      }

      ctx.ui.setStatus("dynamic-model", undefined);

      if (models.length === 0) {
        ctx.ui.notify("No models returned by provider.", "warning");
        return;
      }

      // 3. Build selection list
      const sorted = models.map((m) => m.id).sort();
      const current = ctx.model;
      const currentId =
        current?.provider === PROVIDER ? current.id : undefined;
      const displayItems = sorted.map((id) =>
        id === currentId ? `${id}  ← current` : id
      );

      const choice = await ctx.ui.select("Select model", displayItems);
      if (!choice) return;

      const chosenId = choice.replace(/\s+← current$/, "");

      // 4. Resolve the model — register dynamically if not already known
      const apiEntry = models.find((m) => m.id === chosenId);
      let model = ctx.modelRegistry.find(PROVIDER, chosenId);

      if (!model) {
        registerDynamicModel(pi, ctx, chosenId, baseUrl, apiEntry);
        model = ctx.modelRegistry.find(PROVIDER, chosenId);
      }

      if (!model) {
        ctx.ui.notify(`Could not resolve model ${chosenId}`, "error");
        return;
      }

      // 5. Set the model
      const ok = await pi.setModel(model);
      if (!ok) {
        ctx.ui.notify("Failed to set model (no API key?)", "error");
        return;
      }

      // 6. Persist across sessions
      savePersistedSelection({ provider: PROVIDER, modelId: chosenId, apiEntry });
      ctx.ui.setStatus("dynamic-model", `Model: ${PROVIDER}/${chosenId}`);
      ctx.ui.notify(`Switched to ${chosenId}`, "info");
    },
  });
}
