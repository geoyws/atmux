# atmux architecture

## Principles

1. **tmux is the IPC.** atmux doesn't speak any AI provider API. It writes shell commands into tmux panes via `tmux send-keys` and reads responses by capturing pane output. That means it works with *any* interactive coding-agent TUI — Claude Code, Cursor, OpenCode, Kimi, or any future one.
2. **State lives on disk, in JSON/markdown.** `.atmux/` is greppable, diffable, and survives tmux restarts.
3. **No daemon.** Every verb is idempotent. `whip` and `report` run on cron.
4. **Driver is external.** atmux is launched from the driver's shell. The driver does NOT run inside the tmux session — it's a separate process that fires atmux commands.

## Roles

| Role            | Window position | Default TUI | What it does |
|-----------------|-----------------|-------------|--------------|
| `driver`        | — (not in tmux) | (any)       | Relays human intent via `atmux tell-lead` + `atmux send` |
| `team-lead`     | 1               | claude      | Decomposes asks, dispatches, surfaces blockers           |
| `reviewer`      | 2               | claude      | Reviews diffs, approves commits                          |
| `git-committer` | 3               | claude      | The only member allowed to commit + push                 |
| `devops`        | 4               | claude      | Deploys, env, CI/CD, infra                               |
| `member`        | 5…n             | any         | Workers — do the coding work                              |

## Driver → Lead routing

Two paths; use both:

1. **Durable**: `atmux tell-lead "..."` appends to `.atmux/driver-inbox.md`. Lead reads this first on every whip turn. Survives `/clear`, survives tmux restart.
2. **Immediate**: the same command also fires a short heads-up via `tmux send-keys` to the lead's pane. Gives the lead a nudge to check the inbox.

## Lead → Member routing

1. **Task board**: `atmux task add` + `atmux dispatch <member> <task-id>`. Writes to `inboxes/<member>.json`. Durable, re-queryable.
2. **Immediate ping**: `dispatch` also sends a short notification into the member's pane via `tmux send-keys`. Member can then `atmux inbox <name>` to see details.
3. **Broadcast**: `atmux broadcast "..."` for cross-cutting announcements.

## Work-stealing

Idle members can scan the kanban and pull unclaimed tasks:

```bash
atmux task list --status todo
atmux claim <task-id> --as <member>
```

There is no lock: the first `claim` wins (file write is near-atomic on modern filesystems; jq temp-file + rename is atomic). If two members claim simultaneously, the second call will notice the task is already `in-progress` on next `status` and back off.

## Whip (watchdog) — every 5 min

`atmux whip` checks:

1. Session liveness (is the tmux session up?).
2. Per-member pane: does `#{pane_current_command}` match the expected TUI binary?
3. Per-member banners: `rate-limit`, `Compacting conversation`, `Press up to edit queued messages`.
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
