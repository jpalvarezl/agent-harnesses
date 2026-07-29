import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  type OptimizationPolicy,
  type SelectionDecision,
  type ThinkingLevel,
} from "../../model-chooser/index.ts";
import { getFreshChildCatalog } from "../../model-chooser/child-catalog.ts";
import {
  TOOL_POLICY_VALUES,
  TOOL_THINKING_VALUES,
  normalizeToolModel,
  normalizeToolPolicy,
  normalizeToolThinking,
} from "../../model-chooser/tool-options.ts";
import { adaptPiModels } from "../../model-chooser/pi-adapter.ts";
import { resolvePeerChoice, type PeerRole } from "./chooser-select.ts";
import {
  selectPeerModelWithFallback,
  type ModelReference,
  type PeerModelSelection,
} from "./model-selection.ts";
import { createReviewSnapshot, type GitRunner } from "./review-snapshot.ts";
import {
  AsyncSemaphore,
  capTailText,
  positiveIntegerFromEnv,
} from "./runtime-utils.ts";

const DEFAULT_PEER_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_STDERR_BYTES = 20 * 1024;

interface ChildResult {
  output: string;
  model: ModelReference;
  thinkingLevel: ThinkingLevel;
  stderr: string;
  turns: number;
}

interface SelectedPeer {
  selection: PeerModelSelection;
  thinkingLevel: ThinkingLevel;
  decision?: SelectionDecision;
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

function modelSpec(model: ModelReference): string {
  return `${model.provider}/${model.id}`;
}

function selectionLabel(selection: PeerModelSelection, decision?: SelectionDecision): string {
  return selection.crossFamily
    ? modelSpec(selection.model)
    : `${modelSpec(selection.model)} (${decision ? "same-family selection" : "same-family fallback"})`;
}

function sameFamilyNotice(selection: PeerModelSelection, decision?: SelectionDecision): string {
  if (selection.crossFamily) return "";
  return decision
    ? "\nModel selection: the requested chooser policy/override selected a same-family peer.\n"
    : "\nNote: no opposite-family model was authenticated; this used a different same-family model.\n";
}

async function choosePeerModel(
  ctx: ExtensionContext,
  role: PeerRole,
  options: { model?: string; policy?: OptimizationPolicy; thinkingLevel?: ThinkingLevel },
): Promise<SelectedPeer> {
  const available = ctx.modelRegistry.getAvailable();
  const chooserEnabled = options.model !== undefined || options.policy !== undefined || options.thinkingLevel !== undefined;
  if (!chooserEnabled) {
    const selection = selectPeerModelWithFallback(ctx.model, available);
    if (!selection) {
      throw new Error("No authenticated peer model is available. Run /login or configure another model.");
    }
    return { selection, thinkingLevel: "high" };
  }

  const childCatalog = await getFreshChildCatalog();
  const result = resolvePeerChoice({
    role,
    current: ctx.model,
    available,
    candidates: adaptPiModels(available, childCatalog),
    model: options.model,
    policy: options.policy,
    thinkingLevel: options.thinkingLevel,
  });
  if (!result.selection || !result.thinkingLevel) {
    throw new Error(result.error ?? "No eligible peer model is available");
  }
  return { selection: result.selection, thinkingLevel: result.thinkingLevel, decision: result.decision };
}

async function runPeer(
  ctx: ExtensionContext,
  model: ModelReference,
  thinkingLevel: ThinkingLevel,
  systemPrompt: string,
  task: string,
  signal: AbortSignal | undefined,
  options: {
    cwd?: string;
    timeoutMs: number;
    semaphore: AsyncSemaphore;
    onStatus?: (message: string) => void;
  },
): Promise<ChildResult> {
  const release = await options.semaphore.acquire(signal);
  try {
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
      thinkingLevel,
      "--tools",
      "read,grep,find,ls",
      "--system-prompt",
      systemPrompt,
    ];
    const invocation = getPiInvocation(args);

    return await new Promise<ChildResult>((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: options.cwd ?? ctx.cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdoutBuffer = "";
      let stderr = "";
      let finalOutput = "";
      let modelError: string | undefined;
      let turns = 0;
      let settled = false;
      let timedOut = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
      let executionTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (executionTimer) clearTimeout(executionTimer);
        signal?.removeEventListener("abort", terminate);
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
          options.onStatus?.(`Peer reading with ${event.toolName}…`);
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
            stderr = capTailText(`${stderr}\n${modelError}`, MAX_STDERR_BYTES).text;
          }
        }
      };

