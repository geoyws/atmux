# ADR-143: External cron-fired lead-rotation enforcer (stopgap until martinet ships)

**Status**: proposed
**Date**: 2026-05-14
**Driver-ref**: 2026-05-14 driver session — operator: *"why is it that we always fail to rotate the lead?"*
**EPIC parent**: `t-a6a7afa0` (this Task — operates as informal EPIC pending planner re-decomp).
**Reviewer**: gate before T2 (verb impl) lands.

## Context

Lead self-rotation per `~/.claude/skills/coordination/whip/whip-prompt.md` §1a is a **context-dependent check**: the lead reads its own `~/.claude/teams/<team>/lead-session-start.txt`, computes uptime, and fires `atmux rotate-lead` if it exceeds [[project_atmux_install_topology]]'s `team.whip.leadMaxMin` (default 60min per `src/schema/team.ts:93`).

The defect: **the lead's context is exactly what rots when rotation is needed**. By the 60min mark, the lead pane is typically:

- 70%+ context-burn (per `leadCtxRotateThreshold`, `src/schema/team.ts:108`) — token budget close to compaction.
- Sometimes mid-`Compacting conversation` banner — keystrokes deferred, skill loops skipped.
- Sometimes refusal-pattern stuck (per [ADR-139]) — won't act on its own rotation check.
- Sometimes modal-cycling (per ADR-142 work) — running scan loops but not acting on findings.

A check that fires from inside the rotting context is the wrong topology for the failure mode. Field evidence on 2026-05-14 driver session: lead 8.5hr uptime undetected; downstream `t-7e7031dc` chain blocked because the lead's whip-tick had degraded silently.

### Why medic (ADR-077) doesn't cover this gap

Medic's hourly cadence misses by definition — a 60min threshold caught at hourly cadence has a worst-case 60min lag. Tightening medic's cadence to 5min would force Claude (Opus xhigh) into a per-team scan loop, which is exactly what [ADR-140] cheap-model-first principle is moving Claude OUT of.

### Why martinet (ADR-132) is the long-term home but not the short-term fix

Martinet (Cursor composer-2-fast at 270s in cockpit W3) will absorb routine rotation per [ADR-140] §"What MOVES to martinet". But martinet has open work — `CursorMartinet` impl (ADR-132 T3), `NudgeAction` enum extension (ADR-140 T4), escalation contract (`src/core/martinet-escalation.ts`). Until those ship, every uptime-threshold trip is at risk.

ADR-143 is the **stopgap**: a separate, mechanical cron line that doesn't depend on Claude (or any LLM) being awake, present, or willing.

## Decision

Add an **external cron-fired lead-rotation enforcer** that runs every 5min, reads each team's `~/.claude/teams/<team>/lead-session-start.txt`, and forces `atmux rotate-lead` when uptime > `team.whip.leadMaxMin` — **regardless of the lead's own state**.

The mechanism is bash-process-rooted (not Claude-rooted) and does not require any LLM to be reachable. Cron's own scheduler is the forcing function.

### New verb: `atmux check-lead-rotate`

```
atmux check-lead-rotate [--team <name> | --all-teams] [--dry-run]
```

- `--team <name>` — check a single team's lead.
- `--all-teams` — walk every team registered in `~/.atmux/cockpit.json` (canonical fleet list per ADR-077 / ADR-133 medic rename).
- `--dry-run` — log decision without firing `atmux rotate-lead`.

Behaviour:

1. Resolve target team(s).
2. For each team:
   - Read `~/.claude/teams/<team>/lead-session-start.txt` (epoch seconds, per [ADR-111] / [ADR-114]).
   - Compute `uptimeMin = (now - epoch) / 60`.
   - Compare against `team.whip.leadMaxMin` (default 60).
   - If `uptimeMin <= leadMaxMin`: log `lead uptime ok (<uptimeMin>min ≤ <leadMaxMin>min)` + skip.
   - If `uptimeMin > leadMaxMin`: emit diagnostic snapshot (see §Cross-checks), then either fire `atmux rotate-lead --team <name>` (default) or log-and-skip on `--dry-run`.
3. Append every decision (rotate / skip / outbox-deferred) to `~/.atmux/state/cron-rotate-lead.log` with MYT timestamp.

The verb is **idempotent** — re-running when the lead is within budget is a logged no-op. Re-running just after a force-rotate is also a no-op because `atmux rotate-lead` resets `lead-session-start.txt` to the new spawn epoch.

### Cron line (installed by `atmux cron-install --cockpit`)

```cron
# >>> atmux:cockpit-rotate
*/5 * * * * <atmux_bin> check-lead-rotate --all-teams >> ~/.atmux/state/cron-rotate-lead.log 2>&1
# <<< atmux:cockpit-rotate
```

