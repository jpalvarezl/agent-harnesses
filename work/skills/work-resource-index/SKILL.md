---
name: work-resource-index
description: Index that maps a specific product feature or SDK sample set to the work-resources entry (resource + flavor + env vars) known to run it live. Use to look up WHICH Azure KeyVault-backed resource to load before running or live-testing a feature. Depends on the `work-resources` skill, which provides the `wr-*` CLI used to actually load the secrets. WHEN: "which work resource for X", "what endpoint runs the hosted-agents samples", "how do I live-test feature Y", "look up the resource for a sample".
---

# Work Resource Index

A lookup table from **feature / sample set → work-resources entry** (`resource`, `flavor`,
and the environment variables it provides) that has been verified to run that feature live.

The goal is to **minimize the spread of resources**: when a resource is proven to work for a
feature, record it here so other agents reuse the same one instead of hunting for or creating
new resources.

## Relationship to the `work-resources` skill

This skill is an **index only**. It does not load secrets. It tells you *which* resource/flavor
to load; the actual loading is done with the `wr-*` CLI documented in the sibling
[`work-resources`](../work-resources/SKILL.md) skill.

Typical flow:

1. Look up the feature in the table below to get its `resource` + `flavor`.
2. Use the `work-resources` skill to load it, e.g.:
   ```powershell
   wr-load -Resource <resource> -Flavor <flavor>
   ```
   (`wr-load` also writes the values to `./.env` so they survive across ephemeral shells.)
3. Run the feature's samples/tests; clear with `wr-clear -Force` when done.

All entries below live in the same KeyVault the `work-resources` skill is configured against
(currently the `ai-foundry-test-secrets` vault). Only secret **names** are recorded here — never
secret values.

## Index

| Feature / sample set | Repo path | Resource | Flavor | Env vars |
|----------------------|-----------|----------|--------|----------|
| Azure AI Agents — hosted agents (Java SDK samples) | `azure-sdk-for-java` → `sdk/ai/azure-ai-agents/src/samples/java/com/azure/ai/agents/hostedagents` | `foundry-sdk-deployment` | `java` | `FOUNDRY_PROJECT_ENDPOINT`, `FOUNDRY_AGENT_CONTAINER_IMAGE` |

## Entry details

### Azure AI Agents — hosted agents (Java SDK samples)

- **Resource / flavor:** `foundry-sdk-deployment` / `java`
- **Load:** `wr-load -Resource foundry-sdk-deployment -Flavor java`
- **Env vars → KeyVault secret names:**

  | Env var | KeyVault secret | Used by |
  |---------|-----------------|---------|
  | `FOUNDRY_PROJECT_ENDPOINT` | `foundry-sdk-deployment-java-foundry-project-endpoint` | all hosted-agents samples |
  | `FOUNDRY_AGENT_CONTAINER_IMAGE` | `foundry-sdk-deployment-java-foundry-agent-container-image` | all except the `CodeAgent*` samples |

- **Why this resource:** the `java` flavor ships a prebuilt hosted-agent container image
  (`responses-echo-agent`) already published to the project's ACR, so the container samples run
  without building an image. Authentication is via `DefaultAzureCredential` (e.g. `az login`).
- **Validated:** all 10 hosted-agents samples (`Sessions`, `SessionFiles`, `AgentEndpoint`,
  `SessionLogStream`, `CodeAgent`, plus their `*Async` variants) ran end-to-end against this
  resource.
- **Run one sample (from the repo root):**
  ```powershell
  wr-load -Resource foundry-sdk-deployment -Flavor java
  mvn -f sdk/ai/azure-ai-agents/pom.xml test-compile `
    org.codehaus.mojo:exec-maven-plugin:3.5.1:java `
    "-Dexec.classpathScope=test" `
    "-Dexec.mainClass=com.azure.ai.agents.hostedagents.SessionsSample" -DskipTests -q
  ```

## Adding a new entry

When you verify a resource works for a feature:

1. Confirm the run is genuinely green (sample/test exits successfully against the resource).
2. Prefer an **existing** resource/flavor before introducing a new one — keep the spread minimal.
3. Add a row to the **Index** table and, if the feature needs more than a couple of env vars or
   any extra context, a matching **Entry details** subsection.
4. Record only secret **names** and tag values (`resource`, `flavor`, `env-var-name`), never
   secret values. Use `wr-list -Resource <r> -Flavor <f>` (from the `work-resources` skill) to
   discover the exact secret names.
