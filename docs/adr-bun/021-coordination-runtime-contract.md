# ADR-021: atmux as the runtime for `/coordination:session` + `/coordination:team` skills — verb contract

**Status:** accepted (intent); implementation deferred to Phase 4 post-cutover
**Date:** 2026-05-05
**Owner:** driver

## Context

The `/coordination:session` and `/coordination:team` skills (in `~/.claude/skills/coordination/skills/{session,team}/SKILL.md`) are ~600 LOC of shell logic that:

- Read `.claude/team.json` to discover team name + member list.
- Detect tmux mode (driver / lead-window / solo / no-team) by inspecting `__{team}__team-lead` windows.
- Write/read `~/.claude/teams/<team>/lead-session-start.txt` lead-uptime markers, `~/.claude/teams/<team>/driver-inbox.md` ask queue, `~/.claude/teams/<team>/lead-outbox.md` reply queue, `~/.claude/teams/<team>/lead-window-name.txt` window-name resolver.
- Write handoff files at `~/.claude/projects/<project-slug>/todo/<branch>/handoff.md` (canonical) plus `{cwd}/HANDOFF.md` (dual-harness duplicate).
- Spawn / shut down teammate windows via `tmux send-keys` + the `--agent-id @{team}` claude flag.
- Route a graceful shutdown handshake (`shutdown_request` / `shutdown_response`) with a 90s timeout.

Every one of these artifacts is **owned conceptually by atmux** — atmux is the binary that creates `.atmux/`, defines team membership, runs the kanban + inbox state machine, and spawns the tmux windows. The skill is an **orchestrator** that reads + writes atmux's artifacts using shell + `tmux` directly because no `atmux` verb exposes the operation. Splitting "team coordination" between atmux (the binary) and the skill (the orchestrator) is the seam to collapse: the skill should be a thin shim over atmux verbs, not a parallel implementation.

This is in scope for atmux because:

1. The skill **already** reads `.claude/team.json` + writes to `~/.claude/teams/<team>/`. atmux owns those paths.
2. atmux already ships `team` semantics inside the binary — `add-member`, `start`, `stop`, `attach`, `rotate`, `rotate-lead`, `handoff`, `dispatch`, `claim`, `done`, `tell-lead`, `reply`, `outbox`, `pause`, `resume` all touch the same surface. The missing pieces are session-lifecycle (preclear / cont) and team-state-management (cleanup / bootstrap / clear-member / rotate-member).
3. ADR-018 (`/coordination:*` skills integration contract) already pins immediate items I-1 (lead-uptime marker) + I-2 (window-name detection) as atmux-owned. ADR-021 widens the scope from "atmux exposes a few markers the skill reads" to "atmux exposes the full coordination surface; skill becomes a 1-page shell shim."

## Decision

### 1. Two new verb namespaces — `atmux session <verb>` + `atmux team <verb>`

Mirror the established `atmux task <verb>` pattern. Single top-level verb-IDs in §6.2 (`session` and `team`) cover all sub-verbs each — they are the stable handles, not the sub-verbs.

#### `atmux session <verb>`

| Sub-verb | Skill counterpart | Summary |
|---|---|---|
| `cont` | `/session cont` | Resume after `/clear`. Mode-detect (driver / lead-window / solo / no-team). Read handoff. Cross-check TaskList drift. Surface unresolved decisions. **In solo mode**, emit handoff content + standing decisions to stdout (currently the skill only re-dispatches to teammates; ADR-021 pins solo behavior as explicit). |
| `preclear` | `/session preclear` | Save the current session's coordination state (handoff + memory + tasks). Mode-aware: driver = sanity+exit; solo/lead = full save. Never destructive. |
| `handoff` | `/session handoff` | Write a forward-going brief for a fresh claude in a new worktree/branch. Distinct from `preclear`. |
| `stop` | `/session stop` | End-of-day full shutdown — `team stop` + `team cleanup` + `[FULL-STOP]`-marked handoff. |

Note: `atmux session stop` and `atmux team stop` differ — the session verb is end-of-day composite (kills team + writes shutdown handoff), while `team stop` is the graceful-shutdown primitive. Sub-verb dispatch disambiguates.

#### `atmux team <verb>`

Collapses **integration item I-4** (`/coordination:team` skill shim). Sub-verbs match the skill's current verbs verbatim:

| Sub-verb | Skill counterpart | Summary |
|---|---|---|
| `start` | `/team start` | (Re)spawn all non-lead members. Today's `atmux start` covers some of this; new `team start` wraps it with the skill's mode-detection + live-lead guard. |
| `stop` | `/team stop` | Graceful shutdown handshake (90s budget). Today's `atmux stop` is force-kill-tmux-session; `team stop` is the protocol-aware variant. |
| `add` | `/team add` | Wraps existing `atmux add-member` plus the skill's spawn-into-running-team logic. |
| `clear` | `/team clear` | Single-member `/clear` + re-brief. Refuses for `team-lead`. |
| `cleanup` | `/team cleanup` | Zombie window/process/inbox sweep. |
| `bootstrap` | `/team bootstrap` | First-run bootstrap for a freshly-spawned lead window. |
| `rotate-lead` | `/team rotate-lead` | Lead self-clear + re-bootstrap. Composite of `preclear` + `/clear` + bootstrap. |
| `rotate-member` | `/team rotate-member` | Checkpoint a teammate's state to file, then `/clear` + re-brief. |

Existing top-level verbs (`atmux start`, `atmux stop`, `atmux add-member`, `atmux rotate`, `atmux rotate-lead`) **remain** as primitives. `atmux team <verb>` is the protocol-aware orchestrator; the bare verbs are the runtime mechanics. ADR-021 does not deprecate `atmux start` etc. — `team start` calls into `start` after running mode-detection + guard logic.

### 2. Skill becomes a thin shim

Post-implementation, each `SKILL.md` shrinks to a one-page dispatcher:

```bash
case "$verb" in
  cont)     atmux session cont "$@" ;;
  preclear) atmux session preclear "$@" ;;
  handoff)  atmux session handoff "$@" ;;
  stop)     atmux session stop "$@" ;;
  *)        echo "Usage: /session <verb>"; exit 1 ;;
esac
```

…plus the LLM-facing prose blocks (when-to-use, mode-detection rationale, etc.). The shell logic (mode detection, file writes, tmux spawns, shutdown handshake) **moves into atmux**. The skill keeps:

- Slash-command discoverability (LLM sees `/session preclear`).
- LLM-facing documentation (when-to-use, dual-harness routing, mode rationale).
- Dual-harness branching (`orch_create` vs `tmux send-keys`) — atmux verb invokes the underlying harness; skill chooses which atmux variant to call.

### 3. Path canonicalization

Pin once, atmux writes them:

| Artifact | Canonical path | Owner | Notes |
|---|---|---|---|
| Handoff (session-continuity) | `~/.claude/projects/<project-slug>/todo/<branch>/handoff.md` | atmux writes; skill reads | Global (cross-tool). `<project-slug>` = repo root path with `/` → `-`. |
| Handoff (dual-harness duplicate) | `{cwd}/HANDOFF.md` | atmux writes when `.opencode/` or `CONT.md` present | Gitignored. Convenience for OpenCode harness. |
| Lead-uptime marker | `~/.claude/teams/<team>/lead-session-start.txt` | atmux writes on lead spawn / rotate-lead; clears on stop | I-1 (already in §6.3). |
| Lead-window-name | `~/.claude/teams/<team>/lead-window-name.txt` | atmux writes on lead spawn | I-2 (already in §6.3). Resolved via `atmux which lead [team]`. |
| Driver-inbox (asks queue) | `~/.claude/teams/<team>/driver-inbox.md` | atmux writes; skill + lead read | **Resolves I-3.** Global path wins over `.atmux/driver-inbox.md` because lead is global-scoped (rotates across worktrees) and the inbox must survive `/clear` + worktree-switch. The `.atmux/driver-inbox.md` path used in some bash code paths is **deprecated** by this ADR. |
| Lead-outbox (replies queue) | `~/.claude/teams/<team>/lead-outbox.md` | atmux writes (member-side `atmux reply`); driver reads | Global; same rationale as driver-inbox. Today's `atmux reply` + `atmux outbox` already use this path under one of two fallbacks — atmux stops fallback, makes it canonical. |
| Last-discord-flush marker | `~/.claude/teams/<team>/last-discord-flush.txt` | atmux writes; whip + report read | Already used by V-21 report. |

### 4. Solo-mode `cont` behavior

When `atmux session cont` runs in solo mode (no `__{team}__team-lead` window detected), it:

