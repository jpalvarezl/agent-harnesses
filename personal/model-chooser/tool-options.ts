import {
	OPTIMIZATION_POLICIES,
	THINKING_LEVELS,
	type OptimizationPolicy,
	type ThinkingLevel,
} from "./index.ts";

/** Sentinel-first enums are robust when strict tool callers materialize optional fields. */
export const TOOL_POLICY_VALUES = ["legacy", ...OPTIMIZATION_POLICIES] as const;
export type ToolPolicy = (typeof TOOL_POLICY_VALUES)[number];

export const TOOL_THINKING_VALUES = ["auto", ...THINKING_LEVELS] as const;
export type ToolThinkingLevel = (typeof TOOL_THINKING_VALUES)[number];

export function normalizeToolPolicy(value: ToolPolicy | undefined): OptimizationPolicy | undefined {
	return value === undefined || value === "legacy" ? undefined : value;
}

export function normalizeToolThinking(value: ToolThinkingLevel | undefined): ThinkingLevel | undefined {
	return value === undefined || value === "auto" ? undefined : value;
}

/** Item values override call-level defaults; sentinels inherit the default. */
export function resolveToolPolicy(
	item: ToolPolicy | undefined,
	callDefault: ToolPolicy | undefined,
): OptimizationPolicy | undefined {
	return normalizeToolPolicy(item) ?? normalizeToolPolicy(callDefault);
}

export function resolveToolThinking(
	item: ToolThinkingLevel | undefined,
	callDefault: ToolThinkingLevel | undefined,
): ThinkingLevel | undefined {
	return normalizeToolThinking(item) ?? normalizeToolThinking(callDefault);
}

export function normalizeToolModel(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}
