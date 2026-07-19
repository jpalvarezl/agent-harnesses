import * as fs from "node:fs/promises";
import * as path from "node:path";
import { capText } from "./runtime-utils.ts";

const DEFAULT_MAX_REVIEW_BYTES = 200 * 1024;
const DEFAULT_MAX_UNTRACKED_BYTES = 64 * 1024;
const DEFAULT_MAX_UNTRACKED_FILE_BYTES = 32 * 1024;

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type GitRunner = (cwd: string, args: string[], signal?: AbortSignal) => Promise<GitResult>;

export interface ReviewSnapshot {
  root: string;
  baseLabel: string;
  baseCommit: string;
  status: string;
  stat: string;
  diff: string;
  truncated: boolean;
  untrackedFiles: string[];
}

export interface ReviewSnapshotOptions {
  maxReviewBytes?: number;
  maxUntrackedBytes?: number;
  maxUntrackedFileBytes?: number;
}

async function mustGit(
  runGit: GitRunner,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await runGit(cwd, args, signal);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trimEnd();
}

async function refExists(runGit: GitRunner, cwd: string, ref: string, signal?: AbortSignal): Promise<boolean> {
  return (await runGit(cwd, ["rev-parse", "--verify", "--quiet", ref], signal)).code === 0;
}

export async function resolveBase(
  runGit: GitRunner,
  cwd: string,
  requested: string | undefined,
  signal?: AbortSignal,
): Promise<{ label: string; commit: string }> {
  let label = requested?.trim();
  if (!label) {
    const originHead = await runGit(
      cwd,
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      signal,
    );
    if (originHead.code === 0 && originHead.stdout.trim()) label = originHead.stdout.trim();
  }

  for (const fallback of ["origin/main", "main", "origin/master", "master"]) {
    if (label) break;
    if (await refExists(runGit, cwd, fallback, signal)) label = fallback;
  }
  label ??= "HEAD";

  if (label === "HEAD") return { label, commit: "HEAD" };
  const mergeBase = await mustGit(runGit, cwd, ["merge-base", "HEAD", label], signal);
  if (!mergeBase) throw new Error(`Could not determine merge base with ${label}`);
  return { label, commit: mergeBase };
}

export function parseUntrackedPaths(porcelainZ: string): string[] {
  return porcelainZ
    .split("\0")
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3))
    .filter(Boolean);
}

function safeUntrackedPath(root: string, relativePath: string): string | undefined {
  if (relativePath.includes("\0") || relativePath.includes("\n")) return undefined;
  const absolute = path.resolve(root, relativePath);
  const fromRoot = path.relative(root, absolute);
  if (!fromRoot || fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) return undefined;
  return absolute;
}

