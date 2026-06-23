# atmux — Product Requirements Document

> **Status:** living document. **Re-scoped 2026-06-19 by [ADR-263](adr/263-great-simplification-tmux-harness-and-task-feed.md)** — "the great simplification." atmux was cut from a multi-agent fleet orchestrator down to a **tmux harness + a git/sqlite task feed**. The fleet-coordination layer (orchd, lanes, epics, cockpit, whip, auto-merge, roles, …) is retired per ADR-263 §D4; the staged cut (ADR-263 §D7, phases P0–P4) and the git task source (P3) have **landed** — `src/` is down to the lean keep-set. Where this PRD and an ADR diverge, **the ADR wins**.
>
> **Lineage:** this completes the retreat begun by [ADR-260](adr/260-manual-orchestration-mode-default.md) (manual mode default). The pre-2026-06-19 PRD (the fleet-orchestrator vision) is preserved in git history.

---

## 1. Vision

### 1.1 Problem

A solo operator running coding agents (Claude Code, primarily) in a project wants two things from their terminal:

1. **A deterministic way to bring up and drive agent panes** in a repo — start them, attach, send keystrokes, tear down — that survives tmux restarts and doesn't fight their `~/.tmux.conf`.
2. **A feed of work to point those agents at** — bugs and PRs from a watched git repo, plus ad-hoc tasks they jot down themselves.

What they do **not** need anymore is a coordination brain. Frontier models with 1M-context windows, Claude Workflows, and Claude Code's built-in `/goal` / plan-mode / subagents now do the decomposition, fan-out, and autonomous drive that atmux's fleet layer was built to provide. That layer (≈100k LOC, ≈70 verbs) is now overhead. (ADR-263 §Context.)

### 1.2 Solution

**atmux** is a tmux-native agent harness. It does exactly three things (ADR-263 §D1):

1. **tmux harness** — idempotent bring-up of N agent panes in a repo on a dedicated cage socket with a pinned `atmux.conf`; attach / send / teardown. Panes are **flat** — plain Claude (or any TUI) sessions the operator drives. No roles, no role-briefs.
2. **task feed** — one task list in `.atmux/state.db` (SQLite), fed by two sources:
   - **sqlite** — manual `atmux task add` / `claim` / `done` (the pull-kanban, kept but **optional**).
   - **git** — `atmux issues sync` polls a watched repo's issues/PRs and upserts them as tasks.
3. **the work loop** — a pane runs `atmux claim --next`, works the task, runs `atmux done`. That is the entire coordination model.

Three durable principles (see `docs/ARCHITECTURE.md`):

1. **tmux is the IPC.** `tmux send-keys` writes input; `tmux capture-pane` reads output. Works with any interactive coding-agent TUI; ships pointed at Claude. (ADR-263 §D5 re-commits to this; supersedes the ADR-258/262 programmatic-backend direction.)
2. **State lives on disk.** `state.db` for tasks; `team.json` for the pane list; JSONL for the verb audit log. `.atmux/` survives tmux restart.
3. **No daemon.** Every verb is idempotent and operator-invoked. There is no orchd, no cron LLM cycle, no background process.

### 1.3 Why now

See ADR-263 §Context. In short: 1M-context fast models + Workflows + Claude Code `/goal` made the fleet brain redundant; the operator's verdict was "atmux is way too fat." The harness — the one piece nothing else replaces — stays; the brain goes.

---

## 2. Audience + use cases

### 2.1 Solo operator triaging a watched repo

The operator configures a `taskSources` git entry pointing at `owner/repo` with a label filter. `atmux issues sync` (run by hand or a simple cron) turns matching issues/PRs into tasks. The operator brings up a Claude pane with `atmux up`, and the pane (or the operator) pulls work via `atmux claim --next`, fixes the bug / reviews the PR, and marks it `done`. No lead, no planner, no auto-dispatch — **feed-only** (ADR-263 §D3).

### 2.2 Solo operator running ad-hoc parallel agents

The operator wants three Claude panes in a repo for parallel exploration. `team.json` lists three panes; `atmux start` brings them up in a dedicated tmux session; `atmux attach` drops in; `atmux send <pane> "<text>"` nudges one without switching windows. Tasks optional — atmux is just managing the tmux setup ("manage my tmux setup to run things").

### 2.3 Non-goals (ADR-263)

- **Fleet coordination.** No orchd, lanes, epics, stories, reviewers, committers, auto-merge, auto-spawn, rotation, watchdogs, budget-pause, cockpit. Retired per ADR-263 §D4.
- **Vendor-agnostic backends / daemon.** No `AgentBackend` abstraction, no OpenCode plugin, no Rust daemon. One path: tmux + Claude (ADR-263 §D5, supersedes ADR-258/262).
- **Cross-host coordination.** Single tmux server = single host.
- **Hosted service / web UI / accounts.** Local CLI only.
- **Upstream write-back to the issue tracker.** The git source is read-only ingestion (ADR-261 §Out-of-scope, unchanged).

---

## 3. Scope (target surface per ADR-263 §D2)

### 3.1 Verbs (keep-set)

| Bucket | Verbs |
|--------|-------|
| Lifecycle | `up` / `init` / `start` / `stop` / `attach` / `status` |
| Panes | `send` / `broadcast` |
| Maintenance | `cleanup` / `reconfigure` / `doctor` (slim: tmux + team + task-feed probes) / `version` / `help` / `sync` |
| Task feed (optional) | `task add/list/show/move` / `claim` / `done` |
| Git task source | `issues sync` (re-pointed ADR-261 → tasks, ADR-263 §D3) |

