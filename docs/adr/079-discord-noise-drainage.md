# ADR-079: Discord noise drainage — wave 2

**Status**: accepted (impl wave shipped + reviewer signoff 2026-05-09 13:53 MYT; status-flip 2026-05-12 per t-bb05b9ba — driver-inbox 16:46 MYT 2026-05-10 ask. Shipped commits: §A `ace99b4` · §B `8d8de60` · §C `5d128ec` · §D `cb25664`. Reviewer signoff doc at `docs/reviews/ADR-079+080-revise-pass-1-signoff-2026-05-09.md`.)
**Date**: 2026-05-09
**Driver-ref**: 2026-05-08 17:07 MYT superdriver three-bug bundle + 18:35 MYT sopx-driver 5-finding addendum (`/root/work/src/atmux/.atmux/handoff/superdriver-to-driver-discord-noise-20260508T1707-MYT.md`). Gate cleared by ADR-077 superdoctor wave shipping (`6db43f6` chore(release): 0.6.0). Operator (sopx-driver, 2026-05-08 18:30 MYT) measured `sopx/.atmux/logs/discord.log` at ~275 pings/24h with 90% bare-`[whip]` boilerplate; target ≤80/24h. Demo-week deadline 2026-05-13.

> **Naming note 2026-05-14**: the role formerly called `superdoctor` (mentioned in §Driver-ref + §Context "what already shipped" rows) is now called **medic** per [ADR-133](133-medic-rename.md). Body refs to "superdoctor" retained for historical accuracy; supersession is naming-only, design unchanged.

## Context

### What already shipped (out of scope; referenced for context only)

| Finding | Source | Status | Commit |
|---|---|---|---|
| Bug 1 — `[whip-overdue]` validator missing `⏰📋🩹💓🚀⏳` | 17:07 §Bug 1 + 18:35 §1 | ✅ shipped | `8bf9070` adds 6 emojis to `ALLOWED_BULLET_PREFIX` (`src/abstractions/discord.ts:201-216`) + structural lint test (`tests/unit/abstractions/discord-bullet-prefix-audit.test.ts`) |
| Bug 2-A — cron PATH bake-in for bun shebang resolution | 17:07 §Bug 2 (env half) | ✅ shipped | `fdc16f0` adds `PATH=...` prefix per cron line (`src/core/cron.ts:80-81`) |

### What's still bleeding noise

- **Bug 2-B — schedules ignore `team.whip.intervalMins`** (`src/core/cron.ts:89,94,97,101,111,117`): six hardcoded literals (`*/5`, `*/30`, `0 */4`, `0 4`, `*/1`, `*/2`) regardless of config. Schema field `intervalMins` exists at `src/schema/team.ts:82` but is unread. Operator workaround: manual `crontab -e`, lost on next `atmux start`.
- **Bug 3 — `[whip-audit]` stale rule + audit verb not bun-ported**: `[whip-audit]` pings still fire from a non-typed (likely bash leftover in `.archive-bash-atmux-20260507/`) emitter; rule expects `__atmux__driver` but ADR-044 specifies bare `driver`.
- **Finding #4 — bare `[whip]` template-namespace violation**: 90% of observed sopx pings use bare `[whip]`. **Bun TS surface is already R10-locked**: `DiscordTemplate` union (`src/abstractions/discord.ts:34-99`) has no `"whip"` literal; the compile-time invariant prevents bun-emit of bare `[whip]`. The violation is therefore downstream of bun source — sopx-side bash atmux install, or `.archive-bash-atmux-20260507/` cron emitter still wired in.
- **Finding #5 — diff-based posting on transitions only**: every 5-min cycle re-posts the same boilerplate ("lead: messages queued", "fe-reports: 2 tasks > 90min") even when state is unchanged. Per sopx-driver's measurement: **~70% noise reduction available** via per-member previous-state hash + emit-only-on-transition gate. Single highest-leverage fix in the bundle. Subsumes the "auto-preclear-failed re-fires every 5min" loop noise.

### Why one ADR (not four)

All four are emit-side noise reduction; all share the demo-week deadline; reviewer bar is identical (regression-pin per fix). Sub-section commits keep blast radius small while letting ADR docs stay one read.

## Decision

Four reviewer-gateable sub-sections, each shipping in its own commit. Lead routes per dispatch table at end.

### §A — Cron schedules read from team config (Bug 2-B)

**Lane**: `cron-fired` → `parity-cron-impl`.

