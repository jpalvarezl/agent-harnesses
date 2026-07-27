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

> **Usage guidance is built into the tools.** These extensions ship their own `promptSnippet`/`promptGuidelines`, so once an extension is registered, pi injects its when/how-to-use guidance into the system prompt automatically — no per-machine `AGENTS.md` edits needed.

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

## Personal Skills

### `dev-env-setup`
Interactive setup for a developer shell environment (fish, starship, nvm, lsd, bat, Nerd Fonts).
```text
/skill:dev-env-setup set up my dev environment
```

## Personal Extensions

### `subagent`
Delegate work to specialized subagents with **isolated context windows** (each runs as a separate `pi` process). Registers the model-callable `subagent` tool and `/subagent-model`, and ships agent definitions (`scout`, `planner`, `reviewer`, `worker`) plus workflow prompts (`/implement`, `/scout-and-plan`, `/implement-and-review`).

- **Modes:** single `{agent, task}`, parallel `{tasks: [...]}`, chain `{chain: [...]}` (sequential; `{previous}` is replaced with the prior step's output).
- **Models:** children inherit the active session model by default; set a cheaper session default with `/subagent-model`, or pass a per-task `model`.
- **Parallel writes:** pass `isolation: "git-worktree"` so each task runs in its own worktree/branch and the harness merges them back (clean-merge-only; conflicts preserved for manual resolution; optional `buildCommand` gate; `cleanup` = `on-success` | `never` | `always`). Requires a clean git tree.

Full reference: [`personal/extensions/subagent/README.md`](personal/extensions/subagent/README.md).

```text
Run 2 scouts in parallel: one to find the models, one to find the providers.
/implement add Redis caching to the session store
```

### `peer-agents`
Run isolated, read-only peer agents, preferably using a different model family. Registers two model-callable tools:

- `rubber_duck` challenges designs and assumptions. A GPT parent prefers a configured high-capability Claude Opus model; a Claude parent prefers a configured stable GPT model. If no opposite-family model is authenticated, it explicitly reports that it is using a different same-family model instead.
- `code_review` reviews committed, staged, unstaged, and untracked changes against the requested base (or the repository's default branch). It runs from the Git root so repository-relative paths work even when the parent session starts in a subdirectory.

Pi executes sibling tool calls concurrently. The extension permits four peer subprocesses by default, queues additional calls, enforces a five-minute timeout per running peer, and propagates cancellation. Override these defaults with `PI_PEER_AGENT_MAX_CONCURRENCY` and `PI_PEER_AGENT_TIMEOUT_MS`.

The tools instruct the main agent to run `code_review` after substantive changes and before `git push` or `gh pr create`. Reviews are advisory and must be verified against tests and repository evidence. Peer prompts, diffs, and files read by the peer are sent to the selected model's configured provider, which may differ from the parent model's provider; use these tools only when that data egress is acceptable.

```text
Bounce this caching design off the rubber duck agent.
Review my local diff against origin/main before creating the PR.
Ask two rubber duck agents in parallel to evaluate the API and concurrency designs.
```

### `model-dynamics`
Dynamic GitHub Copilot model selector. Registers `/model_cur`, which queries your authenticated Copilot account for the models currently available and lets you pick and persist one — useful when Copilot exposes a model before it appears in pi's generated model catalog.
```text
/model_cur
```

## Using these skills with GitHub Copilot CLI

The skills in this repo were originally written for **pi**, but the `SKILL.md`
format is the same one [GitHub Copilot CLI](https://docs.github.com/copilot/concepts/agents/about-copilot-cli)
uses, so they work there too with one caveat: Copilot CLI does **not** currently
support a configurable "skills directory" list. It only auto-discovers skills
from a single fixed location:

```
~/.copilot/skills/<skill-name>/SKILL.md
```

To expose this repo's skills there without copying files, symlink each skill
folder into `~/.copilot/skills/`. Because these are links into the repo, a
`git pull` (or a local `SKILL.md` edit) is picked up on Copilot CLI's next
session — no copying or re-installing.

### macOS / Linux

```bash
# from the repo root — link every skill (work + personal)
mkdir -p ~/.copilot/skills
for d in work/skills/*/ personal/skills/*/; do
  ln -sfn "$PWD/$d" ~/.copilot/skills/"$(basename "$d")"
done
```

### Windows (PowerShell)

Use directory **junctions** (no admin or Developer Mode required):

```powershell
# from the repo root
New-Item -ItemType Directory -Force ~/.copilot/skills | Out-Null
Get-ChildItem work/skills, personal/skills -Directory | ForEach-Object {
  New-Item -ItemType Junction -Force -Path "$HOME/.copilot/skills/$($_.Name)" -Target $_.FullName
}
```

### Verifying

Restart Copilot CLI and run:

```text
/skills      # list available skills
/env         # show loaded skills, instructions, MCP servers, etc.
```

### Caveats / scope

- Only **skills** are wired up this way. Copilot CLI has no equivalent for
  pi's `prompts` or `extensions` arrays; those remain pi-only.
- Project-local skills directories aren't supported by Copilot CLI. The links
  in `~/.copilot/skills/` apply globally to every Copilot CLI session.
- Repo-specific guidance is still picked up via `AGENTS.md` (in the git root
  and cwd) and `.github/instructions/**/*.instructions.md`.

## Notes
- Skills can also be triggered implicitly by natural language requests.
- Settings changes require a restart; skill/prompt edits can be picked up with `/reload`.
