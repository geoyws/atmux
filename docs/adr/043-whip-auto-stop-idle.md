# ADR-043: Whip auto-stop on prolonged team idleness

**Status**: accepted
**Date**: 2026-05-03
**Driver-ref**: 2026-05-03 session — operator observed 5 teams configured but only one (`atmux`) actually burning tokens; rest were phantom 1-pane sessions or stopped. Operator request: "make sure to shut down teams when idle for more than two ticks in any team."

## Context

`atmux whip` already detects per-member idleness (stale-task warnings, banner detection, lead uptime) and computes a per-tick body hash for Discord-ping dedup. The hash matches across consecutive ticks when a tick produced **no commits, no done-task moves, no advanced stories, no new decisions / flags / audits, and no fresh per-member findings** — i.e. the team's agents are running but making no observable progress.

Until now, that "nothing happened" state had no termination semantics. A team left running over a weekend would keep its 10 claude panes alive indefinitely, each periodically waking to render the prompt or compact context — quietly burning tokens for no work output.

`atmux stop` archives state and kills the tmux session, so termination is reversible (`atmux start` resumes from archived kanban + decisions). The only missing piece was an automated trigger.

## Decisions

### D1 — `team.whip.autoStopAfterIdleTicks` config field, default `0`

Integer in `team.json` under the `whip` key. Semantics:

- `0` (default, disabled): preserves prior behaviour — whip never auto-stops. Safe migration for existing OSS deployments.
- `N > 0`: after `N` consecutive idle ticks, whip invokes `atmux stop` on the team.

**Why**: matches the established `whip.downConfirmTicks` shape (integer-tick threshold) and `whip.autoRotate` opt-in convention from ADR-009. Conservative default protects non-opted-in users from surprise termination.

### D2 — Idle = body-hash unchanged OR no findings

Reuses the existing dedup primitive. A tick is counted as idle when:

1. The findings array is empty (`whip: all clean` path), OR
2. The findings array is non-empty but its body hash equals the previous tick's hash (already-known stale warnings, recurring lead-uptime nags, etc — none of which represent forward progress).

A tick where the body hash CHANGES (real news: new commits, done tasks, advanced stories, decisions, flags, audit findings, or any new per-member finding) resets the counter to zero.

**Why**: the body-hash machinery is already maintained for ping-rate dedup. Layering the auto-stop counter on it requires no new signal collection. "No new state since last tick" is a strict, well-defined notion of "team is making no progress."

### D3 — State file `.atmux/state/whip-idle-state.json`

Shape: `{"idleTicks": <int>}`. Written via `atmux::jq_update` (the same flock'd helper as `whip-session-state.json`); cleared on activity, cleared on auto-stop attempt to prevent double-fires if the stop racy-fails.

**Why**: parallel structure to ADR-009's `whip-session-state.json` keeps the state-dir layout consistent.

### D4 — Pre-stop Discord ping uses the `whip-autostop` trigger label

The auto-stop helper sets `ATMUX_DISCORD_TRIGGER=whip-autostop` before pinging. Operators who route Discord webhooks per-trigger can filter on this label.

**Why**: trigger labels are already a first-class concept (`ATMUX_DISCORD_TRIGGER` is honored by `atmux::discord_embed_ping`).

## Consequences

**What changes**

- `lib/whip.sh` gains `_atmux_whip_check_auto_stop` helper (~50 lines) and three call sites in `_atmux_report_and_exit` (one per body-hash branch: empty, unchanged, changed).
- `team.json` schema gains optional `whip.autoStopAfterIdleTicks` integer.
- 1 new bats file: `tests/unit/whip_autostop.bats` (5 tests).

**What breaks**

- Nothing for `autoStopAfterIdleTicks: 0` (default). Pure no-op migration.
- For teams that opt in: the team WILL be stopped automatically after N idle ticks. State is archived, so `atmux start` recovers. The lead's accumulated context IS lost (same trade-off as `atmux stop`).

**What we give up**

- Per-member idle granularity. The whole team stops together. A team where 9 members are idle and 1 is busy will NOT auto-stop (the busy member's findings keep the body hash moving). This is intentional — partial-stop is more confusing than uniform behavior.

## Open questions

- **Should the threshold default to `2` for new teams via the `init` template?** Not in this ADR. The OSS default stays `0`; operators opt in per-team. If usage data later shows 100% of users set `2`, revisit.
- **Should auto-stop ping the operator pane (not just Discord) before stopping?** Considered and deferred. The Discord ping is the documented escalation path; pane-side notifications would require operator-attached-vs-detached detection that isn't worth the complexity for an opt-in feature.
