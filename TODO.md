# TODO

Handoff surface for atmux. A fresh agent should be able to read this file top-to-bottom and resume
without the operator re-explaining anything. Newest handoff first.

Conventions: absolute dates only. Every item names the file/ADR it lives in. `P0` = blocks a
capability the operator explicitly asked for; `P1` = real defect, not blocking; `P2` = hygiene.

---

## Handoff 2026-08-09 — status check, nothing moved

Re-verified the 2026-08-07 handoff below against the repo on 2026-08-09. **Every claim in it still
holds; no work has happened in between.** Measured, not assumed:

- `git log db910ce..HEAD` → **empty**. No commits in two days.
- `git status --porcelain` → **empty**. Working tree clean.
- ~~`AHEAD=6, BEHIND=0` — the push still has not happened.~~ **RESOLVED 2026-08-09**: the operator
  pushed `223e5e9..05c19bd`. Now `AHEAD=0, BEHIND=0`, origin tip `05c19bd` == local. All seven
  commits (ADRs, BRD, PRD corrections, issue-sync landing, both handoffs) are on origin.
- The P0 bug is still live: `rg -c 'state\.db|openDatabase|bun:sqlite' src/verbs/handoff.ts` → **0**;
  `kanbanJsonPath` still imported at `:33` and written at `:243`.
- Budget epic `e-50-666140ed`: all six stories still `planning`. Story `s-52` title now correctly
  reads "ADR-270: design record".
- ADR tail is 269 + 271. **270 is still reserved and unwritten** — that is intentional (it belongs
  to `s-52`), not an oversight.

**Origin is now current — start from a clean fetch.** The push landed 2026-08-09, so `origin` has
everything and the tree is in sync. Nothing is stranded on this box any more.

**Suggested order for the next session:** (1) fix the P0 handoff bug — small, self-contained, and
it is the capability the operator actually asked for; (2) get reviewer signoff on ADR-271, since
its dual-path retirement subsumes the three sibling JSON-only bugs; (3) the 23 test failures;
(4) hygiene. Two other repos still have unpushed/unhomed commits — see "pushes not completed"
below; those are unchanged.

### Closed since 2026-08-07

