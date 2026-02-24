/**
 * Dispatch Extension — Scan, dispatch, and merge parallel agent work via git worktrees.
 *
 * Commands:
 *   /scan [path] [-d] [--tag x,y] [--changed] [--since 2w]
 *   /dispatch [TODO-xx ...] [all] [--agent name]
 *   /dispatch status
 *   /dispatch merge
 *   /dispatch cleanup
 *   /sessions
 *   /broadcast <msg>
 *
 * Flow: /scan -d → find markers → group into todos → create worktrees →
 *       spawn parallel subagents → auto-merge with LLM conflict resolution → cleanup
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, BorderedLoader } from "@mariozechner/pi-coding-agent";
import {
	Container,
	type Focusable,
	Key,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	matchesKey,
	truncateToWidth,
	getEditorKeybindings,
} from "@mariozechner/pi-tui";

import {
	createWorktree,
	commitWorktree,
	cleanupWorktree,
	cleanupAllWorktrees,
	listWorktrees,
	getCurrentBranch,
	hasUncommittedChanges,
	getGitRoot,
	type WorktreeInfo,
} from "./git-worktree.js";

import {
	broadcast,
	readBroadcasts,
	watchBroadcasts,
	gcBroadcasts,
	formatBroadcastEvent,
	type BroadcastEvent,
} from "./broadcast.js";

import {
	mergeWithResolution,
	type TodoContext,
	type ResolutionResult,
} from "./merge-resolver.js";

import {
	scanMarkers,
	groupMarkers,
	countFiles,
	type CodeMarker,
	type ProposedTodo,
} from "./scanner.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface DispatchState {
	worktrees: Map<string, WorktreeInfo>;
	results: Map<string, "pending" | "running" | "done" | "failed">;
	mergeResults: ResolutionResult[];
}

// ─── TUI Components ─────────────────────────────────────────────────────────

/** Multi-select checkbox list for picking todos/proposals */
class CheckboxSelector extends Container implements Focusable {
	private items: { label: string; sublabel: string; detail: string; value: string; checked: boolean }[];
	private selectedIndex = 0;
	private onConfirm: (selected: string[]) => void;
	private onCancel: () => void;
	private theme: Theme;
	private title: string;
	private hint: string;

	private _focused = false;
	get focused() { return this._focused; }
	set focused(v: boolean) { this._focused = v; }

	constructor(
		theme: Theme,
		title: string,
		items: { label: string; sublabel: string; detail: string; value: string; checked: boolean }[],
		hint: string,
		onConfirm: (selected: string[]) => void,
		onCancel: () => void,
	) {
		super();
		this.theme = theme;
		this.title = title;
		this.items = items;
		this.hint = hint;
		this.onConfirm = onConfirm;
		this.onCancel = onCancel;
	}

	handleInput(data: string): void {
		const kb = getEditorKeybindings();
		if (kb.matches(data, "selectUp")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
		} else if (kb.matches(data, "selectDown")) {
			this.selectedIndex = this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (matchesKey(data, Key.space)) {
			this.items[this.selectedIndex].checked = !this.items[this.selectedIndex].checked;
		} else if (matchesKey(data, "a")) {
			const allChecked = this.items.every((i) => i.checked);
			for (const item of this.items) item.checked = !allChecked;
		} else if (kb.matches(data, "selectConfirm")) {
			const selected = this.items.filter((i) => i.checked).map((i) => i.value);
			this.onConfirm(selected);
			return;
		} else if (kb.matches(data, "selectCancel")) {
			this.onCancel();
			return;
		} else if (matchesKey(data, "d")) {
			// Quick dispatch
			const selected = this.items.filter((i) => i.checked).map((i) => i.value);
			this.onConfirm(selected);
			return;
		}
		this.invalidate();
	}

	override render(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		const innerWidth = Math.max(10, width - 2);

		// Top border
		lines.push(th.fg("borderMuted", "─".repeat(width)));
		lines.push("");

		// Title
		const selectedCount = this.items.filter((i) => i.checked).length;
		const titleLine = th.fg("accent", th.bold(this.title)) + th.fg("muted", ` (${selectedCount}/${this.items.length} selected)`);
		lines.push(truncateToWidth(`  ${titleLine}`, width));
		lines.push("");

		// Items
		const maxVisible = 12;
		const startIdx = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.items.length - maxVisible));
		const endIdx = Math.min(startIdx + maxVisible, this.items.length);

