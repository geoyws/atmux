# ADR-271: SQLite is the sole coordination store (retire the `kanban.json` compatibility path), and the Rust `atmux-orchd` daemon coordinates by default

**Status**: proposed
**Date**: 2026-08-07
**Driver-ref**: operator-direct 2026-08-07, verbatim — *"also we dont' want to use kanban.json anymore... we just wnat to use sqlite and have a rust binary help do the coordination"*. Two limbs in one sentence: **(1)** retire the JSON store, **(2)** put the Rust daemon back in the coordinator seat. Limb 2 is a deliberate reversal of [ADR-260](260-manual-orchestration-mode-default.md)'s default (2026-06-12), which this ADR supersedes on that one point only — see D10/D11.
**Relates**: [ADR-126](126-sqlite-state-store.md) (**SQLite is canonical — accepted 2026-05-23; this ADR does NOT re-decide that**, it retires the compatibility path ADR-126 left behind), **ADR-060** (the dual-path storage-routing contract `src/core/kanban.ts:71-85` cites by name — the surface D2 deletes. **Unfiled: `docs/adr/060-*.md` does not exist**, verified 2026-08-07; the number is cited by ten ADRs and by code but was never written up, so it is referenced here as a bare number, not a link — see OQ-8), [ADR-098](098-json-and-locking.md) (the JSON+flock model ADR-126 narrowed), [ADR-169](169-state-json-sqlite-migration-3-phase.md) (the ratified-but-unimplemented `.atmux/state/*.json` migration — explicitly OUT of scope here, see OQ-1), **ADR-076** (the inbox JSON→SQL cutover — the precedent D3/D4 copy. **Also unfiled**, same verification, same OQ-8), [ADR-013](013-kanban-write-atomicity.md) (kanban write-atomicity — the flock-around-`updateJson` mechanism that becomes dead weight once the JSON writer is gone; note ADR-169's cross-ref list links this to a non-existent `005-atomic-json-and-flock.md` — the real ADR-005 is `005-doctor-preflight.md`, so ADR-013 + ADR-098 are the correct anchors), [ADR-266](266-shim-sunset-policy-and-first-sweep.md) §D1 (**shim-sunset policy — D8 follows it rather than inventing a deprecation shape**), [ADR-260](260-manual-orchestration-mode-default.md) (**superseded on its §D1 default + §D2 spawn consequence by D10; its mode switch and manual escape hatch are KEPT by D11**), [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) ("orchd is the runtime, not cron" — the direction D10 restores; still `Status: proposed`, cited as the operator's standing position), [ADR-202](202-honker-in-db-messaging-substrate.md) §VII/§Amendment (the Honker substrate + the Rust-supervisor/Bun-handler wire protocol D12 keeps), [ADR-224](224-orchd-rename-and-auto-spawn-loop.md) (relayd→orchd rename + the `__orchd__` window), [ADR-240](240-drop-superorchd-orchd-self-supervises.md) (orchd self-supervises — no second supervisor tier is added here), [ADR-249](249-orchd-singleton-guard.md) (per-DB singleton lock — the guard that makes a default-on daemon safe), [ADR-256](256-orchd-rust-hardening.md) (bounded waits + poison-event tripwire — the hardening that makes a default-on daemon *survivable*), [ADR-259](259-committer-member-optional-orchd-gates-on-automerge.md) (removed the committer-presence spawn gate for exactly the reason D10.2 removes the `autoMerge.enabled` spawn gate), [ADR-226](226-orchd-auto-merge-subscriber.md) / [ADR-229](229-orchd-auto-push-and-safety-gates.md) / [ADR-231](231-orchd-auto-spawn-and-solo-worker-dissolve.md) / [ADR-247](247-lead-stall-watchdog.md) / [ADR-212](212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md) / [ADR-214](214-retire-ombudsman-lead-absorbs-complaint-adjudication-via-honker.md) (the consumers that stop being opt-in), [ADR-267](267-durable-agent-continuity-contract.md) §D4(c) (**deferred its checkpoint cadence explicitly because no process was running — D14 is the unlock**), [ADR-261](261-issue-sync-external-tracker-ingestion.md) (its §Context gap 3 — "an orchd-only poller would be dormant on every current team" — is what D10 fixes; its dual-runtime hedge can collapse), [ADR-203](203-event-topic-taxonomy.md) (closed topic set — deliberately NOT amended), [ADR-007](007-pull-kanban.md) (the pull-kanban surface every retired JSON path served), [ADR-245](245-singleton-atmux-per-project.md) (one kanban per project — the resolution rule D3's refusal message must not violate), [ADR-239](239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) §Supplement-2026-05-26 / [ADR-244](244-per-repo-pre-commit-kanban-decisions-snapshot.md) §Supersession-2026-05-26 (`.atmux/` is operator-private and symlinked out of the product repo — where the files D3 refuses on actually live), [ADR-268](268-managed-repo-state-isolation-enforcement.md) (the same residency invariant, proposed for enforcement).

---

## Context

The operator's sentence has two limbs that are usually discussed separately. They are one ask because they share one substrate: `state.db` is both the store Limb 1 makes exclusive and the event bus Limb 2's daemon subscribes to. Each limb is grounded below against the code and the host as of **2026-08-07**.

### Limb 1 — what "dual-path" actually means today

`docs/PRD.md:11-15` carries the standing description: *"the bun port is dual-path with `state.db` as source of truth when present."* That is accurate but incomplete, and the incompleteness is the problem.

**The routing seam is one `exists()` syscall.** `src/core/kanban.ts:88-90` resolves the DB as `join(atmuxDir, "state.db")` — i.e. **`.atmux/state.db`, NOT `.atmux/state/state.db`** — and `:92-94` defines `_useSqlite(atmuxDir)` as nothing more than `await exists(_stateDbPath(atmuxDir))`. The module header at `:71-85` states the intent: post-migration route through `KanbanRepo`; pre-migration the JSON implementation "stays the source of truth".

**There are 18 dual-path call sites, all in `src/core/kanban.ts`.** Every one is the same `if (await _useSqlite(atmuxDir)) { …repo… }` followed by a JSON fallthrough:

| # | Function | `_useSqlite` at |
|---|---|---|
| 1 | `loadKanban` (`:154`) | `:155` |
| 2 | `addTask` (`:192`) | `:211` |
| 3 | `listTasks` (`:322`) | `:323` |
| 4 | `showTask` (`:354`) | `:355` |
| 5 | `moveTask` (`:380`) | `:406` |
| 6 | `markTaskBlockedWithNote` (`:680`) | `:685` |
| 7 | `setTaskLane` (`:711`) | `:716` |
| 8 | `setTaskEpic` (`:733`) | `:738` |
| 9 | `setTaskStory` (`:754`) | `:759` |
| 10 | `setTaskDeliverable` (`:776`) | `:782` |
| 11 | `setTaskPriority` (`:799`) | `:804` |
| 12 | `setTaskBody` (`:819`) | `:825` |
| 13 | `setTaskDeps` (`:840`) | `:845` |
| 14 | `setTaskDriverOnly` (`:867`) | `:872` |
| 15 | `assignTask` (`:908`) | `:913` |
| 16 | `removeTask` (`:927`) | `:928` |
| 17 | `claimTask` (`:967`) | `:977` |
| 18 | `markTaskDone` (`:1151`) | `:1162` |

Their JSON write sinks are six `updateJson(kanbanJsonPath(atmuxDir), …)` calls at `src/core/kanban.ts:177`, `:271`, `:936`, `:1021`, `:1183`, `:1371`. `src/core/epic.ts` and `src/core/story.ts` are **already SQL-only** — neither imports `kanbanJsonPath`; `epic.ts:59-89` opens the DB unconditionally. So the compat path is confined to task primitives.

**Outside `kanban.ts` the callers split three ways, and two of the three ways are broken.** Verified by grepping `state.db` / `_useSqlite` / `openDatabase` in each file — the "JSON-only" files return **zero** matches:

- **(a) Correct — checks the DB first or gates on either store:** `src/verbs/doctor/state.ts:98-109` (DB branch, JSON `else`), `src/verbs/status.ts:685-697` (`hasSqlite || hasJson` then `loadKanban`), `src/verbs/pulse.ts:188-197` (same, with an in-code note that a bare `loadKanban` would create a stub file).
- **(b) JSON-only READERS — silently blind on every SQL-canonical team, today, in production:** `src/core/discorder.ts:139-152` (done-tasks + advanced-stories digest) and `:286-299` (in-flight / blocked counts) both wrap in `if (await exists(kpath))` and therefore report **zero** when only `state.db` exists; `src/verbs/report.ts:266` does `tryReadJson(kanbanJsonPath(…))` and falls to `tasks = []`, so `atmux report`'s shipped / in-progress / blocked sections are empty; `src/verbs/doctor/driver.ts:196-198` returns `[]` when the JSON is absent, so the `inbox-mark-orphan` probe never fires. These are four live bugs whose single root cause is the compat path, not four independent defects.
- **(c) JSON-only WRITERS:** `src/verbs/init.ts:356-361` unconditionally seeds `{"tasks":[],"epics":[],"stories":[]}\n` when the file is absent — it never checks for `state.db`, so it manufactures the very legacy file everything else must then tolerate; `src/verbs/handoff.ts:243` (`migrateTasks`) reassigns in-progress/blocked task ownership through `updateJson` **with no SQL branch at all**, which means lead/member handoff silently reassigns nothing on a SQL team *and* writes a stub JSON file as a side effect; `src/core/groom.ts:701-702` early-returns when the JSON is absent (already recorded as an anchor in [ADR-267](267-durable-agent-continuity-contract.md) §Decision-anchors) and `:761-772` backs up + rewrites it; `src/verbs/stop.ts:533-538` copies it into the archive.
- **(d) The one legitimate reader:** `src/verbs/migrate-state.ts` — `migrateKanban` at `:188-195` throws `ConfigError` when the file is absent, `:397-406` renames it into `.atmux/archive/json-pre-sqlite-<epoch>/`, and `:470-471` runs it for `--target=all|kanban`. This is the migration ramp and must survive (D5).

**Fleet reality on hax, 2026-08-07 (bounded scan of `/root/work/src/*`, `/root/work/ifca/src/*`, `/root/work/unum/src/*`, `/root/work/journals/.sb`):** twelve `.atmux/kanban.json` files exist. Ten are the empty seed (`50` bytes, or `37` for `hotel-service`) — pure litter from `init.ts:356-361`. **Two are populated:**

| Path | `kanban.json` | Contents | `state.db` |
|---|---|---|---|
| `/root/work/ifca/src/ifca-docs/.atmux/` | 44,063 B | 20 tasks / 1 epic / 5 stories | **present** (610,304 B, 24 tasks) |
| `/root/work/ifca/src/auditx-root/.atmux/` | 94,566 B | **50 tasks / 2 epics / 5 stories** | **MISSING** |

`ifca-docs` is the benign case: `_useSqlite` already routes to the DB (24 tasks there vs 20 in the JSON), so its JSON is a stale orphan. **`auditx-root` is a live JSON-only team** — 4 roster members, `orchestration.mode: "manual"` — and it is the reason a blunt delete is unsafe. There is also stray litter at `/root/work/journals/.sb/_dotfiles/atmux/kanban.json` (50 B, mtime 2026-05-24): an empty seed that `init.ts`'s walk-up resolution deposited in the dotfile tree **root** instead of a `<repo-key>/` directory.

**The hazard that dictates the mechanism.** `src/abstractions/sqlite.ts:33` opens with `new Database(path, { create: true })`. So the *first* verb call on a team with no DB **creates** one and applies the ladder — after which `_useSqlite` is permanently true and the populated `kanban.json` is invisible. This is not a hypothesis: it is documented in-code at `src/core/superdoctor-activity.ts:96-104`, which skips its probe entirely for exactly this reason ("probing a team without an existing state.db SIDE-EFFECTS the team's `.atmux/` by creating an empty DB … Downstream readers of `loadKanban` then see state.db as the canonical store via `_useSqlite` and silently report empty kanban — even when the team has a populated kanban.json"). Deleting the fallback without a guard converts that one probe's known footgun into the behaviour of *every* verb, and `auditx-root`'s 50 tasks are the payload.

**Doc/brief debt.** `templates/briefs/` is now down to a single `kanban.json` mention: `templates/briefs/committer.md:282` deliberately retains *"Tasks live here per ADR-126 (legacy kanban.json is the deprecated mirror)"* — accurate as of the 2026-08-06 batch, obsolete the moment D2 lands. `src/schema/kanban.ts:1`, `:18`, `:336-345`, `src/schema/README.md:27` + `:51`, and `src/abstractions/sqlite-migrations.ts:7` all still describe the file as a live store. `README.md`, `CHANGELOG.md`, `docs/ARCHITECTURE.md`, `docs/PRD.md`, `docs/RUNBOOK-grooming.md`, `plugins/atmux/skills/bau/SKILL.md`, and `plugins/atmux/skills/heads-up/SKILL.md` each carry references (historical-ADR mentions are append-only and stay). Test surface: **31 TypeScript** test files and **51 `.bats`** files reference `kanban.json` — the bats harnesses are already out of scope per [ADR-266](266-shim-sunset-policy-and-first-sweep.md) §Out-of-scope ("the 102 bash-era `tests/unit/*.bats` harnesses").

### Limb 2 — what the Rust daemon already is, and the three-step position history

`rust/` holds **three** crates, built by `package.json` `build:orchd` / `build:listener` / `build:cockpit-mirror` and installed into `/opt/atmux/<version>/bin/` by `build:install`:

- **`atmux-orchd`** — the per-team coordinator. This is the "rust binary" the operator means.
- **`atmux-listener`** — a stdout-streaming wrapper around Honker's blocking `Database::listen()`, so a Bun parent can `read_line()` instead of polling `MAX(id)`.
- **`atmux-cockpit-mirror`** — cockpit-scope reader over `~/.atmux/cockpit-events.db` ([ADR-230](230-cockpit-mirror-rust-crate-fleet-event-consumer.md); the crate header's own "ADR-219" cite is stale — `docs/adr/219-*.md` is `dissolve-epic-completeness`).

**What `atmux-orchd` does today** (`rust/atmux-orchd/src/main.rs`, 1,489 lines). It is a **supervisor + dispatcher, not a rewrite of the logic**: it stays kernel-blocked on Honker's `update_events()` waker, drains new event rows per consumer offset, and spawns `atmux orchd --handle-one --event-id <id> --topic <t> [--consumer-id <id>]` as a one-shot Bun subprocess per event, advancing the offset only on `rc=0` (`main.rs:1-45`). Idle cost is Rust-only, ~5 MB RSS. Concretely:

- **10 consumers** in the `CONSUMERS` slice (`main.rs:176-256`): two legacy topic-routed (`atmux:gitter` on `task.done`, `atmux:lane-router` on `task.unclaimed`) plus eight registry-routed — `orchd:auto-merge`, `orchd:dissolve-solo-worker` (both `task.done`), `orchd:auto-push` (`epic.merged`), `orchd:auto-dissolve` (`epic.pushed`), `orchd:spawn:on-ready` (`epic.ready`), `orchd:spawn:on-unblocked` (`epic.unblocked`), `complaint-consumer` (`complaint.filed`), `rotation-consumer` (`member.context-high`).
- **4 tickers + log rotation**, all in-process, no crontab artifact: sweep-merges 300 s (`:944`), log-rotate 3600 s (`:948`), context-scan + budget-scan 900 s (`:956`), housekeep 86400 s (`:961`); the wake loop uses a 60 s `recv_timeout` belt-and-braces drain (`:975`).
- **Hardening already landed**: bounded child waits with SIGTERM→grace→SIGKILL escalation (600 s per-event handler / 900 s per tick, `:73-74`, [ADR-256](256-orchd-rust-hardening.md)), a 5-strike poison-event dead-letter tripwire, `PR_SET_PDEATHSIG(SIGTERM)` so the daemon dies with its tmux pane, and a per-DB singleton lock ([ADR-249](249-orchd-singleton-guard.md)).

**A verified drift**: the Bun side registers **11** consumer ids (`src/core/orchd-bootstrap.ts`), because [ADR-247](247-lead-stall-watchdog.md) §D2's three lead-stall subscriptions (`story.ready` / `story.unclaimed` / `task.unclaimed`, registered at `orchd-bootstrap.ts:335-362`) landed in commit `e567f89` **without a matching `CONSUMERS` entry in Rust** — `rg -n 'lead-stall' rust/` returns nothing. The Rust supervisor only drains topics it lists, and `task.unclaimed` is claimed by the legacy `atmux:lane-router` entry with `bun_consumer_id: None`, so all three watchdog subscriptions are unreachable. Shipped-but-unwired; D13 closes it.

**The three-step position history on the daemon question — stated with dates because the operator has complained that atmux's docs flip-flop here.** `docs/PRD.md` §1.2 principle 3 (corrected 2026-08-06) already narrates exactly this trail and this ADR is consistent with it; principle 3's *"Current position (read this one)"* block is what D10 replaces:

1. **2026-05-06 — "No daemon."** Nothing long-lived; `whip` (15 min) and `report` (30 min) ran on cron.
2. **2026-05-24 — orchd is the runtime.** [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) retired cron auto-install after the hax boot-storm (1 m loadavg 27 on a 16-core box), naming the Rust daemon as the replacement runtime; [ADR-237](237-no-llm-discord-and-whip-removal.md) killed the LLM whip cadence.
3. **2026-06-12 — manual is the default, orchd is opt-in.** [ADR-260](260-manual-orchestration-mode-default.md) §D1 set `team.json::orchestration.mode` default `"manual"` (`src/schema/team.ts:791` `DEFAULT_ORCHESTRATION_MODE`, resolved at `:797-801`) and §D2 added Gate-1 at `src/core/orchd-window.ts:99-104` so a manual team spawns **no `__orchd__` window at all**. Rationale, operator-verbatim in ADR-260: *"LLMs can manage their own fleet better than atmux can at the moment."*

**What step 3 produced, measured 2026-08-07:** **20 of 20** `team.json` files in `~/work/journals/.sb/_dotfiles/atmux/*/` carry `"orchestration": { "mode": "manual" }` — zero exceptions — and `pgrep -c atmux-orchd` returns **0**. There is no coordinating process anywhere on the host. atmux's own `.atmux/team.json` is the sharpest illustration: `autoMerge.enabled: true` **and** `mode: "manual"`, i.e. auto-merge is configured and dead. Downstream ADRs have been designing around the vacuum rather than treating it as a defect: [ADR-261](261-issue-sync-external-tracker-ingestion.md) §Context gap 3 records that "an orchd-only poller would be dormant on every current team" and pays for a dual runtime home to compensate; [ADR-267](267-durable-agent-continuity-contract.md) §D4(c) declines a checkpoint cadence partly because "a ticker would be dormant on every current team".

**Step 4 is this ADR: the Rust daemon coordinates by default.** ADR-260's premise was that *atmux's automation* was less trustworthy than an LLM lead. Two things changed. First, the automation got hardened — [ADR-249](249-orchd-singleton-guard.md) (no double-daemon), [ADR-256](256-orchd-rust-hardening.md) (no unbounded child wait, no infinite poison retry), [ADR-240](240-drop-superorchd-orchd-self-supervises.md) (no second supervisor tier) all landed accepted **after** ADR-260. Second, the cost of the vacuum became visible: nothing sweeps merges, nothing prunes events, nothing scans context or budget, and every new design pays a dormancy tax. This is a restoration of ADR-233's direction, not a fourth position.

---

## Decision

### D1 — Scope: this ADR does not re-decide SQLite canonicality

[ADR-126](126-sqlite-state-store.md) is `accepted` (ratified 2026-05-23) and already says SQLite is canonical with JSON archive-only; the kanban migration shipped at epoch `1778159007497`. **What this ADR retires is the JSON *compatibility path* that ADR-126 left in place** — the `_useSqlite` fork, the JSON fallthroughs, and the seeder that keeps re-creating the legacy file. Read D2–D9 as "finish ADR-126", never as "decide the store".

Scope boundary, stated so no implementer widens it: **`.atmux/kanban.json` only.** The 14 residual `.atmux/state/*.json` files that [ADR-169](169-state-json-sqlite-migration-3-phase.md) ratified on 2026-05-21 are **out of scope** (OQ-1) — and note that ADR-169 was never implemented: the ladder head is `to: 17` (`src/abstractions/sqlite-migrations.ts:813`) with no `flags` / `role_state` / `budget` table, and 31 `*.json` files remain under `.atmux/state/`. `team.json`, `cockpit.json`, `.claude/team.json`, `decisions.md`, and `flags.md` stay as they are, per [ADR-164](164-sync-claude-team-json.md) and ADR-169 §KEEP-AS-JSON.

### D2 — `src/core/kanban.ts` goes SQL-unconditional; the 18 forks and 6 JSON write sinks are deleted

All 18 `if (await _useSqlite(atmuxDir))` branches collapse to their DB body; the six `updateJson(kanbanJsonPath(…))` sinks (`:177`, `:271`, `:936`, `:1021`, `:1183`, `:1371`) and the `emptyKanban()` `initial` shim (`:1350-1371`) are deleted. `_useSqlite` (`:92-94`) is deleted; `_stateDbPath` (`:88-90`) stays and is the sole path resolver. The `// ---------- Storage routing (ADR-060) ----------` header block (`:71-85`) is replaced with a pointer to this ADR. `KanbanSchema` / `Kanban` imports drop from `kanban.ts` where they become unused; `src/schema/kanban.ts` itself **stays** — `migrate-state` still validates with it (D5).

`kanbanJsonPath` (`src/core/common.ts:107-109`) **stays** for exactly three surviving callers: `migrate-state` (D5), the D3/D4 detector, and `stop.ts`'s archive copy (D6). It stops being a store locator and becomes a legacy-artifact locator; its docstring says so.

### D3 — Fail closed when a populated `kanban.json` exists and `state.db` does not

This is the load-bearing safety rule and it is not negotiable, because `src/abstractions/sqlite.ts:33` opens `{ create: true }`: with D2 landed and no guard, the first verb invocation on `auditx-root` creates an empty DB, applies 17 migrations, and its 50 tasks / 2 epics / 5 stories become unreachable in one syscall, with no error.

**Rule.** A shared preflight — one helper, called from the kanban-touching verb entry points, not scattered per-verb — refuses with `ConfigError` (exit 78) when **both** hold: `<atmuxDir>/kanban.json` exists **and** parses to a non-empty `tasks|epics|stories`, **and** `<atmuxDir>/state.db` does not exist. The message names the file, the counts, this ADR, and the exact remedy:

```
atmux: <atmuxDir>/kanban.json holds 50 tasks / 2 epics / 5 stories but there is no
       state.db. SQLite is the sole store per ADR-271 (finishing ADR-126); the JSON
       path was retired in v0.8.31.
  fix: atmux migrate-state json-to-sqlite --target=kanban --team-dir <atmuxDir>
       (idempotent upsert; archives the JSON to .atmux/archive/json-pre-sqlite-<epoch>/)
```

Three constraints on the implementation. **(i)** The check must run **before** any `openDatabase` call on that team, or it defeats itself. **(ii)** It resolves the team's `.atmux` exactly as the verbs do (`getAtmuxDir` walk-up, [ADR-245](245-singleton-atmux-per-project.md) — one kanban per project), so it never refuses on a *worktree-local* directory when the team root is elsewhere; `.atmux/` is symlinked out of the product repo per [ADR-239](239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) §Supplement-2026-05-26, and `fs` follows symlinks, so no special casing. **(iii)** An **empty** seed (the ten 37–50-byte files on this host, and the dotfile-root stray) must NOT refuse — it is deleted silently by D4, because refusing on litter would brick ten teams for zero data.

`atmux migrate-state` and `atmux doctor` are exempt from the refusal: they are the diagnosis and the remedy.

### D4 — Migrate-then-ignore for the harmless cases; a doctor row, never silence

- **Both stores present** (the `ifca-docs` case): the DB wins, as it already does. The JSON is left on disk untouched — it may hold rows the DB does not — and `atmux doctor` emits a **yellow** `legacy-kanban-json-present` row naming the file, its parsed counts, this ADR, and the `migrate-state --target=kanban` remedy (upsert is idempotent, so re-running it is safe and merges the orphans in). No auto-migration: silently mutating a live team's DB from a stale file is a data decision, not a hygiene decision.
- **Empty seed present** (ten teams here): deleted on the next `atmux doctor --fix` / `atmux cleanup` pass with a one-line receipt. Zero rows, zero risk. Includes `~/work/journals/.sb/_dotfiles/atmux/kanban.json`.
- **Neither present**: nothing to say. Silence is correct.

Naming: `legacy-kanban-json-present` — deliberately **not** `migration-state-incomplete`, which ADR-169 §OQ-6 reserved for the `.atmux/state/*.json` sweep (and which, verified 2026-08-07, does not exist in `src/`; that probe was never built).

### D5 — `atmux migrate-state` is the one surviving reader of `kanban.json`, permanently

`src/verbs/migrate-state.ts` is **not** deprecated and carries no sunset marker. It is the ramp D3's error points at, and it must keep working for as long as any JSON file can turn up (archives, an old clone, a colleague's tree). Three fixes ride the same commit:

1. `migrateKanban` (`:188-195`) raises `ConfigError` when the file is absent — which makes `atmux migrate-state json-to-sqlite` (default `--target=all`, `:470-471`) **fail on an already-migrated team**. Post-D2 that is actively misleading. `--target=all` treats an absent `kanban.json` as a skip-with-warning, matching how it already handles the unimplemented `state` target (`:491-493`). An explicit `--target=kanban` on a missing file keeps erroring — asking for a specific migration that cannot run is a real usage error.
2. **`--dry-run` stops creating the DB it is inspecting.** `openDatabase(dbPath, migrations)` runs unconditionally at `:465` — only `ensureDir` is skipped on dry-run (`:461-463`) — so a dry-run **materialises** `state.db`. The comment at `:459-460` asserts this is "harmless: it's an empty schema file"; it is not, and the counter-example is on this host. An empty `state.db` is the precise trigger for the `_useSqlite` blindness documented at `src/core/superdoctor-activity.ts:96-104`, so on a JSON-only team a dry-run is the thing that loses the kanban. Fix: **a dry-run must never create the file.** For `--target=kanban` that means not opening the DB at all — `migrateKanban`'s dry-run branch returns pure Zod counts at `:199-205` and never touches `repo`. For the other targets, whose dry-run genuinely needs to read existing rows (`migrateInboxes` compares against the `tasks` table), open **read-only** and let a missing DB report "nothing to compare against" rather than materialising one. The false comment is deleted in the same edit, and a regression test asserts `state.db` does not exist after a `--dry-run` on a JSON-only fixture. **This lands in Commit A, before D3's guard**, since D3's remedy instruction is what will send operators at this verb.
3. Its module header (`:1-42`) and the `--target` help text stop calling kanban "the highest-leverage corruption target" in the present tense and cite this ADR as the reason the verb now exists solely as a ramp.

### D6 — The four JSON-only readers and two JSON-only writers are FIXED, not deleted

Retirement is not "remove the JSON reads and ship" — four of these paths are the only implementation their feature has. Each moves to `KanbanRepo` (or `loadKanban`, which is repo-backed after D2), and each **ships with the test that would have caught the bug**: a SQL-canonical fixture (`state.db` present, no `kanban.json`) asserting non-empty output. Today every one of these would pass while returning nothing — a test that green-lights a broken feature is a lie ([global CLAUDE.md](../../CLAUDE.md) §Engineering).

| Site | Today | After |
|---|---|---|
| `src/core/discorder.ts:139-152` | done-tasks / advanced-stories digest reads JSON → **0 on SQL teams** | `KanbanRepo` |
| `src/core/discorder.ts:286-299` | in-flight / blocked counts → **0 on SQL teams** | `KanbanRepo` |
| `src/verbs/report.ts:266` | `tasks = []` → shipped/in-progress/blocked all empty | `KanbanRepo` |
| `src/verbs/doctor/driver.ts:196-198` | returns `[]` → `inbox-mark-orphan` never fires | `KanbanRepo` |
| `src/verbs/handoff.ts:243` (`migrateTasks`) | reassigns owners in JSON only → **handoff silently reassigns nothing**, and writes a stub JSON | repo-backed owner reassignment inside one `transactImmediate` |
| `src/core/groom.ts:692-772` (`summarizeKanban`) | no-op on SQL teams (early return at `:701-702`) | see below |
| `src/verbs/doctor/state.ts:98-109` | correct | drop the JSON `else` |
| `src/verbs/status.ts:685-697`, `src/verbs/pulse.ts:188-197` | correct | drop the `hasJson` half of the gate |
| `src/verbs/stop.ts:533-538` | copies `kanban.json` to archive | **kept**, `exists`-guarded — archiving a legacy artifact is right |

`summarizeKanban` is the one judgement call, and D2 does not change its behaviour: it is *already* a no-op on SQL teams (the anchor [ADR-267](267-durable-agent-continuity-contract.md) §Decision-anchors records), and the sub-op that actually deletes `tasks` rows is `groomArchive` (`src/verbs/groom.ts:677-681`; `src/core/groom-archive.ts`). So `summarizeKanban`'s markdown-rollup half is either (a) re-pointed at the repo, or (b) deleted as dead-on-arrival with its rollup folded into `groomArchive`. **(b) is the recommendation** — one summariser, not two — but it touches `docs/RUNBOOK-grooming.md` and the groom sub-op numbering, so it is **OQ-2**, not decided here. Whichever wins, `groom.ts:800`'s `cullBakFiles` families list keeps `"kanban.json"`: `.bak.*` files exist on disk and still need culling.

### D7 — `atmux init` stops creating `kanban.json`

`src/verbs/init.ts:356-361` no longer writes the seed. Instead it calls `openDatabase(join(atmuxDir, "state.db"), migrations)` and closes — the ladder is idempotent, so a fresh team comes up with an empty, migrated `state.db` and no JSON. This is what stops the litter at the source; ten of the twelve files on this host, plus the dotfile-root stray, exist only because this line ran. `driver-inbox.md` seeding (`:363-366`) is untouched. The stale header comments at `init.ts:10`, `:27`, and `:349-355` (which quote bash `lib/init.sh:87-107` parity) are corrected in the same commit — parity with decommissioned bash is not a reason to keep writing the file.

### D8 — Deprecation shape follows [ADR-266](266-shim-sunset-policy-and-first-sweep.md) §D1; nothing new is invented

ADR-266 §D1 requires an explicit expiry and a greppable `SUNSET(<version-or-date>):` marker at every shim site, and makes a parse-affecting shim "a hard, actionable error first (naming this ADR) where the expired contract already promised failure". The kanban JSON path **never published an expiry**, so a straight silent delete would be the exact failure mode ADR-266 §Context indicts. Therefore:

- **v0.8.31 (this ADR's release; current is `0.8.30`)** — D2's forks go; D3's hard error and D4's doctor row are the migration surface. Both the refusal and the doctor row carry `SUNSET(v0.9.0):` markers at their sites, per §D1. The error names ADR-271.
- **v0.9.0** — the D3 refusal is removed (by then any JSON-only team has migrated or is abandoned); D4's yellow doctor row **stays permanently**, because archives and old clones will keep surfacing the file forever, and a probe that names a stale artifact is worth more than its upkeep.

This deliberately matches [ADR-264](264-cockpit-session-atx-rename.md)'s shims, which ADR-266 §D4 pinned to the same v0.9.0. One sunset train, not two.

### D9 — Doc, brief, and schema-comment debt, enumerated

Same-commit, per the binding-discipline rule in [CLAUDE.md](../../CLAUDE.md) §"Binding discipline" item 2:

1. **`templates/briefs/committer.md:282`** — drop the "(legacy kanban.json is the deprecated mirror)" clause; the line becomes `state.db — Tasks live here per ADR-126; SQLite is the sole store per ADR-271`. This is the one brief clause the 2026-08-06 sweep intentionally left, and D2 is what makes it obsolete.
2. **`docs/PRD.md:11-15`** — the "dual-path with `state.db` as source of truth when present" note becomes "SQLite is the sole store per ADR-271; JSON is archive-only and read only by `atmux migrate-state`". Keep the corrected §1.2 principle 2 wording as-is — it already says the canonical store is `.atmux/state.db`, and it already carries the verified "**not** `.atmux/state/state.db`" caveat.
3. **`docs/PRD.md` §1.2 principle 3** — replace its *"Current position (read this one)"* block with D10, and **append step (iv) 2026-08-07 to the position history rather than rewriting steps (i)–(iii)**. The history is the whole point of that block; erasing a step to make the page tidy is what produced the flip-flop complaint.
4. **`docs/ARCHITECTURE.md`**, **`README.md`**, **`CHANGELOG.md`**, **`docs/RUNBOOK-grooming.md`**, **`plugins/atmux/skills/bau/SKILL.md`**, **`plugins/atmux/skills/heads-up/SKILL.md`** — re-point live-store references at `state.db`. Historical ADR bodies are append-only and are **not** edited (ADR-007/013/098/126/169 et al keep their wording); this ADR is their supersession record.
5. **Schema + migration comments**: `src/schema/kanban.ts:1`, `:18`, `:58`, `:136`, `:250`, `:336-345`; `src/schema/README.md:27` + `:51`; `src/abstractions/sqlite-migrations.ts:7` — all describe `.atmux/kanban.json` as a live store. Re-caption as the migration source shape.
6. **Tests**: the **31** TypeScript files that reference `kanban.json` are re-pointed at SQL fixtures (the four D6 bug-pins are net-new assertions, not rewrites). The **51 `.bats`** files stay untouched per ADR-266 §Out-of-scope; if any of them gate CI, that is surfaced as its own Task rather than silently skipped.
7. **`docs/adr/INDEX.md`** — add the ADR-271 row. (Not done in this ADR's own commit if a sibling agent is concurrently adding 270 — one edit, both rows, to avoid a clobber.)

### D10 — `orchestration.mode` defaults to `"orchd"`; the Rust daemon coordinates unless a team opts out

**This supersedes [ADR-260](260-manual-orchestration-mode-default.md) §D1 (default `"manual"`) and §D2's consequence** ("every team that does not explicitly set `mode: "orchd"` runs orchd-less from its next `atmux start`"). ADR-260 is not edited — it is superseded from here, per the append-only convention.

**D10.1 — the default flips.** `DEFAULT_ORCHESTRATION_MODE` (`src/schema/team.ts:791`) becomes `"orchd"`; an absent `orchestration` block resolves to `"orchd"` via `resolveOrchestrationMode` (`:797-801`). Gate-1 in `maybeSpawnOrchdWindow` (`src/core/orchd-window.ts:99-104`) is unchanged in *shape* — `mode !== "orchd"` still skips — only its default answer changes. Its log line is reworded to cite this ADR alongside ADR-260.

**D10.2 — Gate-2 moves from spawn-time to consumer-time.** `src/core/orchd-window.ts:106-108` currently refuses to spawn unless `team.autoMerge?.enabled === true`, and that field defaults to `false` (`src/schema/team.ts:670`). Left alone, D10.1 would be cosmetic: most teams would still get no daemon. Gating a daemon that hosts **ten** consumers on the **one** auto-merge knob is the same over-restriction [ADR-259](259-committer-member-optional-orchd-gates-on-automerge.md) already diagnosed when it removed the committer-presence gate. So `autoMerge.enabled` stops gating **spawn** and gates **auto-merge**, where it belongs:

- The precedent already exists at consumer level: `src/verbs/committer.ts:289` (`team.autoMerge?.enabled !== true` → logged no-op).
- **`sweepMerges` does NOT currently self-gate** (verified: `src/core/orchd-merge-sweep.ts:84+` has no `autoMerge` reference) and it *dispatches* merges, so the same commit **adds** the `autoMerge.enabled !== true → no-op` check at the `--sweep-merges` tick entry (`src/verbs/orchd.ts:420`, `:1066-1071`). Without that, flipping the default would start auto-merging on teams that never asked. This is a required part of D10, not a follow-up.
- Gate-3 (`ATMUX_HONKER` not `off|0|false`, `orchd-window.ts:121-129`) is unchanged — it is a substrate kill-switch, not a feature opt-in.

**D10.3 — still no crontab, ever.** [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) holds in full. orchd is parented to its `__orchd__` tmux pane via `PR_SET_PDEATHSIG(SIGTERM)`, so it starts only with `atmux start` and dies with the pane. **Nothing about this decision makes anything run at boot** — the 2026-05-24 boot-storm cause was 23 cron sandwich blocks plus 122 `unless-stopped` containers, and this ADR adds zero of either. Stated explicitly because "daemon on by default" reads like a boot-time regression and is not one.

### D11 — What stays true from ADR-260: the mode switch, the escape hatch, and the self-report

ADR-260 is superseded **only** on its default. Everything else it built is kept, and the capability is not deleted:

- **`orchestration.mode: "manual"` remains a fully supported operating point** — a first-class escape hatch, not a legacy value. Setting it still yields no `__orchd__` window, and it is the correct move whenever the daemon misbehaves on a given team. Its value is precisely what ADR-260 said: an operator or LLM lead who wants no automation can have exactly that, one line per team, no state migration in either direction.
- **`atmux member status <idle|working|blocked|rate-limited>`** (§D3), its `state/member-status/<member>.json` storage, its kanban coupling (§D4), and its `atmux status` rendering (§D5) are **unchanged and still valuable**. A self-reported intent signal is *more* useful next to a running daemon, not less: it is the authoritative statement the daemon's derived signals get cross-checked against, which is what ADR-260 §D5 designed it to be.
- **Manual verbs stay manual.** `atmux claim` / `done` / `task move` / `dispatch` / `epic-merge` / `team spawn-epic` / `atmux orchd --start|--drain|--sweep` keep working identically in either mode.
- **ADR-260's diagnosis was not wrong**, and this is not a claim that it was. Its concern was inference quality — pane-state false-`down`, past-tense-glyph skip, footer-freeze rate-limit misreads. That concern is what keeps the escape hatch, keeps every destructive consumer behind its own config gate, and makes D13's gap a blocker rather than a nice-to-have.

### D12 — What "coordination" means: the Rust/TypeScript split stays where it is

The operator asked for a Rust binary to *help do* the coordination. It already does, and this ADR does **not** move logic into Rust. Grounded in what exists (`rust/atmux-orchd/src/main.rs:1-45`):

**Rust `atmux-orchd` owns — the parts that must survive without Bun resident:**
1. Staying subscribed (Honker `update_events()`), the 60 s belt-and-braces drain (`:975`), and the initial catch-up drain.
2. Per-consumer offset bookkeeping in `subscriber_offsets` (`load_offset` / `save_offset`), advancing **only** on `rc=0`.
3. Wall-clock cadence: sweep-merges 300 s (`:944`), log-rotate 3600 s (`:948`), context-scan + budget-scan 900 s (`:956`), housekeep 86400 s (`:961`).
4. Child-process supervision: bounded waits with SIGTERM→grace→SIGKILL (`:73-74`), the 5-strike poison-event dead-letter, `PR_SET_PDEATHSIG`, the [ADR-249](249-orchd-singleton-guard.md) singleton lock, and log rotation.

**TypeScript keeps — all decision logic, unchanged:** every `--handle-one` handler (merge state machine, auto-push, auto-spawn, solo-worker dissolve, complaint routing, rotation) and every tick subverb (`--sweep-merges`, `--scan-context`, `--scan-budget`, `--housekeep`), invoked over the existing wire protocol `atmux orchd --handle-one --event-id <id> --topic <t> [--consumer-id <id>]`.

**Explicitly NOT in scope:** porting handlers to Rust, adding an HTTP surface (atmux has none — [ADR-261](261-issue-sync-external-tracker-ingestion.md) §Context), replacing tmux as the IPC (`docs/PRD.md` §1.2 principle 1), or adding a second supervisor tier ([ADR-240](240-drop-superorchd-orchd-self-supervises.md) dropped superorchd; do not resurrect it). The split is deliberate: Rust holds the ~5 MB idle residency, Bun runs only during handler execution.

### D13 — Close the lead-stall dispatch gap in the same release as the default flip

The three [ADR-247](247-lead-stall-watchdog.md) §D2 subscriptions registered at `src/core/orchd-bootstrap.ts:335-362` have no `CONSUMERS` entry in `rust/atmux-orchd/src/main.rs:176-256`, so they never dispatch. Today that is invisible — no orchd runs anywhere. After D10 it becomes a **false-green**: a team shows a lead-stall watchdog in its config and in the Bun registry, and gets none. Three `ConsumerCfg` entries are added (`story.ready`, `story.unclaimed`, `task.unclaimed`, each with its `bun_consumer_id`), noting that `task.unclaimed` will then have **two** consumers — the legacy `atmux:lane-router` (`bun_consumer_id: None`) and the watchdog — which is exactly the per-consumer-offset isolation `CONSUMERS[i]`/`offsets[i]` already provides for `task.done` (`auto-merge` + `dissolve-solo-worker`).

**A registry-parity check ships with it**, because this drift class will recur every time a consumer is added on one side only: a test asserting the Rust `CONSUMERS` names are exactly the Bun-registered `consumerId` set (modulo the two documented legacy entries). Reviewer-enforceable, and it fails loudly on the next one-sided addition.

### D14 — [ADR-267](267-durable-agent-continuity-contract.md) §D4(c) is unblocked; the cadence remains a separate decision

ADR-267 §D4(c) declined a checkpoint cadence — "No new daemon, no new cron entry, no new orchd ticker" — for three reasons, one of which is now false: *"[ADR-260] makes manual mode the fleet default, so a ticker would be dormant on every current team."* After D10, a ticker is not dormant. This is a **genuine unlock** and worth naming as such: a coordinating daemon is the natural home for a pre-death checkpoint cadence, and the ADR-267 authors said so implicitly by ruling it out on availability grounds rather than on merit.

It is **not** exercised here. ADR-267's other two reasons survive untouched — the [ADR-192](192-cron-arm-idempotency-contract.md) idempotency cost of a new *arm* (moot for an in-process ticker, which creates no on-disk scheduler artifact), and the substantive point that **`planGraceSec` IS the cadence** with `atmux hygiene-tick` as the walker (`src/verbs/hygiene-tick.ts`). Adding an orchd `hygiene-tick` ticker is therefore a **one-line amendment to ADR-267 §D4(c)**, on ADR-267's own judgement, once D10 has run stable. This ADR records the unlock and files it as **OQ-4**; it does not decide the cadence, and it does not add a fifth ticker.

The same unlock applies to [ADR-261](261-issue-sync-external-tracker-ingestion.md), whose dual-runtime hedge (manual verb + orchd ticker) exists because of the same dormancy — its manual verb stays useful, but the orchd ticker stops being the dead leg.

### D15 — Migration order; what must ship together, and in which sequence

**These are two independent limbs and must be two commits — but Limb 1 has a hard internal ordering, and Limb 2 has a hard prerequisite.**

**Step 0 — fleet pre-flight, BEFORE any code lands** (operator-run, on the main loop, not in a subagent):
1. `atmux migrate-state json-to-sqlite --target=kanban --team-dir /root/work/ifca/src/auditx-root/.atmux`, then verify the new `state.db` holds 50 task rows before proceeding. **This is the only step with real data at stake.** Two footguns, both verified, both of which make the obvious careful approach the wrong one:
   - **Do NOT `--dry-run` this first.** `--dry-run` calls `openDatabase` unconditionally (`src/verbs/migrate-state.ts:465`; only the `ensureDir` is skipped, `:461-463`), so it **creates the `state.db`** it claims not to write. The in-code comment at `:459-460` — "The created state.db on a dry-run is harmless: it's an empty schema file" — **is false, and this is the one team on the host where it matters**: an empty `state.db` is exactly what flips `_useSqlite` to true and makes 50 tasks invisible, per `src/core/superdoctor-activity.ts:96-104`. The real run is safe by comparison: it is an idempotent upsert and it archives the JSON by rename rather than deleting it (`:397-406`). D5 fixes the dry-run leak and that comment.
   - **Despite its name, `--team-dir` takes the `.atmux` directory itself, not the repo root** — `atmuxDir = resolve(parsed.teamDir)` (`:449`). Pass the repo root and it creates `<repo>/state.db` and reports a successful migration into the wrong place.
2. Decide `ifca-docs`: either migrate (upsert merges its 20 JSON rows into the DB's 24) or leave the orphan and accept the doctor row. Operator's call — **OQ-3**.
3. Delete the ten empty seeds plus `~/work/journals/.sb/_dotfiles/atmux/kanban.json`.

**Commit A — Limb 1** (one commit; D2 + D3 + D4 + D5 + D6 + D7 + D8 + D9 together). Splitting it is what breaks teams: D2 without D3 loses `auditx-root`'s kanban; D2 without D6 ships four features that return empty; D7 without D2 leaves a seeder feeding a reader that no longer exists. Per [ADR-169](169-state-json-sqlite-migration-3-phase.md) §OQ-4's ruling on exactly this question — "no interim state where some callers read JSON + some read SQLite".

**Commit B — Limb 2** (one commit; D10 + D12's doc statement + D13 together). **D13 gates D10**: flipping the default while the lead-stall consumers are unwired ships a false-green. D10.2's `sweepMerges` gate is inside this commit for the same reason.

**Order: A then B.** B starts a daemon whose consumers write to the kanban; doing that while a JSON fallback still exists means a daemon and a verb could pick different stores on the same team. A first removes that possibility entirely.

**Fleet config after B**: [ADR-260](260-manual-orchestration-mode-default.md) §D6 wrote an explicit `"mode": "manual"` into all 20 `team.json` files, so **the default flip changes nothing until each file is edited** — explicit beats implicit in both directions. That is a feature: it makes the rollout per-team and reversible. Recommended sequence: flip **atmux's own team first** (it already has `autoMerge.enabled: true`), watch one full 24 h housekeep cycle, then widen. `atmux start` per team to spawn the window; `pgrep -c atmux-orchd` and the `__orchd__` pane banner (`main.rs:860-882`: boot line, consumer count + names, cadence line) are the green signal — verify from the pane, not from the config.

---

## Consequences

**Limb 1**

- **Four live bugs are fixed as a side effect**, on every one of the 20 teams: `atmux report`'s task sections, the Discord digest's done-tasks + advanced-stories, the digest's in-flight/blocked counts, and doctor's `inbox-mark-orphan` probe all currently return empty on SQL-canonical teams. The compat path was not a dormant fallback; it was an active source of silent wrongness.
- **`atmux handoff` starts actually reassigning tasks.** `migrateTasks` has been writing to a file nothing reads. Anyone who ran a lead or member handoff on a SQL team and saw no ownership change was seeing this.
- **`atmux init` stops littering.** Ten of twelve `kanban.json` files on this host — plus the dotfile-root stray — exist solely because of `init.ts:356-361`.
- **One store, one lock story.** [ADR-013](013-kanban-write-atomicity.md) / [ADR-098](098-json-and-locking.md) flock-around-`updateJson` for kanban becomes dead weight; SQLite `transactImmediate` is the only write-atomicity mechanism left for tasks. `kanban.json.lock` sidecars on disk (this repo has one, mtime 2026-05-14) become inert litter, sweepable by D4's cleanup.
- **Breaking for JSON-only teams — by design, and loudly.** One team on this host (`auditx-root`, 50 tasks) is affected, and Step 0 migrates it before any code lands. Post-D3, such a team gets an actionable error naming the fix, never a silent empty kanban.
- **A `_useSqlite` fork that no longer exists cannot drift.** The four broken readers in D6 exist because a per-call fork made "which store?" a question each caller answered independently, and four answered wrong.
- **Test churn**: 31 TS files re-pointed; 4 net-new bug-pin assertions. 51 `.bats` files untouched (ADR-266 §Out-of-scope).

**Limb 2**

- **Something coordinates again.** Merge sweeps, event housekeeping, context-saturation scans, and budget scans have not run anywhere on this host since 2026-06-12. Events-table growth on every opted-in team goes from unbounded (ADR-260 §Consequences accepted this: "orchd's 24h housekeep doesn't run either") to bounded by the 24 h tick.
- **Resource cost, honestly**: ~5 MB idle RSS per opted-in team (Rust-only; Bun spawns per event/tick and exits), one extra tmux window, and one `orchd.log` per team capped by rotation at `ATMUX_ORCHD_LOG_MAX_BYTES` (50 MB) × `ATMUX_ORCHD_LOG_KEEP_N` (3) ≈ 150 MB worst case. At 20 teams that is ~100 MB RSS + ≤3 GB of log ceiling. hax has 128 GB and is CPU-gated, not RAM-gated, so RSS is not the constraint — **the wake-storm profile is**: every consumer re-drains on *any* DB commit, so a busy team spawns Bun handlers at commit rate, bounded only by [ADR-256](256-orchd-rust-hardening.md)'s 600 s handler deadline. Which is why the rollout is per-team and starts with one.
- **Every orchd consumer stops being opt-in**: auto-merge ([ADR-226](226-orchd-auto-merge-subscriber.md)) — still behind its own `autoMerge.enabled` per D10.2 — auto-push ([ADR-229](229-orchd-auto-push-and-safety-gates.md)), auto-spawn ([ADR-231](231-orchd-auto-spawn-and-solo-worker-dissolve.md)), solo-worker dissolve, lead-stall watchdog ([ADR-247](247-lead-stall-watchdog.md), newly reachable per D13), complaint routing ([ADR-214](214-retire-ombudsman-lead-absorbs-complaint-adjudication-via-honker.md)), rotation ([ADR-212](212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md)), context/budget scanners. Each keeps whatever config gate it already had — this ADR removes the **spawn** gate, not the per-consumer gates.
- **Inference-quality risk is real and re-accepted with eyes open.** ADR-260's false-green/false-stall classes (pane-state false-`down`, past-tense-glyph skip, footer-freeze rate-limit misreads) are not fixed by this ADR. The mitigations are: D11's escape hatch, per-consumer config gates, ADR-256's tripwires, and a per-team rollout. If a class recurs on a team, that team goes back to `"manual"` in one line — no state migration, per ADR-260's own reversal note.
- **The flip-flop is bounded by an honest record.** Four dated positions now exist (2026-05-06 no daemon → 2026-05-24 orchd is the runtime → 2026-06-12 manual default → 2026-08-07 orchd default). D9 item 3 appends step (iv) rather than rewriting the history, so the PRD keeps telling the truth about how many times this moved. A fifth move should have to argue against this record.
- **Downstream designs lose their dormancy tax**: [ADR-261](261-issue-sync-external-tracker-ingestion.md)'s dual-runtime hedge and [ADR-267](267-durable-agent-continuity-contract.md) §D4(c)'s cadence deferral were both priced on "no process is running". D14 records the unlock without spending it.
- **[ADR-266](266-shim-sunset-policy-and-first-sweep.md) §D1 is exercised as designed** — the first shim created *after* the policy carries a `SUNSET(v0.9.0):` marker from birth, on the same train as ADR-264's shims. Concept surface shrinks: no more "is it JSON or SQLite?".

---

## Open questions

Each needs operator adjudication. None is decided silently above.

1. **OQ-1 — does "just use sqlite" extend to the 14 `.atmux/state/*.json` files?** [ADR-169](169-state-json-sqlite-migration-3-phase.md) ratified that migration on 2026-05-21 (`flags` / `role_state` / `budget` tables, `--target=flags|role-state|budget`) and it was **never implemented**: verified 2026-08-07, the ladder head is `to: 17` with none of the three tables, `migrate-state` still throws `ConfigError` for `--target=state` (`:485-489`), the promised `migration-state-incomplete` doctor probe does not exist in `src/`, and **31 `*.json` files** sit under `.atmux/state/`. D1 scopes this ADR to `kanban.json`; the operator's sentence could reasonably mean the whole `.atmux/` JSON surface. **Recommendation: keep it out.** ADR-169 already owns it with ratified schemas — reviving that EPIC is cheaper and less risky than folding 31 files into a kanban retirement, and mixing them would make Commit A large enough that a rollback becomes all-or-nothing.
2. **OQ-2 — `summarizeKanban`: re-point at the repo, or delete and fold its rollup into `groomArchive`?** It is already a no-op on SQL teams (`src/core/groom.ts:701-702`), and `groomArchive` is what actually deletes rows (`src/verbs/groom.ts:677-681`). **Recommendation: delete + fold** — one summariser. Not decided here because it changes `docs/RUNBOOK-grooming.md`, the documented eight-sub-op numbering, and `groom --kanban-days`' meaning.
3. **OQ-3 — `ifca-docs`' orphan JSON: migrate (upsert) or leave?** Its 20 JSON rows vs 24 DB rows. Upsert would resurrect any row deleted from the DB deliberately (e.g. by `groomArchive`). **Recommendation: leave it, take the doctor row** — resurrecting groomed tasks is worse than a yellow row. Needs the operator, since only they know whether that team's JSON holds anything unique.
4. **OQ-4 — after D10 runs stable, does [ADR-267](267-durable-agent-continuity-contract.md) §D4(c) get its ticker?** D14 unblocks it; ADR-267's `planGraceSec`-is-the-cadence argument still stands on its own. This is an amendment to ADR-267, on ADR-267's authority, not a decision this ADR may make for it.
5. **OQ-5 — rollout breadth and pace.** D15 recommends atmux-first, one 24 h housekeep cycle, then widen. Which teams, in what order, and who watches the first `orchd.log`? Sopx and property-root carry the most lanes and the most merge traffic, so they are the highest-value and highest-risk candidates for wave two.
6. **OQ-6 — does the `ATMUX_HONKER` kill-switch need a fleet-wide counterpart?** Today the only global off-switch for the daemon is per-team config or `ATMUX_HONKER=off` in each cage's environment. With orchd on by default, a single "stop all coordination on this host" lever may be worth having. Deliberately not invented here — a new global env knob is surface, and [ADR-266](266-shim-sunset-policy-and-first-sweep.md)'s budget says argue for it first.
7. **OQ-7 — `templates/briefs/committer.md` scope.** D9 item 1 fixes its one stale clause. But if orchd is the merger by default ([ADR-259](259-committer-member-optional-orchd-gates-on-automerge.md) already made the committer member optional), does the committer brief's single-trunk mode need a broader rewrite? Out of scope here; flagged so the reviewer does not read D9 item 1 as a full audit of that brief.
8. **OQ-8 — two heavily-cited ADR numbers have no files, and D2 deletes code that cites one of them.** Verified 2026-08-07: `docs/adr/060-*.md` and `docs/adr/076-*.md` **do not exist**, yet ADR-060 is the storage-routing contract named in `src/core/kanban.ts:71` (the block D2 deletes) and in [ADR-169](169-state-json-sqlite-migration-3-phase.md), and ADR-076 is cited as the shipped inbox migration by `src/verbs/doctor/state.ts:123`, `templates/briefs/committer.md:283`, ADR-169, and [ADR-126](126-sqlite-state-store.md). A third stale cite: ADR-169's cross-ref list links `005-atomic-json-and-flock.md`, but the real ADR-005 is `005-doctor-preflight.md`. **Recommendation: backfill both as ADRs rather than renumber**, because the numbers are load-bearing in ~10 ADR bodies and in code comments, and both decisions demonstrably shipped. Not this ADR's job — filed here so the D2 implementer does not silently drop the ADR-060 pointer with nowhere to redirect it, and does not "fix" the dangling cites by minting new numbers. Both are `docs/adr/` backfill Tasks.

---

## Decision-anchors

Every row verified against disk on **2026-08-07** unless dated otherwise.

| Claim | Source |
|---|---|
| Kanban DB path is `.atmux/state.db` (**not** `.atmux/state/state.db`) | `src/core/kanban.ts:88-90` |
| The entire dual-path routing decision is one `exists()` syscall | `src/core/kanban.ts:92-94` |
| Dual-path intent, stated in-code ("Pre-migration … the existing JSON-based implementation stays the source of truth") | `src/core/kanban.ts:71-85` |
| **18** dual-path call sites, all in one module | `src/core/kanban.ts:155`, `211`, `323`, `355`, `406`, `685`, `716`, `738`, `759`, `782`, `804`, `825`, `845`, `872`, `913`, `928`, `977`, `1162` |
| **6** JSON write sinks + the empty-kanban `initial` shim | `src/core/kanban.ts:177`, `271`, `936`, `1021`, `1183`, `1371`; `:1350-1371` |
| `epic.ts` / `story.ts` are already SQL-only (no `kanbanJsonPath` import) | `src/core/epic.ts:59-89`; `src/core/story.ts` (zero matches) |
| `kanbanJsonPath` = `join(atmuxDir, "kanban.json")` | `src/core/common.ts:107-109` |
| JSON-only readers — **zero** `state.db`/`openDatabase` references in these files, so they return empty on every SQL team | `src/core/discorder.ts:139-152`, `:286-299`; `src/verbs/report.ts:266`; `src/verbs/doctor/driver.ts:196-198` |
| JSON-only writer: `migrateTasks` reassigns owners in JSON with no SQL branch | `src/verbs/handoff.ts:243` |
| `atmux init` unconditionally seeds `{"tasks":[],"epics":[],"stories":[]}` — the litter source | `src/verbs/init.ts:356-361` |
| `summarizeKanban` early-returns when `kanban.json` is absent → already a no-op on SQL teams | `src/core/groom.ts:692`, `:701-702`; backup + rewrite at `:761-772` |
| Correct dual-path gates (the pattern D6 keeps, minus the JSON half) | `src/verbs/doctor/state.ts:98-109`; `src/verbs/status.ts:685-697`; `src/verbs/pulse.ts:188-197` |
| `stop.ts` archive copy of `kanban.json` — kept | `src/verbs/stop.ts:533-538` |
| `migrate-state` throws `ConfigError` on absent `kanban.json`, so `--target=all` fails on a migrated team | `src/verbs/migrate-state.ts:188-195`, `:470-471` |
| `migrate-state` archives via rename into `.atmux/archive/json-pre-sqlite-<epoch>/`; idempotent upsert | `src/verbs/migrate-state.ts:29-36`, `:397-406` |
| **`--dry-run` CREATES `state.db`** — `openDatabase` is unconditional; only `ensureDir` is dry-run-gated. The in-code "harmless: it's an empty schema file" claim is **false** on a JSON-only team (D5 item 2) | `src/verbs/migrate-state.ts:461-465`; false comment at `:459-460`; kanban dry-run needs no DB — `:199-205` |
| `--team-dir` takes the **`.atmux` dir**, not the repo root | `src/verbs/migrate-state.ts:449` |
| **The D3 hazard**: `openDatabase` opens `{ create: true }` — first call manufactures an empty DB | `src/abstractions/sqlite.ts:33` |
| The same hazard documented in-code, with the exact silent-empty-kanban failure mode | `src/core/superdoctor-activity.ts:96-104` |
| Migration ladder head `to: 17`; **no** `flags` / `role_state` / `budget` table → ADR-169 unimplemented | `src/abstractions/sqlite-migrations.ts:813`; `CREATE TABLE` grep |
| `31` `*.json` files still under `.atmux/state/` (OQ-1 evidence) | `ls .atmux/state/*.json \| wc -l` |
| Fleet: **12** `.atmux/kanban.json` on hax; 10 empty seeds; `auditx-root` 94,566 B / 50 tasks / **no state.db**; `ifca-docs` 44,063 B / 20 tasks **with** state.db (24 tasks) | bounded scan of `/root/work/{src,ifca/src,unum/src}/*`, `/root/work/journals/.sb` |
| Stray empty seed in the dotfile-tree **root** (walk-up misresolution), 50 B, mtime 2026-05-24 | `/root/work/journals/.sb/_dotfiles/atmux/kanban.json` |
| This repo's own `.atmux/` has `state.db` (6,033,408 B) and **no** `kanban.json` — only an inert `kanban.json.lock` | `ls -la .atmux/` |
| The one deliberately-retained brief clause D9 item 1 obsoletes | `templates/briefs/committer.md:282` |
| Only **one** `kanban.json` mention left in `templates/briefs/` (the 2026-08-06 sweep did the rest) | `rg -n 'kanban\.json' templates/` |
| PRD's standing "dual-path … source of truth when present" note | `docs/PRD.md:11-15` |
| PRD §1.2 principle 3 already narrates the three-step daemon history D9 item 3 appends to | `docs/PRD.md` §1.2 principle 3 (corrected 2026-08-06) |
| Test surface: **31** TS files + **51** `.bats` files reference `kanban.json` | `rg -ln 'kanban\.json' tests/ -g '*.ts' \| wc -l` = 31; `-g '*.bats'` = 51 |
| `.bats` harnesses already out of scope | [ADR-266](266-shim-sunset-policy-and-first-sweep.md) §Out-of-scope |
| **10** Rust `CONSUMERS` (2 legacy topic-routed + 8 registry-routed) | `rust/atmux-orchd/src/main.rs:176-256` |
| **11** Bun consumer ids registered → the 3 ADR-247 lead-stall subs have no Rust entry (`rg 'lead-stall' rust/` → no match) | `src/core/orchd-bootstrap.ts:77-112`, `:335-362` |
| Tickers: sweep 300 s, log-rotate 3600 s, ctx+budget 900 s, housekeep 86400 s; 60 s belt-and-braces drain | `rust/atmux-orchd/src/main.rs:944`, `948`, `956`, `961`, `975` |
| Bounded child waits: 600 s handler / 900 s tick, SIGTERM→5 s grace→SIGKILL; 5-strike poison dead-letter | `rust/atmux-orchd/src/main.rs:73-79`, `:93` |
| Rust is a supervisor + dispatcher; **all** logic stays in Bun via `--handle-one --event-id --topic [--consumer-id]` | `rust/atmux-orchd/src/main.rs:1-45`; parsed flags `src/verbs/orchd.ts:169-320` |
| The Rust binary is launched into the `__orchd__` tmux pane, with a Bun fallback if not on PATH | `src/core/orchd-window.ts:248-258` |
| Startup banner an operator verifies from (boot line, consumer count + names, cadence line) | `rust/atmux-orchd/src/main.rs:860-882` |
| Three Rust crates, all installed by `build:install` | `rust/`; `package.json:24-27` |
| `DEFAULT_ORCHESTRATION_MODE = "manual"` — the constant D10.1 flips | `src/schema/team.ts:791`; resolver `:797-801` |
| Gate-1 (mode) — shape unchanged by D10.1, only its default answer | `src/core/orchd-window.ts:99-104` |
| Gate-2 (`autoMerge.enabled`) at spawn time — what D10.2 moves | `src/core/orchd-window.ts:106-108` |
| `autoMerge.enabled` schema default is **`false`** — why D10.1 alone would be cosmetic | `src/schema/team.ts:670` |
| Consumer-level `autoMerge` gate precedent that makes D10.2 safe | `src/verbs/committer.ts:289` |
| **`sweepMerges` does NOT self-gate on `autoMerge`** — the check D10.2 must add | `src/core/orchd-merge-sweep.ts:84+` (no `autoMerge` reference); tick entry `src/verbs/orchd.ts:420`, `:1066-1071` |
| Gate-3 (`ATMUX_HONKER` off) — unchanged | `src/core/orchd-window.ts:121-129` |
| **20 of 20** fleet `team.json` are `mode: "manual"`; `pgrep -c atmux-orchd` = **0** | `~/work/journals/.sb/_dotfiles/atmux/*/team.json`; `pgrep -c atmux-orchd` |
| atmux's own team: `autoMerge.enabled: true` **and** `mode: "manual"` → auto-merge configured and dead | `.atmux/team.json` |
| ADR-260 §D6 wrote explicit `"mode": "manual"` everywhere → the default flip is inert until each file is edited | [ADR-260](260-manual-orchestration-mode-default.md) §D6; the 20 files above |
| ADR-267 §D4(c) deferred its cadence partly on "a ticker would be dormant on every current team" — D14's unlock | [ADR-267](267-durable-agent-continuity-contract.md) §D4(c) |
| ADR-261 §Context gap 3 paid for a dual runtime home for the same dormancy reason | [ADR-261](261-issue-sync-external-tracker-ingestion.md) §Context |
| Shim-sunset policy D8 follows (explicit expiry + greppable `SUNSET(...)` marker + hard actionable error naming the ADR) | [ADR-266](266-shim-sunset-policy-and-first-sweep.md) §D1 |
| v0.9.0 is the existing sunset train (ADR-264 shims) D8 joins | [ADR-266](266-shim-sunset-policy-and-first-sweep.md) §D4 |
| Current version `0.8.30` → D8's first step is v0.8.31 | `package.json:3` |
| "No interim mixed-state where some callers read JSON + others SQLite" — the ruling D15 Commit A applies | [ADR-169](169-state-json-sqlite-migration-3-phase.md) §OQ-4 |
| ADR-126 is `accepted` (2026-05-23) — why D1 re-decides nothing | `docs/adr/126-sqlite-state-store.md:3` |
| ADR-233 and ADR-237 are still `Status: proposed` — cited as the standing operator position, not ratified law | `docs/adr/233-…:3`; ADR-267 already flags this |
| ADR-249 / ADR-256 / ADR-240 are all `accepted` and landed **after** ADR-260 — the hardening that changes its premise | `docs/adr/249-…:3`, `256-…:3`, `240-…:3` |
| **ADR-060 and ADR-076 have no files** in `docs/adr/` despite being cited by ~10 ADRs + code (OQ-8) | `ls docs/adr/060* docs/adr/076*` → no matches |
| ADR-169's `005-atomic-json-and-flock.md` link is dangling — real ADR-005 is `005-doctor-preflight.md`; ADR-013 + ADR-098 are the flock anchors | `docs/adr/005-doctor-preflight.md`; [ADR-169](169-state-json-sqlite-migration-3-phase.md) §Cross-references |
| `atmux-cockpit-mirror`'s header cites "ADR-219", but `219-*.md` is `dissolve-epic-completeness`; the crate's ADR is **230** | `rust/atmux-cockpit-mirror/src/main.rs:1-3`; `docs/adr/230-cockpit-mirror-rust-crate-fleet-event-consumer.md` |
| ADR-076 cite sites that survive D2 (inbox surface, not kanban) | `src/verbs/doctor/state.ts:123`; `templates/briefs/committer.md:283` |

## Cross-references

- **Supersedes**: [ADR-260](260-manual-orchestration-mode-default.md) §D1 (default `"manual"`) and §D2's spawn consequence — **only those**. Its mode switch, `atmux member status` surface (§D3–§D5), fleet-config-is-explicit principle (§D6), and manual escape hatch are kept by D11. ADR-260's file is **not edited** (append-only convention); this is its supersession record.
- **Completes**: [ADR-126](126-sqlite-state-store.md) — its "JSON archive-only" principle, finished on the kanban surface. **ADR-060** (unfiled — OQ-8) / [ADR-098](098-json-and-locking.md) — the dual-path routing and JSON+flock model retired for tasks.
- **Restores**: [ADR-233](233-cron-auto-install-disabled-trust-orchd.md)'s "orchd is the runtime, not cron" direction, without reintroducing a single crontab line (D10.3).
- **Unblocks**: [ADR-267](267-durable-agent-continuity-contract.md) §D4(c) (cadence — OQ-4). Simplifies [ADR-261](261-issue-sync-external-tracker-ingestion.md)'s dual-runtime hedge.
- **Depends on**: [ADR-249](249-orchd-singleton-guard.md), [ADR-256](256-orchd-rust-hardening.md), [ADR-240](240-drop-superorchd-orchd-self-supervises.md) — the hardening that makes a default-on daemon safe, survivable, and single-tiered.
- **Fixes shipped-but-unwired**: [ADR-247](247-lead-stall-watchdog.md) §D2's three subscriptions (D13).
- **Out of scope, owned elsewhere**: [ADR-169](169-state-json-sqlite-migration-3-phase.md) (the 14 `.atmux/state/*.json` files — OQ-1); [ADR-203](203-event-topic-taxonomy.md)'s closed topic set (untouched); [ADR-164](164-sync-claude-team-json.md)'s KEEP-AS-JSON config files.
