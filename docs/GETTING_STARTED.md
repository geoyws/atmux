# Getting started with atmux

atmux is a **tmux harness + an optional task feed** ([ADR-263](adr/263-great-simplification-tmux-harness-and-task-feed.md)). It brings up flat Claude panes in a repo, lets you attach / send / tear down, and — if you want — keeps a small task list you pull work from. No daemon, no roles, no fleet brain: every verb is idempotent and you invoke it by hand.

## 1. Install dependencies

```bash
# macOS
brew install tmux jq git

# Ubuntu / Debian
sudo apt install tmux jq git curl
```

Plus the agent TUI you'll drive — atmux ships pointed at [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Because tmux is the IPC (`send-keys` in, `capture-pane` out), any interactive TUI on `PATH` works, but Claude is the supported default.

## 2. Install atmux

```bash
curl -fsSL https://raw.githubusercontent.com/geoyws/atmux/main/install.sh | bash
```

This clones the repo to `~/.atmux-src` and symlinks `bin/atmux` (and the cage-aware `bin/atmux-tmux`) into `/usr/local/bin/`.

## 3. Bring a team up

From your project root:

```bash
cd ~/code/my-project
atmux            # bare atmux == `atmux up`
```

`atmux up` is the one-stop path: wizard-if-new → `doctor` preflight → `start` (if not already running) → `attach`. Re-running it just reattaches — idempotent.

If you prefer explicit verbs:

```bash
atmux init [--name <team>]   # scaffold .atmux/team.json (defaults team name to the dir)
atmux doctor                 # check deps, team.json, TUI on PATH
atmux start                  # create the tmux session + spawn every pane
atmux attach                 # attach to the session
```

`atmux start`:
- Creates tmux session `atmux-<team>` with one window per pane in `team.json`, on a **dedicated cage socket** (not your default tmux server, so it never fights your `~/.tmux.conf`). Cage socket + pinned `atmux.conf` per [ADR-162](adr/162-atmux-owns-tmux-infrastructure.md) / [ADR-018](adr/018-per-team-tmux-socket-isolation.md).
- Launches each pane's TUI in its window.

Panes are **flat** — plain Claude sessions you drive directly. There is no lead / planner / reviewer / committer distinction and no role-brief paste ([ADR-263](adr/263-great-simplification-tmux-harness-and-task-feed.md) §D1).

## 4. team.json — the source of truth

`.atmux/team.json` is just a team name plus a pane list:

```json
{
  "name": "my-project",
  "panes": [
    { "name": "claude-1", "tui": "claude", "cwd": "." },
    { "name": "claude-2", "tui": "claude", "cwd": "." }
  ]
}
```

Edit it by hand, or re-run the wizard against it with `atmux reconfigure`. An optional `taskSources` block configures the git task source (see §6 — planned).

## 5. Drive the panes

Once attached, cycle windows with the cage prefix (`C-\`, then `n` / `p`). To nudge a pane without switching to it:

```bash
atmux send <pane> "<message...>"    # send-keys to one pane
atmux broadcast "<message...>"      # send to every pane
atmux status                        # team / pane overview
```

## 6. The task feed (optional)

The task feed is **opt-in** — the harness above never needs it ([ADR-263](adr/263-great-simplification-tmux-harness-and-task-feed.md) §D6). Tasks live in `.atmux/state.db` (SQLite). The model is one flat list with statuses `todo → in-progress → done | blocked`.

```bash
atmux task add "<subject>" [--body <text>] [--assignee <pane>] [--deps <id,id>]
atmux task list [--status todo|in-progress|done|blocked] [--assignee <pane>]
atmux task show <id>
atmux task move <id> <todo|in-progress|done|blocked>
atmux task update <id> [--body <text>] [--deps <id,id>] [--owner <pane>|--unassign]
```

The work loop is the whole coordination model — a pane (or you) claims a task, works it, marks it done:

```bash
atmux claim <task-id>     # claim a task
atmux done  <task-id>     # mark a claimed task complete
```

There is **no auto-dispatch** — marking a task `done` does not fan out new work or spawn anything. You point a pane at the feed; the pane pulls.

### Git task source (planned — ADR-263 P3)

A second source is planned: `atmux issues sync` will poll a watched git repo and upsert its issues/PRs as tasks (deduped on source id), configured via a `team.json::taskSources` git block. This is **feed-only** — the watcher files tasks; a Claude pane picks them up. It is **not built yet** ([ADR-263](adr/263-great-simplification-tmux-harness-and-task-feed.md) §D3, phase P3).

## 7. Maintenance

```bash
atmux doctor [--fix] [--json]   # deps, team.json schema, TUI on PATH
atmux reconfigure               # re-run the wizard against an existing team.json
atmux cleanup logs              # rotate large *.log files
atmux sync <sub>                # sync derived state (e.g. claude-team-json, ADR-164)
atmux version
atmux help                      # full verb list
```

State on disk under `.atmux/`: `team.json` (panes), `state.db` (tasks), `logs/` (verb-event JSONL audit), `tmux/` (the cage socket). It survives a tmux restart.

## 8. Shut down

```bash
atmux stop
```

Tears down the tmux session and archives state to `.atmux/archive/<timestamp>/`.

## Environment knobs

```bash
ATMUX_DIR    # override the state dir (default: ./.atmux)
ATMUX_TEAM   # override the team name (otherwise read from team.json)
```

## Troubleshooting

- **`atmux: no team.json at …`** — run `atmux init` in the project root.
- **Preflight failed** — `atmux doctor` prints which dep, TUI binary, or config is broken.
- **A pane shows `zsh`, not `claude`** — the TUI didn't launch; check that `claude` is on `PATH` for that pane's cwd, then `atmux start --force`.
- **Messages seem to go nowhere** — the TUI is still on its welcome screen; give it more runway with `ATMUX_SPAWN_WAIT=10 atmux start`.
