# ADR-089: Hierarchical cockpit — recursive `sessions[]` + nested tmux prefix chain

**Status**: Accepted (2026-05-15, operator-batch-flip)
**Date**: 2026-05-13
**Driver-ref**: `.atmux/driver-inbox.md` 14:03 MYT 2026-05-13 §Pillar 1+2 (lines 2986-3032).
**Parent Task**: t-e576dd43. **Authored under**: t-5e7a6631 (ADR seq 3/6, DRAFT only).
**Numbering shift**: this ADR is the **+1 shift** of driver-inbox's §ADR-088 hierarchical-cockpit ask, bumped to avoid collision with the live **ADR-086** (atmux-pulse, already shipped). The full shift is `driver-inbox §ADR-086→087, §ADR-087→088, §ADR-088→089 (this), §ADR-089→090, §ADR-090→091, §ADR-091→092`. Future readers MUST cross-reference using the shifted IDs, not the original driver-inbox numbering.
**Reviewer pre-flag**: `.atmux/reviewer-preflag-ADR089-091.md` (signed 2026-05-13). Adjacent-class audit: `.atmux/audits/adr-089-091-adjacent-class-2026-05-13.md` (Class 2 F-key rebinding). All 7 §Decision-anchors + 3 Class-2 recommendations folded into §Decision below.

## Context

### Current state — flat cockpit roster

`src/schema/cockpit.ts:117-127` defines `Cockpit.teams: CockpitTeam[]` — a flat array, one entry per participating team. Window order in tmux follows `teams[]` order. The schema works for the current "cockpit + N teams" topology (one cockpit, sibling teams) but has **no representation for nesting** — no team can host its own sub-cockpit; an **epic-team** (per the queued [ADR-090](090-epic-team-lifecycle.md)) has nowhere structural to live except as a peer of its parent.

### Why nesting matters now

Demo-week 2026-05-13 surfaced four concrete asks that need nesting:

1. **Epic-teams** (queued [ADR-090](090-epic-team-lifecycle.md)) — ephemeral sub-teams under a parent team, sharing a single worktree but with their own kanban + lead. The lifecycle requires a parent → child cockpit relationship that today's flat schema can't express.
2. **Auto-merge state machine** (queued [ADR-091](091-kanban-driven-auto-merge.md)) — cron walks the tree, fires `git merge` per merged-state epic. Without a tree, the walker enumerates only sibling teams.
3. **Cross-team `tell-lead`** (queued [ADR-092](092-cross-team-tell-lead.md)) — needs a parent-team lookup so a child can route a message up the chain.
4. **Superdoctor + superdriver** ([ADR-077](077-superdoctor-cockpit-role.md)) — already nested *behaviourally* (window 1 superdriver, window 2 superdoctor, windows 3+ per-team viewers) but represented in the schema as **opt-in singleton fields** rather than first-class tree nodes. As the cockpit grows beyond 2 super-roles, the singleton pattern doesn't scale.

### Tmux prefix chain — the second pillar

Operator George runs cockpit + nested teams on **ghostty + host tmux** with prefix `C-a`. Inside each team's cage, atmux runs **another tmux server** (per-team socket, ADR-018) — collisions today are avoided because the inner tmux uses `C-b` (default) or operator-rebound prefix. Adding epic-teams means a **third nested tmux server**, and a fourth (super-cockpit aggregating multiple cockpits) is foreseeable. Need a deterministic prefix-chain rule operators can set once and forget.

## Decision

Seven §Decision-anchor lines, then prose around each. Pre-flag references map back to the reviewer-preflag doc cited in the header.

