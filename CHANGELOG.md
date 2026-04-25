# Changelog

All notable changes to **atmux** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### ✨ Added

- **Per-member emojis — auto-assigned, displayed everywhere.** Each member in
  `team.json` now carries an optional `.emoji` field, stamped at wizard /
  add-member time. Three assignment modes (`team.emojis.mode`, override via
  `ATMUX_EMOJI_MODE`):
  - `static` — canonical per-role emoji, deterministic (lead=🧭, reviewer=🔍,
    gitter=🌿, devops=⚙️, member=🐝).
  - `random` (default) — random pick from a curated pool per role; avoids
    duplicates within a team for variety.
  - `ai` — `claude -p` picks per-member based on name+role. Falls back to
    `random` if claude is missing or the call fails.
  Display surfaces: tmux window names (`__<team>__<emoji><member>` when
  stamped), `atmux status`, and any future surfaces via `atmux::member_emoji`
  / `atmux::member_display` helpers.
- **Bare `atmux` → one-stop bring-up.** Running `atmux` with no arguments is
  now aliased to `atmux up`: offers the wizard if there's no team.json (with
  the CWD shown prominently so you don't accidentally scaffold in the wrong
  dir), runs doctor preflight, starts the session if it isn't already up, and
  attaches you to it. Idempotent — re-running after the session is up just
  reattaches. Help is still available via `atmux help` / `atmux --help`.
- **`atmux doctor`** — `brew doctor`-style environment check. Validates required
  deps (tmux, jq, git), optional deps (curl, bats, shellcheck), `team.json`
  schema, every member's TUI binary on PATH, `.atmux/` writability, and
  Discord webhook reachability. Flags: `--quiet` (exit-code-only, used by
  start preflight), `--fix` (interactive remediation), `--json` (machine
  readable).
- **`atmux start` preflight.** `start` now runs `doctor --quiet` before
  spawning panes. On red, aborts with a pointer to `atmux doctor`. Use
  `--doctor` for a verbose preflight (or `ATMUX_DOCTOR_ON_START=1` for cron),
  or `--no-doctor` to skip entirely.

## [0.3.0] — 2026-04-24

### ✨ Added

- **`ATMUX_MEMBER` auto-export per pane.** Every TUI launch command now prepends
  `export ATMUX_MEMBER=<name>`, so `atmux claim <id>` and `atmux done <id>` run
  inside a member's pane infer `--as` without any flags.
- **`atmux reply` / `atmux outbox`** — the missing reverse channel. Any member
  writes `atmux reply "..."` to append to `.atmux/lead-outbox.md`; the driver
  reads via `atmux outbox` (with `--ack` to archive, `--json` for pipeability).
  Replaces "attach to lead pane to see what it decided" with an async mailbox.
- **`atmux cost` + budget enforcement.** Parses `~/.claude/projects/*.jsonl`
  `usage` blocks against a pricing table (`lib/pricing.json`; override with
  `ATMUX_PRICING_FILE`). `team.budget.{total,perMember,overrunPolicy}` in
  `team.json` — `overrunPolicy` ∈ `warn | pause | failover`.
- **Budget-exhausted failover.** When `overrunPolicy: "failover"`, `atmux whip`
  auto-invokes `atmux handoff <exhausted> <peer-with-budget>` and pauses the
  exhausted member. Peer selection prefers same `role`.
- **`atmux handoff <from> <to>`.** Two-phase: first asks the source TUI to write
  a handoff summary, waits up to `ATMUX_HANDOFF_WAIT` seconds; if the file
  never materializes, falls back to `tmux capture-pane` screen-scrape. Either
  way the target gets the notes + the in-flight tasks migrated.
- **`atmux pause <member>` / `atmux resume <member>`.** Paused members refuse
  `dispatch` and `claim`. Used by budget enforcement + manual ops.
- **`atmux add-member <name> ...`** — append a member without re-running the
  wizard; spawns immediately if the session is up.
- **`atmux reconfigure`** — re-run the TUI-commands part of the wizard against
  an existing team.json without nuking members.
- **Task `priority` + `deps` enforcement.** `task add --priority N`; `task list`
  sorts ascending by priority. `claim` and `dispatch` refuse tasks whose `deps`
  aren't all `done`.
- **`--json` output** for `atmux status` and `atmux task list` (driver-side
  Claude can now parse team state without grep/awk fragility).
- **`atmux dashboard [--interval <s>]`** — live full-screen status panel.
- **Shell completion**: `completions/atmux.bash` + `completions/_atmux` (zsh).
  Tab-completes verbs + member names read from `.atmux/team.json`.
- **GitHub Actions CI** — `.github/workflows/test.yml` runs shellcheck + bats.
- **`flock` on every JSON mutation.** All `atmux::jq_update` calls now hold a
  per-file lock, preventing read-modify-write races between concurrent
  dispatches / claims.

### 🛡️ Fixed

