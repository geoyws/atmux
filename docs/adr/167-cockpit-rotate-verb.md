# ADR-167: `atmux cockpit rotate <session-name>` — Rung C canonical rotation verb

**Status**: proposed
**Date**: 2026-05-16
**Driver-ref**: `.atmux/driver-inbox.md` §🆕 BACKLOG ASK 23:34 MYT 2026-05-16

## Context

The `/bruh` skill §3a delegates rotation of **cockpit-level roles** — `medic` (W2), `sentinel` (W3), and per-team driver panes (W4+) — to the atmux lead. Today, Rung C of /bruh's escalation chain falls back to a **manual handoff + Ctrl-C + canonical-respawn** sequence the operator performs by hand. There is no `atmux` verb for the operation.

This works but has three drawbacks:
1. **Operator burden**: rotation is a multi-step protocol (capture handoff, kill, respawn with the right wrapper, re-arm cadence). Manual execution is error-prone — wrong wrapper, missing re-arm step, lost handoff state.
2. **No safety gates**: the operator must self-enforce "don't rotate while typing in superdriver", "don't rotate a pane that's mid-turn", "don't rotate too soon after spawn". Each is a real failure mode that has cost time in the past.
3. **No audit trail**: rotations don't land in a structured log, so post-incident analysis ("when was sentinel last rotated and why?") requires reading scrollback.

[ADR-162](162-atmux-owns-tmux-infrastructure.md) put cockpit tmux infrastructure squarely in atmux's scope. This ADR closes the missing Rung C verb on that surface.

Rungs in /bruh's chain (for cross-ref):
- **Rung A**: member-pane rotation via `atmux rotate <member>` — shipped, exercised daily.
- **Rung B**: lead-pane rotation via medic's `/team rotate-lead` orchestration — shipped.
- **Rung C (THIS ADR)**: cockpit-role rotation — manual today; verb-formalized here.
- **Rung D**: full cockpit rebuild via `atmux cockpit rebuild --force-cycle` — shipped.

## Decision

Add `atmux cockpit rotate <session-name>` verb under the existing `src/verbs/cockpit.ts` dispatcher (mirror the existing `cockpit rebuild` subverb pattern). Surface:

```
atmux cockpit rotate medic [--force]
atmux cockpit rotate sentinel [--force]
atmux cockpit rotate <team-name> [--force]
```

