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

### Team topology — single-session by default

`atmux start <team>` spawns every member into your existing driver tmux session as a window prefixed `__<team>__<member>`. The driver and the team share one session — `tmux ls` stays clean, and team-switching is a window-hop (`Ctrl+B w`) rather than a session-hop (`Ctrl+B s`). This is the only mode `atmux init --wizard` creates ([ADR-026](docs/adr/026-always-single-session-topology.md)).

**Escape hatch** (`singleSession=false`) is retained as a *declared* option for the rare case of a non-human-driven team or a detached observer setup that needs a dedicated `atmux-<team>` session. The wizard does not prompt for it; flip by hand:

```bash
jq '.singleSession = false' .atmux/team.json | sponge .atmux/team.json
```

If you flip it on a team that's already running, restart the team to reconcile (`atmux stop && atmux start`).

**Migrating an old dedicated-session team** to the current default uses the Phase 2 verb introduced in ADR-016:

```bash
atmux migrate-to-driver-session <team>
```

The verb refuses while a member is mid-task; run during a quiet window. ADR-016's Phase 2 migrate infrastructure remains the canonical move path even though [ADR-026](docs/adr/026-always-single-session-topology.md) supersedes ADR-016's *default policy*.

See [docs/adr/026-always-single-session-topology.md](docs/adr/026-always-single-session-topology.md) for the rationale + window-count risk register, and [docs/adr/016-single-session-topology.md](docs/adr/016-single-session-topology.md) for the original opt-in design (default policy line is superseded; everything else stands).

### Per-team tmux socket isolation (opt-in)

By default every atmux team shares the user's main tmux server at `/tmp/tmux-$UID/default` — alongside the driver's daily-driver shells, other worktree windows, and any other atmux teams. **Per-team socket isolation** moves a team onto its own tmux server (its own `TMUX_TMPDIR`), so a buggy `kill-session -a` from a misbehaving lib change can't reach unrelated sessions.

**When to pick it.** You're the dev-on-itself team editing atmux internals (or another tool that runs dangerous `tmux` ops). The blast-radius firewall is worth the changed-attach UX. Most teams do NOT need this — leave the field unset.

```json
{
  "tmuxTmpdir": "/tmp/atmux-tmux_<team>"
}
```

**What changes when set:**

- `bin/atmux` exports `TMUX_TMPDIR=<value>` immediately on entry — every subsequent `tmux` call routes to the isolated socket. The directory is auto-created (`mkdir -p`). Existing `$TMUX_TMPDIR` env wins over the team.json value.
- `lib/cron.sh` prepends `TMUX_TMPDIR=<value>` to every emitted `whip` / `report` / `decisions digest` cron line — without this the cron jobs would look at the wrong server and report session DOWN forever.
- Bare `tmux attach` no longer reaches the team. Use either:

  ```bash
  atmux attach                                                # honours team.json
  tmux -S /tmp/atmux-tmux_<team>/tmux-$UID/default attach     # raw tmux fallback
  ```

- `atmux doctor` adds a `tmuxTmpdir` row asserting the directory is writable and (when a session exists) the isolated socket is reachable.

**Caveat.** Orthogonal to the single-session default (ADR-026): every team is single-session today, so `tmuxTmpdir` simply moves the driver's *shared* session onto the team's isolated socket. If you've used the `singleSession=false` escape hatch, the dedicated `atmux-<team>` session lives on the isolated socket instead. Either combination is supported.

The init wizard does not prompt for this field — opt-in is a manual `team.json` edit, since the field is for advanced/dogfooding setups. See [docs/adr/018-per-team-tmux-socket-isolation.md](docs/adr/018-per-team-tmux-socket-isolation.md) for the full design + risk register.

### Renaming a team

`atmux team rename` renames a team **atomically across every surface** the team-name appears in: `team.json:.name`, tmux session + window names, cron markers, the fleet registry, and the single-session capture file. ~150 LOC of orchestration plus a rollback engine — the verb refuses unsafe states up front rather than half-committing on failure ([ADR-027](docs/adr/027-team-rename-verb-and-topology-invariant.md)).

