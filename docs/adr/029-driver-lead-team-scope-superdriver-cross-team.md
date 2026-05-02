# ADR-029: Driver + lead are scoped to own team; only superdriver messages cross-team

**Status**: accepted
**Date**: 2026-04-27
**Related**: [ADR-025](./025-superdriver-phase-1.md) (superdriver Phase 1 read-only), [ADR-027](./027-team-rename-verb-and-topology-invariant.md) (registry as identity source of truth)

## Context

Today, any tmux pane running `atmux --team-dir <any-team> <write-verb>` can message any team. Driver of `atmux` team can `atmux --team-dir /root/work/ifca/src/myteam-alpha-root tell-lead "..."` and write into myteam-alpha's driver-inbox + send-keys to its lead pane. There is no caller-identity check; the only gate is filesystem access to the target's `.atmux/` directory.

This breaks an architectural invariant the driver wants to enforce: **drivers are scoped to one team's project; leads are scoped to one team's members; cross-team coordination requires the superdriver tier**.

Driver feedback 2026-04-27 09:55 MYT: *"make sure that only drivers and leads are scoped to their own projects... only the superdriver can message anyone."*

The current uncontrolled cross-team write surface has produced concrete drift today:
- The atmux-team driver dispatched commit+push directives to myteam-alpha + myteam-beta-root + myteam-c-dev in conversation. Workflow-fine, but architecturally this should have flowed: driver → superdriver → other team-leads. The driver-of-atmux is NOT the driver-of-myteam-alpha; same human at the keyboard does not transfer scope.
- Without the gate, a buggy script or wedged automation could write to every team's kanban from any pane.

The scope policy must be enforced at the tool surface, not via discipline alone.

## Decision

**Scope tiers:**

