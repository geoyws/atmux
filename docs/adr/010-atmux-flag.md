# ADR-010: atmux flag — member→lead structured issue surfacing

**Status**: accepted
**Date**: 2026-04-25
**Epic**: E4 (`e-186a469d`)
**Driver-ref**: `driver-inbox.md` @ 17:00 MYT 2026-04-25 (F.1–F.6 sub-task suggestion)

## Context

E1's decisions verb (ADR-008) gave the lead a structured way to surface decisions to the driver — append-only `.atmux/decisions.md` + Discord ping + whip cursor. The reverse direction (member → lead) has no equivalent. Members surface issues today via:

- `atmux send lead "<prose>"` — unstructured, lead has to scan message stream.
- `atmux reply "<prose>"` — same problem, plus reply lands in lead-outbox.md (wrong channel for in-flight blockers).

Today's gaps:

- **Unstructured.** Lead has to parse prose to extract severity / needs / linked task.
- **Not kanban-visible.** Blockers live in the message stream and disappear on `/clear`.
- **No escalation path.** No way to surface p0 to Discord without member writing a custom `bash + ping-discord.sh` dance.
- **No brief guidance.** member.md never tells workers what to do when stuck. Today's behaviour: silent-suffer (gitter sat on a wedged Monitor 30+ min in the E1 incident before driver caught it).

E4 introduces `atmux flag` — symmetric to `atmux decisions` but member-side.

## Decisions

### D1 — `lib/flags.sh` sits next to `lib/decisions.sh`; same shape

Append-only `.atmux/flags.md`, `### f-xxxxxxxx` heading per entry, fields as bullets, parsed by awk same as decisions.md. Verbs: `add` / `list` / `show` / `resolve`. Reuses `atmux::discord_ping` from `lib/discord.sh` (no reinvention).

**Why**: Symmetry has cost (slightly bigger codebase) but pays back in cognitive load — a worker who knows decisions verb instantly knows flags verb. Same parser, same Discord template family, same webhook resolution chain.

### D2 — `--severity p0` is the ONLY level that pings Discord

p1 and p2 fire `tmux send-keys` to lead pane + write to `flags.md` (kanban-visible) but stay off Discord. `[atmux-flags]` template only constructed for p0.

**Why**: Discord noise discipline. Today's `[whip-*]` family is already noisy; if every p2 "minor question" hits Discord, driver mutes the channel. p0 = "blocking demo / critical decision" — that's the bar for waking the driver on phone. p1/p2 ride kanban + lead pane (which is where lead lives anyway).

If real-world friction surfaces (lead misses p1 for hours), revisit with `--severity-discord-floor` config. Non-breaking change.

### D3 — `--task <id> --needs unblock` flips task to `blocked` AND appends flag id to `.note`

Single flag verb does two things — kanban state mutation + note linkage — when the combination is `--task` + `--needs unblock`. Other `--needs` values (decision/review/context/rotate) with `--task` append to `.note` ONLY (no status change).

**Why**: A flag with `--needs unblock` IS by definition a block on that task. Forcing the worker to run two commands (`atmux flag ... --task X` then `atmux task move X blocked`) is friction that will be skipped under stress. Coupling them makes the durable kanban state match reality.

For `--needs decision/review/context/rotate`: the task isn't necessarily blocked (could just be "I need a clarification but I can keep working on adjacent stuff"). Note-append-only preserves status.

### D4 — Mid-rotation flag send: lost-keystroke acceptable; flag persists durably

When a member fires `atmux flag` while lead pane is mid-`/clear` (auto-rotate from E2): the `tmux send-keys` "now signal" may land in the void or as the first text in the freshly-bootstrapped pane. The flag entry STILL writes to `.atmux/flags.md` durably. Whip will surface it on the next 5-min tick regardless. We do NOT defer the send via reading `<lead>-rotated.epoch`.

**Why**: Adding a defer mechanism (read E2's rotated.epoch, sleep, retry) couples E4 to E2 hard, and the corner case is rare (auto-rotation fires once per 60min; flag send is sub-second). Whip's 5-min tick + flags.md durability is sufficient backstop. We document the corner case here so future readers know it's a known accepted-cost, not an oversight.

If the lead's bootstrap brief gets corrupted by a `📍 flag from foo: ...` keystroke landing as the first user input: that's worse than expected. We mitigate by reading `atmux::capture_pane lead` BEFORE send and detecting `Compacting conversation` / `hit your limit` banners — if present, log + skip the send (flag still persists). This handles ~80% of the bad-state cases without per-rotation-epoch coordination.

## Consequences

**What changes**

- New file `lib/flags.sh` (~250-300 LOC, mirrors decisions.sh).
- New state file `.atmux/flags.md` (append-only).
- New `bin/atmux` dispatcher entry.
- `lib/whip.sh` gains `_atmux_whip_check_flags` mirroring `_atmux_whip_check_decisions` (~30 LOC).
- `lib/kanban.sh` gains `atmux::task_append_note` helper (single-line append, newline-separated).
- `templates/briefs/lead.md` gains a "read flags.md at top of whip loop" line in the existing bootstrap section.
- `templates/briefs/member.md` gains a new §"When to flag" with examples.
- 3 new bats files: `tests/unit/flags.bats`, `tests/unit/flags_discord.bats`, `tests/unit/whip_flags.bats`.
- 1 new e2e: `tests/e2e/flags.bats`.
- CHANGELOG v0.5.0 entry (consolidated alongside E2 — single release covers both).

**What breaks**

- Nothing. `atmux flag` is a new verb. Existing `atmux send lead` / `atmux reply` flows unchanged. Workers can adopt incrementally.

**What we give up**

- Custom severity-Discord floors (D2). Defer until friction.
- Mid-rotation flag-send precision (D4). Defer until ADR-009 follow-up if needed.
- Flag→Discord in p1/p2 lanes for narrow use-cases ("I want this p1 also pinged"). Defer.
- Flag aggregation / deduplication (e.g., 3 members file the same flag → collapse to one Discord ping). Out of MVP scope.
- `atmux flag rotate` shortcut (member-initiated request for own pane rotation). Folded into `--needs rotate` field; lead acts via `atmux rotate <member>`. No new verb.

**Cross-Epic relationship**

E2 and E4 are PARALLEL per lead 17:58 directive — neither blocks the other. The mid-rotation corner case (D4) is the only point of coupling, and we handle it via banner-detection in `lib/flags.sh` (not via reading `rotated.epoch`). When item 007 (cross-Epic deps schema) ships, E4's Epic could declare a SOFT dependency on E2 (advisory, not blocking) for documentation purposes — but no schema change needed today.

## Open questions deferred to future Epics

- Severity-Discord floor configurability (`team.flags.discordFloor: p0|p1|p2`). Defer until friction surfaces.
- Flag aggregation / dedup across members. Defer — may not be a real problem.
- `atmux flag history --task <id>` — list all flags ever filed against a task (for retros). Defer to E5+ analytics.
- Flag SLA reminders (whip pings if a p0 flag is open >30min unresolved). Natural follow-up; defer to keep MVP tight.
- Member self-resolve auto-detection (member fires another flag with `--needs context` after the first; second auto-resolves first). Out of scope; lead resolves manually for now.