function pseudoDiff(relativePath: string, content: string, note?: string): string {
  const lines = content.split("\n");
  const added = lines.map((line) => `+${line}`).join("\n");
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    added,
    note ? `+\n+[peer-agents: ${note}]` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function formatUntrackedFiles(
  root: string,
  relativePaths: string[],
  maxTotalBytes = DEFAULT_MAX_UNTRACKED_BYTES,
  maxFileBytes = DEFAULT_MAX_UNTRACKED_FILE_BYTES,
): Promise<{ text: string; truncated: boolean; included: string[] }> {
  const sections: string[] = [];
  const included: string[] = [];
  let remaining = maxTotalBytes;
  let truncated = false;

  const appendSection = (section: string, incomplete = false) => {
    const separatorBytes = sections.length > 0 ? 2 : 0;
    const capped = capText(section, Math.max(0, remaining - separatorBytes));
    if (capped.text) {
      sections.push(capped.text);
      remaining -= separatorBytes + Buffer.byteLength(capped.text, "utf8");
    }
    truncated ||= incomplete || capped.truncated;
  };

  for (const relativePath of relativePaths) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    const absolute = safeUntrackedPath(root, relativePath);
    if (!absolute) {
      appendSection(`# Untracked path omitted as unsafe: ${JSON.stringify(relativePath)}`, true);
      continue;
    }

    try {
      const metadata = await fs.lstat(absolute);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        appendSection(`# Untracked non-regular file omitted: ${relativePath}`, true);
        continue;
      }

      const fileCap = Math.min(maxFileBytes, remaining);
      const handle = await fs.open(absolute, "r");
      let bytes: Buffer;
      try {
        const buffer = Buffer.alloc(Math.min(metadata.size, fileCap + 4));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        bytes = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }

      if (bytes.includes(0)) {
        appendSection(
          `diff --git a/${relativePath} b/${relativePath}\nBinary untracked file ${relativePath} omitted`,
          true,
        );
        included.push(relativePath);
        continue;
      }

      const capped = capText(bytes.toString("utf8"), fileCap);
      const fileTruncated = metadata.size > fileCap || capped.truncated;
      appendSection(
        pseudoDiff(
          relativePath,
          capped.text,
          fileTruncated ? `file content truncated after ${fileCap} bytes` : undefined,
        ),
        fileTruncated,
      );
      included.push(relativePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendSection(`# Could not read untracked file ${relativePath}: ${message}`, true);
    }
  }

  return { text: sections.join("\n\n"), truncated, included };
}

export async function createReviewSnapshot(
  runGit: GitRunner,
  cwd: string,
  base: string | undefined,
  signal?: AbortSignal,
  options: ReviewSnapshotOptions = {},
): Promise<ReviewSnapshot> {
  const maxReviewBytes = options.maxReviewBytes ?? DEFAULT_MAX_REVIEW_BYTES;
  const maxUntrackedBytes = Math.min(
    options.maxUntrackedBytes ?? DEFAULT_MAX_UNTRACKED_BYTES,
    maxReviewBytes,
  );
  const maxUntrackedFileBytes = options.maxUntrackedFileBytes ?? DEFAULT_MAX_UNTRACKED_FILE_BYTES;

  const root = await mustGit(runGit, cwd, ["rev-parse", "--show-toplevel"], signal);
  const resolved = await resolveBase(runGit, root, base, signal);
  const status = await mustGit(runGit, root, ["status", "--short", "--untracked-files=all"], signal);
  const statusZ = await mustGit(
    runGit,
    root,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    signal,
  );
  const stat = await mustGit(runGit, root, ["diff", "--stat", resolved.commit], signal);
  const trackedDiff = await mustGit(
    runGit,
    root,
    ["diff", "--no-ext-diff", "--find-renames", "--find-copies", "--unified=40", resolved.commit],
    signal,
  );

  const untrackedPaths = parseUntrackedPaths(`${statusZ}\0`);
  const untracked = await formatUntrackedFiles(
    root,
    untrackedPaths,
    maxUntrackedBytes,
    maxUntrackedFileBytes,
  );
  const untrackedBytes = Math.min(Buffer.byteLength(untracked.text, "utf8"), maxUntrackedBytes);
  const tracked = capText(trackedDiff, Math.max(0, maxReviewBytes - untrackedBytes));
  const combined = [tracked.text, untracked.text].filter(Boolean).join("\n\n");
  const finalDiff = capText(combined, maxReviewBytes);

  if (!status && !trackedDiff && untrackedPaths.length === 0) {
    throw new Error(`No changes found relative to ${resolved.label} (${resolved.commit.slice(0, 12)})`);
  }

  return {
    root,
    baseLabel: resolved.label,
    baseCommit: resolved.commit,
    status: status || "(clean status; committed branch changes only)",
    stat: [stat || "(no tracked-file stat)", untrackedPaths.length ? `${untrackedPaths.length} untracked file(s)` : ""]
      .filter(Boolean)
      .join("\n"),
    diff: finalDiff.text || "(no textual diff available)",
    truncated: tracked.truncated || untracked.truncated || finalDiff.truncated,
    untrackedFiles: untracked.included,
  };
}
