import {
	THINKING_LEVELS,
	assessSpawnResolvability,
	type CandidateVariant,
	type ModelCandidate,
	type ModelIdentity,
	type ThinkingLevel,
	type UtilitySignal,
} from "./index.ts";

export interface PiModelLike extends ModelIdentity {
	reasoning: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
	input: readonly ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

const PI_PRICE_CONFIDENCE = 0.55;
const THINKING_PRIOR_CONFIDENCE = 0.2;

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
	return { family: normalized(model.id).split(/[/:]/, 1)[0] || "other", vendor: normalized(model.provider) };
}

/** Mirror Pi's documented thinking-map semantics without coupling pure tests to a Pi installation. */
export function getSupportedThinkingLevels(model: PiModelLike): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

function signal(value: number, confidence: number, source: string): UtilitySignal {
	return { value: Math.max(0, Math.min(1, value)), confidence, provenance: { source } };
}

function positiveReferenceRate(model: PiModelLike): number | undefined {
	if (!model.cost) return undefined;
	const rate = model.cost.input + model.cost.output;
	return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

function effort(level: ThinkingLevel): number {
	const index = THINKING_LEVELS.indexOf(level);
	return index < 0 ? 0 : index / (THINKING_LEVELS.length - 1);
}

function buildVariant(
	level: ThinkingLevel,
	baseCostUtility: number | undefined,
): CandidateVariant {
	const thinkingEffort = effort(level);
	const signals: CandidateVariant["signals"] = {
		// These are deliberately weak priors about the selected effort, not claims
		// about one model family being intrinsically better or faster than another.
		quality: signal(0.45 + 0.55 * thinkingEffort, THINKING_PRIOR_CONFIDENCE, "pi-thinking-effort-prior"),
		speed: signal(1 - 0.55 * thinkingEffort, THINKING_PRIOR_CONFIDENCE, "pi-thinking-effort-prior"),
	};
	if (baseCostUtility !== undefined) {
		// Higher thinking generally consumes more output tokens. This bounded prior
		// keeps the catalog's route price dominant while distinguishing variants.
		signals.cost = signal(
			baseCostUtility * (1 - 0.3 * thinkingEffort),
			PI_PRICE_CONFIDENCE,
			"pi-catalog-base-rates+thinking-effort-prior",
		);
	}
	return { thinkingLevel: level, signals };
}

export function adaptPiModels(
	models: readonly PiModelLike[],
	childCatalog: readonly ModelIdentity[] | undefined,
): ModelCandidate[] {
	const rates = models.map(positiveReferenceRate).filter((rate): rate is number => rate !== undefined);
	const cheapestRate = rates.length > 0 ? Math.min(...rates) : undefined;

	return models.map((model) => {
		const identity = inferModelFamilyVendor(model);
		const rate = positiveReferenceRate(model);
		const baseCostUtility = rate !== undefined && cheapestRate !== undefined ? cheapestRate / rate : undefined;
		return {
			provider: model.provider,
			id: model.id,
			name: model.name,
			...identity,
			input: [...model.input],
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
			spawnResolvable:
				childCatalog === undefined ? "unknown" : assessSpawnResolvability(model, childCatalog),
			variants: getSupportedThinkingLevels(model).map((level) => buildVariant(level, baseCostUtility)),
		};
	});
}
