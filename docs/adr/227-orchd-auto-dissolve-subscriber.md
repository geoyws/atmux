# ADR-227: orchd auto-dissolve subscriber (Phase 4) — `epic.merged` → `atmux team dissolve-epic` → `epic.dissolved`

**Status**: accepted
**Date**: 2026-05-23
**Driver-ref**: parent atmux kanban Epic `e-a946af69` ("orchd lifecycle Phase 3-5") + driver-inbox 08:27 MYT 2026-05-23 (lead relay)

> ⚠ **SUPERSEDED 2026-08-27 by [ADR-276](276-orchd-retirement-and-atmux-scope.md)** (dispatch already stubbed by [ADR-280](280-epic-team-retirement-and-staged-excision.md) stage 3). The auto-dissolve subscriber is deleted — auto-dissolve of teams and cage reaping are retired with orchd. Kept as history; do not implement from it.
**Parent EPIC (this team)**: `e-a946af69` (orchd Phase 3-5)
**Hard gates**: [ADR-226](226-orchd-auto-merge-subscriber.md) (Phase 3 emits `epic.merged`) + [ADR-090](090-epic-team-lifecycle.md) (`dissolve-epic` verb + ADR-090 §pre-flight gates).
**Closes**: [ADR-221](221-solo-worker-scope.md) §v2 auto-dissolve (worker fold-in).
**Sibling cross-refs**: [ADR-202](202-honker-in-db-messaging-substrate.md) (substrate), [ADR-203](203-event-topic-taxonomy.md) (topic taxonomy), [ADR-090](090-epic-team-lifecycle.md) §Decision-anchor #7 (`atmux stop` parent-with-children semantics — informs operator-override carve-out).

## Context

ADR-090 ships `atmux team dissolve-epic <eid>` as the imperative verb that gracefully reclaims an epic-team's cage, worktree, branch refs, and cockpit registration. Today the verb is invoked **only manually** — operator runs it after observing the epic-team's branch landed on the parent base.

The manual step is the canonical orphan-cage source: memory `project_2026_05_19_wedge_audit_session` flagged 7+ orphan cron blocks across atmux/sopx/unum from dissolve-epic forgotten or partially executed (memory `project_epic_team_dissolve_cron_leak`). The fix path was a sweep-epics 6h cron + complaint flow (`e-db13ac01` [P1]) — but that's a janitor, not a primary trigger.

Phase 4 makes dissolution the **canonical default** for any successfully-merged epic-team: orchd subscribes to `epic.merged` (Phase 3 emit), invokes `dissolve-epic` directly, and the operator never has to remember.

This also closes **[ADR-221](221-solo-worker-scope.md) §v2 auto-dissolve** completely. Workers are structurally epic-teams (`w-<task-id>` prefix). Their lifecycle is:

1. Operator spawns worker: `atmux team spawn-epic w-<task-id> --roster solo`.
2. Solo member claims the only Task, ships it, `task move done`.
3. ADR-226 fires: `task.done` → orchd-merge → epic-merge → `epic.merged`.
4. **This ADR** fires: `epic.merged` → orchd-dissolve → dissolve-epic → `epic.dissolved`.

Worker spawn → ship → reap is one operator action. No manual cleanup. Closes ADR-221 §66 ("orphan worker cages will accumulate until v2 auto-dissolve lands").

## Decision

### §D1 — Trigger contract

Orchd subscribes to topic `epic.merged` (new in ADR-226 §D2). Per `epic.merged` event (**superseded** — see §Amendment 2026-05-23 Phase 4 trigger flip below; current default topic is `epic.pushed` per ADR-229 §DA3 ordering constraint):

1. Resolve `epicId` from event payload.
2. Pre-flight check: existing ADR-090 §dissolve-epic gates (all child Tasks `done`, worktree clean, no in-flight sessions). Post-Phase-3 these are already true; the check is defense-in-depth.
   - If gate fails → outcome `escalated`; emit `epic.dissolve-blocked` (operator-observable); continue draining.
3. Check operator carve-outs (see §D3):
   - If epic has `--no-auto-dissolve` flag set at spawn time (persisted to `team.json::epicTeam.autoDissolve === false`) → outcome `skipped-operator-opt-out`. Log to audit trail. Continue draining.
4. Invoke the dissolve dispatcher. Default-stub returns `skipped-not-mine`; the production wiring (T5 / module impl Task) injects `performDissolveEpic` from a new module-level handler factored out of `src/verbs/team-dissolve-epic.ts`.
5. On dispatcher outcome:
   - `dissolved` → emit `epic.dissolved` (already in ADR-203 §D2 v1 topic set); outcome `dissolved`.
   - `gate-held` / throw → idempotency layer catches; offset stays; retry next sweep.

