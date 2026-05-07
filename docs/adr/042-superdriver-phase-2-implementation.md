# ADR-042: Superdriver Phase 2 — implementation shape (bidirectional comms + autonomous fleet awareness + cross-team writes)

**Status**: accepted
**Date**: 2026-05-02
**Related**: [ADR-025](./025-superdriver-phase-1.md) (Phase 1 surface; §"Phase 2 commit gate" superseded), [ADR-029](./029-driver-lead-team-scope-superdriver-cross-team.md) (cross-team write authority + audit), [ADR-031](./031-aggressive-parallelisation-default.md) (parallel BE/TEST dispatch), [ADR-032](./032-socket-pubsub-messaging-layer.md) (socket pubsub primitive), [ADR-034](./034-superdriver-phase-2-commit.md) (driver-authored Phase 2 commit; supersedes ADR-025 §commit-gate).

## Context

ADR-034 unblocked Phase 2 ("build now") and named four ordered Phases (2A bidirectional comms / 2B whip-cycle + backoff / 2C cross-team writes / 2D super-drive UX). It deferred the implementation-shape doc to a subsequent planner-authored ADR — this one. The five design Constraints are CANON (driver-inbox 2026-04-28 08:05 MYT entry, reaffirmed 21:17 MYT; preserved verbatim in `t-8704d75a` body) and inputs not outputs.

This ADR pins the verb surface, file layout, and dependency graph for each Phase. Detail-level open questions remain in §Open questions for implementation Tasks.

## Constraints (recap; canonical, not relitigated)

1. **Whip-cycle scheduling.** Event-driven, exponential backoff `nextInterval = base * 2^quietTicks`, **no ceiling**, base 5min. Daily floor force-wake at 24h since last fleet event (defense-in-depth). Reset on fleet-event mtime bumps.
2. **Agent brief discipline.** Quiet wakes = single-line log + exit. No compensatory polling. Long gaps are the system working.
3. **Inbox-aware fleet quiescence.** Per-team `driver-inbox.md` + `lead-outbox.md` + new `superdriver-inbox.md` are first-class fleet-event sources; full-fleet idle = superdriver itself backs off.
4. **Self-isolation.** Tracker writes only from `lib/super-whip.sh`; agent never touches scheduler state. Origin-tagging on writes (`{origin: "superdriver"}`) excludes self-writes from quietTicks reset.
5. **Bidirectional comms.** New `superdriver-inbox.md` fleet inbox + new `lib/super-reply.sh` verb (member → fleet) + `superdriver.sock` pubsub (extends ADR-032 to fleet level) + `super-tell` direct-member polish + per-member rate limit (10/hr default).

## Decision

### Verb naming (planner picks; both options offered by driver)

- **Cross-team Task push: extend `super-tell` with `--task <kanban-task-json>` flag.** Rationale: same channel as the existing super-tell audit trail; one fewer verb in the surface; correlation between pushed Task + lead-routing message stays in one place.
- **Phase 2D UX verb: new `atmux drive <team>`.** Rationale: `super-attach` is dedicated to the superdriver session itself; overloading it with team-driver attachment would conflate two different "attach to a pane" semantics. `drive` is short, taxonomically clean, and reads correctly cross-cwd (`atmux drive ifca_aix` from anywhere).

### Phase 2A — Bidirectional comms

**New artifacts:**

