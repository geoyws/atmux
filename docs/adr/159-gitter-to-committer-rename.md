# ADR-159: gitter → committer rename — SV register sweep, OSS-canon vocabulary

**Status**: proposed
**Date**: 2026-05-16
**Driver-ref**: 2026-05-16 driver session — SV/Reddit-eng register sweep; chat-app brand collision on `gitter`.
**Parent EPIC**: t-5081041c (this ADR is the umbrella; TR1-TR4 filed in same session per [[feedback_decomp_same_session_with_deps]]).
**Cross-refs**: ADR-134 (merger / in-team gitter expanded fan-in role — gets annotation pointing here), ADR-145 (gitter spawn pattern — coordinate with whoever owns the EPIC), ADR-133 (superdoctor → medic rename-mechanics precedent), ADR-136 (hot-rename label-layer split — committer rename lands here), ADR-158 (martinet → sentinel sibling rename), ADR-160 (whip → poke sibling rename), ADR-161 (`_-prefix` convention — committer joins the default-role set, gains `_-prefix`).

## Context

### Why this rename now

`gitter` shipped as the role-type identifier for the agent-that-records-commits in atmux's team topology. The word has two problems:

1. **Chat-app brand collision**: `Gitter` (gitter.im) is a well-known dev chat platform. Engineers reading `gitter` in atmux code/docs do a double-take — "is this about chat? about git? both?". The cognitive overhead is small per encounter but cumulative.
2. **OSS-canon mismatch**: the OSS world has standard terms for the agent-that-records-commits. Git itself uses `committer` (vs `author`) as a first-class field. The role's responsibility is recording commits + pushing to trunk per ADR-145 / ADR-146 — `committer` reads natively.

This ADR is one of three sibling vocabulary renames in the same release cycle:
- ADR-158: martinet → sentinel.
- ADR-159 (this): gitter → committer.
- ADR-160: whip → poke.

Plus ADR-161 (`_-prefix` convention) lands the same cycle. **Committer becomes a DEFAULT role per ADR-161 §Decision-anchor #1** — gains `_-prefix` on next `atmux start` (label-only via ADR-136).

### Why design stays unchanged

ADR-134 (in-team merger as expanded gitter role) + ADR-145 (gitter spawn pattern) + ADR-146 (kanban auto-files trunk-merge Task on Story-done) all describe the role's responsibility surface. None change with this rename. Schema, dispatch pattern, fan-in semantics, cron triggers — all preserved verbatim. Only the identifier renames.

### Rename mechanics — mirrors ADR-133 + ADR-158

This rename follows the same template:
1. New ADR documents rationale + supersession.
2. Source files renamed via `git mv` (preserves history).
3. Schema gets new value with one-release accept-both grace + deprecation-warn on legacy.
4. Tmux window in-place renamed per ADR-135 D4 — when ADR-161 lands, window becomes `_committer` (not `_gitter`).
5. Briefs + docs + CHANGELOG sweep in same commit.

### Special case — `TeamMember.role` is an enum, not a top-level schema field

Unlike ADR-158 (which renamed a cockpit-level `martinet:` field), ADR-159 renames a VALUE within the `TeamMember.role` enum. The schema shim is value-level: accept both `"gitter"` and `"committer"` as valid role values; canonicalize on parse.

Existing rosters with `{role: "gitter", ...}` keep parsing during the grace cycle. Deprecation-warn surfaces. Post-cycle, legacy `gitter` role values refuse to parse.

### Special case — id-vs-label split per ADR-136

Per ADR-136 hot-rename label-layer split + [[project_member_hot_rename_adr_136]]: members have `id` (immutable; powers branch/worktree/kanban) + `label` (display) + `emoji` (display prefix).