| Caller identity | Read scope | Write scope |
|---|---|---|
| **Driver** (own team's driver pane) | Own team only | Own team only |
| **Lead** (own team's lead pane) | Own team only | Own team only — to that team's members |
| **Member** (own team's member pane) | Own team only | Own team's lead + driver only (via `reply`) |
| **Superdriver** (`__superdriver__home` pane in `superdriver` session) | All teams (read aggregator) | All teams (write to any team's driver-inbox / lead-outbox / kanban) |

**Caller-identity resolution** (new helper `atmux::resolve_caller_scope`):

1. Read `tmux display-message -p '#S:#W'` to get current `<session>:<window>`.
2. Lookup against `~/.claude/teams/registry.json`:
   - Match to `superdriver.{sessionName, windowName}` → caller scope = `superdriver`.
   - Match to `teams[].members[]` where `windowName = __<team>__<member>` AND member.role/name resolves to `team-lead` or `lead` → caller scope = `lead@<team>`.
   - Match to `teams[].driverSession` (registry-tracked driver pane per team) → caller scope = `driver@<team>`.
   - Else → caller scope = `unknown` (refuse-by-default for write verbs; allow read verbs with warning).

**Refuse-gate placement** (helper `atmux::guard_scope <target-team>`):

- `tell-lead` / `tell` / `send` / `broadcast` / `dispatch` / `reply` / `task add` / `task move` / `outbox --ack` / `decisions add` / `flags add` / `flags resolve` — every WRITE verb invokes the guard before touching state.
- Guard logic:
  - If caller scope == `superdriver`: allow any target. **Log the cross-team write to `~/.claude/teams/registry.json:.superdriver.writeAuditLog`** (rate-limited, append-only).
  - Else if caller scope == `driver@X` AND target team == X: allow.
  - Else if caller scope == `lead@X` AND target team == X: allow.
  - Else if caller scope == `member@X` AND verb == `reply` AND target team == X: allow.
  - Else: `atmux::die` with structured error message: `"scope violation: caller=<id> target=<team> verb=<v>. Cross-team writes require superdriver. Attach to superdriver pane or run from own team's driver/lead/member."`

- Read verbs (`status`, `task list`, `task show`, `outbox` w/o `--ack`, `decisions list/show`, `flags list`, `super-status`) are NOT scope-gated. The aggregator pattern requires read access; write is the privilege boundary.

**Superdriver write-audit log:**

Every cross-team write from the superdriver appends one line to `~/.claude/teams/registry.json:.superdriver.writeAuditLog` (or a sibling file `~/.claude/teams/superdriver-writes.jsonl` for size discipline):

```jsonl
{"ts":"2026-04-27T09:55:00+08:00","verb":"tell-lead","targetTeam":"myteam-alpha","caller":"superdriver:__superdriver__home","msgFirstLine":"[driver 09:25 MYT] REROUTE commit+push triage..."}
```

Rationale: the superdriver tier IS the trust escalation; auditing it preserves the "who-told-whom-what" trail when cross-team writes happen.

**Workflow implication for today's driver:**

Until enforcement helpers ship: drivers MAY continue cross-team writes via `atmux --team-dir <other>` BUT SHOULD self-flag the violation in driver-inbox of the target team ("driver of <own> acting cross-team; should have routed via superdriver"). Once `atmux::guard_scope` lands, cross-team writes from team-drivers hard-fail; user must attach to the superdriver pane.

Superdriver workflow: `atmux super-attach` (E10/Sd verb) drops user into `superdriver:__superdriver__home`. From there: `atmux super-tell <team> <member> <msg>` (E10/Sf) or direct `atmux --team-dir <any> <write-verb>` — both succeed because caller scope = superdriver.

## Consequences

- **Architectural invariant becomes load-bearing.** A team driver that drifts into "managing two teams from one pane" hits a hard refuse-gate; either attach to superdriver or stay scoped.
- **Multi-team incidents (concurrent fleet-wide directives) require superdriver-pane attach.** Adds one workflow step (`atmux super-attach`) for the human, but enforces the audit + identity discipline.
- **Read-side aggregation is unaffected.** Driver of atmux-team can `atmux --team-dir /myteam-alpha super-status` or `atmux --team-dir /myteam-alpha task list` to peek; just can't write.
- **Members are intentionally allowed only `reply`** — narrow channel back to lead/driver. They cannot `send` or `dispatch` to peers (existing convention; this ADR codifies it).
- **`unknown` caller** (running atmux from outside any registered tmux pane — e.g., a cron job, a script) is refuse-by-default for writes. Cron-friendly verbs (`atmux whip`, `atmux report`) are read-mostly with narrow controlled writes (whip writes to its own ledger, not cross-team kanban). They run under a special caller-scope `cron` set via env var `ATMUX_CALLER_SCOPE=cron` — explicit declaration, not implicit elevation.
- **First-spawn / no-registry-yet edge case**: until `~/.claude/teams/registry.json` exists (E10/Sa lands), `atmux::resolve_caller_scope` falls back to "any-can-write" with a deprecation warning to stderr. Once registry exists, the gate is hard.
- **Superdriver is now load-bearing for fleet ops.** ADR-025's Phase 1 (read-only aggregator) is already in scope; this ADR makes the superdriver the *only* path for fleet-wide writes. That makes E10/Sd (super-attach) + Sf (super-tell) priority work.
- **Audit log discipline**: superdriver writes go to a JSONL ledger. Driver SHOULD periodically review `tail superdriver-writes.jsonl` to keep visibility on what cross-team actions have flowed.

## References

- [ADR-025](./025-superdriver-phase-1.md) — superdriver concept (Phase 1 read-only)
- [ADR-026](./026-always-single-session-topology.md) — single-session topology + superdriver own-session exception
- [ADR-027](./027-team-rename-verb-and-topology-invariant.md) — registry.json as identity source
- [ADR-028](./028-main-master-pr-only-no-agent-push.md) — sibling refuse-gate precedent
- Driver feedback 2026-04-27 09:55 MYT — scope tier framing
- `lib/stop.sh:39` — refuse-gate implementation precedent
