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

## 3. One-stop bring-up (recommended)

From anywhere:

```bash
cd ~/code/my-project
atmux
```

Bare `atmux` runs the full onboarding flow: offers to run the wizard if there's no `team.json`, runs a doctor preflight, starts the tmux session, and attaches you. Re-running `atmux` later just reattaches — it's idempotent.

The wizard (invoked on first run) asks:

- **Team name** (default: directory name)
- **Preset** (`perf` / `default` / `eco` / `custom`) — governs TUI assignment per member.
- **Staff toggles**: include `planner` (default yes), `reviewer`, `gitter`, `devops`, `dba` — each `[y/n]`.
- **Number of `member` workers** (default: 3)
- **Per-worker TUI** (only if preset=custom) and name. Suggested names: feature-lane form like `fe-auth`, `be-invoice`, `db-orders`.
- **Emoji mode** (`static` / `random` / `ai`) — governs how each member's emoji is assigned.
- **Discord webhook URL** (optional)

This produces `.atmux/team.json`. Inspect it; tweak manually if needed.

### Ephemeral specialists

Spin up an extra planner or dba for a single feature lane — no wizard re-run, just:

```bash
atmux add-member planner-auth --role planner --tui claude
atmux add-member dba-invoice  --role dba     --tui claude
```

They pick up the same brief template as the canonical role. `atmux pause <name>` when the lane is quiet; remove from `team.json` when done.

If you prefer explicit verbs:

```bash
atmux init --wizard    # scaffold only
atmux doctor           # check environment
atmux start            # spawn session + panes
atmux attach           # attach to the session
atmux status           # powerline overview
```

`atmux start`:
- Creates tmux session `atmux-<team>` with one window per member.
- Launches each member's TUI in its window.
- Pastes an initial brief into each pane (from `templates/briefs/<role>.md`).

Attach to watch live:

```bash
atmux attach       # Ctrl-b n / p to cycle between members
```

## 5. Driving an Epic (pull-model walkthrough)

atmux speaks Epic / Story / Task on its kanban. The driver hands the lead an Epic-shaped ask, the planner decomposes, workers pull, and you (the driver) **passively observe**. You don't dispatch. You don't claim. You don't decompose. You just describe what you want and watch the kanban resolve itself.

### Step 1 — Hand the lead an Epic-shaped ask

```bash
atmux tell-lead "Build a /healthz endpoint with versioned JSON + 100% test coverage. \
                 FE wires the demo button; BE owns the handler; TEST adds e2e."
```

This appends to `.atmux/driver-inbox.md` and pings the lead's pane. **You don't tell the lead how to decompose** — you describe scope and constraints; the planner figures out the cuts.

### Step 2 — The lead routes to the planner

The lead reads the inbox, decides this is Epic-shaped (multi-Task, cross-lane), and routes:

```
[lead] atmux send planner "decompose: /healthz endpoint, FE+BE+TEST surfaces, see driver-inbox @ HH:MM"
```

The lead's job is done until the planner replies. The lead does **not** decompose; it routes.

### Step 3 — The planner decomposes onto the kanban

```
[planner] atmux epic add "Healthz endpoint" --body "Versioned JSON + 100% coverage" --driver-ref "driver-inbox@HH:MM"
          → e-3a7b91c2
[planner] atmux story add "BE handler" --epic e-3a7b91c2 --ac "GET /healthz returns 200 + {version, status, ts}"
          → s-9f2c8e41
[planner] atmux story add "FE wire-up" --epic e-3a7b91c2 --ac "Header status badge polls /healthz every 30s"
          → s-44d8a013
[planner] atmux task add "BE handler scaffold" --epic e-3a7b91c2 --story s-9f2c8e41 --lane be --priority 2
[planner] atmux task add "BE versioned JSON shape" --epic e-3a7b91c2 --story s-9f2c8e41 --lane be --priority 2 --deps t-...
[planner] atmux task add "FE status badge component" --epic e-3a7b91c2 --story s-44d8a013 --lane fe --priority 3 --deps t-...
[planner] atmux task add "TEST e2e healthz" --epic e-3a7b91c2 --story s-9f2c8e41 --lane test --priority 3 --deps t-...
[planner] atmux reply "[planner] e-3a7b91c2 ready — 2 Stories / 4 Tasks; deps graph: handler → JSON → FE+TEST"
```

