# atmux — Business Requirements Document

**Status**: proposed
**Date**: 2026-08-06
**Owner**: driver (George Yong)
**Pairs with**: [docs/PRD.md](../PRD.md) — this BRD states WHY and FOR WHOM; the PRD states WHAT is shipped and planned. Neither enumerates the other's content.
**Driver-ref**: operator-direct 2026-08-06 — *"i need atmux to track plans and todos so that they're never lost even if agents run out of tokens and then another agent can easily take the previous agent's place. i need agents to always use atmux as a way to track todos and to update work done and to keep all plans and intents in atmux so that the git repo can be clean of our artifacts and my team members won't need to see my todo artifacts. and i need atmux to note the branches that we're working with across monorepos recursively as well."* Follow-up, same day: *"atmux is meant to assist in agentic dev."*

**Organising thesis (operator, 2026-08-06): atmux is meant to assist in agentic dev.** Every requirement below is justified against that sentence. A requirement that does not make agentic development cheaper, more continuous, or safer for the operator's working environment does not belong in this document.

---

## 1. Purpose + scope of this document

### 1.1 What this document is

This BRD records the **business intent** behind atmux: the problem being paid for, who bears the cost, what outcome counts as the problem being solved, and what atmux deliberately refuses to become. It is the upstream artifact that a PRD requirement and an ADR decision can both be traced back to.

It does **not** enumerate the shipped surface. Verbs, schemas, state machines, role rosters, and preset modes live in [docs/PRD.md](../PRD.md) §3 onward and in [README.md](../../README.md). Where this BRD names a mechanism, it names it only to make a business requirement falsifiable — never as a specification.

### 1.2 Authority order

atmux already runs on a fixed authority chain, stated in `CLAUDE.md` §Source-of-truth:

> **ADRs (`docs/adr/`, append-only, numbered, monotonic) → docs (`docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/RUNBOOK-*.md`, `README.md`, `CHANGELOG.md`) → code. The ADR wins when a doc disagrees.**

A BRD sits **upstream of the PRD in intent and below every accepted ADR in authority**:

- A BR is the *reason* a PRD requirement exists. When the PRD and this BRD disagree about intent, this BRD is the intent of record and the PRD is stale — file the PRD correction.
- **A BR never overrides an accepted ADR.** If a business requirement here conflicts with an accepted decision in `docs/adr/`, the correct move is to file a **new superseding ADR** citing this BRD as the driver-ref. It is never to ignore the ADR, and never to edit the ADR's Decision section — the tree is append-only.
- A BR is not self-executing. Business intent becomes binding on the fleet only once an ADR ratifies a mechanism and the PRD/RUNBOOK documents the surface.

### 1.3 Scope boundary

In scope: business problem, business requirements, stakeholders, non-goals, success measures, risks. Out of scope: mechanism design (ADRs), surface enumeration (PRD), operator procedure (`docs/RUNBOOK-*.md`), agent behavioural contract (`CLAUDE.md`).

---

## 2. The business problem

### 2.1 The failure mode being paid for

Agentic development has one expensive, structural failure mode:

> **An agent's plan lives in the agent's context, and that context is volatile.**

The plan — the decomposition, the ordering, the reason step 4 comes before step 3, the three things already ruled out — is the most valuable artifact the agent produces, and it is the artifact stored in the most perishable medium available. Token exhaustion, context-pressure rotation ([ADR-009](../adr/009-auto-rotation.md), trigger 30% context), refusal-pattern rotation ([ADR-139](../adr/139-refusal-pattern-auto-rotate.md)), `/clear`, and outright pane death all destroy it. Each of those events is routine, not exceptional: on a fleet running Opus lanes continuously, context death is the **expected** end state of every agent, not an incident.

atmux already survives this at the row level. Kanban rows live in SQLite on disk at `.atmux/state.db` ([ADR-126](../adr/126-sqlite-state-store.md)), so *what* was claimed survives by construction. The business problem is that **the WHY does not**. `atmux handoff <from> <to>` (`src/verbs/handoff.ts`) captures narrative on a death-bed, best-effort basis: it asks the source pane to write a summary and polls for `ATMUX_HANDOFF_WAIT` seconds (default 30, `src/verbs/handoff.ts:345`), falls back to a `tmux capture-pane` tail of `ATMUX_HANDOFF_LINES` lines (default 500, `src/verbs/handoff.ts:347`), and when the source window is already gone writes a *"source pane gone"* stub (`src/verbs/handoff.ts:11`). So at precisely the moment the operator cares about — agent out of tokens, context dead, pane gone — the plan prose degrades to a scrollback tail or to nothing.

There is also no cheap way for a *living* agent to journal intent incrementally. `atmux task update --body <text>` **replaces** the body (`src/verbs/task.ts:346`: empty `--body ""` clears it), and no `--note` flag exists on `atmux task update` at all. `--note` is available on sibling verbs — `atmux done` (`src/verbs/claim.ts:68`), `atmux member status` (`src/verbs/member.ts:1104`), `atmux story` (`src/verbs/story.ts:585`), `atmux complaints` (`src/verbs/complaints.ts:193`) — but not on the one verb that owns a task's plan text, and `atmux done` only fires at the end, when the plan no longer needs carrying. Incremental "here is what I just learned / what I am about to do" logging therefore requires a read-modify-write of the whole body, which is a clobber hazard, so agents rationally skip it and keep the plan in context, which is exactly where it dies.

### 2.2 Who pays, and in what currency

The cost does not land on the agent. It lands on the operator, four ways:

1. **Rework.** A replacement agent that inherits rows without intent re-derives the plan. Re-derivation is not free and is not reliably identical — it silently re-litigates decisions that were already settled, including ones settled *against* the obvious answer for a reason nobody recorded.
2. **Lost intent.** Some intent is unrecoverable by re-derivation, because it encoded a fact discovered at runtime (a failing repro, a dead end, an upstream API quirk). That is destroyed work, not delayed work.
3. **The operator is the only durable memory in the system.** When the plan dies with the agent, the operator is the sole remaining copy. Re-explanation is therefore mandatory, personal, and repeated — per agent, per rotation, per lane. This is the specific cost the operator named on 2026-08-06.
4. **Throughput is capped by operator attention, not by agent capacity.** This is the load-bearing consequence. If every lane's continuity depends on the operator re-explaining, then N parallel lanes cost O(N) operator interruptions, and the fleet's real ceiling is how many re-explanations one person can issue per hour — which is a small number, and it does not grow when the fleet grows. Adding agents past that point buys nothing. **The business case for atmux is removing the operator from the continuity path so that agent capacity, not operator attention, sets throughput.**

### 2.3 Two adjacent costs from the same root

The operator's 2026-08-06 ask names two further costs that share the "state has no proper home" root cause:

- **Artifact leakage into product repos.** atmux state co-located inside a managed product repo is a professional-boundary problem, not a tidiness preference. See BR4.
- **No record of the working branch set across nested repos.** IFCA products are submodule monorepos; a cross-repo snapshot is coherent only if every nested repo is on the intended branch, and today nothing records or verifies that. See BR6/BR7.

---

## 3. Business requirements

Each BR states the requirement, the business rationale, an **acceptance signal that is observable** (a command whose output settles the question — never a subjective judgment), current status, and the governing decisions.

### BR1 — Plan and intent survive agent replacement without operator re-explanation

**Requirement.** When an agent is replaced for any reason (token exhaustion, rotation, refusal, `/clear`, pane death), its plan, its intent, and its progress-to-date are already durable at the moment of replacement — not captured *during* it. A replacement agent resumes from atmux alone.

**Rationale.** §2.2 item 3 and item 4. This is the requirement that removes the operator from the continuity path and therefore the one that lifts the throughput ceiling. Death-bed capture cannot satisfy it: capture that runs *at* death fails exactly when death is abrupt, which is the common case.

**Acceptance signal.** For a task whose owning agent died without a clean handoff: a fresh agent running `/atmux:session cont` plus `atmux task show <id>` can state (a) the current plan, (b) what is already done, (c) the next action, (d) what was ruled out — with **zero operator messages** in between. Falsifiable by inspection: count operator turns in `.atmux/lead-outbox.md` / `.atmux/driver-inbox.md` between the death event and the replacement's first commit. Target is zero; any non-zero count is a BR1 miss with a nameable cause.

**Status.** PARTIAL. Rows durable ([ADR-126](../adr/126-sqlite-state-store.md)); hierarchy epic→story→task with `--body` / `--deps` / `--epic` / `--story` / `--deliverable` shipped ([ADR-193](../adr/193-restore-task-add-epic-story-deliverable-flags.md)); handoff + `/atmux:session cont` shipped ([ADR-263](../adr/263-merge-session-preclear-into-handoff.md)); standing decisions logged in `.atmux/decisions.md` ([ADR-008](../adr/008-decisions-verb.md)). Missing: an append-only progress/intent record that a *living* agent writes cheaply and often, so that nothing depends on capture-at-death.

**Governing decisions.** [ADR-126](../adr/126-sqlite-state-store.md), [ADR-193](../adr/193-restore-task-add-epic-story-deliverable-flags.md), [ADR-263](../adr/263-merge-session-preclear-into-handoff.md), [ADR-008](../adr/008-decisions-verb.md), [ADR-009](../adr/009-auto-rotation.md), [ADR-139](../adr/139-refusal-pattern-auto-rotate.md); plus [ADR-267](../adr/267-durable-agent-continuity-contract.md) (durable agent continuity contract — filed in the same 2026-08-06 batch as this BRD, `Status: proposed`).

### BR2 — Work state is durable independently of every agent process

**Requirement.** No item of coordination state (task, epic, story, claim, dependency, inbox message, decision) exists only inside an agent process, a tmux pane's scrollback, or a chat transcript. Every such item is on disk before it is acted on.

**Rationale.** This is the floor BR1 stands on, and it is a commitment worth stating explicitly because it is already met: it is the reason "another agent takes their place" is achievable at all rather than aspirational.

**Acceptance signal.** `sqlite3 .atmux/state.db '.tables'` lists the coordination tables (`tasks`, `epics`, `stories`, `inbox_messages`, `state_kv`, `events`, `complaints`, `spawn_queue`, and siblings — schema owned by `src/abstractions/sqlite-migrations.ts`), and killing every tmux pane in a team then running `atmux status` reproduces the full board with no loss.

**Status.** MET. Stated here as a standing commitment: any future feature that keeps load-bearing state only in a pane or only in an agent's context violates BR2 and is a reviewer-blockable defect.

**Governing decisions.** [ADR-126](../adr/126-sqlite-state-store.md).

### BR3 — A replacement agent needs no dispatcher

**Requirement.** A fresh agent joins work by pulling. It does not require a coordinator to be alive, to be prompted, or to notice it.

**Rationale.** A push/dispatch model makes the coordinator a single point of failure on the continuity path, which reintroduces exactly the operator dependency BR1 removes — one level up. Pull also makes lane count cheap: adding a lane adds a puller, not a dispatch obligation.

**Acceptance signal.** `atmux claim --next --as <member>` on a team whose lead pane is dead returns a claimable task honouring lane preference and unmet-dependency skipping.