1. Reads handoff.md.
2. Surfaces handoff content + standing decisions **to stdout** for the human REPL to read.
3. Cross-references TaskList (`atmux task list`) for in-flight work + drift.
4. Does NOT dispatch resume tasks (no teammates to dispatch to).

Currently the skill's `cont` only re-dispatches to teammates. ADR-021 pins solo behavior as a first-class output path — useful because atmux-bun itself is solo-mode (no team agents) yet has handoff.md content to surface.

### 5. NOT in scope

- **Slash-command syntax change.** `/session cont` continues to work via skill shim. Users keep typing the slash form. atmux verb is the runtime, not the user surface.
- **Handoff content schema.** This ADR pins the *path*, not the *content*. Handoff body shape is documented in the skill's prose and stays there.
- **Killing the skill.** Skill stays — it owns slash-command discoverability + LLM-facing prose. Only the shell logic moves.
- **Cross-version compatibility shim.** When atmux 0.4.0 ships `session` + `team` verbs, the skill's shell logic is replaced wholesale; bash atmux operators run a versioned skill that fork-routes to bash semantics. Acceptable churn — the skill is local-config, not a public API.
- **`atmux session stop` for partial team shutdowns.** End-of-day full-stop only; intra-session checkpointing → `preclear`.

## Schedule

- **ADR-021 lands now (Phase 2).** This commit. Pins the contract before V-25 whip writes against `lead-session-start.txt` + `~/.claude/teams/<team>/` paths — whip designs against a stable interface.
- **V-25 whip (Phase 2).** Implements I-1 + I-2 (immediate items from §6.3). Writes `lead-session-start.txt` + `lead-window-name.txt` per ADR-021's path canonicalization. Does NOT depend on `session`/`team` verb implementation.
- **V-01 up (Phase 2).** Closes Phase 2.
- **Phase 3 — parity harness** (per ADR-009 + ADR-011).
- **Phase 4 — cutover.** Side-by-side burn-in. atmux-bun replaces atmux-bash for solo + IFCA usage.
- **Post-cutover (Phase 4 tail or Phase 5 head).** New verb-IDs:
  - V-26 `session` (sub-verbs: cont / preclear / handoff / stop) — implementation lands as one verb-ID.
  - V-27 `team` (sub-verbs: start / stop / add / clear / cleanup / bootstrap / rotate-lead / rotate-member).
- **Skill cutover.** Once V-26 + V-27 ship, `~/.claude/skills/coordination/skills/{session,team}/SKILL.md` shell logic migrates to thin shims.

LOC estimates deferred to implementation. The bash skill is ~600 LOC but TS port likely lands at 200-400 LOC per verb-ID due to atmux's existing primitives + Zod schema reuse + `core/common.ts` mode-detection helpers. Real estimate happens when porting.

## Consequences

- **§6.3 integration tasks I-3 + I-4 resolve into ADR-021's scope.** `PLAN.md` §6.3 retitles those rows to `(resolved in ADR-021)`; net work is captured by the new V-26 + V-27 IDs.
- **§6.2 grows by two verb-IDs** (V-26 `session` + V-27 `team`) — added as ⏳ pending with ADR-021 cross-reference.
- **§7 ADR backlog** gains ADR-021 row; ADR-018's "deferred to V-25" markers update to "resolved in ADR-021".
- **Whip + V-01 up** ship against the canonical paths from day one. No retrofit.
- **Skill code** is reduced to ~50 LOC of shell shim per verb post-cutover.
- **Single source of truth** for team coordination: atmux. Skills are slash-command UX layer.
- **No break to existing workflow** during Phase 2 — skill keeps working as-is until V-26 + V-27 land. Cutover is opt-in via skill version bump.

## Out of plan

- If skill ergonomics demand a different sub-verb shape (e.g. `/team start --rotate-existing` flag), atmux verb gains the same flag. The contract is "skill arg shape == atmux arg shape" with no translation layer beyond the dispatcher.
- Future skills (`/coordination:heads-up`, `/coordination:tell-lead`, `/coordination:whip`) are out of ADR-021's immediate scope — most already use existing atmux verbs (`tell-lead`, `report`, etc.) and don't need new verb-IDs. Whip's runtime side is V-25 (already scheduled). The pattern from ADR-021 generalizes if any future skill needs additional atmux backing.
