# atmux architecture

> **Storage in atmux-bun.** Per [ADR-126](adr/126-sqlite-state-store.md), kanban
> (tasks/epics/stories), inboxes, and per-feature state moved to **`.atmux/state.db`**
> (SQLite, WAL). The text below referencing `.atmux/kanban.json` describes the legacy
> JSON model — still accurate for bash atmux and for teams not yet migrated, but on the
> bun port the DB is the source of truth. Markdown files (`team.json` excepted as JSON,
> `decisions.md`, `flags.md`, `driver-inbox.md`, `lead-outbox.md`, `HANDOFF.md`) and
> append-only JSONL logs stay as files.

> **2026-05-24 architecture alignment** — atmux ships an event-driven core now: the
> Rust **`atmux-orchd`** daemon (`rust/atmux-orchd/`) runs one process per team with
> 10 in-process consumers + 4 tickers (5min sweep-merges · 15min context-scan +
> budget-scan · hourly log-rotate · 24h housekeep) per [ADR-233](adr/233-cron-auto-install-disabled-trust-orchd.md).
> The **Honker** in-DB messaging substrate ([ADR-202](adr/202-honker-in-db-messaging-substrate.md),
> [ADR-203](adr/203-event-topic-taxonomy.md)) replaces cron polling — `emit(db, payload)`
> in `src/abstractions/events.ts` auto-detects honker-loaded state and the Rust orchd
> spawns Bun `--handle-one --consumer-id <id> --topic <t>` per event. Several cockpit
> roles have been retired in favor of lead-gated honker consumers — **Sentinel
> retired** ([ADR-211](adr/211-retire-sentinel-role-distribute-to-honker-consumers.md)),
> **Medic narrowed to on-demand** ([ADR-212](adr/212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md)),
> **Jury retired** ([ADR-213](adr/213-retire-jury-reviewer-absorbs-acceptance-criteria.md)),
> **Ombudsman retired** ([ADR-214](adr/214-retire-ombudsman-lead-absorbs-complaint-adjudication-via-honker.md)).
> Some role/cron references in the sections below describe the pre-retirement shape;
> they remain accurate for teams that haven't cut over yet (retired roles stay
> running as the safety net until the cleanup-EPIC cutover ≥30 days after
> e-honker-observation-watchdogs ships stable).

> **2026-08-27 — orchd is RETIRED entirely** ([ADR-276](adr/276-orchd-retirement-and-atmux-scope.md),
> operator-direct; executed the same day). atmux's scope narrows to **tmux cages +
> `atmux vox`**. The Rust `rust/atmux-orchd/` crate, the `atmux orchd` verb, the
> `__orchd__` window, the tickers (sweep / ctx-scan / budget-scan / housekeep) and the
> epic-machinery consumers (auto-merge, auto-dissolve — with auto-spawn already gone
> per [ADR-280](adr/280-epic-team-retirement-and-staged-excision.md)) no longer exist.
> The Honker substrate, `atmux-listener`, `atmux-cockpit-mirror` and the events tables
> SURVIVE; the one-shot drain is re-homed as operator-invoked `atmux committer --drain`
> (which also hosts the surviving consumers: gitter, lane-router, complaint consumer,
> lead-stall watchdog; the ADR-229 auto-push engine was deleted with its only trigger emitter). Every "orchd is the runtime" /
> daemon-ticker sentence in the notes above and the sections below is HISTORY.

> **2026-06-12 — manual orchestration is the default** ([ADR-260](adr/260-manual-orchestration-mode-default.md)):
> the orchd daemon described above spawns ONLY when `team.json::orchestration.mode`
> is explicitly `"orchd"`. The default (absent block) is `"manual"` — no daemon, no
> auto-merge/auto-spawn/watchdog; the member/lead LLMs manage the fleet themselves
> (self-reported status via `atmux member status` → `<atmuxDir>/state/member-status/`,
> manual kanban via `claim`/`done`/`task move`, manual fan-in + spawns). Rationale:
> LLMs can manage their own fleet better than atmux's deterministic automation can
> at the moment. Honker events are still emitted (audit trail + clean re-opt-in);
> nothing consumes them in manual mode.

## Principles

