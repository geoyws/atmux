# ADR-005: `atmux doctor` + silent start preflight

**Status**: accepted
**Date**: 2026-04-25

## Context

Users hit opaque failures at `atmux start` time — claude missing from PATH, bad team.json, unwritable `.atmux/`, revoked Discord webhook. The error messages pointed at symptoms, not causes. Diagnosing required reading lib code.

## Decision

Two pieces:

1. **`atmux doctor`** — a `brew doctor`-style verb. Checks required deps (tmux, jq, git), optional deps (curl, bats, shellcheck), `team.json` schema, every member's TUI binary on PATH (resolving `member.command` → `team.tuiCommands[tui]` → built-in), `.atmux/` writability, and Discord webhook reachability if configured. Flags: `--quiet` (exit-code-only), `--fix` (interactive remediation, currently only re-runs wizard on bad team.json), `--json` (machine-readable).

2. **`atmux start` silent preflight** — start invokes `atmux doctor --quiet` before spawning panes. On red, aborts with a pointer: `preflight failed — run 'atmux doctor' to diagnose`. Escape hatches: `--doctor` for verbose preflight, `--no-doctor` to skip, `ATMUX_DOCTOR_ON_START=1` env to force verbose (useful in cron).

## Consequences

### What we gain
- Start failures become self-explanatory instead of mystery exits.
- Cost: ~50ms on every `atmux start` for the preflight (deps + schema + file stat). Worth it.
- `doctor --json` unblocks future CI-style checks (e.g., on commit hook: "is this repo's `.atmux/` healthy?").

### What we give up
- One more verb in the CLI surface. Mitigated by auto-invocation from start and from bare `atmux` (see ADR-006).
- `doctor --fix` auto-remediation is shallow today (only team.json). Other red items (missing deps, missing TUI on PATH) surface hints but don't install — because auto-`apt install`/`brew install` is risky without user clearance.

### Alternatives considered
- **Inline every check in `atmux start`.** Rejected — start becomes a 300-line soup of conditionals, and users can't rerun just the checks without also trying to boot.
- **Fail loudly on every start with a verbose report.** Rejected — for the 95% case where nothing's wrong, the verbose report is noise. Silent-on-green matches `tmux`, `git`, `docker compose up` etc.