      const terminate = () => {
        child.kill("SIGTERM");
        if (!forceKillTimer) forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      };

      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      child.stderr.on("data", (chunk) => {
        stderr = capTailText(stderr + chunk.toString(), MAX_STDERR_BYTES).text;
      });
      child.stdin.on("error", (error) => {
        stderr = capTailText(`${stderr}\n${error.message}`, MAX_STDERR_BYTES).text;
      });
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (code) => {
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);
        finish(() => {
          if (timedOut) {
            reject(new Error(`Peer agent timed out after ${Math.round(options.timeoutMs / 1000)} seconds`));
          } else if (signal?.aborted) {
            reject(new Error("Peer agent was aborted"));
          } else if (modelError) {
            reject(new Error(modelError));
          } else if (code !== 0 || !finalOutput) {
            reject(new Error(stderr.trim() || `Peer agent exited with code ${code ?? "unknown"}`));
          } else {
            resolve({ output: finalOutput, model, thinkingLevel, stderr, turns });
          }
        });
      });

      executionTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeoutMs);
      if (signal?.aborted) terminate();
      else signal?.addEventListener("abort", terminate, { once: true });

      child.stdin.end(task);
    });
  } finally {
    release();
  }
}

const OptimizationPolicySchema = StringEnum(TOOL_POLICY_VALUES, {
  description: "Model selection mode. legacy preserves peer defaults; auto uses the peer role; other values optimize quality, speed, and/or cost.",
  default: "legacy",
});
const ThinkingLevelSchema = StringEnum(TOOL_THINKING_VALUES, {
  description: "Thinking selection. auto lets the chooser decide; other values require that exact level.",
  default: "auto",
});