The line is **separate** from the per-team `atmux:team=<name>` whip cron block (managed by `atmux start` / `atmux stop`) so:

- A paused team (whip cron removed) still has its lead rotation enforced if it's running.
- A broken whip-cron (judge-call timeout, schedule drift) doesn't take rotation down with it.
- The cockpit-rotate block is operator-controlled, not per-team toggled.

`atmux cron-install --cockpit` is the canonical write path; `atmux cron-remove --cockpit` is the inverse.

### Per-team threshold override

Already present in the schema as `team.whip.leadMaxMin` (default 60min). `check-lead-rotate` reads the value directly — no new config surface. Operators who want a slower-paced team (rare) bump it per-team:

```json
{
  "whip": { "leadMaxMin": 90 }
}
```

### Cross-checks before force-rotating

Before firing `atmux rotate-lead`, the verb captures a diagnostic snapshot to `cron-rotate-lead.log`:

```
[12:35 MYT 2026-05-14] team=atmux uptime=63min threshold=60min decision=ROTATE
  pane status:      Cooking (last capture)
  ctx token count:  287k/1000k (29%)
  outbox mtime:     12:11 MYT 2026-05-14 (24min ago)
  flags open:       0
```

Signals captured (informational only — does NOT gate the rotation by default):

- Pane status indicator (`Cooking…` / `Schlepping…` / `Compacting conversation` / etc. — `src/abstractions/tmux.ts::capturePane` is the existing primitive).
- Lead token count from pane footer (`tok N/M`).
- `~/.claude/teams/<team>/lead-outbox.md` last mtime — proxy for "is the lead producing replies?".
- `atmux flag list --status open` count for the team.

### Outbox-recent override (one-tick reprieve)

If **both** are true:

- `uptimeMin > leadMaxMin`
- `lead-outbox.md` mtime within last 10min (lead is actively replying)

…then on **this tick**, log `WARN: lead over uptime but actively responding — skipping rotation` and defer. On the **next 5min tick**, the override does NOT apply — force-rotate regardless of outbox activity.

The one-tick reprieve is intentionally narrow: it covers the case where the lead is mid-flush at threshold-trip, without indefinitely deferring rotation. State persists in `~/.atmux/state/cron-rotate-deferred.json` keyed by team name; reset on rotate-fire or on uptime returning to ≤ `leadMaxMin`.

## Failure modes addressed

| Failure mode | Pre-ADR-143 | Post-ADR-143 |
|---|---|---|
| Lead context-rot suppresses self-check | Undetected | Cron-fired, context-independent |
| Whip-cron paused (budget pause, schedule drift) | Rotation drops with whip | Separate cron line — independent |
| Lead stuck on modal / refusal pattern | No rotate fires | Cron force-rotates regardless |
| Medic 1hr cadence lag | Worst-case 60min stale | 5min worst-case |
| Routine rotation pre-martinet ship | Claude burns scan tokens | Bash-rooted, zero LLM tokens |

## Cross-references

