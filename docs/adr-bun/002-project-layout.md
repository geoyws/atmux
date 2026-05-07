# ADR-002: Project layout

**Status:** accepted
**Date:** 2026-05-04
**Owner:** architect

## Context

ADR-001 commits us to a single-binary TypeScript-on-Bun port. Before any code lands, we need a directory layout that:

1. Isolates the port from the bash reference, which **stays in the worktree** for parity validation (PLAN.md §4.2). The bash reference is read-only input to the parity harness; deleting or moving it would break the harness.
2. Enforces ADR-003's three-layer module taxonomy (abstractions / core / verbs) by physical separation, so reviewer's "abstractions don't import from core" rule has a directory boundary to lean on.
3. Co-locates schemas with the JSON files they validate (one `src/schema/<file>.ts` per JSON boundary file).
4. Splits tests by their nature: unit tests on TS modules, e2e tests on the TS binary, parity tests comparing TS-vs-bash. Each is a distinct CI gate (PLAN.md §8) and benefits from physical separation so coverage tooling can include/exclude appropriately.
5. Keeps the CLI entry boring and predictable so `bun build --compile` produces a single-file binary without bundle-config gymnastics.
6. Supports v2's nested-subcommand redesign (ADR-014, Phase 6) without churning paths — the v2 split is verb-internal, not directory-internal.

The bash project today has `lib/*.sh` flat (27 files at frozen worktree HEAD), `tests/unit/*.bats`, `tests/e2e/lifecycle.bats`, `bin/atmux`. We deliberately do NOT mirror this layout — bash's flat namespace is one of the reasons we're porting (ADR-001 Pressure 1).

## Decision

```
.
├── bin/
│   ├── atmux              # bash binary (frozen reference, do NOT touch)
│   └── atmux-bun          # TS binary shim (single line invoking src/cli.ts)
├── lib/                   # bash sources at worktree HEAD — frozen v1 reference.
│                          # The parity harness reads from here. DO NOT delete or
│                          # move. WIP bash from /root/work/src/atmux/lib/ (main
│                          # checkout) gets ported in Phase 5; same rule applies.
├── src/                   # TS port lives here.
│   ├── cli.ts             # Top-level dispatch (per ADR-010)
│   ├── errors.ts          # AtmuxError base + tagged subclasses (per ADR-006)
│   ├── abstractions/      # Pure IO wrappers; no domain knowledge (per ADR-003)
│   │   ├── tmux.ts        # ADR-004
│   │   ├── json.ts        # ADR-005 (Zod parse/serialize at boundary)
│   │   ├── lock.ts        # ADR-005 (file-lock primitive)
│   │   ├── fs.ts
│   │   ├── time.ts        # ADR-012 (MYT formatter, duration formatter)
│   │   ├── spawn.ts       # ADR-007 (Bun.spawn wrapper)
│   │   ├── http.ts        # Bun fetch wrapper
│   │   └── discord.ts     # ADR-008 (named-template enforcement)
│   ├── core/              # atmux-specific reusables; compose abstractions
│   │   ├── common.ts      # path resolution, .atmux/ root finder, env defaults
│   │   ├── tui.ts         # tput/ANSI helpers (status output, dashboard)
│   │   ├── send.ts        # send/broadcast/tell-lead shared dispatch
│   │   └── pause.ts       # pause/resume member-gating helpers
│   ├── verbs/             # One file per CLI verb (PLAN.md §2 — 23 in-scope verbs +
│   │                      # 7 aliases routed at dispatcher level — see ADR-010)
│   │   └── (filled in Phase 2)
│   └── schema/            # One Zod schema file per JSON boundary file
│       └── (e.g. team.ts, kanban.ts, inbox.ts, cost.ts, decisions.ts)
├── tests/
│   ├── unit/              # bun:test unit specs, mirror src/ tree exactly:
│   │                      # tests/unit/abstractions/tmux.test.ts ↔ src/abstractions/tmux.ts
│   │                      # tests/unit/verbs/whip.test.ts        ↔ src/verbs/whip.ts
│   ├── e2e/               # Black-box tests against the built atmux-bun binary
│   │                      # (per-verb specs ported 1:1 from tests/unit/*.bats and
│   │                      # tests/e2e/lifecycle.bats)
│   └── parity/            # Bash-vs-TS comparator harness (PLAN.md §4.2 + §8.2)
│       ├── runner.ts      # Spawns both, semantic-diffs stdout/exit/state/discord
│       ├── fixtures/      # Zod-validated .atmux/ fixture factories
│       └── verbs/         # One spec file per verb under parity test
├── docs/
│   ├── adr/               # legacy bash ADRs (frozen at worktree HEAD)
│   └── adr-bun/           # this ADR series — port-specific
├── package.json           # Bun-managed (no pnpm/npm)
├── bunfig.toml            # Bun config (test, install, runtime)
├── tsconfig.json          # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
├── biome.json             # lint + format (one tool)
└── .github/workflows/
    └── ci.yml             # typecheck + biome + bun:test --coverage + parity gates
```