- shellcheck-clean (with `-e SC1091,SC2154,SC2155,SC2016,SC2034`). Fixes:
  bogus multi-redirect in `cost.sh`, unused vars, `cd` without `|| exit` in
  tests, `A && B || C` misuse in `start.sh`.

### 🧪 Tests

- **139/139 green** (129 unit + 10 e2e) — up from 96 in v0.2.0.
- New suites: `outbox.bats` (6), `env_member.bats` (7), `json_output.bats` (5),
  `add_member.bats` (4), `deps.bats` (5), `cost.bats` (4), `pause.bats` (4),
  `handoff.bats` (5).



### ✨ Added

- **First-run auto-wizard.** Invoking `atmux <verb>` in a directory with no
  `.atmux/team.json` now offers the setup wizard when stdin is a tty. Non-
  interactive paths (cron, piped stdin) keep the normal "no team.json" error so
  `atmux whip` / `atmux report` in cron don't hang. Opt out with
  `ATMUX_NO_WIZARD=1`. Exempt verbs: `init`, `help`, `version`.
- **Per-team TUI launch aliases** via the new `tuiCommands` field in `team.json`.
  Example: `"tuiCommands": {"claude": "claude --plugin-dir=$HOME/work/journals/.sb/claude-skills"}`.
  atmux appends `--model <model>` unless the prefix already contains `--model`.
- **Per-member full-command override** via a new `command` field on a member.
  Takes priority over everything. Use it when one member needs a totally bespoke
  invocation (e.g. a different wrapper script or completely different flags).
- **Custom TUI type names.** Members can now declare `"tui": "claude-fresh"` or
  `"tui": "claude-heavy"` as long as the name has a matching entry in
  `tuiCommands`. Lets you run multiple Claude configs side-by-side.
- **Wizard asks for TUI launch commands.** After the basic team questions, the
  wizard prompts: *"claude launch command [claude]:"* etc. It tries to detect
  existing shell aliases (e.g. `claude='command claude --plugin-dir=…'`) and
  proposes them as defaults. Only non-default entries are written to
  `tuiCommands`, keeping team.json tidy.
- **`examples/opencode-lead-team.json`** — OpenCode driving as `team-lead`
  (cheap coordination turns), Claude for reviewer/gitter, Cursor + Kimi workers.
- **`examples/custom-claude-team.json`** — multiple Claude configs in one team,
  showing `tuiCommands` + per-member `command` override side-by-side.
- **CHANGELOG.md** (this file).

### 🔧 Changed

- `templates/team.example.json` now includes an empty `tuiCommands` block with an
  inline comment showing the common plugin-dir alias pattern.
- `lib/tui.sh` accepts the full member JSON blob so it can read per-member
  `command` overrides.

### 🧪 Tests

- Full suite now 96/96 green (86 unit + 10 e2e).
- New `tests/unit/tui_resolution.bats` (9 tests) covers every branch of the
  3-tier resolution: `member.command` → `team.tuiCommands[tui]` → built-in
  default, plus the "unknown custom tui" error path and a shell-safety test for
  `cwd` with spaces.
- `tests/unit/first_run.bats` (7 tests) covers the first-run wizard offer: tty
  vs non-tty, opt-out env var, exempt verbs, yes/no branches (yes-branch uses
  `script(1)` to fake a tty).

## [0.1.0] — 2026-04-24

### ✨ Initial release

- 🎮 Driver → 🦅 Team Lead → 🐜 Members orchestration via `tmux send-keys`.
- Supports TUIs: `claude`, `opencode` (MiniMax M2.7 highspeed default), `kimi`
  (kimi-latest default), `cursor-agent` (Composer 2 default), `shell`.
- Per-role defaults: team-lead / reviewer / git-committer / devops on Claude;
  workers on any TUI.
- Core verbs: `init`, `start`, `stop`, `attach`, `send`, `broadcast`, `tell-lead`,
  `task` (add / list / show / move / assign / rm), `dispatch`, `inbox`, `claim`,
  `done`, `status`, `report`, `whip`, `rotate`, `rotate-lead`.
- Automation: `atmux whip` (5-min watchdog) + `atmux report` (30-min digest),
  both idempotent for cron. Discord escalation via `ATMUX_DISCORD_WEBHOOK` with
  `DISCORD_WHIP_WEBHOOK` as a fallback.
- State: project-local `.atmux/` with `team.json`, `kanban.json`, per-member
  `inboxes/`, `driver-inbox.md`, `logs/`, `state/`, `archive/`. All
  greppable / diffable JSON + markdown.
- Test suite: 80 bats-core tests (70 unit + 10 e2e), all green. E2E uses
  `tui=shell` so CI needs no AI API keys.

[Unreleased]: https://github.com/geoyws/atmux/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/geoyws/atmux/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/geoyws/atmux/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/geoyws/atmux/releases/tag/v0.1.0
