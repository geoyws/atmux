# ADR-171: Cage tmux user override conf — `~/.config/atmux/tmux.conf.local`

**Status**: Accepted — ratified by driver 2026-05-21 (append `source-file -q ~/.config/atmux/tmux.conf.local` last; -q silent on absent; operator owns file; §OQ recommendations as-written)
**Date**: 2026-05-18
**Cross-refs**: ADR-162 (atmux owns tmux infrastructure — defers user-override to "ADR-163"), ADR-163 (bundles binary + reset-config verb — full implementation deferred).
**Carve-out from ADR-163**: ADR-163 §Decision-anchor #2 specifies `${userConfigDir}/atmux/tmux.conf.local` as a user-override path loaded via `source-file -q` appended to the default conf. ADR-163 ALSO covers the bundled binary, `reset-config` / `print-config` verbs, install-path resolver, plugin code — heavyweight. This ADR ships the source-file line **early**, leaving the rest of ADR-163 deferred.

## Context

ADR-162 made atmux pass `-f templates/tmux/atmux.conf` for every cage tmux server. The bundled conf is intentionally minimal (8 options) and **does not** load `~/.tmux.conf`, on purpose — host-conf quarantine.

In practice that gives every cage tmux server the tmux-default green statusline. Operators with a curated `~/.tmux.conf` (Catppuccin / tokyonight / opencode-dark powerline, custom prefix, status-bar formatters with CPU/RAM/wifi/time widgets) lose all of it inside cage servers. This is visible right now: atmux/unum/rentx team servers were created BEFORE ADR-162 landed and inherited `~/.tmux.conf` naturally; sopx was started AFTER, hit ADR-162's `-f` flag, and got the minimal conf. The visual inconsistency is the immediate symptom; the structural problem is that operators have no override path at all.

ADR-162 §Decision-anchor #2 forward-refs the fix:

> ADR-163 may eventually layer a `source-file -q ~/.config/atmux/tmux.conf.local` line for user overrides; ADR-162's conf doesn't include it (forward-compat — ADR-163 wires that path).

ADR-163's full implementation (bundled binary acquisition pipeline, version-lock postinstall fetch, atomic-symlink swap, `reset-config` / `print-config` verbs) is months of work. The **source-file line** is one line of conf + one paragraph of docs. Shipping the line early unblocks every operator with a curated `~/.tmux.conf` today, costs nothing for operators without one (the `-q` makes a missing override a silent no-op), and is forward-compatible with ADR-163's full rollout (same path, same semantics).

## Decision

Append the following line as the **last** line of `templates/tmux/atmux.conf`:

```tmux
# User override (ADR-171) — silent no-op if file absent. Loaded LAST so it wins.
source-file -q "~/.config/atmux/tmux.conf.local"
```

The override file is operator-owned; atmux does NOT create it. Operators who want their host `~/.tmux.conf` inside cage servers can put `source-file ~/.tmux.conf` in `tmux.conf.local`; operators who want only specific options can put just those.

### Why `-q`

`source-file -q` silently no-ops on missing file. Operators without an override get the bundled conf unchanged (same behavior as today). Without `-q`, every cage server start would emit a `failed to read` warning on a missing override file — noise for the majority case.

### Why last-line

Override-wins-over-default is the operator's expectation. tmux options are last-write-wins for `set -g`. Putting the source-file last means override values override the bundled conf's defaults. The bundled conf still owns the load-bearing invariants (`base-index`, `allow-rename off`, `automatic-rename off` — required by ADR-135 window naming), and operators who break those by overriding lose the atmux guarantees, but that's an operator-bug, not a framework-bug.

### Why no atmux-managed reset-config verb (yet)

ADR-163 specifies `atmux tmux reset-config` to regenerate both files atomically. This ADR ships the source-file line WITHOUT that verb. Operators who need a fresh override file write it themselves (`touch ~/.config/atmux/tmux.conf.local`). When ADR-163's full implementation lands, it will wrap this path; the source-file line in the bundled conf stays unchanged.

### Why a separate ADR vs amending ADR-162

ADR-162 is accepted (in the "Conventions" section above). Per atmux's append-only ADR rule, ADR-162's body is not edited. ADR-171 layers a small forward-step. ADR-163 stays the umbrella for the bundled-binary work; once ADR-163 ships, both ADR-162 and ADR-171 get a `Superseded by ADR-163` annotation.

## Consequences

- One-line conf change to `templates/tmux/atmux.conf`. No code changes — the `-q` semantics live in tmux itself.
- Existing operators with a curated `~/.tmux.conf` create `~/.config/atmux/tmux.conf.local` once (one-line `source-file ~/.tmux.conf`) and every future cage tmux server picks it up automatically.
- Operators with no override file get the bundled conf unchanged.
- Forward-compatible with ADR-163's full implementation — same path, same semantics, same load order.
- Doesn't affect already-running cage tmux servers — only takes effect on the next server start. Operators who want immediate effect on a live cage run `tmux -S <socket> source-file ~/.config/atmux/tmux.conf.local` once.

## Out of scope

- Bundled binary (ADR-163 §Part B+).
- `atmux tmux reset-config` / `print-config` verbs (ADR-163 §Decision-anchor #3).
- Load-bearing-key override warnings (ADR-163's `print-config` flags overrides that touch `base-index`, `pane-base-index`, etc.).
- XDG-spec `$XDG_CONFIG_HOME` honoring (ADR-163 §Decision-anchor #2 says `$XDG_CONFIG_HOME/atmux/tmux.conf.local OR ~/.config/atmux/tmux.conf.local`; this ADR uses the latter only — XDG case is forward work).
