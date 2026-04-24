# atmux

> 🎮 **Driver** (you) → 🦅 **Team Lead** → 🐜 **Team Members** — coordinated through tmux, not an API.

A tmux-native multi-TUI agent orchestrator. Runs a fleet of coding-agent terminals (Claude Code, Cursor, OpenCode, Kimi) in parallel, with a kanban task board, per-member inboxes, a 5-minute whip watchdog, and a 30-minute progress digest to Discord.

**Why not just Claude Code everywhere?** Because Claude is expensive and not every task needs it. With atmux, the **team-lead, reviewer, git-committer, and devops stay on Claude** (they need the reasoning), while **workers can be Cursor Composer 2, MiniMax, or Kimi** for cheaper parallel throughput. The driver (you, in a Claude Code REPL) talks to the lead; the lead dispatches to workers.

## How it works

```
┌───────────────────────────────────────────────────────────────────┐
│ Your terminal (the driver) — your Claude Code / shell             │
│                                                                    │
│     atmux tell-lead "implement auth flow, see RFC-12"             │
│     atmux status                                                   │
│     atmux report                                                   │
└──────────────┬────────────────────────────────────────────────────┘
               │ tmux send-keys
               ▼
┌───────────────────────────────────────────────────────────────────┐
│ tmux session: atmux-<team>                                         │
│                                                                    │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐      │
│  │ 🦅 lead    │ │ 🔍 reviewer│ │ 📝 gitter  │ │ ⚙️  devops │      │
│  │ claude     │ │ claude     │ │ claude     │ │ claude     │      │
│  └─────┬──────┘ └────────────┘ └────────────┘ └────────────┘      │
│        │ tmux send-keys                                            │
│        ▼                                                           │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐                     │
│  │ 🐜 cursor-1│ │ 🐜 kimi-1  │ │ 🐜 minimax │                     │
│  │ cursor-agt │ │ kimi       │ │ opencode   │                     │
│  └────────────┘ └────────────┘ └────────────┘                     │
│                                                                    │
│  shared state: .atmux/{team.json,kanban.json,inboxes/,logs/}       │
└───────────────────────────────────────────────────────────────────┘
               │ every 5 min                     every 30 min
               ▼                                 ▼
         atmux whip                        atmux report
         (stale panes? rate limits?)       (Discord digest)
```

## Quickstart

```bash
# 1. Install
curl -fsSL https://raw.githubusercontent.com/geoyws/atmux/main/install.sh | bash

# 2. In your project — any command offers the wizard on first run:
cd ~/code/my-project
atmux start                  # 🧙 no team.json yet? atmux will offer to run the wizard
# …or do it explicitly:
atmux init --wizard          # interactive setup
atmux init                   # defaults (7-member template)

# 3. Launch the team:
atmux start
atmux attach                  # (optional) tmux attach to watch
atmux status

# 4. Kick things off via the lead:
atmux tell-lead "build a /healthz endpoint with 100% test coverage"

# 5. Automate the watchdog (cron):
crontab -e
# */5 * * * *  cd ~/code/my-project && /usr/local/bin/atmux whip  >> .atmux/logs/cron.log 2>&1
# */30 * * * * cd ~/code/my-project && /usr/local/bin/atmux report >> .atmux/logs/cron.log 2>&1

# 6. When done:
atmux stop
```

## TUIs supported

| TUI         | Binary            | Default model                           | Switchable? |
|-------------|-------------------|------------------------------------------|-------------|
| `claude`    | `claude`          | (Claude Code default — Opus / Sonnet)   | yes, via `--model` on launch |
| `opencode`  | `opencode`        | `minimax-coding-plan/MiniMax-M2.7-highspeed` | yes, per-member `model` |
| `kimi`      | `kimi`            | `kimi-latest`                            | yes, per-member `model` |
| `cursor`    | `cursor-agent`    | `composer-2`                             | yes, per-member `model` |
| `shell`     | `$SHELL`          | —                                         | for testing only |

### 🎛️ Custom launch commands

The built-in defaults are just *defaults*. You can plug in any shell alias,
wrapper script, or entirely custom TUI via the `tuiCommands` map in
`team.json`:

```json
{
  "tuiCommands": {
    "claude":       "claude --plugin-dir=$HOME/work/journals/.sb/claude-skills",
    "claude-fresh": "claude",
    "claude-heavy": "CLAUDE_CODE_EFFORT_LEVEL=xhigh claude --model claude-opus-4-7",
    "opencode":     "opencode --model minimax-coding-plan/MiniMax-M2.7-highspeed"
  },
  "members": [
    { "name": "lead",     "tui": "claude-heavy", "role": "team-lead" },
    { "name": "reviewer", "tui": "claude-fresh", "role": "reviewer"  }
  ]
}
```

