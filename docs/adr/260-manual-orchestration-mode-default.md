# ADR-260: Manual orchestration mode is the default — LLMs self-report status + drive the kanban; orchd is opt-in

**Status**: accepted
**Date**: 2026-06-12
**Driver-ref**: George 2026-06-12 — "make atmux able to run on manual mode without orchd, meaning let llms manually update their status … and update the kanban … make it configurable via team.json … make all teams that we have right now use manual mode … and default teams to manual mode … write to adrs that this is because llms can manage their own fleet better than atmux can atm."
**Relates**: [ADR-202](202-honker-in-db-messaging-substrate.md) §Amendment (orchd supervisor + spawn gate, amended here), [ADR-259](259-committer-member-optional-orchd-gates-on-automerge.md) (previous spawn-gate amendment — this ADR adds a gate ahead of it), [ADR-258](258-vendor-agnostic-orchestration-agentbackend.md) (AgentBackend status enum this verb's vocabulary aligns with), [ADR-247](247-lead-stall-watchdog.md) / [ADR-226](226-orchd-auto-merge-subscriber.md) / [ADR-229](229-orchd-auto-push-and-safety-gates.md) / [ADR-231](231-orchd-auto-spawn-and-solo-worker-dissolve.md) (the orchd consumers that become opt-in), [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) (orchd-is-the-runtime — meaning "no orchd" is now a real, supported operating point), [ADR-057](057-stall-prevention.md) §D6 (heartbeat file family the new status file mirrors), [ADR-148](148-commit-cadence-truth-signal.md) (derived signals `atmux status` already renders next to the new self-reported one).

## Context

atmux's orchestration layer (the `__orchd__` daemon window + its consumers: auto-merge, auto-push, auto-spawn, solo-worker dissolve, lead-stall watchdog, context/budget scanners) is deterministic automation that *infers* member state from derived signals — pane process trees, git log cadence, heartbeat file age, kanban ownership — and acts on Honker events. That inference is the weak link: every false-green / false-stall class in the memory trail (pane-state false-`down`, past-tense-glyph skip, footer-freeze rate-limit misreads) is orchd-side automation guessing wrong about what an agent is actually doing.

**The operator's assessment, recorded verbatim as the rationale for this ADR: LLMs can manage their own fleet better than atmux can at the moment.** A Claude lead/driver reading `atmux status` and deciding "merge now, nudge be-1, spawn an epic-team" outperforms the current deterministic consumers — the agents have the context the daemon lacks. Until atmux's automation catches up, the automation should be the opt-in path, not the default.

Two gaps block running that way today:

1. **No mode switch.** orchd spawn is gated only on `autoMerge.enabled` (+ `ATMUX_HONKER`) per ADR-259. A team that wants auto-merge semantics later, but manual operation now, has no knob; "manual" is only expressible by disabling autoMerge entirely.
2. **No self-reported status.** Member status is exclusively *derived* (cage-state probe, cadence, heartbeat, kanban counts). An agent has no verb to say "I am working on t-x" / "I am blocked, here's why" — the one signal that is authoritative in manual mode, because the agent itself is the orchestrator.

The kanban side already has the manual primitives (`atmux claim`, `atmux done`, `atmux task move`, `atmux dispatch`) — they write `state.db` directly and emit events without requiring any consumer. What's missing is the status surface plus a contract tying the two together.

## Decision

### D1 — `team.json::orchestration.mode`, default `"manual"`

New strict sub-block (sibling precedent: `whip` / `autoMerge` / `leadStallWatchdog`):

```jsonc
"orchestration": { "mode": "manual" }   // "manual" | "orchd"
```

- **Absent block ⇒ `"manual"`.** Manual is the fleet-wide default per the operator directive. Resolution helper: `resolveOrchestrationMode(team)` in `src/schema/team.ts`.
- `"orchd"` restores the pre-ADR-260 behavior: the daemon window spawns subject to the existing gates (autoMerge.enabled, ATMUX_HONKER, nested-`.atmux` guard).

### D2 — orchd spawn gate: mode must be `"orchd"`

`maybeSpawnOrchdWindow` gains **Gate-1 (mode)** ahead of the ADR-259 gates: `resolveOrchestrationMode(team) !== "orchd"` ⇒ skip with a log line. Because the default is `"manual"`, **every team that does not explicitly set `mode: "orchd"` runs orchd-less from its next `atmux start`** — including teams with `autoMerge.enabled: true`. This is the intended breaking change, not an oversight: the operator directed flipping the whole current fleet to manual.

Manually running `atmux orchd --start` / `--drain` / `--sweep` remains possible in any mode (operator/LLM explicit invocation is itself manual fleet management).

### D3 — member self-reported status: `atmux member status`

```
atmux member status <idle|working|blocked|rate-limited>
                    [--as <member>] [--note <text>] [--task <task-id>] [--team-dir <dir>]
```

- Member resolution mirrors `claim`/`done`: `--as` > `$ATMUX_MEMBER` > cwd match; unknown roster names are refused (typo guard).
- Storage: `<atmuxDir>/state/member-status/<member>.json` — `{ member, status, note?, taskId?, updatedAtSec }`, atomic-write, per-member file (same concurrency reasoning as the ADR-057 heartbeat family). File-based, not a `state.db` table: it is a *signal*, like heartbeats and member-context, not kanban state.
- Vocabulary is the self-reportable subset of the ADR-258 AgentBackend status enum (`idle | working | rate-limited`) plus `blocked` (agent-level judgment the backend enum delegates to `awaiting-input`/`errored`, which are probe-derived, not self-reported).
- Setting a status also touches the member's heartbeat file (`writeHeartbeat`) — a self-report is proof of liveness, so manual-mode teams get fresh `❤️` markers without the cron poke loop.

### D4 — kanban coupling (the "and update the kanban" half)

Kanban transitions stay on the existing verbs; `member status` adds the glue so one call keeps both surfaces honest:

- `working --task <id>` — claims the task for the member when it isn't already theirs (delegates to `claimTaskForMember` + `movePendingToInProgress`, inheriting the deps gate, the driver-only refuse gate, and the in-progress-other race refusal). Already-owned in-progress task ⇒ no-op on the kanban, status recorded.
- `blocked --task <id>` — moves the task to `blocked` via `markTaskBlockedWithNote` (note defaults to the `--note` text).
- `idle` — never mutates the kanban, but when the member still owns in-progress tasks, prints them with an `atmux done <id>` hint so an agent going idle with a dangling in-progress row sees the lie immediately.
- `rate-limited` — status only; `--task` recorded as a reference, no transition.

### D5 — `atmux status` surfaces the self-report

`MemberStatus` rows gain `selfStatus { status, note?, taskId?, ageSec }` (JSON key emitted only when the file exists, matching the `contextPct` presence convention). Text mode appends a `📍<status>(task, age)` segment to the member row, next to the heartbeat marker. The self-report is rendered alongside — not instead of — the derived signals (cage-state / cadence / heartbeat), so a stale or dishonest self-report is cross-checkable at a glance.

### D6 — fleet migration

Every `.atmux/team.json` on the current host gets an explicit `"orchestration": { "mode": "manual" }` block (explicit beats implicit for teams that had `autoMerge.enabled: true` and would otherwise change behavior silently on a future default flip). The Team root schema is `.passthrough()`, so older deployed binaries tolerate the key; ordering of config-flip vs binary redeploy is not load-bearing.

## Consequences

- **All orchd consumers become opt-in**: auto-merge (ADR-226), auto-push (ADR-229), auto-spawn (ADR-231), solo-worker dissolve, lead-stall watchdog (ADR-247), context/budget scanners. In manual mode the lead/driver LLM does these by hand: fan-in via `atmux epic-merge` / `merge-cycle` / plain `git merge`, spawn via `atmux team spawn-epic`, nudges via `atmux dispatch` / `send`.
- Honker events are still **emitted** by the task/story/epic verbs in manual mode (cheap, durable audit trail, and flipping a team back to `"orchd"` resumes consumption from offsets), but nothing consumes them. orchd's 24h housekeep doesn't run either — events-table growth is bounded by a future manual `atmux orchd --housekeep` invocation or a team flip; acceptable at current volumes.
- The self-reported status is **advisory, not enforced** — nothing gates on it in v1. It exists so the orchestrating LLM (lead/driver) has an authoritative intent signal next to the derived ones. Enforcement (e.g. dispatch refusing `blocked` members) is a future ADR if wanted.
- `templates/briefs/member.md` gains the manual-mode protocol (set `working` on claim, `idle` on done, `blocked` with a note when stuck); brief-vocab change rides this same commit per the binding-discipline rule.
- When atmux's automation is judged trustworthy again, the rollback is one line per team (`"mode": "orchd"`) — no state migration in either direction.
