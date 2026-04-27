# atmux

**atmux** — *agent teams multiplexer.* One tmux session per project team, one tmux window per agent.

> 🎮 **Driver** (you) → 🧭 **Team Lead** → 🐝 **Team Members** — coordinated through tmux, not an API.

A tmux-native multi-TUI agent orchestrator. Runs a fleet of coding-agent terminals (Claude Code, Cursor, OpenCode, Kimi) in parallel, with a kanban task board, per-member inboxes, a 5-minute whip watchdog, and a 30-minute progress digest to Discord.

**Why not just Claude Code everywhere?** Because Claude is expensive and not every task needs it. With atmux, the **staff** (lead, planner, reviewer, gitter, devops, dba) stay on Claude because they need the reasoning, while **workers can be Cursor Composer 2, MiniMax, or Kimi** for cheaper parallel throughput per feature lane. The driver (you, in a Claude Code REPL) talks to the lead; the lead routes to the planner (decomposition); workers **pull** their next Task from the kanban; gitter commits; the reviewer signs off Stories; the lead writes the Epic summary back to the driver.

## Agile vocabulary

atmux's kanban speaks Epic / Story / Task. The pull model only works when you keep these distinctions clear.

- **Epic** — a feature or initiative scoped by the driver. State machine: `planning → ready → in-progress → review → done`. The driver hands the lead an Epic-shaped ask via `atmux tell-lead`; the lead routes it to the planner (`atmux send planner`); the planner decomposes it into Stories + Tasks. When every child Task is `done`, the Epic auto-flips to `review` and a "draft Epic summary" Task lands in the lead's inbox — the lead composes the wrap-up via `atmux epic show` + `git log` and `atmux reply`s back to the driver.

- **Story** — a coherent slice of an Epic with explicit acceptance criteria. State machine: `planning → ready → in-progress → testing → review → merging → done`. **Stories are OPTIONAL.** Small Epics with ≤3 Tasks skip them. Use Stories when there are multiple distinct acceptance surfaces (schema vs. UI vs. e2e). Reviewer signoff happens at the Story level on the cumulative diff — empty `acceptanceCriteria` is an automatic REJECT.

- **Task** — an atomic unit of work on the kanban with a lane (FE / BE / DB / OPS / TEST / REVIEW / MISC), optional `--epic` / `--story` tags, optional `--deliverable`, and explicit `--deps`. Workers **pull** the next claimable Task in their lane via `atmux claim --next`; selection prefers their lane, falls back across lanes when `crossLaneClaim=true` (default). Each Task with `.epic` set auto-dispatches a commit-Task to gitter on `move done`; one commit per Task, no batching.

The **lead never decomposes and never dispatches per-Task** — that's the planner's and the kanban's job. The lead routes Epics to the planner, watches state, surfaces blockers, and composes Epic summaries. The **gitter never reviews** and never pushes by default. The **reviewer never commits** and never decomposes. Each role has a narrow surface; the kanban orchestrates.

See [docs/adr/007-pull-kanban.md](docs/adr/007-pull-kanban.md) for the full ADR + state-machine spec, and the implementation plan at `~/.claude/plans/pure-pondering-crane.md` for the rollout sequence.

## How it works

