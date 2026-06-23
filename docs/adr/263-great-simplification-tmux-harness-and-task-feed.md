# ADR-263: The great simplification — atmux is a tmux harness + a git/sqlite task feed; retire the fleet-coordination layer

**Status**: proposed
**Date**: 2026-06-19
**Driver-ref**: George 2026-06-19 — "i no longer need atmux to manage a fleet… but i still need atmux to manage my tmux setup to run things… keep the kanban just optional for now… clean atmux up to simplify"; "now that there's also /goal and etc as well in claude"; "maybe we could use atmux as a way for me to handle bugs and prs that are worked on by claude after watching a certain git repo… tasks come from either git or just via sqlite"; "atmux is way too fat". **Forks resolved this session:** (1) git→Claude path is **feed-only** — the watcher files tasks; a Claude pane pulls them; no auto-dispatch, no auto-spawn. (2) **Drop ADR-258 + ADR-262** — one backend (tmux + Claude); the vendor-agnostic `AgentBackend` interface and the OpenCode plugin/Rust-daemon direction are abandoned.
**Relates / supersedes**: completes the retreat begun by [ADR-260](260-manual-orchestration-mode-default.md) (manual mode default — "LLMs can manage their own fleet better than atmux can"); **supersedes** [ADR-258](258-vendor-agnostic-orchestration-agentbackend.md) + [ADR-262](262-atmux-opencode-plugin-and-daemon.md) (§D5); **re-points** [ADR-261](261-issue-sync-external-tracker-ingestion.md) from `poll → complaints → lead adjudication` to `poll → tasks` (§D3); **retires the fleet-coordination ADR families** listed in §D4. Keeps [ADR-162](162-atmux-owns-tmux-infrastructure.md) (atmux owns its tmux infra — the spine), [ADR-007](007-pull-kanban.md) (pull-kanban — kept but now optional), [ADR-060](126-sqlite-state-store.md) (`state.db` is the task store), [ADR-006](006-bare-atmux.md) (`up`), [ADR-005](005-doctor-preflight.md) (`doctor`).

## Context

atmux was conceived (PRD §1, ARCHITECTURE.md) as a **tmux-native multi-TUI fleet orchestrator**: one tmux session per team, a window per agent, a pull-kanban, and — over ~200 ADRs — an ever-thickening coordination brain on top. As of HEAD that brain is:

- the **`atmux-orchd`** Rust daemon (one process/team, 10 in-process consumers + 4 tickers) and its consumer family — auto-merge, auto-push, auto-spawn, solo-worker-dissolve, lead-stall watchdog, context/budget scanners (ADR-224/226/227/228/229/231/233/240/247/255/256);
- the **Honker** in-DB messaging substrate + topic taxonomy (ADR-202/203);
- **lanes** (lane-tick / lane-stall / lane-drift), **epics + stories**, **epic-team spawn/sweep/dissolve + fan-in mergers** (ADR-090/091/134/...);
- the **cockpit** (+ mirror + rotate) operator surface (ADR-063/077/133/135/162/230);
- **whip/poke**, **report**, **pulse**, **heartbeat**, **watchdog**, **refusal-scan/auto-rotate**, **budget-pause/refresh**, **rotate/handoff**, **improve/hygiene/groom**, **discorder**, **complaints/blockers/ombudsman**, **member roles + briefs** (ADR-001/008/009/049/052/057/086/139/142/147/148/153/214/237/...).

That is **~70 verbs, ~150 `src/core/` modules, ~100k LOC**. The operator's verdict: **"atmux is way too fat."**

**Why the brain is now redundant.** The coordination layer existed to compensate for narrow context windows and the need to fan work across cheap models. Three things changed:

1. **Claude Workflows** — deterministic multi-agent fan-out/verify/synthesize, on demand, no standing daemon.
2. **1M-context, fast frontier models** (e.g. Opus 4.8 [1m], DeepSeek V4 Pro) — a single agent now holds a whole subsystem; the throughput argument for a worker fleet has collapsed.
3. **Claude Code's built-in `/goal`, plan-mode, subagents** — the autonomous-drive and decomposition atmux duplicated now ship in the harness the operator already runs.

