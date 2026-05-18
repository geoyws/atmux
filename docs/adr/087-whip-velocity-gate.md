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

## What T2 ships (Task t-e91fec98)

T2 (this commit) lands the strike→complaint escalation pipeline. The
strike counter from T1 is now wired to the complaints box: when a
symptom-hash hits `strikeThreshold` strikes, T2 files a dedup-aware
complaint via the cockpit-scoped superdoctor pipeline and resets the
strike counter so the next escalation lands on a clean window.

- [x] `src/core/complaints.ts` — `fileDedupedComplaint(db, nowSec, opts)`
      orchestrator. Pure-aside-from-the-db-argument; `nowSec` injected
      for clock-determinism in tests. Dedup window default 3600s (1h)
      per Task body §5; bumps `extra.source_count` + `extra.last_seen`
      on the existing OPEN row when re-files land within the window.
      Resolved/wontfix rows do NOT block fresh inserts.
- [x] `src/core/whip-strikes.ts` (extensions) — three new symptom-hash
      builders (`etaLiedSymptomHash`, `classifierSwallowSymptomHash`,
      `processFrozenSymptomHash`) covering Task body §2's failure
      modes. Plus `renderStrikeTimeline(record, nowSec)` —
      "strikes 0→N over Δt=Xmin; last reason: …" — used by T2's
      body builder.
- [x] `src/core/whip-escalation.ts` — `maybeEscalateStrikes(opts)`
      ties the strike record to the complaint filer + handles
      title/body templating (Task body §3-4) + strike-record reset
      (Task body §6). Threshold defaults to 3 per Task body §1;
      callers may override via `team.json::whip.velocityGate
      .strikeThreshold` once the wiring lands in t-5d85dddb.
- [x] `src/core/repositories/complaints-repo.ts` (extensions) —
      `findOpenBySourceId(sourceId, sinceSec)` + `bumpSourceCount(id,
      lastSeenSec, newCount)` SQL primitives the dedup orchestrator
      uses. Keeps SQL ownership in the repo per the project's
      existing layering convention.
- [x] Tests: complaints filer (32 cases), escalation orchestrator
      (19 cases), strikes extensions (10 cases). 100% line cover on
      the three new files. In-memory SQLite (`:memory:`) fixtures
      with the production migration ladder.

### Symptom hash vocabulary (Task t-e91fec98 §2)

| Hash | Failure mode |
|------|--------------|
| `whip-<team>-velocity-stalled` | V1 baseline — generic BAD verdict |
| `whip-<team>-eta-lied` | Lead picked D=Standby N times without ETA hitting |
| `whip-<team>-classifier-swallow` | Queued compose text persists across ≥2 ticks (auto-mode keystroke swallow) |
| `whip-<team>-process-frozen` | Token count unchanged across 3+ ticks AND last commit > 2h |

T2 does not WIRE the symptom-detection logic — that lives in the
deferred wire-up Task t-5d85dddb (whip.ts runTick + reply
validation). T2 ships the post-detection escalation surface so
t-5d85dddb can call into it without re-deriving the title format,
dedup window, or strike-reset semantics.

### Complaint shape (Task t-e91fec98 §3-4)

- **Title** (incidentSummary): `<team>: <symptom> · <observable-evidence> · whip-tried-N-menus`
- **Body** (rootCause): `<strike-timeline>. <unshipped-tasks-list>.`
- **sourceKind** = `whip`; **sourceId** = symptom hash; **targetTeam** = team name; **openedBy** = `whip:<team>`
- **extra.kind** = `heads-up`; **extra.severity** = `high`; **extra.source_count** + **extra.last_seen** managed by the filer

### Dedup contract (Task t-e91fec98 §5-6)

1. Lookup: `SELECT * FROM complaints WHERE source_id = ? AND status = 'open' AND opened_at >= (nowSec - dedupWindowSec)`
2. If found → bump `extra.source_count` + `extra.last_seen` on that row; return `{ isNew: false, sourceCount: N+1 }`
3. If not found → INSERT fresh with `extra.source_count = 1` + `extra.last_seen = nowSec`; return `{ isNew: true, sourceCount: 1 }`
4. After EITHER outcome → reset the strike record (Task body §6 — strikes have done their job once a complaint exists)

