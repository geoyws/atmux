# ADR-089: Hierarchical cockpit — recursive `sessions[]` + nested tmux prefix chain

**Status**: accepted
**Date**: 2026-05-13
**Driver-ref**: `.atmux/driver-inbox.md` 14:03 MYT 2026-05-13 §Pillar 1+2 (lines 2986-3032).
**Parent Task**: t-e576dd43. **Authored under**: t-5e7a6631 (ADR seq 3/6, DRAFT only).
**Numbering shift**: this ADR is the **+1 shift** of driver-inbox's §ADR-088 hierarchical-cockpit ask, bumped to avoid collision with the live **ADR-086** (atmux-pulse, already shipped). The full shift is `driver-inbox §ADR-086→087, §ADR-087→088, §ADR-088→089 (this), §ADR-089→090, §ADR-090→091, §ADR-091→092`. Future readers MUST cross-reference using the shifted IDs, not the original driver-inbox numbering.
**Reviewer pre-flag**: `.atmux/reviewer-preflag-ADR089-091.md` (signed 2026-05-13). Adjacent-class audit: `.atmux/audits/adr-089-091-adjacent-class-2026-05-13.md` (Class 2 F-key rebinding). All 7 §Decision-anchors + 3 Class-2 recommendations folded into §Decision below.

> **Rename note (2026-05-14)**: this ADR was authored 2026-05-13 referencing the cockpit self-healing role as `superdoctor`. That role was renamed `superdoctor` → `medic` per [ADR-133](./133-medic-rename.md) on 2026-05-14. Prose references below to "superdoctor" should be read as the role now called **medic**. The schema-discriminator literal `type: "superdoctor"` and the TypeScript type identifier `SuperdoctorSession` remain unchanged for the deprecation window per ADR-133 §Out of scope — schema-discriminator renames require a separate migration ADR. ADR-089 implementations landing post-2026-05-14 SHOULD prefer `type: "medic"` once that schema rename ships; until then, the literal stays `"superdoctor"` as documented here for backward-compat.

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

