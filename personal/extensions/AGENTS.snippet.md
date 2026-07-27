# Global AGENTS.md snippet — pi extensions

This is the **source of truth** for the usage guidance that belongs in the
**global** `~/.pi/agent/AGENTS.md` (which pi loads into every session on the
machine, in every project).

## How to install / update on a machine

Do a plain targeted markdown edit — no script needed:

1. Open `~/.pi/agent/AGENTS.md` (create it if it does not exist).
2. If the `<!-- BEGIN agent-harnesses:pi-extensions -->` … `<!-- END agent-harnesses:pi-extensions -->`
   markers are already present, **replace everything between them** with the block below.
   Otherwise, **append** the whole block (markers included).
3. Restart pi (context-file changes are picked up on startup / `/reload`).

Keep the markers intact so future updates stay a clean between-the-markers replace.

---

<!-- BEGIN agent-harnesses:pi-extensions (managed — replace between markers on update) -->
## pi subagent & peer tooling

These user-scoped pi extensions are available in **every** session on this machine.

### `subagent` — delegate to isolated child agents
- Modes: `{agent, task}` (single), `{tasks: [...]}` (parallel), `{chain: [...]}` (sequential; `{previous}` is replaced with the prior step's output).
- Each child runs in its own context window. Use it to fan out recon/review or to split genuinely independent work — not for trivial single steps.
- **Models:** children inherit the active session model by default. Set a cheaper session default with `/subagent-model`, or pass a per-task `model`. Do **not** hard-code provider-specific model IDs in tasks.
- **Parallel writes can race.** For parallel tasks that MODIFY files, pass `isolation: "git-worktree"`: each task runs in its own worktree/branch and the harness merges them back (clean-merge-only). Requires a clean git tree. Conflicts are **preserved for manual resolution — never auto-resolved**. Optional `buildCommand` gates each merge; `cleanup` = `on-success` (default) | `never` | `always`.
- Prefer read-only agents (`scout`, `planner`, `reviewer`) for parallel non-isolated work; use `worker` (full tools) only with isolation, or serialize writes via `chain`.
- Project-local agents (`.pi/agents/*.md`) require `agentScope: "both"` and human approval; they are refused non-interactively.

### `rubber_duck` / `code_review` — independent peer review
- `rubber_duck`: pressure-test a design, decision, or stuck reasoning with an independent, preferably opposite-family model.
- `code_review`: review the local diff after substantive changes and before `git push` / `gh pr create`. Advisory — always still run the tests.
<!-- END agent-harnesses:pi-extensions -->
