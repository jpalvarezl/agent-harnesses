# Workflows & Preferences

## General
- Prefer using skills for discrete tasks (codegen, wr-load, run-tests, search-m2, dup-classes, test-proxy).
- Ask clarifying questions when project/module, commit hash, or test mode is ambiguous.
- Environment variables set via `wr-load` don’t persist across tool calls; if you need them for a command, combine in a single bash call.

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
