// ADR-202 §Amendment 2026-05-22 (V) — `atmux relayd` top-level verb.
//
// Promotes the event-router persona to first-class CLI surface. Splits
// the verb tree to align with the persona separation:
//
//   committer (verb) — merge-related operations:
//     --sweep   (existing, ADR-134)   branch-walking auto-merger
//
//   relayd    (verb) — event-routing operations:
//     --start   (long-lived NOTIFY/LISTEN consumer, multi-topic
//                dispatcher — uses atmux-listener Rust subprocess)
//     --drain   (one-shot cron-backstop drain across all topics)
//     --once    (test ergonomics — exit after first batch)
//     --max-events N (test ergonomics — exit after N events)
//
// The legacy `committer --daemon` / `committer --drain` invocations
// remain as deprecated aliases for one release, emitting a deprecation
// warn so cron lines + operator scripts surface the rename ask.
// Removed cleanly next release.
//
// Implementation re-uses the existing `committerDaemonVerb` /
// `committerDrainVerb` bodies — this verb is just a renamed entry
// point. Wiring stays in `verbs/committer.ts` to avoid a churn-only
// move; this file is a thin dispatcher.

import {
  type CommitterOpts,
  committerDaemonVerb,
  committerDrainVerb,
} from "./committer.ts";
import { UsageError } from "../errors.ts";

const USAGE =
  "atmux relayd <--start|--drain> [--team-dir <path>] [--once] [--max-events N]";

export interface ParsedRelaydArgs {
  /** Sub-verbs:
   *   - `start`  : long-lived multi-topic event-router (was `committer
   *                --daemon`). Subscribes to task.done + task.unclaimed
   *                (and future topics) via atmux-listener Rust
   *                kernel-blocked NOTIFY/LISTEN.
   *   - `drain`  : one-shot cron-backstop drain across all topics
   *                (was `committer --drain`). Processes pending
   *                events via subscriber_offsets table, exits 0. */
  subverb: "start" | "drain";
  teamDir?: string;
  /** `--once`: exit after first batch (test ergonomics). */
  once?: boolean;
  /** `--max-events N`: exit after processing N events (test ergonomics). */
  maxEvents?: number;
}

export function parseRelaydArgs(argv: ReadonlyArray<string>): ParsedRelaydArgs {
  let subverb: "start" | "drain" | undefined;
  let teamDir: string | undefined;
  let once = false;
  let maxEvents: number | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--start" || a === "start") {
      subverb = "start";
      i += 1;
      continue;
    }
    if (a === "--drain" || a === "drain") {
      subverb = "drain";
      i += 1;
      continue;
    }
    if (a === "--once") {
      once = true;
      i += 1;
      continue;
    }
    if (a === "--max-events") {
      const v = argv[i + 1];
      if (v === undefined || v === "") {
        throw new UsageError({
          what: "relayd: --max-events requires a value",
          hint: USAGE,
        });
      }
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new UsageError({
          what: `relayd: --max-events must be a positive integer (got ${v})`,
          hint: USAGE,
        });
      }
      maxEvents = n;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined || v === "") {
        throw new UsageError({
          what: "relayd: --team-dir requires a value",
          hint: USAGE,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a?.startsWith("-") === true) {
      throw new UsageError({ what: `relayd: unknown flag: ${a}`, hint: USAGE });
    }
    throw new UsageError({ what: `relayd: unexpected arg: ${a}`, hint: USAGE });
  }
  if (subverb === undefined) {
    throw new UsageError({
      what: "relayd: no sub-verb specified (--start or --drain)",
      hint: USAGE,
    });
  }
  const out: ParsedRelaydArgs = { subverb };
  if (teamDir !== undefined) out.teamDir = teamDir;
  if (once) out.once = true;
  if (maxEvents !== undefined) out.maxEvents = maxEvents;
  return out;
}

/**
 * `atmux relayd` top-level dispatch. Delegates to the existing
 * committer verb-layer functions via a re-shaped `ParsedCommitterArgs`
 * — single source of truth for the daemon/drain bodies stays in
 * `committer.ts`. Future amendment can move the bodies here once
 * legacy `committer --daemon` is removed.
 */
export async function relayd(
  argv: ReadonlyArray<string>,
  opts: CommitterOpts = {},
): Promise<number> {
  const parsed = parseRelaydArgs(argv);
  // Adapt to ParsedCommitterArgs shape. The verb-layer functions
  // accept a superset that includes `--sweep`; we narrow to the
  // matching sub-verb name.
  const committerSubverb = parsed.subverb === "start" ? "daemon" : "drain";
  const committerArgs = {
    subverb: committerSubverb as "daemon" | "drain",
    ...(parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {}),
    ...(parsed.once === true ? { once: true as const } : {}),
    ...(parsed.maxEvents !== undefined ? { maxEvents: parsed.maxEvents } : {}),
  };
  if (parsed.subverb === "start") {
    return await committerDaemonVerb(committerArgs, opts);
  }
  return await committerDrainVerb(committerArgs, opts);
}
