#!/usr/bin/env node
/**
 * Paid end-to-end smoke test for the model chooser + subagent extension.
 *
 * Usage:
 *   node personal/model-chooser/smoke-test.ts [provider/model]
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const parentModel = process.argv[2] ?? "github-copilot/gpt-5.6-sol";
const expectedHeading = "# Pi Workflows";
const configuredTimeout = Number(process.env.PI_SMOKE_TIMEOUT_MS ?? 10 * 60 * 1000);
const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 10 * 60 * 1000;
if (!fs.existsSync(path.join(process.cwd(), "README.md"))) {
	console.error("Run this smoke test from the agent-harnesses repository root.");
	process.exit(1);
}
const prompt = `Call the subagent tool exactly once in parallel mode with these two read-only tasks and no others:

1. agent scout, policy quality, task "QUALITY_SMOKE: Read README.md and return only its first H1 markdown heading."
2. agent scout, policy cost, task "COST_SMOKE: Read README.md and return only its first H1 markdown heading."

Use thinkingLevel auto, agentScope user, and isolation none. Do not read README.md yourself. After the tool returns, state only whether both tasks succeeded.`;

interface SmokeResult {
	task?: string;
	model?: string;
	modelNote?: string;
	exitCode?: number;
	messages?: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
}

function finalText(result: SmokeResult): string {
	for (let index = (result.messages?.length ?? 0) - 1; index >= 0; index -= 1) {
		const message = result.messages?.[index];
		if (message?.role !== "assistant") continue;
		const text = message.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("") ?? "";
		if (text) return text;
	}
	return "";
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	if (process.env.PI_SMOKE_COMMAND) return { command: process.env.PI_SMOKE_COMMAND, args };
	if (process.platform === "win32") {
		const cli = path.join(path.dirname(process.execPath), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
		if (fs.existsSync(cli)) return { command: process.execPath, args: [cli, ...args] };
		throw new Error("Could not locate Pi's cli.js; set PI_SMOKE_COMMAND to an executable Pi command");
	}
	return { command: "pi", args };
}

const invocation = piInvocation([
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		parentModel,
		"--thinking",
		"low",
		prompt,
	]);
const child = spawn(invocation.command, invocation.args, {
	cwd: process.cwd(),
	shell: false,
	stdio: ["ignore", "pipe", "pipe"],
});
const timeout = setTimeout(() => {
	console.error(`Smoke test timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
	child.kill("SIGTERM");
	setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
}, timeoutMs);
timeout.unref?.();

let stdout = "";
let stderr = "";
let toolResult: { details?: { results?: SmokeResult[] }; isError?: boolean } | undefined;

function processLine(line: string): void {
	if (!line.trim()) return;
	try {
		const event = JSON.parse(line) as {
			type?: string;
			toolName?: string;
			result?: { details?: { results?: SmokeResult[] } };
			isError?: boolean;
		};
		if (event.type === "tool_execution_end" && event.toolName === "subagent") {
			toolResult = { details: event.result?.details, isError: event.isError };
		}
	} catch {
		// Pi JSON mode writes one JSON object per line; ignore non-protocol noise.
	}
}

child.stdout.on("data", (chunk) => {
	stdout += chunk.toString();
	const lines = stdout.split("\n");
	stdout = lines.pop() ?? "";
	for (const line of lines) processLine(line);
});
child.stderr.on("data", (chunk) => {
	stderr += chunk.toString();
});
child.on("error", (error) => {
	console.error(`Could not start Pi: ${error.message}`);
	process.exitCode = 1;
});
child.on("close", (code) => {
	clearTimeout(timeout);
	if (stdout.trim()) processLine(stdout);
	if (code !== 0 || !toolResult) {
		console.error(stderr.trim() || `Pi exited with code ${code ?? "unknown"} before returning a subagent result.`);
		process.exitCode = 1;
		return;
	}

	const results = toolResult.details?.results ?? [];
	const quality = results.find((result) => result.task?.startsWith("QUALITY_SMOKE:"));
	const cost = results.find((result) => result.task?.startsWith("COST_SMOKE:"));
	const failures: string[] = [];
	for (const [policy, result] of [["quality", quality], ["cost", cost]] as const) {
		if (!result) {
			failures.push(`${policy}: missing result`);
			continue;
		}
		if (result.exitCode !== 0) failures.push(`${policy}: child exit ${result.exitCode}`);
		if (!result.modelNote?.includes(`chooser: ${policy}`)) failures.push(`${policy}: missing chooser note`);
		if (!finalText(result).includes(expectedHeading)) failures.push(`${policy}: wrong synthetic-task output`);
	}
	if (quality?.model?.toLowerCase() !== parentModel.toLowerCase())
		failures.push(`quality: expected inherited ${parentModel}, got ${quality?.model}`);
	// The default parent is intentionally not the cheapest model; an override
	// must preserve that condition for this divergence assertion to be meaningful.
	if (cost?.model === quality?.model) failures.push("policies did not diverge: cost reused the quality model");
	if (toolResult.isError) failures.push("subagent tool reported an error");

	console.log("Policy   Model                                  Selection");
	console.log(`quality  ${(quality?.model ?? "(missing)").padEnd(38)} ${quality?.modelNote ?? ""}`);
	console.log(`cost     ${(cost?.model ?? "(missing)").padEnd(38)} ${cost?.modelNote ?? ""}`);
	if (failures.length > 0) {
		console.error(`\nFAIL\n- ${failures.join("\n- ")}`);
		process.exitCode = 1;
		return;
	}
	console.log(`\nPASS: both children read README.md and returned ${JSON.stringify(expectedHeading)}.`);
});
