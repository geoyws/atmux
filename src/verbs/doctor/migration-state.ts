// ADR-169 OQ-6 (KEEP-AS-JSON enforcement): `migration-state-incomplete`
// doctor probe.
//
// Scans `<atmuxDir>/state/*.json` for files that should no longer exist
// as live state: the ADR-169 migrated sources (flags / role_state /
// budget tables — exact stems mirror `src/verbs/migrate-state.ts`
// targets via the repo constants) plus any unclassified ad-hoc file
// outside the KEEP-AS-JSON list. Archived copies under
// `<atmuxDir>/archive/` are out of the scan root, so they stay silent.
//
// Read-only; never moves or deletes. RED per offender, silent when
// clean. House shape mirrors `doctor/claude-accounts.ts`: a pure
// filename-mapper plus a thin I/O wrapper.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { BUDGET_PROBES } from "../../core/budget-state-repo.ts";
import { COCKPIT_FLAG_FILES, TEAM_FLAG_FILES } from "../../core/flags-repo.ts";
import {
  COST_NAMESPACE,
  MODAL_HISTORY_NAMESPACE,
  TEAM_ROLE_STATE_FILES,
} from "../../core/role-state-repo.ts";
import type { DoctorRow } from "./types.ts";

/** Probe label shared by every row this module emits. */
export const MIGRATION_STATE_LABEL = "migration-state-incomplete";

/** Fixed stems migrated by `migrate-state` (ADR-169 §In-scope). */
const MIGRATED_STEM: Record<string, true> = {};
for (const stem of [
  ...TEAM_FLAG_FILES,
  ...COCKPIT_FLAG_FILES,
  ...TEAM_ROLE_STATE_FILES,
  ...BUDGET_PROBES,
]) {
  MIGRATED_STEM[stem] = true;
}

/** Role-scoped prefixes glob-discovered by `--target=role-state`. */
const COST_FILE_PREFIX = `${COST_NAMESPACE}-`;
const MODAL_HISTORY_FILE_PREFIX = `${MODAL_HISTORY_NAMESPACE}-`;

/** KEEP-AS-JSON basenames / prefixes (ADR-169 §KEEP-AS-JSON). */
const BUDGET_PROBE_CACHE_PREFIX = "budget-probe-";
const KEEP_BASENAME: Record<string, true> = { "cockpit.json": true, "team.json": true };

export type MigrationStateFileKind = "migrated" | "keep" | "unknown";

/** Pure classifier for one `state/` basename. Non-JSON names are never
 *  offenders — callers filter to `*.json`, this returns `keep` for them
 *  so stray inputs stay silent. */
export function classifyMigrationStateFile(filename: string): MigrationStateFileKind {
  if (!filename.endsWith(".json")) return "keep";
  const stem = filename.slice(0, -".json".length);
  if (MIGRATED_STEM[stem] === true) return "migrated";
  if (stem.startsWith(COST_FILE_PREFIX) && stem.length > COST_FILE_PREFIX.length) return "migrated";
  if (
    stem.startsWith(MODAL_HISTORY_FILE_PREFIX) &&
    stem.length > MODAL_HISTORY_FILE_PREFIX.length
  ) {
    return "migrated";
  }
  if (KEEP_BASENAME[filename] === true) return "keep";
  if (
    stem.startsWith(BUDGET_PROBE_CACHE_PREFIX) &&
    stem.length > BUDGET_PROBE_CACHE_PREFIX.length
  ) {
    return "keep";
  }
  return "unknown";
}

/** Which `migrate-state --target=` owns a migrated basename (for the
 *  row hint). Null for non-migrated names. */
export function migrationTargetFor(filename: string): "flags" | "role-state" | "budget" | null {
  if (classifyMigrationStateFile(filename) !== "migrated") return null;
  const stem = filename.slice(0, -".json".length);
  if ((TEAM_FLAG_FILES as readonly string[]).includes(stem)) return "flags";
  if ((COCKPIT_FLAG_FILES as readonly string[]).includes(stem)) return "flags";
  if ((BUDGET_PROBES as readonly string[]).includes(stem)) return "budget";
  return "role-state";
}

/** Pure mapping. One red row per offender; silent when clean. */
export function migrationStateIncompleteRows(filenames: ReadonlyArray<string>): DoctorRow[] {
  const rows: DoctorRow[] = [];
  for (const filename of [...filenames].sort()) {
    const kind = classifyMigrationStateFile(filename);
    if (kind === "keep") continue;
    if (kind === "migrated") {
      const target = migrationTargetFor(filename);
      rows.push({
        status: "red",
        label: MIGRATION_STATE_LABEL,
        detail: `state/${filename} is an ADR-169 migrated source still present — canonical store is state.db`,
        hint:
          target === null
            ? "atmux migrate-state json-to-sqlite archives migrated sources to .atmux/archive/ (ADR-169)"
            : `atmux migrate-state json-to-sqlite --target=${target} archives migrated sources to .atmux/archive/ (ADR-169)`,
      });
    } else {
      rows.push({
        status: "red",
        label: MIGRATION_STATE_LABEL,
        detail: `state/${filename} is unclassified JSON state — neither an ADR-169 migrated source nor KEEP-AS-JSON`,
        hint: "classify it (migrate to state.db or extend the ADR-169 KEEP-AS-JSON list) or remove it",
      });
    }
  }
  return rows;
}

/** I/O wrapper. Lists `<atmuxDir>/state/*.json` and maps the outcome
 *  to rows via `migrationStateIncompleteRows`. Read-only; a missing
 *  state dir is clean (nothing to flag). */
export async function checkMigrationStateIncomplete(atmuxDir: string): Promise<DoctorRow[]> {
  const stateDir = join(atmuxDir, "state");
  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch {
    return [];
  }
  return migrationStateIncompleteRows(entries.filter((name) => name.endsWith(".json")));
}