The planner doesn't dispatch; the Tasks just sit on the kanban tagged with lanes + deps.

### Step 4 — Workers pull what's claimable in their lane

```
[be-* ] atmux claim --next            → claims "BE handler scaffold"   (lane=be, priority=2, deps=[])
[fe-* ] atmux claim --next            → no work yet (FE deps unmet — waiting for BE)
[test-*] atmux claim --next           → no work yet (TEST deps unmet)
```

When BE finishes its first Task and `atmux done <id> --note "feat(be): /healthz handler scaffold"`s, gitter auto-receives a commit-Task and lands a commit. The next BE Task unblocks; once both BE Tasks are `done`, FE + TEST become claimable. The kanban routes itself.

### Step 5 — Driver: observe, don't intervene

```bash
atmux outbox                         # async replies from lead + planner + workers
atmux epic show e-3a7b91c2           # tree view of Stories + Tasks + statuses
atmux status                         # team pulse (member panes + kanban counts)
atmux decisions list --since 1h      # auto-mode resolutions you can override
atmux report                         # 30-min digest (auto-pings Discord)
```

Example `atmux epic show` output mid-flight:

```
e-3a7b91c2 [in-progress] — Healthz endpoint
  body: Versioned JSON + 100% coverage
  ref:  driver-inbox@14:32

Stories:
  s-9f2c8e41 [in-progress] — BE handler
    task t-aa11bb22 [done]        — BE handler scaffold
    task t-cc33dd44 [in-progress] — BE versioned JSON shape
    task t-ee55ff66 [todo]        — TEST e2e healthz
  s-44d8a013 [planning] — FE wire-up
    task t-aa77bb88 [todo]        — FE status badge component
```

When the final child Task lands `done`, the Epic auto-flips to `review` and a `draft Epic summary e-3a7b91c2` Task lands in the lead's inbox. The lead composes a wrap-up from `atmux epic show` + `git log` and `atmux reply`s back to you.

### Step 6 — Read the wrap-up

```bash
atmux outbox                         # the lead's Epic summary lands here
git log --oneline | head             # one commit per Task, in order
```

Example `git log` post-Epic (one commit per Task, gitter-authored):

```
4f8a1c2  feat(test): e2e healthz coverage
9b2d3e7  feat(fe): status badge polls /healthz every 30s
a17f4c5  feat(be): versioned JSON shape (status, ts, version)
e3d9b81  feat(be): /healthz handler scaffold
```

The Epic is now `done`. Override anything the planner auto-resolved by replying to the relevant decision in `atmux decisions list` — the cheap window is wide; corrections post-merge are still fine, just more expensive.

### Override the default flow

Pull mode is the default. If you want to override priority or push a Task at a specific worker, the lead can still `atmux dispatch <member> <task-id>` — just tell the lead "give this to BE-foo first." But default-flow workers self-claim from the kanban; you don't need to.

### Quick progress probes

```bash
atmux status                         # team pulse
atmux task list                      # raw kanban
atmux task list --status in-progress # who's working on what
atmux inbox <member>                 # drill into a single member
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

## 7. Driver rotation: surviving your own `/clear`

atmux can `/clear` team members but never the driver — that's you in your
Claude Code REPL. Your session compacts on its own clock, and when it does,
the team's recent context goes opaque. `atmux brief-driver` is the
recovery brief.

```bash
atmux brief-driver
```

Sample output (single-screen, ≤30 lines, sub-second):

```
🟢 atmux driver brief — 2026-04-25 23:18 MYT
─────────────────────────────────────────────
Branch: main (29 commits ahead of origin)
Active loop: /loop kanban-pull (started 18:42 MYT)
Kanban: 2 epics in-progress · 14 tasks todo · 3 in-progress · 2 review

