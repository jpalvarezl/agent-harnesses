/**
 * Model selection for subagents.
 *
 * Effective model = first AVAILABLE candidate in precedence order:
 *   per-task/tool model > session pin (/subagent-model) > agent frontmatter > inherited session model.
 * Invalid candidates are skipped (never fatal) and reported via `note`.
 */

import { resolveModelSpec, type ModelResolution } from "../../model-chooser/index.ts";

export interface ModelRef {
	id: string;
	provider: string;
	name?: string;
}

export interface ModelSelectContext {
	available: ModelRef[];
	current?: ModelRef;
	/** Session-scoped default set via /subagent-model. */
	sessionPin?: string;
}

export function modelSpec(m: ModelRef): string {
	return `${m.provider}/${m.id}`;
}

/** Resolve a canonical provider/id or an unambiguous bare id. */
export function resolveAvailableModel(available: ModelRef[], spec: string): ModelResolution<ModelRef> {
	return resolveModelSpec(available, spec);
}

export function findAvailableModel(available: ModelRef[], spec: string): ModelRef | undefined {
	const resolution = resolveAvailableModel(available, spec);
	return resolution.status === "found" ? resolution.model : undefined;
}

function ambiguousModelError(spec: string, matches: ModelRef[]): string {
	return `Model "${spec}" is ambiguous; use a canonical provider/id: ${matches.map(modelSpec).sort().join(", ")}`;
}

export interface ResolvedModel {
	/** provider/id to pass to --model, or undefined to inherit the child CLI default. */
	spec: string | undefined;
	source: string;
	note?: string;
	/** Hard resolution failure. Callers must not dispatch when set. */
	error?: string;
}

export function resolveEffectiveModel(opts: {
	taskModel?: string;
	sessionPin?: string;
	agentModel?: string;
	current?: ModelRef;
	available: ModelRef[];
}): ResolvedModel {
	const candidates: Array<{ value?: string; source: string }> = [
		{ value: opts.taskModel, source: "task" },
		{ value: opts.sessionPin, source: "session pin" },
		{ value: opts.agentModel, source: "agent frontmatter" },
		{ value: opts.current ? modelSpec(opts.current) : undefined, source: "inherited session" },
	];
	const skipped: string[] = [];
	for (const c of candidates) {
		if (!c.value) continue;
		const resolution = resolveAvailableModel(opts.available, c.value);
		if (resolution.status === "ambiguous") {
			return {
				spec: undefined,
				source: c.source,
				error: ambiguousModelError(c.value, resolution.matches),
			};
		}
		if (resolution.status === "found") {
			const note = skipped.length
				? `model: ${modelSpec(resolution.model)} (${c.source}); skipped unavailable: ${skipped.join(", ")}`
				: undefined;
			return { spec: modelSpec(resolution.model), source: c.source, note };
		}
		skipped.push(c.value);
	}
	return {
		spec: undefined,
		source: "cli default",
		note: skipped.length ? `model: requested ${skipped.join(", ")} unavailable; using child CLI default` : undefined,
	};
}
