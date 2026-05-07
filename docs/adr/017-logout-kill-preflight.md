# ADR-017: Logout-kill preflight — linger detection in doctor + start

**Status**: accepted
**Date**: 2026-04-27

## Context

On 2026-04-26 17:37:46 MYT, the driver's SSH session-3.scope ended. systemd-logind reaped the cgroup; both atmux teams (`myteam-alpha` + `atmux-kanban`) died with the user's tmux server. Root cause: Ubuntu's stock systemd shipped `KillUserProcesses=yes` since systemd 230, and the user did not have `Linger=yes` set via `loginctl`. Effect:

- Two team supervisors lost mid-flight state.
- One orphan `atmux-spawn` scope kept burning CPU for 2h27m before being noticed.
- Whip cron (registered via crontab, survives logout) kept firing every 5 min and pinged Discord with "session DOWN" until manually disabled — noisy false alarms while the real problem was the session topology.

Driver remediation: `loginctl enable-linger root` + relaunched both teams under `systemd-run --user --scope --slice=app.slice`. The fix is a one-liner; the **detection** is the missing piece. atmux today happily spawns into a session that is one logout away from extinction.

The probe is mechanical:

```bash
loginctl show-user "$(id -un)" --property=Linger    # Linger=yes|no
grep -E '^KillUserProcesses=' /etc/systemd/logind.conf  # may be commented (=default yes)
```

If `Linger=no` AND (`KillUserProcesses=yes` OR unset on systemd ≥230), the team is exposed. The UX call is what to do about it.

## Decision

**Add `_doctor_check_logout_kill` to `lib/doctor.sh`.** Wired into `main()` alongside the existing `_doctor_check_*` battery. Reads `loginctl show-user --property=Linger` + `/etc/systemd/logind.conf`. Surfaces:

- **green** — `Linger=yes`. No further action.
- **yellow** — exposed (linger off + KillUserProcesses on/unset) AND session type is local (`tty`). The driver may legitimately accept the risk for local dev.
- **red** — exposed AND session type is `ssh` (read from `loginctl show-session "$XDG_SESSION_ID"` or fallback `$SSH_CONNECTION` non-empty). This is the incident shape.

**`atmux doctor --fix` adds `_doctor_try_fix_logout_kill`.** Tries `loginctl enable-linger "$(id -un)"`. On EPERM (non-root user without polkit auth), prints the `sudo loginctl enable-linger "$(id -un)"` invocation and returns non-zero — no automatic sudo elevation.

**`atmux start` preflight** already invokes `atmux doctor --quiet`. Today `--quiet` swallows yellow/red detail and only conveys exit code. Add a dedicated unmissable line in start when the logout-kill row is non-green: `⚠️  logout-kill exposure: tmux server will die when this SSH session closes. Run \`atmux doctor --fix\` to enable linger.` Start does NOT refuse — driver may legitimately want to spin up an ad-hoc team for a single session.

## Consequences

- `lib/doctor.sh` gains one check function + one fix function (~40 LOC).
- `lib/start.sh` gains ~6 LOC for the warning surface.
- `tests/unit/doctor_logout_kill.bats` covers four matrix cells (linger on/off × ssh/tty session) + --fix invocation path.
- README gets a "preflight: logout-kill exposure" section explaining what the warning means and how to dismiss it.
- No new dependencies (`loginctl` is part of systemd, present on every modern Linux; check is a no-op on macOS — `loginctl` absent → skip the row, no warning either way).
- Trade-off accepted: red on ssh-session exposure is intentionally aggressive. Driver can override by running `atmux doctor --fix` or by accepting yellow downgrade via `team.json:.preflight.lingerSeverity = "yellow"` (deferred — not built in S1; revisit if false alarms accumulate).

## Open questions

1. **OQ1: `--fix` autoexec or print-only?** Resolved: try `loginctl enable-linger`; on EPERM, print `sudo` invocation. (low-rev — easy to flip later.)
2. **OQ2: yellow vs red?** Resolved: yellow on local-tty session, red on ssh session. (medium-rev — UX call; might soften to all-yellow if ssh-detection is unreliable.)
3. **OQ5: should `atmux start` REFUSE on exposure?** Resolved: warn only, do NOT refuse. Driver may accept the risk for short-lived ad-hoc runs. (medium-rev — annoying if wrong.)

All resolutions logged to `.atmux/decisions.md` via `atmux decisions add`.
