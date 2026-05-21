# Runbook — migrate to Honker substrate

**Audience:** operators rolling out the [Honker in-DB messaging substrate](adr/202-honker-in-db-messaging-substrate.md) across an existing atmux fleet. Each team is recycled individually; the atmux-self team migrates **last**.

**Why it matters:** Honker replaces polling / whip / cron-tick observation loops with `~1ms p50` in-DB pubsub (`PRAGMA data_version` tick). Consumers (gitter, jury, watchdogs, whip-as-event) subscribe to topics instead of waking on a fixed cadence — most idle scans disappear, state-change → action latency drops from 30s-15min to ~1ms (per ADR-202 §Decision table).

Per [ADR-202 §Amendment 2026-05-21](adr/202-honker-in-db-messaging-substrate.md) (commit `38cf2c6`), the `ATMUX_HONKER` kill-switch defaults **ON**. Cages restart pre-binary just emit a yellow `honker` doctor row + fall back to poll-mode via `loadHonkerOrFallback`; no behavior change. The day the extension binary lands at `~/.atmux/extensions/honker.so`, consumer dispatch flips event-driven on the next `atmux start` — no code change in this RUNBOOK's path.

> **CRITICAL — operator-executed, never auto.** This RUNBOOK documents the manual steps the operator runs per team. No atmux verb auto-soft-stops anything from inside the substrate. The companion verifier script `scripts/migrate-to-honker.sh` (Story 8 / `t-76803578`) **only verifies post-restart state — it never executes the migration**. Destructive actions go through the lead-gated pattern per [ADR-212 §D2](adr/212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md): Honker detects → consumer writes lead's driver-inbox → Lead's Claude reads + decides → operator runs the verb.

---

## §1 Pre-flight checklist

Before recycling any team, verify on the cron host (typically hax):

- [ ] **Honker binary** present at `~/.atmux/extensions/honker.so` (Linux) or `~/.atmux/extensions/honker.dylib` (macOS). Provisioned by `atmux init`'s install wizard step 5 per [ADR-200 §D6](adr/200-install-wizard-guided-first-run-setup.md). Override path via `ATMUX_HONKER_PATH`.
- [ ] **atmux ≥0.8.10** deployed: `atmux --version`. Required for the `loadHonkerOrFallback` bootstrap + the `honker` doctor row.
- [ ] **macOS-only**: Homebrew sqlite installed (`brew list sqlite >/dev/null`). Apple-bundled SQLite has extension loading disabled; `loadHonkerOrFallback` calls `Database.setCustomSQLite()` against the brew path at boot per ADR-202 §D7. Hax / Linux deploys require no special handling.
- [ ] **Commit cadence green** per team via:
  ```bash
  atmux status --json | jq -r '.members[] | "\(.name)\t\(.cadence.verdict)\t\(.cadence.commitsInWindow)"'
  ```
  No `stalled` verdicts; no `in-progress` Tasks mid-flight in lanes you care about. Migrating during active dispatch loses the in-flight REPL state on cycle.
- [ ] **Disk space sane** — `df -h ~/.atmux | tail -1` shows ≥1 GiB free. Honker streams write to per-team `state.db` + cockpit `cockpit-events.db`; disk-full mid-publish corrupts streams.

If a check fails, fix it before continuing. The migration is idempotent — abort cleanly + retry; no partial-state hazard.

---

## §2 Sequencing — atmux-self team migrates LAST

The atmux team hosts the driver pane. Recycling atmux means the operator's own Claude conversation resets. Pattern:

1. Migrate every **non-atmux** team first, observe ≥1 cycle each (≥10 min idle + ≥1 real event delivery confirmed via `tail .atmux/logs/honker.log`).
2. Migrate **atmux last**, from a tmux session **outside** the cockpit attach.

The atmux-team special case (covered in §6 below): operator runs `atmux stop --soft` from a daily-driver tmux session (not `atmux_cockpit`) or directly via SSH. The driver Claude inside the atmux cage **will lose conversation state** on restart — `/session preclear` first if you want a clean re-bootstrap.

---

## §3 Per-team procedure (manual)

For each team in the sequence (§6 lists the canonical order):

```bash
cd /path/to/team-project    # the team's project root (where .atmux/ lives)

# (a) Drain — soft-stop preserves kanban state + flushes inbox /
#     lead-outbox / state.db; in-flight panes get a grace window
#     before tear-down per ADR-087.
atmux stop --soft
```

After `atmux stop --soft` returns, verify the team is quiet:

```bash
# (b) Verify drain — no in-flight commits, kanban quiet
atmux status --json | jq '[.members[].cadence.commitsInWindow // 0] | add'
# Expected: 0  (any non-zero → wait 30s + re-check; do NOT escalate to --force
#               unless wedged per RUNBOOK-stall-recovery.md)
atmux task list --status in-progress | wc -l
# Expected: 0  (in-progress > 0 → operator decides: hold for owner to land,
#               or restart-with-resume per ADR-076 inbox migration)
```

