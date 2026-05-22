# ADR-215: Multi-driver support per atmux team — ordinal driver-N identity, default count 3, shared inbox with identity-prefix

**Status**: Accepted — ratified by driver 2026-05-21 (multi-instance the existing driver concept, NOT a new role tier; team.json::driverCount z.number().int().min(1).max(8).default(3); ordinal driver-N identity via ATMUX_DRIVER_ID env defaulting driver-1 for back-compat per §D2; shared lead-inbox.md + driver-inbox.md with per-entry identity prefix `from driver-N` / `to driver-N` per §D3 — wins for cross-thread visibility over per-driver inbox files; §D4 atmux tell-lead auto-tags, atmux reply --to driver-N required when N>1, --to-all broadcast supported; §D5 concurrency safety via existing SQLite WAL + flock primitives — no new locking; §D6 legacy single-driver back-compat preserved — absent ATMUX_DRIVER_ID env defaults to driver-1 + behavior identical to today; §D7 operator setup pattern documented; §D8 atmux status --json gains drivers[] enumeration + human-render `drivers: N/M active`; §OQ recommendations as-written; sopx convention precedent honored — default 3 per operator framing "sometimes we want to do multiple things at once"; consistent with simplification arc — net additive of 1 schema field + ~50 lines, 0 role tiers added)
**Date**: 2026-05-21
**Driver-ref**: 2026-05-21 operator — *"let's support multiple drivers per atmux team... and default the number to 3 drivers (just like sopx). sometimes we want to do multiple things at one time"*. Continues the same-session simplification arc — this is **multi-instance the existing driver concept, not a new role tier**, so it's net-additive without adding role complexity.
**Cross-refs**: [ADR-033](033-kanban-driver-only-flag.md) (driver-scope authority — preserved per driver-N), [ADR-029](029-driver-lead-team-scope-superdriver-cross-team.md) (driver/lead/team scope hierarchy), [ADR-042](042-superdriver-phase-2-implementation.md) (superdriver inbox pattern — sibling, fleet-scope; this ADR is intra-team multi-instance), [ADR-202](202-honker-in-db-messaging-substrate.md) §D3 (per-team state.db — driver writes route correctly with identity tag), memory `feedback_atmux_tell_lead_team_flag_no_target_switch` (current tell-lead routing — extended to carry driver-id).

## Context

Atmux today treats "driver" as a singular concept per team. The operator opens one Claude Code REPL outside the team's tmux session + that REPL has `ATMUX_MEMBER=driver` + `ATMUX_CALLER_SCOPE=driver` (per ADR-033). All driver-class operations flow through that single instance:

- `atmux tell-lead` writes to `<atmuxDir>/lead-inbox.md` (shared)
- Lead replies via `atmux reply` to `<atmuxDir>/driver-inbox.md` (singular target — anonymous)
- Driver-scope verbs (`team spawn-epic`, `pool add`, etc. per ADR-033) gated by env, not by identity

The architecture works for one operator thread. It breaks down when the operator wants to **multi-thread** their own work — e.g. one driver pane planning an EPIC for ifca-docs while another driver pane debugging sopx in parallel. Today the operator either:

- Opens multiple REPLs anyway → all entries collapse into `driver-inbox.md` with no provenance; lead can't tell who's asking what; replies go to "driver" ambiguously
- Serializes work into a single REPL → loses concurrency

Operator framing references sopx as a precedent for the 3-driver default. The change is fundamentally **identity-tagging + concurrent inbox routing**, not new role infrastructure.

## Decision

### D1 — Configuration: `team.json::driverCount`, default 3

Add a single field to the team schema:

```ts
// src/schema/team.ts (additive — back-compat for absent field)
driverCount: z.number().int().min(1).max(8).default(3),
```

Default **3** per operator directive. Cap at 8 to prevent runaway inbox traffic; raise via ADR amendment if operator hits the ceiling. Absent field on legacy team.json → defaults to 3 (covers the multi-driver case naturally).

No spawn-side provisioning — drivers don't live inside the team's tmux session. The operator opens N Claude Code REPLs themselves with `ATMUX_DRIVER_ID=driver-N` env per REPL. Atmux's responsibility is **honoring the identity**, not provisioning the panes.

### D2 — Driver identity: ordinal `driver-N` via env

Each driver pane sets:

```bash
export ATMUX_MEMBER=driver
export ATMUX_CALLER_SCOPE=driver
export ATMUX_DRIVER_ID=driver-2     # ordinal: driver-1 .. driver-N
```

`ATMUX_DRIVER_ID` defaults to `driver-1` if unset — preserves legacy single-driver back-compat. Reading code:

```ts
// src/abstractions/driver-id.ts (~20 lines, new)
export function getDriverId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.ATMUX_DRIVER_ID?.trim();
  if (!raw) return "driver-1";
  if (!/^driver-[1-8]$/.test(raw)) {
    throw new Error(`Invalid ATMUX_DRIVER_ID: ${raw} — must match driver-[1-8]`);
  }
  return raw;
}
```

**Why ordinals not names**: simplest mental model + matches operator framing "default the number to 3"; operator can later assign semantic labels via `team.json::driverLabels: {driver-1: "ifca-thread", driver-2: "sopx-thread"}` in a follow-up if needed.

### D3 — Inbox routing: shared files, identity-prefix on entries

**Single `lead-inbox.md`** for incoming-to-lead, **single `driver-inbox.md`** for outgoing-to-drivers. Identity preserved via per-entry prefix:

```markdown
## 2026-05-21 14:00 MYT — from driver-1 — please plan EPIC X
<body...>

## 2026-05-21 14:01 MYT — from driver-2 — please plan EPIC Y
<body...>
```

```markdown
## 2026-05-21 14:05 MYT — to driver-1 — EPIC X plan ready
<body...>

## 2026-05-21 14:06 MYT — to driver-2 — EPIC Y blocked on operator decision
<body...>
```

**Why shared files not per-driver inboxes**:
- Lead reads one file for full picture (cross-thread visibility)
- Operator reading driver-inbox.md sees all replies in chronological order; can filter via heading scan
- Concurrent-write safety already exists via the existing inbox lock pattern (`<inbox>.lock` flock per memory references)
- No file proliferation (1 lead-inbox + 1 driver-inbox per team regardless of N drivers)

Counter-argument considered + rejected: per-driver inboxes (`driver-1-inbox.md` etc.) would isolate threads cleanly, but lose the cross-thread cockpit-view that operators rely on. Shared file with prefix wins for operator UX.

### D4 — Verb impact: `tell-lead` auto-tags; `reply` accepts `--to`

```bash
atmux tell-lead "message body"
  → reads ATMUX_DRIVER_ID
  → writes entry with `from driver-N` prefix
  → no operator action required for the tag

atmux reply --to driver-2 "response body"
  → writes entry to driver-inbox.md with `to driver-N` prefix
  → required when N > 1; legacy `atmux reply "..."` defaults to `driver-1` for back-compat

atmux reply --to-all "response body"
  → broadcast to all driver-Ns
  → one inbox entry tagged `to *` — every driver reads it next turn
```

Other driver-class verbs (`team spawn-epic`, `pool add`, etc. per ADR-033) work as-is — caller scope is the gate, not identity.

### D5 — Scope authority + concurrency safety

All driver-N instances retain `ATMUX_CALLER_SCOPE=driver`. Concurrent driver-scope verb invocations:

- **Kanban writes** — already serialize via SQLite WAL + busy_timeout (ADR-126). Safe.
- **Inbox writes** — existing flock pattern (`<inbox>.lock`) handles concurrent appends. Safe.
- **Worktree mutations** (e.g. `team spawn-epic`) — directory + branch creation is per-EPIC-id; two drivers spawning DIFFERENT epics simultaneously is fine. Two drivers spawning the SAME EPIC ID — second call fails the existence check. Safe.
- **Destructive verbs** (e.g. `rotate-lead`) — race-condition risk if two drivers fire concurrently. Mitigation: rotate-lead verb already idempotent (re-fires reset the session-start; if two run in same second, both see fresh session-start, no harm). Other destructive verbs follow same pattern; per-verb audit deferred to follow-up.

**No new locking primitives added** by this ADR. Existing concurrency safety covers multi-driver.

### D6 — Migration: legacy single-driver back-compat

- Team configs without `driverCount` → schema `.default(3)` kicks in; behavior changes only when operator actually opens >1 REPL.
- Existing single-driver workflows unchanged — single REPL with no `ATMUX_DRIVER_ID` env defaults to `driver-1`; reads + writes are functionally identical to today.
- No state.db migration required (driverCount is a schema field, no DB column).
- Lead briefs and reviewer briefs don't need changes — they read inboxes by file, not by driver identity. The new `from driver-N` prefix is informational; lead can use it for triage but doesn't have to.

### D7 — Operator setup pattern

```bash
# Terminal 1
export ATMUX_DRIVER_ID=driver-1
cd /root/work/src/atmux && claude        # driver-1's Claude Code REPL

# Terminal 2 (concurrent)
export ATMUX_DRIVER_ID=driver-2
cd /root/work/src/atmux && claude        # driver-2's REPL

# Terminal 3 (concurrent)
export ATMUX_DRIVER_ID=driver-3
cd /root/work/src/atmux && claude        # driver-3's REPL
```