> **Read the example above as one instance, not as the rule** — see [§Amendment 2026-08-27](#amendment-2026-08-27--nesting-is-general-not-epic-shaped-group-tier-shifts-the-prefix-chain-down-one-rung-t-f73a418c) §(A). `TeamSession` carries its own recursive `sessions[]` (the `sessions: z.array(z.lazy(() => CockpitSession))` line above), so a `team` nested inside a `team` is equally valid and needs no `epicId`; the epic-team child shown is one reason to nest, not the mechanism. The `loadCockpit` max-depth cap named in this paragraph was **never implemented** — §H and §Amendment 2026-08-27 §(D).

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

> ⚠ **Superseded by [§Amendment 2026-08-27](#amendment-2026-08-27--nesting-is-general-not-epic-shaped-group-tier-shifts-the-prefix-chain-down-one-rung-t-f73a418c) §(B).** Inserting a `group` tier at L2 moves the team cage to `F3` and the epic-team to `F4`; L0/L1 are unchanged. The rows above are kept verbatim as the 2026-05-13/2026-05-24 record — read §(B) for the current tier-to-rung mapping, §(C) for what happens past the chain's end (the "Reserved" row is no longer the answer), and note that the enforcement point is the operator's dotfiles, not this table.

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

Verbs read `ATMUX_NESTING_LEVEL` (integer, 1-indexed per the §C table — `L1=Cockpit`, `L2=top-level team cage`, `L3=epic-team cage`); missing → default `2`. Used in tmux.conf generation to pick the right prefix from `cockpit.prefixChain`.

**Default-shift note (2026-05-24).** Original §D default was `1` (treating L1 as "outermost cage", which collapsed cockpit and top-level team into the same chain slot F1 and relied on tmux-socket separation to avoid physical collision). Operator directive 2026-05-24 — *"Fix code to match ADR §C table + my mental model"* — flipped the default to `2` so standalone `atmux start` produces a team cage at L2 (F2), reserving L1 (F1) for the cockpit. The §C table was always the canonical visual model; the default-shift brings code in line.

**Propagation rule** (§Decision-anchor #5): at cage entry (`src/verbs/start.ts`, `src/verbs/team/spawn-epic.ts`):

```bash
# Child cage entry:
unset ATMUX_NESTING_LEVEL
export ATMUX_NESTING_LEVEL=<computed-own-level>
```

Computed level is `parent.ATMUX_NESTING_LEVEL + 1` (or `2` for cockpit-spawned root teams — cockpit itself is L1, so its direct team children start at L2). The UNSET-then-set discipline ensures child processes inside the cage inherit the child's level, not the parent's.

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

> ⚠ **Never implemented — corrected by [§Amendment 2026-08-27](#amendment-2026-08-27--nesting-is-general-not-epic-shaped-group-tier-shifts-the-prefix-chain-down-one-rung-t-f73a418c) §(D).** `loadCockpit` performs no depth walk; `MAX_NESTING_LEVEL` is read only by `validatePrefixChain` and `childNestingEnv`. The paragraph below describes intent that was never built. §(C) is where the refusal should land.

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


## §Amendment 2026-05-20 — promoted to accepted (status-drift audit T4)

Promoted from `proposed` → `accepted` per [docs/audits/adr-status-drift-audit-2026-05-20.md](../audits/adr-status-drift-audit-2026-05-20.md) (sha=a6f1541). Code-refs + git-log refs both present at audit time confirming shipped + dogfooded status; the `proposed` marker was bookkeeping debt. Original Date preserved verbatim. Append-only — see Status field for the canonical flip; this §Amendment carries the audit traceability.

**Filed via** t-45b401c3 (T4 sweep, 2026-05-20).


## §Amendment 2026-05-22 — `cockpit rebuild` applies the F-key prefix to the cockpit session itself (t-3fb7bc54)

Closes a gap exposed 2026-05-21 21:57 MYT on the operator's hax box (post seed-expansion epic spawn): `atmux cockpit rebuild` applied the level-resolved cage prefix (`resolvePrefix(t.level + 1, cockpit.prefixChain)`) to each enabled CAGE via Phase 3 (`src/verbs/cockpit.ts:693-705`), but never set a prefix on the cockpit session itself. The cockpit's tmux prefix therefore reflected whatever the host tmux config (or `applyCagePrefix`'s legacy `C-\\` default) supplied; operator observed it clobbered to `C-a` and manually ran `tmux -L atmux-cockpit set-option -g prefix F1` per rebuild as the workaround.

**Contract extension** — §C's F-key chain semantics extend by one rung: in addition to the per-level cage prefix wiring (L1 = chain[0] = `F1` default; L2 = chain[1] = `F2` default; etc.), the cockpit session itself receives the **chain's first entry** (`resolvePrefix(1, cockpit.prefixChain)` = `F1` by default). The cockpit is structurally the outer container of all L1 cages — it is NOT a level in the cage chain itself — but `chain[0]` is the right operator-facing value because:

1. The cockpit and L1 cages live on **separate tmux sockets** per [ADR-162](162-atmux-owns-tmux-infrastructure.md) §Decision-anchor #1 (cockpit on `tmux -L atmux-cockpit`; each cage on its own per-team socket). Different tmux servers own different keybinding namespaces — the same `F1` chord doesn't collide; whichever socket the operator's tmux client is attached to receives the chord.
2. `F1` matches the operator's documented manual workaround verbatim (`tmux -L atmux-cockpit set-option -g prefix F1`); using the chain's first entry preserves that mental model.
3. No new config knob is required. The alternative (a distinct `cockpit.cockpitPrefix` field orthogonal to `prefixChain`) adds surface without solving anything the chain's first entry doesn't already cover; deferred as a follow-up if and when an operator hits a case where chain[0] is the wrong cockpit value (none observed today).

**Impl** — `src/verbs/cockpit.ts` Phase 5b (new sub-phase between `reconcileCockpitSession` and `installCockpitCron`) calls `applyCagePrefix(cockpitTmux, resolvePrefix(1, cockpit.prefixChain))` with the same best-effort try/catch wrap as the Phase 3 cage loop — invalid chain or level > `MAX_NESTING_LEVEL` falls through to `applyCagePrefix`'s legacy `C-\\` default (cosmetic only; cockpit operation unaffected). The cockpit session already exists by Phase 5b because `reconcileCockpitSession` materialises it; ordering matters so the `set-option -g` lands on a live session.

**Test coverage** — `tests/unit/verbs/cockpit.test.ts::applyCagePrefix "applies F1 (chain[0]) on a cockpit-shaped session"` exercises the Phase 5b shape directly on a cockpit-shaped fixture.

**Out of scope** — making the cockpit-prefix and L1-cage-prefix DIFFERENT entries by default (would force operators to memorise two different chords for visually-adjacent panes on different sockets). Out of scope: per-cockpit cockpit-prefix override config (deferred — no operator demand today).

**Cross-refs:** [ADR-162](162-atmux-owns-tmux-infrastructure.md) §Decision-anchor #1 (cockpit-on-dedicated-socket → enables the same-chord-no-collision argument); `b887009` (the Phase 3 cage-prefix wiring that this amendment extends).

**Filed via** t-3fb7bc54 (docs role, 2026-05-22).

## §Amendment 2026-06-05 — `spawn-epic` wires the parent-cage viewer (closes the spawn-side gap) (t-2183f488)

§Pillar 1 §Amendment (t-2ea3bdb9, 2026-05-16) moved epic-team viewer placement to the parent cage via `addEpicViewerToParentCage` (`src/core/cockpit.ts`), and ADR-135 §D2 §Amendment (t-34fa0132) made the `🌳-<epicId>` window sit INSIDE the parent session. Call-site coverage was asymmetric: `atmux start` (`src/verbs/start.ts` §10b) added the viewer on cold boot, and `atmux team dissolve-epic` (`src/core/dissolve-epic.ts` §5a) removed it, but `atmux team spawn-epic` (`src/verbs/team/spawn-epic.ts`) registered the child in `cockpit.json::sessions[]` and never called the helper. Spawning an epic-team into a RUNNING parent therefore left the parent cage with no viewer window until the operator `atmux stop` + `atmux start`-ed the parent to re-hit the cold-boot path (operator-facing UX wedge — observed 2026-05-19: `atmux` cage had 7 windows, 0 `🌳-` viewers, despite a registered `e-13f311f5` child).

**Wire-up** — `spawn-epic` step 9 (new, between the cockpit-registry write at step 8 and the success log now at step 10) calls `addEpicViewerToParentCage({ parentRoot, parentName, epicId, epicSocket: resolveTeamSocket(childTeam), epicSession, tmuxFactory, log, warn })`, mirroring `start.ts` §10b's call shape. `epicSocket`/`epicSession` derive from the synthesised `childTeam` (its `tmuxTmpdir` nests under the parent per §Pillar 1). Soft-fail: wrapped in try/catch + warn so a parent-cage/tmux hiccup never fails an otherwise-complete spawn.

**Pre-cage timing is correct** — at `spawn-epic` time the child cage does NOT exist yet (its spawn is deferred to the operator's `atmux cockpit rebuild`). The helper soft-fails only on the PARENT session being down; when the parent is live it always creates the window, whose shell command is a 1s-retry attach loop (`while true; do tmux -S <epicSocket> attach -t <epicSession>; sleep 1; done`). The loop connects the moment the child cage boots, so adding the viewer before the cage exists is the intended behaviour — the retry loop bridges the gap. Idempotent: the helper's window-name check skips a duplicate add when re-spawned.

**Test coverage** — `tests/unit/verbs/team/spawn-epic.test.ts` (describe block "spawnEpic — parent-cage viewer (ADR-089 §Pillar 1 §Amendment / t-2183f488)"): live-parent fixture asserts the `🌳-<epicId>` window is created with the correct retry-attach shell command + nested epic socket; down-parent fixture asserts soft-fail (no window, spawn still returns 0); idempotent fixture (window pre-present) asserts no duplicate `newWindow` call.

**Filed via** t-2183f488 (up-impl lane, 2026-06-05).

## §Amendment 2026-08-27 — nesting is general, not epic-shaped; group tier shifts the prefix chain down one rung (t-f73a418c)

Operator directive 2026-08-27, verbatim: *"let's clean up the docs for epic team.... we have to just make it flexibly nestable so no hard rules like it has to be epic team"*. This amendment does two things: it restates the nesting model as a **general capability with no required reason**, and it records the operator-accepted prefix shift that follows from inserting a `group` tier above the team cage.

**Docs-only.** No TypeScript, schema or test changed in the commit carrying this amendment. §Implementation ledger below states, per claim, whether the shipped binary does it today.

### (A) Nesting is a general capability; `epic-team` is one instance of it, not the mechanism

The model this ADR defines, restated without the epic framing:

> **A cage may contain child cages, to arbitrary depth, for any reason the operator has.** A child cage is a `sessions[]` entry inside a parent's `sessions[]`. Nothing about the mechanism knows or cares *why* the operator nested it.

Three hard rules that earlier readings of §Decision (A) invited, and which are now explicitly **retracted**:

- ❌ *"Nesting means epics."* It does not. Nesting means containment. An epic is one reason to nest; organisational grouping, per-product fan-out, and per-driver lanes are others, and the mechanism is indifferent between them.
- ❌ *"A nested cage must carry an `epicId`."* `epicId` is required only on `type: "epic-team"`, and it stays required **there** — an epic-team without a link back to `kanban.epics[].id` is a lifecycle bug, and ADR-090/091/182/219 all join on that field. What is retracted is the inference that *nesting in general* needs one. `type: "team"` has never had an `epicId` and never needs one.
- ❌ *"Only an `epic-team` may be a child."* `type: "team"` has carried its own recursive `sessions[]` since the original impl (§Implementation ledger row 1). A team inside a team inside a team parses, walks, and gets a cage today.

`epicId` therefore keeps its meaning exactly where an epic genuinely is the reason for the cage, and is simply absent everywhere else. It is not deprecated and not removed.

**Worked example — the four-tier fleet the operator asked for (2026-08-27).** Tiers named `group` and `project` below are *descriptions of intent*, not schema literals; see §Implementation ledger row 3 for what the schema actually admits today.

```
L1  cockpit           _sdriver · _med · _misc
L2    group           geoyws · unum · ifca
L3      project       aix · ix · mx · prjx · px · hx · hrx · rx · fmx · ifca-docs
L4        drivers     3 per project
```

None of `geoyws` / `unum` / `ifca` is an epic. Under the epic-only reading they were inexpressible; under the general reading they are ordinary child cages whose reason for existing is organisational.

### (B) Prefix chain — the group tier shifts every rung below it down by one

**Operator-accepted 2026-08-27.** §C's table is superseded by this one. The chain is unchanged in *shape* — it is the same 1-indexed walk down `prefixChain` — but the tier that occupies each rung moves:

| Level | §C (2026-05-13, as amended 2026-05-24) | This amendment | Prefix |
|---|---|---|---|
| L0 | Host tmux | Host tmux — **unchanged** | `C-a` |
| L1 | Cockpit | Cockpit — **unchanged** | `F1` |
| L2 | Team cage | **Group** | `F2` |
| L3 | Epic-team cage | **Project / team cage** | `F3` |
| L4 | Reserved | **Nested cage — epic or any other reason** | `F4` |
| L5 | Reserved | Spare | `F5` |
| L6+ | Reserved | See §(C) | `F6`… |

**Net effect on muscle memory: a team cage moves `F2` → `F3`, and an epic-team `F3` → `F4`.** Nothing above L2 moves.

**This shift needs no arithmetic change in atmux.** The prefix is resolved from **tree depth**, never from node type — `src/verbs/cockpit.ts:719` computes `resolvePrefix(t.level + 2, cockpit.prefixChain)` against the 0-indexed depth `enabledTeams` annotates. Insert a tier and everything below it descends one rung automatically. That property is why §C's table was always a *description* of the depth arithmetic rather than a hardcoded mapping, and it is what makes this shift a documentation change on the atmux side.

**The enforcement point is the operator's dotfiles, and it is NOT depth-derived.** Two files carry a socket-pattern `if-shell` chain that assigns the prefix by matching the socket path against three hardcoded branches (`*atmux-cockpit` → `F1`; `*/epics/*` → `F3`; `/tmp/atmux-*/sock` or `*/.atmux/tmux/*` or `*atmux-tmux*` → `F2`; else `C-a`):

- `_dotfiles/tmux/.tmux.conf` — comment block lines 127-146, `if-shell` chain lines 148-184
- `_dotfiles/atmux/tmux.conf.local` — lines 16-39, a near-duplicate re-applied after the personal config is sourced

Both must be updated in the same delivery. Updating one and not the other is a silent no-op: `tmux.conf.local` exists precisely to re-assert the prefix after `.tmux.conf` is sourced, so it wins. A third site, `_dotfiles/tmux/.tmux.conf:266`, enumerates the same socket globs for an unrelated `bind w` `choose-tree` branch and needs the new tier's socket pattern added for consistency, though nothing breaks if it is missed.

Because that chain matches on **socket path** rather than depth, a group cage whose socket looks like an ordinary team socket will be assigned `F2` — which is correct for a group and wrong for the project cage sitting under it, whose socket looks identical. Making the dotfiles depth-aware (or giving group cages a distinguishable socket path) is the real work of the shift. Until it lands, **the shift is documented and not in effect**, and this amendment says so rather than describing it as live.

### (C) Beyond F5 — refuse, do not clamp and do not wrap

§C left L4+ as "Reserved", which was tolerable while the level count was fixed at four. With depth open-ended it is undefined behaviour, so this amendment defines it:

> **Every level gets a distinct entry for as long as `prefixChain` lasts (F1..F12 by default = levels 1 through 12). Depth beyond the chain's length is REFUSED at `loadCockpit` with an actionable error naming both the offending depth and the chain length. There is no clamp and no wrap-around.**

**Reasoning.** The two alternatives both reintroduce, at depth, exactly the ambiguity the 2026-05-24 off-by-one shift was raised to remove:

- **Clamp** (levels past the end share the deepest key) makes one chord mean two different cages, and the operator cannot tell which from looking at the pane.
- **Wrap** (L13 → `F1`) is worse — it collides the deepest cage with the **cockpit**, the one session an operator most needs to reach unambiguously in a wedge.

Socket separation does physically disambiguate both cases, but §Decision-anchor #7's whole claim is that the operator should never have to reason about which socket a chord lands on. A refusal costs the operator one config edit (lengthen `prefixChain`, or flatten the tree) and preserves that property; a clamp or a wrap costs them a wrong chord at the worst moment. The independent second reason to refuse: F13+ does not exist on most terminals, so 12 is a real physical ceiling, not an arbitrary one — there is nothing to extend the chain *with* past F12 except Ctrl-letter chords the operator must choose deliberately.

**Consequence for `MAX_NESTING_LEVEL`.** The constant is `6` (`src/core/cockpit.ts:506`), justified in §Decision-anchor #6 as "L1-L4 reserved + 2 headroom" — an arithmetic that assumed a fixed four-level model this amendment retires. Under the rule above the cap should be the chain length (12 by default), leaving the chain — not a separate constant — as the single thing that bounds depth. **Not yet implemented; flagged as a decision needing an implementation task.** Note the current constant already admits the operator's four-tier fleet (cockpit L1 + group L2 + project L3 + drivers as windows, not levels), so nothing is blocked on it today.

### (D) §H correction — the documented depth cap was never implemented

§H states: *"`loadCockpit` refuses cockpit.json files with tree depth > 6."* **It does not, and never has.** `loadCockpit` (`src/core/cockpit.ts:83-138`) rejects a legacy `superdoctor` block, migrates the legacy shape, `safeParse`s, validates `prefixChain` length + uniqueness, and validates operator window names. It performs **no depth walk**. `MAX_NESTING_LEVEL` is consumed in exactly two places — `validatePrefixChain` (`src/core/cockpit.ts:587`, a minimum chain *length* check) and `childNestingEnv` (`src/core/cockpit.ts:649`, a cage-entry runtime guard). Neither reads the tree.

The practical effect: an over-deep tree is not caught at load. It surfaces later as a swallowed `resolvePrefix` throw in the Phase 3 loop (`src/verbs/cockpit.ts:719-724`), which falls back to `applyCagePrefix`'s legacy `C-\` — a cage with a silently wrong prefix, which is the failure mode §Decision-anchor #4 exists to prevent. Recorded here as debt rather than quietly fixed in prose; the §(C) refusal is where it should land.

### §Implementation ledger — what ships today vs what does not

| # | Claim | Status | Sites |
|---|---|---|---|
| 1 | A `team` may contain child cages of any type, to arbitrary depth | **Ships** | `src/schema/cockpit.ts:143` (`TeamSessionT.sessions`), `:204` (zod `sessions`); `src/core/cockpit.ts:393` (`walkSessions` recurses on `team` and `epic-team`). No validation anywhere refuses a `team` under a `team`. |
| 2 | Prefix is derived from depth, not from node type — so a new tier shifts everything below it automatically | **Ships** | `src/verbs/cockpit.ts:719`; `src/core/cockpit.ts:486-499` (`DEFAULT_PREFIX_CHAIN` = F1..F12), `:550` (`resolvePrefix`) |
| 3 | A purely organisational tier — a container with no repo behind it | **Does NOT ship** | The union admits only `team` / `epic-team` / `superdriver` / `medic` (`src/schema/cockpit.ts:194`). Both nestable members demand a backing cage: `team` requires `root` (`:202`), `epic-team` requires `parent` + `epicId` (`:213-214`). There is no cage-less container type. Expressing a `group` today means giving it a `root` with a real `.atmux/team.json` and accepting a cage for it. |
| 4 | A new session type could nest | **Does NOT ship** | `walkSessions` recurses only into `team` / `epic-team` (`src/core/cockpit.ts:393`); `enabledTeams` emits rows only for those two (`:350`, `:361`). Any new type is a leaf until both are widened. |
| 5 | `epicId` is optional in the general nesting model | **Ships as documented** — because general nesting uses `team`, which has no `epicId` at all. On `epic-team` the field stays required, deliberately | `src/schema/cockpit.ts:156` (TS), `:214` (`z.string().min(1)`) |
| 6 | A parent cage gets a viewer window for its child | **Ships for epics only** | `addEpicViewerToParentCage` / `removeEpicViewerFromParentCage` (`src/core/cockpit.ts:741`, `:808`) hardcode the window name `🌳-<epicId>` (`:783`, `:843`). A non-epic child has no equivalent helper and gets no parent-cage viewer. |
| 7 | A verb spawns a nested cage | **Ships for epics only** | `src/verbs/team/spawn-epic.ts:774` writes `type: "epic-team"`. There is no generic "spawn a child cage" verb; `src/verbs/team/` holds spawn/dissolve for `epic` and `worker` only. |
| 8 | `loadCockpit` refuses depth > `MAX_NESTING_LEVEL` | **Does NOT ship** — see §(D) | `src/core/cockpit.ts:83-138` |
| 9 | The L2-group / L3-project / L4-nested prefix shift is in effect for the operator | **Does NOT ship** | Dotfiles socket chain, §(B). atmux's own arithmetic needs no change; the dotfiles do. |

**Scope note.** Rows 3, 4, 6, 7 and the §(C) / §(D) items are the implementation surface a follow-up task would cover. This amendment does not open one; it states the model and the gap so the two are not confused.

### Out of scope

Renaming `epic-team` to a neutral discriminator. The literal is load-bearing across ADR-090 (lifecycle), ADR-091 (auto-merge), ADR-144 (test-gate), ADR-182 (auto-reap), ADR-219 (dissolve completeness) and the orchd subscriber series, and it names a genuinely epic-specific lifecycle that keeps its `epicId` linkage. Generalising the *mechanism* does not require renaming the *instance* — a discriminator rename is a schema migration and needs its own ADR, on the ADR-266 §D2 shim-sunset pattern.

**Cross-refs:** §C (the table this supersedes) · §Decision-anchor #6 (the max-depth rationale §(C) retires) · §H (corrected in §(D)) · [ADR-090](090-epic-team-lifecycle.md) (the epic-shaped instance that keeps its `epicId`) · [ADR-162](162-atmux-owns-tmux-infrastructure.md) §Decision-anchor #1 (per-socket keybinding namespaces — why distinct chords are a convenience, not a correctness requirement) · [`docs/RUNBOOK-cockpit.md`](../RUNBOOK-cockpit.md) §11 (the operator-facing form of §(B)/§(C)).

**Filed via** t-f73a418c (docs lane, 2026-08-27).
