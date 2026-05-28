---
name: missing-protocol-methods
description: Add missing Azure SDK for Java protocol methods for existing convenience methods. Use when client methods need WithResponse overloads that accept RequestOptions, return Response<BinaryData>/Mono<Response<BinaryData>>, and use BinaryData for model inputs.
---

# Missing Protocol Methods for Azure SDK for Java

Use this skill when an Azure SDK for Java client has convenience methods but is missing public protocol-style methods.

A protocol method is the raw HTTP-shape overload that:

- Has the same operation name with `WithResponse` appended.
- Accepts `RequestOptions` as the last parameter.
- Returns `Response<BinaryData>` for sync clients.
- Returns `Mono<Response<BinaryData>>` for async clients.
- Accepts request body model/options-bag parameters as `BinaryData` instead of typed model classes.
- Keeps scalar/path parameters typed (`String`, `boolean`, `int`, `Path`, etc. are okay).

## Implementation workflow

1. Locate the client and async client classes.
   - Search for the convenience method name and nearby generated protocol methods.
   - Use existing methods in the same file as the pattern for JavaDoc, annotations, return types, and delegation.

2. Add the missing public `*WithResponse` method.
   - Sync shape:
     ```java
     public Response<BinaryData> operationWithResponse(..., BinaryData body, RequestOptions requestOptions)
     ```
   - Async shape:
     ```java
     public Mono<Response<BinaryData>> operationWithResponse(..., BinaryData body, RequestOptions requestOptions)
     ```
   - If there is no request body, use only scalars plus `RequestOptions`.
   - If there is an optional scalar from the convenience overload, keep it scalar.
   - If the method is a hand-written convenience method composed from multiple protocol calls, the new protocol method should execute the same flow but return the final raw `Response<BinaryData>` instead of deserializing to a typed model.

3. Update convenience methods minimally.
   - Prefer making the typed convenience method delegate to the new protocol method, then deserialize:
     ```java
     RequestOptions requestOptions = new RequestOptions();
     return operationWithResponse(..., requestOptions).getValue().toObject(MyModel.class);
     ```
   - Async:
     ```java
     RequestOptions requestOptions = new RequestOptions();
     return operationWithResponse(..., requestOptions)
         .flatMap(FluxUtil::toMono)
         .map(data -> data.toObject(MyModel.class));
     ```

4. Do not unnecessarily change access modifiers.
   - If an existing package-private/private generated protocol helper is only used internally, leave it that way.
   - Add a separate public overload for the missing public protocol API when needed.
   - It is okay for the new public method to call package-private helpers because it is in the same class.

5. Preserve code style.
   - Keep edits minimal.
   - Match surrounding annotations (`@ServiceMethod`, `@Generated` usage, line wrapping, JavaDoc style).
   - Do not disable Checkstyle or SpotBugs.

## Examples

### Selector convenience method

For a typed convenience method such as:

```java
public Connection getConnection(String name, boolean includeCredentials)
```

Add:

```java
public Response<BinaryData> getConnectionWithResponse(String name, boolean includeCredentials,
    RequestOptions requestOptions)
```

and async:

```java
public Mono<Response<BinaryData>> getConnectionWithResponse(String name, boolean includeCredentials,
    RequestOptions requestOptions)
```

The implementation can route to existing package-private generated helpers based on the boolean.

### Composed upload convenience method

For a method like:

```java
public FileDatasetVersion createDatasetWithFile(String name, String version, Path filePath, String connectionName)
```

Add:

```java
public Response<BinaryData> createDatasetWithFileWithResponse(String name, String version, Path filePath,
    String connectionName, RequestOptions requestOptions)
```

Keep `Path` and `String` typed because they are not input models. If the method internally creates a request model, send it through the existing lower-level protocol method as `BinaryData.fromObject(...)`. Return the final raw dataset creation response.

## Tests

1. Find existing tests for the convenience methods.
   - Add protocol-method tests in the same test class, next to the convenience tests.
   - Do not invent a different scenario; copy the convenience test flow and change only the call site.
   - Preserve the same annotations as the convenience test, including `@LiveOnly`.

2. Sync assertions should deserialize the response value:

```java
MyModel result = client.operationWithResponse(..., new RequestOptions())
    .getValue()
    .toObject(MyModel.class);
```

3. Async assertions should use the existing `StepVerifier` pattern:

```java
StepVerifier.create(asyncClient.operationWithResponse(..., new RequestOptions()))
    .assertNext(response -> {
        MyModel result = response.getValue().toObject(MyModel.class);
        // same assertions as convenience test
    })
    .verifyComplete();
```

4. If the convenience test is `@LiveOnly`, keep the protocol test `@LiveOnly` too. It will run live and be skipped in record/playback; that is expected.

## Running tests and recordings

Start with compile/test-compile:

```bash
mvn -q -DskipTests compile test-compile
```

When live resources are needed, use the `work-resources` skill and load the narrowest resource/flavor once. For `azure-ai-projects`, the usual Java resource is:

```powershell
wr-list -Resource foundry-sdk-deployment -Flavor java
wr-load -Resource foundry-sdk-deployment -Flavor java
```

`wr-load` writes values into `./.env`, so subsequent bash commands can use:

```bash
set -a; source .env; set +a
```

Run the targeted tests live first:

```bash
set -a; source .env; set +a
AZURE_TEST_MODE=LIVE mvn -q "-Dtest=<comma-separated Class#method+method selectors>" test
```

Then record the targeted tests:

```bash
set -a; source .env; set +a
AZURE_TEST_MODE=RECORD mvn -q "-Dtest=<same selectors>" test
```

Recordings are under the repository-root `.assets` directory, not necessarily under the module directory. Playback before pushing:

```bash
AZURE_TEST_MODE=PLAYBACK mvn -q "-Dtest=<same selectors>" test
```

Push recordings after playback succeeds:

```bash
test-proxy push -a assets.json
```

This updates `assets.json` with the new assets tag.

After using work resources, clear the env file block:

```powershell
wr-clear -Force
```

## Final validation

Run:

```bash
mvn clean install
```

If the only failure is an expected, unrelated Revapi API compatibility failure, verify the rest of the build with:

```bash
mvn clean install -Drevapi.skip=true
```

Report both results, including the Revapi failures if present.
