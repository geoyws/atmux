# ADR-032: Socket pubsub as the messaging layer — supersedes file-write+keystroke-poll

**Status**: proposed
**Date**: 2026-04-27
**Driver-ref**: 14:10 MYT pivot from `/btw` 14:00 MYT — supersedes the 14:05 MYT supervisor-MVP routing (E10/Sh and the E12 inotify variant). Driver explicitly drops the inotify Phase 1 MVP in favor of a single coherent end-state.

## Context

The current messaging layer is **file-write + keystroke-poll**:

- `lib/send.sh::atmux::send_to_member` writes a tmp file, `tmux load-buffer`, `tmux paste-buffer`, `tmux send-keys Enter`. The pane "receives" via the user's TUI.
- `lib/dispatch.sh` writes `<member>-inbox.json` and follows up with a `tmux send-keys` keystroke ping.
- `lib/tell.sh::atmux::tell_lead` appends to `driver-inbox.md` and pings via `send-keys`.
- `lib/whip.sh` runs every 5 min from cron and pings each idle member's pane to "consider claiming next" — this is the polling-claim path.
- `lib/reply.sh` appends to `lead-outbox.md`; the lead reads it as a file on its own cadence.

Three failure modes have accumulated:

1. **No event-driven cascade.** When a Task transitions `done` and unblocks downstream Tasks via `deps[]`, no member is notified — they must wait for the next 5 min `atmux whip` tick or be manually `tmux send-keys`'d. P-95 unblock latency is 2-3 min; on a busy team with 4 cross-Story deps, this serializes work that should run in parallel.
2. **Send-keys is fire-and-forget.** `atmux::send_to_member` does a soft warn-but-proceed on detected mid-turn states (`Compacting conversation`, `Now using extra usage`, rate-limit banners) — the keystroke still goes in and either merges with a queued message, dies in a compacting reset, or answers a modal prompt with the wrong text. The hard-refusal logic exists in `lib/migrate.sh::_atmux_migrate_detect_blocker` (with the U+00A0 NBSP fix per `feedback_migrate_detector_quirks.md`) but is not invoked from the send path.
3. **State and notification are decoupled.** A verb writes JSON, then *separately* tries to wake the reader via `send-keys`. If the keystroke is dropped (rate-limited pane, racing `Compacting`), the reader never sees the new state until the next whip cycle. There is no transactional guarantee that "state mutated → reader woke up."

The architectural fix: **publish the event on a per-member UNIX socket, and have a member-side bash supervisor subscribe to that socket and gate keystroke injection through the migrate-grade preflight.**

This ADR records the decision; Epic E13 ships it.

## Decision

**Adopt UNIX-domain socket pubsub as the messaging layer.** Per `/btw` §4 (2026-04-27 14:00 MYT):

### Convention

- One socket per member at `.atmux/sockets/<member>.sock`.
- Listener owner: a per-member bash supervisor process (one per active member window) — see `Supervisor lifecycle` below.
- Wire format: JSONL events, one event per line. Schema:
  ```json
  {"type": "<verb>", "ts": <epoch>, "from": "<sender-member>", "payload": {…}}
  ```
  `type` examples: `dispatch`, `send`, `broadcast`, `tell-lead`, `reply`, `task-done-cascade`, `decisions-add`, `flag-add`, `flag-resolve`.

### Primitives — `lib/socket-pubsub.sh` (Story Sa)

Three helpers wrap the chosen socket implementation:

- `atmux::sock_bind <member>` — create + listen on `.atmux/sockets/<member>.sock`. Idempotent (unlinks stale socket if no live listener).
- `atmux::sock_publish <member> <event-json>` — connect, write JSONL line, disconnect. Non-blocking when listener absent (returns warn, does not fail).
- `atmux::sock_subscribe <member> <handler>` — accept loop; for each line, invoke `<handler> <event-json>`.

Implementation choice (OQ1 below): `socat UNIX-LISTEN:…,fork` for the listener, `socat - UNIX-CONNECT:…` for the publisher. Smallest dep, ubiquitous on Ubuntu/macOS/Linux, well-tested for fork-mode UNIX-LISTEN. Falls back to `python3 -c socketserver` only if socat is absent.

