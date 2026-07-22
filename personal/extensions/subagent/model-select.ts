/**
 * Model selection for subagents.
 *
 * Effective model = first AVAILABLE candidate in precedence order:
 *   per-task/tool model > session pin (/subagent-model) > agent frontmatter > inherited session model.
 * Invalid candidates are skipped (never fatal) and reported via `note`.
 */

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

/** Resolve a "provider/id" or bare "id" spec against the authenticated models. */
export function findAvailableModel(available: ModelRef[], spec: string): ModelRef | undefined {
	const slash = spec.indexOf("/");
	if (slash > 0) {
		const provider = spec.slice(0, slash);
		const id = spec.slice(slash + 1);
		const exact = available.find((m) => m.provider === provider && m.id === id);
		if (exact) return exact;
	}
	return available.find((m) => m.id === spec);
}

export interface ResolvedModel {
	/** provider/id to pass to --model, or undefined to inherit the child CLI default. */
	spec: string | undefined;
	source: string;
	note?: string;
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
		const found = findAvailableModel(opts.available, c.value);
		if (found) {
			const note = skipped.length
				? `model: ${modelSpec(found)} (${c.source}); skipped unavailable: ${skipped.join(", ")}`
				: undefined;
			return { spec: modelSpec(found), source: c.source, note };
		}
		skipped.push(c.value);
	}
	return {
		spec: undefined,
		source: "cli default",
		note: skipped.length ? `model: requested ${skipped.join(", ")} unavailable; using child CLI default` : undefined,
	};
}
