# ADR-047: Canonical atmux install topology — `/usr/local/bin/atmux` symlinks to dev tree, `/opt/atmux-stable` is autopromote's tested-baseline fallback

**Status**: accepted
**Date**: 2026-05-05
**Driver-ref**: 2026-05-05 session — operator surfaced confusion about why dev edits at `/root/work/src/atmux/lib/whip.sh` weren't reflected in live `atmux` runs. Investigation found 6 stale install dirs accumulating under `/opt/`: 4 `.bak.*` snapshots from manual incident-response copies, plus `/opt/atmux-stable/` (autopromote's target) and `/root/.atmux-promote-staging/` (autopromote's working tree). Symlink at `/usr/local/bin/atmux` pointed at `/opt/atmux-stable/`, so dev-tree edits were silently bypassed by the installed binary. Operator framed it as "needs to source zshrc" — actually a stale-install issue, not a shell-state issue.

## Context

atmux's `install.sh` (one-shot installer):

1. Clones repo → `${ATMUX_HOME:-$HOME/.atmux-src}`
2. Symlinks `/usr/local/bin/atmux` → `<install_dir>/bin/atmux`
3. Same for `atmux-tmux`

The binary self-resolves `ATMUX_LIB_DIR` via `BASH_SOURCE` walking (`bin/atmux:9-19`), so it always finds the lib/ + templates/ tree relative to the symlink's eventual target. **No env var or shell-side config is required for the binary to work** — the source-zshrc concern is unfounded for atmux's runtime; it only applies to optional shell completions (`completions/atmux.bash`, `completions/_atmux`).

But the operator's daily workflow on hax has TWO atmux installations:

1. `/root/work/src/atmux/` — live dev tree (where edits happen). Hosts the dogfooding atmux team's worktrees under `.claude/worktrees/<branch>/`.
2. `/opt/atmux-stable/` — autopromote target (`scripts/autopromote.sh` rsyncs origin/main here every cron run, **after tests pass**).

By default `install.sh` (cloud users) puts atmux at `~/.atmux-src/`. On hax, the operator bootstrapped a different topology by hand: `/usr/local/bin/atmux → /opt/atmux-stable/bin/atmux`. This topology is intentional — `/opt/atmux-stable/` is the **tested-baseline fallback** maintained by autopromote — but it had a sharp edge: dev edits in `/root/work/src/atmux/` weren't picked up by the installed `atmux` until autopromote's cron tick rsync'd to `/opt/atmux-stable/`.

For dogfooding, that's wrong. The operator wants live dev edits to be the runtime so changes are tested in their own use immediately — including breaking ones.

Additionally, six stale install dirs were found under `/opt/`:

```
/opt/atmux-stable                                  1.7M   active fallback  (May 2)
/opt/atmux-stable.backup-20260427-1246-MYT/        752K   stale            (Apr 27)
/opt/atmux-stable.bak.20260504T025206Z/            376K   stale            (May 2)
/opt/atmux-stable.bak.20260504T042548Z/            1.8M   stale            (May 2)
/opt/atmux-stable.bak.20260504T055538Z/            1.7M   stale            (May 2)
/root/.atmux-promote-staging/                      3.2M   autopromote tree (May 2)
```

The `.bak.*` dirs were one-off manual `cp` snapshots taken during incident response (not produced by `autopromote.sh`'s current code, which uses `rsync -a --delete` directly). No retention logic — they accumulate forever unless someone manually prunes.

## Decision

### D1 — Canonical install topology

**`/usr/local/bin/atmux` symlinks DIRECTLY to the live dev tree** so operator edits at `/root/work/src/atmux/` are the runtime atmux:

```
/usr/local/bin/atmux       → /root/work/src/atmux/bin/atmux
/usr/local/bin/atmux-tmux  → /root/work/src/atmux/bin/atmux-tmux
```

`/opt/atmux-stable/` remains the tested-baseline fallback maintained by `autopromote.sh`. Operators can fall back to it with one symlink swap when dev breaks:

```bash
# Swap to stable fallback (e.g. dev tree broken):
ln -sf /opt/atmux-stable/bin/atmux /usr/local/bin/atmux
ln -sf /opt/atmux-stable/bin/atmux-tmux /usr/local/bin/atmux-tmux

# Swap back to dev:
ln -sf /root/work/src/atmux/bin/atmux /usr/local/bin/atmux
ln -sf /root/work/src/atmux/bin/atmux-tmux /usr/local/bin/atmux-tmux
```

This trades one risk (breaking changes in dev affect runtime atmux) for two benefits: (a) immediate dogfooding feedback on dev edits, (b) zero-step propagation for hotfixes (no waiting for autopromote's cron).

### D2 — `/opt/atmux-stable.bak.*` is forbidden by convention

No code in this repo creates `.bak.*` snapshots of `/opt/atmux-stable/`. The 4 stale dirs found 2026-05-05 were manual incident-response copies; deleted in the same session. **Do not reintroduce backup-creating logic without retention.** If incident response needs a snapshot:

- Use `git -C /opt/atmux-stable show HEAD` to capture the SHA — that's the rollback handle.
- Or `cp -r /opt/atmux-stable /tmp/atmux-stable.<TS>` — `/tmp` gets garbage-collected by the OS, no manual cleanup.

`autopromote.sh`'s `rsync -a --delete` is the correct primitive — atomic-replace, no backup needed since git history at the promoted SHA is the rollback path.

### D3 — Worktrees of `/root/work/src/atmux/` do NOT serve as canonical install

Worktrees at `.claude/worktrees/<branch>/` (e.g. atmux-bun port) have their own `bin/atmux` per git worktree mechanics. **The symlink does NOT point at a worktree** — only at the main checkout (`/root/work/src/atmux/`). Worktrees are dev branches, not runtime tracks.

Rationale: worktree branches may be in arbitrary states (mid-refactor, broken builds, port-in-progress). The main checkout's HEAD is the dogfood line. Pointing at a worktree would couple atmux's runtime stability to whatever branch the operator happens to be on.

### D4 — Cleanup discipline going forward

Periodic audit (manual or via a future `atmux doctor` extension):

```bash
ls /opt/ | grep atmux             # should show only `atmux-stable/`
ls /root/ | grep -i atmux         # should show only `.atmux-promote-staging/` (autopromote tree) + the live worktrees under `work/src/atmux/`
```

Anything else is a candidate for deletion. The expected steady state is **2 dirs under /opt and /root each** (active install + autopromote staging) plus the dev tree at `/root/work/src/atmux/`.

## NOT in scope

- **Cross-machine canonical topology.** This ADR pins hax-side. Cloud / Mac local installs continue to use `install.sh`'s default (`~/.atmux-src/`); both are valid, just different conventions.
- **Daemonising atmux.** Operator floated "atmux as a server that doesn't need re-sourcing" — no shell-state caching exists in current bash atmux, so a daemon doesn't solve a real problem at this scale. The TS port (atmux-bun) may add daemon mode if a concrete need surfaces post-cutover. Out of scope here.
- **Deprecating `install.sh`'s default of `~/.atmux-src/`.** First-time cloud installs still want a self-contained install location. The dev-tree symlink described here is hax-specific, operator-bootstrapped.

## Consequences

- Operator's dev-edit → atmux-runtime gap collapses to zero seconds. Saves cycles previously spent waiting for autopromote cron or manually rsync'ing.
- `/opt/atmux-stable/` becomes a "warm fallback" instead of the live runtime. `autopromote.sh` keeps maintaining it (no script changes needed). Discord `[autopromote-shipped]` pings continue, just informational rather than runtime-affecting.
- Risk: a broken dev commit immediately breaks runtime atmux. Mitigation: the operator's dogfooding habit catches it; fall back via the one-line symlink swap above.
- 6 → 2 install dirs under `/opt/` and `/root/` after this session's cleanup.
- README install section updated to describe both topologies (cloud-default + hax-dogfood) so future operators don't accidentally reproduce the 6-dir mess.

## Migration applied 2026-05-05

```bash
# 1. Re-symlink (already applied this session):
ln -sf /root/work/src/atmux/bin/atmux      /usr/local/bin/atmux
ln -sf /root/work/src/atmux/bin/atmux-tmux /usr/local/bin/atmux-tmux

# 2. Delete stale backup dirs (already applied this session):
rm -rf /opt/atmux-stable.backup-20260427-1246-MYT
rm -rf /opt/atmux-stable.bak.20260504T025206Z
rm -rf /opt/atmux-stable.bak.20260504T042548Z
rm -rf /opt/atmux-stable.bak.20260504T055538Z

# Verify steady state:
ls /opt/ | grep atmux       # → atmux-stable
which atmux                  # → /usr/local/bin/atmux
readlink -f /usr/local/bin/atmux  # → /root/work/src/atmux/bin/atmux
atmux version                # → atmux 0.3.0 (from dev tree HEAD)
```
