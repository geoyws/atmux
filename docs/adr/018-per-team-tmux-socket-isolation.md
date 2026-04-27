# ADR-018: Per-team tmux socket isolation — opt-in via `team.tmuxTmpdir`

**Status**: accepted
**Date**: 2026-04-27

## Context

Today every atmux team shares the user's main tmux server at `/tmp/tmux-$UID/default`. Both `sopx-mvp` and `atmux-kanban` ran on the same socket as the driver's daily-driver shell sessions and worktree windows. Two failure modes this exposes:

- **Blast radius on dangerous tmux ops.** atmux is in active development; a buggy `tmux kill-session -a` from a malformed `lib/stop.sh` change, or `atmux start --force` against the wrong team, can nuke unrelated sessions (other worktree shells, sopx-mvp, the user's daily REPL).
- **Pre-existing precedent in the test sandbox.** `tests/helpers/setup.bash` already exports `TMUX_TMPDIR=$ATMUX_TEST_TMP/tmux` so test churn never touches `/tmp/tmux-$UID/default` — incident 2026-04-25 (mass per-pane teardown wedged tmux 3.x). The same pattern applies one level up: the dev-on-itself team that's editing atmux internals deserves the same blast-radius firewall.

Three implementation shapes considered:

- **A (chosen)** — opt-in `team.tmuxTmpdir` field in `team.json`. `bin/atmux` reads it before any verb dispatch and exports `TMUX_TMPDIR` early. `lib/cron.sh` includes the env var in every emitted cron line. Default: unset → shared socket (today's behaviour).
- **B (rejected)** — make per-team isolation the default. Breaks every existing user's mental model + tmux-attach workflow (they'd have to `tmux -S /tmp/atmux-tmux-<team>/default attach` instead of `tmux attach`). Aggressive flip-default change for a benefit only the dev-on-itself team needs.
- **C (rejected)** — auto-isolate based on a heuristic (e.g. team name == repo dir basename → dogfooding team). Magic detection that's almost always wrong; explicit opt-in is clearer.

The interaction with ADR-016 (single-session topology) is benign: `singleSession=true` + `tmuxTmpdir` set means windows live in the driver's session **on the team's isolated socket**. Driver who opts into both attaches via `tmux -S <tmpdir>/tmux-$UID/default attach`. The two flags are orthogonal; neither implies the other.

## Decision

**Add OPTIONAL `tmuxTmpdir` field to team.json schema.** When set:

- `bin/atmux` exports `TMUX_TMPDIR=<value>` immediately after team-dir resolution, BEFORE sourcing `lib/common.sh` or invoking any verb that touches tmux. `mkdir -p "$value"` runs first; missing directory is auto-created (consistent with how `atmux_setup_sandbox` operates). Precedence: existing `$TMUX_TMPDIR` env > team.json `.tmuxTmpdir`.
- `lib/cron.sh::_atmux_cron_render_lines` prepends `TMUX_TMPDIR=<value>` to each `whip` / `report` / `decisions digest` line when the field is non-empty. Otherwise cron lines are unchanged. Without this, whip cron looks at the wrong server and reports session DOWN forever.
- `lib/doctor.sh` adds `_doctor_check_tmux_tmpdir`: when the field is set, asserts the directory is writable + (if a session exists) `tmux -S <tmpdir>/tmux-$UID/default ls` succeeds. Yellow on writable-but-no-session (cold start), green on healthy, red on unwritable / wrong-socket-detected.
- `lib/init.sh` wizard does NOT prompt for `tmuxTmpdir`. Opt-in is manual `team.json` edit; documented in README. (Wizard bloat avoided; the field is for advanced/dogfooding setups.)

After this Epic ships, set `tmuxTmpdir: "/tmp/atmux-tmux-atmux-kanban"` in `/root/work/src/atmux/.atmux/team.json` (the dev-on-itself team) + restart atmux-kanban on its own socket. `sopx-mvp` stays on the main socket (it's not the dev-on-itself team).

## Consequences

- **One new schema field.** Optional, ignored when absent — zero impact on existing teams.
- **bin/atmux gains ~12 LOC** for the early TMUX_TMPDIR resolution.
- **lib/cron.sh::_atmux_cron_render_lines gains ~4 LOC** to prepend the env var conditionally.
- **lib/doctor.sh gains one row + ~30 LOC.**
- **README** documents the opt-in: when to use, how the cron lines change, how to attach (`tmux -S /tmp/<tmpdir>/tmux-$UID/default attach`).
- **Driver attach UX changes** for opted-in teams: bare `tmux attach` no longer reaches the team. `atmux attach` (lib/attach.sh) already routes through `atmux::session_name`; we extend it to also honour `TMUX_TMPDIR` (no change needed if the env var is set globally before attach runs — which it is, via bin/atmux).
- **Rollback path**: remove the field from team.json + restart. Cron lines re-render without the env var on next `atmux start`. No data migration; tmux state is ephemeral.

## Open questions

1. **OQ3: auto-create `tmuxTmpdir` if missing?** Resolved: yes — `mkdir -p` in bin/atmux. Consistent with `atmux_setup_sandbox`. (low-rev.)
2. **OQ4: should init wizard prompt for tmuxTmpdir?** Resolved: NO. Manual edit only; README documents. Field is for advanced dogfooding setups, not first-run UX. (low-rev — easy to add wizard prompt later.)
3. **Out-of-scope carve-out**: `lib/attach.sh` does NOT need a `-S <socket>` plumbing change because bin/atmux exports `TMUX_TMPDIR` globally before attach runs. If a future ADR allows attaching to a team WITHOUT going through the bin/atmux entrypoint (e.g. systemd user service), revisit this.

All resolutions logged to `.atmux/decisions.md` via `atmux decisions add`.
