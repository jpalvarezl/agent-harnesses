/**
 * Git worktree isolation for parallel subagents.
 *
 * Each parallel task runs in its own worktree on its own branch, so concurrent
 * write-capable agents cannot race on the same files. After the agents finish,
 * the harness (not the LLM) commits each worktree and merges the branches back
 * into the parent checkout using a clean-merge-only policy.
 *
 * All git invocations use execFile with an argv array (no shell) so branch
 * names, paths, and commit messages cannot cause shell injection or quoting bugs.
 */

import { exec as execCb, execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface GitResult {
	stdout: string;
	stderr: string;
	code: number;
}

const MAX_BUFFER = 32 * 1024 * 1024;

/** Run a git command with argv (no shell). Never throws on non-zero exit. */
export function runGit(args: string[], cwd: string): Promise<GitResult> {
	return new Promise((resolve) => {
		execFileCb("git", args, { cwd, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
			const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
			resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "", code });
		});
	});
}

/**
 * Sanitize a string into a safe single git ref path component.
 * Keeps [A-Za-z0-9._-], replaces the rest with "-", collapses repeats, and
 * trims leading/trailing separators. Returns "x" if nothing usable remains.
 */
export function sanitizeRefComponent(input: string): string {
	const cleaned = input
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/\.+/g, ".")
		.replace(/^[-.]+|[-.]+$/g, "");
	// Guard against git-invalid sequences and suffixes.
	let safe = cleaned.replace(/\.\./g, ".").replace(/@\{/g, "at-").replace(/\.lock$/i, "-lock");
	if (safe === "@" || safe.length === 0) safe = "x";
	return safe.slice(0, 60);
}

export interface WorktreeInfo {
	index: number;
	agent: string;
	branch: string;
	worktreePath: string;
}

export async function getGitRoot(cwd: string): Promise<string | null> {
	const { stdout, code } = await runGit(["rev-parse", "--show-toplevel"], cwd);
	if (code !== 0) return null;
	const root = stdout.trim();
	return root || null;
}

export async function isWorkingTreeClean(cwd: string): Promise<boolean> {
	const { stdout, code } = await runGit(["status", "--porcelain"], cwd);
	if (code !== 0) return false;
	return stdout.trim().length === 0;
}

export async function getHeadSha(cwd: string): Promise<string> {
	const { stdout } = await runGit(["rev-parse", "HEAD"], cwd);
	return stdout.trim();
}

/** Create a worktree on a new branch off HEAD, clearing any stale path/branch first. */
export async function createWorktree(
	gitRoot: string,
	info: { index: number; agent: string; branch: string; worktreePath: string },
): Promise<WorktreeInfo> {
	fs.mkdirSync(path.dirname(info.worktreePath), { recursive: true });

	if (fs.existsSync(info.worktreePath)) {
		await runGit(["worktree", "remove", "--force", info.worktreePath], gitRoot);
	}
	await runGit(["branch", "-D", info.branch], gitRoot); // ignore result if absent

	const result = await runGit(["worktree", "add", "-b", info.branch, info.worktreePath, "HEAD"], gitRoot);
	if (result.code !== 0) {
		throw new Error(`Failed to create worktree for ${info.agent}: ${result.stderr.trim() || "git worktree add failed"}`);
	}
	return { index: info.index, agent: info.agent, branch: info.branch, worktreePath: info.worktreePath };
}

/** Stage and commit everything in a worktree. Returns whether a commit was made. */
export async function commitAll(worktreePath: string, message: string): Promise<{ committed: boolean; error?: string }> {
	const add = await runGit(["add", "-A"], worktreePath);
	if (add.code !== 0) return { committed: false, error: add.stderr.trim() || "git add failed" };

	const status = await runGit(["status", "--porcelain"], worktreePath);
	if (!status.stdout.trim()) return { committed: false };

	const commit = await runGit(["commit", "--no-verify", "-m", message], worktreePath);
	if (commit.code !== 0) return { committed: false, error: commit.stderr.trim() || "git commit failed" };
	return { committed: true };
}

export type MergeStatus = "clean" | "conflict" | "error";

export interface MergeOutcome {
	status: MergeStatus;
	conflictFiles: string[];
	error?: string;
}

/** Merge a branch into the current checkout (no fast-forward). Aborts on conflict. */
export async function mergeBranchNoFF(cwd: string, branch: string): Promise<MergeOutcome> {
	const result = await runGit(["merge", "--no-ff", "--no-edit", branch], cwd);
	if (result.code === 0) return { status: "clean", conflictFiles: [] };

	const conflicts = await runGit(["diff", "--name-only", "--diff-filter=U"], cwd);
	const conflictFiles = conflicts.stdout.trim().split("\n").filter(Boolean);
	// Always abort so the parent checkout is left clean regardless of failure mode.
	await runGit(["merge", "--abort"], cwd);

	if (conflictFiles.length > 0) return { status: "conflict", conflictFiles };
	return { status: "error", conflictFiles: [], error: result.stderr.trim() || "merge failed" };
}

/** Hard-reset the checkout to a known sha. Returns whether git succeeded. */
export async function resetHard(cwd: string, sha: string): Promise<boolean> {
	const r = await runGit(["reset", "--hard", sha], cwd);
	return r.code === 0;
}

/** Remove untracked files/dirs (build artifacts). Returns whether git succeeded. */
export async function gitClean(cwd: string): Promise<boolean> {
	const r = await runGit(["clean", "-fd"], cwd);
	return r.code === 0;
}

/** Run a repo-configured build/check command via the shell. Abortable via signal. */
export function runBuildCheck(
	cwd: string,
	command: string,
	signal?: AbortSignal,
): Promise<{ success: boolean; output: string; aborted: boolean }> {
	return new Promise((resolve) => {
		execCb(command, { cwd, maxBuffer: MAX_BUFFER, signal }, (error, stdout, stderr) => {
			const aborted = Boolean(signal?.aborted) || (error as NodeJS.ErrnoException | null)?.code === "ABORT_ERR";
			resolve({
				success: !error,
				output: `${stdout?.toString() ?? ""}${stderr?.toString() ?? ""}`,
				aborted,
			});
		});
	});
}

export async function removeWorktree(gitRoot: string, worktreePath: string): Promise<boolean> {
	const r = await runGit(["worktree", "remove", "--force", worktreePath], gitRoot);
	return r.code === 0;
}

export async function deleteBranch(gitRoot: string, branch: string): Promise<boolean> {
	const r = await runGit(["branch", "-D", branch], gitRoot);
	return r.code === 0;
}

export async function pruneWorktrees(gitRoot: string): Promise<void> {
	await runGit(["worktree", "prune"], gitRoot);
}

/** A short, filesystem- and ref-safe run identifier. */
export function makeRunId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
