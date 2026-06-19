# atmux architecture

> **Re-scoped 2026-06-19 by [ADR-263](adr/263-great-simplification-tmux-harness-and-task-feed.md)** — "the great simplification." atmux is a **tmux harness + an optional task feed**, nothing more. The fleet-coordination layer (orchd daemon, Honker messaging, cockpit, lanes, epics/stories, roles + briefs, whip/report/pulse/watchdog, auto-merge, budget, refusal-rotation, complaints/ombudsman, the AgentBackend/opencode-daemon direction) is retired per ADR-263 §D4. This document describes the lean surface only. Where it and an ADR disagree, the ADR wins.

## Principles (ADR-263 §D1, §D5)

1. **tmux is the IPC.** atmux speaks no AI-provider API. It writes input to a pane via `tmux send-keys` and reads output via `tmux capture-pane`. That means it works with *any* interactive coding-agent TUI; it ships pointed at Claude. (ADR-263 §D5 re-commits to this and supersedes the ADR-258/262 programmatic-backend direction.)
2. **State lives on disk.** `state.db` (SQLite, WAL — [ADR-060](adr/126-sqlite-state-store.md)) holds the task feed; `team.json` holds the team name + flat pane list; JSONL under `logs/` is the append-only verb-event audit. `.atmux/` survives tmux restart.
3. **No daemon.** Every verb is idempotent and operator-invoked. No orchd, no cron LLM cycle, no background process. The operator (and the Claude panes they run) own all coordination.

## Flat panes (ADR-263 §D1)

Panes are **flat**: plain Claude (or any TUI) sessions the operator drives. There are no `lead` / `planner` / `reviewer` / `committer` roles, no role-briefs, no driver-vs-member distinction. `team.json` is just a name plus a list of panes; `atmux start` brings up one tmux window per pane. The harness (`up` / `start` / `stop` / `attach` / `send` / `broadcast`) never requires any task state (ADR-263 §D6).

## Tmux topology

Per [ADR-162](adr/162-atmux-owns-tmux-infrastructure.md) + [ADR-018](adr/018-per-team-tmux-socket-isolation.md), atmux owns its tmux infrastructure and never clobbers the operator's default tmux:

- **Cage socket.** Every team operation runs through a dedicated per-team socket at `tmux -S <team-root>/.atmux/tmux/tmux-0/default` (cage-tier isolation, ADR-018). Operations against `team-foo` cannot touch a session belonging to `team-bar` or to the operator's personal tmux server. Session name: `atmux-<team>`. The operator views the panes with plain `tmux attach` (or `atmux attach`).
- **Pinned conf.** Every session is created with `-f <atmux.conf-path>` resolved by `getAtmuxTmuxConfPath()` in `src/core/tmux-paths.ts`; the operator's `~/.tmux.conf` is never loaded. Default: `templates/tmux/atmux.conf` (installed under `/opt/atmux/<version>/templates/`). Operator override: `ATMUX_TMUX_CONF=<path>`. The baseline (ADR-162 §Decision-anchor #3) sets `status on`, `mouse on`, `history-limit 100000` (capture-pane scrollback), `default-terminal tmux-256color`, `allow-rename off` + `automatic-rename off`, `base-index 1`, `escape-time 50`, and keeps the default `C-b` prefix.
- **Version probe.** `doctor` warns on tmux below min 3.2 or above the tested-against 3.6a — the `capture-pane` / `display-message` formats atmux relies on have drifted across tmux 3.x.

## Task feed (optional — ADR-263 §D2, §D6)

The task feed is opt-in: the harness works with zero tasks, and `doctor` does not red-row a team for having none. When used, one `tasks` table in `state.db` is the source of truth.

**Task shape** (`todo → in-progress → done | blocked`):

```
id        t-…            uuidv7
subject   string         short title
body      string         detail (issue body + URL for git-sourced tasks)
status    todo|in-progress|done|blocked
owner     pane | null    who claimed it
deps      [t-…]          unmet deps filter the task out of `claim --next`
priority  int            lower = sooner
createdAt / claimedAt? / completedAt? / note?
```