Replace the six literals at `src/core/cron.ts:89,94,97,101,111,117` with a `cronEvery(N: number) → string` helper reading from team config:

```ts
function cronEvery(minutes: number): string {
  if (minutes <= 0 || minutes > 60) {
    throw new ConfigError({ what: `cronEvery: minutes must be 1–60 (got ${minutes})` });
  }
  if (minutes === 60) return "0 * * * *";
  if (60 % minutes === 0) return `*/${minutes} * * * *`;
  // Doctor warns; renderer falls back to closest divisor.
  return `*/${closestDivisor(minutes)} * * * *`;
}
```

**Schema additions** (`src/schema/team.ts`):

| Field | Default | Reads at | Maps to cron line |
|---|---|---|---|
| `team.whip.intervalMins` | 5 (existing) | already exists | `*/5 ... atmux whip` |
| `team.report.intervalMins` | 30 (new) | `cron.ts:97`, `:94` | `*/30 ... atmux report` (or discorder progress) |
| `team.report.heartbeatHours` | 1 (new) | `cron.ts:95` | `0 * ... atmux discorder heartbeat` |
| `team.decisions.intervalHours` | 4 (new) | `cron.ts:101` | `0 */4 ... atmux decisions digest` |
| `team.groom.atHour` | 4 (new) | `cron.ts:104` | `0 4 ... atmux groom` |
| `team.unblocker.intervalMins` | 2 (new) | `cron.ts:117` | `*/2 ... atmux unblocker tick` |

The `whip-resume-check` 1-min gate at `cron.ts:111` stays hardcoded — sub-1-min cadence isn't a tunable, it's ADR-053 §D4's deliberate post-pause latency floor.

**Doctor warn** (`src/verbs/doctor.ts`): a new yellow check `cron-interval-divisor` warns when any configured `intervalMins` is not a divisor of 60. Cron's `*/N` only honors divisors of 60 cleanly — `*/7` fires at xx:00, xx:07, ..., xx:56, then xx:00 (gap of 4min, not 7).

**Tests** (`tests/unit/core/cron.test.ts`):
- Per-config-shape: `whip.intervalMins=5` → `*/5`, `=10` → `*/10`, `=60` → `0 * * * *`, `=7` → throws (or downgrades w/ warn — see OQ-A1).
- Per-emit-line: `report.intervalMins=60` swaps to `0 * * * * ... atmux report`.
- Doctor warn: invalid divisor surfaces yellow row, not red.

**OQ-A1 [recommended: throw on invalid divisor at render time + emit doctor yellow at config-load time]** — caller-facing fail-fast keeps cron silently-broken-schedules out of the wild.

### §B — Audit verb bun port + driver-name rule alignment (Bug 3)

**Lane**: `read-only` → `parity-read-impl`. (Audit verb is read-only / report-shaped — it inspects topology + emits findings; no state mutation. Off-loaded from whip-impl per load-balance.)

Two layered fixes:

**3a — port `lib/audit.sh` from `.archive-bash-atmux-20260507/` to `src/verbs/audit.ts`**:
- Class-A driver-name rule expects bare `driver` per ADR-044 (NOT `__${team}__driver`).
- Class-B+ rules ported as-is (phantom inbox prune, etc.). Each rule typed via discriminated union per ADR-019 doctor pattern.
- Wire into existing cron block (replaces the bash leftover emitter). `[whip-audit]` template stays in `DiscordTemplate` union.

**3b — kill the legacy bash emitter still firing `[whip-audit]` with `trigger: "unknown"`**:
- Investigation step (sub-30min): `grep -rn "whip-audit" .archive-bash-atmux-20260507/ ~/.claude/worktrees/atmux-bun/lib/ ~/.claude/worktrees/atmux-sqlite/lib/ 2>/dev/null` — find the emitter site.
- Disable the bash path with a one-line guard (or remove the script entirely if `.archive-bash-` is the only host) — sopx-driver guidance: prefer port-then-disable.

**Tests** (`tests/unit/verbs/audit.test.ts`):
- Class-A passes when driver window is named `driver`.
- Class-A fails when driver window is named `__atmux__driver` (regression-pin against the old expectation).
- Phantom-inbox class-B fixtures match bash behavior bit-for-bit.

### §C — `[whip]` template-namespace investigation + structural lint (Finding #4)

**Lane**: `read-only` → `parity-read-impl`. (Pure diagnosis + lint — no runtime emit changes; off-loaded from whip-impl per load-balance.)

