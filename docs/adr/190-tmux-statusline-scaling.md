# ADR-190: tmux statusline scaling at multi-team-of-teams cages — zero-fork cage + TTL-cached operator-curated

**Status**: Accepted — ratified by driver 2026-05-21 (cage statusline zero-fork builtin-only; operator-curated daily-driver/cockpit MAY use #() but MUST TTL-cache; §OQ recommendations as-written)
**Date**: 2026-05-20
**Driver-ref**: driver-2026-05-20-13:24-MYT (operator dispatch from /bruh-discovered tmux statusline performance findings)
**ADR number**: 190 selected per 2026-05-20 collision tracking — 183/184/185/186/187/188/189 all claimed (189 reserved for Epic e-be01fc89 T5 lean-mode-side-project-topology ADR; not yet drafted at time of this filing).
**Operator-dotfiles reference**: `ee009cc` on github.com/geoyws/dotfiles already ships the canonical patterns for the operator's daily-driver tmux. This ADR codifies the same patterns for atmux-shipped configs so every-deployment wins the same scaling fix.

## Context

tmux 3.6a (current bundled version per ADR-163) re-evaluates `#(...)` format expansions on **PANE-ACTIVITY events**, not just on `status-interval` ticks. Claude TUI spinners (`Cooking…`, `Schlepping…`, etc.) generate continuous pane activity → continuous `#()` re-evaluation → fork-storm on every cage.

**Measured at 20-cage scale**: 100+ git-branch forks/second on the operator's daily-driver tmux when statusline contained an unfiltered `#(git branch --show-current)` expansion. CPU + IO load proportional to cage count × pane count × spinner-flicker frequency.

Atmux cages multiply this cost: each per-team cage tmux server has its own statusline. At 18-team fleet observed 2026-05-20 (sentinel cron CPU thrash incident, per ADR-132 §Amendment), the cage-statusline cost compounds.

### Failure mode taxonomy

1. **Direct fork storm**: `#(git branch)` / `#(date)` / `#(uname)` in cage statusline → re-eval on every pane activity → fork-per-pane-event
2. **Cached helper too-fresh**: TTL too low (e.g. 1-5s) → cache misses on every status-interval tick → defeats the cache
3. **status-interval too tight**: default tmux `15s` overridden to `1-5s` in personal configs → status bar redraws faster than helper TTL → cache misses
4. **Cockpit/cage conf sharing**: ADR-162 §Decision-anchor #2 uses ONE canonical `atmux.conf` for both cage AND cockpit tmux servers; cockpit-specific richness via `#()` would leak into cage if added at the bundled-conf layer

### Operator-dotfiles fix (ee009cc) — canonical patterns

The operator's daily-driver tmux now ships:
- `tmux/cpu-bars.sh` — CPU usage with TTL cache
- `tmux/ram-bars.sh` — RAM usage with TTL cache
- `tmux/git-branch-cached.sh` — git branch with TTL cache (MAX_AGE 4s → 15s)
- `tmux/cet-time.sh` — Central European Time helper
- `tmux/local-time.sh` — local-time helper
- `tmux/latency.sh` — network latency helper with TTL cache

Pattern: each helper writes its output to a temp file with timestamp; on invocation, returns cached output if `<MAX_AGE` seconds old; else re-computes and overwrites cache. Default `MAX_AGE=15` matches tmux `status-interval` default.

## Decision

### Rule 1 — Cage tmux statusline MUST be zero-fork

Cage tmux server statusline is built from **tmux builtin format expansions only**. No `#()` forks permitted in atmux-bundled cage statusline.

Canonical cage `status-left` / `status-right` use:
- `#S` — session name (cage:atmux-<team>)
- `#{b:pane_current_path}` — basename of pane CWD
- `#W` — window name (per ADR-135 buildWindowName)
- `%H:%M` — clock (tmux-builtin, zero-fork)

Forbidden in cage statusline: `#(git ...)`, `#(date ...)`, `#(uname ...)`, ANY `#(...)` fork.

### Rule 2 — Operator-curated statuslines (daily-driver, cockpit) MAY use #() but MUST TTL-cache

Operator's personal tmux statusline (daily-driver outside atmux cages) AND atmux cockpit statusline MAY include `#(...)` forks IFF each fork delegates to a TTL-cached helper script.

Atmux ships reusable TTL-cache helper scripts at `bin/atmux-tmux-*.sh` (port of operator-dotfiles patterns; see §Consequences below). Operator references them from `~/.config/atmux/tmux.conf.local` per ADR-171 (existing override path) for cockpit OR from `~/.tmux.conf` for daily-driver.

TTL-cache contract:
- Each helper has `MAX_AGE` env-overrideable default (recommend **15s**)
- Cache file at `${ATMUX_CACHE_DIR:-$HOME/.cache/atmux/tmux-statusline}/<helper>.cache`
- Idempotent + atomic: write to `.tmp` + rename
- Fast-path: if cache file mtime newer than `now - MAX_AGE`, cat the cache and exit
- Slow-path: re-compute + write cache + cat

Helper scripts ported from operator-dotfiles ee009cc into `templates/tmux/bin/` (sibling to `templates/tmux/atmux.conf` per lead-stated convention; one-time port):
1. `templates/tmux/bin/cpu-bars.sh`
2. `templates/tmux/bin/ram-bars.sh`
3. `templates/tmux/bin/git-branch.sh` (cached)
4. `templates/tmux/bin/cet-time.sh`
5. `templates/tmux/bin/local-time.sh`
6. `templates/tmux/bin/latency.sh`

### Rule 3 — status-interval defaults to 15s in atmux-shipped configs

Atmux-bundled `templates/tmux/atmux.conf` SETS `set -g status-interval 15` explicitly (current bundled conf does not set; relies on tmux's 15s default — codify explicitly).

Operator overrides via `~/.config/atmux/tmux.conf.local` per ADR-171.

### Rule 4 — Bundled `templates/tmux/atmux.conf` MUST be operator-agnostic (OSS-ready)

The conf atmux ships to NEW installs / forks / OSS adopters MUST NOT contain operator-personal references. Scrub list:

- **Timezones**: no hardcoded `Europe/Berlin` / `Asia/Kuala_Lumpur` / `+08` / `MYT` literals in conf or helper scripts. Helpers that need timezone data accept env override (e.g. `ATMUX_TMUX_LOCAL_TZ=Asia/Kuala_Lumpur`); default fallback uses system `date` without explicit TZ
- **Hostnames**: no `hax-conditional` branches (e.g. `if hostname == hax then X else Y`). Helpers are hostname-agnostic
- **Person-names**: no `"George travels"` / `"geoyws"` / any operator-personal string literals
- **Catppuccin theme vars**: no `#{BASE}`, `#{TEXT}`, `#{FRAPPE}`, etc. theme-dependent references in atmux-bundled conf. Operator's `tmux.conf.local` is where theming lives (ADR-171)
- **tmux-plugin-dependent strings**: no `#{battery_icon_status}`, `#{wifi_icon}`, `#{online_status}` (these require tmux-plugins/tmux-battery / tmux-online-status / etc.). atmux-bundled conf assumes vanilla tmux; plugin-using statuslines live in operator override

Bundled `templates/tmux/atmux.conf` MUST source-file the operator override at the END:

```
source-file -q "~/.config/atmux/tmux.conf.local"
```

Currently present at line 51 of `templates/tmux/atmux.conf` per ADR-171. ADR-190 codifies this as a §Rule-level invariant (not just an option) — the source-file line cannot be removed by bundled-conf maintenance.

**Outcome**: `atmux init` produces shareable / fork-friendly / OSS-shape conf out of box. Operator's daily-driver tmux is unaffected by this rule (operator tmux is operator-personal scope; rule 4 governs atmux-shipped conf only).

### Rule consistency check

| Scope | Statusline content | Default status-interval | Personal refs |
|---|---|---|---|
| Cage tmux server (per-team) | Zero-fork builtin only | 15s (atmux-bundled) | NONE (Rule 4) |
| Cockpit tmux server | Zero-fork builtin by default; operator may add TTL-cached `#()` via `tmux.conf.local` | 15s (atmux-bundled) | NONE in bundled; operator-personal in `tmux.conf.local` |
| Operator daily-driver tmux | Operator-curated; ATMUX ships helpers; recommendation = TTL-cache all `#()` at 15s | Operator's choice; recommend 15s | OK (operator-personal scope) |

## Consequences

### What changes for which lanes

**OPS lane** — `templates/tmux/atmux.conf` update:
- Add explicit `set -g status-interval 15` (currently relies on tmux default; codify)
- Add explicit zero-fork `status-left` + `status-right` definitions OR leave tmux-default (tmux's defaults are zero-fork — `[#S]` + pane title + time)
- Documentation comment near the status section citing this ADR for the zero-fork invariant
- `~/.config/atmux/tmux.conf.local` (operator override) still loads last per existing ADR-171 contract; operator-curated `#()` lives there

**BE lane** — port 6 helper scripts from operator-dotfiles ee009cc to atmux source at `templates/tmux/bin/*.sh`:
- Adapt MAX_AGE default from 4s → 15s (matches new bundled status-interval)
- Standard cache path: `${ATMUX_CACHE_DIR:-$HOME/.cache/atmux/tmux-statusline}`
- Bash-only (atmux portability); no fork into other shells
- OSS-ready scrub per Rule 4 (no personal refs; env-override for timezone etc)
- Each script: same-commit unit test using bats OR shellcheck OR equivalent ports atmux uses for shell

**DOCS lane** — sweep:
- CLAUDE.md (atmux project) §Tmux discipline (or new section) cross-links ADR-190
- Per-helper-script doc comment at top of each `bin/atmux-tmux-*.sh` cites this ADR + the operator-dotfiles ee009cc origin
- RUNBOOK entry: operator-curating-cockpit-statusline guide
- CHANGELOG entry under [Unreleased] §Added (6 helpers) + §Changed (status-interval 15s default + zero-fork cage invariant codified)

**REVIEW lane** — gate-class:
- Reviewer verifies the 6 ported scripts match operator-dotfiles ee009cc patterns 1:1 (per driver ask "should be 1:1")
- Reviewer verifies atmux.conf change preserves ADR-162 §Decision-anchor invariants (no regression on cage-tier isolation contract)
- Reviewer signs off on the cage zero-fork invariant — grep `templates/tmux/atmux.conf` for any `#(` introduced post-merge

### What we give up

- Cage statusline richness — operator who wants git branch / CPU bars in cage statusline must override via `~/.config/atmux/tmux.conf.local` (ADR-171 path). Trade-off: zero-fork invariant for cage is non-negotiable per operator-stated rule.
- One-line `#()` convenience — explicit TTL-cache helper indirection adds boilerplate. Mitigation: shipped helpers cover the common cases (CPU / RAM / git / time / latency).

### Rollback path

If the zero-fork invariant proves too restrictive for some operator workflow, ADR-171 `~/.config/atmux/tmux.conf.local` is the escape valve — operator can override status-left/right in their local conf. ADR-190 governs what atmux SHIPS as default, not what operator MAY configure.

If TTL=15s is too coarse (statusline feels stale), operators can lower MAX_AGE per helper via env (`ATMUX_TMUX_CPU_MAX_AGE=5 ...`) — helpers honor per-helper env overrides. Set the floor at 5s; below 5s defeats the cache.

## Open questions

1. **(LOW reversibility) status-interval default value**: 15s per operator-stated default. Alternative: 30s for cage (very rarely-watched) vs 5s for operator-watched. Recommendation: 15s uniform (single number; matches helper TTL default; tmux native default). Per-scope tuning defers to operator via `tmux.conf.local`.

2. **(LOW reversibility) Helper script naming**: `bin/atmux-tmux-cpu-bars.sh` vs `bin/atmux-tmux-status-bars/cpu.sh` (directory grouping). Recommendation: flat `bin/atmux-tmux-*.sh` (matches existing bin/ pattern — atmux / atmux-bun / atmux-entry.ts / atmux-tmux).

3. **(LOW reversibility) Cockpit statusline shipped richness**: should atmux ship a cockpit-curated statusline that USES the helpers (so cockpit gets the richness without operator-action)? Recommendation: NO. Cockpit-default stays zero-fork; operator opts-in via `tmux.conf.local`. Reduces shipping surface; preserves the rule-1 invariant cleanly.

4. **(LOW reversibility) Helper output schema stability**: should the helpers commit to a stable stdout shape for future tmux format-string consumers? Recommendation: YES, document each helper's output format at the top of the script with example output. Stability tier: experimental until 0.10 release; semver-compat thereafter.

5. **(LOW reversibility) Cache invalidation on operator command**: should `atmux up` / `cockpit rebuild` clear `~/.cache/atmux/tmux-statusline/`? Recommendation: NO. Cache is bounded by TTL; clearing on every command adds I/O for no observable benefit.

## Cross-refs

- ADR-162 (atmux owns tmux infrastructure — cockpit socket isolation + canonical conf; §Decision-anchor #2 conf invariants preserved)
- ADR-163 (bundled tmux 3.6a — the version whose #() re-eval-on-PANE-ACTIVITY semantics motivates this ADR)
- ADR-171 (tmux.conf.local override — escape valve for operator-curated cage statusline overrides)
- ADR-135 (window-name convention — buildWindowName cited in cage statusline)
- ADR-050 (cage tier isolation — zero-fork keeps Tier-1 lean per the tier invariants)
- ADR-132 §Amendment 2026-05-20 (cost-curve realization — same theme: cron-polling fork storm vs statusline fork storm; both addressed via TTL-cache + on-demand patterns)
- Operator-dotfiles `ee009cc` on github.com/geoyws/dotfiles (origin of the 6 helper scripts)
- Driver-ref: driver-2026-05-20-13:24-MYT
