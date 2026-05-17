# ADR-078: probeBudget read-only by default — refreshOnNearExpiry opt-in

**Status**: accepted
**Date**: 2026-05-09
**Driver-ref**: 2026-05-09 hax cockpit rebuild — operator (cockpit-superdriver) flagged P0 OAuth race after `atmux cockpit rebuild` left the unum driver pane stuck at "Login or use API key". Lead dispatched planner via `/root/.claude/teams/atmux/dispatch-p0-oauth-race.md`. Recommendation #2 (this ADR) flagged as preferred upstream.

## Context

### The bug

During George's cockpit rebuild at 01:28 MYT 2026-05-09, atmux fired `probeBudget` against the just-spawned `claude` TUIs. The Fix-C path in `src/abstractions/budget-probe.ts:182-208` runs `tryRefreshOauth` → `persistRefreshedTokens` whenever `expiresAt < now()+60s`, atomic-rewriting `~/.claude-<account>/.credentials.json` with new tokens. Anthropic rotates `refreshToken` server-side on every refresh, invalidating the previous one.

The TUIs had **already loaded the old tokens into memory** at spawn time. Once atmux's refresh completed:

1. atmux now holds `(accessToken-new, refreshToken-new)` on disk; the old `refreshToken-old` is server-invalidated.
2. The TUI keeps `(accessToken-old, refreshToken-old)` in memory. `accessToken-old` is still semantically valid until natural expiry — so the TUI seems healthy.
3. When `accessToken-old` expires, the TUI tries to refresh using `refreshToken-old`. → 401 (server rejected, rotated). → "Login or use API key" screen.

The bug is structural: **atmux's Fix-C path mutates a shared credentials file that other processes have a stake in.** Bumping the 60s margin (option #1 below) only narrows the race window; it doesn't fix the root cause.

### Evidence

- `/root/.claude-unum/.credentials.json` mtime `2026-05-09 01:28:51` — exactly during rebuild.
- `/root/.claude-icloud/.credentials.json` mtime `2026-05-09 01:28:57`.
- unum **lead** pane (spawned ~3s later) reads post-refresh tokens cleanly → status `geoyws@u-n-u-m.com max`. unum **driver** pane stuck at `--` account, `0 tokens`.
- sopx panes got lucky on timing; symptom did not appear there.
- Cockpit-rebuild itself does NOT call `probeBudget` directly. The race-window suspect is a concurrent whip-tick (`runBudgetCheck` in `src/core/whip-budget-check.ts:176`) or an account-swap pass (`runAccountSwapCheck` at `src/core/account-swap.ts:519` and `:536`, the latter `force: true`). Either path enters the Fix-C refresh on near-expiry. The bug surfaces in cockpit-rebuild because that's where multiple TUIs spawn within seconds of each other; whip-tick + account-swap fire on cron and would race occasionally even outside rebuild, but the operator notices it most visibly when half a cockpit boots without auth.

### Why Fix-C exists

ADR-053 §D1 introduced the OAuth refresh path so that long-running whip cron loops don't 401 mid-tick when an account's access token aged past expiry. That use case is real — atmux **owns** the whip daemon's credentials lifecycle in that context, and refresh-on-the-fly keeps the daemon alive without operator intervention. The issue is that the same code path is now entered by short-lived probes that have no stake in the credentials lifecycle (account-swap, future cockpit/UI surfaces) and just want to read budget headers.

## Decision

**Make `probeBudget` read-only by default. Add a `refreshOnNearExpiry: boolean` option that callers explicitly opt into.** Only long-running daemon contexts that own the credentials lifecycle pass `true`. Spawn-time / one-shot probes pass `false` (the default), getting `probe-401` instead of triggering refresh.

### Option table

