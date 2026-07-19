import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  createReviewSnapshot,
  formatUntrackedFiles,
  parseUntrackedPaths,
  resolveBase,
  type GitRunner,
} from "./review-snapshot.ts";

function result(stdout = "", code = 0, stderr = "") {
  return { stdout, stderr, code };
}

test("parseUntrackedPaths handles NUL-delimited paths with spaces", () => {
  assert.deepEqual(parseUntrackedPaths("?? new file.ts\0 M tracked.ts\0?? nested/a.txt\0"), [
    "new file.ts",
    "nested/a.txt",
  ]);
});

test("resolveBase uses origin HEAD and computes a merge base", async () => {
  const calls: string[] = [];
  const runGit: GitRunner = async (_cwd, args) => {
    calls.push(args.join(" "));
    if (args[0] === "symbolic-ref") return result("origin/main\n");
    if (args[0] === "merge-base") return result("abc123\n");
    return result("", 1, "unexpected");
  };

  assert.deepEqual(await resolveBase(runGit, "/repo", undefined), {
    label: "origin/main",
    commit: "abc123",
  });
  assert.deepEqual(calls, [
    "symbolic-ref --quiet --short refs/remotes/origin/HEAD",
    "merge-base HEAD origin/main",
  ]);
});

test("formatUntrackedFiles includes text and identifies binary files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "peer-review-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "new file.txt"), "hello\nworld\n");
  await fs.writeFile(path.join(root, "binary.dat"), Buffer.from([1, 0, 2]));

  const formatted = await formatUntrackedFiles(root, ["new file.txt", "binary.dat"]);
  assert.match(formatted.text, /diff --git a\/new file\.txt b\/new file\.txt/);
  assert.match(formatted.text, /\+hello\n\+world/);
  assert.match(formatted.text, /Binary untracked file binary\.dat omitted/);
  assert.deepEqual(formatted.included, ["new file.txt", "binary.dat"]);
  assert.equal(formatted.truncated, true);
});

test("formatUntrackedFiles enforces its aggregate budget across omitted files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "peer-review-budget-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "one.bin"), Buffer.from([1, 0, 2]));
  await fs.writeFile(path.join(root, "two.bin"), Buffer.from([3, 0, 4]));

  const formatted = await formatUntrackedFiles(root, ["one.bin", "two.bin"], 64, 32);
  assert.ok(Buffer.byteLength(formatted.text, "utf8") <= 64);
  assert.equal(formatted.truncated, true);
});

test("createReviewSnapshot includes bounded untracked file content", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "peer-snapshot-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "new.ts"), "export const answer = 42;\n");

  const runGit: GitRunner = async (_cwd, args) => {
    const command = args.join(" ");
    if (command === "rev-parse --show-toplevel") return result(`${root}\n`);
    if (command === "status --short --untracked-files=all") return result("?? new.ts\n");
    if (command === "status --porcelain=v1 -z --untracked-files=all") return result("?? new.ts\0");
    if (command === "diff --stat HEAD") return result("");
    if (command === "diff --no-ext-diff --find-renames --find-copies --unified=40 HEAD") return result("");
    return result("", 1, `unexpected: ${command}`);
  };

  const snapshot = await createReviewSnapshot(runGit, root, "HEAD");
  assert.equal(snapshot.root, root);
  assert.deepEqual(snapshot.untrackedFiles, ["new.ts"]);
  assert.match(snapshot.diff, /\+export const answer = 42;/);
  assert.match(snapshot.stat, /1 untracked file\(s\)/);
  assert.equal(snapshot.truncated, false);
});

test("createReviewSnapshot enforces the aggregate byte limit", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "peer-snapshot-cap-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "large.txt"), "x".repeat(500));

  const runGit: GitRunner = async (_cwd, args) => {
    const command = args.join(" ");
    if (command === "rev-parse --show-toplevel") return result(root);
    if (command === "status --short --untracked-files=all") return result("?? large.txt");
    if (command === "status --porcelain=v1 -z --untracked-files=all") return result("?? large.txt\0");
    if (command === "diff --stat HEAD") return result("");
    if (command === "diff --no-ext-diff --find-renames --find-copies --unified=40 HEAD") return result("");
    return result("", 1, `unexpected: ${command}`);
  };

  const snapshot = await createReviewSnapshot(runGit, root, "HEAD", undefined, {
    maxReviewBytes: 128,
    maxUntrackedBytes: 128,
    maxUntrackedFileBytes: 64,
  });
  assert.ok(Buffer.byteLength(snapshot.diff, "utf8") <= 128);
  assert.equal(snapshot.truncated, true);
});