### Supervisor lifecycle — `lib/supervisor.sh` (Story Sb)

A bash background process per member, attached to the team's tmux session in a dedicated `__<team>__supervisor` window. Architecture:

- One supervisor window for the whole team (not per member). Within the window, a single bash process loops over every member in `team.json:.members[].name` and spawns a `sock_subscribe` background per member.
- Each subscription handler runs `_atmux_migrate_detect_blocker` against the member's pane state (NBSP-aware, viewport-only scan per `feedback_migrate_detector_quirks.md`) before injecting via `tmux send-keys`. If the preflight returns non-empty, the event is *deferred* to a per-member pending queue and re-tried on the next supervisor tick (≤30s).
- Crash recovery: a heartbeat file at `.atmux/state/supervisor.heartbeat` is touched every 5s. A `doctor` row checks `now - mtime < 30s`. If the supervisor dies, `atmux supervisor-start <team>` (or auto-restart from `atmux start`) re-spawns the window. Members publish to socket regardless; events queue up in-socket-buffer (kernel-side) until the listener returns — no event loss for short downtime.

### Verb wire-in (Story Sc)

Every state-mutating messaging verb publishes after its mutation:

- `lib/tell.sh::atmux::tell_lead` → `sock_publish <lead> {"type":"tell-lead", …}` after `driver-inbox.md` write.
- `lib/dispatch.sh::cmd_dispatch` → `sock_publish <member> {"type":"dispatch", "task_id":…}` after JSON inbox write.
- `lib/send.sh::atmux::send_to_member` → kept (still useful for "ping NOW") but now publishes a `send` event instead of `tmux send-keys`-ing directly. Supervisor handles the preflight.
- `lib/reply.sh` (planner→lead, lead→driver) → `sock_publish <lead-or-driver> {"type":"reply"}` after `lead-outbox.md` append.
- `lib/kanban.sh::task move` → on `done` transition, fires `sock_publish` to each member whose `claim --next` would unblock from `deps[]`, with `{"type":"task-done-cascade", "unblocked_task_ids": […]}`. Per-member-target debounce 100ms collapses bursts.
- `lib/decisions.sh::cmd_add` → `sock_publish <lead> {"type":"decisions-add"}`.
- `lib/flags.sh::cmd_add` and `cmd_resolve` → `sock_publish <lead> {"type":"flag-add" | "flag-resolve"}`.
- `lib/send.sh::cmd_broadcast` → publish to each addressed member.

Total ~12 wire-ins. Each verb publishes **after** state mutation (after kanban.json.lock release, after file flush) so the reader never sees an event for un-flushed state.

### Brief updates (Story Sd)

Lead + member briefs gain a "Socket-driven messaging" section explaining: the pane may receive supervisor-injected keystrokes between turns; treat as a normal `claim --next` nudge; supervisor handles the preflight so an injected keystroke is always safe to consume. Replaces the polling-claim discipline language.

### Test coverage (Story Se)

bats coverage:

- Socket lifecycle: `bind` is idempotent, `publish` to absent listener warns + non-fatal, `subscribe` accepts multiple lines.
- Concurrent publishers: 10 parallel `sock_publish` calls land all 10 events at the listener (no race-drop).
- Supervisor crash recovery: kill the supervisor PID; verify auto-respawn and event-queue catch-up.
- Send-keys preflight refuses mid-turn: stub `_atmux_migrate_detect_blocker` to return `compacting`; verify supervisor defers the event and does NOT inject.
- `task-done-cascade`: write a Task with deps `[t-A, t-B]`; mark both done; verify the dependent Task's owner-member receives one cascade event (not two — debounce works).
- No double-fire on rapid writes: 5 events within 100ms collapse to one `send-keys` injection.

### Polling-claim deprecation (Story Sg, gated on Sf signoff)

After REVIEW signoff on Sa-Se, `lib/whip.sh` removes its `claim --next` polling block. Cron `atmux whip` still fires every 5 min as a safety net for missed events; it now only runs the heartbeat + decisions-digest + state-summary side, not the polling-claim. Eventually deprecated post-Sg signoff once event-driven path is proven over a soak window.

