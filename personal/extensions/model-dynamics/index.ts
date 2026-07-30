/**
 * Dynamic GitHub Copilot Model Selector
 *
 * Registers /model_cur, which queries the authenticated Copilot account for
 * currently available models. This is useful when Copilot exposes a model
 * before it appears in pi's generated model catalog.
 */
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  getCopilotCatalogStatus,
  hydrateCopilotCatalog,
  refreshCopilotCatalog,
} from "../../model-chooser/copilot-catalog-runtime.ts";
import {
  getModelsDevMetadataStatus,
  hydrateModelsDevMetadata,
  refreshModelsDevMetadata,
} from "../../model-chooser/models-dev-runtime.ts";
import {
  getReasoningCapabilities,
  isCopilotModelEntry,
  isSelectableCopilotModel,
  resolveCopilotApi,
  shouldRestorePersistedModel,
  type CopilotApi,
  type CopilotModelEntry,
} from "./model-metadata.ts";

const PROVIDER = "github-copilot";
const PERSIST_PATH = path.join(getAgentDir(), "dynamic-model-selection.json");
const FETCH_TIMEOUT_MS = 15_000;

const COPILOT_HEADERS: Record<string, string> = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

const UNKNOWN_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

interface PersistedSelection {
  provider: typeof PROVIDER;
  modelId: string;
  apiEntry?: CopilotModelEntry;
}

interface SessionModel {
  provider: string;
  modelId: string;
}

interface CopilotConnection {
  apiKey: string;
  baseUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePersistedSelection(value: unknown): PersistedSelection | null {
  if (!isRecord(value)) return null;
  if (value.provider !== PROVIDER) return null;
  if (typeof value.modelId !== "string" || !value.modelId.trim()) return null;

  if (value.apiEntry !== undefined) {
    if (!isCopilotModelEntry(value.apiEntry)) return null;
    if (value.apiEntry.id !== value.modelId) return null;
  }

  return {
    provider: PROVIDER,
    modelId: value.modelId,
    ...(value.apiEntry ? { apiEntry: value.apiEntry } : {}),
  };
}

async function loadPersistedSelection(): Promise<PersistedSelection | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(PERSIST_PATH, "utf-8"));
    return parsePersistedSelection(parsed);
  } catch {
    return null;
  }
}

