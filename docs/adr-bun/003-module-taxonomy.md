# ADR-003: Module taxonomy (abstraction / core / domain)

**Status:** accepted
**Date:** 2026-05-04
**Owner:** architect

## Context

ADR-001 commits us to TS-on-Bun; ADR-002 commits us to a `src/` tree. This ADR defines **what kinds of code go where**, and how they may depend on each other.

The bash codebase has no enforced layering. Every `lib/*.sh` is sourced into a single global namespace; there is no static check that `lib/whip.sh` doesn't reach into helper variables defined deep inside `lib/discord.sh`. The result is the godfile drift documented in ADR-001 Pressure 1: `whip.sh` (1305 LOC) and `doctor.sh` (1467 LOC) accumulated responsibilities because the namespace allowed it.

The port has the chance to lock layering at the *module-import* level. TypeScript's import graph is statically analysable; reviewer can mechanically check "verb files don't import sideways from each other" or "abstractions don't import from core". This ADR defines the layers, the dependency rule, and the shape contracts (so porters know what each layer is *for*).

The taxonomy is the precondition for porter-foundation (Phase 1) starting work — they implement the abstractions + core libs, and they need the layer boundaries codified before they start writing modules.

## Decision

Three layers, top-down dependency only.

```
┌────────────────────────────────────┐
│ verbs/         (~23 modules)       │  ← domain logic, one per CLI verb
├────────────────────────────────────┤  ↓ may import from
│ core/          (4 modules)         │  ← atmux-specific reusables
├────────────────────────────────────┤  ↓ may import from
│ abstractions/  (8 modules)         │  ← pure IO wrappers
└────────────────────────────────────┘
```

**Dependency rule:** verbs → core → abstractions. Never sideways within a layer. Never upward.

- A verb may import from `src/core/*`, `src/abstractions/*`, `src/schema/*`, `src/errors`.
- A core lib may import from `src/abstractions/*`, `src/schema/*`, `src/errors`.
- An abstraction may import from `src/errors` and `node:*` / `bun:*` only. **No** `src/core/*`, **no** `src/verbs/*`, **no** `src/schema/*` (schemas describe domain shapes; abstractions are domain-blind).
- `src/schema/*` may import only from `zod` + `src/errors`. Schemas are leaf modules.
- `src/errors` is the only module everyone imports from. It has no internal dependencies beyond TS lib types.
- `src/cli.ts` imports from `src/verbs/*` (verb resolution) and `src/errors` (top-level catch). It is the only module that may dynamic-import.

Sideways imports (verb-to-verb, abstraction-to-abstraction) are forbidden. Shared helpers between verbs go to `src/core/*`; shared helpers between abstractions go either to `src/abstractions/spawn.ts` (process IO underpins everything) or to a new abstraction.

### Layer contracts

#### 1. `src/abstractions/` — pure IO wrappers

**Definition.** A wrapper around exactly one external IO surface, exposing a typed API. No knowledge of atmux concepts (no "team", "member", "verb" anywhere). Replaceable in tests with a fake; the fake has the same TypeScript signature.

**Members (8):**

| File | Wraps | Notes / ADR |
|---|---|---|
| `tmux.ts` | the `tmux` CLI | One method per subcommand bucket (ADR-004) |
| `json.ts` | parse/serialize JSON files atomically | Wraps `Bun.file().json()` + atomic write; calls into `src/schema/<file>` (ADR-005) |
| `lock.ts` | file-locking | `proper-lockfile` or `node:fs.flock` (ADR-005) |
| `fs.ts` | filesystem primitives | mkdir, rename, exists, glob — typed wrappers over `node:fs/promises` |
| `time.ts` | clock + formatters | `now()`, `formatMyt()`, `formatDuration()` (ADR-012); test-injectable `setNow` |
| `spawn.ts` | subprocess invocation | `Bun.spawn` with timeout + stderr capture (ADR-007) |
| `http.ts` | HTTP requests | thin wrapper over Bun `fetch` with retry + JSON helpers |
| `discord.ts` | Discord webhook send | Named-template enforcement + chunking (ADR-008) |

**Rules:**
- No abstraction imports another abstraction. Exception: any abstraction may import from `spawn.ts` if it shells out (e.g. `tmux.ts` uses `spawn.ts`; `discord.ts` uses `spawn.ts` to call the Discord shell script per ADR-008).
- Every external-IO failure surfaces as a typed `AtmuxError` subclass (per ADR-006). No silent swallows.
- Every method has a unit-test mirror at `tests/unit/abstractions/<name>.test.ts`.

#### 2. `src/core/` — atmux-specific reusables

**Definition.** Code that *knows about atmux concepts* (team.json, member, verb, .atmux/ root, kanban, inbox) but is *not itself a verb*. Reused by 2+ verbs.

**Members (4):**