- **[ADR-077](077-superdoctor-cockpit-role.md)** medic — hourly cadence; rotation authority narrowed to **emergency** code-fix scenarios post-[ADR-140]. ADR-143's cron-rotate handles routine uptime trips.
- **ADR-111** coordination skills integration — defines `lead-session-start.txt` write contract.
- **ADR-114** coordination runtime contract — formalises the path canonicalisation that ADR-143 consumes.
- **[ADR-132]** martinet — long-term home for routine rotation. ADR-143's cron is **deprecated-once-martinet-lands** (annotation header lands on this ADR when ADR-132 T3 ships).
- **[ADR-138]** verified send-keys — `atmux rotate-lead`'s post-rotate brief paste already uses `safeSendKeysWithVerify` internals; ADR-143's force-rotate inherits that guarantee.
- **[ADR-139]** refusal detection — orthogonal trigger class (refusal-pattern, not uptime). ADR-143 doesn't displace it.
- **[ADR-140]** cheap-model-first — establishes the principle that **external observation > self-check**. ADR-143 is the concrete bash-rooted instantiation while Cursor martinet remains pending.
- **`templates/briefs/lead.md` §Auto-rotation** — operator-facing description of `team.whip.autoRotate` (lead's own self-check). ADR-143 supplements it with the external forcing function.
- **`docs/medic.md`** — operational runbook for the medic role (renamed from `docs/superdoctor.md` per ADR-133); ADR-143's cron-rotate is documented alongside as a sibling fleet-wide cron line.
- `[[feedback_overnight_reddit_stakes]]` (memory) — operator threat on 0-commit overnights. ADR-143 protects against the failure class where the lead silently rots and downstream Tasks block.
- `[[feedback_rotation_threshold_400k]]` (memory) — context-pct threshold. ADR-143 fires on uptime; ctx-pct trigger remains lead-self-checked (until martinet absorbs it).

## Resolved open questions

- **Mid-task rotation risk.** If the lead is mid-dispatch when force-rotation fires, the dispatch is interrupted; the post-rotate brief paste re-bootstraps from `templates/briefs/lead.md`. Documented in the lead brief as accepted risk — rotation > over-60min-staleness, because over-60min staleness silently kills downstream task throughput.
- **State snapshot before rotation.** `atmux rotate-lead`'s existing handoff machinery (per `src/verbs/rotate.ts`) already snapshots the lead's state to `.atmux/handoff/<epoch>.md`. ADR-143 does not duplicate this — it relies on `rotate-lead`'s existing contract.
- **Cron line collision with whip.** Whip writes to `lead-session-start.txt` on team start / lead-spawn. `check-lead-rotate` is read-only on this file (the rotate fire is what triggers the re-write, via `rotate-lead`'s existing path). No file-write contention.
- **Dry-run as default**. Rejected — defeats the purpose. ADR-143's value is the forcing function; `--dry-run` exists as an operator-debug knob, not as the default behaviour.

## Sub-tasks (under EPIC `t-a6a7afa0`)

| Task | Subject | Lane | Deps |
|---|---|---|---|
| T1 (this) | Draft ADR-143 + same-commit doc updates (PRD verb table + lead brief note) | docs | — |
| T2 | `src/verbs/check-lead-rotate.ts` — new verb impl + diagnostic snapshot + outbox-recent override + per-team threshold read | be | T1 |
| T3 | `src/verbs/cron-install.ts` — append `cockpit-rotate` block on `--cockpit`; `src/verbs/cron-remove.ts` symmetric removal | be + ops | T2 |
| T4 | `tests/unit/verbs/check-lead-rotate.test.ts` — synthetic `lead-session-start.txt` scenarios (uptime ok / uptime over / outbox-recent defer / dry-run / cockpit-walk) | test | T2 |

T2-T4 are not yet filed as separate kanban Tasks. Per the planner-decomp empty-deps pattern observed across the project, files them now is cheap; deferring loses visibility. **Action**: planner to file T2-T4 as kanban Tasks immediately after this commit lands so they're claim-able.

## Consequences

**Positive**:

- Eliminates the "lead silently rots past 60min" failure class. The force-rotate is unconditional once the threshold is tripped.
- Zero LLM tokens for the rotation check itself — pure bash + cron. Doesn't add to Claude or Cursor burn.
- 5min worst-case detection lag vs medic's 60min worst-case.
- Independent of whip-cron health — pausing or breaking whip doesn't break rotation.

**Negative**:

- Mid-task rotation interrupts in-flight dispatch when threshold trips during work. Mitigation: outbox-recent one-tick reprieve gives a 5min wrap-up window.
- Two rotation paths (lead-self-check via whip + cron force-rotate) until martinet absorbs both. Operator-visible: two log surfaces (`whip.log` + `cron-rotate-lead.log`); diagnostic snapshot identifies which path fired.
- Cockpit-rotate cron line is **another** fleet-wide cron block to manage. Mitigation: `atmux cron-install --cockpit` + `atmux doctor` orphan-block detection handle install + cleanup.

**Reversibility**: high. Removing the cron line via `atmux cron-remove --cockpit` reverts to lead-self-check. The `check-lead-rotate` verb stays as a manual debugging tool even if cron is detached. No state migration required.

## Out of scope

- **Per-member auto-rotation cron** — separate concern; martinet (per [ADR-140]) absorbs it post-ship. ADR-143 is lead-only.
- **Pre-rotate state snapshot enhancements** — `atmux rotate-lead`'s existing handoff machinery is sufficient.
- **Cross-team coordination on rotation** — each team's rotation is independent; no fleet-level lock or sequencing.
- **Migration of medic's existing rotation paths** — medic retains emergency rotation per [ADR-140] §"Authority split"; ADR-143 covers routine-uptime only.

## Deprecation path

Annotation header lands on this ADR when [ADR-132] martinet's `CursorMartinet` impl ships and the `rotate-routine` `NudgeAction` (per [ADR-140] T4) is wired:

```
**DEPRECATED**: <date> — superseded by martinet `rotate-routine` per ADR-132 T3 + ADR-140 T4.
External cockpit-rotate cron line removed via `atmux cron-remove --cockpit`. Verb
`check-lead-rotate` retained as manual debug entry point.
```

Until then, ADR-143 is the load-bearing rotation guarantee.
