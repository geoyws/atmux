# ADR-025: atmux-superdriver Phase 1 — read-only fleet aggregator

**Status**: accepted
**Date**: 2026-04-27

## Context

A driver running multiple atmux teams on a single host (e.g. `atmux-kanban` + `myteam-alpha` + future product teams) faces fragmented oversight:

- **No fleet view.** "What teams exist? Which are alive? Which have OPS gates pending?" — answered today by `tmux ls` + `cd <project> && atmux status` per-team. Linear in team count, no rollup.
- **Per-team tell-lead** is the only cross-context channel. Driver in superdriver context can't push a "rotate your lead and re-bootstrap" to `myteam-alpha` without `cd /path/to/myteam-alpha && atmux tell-lead "..."`. Friction discourages cross-team coordination.
- **No persistent registry of teams.** `~/.claude/teams/<uuid>/` directories exist (per-Claude-Code-session memory dirs) but don't enumerate atmux team projectRoots. Discovery is ad-hoc.

The driver chose **Phase 1 only** (Decision A): build a read-only fleet aggregator + safe write channel that goes through each team's existing tell-lead durability layer. Defer cross-team Task pushing, cross-team Epics, and whip-cycle for the superdriver to Phase 2 — only commit to those after Phase 1 logs at least one "I had to bypass tell-lead" incident.

Three architectural shapes considered:

- **A (chosen)** — registry at `~/.claude/teams/registry.json` (single source of truth) + 3 new verbs (`super-status`, `super-tell`, `super-attach`) + dedicated `atmux-superdriver` tmux session + brief at `templates/briefs/superdriver.md`. Read-only on cross-team state; writes go through each team's tell-lead chain.
- **B (rejected)** — symlink-based discovery: scan `/path/*/.atmux/team.json`. Implicit, brittle (relies on filesystem layout), no `lastSeen`/health metadata.
- **C (rejected)** — central daemon with IPC. Heavyweight; introduces a service to fail. Registry-as-file is consistent with atmux's "files are the durable handoff layer" pattern (per user memory `feedback_atmux_state_files.md`).

## Decision

**Team registry** at `~/.claude/teams/registry.json` (outside repo — global infrastructure):

```json
[
  {
    "name": "atmux-kanban",
    "projectRoot": "/root/work/src/atmux",
    "sessionName": "atmux",
    "createdAt": 1777246800,
    "lastSeen": 1777251074,
    "status": "running"
  }
]
```

- `lib/registry.sh` (NEW) — public helpers: `atmux::registry_upsert <name> <projectRoot> [<sessionName>]`, `atmux::registry_touch <name>` (updates lastSeen), `atmux::registry_deregister <name>`, `atmux::registry_list [--json]`. All writes flock-guarded via `~/.claude/teams/registry.json.lock` (mirrors kanban.json.lock pattern; per user memory the bare `jq+mv` write is the foot-gun being avoided).
- **`lib/init.sh` hook** — register team on `atmux init`. Uses team.json:.name + abs projectRoot at init time.
- **`lib/start.sh` hook** — touch lastSeen on every `atmux start`.
- **`lib/stop.sh` hook** — mark `status="stopped"` on graceful stop. Don't delete entry; preserves history.

**`atmux super-status`** (NEW verb, lib/super-status.sh):

Per-team digest:
- name + projectRoot + sessionName + status (running/stopped/stale)
- kanban rollup: todo / in-progress / blocked counts; OPS gates pending
- lead-outbox tail (last 3 entries) for active escalations
- `git log --oneline -5` on the registered projectRoot
- branch ahead/behind vs origin

Fleet-wide rollup:
- total teams (running/stopped/stale)
- promote-ready Epics across all teams
- cross-fleet stale claims
- idle teams (no commit + no lead-outbox activity > 24h)

Liveness check per entry: tmux session exists (via `tmux has-session -t <sessionName>`) + `.atmux/` dir present at projectRoot. Stale = registry says running but liveness fails. `--prune` flag prunes stale entries (operator-explicit; no auto-mutate from `super-status` reads). `--json` mode for downstream consumption (e.g. external dashboards).

**`atmux super-tell <team> <member> <msg...>`** (NEW verb, lib/super-tell.sh):

Resolves `<team>` via registry → projectRoot. Invokes target team's tell-lead durability chain:

- writes `<projectRoot>/.atmux/driver-inbox.md` (or `lead-outbox.md` reverse direction TBD per OQ)
- tmux send-keys heads-up to target's lead pane

NO bypass — same channel as a regular driver running `atmux tell-lead` inside the target project. Honors target's existing pane-state preflight (refuse on `thinking with` / `Compacting conversation` / `Press up to edit queued messages` per global CLAUDE.md "Always read pane state BEFORE tmux send-keys"). Audit trail preserved per-team.

**`atmux super-attach`** (NEW verb, lib/super-attach.sh):

`tmux attach -t atmux-superdriver`. If session absent, spawn:
- single window, single Claude pane.
- launch `claude --model claude-opus-4-7` (lead-class judgment).
- inject brief from `templates/briefs/superdriver.md` via tmux send-keys after pane is ready.

**`templates/briefs/superdriver.md`** (NEW) — brief instructions:

- Verb cadence: ON-DEMAND only (NO whip-cycle in Phase 1; per driver decision).
- Day shape: read super-status digest → triage cross-team escalations → super-tell to push asks downstream.
- Discipline: read-only on cross-team state; writes go through super-tell chain (which itself goes through each team's tell-lead durability). NO direct kanban writes to other teams.
- Phase 2 carve-out: when you find yourself wanting to bypass tell-lead, log the incident in `~/.claude/teams/superdriver-bypass-log.md` for driver review. Resist the bypass; surface the incident.

**Sonnet vs Opus**: superdriver runs Opus (`claude-opus-4-7`). It's not narrative-formatter-only; it makes cross-team coordination calls. Per ADR-024 (revised) judgment-on-correctness on others' work = Opus.

## Consequences

- **`~/.claude/teams/registry.json`** (new file, outside repo). Single source of truth for "what teams exist."
- **`lib/registry.sh`** (~80 LOC) — flock-guarded helpers; read-mostly with idempotent upsert.
- **`lib/init.sh` / `lib/start.sh` / `lib/stop.sh` hooks** — ~5 LOC each (one helper call).
- **`lib/super-status.sh`** (~120 LOC) — per-team digest assembly + fleet rollup + JSON mode + --prune.
- **`lib/super-tell.sh`** (~40 LOC) — registry lookup + invoke target's tell-lead chain via `cd <projectRoot> && atmux tell-lead "..."` OR direct file-write + tmux send-keys (cleanest implementation TBD per OQ).
- **`lib/super-attach.sh`** (~30 LOC) — attach-or-spawn pattern.
- **`bin/atmux` dispatcher** — 3 new verb routes (super-status / super-tell / super-attach).
- **`templates/briefs/superdriver.md`** (new).
- **3 bats specs** — `tests/unit/registry.bats` (concurrent writes, corruption recovery, upsert idempotence), `tests/unit/super_status.bats` (multi-team mock + JSON shape + --prune), `tests/unit/super_tell.bats` (happy path + pane-state preflight refuse + audit trail).
- **README** documents the superdriver Phase 1 surface + when to use it + Phase 2 deferral rationale.
- **No impact on existing teams** — registry hooks are additive in init/start/stop; absent registry.json triggers create-on-first-write.
- **Cost trade-off accepted**: superdriver session burns Opus tokens on read-only digest composition. ON-DEMAND mitigates (no idle whip cycle). Driver invokes when needed; otherwise zero.
- **Phase 2 trigger documented**: bypass-log entry threshold not pre-set; driver judgment after Phase 1 sees real usage.

## Risk register (driver-flagged; planner mitigations)

| Risk | Driver flag | Mitigation |
|---|---|---|
| Registry corruption from concurrent atmux start/stop | yes | flock on registry.json.lock — mirrors `kanban.json.lock` pattern; bare jq+mv writes are foot-gun (per user memory). |
| Cross-team tmux send-keys collision | yes | super-tell honors target's pane-state preflight (refuse on `thinking with` / `Compacting` / queued). Same `_atmux_pane_busy` shape as `atmux send`. |
| Stale registry entries (team killed without atmux stop) | yes | super-status liveness check (tmux session exists + .atmux/ dir present) marks `stale`; `--prune` flag for operator-explicit cleanup. NO auto-mutate from reads. |
| Privacy / blast (super-status reads ALL teams' state) | yes | acceptable on the-host (single-user box); document in ADR + README. Multi-tenant deferred indefinitely. |
| Registry race during init across concurrent project-creation | derived | flock-guarded `atmux::registry_upsert` is atomic; idempotent on duplicate names (last-write-wins on lastSeen). |
| Symlink farm in projectRoot (worktrees) | derived | `realpath` projectRoot before storing in registry; canonical paths only. |

## Open questions

1. **OQ G1 (low): registry.json location?** Resolved: `~/.claude/teams/registry.json`. Driver-specified. (low-rev — schema-stable.)
2. **OQ G2 (medium): registry concurrency model?** Resolved: flock on `~/.claude/teams/registry.json.lock`. Mirror kanban.json.lock pattern. Bare `jq+mv` writes rejected per user memory `feedback_destructive_worktree_overwrite.md`. (medium-rev — could fall back to bare jq+mv if flock proves contended; very unlikely on single-host fleet.)
3. **OQ G3 (low): super-status default output format?** Resolved: human (powerline-style, similar to `atmux status`). `--json` flag for downstream consumption. (low-rev.)
4. **OQ G4 (medium): super-tell pane-state preflight — refuse vs queue?** Resolved: refuse with clear error message + suggest retry after pane clears. Same shape as `atmux send`. (medium-rev — could add `--queue` flag later for batch-tell scenarios.)
5. **OQ G5 (low): superdriver session name?** Resolved: `atmux-superdriver`. Driver-specified. (low-rev.)
6. **OQ G6 (medium): super-attach when session absent — auto-spawn vs refuse?** Resolved: auto-spawn (driver brief: "spawning if absent"). Single-window Claude with brief auto-injected. (medium-rev — could split into separate `super-spawn` verb if auto-spawn proves invasive.)
7. **OQ G7 (low): registry schema lastSeen format?** Resolved: epoch seconds (consistent with kanban claimedAt / completedAt). (low-rev.)
8. **OQ G8 (medium): stale registry entry pruning — --prune required vs auto-prune?** Resolved: `--prune` flag required. NO auto-mutate from `super-status` reads (mirror reviewer/planner read-only-on-others'-state discipline). (medium-rev — could add auto-prune-on-stop hook later if --prune adoption proves low.)
9. **OQ G9 (low): super-tell file-write vs cd+tell-lead invocation?** Resolved: file-write directly + tmux send-keys to target's lead pane. Avoids cd subshell complexity + preserves super-tell as a thin wrapper. (low-rev — implementation choice.)

All resolutions logged to `.atmux/decisions.md`.
