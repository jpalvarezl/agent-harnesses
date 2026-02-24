/**
 * Git worktree management for parallel agent dispatch.
 *
 * Creates isolated worktrees on separate branches so multiple agents
 * can edit files without conflicts.
 */

import { exec as execCb } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

const WORKTREE_DIR = ".pi/worktrees";

export interface WorktreeInfo {
	todoId: string;
	branch: string;
	worktreePath: string;
	baseBranch: string;
}

function run(cmd: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		execCb(cmd, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
			resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "", code: error?.code ?? 0 });
		});
	});
}

/** Get current git branch name */
export async function getCurrentBranch(cwd: string): Promise<string> {
	const { stdout } = await run("git rev-parse --abbrev-ref HEAD", cwd);
	return stdout.trim() || "main";
}

/** Get the git root directory */
export async function getGitRoot(cwd: string): Promise<string> {
	const { stdout } = await run("git rev-parse --show-toplevel", cwd);
	return stdout.trim();
}

/** Check if there are uncommitted changes */
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
	const { stdout } = await run("git status --porcelain", cwd);
	return stdout.trim().length > 0;
}

/** Create a worktree for a todo on a new branch */
export async function createWorktree(cwd: string, todoId: string): Promise<WorktreeInfo> {
	const gitRoot = await getGitRoot(cwd);
	const baseBranch = await getCurrentBranch(cwd);
	const branch = `agent/${todoId}`;
	const worktreePath = path.join(gitRoot, WORKTREE_DIR, todoId);

	// Ensure parent directory exists
	fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

	// Remove existing worktree if it exists (stale from previous run)
	if (fs.existsSync(worktreePath)) {
		await run(`git worktree remove --force "${worktreePath}"`, gitRoot);
	}

	// Delete branch if it already exists (stale)
	await run(`git branch -D "${branch}" 2>/dev/null`, gitRoot);

	// Create worktree with new branch from current HEAD
	const result = await run(`git worktree add -b "${branch}" "${worktreePath}" HEAD`, gitRoot);
	if (result.code !== 0 && !result.stderr.includes("already exists")) {
		throw new Error(`Failed to create worktree: ${result.stderr}`);
	}

	return { todoId, branch, worktreePath, baseBranch };
}

/** Commit all changes in a worktree */
export async function commitWorktree(worktree: WorktreeInfo, message: string): Promise<boolean> {
	await run("git add -A", worktree.worktreePath);
	const status = await run("git status --porcelain", worktree.worktreePath);
	if (!status.stdout.trim()) {
		return false; // Nothing to commit
	}
	const result = await run(`git commit -m "${message.replace(/"/g, '\\"')}"`, worktree.worktreePath);
	return result.code === 0;
}

/** Get the diff of a branch relative to its base */
export async function getBranchDiff(cwd: string, branch: string, baseBranch: string): Promise<string> {
	const { stdout } = await run(`git diff "${baseBranch}...${branch}"`, cwd);
	return stdout;
}

/** Get the diff for a specific file between two branches */
export async function getFileDiff(cwd: string, branch: string, baseBranch: string, filePath: string): Promise<string> {
	const { stdout } = await run(`git diff "${baseBranch}...${branch}" -- "${filePath}"`, cwd);
	return stdout;
}

/** Get list of files changed on a branch relative to base */
export async function getChangedFiles(cwd: string, branch: string, baseBranch: string): Promise<string[]> {
	const { stdout } = await run(`git diff --name-only "${baseBranch}...${branch}"`, cwd);
	return stdout.trim().split("\n").filter(Boolean);
}

/** Get file content from a specific branch */
export async function getFileFromBranch(cwd: string, branch: string, filePath: string): Promise<string | null> {
	const result = await run(`git show "${branch}:${filePath}"`, cwd);
	if (result.code !== 0) return null;
	return result.stdout;
}

export interface MergeResult {
	success: boolean;
	conflictFiles: string[];
	mergedFiles: string[];
	error?: string;
}

