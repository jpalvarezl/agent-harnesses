---
name: work-resources
description: Manage Azure KeyVault test/dev secrets via the work-resources `wr-*` CLI (wr-setup, wr-save, wr-update, wr-load, wr-list, wr-delete, wr-clear, wr-add-user, wr-migrate). Use for provisioning a vault, saving and updating secrets, loading secrets into the current shell as environment variables, listing/inspecting vault contents, deleting secrets, clearing loaded env vars, granting team access, or migrating legacy secrets that lack the required tags. Supports a two-dimensional `resource` + `flavor` filter for projects that mirror multi-file env folders (e.g. `.azure/<deployment>/{.env,.superset.env,.py.env,...}`).
---

# Work Resources (Azure KeyVault)

Use the `wr-*` CLI commands from the **work-resources** project to manage
secrets backed by Azure KeyVault. Secrets are organised by two tags:

- `resource` — the logical owner / deployment (e.g. `myapi`, `foundry-sdk-deployment`).
- `flavor`   — *optional* sub-category, typically used to mirror multiple
  env files for the same resource (e.g. `base`, `superset`, `py`, `js`, `net`, `java`).
  Legacy secrets without a flavor tag are still supported.

Both tags can be filtered on by `wr-load`, `wr-list`, `wr-clear`, and `wr-delete`.

## Prerequisite

The `wr-*` commands must be installed and on the user's profile.
If they are missing, instruct the user to install them from the repo:

- Repo:    `https://github.com/jpalvarezl/work-resources`
- Install: `./install.ps1` (Windows / cross-platform) or `./install.sh` (POSIX)

The `wr-*` commands wrap the Azure CLI (`az`) — `az` must also be installed
and the user logged in (`az login`). All commands run as data-plane operations
against the configured vault.

## How agents must invoke the tool

The only supported entrypoint is the `wr-*` commands the installer adds
to the user's shell profile. **Never** invoke the underlying scripts at
`~/.work-resources/scripts/*.ps1` directly, and don't fall back to
`pwsh -File <script>` if `wr-X` isn't resolving — instead, ask the user
to re-open the shell (so the profile reloads) or to re-run `install.ps1`.

## Bootstrapping a new user / machine

Before running `install.ps1` / `install.sh`, the user must put a `.env`
at the repo root (or `~/.work-resources/config/.env` after install)
with these keys:

```ini
VAULT_NAME=...           # globally unique, 3-24 chars, alphanumeric + hyphens
RESOURCE_GROUP_NAME=...
SUBSCRIPTION_ID=...      # optional; defaults to current `az` subscription
```

If the user is joining an existing team vault, ask the vault owner for
these values — do not guess. After writing `.env`, run the installer,
open a fresh shell, then `wr-setup`.

## Key rules for agents

1. **`wr-load` persists values to `./.env`** — use it to bridge ephemeral
   shells. Most modern agent harnesses (Copilot CLI, claude-code,
   pi-mono, etc.) run each shell command in a fresh process, so the env
   vars `wr-load` sets in one tool call are lost by the next. `wr-load`
   therefore **always also writes** the loaded secrets to `./.env` (in
   the current working directory) inside a fenced `# >>> work-resources
   >>>` block. Values are POSIX single-quoted (`KEY='value'`, with
   embedded single quotes escaped as `'\''`).

   `wr-clear` removes the fenced block (even from a fresh shell where
   the in-process env vars from a previous `wr-load` have already
   disappeared) and is therefore the safe way to reset both the file
   and the in-process state. User-authored content in `./.env` (outside
   the fences) is always preserved by both commands. Pass `-NoEnvFile`
   to either to opt out of the file write/removal.
2. **Minimise `wr-load` calls.** `wr-load` does N+1 network calls to KeyVault
   (one list + one show per secret). Call it at most **once per resource/flavor
   combination per session**, then reuse the populated env vars — and the
   `./.env` file — in subsequent commands. Do not call `wr-load` again
   for values you already have.
3. **Load the narrowest set you actually need.** Each per-secret round-trip to
   KeyVault is non-trivial — a full-flavor load can take seconds to minutes
   depending on size, and loading an entire vault is wasteful. Prefer the most
   specific filter you can justify, in this order:
   - **Single secret known**: `wr-load -Resource R -Flavor F -Name N` (one
     `show` call). Use this whenever the agent already knows which secret it
     needs.
   - **Single flavor of a resource**: `wr-load -Resource R -Flavor F` (the
     normal "set up one language SDK" case).
   - **Whole resource**: `wr-load -Resource R` (only when you genuinely need
     every flavor and every secret — most agent tasks do not).
   - **Whole vault**: `wr-load` with no filters. **Avoid in agent
     workflows.** This is intended for human exploration, not automation;
     it triggers a `show` call for every secret in the vault.

   If the user's intent is ambiguous, call `wr-list -Resource R [-Flavor F]`
   first (cheap — one `list` call, no per-secret `show`s) to discover the
   secret name, then load surgically with `-Name`.
