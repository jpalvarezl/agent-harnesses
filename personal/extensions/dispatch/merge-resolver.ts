/**
 * Merge resolver — uses LLM to resolve git merge conflicts with full context.
 *
 * Three layers:
 * 1. Git fast-forward / clean merge (no LLM needed)
 * 2. Conflict resolution with full diff + todo context
 * 3. Semantic verification of clean merges (catch what git misses)
 */

import { spawn, exec as execCb } from "node:child_process";
import * as fs from "node:fs";
import {
	mergeBranch,
	getConflictContent,
	getFileFromBranch,
	getFileDiff,
	getChangedFiles,
	resolveConflict,
	completeMerge,
	abortMerge,
	getCurrentBranch,
	type WorktreeInfo,
} from "./git-worktree.js";

export interface TodoContext {
	todoId: string;
	title: string;
	body: string;
	agentSummary?: string;
}

export interface MergeContext {
	file: string;
	base: string | null;
	versions: {
		todoId: string;
		todoTitle: string;
		todoBody: string;
		branch: string;
		diff: string;
		full: string | null;
		agentSummary?: string;
	}[];
	conflictMarkers?: string;
	previouslyMerged: {
		todoId: string;
		diff: string;
	}[];
	buildErrors?: string;
}

export interface ResolutionResult {
	status: "clean" | "resolved" | "verified" | "failed";
	todoId: string;
	branch: string;
	files: string[];
	conflictFiles?: string[];
	message: string;
	attempts?: number;
}

function buildConflictResolutionPrompt(ctx: MergeContext): string {
	let prompt = `You are resolving a merge conflict in: ${ctx.file}\n\n`;

	for (const ver of ctx.versions) {
		prompt += `## What ${ver.todoId} was doing\n`;
		prompt += `Title: "${ver.todoTitle}"\n`;
		if (ver.todoBody) prompt += `Body: ${ver.todoBody}\n`;
		if (ver.agentSummary) prompt += `Agent notes: ${ver.agentSummary}\n`;
		prompt += `\n## Diff from ${ver.todoId} (${ver.branch} vs base)\n\`\`\`diff\n${ver.diff}\n\`\`\`\n\n`;
	}

	if (ctx.base) {
		prompt += `## Base version (before any changes)\n\`\`\`\n${ctx.base}\n\`\`\`\n\n`;
	}

	if (ctx.conflictMarkers) {
		prompt += `## File with git conflict markers\n\`\`\`\n${ctx.conflictMarkers}\n\`\`\`\n\n`;
	}

	if (ctx.previouslyMerged.length > 0) {
		prompt += `## Previously merged branches (already in base)\n`;
		for (const prev of ctx.previouslyMerged) {
			prompt += `### ${prev.todoId}\n\`\`\`diff\n${prev.diff}\n\`\`\`\n\n`;
		}
	}

	if (ctx.buildErrors) {
		prompt += `## Build errors from previous resolution attempt\n\`\`\`\n${ctx.buildErrors}\n\`\`\`\n\n`;
	}

	prompt += `## Instructions\n`;
	prompt += `Produce the correctly merged file content. ALL changes from ALL branches must be preserved and work together.\n`;
	prompt += `Output ONLY the file content, no explanations, no markdown fences. Just the raw file.\n`;

	return prompt;
}

function buildSemanticVerifyPrompt(file: string, mergedContent: string, diffs: { todoId: string; diff: string }[]): string {
	let prompt = `## Post-merge verification for: ${file}\n\n`;
	prompt += `This file was modified by ${diffs.length} branches that all merged cleanly via git.\n`;
	prompt += `Verify the combined result has no issues.\n\n`;

	for (const d of diffs) {
		prompt += `### Changes from ${d.todoId}\n\`\`\`diff\n${d.diff}\n\`\`\`\n\n`;
	}

	prompt += `## Merged file\n\`\`\`\n${mergedContent}\n\`\`\`\n\n`;

	prompt += `## Check for\n`;
	prompt += `1. Duplicate imports, declarations, enum cases\n`;
	prompt += `2. References to renamed/deleted symbols\n`;
	prompt += `3. Protocol conformances matching current protocol definitions\n`;
	prompt += `4. Logical consistency between the two changesets\n\n`;

	prompt += `If issues found, output the corrected file content (raw, no fences).\n`;
	prompt += `If no issues, respond with exactly: LGTM\n`;

	return prompt;
}

