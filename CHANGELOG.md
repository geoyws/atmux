# Changelog

All notable changes to **atmux** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> Targets **v0.5.0**. Themes: **pull-model kanban** (Epic 1, see ADR-007)
> — Epic/Story/Task data model, lane-aware `claim --next`, auto-dispatched
> commit-Tasks, Story-level reviewer signoff, `atmux decisions add` verb;
> plus **whip Since-last-tick delta enrichment + richer decisions** (Epic 2,
> see ADR-009 §S7–§S10 + ADR-008 §S9–§S10) — per-bullet renders for done-
> tasks/commits/advanced-stories with `[E#/S#]`/`<sha>`/`<sid>` anchors,
> `story.advancedAt` schema field, decisions verb gains 4 optional fields
> (`--context` / `--option` ×5 / `--impact` / `--decided-by`) with section-
> aware multi-message Discord chunking + `[N/M]` headers.

### ✨ Added — Pull-model kanban (Epic 1)

- **Epic / Story / Task data model on `kanban.json`.** New top-level arrays
  `epics[]` + `stories[]`. Tasks gain optional `.epic` / `.story` / `.lane` /
  `.deliverable` fields. Backwards-compat preserved: legacy kanbans with only
  `tasks[]` still load; `atmux::kanban_normalize` (in `lib/common.sh`) auto-adds
  the new arrays on first mutation. Tasks without the new fields keep working
  (treat missing as `null` on read).
- **`atmux epic add | list | show | advance`** (S2). State machine:
  `planning → ready → in-progress → review → done`. `epic show` renders a tree
  view (Epic → Stories → child Tasks with statuses).
- **`atmux story add | list | show | advance`** (S3). State machine:
  `planning → ready → in-progress → testing → review → merging → done`. `--ac`
  flag captures explicit acceptance criteria — empty `acceptanceCriteria` is an
  automatic REJECT at reviewer signoff (per ADR-007 OQ2).
- **`atmux task add` new flags** (S4): `--epic <eid>`, `--story <sid>`,
  `--lane fe|be|db|ops|test|review|misc`, `--deliverable <text>`. Stories are
  optional; small Epics skip them.
- **`atmux claim --next [--lane <l>] [--as <m>]`** (S4). Pull-mode work
  selection: filters Tasks with non-`done` deps, prefers caller's lane, falls
  back across lanes when `team.kanban.crossLaneClaim` is `true` (default).
  Atomic claim with race-aware retry (3 attempts).
- **Auto-dispatch of commit-Tasks to gitter on `task move done`** (S4). When a
  Task with `.epic` set flips to `done`, a `commit <id>` Task lands in gitter's
  inbox automatically. Storyless-Epics auto-flip `in-progress → review` and
  fire a `draft Epic summary` Task to the lead. Story-level test-lane completion
  flips the Story `testing → review`.
- **`.lane` on the team-member schema** (S5). `templates/team.example.json`
  stamps lane explicitly; the wizard infers lane from member-name prefix
  (`fe-foo` → `fe`, `be-bar` → `be`, etc.) with role overrides for staff
  (`reviewer` → `review`, `devops` → `ops`, `dba` → `db`,
  `team-lead`/`planner`/`gitter` → `misc`). `atmux status` adds a `LANE` column
  (UPPER-CASE in display, lowercase in JSON). Backwards-compat: missing `.lane`
  is inferred at read time.
- **`atmux decisions add | list | show`** (S10, [ADR-008](docs/adr/008-decisions-verb.md)).
  Append-only auto-mode-resolution log at `.atmux/decisions.md`. Each `add`
  pings Discord (silent if no webhook). `--reversibility low|medium|high`
  classifies the call. Question / default / note are truncated to fit the
  ≤80-char Discord per-bullet budget; oversize inputs error rather than
  silent-truncate. Whip integration surfaces a pointer for new decisions
  since the last tick (S10).
- **`team.kanban.crossLaneClaim`** config (default `true`). When `false`, an
  empty caller-lane queue produces a hard error instead of falling back to
  any-lane work.

### ✨ Added — Whip enrichment + richer decisions (Epic 2)

