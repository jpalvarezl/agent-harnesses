/**
 * Pure predicates and diagnostics over subagent result state.
 *
 * exitCode sentinels: -2 = queued, -1 = running, >= 0 = finished process exit code.
 */

/** Minimal structural view of a result used by these helpers. */
export interface ResultState {
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	stderr: string;
}

export function isFailedResult(r: ResultState): boolean {
	return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
}

/** A subagent whose process has not yet closed (exitCode sentinel -1). */
export function isRunningResult(r: ResultState): boolean {
	return r.exitCode === -1;
}

/** A parallel task still waiting for a concurrency slot (exitCode sentinel -2). */
export function isQueuedResult(r: ResultState): boolean {
	return r.exitCode === -2;
}

/** Not yet finished: queued or running. */
export function isPendingResult(r: ResultState): boolean {
	return r.exitCode < 0;
}

export const DIAGNOSTIC_CAP = 2000;

function capTail(s: string): string {
	return s.length > DIAGNOSTIC_CAP ? `…${s.slice(-DIAGNOSTIC_CAP)}` : s;
}

/**
 * Combined failure diagnostic for a finished, failed result (tail-capped).
 * Includes both `errorMessage` and `stderr` when they differ. Returns "" for
 * pending or successful results. Rendered after the transcript so a subprocess
 * that emits partial output and then fails still surfaces the error.
 */
export function failureDetail(r: ResultState): string {
	if (isPendingResult(r) || !isFailedResult(r)) return "";
	const err = r.errorMessage?.trim() ?? "";
	const se = r.stderr.trim();
	const parts: string[] = [];
	// Cap each part independently so a very long stderr can never drop the model
	// errorMessage. Combined worst case is ~2x DIAGNOSTIC_CAP, still bounded.
	if (err) parts.push(capTail(err));
	if (se && se !== err) parts.push(capTail(se));
	return parts.join("\n");
}

/**
 * Merge partial transcript output with a failure diagnostic for the parent model.
 * On failure, preserve any partial output AND append the diagnostic so useful work
 * is not lost when a subagent fails after producing output.
 */
export function combineOutputAndDiagnostic(output: string, r: ResultState): string {
	const trimmed = output.trim();
	if (!isFailedResult(r)) return trimmed || "(no output)";
	const diag = failureDetail(r);
	if (trimmed && diag) return `${trimmed}\n\n[error] ${diag}`;
	return trimmed || diag || "(no output)";
}
