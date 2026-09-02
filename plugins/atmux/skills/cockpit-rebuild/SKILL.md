---
name: cockpit-rebuild
description: Deterministically (re)build the atmux cockpit + every per-team cage via `atmux cockpit rebuild`. Idempotent — safe after reboot or accidental cage drop. Per ADR-063 / ADR-135 / ADR-162.
argument-hint: [--no-cycle] [--force-cycle]
---

<!-- carved per ADR-217 §D4 -->

# /atmux:cockpit-rebuild — deterministic cockpit + cage topology

Recreates the canonical cockpit topology in one shot via the `atmux cockpit rebuild` verb (ported from operator dotfiles into atmux proper per [ADR-063](../../../../docs/adr/063-cockpit-verb-port.md)):

| Layer | What |
|---|---|
| Cockpit session `atx` ([ADR-264](../../../../docs/adr/264-cockpit-session-atx-rename.md) §D5; was `atmux_cockpit` per [ADR-135](../../../../docs/adr/135-cockpit-naming-convention.md) §D1, before that `atmux_teams`) | window 1 `_sd` (superdriver lane 1; was `_superdriver` — renamed in place per [ADR-288](../../../../docs/adr/288-superdriver-lane-shortform-and-multi-lane-cockpit.md) §D1); the `_sd2` / `_sd3` superdriver lanes immediately after it as declarative operator windows (ADR-288 §D2, placement per §D5); then optional `_medic` / `_sentinel` slots when configured (both retired as auto-spawn roles per ADR-211 + ADR-212 — slots stay for back-compat); per-team viewer windows from window N+1, each self-heal-loops `tmux attach` into its cage's driver window |
| Per-team cages | one tmux server per team on an atmux-resolved socket (`/tmp/atmux-<team>/sock`, or `team.json::tmuxTmpdir` override; see [ADR-018](../../../../docs/adr/018-per-team-tmux-socket-isolation.md) + [ADR-162](../../../../docs/adr/162-atmux-owns-tmux-infrastructure.md)). Each cage spawns Claude with an isolated `CLAUDE_CONFIG_DIR` so per-account session state and rate-limit windows don't cross-contaminate. Member panes use `--permission-mode auto` + bare window names per ADR-006. |
| Cage prefix | per-cage prefix is **level-resolved** at rebuild time per [ADR-089](../../../../docs/adr/089-hierarchical-cockpit.md) §C — cages nested inside a parent cage gain a different prefix than top-level team cages, so the operator can target a specific layer without ambiguity. |
| Registry `~/.claude/teams/registry.json` | trimmed to the canonical team set; existing emoji rosters preserved across rebuilds. |
| Crontab | scrubbed of orphan lines from stopped teams + stale-team-name blocks. Cron `SHELL` / `PATH` / `TERM=xterm-256color` env preamble prepended so cron's tmux invocations don't segfault on bare env. |

## Instructions

1. Run `atmux cockpit rebuild`, passing through `$ARGUMENTS` if non-empty.
   - `--no-cycle` — skip the cage stop+start cycle; only normalise `team.json` files, registry, and cockpit overlay. Use when in-flight REPL state in cages must be preserved.
   - `--force-cycle` — cycle even cages with running Claude REPL processes (default behavior protects live cages).
2. Stream the verb's output to the user. The verb is verbose and self-documents each phase (`▸ normalising team.json files`, `▸ trimming registry`, `▸ stopping cages`, `▸ starting cages`, `▸ applying level-resolved cage prefix`, `▸ reconciling cockpit`).
3. On non-zero exit, surface the failing phase. Do not retry blindly — the verb is idempotent but the failure is informative (a stale `state/session.txt` from a corrupted prior run can desync; a doctor red predates the rebuild — `--no-doctor` is already baked in, but the doctor row still shows on next `atmux doctor`).
4. On success, suggest `tmux attach -t atmux_cockpit` if not already inside it, and `prefix n/p` to flip between viewer windows.

## Mental model — what's happening under the hood

