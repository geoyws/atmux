# E14 driverOnly:bool refuse-gate — review signoff

- **Task**: t-8312e5e0 — `[E14] REVIEW: signoff driverOnly:bool refuse-gate`
- **Reviewer**: reviewer-2
- **Date**: 2026-05-02 19:43 MYT
- **ADRs**: ADR-033 (driverOnly schema + gate), ADR-029 (audit bar)
- **Verdict**: ⚠️ **APPROVED-WITH-FIXES** — schema, helper, primary refuse-gate sites, and backfill are correct and well-tested; two adjacent state-mutating verbs (`atmux done`, `atmux dispatch`) bypass the gate and need follow-up Tasks before the protection is complete.

## 1. Independent grep

Ran `grep -rn 'driverOnly\|driver_only\|driver-only\|DRIVER_ONLY\|CALLER_SCOPE\|caller_scope\|is_driver_only_blocked' lib/ scripts/ tests/ bin/` — 90 hits across the implementation surface. Touched files:

- `lib/kanban.sh` — schema field on `task add`, refuse-gate on `task move in-progress|done`
- `lib/claim.sh` — refuse-gate on explicit `atmux claim <id>`, scope-aware filter on `claim --next` (lane-pinned + cross-lane fallback both filter)
- `lib/common.sh` — `atmux::resolve_caller_scope`, `atmux::is_driver_only_blocked` helpers
- `scripts/backfill-driver-only.sh` — one-shot E14T3 backfill
- `tests/unit/driver_only.bats` — 14 unit tests
- `docs/adr/033-kanban-driver-only-flag.md` — ADR

## 2. Coverage table — every state-mutating verb vs. the gate

For every entry-point that mutates a Task's `.status`, does it consult `atmux::is_driver_only_blocked` or the inline scope filter?

| Site | File:line | Status transition | Gate? | Verdict |
|---|---|---|---|---|
| `claim --next` lane-pinned select | `lib/claim.sh:252` | todo → in-progress (atomic) | ✅ inline `(.driverOnly // false) == false or $scope == "driver"` filter | OK |
| `claim --next` cross-lane fallback select | `lib/claim.sh:281` | todo → in-progress (atomic) | ✅ same inline filter | OK |
| `atmux claim <id>` (explicit) | `lib/claim.sh:72` | todo → in-progress | ✅ `is_driver_only_blocked` call | OK |
| `atmux task move <id> in-progress` | `lib/kanban.sh:255` | * → in-progress | ✅ `is_driver_only_blocked` call | OK |
| `atmux task move <id> done` | `lib/kanban.sh:255` | * → done | ✅ `is_driver_only_blocked` call (gate fires before `finish_task_done`) | OK |
| `atmux task move <id> todo` | `lib/kanban.sh:253-258` | * → todo | ✅ allowed by design (bookkeeping carve-out per ADR-033 §Refuse-gate sites) | OK |
| `atmux task move <id> blocked` | `lib/kanban.sh:253-258` | * → blocked | ✅ allowed by design (bookkeeping) | OK |
| **`atmux done <id>` (a.k.a. `claim --done`)** | **`lib/claim.sh:110-128`** | * → done (via `finish_task_done`) | ❌ **NO GATE** | ❌ **GAP-1** |
| **`atmux dispatch <member> <id>`** | **`lib/dispatch.sh:62-66`** | * → in-progress, owner=member | ❌ **NO GATE** | ❌ **GAP-2** |
| `lib/flags.sh` flag-add `--task` with `--needs unblock` | `lib/flags.sh:253-256` | * → blocked | n/a — `blocked` is a bookkeeping carve-out; allowed for any caller | OK |
| `lib/groom.sh` archival rewrite | `lib/groom.sh:418-` | done|cancelled → REMOVED | n/a — only operates on already-done tasks (post-gate) | OK |
| `lib/story.sh::story advance` | `lib/story.sh:312-328` | mutates **Story**.status only; mints fresh non-driverOnly review/merge Tasks | n/a — does not transition existing Task .status | OK |
| `lib/epic.sh::epic advance` | `lib/epic.sh:262-274` | mutates **Epic**.status only; mints fresh non-driverOnly summary Task | n/a | OK |
| `lib/kanban.sh::finish_task_done` (auto-mint commit/summary) | `lib/kanban.sh:441-484` | minted children always carry `driverOnly` absent → `// false` | n/a — minted children inherit nothing from parent driverOnly bit | OK |

