# ADR-158: martinet → sentinel rename — SV register sweep, supersedes ADR-132 nomenclature

> **⚠ SUPERSEDED by [ADR-211](211-retire-sentinel-role-distribute-to-honker-consumers.md) — 2026-05-23. Read ADR-211 instead; this file is kept for trace only.**

**Status**: Superseded by e-be01fc89 (sentinel deleted 2026-05-23; rename history retained for audit). Was: accepted 2026-05-20.
**Date**: 2026-05-16 (accepted 2026-05-20 — operator chat-time flip; rename SHIPPED end-to-end 2026-05-16 per TR2 125011d / TR3 1b40f98 / TR4 docs sweep)
**Driver-ref**: 2026-05-16 driver session — operator chat-time decision on SV/Reddit-eng register sweep for cockpit roles.
**Parent EPIC**: t-f3a9ac0c (this ADR is the umbrella; TR1-TR4 filed in same session per [[feedback_decomp_same_session_with_deps]]).
**Cross-refs**: ADR-132 (martinet — pluggable whip-manager; this ADR supersedes nomenclature, not design), ADR-133 (superdoctor → medic — rename-mechanics precedent), ADR-135 (cockpit naming convention — `_-prefix` D4 in-place rename pattern), ADR-159 (gitter → committer — sibling vocabulary rename), ADR-160 (whip → poke — sibling vocabulary rename), ADR-161 (default-member `_-prefix` — sibling convention).

## Context

### Why this rename now

