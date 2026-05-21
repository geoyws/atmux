# ADR-216: Retire the default-member `_`-prefix convention — ADR-161 superseded; member IDs drop the underscore going forward

**Status**: Accepted — ratified by driver 2026-05-21 (ADR-161 default-member `_`-prefix convention retires; new members + new teams use bare IDs going forward; existing `_`-prefixed IDs stay per ADR-136 immutability — mixed teams accepted; Zod regex `^_?[a-z][a-z0-9_-]*$` covers both forms; doctor probe member-id-underscore-residue is info-level only; TR2 commit 5b5981d source stays as no-op back-compat; ADR-135 cockpit window `_`-prefix convention NOT affected — different scope; cleanup-EPIC purges dead role-aware branch in buildWindowName when convenient; §OQ recommendations as-written; sibling simplification to ADR-211/212/213/214/215 batch ratified same session)
**Date**: 2026-05-21
**Driver-ref**: 2026-05-21 operator — *"okay let's retire the convention"* — after observing `geoyws-docs` / `geoyws-gitter` branches don't carry the `_`-prefix that ADR-161 specified for default members. Continuation of the same-session simplification arc (ADR-211/212/213/214/215 + this ADR).
**Supersedes**: [ADR-161](161-default-member-prefix.md) — the `_`-prefix convention for default-member IDs (`_committer`, `_gitter`, `_jury`, etc.) retires. The historical impl work (ADR-161 TR2 commit `5b5981d` + the buildWindowName role-awareness shim) stays in tree as no-op back-compat — member IDs already present with the underscore continue to parse + render; new teams + new members use the no-underscore form.
**Cross-refs**: [ADR-136](136-hot-rename-member-labels.md) (member id immutability — `gitter`/`_gitter` ids that exist stay as-is; never rewrite ids), [ADR-159](159-rename-gitter-to-committer.md) (role-type rename gitter→committer; member id stays `gitter` per ADR-136 — this ADR documents the consequence: `gitter` never carried the underscore per memory `project_adr_161_tr2_shipped` *"committer/gitter omitted pending ADR-159"*), [ADR-135](135-cockpit-naming-convention.md) (cockpit window `_`-prefix — DIFFERENT convention, scope: cockpit-tier windows like `_superdriver`; this ADR does NOT touch ADR-135), [ADR-211](211-retire-sentinel-role-distribute-to-honker-consumers.md) + [ADR-212](212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md) + [ADR-213](213-retire-jury-reviewer-absorbs-acceptance-criteria.md) + [ADR-214](214-retire-ombudsman-lead-absorbs-complaint-adjudication-via-honker.md) (sibling simplification ADRs — retired roles, left ADR-161 with fewer default members to differentiate).

## Context

ADR-161 (2026-05-16) introduced the `_`-prefix convention for system-managed default members — visually distinguish framework-injected roles (`_committer`, `_gitter`) from operator-named team members (`lead`, `planner`, `reviewer`, `be-1`, `fe-1`, etc.). The motivation was clarity: when an operator scans `atmux status`, the underscore tells them "this row is framework-injected, not my custom roster."

That convention has worn thin:

1. **Gitter never got the underscore.** Memory `project_adr_161_tr2_shipped` explicitly notes *"committer/gitter omitted pending ADR-159"*. ADR-159 renamed the role-type gitter→committer but kept the member ID immutable per ADR-136. So today `gitter` is a default member without the underscore + nobody migrated it. Branches read `atmux-geoyws-gitter` not `atmux-geoyws-_gitter`.

2. **Recent retirements (ADR-211/212/213/214) collapsed the default-member set.** Sentinel + Medic + Jury + Ombudsman all retire. The only remaining system-injected member is `_committer` (which also has the ID-immutability quirk — existing `gitter` ids never migrate). The convention covers ~1 future role, which doesn't justify the cross-callsite complexity.

3. **Window name + branch name conventions don't carry the underscore consistently.** `geoyws-docs` (no underscore), `geoyws-gitter` (no underscore). The underscore exists in member IDs in some teams + windows in some teams, but not consistently across the tree. Inconsistency adds cognitive load without paying back.