📥 driver-inbox.md (2 open)
  • RESUME-2 18:30 — 'lead drift after 4h; auto-rotation needed'
  • F.6 21:15 — 'flag verb mid-rotation corner case — defer to E5?'

📤 lead-outbox.md (latest 3)
  • 22:55 [planner] e-186a469d ready · 5 Stories / 28 Tasks / ADR-010
  • 22:14 [reviewer] s-108f62c5 approved · 3 Tasks landed clean
  • 21:42 [be-kanban] t-5b96b9ee shipped · flag.sh + Discord template

🚧 in-progress: t-9e8ea33a (fe-kanban) · t-5b96b9ee (be-kanban)

▶ Resume: atmux outbox --ack ; atmux status
```

**When to run `brief-driver`:**

- Every time YOUR Claude Code session compacts or `/clear`s.
- After an Epic ships — `brief-driver` surfaces the lead's wrap-up from
  `lead-outbox.md` so you don't have to scan the file.
- Before stepping away >2h — read it once now, glance again on return.
- Whenever `atmux outbox` reads as unfamiliar — fastest "where were we?".

NOT auto-fired on team start, NOT cron-scheduled — it's an on-demand verb.
Sub-second runtime keeps it cheap to invoke repeatedly during recovery.

**`atmux driver note` — capture judgment so future-driver doesn't re-derive.**

```bash
atmux driver note "Kept push hold; merge-only on demo branch until S10 ships" \
  --reversibility medium \
  --context "ADR-009 §S7 D11 sized noise; we'd over-emit on noisy branch"
```

Mirrors `atmux decisions add` shape (same `--reversibility low|medium|high`,
same optional `--context` / `--option` / `--impact` / `--note`) but writes
to `.atmux/driver-state.md` and **does not ping Discord** — the driver is
the audience, pinging yourself is noise. Team-scoped so the lead can `cat`
the rationale on any whip turn. Use it when you make a call you'll forget
the reasoning behind by tomorrow.

## 8. Shut down cleanly

```bash
atmux stop
```

State is archived to `.atmux/archive/<timestamp>/`.

## Doctor: diagnosing a broken setup

`atmux doctor` is the `brew doctor` of atmux — it checks deps, the team.json schema, whether every member's TUI binary is on PATH, `.atmux/` writability, and Discord webhook reachability. `atmux start` runs these checks silently as a preflight and aborts with a pointer to `doctor` if anything's red.

```bash
atmux doctor               # full report
atmux doctor --fix         # interactive remediation (re-run wizard on bad team.json)
atmux doctor --json        # machine-readable
atmux doctor --quiet       # no output, exit 0 on green / 1 on red (used by start preflight)

atmux start --doctor       # verbose preflight before starting
atmux start --no-doctor    # skip preflight entirely
ATMUX_DOCTOR_ON_START=1    # env equivalent of --doctor (for cron)
```

## Troubleshooting

- **`atmux: no team.json at …`** — run `atmux init` in the project root (or `atmux doctor --fix` to launch the wizard).
- **`atmux: preflight failed — run 'atmux doctor' to diagnose`** — some dep, TUI binary, or config is broken; `atmux doctor` prints the specifics.
- **`atmux start` says "pane is `zsh` not `claude`"** — the TUI didn't launch. Check that `claude`/`opencode`/`kimi`/`cursor-agent` is on PATH for that member's cwd. Retry with `atmux start --force`.
- **Messages go to a void** — the TUI is on its welcome screen. Give it `ATMUX_SPAWN_WAIT=10 atmux start` a longer runway.
- **Lead keeps compacting** — run `atmux rotate-lead` to `/clear` + re-brief, or lower `ATMUX_LEAD_MAX_MIN`.
