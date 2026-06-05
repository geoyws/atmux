# ADR-207: Opus-sentinel supersedes cursor-sentinel — rolls back ADR-132 §D1 cursor backend per ADR-201 rejection

> **⚠ SUPERSEDED by [ADR-211](211-retire-sentinel-role-distribute-to-honker-consumers.md) — 2026-05-23. Read ADR-211 instead; this file is kept for trace only.**

**Status**: Superseded by e-be01fc89 (sentinel deleted 2026-05-23 — Opus-sentinel impl-EPIC never ships per ADR-211 retire-sentinel; supersedence reason: sentinel role itself retires before this swap could land). Was: Accepted — ratified by driver 2026-05-21 (Opus-sentinel rolls back ADR-132 §D1 cursor backend; pluggable abstraction §D2 preserved; Zod transform shim for legacy `team.json::sentinel.name: "cursor"` migration with one-release deprecation grace; doctor probe surfaces config drift; ADR-140 burn-reduction projection forfeited at sentinel tier — Honker substrate ADR-202 is the replacement cost mitigation, NOT a model swap; adversarial-LLM-diversity now lives in role separation (planner/reviewer/jury/gitter different prompts + briefs) not model separation; sequencing constraint observed — substrate + sentinel-eventized EPIC before cursor.ts deletion; §OQ recommendations as-written). Runtime side already deployed 2026-05-21: `~/.atmux/cockpit.json::sentinel.impl` flipped cursor→claude + `enabled: false`; 4 IFCA team.json cursor members flipped to claude in same operator session.
**Date**: 2026-05-21
**Driver-ref**: 2026-05-21 ADR-201 rejection note — *"REMOVE cursor in favor of Opus across atmux — not just decline to add at member tier, but unwind cursor at sentinel (ADR-132) + cancel forthcoming jury cursor path. Reasoning: adversarial-LLM-diversity reframe is overridden by operator preference for Opus consistency across the chain."*
**Supersedes (in part)**: [ADR-132](132-pluggable-martinet.SUPERSEDED.md) §D1 (Cursor as the production Sentinel impl). Pluggable abstraction stays; cursor backend is rolled back. ADR-132 status remains `Accepted` (the architectural decision to make Sentinel pluggable was sound); this ADR narrows the impl set.
**Cross-refs**: [ADR-132](132-pluggable-martinet.SUPERSEDED.md) (pluggable Sentinel abstraction this narrows), [ADR-158](158-martinet-to-sentinel-rename.SUPERSEDED.md) (martinet → sentinel rename), [ADR-140](140-cheap-model-first.md) (cheap-model-first principle this partially walks back), [ADR-201](201-cursor-cli-composer-25-as-first-class-member-tui.md) §Status (the rejection note that triggered this supersession), [ADR-204](204-jury-role-acceptance-criteria-contract.SUPERSEDED.md) §Amendment 2026-05-21 (sibling rollback for `_jury`), memory `feedback_opus_all_for_agile_flow` (operator stance — refreshed 2026-05-21 in the same commit set).

## Context

ADR-132 (2026-05-14, accepted 2026-05-15) introduced a **pluggable Sentinel abstraction** at cockpit window W3. The abstraction is sound: observation/nudging work is offloaded from the Claude lead's per-team whip cycle to a long-running cockpit-level role; the Claude lead retains exclusive authority over judgment-class decisions via the §D5 escalation gate.

ADR-132 §D1 named **two production impls** for the abstraction:
1. **`cursor`** — `cursor composer-2-fast` as the primary Sentinel impl. Cheap, fast, observation-tier work.
2. **`claude`** — degenerate fallback (Claude Opus). Used when cursor is unavailable.

The cursor backend was the **default** — cheaper, faster, in line with ADR-140's cheap-model-first principle for observation/judgment work outside the agile chain.

On 2026-05-21 the operator rejected ADR-201 (cursor-cli composer-2.5 as first-class member TUI) with the explicit direction to **remove cursor from atmux entirely** — not just decline to add it at the member tier, but unwind it at the cockpit observation tier as well. Per the rejection note and memory `feedback_opus_all_for_agile_flow` 2026-05-21 reaffirmation: the adversarial-LLM-diversity reframe (which briefly justified cursor at member + jury) is overridden by the operator's preference for Opus consistency across every tier (member, sentinel, jury).

ADR-132's `cursor`-named backend is the one explicitly called out in the rejection note. This ADR closes that loop.

## Decision

### D1 — Opus becomes the only Sentinel backend

The Sentinel abstraction's `name` field constraint changes from `z.enum(["cursor", "claude"])` (per ADR-132 §T5 schema) to `z.enum(["claude"])` (one-impl set).

- **`src/abstractions/sentinels/cursor.ts`** — DELETE in the impl-EPIC. Existing tests that exercise it (`tests/unit/abstractions/sentinels/cursor.test.ts` if present) move to a deprecation-grace folder for one release, then deletion in the cleanup-EPIC.
- **`src/abstractions/sentinels/claude.ts`** — was previously the degenerate fallback; becomes the only production impl. Operator-facing brief stays the same observation/nudging shape; only the LLM driving the pane changes.
- **`src/schema/team.ts::TeamSentinel`** — enum narrows; old `team.json::sentinel: { name: "cursor" }` configs are migrated via a Zod `.transform()` shim that rewrites to `name: "claude"` + emits a deprecation warning. One release of grace; cleanup-EPIC removes the shim.
- **`src/schema/cockpit.ts::Cockpit::defaultSentinel`** — same narrowing + transform shim.

### D2 — Pluggable abstraction preserved (not rolled back)

