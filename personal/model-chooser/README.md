# Model Chooser Core

Pure, deterministic selection primitives shared by the personal subagent and peer-agent extensions.

This directory is **not a Pi extension** and should not be added to `settings.json`. Runtime integrations will import it directly.

## Scope

The core defines the contract and ranking behavior. Phase 2 adds an opt-in Pi adapter used by the subagent and peer-agent extensions while preserving their legacy behavior when chooser fields are omitted:

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

## Pi adapter and Phase 2 integration

`pi-adapter.ts` converts Pi's authenticated catalog into candidates, derives supported thinking variants, infers broad family/vendor identities, and compares parent models with a memoized fresh child `ModelRuntime` catalog. Chooser-enabled child calls require confirmed child resolvability; unknown or runtime-only entries fail closed. The extension-free catalog exactly matches peer children (`--no-extensions`) and is intentionally conservative for subagent children that may load provider extensions.

Initial signals are deliberately limited:

- Cost uses normalized positive Pi catalog input + output rates. All-zero/default pricing is unknown, not free.
- Quality and speed use low-confidence thinking-effort priors to distinguish reasoning levels; they do not claim that one model family is intrinsically better or faster.
- Higher thinking receives a quality prior and lower speed/cost priors.

The subagent and peer-agent extensions expose `policy`, `thinkingLevel`, and exact `model` fields. Their strict-tool enums use sentinel-first defaults: `policy: "legacy"` preserves existing behavior and `thinkingLevel: "auto"` lets the chooser decide. This prevents strict callers that materialize optional fields from accidentally opting into the first optimization policy or forcing thinking off. The eight optimization policies remain `auto`, the three single dimensions, three two-way combinations, and `balanced`.

## models.dev enrichment

Phase 3 adds a projected models.dev catalog with exact route matching, canonical vendor resolution, and provenance/freshness metadata. Pi remains authoritative for availability, capabilities, positive route prices, and child resolvability. models.dev can:

- refine canonical vendor and source-specific model family/tier identity (including punctuation aliases and unique name+family aliases such as MAI), while preserving coarse `claude`/`gpt`/`gemini` families for peer-independence decisions;
- supply an exact same-route list price only when Pi pricing is missing or all-zero;
- never introduce a new selectable model or borrow another provider route's price.

For subscription routes such as GitHub Copilot, that fallback price is explicitly a low-confidence list-price proxy. It may not match premium-request, AI-credit, or subscription economics and can therefore misrank `cost` until provider-specific billing metadata is available.

The projected cache lives under `~/.pi/agent/cache/model-chooser/`, is loaded before chooser tools run, and is refreshed stale-while-revalidate outside tool execution. Refreshes use ETags, retain stale data on failures, use atomic writes, and honor `PI_OFFLINE`. Use `/model-metadata status` or `/model-metadata refresh` from the model-dynamics extension to inspect or refresh it.

Benchmark quality, observed latency, user constraints/overrides, authenticated Copilot catalog identity, and shadow evaluation remain later slices.