- **Layered tmux sockets**: the cockpit lives on its own isolated socket per [ADR-162](../../../../docs/adr/162-atmux-owns-tmux-infrastructure.md) (no longer shares the user's default tmux socket — eliminates a class of cross-contamination bugs). Each cage gets its own socket too. Cockpit viewer windows nest-attach into cages.
- **`bareWindowNames`** ([ADR-006](../../../../docs/adr/006-bare-atmux.md)) drops the legacy `__<team>__` prefix on cage windows, so the cage shows `🦀<role>` directly rather than `__<team>__🦀<role>`.
- **Per-team Claude account**: each cage spawns claude with its own `CLAUDE_CONFIG_DIR` so per-account session state + rate-limit windows stay isolated. Encoded as `tuiCommands.claude` in each `team.json` — must be the inline `CLAUDE_CONFIG_DIR=… claude …` form, NOT a shell wrapper function (tmux execs new-session shell-commands via `/bin/sh` which doesn't see user-shell-defined functions).
- **Level-resolved cage prefix**: epic-team cages nested inside a parent atmux team get a different prefix from the parent's prefix per [ADR-089](../../../../docs/adr/089-hierarchical-cockpit.md) §C, so the operator's daily-driver prefix stays unambiguous. Recent fix at commit `b887009` ensures rebuild applies the level-resolved prefix per ADR-089 §C (was previously clobbering the F-key chain with a legacy fixed prefix).

## When NOT to run this

- If team panes contain valuable in-flight Claude conversation state and you don't want to lose it. The default invocation cycles cages = kills all REPLs. Use `--no-cycle` to skip the destructive part if you only need to reconcile the cockpit / registry / team.json.
- If `atmux doctor` is currently red on a critical row — fix the doctor row first; the rebuild's idempotency means re-running after the fix is cheap.

## Operator-facing report format — attention + verdict markers

Cockpit rebuild touches the full topology (cockpit-tier windows + per-team cages + viewers); verdict per end-state reconciliation.

**Verdict-derivation rules:**
- **✅** all expected windows landed (cockpit-tier roles + per-team viewers, every cage at expected socket), cycling completed cleanly.
- **⚠** topology landed but one or more cages couldn't be cycled (in-flight REPL preserved with `--no-cycle`, or cycle hit a wedged pane that needs operator's call).
- **🔴** verb exit non-zero, OR `_sd` window didn't spawn, OR `cockpit.json` read failed, OR ≥1 expected cage failed to come up after retry.
- **👁** attaches when operator must decide: keep wedged pane vs `--force-cycle`, re-enable a paused team, address missing cage socket.

**Examples:**
```
✅ /atmux:cockpit-rebuild — 4 cages up, _sd + 4 viewers, all cycled
```
```
⚠ /atmux:cockpit-rebuild --no-cycle — topology reconciled, 3 cages kept their in-flight REPLs
ℹ Operator: re-run without --no-cycle when ready to refresh REPL contexts
```
```
👁 🔴 /atmux:cockpit-rebuild — cockpit.json read failed (file missing at ~/.atmux/cockpit.json)
👁 Operator: run `atmux init` per ADR-200 wizard to bootstrap cockpit.json, or restore from backup
```

## Cross-references

- [ADR-063](../../../../docs/adr/063-cockpit-verb-port.md) — verb port (this skill's substrate; defines `atmux cockpit rebuild` surface)
- [ADR-135](../../../../docs/adr/135-cockpit-naming-convention.md) — `atmux_teams` → `atmux_cockpit` session rename + `_`-prefix cockpit-role windows
- [ADR-162](../../../../docs/adr/162-atmux-owns-tmux-infrastructure.md) — cockpit on isolated tmux socket; eliminates daily-driver socket contamination
- [ADR-018](../../../../docs/adr/018-per-team-tmux-socket-isolation.md) — per-team cage socket isolation
- [ADR-089](../../../../docs/adr/089-hierarchical-cockpit.md) §C — level-resolved cage prefix chain
- [ADR-006](../../../../docs/adr/006-bare-atmux.md) — `bareWindowNames` convention
- [ADR-211](../../../../docs/adr/211-retire-sentinel-role-distribute-to-honker-consumers.md) + [ADR-212](../../../../docs/adr/212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md) — `_sentinel` + `_medic` cockpit-role auto-spawns retired (slots in `cockpit.json` schema kept for one-release back-compat)
- [ADR-217](../../../../docs/adr/217-atmux-skills-plugin-bundled-and-wizard-installed.md) §D4 — generalization pass strip list (this carve)
