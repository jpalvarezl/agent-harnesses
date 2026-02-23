---
description: Fix Java codegen parameter names ending with '1' due to TypeSpec model naming collisions
---
Fix generated Java client parameter names that end with a numeric suffix (e.g. `createAgentRequest1`).

Inputs:
- Project path (contains tsp-location.yaml): $1
- Local azure-rest-api-specs checkout (optional): $2

Steps:
1. Go to the project path and confirm tsp-location.yaml and TempTypeSpecFiles/ exist. If TempTypeSpecFiles/ is missing, run `tsp-client sync` first.
2. Search the generated *Client.java files for parameter names ending with `1` (e.g. `Request1`). Also check for `*Request1.java` files under `implementation/models/`.
3. For each affected name, find the corresponding TypeSpec `model` in the `.tsp` files under TempTypeSpecFiles/. Confirm it is a `model` (not an `alias`) and is spread (`...ModelName`) into an operation.
4. Edit the `client.tsp` customization file in TempTypeSpecFiles/ — add `@@clientName` directives to rename the colliding models (e.g. `*Request` → `*Input`).
5. Run `tsp-client generate --save-inputs`.
6. Verify: zero `Request1` matches in the client files, old `*Request1.java` files are gone, build compiles.
7. If a spec repo path was provided, apply the same `client.tsp` edits there (derive the file path from the `directory` field in tsp-location.yaml). TempTypeSpecFiles is volatile — changes there are lost on the next tsp-client sync/update.

Ask for any missing inputs before executing commands.
