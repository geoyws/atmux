# Changelog

All notable changes to **atmux** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### 🔤 Vocabulary refresh — SV register sweep

- **ADR-158 (proposed)** — `martinet` → `sentinel` rename (cockpit W3 role + schema key + source identifiers). Cockpit role-type identifier change; design preserved verbatim per ADR-132. JSON-shim in `src/core/cockpit.ts::migrateMartinetBlockToSentinel` accepts legacy `martinet:` key for one release cycle with deprecation-warn (mirrors ADR-133 `migrateSuperdoctorBlockToMedic` precedent). Source identifiers renamed via TR2 (`src/abstractions/sentinel.ts`, `src/verbs/sentinel.ts`, `src/core/sentinel-escalation.ts`); same-commit docs sweep via TR4 (this entry).

> **Post-0.6.0 follow-ups** (catchup sweep 2026-05-13 per t-a1cc07bc).
> `0.5.0` and `0.6.0` shipped without their own CHANGELOG sections — the
> Epic 1 (pull-model kanban), Epic 2 (whip enrichment), Epic 3 (hot reload),
> Epic 4 (atmux flag) bullet groups below cover the bulk of `0.5.0`'s scope;
> `0.6.0` adds the ADR-077 **superdoctor wave** + ADR-079 / ADR-080 noise-
> drainage + improvement bundles (each bullet now cross-references its ADR
> for traceability). The remaining post-0.6.0 work is grouped below under
> **post-0.6.0 follow-ups** until the next release cut.

### 📐 Proposed — ADR-162 atmux owns its tmux infrastructure (cockpit-socket isolation + canonical `atmux.conf` + version probes)

- **[`docs/adr/162-atmux-owns-tmux-infrastructure.md`](docs/adr/162-atmux-owns-tmux-infrastructure.md)** (Status: proposed) — closes the operator-side foot-gun captured in [[project_atmux_socket_isolation_state.md]]: cockpit windows used to land in the operator's own default-socket tmux server; a stray `tmux kill-server` from the operator wiped atmux + personal state together. ADR §Decision-anchor #1-5 specify dedicated `atmux-cockpit` named socket + canonical `templates/tmux/atmux.conf` loaded via `-f` + two new doctor probes. Implementation spans TR1-TR6 (filed in same session per [[feedback_decomp_same_session_with_deps]]); TR2-TR5 already shipped, TR3 + TR6 land in 2026-05-16. See **🟢 Shipped** entries below for per-TR landings.
- **`atmux cockpit migrate-socket`** (TR3, shipped — see entry below) — one-shot migration verb preserving window topology + scrollback as breadcrumb (PID preservation impossible via tmux primitives — documented in ADR-162 §Amendment 2026-05-16).
- **`templates/tmux/atmux.conf`** (TR4, shipped) — canonical 8-option baseline; loaded via `-f` on every cockpit + per-team session.
- **Doctor probes** (TR5, shipped) — `tmux-version-mismatch` + `cockpit-on-default-socket` (warn-class).
- **`docs/RUNBOOK-cockpit.md`** (TR6 same-commit doc sweep, 2026-05-16) — new 5-section operator runbook covering socket isolation, migration verb, canonical `atmux.conf`, doctor probes, and `ATMUX_COCKPIT_SOCKET` escape hatch. ARCHITECTURE.md gains a §Tmux topology section + new Principles bullet 5.

### 🟢 Shipped — `atmux cockpit migrate-socket` one-shot verb (ADR-162 TR3, t-26346aef, 2026-05-16)

