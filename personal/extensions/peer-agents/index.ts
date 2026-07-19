import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { selectPeerModel, type ModelReference } from "./model-selection.ts";

const MAX_REVIEW_BYTES = 200 * 1024;
const MAX_STDERR_BYTES = 20 * 1024;

interface ChildResult {
  output: string;
  model: ModelReference;
  stderr: string;
  turns: number;
}

interface ReviewSnapshot {
  root: string;
  baseLabel: string;
  baseCommit: string;
  status: string;
  stat: string;
  diff: string;
  truncated: boolean;
}

const RUBBER_DUCK_PROMPT = `You are a rigorous but collaborative rubber-duck partner.
Your job is to help another coding agent think, not to take over implementation.

Interrogate assumptions, identify missing constraints, propose alternatives, and surface risks. Prefer a short dialogue-style response with incisive questions followed by your independent assessment. Ground feedback in repository files when useful. Do not modify files.

Output:
## Questions
- The most useful questions the originating agent should answer

## Assessment
Your independent analysis

## Alternatives
Only materially different options, with tradeoffs

## Recommendation
A concrete next step.`;

const CODE_REVIEW_PROMPT = `You are a senior code reviewer operating independently from the implementation agent. Review only; never modify files.

Prioritize correctness, regressions, security, concurrency, data loss, compatibility, and missing tests. Do not spend space on subjective style unless it creates a maintenance or correctness risk. Verify findings against repository files before reporting them. A finding must be actionable and include a file and line when possible. If no substantive issues exist, say so clearly.

Output:
## Critical
Must-fix defects, or "None".

## Warnings
Likely defects or important missing coverage, or "None".

## Suggestions
Optional improvements; keep brief.

## Verdict
One of: BLOCK, REVISE, or APPROVE, followed by a concise rationale.`;

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const executable = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

function capText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { text: value, truncated: false };

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = maxBytes;
  while (end > 0) {
    try {
      return { text: decoder.decode(bytes.subarray(0, end)), truncated: true };
    } catch {
      // A UTF-8 code point straddles the boundary; at most three bytes need removal.
      end -= 1;
    }
  }
  return { text: "", truncated: true };
}

function modelSpec(model: ModelReference): string {
  return `${model.provider}/${model.id}`;
}

function choosePeerModel(ctx: ExtensionContext): ModelReference {
  const available = ctx.modelRegistry.getAvailable();
  const selected = selectPeerModel(ctx.model, available);
  if (!selected) {
    throw new Error(
      "No authenticated model from the opposite GPT/Claude family is available. Run /login or configure another provider.",
    );
  }
  return selected;
}

async function runPeer(
  ctx: ExtensionContext,
  model: ModelReference,
  systemPrompt: string,
  task: string,
  signal: AbortSignal | undefined,
  onStatus?: (message: string) => void,
): Promise<ChildResult> {
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--model",
    modelSpec(model),
    "--thinking",
    "high",
    "--tools",
    "read,grep,find,ls",
    "--system-prompt",
    systemPrompt,
  ];
  const invocation = getPiInvocation(args);

  return await new Promise<ChildResult>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: ctx.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let stderr = "";
    let finalOutput = "";
    let modelError: string | undefined;
    let turns = 0;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abort);
      callback();
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      if (event.type === "tool_execution_start") {
        onStatus?.(`Peer reading with ${event.toolName}…`);
      }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        turns += 1;
        const text = (event.message.content ?? [])
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text)
          .join("");
        if (text) finalOutput = text;
        if (event.message.stopReason === "error") {
          modelError = event.message.errorMessage ?? "Peer model returned an error";
          stderr += `\n${modelError}`;
        }
      }
    };

    const abort = () => {
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });
    child.stderr.on("data", (chunk) => {
      stderr = capText(stderr + chunk.toString(), MAX_STDERR_BYTES).text;
    });
    child.stdin.on("error", (error) => {
      // The child may exit before consuming the prompt; let the close handler report it.
      stderr = capText(`${stderr}\n${error.message}`, MAX_STDERR_BYTES).text;
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      if (stdoutBuffer.trim()) processLine(stdoutBuffer);
      finish(() => {
        if (signal?.aborted) {
          reject(new Error("Peer agent was aborted"));
        } else if (modelError) {
          reject(new Error(modelError));
        } else if (code !== 0 || !finalOutput) {
          reject(new Error(stderr.trim() || `Peer agent exited with code ${code ?? "unknown"}`));
        } else {
          resolve({ output: finalOutput, model, stderr, turns });
        }
      });
    });

    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    child.stdin.end(task);
  });
}

async function execGit(pi: ExtensionAPI, cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await pi.exec("git", args, { cwd, signal });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trimEnd();
}

async function refExists(pi: ExtensionAPI, cwd: string, ref: string, signal?: AbortSignal): Promise<boolean> {
  const result = await pi.exec("git", ["rev-parse", "--verify", "--quiet", ref], { cwd, signal });
  return result.code === 0;
}

async function resolveBase(
  pi: ExtensionAPI,
  cwd: string,
  requested: string | undefined,
  signal?: AbortSignal,
): Promise<{ label: string; commit: string }> {
  let label = requested?.trim();
  if (!label) {
    const originHead = await pi.exec("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
      cwd,
      signal,
    });
    if (originHead.code === 0 && originHead.stdout.trim()) label = originHead.stdout.trim();
  }

  for (const fallback of ["origin/main", "main", "origin/master", "master"]) {
    if (!label && (await refExists(pi, cwd, fallback, signal))) label = fallback;
  }
  label ??= "HEAD";

  if (label === "HEAD") return { label, commit: "HEAD" };
  const mergeBase = await execGit(pi, cwd, ["merge-base", "HEAD", label], signal);
  if (!mergeBase) throw new Error(`Could not determine merge base with ${label}`);
  return { label, commit: mergeBase };
}

