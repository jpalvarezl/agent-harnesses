import assert from "node:assert/strict";
import test from "node:test";
import { createChildBaseArgs } from "./child-invocation.ts";

test("subagent children disable extension discovery and explicitly load only rubber_duck", () => {
	const args = createChildBaseArgs("/extensions/rubber-duck-only.ts");

	assert.deepEqual(args, [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--extension",
		"/extensions/rubber-duck-only.ts",
	]);
});
