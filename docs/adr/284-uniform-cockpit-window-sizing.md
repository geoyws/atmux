# ADR-284: One sizing policy for every cockpit window — the `unum` `window-size smallest` override is retired

**Status**: accepted — operator-direct 2026-08-30
**Date**: 2026-08-30
**Driver-ref**: operator-direct — "get rid of that per window override, all windows should be have the same, supercede it with an adr? retire it durably" + "and then fix unum's current behaviour for the servers' lifetimes".
**Supersedes**: the un-ADR'd operator decision of 2026-06-24, recorded only as a comment block in `_dotfiles/tmux/.tmux.conf` (lines 98–117 at retirement). There was no ADR to mark superseded; this one takes its place in the record.
**Relates**: [ADR-171](171-tmux-conf-local-override.md) (the path by which the operator's personal conf reaches an atmux server), [ADR-162](162-atmux-owns-tmux-infrastructure.md) (atmux owns the cockpit socket and its tmux baseline), [ADR-279](279-declarative-operator-cockpit-windows.md) (cockpit window construction). Also bears on the dotfiles-side devbox migration (dotfiles ADR-008, runbook `_dotfiles/docs/infra/devbox-migration-2026-08.md`) — that migration is why the ghost-reaper cron this override was compensating for is absent on the new host.

## Context

### The symptom

2026-08-30 03:00 MYT, `geoywsMBP`. The operator reported that the `unum` group cage did not resize to the attached terminal while the `ifca` group cage did. Cockpit server `-L atmux-cockpit`, session `atx`:

```
win 4 geoyws:  automatic-rename off
win 5 unum:    automatic-rename off  window-size smallest   <- only window with an override
win 6 ifca:    automatic-rename off
global:        window-size latest  ·  aggressive-resize on
```

Three clients were attached, all mosh sessions into the same box:

| tty | size | last activity | flags |
|---|---|---|---|
| ttys041 | 291x81 | live | `attached,focused` |
| ttys079 | 79x44 | 53 min stale | `attached` |
| ttys066 | 102x53 | 335 min stale | `attached` |

`ifca` rendered **291x80**; `unum` rendered **79x43**, clamped by the 79-column client no matter which client was active. A sweep of every live tmux socket on the box — cockpit, all `/tmp/atmux-*/sock` cages, all in-repo `.atmux/tmux/…` sockets — found **exactly one** `window-size` override at any non-global scope: cockpit `atx:5`. The group-cage servers were never at fault; `/tmp/atmux-grp-unum/sock` reported a 79x43 client and `/tmp/atmux-grp-ifca/sock` a 291x80 one, each faithfully inheriting the cockpit pane it lives in.

### Where the override came from

Not from atmux. `templates/tmux/atmux.conf` sets no `window-size` at any scope, and tmux's compiled-in default is already `latest`. It arrived down the ADR-171 override path — `atmux.conf` → `~/.config/atmux/tmux.conf.local` → `source-file ~/.tmux.conf` — which installed two cockpit-socket-gated hooks:

```tmux
set-hook -ga after-new-window    'if-shell -F "#{m:unum,#{window_name}}" "setw window-size smallest"'
set-hook -ga after-rename-window 'if-shell -F "#{m:unum,#{window_name}}" "setw window-size smallest"'
```

### The root cause the override was hiding

The block's comment gives its date, 2026-06-24, and its stated purpose: let a small second screen see the unum cage un-clipped. The header of `_dotfiles/bin/tmux-ghost-reaper.sh` — written for a different job — describes the incident **one day earlier**:

> *"A lingering narrow client is doubly harmful on the atmux cockpit: with `window-size latest`, every window the ghost last viewed stays frozen at the ghost's small geometry, so cages (e.g. unum) render cramped … (2026-06-23: a 71x38 cockpit attach idled ~21h and pinned the unum cage to 270x74.)"*

So the override was not really about a second screen. It was a workaround for **ghost clients** — mosh/et attaches that linger after their network peer is gone — and it is a workaround that makes the disease permanent: `smallest` promotes a ghost's geometry from an accident into policy. The purpose-built fix already existed on the same day, in the same dotfiles: reap the ghost.

**Both extra clients on 2026-08-30 were ghosts by that reaper's own criteria** (`width < 120` and stale `> 300s`, never the focused client): 79x44 stale 53 min, 102x53 stale 335 min. **The reaper has never been scheduled on `geoywsMBP`** — `crontab -l` is empty and `~/Library/LaunchAgents` holds no such job. It was a hax-era cron; the ADR-008 devbox migration moved the cockpit to the MBP and left the reaper behind. Ghosts have been accumulating unswept ever since, and on exactly one window — `unum` — the accumulation was configured to be authoritative.

### Measured tmux semantics (tmux 3.7c, `geoywsMBP`, 2026-08-30)

Established on a throwaway two-client rig (grouped sessions, a 200x50 pty and an 80x44 pty), then confirmed on the live server:

1. `smallest` sizes a window to the smallest client of any session containing it — **attached**, not viewing. An idle ghost in another window still clamps.
2. `latest` pins a window to the client that last **generated real input** while viewing it. A `select-window` issued by a *control* client does not move the pin: with the small client still attached, the big client selecting the window left it at 80x44; one keypress from that client refit it to 200x50.
3. Removing the override does **not** resize anything by itself, and neither does detaching the pinning client. An unviewed window keeps its stale geometry until something triggers a recalculation.
4. Therefore a stale size on an unviewed window is cosmetic: it refits on first real use. Both facts had to be measured — this ADR asserts neither from the manual.

### Why the override is wrong regardless

- **It optimises for the wrong client.** `smallest` is not "when I am on the small screen", it is "whenever a small client exists anywhere" — including a dead one. The cost lands on the common case to serve the rare one.
- **It is silent and undiscoverable.** One team out of many renders narrow; it looks like a cage bug. Diagnosis needed a fleet sweep of every tmux server on the box.
- **It survives every routine repair.** `refit-nested.sh` cleared *session*-level overrides on reload; a window-level override was outside its loop, so `prefix r` — the reflex fix for sizing drift — never touched it.
- **It singles out one team by hard-coded name.** Nothing about `unum` is structurally different from `ifca` or `geoyws`.
- **It suppresses the signal for the underlying fault.** A cramped cage is how an unreaped ghost announces itself. Pinning the window to the ghost removed the only visible symptom of a missing cron — for 68 days.

## Decision

**D1 — Uniform sizing on the cockpit socket.** Every window on the atmux cockpit server uses one policy: the server global `window-size latest` with `aggressive-resize on`. **No window-level and no session-level `window-size` override is set on any cockpit window, by anything, ever.** Per-team exceptions to window sizing are not a supported configuration.

**D2 — The hook block is deleted at its source.** The `if-shell`-gated `after-new-window` / `after-rename-window` pair in `_dotfiles/tmux/.tmux.conf`, and its `@unum_smallest_hook` guard, are removed and replaced by a tombstone pointing here. Enforcement lives in the operator's dotfiles, not in this repository — atmux carries the contract and the receipts, the same ownership split `/CLAUDE.md` §Cron discipline uses for cron-arm idempotency.

**D3 — `refit-nested.sh` clears window-level overrides too.** The reload refit already unset stale session-level `window-size`; it now unsets window-level on every window of every reachable server, addressed by `#{window_id}` (rename- and renumber-proof). This makes D1 self-healing: a hand-set override — from an experiment, a plugin, or a future hook — is gone by the next `prefix r` instead of persisting invisibly, which is the 2026-05-13 failure mode the session-level unset was written for.

**D4 — A config edit does not fix a running server, so live remediation is part of the change.** Executed on the live cockpit 2026-08-30 03:0x–03:5x MYT, in this order:

```bash
# 1. conf edits land FIRST, so a `prefix r` in between cannot reinstall the hooks
tmux -L atmux-cockpit setw -t atx:unum -u window-size   # drop the override
tmux -L atmux-cockpit set-hook -gu after-new-window     # verified: only slot [0] existed, and it was ours
tmux -L atmux-cockpit set-hook -gu after-rename-window  # `-u` unsets the whole array — check before using it
tmux -L atmux-cockpit set -gu @unum_smallest_hook       # the now-dead once-per-server guard
# 2. reap the ghosts that were doing the clamping (reaper criteria, by hand — no Discord ping)
tmux -L atmux-cockpit detach-client -t /dev/ttys079     # 79x44,  stale 53m
tmux -L atmux-cockpit detach-client -t /dev/ttys066     # 102x53, stale 335m
# 3. force the refit without touching the operator's client (see below)
```

Per §Measured semantics #3, steps 1–2 leave the window at its stale size. Flipping the operator's own client to window 5 and back would refit it, but his keystrokes during the flip would land in the unum cage's pane, so the refit was driven through a **temporary grouped session** instead — `new-session -d -s _fit284 -t atx` shares `atx`'s window list with an independent current-window, so a throwaway 291x81 client can view window 5 while the operator stays on window 6. One keypress on that client repinned `w->latest`; the session and client were then destroyed. Final state: `atx` back to 6 windows, one client, all six windows 291x80, zero overrides, both hook arrays empty, and all three group cages reporting a 291x80 inner client.

**D5 — The small-screen case is answered at the client, not in window config.** A small client that clips a cage is detached (`detach-client -t <tty>`) or lived with for the duration of that attach. If that proves insufficient, the replacement is a deliberate, discoverable, all-windows mechanism — not a per-name hook.

**D6 — The ghost reaper is the real defence, and it is missing on `geoywsMBP`.** D1 is only comfortable to live with while ghosts are swept. `_dotfiles/bin/tmux-ghost-reaper.sh` exists, is executable, and is documented as a 15-minute cron covering the default *and* cockpit servers — but nothing schedules it on this host. Arming it is a standing behaviour change on the operator's machine (it detaches clients and posts to Discord), so it is **raised for the operator rather than armed here**, per ADR-192 cron discipline. Two known portability defects to fix in the same pass: the script appends to `/var/log/tmux-ghost-reaper.log`, which is root-owned on macOS and will abort the script under `set -e` *after* it has already detached clients; and its local-console exemptions (`/dev/pts/0`, `/dev/tty1`) are Linux tty names that never match on Darwin.

## Consequences

- `unum` behaves exactly like every other cockpit window: it follows the most recently active client.
- A small or dead client no longer clamps any window. It will clip what it displays while it is the active client on that window — ordinary tmux behaviour, visible when it happens.
- The 2026-06-24 small-second-screen convenience is gone. Accepted cost: it was serving a rare case at the expense of the common one, and it was masking a missing cron.
- A cramped cage is once again a *symptom* of an unreaped ghost, which is what it should be.
- `refit-nested.sh` does one extra `show`/`unset` pair per window per reachable server. It stays flock-guarded with a 3-second cooldown; the added RPCs are small against the 1–2s the body already takes.
- Until D6 is armed, ghosts must be reaped by hand when a cage looks cramped. The check is one command: `tmux -L atmux-cockpit list-clients -F '#{client_tty} #{client_width}x#{client_height} #{t:client_activity} #{client_flags}'`.

## Rollback

Reinstate the block in `_dotfiles/tmux/.tmux.conf`, drop the window-level unset from `refit_one` in `_dotfiles/tmux/refit-nested.sh`, and re-run `setw -t atx:unum window-size smallest` on the live server. Do not roll back by editing `templates/tmux/atmux.conf` — atmux does not own this option and must not start owning it as a rollback artefact.

## Out of scope, and deliberately so

- **Pinning `window-size latest` in `templates/tmux/atmux.conf`.** It restates tmux's own default and would not have prevented this: a window-level option beats a global one, so the hook would have won regardless. Writing it would advertise an enforcement atmux does not perform — the failure mode [ADR-282](282-never-collect-the-whole-environment-in-a-test.md) §Retraction was written about.
- **A regression test.** The surface is a file in a private dotfiles repository that this repository cannot read in CI. A guard here would assert on something it cannot see.
- **Arming the reaper cron.** See D6 — raised, not armed.

## References

- Live measurement, `geoywsMBP`, 2026-08-30 03:00–03:55 MYT: cockpit `atx` per-window options; three attached clients at 291x81 / 102x53 / 79x44; group-cage clients at 79x43 (`grp-unum`) and 291x80 (`grp-ifca`); final state all six windows 291x80 and all three group cages 291x80.
- Fleet sweep, same session: every live tmux socket on the box checked at window and session scope for `window-size`. One hit, `atx:5`.
- Two-client rig, tmux 3.7c, torn down after use: `latest` pin moves on client **input**, not on a control-client `select-window`; `smallest` clamps from a non-viewing client; an unviewed window keeps a stale size after both the override and the pinning client are gone.
- `_dotfiles/bin/tmux-ghost-reaper.sh` header, recording the 2026-06-23 precedent (a 71x38 attach idled ~21h and pinned the unum cage) that this override was written the next day to work around.