async function savePersistedSelection(
  selection: PersistedSelection
): Promise<void> {
  await fs.mkdir(path.dirname(PERSIST_PATH), { recursive: true });
  const temporaryPath = `${PERSIST_PATH}.${process.pid}.${Date.now()}.tmp`;

  try {
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(selection, null, 2)}\n`,
      { encoding: "utf-8", mode: 0o600 }
    );
    await fs.rename(temporaryPath, PERSIST_PATH);
    await fs.chmod(PERSIST_PATH, 0o600);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function clearPersistedSelection(): Promise<void> {
  await fs.rm(PERSIST_PATH, { force: true });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolveCopilotConnection(
  ctx: ExtensionContext
): Promise<CopilotConnection | undefined> {
  // Resolved provider auth includes Copilot's exchanged bearer token and the
  // account-specific endpoint (including GitHub Enterprise deployments).
  const result = await ctx.modelRegistry.getProviderAuth(PROVIDER);
  const apiKey = result?.auth.apiKey;
  if (!apiKey) return undefined;

  const baseUrl =
    result.auth.baseUrl ??
    ctx.modelRegistry.getProvider(PROVIDER)?.baseUrl;
  if (!baseUrl) {
    throw new Error(`No base URL configured for ${PROVIDER}`);
  }

  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, "") };
}

function hasExplicitModelCliArgument(): boolean {
  return process.argv.slice(2).some(
    (argument) =>
      argument === "--model" ||
      argument.startsWith("--model=") ||
      argument === "--provider" ||
      argument.startsWith("--provider=")
  );
}

function getLastSessionModel(ctx: ExtensionContext): SessionModel | undefined {
  const entries = ctx.sessionManager.getBranch();

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as unknown;
    if (!isRecord(entry) || entry.type !== "message") continue;
    if (!isRecord(entry.message) || entry.message.role !== "assistant") continue;
    if (
      typeof entry.message.provider === "string" &&
      typeof entry.message.model === "string"
    ) {
      return {
        provider: entry.message.provider,
        modelId: entry.message.model,
      };
    }
  }

  return undefined;
}

function modelMatches(
  model: { provider: string; id: string } | undefined,
  selection: PersistedSelection
): boolean {
  return (
    model?.provider === selection.provider && model.id === selection.modelId
  );
}

function modelToConfig(model: Model<Api>): ProviderModelConfig {
  return {
    id: model.id,
    name: model.name ?? model.id,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: [...model.input],
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    headers: model.headers,
    compat: model.compat,
  };
}

function dynamicCompat(
  api: CopilotApi,
  reasoning: boolean
): ProviderModelConfig["compat"] {
  if (api === "openai-completions") {
    return {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: reasoning,
    };
  }

  if (api === "anthropic-messages") {
    return { supportsEagerToolInputStreaming: false };
  }

  return undefined;
}

function buildDynamicModelConfig(
  entry: CopilotModelEntry,
  baseUrl: string
): ProviderModelConfig {
  const api = resolveCopilotApi(entry);
  if (!api) {
    throw new Error(`No supported API endpoint for ${entry.id}`);
  }

  const { reasoning, thinkingLevelMap } = getReasoningCapabilities(entry);
  const limits = entry.capabilities?.limits;

  return {
    id: entry.id,
    name: entry.name?.trim() || entry.id,
    api,
    baseUrl,
    reasoning,
    thinkingLevelMap,
    input: entry.capabilities?.supports?.vision ? ["text", "image"] : ["text"],
    // Copilot's /models endpoint does not provide token prices. Zero is less
    // misleading than applying direct-provider retail prices to Copilot billing.
    cost: UNKNOWN_COST,
    contextWindow: limits?.max_context_window_tokens ?? 200_000,
    maxTokens: limits?.max_output_tokens ?? 64_000,
    headers: COPILOT_HEADERS,
    compat: dynamicCompat(api, reasoning),
  };
}

function registerDynamicModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  entry: CopilotModelEntry,
  baseUrl: string
): void {
  const existingModels = ctx.modelRegistry
    .getAll()
    .filter((model) => model.provider === PROVIDER && model.id !== entry.id)
    .map(modelToConfig);

  pi.registerProvider(PROVIDER, {
    baseUrl,
    // registerProvider requires auth when models are supplied. AuthStorage takes
    // precedence at request time; this placeholder is never sent while logged in.
    apiKey: "unused",
    models: [...existingModels, buildDynamicModelConfig(entry, baseUrl)],
  });
}

async function fetchCopilotModels(
  apiKey: string,
  baseUrl: string,
  externalSignal?: AbortSignal,
): Promise<CopilotModelEntry[]> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        ...COPILOT_HEADERS,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Copilot /models returned ${response.status}: ${body.slice(0, 200)}`
      );
    }

    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new Error("Copilot /models returned an unexpected response shape");
    }

    const unique = new Map<string, CopilotModelEntry>();
    for (const value of payload.data) {
      if (!isCopilotModelEntry(value) || !isSelectableCopilotModel(value)) {
        continue;
      }
      unique.set(value.id, value);
    }

    return [...unique.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Copilot /models timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abort);
  }
}