/** Attempt to merge a branch into the current branch */
export async function mergeBranch(cwd: string, branch: string): Promise<MergeResult> {
	const result = await run(`git merge --no-ff "${branch}" -m "Merge ${branch}"`, cwd);

	if (result.code === 0) {
		const changed = await run(`git diff --name-only HEAD~1`, cwd);
		return {
			success: true,
			conflictFiles: [],
			mergedFiles: changed.stdout.trim().split("\n").filter(Boolean),
		};
	}

	// Merge conflict
	const conflictResult = await run("git diff --name-only --diff-filter=U", cwd);
	const conflictFiles = conflictResult.stdout.trim().split("\n").filter(Boolean);

	if (conflictFiles.length > 0) {
		return {
			success: false,
			conflictFiles,
			mergedFiles: [],
			error: "Merge conflict",
		};
	}

	// Some other merge failure — abort
	await run("git merge --abort", cwd);
	return {
		success: false,
		conflictFiles: [],
		mergedFiles: [],
		error: result.stderr || "Merge failed",
	};
}

/** Get the conflict markers content for a file */
export async function getConflictContent(cwd: string, filePath: string): Promise<string> {
	const fullPath = path.join(cwd, filePath);
	return fs.readFileSync(fullPath, "utf8");
}

/** Write resolved file and stage it */
export async function resolveConflict(cwd: string, filePath: string, resolvedContent: string): Promise<void> {
	const fullPath = path.join(cwd, filePath);
	fs.writeFileSync(fullPath, resolvedContent, "utf8");
	await run(`git add "${filePath}"`, cwd);
}

/** Complete a merge after resolving all conflicts */
export async function completeMerge(cwd: string, message: string): Promise<boolean> {
	const result = await run(`git commit -m "${message.replace(/"/g, '\\"')}"`, cwd);
	return result.code === 0;
}

/** Abort an in-progress merge */
export async function abortMerge(cwd: string): Promise<void> {
	await run("git merge --abort", cwd);
}

/** Remove a worktree and its branch */
export async function cleanupWorktree(cwd: string, worktree: WorktreeInfo): Promise<void> {
	const gitRoot = await getGitRoot(cwd);
	await run(`git worktree remove --force "${worktree.worktreePath}"`, gitRoot);
	await run(`git branch -D "${worktree.branch}"`, gitRoot);
}

/** Remove all dispatch worktrees */
export async function cleanupAllWorktrees(cwd: string): Promise<string[]> {
	const gitRoot = await getGitRoot(cwd);
	const worktreeDir = path.join(gitRoot, WORKTREE_DIR);
	const cleaned: string[] = [];

	if (!fs.existsSync(worktreeDir)) return cleaned;

	const entries = fs.readdirSync(worktreeDir);
	for (const entry of entries) {
		const fullPath = path.join(worktreeDir, entry);
		if (fs.statSync(fullPath).isDirectory()) {
			await run(`git worktree remove --force "${fullPath}"`, gitRoot);
			const branch = `agent/${entry}`;
			await run(`git branch -D "${branch}" 2>/dev/null`, gitRoot);
			cleaned.push(entry);
		}
	}

	// Clean up empty directory
	try {
		fs.rmdirSync(worktreeDir);
		fs.rmdirSync(path.join(gitRoot, ".pi/worktrees"));
	} catch {
		// ignore
	}

	// Prune stale worktree refs
	await run("git worktree prune", gitRoot);

	return cleaned;
}

/** List active worktrees */
export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
	const gitRoot = await getGitRoot(cwd);
	const worktreeDir = path.join(gitRoot, WORKTREE_DIR);
	const worktrees: WorktreeInfo[] = [];

	if (!fs.existsSync(worktreeDir)) return worktrees;

	const baseBranch = await getCurrentBranch(cwd);
	const entries = fs.readdirSync(worktreeDir);
	for (const entry of entries) {
		const fullPath = path.join(worktreeDir, entry);
		if (fs.statSync(fullPath).isDirectory()) {
			worktrees.push({
				todoId: entry,
				branch: `agent/${entry}`,
				worktreePath: fullPath,
				baseBranch,
			});
		}
	}

	return worktrees;
}

/** Check if a build command succeeds */
export async function runBuildCheck(cwd: string, buildCommand: string): Promise<{ success: boolean; output: string }> {
	const result = await run(buildCommand, cwd);
	return {
		success: result.code === 0,
		output: result.stdout + result.stderr,
	};
}
