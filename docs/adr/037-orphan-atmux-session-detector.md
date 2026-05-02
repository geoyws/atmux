# ADR-037: Doctor — orphan `atmux_*` session detector (namespace-scoped, no `--fix`)

**Status**: proposed
**Date**: 2026-04-30
**Driver-ref**: 17:00 MYT — driver request after `icontest` / `iconverify` / `settled` cleanup; constraint: "don't clobber anything in default tmux-land where other non-atmux sessions live."

## Context

After the `icontest` / `iconverify` / `settled` cleanup (7 idle zsh sessions on the operator socket, no traceable creator), driver asked for a doctor row that catches similar orphans before they accumulate. The constraint matters: the operator socket also hosts the driver's daily-driver project sessions (`26`, `__main`, `convoke`, `ix`, `paste`, `sb`, `snap`, etc.) — those are legitimate non-atmux state, owned by the user, and **must not** appear in any atmux-driven cleanup or warning.

Two categories of orphan to think about:

- **A — atmux-namespaced orphans.** Sessions matching the `atmux_*` launcher convention (or bare `atmux`) that aren't backed by a registry entry. Anchored by the naming convention atmux owns; safe to detect.
- **B — non-namespaced orphans.** Idle single-window zsh sessions with random/test names like `icontest`, `iconverify`, `settled`, `foo123`, etc. **No anchor.** Indistinguishable from a user's "scratch" tmux session for a quick task; any heuristic risks false-positives on non-atmux state. **Out of scope** — this ADR explicitly does NOT detect these.

## Decision

**Add `_doctor_check_orphan_atmux_sessions` to `lib/doctor.sh`. Surface-only — no `--fix` action. Scope: operator socket only, names matching `^atmux_*` only.**

Logic:

1. **Skip when not on operator socket.** The check only runs when `$TMUX` points at the operator-socket equivalent (i.e., NOT inside a cage). On the-host this is `/tmp/tmux-$UID/default`. Otherwise return early — cage sockets are atmux-owned by definition; their session list is governed by the cage-isolation contract (ADR-018).

2. **Build allowlist of recognized atmux session names:**
   - `atmux` (the dogfood team — bare session per ADR-018 carve-out for the team literally named `atmux`).
   - `atmux_superdriver` (per ADR-025, fleet aggregator).
   - `atmux_<team>` for every entry in `~/.claude/teams/registry.json`. The launcher convention from ADR-018 amendment (2026-04-27 cage-isolation-as-default).

3. **Iterate operator-socket sessions matching `^atmux(_|$)`.** For each:
   - In allowlist → green (silent — too noisy to emit a row per launcher).
   - NOT in allowlist → yellow row `orphan-atmux-session:<name>` with the explicit message "session matches atmux launcher pattern but no registry entry; investigate before killing — could be a stale launcher from a removed team or a name collision."

4. **Sessions NOT matching `^atmux(_|$)` are NEVER iterated.** No row, no warning, no `--fix` candidate. The user's `26`, `__main`, `convoke`, `ix`, `paste`, `sb`, `snap`, and any future scratch session is invisible to this check by construction.

5. **No `--fix` action.** Surface-only. The driver decides whether the orphan is genuinely stale (e.g., a launcher for a team that was removed) or in-flight work in a renamed-but-not-yet-registered state. A `--fix` that auto-kills sessions risks data loss if a user is mid-task in a session that happens to match the pattern; the false-positive cost is too high relative to the benefit.

## Consequences

**For lib/doctor.sh:** ~40 LOC added. New check function + dispatch entry. No changes to existing rows.

**For tests/unit/doctor_orphan_atmux.bats** (new): three cells:
- Green path: registry has teams `alpha` + `beta`, operator socket has `atmux`, `atmux_superdriver`, `atmux_alpha`, `atmux_beta` → no row emitted.
- Yellow row: operator socket has an extra `atmux_ghost` not in registry → yellow `orphan-atmux-session:atmux_ghost` row.
- No false-positive: operator socket has `26`, `__main`, `convoke`, `paste` — none are `atmux_*` shape → no row regardless of registry contents.

**For non-`atmux_*` orphans (the `icontest` / `iconverify` / `settled` class):** explicitly out of scope. Future ADR can revisit if a strong-anchor heuristic emerges (e.g., empty-pane idle >Nh with stale brief content), but doing it without an anchor risks false-positives on the operator's daily-driver sessions and that's the line driver drew.

**Rollout:** lands as a single doctor row in the next hourly autopromote cycle. Operators see the row when they next run `atmux doctor`. Zero behavioral change for fleets without orphans.

## Open questions

1. **OQ1: detect orphan `atmux_<team>` for teams whose registry entry exists but whose project root is missing on disk?** Out of scope here — that's a separate "stale-registry" detector that's already partly handled by `_doctor_check_topology_invariant` (which probes whether a registry team has a live tmux session). The orphan-session check is the dual: "session exists, no registry." Both classes deserve doctor rows; this ADR handles only the second. Stale-registry is its own ADR if it grows beyond doctor's existing topology row.

2. **OQ2: include the session creation timestamp in the row?** Considered yes — `tmux list-sessions -F '#{session_created}'` returns epoch. Adding "(idle since YYYY-MM-DD HH:MM MYT)" makes the row self-explanatory. Resolved: yes, include if creation epoch is available. Falls back silently if tmux's session_created format isn't supported on the operator's tmux build.

3. **OQ3: should the row escalate to red after a configurable age threshold?** Not initially — yellow is enough. If the same orphan persists across multiple `atmux doctor` runs over weeks, the user notices via the row appearing repeatedly. Auto-escalation adds complexity without solving a problem that doesn't exist yet.

## Cross-references

- ADR-018: per-team tmux socket isolation (defines the `atmux_<team>` launcher convention this check anchors on).
- ADR-025: superdriver phase-1 (defines the `atmux_superdriver` allowlist entry).
- ADR-030: registry emoji immutability (registry is the source-of-truth for "registered teams" — this check reads that same registry).
- `feedback_naming_convention_underscore_domains.md` (memory): underscore separator between `atmux` and the team token — the regex `^atmux(_|$)` follows this convention.
