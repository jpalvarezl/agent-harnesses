# Model Chooser Core

Pure, deterministic selection primitives shared by the personal subagent and peer-agent extensions.

This directory is **not a Pi extension** and should not be added to `settings.json`. Runtime integrations will import it directly.

## Phase 1 scope

The core currently defines the contract and ranking behavior without changing any existing agent defaults:

- Optimization policies: `auto`, `quality`, `speed`, `cost`, `quality-speed`, `quality-cost`, `speed-cost`, and `balanced`.
- Transparent role defaults for `auto`.
- Separate hard constraints and soft optimization preferences.
- Canonical `provider/id` matching with ambiguous bare-ID rejection. A bare ID in the deny-oriented `excludedModels` constraint intentionally excludes that ID from every provider.
- Model/thinking-level pair selection. Reported alternatives are distinct models, each at its best-ranked thinking level.
- Confidence-adjusted quality, speed, and cost signals with provenance.
- Explicit handling of unknown signals.
- Categorical family/vendor diversity preferences for independent peers.
- Child-process resolvability as an eligibility constraint.
- Explainable decisions with alternatives, caveats, and rejection reasons.

## Signal contract

Every utility signal is normalized to `[0, 1]`, where higher is better:

- `quality: 1` means highest expected task quality.
- `speed: 1` means fastest expected completion.
- `cost: 1` means most economical expected execution.

A signal also includes confidence in `[0, 1]` and provenance. Ranking uses `value * confidence`. Missing signals are unknown—not zero-priced, free, fast, or high-quality—and are conservatively assigned zero effective utility with an explicit caveat.

Multi-dimensional policies use the geometric mean of their confidence-adjusted utilities. This treats the dimensions as joint objectives and prevents one excellent dimension from fully masking a poor or unknown one.

## Auto defaults

| Role | Resolved policy |
|---|---|
| Generic | `balanced` |
| Scout | `speed-cost` |
| Planner | `quality-speed` |
| Worker | `balanced` |
| Reviewer | `quality` |
| Code review | `quality` |
| Rubber duck | `quality` |

Rubber-duck independence is represented separately as a categorical family/vendor preference, evaluated before utility ranking. This preference can deliberately override a higher-utility same-family candidate; the decision reports that tradeoff as a caveat.

## Tests

The repository currently runs TypeScript tests directly with Node 24:

```bash
node --test personal/model-chooser/index.test.ts
```

Later phases will add Pi model adapters, subprocess resolvability checks against a fresh `ModelRuntime`, extension integration, cached external metadata, and shadow evaluation.
