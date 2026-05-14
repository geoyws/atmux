// Unit tests for src/core/superdoctor-activity.ts (t-351318dc).
//
// Covers:
//   - gatherSuperdoctorActivity: per-team SQLite probes + aggregates.
//     Probe failures collapse silently (the meta-watchdog must not
//     crash the cockpit-wide pulse tick).
//   - decideMetaWatchdogFire: pure policy fn — dormancy gate +
//     1-page-per-streak dedup ladder.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { ComplaintsRepo } from "../../../src/core/repositories/complaints-repo.ts";
import { SuperdoctorAttemptsRepo } from "../../../src/core/repositories/superdoctor-attempts-repo.ts";
import {
  decideMetaWatchdogFire,
  gatherSuperdoctorActivity,
  META_WATCHDOG_DORMANCY_SEC,
  type MetaWatchdogTeam,
} from "../../../src/core/superdoctor-activity.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atmux-sd-activity-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Build a team's state.db with given complaints + attempts rows. */
function seedTeam(
  teamRoot: string,
  complaints: Array<{ id: string; openedAt: number; status: "open" | "resolved"; summary: string }>,
  attempts: Array<{ complaintId: string; attemptedAt: number; outcome: "failed" | "resolved" }>,
): void {
  const atmuxDir = join(teamRoot, ".atmux");
  const stateDb = join(atmuxDir, "state.db");
  // mkdir -p — seedTeam is called from tests with fresh tmpdirs so
  // the parent doesn't exist yet.
  // Synchronous via bun:sqlite create+open will fail if dir missing.
  require("node:fs").mkdirSync(atmuxDir, { recursive: true });
  const db = openDatabase(stateDb, migrations);
  try {
    const cr = new ComplaintsRepo(db);
    for (const c of complaints) {
      cr.insert({
        id: c.id,
        openedAt: c.openedAt,
        openedBy: "test",
        incidentSummary: c.summary,
        rootCause: null,
        preventiveAsk: null,
        status: c.status,
        resolvedAt: c.status === "resolved" ? c.openedAt + 60 : null,
        resolvedBy: c.status === "resolved" ? "test" : null,
        relatedTaskId: null,
        sourceKind: null,
        sourceId: null,
        targetTeam: null,
        extra: {},
      });
    }
    const ar = new SuperdoctorAttemptsRepo(db);
    let n = 1;
    for (const a of attempts) {
      ar.insert({
        complaintId: a.complaintId,
        attemptN: n++,
        outcome: a.outcome,
        attemptedAt: a.attemptedAt,
        action: null,
        note: null,
        extra: {},
      });
    }
  } finally {
    closeDatabase(db);
  }
}

// ---------- gatherSuperdoctorActivity ----------

describe("gatherSuperdoctorActivity", () => {
  test("aggregates open complaints + latest attempt across teams", async () => {
    const teamA = join(dir, "teamA");
    const teamB = join(dir, "teamB");
    await mkdir(teamA, { recursive: true });
    await mkdir(teamB, { recursive: true });
    seedTeam(
      teamA,
      [
        { id: "c-a1", openedAt: 1000, status: "open", summary: "A complaint 1" },
        { id: "c-a2", openedAt: 2000, status: "resolved", summary: "A complaint 2 (resolved)" },
      ],
      [{ complaintId: "c-a1", attemptedAt: 1500, outcome: "failed" }],
    );
    seedTeam(
      teamB,
      [{ id: "c-b1", openedAt: 1100, status: "open", summary: "B complaint 1" }],
      [{ complaintId: "c-b1", attemptedAt: 1800, outcome: "failed" }],
    );

    const teams: MetaWatchdogTeam[] = [
      { name: "teamA", root: teamA },
      { name: "teamB", root: teamB },
    ];
    const activity = gatherSuperdoctorActivity(teams, { nowSec: 5000 });

    expect(activity.openComplaints).toBe(2);
    expect(activity.latestAttemptedAtSec).toBe(1800);
    expect(activity.oldest).not.toBeNull();
    expect(activity.oldest?.team).toBe("teamA");
    expect(activity.oldest?.summary).toBe("A complaint 1");
    expect(activity.oldest?.ageSec).toBe(5000 - 1000);
    expect(activity.perTeam).toHaveLength(2);
  });

  test("zero teams → zero everything, null oldest", () => {
    const activity = gatherSuperdoctorActivity([], { nowSec: 5000 });
    expect(activity.openComplaints).toBe(0);
    expect(activity.latestAttemptedAtSec).toBeNull();
    expect(activity.oldest).toBeNull();
    expect(activity.perTeam).toHaveLength(0);
  });

  test("missing state.db on a team → skipped silently", async () => {
    const teamA = join(dir, "teamA");
    const teamB = join(dir, "teamB-missing");
    await mkdir(teamA, { recursive: true });
    // teamB has no .atmux dir at all → openDatabase would create it
    // but the migrations would run on an empty DB → table queries
    // would return 0 / null. Acceptable degeneracy. Override
    // resolver to a path that simply doesn't exist.
    seedTeam(
      teamA,
      [{ id: "c-a1", openedAt: 1000, status: "open", summary: "A1" }],
      [{ complaintId: "c-a1", attemptedAt: 1500, outcome: "failed" }],
    );

    const teams: MetaWatchdogTeam[] = [
      { name: "teamA", root: teamA },
      { name: "teamB", root: teamB },
    ];
    const activity = gatherSuperdoctorActivity(teams, {
      nowSec: 5000,
      // Use a resolver that returns a path under a guaranteed-missing
      // parent so openDatabase's create:true can't materialise it.
      stateDbPathFor: (t) =>
        t.name === "teamB"
          ? "/proc/self/no-such-dir/state.db"
          : join(t.root, ".atmux", "state.db"),
    });

    expect(activity.openComplaints).toBe(1);
    expect(activity.latestAttemptedAtSec).toBe(1500);
    expect(activity.perTeam).toHaveLength(1);
    expect(activity.perTeam[0]?.team).toBe("teamA");
  });

  test("zero attempts but open complaints → latestAttemptedAtSec=null (cold cockpit)", async () => {
    const teamA = join(dir, "teamA");
    await mkdir(teamA, { recursive: true });
    seedTeam(
      teamA,
      [{ id: "c-a1", openedAt: 1000, status: "open", summary: "A1" }],
      [], // no attempts on record
    );
    const activity = gatherSuperdoctorActivity([{ name: "teamA", root: teamA }], { nowSec: 5000 });
    expect(activity.openComplaints).toBe(1);
    expect(activity.latestAttemptedAtSec).toBeNull();
  });
});