<!-- Bullets land per-Story; this section is populated by sibling
     Tasks t-fc256867 (S7) / t-1b4d63ea (S8) / t-c6ae5307 (S9) and the
     S10 entry below. Order tracks the ADR-009 §S1→§S5 / §S7→§S10 +
     ADR-008 §S9→§S10 narrative. -->

- **Auto-rotation infrastructure** (E2/S5,
  [ADR-009](docs/adr/009-auto-rotation.md)). New `team.whip.autoRotate`
  config flag (boolean, default `false`, opt-in for safety — `/clear`
  is destructive so existing teams must NOT get auto-rotated on
  upgrade). When `true`, whip auto-execs `atmux rotate-lead` at the
  uptime threshold AND auto-execs `atmux rotate <member>` on banner
  detection (`Compacting conversation` / `approaching usage limit` /
  `hit your limit`). Per-member rotation anchor at
  `.atmux/state/<member>-rotated.epoch` (written by `lib/rotate.sh`
  on every successful rotation; whip's uptime calc switches from
  session-anchored to rotation-anchored, falls back to session-start
  when the anchor file is absent so existing teams see zero
  behavioural change until their first rotation lands). Banner
  preclear gated by the same flag and debounced 5 min via the same
  `<member>-rotated.epoch` so a persistent banner doesn't re-rotate
  every cron tick. Discord finding `♻️ AUTO-ROTATED <member> at <ts>`
  fires on every auto-rotation so the driver knows their pane just
  got `/clear`'d. Brief updates: `templates/briefs/lead.md`
  §Auto-rotation rewrite + `templates/briefs/member.md` §Auto-preclear
  callout. (`lib/rotate.sh`, `lib/whip.sh`, `templates/team.example.json`,
  `templates/briefs/lead.md`, `templates/briefs/member.md`.)

- **whip output noise reduction** (E2/S7,
  [ADR-009 §S7](docs/adr/009-auto-rotation.md)). Dedup pings via
  body-hash anchor (`.atmux/state/whip-last.hash`) so a single stuck
  Task doesn't re-fire 12 identical pings/hour. New per-tick
  "Since last tick" delta block with positive signal — commits +
  done-Tasks + advanced-Stories that landed in the window. Raised
  `staleMin` default `30 → 90` (demo-walk Tasks legitimately exceed
  30 min); per-Task override via `atmux task add --stale-min N`.
  Queued-msg flag suppressed when the pane is BUSY (mid-thinking /
  active token-counter / `Esc to interrupt` banner) — those messages
  WILL be submitted when the current turn ends, not stale.
  (`lib/whip.sh`, `lib/kanban.sh`, `templates/team.example.json`.)

- **decisions verb — Discord gating + inline preview + digest** (E2/S8,
  [ADR-009 §S8](docs/adr/009-auto-rotation.md)). Discord ping at
  add-time is now gated on `--reversibility high` only; `low` /
  `medium` decisions skip the per-add ping and surface via whip's
  inline preview block (`📋 N new decisions: …` with top-3 question +
  default per entry) plus a new `atmux decisions digest` verb that
  consolidates all skipped low/med entries since the last digest
  cursor into ONE Discord post (with `[N/M]` split if it exceeds
  2000 chars; silent on empty windows). Driver brief and planner
  brief explain the new ladder + when each tier pings.
  (`lib/decisions.sh`, `lib/whip.sh`, `templates/briefs/lead.md`,
  `templates/briefs/planner.md`, `README.md` cron snippet.)

- **decisions verb — richer template (4 new optional fields)** (E2/S9,
  [ADR-008 §S9](docs/adr/008-decisions-verb.md)). New optional flags:
  `--context` (the WHY behind the decision), `--option` (repeatable
  up to 5 times — alternatives considered), `--impact` (what
  breaks / who notices / what migrates if the default is wrong),
  `--decided-by` (who landed the call: lead / planner / specific
  teammate). Per-field byte caps were temporarily relaxed to
  200/500 chars in the S9 ship and then dropped entirely in S10
  (see chunker entry below). Discord template extended to render
  the new sections in `question · default · decided-by · context ·
  options · impact · note · reversibility` order, skipping any
  empty section. Backwards-compat preserved: a no-new-flags entry
  is bit-identical in `.atmux/decisions.md` to the pre-S9 4-field
  shape; legacy entries also parse cleanly via the extended awk in
  `_decisions_to_json_array`. Brief copy in lead.md + planner.md
  documents per-field guidance + worked examples.
  (`lib/decisions.sh`, `templates/briefs/lead.md`,
  `templates/briefs/planner.md`.)