| File | Responsibility |
|---|---|
| `common.ts` | `.atmux/` root resolution, `team.json` load+cache, env-var defaults (`ATMUX_DIR`, `ATMUX_TEAM`), member-name validation, path helpers |
| `tui.ts` | ANSI/tput helpers for status output and dashboard chrome — colour, cursor, powerline glyphs, table formatting |
| `send.ts` | shared dispatch logic for `send` / `broadcast` / `tell-lead` — the "look up member, find pane, send-keys, optional inbox append" pipeline |
| `pause.ts` | pause-flag read/write + dispatch-gate check (used by `pause`, `resume`, `dispatch`, `whip`) |

**Rules:**
- Core may use schema imports (it routinely loads and writes JSON files).
- Core may NOT import from `src/verbs/*` (would create a cycle if a verb is also using core).
- Core has no top-level state beyond cached config; functions take their dependencies as args (so tests can inject mocks).
- Every core module has a unit-test mirror.

The 4-module list is the **starting set**. ADR-002 allows new core modules over time. Rule: a new core module justifies itself only if 2+ verbs would import from it; otherwise the helper stays inside the single verb that needs it.

#### 3. `src/verbs/` — domain logic, one file per CLI verb

**Definition.** The user-visible behaviour of an atmux verb. Each file maps 1:1 to one bash `lib/<verb>.sh`.

**Verb count (23 distinct files at the v1 frozen scope):**

```
up.ts, init.ts, start.ts, stop.ts, attach.ts, status.ts,
send.ts, tell.ts, reply.ts, kanban.ts, dispatch.ts, inbox.ts, claim.ts,
report.ts, whip.ts, cost.ts, rotate.ts, handoff.ts, pause.ts,
add-member.ts, reconfigure.ts, dashboard.ts, doctor.ts
```

(7 of the 30 user-visible verbs are aliases routed at the dispatcher level: `broadcast` → `send`, `tell-lead` → `tell`, `outbox` → `reply`, `task` → `kanban`, `done` → `claim`, `rotate-lead` → `rotate`, `resume` → `pause`. Per ADR-010.)

**Mandatory shape — every verb file exports exactly:**

```ts
export default async function run(args: string[]): Promise<number>
```

`args` is the post-flag-parse positional + flag bag (the dispatcher in `src/cli.ts` parses `--help` / `--version` / global flags and hands the rest through). Return value is the process exit code; any thrown error bubbles to the top-level catch in `cli.ts`, which formats it via `src/errors` and exits non-zero.

**Rules:**
- A verb may import from `src/core/*`, `src/abstractions/*`, `src/schema/*`, `src/errors`. Nothing else.
- A verb MUST NOT import from another verb. If two verbs share logic, that logic moves to `src/core/`.
- A verb's IO surfaces (tmux, JSON file, Discord, HTTP) MUST go through abstractions. No direct `Bun.spawn`, no direct `Bun.file().text()`+`JSON.parse`, no direct `fetch`. (Reviewer enforces.)
- Every verb has unit-test mirror at `tests/unit/verbs/<verb>.test.ts` AND a parity-test entry at `tests/parity/verbs/<verb>.test.ts`.

#### 4. `src/schema/`, `src/errors` — leaves and roots

- `src/schema/<file>.ts`: one Zod schema per JSON boundary file. Exports `parse(unknown): T`, `serialize(T): string`, and the inferred TS type. Imports zod + `src/errors` only.
- `src/errors.ts`: `AtmuxError` base + tagged subclasses (per ADR-006). Imported by everyone. No incoming dependencies on app code.

### Enforcement

Reviewer's check #6 ("schema discipline") and the new layer rule are enforced by **biome's import-restriction plugin** plus a small custom lint script:

```jsonc
// biome.json — import restrictions (concept; precise syntax in skeleton task #19)
{
  "linter": {
    "rules": {
      "noRestrictedImports": [
        { "from": "src/abstractions/**", "disallow": ["src/core/**", "src/verbs/**", "src/schema/**"] },
        { "from": "src/core/**",         "disallow": ["src/verbs/**"] },
        { "from": "src/verbs/**",        "disallow": ["src/verbs/**"] }
      ]
    }
  }
}
```

The custom lint covers gaps biome can't (e.g. "no `JSON.parse` outside `src/abstractions/json.ts`", "no `new Date().toLocale*` outside `src/abstractions/time.ts`", "no `Bun.spawn` outside `src/abstractions/spawn.ts`"). It runs as part of `bun run lint`. Reviewer rejects any commit failing either gate.

## Consequences

**Positives:**

