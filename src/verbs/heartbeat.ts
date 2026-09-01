// ADR-057 §D6a: `atmux heartbeat write <member>` — supervisor-side
// heartbeat producer for the per-member liveness signal consumed by
// `atmux watchdog` (§D6b) and `atmux status` (§D6c).
//
// Why this verb exists: src/core/heartbeat.ts shipped writeHeartbeat as
// the foundation primitive but had zero callsites — the watchdog reader
// was reading a file nobody wrote, so D4b's idle-skip predicate always
// saw absent heartbeats (never skipped) and D6b's watchdog perpetually
// flagged every member as stale. This verb is the producer half; the
// supervisor (today: the cron-mediated `atmux poke` tick, which iterates
// team.members every 5 min) folds it in once per per-member iteration
// so a fresh heartbeat means "supervisor observed this member in the
// last poke window".
//
// Fail-soft on the caller side: poke wraps the writeHeartbeat call in
// try/catch + stderr WARN (per ADR-057 §D6 best-effort substrate). This
// verb itself returns 0 on success + throws UsageError on missing args
// (mapped to exit 64 by the top-level reportError handler).

import { getAtmuxDir, type ResolveDirOpts } from "../core/common.ts";
import { writeHeartbeat } from "../core/heartbeat.ts";
import { UsageError } from "../errors.ts";

const USAGE = "atmux heartbeat write <member> [--team-dir <dir>]";

export interface HeartbeatWriteArgs {
  sub: "write";
  member: string;
  teamDir?: string;
}

export type HeartbeatArgs = HeartbeatWriteArgs;

export function parseHeartbeatArgs(argv: ReadonlyArray<string>): HeartbeatArgs {
  const sub = argv[0];
  if (sub === undefined || sub === "") {
    throw new UsageError({ what: "heartbeat: subverb required (try: write)", hint: USAGE });
  }
  if (sub !== "write") {
    throw new UsageError({
      what: `heartbeat: unknown subverb '${sub}' (try: write)`,
      hint: USAGE,
    });
  }
  let member: string | undefined;
  let teamDir: string | undefined;
  let i = 1;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "heartbeat: --team-dir requires a value",
          hint: USAGE,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a !== undefined && !a.startsWith("--") && member === undefined) {
      member = a;
      i += 1;
      continue;
    }
    throw new UsageError({ what: `heartbeat: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  if (member === undefined || member === "") {
    throw new UsageError({
      what: "heartbeat write: <member> arg required",
      hint: USAGE,
    });
  }
  const out: HeartbeatWriteArgs = { sub: "write", member };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

export interface HeartbeatOpts {
  /** Clock override (test injection). Returns ms-since-epoch. */
  now?: () => number;
}

/** `atmux heartbeat write <member>`. Idempotent — re-running overwrites
 *  the per-member epoch file with the current clock. */
export async function heartbeat(
  argv: ReadonlyArray<string>,
  opts: HeartbeatOpts = {},
): Promise<number> {
  const parsed = parseHeartbeatArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  if (opts.now !== undefined) {
    await writeHeartbeat(atmuxDir, parsed.member, Math.floor(opts.now() / 1000));
  } else {
    await writeHeartbeat(atmuxDir, parsed.member);
  }
  return 0;
}
