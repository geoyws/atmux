# atmux

**atmux** — *agent teams multiplexer.* One tmux session per project team, one tmux window per agent.

> 🎮 **Driver** (you) → 🧭 **Team Lead** → 🐝 **Team Members** — coordinated through tmux, not an API.

> **State storage.** Per [ADR-126](docs/adr/126-sqlite-state-store.md) +
> ADR-076 (inbox JSON elimination — file pending; see commits `27d80ee` →
> `5c16432`), kanban + inboxes + per-feature state live in **`.atmux/state.db`**
> (SQLite, WAL). The bash dispatcher was retired in the bun cutover —
> `bin/atmux` is now a TS shim into `src/cli.ts`. Diagrams + prose below that
> still reference `kanban.json` describe legacy teams not yet migrated;
> readers are dual-path (SQL-canonical when `state.db` exists, else JSON).
> Operators upgrading run `atmux migrate-state` once per team root — see
> §State layout for the migration runbook.

A tmux-native multi-TUI agent orchestrator. Runs a fleet of coding-agent terminals (Claude Code, Cursor, OpenCode, Kimi) in parallel, with a kanban task board, per-member inboxes, a 5-minute whip watchdog, and a 30-minute progress digest to Discord.

**Why not just Claude Code everywhere?** Because Claude is expensive and not every task needs it. With atmux, the **staff** (lead, planner, reviewer, committer, devops, dba) stay on Claude because they need the reasoning, while **workers can be Cursor Composer 2, MiniMax, or Kimi** for cheaper parallel throughput per feature lane. The driver (you, in a Claude Code REPL) talks to the lead; the lead routes to the planner (decomposition); workers **pull** their next Task from the kanban; committer commits; the reviewer signs off Stories; the lead writes the Epic summary back to the driver.

## Agile vocabulary

atmux's kanban speaks Epic / Story / Task. The pull model only works when you keep these distinctions clear.

- **Epic** — a feature or initiative scoped by the driver. State machine: `planning → ready → in-progress → review → done`. The driver hands the lead an Epic-shaped ask via `atmux tell-lead`; the lead routes it to the planner (`atmux send planner`); the planner decomposes it into Stories + Tasks. When every child Task is `done`, the Epic auto-flips to `review` and a "draft Epic summary" Task lands in the lead's inbox — the lead composes the wrap-up via `atmux epic show` + `git log` and `atmux reply`s back to the driver.

- **Story** — a coherent slice of an Epic with explicit acceptance criteria. State machine: `planning → ready → in-progress → testing → review → merging → done`. **Stories are OPTIONAL.** Small Epics with ≤3 Tasks skip them. Use Stories when there are multiple distinct acceptance surfaces (schema vs. UI vs. e2e). Reviewer signoff happens at the Story level on the cumulative diff — empty `acceptanceCriteria` is an automatic REJECT.

- **Task** — an atomic unit of work on the kanban with a lane (FE / BE / DB / OPS / TEST / REVIEW / MISC), optional `--epic` / `--story` tags, optional `--deliverable`, and explicit `--deps`. Workers **pull** the next claimable Task in their lane via `atmux claim --next`; selection prefers their lane, falls back across lanes when `crossLaneClaim=true` (default). Each Task with `.epic` set auto-dispatches a commit-Task to committer on `move done`; one commit per Task, no batching.

The **lead never decomposes and never dispatches per-Task** — that's the planner's and the kanban's job. The lead routes Epics to the planner, watches state, surfaces blockers, and composes Epic summaries. The **committer never reviews** and never pushes by default. The **reviewer never commits** and never decomposes. Each role has a narrow surface; the kanban orchestrates.

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
│  │ 🧭 lead    │  │ 🗺️  planner │  │ 🔍 reviewer│  │ 🌿 committer  │   │
│  │ ROUTES     │  │ DECOMPOSES │  │ STORY GATE │  │ COMMITS    │   │
│  └──┬─────────┘  └─────┬──────┘  └──────┬─────┘  └────┬───────┘   │
│     │ atmux send       │ atmux           │ atmux        │ on every  │
│     │ planner          │ epic add        │ story        │ Task done │
│     │                  │ story add       │ advance      │ (auto-    │
│     │                  │ task add        │ --to merging │  dispatch)│
│     │                  │  --epic --lane  │              │           │
│     ▼                  ▼                 ▼              │           │
│  ┌────────────────────────────────────────┐              │           │
│  │ 📋 state.db (Epics + Stories + Tasks)  │ ◄────────────┘           │
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
│  shared state: .atmux/{team.json,state.db,decisions.md,lead-outbox.md}│
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
atmux status                  # team pulse + commit-cadence column (ADR-148)
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

### Per-member worktree isolation (opt-in)

By default every member in an atmux team shares one working tree — `team.json` writes the same `cwd` for all members, and `atmux start` spawns each member's TUI against that single directory. At 10+ concurrent members this fails in three observed ways (see ADR-082 §Context for the full incident log):

1. **`lint-staged` + submodule-`m`-state silently absorbs unrelated content.** Husky's stash/unstash dance during one member's commit can sweep up another member's untracked-or-unstaged edits into the index. The 2026-05-08 SOPX session lost a `docs/adr/` draft this way.
2. **`git stash push` for hook-bypass or branch-switch sweeps other members' WIP** into the stash entry. Recovering requires `git stash show -p` archaeology.
3. **Concurrent `git add -A` races bundle other members' staged files into the wrong commit.** Observed three times in the 2026-05-12 atmux session — commit `99e4879` is the live example, bundling SPEC-063 work alongside ADR-082 W1 (see [ADR-082 §Bundle history](docs/adr/082-worktree-isolation-per-member.md#bundle-history)).

