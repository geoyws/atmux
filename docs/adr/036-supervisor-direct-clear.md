# ADR-036: Supervisor-driven `/clear` on stuck panes — direct, with rotation log

**Status**: accepted (George 14:13 MYT 2026-05-08 — partially implemented in `src/core/send.ts` verify-mode + `src/verbs/stop.ts` modal-stuck handling; remaining work folds into HC#4 live-status of ADR-068)
**Date**: 2026-04-30
**Driver-ref**: 16:30 MYT — driver pivot from "split signal from action" sketch (lead-recommended) to "supervisor /clears directly + logs". Driver explicitly chose the simpler/coupled shape; no whip-handshake.

## Context

ADR-032 introduced the per-team supervisor as pure messaging plumbing: subscribe on `.atmux/sockets/<member>.sock`, gate `tmux send-keys` injection through `_atmux_migrate_detect_blocker`, queue events when blocked, retry on the 30s sweep.

Today's gap: a member that stays blocked forever (rate-limit banner that never clears, modal prompt no one dismisses, compose buffer with abandoned draft text, Compacting that wedges) accumulates queued events in `.atmux/state/queues/<member>.jsonl` indefinitely. The supervisor logs warnings on each retry but never escalates. `lib/whip.sh` has a 5-min cron tick that *can* rotate (`/clear`) members, but its blocker-detection is intentionally laxer (per ADR-009 — rotate fires on uptime + context-bloat signals, not every banner the supervisor flags). So it's possible — observed — for a member to be supervisor-blocked but whip-not-rotating, leaving the queue stranded.

Two shapes were considered:

- **A — Signal-only supervisor.** Supervisor writes `.atmux/state/queues/<member>.rotate-request` markers; whip reads them and runs `lib/rotate.sh` from its own (already-working) code path. Splits signal from action. Pro: keeps supervisor pure plumbing, single owner of `rotate.sh`. Con: extra hop; rotation latency = next whip tick (≤5 min); two systems to coordinate.
- **B (chosen) — Supervisor /clears directly.** Supervisor calls `lib/rotate.sh::_atmux_rotate_member` itself when a member's blocked-duration crosses a threshold. Pro: zero rotation latency once threshold hits, single coherent process for the whole event lifecycle, no marker-file dance. Con: supervisor now does both messaging plumbing AND rotation judgment; lock contention with whip's concurrent rotation path needs care.

Driver chose B explicitly — simpler, shorter feedback loop, supervisor is already Opus-grade reasoning context (it preflights pane state on every event), and the lock-contention concern is bounded (rotate.sh already takes a per-member flock; supervisor and whip serialize naturally through it).

## Decision

**Supervisor gains a stuck-watchdog that runs `_atmux_rotate_member` directly when a per-member blocker persists beyond a configurable threshold.** Concrete shape:

1. **Per-member blocked-state tracker** — `_atmux_supervisor_pids[$member]` already maps member → subscriber-PID. Add a parallel `_atmux_supervisor_blocked_since[$member]` (epoch seconds when first-blocked-seen, 0 otherwise). Updated in `_atmux_supervisor_handle_event` and the queue-sweep loop:
   - On event arrival, blocker non-empty → if `blocked_since[$member]` is 0, set to now. Otherwise leave (preserves first-seen).
   - On event arrival, blocker empty → reset to 0.
   - On queue sweep, if pane still blocked → leave timestamp. If pane now clear → reset to 0 + drain queue (existing behaviour).

2. **Per-blocker-type thresholds** — defaults derive from the blocker label returned by `_atmux_migrate_detect_blocker`:

   | Blocker | Threshold | Reasoning |
   |---|---|---|
   | `rate-limited` / `approaching-limit` | 600s (10min) | Rate-limit windows are short; if it's still wedged after 10min the session needs a clear anyway |
   | `Compacting` / `compacting` | 1800s (30min) | Compacting can take minutes; allow generous headroom |
   | `modal-prompt` / `queued-input` | 300s (5min) | A human/model would have answered by now |
   | `thinking` | 1200s (20min) | Long thoughts are real; only rotate if pathological |

   All overridable via `ATMUX_SUPERVISOR_STUCK_THRESHOLD_<TYPE>=<seconds>` env vars, set in team.json:.supervisorThresholds → exported by start.sh.

3. **Watchdog tick — piggyback on the queue-sweep loop.** No new background loop. Each sweep iteration adds a per-member age check:
   ```
   for member in members:
     if blocked_since[member] > 0 and (now - blocked_since[member]) > threshold(blocker):
       _atmux_supervisor_rotate_member member <reason>
   ```

4. **`_atmux_supervisor_rotate_member <member> <reason>`** — new function in `lib/supervisor.sh`. Sources `lib/rotate.sh` lazily; calls `_atmux_rotate_member <member>`. Wrapped in `flock --timeout=5 .atmux/state/rotate-<member>.lock` to serialize against any concurrent whip-driven rotation. Returns non-zero on flock-contention (whip is rotating right now; supervisor backs off, retries next sweep).

5. **Rotation log — `.atmux/state/rotation-history.jsonl`** — append-only JSONL on every supervisor-driven (or whip-driven) rotation. Schema:
   ```
   {"ts": <epoch>, "member": "<name>", "team": "<team>", "reason": "<blocker-type>", "blocked_for_s": <secs>, "queue_depth": <n>, "by": "supervisor" | "whip", "host": "<hostname>"}
   ```
   Both `_atmux_supervisor_rotate_member` and `_atmux_rotate_member` call a shared `atmux::rotation_log_append` helper (new function in `lib/rotate.sh`). Existing `team-log.md` and Discord whip-rotation pings keep firing — JSONL is the structured audit trail, the markdown/Discord paths are unchanged.

6. **Doctor row — `rotation-storm:<member>`** — yellow row when `rotation-history.jsonl` shows ≥3 rotations of the same member in the past hour. Indicates a pathological rotation loop (rotation didn't actually clear the blocker, member re-enters rate-limit immediately). Fix-hint: investigate the underlying blocker; manual `/clear` + content review before re-claiming work.

7. **Cooldown** — after a supervisor-driven rotation, set `blocked_since[member] = 0` AND record `last_rotated[member] = now`. Skip subsequent watchdog firings for that member while `now - last_rotated[member] < ATMUX_SUPERVISOR_ROTATE_COOLDOWN_SEC` (default 300s = 5min). Prevents back-to-back rotations on a sticky blocker.

## Consequences

**For lib/supervisor.sh:** ~80 LOC added. Tracker arrays + threshold table + watchdog block + rotate function + cooldown gate. Pure additions; no changes to existing event-injection path.

**For lib/rotate.sh:** ~15 LOC added. New `atmux::rotation_log_append` helper. Existing `_atmux_rotate_member` body unchanged; the helper is called at the same spot the team-log markdown is appended.

**For lib/doctor.sh:** ~25 LOC added. New `_doctor_check_rotation_storm` row.

**For team.json schema:** OPTIONAL `.supervisorThresholds` object with per-blocker-type overrides. Backwards-compat default = the table above. No required field.

**For lib/whip.sh:** unchanged. Whip continues to drive its own rotation cadence on its own signals (uptime, no-progress, member-claimed-and-stalled). Supervisor's blocker-driven rotation is additive — both write to the shared `rotation-history.jsonl` so audits show both rotation paths.

**Lock contention:** rotate.sh's per-member flock serializes whip vs supervisor. The 5s timeout in supervisor's wrapper means worst-case the supervisor backs off and tries next sweep (30s later). Whip and supervisor never double-rotate the same member.

**Observability:** `rotation-history.jsonl` gives queryable audit. `atmux super-status` can grow a "rotation rate per team" column that reads the file. Discord pings stay opt-in via existing whip-rotation Discord templates.

**Rollout:** supervisor change is per-team — only takes effect after the next `atmux start <team>` (or supervisor respawn). Existing supervisors keep running the old behaviour until their team is restarted. No fleet-wide flag-day.

## Open questions

1. **OQ1: thresholds per team vs per blocker-type vs both?** Resolved: per-blocker-type defaults (table above) with per-team overrides via team.json. Keeps simple defaults sane while allowing experimental tuning per team without forking the source.

2. **OQ2: should supervisor rotate a member that has uncommitted edits?** UNRESOLVED. Risk: rotation `/clear`s the claude session, losing chat context. If the member was mid-write to `.atmux/state/queues/...` or had un-committed git edits, those survive (files on disk), but in-flight reasoning context is lost. Per the broader rotation philosophy (lib/rotate.sh:_atmux_rotate_check_uncommitted), rotation already pings gitter to commit before /clear. Supervisor-driven rotation should follow the same gate — defer rotation if `git status -s` in member's cwd shows uncommitted work, log a `rotation-deferred` event, and re-check next sweep. Resolution: yes, gate behind the same uncommitted check. Add to implementation scope.

3. **OQ3: behavior when `lib/rotate.sh` source-load fails?** Lazy-source pattern (matches supervisor.sh's existing `lib/migrate.sh` lazy import). On failure: log warn, skip rotation this tick, return 0. Member stays in stuck-state until next sweep retries the source-load.

4. **OQ4: cooldown bypass for `--force`?** Out of scope — rotation is automatic only. Manual `atmux rotate <member>` (operator command) is a separate path, no cooldown applies there.

## Test coverage

**bats — `tests/unit/supervisor_stuck_watchdog.bats`:**
- Synthesize a member at rate-limit-blocker for 600s; assert watchdog fires `_atmux_rotate_member` exactly once.
- Synthesize the same scenario but with `last_rotated[member] = now - 60`; assert cooldown gate skips the fire.
- Synthesize Compacting blocker for 600s; assert watchdog does NOT fire (threshold is 1800s).
- Synthesize an uncommitted-git-status pre-condition; assert rotation is deferred + a `rotation-deferred` event is logged.
- Concurrent whip+supervisor rotation race: spawn synthetic whip rotate while supervisor's watchdog ticks; assert flock serializes (one rotation, one log entry, the loser backs off cleanly).

**Integration — `tests/integration/rotation_storm_doctor.bats`:**
- Append 3 rotation-history.jsonl entries for member X within the past hour; assert `atmux doctor` emits a yellow `rotation-storm:X` row.
- Append 3 entries for X but >1h apart; assert no row.

## Cross-references

- ADR-009: auto-rotation philosophy (whip-driven path; this ADR adds supervisor-driven path).
- ADR-032: socket pubsub messaging layer (supervisor's existing role; this ADR extends without breaking).
- `feedback_migrate_detector_quirks.md` (memory): NBSP-aware viewport scan for `_atmux_migrate_detect_blocker` — same scan the supervisor already runs on every event. No change to the detector itself.
