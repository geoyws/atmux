# ADR-290: Wedged-pane classification + sanctioned recovery ladder

**Status**: accepted (operator-direct — E4 epic e-340d8633 settlements of 2026-09-04/08; detector + escalation only, no auto-unwedge claim)
**Date**: 2026-09-23
**Relates**: [ADR-192](192-cron-arm-idempotency-contract.md) (interim CronCreate arm rules 1–3), [ADR-239](239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) (send-keys invariant, divergence recorded below), [ADR-273](273-voice-fleet-triage-and-pane-input.md) (nudge D4/D5 context), [ADR-023](023-rate-limit-three-tier-llm-judge.md) (rate-limit tiers)

## Context

`atmux nudge` proved the delivery physics and the refusal posture. On wedged
panes bare Enter, triple-Enter, `C-m` and bracketed paste ALL failed; the
paste-and-submit path was the only reliable one (`src/verbs/nudge.ts:22-24`).
Nudge refuses driver panes up front per ADR-239 §D2
(`src/verbs/nudge.ts:328-334` — the task brief cited `:331-338`; the guard
sits three lines higher in this tree).

On 2026-09-08 the operator revoked the send-keys ban (board rule r-1376df29,
banned 2026-09-02 → 2026-09-08) and sanctioned the `/pane-agent` path:
capture before every send, classify the fresh snapshot, `send --queued` into
`idle`/`busy`/`unknown`, keep refusing `dialog` and existing `draft`, verify
the typed draft and the cleared composer afterwards (dotfiles
`/pane-agent` SKILL.md — not in this tree; read-only reference).

That revocation created a divergence this ADR records: the in-tree
`DriverSendKeysViolation` (`src/abstractions/tmux.ts:106-116`) is unchanged,
and ADR-239 was never amended — its §D2 still says NEVER. The sanctioned
`/pane-agent` path and the in-tree invariant disagree, and the disagreement
is resolved in E1-T0 (t-d90f05c6), not here.

What already exists in-tree:

- `src/core/pane-state.ts:78-151` — ordered classifier: RATE-LIMIT
  (`hit your limit`, `:80-81`), COMPACTING (`:83`), BUSY (`:105-117`),
  MODAL (`:121-126`), TYPING (`:128`), SHELL (`:131-132`), READY (`:141-150`).
- `src/core/common.ts:826-830` — `detectRateLimit` (hard on `hit your
  limit`, soft on `approaching usage limit` / `% of limit|window used`);
  `:833-835` `isCompacting`; `:846-848` `hasQueuedMessages`.
- `src/core/cage-state.ts:516-529` — RATE-LIMIT classification maps to
  `wedged` (no forward progress until budget reset).

What is missing: the classifier has no transient-API-error class
(`overloaded` / 5xx card with an idle composer) and no expired-rate-limit
class distinct from live RATE-LIMIT — both fall to `unknown`
(verified: no `overload`/`5xx` pattern in `pane-state.ts`, `common.ts`,
`cage-state.ts` or `nudge.ts`). The `/pane-agent` helper's dotfiles-side
classifier (also not in this tree) has the same hole. Filling it is E4-T2's
job (classifier extension + sweep script); this ADR only ratifies the table
it must implement.

## Decision

### D1 — Placement: a section of `/pane-agent`, not a new skill

The ladder lives as a section of `/pane-agent`. No new skill. The only code
is the classifier extension plus a sweep script over the existing
capture / `send --queued` loop. The raw-tty / dead-omp class cross-refs
`/pane-unstick` instead of duplicating it.

### D2 — Recovery goes through `/pane-agent`, never `atmux nudge`/`send` on driver panes

Nudge's driver refusal is load-bearing (its population is mostly
`driver`/`driver-N` windows) and stays. Driver-pane recovery uses the
sanctioned `/pane-agent` capture → classify → `send --queued` → verify
loop. The sweep reads the current capture only and errs toward
`unknown` + refusal.

### D3 — Scheduler: atmux timer target, CronCreate interim under ADR-192

The target scheduler is the atmux timer (epic e-40915e30). Until it lands,
the sweep arms via CronCreate under ADR-192 Rules 1–3: Rule 1 —
CronList before CronCreate, skip on match; Rule 2 — fuzzy prompt-hash +
interval-exact match; Rule 3 — wake-time recheck via the state-file marker.

### D4 — Claim scope: detector + escalation until the E4-T4 live receipt

This ADR claims detection + escalation only. It never says panes un-wedge.
The claim stays bounded until E4-T4 demonstrates the live receipt.

## Classification table (ratified)

| Observation | Recovery | Escalation |
|---|---|---|
| healthy | none | none |
| idle with stale queued banner | `send --queued` kb-row pointer | att after 2 sweeps |
| transient API error (`overloaded` / 5xx card, composer idle) | `send --queued` `continue` after settle + re-capture | att after 2 failed nudges |
| expired rate limit (`hit your limit` / `approaching usage limit`) | DO NOT nudge; note reset, recheck | att with pane + reset as resolve-when |
| permission prompt | never send | att immediately |
| compaction | wait | att if > 1h |
| raw tty / dead omp | `/pane-unstick` | per that skill |
| unknown | none | att after 3 consecutive unknowns |

Every escalation names the pane id + classification + resolve-when
(board rule r-b00fc737).

## Scheduler

Per D3: atmux timer (e-40915e30) is the target; the interim arm is a single
CronCreate entry obeying ADR-192 Rules 1–3 (list-before-arm, fuzzy
prompt-hash + interval-exact dedup, wake-time recheck). A second arm while
the interim is live is a bug, not coverage.

## Claim scope

Detector + escalation. The sweep classifies, attempts only the
table-sanctioned sends, and raises attention rows with pane id +
classification + resolve-when. Anything beyond that — proof that a class
actually recovers in the live fleet — belongs to E4-T4's live receipt, not
to this ADR.

## Alternatives

- **Do nothing.** Rejected: wedged lanes already sit for hours while
  tick-loops log `BUSY` and never inject waiting todos; the table at least
  names each stuck shape and its next action.
- **atmux-owned sweeper calling `nudge`.** Rejected: `nudge` refuses driver
  panes by design and driver panes are the population; routing around the
  refusal would fork the send path beside `/pane-agent`'s verified
  capture/classify/send loop instead of reusing it.

## Reversal

If E1-T0 (t-d90f05c6) reinstates the send-keys ban, D2 lapses and the table's
send rows become classify-and-escalate-only. If the timer epic ships a
different scheduling surface, the Scheduler section is amended. The table
itself reverses row-by-row on live-receipt evidence that a class never
matches reality.