**Status.** MET.

**Governing decisions.** [ADR-007](../adr/007-pull-kanban.md).

### BR4 — atmux artifacts never enter a managed product repo's git history

**Requirement.** No atmux artifact — team roster, kanban, plans, todos, decisions, handoffs, logs, worktree bookkeeping — is ever tracked, committed, or present in the history of a managed product repository.

**Rationale — organisational, not cosmetic.** The operator is a Senior Manager at IFCA MSC Berhad and drives multiple IFCA product repos in parallel (`property-root`, `crm-react`, `mx-root`, `aix-root`, `rentx-root`, `cax-root`, and siblings). **IFCA teammates clone those repositories.** A leaked `.atmux/` puts the operator's private plans, todos, per-lane task bodies, standing decisions, and fleet topology into a shared professional artifact that colleagues read, diff, and review. Three distinct harms, any one of which is sufficient:

1. **Private working notes become organisationally visible.** Todo bodies and plan prose are drafting material, not published intent. They contain half-formed judgments about work, scope, and sequencing that were never written for an audience.
2. **PR review noise.** atmux state drifting through diffs makes every product PR harder to read, and the reviewers paying that cost never opted into atmux. [ADR-244](../adr/244-per-repo-pre-commit-kanban-decisions-snapshot.md) §S3 states the target directly: *"No commit noise in product repos. Reviewers in sopx/unum/rentx never see atmux changes drifting through PRs."*
3. **atmux state is per-developer, not shared infrastructure.** [ADR-239](../adr/239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) §Supplement-2026-05-26 records the operator's framing verbatim: *"we best not let the other teams see that we're using atmux at all.... because each dev has their own atmux with their own set of epics and etc entirely separate from the next dev."* Committing one developer's atmux state into a shared repo makes a private tool look like team infrastructure it is not, and invites collision.

Git history is append-only in practice. A single forgotten `.gitignore` line is not a recoverable mistake — it is a permanent one. That asymmetry is why BR4 is absolute rather than best-effort.

**Acceptance signal.** In every managed repo, three commands: (a) `git ls-files -- .atmux` prints nothing; (b) `git check-ignore -q -- .atmux/team.json` exits 0; (c) `git log --all --name-only -- .atmux` prints no paths (no historical leak, not merely no current one).

Signal (b) asserts on a **concrete child path**, never on the bare directory name. Measured in `/root/work/src/atmux` on 2026-08-06, whose `.gitignore` line 1 is `.atmux/*`: `git check-ignore -v -- .atmux` exits **1** (no match), while `git check-ignore -v -- .atmux/team.json` exits **0** and reports `.gitignore:1:.atmux/*`. A `.atmux/*` pattern matches the directory's children, not the directory itself, so a bare-directory assertion reports a false red on every repo using that pattern form — see [ADR-268](../adr/268-managed-repo-state-isolation-enforcement.md) §Context (*"`git check-ignore .atmux` — the obvious assertion — is wrong"*, and §D2, which mandates the child-path form and checks all three durable entries `team.json` / `decisions.md` / `state.db`).

Signal (a) is not redundant with signal (b): **gitignore has no effect on an already-tracked path**, so (b) can pass while committed atmux state sits in history permanently. (a) is the leg that catches that, and (c) is the leg that catches it after a later `git rm --cached`.

**Status.** DESIGN MET, ENFORCEMENT MANUAL. All atmux state lives in the operator's personal dotfile tree at `~/work/journals/.sb/_dotfiles/atmux/<repo-key>/`, symlinked into each managed repo's `.atmux/`; Node `fs` follows symlinks transparently so no code change was needed ([ADR-239](../adr/239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) §Supplement-2026-05-26 line 226, [ADR-244](../adr/244-per-repo-pre-commit-kanban-decisions-snapshot.md) §Supersession-2026-05-26 §S1–§S2). This repo's `.gitignore` line 1 is `.atmux/*` with the citing stanza. Backup is `dotfiles push` at operator cadence ([ADR-244](../adr/244-per-repo-pre-commit-kanban-decisions-snapshot.md) §S3), which replaced the per-repo pre-commit hook proposed in that ADR's now-HISTORICAL D1–D6. The gap is BR5.

**Governing decisions.** [ADR-239](../adr/239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) §Supplement-2026-05-26, [ADR-244](../adr/244-per-repo-pre-commit-kanban-decisions-snapshot.md) §Supersession-2026-05-26.

### BR5 — Host-repo cleanliness is established and verified by machine, not by operator memory

**Requirement.** Onboarding a new managed repo establishes the BR4 guarantee without depending on the operator remembering a procedure, and an existing repo's compliance is continuously checkable by a command.

**Rationale.** BR4 is absolute and its failure is permanent (§BR4). A guarantee that absolute cannot rest on recall. Today it does: the setup is a four-step manual operator recipe in [ADR-239](../adr/239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) §Supplement-2026-05-26 (create the dotfiles subdirectory, `ln -s`, confirm `.gitignore`, run `atmux start`), and **no code automates or verifies any of it.** `src/verbs/init.ts` scaffolds `.atmux/` with `inboxes/ logs/ state/ archive/` plus `team.json` from the bundled template (`src/verbs/init.ts:289-293`); it never touches `.gitignore` and never creates the dotfile symlink. Nor does it register the team anywhere: the `~/.claude/teams/registry.json` upsert is **explicitly unported** — `src/verbs/init.ts:50-56` records *"registry abstraction not yet ported in atmux-bun … Phase 2/5 follow-up wires this in"* and `:383-384` marks the step skipped — so that registry is stale and cannot be a coverage source (measured 2026-08-06: `jq length ~/.claude/teams/registry.json` → 2, against 13 `type:"team"` sessions in `~/.atmux/cockpit.json`). This is why [ADR-268](../adr/268-managed-repo-state-isolation-enforcement.md) §D3 enumerates managed roots from `~/.atmux/cockpit.json` rather than from the registry. There is no probe asserting the BR4 acceptance signal. So on every new repo the professional boundary in BR4 is one forgotten step away from being permanently breached.

