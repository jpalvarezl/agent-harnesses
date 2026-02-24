/**
 * Code scanner — finds TODO/FIXME/HACK/WIP/XXX markers and groups them
 * into actionable work items via LLM analysis.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { exec as execCb } from "node:child_process";
import { spawn } from "node:child_process";

const MARKER_PATTERN = /\b(TODO|FIXME|HACK|WIP|XXX|NOTE\(fix\))\b/i;
const CONTEXT_LINES = 5;
const SKIP_INDEX_FILE = ".pi/extensions/skip_index.txt";

/** Read skip_index.txt and return normalized directory paths to exclude */
function loadSkipPaths(cwd: string): string[] {
	const skipFile = path.resolve(cwd, SKIP_INDEX_FILE);
	try {
		const content = fs.readFileSync(skipFile, "utf8");
		return content
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith("#"))
			.map((l) => l.replace(/\/+$/, "")); // strip trailing slashes
	} catch {
		return [];
	}
}

/** Check whether a file path (relative to project root) falls under a skipped directory */
function isSkipped(filePath: string, skipPaths: string[]): boolean {
	for (const skip of skipPaths) {
		if (filePath === skip || filePath.startsWith(skip + "/")) return true;
	}
	return false;
}

export interface CodeMarker {
	type: string;
	file: string;
	line: number;
	text: string;
	context: string;
}

export interface ProposedTodo {
	title: string;
	markers: CodeMarker[];
	risk: "low" | "medium" | "high";
	complexity: "trivial" | "simple" | "moderate" | "complex";
	files: string[];
	body: string;
	tags: string[];
}

function run(cmd: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		execCb(cmd, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
			resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "", code: error?.code ?? 0 });
		});
	});
}

/** Scan for code markers using ripgrep (falls back to grep) */
export async function scanMarkers(cwd: string, options?: {
	path?: string;
	tags?: string[];
	changedOnly?: boolean;
	sinceDays?: number;
}): Promise<CodeMarker[]> {
	const searchPath = options?.path || ".";
	const skipPaths = loadSkipPaths(cwd);
	let files: string[] | null = null;

	// If --changed, only scan files with uncommitted changes
	if (options?.changedOnly) {
		const { stdout } = await run("git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached 2>/dev/null", cwd);
		files = [...new Set(stdout.trim().split("\n").filter(Boolean))];
		if (files.length === 0) return [];
	}

	// If --since, only scan recently changed files
	if (options?.sinceDays) {
		const { stdout } = await run(`git log --since="${options.sinceDays} days ago" --name-only --pretty=format: | sort -u`, cwd);
		const recentFiles = stdout.trim().split("\n").filter(Boolean);
		if (files) {
			files = files.filter((f) => recentFiles.includes(f));
		} else {
			files = recentFiles;
		}
		if (files.length === 0) return [];
	}

	// Apply skip_index filtering to explicit file lists
	if (files) {
		files = files.filter((f) => !isSkipped(f, skipPaths));
		if (files.length === 0) return [];
	}

	// Build the pattern for ripgrep
	const tags = options?.tags?.map((t) => t.toUpperCase()) || ["TODO", "FIXME", "HACK", "WIP", "XXX"];
	const pattern = `\\b(${tags.join("|")})\\b`;

	// Build glob exclusions from skip_index + hardcoded defaults
	const defaultSkips = ["node_modules", ".git", "*.lock", "*.md"];
	const allSkips = [...new Set([...defaultSkips, ...skipPaths])];
	const rgGlobs = allSkips.map((s) => `--glob '!${s}'`).join(" ");
	const grepExcludes = allSkips
		.filter((s) => !s.startsWith("*"))
		.map((s) => `--exclude-dir=${s}`).join(" ");
	const grepExcludeFiles = allSkips
		.filter((s) => s.startsWith("*"))
		.map((s) => `--exclude='${s}'`).join(" ");

	let cmd: string;
	if (files && files.length > 0) {
		// Scan specific files
		const fileList = files.join("\n");
		cmd = `echo "${fileList}" | xargs rg -n -i "${pattern}" 2>/dev/null || echo "${fileList}" | xargs grep -rn -i -E "${pattern}" 2>/dev/null`;
	} else {
		// Scan directory
		cmd = `rg -n -i "${pattern}" "${searchPath}" ${rgGlobs} 2>/dev/null || grep -rn -i -E "${pattern}" "${searchPath}" ${grepExcludes} ${grepExcludeFiles} 2>/dev/null`;
	}

	const { stdout } = await run(cmd, cwd);
	const markers: CodeMarker[] = [];

	for (const line of stdout.trim().split("\n")) {
		if (!line.trim()) continue;

		// Parse rg/grep output: file:line:content
		const match = line.match(/^(.+?):(\d+):(.+)$/);
		if (!match) continue;

		const [, file, lineNum, text] = match;
		const markerMatch = text.match(MARKER_PATTERN);
		if (!markerMatch) continue;

		// Post-scan safety: skip files under excluded directories
		const relFile = file.startsWith("./") ? file.slice(2) : file;
		if (isSkipped(relFile, skipPaths)) continue;

		// Get context around the marker
		const context = await getContext(cwd, file, parseInt(lineNum, 10));

		markers.push({
			type: markerMatch[1].toUpperCase(),
			file,
			line: parseInt(lineNum, 10),
			text: text.trim(),
			context,
		});
	}

	return markers;
}

