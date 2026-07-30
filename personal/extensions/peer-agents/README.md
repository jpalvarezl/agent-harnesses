# Peer Agents

Independent read-only Pi subprocesses for design critique and code review.

## Tools

- `rubber_duck` challenges assumptions and recommends a next step.
- `code_review` reviews committed, staged, unstaged, and untracked changes against a base ref.

Both tools accept optional model-selection fields:

- `model`: exact `provider/id` or unambiguous bare ID
- `policy`: `legacy`, `auto`, `quality`, `speed`, `cost`, `quality-speed`, `quality-cost`, `speed-cost`, or `balanced`
- `thinkingLevel`: `auto`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`

`legacy` preserves the existing opposite-family preference and high thinking. `auto` maps peer roles to `quality`. Quality/speed policies keep the preferred peer and choose a thinking preset. Cost-bearing policies may choose a cheaper peer.

## Independence and safety

- The active parent model is always excluded.
- Another coarse family/vendor is preferred before cost because independence is the purpose of a peer.
- If no opposite-family model is available, legacy mode reports a same-family fallback.
- An explicit same-family chooser selection is reported separately from a fallback.
- Peers use a fresh extension-free child catalog and fail before dispatch when the selected model cannot be resolved.
- Bare IDs matching multiple providers are rejected with canonical alternatives.
- Subprocesses receive only read-only tools (`read`, `grep`, `find`, and `ls`).

## Runtime controls

- `PI_PEER_AGENT_TIMEOUT_MS`: per-running-peer timeout; default five minutes.
- `PI_PEER_AGENT_MAX_CONCURRENCY`: concurrent peer subprocesses; default four.

Prompts, review diffs, and files read by a peer are sent to that model's configured provider. Use the tools only when that data egress is acceptable.