- **decisions verb — drop per-field caps + section-aware multi-message
  Discord chunker** (E2/S10, [ADR-008 §S10](docs/adr/008-decisions-verb.md)).
  S9's per-field byte caps (200 chars on question/default, 500 on
  note/context/impact, 80 on decided-by, 200/each on options) are gone —
  the data layer accepts arbitrarily long input. The Discord renderer
  now composes the full body, ships a single message when ≤1900 chars,
  and otherwise splits **section-by-section** into up to 5 messages
  with a `[N/M]` header per chunk and a 1s sleep between pings to stay
  under Discord's rate-limit margin. Required fields (question, default,
  decided-by, reversibility, show/override pointers) always live in
  chunk 1; optional sections (context, options, impact, note) flow into
  chunks 2–5 in keep-order. Beyond 5 chunks, fields drop in S9-truncate
  order (note → impact → options → context) and the last chunk gets
  `↳ atmux decisions show <id> for full`. Whip's "Since last tick"
  delta block also gains per-bullet rendering for done-tasks
  (`🏁 \`<id>\` [E#/S#] <subject> — <owner>`), commits
  (`✅ \`<sha>\` <subject> — <author>`), and advanced-stories
  (`📈 \`<sid>\` [<epic>] <title> → <status>`); each truncates to
  ≤80 chars/bullet with cap-5-plus-`+N more`. New `story.advancedAt`
  epoch schema field stamped on every transition; old stories pre-
  dating the field are naturally excluded by the strict-greater-than
  filter. Per-field cap regressions in `tests/unit/decisions.bats`
  retargeted; new `tests/unit/whip_delta.bats` enriched-bullet
  coverage (18/18 incl. real-git regression for the format→tformat
  fix from f-3229e152).

### ♻️ Changed — Briefs rewritten for pull model

- **`templates/briefs/lead.md`** — explicit "DO NOT decompose / DO NOT dispatch
  per-Task"; loop now (1) read `driver-inbox.md`, (2) route Epic asks to the
  planner via `atmux send planner`, (3) compose Epic summary on `draft Epic
  summary` request from `atmux epic show` + `git log`. New "Recording decisions"
  section on `atmux decisions add` usage with reversibility tier explainer.
- **`templates/briefs/planner.md`** — explicit "You decompose. You DON'T
  dispatch. The lead routes; workers pull." Loop covers `atmux epic add` →
  optional `atmux story add` → `atmux task add --epic --lane --deps` → `atmux
  reply`. Lane vocabulary table (FE / BE / DB / OPS / TEST / REVIEW / MISC).
  ADR template included. New "Recording resolved open questions" section.
- **`templates/briefs/member.md`** — pull loop: `atmux claim --next` → execute
  → `atmux done <id> --note "<commit subject>"`. Cross-lane handoff via deps;
  surface-with-evidence pattern for cross-lane bugs. FE workers also own the
  TEST-lane capstone for UI Stories. **DO NOT commit / DO NOT push** preserved
  and reframed as "gitter commits on the back".
- **`templates/briefs/reviewer.md`** — Story-level signoff on cumulative diff
  (not per-commit). Empty `acceptanceCriteria` = automatic REJECT. Approve via
  `atmux story advance --to merging`; reject via push-back + `--to in-progress`.
  System-wide audit bar preserved (exhaustive grep + negative-space proof +
  adjacent-class widening).
- **`templates/briefs/gitter.md`** — three Task shapes auto-arrive:
  `commit t-xxx` (one commit per Task), `merge s-xxx` (Story finalization on
  `merging`), `persist deferred items` (one-shot, only allowed write outside
  `/root/work/src/atmux/`). HEREDOC commit example with `Co-Authored-By:`
  trailers. Hooks always run — never `--no-verify`, never `--amend` after a
  hook failure.

