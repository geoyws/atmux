// ADR-057 §D2d (Class B): stale-anchor detection for the lead's
// driver-inbox reading cursor.
//
// Failure mode B3: lead is anchored on stale driver-inbox content. The
// cursor at `<atmuxDir>/state/last-driver-inbox-read.txt` records when
// the lead last consumed driver-inbox tip; if that cursor is >2h behind
// driver-inbox's mtime AND there are unread entries, surface a
// `[whip-stale-anchor]` finding.
//
// Dedup: per the ADR, "single ping per stale window; dedup by hash of
// the unread tip's first line". State file
// `<atmuxDir>/state/whip-stale-anchor-state.json` records the last
// fired hash + epoch. We re-fire only when the unread tip *changes* —
// otherwise the lead has been pinged once per stale window already.

import { join } from "node:path";
import { atomicWrite, readTextOrNull, statOrNull } from "../abstractions/fs.ts";
import { stateDir } from "./common.ts";
import { type DriverInboxEntry, entriesSince, parseEntries, readCursor } from "./driver-inbox.ts";
import { driverInboxPath } from "./common.ts";

/** Threshold for "lead is anchored on stale view": cursor more than
 *  2h behind driver-inbox mtime. */
const DEFAULT_STALE_SEC = 2 * 60 * 60;

const STATE_FILENAME = "whip-stale-anchor-state.json";

interface StaleAnchorState {
  /** Hash of the unread tip's first line at the last fire. */
  lastFiredHash: string;
  /** Epoch seconds when the finding last fired. */
  lastFiredEpoch: number;
}

export interface StaleAnchorVerdict {
  /** True iff the gate fires this tick (cursor stale + new content +
   *  hash hasn't been pinged before). */
  fire: boolean;
  /** Bullet text when `fire === true`; `null` otherwise. */
  bullet: string | null;
  /** Hash of the unread tip — exposed for the caller's audit log. */
  tipHash: string | null;
  /** Number of unread entries (cursor-or-newer). */
  unreadCount: number;
  /** Diagnostic: how far behind the cursor is (sec). 0 when caught up. */
  cursorLagSec: number;
}

export interface CheckStaleAnchorArgs {
  atmuxDir: string;
  /** Current epoch seconds (caller's clock). */
  nowEpochSec: number;
  /** Override stale threshold (sec). Default 2h per ADR-057 §D2d. */
  staleSec?: number;
}

/**
 * Compute + persist the stale-anchor verdict for one whip tick.
 *
 * Returns `fire: false` in any of these cases:
 *   - driver-inbox.md absent / empty
 *   - cursor never set (first-time read; not actually stale, just untouched)
 *   - cursor caught up to within `staleSec` of mtime
 *   - no unread entries
 *   - the same tip hash already fired (dedup)
 *
 * On `fire: true` the dedup state file is written before return; the
 * caller's responsibility is to push the bullet onto its findings list.
 */
export async function checkStaleAnchor(args: CheckStaleAnchorArgs): Promise<StaleAnchorVerdict> {
  const { atmuxDir, nowEpochSec } = args;
  const staleSec = args.staleSec ?? DEFAULT_STALE_SEC;
  const baseVerdict: StaleAnchorVerdict = {
    fire: false,
    bullet: null,
    tipHash: null,
    unreadCount: 0,
    cursorLagSec: 0,
  };

  const path = driverInboxPath(atmuxDir);
  const stat = await statOrNull(path);
  if (stat === null) return baseVerdict;

  const cursor = await readCursor(atmuxDir);
  if (cursor === null) return baseVerdict;

  const fileMtimeSec = Math.floor(stat.mtimeMs / 1000);
  const lag = fileMtimeSec - cursor;
  if (lag <= staleSec) {
    return { ...baseVerdict, cursorLagSec: lag };
  }

  const txt = await readTextOrNull(path);
  if (txt === null || txt.length === 0) {
    return { ...baseVerdict, cursorLagSec: lag };
  }

  const entries = parseEntries(txt, nowEpochSec);
  const unread = entriesSince(entries, cursor);
  if (unread.length === 0) {
    return { ...baseVerdict, cursorLagSec: lag };
  }

  const tip = unread[unread.length - 1] as DriverInboxEntry;
  const tipHash = hashFirstLine(tip.head);

  // Dedup: only fire when the tip hash changed.
  const prev = await readState(atmuxDir);
  if (prev !== null && prev.lastFiredHash === tipHash) {
    return {
      ...baseVerdict,
      tipHash,
      unreadCount: unread.length,
      cursorLagSec: lag,
    };
  }

  await writeState(atmuxDir, {
    lastFiredHash: tipHash,
    lastFiredEpoch: nowEpochSec,
  });

  const lagH = Math.round(lag / 3600);
  return {
    fire: true,
    bullet: `📍 lead driver-inbox cursor ${lagH}h behind tip · ${unread.length} unread`,
    tipHash,
    unreadCount: unread.length,
    cursorLagSec: lag,
  };
}

// ---------- Internals ----------

function hashFirstLine(s: string): string {
  // 32-bit FNV-1a — adequate for change-detection on short strings.
  // Avoids node:crypto dependency in the hot whip-tick path.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function staleAnchorStatePath(atmuxDir: string): string {
  return join(stateDir(atmuxDir), STATE_FILENAME);
}

async function readState(atmuxDir: string): Promise<StaleAnchorState | null> {
  const txt = await readTextOrNull(staleAnchorStatePath(atmuxDir));
  if (txt === null) return null;
  try {
    const parsed = JSON.parse(txt);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { lastFiredHash?: unknown }).lastFiredHash === "string" &&
      typeof (parsed as { lastFiredEpoch?: unknown }).lastFiredEpoch === "number"
    ) {
      return parsed as StaleAnchorState;
    }
  } catch {
    // Corrupt — treat as no prior state; next tick rewrites if it fires.
  }
  return null;
}

async function writeState(atmuxDir: string, state: StaleAnchorState): Promise<void> {
  await atomicWrite(staleAnchorStatePath(atmuxDir), JSON.stringify(state));
}
