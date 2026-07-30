import {
	THINKING_LEVELS,
	assessSpawnResolvability,
	type CandidateVariant,
	type MetadataAttribution,
	type ModelCandidate,
	type ModelIdentity,
	type SignalProvenance,
	type ThinkingLevel,
	type UtilitySignal,
} from "./index.ts";
import { lookupCopilotIdentity, type CopilotCatalogSnapshot, type CopilotIdentityEnrichment } from "./copilot-catalog.ts";
import { lookupModelsDevMetadata, type ModelsDevEnrichment, type ModelsDevSnapshot } from "./models-dev.ts";

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

export interface PiAdapterOptions {
	copilot?: CopilotCatalogSnapshot;
	modelsDev?: ModelsDevSnapshot;
	now?: Date;
}

interface CostBasis {
	rate: number;
	confidence: number;
	provenance: SignalProvenance;
}

interface PreparedModel {
	model: PiModelLike;
	copilot?: CopilotIdentityEnrichment;
	modelsDev?: ModelsDevEnrichment;
	cost?: CostBasis;
}

const PI_PRICE_CONFIDENCE = 0.55;
const MODELS_DEV_PRICE_CONFIDENCE = { fresh: 0.45, stale: 0.3 } as const;
const THINKING_PRIOR_CONFIDENCE = 0.2;
const HEURISTIC_IDENTITY_CONFIDENCE = 0.45;

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

function signal(
	value: number,
	confidence: number,
	provenance: SignalProvenance,
): UtilitySignal {
	return { value: Math.max(0, Math.min(1, value)), confidence, provenance };
}