Operator can name terminals / tmux panes after the driver-id for visual triage. Future ergonomic helper `atmux driver claim` could auto-export the next available driver-id (deferred).

### D8 — Cockpit visibility

`atmux status --json` gains a `drivers[]` array enumerating active driver IDs (computed by scanning recent inbox entries for `from driver-N` patterns + the configured `driverCount`):

```json
{
  "drivers": [
    { "id": "driver-1", "lastSeenSec": 1717340400, "pending": 0 },
    { "id": "driver-2", "lastSeenSec": 1717340420, "pending": 1 },
    { "id": "driver-3", "lastSeenSec": null, "pending": 0 }
  ]
}
```

`pending` = count of `to driver-N` inbox entries the driver hasn't ACK'd (consumed via `atmux reply` heuristic — out of scope for this ADR; informational only).

Human-render adds a one-line `drivers: 2/3 active (driver-1, driver-2)` row under the cockpit summary.

## Consequences

**Becomes easier:**

- Operator multi-threads concurrent work without losing identity provenance.
- Lead's triage benefits from `from driver-N` prefix — can prioritize per-thread.
- Replies route deterministically to the asking driver via `--to driver-N`.
- No new role tier — fits the simplification arc (one config field + identity env + tag-on-write).
- Default 3 covers common case without operator config.

**Becomes harder:**

- Operator manages env vars across N terminals — slightly more setup than single-driver. Mitigation: future `atmux driver claim` helper; documented setup pattern in §D7.
- Lead's inbox grows roughly Nx — 3 drivers ask 3x the questions of 1 driver. Mitigation: rate-limit at driver discipline (operator's responsibility); lead's brief documents prioritization heuristics; cap at 8 prevents runaway.
- Race conditions on destructive verbs need per-verb audit (not done in this ADR — deferred per §D5).

**Risks + mitigations:**

- **Risk**: Two drivers issue conflicting destructive commands (e.g. driver-1 rotate-lead while driver-2 stop --soft). **Mitigation**: rotate-lead is idempotent; soft-stop respects session-state. Pathological pair → operator's responsibility to coordinate. Doctor probe could flag concurrent destructive intents in a future amendment.
- **Risk**: Lead misreads `from driver-1` vs `from driver-2` and replies to wrong target. **Mitigation**: reply verb requires `--to <driver-id>` when N>1 (schema-level — refuse without explicit target). Auto-detect-from-context fallback when only one driver-id appears in the last 5 inbox entries.
- **Risk**: Operator forgets `ATMUX_DRIVER_ID` env in a new terminal → defaults to driver-1 → collides with existing driver-1. **Mitigation**: env detection prints `[driver-1, defaulting from unset ATMUX_DRIVER_ID]` warning at every driver-scope verb invocation; operator catches the bug visually.
- **Risk**: ADR-042 superdriver-inbox (fleet-scope) interaction unclear — does superdriver tell N team drivers? **Mitigation**: out of scope for this ADR; superdriver-inbox is fleet-scope per ADR-042, separate plane from intra-team drivers. Cross-ref noted; integration ADR if/when superdriver phase 2 ships.

## Out of scope (deferred)

- **Named driver labels** (`driver-fe`, `driver-be`) — ordinals sufficient for v1. Semantic naming in follow-up ADR if patterns emerge.
- **`atmux driver claim` ergonomic verb** — operator auto-allocates next available driver-id. Useful but not needed for v1 (export-env is one-liner).
- **Per-driver inbox files** — explicitly rejected per §D3 in favor of shared file with identity-prefix. Revisit if cross-thread visibility proves to be a tax rather than a benefit.
- **Driver-to-driver direct messaging** — out of scope; drivers communicate via shared kanban + via the lead. If direct DM needed, follow-up ADR adds `atmux driver tell --to driver-N`.
- **Per-verb concurrency audit** for destructive driver-scope verbs — flagged in §D5; follow-up audit-EPIC if observed conflicts emerge.
- **Superdriver-N (multi-fleet) integration** — ADR-042 is the fleet-scope plane; intra-team is this ADR. Bridge in a future ADR if both go multi-instance simultaneously.

## References

- ADR-033 — driver-only flag (driver-scope authority preserved per driver-N)
- ADR-029 — driver/lead/team scope hierarchy (multi-instance the driver tier)
- ADR-042 — superdriver phase 2 (fleet-scope sibling; separate plane)
- ADR-126 — state.db / SQLite WAL (concurrency primitive used for §D5 safety)
- memory `feedback_atmux_tell_lead_team_flag_no_target_switch` — current tell-lead routing (extends with driver-id tag)
- memory `feedback_opus_all_for_agile_flow` — operator stance; drivers stay Opus (already are)
