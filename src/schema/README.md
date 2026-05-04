# `src/schema/` — Zod schemas for JSON boundary files

One file per JSON file atmux reads or writes. Each schema:

- Exports a `z.object(...)` with `.strict()` (rejects unknown keys; schema drift surfaces immediately).
- Exports the inferred TS type (`export type X = z.infer<typeof X>`).
- Includes a `schemaVersion: z.literal(N)` discriminator for future migrations.

Per [ADR-005](../../docs/adr-bun/005-json-and-locking.md): all reads from JSON files validate via `schema.parse()`; all writes serialize values that have already been validated. `JSON.parse` is forbidden outside `src/abstractions/json.ts` — domain code reaches JSON only through this layer.

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
