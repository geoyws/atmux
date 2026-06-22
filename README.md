# atmux

**atmux** is a tmux harness for coding agents, plus an optional task feed. It brings up N agent panes (Claude, by default) in a repo on a dedicated tmux socket, lets you attach / send keystrokes / tear down — all idempotently, with no daemon — and keeps a simple task list on disk you can point those panes at. State lives in `.atmux/` and survives tmux restarts.

> **Re-scoped 2026-06-19 by [ADR-263](docs/adr/263-great-simplification-tmux-harness-and-task-feed.md)** — "the great simplification." atmux used to be a multi-agent fleet orchestrator (orchd daemon, lanes, epics/stories, cockpit, roles, whip/report, auto-merge, budget, …). That whole coordination layer is **retired**. atmux is now a tmux harness + a task feed, and nothing more. See [What changed](#what-changed-adr-263) and the [PRD](docs/PRD.md).

## What it does (and doesn't)

atmux's scope is exactly three things (ADR-263 §D1):

1. **tmux harness** — idempotent bring-up of agent panes in a repo on a dedicated cage socket, plus attach / send / teardown. Panes are **flat**: plain Claude (or any TUI) sessions you drive. No roles, no role-briefs, no lead/planner/reviewer.
2. **task feed** (optional) — one task list in `.atmux/state.db`, fed two ways: manual `atmux task add` / `claim` / `done`, and a watched-git-repo source (`atmux issues sync`) that turns a repo's issues/PRs into tasks (ADR-263 §D3, feed-only).
3. **the work loop** — a pane runs `atmux claim --next`, works the task, runs `atmux done`. That is the entire coordination model.

It is **not** a fleet orchestrator. There is no daemon, no auto-dispatch, no auto-merge, no cockpit, no budget pause, no agent roles. Frontier 1M-context models, Claude Workflows, and Claude Code's built-in `/goal` / plan-mode / subagents now do the decomposition and autonomous drive the old fleet layer was built for. (ADR-263 §Context.)

Three durable principles (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)):

1. **tmux is the IPC.** `tmux send-keys` writes input; `tmux capture-pane` reads output. Works with any interactive coding-agent TUI; ships pointed at Claude.
2. **State lives on disk.** `state.db` for tasks; `team.json` for the pane list; JSONL for the verb audit log. `.atmux/` survives tmux restart.
3. **No daemon.** Every verb is idempotent and operator-invoked.

## Install

Dependencies: `tmux`, `jq`, `git` (required); `bun` runs the TypeScript entrypoint. The one-shot installer clones to `~/.atmux-src` and symlinks `bin/atmux` + `bin/atmux-tmux` onto your `PATH`:

```bash
curl -fsSL https://raw.githubusercontent.com/geoyws/atmux/main/install.sh | bash
```

Or from a local clone:

```bash
git clone https://github.com/geoyws/atmux.git ~/.atmux-src
~/.atmux-src/install.sh
```

`atmux-tmux` is the cage-aware tmux wrapper (paired binary) so `attach` lands on the right socket without you remembering the raw `tmux -S …` path. Verify the install:

```bash
atmux doctor      # checks deps, team.json, TUI on PATH, state-dir, tmux version
```

## Quickstart

```bash
cd ~/code/my-project

atmux init --name my-team   # scaffold .atmux/team.json + state dirs
atmux start                 # create the tmux session, spawn a window per pane
atmux attach                # tmux attach to the team session
atmux send lead "build a /healthz endpoint with 100% test coverage"
atmux status                # team / pane overview
atmux stop                  # kill the session, archive state
```

Or do it all at once — bare `atmux` (alias for `atmux up`) runs the wizard if new, then `doctor` → `start` → `attach`:

```bash
atmux
```

Optionally drive work through the task feed instead of (or alongside) ad-hoc `send`:

```bash
atmux task add "fix flaky login test" --assignee worker-1
atmux claim --next --as worker-1     # a pane pulls the next claimable task
atmux done <task-id> --as worker-1
```

## Verbs

The full surface (mirror of `atmux help`):

```
Setup:
  up                          Same as bare `atmux`: bring the team all the way up
  init [--name <team>]        Scaffold .atmux/team.json in current dir
  start                       Create the tmux session, spawn all panes
  stop [--force|--soft]       Kill the tmux session, archive state
  attach                      tmux attach to the team session
  status                      Team / pane overview

Panes:
  send <pane> <msg...>        tmux send-keys to a pane
  broadcast <msg...>          Send to every pane

Task feed (optional):
  task add <subject> [--body <text>] [--assignee <pane>] [--deps <id,id>]
  task list [--status todo|in-progress|done|blocked] [--assignee <pane>]
  task show <id>
  task move <id> <todo|in-progress|done|blocked>
  task update <id> [--body <text>] [--deps <id,id>] [--owner <pane>|--unassign]
  claim <task-id>             Claim the next/given task
  done <task-id>              Mark a claimed task complete

Git task source (ADR-263 §D3):
  issues sync [--source <owner/repo>] [--dry-run]
                              Poll team.json::taskSources (GitHub) → upsert
                              matching issues/PRs as tasks (deduped on sourceId)

Maintenance:
  reconfigure                 Re-run the wizard against an existing team.json
  doctor [--fix] [--json]     Check deps, team.json, TUI PATH
  cleanup <logs|all> [--max-size <bytes>] [--max-age-days <N>] [--dry-run]
                              Rotate big *.log files
  sync <sub>                  Sync derived state (e.g. claude-team-json, ADR-164)
  version
  help | --help | -h
```