- Layer is enforced at PR time, not at architectural-discipline time. The "godfile drift" failure mode of bash atmux (Pressure 1, ADR-001) cannot recur because growth in `verbs/whip.ts` cannot reach into private state of `verbs/dispatch.ts` — the import graph forbids it.
- Reviewing a verb is mechanically simple: read the file's imports; if everything is `core/*` / `abstractions/*` / `schema/*` / `errors`, the verb is layer-correct. The verb's logic is the only thing left to argue about.
- Replacing an abstraction (e.g. swap `proper-lockfile` for hand-rolled `flock(2)`) is a one-file change. No layer above it knows.
- Test mocks slot in cleanly: a verb test imports the verb and the abstraction module, replaces the abstraction's exports with fakes, runs the verb. No test-only branches inside production code.
- v2 redesign (ADR-014) lands inside `src/verbs/` only: subcommand layouts (`src/verbs/task/{add,list,claim,done}.ts`) preserve the rule "no sideways verb imports" because each leaf still owns its own logic.

**Negatives:**

- Some logic that *would naturally live* in a verb file gets pulled into core when a second verb needs the same thing. A small migration cost during Phase 2.
- Adding a 9th abstraction (e.g. `git.ts` for the lifecycle "auto-dispatch on commit-Task" feature) requires an ADR (the foundation porter has to justify a new abstraction layer). This is intentional friction — keeps the abstraction count from drifting.
- Aliases force a choice: do we have `verbs/broadcast.ts` (file) or do we route `broadcast` to `verbs/send.ts` at the dispatcher? Decision: route at dispatcher per ADR-010. Each `src/verbs/*.ts` file is a distinct *implementation*, not a distinct *user-visible verb*.
- Static enforcement requires keeping the import-restriction config in sync as new layers/dirs are added. Reviewer's task at every layer-shaped commit.

**Follow-up tickets:**

- ADR-004 (tmux abstraction interface) — fills in the contract for `src/abstractions/tmux.ts`.
- ADR-005 (JSON + locking) — fills in `src/abstractions/json.ts` + `src/abstractions/lock.ts`.
- ADR-006 (error handling) — defines the error hierarchy that every layer throws.
- ADR-007 (spawn pattern) — defines `src/abstractions/spawn.ts`, the only place `Bun.spawn` is allowed.
- ADR-008 (Discord webhook) — defines `src/abstractions/discord.ts` named-template enforcement.
- ADR-010 (CLI dispatcher) — formalises alias routing in `src/cli.ts`.
- Skeleton task #20 — creates the directory tree + empty placeholder files matching this taxonomy.
- Reviewer task: write the custom lint script (the "no `JSON.parse` outside json.ts" check etc.).

## Alternatives considered

### A. Two layers (verbs + abstractions, no core)

Considered. Simpler. Rejected because there are real cross-verb helpers — the send/broadcast/tell-lead trio is the canonical case (all three "find member, get pane, send-keys, optionally append to inbox file"). Forcing that helper into an abstraction would require teaching `src/abstractions/` about atmux concepts (member, inbox); forcing it into one verb and importing sideways from the others would break the no-sideways rule. Core is the relief valve and earns its existence.

### B. Four layers — split abstractions into "raw IO" + "schema-aware IO"

Considered. The sub-split would be: `tmux/spawn/fs/http/time` (raw) vs. `json/lock/discord` (schema-aware in some sense). Rejected because the only thing that's actually "schema-aware" in the abstraction layer is `src/abstractions/json.ts`, and even that just receives a schema function as an argument — it doesn't know which schema. The split would be cosmetic.

### C. No layer enforcement — trust convention

Rejected. CLAUDE.md "exhaustive grep + negative-space proof" applies: the deliverable IS the enforcement. Convention without static check is what got bash atmux into godfile drift in the first place. We pay the import-restriction config cost once and get the guarantee for free thereafter.

### D. Verbs as folders from day one (`src/verbs/whip/index.ts`)

Considered for v1. Rejected because it's noise at the v1 surface (most verbs are <200 LOC and don't justify a folder). v2 (ADR-014) introduces folders only where the subcommand redesign makes them natural (`src/verbs/task/*.ts`, `src/verbs/member/*.ts`). v1 stays files-only.

### E. Use Nx / Turborepo for graph enforcement

Rejected. Heavyweight monorepo tooling for a single-binary project. Biome's import-restriction plugin + a small custom lint script gives 95% of the value at 0% of the setup tax.

## References

- PLAN.md §2 (in-scope verb count: 30 user-visible / 23 distinct files), §6.1 (porter-A vs porter-B verb split), §10 (tooling table)
- ADR-001 Pressure 1 (godfile drift, the failure this taxonomy prevents)
- ADR-002 (project layout — directory shape that holds this taxonomy)
- ADR-004, ADR-005, ADR-006, ADR-007, ADR-008 (abstraction-specific contracts)
- ADR-010 (CLI dispatcher — verb file resolution + alias routing)
- ADR-014 (v2 verb redesign — preserves this taxonomy, restructures `src/verbs/`)
- bash `bin/atmux` dispatcher (case statement at the bottom of the file) — reference for alias mapping