/** Run a prompt through pi in JSON mode and get the text response */
async function llmResolve(cwd: string, prompt: string, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const args = ["--mode", "json", "-p", "--no-session", "-"];
		const proc = spawn("pi", args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data) => { stdout += data.toString(); });
		proc.stderr.on("data", (data) => { stderr += data.toString(); });

		// Pipe the prompt via stdin to avoid ARG_MAX limits
		proc.stdin.write(prompt);
		proc.stdin.end();

		proc.stdout.on("data", (data) => { stdout += data.toString(); });
		proc.stderr.on("data", (data) => { stderr += data.toString(); });

		proc.on("close", (code) => {
			if (code !== 0 && !stdout.trim()) {
				reject(new Error(`LLM resolve failed: ${stderr}`));
				return;
			}

			// Parse JSON mode output to find assistant text
			const lines = stdout.trim().split("\n");
			let text = "";
			for (const line of lines) {
				try {
					const event = JSON.parse(line);
					if (event.type === "message_end" && event.message?.role === "assistant") {
						for (const part of event.message.content ?? []) {
							if (part.type === "text") text += part.text;
						}
					}
				} catch {
					// not JSON, skip
				}
			}

			resolve(text || stdout);
		});

		proc.on("error", reject);

		if (signal) {
			const kill = () => { proc.kill("SIGTERM"); };
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});
}

/**
 * Merge a single branch with full conflict resolution.
 */
export async function mergeWithResolution(
	cwd: string,
	worktree: WorktreeInfo,
	todoCtx: TodoContext,
	previouslyMerged: { todoId: string; branch: string }[],
	onStatus: (msg: string) => void,
	signal?: AbortSignal,
): Promise<ResolutionResult> {
	const baseBranch = await getCurrentBranch(cwd);

	onStatus(`Merging ${worktree.branch}...`);

	// Attempt git merge
	const mergeResult = await mergeBranch(cwd, worktree.branch);

	if (mergeResult.success) {
		// Layer 1: Clean merge — now do semantic verification
		onStatus(`✓ Clean merge, verifying semantics...`);
		const verifyResult = await semanticVerify(cwd, worktree, todoCtx, previouslyMerged, baseBranch, onStatus, signal);
		return verifyResult;
	}

	// Layer 2: Conflict resolution
	if (mergeResult.conflictFiles.length === 0) {
		return {
			status: "failed",
			todoId: worktree.todoId,
			branch: worktree.branch,
			files: [],
			message: mergeResult.error || "Merge failed",
		};
	}

	onStatus(`⚠ Conflict in ${mergeResult.conflictFiles.length} file(s), resolving...`);

	// Resolve each conflicting file
	for (const file of mergeResult.conflictFiles) {
		const resolved = await resolveFileConflict(cwd, file, worktree, todoCtx, previouslyMerged, baseBranch, onStatus, signal);
		if (!resolved) {
			await abortMerge(cwd);
			return {
				status: "failed",
				todoId: worktree.todoId,
				branch: worktree.branch,
				files: [],
				conflictFiles: mergeResult.conflictFiles,
				message: `Failed to resolve conflict in ${file}`,
			};
		}
	}

	// Complete the merge
	const commitOk = await completeMerge(cwd, `Merge ${worktree.branch} (auto-resolved conflicts)`);
	if (!commitOk) {
		await abortMerge(cwd);
		return {
			status: "failed",
			todoId: worktree.todoId,
			branch: worktree.branch,
			files: [],
			conflictFiles: mergeResult.conflictFiles,
			message: "Failed to commit resolved merge",
		};
	}

	const allChanged = await getChangedFiles(cwd, "HEAD", "HEAD~1");
	return {
		status: "resolved",
		todoId: worktree.todoId,
		branch: worktree.branch,
		files: allChanged,
		conflictFiles: mergeResult.conflictFiles,
		message: `Resolved ${mergeResult.conflictFiles.length} conflict(s)`,
		attempts: 1,
	};
}