### Production promote (Story Sh)

`rsync /opt/atmux-stable/` after Sa-Sg merge.

## Consequences

**For BE lane:** `lib/send.sh`, `lib/dispatch.sh`, `lib/tell.sh`, `lib/reply.sh`, `lib/kanban.sh`, `lib/decisions.sh`, `lib/flags.sh` all gain `sock_publish` calls after state mutation. `lib/start.sh` auto-spawns `__<team>__supervisor` window. New `atmux supervisor-start` verb. New `lib/socket-pubsub.sh`, `lib/supervisor.sh`.

**For TEST lane:** New bats files (socket_pubsub.bats, supervisor.bats, verb_publish.bats, plus an e2e socket lifecycle spec). Adds `socat` as a test-time dep — `tests/helpers/setup.bash` skips socket tests if socat absent (cloud base has it; macOS dev has it via brew).

**For OPS lane:** New tmux window in every running team (one per session). `atmux stop` gains a step to terminate the supervisor process and remove the heartbeat file. `atmux doctor` gains a `supervisor-liveness` row.

**For FE lane:** Lead + member briefs updated; no production-code FE work.

**What we give up:** Single-process simplicity. The team now has three categories of process: (1) member windows (Claude Code REPLs), (2) the supervisor window (bash event router), (3) cron (`atmux whip` 5-min safety net). The supervisor adds a failure mode — if it dies and the heartbeat alarm doesn't trigger doctor, events queue up un-routed. Mitigation: heartbeat + auto-respawn + cron-whip floor.

**What we gain:** Sub-second event latency on the deps[] cascade path; coherent transactional model (state-write-then-publish, never publish-then-state); the migrate-grade preflight gates every keystroke injection, ending the "merged into a queued message" failure class.

**Backward-compat window:** Until Sg deprecates the polling-claim from whip, both paths coexist. No flag-day cutover. Old teams without a supervisor still work via cron-whip.

**Rollback path:** Each verb's `sock_publish` is one-line, after state mutation, non-fatal on failure. Reverting Sc removes those lines; Sa+Sb supervisor + lib stay quiescent. Polling-claim still operational throughout — no demoware on the line.

## Open questions

Resolved at decompose time via `atmux decisions add` (per ADR-007 OQ-resolution pattern). Decision IDs noted in lead-outbox reply.

1. **Socket implementation** — `socat UNIX-LISTEN,fork` (recommended) vs `nc -U` vs `python3 -c socketserver`. **Default**: socat. **Why**: smallest dep, ubiquitous, well-tested fork-mode, BSD/GNU `nc` flag inconsistency burned previous attempts.
2. **Supervisor topology** — one supervisor window per team (recommended) vs one supervisor process per member. **Default**: per-team. **Why**: fewer windows in attach UI, single heartbeat to monitor, parallel subscriptions still happen via bash background within the window.
3. **Heartbeat cadence** — 5s touch + 30s alarm (recommended) vs 1s/10s. **Default**: 5s/30s. **Why**: 30s detection latency is well under cron-whip's 5min floor; 5s touch is cheap and survives normal load spikes.
4. **`task-done-cascade` debounce** — per-member-target 100ms (recommended) vs global 100ms. **Default**: per-member-target. **Why**: global debounce would coalesce unblocks targeted at *different* members, delaying parallel pickup; per-target collapses only the ambiguous "5 deps closed in a burst → one cascade ping" case.
5. **Sg polling-claim deprecation timing** — fire on Sf signoff (recommended) vs require a soak window. **Default**: fire on Sf signoff; cron-whip safety-net remains. **Why**: Se's bats coverage is exhaustive (concurrent publishers, crash recovery, preflight refuse); the cron-whip floor mitigates the "what if events miss" tail.
6. **ADR slot collision** — driver said "ADR-031" but `031-aggressive-parallelisation-default.md` is occupied. **Default**: ADR-032 (next free slot). **Why**: filename ledger is canonical; the file at slot 031 has a header mismatch (says `ADR-030`) but is referenced as 031 elsewhere. Renaming is out of scope here.

Resolved before flipping `Status: accepted`. Override any of the above by replying — cheap before E13/Sa-Sf land, expensive after.
