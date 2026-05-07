# ADR-053: Budget observability — probe port + OAuth refresh + warnings + auto-resume + history log

**Status:** proposed
**Date:** 2026-05-07
**Owner:** planner

## Context

Driver-inbox 08:12 + 08:07 + 08:38 MYT 2026-05-07 stream asks for a real budget-observability layer in the bun port: per-band warnings, refresh-soon pings, auto-resume cron precision, durable history log — plus Fix C (OAuth-401 refresh) folded in as a hard prerequisite.

**Critical scope realization under R1 (bun-first):**

The bun port's `src/verbs/whip.ts` carries NO budget probe today. ADR-022 §"Deferred per ADR-022" explicitly defers everything in this area: `_atmux_whip_check_audit`, brief-version cache, decisions/flags cursors, and (notably for this ADR) anything that would parse Claude Code's status-bar `5h N% / wk N%` line. Bash-side ADR-049 (Claude Max budget watcher) added that machinery to `lib/whip.sh` (~422 LOC across helpers + parser + state file + budget-pause flow) but no equivalent exists in bun.

Ask 4's sub-features (4.1–4.4) ASSUME a working budget probe. Under R1, this ADR cannot decompose 4.x in isolation — it has to scope **the bun-side port of ADR-049's probe machinery + Fix C's OAuth refresh + the four 4.x extensions** as one coherent landing.

Concretely, this ADR covers:

- **Probe port (ADR-049 → bun)** — pane-content status-bar parser; per-account probe with caching; budget-pause + budget-resume state flow.
- **Fix C — OAuth refresh** — read `accessToken + refreshToken + expiresAt` from `.credentials.json`; auto-refresh on expiry/401; surface stale-credential warnings to `atmux flags`.
- **4.1 — `[whip-budget-warning]` template + dedup state.**
- **4.2 — `[whip-budget-refresh-soon]` template + dedup state.**
- **4.3 — Auto-resume cron precision** — `atmux whip-resume-check` lightweight verb (Option B from the brief).
- **4.4 — Durable probe history log** — `.atmux/logs/budget-history.jsonl` append-on-every-probe.

Hard ordering: Fix C lands BEFORE 4.x. 4.x sub-features can land in parallel after Fix C.

The bash-side equivalents (in `/root/work/src/atmux/lib/whip.sh` + `lib/groom.sh`) are out of scope per the R1 pivot — bash atmux team inherits a port-back if bun-port team chooses to surface one, otherwise stays as is.

### Why bun-side budget probe instead of cross-cage state-file sharing

A cheaper alternative would be: have bash `lib/whip.sh` (atmux-geoyws) write `.atmux/state/budget-probe-<team>.json` and have bun-side whip just READ that file. Discarded because:

