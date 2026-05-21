---
name: sweep
description: Fleet-wide diagnose + complain sweep — runs `atmux doctor` and `atmux status --json` across every enabled team, files complaints on anomalies, and takes structural fixes (rotate lead, clear member, push branch fix). Persisted host-pressure playbook (per ADR-198) is one trigger. Per ADR-077 substrate; manually invoked (the auto-spawned cockpit role was retired per ADR-212).
argument-hint: "[run | once | dry-run]"
---

<!-- carved per ADR-217 §D4 — superdoctor → sweep rename per §D2.1 -->

# /atmux:sweep — fleet-wide diagnose + complain (per [ADR-077](../../../../docs/adr/077-superdoctor-cockpit-role.md) substrate)

Single entry point for the cockpit-tier diagnosis loop. The auto-spawned cockpit role was retired per [ADR-212](../../../../docs/adr/212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md); the probe substrate persists and is now operator-invoked via this slash command.

- **`run`** (default, bare) — main loop turn. Reads `~/.atmux/cockpit.json`, sweeps each enabled team, triages, acts.
- **`once`** — single turn, do NOT re-arm. For ad-hoc dispatch from the operator.
- **`dry-run`** — full sweep + report what it would do, but take no action and write no complaints. For testing.

Empty args → `run`. This preserves the `/loop /atmux:sweep` contract.

## Verb dispatch

```bash
case "${1:-run}" in
  run)            ;;   # main loop turn — see §Run
  once)           ;;   # one-shot, no re-arm
  dry-run)        ;;   # full sweep, no side effects
  help|--help|-h) echo "Usage: /atmux:sweep [run | once | dry-run]"; exit 0 ;;
  *)              echo "Unknown verb '$1'. Usage: /atmux:sweep [run | once | dry-run]"; exit 1 ;;
esac
```

---

## §Run — main loop turn (default)

Hourly diagnosis-and-prevention sweep. Fires every 3600s by default — anomalies that warrant a fleet-wide sweep are rare; tighter loops burn Opus tokens on idle sweeps. Operators wanting a different cadence can tune via the re-arm step below.

### How to run

- **Start**: `/loop /atmux:sweep` — dynamic mode. The skill self-paces via `ScheduleWakeup(3600)` at the end of each turn.
- **Stop**: reply `stop` on the next turn, or exit the running pane.
- **Restart after `/clear`**: `/loop /atmux:sweep` again.

The expected runtime location is **any operator-driven pane with cockpit-tier visibility** (typically the cockpit superdriver REPL or a dedicated sweep-loop pane). Running it from inside a per-team cage is undefined — the role assumes it can see every enabled team's state from the host.

### Instructions

Each time this skill fires in `run` mode, do the following. Keep responses terse; goal is *action* and *durable complaints*, not narration.

1. **Load the brief.** Read `${CLAUDE_PLUGIN_ROOT}/skills/sweep/sweep-prompt.md` and follow it verbatim. It is the single source of truth for sweep behaviour.

   If `${CLAUDE_PLUGIN_ROOT}` is unset (legacy install), fall back to `~/.claude/plugins/atmux/skills/sweep/sweep-prompt.md`.

2. **Verify environment.** Confirm `~/.atmux/cockpit.json` exists. If absent, exit cleanly — no cockpit, no role.

3. **Execute the brief.** Run the per-team sweep, triage, investigate, decide authority, act, log to complaint box.

   **Eternal-improvement fallback**: if the per-team sweep finds zero anomalies AND zero open complaints AND every team is shipping (commit-cadence green per BAU verdict), trigger one cycle of `/atmux:bruh` §0.7 in driver-scope per team in scope — file ONE [improve P3] task per the heuristics there (tech-debt grep / ADR §OQ / coverage gap / aged doctor warn / lint sweep / stale memory). Sweep's hourly cadence + low-frequency anomaly profile makes it the natural place to inject background improvements without burning whip-rate tokens. Skip if operator freeze in lead's driver-inbox last 24h. Skip if CPU/RAM throttle active. Log under terminal report as `♻️ eternal improvement: <team> · t-XXXXXXXX <title>`.

