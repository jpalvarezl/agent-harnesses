/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import {
	findAvailableModel,
	type ModelRef,
	type ModelSelectContext,
	modelSpec,
	resolveEffectiveModel,
} from "./model-select.ts";
import {
	combineOutputAndDiagnostic,
	failureDetail,
	isFailedResult,
	isPendingResult,
	isQueuedResult,
	isRunningResult,
} from "./result-state.ts";
import {
	commitAll,
	createWorktree,
	deleteBranch,
	getGitRoot,
	getHeadSha,
	gitClean,
	isWorkingTreeClean,
	makeRunId,
	mergeBranchNoFF,
	pruneWorktrees,
	removeWorktree,
	resetHard,
	runBuildCheck,
	sanitizeRefComponent,
	type WorktreeInfo,
} from "./git-isolation.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
// Keep only the tail of a child's stderr to bound memory for noisy processes.
const STDERR_ACCUM_CAP = 64 * 1024;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	modelNote?: string;
	isolationNote?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const text = msg.content
				.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
				.map((part) => part.text)
				.join("");
			if (text) return text;
		}
	}
	return "";
}

function getResultOutput(result: SingleResult): string {
	return combineOutputAndDiagnostic(getFinalOutput(result.messages), result);
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	modelSelect: ModelSelectContext,
	taskModel: string | undefined,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const resolvedModel = resolveEffectiveModel({
		taskModel,
		sessionPin: modelSelect.sessionPin,
		agentModel: agent.model,
		current: modelSelect.current,
		available: modelSelect.available,
	});

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (resolvedModel.spec) args.push("--model", resolvedModel.spec);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1, // -1 = running; set to the real code once the process closes
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: resolvedModel.spec ?? (modelSelect.current ? modelSpec(modelSelect.current) : undefined),
		modelNote: resolvedModel.note,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		// Pass the task via stdin rather than argv. In print mode pi merges piped
		// stdin into the prompt, and stdin has no OS argv size limit — so large chain
		// handoffs (expanded {previous} output) cannot overflow the command line.
		args.push("Complete the task provided on standard input.");
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});
			let buffer = "";
			let closed = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;

			// Ignore EPIPE if the child exits before we finish writing the task.
			proc.stdin?.on("error", () => {});
			proc.stdin?.write(`Task: ${task}\n`);
			proc.stdin?.end();

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
				if (currentResult.stderr.length > STDERR_ACCUM_CAP) {
					currentResult.stderr = currentResult.stderr.slice(-STDERR_ACCUM_CAP);
				}
			});

			let onAbort: (() => void) | undefined;

			proc.on("close", (code, sig) => {
				closed = true;
				if (killTimer) clearTimeout(killTimer);
				if (signal && onAbort) signal.removeEventListener("abort", onAbort);
				if (buffer.trim()) processLine(buffer);
				// A child terminated by a signal reports code === null. Treat that as a
				// failure (not success) so downstream chain steps do not proceed on
				// partial output. User aborts are handled separately via wasAborted.
				if (code === null) {
					if (!wasAborted) currentResult.stderr += `\n[terminated by signal ${sig ?? "unknown"}]`;
					resolve(1);
					return;
				}
				resolve(code);
			});

			proc.on("error", (err) => {
				closed = true;
				if (killTimer) clearTimeout(killTimer);
				if (signal && onAbort) signal.removeEventListener("abort", onAbort);
				currentResult.stderr += `\n[spawn error] ${err instanceof Error ? err.message : String(err)}`;
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					// SIGTERM sets proc.killed immediately, so gate the force-kill on
					// whether the process has actually closed rather than proc.killed.
					killTimer = setTimeout(() => {
						if (!closed) proc.kill("SIGKILL");
					}, 5000);
					killTimer.unref?.();
				};
				onAbort = killProc;
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

import {
	classifyAfterMerge,
	classifyBeforeMerge,
	type IsolationOutcome,
	isSuccessOutcome,
	shouldRemoveWorktree,
} from "./isolation-policy.ts";

interface IsolationTask {
	agent: string;
	task: string;
	model?: string;
}

function firstLine(text: string, max = 72): string {
	const line = text.split("\n", 1)[0].trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line || "(task)";
}

function isolationNoteFor(outcome: IsolationOutcome, removed: boolean, wt: WorktreeInfo): string {
	const where = removed ? "cleaned up" : `kept branch ${wt.branch} at ${wt.worktreePath}`;
	switch (outcome) {
		case "merged":
			return `worktree: merged cleanly, ${where}`;
		case "no-changes":
			return `worktree: no changes, ${where}`;
		case "agent-failed":
			return `worktree: agent failed, not merged, ${where}`;
		case "commit-failed":
			return `worktree: commit failed, not merged, ${where}`;
		case "conflict":
			return `worktree: merge conflict, aborted, ${where}`;
		case "build-failed":
			return `worktree: build check failed, merge rolled back, ${where}`;
		case "merge-error":
			return `worktree: merge error, aborted, ${where}`;
		case "aborted":
			return `worktree: canceled before merge, ${where}`;
	}
}

/**
 * Parallel execution with git-worktree isolation. Each task runs in its own
 * worktree/branch; the harness commits each and merges them back into the parent
 * checkout with a clean-merge-only policy. Conflicts/build failures are preserved
 * for manual resolution. Never resolves conflicts automatically.
 */
async function runIsolatedParallel(opts: {
	cwd: string;
	agents: AgentConfig[];
	tasks: IsolationTask[];
	modelSelect: ModelSelectContext;
	signal: AbortSignal | undefined;
	onUpdate: OnUpdateCallback | undefined;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
	buildCommand?: string;
	cleanup: "on-success" | "never";
}): Promise<AgentToolResult<SubagentDetails>> {
	const { cwd, agents, tasks, modelSelect, signal, onUpdate, makeDetails, buildCommand, cleanup } = opts;

	const fail = (text: string): AgentToolResult<SubagentDetails> => ({
		content: [{ type: "text", text }],
		details: makeDetails([]),
		isError: true,
	});

	// Preconditions (fail closed).
	const gitRoot = await getGitRoot(cwd);
	if (!gitRoot) {
		return fail(`git-worktree isolation requires a git repository, but ${cwd} is not inside one.`);
	}
	if (!(await isWorkingTreeClean(gitRoot))) {
		return fail(
			`Refusing to dispatch: the working tree at ${gitRoot} has uncommitted changes. Commit or stash them first so merges land on a clean base.`,
		);
	}

	const runId = makeRunId();
	const wtBase = path.join(os.tmpdir(), "pi-subagent-worktrees", runId);

	// Create one worktree/branch per task (outside the working tree).
	const worktrees: WorktreeInfo[] = [];
	try {
		for (let i = 0; i < tasks.length; i++) {
			const comp = sanitizeRefComponent(`${i}-${tasks[i].agent}`);
			worktrees.push(
				await createWorktree(gitRoot, {
					index: i,
					agent: tasks[i].agent,
					branch: `subagent/${runId}/${comp}`,
					worktreePath: path.join(wtBase, comp),
				}),
			);
		}
	} catch (err) {
		for (const wt of worktrees) {
			await removeWorktree(gitRoot, wt.worktreePath);
			await deleteBranch(gitRoot, wt.branch);
		}
		await pruneWorktrees(gitRoot);
		return fail(`Failed to set up worktrees: ${err instanceof Error ? err.message : String(err)}`);
	}

	const allResults: SingleResult[] = tasks.map((t) => ({
		agent: t.agent,
		agentSource: "unknown",
		task: t.task,
		exitCode: -2, // queued
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	}));

	const emit = () => {
		if (!onUpdate) return;
		const running = allResults.filter((r) => isRunningResult(r)).length;
		const queued = allResults.filter((r) => isQueuedResult(r)).length;
		const done = allResults.filter((r) => !isPendingResult(r)).length;
		const queuedStr = queued > 0 ? `, ${queued} queued` : "";
		onUpdate({
			content: [
				{ type: "text", text: `Isolated parallel: ${done}/${allResults.length} done, ${running} running${queuedStr}...` },
			],
			details: makeDetails([...allResults]),
		});
	};

	// Run each agent in its worktree. Catch per-task so ALL workers settle (their
	// child processes fully exit) before we touch the parent checkout — an abort in
	// one task must not race merge/cleanup against another still-shutting-down child.
	const results: SingleResult[] = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
		allResults[index] = { ...allResults[index], exitCode: -1 };
		emit();
		const wt = worktrees[index];
		try {
			const result = await runSingleAgent(
				cwd,
				agents,
				t.agent,
				t.task,
				wt.worktreePath, // force child cwd into the worktree
				undefined,
				signal,
				(partial) => {
					if (partial.details?.results[0]) {
						allResults[index] = partial.details.results[0];
						emit();
					}
				},
				makeDetails,
				modelSelect,
				t.model,
			);
			allResults[index] = result;
			emit();
			return result;
		} catch (err) {
			// Abort or unexpected failure: synthesize a failed result so we never merge
			// this task, but keep waiting for siblings to settle.
			const failed: SingleResult = {
				...allResults[index],
				exitCode: 1,
				stderr: `${allResults[index].stderr}\n[${signal?.aborted ? "aborted" : "error"}] ${err instanceof Error ? err.message : String(err)}`,
			};
			allResults[index] = failed;
			emit();
			return failed;
		}
	});

	const isAborted = () => signal?.aborted === true;
	// Undo a merge and prove the parent checkout is clean again. Returns false if not.
	const rollbackTo = async (sha: string): Promise<boolean> => {
		const reset = await resetHard(gitRoot, sha);
		const clean = await gitClean(gitRoot);
		return reset && clean && (await isWorkingTreeClean(gitRoot));
	};

	// Commit each worktree (capture partial work even if the agent failed).
	const commitResults: { committed: boolean; error?: string }[] = new Array(tasks.length);
	for (let i = 0; i < tasks.length; i++) {
		if (isAborted()) {
			commitResults[i] = { committed: false };
			continue;
		}
		commitResults[i] = await commitAll(
			worktrees[i].worktreePath,
			`subagent(${tasks[i].agent}): ${firstLine(tasks[i].task)}`,
		);
		if (commitResults[i].error) results[i].stderr += `\n[commit] ${commitResults[i].error}`;
	}

	// Merge sequentially into the parent checkout (clean-merge-only). Each step
	// gathers facts, performs the necessary git side effects, then defers the
	// outcome decision to the pure policy in isolation-policy.ts.
	const outcomes: IsolationOutcome[] = new Array(tasks.length);
	for (let i = 0; i < tasks.length; i++) {
		const pre = classifyBeforeMerge({
			aborted: isAborted(),
			agentFailed: isFailedResult(results[i]),
			commitFailed: Boolean(commitResults[i].error),
			committed: commitResults[i].committed,
		});
		if (pre !== "proceed") {
			outcomes[i] = pre;
			continue;
		}

		const preSha = await getHeadSha(gitRoot);
		const merge = await mergeBranchNoFF(gitRoot, worktrees[i].branch);
		if (merge.status === "conflict") results[i].stderr += `\n[merge] conflicts in: ${merge.conflictFiles.join(", ")}`;
		if (merge.status === "error") results[i].stderr += `\n[merge] ${merge.error ?? "failed"}`;

		// Side effects for a clean merge: honor a late abort, run the build gate, and
		// roll back as needed so the parent tree stays clean for the next merge.
		let abortedAfterMerge = false;
		let build: { success: boolean; aborted: boolean } | undefined;
		if (merge.status === "clean") {
			if (isAborted()) {
				abortedAfterMerge = true;
				if (!(await rollbackTo(preSha)))
					results[i].stderr += `\n[rollback] WARNING: parent checkout may not be clean after aborting merge`;
			} else if (buildCommand) {
				const b = await runBuildCheck(gitRoot, buildCommand, signal);
				build = { success: b.success, aborted: b.aborted };
				if (!b.success) {
					// Roll back the merge and remove any generated (untracked) build output.
					if (!(await rollbackTo(preSha)))
						results[i].stderr += `\n[rollback] WARNING: parent checkout may not be clean after rollback`;
					if (!b.aborted)
						results[i].stderr += `\n[build] failed after merge (rolled back):\n${b.output.slice(-2000)}`;
				} else if (!(await rollbackTo("HEAD"))) {
					// Build passed: keep the merge commit but discard build artifacts.
					results[i].stderr += `\n[build] WARNING: parent checkout not clean after build; later merges may be affected`;
				}
			}
		}

		outcomes[i] = classifyAfterMerge({ mergeStatus: merge.status, abortedAfterMerge, build });
	}

	// Cleanup per policy and annotate each result with the real disposition.
	const removed: boolean[] = new Array(tasks.length).fill(false);
	for (let i = 0; i < tasks.length; i++) {
		const wt = worktrees[i];
		if (shouldRemoveWorktree(outcomes[i], cleanup)) {
			const wtRemoved = await removeWorktree(gitRoot, wt.worktreePath);
			const branchRemoved = await deleteBranch(gitRoot, wt.branch);
			if (wtRemoved && branchRemoved) {
				removed[i] = true;
			} else {
				results[i].stderr += `\n[cleanup] failed to remove worktree/branch; kept ${wt.branch} at ${wt.worktreePath}`;
			}
		}
		results[i].isolationNote = isolationNoteFor(outcomes[i], removed[i], wt);
	}
	await pruneWorktrees(gitRoot);
	try {
		fs.rmdirSync(wtBase);
	} catch {
		/* ignore */
	}

	const mergedCount = outcomes.filter((o) => o === "merged").length;
	const noChangeCount = outcomes.filter((o) => o === "no-changes").length;
	const failedCount = outcomes.filter((o) => !isSuccessOutcome(o)).length;
	const preservedFailures = outcomes.filter((o, i) => !removed[i] && !isSuccessOutcome(o)).length;
	const abortedAny = outcomes.some((o) => o === "aborted");

	const summaries = results.map((r, i) => {
		const transcript = truncateParallelOutput(getFinalOutput(r.messages).trim() || "(no output)");
		const diag = failureDetail(r);
		const body = diag ? `${transcript}\n\n[error] ${diag}` : transcript;
		return `### [${r.agent}] ${outcomes[i]}\n\n${body}`;
	});

	const report = outcomes
		.map((o, i) =>
			removed[i]
				? `- ${tasks[i].agent}: ${o} (cleaned up)`
				: `- ${tasks[i].agent}: ${o} (kept ${worktrees[i].branch} at ${worktrees[i].worktreePath})`,
		)
		.join("\n");

	const headline =
		`Isolated parallel (git-worktree): ${mergedCount} merged, ${noChangeCount} no-change, ${failedCount} failed` +
		(abortedAny ? " — aborted" : "") +
		(preservedFailures > 0 ? ` — ${preservedFailures} branch(es) preserved for manual resolution` : "");

	return {
		content: [{ type: "text", text: `${headline}\n\n${summaries.join("\n\n---\n\n")}\n\n## Merge report\n${report}` }],
		details: makeDetails(results),
		isError: failedCount > 0,
	};
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	model: Type.Optional(
		Type.String({ description: "Optional model override (provider/id or id). Falls back if unavailable." }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	model: Type.Optional(
		Type.String({ description: "Optional model override (provider/id or id). Falls back if unavailable." }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	model: Type.Optional(
		Type.String({
			description:
				"Optional model override for single mode (provider/id or id). Defaults to the active session model; falls back if unavailable.",
		}),
	),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	isolation: Type.Optional(
		StringEnum(["none", "git-worktree"] as const, {
			description:
				"Parallel isolation (tasks mode only). 'git-worktree' runs each task in its own git worktree/branch and merges results back with a clean-merge-only policy, preventing parallel write races. Default 'none'.",
			default: "none",
		}),
	),
	mergeStrategy: Type.Optional(
		StringEnum(["clean-only"] as const, {
			description:
				"Merge policy for git-worktree isolation. Only 'clean-only' is supported: conflicting merges are aborted and their branch/worktree preserved for manual resolution.",
			default: "clean-only",
		}),
	),
	buildCommand: Type.Optional(
		Type.String({
			description:
				"Optional build/test command run after each clean merge (git-worktree isolation). A non-zero exit rolls back that one merge and preserves the branch.",
		}),
	),
	cleanup: Type.Optional(
		StringEnum(["on-success", "never"] as const, {
			description:
				"Worktree cleanup for git-worktree isolation. 'on-success' (default) removes merged/no-change worktrees and preserves failures for inspection; 'never' keeps all. Failed tasks are always preserved so their work is recoverable.",
			default: "on-success",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	// Session-scoped default model for subagents, set via /subagent-model.
	// This closure variable is per extension instance, which pi rebinds per session.
	let subagentModelPin: string | undefined;

	pi.on("session_start", () => {
		subagentModelPin = undefined;
	});

	pi.registerCommand("subagent-model", {
		description: "Set the session default model for subagents (no arg opens a picker; choose 'inherit' to clear; or pass a model spec)",
		handler: async (args, ctx) => {
			const available = ctx.modelRegistry.getAvailable() as ModelRef[];
			const INHERIT = "(inherit active session model)";

			const apply = (spec: string | undefined) => {
				if (!spec) {
					subagentModelPin = undefined;
					ctx.ui.notify("Subagents will inherit the active session model.", "info");
					return;
				}
				const found = findAvailableModel(available, spec);
				if (!found) {
					ctx.ui.notify(`Model "${spec}" is not available. Run /login or pick from the list.`, "error");
					return;
				}
				subagentModelPin = modelSpec(found);
				ctx.ui.notify(`Subagents will use ${subagentModelPin} (this session).`, "info");
			};

			const typed = args.trim();
			if (typed) {
				apply(typed);
				return;
			}

			if (available.length === 0) {
				ctx.ui.notify("No authenticated models available.", "error");
				return;
			}
			const currentSpec = subagentModelPin ?? (ctx.model ? modelSpec(ctx.model as ModelRef) : undefined);
			const labels = [INHERIT, ...available.map((m) => modelSpec(m))];
			const title = currentSpec
				? `Default model for subagents (current: ${subagentModelPin ?? `inherited ${currentSpec}`}):`
				: "Default model for subagents:";
			const choice = await ctx.ui.select(title, labels);
			if (!choice) return;
			apply(choice === INHERIT ? undefined : choice);
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		promptSnippet: "Delegate work to isolated child agents in single, parallel, or chain mode.",
		promptGuidelines: [
			"Use subagent for independent recon/review or genuinely separable subtasks with isolated context; avoid it for trivial single-step work.",
			"Use subagent tasks for parallel independent work, and subagent chain when a later step needs an earlier step's output via the {previous} placeholder.",
			'Use subagent with isolation: "git-worktree" whenever parallel tasks may modify files; it requires a clean git tree, merges clean-only, and preserves conflicts for manual resolution (never auto-resolved).',
			"Use subagent parallel mode without isolation only for read-only agents (scout/planner/reviewer); serialize write-heavy work with chain or isolate worker tasks.",
			"Use subagent children with the inherited session model by default; prefer /subagent-model or a per-task model override rather than hard-coding provider-specific model IDs.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			const modelSelect: ModelSelectContext = {
				available: ctx.modelRegistry.getAvailable() as ModelRef[],
				current: ctx.model as ModelRef | undefined,
				sessionPin: subagentModelPin,
			};

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			// Project-local agents are repo-controlled prompts (they can read files and
			// run bash). The approval decision must NOT be controllable by the (LLM-driven)
			// tool caller, so it is deliberately not a tool parameter. Fail closed: require
			// interactive human approval, or an explicit out-of-band trust env var; otherwise
			// refuse to run them (including in non-interactive contexts).
			if (agentScope === "project" || agentScope === "both") {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const trustedByEnv = /^(1|true|yes)$/i.test(process.env.SUBAGENT_TRUST_PROJECT_AGENTS ?? "");
					const denied = (reason: string) => ({
						content: [{ type: "text" as const, text: reason }],
						details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						isError: true,
					});

					if (!trustedByEnv) {
						if (!ctx.hasUI) {
							return denied(
								`Refused to run project-local agents (${names}) from ${dir} without interactive approval. ` +
									`Set SUBAGENT_TRUST_PROJECT_AGENTS=1 to allow in non-interactive contexts (trusted repos only).`,
							);
						}
						const ok = await ctx.ui.confirm(
							"Run project-local agents?",
							`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
						);
						if (!ok) return denied("Canceled: project-local agents not approved.");
					}
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						modelSelect,
						step.model,
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				if ((params.isolation ?? "none") === "git-worktree") {
					return await runIsolatedParallel({
						cwd: ctx.cwd,
						agents,
						tasks: params.tasks,
						modelSelect,
						signal,
						onUpdate,
						makeDetails: makeDetails("parallel"),
						buildCommand: params.buildCommand,
						cleanup: params.cleanup ?? "on-success",
					});
				}

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results (queued until a worker slot opens)
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -2, // -2 = queued, -1 = running, >= 0 = finished
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => isRunningResult(r)).length;
						const queued = allResults.filter((r) => isQueuedResult(r)).length;
						const done = allResults.filter((r) => !isPendingResult(r)).length;
						const queuedStr = queued > 0 ? `, ${queued} queued` : "";
						onUpdate({
							content: [
								{
									type: "text",
									text: `Parallel: ${done}/${allResults.length} done, ${running} running${queuedStr}...`,
								},
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					// Mark running once this task actually acquires a worker slot.
					allResults[index] = { ...allResults[index], exitCode: -1 };
					emitParallelUpdate();
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						modelSelect,
						t.model,
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					// Truncate the transcript first, then append the (already capped) diagnostic
					// so failure detail is never dropped by output truncation.
					const transcript = truncateParallelOutput(getFinalOutput(r.messages).trim() || "(no output)");
					const diag = failureDetail(r);
					const body = diag ? `${transcript}\n\n[error] ${diag}` : transcript;
					return `### [${r.agent}] ${status}\n\n${body}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
					// Surface partial/total failure to the parent model, consistent with single/chain.
					isError: successCount !== results.length,
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					modelSelect,
					params.model,
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const running = isRunningResult(r);
				const isError = !running && isFailedResult(r);
				const icon = running
					? theme.fg("warning", "⏳")
					: isError
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", running ? "(running...)" : "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const diag = failureDetail(r);
					if (diag) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("error", diag), 0, 0));
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					if (r.modelNote) container.addChild(new Text(theme.fg("muted", r.modelNote), 0, 0));
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (displayItems.length === 0)
					text += `\n${theme.fg("muted", running ? "(running...)" : "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const diag = failureDetail(r);
				if (diag) text += `\n${theme.fg("error", diag)}`;
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				if (r.modelNote) text += `\n${theme.fg("muted", r.modelNote)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const runningSteps = details.results.filter((r) => isRunningResult(r)).length;
				const failCount = details.results.filter((r) => !isRunningResult(r) && isFailedResult(r)).length;
				const successCount = details.results.filter((r) => !isRunningResult(r) && !isFailedResult(r)).length;
				const icon =
					runningSteps > 0
						? theme.fg("warning", "⏳")
						: failCount > 0
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isRunningResult(r)
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
						const stepDiag = failureDetail(r);
						if (stepDiag) container.addChild(new Text(theme.fg("error", stepDiag), 0, 0));

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
						if (r.modelNote) container.addChild(new Text(theme.fg("muted", r.modelNote), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = isRunningResult(r)
						? theme.fg("warning", "⏳")
						: isFailedResult(r)
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", isRunningResult(r) ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
					const stepDiag = failureDetail(r);
					if (stepDiag) text += `\n${theme.fg("error", stepDiag)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => isRunningResult(r)).length;
				const queued = details.results.filter((r) => isQueuedResult(r)).length;
				const successCount = details.results.filter((r) => !isPendingResult(r) && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => !isPendingResult(r) && isFailedResult(r)).length;
				const pending = running + queued;
				const isRunning = pending > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const queuedStr = queued > 0 ? `, ${queued} queued` : "";
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running${queuedStr}`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
						const taskDiag = failureDetail(r);
						if (taskDiag) container.addChild(new Text(theme.fg("error", taskDiag), 0, 0));

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
						if (r.modelNote) container.addChild(new Text(theme.fg("muted", r.modelNote), 0, 0));
						if (r.isolationNote) container.addChild(new Text(theme.fg("muted", r.isolationNote), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon = isQueuedResult(r)
						? theme.fg("muted", "·")
						: isRunningResult(r)
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) {
						if (isQueuedResult(r)) text += `\n${theme.fg("muted", "(queued)")}`;
						else if (isRunningResult(r)) text += `\n${theme.fg("muted", "(running...)")}`;
						else text += `\n${theme.fg("muted", "(no output)")}`;
					} else text += `\n${renderDisplayItems(displayItems, 5)}`;
					const taskDiag = failureDetail(r);
					if (taskDiag) text += `\n${theme.fg("error", taskDiag)}`;
					if (r.isolationNote) text += `\n${theme.fg("muted", r.isolationNote)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
