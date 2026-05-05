# ADR-024: Spawned-agent account matching — team members must run on the driver's claude account

**Status:** accepted
**Date:** 2026-05-05
**Owner:** driver

## Context

The `claude` CLI uses `$CLAUDE_CONFIG_DIR` to pick which account/identity to authenticate as:

| Wrapper | `CLAUDE_CONFIG_DIR` | Account | Email |
|---|---|---|---|
| `c-u` (zsh fn) | `$HOME/.claude-unum` | Unum | `geoyws@u-n-u-m.com` |
| `c-ic` (zsh fn) | `$HOME/.claude-icloud` | iCloud / IFCA | `geoyws@icloud.com` |
| `claude` (bare) | `$HOME/.claude` | Personal default | varies |

Each wrapper guards account routing via `_claude_account_guard <expected> "$PWD"` — refuses to launch a c-u (unum) Claude inside an ifca-bound folder, etc. The guard exists because **cross-account use on the same project trips Anthropic ToS flags** (ban risk per the wrapper's own warning).

When the driver spawns team-member windows via `tmux send-keys`, the operator must pick a wrapper. Naively copying the spawn pattern from a stale handoff (e.g. handoff written by a c-ic driver, then a c-u driver runs `/session cont` and copies the line verbatim) results in **cross-account spawns**: driver authenticates as Unum, members authenticate as iCloud/IFCA. Same project, two accounts.

This was observed 2026-05-05: handoff said `Spawn pattern: CLAUDE_GUARD_AGENT=1 c-ic ...`. Driver under `/root/.claude-unum/` (c-u) spawned 4 members with `c-ic`. Caught immediately by George before any team work landed; team was killed + re-spawned correctly.

Beyond ToS exposure, cross-account spawns also break:

- **Cost tracking** — V-22 `atmux cost` reads `~/.claude/projects/<slug-of-cwd>/*.jsonl` for `assistant.message.usage` blocks. Only sees the driver's account by default. Cross-account members' tokens/USD become invisible to whip's `[whip-budget]` template.
- **Session-state continuity** — `~/.claude/projects/<slug>/<session-id>.jsonl` is per-account. Members on a different account write to a different projects-tree the driver can't introspect.
- **Memory + skill access** — `CLAUDE_CONFIG_DIR/CLAUDE.md` is per-account. Members on the wrong account get the wrong global instructions.

## Decision

### Rule

**Every team-member agent spawned via tmux must use the same `CLAUDE_CONFIG_DIR` (and therefore the same wrapper / account) as the driver who spawned them.** Never cross accounts within a single team / project.

### Detection

Driver detects its own account via the `CLAUDE_CONFIG_DIR` env var (set by the wrapper that launched it) OR by path-inspecting where its CLAUDE.md lives:

```bash
# Inspection idiom — read the env first, fall back to path
case "${CLAUDE_CONFIG_DIR:-$(realpath ~/.claude 2>/dev/null)}" in
  */.claude-unum*)    DRIVER_WRAPPER="c-u" ;;
  */.claude-icloud*)  DRIVER_WRAPPER="c-ic" ;;
  */.claude*)         DRIVER_WRAPPER="claude" ;;
  *)                  DRIVER_WRAPPER="claude"; echo "warn: unknown account, defaulting to bare claude" ;;
esac
```

### Spawn pattern (canonical)

```bash
# Per-window spawn — driver substitutes $DRIVER_WRAPPER detected above
tmux new-window -t <session> -n "<emoji><member>" -c "$PWD"
tmux send-keys -t <session>:<window> \
  "CLAUDE_GUARD_AGENT=1 ${DRIVER_WRAPPER} --permission-mode dontAsk --model claude-opus-4-7" Enter
```

`CLAUDE_GUARD_AGENT=1` bypasses the wrapper's interactive confirm (the spawn is non-interactive; the guard would otherwise prompt for a key press to acknowledge the cross-account warning, hanging the spawn). Bypass is **safe within the matching-account constraint** — guard exists for cross-account; matched-account always passes.

### HANDOFF.md spawn-pattern templating

Handoffs must NOT hardcode a specific wrapper. The pattern line uses a placeholder:

```markdown
**Account routing for future agent spawns:** match the driver's account.
Spawn pattern (driver substitutes its own wrapper):
```bash
CLAUDE_GUARD_AGENT=1 <driver-wrapper> --permission-mode dontAsk --model claude-opus-4-7
```
```

`<driver-wrapper>` resolves at `/session cont` time per the detection idiom above. A future automated `/session cont` (V-26 per ADR-021) does this resolution as part of mode-detection.

### Whip-side enforcement

V-25 whip's per-member pane check (per ADR-022 in-scope) gains a small extension when the lead is c-u (matching the driver) but a member's pane shows `CLAUDE_CONFIG_DIR=...claude-icloud` (or any non-matching value). Surface as:

```
🛑 <member>: cross-account spawn (member account=ifca, expected=unum) — kill window + respawn with c-u
```

Implementation lands inside V-25's banner-detection block — read the pane's environment via `tmux show-environment -t <pane> CLAUDE_CONFIG_DIR` (or scrape the launch line from `tmux capture-pane`'s history). Cheap addition (~10 LOC) given V-25 already iterates per-member panes.

### NOT in scope

- **Multi-account teams.** A future use case (e.g. one teammate intentionally on a different account for token-budget reasons) would require a per-member `account` field in `team.json::members[]` — separate ADR. ADR-024 pins the homogeneous-account default.
- **Account-detection for non-tmux harnesses.** Orch / OpenCode use different spawn mechanics (`orch_create` / `orch_spawn`) — those harnesses already pass the parent's auth context. Not a concern here.
- **Cross-machine spawn.** Driver on hax + member on a different machine is out of scope; same-machine-same-account is the constraint.

## Migration plan

- **HANDOFF.md update** — replace any hardcoded `c-ic` / `c-u` / `claude` in the "Account routing for future agent spawns" section with the placeholder + detection idiom. Land in this commit chain.
- **V-25 whip check** — included in V-25's in-scope (per ADR-022) as a small extension. Documented in V-25's commit body.
- **Skill update (post-cutover)** — when `/coordination:team start` skill migrates to `atmux team start` per ADR-021, the runtime detects driver's account + spawns members with the matching wrapper. No operator-visible change.

## Consequences

- One more rule to follow during team spawn — but it's mechanical (detect-then-substitute), not judgmental.
- Cross-account incidents become impossible at the spawn-time check; whip catches drift if a member somehow ends up on the wrong account post-spawn.
- HANDOFF.md becomes more portable across cont's between drivers on different accounts.
- Cost / session-state observability stays unified (one account's projects-tree contains all team activity).
- No public API impact — atmux verbs themselves don't care which account; the constraint is on the spawn-time wrapper choice.

## Out of plan

- If `_claude_account_guard` is ever extended to also block within-account spawns (e.g. dev-vs-prod separation on one account), this ADR may need a "guard-bypass nuance" amendment. Currently the guard is account-scoped only; safe.
- Edge case: a driver running bare `claude` (no wrapper) on the default `~/.claude` account spawns members with bare `claude`. Same wrapper → same account. Still satisfies the rule; just no `CLAUDE_CONFIG_DIR` env var to propagate. The detection idiom above falls through to `DRIVER_WRAPPER="claude"`.
