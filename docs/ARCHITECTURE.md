# atmux architecture

> **Storage in atmux-bun.** Per [ADR-060](adr/126-sqlite-state-store.md), kanban
> (tasks/epics/stories), inboxes, and per-feature state moved to **`.atmux/state.db`**
> (SQLite, WAL). The text below referencing `.atmux/kanban.json` describes the legacy
> JSON model — still accurate for bash atmux and for teams not yet migrated, but on the
> bun port the DB is the source of truth. Markdown files (`team.json` excepted as JSON,
> `decisions.md`, `flags.md`, `driver-inbox.md`, `lead-outbox.md`, `HANDOFF.md`) and
> append-only JSONL logs stay as files.

## Principles

1. **tmux is the IPC.** atmux doesn't speak any AI provider API. It writes shell commands into tmux panes via `tmux send-keys` and reads responses by capturing pane output. That means it works with *any* interactive coding-agent TUI — Claude Code, Cursor, OpenCode, Kimi, or any future one.
2. **State lives on disk** — SQLite (`state.db`) for the kanban + inboxes + per-feature state per ADR-060; markdown for human-edited files (`HANDOFF.md`, `decisions.md`, `flags.md`, driver-inbox/lead-outbox); JSONL for append-only logs. `.atmux/` survives tmux restarts.
3. **No daemon.** Every verb is idempotent. `whip` and `report` run on cron.
4. **Driver is external.** atmux is launched from the driver's shell. The driver does NOT run inside the tmux session — it's a separate process that fires atmux commands.

## Roles

The pull model defines each role by what it *doesn't* do — narrow surfaces, no overlap. See [ADR-007](adr/007-pull-kanban.md) for the full spec.

| Role        | Window | Default TUI | What it does (post pull-model)                                                                                                                          |
|-------------|--------|-------------|---------------------------------------------------------------------------------------------------------------------------------------------------------|
| `driver`    | —      | (any)       | Relays human intent via `atmux tell-lead` + `atmux send`. Never inside the tmux session.                                                                |
| `team-lead` | 1      | claude      | **Routes** Epic-shaped asks to the planner; composes Epic summary at end via `atmux epic show` + `git log`. **Never decomposes. Never dispatches per-Task.** |
| `planner`   | 2      | claude      | **Owns decomposition**: Epic → (optional Stories) → Tasks, with `--lane`, `--deps`, `--deliverable`. Writes ADRs in `docs/adr/`. **Never dispatches.**  |
| `reviewer`  | 3      | claude      | **Story-level signoff** on cumulative diff (not per-commit). Empty `acceptanceCriteria` is automatic REJECT. Never commits.                             |
| `gitter`    | 4      | claude      | Commits on Task `done` via auto-dispatched commit-Tasks. Finalizes Stories on `merging`. Only member that commits. **Never pushes by default.**         |
| `devops`    | 5      | claude      | Deploy / env / CI/CD / infra Tasks.                                                                                                                     |
| `dba`       | 6      | claude      | Schema + migrations + SQL (optional).                                                                                                                   |
| `member`    | 7…n    | any         | Lane workers — pull next claimable Task in their lane via `atmux claim --next`. **FE workers also own the TEST-lane capstone for UI Stories.**          |
| `ombudsman` | (event-driven) | claude (opt) | **Per-team complaint adjudicator** per [ADR-147](adr/147-ombudsman-and-release-notes.md). Reads `atmux complaints list --status open`, picks one of {file-epic, file-task, wontfix, already-addressed, defer} per complaint, appends day-file entry to `docs/release-notes/<Y>/<M>/<Y-M-D>.md` under `## Complaints adjudicated`. Wake via sentinel `.atmux/state/ombudsman-pending.json` + 15min `atmux ombudsman tick` cron line — NOT in whip cadence (ADR-147 §D2). |
| `whip`      | (cron) | —           | 5-min watchdog: pane state, rate-limits, stale Tasks, lead uptime. Escalates to the lead only when auto-recovery fails.                                 |

## Pull coordination

The kanban — `.atmux/kanban.json` — is the source of truth for work. Three top-level arrays:

```json
{
  "epics":   [ { "id": "e-…", "title", "body?", "driverRef?", "status",
                 "stories": [], "tasks": [], "createdAt", "completedAt?" } ],
  "stories": [ { "id": "s-…", "epic": "e-…", "title", "body?",
                 "acceptanceCriteria", "status", "reviewSignoff",
                 "mergeTaskId?", "createdAt", "completedAt?" } ],
  "tasks":   [ { "id": "t-…", "subject", "body", "status", "owner", "deps",
                 "priority", "epic?", "story?", "lane?", "deliverable?",
                 "createdAt", "claimedAt?", "completedAt?", "note?" } ]
}
```

`atmux::kanban_normalize` (in `lib/common.sh`) idempotently ensures `epics`/`stories`/`tasks` exist; legacy kanbans get the new arrays added on first mutation. `epic`/`story`/`lane`/`deliverable` on a Task are optional — missing reads as `null`.

