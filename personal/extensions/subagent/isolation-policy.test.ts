import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyAfterMerge,
	classifyBeforeMerge,
	type IsolationOutcome,
	isSuccessOutcome,
	shouldRemoveWorktree,
} from "./isolation-policy.ts";

test("isSuccessOutcome: only merged/no-changes are successes", () => {
	assert.equal(isSuccessOutcome("merged"), true);
	assert.equal(isSuccessOutcome("no-changes"), true);
	for (const o of ["conflict", "build-failed", "merge-error", "agent-failed", "commit-failed", "aborted"] as const) {
		assert.equal(isSuccessOutcome(o), false, o);
	}
});

test("shouldRemoveWorktree truth table", () => {
	// on-success: remove successes, keep failures
	assert.equal(shouldRemoveWorktree("merged", "on-success"), true);
	assert.equal(shouldRemoveWorktree("no-changes", "on-success"), true);
	assert.equal(shouldRemoveWorktree("conflict", "on-success"), false);
	assert.equal(shouldRemoveWorktree("commit-failed", "on-success"), false);
	// never: keep everything
	assert.equal(shouldRemoveWorktree("merged", "never"), false);
	assert.equal(shouldRemoveWorktree("conflict", "never"), false);
});

test("classifyBeforeMerge precedence: aborted > agent-failed > commit-failed > no-changes > proceed", () => {
	assert.equal(
		classifyBeforeMerge({ aborted: true, agentFailed: true, commitFailed: true, committed: false }),
		"aborted",
	);
	assert.equal(
		classifyBeforeMerge({ aborted: false, agentFailed: true, commitFailed: true, committed: false }),
		"agent-failed",
	);
	assert.equal(
		classifyBeforeMerge({ aborted: false, agentFailed: false, commitFailed: true, committed: false }),
		"commit-failed",
	);
	assert.equal(
		classifyBeforeMerge({ aborted: false, agentFailed: false, commitFailed: false, committed: false }),
		"no-changes",
	);
	assert.equal(
		classifyBeforeMerge({ aborted: false, agentFailed: false, commitFailed: false, committed: true }),
		"proceed",
	);
});

test("classifyBeforeMerge: commit failure never masquerades as no-changes (data-loss guard)", () => {
	// committed=false but the reason is a commit error -> must be commit-failed, not no-changes.
	assert.equal(
		classifyBeforeMerge({ aborted: false, agentFailed: false, commitFailed: true, committed: false }),
		"commit-failed",
	);
});

test("classifyAfterMerge truth table", () => {
	const clean = (over: Partial<Parameters<typeof classifyAfterMerge>[0]> = {}) =>
		classifyAfterMerge({ mergeStatus: "clean", abortedAfterMerge: false, ...over });

	assert.equal(classifyAfterMerge({ mergeStatus: "conflict", abortedAfterMerge: false }), "conflict");
	assert.equal(classifyAfterMerge({ mergeStatus: "error", abortedAfterMerge: false }), "merge-error");
	assert.equal(clean({ abortedAfterMerge: true }), "aborted");
	assert.equal(clean(), "merged"); // no build check
	assert.equal(clean({ build: { success: true, aborted: false } }), "merged");
	assert.equal(clean({ build: { success: false, aborted: false } }), "build-failed");
	assert.equal(clean({ build: { success: false, aborted: true } }), "aborted");
	// Race: cancel lands as a passing build finishes -> keep the good merge.
	assert.equal(clean({ build: { success: true, aborted: true } }), "merged");
});

test("every outcome has a defined success classification", () => {
	const all: IsolationOutcome[] = [
		"merged",
		"no-changes",
		"conflict",
		"build-failed",
		"merge-error",
		"agent-failed",
		"commit-failed",
		"aborted",
	];
	for (const o of all) assert.equal(typeof isSuccessOutcome(o), "boolean", o);
});