`claim --next [--as <pane>]` auto-selects the next claimable task (priority ascending, then creation order), skipping tasks with unmet `--deps`. The pane is inferred from `--as`, then `$ATMUX_MEMBER`, then the caller's cwd matched against `team.json`.

The **git task source** (`atmux issues sync`) polls a watched repo's issues/PRs and upserts them as tasks, deduped on the canonical `sourceId` (`github:owner/repo#123`). It is **feed-only** (ADR-263 §D3): the task lands in the feed and a Claude pane (or you) picks it up via `claim --next` — there is no auto-dispatch, no auto-spawn, no lead. See [Git task source](#git-task-source) below.

## team.json

`team.json` is the on-disk source of truth — a team name plus a flat list of panes, with an optional task-sources block. Minimal shape:

```json
{
  "name": "my-team",
  "members": [
    { "name": "worker-1", "tui": "claude", "cwd": "." },
    { "name": "worker-2", "tui": "claude", "cwd": "." }
  ]
}
```

Each pane entry: `name` (window/pane name), `tui` (`claude` ships as default; `shell` for testing), and `cwd` (working dir, relative to the project root or absolute). Panes are flat — there are no roles to assign.

Optional fields:

- `tmuxTmpdir` — puts the team on its own tmux socket (default `/tmp/atmux-tmux_<name>`). See [Tmux topology](#tmux-topology).
- `tuiCommands` — per-team launch-command overrides keyed by TUI name, e.g. `{ "claude": "claude --plugin-dir=…" }`. A per-pane `command` field overrides everything for that pane.
- `taskSources` — git sources `atmux issues sync` polls (ADR-263 §D3). An array of `{ provider: "github", scope: "owner/repo", labels?: [...], state?: "open"|"closed"|"all", onClose?: "done"|"leave", lane?, priority?, token? }`. See [Git task source](#git-task-source).

## Task feed

The task feed is a single `tasks` table in `.atmux/state.db` (SQLite, WAL). It is **optional** (ADR-263 §D6): `init` / `start` / `attach` / `send` / `stop` never require any task state, and `doctor` does not red-flag a team for having zero tasks.

- **Statuses:** `todo → in-progress → done | blocked`.
- **Add:** `atmux task add <subject> [--body …] [--assignee …] [--deps id,id] [--priority N]`.
- **Pull:** `atmux claim --next --as <pane>` selects by `priority asc, createdAt asc`, skipping tasks whose deps aren't `done`. `atmux claim <id>` claims a specific task.
- **Complete:** `atmux done <id> --as <pane>`.
- **Inspect / edit:** `atmux task list`, `task show <id>`, `task move <id> <status>`, `task update <id> …`.

Tasks are plain data — `done` has no side effects beyond the status flip. There is no auto-dispatch, no commit-task fan-out, no epic/story machinery.

## Git task source

`atmux issues sync` turns a watched repo's issues/PRs into tasks (ADR-263 §D3). It is **feed-only** — the poller files tasks; a Claude pane (or you) works them via `claim --next`. No auto-dispatch, no auto-spawn, no lead, no write-back to the tracker.

Configure sources under `team.json::taskSources`:

```json
{
  "name": "my-team",
  "members": [ { "name": "worker-1", "tui": "claude", "cwd": "." } ],
  "taskSources": [
    {
      "provider": "github",
      "scope": "owner/repo",
      "labels": ["bug"],
      "state": "open",
      "onClose": "done",
      "lane": "be",
      "priority": 2
    }
  ]
}
```

- `provider` — `github` (the only adapter today; the seam is vendor-agnostic).
- `scope` — `owner/repo`.
- `labels` — optional; only issues carrying **all** of these labels (GitHub's native `labels` AND filter). Omit for all matching-state issues + PRs.
- `state` — `open` (default), `closed`, or `all`. Use `all` if you want close reconciliation.
- `onClose` — `done` (default) moves a still-`todo` task to `done` when its issue closes upstream (needs `state: "all"`/`"closed"` to see closes); never yanks an in-progress task. `leave` never auto-mutates.
- `lane` / `priority` — optional stamps applied to created tasks.
- `token` — optional GitHub token literal (prefer the env var or file below).

Run it by hand or from cron (no daemon):

```bash
atmux issues sync                 # poll every configured source
atmux issues sync --source owner/repo   # just one
atmux issues sync --dry-run       # fetch + report counts, write nothing
```

Each issue/PR upserts a task deduped on its canonical `sourceId` (`github:owner/repo#123`) — re-polls update the same row, never duplicate. A per-source watermark (stored in `state_kv`) makes subsequent polls incremental.

**GitHub token** (optional — public repos work unauthenticated at 60 req/hr; a token raises the limit + reads private repos). Resolution order: `ATMUX_GITHUB_TOKEN` env var → `team.json::taskSources[].token` literal → `~/.config/atmux/github-token` file. Tokens are never passed on argv. A read-only fine-grained token (Issues: read) is sufficient.

> **Prompt-injection note (ADR-263 §D3):** public issue/PR bodies are attacker-controllable text that flows into task bodies a Claude pane reads. The body is fenced under an explicit "UNTRUSTED" banner — treat it as data, not instructions. This is a documented residual risk, not a solved one.

## Tmux topology

Per [ADR-162](docs/adr/162-atmux-owns-tmux-infrastructure.md) + ADR-018 (cage-tier isolation), each team runs on a **dedicated cage socket** — not your daily-driver `~/.tmux.conf` tmux server. The session loads a canonical `templates/tmux/atmux.conf` via `tmux -f`, so it won't fight your personal config, and a buggy `kill-session` in one team can't reach unrelated sessions.

- **Socket:** path-explicit per team — `tmuxTmpdir` (default `/tmp/atmux-tmux_<team>`), or the in-repo cage dir under `.atmux/tmux/`.
- **Session:** `atmux-<team>`, one window per pane.
- **Attach:** `atmux attach` (resolves the socket for you) or the `atmux-tmux` wrapper. Bare `tmux attach` will not reach a caged team.

The cage server uses a `C-\` prefix so the nested cage tmux inside `atmux attach` doesn't collide with your outer-tmux prefix.

## Configuration

`team.json` is the primary configuration surface. A few environment variables tune the harness:

| Variable | Effect |
|----------|--------|
| `ATMUX_DIR` | Override the state dir (default `./.atmux`, walked up). |
| `ATMUX_TEAM` | Override the team name (otherwise read from `team.json`). |
| `ATMUX_MEMBER` | Default pane name for `claim` / `done` when `--as` is omitted. |
| `ATMUX_GITHUB_TOKEN` | GitHub token for `issues sync` (optional; raises the rate limit + reads private repos). |
| `ATMUX_CLAUDE_BIN` / `ATMUX_TMUX_BIN` | Override the resolved `claude` / `tmux` binaries. |
| `ATMUX_SPAWN_TIMEOUT_MS` | Bump the tmux/buffered-spawn timeout (default 30s) for slow cold starts. |
| `ATMUX_GIT_TIMEOUT_MS` | Bump the git-wrapper timeout (default 30s) for large packs / cold submodules. |
| `ATMUX_DEBUG` | Print the full error cause-chain on failures. |

Exit codes follow BSD sysexits (ADR-006): `64` usage error, `78` config error, `75` timeout, etc.

## State layout

```
.atmux/
├── team.json          # source of truth — team name + flat pane list (+ optional taskSources)
├── state.db           # SQLite — the task feed
├── logs/              # verb-event JSONL audit log + per-pane send logs
├── tmux/              # per-team cage socket dir (ADR-162 / ADR-018)
└── archive/<ts>/      # created on `atmux stop`
```

## What changed (ADR-263)

atmux was cut from ~280 source files to ~61. Removed entirely: the `atmux-orchd` daemon and its consumers (auto-merge, auto-push, auto-spawn, watchdogs), the Honker in-DB messaging substrate, lanes, epics/stories/epic-teams/mergers, the cockpit, whip/poke/report/pulse/heartbeat, refusal-scan/rotation, budget/cost/account-pool, member roles + role-briefs, the discorder/complaints/ombudsman machinery, and the vendor-agnostic `AgentBackend` / OpenCode-plugin / Rust-daemon direction (ADR-263 §D5, supersedes ADR-258 / ADR-262).

What stayed: the tmux harness (the one piece nothing else replaces), the optional pull-kanban task feed (ADR-007, now off the critical path), `state.db` as the task store (ADR-126), `up` (ADR-006), `doctor` (ADR-005), and the cage-socket topology (ADR-162 / ADR-018). The fleet brain is recoverable from the `pre-adr-263-simplification` git tag if a future need re-emerges.

## Docs

- [docs/PRD.md](docs/PRD.md) — product vision
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — harness spine + tmux topology
- [docs/adr/263-great-simplification-tmux-harness-and-task-feed.md](docs/adr/263-great-simplification-tmux-harness-and-task-feed.md) — the simplification decision
- [docs/adr/INDEX.md](docs/adr/INDEX.md) — ADR index
- [CHANGELOG.md](CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).
