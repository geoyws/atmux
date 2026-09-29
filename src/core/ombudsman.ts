// ADR-147 §D2: ombudsman sentinel — JSON array of pending complaint ids.
//
// One sentinel per team at `<atmuxDir>/state/ombudsman-pending.json`.
// Writers: `atmux complaints file` (append on insert) + `atmux complaints
// resolve` (remove on flip). Reader: `atmux ombudsman tick` (fast no-op
// when empty, wakes the ombudsman pane when non-empty per §D2).
//
// ADR-169 P2 (EPIC e-38ee9939): the sentinel lives in the `role_state`
// table (`role='_'`, `namespace='ombudsman-pending'`) of
// `<atmuxDir>/state.db`, not in the JSON file. Readers promote a
// leftover legacy file on first read; writers are table-only. The
// legacy path helper stays as the fallback address.
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
// Concurrency: every mutation runs inside one IMMEDIATE transaction
// (the SQLite successor to the old flock-guarded `updateJson` per
// ADR-005) that first promotes a leftover legacy file, so a process
// crash between the DB write and the sentinel write leaves an
// inconsistent (sentinel-missing-id) state that the ombudsman's
// read-both reconcile step in `work` heals on the next tick — the
// worst-case is one delayed adjudication, not a lost complaint.

import { join } from "node:path";
import { z } from "zod";
import { parseJsonString } from "../abstractions/json.ts";
import { transactImmediate } from "../abstractions/sqlite.ts";
import { now } from "../abstractions/time.ts";
import { stateDir } from "./common.ts";
import {
  importLegacyRoleText,
  RoleStateRepo,
  readRoleTextAtDb,
  TEAM_ROLE_STATE,
  teamRoleStateDbPath,
  withRoleStateDb,
} from "./role-state-repo.ts";

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

/** Namespace of the sentinel row under the team sentinel role. */
const SENTINEL_NAMESPACE = "ombudsman-pending";

/**
 * Read the sentinel. Returns `{ pending: [] }` when neither a row nor
 * a legacy file exists (first-run / no complaints yet) — absence is
 * the empty case, not an error. Existing-but-malformed state throws
 * `SchemaError`, matching the ADR-005 "never silent fallback to
 * defaults" rule for corrupted state.
 */
export async function readSentinel(atmuxDir: string): Promise<OmbudsmanSentinel> {
  const path = sentinelPath(atmuxDir);
  const text = await readRoleTextAtDb(
    teamRoleStateDbPath(atmuxDir),
    TEAM_ROLE_STATE,
    SENTINEL_NAMESPACE,
    path,
  );
  if (text === null) return EMPTY_SENTINEL;
  return parseJsonString(path, OmbudsmanSentinelSchema, text);
}

/**
 * Append a complaint id to the sentinel. Set-semantic: a no-op if the id
 * is already present (idempotent re-file). Creates the DB on first call.
 */
export async function addToSentinel(atmuxDir: string, complaintId: string): Promise<void> {
  await updateSentinel(atmuxDir, (cur) => {
    if (cur.pending.includes(complaintId)) return cur;
    return { pending: [...cur.pending, complaintId] };
  });
}

/**
 * Remove a complaint id from the sentinel. Set-semantic: no-op when the
 * id is absent. Returns true when a removal happened, false on no-op.
 * Caller (`atmux complaints resolve`) uses the return value to decide
 * whether to log the sentinel clear in addition to the DB flip.
 */
export async function removeFromSentinel(atmuxDir: string, complaintId: string): Promise<boolean> {
  const path = sentinelPath(atmuxDir);
  const dbPath = teamRoleStateDbPath(atmuxDir);
  return withRoleStateDb(dbPath, async (db) => {
    await importLegacyRoleText(db, TEAM_ROLE_STATE, SENTINEL_NAMESPACE, path, now());
    return transactImmediate(db, () => {
      const repo = new RoleStateRepo(db);
      const raw = repo.get(TEAM_ROLE_STATE, SENTINEL_NAMESPACE);
      const cur =
        raw === null ? EMPTY_SENTINEL : parseJsonString(path, OmbudsmanSentinelSchema, raw);
      const idx = cur.pending.indexOf(complaintId);
      if (idx === -1) return false;
      const next = cur.pending.slice();
      next.splice(idx, 1);
      repo.set(
        TEAM_ROLE_STATE,
        SENTINEL_NAMESPACE,
        JSON.stringify(OmbudsmanSentinelSchema.parse({ pending: next })),
        now(),
      );
      return true;
    });
  });
}

/**
 * Read-modify-write the sentinel inside one IMMEDIATE transaction
 * (the SQLite successor to the old flock-guarded `updateJson` —
 * concurrent `complaints file` verbs serialize instead of losing
 * updates). Output re-validates, mirroring the old mutation path.
 */
async function updateSentinel(
  atmuxDir: string,
  mutator: (current: OmbudsmanSentinel) => OmbudsmanSentinel,
): Promise<void> {
  const path = sentinelPath(atmuxDir);
  const dbPath = teamRoleStateDbPath(atmuxDir);
  await withRoleStateDb(dbPath, async (db) => {
    await importLegacyRoleText(db, TEAM_ROLE_STATE, SENTINEL_NAMESPACE, path, now());
    transactImmediate(db, () => {
      const repo = new RoleStateRepo(db);
      const raw = repo.get(TEAM_ROLE_STATE, SENTINEL_NAMESPACE);
      const current =
        raw === null ? EMPTY_SENTINEL : parseJsonString(path, OmbudsmanSentinelSchema, raw);
      const next = OmbudsmanSentinelSchema.parse(mutator(current));
      repo.set(TEAM_ROLE_STATE, SENTINEL_NAMESPACE, JSON.stringify(next), now());
    });
  });
}

/** Convenience: true when the sentinel is empty (or absent). Tick's
 *  hot-path predicate — used so `tick` short-circuits without parsing
 *  the row body. */
export async function isSentinelEmpty(atmuxDir: string): Promise<boolean> {
  const sentinel = await readSentinel(atmuxDir);
  return sentinel.pending.length === 0;
}
