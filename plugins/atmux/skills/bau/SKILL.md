---
name: bau
description: Business-as-usual status check + velocity-fix escalation. Reports commit cadence, rate-limits, kanban, churn per team across the cockpit (or single team from inside a cage). Auto-escalates Dormant teams to lead. `/atmux:bau [hours] [--no-fix]`. Default window 24h.
argument-hint: [hours] [--no-fix] [--digest|--no-digest]
---

<!-- carved per ADR-217 §D4 -->

# /atmux:bau — Business As Usual status check

## How to invoke

Run the script and emit its stdout **verbatim** as the response. The script does everything — scope detection, parallel data collection, verdict computation, velocity-fix escalation, and final markdown rendering. **Do not re-run sub-commands yourself; do not re-format the output.**

```bash
${CLAUDE_PLUGIN_ROOT}/skills/bau/scripts/bau.sh $ARG
```

Pass `$ARG` through verbatim — the script handles arg parsing (`HOURS`, `--no-fix`, `--digest`/`--no-digest`).

If `${CLAUDE_PLUGIN_ROOT}` is unset (legacy install), fall back to `~/.claude/plugins/atmux/skills/bau/scripts/bau.sh`.

### Attention-header prepend (after script emits)

The script emits per-team verdicts (🟢 BAU / 🟡 Quiescent-fresh / 🟡 Quiescent-stale / 🔴 Dormant / 🚫 Rate-Limited / 💀 Saturated / ⚙️ Stuck-input / 💤 Down). The operator scans these but needs a *single sentence at the top* telling them whether the report needs their action or is just FYI.

**Before the verbatim script output, prepend exactly one of these three header lines** based on the verdicts present in the report:

- `**👁 Needs your call** — <one phrase naming the team(s) and the ask>` — when ANY team's verdict is 💀 Saturated, ⚙️ Stuck-input, 🚫 Rate-Limited with no recovery within window, OR 🔴 Dormant where the auto-escalation to lead has already fired AND the lead's velocity-fix didn't land within the next bau window
- `**⚠ Watching** — <one phrase>` — when ANY team is 🟡 Quiescent-stale or 🔴 Dormant where auto-escalation just fired (give the lead one cycle to fix)
- `**✅ All teams BAU** — N green, M quiescent-fresh, <hours>h window` — when every team is 🟢 BAU or 🟡 Quiescent-fresh

This is a thin synthesis layer — DO NOT re-format the script body. The operator's eye lands on the header, decides whether to read the table, and moves on.

Verdict-mapping rationale (mirrors `[[feedback-unambiguous-attention-and-verdict]]` and whip §8.0 / medic §9.5):
- 🟢 BAU and 🟡 Quiescent-fresh map to ✅ (the team is working as intended)
- 🟡 Quiescent-stale maps to ⚠ (sliding, watch one cycle)
- 🚫 Rate-Limited / 💤 Down / 💀 Saturated / ⚙️ Stuck-input / 🔴 Dormant map to 👁 + 🔴 unless the auto-fix is in-flight (then ⚠ for one cycle)

If the script's escalation step (Step 5) already wrote a velocity-fix to the team's lead-inbox, name that team and "auto-fix dispatched, watching next cycle" in the ⚠ header — the operator doesn't need to act unless the lead also fails.

## Arguments

- `<hours>`: integer, default `24`. Time window for commit-cadence + task-completion checks.
- `--no-fix`: disables Step-6 velocity-fix escalation, keeps the read-only diagnostic.
- `--digest` / `--no-digest`: forces the shipped-features digest on/off. Default is auto — on for `HOURS ≥ 24`, off below.

## What it does (1-line summary per step)

1. Detects scope from the tmux socket (cockpit-wide vs single-team cage).
2. Loads the team roster from `~/.atmux/cockpit.json`.
3. Fans out per-team data collection in parallel (git root + submodules, `atmux task list`, `atmux complaints list`, per-window `tmux capture-pane`).
4. Computes per-team verdict: 🟢 BAU · 🟡 Quiescent-fresh · 🟡 Quiescent-stale · 🔴 Dormant · 🚫 Rate-Limited · 💀 Saturated · ⚙️ Stuck-input · 💤 Down.
5. If verdict trigger fires (last ship age ≥ `BAU_STALE_THRESHOLD_HOURS`, default 4h) and the lead can act, writes a velocity-fix directive to that team's `.atmux/lead-inbox.md` via `atmux tell-lead`. Skipped on Rate-Limited / Saturated / Down / Stuck-input.
6. Emits the final markdown report on stdout.

> **Legacy filename** (one-release back-compat per ADR-198): per-team `.atmux/driver-inbox.md` is still readable when present, so a velocity-fix landing during mid-rollout doesn't get lost if a team hasn't been migrated yet. New writes go only to `.atmux/lead-inbox.md`.

## Key invariants (so the model knows what it's reading)

- **Timezone-aware timestamps.** All HH:MM tags render in the user's configured `COORDINATION_TZ` (plugin userConfig, default `UTC`) with the `COORDINATION_TZ_SUFFIX` appended (default `UTC`). Override at the shell with `COORDINATION_TZ=… COORDINATION_TZ_SUFFIX=…`.
- **Durations**: `<60min` → `Nmin`, `≥60min` → `HhMm`. Never day units.
- **State source is SQLite via atmux verbs** (post-ADR-076). Never grep `.atmux/kanban.json` — that file is gone. `atmux task list --json`, `atmux complaints list --status open --json` are the truth source.
- **Lead is always window 2** per ADR-044 + CLAUDE.md "Team Roles". The script doesn't `jq` into `team.json` to find it.
- **`Working` is defined by commit-cadence, not pane liveness** (CLAUDE.md L191).
- **Cage socket resolution** tries `/tmp/atmux-<team>/sock` (legacy) then `<team-root>/.atmux/tmux/tmux-0/default` (current).
- **Stuck-input is cross-checked against whip-velocity-gate.log** (per t-0a4fc7f6). When pane-snapshot reports `queued_n>=3`, the script reads the team's last 3 entries from `$HOME/.atmux/logs/whip-velocity-gate.log` — if ANY show `velocity=OK`, the team is demonstrably shipping (commits-30min >= 1) and the verdict falls through to the normal BAU ladder instead of `⚙️ Stuck-input`. Stuck-input fires only when BOTH signals (pane-snapshot AND velocity-gate) agree teams are idle. The cross-check function lives at `scripts/lib-velocity-gate.sh` with bats tests at `tests/velocity-gate.bats`.

## When the script fails or surprises

- If `~/.atmux/cockpit.json` is missing → script exits 1 with a one-line error.
- If a team has no cage socket → verdict is `💤 Down` (correct surface).
- If the operator passes a scope that doesn't match the cockpit roster (e.g. from inside an unregistered cage), the script falls back to all-teams and prepends a `> note:` line explaining.

The script is the source-of-truth for behaviour. If the output looks wrong, read `scripts/bau.sh` — verdict ordering, escalation gating, and digest bucketing all live there with comments. Do NOT re-implement the procedure in this skill prompt.

## Performance

Single bash invocation; all probes fanned out in parallel. Wall-clock typically **0.5-2s** for a 3-team cockpit. The prior multi-step LLM procedure took 30-60s.

## Examples

```
/atmux:bau              # cockpit-wide (or single-team if invoked from a cage), 24h + auto-escalate
/atmux:bau 48           # 48h window
/atmux:bau 1            # last hour
/atmux:bau 168          # last week — long-horizon churn + cadence review
/atmux:bau 24 --no-fix  # read-only — no lead pings
/atmux:bau 1 --no-digest    # skip shipped-features digest
```
