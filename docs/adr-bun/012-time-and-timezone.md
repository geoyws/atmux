# ADR-012: Time + timezone handling (MYT discipline, UTC internals)

**Status:** accepted
**Date:** 2026-05-04
**Owner:** architect

## Context

CLAUDE.md global conventions are explicit on three timezone+duration rules:

> **Timezone**: All user-facing timestamps are MYT (`Asia/Kuala_Lumpur`, UTC+8) with explicit suffix. Never bare times like "03:44" — always "03:44 MYT".

> **Duration formatting**: User-facing durations are compact human-readable, never raw minutes. `<60m` → `Nmin` (e.g. `47min`). `≥60m` → `HhMm` or just `Hh` if on the hour (e.g. `6h45m`, `2h`, `25h49m`). No day units — 48h is `48h`, not `2d`. Drop `m` when minutes==0.

> Hax box's system clock is typically UTC. **I'm always in Kuala Lumpur, even when SSHing into hax.** Never let hax's UTC clock leak into chat output, commit messages, or review docs as a bare "03:44" — always "11:44 MYT".

Bash atmux today uses `TZ='Asia/Kuala_Lumpur' date +'%H:%M MYT'` in `lib/common.sh:atmux::now_myt()`, scattered raw `date +%s` for epoch storage, and relies on per-call-site discipline for duration formatting. This works well *when the discipline holds*. The TS port hardens the discipline into a typed abstraction with reviewer regex enforcement, so bare timezones can't leak.

The TS port has the same shape: epoch-ms internals, MYT-formatted user-facing output, compact human-readable durations.

## Decision

### `src/abstractions/time.ts` is the only module that uses `Intl.DateTimeFormat`, `Date.toLocale*`, or duration formatting

```ts
// src/abstractions/time.ts
const MYT_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kuala_Lumpur",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const MYT_DATETIME = new Intl.DateTimeFormat("en-CA", {       // YYYY-MM-DD ergonomic
  timeZone: "Asia/Kuala_Lumpur",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});

// ----- Clock -----

let _now: () => number = () => Date.now();   // injectable for tests

export function now(): number { return _now(); }
export function setNow(fn: () => number): void { _now = fn; }
export function resetNow(): void { _now = () => Date.now(); }

// ----- Formatters -----

/**
 * "HH:MM MYT" — the canonical user-facing time format.
 * Example: formatMyt(1714895040000) → "11:44 MYT"
 */
export function formatMyt(epochMs: number = now()): string {
  return `${MYT_TIME.format(epochMs)} MYT`;
}

/**
 * "YYYY-MM-DD HH:MM:SS MYT" — for log lines, review-doc filenames.
 * Example: formatMytFull(1714895040000) → "2026-05-04 11:44:00 MYT"
 */
export function formatMytFull(epochMs: number = now()): string {
  // en-CA gives "YYYY-MM-DD, HH:MM:SS"; we strip the comma.
  return `${MYT_DATETIME.format(epochMs).replace(", ", " ")} MYT`;
}

/**
 * Compact human-readable duration per CLAUDE.md rules.
 * <60m  → "Nmin"   (e.g. "47min")
 * ≥60m  → "HhMm"   or just "Hh" if minutes==0 (e.g. "6h45m", "2h", "25h49m")
 * No day unit. Sub-minute rounds to "1min" (never "0min" for non-zero).
 */
export function formatDuration(ms: number): string {
  if (ms < 0) return formatDuration(-ms);
  const totalMin = Math.max(1, Math.round(ms / 60_000));
  if (totalMin < 60) return `${totalMin}min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}
