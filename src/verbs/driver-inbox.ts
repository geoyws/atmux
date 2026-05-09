// ADR-057 §D2 (Class B / D2b): delta-only driver-inbox read verb.
//
// `atmux driver-inbox [--since <epoch-or-HH:MM>] [--all] [--ack] [--json] [--team-dir <dir>]`
//
// Default: print entries newer than the lead's cursor at
// `<atmuxDir>/state/last-driver-inbox-read.txt`. With `--ack`, update the
// cursor to the tip timestamp after the read so subsequent invocations
// surface only newer content. Failure mode B3 ("anchored on stale view")
// is mitigated by D2d's stale-anchor whip finding (separate Task surface).
//
// Why a new verb (vs extending `outbox`): `atmux outbox` reads
// `lead-outbox.md` (member→driver replies) — different file, different
// audience. ADR-057 §D2b mentions extending `outbox`; the task body's
// "(or whichever owns driver-inbox read-side)" carve-out routes here so
// the existing outbox semantics aren't entangled. The same cursor file
// is exposed via `--since` for backfill and re-used by D2c (handoff)
// and D2d (stale-anchor whip finding).

import { now as nowMs } from "../abstractions/time.ts";
import { getAtmuxDir, type ResolveDirOpts, requireTeam } from "../core/common.ts";
import { type DriverInboxEntry, readDriverInbox, writeCursor } from "../core/driver-inbox.ts";
import { defaultStdoutWrite, type Writer } from "../core/io.ts";
import { UsageError } from "../errors.ts";

const USAGE = "atmux driver-inbox [--since <epoch>] [--all] [--ack] [--json] [--team-dir <dir>]";

// ---------- Args ----------

export interface DriverInboxArgs {
  /** When true, print every entry regardless of cursor. Wins over --since. */
  showAll: boolean;
  /** Cursor override (epoch seconds). Wins over the on-disk cursor when
   *  set; ignored when --all is also set. */
  sinceEpoch?: number;
  /** Update the cursor to the tip timestamp after the read. */
  ack: boolean;
  /** Emit JSON (one object: { entries: [{head, body, tsEpochSec}], cursorBefore, cursorAfter, fileMtimeSec }). */
  json: boolean;
  teamDir?: string;
}

export function parseDriverInboxArgs(argv: ReadonlyArray<string>): DriverInboxArgs {
  let showAll = false;
  let sinceEpoch: number | undefined;
  let ack = false;
  let json = false;
  let teamDir: string | undefined;

  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--all") {
      showAll = true;
      i += 1;
      continue;
    }
    if (a === "--ack") {
      ack = true;
      i += 1;
      continue;
    }
    if (a === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (a === "--since") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "driver-inbox: --since requires a value", hint: USAGE });
      }
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new UsageError({
          what: `driver-inbox: --since requires non-negative epoch seconds (got: ${v})`,
          hint: USAGE,
        });
      }
      sinceEpoch = n;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "driver-inbox: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({
      what: `driver-inbox: unknown arg: ${a ?? ""}`,
      hint: USAGE,
    });
  }

  const out: DriverInboxArgs = { showAll, ack, json };
  if (sinceEpoch !== undefined) out.sinceEpoch = sinceEpoch;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Public entrypoint ----------

export interface DriverInboxOpts {
  stdout?: Writer;
  /** Clock — defaults to `time.now()` (ms). */
  now?: () => number;
}

export async function driverInbox(
  argv: ReadonlyArray<string>,
  opts: DriverInboxOpts = {},
): Promise<number> {
  const parsed = parseDriverInboxArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);
  const stdout = opts.stdout ?? defaultStdoutWrite;
  const clock = opts.now ?? nowMs;
  const nowEpochSec = Math.floor(clock() / 1000);

  // Cursor resolution. --all wins over --since wins over on-disk cursor.
  // `cursorOverride` for readDriverInbox; `0` (epoch start) is the
  // "show all" sentinel — every entry is "after" it.
  const cursorOverride = parsed.showAll ? 0 : parsed.sinceEpoch;
  const result = await readDriverInbox(atmuxDir, nowEpochSec, cursorOverride);
  const entriesToShow = result.delta;

  // Render.
  if (parsed.json) {
    const cursorAfter = parsed.ack && result.tipTs !== null ? result.tipTs : result.priorCursor;
    stdout(
      `${JSON.stringify({
        entries: entriesToShow.map(serializeEntry),
        cursorBefore: result.priorCursor,
        cursorAfter,
        fileMtimeSec: result.fileMtimeSec,
      })}\n`,
    );
  } else if (entriesToShow.length === 0) {
    if (result.fileMtimeSec === null) {
      stdout("(driver-inbox empty / absent)\n");
    } else if (result.priorCursor === null) {
      stdout("(driver-inbox has no entries)\n");
    } else {
      stdout("(no new entries since last read)\n");
    }
  } else {
    stdout(
      `📬 driver-inbox — ${entriesToShow.length} entr${entriesToShow.length === 1 ? "y" : "ies"}:\n\n`,
    );
    for (const e of entriesToShow) {
      stdout(`${e.body}\n\n`);
    }
  }

  // Cursor update on --ack. Cursor advances to the latest entry seen
  // (tipTs of the FULL set, not just delta — so re-running --ack twice
  // doesn't accidentally roll back to a delta-tip when delta is shorter
  // than tip due to undated entries lingering).
  if (parsed.ack && result.tipTs !== null) {
    await writeCursor(atmuxDir, result.tipTs);
  }
  return 0;
}

function serializeEntry(e: DriverInboxEntry): {
  head: string;
  body: string;
  tsEpochSec: number | null;
} {
  return { head: e.head, body: e.body, tsEpochSec: e.tsEpochSec };
}