4. **Always pass `-Value` to `wr-save` and `wr-update`.** Both prompt
   interactively when `-Value` is omitted; that will hang an agent session.
5. **Always pass `-Force` to destructive commands** (`wr-clear`, `wr-delete`)
   to skip the confirmation prompt.
6. **Disambiguate with `-Flavor` when multiple flavors exist for the same env
   var name.** If `wr-load -Resource X` (no `-Flavor`) selects more than one
   secret mapping to the same env-var, the tool warns and the last-loaded
   value wins — pick a specific `-Flavor` instead.
7. **Use `wr-list` before destructive operations** to verify what will be
   affected. Especially before `wr-delete -All`.
8. **Do not invent secret names.** Inspect with `wr-list` first; secret names
   in KeyVault follow `{resource}-{name}` or `{resource}-{flavor}-{name}`.

## Conventions

### Naming

| Item           | Allowed characters                                  | Notes                                              |
|----------------|-----------------------------------------------------|----------------------------------------------------|
| `-Resource`    | `^[a-zA-Z][a-zA-Z0-9-]*$`                           | Start with letter; letters, digits, hyphens only.  |
| `-Name`        | `^[a-zA-Z][a-zA-Z0-9-]*$`                           | Same rules as resource.                            |
| `-EnvVarName`  | `^[A-Za-z_][A-Za-z0-9_]*$`                          | POSIX env var name. Underscores allowed.           |
| `-Flavor`      | `^[a-z]([a-z0-9-]*[a-z0-9])?$` (case-sensitive)     | Lowercase, no leading digit/hyphen, no trailing hyphen. |

### Tags written on each secret

| Tag            | Always present? | Value                                          |
|----------------|-----------------|------------------------------------------------|
| `resource`     | Yes             | The `-Resource` value.                         |
| `env-var-name` | Yes             | The `-EnvVarName` value (mixed case preserved).|
| `flavor`       | Only when `-Flavor` was passed | The `-Flavor` value.                |

### Secret name composition

| Flavor passed? | KeyVault secret name             |
|----------------|----------------------------------|
| No             | `{Resource}-{Name}`              |
| Yes            | `{Resource}-{Flavor}-{Name}`     |

Example: `wr-save -Resource foundry-sdk-deployment -Flavor py -Name foundry-project-endpoint -EnvVarName FOUNDRY_PROJECT_ENDPOINT -Value '...'`
→ KV secret `foundry-sdk-deployment-py-foundry-project-endpoint` with tags
`resource=foundry-sdk-deployment, flavor=py, env-var-name=FOUNDRY_PROJECT_ENDPOINT`.

`wr-load`, `wr-list`, and `wr-clear` also accept `-Name` to narrow to a single
secret using the same composition. `-Name` requires `-Resource` and accepts
at most **one** `-Resource` and at most **one** `-Flavor` (multi-value lists
on either with `-Name` would make the composed match ambiguous and are
rejected). Passing an empty string for `-Name` is treated the same as
omitting it. Example:

```powershell
wr-load -Resource foundry-sdk-deployment -Flavor py -Name foundry-project-endpoint
# Loads exactly foundry-sdk-deployment-py-foundry-project-endpoint into the session.
```

### Filename → flavor convention (for `.azure/<deployment>/...` style folders)

| File           | Flavor      |
|----------------|-------------|
| `.env`         | `base`      |
| `.superset.env`| `superset`  |
| `.py.env`      | `py`        |
| `.js.env`      | `js`        |
| `.net.env`     | `net`       |
| `.java.env`    | `java`      |

## Commands

### `wr-setup`
First-time vault provisioning. Creates the resource group and vault if
missing, and assigns an RBAC role to the current user.

```powershell
wr-setup                # New vault → Officer; existing vault → User (read-only)
wr-setup -Role Admin    # Join existing vault with write access (Officer)
wr-setup -Force         # Re-run to fix permissions
```

### `wr-save`
Create or overwrite a secret. Idempotent (upsert).

```powershell
wr-save -Resource <r> -Name <n> -EnvVarName <ENV> -Value <v> [-Flavor <f>]
```