### State machines

**Epic**: `planning → ready → in-progress → review → done`. The Epic auto-flips `in-progress → review` when its last child Task reaches `done` (storyless Epics) — and a `draft Epic summary` Task lands in the lead's inbox.

**Story**: `planning → ready → in-progress → testing → review → merging → done`. A Story auto-flips `testing → review` when its last open child Task is `done` AND that Task is in the `test` lane (TEST capstone). Reviewer advances `review → merging`; gitter advances `merging → done` once the commit chain is clean.

**Task**: `todo → in-progress → done` (or `blocked`). Tasks with non-`done` deps are filtered out of `claim --next` automatically.

### Pull selection

Workers run `atmux claim --next [--as <member>] [--lane <lane>]`. Selection (lib/claim.sh):

1. Filter Tasks: `status=todo`, `owner=null`, `deps - done_ids = []`.
2. First pass: `lane == caller's lane`. Sort by `priority asc, createdAt asc`. Pick first.
3. If empty AND `team.kanban.crossLaneClaim != false`: any lane, same sort.
4. Atomic claim: `jq_update` flips `owner`/`status`/`claimedAt` only if `owner` is still `null` post-read; race-aware with 3 retries.

Lane vocabulary: `fe` / `be` / `db` / `ops` / `test` / `review` / `misc`. UPPER-CASE in prose ("FE worker"), lowercase in JSON / `--lane` args.

### Auto-dispatch on Task done

When `atmux task move <id> done` lands (or `atmux done <id>`), `lib/kanban.sh` decides side-effects atomically inside one `jq_update`:

- **Always**: if the source Task has `.epic` set, append a new `commit <id>` Task targeting gitter (`owner=gitter`, `status=in-progress`, `lane=misc`, `claimedAt=now`, `epic=null` to prevent recursion). Mirror to `inboxes/gitter.json`.
- **Story testing → review flip**: if the moved Task is the last open child of its Story AND its lane is `test` AND the Story is currently `testing`, set `story.status=review`.
- **Storyless-Epic in-progress → review flip**: if the Epic has zero Stories AND the moved Task is the last open child of the Epic AND the Epic is `in-progress`, set `epic.status=review` AND append a `draft Epic summary <eid>` Task to the lead's inbox.

Each side-effect is gated by a flag computed before the write, so the filter stays read-only when the gate is off — idempotent on `done → done`.

```
                  ┌────────────────────────────────────┐
   member runs    │ atmux done t-aaa --note "feat: …"  │
                  └─────────────┬──────────────────────┘
                                │ kanban.json (atomic jq_update)
                                ▼
        ┌───────────────────────────────────────────────┐
        │ tasks[t-aaa].status = done                     │
        │ if .epic   → tasks += [commit-Task → gitter]  │
        │ if last test-lane child of testing Story      │
        │            → stories[s].status = review       │
        │ if last child of storyless in-progress Epic   │
        │            → epics[e].status = review +       │
        │              tasks += [Epic summary → lead]   │
        └───────────────────────────────────────────────┘
                                │
                                ▼
        gitter / reviewer / lead inbox updates land via
        _atmux_kanban_push_inbox (mirrors kanban → inbox)
```

## Driver → Lead routing

Two paths; use both:

1. **Durable**: `atmux tell-lead "..."` appends to `.atmux/driver-inbox.md`. Lead reads this first on every whip turn. Survives `/clear`, survives tmux restart.
2. **Immediate**: the same command also fires a short heads-up via `tmux send-keys` to the lead's pane. Gives the lead a nudge to check the inbox.

## Lead → Planner routing (pull model)

The lead does **not** decompose Tasks itself and does **not** `atmux dispatch` per-Task as the default flow:

1. **Lead reads `driver-inbox.md`**, decides Epic-shaped asks → `atmux send planner "<verbatim ask + driver-ref>"`.
2. **Planner runs `atmux epic add` → `atmux story add` (optional) → `atmux task add --epic <eid> --lane <lane> --deps …`**, then `atmux reply` to the lead with task IDs + dependency notes.
3. **Workers self-pull** via `atmux claim --next`. No manual dispatch by default; `atmux dispatch <member> <task-id>` is reserved for explicit driver-requested priority overrides.
4. **Decisions log**: `atmux decisions add "<question>" --default "<answer>" --reversibility low|medium|high` for any non-trivial auto-mode resolution. Logs to `.atmux/decisions.md` AND pings Discord. See [ADR-008](adr/008-decisions-verb.md).

## Whip (watchdog) — every 5 min

`atmux whip` checks:

