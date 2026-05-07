# ADR-021: `unblocker` role — dedicated blocker triage at 2-min cadence

**Status**: accepted
**Date**: 2026-04-27

## Context

The team-lead's whip cycle (5-min cadence) bundles dispatch + rotation + Discord composition + blocker triage into a single role-budget. As the team grows past 4–5 members, blocker triage gets crowded out:

- Stale claims (`status=in-progress` with `claimedAt` mtime > 30min and no commit-Task fired) accumulate.
- `status=blocked` Tasks linger across multiple whip ticks before the lead notices.
- Wedged member panes (Claude Code stuck on a `Compacting conversation` banner, `hit your limit` modal, or a permission-prompt buffer) keep their inbox in `inProgress[]` while the worker is silent — phantom-inbox detector helps post-mortem, but doesn't unwedge in real time.

The lead's whip already runs every 5 min; tightening it to 1–2 min would explode Discord noise from the OTHER whip outputs (progress, heartbeat, rotation banners). Splitting blocker triage to a dedicated role with a tighter cadence isolates the cost.

Three shapes considered:

- **A (chosen)** — spawn a dedicated `unblocker` member at `role=unblocker, lane=misc`. Cron'd at 2-min cadence (tighter than whip's 5-min). Read-only on kanban + member panes. Decides per-blocker: nudge member via `atmux send`, escalate to lead via `atmux reply` to lead-outbox, OR surface to driver via `lead-outbox` for `/team clear` approval. Does NOT auto-mutate kanban (`task move blocked → todo`); does NOT claim work; does NOT plan.
- **B (rejected)** — fold into lead with bigger role budget. The cognitive bloat is the problem; adding more responsibilities to the lead makes it worse.
- **C (rejected)** — make it a deterministic cron'd skill (no LLM judgment). Pane-reading + classification + decision (nudge vs clear vs escalate) needs LLM judgment; a regex-based dispatcher would mis-classify the long tail of failure modes.

The role-discipline split mirrors planner/reviewer:

- **planner** — decompose only, never dispatch.
- **reviewer** — signoff only, never claim.
- **unblocker** — detect + classify + route only, never claim, never plan, never auto-mutate.

## Decision

**Add `unblocker` to the role enum** in `team.json` schema validation (referenced in `lib/init.sh` wizard role list + any role-typed validators).

**Spawn topology**: standard member window, brief at `templates/briefs/unblocker.md`. Cadence via cron (registered by `lib/cron.sh::atmux::cron_install` when team has an unblocker member): `*/2 * * * *` invokes `atmux unblocker tick` (new verb OR `atmux whip --as unblocker` variant — pick at implementation time).

**Per-tick responsibilities** (from `briefs/unblocker.md`):

1. Read kanban: enumerate `tasks[]` where `status == "blocked"` OR (`status == "in-progress"` AND `claimedAt` mtime > 30min AND no commit-Task downstream).
2. For each candidate, capture the assigned member's pane (`tmux capture-pane`) + recent activity (last commit SHA, recent stdout). Classify:
   - **wedged** (modal prompt, permission gate, queued-message backbuffer, rate-limit banner) → surface to lead-outbox with classification + paste of pane state. Lead approves `/team clear`.
   - **idle** (no banner, no error, no progress > 30min) → nudge via `atmux send <member> "still on $task_id?"`.
   - **legitimately-slow** (active commits in adjacent task, build running) → no action.
   - **wedged-with-driver-needed** (auth flow, network-down outside scope) → escalate via `atmux reply` (lead-outbox) with explicit "needs driver" tag.
3. Never `task move <id> blocked → todo` autonomously. Surface the recommendation; lead/driver mutates kanban.
4. Never `tmux send-keys` `/clear` without lead approval. Default action is nudge or surface; clear is lead's call.

**Cadence**: 2-min (per OQ C1). 1-min was considered but rejected — pane-capture + classification on N members each minute crowds Claude Code's tick budget; 2-min keeps the loop responsive without spam.

## Consequences

- **+1 window per team** (standard member spawn).
- **`lib/cron.sh` gains ~6 LOC** to detect unblocker membership + emit the 2-min cron line.
- **`lib/whip.sh` (or new `lib/unblocker.sh`)** gains the unblocker tick logic — reuse `atmux::tmux_capture_pane`, kanban readers, `lib/discord.sh` for escalations.
- **`templates/briefs/unblocker.md`** (new) — role brief mirroring planner/reviewer shape.
- **`team.json` role enum** — add `"unblocker"` alongside existing `"member"`, `"team-lead"`, `"planner"`, `"reviewer"`, `"gitter"`, `"dba"`, `"devops"`.
- **README** — document the role + when to add it to a team.
- **Critical ordering**: unblocker is +1 window per team. Land AFTER E7 promote (t-b7ac1bc5) AND AFTER `migrate-to-driver-session` runs for `atmux-kanban` — otherwise n-session pollution gets WORSE (currently 26 windows across 3 sessions; +unblocker on each = +3 windows; on shared single-session that's tolerable, on dedicated sessions that's noise). E9 has a bookkeeping marker Task representing the migrate-fired event; Sc + Sd code Tasks dep on it.
- **Trade-off accepted**: unblocker can mis-classify on edge cases (e.g. a member legitimately running a 45-min e2e). Default-to-nudge (not auto-clear) keeps the blast radius low; brief explicitly tells unblocker to surface ambiguous cases rather than act.

## Open questions

1. **OQ C1: cadence — 1-min vs 2-min?** Resolved: 2-min. (medium-rev — driver may tighten if blockers slip through.)
2. **OQ C2: unblocker writes to lead-outbox vs driver-inbox?** Resolved: lead-outbox (mirrors planner pattern; lead triages onward to driver-inbox if needed). (low-rev.)
3. **OQ C3: auto-mutate kanban (`blocked → todo`)?** Resolved: surface-only. Mirrors planner's no-dispatch + reviewer's no-claim discipline. (medium-rev — driver may relax to allow auto-route on specific patterns.)
4. **OQ C4: /clear authority — does unblocker `/team clear` stale members?** Resolved: nudge-only by default; surface to lead for clear approval. (medium-rev — auto-clear could land later for narrowly-scoped patterns like rate-limit banner with timestamp older than N hours.)

All resolutions logged to `.atmux/decisions.md`.
