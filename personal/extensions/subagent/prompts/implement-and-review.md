---
description: Worker implements, builds, and tests; top-level orchestrator performs one bounded final review
---
Complete this workflow with the top-level agent as the sole review orchestrator:

1. Use the "worker" agent to implement, build, and test: $@
2. Wait for the worker to finish and ensure its changes are integrated into the top-level working tree.
3. From the top-level agent, run code_review once against the complete integrated change set. Do not dispatch a reviewer subagent or ask the worker to review its own work.
4. Apply only required Critical or Warning findings supported by repository evidence. Suggestions are optional and must not trigger edits.
5. If required findings were fixed and materially changed reviewed behavior, run at most one verification code_review. Stop when the verdict is APPROVE or only Suggestions remain.

Do not use a worker-reviewer-worker chain. The worker owns implementation/build/tests; the top-level orchestrator owns the final bounded review.
