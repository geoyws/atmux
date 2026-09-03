# ADR-131: Medic kanban-hygiene auto-fix loop

**Status**: Accepted (2026-05-15, operator-batch-flip)
**Date**: 2026-05-14
**Author**: atmux team (planner / t-ce96470b)
**Extends**: ADR-077 §D2 detection-class chain (`atmux doctor` integrity probes) and §D5 complaint box.
**Parent EPIC**: t-0ca510b2

> **Rename note (2026-05-14, late afternoon)**: this ADR was first authored earlier on 2026-05-14 as "Superdoctor kanban-hygiene auto-fix loop". Later the same day the cockpit self-healing role was renamed `superdoctor` → `medic` per [ADR-133](./133-medic-rename.md). Body prose below refers to **medic** throughout (originally read "superdoctor"). Storage-layer identifiers (`superdoctor_attempts` table, `__superdoctor__` sentinel, `src/core/superdoctor-hygiene/` source dir) remain unchanged for the deprecation window per ADR-133 §Out of scope. The file slug `131-superdoctor-kanban-hygiene.md` is retained — renaming files breaks `git log --follow` and the ADR audit trail.
>
> **Detection-tier relocation (2026-05-14, also late afternoon)** per [ADR-140](./140-cheap-model-first.md) §"What MOVES to martinet" (accepted 2026-05-15): the five kanban-hygiene detectors (§D2) **move from medic's hourly tick to martinet's 270s tick** (Cursor composer-2-fast, Tier 2 cage per ADR-050). Rationale: kanban-hygiene detection is mechanical observation (read tasks table → match fingerprint → produce drain-list); Claude's reluctance bias on the deterministic-fix actions (ghost-owner reassignment, lane-mismatch patch, lane-null backfill) makes the cheaper, non-hedging Cursor backend the production-grade choice. §D2's severity ordering, fix policy, refuse-and-ask escape hatch (§D3), and `hygiene_fingerprints` schema (§D4) are preserved verbatim — only the **caller** changes. Medic retains §D5 complaint-box write authority on detector-confirmed structural failures (Cursor martinet escalates the unfixed fingerprints to medic via `~/.atmux/state/medic-events.log` per [ADR-140](./140-cheap-model-first.md) §"Authority split for rotation"). The §D2 "cost is one additional pass per tick over each team's `state.db` tasks table" line still holds — the pass now runs in martinet's tick, not medic's.

## Context

### Recurring failure shape — kanban data drift wedges auto-claim mechanism

The 2026-05-14 SOPX cockpit diagnostic surfaced **five concrete kanban-data structural-drift issues** all blocking the same mechanism (`atmux claim --next` lane-and-role-affinity matching). Aggregated, they kept one P0 task wedged for 4h+ with the team showing zero commit-cadence while every pane was "alive":

1. **Two ghost-owned tasks** — `owner` strings pointing at members not in `team.members[]` (e.g. legacy member name after a `/team rotate` or `/team add` rename). `atmux claim --next --as <real-member>` skips them because the owner field is set; no real member can claim them; the work is structurally unreachable.
2. **One lane-mismatch on a dispatched-not-claimed P0** — task `lane: be`, owner's natural lane is `test`. `atmux dispatch` wrote the assignment but `atmux claim --next --as testing` filters on lane and skips the task. Wedged 4h+ (the screenshot fingerprint).
3. **One role-mismatch** — `planner` member listed as owner of an execution-class task (lane=fe, body verbs `implement`, `feat:`). Planners decompose; they don't ship code. The task sits because the planner correctly refuses to claim it but the assignment field still occupies the slot.
4. **Nine lane=null backfill cases** — direct member claims succeeded against these but `atmux claim --next` (lane-affinity matcher) cannot surface them as candidates for adjacent idle members because `WHERE lane = ?` returns zero rows when `lane IS NULL`.
5. **Seven prio=null on live tasks** — cosmetic; priority-sort places them last; no functional blocker but disturbs the visible ordering of `atmux task list`.

