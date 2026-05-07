# ADR-023: LLM judge cascade — resilience contract for SOFT rate-limit classifier (and any future judge call site)

**Status:** accepted (intent); implementation deferred until SOFT classifier ports per ADR-022
**Date:** 2026-05-05
**Owner:** driver

## Context

Bash `lib/whip.sh` uses `atmux::llm_judge` (a Sonnet wrapper) to classify SOFT-tier rate-limit banners (`approaching usage limit` / `N% used`) when whip can't deterministically tell whether a member should be rotated immediately or allowed to finish. The bash version makes a single judge call and falls through to a deterministic conservative fallback (`{decision:"unavailable"}`) on any failure.

ADR-022 defers SOFT to post-V-25 because the TS port has no `lib/llm-judge.sh` equivalent. Before SOFT ports, the **resilience contract** must be pinned — otherwise a future port could land a single-point-of-failure judge call that leaves the cron tick in unknown state when:

- The primary judge model hits its **own** rate limit / token exhaustion.
- The Anthropic API rejects the request (5xx, model unavailable, retryable error).
- The judge returns a **schema-invalid response** (model hallucinates non-JSON, wrong field names, wrong enum values).
- The network call **times out** under cron tick budget.
- The **judge model itself is deprecated** mid-deploy and the request 404s.

Whip runs every 5 minutes via cron. A judge that hangs or returns garbage one tick degrades observability for all members — opposite of what whip is for.

## Decision

### 1. Three-tier cascade — never single-point-of-failure

Every judge call site (initially: SOFT rate-limit classifier; future: any other observability decision needing LLM consult) **must** structure as:

```
Tier 1 (primary)    : Sonnet — full reasoning, expensive, accurate
Tier 2 (fallback)   : Haiku  — cheaper, faster, smaller-model judgment
Tier 3 (terminal)   : Deterministic conservative rule — no LLM at all
```

Each tier has a **definite timeout** + **definite outcome**. Tier failures cascade down. Tier 3 always returns a valid decision (cannot fail by definition).

**Cascade entry conditions** — when a tier counts as "failed" and the next tier fires:

- HTTP non-2xx (rate-limit, 5xx, model-unavailable, billing).
- Network timeout (per-tier cap; default Tier 1 = 8s, Tier 2 = 4s).
- Schema-invalid response (parse fail OR Zod validation fail against the judge's expected output schema).
- Empty / null response body.
- Tier-budget exhaustion (cumulative tier budget exceeded — safety against runaway retries).

**Cascade non-entry conditions** — these are bugs, not graceful failures, and must throw (caller treats as fatal tick error):

- Caller passed an invalid prompt (missing fields, schema violation pre-call).
- Auth credentials missing entirely (config error, not transient).

### 2. Deterministic fallback (Tier 3) — conservative-safe

For SOFT rate-limit classification specifically, Tier 3 is "treat as **OBSERVED-NOT-ACTED**" — log the SOFT signal to whip findings as a 🟡 informational bullet ("rate-limit soft-warning, judge unavailable — auto-rotate skipped, manual review"), do **not** trigger auto-rotate. Rationale: false-positive rotate (rotating a member mid-valuable-work) is worse than false-negative observe (letting the member continue and re-checking next tick).

Each future judge call site defines its own Tier 3 policy in the call-site ADR. The pattern: **Tier 3 must always pick the lower-blast-radius decision**.

### 3. Cost ledger — judge calls are billable

Every judge call (Tier 1 or Tier 2 — Tier 3 has no API call) appends to `<atmuxDir>/state/judge-cost.jsonl`:

```json
{"ts":1714860000,"site":"whip-soft","tier":1,"model":"claude-sonnet-4-6","tokens":420,"usd":0.0042,"outcome":"ok","decisionEnum":"observe"}
{"ts":1714860005,"site":"whip-soft","tier":2,"model":"claude-haiku-4-5","tokens":315,"usd":0.0008,"outcome":"ok","decisionEnum":"rotate"}
{"ts":1714860030,"site":"whip-soft","tier":1,"model":"claude-sonnet-4-6","tokens":0,"usd":0,"outcome":"rate-limited","decisionEnum":null}
```

Whip's `📢 [whip-progress]` template includes a per-tick judge-cost summary when judge calls fired (off the existing `cost.computeTeamCost` machinery — judge cost is a peer to teammate cost, both aggregate into one per-tick budget bullet).

### 4. Observability — every cascade step logs

Logs go to `<atmuxDir>/logs/whip.log` with a structured prefix:

```
[judge-cascade] site=whip-soft member=alice tier=1 model=sonnet outcome=rate-limited reason="usage_limit_exceeded" elapsed_ms=8000 → fallthrough
[judge-cascade] site=whip-soft member=alice tier=2 model=haiku outcome=ok decision=rotate elapsed_ms=312
```

Per-tick summary appended to whip's findings when ANY tier failure occurred (so the operator sees degraded judge availability):

```
🤖 judge-cascade: 1 fallthrough Sonnet→Haiku, 0 to-deterministic
```

Three consecutive ticks with **all** Tier 1 calls falling through to Tier 2 → escalate as a `🚨 [judge-degraded]` Discord ping. Three consecutive ticks falling all the way to Tier 3 → `🚨 [judge-down]`.

### 5. Module shape (when implementation lands)

```
src/core/llm-judge.ts
  ├── interface JudgePrompt { ... }
  ├── interface JudgeDecision<T> { tier: 1|2|3; outcome: "ok"|"rate-limited"|"timeout"|"schema-fail"|"deterministic"; value: T; ... }
  ├── interface JudgeCascadeOpts { tier1Model?, tier2Model?, tier1Timeout?, tier2Timeout?, deterministicFallback: () => T; ... }
  ├── async function judgeCascade<T>(prompt, schema, opts): Promise<JudgeDecision<T>>
  └── async function logJudgeCost(atmuxDir, entry): Promise<void>

src/abstractions/llm.ts
  └── thin Anthropic SDK wrapper — just the call mechanics, no cascade logic
```

The cascade lives in `core/llm-judge.ts` so it's reusable by future call sites (not just whip-soft). Each call site supplies its own Zod schema + deterministic fallback.

## NOT in scope

- **Local-model fallback (Ollama / vLLM).** Adds infrastructure dep + auth surface. Tier 3 deterministic is sufficient for whip-soft. If a future call site genuinely needs an LLM fallback (not a deterministic rule), the cascade widens to 4 tiers — separate ADR.
- **Multi-provider cascade** (Anthropic primary, OpenAI fallback). Same reasoning — adds vendor-management surface. Single-provider with model-tier cascade covers the resilience need.
- **Per-call-site cascade tuning UI.** Hardcoded defaults in `core/llm-judge.ts`; call sites override via opts when justified. No `team.json::judge.cascade` config field — too easy to misconfigure for low operational value.
- **Token budget enforcement.** Tier 1 + Tier 2 cumulative cost is bounded in expectation by the cron cadence (5min × tier-success-rate). If a future incident shows runaway spend, add a `judge-cost.jsonl` cumulative-ceiling check — separate ADR.

## Schedule

- **ADR-023 lands now (Phase 2).** This commit. Pins the contract before SOFT classifier ports.
- **V-25 whip ships SOFT-deferred** per ADR-022. No `core/llm-judge.ts` written yet.
- **Post-V-25 (when SOFT re-enables).** Implementation lands as a small focused commit:
  - `feat(core): llm-judge — three-tier cascade per ADR-023`
  - `feat(verbs): whip — re-enable SOFT classifier per ADR-023 cascade`
  - Specific trigger TBD — likely when a real operator incident demonstrates the bash-side SOFT classifier preventing a meaningful false-rotate.

## Consequences

- Future SOFT classifier ports have a documented resilience contract from day one. No single-point-of-failure judge call in the codebase.
- ADR-022's deferred-SOFT row gains a clear re-enable contract: "ADR-023 cascade is the gate; implementation lands when judge call site is ported."
- The cascade pattern generalizes — future call sites (audit-class-A judge, autonomous-decision rationale judge) reuse `judgeCascade` with site-specific schemas + Tier 3 fallbacks.
- Cost discipline: every judge call billable + ledgered + summarized in whip's per-tick output. No invisible LLM spend.
- Operational discipline: cascade degradation surfaces as a first-class Discord finding (`🚨 [judge-degraded]` / `[judge-down]`) so degraded judge availability isn't silently absorbed by Tier 3.

## Out of plan

- If Anthropic deprecates Sonnet 4.6 / Haiku 4.5 mid-cascade, the model strings are constants — small `core/llm-judge.ts` patch + version-pinned for safety.
- Tier 1 + Tier 2 cumulative timeout currently 12s. Whip cron tick has no hard deadline (cron's `*/5` next-tick spacing is the real budget), but if observed tick latency ever crosses ~30s, revisit (consider parallel Tier 1 + Tier 2 fire-and-pick-first).