```

### Internal storage convention — epoch ms only

- All timestamps in JSON state files are **epoch milliseconds** (number). Schemas (ADR-005) declare them as `z.number().int().positive()` with field name suffix `*At` or `*Ms` (e.g. `createdAt`, `lastSeenAt`, `bootedMs`).
- Never store local-formatted strings (`"11:44 MYT"`) in JSON. Strings are display-only.
- Never store ISO 8601 strings (`"2026-05-04T11:44:00+08:00"`) in JSON. Numbers are smaller, comparable, sortable, and don't have timezone-suffix ambiguity.
- Migrating: bash atmux uses `date +%s` (epoch seconds) in some places. ADR-005 schema validators multiply by 1000 on read if the value is < 10^11 (heuristic for "this looks like seconds, not ms"); writes always use ms going forward.

### MYT formatting via `Intl.DateTimeFormat`

The cached `MYT_TIME` and `MYT_DATETIME` formatters are built once at module load. `Intl.DateTimeFormat` is fast on Bun (no per-call `tz database` resolution). Using `en-GB` for time-only output gives `HH:MM` 24-hour without locale variance; `en-CA` for full date gives ISO-like `YYYY-MM-DD HH:MM:SS`.

**Why `Intl` and not a date library (date-fns / luxon / dayjs / temporal):** Bun ships the full ICU; `Intl` does what we need with zero deps. The Temporal proposal isn't stage-4 yet; date-fns is good but adds a dep we don't need for two formatters.

### Test injection

`setNow(fn)` replaces the clock for unit tests. Tests reset with `resetNow()` in `afterEach`:

```ts
// tests/unit/abstractions/time.test.ts (excerpt)
import { setNow, resetNow, formatMyt, formatDuration } from "../../../src/abstractions/time";

test("formatMyt renders MYT with explicit suffix", () => {
  setNow(() => Date.UTC(2026, 4, 4, 3, 44));   // 03:44 UTC = 11:44 MYT
  expect(formatMyt()).toBe("11:44 MYT");
});

afterEach(() => { resetNow(); });