### Test path conventions

- **Mirror rule.** `tests/unit/<path>/<file>.test.ts` ↔ `src/<path>/<file>.ts`. No collision, no orphan tests, no orphan source files. CI fails if a `src/**/*.ts` file (excluding generated/barrel) has no matching `tests/unit/**/*.test.ts`. ADR-009 owns the exact regex.
- **e2e tests** are file-per-verb but run against the *built binary*, not the source modules. They live at `tests/e2e/<verb>.test.ts`. The 11-step `lifecycle.bats` becomes `tests/e2e/lifecycle.test.ts` (1× cold-start non-idempotent — ADR-009 captures the docstring template).
- **parity tests** at `tests/parity/verbs/<verb>.test.ts` invoke the comparator runner, which itself shells out to both `bin/atmux` (bash) and `bin/atmux-bun` (TS) against the same fixture and diffs results. Parity tests are gated separately from unit/e2e in CI to keep failure messages distinct.

### Why one-file-per-verb in `src/verbs/`

The bash equivalent is `lib/<verb>.sh`. We preserve the 1:1 mapping because:
- Parity testing is verb-keyed; one TS file ↔ one bash file ↔ one parity spec keeps the harness diff trivially scoped.
- ADR-014's v2 redesign collapses some verbs into subcommands (`task claim` etc.); that becomes a folder shape (`src/verbs/task/claim.ts`) without disturbing the rest.
- Reviewer's per-verb ADRs (PLAN.md §7 #015+) cite `src/verbs/<verb>.ts` directly.

Each verb file exports exactly:

```ts
export default async function run(args: string[]): Promise<number> { … }
```

Returning the exit code (per ADR-003). The dispatcher in `src/cli.ts` resolves verb → file → run.

### Why `src/` not `apps/` not flat

- `apps/` implies a monorepo with multiple deployables. atmux is one binary; an `apps/atmux/` wrapper would be ceremony for nothing.
- Flat (everything at repo root) collides with `bin/`, `lib/` (bash reference), `docs/`, `tests/`, `.github/`. `src/` is the unambiguous TS island.

### Why schemas in `src/schema/` not `src/abstractions/json.ts`

- One file per JSON boundary file. Deleting/renaming a JSON file maps cleanly to one schema file. A monolithic `schemas.ts` would tend toward the bash godfile pattern we're trying to escape.
- `src/abstractions/json.ts` is generic JSON IO (atomic write, read+parse helpers); it imports from `src/schema/` rather than embedding any specific schema. This keeps ADR-005's "no `JSON.parse` in domain" rule enforceable per-schema.

### Bash reference rule