async function resolveFileConflict(
	cwd: string,
	file: string,
	worktree: WorktreeInfo,
	todoCtx: TodoContext,
	previouslyMerged: { todoId: string; branch: string }[],
	baseBranch: string,
	onStatus: (msg: string) => void,
	signal?: AbortSignal,
	buildErrors?: string,
): Promise<boolean> {
	const conflictContent = await getConflictContent(cwd, file);
	const baseContent = await getFileFromBranch(cwd, worktree.baseBranch, file);
	const branchDiff = await getFileDiff(cwd, worktree.branch, worktree.baseBranch, file);

	const prevDiffs: MergeContext["previouslyMerged"] = [];
	for (const prev of previouslyMerged) {
		const diff = await getFileDiff(cwd, prev.branch, worktree.baseBranch, file);
		if (diff.trim()) {
			prevDiffs.push({ todoId: prev.todoId, diff });
		}
	}

	const mergeCtx: MergeContext = {
		file,
		base: baseContent,
		versions: [
			{
				todoId: todoCtx.todoId,
				todoTitle: todoCtx.title,
				todoBody: todoCtx.body,
				branch: worktree.branch,
				diff: branchDiff,
				full: await getFileFromBranch(cwd, worktree.branch, file),
				agentSummary: todoCtx.agentSummary,
			},
		],
		conflictMarkers: conflictContent,
		previouslyMerged: prevDiffs,
		buildErrors,
	};

	const prompt = buildConflictResolutionPrompt(mergeCtx);
	onStatus(`  → Resolving ${file} with LLM...`);

	try {
		const resolved = await llmResolve(cwd, prompt, signal);
		if (!resolved.trim()) return false;

		await resolveConflict(cwd, file, resolved);
		return true;
	} catch {
		return false;
	}
}

async function semanticVerify(
	cwd: string,
	worktree: WorktreeInfo,
	todoCtx: TodoContext,
	previouslyMerged: { todoId: string; branch: string }[],
	baseBranch: string,
	onStatus: (msg: string) => void,
	signal?: AbortSignal,
): Promise<ResolutionResult> {
	// If this is the first merge or no previously merged branches touched the same files, skip
	if (previouslyMerged.length === 0) {
		return {
			status: "clean",
			todoId: worktree.todoId,
			branch: worktree.branch,
			files: await getChangedFiles(cwd, "HEAD", "HEAD~1"),
			message: "Fast merge, no semantic check needed",
		};
	}

	// Find files that were modified by both this branch and any previous branch
	const thisFiles = await getChangedFiles(cwd, worktree.branch, worktree.baseBranch);
	const overlappingFiles: string[] = [];

	for (const prev of previouslyMerged) {
		const prevFiles = await getChangedFiles(cwd, prev.branch, worktree.baseBranch);
		for (const file of thisFiles) {
			if (prevFiles.includes(file) && !overlappingFiles.includes(file)) {
				overlappingFiles.push(file);
			}
		}
	}

	if (overlappingFiles.length === 0) {
		return {
			status: "clean",
			todoId: worktree.todoId,
			branch: worktree.branch,
			files: await getChangedFiles(cwd, "HEAD", "HEAD~1"),
			message: "No overlapping files, semantic check skipped",
		};
	}

	onStatus(`  → Semantic check on ${overlappingFiles.length} overlapping file(s)...`);

	for (const file of overlappingFiles) {
		const mergedContent = await getFileFromBranch(cwd, "HEAD", file);
		if (!mergedContent) continue;

		const diffs: { todoId: string; diff: string }[] = [];
		diffs.push({
			todoId: todoCtx.todoId,
			diff: await getFileDiff(cwd, worktree.branch, worktree.baseBranch, file),
		});
		for (const prev of previouslyMerged) {
			const diff = await getFileDiff(cwd, prev.branch, worktree.baseBranch, file);
			if (diff.trim()) {
				diffs.push({ todoId: prev.todoId, diff });
			}
		}

		const prompt = buildSemanticVerifyPrompt(file, mergedContent, diffs);
		try {
			const result = await llmResolve(cwd, prompt, signal);
			if (result.trim() !== "LGTM") {
				// LLM found an issue — apply the fix
				onStatus(`  → Fixing semantic issue in ${file}...`);
				fs.writeFileSync(`${cwd}/${file}`, result, "utf8");
				// Stage and amend
				await new Promise<void>((resolve) => {
					execCb(`git add "${file}" && git commit --amend --no-edit`, { cwd }, () => resolve());
				});
			}
		} catch {
			// Semantic check failed, but merge was clean — continue
		}
	}

	return {
		status: "verified",
		todoId: worktree.todoId,
		branch: worktree.branch,
		files: await getChangedFiles(cwd, "HEAD", "HEAD~1"),
		message: `Clean merge, semantic verification passed`,
	};
}