- **Private AGENTS.md memory storage — resolved, and NOT in atmux.** The operator redirected this
  to the dotfiles on 2026-08-07 ("i'll get dotfiles to be the place to store AGENTS.md and not
  atmux") and it has since shipped there as the `/dotfiles-agents` (alias `/dotfa`) skill at
  `~/work/journals/.sb/_dotfiles/agents/skills/dotfiles-agents/SKILL.md`. Nothing for atmux to
  build. Do not resurrect it here.

---

## Handoff 2026-08-07 — agent-continuity docs batch (George's main-loop session)

Operator asks that produced this batch:

> "i need atmux to track plans and todos so that they're never lost even if agents run out of
> tokens and then another agent can easily take the previous agent's place ... keep all plans and
> intents in atmux so that the git repo can be clean of our artifacts and my team members won't
> need to see my todo artifacts ... note the branches that we're working with across monorepos
> recursively"

> "we dont' want to use kanban.json anymore... we just wnat to use sqlite and have a rust binary
> help do the coordination"

Landed as 5 commits on `atmux-geoyws`: `58f7161` (ADR-267/268/269/271 + BRD), `0108ce7` (ADR
append-only restore), `77292e1` (issue-sync Phase 1), `6505b24` (briefs → state.db), `e8e9943`
(in-flight sync).

### P0 — `atmux handoff` migrates ZERO tasks on every team. Fix this first.

**This directly breaks the capability the operator asked for.** `atmux handoff <from> <to>` is
supposed to move in-progress work to a replacement agent. It doesn't.

- `src/verbs/handoff.ts` contains **zero** references to `state.db` / `openDatabase` / `bun:sqlite`.
- `migrateTasks` (declared `:237`, writing at `:243`) only calls
  `updateJson(kanbanJsonPath(atmuxDir), KanbanSchema, …)`.
- ADR-126 made `.atmux/state.db` the canonical store. Measured on the atmux team 2026-08-07:
  **1138 tasks in `state.db`, 3 of them `in-progress`/`blocked`** — exactly what handoff should
  reassign — and **`.atmux/kanban.json` does not exist.**
- Net effect: handoff writes owner reassignments into a file nothing reads, then reports success.
  The kanban rows never change owner. A replacement agent claims nothing.

Fix: give `migrateTasks` a SQL path (mirror how `src/core/kanban.ts` routes on
`_useSqlite`, `:88-94`). Regression test must assert the OWNER COLUMN MOVED IN `state.db` — a test
that only checks handoff's exit code or its stdout would pass against the current broken build.

Related, same root cause (JSON-only readers that silently return empty on SQL teams — all verified
by zero `state.db`/`openDatabase` matches in the file):

- `src/verbs/discorder.ts:139-152` and `:286-299`
- `src/verbs/report.ts:266`
- `src/verbs/doctor/driver.ts:196-198`

All four are covered by ADR-271's dual-path retirement (below), but the handoff one is P0 on its
own because continuity depends on it.

### P0 — ADR-271: retire kanban.json, Rust orchd coordinates (operator decision 2026-08-07)

> ⚠ **2026-08-27 — half of this item is DEAD.** [ADR-276](docs/adr/276-orchd-retirement-and-atmux-scope.md) retired orchd entirely (the `rust/atmux-orchd/` crate named below no longer exists), so ADR-271's "Rust orchd coordinates" half is moot. The kanban.json-retirement half is [ADR-275](docs/adr/275-external-private-kanban-authority.md) territory (external kanban authority, accepted + shipping).

[ADR-271](docs/adr/271-sqlite-sole-store-rust-orchd-coordinator.md) — `Status: proposed`, needs
reviewer signoff before code lands.

Two limbs:

1. **Retire the JSON compatibility path.** ADR-126 already made SQLite canonical; this removes the
   fallback. Enumerated in the ADR: **18 dual-path call sites, all in `src/core/kanban.ts`**
   (`:155, 211, 323, 355, 406, 685, 716, 738, 759, 782, 804, 825, 845, 872, 913, 928, 977, 1162`)
   across 18 exported functions, plus **6 JSON write sinks** (`:177, 271, 936, 1021, 1183, 1371`).
   `src/core/epic.ts` and `src/core/story.ts` are already SQL-only. Fleet has 12 `.atmux/kanban.json`
   files on hax, ten of them empty seeds — re-verify before deleting anything.
2. **Rust binary does the coordination.** `rust/atmux-orchd/` already exists (plus
   `atmux-listener`, `atmux-cockpit-mirror`; see `package.json` `build:orchd` etc.).
   **This reverses [ADR-260](docs/adr/260-manual-orchestration-mode-default.md)**, which on
   2026-06-12 made `orchestration.mode` default to `"manual"` with orchd opt-in. ADR-271 supersedes
   that default and keeps manual mode as an escape hatch — do not delete the capability.

Unlocks ADR-267 §D4's checkpoint cadence, which was deferred purely because no long-lived process
existed to host it.

### P1 — three proposed ADRs awaiting reviewer signoff, then implementation

None are accepted; none are implemented. Any verb named in them will error `unknown verb` today.

- [ADR-267](docs/adr/267-durable-agent-continuity-contract.md) — durable agent continuity.
  Append-only task-note seam (`atmux task note`; today `task update --body` REPLACES and `--note`
  exists only on `done` / `member status` / `ombudsman work`), claim→plan obligation enforced as a
  DETECTABLE PROXY not a hard block, resume contract, pre-death checkpointing.
- [ADR-268](docs/adr/268-managed-repo-state-isolation-enforcement.md) — makes ADR-239/244's
  isolation design enforced instead of remembered: `atmux init` establishes it, a doctor probe
  asserts it, a sweep fixes already-managed repos. **The probe must test a CHILD path** —
  `git check-ignore -q -- .atmux` exits 1 under a `.atmux/*` pattern; use `.atmux/team.json`.
- [ADR-269](docs/adr/269-recursive-branch-ledger.md) — recursive branch ledger. Worked examples
  were recomputed against the live `crm-react` and `ix-root` trees; all six pinned exit codes
  (23 / 13 / 0 / 1 / 2 / 0) reproduce. Do not "simplify" the per-repo intent key back to one row
  per lane — that was the original design blocker; `rentx-root` alone disproves it (root on
  `rx-geoyws`, submodules on `rentx-geoyws`, `.gitmodules` declaring two branch families).

### P1 — 23 e2e/integration test failures landed with `e8e9943`

`bun test`: 8822 pass / **23 fail** / 13 skip / 4 todo. Typecheck and lint are both exit 0
(246 warnings / 31 infos, all pre-existing).

All 23 live in test files **byte-identical to HEAD** — nobody edited them — so they fail because
the source they exercise moved underneath them during the ADR-262→266 in-flight work. Suites:
`epic-auto-merge`, spawn-epic legacy-cockpit migration, cross-team `tell-lead`, ADR-144 test-gate,
`ombudsman`, `cage-state-transitions`, `orchd-phase2-trigger-matrix`, `skills-plugin-schema`.

One is provably independent of the whole batch and is the cheapest start:
`tests/integration/skills-plugin-schema.test.ts:161` asserts 12 plugin skills, while
`plugins/atmux/.claude-plugin/plugin.json` (clean at HEAD) declares **13** — the `/atmux:driver`
skill added in `772faca` bumped the count without updating the test.

**Do not fix these by loosening assertions.** Reproduce with:
`unset TMUX && timeout 900 bun test --timeout 30000` (the zsh bun-test guard aborts inside an
atmux cage per ADR-081/085; the GNU `timeout` wrapper is mandatory — bun's own `--timeout` is
per-test and cannot preempt a runaway loop).

### P1 — needs an operator decision

**Do git remotes + branch purpose annotations live in atmux or in the dotfiles?** STILL OPEN as of
2026-08-09. On 2026-08-07 George asked for atmux to store "git remotes and git branches and details
about what they do and their purpose", then immediately redirected the *AGENTS.md-memory* half to
the dotfiles. The remotes/branches half was never explicitly reassigned.

Checked 2026-08-09: the shipped `/dotfiles-agents` skill covers AGENTS.md guidance only — it says
nothing about remotes, branches, or their purpose — so it did NOT absorb this half by default.

Working assumption: it stays in atmux as a small extension to
[ADR-269](docs/adr/269-recursive-branch-ledger.md)'s ledger, which already records per-repo branch,
HEAD sha, dirty flag and ahead/behind. Adding a remote URL plus a purpose string is additive and
needs no new subsystem. **Confirm with the operator before building** — if it goes to the dotfiles
instead, ADR-269 needs an amendment saying so, since its ledger is the obvious home.

Explicitly dropped: private per-project AGENTS.md memory storage in atmux — see "Closed since
2026-08-07" at the top of this file.

### P2 — pushes not completed

- ~~**`atmux-geoyws` unpushed**~~ — **DONE 2026-08-09**, operator pushed `223e5e9..05c19bd`.
  (Historical note worth keeping: the agent's own `git push` was blocked twice by the Claude Code
  permission classifier — one transient stage-2 error, then a hard block — while pushes to four
  other repos in the same session succeeded. If it recurs, the operator runs
  `! git push origin <branch>` directly rather than the agent retrying.)
- **`opencode-plugin-orch` is 1 commit ahead on `master`, deliberately unpushed** — ADR-028 forbids
  agent pushes to main/master. `git -C /root/work/src/opencode-plugin-orch push origin master`.
- **`/root/work/hig` has no git remote configured at all** — its commit is local-only. Decide
  whether that repo should have an origin.

### P2 — repo-hygiene debt (from the coherence audit)

Ranked by payoff-per-minute. Item 4 is the one only George can do.

1. `docs/ARCHITECTURE.md:54` and `:58` link to `adr/058-cage-tier-isolation.md`, which does not
   exist. Proven pre-existing (`git show HEAD:` is byte-identical). Needs the intended target.
2. `docs/adr/INDEX.md` rows 125 and 205 are truncated mid-markdown-link
   (`[ADR-214](./214-retire-om |`). Also proven pre-existing.
3. Dangling `ADR-060` cites in **15 files** — no `docs/adr/060-*.md` has ever existed and ADR-126
   carries no "renumbered from 060" note. `src/abstractions/sqlite.ts`,
   `src/abstractions/sqlite-migrations.ts`, `src/verbs/migrate-state.ts`, `src/verbs/status.ts`,
   `src/core/kanban.ts`, `src/core/epic.ts`, `src/core/repositories/kanban-repo.ts`, 3 test files,
   and briefs `team-lead.md` / `lead.md` / `reviewer.md` / `merger.md` / `member.md`.
   `docs/`, `README.md` and `templates/briefs/committer.md` are already clean. CHANGELOG hits are
   append-only history — leave them.
4. **Ratify or reject [ADR-237](docs/adr/) and [ADR-238](docs/adr/)** — `proposed` since
   2026-05-24 yet already relied on as law by ADR-266's shipped sweep and by ADR-267's citations.
   Highest-leverage single decision available; unblocks the whip/cron/Discord surface story.
   (24 of 244 ADRs are still `proposed`; 11 are SUPERSEDED-in-filename and **10 more are superseded
   in body only**, so the filename heuristic lies — INDEX.md needs a status column.)
5. Collapse the three coexisting audit locations (`docs/audit.md`, `docs/audit/`, `docs/audits/`)
   and move the loose `INVESTIGATION-*` / `CONVENTION-*` files under one. Delete
   `docs/whip-needs-approval.md` — it names a verb ADR-266 removed.
6. Put dated `SUNSET()` markers (ADR-266 §D1) on `src/verbs/ombudsman.ts` + `src/core/complaints.ts`
   and name ADR-214's cutover condition, so the largest retired-role surface has an expiry rather
   than an indefinite safety-net clause.
7. LAST, lowest payoff / highest risk — the 6 `team-rename*` modules. Leave until 1–6 land.

### P2 — missing verb surface found while working

- `atmux story update` has **no `--title` flag** (`src/verbs/story.ts:33` USAGE_UPDATE;
  `updateStory` at `src/core/story.ts:666` only applies `body` + `acceptanceCriteria`). Retitling
  `s-52` required a direct `stories.title` UPDATE via bun:sqlite. Worth adding a `--title` flag.
- `templates/briefs/team-lead.md` is a **symlink** to `lead.md` (mode `120000`). Something
  dereferenced it into a 47,931-byte duplicate; restored in `e8e9943`. If it reappears as a regular
  file, whatever tool is rewriting briefs is following symlinks — fix the tool, not the file.

---

## Multi-provider budget/usage tracker (`atmux budget`)

Hourly token/quota/spend across all 7 live AI providers → SQLite (`~/.atmux/state/budget.db`) → `atmux budget report` → `/budget` skill narration.

- **Epic:** `e-50-666140ed`
- **Spec:** [`docs/briefs/budget-tracker.md`](docs/briefs/budget-tracker.md) · verified endpoints: [`docs/briefs/budget-tracker-discovery.md`](docs/briefs/budget-tracker-discovery.md)
- **Scope (George 2026-07-31):** SQLite (not Postgres) · all 7 providers ON · Claude = **gmail + ifca2 only** · kimi+cursor best-effort (undocumented) · DB stores usage numbers only, never keys.
- **Handed off 2026-07-31** from George's main-loop session (the security classifier blocks live provider-key calls on the main loop → drivers verify in their own context).

Stories (kanban `atmux story list --epic e-50-666140ed`):

- [ ] `s-52` — ADR-270: design record (schema, 7-provider list, security posture) — before code lands. Re-pinned from ADR-267 on 2026-08-07 (its brief chose the number positionally as "next free"; 267 was taken by a written ADR with live cross-refs). Kanban story title updated to match; see `.atmux/decisions.md`. **Re-verify the ADR tail before authoring — 271 is taken, so 270 is the reserved slot.**
- [ ] `s-53` — `usage_snapshot` schema + migration (`sqlite-migrations.ts` → `~/.atmux/state/budget.db`)
- [ ] `s-54` — Provider adapters (7) + unit tests (anthropic reuses `budget-probe.ts`; kimi+cursor best-effort, `ok=0` on fail never abort; 100% coverage)
- [ ] `s-55` — `atmux budget collect` + `report [--json --window]` verbs (fold in `cost.ts` actual spend)
- [ ] `s-56` — Hourly cron (`crontab.ts` + `cron-install`, ADR-192 idempotent; `cron-remove` reverses)
- [ ] `s-57` — `/budget` skill consumes `atmux budget report --json` (verdict-first; `--live` runs collect first)

Full acceptance criteria + the reuse-not-duplicate integration map are in the brief.