> **§Decision-anchor #1** — Introduce `Cockpit.schemaVersion: z.number().int().default(1)` (pre-flag #1). Shim reads missing/undefined as **v0**, lifts to single-level `sessions[]`; **v1** = recursive native; **v2+** drops shim.
>
> **§Decision-anchor #2** — Use `z.discriminatedUnion("type", [...])` for session subtypes, NOT `z.union` (pre-flag #2). Subtypes: `team` / `epic-team` / `superdriver` / `superdoctor`. This is the **first discriminated union in the repo** (`rg -n discriminatedUnion src/schema` → 0 today); flag as canonical pattern.
>
> **§Decision-anchor #3** — Preserve `.strict()` at the leaf-object level (pre-flag #3, mirrors ADR-054 §D3). Top-level `Cockpit` stays `.passthrough()` per existing `cockpit.ts:127` pattern.
>
> **§Decision-anchor #4** — Validate `prefixChain` at `loadCockpit`: BOTH length ≥ max-depth AND uniqueness (pre-flag #4). `["F1","F2","F2"]` is refused (key collision when both visible).
>
> **§Decision-anchor #5** — `ATMUX_NESTING_LEVEL` is **reset at cage entry**, not propagated (pre-flag #5). `start.ts` / `spawn-epic.ts` UNSET inherited value, then export own level. Prevents L3 → L4 confusion in tmux.conf generation.
>
> **§Decision-anchor #6** — Validate against cycles: cap `loadCockpit` max-depth at **6** (L1-L4 reserved + 2 headroom) (pre-flag #7). Tree is acyclic by construction, but config-authoring error could create a cycle; cheap defensive cap.
>
> **§Decision-anchor #7** — F-keys are **orthogonal to tmux's default `C-a` / `C-b` prefixes** (Class-2 audit Rec 3). Host tmux + cockpit + team + epic-team chain unambiguously. Auto-detect heuristic + fallback chain documented below.

### (A) Recursive `sessions[]` schema (§Pillar 1)

`Cockpit.teams: CockpitTeam[]` is **replaced** by `Cockpit.sessions: CockpitSession[]` where `CockpitSession` is a discriminated union:

```ts
const CockpitSessionBase = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  prefixChain: z.array(z.string()).optional(),  // override-only; default computed
  claudeAccount: CockpitClaudeAccount.optional(),
  tuiOverrides: CockpitTuiOverrides.optional(),
});

const TeamSession = CockpitSessionBase.extend({
  type: z.literal("team"),
  sessions: z.array(z.lazy(() => CockpitSession)).default([]),  // children
}).strict();

const EpicTeamSession = CockpitSessionBase.extend({
  type: z.literal("epic-team"),
  parent: z.string().min(1),       // parent team name (validated as resolvable)
  epicId: z.string().min(1),       // links back to kanban.epics[].id
  sessions: z.array(z.lazy(() => CockpitSession)).default([]),
}).strict();

const SuperdriverSession = CockpitSessionBase.extend({
  type: z.literal("superdriver"),
}).strict();

const SuperdoctorSession = CockpitSessionBase.extend({
  type: z.literal("superdoctor"),
}).strict();

const CockpitSession = z.discriminatedUnion("type", [
  TeamSession, EpicTeamSession, SuperdriverSession, SuperdoctorSession,
]);

const Cockpit = z.object({
  schemaVersion: z.number().int().default(1),       // §Decision-anchor #1
  sessions: z.array(CockpitSession).default([]),
  prefixChain: z.array(z.string()).optional(),
  // existing top-level fields preserved …
}).passthrough();
```

Example JSONC for a cockpit with one team that has one in-flight epic-team:

```jsonc
{
  "schemaVersion": 1,
  "prefixChain": ["F1", "F2", "F3"],
  "sessions": [
    { "type": "superdriver", "name": "superdriver" },
    { "type": "superdoctor", "name": "superdoctor" },
    {
      "type": "team",
      "name": "sopx-guild",
      "sessions": [
        {
          "type": "epic-team",
          "name": "sopx-deferred-cleanup",
          "parent": "sopx-guild",
          "epicId": "e-9c2f4a8b"
        }
      ]
    }
  ]
}
```