**The work loop** is the entire coordination model (ADR-263 §D1): a pane runs `atmux claim --next`, works the task, runs `atmux done`. `claim --next` selects by `priority asc, createdAt asc`, skipping any task whose `deps` are not all `done`; the claim is atomic (flips `owner`/`status`/`claimedAt` only if `owner` is still `null` post-read, race-aware with retries). **There are no auto-dispatch side-effects on `done`** — the fan-out/commit-task/story-flip machinery of the old kanban is gone (ADR-263 §D4). Task CRUD lives in `src/core/kanban.ts`; the `task` / `claim` / `done` verbs route through it with no inbox or member-status coupling.

### Git task source — planned (ADR-263 P3)

A second feed source is **planned, not yet built**: `atmux issues sync` will poll a watched git repo's issues/PRs and upsert each as a task. The ingestion seam exists today (`src/abstractions/issue-tracker.ts` — the types-only vendor-agnostic `IssueTracker` interface from [ADR-261](adr/261-issue-sync-external-tracker-ingestion.md)); ADR-263 §D3 re-points its **output** from the (now-deleted) complaints path to the task table. Contract: `poll → upsert Task`, deduped on `sourceId` (e.g. `github:owner/repo#123`); provenance (`sourceKind` / `sourceId`) is carried on the task row; config under `team.json::taskSources` (`{ provider, scope, labels, state, pollIntervalMins }`); HTTP via `http.ts`. **Feed-only** — no complaints, no Honker, no lead, no auto-dispatch; a Claude pane picks the task up via `claim --next`. No write-back to the tracker. Polling is operator/cron-invoked; there is no daemon.

> **Residual risk (ADR-263 §D3):** ingested public issue/PR bodies are attacker-controllable text that flows into task bodies a Claude pane will read. The body is data, not instructions — documented, not solved.

## State layout

```
.atmux/
├── team.json          # source of truth — team name + flat pane list
├── state.db           # SQLite — the task feed (ADR-060/126). Tasks only.
├── logs/              # verb-event JSONL audit (events-log.ts) + per-pane send logs
├── tmux/              # per-team cage socket dir (ADR-018/162)
└── archive/<ts>/      # created on `atmux stop`
```

## Verb surface (ADR-263 §D2)

The complete dispatcher (`src/cli.ts`); `atmux help` prints the canonical usage.

| Bucket | Verbs |
|--------|-------|
| Lifecycle | `up` (bare `atmux` alias) · `init` · `start` · `stop` · `attach` · `status` |
| Panes | `send` · `broadcast` |
| Task feed (optional) | `task add/list/show/move/update` · `claim` · `done` |
| Maintenance | `reconfigure` · `doctor` · `cleanup` · `sync` ([ADR-164](adr/164-sync-claude-team-json.md) claude-team-json) · `version` · `help` |

Unknown verbs throw `UsageError` → exit 64 (EX_USAGE). The git task source (`issues sync`) is planned for ADR-263 P3 and is not in the dispatcher yet.

## Why `tmux send-keys` and not SDK API calls?

- **Works with any TUI** — no dependence on a model-provider SDK. Whatever interactive coding-agent TUI the operator runs just gets shell input.
- **Zero drift between human + agent view** — what atmux sees is exactly what the human sees in `tmux attach`.
- **No auth plumbing** — whatever auth the TUI itself uses, atmux inherits for free.
- **Robust to provider outages** — atmux never holds an API session that can expire mid-run.

## Non-goals (ADR-263 §2.3)

- **Fleet coordination.** No orchd, lanes, epics, stories, reviewers, committers, auto-merge, auto-spawn, rotation, watchdogs, budget-pause, cockpit.
- **Vendor-agnostic backends / daemon.** No `AgentBackend` abstraction, no OpenCode plugin, no Rust daemon. One path: tmux + Claude (ADR-263 §D5, supersedes ADR-258/262).
- **Cross-host coordination.** Single tmux server = single host.
- **Hosted service / web UI / accounts.** Local CLI only.
- **Upstream write-back to the issue tracker.** The planned git source is read-only ingestion.