function positivePiReferenceRate(model: PiModelLike): number | undefined {
	if (!model.cost) return undefined;
	const rate = model.cost.input + model.cost.output;
	return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

function resolveCostBasis(model: PiModelLike, enrichment: ModelsDevEnrichment | undefined): CostBasis | undefined {
	const piRate = positivePiReferenceRate(model);
	if (piRate !== undefined) {
		return {
			rate: piRate,
			confidence: PI_PRICE_CONFIDENCE,
			provenance: {
				source: "pi-catalog-base-rates",
				detail: "Input + output route list-price proxy; may not match subscription credits or premium requests",
			},
		};
	}
	if (!enrichment?.cost || !enrichment.costProvenance) return undefined;
	const rate = enrichment.cost.input + enrichment.cost.output;
	if (!Number.isFinite(rate) || rate <= 0) return undefined;
	const freshness = enrichment.costProvenance.freshness ?? "stale";
	return {
		rate,
		confidence: MODELS_DEV_PRICE_CONFIDENCE[freshness],
		provenance: { ...enrichment.costProvenance },
	};
}

function effort(level: ThinkingLevel): number {
	const index = THINKING_LEVELS.indexOf(level);
	return index < 0 ? 0 : index / (THINKING_LEVELS.length - 1);
}

function buildVariant(level: ThinkingLevel, cost: (CostBasis & { utility: number }) | undefined): CandidateVariant {
	const thinkingEffort = effort(level);
	const signals: CandidateVariant["signals"] = {
		// These are deliberately weak priors about the selected effort, not claims
		// about one model family being intrinsically better or faster than another.
		quality: signal(0.45 + 0.55 * thinkingEffort, THINKING_PRIOR_CONFIDENCE, {
			source: "pi-thinking-effort-prior",
		}),
		speed: signal(1 - 0.55 * thinkingEffort, THINKING_PRIOR_CONFIDENCE, {
			source: "pi-thinking-effort-prior",
		}),
	};
	if (cost) {
		// Higher thinking generally consumes more output tokens. This bounded prior
		// keeps the route price dominant while distinguishing variants.
		signals.cost = signal(cost.utility * (1 - 0.3 * thinkingEffort), cost.confidence, {
			...cost.provenance,
			detail: `${cost.provenance.detail ?? "Reference route rate"}; adjusted by thinking-effort prior`,
		});
	}
	return { thinkingLevel: level, signals };
}

function heuristicAttribution(field: "family" | "vendor"): MetadataAttribution {
	return {
		confidence: HEURISTIC_IDENTITY_CONFIDENCE,
		provenance: { source: "model-id-heuristic", detail: `${field} inferred from model/provider naming` },
	};
}

function enrichedCoarseFamily(vendor: string | undefined, modelFamily: string | undefined): string | undefined {
	const value = `${vendor ?? ""} ${modelFamily ?? ""}`.toLowerCase();
	if (/\b(anthropic|claude)\b/.test(value)) return "claude";
	if (/\b(openai|gpt|codex)\b/.test(value)) return "gpt";
	if (/\b(google|gemini|gemma)\b/.test(value)) return "gemini";
	if (/\b(microsoft|mai)\b/.test(value)) return "mai";
	if (/\b(alibaba|qwen|qwq)\b/.test(value)) return "qwen";
	if (/\b(deepseek)\b/.test(value)) return "deepseek";
	if (/\b(xai|grok)\b/.test(value)) return "grok";
	if (/\b(mistral|codestral|ministral)\b/.test(value)) return "mistral";
	if (/\b(moonshotai|kimi)\b/.test(value)) return "kimi";
	if (/\b(minimax)\b/.test(value)) return "minimax";
	if (/\b(zai|glm)\b/.test(value)) return "glm";
	return undefined;
}

function coarseFamilyAttribution(
	source: MetadataAttribution | undefined,
	vendor: string | undefined,
	modelFamily: string | undefined,
): MetadataAttribution | undefined {
	if (!source) return undefined;
	return {
		confidence: source.confidence,
		provenance: {
			...source.provenance,
			detail: `coarse independence family derived from ${vendor ? `vendor ${vendor}` : `model family ${modelFamily}`}`,
		},
	};
}

export function adaptPiModels(
	models: readonly PiModelLike[],
	childCatalog: readonly ModelIdentity[] | undefined,
	options: PiAdapterOptions = {},
): ModelCandidate[] {
	const now = options.now ?? new Date();
	const prepared: PreparedModel[] = models.map((model) => {
		const copilot = lookupCopilotIdentity(options.copilot, model, now);
		const modelsDev = lookupModelsDevMetadata(options.modelsDev, model, now);
		return { model, copilot, modelsDev, cost: resolveCostBasis(model, modelsDev) };
	});
	// Pi and models.dev rates are both USD per million tokens (input + output),
	// so they can share one normalization pool. Do not add other billing units.
	const knownRates = prepared.map((entry) => entry.cost?.rate).filter((rate): rate is number => rate !== undefined);
	const cheapestRate = knownRates.length > 0 ? Math.min(...knownRates) : undefined;

	return prepared.map(({ model, copilot, modelsDev, cost }) => {
		const heuristic = inferModelFamilyVendor(model);
		const vendor = copilot?.vendor ?? modelsDev?.vendor ?? heuristic.vendor;
		const modelFamily = copilot?.modelFamily ?? modelsDev?.family;
		const metadataCoarseFamily = enrichedCoarseFamily(vendor, modelFamily);
		const family = metadataCoarseFamily ?? heuristic.family;
		const vendorMetadata = copilot?.identityMetadata?.vendor ?? modelsDev?.identityMetadata?.vendor;
		const modelFamilyMetadata = copilot?.identityMetadata?.modelFamily ?? modelsDev?.identityMetadata?.family;
		const normalizedCost = cost && cheapestRate !== undefined ? { ...cost, utility: cheapestRate / cost.rate } : undefined;
		return {
			provider: model.provider,
			id: model.id,
			name: model.name,
			family,
			modelFamily,
			vendor,
			identityMetadata: {
				family:
					(metadataCoarseFamily ? coarseFamilyAttribution(vendorMetadata ?? modelFamilyMetadata, vendor, modelFamily) : undefined) ??
					(family ? heuristicAttribution("family") : undefined),
				modelFamily: modelFamilyMetadata,
				vendor: vendorMetadata ?? (vendor ? heuristicAttribution("vendor") : undefined),
			},
			input: [...model.input],
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
			spawnResolvable: childCatalog === undefined ? "unknown" : assessSpawnResolvability(model, childCatalog),
			variants: getSupportedThinkingLevels(model).map((level) => buildVariant(level, normalizedCost)),
		};
	});
}