async function createReviewSnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  base: string | undefined,
  signal?: AbortSignal,
): Promise<ReviewSnapshot> {
  const root = await execGit(pi, ctx.cwd, ["rev-parse", "--show-toplevel"], signal);
  const resolved = await resolveBase(pi, root, base, signal);
  const status = await execGit(pi, root, ["status", "--short", "--untracked-files=all"], signal);
  const stat = await execGit(pi, root, ["diff", "--stat", resolved.commit], signal);
  const rawDiff = await execGit(
    pi,
    root,
    ["diff", "--no-ext-diff", "--find-renames", "--find-copies", "--unified=40", resolved.commit],
    signal,
  );
  const capped = capText(rawDiff, MAX_REVIEW_BYTES);

  if (!status && !rawDiff) {
    throw new Error(`No changes found relative to ${resolved.label} (${resolved.commit.slice(0, 12)})`);
  }

  return {
    root,
    baseLabel: resolved.label,
    baseCommit: resolved.commit,
    status: status || "(clean status; committed branch changes only)",
    stat: stat || "(no tracked-file stat)",
    diff: capped.text || "(no tracked diff; inspect untracked files listed in status)",
    truncated: capped.truncated,
  };
}

export default function peerAgents(pi: ExtensionAPI) {
  pi.registerTool({
    name: "rubber_duck",
    label: "Rubber Duck",
    description:
      "Ask an independent peer model from the opposite GPT/Claude family to challenge an idea or design. The peer is read-only and returns questions, tradeoffs, and a recommendation.",
    promptSnippet: "Get a critical second opinion from a different model family",
    promptGuidelines: [
      "Use rubber_duck when the user asks for a second opinion, when a nontrivial design has competing approaches, or when reasoning is stuck.",
      "Independent rubber_duck calls in the same assistant turn run concurrently and are appropriate when several ideas can be evaluated in parallel.",
    ],
    parameters: Type.Object({
      idea: Type.String({ description: "The idea, design, decision, or reasoning to examine" }),
      question: Type.Optional(Type.String({ description: "A specific uncertainty for the peer to focus on" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const model = choosePeerModel(ctx);
      onUpdate?.({
        content: [{ type: "text", text: `Consulting ${modelSpec(model)}…` }],
        details: { model },
      });
      const task = [
        "A coding agent wants to bounce the following idea off you.",
        `\n## Idea\n${params.idea}`,
        params.question ? `\n## Focus question\n${params.question}` : "",
        `\nThe originating agent is using ${ctx.model ? modelSpec(ctx.model) : "an unknown model"}; provide a genuinely independent perspective.`,
      ].join("\n");
      const result = await runPeer(ctx, model, RUBBER_DUCK_PROMPT, task, signal, (message) => {
        onUpdate?.({ content: [{ type: "text", text: message }], details: { model } });
      });
      return {
        content: [{ type: "text", text: `Peer model: ${modelSpec(model)}\n\n${result.output}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "code_review",
    label: "Code Review",
    description:
      "Dispatch an independent read-only peer agent to review the complete local diff, including committed branch changes and working-tree changes. Use before push/PR creation and whenever the user requests review.",
    promptSnippet: "Review the local git diff with an independent model family",
    promptGuidelines: [
      "Use code_review after substantive code changes and before running git push or gh pr create; address BLOCK or REVISE findings before pushing.",
      "Use code_review whenever the user requests review of local changes. The review agent is read-only and must not replace running the relevant tests.",
    ],
    parameters: Type.Object({
      base: Type.Optional(
        Type.String({ description: "Base ref for the review, such as origin/main. Defaults to origin/HEAD, main, or master." }),
      ),
      focus: Type.Optional(Type.String({ description: "Optional review focus, such as concurrency, API compatibility, or tests" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Capturing local diff…" }], details: {} });
      const snapshot = await createReviewSnapshot(pi, ctx, params.base, signal);
      const model = choosePeerModel(ctx);
      onUpdate?.({
        content: [{ type: "text", text: `Reviewing with ${modelSpec(model)}…` }],
        details: { model, base: snapshot.baseLabel },
      });

      const truncationNote = snapshot.truncated
        ? "\nThe inline diff was truncated at 200 KiB. Use read/grep/find/ls to inspect all changed files identified by status and diff stat before reaching a verdict."
        : "";
      const task = `Review the repository changes below.

Repository: ${snapshot.root}
Base: ${snapshot.baseLabel}
Merge-base commit: ${snapshot.baseCommit}
${params.focus ? `Focus: ${params.focus}\n` : ""}
## Git status
\`\`\`
${snapshot.status}
\`\`\`

## Diff stat
\`\`\`
${snapshot.stat}
\`\`\`

## Diff
\`\`\`diff
${snapshot.diff}
\`\`\`${truncationNote}

Check the surrounding implementation and tests with read-only tools. Report only findings introduced by or relevant to this change set.`;
      const result = await runPeer(ctx, model, CODE_REVIEW_PROMPT, task, signal, (message) => {
        onUpdate?.({
          content: [{ type: "text", text: message }],
          details: { model, base: snapshot.baseLabel },
        });
      });
      return {
        content: [
          {
            type: "text",
            text: `Review model: ${modelSpec(model)}\nBase: ${snapshot.baseLabel} (${snapshot.baseCommit.slice(0, 12)})\n\n${result.output}`,
          },
        ],
        details: { ...result, snapshot },
      };
    },
  });
}