Bun TS source can't emit bare `[whip]` (compile-time R10), so this section is **diagnosis + future-proof lint**, not emit-site rewrite. Per OQ-4: investigation + lint only, no aggressive bash teardown this round.

**Investigation step** (~30min, output is a 1-page operator note):
- `grep -rn '"\[whip\]"\|"whip"' .archive-bash-atmux-20260507/ ~/.claude/worktrees/ 2>/dev/null`.
- Identify each emitter; correlate against `sopx/.atmux/logs/discord.log` body_sha256 hashes to confirm host.
- Output: `docs/INVESTIGATION-bare-whip-emitters.md` listing each emitter + recommended fix path (sopx pulls bun-port main, OR per-script bash patch).

**Structural lint** (`tests/unit/abstractions/discord-no-bare-whip.test.ts`):
- AST-grep `src/**/*.ts` for any `template:` literal that equals `"whip"` (no suffix).
- Fails CI with "bare [whip] is R10-violation per ADR-008; use [whip-progress] / [whip-blocker] / [whip-stuck] / [whip-heartbeat] / [whip-overdue]."
- Pre-empts the failure mode where a future contributor adds `"whip"` to the union literal-by-literal and silently bypasses the namespacing intent.

**Out of scope (deferred per OQ-4)**:
- Aggressive `.archive-bash-` removal — needs separate ADR if sopx still load-bearing on bash atmux.
- Sopx-side migration plan — that's sopx-team work, not atmux-team work.

**Tests**: lint-only this section.

### §D — Diff-based posting / transitions-only (Finding #5, highest leverage)

**Lane**: `error-class` → `whip-impl`.

Per-member previous-state hash + emit-only-on-transition. Subsumes the auto-preclear-failed re-fire loop naturally (state unchanged → no emit).

**State file** (`src/core/whip-finding-state.ts`, new — mirrors the `perm-mode-drift-state.ts` shape exactly):

```ts
// State map: <member>.<finding-kind> → {hash: string, lastFireSec: number}
// hash = sha256_16 of finding bullets (excluding timestamp).
// lastFireSec drives hourly heartbeat re-fire.

export interface FindingState { hash: string; lastFireSec: number; }
export type WhipFindingState = Record<string, FindingState>;

export function shouldFireFinding(
  state: WhipFindingState,
  key: string,                  // e.g. "fe-reports.stuck"
  newHash: string,
  nowSec: number,
  heartbeatSec: number = 3600,  // hourly forced re-fire
): "transition" | "heartbeat" | "suppress" {
  const prior = state[key];
  if (prior === undefined) return "transition";
  if (prior.hash !== newHash) return "transition";
  if (nowSec - prior.lastFireSec >= heartbeatSec) return "heartbeat";
  return "suppress";
}
```

**Caller integration** (`src/verbs/whip.ts:1463,:1473,:1485` — `whip-blocker` / `whip-overdue` / `whip-progress` emit sites):
- Compute finding hash before emit.
- Gate via `shouldFireFinding`. Suppress → skip Discord call + log `whip: <member>.<kind>: state unchanged, suppressed`.
- Transition or heartbeat → emit + update state.

**Heartbeat policy**:
- `whip-heartbeat` template (`whip.ts:1451`) keeps its hourly cadence; this section reuses it for forced state re-affirmation when nothing transitioned but operator needs liveness.
- Operator setting `team.whip.heartbeat: false` (existing schema) suppresses the heartbeat re-fire — nothing emits when state unchanged.

**Expected ping volume reduction** (sopx-driver measurement-based):
- 275 pings/24h → ~80 pings/24h (~70% drop). Hits the operator target.

**Tests** (`tests/unit/core/whip-finding-state.test.ts` + `tests/unit/verbs/whip-emit-dedup.test.ts`):
- `shouldFireFinding` returns "transition" on missing/changed hash, "suppress" on identical hash within heartbeat window, "heartbeat" on identical hash past heartbeat window.
- Whip emit fixture: hash=X then hash=X again within 5min → second tick suppresses. hash=X then hash=Y → both emit. hash=X 65min apart → second emits as heartbeat.
- Auto-preclear-failed regression: 12 consecutive ticks with same finding-hash → 1 emit + (after 1h) 1 heartbeat re-emit; not 12.

## Caller migration

