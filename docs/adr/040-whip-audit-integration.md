# ADR-040: Whip → audit sub-pass + `[whip-audit]` Discord template

**Status**: accepted
**Date**: 2026-05-02
**Related**: [ADR-019](./019-discord-domain-separator.md) (Discord embed shape + palette), [ADR-038](./038-declarative-live-audit-model.md) (audit model + class taxonomy + gating policy), [ADR-039](./039-enforcer-agent-role.md) (enforcer role consumes whip-audit output)

## Context

ADR-038 lands `atmux audit` as a verb. Stand-alone CLI invocation is sufficient for one-off operator runs, but routine drift detection needs **continuous coverage** without the operator running anything. Two delivery channels exist:

1. **Cron line `0 5 * * * atmux audit --quiet`** — daily backstop. Useful for when whip is paused or the team is dormant, but daily cadence is too coarse for active fleets (drift introduced at 06:00 hides until tomorrow).
2. **Whip sub-pass** — every 5min, the per-team whip tick invokes audit as one of its checks. Same cron / same flock / same Discord pipeline.

Whip already runs `lib/whip.sh::main` every 5min via cron (per ADR-005 doctor preflight + ADR-009 whip rotate). Whip's structure is a sequential checks battery (session liveness, member pane state, lead uptime, decisions cursor, flags cursor, brief versions, since-last-tick delta), each appending to `findings[]`, then a single Discord embed at end-of-tick. Adding audit as one more check is mechanical.

The Discord channel needs a named template. Per global CLAUDE.md §"Discord message format": every send must be a *named template* — no unnamed prose dumps. Existing templates: `[whip-progress]`, `[whip-blocker]`, `[whip-heartbeat]`, `[whip-decisions]`, `[team-bootstrap]`. Audit findings need their own: `[whip-audit]`.

## Decision

### Whip sub-pass

`lib/whip.sh::_atmux_whip_check_audit` (new function) added to the checks battery. Sequence:

1. **Skip gate**: if `team.json:.audit.enabled == false`, no-op. Default true (audit-by-default).
2. Invoke `atmux audit --json --quiet` (current team scope; whip is per-team).
3. Parse findings array (per ADR-038 schema).
4. **Per-finding decision** (per ADR-038 gating):
   - **low-blast (D, E, F)** + auto-fixable → fire the fix via `atmux audit --fix --class <c>` synchronously; record outcome.
   - **medium-blast (A)** → check pane-state safety gate (driver pane idle); if idle, fire the fix; if not, surface as `⚠️`.
   - **high-blast (B, C)** → surface as `⚠️` with ready-to-fire command.
5. Compose `[whip-audit]` Discord row (see template below) + append to whip's `findings[]`.
6. Single Discord embed at end-of-tick batches all whip findings (existing behavior — audit row is one section).

**Idempotence**: a class-D fix on tick N produces zero findings on tick N+1 → no Discord row → silent green. Whip never spams "I fixed nothing this tick"; only surfaces on actual findings or fixes-fired.

**Failure mode**: if `atmux audit` exits non-zero with non-drift error (e.g. registry unreadable), whip logs the failure to `.atmux/logs/whip.log` + skips the audit section for the tick. Whip's other checks proceed unaffected.

### `[whip-audit]` Discord template

Per global CLAUDE.md format (header + bulleted body + per-bullet emoji):

```
🛡️ **[whip-audit]** · `<team>` · HH:MM MYT

🔧 **Auto-corrected** (low-blast):
🛠️ class D · `__ifca_aix__🪄lead-` → `__ifca_aix__🪄lead`
🛠️ class E · reaped `/tmp/atmux-tmux-d` (empty stray)

⚠️ **Surfaced — driver action**:
⚠️ class B · `unum`: `/tmp/atmux-tmux-unum` → `/tmp/atmux_tmux_unum` · fire: `atmux audit --fix --class b`
⚠️ class A · `atmux`: driver-pane busy — fire later: `atmux audit --fix --class a`

🛑 **Refused** (high-blast, manual only):
🛑 class C · `unum`: window position 11 → 1 · manual: `tmux swap-window -s 11 -t 1`
```

**Header**: `🛡️ **[whip-audit]**` (audit shield emoji), per-team domain, MYT timestamp via `TZ='Asia/Kuala_Lumpur' date +'%H:%M MYT'`.

**Sections** (only emit non-empty sections):
- 🔧 **Auto-corrected** (low-blast fixes that fired this tick) — `🛠️` per bullet, ≤80 chars.
- ⚠️ **Surfaced — driver action** (medium pane-busy + high-blast) — `⚠️` per bullet with ready-to-fire command.
- 🛑 **Refused** (any class where the fixer detected unsafe pre-state) — `🛑` per bullet with reason.

