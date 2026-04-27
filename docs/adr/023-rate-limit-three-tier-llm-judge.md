# ADR-023: Rate-limit detection — three-tier with Sonnet LLM judge

**Status**: accepted
**Date**: 2026-04-27

## Context

`lib/whip.sh:156` deterministically auto-rotates a member when its captured pane matches `'hit your limit|rate.?limit'`. The current 5-min cron + AUTO_ROTATE=true gate already debounces rotations to ≥5 min apart per-member. Failure modes the regex-only path produces:

- **False positives.** A teammate's compose-buffer text containing the literal phrase ("hit your limit yesterday around 3pm") trips the detector. A docstring or test fixture mentioning rate-limit pings AUTO-PRECLEAR.
- **No mid-work judgment.** A teammate halfway through a 6-step refactor with an "approaching usage limit" warning gets rotated even though they could finish the unit cleanly. Rotation throws away the in-progress reasoning.
- **No threshold awareness.** "Approaching usage limit" is a soft signal — sometimes the teammate has 70% of the window left and is fine; sometimes they're at 95% and absolutely should rotate. Regex can't distinguish.

The driver's recommended shape is three-tier:

- **HARD** — exact phrase match for the unrecoverable state ("hit your limit"). Rotate immediately, no LLM call. Safety floor; mirrors current behaviour.
- **SOFT** — soft-warning banners ("approaching usage limit", percent-tier banners, queued-message backbuffer ambiguous with rate-limit context). Pass pane snapshot + recent commits + claim age to a Sonnet LLM judge. Judge returns `{decision: rotate|skip, reason: <str>}`. Skip thrash when teammate is mid-valuable-work; rotate when stalled or close to ceiling.
- **NONE** — no rotation trigger. Default state.

Sonnet (`claude-sonnet-4-6`) is the right judge model: read-only-text-judgment is its sweet spot per global CLAUDE.md model-selection guidance ("ingest a lot of tokens and report a small answer"). Cheap because the invocation is gated on banner presence — typical 5-min tick has zero invocations; degraded periods may see 1–3.

The driver explicitly tied this to ASK C (unblocker role): "fold rotation-judgment into unblocker role brief. Don't spawn a separate 'rotator' member — same pane-reading + classify-and-route work." But also: ASK E "can ship before unblocker if separated cleanly." Decomposition split:

- **Se ships first** — three-tier classification + `lib/llm-judge.sh` helper + cost ledger + bats. Whip's preclear path becomes tier-aware. Standalone, no migration-marker dep.
- **Sc inherits** — unblocker role's tick logic reuses `lib/llm-judge.sh` with its own classification prompt template (wedged/idle/legitimately-slow/wedged-with-driver-needed). Sc's BE Task that builds the unblocker tick deps on Se's helper landing.

## Decision

**New `lib/llm-judge.sh`** — generic helper invoked as `atmux::llm_judge <prompt-file> [--model <m>]`. Default model `claude-sonnet-4-6`. Wraps:

```bash
claude --print --model "$model" --no-conversation < "$prompt_file"
```

Returns the model's output to stdout. Caller parses (typically expecting JSON `{decision, reason}` shape — the prompt template enforces that contract). Cost ledger append on every invocation: one JSONL line per call to `.atmux/state/llm-judge-cost.jsonl` with `{ts, member, caller, model, input_chars, output_chars, decision, reason}`. Reuses cost-tracking idiom from `lib/cost.sh`.

**`lib/whip.sh:140-200` refactor** — replace the regex-only AUTO-PRECLEAR block:

```
classify_tier <pane-snapshot>:
  matches /hit your limit/ exactly         → HARD
  matches /approaching usage limit/        → SOFT
  matches /\d+% of (limit|window) used/    → SOFT
  no match                                 → NONE

case tier:
  HARD:
    findings += "🔴 $name: rate-limited (HARD)"
    if AUTO_ROTATE: rotate immediately (no judge), 5-min debounce as today
  SOFT:
    findings += "🟡 $name: usage warning (SOFT) — invoking judge"
    judge_input = compose_judge_prompt(pane_snapshot, recent_commits, claim_age_min)
    judge_output = atmux::llm_judge --model claude-sonnet-4-6 < judge_input
    parse decision: rotate | skip
    if decision==rotate AND AUTO_ROTATE: rotate, debounce as today
    findings += "♻️ judge: $decision — $reason"  (always log judgment)
  NONE: no-op (existing behaviour)
```

The judge prompt template lives in `templates/prompts/rate-limit-judge.md` (new). Slots: `{member_name}`, `{pane_snapshot}`, `{recent_commits}`, `{claim_age_min}`, `{tier}`. Output contract: single-line JSON `{"decision": "rotate"|"skip", "reason": "<short str>"}`. ≤200 char body to keep response tokens minimal.

**Cost bound**: cost ledger entries surface to `atmux cost --judge` (deferred — out of scope for Se; ADR-007-style read verb in a follow-up). For Se itself: append-only ledger; operator inspects via `cat .atmux/state/llm-judge-cost.jsonl`.

**Sc inheritance**: Sc's `lib/unblocker.sh` tick (E9 SC_T2 — t-a6adc81d) gains a dep on Se's `lib/llm-judge.sh` Task. Unblocker uses its own prompt template (`templates/prompts/unblocker-classify.md`) for the wedged/idle/slow/escalate classification.

## Consequences

- **`lib/llm-judge.sh` (new)** — ~30 LOC + cost ledger append.
- **`lib/whip.sh:140-200` refactor** — ~25 LOC replaces the existing regex block. HARD tier preserves current AUTO_ROTATE behaviour; SOFT tier adds the judge call.
- **`templates/prompts/rate-limit-judge.md` (new)** — judge prompt with output contract.
- **`.atmux/state/llm-judge-cost.jsonl`** — append-only cost ledger; operator-inspectable.
- **Cost trade-off accepted**: Sonnet judge call per SOFT tier hit. Estimated typical cost: ~500-2000 input tokens (pane + commits + prompt) + ~50 output tokens = sub-cent per invocation. Gated on banner; degraded period might run 5-10 invocations/hour. Acceptable.
- **Failure modes**:
  - Judge unreachable (claude CLI absent / network down) → fall back to deterministic rotate (HARD-equivalent for SOFT; conservative).
  - Judge returns malformed JSON → log to whip findings + skip rotation (don't rotate on uncertain judgment).
  - 5-min cron debounce stays in place — judge can't undo the floor.
- **Sc dep added**: SC_T2 (t-a6adc81d) gains dep on Se BE Task that ships `lib/llm-judge.sh`.
- **No migration-marker dep on Se**: Se ships standalone, parallel with E8/E9 Sa+Sb work.

## Open questions

1. **OQ E1: judge model — Sonnet vs Opus vs Haiku?** Resolved: Sonnet (`claude-sonnet-4-6`). Per driver default + global CLAUDE.md guidance ("ingest a lot of tokens and report a small answer"). (medium-rev — could switch to Haiku for cost or Opus if Sonnet judgment proves insufficient.)
2. **OQ E2: judge prompt content?** Resolved: pane snapshot (last 30 lines) + recent commits (last 3 SHAs + subjects) + claim age in minutes + tier classification. JSON output contract enforced. (low-rev — prompt template tunable without code change.)
3. **OQ E3: cost ledger schema?** Resolved: JSONL at `.atmux/state/llm-judge-cost.jsonl` with `{ts, member, caller, model, input_chars, output_chars, decision, reason}`. Append-only. (low-rev — schema additions are non-breaking.)

All resolutions logged to `.atmux/decisions.md`.
