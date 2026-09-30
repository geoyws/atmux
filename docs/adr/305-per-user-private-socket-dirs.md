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

| Socket | Path | Private directories (owned by the uid, no group/other bit) |
|---|---|---|
| Team cage (no `tmuxTmpdir`) | `/tmp/atmux-<uid>/<team>/sock` | `/tmp/atmux-<uid>`, `/tmp/atmux-<uid>/<team>` |
| Group server | `/tmp/atmux-<uid>/grp-<group>/sock` | `/tmp/atmux-<uid>`, `/tmp/atmux-<uid>/grp-<group>` |
| Team with `tmuxTmpdir` | `<tmuxTmpdir>/tmux-<uid>/default` (unchanged) | `<tmuxTmpdir>/tmux-<uid>`, and `<tmuxTmpdir>` itself when it is an `atmux-*` entry of `/tmp` |
| Cockpit | tmux's own `-L atmux-cockpit` → `$TMUX_TMPDIR/tmux-<uid>/atmux-cockpit` (unchanged) | `$TMUX_TMPDIR/tmux-<uid>` |

The base is the literal `/tmp`, not `$XDG_RUNTIME_DIR` or `os.tmpdir()`: cron, launchd and interactive shells must all resolve the same path, and neither alternative is set in all of them (macOS has no `XDG_RUNTIME_DIR`; cron sets none). The per-user root is ONE `/tmp` entry named `atmux-<uid>`, not `/tmp/atmux-<uid>-<team>`: a name with a second hyphen matches groom's zombie-fixture sweep pattern `^atmux-(cockpit-)?(?!grp-)[^/]+-[^/]+$`, which kills the tmux servers it finds under an old directory.

`atmux init` no longer stamps `tmuxTmpdir: "/tmp/atmux-tmux_<team>"` (the ADR-018 bash-era default). That name was one shared `/tmp` entry any local user could create first. With the field unset a new team runs its own server on the per-user cage socket above — the same ADR-018 blast-radius isolation, owned by the uid that runs it, and `team.json` stays portable across uids. An operator who sets `tmuxTmpdir` points it at a directory they (or root) own that no other user can write.

Resolvers: `core/socket-dir.ts` (`resolveCageSocketPath`, `resolveGroupSocketPath`); `core/common.ts::getDefaultSocket` / `resolveTeamSocket` and `core/cockpit.ts::cageSocketPath` / `groupSocketPath` delegate to them.

### D2 — The whole chain, from `/` down

`tmux -S <path>` checks nothing, so atmux checks the WHOLE path it hands tmux, not only the socket's directory. The walk (`core/socket-dir.ts`) starts at `/` and opens one component at a time with `open(O_RDONLY|O_DIRECTORY|O_NOFOLLOW)` resolved inside the directory already checked — on Linux through `/proc/self/fd/<parent>/<name>` (openat semantics) — then `fstat`s the descriptor it just opened. It holds every descriptor until the walk ends. Rules:

1. **Every directory on the way** is a real directory owned by root or by this uid and not writable by group or other — EXCEPT a root-owned sticky directory (`/tmp`, 1777), which may be traversed.
2. **Private directories** — the socket's own directory, and any `atmux-*` entry of a shared sticky directory (`/tmp/atmux-<uid>`, `/tmp/atmux-tmux_*`, pre-ADR-305 `/tmp/atmux-<team>`) — are owned by this uid with no group or other bit at all (read, write or search).
3. **Symlinks.** A symlink is followed only when it sits in a directory no other uid can write (rule 1 without the sticky exception) and is owned by root or this uid — macOS `/tmp → private/tmp` is the case that needs this. A symlink at a private position, inside a shared sticky directory, or owned by another uid is refused. `.`/`..` in the socket path itself are refused.
4. **The socket node** is refused when it is a symlink or owned by another uid.
5. **Missing directories.** `ensurePrivateSocketDir` (create) creates every missing directory with `mkdir(0700)` under umask 077, through the parent descriptor, then opens and checks it like any other. The connect-time check creates only a missing entry of a shared sticky directory (`/tmp/atmux-<uid>` above all), so no other uid can plant it between the check and the dial; a missing directory below one only this uid (or root) can write is safe (nothing can appear there; tmux reports "no server").
6. **Nothing is ever chmod'ed**, and no code path sets 0666 or 0777. An existing directory that breaks a rule is refused with the exact fix.