- `lib/` (the worktree's `lib/`) is **read-only input to the parity harness**, frozen at worktree HEAD. Do not edit. Do not move. Do not import from TS code.
- WIP bash files (Phase 5) are at `/root/work/src/atmux/lib/` (main checkout, not the worktree). Phase 5 ports those at the moment Phase 5 starts (PLAN.md §5). Same read-only rule applies; Phase 5 reads, doesn't move.
- After v1 cutover (PLAN.md Phase 4), the bash binary is renamed to `atmux-legacy` *in production install paths* (`/usr/local/bin/`); the in-repo `lib/` and `bin/atmux` stay for the parity harness during the burn-in window. They are deleted in v2 closure (PLAN.md §13.2) once the legacy binary is removed.

## Consequences

**Positives:**

- Reviewer's three-layer dependency rule (ADR-003) gates by directory: `src/abstractions/` MUST NOT import from `src/core/` or `src/verbs/`; `src/core/` MUST NOT import from `src/verbs/`. Static check via biome import-restriction or a small custom lint.
- Test mirror rule lets the coverage gate name-and-shame missing tests at PR time, not in mysterious lcov gaps.
- v2 redesign (ADR-014) lands by introducing `src/verbs/<group>/<sub>.ts` folders without renaming abstractions or core. Path stability across major versions.
- `bun build --compile --target=bun src/cli.ts -o dist/atmux-bun` is the entire build command. No bundle config.
- Parity harness sits at `tests/parity/` (not `tests/e2e/parity/`) because it has a fundamentally different shape (compares two binaries) and its own CI gate.

**Negatives:**

- Mirror rule means each new abstraction module spawns a unit-test file even when there's nothing to test (e.g. a thin re-export). Mitigated by allowing `// no-test: <reason>` files (a single-line marker) which the lint accepts. Reviewer rejects `no-test` markers without a reason.
- `src/schema/` proliferation: ~10 JSON boundary files → ~10 schema files. Acceptable; one per file beats a 600-line shared file.
- Devs editing TS *and* the frozen bash reference in the same commit would violate the read-only rule by accident. Reviewer regex blocks any commit that touches `lib/*.sh` outside Phase 5 windows (gate flag in CI).

**Follow-up tickets:**

- ADR-003 (module taxonomy) — formalise the dependency rule + lint that enforces it.
- ADR-009 (test strategy) — declare the exact mirror-rule regex and the `no-test` opt-out marker.
- Reviewer rule: forbid `lib/*.sh` edits in non-Phase-5 commits (set via a CI env flag).

## Alternatives considered

### A. Flat `src/*.ts` (no abstractions/core/verbs split)

Rejected. Reproduces the bash flat-namespace problem (Pressure 1 from ADR-001). The whole point of the module taxonomy (ADR-003) is to make a typed module boundary; flattening defeats that boundary.

### B. `apps/atmux-bun/` monorepo style

Rejected. We are one binary. Pulling in monorepo ceremony (workspaces, app-level package.json, `apps/*/tsconfig.json`) costs setup tax for zero benefit at the v1 surface. If we ever ship a second binary (atmux-cockpit?), revisit then.

### C. Schemas in `src/abstractions/json/` as a folder

Considered. Symmetry argument: keep all "JSON-related" code under `src/abstractions/json/`. Rejected because schemas describe **domain shapes**, not **JSON IO mechanics**. `src/abstractions/json.ts` generic-JSON ↔ `src/schema/<file>.ts` domain-specific is a real conceptual split. Keeping them apart helps reviewer reason about layer-violation.

### D. Tests inside `src/` (vitest-style co-location: `src/foo.ts` + `src/foo.test.ts`)

Considered. Bun supports it. Trade-offs:
- Pro: easy to find tests next to source.
- Con: bundling rules complicate (must exclude `*.test.ts` from `bun build --compile`).
- Con: parity + e2e have different lifecycles than units; mixing them under `src/` muddies that distinction.
- Con: `src/` becomes the vendor of test code, which complicates the "src/ ships in the binary" framing.

Mirror layout under `tests/unit/` keeps the binary lean and the harness boundaries clear. The "find tests next to source" ergonomic win is recoverable with a small editor command (open the mirror path).

### E. Move `lib/` (the bash reference) to `bash-reference/`

Considered. Cleaner labelling. Rejected because the bash binary in `bin/atmux` resolves library paths via `dirname $0/../lib/`, which the parity harness reuses. Renaming the directory means patching every bash source's path-resolution at the worktree HEAD — which violates the "frozen reference" rule. Reviewer comment in `lib/README.md` (or banner at the top of any new file we add nearby) documents the read-only intent instead.

### F. Delete `lib/` from the worktree, run parity against the system `atmux` install

Rejected outright. Parity against a moving production binary is not parity. The whole point is that `lib/` is frozen at a known SHA. Deleting it would force the harness to depend on whatever bash atmux is installed at the moment CI runs, which is exactly the kind of false-green CLAUDE.md "verify green from the right path" warns about.

## References

- PLAN.md §4.2 (parity harness shape), §6.1 (verb split), §8 (testing strategy)
- ADR-001 (motivation for the port — Pressure 1 godfile drift drives the abstractions/core/verbs split)
- ADR-003 (module taxonomy — formalises the layered import rule that this layout enforces by directory)
- ADR-009 (test strategy — declares the mirror rule regex + `no-test` opt-out)
- ADR-010 (CLI dispatcher — verb file resolution lives there)
- ADR-014 (v2 verb redesign — preserves this layout; redesign happens within `src/verbs/`)