```
┌───────────────────────────────────────────────────────────────────┐
│ Your terminal (the driver) — your Claude Code / shell             │
│                                                                    │
│   atmux tell-lead "build auth flow, see RFC-12"   ┐               │
│   atmux outbox                                     │ Epic ask      │
│   atmux status / atmux report                      │               │
└──────────────┬─────────────────────────────────────┴───────────────┘
               │ tmux send-keys + driver-inbox.md
               ▼
┌───────────────────────────────────────────────────────────────────┐
│ tmux session: atmux-<team>                                         │
│                                                                    │
│  🧭 STAFF                                                          │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐   │
│  │ 🧭 lead    │  │ 🗺️  planner │  │ 🔍 reviewer│  │ 🌿 gitter  │   │
│  │ ROUTES     │  │ DECOMPOSES │  │ STORY GATE │  │ COMMITS    │   │
│  └──┬─────────┘  └─────┬──────┘  └──────┬─────┘  └────┬───────┘   │
│     │ atmux send       │ atmux           │ atmux        │ on every  │
│     │ planner          │ epic add        │ story        │ Task done │
│     │                  │ story add       │ advance      │ (auto-    │
│     │                  │ task add        │ --to merging │  dispatch)│
│     │                  │  --epic --lane  │              │           │
│     ▼                  ▼                 ▼              │           │
│  ┌────────────────────────────────────────┐              │           │
│  │ 📋 kanban.json (Epics + Stories + Tasks) │ ◄────────────┘           │
│  └─────────┬──────────────────────────────┘                          │
│            │ atmux claim --next  (lane-prefer; deps-aware)            │
│            ▼                                                          │
│  🐝 WORKERS   (one per feature × surface; name = lane-feature)        │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐                        │
│  │ 🐝 fe-auth │ │ 🦊 be-auth │ │ 🦉 db-auth │   ← auth lane          │
│  │ claude     │ │ cursor-agt │ │ opencode   │   pull FE / BE / DB    │
│  └────────────┘ └────────────┘ └────────────┘   Tasks                │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐                        │
│  │ 🐙 fe-inv  │ │ 🦀 be-inv  │ │ 🐢 db-inv  │   ← invoice lane       │
│  │ claude     │ │ kimi       │ │ opencode   │                        │
│  └────────────┘ └────────────┘ └────────────┘                        │
│                                                                       │
│  Final Task done → epic auto-flips → "draft Epic summary" → 🧭 lead   │
│  shared state: .atmux/{team.json,kanban.json,decisions.md,inboxes/}   │
└───────────────────────────────────────────────────────────────────────┘
               │ every 5 min                     every 30 min
               ▼                                 ▼
         atmux whip                        atmux report
         (stale panes? rate limits?)       (Discord digest)
```

**Read this diagram top-to-bottom**: the driver hands the lead an Epic-shaped ask; the lead routes it to the planner via `atmux send planner`; the planner runs `atmux epic add` + (optional) `atmux story add` + `atmux task add --epic <eid> --lane <lane> --deps …` to lay the work onto the kanban; FE / BE / DB / TEST workers then pull whatever's claimable in their lane via `atmux claim --next`. The lead doesn't dispatch per-Task — that's a relic of the push model; the kanban routes itself.

## Quickstart

```bash
# 1. Install
curl -fsSL https://raw.githubusercontent.com/geoyws/atmux/main/install.sh | bash

# 2. In your project:
cd ~/code/my-project
atmux                         # one-stop: wizard (if new) → doctor → start → attach
# …or do it explicitly:
atmux init --wizard           # interactive setup only
atmux doctor                  # environment check (deps / team.json / TUI PATH / webhook)
atmux start                   # spawn the team
atmux attach                  # tmux attach to watch

# 3. Drive the team:
atmux tell-lead "build a /healthz endpoint with 100% test coverage"
atmux status                  # team pulse
atmux outbox                  # read lead's async replies

# 4. Automation is wired for you.
# `atmux start` automatically installs three crontab entries scoped per team
# via marker comments (`# >>> atmux:team=<name>` … `# <<< atmux:team=<name>`):
#   */5  * * * * atmux whip              # watchdog: stale panes, blockers, delta
#   */30 * * * * atmux report            # digest: progress to Discord
#   0 */4 * * * atmux decisions digest   # consolidates low/medium decision pings
# `atmux stop` removes the block (idempotent — safe to re-run). Inspect with
# `crontab -l | grep atmux:team=<your-team>`.
#
# Disable auto-install via team.json (then manage cron yourself):
#   { "kanban": { "cronAutoInstall": false } }
#
# Run `atmux whip` manually any time to fire a tick immediately — same code
# path as the 5-min cron. Useful when investigating an in-flight blocker or
# right after a known event (deploy, rotate, etc.) without waiting for the
# next scheduled tick.

