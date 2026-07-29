import {
	modelSpec,
	policyDimensions,
	resolveModelSpec,
	resolveOptimizationPolicy,
	selectModel,
	type ModelCandidate,
	type OptimizationPolicy,
	type SelectionDecision,
	type ThinkingLevel,
} from "../../model-chooser/index.ts";
import { inferModelFamilyVendor } from "../../model-chooser/pi-adapter.ts";
import {
	getModelFamily,
	selectPeerModelWithFallback,
	type ModelReference,
	type PeerModelSelection,
} from "./model-selection.ts";

export type PeerRole = "rubber-duck" | "code-review";

export interface PeerChooserResult {
	selection?: PeerModelSelection;
	thinkingLevel?: ThinkingLevel;
	decision?: SelectionDecision;
	error?: string;
}

/** Select a peer while preserving the legacy path when no chooser field is supplied. */
export function resolvePeerChoice(opts: {
	role: PeerRole;
	current?: ModelReference;
	available: ModelReference[];
	candidates: ModelCandidate[];
	model?: string;
	policy?: OptimizationPolicy;
	thinkingLevel?: ThinkingLevel;
}): PeerChooserResult {
	const chooserEnabled = opts.model !== undefined || opts.policy !== undefined || opts.thinkingLevel !== undefined;
	if (!chooserEnabled) {
		const selection = selectPeerModelWithFallback(opts.current, opts.available);
		return selection ? { selection } : { error: "No authenticated peer model is available" };
	}

	const legacy = selectPeerModelWithFallback(opts.current, opts.available);
	const { requested, resolved } = resolveOptimizationPolicy(opts.policy, opts.role);
	const usesCost = policyDimensions(resolved).includes("cost");
	let modelOverride = opts.model;
	if (!modelOverride && !usesCost && legacy) {
		const childSafe = resolveModelSpec(opts.candidates, modelSpec(legacy.model));
		if (childSafe.status === "found") modelOverride = modelSpec(childSafe.model);
	}

	const currentIdentity = opts.current
		? resolveModelSpec(opts.candidates, modelSpec(opts.current))
		: undefined;
	const inferredCurrent = opts.current ? inferModelFamilyVendor(opts.current) : undefined;
	const currentFamily =
		currentIdentity?.status === "found" ? currentIdentity.model.family : inferredCurrent?.family;
	const currentVendor =
		currentIdentity?.status === "found" ? currentIdentity.model.vendor : inferredCurrent?.vendor;

	const decision = selectModel(opts.candidates, {
		policy: requested,
		role: opts.role,
		modelOverride,
		thinkingLevelOverride: opts.thinkingLevel,
		constraints: {
			requireSpawnResolvable: true,
			excludedModels: opts.current ? [modelSpec(opts.current)] : undefined,
		},
		preferences: {
			preferDifferentFamilyFrom: currentFamily,
			preferDifferentVendorFrom: currentVendor,
		},
	});
	if (!decision.selected) return { decision, error: decision.error ?? "No eligible peer model is available" };

	const model: ModelReference = {
		provider: decision.selected.model.provider,
		id: decision.selected.model.id,
		name: decision.selected.model.name,
	};
	const selectedFamily = decision.selected.model.family;
	const crossFamily = opts.current
		? selectedFamily && currentFamily
			? selectedFamily.toLowerCase() !== currentFamily.toLowerCase()
			: getModelFamily(model) !== getModelFamily(opts.current)
		: decision.selected.diversityRank > 0;
	return {
		selection: { model, crossFamily },
		thinkingLevel: decision.selected.thinkingLevel,
		decision,
	};
}