- Bash whip doesn't run inside this team's cron (the team's cron fires `bin/atmux whip` from the symlinked runtime, and the runtime's whip.sh DOES probe — but writes state in atmux-geoyws's checkout's `.atmux/`, not this worktree's). Cross-checkout state-file sharing is fragile + non-obvious + introduces an ordering dep on bash whip running first.
- ADR-013 §"Phase 5 ports the WIP" — the budget-watcher is exactly the kind of WIP whose port belongs in Phase 5. Doing it now under R1 is a deliberate Phase-5 pre-emption authorized by the driver pivot, NOT a casual scope inflation.
- Long-term: bun port replaces bash runtime. State-file sharing is a transitional crutch we'd remove anyway.

## Decision

### D1 — Port ADR-049's budget probe to bun, OAuth-refresh-aware from day one

`src/abstractions/budget-probe.ts` — new module:

```ts
export interface BudgetProbeResult {
  account: string;          // identity from .credentials.json filename or team.claudeAccount
  h5_pct_used: number;      // 0–100, integer
  wk_pct_used: number;      // 0–100, integer
  h5_reset_epoch: number;   // seconds since epoch
  wk_reset_epoch: number;
  status: "allowed" | "rejected" | "probe-401" | "probe-error" | "no-credentials";
  source: "probe" | "cache-hit";
  probedAt: number;         // epoch
  error?: string;           // only when status != "allowed"/"cache-hit"
}

export async function probeBudget(
  account: string,
  opts?: { force?: boolean; ttlSec?: number },
): Promise<BudgetProbeResult>;
```

State file: `.atmux/state/budget-probe-<account>.json` (matches bash convention so cross-runtime reads are byte-identical).

Probe flow:

1. Read `~/.<account>/credentials.json` (canonical Claude Code credentials path).
2. Extract `claudeAiOauth.accessToken` + `claudeAiOauth.refreshToken` + `claudeAiOauth.expiresAt`.
3. **OAuth refresh check (Fix C):**
   - If `expiresAt` < `now + 60s` (60s margin): fire refresh BEFORE the probe call.
   - Refresh: POST `https://api.anthropic.com/v1/oauth/token` with `grant_type=refresh_token`. Write new tokens back to `credentials.json` atomically (tmp+rename). 24h TTL on the new access token.
4. Probe call: GET `https://api.anthropic.com/v1/messages?…` (bash uses an inexpensive endpoint that returns rate-limit headers; replicate the exact endpoint to keep cost identical).
5. **401 handling:** if probe returns 401 with valid-looking token → assume token actually expired between step 3 + 4. Single retry with explicit refresh, then fail.
6. **Refresh failure handling:** if refresh itself returns 401/403 → write `status: "probe-401"` to cache; surface `atmux flags add` entry: `severity=p2 needs=context "OAuth refresh failed for account=<n>; user re-login needed"` (Fix C bonus per driver brief).
7. Write result to `.atmux/state/budget-probe-<account>.json` regardless of status (failures are observable).
8. Append history entry to `.atmux/logs/budget-history.jsonl` (D5).

Caching: `ttlSec` default 240 (matches bash). `force: true` skips cache.

### D2 — Whip-side budget-pause + budget-resume integration

`src/verbs/whip.ts` adds a per-tick budget check (re-enables ADR-022's deferred row in the §Deferred-row table):

- After per-member status check, if any member's `h5_pct_used` or `wk_pct_used` ≥ `team.json::whip.budgetPauseThreshold` (default 90 — i.e., ≤10% remaining): enter budget-pause.
- Pause flow mirrors bash: write `.atmux/state/budget-pause.json` (at-risk roster + timestamps); `atmux pause <member>` for every member; `atmux handoff` for checkpoint; driver-inbox entry; Discord `[whip-budget-pause]`.
- Resume gate (per tick when paused): ALL members `h5_pct_used` AND `wk_pct_used` ≤ `team.json::whip.budgetResumeThreshold` (default 80, i.e., ≥20% remaining on both). On resume: `atmux resume <member>` for every member, clear state file, driver-inbox entry, Discord `[whip-budget-resume]`.

**Hysteresis kept at 10pp** (matches bash). Configurable via team.json.

**Important coordination with eternal-improvement Mode B (T6, t-a3a0e5b1):** budget-pause supersedes eternal-improvement at the whip-tick level. If budget-pause is active, do NOT enter eternal-improvement Mode B; the team is already in a deliberate hold. The integration order is:
1. Budget-pause check (this ADR) — early-return if active.
2. Kanban-empty check (eternal-improvement Mode B).
3. Per-member regular checks.

This matches the rule "budget-pause is a deliberate hold, not idleness" from bash ADR-052 §D5.

### D3 — Discord trigger templates (4.1 + 4.2 + bundle)

Extend `src/abstractions/discord.ts` `DiscordEventType` union (line 39) with:

```ts
| "whip-budget-warning"
| "whip-budget-refresh-soon"
| "whip-budget-pause"        // already exists implicitly via whip-budget; rename for clarity
| "whip-budget-resume"
```

Templates (per CLAUDE.md Discord rules: header + bullets, ≤80 chars, MYT timestamp, named templates):

**4.1 — `[whip-budget-warning]`** (per band crossing):

```
⚠️ [whip-budget-warning] · `<team>` · HH:MM MYT
  • 💰 account: `<account>` — remaining 5h: NN% (band: 50%/25%/15%)
  • ⏱️ resets in: 4h53m
  • 👥 affected members: 3
  • 🔁 next band: 25%
```

Dedup state: `.atmux/state/budget-warning-state.json`:

```jsonc
{
  "<account>:5h:0.50": <epoch-of-fire>,
  "<account>:5h:0.25": <epoch-of-fire>,
  "<account>:wk:0.15": <epoch-of-fire>,
  ...
}
```

Reset semantics: on each window-reset epoch (h5_reset_epoch or wk_reset_epoch incrementing past previous probe), wipe entries for that `<account>:<window>:*`. Re-arms the bands for the new window.

**4.2 — `[whip-budget-refresh-soon]`** (per window-reset):

```
🌅 [whip-budget-refresh-soon] · `<team>` · HH:MM MYT
  • ⏱️ window resets in: 28min (5h)
  • 💰 account: `<account>` — remaining: 8%
  • 🔁 will auto-resume on refresh
```

Dedup state: `.atmux/state/budget-refresh-soon-state.json`:

```jsonc
{
  "<account>:5h:<resetEpoch>": <fire-epoch>,
  "<account>:wk:<resetEpoch>": <fire-epoch>
}
```

Per-`(account, window-id, resetEpoch)` keying — once that resetEpoch passes, the entry is moot; groom-side cleans entries with `resetEpoch < now`.

Lead-time configurable via `team.json::whip.budgetRefreshLeadMins` (default 30).

### D4 — Auto-resume cron precision (4.3) — Option B (recommended)

Add `src/verbs/whip-resume-check.ts` — a lightweight verb that ONLY runs:

1. Acquire `.atmux/state/whip-resume-check.lock` (non-blocking flock; skip on contention).
2. Probe each account's budget (D1, with cache TTL respected).
3. If `.atmux/state/budget-pause.json` shows active pause AND `_atmux_whip_budget_pause_should_resume` returns true: invoke the same resume code path as full whip's tick.
4. Append to `.atmux/logs/budget-history.jsonl` (D5).
5. Exit.

Cron line installed via `team start` (extends the 3-line block per `crontab markers (managed by atmux start/stop)` rule):

```cron
# >>> atmux:team=<n>
*/5 * * * * cd <project> && atmux whip
*/30 * * * * cd <project> && atmux report
0 */4 * * * cd <project> && atmux decisions digest
*/1 * * * * cd <project> && atmux whip-resume-check  # NEW
# <<< atmux:team=<n>
```

`whip-resume-check` is intentionally cheap: ~1 probe call per active account × 240s TTL → most ticks are pure cache reads. Cost: 1 extra cron line per team; negligible system load.

**Why not Option A (bump full-whip to */1):** full whip is ~80 LOC of sequential per-member checks, status-bar parsing, lock acquisition, and Discord composition. Running it 5× more often amplifies any future bugs and burns Discord noise (whip-progress + whip-blocker emit on every tick). Option B isolates the cheap path.

### D5 — Durable probe history log (4.4)

`.atmux/logs/budget-history.jsonl` — append-only JSON-line log. One line per probe attempt (success AND failure). Shape:

```jsonc
{
  "ts": 1778120000,
  "account": "icloud",
  "h5_util": 0.08,
  "wk_util": 0.42,
  "h5_reset": 1778137800,
  "wk_reset": 1778565000,
  "status": "allowed",      // | "rejected" | "probe-401" | "probe-error" | "no-credentials" | "cache-hit"
  "source": "probe",        // | "cache-hit"
  "tokenRefreshed": false   // true when this probe triggered a Fix C OAuth refresh
}
```

Append via `appendText` (existing `src/abstractions/fs.ts` helper). Lock via `.atmux/logs/budget-history.jsonl.lock` flock. Race-safe with multiple whip ticks (cron + whip-resume-check) probing concurrently.

Rotation: `groom` machinery — when `.atmux/logs/budget-history.jsonl` > 1MB, rename to `.log.1`, start fresh. Keep last N rotations per `groom`'s existing `--keep-bak` policy. `groom`'s bak-cull bug (driver mention 08:38 MYT side-note) is bash-side `lib/groom.sh` and OUT OF SCOPE for this ADR per R1.

Operator query path: `jq -c '.[]' .atmux/logs/budget-history.jsonl | grep '"account":"icloud"' | jq '.h5_util'` for ad-hoc charts. No new verb needed in v1; if heavy demand emerges, a `atmux budget-history --account <n> --since <timespec>` read-side verb folds into a follow-up.

### D6 — Configuration

`src/schema/team.ts` — extend the `whip` z.unknown() to a real Zod object (covered fully in ADR-054, the 5.1 zod whip-config ADR; this ADR depends on ADR-054 for type safety but doesn't itself author the schema). Fields used by ADR-053:

```jsonc
{
  "whip": {
    "budgetPauseThreshold": 90,        // % used — pause when ANY member ≥ this
    "budgetResumeThreshold": 80,       // % used — resume when ALL members ≤ this
    "budgetWarningBands": [0.50, 0.25, 0.15],  // remaining-fraction bands; descending
    "budgetRefreshLeadMins": 30,
    "claudeAccount": "icloud"          // primary account for this team
  }
}
```

If team.json fails Zod validation per ADR-054: fall back to inline defaults (90/80/[0.50,0.25,0.15]/30) AND fire `[whip-config-drift]` per ADR-054 §D2.

### D7 — Test coverage

Per CLAUDE.md TestingDiscipline (100% coverage, narrowed denominator, tests in same commit):

- `tests/unit/abstractions/budget-probe.test.ts` — probe flow, cache hit/miss, OAuth refresh on expiry, OAuth refresh on 401, refresh failure → flags entry, no-credentials.
- `tests/unit/verbs/whip.test.ts` (extend existing) — budget-pause entry/exit, hysteresis, eternal-improvement coordination order.
- `tests/unit/verbs/whip-resume-check.test.ts` — lock contention, probe + resume gating.
- `tests/unit/abstractions/discord.test.ts` (extend) — 4 new template renderers.
- `tests/unit/state/budget-warning-state.test.ts` — band-crossing dedup, window-reset wipe.
- `tests/unit/state/budget-refresh-soon-state.test.ts` — per-resetEpoch dedup.
- `tests/unit/logs/budget-history.test.ts` — append, lock contention, rotation handoff to groom.
- `tests/e2e/budget-pause.test.ts` — synthetic high-utilization scenario walks pause → resume; matches bash `tests/e2e/pause_resume.bats` shape so parity matrix can fold in later.

## Consequences

- **Bun port reaches parity with bash on budget observability.** ADR-049's machinery + the four ASK-4 extensions land together. Future budget-area work (Ask 5.3 account-swap) builds on this foundation.
- **OAuth-401 silent stale class is closed.** Currently 3 of 4 hax accounts are 401'd silently per driver brief. After this ADR, refresh is automatic; refresh-failure is loud (flags entry + Discord).
- **History log enables retro analysis.** Operators can answer "what was utilization at <time>" deterministically without scraping panes. Charts via jq + gnuplot.
- **Cron noise increases by 1 line per team.** Negligible system cost; major UX win on auto-resume granularity (1min vs 5min).
- **eternal-improvement Mode B integration is preserved.** Budget-pause supersedes Mode B at whip-tick level; no double-trigger risk.
- **Bash-side stays as-is.** Per R1 pivot, bash atmux team handles their own OAuth-401 (or doesn't); bun-port is now self-sufficient for budget observability.
- **Fix C bonus (flags surface).** OAuth refresh failure becomes operator-visible via `atmux flags list`. Closes a class of "why is budget data stale" mystery debugging.
- **Probe-401 + cache-hit failure loud-rather-than-silent.** Every probe writes to history.jsonl regardless of outcome — operators can grep for "probe-401" to count staleness occurrences.

## Considered alternatives

### A. Read bash whip's state file from cross-checkout

Discarded per §Context — fragile, non-obvious, introduces ordering dep, transitional crutch we'd remove anyway.

### B. ADR-052 (kanban-pause) port instead of ADR-049 port

Driver bias confirmed: bash ADR-052 (kanban-pause) is OBSOLETED by eternal-improvement Mode B. Reasoning:

- Both intercept the auto-stop trigger point. Mode B intercepts to LAUNCH improvement work; kanban-pause intercepts to SKIP whip body composition.
- Mode B is strictly more useful: it CONVERTS idle into productive token spend (improvement Tasks land + ship). Kanban-pause just defers the decision (cage stays up, no work happens, eventually still stops).
- Mode B + this ADR's budget-pause cover the full lifecycle: budget-pause halts when tokens drained; Mode B converts kanban-empty into work; when Mode B's budget exhausts AND kanban still empty, the original `atmux stop` path fires.
- ADR-052-bash's value-prop ("preserve warm context, don't kill cage") is delivered by Mode B's "loop until budget exhausts" — same outcome (cage stays up while budget remains), better UX (productive work).

**Recommendation:** do NOT port bash ADR-052 to bun. Document the call here. If post-implementation feedback shows Mode B has gaps that kanban-pause would fill, revisit.

### C. Single ADR covering Asks 4 + 5 (one mega-ADR)

Discarded — Ask 5 has three independent surfaces (zod config, cursor self-heal, account-swap). Bundling all into one ADR would (a) blow the size budget, (b) couple unrelated reviewer-gate cycles, (c) violate the lead's "split is fine" guidance in the dispatch. Asks 4 + 5 split into ADR-053 + ADR-054 + ADR-055 + ADR-056.

### D. Defer Fix C to its own ADR

Discarded — Fix C is a hard prerequisite for D1 (probe). Decoupling would require a stub probe that ignores OAuth refresh + a follow-up to retrofit it. Folding Fix C into D1 from day one is cheaper.

### E. Polling /v1/usage endpoint instead of status-bar parse

Anthropic's /v1/usage endpoint exists but isn't part of the official Max SDK contract. Bash whip uses status-bar parsing because the pane already shows the data; no API call needed. Bun port follows suit for consistency. If /v1/usage stabilizes, a v2 ADR can swap.

## Open questions

### OQ-1 — Probe endpoint identity (low reversibility)

Bash uses an inexpensive endpoint that returns rate-limit headers. Bun port should replicate the exact endpoint to keep cost identical. **Resolution required during impl** — porter reads `lib/whip.sh::_atmux_whip_probe_account_budget` for the exact URL + headers + payload, mirrors in TS. Trivially flippable.

### OQ-2 — `expiresAt` field name in `.credentials.json` (low reversibility)

Driver brief says `expiresAt` is "if present in the credentials shape" — implying not always present. Porter validates by reading a real `.credentials.json` first; if absent, fall back to "treat token as already-expired before every probe; refresh if 401" (slightly less efficient but always correct).

### OQ-3 — `whip-resume-check` cron line in already-running teams (low reversibility)

`atmux start` installs the 4-line block on team start. Existing teams (already started) won't auto-pick-up the new line. Migration path: `atmux team reconfigure` re-installs the cron block; document in HANDOFF + run on each fleet team after this ADR ships.

### OQ-4 — History log format — JSONL vs CSV (low reversibility)

JSONL keeps schema flexibility; CSV would be marginally easier for naive tools. Recommended JSONL. Trivial to flip.

### OQ-5 — Account identity convention (low reversibility)

Bash uses filename convention (`budget-probe-<account>.json`). What's `<account>`? Driver hints it's `icloud / unum / ifca / personal`. Resolution: `<account>` = the basename of `~/.<account>` directory the credentials live in; mirror bash. Document in budget-probe.ts header.

## Termination signals

`proposed → accepted` flip is gated on:

- Lead routes the four impl-Tasks; reviewer-gate signoff per commit.
- Fix C land first; 4.x sub-features land in parallel after.
- Bash ADR-052 (kanban-pause) confirmed obsolete by feedback after eternal-improvement Mode B ships (T6 reviewer signoff).

OQ-1 through OQ-5 are code-shape, resolve in-impl.
