# RUNBOOK — `atmux pulse`

Cockpit-wide deterministic verdict probe. Pings Discord on verdict change + sustained urgency. See ADR-086 for the rationale.

## What it does

Every 5 minutes (recommended), `atmux pulse` walks every enabled team in `~/.atmux/cockpit.json`, gathers a small bundle of inputs per team (root-repo commits in the last 30min, doctor red count, kanban in-progress/todo counts, open driver-inbox asks with their ages, open `🔵` decisions), computes one of five verdicts, and fires a Discord ping on transitions or sustained urgency:

- `🟢 Shipping` — commits in window, doctor green.
- `🟡 Cool` — quiet on purpose (no in-progress, no todos).
- `🟡 Idle` — quiet by accident (todos / in-progress exist, no commits yet).
- `🔴 Stalled` — 0 commits, in-progress ≥1, window aged past `windowMin`.
- `🚨 Need you` — open driver-asks ≥1 OR open decisions ≥1.

Discord is silent during steady-state 🟢 / 🟡 — you only hear it when something changes or stays urgent past the dedup window.

## Setup

### 1. Prerequisites

- `atmux` on `PATH` (any post-ADR-086 build).
- `~/.atmux/cockpit.json` present, with at least one enabled team.
- `ATMUX_DISCORD_WEBHOOK` env var set (or `~/.config/atmux/discord-webhook` file) when you want pings. Without a webhook, the verb still computes verdicts and updates state — it just skips the send.

### 2. Manual cron install

Edit your crontab (`crontab -e`) and add:

```
*/5 * * * * ATMUX_DISCORD_WEBHOOK=$(cat ~/.config/atmux/discord-webhook) /usr/local/bin/atmux pulse >> ~/.atmux/logs/pulse.log 2>&1
```

Adjust the `atmux` binary path to match your install. The log path is informational — tail it to see what fired.

### 3. Optional cockpit tunables

In `~/.atmux/cockpit.json`, add an optional `pulse` block:

```json
{
  "cockpitSession": "atmux_teams",
  "teams": [ ... ],
  "pulse": {
    "windowMins": 30,
    "intervalMins": 5,
    "dedupMins": 30
  }
}
```

Defaults are 30 / 5 / 30. Omit the block entirely for defaults; all three fields are individually optional.

- `windowMins` — commit-cadence observation window. The verdict logic consults `git log --since=<windowMins>min` and decides 🟢 / 🟡 / 🔴 based on the count.
- `intervalMins` — informational only (documented here, doesn't auto-install the cron line yet).
- `dedupMins` — re-fire window for sustained 🔴 / 🚨. Match the cron interval × N to control how often you get re-pinged on persistent urgency.

## Driving it manually

- **One-shot dry run (no Discord)** — `atmux pulse --json` prints a JSON array of tick results without firing pings (unless a webhook env is set).
- **Force a send** — `atmux pulse --ping` overrides the env-gating and always sends on `didFire`.
- **Different cockpit** — `atmux pulse --config /path/to/alt-cockpit.json` (or set `ATMUX_COCKPIT_CONFIG`).

## State file

`~/.atmux/state/pulse-state.json` — cockpit-scoped, one entry per enabled team. Atomic writes (mktemp + rename). Safe to inspect; safe to delete (next tick re-observes everything as a `first-observation`).

## Troubleshooting

- **No pings firing at all** — check `ATMUX_DISCORD_WEBHOOK`. Without a webhook AND without `--ping`, the verb skips sends. Confirm with `atmux pulse --json`: every `didFire: true` entry should map to a Discord message in the channel.
- **Same verdict pinged twice quickly** — that's `transition` then `sustained-urgency`. The first ping marks the verdict shift; the second confirms it stuck past `dedupMins`. If you want longer silence, raise `dedupMins`.
- **Team shows 🟢 Shipping but the build is broken** — doctor likely returned 0 red rows for the broken category. Run `atmux doctor --team-dir <root> --json` against that team and check the row list.
- **Team shows 🔴 Stalled but it just kicked off** — `windowAgeMin` is currently approximated as equal to `windowMin` (Phase 1). A truly-fresh team falsely triggers Stalled on the first observation. Workaround: send a quick `git commit --allow-empty -m bootstrap` in the team root, or wait one more tick.
- **`atmux pulse` errors with `ConfigError: no cockpit config at ...`** — seed `~/.atmux/cockpit.json` per the cockpit doc, or pass `--config`.

## Out of scope (Phase 2)

- MiniMax-via-OpenCode external observer rendering a parallel LLM verdict.
- Submodule-recursive commit cadence.
- Auto-install via `atmux cron-install --cockpit`.
- Per-team Discord webhook routing.
- Historical verdict timeline.

See ADR-086 for the full scope split.
