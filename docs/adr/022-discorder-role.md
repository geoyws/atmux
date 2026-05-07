# ADR-022: `discorder` role — scheduled-ping ownership split from lead

**Status**: accepted
**Date**: 2026-04-27

## Context

The team-lead currently composes ALL Discord pings:

- **Scheduled / narrative**: 30-min progress digest, hourly heartbeat. Routine, derives from kanban + git-log + decisions snapshots.
- **Urgent / event-driven**: blocker pings, decision pings (high-rev), critical failures. Caused by lead's own dispatch + coordination events.

Bundling both into the lead has two costs:

1. **Narrative composition competes with coordination**. Writing a 30-min progress digest is a 200–400 token compose; doing it inline with whip dispatch reduces lead's attention to dispatch decisions.
2. **Tone drift**. Same role writing both blocker-urgent + 30-min-narrative creates an inconsistent voice; either heartbeats sound too urgent, or blockers sound too summary-style.

Three shapes considered:

- **A (chosen — driver default)** — split ownership. Lead keeps urgent (blocker, decision, critical) — they're caused by lead's own events. **Discorder owns scheduled** (progress digest 30-min, heartbeat 60-min). Cleanest decoupling along the urgent-vs-routine axis.
- **B (rejected)** — cron-driven ping renderer (deterministic, no LLM judgment). Risk: misses narrative nuance; routine becomes robotic.
- **C (rejected)** — discorder owns ALL Discord; lead writes nothing. Loses the "blocker pings come from the role that detected the blocker" signal; adds a routing hop on urgent paths.

The split mirrors A (driver default). Lead's role-discipline brief (`briefs/team-lead.md`) gets a one-line carve-out: "scheduled pings (progress, heartbeat) are discorder's; urgent pings (blocker, decision, critical) are yours."

## Decision

**Add `discorder` to the role enum** in `team.json` schema validation.

**Spawn topology**: standard member window, brief at `templates/briefs/discorder.md`. Cadence via cron (registered by `lib/cron.sh::atmux::cron_install` when team has a discorder member):

- `*/30 * * * *` — `atmux discorder progress` — composes 30-min progress digest from kanban diff + git-log since last cursor + completed decisions; pings via `atmux::discord_embed_ping` (per ADR-019).
- `0 * * * *` — `atmux discorder heartbeat` — composes hourly state-of-team ping (members alive, in-flight Tasks, blocker count, lead uptime).

**Ownership boundary** (documented in briefs, NOT enforced in `lib/discord.sh`):

| Ping category | Owner | Trigger |
|---|---|---|
| `whip-progress` (30-min digest) | discorder | cron `*/30` |
| `whip-heartbeat` (hourly) | discorder | cron `0 *` |
| `whip-blocker` | lead | whip detects blocker |
| `whip-decisions` | lead/planner | high-rev `decisions add` |
| `whip-critical` (P0) | lead | escalation path |

**Legacy `report` cron line** (`*/30 * * * * ATMUX_DIR=... %s report >> ...` in `lib/cron.sh::_atmux_cron_render_lines`): when the team has a discorder member, suppress the `report` line emission — discorder's progress-digest cron replaces it (per OQ D4). Teams without discorder keep the legacy `report` line unchanged.

**Composition source**: discorder reads kanban + git-log + decisions.md + flags.md directly (same data sources as `atmux report`). Reuses templates from global `whip-prompt.md` §6+§7 voice (Discord message format with header + bulleted body + per-bullet emoji).

## Consequences

- **+1 window per team** (standard member spawn).
- **`lib/cron.sh` gains ~10 LOC** to detect discorder membership, emit the 2 new cron lines, and conditionally suppress the legacy `report` cron line.
- **`lib/discorder.sh` (new)** — composes scheduled pings. Reads kanban + git-log + decisions; emits via `atmux::discord_embed_ping`. Two subcommands: `progress` and `heartbeat`.
- **`templates/briefs/discorder.md`** (new) — role brief.
- **`templates/briefs/team-lead.md`** — one-line carve-out: scheduled pings now belong to discorder; lead keeps urgent only.
- **`team.json` role enum** — add `"discorder"`.
- **README** — document the role + the urgent-vs-scheduled split.
- **`atmux report` verb stays intact** — manual invocation works as today (driver can still snapshot on demand). Only the cron emission changes when discorder is present.
- **Critical ordering**: same as ADR-021. Blocked on E7 promote (t-b7ac1bc5) + `migrate-to-driver-session` for `atmux-kanban`. E9's migration marker Task gates Sc + Sd's first BE Tasks.
- **Trade-off accepted**: separating ownership means a blocker ping (lead) and a progress digest (discorder) can land within seconds of each other in different voices. Brief consistency mitigates; full voice unification was the rejected option C.

## Open questions

1. **OQ D1: exact ownership split?** Resolved: lead keeps urgent (blocker, decision, critical); discorder owns scheduled (progress 30-min, heartbeat 60-min). Driver default. (medium-rev — boundary may shift if a category proves miscategorized in practice.)
2. **OQ D2: progress digest cadence?** Resolved: 30-min (matches existing `report` cron). (low-rev.)
3. **OQ D3: heartbeat cadence?** Resolved: 60-min. (low-rev.)
4. **OQ D4: cron `report` line fate when discorder present?** Resolved: suppress emission (discorder replaces it). Teams without discorder keep `report` cron line. (medium-rev — could keep both if discorder's progress-digest proves divergent enough to need both signals.)

All resolutions logged to `.atmux/decisions.md`.