- **New sub-verb** `atmux cockpit migrate-socket` migrates a legacy cockpit session from the operator's default tmux socket to the dedicated `atmux-cockpit` named socket per ADR-162 §Decision-anchor #1 + #4. Idempotent — re-running on an already-migrated cockpit is a no-op. Filed in same session as the TR2/TR4/TR5 implementation per [[feedback_decomp_same_session_with_deps]].
- **Six-phase flow** (per ADR-162 §Decision-anchor #4): discovery on default socket → scrollback capture → recreate session on `atmux-cockpit` socket → recreate windows (additive merge when target session exists) → scrollback breadcrumb to `/tmp/atmux-cockpit-migrate-<epoch>.log` → cleanup legacy session. Both the canonical `atmux_cockpit` session name AND the pre-ADR-135 `atmux_teams` legacy are accepted on the source side; both canonicalise to `atmux_cockpit` on the target.
- **`--dry-run`** previews the planned migration without mutating either socket. Reports discovered legacy windows + cleanup intent; safe to run on production cockpits before commit.
- **`--keep-legacy`** skips Phase 6 cleanup. Legacy default-socket cockpit and new atmux-cockpit cockpit coexist; operator decides when to nuke the legacy via `tmux kill-session -t atmux_cockpit`.
- **`ATMUX_COCKPIT_SOCKET=default` refusal**: when the operator has opted back into the legacy socket via the escape hatch, migration target equals source → refuses with hint to unset the env var.
- **Process-preservation — honest mechanism** (ADR-162 §Decision-anchor #4 amendment): graceful-recreate, NOT PID-preservation. tmux primitives can't transfer running pane processes across servers (sockets) — the PID is bound to a PTY the source tmux server owns; severing severs stdio. ptrace-based reparenting tools (`reptyr`) exist but are not bundled. Scrollback is captured + presented as visual context in the breadcrumb file; operator re-invokes any in-pane Claude/script process in the new panes. Cron-spawned cockpit roles (medic / martinet / sentinel) re-establish themselves on the next cron tick — they're not state-bearing across ticks.
- **Tests** (`tests/unit/verbs/cockpit.test.ts`, ~96% coverage on the new code path): parser arms (bare / --dry-run / --keep-legacy / rejection on rebuild|reload / unknown-verb error mentions new subverb); `buildMigrationBreadcrumb` (per-window separators, empty scrollback placeholder, zero-window edge); mock-driven flow (Phase 1 short-circuit on missing server / no legacy / `ATMUX_COCKPIT_SOCKET=default` refusal; happy-path mixed `atmux_cockpit`+`atmux_teams`; --dry-run zero-mutation; --keep-legacy preserves; idempotent additive merge against pre-existing target; Phase 6 kill-session failure warns + continues; Phase 2 capture failure warns + continues).
- **E2E follow-up**: a real-tmux ephemeral-socket e2e (per ADR-162 TR3 §5) is filed for a sibling Task — the unit-mock coverage of all 6 phases + the deliberate graceful-recreate mechanism narrows the e2e surface to "happy-path on real tmux." Reviewer can request before signoff if desired.

### 🟢 Shipped — atmux 0.8.1 install — templates-dir fix (t-17d413b1, resolves c-003a2a4c, 2026-05-16)

- **Root cause** (verified via `/usr/local/bin/atmux init` repro in `/tmp/atmux-init-test/`): the previous `defaultTemplatesDir()` / `defaultBriefsDir()` resolvers used `resolve(import.meta.dir, "..", "..", "templates"[, "briefs"])` which broke in compiled-bun mode. `bun --compile` produces an ELF where `import.meta.dir` returns a path inside bun's internal $bunfs (rooted at `/`), so the resolve walked to `/templates` (filesystem root). Repro: `atmux init` errored with `fs read failed on /templates/team.example.json`. Same break would hit every brief read from `src/verbs/rotate.ts` + `src/verbs/start.ts` (the `defaultBriefsDir()` consumers) — bug surfaced first on `init` because that's the operator's first call against a fresh install.
- **Fix**: new `src/core/templates-dir.ts` exports `resolveTemplatesDir(env?)` + `resolveBriefsDir(env?)` with a 4-stage resolution chain — (1) `ATMUX_TEMPLATES_DIR` env override; (2) dev-mode probe `<this-file>/../../../templates` via `import.meta.dir` (exists in source tree, falls through when missing in $bunfs); (3) installed-mode probe `<realpath(process.execPath)>/../templates` (resolves `/usr/local/bin/atmux → /opt/atmux/current/bin/atmux → /opt/atmux/<V>/bin/atmux` then up 1 → `/opt/atmux/<V>/templates/`); (4) fallback returns the dev-mode path even if missing so downstream `readJson` / `readText` surfaces a clear actionable error. `src/verbs/init.ts::defaultTemplatesDir` + `src/verbs/rotate.ts::defaultBriefsDir` both delegate to the shared resolver.
- **Companion `build:install` change**: `package.json::scripts.build:install` now runs `sudo rm -rf /opt/atmux/<V>/templates && sudo cp -r templates /opt/atmux/<V>/templates` between the binary install + the atomic symlink swap so the installed-mode resolver has a target. `rm -rf` ahead of the copy makes re-installs of the same version idempotent (handles operators iterating on `build:install` during dev). `docs/RUNBOOK-deploy.md` §Cut procedure step 4 sub-numbered to call out the new static-assets ship step explicitly + cross-link this fix.
- **Version bump `0.8.0 → 0.8.1`** (PATCH per semver — backward-compat bug fix, no new surfaces). `package.json::version` bumped; deployed via `bun run build:install` from the worktree to `/opt/atmux/0.8.1/` + atomic symlink swap. 0.8.0 preserved at `/opt/atmux/0.8.0/` as the rollback target (`ln -sfn /opt/atmux/0.8.0 /opt/atmux/current` reverts in one line).
- **Verification**: post-install `/usr/local/bin/atmux init` in `/tmp/atmux-init-test/` succeeds with no fs read error (full team.json scaffolded with 11 members + tmuxTmpdir + cwd-rewrites). `--version` returns `atmux 0.8.1`. Unit tests in `tests/unit/core/templates-dir.test.ts` (8 tests, 100% line/func coverage on the new module: env override paths, dev-mode probe, edge cases). Installed-mode `process.execPath` branch is exercised via the shell-level repro (can't be covered purely in-process under bun-test because `process.execPath` is the bun binary, not atmux).
- **Complaint c-003a2a4c marked resolved** (high — install UX failure): cross-ref to this commit's SHA in the resolution note.
- **Note on the task body's npm-hypothesis**: the task body proposed adding `templates/` to `package.json::files`. That hypothesis assumes npm-tarball publishing; atmux ships via `bun --compile` to a single-file ELF + sudo install — no npm tarball is involved. The real bug is the resolver's `import.meta.dir` assumption in compiled mode, not a packaging exclusion. `package.json::files` was `null` (i.e. unset) before this fix + remains unset after — irrelevant to the install topology per ADR-047.

### 🟢 Shipped — team-of-teams pre-sopx capstone phase-1 skeleton (t-edc93b42, 2026-05-16) + `docs/RUNBOOK-team-of-teams.md`

- **New `tests/e2e/team-of-teams-pre-sopx.test.ts`** — capstone gate spec authored as a **structured skeleton** (`describe.skip` + 8x `test.todo` covering the full ADR-090/091/134 lifecycle: spawn 2 parallel epics → seed mock Tasks → claim/done lifecycle → auto-merge state machine fan-in to epic-trunk → epic-trunk fan-in to parent-trunk → dissolve-epic → parent KanbanEpic done → no-leakage proof). Fixture-helper signatures locked: `ParentFixture`, `SpawnedEpic`, `LifecycleSnapshot`, `DissolutionResult` interfaces define the phase-2 contract; module-level `activeFixtureDirs` registry + `process.on('exit')` hook + `afterAll` sweep mirror the t-88b60ca7 / c-4698c603 defense pattern so the same cleanup machinery lights up when phase-2 swaps in real fixtures. State-snapshot expectations table (per CLAUDE.md Test finding report pattern) documented in companion RUNBOOK; idempotence proof (post-cleanup snapshot == pre-spawn-baseline) is the closure beat.
- **Phase-1 ship rationale (vs deferring entire file to phase-2)**: reserves the canonical filename + fixture shape so phase-2's diff is implementation-only; documents the INTENDED lifecycle + state-snapshot expectations now while context is hot; locks down helper signatures so phase-2's review gate has a stable structural contract. Per CLAUDE.md "Pair demo runbook beats with rehearsal spec steps" — every RUNBOOK beat name maps to one `test.step()` label verbatim in phase-2; drift surfaces as a failing rehearsal run, not a sopx-flip-morning surprise.
- **WIDER blocker captured in spec header**: phase-2 wires real assertions once gitter sweep fans the following branches into trunk — `geoyws-up-impl-3` (carries 762716f + aac4ee1 + 57b0d0d + b502ebe + a34fafa: ADR-090 schema + spawn-epic/dissolve-epic verbs + ADR-091 state machine + ADR-090↔091 wire-up) + `geoyws-up-impl` (carries ba7ee3f: ADR-092 cross-team tell-lead). All listed branches were `state=null action=queued` or `skipped-in-flight` in the gitter sweep run at 06:14 MYT 2026-05-16; gitter-stuck-bug captured separately at t-f4088323.
- **New `docs/RUNBOOK-team-of-teams.md`** — operator-facing companion: when-to-spawn / sopx-adoption-sequence (8 verbatim beats from driver-inbox 14:03 MYT lines 3122-3132, 1:1 with spec test.step labels) / state-snapshot expectations table (8 stages with parent.KanbanEpic.status / cockpit.epic-entry / worktree / cage / cron-block columns) / failure-mode triage / cross-team tell-lead deferred-to-phase-2 note / doctor D5a/D8/D9 deferred-to-phase-2 note / adjacent-flags from t-cc4c5fd9 audit. `⚠️ Status: phase-1 skeleton` banner at top until phase-2 flips Intended → Verified.
- **Phase-2 deferred to** `t-bc4fdb19` (deps=[t-c2e544b6, ba7ee3f-on-trunk]) with full ADR-092/doctor-D8/D9 + spawn-epic/dissolve-epic real-assertions scope; TODO comment block at end of spec cross-links the 3 cross-team tell-lead paths + 3 doctor checks + 3 adjacent-flag-deferrals so phase-2's claimant has a turnkey wiring spec.

### 🔴 Fixed — `advanceStory` + `advanceEpic` reviewer/team-lead lookup: `dir:` not `teamDir:` for `tryLoadTeam` (t-85846a0b clusters 4+5 of t-2b801707; 8 failures closed)

- **`src/core/story.ts:186`** (`advanceStory` entry) and **`src/core/epic.ts:237`** (`dispatchEpicSummary`): replaced `tryLoadTeam({ teamDir: atmuxDir })` with `tryLoadTeam({ dir: atmuxDir })`. `getAtmuxDir`'s `teamDir` semantics is "project root containing `.atmux/`" (appends `.atmux` to the value); passing the `.atmux/` path itself caused a double-append → `<atmuxDir>/.atmux/team.json` (wrong path; always missed the test fixture's actual `<atmuxDir>/team.json`). The `dir` option is "explicit `.atmux/` path, overrides every other source" per `ResolveDirOpts` — exactly what these call sites have available. Sibling-correct pattern at `src/verbs/groom.ts:565` uses `tryLoadTeam({ teamDir: dirname(atmuxDir) })`.
- **Concrete failure mode**: pre-fix, both call sites threw `ConfigError("no member with role=reviewer in team.json")` / `("no member with role=team-lead in team.json")` regardless of whether the fixture actually had those members. Cluster 4 (advanceStory, 5 fails) and cluster 5 (advanceEpic, 3 fails) of the t-2b801707 release-blocker — both close in this commit.
- **Scope-expand transparency**: t-85846a0b's task body framed clusters 4+5 as "test-fixture additions — missing reviewer / team-lead members". Static analysis disagreed: the global test fixture in `tests/unit/verbs/story.test.ts::seedTeam` (lines 27-42) already seeds `{ name: "lead", role: "team-lead" }, { name: "reviewer", role: "reviewer" }` at the canonical `join(atmuxDir, "team.json")` path. The bug was production-side; the fixtures were always correct. Scope-boundary on T1 (no `src/` touches) bent for the 2-line surgical fix per operator urgency (release-blocker for epic-teams).
- **Cluster 8 deferred to sibling task** (start ADR-063 cockpit auto-reconcile, 3 fails). Static analysis suggests the test recorder + production code's positional args still line up post-ADR-133 rename and post-ADR-135 session-name shift; identifying the precise 3 failures requires bun-test runtime execution which is blocked by [[feedback_pause_bun_tests]] (cage-crash rule). Filed as separate task for test-impl with bun-test access.

### 🟢 Shipped — task update: `--driver-only` / `--no-driver-only` retro-flag (t-2ef0c994; closes the "verb supports retro-flag?" gap)

- **New `setTaskDriverOnly(atmuxDir, id, driverOnly)`** helper in `src/core/kanban.ts` (mirrors `setTaskDeps` shape). Boolean retro-flag setter for ADR-033 `driverOnly`; `true` sets, `false` clears (normalized to `undefined` on write per `task add`'s "only stamp when explicitly true" pattern at line 208 so the on-disk shape stays clean). SQLite-aware via `_useSqlite` / `_withDb` / `transact`; falls through to `updateTaskByIdOrThrow` on the legacy JSON path. Throws `ConfigError` on missing id.
- **`atmux task update --driver-only` / `--no-driver-only`** flag in `src/verbs/task.ts`. Both are boolean flags (no value). Previously `task add --driver-only` was the only entry point — operators who forgot at filing time, or decided to park a Task after filing, had no verb path (the t-2ef0c994 task body explicitly noted "assuming verb supports retro-flag; otherwise direct kanban edit"). Update verb's "at least one of" guard now includes both flags; help text + USAGE_UPDATE string updated.
- **Operational fix applied same session**: `atmux task update t-9319a22c --driver-only` flipped `driverOnly: false → true` on the Supergroomer parking-lot Task. Verified via `atmux task list` showing the `D` marker in the F column. Per the task body's acceptance: t-9319a22c remains visible in `atmux task list --status blocked --json`; auto-pickup by `claim --next --as <member>` is now refuse-gated by `isDriverOnlyBlocked`; `atmux claim t-9319a22c --as driver` retains pickup ability (driver scope bypasses the refuse-gate). Closes the 3+ observed auto-claim loops biting up-impl during 2026-05-15.
- **Same-commit tests** at `tests/unit/core/kanban.test.ts` — 4 new cases in `describe("setTaskDriverOnly", ...)`: set-on-fresh-task, clear-normalizes-to-undefined, idempotent-re-set, missing-id-throws.

### 🔴 Fixed — gitter sweep: `in_progress` no longer blocks re-queue (t-f4088323 P1 — branches stuck while workers task-clean)

- **`src/core/gitter-sweep.ts`** — remove `in_progress` from `IN_FLIGHT_STATES` constant. The initial too-conservative shape (ADR-134 T4 baseline) included `in_progress`, which trapped branches whose dispatcher pre-merge gate (`shouldTransitionFromInProgress`) was held by worker dirty-state at the FIRST tick: once the state was seeded `in_progress`, sweep skipped it forever, so the gate never re-evaluated when the worker became task-clean. Post-fix, `in_progress` is treated like `open` from the sweep's perspective — re-queue every cycle and let the dispatcher re-run the gate.
- **Concrete blocking case observed 2026-05-16 12:2X MYT**: 11/16 branches transitioned to `merger_state=in_progress`, then sat across multiple sweep cycles even after their workers went task-clean. `ba7ee3f` on `geoyws-up-impl` (+2 ahead of trunk) sat 30min stuck; capstone-task `t-edc93b42` was blocked waiting for the trunk-merge so `t-c2e544b6` (ADR-092 dogfood) could claim.
- **Idempotence preserved**: the dispatcher's `shouldTransitionFromInProgress` is idempotent on `in_progress → in_progress` self-loops (BEGIN IMMEDIATE per ADR-134 §state-machine race-protection). A gate-still-held tick returns `{queued:false, reason:"gate-held: <reason>"}`; the sweep records this as `queue-refused` with the dispatcher's note so operators can see WHY the branch didn't advance.
- **Remaining IN_FLIGHT_STATES** (`ready_to_merge`, `rebasing`, `merging`, `tested`, `test_failed`) stay in the skip set — these are genuine mid-walk progress states owned by either the same-tick dispatcher iteration loop OR a caller-driven test gate (the dispatcher's "Stop conditions" loop carve-out for tested/test_failed). Re-queueing these would race the active progressor.
- **Tests at `tests/unit/core/gitter-sweep.test.ts`**: existing `test.each` parameter list trimmed from 6 states to 5 (drops `in_progress`); two new tests pin the post-fix behavior — `state=in_progress + commits ahead → queued` (re-eval gate) and `state=in_progress + dispatcher gate-held → queue-refused` (queue path runs, dispatcher's `{queued:false}` falls through with informative `reason`). Idempotence test's seed transition changed from `in_progress` to `merging` (the original intent — pin sweep-doesn't-double-fire on a mid-walk row); a companion test pins the explicit post-fix `in_progress → re-queue` path.
- **Operator unblock**: branches stuck pre-fix start advancing on the next sweep tick once their workers are task-clean. `t-edc93b42` capstone unblock + `t-c2e544b6` ADR-092 dogfood claim path clear.
- **Skipped optional**: dispatch mentioned options 2 (`--advance <branch>` manual override) + 3 (`--reevaluate` flag) — both deferred to follow-on; the structural fix (option 1, narrowest scope) is sufficient for the live blocker.

### 🟢 Shipped — gitter: post-merge done-flip hook closes duplicate-ship leak at source (t-f8beb03b; Part b of t-dc830eb0)

- **New `src/core/post-merge-task-flip.ts`** + wiring into `src/core/intra-team-merge-dispatcher.ts` (ADR-160 candidate). Closes the duplicate-ship leak at SOURCE: where Part a's groom kanban-vs-git reconcile is read-side reconciliation (catches what already leaked, daily cadence), Part b is write-side prevention — every successful merge tick in the in-team auto-merger scans the just-merged range (`<previousBaseSha>..<mergedSha>`) and flips every referenced open Task to `done` with note `flipped: shipped via merge SHA <hash>` (distinct from groom's `groomed: shipped via SHA` for audit-trail visual distinction).
- **Subject-only matching + EPIC parent-ref filter** mirrored from Part a's t-4ea69dd1 P0 fix: `git log --format=%H%n%s%x00` (subject only; bodies are reference scaffolding, NOT ship signals), plus `PARENT_REF_KEYWORDS = ["EPIC ", "parent ", "Parent: ", "Refs: ", "Ref: "]` filter to skip task IDs preceded by parent-ref keywords in conventional-commits parentheticals. Helpers are intentionally duplicated (not import-shared) per a symmetry contract — both update together when the convention shifts.
- **Dispatcher wiring** in `productionQueueMergeAttempt`: captures `previousBaseSha` from the entry row BEFORE the state-machine walk, captures `mergedSha` during the walk on the `ready_to_merge → tested` transition, then post-walk invokes `flipTasksMergedInRange(atmuxDir, previousBaseSha, mergedSha, opts)`. Wrapped in try/catch — hook failures NEVER fail the dispatcher (merge already succeeded; kanban hygiene is best-effort). Soft-skips on `no-range` (null/empty fromSha — first-ever merge for the branch; that's groom-reconcile's job) and `git-log-failed`.
- **`src/verbs/gitter.ts` wires `atmuxDir` through `ProductionDispatcherDeps`** so the dispatcher's helper can open the kanban DB after every successful merge tick.
- **Window-of-vulnerability closed**: without Part b, members claiming in the 24h window between merge and the next groom tick still hit duplicate-ship pre-flight; the velocity-gate spurious-fire pattern (6× in 75min with 0 SHA per lead's 10:10 MYT outbox ask) recurs whenever groom is behind, even briefly. Post-Part-b, groom-reconcile becomes a backstop, not a primary mechanism.
- **Same-commit tests** at `tests/unit/core/post-merge-task-flip.test.ts` — 12 cases mirroring `groom-reconcile.test.ts`'s coverage: subject-only match → flip with merge-SHA note, body-only → NOT flipped (t-4ea69dd1 mirror), cross-ref guard, EPIC parent-ref guard (verbatim 2026-05-16 commit subjects), Revert ignored, no-range soft-skip (null + empty), git-log-failed soft-skip, skip-not-open, dry-run, first-SHA-wins, range-form invocation `<from>..<to>` + `--format=%H%n%s%x00` assertion.

### 🔴 Fixed — groom reconcile sub-op subject-match-only (t-4ea69dd1 P0 — body-grep was too greedy)

- **`src/core/groom-reconcile.ts`** — change `git log --format` from `%H%n%s%n%b%x00` (subject + body) to `%H%n%s%x00` (subject only). Match `TASK_ID_RE` against the subject line ONLY; commit bodies are no longer scanned. Closes the false-positive class shipped by t-dc830eb0's initial impl: cross-references, EPIC parent refs, deps lists, follow-up filings (`filed as t-X`), CHANGELOG cross-refs all live in commit BODIES, not subjects — they're reference scaffolding, NOT ship signals.
- **Concrete evidence triggering the fix**: 2026-05-16 first live `atmux groom` run flipped 21 actively-open Tasks to `done` as false positives (cross-ref body matches). Lead reverted all 21 to `todo` within minutes. Affected IDs included `t-7e9eed65` (in-flight to up-impl-3), `t-20674483` (ADR-152 EPIC), `t-f8beb03b` (Part b filing-record Task), plus 18 more. `cron-install --template kanban-reconcile-sweep` was unsafe until this fix.
- **Subject-only is the canonical ship signal** per conventional-commits: `feat(scope): t-XXXX — desc` declares "this commit ships t-XXXX". Body content (Closes / Refs / Deps / Cross-refs / CHANGELOG mentions / EPIC parent / Follow-up Tasks) is intentionally NOT scanned — those are coordination scaffolding for human readers, not state-transition signals for automation.
- **EPIC parent-ref filter** (post-dry-run refinement): subject-only matching alone still hit 3/21 false-positives because conventional-commits subjects carry EPIC parent IDs in parentheticals (`(EPIC t-XXXX)`, `(T1 of EPIC t-XXXX)`, `(t-AAAA, EPIC t-BBBB)`). New `PARENT_REF_KEYWORDS = ["EPIC ", "parent ", "Parent: ", "Refs: ", "Ref: "]` constant; `isParentRefAnnotation(subject, matchIdx)` checks the 12-char window before each task ID match against the keyword list (case-insensitive, trailing-space tolerant). Matches preceded by a parent-ref keyword are filtered out of the ship-signal set.
- **Regression-pin tests** at `tests/unit/core/groom-reconcile.test.ts` (14 total now, +2 over t-dc830eb0's 12):
  - "body-only match → NOT flipped" — inverted from the previously-passing flip-on-body-match case (asserts `matched === 0 && flipped === 0 && markDone NOT called`).
  - "cross-ref guard: subject names A, body names B → only A flips" — pins the body-grep bug fingerprint with 5 body mentions of B; only A flips.
  - "EPIC parent-ref in subject → NOT flipped" — pins the 3-of-21 EPIC-parenthetical fingerprint with the verbatim 2026-05-16 commit subjects (`(T1 of EPIC t-83dcef6b)`, `(t-63e3ddc2, EPIC t-51d2c635)`, `(t-f58c6ccc, T1 of EPIC t-5df48a74)`); only shipping IDs flip; EPIC IDs stay open.
- **Live verification**: post-fix `bun -e "reconcileKanbanVsGit(...)"` dry-run against the current kanban + git state reported `scanned: 58, matched: 0, flipped: 0` (no false-positive flips; legitimate ship signals already done in kanban). Pre-fix had matched 21 false-positives.
- **No flag added** — `--kanban-reconcile-strict` (default true with `--no-strict` for body-grep forensics) was in the dispatch as "Optional"; skipped for minimal P0 scope. Future forensics use can shell `git log --all --grep=t-XXXXXXXX --format=%H` directly, which is what the old body-scan was approximating.
- **USAGE_TEXT sub-op #7 description** updated to name the subject-only constraint explicitly; cron template (`kanban-reconcile-sweep`) becomes safe to install post-fix.

### 🟢 Shipped — groom: kanban-vs-git reconcile sub-op auto-flips shipped tasks to done (t-dc830eb0; Part a of two-part fix)

- **New `src/core/groom-reconcile.ts`** + sub-op #7 wired into `src/verbs/groom.ts`. Single bulk `git -C <repo> log --all --format=%H%n%s%n%b%x00` per groom run; for every open task (status ∈ {todo, in-progress}) whose ID appears in a non-revert commit's message (subject or body), auto-flip to `done` with note `groomed: shipped via SHA <hash>`. First SHA wins (git log default reverse-chrono order). Idempotent — re-running on already-done tasks is a no-op (filter scopes to open statuses only). Safe — `Revert ` / `Revert "` subjects are treated as not-a-ship-signal so a revert of a ship doesn't re-flip the task.
- **Closes the duplicate-ship dispatch-collision pattern** (lead 10:10 MYT P0 outbox ask): every claim was hitting `git log --all | grep <id>` pre-flight to avoid duplicate work; velocity-gate fired 6× in 75min with 0 SHA because every dispatch redirected on duplicate-detect (concrete cases: t-a5b01d24 / t-b3a69ac6 / t-82b6aed9 all shipped 2h ago with commit-msg referencing Task ID verbatim, still flagged `todo` in kanban).
- **Default-on; `--no-reconcile` opt-out** for projects that don't follow the "commit msg references Task ID" convention or for one-off groom invocations during a partial-history bisect. Sub-op error-contained — failures (non-versioned project, git log non-zero exit) surface as `skippedReason` not throws; groom returns 0 even when reconcile bails.
- **Runs after lane-drift-check + summarizeKanban** so the open-tasks list reflects post-sweep state, and **before `--archive`** so reconciled-done tasks become eligible for the same-run state.db archive move. Per-task `markTaskDone` invocation passes `callerScope: "driver"` (groom is a system maintenance verb invoked by cron — bypasses ADR-033 driver-only refuse-gate intended for member-pane mistakes, not the daily reconcile).
- **Same-commit tests** at `tests/unit/core/groom-reconcile.test.ts` — 12 cases: subject-only match, body-only match, Revert-commit ignored, no-match no-op, dry-run (no markDone calls), repoDir-missing soft-skip, git-log-failed soft-skip, first-SHA-wins, non-task-ID prefixes (c-/d-) ignored, empty-open-tasks (no git spawn), multi-task mixed match/no-match, --all flag verification. Plus a `tests/unit/verbs/groom.test.ts` update for the new `noReconcile` field in `ParsedGroomArgs`.
- **Companion to [ADR-160 candidate](docs/adr/) (Part b: post-merge done-flip in gitter)** — read-side reconciliation here closes the existing leak; Part b's write-side prevention closes the leak at source by extending [ADR-134](docs/adr/134-in-team-auto-merger.md) T9's production merge dispatcher to call `atmux task move <Task-ID> done` immediately after a merge, parsing the Task ID from the merge commit body. Filed as follow-on task; this commit ships Part a only.

### 🟢 Shipped — groom: wire `--inbox-days` flag → per-entry `## Open` → `## Archive` aging (t-82b6aed9; closes complaint c-7a308f7f)

- **New `ageInboxOpenToArchive(atmuxDir, days, opts)`** in `src/core/groom.ts` (t-82b6aed9). Closes the gap at `src/verbs/groom.ts:60` ("Reserved per bash flag set; not yet consumed") + `:207` ("Reserved for future per-entry inbox parsing") — the `--inbox-days` flag was parsed, validated, defaulted to 7, then dropped. Sub-op parses `driver-inbox.md` + `lead-outbox.md` into HEAD / OPEN / ARCHIVE segments via `## Open` / `## Archive` headers, splits OPEN body on `- [HH:MM MYT ...]` entry-start prefixes (continuation lines attach to preceding entry), parses each entry's timestamp (MYT = UTC+8, today-implicit when date omitted), and migrates entries older than `now - days*86400s` to the same file's `## Archive` section in OPEN order (preserves newest-at-top within ARCHIVE). Unparseable-timestamp entries stay in `## Open` (conservative — convention-violating rows shouldn't silently move).
- **`--aggressive` synonym for `--inbox-days 0`** in `src/verbs/groom.ts` — one-shot historical-bloat clear that moves every entry in `## Open` to `## Archive` regardless of timestamp shape. Use case from complaint c-7a308f7f: sopx team's 10668-line `lead-outbox.md` + 461-line `driver-inbox.md` accumulated across the markdown-storage scaling-wall; aggressive clears the residue in one tick. `--inbox-days 0` at the sub-op layer behaves identically; `--aggressive` is the operator-readable surface in cron lines + manual invocations.
- **Order BEFORE `flushInboxOutboxArchive` in groom verb body** so the just-aged entries get swept to the monthly archive file in the SAME groom pass. Without this ordering, aging would land in `## Archive` but require a SECOND groom tick to reach the monthly file — leaving inbox bloat on the demo path for up to 24h. Task body originally said "Order AFTER" but the "same pass" intent requires chronological-before — fix interpretation applied with cross-ref in the source comment.
- **Same-commit tests** at `tests/unit/core/groom.test.ts` — 4 `ageInboxOpenToArchive` fixture cases (all-fresh, all-stale, mixed-with-unparseable, aggressive) + dryRun-no-mutate + archive-header-synthesis + `sliceOpenArchive` / `parseEntryTimestamp` / `parseOpenEntries` unit coverage. Includes a `tests/unit/verbs/groom.test.ts` update for the new `aggressive` field in `ParsedGroomArgs`.
- **Stopgap until [ADR-154](docs/adr/154-driver-inbox-lead-outbox-sqlite-migration.md)** (markdown→SQLite migration for driver-inbox + lead-outbox, EPIC t-2298cbb0). Post-cutover the legacy `.md` files become read-only renders of SQLite rows and this sub-op becomes dead code. Operator pick per the dispatch literal: ship aging stopgap NOW to clear sopx 10668-line bloat immediately rather than wait for ADR-154 T2-T6.

### 🟢 Shipped — ADR-139 T5 e2e — refusal auto-rotate cold-start walk

- **New `tests/e2e/refusal-pattern-auto-rotate.test.ts`** per [ADR-139](docs/adr/139-refusal-pattern-auto-rotate.md) §D1-D5 + T5 (t-f596a318). Walks the full chain end-to-end: pane capture → `classifyRefusal` (T2) → `refusal_events` write (T3) → threshold check (T2 `shouldRotate`) → `atmux rotate` spawn (T4) → rotations log append + cap accounting + complaint file + Discord `[member-refusal-rotate]` fire. Each scenario re-seeds a throwaway tmpdir + in-memory state.db per `beforeEach` — stateful 1x cold-start walks per CLAUDE.md testing discipline.
- **Six scenarios cover the EPIC acceptance gate**: (1) 3 soft events → rotate fires + log row + Discord 🟡; (2) 2 hard events → rotate with class=hard; (3) 1 role event → instant rotate; (4) cap exhaustion (3/day) → 4th trip files complaint + emits 🚨, NO spawn; (5) exempt member → events recorded for audit but rotation skipped; (6) backward-compat — team without `refusalDetection` block → defaults apply + rotate fires on 3 soft events.
- **Mocking shape**: `paneCapture` returns pre-canned ADR-139-classifier-matching strings per beat (real classifier runs on the captures); `openDb` pins to `:memory:`; `spawnAtmux` + `sendDiscord` are recorders. Per ADR-139 T5 task body's "OR by seeding pre-recorded captures into a fake tmux capture-pane shim" carve-out — full live tmux is unnecessary for the trigger-chain proof.
- **Same-commit doc update**: `docs/RUNBOOK-stall-recovery.md` gains a `[member-refusal-rotate]` runbook entry mirroring the existing `[whip-modal-cycling]` shape — what fires it, auto-recovery surfaces, manual escalation steps, per-team opt-out JSON, rehearsal commands. Per CLAUDE.md "pair demo runbook beats with rehearsal spec steps" rule — runbook reads against the e2e walk's beats.
- **EPIC complete**: ADR-139 T1+T2+T3+T4+T5 all shipped. Reviewer flips `Status: Proposed` → `Status: Accepted` in the follow-up `chore(adr)` commit.

### 🟢 Shipped — ADR-139 T4 refusal-rotate trigger + cap (`team.json::refusalDetection`)

- **New `team.json::refusalDetection` Zod block** per [ADR-139](docs/adr/139-refusal-pattern-auto-rotate.md) §Config + T4 (t-a830d2ee). Strict-mode shape (ADR-054 §D3 drift detection — typos like `softTreshold` reject at load): `enabled`, `softThreshold`, `hardThreshold`, `roleThreshold`, `windowMin`, `exemptMembers`, `maxRotationsPerDay`. All fields optional; absent block resolves to defaults via `resolveRefusalConfig(team.refusalDetection)`. Defaults mirror ADR-139 §D3 table verbatim (soft=3, hard=2, role=1, window=30min, cap=3/day per OQ-2).
- **New `src/core/refusal-trigger.ts::runRefusalTriggerForTeam`** — the trigger glue between SCAN+RECORD (T3) and `atmux rotate` fire. For each team member: read recent `refusal_events` rows (via T3's `listRefusalEventsForMember`), apply outer gates (exempt members, day-cap), call `shouldRotate` (T2 pure decision), spawn `atmux rotate <member>` on green, append row to `<atmuxDir>/state/refusal-rotations.log` (tab-separated, UTC day-key in column 2 for cap arithmetic), file complaint on `cap-hit` HARD escalation, emit Discord `[member-refusal-rotate]` template. Every collaborator (DB, spawn, clock, fs append, Discord send, member filter) is dep-injectable.
- **Cap-hit + spawn-failed HARD paths** — when today's rotation count ≥ `maxRotationsPerDay`, the trigger files a deduped complaint (sourceKind=`refusal-trigger`, sourceId=`refusal-cap-hit:<team>:<member>:<UTC-day>`) AND emits the Discord template with `escalation: 'cap-hit'` → 🚨 verdict + 🙏 Need-from-George bullet. When the rotate spawn returns non-zero exit, the trigger still records the attempt (next tick re-fires if events keep landing) AND emits `escalation: 'spawn-failed'` → 🚨 verdict naming the failure.
- **New Discord `[member-refusal-rotate]` typed renderer** at `src/abstractions/discord.ts::renderMemberRefusalRotate` per CLAUDE.md §Discord format rules. Verdict-first (single load-bearing line), category emoji 🔄 (green path) or 🚨 (HARD path), `topPhrases` surface as 📋 trigger bullets, footer carries `rotations today: N/maxRotationsPerDay · window Xmin`. Mobile-triage on a phone: one verdict line + one footer + (HARD-only) one Need-from-George bullet.
- **Same-commit tests** at `tests/unit/core/refusal-trigger.test.ts` (12 tests: outer gates `disabled`/`exempt`/`skip-no-events`/`skip-below-threshold` + threshold-crossing paths soft/hard/role + cap-hit complaint-file + spawn-failed escalation + log-row UTC-day-key format), `tests/unit/schema/team.test.ts` (12 tests: TeamRefusalDetection empty/full/partial/strict-rejection/default-constant/resolveRefusalConfig defaults applier + Team-integration), and `tests/unit/abstractions/discord.test.ts` (5 tests on the new renderer: rotate vs cap-hit vs spawn-failed verdicts, single-event plural-drop, empty-phrases footer fallback).
- **Same-commit doc updates** — ADR-139 §Implementation plan §Progress annotates T2+T3+T4 ship status; deferred §D4 post-rotate verification path called out so reviewers don't ask "where's the T+5min re-scan" mid-review.
- **Out of scope this commit** — T5 e2e proof (synthetic refusing pane fixture + threshold trip + rotation observation + cap exhaustion + exempt verification); the T+5min post-rotate re-scan (scheduler concern per ADR-139 §D4 — belongs in medic's hourly loop or a dedicated cron, not the trigger module); LLM-based classification (per EPIC out-of-scope); cross-team aggregation (Phase 2). Reviewer flips ADR-139 Proposed → Accepted once T5 lands.

### 🟢 Shipped — ADR-139 T3 refusal-event scan + record (`atmux refusal-scan`)

- **New `atmux refusal-scan` verb** per [ADR-139](docs/adr/139-refusal-pattern-auto-rotate.md) §D2 + T3 (t-841049e4). Captures each team member's tmux pane, runs the ADR-139 T2 classifier (`src/core/refusal-classifier.ts`), and records positive results to a new per-team `refusal_events` SQLite table. Record-only — threshold-trigger logic + auto-rotate fire path ship in T4.
- **Migration v6 → v7** in `src/abstractions/sqlite-migrations.ts` materialises `refusal_events(id TEXT PK, member TEXT, team TEXT, phrases TEXT JSON, severity TEXT, confidence REAL, detected_at INTEGER, minute_bucket INTEGER)` + `UNIQUE(member, minute_bucket, severity)` idempotency constraint per ADR-139 §D2. Same-minute re-scans (medic + martinet ticks overlapping inside 60s, or a tick double-firing on retry) collapse to a single row via `INSERT OR IGNORE`.
- **Pure-of-direct-IO core** at `src/core/refusal-scan.ts` — `scanTeamForRefusals(team, atmuxDir, deps)` walks members, classifies, records via `recordRefusalEvent`. Every external collaborator (pane capture, classifier, DB factory, clock, member filter) is dep-injectable so unit tests pin all dimensions without touching disk or tmux. `listRefusalEventsForMember` exposes the read-side surface T4's threshold gate consumes.
- **Medic invocation contract** (ADR-077 §F7 annotation): medic's hourly per-team sweep now fires `atmux refusal-scan --team-dir <path>` once per enabled team, after the existing complaints sweep. Verb is a record-only no-op when zero detections land — safe every tick. Skill prompt at `~/.claude/skills/superdoctor/superdoctor-prompt.md` (dotfiles-managed per ADR-141 + memory `[[feedback_claude_skills_dotfiles_territory]]`) picks up the hook out-of-band — atmux side ships the verb + ADR annotation.
- **Martinet forward-compat hook** (ADR-132 §D1 cross-ref + new `templates/briefs/martinet.md` scaffold). Same verb at 270s cadence makes martinet the primary detector once its skill prompt lands (post-ADR-132 T8); medic stays the hourly backstop. Shared `UNIQUE(member, minute_bucket, severity)` constraint makes concurrent ticks safe.
- **Same-commit tests** at `tests/unit/abstractions/sqlite-migrations.test.ts` (7 tests on the v6→v7 ladder: column shape + types + NOT NULL + PK, UNIQUE constraint, `json_valid` CHECK, round-trip, INSERT OR IGNORE dedup, severity-differentiation, secondary index presence) + `tests/unit/core/refusal-scan.test.ts` (15 tests across `recordRefusalEvent`, `listRefusalEventsForMember`, `scanTeamForRefusals` happy + dedup + capture-failure + empty-capture + member-filter paths).
- **Out of scope this commit** — T4 threshold-trigger logic + `atmux rotate-member` fire + Discord template + complaint wire (`refusal-threshold.ts::shouldRotate` reads the rows this verb writes); T5 e2e proof (synthetic refusing pane + threshold trip + rotation observation); LLM-based classification (v2 if regex false-negatives become operationally meaningful); cross-team aggregation (Phase 2). Reviewer flips ADR-139 Proposed → Accepted once T3+T4+T5 land.

### 🟢 Shipped — ADR-050 §Brief generator (Tier 2 fallback brief composer)

- **New `src/core/fallback-brief.ts`** per [ADR-050](docs/adr/050-fallback-chain.md) §Brief generator (t-d15b23da). Pure-of-direct-IO module: `composeFallbackBrief(opts)` reads the member's pre-pause in-progress Task body + `templates/briefs/<role>.md` + `git log --oneline -10` + `lead-outbox.md` tail (50 lines), assembles per ADR-050 §step 1-5 order, writes to `<atmuxDir>/state/fallback-brief-<member>.md`. Cage spawn (`src/abstractions/fallback-cage.ts`) pipes this as the initial prompt to `cursor-agent --print`.
- **Tier-2 guardrails preface** inserted verbatim from ADR-050 §step 3: 4 lines naming the executor (`cursor-agent`), the original member, the SAME-branch + SAME-commit-prefix commit policy, the `atmux reply '[fallback-cursor]'` exit protocol, and the mid-resume teardown notice. Substitutes the original member name + agent name at compose time.
- **Missing-input degradation**: per-section notice lines when an input is missing (no in-progress task / brief template absent / git log empty / lead-outbox empty). Composer NEVER throws; the cage agent always sees a coherent document even when state is partial.
- **Dep-injection seams** on every reader (gitLog / readTemplate / readLeadOutboxTail / writeBrief / taskBody override) — unit tests pin deterministic inputs without touching disk or shelling git. Default impls fall through to `Bun.file` / `runSpawn` / `loadInbox`.
- **Same-commit tests** at `tests/unit/core/fallback-brief.test.ts` — 12 tests across 6 describe blocks (happy path, guardrails preface, missing-input degradation x5, section ordering, git-log fail-soft, result-shape contract). 100% line coverage on the new module.
- **Out of scope this commit** — `src/verbs/whip.ts` extension that fires the composer at sustained-pause detection (T2 dep: `t-5881225a` ADR-050 §Trigger semantics); resume-continuity composer (T3 dep: `t-8ec31d4d` ADR-050 §Resume continuity); e2e (T4 dep: `t-7c491368` ADR-050 §E2E gate).

### 🟢 Shipped — ADR-141 Claude shared skills + memories (atmux-side scripts)

- **New [ADR-141](docs/adr/141-claude-shared-skills-memories.md)** — canonical layout under operator's dotfiles repo (`~/work/journals/.sb/_dotfiles/claude-shared/`) with per-account symlinks. Memory + skill workspace dirs shared across all five `~/.claude*` accounts; auth + sessions + plugin-cache + settings.json stay strictly per-account.
- **`scripts/claude-shared-audit.sh`** — read-only audit. Walks every `~/.claude*/projects/*/memory` + `~/.claude*/skills/*` (workspace dirs only — plugin-cache symlinks skipped), reports per-project diffs / sizes / suggested winner (most-recent-mtime) / conflict flag. Pre-flight checks for canonical store presence + running `claude` processes. Safe to run any time.
- **`scripts/claude-shared-migrate.sh`** — dry-run-by-default migration. `--apply` writes changes; refuses to run with `--apply` if any `claude` process is alive (sessions-stopped invariant per ADR-141 §D5; `--force` overrides at operator's risk). Per-project: backup losing-side content to `_archive-<DATE>/`, move winner to canonical, symlink each account's path. Idempotent re-run.
- **Out-of-scope for this commit** — the dotfiles-repo deliverables (`_dotfiles/init-claude-shared.sh` + `_dotfiles/README-claude-shared.md`) and the actual migration execution + cross-account smoke test live in operator's dotfiles repo (`~/work/journals/.sb/_dotfiles`, sibling repo). Operator runs `scripts/claude-shared-migrate.sh --apply` with sessions stopped, then commits the canonical-store + init-script in the dotfiles repo separately.

### 🟢 Shipped — kanban auto-emit trunk-merge Task on Story-done (ADR-146 T2)

- **New `KanbanStory.branch` field** per [ADR-146](docs/adr/146-kanban-auto-files-trunk-merge.md) §D4 — source branch this Story's work lives on (typically `<base>-<member>` per ADR-082+084). Rides through the `extra` JSON column on the `stories` table; zero-migration roll-out.
- **`moveTask` hook** — when a Task's status transitions to `done`, if it's the last non-done child of a branched Story AND the team has `worktreeIsolation: true`, atmux auto-files a `merge t-xxx (branch→trunk): <source-branch> → trunk` Task per ADR-146 §D1+D2 — assigned to `gitter` (or per `autoEmitTrunkMerge.fallbackAssignee`). The auto-file lands in the SAME `BEGIN IMMEDIATE` transaction as the move-to-done write, so the ADR-032 task-done cascade wakes only after BOTH rows commit (no false-positive idle nudge per §Atomic).
- **Short-circuit rules** per ADR-146 §D5: Story without `branch` set, team without `worktreeIsolation`, `autoEmitTrunkMerge.enabled === false`, `Story.branch === team.merger.baseBranch` (when `shortCircuitOnSharedBase: true`), remaining non-done siblings, OR done-Task subject already matches the auto-emit pattern (loop-prevention) — any of these skip emit cleanly.
- **New `team.json::autoEmitTrunkMerge` config block** per ADR-146 §D7 — `enabled` (default `true` when `worktreeIsolation: true`, `false` otherwise), `fallbackAssignee` (default `null` = unassigned), `shortCircuitOnSharedBase` (default `true`). Strict-mode Zod block; typos rejected per ADR-054 §D3 drift detection.
- **Backfill script** at `scripts/backfill-story-branch.ts` — dry-run by default; `--apply` walks every Story with status `in-progress`/`testing`/`review`/`merging`/`done` and infers `<base>-<member>` from child-task owners when all children share a single declared member. Conservative (skips Stories with mixed owners or non-member owners — operator can hand-backfill via SQL). Idempotent; safe to re-run.
- **Out of scope this commit** — `atmux story update s-xxx --branch <b>` verb (deferred per OQ-1 to a future commit); cron-backstop trunk-merge (already handled by ADR-134 §state-machine cron path); `tested → merged` test-gate chaining (separate ADR per §D6).

### 🟢 Shipped — ADR-147 release-event verify (t-3b2d1a26, 2026-05-16) + `docs/RUNBOOK-deploy.md`

- **Release-event verify executed against fresh 0.8.0 install.** `atmux ombudsman tick` under the byte-equal cron env (`PATH=/root/.bun/bin:/usr/local/bin:/usr/bin:/bin TMUX_TMPDIR=<team-tmux-dir> ATMUX_DIR=<team-atmux-dir>`) returned `ombudsman tick: sentinel empty — no-op` (exit 0, steady state — no queued complaints). `atmux gitter --sweep` under the same env returned a rich dispatcher state-machine summary (`team='atmux' base='geoyws' checked=16 queued=1 refused=0 skipped=15`) with one fan-in queued (`geoyws-up-impl +1`). Both `<atmux-dir>/logs/{ombudsman,gitter-sweep}.log` had pre-install `atmux: unknown verb: …` lines through `May 16 06:00` (last 0.7.2 tick) — proves the ARMED-but-no-op → DRAINING flip happened exactly at 0.8.0 swap-in. ADR-135 resolver smoke also re-verified (this verify's `atmux send lead …` calls all exited 0 against the same `🧭-lead` window that 0.7.2 had failed on minutes earlier).
- **New `docs/RUNBOOK-deploy.md`** documents the build:install cut procedure (semver call → CHANGELOG roll → trunk commit → `bun run build:install` → push trunk) + the post-install release-event verify gate (--version round-trip → cron-env verb-presence smoke → cron-log tail proof → ADR-135 send-lead smoke) + one-line atomic rollback + trigger-discipline note for dispatch-only parking-lot Tasks (`⚠️ DO NOT CLAIM via claim --next` convention marker). Cross-refs ADR-047 / ADR-134 §T7 / ADR-147 / ADR-135.
- **Trigger-discipline reinforcement**: t-3b2d1a26's body opens with `⚠️ DO NOT CLAIM via claim --next` and supersedes a previously-closed `t-921deabc` whose looser body language caused a false self-claim 2026-05-16 06:08 MYT. The new RUNBOOK §Trigger discipline (parking-lot Tasks) captures the convention so future release-event parking-lot Tasks inherit the marker rather than reinventing.

### 🟢 Shipped — atmux 0.8.0 install (t-eda081cf, 2026-05-16)

- **Version bump `0.7.2 → 0.8.0`** (`package.json`) + `bun run build:install` cut a fresh binary to `/opt/atmux/0.8.0/bin/atmux` with atomic symlink swap (`/opt/atmux/current → /opt/atmux/0.8.0`; `/usr/local/bin/atmux` unchanged, still resolves through `current`). Rollback target preserved at `/opt/atmux/0.7.2/` (and earlier 0.3.0–0.7.1 dirs) — `sudo ln -sfn /opt/atmux/0.7.2 /opt/atmux/current` reverts in one line.
- **Minor bump rationale**: 0.8.0 packages four backward-compat surface additions accumulated since 0.7.2 (May-13) — `atmux gitter` verb (ADR-134 T9 production merge dispatcher), `atmux ombudsman` verb (ADR-147 T9 complaints sweeper), `atmux cron-install --template gitter-sweep` + `--template ombudsman-tick` options (ADR-134 T7), and the ADR-135 hyphenated-window-name resolver (closes the live `/usr/local/bin/atmux` failure mode `tmux: can't find window: 🧭lead`). No breaking removals — existing `cockpit.json.superdoctor` block still loaded via back-compat shim per ADR-133 (TR8 follow-up scheduled for next release per the existing `🚨 Coming next release` row below).
- **Deploy-time CHANGELOG note**: the bulk of this `[Unreleased]` block was authored against 0.7.2-as-baseline and SHOULD migrate into a formal `## [0.8.0] — 2026-05-16` named section per Keep-a-Changelog; deferred from this deploy commit to keep the diff scope narrow (release-cut housekeeping is a separate Task) — the per-section `🟢 Shipped` / `📋 Proposed` / `🏷️ Renamed` / `⚙️ Migration` / `⚠️ Deprecated` glyphs already encode shipped-vs-pending status in place.

### 🟢 Shipped — ADR-147 ombudsman + release-notes dogfood (T9) + SQLite legacy-DB rescue

- **ADR-147 status flipped `proposed → accepted`** ([docs/adr/147-ombudsman-and-release-notes.md](docs/adr/147-ombudsman-and-release-notes.md)) per its own T9 gate: atmux-team's `.atmux/team.json` gained an `ombudsman` member entry (`emoji: ⚖️`, `claudeAccount: personal`) + `ombudsman: { enabled: true, tickIntervalMins: 15 }` config block; `atmux start` spawned the ombudsman pane (window `⚖️-ombudsman`); ombudsman bootstrap-time drained the singleton open complaint (`c-7a308f7f` groom `--inbox-days` aging gap) by filing task `t-82b6aed9` (planner-routed) + resolving the complaint with cross-ref to ADR-154's SQLite migration; day-file `docs/release-notes/2026/05/2026-05-16.md` landed on `geoyws-ombudsman` @ `b68f2b4`. `atmux cron-install --template ombudsman-tick` installed the `*/15` cron line in the atmux team's crontab block (verified via `crontab -l | grep ombudsman`). End-to-end annotation table + dogfood findings appended to the ADR.
- **SQLite legacy-DB rescue (precursor commit `ed24844`)** — `fix(sqlite-migrations): legacy DB rescue + idempotent CREATEs`. Pre-T9 state.db was at `user_version=4` with `superdoctor_hygiene` present but `superdoctor_attempts` absent — the pre-renumber `v3→v4` (which was hygiene before the 2026-05-14 16:05 MYT renumber) ran, but the renumbered new `v3→v4` (attempts) never did. Worktree atmux crashed on every state.db open with `SQLiteError: table superdoctor_hygiene already exists` (sqlite-migrations.ts:218) which would have blocked every member running new-build atmux until `/usr/local/bin/atmux` is bumped. Fix: `IF NOT EXISTS` guards on v3→v4 (attempts) + v4→v5 (hygiene) `CREATE TABLE` + `CREATE INDEX`, plus a new `v6→v7` migration that re-runs the v3→v4 SQL idempotently to backfill the missing table on legacy DBs. 3 new tests in `tests/unit/abstractions/sqlite.test.ts` (legacy seeded state walks to highest version, fresh DB walks v0→highest, re-open is no-op) — 9 tests pass total, 100% line/func coverage on `sqlite-migrations.ts`. Live state.db now at `user_version=7` with both tables present.

### 🟢 Shipped — ADR-157 T6 e2e goal-primary-drain + failure-injection matrix

- **New e2e** at `tests/e2e/goal-primary-drain.test.ts` per ADR-157 T6 (`t-869a0226`). Deps T3 (`05e9b9c`) + T4 (`33f995c`) + T5 (`675600b`) all shipped this session. Validates the full /goal-primary-drain wiring end-to-end across the lane-tick + goal-injection + cron-cadence stack via the `LaneTickDeps` dependency-injection seams (no real tmux / no real Anthropic API for the CI default path).
- **Mock-default + ATMUX_E2E_LIVE=1 opt-in** per task body. Live mode is a placeholder pending real Claude Code pane availability with `/goal` skill (v2.1.139+); CI runs the mock matrix sub-second.
- **Cell 1 — Latency benchmark (structural proxy)**: 5-tick treatment vs baseline. Treatment (goal-active claude) → 5/5 `skip-goal-active` outcomes, ZERO send-keys fired (drain handled by /goal evaluator). Baseline (goal-inactive claude) → 5/5 `injected` outcomes (cron-driven claim-injection). Ratio assertion 0:5 proves the wiring is correct — real wall-clock latency is sub-second in treatment (when wired to a live Haiku evaluator) and ~150s mean in baseline at the */5 cron cadence T5 ships.
- **Cell 2 — Failure-injection backstop (3 cases)**:
  1. Rate-limit pane → `skip-not-ready` (NOT `skip-goal-active`) — pane-health signal preserved per T4 reviewer pre-flag #1 ordering.
  2. Dead-pane / shell prompt → `skip-not-ready` — lane-tick is the external observer.
  3. Compaction-wipe simulation → `skip-not-ready` — DOCUMENTED as **Branch A-prime** in the spec header: neither "still skip claim-injection" (A) nor "fall back to claim" (B), but "skip via pane-health, defer to operator-driven `atmux rotate` recovery." If operator experience reveals this is too operator-heavy (auto-rotation desired), file an ADR-157 amendment to wire a rotate-on-compaction-detected hook.
- **Cross-check** — Cursor carve-out (§D4) cross-check at e2e level: `runtime: "cursor"` + `goal` set → claim-injection RUNS (cursor has no /goal skill; cron is the only drain). Confirms T4's runtime-gate honors §D4 contract under e2e wiring, not just at unit level.
- **Spec header docstring documents non-idempotence** per CLAUDE.md §Testing Discipline ("Stateful e2e specs are not repeatable smokes"). Each cell stages a fresh tmpdir + tmpdir-scoped `team.json` + `state/session.txt`. No live `~/.atmux/cockpit.json` reads, no live `~/.atmux/state/*` writes — reviewer pre-flag honored.
- **`setDefaultTimeout(120_000)`** per CLAUDE.md bun-test integration rule. Mock mode actually runs sub-second; the headroom is for the cell-scaffold tmpdir creation.
- **Tests**: 7/7 pass + 1 skip (live mode placeholder). Typecheck clean.
- **ADR-157 EPIC code-path scope COMPLETE this session**: T1 draft (`fa5d9c7`) → T2 schema/resolver (`8bbf28c`) → T3 injection (`05e9b9c`) → T4 lane-tick narrow (`33f995c`) → T5 cadence relax (`675600b`) → T6 e2e (this commit). T7 (dogfood, gated on ADR-151 unblocker landing) is the only remaining sub-task.
- **Out of scope**: dogfood on atmux team (T7 — `t-6f8d27e8`, gated on ADR-151 unblocker `t-fba73bf8`); cross-team /goal coordination (not in v1); Cursor-side /goal equivalent (no upstream skill); ATMUX_E2E_LIVE wired against real Claude Code pane (deferred — operator validation gate).

### 🟢 Shipped — ADR-157 T5 cron cadence relaxation `*/2` → `*/5` (lane-tick)

- **Cron template lane-tick cadence relaxed from `*/2 * * * *` to `*/5 * * * *`** per ADR-157 T5 (`t-e847d0ae`). Closes the EPIC's drain-mechanism shift: T3 (/goal injection) + T4 (lane-tick goal-narrow) together mean Claude members drive their own loop via the per-turn Haiku evaluator; lane-tick narrows to a structural backstop for failure modes /goal cannot see (wedged panes, rate-lockouts, compaction-wipe). Sub-2-min cadence is no longer needed.
- **Per-team override `team.crons.laneTickMins`** (sibling to `laneTickEnabled`, mirrors the ADR-148 cadence-knob pattern). Optional; default `5` (new constant `DEFAULT_LANE_TICK_CRON_MINS`). Schema-side refinement REJECTS non-divisors of 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60); `cronEvery` rejects non-divisors as a second line of defense.
- **Lower bound floor** is /goal mean-time-to-detect-failure × 2 (~5min); **ceiling** 10min acceptable with operator validation. Teams that want the pre-T5 fast cadence can opt into it explicitly via `crons.laneTickMins: 2` — backward-compat path verified by test.
- **Operator-facing migration**: existing atmux deployments pick up the new cadence on next `atmux start` / `atmux cron-install` — the cron-block re-install logic replaces the previous `*/2` line idempotently. No code-path semantic change; same lane-tick verb, same logic, just longer interval. T4's skip-branch is what makes the relaxed cadence safe.
- **Tests**: 18 new tests pass — 4 in `tests/unit/core/cron.test.ts` (default `*/5` emit + `*/10` override + `*/2` backward-compat override + the existing test renamed/updated) + 8 in `tests/unit/schema/team.test.ts` (default-5 / explicit-10 / explicit-2 / non-divisor-7 rejected / non-divisor-8 rejected / zero+negative rejected / non-integer rejected / Team.parse round-trip). Full regression run: 216/216 pass on `cron.test.ts` + `team.test.ts`. Typecheck clean.
- **Out of scope**: lane-tick goal-narrow skip-branch (T4 — shipped 33f995c, structural prereq satisfied); /goal injection (T3 — shipped 05e9b9c); e2e (T6); dogfood (T7).

### 🟢 Shipped — ADR-157 T4 lane-tick goal-narrow + 3-safety-net preservation

- **`src/verbs/lane-tick.ts` goal-skip branch** per ADR-157 T4 (`t-e8ad0db5`). Claim-injection (`atmux claim --next --as <member>`) is now SKIPPED for goal-active Claude members; lane-tick narrows to a structural backstop for failure modes `/goal` cannot see (wedged panes, rate-lockouts, compaction-wipe). New `LaneTickMemberOutcome` literal `"skip-goal-active"`.
- **Goal-skip ordering (reviewer pre-flag #1)**: skip-branch lands AFTER the READY classification + AFTER the lead-ctx-rotate override. Wedged goal-active members surface as `skip-not-ready` (the pane-health signal), NOT `skip-goal-active` — operators see dead-pane issues even when /goal is set. Goal-active leads still receive `/team rotate-lead` nudge when ctx ≥ threshold (lead can't self-rotate via /goal).
- **Cursor carve-out (ADR-157 §D4)**: members with `runtime: "cursor"` short-circuit BEFORE goal resolution — claim-injection continues unchanged. Cursor CLI has no /goal equivalent so the cron-driven nudge stays the only drain for those panes.
- **Three safety nets PRESERVED verbatim per ADR-157 §D5**:
  - **#1 auto-done sweep** (`runAutoDoneScan`) — fires AFTER per-member loop for ALL members regardless of goal-state.
  - **#2 lead-ctx-rotate nudge** — fires ABOVE the goal-skip branch for ALL leads regardless of goal-state. Verified: `isRotateNudge: true` bypasses the goal-active early-exit.
  - **#3 dead-pane / rate-limit detection** — fires ABOVE via `skip-not-ready` classification. Wedged goal-active members surface as pane-health issues, not masked as goal-skipped.
- **Operator-debuggable skip log (Task body §3)**: `[lane-tick] skip claim-inject for <member>: goal-active (resolved-via=team.json|brief)`. Source attribution (team.json explicit vs brief Standing Goal) makes goal-phrasing bugs easy to trace.
- **Goal-resolver failure fallback**: if `resolveGoalForMember` throws (corrupt brief, permission denied), the helper falls through to existing claim-injection path with a WARN log. Conservative — drain stays healthy; operator sees the warn rather than a silently-skipped member.
- **Summary log line extended**: `lane-tick: visited=N ... skip-goal-active=M` for cron-log grep.
- **Tests**: 9/9 pass on `tests/unit/verbs/lane-tick-goal-narrow.test.ts`. Full 5-cell matrix per task body (goal-active+claude SKIPPED / goal-active+cursor RAN / goal-active+dead-pane → skip-not-ready / goal-inactive RAN / goal-inactive+dead-pane → skip-not-ready) + 3 safety-net assertions (lead-ctx-rotate over goal-skip / auto-done independence / dead-pane priority) + goal-resolver failure fallback. Typecheck clean. 28/28 existing lane-tick tests still pass.
- **Out of scope**: cron cadence change (T5 — `t-e847d0ae`, structural prereq satisfied by this commit); /goal injection (T3 — shipped 05e9b9c); e2e (T6).

### 🟢 Shipped — ADR-157 T3 `/goal` injection hooks (rotate + start)

- **`/goal` injection wired into `src/verbs/rotate.ts` + `src/verbs/start.ts`** per ADR-157 T3 (`t-c89ead5f`). Both call sites delegate to a shared helper `injectGoalIfActive` in `src/core/goal-injection.ts` (Task body §2 deduplication mandate). Brief-paste ordering preserved: `/goal` fires AFTER `bootClaudeMember` / `pasteBriefForMember` completes (reviewer pre-flag #2 — no injection into a busy compose box).
- **Per ADR-138**: injection routes through `safeSendKeysWithVerify` with `composerEmpty()` verifier — NEVER raw `tmux send-keys`. Re-uses the universal post-Enter signal (slash-command acceptance clears the composer the same way prompts do; same verifier `verifierForTui("claude")` already returns). NO new verifier added — composer-empty covers the slash-command acceptance signal without inventing a goal-specific pattern.
- **Cursor-runtime carve-out (ADR-157 §D4)**: members with `runtime: "cursor"` short-circuit before goal resolution — no `/goal` fired, no brief read wasted. Returns `{ fired: false, reason: "runtime=cursor" }`.
- **Goal resolution**: delegates to `resolveGoalForMember` from ADR-157 T2 (single source of truth). Resolution chain `member.goal` explicit > brief `## Standing Goal` section > null. Empty-string opt-out preserved.
- **Idempotent re-fire**: Claude TUI overwrites the goal silently on a second `/goal` call — re-firing is harmless. Helper logs but does not skip (Task body §4 — simpler than tracking state).
- **Failure semantics (reviewer pre-flag #3)**: verify-failed injection escalates to `send-keys-failures.log` per ADR-138 + helper returns `{ fired: false, reason: "verify-failed" }`. Rotation / cold-spawn pipeline does NOT abort — lane-tick backstop (T4) must still apply to goal-set-but-injection-failed members so the drain isn't deadlocked.
- **Goal-text quoting**: payload is `/goal "<text>"` with embedded `"` chars escaped (`\\"`). Multi-word goals land as a single quoted argument; matches the user-facing `/goal "<text>"` form.
- **Tests**: 7/7 pass on `tests/unit/core/goal-injection.test.ts` + 100% line coverage on `goal-injection.ts`. Full 5-cell matrix from task body (member.goal-set+claude / brief-parsed+claude / runtime=cursor SKIPPED / no-goal SKIPPED / verify-timeout escalates) + 2 edge tests (empty-string opt-out, embedded-quote escaping). Typecheck clean. 124 existing rotate+start tests still pass; 5 pre-existing failures verified unrelated via git stash.
- **Out of scope**: lane-tick narrowing (T4 — `t-e8ad0db5`); cron cadence change (T5 — `t-e847d0ae`); e2e (T6); dogfood (T7).

### 🟢 Shipped — ADR-157 T2 schema + goalResolver helper

- **`Team.members[].goal: z.string().optional()` field** + **`Team.members[].runtime: z.string().optional()`** added to `src/schema/team.ts` TeamMember per ADR-157 T2 (`t-b5b0678e`). Additive optional — back-compat verified (existing teams without these fields parse unchanged). Field JSDocs cite ADR-157 §D2 (resolution chain) + §D4 (cursor runtime carve-out) + §Decision-anchor #1 (goal-phrasing-rule).
- **New `src/core/goal-resolver.ts` module** — single source of truth for "what is this member's standing goal?" Consumed by T3 `/goal` injection hooks + T4 lane-tick narrowing (both forthcoming). Exports:
  - `resolveGoalForMember(member, briefPath?): Promise<string | null>` — resolution chain per ADR-157 §D2 / §OQ3: `member.goal` explicit > `templates/briefs/<role>.md ## Standing Goal` section > `null`. Empty-string member.goal = explicit opt-out (returns null without consulting brief).
  - `parseStandingGoalFromBrief(briefText): string | null` — case-sensitive anchored regex `## Standing Goal` (no trailing colon) per T2 reviewer pre-flag. Multi-line capture until next markdown heading or EOF.
  - `validateGoalRuntime(member): string | null` — WARN-not-refuse helper. Returns one-line WARN string when `runtime === "cursor"` AND `goal` set non-empty (partial-migration no-op case); null otherwise. Zod doesn't have a first-class WARN severity; loader-side warning surface uses the return value.
- **Tests**: 19/19 pass + 100% line coverage on `goal-resolver.ts`. 5-cell resolution matrix per task body (explicit-wins / brief-parsed / brief-missing-section / graceful-degrade / empty-string-opt-out) + runtime-gate WARN matrix + schema back-compat smoke (existing TeamMember without goal/runtime parses unchanged).
- **Out of scope**: `/goal` injection hooks (T3 — `t-c89ead5f`); lane-tick edits (T4 — `t-e8ad0db5`); cron cadence change (T5 — `t-e847d0ae`); e2e (T6); dogfood (T7).

### 🟢 Shipped — cross-team `atmux tell-lead --team <name>` (ADR-092)

- **New `--team <name>` flag on `atmux tell-lead`** per ADR-092 T1 (`t-5f20ba85`). Driver / parent-team / child-epic-team can now route a `tell-lead` ask into another team's inbox in the cockpit tree without `cd`-ing into the target's worktree. Closes the ADR-091 epic-merge conflict-surface gap (T12 migration deferred to its own commit per ADR-092 §Out-of-scope).
- **Cockpit-walk resolution (D1)**: `--team <name>` does a depth-first match on `cockpit.sessions[].name`; resolves target's `root` (own for `type: "team"`, nearest-ancestor `team.root` for `type: "epic-team"`), `team.json`, cage socket via `resolveTeamSocket`, and lead window. Default (no flag): existing cwd-derived single-team path is **byte-identical** to pre-ADR-092 behavior (Decision-anchor #1 — no regression on the hot path).
- **`findTeamByName(cockpit, name): CockpitTeamLookup | null` helper (D2)**: new pure export from `src/core/cockpit.ts`. Reuses existing `walkSessions` DFS walker. Returns the first matching `team` / `epic-team` node (other session types — superdriver, medic, martinet — skipped). Name-collision is operator error per Decision-anchor #2; lookup is deterministic on DFS order.
- **`callerScopeAllowed(cockpit, src, tgt, scope): boolean` gate (D3)**: symmetric four-case policy table — (a) `ATMUX_CALLER_SCOPE === "driver"` master override, (b) same-team trivially allowed, (c) child-epic-team → parent allowed, (d) parent → child-epic-team allowed. Siblings under same parent + unrelated teams refused (must route via parent). Refusal text names both ends per Decision-anchor #5 so operators see the policy violation root, not a generic "scope refused."
- **`ATMUX_CALLER_SCOPE` env var (D3 / Decision-anchor #4)**: exact-match — no `ATMUX_SCOPE` shorthand, no `--scope` flag-form (env-only). Cockpit driver pane sets it once on bootstrap; member panes do NOT inherit it (cage-tier boundary per ADR-058).
- **Socket resolution respects nested cages (D4)**: cross-team heads-up loads target `team.json` directly + calls `resolveTeamSocket(targetTeam)` — no path-construction from source-cage state (Decision-anchor #6 reviewer pre-flag enforces no parent-cage-prefix leak).
- **Tests**: 13 unit tests in `tests/unit/core/cockpit.test.ts` for findTeamByName (depth-3 fixture + own-root vs parent-root + DFS deterministic match + leaf-type skip + null on miss) and callerScopeAllowed (full 7-case matrix: driver / same-team / child→parent / parent→child / siblings-same-parent / siblings-diff-parent / unrelated / unknown). 3 unit tests in `tests/unit/verbs/tell-lead.test.ts` for `--team` flag parsing (populate / missing-value error / bare-invocation fast-path preserved).
- **Out of scope**: member-to-member cross-team messaging (separate `atmux send --team` Task if needed); `atmux doctor` D8 / D9 cross-team-routing health checks (Task `t-c2e544b6` — sibling e2e); sibling-epic-team direct routing (refused per D3 — must route via parent); ADR-091 T12 conflict-surface migration (referenced for traceability; separate commit).
- **Cross-refs**: ADR-089 (`walkSessions` DFS substrate — load-bearing primitive), ADR-090 (epic-team lifecycle; forward-reference — `epicTeam.parent` linkage), ADR-091 (epic-merge conflict-surface; forward-reference — first consumer), ADR-029 (tell-lead bash spec — byte-equal contract preserved on default path), ADR-058 (cage tier; forward-reference — Tier-1 boundary respected), ADR-099 (error-handling — `EX_NOPERM=77` for refusal).

### 🟢 Shipped — `atmux blockers list` unified verb fans across 7 surfaces (ADR-152)

- **New verb** `atmux blockers list [--json] [--class <c>] [--source <s>] [--max-age <duration>]` per ADR-152 T1 (`t-8f3061ef`). Closes complaint `c-1d28fc72` (driver-claude-sopx /bruh sweep 2026-05-15). Foundation for ADR-151 unblocker (`t-fba73bf8`) — single queryable signal source replaces the operator memory-load that grew with team size and compounded across rotations.
- **Fans across 7 surfaces** (no storage migration — markdown stays markdown, SQLite stays SQLite; only joins reads): SQLite tables `tasks` (status=blocked, status=in-progress past `stale_min`), `complaints` (status=open), `merger_state` (state in conflict|reverted) + markdown `decisions.md` (unstruck sections) `flags.md` (open flags w/o resolution rows) `driver-inbox.md` (🔵/⏳/📤 glyph entries OR un-glyphed past stale-age).
- **Normalized row shape** `BlockerRow {id, source, opened_at, age_sec, summary, blocker_class, suggested_action, related_task_id?}`. `id` surface-prefixed (`task:t-...`, `flag:f-...`, `merger:<branch>`) for cross-surface uniqueness. `suggested_action` carries an imperative one-liner (≤200 chars) the unblocker / operator can act on directly.
- **`blocker_class` taxonomy (D3, eight classes)**: `decision-pending` · `member-stuck` · `cross-lane-WIP` · `tooling-broken` · `stale-claim` · `dep-not-shipped` · `review-pending` · `push-policy-gate`. Per-surface defaults documented in ADR §D3 table; markdown surfaces lift class from leading-emoji glyph (🔵 → decision-pending, ⏳ → review-pending, 📤 → stale-claim, 🛠️ → tooling-broken, 🚫 → push-policy-gate, 🔁 → cross-lane-WIP) OR explicit `[class:X]` token (token wins).
- **Class derivation for SQLite surfaces**: blocked tasks → `dep-not-shipped` when any dep not done, else `member-stuck`. Stale in-progress tasks → `stale-claim` (default 24h, per-task `stale_min` override). Open complaints → `tooling-broken` default; lift from `extra.blocker_class` JSON field (forward-compat). Stuck merger_state → `tooling-broken` (conflict) or `push-policy-gate` (reverted).
- **CLI**: `--json` for unblocker + dashboard machine consumption (NO isatty auto-detection — explicit flag avoids SSH/CI footgun); `--class` / `--source` filters for surgical operator queries; `--max-age` accepts suffix-form (`30m`, `2h`, `7d`) or bare seconds.
- **Per-surface helpers exported** (`readBlockedTasks`, `readStaleInProgressTasks`, `readOpenComplaints`, `readStuckMergerState`, `readPendingDecisionsMd`, `readOpenFlagsMd`, `readDriverInboxBlockers`) so unblocker + tests can exercise each in isolation. `queryAllBlockers(atmuxDir, db, opts)` is the verb-facing fan-out; `nowSec` injectable for deterministic tests.
- **Markdown parsers regex-based** — formats are already consistent (the producing verbs enforce them). Reviewer blocks future format drift that doesn't update both producer + `src/core/blockers.ts` consumer in same commit.
- **Unit tests**: per-surface helper tests + integration test seeding all 7 surfaces in a temp dir + asserting row-count, class-mapping, source attribution, and cross-surface ID uniqueness (`ids.size === rows.length`).
- **Out of scope this commit**: lead-outbox.md as 8th source (already surfaced by `atmux outbox`); cross-team blockers fan-out (cockpit-tier concern); auto-promotion (driver-inbox → flag at 12h — separate ADR-153); action execution (unblocker's job per ADR-151); `atmux blockers add/resolve` (resolutions go through per-surface verbs).
- **Cross-refs**: ADR-060 (kanban SQLite canonical), ADR-077 §F2 (complaints), ADR-134 (merger_state), ADR-008 (decisions verb), ADR-022 (flags), ADR-057 §D2 (driver-inbox parser), ADR-151 (unblocker — primary consumer), ADR-148 (sibling single-canonical-truth-signal pattern). Complaint `c-1d28fc72` closed.

### 📋 Proposed — `team.json.autonomy` shared policy block (ADR-166)

- **New ADR drafted** at [docs/adr/166-team-autonomy-policy.md](docs/adr/166-team-autonomy-policy.md) (Status: `proposed`) per EPIC `t-99b85ee9` T1 (`t-446cc619`). Rejects the 2026-05-15 19:02 MYT operator `whip → bruh` rename proposal — instead lifts the per-team **aggression dial** (the actually-shared concern) into ONE shared policy block consumed by all action-class actors (martinet / `/bruh` skill / gitter / reviewer), leaving each role's mechanics where they are.
- **Slot-history (this re-slot is itself the case study)**: planner reserved **ADR-151** for autonomy-policy; sibling `t-b0e6c4ff` shipped `docs/adr/151-unblocker-role.md` on `geoyws-docs-2` (`fabbf30`, 2026-05-15 22:26 MYT) collapsing the slot. Driver routed re-slot to **ADR-165** via `/bruh #5` 2026-05-16 22:38 MYT; by 23:00 MYT ADR-165 had also shipped via my own `t-85b928a9` (atmux team config CLI, `7cdd886` — different topic). Applied lead/driver intent ("next clean gap") to current state — landed at **ADR-166** with full slot-history annotation. Per `[[feedback_pre_claim_verify_protocol]]` no duplicate-slot file was ever written; append-only convention preserved across both prior occupants.
- **Block keys (D3, 7-shape verbatim from EPIC body, reviewer-overridable at signoff)**: `autoMerge: 'off' | 'trunk-merge-tasks' | 'all'` (gitter consumer; default `'trunk-merge-tasks'` per ADR-145); `autoApproveDecisions: boolean` (bruh + martinet event-handler; default `true`); `autoFlipFlags: boolean` (bruh; default `true`); `autoReanimateZombies: 'off' | 'lead-only' | 'all-members'` (bruh + martinet; default `'all-members'`); `autoRotateMembers: 'off' | 'ctx-pressure' | 'ctx-or-stale' | 'all'` (martinet + bruh cascade; default `'ctx-or-stale'`); `autoFileFollowUps: boolean` (martinet; default `true`); `bruhScope: 'narrow' | 'sweep'` (bruh; default `'sweep'`).
- **D4 operator override semantic**: `/bruh` ALWAYS sweeps regardless of policy — the block governs AUTOMATED paths only; deliberate operator action supersedes. Implementation note: `/bruh` skill must distinguish operator-typed invocations from sibling-skill invocations via env-marker.
- **D5 backward compatibility**: missing block defaults all-auto-enabled (today's behavior preserved verbatim across every key). Migration is purely additive — no schema bump, no data migration. Existing per-role aggression toggles (`team.autoMerge.enabled` etc.) coexist for one release window, then deprecate with hard-error pointing operators at the autonomy block.
- **D7 sibling config block pattern** (per ADR-148): `autonomy` joins the family of team-level config blocks alongside `whip` / `cadence` / `eternalImprovement` etc. Zod `.strict()` sub-object (drift-rejection per ADR-054); mirror in `src/schema/cockpit.ts` for `defaultAutonomy` fleet-defaults; resolver helper mirrors `resolveEternalImprovementEnabled` cascade per ADR-149 verbatim.
- **§Reuse statement explicit on zero new abstractions** — schema extension + Zod mirror + cascade resolver + existing consumers + reuse of ADR-165's `atmux team set` CLI for operator edits. All plumbing on top of existing patterns.
- **Cross-refs**: ADR-013 (reviewer), ADR-077 (medic — complaint-handling consumer), ADR-132 (martinet `NudgeAction`), ADR-140 (cheap-model-first — frames why `whip→bruh` rename is unnecessary), ADR-145 (gitter `autoMerge`), ADR-148 (sibling config block pattern), ADR-165 (CLI-surface dep — `/bruh` consumes `atmux team get autonomy.<key>` once ADR-165 T3 lands).
- **Out of scope this commit**: per-member overrides; time-of-day windows; cross-team inheritance via super-driver (ADR-274 concern); time-bounded one-shot overrides; T2 schema impl; T3 consumer wiring; T4 `/bruh` skill update; T5 doc sweep; T6 e2e — sub-task filing is parent EPIC's responsibility per Task body's explicit "T1 ships ADR file ONLY" boundary.

### 📋 Proposed — `atmux team set/get/unset` CLI for `team.json` config edits (ADR-165)

- **New ADR drafted** at [docs/adr/165-atmux-team-config-cli.md](docs/adr/165-atmux-team-config-cli.md) (Status: `proposed`) per EPIC `t-2deb17f0` T1 (`t-85b928a9`). Closes the manual-JSON-edit fragility flagged 2026-05-16 08:07 MYT (driver flag: *"had to bypass atmux to flip `team.json.autoMerge.enabled` (null → true) because no CLI verb exists for it."*). Pre-flight verified: ADR-164 slot taken by `t-846e43dd` (sync claude-team-json); 165 + 166+ clean — resolved to 165.
- **Verb namespace (D1)**: three sub-verbs under existing `team` namespace — `atmux team set <dot.path> <value>` / `team get <dot.path>` / `team unset <dot.path>` — plus `--no-backup` / `--no-audit` / `--force` / `--dry-run` flags.
- **Schema gate (D2)**: every mutation Zod-validates the post-mutation object via `Team.parse()`; refuse-with-stderr on validation failure (fail-closed). `--force` is the migration escape hatch for files already schema-drifted at v1 cutover; audit-log records `caller_scope: "forced"`.
- **Atomic write (D3)** reuses ADR-098's `atmux::jq_update` primitive verbatim — flock sidecar (`team.json.lock`) + tempfile in same dir + `fs.rename`. Permissions preserved across the rename. Same lock that whip + ts-side `updateJson` already use; no new lock-ordering concern.
- **Backup default-on (D4)** snapshots pre-mutation state to `.atmux/team.json.bak.<epoch>`; `--no-backup` opt-out. Pruning delegates to existing `atmux groom --keep-bak N` (default 5) — no new pruning logic.
- **Audit-log NDJSON (D5)** appends `{ts, key, op, old, new, caller_scope, forced}` to `.atmux/logs/team-config-mutations.jsonl` per mutation. Append-only in v1; ~150KB/year/team estimate. `--no-audit` opt-out.
- **Dot-path = JSON-Pointer-lite (D6)**: `autoMerge.enabled` → `team["autoMerge"]["enabled"]`; numeric segments index arrays (`members.0.role`). Keys-containing-dot are out of v1; future escape grammar if needed.
- **Type coercion (D7)**: `true`/`false`→bool, `null`→null, int/float regex, `{...}`/`[...]`→JSON, `"..."`→quote-stripped string, else string. Zod gate is final arbiter.
- **Migration story (D8)**: no automatic schema-drift migration in v1. Operators inspect via `get` (which does NOT round-trip Zod per OQ-1), fix drift manually OR via `--force`, then re-run without `--force` once gate passes.
- **3 OQs with recommended defaults**: get-Zod-roundtrip (defer — raw JSON print); unset-of-required-field (refuse; --force bypasses); audit-log location (`.atmux/logs/` per ADR-147 convention).
- **Cross-refs**: ADR-054 (strict-mode schema — note: 054 file itself is a ghost-ADR similar to pre-`t-75a79d7c` ADR-052; out-of-scope follow-up to backfill), ADR-098 (JSON + locking primitive — reused verbatim), ADR-076 (kanban→SQLite — boundary marker; this verb governs JSON-resident state only), ADR-148 (commit-cadence — config edits NOT git commits, no cadence advance), ADR-097 (tmux abstraction — named by Task body for completeness; not load-bearing).
- **Out of scope this commit**: cross-team batch edits; diff-based / JSON-patch edits; secret handling; `atmux cockpit set/get/unset` sibling verb (same pattern, separate Task); `atmux team migrate` automated rename verb; SQLite-resident state mutations. T2-T6 (impl + tests + docs + e2e) per the §Implementation plan table; sub-task filing is the parent EPIC's responsibility.

### 📋 Proposed — `/goal` as primary drain for Claude service-loop roles (ADR-157)

- **New ADR drafted** at [docs/adr/157-goal-as-primary-drain.md](docs/adr/157-goal-as-primary-drain.md) (Status: `proposed`) per EPIC `t-3c1aab98` T1 (`t-a5b01d24`). Operator-authorized 2026-05-16 00:55 MYT (*"let's remove the lane tick for claudes then and make sure that we use goal instead"*) + driver hybrid-recommendation accepted (`/goal`-primary + lane-tick-backstop). Wires Claude Code v2.1.139+ `/goal` skill as the PRIMARY drain mechanism for Claude service-loop roles (gitter, unblocker, reviewer, lead, ombudsman); narrows lane-tick to a structural BACKSTOP for failure modes the per-turn Haiku evaluator cannot see (wedged panes, rate-lockouts, compaction-wipe).
- **Schema (D2)**: additive optional `team.json.members[].goal: z.string().optional()`. Presence is the gate for the lane-tick skip-claim-injection branch (no pane scan needed). Resolution chain: `team.json` explicit override > `templates/briefs/<role>.md ## Standing Goal` brief-source default.
- **Per-role goal phrasings (D3, load-bearing)**: gitter `"All members' branches are merged to trunk and trunk typechecks green"`; unblocker `"Kanban.status=blocked column is empty"`; reviewer `"No commit in last 24h is unreviewed"`; lead `"All members have a commit in last 30min AND no member is over ctx-threshold"`; ombudsman `"complaints/ sentinel queue is drained"`. Each MUST be unsatisfiable in steady state AND re-satisfy on real-world regression — reviewer pre-flag at every goal addition (failure-mode example: gitter goal without the trailing `"AND trunk typechecks green"` halts indefinitely).
- **Cursor-CLI carve-out (D4)**: members with `runtime: "cursor"` (martinet via ADR-132 + ADR-140) do NOT get `/goal` — Cursor CLI has no equivalent skill. Both `/goal` injection hooks AND lane-tick skip-claim-injection branch short-circuit on `runtime === "cursor"` (structural, not advisory).
- **Lane-tick narrowing (D5)**: skip claim-injection for goal-active non-cursor members; RETAIN three safety-net functions verbatim — (a) ADR-080 §B2 auto-done sweep, (b) ADR-080 §A2 lead-ctx-rotate nudge, (c) dead-pane / rate-limit-lockout detection + logging (escalation signal for medic/canary).
- **Cron cadence (D6)**: `*/2` → `*/5` recommended target; `*/10` ceiling iff validation shows `/goal` mean-time-to-detect-failure × 2 ≥ 5min. Lower bound floor is `/goal` failure-detection latency.
- **Injection via `safeSendKeysWithVerify` per ADR-138 (D7)**: NOT raw `tmux send-keys`. Verification confirms the slash-command was actually accepted by the TUI rather than eaten by a modal or compose-box-already-occupied state.
- **OQ1 (compaction-survives-`/goal`) is LOAD-BEARING** per lead 01:12 MYT note. Branch A (compaction preserves goal): cadence relaxes to `*/5` default; backstop optional. Branch B (compaction wipes goal): cadence stays `*/5` mandatory; backstop is structural failover, not optional. Verify before committing default. OQ4 (gitter-goal + ADR-145/ADR-134 cron interaction) RESOLVED orthogonal — `/goal` halts service-loop, cron-driven sweep is unaffected.
- **Cross-refs**: ADR-138 (verified send-keys — load-bearing dep), ADR-080 (lane-tick substrate — narrow not remove), ADR-145 (gitter-pattern — `/goal` interaction), ADR-134 (in-team auto-merger — cron orthogonality), ADR-132 + ADR-140 (martinet cursor carve-out), ADR-151 (unblocker — first goal-driven consumer), ADR-148 (cadence-as-canonical-truth — `/goal` latency informs new cadence baseline).
- **Slot-ledger note**: originally drafted as ADR-156; re-slotted to ADR-157 per lead 01:08 MYT — t-20674483 (medic→canary rename) had pre-existing planner reservation on 156 in same /bruh-sweep-4 window.
- **Out of scope this commit**: execution slices T2 (schema + loader, `t-b5b0678e`), T3 (rotation + cold-spawn hooks, `t-c89ead5f`), T4 (lane-tick narrow, `t-e8ad0db5`), T5 (cron cadence change, `t-e847d0ae`), T6 (e2e + failure-injection, `t-869a0226`), T7 (dogfood gated on ADR-151 unblocker `t-fba73bf8`, `t-6f8d27e8`) — same-session decomp per `[[feedback_decomp_same_session_with_deps]]`. ADR is doc-only this commit.

### 📋 Proposed — `unblocker` in-team role (ADR-151)

- **New ADR drafted** at [docs/adr/151-unblocker-role.md](docs/adr/151-unblocker-role.md) (Status: `proposed`) per EPIC `t-fba73bf8` T1 (`t-b0e6c4ff`). Integrates the four sibling /bruh-sweep drafts (ADR-152 blockers-list + ADR-153 auto-promotion + ADR-154 SQLite storage + ADR-155 pane-state verb) into a coherent in-team role contract. Each sibling produced a structured signal; ADR-151 names the consumer that drains them.
- **Required in-team role (D1)**: `team.json::requiredRoles` extended (additively) to include `"unblocker"`. New teams default-include; existing teams log warn-class deprecation for one release, then hard-error at `loadTeam`. Epic-team carve-out per ADR-090: epic-teams reuse parent's unblocker via cross-team complaint path. Per planner-anchor #1.
- **Opus model (cheap-model-first carve-out)**: per ADR-140 + planner-anchor #2 + `[[feedback_opus_all_for_agile_flow]]` memory. Classification + write-side authority is judgment work; martinet (cheap-tier) observes, unblocker (Opus) acts. The two compose.
- **In-team cage, not cockpit-W4**: per operator framing 2026-05-16 00:09 MYT ("busy + triage + has to live within teams"). Cross-team failures already have a path (complaint → sibling ombudsman); a cockpit-layer role would duplicate martinet (ADR-132) and pay round-trip context cost. Sibling cage residents (lead / planner / reviewer / docs / gitter / qa / ombudsman) gain one peer.
- **Drain loop — hybrid (D3)**: martinet sentinel-routed primary path (`.atmux/state/unblocker-pending.json` written by ADR-132 observe loop; filesystem-watch + 60s polling fallback) + whip-cycle backstop (15min cadence runs `atmux blockers list --class member-stuck,stale-claim,tooling-broken` and picks oldest unclaimed). Neither pure-event-driven nor pure-polling; backstop covers the (rare) cases martinet misses.
- **Authority matrix (D4)**: MAY triage / reanimate dead panes IN-TEAM (via ADR-138 verified send-keys when `runtime_state=dead` per ADR-155) / mutate kanban `blocked → todo` with audit note / file complaints via ombudsman (ADR-147) for cross-team root causes. MUST NOT move `blocked → done` (original owner ships) / reanimate cross-team panes (martinet) / approve-reject commits (reviewer).
- **Boundary with ombudsman (D5)**: disjoint surfaces — unblocker on `tasks WHERE status='blocked'`, ombudsman on `complaints WHERE status='open'`. Overlap resolved by artifact ownership: complaint adjudication → ombudsman; kanban-row resolution → unblocker. ADR-153 R1 auto-resolves the complaint when unblocker resolves the underlying blocker; no coordination handoff between the two roles.
- **Lane-respect window (D6)**: `team.unblocker.laneRespectMinutes ?? 30` — unblocker waits before acting on a Task whose owner's lane could plausibly fix it. Forced-pickup override when ADR-153 R1 fires (24h threshold = members' lane gave up). Tunable per team; default revisited after one month of dogfood metrics.
- **Spawn integration (D7)**: standard `start.ts` provisioning when role appears in `requiredRoles`; window name `🩹-unblocker` per ADR-135 convention; brief template at `templates/briefs/unblocker.md`; emoji 🩹 chosen for visual distinction from gitter 🌿 / reviewer 🛡 / lead 🧭 / planner 🗺 / ombudsman ⚖ / medic 🩺.
- **Per-team singleton (D10)**: enforced via existing tmux window-name uniqueness; no new locking primitive. Cross-team concurrency intentional + safe (each unblocker operates on its own team's kanban + cage).
- **Cross-team escalation BOUNDARY (D9)**: unblocker stays strictly in-team; cross-team root causes flow via complaint to target team's ombudsman (ADR-150 helpers handle the path). Martinet may write sentinels into sibling teams' `.atmux/state/unblocker-pending.json` for high-frequency cross-team patterns (audit trail stays in complaints).
- **Cross-refs**: ADR-152/153/154/155 (sibling /bruh drafts), ADR-150 (cross-team helpers), ADR-147 (ombudsman boundary), ADR-077/133 (medic substrate), ADR-132 (martinet sentinel-router), ADR-148 (cadence-truth-signal), ADR-140 (cheap-model-first carve-out), ADR-090 (epic-team carve-out), ADR-135 (naming convention), ADR-138 (verified send-keys), ADR-005 (kanban-source-of-truth), ADR-010 (`atmux flag`), ADR-085 (`Status: proposed (deferred: …)` annotation — unblocker does not auto-action deferred ADRs).
- **Out of scope this commit**: execution slices T2-T7 (brief template ship, start.ts wiring, sentinel reader, whip backstop, reanimate authority gate, complaint-file path, 100%-coverage unit tests, dogfood gate) — staged per lead-saturation carve-out. ADR is doc-only; impl Tasks filed post-reviewer-acceptance per the same-session decomp pattern (per `[[feedback_decomp_same_session_with_deps]]`).

### 📋 Proposed — `atmux pane-state` structured verb (ADR-155)

- **New ADR drafted** at [docs/adr/155-pane-state-structured-verb.md](docs/adr/155-pane-state-structured-verb.md) (Status: `proposed`) per EPIC `t-232d0d12` T1 (`t-4a4201de`). Closes complaint `c-6cd891d1` (operator-filed verb framing) + downstream sopx-side `c-068eba4d` / `c-a3c3a42d` (Stuck-input false-positive cascade observed 2026-05-15: `/bau` reported 14–16 of 19 windows "stuck input"; manual scan found 0 actually-user-queued). Replaces the per-consumer `tail -10` heuristic with a single structured verb.
- **Verb surface (D1)**: `atmux pane-state <window> [--json|--table]`. JSON-default (machines first; per the verb's primary consumers — `/bau`, `/bruh`, ADR-151 unblocker, ADR-148 cadence column substrate, ADR-132 martinet observer). Read-only; no side effects. Consumers compose state via their own loop cadence (verb is stateless).
- **Return shape (D2)**: Zod-validated closed schema — `{ pid, runtime_state, composer: { has_text, text, likely_user_typed, residue_class }, last_turn_marker_age_seconds, mode }`. Shape locked at v1; additions require an ADR-155 annotation header per project CLAUDE.md ADR append-only convention.
- **7-state `runtime_state` enum (D3)**: `idle` / `working` / `compacting` / `rate-limited` / `dead` / `shell-prompt` / `welcome-screen`. Spans the observer's decision tree (reanimate / nudge / leave-alone / log) without giving callers states they can't act on. Closed enum; new states require an ADR.
- **Structural marker parsing, not tail-10 (D4)**: composer separator + status footer + turn-execution glyphs (`✽` / `✻` / `✶`) + banner blocks. Markers enumerated in `src/core/pane-state-patterns.ts` (load-bearing constants module; reviewer-audited). TUI version bumps that break a marker land as ADR-155 annotation headers.
- **Projection map to ADR-057 (D5)**: `core/pane-state.ts` (the existing 8-state internal classifier serving `safeSendKeys` per ADR-138) is refactored to consume the new structured reader and project the result. Zero behavioral regression for `safeSendKeys` callers; new structured surface for new consumers.
- **`residue_class` denylist (D7)**: closed string-set, NOT a regex engine — `claim-next` / `pull-next` / `check-status` / `null`. v1 set sourced from the sopx 2026-05-15 false-positive corpus; expands slowly with auto-mode vocabulary. Auditable; reviewer-flagged per addition.
- **`likely_user_typed` defensive-default-false (D6)**: composer text is `likely_user_typed=true` IFF it does NOT match any `residue_class` pattern. Asymmetric-cost rationale: false-positive (residue mis-flagged as user input) sends Enter and triggers residue cascade; false-negative (real input mis-flagged) waits for operator's next checkin. Cheaper failure mode wins.
- **Dead-pane detection (D8)**: triple-check — `tmux display-message` empty OR `kill -0 <pid>` fails OR `/proc/<pid>/status: State: Z`. Zombie-pane states (claude crashed, shell holds defunct PID, tmux shows last frame) read as `dead`, not `idle`. Reanimation can fire.
- **Cross-refs**: ADR-057 (internal classifier — projection target), ADR-138 (verified send-keys — consumer via projection), ADR-148 (cadence-as-truth; pane-state is the proxy — column substrate), ADR-077 / ADR-133 (medic observe-loop), ADR-132 (martinet — primary cheap-model consumer), ADR-151 (unblocker — `runtime_state=dead` consumer), ADR-152 (blockers list — join target), ADR-154 (sibling /bruh sweep draft).
- **Out of scope this commit**: execution slices T2-T6 (verb impl, patterns module, consumer migration for `/bau` / `/bruh` / martinet / unblocker / status, dogfood gate, e2e tests) — staged per lead-saturation carve-out. ADR is doc-only; impl Tasks filed post-reviewer-acceptance per the same-session decomp pattern.

### 📋 Proposed — driver-inbox + lead-outbox SQLite migration (ADR-154)

- **New ADR drafted** at [docs/adr/154-driver-inbox-lead-outbox-sqlite-migration.md](docs/adr/154-driver-inbox-lead-outbox-sqlite-migration.md) (Status: `proposed`) per EPIC `t-2298cbb0` T1 (`t-8b50ab84`). Closes complaint `c-96e5a8f2` (driver-claude-sopx /bruh sweep 2026-05-15 00:17 MYT). Promotes `.atmux/driver-inbox.md` + `.atmux/lead-outbox.md` from markdown-as-canonical to **SQLite-tables-as-canonical with markdown view layer** — same pattern as ADR-076's member-inboxes cut.
- **Schema shape (D2)**: UNIFIED `coordination_messages` table with `direction` discriminator (`'lead-to-driver'` | `'member-to-driver'`), not per-direction tables. Operator + lead recommendation — identical triage semantics, cross-direction queries (ADR-152 blockers list) avoid UNION ALL, threading via `parent_id` composes naturally on a single table. Per-direction shape documented in §Tradeoffs as rejected alternative.
- **Triage shape (D4)**: structured `status` enum (`pending` / `acked` / `routed` / `waiting` / `archived`) + `acked_at` / `archived_at` / `triaged_by` columns, NOT raw glyphs in a `triage TEXT` column. Markdown render translates back to the existing ✅ / 📤 / ⏳ / ❌ / (filter) glyphs so operator muscle-memory survives the cut.
- **Markdown is render-only (D3)**: no background `state.db ↔ .md` sync. `atmux driver-inbox show [--json|--md]` renders from SQLite on demand; `atmux driver-inbox watch` provides committed-row stdout tail for live view.
- **Migration (D7)**: one-shot `atmux migrate inbox-to-sqlite` verb auto-fires on first `atmux start` after upgrade; idempotent re-run via `migration_audit` row + non-zero `coordination_messages` row count. Parses date headers + triage glyphs from existing `.md` files; moves legacy files to `.atmux/legacy/` as read-only archive.
- **Deprecation (D8)**: one-release window — next minor ships SQLite cut + markdown-read+write back-compat path; cut-over release removes the markdown path with a hard-error pointing operators at the migrate verb. Mirrors ADR-076's clean-cut pattern per `[[project_inbox_migration_done]]` memory.
- **Cross-refs**: ADR-060 (kanban SQLite canonical), ADR-076 (inboxes migration precedent), ADR-152 (blockers list — downstream consumer), ADR-153 (auto-promotion inbox→flag at 12h — downstream consumer), ADR-155 (pane-state verb — sibling /bruh draft), ADR-151 (unblocker — consumer).
- **Out of scope this commit**: execution slices T2-T6 (schema migration code, verb impls, dogfood gate, e2e tests) — staged per lead-saturation carve-out. ADR is doc-only; impl Tasks filed post-reviewer-acceptance per the same-session decomp pattern.

### 🟢 Shipped — `gitter-sweep` cron-install template (ADR-134 T7)

- **New `--template gitter-sweep`** option on `atmux cron-install` per [ADR-134](docs/adr/134-in-team-auto-merger.md) §triggers + T7 scope (`t-a87a39f1`). Emits a `*/N * * * * <env> atmux gitter --sweep >> .../gitter-sweep.log` cron line that backstops the intra-team auto-merger when the gitter member misses an event (paused / rate-limited / restart). Mirrors the existing `--template ombudsman-tick` / `lane-stall-watch` shape: install-time `ConfigError` if `team.autoMerge.enabled !== true`; renderer dual-gate also checks the roster for a `role: "gitter"` member before emitting the line.
- **Cadence resolution precedence**: (a) `cron-install --template gitter-sweep --interval <N>` transient override beats (b) `team.json::autoMerge.cronBackstopMin` config beats (c) the schema-side `DEFAULT_AUTO_MERGE_CRON_BACKSTOP_MIN = 10`. Matches ADR-134 §Config OQ-default (10 minutes).
- **Wiring surface**: new `gitterSweepIntervalOverride?: number` on `RenderCronBlockOpts` in `src/core/cron.ts`; new `"gitter-sweep"` entry in the `CRON_INSTALL_TEMPLATES` allowlist + `TEMPLATES_WITH_INTERVAL` set in `src/verbs/cron-install.ts`. Backward-compat: existing teams without `autoMerge.enabled` keep the old rendered block byte-equal (no spurious line; doctor sees no diff).
- **Out of scope this commit** — T7's other scope items (gitter member entry in the atmux team's `.atmux/team.json`, `atmux start` spawn integration, doc updates beyond CHANGELOG) ship in follow-up Tasks under the same EPIC. Cron-install template is the lowest-risk slice that unlocks operator manual-install of the backstop on `autoMerge` teams today.

### 🧹 Trunk fan-in cleanup — dedup duplicate `TeamCadence` Zod (ADR-148 T2 / T3)

- **Removed duplicate `TeamCadence` + `TeamCadenceThresholds` Zod definitions** in `src/schema/team.ts` introduced by the parallel landing of ADR-148 T3 (`ce9467e` via `c22ff1a`) and T2 (`8f2b857` via `51e8362`). Both branches added the same schema independently against an older base; `git merge-ort` accepted both copies additively (different line ranges, no conflict marker), then `tsc` errored with `TS2451: Cannot redeclare block-scoped variable 'TeamCadence'` + `TS1117: object literal cannot have multiple properties with the same name` on the duplicate `cadence:` field in `Team`. Trunk now ships T2's version (`enabled.optional()` matches ADR-148 §D1's "cadence is canonical truth signal — surface by default" intent); `DEFAULT_LANE_STALL_MIN_AGE_SEC` + `DEFAULT_LANE_STALL_CRON_INTERVAL_MINS` consts (T3 origin) preserved unchanged so `lane-stall-tick` + `cron.ts` consumers still resolve.
- **Why this row exists**: this is a trunk-fan-in artifact, not a feature/fix authored against a Task — surfaced post-merge by the T7 ship's `tsc --noEmit` gate. Captured here so future operators reading the CHANGELOG see the dedup context rather than wondering why a "Cadence schema (T2)" row sits next to a "Cadence schema cleanup" row.

### 🟢 Shipped — kanban auto-emit trunk-merge Task on Story-done (ADR-146 T2)

- **New `KanbanStory.branch` field** per [ADR-146](docs/adr/146-kanban-auto-files-trunk-merge.md) §D4 — source branch this Story's work lives on (typically `<base>-<member>` per ADR-082+084). Rides through the `extra` JSON column on the `stories` table; zero-migration roll-out.
- **`moveTask` hook** — when a Task's status transitions to `done`, if it's the last non-done child of a branched Story AND the team has `worktreeIsolation: true`, atmux auto-files a `merge t-xxx (branch→trunk): <source-branch> → trunk` Task per ADR-146 §D1+D2 — assigned to `gitter` (or per `autoEmitTrunkMerge.fallbackAssignee`). The auto-file lands in the SAME `BEGIN IMMEDIATE` transaction as the move-to-done write, so the ADR-032 task-done cascade wakes only after BOTH rows commit (no false-positive idle nudge per §Atomic).
- **Short-circuit rules** per ADR-146 §D5: Story without `branch` set, team without `worktreeIsolation`, `autoEmitTrunkMerge.enabled === false`, `Story.branch === team.merger.baseBranch` (when `shortCircuitOnSharedBase: true`), remaining non-done siblings, OR done-Task subject already matches the auto-emit pattern (loop-prevention) — any of these skip emit cleanly.
- **New `team.json::autoEmitTrunkMerge` config block** per ADR-146 §D7 — `enabled` (default `true` when `worktreeIsolation: true`, `false` otherwise), `fallbackAssignee` (default `null` = unassigned), `shortCircuitOnSharedBase` (default `true`). Strict-mode Zod block; typos rejected per ADR-054 §D3 drift detection.
- **Backfill script** at `scripts/backfill-story-branch.ts` — dry-run by default; `--apply` walks every Story with status `in-progress`/`testing`/`review`/`merging`/`done` and infers `<base>-<member>` from child-task owners when all children share a single declared member. Conservative (skips Stories with mixed owners or non-member owners — operator can hand-backfill via SQL). Idempotent; safe to re-run.
- **Out of scope this commit** — `atmux story update s-xxx --branch <b>` verb (deferred per OQ-1 to a future commit); cron-backstop trunk-merge (already handled by ADR-134 §state-machine cron path); `tested → merged` test-gate chaining (separate ADR per §D6).

### 🟢 Shipped — commit-cadence column in `atmux status` (ADR-148 T2)

- **New cadence column** in `atmux status` output per [ADR-148](docs/adr/148-commit-cadence-truth-signal.md) §D3. Renders the canonical truth-signal for "is this member shipping?": one of `🟢 shipping (Nmin)` / `🟡 idle (HhMm)` / `🔴 dormant (Hh)` / `🚨 ship-zero (Hh)` per ADR-148 §D2 classifier. Sourced from per-member `git -C <worktree> log --since=<windowSec>s --author=<name>` — the cadence is the truth signal; pane-state is the proxy.
- **`state` column renamed to `pane-state`** per ADR-148 §D3 to make the proxy explicit. Existing operators reading the column see the same cage-state values (`active`/`wedged`/`bootstrapping`/`down`); the header rename signals that this is a process observable, NOT a verdict on whether the member is shipping. The cadence column is the new primary verdict; the pane-state column persists for one release cycle so operators with muscle memory still see the process diagnostic.
- **New `team.json::cadence` config block** per ADR-148 §D7 — opt-out via `cadence.enabled: false`; per-member opt-out via `cadence.exemptMembers: ["planner", "reviewer"]` (exempt members render as `(exempt)`); per-team threshold overrides under `cadence.thresholds` (shippingMaxAgeSec / idleMaxAgeSec / dormantMaxAgeSec / shipZeroWindowSec). Defaults match ADR-148 §D7 (30-min ship window, 2-hr ship-zero threshold matching CLAUDE.md whip §0.05 stake floor).
- **JSON output gains `members[].cadence`** with the `CadenceObservation` shape (`windowSec`, `commitsInWindow`, `lastCommitAt`, `lastCommitSha`, `ageOfLastCommitSec`, `verdict`). Backwards-compat: the legacy `paneCommand` + `cageState` fields remain unchanged so existing consumers (dashboards, cockpit aggregators) are not broken.
- **Out of scope this commit** — T3 (lane-stall cron rule) + T5 (`src/core/cadence-classifier.ts` extraction + martinet observe() wiring + `[ship-zero-window]` Discord template) ship in follow-up Tasks under the same EPIC. T2 inlines the classifier in `src/verbs/status.ts` so the column surfaces today; T5 lifts the classifier verbatim into the shared module.

### 🟢 Shipped — ADR-087 §D4 cron quiescence on soft-stop (t-ccabd763)

- **New `quiesceCron` helper** in `src/core/soft-stop.ts` per [ADR-087 §D4 amendment](docs/adr/087-atmux-stop-soft.md#§D4-—-cron-quiescence-amendment-2026-05-16-t-ccabd763). Closes the race where the team's whip + watchdog cron lines remain installed + active during the soft-stop window (notice → grace → manifest → archive → kill-session), so a `*/15` or `*/1` tick landing inside that window re-pokes panes that are shutting down / re-spawns dead members / fires Discord pings against a stopping team.
- **Wired in `src/verbs/stop.ts`** — `quiesceCron({ atmuxDir })` fires BEFORE `softStop()` in the `--soft` branch. Non-fatal: a crontab swap failure surfaces as a stderr warn and soft-stop proceeds (race risk degrades to today's bare soft-stop, not worse). Surfaces a `cron-quiesce: suspended N new line(s), M already suspended` stdout line when a non-zero count of lines was acted on.
- **Scope is whip + watchdog only** — regex `\batmux\s+(whip|watchdog)\b` catches `atmux whip` + `atmux whip-resume-check` (word-boundary at `-`) + `atmux watchdog`. Other team-scoped cron verbs (gitter-sweep / lane-stall-watch / ombudsman-tick / epic-merge-tick / groom / report / decisions-digest / unblocker-tick) are deliberately LEFT running — they manage trunk/state.db, not panes, and don't interact with the panes winding down.
- **Per-team scoping** via the `ATMUX_DIR=<atmuxDir>` env marker every renderer-produced cron line carries (per `src/core/cron.ts::renderCronLines`). Other teams' whip/watchdog lines (different ATMUX_DIR) are left running — counted as `skippedOtherTeam` in the result. Operator-installed out-of-block lines that carry the marker are also suspended.
- **Comment-prefix pattern** `# ATMUX-QUIESCED <epoch> <original-line>` makes cron ignore the line + leaves a forensic trail (timestamp shows WHEN soft-stop fired). The next `atmux start` re-installs the team's cron block via existing `cron-install` path, which renders fresh lines without the comment tag — no companion `unquiesceCron` is needed for the standard in-block lifecycle.
- **Idempotent** — re-runs against an already-quiesced crontab are no-ops (already-tagged lines counted as `alreadySuspended`, no second write to crontab). Test injection seams: `crontab?: CrontabIO` (default `defaultCrontabIO()`), `dryRun?: boolean`, `clock?: () => number` (default `time.now()`).
- **/loop processes** (Claude Code `ScheduleWakeup` self-wakeups) are NOT explicitly cancelled. They die implicitly when the TUI is killed at `tmux kill-session` (the last step of stop.ts). A 5s grace-window race is theoretically possible but bounded by `ScheduleWakeup`'s 60s clamp — any realistic `/loop` cadence (60s–3600s) is >> 5s. Explicit `C-c` pre-kill cancellation is deferred per ADR-087 §D4-OQ1 ("revisit if production logs show a `/loop`-class race post-quiesce"; reversibility: low).
- **Tests** — 8 new unit tests under `tests/unit/core/soft-stop.test.ts::describe("quiesceCron")`: happy path (whip + watchdog suspended, unrelated lines untouched), other-team isolation, idempotent re-run, `whip-resume-check` matched via word-boundary, dryRun reports without writing, no-crontab / crontab-unavailable clean zero, unrelated verbs NOT matched, crontab structure preserved (marker fence + non-atmux lines + line-count invariance).
- **Same-commit doc**: ADR-087 §D4 amendment appended (append-only per ADR convention) with race explanation + decision + scope rationale + `/loop` analysis + cron-remove interaction + 2 open questions. Existing §Refs preserved; new §Refs addendum cites the §D4-specific surfaces.
- **Out of scope this commit** (Task body explicit carve-outs): cockpit-level cascade (parent's `stop --soft` → recursive child stops) — that's ADR-090 §Decision-anchor #7 territory; explicit `pkill -f "atmux whip"` in-flight tick reaping (ADR-053 advisory lock makes this lower-priority — current ticks exit cleanly when the lock is released; the comment-out already prevents NEW ticks from firing).
- **Cross-refs**: ADR-087 (parent), ADR-053 (whip advisory locking), ADR-076 (per-team cron isolation), ADR-083 (`cron-remove` verb — companion post-kill step), CLAUDE.md §Docs Discipline (ADR-first, same-commit doc updates).

### 🟢 Shipped — `atmux groom --zombie-sweep` sub-op (t-0027eec3)

- **New `sweepZombieTmuxSockets` sub-op** in `src/core/groom.ts` per Task body t-0027eec3 (c-4698c603 arm b). Defense-in-depth for SIGKILL'd `bun test` orphans that bypass the (a) primary fix shipped in t-88b60ca7 (`tests/unit/verbs/cockpit.test.ts` module-level fixture registry + `process.on('exit')` + `afterAll` sweep). Under SIGKILL no userland exit hook fires, so the fixture's `mkdtemp` socket dir + tmux server leak; this sub-op walks `os.tmpdir()` for fixture-shape `atmux-*-<suffix>` directories older than `minAgeMs` (default 6h), kills any tmux server bound to a socket inside, then `rm -rf` the parent dir.
- **New `--zombie-sweep` flag** on `atmux groom` (opt-in, default OFF). Wired in `src/verbs/groom.ts` after the existing `--archive` sub-op; error-contained (one failure surfaces as warn + continues). `result.zombieSweep` carries the `ZombieSweepResult` (scanned / killed / removed / per-dir errors).
- **Fixture-shape regex** `/^atmux-(cockpit-)?[^/]+-[^/]+$/` requires the trailing mkdtemp suffix; production cage dirs (e.g. `/tmp/atmux-<team>/sock` without trailing hyphen) are deliberately excluded. Two socket shapes detected per matched dir: `<dir>/sock` (default cage convention) + `<dir>/tmux-<uid>/default` (`resolveTeamSocket` with explicit `team.tmuxTmpdir`).
- **`tmux kill-server` is idempotent** — no-server errors (`"no server running"`, `"server not found"`, `"no such file"`, `"connection refused"`) are EXPECTED on idempotent re-runs and are swallowed. Unexpected errors (permission-denied, garbled socket) surface to `result.errors[]` per groom convention.
- **Test injection seams**: `tmpDir` (defaults to `os.tmpdir()`), `nowMs` (defaults to `time.now()`), `dryRun`, `killServer` (defaults to `createTmux({ socketPath }).server.killServer()`).
- **Cron policy** — `--zombie-sweep` is opt-in / default-off in v1. Rationale: (1) false-positive deletes against an actively-running long-lived test fixture corrupt the in-flight test, (2) the (a) primary fix already covers the common case; defense-in-depth is housekeeping, not load-bearing. Follow-up Task to migrate to `team.json::groom.zombieSweep: true` config knob with cron auto-respect after N weeks of opt-in production proof.
- **Tests** — 13 unit tests in `tests/unit/core/groom-zombie-sweep.test.ts` covering: matched + stale dir cleanup, `atmux-cockpit-*` nested fixture shape, age-threshold gate (5h59m skipped), production-shape exclusion (`atmux-atmux` not matched), unrelated `/tmp` entries ignored, `tmux-<uid>/default` socket shape detection, no-socket cleanup-only path, dryRun reports without mutating, idempotent re-run, expected-class kill errors swallowed, unexpected kill errors surfaced, custom `minAgeMs`, missing tmpDir cold-start safety, top-level file entries skipped. Stubs `killServer` for deterministic execution.
- **Same-commit doc**: new `docs/RUNBOOK-grooming.md` documents all 8 groom sub-ops with the new `--zombie-sweep` flagged + operator usage + cron policy + return shape; existing `parseGroomArgs` unit test updated for the new `zombieSweep: false` default.
- **ADR pointer**: no dedicated ADR (housekeeping scope per Task body); references ADR-068 (groom umbrella — ghost ADR per `t-75a79d7c`), complaint `c-4698c603` (resolved), `t-88b60ca7` (primary fix shipped, `20fccb1`), CLAUDE.md §`bun test` orphan rule (root cause).
- **Out of scope this commit**: cron-default-on migration (follow-up Task once opt-in production proves stable); `team.json::groom.zombieSweep` config knob; cross-`/tmp/atmux-*/sock` enumeration beyond `os.tmpdir()` root (e.g. `/var/folders/.../T/` on macOS — Linux primary first).

### 🟢 Shipped — team-of-teams pre-sopx capstone phase-2 partial — ADR-092 cross-team tell-lead asserted (t-bc4fdb19)

- **Phase-1 skeleton (`tests/e2e/team-of-teams-pre-sopx.test.ts`) extended** with phase-2's narrow scope per Task body: 3 INTEGRATION tests in `describe("ADR-092 cross-team tell-lead (phase-2, t-bc4fdb19)")` that walk the cross-team routing surface end-to-end against real cockpit fixtures + the real `spawnEpic` verb. Phase-1's lifecycle walk (8 `test.todo` stages spanning spawn→fan-in→dissolve→no-leakage) remains at phase-1 scope; phase-2's Task body explicitly bounded the cross-team paths + doctor checks, not the lifecycle.
- **Three canonical paths asserted**: (a) parent driver → epic-lead (with `ATMUX_CALLER_SCOPE=driver` master override per §D3 case a), (b) epic-lead → parent (allowed natively via §D3 case c via cockpit's `epicTeam.parent` linkage), (c) unrelated outsider → epic refused per §D3 case e/g. Refusal-path asserts NO inbox write on either side — refusal lands BEFORE `appendDriverInbox`. Happy-path asserts the inbox-write durability (per ADR-029 §F6 + tell-lead.ts comment "appendDriverInbox already landed before this throw"); tmux send unavoidably fails in test (no cage server) — that's the EXPECTED terminal failure mode the assertion machinery is built around.
- **Phase-1 helper signatures implemented**: `ParentFixture` extends as `ParentFixtureRuntime` (adds `cockpitPath`, `templatesDir`, `capturedLogs`); `SpawnedEpic` returned shape preserved. `makeParentFixture` + `spawnEpicForFixture` follow the same shape as `tests/e2e/epic-auto-merge.test.ts::makeFixture` (bare remote + working clone + tmuxTmpdir pinned at fixture so `resolveTeamSocket` doesn't touch shared `/tmp` paths).
- **Predecessor cherry-picks onto `geoyws-up-impl-3`**: `3822b3b` (ADR-092 cross-team tell-lead from `ba7ee3f` on `geoyws-up-impl`) + `590517c` (phase-1 skeleton from `a670648` on `geoyws-up-impl-2`). Both were queued for trunk fan-in via gitter at sweep time but had not landed; cherry-pick assembles the predecessor stack locally so phase-2 can build on top. Criss-cross history is acceptable per ADR-137 §carve-outs — final fan-in via gitter collapses it.
- **Doctor D5a/D8/D9 remains deferred** to `t-c2e544b6` (the ADR-092 dogfood Task; doctor probe surfaces NOT yet on trunk). Captured as `describe.todo("ADR-092 doctor D5a/D8/D9 (deferred to t-c2e544b6)")` block with 3 `test.todo` entries each spelling out the helper sketch — turnkey wiring spec for t-c2e544b6's claimant. Re-claims on t-c2e544b6 ship.
- **RUNBOOK companion updated** — `docs/RUNBOOK-team-of-teams.md` §Cross-team tell-lead section flips from "deferred to phase-2" → "Verified — phase-2, t-bc4fdb19" with the 3 paths + test pattern documented. Status banner reflects partial phase-2 (cross-team Verified; lifecycle + doctor still pending).
- **Out of scope** (phase-2 carve-outs preserved from Task body): sopx-side migration (operator-driven), PR-mode dissolution (§Decision-anchor #6 deferred), member-to-member cross-team messaging (ADR-092 §Out-of-scope), full lifecycle walk (phase-1's 8 `test.todo` stages — lifecycle is its own scope-class, not bundled into the cross-team capstone delta).
- **Cross-refs**: ADR-092 (cross-team tell-lead — primary contract under test), ADR-099 (`EX_NOPERM=77` refusal exit), ADR-090 (epic-team lifecycle — spawn-epic fixture target), ADR-091 (epic-merge state machine — pre-fixed deferred), ADR-137 §carve-outs (sibling-merge via cherry-pick is acceptable for member-branch predecessor assembly), ADR-029 §F6 (durable inbox-write semantics — assertion machinery foundation).

### 🟢 Shipped — team-of-teams pre-sopx capstone phase-1 skeleton (t-edc93b42, 2026-05-16) + `docs/RUNBOOK-team-of-teams.md`

- **New `tests/e2e/team-of-teams-pre-sopx.test.ts`** — capstone gate spec authored as a **structured skeleton** (`describe.skip` + 8x `test.todo` covering the full ADR-090/091/134 lifecycle: spawn 2 parallel epics → seed mock Tasks → claim/done lifecycle → auto-merge state machine fan-in to epic-trunk → epic-trunk fan-in to parent-trunk → dissolve-epic → parent KanbanEpic done → no-leakage proof). Fixture-helper signatures locked: `ParentFixture`, `SpawnedEpic`, `LifecycleSnapshot`, `DissolutionResult` interfaces define the phase-2 contract; module-level `activeFixtureDirs` registry + `process.on('exit')` hook + `afterAll` sweep mirror the t-88b60ca7 / c-4698c603 defense pattern so the same cleanup machinery lights up when phase-2 swaps in real fixtures. State-snapshot expectations table (per CLAUDE.md Test finding report pattern) documented in companion RUNBOOK; idempotence proof (post-cleanup snapshot == pre-spawn-baseline) is the closure beat.
- **Phase-1 ship rationale (vs deferring entire file to phase-2)**: reserves the canonical filename + fixture shape so phase-2's diff is implementation-only; documents the INTENDED lifecycle + state-snapshot expectations now while context is hot; locks down helper signatures so phase-2's review gate has a stable structural contract. Per CLAUDE.md "Pair demo runbook beats with rehearsal spec steps" — every RUNBOOK beat name maps to one `test.step()` label verbatim in phase-2; drift surfaces as a failing rehearsal run, not a sopx-flip-morning surprise.
- **WIDER blocker captured in spec header**: phase-2 wires real assertions once gitter sweep fans the following branches into trunk — `geoyws-up-impl-3` (carries 762716f + aac4ee1 + 57b0d0d + b502ebe + a34fafa: ADR-090 schema + spawn-epic/dissolve-epic verbs + ADR-091 state machine + ADR-090↔091 wire-up) + `geoyws-up-impl` (carries ba7ee3f: ADR-092 cross-team tell-lead). All listed branches were `state=null action=queued` or `skipped-in-flight` in the gitter sweep run at 06:14 MYT 2026-05-16; gitter-stuck-bug captured separately at t-f4088323.
- **New `docs/RUNBOOK-team-of-teams.md`** — operator-facing companion: when-to-spawn / sopx-adoption-sequence (8 verbatim beats from driver-inbox 14:03 MYT lines 3122-3132, 1:1 with spec test.step labels) / state-snapshot expectations table (8 stages with parent.KanbanEpic.status / cockpit.epic-entry / worktree / cage / cron-block columns) / failure-mode triage / cross-team tell-lead deferred-to-phase-2 note / doctor D5a/D8/D9 deferred-to-phase-2 note / adjacent-flags from t-cc4c5fd9 audit. `⚠️ Status: phase-1 skeleton` banner at top until phase-2 flips Intended → Verified.
- **Phase-2 deferred to** `t-bc4fdb19` (deps=[t-c2e544b6, ba7ee3f-on-trunk]) with full ADR-092/doctor-D8/D9 + spawn-epic/dissolve-epic real-assertions scope; TODO comment block at end of spec cross-links the 3 cross-team tell-lead paths + 3 doctor checks + 3 adjacent-flag-deferrals so phase-2's claimant has a turnkey wiring spec.

### 🟢 Shipped — cross-team `atmux tell-lead --team <name>` (ADR-092)

- **New `--team <name>` flag on `atmux tell-lead`** per ADR-092 T1 (`t-5f20ba85`). Driver / parent-team / child-epic-team can now route a `tell-lead` ask into another team's inbox in the cockpit tree without `cd`-ing into the target's worktree. Closes the ADR-091 epic-merge conflict-surface gap (T12 migration deferred to its own commit per ADR-092 §Out-of-scope).
- **Cockpit-walk resolution (D1)**: `--team <name>` does a depth-first match on `cockpit.sessions[].name`; resolves target's `root` (own for `type: "team"`, nearest-ancestor `team.root` for `type: "epic-team"`), `team.json`, cage socket via `resolveTeamSocket`, and lead window. Default (no flag): existing cwd-derived single-team path is **byte-identical** to pre-ADR-092 behavior (Decision-anchor #1 — no regression on the hot path).
- **`findTeamByName(cockpit, name): CockpitTeamLookup | null` helper (D2)**: new pure export from `src/core/cockpit.ts`. Reuses existing `walkSessions` DFS walker. Returns the first matching `team` / `epic-team` node (other session types — superdriver, medic, martinet — skipped). Name-collision is operator error per Decision-anchor #2; lookup is deterministic on DFS order.
- **`callerScopeAllowed(cockpit, src, tgt, scope): boolean` gate (D3)**: symmetric four-case policy table — (a) `ATMUX_CALLER_SCOPE === "driver"` master override, (b) same-team trivially allowed, (c) child-epic-team → parent allowed, (d) parent → child-epic-team allowed. Siblings under same parent + unrelated teams refused (must route via parent). Refusal text names both ends per Decision-anchor #5 so operators see the policy violation root, not a generic "scope refused."
- **`ATMUX_CALLER_SCOPE` env var (D3 / Decision-anchor #4)**: exact-match — no `ATMUX_SCOPE` shorthand, no `--scope` flag-form (env-only). Cockpit driver pane sets it once on bootstrap; member panes do NOT inherit it (cage-tier boundary per ADR-058).
- **Socket resolution respects nested cages (D4)**: cross-team heads-up loads target `team.json` directly + calls `resolveTeamSocket(targetTeam)` — no path-construction from source-cage state (Decision-anchor #6 reviewer pre-flag enforces no parent-cage-prefix leak).
- **Tests**: 13 unit tests in `tests/unit/core/cockpit.test.ts` for findTeamByName (depth-3 fixture + own-root vs parent-root + DFS deterministic match + leaf-type skip + null on miss) and callerScopeAllowed (full 7-case matrix: driver / same-team / child→parent / parent→child / siblings-same-parent / siblings-diff-parent / unrelated / unknown). 3 unit tests in `tests/unit/verbs/tell-lead.test.ts` for `--team` flag parsing (populate / missing-value error / bare-invocation fast-path preserved).
- **Out of scope**: member-to-member cross-team messaging (separate `atmux send --team` Task if needed); `atmux doctor` D8 / D9 cross-team-routing health checks (Task `t-c2e544b6` — sibling e2e); sibling-epic-team direct routing (refused per D3 — must route via parent); ADR-091 T12 conflict-surface migration (referenced for traceability; separate commit).
- **Cross-refs**: ADR-089 (`walkSessions` DFS substrate — load-bearing primitive), ADR-090 (epic-team lifecycle; forward-reference — `epicTeam.parent` linkage), ADR-091 (epic-merge conflict-surface; forward-reference — first consumer), ADR-029 (tell-lead bash spec — byte-equal contract preserved on default path), ADR-058 (cage tier; forward-reference — Tier-1 boundary respected), ADR-099 (error-handling — `EX_NOPERM=77` for refusal).

### 📋 Proposed — ADR-091 design doc draft (t-4af76f05)

- **New `docs/adr/091-kanban-driven-auto-merge.md`** — standalone design doc for the epic-team auto-merge state machine. Closes the layering deviation flagged across t-04350614 (`a34fafa`), t-9a8b0e4e (`b502ebe`), and t-9d22718b (`d79840b`) where impl + wire-up + e2e shipped first per planner discretion.
- **All 8 reviewer pre-flags folded into §Decision-anchor lines** (sourced from `.atmux/reviewer-preflag-ADR089-091.md` §ADR-091, signed 2026-05-13): #1 `BEGIN IMMEDIATE` on every transition, #2 conflict-surface durability (parent state.db write FIRST then tell-lead), #3 `reviewer-trunk-signoff` marker cited from [ADR-090](docs/adr/090-epic-team-lifecycle.md) §Decision-anchor #1 verbatim, #4 stale-epic rebase via `rebasing` intermediate state, #5 wrong-parent merge validation, #6 `dissolved` terminal state, #7 `conflict → in_progress` reverse transition (operator unblock path), #8 `mergeMode: "pr"` schema-accept-runtime-noop.
- **3 post-ship audit recommendations folded into §Decision-anchor lines** (from `.atmux/audits/adr-089-091-adjacent-class-2026-05-13.md` §Class 1): #9 `pr-open` state for pr-mode runtime (deferred), #10 PR-creation durability (`epic.prNumber` written to state.db BEFORE `gh` CLI returns), #11 `gh auth switch` process-global concurrency mutex via `cockpit_gh_lock` (mirrors [ADR-090](docs/adr/090-epic-team-lifecycle.md) §Decision-anchor #11).
- **Full state machine documented**: auto-mode chain `open → in_progress → ready_to_merge → [rebasing →] merging → merged → dissolved | conflict` plus pr-mode chain `ready_to_merge → pr-open → (pr-merged | pr-closed | pr-conflict) → dissolved` (deferred). Transition table covers all 15 valid edges with side-effects + priority order. EPIC-done definition mirrors [ADR-090](docs/adr/090-epic-team-lifecycle.md) §Decision-anchor #5 verbatim. Reverse-transition unblock path documented end-to-end.
- **Cross-refs canonical**: [ADR-090](docs/adr/090-epic-team-lifecycle.md) (schema + lifecycle), [ADR-134](docs/adr/134-in-team-auto-merger.md) (sibling intra-team merger, shared state machine module), [ADR-092](docs/adr/092-cross-team-tell-lead.md) (cross-team tell-lead, forward-ref for SECOND-line conflict surface). Reuse statement enumerates every primitive — zero new abstractions.
- **Open questions carved out**: §Decision-anchor #6 enum extension (adding `dissolved` to `BranchMergeState` requires scope-discrimination across ADR-091/ADR-134 — follow-up Task to decide), §Decision-anchor #7 verb sugar (`atmux epic advance --to in-progress` — follow-up).
- **Status: proposed** — flips to accepted after operator review or reviewer signoff. Earlier impl commits (a34fafa / b502ebe / d79840b) pin to the design captured here.

### 📋 Proposed — epic-team auto-merge e2e dogfood gate (ADR-091, t-9d22718b)

- **New `tests/e2e/epic-auto-merge.test.ts`** — full ADR-090↔ADR-091 loop walked end-to-end against a real git repo + real SQLite + scratch cockpit.json. Cold-started fixture per test via `mkdtemp` + `afterEach` teardown (stateful e2e per [CLAUDE.md](CLAUDE.md) §Testing Discipline — not a repeatable smoke).
- **Happy-path beat sequence**: parent-team fixture (real git, bare remote, parent state.db with seeded EPIC row) → `spawnEpic` verb provisions the child worktree + `team.json` + state.db + cockpit append → epic-team commits a feature file on its `<parentBase>-epic-<epicId>` branch → child kanban seeded with one done Task + the canonical `reviewer-trunk-signoff` Task in done (per [ADR-090](docs/adr/090-epic-team-lifecycle.md) §Decision-anchor #5) → three successive `epicMergeTickVerb` calls drive `open → in_progress → ready_to_merge → merging → merged` per the per-tick contract → on `merged`, the `dispatchDissolve` hook (wired by t-9a8b0e4e in `b502ebe`) invokes the production `dissolveEpic` verb which prunes the child worktree, unregisters the cockpit entry, marks parent's EPIC row done → assertions verify parent's `main` branch carries the child's commit under a `--no-ff` merge commit (`git log --merges`), the child `feature.md` file landed in the parent, cockpit no longer references the child, parent EPIC row is `status='done'` with `completed_at` set.
- **Reviewer-trunk-signoff gate**: separate test asserts a child kanban WITH a done feature Task but WITHOUT the `reviewer-trunk-signoff` Task stays in `in_progress` (gate-veto per §Decision-anchor #5) with the operator-actionable reason in the tick log.
- **Conflict-path beat sequence**: parent + child commit divergent versions to the same file → epic-merge tick observes `baseHasMoved: true` → state machine routes to `rebasing` per the shared `shouldTransitionFromInProgress` contract → no dissolve fires → worktree + cockpit entry persist for operator intervention. (Terminal `conflict` arrives via a subsequent rebase attempt OR future cron-driven rebase resolver — out of scope for this dogfood; the rebasing detour is the observable contract today.)
- **Cleanup-guarantees test**: confirms no orphan worktree + no orphan cockpit entry post-merged; a follow-up `dissolveEpic` invocation against the already-gone epic-team refuses with `not found in cockpit` (idempotent safety-net).
- **Test runtime budget**: each `test()` carries a 30s timeout per pre-flag #3. Real git ops dominate; the 30s ceiling fits CI's per-test slot.
- **Out of scope (per Task body §"Out of scope")**: `pr` mode dogfood (deferred per §Decision-anchor #6); `tell-lead` conflict-path surface to parent (forward-ref ADR-092 / T14 — once the cross-team caller-scope gate lands, the conflict test adds a `tell-lead --team parent-team` assertion).
- **Layering deviation**: ADR-091 `Status: proposed → accepted` from the Task AC is **NOT flipped in this commit** — the ADR-091 design doc (`docs/adr/091-kanban-driven-auto-merge.md`) is not yet on disk (`t-4af76f05` still todo). The dogfood test landed first per the planner-discretion-impl-before-design pattern that produced t-04350614; the doc lands as the Acceptance side under t-4af76f05, then a follow-up commit flips its status. Flagging for reviewer per the [[feedback-test-impl-session-pattern-2026-05-14]] "ship-and-flag" pattern.
- **Status: proposed** until the ADR-091 design doc lands + flips to accepted.

### 📋 Proposed — epic-team `spawn-epic` / `dissolve-epic` verbs (ADR-090, t-b430b185)

- **New `atmux team spawn-epic <epicId> --from <parentTeam>`** (`src/verbs/team/spawn-epic.ts`) — creates a child epic-team end-to-end. Pipeline: caller-scope gate (ADR-033 — refuses non-driver) → cockpit walk to resolve parent → compute `<parentRoot>-epics/<epicId>/` sibling path (per [ADR-090](docs/adr/090-epic-team-lifecycle.md) §Decision-anchor #2) + `<parentBase>-epic-<epicId>` branch → roster resolution (`--roster <preset>` / `--roster-file <path>`, mutually exclusive per §Decision-anchor #4, default `templates/epic-rosters/default.json`) → `provisionWorktree` (ADR-082/088 — `initSubmodules: true`) → synthesize + write child `team.json` with `epicTeam` block populated → init child `state.db` via `openDatabase` + `migrations` → append nested `epic-team` session under parent in cockpit.json → log next-step hint.
- **Transactional rollback** on mid-pipeline failure (per Task pre-flag #1): if step 6-8 fails after the worktree landed in step 5, the verb attempts `pruneWorktree(..., dirty: "force")` to undo the side-effect. The cockpit registry append is the LAST mutation; failure exits non-zero with the partial state visible (deliberate — operator can re-run after fixing the cause). Force-mode prune is safe here because the worktree was authored this turn — no operator data lives inside it.
- **New `atmux team dissolve-epic <epicId>`** (`src/verbs/team/dissolve-epic.ts`) — composes `softStop` (ADR-087, `src/core/soft-stop.ts`) + `pruneWorktree` (ADR-082) for the graceful tear-down. Pipeline: caller-scope gate → cockpit walk to locate epic-team + parent → load child `team.json` (best-effort — partially-spawned remnants still clean up) → pre-flight gates (skipped under `--skip-checks`): all child kanban Tasks in `done` / `wontfix` + worktree clean → soft-stop child cage (best-effort, fail-warn-continue) → prune worktree (dirty refuses with operator-actionable error unless `--force-prune` or `--skip-checks`) → remove epic-team entry from parent's cockpit sessions[] → mark parent's kanban EPIC row done (UPDATE epics SET status='done').
- **`--skip-checks` lead-override** per ADR-090 resolved-open #5 — bypasses both pre-flight gates AND switches prune to `force` mode. Logged loudly so the operator owns the consequences (also written to stderr as a WARN).
- **CLI registration** in `src/cli.ts::dispatchTeamSubverb` — `atmux team spawn-epic` + `atmux team dissolve-epic` join `team repair-rename` under the existing team-sub-dispatch.
- **Reuse statement** (per ADR-090 §Reuse statement): zero new abstractions. spawn-epic composes `provisionWorktree` + `openDatabase` + `Team.parse` + raw JSON read/write; dissolve-epic composes `softStop` (via injected `softStopHook` for test seam) + `pruneWorktree` + `isWorktreeDirty` + raw JSON read/write.
- **Tests** (`tests/unit/verbs/team/spawn-epic.test.ts` + `dissolve-epic.test.ts`): 15 + 13 cases respectively. Arg-parser unit tests cover every flag + mutual-exclusion + missing-required refusal. End-to-end tests use a scratch tmpdir + fake `cockpit.json` + mocked `GitSpawn` to exercise the worktree-create, child-team-write, child-state.db-init, cockpit-mutate, parent-EPIC-mark-done paths. Refusal-path coverage: caller-scope-member, parent-not-in-cockpit, epic-team-root-already-exists, roster-preset-not-found, open-tasks-without-skip, dirty-worktree-without-skip-or-force, epic-not-in-cockpit (dissolve).
- **Out of scope** (forward-refs): child cage auto-spawn (operator runs `atmux cockpit rebuild` after spawn-epic in v1; auto-spawn lands as a follow-up Task); `gh` fail-fast assertions for pr-mode (§Decision-anchor #10 — pr-mode runtime deferred; the schema layer's superRefine already refuses pr-mode without `prTarget.base` + `prAuthorUser`); cross-team `tell-lead` from epic-team back to parent (ADR-092 / T14); ADR-091 auto-merge state machine wiring on dissolve (epic-merge cron already auto-dispatches `dissolve-epic --auto` per `src/core/epic-merge.ts` — T9 of ADR-091 t-04350614, the bridge between the auto-merge ledger transition and this verb is the stderr TODO emitted from `tryDispatchDissolve`).
- **Status: proposed** until the cockpit auto-spawn lands + the epic-merge `tryDispatchDissolve` is wired to actually invoke `atmux team dissolve-epic --auto`.

### 📋 Proposed — epic-team auto-merge state machine + cron (ADR-091, t-04350614)

- **New `src/core/epic-merge.ts`** — caller wrapping the shared `branch-merge-state.ts` (ADR-091 + ADR-134 shared module landed in `7da4e85`) with epic-team scope. Exports `EpicMergeContext` + `performEpicMerge(ctx)` + pure `shouldEpicTransitionFromInProgress(gate, hasReviewerTrunkSignoff)`. Sibling of `intra-team-merge.ts` (ADR-134); both compose the same `MergerStateRepo` (rows coexist, addressed by branch name — no schema migration). The state machine is keyed on the epic-team's shared branch (`<parentBase>-epic-<epicId>`) per [ADR-090](docs/adr/090-epic-team-lifecycle.md) §Decision-anchor #3 carve-out (one row per epic-team, since members share the worktree).
- **Epic-team-aware gate** refines the shared `shouldTransitionFromInProgress` with ADR-090 §Decision-anchor #5: the `reviewer-trunk-signoff` Task gate. A done Task with `role: "reviewer-trunk-signoff"` MUST exist before `in_progress → ready_to_merge` fires, regardless of the other gate facts. Missing-signoff stays `in_progress` with an operator-actionable reason; the trunk-signoff Task is the EPIC's test-coverage gate (per project [CLAUDE.md](CLAUDE.md) §Testing Discipline).
- **New CLI verb `atmux epic-merge tick`** (`src/verbs/epic-merge.ts`) — one-shot cron entry-point. Resolves gate facts from the epic-team's kanban + git probes (`git status --porcelain` on parent, `git rev-list --count parentBase..HEAD` on epic, `git merge-base` for base-moved detection), composes `EpicMergeContext`, dispatches `performEpicMerge`. Default `by` attribution is `"epic-cron"`; bare invocation outside cron also works (idempotent on unchanged state).
- **New cron-line emission** in `src/core/cron.ts::renderCronLines` gated on `team.epicTeam !== undefined` — fires `atmux epic-merge tick` every `DEFAULT_EPIC_MERGE_CRON_INTERVAL_MINS` (5min default). Threading mirrors the merger / ombudsman / lane-stall override pattern (`cron-install --template epic-merge --interval <N>`). Normal teams (no `epicTeam` block) skip — additive.
- **mergeMode dispatch** per [ADR-090](docs/adr/090-epic-team-lifecycle.md) §Decision-anchor #6: `"auto"` runs `mergeMember(parentBase, epicBranch, parentRepoPath)` (default, v1) — on success, advances directly to terminal `merged` (skips the `tested` intermediate that ADR-134 uses, since the trunk-signoff Task already absorbed the test gate per §Decision-anchor #5). `"pr"` is schema-accept-runtime-noop in v1: short-circuits at `ready_to_merge` with a deferred-runtime reason.
- **Auto-dispatch `dissolve-epic --auto`** stub on `merged` success — until T9 (`t-b430b185`, spawn-epic / dissolve-epic verbs) ships, the dispatch is a stderr-logged TODO with the epicId; operator dissolves manually for now. The verb's wiring lands in T9.
- **Conflict path** per pre-flag #3: surfaces to `merger_state.note` with conflict-paths detail. Cross-team `tell-lead --team <parent>` routing is forward-ref to ADR-092 / T14; until that ships, conflict surface stays in the row (operator-visible via `atmux status`) and the standing flag-add path applies.
- **Gitter brief update** (`templates/briefs/gitter.md`) — adds the EPIC-TEAM CARVE-OUT rule to the auto-merge mode hard-rules section: epic-team gitters do NOT run trunk merges; that's `atmux epic-merge tick`'s job. Parent-team gitters only handle merge-result notifications.
- **Out of scope** (forward-refs): `tested`/`test_failed` test-gate path (ADR-134 territory; epic-teams skip via §Decision-anchor #5); ADR-091 design doc proper (`docs/adr/091-kanban-driven-auto-merge.md` not yet authored under t-4af76f05 — impl ships first per planner discretion, ADR draft follows as the Acceptance side); pr-mode runtime (deferred per §Decision-anchor #6); cross-team `tell-lead --team <parent>` (ADR-092 / T14).
- **Status: proposed** until T9 (`t-b430b185`) wires the auto-dissolve dispatch + ADR-091 design doc lands under t-4af76f05.

### 📋 Proposed — epic-team lifecycle schema (ADR-090 T1)

- **New `team.epicTeam` config block + `TeamEpic` schema** per [ADR-090](docs/adr/090-epic-team-lifecycle.md) §Schema — required fields `parent` / `parentEpicKanbanId` / `parentBase`; defaulted `mergeMode` (enum `auto` | `pr`, default `auto`); optional `prTarget.{remote,base}` + `prAuthorUser` (required-when-pr via Team-level `superRefine`). Absent block = normal team (existing topology unchanged).
- **Three cross-field refinements on `Team`** enforce ADR-090's hard invariants at `loadTeam` time: (#3) `epicTeam` + `worktreeIsolation: true` ⇒ refuse (HARD CONFLICT carve-out vs ADR-084); (#8) `mergeMode: "pr"` ⇒ requires `prTarget.base`; (#9) `mergeMode: "pr"` ⇒ requires `prAuthorUser`. Refuse errors cite the §Decision-anchor # so operators can lookup the rationale.
- **Kanban schema additions** (`src/schema/kanban.ts`): `KanbanTask.role` (reserves `"reviewer-trunk-signoff"` per §Decision-anchor #1); `KanbanEpic.epicTeamName` + `.epicTeamRoot` (filled by `spawn-epic`, cleared by `dissolve-epic`); `KanbanEpic.prNumber` + `.prState` + `.note` (forward-refs for ADR-091 state machine). All `.nullable().optional()` for back-compat.
- **Roster preset** `templates/epic-rosters/default.json` — 7-member preset (lead + planner + reviewer + 2 fe-* + 2 be-*) per §Roster preset. Resolved by `spawn-epic` when no `--roster` / `--roster-file` flag passed (§Decision-anchor #4).
- **Epic-team lead brief** `templates/briefs/epic-lead.md` — delta brief that **extends, does NOT fork** `lead.md` (reviewer pre-flag #3). New placeholders `{{PARENT}}` + `{{EPIC_ID}}`; brief renderer (`renderBrief` in `src/verbs/rotate.ts`) gains optional `parent` + `epicId` vars (back-compat: omitted vars leave placeholders inert).
- **Out of scope this commit** (T1): `spawn-epic` / `dissolve-epic` verbs (T9 — `t-b430b185`); `start.ts` shared-worktree short-circuit (T10 — `t-7e9eed65`); ADR-091 auto-merge state machine logic (T12). Every schema field is purely additive; existing teams parse unchanged.
- **Status: proposed** until T9 + T10 + T12 land green and the ADR-090 + ADR-091 fan-in completes via dogfood gate (`t-9d22718b`).

### 📋 Proposed — commit-cadence ground-truth health signal (ADR-148)

- **New `team.cadence` config block** per [ADR-148](docs/adr/148-commit-cadence-truth-signal.md) §D7 — full schema lands in T3 (this commit, `t-e9424574`) so T2 / T5 land additively. Fields: `enabled`, `windowSec`, `thresholds` (4 verdict bands), `laneStallEnabled`, `laneStallMinAgeSec`, `exemptMembers`. Opt-in via `enabled: true`; lane-stall defaults on once master switch flips.
- **Lane-stall fallback cron** per ADR-148 §D4 (T3, `t-e9424574`): new `atmux lane-stall-tick` verb fires every 5min by default (override via `cron-install --template lane-stall-watch --interval <N>`). Scans `lane=X todo` Tasks older than `laneStallMinAgeSec` (default 30min) against per-member cadence verdicts; when ALL lane-affinity members have verdict ∈ {idle, dormant, ship-zero-window}, fires Enter-push `atmux claim <id>` to the lane's most-recently-active member's pane. Pane-state check mandatory before send-keys per CLAUDE.md (uses `safeSendKeys` for classify + retry + refuse). On refuse, appends to `<atmuxDir>/state/lane-stall-flags.md` for operator review. Dedup via `~/.atmux/state/lane-stall-fires.json` with `(taskId, lane, firedAt)` rows; skips re-fire within `laneStallMinAgeSec / 2` (15min default).
- **Sibling to ADR-127** lane-claim auto-pickup. ADR-127 handles the `member-idle` event (member finishes a turn → cron injects `claim --next`); ADR-148 §D4 adds the `lane-stall` event (Task waits in lane while members idle). Both paths converge on the same `atmux claim` Enter-push; lane-claim is per-member-state, lane-stall is per-Task-age.
- **Cadence verdict source** stubbed at the verb's dep-injection layer until T5 (`src/core/cadence-classifier.ts`) lands — defaults to `"idle"` for every member (worst-case fall-through; lane-stall fires whenever the age + lane-membership gates trip). T5 swaps in the real `classifyMemberCadence` reading per-member `git log --since=<windowSec>s --format='%H %ct'`.
### 📋 Proposed — cross-team complaint storage (ADR-150)

- **ADR-150: cross-team complaint storage semantics — target-team-authoritative writes (proposed)** ([docs/adr/150-cross-team-complaints-routing.md](docs/adr/150-cross-team-complaints-routing.md)). `atmux complaints file --target-team <t>` becomes AUTHORITATIVE for storage: the row is written to the TARGET team's `state.db` via cockpit-registry `atmuxDir` lookup, not the filer's; `origin_team` is set to the filer's `team.name`. Backward-compat preserved when `--target-team` is absent (current behaviour: filer's DB, `origin_team=NULL`). Resolve walks all teams in the cockpit registry (cheap; O(N) at fleet scale) — no globally-unique-ID-by-prefix routing. Listing: default returns rows received by current team; `--sent-by-me` walks the cockpit registry to surface rows where `origin_team === <current-team-name>` across all teams. New helper `lookupTeamAtmuxDir(cockpit, teamName)` reuses existing `walkSessions` DFS (per ADR-089); refuses on multi-match (operator config error) — silent first-pick rejected. New `complaints.origin_team TEXT NULL` column (nullable, optional in Zod; forward-only additive migration). Permission model is open in v1 (any team may file against any other); allowlist deferred to future ADR. Singular alias `atmux complaint` deferred to optional T7 (UX polish, not load-bearing). All 6 §Decision-anchor pre-flags folded (no bidirectional writes / walk-all-teams resolve / cockpit-registry O(N) cheap / `origin_team` nullable / refuse-on-multi-match / singular alias deferred). Kanban Task `t-3b65330b` (T1 doc; T2–T8 staged impl). Foundation routing primitive for ADR-152 cross-team aggregation + ADR-153 cross-team R1 (both currently deferred per their respective §Out of scope).

### 📋 Proposed — auto-promotion rules (ADR-153)

- **ADR-153: auto-promotion rules — kanban-blocked → complaint (24h) / driver-inbox → flag (12h) / lead-outbox → inbox_messages (6h) + `blocked_at` column (proposed)** ([docs/adr/153-auto-promotion-rules.md](docs/adr/153-auto-promotion-rules.md)). Three deterministic, idempotent, cron-driven rules that auto-promote stale signals from low-visibility to high-visibility surfaces. R1: kanban Tasks at `status=blocked` aged >24h auto-file a complaint with `blocker_class="dep-not-shipped"` default (override via `[blocker_class:X]` Task-body marker); auto-resolves when the Task transitions out of blocked. R2: driver-inbox rows with no triage glyph aged >12h auto-append a `[stale-inbox]` flag entry (one-shot, persists until manual `atmux flag resolve`). R3: lead-outbox `## Open` rows unacked >6h auto-emit a heads-up via `inbox_messages` (dedup'd by `relates_to_outbox` predicate; auto-archives via existing `atmux outbox --ack`). New `tasks.blocked_at INTEGER NULL` column set in same transaction as `status='blocked'` UPDATE; existing-row backfill heuristic `blocked_at = claimed_at` is an acknowledged cut-over compromise. Wires into existing whip cycle (extended turn appends `runGroomPass()` — no new cron line); standalone invocation via `atmux groom [--rules R1,R2,R3] [--dry-run]`. Thresholds configurable per-team via `team.json.groom.autoPromotionThresholds` (`r1Hours`/`r2Hours`/`r3Hours`), fleet-default via `cockpit.json`. Every rule carries a `NOT EXISTS (... opened_via=<rule-id> ...)` idempotence predicate — reviewer's load-bearing audit-row. All 8 §Decision-anchor pre-flags folded (default class + idempotence + cron-not-write-hook + flag-stays-one-cycle + backfill compromise + configurable thresholds + cross-team deferred + R3 dedup). Closes complaint `c-33475fd6` (originator: driver-claude-sopx /bruh sweep 2026-05-16 00:17 MYT). Kanban Task `t-28a75ee5` (T1 doc; T2–T7 staged impl). Temporal-overlay sibling of ADR-152; foundation freshness signal for ADR-151 (unblocker).

### 🟢 Shipped — proposed ADRs
- **ADR-152: atmux blockers list unified verb (proposed)** ([docs/adr/152-atmux-blockers-list-unified-verb.md](docs/adr/152-atmux-blockers-list-unified-verb.md)). New `atmux blockers list [--json] [--class <c>] [--source <s>] [--max-age <duration>]` verb fans across the 7 coordination surfaces (kanban / complaints / flags / driver-inbox / lead-outbox / decisions / todo) and emits normalized rows `{id, source, opened_at, age, summary, blocker_class, suggested_action, related_task_id?}`. 8-value `blocker_class` closed enum: `decision-pending` / `member-stuck` / `cross-lane-WIP` / `tooling-broken` / `stale-claim` / `dep-not-shipped` / `review-pending` / `push-policy-gate`. READ-ONLY aggregation layer — markdown surfaces stay markdown; SQLite surfaces (kanban, complaints) gain one additive `blocker_class` column; works BEFORE AND AFTER ADR-154 storage port. Closes complaint `c-1d28fc72` (originator: driver-claude-sopx 2026-05-15). Kanban Task `t-94a1c95e` (T1 doc; T2–T6 staged impl). Foundation for ADR-151 (unblocker) + ADR-153 (auto-promotion) + ADR-154 (storage port).

### 📋 Proposed — ombudsman role + release-notes layout (ADR-147)

- **New per-team role `ombudsman`** per [ADR-147](docs/adr/147-ombudsman-and-release-notes.md) §D1 — adjudicates open complaints (filed by medic / whip-velocity-gate / operator / CLI) and writes a durable response log to the day's release-notes file. Closes the parking-lot task `t-441d6d4c` reframed as the EPIC umbrella.
- **Event-driven wake** per ADR-147 §D2: sentinel file `.atmux/state/ombudsman-pending.json` + 15min `atmux ombudsman tick` cron line. NOT in whip cadence — lane-tick must NOT inject `claim --next --as ombudsman`.
- **Adjudication authority** per ADR-147 §D3: file epic / file task / wontfix / already-addressed / defer. Every action appends a one-line entry to today's `docs/release-notes/<Y>/<M>/<Y-M-D>.md` under `## Complaints adjudicated`.
- **New release-notes layout** per ADR-147 §D4: `docs/release-notes/<YYYY>/<MM>/<YYYY-MM-DD>.md` with append-only sections (`## Shipped`, `## Merges`, `## ADRs landed`, `## Complaints adjudicated`, `## Doctor regressions`, `## Notes`). Each section is owned by a specific agent (gitter for Shipped + Merges, ombudsman for Complaints, medic for Doctor regressions). First writer of the day creates the file; section headers act as natural insertion anchors so concurrent appends stay conflict-free.
- **Entry-point**: new `docs/release-notes/README.md` documents the layout + browsing convention + auto-generated 30-day TOC.
- **Doctor probe `release-note-missing`** (warn-class) per ADR-147 §D5 — fires when today has ≥1 trunk commit AND `docs/release-notes/<Y>/<M>/<Y-M-D>.md` does not exist. Backstop for missed days; not a gate.
- **Status: proposed** until ADR-147 T9 dogfood gate (atmux-team's first day-file lands cleanly + 3 known open complaints adjudicated by ombudsman, not operator).

### 🏷️ Renamed — cockpit naming convention (ADR-135)

- **Cockpit session renamed** from `atmux_teams` to `atmux_cockpit` per [ADR-135](docs/adr/135-cockpit-naming-convention.md). New default for `cockpit.json::cockpitSession`; the literal `atmux_teams` is accepted during the deprecation window with a one-line warning (`deprecated literal, rename to atmux_cockpit per ADR-135`).
- **Cockpit-role windows gain underscore prefix**: `superdriver → _superdriver`, `medic → _medic`, `martinet → _martinet`. Per-team viewer windows stay plain (no underscore). Single-underscore signals "cockpit system role" and sorts before plain team names in `tmux list-windows`. Double-underscore remains reserved for atmux-internal placeholder windows (`__home`, `__driver` in `start.ts`).
- **Member windows gain hyphen separator**: `buildWindowName` emits `<emoji>-<member>` (was `<emoji><member>`). Examples: `🧭-lead` (was `🧭lead`), `📦-whip-impl` (was `📦whip-impl`). Symmetric with hyphenated member names already in use (`whip-impl`, `parity-cron-impl`); regex/tab-completion-friendly; no shell-quoting hazard around variation-selector emoji like `🛠️`.
- **Migration is in-place + idempotent**: `atmux cockpit rebuild` detects legacy `atmux_teams` session + non-underscored cockpit-role windows and renames them via `tmux rename-session` + `tmux rename-window` (preserves pane PIDs, attached clients, scroll history). `atmux start` (or `atmux team rebuild --force-cycle`) applies the member-window hyphen migration the same way. Re-running rebuild after migration is a no-op.
- **Cron migration**: `atmux cron-install` idempotently rewrites emitted cron lines that reference the old session/window names (`atmux_teams:medic` → `atmux_cockpit:_medic`, etc.), same pattern as ADR-133 TR6.
- **No state-file migration**: `cockpit.json` is a value-level (string-literal) field, not a key-level change; legacy literal accepted with warning during the deprecation window. After one semver bump (timeline TBC), the literal becomes a hard error pointing at ADR-135.

### 🏷️ Renamed — `superdoctor` → `medic` (ADR-133)

- **Cockpit self-healing role renamed** from `superdoctor` to `medic` per [ADR-133](docs/adr/133-medic-rename.md) to eliminate the `atmux doctor` verb-vs-process naming collision. `medic` is collision-free and semantically tight for the cockpit-fleet-healer role.
- **Operator-visible surface:** `cockpit.json.medic` is the new canonical config block. The legacy `cockpit.json.superdoctor` key is still accepted during the deprecation window — `atmux cockpit rebuild` emits a one-line deprecation warning (`deprecated key, rename to medic per ADR-133`) but proceeds normally. If both keys are present, `medic` wins and a warning lists `superdoctor` as ignored.
- **Window 2** of the cockpit session is renamed `medic` (was `superdoctor`).
- **Docs:** `docs/superdoctor.md` → `docs/medic.md`. Cross-refs in ADR-081 / ADR-079 / ADR-086 updated with first-occurrence footnotes citing the rename. ADR-077 carries an annotation header per the append-only ADR convention (the file is not renamed).
- **Out of scope this release:** storage-layer identifiers — `superdoctor_attempts` table, `SuperdoctorAttemptsRepo` class, `__superdoctor__` member sentinel, `superdoctor-self-heal-escalation` Discord dedup key, `src/core/superdoctor-activity.ts` source path, `~/.claude/skills/superdoctor/` skill path, and `[superdoctor]` Discord template prefix all remain unchanged. Schema renames require a separate migration ADR; skill source + Discord template renames ship under EPIC `t-d25ff629` TR5+.

### ⚙️ Migration — `atmux superdoctor` → `atmux medic` cron-line rewrite (ADR-133 TR6)

- **`atmux cron-install` now idempotently rewrites any `atmux superdoctor [args]` cron line inside an atmux-managed block** (`# >>> atmux:team=...` / `# >>> atmux:cockpit`) to `atmux medic [args]`. No-op on every current installation (atmux does NOT write `atmux superdoctor` cron lines today — the cockpit superdoctor runs via tmux pane keystroke `/loop /superdoctor`, not crontab), but forward-compat for the deprecation window if any path begins emitting them or if operators have hand-installed legacy lines inside a managed block.
- **Operator-manual cron lines OUTSIDE atmux-managed blocks are PRESERVED** — the migration only touches lines fenced by the `# >>> atmux:...` / `# <<<` markers.
- **Audit log** at `~/.atmux/state/cron-rename-migration.log` records every rewrite (no-op on installs where no migrations fire).
- Source: `src/core/cron.ts::migrateSuperdoctorToMedicCronLines` (pure transform) + `src/verbs/cron-install.ts` wiring + unit + integration tests.

### ⚠️ Deprecated — `cockpit.json.superdoctor` block (ADR-133)

- The `superdoctor` key in `~/.atmux/cockpit.json` is **deprecated as of this release**. Operators should rename their cockpit config to use the new `medic` key. The deprecation window is **one release cycle**; the next release ships the BREAKING removal below.
- Migration path:
  ```bash
  # in ~/.atmux/cockpit.json, rename the block:
  # before: "superdoctor": { ... }
  # after:  "medic": { ... }
  atmux cockpit rebuild
  ```
- The deprecation warning fires on every `atmux cockpit rebuild` until the rename ships. Silent on `atmux status` / `atmux doctor` for now.

### 🚨 Coming next release — BREAKING: drop `cockpit.json.superdoctor` key (ADR-133)

- **Next release will REMOVE the `superdoctor` key acceptance from `cockpit.json` schema.** Operators on the legacy key will fail-fast on `atmux cockpit rebuild` until they migrate. The deprecation warning shipping this release is the operator's one-cycle migration window.
- Plan ahead: rename `superdoctor` → `medic` in your cockpit config before upgrading past the next release. Schema validation will reject the legacy key with a clear error pointing to ADR-133.

### ✨ Added — `atmux pulse` (ADR-086)

- **`atmux pulse`** — cockpit-wide deterministic verdict probe. Iterates every enabled team in `~/.atmux/cockpit.json`, gathers commit count + doctor red count + kanban / driver-inbox / pending-decisions inputs, computes one of five verdicts (`🟢 Shipping` / `🟡 Cool` / `🟡 Idle` / `🔴 Stalled` / `🚨 Need you`), and pings Discord on verdict change or sustained-urgency dedup expiry. Phase 1 of the MiniMax observer (Phase 2 swaps the renderer for an LLM call against the same input bundle).
- **New Discord template `pulse-verdict`** in `src/abstractions/discord.ts` — verdict-first format with per-verdict header emoji (💓 / 📊 / 🛑 / 🚨).
- **New cockpit schema field `pulse`** (`windowMins` / `intervalMins` / `dedupMins`, defaults 30 / 5 / 30).
- **New state file** `~/.atmux/state/pulse-state.json` — cockpit-scoped, one row per team, dedup via `shouldFire(prior, current, now, dedupMins)`.
- **Auto cron install** wired into `atmux cockpit rebuild` Phase 6 — a new `# >>> atmux:cockpit` marker-fenced block (distinct namespace from per-team blocks) lands `*/5 * * * * atmux pulse` idempotently every rebuild. Honors `ATMUX_NO_CRON=1` + cockpit.pulse.intervalMins override. Manual install line preserved in `docs/RUNBOOK-pulse.md` for operators who don't run `cockpit rebuild`.

## [0.5.0] — 2026-05-08

> Themes: **pull-model kanban** (Epic 1, see ADR-007)
> — Epic/Story/Task data model, lane-aware `claim --next`, auto-dispatched
> commit-Tasks, Story-level reviewer signoff, `atmux decisions add` verb;
> plus **whip Since-last-tick delta enrichment + richer decisions** (Epic 2,
> see ADR-009 §S7–§S10 + ADR-008 §S9–§S10) — per-bullet renders for done-
> tasks/commits/advanced-stories with `[E#/S#]`/`<sha>`/`<sid>` anchors,
> `story.advancedAt` schema field, decisions verb gains 4 optional fields
> (`--context` / `--option` ×5 / `--impact` / `--decided-by`) with section-
> aware multi-message Discord chunking + `[N/M]` headers; plus **auto-rotation
> infrastructure** (ADR-009 §S1–§S5) — opt-in `team.whip.autoRotate` flag,
> per-member rotated.epoch anchor, banner preclear; plus **`atmux flag` verb**
> (Epic 4, see ADR-010) — member→lead structured issue surfacing with p0
> Discord gating + `--task --needs unblock` atomic blocked-state mutation;
> plus **hot reload** (Epic 3, see ADR-011) — `atmux brief-reload`,
> `atmux config-reload`, `atmux verify-libs`, versioned briefs with whip
> auto-detect (verbs 3 + 6 carved to recommended **E5** for pane lifecycle +
> per-claim state work).

### ✨ Added — post-0.6.0 follow-ups

- **ADR-148 T5 — commit-cadence classifier lifted + martinet observation cadence field + per-member E6 escalation** (t-ac95b267).
  Lifts the inline cadence classifier T2 (t-1d370b04) inlined in `src/verbs/status.ts` into a shared `src/core/cadence-classifier.ts` module so martinet observe() + future medic + doctor consumers all read one contract. `status.ts` re-exports the public surface (`CadenceObservation`, `CadenceThresholds`, `classifyCadence`, `defaultGitLog`) so pre-T5 importers stay valid. New `classifyMemberCadence(member, worktreePath, config, deps)` async wrapper composes the canonical `git -C <path> log --since=<N>s --author=<member> --format=%H %ct` probe with the pure classification step — sinceSec capped at `max(windowSec, dormantMax)` so the probe sees the actual last commit even when it falls outside `windowSec` (needed for `ageOfLastCommitSec`). Fail-soft probe (returns `[]` on any git error) per T2's status.ts contract; injectable for tests. Martinet `Observation.members[].cadence?: CadenceObservation` field added — composed by the cockpit-W3 dispatcher (T7/T8 wire-up; the type extension is the load-bearing surface). Escalation classifier `src/core/martinet-escalation.ts` extended: alongside the pre-existing team-aggregate `commitCadence.last2hr === 0` path, ANY member's `cadence.verdict === "ship-zero-window"` now fires the `ship-zero-2hr` reason (closed `EscalationReason` enum unchanged — both paths share the literal so the dispatcher's evidence threading stays bounded). `else if` short-circuits the second path so the reason fires exactly once even when both gates trip. Same-commit unit tests: 15 cases under `cadence-classifier.test.ts` covering the full §D2 verdict matrix (shipping / idle / dormant / ship-zero-window with precedence + boundary + empty-log + malformed-line + clock-skew edge cases), the async wrapper's `sinceSec = max(windowSec, dormantMax)` cap, and clock injection; 5 new cases under `martinet-escalation.test.ts` covering the per-member ship-zero-window E6 path (HIT with mixed roster + NEAR-MISS shipping/idle verdicts + reason-deduplication when both team-aggregate AND per-member paths fire). Same-commit docs: `docs/ARCHITECTURE.md` cadence-classifier module-map entry. **Deferred to follow-up** (explicit scope-trim per driver's `/team rotate-lead` at 30% ctx guidance — single focused commit): (a) Discord `[ship-zero-window]` named template — light additive `src/abstractions/discord.ts` extension when the operator-facing render is needed; (b) medic event-driven pickup — ADR-148 task body's spec is "concrete site decided at impl time" between `src/verbs/medic.ts` vs the medic skill brief; not load-bearing for §E6 gate firing. The deferred work is captured in the follow-up TODO chain; T5 closes here with classifier + martinet E6 wire-up green per the load-bearing ADR-132 §E6 contract. typecheck clean; biome lint clean; bun-test gated per `feedback_pause_bun_tests` memory.

- **ADR-134 T4 — `atmux gitter --sweep` cron backstop + `team.autoMerge` schema** (t-64e52aac).
  Per-team cron-fired sweep catching merge attempts missed by the T3 event-driven socket-pubsub path. New `src/verbs/gitter.ts` hosts the `--sweep` sub-verb (also accepts `sweep` positional form for cron-line ergonomics); `src/core/gitter-sweep.ts` is the pure eligibility-analysis layer. Sweep flow: `git -C <teamRoot> branch --list --format=%(refname:short) <baseBranch>-*` enumerates candidates → per-candidate `rev-list --count <base>..<member>` filters to ahead-of-base → `MergerStateRepo.getState(memberBranch)` consultation classifies in-flight (`in_progress`/`ready_to_merge`/`rebasing`/`merging`/`tested`/`test_failed`) vs queue-eligible (terminal `merged`/`conflict`/`reverted` with fresh tip, OR `open`/null) → injected `QueueMergeFn` callback fires the merge attempt. Returns `GitterSweepResult` with per-branch entries + aggregate `checked/queued/skipped/refused` counts; verb-layer logs a one-line summary + per-entry detail to the cron log. Idempotent — re-running when every branch is merged or in-flight is a zero-op pass; `BEGIN IMMEDIATE` transactions in `MergerStateRepo.transition` (per ADR-091 reviewer pre-flag) keep concurrent event-driven + cron-backstop firings on the same branch race-safe. New `TeamAutoMerge` Zod schema landing the full ADR-134 §Config surface (`enabled`, `requireReviewerSignoff`, `skipTestGate`, `testCommand`, `revertOnFail`, `cronBackstopMin`, `maxMergesPerHour`); only `enabled` is consumed by T4 (gate the verb), the rest are forward-compat for T6 gitter member impl + T7 cron-install template + T8 e2e. `team.autoMerge` distinct from existing `team.merger` (ADR-088 bulk merge-cycle) — both coexist; they serialize through the same `MergerStateRepo` shared state machine. `DEFAULT_AUTO_MERGE_CRON_BACKSTOP_MIN = 10` co-located with schema for T7 cron-install consumption. **Sibling-task layering**: the production dispatcher (T3 / t-27b06cda event-driven, parallel work) hasn't shipped — until it lands, T4's `queueMergeAttempt` default factory uses `recordingQueueMergeAttempt` which logs queue intent + returns `{queued: true}` so the sweep emits useful evidence without crashing. When T3 ships, the verb-layer factory swaps the real dispatcher in; the sweep core stays unchanged. CLI dispatch registered at `case "gitter"` in `src/cli.ts`. Same-commit unit tests: 16 cases under `gitter-sweep.test.ts` covering branch enumeration (empty / git-failure / glob format), ahead-of-base check (0 / >0 / non-numeric / non-zero exit), in-flight state recognition (each of 6 in-flight literals + `open` as initial), terminal-state + fresh tip semantics (3 terminals × queue-eligibility), dispatcher refusal (with-reason + without), multi-branch aggregate matching the task body's 3-member acceptance ("2 ahead, 1 already merging → queues exactly the 1 missing"), and idempotence (second sweep after recorded transition skips). 11 cases under `gitter.test.ts` covering arg parsing (--sweep / sweep / --team-dir / errors), recordingQueueMergeAttempt logging, verb integration (autoMerge.enabled !== true → no-op exit 0, autoMerge unset → no-op, 2-branch dispatch + queue + summary log, default factory falls back to recording stub), top-level gitter() dispatch. typecheck clean; biome lint clean; bun-test gated per `feedback_pause_bun_tests` memory.

- **ADR-147 T3 — `atmux cron-install --template ombudsman-tick` + role-gated cron line** (t-94a22bb0).
  Extends `cron-install` to emit a per-team `atmux ombudsman tick` cron line for the ADR-147 complaint-adjudicator role. New `--template ombudsman-tick` flag is the operator-facing "I'm installing for the ombudsman role" assertion — validates `team.ombudsman.enabled === true` at install time (`ConfigError` with hint citing ADR-147 + the role-member step if not). Mirrors the ADR-088 W7 `--template merge-cycle` gating pattern verbatim. The `--interval Nm|Nh` flag now opts in via the new `TEMPLATES_WITH_INTERVAL` allowlist (`merge-cycle` + `ombudsman-tick`); the parsed value threads through `installCronBlock` as `ombudsmanIntervalOverride` (new field on `RenderCronBlockOpts`), wins first against `team.ombudsman.tickIntervalMins`, then the schema's `DEFAULT_OMBUDSMAN_TICK_INTERVAL_MINS` (15 per ADR-147 §D2). `--interval` is transient — `team.json` on disk is not rewritten (unit-tested). The line shape: `<cronEvery(N)> PATH=… ATMUX_DIR=… /usr/local/bin/atmux ombudsman tick >> <atmuxDir>/logs/ombudsman.log 2>&1` — relies on `ATMUX_DIR` for team resolution (consistent with other cron lines; the verb's `requireTeam` reads from env). The ADR's `--team <team>` shorthand reframed as `ATMUX_DIR`-via-baseEnv per the verb's actual `--team-dir <path>` signature. **Renderer gating** (in `renderCronLines` step 9): line emitted IFF `team.ombudsman.enabled === true` AND `team.members[]` contains an entry with `role: "ombudsman"`. Absent either, the line is suppressed silently — matches the `unblocker` precedent of gating cron output on member-roster presence. The template-flag validation surfaces the `enabled` half at install time (operator-friendly fail-fast); the member-role half stays at the renderer (adding/removing a member is a separate team-config step). Bare `cron-install` (no `--template`) on an enabled+member team STILL emits the line — the template flag is the assertion, not the gate. Same-commit unit tests (10 cases): `--template ombudsman-tick` emits expected line shape with default cadence; `enabled=false` rejects with `ConfigError`; no-block-at-all rejects with hint; `--interval 5m` overrides cadence; `--interval` transient (team.json byte-identical pre/post); `team.ombudsman.tickIntervalMins=30` honored when --interval omitted; bare install on enabled+member team emits line; enabled=true but no role=ombudsman member → line absent; enabled=false → line absent; idempotent re-install → byte-identical body. `CRON_INSTALL_TEMPLATES` allowlist updated to `["merge-cycle", "ombudsman-tick"]`. typecheck clean; bun-test gated per `feedback_pause_bun_tests` memory.

- **ADR-132 T3 — `CursorMartinet` impl + cockpit cursor cage wiring** (t-e96d286a).
  Production-default pluggable martinet impl shipping as `src/abstractions/martinets/cursor.ts` per [ADR-132 §D4](docs/adr/132-pluggable-martinet.md) + [ADR-140](docs/adr/140-cheap-model-first.md) cheap-model-first principle. Cage-agnostic class — the dispatcher injects `runCursorAgent` (default factory shells out to `cursor-agent --print --output-format json --model composer-2-fast --force <prompt>` via `src/abstractions/spawn.ts`) and `sendKeys` (defaults absent → `apply()` returns success=false with diagnostic evidence rather than silent no-op). `decide()` always invokes runCursorAgent at least once per tick (T7 e2e Case 5 invariant), parses the canonical `{type, subtype, is_error, result, usage}` envelope, validates the nested `result` JSON as `NudgeAction[]` via Zod, and re-attaches the live `Observation` to escalate-to-claude-lead emissions. Fail-loud paths (spawn throw / unparseable envelope / schema mismatch / `is_error: true` / invalid action shape) all funnel to a single escalate-to-claude-lead carrying a diagnostic reason — no silent regressions on broken-binary scenarios. `shouldEscalateToClaudeLead()` composes T6's `classify()` + `shouldEscalate()` with an empty-history fallback so unit tests that carry only the current Observation exercise the E6 mandatory floor + E2 P0-hygiene gate; `historyFn` injection drives the temporal gates (E1 / E3 / E4 / E5) for the cockpit-tier dispatcher. NudgeAction kind mapping (per task body's six-kind expanded set, mapped onto the four T2 interface kinds): `enter-push` → 1:1; `claim-next` → 1:1; `rotate-routine` → emit `rotate` with reason="routine" per ADR-140 amendment; `modal-release` → emit `enter-push` with reason="modal-release"; `force-push-approved` → emit `escalate-to-claude-lead` (destructive git ops are operator-only per CLAUDE.md push policy); `escalate-to-claude-lead` → 1:1. Verb wiring: `src/verbs/martinet.ts::buildMartinet` constructs `CursorMartinet` when `impl === "cursor"` and threads `cockpit.martinet.cursorBinPath` + `cockpit.martinet.model` into the default spawn factory; existing fleet-default-fallback path warns and falls back to `ClaudeMartinet` only on a forward-compat unknown impl literal. Cockpit window: `src/verbs/cockpit.ts::buildMartinetWindowCommand` cursor variant emits `while true; do atmux martinet tick; sleep 270; done` (no Claude TUI — cursor-agent is a `--print` CLI; the bash loop owns cadence at the W3 window). Cage posture: the cockpit W3 window itself runs as operator UID with full git access per ADR-058 §D1 trust posture — no separate per-team `/tmp/atmux_cursor_martinet_<team>/sock` cage is provisioned (martinet is fleet-wide singleton; per-team cage paths in the original t-e96d286a body predated the §D2 fleet-singleton reshape). Same-commit unit tests: `tests/unit/abstractions/martinets/cursor.test.ts` exercises constructor name + default + override model, observe pass-through, decide happy path (CLI args + multi-line stream-json envelope), six fail-loud branches, four apply variants (enter-push, claim-next, rotate, sendKeys-missing diagnostic), and §D5 gate (E6 mandatory + clean-state false + E2 wedge + E1 historyFn temporal gate); `tests/unit/verbs/martinet.test.ts` updated to assert cursor branch constructs `CursorMartinet` (was: falls back to claude with warn) plus cockpit-binPath-override coverage; `tests/unit/verbs/cockpit.test.ts` adds `buildMartinetWindowCommand` claude-variant + cursor-variant assertions; `tests/e2e/cursor-martinet.test.ts` static import replaces the dynamic-import + `@ts-expect-error` shim per the test's documented "remove when t-e96d286a ships" trip-wire. typecheck clean; bun-test gated per `feedback_pause_bun_tests` memory.

- **ADR-088 W8 — end-to-end merger-fan-in e2e test** (t-7a7f0825).
  `tests/e2e/merger-fan-in.test.ts` walks the full ADR-088 fan-in path against a real git repo with a bare remote + per-member worktrees + 3 members on `develop-<member>` branches: (1) `merge-cycle --dry-run` lists 3 prospective merges without git mutation; (2) `merge-cycle --push` lands all 3 clean + base advances ≥3 commits + remote receives push; (3) conflict isolation — when two members modify the same line of README, the conflict is contained to one member's branch, the sibling still merges, and a `merger-conflict` flag with `severity=high` lands in `flags.md`; (4) doctor's `merger-branch-stale` probe — backdating a member's tip via `GIT_COMMITTER_DATE` triggers a yellow row from `checkMergerFanIn`; (5) fresh commits do NOT fire the stale probe. Uses `develop` as base (non-staging-shaped) so the push-policy gate doesn't refuse; teams using `main`/`master`/`<x>-staging` see `refused-by-policy` per the W2 push-policy contract. Non-idempotent (per CLAUDE.md "stateful e2e specs are not repeatable smokes") — each test cold-starts a fresh mkdtemp'd repo. `.gitignore` in the fixture excludes `.atmux/` so W1's `guardBaseWorktreeClean` doesn't refuse the merge. 5 e2e cases passing. Out-of-scope (defer to a follow-up sibling e2e): `atmux stop --force` cleanup verification — the stop verb's session/tmux state probes are heavy and orthogonal to fan-in correctness. This commit also cherry-picks W5 (templates/briefs/merger.md, t-ab5e31f6) and W6 (doctor merger-fan-in probes, t-81fca58f) from sibling worker branches (`geoyws-parity-state-impl`, `geoyws-up-impl-2`) — needed locally to write the W8 e2e and unblock the chain ahead of gitter's natural merge cycle (operator-authorized cross-lane cherry-pick under the "ship it" policy).

- **ADR-088 W7 — `atmux cron-install --template merge-cycle [--interval 5m|15m|1h]`** (t-2f12839e).
  Extends `cron-install` to emit a `merge-cycle` cron line in the team's standard marker-fenced block. Gated on `team.merger.enabled === true` — operators flip the schema field to opt in. New schema field `team.merger.cycleIntervalMins` (optional, integer minutes) sets per-team cadence; default 15min when unset (matches ADR-088 §Decision-5 default). The new `--template merge-cycle` flag is the operator-facing "I'm installing for merge-cycle" assertion — it validates `merger.enabled === true` at install time (fail-fast `ConfigError` if not set, with a clear hint). The `--interval <N>m|<N>h` flag accepts transient cadence overrides (parsed via the new exported `parseIntervalToMins` helper; rejects bare numbers + 0 + negative + garbage); threaded through `installCronBlock` → `renderCronLines` as `mergerIntervalOverride` so the operator can pin a one-off cadence without rewriting team.json. The merge-cycle line shape: `<cronEvery(N)> PATH=… ATMUX_DIR=… /usr/local/bin/atmux merge-cycle --push >> <atmuxDir>/logs/merge-cycle.log 2>&1`. Idempotent re-install yields byte-identical body. 16 new unit tests covering parser (--template / --interval allowlist + mutual deps + bad input), the new `parseIntervalToMins` helper, and the cronInstall verb's integration paths (enabled-true emits line, enabled-false skips, --interval overrides, idempotence). Unblocks W6 (doctor probe consumes the same gate).

- **ADR-088 W3 — `atmux merge-cycle [--push] [--dry-run]` bulk wrapper** (t-d78127c7).
  Single-shot bulk-merge across every `<base>-<member>` branch in one cycle. Flow: `git fetch origin` once → `git branch --list "<base>-*"` enumerate → per-candidate `git rev-list --count` pre-filter (skip 0-ahead) → W1 primitive call with `fetch: false` (avoids redundant fetch per branch) → per-branch conflict captured but cycle CONTINUES (per ADR-088 §Decision-4 "On conflict per-branch: continue iteration"). Summary at end: `{ merged: [...], noOp: [...], conflicts: [...] }` + (when `--push`) ONE push of `<base>` at cycle-end covering all merges that landed (overrides ADR §OQ-3 default "per-merge" for cycle mode since the cycle is the atomic unit). `--dry-run` lists prospective merges without git mutation; mutually exclusive with `--push`. CLI dispatch registered at `case "merge-cycle"` in `src/cli.ts`. 28 unit tests / 98.55% line coverage. Exit-code contract: `0` on clean cycles + push-refused-by-policy; `1` on any conflict OR push-failure. Unblocks W5 (merger brief), W7 (cron template), W8 (e2e).

- **ADR-088 W2 — `atmux merge-member <member> [--push]` verb wiring** (t-e7724527).
  Wraps the W1 primitive with the policy + surfacing layer. Steps: `requireTeam` → `resolveMergerConfig` to get `baseBranch` (explicit or via current-HEAD) → `wtBranch = ${base}-${sanitizeBranchSegment(member)}` → W1 primitive → outcome handling. Exit-code contract: `0` on merged / no-op / push-refused-by-policy; `1` on conflict / push-failure. Flag surface: appends to `<atmuxDir>/flags.md` (`severity=high` for conflict + push-failure; `severity=medium` for push-refused). Push policy: reuses `isPushAllowed` from `src/core/auto-push.ts` — same staging-pattern regex (`-staging$`, `^main$`, `^master$`, `^production$`) gates both `atmux done` auto-push + merger fan-in push. Refused pushes keep the merge locally + raise a flag for operator's manual follow-up. CLI dispatch registered at `case "merge-member"` in `src/cli.ts`. 20 unit tests / 99.15% line coverage. Unblocks W3 (`merge-cycle` bulk wrapper) + W5/W6/W7/W8 downstream.

- **ADR-088 W1 — `src/abstractions/branch-merge.ts` `mergeMember(base, wtBranch, repoPath, opts)` primitive** (t-bed51da2).
  Per-member branch fan-in primitive ([docs/adr/088-per-member-branch-fan-in.md](docs/adr/088-per-member-branch-fan-in.md) §Decision-3). Pure git-shell wrapper using the `GitSpawn` injectable pattern (mirrors `worktree.ts` / `auto-push.ts`); every invocation routes through `git -C <repoPath>` so the function is repoPath-agnostic at the spawn layer. Idempotent (returns `{ status: "no-op", reason: "no-commits-ahead" }` when re-fired post-merge). Three hard-refuse guards: `guardBaseWorktreeClean` (uncommitted changes), `guardBranchExists` (missing wtBranch), `guardCommitsAhead` (zero-ahead → no-op exit). On conflict: captures porcelain status for the conflicted-path list, fires `git merge --abort` to restore the worktree to clean, throws `MergeConflictError` carrying both `wtBranch` + `conflictPaths`. New `MergeConflictError` class extends `ConfigError`. Unit suite: 27 cases / 100% line + func coverage on the new module (mock-injected GitSpawn for every decision-tree branch; one real-git smoke against `defaultGitSpawn`). Gates 6 downstream ADR-088 W2-W8 tasks (verb wiring, bulk merge-cycle, brief, doctor probe, cron template, e2e).

- **`atmux complaints file` — whip-velocity-gate flag-vocab compat** (t-7bd53cba).
  Three new flags + one default-behavior change so cockpit-level whip
  cron scripts (`/root/.atmux/bin/whip-velocity-gate.sh`) can file
  complaints AGAINST observed teams without their entire CLI call
  failing at the first unknown arg:
  - **`--title <s>`** — alias for `--summary` (canonical field stays `incidentSummary`)
  - **`--body <r>`** — alias for `--root-cause` (canonical field stays `rootCause`)
  - **`--severity <s>`** — free-form severity classifier; stored in `extra.severity` (no first-class column)
  - **`--target-team` defaults to current team's name** when omitted (was: defaults to `null`). Preserves the pre-v3 implicit "complaint in team X's DB is about team X" semantics — cross-team callers still pass `--target-team` to file against a different observed team.
  - **`COMPLAINT_SOURCE_KINDS` allowlist** extended with `"whip"` and `"whip-velocity-gate"` so velocity-gate's `--source-kind whip-velocity-gate` doesn't reject.
  Acceptance: end-to-end smoke test mirroring the velocity-gate's exact CLI invocation lands a row recoverable via `complaints list --source-kind whip-velocity-gate --target-team <team>`. No schema migration required — uses the existing v3 `target_team` column + the existing `extra` JSON bag.

- **ADR-140 — cheap-model-first principle (Cursor composer-2-fast martinet; medic event-driven)** ([docs/adr/140-cheap-model-first.md](docs/adr/140-cheap-model-first.md)).
  ADR text only (T1 of EPIC `t-83dcef6b`). Principle: Claude (Opus
  xhigh) stays for strategic + code-gen + review work; Cursor
  composer-2-fast (via martinet, Tier 2 cage per ADR-058) handles
  ALL mechanical execution loops + uncomfortable-but-routine
  actions. Codifies the operator's 4-message arc on 2026-05-14
  (MiniMax + Kimi explicitly rejected — capability bar too low;
  Cursor composer-2-fast is the production-grade tradeoff).
  Includes canonical roles+responsibilities matrix (superdriver,
  medic, martinet, team-lead, planner/reviewer/workers, gitter)
  and a back-of-envelope token-burn projection: ~440k Claude
  tokens/hour mechanical → ~60k Claude + ~137k Cursor tokens/hour
  post-migration (~65–70% Claude-burn replaced by Cursor cost).
  Rotation authority split: routine triggers (context >400k,
  refusal-pattern, dormancy-window) → martinet; emergency
  triggers (broken claude proc, planner misalignment) → medic
  + lead. T2 — ADR-077/131/139 cross-reference annotations —
  shipped via Task `t-d16c99ae` (commit `ad47419`); ADR-132 was
  pre-annotated 2026-05-14. T3 (medic verb scan-loop → event-
  listener, `t-e057d8ff`, lane=be) + T4 (martinet `NudgeAction`
  enum extension, `t-1cc90cc0`, lane=be) filed and claimable
  for be-lane workers, both deps-cleared on T2. Kanban Task
  `t-83dcef6b` (EPIC; T1 + T2 done; T3 + T4 open).
- **ADR-138 — verified send-keys (verify-and-retry pattern)** ([docs/adr/138-verified-send-keys.md](docs/adr/138-verified-send-keys.md)).
  ADR text only (T1 of EPIC `t-5df48a74`). Decision: new
  `safeSendKeysWithVerify` helper in `src/abstractions/tmux.ts` —
  send once, capture pane, assert state transition via caller-
  supplied `PaneVerifier`, retry once on timeout, escalate to
  `~/.atmux/state/send-keys-failures.log` + doctor probe + Discord
  template `[send-keys-failure]`. Ships 6 built-in verifiers
  (`composerEmpty`, `agentThinking`, `modalClosed`, `contextNonZero`,
  `paneMatchesRegex`, caller-closure). Migration plan touches 6
  caller files (send / dispatch / lane-tick / start / rotate +
  driver modal-release helpers); direct `tmux send-keys` remains
  only for window-rename / layout commands. Rejected blanket-3x-Enter
  alternative inline — state-destructive at every pane mode (would
  submit empty prompts on composer, wrong defaults on modals, etc.).
  Cross-refs ADR-081 §A (C-m submit cascade — layer below) and
  ADR-132 (martinet — long-term home, inherits the helper). Sub-tasks
  T2 (helper impl + tests) and T3 (caller migration + e2e) filed
  under the EPIC. Kanban Tasks `t-5df48a74` (EPIC), `t-f58c6ccc` (T1,
  this commit).
- **ADR-136 — hot-rename member labels (Option B — id + label + emoji split)** ([docs/adr/136-hot-rename-member-labels.md](docs/adr/136-hot-rename-member-labels.md)).
  ADR text only (TR1 of EPIC `t-13367b7a`). Decision: add an optional
  `label` field to `TeamMember`; `name` stays the immutable ASCII ID;
  `atmux member rename` mutates `label` only. Display surfaces render
  `label ?? name`; id-keyed state (worktrees, branches, inboxes,
  kanban owner, lane-tick args, paused.json, resume.json) stays
  pinned to `name`. Option A (emoji-as-stable-ID) was rejected on two
  hazards documented inline — variation-selector trap
  (`🛠️` 2-codepoint vs `🛠` 1-codepoint), and
  `sanitizeBranchSegment` already strips non-ASCII at
  `src/abstractions/worktree.ts:189-195`. All 4 OQs settled in-spec.
  Cross-refs ADR-027 (team-rename sibling), ADR-030 (registry —
  accepts label drift), ADR-082+ADR-084 (worktree substrate uses
  name not label), CONVENTION-059 (id-layer; ADR-136 composes the
  display layer on top). Sub-tasks TR2–TR5 filed under the EPIC for
  schema + verb + display-fallback + e2e implementation. Kanban
  Tasks `t-13367b7a` (EPIC), `t-646bc535` (TR1, this commit).
- **cockpit-pulse meta-watchdog — bypass-page George when superdoctor itself is dormant** ([ADR-086 §Phase 2](docs/adr/086-atmux-pulse.md)).
  Extends the 5-min cockpit-pulse cron tick with an aggregate
  superdoctor-liveness probe. Walks every cockpit-enabled team's
  `state.db`, sums `complaints WHERE status='open'` and takes
  `MAX(superdoctor_attempts.attempted_at)` across teams. When at
  least one open complaint exists AND the latest attempt is ≥2h
  stale (or there's never been an attempt), pulse emits a new
  `[meta-watchdog]` Discord template — verdict-first 2-button menu
  (A: check superdoctor pane, B: kill+respawn) with a 30-min
  default deadline keyed off `whenMs`. Dedup is "1 page per
  dormancy streak": `pulse-state.json::metaWatchdog = { paged,
  dormantSinceSec }`; streak ends when a fresh attempt lands or all
  complaints clear. Closes the "if superdoctor itself goes silent,
  no one notices" gap left by ADR-077. (`src/core/superdoctor-activity.ts`,
  `src/abstractions/discord.ts::renderMetaWatchdog`,
  `src/core/pulse-state.ts::PulseMetaWatchdogSchema`,
  `src/verbs/pulse.ts`.) Kanban Task `t-351318dc`.
- **CONVENTION-059 — Generic indexed member naming** ([docs/CONVENTION-059-indexed-member-naming.md](docs/CONVENTION-059-indexed-member-naming.md)).
  Codifies the `<lane><index>` pattern (`fe0`, `fe1`, `be0`, `be1`,
  `ops0`, ...) for fungible team members — zero-indexed, no separator,
  one of the canonical lane prefixes (`fe` / `be` / `ops` / `test` /
  `review` / `db` / `misc`). Named roles (`lead`, `planner`,
  `reviewer`, `gitter`, `dba`, `devops`, `auditor`, `discorder`,
  `enforcer`, `unblocker`) keep their canonical names. Ships
  `checkIndexedMemberName` + `CONVENTION_059_LANE_PREFIXES` in
  `src/core/common.ts` — advisory-only validator, never throws.
  `templates/briefs/member.md` cross-references the convention for new
  brief consumers. Existing teams with non-indexed names (`whip-impl`
  on atmux, `eng-mobile` on unum, `fe-1` on sopx) keep their names
  until a deliberate migration cycle; the convention is forward-looking,
  not a forced rename. Kanban Task `t-05ad3bb4`.
- **CONVENTION-067 — `develop` branch for integration** ([docs/CONVENTION-067-develop-branch-integration.md](docs/CONVENTION-067-develop-branch-integration.md)).
  Workflow convention codifying the `feat/<topic>` and `<account>-<role>`
  worker branches → `develop` integration tip → `main` release-cut
  topology. First named convention doc in the project. Authored
  2026-05-14 after a docs worker hit a concrete cross-branch dep
  blocker — `t-289119f2` was marked `done` on the kanban (kernel commit
  `2a7db33`) but the kernel files lived on `geoyws-parity-cron-impl`,
  invisible to sibling worker branches. The convention defines the
  integration rhythm that prevents that drift: branch off `develop`,
  merge back to `develop` once green, pull from `develop` before
  claiming a dep-having task. Kanban Task `t-221eb576`.
- **Superdoctor self-escalation primitives** ([ADR-077 §F6](docs/adr/077-superdoctor-cockpit-role.md)).
  Without these, superdoctor silently loops while a team stays broken
  (rotate-lead swallowed under auto-mode; kill+respawn welcome-screen-gates;
  members idle 3h after rebuild). Ships three primitives the deferred
  `~/.claude/skills/superdoctor/` skill consumes: (a) SQLite migration
  v2→v3 materialising `superdoctor_attempts(complaint_id, attempt_n,
  outcome ∈ {resolved, partial, failed}, attempted_at, action, note,
  extra)` per-team — one row per structural-fix attempt with a CHECK
  constraint on `outcome`; (b) typed CRUD via `SuperdoctorAttemptsRepo`
  (`src/core/repositories/superdoctor-attempts-repo.ts`) — load-bearing
  query is `countByOutcomeFor(complaintId, 'failed')`, reaching 3 is the
  page-George trigger; (c) Discord template `[self-heal-failed]` +
  renderer `renderSelfHealFailed` (`src/abstractions/discord.ts`) —
  verdict-first ABC menu (`A` /team stop+start, `B` swap account,
  `C` park for the night) with a 30-min default deadline keyed off
  `whenMs`. Operator replies one letter from a phone. Dedup state lives
  in `state_kv` (feature `superdoctor-self-heal-escalation`, key per
  `complaint_id`, 1h re-fire window). Documented end-to-end in
  [`docs/superdoctor.md` § "Self-escalation when fixes keep failing"](docs/superdoctor.md).
- **`atmux stop --soft` + resume manifest** ([ADR-087](docs/adr/087-stop-soft-resume-manifest.md)).
  Graceful counterpart to bare `stop`. Reads kanban for in-progress Tasks,
  sends a `# soft-stop incoming — finish current operation, no new claims`
  send-keys comment to each non-shell member pane (enter-false so it lands
  in the compose box without auto-submitting), sleeps
  `team.softStopGraceSeconds` (default `5`), then atomic-writes
  `<atmuxDir>/state/resume.json` (mktemp + rename). The next `atmux start`
  surfaces a resume hint. First ADR in the team-of-teams ADR-087…092
  sequence; smallest scope, independent of the rest. (`src/core/soft-stop.ts`,
  `src/verbs/stop.ts`.)
- **`scanNeedsApproval` lib — approval-debt scanner** ([ADR-085](docs/adr/085-whip-approvals-watcher.md)
  §Scan API). New `src/lib/needs-approval.ts` exports
  `scanNeedsApproval(deps?) → NeedsApprovalReport` covering three buckets:
  (A) ADRs under `docs/adr/*.md` / `docs/adr/*.md` with `Status:
  proposed|draft|wip|pending` and no `(deferred: ...)` escape hatch;
  (B) `driver-inbox.md` headings missing `✅`/`📤`/`⏳`/`❌` triage marker
  (`🚨`/`🪫` don't count) and stale (`ageMin > 30`); (C) kanban tasks with
  `status='blocked'` stale beyond `ageMin > 120`. Each bucket is failure-
  isolated (one exception doesn't poison the report); all three reads are
  LIVE per ADR-068 §HC#4. Unblocks the whip §2.5 wire (t-21c3aa64) and
  status-verb row (t-9281649f).
- **`atmux groom` absorbs lane-drift-check** ([ADR-062](docs/adr/062-lane-claim-auto-pickup.md)
  §5). Daily 04:00 sweep gains a 6th sub-op — lane-drift detection across
  every team in the cockpit. Paired with the every-2-min cron lane-tick
  line (below) for fast-feedback drift detection inside the day; groom is
  the catch-the-stragglers pass for drift the cron missed (host suspended
  overnight, cron disabled by `ATMUX_NO_CRON`, pane classifier wedged for
  a window). The standalone `atmux lane-drift-check` verb stays — useful
  for operator ad-hoc diagnosis.
- **Cron emits `lane-tick` line + `crons.laneTickEnabled` kill-switch**
  ([ADR-062](docs/adr/062-lane-claim-auto-pickup.md) §Decision 4).
  `src/core/cron.ts::renderCronLines()` now emits a 7th line at end-of-
  block: `*/2 * * * * <baseEnv> lane-tick >> <atmuxDir>/logs/lane-tick.log
  2>&1`. Hardcoded `*/2` cadence per §OQ2 (tighter amplifies classifier
  bugs; looser dulls auto-claim chain). Gating requires BOTH ≥1
  `team.members[].lane` field set AND `team.crons.laneTickEnabled !==
  false` — teams without lanes see no line; per-team kill-switch lives in
  `team.json`.
- **Complaints schema v3 — provenance columns** (per [ADR-077](docs/adr/077-superdoctor-cockpit-role.md)
  §F2 follow-up). Per-team `complaints` table gains `source_kind`
  (enum: `superdoctor` / `lead` / `member` / `driver` / `cron`),
  `source_id` (free-text ID matching the kind — member name, cron line,
  etc.), and `target_team` (when superdoctor files a complaint in team
  A's `state.db` ABOUT team B). Closes the 2026-05-09 driver-chat ask:
  "complaints box must also capture from whom it came". Cross-team
  analysis (`show me all complaints superdoctor filed last week`) now
  runs via indexed query instead of grep. SQLite migration in
  `src/migrations/`.
- **`atmux epic` + `atmux story` sub-verbs — bun port**
  ([ADR-007](docs/adr/007-pull-model-kanban.md) hierarchy verbs).
  Ports `lib/epic.sh` (318 LOC) + `lib/story.sh` (388 LOC) to TS. New
  `src/core/epic.ts` (state-machine + auto-dispatch summary on review
  entry) + `src/core/story.ts` (4 gates: non-test child tasks done →
  `testing`; test-lane done → `review`; reviewer signoff → `merging`;
  merge task done → `done`). Auto-flips parent Epic `ready → in-progress`
  on first Story claim. Pre-req for proper kanban filing under
  Epic/Story doctypes.

### ✨ Added — atmux superdoctor wave (0.6.0, [ADR-077](docs/adr/077-superdoctor-cockpit-role.md))

- **`superdoctor` cockpit role at window 2**. Self-healing diagnosis-and-
  prevention loop; sits between superdriver (window 1) and per-team
  viewers. Owns the structural-fix loop atmux teams lacked when an
  anomaly fired (`atmux doctor` says *what* is wrong; `atmux whip` says
  *that* something stalled; superdoctor asks *why* and proposes the
  structural fix). Cockpit topology cutover (§D1+D2); inbox key
  `__superdoctor__` for send-key routing (§F3); cockpit-state surface
  on `atmux status` + P0 runbook (§F4+§F5); per-team complaint box +
  `atmux complaints` verb (§F2); cockpit reload hot-edit (`atmux cockpit
  reload`); rebuild prints superdoctor `/loop` nudge when enabled.
- **`atmux complaints` verb** (§F2). Per-team SQLite-backed log of root
  causes + preventive asks, distinct from driver-inbox (per-team asks at
  the lead) and pending-decisions.md (asks at the operator). Verb shape
  mirrors `atmux flag` — `complaints add|list|show|resolve`. Schema
  carries provenance columns post-v3 (see post-0.6.0 follow-ups above).

### ✨ Added — Discord noise drainage wave 2 (0.6.0, [ADR-079](docs/adr/079-discord-noise-drainage.md))

- **§A — cron schedules read from `team.whip.intervalMins`** instead of
  hardcoded `*/5` / `*/30` / `0 */4` / etc. (`src/core/cron.ts`). Schema
  field `intervalMins` was previously written but unread.
- **§B — `atmux audit` verb bun-ported** + ADR-044 driver-name rule
  alignment (bare `driver` not `__atmux__driver`).
- **§C — bare `[whip]` template-namespace lint** as structural CI gate.
  `DiscordTemplate` union (`src/abstractions/discord.ts`) has no `whip`
  literal; the compile-time invariant prevents bun-emit of bare `[whip]`.
- **§D — per-finding hash dedup + transitions-only emit** (highest
  leverage). Whip's per-member previous-state hash gates re-posting; only
  state transitions emit to Discord. Subsumes the auto-preclear-failed
  loop noise. ~70% reduction observed pre-demo-week.

### ✨ Added — Operator-observed improvements bundle (0.6.0, [ADR-080](docs/adr/080-operator-observed-improvements.md))

- **§A1 — ctx-pct rotation policy** in whip. `team.whip.ctxPctMax`
  (default `30`) — leads above this threshold auto-rotate regardless of
  uptime. Resolves the "lead at 67% ctx not rotating" sopx incident.
- **§A2 — lane-tick ctx-threshold lead refusal**. Lane-tick refuses to
  inject `claim --next` into a lead pane already above
  `team.whip.ctxPctMax` — avoids defeating the rotation that whip
  triggered.
- **§B1 — `findCommitForTask` helper** in `src/core/auto-done.ts`. Scans
  git history for `t-<id>` references; backbone for §B2.
- **§B2 — lane-tick auto-done back-fill** for stale `commit t-X` Tasks
  whose commit landed but `atmux done` never fired (sopx had 29 of
  these on 2026-05-09).
- **§C — pane-state `BUSY` for spinner verbs**. `pane-state.ts` gains a
  BUSY classification covering `Honking`/`Cooked for Ns`/`✻`/etc.
  spinners; lane-tick refuses claim injection on BUSY (was wrongly
  classified UNKNOWN → `skip-capture-error`).
- **§D — `task list --status` underscore normalize + did-you-mean error**.
  `--status in_progress` now works (was silent `(no tasks)`); unknown
  values produce `--status: 'xyz' not in {todo,in-progress,...}; did
  you mean 'in-progress'?` instead of empty result.
- **§E — `task list --json` escape audit** + regression fixture for
  bodies containing backticks/newlines/quotes.

### ✨ Added — Per-member worktree isolation (0.6.0+, [ADR-082](docs/adr/082-worktree-isolation-per-member.md) + [ADR-084](docs/adr/084-worktree-per-member-branch-model.md))

- **`team.json.worktreeIsolation` + `worktreeRoot`** Zod fields (W2).
  Each team member gets a private `<atmuxDir>/worktrees/<member>/`
  working tree on a per-member branch (`<base>-<member>` —
  `geoyws-up-impl`, etc.) so `lint-staged` stash-collisions can no
  longer sweep another member's untracked edits into the commit index.
  Demo-week-blocking concurrency-safety fix at 20+ member scale.
- **`atmux start` per-member worktree provisioning** (W3) — provision
  loop runs alongside the existing member spawn, with cwd override
  passed into `tuiClaude()`.
- **`atmux stop --force` worktree teardown** (W4) — `pruneWorktrees`
  with dirty-skip; orphan branches surfaced via doctor.
- **`atmux doctor` worktree-isolation probe** (W5) — four anomaly
  classes (missing worktree, stale/locked, branch drift, dirty state).
- **Per-member branch model** (ADR-084 amends ADR-082 OQ6) — fixes the
  "every member tries to checkout 'geoyws' which git refuses" failure
  surfaced during W6a dogfood-flip. `provisionWorktree` now creates
  `-b <base>-<member>` per call; cockpit's `--force-cycle` safety gate
  prevents accidental cross-member branch overwrite.

### ✨ Added — Driver-only Task refuse-gate ([ADR-033](docs/adr/033-driveronly-task-refuse-gate.md))

- **`Task.driverOnly: boolean`** schema field. `claim --next` skips
  driver-only Tasks during auto-pickup; explicit `atmux claim <id>` from
  a non-driver context refuses with a clear error; `atmux task move` /
  `atmux done` enforce the gate on state transitions. `--driver-only`
  flag on `atmux task add` stamps the field. Prevents auto-lane workers
  from claiming Tasks the planner reserved for driver-side ops.

### ✨ Added — Other 0.6.0 surfaces

- **`atmux send` `__superdoctor__` inbox key** (ADR-077 §F3) — send-keys
  routing for superdoctor pane lookup.
- **`atmux cockpit reload`** sub-verb — hot-reload alias for
  `cockpit.json` edits without process restart.
- **`atmux health` verb** — composed read-only diagnostic snapshot
  ([SPEC-066](docs/SPEC-066-health-verb.md)) bundling doctor + status +
  whip-last-tick + scanNeedsApproval into a single JSON output.
- **`atmux team repair-rename`** verb — V1 explicit-team port
  (ADR-027 ADDENDUM 11) for the per-team rename flow.
- **`atmux cron-install` + `atmux cron-remove`** explicit verbs ([ADR-083](docs/adr/083-cron-install-port-scope.md)).
  Port `installCronBlock` + DI seam from bash to TS; `atmux start`/`stop`
  call into them so cron block management is unified.
- **`atmux task update` sub-verb** ([ADR-084](docs/adr/084-worktree-per-member-branch-model.md) W3)
  — body + deps editor for in-flight tasks.
- **`atmux task` race-condition gate** — refuses member claim of an
  in-progress task owned by a different member (closes a kanban-state
  race surfaced during ADR-084 dogfood).
- **Bootstrap brief-paste port to `atmux start`** ([ADR-081](docs/adr/081-bootstrap-brief-paste-bug.md) §C).
  Lifts `_atmux_paste_brief` from the archived bash path into the TS
  spawn loop — fresh cages no longer silently starve on every `atmux
  start`. Uses the §A `C-m`-after-paste-buffer discipline.
- **Bun-runtime cage-safety preload** — refuses `bun test` inside an
  atmux cage (`bun test` crashes Claude's TUI cage in atmux repo per
  prior memory finding).
- **Events log** ([t-91cd050f](#)) — unified per-verb JSONL observability
  surface under `<atmuxDir>/logs/events.jsonl` (single line per state-
  mutating verb invocation; replaces ad-hoc per-verb logs).
- **`fix(cron)` config-driven schedules** — see ADR-079 §A above.
- **`fix(budget-probe)` opt-in OAuth refresh** ([ADR-078](docs/adr/078-budget-probe-oauth-refresh.md))
  — cockpit-rebuild TUI race resolved.

### ♻️ Changed — post-0.6.0

- **`atmux rotate-lead` team-lead role aliasing** — `team-lead` →
  `lead.md` resolves before existence check via
  `BRIEF_ALIASES: Readonly<Record<string,string>>` (ADR-081 §B; commit
  `7aa7cf2`). The deprecated `templates/briefs/team-lead.md` is now a
  symlink to `lead.md`.
- **`tmux send-keys` paste-submit** uses `C-m` not literal `Enter`
  ([ADR-081](docs/adr/081-bootstrap-brief-paste-bug.md) §A) — bracketed-
  paste envelope eats the trailing Enter as multi-line continuation;
  `C-m` is the literal carriage return that survives the envelope.
  Applied across every paste-buffer call site.
- **`atmux status` honors `team.tmuxTmpdir`** on read-side socket
  lookup; `atmux start`/`whip` honor it on write-side socket resolution.

### ✨ Added — Pull-model kanban (Epic 1)

- **Epic / Story / Task data model on `kanban.json`.** New top-level arrays
  `epics[]` + `stories[]`. Tasks gain optional `.epic` / `.story` / `.lane` /
  `.deliverable` fields. Backwards-compat preserved: legacy kanbans with only
  `tasks[]` still load; `atmux::kanban_normalize` (in `lib/common.sh`) auto-adds
  the new arrays on first mutation. Tasks without the new fields keep working
  (treat missing as `null` on read).
- **`atmux epic add | list | show | advance`** (S2). State machine:
  `planning → ready → in-progress → review → done`. `epic show` renders a tree
  view (Epic → Stories → child Tasks with statuses).
- **`atmux story add | list | show | advance`** (S3). State machine:
  `planning → ready → in-progress → testing → review → merging → done`. `--ac`
  flag captures explicit acceptance criteria — empty `acceptanceCriteria` is an
  automatic REJECT at reviewer signoff (per ADR-007 OQ2).
- **`atmux task add` new flags** (S4): `--epic <eid>`, `--story <sid>`,
  `--lane fe|be|db|ops|test|review|misc`, `--deliverable <text>`. Stories are
  optional; small Epics skip them.
- **`atmux claim --next [--lane <l>] [--as <m>]`** (S4). Pull-mode work
  selection: filters Tasks with non-`done` deps, prefers caller's lane, falls
  back across lanes when `team.kanban.crossLaneClaim` is `true` (default).
  Atomic claim with race-aware retry (3 attempts).
- **Auto-dispatch of commit-Tasks to gitter on `task move done`** (S4). When a
  Task with `.epic` set flips to `done`, a `commit <id>` Task lands in gitter's
  inbox automatically. Storyless-Epics auto-flip `in-progress → review` and
  fire a `draft Epic summary` Task to the lead. Story-level test-lane completion
  flips the Story `testing → review`.
- **`.lane` on the team-member schema** (S5). `templates/team.example.json`
  stamps lane explicitly; the wizard infers lane from member-name prefix
  (`fe-foo` → `fe`, `be-bar` → `be`, etc.) with role overrides for staff
  (`reviewer` → `review`, `devops` → `ops`, `dba` → `db`,
  `team-lead`/`planner`/`gitter` → `misc`). `atmux status` adds a `LANE` column
  (UPPER-CASE in display, lowercase in JSON). Backwards-compat: missing `.lane`
  is inferred at read time.
- **`atmux decisions add | list | show`** (S10, [ADR-008](docs/adr/008-decisions-verb.md)).
  Append-only auto-mode-resolution log at `.atmux/decisions.md`. Each `add`
  pings Discord (silent if no webhook). `--reversibility low|medium|high`
  classifies the call. Question / default / note are truncated to fit the
  ≤80-char Discord per-bullet budget; oversize inputs error rather than
  silent-truncate. Whip integration surfaces a pointer for new decisions
  since the last tick (S10).
- **`team.kanban.crossLaneClaim`** config (default `true`). When `false`, an
  empty caller-lane queue produces a hard error instead of falling back to
  any-lane work.

### ✨ Added — Whip enrichment + richer decisions (Epic 2)

<!-- Bullets land per-Story; this section is populated by sibling
     Tasks t-fc256867 (S7) / t-1b4d63ea (S8) / t-c6ae5307 (S9) and the
     S10 entry below. Order tracks the ADR-009 §S1→§S5 / §S7→§S10 +
     ADR-008 §S9→§S10 narrative. -->

- **Auto-rotation infrastructure** (E2/S5,
  [ADR-009](docs/adr/009-auto-rotation.md)). New `team.whip.autoRotate`
  config flag (boolean, default `false`, opt-in for safety — `/clear`
  is destructive so existing teams must NOT get auto-rotated on
  upgrade). When `true`, whip auto-execs `atmux rotate-lead` at the
  uptime threshold AND auto-execs `atmux rotate <member>` on banner
  detection (`Compacting conversation` / `approaching usage limit` /
  `hit your limit`). Per-member rotation anchor at
  `.atmux/state/<member>-rotated.epoch` (written by `lib/rotate.sh`
  on every successful rotation; whip's uptime calc switches from
  session-anchored to rotation-anchored, falls back to session-start
  when the anchor file is absent so existing teams see zero
  behavioural change until their first rotation lands). Banner
  preclear gated by the same flag and debounced 5 min via the same
  `<member>-rotated.epoch` so a persistent banner doesn't re-rotate
  every cron tick. Discord finding `♻️ AUTO-ROTATED <member> at <ts>`
  fires on every auto-rotation so the driver knows their pane just
  got `/clear`'d. Brief updates: `templates/briefs/lead.md`
  §Auto-rotation rewrite + `templates/briefs/member.md` §Auto-preclear
  callout. (`lib/rotate.sh`, `lib/whip.sh`, `templates/team.example.json`,
  `templates/briefs/lead.md`, `templates/briefs/member.md`.)

- **whip output noise reduction** (E2/S7,
  [ADR-009 §S7](docs/adr/009-auto-rotation.md)). Dedup pings via
  body-hash anchor (`.atmux/state/whip-last.hash`) so a single stuck
  Task doesn't re-fire 12 identical pings/hour. New per-tick
  "Since last tick" delta block with positive signal — commits +
  done-Tasks + advanced-Stories that landed in the window. Raised
  `staleMin` default `30 → 90` (demo-walk Tasks legitimately exceed
  30 min); per-Task override via `atmux task add --stale-min N`.
  Queued-msg flag suppressed when the pane is BUSY (mid-thinking /
  active token-counter / `Esc to interrupt` banner) — those messages
  WILL be submitted when the current turn ends, not stale.
  (`lib/whip.sh`, `lib/kanban.sh`, `templates/team.example.json`.)

- **decisions verb — Discord gating + inline preview + digest** (E2/S8,
  [ADR-008 §S8](docs/adr/008-decisions-verb.md)). Discord ping at
  add-time is now gated on `--reversibility high` only; `low` /
  `medium` decisions skip the per-add ping and surface via whip's
  inline preview block (`📋 N new decisions: …` with top-3 question +
  default per entry) plus a new `atmux decisions digest` verb that
  consolidates all skipped low/med entries since the last digest
  cursor into ONE Discord post (with `[N/M]` split if it exceeds
  2000 chars; silent on empty windows). Driver brief and planner
  brief explain the new ladder + when each tier pings.
  (`lib/decisions.sh`, `lib/whip.sh`, `templates/briefs/lead.md`,
  `templates/briefs/planner.md`, `README.md` cron snippet.)

- **decisions verb — richer template (4 new optional fields)** (E2/S9,
  [ADR-008 §S9](docs/adr/008-decisions-verb.md)). New optional flags:
  `--context` (the WHY behind the decision), `--option` (repeatable
  up to 5 times — alternatives considered), `--impact` (what
  breaks / who notices / what migrates if the default is wrong),
  `--decided-by` (who landed the call: lead / planner / specific
  teammate). Per-field byte caps were temporarily relaxed to
  200/500 chars in the S9 ship and then dropped entirely in S10
  (see chunker entry below). Discord template extended to render
  the new sections in `question · default · decided-by · context ·
  options · impact · note · reversibility` order, skipping any
  empty section. Backwards-compat preserved: a no-new-flags entry
  is bit-identical in `.atmux/decisions.md` to the pre-S9 4-field
  shape; legacy entries also parse cleanly via the extended awk in
  `_decisions_to_json_array`. Brief copy in lead.md + planner.md
  documents per-field guidance + worked examples.
  (`lib/decisions.sh`, `templates/briefs/lead.md`,
  `templates/briefs/planner.md`.)

- **decisions verb — drop per-field caps + section-aware multi-message
  Discord chunker** (E2/S10, [ADR-008 §S10](docs/adr/008-decisions-verb.md)).
  S9's per-field byte caps (200 chars on question/default, 500 on
  note/context/impact, 80 on decided-by, 200/each on options) are gone —
  the data layer accepts arbitrarily long input. The Discord renderer
  now composes the full body, ships a single message when ≤1900 chars,
  and otherwise splits **section-by-section** into up to 5 messages
  with a `[N/M]` header per chunk and a 1s sleep between pings to stay
  under Discord's rate-limit margin. Required fields (question, default,
  decided-by, reversibility, show/override pointers) always live in
  chunk 1; optional sections (context, options, impact, note) flow into
  chunks 2–5 in keep-order. Beyond 5 chunks, fields drop in S9-truncate
  order (note → impact → options → context) and the last chunk gets
  `↳ atmux decisions show <id> for full`. Whip's "Since last tick"
  delta block also gains per-bullet rendering for done-tasks
  (`🏁 \`<id>\` [E#/S#] <subject> — <owner>`), commits
  (`✅ \`<sha>\` <subject> — <author>`), and advanced-stories
  (`📈 \`<sid>\` [<epic>] <title> → <status>`); each truncates to
  ≤80 chars/bullet with cap-5-plus-`+N more`. New `story.advancedAt`
  epoch schema field stamped on every transition; old stories pre-
  dating the field are naturally excluded by the strict-greater-than
  filter. Per-field cap regressions in `tests/unit/decisions.bats`
  retargeted; new `tests/unit/whip_delta.bats` enriched-bullet
  coverage (18/18 incl. real-git regression for the format→tformat
  fix from f-3229e152).

### ✨ Added — SQLite state cutover (ADR-076)

ADR-076 collapses the legacy JSON-canonical inbox (`.atmux/inboxes/<member>.json`)
into the SQLite `state.db` already introduced by ADR-060. Five phases shipped
2026-05-08:

- **Phase 1 — `atmux migrate-state --target=inboxes`** (commit `27d80ee`). One-
  shot backfill: reads every `.atmux/inboxes/*.json` into the `inbox_messages`
  SQLite table, idempotent on re-run, dry-run support. Safety net for operators
  upgrading existing teams (run before flipping to SQL-canonical reads).
- **Phase 2 — SQL-canonical `loadInbox`** (commit `c3c6cc0`). Inbox readers
  switch to `state.db` when present, falling back to the JSON file when not.
  Per-team SQL detection via the presence of `state.db` + the `inbox_messages`
  table; old teams continue working on JSON without migration.
- **Phase 3 — inbox writer no-op on SQL-canonical teams** (commit `95b45c9`).
  Inbox writes route to SQLite on SQL-canonical teams; the JSON-file writer
  is a no-op rather than a dual-write (avoiding drift between the two stores).
  Legacy `inboxes/*.json` files survive untouched as historical artifacts.
- **Phase 4 — `atmux status` column update** (commit `8005c69`). The per-
  member "📨 N pending" inbox column is replaced by "🟡 N active 📌 N todo"
  reading from the kanban directly — pending-inbox semantics were a JSON-era
  artifact (the inbox JSON tracked `{pending, inProgress, done}` slots per
  member); on SQL-canonical teams the kanban `tasks` table is the source of
  truth for what a member is working on.
- **Phase 5 — 0.5.0 release tag** (commit `5c16432`). All four phases bundled
  in a single minor release because the migration story is atomic per-team.
  Operators upgrading from 0.4.x: run `atmux migrate-state --target=inboxes`
  once per team root before the next `atmux start`.

Cross-refs in code: `src/core/inbox.ts`, `src/verbs/migrate-state.ts`,
`src/verbs/status.ts`, `src/verbs/whip.ts`. SQLite schema migration ladder
at `src/abstractions/sqlite-migrations.ts`.

### ✨ Added — atmux flag verb (Epic 4)

- **`atmux flag` — member→lead structured issue surfacing** (E4,
  [ADR-010](docs/adr/010-atmux-flag.md)). Symmetric counterpart to
  `atmux decisions add` but in the reverse direction: members fire
  `atmux flag "<msg>" --severity p0|p1|p2 --needs unblock|decision|review|context|rotate [--task <id>]`
  to surface a structured issue to the lead. Append-only state at
  `.atmux/flags.md` (one `### f-xxxxxxxx` heading per entry, fields
  as bullets, parsed by awk — same shape as `decisions.md`). Verbs:
  `flag add` / `flag list [--status open|resolved]` / `flag show <fid>` /
  `flag resolve <fid> [--note <text>]`. Replaces the silent-suffer
  pattern: workers stuck >10 min now fire a flag instead of grinding.
- **`[atmux-flags]` Discord template at `--severity p0` ONLY**.
  Mirrors ADR-008 §S8's reversibility-gates-Discord pattern: p0 pings
  the team channel immediately (driver gets phone visibility on
  demo-blocking issues); p1/p2 write to `flags.md` + send a tmux
  keystroke to the lead pane (kanban-visible, channel-quiet). Whip's
  `_atmux_whip_check_flags` surfaces `📍 N open p0 flags` inline in
  the next `[whip-progress]` ping so even resolved-late p0s stay
  visible.
- **`--task <id> --needs unblock` is a single-call atomic mutation**.
  When both flags are present, `atmux flag add` (a) writes the flag
  entry to `flags.md`, (b) appends the flag id to `task.note` for
  audit, AND (c) flips the linked Task to `blocked` state — kanban
  state matches reality without forcing the worker to remember a
  second command. Other `--needs` values with `--task` append to
  `.note` only (no status change — could be "I need a clarification
  but can keep working on adjacent stuff").
- **Mid-rotation flag-send: lost-keystroke acceptable; flag persists
  durably**. When a member fires `atmux flag` while the lead pane is
  mid-`/clear` (E2 auto-rotate), the `tmux send-keys` "now signal"
  may land in the void or as the first text in the freshly-bootstrapped
  pane. The flag entry STILL writes to `flags.md` durably; whip
  surfaces it on the next 5-min tick regardless. Banner-detect on
  the lead pane (`Compacting conversation` / `hit your limit`) skips
  the keystroke send pre-emptively.
- **Brief updates**: `templates/briefs/lead.md` whip loop reads
  `flags.md` FIRST (before driver-inbox.md) with triage markers
  (✅ resolved / 📤 routed / ⏳ in-progress / ❌ deferred) plus a
  callout that open p0 flags appear in `[whip-progress]` Discord
  pings. `templates/briefs/member.md` gains §"When to flag" — 4
  triggers (stuck >10 min / ambiguous tool output / decision needed /
  mid-rotation blocker) with 3 worked examples.
  (`lib/flags.sh`, `lib/whip.sh`, `lib/kanban.sh`, `bin/atmux`,
  `templates/briefs/lead.md`, `templates/briefs/member.md`.)

### ✨ Added — Hot reload (Epic 3)

Erlang/OTP-style hot code swap for atmux teams. Edit a brief, change
team.json, or fix a `lib/*.sh` syntax error WITHOUT `/clear`-ing anyone
or restarting the session. See [ADR-011](docs/adr/011-hot-reload.md).

E3 ships verbs 1, 2, 4, 5 of the original 6-verb spec; verbs 3 (TUI
swap) and 6 (Erlang per-claim brief snapshot) are carved into a
recommended **E5** spinoff (multi-day foundational work that deserves
its own ADR — pane lifecycle + per-claim state).

- **`atmux brief-reload <member>`** — re-paste the latest
  `templates/briefs/<role>.md` into the member's pane as a *prepended
  notice* (no `/clear`, no context loss). Use mid-Epic when a brief
  was edited and the member's understanding lags the file. Banner-skip
  safety: if the pane shows `Compacting conversation` /
  `Press up to edit queued messages` / `approaching usage limit` /
  `hit your limit` / `thinking with`, the reload logs and exits 1
  (pasting into those states scrambles queued buffers or interleaves
  with model output). `--force` bypasses for stale-banner edge cases.
- **`atmux config-reload [--member <m>]`** — re-read `team.json`,
  compute per-member delta against `.atmux/state/spawn-snapshot.json`
  (written at `atmux start`), and ping each affected member with
  `⚙️ CONFIG RELOAD: your <field> changed: <old>→<new>. Apply on
  next dispatch.` Members with no delta stay silent. NO tmux
  respawn, NO model swap exec, NO `/clear` — verbal protocol, soft
  cut. Members finish current Task on the OLD config (reasoning
  continuity), apply on next dispatch. Schema-enforced per-claim
  versioning is deferred to E5.
- **`atmux verify-libs`** — sources every `lib/*.sh` in a subshell,
  reports defined `atmux::*` functions per-file, fails fast on bash
  parse errors. Catches "broken lib/whip.sh doesn't propagate to
  running members until they re-shell" before it bites a live team.
  Wired into `atmux doctor` as a `libs:` check (~10 LOC).
- **Versioned briefs** — every `templates/briefs/*.md` carries a
  `<!-- brief-version: vN -->` HTML comment as the first line
  (invisible when the brief renders in-pane — markdown comments
  don't render). State at `.atmux/state/brief-versions.json`
  records each member's pasted version: `{<member>: {role, version,
  pastedAt}}`. Whip's `_atmux_whip_check_brief_versions` diffs
  file-version vs pasted-version every tick; on mismatch emits
  `📋 brief-version mismatch <member>: pane=vN, file=vM`. Lead (or
  driver) responds by dispatching `atmux brief-reload <member>`.
  `v0` is the legacy fallback for marker-less briefs — old teams
  never trip the finding until they upgrade.
- **Brief updates**: `templates/briefs/lead.md` gains §"Hot reload"
  (brief-reload semantics + banner-skip + config-reload delta-only +
  brief-version flow). `templates/briefs/member.md` gains §"When
  whip pings brief version available" (run brief-reload between
  Tasks, NOT mid-Task; config-reload applies at next dispatch).
  (`lib/reload.sh`, `lib/verify_libs.sh`, `lib/common.sh`,
  `lib/start.sh`, `lib/rotate.sh`, `lib/whip.sh`, `lib/doctor.sh`,
  `bin/atmux`, `templates/briefs/lead.md`,
  `templates/briefs/member.md`, all 8 `templates/briefs/*.md`.)

### ♻️ Changed — Briefs rewritten for pull model

- **`templates/briefs/lead.md`** — explicit "DO NOT decompose / DO NOT dispatch
  per-Task"; loop now (1) read `driver-inbox.md`, (2) route Epic asks to the
  planner via `atmux send planner`, (3) compose Epic summary on `draft Epic
  summary` request from `atmux epic show` + `git log`. New "Recording decisions"
  section on `atmux decisions add` usage with reversibility tier explainer.
- **`templates/briefs/planner.md`** — explicit "You decompose. You DON'T
  dispatch. The lead routes; workers pull." Loop covers `atmux epic add` →
  optional `atmux story add` → `atmux task add --epic --lane --deps` → `atmux
  reply`. Lane vocabulary table (FE / BE / DB / OPS / TEST / REVIEW / MISC).
  ADR template included. New "Recording resolved open questions" section.
- **`templates/briefs/member.md`** — pull loop: `atmux claim --next` → execute
  → `atmux done <id> --note "<commit subject>"`. Cross-lane handoff via deps;
  surface-with-evidence pattern for cross-lane bugs. FE workers also own the
  TEST-lane capstone for UI Stories. **DO NOT commit / DO NOT push** preserved
  and reframed as "gitter commits on the back".
- **`templates/briefs/reviewer.md`** — Story-level signoff on cumulative diff
  (not per-commit). Empty `acceptanceCriteria` = automatic REJECT. Approve via
  `atmux story advance --to merging`; reject via push-back + `--to in-progress`.
  System-wide audit bar preserved (exhaustive grep + negative-space proof +
  adjacent-class widening).
- **`templates/briefs/gitter.md`** — three Task shapes auto-arrive:
  `commit t-xxx` (one commit per Task), `merge s-xxx` (Story finalization on
  `merging`), `persist deferred items` (one-shot, only allowed write outside
  `/root/work/src/atmux/`). HEREDOC commit example with `Co-Authored-By:`
  trailers. Hooks always run — never `--no-verify`, never `--amend` after a
  hook failure.

### 📚 Docs

- **`README.md`** — new "Agile vocabulary" section (Epic, Story OPTIONAL,
  Task definitions); revised "How it works" diagram showing pull-model flow
  (driver → lead → planner → kanban → workers pull → gitter commits → lead
  Epic summary). Commands section updated with `atmux epic` / `atmux story` /
  `atmux task add --epic --story --lane --deliverable` / `atmux claim --next` /
  `atmux decisions add | list | show`.
- **`docs/ARCHITECTURE.md`** — Roles table redefined for the pull model
  (lead routes, planner decomposes, reviewer signs off Stories, gitter auto-
  dispatched, member pulls). New "Pull coordination" section covers the
  kanban data model + 3 state machines + `claim --next` selection +
  auto-dispatch flow with ASCII diagram. New "Lead → Planner routing" section
  replaces the old push-model "Lead → Member routing".
- **`docs/GETTING_STARTED.md`** — new "Driving an Epic" 6-step walkthrough
  with realistic `/healthz` example, live `atmux epic show` tree-view
  example mid-flight, example `git log` post-Epic showing one commit per
  Task. Existing first-time-setup + cron + doctor sections preserved.
- **Tab-completions** (`completions/_atmux` zsh, `completions/atmux.bash`
  bash) — `epic`/`story`/`decisions` top-level verbs with sub-verbs;
  `--lane` / `--reversibility` / `--to` / `--status` enum completions
  (state-machine aware: epic-states for `epic advance --to`, story-states
  for `story advance --to`); `task add` new-flag matrix; `claim --next` +
  `--lane` + `--as`.
- **[ADR-081](docs/adr/081-bootstrap-brief-paste-bug.md) §F — first-turn
  precedence over residue-discard memory rules**. New section + brief-
  template anchors in `templates/briefs/lead.md` + `templates/briefs/member.md`
  ensure fresh leads / members accept their FIRST `atmux claim --next
  --as <role>` keystroke as legitimate kick-off, overriding any operator-
  memory rule that says to discard such injections as auto-loop residue.
  Status flipped `proposed → accepted` on the same commit.
- **ADR status hygiene pass** — 4 ADRs flipped `proposed → accepted`
  with per-§ commit-chain inline (ADR-077 superdoctor, ADR-079 discord-
  noise drainage, ADR-080 operator-observed improvements, ADR-084
  worktree per-member branch model); ADR-082 (worktree isolation)
  annotated `proposed (deferred: W6c verify + W9 adversarial regression
  test remain blocked)`. Pre-cleanup before whip §2.5 needs-approval
  scanner lands, so the noise floor stays clean. AC: `rg '^Status:
  proposed$' docs/adr/*.md` returns zero matches.
- **Docs Discipline section in 5 brief templates** —
  `templates/briefs/{lead,member,reviewer,planner,unblocker}.md` now
  carry a Docs Discipline section near the top (after role intro,
  before role-specific mechanics) embedding the ADRs → docs → brief
  templates → source lookup order, peruse-before-working rule, and
  same-commit doc-update rule. `/CLAUDE.md` cited as canonical contract.
- **No-gitter, worker-self-commits pattern in `lead.md` + `member.md`**.
  New §"Commit ownership" section in both briefs describing the two
  topologies (gitter-bearing teams: stage + mark done, gitter commits on
  the back; gitter-less teams: commit + push BEFORE `atmux done`). Five
  contradictory existing lines reworded so the brief is internally
  consistent. Defensively phrased — `team.json:.members[]` `role:
  "gitter"` probe disambiguates at the call site so future gitter-bearing
  teams aren't broken.
- **[ADR-094](docs/adr/094-c-alias-spawn-convention.md) — c-alias
  spawn convention as first-class**. Author the ADR proposing that
  `atmux::tui_claude` bake the global `CLAUDE.md` §Spawn Pattern
  defaults inline so per-team `tuiCommands.claude` overrides aren't
  required for the canonical autonomous-team-member spawn shape
  (CLAUDE_GUARD_AGENT=1 + --plugin-dir + --permission-mode auto). Asks
  A+B+C cohesive design; D (init wizard prompt) cross-linked as
  orthogonal. Three env knobs (`ATMUX_CLAUDE_GUARD_AGENT`,
  `ATMUX_CLAUDE_PLUGIN_DIR`, `ATMUX_CLAUDE_PERMISSION`) gate the bake
  with rollback-friendly defaults; no schema change. Status: proposed.

### 🚨 Breaking changes

- **Brief templates rewritten**. Existing teams should re-init briefs from
  `templates/briefs/*.md` (or run `atmux reconfigure`). Old push-model
  briefs are stale; the lead/member/reviewer/gitter behaviour described
  in them no longer matches the runtime.
- **Lead no longer dispatches per-Task by default**. Workers pull. Manual
  `atmux dispatch <member> <task-id>` is reserved for explicit driver-
  requested priority overrides; default flow is `atmux claim --next`.
- **Per-member inbox JSON files are no longer the source of truth**
  (ADR-076). Reads + writes route to SQLite `state.db` on teams that have
  it; the legacy `.atmux/inboxes/<member>.json` files remain on disk for
  legacy teams + as historical artifacts but new operations do not touch
  them. Operators upgrading from 0.4.x: run `atmux migrate-state
  --target=inboxes` once per team root to backfill the SQLite store from
  the legacy JSON before the next `atmux start`. Same applies to the
  kanban (`atmux migrate-state --target=tasks` per ADR-060).
- **`atmux status` per-member column format changed**. The "📨 N pending"
  inbox column is now "🟡 N active 📌 N todo" reading from the kanban
  rather than the inbox file. Downstream scrapers / dashboards parsing the
  old format need to update their regex.

### ✨ Added — pre-Epic-1 (already in Unreleased before this Epic)

- **`planner` + `dba` as canonical staff roles.** Planner owns task
  decomposition + ADR authorship, so the lead's context budget goes to
  coordination only (per the CLAUDE.md doctrine "team-lead never plans").
  DBA owns schema + migrations + data integrity. Both are toggleable in
  the wizard (`planner` on by default, `dba` off by default). New brief
  templates in `templates/briefs/planner.md` and `templates/briefs/dba.md`.
- **Wizard preset modes.** New top-of-wizard prompt: `perf` (all claude),
  `default` (claude staff + cursor/opencode/kimi workers cycled),
  `eco` (all opencode / MiniMax), `custom` (prompt each worker individually).
  Preset drives staff + worker TUI defaults; other prompts still run so the
  user confirms team shape.
- **Feature-lane worker naming convention.** README + wizard suggest
  `fe-auth`, `be-auth`, `db-auth`, etc. over `cursor-1` / `kimi-2` —
  surfaces ownership and makes kanban/status readable at a glance.
- **Ephemeral specialists pattern.** Documented in README +
  GETTING_STARTED: `atmux add-member planner-auth --role planner`
  spawns a feature-scoped specialist when canonical staff is saturated.
  No new code; formalises an existing capability.
- **`docs/adr/` with 6 initial ADRs** covering planner role, preset modes,
  emoji architecture, ephemeral specialists, doctor preflight, and bare
  `atmux`. Planner uses this directory for new ADRs going forward.

### ♻️ Changed

- **Role rename: `git-committer` → `gitter`.** Role value, brief file,
  emoji pool, status fallback, docs + README + template all updated.
  Shorter + matches the wizard prompt. Existing team.json files with
  `role: "git-committer"` keep working via status.sh fallback but should
  be migrated.

- **Per-member emojis — auto-assigned, displayed everywhere.** Each member in
  `team.json` now carries an optional `.emoji` field, stamped at wizard /
  add-member time. Three assignment modes (`team.emojis.mode`, override via
  `ATMUX_EMOJI_MODE`):
  - `static` — canonical per-role emoji, deterministic (lead=🧭, reviewer=🔍,
    gitter=🌿, devops=⚙️, member=🐝).
  - `random` (default) — random pick from a curated pool per role; avoids
    duplicates within a team for variety.
  - `ai` — `claude -p` picks per-member based on name+role. Falls back to
    `random` if claude is missing or the call fails.
  Display surfaces: tmux window names (`__<team>__<emoji><member>` when
  stamped), `atmux status`, and any future surfaces via `atmux::member_emoji`
  / `atmux::member_display` helpers.
- **Bare `atmux` → one-stop bring-up.** Running `atmux` with no arguments is
  now aliased to `atmux up`: offers the wizard if there's no team.json (with
  the CWD shown prominently so you don't accidentally scaffold in the wrong
  dir), runs doctor preflight, starts the session if it isn't already up, and
  attaches you to it. Idempotent — re-running after the session is up just
  reattaches. Help is still available via `atmux help` / `atmux --help`.
- **`atmux doctor`** — `brew doctor`-style environment check. Validates required
  deps (tmux, jq, git), optional deps (curl, bats, shellcheck), `team.json`
  schema, every member's TUI binary on PATH, `.atmux/` writability, and
  Discord webhook reachability. Flags: `--quiet` (exit-code-only, used by
  start preflight), `--fix` (interactive remediation), `--json` (machine
  readable).
- **`atmux start` preflight.** `start` now runs `doctor --quiet` before
  spawning panes. On red, aborts with a pointer to `atmux doctor`. Use
  `--doctor` for a verbose preflight (or `ATMUX_DOCTOR_ON_START=1` for cron),
  or `--no-doctor` to skip entirely.

## [0.3.0] — 2026-04-24

### ✨ Added

- **`ATMUX_MEMBER` auto-export per pane.** Every TUI launch command now prepends
  `export ATMUX_MEMBER=<name>`, so `atmux claim <id>` and `atmux done <id>` run
  inside a member's pane infer `--as` without any flags.
- **`atmux reply` / `atmux outbox`** — the missing reverse channel. Any member
  writes `atmux reply "..."` to append to `.atmux/lead-outbox.md`; the driver
  reads via `atmux outbox` (with `--ack` to archive, `--json` for pipeability).
  Replaces "attach to lead pane to see what it decided" with an async mailbox.
- **`atmux cost` + budget enforcement.** Parses `~/.claude/projects/*.jsonl`
  `usage` blocks against a pricing table (`lib/pricing.json`; override with
  `ATMUX_PRICING_FILE`). `team.budget.{total,perMember,overrunPolicy}` in
  `team.json` — `overrunPolicy` ∈ `warn | pause | failover`.
- **Budget-exhausted failover.** When `overrunPolicy: "failover"`, `atmux whip`
  auto-invokes `atmux handoff <exhausted> <peer-with-budget>` and pauses the
  exhausted member. Peer selection prefers same `role`.
- **`atmux handoff <from> <to>`.** Two-phase: first asks the source TUI to write
  a handoff summary, waits up to `ATMUX_HANDOFF_WAIT` seconds; if the file
  never materializes, falls back to `tmux capture-pane` screen-scrape. Either
  way the target gets the notes + the in-flight tasks migrated.
- **`atmux pause <member>` / `atmux resume <member>`.** Paused members refuse
  `dispatch` and `claim`. Used by budget enforcement + manual ops.
- **`atmux add-member <name> ...`** — append a member without re-running the
  wizard; spawns immediately if the session is up.
- **`atmux reconfigure`** — re-run the TUI-commands part of the wizard against
  an existing team.json without nuking members.
- **Task `priority` + `deps` enforcement.** `task add --priority N`; `task list`
  sorts ascending by priority. `claim` and `dispatch` refuse tasks whose `deps`
  aren't all `done`.
- **`--json` output** for `atmux status` and `atmux task list` (driver-side
  Claude can now parse team state without grep/awk fragility).
- **`atmux dashboard [--interval <s>]`** — live full-screen status panel.
- **Shell completion**: `completions/atmux.bash` + `completions/_atmux` (zsh).
  Tab-completes verbs + member names read from `.atmux/team.json`.
- **GitHub Actions CI** — `.github/workflows/test.yml` runs shellcheck + bats.
- **`flock` on every JSON mutation.** All `atmux::jq_update` calls now hold a
  per-file lock, preventing read-modify-write races between concurrent
  dispatches / claims.

### 🛡️ Fixed

- shellcheck-clean (with `-e SC1091,SC2154,SC2155,SC2016,SC2034`). Fixes:
  bogus multi-redirect in `cost.sh`, unused vars, `cd` without `|| exit` in
  tests, `A && B || C` misuse in `start.sh`.

### 🧪 Tests

- **139/139 green** (129 unit + 10 e2e) — up from 96 in v0.2.0.
- New suites: `outbox.bats` (6), `env_member.bats` (7), `json_output.bats` (5),
  `add_member.bats` (4), `deps.bats` (5), `cost.bats` (4), `pause.bats` (4),
  `handoff.bats` (5).



### ✨ Added

- **First-run auto-wizard.** Invoking `atmux <verb>` in a directory with no
  `.atmux/team.json` now offers the setup wizard when stdin is a tty. Non-
  interactive paths (cron, piped stdin) keep the normal "no team.json" error so
  `atmux whip` / `atmux report` in cron don't hang. Opt out with
  `ATMUX_NO_WIZARD=1`. Exempt verbs: `init`, `help`, `version`.
- **Per-team TUI launch aliases** via the new `tuiCommands` field in `team.json`.
  Example: `"tuiCommands": {"claude": "claude --plugin-dir=$HOME/work/journals/.sb/claude-skills"}`.
  atmux appends `--model <model>` unless the prefix already contains `--model`.
- **Per-member full-command override** via a new `command` field on a member.
  Takes priority over everything. Use it when one member needs a totally bespoke
  invocation (e.g. a different wrapper script or completely different flags).
- **Custom TUI type names.** Members can now declare `"tui": "claude-fresh"` or
  `"tui": "claude-heavy"` as long as the name has a matching entry in
  `tuiCommands`. Lets you run multiple Claude configs side-by-side.
- **Wizard asks for TUI launch commands.** After the basic team questions, the
  wizard prompts: *"claude launch command [claude]:"* etc. It tries to detect
  existing shell aliases (e.g. `claude='command claude --plugin-dir=…'`) and
  proposes them as defaults. Only non-default entries are written to
  `tuiCommands`, keeping team.json tidy.
- **`examples/opencode-lead-team.json`** — OpenCode driving as `team-lead`
  (cheap coordination turns), Claude for reviewer/gitter, Cursor + Kimi workers.
- **`examples/custom-claude-team.json`** — multiple Claude configs in one team,
  showing `tuiCommands` + per-member `command` override side-by-side.
- **CHANGELOG.md** (this file).

### 🔧 Changed

- `templates/team.example.json` now includes an empty `tuiCommands` block with an
  inline comment showing the common plugin-dir alias pattern.
- `lib/tui.sh` accepts the full member JSON blob so it can read per-member
  `command` overrides.

### 🧪 Tests

- Full suite now 96/96 green (86 unit + 10 e2e).
- New `tests/unit/tui_resolution.bats` (9 tests) covers every branch of the
  3-tier resolution: `member.command` → `team.tuiCommands[tui]` → built-in
  default, plus the "unknown custom tui" error path and a shell-safety test for
  `cwd` with spaces.
- `tests/unit/first_run.bats` (7 tests) covers the first-run wizard offer: tty
  vs non-tty, opt-out env var, exempt verbs, yes/no branches (yes-branch uses
  `script(1)` to fake a tty).

## [0.1.0] — 2026-04-24

### ✨ Initial release

- 🎮 Driver → 🦅 Team Lead → 🐜 Members orchestration via `tmux send-keys`.
- Supports TUIs: `claude`, `opencode` (MiniMax M2.7 highspeed default), `kimi`
  (kimi-latest default), `cursor-agent` (Composer 2 default), `shell`.
- Per-role defaults: team-lead / reviewer / git-committer / devops on Claude;
  workers on any TUI.
- Core verbs: `init`, `start`, `stop`, `attach`, `send`, `broadcast`, `tell-lead`,
  `task` (add / list / show / move / assign / rm), `dispatch`, `inbox`, `claim`,
  `done`, `status`, `report`, `whip`, `rotate`, `rotate-lead`.
- Automation: `atmux whip` (5-min watchdog) + `atmux report` (30-min digest),
  both idempotent for cron. Discord escalation via `ATMUX_DISCORD_WEBHOOK` with
  `DISCORD_WHIP_WEBHOOK` as a fallback.
- State: project-local `.atmux/` with `team.json`, `kanban.json`, per-member
  `inboxes/`, `driver-inbox.md`, `logs/`, `state/`, `archive/`. All
  greppable / diffable JSON + markdown.
- Test suite: 80 bats-core tests (70 unit + 10 e2e), all green. E2E uses
  `tui=shell` so CI needs no AI API keys.

[Unreleased]: https://github.com/geoyws/atmux/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/geoyws/atmux/compare/v0.3.0...v0.5.0
[0.3.0]: https://github.com/geoyws/atmux/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/geoyws/atmux/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/geoyws/atmux/releases/tag/v0.1.0
