# ADR-137: Merge over rebase for intra-team trunk integration

**Status**: proposed
**Date**: 2026-05-14
**Parent task**: t-f35bfefc
**Driver-ref**: 2026-05-14 driver session — operator on force-push surprise after parity-cron-impl's trunk-advance (t-2411bee8) caused whip-impl + parity-read-impl to rebase + force-push: *"next time this shouldn't happen again correct? let's make it not happen again? force push is weird?"*. Operator picked Path A (merge over rebase) over Path B (short-lived task-branches) + Path C (auto-authorize force-push) for the standing convention.

## Context

### Per-member-branch substrate makes rebase the wrong default

[ADR-082](082-worktree-isolation-per-member.md) + [ADR-084](084-worktree-per-member-branch-model.md) put every member on a long-lived `<base>-<member>` branch in its own worktree. The substrate is correct (it unblocks 20+ member concurrency for the demo-week constraint that drove ADR-082), but it changes the consequence of `git rebase origin/<base>`:

- **Pre-ADR-082 single-trunk teams**: a member rebased their working branch when trunk moved, then force-pushed. The force-push was their private artifact — no one else watched that branch.
- **Post-ADR-082 per-member-branch teams**: the member's branch `<base>-<member>` IS the worktree's checkout AND the published artifact other members (and the upcoming gitter, ADR-134) read from. A rebase forces a force-push, and the force-push:
  - Triggers the harness deny-rule on non-`*-staging` branches (the operator sees "force-push blocked" prompts).
  - Diverges the worktree's HEAD from `origin/<base>-<member>` until the force-push completes, surfacing as confusing `git status` output.
  - Invalidates any sibling worker's `git fetch` view of the branch — the SHA they last saw is now reachable only via `reflog`.

### Observed incident — 2026-05-14 trunk advance

The parity-cron-impl Task `t-2411bee8` advanced `geoyws` trunk with a merge of three docs+impl branches. Two members downstream (whip-impl + parity-read-impl) attempted to sync via `git rebase origin/geoyws`. Both then hit the "force push to non-staging branch" deny in the harness, surfacing the question that this ADR answers: *"why are we force-pushing as part of routine work?"*

Underlying cause: `rebase` is the wrong tool for the long-lived branch model. The right tool is `merge`.

### Why Path A (merge), not Path B (short-lived branches) or Path C (auto-authorize force-push)

Three paths surfaced in the driver session:

- **Path A — merge over rebase** (this ADR). Smallest convention change. Eliminates routine force-push by replacing the operation that requires it. Tradeoff: criss-cross history inside member branches (acceptable; bounded once epic-teams ship per the operator's accompanying observation).
- **Path B — short-lived task-branches**. Members cut a new branch per Task, merge to base on done, delete. Bigger architectural change — rewrites ADR-084's per-member-branch model. Defer until evidence shows long-lived branches cause problems beyond force-push (today they don't).
- **Path C — auto-authorize force-push on non-staging branches**. Lowers the safety bar; "force-push is destructive" intuition violated; loosens harness deny on WIP branches. Path of least resistance but worst for operator-visible noise — every routine sync surfaces a force-push prompt and the operator habituates to clicking allow, weakening the deny rule for cases where it *should* matter.

Operator picked **A** with an accompanying insight: *"once we do epic-teams we will not have this cross-cross thing"* — epic-teams bound the criss-cross to the epic's lifetime, so Path A is the right stopgap until ADR-089/090/091/092 land + epic-teams replace the long-lived single-tier branches.

## Decision

### (D1) Members MUST integrate trunk via `git merge`, NOT `git rebase`

When a member's branch falls behind base (`<base>-<member>` is behind `origin/<base>`):

```bash
# CANONICAL — picks up trunk advance, criss-cross is acceptable
git -C <worktree-root> fetch origin
git -C <worktree-root> merge origin/<base> --no-edit

# FORBIDDEN — forces a force-push for no benefit
git -C <worktree-root> rebase origin/<base>
```

