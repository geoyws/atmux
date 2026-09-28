# ADR-298: Retire the `_bot` seat and `_superbot` scheduler (supersedes ADR-285)

**Status**: accepted (operator-direct — George ordered removal; driver-shipped with adversarial self-review per the drivers-only default)
**Date**: 2026-09-28
**Driver-ref**: kb atmux t-791da4d3 (live config strip), t-e9e1168d (seat removal, commit `ef28329a`), t-67f9a21d (superbot removal, commit `afd121f3`), t-9024d2fa (this ADR + doc cleanup)
**Supersedes**: [ADR-285](285-cooperative-bot-seat-and-superbot-offer-protocol.SUPERSEDED.md)
**Relates**: [ADR-239](239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) (send-keys ban revoked 2026-09-08 — see below), [ADR-287](287-canonical-cockpit-nesting-and-drivers-only-roster.md) (template passages now stale — see Stale-passage register), [ADR-279](279-declarative-operator-cockpit-windows.md) (cockpit ordering passages), [ADR-296](296-per-team-superdriver-window-before-driver.md) (current window order)

## Context

ADR-285 (2026-08-28) built a cooperative `_bot` seat per team plus a cockpit `_superbot` scheduler offering Kanban work on a 30-minute loop. Three developments dissolved its premise:

1. **Send-keys ban revoked (2026-09-08).** The `_bot` seat existed partly because drivers could not receive automated input; with the ban revoked and `/pane-agent` delivery, the operator-typing refuge `_bot` provided is no longer load-bearing.
2. **Planner→executor hand-off (2026-09-28).** Lane coordination moved to queued pane-agent pointers off board rows; no scheduler offers work into cages.
3. **Zero live use measured (2026-09-28).** Every live `bot` block found (four team.json files across `@@mbp`, none on `@@hax`) was `enabled: false` with no worktree; no `_bot` windows, no `*-bot` branches, no `superbot` cockpit blocks on either host. Nothing ever ran.

## Decision

### D1 — Supersede ADR-285, keep it readable

ADR-285 is marked superseded (status line + `.SUPERSEDED.md` rename per the ADR-052/286 precedent) and retained for trace. Its migration plan (`docs/migrations/285-superbot-fleet-plan.{md,json}`) is deleted with the code — it described an activation that will never happen.

### D2 — Code removal (landed before this ADR)

- t-e9e1168d (`ef28329a`): `bot hold|resume` verb, `start` step 7b + worktree provisioning, seat-only `core/bot.ts` exports, doctor `bot:config` check, help lines, template block + brief, seat tests. No shim.
- t-67f9a21d (`afd121f3`): `superbot run|tick` verb, routing/offer/cooldown/singleton-lock, cockpit window placement, fleet adapter, render script, migration files, their tests — plus the then-orphaned `team.json::bot` schema block, `TeamBot`, and the rest of `core/bot.ts`.
- Stale `superbot` blocks in live cockpit.json files parse harmlessly (top-level `.passthrough()`); legacy `_superbot` windows fall into orphan-prune. Live `bot` blocks were stripped first (t-791da4d3) so strict `Team` parsing never trips on them.

### D3 — Stale-passage register (append-only ADRs are NOT rewritten)

The following passages in accepted ADRs describe removed behavior. They stand as history; this register is the current truth:

- ADR-287 §D-bullets (~lines 109, 114): the shipped template no longer carries a `bot` block and `atmux init` renders none; "`bot.claudeAccount`" stamping notes are void.
- ADR-239 / ADR-279 window-order passages naming `_bot` / `_superbot`: current order is superdriver → drivers → members/services (cockpit: `_superdriver`, `_medic`, operator windows, team viewers — ADR-296).
- ADR-285 body itself: all of it (superseded).

### D4 — Docs follow the code in the same change

ARCHITECTURE.md, PRD.md, RUNBOOK-cockpit.md drop live-behavior descriptions of both seats (table rows, roster sections, the runbook's held-role section); CHANGELOG.md gains a removal entry (old entries stand — changelog is history). The dated review `docs/reviews/2026-09-01-1239-quality.md` is a point-in-time snapshot and is left untouched; its superbot baseline notes are stale by this ADR.

## Consequences

- `atmux bot ...` and `atmux superbot ...` are unknown verbs via the default path. Any script, cron, or runbook invoking them fails loudly — that is intended (no silent no-op).
- A future automation seat is a new ADR, not a revert: the worktree/branch/lock machinery was deleted, not disabled.
- `team.json` files carrying a `bot` block now fail strict validation — the pre-removal strip (t-791da4d3) plus this ADR's D2 ordering note are the reason no live cage trips on it.