**Per-member worktree isolation** moves each member into their own `git worktree` at `<atmuxDir>/worktrees/<member>/` on their own branch `<base>-<member>` (e.g. `geoyws-up-impl`). The `.git` directory stays shared (git's worktree mechanism hardlinks objects, so disk cost is workdir-only); the working trees + indexes are isolated, so a sibling's `git add -A` cannot reach another teammate's staged files.

**When to pick it.** ≥10 concurrent members — atmux-team itself at 11+, sopx-guild at 19+, cockpit-aggregated teams approaching 30. Most ≤3-member teams do NOT need this — leave the field unset.

```json
{
  "worktreeIsolation": true
}
```

`worktreeRoot` is a relative path resolved against `atmuxDir`; defaults to `.atmux/worktrees` and rarely needs override.

**What changes when set:**

- `atmux start` provisions one worktree per member via `git worktree add -b <base>-<member> <wtPath> <base>` BEFORE spawning each member's TUI. The base branch is whatever the parent worktree currently has checked out; per-member branches are idempotent (existing `<base>-<member>` branches re-used on re-provision).
- Each member's `tmux new-window` `cwd` is overridden to their isolated path — they only see their own `git status`, their own staged files. The on-disk `team.json` `cwd` is unchanged.
- `atmux stop --force` calls `git worktree remove` for each *clean* worktree; **dirty worktrees are skipped** with a warning (never silently destroy uncommitted work). The `<base>-<member>` branch is left behind by default; add `--prune-branch` (requires `--force`) to also delete each pruned worktree's branch via safe `git branch -d` (unmerged branches refuse the delete and are surfaced as a warning — operator escalates to `git branch -D` manually).
- `atmux stop` (no `--force`) does NOT prune. Worktrees survive normal stop+start cycles.
- `atmux doctor` adds four worktree probe classes:
  - `worktree-missing` — isolation on but no worktree dir for a member (auto-fixable: re-provision via `--fix`).
  - `worktree-orphan` — worktree dir for an unknown-member name (auto-fixable via `--fix`).
  - `worktree-wrong-branch` — worktree on a branch other than `<base>-<member>` (surface-only; operator decides).
  - `worktree-disabled-but-present` — isolation off but worktrees exist on disk (surface-only).

**Trade-offs:**

- **Wins.** Stash-eat collisions structurally impossible. The husky/lint-staged submodule-`m`-state absorption (CLAUDE.md global rule on "Hooks, Commits, Tooling") becomes a non-issue at the worktree boundary. The parallel `git add -A` race that bundled W1 + SPEC-063 cannot happen — each member's index is separate.
- **Costs.** Push conflicts become **visible** where they were silently stash-eaten before; two members editing the same file on `<base>-A` vs `<base>-B` discover the conflict at merge-back time. Net-positive for ops visibility; net-negative for "everything just merges" muscle memory. Disk: N members × working-tree size (atmux ≈ 50MB/member, sopx-guild ≈ 1.2GB/member); `.git` objects hardlinked so growth is workdir-only.

**Rollback** — one-line revert:

```bash
jq '.worktreeIsolation = false' .atmux/team.json | sponge .atmux/team.json
atmux stop --force --prune-branch                          # prunes clean worktrees + safe-deletes merged branches
atmux start
```

`--prune-branch` is opt-in (requires `--force`) and only deletes branches whose worktrees were successfully pruned. Unmerged branches refuse the delete (no `-D` escalation); those + dirty-worktree branches stay for the operator to handle, per the "destructive git ops need explicit auth" rule.

**Known gaps (post-MVP):**

- **Submodules currently shared.** sopx has 5+ submodules; per-member submodule worktrees would 5× the disk + provisioning cost. MVP keeps submodules shared, so cross-member edits *inside* a submodule can still race. File a follow-up ADR if demo prep exposes need (ADR-082 OQ4).
- **Committer alignment is operator-defined.** The committer role can either commit on its own `<base>-committer` worktree (default — symmetric with other members), or commit on the parent repo's `<base>` directly (legacy pattern — keeps the committer outside the per-member namespace). ADR-084 OQ-3 leaves this to the operator; both work.

The init wizard does not prompt for this field — opt-in is a manual `team.json` edit, since the field is for sopx-class (≥10 member) setups. See [docs/adr/082-worktree-isolation-per-member.md](docs/adr/082-worktree-isolation-per-member.md) (provision / prune / probe shapes + the original MVP rationale) and [docs/adr/084-worktree-per-member-branch-model.md](docs/adr/084-worktree-per-member-branch-model.md) (per-member branch model amending OQ6).

### Renaming a team

`atmux team rename` renames a team **atomically across every surface** the team-name appears in: `team.json:.name`, tmux session, the cockpit team-viewer window (per [ADR-135](docs/adr/135-cockpit-naming-convention.md) — only the team-viewer window carries the team-name; per-member windows are NOT touched), cron markers, the cockpit registry (`cockpit.json::sessions[]` DFS — see ADR-089 §B), and the single-session capture file. Rollback-staged orchestration plus refuse-gate preflight (in-progress kanban, name collision, invalid charset) — the verb refuses unsafe states up front rather than half-committing on failure ([ADR-027](docs/adr/027-team-rename-verb-and-topology-invariant.md)).

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
3. `tmux rename-window` for the cockpit team-viewer window matching the bare `<old>` name → `<new>` (per [ADR-135](docs/adr/135-cockpit-naming-convention.md) §window-naming: cockpit team-viewer carries the team name; per-member `<emoji>-<member>` + cockpit-role `_<role>` + epic-viewer `🌳-<eid>` windows do NOT carry team-name and are NOT touched). If `--session <new-session>` differs from the current session name, `tmux rename-session` runs too.
4. Rewrite `state/session.txt` for single-session teams.
5. **Cron re-install with NEW marker first, then remove the OLD marker.** Install-new-then-remove-old is the explicit ordering — avoids any window where the team has zero cron coverage (per ADR-027 OQ H3). Brief overlap of two markers is harmless; whip is flock-guarded so duplicate fires no-op.
6. Cockpit registry update: DFS-walk `cockpit.json::sessions[]` (per [ADR-089](docs/adr/089-recursive-cockpit-sessions.md) §B) for the `type: "team"` node matching `<old>`; mutate `.name = <new>` in place. Legacy flat `teams[]` rosters auto-lift to the canonical `sessions[]` shape on first rename via `migrateLegacyShape`. Child epic-team nodes' `.name` fields are NOT touched — only the renamed team's own `.name` is mutated.
7. Clear `rename.lock`.
8. Return success.

**Rollback semantics.** Any step ≥2 failure triggers reverse-order rollback: cron re-remove → `state/session.txt` restore → `tmux rename-window` back → `tmux rename-session` back → `team.json` restore from backup → registry rollback → clear lock. The full attempt log writes to `<projectRoot>/.atmux/state/rename-rollback.log` for operator inspection.

Rollback is **best-effort**. Some terminal failure modes (the tmux session dying mid-rename, registry write contention with a parallel `atmux start`) require manual recovery — the rollback log records what was attempted and what state the operator is left holding. The verb logs a final `manual recovery: see rename-rollback.log` line so the failure can't pass silently.

**Historical entries are NOT rewritten.** `kanban.json` archive entries, `lead-outbox.md`, `driver-inbox.md`, and `decisions.md` retain old-team-name references in their archived bodies — archive-don't-rewrite. New entries written after the rename use the new name. Operators grepping for the old name reach the archive layer directly; this preserves auditability across the rename boundary at the cost of one mental "this was named differently before" step on grep.

`.atmux/` itself is **not moved** — the directory is pinned to `projectRoot`, not to the team name.

### Audit — declarative drift detection

Operational state drifts from declared intent over time: a tmux session gets hand-renamed, a team migrates to a new cage path naming convention but stragglers remain, an empty cage dir gets left behind after `atmux stop`, a tmux config glyph gets locale-blind-downgraded to `_` after a rename. `atmux audit` is the declarative-vs-live drift detector ([ADR-038](docs/adr/038-declarative-live-audit-model.md)) — it reads the three sources of truth (`team.json`, `~/.claude/teams/registry.json`, `~/.tmux.conf`), compares to live tmux + filesystem state, and classifies every finding into one of six classes with documented blast-radius and auto-fix gating.

```bash
atmux audit                       # detect-only; human render of findings
atmux audit --quiet               # whip's sub-pass shape: exit 0 green / 1 drift, no output
atmux audit --json                # findings array for whip / external dashboards
atmux audit --fix                 # apply fixes; defaults to safe classes (D, E, F)
atmux audit --fix --class a       # narrow to a specific class
atmux audit --dry-run             # print fix plan, no mutations (default for blast≥medium)
```

**Class taxonomy + remediation gating:**

| Class | Name | Detector signal | Blast | Auto-fix? | Runbook |
|---|---|---|---|---|---|
| **A** | driver-window naming | `tmux list-windows` shows bare `driver` instead of `__<team>__driver` | medium | ✅ gated on driver-pane idle (no claude REPL, no modal, no rate-limit banner) | `atmux audit --fix --class a` (whip auto-fires when idle; surfaces `⚠️` otherwise) |
| **B** | cage path separator | `team.json:.tmuxTmpdir` matches old hyphen form `/tmp/atmux-tmux-*` instead of `/tmp/atmux_tmux_*` | high | ❌ surface only — driver fires | wraps `lib/team-repair-rename.sh` with rollback per [ADR-027](docs/adr/027-team-rename-verb-and-topology-invariant.md) |
| **C** | window position drift | driver pane window position ≠ 1 OR team-lead position ≠ 2 | high | ❌ surface only — driver fires | `tmux swap-window` × N, no atomic wrapper today |
| **D** | rename residue | window name has trailing-dash or partial-match pattern (`__ifca_aix__🪄lead-`) | low | ✅ | strip trailing dash via `tmux rename-window` |
| **E** | stray empty cage dirs | `/tmp/atmux-tmux-*` or `/tmp/atmux_tmux_*` exist with no live socket AND no registry entry | low | ✅ | `rmdir` with `[ -z "$(ls -A)" ]` guard |
| **F** | tmux config glyph mismatch | per-cage `tmux show-option -gv status-left` ≠ `~/.tmux.conf`-derived expansion (locale-blind tooling downgrades nerd-font glyph to `_`) | low | ✅ | `atmux tmux-conf-restore <cage-socket>` shared primitive |

**Auto-fix gating policy.** Low-blast (D, E, F) auto-fires; pane state irrelevant — D/F are tmux metadata, E is filesystem. Medium-blast (A) auto-fires only when the driver pane is at shell idle (no `claude` REPL, no `Compacting conversation`, no `Press up to edit queued messages`, no rate-limit modal); on not-idle, surfaces as `⚠️` with the ready-to-fire command for driver review. High-blast (B, C) **never** auto-fires — surfaces with `⚠️` only; driver fires after eyeballing.

**When to invoke.**

- **Ad-hoc**: after a fleet-wide convention shift (an ADR amendment, a rename burst, a manual `tmux` op that touched topology) — `atmux audit` shows the drift inventory; pick fixes class-by-class.
- **Whip auto** (per [ADR-040](docs/adr/040-audit-whip-integration.md)): every 5-min whip tick invokes `atmux audit --quiet --fix` as a sub-pass; low-blast classes auto-fire, medium gates on idle, high surfaces. Zero operator action required for D/E/F drift.
- **Daily backstop**: a once-a-day cron (operator opt-in) ensures classes that whip might have skipped (target pane busy all day) eventually surface. Phase 2 of the enforcer agent (ADR-039) may take this over fleet-wide.

**Fleet scope.** Per-team is the default invocation. Fleet aggregation walks `~/.claude/teams/registry.json`, runs the per-team audit on each entry, and rolls up findings — that's the **enforcer** role's job ([ADR-039](docs/adr/039-enforcer-agent-role.md)). Cross-team patterns (≥2 teams hitting the same class = convention shift, not 3 independent bugs) become visible at fleet scope.

**Convergence with ELEVATION.** When the ELEVATION manifest + reconciler ships, `atmux audit` becomes a thin wrapper around `atmux diff --class drift` (detect) + `atmux apply --selected-class <a|b|c|d|e|f>` (fix). The class taxonomy migrates verbatim; gating policy survives. The class vocabulary (A–F + future additions) is the durable artifact.

**See also**: [ADR-038](docs/adr/038-declarative-live-audit-model.md) (audit model + sources of truth + class taxonomy + per-class detector/fixer pair pattern); [ADR-039](docs/adr/039-enforcer-agent-role.md) (fleet-level enforcer agent that aggregates per-team audit findings); [ADR-040](docs/adr/040-audit-whip-integration.md) (whip sub-pass that auto-fires safe classes); `docs/audit.md` (operator guide — runbooks per class).

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

### Unblocker role

Optional dedicated blocker-triage member, spawned at `role=unblocker, lane=misc`. Reads pane state + kanban every 2 minutes, classifies wedged work, and routes the unblock action — surface-only, never claims, never plans, never auto-mutates the kanban.

**What it does.** Per [ADR-021](docs/adr/021-unblocker-role.md): on a 2-min cron tick, enumerates `tasks[]` with `status == "blocked"` OR (`status == "in-progress"` AND `claimedAt` mtime > 30 min with no commit-Task downstream). For each candidate, captures the assigned member's pane (`tmux capture-pane`) + recent activity, then classifies into one of **WEDGED** (modal/permission/rate-limit banner — surface to `lead-outbox.md` for `/team clear` approval), **IDLE** (no progress > 30 min — nudge via `atmux send <member>`), **LEGITIMATELY-SLOW** (active build/e2e — no action), or **WEDGED-WITH-DRIVER-NEEDED** (escalate to `driver-inbox.md` tagged `🚨 needs driver`). See `templates/briefs/unblocker.md` for the per-tick loop and action-authority table.

**When to add it.** The lead's whip cycle bundles dispatch + rotation + Discord composition + blocker triage into a single 5-min budget. As teams grow past **~4–5 members** and stale `in-progress` claims start slipping past a full whip tick, the lead's blocker-triage attention gets crowded out. A dedicated unblocker at 2-min cadence isolates the cost. Skip it for small teams (≤3 members) — the lead's whip is enough.

**How to add it.** No config edit needed; `atmux add-member` does the team.json mutation + spawn:

```bash
atmux add-member unblocker --role unblocker --tui claude --lane misc --cwd "$PWD"
```

For `role=unblocker` the `--lane` flag is honored verbatim (`misc` is conventional but `--lane` accepts any of `{fe,be,db,ops,test,review,misc}`). Standard member spawn — `+1 window` per team. To pause while idle: `atmux pause unblocker`. To remove permanently: `atmux remove-member unblocker`.

**Cadence + Discord behaviour.** `lib/cron.sh::atmux::cron_install` emits a `*/2 * * * * … atmux unblocker tick` line when `team.json` has a member with `role: unblocker` (otherwise no-op). The unblocker itself **does not send Discord pings directly** — its outputs are:

- **Nudges** — `atmux send <member>` (tmux send-keys; no Discord).
- **Surfaces** — `atmux flag add` (writes `flags.md`; the lead picks up the `flag-add` socket event per [ADR-032](docs/adr/032-socket-pubsub-messaging-layer.md) and composes a `whip-blocker` Discord ping at its next whip tick).
- **Driver escalations** — appended to `.atmux/driver-inbox.md` (no Discord; driver reads on-demand).

The unblocker is the *detector*; the lead remains the urgent-Discord *voice*. (When a discorder is also present, scheduled `whip-progress` digests will mention surfaced blockers inline as a bullet — see [ADR-022](docs/adr/022-discorder-role.md).)

**See also**: [ADR-021](docs/adr/021-unblocker-role.md) (role rationale + per-tick spec + open questions); `templates/briefs/unblocker.md` (canonical brief loaded at spawn time).

### Discorder role

Optional dedicated narrative-composition member, spawned at `role=discorder, lane=misc`. Owns the team's **scheduled** Discord pings — 30-min `whip-progress` digest + 60-min `whip-heartbeat` — while the team-lead keeps the **urgent** voice (`whip-blocker`, `whip-decisions`, `whip-critical`). Read-only on kanban / git-log / decisions; never claims, never plans, never sends urgent pings.

**What it does.** Per [ADR-022](docs/adr/022-discorder-role.md): on a scheduled cron tick, snapshots the kanban (SQLite `state.db` post-ADR-076) + recent commit log + new entries since the last decisions cursor, composes a `whip-progress` digest body matching the canonical `~/.claude/CLAUDE.md` Discord-format rule (header + bulleted body + per-bullet emoji), and routes via `~/.claude/skills/whip/scripts/ping-discord.sh`. Hourly the same loop fires a `whip-heartbeat` — single bullet, "team alive, last commit Nm ago, kanban: todo=X / in-progress=Y." See `templates/briefs/discorder.md` for the per-tick loop, the section discipline, and the one-line escalation rule (anything that needs judgment-on-correctness routes to lead via `atmux send lead`).

**Ownership split.** The lead retains every event-driven ping; the discorder owns the routine narrative:

| Ping template          | Owner       | Why                                                                     |
|------------------------|-------------|-------------------------------------------------------------------------|
| `whip-blocker`         | **lead**    | Caused by the lead's own dispatch + coordination events.                |
| `whip-decisions`       | **lead**    | High-rev decisions interrupt the driver in real time; lead authored.   |
| `whip-critical` / 🚨   | **lead**    | Same urgency tier — lead saw it, lead pings.                            |
| `whip-progress` (30m)  | **discorder** | Routine narrative summary. Composes 200–400 tokens — bigger than lead's coordination budget can absorb every tick. |
| `whip-heartbeat` (60m) | **discorder** | Same shape: routine, no judgment-on-correctness.                        |
| `team-bootstrap`       | **lead**    | Lifecycle event — lead's authority.                                      |

**When to add it.** Bundling narrative composition into the lead has two costs: (1) the 200–400 token progress-digest compose competes with the lead's dispatch attention every 30 min, and (2) the same role writing both urgent and routine creates tone drift — either heartbeats sound too urgent or blockers sound too summary-style. Add a discorder once the team is **≥4 members** AND the lead's progress-digest pings are starting to ship late or feel rushed. Smaller teams don't generate enough narrative volume to justify the extra member; the lead can absorb it. Skip it for solo or 2-member teams.

```bash
atmux add-member discorder --role discorder --tui claude --lane misc --cwd "$PWD"
```

For `role=discorder` the model is **Sonnet** (`claude-sonnet-4-6`) per [ADR-024](docs/adr/024-per-member-model-selection.md) — pure narrative formatter, no judgment-on-correctness. The discorder is the **single carve-out** from the global "Team members always use Opus" rule (`~/.claude/CLAUDE.md` Model Selection §). Standard member spawn — `+1 window` per team. To pause while idle: `atmux pause discorder`. To remove permanently: `atmux remove-member discorder`.

**Cadence + cron behaviour.** `lib/cron.sh::atmux::cron_install` emits two scheduled lines when `team.json` has a member with `role: discorder`:

```
*/30 * * * * … atmux discorder progress    # 30-min progress digest
0    * * * * … atmux discorder heartbeat   # 60-min heartbeat
```

The legacy `atmux report` cron line — pre-discorder, lead-composed report — is **auto-suppressed** when a discorder member exists (cron-rewrite skips that block on next `atmux start`). Manual `atmux report` still works for one-off invocations from any context, regardless of discorder presence; only the cron auto-fire is suppressed to avoid duplicate routine pings into the channel.

**See also**: [ADR-022](docs/adr/022-discorder-role.md) (role rationale + ownership split + open questions); `templates/briefs/discorder.md` (canonical brief loaded at spawn time); [ADR-024](docs/adr/024-per-member-model-selection.md) (per-member model + the discorder Sonnet carve-out).

### Ombudsman role

Optional per-team complaint-adjudicator member, spawned at `role=ombudsman, lane=misc` (emoji `⚖️`). Per [ADR-147](docs/adr/147-ombudsman-and-release-notes.md) §D1, reads open complaints (filed by medic / whip-velocity-gate / operator / CLI), triages each into one of five outcomes (file epic / file task / wontfix / already-addressed / defer), and writes its adjudication entry to the day's release-notes file. Surface-only on the code side — never claims code Tasks, never plans, only writes kanban + complaint resolutions.

**Why**: the complaint *filing* side has named owners (medic per ADR-077, whip per ADR-177), but the *adjudicating* side has none — open complaints linger indefinitely until the operator triages them by hand. Ombudsman closes that loop per ADR-147 §Context.

**Wake mechanism** (per [ADR-147](docs/adr/147-ombudsman-and-release-notes.md) §D2): **event-driven, NOT whip-polled**. A sentinel file `.atmux/state/ombudsman-pending.json` is written-through by `atmux complaints file|resolve`; a cron line `atmux ombudsman tick` (default 15min via `team.ombudsman.tickIntervalMins`) fast-paths no-op when the sentinel is empty and wakes the ombudsman pane via verified send-keys ([ADR-138](docs/adr/138-verified-send-keys.md)) when non-empty. Lane-tick MUST NOT inject `atmux claim --next --as ombudsman` — the role is outside the pull-model cadence.

**Adjudication authority** (per ADR-147 §D3): for each open complaint, file an epic (`atmux task add --epic`), file a single task, mark `wontfix` (with rationale), mark `resolved` (citing the SHA/ADR that already addressed it), or defer (leaves sentinel entry for next tick). Every action also appends a one-line entry to the day's release-notes file `docs/release-notes/<Y>/<M>/<Y-M-D>.md` under `## Complaints adjudicated`. See ADR-147 §D4 for the day-file layout.

**When to add it.** Once a team has accumulated ≥3 open complaints + the operator finds themselves triaging them manually each session. Skip for teams with no medic / no velocity gate (complaint volume too low to warrant the role).

**How to add it.** No config edit needed; `atmux add-member` does the team.json mutation + spawn:

```bash
atmux add-member ombudsman --role ombudsman --tui claude --lane misc --cwd "$PWD"
```

**See also**: [ADR-147](docs/adr/147-ombudsman-and-release-notes.md) (role rationale + release-notes layout + sub-task decomposition); `templates/briefs/ombudsman.md` (canonical brief, ships with ADR-147 T4); `docs/release-notes/README.md` (the layout convention this role writes to per ADR-147 §D4 Discovery).

### Enforcer role

Optional fleet-level audit consumer member, spawned on the **superdriver team** at `role=enforcer, lane=misc`. Walks `~/.claude/teams/registry.json` per tick, invokes `atmux audit --json` per registered team, aggregates findings, and routes by class — surface-only, never claims, never plans, never auto-fires high-blast fixes.

**What it does.** Per [ADR-039](docs/adr/039-enforcer-agent-role.md): on each ON-DEMAND tick, reads `atmux super-status --json` + per-team `atmux audit --json` (per [ADR-038](docs/adr/038-declarative-live-audit-model.md)) and classifies every finding into one of four shapes — **fleet-wide pattern** (≥2 teams hitting the same audit class — surface as a digest entry to driver via `super-tell` OR append to `~/.claude/teams/superdriver-bypass-log.md`), **isolated finding** (one team only — no-op; whip's per-team auto-fix already owns it), **ambiguous medium/high-blast** (whip surfaced as `⚠️` — propose a fix command + safety gate; surface to driver), or **convention regression suggesting new class** (draft an ADR-038 amendment + route via planner). Maintains `docs/audit.md` operator guide + the ADR-038 class table via the planner ADR flow. See `templates/briefs/enforcer.md` for the per-tick loop, action-authority table, and channel matrix.

**When to add it.** Per-team `atmux audit` is necessary but not sufficient: cross-team patterns (a class hitting 3-of-4 teams = fleet-wide convention shift, not 3 independent bugs) are invisible to per-team whip. Add an enforcer once the fleet has **≥2 teams** running `atmux audit` and you've noticed yourself grepping across team logs by hand to spot patterns. Skip it for a single-team setup — there's nothing to aggregate. The role is opt-in on the superdriver team only; existing per-team teams need no change.

```bash
# Superdriver team's team.json — manual edit (wizard not yet aware of enforcer):
atmux add-member enforcer --role enforcer --tui claude --lane misc --cwd "$PWD"
```

For `role=enforcer` the model is `claude-opus-4-7` with `CLAUDE_CODE_EFFORT_LEVEL=xhigh` per [ADR-024](docs/adr/024-per-member-model-selection.md) — cross-team audit is judgment-heavy work, not mechanical pattern-matching, so Sonnet is *not* the right fit (ADR-039 §B3). Standard member spawn — `+1 window` on the superdriver team.

**Cadence + Discord behaviour.** **ON-DEMAND in v1**, mirroring the superdriver itself ([ADR-025](docs/adr/025-superdriver-phase-1.md)) — NO cron schedule, NO whip cycle. Driver invokes after fleet-wide changes (ADR amendments, convention shifts, post-incident sweeps). The enforcer's outputs are:

- **Digests** — `atmux super-tell driver "<digest>"` (cross-team, real-time; no direct Discord).
- **Async audit log** — appended to `~/.claude/teams/superdriver-bypass-log.md` (driver reviews at next `super-attach`).
- **ADR amendment drafts** — routed to the superdriver team's planner via `atmux send planner` (planner integrates via the normal ADR flow; enforcer never bypasses planner).
- **Operator guide updates** — `docs/audit.md` edits routed via planner review.

The enforcer is the *cross-team aggregator*; the planner remains the ADR *author*; the driver remains the high-blast *decider*. Phase 2 may add a low-cadence cron (e.g. daily 06:00) — deferred until v1 logs ≥3 missed-pattern incidents per ADR-039 §Open questions B2.

**See also**: [ADR-039](docs/adr/039-enforcer-agent-role.md) (role rationale + per-tick spec + role taxonomy comparison); [ADR-038](docs/adr/038-declarative-live-audit-model.md) (the audit model + class taxonomy enforcer consumes); `templates/briefs/enforcer.md` (canonical brief loaded at spawn time).

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

### Migrating off the Claude `/team` skill

Operators coming from the Claude `/team` skill family (`/team rotate-lead`, `/team clear <member>`, bootstrap brief paste-in) still have a `.claude/team.json` on disk that drifts the moment atmux owns the canonical roster at `.atmux/team.json`. `atmux sync claude-team-json` materializes the Claude-side file from the atmux-side one so both surfaces stay aligned without hand-edits ([ADR-164](docs/adr/164-sync-claude-team-json.md)).

```bash
atmux sync claude-team-json --dry-run        # preview the diff (no write)
atmux sync claude-team-json                  # atomic write of .claude/team.json
atmux sync claude-team-json --overwrite-briefs   # replace hand-authored long-form roles
atmux sync claude-team-json --force          # override drift refusal (after reviewing diff)
```

Preserve-by-default protects hand-authored long-form `role` text on the Claude side; drift detection refuses re-sync (exit `65`) when the file was hand-edited since the last sync. Color sidecar `.claude/team-colors.json` lets operators paint specific emoji-or-member combos. See [docs/RUNBOOK-sync.md](docs/RUNBOOK-sync.md) for the full operator flow.

### Discord palette per team

When multiple atmux teams ping into the same Discord channel, the team-name backticks alone aren't enough to distinguish pings at a glance — under load (20+ pings/hour, 2–3 teams), the wall blurs together. atmux solves this by rendering each ping as a Discord webhook **embed** with a **per-team color** (a curated 16-color dark-theme palette) and a **leading glyph** in the embed title.

**Default (no config — works out of the box).** Each team gets a deterministic auto-color via `sha256(team-name)[0] mod 16` → palette index. `atmux-kanban` always renders one fixed color, `myteam-alpha` always another — no operator config required, and the assignment is stable across restarts.

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
keep coordination turns cheap, Claude only for reviewer / committer:

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
| `committer`          | `claude`    | Commit msg + hooks discipline                 |
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
| `committer` | Opus | commit composition + lint-staged-trap + scope-check |
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

Same precedent as the model field above ([ADR-024](docs/adr/024-per-member-model-selection.md)) — a sugar layer on top of Claude Code's built-in `CLAUDE_CONFIG_DIR` env var. Set `claudeAccount` per member in `team.json` to declaratively route members across multiple Claude Max accounts (cost balance, rate-limit headroom, account-scoped scopes for internal-vs-personal work):

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

**Operator-shell env scrub.** `atmux start` strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `CLAUDE_CONFIG_DIR` from the cage tmux session's environment after `new-session`. This is defense-in-depth for member.command / tuiCommands paths that bypass tuiClaude's own `env -u` prefix (bug t-4d2936ac, 2026-05-14 incident): without the scrub, an operator running `atmux start` from a shell with `ANTHROPIC_API_KEY` exported would have every claude pane fall into env-key bearer mode + hit the "Do you want to use this API key?" dialog every spawn. The scrub is unconditional + idempotent — no operator action needed before invoking `atmux start`.

## Commands

```
🏁 Setup
atmux init [--wizard] [--force] [--name <team>]
atmux start [--force]
atmux stop [--force] [--no-archive] [--prune-branch]
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
atmux story add <title> --epic <eid> [--ac <text>] [--body <text>] \
                                     [--merge-mode feature-branch|trunk-direct]  # ADR-175
atmux story list --epic <eid> [--status <s>] [--json]
atmux story show <id>
atmux story advance <id> [--to <state>]             # feature-branch: planning→ready→in-progress→testing→review→merging→done
                                                    # trunk-direct:   planning→ready→in-progress→testing→review→done  (ADR-175)
atmux story signoff   <id> [--as <m>] [--note <t>]  # Flip review-signoff bit + audit append (ADR-175 GAP 1)
atmux story unsignoff <id> [--as <m>] [--note <t>]  # Revert review-signoff (pre-merging only; ADR-175 GAP 1)
atmux task add <subject> [--body <txt>] [--epic <eid>] [--story <sid>] \
                         [--lane fe|be|db|ops|test|review|misc] \
                         [--deliverable <text>] [--assignee <m>] [--deps <id,id>] [--priority <n>]
atmux task list [--status …] [--assignee <m>] [--json]
atmux task show <id>
atmux task move <id> <todo|in-progress|done|blocked>   # done auto-dispatches commit-Task to committer
atmux task assign <id> <member>
atmux task lane <id> <fe|be|db|ops|test|review|misc|git|docs|->     # `-` clears lane
atmux task priority <id> <N|->                                       # `-` clears priority (treated as default 99)
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
atmux improve [--budget <spec>] [--status]   # eternal-improvement loop (ADR-052)
              [--dry-run] [--default-budget]
              [--idle-fallback] [--force]
atmux whip-resume-check [--no-discord]       # 1-min auto-resume cron precision (ADR-053)
              [--team-dir <dir>]
atmux watchdog [--no-discord]                # 2-min heartbeat staleness detector (ADR-057 §D6b)
              [--team-dir <dir>]
atmux pulse [--json] [--ping] [--config <p>] # 5-min cockpit-wide verdict probe (ADR-086)
atmux hygiene-tick [--team-dir <d>]          # superdoctor kanban-hygiene pass (ADR-131)
              [--no-json]                    #   one auto-fix per tick via severity/confidence ladder

🔧 Maintenance
atmux rotate <member>
atmux rotate-lead
atmux handoff <from> <to> [--reason <r>] [--no-native] [--pause-from]
atmux add-member <name> --role <r> --tui <t> [--model <m>] [--cwd <d>] [--command <c>]
atmux member rename <id> --label <new>       # hot-rename display label (ADR-136)
atmux member move <id> --to <position>       # relocate member's tmux window (ADR-161 §C)
atmux member swap <id-a> <id-b>              # pairwise window swap (ADR-161 §C)
atmux member sort [--defaults-first]         # canonical reorder (ADR-161 §C)
atmux reconfigure                            # re-run wizard on existing team
atmux dashboard [--interval <s>]             # live full-screen panel

🩺 Fleet topology + orphan reap (ADR-222 + ADR-223)
atmux topo [--tree] [--orphans] [--json]                  # read-only fleet manifest + classifier
           [--team <name>] [--since <iso>]                # scope filters
atmux topo --reap [--apply] [--yes] [--class <name>]      # destructive — dry-run by default
           [--skip-checks] [--json]                       # see docs/RUNBOOK-topology.md

🚢 Release
atmux release <patch|minor|major>            # one-shot deploy: bump package.json + commit
              [--dry-run] [--allow-dirty]    # + bun run build:install + git push (ADR-183 sibling — t-c3f4c418)
                                             # exit 0=ok, 64=usage, 65=dirty/no-op refused, 70=step failure
```

## 📡 Commit-cadence column (ADR-148)

`atmux status` surfaces a per-member **cadence** column — the canonical truth-signal for "is this member shipping?" per [ADR-148](docs/adr/148-commit-cadence-truth-signal.md). The column reads the member's worktree git log directly (`git -C <worktree> log --since=<windowSec>s --author=<name>`) and renders one of four verdicts:

| Verdict | Trigger | Display |
|---|---|---|
| `shipping` | ≥1 commit in window AND last commit `< shippingMaxAgeSec` (default 30 min) | `🟢 shipping (5min)` |
| `idle` | 0 commits in window AND last commit `< idleMaxAgeSec` (default 2h) — could resume soon | `🟡 idle (1h2m)` |
| `ship-zero-window` | 0 commits in window AND age `≥ shipZeroWindowSec` (default 2h) — escalation flag per ADR-132 §E6 | `🚨 ship-zero (3h)` |
| `dormant` | 0 commits in window AND age `≥ dormantMaxAgeSec` (default 6h) | `🔴 dormant (15h)` |

Per-member exemption (planners during long decomp passes, reviewers during multi-commit audit reviews) lands in `team.json::cadence.exemptMembers`; those rows render `(exempt)`.

Cadence is the truth signal — **pane-state is the proxy.** The companion `pane-state` column (formerly `state`) shows the cage-state taxonomy (`active`/`wedged`/`bootstrapping`/`down`); use it for "is the process running?" diagnostics, NOT for "is work happening?" verdicts.

Config under `team.json::cadence` — all fields optional, defaults applied per ADR-148 §D7:

```jsonc
{
  "cadence": {
    "enabled": true,
    "windowSec": 1800,
    "thresholds": {
      "shippingMaxAgeSec": 1800,
      "idleMaxAgeSec":     7200,
      "dormantMaxAgeSec":  21600,
      "shipZeroWindowSec": 7200
    },
    "laneStallEnabled":   true,
    "laneStallMinAgeSec": 1800,
    "exemptMembers":      []
  }
}
```

JSON output (`atmux status --json`) gains `members[].cadence` with the full observation shape: `windowSec`, `commitsInWindow`, `lastCommitAt`, `lastCommitSha`, `ageOfLastCommitSec`, `verdict`.

## 🌱 Eternal-improvement (ADR-052)

`atmux improve` — kanban-empty fallback to autonomous self-improvement loop. See [`docs/adr/052-eternal-improvement.md`](docs/adr/052-eternal-improvement.md). When the team's kanban hits empty, instead of `atmux stop` firing the cage dies, `atmux improve` decomposes "what can we improve on?" into kanban Tasks, dispatches them, loops cycles bounded by a token budget (default `30%-wk`), and only stops when the budget is exhausted AND kanban is still empty. Two modes share one implementation: **Mode A** (user-invoked — driver runs `atmux improve [--budget <spec>]` any time) and **Mode B** (idle-fallback — whip's ADR-043 hook intercepts the auto-stop with `--idle-fallback --default-budget`). Today's `kanban-empty → auto-stop → manual restart` becomes `kanban-empty → improve cycles → auto-stop`. State at `.atmux/state/eternal-improvement.json`.

## State layout

Everything lives in `.atmux/` at the project root (or wherever `ATMUX_DIR` points):

```
.atmux/
├── team.json              # source of truth: members, roles, TUIs, models
├── state.db               # SQLite canonical store: Epics + Stories + Tasks +
│                          #   per-member inbox messages + complaints + handoff
│                          #   state (ADR-060 + ADR-076)
├── decisions.md           # append-only auto-mode-resolution log (markdown)
├── flags.md               # member → lead structured issues (markdown)
├── lead-outbox.md         # member → driver (`atmux reply` writes; markdown)
├── driver-inbox.md        # legacy stub; use `atmux tell-lead` (markdown)
├── inboxes/               # legacy JSON files — writer no-ops post-ADR-076,
│                          #   state.db is canonical. Old teams keep these
│                          #   alongside until `atmux migrate-state` lands them.
├── logs/
│   ├── send-<member>.log
│   ├── whip.log
│   └── report.log
├── state/
│   ├── session.txt        # tmux session name captured at start (ADR-026)
│   ├── lead-session-start.txt # epoch seconds; whip uses for lead uptime
│   └── …                  # per-feature anchor files (rotated.epoch, etc.)
└── archive/<timestamp>/   # created on atmux stop
```

> **JSON → SQLite cutover (ADR-076).** Pre-0.5.0 atmux kept the kanban + per-
> member inboxes as JSON files. Phases 1–5 (released in 0.5.0) collapsed both
> into `state.db`. Operators upgrading existing teams: run `atmux migrate-state
> --target=tasks --target=inboxes` once on each team root to backfill the
> SQLite store from the legacy JSON, then `atmux start` thereafter reads SQL-
> canonical. Legacy `kanban.json` is left in place as a deprecation stub; the
> per-file `inboxes/*.json` writes become no-ops on SQL-canonical teams.

## Conventions

Two rules govern how atmux verbs emit state to agents. Both target the same problem — token cost on long-running teams — at different layers. Reviewer flags violations of either rule during signoff.

### Agents see slices, never full state files

Every callsite (in `src/` post-bun cutover; historically `lib/*.sh`) that reads from `.atmux/state.db` (or the legacy `kanban.json`, `decisions.md`, `flags.md`, `lead-outbox.md`, `driver-inbox.md`) for **agent-facing output** narrows to an explicit slice — by status, lane, member, story, epic, or recency window — before emitting. Whole-state emit is reserved for tooling-internal callsites (`atmux groom`, `atmux doctor`, `atmux audit`).

Concrete defaults:

- `atmux task list` emits ID/subject/status/owner only; full body via `--full`.
- `atmux claim --next` returns just the claimed Task (ID + subject + body + deps), never the surrounding kanban.
- `atmux inbox <member>`, `atmux status` emit per-member-and-current-state slices.
- `atmux super-status` emits a per-team summary, never per-team kanban contents.

Token math (informal — atmux dogfood team, ~1.2 MB historical kanban):

| Read shape                | Tokens     | When                                  |
|---------------------------|------------|---------------------------------------|
| Whole kanban (`state.db`) | ~300K      | groom / doctor / audit (admin tools)  |
| Per-purpose slice (SQL)   | ~500–2K    | every claim, every inbox, every tick  |

Per-tick win: ~99% of kanban-read budget on long-running teams. See [ADR-041](docs/adr/041-token-savings-kanban-slicing.md) for the per-callsite audit table + slice helper inventory.

### `--full` flag — operator escape hatch

`--full` bypasses the default slice and emits whole content. Reserved for:

- Operator debug at the shell (`atmux task list --full | grep …`).
- Tooling-internal callsites (groom, doctor) that traverse the whole kanban by design.

`--full` in agent-facing context is a discipline regression — the reviewer flags it during signoff. If you need richer info inside an agent loop, pull a per-purpose slice (`atmux task list --status todo --epic <id>`, `atmux task show <id>`) instead of `--full`-ing the whole kanban into your context window.

### Stable-first, churn-last brief ordering

Member briefs (`templates/briefs/*.md`) are paste-targets for every spawned pane and the dominant input to the Anthropic prompt cache (5-min TTL). Ordering matters:

1. **Top — stable preamble.** Role identity, channels matrix, ADR cross-refs, lane vocabulary. Cached across the whole session.
2. **Middle — semi-stable rules.** Per-loop cadence, what-you-do / what-you-don't, hard rules.
3. **Bottom — pointers to churning state.** `state.db` (tasks / inbox rows), `lead-outbox.md`, `flags.md`. The pointers are stable; the *stores they point at* churn faster than the cache TTL, so the references go LAST so the cached preamble survives every tick.

See [ADR-041 §Prompt-cache discipline](docs/adr/041-token-savings-kanban-slicing.md) for the full rationale + claim-reply / `task list` / whip-prelude levers. Roll-out is incremental (per ADR-041 OQ D2 resolution): each brief touched in normal evolution gets reordered if needed; reviewer flags ordering on changes. Mass restructure was rejected — cache-discipline wins are cumulative.

<!-- per ADR-217 §D7 -->
## 🛠️ Skills (`/atmux:` namespace)

atmux ships with a Claude Code plugin bundling 12 cockpit-tier skills (`/atmux:bruh`, `/atmux:team`, `/atmux:tell-lead`, `/atmux:whip`, etc.) at [`plugins/atmux/`](plugins/atmux/). Each wraps a recurring multi-step atmux workflow so operators can drive a fleet without memorising the full verb surface. Install via the `atmux init` wizard (per [ADR-200](docs/adr/200-install-wizard-guided-first-run-setup.md)) or manually symlink `plugins/atmux/` into `~/.claude/plugins/atmux/`.

| Skill                       | What it does                                                              | Calls atmux verb              |
|-----------------------------|---------------------------------------------------------------------------|-------------------------------|
| `/atmux:bau`                | Business-as-usual status check + auto-escalate dormant teams to lead.     | `atmux status / report` (read) |
| `/atmux:bruh`               | Unblocker sweep — decisions / blockers / flags / worktrees in one pass.   | `atmux flags / decisions / inbox` |
| `/atmux:bruhloop`           | 15-min `/atmux:bruh` cadence sugar wrapping `/loop`.                      | (chains to `/atmux:bruh`)     |
| `/atmux:budget`             | Live rate-limit probe across every Claude account, prints utilisation.    | (pure-shell — Anthropic API)  |
| `/atmux:cockpit-rebuild`    | Deterministically (re)build the cockpit + every per-team cage.            | `atmux cockpit rebuild`       |
| `/atmux:ghostbuster`        | Sweep mergeable epic-team branches; merge what's ahead, prune stale.      | `atmux epic-merge / git`      |
| `/atmux:heads-up <msg>`     | Lightweight nudge to teammates about new tasks / cascade unblocks.        | `atmux send`                  |
| `/atmux:session`            | Session continuity (cont / preclear / handoff / stop) at phase boundaries.| `atmux handoff`               |
| `/atmux:sweep`              | Cockpit-level self-healing diagnosis-and-prevention sweep.                | `atmux doctor / status`       |
| `/atmux:team`               | Team lifecycle (start / stop / add / clear / cleanup / rotate-lead).      | `atmux team / start / stop`   |
| `/atmux:tell-lead <msg>`    | Driver → lead durable ask with best-effort pane wake-up.                  | `atmux tell-lead`             |
| `/atmux:whip`               | Autonomous-work nudge loop (run / cadence / watchdog verbs).              | `atmux whip`                  |

**Install posture (per [ADR-217](docs/adr/217-atmux-skills-plugin-bundled-and-wizard-installed.md) §D5):**

- **Optional** — wizard prompts `[Y/n/s]` (yes / no / show-list). Skip with `atmux init --no-skills`; re-install later with `atmux init --skills-only`.
- **Symlink not copy** — atmux upgrades automatically refresh bundled SKILL.md bodies via the symlink target. No manual re-install needed to pick up newer skill behavior.
- **Operator dotfiles override preserved** — if `~/.claude/plugins/atmux/` already exists as a real directory (not a symlink), the wizard preserves it + prints a notice. Operators who maintain their own per-skill customizations keep them.
- **Doctor probe** — `atmux doctor` adds an `atmux-skills-plugin` row surfacing install state (green when symlinked + `plugin.json` validates; yellow when missing / malformed; info-level when opted out at wizard time).

See [`plugins/atmux/README.md`](plugins/atmux/README.md) for the full per-skill reference + uninstall instructions.

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
| `ATMUX_CURSOR_FORCE`                 | `1`                                          | Append `--force` (Auto-run); set `0` to disable     |
| `ATMUX_CURSOR_APPROVE_MCPS`          | `1`                                          | Append `--approve-mcps`; set `0` to disable           |
| `ATMUX_CURSOR_ARGS_EXTRA`            | _(empty)_                                    | Extra args appended after `--model`                   |
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

When the driver runs more than one atmux team on a single host (e.g. `atmux-kanban` + `myteam-alpha` + future product teams), per-team oversight fragments fast: "what teams exist? which are alive? which have OPS gates pending?" is answered today by `tmux ls` + `cd <project> && atmux status` per team — linear in team count, no rollup. Per-team `tell-lead` is the only cross-context channel, so pushing a "rotate your lead" to `myteam-alpha` from any other shell costs a `cd` + an inbox edit. **atmux-superdriver Phase 1** is a read-only fleet aggregator + safe write channel that goes through each team's existing `tell-lead` durability layer — no new write surface to learn, no new audit trail to police.

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
atmux super-tell myteam-alpha lead "rotate-lead — uptime over 4h, context rotting"
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

- **Registry-as-file** at `~/.claude/teams/registry.json` — single source of truth for "what teams exist." Atomic writes (`jq | mv` with a sidecar lock) mirror the per-team kanban writer pattern; bare `jq > file` is a documented foot-gun and intentionally not used.
- **Read-only on cross-team state.** `super-status` reads any registered team's `state.db` / `lead-outbox.md` / git state but never writes. The only sanctioned cross-team writes are `super-tell` (which goes through each team's `tell-lead` chain) and `super-status --prune` (operator-explicit registry cleanup).
- **NO bypass of `tell-lead`.** Every cross-team write routes through the target team's existing durability layer — no separate cross-team kanban, no shadow audit trail.