Resolution order (highest priority first):
1. **`member.command`** — full override. Used verbatim, with `cd <cwd> &&` prepended.
2. **`team.tuiCommands[<tui>]`** — per-team launch prefix. atmux appends `--model <model>` unless the prefix already has `--model`.
3. **Built-in default** — from `lib/tui.sh` (`claude`, `opencode`, `kimi`, `cursor`, `shell`).

The wizard asks for each of these during `atmux init --wizard` and tries to
detect existing shell aliases (`claude='command claude --plugin-dir=…'`) as
proposed defaults.

### 🧑‍✈️ Non-Claude lead

Nothing forces Claude to be the lead. Example — OpenCode as `team-lead` to
keep coordination turns cheap, Claude only for reviewer / gitter:

```bash
cp examples/opencode-lead-team.json .atmux/team.json
atmux start
```

See `examples/` for more patterns.

Default role→TUI mapping:

| Role              | Default TUI | Reason                                        |
|-------------------|-------------|-----------------------------------------------|
| `team-lead`       | `claude`    | Coordination + judgment — needs Opus          |
| `reviewer`        | `claude`    | Quality gate — needs Opus                     |
| `git-committer`   | `claude`    | Commit msg + hooks discipline                 |
| `devops`          | `claude`    | Infra judgment calls                          |
| `member`          | any         | Parallel throughput — pick cheapest that works |

## Commands

```
🏁 Setup
atmux init [--wizard] [--force] [--name <team>]
atmux start [--force]
atmux stop [--force] [--no-archive]
atmux attach
atmux status [--json]

💬 Messaging
atmux send <member> <msg...>
atmux broadcast <msg...>
atmux tell-lead <msg...>                    # driver → lead (driver-inbox.md)
atmux reply <msg...>                        # member → driver (lead-outbox.md)
atmux outbox [--ack] [--json]               # driver reads lead-outbox

📋 Task board
atmux task add <subject> [--body <txt>] [--assignee <m>] [--deps <id,id>] [--priority <n>]
atmux task list [--status …] [--assignee <m>] [--json]
atmux task show <id>
atmux task move <id> <todo|in-progress|done|blocked>
atmux task assign <id> <member>
atmux task rm <id>

📨 Dispatch / work
atmux dispatch <member> <task-id> [--no-ping]   # blocked if deps unresolved
atmux inbox <member> [--json]
atmux claim <task-id> [--as <member>]            # blocked if deps unresolved
atmux done  <task-id> [--as <member>] [--note <text>]

💰 Cost + budgets
atmux cost [--member <m>] [--since <ts>] [--json]
atmux pause <member>                         # dispatch/claim refuse
atmux resume <member>

🤖 Automation
atmux whip                                   # 5-min watchdog (cron)
atmux report [--no-discord]                  # 30-min digest (cron)

🔧 Maintenance
atmux rotate <member>
atmux rotate-lead
atmux handoff <from> <to> [--reason <r>] [--no-native] [--pause-from]
atmux add-member <name> --role <r> --tui <t> [--model <m>] [--cwd <d>] [--command <c>]
atmux reconfigure                            # re-run wizard on existing team
atmux dashboard [--interval <s>]             # live full-screen panel
```

## State layout

Everything lives in `.atmux/` at the project root (or wherever `ATMUX_DIR` points):

```
.atmux/
├── team.json              # source of truth: members, roles, TUIs, models
├── kanban.json            # shared task board
├── driver-inbox.md        # driver → lead asks (markdown, greppable)
├── inboxes/
│   ├── lead.json
│   ├── reviewer.json
│   └── …                  # {pending, inProgress, done}
├── logs/
│   ├── send-<member>.log
│   ├── whip.log
│   └── report.log
├── state/
│   ├── session-start.txt  # epoch seconds; used by whip for lead uptime
│   └── last-report.epoch
└── archive/<timestamp>/   # created on atmux stop
```

## Configuration (environment variables)

