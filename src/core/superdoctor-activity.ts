// t-351318dc: cockpit-wide aggregate of superdoctor liveness.
//
// `gatherSuperdoctorActivity` walks every cockpit-enabled team's
// state.db and returns:
//   - total open complaints (sum across all teams' complaint boxes)
//   - latest `superdoctor_attempts.attempted_at` across every team
//   - oldest open complaint (team / summary / age) for the operator-
//     readable footer in the meta-watchdog Discord page
//
// `decideMetaWatchdogFire` is the pure policy fn — given the gathered
// activity + the prior pulse-state row + a clock, returns whether to
// emit the page this tick and the next-state row to persist.
//
// Dormancy gate is "≥1 open complaint AND no superdoctor activity in
// ≥2h" — a cold cockpit (zero attempts on record) with open complaints
// is also dormant (the cockpit never started healing).
//
// Dedup is "1 page per dormancy streak" — when dormancy clears (either
// a fresh attempt OR all complaints resolved), the streak ends and the
// next dormancy event re-pages.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";

/** A team-shaped entry from the cockpit. The meta-watchdog only needs
 *  name + root; we duck-type rather than importing `CockpitTeam` to
 *  keep this module independent of the cockpit schema. */
export interface MetaWatchdogTeam {
  name: string;
  root: string;
}

export interface OldestComplaintRow {
  team: string;
  summary: string;
  /** Age in seconds at observation time. */
  ageSec: number;
}

export interface SuperdoctorActivity {
  /** Sum of `complaints.status = 'open'` across every team's
   *  state.db. */
  openComplaints: number;
  /** MAX(`superdoctor_attempts.attempted_at`) across every team's
   *  state.db. Null when zero attempts exist anywhere — a cold cockpit. */
  latestAttemptedAtSec: number | null;
  /** Oldest open complaint surfaced for the page footer. Null when
   *  `openComplaints === 0`. */
  oldest: OldestComplaintRow | null;
  /** Per-team breakdown — preserved for callers wanting to attribute
   *  dormancy to a particular team. The meta-watchdog summary doesn't
   *  surface this directly; it's here so a future status verb can. */
  perTeam: ReadonlyArray<{
    team: string;
    openComplaints: number;
    latestAttemptedAtSec: number | null;
  }>;
}

export interface GatherSuperdoctorActivityDeps {
  /** Epoch-seconds at observation time. Used to compute the oldest
   *  complaint's age. Test injection. */
  nowSec: number;
  /** Override the per-team state.db path resolver (defaults to
   *  `<team.root>/.atmux/state.db`). Test injection. */
  stateDbPathFor?: (team: MetaWatchdogTeam) => string;
}

/** Aggregate superdoctor liveness across every team in `teams`.
 *  Per-team probe failures (missing state.db, schema drift, locked
 *  WAL) are collapsed silently — the meta-watchdog must not crash the
 *  cockpit-wide pulse tick. The team is simply skipped from the
 *  aggregate. */
export function gatherSuperdoctorActivity(
  teams: ReadonlyArray<MetaWatchdogTeam>,
  deps: GatherSuperdoctorActivityDeps,
): SuperdoctorActivity {
  const resolveDbPath =
    deps.stateDbPathFor ?? ((t: MetaWatchdogTeam) => join(t.root, ".atmux", "state.db"));
  let openComplaints = 0;
  let latestAttemptedAtSec: number | null = null;
  let oldest: OldestComplaintRow | null = null;
  const perTeam: Array<{
    team: string;
    openComplaints: number;
    latestAttemptedAtSec: number | null;
  }> = [];

  for (const team of teams) {
    const path = resolveDbPath(team);
    // t-584b5f37 cluster 10 fix: `openDatabase` opens with `create:true`
    // (bun:sqlite default; sqlite.ts:33), so probing a team without an
    // existing state.db SIDE-EFFECTS the team's `.atmux/` by creating an
    // empty DB + applying migrations. Downstream readers of
    // `loadKanban` then see state.db as the canonical store via
    // `_useSqlite` and silently report empty kanban — even when the
    // team has a populated kanban.json. Skip the probe entirely when
    // the team has no state.db on disk; matches the meta-watchdog
    // contract that it only reads existing complaint stores and
    // never coerces a team's storage shape.
    if (!existsSync(path)) {
      // Match the legacy "skip-on-probe-failure" semantic that the
      // existing missing-state.db test already pinned (line 161): no
      // perTeam entry, no aggregate contribution. Cluster 10's fix
      // changes WHEN the skip fires (existence check up front instead
      // of openDatabase throwing on an invalid path); the no-entry
      // outcome stays identical.
      continue;
    }
    let db: ReturnType<typeof openDatabase> | null = null;
    try {
      db = openDatabase(path, migrations);
      const openRow = db
        .query("SELECT COUNT(*) AS n FROM complaints WHERE status = 'open'")
        .get() as { n: number } | null;
      const teamOpen = openRow?.n ?? 0;
      const latestRow = db
        .query("SELECT MAX(attempted_at) AS max FROM superdoctor_attempts")
        .get() as { max: number | null } | null;
      const teamLatest = latestRow?.max ?? null;
      const oldestRow = db
        .query(
          "SELECT incident_summary AS summary, opened_at AS openedAt FROM complaints WHERE status = 'open' ORDER BY opened_at ASC LIMIT 1",
        )
        .get() as { summary: string; openedAt: number } | null;

      openComplaints += teamOpen;
      if (teamLatest !== null) {
        if (latestAttemptedAtSec === null || teamLatest > latestAttemptedAtSec) {
          latestAttemptedAtSec = teamLatest;
        }
      }
      if (oldestRow !== null) {
        const ageSec = Math.max(0, deps.nowSec - oldestRow.openedAt);
        if (oldest === null || ageSec > oldest.ageSec) {
          oldest = {
            team: team.name,
            summary: oldestRow.summary,
            ageSec,
          };
        }
      }

      perTeam.push({
        team: team.name,
        openComplaints: teamOpen,
        latestAttemptedAtSec: teamLatest,
      });
    } catch {
      // Probe failure — skip this team silently. The meta-watchdog
      // is a probe; a malformed team DB shouldn't crash the
      // cockpit-wide pulse tick. `doctor` surfaces the schema row.
    } finally {
      if (db !== null) closeDatabase(db);
    }
  }

  return { openComplaints, latestAttemptedAtSec, oldest, perTeam };
}