### 📚 Docs

- **`README.md`** — new "Agile vocabulary" section (Epic, Story OPTIONAL,
  Task definitions); revised "How it works" diagram showing pull-model flow
  (driver → lead → planner → kanban → workers pull → gitter commits → lead
  Epic summary). Commands section updated with `atmux epic` / `atmux story` /
  `atmux task add --epic --story --lane --deliverable` / `atmux claim --next` /
  `atmux decisions add | list | show`.
- **`docs/ARCHITECTURE.md`** — Roles table redefined for the pull model
  (lead routes, planner decomposes, reviewer signs off Stories, gitter auto-
  dispatched, member pulls). New "Pull coordination" section covers the
  kanban data model + 3 state machines + `claim --next` selection +
  auto-dispatch flow with ASCII diagram. New "Lead → Planner routing" section
  replaces the old push-model "Lead → Member routing".
- **`docs/GETTING_STARTED.md`** — new "Driving an Epic" 6-step walkthrough
  with realistic `/healthz` example, live `atmux epic show` tree-view
  example mid-flight, example `git log` post-Epic showing one commit per
  Task. Existing first-time-setup + cron + doctor sections preserved.
- **Tab-completions** (`completions/_atmux` zsh, `completions/atmux.bash`
  bash) — `epic`/`story`/`decisions` top-level verbs with sub-verbs;
  `--lane` / `--reversibility` / `--to` / `--status` enum completions
  (state-machine aware: epic-states for `epic advance --to`, story-states
  for `story advance --to`); `task add` new-flag matrix; `claim --next` +
  `--lane` + `--as`.

### 🚨 Breaking changes

- **Brief templates rewritten**. Existing teams should re-init briefs from
  `templates/briefs/*.md` (or run `atmux reconfigure`). Old push-model
  briefs are stale; the lead/member/reviewer/gitter behaviour described
  in them no longer matches the runtime.
- **Lead no longer dispatches per-Task by default**. Workers pull. Manual
  `atmux dispatch <member> <task-id>` is reserved for explicit driver-
  requested priority overrides; default flow is `atmux claim --next`.

### ✨ Added — pre-Epic-1 (already in Unreleased before this Epic)

- **`planner` + `dba` as canonical staff roles.** Planner owns task
  decomposition + ADR authorship, so the lead's context budget goes to
  coordination only (per the CLAUDE.md doctrine "team-lead never plans").
  DBA owns schema + migrations + data integrity. Both are toggleable in
  the wizard (`planner` on by default, `dba` off by default). New brief
  templates in `templates/briefs/planner.md` and `templates/briefs/dba.md`.
- **Wizard preset modes.** New top-of-wizard prompt: `perf` (all claude),
  `default` (claude staff + cursor/opencode/kimi workers cycled),
  `eco` (all opencode / MiniMax), `custom` (prompt each worker individually).
  Preset drives staff + worker TUI defaults; other prompts still run so the
  user confirms team shape.
- **Feature-lane worker naming convention.** README + wizard suggest
  `fe-auth`, `be-auth`, `db-auth`, etc. over `cursor-1` / `kimi-2` —
  surfaces ownership and makes kanban/status readable at a glance.
- **Ephemeral specialists pattern.** Documented in README +
  GETTING_STARTED: `atmux add-member planner-auth --role planner`
  spawns a feature-scoped specialist when canonical staff is saturated.
  No new code; formalises an existing capability.
- **`docs/adr/` with 6 initial ADRs** covering planner role, preset modes,
  emoji architecture, ephemeral specialists, doctor preflight, and bare
  `atmux`. Planner uses this directory for new ADRs going forward.

### ♻️ Changed

- **Role rename: `git-committer` → `gitter`.** Role value, brief file,
  emoji pool, status fallback, docs + README + template all updated.
  Shorter + matches the wizard prompt. Existing team.json files with
  `role: "git-committer"` keep working via status.sh fallback but should
  be migrated.

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
