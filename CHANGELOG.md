# Changelog

All notable changes to **atmux** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> **Post-0.6.0 follow-ups** (catchup sweep 2026-05-13 per t-a1cc07bc).
> `0.5.0` and `0.6.0` shipped without their own CHANGELOG sections — the
> Epic 1 (pull-model kanban), Epic 2 (whip enrichment), Epic 3 (hot reload),
> Epic 4 (atmux flag) bullet groups below cover the bulk of `0.5.0`'s scope;
> `0.6.0` adds the ADR-077 **superdoctor wave** + ADR-079 / ADR-080 noise-
> drainage + improvement bundles (each bullet now cross-references its ADR
> for traceability). The remaining post-0.6.0 work is grouped below under
> **post-0.6.0 follow-ups** until the next release cut.

### 🟢 Shipped — atmux 0.8.0 install (t-eda081cf, 2026-05-16)

- **Version bump `0.7.2 → 0.8.0`** (`package.json`) + `bun run build:install` cut a fresh binary to `/opt/atmux/0.8.0/bin/atmux` with atomic symlink swap (`/opt/atmux/current → /opt/atmux/0.8.0`; `/usr/local/bin/atmux` unchanged, still resolves through `current`). Rollback target preserved at `/opt/atmux/0.7.2/` (and earlier 0.3.0–0.7.1 dirs) — `sudo ln -sfn /opt/atmux/0.7.2 /opt/atmux/current` reverts in one line.
- **Minor bump rationale**: 0.8.0 packages four backward-compat surface additions accumulated since 0.7.2 (May-13) — `atmux gitter` verb (ADR-134 T9 production merge dispatcher), `atmux ombudsman` verb (ADR-147 T9 complaints sweeper), `atmux cron-install --template gitter-sweep` + `--template ombudsman-tick` options (ADR-134 T7), and the ADR-135 hyphenated-window-name resolver (closes the live `/usr/local/bin/atmux` failure mode `tmux: can't find window: 🧭lead`). No breaking removals — existing `cockpit.json.superdoctor` block still loaded via back-compat shim per ADR-133 (TR8 follow-up scheduled for next release per the existing `🚨 Coming next release` row below).
- **Deploy-time CHANGELOG note**: the bulk of this `[Unreleased]` block was authored against 0.7.2-as-baseline and SHOULD migrate into a formal `## [0.8.0] — 2026-05-16` named section per Keep-a-Changelog; deferred from this deploy commit to keep the diff scope narrow (release-cut housekeeping is a separate Task) — the per-section `🟢 Shipped` / `📋 Proposed` / `🏷️ Renamed` / `⚙️ Migration` / `⚠️ Deprecated` glyphs already encode shipped-vs-pending status in place.

### 🟢 Shipped — ADR-147 ombudsman + release-notes dogfood (T9) + SQLite legacy-DB rescue

- **ADR-147 status flipped `proposed → accepted`** ([docs/adr/147-ombudsman-and-release-notes.md](docs/adr/147-ombudsman-and-release-notes.md)) per its own T9 gate: atmux-team's `.atmux/team.json` gained an `ombudsman` member entry (`emoji: ⚖️`, `claudeAccount: personal`) + `ombudsman: { enabled: true, tickIntervalMins: 15 }` config block; `atmux start` spawned the ombudsman pane (window `⚖️-ombudsman`); ombudsman bootstrap-time drained the singleton open complaint (`c-7a308f7f` groom `--inbox-days` aging gap) by filing task `t-82b6aed9` (planner-routed) + resolving the complaint with cross-ref to ADR-154's SQLite migration; day-file `docs/release-notes/2026/05/2026-05-16.md` landed on `geoyws-ombudsman` @ `b68f2b4`. `atmux cron-install --template ombudsman-tick` installed the `*/15` cron line in the atmux team's crontab block (verified via `crontab -l | grep ombudsman`). End-to-end annotation table + dogfood findings appended to the ADR.
- **SQLite legacy-DB rescue (precursor commit `ed24844`)** — `fix(sqlite-migrations): legacy DB rescue + idempotent CREATEs`. Pre-T9 state.db was at `user_version=4` with `superdoctor_hygiene` present but `superdoctor_attempts` absent — the pre-renumber `v3→v4` (which was hygiene before the 2026-05-14 16:05 MYT renumber) ran, but the renumbered new `v3→v4` (attempts) never did. Worktree atmux crashed on every state.db open with `SQLiteError: table superdoctor_hygiene already exists` (sqlite-migrations.ts:218) which would have blocked every member running new-build atmux until `/usr/local/bin/atmux` is bumped. Fix: `IF NOT EXISTS` guards on v3→v4 (attempts) + v4→v5 (hygiene) `CREATE TABLE` + `CREATE INDEX`, plus a new `v6→v7` migration that re-runs the v3→v4 SQL idempotently to backfill the missing table on legacy DBs. 3 new tests in `tests/unit/abstractions/sqlite.test.ts` (legacy seeded state walks to highest version, fresh DB walks v0→highest, re-open is no-op) — 9 tests pass total, 100% line/func coverage on `sqlite-migrations.ts`. Live state.db now at `user_version=7` with both tables present.

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