### §D2 — Topic taxonomy

- **Trigger** `epic.merged` — added by ADR-226 §D2; reused here.
- **Success** `epic.dissolved` — already in [ADR-203](203-event-topic-taxonomy.md) §D2 v1 topic set. Payload schema landed by ADR-203's initial decomp; this ADR confirms the consumer wires onto the existing topic without taxonomy amendment.
- **Operator-observability** `epic.dissolve-blocked` — NEW topic added to ADR-203 §D2 in same commit as T5. Payload: `{topic, epicId, reason, blockedAtSec}`. No v1 consumer; surfaces in cockpit-mirror Discord feed per ADR-219. Field-name convention `blockedAtSec` aligns with ADR-203 + ADR-226 §D2 (`mergedAtSec` / `blockedAtSec`); be-1's worktree-pending `EpicDissolveBlockedPayload` in `src/schema/events.ts` already uses `blockedAtSec`.

### §D3 — Carve-outs (operator override surface)

Two carve-outs at v1, both stored in `team.json::epicTeam`:

1. **`autoDissolve: false`** — operator wants the epic-team's worktree to persist post-merge for inspection. Examples: "I need to grep the cage's `.atmux/logs/` after the EPIC ships" or "I'm doing post-mortem on a failed deploy from this branch." Default: `true` (auto-dissolve on every successful merge).

   Schema addition in `src/schema/team.ts::TeamEpic`:
   ```ts
   autoDissolve: z.boolean().default(true).describe(
     "ADR-227: when true (default), orchd auto-dissolves the epic-team " +
     "on epic.merged. Operator sets false at spawn time to keep the " +
     "cage alive for post-merge inspection; manual `atmux team " +
     "dissolve-epic <eid>` still works as the cleanup path."
   ),
   ```

   Spawn-time CLI flag: `atmux team spawn-epic <eid> --no-auto-dissolve` writes `autoDissolve: false` to the cage's team.json at provision time.

2. **Pre-flight refusal carve-out** — if ADR-090 dissolve-epic gates refuse (any task non-done, dirty worktree), we DO NOT silent-skip. Emit `epic.dissolve-blocked` + structured audit-log entry. Operator sees in cockpit-mirror feed; can investigate manually.

### §D4 — Audit trail

Per ADR-090 audit pattern, every dissolve attempt (success OR blocked) appends to `.atmux/logs/orchd-dissolve.log`. One JSONL row per attempt:

```jsonl
{"at":"2026-05-23T14:02:11Z","epicId":"e-abc12345","outcome":"dissolved","mergedSha":"abc123...","dissolvedSha":"def456...","reason":null}
{"at":"2026-05-23T14:05:22Z","epicId":"e-def67890","outcome":"blocked","reason":"worktree dirty: 3 uncommitted files in apps/web","mergedSha":null,"dissolvedSha":null}
{"at":"2026-05-23T14:08:33Z","epicId":"e-ghi13579","outcome":"opt-out","reason":"team.json::epicTeam.autoDissolve=false","mergedSha":"...","dissolvedSha":null}
```

Audit log is append-only; rotation is a follow-up (not v1 scope — JSONL grows slowly + log volume is ~1 line per epic merge per day).

### §D5 — Solo-worker fold-in (closes ADR-221 §v2)

Workers (`w-<task-id>` epic-id prefix per ADR-221 §v1) are **structurally identical** to regular epic-teams from orchd's perspective:

- They have a `team.json::epicTeam` block (ADR-221 §32 — "convention layered on top, not a new schema").
- They emit `task.done` (from the solo member's single Task) → ADR-226 fires → `epic.merged` → THIS ADR fires → `epic.dissolved`.

No special-casing. The `w-` prefix is purely a cockpit-display convention; the lifecycle subscriber treats them as epics.

ADR-221 §38 ("v2 surface — follow-up Task") is **closed in full** by this ADR. The §66 caveat ("orphan worker cages will accumulate until v2 auto-dissolve lands") is resolved at the moment T5 lands.

### §D6 — Subscription seam (cross-team contract with `e-60e16169`)

Mirror of ADR-226 §D5. Exported by `src/core/orchd-dissolve.ts`:

```ts
export type AutoDissolveOutcome =
  | "dissolved"
  | "escalated"
  | "skipped-operator-opt-out"
  | "skipped-not-mine"
  | "skipped-honker-off";

export interface OrchdDissolveConsumeDeps {
  db: Database;
  consumerName?: string;        // default "atmux:orchd-dissolve"
  topics?: ReadonlyArray<string>; // default ["epic.pushed"] (per §Amendment 2026-05-23; was ["epic.merged"] pre-amendment)
  handler?: (event: EpicPushedPayload) => Promise<AutoDissolveOutcome>; // post-amendment payload type
  nowSec?: () => number;
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
}

