# `src/schema/` — Zod schemas for JSON boundary files

One file per JSON file atmux reads or writes. Each schema:

- Exports a `z.object(...)` with `.strict()` (rejects unknown keys; schema drift surfaces immediately).
- Exports the inferred TS type (`export type X = z.infer<typeof X>`).
- Includes a `schemaVersion: z.literal(N)` discriminator for future migrations — **except for bash-shared schemas during the burn-in window; see [Burn-in compatibility](#burn-in-compatibility-bash-shared-schemas) below.**

Per [ADR-005](../../docs/adr/098-json-and-locking.md): all reads from JSON files validate via `schema.parse()`; all writes serialize values that have already been validated. `JSON.parse` is forbidden outside `src/abstractions/json.ts` — domain code reaches JSON only through this layer.

## Burn-in compatibility: bash-shared schemas

Some `.atmux/` JSON files are written by **both** the bash binary and the TS port during the burn-in window — [PLAN.md §4.1](../../PLAN.md): "Cutover policy: never delete bash until all 4 teams have run TS for 14 consecutive days with zero divergence" (≥2 weeks of side-by-side parity validation across `atmux`, `sopx-mvp`, `ifca_aux`, `unum`). Schemas that model these shared files **MUST omit `schemaVersion`** until Phase 6: bash never wrote a `schemaVersion` key, so adding one in the TS port would write a key bash never reads, making the file shape unreadable to bash and breaking parity at the worst possible moment.

**Rule.** A schema is "bash-shared" if its on-disk file is read OR written by bash atmux at the parity-target HEAD `2aadc3f`. For these schemas:

- ❌ Do **NOT** add `schemaVersion: z.literal(N)`.
- ✅ Use `.passthrough()` rather than `.strict()` if the bash side may write keys the TS port hasn't modeled yet (`team.ts` is the canonical example — operator-authored `_comment_*` keys plus Phase 2 sub-shapes the porters haven't reached).
- ✅ Document the deviation in the schema file's header comment with a precedent reference. The canonical deviation comment template lives at [`src/schema/paused.ts:8-14`](paused.ts) — paste, re-cite, and adjust the bash-side reader/writer reference for the new schema.

**Examples (bash-shared at HEAD `2aadc3f`, all omit `schemaVersion`):**

| Schema | On-disk file | Bash-side reader / writer |
|---|---|---|
| [`team.ts`](team.ts) | `.atmux/team.json` | `lib/common.sh::atmux::team_field` |
| [`paused.ts`](paused.ts) | `<atmuxDir>/state/paused.json` | `lib/pause.sh` (writes via `atmux::jq_update`) |
| `kanban.ts` *(Phase 2)* | `.atmux/kanban.json` | `lib/kanban.sh` |
| *(future: `inbox.ts`, `cost.ts`, `flags.ts`, `decisions.ts`, `lead-outbox.ts`, `driver-inbox.ts` — see Roster below)* | various under `.atmux/` | various under `lib/` |

**Carve-out direction reminder.** This rule is one-way:

| Schema kind | `schemaVersion`? | Rationale |
|---|---|---|
| Bash-shared (table above) | ❌ omit | Burn-in parity; bash never wrote it |
| **TS-only** (e.g. parity-harness fixture shapes, internal TS-side state introduced by Phase 6 v2 redesign) | ✅ include | Default rule applies; bash never reads these files |

**Phase 6 sunset.** Once bash is decommissioned at the end of [PLAN.md §4.1](../../PLAN.md)'s 4-week rollback window (≥14-day side-by-side burn-in → Phase 4 cutover → 28-day rollback hold → bash deleted), [Phase 6 / ADR-016](../../docs/adr/109-schema-version-deferred.md) introduces versioned schemas in a single coordinated commit, parallel to (not part of) the [ADR-014](../../docs/adr/107-verb-design-debt.md) v2 verb redesign that ships in the same window. At that point this carve-out is sunset — every schema becomes "TS-only" by definition, and `schemaVersion` lands across the whole tree with migrators per the [Schema version migrations](#schema-version-migrations) section below.

**References:**
- [ADR-005](../../docs/adr/098-json-and-locking.md) — JSON + locking model (source-of-truth for schema discipline; the rule this carve-out modifies for bash-shared schemas).
- [ADR-013](../../docs/adr/106-wip-bash-deferral.md) — WIP-bash deferral (sister rule for the *other* "wait for bash to decide" deferrals).
- [ADR-014](../../docs/adr/107-verb-design-debt.md) — Phase 6 v2 verb redesign. Ships in the same window as the schemaVersion rollout but does NOT author it (verb-design only; verified `grep -i "schema\|version"` → zero matches). Adjacent in timing, not source of the deferral.
- [ADR-016](../../docs/adr/109-schema-version-deferred.md) — Schema-version rollout deferred to Phase 6. Source of the schemaVersion-at-Phase-6 commitment this carve-out documents.
- [PLAN.md §4.1](../../PLAN.md) — burn-in window definition (14 consecutive days, all 4 teams, zero divergence).
- [`src/schema/paused.ts:8-14`](paused.ts) — canonical deviation comment template.
- [`src/schema/team.ts`](team.ts) — same pattern (`.passthrough()` for forward-compat with operator + Phase-2 keys).

## Roster (Phase 2, when porters land)

- `team.ts` — `.atmux/team.json`
- `kanban.ts` — `.atmux/kanban.json`
- `inbox.ts` — `.atmux/inboxes/<member>.json`
- `cost.ts` — `.atmux/cost.json`
- `flags.ts` — `.atmux/flags.md` frontmatter (if applicable)
- `decisions.ts` — `.atmux/decisions.md` entries (if applicable)
- `lead-outbox.ts` — `.atmux/lead-outbox.md` entries (if applicable)
- `driver-inbox.ts` — `.atmux/driver-inbox.md` entries (if applicable)

The exact set is finalised by porter-A in Phase 2.

## Schema version migrations

When a schema changes incompatibly, increment `schemaVersion` and add a migrator under `src/schema/migrations/<file>-vN-to-vN+1.ts`. Migrators run once on read; tested.

**Note.** The Burn-in compatibility carve-out above suspends this rule for bash-shared schemas through Phase 6 (per [ADR-016](../../docs/adr/109-schema-version-deferred.md)). After bash is decommissioned at the end of the rollback window, every schema in the tree gains a `schemaVersion: z.literal(1)` discriminator in a single coordinated commit; subsequent schema changes follow the migrator convention from that point.