ADR-132's core architectural decision (Sentinel as a pluggable role, decoupled from any specific LLM CLI) stays. The interface contract in `src/abstractions/sentinel.ts` is unchanged. Future LLM backends can be re-added by widening the enum without touching the abstraction. This ADR only narrows the **shipping impl set**, not the **abstraction shape**.

Rationale: rolling back the abstraction entirely would lose the migration path back to a non-Claude backend if operator stance shifts again. The plug remains; the plugged-in cursor backend is removed.

### D3 — Cost trade-off explicit

ADR-140 (cheap-model-first principle) projected ~65-70% Claude-burn reduction from offloading observation loops to cheaper models. Rolling back cursor means **most of that projected savings is forfeited** at the cockpit observation tier:

- Sentinel ticks now consume Opus + xhigh effort per tick.
- Per-team observation loops × fleet teams × tick cadence = Claude budget consumption.
- The Honker substrate (ADR-202 + ADR-203 + ADR-204) is the alternative cost mitigation — observation loops disappear entirely once consumers go event-driven, not because the model became cheaper but because the wake itself becomes near-zero-cost (~1ms p50 from PRAGMA data_version polling). The substrate work continues per the queued EPIC sequence.

The operator's stated cost-vs-quality trade-off: judgment consistency (Opus everywhere) is worth more than burn reduction at observation tier. Documented for future cost reviews.

### D4 — Doctor probe drift detection

Add a doctor row that detects `team.json::sentinel.name === "cursor"` (legacy config) and surfaces a yellow row with the migration hint:

```
yellow  sentinel-config  team uses legacy `sentinel.name: "cursor"` (per ADR-132 §D1)
                         hint: ADR-207 supersedes — change to `name: "claude"` or remove (default is "claude")
                         migration shim writes new value on next atmux start
```

Survives one release alongside the Zod transform shim; removed in the cleanup-EPIC.

### D5 — Memory + brief sweep

Memories and briefs that reference cursor-sentinel:
- `project_martinet_pattern` — update with 2026-05-21 supersession note pointing here.
- `project_sentinel_rename_adr_158` — same.
- `project_cheap_model_first_adr_140` — annotate that the projection no longer holds for sentinel tier.
- `templates/briefs/sentinel.md` (if present) — drop cursor-specific operator hints.

These are documentation sweeps; not a Zod-schema decision. Memory file refresh + brief edit handled in the impl-EPIC.

## Consequences

**Becomes easier:**

- Single judgment-quality bar across all tiers (member + sentinel + jury all Opus + xhigh).
- Fewer LLM-specific code paths — no separate cursor-pane verifiers, no cursor-account abstraction, no cursor-CLI flag-drift tracking.
- Memory drift between operator stance ("Opus all the way") and codebase reality closes.
- Operator mental model simplifies — one LLM, one set of permissions, one set of patterns.

**Becomes harder:**

- Claude-burn at cockpit observation tier rises. Mitigation: Honker substrate (ADR-202) eliminates most observation loops entirely, recovering the cost savings via architectural change rather than model substitution.
- Adversarial-LLM-diversity (the briefly-considered reframe) loses one of its anchors. Mitigation per ADR-204 §Amendment 2026-05-21: diversity now lives in **role separation** (planner / reviewer / jury / gitter different prompts + briefs) not **model separation**.
- ADR-132 ships with a one-impl pluggable abstraction — looks like over-engineering. Mitigation: preserve the pluggability for future re-addition without re-arguing the abstraction.
- One-release deprecation grace requires brief warning bookkeeping; cleanup-EPIC must remove the shim or it lingers.

**Risks + mitigations:**

- **Risk**: Existing cockpits with `sentinel.name: "cursor"` boot into a broken state after the impl-EPIC ships (cursor.ts deleted; transform shim missing on first run). **Mitigation**: Zod transform shim lands BEFORE cursor.ts deletion; one release between them; doctor probe surfaces drift in the gap.
- **Risk**: Operator changes stance again and wants cursor back. **Mitigation**: pluggable abstraction preserved per §D2; widening the enum + restoring cursor.ts is a single ADR away.
- **Risk**: Claude budget exhaustion at cockpit tier without Honker substrate landing first. **Mitigation**: substrate work prioritizes consumer EPICs that eliminate the heaviest observation loops (e-honker-sentinel + e-honker-medic) before this rollback ships. Sequencing matters: substrate → sentinel-eventized → THEN cursor rollback.

## Out of scope (deferred)

- **Re-adding cursor (or any non-Claude backend)** — requires a separate ADR. The pluggable abstraction makes this a one-ADR + one-impl-EPIC addition; no architectural debate needed at the abstraction layer.
- **Auto-detection of `_jury` config drift** — ADR-204's §Amendment 2026-05-21 reviewer surface handles the equivalent at the jury layer.
- **Cost analysis of the rolled-back cheap-model-first principle** — separate ADR-140 amendment when burn data is available post-substrate landing.

## References

- ADR-132 — pluggable Sentinel abstraction (this ADR narrows §D1 impl set; §D2 abstraction preserved)
- ADR-201 — cursor-cli composer-2.5 first-class member TUI (Status: Rejected — the rejection note triggered this supersession)
- ADR-204 §Amendment 2026-05-21 — sibling rollback for `_jury` (cursor → Opus)
- ADR-140 — cheap-model-first principle (partial walk-back at sentinel tier)
- ADR-158 — martinet → sentinel rename (terminology only)
- ADR-202 — Honker substrate (the cost mitigation that replaces cheap-model-first at the observation tier)
- memory `feedback_opus_all_for_agile_flow` — refreshed 2026-05-21 with the reaffirmation date
- memory `project_martinet_pattern` — pluggable abstraction context (needs sweep per §D5)
- memory `project_sentinel_rename_adr_158` — same
- memory `project_cheap_model_first_adr_140` — same