## What V1 defers (follow-up Task to file post-commit)

- [x] `src/verbs/whip.ts` wiring — call classifier per tick, write
      strike record on BAD, inject `safeSendKeys` action-menu when
      `shouldNudgeLeadPane` returns true. Deferred because whip.ts
      is 1826 LOC at HEAD; extending it cleanly + the same-commit
      reviewer surface for the kernel + the wire-up would exceed
      single-commit scope. The kernel is independently useful (T2
      can read the strikes file even without the wire-up).
- [x] Reply validation — `^[ABCD]:` marker enforcement on lead's
      next turn. Requires comparing consecutive tick captures of the
      lead pane — net-new state in `whip-strikes-<team>.json`
      (`lastMenuTickSec` + `lastMenuHash`). Out of single-commit
      scope.
- [x] Action-menu UX — the prose text George wants ("If you're
      about to write making progress / thinking through / analyzing
      — STOP and pick A or B. Verbs not nouns. SHA or no SHA.") +
      the A/B/C/D payload validators. Bundled with the wiring above.

> **§Amendment 2026-05-18 (t-5d85dddb)** — All three V1-deferred items shipped. Wiring lives in `src/verbs/poke.ts::runVelocityGate` (called from `runTick` near the end, gated on `team.crons?.whipVelocityGateEnabled !== false` per ADR-087 §Spec); the orchestration logic + pure helpers live in the new `src/core/velocity-gate.ts` module so the decision tree is testable without spinning up a full poke tick context. State-file additions: `StrikeRecord` gains optional `menuSentAtSec` + `menuPaneHash` fields (preserved across `incrementStrike`, owned by `recordMenuSent` / `clearPendingMenu`; backward-compat readers default missing to null). Reply-validation pass runs at the top of the velocity-gate sub-op: prior tick's pending-menu state → compute current pane hash → matching hash = `classifier-swallow` strike (keystroke dropped); differing hash without `^[ABCD]:` marker = `no-marker` strike; with marker = compliant (clear menu). The classifier still runs after validation, so a compliant reply doesn't excuse a fresh BAD tick (commits-in-window is the only OK trigger). Action-menu prompt text lives in `buildActionMenuPrompt` with George's verbatim "verbs not nouns. SHA or no SHA" preamble. Send path uses tmux paste-buffer + paste-submit (matches modal-cycling clarifier convention; safer for multi-line text than raw send-keys). BUSY pane signal → strike but no send (classifier-swallow guard); UNREACHABLE pane → no strike, no send (out-of-scope per existing checkMember wedge escalation path). Sibling T2 (t-e91fec98) — superdoctor complaint escalation on count ≥ strikeThreshold — remains a separate Task; this module's symptom-hash usage is intentionally narrow to `velocityStalledSymptomHash`.

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
- [x] (T2) 3 strikes → complaint filed via `maybeEscalateStrikes`;
      dedup within 1h bumps existing row; strike record resets after.
- [ ] (follow-up t-5d85dddb) Lead D-reply tracked; missed ETA strikes
      → calls into `maybeEscalateStrikes` with `etaLiedSymptomHash`.
- [ ] (follow-up) Kill-switch (`crons.whipVelocityGateEnabled=false`)
      flips off cleanly.

## Refs

- `src/core/velocity.ts` (T1)
- `src/core/whip-strikes.ts` (T1 kernel + T2 symptom-hash extensions)
- `src/schema/team.ts` (T1)
- `src/core/complaints.ts` (T2)
- `src/core/whip-escalation.ts` (T2)
- `src/core/repositories/complaints-repo.ts` (T2 — `findOpenBySourceId` + `bumpSourceCount`)
- Sibling Task t-e91fec98 (T2 — this commit's escalation surface)
- ADR-062 §Rollback (`crons.laneTickEnabled` precedent for the
  fleet-consistent kill-switch shape)
- CLAUDE.md "0-commit overnight excuses → Reddit receipts" — the
  operator stake that drove this ADR
