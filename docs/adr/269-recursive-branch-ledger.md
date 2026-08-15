# ADR-269: Recursive branch ledger — per-repo branch state across a monorepo's nested submodules

**Status**: proposed
**Date**: 2026-08-06
**Driver-ref**: operator-direct 2026-08-06 — *"and i need atmux to note the branches that we're working with across monorepos recursively as well."* Requirement R3 of a three-part ask (R1 continuity of plans/todos across agent death, R2 host-repo cleanliness, R3 this).
**Cross-refs**: [ADR-035](035-per-member-branch-recursive-ops.md) (**the direct antecedent** — diagnosed this hole on 2026-04-29 and deliberately named no replacement; ADR-035 **§1** mandatory-branch-arg, which is also the true home of the no-`.gitmodules`-default rule — `docs/adr/035-per-member-branch-recursive-ops.md:37`, "No config-mode (no-arg) variants. No `.gitmodules`-reading 'smart default.'" — and ADR-035 **§Context failure-mode 2** at `:17`, the `.gitmodules`-cannot-capture-which-member finding, are both preserved verbatim by this ADR. **Section-numbering care:** ADR-035's *Decision* §2 is "Skills are deployed per-team, not global" (`:39`) — a different rule, cited separately in D4.1 — so the `.gitmodules` quotation must be cited as §Context failure-mode 2, never as §2), [ADR-084](084-worktree-per-member-branch-model.md) (`<base>-<member>` per-member branch model — the root-repo-level branch concept this extends downward into submodules), [ADR-082](082-worktree-isolation-per-member.md) (per-member worktrees — why one team has many monorepo roots), [ADR-088](088-worktree-submodule-init.md) (`initSubmodules` = `git submodule update --init --recursive` inside a freshly provisioned worktree — the write point in D4), [ADR-179](179-per-member-branch-fan-in.md) (the `team.json::worktreeInitSubmodules` opt-in flag whose schema comment carries this cite, `src/schema/team.ts:1499-1504`), [ADR-137](137-merge-over-rebase.md) (merge-never-rebase — why the ledger records a `trunk_branch` alongside the lane branch), [ADR-126](126-sqlite-state-store.md) (state.db is the house store; single append-only migration ladder), [ADR-098](098-json-and-locking.md) (the JSON+flock model that ADR-126 narrowed — the alternative rejected in D2), [ADR-096](096-module-taxonomy.md) (abstraction / core / verb layering — why the state.db write lands in the verb layer, not in `src/abstractions/worktree.ts`), [ADR-239](239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) §Supplement-2026-05-26 + [ADR-244](244-per-repo-pre-commit-kanban-decisions-snapshot.md) §Supersession-2026-05-26 (all `.atmux/` state is operator-private, symlinked out of the product repo — the residency guarantee the ledger inherits), [ADR-245](245-singleton-atmux-per-project.md) (single kanban per project — the ledger resolves UP to the team-root state.db, never a worktree-local one), [ADR-057](057-stall-prevention.md) §D5a (`checkSubmoduleIntegrity` — the one existing submodule-aware doctor probe, which records pointer state but never branch), [ADR-176](176-epic-aware-lane-drift-revert.md) + [ADR-127](127-lane-claim-auto-pickup.md) §OQ5 (`atmux lane-drift-check` and the auto-revert algorithm ADR-176 supersedes in part — a DIFFERENT failure class; see D6 on the naming hazard), [ADR-203](203-event-topic-taxonomy.md) (closed topic set — deliberately NOT amended: v1 emits no event), [ADR-260](260-manual-orchestration-mode-default.md) (manual orchestration is the fleet default — why v1 ships no orchd ticker), [ADR-266](266-shim-sunset-policy-and-first-sweep.md) (surface-bloat discipline — the budget this ADR spends one noun against).

**Batch siblings** (same 2026-08-06 operator ask, all three on disk in `docs/adr/` as of 2026-08-06): [ADR-267](267-durable-agent-continuity-contract.md) is R1 — continuity of plans/todos across agent token exhaustion. [ADR-268](268-managed-repo-state-isolation-enforcement.md) is R2 — managed-repo state isolation, whose residency guarantee this ADR's ledger rows inherit (D2 §Residency). This ADR is R3.

## Context

### The hole ADR-035 diagnosed and left open

atmux ships four recursive git ops — `scripts/recursive-checkout.sh`, `recursive-pull.sh`, `recursive-push.sh`, `recursive-reset.sh`, surfaced as the `/rcheckout` `/rpull` `/rpush` `/rreset` skills (`.claude/skills/rcheckout/SKILL.md` and siblings). Each walks the root repo plus every nested submodule via `git submodule foreach --recursive --quiet 'echo "$displaypath"'` (`scripts/recursive-checkout.sh:33`).

ADR-035 (accepted 2026-04-29) governs them. Its **§Context failure-mode 2** finding (`docs/adr/035-per-member-branch-recursive-ops.md:17`), verbatim:

> **`.gitmodules` cannot capture *which member is currently working*** — it's a fixed declaration. Any "default" it produces is correct for at most one member and wrong for all others.

That is correct, and ADR-035 acted on it: **§1** (`:25`, rule text at `:37`) makes `<branch>` **mandatory** on every recursive script ("No config-mode (no-arg) variants. No `.gitmodules`-reading 'smart default.' No 'uniform on root branch' inference"), and **§4** (`:54`) demotes `.gitmodules` `branch =` to a remote-tracking hint for `git submodule update --remote` SHA bumps. (ADR-035's Decision **§2** is a different rule — "Skills are deployed per-team, not global", `:39` — cited on its own terms in D4.1. This ADR never cites the `.gitmodules` finding as "§2".)

ADR-035 therefore **rejected `.gitmodules` as the working-state source of truth and named no replacement.** Between 2026-04-29 and 2026-08-06 no replacement was filed. Confirmed absent on 2026-08-06:

```
rg -n -i 'submoduleBranch|branchMap|per-submodule|recordBranch' src/schema/ src/core/   → no matches
```

`src/schema/team.ts` carries only ROOT-repo branch concepts: `worktreeInitSubmodules` (line 1504), `base`, the derived `<base>-<member>` branches of ADR-084, `merger.branch`, `allowedPushBranches`. Nothing in the tree enumerates nested repos, and nothing records what branch any of them is on. The working state of a monorepo lives in exactly two places today: the operator's head, and the branch string typed into `/rcheckout` before it scrolled out of the pane.

### Why "same name everywhere" makes drift the failure to expose

The operator's branch convention (global CLAUDE.md, George 2026-07-29) is `<product>-<feature>-<user>-driver-N` — e.g. `px-crm-geoyws-driver-2`. Trunk is `<product>-<feature>-<user>` (`px-crm-geoyws`); lanes are `<trunk>-driver-N`; sync into a lane is `git merge <trunk> --no-edit` (ADR-137, never rebase). The **same branch name is checked out in every submodule deliberately**: "we routinely pull submodules from sibling projects, so checking out the SAME branch name in each submodule reconstitutes one consistent snapshot; a divergent name per repo breaks that."

So the *stated* invariant is uniformity, and the failure is **drift**: one nested repo on a different branch, or detached while the lane is meant to be working, or dirty, or — the silent one — a submodule where the lane branch was never created at all, which `recursive-checkout.sh:70` reports as a single `WARN:` line inside a whole-tree sweep and then forgets. `recursive-pull.sh` already refuses to proceed on any mismatch (its pre-flight, `scripts/recursive-pull.sh:29-45`), which proves the mismatch matters; nothing records it.

### Measured reality: a single branch per monorepo is not representable

The convention says one name everywhere. **Disk says otherwise, on every monorepo measured on 2026-08-06.** This is the fact the ledger schema has to survive, so it is recorded here rather than assumed away.

`/root/work/ifca/src/crm-react/.atmux/worktrees/driver-2` — the exact lane D5's acceptance test names, provisioned by atmux itself, and **correct**:

```
$ git -C /root/work/ifca/src/crm-react/.atmux/worktrees/driver-2 branch --show-current
px-crm-geoyws-driver-2
$ ... submodule status --recursive | wc -l        → 23 declared
$ ... submodule foreach --recursive | wc -l       → 18 initialised (5 uninitialised)
$ ... foreach --recursive 'git branch --show-current' | sort | uniq -c
      1 aix-geoyws-driver-2      # services/aix-root — a DIFFERENT product's branch family
     17 (detached)               # ADR-035 §3's correct read-only state
$ ... foreach --recursive '<does px-crm-geoyws-driver-2 exist in refs/heads or refs/remotes/origin?>'
     14 MISSING · 4 HAS
```

Against a single `intended_branch = 'px-crm-geoyws-driver-2'` for this monorepo root, `verify` would emit **14 `missing-branch` (RED) + 4 `wrong-branch`/`detached` (YELLOW) + 5 `uninitialised` = 23 drift rows and exit code 23, permanently, on a correctly provisioned lane.** `checkBranchLedgerDrift` would print 14 RED doctor rows every run. Verified instance of the RED case: in `services/aix-root/packages/std-root/packages/std-core`, `refs/heads/px-crm-geoyws-driver-2` and `refs/remotes/origin/px-crm-geoyws-driver-2` are both absent; that repo's refs are the `ix-geoyws` / `aix-geoyws` families. `std-core` is a vendored shared library this lane consumes and never edits — the lane branch is not *supposed* to exist there.

Two further roots, both `type:"team"` entries in `~/.atmux/cockpit.json`:

| Root | Root branch | Nested state | Single-intent verdict |
|---|---|---|---|
| `/root/work/ifca/src/rentx-root` | `rx-geoyws` | 18 declared submodules, 7 initialised: `gz/business-backend` + `gz/business-frontend` on `rentx-geoyws`; `services/aix-root` on `rx-geoyws`; 4 repos under `services/aix-root` detached; 11 uninitialised | 2 `wrong-branch` + 4 `detached` + 11 `uninitialised` = 17 of 18 — and `rentx-root/.gitmodules` itself **declares two different branches** (`branch = rentx-geoyws` ×2, `branch = rx-geoyws` ×1), so the divergence is deliberate and versioned, not an accident to be corrected |
| `/root/work/ifca/src/ix-root` | `ix-geoyws` | 20 nested repos attached to `ix-geoyws` (convention honoured); 18 detached, all of them the children of two copies of the vendored `std-root` subtree (`packages/std-root/*` and `packages/aix-root/packages/std-root/*`) | 18 `detached` on a tree that is otherwise the convention's best case |

**Conclusion:** a schema with one `intended_branch` per `(team, lane, monorepo_root)` is a false-alarm generator on all three roots. `docs/brd/atmux.md` §BR7 (`:161`) names that outcome as the thing to avoid, verbatim — *"A drift report that flags correct read-only state is noise, and noise is how a probe gets ignored"* — and a noisy probe is fail-state under this repo's own reviewer discipline. D1(b) and D2 are therefore **per-repo**, not per-monorepo.

### Which of convention and observation is authoritative, and why

The two disagree, so the ADR must say which one wins where. It splits by role:

- **Observation (`branch_ledger`) is authoritative about what *is*.** It is a live read of git, per repo, and it is never edited to match the convention.
- **Intent (`branch_ledger_intent`) is authoritative about what *should be*, and the operator's uniform-name convention is its DEFAULT.** The `repo_path = '.'` row carries the convention's single branch name for the whole monorepo; per-repo rows override it only where a human explicitly said so.
- **Intent is never derived from observation.** If the automatic write points inferred each repo's intent from the branch that repo happens to be on, `rentx-root`'s divergence would be silently ratified as intended and drift would become permanently undetectable — the ledger would exist and report zero problems. That is the same move ADR-035 §1 forbids one level down (deriving a checkout target from `.gitmodules`), and it is forbidden here too.

The consequence is the behaviour the operator's convention actually wants: **`crm-react` driver-2's `services/aix-root` sitting on `aix-geoyws-driver-2` shows up as `wrong-branch` drift until a human declares it intentional** with a per-repo override. Drift stays visible; it is not normalised away. What the per-repo rows buy is that declaring it costs one command instead of being impossible.

### Relationship to ADR-035 §"Notes for the future"

ADR-035 closes with an explicit warning, verbatim (`docs/adr/035-per-member-branch-recursive-ops.md:76`):

> If a team genuinely wants "all submodules on one branch always" (e.g., a tightly-coupled monorepo where each release locks every submodule to the same tag), that's a *different ADR* — and would require tooling that's `.gitmodules`-driven by design (not the per-member tooling here). Don't conflate the two models.

**This ADR serves the per-member model, not the uniform-branch model, and it adopts no `.gitmodules`-driven tooling.** Three specifics, because the distinction is easy to lose:

1. **The ledger's unit is the lane, not the monorepo.** Every row is keyed on `(team, lane, …)`. Two lanes on the same monorepo root hold independent intent and independent observations. The uniform-branch model has no lane dimension at all — that is precisely what makes it a different model.
2. **Recording observed state is not adopting the uniform-branch model.** ADR-035's objection to "all submodules on one branch always" is an objection to *tooling that enforces or infers* uniformity. This ADR enforces nothing (§Out of scope) and infers nothing (D4 anti-inference rule). It reads git and writes rows.
3. **The operator's `<product>-<feature>-<user>-driver-N` convention is a per-member convention that happens to prefer one name per lane** — `px-crm-geoyws-driver-2` names the member's lane, and reusing it across submodules reconstitutes one snapshot *of that member's work*. That is ADR-035's model with a naming discipline layered on, not ADR-035's rejected model. The ledger holds that preference as a per-lane default and lets reality override it per repo; it never promotes it to a fleet-wide rule and never reads `.gitmodules` to obtain it.

If the uniform-branch model is ever genuinely wanted, ADR-035's note still stands: it needs its own ADR. This one is not it.

### What already exists nearby (and why none of it is the ledger)

- `checkSubmoduleIntegrity` (`src/verbs/doctor/git.ts:68-98`, ADR-057 §D5a) parses `git submodule status` and flags pointer mismatch (`+`), uninitialised (`-`), and conflict (`U`). It is **pointer**-aware and **branch**-blind, non-recursive, and stores nothing.
- `merger_state` (state.db v5→v6, `src/abstractions/sqlite-migrations.ts:277-296`) is keyed on `member_branch` — one root-repo branch per member, driving a 10-state merge machine.
- `src/verbs/lane-drift-check.ts` is about kanban lanes, not git branches (D6).
- ADR-088's `initSubmodules` (`src/abstractions/worktree.ts:225-241`) runs `git submodule update --init --recursive` inside a newly provisioned worktree when `team.json::worktreeInitSubmodules` is true. It is the moment a lane's submodules come into existence — and it leaves every one of them detached at the parent's pinned SHA, which per ADR-035 §3 is the **correct read-only state**, not an error.

## Decision

Add a **recursive branch ledger**: a per-lane, per-repo record of observed git branch state across a monorepo root and every nested submodule, plus an explicitly-supplied, **also per-repo**, record of what each repo is *intended* to be doing — so intended-vs-actual is a diff rather than a memory.

Two constraints are load-bearing and neither is negotiable:

1. **The ledger records observations. It never infers a checkout target** (restated in D4).
2. **Intent is per-repo, and the monorepo-wide branch is a default rather than the only expressible answer.** A single branch per monorepo cannot describe any of the three monorepos measured in §Context; a design that assumes it produces a permanent false alarm on a correct tree, which is fail-state.

### D1 — What the ledger records

Two records. One per observed repo, one per lane.

**(a) Per-repo observation.** Fields, with the git command each comes from:

| Field | Source | Notes |
|---|---|---|
| `repo_path` | `$displaypath` from `git submodule foreach --recursive`; `.` for the root | root-relative, never absolute — absolute paths differ per lane worktree |
| `role` | derived | `root` \| `submodule` |
| `parent_path` | derived (D3) | `repo_path` of the immediate superproject; NULL for the root |
| `depth` | derived (D3) | `0` root, `1` direct submodule, `2` nested-in-submodule (e.g. `aix-root/packages/aix-gql-px` under a root whose submodule is `aix-root`) |
| `head_state` | `git -C <p> rev-parse --abbrev-ref HEAD` + probes | `attached` \| `detached` \| `unborn` \| `uninitialised` \| `absent` |
| `branch` | same | NULL unless `head_state = 'attached'` |
| `head_sha` | `git -C <p> rev-parse HEAD` | full 40-hex; NULL when `unborn`/`uninitialised`/`absent` |
| `dirty`, `dirty_count` | `git -C <p> status --porcelain` | `dirty` 0/1; `dirty_count` = line count |
| `upstream` | `git -C <p> rev-parse --abbrev-ref '@{u}'` | e.g. `origin/px-crm-geoyws-driver-2`; NULL when unset |
| `ahead`, `behind` | `git -C <p> rev-list --left-right --count '@{u}...HEAD'` | NULL when no upstream. **Computed from local refs only — `record` never fetches** (D3) |
| `observed_at_sec` | clock | epoch seconds. Load-bearing: every consumer must check it (see Consequences) |

**Detached HEAD is a first-class recorded state, not an error.** ADR-035 §3 is explicit that detached-at-the-pinned-SHA is the correct state after `git submodule update --init --recursive`; a ledger that treated it as a fault would flag every freshly provisioned worktree (ADR-088) as broken. Detachment becomes *drift* only when measured against a lane intent that names a working branch (D3, `verify`).

`uninitialised` (declared in `.gitmodules`, no git dir on disk) and `absent` (path missing entirely) are likewise recorded states, not errors.

**(b) Per-repo intent.** One row per `(team, lane, monorepo_root, repo_path)` — **not one row per monorepo.** The `repo_path = '.'` row is the monorepo-wide default (the operator's uniform-name convention); any other `repo_path` row overrides it for that repo and, by prefix, its subtree.

- `intent_kind` — **the field that makes the schema representable.** Three literals:
  - `branch` — this repo is meant to be attached to `intended_branch`. The default kind, and the only kind the `.` row ever carries when written automatically.
  - `expected_detached` — this repo is meant to sit detached at the superproject's pinned SHA, which ADR-035 §3 calls the correct read-only state. A positive assertion, not silence: drift is *attached to anything*, or dirty. This is the honest kind for a vendored subtree the lane consumes and never edits — declared at the directory prefix that holds the read-only repos, **not** at the subtree root, per the resolution rule below (`services/aix-root/apps` + `services/aix-root/packages` in `crm-react` driver-2; `packages/std-root/{apps,packages}` + `packages/aix-root/packages/std-root/{apps,packages}` in `ix-root`, whose two subtree roots are themselves attached and must keep resolving to the `.` row).
  - `exempt` — the lane makes **no claim** about this repo. No drift class fires, `missing-branch` included. The kind for a sibling-product submodule the lane never owns.
- `intended_branch` — nullable, and **required only when `intent_kind = 'branch'`** (enforced at the Zod + verb layer, not by a DB CHECK — house posture, D2). NULL for `expected_detached` and `exempt`. **Only ever written from an explicit source** (D4): the `<branch>` argument the operator gave a recursive script, the `wtBranch` that worktree provisioning created, or an operator-supplied `--intended` / `--intended-for`. **Never derived from an observation** — see §"Which of convention and observation is authoritative".
- `trunk_branch` — the ADR-137 merge source (`px-crm-geoyws` for lane `px-crm-geoyws-driver-2`), so a replacement agent learns both "your branch" and "what to merge from". Per-repo where it differs: `services/aix-root`'s trunk is `aix-geoyws`, not `px-crm-geoyws`.
- `source` — `rcheckout` \| `rpull` \| `rpush` \| `rreset` \| `worktree-provision` \| `operator`.
- `set_by`, `set_at_sec`.

**Resolution rule (one rule, reused).** The effective intent for repo `R` is the row whose `repo_path` is the **longest** entry in the intent table that is either `R` itself or a strict path-prefix ancestor of `R`; the `.` row is the final fallback. This is the identical longest-prefix walk D3 already uses to derive `parent_path`, so there is one path-matching helper in `src/core/branch-ledger.ts`, not two.

**A row governs the declaring node itself — resolved explicitly here, because it is the rule's one counter-intuitive edge and it silently corrupted two earlier drafts of the worked examples below.** Since `R` matches "`R` itself", a row at path `P` binds `P` *and* every descendant of `P` without a nearer row. There is deliberately **no `scope` column and no self-vs-subtree flag**: the PK is `(team, lane, monorepo_root, repo_path)`, so one path holds exactly one statement, and any scope flag would immediately need a *second* row at the same path to say something different about the node than about its children — a PK collision. The mechanism for "read-only subtree, but the subtree root is the lane's own work" is therefore **path placement, not a flag**:

> **An intent `repo_path` may be any root-relative path prefix, including a directory that is not itself a repo.** A row at `packages/std-root/packages` governs the eight repos beneath it and says *nothing* about `packages/std-root`. A non-repo path never resolves to "itself" (there is no repo there), so such a row is descendants-only by construction.

That is what makes the `ix-root` case in §Context declarable at all. Measured 2026-08-06: both copies of the vendored `std-root` subtree have roots **attached to `ix-geoyws`** (`packages/std-root` and `packages/aix-root/packages/std-root`) while all 18 of their children are detached. An `expected_detached` row placed *at* either subtree root would therefore score that root as `unexpectedly-attached` — a false positive manufactured by the very declaration meant to remove one. Placed one level down, at each subtree's `apps` and `packages` directories, it scores nothing. Every worked example below places rows accordingly, and `verify --explain` (D3) must emit the directory-prefix form wherever that is the correct placement.

Subtree inheritance is what keeps the row count honest; placement below the subtree root is what keeps it *correct*. On `ix-root`, **four** rows — `packages/std-root/apps`, `packages/std-root/packages`, `packages/aix-root/packages/std-root/apps`, `packages/aix-root/packages/std-root/packages` — cover all 18 detached repos and leave both `std-root` roots resolving to the `.` row, which is where they belong. On `crm-react` driver-2, **two** rows at `services/aix-root/apps` and `services/aix-root/packages` cover all 22 repos beneath `services/aix-root`. So a subtree costs one row per intermediate directory, not one per repo — but the total per monorepo is not 1–3 once uninitialised sibling-product submodules are in the tree, and the worked example below prints that arithmetic instead of asserting a number.

**Worked example — the `crm-react` driver-2 lane measured in Context**, which the single-intent schema scored as 23 drift rows. Re-walked and re-derived on 2026-08-06, with the arithmetic printed in full so the next reader can check it against the live tree instead of trusting a restated number. **The invariant this example is held to: applying this ADR's own rules to the live filesystem must reproduce the exit codes claimed here.**

The tree, as measured: **24 repos** = root + 23 declared submodules; **18 initialised** (exactly one attached — `services/aix-root` on `aix-geoyws-driver-2` — and 17 detached) and **5 declared-but-uninitialised**. Every submodule beneath `services/aix-root` sits under either its `apps/` or its `packages/` directory, and nothing except `services/aix-root` itself is attached to `aix-geoyws-driver-2`.

**Step 1 — the three rows the obvious declaration produces, and why they are not enough.** `.` plus one row per divergent subtree root:

| `repo_path` | `intent_kind` | `intended_branch` | `trunk_branch` |
|---|---|---|---|
| `.` | `branch` | `px-crm-geoyws-driver-2` | `px-crm-geoyws` |
| `services/aix-root` | `branch` | `aix-geoyws-driver-2` | `aix-geoyws` |
| `services/aix-root/packages/std-root` | `expected_detached` | NULL | NULL |

**These three rows reach `verify` exit `13`, not 0.** Resolving every one of the 24 repos by the rule above (paths under `services/aix-root/` abbreviated to their tail):

| Resolved from | Repos | Observed | Class | Drift |
|---|---|---|---|---|
| `.` — self | `.` | attached `px-crm-geoyws-driver-2` | matches | 0 |
| `services/aix-root` — self | `services/aix-root` | attached `aix-geoyws-driver-2` | matches | 0 |
| `services/aix-root` — ancestor | `apps/aix-node`, `packages/{aix-core, aix-eslint-config, aix-gql-px, aix-tools-hx, aix-tools-px, aix-ui-umi, system-scaffold}` | detached, and `aix-geoyws-driver-2` absent from both ref namespaces | `missing-branch` (RED) | **8** |
| `services/aix-root` — ancestor | `packages/{aix-admin, aix-gql-hx, aix-tools-ix, aix-ui}` | uninitialised | `uninitialised` | **4** |
| `.../std-root` — self | `packages/std-root` | detached | as declared | 0 |
| `.../std-root` — ancestor | its 8 detached `packages/*` children | detached | as declared | 0 |
| `.../std-root` — ancestor | `packages/std-root/apps/std-traefik` | uninitialised | `uninitialised` | **1** |

`8 + 4 + 1 = 13` drifting repos, `24 − 13 = 11` clean, **exit 13**. Two facts this makes concrete, both of which earlier drafts of this ADR got backwards:

- **`services/aix-root/**` inherits `services/aix-root`'s row, never the `.` row** — `services/aix-root` is the longest matching prefix, so every repo beneath it is measured against **`aix-geoyws-driver-2`**, not against the `.` row's `px-crm-geoyws-driver-2`. Getting that backwards was the specific error in earlier drafts of this ADR, and it inverts the per-repo diagnosis: `services/aix-root/packages/aix-gql-px` is detached and *does* carry both `refs/heads/px-crm-geoyws-driver-2` and `refs/remotes/origin/px-crm-geoyws-driver-2`, so against the `.` row it would have scored `detached` and could never have scored `missing-branch`. Measured against the row that actually resolves, it scores `missing-branch` — because `aix-geoyws-driver-2` exists in exactly **one** repo in this tree, `services/aix-root` itself; all 17 other initialised repos lack it in both namespaces (verified 2026-08-06).
- **Step 1's three rows therefore emit 8 RED rows, not 8 YELLOW.** `missing-branch` outranks `detached` where both would apply — the same precedence Context §"Measured reality" uses to score the single-intent design as 14 RED + 4 YELLOW + 5 `uninitialised` = 23. Stated plainly because it fixes what "correctly declared" means in D6.1 and Decision-anchor 12: the zero-RED bar is cleared by **Step 2**, not by the obvious three-row declaration.
- **`uninitialised` fires under `expected_detached` as well as under `branch`** (D3's class table). A read-only declaration does not silence an uninitialised node; only `exempt` does. That is where 5 of the 13 come from.

**Step 2 — the declaration that genuinely reaches exit 0: nine rows.**

| `repo_path` | `intent_kind` | `intended_branch` | `trunk_branch` | Covers |
|---|---|---|---|---|
| `.` | `branch` | `px-crm-geoyws-driver-2` | `px-crm-geoyws` | the root, and anything without a nearer row |
| `services/aix-root` | `branch` | `aix-geoyws-driver-2` | `aix-geoyws` | that submodule **only** — every child has a nearer row |
| `services/aix-root/apps` | `expected_detached` | NULL | NULL | `apps/aix-node` (1 repo) |
| `services/aix-root/packages` | `expected_detached` | NULL | NULL | the 12 `packages/*` repos + the whole `std-root` subtree = 21 repos, less those with nearer rows |
| `services/aix-root/packages/aix-admin` | `exempt` | NULL | NULL | uninitialised sibling-product submodule |
| `services/aix-root/packages/aix-gql-hx` | `exempt` | NULL | NULL | uninitialised sibling-product submodule |
| `services/aix-root/packages/aix-tools-ix` | `exempt` | NULL | NULL | uninitialised sibling-product submodule |
| `services/aix-root/packages/aix-ui` | `exempt` | NULL | NULL | uninitialised sibling-product submodule |
| `services/aix-root/packages/std-root/apps` | `exempt` | NULL | NULL | uninitialised `std-root/apps/std-traefik` |

Re-derived against the same live walk, every repo accounted for exactly once: `.` matches its `branch` intent (1) · `services/aix-root` matches its own `branch` intent (1) · all **17** detached repos — including `packages/std-root` itself, which resolves to `services/aix-root/packages` — are detached under an `expected_detached` directory-prefix row (17) · all **5** uninitialised repos are `exempt`, and `exempt` fires no class at all (5). `1 + 1 + 17 + 5 = 24` repos, **0 drifting, exit 0.**

The four `exempt` rows sit at repo paths rather than a shared prefix because those four submodules interleave with owned ones under the same `packages/` directory — there is no prefix that selects them and nothing else. That is the honest row count, not a shortcoming to be rounded away.

Exit 0 is not achieved by weakening the check: `verify` still exits non-zero the moment `services/aix-root` moves off `aix-geoyws-driver-2` (`wrong-branch`), or any repo under an `expected_detached` row gets checked out onto a branch (`unexpectedly-attached`), or the root leaves `px-crm-geoyws-driver-2`, or an `exempt` submodule is later claimed as the lane's own work and its row cleared.

**Declaration debt, stated honestly.** Nine rows, not three, and the gap between them *is* the cost of adoption on this tree: **only the `.` row → 23 drift rows; Step 1's three rows → 13; Step 2's nine rows → 0.** `verify --strict` is not what closes that gap; `atmux branches verify --explain` (D3) prints, per drifting repo, the exact `--intended-for` / `--expect-detached` / `--exempt` invocation that would declare it — in the directory-prefix form where that is the correct placement. Working the noise to zero is a bounded one-time act per monorepo (worst measured: 24 repos → 9 intent rows), not a design flaw.

**Intent absent entirely** ⇒ `verify` has nothing to diff against for that repo and reports `no-intent` (informational, exit-code-neutral, never a drift class). A submodule-less or single-repo team never records anything and pays nothing. **`no-intent` is deliberately not a drift class**: a fresh monorepo nobody has declared anything about must read as "undeclared", not as "broken".

### D2 — Persistence: two STRICT tables in the team's `state.db`

Migration **`from: 18, to: 19`** in `src/abstractions/sqlite-migrations.ts`. Verified on 2026-08-06: the highest landed rung is `from: 16, to: 17` (ADR-261 §D4's `issue_sync` + `issue_sync_cursor`, lines 811-844), so `to: 18` is the next free number and `to: 19` is the one after.

**Rung assignment, stated up front and pinned.** Two ADRs in this 2026-08-06 batch each need a rung, and both initially claimed `to: 17` — which is already taken. They are now split explicitly so the collision cannot happen at implementation time:

| ADR | Table(s) | Rung |
|---|---|---|
| [ADR-267](267-durable-agent-continuity-contract.md) (R1) | `task_notes` | **`from: 17, to: 18`** |
| ADR-269 (R3, this ADR) | `branch_ledger`, `branch_ledger_intent` | **`from: 18, to: 19`** |

ADR-269 deliberately takes the **later** rung: ADR-267's `task_notes` is the higher-priority continuity leg and should not be blocked on this one. Per ADR-126's single append-only ladder the ladder must stay monotonic, so if ADR-267's rung has not landed when this one is implemented, **this migration still writes `from: 18, to: 19` and simply cannot apply until 17→18 exists** — the implementer's job is to confirm with `rg -n 'from: 1[6-9]' src/abstractions/sqlite-migrations.ts` and take the next free pair if the batch landed in a different order. Renumber precedent is already in the file (the v14→v15 and v15→v16 renumber comments at lines 655-662 and 728-735). No landed `up` body is ever edited.

```sql
CREATE TABLE branch_ledger (
  team            TEXT NOT NULL,
  lane            TEXT NOT NULL,   -- member name ('driver-2', 'be-1') or the literal 'operator'
  monorepo_root   TEXT NOT NULL,   -- absolute `git rev-parse --show-toplevel` of the observed root
  repo_path       TEXT NOT NULL,   -- '.' for the root, else root-relative $displaypath
  parent_path     TEXT,
  depth           INTEGER NOT NULL,
  role            TEXT NOT NULL,
  head_state      TEXT NOT NULL,
  branch          TEXT,
  head_sha        TEXT,
  dirty           INTEGER NOT NULL DEFAULT 0,
  dirty_count     INTEGER,
  upstream        TEXT,
  ahead           INTEGER,
  behind          INTEGER,
  observed_at_sec INTEGER NOT NULL,
  extra           TEXT,            -- JSON passthrough
  PRIMARY KEY (team, lane, monorepo_root, repo_path)
) STRICT;
CREATE INDEX idx_branch_ledger_lane_order
  ON branch_ledger(team, lane, monorepo_root, depth, repo_path);
CREATE INDEX idx_branch_ledger_observed ON branch_ledger(team, observed_at_sec);

CREATE TABLE branch_ledger_intent (
  team            TEXT NOT NULL,
  lane            TEXT NOT NULL,
  monorepo_root   TEXT NOT NULL,
  repo_path       TEXT NOT NULL,   -- '.' = monorepo-wide default; else a root-relative
                                   -- $displaypath overriding '.' for that repo + its subtree
  intent_kind     TEXT NOT NULL,   -- 'branch' | 'expected_detached' | 'exempt'
  intended_branch TEXT,            -- required iff intent_kind='branch'; NULL otherwise
  trunk_branch    TEXT,
  source          TEXT NOT NULL,
  set_by          TEXT,
  set_at_sec      INTEGER NOT NULL,
  extra           TEXT,
  PRIMARY KEY (team, lane, monorepo_root, repo_path)
) STRICT;
CREATE INDEX idx_branch_ledger_intent_lane
  ON branch_ledger_intent(team, lane, monorepo_root, repo_path);
```

**Why `repo_path` is in the intent PK, and why `intended_branch` lost `NOT NULL`.** Both are forced by measured reality (Context §"Measured reality"): `crm-react` driver-2 needs three different intents for one monorepo root, and two of the three name no branch at all. A `(team, lane, monorepo_root)` PK with `intended_branch TEXT NOT NULL` can express exactly one of them, so the other two repos would be scored as drift forever. The `'.'` row preserves the ergonomics the old shape had — declare one branch, cover the whole monorepo — as a **default** rather than a ceiling.

Permissive TEXT with no CHECK constraints on `role` / `head_state` / `source` / `intent_kind` — house posture (`src/abstractions/sqlite-migrations.ts` header §), so a future literal lands without an ALTER. Enums, and the `intent_kind='branch' ⇒ intended_branch NOT NULL` conditional requirement, are gated at the Zod + verb layer.

**`branch_ledger` is a current-state upsert, not a history log** — one row per repo per lane, last observation wins. Rationale in Alternatives (7).

**Residency.** `<atmuxDir>/state.db` (`src/core/kanban.ts:89` — `join(atmuxDir, "state.db")`; note this is `.atmux/state.db`, **not** `.atmux/state/state.db`), resolved UP to the team root per ADR-245, never a worktree-local DB (the `checkWorktreeNestedStateDb` probe, `src/verbs/doctor.ts:243`, already guards that). Under ADR-239 §Supplement-2026-05-26 + ADR-244 §Supersession-2026-05-26 the whole of `.atmux/` is a symlink into `~/work/journals/.sb/_dotfiles/atmux/<repo-key>/`, and each managed repo's `.gitignore` line 1 is `.atmux/*`. **The ledger inherits that isolation and needs it:** its rows spell out internal lane topology and cross-product branch names (`px-crm-geoyws-driver-2`, sibling-product submodule paths) — precisely the artifact class a teammate cloning `property-root` must never see. This satisfies R2 for R3's output with zero new mechanism.

`team` is denormalized into both tables even though one `state.db` is one team, mirroring `refusal_events.team` (v7→v8, line 377): it makes a future cockpit-level aggregation a plain `UNION` over per-team DBs, and makes a hand-run `sqlite3` query self-describing.

### D3 — Verb surface: `atmux branches record | intend | show | verify`

New verb module `src/verbs/branches.ts` + pure helper `src/core/branch-ledger.ts` (walker/differ, injectable `GitSpawn`, zero IO — the house pattern of `src/core/lane-drift.ts` behind `src/verbs/lane-drift-check.ts`). Registered in `src/cli.ts` beside `case "lane-drift-check":` (line 255). No collision: `rg 'case "branch' src/cli.ts` returns nothing.

- **`atmux branches record [--lane <member>] [--intended <branch>] [--trunk <branch>] [--root <path>] [--team-dir <dir>]`**
  Walks root + nested submodules, upserts one `branch_ledger` row per repo — **that upsert is the record of what a recursive op actually achieved per repo**, because the walk is a live read taken after the op, not a transcription of the branch string the operator typed. A `/rcheckout px-crm-geoyws-driver-2` that landed on 4 of 18 repos records 4 attached rows and 14 unchanged ones; nothing in the ledger claims otherwise.
  Writes `branch_ledger_intent` **only when `--intended` is given**, and then **only the `repo_path = '.'` default row** (`intent_kind = 'branch'`) — a bare `record` refreshes observations and leaves intent untouched. `--lane` explicit wins; else derived from the cwd path segment when cwd is under `<atmuxDir>/worktrees/<member>/`; else the literal `operator`.
  **`record` never writes a per-repo override.** Per-repo intent comes only from the three explicit flags below. This is the anti-inference rule (D4) applied to the intent table: an automatic writer that turned each repo's observed branch into that repo's intent would ratify `rentx-root`'s divergence as intended and make drift permanently undetectable.
- **`atmux branches intend --lane <member> ( --intended-for <repo>=<branch> | --expect-detached <repo> | --exempt <repo> )… [--trunk-for <repo>=<branch>] [--clear <repo>] [--root <path>]`**
  The only writer of per-repo intent rows. `<repo>` is a root-relative path — **a repo path or any intermediate directory prefix**, per D1(b)'s resolution rule; a row covers that path *and* its whole subtree, so `--expect-detached services/aix-root/packages` is one command for 21 repos. Placement matters and is not cosmetic: a row *at* a subtree root also declares that root, which is why the read-only declarations in D1(b)'s worked examples sit at `…/apps` and `…/packages` rather than at the `std-root` roots themselves. `--clear <repo>` deletes that override and returns the repo to whatever the nearest surviving ancestor row says. Repeatable; all rows in one `BEGIN IMMEDIATE` transaction. `source = 'operator'`.
- **`atmux branches show [--lane <member>] [--json]`**
  Prints the resolved per-repo intent then the ledger as a depth-indented table: repo path, resolved `intent_kind` + `intended_branch` (with the `repo_path` the intent was inherited from, so a reader can see *why* a repo is expected to be detached), the observed head — the `branch` name when `head_state = 'attached'`, otherwise the state itself in parentheses: `(detached)` / `(unborn)` / `(uninitialised)` / `(absent)`, covering all five D1(a) values — `sha7`, dirty marker, `±ahead/behind`, observation age. **Every recorded row is printed, including `uninitialised` and `absent` ones; a repo is never omitted for lacking a branch** — that is what makes D5 assertion 5 (the 5 declared-but-uninitialised `crm-react` repos listed as `uninitialised`) satisfiable by an implementer following this spec literally. `--json` is the agent-facing form. Read-only; no git calls; works when every repo is offline.
- **`atmux branches verify [--lane <member>] [--strict] [--flag] [--explain]`**
  **Fresh live walk**, diffed against the **resolved per-repo intent** (D1(b)). **Exit code = number of drifting repos** (mirroring `recursive-checkout.sh:84`, `exit "$fail"`). Also reports ledger staleness (live-vs-recorded) as information.

  **Every drift class is evaluated against the resolved intent for that repo, never against the `.` row directly** — that single sentence is what stops the false-alarm storm measured in Context. Classes, by `intent_kind`:

  | Resolved `intent_kind` | Drift classes that can fire | Classes that **cannot** fire |
  |---|---|---|
  | `branch` | `missing-branch`, `wrong-branch`, `detached`, `uninitialised`/`absent`, `dirty`, `unpushed` | — |
  | `expected_detached` | `unexpectedly-attached` (HEAD on a branch), `dirty`, `uninitialised`/`absent` | **`missing-branch`**, `wrong-branch`, `detached`, `unpushed` |
  | `exempt` | none | all |
  | no row resolves | none — reports `no-intent` (informational) | all |

  1. `missing-branch` — `intended_branch` exists in neither `refs/heads/` nor `refs/remotes/origin/` for that repo. **Highest severity**: this is the silent case, the `WARN:`-and-continue at `recursive-checkout.sh:70`. **Structurally unreachable unless the resolved `intent_kind` is `branch`** — there is no `intended_branch` to look for otherwise. That is the guard that keeps a vendored `std-root` child or a sibling-product submodule from ever producing a RED row for a branch the lane never owned there.
  2. `wrong-branch` — attached to a branch ≠ resolved `intended_branch`.
  3. `detached` — detached while the resolved intent is `intent_kind = 'branch'`.
  4. `unexpectedly-attached` — attached while the resolved intent is `expected_detached`. New class, and the reason `expected_detached` is a positive assertion rather than a synonym for `exempt`: someone checking a branch out inside a vendored subtree is real drift worth a YELLOW.
  5. `uninitialised` / `absent`.
  6. `dirty` — warn class; counted as drift only under `--strict`.
  7. `unpushed` — `ahead > 0`; warn class only, because ahead/behind is fetch-stale.

  `--explain` prints, for each drifting repo, the exact `atmux branches intend …` invocation that would declare it — so bringing a newly-adopted monorepo to a clean `verify` is a bounded one-time act with the commands handed to the operator, instead of a hunt.
  `--flag` additionally appends a formatted entry to `<atmuxDir>/flags.md` via `appendText`, exactly the precedent of `defaultRaiseFlag` (`src/verbs/lane-drift-check.ts:434-440`). Not default-on: `verify`'s contract is its exit code.

**Intent is a declaration, not a normalisation.** `atmux branches intend` records that a divergence is *expected*; it never changes a branch, never touches git, and the observation table keeps recording the divergent branch verbatim. So `crm-react` driver-2's `services/aix-root` on `aix-geoyws-driver-2` remains visible as a different branch family in `show` output whether or not it has been declared — declaring it only stops it counting toward `verify`'s exit code.

**Recursion mechanics.** Enumeration needs two git reads, because neither alone is sufficient:

- `git submodule status --recursive` lists the **declared** set including uninitialised nodes (leading `-`) — `foreach` skips those entirely, so `foreach` alone would render an uninitialised submodule invisible rather than recorded. `parseSubmoduleStatus` already exists for the non-recursive form (`src/verbs/doctor/git.ts:32`) and is reusable.
- `git submodule foreach --recursive --quiet 'echo "$displaypath"'` gives the initialised set with root-relative paths — the same call the four shipped scripts use, so traversal semantics stay identical to the ops the ledger describes.

`parent_path` and `depth` are derived **without extra git calls**: sort the collected `repo_path` set and take each repo's parent to be the longest known `repo_path` that is a strict path-prefix of it (root `.` is the fallback parent). **This is the same longest-prefix walk D1(b) uses to resolve intent — one helper, two callers.**

Do **not** compute depth from slash count. The measured worst case, from `/root/work/ifca/src/crm-react/.atmux/worktrees/driver-2` on 2026-08-06:

```
services/aix-root/packages/std-root/packages/std-core
```

Six path segments, **nesting depth 3** (`crm-react` → `services/aix-root` → `.../std-root` → `.../std-core`). Slash-counting would call it depth 5. The same shape occurs in `/root/work/ifca/src/ix-root` at `packages/aix-root/packages/std-root/packages/std-core`, and `ix-root` additionally carries the **same subtree twice** at two different depths (`packages/std-root/*` at depth 2 and `packages/aix-root/packages/std-root/*` at depth 3), which is the case that proves parent must be derived from the path set rather than from a basename lookup.

Per-repo fields come from `git -C <abs-path> …` shell-outs through the house spawn abstraction, using the `ATMUX_GIT_TIMEOUT_MS` seam (`resolveGitTimeoutMs`, `src/abstractions/spawn.ts:102`, default `DEFAULT_GIT_SPAWN_TIMEOUT_MS = 30_000` at line 90).

Edge cases, each an explicit recorded outcome rather than an abort:
- **Uninitialised submodule** → `head_state = 'uninitialised'`. Its own nested children are **unknowable** until init (there is no git dir to read `.gitmodules` from), so the ledger records the node and does **not** fabricate a subtree. ADR-088's `worktreeInitSubmodules` is what closes this for atmux-provisioned worktrees.
- **Absent path** → `head_state = 'absent'`.
- **Path present but not a git repo** (the ADR-088 empty-directory case) → `uninitialised`.
- **A repo that is itself a git worktree** (`.git` is a file containing `gitdir:`) → all probes are plain `git -C <path>` calls, which resolve gitlink and worktree `.git` files transparently; no special-casing. **Untested against a submodule nested inside a git worktree of the superproject — verify in Phase 1** against `/root/work/ifca/src/crm-react/.atmux/worktrees/driver-2`, which is exactly that shape (an atmux-provisioned git worktree of `crm-react` carrying 23 declared submodules nested 3 deep), before claiming it works.
- **Detached, unborn (`--abbrev-ref HEAD` returns `HEAD` on an empty repo), no-upstream** → recorded states, never faults.
- Any per-repo probe failure records `extra.probeError` for that repo and the walk continues. A single broken submodule must never abort the sweep — the same failure-tolerance the four scripts already have.

### D4 — Write points: where branch state actually changes

The ledger is worthless if it is only ever written on demand, because the moment worth capturing is the moment the branch changed.

1. **The four recursive scripts.** After the action loop and before the summary line, each of `scripts/recursive-{checkout,pull,push,reset}.sh` invokes:
   ```bash
   command -v atmux >/dev/null 2>&1 && \
     atmux branches record --intended "$branch" --root "$root_abs" >/dev/null 2>&1 || true
   ```
   Guarded and **never** able to change the script's exit code (which stays "number of repos that failed"). A host without `atmux` on PATH, or a repo with no `.atmux/` up-tree, is a silent no-op. All four record, not just checkout: `checkout` changes `branch`; `pull`/`reset` change `head_sha` and `ahead`/`behind`; `push` changes `ahead`. A ledger refreshed only on checkout would go stale on the very next `/rpull`.
   **`--intended "$branch"` writes only the `.` default row** (D3), so a `/rpull` whose `<branch>` arg is a *filter* rather than a target cannot silently overwrite a per-repo override. It can, however, overwrite another op's `.` row — `.`-row intent is last-write-wins, which is correct (the most recent explicit statement of the monorepo-wide branch is the current one) and is exactly why per-repo declarations live in their own PK rows where a `.`-row rewrite cannot reach them.
   **Distribution caveat:** per ADR-035 **Decision §2** ("Skills are deployed per-team, not global", `docs/adr/035-per-member-branch-recursive-ops.md:39`) these scripts are **copied per-team** into each managed project's `scripts/`. This hook lands in the atmux canon and reaches `crm-react` / `rentx-root` / `ix-root` / `sopx` only when the operator re-copies. Copy drift is real and is left to a follow-up (Open question 3).
2. **Worktree provisioning.** `src/verbs/start.ts` records after a successful `provisionWorktree(...)` — the two sites that already pass `initSubmodules` from `team.worktreeInitSubmodules` are the driver-worktree call at `src/verbs/start.ts:528-531` (flag at `:530`) and the member-worktree call at `src/verbs/start.ts:684-688` (flag at `:687`); and `src/verbs/team/spawn-epic.ts:641-645` for epic-team worktrees — **record after that call returns and before the `Team.parse({…})` child-team synthesis at `:650`.** Intent = the ADR-084 `wtBranch` the caller just created, written as the `repo_path = '.'` default row only; `trunk` = `baseBranch`; `source = 'worktree-provision'`; `lane` = the member name.
   - **Order matters:** record *after* `initSubmodules` runs, otherwise every submodule reads `uninitialised`.
   - **The write goes in the verb layer, not the abstraction.** `src/abstractions/worktree.ts` must not touch `state.db` — ADR-096 layering, and a reviewer would rightly block it. `provisionWorktree` stays pure plumbing.
   - The idempotent path (`created === false`) still records: the observation is cheap and the caller legitimately knows the intent.
3. **Nothing polls.** No orchd ticker, no cron, no event consumer in v1 — manual orchestration is the fleet default (ADR-260) and a recursive walk is the most expensive probe in the tree (Consequences). `record` is otherwise agent- or operator-invoked.

**The anti-inference rule (ADR-035 §1 preserved, verbatim intent).** `<branch>` remains **mandatory** on all four recursive scripts. This ADR adds **no** read path from the ledger into any recursive op, and there is no no-arg variant of anything. Recording observed state is not the same act as inferring a checkout target: the ledger answers *"what is each repo on, and what did someone explicitly say it should be on"*, never *"what should I check out if you don't tell me."* The `.gitmodules` smart default ADR-035 forbade is forbidden one level up too.

The rule has **two prohibited directions**, and per-repo intent makes the second one newly reachable, so it is named explicitly:

1. **Ledger → checkout target** — forbidden. No recursive op reads the ledger. This is ADR-035 §1 carried forward unchanged.
2. **Observation → intent** — forbidden. No automatic writer may turn a repo's observed branch into that repo's intent. `record` writes the `.` row from an explicitly-typed `--intended` and nothing else; per-repo rows come only from `atmux branches intend`, which a human runs. Were direction 2 allowed, `record` on `/root/work/ifca/src/rentx-root` would write `gz/business-backend → rentx-geoyws` as *intended* purely because that is where it sits, the ledger would report zero drift forever, and the capability would be worse than absent — it would be a green light with no measurement behind it.

A future **replay** convenience — re-checking-out a monorepo from a recorded lane intent — is explicitly **deferred to its own decision**, and if it ever ships it must (a) name a lane explicitly on the command line, (b) never be the default behaviour of any existing verb or script, and (c) never activate with no argument. v1 needs none of it: `atmux branches show` prints the resolved per-repo intent, and the agent types `/rcheckout <that branch>` itself. That is one human-readable step and it keeps the branch argument explicit, which is the whole point of ADR-035.

### D5 — Continuity payoff, stated as the acceptance test

This is the R3 leg of the same continuity guarantee [ADR-267](267-durable-agent-continuity-contract.md) makes for plans and todos: a replacement agent must be able to resume without operator re-explanation.

**Acceptance test.** The Given is the real tree measured on 2026-08-06, divergence included — not an idealised uniform one — because a test written against a uniform tree passes without ever exercising the field that made this design necessary.

- **Given** team `crm-react`, lane `driver-2`, monorepo root `/root/work/ifca/src/crm-react/.atmux/worktrees/driver-2`: root on `px-crm-geoyws-driver-2`, `services/aix-root` on `aix-geoyws-driver-2`, 17 nested repos detached, 5 declared-but-uninitialised, 24 repos in total. Intent recorded as **the nine rows of D1(b)'s worked example Step 2** — `.` = `branch px-crm-geoyws-driver-2` / trunk `px-crm-geoyws`; `services/aix-root` = `branch aix-geoyws-driver-2` / trunk `aix-geoyws`; `services/aix-root/apps` and `services/aix-root/packages` = `expected_detached`; and five `exempt` rows for the uninitialised sibling-product submodules. **Step 1's three-row set is deliberately *not* the Given**, because it reaches exit 13, not 0 — that number is asserted separately below rather than wished away.
- **When** agent A dies from token exhaustion with no handoff prose written — the exact case where `atmux handoff` degrades to a `tmux capture-pane` tail or a "source pane gone" stub — and agent B spawns into the same lane and runs `atmux branches show --lane driver-2 --json`.
- **Then PASS iff** agent B can, from that single command's output alone, answer **per repo** — every assertion below is on a named repo, not on the monorepo as a whole, and not on "a command printed something":
  1. **`.` → `px-crm-geoyws-driver-2`, trunk `px-crm-geoyws`.** Asserting the root's branch alone is the weak version of this test and does not count.
  2. **`services/aix-root` → `aix-geoyws-driver-2`, trunk `aix-geoyws`** — a *different* branch and a *different* trunk from the root. A ledger that answered `px-crm-geoyws-driver-2` here would be wrong, and the single-intent schema this ADR replaces answered exactly that.
  3. **`services/aix-root/packages/std-root/packages/std-core` → `expected_detached`, inherited from `services/aix-root/packages`.** The output must name the ancestor row the intent came from — and here that ancestor is a **directory prefix, not a repo**, which is the placement rule D1(b) makes load-bearing. Agent B must be able to tell "declared read-only" from "nobody has said".
  4. **`services/aix-root/packages/aix-gql-px` → `expected_detached`, inherited from `services/aix-root/packages`.** This is the inheritance-visibility assertion, and it is stated as two things the output must **not** say. It must not resolve to the `.` row's `px-crm-geoyws-driver-2` — `services/aix-root/packages` is a longer matching prefix, and resolving to `.` here is the specific error this ADR's own earlier drafts made. And it must not report `missing-branch`: measured 2026-08-06, that repo carries `refs/heads/px-crm-geoyws-driver-2` *and* `refs/remotes/origin/px-crm-geoyws-driver-2` while sitting detached, so even against the `.` row the class would have been `detached`. Inheritance must be visible as inheritance and never be mistaken for a declaration.
  5. **The 5 uninitialised repos are listed** as `uninitialised`, not omitted — `git submodule foreach` alone would hide them (D3 recursion mechanics), so their presence in the output is the assertion that both git reads happened.
- **And PASS iff `atmux branches verify --lane driver-2` exits `0`** with the nine-row Given in place. This is the anti-noise leg: 23 of the 24 repos are not attached to the root's branch, and a correct implementation still exits 0 because each one's *resolved* intent is satisfied. An implementation that exits 23 here has the defect this redesign exists to remove.
- **And PASS iff the same tree, declared only with Step 1's three rows, exits exactly `13`; and declared with only the `.` row, exactly `23`.** Three declarations, three pinned numbers, one tree — this is what makes the exit-0 bullet above a measurement rather than a hope. The 13 decomposes as 8 `missing-branch` (measured against `services/aix-root`'s `aix-geoyws-driver-2`, which exists in no repo beneath it) + 5 `uninitialised` (4 resolving to a `branch` row, 1 to an `expected_detached` row), per D1(b) Step 1's table. Any implementation returning the same number for all three declarations is broken regardless of which number it is.
- **And PASS iff** moving any single repo away from its resolved intent — e.g. `git -C services/aix-root checkout aix-geoyws`, which yields `wrong-branch` on exactly that repo and leaves its children resolving to their own nearer rows untouched — makes `verify` exit exactly `1` and names that repo. Non-zero-on-real-drift and zero-on-correct-tree are one test, not two; either alone is passable by a broken implementation (always-0 passes the first, always-N passes the second).
- **FAIL** if agent B has to ask "which branch am I on?", or if any assertion above is satisfied only at the monorepo level. That is today's behaviour: the answer exists only in the operator's head and in a `/rcheckout` argument that has scrolled away.

### D6 — Drift surfacing: how a non-zero exit reaches a human

**Checked, not assumed:** `src/verbs/lane-drift-check.ts` is **not** about git branches. It loads in-progress kanban tasks, classifies each owner's tmux pane, greps the last N commit messages for task references, and reverts stalled claims to `todo` plus a `flags.md` entry ([ADR-176](176-epic-aware-lane-drift-revert.md), which supersedes in part [ADR-127](127-lane-claim-auto-pickup.md) §OQ5 — the original 3-criterion auto-revert algorithm; there is no ADR-062 in `docs/adr/`). Its only git call is `git(["log", …])` at line 334 with **no `-C`** and no submodule traversal — so it is cwd-scoped and root-repo-only, and it is a different failure class entirely ("claimed but not progressing", not "on the wrong branch").

Therefore the branch ledger **sits beside `lane-drift-check`, it does not extend it.** And a naming rule: the new failure class is **branch drift**, never "lane drift". Two mechanisms sharing the word "drift" with different meanings is exactly the load-bearing ambiguity the operator's §Language rule forbids; keep the nouns distinct in code, verbs, docs, and flag text.

Two surfaces:

1. **Doctor probe `checkBranchLedgerDrift`** in `src/verbs/doctor/git.ts` (the file that already owns `checkSubmoduleIntegrity`), registered in `runAllChecks` next to it (`src/verbs/doctor.ts:207`). The probe **reads the ledger only — it does not re-walk.** Rows:
   **The probe classifies against the resolved per-repo intent, using the identical resolver `verify` uses** (`src/core/branch-ledger.ts`, one implementation, two callers). A probe with its own looser rule would re-import exactly the false-alarm behaviour D1(b) removed. Rows:
   - **RED** per recorded `missing-branch` — which, per D3, can only arise where the resolved `intent_kind` is `branch`. **On the three monorepos measured in Context, correctly declared, this probe emits zero RED rows.** That is the acceptance bar for the probe itself, not an aspiration: a probe that RED-flags a vendored `std-root` child gets ignored, and an ignored probe is worse than no probe.
   - **YELLOW** per recorded `wrong-branch`, `detached`-against-`branch`-intent, or `unexpectedly-attached`-against-`expected_detached`-intent; YELLOW per dirty repo.
   - **Nothing** for `exempt` repos and nothing for `no-intent` repos. `no-intent` is not a doctor row: a monorepo nobody has declared anything about is undeclared, not broken. The one exception is the aggregate hint below.
   - **YELLOW, once per lane** when a lane has `branch_ledger` rows but **no** `branch_ledger_intent` rows at all: *"no branch intent recorded for lane `<lane>` — run `atmux branches record --intended <branch>`."* One row per lane, never one per repo, so an undeclared 24-repo monorepo costs one line.
   - **YELLOW** when the newest `observed_at_sec` for a lane is older than a threshold: *"ledger stale — run `atmux branches record`."*
   - **No row at all** when the team has no ledger rows. Submodule-less teams and single-repo teams pay exactly zero, which is what keeps this probe acceptable in an already-long doctor chain.
   The live re-walk stays `atmux branches verify`'s job, invoked explicitly. This split is deliberate: doctor is cheap and reports *recorded* state plus its age; verify is expensive and reports *live* truth.
2. **`atmux branches verify --flag`** appends to `<atmuxDir>/flags.md` (the `lane-drift-check.ts:434-440` precedent), giving a durable operator-visible surface for a scripted/CI invocation whose exit code nobody is watching.

**No new event topic.** ADR-203's closed set is untouched — v1 emits nothing, exactly as `lane-drift-check` emits nothing.

**No Discord path, and no `whip` path.** The `whip` CLI verb no longer exists: [ADR-266](266-shim-sunset-policy-and-first-sweep.md) §D2 removed `whip` + `whip-resume-check` from `src/cli.ts` and dropped the `whip` row from `atmux help` (verified 2026-08-06: `rg -n -i 'whip' src/cli.ts` → no match; `ls src/verbs/ | grep -i whip` → nothing), and §D3 deleted `src/core/whip-escalation.ts` as dead code. So branch drift has exactly the two surfaces above — the doctor probe and `flags.md` — plus lead adjudication via [ADR-214](214-retire-ombudsman-lead-absorbs-complaint-adjudication-via-honker.md) once a flag is raised. [ADR-237](237-no-llm-discord-and-whip-removal.md) is the standing operator position against LLM cadence into Discord and is cited here as **Status: Proposed**, not as accepted law (ADR-266's own Context records that 237 "never completed cutover conditions or [is] still Proposed"); this ADR does not rely on it, because it adds no cadence and no Discord path of its own.

## Out of scope

- **Replay / re-checkout from the ledger** — deferred to its own decision, with the three constraints in D4.
- **Any orchd ticker or cron cadence** for `record` / `verify` — v1 is manual-invocation only (ADR-260); a cadence needs the traversal cost measured first (Open question 1).
- **A new event topic** (`branch.drift` et al) — ADR-203 closed set untouched.
- **Enforcement.** The ledger detects drift; it does not prevent it. No pre-commit hook, no push gate, no auto-correction.
- **Cross-team / fleet-wide aggregation** of ledgers across the cockpit — the `team` column makes it cheap later; no v1 code.
- **`.gitmodules` authoring or `--remote` SHA-bump policy** — ADR-035 §4 stands untouched.

## Alternatives considered

1. **`.gitmodules` `branch =` as the source of truth** — **rejected**, and this is settled law: ADR-035 §Context failure-mode 2 ("a fixed declaration… correct for at most one member and wrong for all others") and §4 (remote-tracking hint, not a checkout target). This ADR exists precisely because that rejection left a vacancy. Worth recording that `.gitmodules` is *also* insufficient on its own terms: `/root/work/ifca/src/rentx-root/.gitmodules` declares `branch = rentx-geoyws` for two submodules and `branch = rx-geoyws` for a third, so even the fixed declaration is non-uniform — a single-branch reader of `.gitmodules` would be wrong there before any member started working.
2. **A single `intended_branch` per `(team, lane, monorepo_root)`** — this was **this ADR's own first design and it is rejected**, recorded here rather than quietly edited out because the rejection is the load-bearing decision of the file. It cannot represent any of the three monorepos measured in Context, and on the very lane D5's acceptance test names it would score 23 drift rows and 14 RED doctor rows against a correctly provisioned tree. `docs/brd/atmux.md` §BR7 (`:161`) states the consequence: *"A drift report that flags correct read-only state is noise, and noise is how a probe gets ignored."* Superseded by the per-repo PK in D2 with the `'.'` row preserving the one-branch-per-monorepo ergonomics as a default.
3. **Per-repo intent, but with no `expected_detached` / `exempt` kinds** — **rejected.** Without them the only way to stop `missing-branch` firing on a vendored `std-root` child is to invent a fake `intended_branch` for it, which is a lie in the highest-severity field, or to leave the repo undeclared, which loses the ability to detect someone checking a branch out inside a read-only subtree. Two extra `intent_kind` literals in an already-free-form TEXT column cost nothing and make the honest statement sayable.
4. **A JSON file (`.atmux/state/branch-ledger.json`)** — **rejected.** Concurrent lanes record independently (5 driver worktrees each running `/rcheckout`), so a single JSON file needs `flock` — the exact hazard ADR-098 documents and ADR-126 narrowed away from; the flock-race class is already recorded in the `spawn_queue` migration comment (`src/abstractions/sqlite-migrations.ts:669-672`). Per-lane JSON files instead reintroduce the shared-worktree Write-clobber class. `state.db` gives WAL serialization and `BEGIN IMMEDIATE` for free and is already `.gitignore`d.
5. **Extending `merger_state`** — **rejected.** It is keyed on `member_branch` (one root-repo branch per member) and carries a 10-state merge machine whose `merged` state is permanent-terminal. Adding per-submodule observation rows breaks the primary key and conflates merge state with checkout state.
6. **Extending `atmux lane-drift-check`** — **rejected** on both grounds in D6: different failure class, and the shared word "drift" would be forbidden ambiguity.
7. **An append-only history table instead of a current-state upsert** — **deferred, not adopted.** Growth is (lanes × repos × every recursive op): the measured `crm-react` tree is 24 repos, so 3 lanes write 72 rows per sweep, and every `/rpull` is a sweep. No v1 question needs history — "what is each repo on now, and how stale is that reading" is answered by the upsert plus `observed_at_sec`. If an audit trail is ever wanted, the existing `events` table is the place, and that needs an ADR-203 amendment.
8. **Writing the ledger inside `provisionWorktree`** — **rejected** on ADR-096 layering: `src/abstractions/` must not reach into `state.db`. The verb-layer caller records (D4.2).
9. **A `post-checkout` git hook installed in the root and every submodule** — **rejected.** Installing 24 hooks per lane into product repos (the measured `crm-react` driver-2 repo count) is exactly the host-repo pollution R2 forbids, hooks are per-clone (invisible to a teammate, unversioned), and the operator's hook-bypass discipline makes hooks a poor home for observability.
10. **Recording each repo's observed branch as that repo's intent, automatically** — **rejected**, and this is the sharpest of the rejections because it looks like a convenience. It makes the ledger self-satisfying: `record` on `rentx-root` would write `gz/business-backend → rentx-geoyws` as *intended* solely because that is where it sits, `verify` would exit 0 forever, and the operator's uniform-name convention would become unverifiable at the exact moment the tooling claimed to verify it. Intent is written only from an explicit human act (D4 anti-inference rule, direction 2).

## Consequences

**Positive**

- The question ADR-035 left unanswered on 2026-04-29 gets an answer that keeps every one of ADR-035's own constraints intact: branch arg still mandatory, no `.gitmodules` default, no inference in either direction.
- Drift becomes **nameable per repo**: `missing-branch` in one of `crm-react` driver-2's 23 submodules stops being a `WARN:` line inside a sweep summary and becomes a RED doctor row plus a non-zero `verify` exit — **and, equally load-bearing, a vendored `std-root` child stops producing that row at all**, because `expected_detached` makes "this one is not ours" sayable. A drift surface is only as valuable as its false-positive rate.
- A replacement agent taking over a monorepo lane reads one command instead of asking the operator, and gets the answer **per repo**, including the repos whose branch family differs from the root's (D5).
- Additive only: two leaf tables, one verb module, one pure core helper, four guarded shell one-liners, three verb-layer call sites. Zero changes to any documented surface's semantics.

**Negative / risks**

- **Traversal cost.** Measured repo counts, 2026-08-06: `/root/work/ifca/src/crm-react/.atmux/worktrees/driver-2` = 24 repos (23 declared submodules + root, 18 initialised); `/root/work/ifca/src/ix-root` = 39 repos (38 declared + root); `/root/work/ifca/src/rentx-root` = 19 repos (18 declared + root, of which only 7 are initialised — 11 uninitialised, the largest `uninitialised` population measured and the clearest case for D3's two-git-reads rule); `/root/work/ifca/src/property-root` = 15 repos (14 declared submodules, recursive count equal to top-level, i.e. **depth 1 — not a nesting test case**, and not a `type:"team"` root in `~/.atmux/cockpit.json`). At roughly four `git -C` spawns per repo that is ~96 spawns for `crm-react` driver-2 and **~156 for `ix-root`, the worst case in the fleet.** Wall-clock is **unmeasured — measure on `/root/work/ifca/src/ix-root` before wiring any cadence.** This is the direct reason v1 has no ticker (D4.3) and why the doctor probe reads the ledger instead of re-walking (D6.1). The `ATMUX_GIT_TIMEOUT_MS` seam bounds each call, not the total.
- **Declaration debt on adoption.** A newly adopted monorepo whose only intent row is `.` reports every non-conforming repo as drift until a human declares it — measured on `crm-react` driver-2: **23 rows with only `.`, 13 with D1(b) Step 1's three obvious subtree rows, 0 with Step 2's nine.** The middle number is the one worth internalising: the obvious declaration is not the complete one, because a subtree row does not silence an uninitialised node (only `exempt` does) and because read-only rows belong below the subtree root, not at it. This is real friction and it is deliberately *not* hidden: `verify --explain` emits the exact `atmux branches intend` commands, and the alternative (auto-declaring from observation) is Alternatives (10), rejected. Bounded one-time cost per monorepo, not per sweep.
- **Staleness — the ledger records an observation, not a lock.** Nothing stops a bare `git checkout` in one submodule one second after `record`. The ledger makes drift *detectable*, never *prevented*. Any consumer that reads a `branch_ledger` row as current state without checking `observed_at_sec` is wrong, and the doctor probe's staleness row exists to keep that honest. State this in `docs/RUNBOOK-branch-ledger.md` in the same words.
- **`ahead`/`behind` are fetch-stale by construction** — `record` deliberately does no `git fetch` (that is the recursive scripts' expensive network leg). The numbers are relative to whenever that repo last fetched, which the ledger does not currently record (Open question 2). Hence `unpushed` is warn-class only.
- **Script-copy drift.** The write points in the four scripts only reach a managed repo when the operator re-copies them there (ADR-035 Decision §2 per-team deployment). Until then that repo's `/rcheckout` records nothing and its ledger goes stale silently — the staleness doctor row is the only signal.
- **One new CLI noun** (`branches`) on top of roughly 70 verb modules, in a tree whose ADR-266 shim-sunset policy is an admission of surface bloat. Accepted: it is +1 noun for a capability with no existing home, and it retires nothing (so it also removes nothing). The noun carries four subverbs rather than three — `intend` is the price of a representable schema, and folding it into `record` was rejected because `record` runs automatically from shell hooks and must never write per-repo intent (D3).
- **Row volume**: lanes × repos per monorepo, plus one intent row per declared path per lane — a count the declaration drives, not a fixed number (D1(b)). `crm-react` carries 3 atmux worktree lanes under `.atmux/worktrees/` (measured 2026-08-06: `driver-2`, `driver-3`, `table-width`) × ~24 repos ≈ 72 observation rows, and ~9 intent rows **per lane** ≈ 27; `ix-root` at one lane is 39 observation rows and 5 intent rows (`.` plus the four directory-prefix `expected_detached` rows of D1(b)). Trivial for SQLite; noted only so nobody is surprised by the row count.
- **Intent rows are a second thing that can be wrong.** A stale `expected_detached` row keeps `verify` quiet about a subtree that has since become the lane's own work. Mitigations: `show` always prints which `repo_path` an intent was inherited from, and `intend --clear <repo>` is one command. Not mitigated by anything automatic, by design — an automatic corrector would be Alternatives (10).

**Reversibility: HIGH.** Drop the two leaf tables (nothing references them), delete `src/verbs/branches.ts` + `src/core/branch-ledger.ts` + the `cli.ts` case, remove four shell one-liners and three verb-layer calls, unregister one doctor probe. No event schema, no topic, no `team.json` change, no behaviour change to any existing verb.

## Phasing

- **Phase 0** — this ADR + `docs/RUNBOOK-branch-ledger.md` + types-and-pure-functions only in `src/core/branch-ledger.ts` (the walk plan, the shared longest-prefix resolver used for both `parent_path` derivation and intent resolution, the intended-vs-actual differ). No migration, no verb, no behaviour.
- **Phase 1** — the `from: 18, to: 19` migration (or the next free pair if the batch lands out of order), `src/verbs/branches.ts` with all four subverbs (`record`, `intend`, `show`, `verify`), `src/cli.ts` registration, the four script one-liners, the `src/verbs/start.ts` + `spawn-epic.ts` record-after-provision calls, `checkBranchLedgerDrift` + its `runAllChecks` registration, `--json`, `--explain`, `--flag`. Tests same-commit per house rules:
  - **Unit, on the pure differ**: every drift class × every `intent_kind`, asserting the cells the D3 table says **cannot** fire actually cannot — in particular `missing-branch` must be unreachable under `expected_detached` and under `exempt`, and no class at all may fire under `exempt` or under `no-intent`; detached-is-not-drift-without-intent; longest-prefix intent resolution including a repo covered by an ancestor row two levels up and a repo whose own row overrides a nearer ancestor; `--clear` falling back to the surviving ancestor.
  - **Unit, on depth derivation**: `services/aix-root/packages/std-root/packages/std-core` must derive `depth = 3` and `parent_path = services/aix-root/packages/std-root`, not depth 5 — the measured 6-segment case. Plus `ix-root`'s duplicated-subtree case (`packages/std-root/*` at depth 2 and `packages/aix-root/packages/std-root/*` at depth 3 in one tree) to prove parent is resolved from the path set rather than a basename.
  - **Regression pin against the rejected single-intent design**: a fixture reproducing the measured `crm-react` driver-2 shape (root branch, one submodule on a different branch family, a detached vendored subtree, uninitialised nodes) must yield `verify` exit `0` with D1(b) Step 2's **nine** intent rows, exit exactly **13** with Step 1's three rows, and exit exactly **23** with only the `.` row. All three numbers asserted against one fixture — an always-0 implementation fails the second and third, an always-N fails the first, and an implementation that resolves `services/aix-root/packages/*` to the `.` row instead of to `services/aix-root` fails the 13. Also pin the **placement** rule, on a second fixture reproducing the measured `ix-root` shape (a vendored subtree whose root is *attached* while all its children are detached): declaring `expected_detached` at the two `std-root` subtree roots must yield exit **2** — one `unexpectedly-attached` per subtree root — while declaring it at those subtrees' `apps` and `packages` directory prefixes must yield exit **0**. Both live-verified on `/root/work/ifca/src/ix-root` (39 repos, 20 attached / 18 detached) on 2026-08-06. This is the test that fails if an implementer "helpfully" exempts the declaring node from its own row.
  - **Integration** against a fixture monorepo carrying two-level nesting, a deliberately uninitialised submodule, a detached submodule, and a submodule missing the lane branch. Per this repo's CLAUDE.md §Hooks-Commits-Tooling, any `bun test` invocation in unattended runs is wrapped in a GNU wall-clock `timeout`.
  - **Live verification, not a substitute for the above**: run `record` + `verify` against `/root/work/ifca/src/crm-react/.atmux/worktrees/driver-2` (the git-worktree-superproject case D3 flags as untested) and `/root/work/ifca/src/ix-root` (depth 3, duplicated subtree, 39 repos — the fleet worst case). `property-root` is **not** a suitable target for either: 14 submodules at depth 1, and not a `type:"team"` root in `~/.atmux/cockpit.json`.
- **Deferred (each its own decision)** — replay-from-ledger; an orchd `record` ticker once traversal cost is measured; a probe for per-team recursive-script copy drift; cockpit-wide ledger aggregation.

## Open questions

1. Measured wall-clock of `record` and `verify` on `/root/work/ifca/src/ix-root` (39 repos, depth 3 — the fleet worst case measured 2026-08-06) — needed before any cadence is armed. Phase 1 measures. **Threshold, pinned rather than left soft: if `record` exceeds 5s wall-clock on `ix-root`, or `verify` exceeds 10s, `record` grows a `--shallow` mode** that skips `dirty` / `ahead` / `behind` and records `branch` + `head_sha` only. Secondary datapoint on `/root/work/ifca/src/crm-react/.atmux/worktrees/driver-2` (24 repos) for the git-worktree-superproject path.
2. Should the ledger record a per-repo `last_fetch_sec` (stat of `git -C <p> rev-parse --git-path FETCH_HEAD`) so `ahead`/`behind` carry their own staleness? One extra call per repo against a real honesty gain. Leaning yes, but deferred out of Phase 1 to keep the traversal lean.
3. Per-team script-copy drift: a doctor probe diffing a managed repo's `scripts/recursive-*.sh` against the atmux canon would catch missing write points — but ADR-035 Decision §2 deliberately allows per-team script adaptation, so a naive hash comparison would false-positive. Needs its own small decision.
4. `lane` for work done directly in a team-root repo with no worktree isolation: the literal `operator` sentinel is proposed in D3. Confirm against how the operator actually works in `crm-react` before Phase 1 freezes it. Live datapoint 2026-08-06: `/root/work/ifca/src/crm-react` itself (the non-worktree checkout) sits on `px-crm-geoyws-driver-1` while `.atmux/worktrees/driver-2` and `driver-3` hold driver-2 and driver-3 — so the team root is *also* a lane in practice, and calling it `operator` may be the wrong label. Resolve before freezing.
5. Should `expected_detached` additionally assert the repo's `head_sha` equals the superproject's recorded gitlink SHA (i.e. `git submodule status` shows no leading `+`)? That is what "detached at the pinned SHA" literally means, and `checkSubmoduleIntegrity` (`src/verbs/doctor/git.ts:68-98`) already parses that `+` marker, so the data is one existing helper away. Deferred out of Phase 1: it would make `expected_detached` a two-part assertion, and pointer drift is ADR-057 §D5a's existing failure class, not this ADR's. Decide before `expected_detached`'s semantics are documented in `docs/RUNBOOK-branch-ledger.md`.

## Decision-anchors

1. **ADR-035 §1 and §Context failure-mode 2 are preserved, not amended.** `<branch>` stays mandatory on all four recursive scripts; `.gitmodules` stays a remote-tracking hint; no no-arg variant of anything ships. ADR-035's Decision §2 (per-team script deployment) is a separate rule and is cited as such — never as the home of the `.gitmodules` finding.
2. **Intent is PER-REPO, keyed `(team, lane, monorepo_root, repo_path)`**, with the `repo_path = '.'` row as the monorepo-wide default and nearer rows overriding it by longest path prefix. **A row governs the declaring node itself *and* its descendants, and there is no scope flag** — the PK allows one statement per path, so a scope flag would need two rows at one path. A descendants-only declaration is therefore made by **placing the row at an intermediate directory prefix**, which is why `ix-root`'s read-only rows sit at `packages/std-root/{apps,packages}` rather than at `packages/std-root`, whose own HEAD is attached to `ix-geoyws` (measured 2026-08-06; declaring at the root instead manufactures 2 false `unexpectedly-attached` rows). A single `intended_branch` per monorepo is **rejected** (Alternatives 2): it is unrepresentable on all three monorepos measured 2026-08-06 and would emit 14 RED doctor rows on the very lane D5 names.
3. **`intent_kind` ∈ {`branch`, `expected_detached`, `exempt`}, and `missing-branch` — the highest-severity class — is structurally unreachable outside `branch`.** A repo the lane does not own can never produce a RED row.
4. **Observation is authoritative about what *is*; the operator's uniform-name convention is the DEFAULT for what *should be*.** Convention drift stays visible as drift; it is never silently normalised. Declaring a divergence intentional is a human act, and the declaration does not erase the observation.
5. **Inference is forbidden in both directions.** Ledger → checkout target: no read path into any recursive op; replay deferred and, if it ever lands, must name a lane explicitly. Observation → intent: no automatic writer may derive a repo's intent from the branch it happens to be on (Alternatives 10). `record` writes only the `'.'` row, only from an explicitly-typed `--intended`.
6. **Detached HEAD is a recorded state, not an error** (ADR-035 §3). It is drift only against an intent that names a working branch — and under `expected_detached` the drift runs the other way (`unexpectedly-attached`).
7. **This ADR serves ADR-035's per-member model, not the uniform-branch model ADR-035 §Notes-for-the-future set aside.** Every row is lane-keyed; nothing is `.gitmodules`-driven; nothing enforces uniformity. Recording observed state is not adopting the uniform-branch model. If that model is ever wanted, ADR-035's note stands: it needs its own ADR.
8. **`state.db` under `.atmux/`, resolved up to the team root** (ADR-126 / ADR-245), inheriting ADR-239 + ADR-244 operator-private residency. Ledger rows never enter a product repo's git history.
9. **The state.db write lives in the verb layer**, never in `src/abstractions/worktree.ts` (ADR-096).
10. **"Branch drift", never "lane drift."** `atmux lane-drift-check` is a different failure class; the ledger sits beside it.
11. **The ledger records an observation, not a lock.** `observed_at_sec` is mandatory reading for every consumer.
12. **A drift surface that fires on a correct tree is a defect, not a conservative default.** Zero RED doctor rows on the three measured monorepos, correctly declared, is the acceptance bar for `checkBranchLedgerDrift` — and `verify` must be tested in both directions (exit 0 on the correct tree, exit ≠ 0 on real drift), because either assertion alone is passable by a broken implementation.
13. **v1 emits no event and amends no topic** (ADR-203 closed set untouched), ships no automatic cadence (ADR-260 manual default), and has no `whip` or Discord path (the `whip` verb was removed by ADR-266 §D2).
14. **Migration rung is `from: 18, to: 19`**, leaving `from: 17, to: 18` to ADR-267. Highest landed rung on 2026-08-06 is `from: 16, to: 17`. Re-derive with `rg -n 'from: 1[6-9]' src/abstractions/sqlite-migrations.ts` at implementation time; the ladder is append-only and monotonic.
