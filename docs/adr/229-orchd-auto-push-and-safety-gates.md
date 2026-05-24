# ADR-229: orchd auto-push subscriber (Phase 6) — `epic.merged` → `git push origin <base>` + 7 load-bearing safety gates

**Status**: accepted
**Date**: 2026-05-23
**Driver-ref**: parent atmux kanban Epic `e-a946af69` + driver-inbox amendment 2026-05-23 (lead relay) + parent atmux Task `t-5-cf7682b1` (amendment audit trail) + parent atmux Task `t-0db3f393` (master design).
**Parent EPIC (this team)**: `e-a946af69` (orchd Phase 3-5 + Phase 6 fold-in)
**Hard gates**: [ADR-226](226-orchd-auto-merge-subscriber.md) (Phase 3 emits `epic.merged`) + [`e-60e16169`](../../README.md) (orchd daemon substrate).
**Sibling cross-refs**: [ADR-202](202-honker-in-db-messaging-substrate.md) (substrate), [ADR-203](203-event-topic-taxonomy.md) (topic taxonomy), [global CLAUDE.md push policy](../../../../.claude-personal/CLAUDE.md) (staging-branch hard-refuse + George-manual constraint).
**Closes**: manual-push friction caused by classifier blocking driver pushes; lead-amendment 2026-05-23.

## Context

ADR-226 ships Phase 3 auto-merge: `task.done → orchd-merge → atmux epic-merge → epic.merged`. The merge lands LOCALLY on the parent base. The remote push to `origin/<parent-base>` is still a manual operator step.

Today's friction modes:

1. **Operator forgets** — local merge sits ahead of origin for hours/days; sibling epic-teams fork from a stale base.
2. **Driver-pane classifier blocking** — interactive `git push` from a driver pane occasionally trips the pane-state classifier (false-busy / refusal-residue), so even the "push from driver" workaround stalls.
3. **Cron-decommission opportunity** — the `auto-push.ts` cron in `src/core/auto-push.ts` (per ADR-194 auto-push just-done SHA) handles a DIFFERENT scope (per-member branch pushes on `task.done`). Phase 6 doesn't replace it; it extends auto-push semantics to the **parent base** post-merge.

Phase 6 closes the Phase 3 → push gap end-to-end: same daemon, same Honker subscriber pattern, triggered by `epic.merged` (ADR-226 emit).

### Why Phase 6 needs its own ADR (not folded into ADR-226)

ADR-226 governs the **local** merge contract. ADR-229 governs **remote mutation** with global CLAUDE.md push-policy intersection. The two have:

- Different rollback semantics — local merge can `git reset --hard`; remote push needs `git push --force` (which is itself gated as the #1 safety rule).
- Different operator-trust profile — local merges are routine; pushes to origin are visible to sibling epic-teams + CI + (in some projects) staging deploys.
- Different config surface — `team.json::autoPush` opt-in (separate from `team.json::epicTeam` which Phase 3-4 use).
- Different ADR-203 §D2 topic family (`epic.pushed`, `epic.push-blocked`, `epic.push-conflict`).

Folding Phase 6 as an §amendment on ADR-226 would couple two distinct mutation surfaces under one §Decision block. Operators reading "auto-merge ADR" would not find push-policy without grepping; reviewers auditing push-safety would have to inherit auto-merge context. Separate ADR is the lower-cost shape.

### Why Phase 6 needs its own Story (not folded into Phase 3 Story)

The handler **chains** at the daemon level — sibling EPIC `e-60e16169`'s `src/verbs/orchd.ts` calls `orchdMergeConsume` then (on success) `orchdPushConsume`. But the **modules** are independently shipped + independently testable + independently reviewable:

- `src/core/orchd-merge.ts` — Phase 3 (existing decomp)
- `src/core/orchd-push.ts` — Phase 6 (NEW)

The 7 safety gates need a separate AC surface for reviewer signoff. Bundling under one Story would force reviewer to acceptance-test 6 phases worth of surface in one pass; separate Story = separate reviewer-trunk-signoff gate = narrower diff per review.

## Decision

### §D1 — Trigger contract

Orchd subscribes to topic `epic.merged` (new in ADR-226 §D2; consumed by both Phase 4 ADR-227 AND Phase 6). Per `epic.merged` event:

1. Resolve `parentBase` from event payload (or look up `team.json::epicTeam.parentBase` if absent).
2. Run 7 safety gates IN ORDER (§D2). Any refusal → emit `epic.push-blocked` with structured reason; continue draining.
3. If all gates pass → invoke push dispatcher (`git push origin <parentBase>` via `src/core/orchd-push.ts`).
4. Per outcome:
   - success → emit `epic.pushed`; outcome `pushed`.
   - upstream-advanced → emit `epic.push-conflict`; outcome `escalated` (operator must inspect / rebase / pull-then-retry).
   - any throw → idempotency layer catches; offset stays; retry next sweep BUT gate #7 (cooldown) prevents tight-loop.

**Phase 4 + Phase 6 ordering on `epic.merged`**: both subscribe. Phase 4 (dissolve) MUST NOT fire before Phase 6 (push) — once the cage is dissolved, the worktree is gone + we lose the local-branch state needed to push. Solution: Phase 4 subscribes to `epic.pushed` instead of `epic.merged`. This ADR amends ADR-227 §D1 trigger from `epic.merged` to `epic.pushed`.

**ADR-227 §D1 amendment** (filed same-commit as T_push_module ships):

```
Phase 4 trigger:
  BEFORE: epic.merged
  AFTER:  epic.pushed  (per ADR-229 §D1 ordering constraint)
```

This means: Phase 3 → Phase 6 → Phase 4 is the canonical chain. Phase 4 still observes the same green-path lifecycle; it just waits one extra event-hop.

### §D2 — 7 load-bearing safety gates (must ship together)

**§DA-Gate-N numbers are semantic IDs (stable cross-ADR references)** — NOT fire order. Fire order is independent + chosen cheapest-first to fail fast without paying network/disk cost on the unhappy path.

**Fire order (cheapest-first, per §Amendment 2026-05-23 committer FLAG-3 fix + FLAG-A swap)**:

```
5 (env read)
  → 4 (team.json read)
    → 2 (string match via isPushAllowed)
      → 7 (in-memory cooldown lookup — Map.get, O(1))
        → 3a (working-tree stat via git status --porcelain subprocess)
          → 1 (network: git fetch + rev-list HEAD..origin/<base>)
            → 3b (subprocess: tsc / bun run typecheck — costliest, last)
              → push dispatcher
```

**Why 7 before 3a (FLAG-A swap, §Amendment 2026-05-23)**: Gate-7 is an in-memory Map lookup (microseconds); Gate-3a forks `git status --porcelain` as a subprocess (typically 50-500ms including process spawn + git index walk). A cooldown-hit shouldn't pay subprocess cost.

Gate-6 (audit log) is not a fire-order step — every gate's outcome appends a row regardless of position. All 7 ship in T_push_module's single commit; partial shipment is a §Decision-anchor violation.

> **§DA-Gate-1 — NEVER force-push (and NEVER bypass hooks)**. Refuse if `git fetch origin <base> && git rev-list HEAD..origin/<base>` shows upstream-advanced commits. Emit `epic.push-conflict` with `{ahead: N, behind: M, divergenceSha}`. Operator must inspect (manual rebase / pull). **MUST use the existing `git push` invocation pattern in `src/core/auto-push.ts`** — no `--force` / `--force-with-lease` / `--mirror` / `--all` / `--tags` / `--delete` / `--prune` / **`--no-verify`** ever; not even an env-flag opt-in. (`--no-verify` added per §Amendment 2026-05-23 FLAG-B — bypassing pre-push hooks defeats Gate-3b and any team-installed pre-push hooks.) Reviewer grep enforces (see §D2.1 DoD additions).
>
> **§DA-Gate-2 — Staging / main / master / production refuse (ADR-028 fleet invariant)**. **MUST import + reuse `isPushAllowed(branch, allowedOverride)` from `src/core/auto-push.ts:47`** — the canonical primitive. That function consults `STAGING_PATTERNS` at `src/core/auto-push.ts:32` (4 entries: `/-staging$/`, `/^main$/`, `/^master$/`, `/^production$/`) per CLAUDE.md push policy + [ADR-028] main/master PR-only fleet invariant. **NO inline regex in `src/core/orchd-push.ts`** — duplication risks the two regex sets drifting (e.g. someone adds `/^release-.+$/` to one and forgets the other). Single source of truth.
>
>   Mapping: orchd-push calls `isPushAllowed(parentBase, allowedOverride)` where `allowedOverride` is the operator-configurable allowlist. v1 wiring: `allowedOverride = cockpit.json::pushPolicy.allowedBases ?? []` (cockpit-scope, e.g. enroll `geoy.ws`-personal branches). Refusal → emit `epic.push-blocked` with reason `"refused-by-isPushAllowed — see CLAUDE.md push policy + scripts/push-staging.sh authorization gate"`.
>
>   `cockpit.json::pushPolicy.refusedBases` is **kept as an additive layer** for ops-specific extra refusals (e.g. project-specific `*-canary` branches that aren't in STAGING_PATTERNS). Order: `STAGING_PATTERNS` (canonical, via isPushAllowed) + `refusedBases` (additive); `allowedBases` overrides BOTH (escape hatch). All three live in `src/core/orchd-push.ts` as a thin wrapper around isPushAllowed — the wrapper extends but does not replace.
>
> **§DA-Gate-3 — Pre-flight cleanliness**. Three sub-checks split by cost for fire-order interleaving:
>   - **3a (subprocess, local)** — `git status --porcelain` clean (no uncommitted changes / untracked files matching `.gitignore`-respected glob). Fires AFTER Gate-7 (in-mem cooldown lookup, microseconds) BUT BEFORE Gate-1 (network). Subprocess spawn cost (~50-500ms) means it's cheaper than network but pricier than memory.
>   - **3b (costly, subprocess)** — `tsc` clean (zero errors) — invoke via `team.json::autoPush.typecheckCmd` (default `"bun run typecheck"`; empty string skips per §OQ5). Output captured to audit log on failure. Fires LAST in the chain (subprocess cost).
>   - **3c (defense-in-depth, folded into Gate-1)** — `git rev-list HEAD..origin/<base>` returns 0 (no remote-ahead). Implementation note: Gate-1's `git fetch + rev-list` already runs this; 3c is the same check spelled out in the gate roster so reviewer auditors don't think it was skipped. NOT a separate fire step.
>
>   Sub-check failure → emit `epic.push-blocked` with `{gate: "preflight", subcheck: "working-tree"|"tsc"|"remote-ahead", details}`.
>
> **§DA-Gate-4 — Opt-in per team**. `team.json::autoPush.enabled !== true` → refuse + emit `epic.push-blocked` with reason `"team.json::autoPush.enabled not set (opt-in only)"`. NEW Zod schema field (T_push_schema deliverable; canonical name **`autoPush.typecheckCmd`** — NOT `push.typecheckCmd` per FLAG-2 fix):
>   ```ts
>   autoPush: z.object({
>     enabled: z.boolean().default(false),                    // Gate-4 opt-in (loud default)
>     typecheckCmd: z.string().default("bun run typecheck"),  // Gate-3b invocation
>     cooldownSec: z.number().int().positive().default(30),   // Gate-7 window
>   }).optional().describe("ADR-229: orchd Phase 6 auto-push opt-in config. Refuse-by-default until enabled is explicitly true."),
>   ```
>   Default-false is deliberate: push policy is **opt-in**, not opt-out. Operators flip per-team after dogfood.
>
> **§DA-Gate-5 — Kill switch (cockpit-scope)**. `ATMUX_AUTOPUSH_OFF=1` env (any truthy value) → refuse ALL auto-push attempts cockpit-wide. Emit `epic.push-blocked` with reason `"ATMUX_AUTOPUSH_OFF=1 set in env"`. **Fires FIRST in the chain** — env read is microseconds, cheaper than any other gate. Higher precedence than Gate-4 (team opt-in) — kill-switch is the emergency cockpit-wide break. Matches `ATMUX_HONKER=off` substrate-pause shape.
>
> **§DA-Gate-6 — Audit trail (JSONL append-only)**. Every push attempt (success OR blocked) appends one row to `.atmux/logs/orchd-push.jsonl` (`.jsonl` extension — aligns with sibling `auto-push.jsonl` at `src/core/auto-push.ts:80`; the `.log` extension in earlier drafts was a typo, fixed via §Amendment 2026-05-23 NIT-2):
>   ```jsonl
>   {"at":"2026-05-23T14:02:11Z","epicId":"e-abc12345","base":"atmux-geoyws","outcome":"pushed","headSha":"abc123...","beforeSha":"def456...","gatesPassed":["5","4","2","7","3a","1","3b"],"durationMs":423}
>   {"at":"2026-05-23T14:05:22Z","epicId":"e-def67890","base":"unum-staging","outcome":"blocked","gateBlocked":"2","reason":"refused-by-isPushAllowed — see CLAUDE.md push policy","details":null}
>   {"at":"2026-05-23T14:08:33Z","epicId":"e-ghi13579","base":"atmux-geoyws","outcome":"blocked","gateBlocked":"1","reason":"upstream-advanced 3 commits","details":{"ahead":3,"divergenceSha":"..."}}
>   {"at":"2026-05-23T14:10:44Z","epicId":"e-jkl24680","base":"atmux-geoyws","outcome":"blocked","gateBlocked":"3b","reason":"tsc 7 errors","details":{"subcheck":"tsc","stderrTail":"..."}}
>   ```
>   Same JSONL shape as ADR-227 dissolve log + ADR-194 auto-push log (operator learns one format). Rotation: deferred (low volume — ~1 line per epic merge).
>
> **§DA-Gate-7 — Cooldown (per-team, in-memory)**. After a successful push to `<base>`, no further push to the SAME `<base>` from THIS daemon for `cooldownSec` (default 30s, configurable per `autoPush.cooldownSec`). Loop prevention: protects against rapid-fire `task.done → merge → push` cascade when an operator drains a 10-Task backlog. State stored in-memory per-daemon (no persistence — process-restart re-allows; that's fine, restarts are rare). **Fires before Gate-3a (subprocess git status) AND Gate-1 (network fetch)** so a cooldown-hit pays neither subprocess nor network cost — see fire-order table in §D2 preamble (FLAG-A swap, §Amendment 2026-05-23). Cooldown refused → emit `epic.push-blocked` with reason `"cooldown 18s remaining"`. Operator sees the wait window; not a permanent block.

### §D2.1 — Reviewer DoD additions (per §Amendment 2026-05-23 committer review)

Bundled here so T_push_module (t-1-fc0368cb) implementer + T_push_review (t-3-2bb5c6e6) reviewer both see them inline:

1. **Grep enforcement** — `rg -nP '(--mirror|--all|--tags|--delete|--prune|--force|--force-with-lease|--no-verify|forcePush)' src/core/orchd-push.ts` MUST return zero hits. Reviewer runs verbatim; CI may codify later. **`--no-verify` added per §Amendment 2026-05-23 FLAG-B** — bypassing pre-push hooks is the canonical way to ship code past local safety checks; allowing it would silently neutralize Gate-3b (tsc) and any team-installed pre-push hooks.
2. **No inline staging-pattern regex in `src/core/orchd-push.ts`** — `rg -nP '/-staging\$|\^main\$|\^master\$|\^production\$' src/core/orchd-push.ts` MUST return zero hits (only `src/core/auto-push.ts` may carry STAGING_PATTERNS). Force re-import from canonical primitive.
3. **Regression test cell: `parentBase = "main"` with empty `cockpit.json::pushPolicy` MUST refuse** — catches the §Amendment 2026-05-23 BLOCKER class (proves Gate-2 reuses isPushAllowed instead of inline `^.*-staging$` only). Test name: `"Gate-2 refuses parentBase=main with empty pushPolicy (ADR-028 fleet invariant)"`.
4. **Regression test cells for full STAGING_PATTERNS coverage** — one test per canonical pattern: `parentBase ∈ {"main", "master", "production", "unum-staging"}` all refuse via Gate-2 with default pushPolicy.

### §D3 — Topic taxonomy amendments (ADR-203 §D2)

3 new topics added to ADR-203 §D2 in same commit as T_push_module:

- `epic.pushed` — fires after `git push` succeeds. Payload: `{topic, epicId, base, headSha, beforeSha?, pushedAtSec, durationMs?}`. Consumed by Phase 4 (per §D1 amendment). Field name `pushedAtSec` (not `pushedAt`) aligns with the `*Sec` suffix convention enforced across ADR-203/226/227/228 — impl + ADR-203 §D2 entry already use `pushedAtSec`; this paragraph catches up per §Amendment 2026-05-23-rev3 reviewer-pass.
- `epic.push-blocked` — fires on any safety-gate refusal. Payload: `{topic, epicId, base, gateBlocked: "1"|"2"|"3a"|"3b"|"4"|"5"|"7", reason, blockedAtSec}`. Operator-observable in cockpit-mirror feed. `blockedAtSec` field added per §Amendment 2026-05-23-rev3 reviewer-pass (impl + ADR-203 §D2 entry already emit it; previous `details` field was a typo).
- `epic.push-conflict` — fires specifically on Gate-1 upstream-advanced refusal. Payload: `{topic, epicId, base, ahead, behind, divergenceSha?, blockedAtSec}`. Distinct from `epic.push-blocked` because it carries actionable rebase/pull metadata. Cockpit may surface a distinct Discord template (`[push-conflict]`) per ADR-219. `blockedAtSec` field added per §Amendment 2026-05-23-rev3 (impl already emits it).

### §D4 — Subscription seam (cross-team contract with `e-60e16169`)

Mirror of ADR-226 §D5. Exported by `src/core/orchd-push.ts`:

```ts
export type AutoPushOutcome =
  | "pushed"
  | "escalated"
  | "skipped-staging-base"
  | "skipped-not-opted-in"
  | "skipped-kill-switch"
  | "skipped-cooldown"
  | "skipped-preflight"
  | "skipped-honker-off";

export interface OrchdPushConsumeDeps {
  db: Database;
  consumerName?: string;        // default "atmux:orchd-push"
  topics?: ReadonlyArray<string>; // default ["epic.merged"]
  handler?: (event: EpicMergedPayload) => Promise<AutoPushOutcome>;
  nowSec?: () => number;
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
}

export async function orchdPushConsume(
  deps: OrchdPushConsumeDeps,
): Promise<{ processed: number; escalated: number }>;
```

Plus factory `createAutoPushHandler({db, performGitPush, auditLogPath, cooldownState, typecheckCmd})` that bundles production wiring + per-daemon cooldown state. Sibling EPIC `e-60e16169` imports both + invokes in the same tick-cycle as Phase 3 (chain order: merge handler → push handler → dissolve handler).

## Consequences

- **Zero-touch full lifecycle** — operator files epic → orchd handles spawn-queue-drain → spawn → kanban-run → task.done → auto-merge → auto-push → auto-dissolve. End-to-end without operator follow-up.
- **`epic.merged → epic.pushed → epic.dissolved` chain order**. ADR-227 §D1 amended (Phase 4 trigger flips from `epic.merged` to `epic.pushed`). Phase 4 still runs; just one event-hop later.
- **7 safety gates ship together** — partial shipment violates §DA-Gate-* anchors. Reviewer-trunk-signoff Task gates the merge on all 7 present + tested.
- **CLAUDE.md push policy + ADR-028 fleet invariant honored** — Gate-2 reuses canonical `isPushAllowed(branch, allowedOverride)` from `src/core/auto-push.ts:47` (4 `STAGING_PATTERNS` entries: `-staging$`, `^main$`, `^master$`, `^production$`). NO inline regex in `src/core/orchd-push.ts`. Operator-configurable allowlist/denylist additively layered via `cockpit.json::pushPolicy.{allowedBases,refusedBases}`. `geoy.ws` carve-out explicit (operator enrolls via allowlist).
- **`team.json::autoPush.enabled` opt-in default-false** — loud opt-in. No team accidentally auto-pushes pre-dogfood.
- **`ATMUX_AUTOPUSH_OFF` kill switch** — cockpit-wide emergency break, matches `ATMUX_HONKER` shape.
- **Cooldown prevents loop storms** — 30s default. Operator's flag-day backlog of 10 task.done events doesn't trigger 10 pushes within 1 minute.
- **Audit trail** — `.atmux/logs/orchd-push.jsonl` (`.jsonl` to align with sibling `auto-push.jsonl` per ADR-194) gives full forensic visibility (Gate-6).
- **Coexists with ADR-194 auto-push** — different scope (ADR-194 = per-member-branch on task.done; this ADR = parent-base on epic.merged). No replacement, no conflict.
- **Rollback** — `ATMUX_HONKER=off` OR `ATMUX_AUTOPUSH_OFF=1` OR `team.json::autoPush.enabled=false` all individually disable Phase 6. Three independent off-switches.

## Open questions

1. **Cooldown state — in-memory or DB-persisted?** Default in-memory (process-scope; restart re-allows). Reversibility: low — promotion to DB-row is one schema migration. Reasoning: cooldown is loop-prevention, not durable policy; process restart is rare + the next merge re-triggers naturally. **Decided-by**: planner.
2. **Phase 4 trigger amendment — ADR-227 §D1 flips from `epic.merged` to `epic.pushed`. Should ADR-227 be revisioned (Status: superseded + new §amendment) or marked §Amendment 2026-05-23?** Default: §Amendment block at end of ADR-227 + this ADR §D1 cross-cite. Avoids ADR-number explosion. Reversibility: medium (rename later requires git-aware sed). **Decided-by**: planner; surface to reviewer.
3. **Push to non-origin remotes?** Today's scope: `origin` only. Multi-remote (e.g. `geoyws` personal + `upstream` org) deferred to v2 follow-up. Reversibility: low. **Decided-by**: planner; v2 Task if dogfood reveals need.
4. **`epic.push-conflict` separate topic vs `epic.push-blocked` discriminator?** Default: separate topic — actionable metadata + distinct Discord template per ADR-219. Reversibility: low (collapse via discriminator if v2 noise reveals duplication). **Decided-by**: planner.
5. **Typecheck cost on every push?** A `bun run typecheck` per push adds ~3-15s latency depending on project. Per-team override via `team.json::autoPush.typecheckCmd = ""` (empty → skip) for projects where typecheck is too slow OR runs in CI as the gate. Default: enabled. Reversibility: low. **Decided-by**: planner.

## Decision-anchors

> **§DA1** — Phase 6 is a SEPARATE Story + SEPARATE ADR (not folded into Phase 3 / ADR-226). Reasoning: distinct mutation surface, distinct rollback semantics, distinct config surface, distinct topic family.
>
> **§DA2** — Trigger is `epic.merged` (ADR-226 emit); success is `epic.pushed` (NEW topic); conflict-specific is `epic.push-conflict` (NEW topic); generic block is `epic.push-blocked` (NEW topic). 3 new topics in ADR-203 §D2 amendment.
>
> **§DA3** — Phase 4 trigger amended from `epic.merged` to `epic.pushed`. ADR-227 §D1 §Amendment 2026-05-23 captures the flip; cross-cited here.
>
> **§DA4** — 7 safety gates ship TOGETHER in T_push_module's single commit. Partial shipment violates §DA-Gate-* anchors. Reviewer-trunk-signoff gates on all 7 present + tested.
>
> **§DA5** — `team.json::autoPush.enabled` opt-in **default-false**. Loud opt-in. No silent auto-push pre-dogfood.
>
> **§DA6** — `ATMUX_AUTOPUSH_OFF` cockpit-wide kill-switch + `team.json::autoPush.enabled=false` per-team off + `ATMUX_HONKER=off` substrate-off. Three independent off-switches; each disables Phase 6 independently.
>
> **§DA7** — Cross-team seam: `src/core/orchd-push.ts` exports `orchdPushConsume` + `createAutoPushHandler`. Sibling EPIC `e-60e16169` integrates daemon-loop call site (chain: merge → push → dissolve).
>
> **§DA8 (2026-05-23 §Amendment)** — Gate-2 MUST reuse `isPushAllowed` from `src/core/auto-push.ts:47` (ADR-145 primitives-vs-policy). NO inline regex in `src/core/orchd-push.ts`. ADR-028 main/master/production fleet invariant honored by sharing the canonical `STAGING_PATTERNS` set; drift between two regex sources is the failure mode this anchor prevents. Reviewer DoD includes grep enforcement (§D2.1).
>
> **§DA9 (2026-05-23 §Amendment — superseded same-day by §DA9-rev1)** — §DA-Gate-N IDs are SEMANTIC (stable cross-ADR refs). FIRE ORDER is independent + cheapest-first (5 → 4 → 2 → **7 → 3a** → 1 → 3b — per FLAG-A swap; cooldown in-mem lookup is cheaper than working-tree subprocess). Implementation MUST follow fire-order; reviewer audit verifies via test-trace ordering on a happy-path test case (which gates appeared in `gatesPassed`).

## §Amendment 2026-05-23 — committer reviewer-pass corrections (1 BLOCKER + 3 flags + 2 nits)

Committer reviewed ADR-229 at lead-outbox 11:17 MYT 2026-05-23 (pre-claim of t-1-fc0368cb). All 6 items absorbed inline above; this block records the diff trail for future readers.

**BLOCKER (ADR-028 invariant risk)**: §D2 Gate-2 originally inlined `^.*-staging$` regex + an operator-configurable list. Without operator pre-population of `cockpit.json::pushPolicy.refusedBases`, orchd-push would have ALLOWED `git push origin main` — violating ADR-028 main/master PR-only fleet invariant. **Fix**: §DA-Gate-2 now mandates `isPushAllowed(branch, allowedOverride)` import from `src/core/auto-push.ts:47` (canonical 4-pattern set). `refusedBases` survives as an ADDITIVE layer; `allowedBases` survives as an escape hatch. §DA8 codifies the no-inline-regex rule; §D2.1 reviewer DoD adds grep enforcement.

**FLAG-1 (ADR-145 primitives-vs-policy)**: enforce via §D2.1 grep DoD + §DA8 anchor. orchd-push imports primitives; does not duplicate them.

**FLAG-2 (config field name drift)**: §D2 originally referenced both `team.json::push.typecheckCmd` (Gate-3 prose) and `team.json::autoPush.typecheckCmd` (Gate-4 Zod schema). Unified on **`autoPush.typecheckCmd`** matching §DA5 + Gate-4 schema. All Gate-3b prose now cites the canonical field.

**FLAG-3 (fire-order contradicts cheapest-first claim)**: original §D2 ordered gates 1-7 by §DA-Gate-N numbering, but Gate-1 (network fetch+rev-list) is more expensive than Gate-5 (env read) / Gate-4 (file read) / Gate-2 (string match). **Fix**: §D2 now distinguishes SEMANTIC IDs (§DA-Gate-N, stable cross-ADR refs) from FIRE ORDER (cheapest-first: 5 → 4 → 2 → 3a → 7 → 1 → 3b). §DA9 codifies.

**NIT-1 (ADR-227 §Amendment underspecified)**: ADR-227 §Amendment block must EXPLICITLY state Phase 4 does NOT fire on `epic.push-blocked` / `epic.push-conflict` — cage persists until operator resolution. Otherwise readers might infer Phase 4 fires on any push-terminal event. **Fix**: T_adr227_amend (t-7-29631cdc) body updated to require that explicit non-fire clause; ADR-227 amendment authored same-commit as T_push_module.

**NIT-2 (audit log extension drift)**: §DA-Gate-6 originally said `.atmux/logs/orchd-push.log`; sibling ADR-194 uses `.atmux/logs/auto-push.jsonl`. **Fix**: renamed throughout to `.atmux/logs/orchd-push.jsonl` for operator-cognitive consistency (one extension across the audit-log family).

**Verifier**: t-2-944dfc1c (ADR-229 reviewer-pass) confirms all 6 corrections landed before flipping Status: accepted.

### §Amendment 2026-05-23-rev2 — be-1's conditional reviewer-pass (2 single-line patches)

be-1 shipped conditional reviewer-pass at commit `2310085` (lead-outbox relay 2026-05-23). 6 of the committer-amendment items verified landed; 2 single-line patches still needed before Status: accepted flip. Both applied below; Status: accepted flipped in the same commit.

**FLAG-A — fire-order swap (3a ↔ 7)**: original fire-order in §D2 + §DA9 was `5 → 4 → 2 → 3a → 7 → 1 → 3b`. Gate-7 (cooldown) is an in-memory `Map.get` (microseconds); Gate-3a (working-tree) forks `git status --porcelain` as a subprocess (~50-500ms). Cheaper-first means 7 fires BEFORE 3a. **Fix**: fire-order updated throughout §D2 (preamble + DA-Gate-3 + DA-Gate-7), `gatesPassed[]` audit-log example reordered, §DA9 superseded by §DA9-rev1.

**FLAG-B — `--no-verify` grep blocklist gap**: §DA-Gate-1 + §D2.1 grep enforcement omitted `--no-verify`. Bypassing pre-push hooks is the canonical exfil for unsafe code (it defeats Gate-3b tsc AND any team-installed pre-push hooks). **Fix**: `--no-verify` added to both §DA-Gate-1 prose blocklist AND §D2.1 grep regex. T_push_module (t-1-fc0368cb) body updated to include the augmented grep.

**Status flip**: proposed → accepted, landing in the SAME commit as these 2 patches.

### §Amendment 2026-05-23-rev3 — Independent reviewer-pass on Phase 6 trunk-signoff (t-3-2bb5c6e6)

Independent reviewer (per brief §audit-bar #1) audited cumulative Phase 6 diff = `6d8e593` (schema) + `1c31056` (orchd-push.ts module + 7 gates + ADR-229 same-commit + ADR-203 §D2 amendment + tests). Supersedes be-1's self-trunk-signoff `6a4b7e6` (be-1 self-flagged independence caveat at claim time per lane=be routing past ADR-031 REVIEW-lane carve-out).

**Audit verdict**: APPROVE — all 12 DoD checklist items in t-3-2bb5c6e6 body verified by independent inspection. Highlights below; full enumeration in trunk-signoff Task note.

Independent greps run (NOT copied from author):

```
# (a) Forbidden flags — own pattern, slightly broader than §D2.1
rg -nP '\-\-force|\-\-mirror|\-\-all\b|\-\-tags\b|\-\-delete\b|\-\-prune\b|\-\-no-verify|forcePush|force-with-lease' src/core/orchd-push.ts
# Result: 6 hits, ALL in module-header DoD comment block (lines 20-22, 310-311 — quoting the prohibition for future maintainers).
# Carve-out: §D2.1 grep DoD is codified as a unit test that filters comment lines (tests/unit/core/orchd-push.test.ts:748-751);
# zero functional invocations exist. Test correctly strips `^\s*//` and `^\s*\*` lines before assertion.

# (b) Inline STAGING_PATTERNS regex
rg -nP 'staging\$|\^main\$|\^master\$|\^production\$|-staging|/main/|/master/|/production/' src/core/orchd-push.ts
# Result: 5 hits, all string LITERALS (skipped-staging-base outcome label, scripts/push-staging.sh in error msg, DoD comment).
# Zero RegExp constructions; STAGING_PATTERNS confirmed single-sourced at src/core/auto-push.ts:32.

# (c) isPushAllowed import + invocation
rg -n 'isPushAllowed' src/core/orchd-push.ts
# Result: imported at line 43; invoked at line 274. Canonical reuse — no shadow primitive.

# (d) Gate fire-order trace (cheapest-first per §DA9-rev1)
sed -n '254p;261p;272p;290p;301p;308p;367p' src/core/orchd-push.ts
# Result: Gate-5 (line 254) → Gate-4 (261) → Gate-2 (272) → Gate-7 (290) → Gate-3a (301) → Gate-1 (308) → Gate-3b (367). Matches §DA9-rev1.
```

**Drift flagged (NIT — not blocker; follow-up Task scope)**: §DA-Gate-2 line 96 claims "allowedBases overrides BOTH (escape hatch)" but impl at `src/core/orchd-push.ts:274,281` honors a different precedence — allowedBases overrides STAGING_PATTERNS only (line 274 via isPushAllowed `allowedOverride`), while refusedBases is an independent additive check (line 281) that fires regardless of allowedBases membership. In the **conflict case** (base in BOTH allowedBases AND refusedBases), impl refuses; ADR says allow. No test covers the conflict case today.

Two valid resolutions for follow-up (either preserves intent; planner picks):
1. **Patch impl line 281** to `if (policy.refusedBases.includes(base) && !policy.allowedBases.includes(base))` — honors ADR "allowedBases overrides BOTH" semantics.
2. **Patch ADR §DA-Gate-2 line 96 + §D2 Gate-2 prose** to "refusedBases is additive AND wins on conflict — operator safety net default" + add a regression test cell to t-1-fc0368cb's grand suite ("base in both lists → refusedBases wins").

Either resolution is a one-line code change OR a doc fix. Independent reviewer recommends #2 (refusedBases-wins is the safer default in operator-config-conflict edge cases), but defers to planner. Follow-up Task ID TBD — operator-direct via driver-inbox or via lead routing.

**Decision-anchor + Open-question cross-refs intact** — verified via direct read: §DA1↔§D1, §DA2↔§D3+§D1, §DA3↔ADR-227 §D1 §Amendment, §DA4↔§D2, §DA5↔§D2 Gate-4, §DA6↔§D2 Gate-5+Gate-4, §DA7↔§D4, §DA8↔§D2 Gate-2+§D2.1+§Amendment, §DA9+§DA9-rev1↔§D2 fire-order. §OQ1↔§DA-Gate-7, §OQ2↔ADR-227 §D1 §Amendment, §OQ4↔§DA-Gate-1+§D3 push-conflict, §OQ5↔§DA-Gate-3b+§DA-Gate-4 schema. §OQ3 (multi-remote) properly deferred to v2 with no §Decision-anchor (correct shape).

**Test coverage enumeration** (Story-diff level — 1c31056 ships 795-line test file; 100% line coverage on orchd-push.ts + schema/events.ts per commit body):

| Group | Tests | Coverage class |
|---|---|---|
| appendOrchdPushAuditRow JSONL writer | 1 | §DA-Gate-6 audit-log shape |
| Happy-path 7-gate fire order | 1 | §DA9-rev1 cheapest-first; gatesPassed audit |
| Gate-1 upstream-advanced | 1 | push-conflict emit + escalated outcome |
| Gate-2 (BLOCKER regression + STAGING_PATTERNS coverage + carve-outs) | 6 | main / master / production / unum-staging / allowedBases escape / refusedBases additive |
| Gate-3a working-tree dirty | 1 | skipped-preflight via runGitStatusClean |
| Gate-3b tsc | 2 | tsc errors + typecheckCmd="" skip per §OQ5 |
| Gate-4 opt-in | 1 | enabled=false → skipped-not-opted-in |
| Gate-5 kill-switch | 4 | base trigger + empty + "0" guard + Gate-5-over-Gate-4 precedence |
| Gate-7 cooldown | 4 | within-window + post-window + per-base + Gate-7-before-Gate-3a cost-saving |
| dispatcher skipped-not-mine | 1 | no terminal emit / no audit row |
| default handler stubs | 4 | DEFAULT_DISPATCH_STUB + DEFAULT_TSC_CLEAN + DEFAULT_GIT_STATUS_CLEAN + default-resolvers-refuse-via-Gate-4 |
| logger info/warn | 2 | warn-on-conflict + info-on-pushed |
| orchdPushConsume kill-switch | 3 | ATMUX_HONKER off + unset + log-fallback |
| orchdPushConsume happy + escalated counts | 2 | N-event drain + escalated separation |
| orchdPushConsume idempotency | 1 | throw-halts-drain (offset stays) |
| orchdPushConsume consumer + topic injection | 2 | custom consumerName + default topics=['epic.merged'] |
| end-to-end consumer→factory→7-gates | 1 | emit epic.merged → drain → emit epic.pushed |
| §D2.1 grep DoD codified | 2 | forbidden-flag + inline-regex (test strips comments before assertion — verified at tests/unit/core/orchd-push.test.ts:748-751) |

**Three-off-switch independence verified structurally**:
1. `ATMUX_HONKER=off` short-circuits `orchdPushConsume` at line 469-472 BEFORE handler invocation.
2. `ATMUX_AUTOPUSH_OFF=1` short-circuits `createAutoPushHandler` at Gate-5 line 254-258 (env read, fires first).
3. `team.json::autoPush.enabled=false` short-circuits at Gate-4 line 261-269 (file-resolved config). Each gate hits a different code path; tests cover each in isolation (Gate-5-over-Gate-4 precedence test confirms Gate-5 wins when both off → expected).

**Carve-outs accepted**:
- Sibling-daemon Phase 3+6 chain integration is e2e-stubbed (sibling EPIC `e-60e16169`'s `src/verbs/orchd.ts` not yet shipped). End-to-end consumer→factory→push test exercises the seam shape; the daemon-loop chain order (merge → push → dissolve) is sibling-territory scope.
- ADR §D3 `*Sec` field-name alignment patched in this Amendment (3 fields catch up to impl + ADR-203 §D2 already-aligned shape).
- §DA-Gate-2 precedence drift filed as follow-up (NIT scope — see above).

**Be-1's self-signoff `6a4b7e6` is superseded** by this independent reviewer pass; the standalone `docs/reviews/t-1-fc0368cb-trunk-signoff-2026-05-23.md` file remains as historical record of be-1's self-checklist.

Trunk-signoff status: APPROVED. Phase 6 ships ready-to-merge; magic-value `extra.role='reviewer-trunk-signoff'` stamp on t-3-2bb5c6e6 owed to driver per atmux 0.8.11 `task update --extra` gap.