| Var                                  | Default                                      | Purpose                                             |
|--------------------------------------|----------------------------------------------|-----------------------------------------------------|
| `ATMUX_DIR`                          | `$PWD/.atmux` (walked up)                    | Override state dir                                  |
| `ATMUX_TEAM`                         | `.name` in `team.json`                       | Override team name                                  |
| `ATMUX_NO_WIZARD`                    | (unset)                                      | Set to `1` to suppress the first-run wizard prompt  |
| `ATMUX_SESSION`                      | `atmux-<team>`                               | Override tmux session name                          |
| `ATMUX_DISCORD_WEBHOOK`              | (unset → falls back to `DISCORD_WHIP_WEBHOOK`) | Discord webhook for whip/report                     |
| `ATMUX_STALE_MIN`                    | `30`                                         | `atmux whip`: flag in-progress tasks older than this |
| `ATMUX_LEAD_MAX_MIN`                 | `60`                                         | `atmux whip`: recommend `rotate-lead` after this     |
| `ATMUX_SPAWN_WAIT`                   | `6`                                          | seconds to wait after spawning before pasting brief |
| `ATMUX_CLAUDE_EFFORT`                | `xhigh`                                      | `CLAUDE_CODE_EFFORT_LEVEL` per member               |
| `ATMUX_CLAUDE_PERMISSION`            | `dontAsk`                                    | Claude Code `--permission-mode`                     |
| `ATMUX_OPENCODE_DEFAULT_MODEL`       | `minimax-coding-plan/MiniMax-M2.7-highspeed` | Default `--model` for OpenCode TUIs                 |
| `ATMUX_KIMI_DEFAULT_MODEL`           | `kimi-latest`                                | Default `--model` for Kimi                          |
| `ATMUX_CURSOR_DEFAULT_MODEL`         | `composer-2`                                 | Default `--model` for Cursor                        |
| `ATMUX_CURSOR_BIN`                   | `cursor-agent`                               | Cursor CLI binary                                   |
| `ATMUX_KIMI_BIN`                     | `kimi`                                       | Kimi CLI binary                                     |

## Dependencies

- `tmux` (≥ 3.0)
- `jq`
- `bash` (≥ 4.0) — macOS ships 3.2, use homebrew bash
- `git`
- `curl` (only if you want Discord webhook pings)
- Whatever TUIs you declare: `claude`, `opencode`, `kimi`, `cursor-agent`

## 💰 Cost tracking + budgets

atmux parses `~/.claude/projects/<slug>/<uuid>.jsonl` for assistant-message
`usage` blocks, sums them against a pricing table, and attributes per member
by `cwd`. Configure in `team.json`:

```json
"budget": {
  "total": 25.00,
  "perMember": 5.00,
  "currency": "USD",
  "overrunPolicy": "failover"
}
```

- **`warn`** — whip logs + Discord-pings only.
- **`pause`** — whip also calls `atmux pause <member>`; `dispatch`/`claim` refuse.
- **`failover`** — whip additionally tries `atmux handoff <exhausted> <peer>`,
  where `<peer>` is another member with the same `role` that still has budget.

Override pricing with `ATMUX_PRICING_FILE=/path/to/my-pricing.json`. Default
table at `lib/pricing.json` (Opus / Sonnet / Haiku).

```bash
atmux cost                      # powerline per-member breakdown
atmux cost --member lead        # single member
atmux cost --json               # pipe to jq
atmux cost --since "1 hour ago" # windowed
```

## 🤝 Handoff

```bash
atmux handoff cursor-1 kimi-1 --reason "cursor budget exhausted"
```

Two-phase:
1. 📝 **Native**: asks the source TUI to write a handoff summary to a
   pre-registered path. Waits `ATMUX_HANDOFF_WAIT` (default 30s).
2. 🖥️ **Screen-scrape**: if the file never shows up, `tmux capture-pane -S
   -<ATMUX_HANDOFF_LINES>` (default 500) grabs the pane history verbatim.

Either way, the target member gets the notes + the migrated in-flight tasks.
`--pause-from` additionally calls `atmux pause <from>` so the source stops
accepting new work.

## Testing

```bash
# Unit tests (bats-core, parallel-safe)
bats --jobs 4 tests/unit/

# E2E tests (uses tui=shell; no AI API calls; serial because shared tmux state)
bats tests/e2e/

# Or run everything (+ shellcheck):
./tests/run.sh --shellcheck --jobs 4
```

## Completion

```bash
# bash
echo '. /root/.atmux-src/completions/atmux.bash' >> ~/.bashrc

# zsh — add to fpath
mkdir -p ~/.zsh/completions
ln -s /root/.atmux-src/completions/_atmux ~/.zsh/completions/_atmux
# then in ~/.zshrc: fpath=(~/.zsh/completions $fpath) && autoload -Uz compinit && compinit
```

## Comparison vs plugin-orch

atmux is the successor to [opencode-plugin-orch](https://github.com/geoyws/opencode-plugin-orch). Key differences:

|                           | plugin-orch                       | atmux                             |
|---------------------------|-----------------------------------|-----------------------------------|
| Host                      | OpenCode plugin (inside a session)| Standalone CLI                    |
| Transport                 | OpenCode SDK `promptAsync`        | `tmux send-keys`                  |
| TUI constraints           | OpenCode only                     | Any TUI: claude/opencode/kimi/cursor |
| Install                   | `pnpm install` in opencode config | `curl \| bash`                    |
| Team lead model           | Whatever OpenCode is configured for| Claude (default) or any TUI       |
| Shareability with others  | Requires OpenCode + plugin setup  | Just needs tmux + their TUIs      |

## License

MIT. See [LICENSE](LICENSE).
