Override a TypeSpec field type so that generated Java uses a specific Java type.

Inputs:
- Model name (TypeSpec name): {{model}}
- Field name (TypeSpec name, e.g. created_at): {{field}}
- Desired Java type: {{java_type}}
- Project path (contains tsp-location.yaml): {{project_path}}
- Local azure-rest-api-specs checkout (optional): {{spec_repo_path}}

Steps:
1. Go to the project path and confirm tsp-location.yaml and TempTypeSpecFiles/ exist. If TempTypeSpecFiles/ is missing, run `tsp-client sync` first.
2. Search the .tsp files to find the model and field definition. Confirm the current TypeSpec type.
3. Determine if a TypeSpec built-in scalar maps to the desired Java type (e.g. utcDateTime → OffsetDateTime). If yes, use Form A. If not, use Form B (external type on the type definition).
4. Edit TempTypeSpecFiles/**/client.java.tsp — add the @@alternateType decorator.
5. Run `tsp-client generate --save-inputs`.
6. Verify the generated Java file uses the expected type in fields, getters, and deserialization.
7. If spec_repo_path was provided, apply the same client.java.tsp edits there (derive the file path from the `directory` field in tsp-location.yaml). TempTypeSpecFiles is volatile — changes there are lost on the next tsp-client sync/update.
8. Remind the user to open a PR in Azure/azure-rest-api-specs with the client.java.tsp changes.

Ask for any missing inputs before executing commands.