export default function (pi: ExtensionAPI) {
  let sessionReady = false;
  let changingModel = false;
  let metadataRefreshController: AbortController | undefined;

  pi.on("session_start", async (_event, ctx) => {
    sessionReady = false;
    if (process.env.PI_SUBAGENT_CHILD !== "1") {
      await Promise.all([hydrateModelsDevMetadata(), hydrateCopilotCatalog()]);
      metadataRefreshController?.abort();
      metadataRefreshController = new AbortController();
      const refreshSignal = metadataRefreshController.signal;
      // Stale-while-revalidate: tools use hydrated snapshots immediately;
      // network refresh remains outside model-selection tool execution. Nested
      // child Pi processes skip this to avoid parallel catalog downloads.
      void refreshModelsDevMetadata({ signal: refreshSignal });
      void (async () => {
        try {
          const connection = await resolveCopilotConnection(ctx);
          if (connection) {
            await refreshCopilotCatalog(
              (signal) => fetchCopilotModels(connection.apiKey, connection.baseUrl, signal),
              { signal: refreshSignal },
            );
          }
        } catch {
          // Cached provider metadata remains usable; status/refresh reports errors explicitly.
        }
      })();
    }

    try {
      const saved = await loadPersistedSelection();
      if (!saved) return;

      // Respect explicit CLI selection and resumed sessions that were using a
      // different model. A matching last model restores a missing live model.
      if (
        !shouldRestorePersistedModel({
          saved,
          current: ctx.model,
          lastSessionModel: getLastSessionModel(ctx),
          hasExplicitModelArgument: hasExplicitModelCliArgument(),
        })
      ) {
        return;
      }

      let model = ctx.modelRegistry.find(saved.provider, saved.modelId);
      if (!model && saved.apiEntry && isSelectableCopilotModel(saved.apiEntry)) {
        const connection = await resolveCopilotConnection(ctx);
        if (connection) {
          registerDynamicModel(pi, ctx, saved.apiEntry, connection.baseUrl);
          model = ctx.modelRegistry.find(saved.provider, saved.modelId);
        }
      }

      if (!model) return;

      if (!modelMatches(ctx.model, saved)) {
        changingModel = true;
        try {
          if (!(await pi.setModel(model))) return;
        } finally {
          changingModel = false;
        }
      }

      ctx.ui.setStatus(
        "dynamic-model",
        `Model: ${saved.provider}/${saved.modelId}`
      );
    } catch (error) {
      ctx.ui.notify(
        `Could not restore dynamic model: ${formatError(error)}`,
        "warning"
      );
    } finally {
      sessionReady = true;
    }
  });

  pi.on("model_select", async (event, ctx) => {
    if (!sessionReady || changingModel) return;

    const saved = await loadPersistedSelection();
    if (!saved || modelMatches(event.model, saved)) return;

    try {
      await clearPersistedSelection();
      ctx.ui.setStatus("dynamic-model", undefined);
    } catch (error) {
      ctx.ui.notify(
        `Could not clear dynamic model preference: ${formatError(error)}`,
        "warning"
      );
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    metadataRefreshController?.abort();
    metadataRefreshController = undefined;
    ctx.ui.setStatus("dynamic-model", undefined);
    ctx.ui.setStatus("model-metadata", undefined);
  });

  pi.registerCommand("model-metadata", {
    description: "Inspect or refresh cached Copilot and models.dev chooser metadata",
    getArgumentCompletions: (prefix) => {
      const options = [
        { value: "status", label: "status", description: "Show cache freshness and current-model matches" },
        { value: "refresh", label: "refresh", description: "Refresh authenticated Copilot and conditional models.dev metadata" },
      ];
      const filtered = options.filter((option) => option.value.startsWith(prefix.trim().toLowerCase()));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (action === "refresh") {
        metadataRefreshController?.abort();
        metadataRefreshController = new AbortController();
        const refreshSignal = metadataRefreshController.signal;
        ctx.ui.setStatus("model-metadata", "Refreshing model metadata…");
        const modelsDevPromise = refreshModelsDevMetadata({ force: true, signal: refreshSignal });
        let copilotResult: Awaited<ReturnType<typeof refreshCopilotCatalog>> | undefined;
        try {
          const connection = await resolveCopilotConnection(ctx);
          if (connection) {
            copilotResult = await refreshCopilotCatalog(
              (signal) => fetchCopilotModels(connection.apiKey, connection.baseUrl, signal),
              { force: true, signal: refreshSignal },
            );
          }
        } catch (error) {
          ctx.ui.notify(`Copilot metadata refresh failed; cached metadata kept: ${formatError(error)}`, "error");
        }
        const modelsDevResult = await modelsDevPromise;
        ctx.ui.setStatus("model-metadata", undefined);
        if (modelsDevResult.status === "error")
          ctx.ui.notify(`models.dev refresh failed; cached metadata kept: ${modelsDevResult.error}`, "error");
        else if (modelsDevResult.status === "offline")
          ctx.ui.notify("Metadata refresh skipped because PI_OFFLINE is enabled", "warning");
        else
          ctx.ui.notify(`models.dev metadata: ${modelsDevResult.status}`, "info");
        if (copilotResult)
          ctx.ui.notify(
            copilotResult.status === "error"
              ? `Copilot metadata refresh failed; cached metadata kept: ${copilotResult.error}`
              : `Copilot metadata: ${copilotResult.status}`,
            copilotResult.status === "error" ? "error" : copilotResult.status === "offline" ? "warning" : "info",
          );
      } else if (action !== "status") {
        ctx.ui.notify("Usage: /model-metadata [status|refresh]", "error");
        return;
      }

      const available = ctx.modelRegistry.getAvailable();
      const status = getModelsDevMetadataStatus(available);
      const copilotStatus = getCopilotCatalogStatus(available);
      const unmatched = status.unmatchedModels.length > 0
        ? `; unmatched: ${status.unmatchedModels.slice(0, 5).join(", ")}${status.unmatchedModels.length > 5 ? ` (+${status.unmatchedModels.length - 5})` : ""}`
        : "";
      ctx.ui.notify(
        status.available
          ? `models.dev ${status.fresh ? "fresh" : "stale"}; matched ${status.matchedModels}/${status.matchedModels + status.unmatchedModels.length}; validated ${status.validatedAt}${unmatched}`
          : `No models.dev cache at ${status.cachePath}${unmatched}`,
        status.available ? "info" : "warning",
      );
      const copilotUnmatched = copilotStatus.unmatchedModels.length > 0
        ? `; unmatched: ${copilotStatus.unmatchedModels.slice(0, 5).join(", ")}${copilotStatus.unmatchedModels.length > 5 ? ` (+${copilotStatus.unmatchedModels.length - 5})` : ""}`
        : "";
      ctx.ui.notify(
        copilotStatus.available
          ? `Copilot catalog ${copilotStatus.fresh ? "fresh" : "stale"}; matched ${copilotStatus.matchedModels}/${copilotStatus.matchedModels + copilotStatus.unmatchedModels.length}; fetched ${copilotStatus.fetchedAt}${copilotUnmatched}`
          : `No Copilot metadata cache at ${copilotStatus.cachePath}${copilotUnmatched}`,
        copilotStatus.available ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("model_cur", {
    description: "Select a model from the live GitHub Copilot catalog",
    getArgumentCompletions: (prefix) => {
      const clear = { value: "clear", label: "clear", description: "Clear saved selection" };
      return "clear".startsWith(prefix.trim().toLowerCase()) ? [clear] : null;
    },
    handler: async (args, ctx) => {
      if (args.trim().toLowerCase() === "clear") {
        try {
          await clearPersistedSelection();
          ctx.ui.setStatus("dynamic-model", undefined);
          ctx.ui.notify("Cleared saved dynamic model selection", "info");
        } catch (error) {
          ctx.ui.notify(
            `Could not clear dynamic model selection: ${formatError(error)}`,
            "error"
          );
        }
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify("/model_cur requires an interactive UI", "error");
        return;
      }

      let connection: CopilotConnection | undefined;
      try {
        connection = await resolveCopilotConnection(ctx);
      } catch (error) {
        ctx.ui.notify(
          `Could not resolve ${PROVIDER} authentication: ${formatError(error)}`,
          "error"
        );
        return;
      }
      if (!connection) {
        ctx.ui.notify(`No API key for ${PROVIDER}. Run /login first.`, "error");
        return;
      }

      const { apiKey, baseUrl } = connection;
      ctx.ui.setStatus("dynamic-model", "Fetching Copilot models…");

      let models: CopilotModelEntry[];
      try {
        models = await fetchCopilotModels(apiKey, baseUrl);
        await refreshCopilotCatalog(async () => models, { force: true });
      } catch (error) {
        ctx.ui.notify(formatError(error), "error");
        return;
      } finally {
        ctx.ui.setStatus("dynamic-model", undefined);
      }

      if (models.length === 0) {
        ctx.ui.notify("Copilot returned no compatible tool-capable models", "warning");
        return;
      }

      const currentId =
        ctx.model?.provider === PROVIDER ? ctx.model.id : undefined;
      const labels = models.map((entry) => {
        const name = entry.name && entry.name !== entry.id ? ` — ${entry.name}` : "";
        const current = entry.id === currentId ? "  ← current" : "";
        return `${entry.id}${name}${current}`;
      });

      const choice = await ctx.ui.select("Select Copilot model", labels);
      if (!choice) return;

      const selectedIndex = labels.indexOf(choice);
      const apiEntry = models[selectedIndex];
      if (!apiEntry) {
        ctx.ui.notify("Could not resolve the selected model", "error");
        return;
      }

      let model = ctx.modelRegistry.find(PROVIDER, apiEntry.id);
      let dynamicallyRegistered = false;
      if (!model) {
        try {
          registerDynamicModel(pi, ctx, apiEntry, baseUrl);
          dynamicallyRegistered = true;
          model = ctx.modelRegistry.find(PROVIDER, apiEntry.id);
        } catch (error) {
          ctx.ui.notify(
            `Could not register ${apiEntry.id}: ${formatError(error)}`,
            "error"
          );
          return;
        }
      }

      if (!model) {
        ctx.ui.notify(`Could not resolve model ${apiEntry.id}`, "error");
        return;
      }

      changingModel = true;
      try {
        if (!(await pi.setModel(model))) {
          ctx.ui.notify("Failed to set model: authentication is unavailable", "error");
          return;
        }

        try {
          await savePersistedSelection({
            provider: PROVIDER,
            modelId: apiEntry.id,
            apiEntry,
          });
        } catch (error) {
          ctx.ui.notify(
            `Model switched, but persistence failed: ${formatError(error)}`,
            "warning"
          );
        }
      } finally {
        changingModel = false;
      }

      ctx.ui.setStatus("dynamic-model", `Model: ${PROVIDER}/${apiEntry.id}`);
      ctx.ui.notify(`Switched to ${apiEntry.name || apiEntry.id}`, "info");

      if (dynamicallyRegistered) {
        ctx.ui.notify(
          "Pricing metadata is unavailable for this live model; pi will show a $0 cost estimate.",
          "warning"
        );
      }
      if (apiEntry.warning_message) {
        ctx.ui.notify(apiEntry.warning_message.slice(0, 500), "warning");
      }
    },
  });
}
