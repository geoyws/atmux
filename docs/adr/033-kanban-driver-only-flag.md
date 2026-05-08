# ADR-033: `driverOnly: bool` flag on kanban Tasks — load-bearing gate for driver-fires Tasks

**Status**: accepted (George 14:13 MYT 2026-05-08 — paperwork catch-up; implemented in `src/schema/kanban.ts:83` + `src/core/repositories/kanban-repo.ts:111,135,165`)
**Date**: 2026-04-27
**Driver-ref**: t-efaf4096 (lead-relayed) at 14:14 MYT after reviewer-2 caught t-3b8a2f55 (E9 migrate-to-driver-session bookkeeping marker) auto-claimed via `claim --next` despite body AC saying "Driver-only fire (NOT auto-claimable)".

## Context

A growing class of Tasks must only be fired by the driver, never by an auto-claiming worker:

- E10/Sh registry-backfill (t-dfe8f0df) — global filesystem mutation across teams.
- E9 migrate-to-driver-session marker (t-3b8a2f55) — bookkeeping ack the driver completed a topology migration.
- Per-Epic OPS promote Tasks (t-72df5c45 / t-b7ac1bc5 / t-66b870d0 / t-fcd68186 / t-ef999a93 / t-14fba59e) — `rsync /opt/atmux-stable/` operations.
- E13/Sh (t-930a74a9) — same OPS shape for socket-pubsub promote.

The previous gate was *body AC text* — Tasks read "Driver-only fire (NOT auto-claimable)" in the description. Reviewer-2 surfaced 14:14 MYT that this is not load-bearing: `claim --next` reads `lane`, `deps[]`, and `paused` state, but does *not* parse Task body text. A worker correctly auto-claimed t-3b8a2f55. Reviewer-2 caught it manually; next time may not.

The risk is real:

- A non-driver claims a driver-fires Task, marks it `done`, and the kanban records it as complete — unblocking deps[]-gated downstream Tasks prematurely (specifically Sc+Sd workers in E9 in this incident).
- For OPS promote Tasks, the worker-claimed `done` doesn't actually rsync `/opt/atmux-stable/`; the system is left in a state where the schema thinks the promote happened but the filesystem is unchanged.

## Decision

**Add a `driverOnly: bool` field to the kanban Task schema. `claim --next` and `task move` refuse driver-only Tasks unless the caller's scope is `driver`.**

### Schema

```jsonc
{
  "id": "t-…",
  // … existing fields …
  "driverOnly": false  // default; explicitly true on driver-fires Tasks
}
```

### CLI surface

- `atmux task add … --driver-only` flag sets `driverOnly: true` at create time.
- Existing Tasks default to `false` (jq `// false` coalesce in claim/move read paths so missing-field is treated as not-driver-only).

### Caller scope detection

- **Interim** (until E10/Si `atmux::resolve_caller_scope` lands per ADR-029): env gate `ATMUX_CALLER_SCOPE=driver`. The driver pane exports this in its tmux env; member panes don't. Members that try to set it themselves fail the refuse-gate's secondary check (caller's tmux window-name doesn't match `driver` per ADR-029 conventions).
- **Post-E10/Si**: replace the env gate with `atmux::resolve_caller_scope` per ADR-029. The interim env gate becomes a fallback when the helper isn't available.

### Refuse-gate sites

1. **`lib/claim.sh::cmd_claim --next` selection loop**: skip Tasks where `driverOnly=true` if caller is not driver scope. The Task remains in `todo` status (not consumed).
2. **`lib/kanban.sh::task move <id> in-progress|done`**: refuse with `atmux::die` if `driverOnly=true` and caller is not driver scope. (`todo` and `blocked` transitions remain allowed — useful for bookkeeping.)
3. **`lib/claim.sh::cmd_claim <id>` (explicit-id form)**: same refuse as `task move in-progress` — explicit claim is just `task move in-progress` with implicit assignee.

### Backfill

One-shot Task that jq-edits 9 known Tasks to add `driverOnly: true`:
- t-dfe8f0df (E10/Sh registry-backfill)
- t-3b8a2f55 (E9 migrate marker)
- t-72df5c45 (E6 promote)
- t-b7ac1bc5 (E7 promote, currently blocked)
- t-66b870d0 (E8 Epic-end deploy)
- t-fcd68186 (E9 Epic-end deploy)
- t-ef999a93 (E10 Epic-end deploy)
- t-14fba59e (E11 Epic-end deploy)
- t-930a74a9 (E13/Sh socket-pubsub promote — newly minted)

Backfill itself is driver-fires (touches kanban schema for 9 Tasks atomically).

### `assignee='driver'` convention

The existing visual hint stays. It's not load-bearing — `driverOnly` is the gate — but assignee='driver' is still a useful at-a-glance indicator in `atmux task list`. New driver-fires Tasks SHOULD set both: `--driver-only` flag + `--assignee driver` (when the convention is supported by `task add`).

## Consequences

**For BE lane:** `lib/claim.sh` selection loop gains a `driverOnly` filter; `lib/kanban.sh::task move` gains a refuse-gate; `lib/kanban.sh::task add` gains `--driver-only` flag. Helper `atmux::is_driver_only_blocked <task-id> <caller-scope>` centralizes the logic, callable from both sites.

**For TEST lane:** New `tests/unit/driver_only.bats`. Coverage: `claim --next` skips driverOnly Tasks for non-driver caller; `claim --next` returns driverOnly Tasks for driver caller (ATMUX_CALLER_SCOPE=driver); `task move in-progress` refused for non-driver; `task move done` refused for non-driver; `task move todo|blocked` allowed for any caller; explicit `claim <id>` refused for non-driver.

**For OPS lane:** Backfill one-shot Task adds the field to 9 existing Tasks. Driver-fires (because the backfill itself touches kanban; ironic recursion is avoided by running the backfill *before* the refuse-gate code lands — sequence-wise, schema field comes first, then refuse-gate, with the backfill in between).

**What we give up:** A small amount of schema surface (one bool field per Task) and a 5-line filter in two read paths. Negligible.

**What we gain:** Hard refuse-gate replaces body-text honor system. A worker physically cannot mark a driverOnly Task done. The 8 listed Tasks (and any future driver-fires) are protected from accidental progression.

**Rollback path:** `driverOnly` defaults to `false` everywhere. Removing the refuse-gate restores prior behavior; the field becomes vestigial. Backfilled Tasks revert to body-text-only convention.

## Open questions

Resolved at decompose via `atmux decisions add`.

1. **Caller scope detection — env gate now or wait for E10/Si `resolve_caller_scope`?** Default: env gate now (`ATMUX_CALLER_SCOPE=driver`); swap to `atmux::resolve_caller_scope` when E10/Si lands. Why: bug surface is live (8 driver-fires Tasks unprotected); waiting on Si calendar-couples this fix.
2. **Backfill mechanism — auto-script Task vs driver-fires?** Default: driver-fires backfill Task (the script edits 9 Task IDs in kanban.json atomically; running it as auto-claim risks a non-driver worker doing a multi-Task schema migration). Why: schema migrations have always been driver-fires here.
3. **`assignee='driver'` convention — keep or replace?** Default: keep as visual hint; `driverOnly` is the load-bearing gate. Why: defense-in-depth — if env gate fails open somehow, the assignee field is a second visible signal at `atmux task list` time.
4. **Standalone Epic vs fold into E10/Si?** Default: standalone (E14). Why: bug fix needs to ship within hours; E10/Si is a 12-verb wire-in + JSONL audit, multiple weeks of work. Folding couples a P1 bug fix to a P3 Epic.
