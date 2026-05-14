# ADR-087: Whip Velocity-Gate — ground-truth classifier + strike counter

- **Status**: proposed (deferred: whip.ts wiring + reply validation +
  action-menu UX deferred to follow-up Task **t-5d85dddb**, per
  CLAUDE.md "ADR write-flow (deferred:) lint" rule per
  t-968416aa convention)
- **Date**: 2026-05-14
- **Driver**: parity-cron-impl (t-289119f2)
- **Related**: sibling t-e91fec98 (T2 superdoctor escalation),
  ADR-062 (`crons.laneTickEnabled` shape sibling), ADR-085 (whip
  needs-approval surface), ADR-077 (superdoctor cockpit role)

## Problem

Lead self-reported velocity is fake-liveness. Observed 2026-05-14:
**10 zero-commit heartbeats over 4.5h** on this very atmux team.
`atmux whip` ticks read the lead pane, see `thinking with N tokens`
/ "analysis" prose / `working on X` framings, and emit ✅
heartbeats — but the kanban shows zero in-progress transitions and
`git log` shows zero commits over the whole window.

The existing whip checks (`checkLeadUptime`, `checkMember`,
`emitFindings`) classify based on pane-text patterns + token
indicators + budget signals — every one of which the lead pane can
satisfy WITHOUT shipping work. Lead self-report is unfit as a
liveness signal.

## Decision

Add a **ground-truth velocity-gate** to every whip tick:

1. **Classify** the team's velocity using only post-fact evidence
   (commits-in-window count, last-commit age, in-progress task
   count). No lead self-report inputs.
2. Verdicts are `OK` / `STANDBY` / `BAD`. BAD fires when a window
   passed with zero commits AND there's claimed work in flight.
3. On BAD, **bump a per-symptom-hash strike counter** at
   `<atmuxDir>/state/whip-strikes-<team>.json` AND inject an action
   menu into the lead pane via `safeSendKeys` (the menu UX is the
   follow-up; V1 ships the counter + classifier kernel).
4. Strike counter resets on the next OK/STANDBY tick OR on explicit
   `resetStrikeRecord` (called by T2 after filing a complaint).
5. When strikes ≥ `strikeThreshold` (default 3), sibling Task T2
   (t-e91fec98) files a complaint via the cockpit-scoped
   superdoctor escalation pipeline. T2 reads this file; T1 only
   writes it.

## Spec

### Classifier (pure, `src/core/velocity.ts`)

```ts
classifyVelocity(inputs: VelocityInputs): VelocityClassification
```

Resolution order:

| # | Condition | Verdict |
|---|-----------|---------|
| 1 | `commitsInWindow >= 1` | OK |
| 2 | `lastCommitAgeMin <= standbyGraceMin` | STANDBY |
| 3 | `inProgressTaskCount === 0 && commitsInWindow === 0` | STANDBY |
| 4 | otherwise | BAD |

The pane signal (`READY` / `BUSY` / `UNREACHABLE`) does NOT affect
the verdict — it gates whether whip.ts ACTS on BAD this tick
(`shouldNudgeLeadPane`). BAD on a non-READY pane still increments
the strike counter — classifier-swallow (keystrokes dropped against
a BUSY pane) is itself a strike symptom per Task body §3.

### Strike state file (`src/core/whip-strikes.ts`)

Path: `<atmuxDir>/state/whip-strikes-<team>.json`.

Shape:

```json
{
  "schemaVersion": 1,
  "records": {
    "whip-<team>-velocity-stalled": {
      "count": 2,
      "firstStrikeSec": 1715630000,
      "lastStrikeSec": 1715630600,
      "lastReason": "BAD: 0 commits in 60min · last commit 240min ago · 3 in-progress (stalled)"
    }
  }
}
```

Atomic writes via the project's `atomicWrite` (mktemp + rename).
JSON-parse failures + missing-file cases return an empty in-memory
record (sub-op error containment — whip never crashes on a strikes-
file transient).

Per-symptom-hash keying (not a single global counter) so T2 can
dedup complaints per failure mode (eta-lied vs classifier-swallow vs
process-frozen — see t-e91fec98 §2). V1 has one symptom hash:
`whip-<team>-velocity-stalled`. T2 extends with the others.

### Schema

`src/schema/team.ts`:

- `crons.whipVelocityGateEnabled: boolean` (default `true`) — fleet-
  consistent shape with `crons.laneTickEnabled`. Operators flip off
  to revert to pre-ADR-087 behavior (no velocity gate; lead self-
  report wins).
- `whip.velocityGate?: { windowMin, strikeThreshold, standbyGraceMin }` —
  all optional, defaults baked into the classifier constants
  (`DEFAULT_VELOCITY_WINDOW_MIN = 60`, `DEFAULT_STRIKE_THRESHOLD = 3`,
  `DEFAULT_STANDBY_GRACE_MIN = 30`).