| Parameter      | Required | Notes                                                                                                                    |
|----------------|----------|--------------------------------------------------------------------------------------------------------------------------|
| `-Resource`    | Yes      | Resource tag.                                                                                                            |
| `-Name`        | Yes      | Short name; combined with `-Resource` (and `-Flavor` if set) to form the KV secret name.                                 |
| `-EnvVarName`  | Yes      | The env var that `wr-load` will set from this secret.                                                                    |
| `-Value`       | No       | **Pass it explicitly in agent contexts** — omitting it triggers an interactive masked prompt.                            |
| `-Flavor`      | No       | Set when mirroring per-file env structures or otherwise needing multiple flavors of the same env var for the same resource. |

### `wr-update`
Update an existing secret in place. Preserves any tag you do not explicitly
overwrite — including `flavor` if it was set previously.

```powershell
wr-update -Resource <r> -Name <full-kv-name> -Value <v> [-EnvVarName <ENV>] [-Flavor <f>]
```

> **Naming asymmetry to remember:** `wr-update -Name` takes the **full KV
> secret name** (e.g. `foundry-sdk-deployment-py-foundry-project-endpoint`),
> NOT the short name like `wr-save -Name`. Look it up with `wr-list` first.

The new value is also set in the current PowerShell session as
`$env:<EnvVarName>`.

### `wr-load`
Fetch secrets from KeyVault and set them as environment variables in the
current shell. **Always also writes the loaded values to `./.env` in the
current working directory**, inside a fenced `# >>> work-resources >>>`
block — see Rule #1.

```powershell
wr-load                                         # Load every secret in the vault
wr-load -Resource <r>                           # Filter by resource
wr-load -Resource "r1,r2"                       # Multiple resources
wr-load -Resource <r> -Flavor <f>               # Resource + flavor (recommended for flavored vaults)
wr-load -Resource <r> -Flavor "py,js"           # Multiple flavors
wr-load -Resource <r> -Flavor <f> -Name <n>     # Single secret: matches {r}-{f}-{n}
wr-load -Resource <r> -Export bash              # Print export commands instead of mutating session
wr-load -Resource <r> -SpawnShell               # Spawn a child shell with env vars set
wr-load -Resource <r> -NoEnvFile                # Skip the ./.env write (in-process env still set)
```

When the matched set contains multiple secrets sharing the same
`env-var-name`, `wr-load` prints a collision warning and last-loaded wins.
Resolve by adding `-Flavor` (or `-Flavor` together with `-Name` for the
surgical single-secret case; bare `-Name` will only match unflavored
secrets named `{Resource}-{Name}`, not flavored ones).

### `wr-list`
Inspect the vault. Groups output by resource, then by flavor when flavors
are present.

```powershell
wr-list                                                 # All secrets
wr-list -Resource <r>                                   # Filter by resource
wr-list -Resource "r1,r2"                               # Multiple resources
wr-list -Resource <r> -Flavor <f>                       # Resource + flavor
wr-list -Resource <r> -Flavor <f> -Name <n>             # Single secret: matches {r}-{f}-{n}
```

Read-only; does not require Officer role.

### `wr-clear`
Unset env vars that `wr-load` could have populated, AND remove the
work-resources fenced block from `./.env`. The filter narrows the set
of env-var names to clear; it does **not** verify which flavor populated
each var (the OS does not retain that provenance).

```powershell
wr-clear -Force                                 # Clear everything wr-load could set
wr-clear -Resource <r> -Force
wr-clear -Resource <r> -Flavor <f> -Force
wr-clear -Resource <r> -Flavor <f> -Name <n> -Force   # Single env var (the one {r}-{f}-{n} maps to)
wr-clear -Force -NoEnvFile                      # Clear in-process only, leave ./.env alone
```

### `wr-delete`
Delete secrets from KeyVault. Soft-delete by default per the vault's
retention policy.

```powershell
wr-delete -Resource <r> -Name <short-name> -Force                  # Single
wr-delete -Resource <r> -Flavor <f> -Name <short-name> -Force      # Single + flavor (verifies tags first)
wr-delete -Resource <r> -All -Force                                # All for resource
wr-delete -Resource <r> -All -Flavor "py,js" -Force                # All matching resource AND any flavor in list
```

With `-Name` + `-Flavor`, `wr-delete` composes `{Resource}-{Flavor}-{Name}`
AND verifies the secret's `resource` and `flavor` tags match before
deleting. This prevents accidentally nuking a legacy secret whose name
happens to collide with the composed form.

`-Flavor` accepts a comma-list only with `-All`. With `-Name`, it must be
a single token.

### `wr-add-user`
Grant or remove vault access for a teammate. Requires Officer role.

```powershell
wr-add-user -Email <upn>                        # Read-only (User)
wr-add-user -Email <upn> -Role Admin            # Read + write (Officer)
wr-add-user -Email <upn> -Remove                # Revoke
```