4. **Cockpit window naming (ADR-135) is a separate convention** — `_superdriver` / `_medic` / `_sentinel` prefix cockpit-tier windows. That convention has different scope + different justification + does not retire here. (ADR-135's value: distinguish cockpit-tier windows from team-viewer windows in a single tmux session. Still useful, even with most cockpit roles retired.)

5. **Operator simplification directive** (2026-05-21, same session as 4 role retirements): *"atmux is getting too complex and we need to simplify"* + *"atmux is too bloated"*. The `_`-prefix on member IDs is exactly the kind of convention worth retiring under that directive.

## Decision

### D1 — Retire the `_`-prefix convention for default-member IDs

No new code paths apply the `_`-prefix to default-member IDs. Specifically:

- **New teams created via `atmux team bootstrap` / `atmux init`** — default members named without underscore: `committer`, `gitter`, etc. (whichever defaults survive the retirements).
- **`atmux team add-member` + `atmux team add-default-member`** — no underscore.
- **`buildWindowName` (ADR-161 TR2)** — drops the role-aware underscore-prefix branch; renders member ID verbatim with emoji.
- **Code paths that hard-code `_committer` / `_gitter` as literal strings** — adjusted in cleanup-EPIC. Zod schemas accept BOTH forms (Zod `.transform()` canonicalizes by stripping leading underscore for new writes; existing rows with `_` stay readable).

### D2 — Existing IDs with underscore stay (ADR-136 immutability)

Per ADR-136, member IDs are immutable for git-history + audit-trail continuity. So teams already shipping with `_committer` / `_gitter` member IDs **keep those IDs forever**. No retroactive rename — that would break git blame chains + decisions.md cross-refs + every reviewer signoff that named the member.

Mixed teams are accepted: some members with `_`-prefix (legacy), some without (new). The atmux runtime treats them identically (Zod schema accepts both regex `^[_a-z][a-z0-9_-]*$`).

### D3 — Schema-level acceptance

`src/schema/team.ts::TeamMember::name` regex extends to accept both:
- `^[a-z][a-z0-9_-]*$` (preferred, no leading underscore)
- `^_[a-z][a-z0-9_-]*$` (legacy, leading underscore)

Combined: `^_?[a-z][a-z0-9_-]*$`. Same regex covers both classes.

Window names follow the member ID verbatim (no role-aware underscore-prefix addition).

### D4 — Doctor probe

Single probe row `member-id-underscore-residue` (info-level — NOT yellow) lists any team with a member ID carrying the underscore-prefix. Informational only; ADR-136 prevents rewriting them, so the row is just visibility.

Merges with the consolidated `retired-role-config-residue` probe per ADR-211/212/213/214 cleanup-EPIC scope.

### D5 — What persists from ADR-161

- **TR2 commit `5b5981d` source code** — stays in tree (no-op back-compat behavior; doesn't apply underscore for new members + still accepts legacy underscored IDs).
- **`buildWindowName` helper** — stays, but the role-aware branch becomes inert.
- **The 16 verb call-sites threaded with TR2** — no changes; they handled both prefixed + non-prefixed IDs already.

### D6 — Sequencing

Retires alongside sentinel/medic/jury/ombudsman in the same simplification wave. Cleanup-EPIC purges the dead `_`-prefix branch in `buildWindowName` + drops the role-aware comment hints. No code action required until the cleanup-EPIC ships; ADR-216 is doc-only until then.

## Consequences

**Becomes easier:**

- One fewer cross-callsite convention to remember
- New teams + new members consistent (no `_`-prefix anywhere)
- Branch naming consistent (`<base>-<member>` always, no underscore variant)
- Less surface for "why doesn't this work?" investigations (the gitter inconsistency surfaced 2026-05-21 is the canonical example)

**Becomes harder:**

- Mixed teams (some members with underscore, some without) need visual triage rules — operator scans naming pattern, infers default-vs-custom from role field instead of ID prefix
- Documentation references to `_committer` / `_gitter` patterns become historical; new docs use bare names

**Risks + mitigations:**

- **Risk**: Code path hard-codes `member.id === "_committer"` literal check; after retirement, new teams' `committer` member ID fails the check. **Mitigation**: cleanup-EPIC audits + updates literal-string equality checks to test `name.replace(/^_/, '')` or use `role` field instead of `id` for default-member detection.
- **Risk**: Operator habits expect `_`-prefix for default members. **Mitigation**: doctor probe (D4) makes the residue visible; tabular `atmux status` rendering can group by `role` field instead of relying on ID prefix.

## Out of scope (deferred)

- **Retire ADR-135 cockpit window naming convention** — different scope (cockpit-tier windows like `_superdriver`); not affected by this ADR. Separate decision if/when operator chooses.
- **Retroactive rename of existing underscored member IDs** — explicitly forbidden per §D2 + ADR-136 immutability.
- **`atmux team migrate-ids` verb** to bulk-rename underscored IDs to bare forms — out of scope; not worth the git-history break.

## References

- ADR-161 — Default-member `_`-prefix (this ADR supersedes)
- ADR-136 — Member id immutability (preserves existing underscored IDs)
- ADR-159 — gitter→committer role-type rename (explains why gitter never got the underscore)
- ADR-135 — Cockpit window naming convention (different scope; NOT affected by this ADR)
- ADR-211/212/213/214 — sibling simplification ADRs (retired 4 default-member roles, leaving ADR-161 with fewer roles to differentiate)
- memory `project_adr_161_tr2_shipped` — TR2 shipping note + the "committer/gitter omitted pending ADR-159" exclusion that drove the inconsistency
- memory `feedback_atmux_no_gitter_worker_commits` — gitter→committer rename context