| # | Option | Complexity | Blast radius | Preserves Fix-C? | Cockpit UX impact |
|---|--------|------------|--------------|------------------|-------------------|
| 1 | Bump `expiresAt > now+5min` threshold (vs current `now+60s`) | Trivial — 1 const | Smallest (1-line change) | Yes (just shifts when refresh fires) | Race window narrows but persists; cockpit-rebuild still 401s if a TUI spawns inside the new 5min lookahead window. **Doesn't fix root cause.** |
| **2** | **`probeBudget` read-only by default; `refreshOnNearExpiry` opt-in (PREFERRED)** | **Low — opt arg + 4-5 caller migrations** | **Surgical (gates existing branches)** | **Yes (whip-budget-check + whip-resume-check pass `true`; preserve Fix-C behaviour where it belongs)** | **Cockpit-rebuild + account-swap stop racing TUI spawns; budget UX unchanged from operator POV** |
| 3 | Defer probe entirely until first whip tick | Medium — cockpit-rebuild placeholder + first-tick wakeup | Largest (UX shift; budget shows `--` until first probe arrives) | Yes (whip ticks still refresh) | Cockpit boots without budget data; `--` until next minute. **Most conservative on race; worst UX.** |

### Why #2

- **Structurally honest.** Refresh-on-the-fly is a behaviour that **only** makes sense when the caller owns the credentials lifecycle. Making the default opt-in says that explicitly at every call site, instead of hiding the tradeoff inside `probeBudget`.
- **Surgical.** All five existing call sites are reachable; default `false` is safe (worst case the probe 401's and the operator gets a flag — same surface they'd see today if Fix-C failed). Only the two daemon paths need to flip `true` to keep current behaviour.
- **Test-extensible.** A regression test simulating "spawn TUI → probe with refresh — assert old refreshToken still works" gates against future drift. With the opt-in, the test path is just "call with `refreshOnNearExpiry: false` → assert no `persistRefreshedTokens` call → no race."
- **Reversible.** If the daemon paths later prove to also need the refresh-off variant (unlikely but possible), they flip a flag; no rewind needed.

## Implementation

### D1 — `src/abstractions/budget-probe.ts`

Add `refreshOnNearExpiry?: boolean` to `ProbeBudgetOpts`:

```ts
export interface ProbeBudgetOpts {
  // ...existing...

  /**
   * Refresh OAuth tokens when `expiresAt < now+60s`. **Default: false.**
   *
   * Setting this to `true` causes `probeBudget` to atomic-rewrite
   * `.credentials.json`, which rotates the server-side refreshToken.
   * Any other process holding the previous refreshToken in memory
   * (e.g. a just-spawned `claude` TUI) will 401 on its next refresh.
   *
   * Only set `true` in long-running daemon contexts that **own** the
   * credentials lifecycle (whip-budget-check, whip-resume-check). For
   * one-shot probes (cockpit, account-swap, doctor checks), leave it
   * false — a stale-token probe will return `probe-401` and the
   * operator gets a normal flag-surfaced error instead of an invisible
   * race against TUI spawns.
   *
   * Origin: ADR-078 (P0 cockpit-rebuild OAuth race, 2026-05-09).
   */
  refreshOnNearExpiry?: boolean;
}
```

Gate both Fix-C branches on the flag. Read at top of function:

```ts
const refreshOnNearExpiry = opts.refreshOnNearExpiry === true;
```

**Branch 1** (lines 183-208 — pre-probe near-expiry refresh): wrap the entire `if (expiresAt > 0 && expiresAt < now() + REFRESH_MARGIN_SEC * 1000)` block in `if (refreshOnNearExpiry)`. When `false` and the token is near-expiry, fall through to the probe call — let the upstream 401 (if any) surface as `probe-401` with a helpful error.

**Branch 2** (lines 215-231 — single 401 retry with refresh): wrap in `if (refreshOnNearExpiry)`. When `false` and the probe returned 401, skip the retry and emit `probe-401` directly.

Update the file-header docstring (lines 1-37) to call out the opt-in: ADR-078 narrows Fix-C to its intended surface (whip daemons), not all probes.

### D2 — Caller migration (5 sites)

Grep:

```bash
grep -rn 'probeBudget\b' src/ | grep -v 'budget-probe.ts'
```