**Code-format** (backticks): team names, paths, fix commands, window names. Per global CLAUDE.md `Code-format ... for member names, SHAs, file paths, task IDs, URLs`.

**Banned**: free-prose dumps, single-paragraph status walls, run-on findings joined by em-dashes. Every finding is its own bullet.

**Empty-tick discipline**: zero findings + zero fixes → omit `[whip-audit]` from Discord entirely. No "audit clean" heartbeat row; whip's existing per-tick presence covers liveness.

### Discord pipeline

Routes through existing `lib/discord.sh::atmux::discord_embed_ping` via whip's end-of-tick batched embed. Audit row sits alongside other whip sections in the single tick embed (not a separate ping). `ATMUX_DISCORD_TRIGGER` env stays `whip` (caller-set in `lib/whip.sh`); per-row template name (`[whip-audit]`) is part of the body, not the trigger.

### Auto-fix audit log

Every auto-fix that fires writes a structured jsonl row to `.atmux/logs/audit.log`:

```json
{"ts":"2026-05-02T11:32:14+08","class":"D","team":"ifca_aix","action":"rename-window","from":"__ifca_aix__🪄lead-","to":"__ifca_aix__🪄lead","outcome":"ok"}
```

Allows post-mortem reconstruction when an auto-fix has unintended downstream effects. Schema mirrors `discord.log` shape (ADR-019 logging discipline).

## Consequences

- **`lib/whip.sh`** gains `_atmux_whip_check_audit` (~40 LOC) — invoke audit, parse JSON, decide auto-fix vs surface, compose `[whip-audit]` body, append to findings.
- **`lib/discord.sh`** gains `_atmux_whip_audit_format` template formatter (~30 LOC) — composes the bulleted body from a findings array + fix-outcomes array. Section emit only if non-empty.
- **`team.json`** gains optional `.audit.enabled` (default `true`). Opt-out for teams that explicitly want no audit pressure (e.g. observation-only teams).
- **`.atmux/logs/audit.log`** (new) — jsonl audit-fix log per team. Schema documented in `docs/audit.md`.
- **`tests/unit/whip_audit.bats`** — fixture: detector returns 4 findings (1 of each class A/D/B/C); assert auto-fix fires for D, surface for A (busy pane mock) + B + C; assert Discord body contains `[whip-audit]` header + correct sections.
- **No impact on existing whip behavior** — audit is one more check; other findings + Discord composition unchanged. `team.json:.audit.enabled = false` opts out cleanly.
- **Pane-state preflight** for class A reuses `_atmux_pane_busy` shape (ADR-025 OQ G4) — no new pane-state primitive.
- **Cost trade-off accepted**: each whip tick burns ~50–200ms running `atmux audit --json`. Acceptable; whip is async per-team. If contention surfaces, audit can move to every-Nth-tick (e.g. every 3rd tick = 15min cadence) — deferred until measured.

## Open questions (auto-mode resolved)

1. **OQ C1 (low): empty-tick row — emit "audit clean" heartbeat or omit?** Resolved: omit. Whip's existing per-tick presence covers liveness. Audit row only on findings/fixes. (low-rev)
2. **OQ C2 (medium): `team.json:.audit.enabled` default — true (chosen) vs false (opt-in)?** Resolved: true. Audit is opt-out. Reasoning: drift accumulates silently; default-on catches it. Teams that explicitly don't want it set `false`. (medium-rev — could flip to opt-in if false-positive rate proves high.)
3. **OQ C3 (low): audit-row position in whip embed — first / middle / last?** Resolved: middle (after delta-since-last-tick, before findings). Findings section is the alert surface; audit row is informational. (low-rev)
4. **OQ C4 (medium): cadence — every tick (5min, chosen) vs every-Nth-tick?** Resolved: every tick. Detector runs in <500ms per benchmark; whip's tick budget tolerates. Demote to every-Nth-tick if measured contention. (medium-rev)
5. **OQ C5 (low): audit.log location — `.atmux/logs/audit.log` (chosen) vs `~/.claude/teams/audit.log`?** Resolved: per-team `.atmux/logs/audit.log`. Mirrors `discord.log` + `whip.log` placement. (low-rev)

## References

- [ADR-019](./019-discord-domain-separator.md) — Discord embed shape + per-team palette
- [ADR-038](./038-declarative-live-audit-model.md) — audit model + class taxonomy + gating policy this template encodes
- [ADR-039](./039-enforcer-agent-role.md) — enforcer role aggregates `[whip-audit]` output across teams
- [global CLAUDE.md §Discord message format] — named-template pattern + per-bullet emoji + banned shapes
