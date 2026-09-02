---
name: heads-up
description: Lightweight notification skill — atmux supervisor pings teammates via `/atmux:heads-up <message>` to nudge them about new tasks, cascade unblocks, or inbox updates. Skill just acknowledges; teammate folds the nudge into next idle turn.
argument-hint: <event description>
---

<!-- carved per ADR-217 §D4 -->

# /atmux:heads-up — atmux supervisor notification

Invoked by atmux when notifying a teammate's pane between turns. Examples:

- `/atmux:heads-up new task t-abc1234 dispatched`
- `/atmux:heads-up cascade unblock — claim --next`
- `/atmux:heads-up message from reviewer`
- `/atmux:heads-up new tell-lead from driver`
- `/atmux:heads-up decisions-add`
- `/atmux:heads-up flag-add`

## Why this skill exists

Without it, every supervisor injection produces `Unknown command: /atmux:heads-up` errors in the pane (cosmetic but noisy — log spam buries real signal). The skill silently absorbs the nudge so atmux's notification mechanism is clean.

The skill itself does not act. Per the team-member brief in atmux templates, atmux's between-turn injections are "always safe to consume" — pane-state preflight runs upstream (post-ADR-202 Honker substrate, this is event-driven; pre-substrate, it's the legacy supervisor's keystroke gate). Treat the heads-up as a normal nudge: read the args (what changed), fold into your loop on the next idle turn, no special handling.

## Instructions for the receiving agent

1. **Read the args** (`$ARGUMENTS`). The args summarise what changed:
   - `new task <id> dispatched` → next idle turn, claim or note the task
   - `cascade unblock — claim --next` → run `atmux claim --next` when ready
   - `new tell-lead from driver` → re-read `.atmux/driver-inbox.md` `## Open` section (the lead's incoming inbox; an earlier proposed rename was REVERTED — canonical filename is `driver-inbox.md`; driver→lead direction per [ADR-215](../../../../docs/adr/215-multi-driver-support-per-team-default-three.md) §D3)
   - `new flag <id>` / `flag-add` / `flag-resolve` → `atmux flags list --status open`
   - `new reply from <member>` → re-read `.atmux/lead-outbox.md`
   - `decisions-add` → re-read `.atmux/decisions.md`
   - generic `<etype> event` → check kanban + inbox for the changed surface

2. **Do not interrupt in-flight work.** If currently mid-task, finish the turn first. The supervisor's pane-state preflight already gated the keystroke — receipt is a hint, not a preempt.

3. **No output required.** The skill is a no-op acknowledgement. Don't echo "I received the heads-up" or similar — Claude Code's silent consumption keeps the pane clean.

4. **State files are the source of truth.** State + notification are transactional (verb writes state.db row → publishes event → atmux injects), so a missed keystroke can't desync you from kanban truth — re-read state via `atmux inbox <member>` + `atmux task list` when in doubt. If you missed multiple heads-ups while busy, just re-query on next idle turn; you'll catch up. The kanban itself lives in `.atmux/state.db` (SQLite per ADR-126) — never grep the .db directly; always use the verbs.

## What this skill does NOT do

- Does not invoke any tool.
- Does not send a reply.
- Does not modify any state files.
- Does not auto-claim tasks (that's `atmux claim --next`, separate verb).

It exists purely so `/atmux:heads-up <args>` is a valid skill invocation rather than an `Unknown command` error.

## Attention + verdict format — deliberate exemption

Unlike `/atmux:whip` §8.0, `/atmux:sweep` §9.5 (formerly the medic operator surface; per [ADR-212](../../../../docs/adr/212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md) the role retired but the marker scheme stayed), `/atmux:bau` header, `/atmux:session` global, and `/atmux:team` global — which all mandate an `✅/⚠/🔴` + `👁` attention-marker header on every operator-facing report — `/atmux:heads-up` **deliberately produces no output**, attention markers included. Pane silence IS the success state: the injection is a hint folded into the next idle loop, not a turn the operator reads. Echoing any verdict line — even `✅` — defeats the noise-suppression purpose.

If something genuinely warrants the operator's attention as a result of a heads-up (e.g. parsing the args revealed a 🔴-class condition), the receiving agent surfaces it via its *own* normal channel (lead-queue entry, whip status line, BAU report) — NOT via this skill's output. Keep this skill silent.

## Cross-references

- [ADR-202](../../../../docs/adr/202-honker-in-db-messaging-substrate.md) — Honker substrate; supersedes legacy supervisor keystroke loop with event-driven NOTIFY/LISTEN. Consumers register topics; emit→drain ~1ms p50.
- [ADR-126](../../../../docs/adr/126-sqlite-state-store.md) — `.atmux/state.db` SQLite store (replaces legacy `.atmux/kanban.json` + `.atmux/inboxes/<m>.json`).
- [ADR-154](../../../../docs/adr/154-driver-inbox-lead-outbox-sqlite-migration.md) — `driver-inbox.md` + `lead-outbox.md` SQLite-canonical with rendered markdown view; clarifies surface vocab used above.
- [ADR-217](../../../../docs/adr/217-atmux-skills-plugin-bundled-and-wizard-installed.md) §D4 — generalization pass strip list (this carve).
