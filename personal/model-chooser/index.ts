export const OPTIMIZATION_DIMENSIONS = ["quality", "speed", "cost"] as const;
export type OptimizationDimension = (typeof OPTIMIZATION_DIMENSIONS)[number];

export const OPTIMIZATION_POLICIES = [
	"auto",
	"quality",
	"speed",
	"cost",
	"quality-speed",
	"quality-cost",
	"speed-cost",
	"balanced",
] as const;
export type OptimizationPolicy = (typeof OPTIMIZATION_POLICIES)[number];
export type ResolvedOptimizationPolicy = Exclude<OptimizationPolicy, "auto">;

export const CHOOSER_ROLES = ["generic", "scout", "planner", "worker", "reviewer", "code-review", "rubber-duck"] as const;
export type ChooserRole = (typeof CHOOSER_ROLES)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type SpawnResolvable = boolean | "unknown";

export interface ModelIdentity {
	provider: string;
	id: string;
	name?: string;
	family?: string;
	vendor?: string;
}

export interface SignalProvenance {
	/** Stable source name, such as "pi-catalog", "models.dev", or "local-eval". */
	source: string;
	url?: string;
	fetchedAt?: string;
}

/**
 * A normalized desirability signal. Higher values are always better, including
 * cost (where 1 means most economical) and speed (where 1 means fastest).
 */
export interface UtilitySignal {
	value: number;
	confidence: number;
	provenance: SignalProvenance;
}

/** A model/thinking-level pair. Signals should describe this exact pair. */
export interface CandidateVariant {
	thinkingLevel: ThinkingLevel;
	signals: Partial<Record<OptimizationDimension, UtilitySignal>>;
}

export interface ModelCandidate extends ModelIdentity {
	input: readonly ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	/** Whether a fresh child process can resolve this model. */
	spawnResolvable: SpawnResolvable;
	variants: readonly CandidateVariant[];
}

export interface SelectionConstraints {
	allowedProviders?: readonly string[];
	deniedProviders?: readonly string[];
	requiredInput?: readonly ("text" | "image")[];
	minimumContextWindow?: number;
	minimumMaxTokens?: number;
	requireReasoning?: boolean;
	requireSpawnResolvable?: boolean;
	excludedModels?: readonly string[];
}

/** Categorical preferences are compared before optimization utility. */
export interface SelectionPreferences {
	preferDifferentFamilyFrom?: string;
	preferDifferentVendorFrom?: string;
}

export interface SelectionRequest {
	policy?: OptimizationPolicy;
	role?: ChooserRole;
	constraints?: SelectionConstraints;
	preferences?: SelectionPreferences;
	/** Exact provider/id or an unambiguous bare model id. */
	modelOverride?: string;
	thinkingLevelOverride?: ThinkingLevel;
	maxAlternatives?: number;
}

export interface RejectedCandidate {
	model: ModelIdentity;
	reasons: string[];
}

export interface DimensionScore {
	dimension: OptimizationDimension;
	known: boolean;
	value?: number;
	confidence: number;
	/** Confidence-adjusted utility used by ranking. */
	effectiveValue: number;
	provenance?: SignalProvenance;
}

export interface RankedCandidate {
	model: ModelCandidate;
	thinkingLevel: ThinkingLevel;
	utility: number;
	confidence: number;
	dimensionScores: DimensionScore[];
	diversityRank: number;
}

export interface SelectionDecision {
	requestedPolicy: OptimizationPolicy;
	resolvedPolicy: ResolvedOptimizationPolicy;
	selected?: RankedCandidate;
	alternatives: RankedCandidate[];
	reasons: string[];
	caveats: string[];
	rejected: RejectedCandidate[];
	error?: string;
}

export type ModelResolution<T extends ModelIdentity = ModelIdentity> =
	| { status: "found"; model: T }
	| { status: "ambiguous"; matches: T[] }
	| { status: "not-found" };

export const AUTO_POLICY_BY_ROLE: Readonly<Record<ChooserRole, ResolvedOptimizationPolicy>> = {
	generic: "balanced",
	scout: "speed-cost",
	planner: "quality-speed",
	worker: "balanced",
	reviewer: "quality",
	"code-review": "quality",
	"rubber-duck": "quality",
};

const POLICY_DIMENSIONS: Readonly<Record<ResolvedOptimizationPolicy, readonly OptimizationDimension[]>> = {
	quality: ["quality"],
	speed: ["speed"],
	cost: ["cost"],
	"quality-speed": ["quality", "speed"],
	"quality-cost": ["quality", "cost"],
	"speed-cost": ["speed", "cost"],
	balanced: ["quality", "speed", "cost"],
};

function normalize(value: string): string {
	return value.trim().toLowerCase();
}

