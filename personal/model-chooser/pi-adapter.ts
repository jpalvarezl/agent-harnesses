import {
	THINKING_LEVELS,
	assessSpawnResolvability,
	type ModelCandidate,
	type ModelIdentity,
	type ThinkingLevel,
} from "./index.ts";

export interface PiModelLike extends ModelIdentity {
	reasoning: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

function normalized(value: string): string {
	return value.trim().toLowerCase();
}

export function inferModelFamilyVendor(
	model: Pick<ModelIdentity, "provider" | "id" | "name">,
): Pick<ModelIdentity, "family" | "vendor"> {
	const value = `${model.id} ${model.name ?? ""}`.toLowerCase();
	if (/\b(claude|opus|sonnet|haiku)\b/.test(value)) return { family: "claude", vendor: "anthropic" };
	if (/\b(gpt|openai|codex)\b/.test(value)) return { family: "gpt", vendor: "openai" };
	if (/\b(gemini|gemma)\b/.test(value)) return { family: "gemini", vendor: "google" };
	if (/\b(qwen|qwq)\b/.test(value)) return { family: "qwen", vendor: "alibaba" };
	if (/\b(deepseek)\b/.test(value)) return { family: "deepseek", vendor: "deepseek" };
	if (/\b(grok)\b/.test(value)) return { family: "grok", vendor: "xai" };
	if (/\b(mistral|codestral|ministral)\b/.test(value)) return { family: "mistral", vendor: "mistral" };
	if (/\b(kimi|moonshot)\b/.test(value)) return { family: "kimi", vendor: "moonshotai" };
	if (/\b(minimax)\b/.test(value)) return { family: "minimax", vendor: "minimax" };
	if (/\b(glm|zai|z\.ai)\b/.test(value)) return { family: "glm", vendor: "zai" };
	if (/\b(mai-code|mai)\b/.test(value)) return { family: "mai", vendor: "microsoft" };
	return { family: normalized(model.id).split(/[/:]/, 1)[0] || "other", vendor: normalized(model.provider) };
}

export function getSupportedThinkingLevels(model: PiModelLike): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

function positiveReferenceRate(model: PiModelLike): number | undefined {
	if (!model.cost) return undefined;
	const rate = model.cost.input + model.cost.output;
	return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

export function adaptPiModels(
	models: readonly PiModelLike[],
	childCatalog: readonly ModelIdentity[] | undefined,
): ModelCandidate[] {
	return models.map((model) => ({
		provider: model.provider,
		id: model.id,
		name: model.name,
		...inferModelFamilyVendor(model),
		cost: positiveReferenceRate(model),
		spawnResolvable: childCatalog === undefined ? "unknown" : assessSpawnResolvability(model, childCatalog),
		variants: getSupportedThinkingLevels(model).map((thinkingLevel) => ({ thinkingLevel })),
	}));
}