**Acceptance signal.** Two, both observable: (a) `atmux init` in a fresh repo leaves the BR4 acceptance signal already true, or refuses with an actionable message naming the missing step — it never silently completes into a leaking state; (b) `atmux doctor` reports a probe whose verdict is the BR4 signal — `git check-ignore -q -- .atmux/team.json` exits 0 (child path, never the bare `.atmux`, per §BR4 and [ADR-268](../adr/268-managed-repo-state-isolation-enforcement.md) §D2) **plus** `git ls-files -- .atmux` empty — red when either fails. The natural seam is the existing doctor git-probe module `src/verbs/doctor/git.ts` (sibling to `checkSubmoduleIntegrity`, `checkWorktreeIsolation`, `checkWorktreeNestedStateDb`) — a new probe there, not a new subsystem.

**Status.** NOT MET. `rg -l -i 'gitignore' src/ scripts/ templates/` matches only `scripts/autopromote.sh`.

**Governing decisions.** [ADR-239](../adr/239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md), [ADR-244](../adr/244-per-repo-pre-commit-kanban-decisions-snapshot.md); plus [ADR-268](../adr/268-managed-repo-state-isolation-enforcement.md) (managed-repo state isolation enforcement — filed in the same 2026-08-06 batch as this BRD, `Status: proposed`).

### BR6 — atmux records the working branch of every repo in a monorepo, recursively

**Requirement.** For each team, atmux holds a ledger of every git repository in scope — the root plus every nested submodule, to arbitrary depth — recording the branch each one is intended to be on and the branch each one is actually on.

**Rationale.** IFCA products are submodule monorepos, and their depth is not uniform. Measured 2026-08-06: `/root/work/ifca/src/property-root` carries **14 submodules at depth 1** (`git -C /root/work/ifca/src/property-root submodule status --recursive | wc -l` → 14, equal to the non-recursive count, so no nesting there), while `/root/work/ifca/src/ix-root` reaches **depth 3** — `packages/aix-root/packages/std-root/packages/std-core` — with 12 submodules at the top level but **38 recursively** (39 repos counting the root). A ledger that only walks one level is therefore correct for property-root and wrong for ix-root, which is why BR6 says *arbitrary depth* rather than naming a bound. A cross-repo change is a *snapshot*, and the snapshot is coherent only when every nested repo sits on the intended branch. The operator's branch convention makes this explicit (global `CLAUDE.md`, 2026-07-29): `<product>-<feature>-<user>-driver-N` — e.g. `px-crm-geoyws-driver-2` — and the **same** branch name is deliberately checked out in every submodule, because *"we routinely pull submodules from sibling projects, so checking out the SAME branch name in each submodule reconstitutes one consistent snapshot; a divergent name per repo breaks that."*

The mechanics exist and the record does not. `scripts/recursive-{checkout,pull,push,reset}.sh` and the `/rcheckout /rpull /rpush /rreset` skills perform the recursive ops. [ADR-035](../adr/035-per-member-branch-recursive-ops.md) is the governing decision and it is the ADR that **identifies this hole without filling it**: Decision §1 makes `<branch>` mandatory on every recursive script and is the home of the no-default rule — *"No config-mode (no-arg) variants. No `.gitmodules`-reading 'smart default.'"*; §Context failure-mode 2 states the reason in terms that generalise — *"`.gitmodules` cannot capture which member is currently working — it's a fixed declaration. Any 'default' it produces is correct for at most one member and wrong for all others"*; Decision §4 confirms `.gitmodules` `branch =` is a remote-tracking hint for `--remote` SHA bumps, not a checkout target. ADR-035 was right to reject `.gitmodules` and **named no replacement**. So the working state currently lives in the operator's head plus the branch string typed into `/rcheckout` — which is memory, and §2.2 item 3 is exactly the cost of the operator being the durable memory.

Confirmed absent from the codebase: `rg -n -i 'submoduleBranch|branchMap|per-submodule|recordBranch' src/schema/ src/core/` returns nothing. `src/schema/team.ts` carries only root-repo-level branch concepts — `base`, derived `<base>-<member>` branches ([ADR-082](../adr/082-worktree-isolation-per-member.md) / [ADR-084](../adr/084-worktree-per-member-branch-model.md)), `merger.branch`, `allowedPushBranches`, and `worktreeInitSubmodules` ([ADR-179](../adr/179-per-member-branch-fan-in.md)). Nothing enumerates nested repos.

**Acceptance signal.** One command, run from a team root, enumerates every nested repo to full depth and prints per repo: path, intended branch, actual branch, HEAD SHA, dirty flag. Its repo enumeration matches `git submodule status --recursive`'s repo set exactly — no repo silently omitted.

**Status.** NOT MET (recursive ops shipped; ledger absent).

**Governing decisions.** [ADR-035](../adr/035-per-member-branch-recursive-ops.md) (rejects `.gitmodules` as working-state truth; names the gap), [ADR-137](../adr/137-merge-over-rebase.md) (lane sync is `git merge <trunk> --no-edit`, never rebase — the ledger must not imply otherwise), [ADR-028](../adr/028-main-master-pr-only-no-agent-push.md) (push policy the ledger must not appear to license); plus [ADR-269](../adr/269-recursive-branch-ledger.md) (recursive branch ledger — filed in the same 2026-08-06 batch as this BRD, `Status: proposed`).