| Caller | Before | After |
|---|---|---|
| `cron.ts:89,94,97,101,111,117` | hardcoded literals | `cronEvery(team.whip.intervalMins)` etc. |
| `whip.ts:1463,:1473,:1485` | unconditional emit | hash-gated emit via `shouldFireFinding` |
| (new) `verbs/audit.ts` | bash spawn from cron | typed verb dispatched via cron block |
| (deleted) `.archive-bash-.../audit.sh` invocation site | cron leftover | removed (3b) |

No `team.json` migration required — all new schema fields default to current behaviour. Existing teams pick up the new policies on next `atmux start` (cron block re-renders).

## Test plan summary

- §A: 5 cron renderer branches (whip / report-or-discorder / decisions / groom / unblocker — `whip-resume-check` stays hardcoded) + 1 doctor warn = 6 unit tests.
- §B: 1 driver-name pass + 1 driver-name regression-pin + N phantom-inbox parity tests = ~4–6 unit tests.
- §C: 1 lint test (no further runtime tests).
- §D: 3 `shouldFireFinding` branches + 3 emit-fixture cases + 1 auto-preclear regression = 7 unit tests.

All same-commit-as-code per CLAUDE.md "Testing Discipline". Coverage: 100% on new code (cron renderer, audit rule, hash gate, lint).

## Commit strategy

Single commit per sub-section. Conventional:

```
fix(cron): config-driven schedules (ADR-079§A)
feat(audit): bun port of audit verb + ADR-044 driver-name rule (ADR-079§B)
chore(lint): fail CI on bare [whip] template literal (ADR-079§C)
feat(whip): per-finding hash dedup + transitions-only emit (ADR-079§D)
docs(adr): ADR-079 — Discord noise drainage wave 2
```

Reviewer gates each commit independently. ADR doc commit lands first; impl commits land in dispatch order (likely §A first as smallest, §D last as biggest).

## Branch + push policy

- All on `geoyws` (NON-staging — auto-push fine per Push Policy).
- No `${product}-staging` destination involved; no manual gate trip.

## Open questions

- **OQ-A1** [recommended: **throw on invalid divisor + doctor yellow**] — fail-fast vs. silently-degrade. Override by reply.
- **OQ-A2** [recommended: **`team.report.heartbeatHours: 1`** as separate field, not derived from `intervalMins`] — operator may want hourly heartbeat at 30min report cadence or vice versa. Override by reply.
- **OQ-D1** [recommended: **per-finding-kind hash key, not whole-tick hash**] — finer granularity, fewer suppression false-positives. Override by reply.

## Coverage / negative-space

This ADR addresses **emit-side** noise (validator allowlist, schedule cadence, template namespacing, dedup gate). **Not in scope, not orphaned**:

- **Discord webhook reachability** — covered by ADR-019 doctor's `discord-webhook` check.
- **Webhook chunking** — covered by `discord.ts:8-9` (2000-byte hard limit).
- **Receive-side filtering** (operator's Discord channel rules) — operator-owned, not atmux-owned.
- **`[whip-audit]` stale rule beyond driver-name** — Class-B+ rules ported as-is in §B; broader audit-rule modernisation = separate ADR if surfaced.
- **Bug 4 (cage-killing `bun test`)** — flagged in 17:07 MYT handoff add-on (00:50 MYT 2026-05-09); test-isolation lane, NOT Discord-noise. Recommend separate ADR if not already addressed in ADR-077 superdoctor wave.

## Dispatch table

| Section | Lane            | Member             | Window | Primary files                                                  | Blocked by |
|---------|-----------------|--------------------|--------|----------------------------------------------------------------|------------|
| §A      | cron-fired      | parity-cron-impl   | W7     | `src/core/cron.ts:89,94,97,101,111,117`, `src/schema/team.ts`, `src/verbs/doctor.ts` | —          |
| §B      | read-only       | parity-read-impl   | W9     | `src/verbs/audit.ts` (new), `.archive-bash-atmux-20260507/lib/audit.sh` (delete) | —          |
| §C      | read-only       | parity-read-impl   | W9     | `tests/unit/abstractions/discord-no-bare-whip.test.ts` (new), `docs/INVESTIGATION-bare-whip-emitters.md` (new) | —          |
| §D      | error-class     | whip-impl          | W5     | `src/core/whip-finding-state.ts` (new), `src/verbs/whip.ts:1463,:1473,:1485` | —          |

**Parallel-safe**: all four sections dispatch in parallel (no cross-deps). parity-read-impl owns two adjacent investigation/lint tasks (§B + §C); recommend §B first as larger, §C as quick follow-up. whip-impl owns §D solo (the heaviest individual ticket — biggest leverage per sopx measurement).
