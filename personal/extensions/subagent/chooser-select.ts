import {
	modelSpec as chooserModelSpec,
	policyDimensions,
	resolveModelSpec,
	resolveOptimizationPolicy,
	selectModel,
	type ChooserRole,
	type ModelCandidate,
	type OptimizationPolicy,
	type SelectionDecision,
	type ThinkingLevel,
} from "../../model-chooser/index.ts";
import {
	resolveEffectiveModel,
	type ModelRef,
	type ResolvedModel,
} from "./model-select.ts";

export interface ChooserResolvedModel extends ResolvedModel {
	thinkingLevel?: ThinkingLevel;
	error?: string;
	requestedPolicy?: OptimizationPolicy;
	resolvedPolicy?: string;
	decision?: SelectionDecision;
}

export function agentRole(agentName: string): ChooserRole {
	switch (agentName.toLowerCase()) {
		case "scout":
		case "planner":
		case "worker":
		case "reviewer":
			return agentName.toLowerCase() as ChooserRole;
		default:
			return "generic";
	}
}

function joinNotes(...notes: Array<string | undefined>): string | undefined {
	const present = notes.filter((note): note is string => Boolean(note));
	return present.length > 0 ? present.join("; ") : undefined;
}

/**
 * Preserve the existing explicit/session/frontmatter precedence, then apply an
 * opt-in policy to the inherited/default choice and its thinking level.
 */
export function resolveChooserModel(opts: {
	taskModel?: string;
	sessionPin?: string;
	agentModel?: string;
	current?: ModelRef;
	available: ModelRef[];
	candidates: ModelCandidate[];
	agentName: string;
	policy?: OptimizationPolicy;
	thinkingLevel?: ThinkingLevel;
}): ChooserResolvedModel {
	const legacy = resolveEffectiveModel({
		taskModel: opts.taskModel,
		sessionPin: opts.sessionPin,
		agentModel: opts.agentModel,
		current: opts.current,
		available: opts.available,
	});

	if (opts.policy === undefined && opts.thinkingLevel === undefined) return legacy;

	const role = agentRole(opts.agentName);
	const { requested, resolved } = resolveOptimizationPolicy(opts.policy, role);
	const usesCost = policyDimensions(resolved).includes("cost");
	let modelOverride: string | undefined;

	if (legacy.spec) {
		const preferred = resolveModelSpec(opts.candidates, legacy.spec);
		const isStrongPreference = legacy.source !== "inherited session" && legacy.source !== "cli default";
		// A thinking-only request keeps the inherited model. Once a cost-bearing
		// policy is explicit, thinking constrains the chosen variant without
		// suppressing policy-driven model selection.
		const shouldPin = isStrongPreference || opts.policy === undefined || !usesCost;
		if (shouldPin && preferred.status === "found") modelOverride = chooserModelSpec(preferred.model);
	}

	const decision = selectModel(opts.candidates, {
		policy: requested,
		role,
		modelOverride,
		thinkingLevelOverride: opts.thinkingLevel,
		constraints: { requireSpawnResolvable: true },
	});

	if (!decision.selected) {
		const error = decision.error ?? "No eligible child model is available";
		return {
			spec: undefined,
			source: "chooser",
			error,
			note: joinNotes(legacy.note, `chooser: ${error}`),
			requestedPolicy: requested,
			resolvedPolicy: resolved,
			decision,
		};
	}

	const selectedSpec = chooserModelSpec(decision.selected.model);
	return {
		spec: selectedSpec,
		source: modelOverride ? legacy.source : `policy ${resolved}`,
		thinkingLevel: decision.selected.thinkingLevel,
		requestedPolicy: requested,
		resolvedPolicy: resolved,
		decision,
		note: joinNotes(
			legacy.note,
			`chooser: ${requested}${requested === "auto" ? `→${resolved}` : ""}, ${selectedSpec}:${decision.selected.thinkingLevel}`,
			decision.caveats.length > 0 ? decision.caveats.join(", ") : undefined,
		),
	};
}