		for (let i = startIdx; i < endIdx; i++) {
			const item = this.items[i];
			const isSelected = i === this.selectedIndex;
			const checkbox = item.checked ? th.fg("success", "✓") : th.fg("dim", "○");
			const cursor = isSelected ? th.fg("accent", "→") : " ";
			const label = isSelected ? th.fg("accent", item.label) : th.fg("text", item.label);
			lines.push(truncateToWidth(`  ${cursor} ${checkbox} ${label}`, width));
			if (item.sublabel) {
				lines.push(truncateToWidth(`        ${th.fg("muted", item.sublabel)}`, width));
			}
			if (isSelected && item.detail) {
				lines.push(truncateToWidth(`        ${th.fg("dim", item.detail)}`, width));
			}
		}

		if (this.items.length > maxVisible) {
			lines.push(truncateToWidth(`  ${th.fg("dim", `(${this.selectedIndex + 1}/${this.items.length})`)}`, width));
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", this.hint)}`, width));
		lines.push("");
		lines.push(th.fg("borderMuted", "─".repeat(width)));
		return lines;
	}

	override invalidate(): void {
		super.invalidate();
	}
}

/** Progress display for dispatch operations */
class DispatchProgress {
	private theme: Theme;
	private tasks: { todoId: string; title: string; status: string; lastAction: string }[];
	private phase: string;
	private phaseDetail: string;

	constructor(theme: Theme) {
		this.theme = theme;
		this.tasks = [];
		this.phase = "Initializing";
		this.phaseDetail = "";
	}

	setPhase(phase: string, detail?: string): void {
		this.phase = phase;
		this.phaseDetail = detail || "";
	}

	setTasks(tasks: { todoId: string; title: string }[]): void {
		this.tasks = tasks.map((t) => ({ ...t, status: "pending", lastAction: "" }));
	}

	updateTask(todoId: string, status: string, lastAction?: string): void {
		const task = this.tasks.find((t) => t.todoId === todoId);
		if (task) {
			task.status = status;
			if (lastAction) task.lastAction = lastAction;
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];

		lines.push("");
		// Phase header
		const phaseIcon = this.phase.includes("complete") ? th.fg("success", "✓") :
			this.phase.includes("fail") ? th.fg("error", "✗") : th.fg("warning", "⏳");
		lines.push(truncateToWidth(`  ${phaseIcon} ${th.fg("accent", th.bold(this.phase))}`, width));
		if (this.phaseDetail) {
			lines.push(truncateToWidth(`    ${th.fg("muted", this.phaseDetail)}`, width));
		}
		lines.push("");

		// Task list
		for (const task of this.tasks) {
			const icon = task.status === "done" ? th.fg("success", "✓") :
				task.status === "failed" ? th.fg("error", "✗") :
				task.status === "running" ? th.fg("warning", "⏳") :
				th.fg("dim", "○");
			const titleColor = task.status === "done" ? "dim" : task.status === "failed" ? "error" : "text";
			const todoRef = th.fg("accent", `TODO-${task.todoId}`);
			const title = th.fg(titleColor, task.title);
			lines.push(truncateToWidth(`  ${icon} ${todoRef} ${title}`, width));
			if (task.lastAction && task.status === "running") {
				lines.push(truncateToWidth(`    ${th.fg("dim", `→ ${task.lastAction}`)}`, width));
			}
		}

		const done = this.tasks.filter((t) => t.status === "done").length;
		const failed = this.tasks.filter((t) => t.status === "failed").length;
		const running = this.tasks.filter((t) => t.status === "running").length;
		if (this.tasks.length > 0) {
			lines.push("");
			lines.push(truncateToWidth(`  ${th.fg("muted", `${done} done, ${running} running, ${failed} failed`)}`, width));
		}

		lines.push("");
		return lines;
	}
}

/** Sessions display */
class SessionsDisplay extends Container {
	private theme: Theme;
	private onClose: () => void;

