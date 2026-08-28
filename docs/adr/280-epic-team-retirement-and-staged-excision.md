# ADR-280: Epic-teams are retired — the concept, the `epic-team` cage type, and `epicId` on cockpit sessions

**Status**: accepted — operator-direct 2026-08-27
**Date**: 2026-08-27
**Driver-ref**: George 2026-08-27, verbatim: *"get rid of the concept of epic team entirely and epicId because that's no longer used in atmux... it's been months since we used that... like since april...."*
**Supersedes**: the `epicId` clause of [ADR-089 §Amendment 2026-08-27](089-hierarchical-cockpit.md#amendment-2026-08-27--nesting-is-general-not-epic-shaped-group-tier-shifts-the-prefix-chain-down-one-rung-t-f73a418c) (landed the same day, `dcf04cfa`) — see §D3. Supersedes in effect the 21 epic-specific ADRs listed in §D2; those files remain on disk as history.
**Relates**: [ADR-275](275-external-private-kanban-authority.md) (external kanban is the sole work-state authority — owns the `Epic` **work item**), [ADR-276](276-orchd-retirement-and-atmux-scope.md) (orchd is retired — owns most of the `epicId` surface), [ADR-266](266-shim-sunset-policy-and-first-sweep.md) (the staged-removal + sunset-marker pattern this ADR follows), [ADR-221](221-solo-worker-scope.md) (worker-teams — built **on top of** the epic machinery; see §Risk 1), [ADR-089](089-hierarchical-cockpit.md) (the recursive `sessions[]` model that survives this)

## Context

### The directive

Epic-teams were ephemeral child cages spawned per kanban Epic: their own worktree at `<parentRoot>-epics/<epicId>/`, their own branch `<parentBase>-epic-<epicId>`, their own roster, dissolved on merge. The operator has stopped using them and has asked for the concept — not merely the dead config — to be removed.

### Dormancy evidence, with the dates corrected

The directive recalls "since april". The record says **May–June 2026**, and this ADR states the accurate dates rather than repeating the recollection:

| Evidence | Finding |
|---|---|
| Last substantive epic commit | `e68e40c0`, **2026-06-05** — *fix(spawn-epic): wire parent-cage viewer window*. Everything before it is May 2026. |
| `~/.atmux/e-21-6593dd0f`, `e-22-4d6af038`, `e-23-0f71512b` | Each held **only** a `team.json`, last written **2026-06-12**. No worktrees, no state. |
| `/tmp/atmux-<epicId>` directories | Two existed and both were **empty — no socket file inside**, i.e. shells a cockpit rebuild recreated, not live cages. |
| `~/work/src/atmux-epics/` | **Does not exist**, though three `_repo-registry.sh` entries pointed into it. |
| Worker-teams ([ADR-221](221-solo-worker-scope.md), the epic machinery's only other consumer) | Last touched `657a03c2`, **2026-05-23**. No live `w-*` cage on this box. |

So: **~3 months dormant, with the newest artefact dated 2026-06-12.** Not April, and the difference matters only because an ADR that repeats an unverified date invites the next reader to trust the rest of it the same way.

### What this ADR is, and is not

**This ADR removes no code.** It records the retirement decision, fixes the ADR record, and defines the staged excision that later commits execute and cite. Stage 1 is already done (§D4) and is recorded here as completed, not proposed.

## Decision

### D1 — The epic-team concept is retired

`epic-team` is no longer a supported cage type, `epicId` is no longer a field on any cockpit session, and the five epic verbs are no longer part of atmux's surface. The general nesting model that ADR-089 defines **survives untouched**: a `team` may contain child cages of any depth for any reason, which is precisely what ADR-089 §Amendment 2026-08-27 §(A) already established. What is retired is the epic-shaped *instance*, not the mechanism.

### D2 — The ADR record is append-only; supersession is a marker, never a deletion

The 21 epic-specific ADRs recorded decisions that were true when made. **None of them is deleted.** They are superseded by this one:

| Live today | | | |
|---|---|---|---|
| [090](090-epic-team-lifecycle.md) epic-team lifecycle | [144](144-epic-team-test-gate.md) epic-team test gate | [170](170-sweep-epics-verb.md) `sweep-epics` verb | [173](173-epic-show-enumerate-children.md) `epic show` children |
| [174](174-task-list-epic-story-filters.md) epic/story filters | [176](176-epic-aware-lane-drift-revert.md) epic-aware lane drift | [182](182-auto-reap-epic-team-on-epic-merge.md) auto-reap on merge | [184](184-host-wide-epic-team-cap-queue-and-dormancy-audit.md) host-wide cap |
| [193](193-restore-task-add-epic-story-deliverable-flags.md) task-add epic flags | [195](195-epic-done-transfer-follow-up-tasks.md) epic-done transfer | [196](196-worktree-isolation-true-default-for-spawn-epic.md) worktree isolation | [199](199-claude-account-pool-for-epic-team-spawning.md) account pool |
| [209](209-never-started-epic-team-detection.md) never-started detection | [219](219-dissolve-epic-completeness.md) dissolve completeness | [225](225-epic-dependencies-and-is-ready-toggle.md) epic deps + is_ready | [250](250-orchd-stale-epic-reaper.md) stale-epic reaper |
| [251](251-epic-cage-socket-resolution.md) epic cage socket | [252](252-epic-cage-children-removal-guard.md) children removal guard | | |

**Already superseded, by ADR-211, and untouched by this ADR:** `183-sentinel-scope-includes-epic-teams.SUPERSEDED.md`, `185-sentinel-epic-team-scope-extension.SUPERSEDED.md`, `206-sentinel-dynamic-epic-discovery.SUPERSEDED.md`. They stay pointed at ADR-211; a second supersession banner would misrepresent which decision replaced which.

**Marker convention — follow the existing precedent, with one correction.** ADRs 083/086/132/143/158/183/185/204/206/207/236 were all marked the same four ways, and Stage 5 does the same for the 18 live ADRs above:

1. Rename the file `NNN-slug.md` → `NNN-slug.SUPERSEDED.md`.
2. Insert a blockquote banner as the first line after the `#` heading: `> **⚠ SUPERSEDED by [ADR-280](280-epic-team-retirement-and-staged-excision.md) — 2026-08-27. Read ADR-280 instead; this file is kept for trace only.**`
3. Rewrite the `Status:` line to `Superseded by ADR-280 (2026-08-27). Was: <original status>.`
4. Move the row from `INDEX.md` §Live ADRs to §Superseded (skip).

**The correction: the rename breaks inbound links, and every prior sweep left them broken.** Measured 2026-08-27 across `docs/adr/*.md`: **7 dead intra-tree links survive from earlier renames** — 4 pointing at `132-pluggable-martinet.md`, 2 at `158-martinet-to-sentinel-rename.md`, 1 at `183-sentinel-scope-includes-epic-teams.md`, none of which exist under those names. This sweep is 18 files carrying **68 inbound link edges** (ADR-090 alone is linked from 25 files), so repeating the omission would multiply the existing damage tenfold. **Stage 5 rewrites every inbound link in the same commit as the rename, and verifies with a link check that resolves every `](NNN-*.md)` target against the tree.** If that verification cannot be made to pass in one commit, do steps 2–4 and *skip the rename* — a correct banner on a stably-named file beats a renamed file nobody can reach.

### D3 — This supersedes ADR-089 §Amendment 2026-08-27's `epicId` clause

That amendment landed earlier the same day (`dcf04cfa`) and says, in its second retraction bullet:

> *"`epicId` is required only on `type: "epic-team"`, and it stays required **there** — an epic-team without a link back to `kanban.epics[].id` is a lifecycle bug, and ADR-090/091/182/219 all join on that field. […] It is not deprecated and not removed."*

**That was true when written and is now retracted.** `epicId` is removed along with the `epic-team` type that carries it. The amendment's §Out of scope paragraph — declining to rename the `epic-team` discriminator because the literal is load-bearing across ADR-090/091/144/182/219 — is likewise overtaken: this ADR does not *rename* the discriminator, it removes it, and the ADRs it was load-bearing for are the ones §D2 supersedes.

**What survives from that amendment, unchanged:** §(A)'s general nesting model, §(B)'s prefix-chain shift, §(C)'s refuse-past-the-chain rule, and §(D)'s correction that `loadCockpit` performs no depth walk. None of those depend on epics. §Implementation-ledger rows 6 and 7 — the parent-cage viewer window and the spawn verb, both marked *"Ships for epics only"* — become **"does not ship"** rather than **"ships for epics only"** once Stage 3 lands; a generic child-cage spawn verb remains unbuilt and out of scope here.

### D4 — Staged excision order

**Invariant, at every stage boundary: `bun run typecheck`, `bun run lint`, and `bun test` all pass, and `bun run build` produces a binary.** A stage that cannot satisfy that is not finished, and the next stage does not start. Each removal commit names this ADR.

---

#### Stage 1 — config + dead runtime state · **DONE**

Landed in the dotfiles as `9c25e90` (*chore(atmux): adopt atx, retire dead epic-team config and state (stage 1)*), merged as `0f59a11`.

- `cockpitSession` `atmux_cockpit` → `atx` in **both** `cockpit.json` and `cockpit.macos.json`. This was already ADR-264's canonical value; the config had been taking the deprecated-literal coercion path on every load, which ADR-279 §D1 then made *stop* coercing — so the config had to be corrected before that change could be safe.
- 5 `epic-team` entries removed from **both** configs: `4-e8a9523d`, `5-dab960f8`, `6-262ea494` (under `unum`); `8-541746ea`, `9-0a10c37f` (under `mx`). **Both files had to lose them before the schema type goes**, because `EpicTeamSession` is a `.strict()` leaf of a discriminated union (ADR-089 §Decision-anchor #2/#3) — an unknown `type` fails `safeParse`, and hax's config would stop parsing entirely, not degrade.
- Removed: `~/.atmux/e-21-6593dd0f`, `e-22-4d6af038`, `e-23-0f71512b`; the two empty `/tmp/atmux-<epicId>` dirs; the 3 `_repo-registry.sh` entries pointing at the non-existent `~/work/src/atmux-epics/`.

**Verified through atmux's own `loadCockpit`**: `cockpitSession=atx`, 18 enabled teams, 0 epic-teams. Re-verified 2026-08-27: `grep -c 'epic-team'` returns 0 on both config files.

**Precondition for Stage 2:** the same check must pass against **hax's** `~/.atmux/cockpit*.json`, not only this box's. Stage 1 was executed on the MBP; hax has not been confirmed.

---

#### Stage 2 — CLI verbs, `EpicTeamSession`, `epicId`

**Before it starts:** Stage 1 verified on every host that runs atmux; the external consumers of §D6 already re-pointed or accepted as broken; §Risk 1 (worker-teams) decided.

**What moves.** The five verbs at `src/cli.ts:233` (`epic`), `:322` (`epic-merge`), `:410` (`team spawn-epic`), `:412` (`team dissolve-epic`), `:414` (`team sweep-epics`), plus their rows in `src/verbs/help.ts` (lines 88–93 and 135–155) and in `completions/_atmux` (the `epic` verb block and the `epic_states` array). Then `EpicTeamSession` and its `epicId` / `parent` fields from `src/schema/cockpit.ts:143-157,204-215`, and `team.json::epicTeam` — the `TeamEpic` block at `src/schema/team.ts:988-1101`, its `epicTeam: TeamEpic.optional()` field at `:1647`, and the two `superRefine` clauses at `:1689+` that enforce ADR-090 §Decision-anchor #3.

**Asymmetry worth knowing: `team.json` is safer than `cockpit.json` was.** The top-level `Team` schema ends in `.passthrough()` (`src/schema/team.ts:1688`), so a residual `epicTeam` block in a live `team.json` degrades to an ignored key rather than a parse failure — the opposite of the `.strict()` cockpit leaf. Verified 2026-08-27: no `team.json` on this box carries `epicTeam`. **Re-check on hax at stage time anyway** — the passthrough makes it survivable, not correct.

**Verified by:** the stage invariant, plus `atmux cockpit status` and `atmux fleet` against the real 18-team config, plus `atmux help` and a shell-completion smoke test.

---

#### Stage 3 — the 13 epic source files and their call sites

**Before it starts:** Stage 2 landed; §Risk 2 (orchd) sequenced; the shared-surface list below re-derived at stage time rather than trusted from this ADR.

**What moves — the 13 files** (7,124 lines): `src/core/epic.ts` (745), `epic-merge.ts` (986), `epic-cage-children.ts` (167), `epic-test-cage.ts` (318), `epic-test-deploy.ts` (454), `dissolve-epic.ts` (592); `src/core/orchd-dispatch/dissolve-epic.ts` (236), `epic-merge.ts` (492); `src/verbs/epic.ts` (768), `epic-merge.ts` (892); `src/verbs/team/spawn-epic.ts` (960), `dissolve-epic.ts` (98), `sweep-epics.ts` (416). Plus `templates/epic-rosters/{default,solo,solo+committer,backend-heavy}.json` and `templates/briefs/epic-lead.md`, which no other verb reads.

**And the call sites in files that are NOT epic-named and MUST survive** — every one needs an edit, not a delete:

| File | What it does with epics |
|---|---|
| `src/core/cockpit.ts:145,322,338,361-363,393,408-439,474-475` | `walkSessions` / `enabledTeams` / adjacency all branch on `type === "epic-team"`; `addEpicViewerToParentCage` (`:741`) / `removeEpicViewerFromParentCage` (`:808`) hardcode the `🌳-<epicId>` window name (`:783`, `:843`) |
| `src/core/groom.ts:43,973-1052` | ADR-252 live-epic-children guard — imports `hasLiveEpicChildren`, and the guard's *purpose* (do not `rm -rf` a parent whose child cage is alive) generalises past epics |
| `src/core/cage-resolver.ts:109` | ADR-251 socket resolution walks for `epic-team` nodes |
| `src/core/issue-sync.ts:338` | ADR-261 walk admits `team` and `epic-team` |
| `src/core/topo-aggregate.ts:409`, `src/verbs/topo-io.ts:509` | topology aggregation branches on the type and joins on `epicId` |
| `src/core/vox/team-context.ts:34` | the voice interface's team-context type union |
| `src/verbs/team-rename.ts:214`, `team-rename-cockpit.ts:66,163` | rename walks admit both types |
| `src/verbs/tell-lead.ts:151`, `src/verbs/fleet.ts:544`, `src/verbs/cockpit.ts:1735-1746` | error hints, fleet rendering, reconcile filter |
| `src/schema/events.ts` | `epic.unblocked` / `epic.ready` / `epic.merged` / `epic.merge-blocked` / `epic.pushed` payloads and the optional `epicId` on three shared payloads |
| `src/verbs/rotate.ts:141` | references the `epic-lead.md` brief |

**Verified by:** the stage invariant, plus a full cockpit reconcile dry-run against the live 18-team config, plus `atmux vox` and `atmux topo` smoke tests (both consume the walkers being edited).

---

#### Stage 4 — tests

**Before it starts:** Stage 3 landed with the suite green — which necessarily means the epic tests were already deleted alongside their subjects, per ADR-266 §D3's precedent ("tests covering the above are deleted with them"). Stage 4 is therefore a **sweep for what Stage 3 missed**, not a bulk deletion, and it must not be the stage that first makes the suite green.

**What moves:** the residue of the 171 test files that mention epics — helper fixtures in `tests/helpers/`, e2e specs in `tests/e2e/`, and `tests/unit/core/orchd-dispatch/`. Fixtures shared with non-epic tests are edited, not deleted.

**Verified by:** `bun test --coverage`; coverage on tracked paths must not fall — a drop means live code lost its only test, which is a Stage 3 defect surfacing late.

---

#### Stage 5 — docs, runbooks, ADR markers, and the `ghostbuster` skill

**What moves:** `docs/RUNBOOK-epic-teams.md` (261 lines — deleted outright) and the epic sections of `docs/RUNBOOK-team-of-teams.md` (144 lines), `RUNBOOK-topology.md`, `RUNBOOK-cockpit.md`, `RUNBOOK-grooming.md`, `RUNBOOK-stall-recovery.md`, `ARCHITECTURE.md`, `PRD.md`, `GETTING_STARTED.md`, `docs/AGENTS.md`, `CHANGELOG.md`. Then the §D2 supersession markers on 18 ADRs plus the `INDEX.md` moves and the inbound-link rewrite. Then, **outside this repository**, the `ghostbuster` skill (§D6).

**Explicitly NOT touched:** `docs/release-notes/**`, `docs/reviews/**`, `docs/audits/**`, `docs/audit/**`. Those are dated records of what happened, and editing them is falsification, not cleanup.

**Verified by:** `grep -ri 'epic-team\|epicId\|spawn-epic' docs/ --include='*.md'` returning hits only in the four historical trees above and in this ADR's supersession list; plus the link check named in §D2.

### D5 — Sequencing against ADR-275 and ADR-276, which own most of this surface

This is not a standalone excision. **Three retirements overlap, and running them in the wrong order does the same work twice or breaks a stage boundary:**

- **[ADR-275](275-external-private-kanban-authority.md) (accepted) owns the Epic *work item*.** `src/core/epic.ts`, `src/verbs/epic.ts` (the `atmux epic add|list|show|advance|ready|unready|set-depends-on|deps` verb), `KanbanEpic` in `src/schema/kanban.ts:145-245`, and the `epics[]` table are **internal-kanban** surfaces, not epic-*team* surfaces. ADR-275 §D4 stage 6 already governs their removal, gated behind an observation receipt. **This ADR does not authorise removing them ahead of that gate.** The `atmux epic` verb appears in §D4 Stage 2 because the operator named it and because it is unusable once nothing spawns a cage from an epic — but its removal is executed under ADR-275's gate, citing both ADRs.
- **[ADR-276](276-orchd-retirement-and-atmux-scope.md) (proposed) owns most of the `epicId` count.** Of the 463 `epicId` occurrences in `src/`, the orchd modules hold roughly half: `orchd-merge` 31, `orchd-spawn` 24, `orchd-dissolve` 22, `orchd-merge-sweep` 20, `orchd-push` 17, `orchd-reap` 15, `orchd-reap-enum` 9, `orchd-dispatch/epic-merge` 34, `orchd-dispatch/dissolve-epic` 14, `verbs/orchd` 9. **If ADR-276 is accepted and executed first, Stage 3 shrinks to the non-orchd remainder and two of its 13 files disappear with the daemon.** Running Stage 3 first is not wrong, only wasteful. **Recommended order: settle ADR-276 first.**
- **Independently true regardless of both:** the cockpit `epic-team` type, `epicId` on cockpit sessions, `team.json::epicTeam`, the three `team/*-epic*` verbs, and the walkers that branch on the type. That is this ADR's irreducible core.

### D6 — External consumers are re-pointed before the verbs they call are removed

`ghostbuster` lives at `_dotfiles/agents/skills/ghostbuster/` — **outside this repository, in the private dotfiles.** Its entire replenish loop is epic-team machinery: `scripts/ghostbuster.sh:291` shells `atmux team dissolve-epic <eid> --skip-checks`, `:336` shells `atmux team spawn-epic <eid> --from <parent>`, `:329` reads `atmux epic list --status ready --json`, and `:50` enumerates `git branch -l "${TRUNK}-epic-*"`.

**Removing the verbs breaks it silently** — a shelled-out verb that no longer exists surfaces as a non-zero exit inside a loop the script already tolerates, not as a visible failure. So:

1. `ghostbuster` is retired or rewritten **in the dotfiles, in its own commit, before Stage 2 lands**. Retirement is the likely answer: a skill whose only job is recycling epic-teams has nothing left to do.
2. The commit that removes the verbs states in its body that the external consumer was handled first, and names the dotfiles commit.

Also found and lower-stakes: `_dotfiles/agents/skills/bau/SKILL.md:70` counts epic-team merges — but `/bau` is already deprecated (2026-08-17), so it needs a line edit at most. `_dotfiles/atmux/mx-root/team.json:93` and `team.macos.json:84` carry `_comment_autoSpawn` prose referencing `atmux epic add` — comments only, no schema effect, but they should go in the same dotfiles pass.

## Blast radius — measured 2026-08-27 on `atmux-geoyws` at `dcf04cfa`

| Surface | Count |
|---|---|
| `src/` files mentioning epic | 123 |
| `epicId` occurrences in `src/` | 463 (≈half in orchd — §D5) |
| `"epic-team"` literals in `src/` | 39 occurrences in 17 files (65 files mention `epic-team` in some form) |
| Test files mentioning epic | 171 of 390 |
| ADRs mentioning epic-team | 86 |
| ADRs titled `epic-*` or epic-specific | 21 (18 live + 3 already superseded) |
| CLI verbs | 5 |
| Epic-named source files | 13 (7,124 lines) |
| Templates | 4 epic rosters + 1 `epic-lead` brief |
| Runbooks | 2 dedicated + ~8 with epic sections |
| Outside this repo | `ghostbuster` skill (+ deprecated `bau`, 2 team.json comments) |

## Risks — the places where this is a refactor, not a deletion

**Ordered by how badly getting it wrong hurts.** Each is stated as *what to check at stage time*, because measuring once in an ADR and trusting it three commits later is exactly how a "clean deletion" turns into a broken build.

### Risk 1 — worker-teams are built ON the epic machinery, and the coupling is total

**This is the finding that decides whether Stages 2/3 are deletions or a refactor.** ADR-221's worker-team family — `atmux team spawn-worker`, `dissolve-worker`, `list-workers`, all three live in `src/cli.ts:416-420` — is not epic-named and *is* epic-implemented:

- `src/verbs/team/spawn-worker.ts:45,47` imports `addEpic` from `core/epic.ts` and `spawnEpic` from `spawn-epic.ts`; its own header calls it *"a thin wrapper around `spawn-epic`"*. It **creates a wrapper kanban EPIC row** so teardown has something to mark done, then delegates.
- `src/verbs/team/dissolve-worker.ts:25` imports `dissolveEpic` from `dissolve-epic.ts`.
- `src/verbs/team/list-workers.ts:94-103` filters `enabledTeams(cockpit)` for `type === "epic-team"` and reads `entry.epicId`, because **a worker cage IS an `epic-team` node** whose `epicId` is `w-<tail>`.

So Stage 2 cannot remove `EpicTeamSession` while the worker verbs stand. Three options, and **the ADR does not pick one — the operator does**:

1. **Retire worker-teams too.** Defensible on the same evidence: last touched `657a03c2` (**2026-05-23**, two weeks *before* the last epic commit), and no live `w-*` cage exists on this box. This is dormant code depending on dormant code, not a live feature blocked by a cleanup. **Recommended, pending operator confirmation.**
2. **Re-base worker-teams on a generic child-cage spawn.** Correct but it is *new construction* — ADR-089 §Amendment §Implementation-ledger row 7 records that no generic spawn verb exists. That is a separate ADR and a separate build.
3. **Keep the epic machinery alive for workers alone.** Rejected on its face: it retains the concept the directive removes, under a different name.

**Check at stage time:** whether any `w-*` cage exists on **hax** as well as this box, before treating option 1 as free.

### Risk 2 — `src/core/orchd-dispatch/` has a non-epic member; the directory survives

`git-push.ts` (204 lines, ADR-229) sits beside `dissolve-epic.ts` and `epic-merge.ts` and mentions epics only 4 times. **The directory is not deleted; two of its three files are.** Both `src/verbs/orchd.ts:35-37` and `src/verbs/committer.ts:85-87` import all three dispatchers together, so both files need a partial edit rather than a dropped import block — and `committer` is a live verb that ADR-276 does *not* retire. **Check at stage time** whether `git-push.ts` shares helpers with the two epic dispatchers, and whether `committer`'s auto-push path reaches them; the ADR asserts only that the directory has a non-epic consumer, not that the three files are independent.

### Risk 3 — ADR-252's live-children guard is epic-shaped but not epic-purposed

`src/core/groom.ts:1019-1052` refuses to `rm -rf` a parent tmpdir whose `<dir>/epics/*` hosts a live child cage. The *implementation* is epic-specific (it globs `epics/`); the *invariant* — never destroy a parent out from under a live child — generalises to any nested cage, which ADR-089 §Amendment §(A) says is now the normal case. **Do not delete this guard with the epic code.** Stage 3 must either keep it with a generalised path glob or record explicitly that groom no longer guards nested children. Deleting it silently reintroduces the exact failure ADR-252 was written for.

### Risk 4 — the walkers are shared infrastructure, and the union has four members

`walkSessions` and `enabledTeams` (`src/core/cockpit.ts:350-393`) recurse into `team` and `epic-team` only; the discriminated union is `team | epic-team | superdriver | medic`. Narrowing it to three members touches every consumer in the Stage 3 table — including `vox`, `issue-sync`, `topo` and `cage-resolver`, none of which are epic features. The mechanical risk is low (drop one branch of a type check) but the *count* is what bites: 17 files carry the quoted literal and 65 mention it in some form. **Check at stage time** that no consumer relies on `epic-team` being present to reach a `parent` field — `src/core/cockpit.ts:439` sets `out.parent` only on the epic branch, and something downstream may read it.

### Risk 5 — `epicId` is two different things wearing one name

`epicId` on a **cockpit session** is a cage-identity field, and it goes. `epicId` on an **event payload** (`src/schema/events.ts:45,60,80`) is an optional correlation key on three payloads shared with non-epic topics, and `epicId` on a **kanban row** is the work-item hierarchy that ADR-275 owns. **The 463-occurrence figure conflates all three, and no stage should be planned from it.** Split the count per meaning at stage time before deciding what a given occurrence costs.

### Risk 6 — unclassified

Not every mention was traced to a meaning. `src/core/epic-test-cage.ts` and `epic-test-deploy.ts` (ADR-144) are imported only by `src/verbs/epic-merge.ts` and each other, which *reads* as epic-only — but a test-cage-and-deploy gate is the kind of thing worth salvaging rather than deleting, and that judgement was not made here. `src/core/orchd-spawn.ts` / `orchd-sweep.ts` / `orchd-reap.ts` mention epics 104 / 63 / 54 times and are presumed epic-driven end to end, unverified. **Both are flagged for stage-time investigation, and the ADR does not claim they are clean deletions.**

## Consequences

- The concept goes away in one direction only: nothing here builds a replacement. If a future need for per-work-item cages appears, it is served by ADR-089's general nesting plus a generic spawn verb — a new ADR, not a revival of this one.
- ~7,100 lines of source, 4 templates, 2 runbooks and a skill leave the tree, and the concept surface shrinks: no more "is this cage a team or an epic-team?" at every walker.
- **Breaking, deliberately.** Any config still carrying `type: "epic-team"` fails to parse after Stage 2, with an error naming this ADR. That is the ADR-266 §D2 precedent — an expired contract fails loud rather than aliasing silently.
- The 18 superseded ADRs stay readable, and the supersession chain stays walkable — provided Stage 5 does the link rewrite the previous sweeps skipped.
- **Out of scope:** ADR-275's internal-kanban removal, ADR-276's orchd retirement, the worker-team decision (§Risk 1), a generic child-cage spawn verb, and `MAX_NESTING_LEVEL` (ADR-089 §Amendment §(C) already owns that).

## Rollback

Per stage, `git revert` the stage's commit — the stages are ordered so each is independently revertible against the one below it. **Stage 1 is the exception**: it is already merged in the dotfiles, and reverting it would restore `cockpitSession: "atmux_cockpit"`, which ADR-279 §D1 now treats as literal operator intent — a reconcile would then rename the live session. If Stage 1 must be undone, restore the epic-team config entries **without** the `cockpitSession` change.

Post-Stage-5 rollback of the whole retirement is a re-implementation, not a revert. That is the intended cost.

## References

- Operator directive, 2026-08-27 (quoted in full in the header).
- Dormancy receipts, 2026-08-27: `e68e40c0` (2026-06-05); `~/.atmux/e-2{1,2,3}-*` `team.json` mtimes 2026-06-12; two empty socket-less `/tmp/atmux-<epicId>` dirs; `~/work/src/atmux-epics/` absent; `657a03c2` (2026-05-23) for the worker family.
- Stage 1 receipt: dotfiles `9c25e90`, merged `0f59a11`. Re-verified 2026-08-27 — `grep -c 'epic-team'` = 0 on both `cockpit.json` and `cockpit.macos.json`.
- Link-rot receipt, 2026-08-27: 7 dead intra-tree links from earlier `.SUPERSEDED.md` renames (4 → 132, 2 → 158, 1 → 183); 68 inbound edges across the 18 ADRs this sweep renames, 25 of them to ADR-090 alone.
- [ADR-266](266-shim-sunset-policy-and-first-sweep.md) §D1 — every removal in Stages 2–5 carries a `SUNSET`-style marker or lands outright; nothing here ships a new shim with an unbounded window.
