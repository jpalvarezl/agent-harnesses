/**
 * Pure decision policy for git-worktree isolation.
 *
 * These functions contain NO git/side effects — they only map facts to
 * decisions, so the merge/cleanup policy is declarative, self-documenting, and
 * trivially testable as truth tables. The imperative orchestrator gathers the
 * facts (run agent, merge, build) and applies the decisions.
 */

export type IsolationOutcome =
	| "merged" // branch merged cleanly (and any build check passed)
	| "no-changes" // agent produced nothing to commit
	| "conflict" // merge hit conflicts; aborted and preserved
	| "build-failed" // clean merge, but the build check failed; rolled back and preserved
	| "merge-error" // merge failed for a non-conflict reason
	| "agent-failed" // the subagent process itself failed
	| "commit-failed" // committing the worktree failed (work preserved, never discarded)
	| "aborted"; // user canceled before/while integrating this task

export type CleanupPolicy = "on-success" | "never" | "always";

/** An outcome that leaves nothing to recover, so its worktree is safe to remove by default. */
export function isSuccessOutcome(outcome: IsolationOutcome): boolean {
	return outcome === "merged" || outcome === "no-changes";
}

/**
 * Whether a task's worktree/branch should be removed, given the cleanup policy.
 *
 *   policy       | success | failure
 *   -------------|---------|--------
 *   on-success   | remove  | keep
 *   never        | keep    | keep
 *   always       | remove  | remove
 */
export function shouldRemoveWorktree(outcome: IsolationOutcome, cleanup: CleanupPolicy): boolean {
	if (cleanup === "never") return false;
	if (cleanup === "always") return true;
	return isSuccessOutcome(outcome); // on-success
}

/**
 * Classify a task BEFORE attempting its merge. Returns a terminal outcome, or
 * "proceed" meaning the branch has committed changes ready to merge.
 *
 * Precedence is load-bearing: a failed commit MUST outrank "no-changes" so that
 * an agent's work is preserved (commit-failed) rather than treated as empty and
 * cleaned up (data loss).
 */
export function classifyBeforeMerge(facts: {
	aborted: boolean;
	agentFailed: boolean;
	commitFailed: boolean;
	committed: boolean;
}): IsolationOutcome | "proceed" {
	if (facts.aborted) return "aborted";
	if (facts.agentFailed) return "agent-failed";
	if (facts.commitFailed) return "commit-failed";
	if (!facts.committed) return "no-changes";
	return "proceed";
}

/**
 * Classify the result of merging + an optional build check. Pure mapping only;
 * the caller is responsible for the corresponding side effects (abort/build
 * rollbacks) before applying this outcome.
 *
 *   mergeStatus | abortedAfterMerge | build                        | outcome
 *   ------------|-------------------|------------------------------|-------------
 *   conflict    | -                 | -                            | conflict
 *   error       | -                 | -                            | merge-error
 *   clean       | true              | -                            | aborted
 *   clean       | false             | undefined                    | merged
 *   clean       | false             | { success:true,  aborted:* } | merged
 *   clean       | false             | { success:false, aborted:F } | build-failed
 *   clean       | false             | { success:false, aborted:T } | aborted
 *
 * Note: a successful build is "merged" regardless of `aborted` (a cancel that
 * lands just as a passing build finishes keeps the good merge), matching the
 * imperative behavior where `aborted` was only consulted when the build failed.
 */
export function classifyAfterMerge(facts: {
	mergeStatus: "clean" | "conflict" | "error";
	abortedAfterMerge: boolean;
	build?: { success: boolean; aborted: boolean };
}): IsolationOutcome {
	if (facts.mergeStatus === "conflict") return "conflict";
	if (facts.mergeStatus === "error") return "merge-error";
	if (facts.abortedAfterMerge) return "aborted";
	if (facts.build && !facts.build.success) {
		return facts.build.aborted ? "aborted" : "build-failed";
	}
	return "merged";
}