// ---------- decideMetaWatchdogFire ----------

describe("decideMetaWatchdogFire", () => {
  test("not dormant: zero open complaints → no fire, state reset", () => {
    const decision = decideMetaWatchdogFire({
      activity: { openComplaints: 0, latestAttemptedAtSec: null, oldest: null, perTeam: [] },
      prior: null,
      nowSec: 10000,
    });
    expect(decision.isDormant).toBe(false);
    expect(decision.shouldFire).toBe(false);
    expect(decision.reason).toBe("not-dormant");
    expect(decision.next.paged).toBe(false);
    expect(decision.next.dormantSinceSec).toBeNull();
  });

  test("not dormant: complaints exist but a fresh attempt cleared the streak", () => {
    const decision = decideMetaWatchdogFire({
      activity: {
        openComplaints: 3,
        latestAttemptedAtSec: 9999, // 1s ago
        oldest: null,
        perTeam: [],
      },
      prior: { paged: true, dormantSinceSec: 5000 },
      nowSec: 10000,
    });
    expect(decision.isDormant).toBe(false);
    expect(decision.shouldFire).toBe(false);
    expect(decision.next.paged).toBe(false);
  });

  test("dormant: first dormancy tick → fire + record streak start", () => {
    const decision = decideMetaWatchdogFire({
      activity: {
        openComplaints: 2,
        latestAttemptedAtSec: 10000 - META_WATCHDOG_DORMANCY_SEC - 1,
        oldest: null,
        perTeam: [],
      },
      prior: null,
      nowSec: 10000,
    });
    expect(decision.isDormant).toBe(true);
    expect(decision.shouldFire).toBe(true);
    expect(decision.reason).toBe("first-page");
    expect(decision.next.paged).toBe(true);
    expect(decision.next.dormantSinceSec).toBe(10000);
  });

  test("dormant: cold cockpit (no attempts ever) → fire", () => {
    const decision = decideMetaWatchdogFire({
      activity: { openComplaints: 1, latestAttemptedAtSec: null, oldest: null, perTeam: [] },
      prior: null,
      nowSec: 10000,
    });
    expect(decision.isDormant).toBe(true);
    expect(decision.shouldFire).toBe(true);
  });

  test("dormant: continuing streak → dedup suppress", () => {
    const decision = decideMetaWatchdogFire({
      activity: {
        openComplaints: 2,
        latestAttemptedAtSec: 5000,
        oldest: null,
        perTeam: [],
      },
      prior: { paged: true, dormantSinceSec: 8000 },
      nowSec: 20000,
    });
    expect(decision.isDormant).toBe(true);
    expect(decision.shouldFire).toBe(false);
    expect(decision.reason).toBe("dedup-suppress");
    // Streak start preserved.
    expect(decision.next.dormantSinceSec).toBe(8000);
  });

  test("dormancy threshold override is honoured", () => {
    const decision = decideMetaWatchdogFire({
      activity: {
        openComplaints: 1,
        latestAttemptedAtSec: 9500, // 500s ago
        oldest: null,
        perTeam: [],
      },
      prior: null,
      nowSec: 10000,
      dormancyThresholdSec: 300, // 5min — 500s qualifies as dormant
    });
    expect(decision.isDormant).toBe(true);
    expect(decision.shouldFire).toBe(true);
  });

  test("streak-end transition (paged → not-paged) is recorded in next state", () => {
    const decision = decideMetaWatchdogFire({
      activity: {
        openComplaints: 0, // complaints all resolved
        latestAttemptedAtSec: null,
        oldest: null,
        perTeam: [],
      },
      prior: { paged: true, dormantSinceSec: 5000 },
      nowSec: 10000,
    });
    expect(decision.shouldFire).toBe(false);
    expect(decision.next.paged).toBe(false);
    expect(decision.next.dormantSinceSec).toBeNull();
  });
});