The merge commit lands on the member's branch with the default `Merge branch 'origin/<base>' into <base>-<member>` subject. Reviewer doesn't gate routine merge commits (the merge itself isn't a code change; the trunk-advance commits were already reviewer-gated upstream).

### (D2) Applies to intra-team scope only

| Scope | Convention | Rationale |
|---|---|---|
| **Intra-team trunk → member sync** (`geoyws` → `geoyws-<member>`) | **Merge** (this ADR) | Per-member branches are long-lived; force-push noise unacceptable |
| **Epic-team trunk → epic-team-member sync** (post-ADR-091, one nesting level deeper) | **Merge** (this ADR, extended) | Same long-lived-branch reasoning; same Path A choice |
| **Epic-team-base → parent-trunk fan-in** (ADR-091 gitter scope) | **Rebase-then-merge** (per ADR-091 pre-flag #4) | Different layer — gitter operates in its own cage with auto-authorized force-push on the epic-team-base only; rebase keeps the parent-trunk history linear |
| **Member-initiated history cleanup** (squash, interactive rebase, fixup) | **No constraint** (voluntary, this ADR doesn't govern) | Different intent — this ADR only governs trunk integration |
| **Final fan-in via gitter** (ADR-134) | **No constraint** — gitter handles whatever internal shape members chose | Gitter's merge into team-trunk works on either rebased or merged member-branch shape |

### (D3) Doctor probe + Discord template warn on violation

`atmux doctor` gains a new probe `member-forcepush-recent`. The probe reads `git reflog` per member-branch worktree for force-push events (`forced-update` ref-log entries) in the last 1 hour. On hit:

- Doctor reports it as a **warn-class** issue (yellow, not red) with hint `did you mean to merge instead of rebase? See ADR-137.`
- Discord template `[member-forcepush-warning]` fires once per detection window (30-min dedup keyed on `<team>:<branch>`).
- The probe does NOT block any operation — it's a nudge, not a gate. The harness force-push deny remains the actual gate; the doctor probe is the post-hoc surface for cases where the operator authorized the force-push and the team-lead wants to know it happened.

This is deferred to the second commit on this Task per the task body's reviewer-split sanction; the first commit (this ADR + brief + project-CLAUDE.md) lands the convention, the second adds the probe + template + test.

### (D4) Acceptable criss-cross — bounded by epic-team lifetime

Merging trunk into each member-branch creates a criss-cross pattern in the git log (each member-branch's history shows a series of `Merge origin/<base>` commits interleaved with the member's own work). Two reasons this is acceptable:

1. **Final fan-in collapses it**. Once gitter (ADR-134) merges the member's branch back into team-base with `git merge --no-ff geoyws-<member>`, the trunk's view of the work is one merge commit per fan-in — the criss-cross inside the member-branch is hidden behind the fan-in merge.
2. **Epic-teams bound the criss-cross lifetime**. Once ADR-089/090/091/092 land (hierarchical cockpit + epic-team-lifecycle + epic-team-auto-merge + cross-team tell-lead), member-branches are scoped to the epic's lifetime (typically days, not weeks). The criss-cross window is the epic, not the project; the cumulative pollution stays small.

## Tradeoffs

### Why not require `--no-edit` on the merge

Default merge message (`Merge branch 'origin/<base>' into <base>-<member>`) is descriptive and consistent. Forcing operators to write per-merge subjects on routine trunk advances adds friction without value. The merge commit message is signal-free unless the merge IS the work (e.g. a feature-branch landing); routine trunk-sync merges should be ignorable in `git log --oneline`.

### Why not require `git merge --ff-only`

`--ff-only` refuses merges that require a true merge commit (i.e. when the member's branch has diverged from base). For trunk integration after the member has done any work, the merge will always be non-fast-forward, so `--ff-only` would refuse the operation. That's exactly the case this ADR is solving — the merge must be allowed to create a merge commit.

### Why not require operator manual sync (no auto-merge of trunk)

Could mandate operator-only trunk sync via a `tell-lead` ask, eliminating member-initiated merges entirely. Two reasons this is overkill:

1. Members already know their branch is behind (the doctor probe + `git log origin/<base>..HEAD` make it visible). Routing through tell-lead serializes a parallelizable operation.
2. The operation is safe — `git merge origin/<base>` against a clean worktree is reversible (`git reset --merge`) and visible (creates a commit in the member-branch history). Operator-gating it adds latency without safety gain.

## Cross-references

- [ADR-082](082-worktree-isolation-per-member.md) — per-member worktrees (substrate this convention applies to)
- [ADR-084](084-worktree-per-member-branch-model.md) — per-member-branch model (why long-lived branches make rebase the wrong default)
- ADR-091 — epic-team auto-merge (different layer; rebase-before-merge stays canonical per its pre-flag #4)
- ADR-134 — intra-team gitter (final fan-in; works on either rebased or merged member-branch shape)
- ADR-089/090/091/092 — epic-team chain (criss-cross bounded once landed per operator insight 2026-05-14)
- Origin force-push incident 2026-05-14: t-7e7031dc (whip-impl tmux prefix-chain rebase + force-push) + parity-read-impl's similar rebase modal — both surfaced the cost of rebase-as-default in the per-member-branch model

## Open questions

None. Both architectural alternatives (Path B short-lived branches, Path C auto-authorize force-push) were considered and rejected in the driver session that authorized this ADR.

## Implementation

This commit ships the convention as docs:

1. `docs/adr/137-merge-over-rebase.md` — this file.
2. `templates/briefs/member.md` — new §Trunk integration section mandating merge-over-rebase + linking back to this ADR.
3. `/CLAUDE.md` (project-root agent contract) — new §Trunk integration note under the Push Policy section.

Second commit (deferred per the task body's reviewer-split sanction):

4. `src/verbs/doctor.ts` — new `member-forcepush-recent` probe.
5. `src/abstractions/discord.ts` — new `[member-forcepush-warning]` template + dedup keying.
6. `tests/unit/verbs/doctor.test.ts` — coverage for the new probe.
7. `tests/unit/abstractions/discord.test.ts` — coverage for the new template.

## Acceptance gates

- [x] `docs/adr/137-merge-over-rebase.md` exists with `Status: proposed` (this commit).
- [x] `templates/briefs/member.md` gains §Trunk integration mandating merge-over-rebase (this commit).
- [x] `/CLAUDE.md` gains §Trunk integration under Push Policy (this commit).
- [ ] `atmux doctor` reports zero `member-forcepush-recent` warnings on a fresh team that follows the new convention (second commit).
- [ ] Discord `[member-forcepush-warning]` template fires on synthetic force-push event in test (second commit).
- [ ] Reviewer-gated across the chain.
