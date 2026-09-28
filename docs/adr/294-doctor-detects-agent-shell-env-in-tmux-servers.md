# ADR-294: `atmux doctor` detects tmux servers whose global environment came from an agent shell

**Status**: proposed
**Date**: 2026-09-25
**Driver-ref**: kanban `t-4ad1dac6` (atmux doctor agent-env check).
**Numbering**: 294, not the 286 that `INDEX.md` names as next. Unmerged branches already carry ADR files numbered 286–293 (`286-eternal-improvement-retirement`, `288-*`, `289-*`, `290-*`, `291-*`, `292-*`, `293-*`, several twice), so 294 is the first number no known branch uses. Re-check on merge.
**Relates**: [ADR-277](277-cage-color-environment-scrub.md) (the mechanism: a tmux server freezes its starter's environment into every pane; its §Out of scope deferred the wider agent-variable class), [ADR-281](281-tmux-child-environment-scrub-at-the-spawn-seam.md) (the spawn-seam scrub, and its admission that servers atmux did not start are out of its reach), [ADR-282](282-never-collect-the-whole-environment-in-a-test.md) (names only, never values), [ADR-162](162-atmux-owns-tmux-infrastructure.md) (doctor's warn-class tmux probes), [ADR-005](005-doctor-preflight.md) (`atmux doctor`).

## Context

On 2026-09-25, three live atmux tmux servers on geoywsMBP (`reins`, `wedding`, `dotprobe`) were found with an agent shell's environment in their global environment (`tmux show-environment -g`). They had been started from inside an omp ("Oh My Pi") bash-tool shell, which exports `CI=true`, `AGENT=1`, `NO_COLOR=1`, `TERM=dumb`, `EDITOR`/`VISUAL`/`GIT_EDITOR=true`, `PAGER=cat`, `SSH_ASKPASS=/usr/bin/false` and more (omp `src/exec/non-interactive-env.ts`). Every pane on those servers inherited the set. Claude Code rendered with no colour, and `git commit` in those panes silently took the default message. The servers were in that state from 2026-09-24 20:53 until a human noticed.

The prevention layers (ADR-277's conf scrub, ADR-281's spawn-seam scrub, and the config-layer scrub now applied at server start) all act at server START. None of them can see a server that is already polluted, and ADR-281 says plainly that servers atmux did not start are out of its reach. Nothing reported the state.

## Decision

### D1 — A read-only doctor probe, `tmux-agent-env`

`src/verbs/doctor/agent-env.ts::checkAgentShellEnv`, wired into `runAllChecks`. For every tmux server atmux knows about, it emits one **yellow** row when the server's global environment carries a marker. Yellow, not red: a polluted server elsewhere on the host must not fail another team's preflight.

### D2 — One exported marker set

`AGENT_SHELL_ENV_MARKERS` is the single, documented list:

| Variable | Counts when |
|---|---|
| `AGENT`, `CI`, `NO_COLOR` | set to any value |
| `EDITOR`, `VISUAL`, `GIT_EDITOR` | `true` |
| `PAGER`, `GIT_PAGER` | `cat` |
| `GIT_TERMINAL_PROMPT` | `0` |
| `SSH_ASKPASS` | `/usr/bin/false`, `/bin/false` or `false` |

A human may set `EDITOR` or `PAGER` on purpose, so only the value the harness uses counts. `NO_COLOR` must be SET: tmux lists `-NO_COLOR` for a removal mark, which is what `atmux.conf`'s `set-environment -gr NO_COLOR` leaves, and that is the healthy state.

Three things are left out on purpose:

- **`TERM=dumb`.** It is inert. tmux sets `TERM` from `default-terminal` in every pane and every `run-shell` job, so the global value never reaches them. This was measured on tmux 3.7c on 2026-09-25, with a scratch server started under `TERM=dumb`. The dotfiles tmux conf also leaves `TERM` unscrubbed by design. So every server born from an agent shell would keep it and raise a permanent yellow that means nothing; `reins` and `wedding` did exactly that after their repair. `AGENT` is the harness fingerprint instead. (Operator decision, 2026-09-25.)
- **`CLAUDECODE`.** atmux sets it itself on every claude launch (`src/core/tui-cmd.ts`).
- **`LESS=FRX`, `PYTHONUNBUFFERED=1`, `DEBIAN_FRONTEND=noninteractive` and the package-manager knobs.** They are common in human shells and harmless in a pane.

### D3 — Which servers: atmux's own discovery, no globbing

`discoverAtmuxServerSockets` builds the list from paths only:

- the cockpit socket file: `getCockpitSocketPath()`, which is `$TMUX_TMPDIR/tmux-<uid>/<ATMUX_COCKPIT_SOCKET or atmux-cockpit>` (new in `src/core/tmux-paths.ts`, because `-L` gives no path to test);
- one socket per group in `cockpit.json` (`groupSocketPath`);
- for each team in `cockpit.json`, every path a cage may use: `resolveTeamSocket` when team.json loads, plus the legacy `/tmp/atmux-<team>/sock` and the per-team `.atmux/tmux` path that `resolveCageSocket` also walks;
- the current team (`resolveTeamSocket`).

Disabled teams and groups are included, because disabled is a cockpit flag and not proof that no server is running. A server atmux does not know about is out of scope. `dotprobe` above is an example: it lives on a bare `/tmp/tmux-<uid>/dotprobe` socket.

### D4 — Probe safely; report names only

- The socket FILE is checked first (`[ -S ]` semantics). A missing path is skipped without running tmux.
- Only `has-session` and `show-environment -g` run. Neither starts a server. A stale socket file, or a server with no session, is skipped.
- The row carries the socket and the variable NAMES. Values are compared inside the parser and dropped, and values are never kept for any name outside the marker set.
- The hint is the repair, one command per variable: `tmux -S <sock> set-environment -g -u <VAR>`. It adds that panes already running keep the old environment until their processes restart. New panes are clean at once.
- The doctor stays read-only. It never applies the repair.

## Consequences

- A polluted server now shows up on the next `atmux doctor` or medic sweep, instead of when a human notices.
- The test estate is pointed at scratch sockets through seams that already exist (`ATMUX_COCKPIT_CONFIG`, `ATMUX_COCKPIT_SOCKET`, `TMUX_TMPDIR`, `HOME`, `--team-dir`, `ATMUX_TMUX_BIN`). No doctor-only override was added.
- Regression coverage: `tests/unit/verbs/doctor-agent-env.test.ts` (parser, discovery and probe branches), and `tests/e2e/doctor-agent-env.test.ts`, which runs real tmux servers on scratch sockets through the real `bin/atmux doctor --json`. The e2e covers a polluted server, a clean one, missing and stale sockets (it checks that no server is created on them), and running the hint's commands as written.
- A server started outside atmux's topology is still invisible to this probe (D3).

## Out of scope

- Repairing servers automatically. The doctor is detection only; `--fix` is unchanged.
- Session-level environments (`show-environment -t <session>`). This probe reads only the global environment, which is what every new pane is built from.