| Path | Purpose |
|---|---|
| `~/.claude/teams/superdriver-inbox.md` | Fleet-level inbox (append-only, flock-guarded). Mirrors per-team `driver-inbox.md` format: `[HH:MM MYT] [team/member] msg` with status markers (📥 / ⏳ / ✅ / ❌). |
| `~/.claude/teams/superdriver-inbox.md.lock` | flock file for fleet-inbox writes. |
| `~/.claude/teams/superdriver.sock` | Pubsub socket for fleet-level events (extends ADR-032 wire format; `type: "super-reply" \| "super-tell-reply" \| "fleet-event"`). |
| `lib/super-reply.sh` | NEW verb. Members run `atmux super-reply <msg>` from inside cage; resolves current team via `$ATMUX_DIR` / cwd; appends to fleet-inbox + emits pubsub event + writes per-team audit. |
| `<projectRoot>/.atmux/super-reply-audit.md` | Per-team audit trail of what their members sent up — bypass without going dark to the team's own lead. |
| `<projectRoot>/.atmux/super-reply-rate.json` | Per-member epoch-bucket rate-limit counters (10/hr default; configurable `ATMUX_SUPER_REPLY_RATE_PER_HOUR`). |

**Wire format on `superdriver.sock`** (extends ADR-032 schema):
```json
{"type":"super-reply","ts":1777722000,"from":"<team>/<member>","payload":{"msg":"...","auditId":"sr-..."}}
```

**Verb surface delta:**

```text
atmux super-reply <msg> [--from <member>]      # NEW (Phase 2A)
atmux super-tell <team> [<member>] <msg>       # POLISH — direct-member default already accepted; --reply <super-tell-id> for correlation (optional, deferred)
```

**Rate-limit semantics:**
- Per-member, per-hour epoch-bucket. Bucket = `epoch_hour = floor(now / 3600)`.
- Counter file: `<projectRoot>/.atmux/super-reply-rate.json` — `{"<member>": {"<epoch_hour>": N}}`.
- Breach = N ≥ 10 (default). On breach: refuse the append, emit `🛑` Discord-style ping to the member's pane, append a breach-flag entry to `~/.claude/teams/superdriver-bypass-log.md` (per ADR-034 — bypass-log is now the generic incident channel).
- Stale buckets pruned on each write (only retain current-hour + previous-hour for grace).

**Self-isolation tie-in (Constraint 4):** `super-reply` writes to `superdriver-inbox.md` — these MUST count as fleet-events (member→superdriver communication is the canonical signal that wakes superdriver). NO `{origin: "superdriver"}` tag. Conversely, when the superdriver session itself appends to fleet-inbox (e.g. logging an outbound super-tell for thread continuity), entries carry `{origin: "superdriver"}` and are excluded from quietTicks reset.

### Phase 2B — Whip-cycle + backoff (autonomous fleet awareness)

**New artifacts:**

| Path | Purpose |
|---|---|
| `lib/super-whip.sh` | NEW scheduler verb. Reads tracker, computes `nextWakeAt`, decides skip-or-spawn-digest, writes tracker under flock. |
| `~/.claude/teams/superdriver-whip-state.json` | Tracker `{lastFleetEventAt, quietTicks, nextWakeAt, lastWakeAt}`. |
| `~/.claude/teams/superdriver-whip-state.json.lock` | flock file for tracker mutations. |
| `~/.claude/teams/superdriver.log` | Append-only run log: `[ts] tick: quiet | digest-spawned | daily-floor | ...`. |
| crontab line | `*/5 * * * * <env-block> /path/to/atmux super-whip` (auto-installed via `atmux super-whip --install-cron`; mirrors per-team `atmux start` cron-install pattern). |
| `templates/briefs/superdriver.md` (delta) | Section "Whip-cycle discipline" encoding Constraints 1-4 in agent-readable rules. |

**Tracker mutation policy (Constraint 4 — self-isolation):**
- Only `lib/super-whip.sh` writes the tracker. Agent has no API.
- Mutation is flock-guarded; concurrent ticks serialize.
- Agent may read tracker freely (`cat`, `jq`); reads do not bump mtime on watched fleet-event paths.

**Backoff curve (Constraint 1):**
```text
quietTicks 0  → nextWakeAt = now + base                 (5min)
quietTicks 1  → nextWakeAt = now + base * 2             (10min)
quietTicks 2  → nextWakeAt = now + base * 4             (20min)
...
quietTicks N  → nextWakeAt = now + base * 2^N           (no ceiling)
```
Optional jitter: `nextInterval ± random(10%)` — implemented but documented as off-by-default (no concurrent superdrivers today; hook for future).