### Phase 2 deferral

These verbs / behaviors are **explicitly deferred to Phase 2** and DO NOT exist in Phase 1:

- Cross-team Task pushing (writing directly into another team's `state.db`).
- Cross-team Epics that span multiple teams' kanban stores.
- Cross-team conflict arbitration that edits both teams' state.
- Superdriver whip-cycle (recurring 5-min/30-min digest from the superdriver pane).

The Phase 2 commit gate is empirical: when the superdriver finds itself wanting to bypass `tell-lead` (push directly, arbitrate, write a cross-team Epic), it logs the incident in `~/.claude/teams/superdriver-bypass-log.md` with timestamp + situation + what it wanted to bypass + **why the `tell-lead` chain was insufficient**. Driver reviews the log periodically; consistent themes drive a Phase 2 ADR. Empty log after weeks of use = Phase 1 was sufficient.

### Risk register summary

| Risk | Mitigation |
|---|---|
| Registry corruption from concurrent atmux start/stop | flock on `registry.json.lock` mirrors the kanban-lock pattern; bare `jq + mv` rejected. |
| Cross-team tmux send-keys collision | `super-tell` honors target pane's preflight (refuse on `thinking with` / `Compacting` / queued). |
| Stale registry entries (team killed without `atmux stop`) | `super-status` liveness check (tmux session + `.atmux/` dir) marks `stale`; `--prune` for operator-explicit cleanup — NO auto-mutate from reads. |
| Privacy / blast (super-status reads ALL teams) | Acceptable on the-host (single-user box). Multi-tenant deferred indefinitely. |

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

## Install (dev / dogfooding)

The default `install.sh` puts atmux at `~/.atmux-src/` and symlinks `/usr/local/bin/atmux` there. Fine for users.

For atmux **maintainers** who want their dev edits to be the runtime atmux (immediate dogfooding feedback, no `git pull` lag), point the symlink directly at the dev tree:

```bash
# One-time bootstrap — symlink directly at the dev clone:
ln -sf /path/to/atmux-dev/bin/atmux      /usr/local/bin/atmux
ln -sf /path/to/atmux-dev/bin/atmux-tmux /usr/local/bin/atmux-tmux
```

Optional second tier — keep a `/opt/atmux-stable/` "tested fallback" maintained by `scripts/autopromote.sh` (hourly cron: pull origin/main → run tests → rsync to `/opt/atmux-stable/` only if tests don't regress). When a dev edit breaks runtime atmux, swap the symlink in one line:

```bash
# Swap to stable fallback:
ln -sf /opt/atmux-stable/bin/atmux      /usr/local/bin/atmux
ln -sf /opt/atmux-stable/bin/atmux-tmux /usr/local/bin/atmux-tmux

# Swap back to dev when fixed:
ln -sf /path/to/atmux-dev/bin/atmux      /usr/local/bin/atmux
ln -sf /path/to/atmux-dev/bin/atmux-tmux /usr/local/bin/atmux-tmux
```

The atmux binary is **self-locating** (`bin/atmux` walks `BASH_SOURCE` symlinks to find `lib/` + `templates/`) — no env var or shell-side state required. atmux changes are picked up immediately on the next `atmux <verb>` call; **sourcing `~/.zshrc` is NOT needed** for runtime updates. (Optional shell completions DO require sourcing on update — that's standard for any tool with completion.)

**Don't** create manual `cp -r` snapshots of `/opt/atmux-stable/` (e.g. `.bak.<TS>` dirs) — they accumulate without retention and clutter `/opt/`. Git history at the promoted SHA is the rollback handle. Full rationale: `docs/adr/047-canonical-install-topology.md`.

## Troubleshooting

**"My whip stopped pinging."** Run `atmux doctor`. It surfaces two cron-related conditions:

- `cron-config` (yellow) — atmux cron entries point at a different `ATMUX_DIR` than the current project. Common after the project moved on disk (rename, relocation, fresh checkout under a new path). Fix: `crontab -e` and update the path, or re-run `atmux start` from the new path.
- `cron-orphan` (yellow) — a marker block exists for a team whose `ATMUX_DIR` is missing on disk (e.g. you `rm -rf`'d a worktree without `atmux stop`). Fix: `atmux doctor --fix` prunes the orphan block automatically, or `crontab -e` to remove by hand.

**"I don't want atmux touching my crontab."** Set `kanban.cronAutoInstall: false` in `team.json` before the first `atmux start`. If you've already started, `atmux stop` removes the block, then add the opt-out, then `atmux start` again.

### Preflight: logout-kill exposure

**Why it matters.** On modern Linux (systemd ≥230), `KillUserProcesses=yes` is the stock default. When your SSH session ends, systemd-logind reaps the entire user cgroup — your tmux server, every atmux team in it, and any orphan helper scopes all die together. The 2026-04-26 incident on the-host cost both `myteam-alpha` and `atmux-kanban` their mid-flight state when an SSH session-3.scope ended; whip cron survived (it lives in crontab, outside the user session) and proceeded to ping Discord with "session DOWN" every 5 min until manually disabled. The fix is one `loginctl` call, but the **detection** has to happen before you start the team.

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
  ⚠️  topology:myteam-alpha        session=atmux has 11 windows but team.json expects 12 members
     → audit member-by-member: tmux list-windows -t atmux | grep '^__myteam-alpha__'
  ❌ topology:myteam-beta-root         registry says session=atmux-myteam-beta but 5 windows live in atmux
     → atmux team rename myteam-beta-root --session atmux --migrate-session OR atmux team rename myteam-beta-root --session atmux-myteam-beta
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
