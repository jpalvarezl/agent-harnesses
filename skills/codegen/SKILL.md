---
name: codegen
description: Generate code from TypeSpec via tsp-client (update, sync, generate). Requires a tsp-location.yaml in the current working directory. Supports updating the commit hash before running.
---

# TypeSpec Code Generation (tsp-client)

Use this skill to run `tsp-client` workflows for projects that include a `tsp-location.yaml` file.

## Preconditions
- You must be in the directory that contains `tsp-location.yaml`.
- If the file is missing, warn the user and ask for the correct directory (do not run commands).

## Commit hash update
If the user provides a commit hash, update the `commit:` field in `tsp-location.yaml` **before** running tsp-client.
- Read the file and locate the `commit:` line.
- Replace the value with the provided hash (keep the same key name and formatting).
- Example:
  - Before: `commit: 6267b6...`
  - After:  `commit: <new_hash>`

## Commands

### `tsp-client update`
Pull the latest codegen tooling or definitions (default action when the user is vague).
```bash
tsp-client update
```

### `tsp-client sync`
Fetch/sync TypeSpec inputs for the project.
```bash
tsp-client sync
```

### `tsp-client generate`
Generate code from TypeSpec inputs.
```bash
tsp-client generate
```

Keep the synced TypeSpec inputs:
```bash
tsp-client generate --save-inputs
```

## Steps
1. Verify `tsp-location.yaml` exists in the current directory. If not, stop and ask for the correct location.
2. If the user provided a commit hash, update the `commit:` value in `tsp-location.yaml`.
3. Determine the user intent:
   - **Update**: run `tsp-client update`.
   - **Sync/fetch**: run `tsp-client sync`.
   - **Generate**: run `tsp-client generate` (use `--save-inputs` if the user wants to keep inputs).
4. If the user doesn’t specify, default to `tsp-client update`.
5. If the project defines or creates a `TempTypeSpecFiles` folder and the user wants code generation, run `tsp-client generate` (with `--save-inputs` if requested).