`<session-name>` is one of three canonical targets:
| Target | Cockpit window | What rotates |
|---|---|---|
| `medic` | `_medic` (W2 per ADR-135) | self-healing role pane |
| `sentinel` | `_sentinel` (W3 per ADR-158) | whip-manager pane |
| `<team-name>` | `<team-name>` (W4+) | per-team driver pane (NOT the team's lead — lead lives in cage per ADR-162) |

Hard-refused targets: `superdriver` (W1, operator REPL).

### Pre-flight gate matrix

Four gates execute in order; any failure aborts with `exit 65` (EX_DATAERR) and a structured stderr line:

| # | Gate | Description | `--force` bypass? |
|---|---|---|---|
| 1 | user-not-typing | Capture `<cockpit_session>:_superdriver` compose-box; refuse if non-empty (operator may be about to reference target panes) | yes |
| 2 | pane-idle | Capture target pane last 60s; refuse if `✽`/`✻`/`Compacting` markers present | yes |
| 3 | uptime | Read per-role session-start marker mtime; refuse if `<60min` ago (premature rotation) | yes |
| 4 | never-rotate-superdriver | Hard-check `session-name == "superdriver"`; ALWAYS refuse | **no** |

Gate 4 fires before 1–3 (cheapest + most-load-bearing). `--force` is meaningful for operator override of 1–3 only; gate 4 is unconditional.

### Per-role respawn matrix

```
1. assemble handoff payload (role-specific; see §Handoff)
2. atomic-write handoff to ~/.claude/teams/__cockpit__/<role>/handoff.md (flock per ADR-005)
3. send Ctrl-C via safeSendKeysWithVerify (ADR-138) — wait 3s grace, then HUP if still alive
4. tmux kill-pane -t <cockpit_session>:<window>
5. resolve claudeAccount wrapper from cockpit.json (see table below)
6. respawn pane via tmux new-window / respawn-window with the resolved wrapper
7. re-arm role-specific cadence (medic → /superdoctor; sentinel → sentinel-tick; team-driver → tell-lead-tick)
8. append outcome row to ~/.atmux/state/cockpit-rotate-audit.log (NDJSON)
```

ClaudeAccount wrapper resolver (extracted to `src/abstractions/claude-account-wrapper.ts` per ADR-094 c-alias convention):

| `claudeAccount.configDir` | Wrapper |
|---|---|
| `/root/.claude` (default) | `claude` |
| `/root/.claude-unum` | `c-u` |
| `/root/.claude-icloud` | `c-ic` |
| `/root/.claude-ifca` | `c-i` (if exists) |
| (unknown) | refuse with `ConfigError` — hint operator to register the wrapper |

Lead panes are **unaffected** — leads live in the team cage on per-team sockets per ADR-162; this verb operates on the cockpit shared socket only.

### Handoff payload schema (per-role)

All payloads land at `~/.claude/teams/__cockpit__/<role>/handoff.md` in brief-paste-ready Markdown:

**medic**:
- in-flight diagnosis state from `src/verbs/medic.ts` runtime
- recent complaints (`.atmux/state.db` complaints WHERE `source_kind = 'medic'`, last N)
- recent rotation calls (tail-N from cockpit-rotate-audit.log WHERE `role = 'medic'`)

**sentinel**:
- whip-classifier state snapshot
- NudgeAction history (last N from per-team sentinel logs)
- recent escalations (filter audit log by sentinel-escalated rows)

**team-driver**:
- recent tell-lead history (`.atmux/lead-outbox.md` or `tells` SQLite table tail-N)
- outbox state snapshot at rotation time

### Audit log

`~/.atmux/state/cockpit-rotate-audit.log` — NDJSON, append-only. One row per rotation attempt:

```json
{"ts":"2026-05-16T23:45:12+08:00","role":"medic","sessionName":"medic","outcome":"success","durationMs":4231,"callerScope":"driver","handoffPath":"/root/.claude/teams/__cockpit__/medic/handoff.md"}
{"ts":"2026-05-16T23:46:08+08:00","role":"sentinel","sessionName":"sentinel","outcome":"gate-1-refused","durationMs":12,"callerScope":"driver","error":"superdriver compose-box non-empty"}
```

Outcome values: `success` / `gate-N-refused` / `respawn-failed` / `handoff-write-failed`.

### Caller-scope gate

Per [ADR-033](033-caller-scope-gate.md): verb refuses non-driver callers. Cockpit rotation is high-consequence (parallel to spawn-epic / dissolve-epic); restricting to `ATMUX_CALLER_SCOPE=driver` matches the existing pattern for cockpit-level mutations.

### Ordering invariant

**Handoff write lands BEFORE Ctrl-C** so the rotation can be re-traced if the respawn step crashes mid-flight. Audit-log row writes AFTER the respawn attempt completes (success or fail) so the row's `outcome` reflects ground truth.

## Consequences

- **Operator burden drops**: four-gate-protected single-verb replaces multi-step manual protocol. The /bruh skill §3a manual-fallback note flips to "use `atmux cockpit rotate <session-name>`".
- **Audit trail**: NDJSON log captures every rotation attempt + outcome. Post-incident analysis no longer requires scrollback grepping.
- **Safety gates close real failure modes**: gate-1 (user-typing) closes the "operator was typing when I rotated their reference pane" class; gate-3 (uptime) closes the "rotated too soon after spawn, lost context unnecessarily" class.
- **Cockpit shared socket only**: leads are unaffected (per-team sockets per ADR-162). Lead rotation continues to use Rung B (medic's `/team rotate-lead`).
- **Verb fits within ADR-162's scope**: atmux owns cockpit tmux infrastructure; this verb is the canonical surface for cockpit-pane lifecycle ops alongside `cockpit rebuild`.
- **Audit-log growth bounded**: rotation is operator-fired (not cron); growth rate is one row per manual rotation. V1 has no rotation/truncation policy; if usage ramps to >100 rows/week, add a rotation policy in a follow-up ADR.
- **Per-role marker location** (per-role session-start mtime source for gate-3): under `~/.claude/teams/__cockpit__/<role>/session-start.txt`. Markers are written at spawn time by the same cockpit-pane spawner that this verb tears down + replaces.
- **Out of scope (v1)**:
  - Auto-rotation (cron-fired) — defer; v1 is operator-fired only.
  - Batch rotation (rotate all 3 cockpit roles in one command) — defer; v1 is per-target.
  - Cross-machine rotation (rotate a cockpit pane on a remote host) — defer; v1 is local-only.
  - Lead-pane rotation via this verb — out of scope (Rung B already covers it).

## Open questions

1. **OQ-1 (RESOLVED, LOW-rev)**: per-role session-start marker location — `~/.claude/teams/__cockpit__/<role>/` vs `~/.atmux/state/cockpit/<role>/` vs sibling of cockpit.json.
   - **Default**: `~/.claude/teams/__cockpit__/<role>/session-start.txt`.
   - **Rationale**: matches the existing `~/.claude/teams/<team>/lead-window-name.txt` convention used by lead-marker.ts (per ADR-135 D2); single convention across role-marker files.

2. **OQ-2 (RESOLVED, MEDIUM-rev)**: handoff payload size cap — none / 100KB / 1MB.
   - **Default**: 100KB soft cap per handoff payload. Larger payloads truncate with a `[...truncated at 100KB; see audit log for full assembly inputs]` trailer.
   - **Rationale**: brief-paste-ready handoffs that exceed 100KB are pathological (Claude Code paste-buffer + first-input quirks per ADR-081); truncation is safer than failure. Audit-log row references the full inputs so nothing is lost.

3. **OQ-3 (RESOLVED, LOW-rev)**: Ctrl-C wait policy on in-flight pane — graceful (3s) vs hard (immediate kill).
   - **Default**: graceful 3s wait, then HUP. The wait is bounded; matches operator muscle-memory for tmux pane teardown.
   - **Rationale**: a graceful shutdown lets the existing claude session flush its compose state to disk before death; the bounded wait prevents pathological lockup.

4. **OQ-4 (RESOLVED, LOW-rev)**: re-arm cadence path — single shim function vs per-role inline.
   - **Default**: per-role inline. Each role's cadence has different triggers (cron line for medic + sentinel; tick-injection for team-driver) and a single shim would force unnatural abstraction.
   - **Rationale**: re-arm is the LAST step of the per-role respawn matrix; coupling it to the respawn site keeps the responsibility local.

5. **OQ-5 (RESOLVED, LOW-rev)**: refusal exit codes — single 65 (EX_DATAERR) vs per-gate distinct codes.
   - **Default**: single 65 for all gate refusals. Stderr line distinguishes the specific gate (`gate-N-<name>: <reason>`).
   - **Rationale**: matches ADR-006 top-level error mapping (one code per error class); over-specifying exit codes invites operator confusion.

6. **OQ-6 (RESOLVED, LOW-rev — deferred)**: audit-log rotation policy.
   - **Default**: defer to follow-up. V1 ships append-only with no rotation; v2 adds size-cap rotation if growth proves problematic.
   - **Rationale**: rotation is operator-fired; growth is bounded. Premature rotation policy is over-engineering.

## Related

- [ADR-006](006-error-class-and-exit-code.md) — error class → exit code mapping (65 EX_DATAERR for gate refusals).
- [ADR-033](033-caller-scope-gate.md) — caller-scope gate; cockpit rotate is driver-only.
- [ADR-077](077-superdoctor-self-healing.md) → renamed medic per ADR-133 — medic cadence; re-arm step in per-role respawn matrix.
- [ADR-094](094-c-alias-spawn-convention.md) — c-alias spawn convention; claudeAccount wrapper resolution.
- [ADR-132](132-pluggable-martinet.md) → renamed sentinel per ADR-158 — sentinel pluggable martinet pattern.
- [ADR-135](135-cockpit-naming-convention.md) — `_-prefix` cockpit window naming; medic / sentinel window IDs.
- [ADR-138](138-verified-send-keys.md) — safeSendKeysWithVerify; all Ctrl-C + spawn-prompt sends route through this.
- [ADR-155](155-pane-state-classifier.md) — pane-state probe; reusable abstraction for gate-1 + gate-2.
- [ADR-162](162-atmux-owns-tmux-infrastructure.md) — atmux owns cockpit tmux infrastructure; this verb fits within that scope.
- `/bruh` skill §3a — manual fallback today; T8 flips to canonical-verb path post-impl.
