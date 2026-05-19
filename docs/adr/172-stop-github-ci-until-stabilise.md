# ADR-172: Stop GitHub Actions CI on geoyws/atmux until things stabilise

**Status:** Accepted
**Date:** 2026-05-18
**Authors:** George Yong (operator directive, 2026-05-18 ~14:54 MYT)
**Cross-refs:**
- `~/work/unum/src/root/docs/decisions/ADR-0057` (parallel decision for u-n-u-m/root — same rationale, same re-enable criteria)
- `sapiensia/root` — separate parallel ADR pending (repo not locally cloned on hax; ADR to land when next pulled)

---

## Context

GitHub notification spam audit on 2026-05-18 14:51 MYT showed `geoyws/atmux` contributed **573 of 1189** total notifications (48%), all `ci_activity` failures of the single `ci-bun` workflow chronically red across `geoyws`, `geoyws-gitter`, `geoyws-planner`, and other member branches.

atmux is developed locally on hax inside the atmux cage (`~/work/src/atmux/`) by an atmux-team-of-agents. The team runs `bun test` locally before every commit; the local pre-commit hook covers lint + typecheck. The `ci-bun` GH workflow added zero merge-gating signal beyond what local already provided, and its persistent red state was both noise and false signal (it implied breakage that wasn't actually breaking local dev).

Re-greening `ci-bun` would have required either pinning bun version to whatever GH's runner image carries, or maintaining a per-branch ignore list as members rotate. Neither was worth the maintenance cost pre-ship.

## Decision

**Disable `ci-bun` until atmux stabilises.** Disabled 2026-05-18 ~14:57 MYT via `gh workflow disable "ci-bun" -R geoyws/atmux` — state now `disabled_manually`.

Replacement: local `bun test` runs via the existing pre-commit hook + `.atmux/lead-outbox.md` member self-reports (members commit only after `bun test` green; reviewer audits). No PR workflow change — atmux uses direct-to-`main` commits from member branches via `atmux gitter`, and that continues.

## Consequences

**Positive**
- Notification spam drops by ~48% (the largest single contributor).
- Member branches stop accumulating red checks that nobody reads.

**Negative**
- Outside contributors (none right now) lose the CI badge as a public health signal.
- Future-self with stale memory may assume CI exists; mitigation = this ADR + the parallel `[[verify-intentional-state-before-drift-surface]]` memory in the unum tree.

## Re-enable criteria

Re-enable `ci-bun` when:

1. atmux has a stable bun-version pin (`.tool-versions` or `engines.bun`) that matches what we want GH to run
2. Local `bun test` is reliably green on `main` for ≥1 week (the workflow should mirror local, not impose stricter conditions)
3. There is an actual outside observer or contributor who would benefit from the badge — pre that, the workflow is internal-only and adds no value over local

Re-enable is a single command: `gh workflow enable "ci-bun" -R geoyws/atmux`. Treat it as a deliberate policy reversal, not routine cleanup.
