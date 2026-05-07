# ADR-054: Zod schema for `whip` sub-config + per-tick validation + drift surface

**Status:** proposed
**Date:** 2026-05-07
**Owner:** planner

## Context

Driver-inbox 08:38 MYT 2026-05-07 (Ask 5.1): per-tick Zod validation of `team.json::whip` block. Currently `src/schema/team.ts` has `whip: z.unknown()` — passthrough, no shape, no drift detection. When operator edits team.json (intentionally or accidentally) with an invalid shape, whip silently uses `undefined` for missing fields and crashes when accessing nested keys. The driver wants:

- Per-tick validation pass.
- Safe-default fallback on validation failure (not a tick crash).
- `[whip-config-drift]` Discord ping with dedup-by-hash so consecutive ticks on the same drift don't spam.

This ADR is the smallest of the three Ask-5 ADRs; tight scope = ~30 LOC + Zod schema + 4 bats cases.

ADR-053 also depends on this — its budget thresholds + warning bands MUST live in a typed `whip` block, not `z.unknown()`.

## Decision

### D1 — Tighten `team.json::whip` to a structured Zod object

Replace `whip: z.unknown().optional()` in `src/schema/team.ts` with:

```ts
export const TeamWhip = z
  .object({
    intervalMins: z.number().int().positive().default(5),
    staleMin: z.number().int().nonnegative().default(90),
    leadMaxMin: z.number().int().positive().default(60),
    autoRotate: z.boolean().default(false),

    // ADR-049 / ADR-053 budget knobs
    budgetPauseThreshold: z.number().int().min(0).max(100).default(90),
    budgetResumeThreshold: z.number().int().min(0).max(100).default(80),
    budgetWarningBands: z.array(z.number().min(0).max(1)).default([0.50, 0.25, 0.15]),
    budgetRefreshLeadMins: z.number().int().nonnegative().default(30),
    claudeAccount: z.string().optional(),

    // ADR-043 (deprecated under R1; preserved for back-compat reads only)
    autoStopAfterIdleTicks: z.number().int().nonnegative().default(0),

    // ADR-055 self-heal opt-in
    selfHealEnabled: z.boolean().default(false),
    selfHealRecipes: z.array(z.string()).default([]),

    // ADR-056 account-swap opt-in
    accountFallback: z.array(z.string()).default([]),
    accountSwapTriggerThreshold: z.number().int().min(0).max(100).default(75),
  })
  .strict();
export type TeamWhip = z.infer<typeof TeamWhip>;
```

Update the parent `Team` schema's `whip` field to `TeamWhip.optional()`.

**Why `.strict()`:** drift detection requires unknown-key rejection. Passthrough at this level would mask typos (e.g. `whip.budgetPauseTreshold` — note the typo — falls through silently with passthrough; strict catches it).

### D2 — Per-tick validation in whip + safe fallback

In `src/verbs/whip.ts`'s tick entry (after `getAtmuxDir` + before any whip body work):

```ts
const teamRaw = await readTextOrNull(teamJsonPath);
const teamParsed = Team.safeParse(JSON.parse(teamRaw ?? "{}"));
let team: Team;
let driftReport: DriftReport | null = null;

if (teamParsed.success) {
  team = teamParsed.data;
} else {
  driftReport = composeDriftReport(teamParsed.error, teamRaw ?? "");
  team = Team.parse(makeDriftSafeDefaults(JSON.parse(teamRaw ?? "{}")));
}

if (driftReport) {
  await maybeFireDriftPing(driftReport, atmuxDir);
}
```

`makeDriftSafeDefaults` strips invalid keys + applies Zod defaults to missing required keys via deep-merge with the schema's default-shape. Returns a parseable shape — never throws.

**Drift report shape:**

```ts
interface DriftReport {
  driftHash: string;        // sha256 of canonical issue list
  issues: Array<{
    path: string[];          // e.g. ["whip", "budgetPauseThreshold"]
    code: string;            // Zod issue code
    message: string;
  }>;
  rawSnippet: string;        // ≤500 chars, masking secrets per ADR-008 chunker convention
}
```

`composeDriftReport` extracts up to 5 issues + computes hash from canonical sorted issue list. Dedup state file `.atmux/state/whip-config-drift-state.json`:

```jsonc
{ "<driftHash>": <epoch-of-last-fire> }
```

`maybeFireDriftPing`:
- If `driftHash` not in state file: fire `[whip-config-drift]` Discord, write state.
- If `driftHash` already present AND `<24h ago`: skip (dedup).
- If `<24h passed since last fire`: re-fire (operator may have forgotten).

