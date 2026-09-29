// t-a1f9e37e: `complaint-row-residue` doctor probe.
//
// Flags complaint rows that pre-date ADR-150 routing: a row whose
// `target_team` names a DIFFERENT team than the DB that holds it, with
// no `--no-route` record (`extra.no_route`). Such rows were filed
// locally about another team before `--target-team` became
// storage-authoritative, so the intended recipient's ombudsman never
// drains them.
//
// Shape mirrors `claude-accounts.ts`: pure state-mapper
// (`complaintResidueStateRows`, no I/O) + thin I/O wrapper
// (`checkComplaintResidue`, cockpit walk + SELECT-only reads).

import { existsSync } from "node:fs";
import { join } from "node:path";

import { closeDatabase, openDatabase } from "../../abstractions/sqlite.ts";
import { migrations } from "../../abstractions/sqlite-migrations.ts";
import { enabledTeams, type LoadCockpitOpts, loadCockpit } from "../../core/cockpit.ts";
import { stateDbPath } from "../../core/common.ts";
import { ComplaintsRepo } from "../../core/repositories/complaints-repo.ts";
import type { DoctorRow } from "./types.ts";

/** One complaint row sighting for the pure state-mapper. Exported so
 *  tests exercise every branch without filesystem I/O. */
export interface ComplaintResidueCandidate {
  id: string;
  targetTeam: string | null;
  /** True when the row was filed with `file --no-route` (intentional
   *  local copy — never residue). */
  noRoute: boolean;
  /** Cockpit-registered name of the team whose DB holds the row. */
  ownerTeam: string;
  atmuxDir: string;
}

/** Pure mapping. Silent when clean — a correctly-routed fleet needs no row. */
export function complaintResidueStateRows(
  candidates: ReadonlyArray<ComplaintResidueCandidate>,
): DoctorRow[] {
  const residue = candidates.filter(
    (c) => c.targetTeam !== null && c.targetTeam !== c.ownerTeam && c.noRoute !== true,
  );
  if (residue.length === 0) return [];
  const detail = residue
    .map(
      (c) => `${c.id} targets '${c.targetTeam}' but lives in ${c.ownerTeam}'s DB (${c.atmuxDir})`,
    )
    .join("; ");
  return [
    {
      status: "yellow",
      label: "complaint-row-residue",
      detail: `${residue.length} mis-routed complaint row(s): ${detail}`,
      hint: "re-file with `atmux complaints file --target-team <t>` so the row lands in the target team's DB, or keep it local with `file --no-route` (ADR-150)",
    },
  ];
}

export interface CheckComplaintResidueOpts {
  /** Cockpit-loader seams (path/env/home injection — tests pass a
   *  scratch cockpit path; production callers omit). */
  cockpit?: LoadCockpitOpts;
}

/** I/O wrapper. Walks cockpit-registered team DBs (SELECT-only; teams
 *  without a state.db are skipped, never created) and maps the
 *  sightings via `complaintResidueStateRows`. Silent when the cockpit
 *  registry is absent — a single-team operator has no fleet to walk. */
export async function checkComplaintResidue(
  opts: CheckComplaintResidueOpts = {},
): Promise<DoctorRow[]> {
  const cockpit = await loadCockpit(opts.cockpit ?? {}).catch(() => null);
  // Absent/unreadable registry: a single-team operator has no fleet to
  // walk, so stay silent.
  if (cockpit === null) return [];
  const candidates: ComplaintResidueCandidate[] = [];
  const seen: Record<string, true> = {};
  for (const entry of enabledTeams(cockpit)) {
    const atmuxDir = join(entry.root, ".atmux");
    if (seen[atmuxDir] === true) continue;
    seen[atmuxDir] = true;
    const dbPath = stateDbPath(atmuxDir);
    if (!existsSync(dbPath)) continue;
    const db = openDatabase(dbPath, migrations);
    try {
      const repo = new ComplaintsRepo(db);
      for (const c of repo.list()) {
        candidates.push({
          id: c.id,
          targetTeam: c.targetTeam,
          noRoute: c.extra?.no_route === true,
          ownerTeam: entry.name,
          atmuxDir,
        });
      }
    } finally {
      closeDatabase(db);
    }
  }
  return complaintResidueStateRows(candidates);
}
