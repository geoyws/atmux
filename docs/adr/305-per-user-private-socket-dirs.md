# ADR-305 — Per-user private tmux socket directories

Status: proposed
Date: 2026-09-30 (kb atmux t-049753ab; host containment in kb infra t-67d80702)
Amends: [ADR-018](018-per-team-tmux-socket-isolation.md) (per-team sockets now also per-user), e-419553c6 group servers (`/tmp/atmux-grp-<group>/sock`), [ADR-063](063-cockpit-verb-port.md) follow-up dual-socket resolution
Relates: [ADR-162](162-atmux-owns-tmux-infrastructure.md) (cockpit on tmux's own `-L atmux-cockpit`), [ADR-294](294-doctor-detects-agent-shell-env-in-tmux-servers.md) (doctor probes live servers)

## Context

Measured on @@hax on 2026-09-30: the cage socket directories `/tmp/atmux-journal/` and `/tmp/atmux-px/` were mode 0777 with 0777 sockets, and the `nobody` user ran `tmux -S /tmp/atmux-<team>/sock has-session` against root's live cages with exit 0. Any local user could drive a root shell. 22,385 `/tmp/atmux-*` directories existed; the ones checked were 0777. `/tmp` itself was 0777 without the sticky bit, so any user could also rename a root-owned entry away and plant their own.

atmux passes `-S <path>` for cages and group servers. With `-S`, tmux does none of the checks it does for `-L` (it creates `$TMUX_TMPDIR/tmux-<uid>` 0700 and refuses it when another uid owns it or it has world bits). atmux created the parent with a plain `mkdir -p`, so the mode was whatever the umask and the host allowed. A second local user (the `coder` agent user, kb infra t-3dc6f935 / t-d47794c6) running its own atmux would also have shared `/tmp/atmux-<team>/` with root.

## Decision

### D1 — Path scheme

| Socket | Path | Private directories |
|---|---|---|
| Team cage (no `tmuxTmpdir`) | `/tmp/atmux-<uid>/<team>/sock` | `/tmp/atmux-<uid>`, `/tmp/atmux-<uid>/<team>` |
| Group server | `/tmp/atmux-<uid>/grp-<group>/sock` | `/tmp/atmux-<uid>`, `/tmp/atmux-<uid>/grp-<group>` |
| Team with `tmuxTmpdir` | `<tmuxTmpdir>/tmux-<uid>/default` (unchanged) | `<tmuxTmpdir>/tmux-<uid>` |
| Cockpit | tmux's own `-L atmux-cockpit` → `$TMUX_TMPDIR/tmux-<uid>/atmux-cockpit` (unchanged) | `$TMUX_TMPDIR/tmux-<uid>` |

The base is the literal `/tmp`, not `$XDG_RUNTIME_DIR` or `os.tmpdir()`: cron, launchd and interactive shells must all resolve the same path, and neither alternative is set in all of them (macOS has no `XDG_RUNTIME_DIR`; cron sets none). The per-user root is ONE `/tmp` entry named `atmux-<uid>`, not `/tmp/atmux-<uid>-<team>`: a name with a second hyphen matches groom's zombie-fixture sweep pattern `^atmux-(cockpit-)?(?!grp-)[^/]+-[^/]+$`, which kills the tmux servers it finds under an old directory.

Resolvers: `core/socket-dir.ts` (`resolveCageSocketPath`, `resolveGroupSocketPath`); `core/common.ts::getDefaultSocket` / `resolveTeamSocket` and `core/cockpit.ts::cageSocketPath` / `groupSocketPath` delegate to them.

### D2 — Creation and refusal rules

1. A directory atmux creates is created 0700 and chmod'ed 0700 right after, so no umask leaves it wider (or too narrow to use).
2. An existing directory is never chmod'ed. It is refused, with the exact fix, when it is a symlink, not a directory, owned by another uid, or has any group or world bit (read, write or search).
3. A socket node owned by another uid (or a symlink) is refused.
4. Nothing atmux does ever widens a mode; no code path sets 0666 or 0777.

Enforcement points: `ensurePrivateSocketDir` at every creation site (`atmux start`, `cockpit reconcile` cage pre-create and group servers), and a connect-time guard in `createTmux` that runs before EVERY tmux spawn of a namespace (`-S` path, and the `-L` name's `tmux-<uid>` directory). A refusal is `UnsafeSocketPathError`, a `ConfigError` (exit 78). Raw `tmux -S` probes in doctor (`tmux-agent-env`, legacy window names) skip an unsafe socket instead of dialling it. The cockpit's viewer retry-loops dial a socket only when `[ -S s ] && [ -O s ]`. `bin/atmux-tmux` applies the same rules in shell.

### D3 — Pre-ADR-305 sockets

A live cage or group server still on `/tmp/atmux-<team>/sock` (or `/tmp/atmux-grp-<group>/sock`) keeps working only while that socket is ours AND its directory passes D2 (for example the @@hax directories chmod'ed 0700 on 2026-09-30). Resolution order: per-user socket present → it; else a legacy socket that is ours in a private directory → it; else the per-user path. A legacy socket in a shared directory is never used, and another uid's legacy socket never becomes this uid's default.

At create time (`start`, group-server reconcile): a dead private legacy socket is removed and the server moves to the per-user path; a LIVE legacy socket of ours in a shared directory is refused (a second server on the per-user path would duplicate the cage), with the hint `chmod 700 <dir>` to adopt it until its next restart.

### D4 — Doctor

`atmux doctor` gains `socket-dir` (red: the team's or cockpit's socket directory breaks D2; green otherwise) and `socket-dir-legacy` (yellow: a legacy socket of ours in a shared directory). Cage-probing checks that the guard refuses return no rows instead of aborting the run.

### D5 — Capability marker

`SOCKET_DIR_FEATURE = "socket-dirs=per-user-0700"` (`core/socket-dir.ts`), printed as its own line by `atmux version --features` and carried in the green `socket-dir` row. A bootstrap refuses an older build with:

```sh
atmux version --features | grep -qx 'socket-dirs=per-user-0700'
```

An older build prints only the version line, so the grep fails closed. The token is never reworded; a successor scheme gets a new marker.

## Consequences

- Root and every other uid get disjoint socket trees; a second uid cannot connect to (or even see) another uid's cage or group socket. Proven by `tests/e2e/socket-dir-two-uid.test.ts` with real uids in a Linux container, including a negative control showing the pre-ADR shape was reachable.
- Operator-visible break: an existing socket directory with group/world bits is refused until fixed. On hosts where cages were started with a 022 umask (`/tmp/atmux-<team>/` at 0755, `<root>/.atmux/tmux/tmux-<uid>/` at 0755), the cage verbs refuse that cage with the `chmod 700 <dir>` hint; `atmux doctor` lists them. Dead leftovers in shared legacy directories are ignored, not refused.
- `/tmp/atmux-<uid>` can be squatted by another local user (atmux then refuses, clearly, rather than using it). That is a denial of service, never a hijack. A world-writable `/tmp` without the sticky bit (as measured on @@hax) makes squatting easier and is a host fix owned by infra.
- Out of scope: the `-L` fallback cages (`/tmp/atmux_fallback_*`, tmux enforces its own directory), retired epic-cage probe paths in `topo`, and the ~22k leftover `/tmp/atmux-*` directories on @@hax (infra t-67d80702).
