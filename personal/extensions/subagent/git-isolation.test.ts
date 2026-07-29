import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	commitAll,
	createWorktree,
	getGitRoot,
	getHeadSha,
	gitClean,
	isWorkingTreeClean,
	makeRunId,
	mergeBranchNoFF,
	removeWorktree,
	resetHard,
	runBuildCheck,
	sanitizeRefComponent,
} from "./git-isolation.ts";

function git(args: string[], cwd: string): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

function makeRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-git-"));
	git(["init", "-q", "-b", "main"], dir);
	git(["config", "user.email", "t@t.dev"], dir);
	git(["config", "user.name", "Test"], dir);
	git(["config", "commit.gpgsign", "false"], dir);
	// Keep temporary repositories hermetic. Windows Git commonly inherits
	// system core.autocrlf=true, which rewrites checkout results to CRLF and
	// makes byte-exact merge assertions depend on the developer machine.
	git(["config", "core.autocrlf", "false"], dir);
	git(["config", "core.eol", "lf"], dir);
	fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
	git(["add", "-A"], dir);
	git(["commit", "-q", "-m", "init"], dir);
	return dir;
}

test("sanitizeRefComponent produces safe ref components", () => {
	assert.equal(sanitizeRefComponent("0-scout"), "0-scout");
	assert.equal(sanitizeRefComponent("weird name/../@{x}*"), "weird-name-.-x");
	assert.equal(sanitizeRefComponent("///"), "x");
	assert.equal(sanitizeRefComponent("feature.lock"), "feature-lock");
	assert.ok(sanitizeRefComponent("a".repeat(200)).length <= 60);
});

test("runBuildCheck reports success and failure", async () => {
	const ok = await runBuildCheck(process.cwd(), "exit 0");
	assert.equal(ok.success, true);
	const bad = await runBuildCheck(process.cwd(), "exit 3");
	assert.equal(bad.success, false);
	assert.equal(bad.aborted, false);
});

test("gitClean removes untracked files", async () => {
	const dir = makeRepo();
	try {
		fs.writeFileSync(path.join(dir, "artifact.txt"), "generated\n");
		assert.equal(await isWorkingTreeClean(dir), false);
		await gitClean(dir);
		assert.equal(fs.existsSync(path.join(dir, "artifact.txt")), false);
		assert.equal(await isWorkingTreeClean(dir), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("commitAll surfaces an error outside a git repo (no silent no-changes)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-nogit-"));
	try {
		fs.writeFileSync(path.join(dir, "f.txt"), "x\n");
		const r = await commitAll(dir, "msg");
		assert.equal(r.committed, false);
		assert.ok(r.error && r.error.length > 0, "expected an error, not a silent no-changes");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("clean-tree detection and git root", async () => {
	const dir = makeRepo();
	try {
		assert.equal(await isWorkingTreeClean(dir), true);
		fs.writeFileSync(path.join(dir, "dirty.txt"), "x\n");
		assert.equal(await isWorkingTreeClean(dir), false);
		const root = await getGitRoot(dir);
		assert.equal(root && fs.existsSync(path.join(root, ".git")), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("getGitRoot returns null outside a repo", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-nogit-"));
	try {
		assert.equal(await getGitRoot(dir), null);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("two non-overlapping worktrees both merge cleanly", async () => {
	const dir = makeRepo();
	// Worktrees live OUTSIDE the working tree so they never pollute `git status`.
	const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-wt-"));
	try {
		const runId = makeRunId();
		const a = await createWorktree(dir, {
			index: 0,
			agent: "a",
			branch: `subagent/${runId}/0-a`,
			worktreePath: path.join(wtRoot, `${runId}-0-a`),
		});
		const b = await createWorktree(dir, {
			index: 1,
			agent: "b",
			branch: `subagent/${runId}/1-b`,
			worktreePath: path.join(wtRoot, `${runId}-1-b`),
		});

		fs.writeFileSync(path.join(a.worktreePath, "a.txt"), "from a\n");
		fs.writeFileSync(path.join(b.worktreePath, "b.txt"), "from b\n");
		assert.equal((await commitAll(a.worktreePath, "task a")).committed, true);
		assert.equal((await commitAll(b.worktreePath, "task b")).committed, true);

		const m1 = await mergeBranchNoFF(dir, a.branch);
		const m2 = await mergeBranchNoFF(dir, b.branch);
		assert.equal(m1.status, "clean");
		assert.equal(m2.status, "clean");
		assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "from a\n");
		assert.equal(fs.readFileSync(path.join(dir, "b.txt"), "utf8"), "from b\n");
		assert.equal(await isWorkingTreeClean(dir), true);

		await removeWorktree(dir, a.worktreePath);
		await removeWorktree(dir, b.worktreePath);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(wtRoot, { recursive: true, force: true });
	}
});

test("no-change worktree reports nothing committed", async () => {
	const dir = makeRepo();
	const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-wt-"));
	try {
		const runId = makeRunId();
		const wt = await createWorktree(dir, {
			index: 0,
			agent: "noop",
			branch: `subagent/${runId}/0-noop`,
			worktreePath: path.join(wtRoot, `${runId}-0-noop`),
		});
		assert.equal((await commitAll(wt.worktreePath, "noop")).committed, false);
		await removeWorktree(dir, wt.worktreePath);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(wtRoot, { recursive: true, force: true });
	}
});

test("conflicting worktrees: first merges, second aborts and leaves tree clean", async () => {
	const dir = makeRepo();
	const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-wt-"));
	try {
		const runId = makeRunId();
		const a = await createWorktree(dir, {
			index: 0,
			agent: "a",
			branch: `subagent/${runId}/0-a`,
			worktreePath: path.join(wtRoot, `${runId}-0-a`),
		});
		const b = await createWorktree(dir, {
			index: 1,
			agent: "b",
			branch: `subagent/${runId}/1-b`,
			worktreePath: path.join(wtRoot, `${runId}-1-b`),
		});

		// Both edit the SAME file at the same line -> conflict on second merge.
		fs.writeFileSync(path.join(a.worktreePath, "base.txt"), "changed by a\n");
		fs.writeFileSync(path.join(b.worktreePath, "base.txt"), "changed by b\n");
		await commitAll(a.worktreePath, "a edits base");
		await commitAll(b.worktreePath, "b edits base");

		const preSha = await getHeadSha(dir);
		const m1 = await mergeBranchNoFF(dir, a.branch);
		assert.equal(m1.status, "clean");
		const m2 = await mergeBranchNoFF(dir, b.branch);
		assert.equal(m2.status, "conflict");
		assert.ok(m2.conflictFiles.includes("base.txt"));
		// Parent tree must be clean (merge aborted), 'a' still applied.
		assert.equal(await isWorkingTreeClean(dir), true);
		assert.equal(fs.readFileSync(path.join(dir, "base.txt"), "utf8"), "changed by a\n");

		// resetHard can roll back the successful merge to the pre-merge sha.
		await resetHard(dir, preSha);
		assert.equal(fs.readFileSync(path.join(dir, "base.txt"), "utf8"), "base\n");

		await removeWorktree(dir, a.worktreePath);
		await removeWorktree(dir, b.worktreePath);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(wtRoot, { recursive: true, force: true });
	}
});
