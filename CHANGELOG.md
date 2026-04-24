# Changelog

All notable changes to **atmux** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-04-24

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

[Unreleased]: https://github.com/geoyws/atmux/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/geoyws/atmux/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/geoyws/atmux/releases/tag/v0.1.0
