# CONVENTION-059 — Generic indexed member naming (`fe0` / `fe1` / `be0` / `be1`)

> **Status**: accepted 2026-05-14 · George Yong  
> **Source**: driver-inbox.md 2026-05-07 17:36 entry bundle 5 · kanban Task `t-05ad3bb4`  
> **Not an ADR** — workflow convention.

## TL;DR

For **fungible** team members (those filling a generic lane slot, not a
named role), use the pattern:

```
<lane><index>
```

- `<lane>` is one of the canonical lane slugs: `fe`, `be`, `ops`,
  `test`, `review`, `db`, `misc`.
- `<index>` is a **zero-indexed** integer: `0`, `1`, `2`, ...

**Examples**: `fe0`, `fe1`, `be0`, `be1`, `ops0`, `test0`.

**Not examples**: `fe-1` (hyphenated, 1-indexed), `eng-mobile` (domain-named),
`frontend1` (un-abbreviated), `feA` (non-numeric index).

Named roles (`lead`, `planner`, `reviewer`, `gitter`, `auditor`, `dba`,
`devops`, `discorder`, `enforcer`, `unblocker`) are **out of scope** for
this convention — they keep their canonical names.

## Why this exists

Three reasons, weighted by frequency of impact:

1. **Generic talk works across teams.** A skill brief or runbook that
   says "the lead pings `fe0` to claim the next FE task" reads
   identically on `sopx`, `unum`, `atmux`, and any new team. With
   domain-named members (`eng-mobile`, `eng-watchos`), the same brief
   has to be rewritten per team or risks naming things that don't
   exist there.
2. **Failover swaps are name-stable.** Rotating `fe0` from `.claude-X`
   to `.claude-Y` (per ADR-056 account-swap) doesn't churn the member's
   name — just the spawn account. The lane stays `fe`, the slot stays
   `0`, and every kanban Task that names `fe0` continues to address
   the same slot post-swap.
3. **Superdoctor + watchdog templates already assume it.** The
   `clear-member:fe0` action string in the ADR-077 §F6 attempts log
   already uses this shape. Codifying the convention means existing
   tooling references aren't bespoke.

## The rule

| Aspect            | Rule                                                          |
|-------------------|---------------------------------------------------------------|
| **Indexing**      | Zero-indexed (`fe0`, `fe1`, NOT `fe1`, `fe2`).                |
| **Separator**     | None — `fe0` not `fe-0`.                                      |
| **Lane prefix**   | One of: `fe`, `be`, `ops`, `test`, `review`, `db`, `misc`.    |
| **Case**          | Lowercase (enforced by `MEMBER_NAME_REGEX` in `src/core/common.ts`). |
| **Max index**     | Single digit (`0`-`9`) for most teams; `10+` allowed for ≥10-member lanes. |
| **Role field**    | `"member"` (these are fungible workers, not named roles).     |
| **Lane field**    | Set to the lane slug (matches the prefix): `lane: "fe"` for `fe0`. |

Existing `MEMBER_NAME_REGEX = /^[a-z][a-z0-9_-]{0,30}$/` already accepts
all valid CONVENTION-059 names — no schema break needed.

## When to use it (and when not)

**Use indexed naming when**:

- The member fills a generic lane slot (FE engineer, BE engineer, ops,
  QA tester) and would be interchangeable with any other worker in the
  same lane.
- You expect the team to scale workers up or down within a lane —
  `fe0`, `fe1`, `fe2`, drop `fe2` when load drops.
- A skill brief or runbook needs to address the member generically
  across teams.

**Use a named role when**:

- The member is a singular role with team-wide responsibility: `lead`,
  `planner`, `reviewer`, `gitter`, `auditor`, `dba`, `devops`,
  `discorder`, `enforcer`, `unblocker`. These are named in the
  reserved-roles list in `templates/briefs/`.
- The member's work is genuinely specialized to a stack the team will
  always have one of (e.g. `db` for the single DBA member on a team
  with one DBA).

## Soft validation

A pure helper `checkIndexedMemberName(name)` in `src/core/common.ts`
returns `null` when the name matches the CONVENTION-059 pattern, or a
human-readable reason string otherwise. The validator is **advisory**:
it's surfaced where useful (suggest-but-don't-block) and never throws.
Existing names that don't match (e.g. `whip-impl` on the atmux team,
`eng-mobile` on the unum team) continue to work — this convention is
forward-looking for new members + the migration path below.

Reasoning: hard-rejecting non-indexed names would break sopx (`fe-1`),
unum (`eng-mobile`), and atmux's own role-shaped members
(`whip-impl`, `parity-cron-impl`). Those are deliberate names that
predate the convention. CONVENTION-059 captures the *target* shape;
migration happens at member-rename or team-restart time, not on
schema-validation.

## Migration plan

Migrating an existing team to indexed names:

1. **Identify candidate members.** Members with `role: "member"` and a
   non-indexed name (e.g. `fe-1`, `eng-mobile`) are migration
   candidates. Members with named roles (`lead`, `reviewer`,
   `planner`, etc.) are NOT.
2. **Open a follow-up kanban Task per team.** The rename is a
   team-mutating operation that touches `.atmux/team.json`,
   worktrees, tmux window names, kanban `owner` strings, and any
   in-flight inbox messages. Each team owns its own migration; the
   convention doesn't dictate when.
3. **Pick a quiet window.** Rename during a `/team stop` cycle so
   in-flight panes don't get orphaned. Pattern: `/team stop` →
   edit `.atmux/team.json` → rename worktree directories under
   `.atmux/worktrees/` → re-bootstrap with `/team start`.
4. **Kanban owner rewrite.** SQLite update over `tasks.owner`:
   `UPDATE tasks SET owner = 'fe0' WHERE owner = 'fe-1';`. Same for
   `tasks.claimed_from`. The `complaints` + `superdoctor_attempts`
   tables don't carry owner strings, so they're untouched.
5. **Window-name fallout.** Tmux window names are
   `__<team>__<member>`; the `/team start` re-bootstrap regenerates
   them from the new `team.json`, so step 3's stop+start handles this
   transparently.

No team is required to migrate by any deadline — this is a "when you
touch it" upgrade.

## Briefs that reference this convention

- `templates/briefs/member.md` — the canonical brief for `role:
  "member"` workers, points at this convention for naming guidance.

(Briefs for named roles — `lead.md`, `planner.md`, `reviewer.md`,
etc. — don't reference CONVENTION-059 because named roles are out of
scope.)

## Refs

- `src/core/common.ts::MEMBER_NAME_REGEX` — the underlying validity gate
  (regex unchanged by this convention).
- `src/core/common.ts::checkIndexedMemberName` — soft helper added in
  the same commit as this doc; advisory-only.
- CONVENTION-067 (`docs/CONVENTION-067-develop-branch-integration.md`) —
  sibling convention; both are workflow conventions.
- Kanban Tasks `t-05ad3bb4` (this convention).
