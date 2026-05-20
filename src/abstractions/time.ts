// ADR-012: Time + timezone handling (MYT discipline, UTC internals).
//
// The ONLY module that uses `Intl.DateTimeFormat` / `Date.toLocale*` /
// duration formatting. R5/R5a/R5b/R5c (per ADR-006 + ADR-012) forbid raw
// time formatting outside this file.
//
// Internal storage is epoch milliseconds (number). User-facing rendering
// is MYT (`Asia/Kuala_Lumpur`, UTC+8) with explicit `MYT` suffix.

const MYT_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kuala_Lumpur",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const MYT_DATETIME = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kuala_Lumpur",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const MYT_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kuala_Lumpur",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// ---------- Clock (test-injectable) ----------

let _now: () => number = () => Date.now();

/** Current epoch ms. Tests override via `setNow`. */
export function now(): number {
  return _now();
}

/** Replace the clock for unit tests; pair with `resetNow()` in `afterEach`. */
export function setNow(fn: () => number): void {
  _now = fn;
}

/** Restore the real clock. */
export function resetNow(): void {
  _now = () => Date.now();
}

// ---------- Formatters ----------

/**
 * "HH:MM MYT" — the canonical user-facing time format.
 * Example: `formatMyt(Date.UTC(2026, 4, 4, 3, 44))` → `"11:44 MYT"`.
 */
export function formatMyt(epochMs: number = now()): string {
  return `${MYT_TIME.format(epochMs)} MYT`;
}

/**
 * "YYYY-MM-DD HH:MM:SS MYT" — for log lines, review-doc filenames.
 * Example: `formatMytFull(...)` → `"2026-05-04 11:44:00 MYT"`.
 */
export function formatMytFull(epochMs: number = now()): string {
  // en-CA renders "YYYY-MM-DD, HH:MM:SS"; strip the comma.
  return `${MYT_DATETIME.format(epochMs).replace(", ", " ")} MYT`;
}

/** ISO 8601 UTC string with second precision — for internal logs only. */
export function nowIso(epochMs: number = now()): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * "YYYY-MM-DD" anchored on MYT — for date-bucketed paths
 * (`docs/release-notes/<Y>/<M>/<Y-M-D>.md` per ADR-147 §D4).
 * Example: a UTC instant at 2026-05-14 19:00Z is 2026-05-15 03:00 MYT,
 * so this returns `"2026-05-15"`.
 */
export function mytDate(epochMs: number = now()): {
  year: string;
  month: string;
  day: string;
  iso: string;
} {
  const parts = MYT_DATE.formatToParts(epochMs);
  const year = parts.find((p) => p.type === "year")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  return { year, month, day, iso: `${year}-${month}-${day}` };
}

/**
 * Compact human-readable duration per CLAUDE.md rules.
 * - `<60m` → `"Nmin"` (e.g. `"47min"`)
 * - `≥60m` → `"HhMm"` or `"Hh"` if minutes==0 (e.g. `"6h45m"`, `"2h"`, `"25h49m"`)
 * - No day units. Sub-minute rounds to `"1min"` (never `"0min"` for non-zero ms).
 * - Negative input is normalized to its absolute value.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "0min";
  const abs = Math.abs(ms);
  if (abs === 0) return "0min";
  const totalMin = Math.max(1, Math.round(abs / 60_000));
  if (totalMin < 60) return `${totalMin}min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

/**
 * Granular human-readable duration — d/h/m/s/ms units. Distinct from
 * {@link formatDuration} (which rounds-up to minute floor per CLAUDE.md
 * §Conventions). Use this for short-cycle log lines where sub-minute
 * precision matters (sentinel ticks 26ms-2min typical; tick health
 * latency observation; e2e step timings).
 *
 * Picks the two largest non-zero units for readability:
 *   - 750ms          → "750ms"
 *   - 26119ms        → "26s"
 *   - 5500ms         → "5s500ms" (sub-1s remainder kept when total < 1m)
 *   - 110484ms       → "1m50s"
 *   - 3600000ms      → "1h"
 *   - 3660000ms      → "1h1m"
 *   - 90061000ms     → "1d1h"
 *   - 0 / NaN / -ve  → "0ms"
 */
export function formatTickDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;

  const totalSec = Math.floor(ms / 1000);
  const remMs = Math.round(ms - totalSec * 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);

  if (totalMin === 0) {
    // <1 minute — keep ms tail if present so 5500ms reads "5s500ms"
    return remMs > 0 ? `${s}s${remMs}ms` : `${s}s`;
  }
  const m = totalMin % 60;
  const totalHour = Math.floor(totalMin / 60);
  if (totalHour === 0) {
    return s === 0 ? `${m}m` : `${m}m${s}s`;
  }
  const h = totalHour % 24;
  const d = Math.floor(totalHour / 24);
  if (d === 0) {
    return m === 0 ? `${h}h` : `${h}h${m}m`;
  }
  return h === 0 ? `${d}d` : `${d}d${h}h`;
}