## What V1 ships (this commit, t-289119f2)

- [x] ADR-087 (this doc), Status: proposed
- [x] `src/core/velocity.ts` — pure classifier + `shouldNudgeLeadPane`
      + `shouldIncrementStrike` helpers
- [x] `src/core/whip-strikes.ts` — strike state file IO (read /
      increment / reset / hash)
- [x] Schema: `crons.whipVelocityGateEnabled` +
      `whip.velocityGate` cadence knobs
- [x] Tests: classifier + strike-file IO (target 100% line cover per
      ADR-009 narrowed denominator)

## What V1 defers (follow-up Task to file post-commit)

- [ ] `src/verbs/whip.ts` wiring — call classifier per tick, write
      strike record on BAD, inject `safeSendKeys` action-menu when
      `shouldNudgeLeadPane` returns true. Deferred because whip.ts
      is 1826 LOC at HEAD; extending it cleanly + the same-commit
      reviewer surface for the kernel + the wire-up would exceed
      single-commit scope. The kernel is independently useful (T2
      can read the strikes file even without the wire-up).
- [ ] Reply validation — `^[ABCD]:` marker enforcement on lead's
      next turn. Requires comparing consecutive tick captures of the
      lead pane — net-new state in `whip-strikes-<team>.json`
      (`lastMenuTickSec` + `lastMenuHash`). Out of single-commit
      scope.
- [ ] Action-menu UX — the prose text George wants ("If you're
      about to write making progress / thinking through / analyzing
      — STOP and pick A or B. Verbs not nouns. SHA or no SHA.") +
      the A/B/C/D payload validators. Bundled with the wiring above.

## Rollback

Flip `team.json::crons.whipVelocityGateEnabled = false`. The classifier
+ strike module stay on disk (no-op without a caller). T2 sees no
incoming strikes and never escalates. Reversible.

## Open questions resolved at decompose-time

- **OQ1 — symptom hash format**. Picked `whip-<team>-<symptom-name>`
  (matches Task body §2 spec verbatim). Stable, greppable, dedup-
  friendly.
- **OQ2 — strike counter scope**. Per-team JSON file vs SQLite
  table. Chose JSON: matches existing whip-side state (`whip-
  last.hash`, `session-start.txt`) + low write volume (1-3 strikes
  per BAD streak per team) + no need for cross-team queries (T2 is
  cockpit-scoped but reads per-team files).
- **OQ3 — STANDBY downgrade**. Schema `standbyGraceMin` (default
  30min) — half the main window. Tighter (10-15min) over-strikes
  on legitimate "lead reading next Task" pauses; looser (>main
  window) over-mutes on stalled teams that shipped 50min ago. 30min
  matches the operator's gut on the 2026-05-14 incident.

## OQs deferred to follow-up

- **OQ4 — sliding window source**. V1 classifier accepts
  `commitsInWindow` as a pre-computed count; whip.ts wiring (the
  deferred piece) decides whether to read from `git log --all` or
  from a kanban `commits` index. Sibling t-727f1f42 (lane-tick)
  uses `git log`; following that precedent is the recommended path.
- **OQ5 — multi-tier strike threshold escalation**. Today: 3
  strikes → T2 fires one complaint. Future: 3 strikes → soft ping,
  5 strikes → complaint, 10 strikes → Discord-loud. Decompose when
  the operator-observed false-positive rate is measurable.

## Acceptance (full ADR-087, across T1 + follow-up)

- [x] (T1) Classifier returns expected verdicts across the resolution
      table; 100% test coverage on the pure module.
- [x] (T1) Strike record reads/writes round-trip; missing-file +
      malformed-JSON degrade gracefully (return empty record).
- [x] (T1) Schema fields surface in `team.json` + reject typos at
      strict-mode validation.
- [ ] (follow-up) Whip on a 0-commit team with in-progress tasks
      emits menu via `safeSendKeys` (verified via tmux capture-pane).
- [ ] (follow-up) Lead A-reply with payload triggers expected
      dispatch.
- [ ] (follow-up) Lead D-reply tracked; missed ETA strikes; 3 strikes
      → T2 complaint filed.
- [ ] (follow-up) Kill-switch (`crons.whipVelocityGateEnabled=false`)
      flips off cleanly.

## Refs

- `src/core/velocity.ts` (this commit)
- `src/core/whip-strikes.ts` (this commit)
- `src/schema/team.ts` (this commit)
- Sibling Task t-e91fec98 (whip→superdoctor escalation via complaints)
- ADR-062 §Rollback (`crons.laneTickEnabled` precedent for the
  fleet-consistent kill-switch shape)
- CLAUDE.md "0-commit overnight excuses → Reddit receipts" — the
  operator stake that drove this ADR