# 5. When done:
atmux stop
```

### Single-session mode (opt-in)

By default, `atmux start <team>` creates a dedicated tmux session named `atmux-<team>` per team. **Single-session mode** (opt-in) spawns members into your existing driver tmux session instead — cleaner `tmux ls`, plus team-switching becomes a window-hop (`Ctrl+B w`) rather than a session-hop (`Ctrl+B s`).

```bash
# Opt-in via team.json (preferred — sticky across starts):
jq '.singleSession = true' .atmux/team.json | sponge .atmux/team.json

# …or one-shot at start time via env:
ATMUX_DRIVER_SESSION=1 atmux start
```

`atmux init --wizard` surfaces the flag at team-create time. **Existing teams stay on dedicated sessions** — opt in retroactively via `atmux migrate-to-driver-session <team>` (lands in Phase 2 / Story Sb).

See [docs/adr/016-single-session-topology.md](docs/adr/016-single-session-topology.md) for the design + risk register.

### Preset modes

The wizard asks for a preset up front — governs default TUI assignment:

| Preset  | Staff            | Workers                                   | When to pick it                        |
|---------|------------------|-------------------------------------------|----------------------------------------|
| `perf`    | all `claude`   | all `claude`                              | Capability > cost. Production-grade work. |
| `default` | all `claude`   | cycles `cursor` → `opencode` → `kimi`     | The balanced default — Claude staff + cheap workers per feature lane. |
| `eco`     | all `opencode` | all `opencode` (MiniMax)                  | Cost > capability. Prototyping, throwaway branches. |
| `custom`  | prompted       | prompted per worker                       | Fine-grained control. Falls back to the per-worker TUI prompt. |

### Ephemeral feature specialists

atmux's default staff is one of each role. For a big feature with heavy planning or DB work, spin up a specialist just for that lane — no config change, just `add-member`:

```bash
atmux add-member planner-auth --role planner --tui claude --cwd "$PWD"
atmux add-member dba-invoice  --role dba     --tui claude --cwd "$PWD"
atmux add-member planner-mig  --role planner --tui claude --cwd "$PWD"

# Remove them when the lane ships — or pause while idle:
atmux pause planner-auth
```

They share the same brief template as the canonical role, so the lead treats them as parallel staff. Useful when the main planner's queue is deep or a feature needs a dedicated schema reviewer.

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
| `team-lead`       | `claude`    | Routes asks + dispatches; never plans itself  |
| `planner`         | `claude`    | Decomposition + ADRs — owns the cognitive load the lead used to carry |
| `reviewer`        | `claude`    | Quality gate — needs Opus                     |
| `gitter`          | `claude`    | Commit msg + hooks discipline                 |
| `devops`          | `claude`    | Infra judgment calls                          |
| `dba`             | `claude`    | Schema + migrations + data integrity (optional) |
| `member`          | any         | Parallel throughput per feature lane — pick cheapest that works |

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

📋 Kanban (Epic + Story + Task)
atmux epic add <title> [--body <txt>] [--driver-ref <ref>]
atmux epic list [--status <s>] [--json]
atmux epic show <id>
atmux epic advance <id> [--to <state>]              # planning→ready→in-progress→review→done
atmux story add <title> --epic <eid> [--ac <text>] [--body <text>]
atmux story list --epic <eid> [--status <s>] [--json]
atmux story show <id>
atmux story advance <id> [--to <state>]             # planning→ready→in-progress→testing→review→merging→done
atmux task add <subject> [--body <txt>] [--epic <eid>] [--story <sid>] \
                         [--lane fe|be|db|ops|test|review|misc] \
                         [--deliverable <text>] [--assignee <m>] [--deps <id,id>] [--priority <n>]
atmux task list [--status …] [--assignee <m>] [--json]
atmux task show <id>
atmux task move <id> <todo|in-progress|done|blocked>   # done auto-dispatches commit-Task to gitter
atmux task assign <id> <member>
atmux task rm <id>

📨 Dispatch / work
atmux dispatch <member> <task-id> [--no-ping]   # priority override only; default flow is pull
atmux inbox <member> [--json]
atmux claim <task-id> [--as <member>]            # blocked if deps unresolved
atmux claim --next [--as <member>] [--lane <l>]  # pull-mode: pick next claimable Task in your lane
atmux done  <task-id> [--as <member>] [--note <text>]   # auto-fires commit-Task on Epic-tagged Tasks

📓 Decisions log
atmux decisions add "<question>" --default "<answer>" --reversibility low|medium|high [--note <text>]
atmux decisions list [--since <when>] [--reversibility <level>] [--json]
atmux decisions show <id>

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

## 🔄 Driver rotation

atmux can `/clear` team members (`atmux rotate <member>`, `atmux rotate-lead`,
or auto-rotation when `team.whip.autoRotate=true`) but **it cannot `/clear`
the driver** — that's you, the human at the keyboard. Your Claude Code
session compacts on its own schedule, and when it does, the entire team's
recent context goes opaque to your next session: who asked what, why the
lead picked option (b), what's still pending in `driver-inbox.md`.

`atmux brief-driver` is the recovery brief — single-screen (≤30 lines),
sub-second runtime, on-demand only:

```bash
atmux brief-driver
```

Output bundles: kanban counts, branch ahead-of-origin, active loop, open
`driver-inbox.md` entries, latest 3 `lead-outbox.md` entries, in-progress
Tasks, and the recovery command sequence to fully re-bootstrap. Run it:

- After every fresh `/clear` of your own session.
- After an Epic ships (the wrap is in lead-outbox; brief-driver surfaces it).
- Before stepping away >2h (read it now, you'll thank yourself on return).
- Whenever `atmux outbox` looks foreign — fastest path to "where were we?"

**`atmux driver note`** captures a judgment call so a future driver doesn't
re-derive it. Mirrors `atmux decisions add` shape — same `--reversibility`
flag, same field structure — but writes to `.atmux/driver-state.md` and
**does not ping Discord** (you're the audience; pinging yourself is noise).
Team-scoped (lead can `cat` the rationale on any whip turn) so judgment
calls are visible to the team without round-tripping.

```bash
atmux driver note "S9 sandbox path option (c) — DB-side dispatcher" \
  --reversibility medium \
  --context "options (a)/(b) discarded after planner audit; (c) survives RLS gates"
