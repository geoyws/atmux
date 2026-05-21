---
name: tell-lead
description: Send a driver→lead ask via `atmux tell-lead` — durable to .atmux/lead-inbox.md plus best-effort wake-up to the lead's pane. Explains the two listener-absent warnings as expected output, not a failure.
argument-hint: <message>
---

<!-- carved per ADR-217 §D4 -->

# /atmux:tell-lead — driver→lead ask, file-backed + best-effort wake-up

Wraps `atmux tell-lead "$ARGUMENTS"`. The verb does two things:

1. **Durable**: appends a timestamped bullet to `.atmux/lead-inbox.md` under `## Open`. This is the source of truth — it survives `/clear`, pane crashes, and team restarts.
2. **Best-effort wake-up**: `sock_publish` an event to the lead's supervisor socket (real-time nudge), then `tmux send-keys` a `📬 lead-inbox has a new ask` ping to the lead's pane.

The user is in their driver pane and types `/atmux:tell-lead <message>`. Run the verb, then explain the output cleanly — especially the `lead listener absent` warnings, which look scary but are by design.

## Pre-flight

Run `atmux status 2>&1 | head -3` to check the team is up.

- **session=up** → proceed normally; the wake-up will land.
- **session=down** → the durable write to `.atmux/lead-inbox.md` will still happen, but the lead can't be paged because there's no pane. Two paths:
  - Recommend the user run `atmux start` first, then retry — the lead will read the inbox on bootstrap anyway.
  - OR confirm the user wants the message queued for whenever the team next starts (still useful — the inbox is the actual contract).

## Action

```bash
atmux tell-lead "$ARGUMENTS"
```

## Output interpretation

You will see something like:

```
⚠️ atmux sock_publish: lead listener absent (this is fine — durable write still happened)
⚠️ atmux sock_publish: lead listener absent (this is fine — durable write still happened)
✅ tell-lead → lead (appended to .atmux/lead-inbox.md)
```

**The two `lead listener absent` warnings are EXPECTED when the team is stopped — they are not failures.**

Why two warnings, not one? Per [ADR-042](../../../docs/adr/042-socket-pubsub.md) phase 2, both `tell.sh` and the nested `send_to_member` independently call `sock_publish`. When no supervisor is listening on the lead's socket (team stopped, lead pane not yet bootstrapped, supervisor crashed), both publishes warn-only and continue. The durable `.atmux/lead-inbox.md` write is the contract; the publish is just a wake-up nudge.

When the team **is up** and the lead's supervisor is listening, you'll see one `✅ sock_publish` per call instead of the warning, plus the final `✅ tell-lead → lead` line.

> **Legacy `driver-inbox.md`** (one-release back-compat per [ADR-198](../../../docs/adr/198-medic-host-pressure-playbook.md) §History): this verb previously wrote to `.atmux/driver-inbox.md`. The atmux read path still accepts the legacy filename — if both files exist mid-rollout they merge by mtime. New writes go to `.atmux/lead-inbox.md` only; the per-team migration walker handles the on-disk `mv`.

## Failure mode (real this time)

If the verb exits **non-zero** with `no tmux window for lead`:

- The team session isn't running at all (no panes exist).
- The lead-inbox.md write **still happened** — re-run `cat .atmux/lead-inbox.md | tail -5` to confirm.
- Recover with `atmux start`, then optionally re-run `tell-lead` to deliver the wake-up nudge (the inbox entry is already there, so this is just for immediacy).

If the verb exits non-zero with `no lead defined in team.json`:

- The team config has no member with `role: team-lead` (or named `lead`). This is a config bug, not a runtime issue. Fix `.atmux/team.json` first.

## What to check after a successful tell-lead

- The lead's pane should show a `📬 lead-inbox has a new ask: <first 80 chars>…` ping line within ~1 second.
- `cat .atmux/lead-inbox.md | tail -3` should show the new bullet with a `[HH:MM TZ]` timestamp (timezone configurable per team via the supervisor's tz config) and your message.
- The lead will mark it ✅ / 📤 / ⏳ / ❌ on their next whip turn — don't expect an immediate reply in the driver pane.

## Anti-pattern

**Do NOT use `tell-lead` for ephemeral chitchat or a one-line FYI.** Use `atmux send lead <msg>` for that — it pages the lead's pane without polluting the durable inbox, which is meant for asks the lead must process and ACK.

`tell-lead` is for: scope changes, blocker escalations, decision requests, dispatch overrides, anything the lead must close the loop on.
`send lead` is for: "FYI, I restarted the FE", "rebased your branch onto main", "see you in 10".

When in doubt: if you'd be annoyed to see it sitting in your inbox unmarked tomorrow, use `send lead`.

## Operator-facing report format — attention + verdict markers

`tell-lead` runs once and emits the verb's output. Wrap that output with a one-line top-marker so the operator knows whether the ask landed cleanly, partial-landed (durable write OK but wake-up missed), or failed (no durable write at all). Same verdict-marker scheme as other atmux skills (whip, sweep, bau, bruh, session, team).

**Verdict-derivation rules:**

- **✅** when `atmux tell-lead` exits 0 AND durable write to `.atmux/lead-inbox.md` confirmed (the two `lead listener absent` warnings are ℹ noise, NOT a downgrade — they're expected when supervisor isn't listening; durable write still happened).
- **⚠** when exit 0 but team session is down (durable write OK, lead can't be paged until team-start) — operator should know they may want to `atmux start` before the inbox grows stale.
- **🔴** when exit non-zero AND durable write didn't happen (`no tmux window for lead` with empty inbox, or `no lead defined in team.json`) — the ask was lost, operator must retry.

**Examples:**

```
✅ /atmux:tell-lead — delivered to lead (appended to .atmux/lead-inbox.md, sock_publish OK)
```

```
⚠ /atmux:tell-lead — durable write OK, lead can't be paged (session down)
👁 Operator: run `atmux start` to bring the lead up; inbox entry will be read on bootstrap
```

```
👁 🔴 /atmux:tell-lead — aborted, no durable write
Cause: `no lead defined in team.json` (config bug — no member with role: team-lead)
👁 Operator: fix .atmux/team.json (add team-lead role to a member), then retry
```

**Anti-pattern:** marking `🔴` when the two `lead listener absent` warnings appear. Those are ℹ. The verdict is determined by the verb's exit code + the durable write, not by the warning noise.