Then restart + confirm Honker boots:

```bash
# (c) Restart — re-spawns cages; loadHonkerOrFallback runs at process boot
#     per ADR-202 §D5, before any verb dispatch
atmux start

# (d) Wait for cages to come up + smoke probe to complete
#     (rough: 5-15s depending on member count + submodule init)
sleep 10

# (e) Confirm Honker row
atmux doctor --json | jq '.checks[] | select(.label == "honker")'
```

Expected `(e)` outputs:

```json
// Healthy — binary present + smoke passed
{ "status": "green", "label": "honker", "detail": "substrate loaded — extension at ~/.atmux/extensions/honker.so", "hint": "" }

// Acceptable pre-binary — graceful fallback, consumers run poll-mode + cron-backstop
{ "status": "yellow", "label": "honker", "detail": "fallback mode — extension not found at ~/.atmux/extensions/honker.so", "hint": "extension binary not yet provisioned (install wizard ADR-200 §D6 ships this); consumers fall through to poll-mode + cron-backstop sweep" }

// Explicit opt-out (status=info, not yellow) — operator disabled per §5
{ "status": "info", "label": "honker", "detail": "kill-switch off (ATMUX_HONKER unset or off); poll-mode in effect", "hint": "" }
```

**No `red` row currently emitted by the honker probe** — failure paths route through `yellow` (fallback) or `info` (opt-out). A red row from any **other** probe (cron-drift, state-db, etc.) is a stop-the-world signal — fix that before continuing.

---

## §4 Post-restart verification

After §3 returns green-or-yellow, smoke the substrate end-to-end:

```bash
# (a) Per-team Honker log — tail for event delivery on real state changes
tail -f .atmux/logs/honker.log
```

What "healthy" looks like:

- **Immediately post-restart**: empty log is normal. Events fire on real state changes (`task.claimed`, `task.done`, `commit.landed`, `pane.classified`, etc.) — not on idle background activity.
- **After ≥1 real event** (e.g. a kanban `task.done` lands, or a commit lands via gitter): a corresponding emit line appears within ~1s.
- **`subscriber registered <topic>`** lines on cage start: consumer base-class registering its event surface.

```bash
# (b) Smoke probe (synthetic event roundtrip) — if shipped
atmux doctor --probe honker-smoke
#   Confirms publish→drain ≤100ms via an in-memory test topic.
#   Failure path falls back to the §D5 step-3 substrate smoke ran at boot.

# (c) Cross-team correlation: confirm cockpit-mirror landed events
ls -la ~/.atmux/cockpit-events.db
sqlite3 ~/.atmux/cockpit-events.db 'select count(*) from events' 2>/dev/null
#   On a healthy fleet with ≥1 team event since restart, count > 0.
#   Per ADR-202 §D3, the cockpit-mirror consumer is async + best-effort —
#   a temporarily empty DB during quiet periods is NOT a failure.
```

After ≥10 min of observation per team (1 real event delivered + no consumer crash-loop in `.atmux/logs/honker.log`), proceed to the next team in §6.

---

## §5 Rollback — `ATMUX_HONKER=off`

If post-restart shows substrate-related regressions (event storm, consumer crash-loop, ATTACH lock contention, kanban DB corruption), fall back to poll-mode:

```bash
cd /path/to/team-project

# (a) Disable via cage env. Path depends on your cage-env injection point:
#     - If using .atmux/cage-env.sh (operator dotfiles convention):
echo 'export ATMUX_HONKER=off' >> .atmux/cage-env.sh
#     - Or set per-team in team.json::env (lead-managed; see ADR-202 §D2):
#       lead runs `atmux config-reload` after editing team.json

# (b) Recycle the cage so the env disable takes effect
atmux stop --soft
atmux start

# (c) Confirm fallback
atmux doctor --json | jq '.checks[] | select(.label == "honker")'
# Expected: { "status": "info", "label": "honker",
#             "detail": "kill-switch off (ATMUX_HONKER unset or off); poll-mode in effect" }
```

**Accepted off-form values** per ADR-202 §Amendment 2026-05-21: `off`, `0`, `false`, `OFF`, `FALSE`. Garbage strings (`onn`, `disable`, `no`) fall back to **default-ON** — typo-safe positive form. Only the listed forms disable the substrate.

**After rollback:**

- gitter consumer falls back to its cron sweep (cron-backstop kept ≥30 days per ADR-202 §D6, so the path is always exercised)
- Watchdog consumers fall back to scheduled cron ticks
- No data loss — events that fired during the broken window were captured to per-consumer stream offsets; on next `ATMUX_HONKER=on`, the consumer drains from `last_processed` via at-least-once + UUIDv7 idempotency

Surface the rollback to the lead via `atmux send lead "<failure mode + log excerpt>"` so they can flag the regression upstream + queue a follow-up Task.