The same pattern has surfaced in the atmux-team kanban (different members, identical fingerprint shape) and is hypothesised to recur across every multi-team cluster. **Lead-of-team cannot detect these from inside** — the data drift is invisible to a single-team perspective (the lead doesn't have a current canonical roster of "valid owners" vs "stale strings"; doesn't have a deterministic policy for which member should pick up a lane=null orphan). A **fleet-level auditor** does.

### Medic is the natural home

ADR-077 already establishes the cockpit-tier diagnosis-and-prevention role: an hourly Opus + xhigh loop that runs `atmux doctor --json` + `atmux status --json` per team, investigates root causes, files complaints with preventive asks. §D2's detection-class chain currently covers tmux/cron/socket/cursor parity — adding a sixth class **`kanban-hygiene`** is on-mission: same loop, same authority bounds, same complaint-box write surface. The cost is one additional pass per tick over each team's `state.db` tasks table.

### Why "deterministic auto-fix" beats "refuse-and-ask"

When medic detects a ghost-owned task with multiple candidate members eligible to reassign (e.g. `fe-1` + `fe-2` both match lane affinity, both lowest-load), the choice between them is **bounded risk** — the work ships either way; the wrong choice means one member has slightly more load than the other for a window. The alternative is **silent skip with Discord ask-George** ("which member should pick this up — fe-1 or fe-2?"), which leaves the task wedged for an entire human response cycle (overnight: 8h+). Silent skip on bounded-risk decisions is **unbounded dormancy** — exactly the "0 overnight commits" fingerprint flagged in [[feedback_overnight_reddit_stakes]] (whip §0.05): operator-stated stake is *"keep burning nights with excuses + 0 overnight commits and screenshots land on r/ClaudeAI"*.

Medic's authority is already wide per ADR-077 §D3 (`/team rotate-lead`, `/team clear`, pushing source fixes, modifying cockpit config). Deterministic-pick of `fe-1` vs `fe-2` is dramatically narrower than any of those — it's the trivial extension of the existing authority bound.

## Decision

### (D1) Add `kanban-hygiene` detector class to medic's hourly tick

After the existing complaint-file pass (ADR-077 §D2 chain), medic runs **one additional pass per team** over the team's `state.db` tasks table. Five sub-detector files under `src/core/superdoctor-hygiene/` (source dir name unchanged per ADR-133 §Out of scope) produce a flat list of fingerprints; the drain loop picks the highest-severity unfixed fingerprint and applies its deterministic fix. One drain action per tick per team — bounded blast radius preserved.

### (D2) Five detectors, severity ordering, fix policy

| # | Detector | Fingerprint | Severity | Fix policy |
|---|---|---|---|---|
| 1 | `ghost-owner` | `task.owner` ∉ `team.members[].name` | **P0** blocking | Reassign deterministically: lowest-current-load member matching lane affinity; if no lane match, lowest-load any-member; alphabetical tiebreak |
| 2 | `lane-mismatch` | `owner.lane ≠ task.lane` AND `task.claimedAt IS NULL` (dispatched-not-claimed wedge) | **P0** blocking | Update `task.lane` to owner's natural lane (data error is more likely lane than owner — if owner was wrong, dispatch would have surfaced earlier) |
| 3 | `role-mismatch` | `owner.role` ∈ {planner, lead, reviewer, gitter, devops-encore} AND task is execution-class (lane ∈ {fe, be, ops, test} OR body matches `\b(implement\|feat:\|fix:)\b`) | **P1** blocking | Reassign to deterministic execution-class member (same deterministic-pick rule as ghost-owner) |
| 4 | `lane-null-orphan` | `task.lane IS NULL` AND `task.owner IS NULL` AND at least one candidate member exists | **P3** cosmetic | Backfill `task.lane` to the deterministic-pick member's natural lane. Fires only after P0/P1 are drained. |
| 5 | `prio-null` | `task.priority IS NULL` AND `task.status` ∈ {todo, in-progress} | **P3** cosmetic | Default to `3` (mid). Fires only after P0/P1 are drained. |

