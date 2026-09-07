---
name: work-resource-index
description: >-
  Index that maps a specific product feature or SDK sample set to the work-resources entry
  (resource + flavor + env vars + any required Azure CLI profiles) known to run it live. Use to look up WHICH Azure
  KeyVault-backed resource to load before running or live-testing a feature. Depends on the
  `work-resources` skill, which provides the `wr-*` CLI used to actually load the secrets.
  WHEN: "which work resource for X", "what endpoint runs the hosted-agents samples", "how do I
  live-test feature Y", "look up the resource for a sample".
---

# Work Resource Index

A lookup table from **feature / sample set → work-resources entry** (`resource`, `flavor`,
the environment variables it provides, and any required Azure CLI profiles) that has been
verified to run that feature live.

The goal is to **minimize the spread of resources**: when a resource is proven to work for a
feature, record it here so other agents reuse the same one instead of hunting for or creating
new resources.

## Relationship to the `work-resources` skill

This skill is an **index only**. It does not load secrets. It tells you *which* resource/flavor
to load; the actual loading is done with the `wr-*` CLI documented in the sibling
[`work-resources`](../work-resources/SKILL.md) skill.

Typical flow:

1. Look up the feature's `resource` + `flavor` and any **Authentication context** in its
   entry details. Select the entry's vault CLI profile before loading secrets.
2. Use the `work-resources` skill to load it, e.g.:
   ```powershell
   wr-load -Resource <resource> -Flavor <flavor>
   ```
   (`wr-load` also writes the values to `./.env` so they survive across ephemeral shells.)
3. After loading succeeds, select the entry's runtime CLI profile and start the sample
   from that same shell. Switch back to the vault profile before `wr-clear -Force`.
   Restore the caller's previous profile afterwards.

All entries below live in the same KeyVault the `work-resources` skill is configured against
(currently the `ai-foundry-test-secrets` vault). Only secret **names** are recorded here — never
secret values. A runtime resource may belong to a different account or tenant from the vault.

## Authentication context