atmux had already started this retreat itself: **ADR-260 (2026-06-12) made manual orchestration the default**, recording verbatim that "LLMs can manage their own fleet better than atmux can at the moment." ADR-260 made the brain *opt-in*. This ADR finishes the job: it makes the brain *gone*, and re-aims what remains at a concrete, durable job.

**What is durably valuable.** Two things, and only two:

- The **tmux harness** — deterministic, idempotent bring-up of agent panes in a project on a dedicated cage socket with a pinned `atmux.conf` (ADR-162/058), plus attach / send / teardown. This is the one piece nothing else replaces, and it is what the operator explicitly wants to keep ("still need atmux to manage my tmux setup to run things").
- A **task feed** the operator triages from — now with a second, requested source: **a watched git repo** whose issues/PRs become tasks ("handle bugs and PRs… after watching a certain git repo… tasks come from either git or just via sqlite").

## Decision

### D1 — atmux's scope is exactly three things

1. **tmux harness.** Bring up N agent panes in a repo, attach, send keystrokes, tear down — idempotent, on the dedicated cage socket per ADR-162. Panes are **flat**: plain Claude (or any TUI) sessions the operator drives. No roles, no role-briefs, no lead/planner/reviewer/committer distinction.
2. **task feed.** One task list in `state.db` (ADR-060), fed by two sources:
   - **sqlite** — manual `atmux task add` / `claim` / `done` (the pull-kanban of ADR-007, kept but **optional** — see D6).
   - **git** — a poller that turns a watched repo's issues/PRs into tasks (D3).
3. **the work loop.** A pane runs `atmux claim --next`, works the task, runs `atmux done`. That is the entire coordination model. No lanes, epics, stories, reviewers, committers, auto-merge, or daemon.

### D2 — Keep-set (the spine)

Verbs retained: `init` · `start` · `stop` · `status` · `attach` · `up` · `send` / `broadcast` · `cleanup` · `doctor` (slimmed to tmux/team/task-feed probes) · `reconfigure` · `version` · `help` · `sync` (claude-team-json) · the kanban verbs (`task` / `claim` / `done`, see D6) · the git task-source verb (`issues sync`, see D3).

Abstractions retained: `tmux.ts` / `tmux-window-orchestrator.ts`, `fs.ts`, `json.ts`, `lock.ts`, `spawn.ts`, `worktree.ts`, `time.ts`, `sqlite.ts` / `sqlite-migrations.ts`, `http.ts`, `issue-tracker.ts` (+ its `github` adapter, D3), `uuidv7.ts`. Core retained: `common.ts`, `tmux-paths.ts`, `resolve-tmux-bin.ts`, `tui.ts`, `kanban.ts` (task CRUD), `io.ts`, `name-resolver.ts`, `events-log.ts` (verb audit JSONL — kept; this is **not** Honker), `templates-dir.ts`.

### D3 — Git task source: re-point ADR-261 from complaints to tasks

ADR-261 built the right *ingestion* seam (the types-only `IssueTracker` interface, the poll-not-webhook stance, the `github`/`azure-devops` adapter house pattern, the `team.json::issueSync` config) but wired its **output** into the fleet machinery this ADR deletes: `poll → fileDedupedComplaint → complaint.filed (Honker) → consumer → tell-lead → lead adjudication`. That entire downstream is cut.

**New contract:** `poll → upsert Task`.