### BR7 — Divergence from the intended cross-repo snapshot is detectable

**Requirement.** When any repo in scope drifts off the intended snapshot branch — wrong branch, unexpected detached HEAD, uncommitted changes blocking a switch — that drift is surfaced as a discrete finding naming the repo path and both branches.

**Rationale.** BR6's ledger is only worth building if it answers a question. The convention says *all repos carry the same branch name*, and today **nothing verifies it** — the ledger's business value is not bookkeeping, it is drift detection. Drift is silent and expensive: commits land on the wrong branch, a submodule pointer bumps to a SHA that is not on the intended branch, and a "cross-repo snapshot" turns out to have been a partial one. [ADR-035](../adr/035-per-member-branch-recursive-ops.md) records the concrete instance: on 2026-04-29 a superdriver ran `recursive-checkout.sh <root-branch>` across the 17 submodules of that ADR's anonymized example repo `myteam-beta-root` to "unify," erasing per-member submodule branch state and setting up a collision the next time a different member checked out (§Context failure-mode 3). The figure 17 belongs to that example repo and to no live root — measured counts for the operator's actual monorepos are in BR6's rationale above. Note the boundary ADR-035 Decision §3 draws: submodules sitting in detached HEAD at the parent's pinned SHA after `git submodule update --init --recursive` is the **correct read-only state**, not drift. A drift report that flags correct read-only state is noise, and noise is how a probe gets ignored.

**Acceptance signal.** In a deliberately drifted tree (one nested submodule moved to a different branch), the drift report names that repo, the actual branch, and the intended branch, and reports zero findings on a clean tree. Both halves are required — a detector that never reports clean is not a detector.

**Status.** NOT MET.

**Governing decisions.** [ADR-035](../adr/035-per-member-branch-recursive-ops.md) §3 (detached-HEAD-is-correct boundary), plus [ADR-269](../adr/269-recursive-branch-ledger.md) as above.

### BR8 — Compliance with every BR above is detectable

**Requirement.** Every requirement in this document has at least one **observable proxy** that a machine evaluates — a doctor probe, a kanban query, a reviewer gate, or a git command — and no requirement's satisfaction is asserted only in prose.

**Rationale.** atmux orchestrates autonomous agents. It can create a durable seam; it cannot compel an agent to write to it. The honest consequence is §7.1: enforcement is detection plus surfacing, never a guarantee. That makes detection load-bearing rather than optional — an undetectable requirement is a requirement the fleet will drift off silently, and prose in `CLAUDE.md` is the weakest instrument in the system. atmux's existing gate model already works this way: the reviewer blocks code-without-doc-update on documented surfaces (`CLAUDE.md` §Binding-discipline 3) because that condition is *checkable from the diff*. There is no equivalent check for "claimed a task without recording a plan", and that absence is why BR1's prose has not been self-enforcing.

**Acceptance signal.** Each of BR1–BR7 above states a command or query whose output settles it. Each is written to be falsifiable, and each names the seam it would be checked from.

**Status.** PARTIAL — BR2/BR3/BR4 signals are checkable today with the commands stated above; BR1/BR5/BR6/BR7 signals depend on mechanisms that are `proposed`, not shipped ([ADR-267](../adr/267-durable-agent-continuity-contract.md), [ADR-268](../adr/268-managed-repo-state-isolation-enforcement.md), [ADR-269](../adr/269-recursive-branch-ledger.md)).

---

## 4. Stakeholders

| Stakeholder | Relationship to atmux | What they require |
|---|---|---|
| **Operator / driver** — George Yong, Senior Manager at IFCA MSC Berhad. Drives multiple product teams in parallel on the `hax` host (IFCA products plus Unum). | **Primary and only** stakeholder with preferences. Sole decision authority; every ADR's driver-ref traces to them. | BR1–BR8. Specifically: to stop being the system's durable memory (§2.2 item 3), and to stop being its throughput ceiling (§2.2 item 4). |
| **The agent fleet** — lead, planner, reviewer, gitter, docs, plus driver lanes; Claude Opus for every member role per `CLAUDE.md` §Spawning. | **Consumers of a contract**, not stakeholders with standing. | A contract cheap enough to follow under context pressure. This is a real design constraint: an expensive-to-use seam (read-modify-write a task body to add one note) will be skipped, and a skipped seam is an absent seam. Agents get no vote, and their compliance is never assumed — see BR8 and §7.1. |
| **IFCA teammates** — colleagues who clone `property-root`, `crm-react`, `mx-root`, `aix-root`, `rentx-root`, `cax-root` and review PRs in them. | **NON-consumers.** They do not use atmux, do not have `.atmux/`, and carry no atmux obligation. | To remain **entirely unaffected**: never to see an atmux artifact, never to review an atmux diff, never to need to know atmux exists. This group is the whole reason BR4 and BR5 exist, and it is the reason BR4 is stated as an organisational boundary rather than a tidiness preference. |
| **The ADR tree + reviewer gate** | **Constraint holder**, not a consumer. | That this BRD does not override an accepted decision (§1.2), and that new mechanisms arrive as new ADRs rather than as edits to old ones. |

---

## 5. Non-goals / out of scope

Firm refusals. Each exists because accepting it would trade away the organising thesis stated in this document's header — *atmux is meant to assist in agentic dev* — for scope that serves someone other than the stakeholders in §4.

