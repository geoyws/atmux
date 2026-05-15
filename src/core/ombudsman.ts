// ADR-147 §D2: ombudsman sentinel — JSON array of pending complaint ids.
//
// One sentinel per team at `<atmuxDir>/state/ombudsman-pending.json`.
// Writers: `atmux complaints file` (append on insert) + `atmux complaints
// resolve` (remove on flip). Reader: `atmux ombudsman tick` (fast no-op
// when empty, wakes the ombudsman pane when non-empty per §D2).
//
// **Why a JSON file, not a SQLite table** — ADR-147 §D2 cites the
// `groom-pending-judgment.json` pattern (t-9319a22c parking-lot task).
// Sentinel is a single small array read on every cron tick; the
// constant-time existence-check (`pending.length === 0`) is the hot
// path. A DB roundtrip per tick wastes the optimisation. The sentinel
// is allowed to drift from `complaints.status='open'` by milliseconds
// — the work-side reconciles by reading both on each drain (see
// brief §"Your loop" step 1).
//
// Concurrency: every mutation routes through `updateJson` (flock + atomic
// rename per ADR-005). T2 (atmux complaints file/resolve sentinel
// integration) wraps each `addToSentinel`/`removeFromSentinel` call inside
// the same DB transaction that performs the row write, so a process crash
// between the DB write and the sentinel write leaves an inconsistent
// (sentinel-missing-id) state that the ombudsman's read-both reconcile
// step in `work` heals on the next tick — the worst-case is one delayed
// adjudication, not a lost complaint.

import { join } from "node:path";
import { z } from "zod";
import { ensureDir, exists } from "../abstractions/fs.ts";
import { readJsonOr, updateJson } from "../abstractions/json.ts";
import { stateDir } from "./common.ts";

/** Zod schema for the on-disk sentinel — `{ pending: string[] }`. The
 *  wrapping object (rather than a bare array) leaves room for future
 *  metadata (e.g. `lastReadAt`, `version`) without a v2 migration. */
export const OmbudsmanSentinelSchema = z
  .object({
    pending: z.array(z.string()),
  })
  .strict();
export type OmbudsmanSentinel = z.infer<typeof OmbudsmanSentinelSchema>;

const EMPTY_SENTINEL: OmbudsmanSentinel = { pending: [] };

/** Path to the sentinel file given an atmux dir. Pure — does not touch
 *  disk. Exported so verbs + tests share one path-resolution path. */
export function sentinelPath(atmuxDir: string): string {
  return join(stateDir(atmuxDir), "ombudsman-pending.json");
}

/**
 * Read the sentinel. Returns `{ pending: [] }` when the file is absent
 * (first-run / no complaints yet) — absence is the empty case, not an
 * error. An existing-but-malformed file throws `SchemaError` from
 * `readJsonOr`, matching the ADR-005 "never silent fallback to defaults"
 * rule for corrupted state.
 */
export async function readSentinel(atmuxDir: string): Promise<OmbudsmanSentinel> {
  return await readJsonOr(sentinelPath(atmuxDir), OmbudsmanSentinelSchema, EMPTY_SENTINEL);
}

/**
 * Append a complaint id to the sentinel. Set-semantic: a no-op if the id
 * is already present (idempotent re-file). Creates the state dir + file
 * on first call.
 */
export async function addToSentinel(atmuxDir: string, complaintId: string): Promise<void> {
  await ensureDir(stateDir(atmuxDir));
  await updateJson(
    sentinelPath(atmuxDir),
    OmbudsmanSentinelSchema,
    (cur) => {
      if (cur.pending.includes(complaintId)) return cur;
      return { pending: [...cur.pending, complaintId] };
    },
    { initial: EMPTY_SENTINEL },
  );
}

/**
 * Remove a complaint id from the sentinel. Set-semantic: no-op when the
 * id is absent. Returns true when a removal happened, false on no-op.
 * Caller (`atmux complaints resolve`) uses the return value to decide
 * whether to log the sentinel clear in addition to the DB flip.
 */
export async function removeFromSentinel(atmuxDir: string, complaintId: string): Promise<boolean> {
  await ensureDir(stateDir(atmuxDir));
  let removed = false;
  await updateJson(
    sentinelPath(atmuxDir),
    OmbudsmanSentinelSchema,
    (cur) => {
      const idx = cur.pending.indexOf(complaintId);
      if (idx === -1) return cur;
      removed = true;
      const next = cur.pending.slice();
      next.splice(idx, 1);
      return { pending: next };
    },
    { initial: EMPTY_SENTINEL },
  );
  return removed;
}

/** Convenience: true when the sentinel is empty (or absent). Tick's
 *  hot-path predicate — used so `tick` short-circuits without parsing
 *  the file body. */
export async function isSentinelEmpty(atmuxDir: string): Promise<boolean> {
  const path = sentinelPath(atmuxDir);
  if (!(await exists(path))) return true;
  const sentinel = await readSentinel(atmuxDir);
  return sentinel.pending.length === 0;
}
