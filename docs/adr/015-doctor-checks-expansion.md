# ADR-015: Doctor checks expansion — cron health + phantom inbox detection

**Status**: accepted
**Date**: 2026-04-26

## Context

`atmux doctor` today checks: deps, libs, team.json, TUIs, state-dir, webhook, crontab. It does NOT check whether the cron is *actually firing* (only that the crontab entry exists), and it does not cross-check inbox entries against kanban truth.

Two observed gaps:

1. **Cron silent failure.** If the crontab entry exists but the cron daemon stopped, or the wrapper script errors mid-run, whip never fires. Symptom: `.atmux/state/whip-last.hash` mtime ages out indefinitely while the team session looks healthy. Today: no observability — only the absence of Discord pings tells you something is wrong, and only after hours of staring at silence.

2. **Phantom inbox entries.** Per ADR-013, atomicity bugs can leave inbox entries with no kanban backing. Whip's tick-time auto-prune (T1.1) handles ongoing operation, but a one-shot `doctor` check is the right tool for: cold-start audit, post-incident verification, CI/automation integration.

## Decision

**Two new doctor checks, both yellow-only (never red):**

1. **`_doctor_check_whip_hash`** — if `.atmux/state/whip-last.hash` mtime > 24h ago AND `atmux::tmux_session_exists`, flag yellow `whip-last.hash stale (>24h) — cron likely broken`. Skip the check entirely if the session is down (legitimately paused team).

2. **`_doctor_check_phantom_inboxes`** — calls the shared `atmux::find_phantom_inbox_ids()` helper (introduced in ADR-013 / T1.1). For each phantom, append yellow `<member> inbox.inProgress contains phantom <id> ("<subject>")`. `doctor --fix` prunes via `atmux::jq_update`.

**Both checks are yellow, never red.** Stale whip-hash on a long-paused team is legitimate; phantoms are recoverable. Red is reserved for "atmux is broken" — these are "atmux state is suspicious."

**Shared helper, shared definition.** Whip's auto-prune (T1.1) and doctor's check (T3.1+T3.2) consume the same `atmux::find_phantom_inbox_ids()` function. There is one canonical definition of "phantom inbox entry" in the codebase.

## Consequences

- **BE (T3.1):** lib/doctor.sh grows `_doctor_check_whip_hash` + `_doctor_check_phantom_inboxes`. `_doctor_try_fix` learns to prune phantoms.
- **TEST (T3.3):** tests/unit/doctor_audit.bats covers both checks + `--fix` idempotence.
- **Surfacing:** `atmux doctor` output now flags cron-silent and phantom-inbox conditions. Useful in CI/automation pipelines (`doctor --json | jq '.findings[] | select(.severity=="yellow")'`).
- **No new dependencies.** Reuses existing `_doctor_check_*` harness.
- **Rollback:** revert T3.1; existing doctor surface remains.

## Open questions

1. **Stale-hash threshold = 24h or shorter?**
   *Resolved (planner default, low-reversibility):* 24h. Long-paused teams legitimately go quiet for many hours; cron broken < 24h is rarely worth flagging (single missed tick can be intermittent). 24h is the "definitely something's wrong" threshold.

2. **`--fix` for stale whip-hash?**
   *Resolved (planner default, low-reversibility):* No — log + nudge only ("check crontab; ATMUX_DEBUG=1 atmux whip --once"). Doctor cannot auto-restart cron without root, and shouldn't try.