Severity ordering is non-arbitrary: P0 blocks the auto-claim mechanism entirely (silent dormancy); P1 blocks a single execution-class slot (visible idle); P3 is presentation drift (no functional impact). Drain loop respects severity DESC then `detectedAt` ASC (oldest fingerprint first within a severity tier).

### (D3) "Deterministic auto-fix" policy locked in

Every fix above resolves to a single decision without operator round-trip when the inputs allow. The four resolution rules, in priority order, applied to ghost-owner / role-mismatch reassignments and lane-null-orphan backfills:

1. **Lane affinity** — candidate set narrows to members whose declared `lane` matches `task.lane` (or, for lane-null-orphan, members whose natural lane is in the team's most-active lane set).
2. **Current load** — within the narrowed set, lowest count of `in-progress` tasks wins.
3. **Alphabetical** — within tied load, lowest member name (sort-key) wins.
4. **Refuse-and-ask escape hatch** — if **zero candidate members exist** (e.g. ghost-owned task on a lane with no remaining members), THEN and ONLY then the fingerprint surfaces to Discord via the `[hygiene-blocker]` template (§D5). This is the bounded-risk escape: no candidates = no deterministic answer.

### (D4) Per-team hygiene table at `.atmux/state.db`

New SQLite migration adds the `hygiene_fingerprints` table to each team's state.db:

```
hygiene_fingerprints (
  id              TEXT PRIMARY KEY,         -- UUID
  task_id         TEXT NOT NULL,
  fingerprint_class TEXT NOT NULL,          -- 'ghost-owner' | 'lane-mismatch' | ...
  severity        TEXT NOT NULL,            -- 'P0' | 'P1' | 'P3'
  detected_at     INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,         -- monotonic-bumped on re-detect
  attempted_fix   TEXT,                     -- JSON of intended fix
  fix_applied_at  INTEGER,
  fix_successful  INTEGER                   -- 0/1/NULL (NULL=unattempted)
);

CREATE UNIQUE INDEX idx_hygiene_unique
  ON hygiene_fingerprints (task_id, fingerprint_class);
```

Idempotence: re-detecting an existing (task_id, fingerprint_class) pair bumps `last_seen_at` without duplicating rows. The unique index enforces this at the SQL layer.

Why per-team (not shared `~/.atmux/state/superdoctor-hygiene.db`): per-team is the existing canonical residency for kanban data per ADR-126; sharing would split the audit trail across two stores and require a JOIN across files for `atmux doctor` integrity checks. Trade-off captured in §OQ-2.

### (D5) Discord surfacing — `[hygiene-blocker]` template

New named template in `src/abstractions/discord.ts` per the global Discord format rules (CLAUDE.md verdict-first, milestone-grade). Fires only when:

- Severity is **P0** (blocking auto-claim entirely) AND
- `wedgedMin >= 240` (4h+ wedge — the SOPX screenshot fingerprint) AND
- **Refuse-and-ask escape triggered** (per §D3 rule 4) — i.e. zero deterministic candidates exist.

P0 fingerprints with a deterministic fix candidate are **silently auto-fixed** and logged to the complaint box (ADR-077 §D5), not pinged to Discord. The Discord channel is reserved for genuinely-ambiguous cases requiring operator intervention.

Body format:

```
🔧 **[hygiene-blocker]** · `{team}` · HH:MM MYT

🔴 Stalled — `{task-id}` wedged {wedgedMin}min, {root-cause}

🙏 **Need from George** (zero deterministic candidates)
- {ask, ≤60 chars}
  - A) {option}
  - B) {option}
  - **Default at HH:MM MYT if silent:** {recommended option}

📍 medic tick #N · auto-fixes this tick: {K} · complaints filed: {C}
```

Header / verdict / What's new / Need from George / footer fields follow CLAUDE.md global Discord rules verbatim — categorisation `[hygiene-blocker]`, 🚨 reserved for genuinely-irreversible asks (not used here unless the wedge threatens a demo window).

### (D6) Verb surface dependencies

Auto-fix actions shell to atmux verbs (no direct SQL writes from medic):

- `atmux task assign <id> <member>` — **EXISTS** as of 2026-05-14 per SOPX session capture.
- `atmux task lane <id> <lane>` — **DOES NOT EXIST** today. Needs a sub-task (see EPIC body §Sub-tasks T4).
- `atmux task priority <id> <N>` — **DOES NOT EXIST** today. Same sub-task.

ADR-131's implementation is gated on those verbs landing. The detector files (T2) and hygiene table migration (T3) can land before the verbs; medic's drain loop wires them in T3 + T6 (e2e). EPIC body §Sub-tasks already captures this sequencing.

## Tradeoffs

### Bounded vs unbounded risk — the load-bearing decision

| Choice | Risk shape | Pick? |
|---|---|---|
| Auto-fix ghost-owner deterministically (load-balanced + alphabetical tiebreak) | **Bounded**: wrong member ends up slightly more loaded for one tick; work ships | ✅ |
| Refuse and ask George ("`fe-1` or `fe-2`?") on every ambiguous reassign | **Unbounded**: overnight 0-commit fingerprint → Reddit receipts per whip §0.05 / [[feedback_overnight_reddit_stakes]] | ❌ |
| Silent skip ghost-owner (status quo today) | **Unbounded**: P0 task wedged indefinitely; no detection mechanism today exists at the team-lead level | ❌ |

The recurring failure mode operator has flagged dozens of times is: *agent reports "team alive / queued / dispatched" without verified turn-execution; user re-checks N min later; nothing moved; time wasted*. That failure mode is the ⏎ point of CLAUDE.md "Don't make a dormant team look like a working team" — `working` is defined by commit-cadence, not pane liveness. Auto-fix-deterministic is the structural antidote: medic refuses to leave a P0 hygiene fingerprint un-actioned across a full tick when bounded fix candidates exist.

### Misdiagnosis blast radius

A bad reassignment doesn't lose work — the original task body is intact, the new owner picks it up via the existing `claim --next` path, the commit cadence resumes. The only failure shape is "the wrong member is slightly overloaded for a tick" — self-correcting on the next tick once they finish their current Task.

A bad **`lane-mismatch` fix** is similar: if medic's "owner is right, lane was wrong" assumption is inverted (owner was wrong, lane is right), the next `claim --next` for the correct member still surfaces the task (now with matching lane); a real-member can claim it; no work loss. Worst case is one extra tick of indirection.

The complaint box (ADR-077 §D5) audit-logs every auto-fix BEFORE execution, so reversal (manual `atmux task assign` back to the original owner if operator disagrees) is always one verb away.

### Cost — one extra pass per team per hour

Each detector is a single `SELECT … FROM tasks` query with an index on `status`. Five detectors × N teams × hourly tick = 5N SQL queries/hour, plus the drain action (one `atmux task assign` / `atmux task lane` / `atmux task priority` shell per tick per team in the steady-state worst case). Negligible against the cost of one Opus + xhigh turn.

## Cross-references

- **ADR-077** — medic cockpit role. §D1-D2 establish the detection-class chain this ADR extends; §D3 cadence/authority bound; §D5 complaint box residency.
- **ADR-082** — per-member worktree isolation. The 9 lane=null orphans observed in SOPX correlate with worktree-isolated teams where dispatch routing is per-lane; lane=null orphans become functionally invisible to the lane-affinity matcher.
- **ADR-084** — per-member-branch model. Members' natural-lane resolution (used by deterministic-pick) reads from `team.members[].lane` introduced alongside this ADR's tier.
- **historical decision number 076 (no surviving ADR file)** — SQL-canonical inbox. Hygiene fingerprints live in the same `state.db` per the same residency pattern.
- **ADR-126** — kanban storage in `state.db`. The tasks table this ADR audits.
- **historical decision number 049 (no surviving ADR file)** — budget-pause. Medic's hourly cadence respects budget windows; hygiene pass skips when team is paused (no point fixing wedge fingerprints during a pause that already wedges everything).
- **CLAUDE.md** "Don't make a dormant team look like a working team" + whip §0.05 — the operator-side rule this ADR makes structurally enforced.
- **`feedback_overnight_reddit_stakes`** — the operator-stated stake for not letting deterministic fixes get blocked on operator round-trips.

## Open questions

**OQ-1 — Cosmetic class autofire cadence: every tick or daily?**

`lane-null-orphan` + `prio-null` are P3 cosmetic. Firing them every hour (same cadence as P0/P1) is uniform but wastes drain slots on cosmetics when blocking classes are present. Firing them daily (e.g. once per 24h tick window) preserves drain budget for P0/P1.

**Recommended default**: fire every tick BUT only when no P0/P1 fingerprints exist in the same pass (the severity-DESC drain order naturally enforces this — P3 fingerprints starve out behind P0/P1). No special-case timing needed; the existing drain rule covers it. Override via decisions log if cosmetic noise in the complaint box becomes an issue.

**OQ-2 — Hygiene-DB residency: per-team `.atmux/state.db` or shared `~/.atmux/state/superdoctor-hygiene.db`?**

Per-team is the existing canonical residency for kanban data (ADR-126 + historical decision number 076 (no surviving ADR file)). Shared would centralise the audit trail across all teams medic monitors but split the residency model (kanban here, hygiene there).

**Recommended default**: per-team `.atmux/state.db` (matches existing ADR-126/076 pattern; no residency drift; cross-team aggregation composable via `UNION ALL` query if needed; survives team archival as part of the team's own state). Override = move to shared store when medic needs to correlate hygiene patterns across teams (e.g. "ghost-owner spikes after every cockpit rebuild" — a cross-team signal). Until that signal exists, per-team is cheaper.

## Implementation plan

This ADR commits the **specification only**. Implementation lands across the EPIC's six sub-tasks (per t-0ca510b2 §Sub-tasks): T1 (this ADR) → T2 (5 detector files + unit tests) → T3 (hygiene table migration + drain loop integration) → T4 (`task lane` / `task priority` verbs) → T5 (Discord template + render test) → T6 (e2e dogfood gate). Reviewer flips this ADR Proposed → Accepted in a follow-up commit per the brief.

## Out of scope

- Code implementation — separate sub-tasks per EPIC body.
- Cross-team correlation of hygiene patterns — deferred to ADR-131b fold-in once cross-team residency need is observed (gated on OQ-2 override).
- Auto-fix on cosmetic classes for `done` / `archived` tasks — only `todo` / `in-progress` are in scope (cosmetic drift on completed work is historical record, not functional drag).
- LLM-judged reassignment (e.g. "this task body looks like fe even though lane is null") — deterministic rules only in v1; LLM-judge surface deferred until determinism-misses are observed.
- Auto-rotation triggered by hygiene pattern (e.g. "lead has produced 5 ghost-owners this week — rotate") — kept as a complaint-box recommendation only; rotation authority stays in §D3's existing channels.

## Sibling sub-op: phantom-in-progress auto-prune (t-d6fc03a7, complaint c-368c375b)

A separate concern lives alongside (not inside) the §D2 5-class drain: **phantom-in-progress claims** — kanban rows where `status='in-progress'` AND `owner` is set AND the owner's tmux window is NOT present in the team's cage. Their detection shape is different from the five kanban-hygiene classes (live-pane probe + claim-age filter, not pure kanban analysis), and their sink is the `tasks` table (`status` → `blocked` with `auto-pruned at <iso> via <source>` note), not the `superdoctor_hygiene` row upsert.

Module: `src/core/phantom-prune.ts`. Callers / sources:

| Source | Surface | Trigger |
|---|---|---|
| `session-stop` | `atmux stop` runtime (`src/verbs/stop.ts::runStopPhantomPrune`) | Every team teardown, after C-c + 2s sleep — captures rows from members that didn't get to `atmux done` before kill. |
| `doctor-fix` | `atmux doctor --fix` (`src/verbs/doctor.ts`) | Operator-driven, between sessions. Flips every detected phantom regardless of age. |
| `hygiene-tick` | `atmux hygiene-tick` opportunistic sub-op (this Task) | Cron-fired, runs alongside the 5-class drain. Applies a default `minAgeSec = 86_400` (24h) age filter so fresh claims aren't pruned out from under a still-bootstrapping member. Opt-out via `--no-phantom-prune`. Skipped on `team.singleSession === true` per ADR-026 (no cage to probe). |

The hygiene-tick sub-op closes the gap that motivated complaint **c-368c375b**: past atmux team sessions left in-progress claims in the kanban (5 stuck IDs cited — `t-add5976a` / `t-f71b5600` / `t-ac139cc6` / `t-a631e00c` / `t-221eb576`); doctor flagged them but didn't auto-fix when the operator didn't run `atmux doctor --fix`, and the stop hook only catches graceful-teardown paths. The cron-fired sub-op is the path of last resort — it eventually reaps phantoms even when neither operator nor the graceful-stop path got to them.

The sub-op's JSON output sits alongside the existing drain-loop fields on `HygieneTickResult` so the agent-consumer parses both in one tick:

```json
{
  "detected": N,
  "unfixedAfter": N,
  "drained": { "row": {...}, "result": {...} } | null,
  "skipReason": "no-unfixed" | "ladder-defer" | "",
  "phantomPrune": {
    "detected": N,
    "prunedIds": ["t-…"],
    "alreadyPrunedIds": ["t-…"],
    "skipReason": "" | "disabled" | "singleSession" | "probe-failed" | "no-candidates"
  } | null
}
```

The sub-op is a deliberately separate concern: kanban-hygiene drains data-shape drift (owner-not-in-roster, lane-mismatch, etc.), and phantom-prune drains process-shape drift (claim-without-runner). Keeping them parallel — both invoked from the verb, neither dispatching to the other — preserves §D2's 5-class drain semantics (one fix per tick, severity-ordered ladder) without leaking phantom rows into the `superdoctor_hygiene` table or vice versa.

## Amendments

### 2026-05-17 — Tighten "shipped via SHA" auto-groom criteria (high false-positive rate observed)

**Observation** (planner grooming cycle 2026-05-17 ~01:50 MYT):

A planner-initiated kanban-grooming sweep audited 6 EPIC-parent tasks marked `task.note = "groomed: shipped via SHA <hex>"` by an auto-groom hook (likely a §D2-adjacent rule extending the 5-class drain). Subject-vs-shipped-SHA scope-match check revealed **5 / 6 = ~83% false-positive rate**:

| Task | Subject scope | Groomed-as-shipped SHA | Actual SHA scope | Match? |
|---|---|---|---|---|
| `t-7101c40f` | historical decision number 064 (no surviving ADR file) bash decommission | (multiple) | bin/atmux → bun shim; lib/ gone | ✅ true positive |
| `t-60982d48` | ADR-089 **dogfood** (cockpit verbs walk + nested-cage e2e) | 7be35c4 | ADR-089 recursive sessions[] **impl** + DFS flattener | ❌ scope mismatch (impl, not dogfood-e2e) |
| `t-c2e544b6` | ADR-092 **doctor D5a/D8/D9** + round-trip e2e | (multiple) | ADR-092 tell-lead cross-team verb; D5a in doctor.ts is ADR-057-referenced; D8+D9+e2e not visible | ❌ partial |
| `t-8ec31d4d` | ADR-050 **§Resume continuity** (composer + member-pane paste on budget-resume) | 258ea95 | ADR-050 **§Acceptance gate Tier 2** (Cursor) fallback lifecycle | ❌ different §section |
| `t-66746ab4` | bun-port: task add/update `--epic` + `--story` CLI flags | 407d075 | **bash** kanban verb shipped 2026-04-25; bun-port src/verbs/task.ts has no `"--epic"` literal | ❌ pre-historical decision number 064 (no surviving ADR file) bash artifact |
| `t-e057d8ff` | ADR-140 T3 medic verb impl | 3cb1697 | `docs(changelog)`: refreshes ADR-140 entry, explicitly says **"T3 + T4 filed and claimable for be-lane"** | ❌ doc-update mistaken for ship |

**Failure mode**: the auto-groom hook appears to tag `task.note = "shipped via SHA X"` based on **loose criteria** — likely an `ADR-NNN` substring match in commit subject — without verifying:

1. Whether the commit's scope (subject + body) covers the task's **specific** scope (§section, sub-task identifier, deliverable surface).
2. Whether the commit is a code-shipping commit (`feat:` / `fix:`) vs a doc/changelog refresh (`docs:` that may explicitly say the work is NOT yet done).
3. Whether the commit reflects the modern artifact (TS port post-historical decision number 064 (no surviving ADR file)) vs a pre-decommission bash artifact.

**Decision** (extends §D2 5-class drain with a 6th detector class, OR — preferred — tightens §D2's `shipped-via-SHA` write-out criteria):

When auto-groom writes `task.note = "groomed: shipped via SHA X"` on a `todo` task, the SHA-vs-task match MUST require **AT LEAST ONE** of the following stronger signals (not just ADR-NNN substring):

- (a) commit message body explicitly cites the task ID (`t-XXXX`) OR the EPIC's specific sub-task identifier (e.g. `ADR-140 T3`).
- (b) commit subject prefix is `feat:` or `fix:` (not `docs:` / `chore:` / `test:` alone) AND commit subject contains a substring derivable from the task's subject (not just the ADR number).
- (c) `git diff <SHA>^..<SHA>` touches a file path that the task body explicitly names as the deliverable.

If ZERO of (a)/(b)/(c) match, the auto-groom MUST instead write a weaker `task.note = "candidate-shipped via SHA X (groom-auto-detected; scope-match unverified)"` AND keep `status='todo'`. Planner-or-medic confirms the scope-match before re-grooming with the canonical `shipped via SHA` form.

**Rationale**:

- False-positive groom-noted closures create silent kanban drift — the task LOOKS done in `atmux task show` but the work hasn't shipped. Downstream consumers (lead status reports, reviewer signoff gates, planner cycle planning) trust the note and skip the real work.
- The 5/6 sample is small but consistent — the failure mode is structural, not statistical noise.
- The fix is criteria-tightening at the auto-groom write-path; no schema changes. The `superdoctor_hygiene` table doesn't change; the `tasks.note` text format gains a `candidate-` prefix for unverified matches.

**Implementation surface** (a follow-up Task should impl this — file as a sibling sub-task under the relevant EPIC, OR a fresh standalone Task with body referencing this Amendment):

1. Locate the auto-groom write site — likely `src/core/superdoctor-hygiene/<rule>.ts` OR `src/core/groom.ts` (verify via `rg "groomed: shipped via SHA" src/`).
2. Add the 3-signal scope-match check before writing the canonical note.
3. Add the `candidate-` prefix fallback for unverified matches.
4. Unit-test coverage: 6 test cases mirroring the 5/6 false-positive sample above + 1 true-positive control.
5. Doctor probe: `groom-candidate-shipped-stale` — warns when a `candidate-shipped` note is older than 7 days without resolution. Nice-to-have, lower priority.

**Reversibility**: high. Criteria can be tuned post-impl based on observed false-positive/false-negative tradeoffs.

**Cross-ref**: planner sweep 2026-05-17 surfaced via `atmux reply` (lead-outbox), see same-date entry mentioning "go-b grooming sweep — surfaced HIGH FALSE-POSITIVE rate on auto-groom 'shipped via SHA' notes. Net: 1 task closed (verified structural), 5 reverted to todo".