```

## 🛰️ atmux-superdriver Phase 1

When the driver runs more than one atmux team on a single host (today: hax with `atmux-kanban` + `sopx-mvp` + future Unum / IFCA product teams), per-team oversight fragments fast: "what teams exist? which are alive? which have OPS gates pending?" is answered today by `tmux ls` + `cd <project> && atmux status` per team — linear in team count, no rollup. Per-team `tell-lead` is the only cross-context channel, so pushing a "rotate your lead" to `sopx-mvp` from any other shell costs a `cd` + an inbox edit. **atmux-superdriver Phase 1** is a read-only fleet aggregator + safe write channel that goes through each team's existing `tell-lead` durability layer — no new write surface to learn, no new audit trail to police.

### Phase 1 surface

| Verb | Purpose |
|---|---|
| `atmux super-attach` | Attach-or-spawn the dedicated `atmux-superdriver` tmux session. Spawns a single Claude pane with the superdriver brief auto-injected if the session is absent. |
| `atmux super-status` | Per-team digest (status, kanban rollup, OPS gates, last lead-outbox entries, branch ahead/behind, recent commits) + fleet rollup (total teams, promote-ready Epics, cross-fleet stale claims, idle teams >24h). `--json` for downstream consumption; `--prune` for operator-explicit cleanup of stale registry entries. |
| `atmux super-tell <team> <member> <msg>` | Cross-team write via `tell-lead` durability — registry lookup → projectRoot resolution → write target's `driver-inbox.md` + tmux send-keys heads-up to the target's lead pane. Honors target's pane-state preflight (refuses on `thinking with` / `Compacting conversation` / queued messages). Same channel as a regular driver running `atmux tell-lead` inside the target project. |

### How to use

```bash
atmux super-attach          # opens dedicated atmux-superdriver session
                            # (spawn-or-attach; ON-DEMAND, no whip-cycle)
