import assert from "node:assert/strict";
import test from "node:test";
import {
  AsyncSemaphore,
  capTailText,
  capText,
  positiveIntegerFromEnv,
} from "./runtime-utils.ts";

test("capText preserves valid UTF-8 at a byte boundary", () => {
  assert.deepEqual(capText("a🙂b", 5), { text: "a🙂", truncated: true });
  assert.deepEqual(capText("a🙂b", 4), { text: "a", truncated: true });
});

test("capTailText keeps the end and preserves valid UTF-8", () => {
  assert.deepEqual(capTailText("a🙂b", 5), { text: "🙂b", truncated: true });
  assert.deepEqual(capTailText("a🙂b", 2), { text: "b", truncated: true });
});

test("positiveIntegerFromEnv rejects invalid limits", () => {
  assert.equal(positiveIntegerFromEnv("12", 4), 12);
  assert.equal(positiveIntegerFromEnv("0", 4), 4);
  assert.equal(positiveIntegerFromEnv("1.5", 4), 4);
  assert.equal(positiveIntegerFromEnv(undefined, 4), 4);
});

test("AsyncSemaphore queues work above the concurrency limit", async () => {
  const semaphore = new AsyncSemaphore(1);
  const releaseFirst = await semaphore.acquire();
  let secondAcquired = false;
  const second = semaphore.acquire().then((release) => {
    secondAcquired = true;
    return release;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondAcquired, false);

  releaseFirst();
  const releaseSecond = await second;
  assert.equal(secondAcquired, true);
  releaseSecond();
});

test("AsyncSemaphore removes an aborted queued waiter", async () => {
  const semaphore = new AsyncSemaphore(1);
  const release = await semaphore.acquire();
  const controller = new AbortController();
  const queued = semaphore.acquire(controller.signal);
  controller.abort();

  await assert.rejects(queued, /aborted while waiting/);
  release();

  const releaseAfterAbort = await semaphore.acquire();
  releaseAfterAbort();
});