Everything else in the current dispatcher (`src/cli.ts`) is cut per ADR-263 §D4 (P1–P2).

### 3.2 TUI matrix

| TUI | Binary | Default model |
|-----|--------|---------------|
| `claude` | `claude` | Claude Code default (Opus) |
| `shell` | `$SHELL` | (testing only) |

atmux ships pointed at Claude; the tmux-is-IPC principle means any interactive TUI works, but the multi-TUI preset/worker matrix (cursor/opencode/kimi/minimax tiers) is retired with the fleet layer.

### 3.3 State layout (target)

```
.atmux/
├── team.json          # source of truth — team name + pane list (drivers[]/members[] collapse to flat panes)
├── state.db           # SQLite — the task feed (ADR-060/126). Tasks only; epics/stories tables + tasks.epic/story columns dropped by migration v18 (ADR-264); complaints/inboxes/merger-state tables dropped.
├── logs/              # verb-event JSONL audit (events-log.ts) + per-pane send logs
├── tmux/              # per-team cage socket dir (ADR-018/162)
└── archive/<ts>/      # created on atmux stop
```

Dropped vs. the fat layout: `kanban.json` legacy, inboxes, driver-inbox / lead-outbox / lead-queue, decisions / flags, budget-pause / pulse / cron-migration state, sockets/ (Honker), and the epic/story/complaint/merger DB tables.

### 3.4 Configuration

`team.json` is the on-disk source of truth — a name plus a pane list, plus optional `taskSources` (git) per ADR-263 §D3. Environment knobs documented in `README.md`. The fleet config sub-blocks (`whip` / `report` / `autoMerge` / `orchestration` / `leadStallWatchdog` / `discord` / `issueSync`-as-complaints) are retired or re-documented as the cut lands.

---

## 4. Architecture

The harness spine: `up` → wizard-if-new → `doctor` preflight → `start` (idempotent session + one window per pane on the cage socket) → `attach`. See `docs/ARCHITECTURE.md` §Tmux topology (ADR-162/018). `send` / `broadcast` write to panes via verified `send-keys`. `stop` tears down + archives.

The task feed: `state.db` holds a single `tasks` table (`todo → in-progress → done | blocked`). `claim --next` selects by `priority asc, createdAt asc`, skipping tasks with unmet deps. `issues sync` upserts git issues/PRs as tasks, deduped on `sourceId` (ADR-263 §D3). No auto-dispatch side-effects on `done` — the fan-out/commit-task machinery of the old kanban (ARCHITECTURE.md §Auto-dispatch) is retired.

---

## 5. Roadmap

Per ADR-263 §D7 — the decision was recorded first; the cut landed in reviewable phases, recoverable via the `pre-adr-263-simplification` git tag.

| Phase | Deliverable | Status |
|-------|-------------|--------|
| **P0 — decision** | ADR-263 + this PRD rewrite + INDEX row + ADR-261 re-point banner | ✅ landed |
| **P1 — unwire** | Drop cut verbs from `cli.ts` + `help`; stop orchd/cockpit spawn in `start`; stop role-brief paste; collapse panes to flat | ✅ landed |
| **P2 — delete** | Remove cut `src/verbs/*`, `src/core/*`, `rust/*`, `plugins/*`, `templates/briefs/*`, tests, RUNBOOKs, dead schema; move superseded ADR rows in INDEX | ✅ landed (`src/` 282→61 files) |
| **P3 — git source** | Implement `issues sync → task` (github adapter → tasks table; drop complaints path) | ✅ landed (`issues sync`, sqlite v17, feed-only) |
| **P4 — docs sweep** | ARCHITECTURE.md / README.md / GETTING_STARTED.md / CHANGELOG.md reflect lean surface | ✅ landed |

The P1–P2 cut was executed via a Claude Workflow (fan-out deletion across independent file sets; typecheck + tests green per phase); P3 was a coherent inline feature build.

---

## 6. Quality gates

Unchanged in spirit (CLAUDE.md test discipline): `bun typecheck`, `bun test --coverage` (100% on touched tracked paths), `biome lint` + `format`, conventional commits, no silent error swallows, schema-validated I/O, ADR-pointer on documented-surface changes. The parity harness (bash↔TS, ADR-119/120) is retired with the bash legacy. e2e narrows to the harness lifecycle (`start`/`stop`/`attach`/`send`) + the task feed (`task`/`claim`/`done`/`issues sync`).

---

## Appendix A: Cross-reference index

| Topic | Source of truth |
|-------|-----------------|
| The simplification decision | [ADR-263](adr/263-great-simplification-tmux-harness-and-task-feed.md) |
| Manual-mode lineage | [ADR-260](adr/260-manual-orchestration-mode-default.md) |
| Git task source (seam) | [ADR-261](adr/261-issue-sync-external-tracker-ingestion.md) (re-pointed) + `src/abstractions/issue-tracker.ts` |
| tmux infra / topology | [ADR-162](adr/162-atmux-owns-tmux-infrastructure.md) + `docs/ARCHITECTURE.md` |
| Task store | [ADR-060/126](adr/126-sqlite-state-store.md) |
| Verbs reference | `README.md` "Commands" |
| Configuration env vars | `README.md` "Configuration" |
| ADR index | `docs/adr/INDEX.md` |
| CHANGELOG | `CHANGELOG.md` |

---

## Appendix B: PRD update protocol

Living doc. Update on every commit-chain that changes behavior; small `docs(prd):` commits alongside the feature; reviewer-gated. PRD's job is the **map**, not the territory — cross-reference the canonical ADR/README rather than duplicating it. During the ADR-263 cut, update §3 + §5 as each phase (P1–P4) lands.
