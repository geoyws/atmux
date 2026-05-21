// ADR-068 cutover (Tier 1, P0) — `atmux cleanup` core helpers.
//
// Two idempotent sub-ops, both cron-safe + dry-runnable:
//   1. rotateLogs — rotate any *.log file >1MB to *.log.1
//   2. removeLegacyInboxFiles — delete stale `.atmux/inboxes/*.json`
//      (+ sidecars) on SQL-canonical teams (state.db present).

import { readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { exists, removeFile, statOrNull, writeText } from "../abstractions/fs.ts";
import { now as nowMs } from "../abstractions/time.ts";
import { inboxDir as resolveInboxDir, logsDir as resolveLogsDir } from "./common.ts";

// ---------- Sub-op 1: log rotation ----------

export interface RotatedLog {
  path: string;
  size: number;
}

export interface LogRotationResult {
  rotated: RotatedLog[];
  skipped: number;
  capBytes: number;
}

export interface RotateLogsOpts {
  maxBytes?: number;
  dryRun?: boolean;
}

export async function rotateLogs(
  atmuxDir: string,
  opts: RotateLogsOpts = {},
): Promise<LogRotationResult> {
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  const dryRun = opts.dryRun === true;
  const ldir = resolveLogsDir(atmuxDir);
  const out: LogRotationResult = { rotated: [], skipped: 0, capBytes: maxBytes };

  if (!(await exists(ldir))) return out;

  const entries = await readdir(ldir).catch(() => [] as string[]);
  for (const name of entries) {
    if (!name.endsWith(".log")) continue;
    const full = join(ldir, name);
    const st = await statOrNull(full);
    if (st === null || !st.isFile) continue;
    if (st.size > maxBytes) {
      if (!dryRun) {
        await rename(full, `${full}.1`).catch(async () => {
          await removeFile(`${full}.1`);
          await rename(full, `${full}.1`);
        });
        await writeText(full, "");
      }
      out.rotated.push({ path: full, size: st.size });
    } else {
      out.skipped += 1;
    }
  }
  return out;
}

// ---------- Sub-op 2: legacy inbox JSON removal (ADR-076 Phase 3) ----------

export interface RemoveLegacyInboxFilesResult {
  removed: string[];
  skipped: boolean;
}

export interface RemoveLegacyInboxFilesOpts {
  dryRun?: boolean;
}

/**
 * Remove stale `.atmux/inboxes/*.json` (+ sidecars) when the team is
 * SQL-canonical (`state.db` exists). No-op when state.db is absent.
 */
export async function removeLegacyInboxFiles(
  atmuxDir: string,
  opts: RemoveLegacyInboxFilesOpts = {},
): Promise<RemoveLegacyInboxFilesResult> {
  const dryRun = opts.dryRun === true;
  const stateDb = join(atmuxDir, "state.db");
  if (!(await exists(stateDb))) {
    return { removed: [], skipped: true };
  }

  const ibDir = resolveInboxDir(atmuxDir);
  const out: RemoveLegacyInboxFilesResult = { removed: [], skipped: false };
  if (!(await exists(ibDir))) return out;

  const entries = await readdir(ibDir).catch(() => [] as string[]);
  for (const name of entries) {
    const isLegacy =
      name.endsWith(".json") ||
      name.endsWith(".json.lock") ||
      name.includes(".json.bak");
    if (!isLegacy) continue;
    const full = join(ibDir, name);
    const st = await statOrNull(full);
    if (st === null || !st.isFile) continue;
    if (!dryRun) await removeFile(full);
    out.removed.push(name);
  }
  return out;
}

/** @deprecated Use removeLegacyInboxFiles */
export const purgeLegacyInboxes = removeLegacyInboxFiles;
