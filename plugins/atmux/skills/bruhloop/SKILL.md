---
name: bruhloop
description: One-shot chained shortcut — fires `/loop 15mins /atmux:bruh you are sentinel, make all teams work, unblock everyone`. Use when the operator wants a hands-off 15-minute /atmux:bruh sweep cadence without typing the whole invocation each time.
argument-hint: (no args)
---

<!-- carved per ADR-217 §D4 -->

# /atmux:bruhloop — 15-minute /atmux:bruh sweep cadence

`/atmux:bruhloop` is a sugar shortcut. It expands to exactly:

```
/loop 15mins /atmux:bruh you are sentinel, make all teams work, unblock everyone
```

That's the whole skill. Don't add ceremony, don't ask questions, don't tune the interval — the operator types `/atmux:bruhloop` precisely because they don't want to think about the parameters.

## When the operator invokes /atmux:bruhloop

1. **Immediately invoke the chained command.** Fire `/loop` with interval `15mins` and prompt `/atmux:bruh you are sentinel, make all teams work, unblock everyone` as the per-iteration command. Use the Skill tool to invoke `/loop` if that's how the harness routes; otherwise schedule the next iteration directly via `ScheduleWakeup` (delaySeconds=900, prompt=`/atmux:bruh you are sentinel, make all teams work, unblock everyone`).
2. **Run the first /atmux:bruh sweep on this turn** — don't wait the 15 minutes for the first one. The operator wants forward motion now plus a recurring cadence; firing the sweep immediately AND scheduling the loop is the right read.
3. **Echo back what was set up** in one line: `🔁 bruhloop armed — /atmux:bruh sentinel sweep every 15min; first sweep firing now.`

## The role priming — "you are sentinel"

The literal verbiage `you are sentinel` is preserved verbatim per operator instruction. Historical note: `sentinel` was the cockpit W3 whip-manager / NudgeAction classifier role; per [ADR-211](../../../../docs/adr/211-retire-sentinel-role-distribute-to-honker-consumers.md) + [ADR-212](../../../../docs/adr/212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md) the cockpit-tier role retired, with its observation functions absorbed into the unified `e-honker-observation-watchdogs` consumer EPIC. The role-priming verbiage continues to work as **tone-priming for the receiving /atmux:bruh sweep** — classify pending nudges aggressively, route stale work to the right rung, don't defer to "operator will decide".

The priming is identity-flavor for the sweep, not a hard branch in /atmux:bruh logic. /atmux:bruh's existing procedure runs as written; the sentinel framing just tightens the lean-in tone.

## The directive — "make all teams work, unblock everyone"

Plain-English shorthand for /atmux:bruh's four verbs (unblock all, approve all, flip all, merge all) plus the rotation + epic-spawn cascades. Nothing new — just an operator-facing one-liner that maps to the full sweep.

## Why a separate skill instead of an alias

- The operator wanted a memorable verb. `/atmux:bruhloop` is one keystroke-group; the full chained invocation is 70+ characters and breaks fingerflow.
- Keeping it as a real skill (not a shell alias) means it works from any harness — shell aliases don't reach the Claude Code TUI.
- The skill doc is the single source of truth for the per-iteration prompt — if the prompt changes (e.g. role rename, retirement amendment), update here and `/atmux:bruhloop` callers stay in sync.

## Hard stops

- **Don't re-invoke /atmux:bruhloop inside a /atmux:bruh iteration.** /atmux:bruh's anti-spiral guard already blocks /atmux:bruh recursion; /atmux:bruhloop scheduling another /atmux:bruhloop is the same runaway one level up. The /loop scheduler owns cadence — /atmux:bruh just executes its sweep and stops.
- **Don't try to "tune" the 15min interval based on team state.** If the operator wants a different cadence, they'll type `/loop <other> /atmux:bruh ...` directly or edit this skill. /atmux:bruhloop is opinionated by design.
- **Don't downgrade the role priming.** Don't drop "you are sentinel" because the role retired — the operator chose that wording for tone-priming; preserve it verbatim in the scheduled prompt. See §"The role priming" above for the architectural history.

## Composability

`/atmux:bruhloop` is one of a family of `/loop`-prefixed shortcuts the operator can build:

- `/atmux:bruhloop` — 15min /atmux:bruh sentinel sweep (this skill)
- `/loop /atmux:whip` — the canonical whip autonomous-work loop (see `/atmux:whip`)
- Future: any other `/atmux:X` skill the operator wants on a fixed cadence can get its own `/atmux:Xloop` sugar.

The pattern: thin skill, no logic, prompt is the spec.

## Cross-references

- [`/atmux:bruh`](../bruh/SKILL.md) — the per-iteration verb this loops on
- [`/atmux:whip`](../whip/SKILL.md) — sibling autonomous-work loop
- [ADR-192](../../../../docs/adr/192-cron-arm-idempotency-contract.md) — `/loop` dynamic-pacing idempotency contract (state-file at `~/.atmux/state/loop-arm-<hash>.json`; check before re-arming)
- [ADR-211](../../../../docs/adr/211-retire-sentinel-role-distribute-to-honker-consumers.md) + [ADR-212](../../../../docs/adr/212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md) — sentinel + medic role retirement (verbiage preserved per operator instruction; architectural history above)
- [ADR-217](../../../../docs/adr/217-atmux-skills-plugin-bundled-and-wizard-installed.md) §D4 — generalization pass strip list (this carve)
