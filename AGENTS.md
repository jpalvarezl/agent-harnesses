# Workflows & Preferences

## Repository layout
This repo is split into two top-level directories:
- **`work/`** — skills, prompts, and extensions for the team (safe to share with colleagues).
- **`personal/`** — personal skills, extensions, and prompts (machine-setup, dotfiles, etc.).

## Extensions
- Extensions live under `work/extensions/` or `personal/extensions/`.
- Each extension is either a single `.ts` file or a directory with an `index.ts` entry point.
- Extensions must be registered in `~/.pi/agent/settings.json` under the `"extensions"` array (see README for setup).
- **New extensions require a full restart of pi** — `/reload` may not detect newly added extensions.
- Ship usage guidance **with the extension** via `registerTool`'s `promptSnippet`/`promptGuidelines` (pi injects it into the system prompt when the tool is active) rather than editing the global `~/.pi/agent/AGENTS.md`. Keep guideline bullets compact and name the tool in each one.

## General
- Prefer using skills for discrete tasks (codegen, wr-load, run-tests, search-m2, dup-classes, test-proxy, github, union-type-wrappers).
- Ask clarifying questions when project/module, commit hash, or test mode is ambiguous.
- Environment variables set via `wr-load` don't persist across tool calls; if you need them for a command, combine in a single bash call.

## Codegen workflow
- When the user provides a commit hash, update `tsp-location.yaml` in the current project **before** running tsp-client.
- Default to `tsp-client update` unless the user requests sync or generate.

## Test workflow
- Use `AZURE_TEST_MODE=LIVE|RECORD|PLAYBACK` when the user requests live/record/playback.
- If tests need KeyVault secrets, use `wr-load` and run tests in the same command.

## Duplicate class checks
- When asked to verify duplication vs `openai-java`, use the `dup-classes` skill (and `search-m2` if you need help locating the JAR).

## Recordings
- When the user is happy with recordings, use the `test-proxy` skill to push `assets.json`.

## Release notes
- Use the `release-notes` skill when updating CHANGELOG.md or README.md from a PR.
- Always ask for the PR URL/number if not provided.
- Summarize changes from a consumer perspective; group repetitive renames by pattern.
- Never break the CI-enforced CHANGELOG heading structure (`Features Added`, `Breaking Changes`, `Bugs Fixed`, `Other Changes`).
- Never remove existing entries from the CHANGELOG.
- For README updates, preserve the existing heading hierarchy and update code snippets if renamed APIs are referenced.

## GitHub
- Use the `github` skill for issues, PRs, CI runs, and advanced API queries via the `gh` CLI.

## Union type wrappers
- When generated Java models expose `BinaryData` for TypeSpec union-typed fields, use the `union-type-wrappers` skill to add typed getters/setters.
- Properties typed as `unknown` in TypeSpec stay as `BinaryData` — only unions get wrappers.
- The `// AI Tooling: union type` comment marks customized properties for future maintainers.
