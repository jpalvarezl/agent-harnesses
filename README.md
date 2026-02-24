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
    "~/path/to/agent-harnesses/personal/extensions/dispatch"
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

## Notes
- Skills can also be triggered implicitly by natural language requests.
- Settings changes require a restart; skill/prompt edits can be picked up with `/reload`.