---

## §6 Active teams + per-team notes

Five active teams in scope as of 2026-05-21:

| Order | Team | Host | Per-team note |
|---|---|---|---|
| 1 | `unum` | hax | Lowest blast radius — single-product team, narrow kanban. Migrate first to validate the substrate end-to-end on a low-stakes target. |
| 2 | `sopx` | hax | Has nested submodules (`aix-root` / `std-root`). Cold-restart `atmux start` may need `ATMUX_SPAWN_TIMEOUT_MS=120000` exported per CLAUDE.md §Spawn timeout. Allow extra drain time. |
| 3 | `rentx` | hax | Largest kanban currently. Confirm `in-progress > 0` count carefully via §3(b) before stop; operator may want to wait for an in-flight Story to ship before recycling. |
| 4 | `ifca-docs` | hax | Docs-only team; smallest blast radius. Useful sanity check after rentx — if rentx introduced a regression, ifca-docs surfaces it cheaply. |
| 5 | `atmux` | hax | **LAST.** Driver runs inside this cage. See special handling below. |

### §6.1 atmux-self special handling

The atmux team's cage hosts the operator's driver Claude. Restarting it = restarting the operator's own session.

- **Do NOT** run `atmux stop --soft` on atmux from inside the atmux driver pane — the soft-stop kills the operator's own Claude conversation context mid-migration. Run from a separate tmux session (operator's daily-driver default — `tmux attach -t default`, not `atmux attach -t atmux_cockpit`) or directly via SSH.
- **Pre-stop hygiene**: run `/session preclear` from inside the atmux driver first if you want the post-restart Claude to bootstrap cleanly. This commits the conversation summary to memory before the cage cycle.
- **Post-restart**: re-attach via cockpit + observe `honker` doctor row green-or-yellow per §3(e); the new driver Claude bootstraps from CLAUDE.md without prior turn context.
- **Failure path**: if `atmux stop --soft` on atmux wedges (rare — usually a sentinel or merger pane mid-turn), fall back to `atmux stop --force` from the outside session. `--force` is documented per ADR-087 for the wedged case.

---

## Verification checklist (per team, end of §3 + §4)

- [ ] `atmux status --json | jq '.sessionState'` returns `"up"`.
- [ ] `atmux doctor --json | jq '.red'` returns `0` (no red rows across **all** probes — not just `honker`).
- [ ] `atmux doctor --json | jq '.checks[] | select(.label == "honker") | .status'` returns `"green"` (binary present) or `"yellow"` (graceful fallback) — **not** `"red"`.
- [ ] `.atmux/logs/honker.log` exists + writable (`ls -la .atmux/logs/honker.log`).
- [ ] On the first real event after restart, log shows a corresponding emit line within ~1s.
- [ ] No `consumer crash` / `boot failed` / `smoke probe failed` errors in `tail -50 .atmux/logs/honker.log`.

If any check fails on a non-atmux team: roll back via §5, surface to the lead, hold the rest of the fleet at the last-known-good state.

If any check fails on the atmux team specifically: do NOT migrate the next team (you're already at the last). Roll back atmux via §5 from the outside session; surface to the lead via `atmux send lead`; operator decides whether to retry or freeze the rollout.

---

## Reference

- [ADR-202 — Honker in-DB messaging substrate](adr/202-honker-in-db-messaging-substrate.md) — substrate decision, `ATMUX_HONKER` contract, fallback semantics, per-consumer cron-backstop
- [ADR-212 — Retire medic + lead-gated rotation pattern](adr/212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md) §D2 — why this RUNBOOK is operator-executed (never auto-fire from a verifier)
- [ADR-217 — Skills plugin bundled + wizard-installed](adr/217-atmux-skills-plugin-bundled-and-wizard-installed.md) — EPIC anchor; this RUNBOOK is Half-B of Story 1
- [ADR-200 — Install wizard](adr/200-install-wizard-guided-first-run-setup.md) §D6 — Honker extension provisioning (where the binary lands)
- [ADR-087 — atmux stop --soft](adr/087-atmux-stop-soft.md) — soft-stop semantics + drain contract
- [RUNBOOK-cockpit.md](RUNBOOK-cockpit.md) — cockpit topology reference (the atmux-self special case in §6.1)
- [RUNBOOK-stall-recovery.md](RUNBOOK-stall-recovery.md) — recovery patterns if a cage wedges during migration
- **Verifier script:** `scripts/migrate-to-honker.sh` (Story 8 / `t-76803578`, BE-owned, **verifier-only** — never executes the migration)
- **Doctor probe surface:** `src/verbs/doctor.ts::checkHonker` / `honkerStateRows` — the row this RUNBOOK reads at §3(e) + §5(c)
- Source for default-ON flip: commit `38cf2c6` (`feat(honker): flip default OFF → ON for driver-initiated dogfood`)