`AZURE_CONFIG_DIR` adds a **local authentication layer**, not a third resource/flavor tag.
The [work-resources profile workflow](../work-resources/SKILL.md#azure-cli-profiles-for-multiple-accounts)
documents bootstrap, load/run ordering, credential precedence, and restoration.

For entries that require another account, add an **Authentication context** block to the
entry details:

| Field | What to record |
|-------|----------------|
| Vault CLI profile | Profile used for `wr-*`, e.g. the normal `$HOME\.azure` profile. |
| Runtime CLI profile | Profile used by the sample, e.g. `$HOME\.azure-claude-haiku`. |
| Tenant/subscription selection | How to obtain the expected IDs from the resource owner or named configuration entries and select them within that profile. |
| Authentication method | Azure CLI/Entra credentials, or another explicitly configured credential source. |
| Invocation evidence | Sample that completed successfully using this profile and resource. |

Use home-relative profile descriptions in shared guidance, resolving them to absolute paths
at launch. Profiles and their cached logins are local to each machine; teammates must
authenticate their own profiles. Do not record credentials, token caches, or another user's
login details. Keep endpoint/model values in the configuration source; retain the existing
secret-name-only convention here.

Existing entries without an Authentication context block do not declare an alternate profile.
Do not infer an account switch from an endpoint or flavor, and do not assume the current
identity is authorized merely because it can list a resource. A successful directory creation,
login, or token request is not sufficient to add an entry to the verified index.

## Index

| Feature / sample set | Repo path | Resource | Flavor | Env vars |
|----------------------|-----------|----------|--------|----------|
| Azure AI Agents — hosted agents (Java SDK samples) | `azure-sdk-for-java` → `sdk/ai/azure-ai-agents/src/samples/java/com/azure/ai/agents/hostedagents` | `foundry-sdk-deployment` | `java` | `FOUNDRY_PROJECT_ENDPOINT`, `FOUNDRY_AGENT_CONTAINER_IMAGE` |
| Azure AI Agents — memory stores (Java SDK samples) | `azure-sdk-for-java` → `sdk/ai/azure-ai-agents/src/samples/java/com/azure/ai/agents/memory` | `foundry-sdk-deployment` | `java` | `FOUNDRY_PROJECT_ENDPOINT`, `AZURE_AI_CHAT_MODEL_DEPLOYMENT_NAME`, `AZURE_AI_EMBEDDING_MODEL_DEPLOYMENT_NAME` |
| Azure AI Agents — toolboxes (Java SDK samples) | `azure-sdk-for-java` → `sdk/ai/azure-ai-agents/src/samples/java/com/azure/ai/agents/toolboxes` | `foundry-sdk-deployment` | `java` | `FOUNDRY_PROJECT_ENDPOINT` |
| Azure AI Agents — tools (most; Java SDK samples) | `azure-sdk-for-java` → `sdk/ai/azure-ai-agents/src/samples/java/com/azure/ai/agents/tools` | `foundry-sdk-test6` | `java` | `FOUNDRY_PROJECT_ENDPOINT`, `FOUNDRY_MODEL_NAME`, + per-tool connection-id vars (see Tools section) |
| Azure AI Agents — tools: ImageGeneration | `…/tools/ImageGeneration*.java` | `foundry-sdk-deployment` | `java` | `FOUNDRY_PROJECT_ENDPOINT`, `FOUNDRY_MODEL_NAME`, `IMAGE_GENERATION_MODEL_DEPLOYMENT_NAME` |
| Azure AI Agents — tools: FabricIQ | `…/tools/FabricIQ*.java` | `fabric-iq-resource` | _(none)_ | `FOUNDRY_PROJECT_ENDPOINT`, `FOUNDRY_MODEL_NAME`, `FABRIC_IQ_PROJECT_CONNECTION_ID` |
| Azure AI Agents — tools: WorkIQ | `…/tools/WorkIQ*.java` | `fabric-iq-resource` (endpoint+model) + `work-iq-resource` (connection) | _(none)_ | `FOUNDRY_PROJECT_ENDPOINT`, `FOUNDRY_MODEL_NAME`, `WORK_IQ_PROJECT_CONNECTION_ID` |

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

### Azure AI Agents — memory stores (Java SDK samples)

- **Resource / flavor:** `foundry-sdk-deployment` / `java`
- **Load:** `wr-load -Resource foundry-sdk-deployment -Flavor java`
- **Env vars → KeyVault secret names:**

  | Env var | KeyVault secret | Used by |
  |---------|-----------------|---------|
  | `FOUNDRY_PROJECT_ENDPOINT` | `foundry-sdk-deployment-java-foundry-project-endpoint` | all memory samples |
  | `AZURE_AI_CHAT_MODEL_DEPLOYMENT_NAME` | `foundry-sdk-deployment-java-azure-ai-chat-model-deployment-name` | `CreateMemoryStore` only |
  | `AZURE_AI_EMBEDDING_MODEL_DEPLOYMENT_NAME` | `foundry-sdk-deployment-java-azure-ai-embedding-model-deployment-name` | `CreateMemoryStore` only |

- **Ordering:** the samples share the hard-coded store name `my_memory_store_java`, so run them as
  `CreateMemoryStore` → `GetMemoryStore` / `UpdateMemoryStore` / `ListMemoryStores` →
  `DeleteMemoryStore` (cleanup). `ListMemoryStores` works standalone.
- **Validated:** all 5 memory samples ran end-to-end against this resource.
- **⚠️ Secret hygiene note:** the chat/embedding model-name secrets in this flavor previously held a
  malformed value (the model name plus an inline `# Deployed models are : …` comment), which the
  service rejected with `400 ... model deployment '…' was not found`. They were corrected with
  `wr-update` to the bare deployment names (`gpt-5.2` and `text-embedding-3-large`). If a model-name
  secret ever fails this way again, inspect its value for a trailing `#` comment and re-`wr-update`
  it to the bare name. The valid deployed models on this project are `gpt-4o`, `gpt-5`, `gpt-5.2`,
  `gpt-4o-mini`, `gpt-5.2-chat`, and `text-embedding-3-large`.

### Azure AI Agents — toolboxes (Java SDK samples)

- **Resource / flavor:** `foundry-sdk-deployment` / `java`
- **Load:** `wr-load -Resource foundry-sdk-deployment -Flavor java`
- **Env vars → KeyVault secret names:**

  | Env var | KeyVault secret | Used by |
  |---------|-----------------|---------|
  | `FOUNDRY_PROJECT_ENDPOINT` | `foundry-sdk-deployment-java-foundry-project-endpoint` | all toolboxes samples |

- **Ordering:** `ToolboxSearchToolboxSample` and `ToolboxesAsyncSample` are self-contained (they
  create and delete their own toolbox). The single-operation samples share the hard-coded name
  `toolbox_created_from_java`, so run `CreateToolboxVersion` (twice — `UpdateToolbox` switches the
  default to version `2`), then `GetToolbox` / `ListToolboxes` / `GetToolboxVersion` /
  `ListToolboxVersions` / `UpdateToolbox` / `DeleteToolboxVersion`, then `DeleteToolbox` (cleanup).
- **Validated:** all 10 toolboxes samples ran end-to-end against this resource. They only need the
  project endpoint (the MCP tool points at the public `https://gitmcp.io/Azure/azure-rest-api-specs`).

### Azure AI Agents — tools (Java SDK samples)

The `tools` package has 46 samples (mostly sync/async pairs). They were validated 2026-06-11.
**Primary resource: `foundry-sdk-test6` / `java`** — it is the most complete flavor (it has every
per-tool connection-id plus the AzureAISearch and AzureFunction vars that `foundry-sdk-deployment`
lacks), so prefer it for this package. A few tools need a different resource (below).

- **Load (primary):** `wr-load -Resource foundry-sdk-test6 -Flavor java`
- **All tools samples read** `FOUNDRY_PROJECT_ENDPOINT` and `FOUNDRY_MODEL_NAME`; most also read one
  tool-specific connection-id var. Each builds the GA client (no `allowPreview` needed).

- **Per-tool extra env var → KeyVault secret (in `foundry-sdk-test6/java` unless noted):**

  | Tool sample(s) | Extra env var(s) | KeyVault secret |
  |----------------|------------------|-----------------|
  | `AgentToAgent*` | `A2A_PROJECT_CONNECTION_ID` | `foundry-sdk-test6-java-a2a-project-connection-id` |
  | `AzureAISearch*` | `AZURE_AI_SEARCH_CONNECTION_ID`, `AI_SEARCH_INDEX_NAME` | `…-azure-ai-search-connection-id`, `…-ai-search-index-name` |
  | `AzureFunction*` | `STORAGE_INPUT_QUEUE_NAME`, `STORAGE_OUTPUT_QUEUE_NAME`, `STORAGE_QUEUE_SERVICE_ENDPOINT` | `…-storage-input-queue-name`, `…-storage-output-queue-name`, `…-storage-queue-service-endpoint` |
  | `BingGrounding*` | `BING_PROJECT_CONNECTION_ID` | `…-bing-project-connection-id` |
  | `BingCustomSearch*` | `BING_CUSTOM_SEARCH_PROJECT_CONNECTION_ID`, `BING_CUSTOM_SEARCH_INSTANCE_NAME` | `…-bing-custom-search-project-connection-id`, `…-bing-custom-search-instance-name` |
  | `BrowserAutomation*` | `BROWSER_AUTOMATION_PROJECT_CONNECTION_ID` | `…-browser-automation-project-connection-id` |
  | `Fabric*` | `FABRIC_PROJECT_CONNECTION_ID` | `…-fabric-project-connection-id` |
  | `Mcp*`, `OpenApi*`, `CodeInterpreter*`, `FileSearch*`, `FunctionCall*`, `WebSearch*`, `ComputerUse*` | _(endpoint + model only)_ | — |
  | `McpWithConnection*` | `MCP_PROJECT_CONNECTION_ID` | `…-mcp-project-connection-id` |
  | `OpenApiWithConnection*` | `OPENAPI_PROJECT_CONNECTION_ID` | `…-openapi-project-connection-id` |
  | `MemorySearch*` | `AZURE_AI_CHAT_MODEL_DEPLOYMENT_NAME`, `AZURE_AI_EMBEDDING_MODEL_DEPLOYMENT_NAME` | `…-azure-ai-chat-model-deployment-name`, `…-azure-ai-embedding-model-deployment-name` |
  | `SharePointGrounding*` | `SHAREPOINT_PROJECT_CONNECTION_ID` | `…-sharepoint-project-connection-id` |
  | `ComputerUse*` | _(optional)_ `AZURE_COMPUTER_USE_MODEL_DEPLOYMENT_NAME` | `…-azure-computer-use-model-deployment-name` |

- **Samples that need a DIFFERENT resource:**

  | Tool sample(s) | Resource / flavor | Extra env var → secret |
  |----------------|-------------------|------------------------|
  | `ImageGeneration*` | `foundry-sdk-deployment` / `java` | `IMAGE_GENERATION_MODEL_DEPLOYMENT_NAME` → `foundry-sdk-deployment-java-image-generation-model-deployment-name` (`foundry-sdk-test6/java` has no image-gen var) |
  | `FabricIQ*` | `fabric-iq-resource` (unflavored) — self-contained | `FABRIC_IQ_PROJECT_CONNECTION_ID`, plus its own `FOUNDRY_PROJECT_ENDPOINT` + `FOUNDRY_MODEL_NAME` |
  | `WorkIQ*` | `fabric-iq-resource` (endpoint+model) + `work-iq-resource` (connection) | `WORK_IQ_PROJECT_CONNECTION_ID` → `work-iq-resource-work-iq-project-connection-id`. Load both: `wr-load -Resource "fabric-iq-resource,work-iq-resource"`. Both IQ connection-ids belong to the same `e2e-tests-westus2` project that `fabric-iq-resource` points at. |

- **Validated outcome (46 samples):** 31 pass end-to-end. The rest were re-checked with alternate
  models (2026-06-11) and are NOT primary-resource/model problems:
  - **ComputerUse{Sync,Async}** — needs a real `computer-use-preview` deployment. `foundry-sdk-test6`
    only has `gpt-5` (its `AZURE_COMPUTER_USE_MODEL_DEPLOYMENT_NAME` secret = `gpt-5` → `400: Tool
    computer_use_preview not supported`). `foundry-sdk-deployment/java` DOES have a real
    `computer-use-preview` model (after fixing its malformed secret). With that, the call advances
    past validation but the service then returns a retryable `500` at the response step. So run
    ComputerUse against `foundry-sdk-deployment/java` (not test6); it currently 500s service-side.
  - **CustomCodeInterpreter{Sync,Async}** — require `MCP_SERVER_URL`, which is **not present in any
    work-resources entry**; could not be run.
  - **ImageGeneration{Sync,Async}** — `foundry-sdk-deployment/java` (test6 has no image-gen var).
    Swept ALL five deployment chat models for `FOUNDRY_MODEL_NAME` (`gpt-5.2`, `gpt-4o`, `gpt-5`,
    `gpt-4o-mini`, `gpt-5.2-chat`) with `IMAGE_GENERATION_MODEL_DEPLOYMENT_NAME=gpt-image-1`; every
    one returns a retryable `500` at the response step. No model combination works — service-side.
  - **FabricIQ / WorkIQ (4)** — ran against their dedicated resources (`fabric-iq-resource` /
    `work-iq-resource`, project `e2e-tests-westus2`, model `gpt-5` — no alternate models listed).
    Auth/endpoint/connection accepted; service returns a retryable `500` (confirmed across 3
    attempts). Dedicated resources were used as intended; the 500 is service-side.
  - **Sample bugs (3):** `FileSearchAsync` and `MemorySearchAsync` call `block()` on a reactor HTTP
    thread (their sync variants pass); `McpWithConnectionSync` sends both `previous_response_id` and
    `conversation` → `400` (async variant passes).
  - **Config (1):** `OpenApiWithConnectionSync` — the OpenAPI spec defines no
    `components.securitySchemes`, required for connection-based auth.
  - **Transient:** `WebSearch*` and `OpenApi*` initially hit `429`/external-`503`/timeout but
    **passed on retry** — space these runs out and retry if they flake.

  **Net still-failing after model retries:** ComputerUse, ImageGeneration, FabricIQ, WorkIQ (all
  service-side `500`); CustomCodeInterpreter (no `MCP_SERVER_URL`); 3 sample bugs; 1 spec/config.
  No model-value combination from the vault comments resolved any of these.

- **⚠️ Secret hygiene note (applies to `foundry-sdk-test6/java` too):** several model-name secrets
  had a malformed ` # Deployed models are : …` suffix. Corrected with `wr-update`:
  - `foundry-sdk-test6-java-azure-ai-chat-model-deployment-name`=`gpt-5`
  - `foundry-sdk-test6-java-azure-ai-embedding-model-deployment-name`=`text-embedding-3-small`
  - `foundry-sdk-test6-java-foundry-model-name`=`gpt-5`
  - `foundry-sdk-deployment-java-image-generation-model-deployment-name`=`gpt-image-1`
  - `foundry-sdk-deployment-java-azure-computer-use-model-deployment-name`=`computer-use-preview`
    (was malformed; the bare value is a real computer-use model)

  If a model-name secret fails with `400 ... model deployment '…' was not found` (or a tool reports
  "not supported with <model>"), check for a trailing `#` comment and re-`wr-update` to the bare
  name. Valid deployed models — `foundry-sdk-test6`: `gpt-4.1`, `gpt-5`, `gpt-5.4`,
  `text-embedding-3-small`. `foundry-sdk-deployment`: `gpt-4o`, `gpt-5`, `gpt-5.2`, `gpt-4o-mini`,
  `gpt-5.2-chat`, `text-embedding-3-large`, `gpt-image-1`, `computer-use-preview`.


## Adding a new entry

When you verify a resource works for a feature:

1. Confirm the run is genuinely green (sample/test exits successfully against the resource).
2. Prefer an **existing** resource/flavor before introducing a new one — keep the spread minimal.
3. Add a row to the **Index** table and, if the feature needs more than a couple of env vars or
   any extra context, a matching **Entry details** subsection.
4. Record only secret **names** and tag values (`resource`, `flavor`, `env-var-name`), never
   secret values. Use `wr-list -Resource <r> -Flavor <f>` (from the `work-resources` skill) to
   discover the exact secret names.
5. If authentication needs a separate account, record both CLI profiles and the successful
   sample run in an **Authentication context** block. Keep this local profile metadata
   separate from the KeyVault secret names/tags.