| # | File:line | Caller | Set to | Rationale |
|---|-----------|--------|--------|-----------|
| 1 | `src/core/whip-budget-check.ts:176` | `runBudgetCheck` (whip cron) | `true` | Long-running daemon. Owns credentials lifecycle. **Preserves Fix-C.** |
| 2 | `src/verbs/whip-resume-check.ts:192` | `whip-resume-check` (cron tick) | `true` | Long-running daemon. Same rationale as #1. |
| 3 | `src/core/account-swap.ts:519` | `runAccountSwapCheck` (per-account probe loop) | `false` | One-shot probe gathering budget snapshot. Does not own creds. |
| 4 | `src/core/account-swap.ts:536` | `runAccountSwapCheck` (force-fresh fallback candidate) | `false` (keep existing `force: true`) | Same. `force: true` skips the cache; that's orthogonal to OAuth refresh. |
| 5 | `src/verbs/whip.ts:903` (closure inside `runAccountSwapTickCheck`) | Adapter wrapping `defaultProbe` | `false` | Same rationale as #3. The wrapper passes through to `defaultProbe(account)` without forcing refresh. |
| 6 | `src/verbs/whip.ts:952` (closure inside `runSwapPassTickCheck`) | Adapter wrapping `defaultProbe` for `probeTarget` | `false` | Same. |

Each call goes from e.g. `defaultProbe(account)` to `defaultProbe(account, { refreshOnNearExpiry: true })` (daemon paths) or stays as-is (default `false` — the migration is implicit for the rest).

The **`AccountSwapCheckDeps.probeBudget`** signature already accepts `opts?: { force?: boolean }`. Extend it to `opts?: { force?: boolean; refreshOnNearExpiry?: boolean }` so the test fakes get type-safety on the new flag too.

### D3 — Regression test plan

Two unit tests in `tests/unit/abstractions/budget-probe.test.ts`:

1. **Test: `refreshOnNearExpiry` defaults to false.**
   Setup: credentials with `expiresAt: now()+30s` (well inside the 60s margin), valid `refreshToken`. Inject a fake `oauthRefreshUrl` that records calls.
   Call: `probeBudget("test", { atmuxDir, homeDir })` (no flag).
   Assert: `oauthRefreshUrl` was NEVER called. Probe was called directly with the existing `accessToken`. Result reflects whatever the probe responded.

2. **Test: `refreshOnNearExpiry: true` preserves Fix-C semantics (regression-pin existing behaviour).**
   Setup: same as #1.
   Call: `probeBudget("test", { atmuxDir, homeDir, refreshOnNearExpiry: true })`.
   Assert: `oauthRefreshUrl` WAS called once. `credentials.json` on disk has the new tokens. Probe was called with the new accessToken.

3. **Test: 401 retry path also gated.** Setup: credentials with `expiresAt: now()+1h` (NOT near-expiry). Probe upstream returns 401.
   Call A: `probeBudget("test", { ... })` (default `false`) → assert `oauthRefreshUrl` NEVER called; result is `probe-401` with error "probe 401 — refreshOnNearExpiry disabled" (or similar).
   Call B: `probeBudget("test", { ..., refreshOnNearExpiry: true })` → assert single 401-retry refresh fires (existing Fix-C behaviour).

4. **Test: caller-migration regression in `account-swap.ts`.** Add a test at `tests/unit/core/account-swap.test.ts` asserting the injected `probeBudget` fake receives `refreshOnNearExpiry !== true` (i.e. `false` or undefined) on every call. Pin the call-site contract.

5. **Test: caller-migration regression in `whip-budget-check.ts`.** Add a test at `tests/unit/core/whip-budget-check.test.ts` asserting the injected fake receives `refreshOnNearExpiry: true`. Pins the daemon path stays Fix-C-on.

No e2e changes needed — the existing budget-pause e2e still covers end-to-end whip behaviour, and the unit tests cover the spawn-time race in isolation.

### D4 — Branch + commit strategy

Single PR, single commit. The five caller migrations are mechanical and tightly coupled to the new opt; splitting risks landing only the opt without flipping the daemons (silent regression of Fix-C). One commit is the smallest unit of correctness here.

Branch: `geoyws` (current). Commit message:

```
fix(budget-probe): make OAuth refresh opt-in to fix cockpit-rebuild TUI race (ADR-078)

probeBudget defaulted to refreshing tokens when expiresAt < now+60s, which
atomic-rewrote .credentials.json. Anthropic rotates refreshToken server-side
on every refresh, which 401's any other process (e.g. just-spawned claude
TUIs) holding the old refreshToken in memory.

Add `refreshOnNearExpiry: boolean` opt (default false). Only daemon paths
that own the credentials lifecycle (whip-budget-check, whip-resume-check)
opt in. account-swap + future spawn-time probes stay read-only.

Refs: ADR-078, dispatch-p0-oauth-race
```

