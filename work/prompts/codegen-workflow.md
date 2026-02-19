Run my standard codegen + test workflow.

Inputs:
- Commit hash: {{commit}}
- Project/module path (contains tsp-location.yaml and pom.xml): {{project_path}}
- Resource for wr-load: {{resource}}
- Test mode (LIVE|RECORD|PLAYBACK): {{test_mode}}
- Test selection (optional): {{test_pattern}}
- Assets file (default assets.json): {{assets_file}}

Steps:
1. Go to the project path and confirm tsp-location.yaml exists.
2. Update the commit hash in tsp-location.yaml to the provided commit.
3. Run tsp-client update (or sync/generate if needed).
4. Run mvn test (use -Dtest if test_pattern is provided).
5. Check for duplicate classes vs openai-java (use dup-classes; search-m2 if needed).
6. Load secrets with wr-load for the given resource and rerun tests with AZURE_TEST_MODE.
7. Push recordings with test-proxy push -a assets file.

Ask for any missing inputs before executing commands.
