# tests/parity/fixtures — Zod-validated `.atmux/` factories

**Spec:** [ADR-009 §3](../../../docs/adr-bun/009-test-strategy.md) + [ADR-005 (forthcoming)](../../../docs/adr-bun/README.md).

## Purpose

Each parity test starts from a fresh `.atmux/` directory. Rather than hand-rolling JSON snippets per test (the bats approach, which produces drift between specs), the harness uses a **Zod-validated factory** that:

1. Accepts a preset name (`minimal`, `lifecycle`, `multi-team`) plus optional overrides.
2. Constructs the in-memory shape, parses through `src/schema/team.ts` + `src/schema/kanban.ts` (once ADR-005 lands; interim local copies live in `schemas.ts`).
3. Materializes the directory tree on disk: `team.json`, `kanban.json`, `inboxes/`, `logs/`, `state/`, `driver-inbox.md`.
4. Returns a `FixtureHandle = { path: string, cleanup: () => Promise<void> }`.

The bash side and TS side both read the *same* directory — that's the parity contract. The factory ensures the shape on disk is valid by both atmux's bash expectations and the forthcoming TS schemas.

## Phase 0 status

Empty placeholder. Files arrive in Phase 1 (foundation porter, after ADR-005 ratifies the schemas):

- `factory.ts` — `makeFixture({preset, overrides}) → Promise<FixtureHandle>`
- `schemas.ts` — interim Zod schemas; deleted once ADR-005's `src/schema/` is published
- `presets/minimal.ts` — 2-member team, empty kanban, no inboxes
- `presets/lifecycle.ts` — 4-member team mirroring `tests/e2e/lifecycle.bats` template (lead/reviewer/gitter/w1)
- `presets/multi-team.ts` — state shapes covering atmux/sopx-mvp/ifca_aux/unum prod state shapes for Phase 3

## Why Zod here when the production runtime already validates?

Defence in depth at the **fixture authoring** boundary. Hand-written JSON drifts; a fixture that accidentally adds a key the runtime doesn't read produces a parity test that passes for the wrong reason (bash and TS both ignore the key — divergence hidden). Parsing fixture inputs through the same schemas as runtime catches authoring errors at test-write time, not at parity-divergence time.

CLAUDE.md "verify green from the right path" applies — a parity-green run against an invalid fixture is false-green.