export default function peerAgents(pi: ExtensionAPI) {
  const timeoutMs = positiveIntegerFromEnv(process.env.PI_PEER_AGENT_TIMEOUT_MS, DEFAULT_PEER_TIMEOUT_MS);
  const maxConcurrency = positiveIntegerFromEnv(
    process.env.PI_PEER_AGENT_MAX_CONCURRENCY,
    DEFAULT_MAX_CONCURRENCY,
  );
  const semaphore = new AsyncSemaphore(maxConcurrency);
  const runGit: GitRunner = (cwd, args, signal) => pi.exec("git", args, { cwd, signal });

  pi.registerTool({
    name: "rubber_duck",
    label: "Rubber Duck",
    description:
      "Ask an independent read-only peer, preferably from another model family, to challenge an idea or design. Optionally select an exact model or a quality/speed/cost policy.",
    promptSnippet: "Get a critical second opinion, preferably from a different model family",
    promptGuidelines: [
      "Use rubber_duck when the user asks for a second opinion, when a nontrivial design has competing approaches, or when reasoning is stuck.",
      "Independent rubber_duck calls in the same assistant turn run concurrently and are appropriate when several ideas can be evaluated in parallel.",
    ],
    parameters: Type.Object({
      idea: Type.String({ description: "The idea, design, decision, or reasoning to examine" }),
      question: Type.Optional(Type.String({ description: "A specific uncertainty for the peer to focus on" })),
      model: Type.Optional(Type.String({ description: "Optional exact peer model (provider/id or unambiguous id)." })),
      policy: Type.Optional(OptimizationPolicySchema),
      thinkingLevel: Type.Optional(ThinkingLevelSchema),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const selectedPeer = await choosePeerModel(ctx, "rubber-duck", {
        model: normalizeToolModel(params.model),
        policy: normalizeToolPolicy(params.policy),
        thinkingLevel: normalizeToolThinking(params.thinkingLevel),
      });
      const { selection, thinkingLevel, decision } = selectedPeer;
      onUpdate?.({
        content: [{ type: "text", text: `Consulting ${selectionLabel(selection, decision)}…` }],
        details: selection,
      });
      const task = [
        "A coding agent wants to bounce the following idea off you.",
        `\n## Idea\n${params.idea}`,
        params.question ? `\n## Focus question\n${params.question}` : "",
        `\nThe originating agent is using ${ctx.model ? modelSpec(ctx.model) : "an unknown model"}; provide a genuinely independent perspective.`,
      ].join("\n");
      const result = await runPeer(ctx, selection.model, thinkingLevel, RUBBER_DUCK_PROMPT, task, signal, {
        timeoutMs,
        semaphore,
        onStatus: (message) => {
          onUpdate?.({ content: [{ type: "text", text: message }], details: selection });
        },
      });
      const fallbackNotice = sameFamilyNotice(selection, decision);
      return {
        content: [
          {
            type: "text",
            text: `Peer model: ${selectionLabel(selection, decision)}:${thinkingLevel}${fallbackNotice}\n${result.output}`,
          },
        ],
        details: { ...result, ...selection, decision },
      };
    },
  });

  pi.registerTool({
    name: "code_review",
    label: "Code Review",
    description:
      "Dispatch an independent read-only peer to review the complete local diff, including committed, staged, unstaged, and untracked changes. Optionally select an exact model or a quality/speed/cost policy.",
    promptSnippet: "Review the complete local git diff with an independent peer model",
    promptGuidelines: [
      "Use code_review after substantive code changes and before running git push or gh pr create; address BLOCK or REVISE findings before pushing.",
      "Use code_review whenever the user requests review of local changes. The review agent is read-only and must not replace running the relevant tests.",
    ],
    parameters: Type.Object({
      base: Type.Optional(
        Type.String({ description: "Base ref for the review, such as origin/main. Defaults to origin/HEAD, main, or master." }),
      ),
      focus: Type.Optional(Type.String({ description: "Optional review focus, such as concurrency, API compatibility, or tests" })),
      model: Type.Optional(Type.String({ description: "Optional exact review model (provider/id or unambiguous id)." })),
      policy: Type.Optional(OptimizationPolicySchema),
      thinkingLevel: Type.Optional(ThinkingLevelSchema),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Capturing local diff…" }], details: {} });
      const snapshot = await createReviewSnapshot(runGit, ctx.cwd, params.base, signal);
      const selectedPeer = await choosePeerModel(ctx, "code-review", {
        model: normalizeToolModel(params.model),
        policy: normalizeToolPolicy(params.policy),
        thinkingLevel: normalizeToolThinking(params.thinkingLevel),
      });
      const { selection, thinkingLevel, decision } = selectedPeer;
      onUpdate?.({
        content: [{ type: "text", text: `Reviewing with ${selectionLabel(selection, decision)}…` }],
        details: { ...selection, base: snapshot.baseLabel },
      });

      const truncationNote = snapshot.truncated
        ? "\nSome inline diff content was truncated or omitted (for example, binary or non-regular files). Use read/grep/find/ls from the repository root to inspect every changed file identified by status and diff stat before reaching a verdict."
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

## Diff (includes bounded textual snapshots of untracked regular files)
\`\`\`diff
${snapshot.diff}
\`\`\`${truncationNote}

Check the surrounding implementation and tests with read-only tools. Report only findings introduced by or relevant to this change set.`;
      const result = await runPeer(ctx, selection.model, thinkingLevel, CODE_REVIEW_PROMPT, task, signal, {
        cwd: snapshot.root,
        timeoutMs,
        semaphore,
        onStatus: (message) => {
          onUpdate?.({
            content: [{ type: "text", text: message }],
            details: { ...selection, base: snapshot.baseLabel },
          });
        },
      });
      const fallbackNotice = sameFamilyNotice(selection, decision);
      return {
        content: [
          {
            type: "text",
            text: `Review model: ${selectionLabel(selection, decision)}:${thinkingLevel}\nBase: ${snapshot.baseLabel} (${snapshot.baseCommit.slice(0, 12)})${fallbackNotice}\n${result.output}`,
          },
        ],
        details: { ...result, ...selection, decision, snapshot },
      };
    },
  });
}