- `atmux issues sync` polls the configured repo via the `IssueTracker` adapter (Phase 1 = `github` only; the `azure-devops` adapter and the `TrackerId` union stay in the seam for later). HTTP via `http.ts` per ADR-261 §D1.
- Each matching issue/PR (filter = state + label allowlist from config) is **upserted as a Task** in `state.db`: `subject` = issue title, `body` = issue body + canonical URL, provenance carried on the task row (`sourceKind: "github"`, `sourceId: "github:owner/repo#123"`). Dedup keyed on `sourceId` — re-polls update, never duplicate (closing the ADR-261 §Context gap #1 1h-window problem by keying on identity, not time).
- Upstream-closed issue → the task is moved to `done` (or left, operator-configurable). No write-back to the tracker (ADR-261 §Out-of-scope unchanged).
- **No complaints, no Honker emit, no lead, no auto-dispatch.** The task lands in the feed; a Claude pane (or the operator) picks it up via `claim --next`. This is the **feed-only** fork the operator chose.
- Config moves to a `team.json::taskSources` block (or the existing `issueSync` block, re-documented): `{ provider: "github", scope: "owner/repo", labels: [...], state: "open", pollIntervalMins: N }`. Polling is operator/cron-invoked (`atmux issues sync`); there is no daemon.
- **Prompt-injection note (ADR-261 §Context gap #5 carried forward):** public issue/PR bodies are attacker-controllable text that now flows into task bodies a Claude pane will read. The task body is data, not instructions; the pane's brief (such as it is) must treat ingested bodies as untrusted. This is a documented residual risk, not a solved one.

### D4 — Cut-set (the fleet-coordination layer) + supersession

Removed entirely (verbs, core modules, Rust crates, schema, briefs, tests, RUNBOOKs, cron templates). The authoring ADRs are **superseded by this ADR** (append-only: the ADR files stay for trace; their rows move to the INDEX "Superseded" section as the code lands):

- **Daemon + messaging:** orchd (ADR-224/226/227/228/229/231/233/240/247/255/256), Honker + topic taxonomy (ADR-202/203), `rust/atmux-orchd`, `rust/atmux-listener`, `rust/atmux-cockpit-mirror`.
- **Lanes / epics / stories / epic-teams / mergers:** ADR-090/091/134 and the lane-tick/stall/drift, epic, story, epic-merge, merge-cycle, merge-member, team spawn-epic/sweep-epics/dissolve-epic/spawn-worker families.
- **Cockpit:** ADR-063/077/133/135/230 — cockpit, cockpit-mirror, cockpit-rotate. (The operator views team panes with plain `tmux attach`; the bespoke cockpit session/socket is gone.)
- **Watchdogs / cadence / nudging:** whip/poke + report + pulse + heartbeat + watchdog + refusal-scan/threshold/rotate + modal-cycling + cadence-classifier + lead-stall-watchdog (ADR-009/057/086/139/142/148/237).
- **Budget / cost / accounts:** budget-pause/refresh/warning/history, account-pool/swap, cost (ADR-049/053/054/055/056).
- **Roles / coordination extras:** lead/planner/reviewer/committer/ombudsman roles + all `templates/briefs/*`, rotate/handoff, improve/eternal-improvement/hygiene-tick/groom, discorder, complaints/blockers, dispatch, tell-lead/driver-inbox/reply/outbox, decisions/flags (ADR-001/008/052/147/153/214/257/...).
- **Vendor-agnostic + opencode (D5):** ADR-258 + ADR-262.

This is roughly **80% of the codebase**. The driver fan-out (`drivers[]`) collapses into the flat-pane model of D1 — the new default *is* the driver model (operator-interactive panes, no pre-prompts, no brief paste), which ADR-239 already described for drivers.

### D5 — One backend: tmux + Claude

ADR-258 (demote tmux to an attach view behind an `AgentBackend` adapter) and ADR-262 (split atmux into an OpenCode plugin + Rust daemon, eliminating tmux from the critical path) are **superseded**. The simplified atmux re-commits to ARCHITECTURE.md Principle #1 in its original form: **tmux is the IPC.** `tmux send-keys` writes input; `tmux capture-pane` reads output; it works with any TUI but ships pointed at Claude. Delete `src/abstractions/agent-backend.ts`, `src/abstractions/backends/`, `plugins/atmux-opencode/`, the planned `rust/atmuxd/`, and the in-flight `.opencode/` scaffold.

### D6 — Kanban (and the whole task feed) is optional

`atmux start` / `up` / `attach` / `send` / `stop` **never require any task state**. A team is just a `team.json` (a name + a list of panes). The task feed — sqlite tasks and the git source — is opt-in: present it only when the operator uses `task`/`claim`/`issues sync`. `doctor` does not red-row a team for having zero tasks. "Keep the kanban just optional for now" = it stays in the codebase, fully functional, but off the critical path of the harness.

### D7 — Staging the cut (decision now, code in reviewable phases)

Per the binding discipline (ADR before code), this ADR + the PRD rewrite land **first**, as the decision record. The deletion follows in phases, each its own reviewable commit, recoverable via a pre-cut git tag (`pre-adr-263-simplification`):

- **P0 (this commit):** ADR-263 + PRD rewrite + INDEX row + ADR-261 re-point banner.
- **P1 — unwire:** drop the cut verbs from `src/cli.ts` dispatch + `help`; stop spawning orchd/cockpit from `start`; stop role-brief paste; collapse `members[]`/`drivers[]` to flat panes. (Behavior flips here; code still present.)
- **P2 — delete:** remove the cut `src/verbs/*`, `src/core/*`, `rust/*`, `plugins/*`, `templates/briefs/*`, their tests, RUNBOOKs, and dead schema. Move superseded ADR rows to the INDEX "Superseded" section.
- **P3 — re-point issue-sync:** implement `issues sync → task` per D3 (the `github` adapter against the task table; drop the complaints path).
- **P4 — docs sweep:** ARCHITECTURE.md, README.md, GETTING_STARTED.md, CHANGELOG.md reflect the lean surface.

P1–P4 are a natural fit for a Workflow (fan-out deletion across independent file sets, verify typecheck/test green per phase).

**Implementation status (2026-06-22):** all phases landed on branch `atmux-geoyws-driver-2`. P0–P2 + P4 cut `src/` from 282 → 61 non-test files (recovery tag `pre-adr-263-simplification`). **P3 (this update)** shipped the git task source per §D3: restored `src/abstractions/http.ts` + the re-pointed `src/abstractions/issue-tracker.ts` seam, added the `github` adapter (`src/abstractions/trackers/github.ts`), the sync engine (`src/core/issue-sync.ts`), the `issues sync` verb, the `team.json::taskSources` schema block, and sqlite-migrations **v16→v17** (`tasks.source_kind` + `tasks.source_id` + the partial-unique `idx_tasks_source_id` dedup index). Feed-only, dedup on `sourceId`, per-source watermark in `state_kv`, `onClose` close-reconciliation that never yanks an in-progress task. The prompt-injection residual (§D3) is mitigated by fencing ingested bodies under an explicit "UNTRUSTED" banner but remains a documented, unsolved risk. 100% unit coverage on every new file.

**Amendment 2026-06-23 — residual Epic/Story cut completed (see [ADR-264](264-tasks-drive-development-headless-drivers.md)):** §D4 retired the fleet *behaviour* but the P2 delete left the Epic/Story **data model** physically present as dead residue (the `KanbanEpic` / `KanbanStory` schemas + `{tasks, epics, stories}` shape, the `epics` / `stories` SQLite tables + `tasks.epic` / `tasks.story` columns, the `--epic` / `--story` verb flags, the ADR-146 story-branch auto-emit hook, and the `epic.*` / `story.*` Honker event taxonomy). ADR-264 cuts all of it — Task is now the sole persistent work unit; decomposition is the executing agent's transient Workflow concern, not persisted rows. sqlite-migrations **v18** drops the `epics` / `stories` tables, the `tasks.epic` / `tasks.story` columns, and their indexes.

## Consequences

- **atmux becomes ~20% of its current size** — a tmux harness + a task feed + a git poller. Far less to maintain, reason about, or break.
- **The fleet stops, deterministically.** No daemon, no cron LLM cycles, no auto-merge, no auto-spawn. The operator (and the Claude panes they run) own all coordination — exactly the ADR-260 premise, taken to its conclusion.
- **~30 ADRs move to superseded.** They stay on disk (append-only history); the INDEX reflects the supersession. ADR-261's seam survives, re-aimed; its complaints downstream dies with the substrate.
- **Loss of recoverability is bounded by a tag.** The fleet brain is recoverable from `pre-adr-263-simplification` if a future need re-emerges — but the bet (recorded as the operator's, like ADR-260) is that it won't, because frontier models + Workflows + `/goal` now do it better.
- **Brief/role vocabulary is deleted, not just unused** — `templates/briefs/*` and the role enum go. The flat-pane model has no roles to brief.
- **The prompt-injection surface of ingested git issues is new and unsolved** (D3) — documented as residual risk for a follow-up ADR if the git source is pointed at public repos.