	constructor(
		theme: Theme,
		sessions: { id: string; name?: string; status: string }[],
		broadcasts: BroadcastEvent[],
		onClose: () => void,
	) {
		super();
		this.theme = theme;
		this.onClose = onClose;

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(new Text(theme.fg("accent", theme.bold("Live Sessions")), 1, 0));
		this.addChild(new Spacer(1));

		if (sessions.length === 0) {
			this.addChild(new Text(theme.fg("muted", "  No other sessions detected"), 0, 0));
		} else {
			for (const session of sessions) {
				const icon = session.status === "working" ? theme.fg("warning", "●") : theme.fg("success", "●");
				const name = session.name || session.id.slice(0, 8);
				this.addChild(new Text(`  ${icon} ${theme.fg("text", name)} ${theme.fg("dim", `(${session.status})`)}`, 0, 0));
			}
		}

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Recent Broadcasts")), 1, 0));
		this.addChild(new Spacer(1));

		const recentBroadcasts = broadcasts.slice(-10);
		if (recentBroadcasts.length === 0) {
			this.addChild(new Text(theme.fg("muted", "  No recent broadcasts"), 0, 0));
		} else {
			for (const event of recentBroadcasts) {
				this.addChild(new Text(`  ${theme.fg("dim", formatBroadcastEvent(event))}`, 0, 0));
			}
		}

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Press Escape to close"), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onClose();
		}
	}
}

/** Conflict resolution choice display */
class ConflictChoiceDisplay extends Container {
	private selectList: SelectList;

