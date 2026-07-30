import { inferModelFamilyVendor } from "../../model-chooser/pi-adapter.ts";

export interface ModelReference {
  provider: string;
  id: string;
  name?: string;
}

export type ModelFamily = "claude" | "gpt" | "other";

export interface PeerModelSelection {
  model: ModelReference;
  crossFamily: boolean;
}

const CLAUDE_PREFERENCES = [
  "claude-opus-4.9",
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-sonnet-5",
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
];

const GPT_PREFERENCES = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "gpt-5-mini",
];

export function getModelFamily(model: Pick<ModelReference, "id" | "name"> & { provider?: string }): ModelFamily {
  const family = inferModelFamilyVendor({ provider: model.provider ?? "", id: model.id, name: model.name }).family;
  return family === "claude" || family === "gpt" ? family : "other";
}

function preferenceRank(id: string, preferences: string[]): number {
  const normalized = id.toLowerCase();
  const exact = preferences.findIndex((candidate) => normalized === candidate);
  if (exact >= 0) return exact;

  const prefix = preferences.findIndex((candidate) => normalized.startsWith(`${candidate}-`));
  return prefix >= 0 ? prefix + preferences.length : Number.MAX_SAFE_INTEGER;
}

function providerRank(provider: string, family: Exclude<ModelFamily, "other">): number {
  if (family === "claude") {
    if (provider === "anthropic") return 0;
    if (provider === "github-copilot") return 1;
  } else {
    if (provider === "openai") return 0;
    if (provider === "github-copilot") return 1;
  }
  return 2;
}

function pickPreferred(
  candidates: ModelReference[],
  family: Exclude<ModelFamily, "other">,
  currentProvider?: string,
): ModelReference | undefined {
  const preferences = family === "claude" ? CLAUDE_PREFERENCES : GPT_PREFERENCES;
  return [...candidates]
    .filter((model) => getModelFamily(model) === family)
    .sort((left, right) => {
      const leftPreference = preferenceRank(left.id, preferences);
      const rightPreference = preferenceRank(right.id, preferences);
      if (leftPreference !== rightPreference) return leftPreference - rightPreference;

      const leftCurrentProvider = left.provider === currentProvider ? 0 : 1;
      const rightCurrentProvider = right.provider === currentProvider ? 0 : 1;
      if (leftCurrentProvider !== rightCurrentProvider) return leftCurrentProvider - rightCurrentProvider;

      const providerDifference = providerRank(left.provider, family) - providerRank(right.provider, family);
      if (providerDifference !== 0) return providerDifference;
      return right.id.localeCompare(left.id, undefined, { numeric: true });
    })[0];
}

/** Select a model from the opposite family, preferring stable high-capability models. */
export function selectPeerModel(
  current: ModelReference | undefined,
  available: ModelReference[],
): ModelReference | undefined {
  const candidates = available.filter(
    (model) => !current || model.provider !== current.provider || model.id !== current.id,
  );
  const currentFamily = current ? getModelFamily(current) : "other";

  if (currentFamily === "gpt") return pickPreferred(candidates, "claude", current?.provider);
  if (currentFamily === "claude") return pickPreferred(candidates, "gpt", current?.provider);

  return (
    pickPreferred(candidates, "claude", current?.provider) ??
    pickPreferred(candidates, "gpt", current?.provider)
  );
}

/** Prefer an opposite-family peer, then degrade loudly to a different available model. */
export function selectPeerModelWithFallback(
  current: ModelReference | undefined,
  available: ModelReference[],
): PeerModelSelection | undefined {
  const opposite = selectPeerModel(current, available);
  if (opposite) return { model: opposite, crossFamily: true };

  const candidates = available.filter(
    (model) => !current || model.provider !== current.provider || model.id !== current.id,
  );
  const currentFamily = current ? getModelFamily(current) : "other";
  let fallback: ModelReference | undefined;
  if (currentFamily === "gpt" || currentFamily === "claude") {
    fallback = pickPreferred(candidates, currentFamily, current?.provider);
  }
  fallback ??= candidates[0];
  return fallback ? { model: fallback, crossFamily: false } : undefined;
}