/** The dormancy threshold per t-351318dc: superdoctor is dormant when
 *  its last attempt is more than 2 hours stale (or there's been no
 *  attempt at all). */
export const META_WATCHDOG_DORMANCY_SEC = 2 * 60 * 60;

/** Prior state for the meta-watchdog dedup ladder. */
export interface MetaWatchdogPriorState {
  /** True iff we've already paged during the current dormancy streak. */
  paged: boolean;
  /** Epoch-seconds when the current streak started. Null when not in
   *  a streak. */
  dormantSinceSec: number | null;
}

export interface MetaWatchdogDecision {
  /** Whether dormancy is observed THIS tick. */
  isDormant: boolean;
  /** Whether to emit the Discord page THIS tick. False when (a) not
   *  dormant or (b) already paged during the current streak. */
  shouldFire: boolean;
  /** Reason classifier for observability — surfaced in test
   *  assertions and (optionally) per-tick logs. */
  reason: "not-dormant" | "first-page" | "dedup-suppress";
  /** Next state to persist. The caller writes this onto pulse-state
   *  regardless of `shouldFire` so streak-end transitions also stick. */
  next: MetaWatchdogPriorState;
}

export interface DecideMetaWatchdogFireInputs {
  activity: SuperdoctorActivity;
  prior: MetaWatchdogPriorState | null;
  nowSec: number;
  /** Override the dormancy threshold (test injection); defaults to
   *  the canonical 2h. */
  dormancyThresholdSec?: number;
}

/** Pure policy: decide whether to emit a meta-watchdog page this
 *  tick, and compute the next dedup state. */
export function decideMetaWatchdogFire(inputs: DecideMetaWatchdogFireInputs): MetaWatchdogDecision {
  const threshold = inputs.dormancyThresholdSec ?? META_WATCHDOG_DORMANCY_SEC;
  const priorPaged = inputs.prior?.paged === true;
  const priorSince = inputs.prior?.dormantSinceSec ?? null;

  const hasOpenComplaints = inputs.activity.openComplaints > 0;
  const stale =
    inputs.activity.latestAttemptedAtSec === null ||
    inputs.nowSec - inputs.activity.latestAttemptedAtSec >= threshold;
  const isDormant = hasOpenComplaints && stale;

  if (!isDormant) {
    return {
      isDormant: false,
      shouldFire: false,
      reason: "not-dormant",
      next: { paged: false, dormantSinceSec: null },
    };
  }

  // Dormant. Continuing-streak vs fresh-streak by prior.dormantSinceSec.
  const dormantSinceSec = priorSince ?? inputs.nowSec;
  if (priorPaged && priorSince !== null) {
    return {
      isDormant: true,
      shouldFire: false,
      reason: "dedup-suppress",
      next: { paged: true, dormantSinceSec: priorSince },
    };
  }
  return {
    isDormant: true,
    shouldFire: true,
    reason: "first-page",
    next: { paged: true, dormantSinceSec },
  };
}