export function modelSpec(model: Pick<ModelIdentity, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

export function resolveOptimizationPolicy(
	policy: OptimizationPolicy | undefined,
	role: ChooserRole | undefined,
): { requested: OptimizationPolicy; resolved: ResolvedOptimizationPolicy } {
	const requested = policy ?? "auto";
	return {
		requested,
		resolved: requested === "auto" ? AUTO_POLICY_BY_ROLE[role ?? "generic"] : requested,
	};
}

export function policyDimensions(policy: ResolvedOptimizationPolicy): readonly OptimizationDimension[] {
	return POLICY_DIMENSIONS[policy];
}

/**
 * Resolve a canonical provider/id first, then an unambiguous bare id. This also
 * handles model ids that themselves contain slashes (for example OpenRouter ids).
 */
export function resolveModelSpec<T extends ModelIdentity>(models: readonly T[], requested: string): ModelResolution<T> {
	const wanted = normalize(requested);
	if (!wanted) return { status: "not-found" };

	const canonical = models.filter((model) => normalize(modelSpec(model)) === wanted);
	if (canonical.length === 1) return { status: "found", model: canonical[0] };
	if (canonical.length > 1) return { status: "ambiguous", matches: canonical };

	const byId = models.filter((model) => normalize(model.id) === wanted);
	if (byId.length === 1) return { status: "found", model: byId[0] };
	if (byId.length > 1) return { status: "ambiguous", matches: byId };
	return { status: "not-found" };
}

/** Compare a parent-runtime model with a fresh child-runtime catalog. */
export function assessSpawnResolvability(
	model: ModelIdentity,
	childCatalog: readonly ModelIdentity[],
): boolean {
	return childCatalog.some(
		(candidate) => normalize(candidate.provider) === normalize(model.provider) && normalize(candidate.id) === normalize(model.id),
	);
}

function validateCandidates(candidates: readonly ModelCandidate[]): void {
	const identities = new Set<string>();
	for (const candidate of candidates) {
		const spec = normalize(modelSpec(candidate));
		if (identities.has(spec)) throw new Error(`Duplicate model candidate: ${modelSpec(candidate)}`);
		identities.add(spec);
		if (!candidate.provider.trim() || !candidate.id.trim()) throw new Error("Model provider and id must be non-empty");
		if (!Number.isFinite(candidate.contextWindow) || candidate.contextWindow <= 0)
			throw new Error(`Invalid context window for ${modelSpec(candidate)}`);
		if (!Number.isFinite(candidate.maxTokens) || candidate.maxTokens <= 0)
			throw new Error(`Invalid max tokens for ${modelSpec(candidate)}`);
		if (candidate.variants.length === 0) throw new Error(`No thinking variants for ${modelSpec(candidate)}`);

		const thinkingLevels = new Set<ThinkingLevel>();
		for (const variant of candidate.variants) {
			if (!(THINKING_LEVELS as readonly string[]).includes(variant.thinkingLevel))
				throw new Error(`Invalid thinking level ${String(variant.thinkingLevel)} for ${modelSpec(candidate)}`);
			if (thinkingLevels.has(variant.thinkingLevel))
				throw new Error(`Duplicate thinking level ${variant.thinkingLevel} for ${modelSpec(candidate)}`);
			thinkingLevels.add(variant.thinkingLevel);
			for (const dimension of OPTIMIZATION_DIMENSIONS) {
				const signal = variant.signals[dimension];
				if (!signal) continue;
				if (!Number.isFinite(signal.value) || signal.value < 0 || signal.value > 1)
					throw new Error(`Invalid ${dimension} value for ${modelSpec(candidate)}:${variant.thinkingLevel}`);
				if (!Number.isFinite(signal.confidence) || signal.confidence < 0 || signal.confidence > 1)
					throw new Error(`Invalid ${dimension} confidence for ${modelSpec(candidate)}:${variant.thinkingLevel}`);
				if (!signal.provenance.source.trim())
					throw new Error(`Missing ${dimension} provenance for ${modelSpec(candidate)}:${variant.thinkingLevel}`);
			}
		}
	}
}

function containsNormalized(values: readonly string[] | undefined, value: string): boolean {
	return values?.some((candidate) => normalize(candidate) === normalize(value)) ?? false;
}

function rejectionReasons(candidate: ModelCandidate, constraints: SelectionConstraints): string[] {
	const reasons: string[] = [];
	// A supplied allow-list is fail-closed: an empty list allows no provider.
	if (constraints.allowedProviders !== undefined && !containsNormalized(constraints.allowedProviders, candidate.provider))
		reasons.push(`provider ${candidate.provider} is not allowed`);
	if (containsNormalized(constraints.deniedProviders, candidate.provider))
		reasons.push(`provider ${candidate.provider} is denied`);
	if (constraints.requiredInput?.some((input) => !candidate.input.includes(input)))
		reasons.push(`missing required input: ${constraints.requiredInput.filter((input) => !candidate.input.includes(input)).join(", ")}`);
	if (constraints.minimumContextWindow !== undefined && candidate.contextWindow < constraints.minimumContextWindow)
		reasons.push(`context window ${candidate.contextWindow} is below ${constraints.minimumContextWindow}`);
	if (constraints.minimumMaxTokens !== undefined && candidate.maxTokens < constraints.minimumMaxTokens)
		reasons.push(`max output ${candidate.maxTokens} is below ${constraints.minimumMaxTokens}`);
	if (constraints.requireReasoning && !candidate.reasoning) reasons.push("reasoning support is required");
	if (constraints.requireSpawnResolvable && candidate.spawnResolvable !== true)
		reasons.push(
			candidate.spawnResolvable === "unknown"
				? "child-process resolvability is unknown"
				: "model is not resolvable by a fresh child process",
		);
	if (
		constraints.excludedModels?.some((entry) => {
			const wanted = normalize(entry);
			return wanted === normalize(modelSpec(candidate)) || wanted === normalize(candidate.id);
		})
	)
		reasons.push("model is explicitly excluded");
	return reasons;
}

function scoreDimension(variant: CandidateVariant, dimension: OptimizationDimension): DimensionScore {
	const signal = variant.signals[dimension];
	if (!signal) {
		return { dimension, known: false, confidence: 0, effectiveValue: 0 };
	}
	return {
		dimension,
		known: true,
		value: signal.value,
		confidence: signal.confidence,
		effectiveValue: signal.value * signal.confidence,
		provenance: signal.provenance,
	};
}

function jointUtility(scores: readonly DimensionScore[]): number {
	if (scores.length === 1) return scores[0].effectiveValue;
	if (scores.some((score) => score.effectiveValue <= 0)) return 0;
	const logMean = scores.reduce((sum, score) => sum + Math.log(score.effectiveValue), 0) / scores.length;
	return Math.exp(logMean);
}

function diversityRank(model: ModelCandidate, preferences: SelectionPreferences): number {
	let rank = 0;
	if (
		preferences.preferDifferentFamilyFrom &&
		model.family &&
		normalize(model.family) !== normalize(preferences.preferDifferentFamilyFrom)
	)
		rank += 2;
	if (
		preferences.preferDifferentVendorFrom &&
		model.vendor &&
		normalize(model.vendor) !== normalize(preferences.preferDifferentVendorFrom)
	)
		rank += 1;
	return rank;
}

function rankVariant(
	model: ModelCandidate,
	variant: CandidateVariant,
	dimensions: readonly OptimizationDimension[],
	preferences: SelectionPreferences,
): RankedCandidate {
	const dimensionScores = dimensions.map((dimension) => scoreDimension(variant, dimension));
	return {
		model,
		thinkingLevel: variant.thinkingLevel,
		utility: jointUtility(dimensionScores),
		confidence: dimensionScores.reduce((sum, score) => sum + score.confidence, 0) / dimensionScores.length,
		dimensionScores,
		diversityRank: diversityRank(model, preferences),
	};
}

function compareRanked(left: RankedCandidate, right: RankedCandidate): number {
	if (left.diversityRank !== right.diversityRank) return right.diversityRank - left.diversityRank;
	if (left.utility !== right.utility) return right.utility - left.utility;
	if (left.confidence !== right.confidence) return right.confidence - left.confidence;
	const leftKnown = left.dimensionScores.filter((score) => score.known).length;
	const rightKnown = right.dimensionScores.filter((score) => score.known).length;
	if (leftKnown !== rightKnown) return rightKnown - leftKnown;
	const leftSpec = modelSpec(left.model);
	const rightSpec = modelSpec(right.model);
	// Code-unit ordering is deterministic across host locales and operating systems.
	if (leftSpec < rightSpec) return -1;
	if (leftSpec > rightSpec) return 1;
	return THINKING_LEVELS.indexOf(left.thinkingLevel) - THINKING_LEVELS.indexOf(right.thinkingLevel);
}

function formatSignalReason(score: DimensionScore): string {
	if (!score.known) return `${score.dimension}: unknown (conservatively scored as 0)`;
	return `${score.dimension}: ${score.value?.toFixed(2)} × ${score.confidence.toFixed(2)} confidence (${score.provenance?.source})`;
}

function emptyDecision(
	requestedPolicy: OptimizationPolicy,
	resolvedPolicy: ResolvedOptimizationPolicy,
	rejected: RejectedCandidate[],
	error: string,
): SelectionDecision {
	return {
		requestedPolicy,
		resolvedPolicy,
		alternatives: [],
		reasons: [],
		caveats: [],
		rejected,
		error,
	};
}

export function selectModel(
	candidates: readonly ModelCandidate[],
	request: SelectionRequest = {},
): SelectionDecision {
	validateCandidates(candidates);
	const { requested, resolved } = resolveOptimizationPolicy(request.policy, request.role);
	const constraints = request.constraints ?? {};
	const preferences = request.preferences ?? {};
	const rejected: RejectedCandidate[] = [];
	const eligible: ModelCandidate[] = [];

	for (const candidate of candidates) {
		const reasons = rejectionReasons(candidate, constraints);
		if (reasons.length > 0) rejected.push({ model: candidate, reasons });
		else eligible.push(candidate);
	}

	let pool = eligible;
	const reasons: string[] = [];
	if (requested === "auto") reasons.push(`Policy auto resolved to ${resolved} for role ${request.role ?? "generic"}`);
	else reasons.push(`Using explicit ${resolved} policy`);

	if (request.modelOverride) {
		const resolution = resolveModelSpec(candidates, request.modelOverride);
		if (resolution.status === "not-found")
			return emptyDecision(requested, resolved, rejected, `Requested model "${request.modelOverride}" was not found`);
		if (resolution.status === "ambiguous") {
			const matches = resolution.matches.map(modelSpec).sort().join(", ");
			return emptyDecision(requested, resolved, rejected, `Requested model "${request.modelOverride}" is ambiguous: ${matches}`);
		}
		const matchingEligible = eligible.find(
			(candidate) => normalize(modelSpec(candidate)) === normalize(modelSpec(resolution.model)),
		);
		if (!matchingEligible) {
			const rejection = rejected.find(
				(candidate) => normalize(modelSpec(candidate.model)) === normalize(modelSpec(resolution.model)),
			);
			return emptyDecision(
				requested,
				resolved,
				rejected,
				`Requested model "${modelSpec(resolution.model)}" is ineligible${rejection ? `: ${rejection.reasons.join("; ")}` : ""}`,
			);
		}
		pool = [matchingEligible];
		reasons.push(`Exact model override selected ${modelSpec(matchingEligible)}`);
	}

	if (pool.length === 0) return emptyDecision(requested, resolved, rejected, "No eligible models are available");

	const dimensions = policyDimensions(resolved);
	const ranked = pool
		.flatMap((model) =>
			model.variants
				.filter((variant) => !request.thinkingLevelOverride || variant.thinkingLevel === request.thinkingLevelOverride)
				.map((variant) => rankVariant(model, variant, dimensions, preferences)),
		)
		.sort(compareRanked);

	if (ranked.length === 0) {
		return emptyDecision(
			requested,
			resolved,
			rejected,
			request.thinkingLevelOverride
				? `No eligible model supports thinking level ${request.thinkingLevelOverride}`
				: "No eligible model/thinking variants are available",
		);
	}

	const selected = ranked[0];
	reasons.push(`Selected ${modelSpec(selected.model)} at thinking level ${selected.thinkingLevel}`);
	for (const score of selected.dimensionScores) reasons.push(formatSignalReason(score));
	if (selected.diversityRank > 0) reasons.push("Applied categorical model-family/vendor diversity preference before utility ranking");

	const caveats = selected.dimensionScores
		.filter((score) => !score.known)
		.map((score) => `Selected candidate has no known ${score.dimension} signal`);
	if (selected.model.spawnResolvable === "unknown") caveats.push("Child-process resolvability is unknown");

	const utilityLeader = [...ranked].sort((left, right) => {
		if (left.utility !== right.utility) return right.utility - left.utility;
		if (left.confidence !== right.confidence) return right.confidence - left.confidence;
		return compareRanked(left, right);
	})[0];
	if (
		selected.diversityRank > 0 &&
		utilityLeader &&
		modelSpec(utilityLeader.model) !== modelSpec(selected.model) &&
		utilityLeader.utility > selected.utility
	) {
		caveats.push(
			`Categorical diversity preference overrode higher-utility candidate ${modelSpec(utilityLeader.model)}`,
		);
	}

	// Alternatives are alternative models, not additional thinking variants of
	// the selected model. Keep only the best-ranked variant for each model.
	const alternativeModels: RankedCandidate[] = [];
	const seenModels = new Set([normalize(modelSpec(selected.model))]);
	for (const alternative of ranked.slice(1)) {
		const spec = normalize(modelSpec(alternative.model));
		if (seenModels.has(spec)) continue;
		seenModels.add(spec);
		alternativeModels.push(alternative);
	}

	const requestedMaxAlternatives = request.maxAlternatives ?? 3;
	const maxAlternatives = Number.isFinite(requestedMaxAlternatives)
		? Math.max(0, Math.floor(requestedMaxAlternatives))
		: 3;
	return {
		requestedPolicy: requested,
		resolvedPolicy: resolved,
		selected,
		alternatives: alternativeModels.slice(0, maxAlternatives),
		reasons,
		caveats,
		rejected,
	};
}
