---
name: run-tests
description: Run project tests using Maven (mvn). Use when the user asks to run tests.
---

# Run Tests (Maven)

Use Maven (`mvn`) to run tests. Confirm you are in a directory with a `pom.xml` (project root or module root).

## Common commands

### All tests (default)
```bash
mvn test
```

### Specific module (multi-module)
```bash
mvn -pl <module> -am test
```

### Specific test class or method (Surefire)
```bash
mvn -Dtest=MyTest test
mvn -Dtest=MyTest#myMethod test
```

## Test modes (AZURE_TEST_MODE)
If the user asks for live/record/playback, set the env var for the command:
```bash
AZURE_TEST_MODE=LIVE mvn test
AZURE_TEST_MODE=RECORD mvn test
AZURE_TEST_MODE=PLAYBACK mvn test
```

## Steps
1. Ensure you’re in the correct Maven project directory (contains `pom.xml`). If not, ask for the correct path.
2. If the user provides a test name, use `-Dtest=<pattern>` and run `mvn test`.
3. If the user specifies a module, use `-pl <module> -am test`.
4. If the user specifies a test mode (LIVE/RECORD/PLAYBACK), prefix the command with `AZURE_TEST_MODE=<mode>`.
5. Otherwise, run `mvn test`.
6. If the command fails, report the error output and ask how they want to proceed.

## Notes
- If tests require secrets from KeyVault, use `wr-load` first and run tests in the same command:
```bash
eval "$(wr-load -Export bash -Resource <resource>)" && AZURE_TEST_MODE=RECORD mvn test
```
- For `azure-sdk-for-java` modules under `sdk/` (notably `sdk/ai`), the parent POM adds `src/samples/java` as test sources. If samples use newer language features, the Java 8 base-testCompile can fail. Skip sample test sources with build-helper flags:
```bash
eval "$(wr-load -Export bash -Resource <resource>)" && \
AZURE_TEST_MODE=RECORD mvn \
  -Dbuildhelper.addtestsource.skip=true -Dbuildhelper.addtestresource.skip=true \
  -Dtest=<TestClass>#<testMethod> test
```
  Example (azure-ai-agents):
```bash
eval "$(wr-load -Export bash -Resource azure-agents)" && \
AZURE_TEST_MODE=RECORD mvn \
  -Dbuildhelper.addtestsource.skip=true -Dbuildhelper.addtestresource.skip=true \
  -Dtest=AgentsTests#basicCRUDOperations test
```
- If Maven/Surefire shows JPMS/module-path errors (e.g., `okio` module issues) but IntelliJ runs fine, disable the module path to match IntelliJ’s classpath behavior:
```bash
-Dsurefire.useModulePath=false -Dmaven.surefire.useModulePath=false
```
  Example (azure-ai-agents):
```bash
eval "$(wr-load -Export bash -Resource azure-agents)" && \
AZURE_TEST_MODE=RECORD mvn \
  -Dbuildhelper.addtestsource.skip=true -Dbuildhelper.addtestresource.skip=true \
  -Dsurefire.useModulePath=false -Dmaven.surefire.useModulePath=false \
  -Dtest=AgentsTests#promptAgentTest test
```
- If async tests fail with Reactor blocking errors (Netty thread), align with IntelliJ by forcing OkHttp in tests:
```bash
AZURE_TEST_HTTP_CLIENTS=okhttp
```
  Example (azure-ai-agents async prompt test):
```bash
eval "$(wr-load -Export bash -Resource aiservices-tip,azure-common,openai)" && \
AZURE_TEST_HTTP_CLIENTS=okhttp AZURE_TEST_MODE=RECORD mvn \
  -Dbuildhelper.addtestsource.skip=true -Dbuildhelper.addtestresource.skip=true \
  -Dsurefire.useModulePath=false -Dmaven.surefire.useModulePath=false \
  -Dtest=AgentsAsyncTests#promptAgentTest test
```
- If build plugins block the run, add skip flags (example):
```bash
-Denforcer.skip=true -Dcodesnippet.skip=true -Dcheckstyle.skip=true \
-Dspotbugs.skip=true -Dspotless.skip=true -Dspotless.apply.skip=true \
-Dspotless.check.skip=true -Drevapi.skip=true -Djacoco.skip=true \
-Dmaven.javadoc.skip=true -Dshade.skip=true -Danimal.sniffer.skip=true
```
