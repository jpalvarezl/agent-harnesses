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
    "~/path/to/agent-harnesses/work/extensions/my-extension",
    "~/path/to/agent-harnesses/personal/extensions/dispatch",
    "~/path/to/agent-harnesses/personal/extensions/peer-agents"
  ],
  "enableSkillCommands": true
}
```

### For colleagues (work only)

Share just the `work/` directory:

```json
{
  "skills": ["~/path/to/agent-harnesses/work/skills"],
  "prompts": ["~/path/to/agent-harnesses/work/prompts"],
  "extensions": ["~/path/to/agent-harnesses/work/extensions/my-extension"],
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
- `wr-load` requires the **work-resources** CLI: https://github.com/jpalvarezl/work-resources
- `codegen` requires `tsp-client` on PATH (npm package: https://www.npmjs.com/package/@azure-tools/typespec-client-generator-cli?activeTab=readme).
- `run-tests` requires Java + Maven (`mvn`) on PATH.
  - Recommended Java: Temurin JDK 21 (https://adoptium.net/en-GB/temurin/releases)
  - Maven install: https://maven.apache.org/install.html
- `test-proxy` requires the `test-proxy` CLI on PATH (install: https://github.com/Azure/azure-sdk-tools/blob/main/tools/test-proxy/Azure.Sdk.Tools.TestProxy/README.md#installation-and-initial-run).

### `wr-load`
```text
/skill:wr-load load secrets for resource myapi
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

### `dispatch`
Scan, dispatch, and merge parallel agent work via git worktrees. Registers commands: `/scan`, `/dispatch`, `/sessions`, `/broadcast`.
```text
/scan src -d            # scan for markers and auto-dispatch
/dispatch TODO-ab12cd34 # dispatch a specific todo
/dispatch status        # show active worktrees
/sessions               # show live sessions and broadcasts
/broadcast <message>    # broadcast to other sessions
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

## Using these skills with GitHub Copilot CLI

The skills in this repo were originally written for **pi**, but the `SKILL.md`
format is the same one [GitHub Copilot CLI](https://docs.github.com/copilot/concepts/agents/about-copilot-cli)
uses, so they work there too with one caveat: Copilot CLI does **not** currently
support a configurable "skills directory" list. It only auto-discovers skills
from a single fixed location:

```
~/.copilot/skills/<skill-name>/SKILL.md
```

To expose this repo's skills there without copying files, we link each skill
folder into `~/.copilot/skills/`. The provided scripts are idempotent and
preserve any skills you already have installed under that directory.

### Windows (PowerShell)

```powershell
# from the repo root
pwsh ./scripts/install-copilot-cli-skills.ps1               # link everything
pwsh ./scripts/install-copilot-cli-skills.ps1 -Work         # work skills only
pwsh ./scripts/install-copilot-cli-skills.ps1 -Personal     # personal skills only
pwsh ./scripts/install-copilot-cli-skills.ps1 -DryRun       # preview
```

The Windows script creates directory **junctions**, which don't require admin
or Developer Mode.

### macOS / Linux

```bash
# from the repo root
./scripts/install-copilot-cli-skills.sh                # link everything
./scripts/install-copilot-cli-skills.sh --work         # work skills only
./scripts/install-copilot-cli-skills.sh --personal     # personal skills only
./scripts/install-copilot-cli-skills.sh --dry-run      # preview
```

### Verifying

After running the script, restart Copilot CLI and run:

```text
/skills      # list available skills
/env         # show loaded skills, instructions, MCP servers, etc.
```

Because the entries are links into this repo, a `git pull` (or local edit of
any `SKILL.md`) is picked up by Copilot CLI on its next session — no copying
or re-running the installer needed.

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