atmux super-status          # triage cross-team digest
atmux super-tell sopx-mvp lead "rotate-lead — uptime over 4h, context rotting"
```

The session sits idle when not in use. There is **no whip-cycle in Phase 1** — the driver invokes `super-attach` when fleet-wide coordination is needed, works, then exits. No 5-min watchdog, no 30-min digest, no idle Opus burn.

### Architectural posture

- **Registry-as-file** at `~/.claude/teams/registry.json` — single source of truth for "what teams exist." flock-guarded writes mirror the `kanban.json.lock` pattern (bare `jq + mv` writes are a documented foot-gun and intentionally not used).
- **Read-only on cross-team state.** `super-status` reads any registered team's `kanban.json` / `lead-outbox.md` / git state but never writes. The only sanctioned cross-team writes are `super-tell` (which goes through each team's `tell-lead` chain) and `super-status --prune` (operator-explicit registry cleanup).
- **NO bypass of `tell-lead`.** Every cross-team write routes through the target team's existing durability layer — no separate cross-team kanban, no shadow audit trail.

### Phase 2 deferral

These verbs / behaviors are **explicitly deferred to Phase 2** and DO NOT exist in Phase 1:

- Cross-team Task pushing (writing directly into another team's `kanban.json`).
- Cross-team Epics that span multiple teams' kanban files.
- Cross-team conflict arbitration that edits both teams' state.
- Superdriver whip-cycle (recurring 5-min/30-min digest from the superdriver pane).

The Phase 2 commit gate is empirical: when the superdriver finds itself wanting to bypass `tell-lead` (push directly, arbitrate, write a cross-team Epic), it logs the incident in `~/.claude/teams/superdriver-bypass-log.md` with timestamp + situation + what it wanted to bypass + **why the `tell-lead` chain was insufficient**. Driver reviews the log periodically; consistent themes drive a Phase 2 ADR. Empty log after weeks of use = Phase 1 was sufficient.

### Risk register summary

| Risk | Mitigation |
|---|---|
| Registry corruption from concurrent atmux start/stop | flock on `registry.json.lock` mirrors the kanban-lock pattern; bare `jq + mv` rejected. |
| Cross-team tmux send-keys collision | `super-tell` honors target pane's preflight (refuse on `thinking with` / `Compacting` / queued). |
| Stale registry entries (team killed without `atmux stop`) | `super-status` liveness check (tmux session + `.atmux/` dir) marks `stale`; `--prune` for operator-explicit cleanup — NO auto-mutate from reads. |
| Privacy / blast (super-status reads ALL teams) | Acceptable on hax (single-user box). Multi-tenant deferred indefinitely. |

Full risk register + open-question resolutions: see [`docs/adr/025-superdriver-phase-1.md`](docs/adr/025-superdriver-phase-1.md).

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

## Troubleshooting

**"My whip stopped pinging."** Run `atmux doctor`. It surfaces two cron-related conditions:

- `cron-config` (yellow) — atmux cron entries point at a different `ATMUX_DIR` than the current project. Common after the project moved on disk (rename, relocation, fresh checkout under a new path). Fix: `crontab -e` and update the path, or re-run `atmux start` from the new path.
- `cron-orphan` (yellow) — a marker block exists for a team whose `ATMUX_DIR` is missing on disk (e.g. you `rm -rf`'d a worktree without `atmux stop`). Fix: `atmux doctor --fix` prunes the orphan block automatically, or `crontab -e` to remove by hand.

**"I don't want atmux touching my crontab."** Set `kanban.cronAutoInstall: false` in `team.json` before the first `atmux start`. If you've already started, `atmux stop` removes the block, then add the opt-out, then `atmux start` again.

## FAQ

**Why two topology options (dedicated session vs single-session)?**

Dedicated session keeps team isolation strong — `kill-session` is a clean shutdown that can't accidentally take down the driver shell, and `tmux ls` lists each team explicitly. Single-session is the modern default for solo-driver setups (most users); members spawn alongside the driver's windows so `tmux ls` stops accumulating `atmux-*` entries and team-switching becomes a window-hop. Pick dedicated when you run multiple teams in parallel and want hard isolation; pick single-session when you primarily drive one team at a time and want a clean tmux surface. ADR-016 has the full tradeoff.

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