1. **tmux is the IPC.** atmux doesn't speak any AI provider API. It writes shell commands into tmux panes via `tmux send-keys` and reads responses by capturing pane output. That means it works with *any* interactive coding-agent TUI — Claude Code, Cursor, OpenCode, Kimi, or any future one. *(Clarified 2026-08-06 — that is a claim about the **seam**, not about staffing.)* Every member role runs Claude Opus (`claude-opus-4-7` at `CLAUDE_CODE_EFFORT_LEVEL=xhigh`) per `CLAUDE.md` §"Spawning + model selection" — never Sonnet for member roles — and [ADR-201](adr/201-cursor-cli-composer-25-as-first-class-member-tui.md) (cursor-cli composer-2.5 as a first-class member TUI) was **Rejected** by driver verdict 2026-05-21. Cheaper models are permitted only for **read-only** sub-agents. The TUI list above is what atmux **can launch**, not what the operator's teams **run** — see `docs/PRD.md` §1.3. *(One carve-out, 2026-08-14 — read it together with this principle so the apparent contradiction is not re-litigated: [ADR-272](adr/272-voice-operator-interface.md) §D1 adds `atmux vox`, which does speak a provider's realtime API. The principle is a claim about the **orchestration** seam — how atmux drives agents — and voice sits on the other side of it as an **operator** seam: the provider orchestrates nothing, spawns no member, appears in no brief, and is invisible to every team. It is a transducer between the operator's voice and the CLI, in the same category as his terminal emulator. The carve-out is bounded by an enforced import fence — `src/abstractions/voice/**` is importable only from `src/core/vox/**` and `src/verbs/vox.ts`, and no orchestration module may import it, directly or transitively. A provider call on the orchestration path remains [ADR-258](adr/258-vendor-agnostic-orchestration-agentbackend.md)'s business and needs its own ADR; this is not a precedent for one.)*
2. **State lives on disk, outside every agent process.** *(Corrected 2026-08-06 — the durability claim still holds; the storage details in the previous wording were stale.)* **Still true:** no coordination item — task, epic, story, claim, dependency, inbox message, decision — exists only inside an agent process, a tmux pane's scrollback, or a chat transcript. `.atmux/` survives tmux restarts and state replays on `atmux start`. **Two corrections:** (a) the canonical store is **SQLite at `.atmux/state.db`** (WAL) per [ADR-126](adr/126-sqlite-state-store.md) — resolved by `src/core/kanban.ts:89` (`join(atmuxDir, "state.db")`), **not** `.atmux/state/state.db` — so `.atmux/` is queried with `sqlite3` rather than being greppable end-to-end, and JSON is archive-only. Markdown stays plain text and diffable (`HANDOFF.md`, `decisions.md`, `flags.md`, driver-inbox/lead-outbox), as do the append-only JSONL logs. (b) the durable artifacts are **operator-private and live outside the product repo**: `.atmux/team.json`, `.atmux/decisions.md`, and `.atmux/state.db` belong in the operator's dotfile tree at `~/work/journals/.sb/_dotfiles/atmux/<repo-key>/` and are symlinked into `.atmux/`, with the managed repo gitignoring all of `.atmux/` and no `!.atmux/team.json` carve-out ([ADR-239](adr/239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) §Supplement-2026-05-26, [ADR-244](adr/244-per-repo-pre-commit-kanban-decisions-snapshot.md) §Supersession-2026-05-26). Node `fs` follows symlinks transparently, so no code changed. Enforcement of that layout in code is **proposed, not shipped** — [ADR-268](adr/268-managed-repo-state-isolation-enforcement.md).
3. **Every verb is idempotent, and no long-lived process is required.** *(Corrected 2026-08-06 — the position on daemons moved twice; both moves are recorded here rather than erased, because this file previously carried only the 2026-05-06 wording while the header notes above carried two later ones.)* **Current position (read this one):** manual orchestration is the **fleet default** per [ADR-260](adr/260-manual-orchestration-mode-default.md) (accepted 2026-06-12) — `team.json::orchestration.mode` defaults to `"manual"`, an absent block resolves to `"manual"` (§D1), and in manual mode **no `atmux-orchd` window is spawned at all** (§D2 Gate-1). The lead / driver LLM drives the kanban by hand with the existing verbs (`claim` / `done` / `task move` / `dispatch` / `epic-merge` / `team spawn-epic`), and members self-report liveness and intent via `atmux member status <idle|working|blocked|rate-limited>` (§D3–§D5). The Rust **`atmux-orchd`** daemon is **opt-in** — it spawns only for a team that explicitly sets `"orchestration": { "mode": "orchd" }`, and every orchd consumer (auto-merge, auto-push, auto-spawn, solo-worker dissolve, lead-stall watchdog, context/budget scanners) becomes opt-in with it; `atmux orchd --start / --drain / --sweep` stays manually invocable in any mode. Operator rationale, verbatim in ADR-260: *"LLMs can manage their own fleet better than atmux can at the moment."* **Position history, kept deliberately:** (i) **2026-05-06 original** — "No daemon"; `whip` (15min) and `report` (30min) ran on cron. (ii) **2026-05-24** — cron auto-install was retired and orchd became "the runtime" ([ADR-233](adr/233-cron-auto-install-disabled-trust-orchd.md) §D1 — `atmux start` writes zero crontab lines), and the hourly LLM whip cadence into Discord was removed ([ADR-237](adr/237-no-llm-discord-and-whip-removal.md)). (iii) **2026-06-12** — ADR-260 reversed the default: manual is the default, orchd is opt-in. Rollback is one line per team in either direction; no state migration either way. (iv) **2026-08-27** — [ADR-276](adr/276-orchd-retirement-and-atmux-scope.md) retired orchd ENTIRELY: the crate, verb, window, tickers and consumers are gone; the one-shot drain survives as `atmux committer --drain`, and where a retired capability is still wanted it returns as an operator-invoked verb, never a daemon. The `whip` **verb** itself no longer exists: renamed to `poke` by [ADR-160](adr/160-whip-to-poke-rename.md), and the `whip` alias removed from `src/cli.ts` by [ADR-266](adr/266-shim-sunset-policy-and-first-sweep.md) §D2 (verified 2026-08-06: `rg -i whip src/cli.ts` returns no match). `atmux report` and `atmux hygiene-tick` remain on-demand verbs.
4. **Driver is external.** atmux is launched from the driver's shell. The driver does NOT run inside the tmux session — it's a separate process that fires atmux commands.
5. **atmux owns its tmux infrastructure** ([ADR-162](adr/162-atmux-owns-tmux-infrastructure.md)). The cockpit binds to a dedicated `atmux-cockpit` named socket — not the operator's default socket. Every cockpit + per-team session loads a canonical `templates/tmux/atmux.conf` via `-f`, ignoring `~/.tmux.conf` — but see the ⚠ under §Tmux topology: a tmux **server** started implicitly (by `attach`, or by a read-only probe against a dead socket) loads no conf at all, so a conf directive is not a fleet-wide guarantee on its own ([ADR-281](adr/281-tmux-child-environment-scrub-at-the-spawn-seam.md)). Doctor probes warn on tmux version drift + legacy-cockpit-on-default-socket residue. See §Tmux topology below.

## Tmux topology

Per [ADR-162](adr/162-atmux-owns-tmux-infrastructure.md):

| Tier     | Socket flag                                              | Session name      | What runs there                                                                            |
|----------|----------------------------------------------------------|-------------------|--------------------------------------------------------------------------------------------|
| Cockpit  | `tmux -L atmux-cockpit` (named socket, dedicated)        | configured `cockpitSession` (default `atx`) | Operator's window into every enabled team — `_superdriver`, optional `_medic`, enabled `_superbot`, declarative operator windows, then per-team viewers ([ADR-279](adr/279-declarative-operator-cockpit-windows.md), [ADR-285](adr/285-cooperative-bot-seat-and-superbot-offer-protocol.md)). `_superbot` defaults disabled + shadow. The same cockpit config can opt into `driverOnly: true` for the dedicated vendored split, which narrows the session to exactly three operator windows (`driver`, `driver-2`, `driver-3`) and no team viewers. |
| Per-team | `tmux -S <team-root>/.atmux/tmux/tmux-0/default` (cage)  | bare team name    | Drivers first, configured `_bot`, then the team's members/services. `_bot` is a distinct cooperative seat, not a driver or member ([ADR-239](adr/239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md), [ADR-285](adr/285-cooperative-bot-seat-and-superbot-offer-protocol.md)). Cage-tier per [ADR-058](adr/058-cage-tier-isolation.md). |
| Voice    | `tmux -L default` (the operator's **default** socket)     | `atmux-vox`     | The `atmux vox` WebSocket server under a crash-loop wrapper, when started with `--supervise` ([ADR-272](adr/272-voice-operator-interface.md) §D10). Fleet-wide operator infrastructure belonging to no team — a sibling of the driver's own shell ([ADR-044](adr/044-driver-session-on-default-socket.md)), deliberately **not** a cockpit window (the reconcile pass would prune it as an orphan) and **not** a cage window (`atmux stop` on an unrelated team would end the call). |

**Config (both tiers):** every session is created with `-f <atmux.conf-path>` resolved by `getAtmuxTmuxConfPath()` in `src/core/tmux-paths.ts`. Default: `templates/tmux/atmux.conf` (installed under `/opt/atmux/<version>/templates/`). Operator override: `ATMUX_TMUX_CONF=<path>`. The 8-option baseline includes `automatic-rename off` — load-bearing for [ADR-135](adr/135-cockpit-naming-convention.md)'s `_-prefix` window-name contract.

⚠ **"Every session" is not "every server", and the difference is load-bearing** ([ADR-281](adr/281-tmux-child-environment-scrub-at-the-spawn-seam.md), 2026-08-28). `createTmux` emits `-f` only when the caller passed a `configFile` — several call sites (notably `vox.ts`'s supervisor) do not — and tmux starts a **server** implicitly for any subcommand against a dead socket, `attach-session` and even a read-only `list-keys` included. A server born that way never loads the conf, and a running tmux server does not re-read one. Measured 2026-08-28 on geoywsMBP: **6 of 47 live servers had never loaded any atmux conf.** So anything that MUST hold for every cage cannot be implemented in the conf alone. The colour-environment scrub is therefore applied at the `spawn()` seam as well — see §Tmux child environment.

**Tmux child environment:** every tmux process atmux spawns has `NO_COLOR` **deleted** from its environment — a deletion and nothing else, via `TMUX_CHILD_UNSET_ENV` in `src/abstractions/tmux.ts` and the `unsetEnv` option on `src/abstractions/spawn.ts` ([ADR-281](adr/281-tmux-child-environment-scrub-at-the-spawn-seam.md)). atmux **sets** no colour variable on a tmux child: tmux sets `COLORTERM` in every pane itself, and on the `attach-session` path tmux reads `COLORTERM` from the **client** to decide whether the operator's own terminal advertises RGB — asserting that on their behalf makes tmux emit raw 24-bit colour at a terminal that never claimed to understand it (ADR-281 §D2). Server-level `COLORTERM` in a tmux conf is a different thing and is set there: `templates/tmux/atmux.conf` carries `set-environment -g COLORTERM truecolor` after the ADR-277 scrub and above the ADR-171 `source-file`, added 2026-08-28 because ADR-281 had claimed it was already there and it was not. Measured on tmux 3.7c (2026-08-29), that option does NOT add `RGB` to a client's `#{client_termfeatures}` — which is what makes it the safe half — and it is **inert for the pane**, since tmux sets `COLORTERM=truecolor` in every pane itself with or without the line. It is a cheap defensive default, not a fix for any pane fault measured here; the conf comment carries the full measurement. A tmux server freezes its own environ at start and builds every pane it ever creates from that copy, so a cage launched from inside an agent's Bash tool (which exports `NO_COLOR=1`) rendered every TUI in it monochrome for the life of the server. Three layers, in order: the spawn scrub (holds with no conf at all) → `atmux.conf`'s `set-environment -gr NO_COLOR` ([ADR-277](adr/277-cage-color-environment-scrub.md), covers servers atmux did not start) → `~/.config/atmux/tmux.conf.local`, which loads last so an operator who genuinely wants monochrome cages still wins ([ADR-171](adr/171-tmux-conf-local-override.md)). The scrub rewrites the **child's** environment only — atmux's own stdout keeps honouring <https://no-color.org> through `src/core/tui.ts::defaultPalette`. Sudo-wrapped call sites (`fallback-cage` Tier 3+, `poke`'s cage-brief sender) carry `TMUX_CHILD_ENV_ARGV` (`-u NO_COLOR`) in their `env(1)` prefix instead, because `sudo`'s `env_reset` discards a spawn-level override. The seam only reaches servers **atmux** starts; one measured on 2026-08-28 was created by `tmux list-keys` from outside atmux entirely, and for those the conf layer and the ADR-277 §D3 in-place repair remain the only tools.

**Plane split:** the legacy / ordinary atmux plane stays on `resolveTmuxBin()` (`ATMUX_TMUX_BIN` override → host PATH) and remains the old Homebrew tmux/resurrect plane. The future `aca` / `aco` vendored cockpit plane will be separate: its own socket, config, and resurrect namespace, an explicit tmux 3.7c binary via `resolveVendoredTmuxBin()`, and fail-closed behavior with no host PATH fallback. Ordinary atmux calls do not auto-route into that plane.

**Socket override:** `ATMUX_COCKPIT_SOCKET=<name>` (cockpit-tier only; per-team sockets are path-explicit by design per [ADR-058](adr/058-cage-tier-isolation.md)). Legacy operators can opt back into the default socket via `ATMUX_COCKPIT_SOCKET=default` for one more cycle while migrating.

**Migration from pre-ADR-162 setups:** `atmux cockpit migrate-socket` is the one-shot verb. Six phases (discovery → capture → recreate session on dedicated socket → recreate windows → scrollback breadcrumb → cleanup); idempotent; `--dry-run` previews; `--keep-legacy` preserves the old session. Process state is NOT transferred (tmux primitives can't re-bind PIDs across servers — see [ADR-162 §Amendment 2026-05-16](adr/162-atmux-owns-tmux-infrastructure.md#2026-05-16--decision-anchor-4-mechanism-graceful-recreate-not-pid-preservation-t-26346aef-tr3-impl)); operator re-invokes any in-pane process in the new panes. Cron-spawned roles re-establish on next tick. Full operator-facing details in [`docs/RUNBOOK-cockpit.md`](RUNBOOK-cockpit.md).

**Doctor probes (warn-class):**

- `tmux-version-mismatch` — host tmux below min 3.2 or untested above tested-against 3.7c.
- `cockpit-on-default-socket` — legacy cockpit session residue (`atx`, `atmux_cockpit`, or `atmux_teams`) on the default socket. Self-clearing post-migration.

**Member window-name format (per [ADR-161](adr/161-default-member-prefix-and-sort-verbs.md) §Part B):** in-team windows split by role class. `buildWindowName(name, emoji, label, role)` in `src/core/common.ts` picks the format:

- **Default members** (`role` in `{team-lead, planner, reviewer, ombudsman}`; `committer` joins per ADR-159) render `${emoji}_${label}` — underscore as both prefix marker and separator. Mirrors the cockpit-tier `_-prefix` convention from [ADR-135](adr/135-cockpit-naming-convention.md) §D2.
- **User-added members** (any other role, typically `"member"`) render `${emoji}-${label}` — hyphen separator per ADR-135 §D3 (still operative for the non-default branch).

`tmux list-windows` for a typical team renders `driver / 🧭_lead / 🗺️_planner / 🔍_reviewer / 🛠️-be-1 / 🛠️-fe-1` — defaults grouped at the top by canonical order, user-added below.

**Topographic-normalization verbs (per ADR-161 §Part C):** four `atmux member <sub>` verbs operate on the team layer (cockpit refused). Each uses `tmux move-window` / `tmux swap-window` primitives — pane PIDs, attached clients, and the running claude-process state are preserved across reorders.

| Verb | Effect | Idempotent on |
|---|---|---|
| `atmux member rename <id> --label <new>` | Hot-rename display label (ADR-136); no window-index change. | Label already matches. |
| `atmux member move <id> --to <position>` | Relocate one member's window to absolute 1-indexed slot. Auto-picks `swap-window` when target occupied (preserves occupant's PIDs), `move-window` when empty. | Source already at `<position>`. |
| `atmux member swap <id-a> <id-b>` | Pairwise atomic exchange via `tmux swap-window`. TmuxError-fallback to a three-move temp-index dance. | `idA === idB` refused at parse. |
| `atmux member sort [--defaults-first]` | One-shot canonical normalize: defaults by §Decision-anchor #4 order, user-added in existing relative order. | Already-sorted team. |

Every successful run rewrites `team.json::members[]` via `updateJson(Team)` under flock; ordering is derived from a post-mutation `listWindows` snapshot (authoritative — avoids hand-computed shifts).

## Roles

The pull model defines each role by what it *doesn't* do — narrow surfaces, no overlap. See [ADR-007](adr/007-pull-kanban.md) for the full spec.

| Role        | Window | Default TUI | What it does (post pull-model)                                                                                                                          |
|-------------|--------|-------------|---------------------------------------------------------------------------------------------------------------------------------------------------------|
| `driver`    | —      | (any)       | Relays human intent via `atmux tell-lead` + `atmux send`. Never inside the tmux session.                                                                |
| `team-lead` | 1      | claude      | **Routes** Epic-shaped asks to the planner; composes Epic summary at end via `atmux epic show` + `git log`. **Never decomposes. Never dispatches per-Task.** |
| `planner`   | 2      | claude      | **Owns decomposition**: Epic → (optional Stories) → Tasks, with `--lane`, `--deps`, `--deliverable`. Writes ADRs in `docs/adr/`. **Never dispatches.**  |
| `reviewer`  | 3      | claude      | **Story-level signoff** on cumulative diff (not per-commit). Empty `acceptanceCriteria` is automatic REJECT. Never commits.                             |
| `committer`    | 4      | claude      | Commits on Task `done` via auto-dispatched commit-Tasks. Finalizes Stories on `merging`. Only member that commits. **Never pushes by default.**         |
| `devops`    | 5      | claude      | Deploy / env / CI/CD / infra Tasks.                                                                                                                     |
| `dba`       | 6      | claude      | Schema + migrations + SQL (optional).                                                                                                                   |
| `member`    | 7…n    | any         | Lane workers — pull next claimable Task in their lane via `atmux claim --next`. **FE workers also own the TEST-lane capstone for UI Stories.**          |
| `ombudsman` | (event-driven) | claude (opt) | **Per-team complaint adjudicator** per [ADR-147](adr/147-ombudsman-and-release-notes.md). Reads `atmux complaints list --status open`, picks one of {file-epic, file-task, wontfix, already-addressed, defer} per complaint, appends day-file entry to `docs/release-notes/<Y>/<M>/<Y-M-D>.md` under `## Complaints adjudicated`. Wake via sentinel `.atmux/state/ombudsman-pending.json` + 15min `atmux ombudsman tick` cron line — NOT in whip cadence (ADR-147 §D2). |
| `whip`      | (cron) | —           | 5-min watchdog: pane state, rate-limits, stale Tasks, lead uptime. Escalates to the lead only when auto-recovery fails.                                 |

## Pull coordination

> **Held extension — `_superbot` offer-and-pull.** [ADR-285](adr/285-cooperative-bot-seat-and-superbot-offer-protocol.md)
> keeps Kanban as the sole work and lease authority. A deterministic cockpit
> scheduler reads `kb claim --candidates`, routes only by explicit `(board, tag)`
> ownership, and sends a short exact-claim offer to a stably idle team `_bot`.
> It never sends task bodies, claims, assigns, or targets a driver. The first
> `_bot` granted the atomic lease owns the task; every refused bot stops. The
> source implementation is complete behind disabled + shadow defaults; fleet
> activation remains a separate decision with no live config or tmux mutation.

The external private Kanban CLI is the current source of truth for work and
leases per [ADR-275](adr/275-external-private-kanban-authority.md). The legacy
in-repo schema below records the pre-cutover shape for historical and rollback
reading; new orchestration code must use the typed CLI adapter rather than open
or recreate this store.

```json
{
  "epics":   [ { "id": "e-…", "title", "body?", "driverRef?", "status",
                 "stories": [], "tasks": [], "createdAt", "completedAt?" } ],
  "stories": [ { "id": "s-…", "epic": "e-…", "title", "body?",
                 "acceptanceCriteria", "status", "reviewSignoff",
                 "mergeTaskId?", "createdAt", "completedAt?" } ],
  "tasks":   [ { "id": "t-…", "subject", "body", "status", "owner", "deps",
                 "priority", "epic?", "story?", "lane?", "deliverable?",
                 "createdAt", "claimedAt?", "completedAt?", "note?" } ]
}
```

`atmux::kanban_normalize` (in `lib/common.sh`) idempotently ensures `epics`/`stories`/`tasks` exist; legacy kanbans get the new arrays added on first mutation. `epic`/`story`/`lane`/`deliverable` on a Task are optional — missing reads as `null`.

### State machines

**Epic**: `planning → ready → in-progress → review → done`. The Epic auto-flips `in-progress → review` when its last child Task reaches `done` (storyless Epics) — and a `draft Epic summary` Task lands in the lead's inbox.

**Story**: `planning → ready → in-progress → testing → review → merging → done`. A Story auto-flips `testing → review` when its last open child Task is `done` AND that Task is in the `test` lane (TEST capstone). Reviewer advances `review → merging`; committer advances `merging → done` once the commit chain is clean.

**Task**: `todo → in-progress → done` (or `blocked`). Tasks with non-`done` deps are filtered out of `claim --next` automatically.

### Pull selection

Workers run `atmux claim --next [--as <member>] [--lane <lane>]`. Selection (lib/claim.sh):

1. Filter Tasks: `status=todo`, `owner=null`, `deps - done_ids = []`.
2. First pass: `lane == caller's lane`. Sort by `priority asc, createdAt asc`. Pick first.
3. If empty AND `team.kanban.crossLaneClaim != false`: any lane, same sort.
4. Atomic claim: `jq_update` flips `owner`/`status`/`claimedAt` only if `owner` is still `null` post-read; race-aware with 3 retries.

Lane vocabulary: `fe` / `be` / `db` / `ops` / `test` / `review` / `misc`. UPPER-CASE in prose ("FE worker"), lowercase in JSON / `--lane` args.

### Auto-dispatch on Task done

When `atmux task move <id> done` lands (or `atmux done <id>`), `lib/kanban.sh` decides side-effects atomically inside one `jq_update`:

- **Always**: if the source Task has `.epic` set, append a new `commit <id>` Task targeting committer (`owner=committer`, `status=in-progress`, `lane=misc`, `claimedAt=now`, `epic=null` to prevent recursion). Mirror to `inboxes/committer.json`.
- **Story testing → review flip**: if the moved Task is the last open child of its Story AND its lane is `test` AND the Story is currently `testing`, set `story.status=review`.
- **Storyless-Epic in-progress → review flip**: if the Epic has zero Stories AND the moved Task is the last open child of the Epic AND the Epic is `in-progress`, set `epic.status=review` AND append a `draft Epic summary <eid>` Task to the lead's inbox.

Each side-effect is gated by a flag computed before the write, so the filter stays read-only when the gate is off — idempotent on `done → done`.

```
                  ┌────────────────────────────────────┐
   member runs    │ atmux done t-aaa --note "feat: …"  │
                  └─────────────┬──────────────────────┘
                                │ kanban.json (atomic jq_update)
                                ▼
        ┌───────────────────────────────────────────────┐
        │ tasks[t-aaa].status = done                     │
        │ if .epic   → tasks += [commit-Task → committer]  │
        │ if last test-lane child of testing Story      │
        │            → stories[s].status = review       │
        │ if last child of storyless in-progress Epic   │
        │            → epics[e].status = review +       │
        │              tasks += [Epic summary → lead]   │
        └───────────────────────────────────────────────┘
                                │
                                ▼
        committer / reviewer / lead inbox updates land via
        _atmux_kanban_push_inbox (mirrors kanban → inbox)
```

## Driver → Lead routing

Two paths; use both:

1. **Durable**: `atmux tell-lead "..."` appends to `.atmux/driver-inbox.md`. Lead reads this first on every whip turn. Survives `/clear`, survives tmux restart.
2. **Immediate**: the same command also fires a short heads-up via `tmux send-keys` to the lead's pane. Gives the lead a nudge to check the inbox.

## Lead → Planner routing (pull model)

The lead does **not** decompose Tasks itself and does **not** `atmux dispatch` per-Task as the default flow:

1. **Lead reads `driver-inbox.md`**, decides Epic-shaped asks → `atmux send planner "<verbatim ask + driver-ref>"`.
2. **Planner runs `atmux epic add` → `atmux story add` (optional) → `atmux task add --epic <eid> --lane <lane> --deps …`**, then `atmux reply` to the lead with task IDs + dependency notes.
3. **Workers self-pull** via `atmux claim --next`. No manual dispatch by default; `atmux dispatch <member> <task-id>` is reserved for explicit driver-requested priority overrides.
4. **Decisions log**: `atmux decisions add "<question>" --default "<answer>" --reversibility low|medium|high` for any non-trivial auto-mode resolution. Logs to `.atmux/decisions.md` AND pings Discord. See [ADR-008](adr/008-decisions-verb.md).

## Whip (watchdog) — every 5 min

`atmux whip` checks:

1. Session liveness (is the tmux session up?).
2. Per-member pane: does `#{pane_current_command}` match the expected TUI binary?
3. Per-member banners: `rate-limit`, `Compacting conversation`, `Press up to edit queued messages`.
   - **Modal cycling** (per ADR-142, module `src/core/modal-cycling-detector.ts`): ≥N distinct modal-prompts within `modalCycling.windowMin` AND 0 commits in `commitGracePeriodMin` → fires `[whip-modal-cycling]` Discord + clarifier dispatch + flag. Sits one layer above the existing static-stuck classifier (which catches *same prompt repeating*); modal-cycling catches *different prompts in rapid sequence*, the pattern §1c missed on 2026-05-14 whip-impl. State at `~/.atmux/state/modal-history-<member>.json` + `modal-cycling-dedup-state.json`.
   - **Commit-cadence classifier** (per [ADR-148](adr/148-commit-cadence-truth-signal.md) §D2, module `src/core/cadence-classifier.ts` — landed by T5 / t-ac95b267, lifting the inline classifier T2 inlined in `src/verbs/status.ts`): pure `classifyCadence(logLines, nowSec, windowSec, thresholds)` + async wrapper `classifyMemberCadence(member, worktreePath, config, deps)` composing the canonical `git -C <path> log --since=<N>s --author=<member> --format=%H %ct` probe with classification. Emits four verdicts (`shipping` / `idle` / `dormant` / `ship-zero-window`) per ADR-148 §D2 table. Consumers: `atmux status` cadence column (T2), Discord `[ship-zero-window]` template + medic event-driven pickup (deferred follow-up per ADR-140 chain). (The planned orchd event consumers will not ship — orchd retired per ADR-276.)
4. Per-member staleness: any `inProgress` tasks older than `ATMUX_STALE_MIN`?
5. Lead uptime: has the lead been alive longer than `ATMUX_LEAD_MAX_MIN`? If so, recommend `atmux rotate-lead`.

Findings are appended to `.atmux/logs/whip.log`. Non-empty findings also get pinged to Discord (`ATMUX_DISCORD_WEBHOOK` or `DISCORD_WHIP_WEBHOOK`).

## Report (digest) — every 30 min

`atmux report` produces:

- **Shipped** (tasks completed since last report)
- **In-progress** (current assignments per member)
- **Blocked**
- **Open driver-inbox asks**

Pinged to Discord.

## Release notes layout — `docs/release-notes/<Y>/<M>/<Y-M-D>.md`

Per [ADR-147](adr/147-ombudsman-and-release-notes.md) §D4, atmux ships a per-day release-notes file at `docs/release-notes/<YYYY>/<MM>/<YYYY-MM-DD>.md`. Year and month folders give navigability (`ls docs/release-notes/2026/05/` = month view); one file per day with append-only sections keeps cross-team writes conflict-free.

Every day-file follows a skeleton with append-only sections, each owned by a specific agent:

| Section                       | Written by                                                       |
|-------------------------------|------------------------------------------------------------------|
| `## Shipped (kanban→done)`    | committer post-fan-in (or hygiene-tick backstop) per ADR-147 §D4    |
| `## Merges (branch→trunk)`    | committer post-trunk-merge per ADR-145 + ADR-146                    |
| `## ADRs landed`              | hygiene-tick on detecting new `docs/adr/*.md`, or ADR author     |
| `## Complaints adjudicated`   | ombudsman per ADR-147 §D3                                        |
| `## Doctor regressions`       | medic on red-row escalation (optional; empty most days)          |
| `## Notes`                    | operator-curated narrative (optional; empty most days)           |

**Auto-create + idempotency**: the first writer of the day creates the file with all skeleton sections empty; subsequent writers append to their own section. No locking — section headers act as natural insertion anchors. The append-only invariant lets multiple agents write the same day-file safely (per ADR-147 §D4).

**Discovery**: `docs/release-notes/README.md` is the entry-point, documenting the layout convention + browsing pattern + auto-generated 30-day TOC (ADR-147 §D4).

**Cross-team monorepos** (ADR-090 epic-team scope, future): same physical file at repo root; each team writes only to its `### <team>` sub-section within `## Complaints adjudicated` to keep appends conflict-free (ADR-147 §D6).

**Doctor backstop**: probe `release-note-missing` (warn-class, NOT block) fires when today has ≥1 trunk commit AND today's day-file doesn't exist — backfill cue for ombudsman or hygiene-tick (ADR-147 §D5).

## Ombudsman wake — sentinel + cron (event-driven)

Per [ADR-147](adr/147-ombudsman-and-release-notes.md) §D2, the ombudsman role wakes on **events**, not whip cadence. Two writers + one reader define the protocol:

- **Sentinel file** — `.atmux/state/ombudsman-pending.json`: an array of complaint IDs (`c-xxxxxxxx`) awaiting first adjudication.
- **Write-through**: `atmux complaints file` appends the new `c-id` to the sentinel (same transaction as the DB insert, ADR-091 pre-flag #1 pattern). `atmux complaints resolve` removes the `c-id` (whether ombudsman wrote the resolution or operator manual-resolved).
- **Cron tick**: `atmux ombudsman tick --team <team>` runs every `team.ombudsman.tickIntervalMins` (default 15min). Fast-path no-op when sentinel is empty; wakes the ombudsman pane via `safeSendKeysWithVerify` ([ADR-138](adr/138-verified-send-keys.md)) with `atmux ombudsman work` when non-empty.

The sentinel + cron pair is chosen over pure socket-pubsub (ADR-032) because medic + whip-velocity-gate can file 5–10 complaints in a burst; batching the wake gives ombudsman the chance to drain in one session rather than wake-process-sleep × N. This matches the `groom-pending-judgment.json` pattern from the supergroomer parking-lot task (ADR-147 §D2 tradeoff section).

## Module map (selected — health + observability)

| Module | Purpose | Authoring ADR |
|---|---|---|
| `src/core/cage-state.ts` | Unified 4-state taxonomy (down/bootstrapping/active/wedged) for claude member panes. Replaces the `pane_current_command` proxy that mis-classified welcome-screen TUIs. | t-74273200 |
| `src/core/cadence-classifier.ts` (T5) | Pure commit-cadence classifier consumed by status (the planned orchd event consumers will not ship — ADR-276). | [ADR-148](adr/148-commit-cadence-truth-signal.md) |
| `src/core/refusal-classifier.ts` | Pure pane-output refusal classifier. Four classes (soft / hard / role / meta) with regex primary + heuristic secondary. Sibling-not-extension of `safe-send.ts` (input-side refusal); ADR-139 §Grep findings audit covers the boundary. | [ADR-139](adr/139-refusal-pattern-auto-rotate.md) §D1 |
| `src/core/refusal-threshold.ts` | Pure threshold gate over a refusal-event ledger. Decides whether accumulated detections cross the rotate threshold per ADR-139 §D3 (soft 3/30min, hard 2/10min, role 1/instant; meta never rotates). | [ADR-139](adr/139-refusal-pattern-auto-rotate.md) §D3 |
| `src/core/fallback-brief.ts` | Pure-of-direct-IO Tier 2 fallback brief composer. Reads in-progress Task body + `templates/briefs/<role>.md` + `git log --oneline -10` + lead-outbox tail; writes assembled brief with Tier-2 guardrails preface to `<atmuxDir>/state/fallback-brief-<member>.md` for the cage spawn to pipe into `cursor-agent --print`. | [ADR-050](adr/050-fallback-chain.md) §Brief generator |
| `src/core/lead-marker.ts` | I-1 (`lead-session-start.txt`) + I-2 (`lead-window-name.txt`) marker R/W. The rotation-gate canonical source per ADR-077 §lead-uptime-measurement — NEVER read `ps -o etime` for rotation decisions. | [ADR-077](adr/077-superdoctor-cockpit-role.md) §lead-uptime-measurement |
| `src/core/branch-merge-state.ts` | Pure state machine for ADR-091 (epic-team) + ADR-134 (intra-team) auto-merger. 10-state lifecycle + pure transition function. | [ADR-091](adr/091-kanban-driven-auto-merge.md), [ADR-134](adr/134-in-team-auto-merger.md) |
| `src/core/repositories/merger-state-repo.ts` | Typed CRUD over `merger_state` table; transactions wrap `BEGIN IMMEDIATE` to serialize concurrent ticks. | [ADR-134](adr/134-in-team-auto-merger.md) §state-machine |
| `src/abstractions/issue-tracker.ts` | Types-only vendor-agnostic `IssueTracker` seam (`NormalizedIssue` / `IssueTrackerPage`) for **issue-sync** — external issue-tracker ingestion (GitHub / Azure DevOps) polled into the complaints substrate; config at `team.json::issueSync`. Phase 0: types + schema + [RUNBOOK-issue-sync](RUNBOOK-issue-sync.md) only; adapters + `atmux issues sync` land Phase 1. | [ADR-261](adr/261-issue-sync-external-tracker-ingestion.md) |

## Voice subsystem (`atmux vox`)

Per [ADR-272](adr/272-voice-operator-interface.md). The operator's spoken
interface to the fleet: **phone PWA → WebSocket relay → realtime provider →
`atmux` verbs**. Operating surface in [`docs/RUNBOOK-vox.md`](RUNBOOK-vox.md);
product framing in `docs/PRD.md` §3.7.

**Consistency with §Principles.** Principle 1 (*"atmux doesn't speak any AI
provider API"*) governs the **orchestration** seam; voice is an **operator**
seam and is the single carve-out, bounded by the import fence recorded inline in
that principle above. The other four principles hold unchanged, and two hold
*because* of specific design choices rather than by accident:

- **Principle 2 (state on disk, outside every agent process)** — voice adds no
  store. Session state is in-memory and dies with the session; the tool bridge
  never opens a `Database`, which is also what makes [ADR-271](adr/271-sqlite-sole-store-rust-orchd-coordinator.md)
  §D3's `{ create: true }` auto-create footgun structurally unreachable from this
  path. No voice artifact is written into any managed product repo
  ([ADR-268](adr/268-managed-repo-state-isolation-enforcement.md)).
- **Principle 3 (no long-lived process required)** — the server is one, but it is
  **operator-started and starts nothing at boot** ([ADR-233](adr/233-cron-auto-install-disabled-trust-orchd.md)),
  dies with its tmux pane, and is not a cron arm ([ADR-192](adr/192-cron-arm-idempotency-contract.md)
  governs cadences; a supervised process is not one).
- **Principle 4 (driver is external)** — unchanged, and sharpened: the server
  invokes verbs with `ATMUX_CALLER_SCOPE=driver`, so the same gates that apply to
  the operator's own shell apply here, rather than a parallel implementation that
  can drift.

The one honest tension is with §Non-goals: atmux gains a **listening socket**,
which is the property [ADR-261](adr/261-issue-sync-external-tracker-ingestion.md)
§Context previously paid to avoid. It is bound to loopback by default, reachable
only through nginx, and is an operator surface — not a hosted service, not
accounts, not cross-machine orchestration. See §Non-goals below.

### Layering

Each layer knows only the layer beneath it. Reading top-down is reading the path
a spoken sentence takes.

| Layer | Modules | Responsibility |
|---|---|---|
| **PWA client** | `templates/vox/` (`index.html`, `js/`, `worklet/`, `manifest.webmanifest`) | Vanilla ESM, **no build step, no service worker** (§D11). Captures mic in an `AudioWorklet` on the audio render thread, decimates 48 kHz → 24 kHz at an exact 2:1 ratio, plays raw PCM downlink. Push-to-talk. Staged by the existing `templates/` copy in `build:install` and located at runtime by `resolveTemplatesDir()`, so it sits outside the `src/**` coverage universe by construction rather than by exclusion (§D9). |
| **Serve verb** | `src/verbs/vox.ts` | `--serve` / `--supervise` / `--status` / `--stop`. Owns the detached `atmux-vox` tmux session, the crash-loop wrapper and its circuit breaker, and applies the read-only catalog filter. |
| **Session state machine** | `src/core/vox/session.ts` | One active session (§D8): hello/auth handshake, latest-wins takeover, the 90-second resume park, provider dial with a bounded `session-ready` budget, and the relay between phone frames and provider events. |
| **Tool bridge** | `src/core/vox/{tool-bridge,tool-catalog,config,team-context,summarize,instructions,fleet}.ts` | Turns a model tool call into an **argv array** for the `atmux` CLI — never a shell string (§D2). Per-tool Zod validation before the argv is built; result summarization back to speech-sized text. `fleet.ts` is the ADR-273 D1–D3 triage classifier + renderer behind `fleet_attention` / `fleet_quiet` — pure, no IO, with the sweep itself in `src/verbs/fleet.ts`. |
| **Provider seam** | `src/abstractions/voice-provider.ts` (types-only) · `src/abstractions/voice/{factory,openai-realtime,gemini-live}.ts` | `VoiceProvider.connect(config) → VoiceSession`. Translates provider-native frames into neutral events. See below. |
| **Protocol** | `src/core/vox/{frame,audio,auth,confirm,registry,assets,probe}.ts` · `src/schema/voice.ts` | Binary frame codec (4-byte header: magic `0xA1`, flags incl. `TURN_END`, `uint16` seq; payload PCM16LE mono 24 kHz, 40 ms = 1924 bytes/frame), JSON control schema, timing-safe pre-upgrade token auth, and the confirmation-token store. Audio and control never mix: audio is binary frames, control is JSON text frames. |

**Canonical audio is PCM16LE mono 24 kHz in both directions** (§D5), chosen so
the *irreversible* quality decision never happens on the phone: 48 → 24 is an
exact halving, OpenAI is passthrough on both legs, and Gemini's 24 → 16 uplink
resample happens **server-side** where CPU is free.

### Why the provider seam exists

This is [ADR-272](adr/272-voice-operator-interface.md) §D4, and it is the
architectural decision in the subsystem worth understanding before changing
anything in it.

**atmux does not speak any one AI provider's API — not even here.**
`src/abstractions/voice-provider.ts` declares two types and nothing else
(types-only, zero runtime), following the `AgentBackend` precedent set by
[ADR-258](adr/258-vendor-agnostic-orchestration-agentbackend.md). **No
provider-native frame shape crosses the adapter boundary in either direction:**
OpenAI's `response.output_audio.delta` and Gemini's `serverContent.modelTurn`
are both translated *inside* their adapter into the same neutral event before
anything else sees them. The core, the tool bridge, the wire protocol and the
client know only the neutral shape.

The test of the decision is behavioural, not stylistic: **swapping
`ATMUX_VOX_PROVIDER` from `openai-realtime` to `gemini-live` must require zero
client-side diff.** A second adapter (Gemini Live — a different handshake, a
different audio rate, a different tool-call shape carrying a required `name`
beside the id, and a different turn-detection model) landed behind the seam with
`voice-provider.ts` untouched and no client change. That is the seam holding.
If a client change is ever needed for a provider swap, the seam has leaked and
the adapter is wrong.

Provider selection resolves **once, at session construction**. There is no
hot-swap and no mid-session failover: reconciling two conversation-history
models and two audio negotiations mid-sentence is worse than the honest failure
of ending the session and redialing.

**Both adapters are live-verified against their real providers**, and V-7 — the
acceptance test for this seam — is closed **live** rather than on a fixture:
flipping `ATMUX_VOX_PROVIDER` to `gemini-live` and re-running the probe against
the real Google endpoint reached `session-ready`, streamed 50 uplink frames, and
returned 14 downlink frames (71,040 bytes) with user and assistant transcripts
and a clean `1000` close — with byte-identical client assets. Receipt in
`CHANGELOG.md`.

**The path each adapter took to get there differs, and that asymmetry is the
instructive part.** `openai-realtime` needed a **GA port** before it worked at
all: it had been written against the retired Realtime beta API, and every one of
its tests passed against a fixture that encoded our model of the API rather than
the API. `gemini-live` was **correct as written** and verified without code
changes. The general lesson is not that one adapter was better authored than the
other — it is that **neither was proven until someone dialled the real
endpoint**, and one of the two turned out to be entirely broken at that moment.
A green fixture suite is not evidence that an integration works; see
`CHANGELOG.md` for the full account.

## Why `tmux send-keys` and not SDK API calls?

- **Works with any TUI** — we don't depend on a model-provider SDK. Cursor's CLI, Kimi's CLI, OpenCode, Claude Code all just get shell input.
- **Zero drift between human + agent view** — what atmux sees is exactly what the human sees in `tmux attach`.
- **No auth plumbing** — whatever auth the TUI itself uses, atmux inherits for free.
- **Robust to provider outages** — if one TUI's API is down, other TUIs keep working.

## Why bash + jq?

- **Shareable** — `curl | bash` install, no compile step, no language runtime to pin.
- **tmux-native** — the whole tool is tmux-wrapper-shaped; bash is the natural language.
- **jq is the best JSON tool for shell scripts.** Atomic `jq … > file.tmp && mv` writes.

Tradeoff: less type safety than TypeScript. Mitigated by bats-core unit tests.

## Non-goals

- Hosted service. atmux is a local CLI. No server, no accounts.
- Sandbox. If you let Claude run `rm -rf` in a member's pane, it'll run. Use `--permission-mode` / the TUI's own guardrails.
- Cross-machine orchestration. Everything is a single tmux server = single host.