```bash
atmux team rename <old> <new> [--session <new-session>] [--migrate-session] [--force]
```

**Pre-flight refuse-gates** (any one fails → refuse with a specific error):

- Any kanban Task with `status=="in-progress"` → refuse. Mid-flight work would land in indeterminate naming state. **Overridable with `--force`** when the operator accepts the risk.
- `<new>` already exists in the registry → refuse. Hard refuse (NOT `--force`-overridable) — collisions can't be safely resolved automatically.
- `<new>` doesn't match `[a-z0-9_-]+` → refuse. Hard refuse.

**Orchestration sequence** — each step rollback-staged; a partial failure invokes rollback in reverse order (full detail in ADR-027 §Orchestration sequence):

1. Set the `rename.lock` state file. Cron'd consumers (whip, super-status, decisions digest, cron orphan-detect) check this at entry and return 0 silently — no concurrent state mutation while the rename runs.
2. `jq`-edit `team.json:.name` → `<new>`. Backup at `team.json.bak.<epoch>`.
3. `tmux rename-window` per `__<old>__*` window → `__<new>__*`. If `--session <new-session>` differs from the current session name, also `tmux rename-session` (or `--migrate-session` invokes the ADR-016 Phase 2 migrate path for legacy dedicated→driver-session moves).
4. Rewrite `state/session.txt` for single-session teams.
5. **Cron re-install with NEW marker first, then remove the OLD marker.** Install-new-then-remove-old is the explicit ordering — avoids any window where the team has zero cron coverage (per ADR-027 OQ H3). Brief overlap of two markers is harmless; whip is flock-guarded so duplicate fires no-op.
6. Registry update: `atmux::registry_deregister <old>` + `atmux::registry_upsert <new> <projectRoot> <new-session>`. `createdAt` is preserved on the new entry — rename, not re-init.
7. Clear `rename.lock`.
8. Return success.

**Rollback semantics.** Any step ≥2 failure triggers reverse-order rollback: cron re-remove → `state/session.txt` restore → `tmux rename-window` back → `tmux rename-session` back → `team.json` restore from backup → registry rollback → clear lock. The full attempt log writes to `<projectRoot>/.atmux/state/rename-rollback.log` for operator inspection.

Rollback is **best-effort**. Some terminal failure modes (the tmux session dying mid-rename, registry write contention with a parallel `atmux start`) require manual recovery — the rollback log records what was attempted and what state the operator is left holding. The verb logs a final `manual recovery: see rename-rollback.log` line so the failure can't pass silently.

**Historical entries are NOT rewritten.** `kanban.json` archive entries, `lead-outbox.md`, `driver-inbox.md`, and `decisions.md` retain old-team-name references in their archived bodies — archive-don't-rewrite. New entries written after the rename use the new name. Operators grepping for the old name reach the archive layer directly; this preserves auditability across the rename boundary at the cost of one mental "this was named differently before" step on grep.

`.atmux/` itself is **not moved** — the directory is pinned to `projectRoot`, not to the team name.

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

### Member emoji stability

Each member spawns into a tmux window named `__<team>__<emoji><member>` — the leading emoji is the visual shorthand the driver builds up over weeks of operation ("🐰 is be-kanban", "🦁 is lead"). To keep that shorthand intact across restarts, atmux records each member's emoji to the cross-team registry at `~/.claude/teams/registry.json` (see [ADR-025](docs/adr/025-superdriver-phase-1.md)) and treats it as **immutable once first written**.