### 🟢 Shipped — commit-cadence column in `atmux status` (ADR-148 T2)

- **New cadence column** in `atmux status` output per [ADR-148](docs/adr/148-commit-cadence-truth-signal.md) §D3. Renders the canonical truth-signal for "is this member shipping?": one of `🟢 shipping (Nmin)` / `🟡 idle (HhMm)` / `🔴 dormant (Hh)` / `🚨 ship-zero (Hh)` per ADR-148 §D2 classifier. Sourced from per-member `git -C <worktree> log --since=<windowSec>s --author=<name>` — the cadence is the truth signal; pane-state is the proxy.
- **`state` column renamed to `pane-state`** per ADR-148 §D3 to make the proxy explicit. Existing operators reading the column see the same cage-state values (`active`/`wedged`/`bootstrapping`/`down`); the header rename signals that this is a process observable, NOT a verdict on whether the member is shipping. The cadence column is the new primary verdict; the pane-state column persists for one release cycle so operators with muscle memory still see the process diagnostic.
- **New `team.json::cadence` config block** per ADR-148 §D7 — opt-out via `cadence.enabled: false`; per-member opt-out via `cadence.exemptMembers: ["planner", "reviewer"]` (exempt members render as `(exempt)`); per-team threshold overrides under `cadence.thresholds` (shippingMaxAgeSec / idleMaxAgeSec / dormantMaxAgeSec / shipZeroWindowSec). Defaults match ADR-148 §D7 (30-min ship window, 2-hr ship-zero threshold matching CLAUDE.md whip §0.05 stake floor).
- **JSON output gains `members[].cadence`** with the `CadenceObservation` shape (`windowSec`, `commitsInWindow`, `lastCommitAt`, `lastCommitSha`, `ageOfLastCommitSec`, `verdict`). Backwards-compat: the legacy `paneCommand` + `cageState` fields remain unchanged so existing consumers (dashboards, cockpit aggregators) are not broken.
- **Out of scope this commit** — T3 (lane-stall cron rule) + T5 (`src/core/cadence-classifier.ts` extraction + martinet observe() wiring + `[ship-zero-window]` Discord template) ship in follow-up Tasks under the same EPIC. T2 inlines the classifier in `src/verbs/status.ts` so the column surfaces today; T5 lifts the classifier verbatim into the shared module.

### 📋 Proposed — commit-cadence ground-truth health signal (ADR-148)

- **New `team.cadence` config block** per [ADR-148](docs/adr/148-commit-cadence-truth-signal.md) §D7 — full schema lands in T3 (this commit, `t-e9424574`) so T2 / T5 land additively. Fields: `enabled`, `windowSec`, `thresholds` (4 verdict bands), `laneStallEnabled`, `laneStallMinAgeSec`, `exemptMembers`. Opt-in via `enabled: true`; lane-stall defaults on once master switch flips.
- **Lane-stall fallback cron** per ADR-148 §D4 (T3, `t-e9424574`): new `atmux lane-stall-tick` verb fires every 5min by default (override via `cron-install --template lane-stall-watch --interval <N>`). Scans `lane=X todo` Tasks older than `laneStallMinAgeSec` (default 30min) against per-member cadence verdicts; when ALL lane-affinity members have verdict ∈ {idle, dormant, ship-zero-window}, fires Enter-push `atmux claim <id>` to the lane's most-recently-active member's pane. Pane-state check mandatory before send-keys per CLAUDE.md (uses `safeSendKeys` for classify + retry + refuse). On refuse, appends to `<atmuxDir>/state/lane-stall-flags.md` for operator review. Dedup via `~/.atmux/state/lane-stall-fires.json` with `(taskId, lane, firedAt)` rows; skips re-fire within `laneStallMinAgeSec / 2` (15min default).
- **Sibling to ADR-127** lane-claim auto-pickup. ADR-127 handles the `member-idle` event (member finishes a turn → cron injects `claim --next`); ADR-148 §D4 adds the `lane-stall` event (Task waits in lane while members idle). Both paths converge on the same `atmux claim` Enter-push; lane-claim is per-member-state, lane-stall is per-Task-age.
- **Cadence verdict source** stubbed at the verb's dep-injection layer until T5 (`src/core/cadence-classifier.ts`) lands — defaults to `"idle"` for every member (worst-case fall-through; lane-stall fires whenever the age + lane-membership gates trip). T5 swaps in the real `classifyMemberCadence` reading per-member `git log --since=<windowSec>s --format='%H %ct'`.
- **Status: proposed** — T1 reviewer signoff landed via `t-1e9fd74e`; T2 / T5 / T6 still parallel-shipping. ADR flips to accepted once the full plan (T2-T6) lands green.

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
  + lead. T2–T4 (ADR annotations, medic refactor, martinet
  NudgeAction enum extension) remain open under the EPIC —
  recommend planner-near decomposes into separate kanban Tasks
  so they're claimable. Kanban Task `t-83dcef6b` (EPIC; T1 done
  this commit).
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
