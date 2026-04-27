# ADR-028: `main` / `master` is PR-only — agents never push directly

**Status**: accepted
**Date**: 2026-04-27
**Related**: [ADR-027](./027-team-rename-verb-and-topology-invariant.md) (rename verb), push policy memory `project_push_policy.md`

## Context

Agents (gitter, member-direct-commit roles, lead, unblocker) have demonstrated push capability via the existing tooling: `git push origin <branch>`, `atmux task add ... commit-Task ...`, `atmux dispatch gitter`. The previously-encoded push policy (memory `project_push_policy.md`) treated branch classes by allow/deny:

- WIP branches (`geoyws`, `sopx-geoyws`, `aix-geoyws`, `geoyws-beads`): agents auto-push OK.
- `*-staging` branches (`sopx-staging`, `aix-staging`, etc.): George-manual only — agents refuse.
- `main` / `master`: previously documented as "surface before any push" — too soft.

Driver feedback 2026-04-27 09:30 MYT: *"agents can never push to main/master. that is PR-only domain."*

The "surface before any push" framing leaves room for agents to interpret edge cases (a Task body says "push to main"; a CI pipeline says "merge fix"; a stale config has `branch.foo.merge = refs/heads/main`). Soft policy = drift risk. The actual invariant George wants is **hard refuse**: `main` / `master` is exclusively the PR-merge target, not an agent push destination — even with explicit driver authorisation in conversation. The path to `main` is open-PR → review → merge-via-Github (or equivalent), with a human being the merger.

This is also why the existing `lib/stop.sh` refuse-gate model is the right precedent: certain destructive ops are short-circuited regardless of caller intent. Push-to-main is now in that class.

## Decision

**Hard refuse-gate at every push surface for `main` / `master`:**

1. **`gitter` brief**: explicitly forbids `git push origin main` / `git push origin master` / any push whose target ref is `refs/heads/main` or `refs/heads/master`. Even if a Task body or driver-inbox entry instructs the push, gitter SURFACES THE ASK BACK to driver via lead-outbox + refuses to fire.
2. **Reviewer brief**: blocks any Story signoff whose acceptance criteria mention "merge to main" or "push main" — only acceptable phrasing is "open PR against main" / "PR-ready". Reviewer flips the Story back to `in-progress` with the reason logged.
3. **Lead brief**: refuses to dispatch a commit-Task or push-Task whose `note` field references `main` / `master` as the push target. Lead surfaces to driver-inbox + does NOT route.
4. **Unblocker brief**: cannot itself execute pushes; observes git state. If unblocker detects local HEAD matches `main` / `master` AND there are unpushed commits, it ESCALATES to driver-inbox with a `🚨 main-direct-commit detected` flag — does NOT propose `git push` as a fix.
5. **Tooling refuse-gate** (post-ADR follow-up Task): a new helper `atmux::guard_push_target <branch>` invoked from `gitter` flow that hard-`atmux::die` if branch matches `^(main|master)$` regardless of remote URL. Failure surface mirrors `lib/stop.sh`'s refuse-gate. Bats coverage: 4 cells (push-main / push-master / push-mainline-via-config / push-allowed-WIP).

**The PR path (the ONLY allowed route to `main` / `master`):**

- Agents may prepare PR-ready branches (commit work to feature branch, push to remote).
- Agents may compose draft PR body (markdown describing scope + test plan).
- Agents may open a Github PR using `gh pr create --base main --head <wip-branch>` — opening a PR is NOT pushing-to-main.
- The merge itself (PR → main) is **human-clicked** in Github UI (or `gh pr merge` invoked by the human). No agent runs `gh pr merge` without driver-explicit-per-PR-call.

**This applies fleet-wide**: atmux, ifca_sopx, ifca_aix, unum_beads, and all future teams. Lead briefs across all teams must carry the refuse-gate reference.

## Consequences

- **PR-discipline becomes structural**, not procedural. Agents physically cannot push to `main` / `master`; the policy is enforced by tooling, not by goodwill.
- **Edge cases get surfaced, not interpreted.** A misconfigured `branch.foo.merge` pointing to `refs/heads/main` (the same shape as the aix-root upstream-misconfig incident, but pointing to main instead of staging) hits the refuse-gate and surfaces — agents do not auto-correct or auto-push.
- **Driver-explicit `--force-push-main` flag is NOT introduced.** The escape hatch is "George does it manually outside the agent stack" — no agent gets a path through the gate, even with a flag, because flags drift in autonomous mode.
- **Reviewer's job widens slightly**: must scope-check Task acceptance criteria for the prohibited phrasing. Bats coverage on the reviewer brief verb tests this.
- **Initial implementation is brief-only** (text-level enforcement) until the `atmux::guard_push_target` helper lands. Brief-level enforcement is sufficient for trustworthy agents (Opus + xhigh) but the helper is the load-bearing version.
- **`master` included alongside `main`** for forward-compat with any older repo that still uses `master` as the protected line. Same refuse-gate applies; reviewer/gitter check both names.
- **Open-PR is encouraged.** Agents that hit the refuse-gate should propose "open a PR" as the next step rather than waiting passively. Lead's whip-cycle mints the PR-prep Task (commit-clean → branch push → `gh pr create` draft) when work is ready.

## References

- [ADR-027](./027-team-rename-verb-and-topology-invariant.md) — rename verb push-state guards (similar refuse-gate pattern)
- `project_push_policy.md` — fleet-wide branch-class push policy (this ADR fixes the `main` / `master` row to "hard refuse")
- Driver feedback 2026-04-27 09:30 MYT — "PR-only domain" framing
- `lib/stop.sh:39` refuse-gate — implementation precedent for hard short-circuit on destructive ops