**Lookup priority at spawn time** (`lib/start.sh`, `lib/add-member.sh`, anywhere a member's emoji is resolved):

1. **Registry** — `registry.json:teams[name=$team].members[name=$member].emoji`. Present + non-empty → use it.
2. **`team.json`** — `.members[name=$member].emoji`. Present + non-empty → use it AND write it through to the registry. Subsequent spawns hit step 1.
3. **Random fallback** — pick from the animal palette → use it AND write it through to the registry. The first random pick is the durable assignment; subsequent restarts keep that animal.

The persist-back step on (2) and (3) is load-bearing — without it, "🐰 = be-kanban" would re-roll on every restart and the driver's mental model would never stabilise.

**Why this is immutable.** Driver feedback before ADR-030: every `atmux stop` + `atmux start` cycle re-randomised any member without a baked `team.json` emoji, breaking the visual shorthand. Bulk-rename windows (4 sequential renames in one Sg burst) compounded the churn. Registry-as-source-of-truth + immutability fixes both — once a member has an emoji, that emoji is permanent.

**Override path.** Editing `team.json:.members[].emoji` on an **already-registered** member has NO effect at spawn time — the registry wins per the lookup priority. To change a registered member's emoji:

```bash
# Operator-explicit: edit the registry directly, then rotate the member.
jq --arg t atmux-kanban --arg m be-kanban --arg e 🐺 \
   '(.teams[] | select(.name == $t) | .members[] | select(.name == $m) | .emoji) = $e' \
   ~/.claude/teams/registry.json | sponge ~/.claude/teams/registry.json
atmux rotate be-kanban
```

The rotate is what re-spawns the window under the new emoji name; until then the live tmux window keeps the old name.

See [docs/adr/030-registry-emoji-immutability.md](docs/adr/030-registry-emoji-immutability.md) for the full design + risk register.

### Discord palette per team

When multiple atmux teams ping into the same Discord channel, the team-name backticks alone aren't enough to distinguish pings at a glance — under load (20+ pings/hour, 2–3 teams), the wall blurs together. atmux solves this by rendering each ping as a Discord webhook **embed** with a **per-team color** (a 16-color Catppuccin-Frappe-aligned palette) and a **leading glyph** in the embed title.

**Default (no config — works out of the box).** Each team gets a deterministic auto-color via `sha256(team-name)[0] mod 16` → palette index. `atmux-kanban` always renders one fixed color, `sopx-mvp` always another — no operator config required, and the assignment is stable across restarts.

**Override (when the auto-color clashes).** Both fields are optional and live in `team.json:.discord`:

```json
{
  "discord": {
    "webhook": "https://discord.com/api/webhooks/...",
    "color":   "#7287fd",
    "emoji":   "🌊"
  }
}
```

- `color` — hex string (with or without leading `#`), e.g. `#7287fd`. Wins over the hash-derived palette index.
- `emoji` — single glyph rendered before the team name in the embed title (default: `🤖`).

**Test escape.** `ATMUX_DISCORD_PLAINTEXT=1` forces the embed sender to fall back to the plain `{content: <body>}` shape. Used by test fixtures that assert on `.content`, and as a runtime kill-switch if a Discord-side embed regression appears.

The palette is locked at decompose time — adding a new color is a one-line append, but reordering or removing entries shifts every existing team's auto-color, so the order is intentionally stable. See [docs/adr/019-discord-domain-separator.md](docs/adr/019-discord-domain-separator.md) for the full design + 16-color list.

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

### 🧠 Per-member model selection

The Claude CLI accepts `--model <id>`; atmux propagates a per-member `model`
field in `team.json` through that flag at spawn time
(`lib/start.sh` → `lib/tui.sh::atmux::tui_claude`). Default semantics:
`.model == "default"` OR field absent → claude CLI's default model (Opus
today via the global `CLAUDE_CODE_EFFORT_LEVEL=xhigh` env). Explicit model
IDs (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`,
…) propagate verbatim.

Per-role assignment for an atmux team (per
[ADR-024](docs/adr/024-per-member-model-selection.md), revised
2026-04-27 07:55 MYT per decision `d-c3f8d980`):

| Role | Model | Rationale |
|---|---|---|
| `lead` | Opus | coordination + dispatch |
| `planner` | Opus | decomposition + ADRs |
| `be-kanban` / `fe-kanban` / `test-kanban` | Opus | writes code |
| `gitter` | Opus | commit composition + lint-staged-trap + scope-check |
| `reviewer` | Opus | audit-bar judgment on others' work (exhaustive grep + negative-space + class-widening) |
| `unblocker` | Opus | `/team clear` blast-radius + classify-and-route on others' work |
| `auditor` | Opus | exhaustive-grep + verdict pattern on already-committed code |
| `discorder` | **Sonnet** (`claude-sonnet-4-6`) | pure narrative formatter; writes Discord pings only; no judgment-on-correctness |
| (`lib/llm-judge.sh` helper, **not** a team member) | Sonnet | ad-hoc `claude --print` invocation from `lib/whip.sh` SOFT-tier path; see [ADR-023](docs/adr/023-rate-limit-three-tier-llm-judge.md) |

**Driver narrow-carve-out note.** atmux teams override the global
`~/.claude/CLAUDE.md` "Team members always use Opus" rule **only** for
the pure narrative formatter (`discorder`). Sonnet-fit means
read-and-summarise *without judgment-on-correctness*. `reviewer`,
`unblocker`, and `auditor` were originally proposed for Sonnet (decision
`d-a26b4211`) but reverted per `d-c3f8d980` — they make consequential
calls on others' work and stay on Opus.

**Per-member override.** One `jq` edit + a rotate is enough to flip a
member to Sonnet (or any other model):

```bash
jq '(.members[] | select(.name == "discorder") | .model) = "claude-sonnet-4-6"' \
  .atmux/team.json > .atmux/team.json.tmp \
  && mv .atmux/team.json.tmp .atmux/team.json
atmux rotate discorder
```

Restart with `atmux rotate <name>` to re-spawn the pane under the new
model, or wait for the next natural rotation if the running session is
mid-work. `CLAUDE_CODE_EFFORT_LEVEL=xhigh` stays global for all members —
Sonnet members inherit `xhigh` effort by design.

### 🔑 Per-member Claude account selection

Same precedent as the model field above ([ADR-024](docs/adr/024-per-member-model-selection.md)) — a sugar layer on top of Claude Code's built-in `CLAUDE_CONFIG_DIR` env var. Set `claudeAccount` per member in `team.json` to declaratively route members across multiple Claude Max accounts (cost balance, rate-limit headroom, account-scoped scopes for IFCA-vs-personal work):

```json
{
  "members": [
    { "name": "lead",      "tui": "claude", "claudeAccount": "default" },
    { "name": "be-kanban", "tui": "claude", "claudeAccount": "ifca"    },
    { "name": "fe-kanban", "tui": "claude", "claudeAccount": "ifca"    }
  ]
}
```

Resolution: `claudeAccount: "<suffix>"` → spawn cmd prepends `CLAUDE_CONFIG_DIR=$HOME/.claude-<suffix>`. Absent or `"default"` → no env, claude uses `~/.claude` as usual. The auth flow itself is identical — first time you spawn a member with `claudeAccount: "ifca"`, run `CLAUDE_CONFIG_DIR=$HOME/.claude-ifca claude /login` once to seed the config dir; subsequent spawns reuse it.

`atmux doctor` adds a `claude-account:<member>` row asserting the resolved dir exists and is readable when the field is set — a missing dir would silently re-trigger first-time auth on next rotation.

**Override path interaction.** `member.command` (full override) and `team.tuiCommands[<tui>]` (custom prefix) paths bypass this auto-application — those are operator-owned envelopes; if you want the env var there, write it into the prefix/override yourself. The auto-apply is on the built-in claude path only.

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

### `atmux super-status`

Cross-team triage in one shot. Reads every entry in `~/.claude/teams/registry.json`, assembles a per-team digest, and tops it with a fleet rollup. Read-only by default — no auto-mutation of registry state.

**What it shows, per team:**

- `name`, `projectRoot`, `sessionName`, liveness `status`.
- Kanban rollup: `todo` / `in-progress` / `blocked` counts + `opsPending` (lane=`ops` Tasks not yet `done`).
- Lead-outbox tail — last 3 lines of `<projectRoot>/.atmux/lead-outbox.md`.
- Git: `git log --oneline -5` on `projectRoot` + ahead/behind vs `origin/<branch>`.
- `lastCommit` + `lastOutbox` epoch timestamps (drives the fleet `idleTeams` rollup).

**Fleet rollup section:**

- Team count by status (running / stopped / stale).
- `promoteReadyEpics` — Epics across all teams in `status: "review"` or with all-Stories-done.
- `staleClaims` — `in-progress` Tasks whose `claimedAt` is older than 24h on any team.
- `idleTeams` — no commit AND no lead-outbox activity in the last 24h (`stopped` teams skipped — that's operator-intentional, not a fleet anomaly).

**Liveness check semantics.** Per registry entry: `tmux has-session -t <sessionName>` AND `<projectRoot>/.atmux/` directory present. Both pass → render `status: "running"`. Either fails → render `status: "stale"`. The check **never mutates the registry** — `--prune` is the only operator-explicit channel that flips an entry's stored status.

**`--json` mode** for downstream consumption (dashboards, alert pipelines, ad-hoc `jq` queries). Schema is stable across releases:

```jsonc
{
  "teams": [
    {
      "name": "atmux-kanban",
      "projectRoot": "/root/work/src/atmux",
      "sessionName": "atmux-kanban",
      "status": "running",            // running | stopped | stale
      "kanban": { "todo": 12, "inProgress": 3, "blocked": 1, "opsPending": 0 },
      "leadOutbox": ["…last 3 non-blank lines…"],
      "gitLog": ["abc1234 feat(x): …", "…"],   // up to 5
      "branch": { "ahead": 2, "behind": 0 },
      "lastCommit": 1777200000,        // epoch seconds
      "lastOutbox": 1777199500
    }
  ],
  "fleet": {
    "counts": { "running": 2, "stopped": 0, "stale": 1, "total": 3 },
    "promoteReadyEpics": [ { "team": "…", "id": "e-…", "title": "…", "status": "review" } ],
    "staleClaims":       [ { "team": "…", "id": "t-…", "owner": "…", "claimedAt": 1777, "ageSec": 90000 } ],
    "idleTeams":         [ { "name": "…", "lastCommit": 1777, "lastOutbox": 1777 } ]
  }
}
```

**`--prune` semantics.** Operator-explicit cleanup of liveness-failed registry entries — flips their stored `.status` to `"stale"` (no delete; ADR-025 keeps history). Default reads do NOT mutate. Run `super-status` first to see what will be flipped, then `super-status --prune` to apply:

```bash
atmux super-status                # read-only triage; renders 'stale' marker
atmux super-status --prune        # operator-explicit; flips stored status
```

Cross-link: full mechanism + risk register in [`docs/adr/025-superdriver-phase-1.md`](docs/adr/025-superdriver-phase-1.md).

### `atmux super-tell`

Cross-team write that goes through the **target team's existing `tell-lead` durability layer** — same channel a regular driver running `atmux tell-lead` inside the target project would use. The superdriver doesn't get a side-channel; every cross-team ask flows through the inbox + pane-state guard the target team already enforces.

```bash
atmux super-tell <team> <member> <msg…>
```

The verb resolves `<team>` via `~/.claude/teams/registry.json`, `cd`'s into the target's `projectRoot`, and:

1. Appends the entry to `<projectRoot>/.atmux/driver-inbox.md` — the same file the target's lead reads at the top of every whip tick.
2. Sends a `📬 super-tell → <member>: <truncated-msg>` heads-up keystroke to the target's lead pane via `tmux send-keys`.

**Pane-state preflight (refuses, doesn't fall through).** Before sending the keystroke, super-tell captures the target lead's pane and checks for the same status indicators every member-side `tmux send-keys` honors — `thinking with`, `Compacting conversation`, `Press up to edit queued messages`, rate-limit banners. Any of these fires a refuse with a "retry once it clears" message; the driver-inbox write happens regardless, so the ask is never lost — only the keystroke heads-up is gated. Re-running super-tell once the pane is idle is safe (idempotent on the inbox if the message body is identical).

**Audit trail.** super-tell entries land in `<projectRoot>/.atmux/driver-inbox.md` alongside regular `tell-lead` entries. The line carries an explicit `(super-tell → <member>)` provenance tag so post-hoc audit (grep / lead's whip read) can distinguish a cross-team ask from a same-team driver ask, but the file format and the lead's reading discipline are identical:

```
- [09:30 MYT] (super-tell → lead) rotate-lead — uptime over 4h, context rotting
- [09:32 MYT] check the deploy-staging gate before merging E10
```

The first line is a super-tell; the second is a same-team `atmux tell-lead`. Both are read in the same lead loop. No new audit channel; no shadow log.

**Phase 2 carve-out reminder.** super-tell is intentionally constrained — no cross-team Task push, no cross-team Epics, no arbitration that edits both teams' kanban. When fleet operation surfaces an ask the `tell-lead` chain genuinely cannot carry, the discipline is to **log the incident** in `~/.claude/teams/superdriver-bypass-log.md` with timestamp + situation + what the superdriver wanted to bypass + **why `tell-lead` was insufficient** — driver reviews the log periodically; consistent themes drive a Phase 2 ADR. Empty log after weeks of operation = Phase 1 was sufficient. The superdriver brief at `templates/briefs/superdriver.md` carries the same reminder for the agent that runs in the dedicated `atmux-superdriver` session.

Cross-link: [`docs/adr/025-superdriver-phase-1.md`](docs/adr/025-superdriver-phase-1.md) — full design + risk register + Phase 2 deferral list.

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

### Preflight: logout-kill exposure

**Why it matters.** On modern Linux (systemd ≥230), `KillUserProcesses=yes` is the stock default. When your SSH session ends, systemd-logind reaps the entire user cgroup — your tmux server, every atmux team in it, and any orphan helper scopes all die together. The 2026-04-26 incident on hax cost both `sopx-mvp` and `atmux-kanban` their mid-flight state when an SSH session-3.scope ended; whip cron survived (it lives in crontab, outside the user session) and proceeded to ping Discord with "session DOWN" every 5 min until manually disabled. The fix is one `loginctl` call, but the **detection** has to happen before you start the team.

**The check.** `atmux doctor` runs `_doctor_check_logout_kill` as part of its preflight battery. It reads `loginctl show-user --property=Linger` + `/etc/systemd/logind.conf` and surfaces one of three rows:

- `logout-kill` (green) — `Linger=yes`. Your tmux server survives logout; nothing to do.
- `logout-kill` (yellow) — exposed (linger off + `KillUserProcesses` on/unset) on a **local TTY** session. The driver may legitimately accept this risk for local dev.
- `logout-kill` (red) — exposed on an **SSH** session (detected via `loginctl show-session "$XDG_SESSION_ID"` or `$SSH_CONNECTION` non-empty). This is the incident shape — your team is one logout away from extinction.

**`atmux start` warns but does not refuse.** Start invokes `atmux doctor --quiet`; when the logout-kill row is non-green, start prints an unmissable `⚠️ logout-kill exposure: tmux server will die when this SSH session closes. Run \`atmux doctor --fix\` to enable linger.` and proceeds. The driver may legitimately want to spin up an ad-hoc team for a single session; refusal would be paternalistic.

**How to dismiss.** Two paths, both run-once:

```bash
atmux doctor --fix                              # tries `loginctl enable-linger`; on
                                                # EPERM prints the sudo invocation.
sudo loginctl enable-linger "$(id -un)"         # manual, when --fix can't elevate.
```

After enabling linger, re-run `atmux doctor` to confirm the row flips to green. Linger persists across reboots — one-time fix per host.

**macOS / non-systemd hosts.** `loginctl` is absent, the check skips silently, no row is emitted either way. The exposure isn't a Linux-stock-default problem outside systemd-init systems.

Full rationale + risk register + open-question resolutions: see [`docs/adr/017-logout-kill-preflight.md`](docs/adr/017-logout-kill-preflight.md).

### Topology invariant check

**Why it matters.** With every team running in single-session topology ([ADR-026](docs/adr/026-always-single-session-topology.md)) plus the fleet registry tracking each team's `sessionName`, drift between "what the registry says" and "what tmux actually has" becomes detectable. Hand-renamed sessions, partially-applied `atmux team rename` rollbacks, manually-killed windows, and a missing superdriver session all leave the team in a state where the next `atmux start` would spawn into the wrong place. The topology invariant check ([ADR-027 §invariant check](docs/adr/027-team-rename-verb-and-topology-invariant.md)) catches all four shapes.

**The check.** `atmux doctor` runs `_doctor_check_topology_invariant` as part of its preflight battery. For each registry entry with `status="running"` it asserts:

1. `tmux has-session -t <registry.sessionName>` succeeds.
2. The team's windows (`__<team>__*`) live in that session — and the count matches `team.json:.members | length`.

Plus a fleet-level rule: when ≥1 team is running, the canonical `atmux-superdriver` session must exist.

Three severities, with action hints attached:

- `topology:<team>` (**green**) — registry session matches tmux state and member count agrees with `team.json`. Sample: `✅ topology:atmux-kanban  session=atmux 9 members in atmux:*`.
- `topology:<team>` (**yellow**) — windows match the registry session but their count differs from `team.json:.members[]` length. Could be a half-killed pane or a mid-flight `add-member`. Hint: `audit member-by-member: tmux list-windows -t <session> | grep '^__<team>__'`.
- `topology:<team>` (**red**) — registry-claimed session doesn't hold the team's windows. The check sub-classifies:
  - **Wrong-session match** — windows live in a different session than the registry says. Hint: `atmux team rename <team> --session <actual> --migrate-session OR atmux team rename <team> --session <registry.sessionName>`.
  - **Session missing entirely** — neither the registry-claimed session nor any other session holds `__<team>__*` windows. Hint: `atmux team rename <team> --session <actual> --migrate-session OR restart with atmux start`.
- `topology:superdriver` (**red**) — at least one team is running but the canonical `atmux-superdriver` session is absent. Hint: `atmux super-attach`.

Sample rows from `atmux doctor`:

```
  ✅ topology:atmux-kanban    session=atmux 9 members in atmux:*
  ⚠️  topology:sopx-mvp        session=atmux has 11 windows but team.json expects 12 members
     → audit member-by-member: tmux list-windows -t atmux | grep '^__sopx-mvp__'
  ❌ topology:aix-root         registry says session=atmux-aix but 5 windows live in atmux
     → atmux team rename aix-root --session atmux --migrate-session OR atmux team rename aix-root --session atmux-aix
  ❌ topology:superdriver      atmux-superdriver session absent — fleet aggregator unavailable
     → atmux super-attach
```

**`atmux start` / `atmux up` refuse on red.** Both verbs invoke the topology check in their preflight; a `red` row aborts the spawn with the row's content + suggestion text and a final "use `--force` to override" line. `--force` overrides the refuse-gate (operator accepts the drift); `yellow` rows warn and proceed without `--force`. Standalone `atmux doctor` invocations **never refuse** — they only report. The refuse-gate applies exclusively to mutating verbs (`start`, `up`); a read-only doctor run always exits with the row count, not a hard error.

**Skipped silently when** tmux or `jq` is missing, the registry is empty, or `atmux::registry_list` isn't present (cold-start before any `atmux init` has registered a team). Same skip discipline as the rest of the doctor checks — no rows means "nothing to assert against," not "everything's fine."

Full mechanism + ADR-026 single-session topology rationale that justifies the invariant: [`docs/adr/027-team-rename-verb-and-topology-invariant.md`](docs/adr/027-team-rename-verb-and-topology-invariant.md) + [`docs/adr/026-always-single-session-topology.md`](docs/adr/026-always-single-session-topology.md).

## FAQ

**Why is single-session the default — and when would I disable it?**

Driver + members share one tmux session because that's how a human actually drives the team: they want to see everything at a glance, hop between members with `prefix w`, and avoid the session-soup that dedicated sessions accumulate when you run multiple teams. Window-name prefix `__<team>__<member>` keeps choose-tree (`prefix s`) grouped visually, and `lib/stop.sh`'s refuse-gate prevents accidental `kill-session` on the driver shell. ADR-026 captures the rationale + window-count risk register.

Flip `singleSession=false` only for teams that aren't being driven by a human — non-human-driven team or a detached observer setup that wants a dedicated `atmux-<team>` session it can attach to in isolation. The wizard does not prompt for it; the field is a declared escape hatch, edited by hand. ADR-016 holds the original opt-in design for context (its default policy line is superseded by ADR-026, but the migrate verb + refuse-gate infrastructure stand).

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
