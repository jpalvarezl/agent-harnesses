import assert from "node:assert/strict";
import test from "node:test";
import {
	combineOutputAndDiagnostic,
	failureDetail,
	isFailedResult,
	isPendingResult,
	isQueuedResult,
	isRunningResult,
	type ResultState,
} from "./result-state.ts";

const base: ResultState = { exitCode: 0, stderr: "" };

test("state predicates for queued/running/finished", () => {
	assert.equal(isQueuedResult({ ...base, exitCode: -2 }), true);
	assert.equal(isRunningResult({ ...base, exitCode: -1 }), true);
	assert.equal(isPendingResult({ ...base, exitCode: -2 }), true);
	assert.equal(isPendingResult({ ...base, exitCode: -1 }), true);
	assert.equal(isPendingResult({ ...base, exitCode: 0 }), false);
	assert.equal(isRunningResult({ ...base, exitCode: -2 }), false);
});

test("isFailedResult covers exit code and stop reason", () => {
	assert.equal(isFailedResult({ ...base, exitCode: 0 }), false);
	assert.equal(isFailedResult({ ...base, exitCode: 1 }), true);
	assert.equal(isFailedResult({ ...base, exitCode: 0, stopReason: "error" }), true);
	assert.equal(isFailedResult({ ...base, exitCode: 0, stopReason: "aborted" }), true);
	assert.equal(isFailedResult({ ...base, exitCode: 0, stopReason: "end" }), false);
});

test("failureDetail is empty for pending or successful results", () => {
	assert.equal(failureDetail({ ...base, exitCode: -1, stderr: "still going" }), "");
	assert.equal(failureDetail({ ...base, exitCode: 0, stderr: "noise" }), "");
});

test("failureDetail returns errorMessage only", () => {
	assert.equal(failureDetail({ exitCode: 1, stderr: "", errorMessage: "boom" }), "boom");
});

test("failureDetail returns stderr only", () => {
	assert.equal(failureDetail({ exitCode: 1, stderr: "spawn ENOENT" }), "spawn ENOENT");
});

test("failureDetail combines distinct errorMessage and stderr", () => {
	const d = failureDetail({ exitCode: 1, errorMessage: "model error", stderr: "[terminated by signal SIGKILL]" });
	assert.equal(d, "model error\n[terminated by signal SIGKILL]");
});

test("failureDetail does not duplicate identical errorMessage and stderr", () => {
	assert.equal(failureDetail({ exitCode: 1, errorMessage: "same", stderr: "same" }), "same");
});

test("failureDetail tail-caps very long diagnostics", () => {
	const long = "x".repeat(5000);
	const d = failureDetail({ exitCode: 1, stderr: long });
	assert.ok(d.startsWith("…"));
	assert.ok(d.length <= 2001);
});

test("failureDetail keeps errorMessage even when stderr is very long", () => {
	const d = failureDetail({ exitCode: 1, errorMessage: "model blew up", stderr: "x".repeat(5000) });
	assert.ok(d.startsWith("model blew up\n"), "errorMessage must survive at the head");
	assert.ok(d.includes("…"), "stderr should be tail-capped");
});

test("combineOutputAndDiagnostic: success returns output", () => {
	assert.equal(combineOutputAndDiagnostic("done", { ...base }), "done");
	assert.equal(combineOutputAndDiagnostic("", { ...base }), "(no output)");
});

test("combineOutputAndDiagnostic: failure preserves partial output AND appends error", () => {
	const out = combineOutputAndDiagnostic("partial progress", { exitCode: 1, stderr: "spawn ENOENT" });
	assert.equal(out, "partial progress\n\n[error] spawn ENOENT");
});

test("combineOutputAndDiagnostic: failure with no output returns diagnostic", () => {
	assert.equal(combineOutputAndDiagnostic("", { exitCode: 1, stderr: "spawn ENOENT" }), "spawn ENOENT");
});

test("combineOutputAndDiagnostic: failure with neither returns (no output)", () => {
	assert.equal(combineOutputAndDiagnostic("", { exitCode: 1, stderr: "" }), "(no output)");
});