Why this is enough: under rules 1–3 no other uid can rename, replace or re-point any component of the checked path — a sticky directory lets only an entry's owner (or root) rename it, and every other directory on the way is writable only by root or this uid — so the path atmux then hands tmux still means what the walk checked. Without `/proc` (macOS), names resolve against the walk's own resolved path, which holds no symlink and, by the same rules, nothing another uid can change.

Enforcement points: `ensurePrivateSocketDir` at every creation site (`atmux start`, `cockpit reconcile` cage pre-create and group servers); the connect-time guard in `createTmux`, before EVERY tmux spawn of a namespace (`-S` path, and the `-L` name's `$TMUX_TMPDIR/tmux-<uid>/<name>`); `atmux socket-dial` (D6) for shell loops; `bin/atmux-tmux`, which applies the same rules in POSIX shell: it walks the tmpdir from `/` one component at a time, checks each with `ls -ldn` BEFORE following anything, follows a symlink only under rule 3 (never one inside a shared sticky directory such as `/tmp`, never one another uid owns; at most 32 hops), creates missing directories with `umask 077; mkdir`, and hands tmux the checked physical path. A refusal is `UnsafeSocketPathError`, a `ConfigError` (exit 78).

**Every dial runs the guard itself, immediately before it spawns.** An inspect-only check (`socketPathIssue`, which treats a missing directory as safe) never gates a dial, and no check result is reused for a later dial: another uid that squatted `/tmp/atmux-<uid>` can rename it away for the check and back for the dial. The dial sites outside `createTmux` are guarded the same way: doctor's tmux spawn (`verbs/doctor/types.ts::defaultTmuxSpawn`, for `tmux-agent-env`, `legacy-window-name-format` and `cockpit-on-default-socket`) runs `guardTmuxArgv` on every `-S`/`-L` argv; `atmux test-reaper` guards its `kill-server`; the fallback-cage operator paths (`poke.ts::sendCageBrief`, `fallback-cage.ts` capture) guard their `-L` dials. Copy-paste hints in doctor rows, orphan reports and refusals name `atmux socket-dial <socket> …`, never a raw `tmux -S`.

**Removing or renaming a socket or a socket directory** (revision 4) never acts on a path. The walk keeps its descriptors and the operation runs relative to the held parent directory (`unlinkat`/`renameat` semantics through `/proc/self/fd/<dir>/<name>` on Linux):

- a **socket** is removed only by `removeDeadSocket`: the chain passes, the socket's own directory is ours alone (the `privateDirIssue` rule, checked by the same walk that keeps its descriptor), the node is our socket, and a `connect()` through that descriptor is refused (ECONNREFUSED — a timeout or any other error is "unknown", never dead). Used by `start`'s stale legacy-socket cleanup (e-29) and the D3 migration.
- a **directory tree** is removed only by `removePrivateTree`: the directory is ours alone (owned by this uid, no group/other bit, a passing chain). Used by `atmux test-reaper`, the groom zombie sweep and `atmux socket-rmdir` (D6).
- a **directory move** (`team repair-rename`'s tmpdir `mv`) goes through `renameOwnedDir`: both parent chains pass, the source is a real directory of ours, nothing exists at the target.

A path the guard refuses is **unsafe, never "dead"**: a liveness probe that throws `UnsafeSocketPathError` leaves the socket in place, and so does any other probe failure. `atmux test-reaper` additionally skips (`unsafe-skipped`) a fixture whose `sock` is a symlink or another uid's; the groom sweep reports a directory that is not ours alone and leaves it.

### D3 — Pre-ADR-305 sockets

A live cage or group server still on `/tmp/atmux-<team>/sock` (or `/tmp/atmux-grp-<group>/sock`) keeps working only while that socket is ours AND its whole chain passes D2 (for example the @@hax directories chmod'ed 0700 on 2026-09-30, under the now-sticky `/tmp`). Resolution order: a per-user socket of ours behind a passing chain (the descriptor walk, never a path `lstat`) → it; else a legacy socket of ours with a passing chain → it; else the per-user path. A legacy socket in a failing chain is never used, and another uid's legacy socket never becomes this uid's default.

At create time (`start`, group-server reconcile): a dead legacy socket with a passing chain is removed (`removeDeadSocket`, D2) and the server moves to the per-user path; a LIVE legacy socket of ours in a failing chain is refused (a second server on the per-user path would duplicate the cage), with the fix for the component that fails (`chmod 700 <dir>` for the usual case) to adopt it until its next restart.

### D4 — Doctor

`atmux doctor` gains `socket-dir` (red: the team's or cockpit's socket path breaks D2; green otherwise) and `socket-dir-legacy` (yellow: a legacy socket of ours in a failing chain). Cage-probing checks that the guard refuses return no rows instead of aborting the run.

### D5 — Capability marker

`SOCKET_DIR_FEATURE = "socket-dirs=per-user-0700;rev=4"` (`core/socket-dir.ts`), printed as its own line by `atmux version --features` and carried in the green `socket-dir` row. A bootstrap refuses an older build with:

```sh
atmux version --features | grep -qx 'socket-dirs=per-user-0700;rev=4'
```

An older build prints only the version line; the unreleased cuts that failed review printed the bare `socket-dirs=per-user-0700` (35ea2c3, a9f96ac2) or `;rev=3` (ccd9f275), so the grep fails closed on all of them. `socket-dirs=per-user-0700` names the scheme and is never reworded (a successor scheme gets a new name); `;rev=N` (`SOCKET_DIR_REVISION`) is bumped by every security fix a consumer must be able to require.

### D6 — `atmux socket-dial` for shell loops

`atmux socket-dial <socket> <tmux-args…>` runs `tmux -S <socket> <tmux-args…>` with inherited stdio only after the D2 connect-time walk passes; it exits 1 when there is no socket of ours to dial and 78 when the path is unsafe, in both cases without running tmux. The cockpit's viewer retry-loops (team windows and group windows) and the bau skill dial through it, invoking the atmux build that wrote the loop (`ATMUX_BIN`, else this checkout's `bin/atmux`, else the compiled binary). A shell `[ -S s ] && [ -O s ] && tmux -S s` test is not a substitute: it follows symlinks and checks only the socket node, so a uid that can rename a directory on the way swaps the path between the test and the dial (the review of the first cut measured 80 of 300 such dials reaching the other uid's server; the e2e below reproduces it). `socket-dial` is exempt from the per-verb events log (a viewer dials about once a second).

Its sibling `atmux socket-rmdir <dir>` (revision 4) is how a shell or an agent prompt removes a dead fixture's socket directory: `removePrivateTree` (D2), exit 0 removed, 1 absent, 78 not ours alone (nothing removed). The sweep and whip prompts use it instead of `[ -O "$DIR" ] && rm -rf "$DIR"`, which checks one path and then acts on another.

## Consequences

- Root and every other uid get disjoint socket trees; a second uid cannot connect to (or even see) another uid's cage, group or cockpit socket. Proven by `tests/e2e/socket-dir-two-uid.test.ts` with real uids in a Linux container: library calls (beats 1–5) and the real CLI — `atmux start` and `cockpit reconcile` as two uids, `socket-dial`, `bin/atmux-tmux` — including a pre-planted `tmuxTmpdir` parent, a racing symlink swap (the old guard is reached, `socket-dial` never is), a missing `/tmp/atmux-<uid>`, a squatted cockpit directory, and a squatted per-user root with a symlink to the victim's own live socket (beat 14: never unlinked).
- Operator-visible break: a socket path with a group- or world-writable (non-sticky) directory anywhere on the way, a foreign-owned directory on the way, or a private directory with any group/other bit, is refused until fixed; `atmux doctor` lists them. Measured on @@hax on 2026-09-30: `/tmp` is now root 1777 (it was 0777 without the sticky bit when this ADR was opened — under that mode every atmux socket on the host would be refused); `/root/work/geoyws/src/root/.atmux/tmux/tmux-0` is 0755 (refused, `chmod 700` fixes it); the empty `/tmp/atmux-tmux_{geoyws,hrx,hx}` directories are root 0777 and would be refused if a team pointed at them (no team.json on the host does); `/tmp/atmux-journal` and `/tmp/atmux-px` are root 0700 and adopted.
- `/tmp/atmux-<uid>` can be squatted by another local user (atmux then refuses, clearly, rather than using it). That is a denial of service, never a hijack.
- macOS: the chain is walked through the trusted `/tmp → private/tmp` link without `/proc`; `bin/atmux-tmux` hands tmux the physical `/private/tmp/…` path. Untested on macOS — verify.
- Out of scope: the `-L` fallback cages (`/tmp/atmux_fallback_*`, tmux enforces its own directory), retired epic-cage probe paths in `topo`, and the ~22k leftover `/tmp/atmux-*` directories on @@hax (infra t-67d80702).

## Revision 4 — 2026-09-30, review of revision 3 (ccd9f275)

Revision 3 still removed by path. `start`'s stale legacy-socket cleanup read a guard refusal (`UnsafeSocketPathError` from `hasServer`) as "no server", then `rmSync`'d the path; and resolution's "per-user socket present" test was a path `lstat`, which follows symlinks in the middle of the path. The reviewer reproduced it with real uids and the real CLI: uid 4302 created `/tmp/atmux-0` (0755) with `kanban -> /tmp/atmux-journal`, and root's `atmux start` of a `tmuxTmpdir` team logged `removed stale legacy socket /tmp/atmux-0/kanban/sock` — unlinking root's own live `/tmp/atmux-journal/sock` and orphaning that server. Revision 4: a guard refusal is unsafe, never dead; every removal and rename of a socket or socket directory runs through a held descriptor under the D2 rule ("Removing or renaming" above); resolution and the legacy classification use the descriptor walk, never a path `lstat`; `bin/atmux-tmux` no longer `cd -P`s before checking (it followed another uid's symlink in `/tmp`); `atmux socket-rmdir` replaces the prompts' `rm -rf`; and the D5 marker becomes `;rev=4`. Regressions: e2e beats 14 (the reviewer's repro) and 15 (the wrapper), and `tests/unit/core/tmux-paths-stale-socket.test.ts` "rev 4" cases — all fail on ccd9f275 and pass here.

## Revision 3 — 2026-09-30, review of revision 2 (a9f96ac2)

Revision 2 still let doctor check a socket with the inspect-only walk and then dial it raw, so a squatter renaming `/tmp/atmux-<uid>` away and back reached doctor's tmux client; `atmux test-reaper` dialled `kill-server` without the guard and removed any matching directory, so a planted `sock` link let another uid aim root's reaper at root's own cage; and the sweep/whip prompts still told agents to run raw `tmux -S` on shared `/tmp` paths. Revision 3 guards every dial at the dial (D2 above), gates test-reaper's kill and removal, points every prompt and hint at `atmux socket-dial`, and adds `;rev=3` to the D5 marker. Regressions: `tests/unit/verbs/adr305-dial-regressions.test.ts` (fails on a9f96ac2, passes here) and e2e beats 12–13.

## Revision — 2026-09-30, review of the first cut (35ea2c3)

The first cut checked only the socket's own directory (plus `/tmp/atmux-<uid>`), treated a missing directory as safe, chmod'ed what it created by path, left `atmux init` stamping the shared `/tmp/atmux-tmux_<team>`, and let the cockpit viewer loops dial after a shell `[ -S ] && [ -O ]` test. An independent review showed a pre-planted 0777 `tmuxTmpdir` parent let another uid rename root's `tmux-0` and reach 46 of 300 guarded probes, and a symlink swap redirected 80 of 300 viewer dials. D1 (init), D2 (whole chain, descriptor walk, create-before-dial, no chmod), D3 and D6 are the fix.