Only handles individual users by UPN. For granting access to an AAD security
group, fall back to `az role assignment create --assignee-object-id <group-id>
--assignee-principal-type Group --role 'Key Vault Secrets User' --scope <vault-id>`.

### `wr-migrate`
Backfill `resource` and `env-var-name` tags on legacy secrets that were
created before the tag convention. Prompts interactively for missing tag
values (so do not invoke unattended unless you can answer the prompts).

```powershell
wr-migrate -DryRun       # Show what would change
wr-migrate               # Interactive
wr-migrate -Force        # Skip the "proceed?" prompt (still prompts for tag values)
```

## RBAC roles

| Role                          | Maps to in `-Role`   | Can do                                                |
|-------------------------------|----------------------|-------------------------------------------------------|
| `Key Vault Secrets User`      | `User` (default)     | `wr-load`, `wr-list`, `wr-clear`                      |
| `Key Vault Secrets Officer`   | `Admin`              | All commands above plus `wr-save`, `wr-update`, `wr-delete`, `wr-add-user`, `wr-migrate` |

`wr-save`, `wr-update`, `wr-delete`, `wr-add-user`, and `wr-migrate` assert
the caller has Officer (or Key Vault Administrator) before doing anything.
If the assertion fails, the script exits with instructions for the user.

## Bridging ephemeral shells

When each tool call spawns a fresh shell process — typical for Copilot CLI,
claude-code, pi-mono, and similar harnesses — the in-process env vars set
by `wr-load` are gone by the next call. `wr-load` writes the values to
`./.env` (cwd) so subsequent tool calls can pick them up from disk; how
to consume that file is up to the caller. `wr-clear -Force` removes both
the in-process env vars and the fenced block from `./.env`.

## Troubleshooting

| Symptom                                                        | Likely cause                                                                                  | Fix                                                                                                            |
|----------------------------------------------------------------|-----------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------|
| `wr-* : The term '...' is not recognized`                      | CLI not installed, or shell session predates the install.                                     | Run `./install.ps1` then **restart the shell** (or `. $PROFILE.CurrentUserAllHosts`). Do not invoke the underlying scripts directly as a workaround. |
| Agent is calling `~/.work-resources/scripts/*.ps1` or `pwsh -File ...` | Misreading the install layout as the supported entrypoint.                            | Stop. The only supported entrypoint is `wr-*`. See **How agents must invoke the tool** above.                  |
| `Configuration not found. Please copy .env.template to .env`   | No `.env` at `~/.work-resources/config/.env` (or repo root for source runs).                  | Follow **Bootstrapping a new user / machine**: gather the three values from the user and write the `.env`.     |
| `You don't have write access to vault`                         | Caller has User role, not Officer.                                                            | Ask a vault admin to run `wr-add-user -Email <upn> -Role Admin`, or `wr-setup -Role Admin` to elevate.         |
| `Could not list secrets — you may need to wait for role assignment to propagate` | RBAC propagation lag (1–2 min after `wr-setup` / `wr-add-user`).                | Wait 1–2 minutes and retry.                                                                                    |
| `Multiple secrets map to $env:VAR (last loaded wins)`          | The matched set spans multiple flavors of the same env var.                                   | Add `-Flavor <name>` to `wr-load` to pick one.                                                                 |
| `Invalid flavor 'X'. Must be lowercase ...`                    | Uppercase or other invalid characters in `-Flavor`.                                           | Lowercase the value; only letters/digits/internal hyphens are allowed.                                         |
| `Single-delete mode (-Name) requires exactly one flavor`       | Comma-list `-Flavor` used with `-Name`.                                                       | Use a single flavor token with `-Name`, or switch to `-All` if you want to delete across flavors.              |
| `Tag verification failed for ...`                              | `wr-delete -Name -Flavor` composed a name that exists, but the secret's tags don't match.    | Inspect with `wr-list` to confirm what's really stored. Most likely you meant a different flavor or no flavor.  |

## Notes

- The vault config (`VAULT_NAME`, `RESOURCE_GROUP_NAME`, `SUBSCRIPTION_ID`) lives in `~/.work-resources/config/.env` after install. Edit that file to switch vaults.
- `wr-save` and `wr-update` are upserts; running them twice with the same args is safe (overwrites with the same value).
- `wr-delete` performs a soft-delete; the secret name stays reserved until purged. Re-creating with the same name immediately after delete can fail with `ObjectIsBeingDeleted` — wait ~20 s or `az keyvault secret purge` first.
- Azure CLI silently injects a `file-encoding: utf-8` tag on every set/update — it's metadata only and does not affect filtering.
- All commands accept `-Verbose` via standard PowerShell common parameters, but most progress is already on by default to stderr.