1. **Not a project-management product for humans.** No web UI, no dashboard webapp, no human-facing board ([docs/PRD.md](../PRD.md) §2.4 — `atmux dashboard` is TUI-only). The board's reader is an agent; the operator's interface is a CLI and a tmux pane. Adding a human PM surface would make the fleet's coordination state a shared human artifact, which collides directly with BR4's per-developer-private framing.
2. **Not a CI system.** atmux does not own building, testing, or deploying. Test and coverage gates run in the agents' own shells under the `/tidy` and reviewer disciplines; atmux records that a gate was run and what it said. It never becomes the runner.
3. **Not an issue tracker.** atmux **ingests from** external trackers and does not replace them. [ADR-261](../adr/261-issue-sync-external-tracker-ingestion.md) is explicit: ingested GitHub / Azure DevOps issues become **complaints** filed through the existing complaints substrate (§D3), the **lead** adjudicates unchanged (§D6 — LLM auto-triage is out of scope there, and issue-sync never auto-converts an issue into an epic or task), and **upstream write-back is deferred to its own future ADR** (§D11 Phase 3). The trackers stay authoritative for the operator's stakeholders; atmux is downstream of them.
4. **Not a provider-agnostic API layer.** tmux is the IPC ([docs/PRD.md](../PRD.md) §1.2 principle 1: `send-keys` writes, `capture-pane` reads). atmux integrates with an agent by driving its terminal, not its SDK. Provider-API abstraction is a different product and would delete the property that makes atmux work with any interactive coding-agent TUI, including ones that do not exist yet.
5. **Not multi-host.** Single-host by design ([docs/PRD.md](../PRD.md) §2.4).
6. **Not a plugin platform.** Verbs are a closed set ([docs/PRD.md](../PRD.md) §2.4).
7. **Not a replacement for git, and never a second source of truth for branch state.** BR6's ledger *observes* git and is re-derived from it. If the ledger and `git` disagree, git is right and the ledger is stale by definition. A ledger trusted as authoritative-by-write would become a confident liar (§7.3).
8. **Not shared team infrastructure.** atmux is per-developer and private ([ADR-239](../adr/239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) §Supplement-2026-05-26). Any feature premised on two developers sharing one atmux state tree is out of scope.

---

## 6. Success measures

Observable only. Each is a command or a countable event, not an impression.

| # | Measure | How it is observed | Target |
|---|---|---|---|
| M1 | **Operator re-explanations per agent replacement** | Count operator-authored turns in `.atmux/lead-outbox.md` / `.atmux/driver-inbox.md` between an agent-death event and the replacement's first commit. | 0 |
| M2 | **Cadence, not liveness, is the evidence of work** | `/bau [hours]` per team: commits per team per window, plus churn. A live pane is explicitly **not** evidence — `CLAUDE.md` §Tmux-discipline: *"Text at prompt ≠ ready."* Anchored on the operator's standing discipline that commit cadence, not pane state, settles whether a lane is working. | Non-zero cadence per active lane per window; a Dormant verdict is a finding, not a status |
| M3 | **Artifact leaks into product repos** | Per managed repo: `git ls-files -- .atmux` and `git log --all --name-only -- .atmux`. | 0 paths, current and historical |
| M4 | **New-repo onboarding correctness** | After `atmux init` in a fresh repo, evaluate the BR4 signal — all three legs, with the ignore leg on a child path (`git check-ignore -q -- .atmux/team.json`), never on the bare `.atmux` — without any manual step. | True on the first try, every time |
| M5 | **Snapshot drift findings** | The BR7 drift report over a team's full nested repo set. | 0 on a clean tree; exactly the drifted repos on a drifted tree |
| M6 | **Plan-record coverage on in-flight work** | Fraction of tasks in `in-progress` or `blocked` that carry a plan/intent record written *after* the claim. Queryable from `.atmux/state.db`. | Rising toward 1.0; a persistent gap names either an ergonomics failure (the seam is too expensive) or an enforcement failure (§7.1) |
| M7 | **Body-clobber incidents** | Occurrences of a task body losing content through read-modify-write. | 0 |

---

## 7. Risks + open questions

### 7.1 The honest risk: atmux can create the seam but cannot force its use

atmux can make plan-recording durable, cheap, and adjacent to the work. It **cannot compel an agent to write to it.** The instruction lives in `CLAUDE.md` prose, and prose is advisory to an autonomous agent under context pressure — which is precisely the condition where an agent economises. So BR1's guarantee is structurally **best-effort at the write side**, however durable the storage.

The mitigation is honest and partial: a **detectable proxy plus surfacing**, not a hard guarantee.

- **Detectable proxy** — a claimed task in `in-progress` with no plan/intent record is a queryable condition (M6). It is a proxy, not proof: a recorded plan can still be thin or wrong, and no query can tell the difference.
- **Surfacing** — three instruments that ship today turn a detected condition into a consequence: the **reviewer gate**, which already blocks code-without-doc-update on documented surfaces and is fail-state (`CLAUDE.md` §Binding-discipline 3); an **`atmux doctor` probe**, which is the read-only reporting seam (`src/verbs/doctor/git.ts` and siblings); and the **complaints substrate**, where `atmux complaints` files a finding that the **lead** adjudicates ([ADR-214](../adr/214-retire-ombudsman-lead-absorbs-complaint-adjudication-via-honker.md) §D2 — the lead absorbed this from the retired ombudsman). `atmux hygiene-tick` ([ADR-131](../adr/131-superdoctor-kanban-hygiene.md)) is the one shipped verb that already walks kanban rows on demand and is therefore the cheapest host for a plan-record detector. **Not** an instrument: the `whip` verb, which [ADR-266](../adr/266-shim-sunset-policy-and-first-sweep.md) §D2 removed from `src/cli.ts` and from `atmux help`, and `src/core/whip-escalation.ts`, which §D3 deleted as verified-dead code (`maybeEscalateStrikes` was never called). Verified 2026-08-06: `rg -n -i 'whip' src/cli.ts` returns no match and `src/core/whip-escalation.ts` does not exist.
- **Ergonomics is the real lever.** The strongest available enforcement is making the compliant path cheaper than the non-compliant one. Today it is more expensive (§2.1: read-modify-write a whole body to add one line), which is sufficient explanation for the current non-compliance without invoking agent misbehaviour at all.

