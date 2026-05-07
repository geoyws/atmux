# ADR-051 — `cron_install` self-heals stale blocks + injects env preamble

**Status:** accepted (2026-05-06)

## Context

atmux exists to let **agent teams work autonomously, completing tasks
with minimal human input**. The cockpit + lead + planner + member panes
are designed to run for hours unattended; the operator only steps in for
HIGH-rev decisions, demo redirects, or genuine blockers. Anything that
silently stalls a team — kanban dispatch, lead whip, member spawn —
breaks that contract directly.

On 2026-05-06, the `sopx` and `unum` cage tmux servers crashed under
load with no operator action. Diagnosis surfaced two compounding causes:

### 1. Rename-orphan cron blocks

`lib/cron.sh::cron_install` keys its strip-then-append on the *current*
`team.json:.name` only. When a team is renamed (registry + team.json +
session.txt updated atomically by the operator, but no atmux verb to do
the rename), the old marker block lingers under the prior name with
cron lines pointing at the SAME `ATMUX_DIR`. Two blocks now fire the
same `atmux whip` against one cage every */5 tick.

Observed crontab on hax pre-fix:

```
# >>> atmux:team=ifca_sopx — managed by atmux start; ...
*/5 * * * * TMUX_TMPDIR=/root/work/ifca/src/sopx-root/.atmux/tmux ATMUX_DIR=/root/work/ifca/src/sopx-root/.atmux atmux whip ...
# <<< atmux:team=ifca_sopx
# >>> atmux:team=sopx — managed by atmux start; ...
*/5 * * * * TMUX_TMPDIR=/root/work/ifca/src/sopx-root/.atmux/tmux ATMUX_DIR=/root/work/ifca/src/sopx-root/.atmux atmux whip ...
# <<< atmux:team=sopx
```

Both blocks fire concurrently. They race on `whip.lock`; the loser
logs "another instance running" and exits. Net: 2× cron load per tick
against one cage with no actual benefit.

### 2. Pre-marker orphan lines

Pre-marker eras of `atmux start` wrote bare `*/5 ... atmux whip` lines
outside any `>>> ... <<<` block. Today's marker-aware
`_atmux_cron_strip_block` can't see them. They accumulate silently
across every operator's history of starts on a long-lived box.

### 3. Bare cron env

Cron runs commands without the operator's interactive env — no `TERM`,
narrow `PATH` (typically `/usr/bin:/bin`). When `atmux whip` invokes
tmux operations on the cage socket, a missing `TERM=xterm-256color`
intermittently triggers tmux 3.5a segfaults (crash 139). Compounded by
(1) + (2)'s concurrency, the segfault probability per minute climbs
until the cage tmux server itself dies — leaving the cockpit viewer
windows looping `attach -t … no sessions` forever. The operator
discovers it only on the next manual check; in the meantime, the
team's autonomous work has stopped.

This violates atmux's reason for existing: a coordination harness that
silently stalls is worse than no harness at all, because the operator
trusts panes that aren't actually working.

## Decision

`cron_install` gains three new helpers in its strip pipeline:

### D1 — `_atmux_cron_strip_by_atmux_dir <atmux_dir>`

Streams stdin through awk, detecting any marker block whose body
references `ATMUX_DIR=<atmux_dir>` (followed by space or tab) and
dropping the entire block — header + body + footer — regardless of
the team name in the marker. Catches rename-orphans (1).

### D2 — `_atmux_cron_strip_orphan_lines`

Streams stdin through awk, dropping any `atmux <verb>` line
(`whip|report|decisions|groom|discorder|unblocker`) that is NOT inside
a marker block. Catches pre-marker orphans (2).

### D3 — `_atmux_cron_ensure_env_preamble`

Prepends `SHELL=/bin/bash`, `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
`TERM=xterm-256color` to the crontab if at least one `atmux:team=` block
exists in the new output AND the preamble is not already present.
Idempotent. Operators who don't use atmux cron see no change. Addresses
(3).

### D4 — `cron_install`'s strip pipeline

Three passes (order matters):

1. `_atmux_cron_strip_block <team>` — idempotent re-install of the current team's block
2. `_atmux_cron_strip_by_atmux_dir <atmux_dir>` — catches rename-orphans
3. `_atmux_cron_strip_orphan_lines` — catches pre-marker residue

Then the new block is composed and the env preamble is injected before
the atomic crontab swap.

## Consequences

**Pro**

- Team renames (registry + team.json + session.txt) no longer create
  permanent orphan cron blocks. Next `atmux start` from the renamed
  team's root self-heals the crontab.
- Pre-marker orphan lines accumulated across years of starts get
  swept on the next install.
- Bare cron env tmux segfaults are mitigated by the env preamble —
  the failure mode that crashed sopx + unum on 2026-05-06 should not
  recur under the same conditions.
- Single source of truth: external scripts (e.g. operator
  cockpit-rebuild) can drop their own crontab-scrub logic and
  delegate to atmux. See dotfiles `cockpit-rebuild.sh` 7199019 for
  the corresponding cleanup.

**Con**

- The dedup is path-based, not registry-based. If two teams legitimately
  share an `ATMUX_DIR` (currently impossible per ADR-018 cage
  isolation, but theoretically allowed), the second install would
  strip the first. Acceptable: same-path teams would already collide
  on cage socket / state files / inboxes.
- The orphan-line strip is verb-name-keyed. New atmux verbs added
  later won't be caught by the existing regex — keep
  `whip|report|decisions|groom|discorder|unblocker` updated.
- Env preamble is injected globally (top of crontab, not per-block).
  Operators who want different `PATH` per team would have to set it
  inline in each cron line. Acceptable: per-block env is a niche need
  outside atmux's coordination concern.

**Failure modes**

- If `crontab -l` returns garbage (corrupted file), the awk filters
  pass it through verbatim and the swap may produce an invalid
  crontab. Mitigation: atmux's existing `crontab <tmpfile>` swap
  validates the file; cron will reject syntax errors and `crontab`
  exits non-zero. The function already warns on swap failure.
- The env preamble triggers off `^TERM=xterm-256color$` exactly. An
  operator who sets `TERM=screen-256color` (also valid) wouldn't get
  the preamble re-injected. Acceptable: if the operator has set their
  own TERM, they've thought about it.

## Out of scope

- Registry-vs-crontab dedup (e.g., strip blocks for team names not
  present in `~/.claude/teams/registry.json`). Stronger but requires
  the registry path helper from `lib/registry.sh`, larger surface,
  separate ADR if pain materialises.
- A dedicated `atmux team rename <old> <new>` verb. Rename remains a
  multi-file manual op; this ADR makes the cron side self-heal but
  doesn't address the registry/team.json/state-file coordination
  cost. Worth a follow-up if rename frequency increases.
- Generic tmux 3.5a segfault avoidance (cgroup pressure, ncurses
  bugs). Out of atmux's scope; the env preamble fixes the most common
  cause but not all.

## References

- atmux commit `3b61b00` — implementation
- dotfiles commit `7199019` — operator-side cleanup delegating to D4
- Memory: `feedback_atmux_cron_pollution_kills_cages.md` (operator's
  failure-mode log, 2026-05-06)
