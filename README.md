# Pi Workflows

This repo contains **skills**, **prompt templates**, and **extensions** for pi workflows, split into two areas:

| Directory | Contents | Audience |
|-----------|----------|----------|
| `work/` | Skills, prompts & extensions for day-to-day team workflows (codegen, testing, recordings, …) | **Team — safe to share** |
| `personal/` | Personal extensions, environment setup, dotfiles, etc. | **Individual** |

Pi is a CLI coding-agent harness for agent orchestration, custom skills, prompt templates, and extensions.
Docs: https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent

## Setup

### For the full repo (personal + work)

Add both paths in your global settings (`~/.pi/agent/settings.json`):

```json
{
  "skills": [
    "~/path/to/agent-harnesses/work/skills",
    "~/path/to/agent-harnesses/personal/skills"
  ],
  "prompts": [
    "~/path/to/agent-harnesses/work/prompts"
  ],
  "extensions": [
    "~/path/to/agent-harnesses/personal/extensions/model-dynamics",
    "~/path/to/agent-harnesses/personal/extensions/peer-agents",
    "~/path/to/agent-harnesses/personal/extensions/subagent"
  ],
  "enableSkillCommands": true
}
```

### For colleagues (work only)

Share just the `work/` directory (skills + prompts; there are no work-only extensions today):

```json
{
  "skills": ["~/path/to/agent-harnesses/work/skills"],
  "prompts": ["~/path/to/agent-harnesses/work/prompts"],
  "enableSkillCommands": true
}
```

> **Tip:** For project-local settings, add a `.pi/settings.json` in a repo:
> ```json
> { "skills": ["../agent-harnesses/work/skills"], "prompts": ["../agent-harnesses/work/prompts"] }
> ```

> **Note:** Extensions are either a single `.ts` file or a directory containing an `index.ts` entry point. Each extension path must be listed individually in the `"extensions"` array. **New extensions require a full restart of pi** — `/reload` may not detect them.

> **Usage guidance is built into the model-callable tools.** The `subagent` and `peer-agents` tools ship their own `promptSnippet`/`promptGuidelines`, so once registered, pi injects their when/how-to-use guidance into the system prompt automatically — no per-machine `AGENTS.md` edits needed.

## Work Skills