### D5 — Rollback plan

If the migration regresses Fix-C semantics in production (whip daemon starts 401-ing), revert is a single-commit `git revert <SHA>`. The opt is purely additive; reverting restores the old "always refresh on near-expiry" behaviour. No state migration, no data loss path.

If only ONE caller proves wrong (e.g. account-swap genuinely needs Fix-C and we underestimated), flip just that site's flag to `true` in a follow-up commit. The opt-in design makes per-caller tuning a one-line change.

### D6 — Adjacent: `atmux start` skipping `C-\` prefix

The brief flagged a separate symptom: `atmux start unum` did NOT set the `C-\` prefix that ADR-018 mandates. sopx + atmux cages got `C-\` correctly during their starts; unum landed on tmux default `C-b`. Workaround already in place (manual prefix-set from the cockpit-superdriver).

This is **not in scope for ADR-078** — independent root cause, independent fix surface. Suspected lane: `src/verbs/start.ts` or its tmux-config helper, conditional on team.json shape. Recommend dispatching as parallel investigation:

- Owner: `parity-cron-impl` (window 7) OR `up-impl` (window 6) — `up-impl` is the lifecycle lane (= `atmux start` ownership) and the better fit. **Recommend `up-impl`.**
- Deliverable: bisect what differentiates unum's team.json from sopx/atmux. Likely candidates:
  - missing field that gates the prefix-set step
  - first-cage-in-cockpit ordering race (was unum the first cage spawned?)
  - `singleSession: false` interacting with prefix initialisation
- Fix: separate ADR if behaviour was intentional, or single-commit fix-and-test if it's an oversight.

## Member-dispatch recommendation

| Role | Dispatch to | Window | Why |
|------|-------------|--------|-----|
| Implementer (this ADR) | `whip-impl` | window 5 | Error-class lane explicitly owns `budget-probe.ts` (last commit on the file is part of R1-T1). Touches `core/whip-budget-check.ts`, `core/account-swap.ts`, `verbs/whip.ts`, `verbs/whip-resume-check.ts` — all in-lane. |
| Adjacent C-\ prefix bug | `up-impl` | window 6 | Lifecycle lane = `src/verbs/start.ts` ownership. Independent lane; runs in parallel without conflicting on files with whip-impl. |

## Test strategy summary

- 3 unit tests in `tests/unit/abstractions/budget-probe.test.ts` (default-off / opt-in / 401 retry gate).
- 1 unit test in `tests/unit/core/account-swap.test.ts` pinning `refreshOnNearExpiry !== true` on every call.
- 1 unit test in `tests/unit/core/whip-budget-check.test.ts` pinning `refreshOnNearExpiry === true` on the daemon call.
- No e2e changes; existing `tests/e2e/budget-pause.test.ts` continues to cover end-to-end whip behaviour with the daemon path's Fix-C still active.
- **Bun test guard reminder:** per CLAUDE.md / memory, `bun test` crashes Claude's cage in the atmux repo. Implementer must run via the project's existing test guard (vitest under the wrapper), not `bun test` directly.

## Links

- `src/abstractions/budget-probe.ts:131` — `probeBudget` entry.
- `src/abstractions/budget-probe.ts:183-208` — Branch 1 Fix-C (pre-probe refresh).
- `src/abstractions/budget-probe.ts:215-231` — Branch 2 Fix-C (single 401 retry).
- `src/core/whip-budget-check.ts:176` — daemon caller (flip to `true`).
- `src/verbs/whip-resume-check.ts:192` — daemon caller (flip to `true`).
- `src/core/account-swap.ts:519,536` — one-shot caller (default `false`).
- `src/verbs/whip.ts:903,952` — adapter callers (default `false`).
- ADR-053 — original Fix-C / OAuth refresh introduction.
- `/root/.claude/teams/atmux/dispatch-p0-oauth-race.md` — origin brief.
- `/root/.claude/teams/atmux/driver-inbox.md` [07:48 MYT 2026-05-09] — original superdriver entry.