### D3 — `[whip-config-drift]` Discord template

```
🔧 [whip-config-drift] · `<team>` · HH:MM MYT
  • ⚠️ team.json::whip validation failed — using safe defaults
  • 📍 issues: 3 (1 unknown_key, 2 invalid_type)
  • 🔍 first: whip.budgetPauseTreshold (unknown_key, did you mean budgetPauseThreshold?)
  • 🛠️ fix: edit team.json + re-run atmux doctor
  • 📜 driftHash: a3f2c814 (re-pings if changes)
```

Add `"whip-config-drift"` to `DiscordEventType` union in `src/abstractions/discord.ts`.

### D4 — Doctor integration

`src/verbs/doctor.ts` adds a finding when team.json fails Zod validation. Severity P3 (drift, not breakage — whip handles it gracefully). Same drift report shape; surfaces in `atmux doctor` output for operator triage WITHOUT needing to wait for next whip tick.

### D5 — Test coverage

Per CLAUDE.md TestingDiscipline:

- `tests/unit/schema/team.test.ts` (extend) — TeamWhip Zod schema accepts valid shape; rejects unknown key (strict); applies defaults on missing keys.
- `tests/unit/verbs/whip.test.ts` (extend) — 4 cases: valid shape (no drift), missing optional field (default applied, no drift), type mismatch (drift fired, safe default used), malformed JSON (catastrophic drift, full-defaults fallback).
- `tests/unit/state/whip-config-drift-state.test.ts` — hash dedup, 24h re-fire window, multi-drift sequencing.
- `tests/unit/verbs/doctor.test.ts` (extend) — drift finding renders.

## Consequences

- **Operator typos surface fast.** Today: silent fallthrough + crash. After: drift ping within 5min of next whip tick + doctor surfaces immediately.
- **ADR-053 + ADR-055 + ADR-056 can rely on typed `whip` config.** Phase 5 / future verbs reading whip-area config get type safety without each adding their own ad-hoc validation.
- **Back-compat preserved for `autoStopAfterIdleTicks`.** Field stays in schema (default 0); whip helper early-returns regardless per eternal-improvement Mode B + budget-pause supersession. Doctor warns when value > 0 (informational; no behavior change).
- **Reverse migration cost ~zero.** Strict mode rejects unknown keys; if the schema misses a field operators are using, it shows as drift with the exact path. Operator either edits team.json to remove the unused key, or porters extend the schema. Either way, drift is the early-warning mechanism.

## Considered alternatives

### A. `.passthrough()` instead of `.strict()`

Discarded — no drift detection, defeats the ADR's purpose. The whole point is unknown-key surfacing.

### B. Validation in `core/common.ts::requireTeam` instead of whip-tick

Discarded — `requireTeam` runs in EVERY verb's prelude (status, send, claim, etc.). Drift-ping spam if every read fails identically. Whip-tick is the right cadence: once per 5min, with dedup.

### C. Auto-fix drift via `atmux doctor --fix`

Discarded for v1 — automated config edits without operator review are too risky. Doctor surfaces the drift; operator fixes. ADR-055's cursor self-heal could later add `fix:team-json-schema-drift` as an opt-in recipe (already in 5.2's whitelist).

## Open questions

### OQ-1 — `intervalMins` enforcement (low reversibility)

If operator sets `intervalMins: 1` but cron is installed at `*/5`, the schema-side value is moot — cron's the authority. Recommended: validate `intervalMins` matches the installed cron line on doctor pass; warn on mismatch. Out of scope for this ADR; surface in ADR-054's open-questions for future doctor work.

### OQ-2 — Drift-hash collision (very low rev)

Two genuinely-distinct drifts could in theory hash-collide (sha256 truncated to 8 hex). Recommended: keep full sha256; truncate only in Discord display. Trivial to flip.

### OQ-3 — Parsing of pre-existing `team.json` files (low reversibility)

Live `team.json` files in fleet teams (sopx, atmux, unum) may already use `z.unknown()` shapes that don't pass strict validation. Migration: ADR-054 land + dispatch a fleet-wide `atmux doctor` + driver-supervised update of each team.json. NOT a code concern — operator action. Document in HANDOFF.

## Termination signals

`proposed → accepted` flip is gated on:

- Reviewer-gate per commit.
- Drift detection observed live on a synthetic test (intentionally-broken team.json triggers drift ping with safe-default fallback).
- ADR-053 implementation Tasks have a typed `team.whip` to read against.