	constructor(
		theme: Theme,
		files: string[],
		onSelect: (action: string) => void,
		onCancel: () => void,
	) {
		super();

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(new Text(theme.fg("warning", theme.bold(`  ⚠ Merge conflict in ${files.length} file(s)`)), 0, 0));
		this.addChild(new Spacer(1));

		for (const file of files) {
			this.addChild(new Text(theme.fg("muted", `  ${file}`), 0, 0));
		}
		this.addChild(new Spacer(1));

		const options: SelectItem[] = [
			{ value: "resolve", label: "Resolve with LLM", description: "Auto-resolve using full diff context" },
			{ value: "skip", label: "Skip", description: "Skip this merge, keep branch for later" },
			{ value: "abort", label: "Abort", description: "Abort remaining merges" },
		];

		this.selectList = new SelectList(options, options.length, {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});
		this.selectList.onSelect = (item) => onSelect(item.value);
		this.selectList.onCancel = () => onCancel();
		this.addChild(this.selectList);

		this.addChild(new Text(theme.fg("dim", "  Enter to confirm • Esc cancel"), 0, 0));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}

// ─── Todo Integration Helpers ────────────────────────────────────────────────

interface TodoInfo {
	id: string;
	title: string;
	body: string;
	tags: string[];
	status: string;
}

async function listOpenTodos(ctx: ExtensionContext): Promise<TodoInfo[]> {
	// Read todos from .pi/todos directory
	const todosDir = ".pi/todos";
	const fs = await import("node:fs");
	const path = await import("node:path");
	const fullDir = path.resolve(ctx.cwd, todosDir);

	if (!fs.existsSync(fullDir)) return [];

	const entries = fs.readdirSync(fullDir).filter((f: string) => f.endsWith(".md"));
	const todos: TodoInfo[] = [];

	for (const entry of entries) {
		const id = entry.slice(0, -3);
		const content = fs.readFileSync(path.join(fullDir, entry), "utf8");

		// Parse JSON front matter
		if (!content.startsWith("{")) continue;
		let depth = 0;
		let inString = false;
		let escaped = false;
		let endIdx = -1;
		for (let i = 0; i < content.length; i++) {
			const ch = content[i];
			if (inString) {
				if (escaped) { escaped = false; continue; }
				if (ch === "\\") { escaped = true; continue; }
				if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') { inString = true; continue; }
			if (ch === "{") depth++;
			if (ch === "}") { depth--; if (depth === 0) { endIdx = i; break; } }
		}

		if (endIdx === -1) continue;
		try {
			const meta = JSON.parse(content.slice(0, endIdx + 1));
			const body = content.slice(endIdx + 1).replace(/^\r?\n+/, "");
			if (meta.status === "closed" || meta.status === "done") continue;
			todos.push({
				id: meta.id || id,
				title: meta.title || "",
				body: body || "",
				tags: meta.tags || [],
				status: meta.status || "open",
			});
		} catch {
			continue;
		}
	}

	return todos;
}

// ─── Core Dispatch Logic ─────────────────────────────────────────────────────

async function runDispatch(
	ctx: ExtensionCommandContext,
	todoIds: string[],
	agentName: string,
	onProgress: DispatchProgress,
	onRender: () => void,
): Promise<void> {
	const sessionId = ctx.sessionManager.getSessionId();
	const sessionName = ctx.sessionManager.getSessionName() ?? undefined;

	// Check for uncommitted changes
	if (await hasUncommittedChanges(ctx.cwd)) {
		const ok = await ctx.ui.confirm(
			"Uncommitted changes",
			"You have uncommitted changes. Worktrees branch from HEAD.\nCommit or stash first?",
		);
		if (!ok) return;
	}

	// Load todos
	const allTodos = await listOpenTodos(ctx);
	const todos = allTodos.filter((t) => todoIds.includes(t.id));
	if (todos.length === 0) {
		ctx.ui.notify("No matching open todos found", "error");
		return;
	}

	broadcast(ctx.cwd, { type: "dispatch:started", sessionId, sessionName, message: `Dispatching ${todos.length} todos` });

	// Phase 1: Create worktrees
	onProgress.setPhase("Creating worktrees");
	onProgress.setTasks(todos.map((t) => ({ todoId: t.id, title: t.title })));
	onRender();

	const worktrees: WorktreeInfo[] = [];
	for (const todo of todos) {
		try {
			const wt = await createWorktree(ctx.cwd, todo.id);
			worktrees.push(wt);
			onProgress.updateTask(todo.id, "pending", `Worktree ready: ${wt.worktreePath}`);
			onRender();
		} catch (error: any) {
			onProgress.updateTask(todo.id, "failed", error.message);
			onRender();
			ctx.ui.notify(`Failed to create worktree for TODO-${todo.id}: ${error.message}`, "error");
		}
	}

	if (worktrees.length === 0) {
		onProgress.setPhase("Failed — no worktrees created");
		onRender();
		return;
	}

	// Phase 2: Spawn parallel subagents
	onProgress.setPhase("Running agents", `${worktrees.length} parallel agent(s)`);
	onRender();

	// Build task descriptions for the subagent tool
	const subagentTasks = worktrees.map((wt) => {
		const todo = todos.find((t) => t.id === wt.todoId)!;
		const taskPrompt = buildAgentTaskPrompt(todo, wt);

		broadcast(ctx.cwd, {
			type: "agent:started",
			sessionId,
			sessionName,
			todoId: todo.id,
			todoTitle: todo.title,
		});

		onProgress.updateTask(todo.id, "running", "Agent starting...");
		onRender();

		return {
			agent: agentName,
			task: taskPrompt,
			cwd: wt.worktreePath,
		};
	});

	// Use sendUserMessage to trigger subagent parallel execution
	const subagentPrompt = buildSubagentMessage(subagentTasks);

	// We need to send a message that will use the subagent tool
	// The cleanest approach: inject the message and let the LLM call subagent
	ctx.ui.setEditorText(subagentPrompt);

	onProgress.setPhase("Agents dispatched", "Waiting for agents to complete. Watch output above.");
	onRender();

	// Wait for the agent to finish
	await ctx.waitForIdle();

	// Phase 3: Commit and merge
	onProgress.setPhase("Committing and merging");
	onRender();

	// Commit any changes in each worktree
	for (const wt of worktrees) {
		const todo = todos.find((t) => t.id === wt.todoId)!;
		const committed = await commitWorktree(wt, `feat: ${todo.title} (TODO-${todo.id})`);
		if (committed) {
			onProgress.updateTask(todo.id, "done", "Committed");
			broadcast(ctx.cwd, {
				type: "agent:finished",
				sessionId,
				sessionName,
				todoId: todo.id,
				todoTitle: todo.title,
			});
		} else {
			onProgress.updateTask(todo.id, "done", "No changes to commit");
		}
		onRender();
	}

	// Sequential merge
	onProgress.setPhase("Merging branches");
	onRender();

	const mergeResults: ResolutionResult[] = [];
	const previouslyMerged: { todoId: string; branch: string }[] = [];

	for (const wt of worktrees) {
		const todo = todos.find((t) => t.id === wt.todoId)!;
		const todoCtx: TodoContext = {
			todoId: `TODO-${todo.id}`,
			title: todo.title,
			body: todo.body,
			agentSummary: "",
		};

		const result = await mergeWithResolution(
			ctx.cwd,
			wt,
			todoCtx,
			previouslyMerged,
			(msg) => {
				onProgress.updateTask(todo.id, "running", msg);
				onRender();
			},
		);

		mergeResults.push(result);
		if (result.status === "clean" || result.status === "resolved" || result.status === "verified") {
			previouslyMerged.push({ todoId: `TODO-${todo.id}`, branch: wt.branch });
			onProgress.updateTask(todo.id, "done", result.message);
			broadcast(ctx.cwd, {
				type: "merge:success",
				sessionId,
				sessionName,
				todoId: todo.id,
				todoTitle: todo.title,
			});
		} else {
			onProgress.updateTask(todo.id, "failed", result.message);
			broadcast(ctx.cwd, {
				type: "merge:conflict",
				sessionId,
				sessionName,
				todoId: todo.id,
				todoTitle: todo.title,
				message: result.message,
			});
		}
		onRender();
	}

	// Phase 4: Cleanup
	onProgress.setPhase("Cleaning up");
	onRender();

	for (const wt of worktrees) {
		try {
			await cleanupWorktree(ctx.cwd, wt);
		} catch {
			// ignore cleanup errors
		}
	}

	// Summary
	const merged = mergeResults.filter((r) => r.status !== "failed").length;
	const failed = mergeResults.filter((r) => r.status === "failed").length;

	if (failed === 0) {
		onProgress.setPhase("Dispatch complete", `${merged}/${mergeResults.length} merged ✓`);
	} else {
		onProgress.setPhase("Dispatch complete with errors", `${merged} merged, ${failed} failed`);
	}
	onRender();

	broadcast(ctx.cwd, {
		type: "dispatch:complete",
		sessionId,
		sessionName,
		message: `${merged}/${mergeResults.length} merged`,
	});
}

function buildAgentTaskPrompt(todo: TodoInfo, wt: WorktreeInfo): string {
	const bodySection = todo.body ? `\n\n## Details\n${todo.body}` : "";
	return `You are working in an isolated git worktree on branch "${wt.branch}".

## Task
TODO-${todo.id}: ${todo.title}${bodySection}

## Important
- Make ALL changes needed to complete this task
- Ensure the code compiles (run the build if there's a build script)
- Remove any TODO/FIXME/HACK/WIP comments that you've addressed
- Do NOT commit — the orchestrator handles commits
- Do NOT touch files outside the scope of this task

When done, output:
## Completed
What was done.

## Files Changed
- \`path/to/file\` - what changed
`;
}

function buildSubagentMessage(tasks: { agent: string; task: string; cwd: string }[]): string {
	if (tasks.length === 1) {
		const t = tasks[0];
		return `Use the subagent tool to run this task:

Agent: ${t.agent}
Working directory: ${t.cwd}
Task: ${t.task}`;
	}

	const taskList = tasks.map((t, i) =>
		`${i + 1}. Agent: ${t.agent}, cwd: "${t.cwd}"\n   Task: ${t.task}`
	).join("\n\n");

	return `Use the subagent tool in PARALLEL mode to run these ${tasks.length} tasks simultaneously:

${taskList}

Each task has its own working directory (a git worktree). Run them all in parallel.`;
}

// ─── Parse /scan arguments ──────────────────────────────────────────────────

interface ScanArgs {
	path?: string;
	dispatch: boolean;
	tags?: string[];
	changedOnly: boolean;
	sinceDays?: number;
}

function parseScanArgs(args: string): ScanArgs {
	const parts = args.trim().split(/\s+/);
	const result: ScanArgs = { dispatch: false, changedOnly: false };

	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p === "-d" || p === "--dispatch") {
			result.dispatch = true;
		} else if (p === "--changed") {
			result.changedOnly = true;
		} else if (p === "--tag" && parts[i + 1]) {
			result.tags = parts[++i].split(",").map((t) => t.trim());
		} else if (p === "--since" && parts[i + 1]) {
			const val = parts[++i];
			const match = val.match(/^(\d+)([dwm])$/);
			if (match) {
				const num = parseInt(match[1], 10);
				const unit = match[2];
				result.sinceDays = unit === "w" ? num * 7 : unit === "m" ? num * 30 : num;
			}
		} else if (!p.startsWith("-")) {
			result.path = p;
		}
	}