**Coverage ratio (primary spec):** 6/6 named refuse-gate sites in ADR-033 §Refuse-gate sites are wired (claim --next select, explicit claim, task move in-progress, task move done, task move todo allowed, task move blocked allowed).

**Coverage ratio (full state-mutation surface):** 6/8 entry points that flip Task `.status` to a forward-progress state are gated. Two unguarded sites (GAP-1, GAP-2) — see §5.

## 3. Caller-scope detection — env gate + window-name defense-in-depth

`atmux::resolve_caller_scope` (`lib/common.sh:293-317`) implements the two layers ADR-033 §Caller scope detection requires:

1. **Window-name short-circuit (defense-in-depth)** — if `$TMUX` is set and `tmux display-message -p '#{window_name}'` matches `^__[a-z0-9_-]+__` (the spawn convention from ADR-030), force scope=`member` regardless of any env. A member who runs `export ATMUX_CALLER_SCOPE=driver` in their REPL hits this gate first and stays member-scoped.
2. **Env read** — tmux session env (`tmux show-environment ATMUX_CALLER_SCOPE`) takes precedence over process env, then process env. Only the literal string `driver` returns `driver`; anything else (unset, empty, `member`, garbage) → `member` (fail-secure default).

`tests/unit/driver_only.bats:188-216` exercises the window-name override: with `$TMUX` set + a stubbed `tmux` returning `__driveronly__fe-kanban` for `display-message`, AND `ATMUX_CALLER_SCOPE=driver` exported, the helper still returns `member`. ✅ assertion holds.

