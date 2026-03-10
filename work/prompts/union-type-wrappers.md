Add typed union-type wrappers over BinaryData properties in generated Java models.

Inputs:
- Project path (contains tsp-location.yaml and pom.xml): {{project_path}}
- Scope (optional — specific class or property to handle): {{scope}}

Steps:
1. Go to the project path and confirm tsp-location.yaml exists. Sync TypeSpec if TempTypeSpecFiles/ is missing.
2. Scan all model classes for `BinaryData` properties.
3. Cross-reference each against the TypeSpec to classify as **union type** or **unknown**.
4. For each union type, identify the variant types (from TSP, Stainless SDK JAR, or generated Azure models).
5. Apply the union-type wrapper pattern: mark with `// AI Tooling: union type`, make BinaryData getter/setter private, add typed setters and `get*As*()` getters.
6. Update all callers (samples, tests, internal code) to use the new typed API.
7. Write serialization/deserialization unit tests for each union-typed property.
8. Compile and run all tests.

Ask for any missing inputs before executing commands.