	return result;
}

// ─── Parse /dispatch arguments ──────────────────────────────────────────────

interface DispatchArgs {
	subcommand?: "status" | "merge" | "cleanup";
	todoIds: string[];
	all: boolean;
	agent: string;
}

function parseDispatchArgs(args: string): DispatchArgs {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const result: DispatchArgs = { todoIds: [], all: false, agent: "worker" };

	if (parts[0] === "status" || parts[0] === "merge" || parts[0] === "cleanup") {
		result.subcommand = parts[0] as DispatchArgs["subcommand"];
		return result;
	}

	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p === "all") {
			result.all = true;
		} else if ((p === "--agent" || p === "-a") && parts[i + 1]) {
			result.agent = parts[++i];
		} else if (p.match(/^(TODO-)?[a-f0-9]{8}$/i)) {
			const id = p.replace(/^TODO-/i, "").toLowerCase();
			result.todoIds.push(id);
		}
	}

	return result;
}

// ─── Extension Entry Point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let stopWatching: (() => void) | null = null;

	// Start broadcast watcher on session start
	pi.on("session_start", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		gcBroadcasts(ctx.cwd);

		stopWatching = watchBroadcasts(ctx.cwd, sessionId, (event) => {
			const msg = formatBroadcastEvent(event);
			ctx.ui.notify(`📢 ${msg}`, "info");
		});
	});

	pi.on("session_shutdown", async () => {
		if (stopWatching) {
			stopWatching();
			stopWatching = null;
		}
	});

	// ─── /scan ──────────────────────────────────────────────────────────────

	pi.registerCommand("scan", {
		description: "Scan codebase for TODO/FIXME/HACK/WIP markers, propose todos, optionally dispatch",
		handler: async (rawArgs, ctx) => {
			const args = parseScanArgs(rawArgs ?? "");

			// Phase 1: Scan
			const fileCount = await countFiles(ctx.cwd, args.path);
			ctx.ui.notify(`Scanning ${fileCount} files...`, "info");

			const markers = await scanMarkers(ctx.cwd, {
				path: args.path,
				tags: args.tags,
				changedOnly: args.changedOnly,
				sinceDays: args.sinceDays,
			});

			if (markers.length === 0) {
				ctx.ui.notify("No markers found ✓", "info");
				return;
			}

			// Count by type
			const counts = new Map<string, number>();
			for (const m of markers) {
				counts.set(m.type, (counts.get(m.type) || 0) + 1);
			}
			const countStr = Array.from(counts.entries()).map(([t, c]) => `${c} ${t}`).join(", ");
			ctx.ui.notify(`Found ${markers.length} markers (${countStr})`, "info");

			// Phase 2: Group via LLM
			let proposals: ProposedTodo[];

			const proposalResult = await ctx.ui.custom<ProposedTodo[] | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Analyzing and grouping markers...");
				loader.onAbort = () => done(null);

				groupMarkers(ctx.cwd, markers, (msg) => {
					// update status
				}, loader.signal)
					.then((result) => done(result))
					.catch(() => done(null));

				return loader;
			});

			if (!proposalResult || proposalResult.length === 0) {
				ctx.ui.notify("No proposals generated", "info");
				return;
			}
			proposals = proposalResult;

			// Phase 3: Show proposals for selection
			if (args.dispatch) {
				// Auto-select low and medium risk
				const autoSelected = proposals
					.filter((p) => p.risk !== "high")
					.map((p) => p.title);

				// Create todos
				const createdIds = await createTodosFromProposals(
					ctx,
					proposals.filter((p) => autoSelected.includes(p.title)),
				);

				if (createdIds.length === 0) {
					ctx.ui.notify("No todos created", "info");
					return;
				}

				// Log skipped high-risk items
				const skipped = proposals.filter((p) => p.risk === "high");
				if (skipped.length > 0) {
					ctx.ui.notify(`Skipped ${skipped.length} high-risk item(s) — review manually`, "warning");
				}

				// Dispatch
				const progress = new DispatchProgress(ctx.ui.theme);
				ctx.ui.setWidget("dispatch-progress", (_tui, _theme) => ({
					render: (w: number) => progress.render(w),
					invalidate: () => {},
				}));

				await runDispatch(ctx, createdIds, "worker", progress, () => {
					// Force widget re-render
					ctx.ui.setWidget("dispatch-progress", (_tui, _theme) => ({
						render: (w: number) => progress.render(w),
						invalidate: () => {},
					}));
				});

				ctx.ui.setWidget("dispatch-progress", undefined);
				return;
			}

			// Interactive mode: show checkbox selector
			const selectedTitles = await ctx.ui.custom<string[] | null>((tui, theme, _kb, done) => {
				const items = proposals.map((p) => {
					const markerRefs = p.markers.map((m) => `${m.type} ${m.file}:${m.line}`).join(" • ");
					return {
						label: `${p.title}`,
						sublabel: markerRefs,
						detail: `${p.risk} risk • ${p.files.length} file(s) • ${p.complexity}`,
						value: p.title,
						checked: p.risk !== "high",
					};
				});

				return new CheckboxSelector(
					theme,
					"Proposed Todos",
					items,
					"Space toggle • a all • Enter create todos • d create & dispatch • Esc cancel",
					(selected) => done(selected),
					() => done(null),
				);
			});

			if (!selectedTitles || selectedTitles.length === 0) return;

			const selectedProposals = proposals.filter((p) => selectedTitles.includes(p.title));
			const createdIds = await createTodosFromProposals(ctx, selectedProposals);

			if (createdIds.length > 0) {
				ctx.ui.notify(`Created ${createdIds.length} todo(s)`, "info");

				const shouldDispatch = await ctx.ui.confirm(
					"Dispatch now?",
					`Dispatch ${createdIds.length} todos to parallel agents?`,
				);

				if (shouldDispatch) {
					const progress = new DispatchProgress(ctx.ui.theme);
					ctx.ui.setWidget("dispatch-progress", (_tui, _theme) => ({
						render: (w: number) => progress.render(w),
						invalidate: () => {},
					}));

					await runDispatch(ctx, createdIds, "worker", progress, () => {
						ctx.ui.setWidget("dispatch-progress", (_tui, _theme) => ({
							render: (w: number) => progress.render(w),
							invalidate: () => {},
						}));
					});

					ctx.ui.setWidget("dispatch-progress", undefined);
				}
			}
		},
	});

	// ─── /dispatch ──────────────────────────────────────────────────────────

	pi.registerCommand("dispatch", {
		description: "Dispatch todos to parallel agents via git worktrees",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["status", "merge", "cleanup", "all"];
			const matches = subcommands.filter((s) => s.startsWith(prefix.toLowerCase()));
			if (matches.length > 0) {
				return matches.map((s) => ({ value: s, label: s }));
			}
			return null;
		},
		handler: async (rawArgs, ctx) => {
			const args = parseDispatchArgs(rawArgs ?? "");

			if (args.subcommand === "status") {
				const worktrees = await listWorktrees(ctx.cwd);
				if (worktrees.length === 0) {
					ctx.ui.notify("No active worktrees", "info");
					return;
				}
				const lines = worktrees.map((wt) =>
					`  TODO-${wt.todoId}  ${wt.branch}  ${wt.worktreePath}`
				);
				ctx.ui.notify(`Active worktrees:\n${lines.join("\n")}`, "info");
				return;
			}

			if (args.subcommand === "cleanup") {
				const cleaned = await cleanupAllWorktrees(ctx.cwd);
				ctx.ui.notify(cleaned.length > 0
					? `Cleaned up ${cleaned.length} worktree(s): ${cleaned.join(", ")}`
					: "No worktrees to clean up",
					"info",
				);
				return;
			}

			if (args.subcommand === "merge") {
				ctx.ui.notify("Use /dispatch to re-run merge on existing branches", "info");
				return;
			}

			// Main dispatch flow
			let todoIds = args.todoIds;

			if (args.all) {
				const todos = await listOpenTodos(ctx);
				todoIds = todos.filter((t) => !t.status.includes("claimed")).map((t) => t.id);
			}

			if (todoIds.length === 0) {
				// Interactive: show todo picker
				const todos = await listOpenTodos(ctx);
				if (todos.length === 0) {
					ctx.ui.notify("No open todos. Use /scan to find work.", "info");
					return;
				}

				const selected = await ctx.ui.custom<string[] | null>((tui, theme, _kb, done) => {
					const items = todos.map((t) => ({
						label: t.title || "(untitled)",
						sublabel: t.tags.length > 0 ? t.tags.join(", ") : "",
						detail: `TODO-${t.id} • ${t.status}`,
						value: t.id,
						checked: true,
					}));

					return new CheckboxSelector(
						theme,
						"Dispatch Todos",
						items,
						`Space toggle • a all • Enter dispatch • Agent: ${args.agent} • Esc cancel`,
						(sel) => done(sel),
						() => done(null),
					);
				});

				if (!selected || selected.length === 0) return;
				todoIds = selected;
			}

			// Run dispatch
			const progress = new DispatchProgress(ctx.ui.theme);
			ctx.ui.setWidget("dispatch-progress", (_tui, _theme) => ({
				render: (w: number) => progress.render(w),
				invalidate: () => {},
			}));

			await runDispatch(ctx, todoIds, args.agent, progress, () => {
				ctx.ui.setWidget("dispatch-progress", (_tui, _theme) => ({
					render: (w: number) => progress.render(w),
					invalidate: () => {},
				}));
			});

			ctx.ui.setWidget("dispatch-progress", undefined);
		},
	});

	// ─── /sessions ──────────────────────────────────────────────────────────

	pi.registerCommand("sessions", {
		description: "Show live sessions and recent broadcasts",
		handler: async (_args, ctx) => {
			const broadcasts = readBroadcasts(ctx.cwd);

			// Extract unique sessions from broadcasts
			const sessionMap = new Map<string, { id: string; name?: string; status: string }>();
			for (const event of broadcasts) {
				sessionMap.set(event.sessionId, {
					id: event.sessionId,
					name: event.sessionName,
					status: event.type.includes("started") ? "working" : "idle",
				});
			}
			const sessions = Array.from(sessionMap.values());

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				return new SessionsDisplay(theme, sessions, broadcasts, () => done());
			});
		},
	});

	// ─── /broadcast ─────────────────────────────────────────────────────────

	pi.registerCommand("broadcast", {
		description: "Send a message to all other sessions",
		handler: async (rawArgs, ctx) => {
			const msg = (rawArgs ?? "").trim();
			if (!msg) {
				ctx.ui.notify("Usage: /broadcast <message>", "error");
				return;
			}

			const sessionId = ctx.sessionManager.getSessionId();
			const sessionName = ctx.sessionManager.getSessionName() ?? undefined;

			broadcast(ctx.cwd, {
				type: "message",
				sessionId,
				sessionName,
				message: msg,
			});

			ctx.ui.notify("Broadcast sent ✓", "info");
		},
	});
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function createTodosFromProposals(
	ctx: ExtensionCommandContext,
	proposals: ProposedTodo[],
): Promise<string[]> {
	const ids: string[] = [];
	const fs = await import("node:fs");
	const path = await import("node:path");
	const crypto = await import("node:crypto");

	const todosDir = path.resolve(ctx.cwd, ".pi/todos");
	fs.mkdirSync(todosDir, { recursive: true });

	for (const proposal of proposals) {
		const id = crypto.randomBytes(4).toString("hex");

		// Build body with source markers
		let body = `## Task\n${proposal.title}\n\n`;
		body += `## Source markers\n`;
		for (const marker of proposal.markers) {
			body += `- \`${marker.file}:${marker.line}\` — ${marker.text}\n`;
		}
		if (proposal.body) {
			body += `\n${proposal.body}`;
		}

		const frontMatter = JSON.stringify({
			id,
			title: proposal.title,
			tags: proposal.tags,
			status: "open",
			created_at: new Date().toISOString(),
		}, null, 2);

		const content = `${frontMatter}\n\n${body}\n`;
		fs.writeFileSync(path.join(todosDir, `${id}.md`), content, "utf8");
		ids.push(id);
	}

	return ids;
}