`tests/unit/driver_only.bats:218-236` covers the inverse: window name `driver` (the driver pane's own name) does NOT short-circuit; the env path resolves and returns `driver`. ✅

`tests/unit/driver_only.bats:247-254` covers fail-secure default: no TMUX, no env → `member`. ✅

The ADR-029 follow-up (centralizing scope resolution per ADR-029 once E10/Si lands) is a known interim — flagged in the source comment at `lib/common.sh:290-292`. Not a blocker per task body.

## 4. Backfill verification

`scripts/backfill-driver-only.sh` (E14T3 deliverable):

- Lists 9 target IDs (`scripts/backfill-driver-only.sh:46-56`):
  - t-dfe8f0df (E10/Sh registry-backfill)
  - t-3b8a2f55 (E9 migrate marker)
  - t-72df5c45 (E6 promote)
  - t-b7ac1bc5 (E7 promote)
  - t-66b870d0 (E8 Epic-end deploy)
  - t-fcd68186 (E9 Epic-end deploy)
  - t-ef999a93 (E10 Epic-end deploy)
  - t-14fba59e (E11 Epic-end deploy)
  - t-930a74a9 (E13/Sh socket-pubsub promote)
- Atomicity: single `atmux::jq_update` call wrapping all 9 mutations under one flock. ✅
- Pre-write snapshot via `atmux::kanban_json_backup`. ✅
- Idempotence: classification logic at `scripts/backfill-driver-only.sh:117-126` distinguishes `set` vs `no-op (already true)` vs `not in kanban`. Re-running on already-flipped data takes the `no-op` branch — kanban write still fires (`.driverOnly = true` → already `true`), but no semantic change. ✅
- Coverage in current kanban: live verification via `jq` confirms **9/9 target IDs carry `driverOnly: true`** in `.atmux/kanban.json`. (4 are `status=done` from before the gate landed; gate is post-hoc and does not retroactively block already-completed driver-fires Tasks. 5 are `status=todo`, awaiting the driver.)

## 5. Vulnerability widening — adjacent state-mutating verbs

Task body §5 raises three candidate adjacent classes. Empirical verification:

### GAP-1 (P1 — real exploit): `atmux done <id>` bypasses the gate

Task body says: *"atmux done (alias for task move done — covered if task move is)"*.

This assumption is **incorrect**. `atmux done` is rewritten by `bin/atmux` to `atmux claim --done <id>`, which dispatches into `lib/claim.sh:110-128`'s `done` branch:

```sh
done)
  ATMUX_FINISH_TASK_NO_DISPATCH="$no_dispatch" \
    atmux::finish_task_done "$id" "$note"
  _atmux_inbox_move "$who" "$task" "inProgress->done" "$now"
  atmux::ok "$who completed $id"
  ;;
```

There is no `is_driver_only_blocked` call. `atmux::finish_task_done` (`lib/kanban.sh:316-`) also does not consult the gate — its callers are expected to. `_atmux_task_move done` does (line 255), but `claim --done` does not.

**Empirical reproduction** (sandbox, fe-kanban member, ATMUX_CALLER_SCOPE unset):

```
$ atmux task add 'driver-only probe' --driver-only --lane fe
t-f5b26132   # status=todo, driverOnly=true, owner=null

$ atmux done t-f5b26132 --as fe-kanban
✅ atmux fe-kanban completed t-f5b26132
# status=done, driverOnly=true, owner=null, completedAt=...
```

A non-driver member directly completed a `todo` driverOnly Task — never claimed it, never had to. The Task is now in `done` state. **All three primary gates were bypassed by skipping `claim` and going straight to `done`.**

**Fix sketch**: gate the `done` branch in `lib/claim.sh:110` with the same `atmux::is_driver_only_blocked` check as the `claim` branch at line 72. Consider also lifting the gate into `atmux::finish_task_done` itself so any future caller inherits the protection (defense-in-depth — the helper is the chokepoint that shared by `task move done` and `claim --done`).

### GAP-2 (P2 — operational): `atmux dispatch` bypasses the gate

Task body says: *"atmux dispatch (writes inbox JSON, doesn't move task — out-of-scope unless dispatch implies in-progress?)"*.

The answer is **yes, dispatch implies in-progress**. `lib/dispatch.sh:62-66`:

```sh
atmux::jq_update "$k" \
  '(.tasks[] | select(.id == $id) | .owner) = $who
   | (.tasks[] | select(.id == $id) | .status) = "in-progress"
   | (.tasks[] | select(.id == $id) | .claimedAt) = $now' \
  ...
```

No `is_driver_only_blocked` consultation.

**Empirical reproduction** (sandbox, no driver scope set):

```
$ atmux task add 'driver-only probe 2' --driver-only --lane fe
t-51e97e79   # status=todo, driverOnly=true

$ atmux dispatch fe-kanban t-51e97e79 --no-ping
✅ atmux dispatched t-51e97e79 → fe-kanban
# status=in-progress, driverOnly=true, owner=fe-kanban
```

The driverOnly Task is now in-progress and assigned to a non-driver member. Per the gate's design intent (ADR-033 §Goal: "a worker physically cannot mark a driverOnly Task done"), this is a violation of the in-progress invariant: the Task has been touched by a non-driver path.

In practice the lead would not dispatch a driverOnly Task — these are explicitly driver-fires — so this is *operationally* low-risk. But the contract ADR-033 establishes is "non-driver scope cannot make forward-progress transitions on driverOnly Tasks". Dispatch can.

**Fix sketch**: add `if atmux::is_driver_only_blocked "$id"; then atmux::die "..."; fi` at `lib/dispatch.sh:46` (after the `task` lookup, before the dep-gate). Keep the same error message shape as the claim/move sites for consistency.

### Other adjacent classes (not gaps)

- `atmux pause`/`atmux resume` (`lib/pause.sh`) — touches `paused.json`, not kanban Tasks. ✅ out of scope.
- `lib/flags.sh` `--needs unblock` flips Task to `blocked` — `blocked` is the documented bookkeeping carve-out (ADR-033 §Refuse-gate sites). ✅ allowed.
- `story advance` / `epic advance` — mutate Story.status / Epic.status, mint fresh (non-driverOnly) child Tasks; do not transition existing Task .status. ✅ out of scope.
- `groom.sh` — only touches already-`done` or `cancelled` Tasks (post-gate). ✅ out of scope.

## 6. Test coverage audit — `tests/unit/driver_only.bats`

Ran `bats tests/unit/driver_only.bats` → **14/14 pass.**

Coverage matrix vs. ADR-033 requirements:

| Required behavior | Test | Verdict |
|---|---|---|
| `claim --next` non-driver skips driverOnly | tests 1, 2 | ✅ |
| `claim --next` driver selects driverOnly | test 3 | ✅ |
| `task move in-progress` non-driver refuses | test 4 | ✅ |
| `task move done` non-driver refuses | test 5 | ✅ |
| `task move todo` non-driver allowed (bookkeeping) | test 6 | ✅ |
| `task move blocked` non-driver allowed (bookkeeping) | test 7 | ✅ |
| explicit `atmux claim <id>` non-driver refuses | test 8 | ✅ |
| explicit `atmux claim <id>` driver succeeds | test 9 | ✅ |
| pre-ADR-033 task without field reads as not-driver-only | test 10 | ✅ |
| window-name `__<team>__*` overrides env | test 11 | ✅ |
| window-name `driver` does not override env | test 12 | ✅ |
| env-only path resolves driver | test 13 | ✅ |
| fail-secure default | test 14 | ✅ |
| **`atmux done <id>` non-driver refuses** | **MISSING** | ❌ **(GAP-1 not asserted by tests)** |
| **`atmux dispatch <m> <id>` non-driver refuses** | **MISSING** | ❌ **(GAP-2 not asserted)** |

Both gaps are silent in the test matrix because the test file's coverage statement (lines 4-15) doesn't enumerate `atmux done` or `atmux dispatch`. If those gaps had been considered when the test file was authored, the tests would have caught them.

## 7. Verdict

⚠️ **APPROVED-WITH-FIXES** within scope.

**Approved**: schema field on `task add`, helper `is_driver_only_blocked`, scope resolver with two-layer defense-in-depth, claim+move integration sites (lane-pinned select / cross-lane fallback / explicit claim / task move in-progress / task move done), backfill correctness (atomicity + idempotence + 9/9 IDs flipped), test coverage of the 14 cases the test file enumerates.

**Fixes required before this Story closes**:

1. **GAP-1 (P1)** — gate `lib/claim.sh:110` `done` branch with `atmux::is_driver_only_blocked`. Recommendation: also lift the check into `atmux::finish_task_done` (the chokepoint), so the protection covers both call paths and any future caller. Test: add a case mirroring tests 4-5 but invoking `atmux done <id>` instead of `atmux task move <id> done`.
2. **GAP-2 (P2)** — gate `lib/dispatch.sh:46` (after task-lookup). Test: add a case asserting `atmux dispatch <m> <driverOnly-id>` refuses for non-driver scope.

**Adjacent classes not covered by this Story** (deferred, not blockers):

- ADR-029 `atmux::resolve_caller_scope` consolidation — pending E10/Si landing per source comment at `lib/common.sh:290-292`. Reviewer flags as known-gap, not a blocker for E14.
- `lib/flags.sh:253-256` direct `.status = "blocked"` write bypasses `task move` — currently aligned with ADR-033's bookkeeping carve-out, but worth noting if future ADRs tighten the `blocked` transition.