### Dependencies
- `work-resources` requires the **work-resources** CLI: https://github.com/jpalvarezl/work-resources
- `codegen` requires `tsp-client` on PATH (npm package: https://www.npmjs.com/package/@azure-tools/typespec-client-generator-cli?activeTab=readme).
- `run-tests` requires Java + Maven (`mvn`) on PATH.
  - Recommended Java: Temurin JDK 21 (https://adoptium.net/en-GB/temurin/releases)
  - Maven install: https://maven.apache.org/install.html
- `test-proxy` requires the `test-proxy` CLI on PATH (install: https://github.com/Azure/azure-sdk-tools/blob/main/tools/test-proxy/Azure.Sdk.Tools.TestProxy/README.md#installation-and-initial-run).

### `work-resources`
```text
/skill:work-resources load secrets for resource myapi
```

### `codegen`
```text
/skill:codegen update commit to 6267b6... then generate (keep inputs)
```

### `run-tests`
```text
/skill:run-tests run tests in RECORD mode
```

### `search-m2`
```text
/skill:search-m2 find where com.example.FooService lives
```

### `dup-classes` (field-by-field model comparison)
```text
/skill:dup-classes compare generated models under ./src/main/java with openai-java
```

### `test-proxy`
```text
/skill:test-proxy push assets.json
```

### `release-notes`
```text
/skill:release-notes update changelog and readme from PR https://github.com/Azure/azure-sdk-for-java/pull/12345
```

### `github`
Interact with GitHub via the `gh` CLI — issues, PRs, CI runs, and advanced `gh api` queries.
```text
/skill:github show the failing checks on PR 123
```

### `work-resource-index`
Look up **which** work-resources entry (resource + flavor + env vars) is known to run a given feature or sample set live, before loading secrets with `work-resources`.
```text
/skill:work-resource-index which resource runs the hosted-agents samples?
```

### `dedup-openai`
Suppress generated Java classes that duplicate `openai-java` models (via `@@alternateType` in TypeSpec + manual serialization bridges). Run after `dup-classes` identifies actionable duplicates.
```text
/skill:dedup-openai suppress the duplicates dup-classes found
```

### `missing-protocol-methods`
Add missing Azure SDK for Java protocol-method overloads (WithResponse taking `RequestOptions`, returning `Response<BinaryData>`) for existing convenience methods.
```text
/skill:missing-protocol-methods add protocol overloads for the Foo client
```

### `tsp-naming-collision`
Fix Java codegen parameter names ending in a numeric suffix (e.g. `createAgentRequest1`) caused by TypeSpec model-name collisions.
```text
/skill:tsp-naming-collision fix the Request1 parameter names in ./sdk/foo
```

### `tsp-type-override`
Override a TypeSpec field type with a Java-native type (e.g. `OffsetDateTime`) via `@@alternateType` in `client.java.tsp`.
```text
/skill:tsp-type-override map Model.created_at to OffsetDateTime
```

### `union-type-wrappers`
Add typed getters/setters over `BinaryData` properties that represent TypeSpec union types in generated Java models.
```text
/skill:union-type-wrappers add typed accessors for union fields under ./src/main/java
```

## Work Prompt Templates

### Full workflow
```text
/codegen-workflow
```

### Duplicate check helper
```text
/dup-check
```

### Release notes from a PR
```text
/release-notes https://github.com/Azure/azure-sdk-for-java/pull/12345
```

### Fix TypeSpec naming collisions
```text
/tsp-naming-collision ./sdk/foo
```

### Override a TypeSpec field type
```text
/tsp-type-override
```

### Union-type wrappers
```text
/union-type-wrappers
```

## Personal Skills

### `dev-env-setup`
Interactive setup for a developer shell environment (fish, starship, nvm, lsd, bat, Nerd Fonts).
```text
/skill:dev-env-setup set up my dev environment
```

### `ios-device-deploy`
Build, install, and launch iOS/iPadOS apps on a physical device from the CLI (`xcodebuild` + `devicectl`) — no Xcode GUI.
```text
/skill:ios-device-deploy deploy this app to my iPhone
```

### `swift-development`
Swift 6 development guidelines (strict concurrency, actor isolation, Sendable, async/await, SwiftUI, Swift Testing). Use when writing or reviewing Swift.
```text
/skill:swift-development review this file for Swift 6 concurrency issues
```

## Personal Extensions

### `subagent`
Delegate work to specialized subagents with **isolated context windows** (each runs as a separate `pi` process). Registers the model-callable `subagent` tool and `/subagent-model`, and ships agent definitions (`scout`, `planner`, `reviewer`, `worker`) plus workflow prompts (`/implement`, `/scout-and-plan`, `/implement-and-review`).

- **Modes:** single `{agent, task}`, parallel `{tasks: [...]}`, chain `{chain: [...]}` (sequential; `{previous}` is replaced with the prior step's output).
- **Models:** children inherit the active session model by default; set a session pin with `/subagent-model`, pass an exact per-task `model`, or opt into a `policy` (`auto`, `quality`, `speed`, `cost`, any two-way combination, or `balanced`) with an optional `thinkingLevel`. Use canonical `provider/id` specs: ambiguous bare IDs are rejected rather than selecting an arbitrary provider.
- **Parallel writes:** pass `isolation: "git-worktree"` so each task runs in its own worktree/branch and the harness merges them back (clean-merge-only; conflicts preserved for manual resolution; optional `buildCommand` gate; `cleanup` = `on-success` | `never`). Requires a clean git tree.
- **Child capabilities:** subagent children disable extension discovery and explicitly load only the rubber-duck child entry point. Workers implement, build, and test; they may consult `rubber_duck`, but cannot recursively call `code_review` or `subagent`. The top-level orchestrator reviews the integrated result once.

Full reference: [`personal/extensions/subagent/README.md`](personal/extensions/subagent/README.md).

> **Extra install step:** the bundled agents (`scout`/`planner`/`reviewer`/`worker`) and workflow prompts (`/implement`, `/scout-and-plan`, `/implement-and-review`) must be symlinked into pi's `~/.pi/agent/agents` and `~/.pi/agent/prompts`. Registering the extension alone gives you the `subagent` tool but not those — see the extension README's **Installation** section.

```text
Run 2 scouts in parallel: one to find the models, one to find the providers.
/implement add Redis caching to the session store
```

### `peer-agents`
Run isolated, read-only peer agents, preferably using a different model family. Registers two model-callable tools:

- `rubber_duck` challenges designs and assumptions. By default, a GPT parent prefers a configured high-capability Claude model and vice versa. Optionally pass `policy`, `thinkingLevel`, or an exact `model`; chooser policies retain categorical family/vendor diversity.
- `code_review` reviews committed, staged, unstaged, and untracked changes against the requested base (or the repository's default branch). It runs from the Git root so repository-relative paths work even when the parent session starts in a subdirectory, and accepts the same optional model-selection fields.

Pi executes sibling tool calls concurrently. The extension permits four peer subprocesses by default, queues additional calls, enforces a five-minute timeout per running peer, and propagates cancellation. Override these defaults with `PI_PEER_AGENT_MAX_CONCURRENCY` and `PI_PEER_AGENT_TIMEOUT_MS`.

The tools instruct only the top-level orchestrator to run `code_review`, once substantive or high-risk work is complete, tested, and fully integrated. Parallel workers do not perform local reviews. Required BLOCK/REVISE fixes permit at most one material verification review; optional Suggestions do not trigger edits or re-review. Review reasoning remains high by default. Reviews are advisory and must be verified against tests and repository evidence. Peer prompts, diffs, and files read by the peer are sent to the selected model's configured provider, which may differ from the parent model's provider; use these tools only when that data egress is acceptable.

```text
Bounce this caching design off the rubber duck agent.
Review my local diff against origin/main before creating the PR.
Ask two rubber duck agents in parallel to evaluate the API and concurrency designs.
Use a quality-cost policy for the next independent code review.
```

### `model-dynamics`
Dynamic GitHub Copilot model selector. Registers `/model_cur`, which queries your authenticated Copilot account for the models currently available and lets you pick and persist one — useful when Copilot exposes a model before it appears in pi's generated model catalog.
```text
/model_cur
```

## Notes
- Skills can also be triggered implicitly by natural language requests.
- Settings changes require a restart; skill/prompt edits can be picked up with `/reload`.
