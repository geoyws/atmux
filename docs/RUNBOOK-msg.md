# RUNBOOK-msg — `atmux msg`: pane-to-pane messenger

Contract: [ADR-292](adr/292-atmux-msg-mailbox-record-and-wake.md). The epic
(e-05309933) is the specification; where the two differ the ADR wins and
the difference is noted in the implementing lane's report, not edited
into the ADR.

## What it is

`atmux msg` is a durable mailbox plus a print-only wake pointer. `send`
appends one `kind='msg'` row to the team's `.atmux/state.db`
`inbox_messages` table (priority in `extra.priority`, per-reader acks in
`extra.acked_by` — zero schema change) and prints the peer's
`<session>:<window>` address plus a pointer line. It never drives pane
input: no `send-keys`, no paste-buffer write. Delivering the pointer to
a live pane is the caller's job, via the operator-sanctioned
`/pane-agent send --queued` path (sanction 2026-09-08).

## Verbs

```
atmux msg send <peer> [--priority p0..p3 | --p0..--p3] [--as <sender>] <body...>
  -> peer=driver-2 window=<session>:<win> priority=p0
     pointer="msg m-7 from driver: prod deploy wedged — atmux msg check"

atmux msg check [--min <p>] [--since <epoch>] [--all] [--ack] [--json] [--as <member>]
  -> 1 unread p0 from driver (2026-09-04 15:02 MYT)   exit 1

atmux msg read [--min <p>] [--since <epoch>] [--all] [--ack] [--json] [--as <member>]
  -> full bodies with per-row [acked]/[unread] flags   exit 0
```

Defaults (ADR-292 OQ1 lean, threshold token corrected — see the E1-T3
lane report): send priority `p2`, `check`/`read` threshold `--min p3`
(everything). Peers and readers are roster names: `members[]` plus the `drivers[]` seats (`driver`, `driver-2`, …; ADR-292 amendment 2026-09-29). Identity: `--as <member>` wins, then
`$ATMUX_MEMBER` (same convention as `claim --as`); `check`/`read`
refuse unknown or missing names instead of showing the wrong mailbox.

## Semantics worth knowing

- **Cursor precedence**: `--all` > `--since` > stored cursor (in
  `state_kv`, feature `msg`, key `cursor:<reader>`). Absent cursor =
  never read = everything surfaces.
- **`check` vs `read`**: `check` counts only unacked rows (the 0/1 exit
  contract — 0 nothing unread, 1 unread exists, 2 reserved).
  `read` shows everything after the cursor with per-row ack columns, so
  `[acked]` is observable after `--ack` + `--since` rewind.
- **Ack outlives the cursor**: `--ack` advances your cursor to the
  mailbox tip AND records per-row ack; acked rows stay hidden under
  `--since` rewinds. Acks are per-reader — acknowledging never hides a
  row from anyone else.
- **No migration step**: `kind='msg'` rows need no backfill; opening a
  pre-E1 `state.db` upgrades through the normal idempotent ladder.
  Medic readers query by inbox key (`__medic__`), so `msg` rows
  addressed to roster members never leak into the medic inbox.

## Triage recipe

1. In the member pane: `atmux msg check` (exit 1 = something needs you).
2. `atmux msg read` for full bodies; `atmux msg read --ack` to clear.
3. To ping someone else: `atmux msg send <peer> --p0 <what>` then hand
   the printed pointer to `/pane-agent send --queued`.