The cockpit role-type identifier `martinet` shipped with ADR-132 in May 2026. The word is French — a strict, coercive disciplinarian (originally a cat-o'-nine-tails). It captures the role's continuous-observer + escalation-on-misbehavior semantics, but the register is hostile. atmux is an SV/Reddit-engineering register codebase: identifiers should sound like things engineers say, not things drill sergeants say.

The Redis ecosystem has `Sentinel` — a process that observes the cluster, escalates on failure, manages state transitions. Exactly the semantic shape of atmux's role. `sentinel` reads as a familiar cluster-management primitive; engineers already know what it does without needing to look it up.

This ADR is one of three sibling vocabulary renames shipped in the same release cycle:
- ADR-158 (this): martinet → sentinel.
- ADR-159: gitter → committer.
- ADR-160: whip → poke.

Plus ADR-161 (default-member `_-prefix`) lands the same cycle as a cosmetic convention sibling.

### Why design stays unchanged

The role's responsibility surface is unchanged — ADR-132 §classifier + ADR-140 cheap-model-first + ADR-139 refusal-pattern detection all still describe what sentinel does, just under a different name. Schema, escalation contract, cockpit window position (W3 per ADR-135 / ADR-133), NudgeAction classifier, pluggability layer — all preserved verbatim. Only the identifier changes.

### Why this ADR doesn't edit ADR-132

ADRs are append-only per project [CLAUDE.md](../../CLAUDE.md) §Docs Discipline. ADR-132's body documents the design of `martinet`; that body stays. ADR-132 gains an `## Amendments` annotation pointing to ADR-158 for the rename rationale + canonical identifier going forward. Readers landing on ADR-132 see "this design ships under the name `sentinel` per ADR-158" and follow the pointer.

### Rename mechanics precedent — ADR-133

ADR-133 superdoctor → medic established the canonical rename mechanic for atmux:

1. New ADR documents rationale + supersession.
2. Source files renamed (git mv preserves history).
3. Schema gets new field with one-release JSON-shim for legacy key (deprecation-warn on legacy).
4. Tmux window renamed in-place per ADR-135 D4 (preserves PID + attachments).
5. Briefs + docs + CHANGELOG sweep in same commit.

ADR-158 follows this template byte-for-byte; the only deltas are the specific identifier + the affected files.

## Decision

Four §Decision-anchor lines first, then prose around each subsystem.

> **§Decision-anchor #1** — **`sentinel` is the canonical identifier going forward.** Every code path that named `martinet` (file names, function names, type names, schema keys, brief template filenames, doctor probe names, escalation-contract identifier) renames to `sentinel`. Cockpit window: `_martinet` → `_sentinel` per ADR-135 D4 in-place rename pattern (preserves PID + claude-process state). The rename lands in a single release cycle (no extended grace period); the JSON-shim accepts the legacy key for one release.

> **§Decision-anchor #2** — **Schema JSON-shim accepts both keys for ONE release with deprecation-warn on legacy `martinet`.** Mirrors ADR-133 superdoctor → medic precedent. The cockpit.json schema's discriminated union accepts `sentinel: {...}` AND `martinet: {...}` (canonicalized to `sentinel` at runtime). On legacy-key parse, doctor emits a `🟡 deprecated 'martinet' key in cockpit.json — rename to 'sentinel' per ADR-158` warning. After one release cycle, the legacy key is removed from the schema; cockpit.json files still using `martinet:` refuse to parse.

> **§Decision-anchor #3** — **ADR-132 stays intact; gains `## Amendments` annotation pointing to ADR-158.** Per ADR-convention §Append-only. The annotation reads: "2026-05-16 — Role-type identifier renamed `martinet` → `sentinel` per ADR-158. Design preserved verbatim; only the identifier changes." No edit to existing §Decision prose.

> **§Decision-anchor #4** — **Sibling-rename coordination.** This ADR ships alongside ADR-159 (gitter → committer) + ADR-160 (whip → poke) + ADR-161 (`_-prefix` convention). All four can ship in any order; none depend on the others. Cross-references in each are forward-looking — if a sibling hasn't shipped yet, the cross-ref is a reservation, not a dependency. The release-cycle ships all four (or whichever subset reaches reviewer signoff in the cycle window).

### §Surface inventory — what gets renamed

Per the EPIC body's scope statement + greps:

| Surface | Action |
|---------|--------|
| `src/abstractions/martinet.ts` | `git mv` → `src/abstractions/sentinel.ts`; rewrite imports across `src/` + `tests/` |
| `src/verbs/martinet.ts` | `git mv` → `src/verbs/sentinel.ts`; rewrite imports + help.ts entry |
| `src/core/martinet-escalation.ts` (per memory [[project_martinet_pattern]]) | `git mv` → `src/core/sentinel-escalation.ts`; rewrite imports |
| `src/schema/cockpit.ts` — `martinet:` field | rename to `sentinel:`; add JSON-shim for legacy key (TR3) |
| `templates/briefs/martinet.md` | `git mv` → `templates/briefs/sentinel.md`; body rewrite (s/martinet/sentinel/g) |
| `docs/martinet.md` (if exists; locate via grep) | `git mv` → `docs/sentinel.md`; body rewrite |
| Doctor probe names (`martinet-stalled`, `martinet-misclassified`, etc. — locate via grep) | rename to `sentinel-*` |
| ADR-132 file | annotation-only (append `## Amendments` section; don't edit existing prose) |
| ADR-077, ADR-079, ADR-086, ADR-133, ADR-135, ADR-139, ADR-140 — any prose citing `martinet` | annotation-only via `## Amendments` if substantive; otherwise leave with the legacy identifier (historical record per ADR convention) |
| `CLAUDE.md` (global + project-local) — `martinet` references | rewrite to `sentinel`; CLAUDE.md is mutable (not append-only) |
| `README.md` | rewrite martinet → sentinel where it appears |
| `CHANGELOG.md` | add [Unreleased] entry citing rename |
| Memory entries — `project_martinet_pattern.md` (per [[project_martinet_pattern]]) | update body to cite new identifier; keep filename for git-friendly-history OR rename + update MEMORY.md index |
| Discord templates — `[martinet-*]` (if any exist) | rename to `[sentinel-*]` |
| Cron schedule files — any `martinet` cron-line identifiers | rewrite |

### §Part A — source rename

**`git mv` preserves history** — every file rename uses `git mv` (single commit per file, tracked as rename, not delete+add). After rename, every import-site needs updating. Use a precise grep + sed pipeline OR equivalent IDE refactor; verify post-rewrite with `bun build` (or whatever atmux's typecheck is) to catch broken imports.

**Identifier rewrite within renamed files**:
- Function names: `martinetTick()` → `sentinelTick()`, `classifyMartinet()` → `classifySentinel()`, etc.
- Type names: `MartinetState` → `SentinelState`, `MartinetClassifier` → `SentinelClassifier`.
- Variable names: local variables named `martinet` inside renamed files → `sentinel`.

**Identifier rewrite OUTSIDE renamed files** (other files import the abstraction):
- Import paths: `from "./abstractions/martinet"` → `from "./abstractions/sentinel"`.
- Type imports: `import type { MartinetState } from ...` → `import type { SentinelState } from ...`.

**Backward-compat at the export layer**: no — internal exports are renamed. External consumers (operator scripts, third-party integrations) don't exist for cockpit-role abstractions; no backward-compat needed at the JS-export layer. The ONLY backward-compat is the cockpit.json schema JSON-shim (§Decision-anchor #2).

### §Part B — schema JSON-shim

**Implementation pattern** (mirroring ADR-133 superdoctor → medic):

```ts
// src/schema/cockpit.ts (sketch)
export const CockpitSchema = z.object({
  // ... other fields ...
  sentinel: SentinelConfigSchema.optional(),
  martinet: SentinelConfigSchema.optional(),  // legacy alias; deprecation-warn
}).transform((data) => {
  if (data.martinet && !data.sentinel) {
    // canonicalize: legacy key → new key
    return { ...data, sentinel: data.martinet, martinet: undefined };
  }
  return data;
}).refine(
  (data) => !(data.martinet && data.sentinel),
  { message: "Cannot specify both 'martinet' and 'sentinel'; use 'sentinel'." }
);
```

**Deprecation-warn emit point**: when `loadCockpit` detects the legacy key, emit a doctor-finding `cockpit-legacy-martinet-key` (warn-class) — surfaces on every `atmux doctor --json` until the operator updates their cockpit.json. Self-clearing post-rename.

**Removal timeline**: one release cycle. After the cycle, the JSON-shim is removed; cockpit.json files still using `martinet:` refuse to parse with `ConfigError: Use 'sentinel' instead of 'martinet' per ADR-158`. The removal is itself an ADR-158 amendment (no separate ADR needed for the shim removal step).

### §Part C — cockpit window rename (ADR-135 D4 in-place)

Per ADR-135 D4 (in-place rename preserves PIDs + attachments):

```sh
tmux -L atmux-cockpit rename-window -t _martinet _sentinel
```

The rename happens on next `atmux cockpit rebuild` invocation (per ADR-135 D4 reconciliation pattern). PID + claude-process state preserved. No respawn.

If operator is mid-attached to the `_martinet` window: tmux's rename-window doesn't detach the client; the window-name updates in-place. Cosmetic only.

### §EPIC-done definition (canonical for this ADR's decomp)

ADR-158 completes when ALL of:

1. TR1 lands — this ADR commits (greenfield-verified pre-flight).
2. TR2 lands — source rename via `git mv`; imports rewritten; unit tests cover the new identifiers.
3. TR3 lands — cockpit.json schema gains `sentinel:` + JSON-shim for `martinet:`; doctor probe emits deprecation-warn on legacy key; Zod tests cover both key shapes.
4. TR4 lands — RUNBOOK + ARCHITECTURE + briefs + ADR-132 §Amendment + CHANGELOG + memory entries + CLAUDE.md global/project sweep.

## Consequences

### What this ADR enables

- **Vocabulary fit**: `sentinel` reads natively to SV engineers; muscle-memory link to Redis Sentinel makes the role's semantics self-documenting.
- **Cohesive release-cycle sweep**: lands with sibling vocabulary renames (committer / poke) + `_-prefix` cosmetic for a holistic cockpit-vocabulary refresh.
- **Zero design risk**: design preserved verbatim per ADR-132; this rename has no behavior implications, only readability.
- **Reusable rename mechanic**: ADR-133 + ADR-158 establish a stable rename pattern (file mv + schema shim + window rename + ADR annotation + briefs sweep + memory update). ADR-159 + ADR-160 follow the same template.

### What this ADR does NOT cover

- **Design changes to martinet/sentinel** — out of scope. Pure identifier rename.
- **Removal of legacy ADR-132 references in OLDER ADRs** — out of scope. Historical record stays per ADR convention.
- **Operator-side tooling renames** (e.g. user scripts that grep for "martinet") — operators handle their own scripts; atmux doesn't migrate operator-owned tooling.
- **Schema migration of existing cockpit.json files** — handled by the JSON-shim; no operator action required during the one-release grace window.

### Rollback path

- Source rename: `git revert` the rename commit. History restored.
- Schema shim: leave the JSON-shim in place (additive); operators using either key keep working.
- Cockpit window: `tmux rename-window _sentinel _martinet` reverts the in-place rename.
- ADR-132 §Amendment: leave the annotation (append-only convention); document the rollback in a new annotation if needed.

### Reuse statement

- Rename mechanic: ADR-133 (superdoctor → medic) — reused verbatim.
- In-place window rename: ADR-135 D4 — reused.
- JSON-shim discriminated-union pattern: ADR-133 — reused.
- Append-only ADR annotation: ADR convention — reused.
- NEW abstraction: none. Pure rename.

### What breaks (during the one-release grace window)

- Nothing. JSON-shim accepts both keys; deprecation-warn surfaces but doesn't block.

### What breaks (post-grace-window)

- Operator cockpit.json files still using `martinet:` refuse to parse. Hint actionably names ADR-158 + the canonical `sentinel:` key. Migration is one-line sed.

## Open questions

1. **Should `[sentinel-*]` Discord templates also rename?** ADR-132 / ADR-140 don't enumerate Discord templates by martinet name — locate via grep `[martinet-` in `src/abstractions/discord.ts`. **Planner recommendation**: rename if templates exist; if no templates carry the legacy identifier, no action.

2. **Memory file rename — `project_martinet_pattern.md` → `project_sentinel_pattern.md`?** Renaming + updating MEMORY.md index breaks git-history-friendly tracking. **Planner recommendation**: keep filename (preserves history); update body content + MEMORY.md description to use `sentinel`. Filename is internal; readers see the body.

3. **Should the rename ship in one commit OR multiple (per surface)?** **Planner recommendation**: TR2 ships source rename in one commit (atomic). TR3 ships schema shim in another commit. TR4 ships doc sweep in another. Three commits across the cycle — reviewer can audit each independently.

4. **Operator-visible release-notes ordering**: when 158/159/160 all land same cycle, CHANGELOG entries land together. **Planner recommendation**: group them under a single `### 🔤 Vocabulary refresh — SV register sweep` heading in CHANGELOG, with bullets per ADR. Cleaner narrative than three sibling entries.

## Cross-references

- [ADR-132](132-pluggable-martinet.md) — design of the role (superseded nomenclature only; design preserved). Gains §Amendment annotation.
- [ADR-133](133-medic-rename.md) — rename-mechanics precedent (superdoctor → medic).
- [ADR-135](135-cockpit-naming-convention.md) — D4 in-place window rename pattern.
- [ADR-139](139-refusal-pattern-auto-rotate.md) — refusal-pattern detection (consumed by sentinel; identifier renames cascade).
- [ADR-140](140-cheap-model-first.md) — cheap-model-first principle (sentinel runs on cheap models; identifier renames cascade).
- [ADR-159](159-*.md) — gitter → committer (sibling vocabulary rename).
- [ADR-160](160-*.md) — whip → poke (sibling vocabulary rename).
- [ADR-161](161-default-member-prefix-and-sort-verbs.md) — `_-prefix` convention (sibling sweep cosmetic; cockpit-role `_sentinel` aligns).
- Driver-ref: 2026-05-16 driver session — SV/Reddit-eng register sweep.
- Memory [[project_martinet_pattern]] — gets body-update + cite of new identifier.
- Memory [[project_medic_rename_adr_133]] — precedent for this rename's mechanic.
- Project [CLAUDE.md](../../CLAUDE.md) §Docs Discipline §Append-only ADRs.