1. Session liveness (is the tmux session up?).
2. Per-member pane: does `#{pane_current_command}` match the expected TUI binary?
3. Per-member banners: `rate-limit`, `Compacting conversation`, `Press up to edit queued messages`.
   - **Modal cycling** (per ADR-142, module `src/core/modal-cycling-detector.ts`): ≥N distinct modal-prompts within `modalCycling.windowMin` AND 0 commits in `commitGracePeriodMin` → fires `[whip-modal-cycling]` Discord + clarifier dispatch + flag. Sits one layer above the existing static-stuck classifier (which catches *same prompt repeating*); modal-cycling catches *different prompts in rapid sequence*, the pattern §1c missed on 2026-05-14 whip-impl. State at `~/.atmux/state/modal-history-<member>.json` + `modal-cycling-dedup-state.json`.
   - **Commit-cadence classifier** (per [ADR-148](adr/148-commit-cadence-truth-signal.md) §D2, module `src/core/cadence-classifier.ts` — landed by T5 / t-ac95b267, lifting the inline classifier T2 inlined in `src/verbs/status.ts`): pure `classifyCadence(logLines, nowSec, windowSec, thresholds)` + async wrapper `classifyMemberCadence(member, worktreePath, config, deps)` composing the canonical `git -C <path> log --since=<N>s --author=<member> --format=%H %ct` probe with classification. Emits four verdicts (`shipping` / `idle` / `dormant` / `ship-zero-window`) per ADR-148 §D2 table. Consumers: `atmux status` cadence column (T2), martinet `Observation.members[].cadence` field (T5 — escalation classifier in `src/core/martinet-escalation.ts` fires E6 on any member `ship-zero-window` verdict, alongside the pre-existing team-aggregate `commitCadence.last2hr === 0` path), Discord `[ship-zero-window]` template + medic event-driven pickup (deferred follow-up per ADR-140 chain).
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

## Release notes layout — `docs/release-notes/<Y>/<M>/<Y-M-D>.md`

Per [ADR-147](adr/147-ombudsman-and-release-notes.md) §D4, atmux ships a per-day release-notes file at `docs/release-notes/<YYYY>/<MM>/<YYYY-MM-DD>.md`. Year and month folders give navigability (`ls docs/release-notes/2026/05/` = month view); one file per day with append-only sections keeps cross-team writes conflict-free.

Every day-file follows a skeleton with append-only sections, each owned by a specific agent:

| Section                       | Written by                                                       |
|-------------------------------|------------------------------------------------------------------|
| `## Shipped (kanban→done)`    | gitter post-fan-in (or hygiene-tick backstop) per ADR-147 §D4    |
| `## Merges (branch→trunk)`    | gitter post-trunk-merge per ADR-145 + ADR-146                    |
| `## ADRs landed`              | hygiene-tick on detecting new `docs/adr/*.md`, or ADR author     |
| `## Complaints adjudicated`   | ombudsman per ADR-147 §D3                                        |
| `## Doctor regressions`       | medic on red-row escalation (optional; empty most days)          |
| `## Notes`                    | operator-curated narrative (optional; empty most days)           |

**Auto-create + idempotency**: the first writer of the day creates the file with all skeleton sections empty; subsequent writers append to their own section. No locking — section headers act as natural insertion anchors. The append-only invariant lets multiple agents write the same day-file safely (per ADR-147 §D4).

**Discovery**: `docs/release-notes/README.md` is the entry-point, documenting the layout convention + browsing pattern + auto-generated 30-day TOC (ADR-147 §D4).

**Cross-team monorepos** (ADR-090 epic-team scope, future): same physical file at repo root; each team writes only to its `### <team>` sub-section within `## Complaints adjudicated` to keep appends conflict-free (ADR-147 §D6).

**Doctor backstop**: probe `release-note-missing` (warn-class, NOT block) fires when today has ≥1 trunk commit AND today's day-file doesn't exist — backfill cue for ombudsman or hygiene-tick (ADR-147 §D5).

## Ombudsman wake — sentinel + cron (event-driven)

Per [ADR-147](adr/147-ombudsman-and-release-notes.md) §D2, the ombudsman role wakes on **events**, not whip cadence. Two writers + one reader define the protocol:

- **Sentinel file** — `.atmux/state/ombudsman-pending.json`: an array of complaint IDs (`c-xxxxxxxx`) awaiting first adjudication.
- **Write-through**: `atmux complaints file` appends the new `c-id` to the sentinel (same transaction as the DB insert, ADR-091 pre-flag #1 pattern). `atmux complaints resolve` removes the `c-id` (whether ombudsman wrote the resolution or operator manual-resolved).
- **Cron tick**: `atmux ombudsman tick --team <team>` runs every `team.ombudsman.tickIntervalMins` (default 15min). Fast-path no-op when sentinel is empty; wakes the ombudsman pane via `safeSendKeysWithVerify` ([ADR-138](adr/138-verified-send-keys.md)) with `atmux ombudsman work` when non-empty.

The sentinel + cron pair is chosen over pure socket-pubsub (ADR-032) because medic + whip-velocity-gate can file 5–10 complaints in a burst; batching the wake gives ombudsman the chance to drain in one session rather than wake-process-sleep × N. This matches the `groom-pending-judgment.json` pattern from the supergroomer parking-lot task (ADR-147 §D2 tradeoff section).

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