4. **Re-arm.** At the end of the turn:

   ```
   ScheduleWakeup(delaySeconds: 3600, prompt: "<<autonomous-loop-dynamic>>", reason: "sweep re-arm")
   ```

   Default 3600s (1 hour). The cache-miss-vs-amortize tradeoff (see `ScheduleWakeup` docs) favours hourly here because anomaly investigation is genuinely sparse — the cache miss is amortized across an hour of "no work" instead of being paid every 5 minutes.

   `once` mode skips this step.

### §Run notes

- **Not a daemon.** Sweep dies with the pane session. `/clear` or exit kills the loop. Re-arm with `/loop /atmux:sweep`.
- **Action authority is real.** Per [ADR-077](../../../../docs/adr/077-superdoctor-cockpit-role.md) §D3 sweep may rotate leads, clear members, cycle cages, push fixes to atmux on its own branch + open PR, and modify `~/.atmux/cockpit.json`. Hard limits in §What it must NOT do (in the brief).
- **Action-before-log audit trail.** Every action is written to the complaint box BEFORE it executes. If the action turns out to be wrong, the audit trail survives.
- **Discord uses `[sweep]` prefix.** Operator-facing reports gate on the attention+verdict marker scheme; ban on unprefixed pings still applies.
- **Operator-facing report format.** All three modes (`run`, `once`, `dry-run`) emit reports using the attention+verdict scheme (👁 / ✅ / ⚠ / 🔴 / ℹ). The discipline + per-team derivation rules live in the brief at `sweep-prompt.md` §9.5; mirrors `/atmux:whip` §8.0, `/atmux:bau` header, `/atmux:bruh` §7, `/atmux:session` global, `/atmux:team` global, `/atmux:tell-lead`, and `/atmux:budget`.

---

## §Once — single turn, no re-arm

Operator-triggered one-shot. Same logic as `run` but skips the `ScheduleWakeup` re-arm at step 4. Useful when the operator wants sweep to do a sweep right now (e.g. after manually adding a new team to the roster, or post-incident before re-enabling the loop). Also the canonical entry point for the [ADR-198](../../../../docs/adr/198-medic-host-pressure-playbook.md) host-pressure playbook — when the host is under memory/IO pressure, the operator runs `/atmux:sweep once` to fire the 5-step playbook surface as one turn.

```
/atmux:sweep once
```

---

## §Dry-run — full sweep, no side effects

Executes the complete brief — read inbox, sweep teams, triage, investigate — but stops short of acting. No complaints written, no `atmux send` writes, no `tmux send-keys`, no commits or pushes. Reports findings to the calling pane only.

Used for operator-side spot-checking after a topology change, or for first-time setup when the complaint box (per ADR-077 §F2) hasn't shipped yet on a given install.

```
/atmux:sweep dry-run
```

---

## Status of the deferred follow-ups

This skill exists. The ADR-077 §F1-F4 deferreds remain tracked in atmux's kanban:

- **F2** (complaint box SQLite schema + `atmux complaints` verb) — until F2 ships, sweep logs complaints inline to its lead-queue + Discord. The brief's "log to complaint box" steps degrade to "log via Discord ping with `[sweep]` prefix".
- **F3** (`atmux send __sweep__`) — when shipped, members can ping sweep with heads-up. Until then, members surface signals via team Discord pings; sweep reads Discord history out-of-band.
- **F4** (P0 send-keys runbook) — folded into the brief's §Authority levels.
- **F5** (status verb sweep surface) — operator-side; doesn't change sweep's own behaviour.

## Cross-references

- [ADR-077](../../../../docs/adr/077-superdoctor-cockpit-role.md) — original cockpit self-healing role (this skill's substrate).
- [ADR-133](../../../../docs/adr/133-superdoctor-to-medic-rename.md) — historical rename of the cockpit role `superdoctor` → `medic` (to avoid collision with the `atmux doctor` verb).
- [ADR-212](../../../../docs/adr/212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md) — retirement of the medic cockpit-role auto-spawn; probe substrate + this slash command persist as on-demand surfaces.
- [ADR-198](../../../../docs/adr/198-medic-host-pressure-playbook.md) — host-pressure playbook (one trigger inside `/atmux:sweep`).
- [ADR-217](../../../../docs/adr/217-atmux-skills-plugin-bundled-and-wizard-installed.md) §D2.1 — naming rationale (`/atmux:sweep` vs `/atmux:superdoctor`/`/atmux:medic`).
