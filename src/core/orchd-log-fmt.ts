// e-12-640853f3 §S2 + §S3 — human-readable sweep formatter + emoji/timestamp prefix.
//
// Replaces the 10KB-per-tick JSON dump in orchd.log with a single
// summary line + only-interesting per-epic detail lines. Operators
// scanning the orchd pane see verdicts at a glance instead of
// scrolling through 75 raw UUIDs.
//
// Machine consumers (cockpit-mirror, future telemetry) get the JSON
// shape via the orchd verb's `--json` flag — same data, different
// rendering.

import type { SweepResult } from "./orchd-merge-sweep.ts";

/** ISO-ish local-timestamp prefix per ADR-029 §F8 / global CLAUDE.md
 *  timestamp rule (MYT with TZ suffix). */
export function isoLocalTs(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  // Server runs UTC; format `HH:MM UTC` then operators read it as
  // wall clock. Full ISO is too long for per-line prefix budget.
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

/** Prefix every line with `[ts] [emoji] [scope]` so operators scanning
 *  the pane can grep + classify at a glance. */
export function logLine(emoji: string, scope: string, msg: string, ts?: string): string {
  const t = ts ?? isoLocalTs();
  return `[${t}] ${emoji} ${scope} ${msg}`;
}

/** Render the sweep result as a one-line summary + only-interesting
 *  detail lines (dispatch verdicts; suppressed for skip-only runs).
 *  When nothing was dispatched + nothing errored, this is a single
 *  line — the operator sees `[ts] 🧭 sweep ok — 75 epics, 0 ready`
 *  instead of 10KB of repeated 'no tasks or stories'.
 *
 *  Operators reading this for the first time grok the legend:
 *    🧭 sweep tick start / end
 *    ✅ dispatched-merged
 *    🟡 dispatched-gate-held (operator-actionable; needs decision)
 *    💤 skipped (attended / not-ready / already-merged)
 *    🔴 errored (orchd-internal fault; investigate immediately)
 *
 *  The reason summary collapses repetitive skip-reasons (e.g. "60×no-
 *  decomp, 15×in-planning") so a fleet with hundreds of epics doesn't
 *  spam the log. */
export function formatSweepReport(result: SweepResult, ts?: string): string {
  const t = ts ?? isoLocalTs();
  const lines: string[] = [];

  // Header line — always present, always short.
  const headerEmoji = result.epicsErrored > 0
    ? "🔴"
    : result.epicsDispatchedMerged > 0
      ? "✅"
      : result.epicsDispatchedGateHeld > 0
        ? "🟡"
        : "🧭";
  const verdict =
    result.epicsDispatchedMerged > 0
      ? `${result.epicsDispatchedMerged} merged`
      : result.epicsErrored > 0
        ? `${result.epicsErrored} errored`
        : result.epicsDispatchedGateHeld > 0
          ? `${result.epicsDispatchedGateHeld} deferred`
          : "no action";

  // Skip-reason rollup — collapses repetitive entries like 60×"no tasks
  // or stories" → "60×no-decomp" so the summary stays one line even on
  // fleets with hundreds of epics.
  const skipRollup = rollupSkipReasons(result);
  const skipSuffix = skipRollup.length > 0 ? ` · skips: ${skipRollup}` : "";

  lines.push(
    `[${t}] ${headerEmoji} sweep · ${result.epicsConsidered} epics · ${verdict} · ` +
      `ready=${result.epicsDispatchedMerged + result.epicsDispatchedGateHeld + result.epicsDispatchedSkipped} ` +
      `attended=${result.epicsAttended} not-ready=${result.epicsNotReady} ` +
      `already-merged=${result.epicsAlreadyMerged}${skipSuffix}`,
  );

  // Per-epic detail — ONLY for dispatch verdicts (merged / gate-held /
  // errored). Skips are summarized in the rollup; including them per-
  // epic was the noise we set out to remove.
  for (const ep of result.perEpic) {
    if (
      ep.outcome === "skipped-attended" ||
      ep.outcome === "skipped-not-ready" ||
      ep.outcome === "skipped-already-merged" ||
      ep.outcome === "dispatched-skipped"
    ) {
      continue;
    }
    const emoji = outcomeEmoji(ep.outcome);
    const reasonSuffix = ep.reason !== undefined && ep.reason !== "" ? ` — ${ep.reason}` : "";
    lines.push(`[${t}] ${emoji} sweep:${ep.epicId} ${ep.outcome}${reasonSuffix}`);
  }

  return lines.join("\n");
}

/** Verdict emoji per per-epic outcome. */
function outcomeEmoji(outcome: SweepResult["perEpic"][number]["outcome"]): string {
  switch (outcome) {
    case "dispatched-merged":
      return "✅";
    case "dispatched-gate-held":
      return "🟡";
    case "dispatched-skipped":
      return "💤";
    case "skipped-attended":
    case "skipped-not-ready":
    case "skipped-already-merged":
      return "💤";
    case "errored":
      return "🔴";
  }
}

/** Bucket the per-epic skip reasons into a compact rollup string like
 *  `60×no-decomp, 15×in-planning`. Buckets known reason patterns first,
 *  then collapses tail into `N×other`. */
function rollupSkipReasons(result: SweepResult): string {
  const buckets = new Map<string, number>();
  let other = 0;
  for (const ep of result.perEpic) {
    if (
      ep.outcome !== "skipped-attended" &&
      ep.outcome !== "skipped-not-ready" &&
      ep.outcome !== "skipped-already-merged"
    ) {
      continue;
    }
    const r = (ep.reason ?? "").toLowerCase();
    if (r.includes("no tasks or stories")) {
      buckets.set("no-decomp", (buckets.get("no-decomp") ?? 0) + 1);
    } else if (r.includes("story status=planning") || r.includes("task status=planning")) {
      buckets.set("in-planning", (buckets.get("in-planning") ?? 0) + 1);
    } else if (r.startsWith("story status=") || r.startsWith("task status=")) {
      // e.g. story status=ready / review / in-progress
      const m = /(?:story|task) status=([\w-]+)/.exec(r);
      const k = m ? `${m[1]}` : "in-progress";
      buckets.set(k, (buckets.get(k) ?? 0) + 1);
    } else if (r.includes("in-progress task")) {
      buckets.set("attended-inprogress", (buckets.get("attended-inprogress") ?? 0) + 1);
    } else if (r.includes("grace window")) {
      buckets.set("attended-grace", (buckets.get("attended-grace") ?? 0) + 1);
    } else {
      other += 1;
    }
  }
  const parts: string[] = [];
  for (const [k, n] of buckets) parts.push(`${n}×${k}`);
  if (other > 0) parts.push(`${other}×other`);
  return parts.join(", ");
}
