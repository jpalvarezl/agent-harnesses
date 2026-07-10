import type { Api } from "@earendil-works/pi-ai";

export type CopilotApi = Extract<
  Api,
  "anthropic-messages" | "openai-completions" | "openai-responses"
>;

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ThinkingLevelMap = Partial<
  Record<ThinkingLevel, string | null>
>;

export interface CopilotModelEntry {
  id: string;
  name?: string;
  object?: string;
  version?: string;
  vendor?: string;
  preview?: boolean;
  model_picker_enabled?: boolean;
  supported_endpoints?: string[];
  warning_message?: string;
  capabilities?: {
    type?: string;
    family?: string;
    limits?: {
      max_context_window_tokens?: number;
      max_output_tokens?: number;
      max_prompt_tokens?: number;
    };
    supports?: {
      parallel_tool_calls?: boolean;
      reasoning_effort?: boolean | string[];
      streaming?: boolean;
      structured_outputs?: boolean;
      tool_calls?: boolean;
      vision?: boolean;
    };
  };
}

export interface ReasoningCapabilities {
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
}

export interface PersistedModelReference {
  provider: string;
  modelId: string;
}

export interface ActiveModelReference {
  provider: string;
  id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isOptionalPositiveNumber(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value > 0)
  );
}

function isCapabilities(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (!isOptionalString(value.type) || !isOptionalString(value.family)) return false;

  if (value.limits !== undefined) {
    if (!isRecord(value.limits)) return false;
    if (
      !isOptionalPositiveNumber(value.limits.max_context_window_tokens) ||
      !isOptionalPositiveNumber(value.limits.max_output_tokens) ||
      !isOptionalPositiveNumber(value.limits.max_prompt_tokens)
    ) {
      return false;
    }
  }

  if (value.supports !== undefined) {
    if (!isRecord(value.supports)) return false;
    for (const field of [
      "parallel_tool_calls",
      "streaming",
      "structured_outputs",
      "tool_calls",
      "vision",
    ]) {
      if (!isOptionalBoolean(value.supports[field])) return false;
    }

    const reasoningEffort = value.supports.reasoning_effort;
    if (
      reasoningEffort !== undefined &&
      typeof reasoningEffort !== "boolean" &&
      (!Array.isArray(reasoningEffort) ||
        !reasoningEffort.every((level) => typeof level === "string"))
    ) {
      return false;
    }
  }

  return true;
}

export function isCopilotModelEntry(
  value: unknown
): value is CopilotModelEntry {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) {
    return false;
  }

  if (
    !isOptionalString(value.name) ||
    !isOptionalString(value.object) ||
    !isOptionalString(value.version) ||
    !isOptionalString(value.vendor) ||
    !isOptionalString(value.warning_message) ||
    !isOptionalBoolean(value.preview) ||
    !isOptionalBoolean(value.model_picker_enabled)
  ) {
    return false;
  }

  if (
    value.supported_endpoints !== undefined &&
    (!Array.isArray(value.supported_endpoints) ||
      !value.supported_endpoints.every((endpoint) => typeof endpoint === "string"))
  ) {
    return false;
  }

  return isCapabilities(value.capabilities);
}

function persistedReferenceMatches(
  model: PersistedModelReference | undefined,
  saved: PersistedModelReference
): boolean {
  return model?.provider === saved.provider && model.modelId === saved.modelId;
}

/** Decide whether startup restoration should supersede pi's initially selected model. */
export function shouldRestorePersistedModel(options: {
  saved: PersistedModelReference;
  current?: ActiveModelReference;
  lastSessionModel?: PersistedModelReference;
  hasExplicitModelArgument: boolean;
}): boolean {
  if (options.hasExplicitModelArgument) return false;

  const currentMatches =
    options.current?.provider === options.saved.provider &&
    options.current.id === options.saved.modelId;

  return (
    !options.lastSessionModel ||
    persistedReferenceMatches(options.lastSessionModel, options.saved) ||
    currentMatches
  );
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().toLowerCase().replace(/^wss?:/, "");
}

function fallbackApi(modelId: string): CopilotApi {
  const normalized = modelId.toLowerCase();
  if (normalized.startsWith("claude")) return "anthropic-messages";
  if (normalized.startsWith("gpt-5") || normalized.includes("codex")) {
    return "openai-responses";
  }
  return "openai-completions";
}

/** Resolve the transport from provider-advertised endpoints, using the ID only for legacy entries. */
export function resolveCopilotApi(
  entry: CopilotModelEntry
): CopilotApi | undefined {
  const endpoints = (entry.supported_endpoints ?? [])
    .map(normalizeEndpoint)
    .filter(Boolean);

  if (endpoints.some((endpoint) => endpoint.endsWith("/messages"))) {
    return "anthropic-messages";
  }
  if (endpoints.some((endpoint) => endpoint.endsWith("/responses"))) {
    return "openai-responses";
  }
  if (endpoints.some((endpoint) => endpoint.endsWith("/chat/completions"))) {
    return "openai-completions";
  }

  // Older Copilot responses did not include supported_endpoints.
  return endpoints.length === 0 ? fallbackApi(entry.id) : undefined;
}

function fallbackReasoning(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return !(
    normalized.startsWith("gpt-4o") || normalized.startsWith("gpt-4.1")
  );
}

export function getReasoningCapabilities(
  entry: CopilotModelEntry
): ReasoningCapabilities {
  const advertised = entry.capabilities?.supports?.reasoning_effort;

  if (typeof advertised === "boolean") {
    return { reasoning: advertised };
  }

  if (!Array.isArray(advertised)) {
    return { reasoning: fallbackReasoning(entry.id) };
  }

  const supported = new Set(
    advertised.map((level) => level.trim().toLowerCase()).filter(Boolean)
  );
  const reasoning = [...supported].some(
    (level) => level !== "none" && level !== "off"
  );
  if (!reasoning) return { reasoning: false };

  const map: ThinkingLevelMap = {};
  const offValue = supported.has("none")
    ? "none"
    : supported.has("off")
      ? "off"
      : null;
  map.off = offValue;

  for (const level of [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ] as const) {
    map[level] = supported.has(level) ? level : null;
  }

  return { reasoning: true, thinkingLevelMap: map };
}

export function isSelectableCopilotModel(entry: CopilotModelEntry): boolean {
  if (!entry.id.trim()) return false;
  if (entry.model_picker_enabled === false) return false;
  if (entry.capabilities?.supports?.tool_calls === false) return false;
  if (entry.capabilities?.supports?.streaming === false) return false;
  if (
    entry.capabilities?.type !== undefined &&
    entry.capabilities.type !== "chat"
  ) {
    return false;
  }
  return resolveCopilotApi(entry) !== undefined;
}
