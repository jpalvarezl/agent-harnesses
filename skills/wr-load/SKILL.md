---
name: wr-load
description: Manage Azure KeyVault work resources via the work-resources CLI (wr-setup, wr-save, wr-update, wr-load, wr-list, wr-delete, wr-clear, wr-migrate). Use for provisioning, listing, loading, saving, updating, deleting, or clearing secrets.
---

# Work Resources (Azure KeyVault)

Use the `wr-*` CLI wrappers from the work-resources project to manage secrets for test/dev resources.

## Project location
- Repo: `~/Code/work/work-resources`
- CLI wrappers: `~/Code/work/work-resources/bin/wr-*`
- Docs: `~/Code/work/work-resources/README.md`

## General guidance
- Prefer the `wr-*` commands (they wrap the PowerShell scripts correctly).
- If the user asks for available resources, run `wr-list`.
- If the CLI isn’t installed in the shell, use the project installers:
  - macOS/Linux/WSL: `~/Code/work/work-resources/install.sh`
  - Windows: `~/Code/work/work-resources/install.ps1`
- Only uninstall on explicit request: `uninstall.sh` or `uninstall.ps1`.

## Commands

### `wr-setup`
Initial KeyVault setup (creates resource group/vault and assigns permissions).
```bash
wr-setup
wr-setup -Force
```

### `wr-save`
Save a new secret (prompts for value if omitted).
```bash
wr-save -Resource <resource> -Name <secret-name> -EnvVarName <ENV_VAR> [-Value <value>]
```

### `wr-update`
Update an existing secret (value and/or env var name).
```bash
wr-update -Resource <resource> -Name <secret-name> [-EnvVarName <ENV_VAR>] [-Value <value>]
```

### `wr-load`
Load secrets into the current shell session.
```bash
wr-load
wr-load -Resource <resource>
wr-load -Resource "res1,res2"
wr-load -SpawnShell
```

**Note for pi:** environment changes don’t persist across tool calls. If you need the variables for a single command, combine them in one call:
```bash
eval "$(wr-load -Export bash -Resource <resource>)" && <your-command>
```

### `wr-list`
List secrets in the vault (optionally by resource prefix).
```bash
wr-list
wr-list -Resource <resource>
```

### `wr-clear`
Clear loaded secrets from the current session.
```bash
wr-clear
wr-clear -Resource <resource>
wr-clear -Force
```

### `wr-delete`
Delete secrets from the vault.
```bash
wr-delete -Resource <resource> -Name <secret-name> [-Force]
wr-delete -Resource <resource> -All [-Force]
```

### `wr-migrate`
Maintenance tool to add missing tags (`env-var-name`, `resource`).
```bash
wr-migrate -DryRun
wr-migrate
wr-migrate -Force
```

## Steps
1. Determine which `wr-*` command matches the user request.
2. If the request requires a resource name and it’s missing, run `wr-list` and ask the user to pick one.
3. Execute the appropriate `wr-*` command with the user’s parameters.