State this plainly rather than claiming enforcement: **no BR in this document is guaranteed by construction at the write side. BR2 (durability), BR3 (pull), BR4/BR5 (git-checkable cleanliness), and BR7 (git-derived drift) are; BR1's and BR6's write side is not.**

### 7.2 Surface accumulation is the coherence risk, not mission drift

The operator asked on 2026-08-06 whether the project is *"all over the place."* On the evidence, the **mission is coherent and the surface is not.** R1/R2/R3 all sit inside the stated vision; BR4's design was fully reasoned in May 2026 ([ADR-239](../adr/239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) / [ADR-244](../adr/244-per-repo-pre-commit-kanban-decisions-snapshot.md)); BR6's problem was correctly analysed in April 2026 ([ADR-035](../adr/035-per-member-branch-recursive-ops.md)). What has accumulated is **unretired surface and unmaintained top-level documentation**, which is a real risk to this BRD because it makes the authority chain in §1.2 harder to follow:

- [docs/PRD.md](../PRD.md) **held three simultaneous positions on the daemon question until the 2026-08-06 correction**: §1.2 durable principle 3 read *"No daemon... nothing long-lived"*; the PRD's own 2026-05-24 header read *"orchd is the runtime"*; and [ADR-260](../adr/260-manual-orchestration-mode-default.md) (accepted 2026-06-12) makes manual orchestration the fleet default with orchd opt-in. A reader could not tell which was current from the PRD alone. **Corrected in the same 2026-08-06 batch as this BRD**: PRD §1.2 principle 3 now names ADR-260's position as current and keeps both superseded positions as recorded history rather than erasing them.
- [docs/PRD.md](../PRD.md) §1.2 principle 2 read *"State lives on disk in JSON / markdown... greppable, diffable"* — superseded twice over, by [ADR-126](../adr/126-sqlite-state-store.md) (SQLite at `.atmux/state.db`) and by [ADR-244](../adr/244-per-repo-pre-commit-kanban-decisions-snapshot.md) §Supersession-2026-05-26 (state relocated to the operator's dotfile tree). **Corrected 2026-08-06** in the same batch; the durability claim was retained because it was never the stale part.
- [docs/PRD.md](../PRD.md) §1.3 pitched mixed cheap-worker tiers (Cursor Composer 2 / OpenCode / Kimi), which the operator's Opus-all-the-way stance and the rejection of a cursor-cli member surface had overtaken (`CLAUDE.md` §Spawning: *"Never Sonnet for member roles"*). **Rewritten 2026-08-06** in the same batch.

The three bullets above are in the past tense deliberately: they are the diagnosis this BRD's batch acted on, and the PRD passages they describe no longer read that way. The two below are **still live at 2026-08-06** and remain open:

- Retired roles still ship as a safety net ([ADR-211](../adr/211-retire-sentinel-role-distribute-to-honker-consumers.md) sentinel, [ADR-212](../adr/212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md) medic, [ADR-213](../adr/213-retire-jury-reviewer-absorbs-acceptance-criteria.md) jury, [ADR-214](../adr/214-retire-ombudsman-lead-absorbs-complaint-adjudication-via-honker.md) ombudsman), with `src/verbs/ombudsman.ts` and `src/core/complaints.ts` still present. [ADR-266](../adr/266-shim-sunset-policy-and-first-sweep.md) is the tree's own admission of this and the correct instrument for it.
- `docs/` root sprawl: three coexisting audit locations (`docs/audit.md`, `docs/audit/`, `docs/audits/`) plus loose `INVESTIGATION-*` and `CONVENTION-*` files beside twelve `RUNBOOK-*.md` (counted 2026-08-06: `ls docs/RUNBOOK-*.md | wc -l` → 12 — cockpit, cron-migration, deploy, epic-teams, grooming, issue-sync, migrate-to-honker, pulse, stall-recovery, sync, team-of-teams, topology; [ADR-269](../adr/269-recursive-branch-ledger.md) §Phasing Phase 0 adds a thirteenth, `docs/RUNBOOK-branch-ledger.md`). `src/verbs/` carries 70 modules (`ls src/verbs/*.ts | wc -l` → 70) including five separate `team-rename-*` modules.

**Business consequence:** documentation nobody trusts is documentation nobody reads, and BR1's continuity story depends on a replacement agent reading and believing what it finds. Surface consolidation is therefore not housekeeping — it is a BR1 dependency. Instrument of record: [ADR-266](../adr/266-shim-sunset-policy-and-first-sweep.md).

### 7.3 A stale ledger is worse than no ledger

BR6's ledger, if trusted as authoritative-by-write, becomes a confident liar the moment someone runs a bare `git checkout` in a submodule. Non-goal 7 is the mitigation in principle (git wins; the ledger is re-derived), and BR7's clean-tree half is the mitigation in practice (a report that cannot say "clean" cannot be trusted when it says "drifted"). Residual risk: an operator or agent reading a cached ledger without re-deriving. Untested — verify once the [ADR-269](../adr/269-recursive-branch-ledger.md) mechanism ships (that ADR is `proposed` at 2026-08-06, so no implementation exists to test against yet).

### 7.4 Private state has a single durability path

BR4's solution puts all atmux state in the operator's dotfile tree with `dotfiles push` as the snapshot mechanism at operator cadence ([ADR-244](../adr/244-per-repo-pre-commit-kanban-decisions-snapshot.md) §S3, replacing that ADR's per-repo pre-commit hook). Consequences accepted with it: (a) state is only as durable as that cadence, and nothing verifies the cadence ran; (b) a managed repo cloned onto a second machine has **no** atmux state until the dotfile tree is present there, because `.atmux/` is a symlink into it; (c) BR2's durability guarantee covers agent death, not dotfile-tree loss. No measure in §6 currently observes snapshot freshness — that is a gap, not a solved problem.

### 7.5 Open questions

1. **Append-only note shape.** Does the BR1 progress record become a new table in `.atmux/state.db` (migration via `src/abstractions/sqlite-migrations.ts`), or an append-only `--note` flag on `atmux task update` writing into an existing column? [ADR-267](../adr/267-durable-agent-continuity-contract.md) decides. Constraint from §4: whichever is cheaper for an agent under context pressure wins, because an expensive seam is a skipped seam.
2. **Ledger residency.** Does the BR6 ledger live in `.atmux/state.db` or in `.atmux/team.json`? [ADR-269](../adr/269-recursive-branch-ledger.md) decides. Constraint: it must not become a second source of truth (non-goal 7).
3. **`atmux init` posture.** Does `atmux init` *write* `.gitignore` and create the dotfile symlink, or *refuse and instruct*? [ADR-268](../adr/268-managed-repo-state-isolation-enforcement.md) decides. Constraint from BR5: it must never silently complete into a leaking state.
4. **Enforcement instrument for BR1.** Reviewer gate, an `atmux doctor` probe, an `atmux hygiene-tick` sub-op, or a filed complaint for lead adjudication — or several at different severities? Unsettled; §7.1 constrains it to detection-plus-surfacing regardless, and constrains the candidate set to surfaces that still ship (the `whip` verb and `src/core/whip-escalation.ts` were removed by [ADR-266](../adr/266-shim-sunset-policy-and-first-sweep.md) §D2/§D3, so neither is available).
5. **Intended-branch source for BR6/BR7.** What declares the *intended* snapshot branch, given [ADR-035](../adr/035-per-member-branch-recursive-ops.md) Decision §1 rejected both `.gitmodules` defaults and inference from the root branch (its §Context failure-mode 2 carries the reasoning)? Candidates: the team's `base` plus lane derivation ([ADR-082](../adr/082-worktree-isolation-per-member.md) / [ADR-084](../adr/084-worktree-per-member-branch-model.md)), or an explicit per-team declaration. [ADR-269](../adr/269-recursive-branch-ledger.md) must name one and must respect the `<product>-<feature>-<user>-driver-N` convention.

---

## 8. Traceability — operator ask → BR → decision

| Operator ask (2026-08-06, verbatim fragment) | BR | Governing decision(s) |
|---|---|---|
| *"track plans and todos so that they're never lost even if agents run out of tokens"* | BR1, BR2 | [ADR-126](../adr/126-sqlite-state-store.md), [ADR-193](../adr/193-restore-task-add-epic-story-deliverable-flags.md), [ADR-263](../adr/263-merge-session-preclear-into-handoff.md) + [ADR-267](../adr/267-durable-agent-continuity-contract.md) (proposed) |
| *"another agent can easily take the previous agent's place"* | BR1, BR3 | [ADR-007](../adr/007-pull-kanban.md), [ADR-263](../adr/263-merge-session-preclear-into-handoff.md) + [ADR-267](../adr/267-durable-agent-continuity-contract.md) (proposed) |
| *"agents to always use atmux as a way to track todos and to update work done"* | BR1, BR8 | [ADR-267](../adr/267-durable-agent-continuity-contract.md) (proposed); enforcement bounded by §7.1 |
| *"keep all plans and intents in atmux so that the git repo can be clean of our artifacts"* | BR4 | [ADR-239](../adr/239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) §Supplement-2026-05-26, [ADR-244](../adr/244-per-repo-pre-commit-kanban-decisions-snapshot.md) §Supersession-2026-05-26 |
| *"my team members won't need to see my todo artifacts"* | BR4, BR5 | as above + [ADR-268](../adr/268-managed-repo-state-isolation-enforcement.md) (proposed) |
| *"note the branches that we're working with across monorepos recursively"* | BR6, BR7 | [ADR-035](../adr/035-per-member-branch-recursive-ops.md) + [ADR-269](../adr/269-recursive-branch-ledger.md) (proposed) |
| *"atmux is meant to assist in agentic dev"* | organising thesis (header), all non-goals (§5) | this BRD |

**Batch note.** [ADR-267](../adr/267-durable-agent-continuity-contract.md), [ADR-268](../adr/268-managed-repo-state-isolation-enforcement.md), and [ADR-269](../adr/269-recursive-branch-ledger.md) were authored in the same 2026-08-06 batch as this BRD and all three are on disk in `docs/adr/` (verified 2026-08-06: `ls docs/adr/ | rg '^26[7-9]'` returns all three). All three carry `Status: proposed`, so per §1.2 none of them is binding on the fleet yet: a `proposed` ADR states an intended mechanism, and it becomes law only via reviewer signoff or driver/lead `decisions-add` (`CLAUDE.md` §Binding-discipline 4). Every "(proposed)" marker in the table above means exactly that — the decision is filed and linkable, not yet ratified and not yet shipped.
