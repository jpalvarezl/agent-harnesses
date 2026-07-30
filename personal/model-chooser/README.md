# Model Chooser

Small deterministic helpers shared by the personal subagent and peer-agent extensions. This directory is **not a Pi extension** and should not be added to `settings.json`.

## What it does

- Resolves canonical `provider/id` model references and rejects ambiguous bare IDs.
- Confirms a model exists in a fresh child Pi runtime before dispatch.
- Preserves exact task/session/frontmatter model pins.
- Selects the cheapest known child-resolvable model for cost-bearing policies.
- Selects a supported thinking-level preset for all policies.
- Prefers another coarse model family/vendor for independent peer agents.
- Keeps legacy behavior when chooser fields are omitted.

## Honest policy semantics

Quality and speed are **thinking presets**, not cross-model measurements. The chooser has no benchmark quality or observed latency data and does not pretend otherwise.

| Policy | Model behavior | Thinking preset |
|---|---|---|
| `quality` | inherited/pinned | highest supported |
| `speed` | inherited/pinned | lowest supported |
| `cost` | cheapest known | lowest supported |
| `quality-speed` | inherited/pinned | middle |
| `quality-cost` | cheapest known | high |
| `speed-cost` | cheapest known | lowest |
| `balanced` | cheapest known | middle |
| `auto` | resolves to a role policy | that policy's preset |

`auto` maps scout → `speed-cost`, planner → `quality-speed`, worker/generic → `balanced`, and reviewer/code-review/rubber-duck → `quality`.

Cost is Pi's positive input + output list-price reference rate. Missing/all-zero pricing is unknown, not free. For subscription providers this may not represent actual credits or billing.

Peer family/vendor diversity is categorical and outranks cost because independence is the purpose of rubber-duck and review agents.

## Tool compatibility

Strict-tool enums use sentinel-first defaults:

- `policy: "legacy"` preserves existing behavior.
- `thinkingLevel: "auto"` lets the chooser select the preset.

Top-level policy/thinking values default parallel and chain items; item values override them.

## Tests

```bash
node --test personal/model-chooser/*.test.ts
```