- The CURRENT team's `gitter` member keeps `id: "gitter"` (immutable; branch `<base>-gitter`, worktree path, kanban owner all stay verbatim).
- The MEMBER's `label` updates to `"committer"` — display shows `_committer` (with `_-prefix` per ADR-161).
- The `role` enum value also updates: `role: "gitter"` → `role: "committer"` in team.json (via the schema's accept-both shim).

**Two layers of rename**:
- `role` enum value: legacy `gitter` → canonical `committer` (schema shim grace).
- `label` field: legacy `"gitter"` → canonical `"committer"` (display update; `atmux member rename` or auto-applied on next `atmux start`).

Both rename layers happen independently. The `id` STAYS `"gitter"` forever per ADR-136 (kanban + branch stability).

## Decision

Four §Decision-anchor lines first, then prose.

> **§Decision-anchor #1** — **`committer` is the canonical role-type identifier going forward.** Source files, function names, type names, brief filenames rename to `committer`. The `TeamMember.role` enum gains `"committer"` as a value; existing `"gitter"` value accepted for one release with deprecation-warn. Cron templates emit `atmux committer --sweep`; legacy `atmux gitter --sweep` alias retained for one release per [[feedback_atmux_no_gitter_worker_commits]] migration history.

> **§Decision-anchor #2** — **Member id stays `"gitter"`; label updates to `"committer"`.** Per ADR-136 id-vs-label split — id is immutable (powers `<base>-gitter` branch, worktree path, kanban owner). Label updates display. `_committer` window name per ADR-161 (committer is now a default role per ADR-161 §Decision-anchor #1 closed set).

> **§Decision-anchor #3** — **ADR-134 (merger / expanded gitter) + ADR-145 (gitter spawn pattern) get `§Amendments` annotations.** Append-only per ADR convention. Both ADRs' bodies preserve "gitter" identifier verbatim; annotation points to ADR-159 for the canonical rename. Design unchanged in both.

> **§Decision-anchor #4** — **Migration timing for default-role inclusion.** ADR-161 includes `committer` in `DEFAULT_MEMBER_ROLES` per its §Decision-anchor #1. The `_-prefix` rendering activates when both ADR-159 (this) and ADR-161 ship + impl-side rename of role enum value lands. Until then: legacy `gitter` role members render with hyphen format; canonical `committer` role members render with `_-prefix`. The grace-cycle dual-state is acceptable (deprecation-warn surfaces).

### §Surface inventory

| Surface | Action |
|---------|--------|
| `src/abstractions/gitter.ts` (if exists; locate via grep) | `git mv` → `committer.ts`; rewrite imports |
| `src/verbs/gitter.ts` | `git mv` → `committer.ts`; rewrite imports + help.ts entry |
| `src/schema/team.ts` — `TeamMember.role` enum | accept-both shim: `z.enum(["gitter", "committer", ...])`; transform `gitter` → `committer` on parse; deprecation-warn |
| `templates/briefs/gitter.md` | `git mv` → `templates/briefs/committer.md`; body rewrite (s/gitter/committer/g, preserve git-related prose) |
| Cron templates (locate via grep `atmux gitter`) | `atmux gitter` → `atmux committer`; legacy alias retained one release |
| ADR-134 + ADR-145 + ADR-146 — body cites of `gitter` | annotation-only (append `§Amendments`); historical record stays |
| `CLAUDE.md` (global + project) — gitter references | rewrite to committer; global goes via dotfiles-flow propose |
| `README.md` | rewrite |
| `CHANGELOG.md` | add [Unreleased] bullet under 🔤 Vocabulary refresh heading (groups with ADR-158/160) |
| Memory — `feedback_atmux_no_gitter_worker_commits.md` | filename preserved (history); body updated to cite committer canonical |
| Discord templates `[gitter-*]` (if any; locate via grep) | rename to `[committer-*]` |

### §Schema shim — value-level (not field-level)

```ts
// src/schema/team.ts (sketch)
const TeamMemberRoleEnum = z.enum([
  "team-lead",
  "planner",
  "reviewer",
  "ombudsman",
  "committer",
  "gitter",  // legacy alias; deprecation-warn; removed after one release cycle
  "member",
]).transform((value) => value === "gitter" ? "committer" : value);
```

The `.transform()` canonicalizes on parse — every downstream consumer sees `"committer"` regardless of which legacy / canonical value was in the source JSON. Deprecation-warn fires once per parse via a side-channel (e.g. doctor probe).

### §Special case — kanban Task owner field

Existing kanban rows may have `owner: "gitter"` literal (kanban Task assigned to the gitter member by id, not by role). Per ADR-136 id immutability, those rows STAY — `id: "gitter"` is canonical for the member. Owner field is by-id, not by-role. No migration needed.

Tasks filed AFTER this ADR may have `owner: "gitter"` (matching the current member's id) — that's still valid + stays. The role enum rename is orthogonal to the member id.

### §EPIC-done definition

ADR-159 completes when:
1. TR1 lands — this ADR commits.
2. TR2 lands — source rename via `git mv` + import rewrites + tests.
3. TR3 lands — schema accept-both + transform + cron alias + tests.
4. TR4 lands — briefs + docs + ADR-134/145/146 §Amendments + CHANGELOG + memory + global CLAUDE.md propose.

## Consequences

### Enables

- Clearer vocabulary (no chat-app brand collision).
- OSS-canon term for the role; reduces operator-onboarding friction.
- Joins ADR-158/160 in same-cycle SV register sweep.
- Committer joins ADR-161 default-role set with `_-prefix` rendering.

### Does NOT cover

- Member id rename (`id: "gitter"` stays immutable per ADR-136).
- Branch name rename (`<base>-gitter` stays per ADR-136).
- Worktree path rename (per ADR-082/084 cage-tier path stays).
- Removal of ADR-134/145/146 prose mentioning "gitter" — append-only per ADR convention.

### Rollback path

- Source rename: `git revert` the rename commit.
- Schema shim: stays in place (additive); operators using either value keep working.
- Member label: `atmux member rename --to "gitter"` reverts display.

### Reuse statement

- Rename mechanic: ADR-133 / ADR-158 — reused.
- ADR-136 label-vs-id split: consumed.
- ADR-161 default-role + `_-prefix`: consumed.
- Schema accept-both pattern: ADR-133 cockpit-key shim adapted to enum-value level.

## Open questions

1. **Cron-line legacy alias removal timing**. `atmux gitter --sweep` alias to `atmux committer --sweep` works during grace; after one release, alias is removed. **Planner recommendation**: align with the schema shim removal (same release cycle). Reviewer can flip.

2. **`role: "gitter"` in active kanban rows** — do we migrate them on schema parse? **Planner recommendation**: NO. Owner field is by-id; role enum is for member lookup. The schema shim handles role-value transform at parse time; no row-level mutation needed. Reviewer can flip if they want a doctor-probe that flags legacy role values in existing rows.

3. **Member id rename ever?** Out of scope here (ADR-136 immutability). If operator pushback shows up, file a separate ADR addressing id mutability + the cascading branch/worktree/kanban migrations.

## Cross-references

- [ADR-133](133-medic-rename.md) — rename-mechanics precedent.
- [ADR-134](134-in-team-auto-merger.md) — merger / expanded gitter role; gets §Amendments annotation.
- [ADR-136](136-hot-rename-member-labels.md) — id-vs-label split; this rename lands in label layer.
- [ADR-145](145-atmux-adopts-gitter.md) — gitter spawn pattern; gets §Amendments annotation.
- [ADR-146](146-kanban-auto-files-trunk-merge.md) — auto-files trunk-merge on Story-done; gets §Amendments annotation.
- [ADR-158](158-martinet-to-sentinel-rename.md) — sibling vocabulary rename (sentinel).
- [ADR-160](160-*.md) — sibling vocabulary rename (poke).
- [ADR-161](161-default-member-prefix-and-sort-verbs.md) — committer joins default-role set; gains `_-prefix`.
- Driver-ref: 2026-05-16 driver session.
- Memory [[feedback_atmux_no_gitter_worker_commits]] — gitter policy reversal; gets body update post-rename.
- Project [CLAUDE.md](../../CLAUDE.md) §Docs Discipline.
