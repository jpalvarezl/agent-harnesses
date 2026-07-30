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

export interface CandidateVariant {
	thinkingLevel: ThinkingLevel;
}

export interface ModelCandidate extends ModelIdentity {
	input: readonly ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	/** Input + output list-price reference rate; absent means unknown. */
	cost?: number;
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

export interface SelectionPreferences {
	preferDifferentFamilyFrom?: string;
	preferDifferentVendorFrom?: string;
}

export interface SelectionRequest {
	policy?: OptimizationPolicy;
	role?: ChooserRole;
	constraints?: SelectionConstraints;
	preferences?: SelectionPreferences;
	modelOverride?: string;
	thinkingLevelOverride?: ThinkingLevel;
	maxAlternatives?: number;
}

export interface RejectedCandidate {
	model: ModelIdentity;
	reasons: string[];
}

export interface RankedCandidate {
	model: ModelCandidate;
	thinkingLevel: ThinkingLevel;
	diversityRank: number;
	cost?: number;
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

/** Transparent thinking presets; quality/speed are not cross-model measurements. */
const POLICY_THINKING_TARGET: Readonly<Record<ResolvedOptimizationPolicy, ThinkingLevel>> = {
	quality: "max",
	speed: "off",
	cost: "off",
	"quality-speed": "medium",
	"quality-cost": "high",
	"speed-cost": "off",
	balanced: "medium",
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
	return { requested, resolved: requested === "auto" ? AUTO_POLICY_BY_ROLE[role ?? "generic"] : requested };
}

export function policyDimensions(policy: ResolvedOptimizationPolicy): readonly OptimizationDimension[] {
	return POLICY_DIMENSIONS[policy];
}

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

export function assessSpawnResolvability(model: ModelIdentity, childCatalog: readonly ModelIdentity[]): boolean {
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
		if (candidate.cost !== undefined && (!Number.isFinite(candidate.cost) || candidate.cost <= 0))
			throw new Error(`Invalid cost for ${modelSpec(candidate)}`);
		if (candidate.variants.length === 0) throw new Error(`No thinking variants for ${modelSpec(candidate)}`);
		const levels = new Set<ThinkingLevel>();
		for (const variant of candidate.variants) {
			if (!(THINKING_LEVELS as readonly string[]).includes(variant.thinkingLevel))
				throw new Error(`Invalid thinking level ${String(variant.thinkingLevel)} for ${modelSpec(candidate)}`);
			if (levels.has(variant.thinkingLevel)) throw new Error(`Duplicate thinking level ${variant.thinkingLevel} for ${modelSpec(candidate)}`);
			levels.add(variant.thinkingLevel);
		}
	}
}

function containsNormalized(values: readonly string[] | undefined, value: string): boolean {
	return values?.some((candidate) => normalize(candidate) === normalize(value)) ?? false;
}

function rejectionReasons(candidate: ModelCandidate, constraints: SelectionConstraints): string[] {
	const reasons: string[] = [];
	if (constraints.allowedProviders !== undefined && !containsNormalized(constraints.allowedProviders, candidate.provider))
		reasons.push(`provider ${candidate.provider} is not allowed`);
	if (containsNormalized(constraints.deniedProviders, candidate.provider)) reasons.push(`provider ${candidate.provider} is denied`);
	const missingInputs = constraints.requiredInput?.filter((input) => !candidate.input.includes(input)) ?? [];
	if (missingInputs.length) reasons.push(`missing required input: ${missingInputs.join(", ")}`);
	if (constraints.minimumContextWindow !== undefined && candidate.contextWindow < constraints.minimumContextWindow)
		reasons.push(`context window ${candidate.contextWindow} is below ${constraints.minimumContextWindow}`);
	if (constraints.minimumMaxTokens !== undefined && candidate.maxTokens < constraints.minimumMaxTokens)
		reasons.push(`max output ${candidate.maxTokens} is below ${constraints.minimumMaxTokens}`);
	if (constraints.requireReasoning && !candidate.reasoning) reasons.push("reasoning support is required");
	if (constraints.requireSpawnResolvable && candidate.spawnResolvable !== true)
		reasons.push(candidate.spawnResolvable === "unknown" ? "child-process resolvability is unknown" : "model is not resolvable by a fresh child process");
	if (constraints.excludedModels?.some((entry) => normalize(entry) === normalize(modelSpec(candidate)) || normalize(entry) === normalize(candidate.id)))
		reasons.push("model is explicitly excluded");
	return reasons;
}

function diversityRank(model: ModelCandidate, preferences: SelectionPreferences): number {
	let rank = 0;
	if (preferences.preferDifferentFamilyFrom && model.family && normalize(model.family) !== normalize(preferences.preferDifferentFamilyFrom)) rank += 2;
	if (preferences.preferDifferentVendorFrom && model.vendor && normalize(model.vendor) !== normalize(preferences.preferDifferentVendorFrom)) rank += 1;
	return rank;
}

function chooseThinking(model: ModelCandidate, policy: ResolvedOptimizationPolicy, override?: ThinkingLevel): ThinkingLevel | undefined {
	if (override) return model.variants.some((variant) => variant.thinkingLevel === override) ? override : undefined;
	const target = THINKING_LEVELS.indexOf(POLICY_THINKING_TARGET[policy]);
	const variants = [...model.variants].sort((left, right) => {
		const leftIndex = THINKING_LEVELS.indexOf(left.thinkingLevel);
		const rightIndex = THINKING_LEVELS.indexOf(right.thinkingLevel);
		const distance = Math.abs(leftIndex - target) - Math.abs(rightIndex - target);
		return distance !== 0 ? distance : leftIndex - rightIndex;
	});
	return variants[0]?.thinkingLevel;
}

function compareModels(left: ModelCandidate, right: ModelCandidate, policy: ResolvedOptimizationPolicy, preferences: SelectionPreferences): number {
	const diversity = diversityRank(right, preferences) - diversityRank(left, preferences);
	if (diversity !== 0) return diversity;
	if (policyDimensions(policy).includes("cost")) {
		if (left.cost !== undefined && right.cost === undefined) return -1;
		if (left.cost === undefined && right.cost !== undefined) return 1;
		if (left.cost !== undefined && right.cost !== undefined && left.cost !== right.cost) return left.cost - right.cost;
	}
	const leftSpec = modelSpec(left);
	const rightSpec = modelSpec(right);
	return leftSpec < rightSpec ? -1 : leftSpec > rightSpec ? 1 : 0;
}

function emptyDecision(requestedPolicy: OptimizationPolicy, resolvedPolicy: ResolvedOptimizationPolicy, rejected: RejectedCandidate[], error: string): SelectionDecision {
	return { requestedPolicy, resolvedPolicy, alternatives: [], reasons: [], caveats: [], rejected, error };
}

export function selectModel(candidates: readonly ModelCandidate[], request: SelectionRequest = {}): SelectionDecision {
	validateCandidates(candidates);
	const { requested, resolved } = resolveOptimizationPolicy(request.policy, request.role);
	const constraints = request.constraints ?? {};
	const preferences = request.preferences ?? {};
	const rejected: RejectedCandidate[] = [];
	let eligible = candidates.filter((candidate) => {
		const reasons = rejectionReasons(candidate, constraints);
		if (reasons.length) rejected.push({ model: candidate, reasons });
		return reasons.length === 0;
	});
	const reasons = [requested === "auto" ? `Policy auto resolved to ${resolved} for role ${request.role ?? "generic"}` : `Using explicit ${resolved} policy`];

	if (request.modelOverride) {
		const resolution = resolveModelSpec(candidates, request.modelOverride);
		if (resolution.status === "not-found") return emptyDecision(requested, resolved, rejected, `Requested model "${request.modelOverride}" was not found`);
		if (resolution.status === "ambiguous")
			return emptyDecision(requested, resolved, rejected, `Requested model "${request.modelOverride}" is ambiguous: ${resolution.matches.map(modelSpec).sort().join(", ")}`);
		const selected = eligible.find((candidate) => normalize(modelSpec(candidate)) === normalize(modelSpec(resolution.model)));
		if (!selected) {
			const rejection = rejected.find((entry) => normalize(modelSpec(entry.model)) === normalize(modelSpec(resolution.model)));
			return emptyDecision(requested, resolved, rejected, `Requested model "${modelSpec(resolution.model)}" is ineligible${rejection ? `: ${rejection.reasons.join("; ")}` : ""}`);
		}
		eligible = [selected];
		reasons.push(`Exact model override selected ${modelSpec(selected)}`);
	}
	if (!eligible.length) return emptyDecision(requested, resolved, rejected, "No eligible models are available");

	// Integrations pin non-cost policies. Direct unpinned core calls use stable
	// modelSpec ordering rather than inventing a quality or latency comparison.
	const sortedModels = [...eligible].sort((left, right) => compareModels(left, right, resolved, preferences));
	const ranked = sortedModels.flatMap((model): RankedCandidate[] => {
		const thinkingLevel = chooseThinking(model, resolved, request.thinkingLevelOverride);
		return thinkingLevel ? [{ model, thinkingLevel, diversityRank: diversityRank(model, preferences), cost: model.cost }] : [];
	});
	if (!ranked.length)
		return emptyDecision(
			requested,
			resolved,
			rejected,
			request.thinkingLevelOverride
				? `No eligible model supports thinking level ${request.thinkingLevelOverride}`
				: "No eligible model/thinking variants are available",
		);

	const selected = ranked[0];
	reasons.push(`Selected ${modelSpec(selected.model)} at thinking level ${selected.thinkingLevel}`);
	if (selected.diversityRank > 0) reasons.push("Applied categorical model-family/vendor diversity preference");
	if (policyDimensions(resolved).includes("cost"))
		reasons.push(
			selected.cost === undefined
				? "Cost is unknown; used deterministic fallback ordering"
				: `Selected lowest known input + output reference rate (${selected.cost} USD/Mtok)`,
		);
	else reasons.push("Quality/speed policy controls thinking only; model choice remains pinned by the caller/integration");
	const caveats: string[] = [];
	if (policyDimensions(resolved).includes("cost") && selected.cost === undefined) caveats.push("Selected model has no known cost");
	if (selected.model.spawnResolvable === "unknown") caveats.push("Child-process resolvability is unknown");

	const maxAlternativesInput = request.maxAlternatives ?? 3;
	const maxAlternatives = Number.isFinite(maxAlternativesInput) ? Math.max(0, Math.floor(maxAlternativesInput)) : 3;
	return {
		requestedPolicy: requested,
		resolvedPolicy: resolved,
		selected,
		alternatives: ranked.slice(1, maxAlternatives + 1),
		reasons,
		caveats,
		rejected,
	};
}