**Daily floor (Constraint 1 defense-in-depth):** if `now - lastFleetEventAt > 24h`, force `nextWakeAt = now` regardless of quietTicks; emit `daily-floor` log line. Configurable `ATMUX_SUPER_WHIP_DAILY_FLOOR_HOURS=24` (set 0 to disable).

**Fleet-event detector (closed allow-list per Constraint 4):**
1. Any registered team's `<projectRoot>/.atmux/kanban.json` mtime > `lastWakeAt`.
2. Any registered team's `<projectRoot>/.atmux/lead-outbox.md` mtime > `lastWakeAt`.
3. Any registered team's `<projectRoot>/.atmux/driver-inbox.md` has unmarked Open entry OR `⏳` entry older than 2h since in-progress mark.
4. `~/.claude/teams/superdriver-inbox.md` mtime > `lastWakeAt` (Constraint 5 fold-in).
5. `~/.claude/teams/registry.json:.lastSeen` bump above noise floor (any team's `lastSeen > lastWakeAt + 60s`).
6. Per-team `<projectRoot>/.atmux/super-reply-audit.md` mtime > `lastWakeAt` (member→fleet activity).

**EXCLUDED from detector (Constraint 4):**
- Any file write tagged `{origin: "superdriver"}` in audit trail.
- `~/.claude/teams/superdriver-whip-state.json` itself (tracker is not a fleet event).
- `~/.claude/teams/superdriver.log` (run log not a fleet event).
- `~/.claude/teams/superdriver-writes.jsonl` (superdriver's own writes audit, see Phase 2C).

**`_super_inbox_idle <projectRoot>` predicate (Constraint 3):**
- Returns 0 (idle) iff: every Open driver-inbox entry has marker (✅ / 📤 / ⏳ / ❌) AND no `⏳` older than 2h since the in-progress mark AND `lead-outbox.md` mtime older than `lastWakeAt`.
- Returns 1 (active) otherwise.
- Stuck-ask escalation (`⏳` > 2h on any team's driver-inbox) is itself a fleet-event triggering reset; surfaces in next digest as `🛑 stuck-ask: <team>/<entry-snippet>`.

**Tick logic** (pseudocode):
```text
flock superdriver-whip-state.json.lock
  read tracker → lastFleetEventAt, quietTicks, nextWakeAt, lastWakeAt
  if now < nextWakeAt: log "tick: skip (next at <nextWakeAt>)"; exit
  enumerate fleet events since lastWakeAt
  if any fleet event:
    quietTicks = 0
    lastFleetEventAt = max(event mtimes)
    spawn digest pass
  else if now - lastFleetEventAt > 24h:
    quietTicks = 0  (daily floor; treat as fleet event for cadence)
    log "tick: daily-floor force-wake"
    spawn digest pass
  else:
    quietTicks += 1
    log "tick: quiet (q=N)"
    no digest spawn
  nextWakeAt = now + base * 2^quietTicks  (with optional jitter)
  lastWakeAt = now
  write tracker
unflock
```

**Digest spawn:** identical to a manual `atmux super-attach` invocation but writes a wake-line to the superdriver session's pane (or spawns the session if not running). The agent reads `superdriver-inbox.md` + per-team digests as part of its standard wake routine.

### Phase 2C — Cross-team writes

**New verbs / file artifacts:**

| Path | Purpose |
|---|---|
| `lib/super-epic.sh` | NEW. `atmux super-epic <team-list> <title> [--body <text>] [--driver-ref <ref>]` — mints cross-team Epic; appends a coordinated Epic record to each target team's `kanban.json:.epics[]` under per-team flock. |
| `lib/super-tell.sh` (delta) | Add `--task <kanban-task-json>` flag. Pushes a fully-formed Task into target team's kanban under that team's `kanban.json.lock`. |
| `lib/super-arbitrate.sh` | NEW. `atmux super-arbitrate <team-A> <team-B> --resolve <patch-json>` — coordinated multi-team-lock acquisition + per-team mutation + atomic rollback on partial failure. |
| `~/.claude/teams/superdriver-writes.jsonl` | Append-only audit trail; one JSONL line per cross-team write. Schema: `{"ts": <epoch>, "verb": "super-epic"|"super-tell --task"|"super-arbitrate", "origin": "superdriver", "targets": ["<team>", ...], "payload": {...}, "result": "ok"|"rolled-back", "error": "<msg>?"}`. Flock-guarded via sibling `.lock` file. |

**Storage decision (audit trail):** ADR-029's note about `registry.json:.superdriver.writeAuditLog` is **superseded** by this ADR — audit moves to a dedicated JSONL file. Rationale: append-only writes are simpler to flock-guard (no read-merge-write cycle); registry.json stays focused on team identity; JSONL lets `tail -f` work naturally for tail-following.

**Coordinated lock acquisition (super-arbitrate):**
- Sort target teams alphabetically by team name to obtain consistent global lock order (deadlock prevention).
- Acquire each team's `kanban.json.lock` in order; block on each (no try-flock — keep semantics simple).
- Apply per-team mutation atomically (each team's mutation is a regular flock-guarded `jq + mv`).
- On any per-team failure: roll back already-applied teams via reverse-order rewrite (require pre-mutation snapshot per team for rollback fidelity).
- Release locks in reverse order.

**Audit JSONL invariants:**
- Every cross-team verb writes ONE JSONL line per invocation (success or failure).
- Failed writes (any phase) include `"result": "rolled-back"` + the reason.
- Writes carry `{origin: "superdriver"}` so Constraint 4 self-isolation excludes these from quietTicks reset.
- Bats coverage MUST assert: every successful super-epic / super-tell --task / super-arbitrate invocation produces exactly one JSONL line.

**Phase 2C gates on Phase 2A:** cross-team writes need fleet-inbox observability so the superdriver knows which teams' members are responding to pushed Tasks/Epics. Sa-T1 (super-reply.sh) + Sa-T3 (superdriver.sock) MUST land before Sc-T1 dispatches.

### Phase 2D — `atmux drive <team>` UX verb

**New artifact:** `lib/drive.sh` + dispatcher entry in `bin/atmux`.

**Behavior:**
```text
atmux drive <team>
  resolve <team> via ~/.claude/teams/registry.json → projectRoot, sessionName, tmuxTmpdir
  if tmux session not running on team's tmuxTmpdir socket:
    spawn (delegate to atmux start <team> on the right cwd)
  attach to <sessionName>:1 (driver pane is window 1 by convention)
```

**Cross-cwd safety:** verb does NOT `cd` into the team's projectRoot in the calling shell. tmux attach happens on the team's socket; the team's panes already operate in their own projectRoot. Caller's shell remains where it was — same UX as `tmux attach` from anywhere.

**Failure modes:**
- Team not in registry → die with `"unknown team: <team>. Run atmux super-status to list registered teams."`
- Team's tmuxTmpdir directory missing → die with `"team <team> registered but cage-tmpdir <path> absent. Run atmux start in <projectRoot> first."`
- Driver pane not at window 1 → attach to whatever window the registry says holds driver; warn if drift from the position-1 convention (handles E14 Class C drift gracefully).

## Dependency graph

```text
Sa (Phase 2A — bidirectional comms)        [parallel with Sb + Sd; no Story-level deps]
  Sa-T1 BE super-reply.sh ─────┬────► Sa-T8 REVIEW
  Sa-T2 BE bin/atmux wire-in ──┤
  Sa-T3 BE superdriver.sock ───┤
  Sa-T4 BE super-tell polish ──┤
  Sa-T5 FE brief delta ────────┤
  Sa-T6 TEST super_reply.bats ─┤
  Sa-T7 TEST super_tell_polish ┘

Sb (Phase 2B — whip-cycle + backoff)       [parallel with Sa + Sd; gates on nothing]
  Sb-T1 BE super-whip.sh scheduler ─┬───► Sb-T8 REVIEW
  Sb-T2 BE detector + idle pred ────┤
  Sb-T3 BE bin/atmux + cron install ┤
  Sb-T4 FE brief discipline delta ──┤
  Sb-T5 TEST scheduler ─────────────┤
  Sb-T6 TEST self-isolation ────────┤
  Sb-T7 TEST inbox-idle predicate ──┘

Sc (Phase 2C — cross-team writes)          [GATES ON Sa-T1 + Sa-T3]
  Sc-T1 BE super-epic.sh ───────────┬───► Sc-T9 REVIEW
  Sc-T2 BE super-tell --task ───────┤
  Sc-T3 BE super-arbitrate.sh ──────┤
  Sc-T4 BE writes.jsonl audit ──────┤
  Sc-T5 FE brief delta ─────────────┤
  Sc-T6 TEST super_epic.bats ───────┤
  Sc-T7 TEST super_tell_task.bats ──┤
  Sc-T8 TEST super_arbitrate.bats ──┘

Sd (Phase 2D — atmux drive <team>)         [parallel with Sa; tiny scope]
  Sd-T1 BE drive.sh + dispatcher ───┬───► Sd-T3 REVIEW
  Sd-T2 TEST drive.bats ────────────┘
```

**Parallelism (per ADR-031):** be-kanban + be-kanban-2 dispatchable to Sa-T1 + Sb-T1 in the same lead turn. fe-kanban + test-kanban can take Sa-T6 + Sb-T5 + Sd-T2 concurrently. Sc Tasks queue until Sa lands.

## Consequences

- **Verb surface grows by 4** (`super-reply`, `super-whip`, `super-epic`, `drive`) + 1 polish (`super-tell --task` flag, `super-tell <team> <member>` direct-member default).
- **State files grow by 6** (`superdriver-inbox.md` + `superdriver-whip-state.json` + `superdriver.sock` + `superdriver-writes.jsonl` + per-team `super-reply-audit.md` + per-team `super-reply-rate.json`).
- **Cron grows by 1 line** (`*/5 * * * * atmux super-whip`). Bash tick cost <10ms when fleet quiet (verified via Sb bats spec); only fleet-event or daily-floor triggers Opus digest spawn.
- **Phase 1 surface unchanged** — registry, super-status, super-tell (existing), super-attach all stay. No regressions.
- **ADR-029 audit-storage note superseded** — JSONL file replaces `registry.json:.superdriver.writeAuditLog`. Document the supersession in ADR-029's status block (lightweight cross-ref edit; not a status change).
- **Bypass-log reframed already** (per ADR-034) — used here for super-reply rate-limit breach surfacing + future "wanted to do something not sanctioned" incidents.
- **Brief discipline becomes load-bearing** — Constraint 2 is mostly enforced by templates/briefs/superdriver.md content, not scheduler logic. Reviewer flags brief drift.

## Risk register

| Risk | Mitigation |
|---|---|
| `super-reply` rate-limit window leakage (epoch-bucket boundary) | Bats coverage on bucket boundary: rapid-fire 11 calls spanning a wall-clock hour rollover MUST allow 10 in current hour + 1 in next; reject excess. |
| Tracker file corruption from concurrent ticks | flock-guarded mutation; bats covers concurrent `super-whip` invocations; tracker schema validated on read (jq `type == "object"` + required keys). |
| Self-isolation gap — agent finds an unwatched write path that resets backoff | Closed allow-list of fleet-event paths (§Phase 2B detector). Bats asserts: super-status (read-only), super-tell with `{origin: "superdriver"}`, bypass-log appends, superdriver.log appends, tracker writes — none of these change `quietTicks`. |
| Cross-team arbitrate partial failure leaves teams in inconsistent state | Pre-mutation snapshot per team; reverse-order rollback; bats covers rollback fidelity (target team B's mutation fails → team A reverts). |
| Daily floor races with detector (event arrives at 23:59:59) | Detector runs first in tick logic; daily-floor branch only enters if no event found. Bats covers race window. |
| `atmux drive <team>` attaches to wrong window when driver position drifted (E14 Class C) | Registry stores authoritative driverWindow position; attach to that, warn if drift from position 1. |
| Member spam via super-reply (10/hr default too generous?) | Configurable via env var; reviewer signoff includes a 24h dogfood observation; cut to 5/hr if drift observed. |
| Audit JSONL grows unbounded over months | Out of scope this Epic; followup groom verb (extend `atmux groom` per ADDENDUM 13's E16) rotates monthly. Document in groom Epic (separate). |

## Open questions (planner reserves for implementation Tasks)

1. **OQ-A1 (low-rev): super-reply default member resolution.** Inside cage, `$ATMUX_DIR` resolves projectRoot but not member identity (driver pane vs lead pane vs member pane all share env). Resolve via `tmux display-message -p '#W'` matching `__<team>__<member>` window-name convention; fall back to `--from <member>` flag. Implementation Task: Sa-T1.
2. **OQ-A2 (medium-rev): pubsub event delivery semantics on superdriver.sock.** The superdriver session may not be running when a member super-replies; events must persist to fleet-inbox regardless. Decision: fleet-inbox.md is the durable log; socket is optional push-fast-path. Resolved here; bats verifies inbox writes succeed even when socket has no subscriber.
3. **OQ-B1 (low-rev): jitter default.** Off-by-default per single-host assumption today; planner-discretion to flip on if multi-host superdriver becomes a thing. Document the env var (`ATMUX_SUPER_WHIP_JITTER_PCT`).
4. **OQ-B2 (medium-rev): mtime read-side effects.** ext4 default-noatime on hax (verify in implementation Task Sb-T1). If FS uses atime updates, `cat`/`stat` reads of inbox files would bump mtime and pollute the detector — mount with noatime or use `stat --format=%Y` only without dereference. Verify once at implementation time.
5. **OQ-C1 (medium-rev): super-arbitrate scope on first ship.** Full coordinated-lock multi-team rollback is the long-form spec; first ship may bound to read-coordinate-write-one-side semantics (less rollback complexity) and add full multi-team mutation in a follow-up. Reviewer call during Sc-T3 dispatch. Document chosen scope in Sc-T9 signoff.
6. **OQ-D1 (low-rev): drive verb cwd preservation.** Verb explicitly does NOT cd in the calling shell. If operator wants project-shell context post-attach, they exec from inside the attached tmux window. Documented in §Phase 2D; no implementation question.

## Cross-references

- [ADR-025](./025-superdriver-phase-1.md) — Phase 1 surface (untouched).
- [ADR-029](./029-driver-lead-team-scope-superdriver-cross-team.md) — cross-team write authority; this ADR supersedes the audit-storage detail (JSONL file vs registry-embedded log).
- [ADR-031](./031-aggressive-parallelisation-default.md) — parallel BE/TEST dispatch applies; Sa+Sb+Sd in same lead turn.
- [ADR-032](./032-socket-pubsub-messaging-layer.md) — per-member socket pubsub primitive; superdriver.sock extends to fleet level.
- [ADR-034](./034-superdriver-phase-2-commit.md) — driver-authored commit; this ADR is its implementation pair.
- Driver-inbox 2026-04-28 08:05 MYT entry (Constraints 1-5 canonical source) — preserved verbatim in `t-8704d75a` body.
- Driver-inbox 2026-04-28 21:17 MYT entry (Phase 2 commit + ordering recommendation) — preserved verbatim in `t-8704d75a` body.