async function getContext(cwd: string, file: string, line: number): Promise<string> {
	const startLine = Math.max(1, line - CONTEXT_LINES);
	const endLine = line + CONTEXT_LINES;

	try {
		const fullPath = path.resolve(cwd, file);
		const content = fs.readFileSync(fullPath, "utf8");
		const lines = content.split("\n");
		const contextLines = lines.slice(startLine - 1, endLine);
		return contextLines.map((l, i) => {
			const lineNum = startLine + i;
			const marker = lineNum === line ? "→" : " ";
			return `${marker} ${lineNum}: ${l}`;
		}).join("\n");
	} catch {
		return "";
	}
}

/** Group markers into proposed todos using LLM */
export async function groupMarkers(
	cwd: string,
	markers: CodeMarker[],
	onStatus?: (msg: string) => void,
	signal?: AbortSignal,
): Promise<ProposedTodo[]> {
	if (markers.length === 0) return [];

	onStatus?.("Analyzing and grouping markers...");

	const markersText = markers.map((m, i) =>
		`${i + 1}. ${m.file}:${m.line}\n   ${m.text}\n   Context:\n${m.context}\n`
	).join("\n");

	const prompt = `You are analyzing code markers (TODO/FIXME/HACK/WIP/XXX) from a codebase.

## Markers found

${markersText}

## Instructions

Group related markers into actionable work items. Return valid JSON array only, no markdown fences.

Each item must have this exact shape:
{
  "title": "Imperative action title (Add..., Fix..., Replace...)",
  "markerIndices": [1, 2, 3],
  "risk": "low" | "medium" | "high",
  "complexity": "trivial" | "simple" | "moderate" | "complex",
  "files": ["path/to/file1.swift", "path/to/file2.swift"],
  "tags": ["tag1", "tag2"],
  "body": "Detailed markdown description:\\n- What's wrong\\n- What the fix should look like\\n- Code context"
}

Rules:
- Markers in the same file about the same concern → one group
- Related markers across files (e.g., "retry" in 3 places) → one group
- Unrelated markers in the same file → separate groups
- A single marker can be its own group
- Don't group more than 5 files into one todo
- Risk: low = no API/concurrency changes; medium = structural changes; high = safety/threading
- Tags should be short area identifiers like "agent-loop", "plugins", "audio", "testing"

Return ONLY the JSON array.`;

	const result = await llmCall(cwd, prompt, signal);

	try {
		// Extract JSON from response (handle potential markdown fences)
		let jsonStr = result.trim();
		if (jsonStr.startsWith("```")) {
			jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
		}

		const grouped = JSON.parse(jsonStr) as Array<{
			title: string;
			markerIndices: number[];
			risk: string;
			complexity: string;
			files: string[];
			tags: string[];
			body: string;
		}>;

		return grouped.map((g) => ({
			title: g.title,
			markers: g.markerIndices
				.map((idx) => markers[idx - 1])
				.filter(Boolean),
			risk: (g.risk || "medium") as ProposedTodo["risk"],
			complexity: (g.complexity || "moderate") as ProposedTodo["complexity"],
			files: g.files || [],
			body: g.body || "",
			tags: g.tags || [],
		}));
	} catch {
		// Fallback: one todo per marker
		return markers.map((m) => ({
			title: `Fix ${m.type} in ${m.file}:${m.line}`,
			markers: [m],
			risk: "low" as const,
			complexity: "simple" as const,
			files: [m.file],
			body: `${m.text}\n\n\`\`\`\n${m.context}\n\`\`\``,
			tags: [m.type.toLowerCase()],
		}));
	}
}

async function llmCall(cwd: string, prompt: string, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const args = ["--mode", "json", "-p", "--no-session", "-"];
		const proc = spawn("pi", args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";

		proc.stdout.on("data", (data) => { stdout += data.toString(); });

		// Pipe the prompt via stdin to avoid ARG_MAX limits
		proc.stdin.write(prompt);
		proc.stdin.end();

		proc.on("close", () => {
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
					// skip
				}
			}
			resolve(text || stdout);
		});
		proc.on("error", reject);

		if (signal) {
			const kill = () => proc.kill("SIGTERM");
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});
}

/** Count files scanned (for progress) */
export async function countFiles(cwd: string, searchPath?: string): Promise<number> {
	const sp = searchPath || ".";
	const skipPaths = loadSkipPaths(cwd);
	const defaultSkips = ["node_modules", ".git"];
	const allSkips = [...new Set([...defaultSkips, ...skipPaths])];
	const pruneArgs = allSkips.map((s) => `-not -path "*/${s}/*"`).join(" ");
	const { stdout } = await run(
		`find "${sp}" -type f \\( -name "*.swift" -o -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.rs" -o -name "*.go" -o -name "*.c" -o -name "*.cpp" -o -name "*.h" -o -name "*.java" -o -name "*.kt" -o -name "*.rb" \\) ${pruneArgs} 2>/dev/null | wc -l`,
		cwd,
	);
	return parseInt(stdout.trim(), 10) || 0;
}