export async function orchdDissolveConsume(
  deps: OrchdDissolveConsumeDeps,
): Promise<{ processed: number; escalated: number }>;
```

Plus factory `createAutoDissolveHandler({db, performDissolveEpic, auditLogPath})` that bundles production wiring. Sibling EPIC `e-60e16169` imports both + invokes per tick.

## Consequences

- **Zero-touch EPIC lifecycle** on the happy path: operator files an epic with `autoSpawn + autoMerge + autoDissolve` (all default `true`), kanban runs to completion, orchd reaps. Worker case = `spawn-epic w- → ship → gone`.
- **ADR-221 §v2 closed** — solo-worker auto-dissolve no longer a "v2 follow-up"; this ADR is the closer.
- **Operator opt-out** preserved via `--no-auto-dissolve` for inspection / post-mortem scenarios.
- **Audit trail** (`orchd-dissolve.log`) gives operator full visibility into auto-actions; post-mortems remain debuggable.
- **No new cron** — Phase 4 is event-only. There's no existing `dissolve-epic tick` cron to decommission (per task body Cleanup section).
- **Reaper class** (`e-db13ac01` sweep-epics 6h) stays relevant for the long tail: epics that never emit `epic.merged` (e.g. cancelled mid-flight), epics with operator opt-out that were forgotten. Orchd handles the green path; reaper handles the red.
- **Rollback** — `ATMUX_HONKER=off` disables substrate; falls back to operator-manual `dissolve-epic` (today's behavior). Same kill-switch as Phase 3.

## Open questions

1. **Is `epic.merged → epic.dissolved` sequencing strict?** If the dissolve dispatcher races with a still-in-flight write to `.atmux/state.db` (e.g. final commit/push hooks), we could lose data. **Default**: pre-flight gate explicitly checks "no in-flight sessions" via `tmux list-sessions` + state.db lock — same check ADR-090 §dissolve-epic does today. Reversibility: low (the check is already there). **Decided-by**: planner; T5 verifies pre-flight call site matches.
2. **Worker audit-log scoping** — should worker dissolves (`w-` prefix) write to the same `orchd-dissolve.log` or a separate `orchd-worker-dissolve.log`? **Default**: same log; tag with `epicId` prefix on read. Single log = single rotation strategy. Reversibility: medium (splitting later is a sed + filter). **Decided-by**: planner.
3. **`--no-auto-dissolve` decay** — should the opt-out auto-expire after N days so forgotten inspections still get cleaned up? **Default**: no — let the reaper class (`e-db13ac01`) handle the long tail per its 6h cadence. Two layers of cleanup is cleaner than one layer with self-expiring opt-outs. Reversibility: low. **Decided-by**: planner; surface to lead for sentinel-cadence alignment.

## Decision-anchors

> **§DA1** — Trigger is `epic.merged` (ADR-226 emit); success is `epic.dissolved` (existing topic); blocked is `epic.dissolve-blocked` (NEW topic, ADR-203 amendment in T5 commit).
>
> **§DA2** — `autoDissolve: true` is the **default**. Operator override via `--no-auto-dissolve` flag at spawn time → `team.json::epicTeam.autoDissolve = false` persists for the cage's lifetime.
>
> **§DA3** — ADR-221 §v2 auto-dissolve is **closed in full** by this ADR. Workers (`w-` prefix) get the same subscriber handler — no special-casing. Worker lifecycle becomes spawn → ship → gone with zero operator follow-up.
>
> **§DA4** — Audit trail `.atmux/logs/orchd-dissolve.log` (JSONL append-only) per ADR-090 pattern. Single log for epics + workers; rotation deferred to follow-up.
>
> **§DA5** — Cross-team seam: `src/core/orchd-dissolve.ts` ownership = this EPIC. Sibling EPIC `e-60e16169` integrates via `orchdDissolveConsume` + `createAutoDissolveHandler` factory.

## §Amendment 2026-05-23 — Phase 4 trigger flip (per ADR-229 §DA3 ordering constraint + NIT-1)

[ADR-229](229-orchd-auto-push-and-safety-gates.md) adds Phase 6 (auto-push) as a peer subscriber on `epic.merged`. Ordering constraint: Phase 4 (dissolve) MUST NOT fire before Phase 6 (push) — once the cage is dissolved, the worktree is gone + the local-branch state needed to push is lost.

### §D1 trigger amendment

```
Phase 4 default topics:
  BEFORE: ["epic.merged"]
  AFTER:  ["epic.pushed"]   (per ADR-229 §DA3)
