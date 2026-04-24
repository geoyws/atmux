# Getting started with atmux

## 1. Install dependencies

```bash
# macOS
brew install tmux jq bash git

# Ubuntu / Debian
sudo apt install tmux jq bash git curl
```

Plus whichever TUIs you plan to use:

```bash
# Claude Code
# https://docs.anthropic.com/en/docs/claude-code

# OpenCode
# https://opencode.ai

# Kimi CLI (Moonshot)
# https://platform.moonshot.ai

# Cursor CLI
# https://cursor.com/cli
```

## 2. Install atmux

```bash
curl -fsSL https://raw.githubusercontent.com/geoyws/atmux/main/install.sh | bash
```

This clones the repo to `~/.atmux-src` and symlinks `bin/atmux` into `/usr/local/bin/atmux`.

## 3. Initialize your first team

In your project directory:

```bash
cd ~/code/my-project
atmux init --wizard
```

The wizard asks:

- Team name (default: directory name)
- How many `member` workers? (default: 3)
- For each worker: which TUI? (claude / opencode / kimi / cursor / shell)
- For each worker: custom model? (Enter for default)
- Discord webhook URL? (optional; skip with Enter)

This produces `.atmux/team.json`. Inspect it; tweak manually if needed.

## 4. Start the team

```bash
atmux start
atmux status
```

`atmux start`:
- Creates tmux session `atmux-<team>` with one window per member.
- Launches each member's TUI in its window.
- Pastes an initial brief into each pane (from `templates/briefs/<role>.md`).

Attach to watch live:

```bash
atmux attach       # Ctrl-b n / p to cycle between members
```

## 5. Kick off work

```bash
atmux tell-lead "Build a /healthz endpoint that returns 200 + versioned JSON, with tests."
```

This appends to `.atmux/driver-inbox.md` and pings the lead's pane. The lead decomposes into tasks, dispatches to members.

Check progress:

```bash
atmux status
atmux task list
atmux inbox ui-cursor
```

## 6. Automate the watchdog

Add to `crontab -e`:

```cron
*/5  * * * * cd /abs/path/to/project && /usr/local/bin/atmux whip   >> .atmux/logs/cron.log 2>&1
*/30 * * * * cd /abs/path/to/project && /usr/local/bin/atmux report >> .atmux/logs/cron.log 2>&1
```

Set `ATMUX_DISCORD_WEBHOOK` in `~/.zshrc` / `~/.bashrc` for Discord escalation:

```bash
export ATMUX_DISCORD_WEBHOOK="https://discord.com/api/webhooks/..."
```

## 7. Shut down cleanly

```bash
atmux stop
```

State is archived to `.atmux/archive/<timestamp>/`.

## Troubleshooting

- **`atmux: no team.json at …`** — run `atmux init` in the project root.
- **`atmux start` says "pane is `zsh` not `claude`"** — the TUI didn't launch. Check that `claude`/`opencode`/`kimi`/`cursor-agent` is on PATH for that member's cwd. Retry with `atmux start --force`.
- **Messages go to a void** — the TUI is on its welcome screen. Give it `ATMUX_SPAWN_WAIT=10 atmux start` a longer runway.
- **Lead keeps compacting** — run `atmux rotate-lead` to `/clear` + re-brief, or lower `ATMUX_LEAD_MAX_MIN`.