test("formatDuration drops m when minutes==0", () => {
  expect(formatDuration(2 * 3600_000)).toBe("2h");
  expect(formatDuration(6 * 3600_000 + 45 * 60_000)).toBe("6h45m");
  expect(formatDuration(25 * 3600_000 + 49 * 60_000)).toBe("25h49m");
  expect(formatDuration(47 * 60_000)).toBe("47min");
  expect(formatDuration(48 * 3600_000)).toBe("48h");      // no day unit
});
```

ADR-009 (test strategy) declares `bun:test` lifecycle resets between tests — `resetNow()` is on the test author, not auto-magic.

### Reviewer rules

- **R5.** Forbid `new Date().toLocaleString()` / `.toLocaleDateString()` / `.toLocaleTimeString()` outside `src/abstractions/time.ts`. (Custom lint regex.)
- **R5a.** Forbid `Intl.DateTimeFormat` outside `src/abstractions/time.ts`. (Custom lint regex.)
- **R5b.** Forbid bare `${minutes}min` / `${seconds}s` / `${hours}h` template construction outside `time.ts`. Domain code calls `formatDuration(ms)`.
- **R5c.** Forbid log lines / Discord output / review-doc filenames containing bare `HH:MM` without `MYT` suffix. Detected by regex `\b\d{2}:\d{2}\b(?!\s*MYT)` over markdown + TS string literals; trades false positives for absolute compliance. Reviewer applies judgment for false positives (port numbers `:80`, `:443`, etc.).

These regexes are part of `scripts/lint-discipline.ts` (ADR-006). CI fails any commit that violates.

### Logger integration

`spawn.ts` (ADR-007) and other logger-using code prefix log lines with `formatMytFull()`. Log shape:

```
2026-05-04 11:44:00 MYT [whip atmux-bun lead] spawn: tmux send-keys -t … → exit 0 in 12ms
```

This matches CLAUDE.md log-prefix conventions and PLAN.md §10 logger note.

### Day-unit ban

CLAUDE.md is explicit: no day units. `48h` not `2d`. `formatDuration` never emits `d`. The reasoning is that "2d" is mentally translated to "48h" anyway when reasoning about uptime / streaks; eliding the translation step makes the unit grammatically uniform with `Nh / Nh:M / Nmin`.

### Sub-minute rounding

Sub-minute durations round up to `1min`. `formatDuration(30_000)` → `"1min"`. The CLAUDE.md spec's smallest example is `47min`; we don't go finer for user-facing display. Internal logging of sub-minute durations (e.g. `spawn` reports `12ms`) doesn't go through `formatDuration` — it formats numbers directly.

## Consequences

**Positives:**

- MYT discipline is mechanical, not aspirational. Reviewer regex catches every bare timezone leak before the commit lands.
- One module owns timezone + duration formatting. Future spec changes (e.g. internationalisation in v3) touch one file.
- Test injection (`setNow`) means time-dependent code is deterministic; no flaky tests.
- Epoch-ms storage is uniform across JSON files; cross-file comparisons (e.g. "was the last whip after the last dispatch?") are subtraction.
- `Intl.DateTimeFormat` is zero-dep, full ICU, fast.
- Day-unit ban makes durations greppable: `grep -E '\b\d+h\d*m?\b'` matches every duration in logs.

**Negatives:**

- Operators in non-MYT timezones reading raw output may find MYT-only display jarring. Documented as "atmux output is MYT, regardless of operator's TZ" in README; we're not internationalising this in v1.
- Test authors must remember to call `resetNow()` in `afterEach`. ADR-009 declares this in the test-author guide; missed reset shows as flaky time-dependent test.
- Duration regex in lint may have false positives on port numbers (`:80`, `:443`) and on log lines that already have `MYT` but with non-standard spacing. Reviewer adjudicates.
- ICU is part of Bun's bundle; if we ever move to Bun's `--target=bun-baseline` (no-ICU build), we lose `Intl.DateTimeFormat`. Not a v1 concern; documented in foundation porter's notes.

**Follow-up tickets:**

- Foundation porter (Phase 1) implements `src/abstractions/time.ts` per the sketch + tests.
- Foundation porter writes the R5/R5a/R5b/R5c lint regexes into `scripts/lint-discipline.ts`.
- Schema porter (Phase 2): every existing bash JSON file with `*_at` / `*Sec` / `*_epoch` field gets normalized to `*At` (epoch ms) in the v1 schemas.
- Reviewer: at v1 cutover, run `git grep -E '\b\d{2}:\d{2}\b(?!\s*MYT)' src/ docs/` once over the whole TS tree as a sanity sweep.

## Alternatives considered

### A. Use `date-fns` or `dayjs` for formatting

Rejected. We need two formatters (`HH:MM MYT`, `YYYY-MM-DD HH:MM:SS MYT`) and one duration helper. `Intl.DateTimeFormat` does the formatting; the duration helper is ~10 LOC. Adding a 4-figure-line dep for two formatters is a tax.

### B. Use Temporal proposal (`Temporal.ZonedDateTime`)

Considered, attractive. Stage 3 as of mid-2025. Bun has partial support behind a flag. Rejected for v1: we ship in 2026 and want production-stable APIs. Revisit at v2 — the formatter implementations can swap to Temporal without changing the public API of `time.ts`.

### C. ISO 8601 strings in JSON instead of epoch ms

Rejected. ISO strings are larger, slower to compare, and have timezone-offset rendering ambiguity. Epoch ms is uniform, comparable, and consistent.

### D. Allow each verb to format its own timestamps

Rejected. CLAUDE.md "Never let hax's UTC clock leak into chat output" requires structural enforcement. Per-verb formatting is exactly the discipline-without-structure pattern bash atmux already does and that this ADR is hardening.

### E. Locale-detect the user's timezone via `Intl.DateTimeFormat().resolvedOptions().timeZone`

Rejected. CLAUDE.md is explicit: MYT is the timezone. No detect-and-display. Operator's local clock is irrelevant to atmux output (they're "always in Kuala Lumpur, even when SSHing into hax").

### F. Day units in long durations (e.g. "2d3h")

Rejected. CLAUDE.md is explicit: no day units. `48h` not `2d`. Discussion settled.

## References

- CLAUDE.md global conventions §"Timezone", §"Duration formatting"
- CLAUDE.md "Session-start detection" — hax UTC clock vs MYT user-facing
- PLAN.md §3 (constraints — MYT discipline)
- ADR-003 (module taxonomy — `time.ts` is one of 8 abstractions)
- ADR-006 (error handling — no time-related errors; `time.ts` is pure)
- ADR-007 (spawn pattern — logger uses `formatMytFull` for log line timestamps)
- ADR-008 (discord — header uses `formatMyt`)
- ADR-009 (test strategy — `setNow` / `resetNow` test pattern)
- bash `lib/common.sh` `atmux::now_myt` — current implementation matched