```

`orchdDissolveConsume`'s `topics` default flips from `["epic.merged"]` to `["epic.pushed"]`. Module impl (T_dissolve_module t-98707306) ships with the new default; if T_dissolve_module already landed pre-amendment, file follow-up Task to flip its default (already noted as conditional sub-task in T_adr227_amend body t-7-29631cdc).

### §D1.1 — Phase 4 does NOT fire on push-terminal-failure events (per committer NIT-1)

Phase 4 subscribes ONLY to `epic.pushed`. It does NOT subscribe to:

- **`epic.push-blocked`** — push refused by any Gate-{1..7}. Cage persists; operator inspects via `.atmux/logs/orchd-push.jsonl` + resolves the gate (e.g. flip `autoPush.enabled=true`, drop the kill switch, wait out cooldown, fix tsc errors). Once resolved, NEXT `task.done` re-fires Phase 3 → 6 → 4 chain.
- **`epic.push-conflict`** — Gate-1 upstream-advanced refusal. Cage persists; operator inspects via Discord `[push-conflict]` template (ADR-219) + rebases/pulls/resolves manually. Once `git push` lands manually (or via follow-up auto-push on next epic.merged), the chain re-resumes.

Rationale: dissolution removes the operator's only forensic surface for diagnosing push failures. If Phase 4 fired on push-blocked/conflict, the operator would lose:
- The local merge commit + history (worktree gone)
- The `.atmux/logs/orchd-push.jsonl` audit row pointer (cage state.db gone)
- The branch ref needed to `git push` manually after resolution

Cage-persists-on-push-failure is the canonical recovery surface. Operator-driven `atmux team dissolve-epic <eid>` remains the manual path when the operator wants to abandon a stuck push (e.g. epic landed on the wrong base; resolve out-of-band).

**Side note on solo-workers (ADR-221 §v1, `w-` prefix)**: same logic applies — a worker whose push gets blocked stays alive until the operator resolves. The `w-` lifecycle convention (spawn → ship → gone) holds for the GREEN path only; red-path push failures fall back to manual dissolve. This is the same risk surface a non-worker epic-team has; no special-casing needed.

### §Cross-cite

ADR-229 §DA3 + §D1 amendment block + committer reviewer-pass NIT-1 at lead-outbox 11:17 MYT 2026-05-23.

## §Amendment 2026-05-23 — Reviewer-pass (t-e24e9351)

Status flipped `proposed → accepted`. Three impl-doc parity patches landed in the same commit as the status flip:

1. §D2 `epic.dissolve-blocked` payload field `blockedAt` → `blockedAtSec` to match the `*Sec` suffix convention enforced across ADR-203 + ADR-226 §D2. be-1's worktree-pending `EpicDissolveBlockedPayload` in `src/schema/events.ts:155-172` (uncommitted as of this writing) already uses `blockedAtSec`; this ADR catches up.
2. §D1 trigger line — added inline supersession marker pointing forward to §Amendment 2026-05-23 Phase 4 trigger flip block. Pre-existing §D1 text reads "Per `epic.merged` event" but the Amendment at the file's tail flips the default to `epic.pushed` per ADR-229 §DA3 ordering constraint (Phase 6 push must precede Phase 4 dissolve so the worktree+local-branch state survive long enough to push). Without the inline marker, mid-document readers would miss the Amendment.
3. §D6 `OrchdDissolveConsumeDeps` surface — `topics` default flipped to `["epic.pushed"]` + `handler` payload type flipped to `EpicPushedPayload` (post-amendment shape). Pre-amendment ts-block had `["epic.merged"]` + `EpicMergedPayload`, which would type-check at compile time but produce dead code at runtime (handler would never fire because the default subscription wouldn't match Phase 6 emits).

Audit summary:
- Seam shape mirrors gitter-consumer.ts + ADR-226 §D5 (withIdempotency + Honker kill-switch + stubbed-default-with-injected-resolver). ✅
- `--no-auto-dissolve` schema addition opt-in default-true (§D3 line 58 `z.boolean().default(true)`); be-1 already shipped impl at commit `cfb791b` (`feat(schema/team): TeamEpic.autoDissolve + spawn-epic --no-auto-dissolve flag (ADR-227 §D3)`). ✅
- ADR-221 §v2 closure assertion explicit (§D5 line 91 + §DA3); workers (`w-` prefix) fold-in correct (§D5 lines 84-89). ✅
- Audit log JSONL format (§D4) — three-row example with `at`, `epicId`, `outcome`, `mergedSha`, `dissolvedSha`, `reason` fields; rotation deferred (acceptable v1 carve-out). ✅
- Trigger ordering: `epic.pushed` (Phase 6) → Phase 4 (this ADR) ensures cage-persists-on-push-failure operator-recovery surface preserved (§D1.1). ✅

Pending T5 impl (`src/core/orchd-dissolve.ts`) will land in a downstream Task; this reviewer-pass scope is doc-only.
