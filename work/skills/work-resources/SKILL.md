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

There is exactly **one supported entrypoint**: the `wr-*` commands that the
installer adds to the user's shell profile (PowerShell functions on Windows;
shell functions on bash/zsh/fish; symlinks in `~/.local/bin` on POSIX).

- **Always** call `wr-load`, `wr-save`, `wr-list`, etc. as they appear in this
  skill — by name, with no path prefix.
- **Never** invoke the underlying PowerShell scripts directly. Specifically:
  - Do **not** run `~/.work-resources/scripts/load-env.ps1` (or any other
    script under `~/.work-resources/scripts/` / `%USERPROFILE%\.work-resources\scripts\`).
    That path is an implementation detail of the installer.
  - Do **not** clone the repo just to invoke `./scripts/*.ps1` — the README
    shows those relative paths for the *development* of the tool itself, not
    for normal use.
  - Do **not** call `pwsh -File <script>` as a workaround. If `wr-X` isn't
    resolving, fix the shell environment (see below), don't bypass it.

If `wr-X` is not found in a fresh shell after a successful install, the
fix is almost always one of:

1. **The shell was opened before install completed.** Open a new shell so
   the updated profile loads.
2. **The profile didn't get sourced.** In PowerShell: `. $PROFILE.CurrentUserAllHosts`.
   In bash/zsh: `source ~/.bashrc` / `source ~/.zshrc`. In fish: start a new shell.
3. **The install didn't actually run for the current user/shell.** Re-run
   `./install.ps1` from a clone of the repo. The installer is idempotent.

To verify availability without invoking a network operation:

```powershell
Get-Command wr-load -ErrorAction SilentlyContinue   # pwsh
```

```bash
command -v wr-load                                   # bash/zsh
type wr-load                                         # fish
```

If the command isn't present, fall back to the install/repair steps above
before attempting any work — do **not** try to find and execute the scripts
directly.

## Bootstrapping a new user / machine

Before the installer can complete, the user needs a `.env` file with three
values. Ask the user for these **before** running `install.ps1` / `install.sh`:

| Key                  | Value                                                                                                |
|----------------------|------------------------------------------------------------------------------------------------------|
| `VAULT_NAME`         | Globally unique KeyVault name (3–24 chars, alphanumeric + hyphens, must start with a letter).        |
| `RESOURCE_GROUP_NAME`| Azure resource group containing the vault.                                                           |
| `SUBSCRIPTION_ID`    | (Optional) Azure subscription ID. Leave blank to use the user's current `az` default subscription.   |

Where the user gets these values depends on the scenario:

- **Joining an existing team vault** (most common): the vault owner already
  set these values. Ask them, or look in any onboarding message / `wr-add-user`
  invite they received. Do NOT make these up.
- **Creating a brand-new vault**: the user picks `VAULT_NAME` and
  `RESOURCE_GROUP_NAME` themselves. Confirm the chosen `VAULT_NAME` is not
  already taken across all of Azure (the `az keyvault create` call will fail
  with a clear error if it is).

Write the answers to **one** of these locations (the installer reads from
both, preferring the install location once it exists):

| Stage                          | Path                                                         |
|--------------------------------|--------------------------------------------------------------|
| Before first install           | `<repo-clone>/.env` (gitignored; created from `.env.template`)|
| After install (to change vault)| `~/.work-resources/config/.env`                              |

Example content:

```ini
# Azure KeyVault Configuration
VAULT_NAME=ai-foundry-test-secrets
RESOURCE_GROUP_NAME=openai-test-rg
SUBSCRIPTION_ID=e72e5254-f265-4e95-9bd2-9ee8e7329051
```

The bootstrap sequence is:

1. Clone the repo (or `cd` into an existing clone).
2. Ask the user for the three values; write them to `<repo>/.env`.
3. Run `./install.ps1` (Windows / cross-platform) or `./install.sh` (POSIX).
4. **Start a new shell** so the profile changes take effect.
5. Run `wr-setup` to join (or create) the vault and assign the RBAC role.
6. Verify with `wr-list`.

## Key rules for agents

1. **Minimise `wr-load` calls.** `wr-load` does N+1 network calls to KeyVault
   (one list + one show per secret). Call it at most **once per resource/flavor
   combination per session**, then reuse the populated env vars in subsequent
   commands. Do not call `wr-load` again for values you already have in this
   shell.
2. **Always pass `-Value` to `wr-save` and `wr-update`.** Both prompt
   interactively when `-Value` is omitted; that will hang an agent session.
3. **Always pass `-Force` to destructive commands** (`wr-clear`, `wr-delete`)
   to skip the confirmation prompt.
4. **Disambiguate with `-Flavor` when multiple flavors exist for the same env
   var name.** If `wr-load -Resource X` (no `-Flavor`) selects more than one
   secret mapping to the same env-var, the tool warns and the last-loaded
   value wins — pick a specific `-Flavor` instead.
5. **Use `wr-list` before destructive operations** to verify what will be
   affected. Especially before `wr-delete -All`.
6. **Do not invent secret names.** Inspect with `wr-list` first; secret names
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
current shell.

```powershell
wr-load                                         # Load every secret in the vault
wr-load -Resource <r>                           # Filter by resource
wr-load -Resource "r1,r2"                       # Multiple resources
wr-load -Resource <r> -Flavor <f>               # Resource + flavor (recommended for flavored vaults)
wr-load -Resource <r> -Flavor "py,js"           # Multiple flavors
wr-load -Resource <r> -Export bash              # Print export commands instead of mutating session
wr-load -Resource <r> -SpawnShell               # Spawn a child shell with env vars set
```

When the matched set contains multiple secrets sharing the same
`env-var-name`, `wr-load` prints a collision warning and last-loaded wins.
Resolve by adding `-Flavor`.

### `wr-list`
Inspect the vault. Groups output by resource, then by flavor when flavors
are present.

```powershell
wr-list                                                 # All secrets
wr-list -Resource <r>                                   # Filter by resource
wr-list -Resource "r1,r2"                               # Multiple resources
wr-list -Resource <r> -Flavor <f>                       # Resource + flavor
```

Read-only; does not require Officer role.

### `wr-clear`
Unset env vars that `wr-load` could have populated. The filter narrows the
set of env-var names to clear; it does **not** verify which flavor populated
each var (the OS does not retain that provenance).

```powershell
wr-clear -Force                                 # Clear everything wr-load could set
wr-clear -Resource <r> -Force
wr-clear -Resource <r> -Flavor <f> -Force
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

## Workflows

### Load secrets and run tests in one shell
```powershell
wr-load -Resource myapi -Flavor py
pytest                              # or npm test, etc.
wr-clear -Resource myapi -Force     # optional cleanup
```

### Save multiple secrets for a resource
```powershell
wr-save -Resource myapi -Name api-key      -EnvVarName MYAPI_API_KEY      -Value '...'
wr-save -Resource myapi -Name api-secret   -EnvVarName MYAPI_API_SECRET   -Value '...'
wr-save -Resource myapi -Name endpoint     -EnvVarName MYAPI_ENDPOINT     -Value 'https://api.example.com'
wr-list -Resource myapi             # verify
```

### Mirror a `.azure/<deployment>/` env folder (verbatim, with flavors)
```powershell
# For each (deployment, file, VAR=VAL line):
wr-save -Resource <deployment> -Flavor <flavor> -Name <kebab(VAR)> -EnvVarName <VAR> -Value <VAL>

# Then to consume only the .py.env subset:
wr-load -Resource <deployment> -Flavor py
```

### Rotate a single secret value
```powershell
# Find the exact KV secret name first
wr-list -Resource myapi -Flavor py
# Then update (use the FULL kv secret name for wr-update -Name)
wr-update -Resource myapi -Flavor py -Name myapi-py-api-key -Value '<new-value>'
```

### Onboard a teammate
```powershell
wr-add-user -Email teammate@company.com                # read-only by default
wr-add-user -Email teammate@company.com -Role Admin    # writer
```

## Steps for the agent

1. **Detect availability.** Check whether the user already has the `wr-*` commands on PATH (`Get-Command wr-load -ErrorAction SilentlyContinue` in pwsh; `command -v wr-load` in bash/zsh; `type wr-load` in fish). If they are missing, follow **Bootstrapping a new user / machine** above; do **not** locate the underlying scripts and invoke them directly.
2. **Detect Azure auth.** If a command fails because the user is not logged in, instruct them to run `az login` once; do not retry in a loop.
3. **Reach for `wr-list` first** when the user's request lacks a specific resource/flavor/name. Show them the inventory, then ask which slice they want.
4. **Choose the right command** for the user's intent:
   - read values into the shell → `wr-load`
   - inspect what's stored → `wr-list`
   - add a new secret → `wr-save`
   - rotate an existing value → `wr-update`
   - remove a secret → `wr-delete`
   - undo a load in the current session → `wr-clear`
   - bootstrap a new vault → `wr-setup`
   - share access → `wr-add-user`
   - fix legacy untagged secrets → `wr-migrate`
5. **For `wr-save` / `wr-update` always pass `-Value`** — never let the script prompt interactively.
6. **For `wr-clear` / `wr-delete` always pass `-Force`** — never let the script prompt interactively.
7. **For multi-flavor vaults, always pass `-Flavor`** on `wr-load` unless you genuinely want every flavor. The collision warning is a signal that you should have.
8. **After `wr-load` succeeds, cache the values** (they live in env vars for the rest of the session). Do not call `wr-load` again for the same `(Resource, Flavor)` pair.

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
