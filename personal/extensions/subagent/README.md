# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # Implementation, builds, and tests (+ rubber duck)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> top-level bounded review
```

## Installation

This extension lives at `personal/extensions/subagent/` in the agent-harnesses repo
and is registered in `~/.pi/agent/settings.json` under `"extensions"`. The agent and
prompt files are symlinked into pi's discovery directories:

```bash
EXT="$(pwd)/personal/extensions/subagent"

# Agents -> ~/.pi/agent/agents (user-level, always loaded)
mkdir -p ~/.pi/agent/agents
for f in "$EXT"/agents/*.md; do ln -sf "$f" ~/.pi/agent/agents/"$(basename "$f")"; done

# Workflow prompts -> ~/.pi/agent/prompts
mkdir -p ~/.pi/agent/prompts
for f in "$EXT"/prompts/*.md; do ln -sf "$f" ~/.pi/agent/prompts/"$(basename "$f")"; done
```

Then add `personal/extensions/subagent` to the `"extensions"` array in
`~/.pi/agent/settings.json` and **fully restart pi** (new extensions are not picked up by `/reload`).

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

Child processes run with extension discovery disabled. The harness explicitly loads only the `rubber_duck` child entry point, so workers can consult an independent design peer but cannot recursively invoke `code_review`, `subagent`, or unrelated extensions. The top-level orchestrator owns final review after all worker changes are integrated.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

**Approval is not caller-controllable (fail closed).** The project-agent confirmation cannot be disabled via a tool parameter, so a prompt-injected or mistaken parent model cannot silently run repo-controlled agents. When project agents are requested:
- Interactive session: the tool prompts for human confirmation and refuses on cancel.
- Non-interactive session (no UI): the tool **refuses** to run project agents.
- Escape hatch for trusted automation: set the out-of-band env var `SUBAGENT_TRUST_PROJECT_AGENTS=1` (`true`/`yes` also accepted) to skip the prompt. Only use this for repositories you fully trust.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

All modes accept optional `model`, `policy`, and `thinkingLevel` fields. In single mode they apply to that call. In `tasks`/`chain` mode, top-level `policy` and `thinkingLevel` act as defaults and each item may override them; exact `model` remains per item. Omitting chooser fields preserves the legacy model-inheritance behavior.

## Parallel Isolation (git worktrees)

Because each subagent is a separate `pi` process, parallel write-capable agents can race on the same files (there is no shared file-mutation queue across processes). To make parallel writes safe, use **git-worktree isolation** — the harness (not the LLM) gives each task its own worktree/branch and merges the results back.

```jsonc
{
  "tasks": [ { "agent": "worker", "task": "..." }, { "agent": "worker", "task": "..." } ],
  "isolation": "git-worktree",
  "mergeStrategy": "clean-only",   // only supported policy for now
  "buildCommand": "npm run build", // optional: run after each clean merge; failure rolls back that merge
  "cleanup": "on-success"          // on-success (default) | never
}
```

Mechanics (all harness-owned, not prompt instructions):
1. **Preconditions (fail closed):** the cwd must be inside a git repo and the working tree must be clean. Otherwise the tool refuses and dispatches nothing.
2. Creates one worktree + branch per task in a temp dir (outside the repo, so it never pollutes `git status`), each branched off `HEAD`.
3. Runs each agent with its cwd forced into its worktree — agents cannot collide on files.
4. After each agent finishes, the harness commits that worktree (`git add -A && git commit`).
5. Merges branches sequentially into the parent checkout with `--no-ff`, **clean-merge-only**:
   - **Conflict** → merge aborted, branch + worktree **preserved** for manual resolution.
   - **`buildCommand` fails** after a clean merge → that merge is **rolled back** (`git reset --hard` + `git clean -fd` to drop generated files) and the branch preserved.
   - **Commit fails** (e.g. missing git identity) or the **agent fails** → not merged, worktree/branch **preserved** (never silently discarded).
   - **Abort (Ctrl+C)** after agents finish → stops before further merges; already-merged work stays, unprocessed worktrees are preserved.
6. Cleanup per `cleanup`: `on-success` removes merged/no-change worktrees and preserves failures; `never` keeps all. **Failed tasks are always preserved** so their work stays recoverable.

> **`buildCommand` runs an arbitrary shell command** in the parent checkout. It is convenient but is real code execution — only pass build commands you trust. (In the default coding-agent context the parent already has a bash tool, so this is not a new capability; in locked-down deployments, treat it as one.)

**Conflicts are never auto-resolved.** The tool reports which branches/worktrees were preserved so you (or the orchestrator, in a follow-up) can finish the merge manually. The result includes a `## Merge report` section and sets `isError` if any task failed to merge.

Isolation applies to **parallel `tasks` mode only** (that is where races occur). Single/chain modes are inherently serialized.

## Model Selection

### Optimization policies

Set `policy` to let the chooser select a model/thinking-level pair. The tool schema also accepts `legacy` (the compatibility default) to preserve normal model inheritance:

- `auto` — resolve from the agent role (`scout` → `speed-cost`, `planner` → `quality-speed`, `worker` → `balanced`, `reviewer` → `quality`)
- `quality`, `speed`, or `cost`
- `quality-speed`, `quality-cost`, or `speed-cost` — joint objectives
- `balanced` — jointly optimize all three

Set `thinkingLevel` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`) to require a particular supported level, or `auto` (the default) to let the chooser decide. Policies are opt-in: omitted/`legacy` policy plus omitted/`auto` thinking uses the unchanged legacy path. These sentinel values prevent strict tool callers from accidentally materializing `auto` policy or `off` thinking when optional fields are expanded.

```jsonc
// Single: optimize automatically for the agent role
{ "agent": "scout", "task": "Map the auth flow", "policy": "auto" }

// Parallel: top-level policy is the default; the reviewer overrides it
{
  "policy": "speed-cost",
  "tasks": [
    { "agent": "scout", "task": "Find relevant files" },
    { "agent": "reviewer", "task": "Audit the design", "policy": "quality" }
  ]
}
```

The chooser uses Pi's positive input + output list-price reference rate for cost-bearing policies. Zero/default prices are unknown, not free. Quality and speed policies are explicit thinking-level presets on the inherited/pinned model; they are not benchmark-backed cross-model claims.

### Precedence and compatibility

Subagents first resolve a baseline model in this order:

1. Explicit `model` on the tool call / task / chain item
2. Session default set with `/subagent-model`
3. Agent frontmatter `model:`
4. **Inherited active session model**
5. Child CLI default

Then policy semantics apply: exact/session/frontmatter choices stay pinned while policy selects their thinking level; non-cost quality/speed policies also keep the inherited model; a cost-bearing policy may replace only the inherited/default model with a cheaper child-resolvable model.

A `model` value may be canonical `provider/id` (recommended) or an unambiguous bare `id`. Unavailable candidates are skipped and reported. Ambiguous bare IDs no longer select an arbitrary provider; qualify them with the provider. Exact per-task models are child-verified even when no policy/thinking field is supplied.

Chooser-enabled calls verify models against a cached fresh child-runtime catalog. A model known only to the parent process is not selected for a child. If the fresh catalog cannot be loaded, no eligible model remains, or the requested thinking level is unsupported, the task fails before dispatch with a diagnostic instead of silently running a different model.

**`/subagent-model`** — pick a session-scoped default model for subagents:
- `/subagent-model` — interactive picker over available models (plus "inherit active session model")
- `/subagent-model github-copilot/claude-sonnet-4.5` — set directly
- `/subagent-model` then choose inherit, or set an empty value — clear the pin

The pin is per session and resets on new/resumed sessions. The parent LLM can still override it per task via the `model` parameter. A pin is stronger than `policy`; the policy still chooses a compatible thinking level for the pinned model.

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status
- Returns each completed task's final output to the parent model, capped at 50 KB per task
- Returns failure diagnostics from stderr/error messages when a child exits before producing output

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
# Optional. Omit to inherit the active session model (recommended for
# provider portability). If set, it is only used when available; otherwise
# the tool falls back per the Model Selection precedence above.
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

**Locations:**
- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | inherits session | read, grep, find, ls, bash |
| `planner` | Implementation plans | inherits session | read, grep, find, ls |
| `reviewer` | Code review | inherits session | read, grep, find, ls, bash |
| `worker` | Implement, build, and test | inherits session | read, grep, find, ls, bash, edit, write, rubber_duck |

The sample agents no longer pin a model, so they inherit the active session model by default. Use `/subagent-model` or a per-task `model` to run cheaper/faster models (e.g. for scout recon).

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → one top-level review → required fixes → at most one verification |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
- **Parallel write races:** each subagent is a separate `pi` process, so the per-file mutation queue is NOT shared across them. Running multiple write-capable agents (e.g. `worker`) in parallel on overlapping files can race and overwrite each other's changes. For parallel writes, use **`isolation: "git-worktree"`** (see [Parallel Isolation](#parallel-isolation-git-worktrees)); otherwise prefer read-only agents (restricted `tools:`) in parallel mode, and use `chain` for write-heavy work that must be serialized.
- Git-worktree isolation uses `clean-merge-only`: it never auto-resolves conflicts. LLM-assisted conflict resolution is intentionally not implemented yet (planned behind build/test validation).