**Cockpit walk** is depth-first; window order matches DFS traversal. Nesting is **unbounded by the schema**, capped at runtime by `loadCockpit` max-depth (§Decision-anchor #6).

### (B) Migration shim — flat → recursive

`loadCockpit` reads `schemaVersion` per §Decision-anchor #1:

- `schemaVersion` missing or `=== undefined` → treat as **v0**: lift `teams[]` into `sessions[]` as single-level `TeamSession[]` entries, default `sessions: []` per child. Singleton fields `superdriver` / `superdoctor` are lifted into top-level `sessions[]` as their own discriminated entries.
- `schemaVersion === 1` → recursive native. No lift.
- `schemaVersion >= 2` → reserved; shim drops in v2+ releases.

**Shim lifetime**: one release cycle. **Removed in the v2 schema bump**, which is a separate ADR. Until then, both flat-legacy and recursive-native cockpit.json files parse cleanly.

Operators can flip an existing cockpit by adding `"schemaVersion": 1` + restructuring `teams[]` → `sessions[]`. `atmux cockpit migrate` is **not** added in this ADR — operators edit cockpit.json by hand; the shim is the migration path.

### (C) F-key prefix chain (§Pillar 2)

Default chain per nesting level:

| Level | Owner | Prefix | Notes |
|---|---|---|---|
| L0 | Host tmux | `C-a` | Operator-bound; atmux never rebinds |
| L1 | Cockpit tmux server | `F1` | Default; override via `cockpit.prefixChain[0]` |
| L2 | Team tmux server | `F2` | Default; override via `cockpit.prefixChain[1]` |
| L3 | Epic-team tmux server | `F3` | Default; override via `cockpit.prefixChain[2]` |
| L4+ | Reserved | F4-F12 | Future use (super-cockpit, multi-epic chains) |

**Operator override** via `cockpit.prefixChain: ["F1","F2","F3"]` or `["C-q","C-w","C-e"]` (Ctrl-letter for mobile, see fallback below). Validation at `loadCockpit` per §Decision-anchor #4: length ≥ max-depth AND uniqueness.

#### Auto-detect heuristic (Class-2 audit Rec 1)

`loadCockpit` sniffs `TERM_PROGRAM` + `LC_TERMINAL` env vars at boot:

```ts
function suggestPrefixChain(env: NodeJS.ProcessEnv): string[] | null {
  const tp = env.TERM_PROGRAM ?? "";
  const lc = env.LC_TERMINAL ?? "";
  if ((tp === "iTerm.app" && lc === "iTerm2-CC") || /Termius|Blink/i.test(tp)) {
    return ["C-q", "C-w", "C-e"];
  }
  return null;  // F-keys default applies
}
```

If `cockpit.prefixChain` is unset AND the heuristic returns a suggestion, `loadCockpit` emits a **warning** (not refuse): `"cockpit.prefixChain unset; on this terminal F-keys may be modal — suggested: ['C-q','C-w','C-e']"`. Operator chooses to set the field or ignore. Refusal at load-time is over-protective; warnings preserve operator agency.

#### Fallback chain (Class-2 audit Rec 2)

| Topology | Default chain |
|---|---|
| Default desktop (ghostty/iTerm2 raw/Apple Terminal/Alacritty/Kitty/Wezterm) | `["F1","F2","F3"]` |
| Mobile / iTerm2-CC | `["C-q","C-w","C-e"]` |
| Heavy-tmux topology (host tmux + nested chain) | `["F1","F2","F3"]` (orthogonal to C-a) |

Operator picks once at cockpit setup; documented in **`docs/RUNBOOK-cockpit.md`** (new doc — same commit as ADR-089 impl Task per docs-discipline, NOT this draft commit).

#### Orthogonality statement (Class-2 audit Rec 3)

**F-keys are orthogonal to tmux's default `C-a` / `C-b` prefixes.** Host tmux (L0, `C-a`) + cockpit (L1, `F1`) + team (L2, `F2`) + epic-team (L3, `F3`) chain unambiguously — no key collides with the others. This is a structural property of the chosen default, not coincidence.

### (D) `ATMUX_NESTING_LEVEL` env contract

Verbs read `ATMUX_NESTING_LEVEL` (integer, 1-indexed); missing → default `1`. Used in tmux.conf generation to pick the right prefix from `cockpit.prefixChain`.

**Propagation rule** (§Decision-anchor #5): at cage entry (`src/verbs/start.ts`, `src/verbs/team/spawn-epic.ts`):

```bash
# Child cage entry:
unset ATMUX_NESTING_LEVEL
export ATMUX_NESTING_LEVEL=<computed-own-level>
```

Computed level is `parent.ATMUX_NESTING_LEVEL + 1` (or `1` for cockpit-spawned root teams). The UNSET-then-set discipline ensures child processes inside the cage inherit the child's level, not the parent's.

### (E) Nested tmpdir

Child cage tmpdir nests under parent's:

- Parent team: `/tmp/atmux-<team>/sock` (existing per ADR-018).
- Epic-team child: `/tmp/atmux-<team>/epics/<epicId>/sock`.
- Further nesting: `/tmp/atmux-<team>/epics/<epicId>/epics/<grandchildId>/sock` (extensible).

`team.tmuxTmpdir` field can override per-team; default behaviour computes the nested path from the parent's tmpdir + epicId.

### (F) `enabledTeams` flattener for legacy callers

Existing verbs that iterate `cockpit.teams.filter(t => t.enabled)` get a compatibility helper:

```ts
function flattenEnabledTeams(cockpit: Cockpit): TeamSession[] {
  // DFS traversal, filter type === "team" && enabled === true.
  // Used by callers not yet migrated to recursive walk.
}
```

Lifetime: until every caller is migrated to recursive walk (covered by the implementation Tasks T4/T5/T6); then removed. Deprecation marker on the function so reviewer can grep for stragglers at v2-bump time.

### (G) Schema invariants (§Decision-anchor #3)

- All `*Session` leaf objects use `.strict()` per ADR-054 §D3 drift-detection rule.
- Top-level `Cockpit` uses `.passthrough()` per existing `cockpit.ts:127` pattern.
- `schemaVersion` is `.default(1)` so legacy files (missing the field) flow through the shim path.

### (H) Max-depth cap (§Decision-anchor #6)

`loadCockpit` refuses cockpit.json files with tree depth > 6. Computation: DFS, track max depth seen, throw `UsageError` on overshoot. Acyclic-by-construction is preserved; the cap defends against config-authoring errors that introduce cycles (e.g. `sessionA.parent === "sessionB" && sessionB.parent === "sessionA"` is structurally impossible in this schema, but a copy-paste loop in `sessions[]` nesting is possible). Cap of 6 covers L1-L4 reserved + 2 headroom.

## Adjacent classes

### `ATMUX_CALLER_SCOPE` leak across cage boundaries (pre-flag #6)

Same root cause as §Decision-anchor #5: `ATMUX_CALLER_SCOPE=driver` (`src/core/common.ts:603-606`) is env-only. An epic-team's driver pane would inherit parent's `driver` status — but parent's driver is the only legit driver for parent-scoped operations.

**Decision**: cage-entry **also resets `ATMUX_CALLER_SCOPE`** alongside `ATMUX_NESTING_LEVEL`. Child cage's `start.ts` runs:

```bash
unset ATMUX_NESTING_LEVEL ATMUX_CALLER_SCOPE
export ATMUX_NESTING_LEVEL=<computed>
export ATMUX_CALLER_SCOPE=<role-resolved-for-child>  # driver / member / lead / etc
```

This bleeds into [ADR-092](092-cross-team-tell-lead.md)'s caller-scope-gate design — the gate must read the child's `ATMUX_CALLER_SCOPE`, not the parent's. ADR-092 cites this resolution.

### Class-2 audit — F-key rebinding on mobile/iTerm2-CC

Covered by §Decision (C) auto-detect + fallback chain. The 12-row compat matrix is the audit's deliverable; reproduced in `docs/RUNBOOK-cockpit.md` (new doc landed alongside impl T5).

## Compat matrix (Class-2 audit, 12 rows)

| Terminal | F-key default | Atmux concern | Mitigation |
|---|---|---|---|
| ghostty | passthrough | none | n/a (G's daily driver) |
| Apple Terminal | passthrough | none | n/a |
| iTerm2 (raw) | passthrough | none | n/a |
| iTerm2-CC | tmux-integration renders native | F-prefix chain unverified in CC mode | `cockpit.prefixChain: ["C-q","C-w","C-e"]` |
| Alacritty | passthrough | none | n/a |
| Kitty | passthrough; per-user rebind possible | per-user config could rebind F1-F12 | operator override via `cockpit.prefixChain` |
| Wezterm | passthrough | none | n/a |
| mosh | passthrough (wraps SSH terminfo) | none | n/a |
| Termius (iOS) | software keyboard, modal | F-keys often need modifier press | `["C-q","C-w","C-e"]` fallback |
| Blink (iOS) | per-keyboard config | same as Termius | same |
| tmux-on-tmux nested | host C-a + nested F-keys | no collision (orthogonal) | n/a — design strength |
| screen-on-screen | rare; host C-a; nested F-keys | no collision (orthogonal) | n/a |

## Consequences

- **Migration**: one release cycle of dual-shape support (v0 flat + v1 recursive). No flag day. Existing cockpit.json files keep loading via the shim.
- **Behaviour change at default**: cockpit window order is now DFS through `sessions[]` (was `teams[]` order). For flat-shaped configs lifted by the shim, window order is preserved (single-level DFS = sibling iteration).
- **Reviewer-gate**: this ADR introduces the **first** `z.discriminatedUnion` in `src/schema/` (`rg -n discriminatedUnion src/schema` → 0 today, 1 after impl). Flag as canonical pattern for any future polymorphic schema.
- **Test surface**: impl Tasks T4/T5/T6 (separate filings) own the test work. Coverage targets: loadCockpit migration shim happy-path + v0-flat-with-superdriver-singleton + v1-recursive + max-depth refuse + prefixChain length/uniqueness refuse + auto-detect heuristic + cage-entry env-unset.
- **Reversibility**: schema additions are additive (new fields, opt-in defaults). Reverting drops `schemaVersion` + `sessions[]` and re-instates `teams[]`. Migration shim covers both directions during the release-cycle window.
- **Cross-ADR coupling**: ADR-090 (epic-team lifecycle) consumes `EpicTeamSession`. ADR-091 (auto-merge) walks the tree via `flattenEnabledTeams` + the recursive walker. ADR-092 (cross-team tell-lead) reads `parent` field for upward routing. All three depend on this ADR landing first.

## Open questions

- **OQ-1**: Should `flattenEnabledTeams` remain forever (legacy compat) OR get deprecated at v2-bump? **Resolved default**: deprecate at v2-bump. Mark with `/** @deprecated remove at v2 schema bump */` JSDoc tag at impl time so reviewer-grep picks it up. Driver may override via `atmux decisions add`.
- **OQ-2**: Should the auto-detect heuristic in §C **refuse** (not warn) when iTerm2-CC is detected? **Resolved default**: warn, don't refuse. Operator agency wins; refusing on heuristic match is over-aggressive (the heuristic can have false positives — `TERM_PROGRAM` is set by tooling, not always accurate).
- **OQ-3**: Should `ATMUX_CALLER_SCOPE` reset cascade to all atmux env vars (`ATMUX_MEMBER`, `ATMUX_TEAM`, etc.) at cage entry? **Resolved default**: yes — cage entry is the clean boundary. Document the full unset list in the impl Task body.

## Cross-references

- `.atmux/driver-inbox.md` 14:03 MYT 2026-05-13 §Pillar 1+2 (original ask).
- `.atmux/reviewer-preflag-ADR089-091.md` (signed 2026-05-13) — 7 §Decision-anchors lifted from §ADR-089.
- `.atmux/audits/adr-089-091-adjacent-class-2026-05-13.md` §Class 2 — F-key rebinding compat matrix + auto-detect heuristic.
- [ADR-018](018-per-team-tmux-socket-isolation.md) — cage topology this ADR nests on top of.
- [ADR-054](054-strict-schema-drift-detection.md) §D3 — `.strict()` at leaf-object level (preserved here).
- [ADR-063](063-cockpit-roster-schema.md) — current flat cockpit schema (this ADR is its successor).
- [ADR-077](077-superdoctor-cockpit-role.md) §D1 — singleton superdriver/superdoctor pattern (lifted into `sessions[]` as discriminated types).
- [ADR-090](090-epic-team-lifecycle.md) — consumes `EpicTeamSession`; lands after impl T4.
- [ADR-091](091-kanban-driven-auto-merge.md) — walks the tree; lands after impl T4+T6.
- [ADR-092](092-cross-team-tell-lead.md) — reads `parent` field for cross-team routing.
- `src/schema/cockpit.ts:117-127` — current flat schema; replaced by recursive `sessions[]` at impl T4.
- `src/core/common.ts:603-606` — `ATMUX_CALLER_SCOPE` env (the adjacent-class leak target).

## Chain Tasks (parent t-e576dd43)

- **T1 / T2 / T3** — preceding ADRs in the team-of-teams sequence (ADR-087/088 + retired collision-numbering placeholder).
- **T4** = ADR-089 impl: cockpit recursive `sessions[]` schema + migration shim + `enabledTeams` flattener (`t-d8b2cc41`).
- **T5** = ADR-089 impl: tmux prefix-chain by nesting level + `ATMUX_NESTING_LEVEL` env propagation (`t-7e7031dc`).
- **T6** = ADR-089 dogfood: cockpit verbs walk recursive tree + nested-cage e2e gate (`t-60982d48`).
- **T7+** = downstream ADRs (090 epic-team lifecycle / 091 auto-merge / 092 cross-team tell-lead).
