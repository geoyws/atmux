# ADR-004: Ephemeral feature specialists via `add-member`

**Status**: accepted
**Date**: 2026-04-25

## Context

A big feature can saturate a single staff member — the main `planner` runs long on a complex decomposition while a second feature waits; the `dba` is deep in one schema while another lane needs a review. Options considered:

1. Auto-spawn ephemeral specialists when canonical staff is "busy" (queue depth, idle signal).
2. Manual spawn via `atmux add-member <name> --role <role>`.
3. Don't solve — tell users to scale up the whole team or wait.

## Decision

Option 2: **manual spawn, documented pattern**. The `add-member` verb already supports arbitrary member names + roles; there's no new code. The convention is `<role>-<feature>`:

```bash
atmux add-member planner-auth --role planner --tui claude
atmux add-member dba-invoice  --role dba     --tui claude
atmux add-member planner-mig  --role planner --tui claude
```

They inherit the same brief template as the canonical role, so the lead treats them as parallel staff. `atmux pause <name>` when idle; remove from `team.json` when the lane ships.

## Consequences

### What we gain
- Zero new code. `add-member` already does it.
- Operator keeps control — no auto-spawn that surprises the team or the wallet.
- Naming convention (`role-feature`) is greppable and surfaces intent.

### What we give up
- Operator has to notice "canonical planner is backed up" manually. For active sessions that's fine (visible in `atmux status`); for cron-run teams it requires an eyeball.
- No per-specialist brief customization yet — they all get the generic role brief. If `planner-auth` needs auth-specific context, the operator has to `atmux tell-lead` it.

### What we defer
- **Auto-spawn**: revisit after we have a reliable "is canonical staff busy?" signal (see the idle-aware rotation work). Until then, operator-driven scaling is sufficient and avoids runaway teams.
- **Per-specialist briefs**: could pass a `--context <file>` flag to `add-member` in a future version to prepend feature-specific briefing.
