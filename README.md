# Pi Workflows (shared .pi)

This repo contains shared **skills** and **prompt templates** for our pi workflows.

Pi is a CLI coding-agent harness for agent orchestration, custom skills, prompt templates, and extensions.
Docs: https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent

## Setup

Add these paths to your global settings (`~/.pi/agent/settings.json`):

```json
{
  "skills": ["~/path/to/shared/.pi/skills"],
  "prompts": ["~/path/to/shared/.pi/prompts"],
  "enableSkillCommands": true
}
```

Then restart pi (or run `/reload` after edits inside the skills/prompts).

> Tip: If you want project‑local settings, you can add a `.pi/settings.json` in a repo:
> ```json
> { "skills": ["../.pi/skills"], "prompts": ["../.pi/prompts"] }
> ```

## Skills (examples)

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

## Prompt templates (examples)

### Full workflow
```text
/codegen-workflow
```

### Duplicate check helper
```text
/dup-check
```

## Notes
- Skills can also be triggered implicitly by natural language requests.
- Settings changes require a restart; skill/prompt edits can be picked up with `/reload`.
