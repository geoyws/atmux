// Unit tests for src/core/whip-escalation.ts (ADR-087 §T2 / Task t-e91fec98).
//
// Exercises the strikes-≥-threshold → complaint pipeline end-to-end:
// fresh complaint, dedup bump, strike-record reset, threshold gating,
// title/body templating. Combines an in-memory SQLite (for the
// complaints DB) with a real `.atmux/state/` directory (for the whip-
// strikes file IO).

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { ComplaintsRepo } from "../../../src/core/repositories/complaints-repo.ts";
import {
  buildComplaintBody,
  buildComplaintTitle,
  DEFAULT_STRIKE_THRESHOLD,
  type MaybeEscalateResult,
  maybeEscalateStrikes,
} from "../../../src/core/whip-escalation.ts";
import {
  etaLiedSymptomHash,
  incrementStrike,
  readStrikeRecord,
  type StrikeRecord,
} from "../../../src/core/whip-strikes.ts";

let teamDir: string;
let atmuxDir: string;
let db: Database;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-whip-esc-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  db = openDatabase(join(atmuxDir, "state.db"), migrations);
});

afterEach(async () => {
  closeDatabase(db);
  await rm(teamDir, { recursive: true, force: true });
});

function strikeRecord(count: number, firstSec: number, nowSec: number): StrikeRecord {
  return {
    count,
    firstStrikeSec: count > 0 ? firstSec : null,
    lastStrikeSec: count > 0 ? nowSec : null,
    lastReason: count > 0 ? "BAD: 0 commits in 60min window" : null,
  };
}

// ---------- Constants ----------

describe("DEFAULT_STRIKE_THRESHOLD", () => {
  test("matches Task t-e91fec98 §1 default of 3", () => {
    expect(DEFAULT_STRIKE_THRESHOLD).toBe(3);
  });
});

// ---------- Threshold gating ----------

describe("maybeEscalateStrikes — below threshold", () => {
  test("returns below-threshold for count=0", async () => {
    const result = await maybeEscalateStrikes({
      db,
      atmuxDir,
      teamName: "team-a",
      symptomHash: etaLiedSymptomHash("team-a"),
      symptomLabel: "eta-lied",
      observableEvidence: "lead picked D 0 times",
      whipMenusTried: 0,
      unshippedTasks: [],
      record: strikeRecord(0, 0, 0),
      nowSec: 1000,
    });

    expect(result.kind).toBe("below-threshold");
    if (result.kind === "below-threshold") {
      expect(result.strikes).toBe(0);
      expect(result.threshold).toBe(3);
    }

    // No DB write
    const repo = new ComplaintsRepo(db);
    expect(repo.list().length).toBe(0);
  });

  test("returns below-threshold for count=2 (just under default)", async () => {
    const result = await maybeEscalateStrikes({
      db,
      atmuxDir,
      teamName: "team-a",
      symptomHash: etaLiedSymptomHash("team-a"),
      symptomLabel: "eta-lied",
      observableEvidence: "x",
      whipMenusTried: 2,
      unshippedTasks: [],
      record: strikeRecord(2, 800, 1000),
      nowSec: 1000,
    });

    expect(result.kind).toBe("below-threshold");
  });

  test("custom threshold respected — count=2 below threshold=5", async () => {
    const result = await maybeEscalateStrikes({
      db,
      atmuxDir,
      teamName: "team-a",
      symptomHash: etaLiedSymptomHash("team-a"),
      symptomLabel: "eta-lied",
      observableEvidence: "x",
      whipMenusTried: 2,
      unshippedTasks: [],
      record: strikeRecord(2, 800, 1000),
      nowSec: 1000,
      strikeThreshold: 5,
    });
    expect(result.kind).toBe("below-threshold");
  });
});

// ---------- Threshold met — fresh file ----------

describe("maybeEscalateStrikes — fresh file at threshold", () => {
  test("count=3 (exactly threshold) files a fresh complaint", async () => {
    const result = await maybeEscalateStrikes({
      db,
      atmuxDir,
      teamName: "team-a",
      symptomHash: etaLiedSymptomHash("team-a"),
      symptomLabel: "eta-lied",
      observableEvidence: "lead picked D=Standby 3 times without ETA hitting",
      whipMenusTried: 3,
      unshippedTasks: ["t-aaaa1111", "t-bbbb2222"],
      record: strikeRecord(3, 800, 2000),
      nowSec: 2000,
    });

    expect(result.kind).toBe("filed");
    if (result.kind === "filed") {
      expect(result.isNew).toBe(true);
      expect(result.sourceCount).toBe(1);
      expect(result.complaintId).toMatch(/^c-[0-9a-f]{8}$/);
    }

    const repo = new ComplaintsRepo(db);
    expect(repo.list().length).toBe(1);
  });

  test("count > threshold also fires", async () => {
    const result = await maybeEscalateStrikes({
      db,
      atmuxDir,
      teamName: "team-a",
      symptomHash: etaLiedSymptomHash("team-a"),
      symptomLabel: "eta-lied",
      observableEvidence: "x",
      whipMenusTried: 5,
      unshippedTasks: [],
      record: strikeRecord(5, 800, 2000),
      nowSec: 2000,
    });
    expect(result.kind).toBe("filed");
  });

  test("complaint carries expected schema fields", async () => {
    const result = await maybeEscalateStrikes({
      db,
      atmuxDir,
      teamName: "team-a",
      symptomHash: etaLiedSymptomHash("team-a"),
      symptomLabel: "eta-lied",
      observableEvidence: "5 standby picks",
      whipMenusTried: 3,
      unshippedTasks: ["t-xx"],
      record: strikeRecord(3, 800, 2000),
      nowSec: 2000,
    });

    if (result.kind !== "filed") throw new Error("expected filed");
    const repo = new ComplaintsRepo(db);
    const c = repo.getById(result.complaintId);
    expect(c).not.toBeNull();
    expect(c?.sourceKind).toBe("whip");
    expect(c?.sourceId).toBe("whip-team-a-eta-lied");
    expect(c?.targetTeam).toBe("team-a");
    expect(c?.openedBy).toBe("whip:team-a");
    expect(c?.status).toBe("open");
    expect(c?.openedAt).toBe(2000);
    expect(c?.incidentSummary).toContain("team-a");
    expect(c?.incidentSummary).toContain("eta-lied");
    expect(c?.incidentSummary).toContain("5 standby picks");
    expect(c?.incidentSummary).toContain("whip-tried-3-menus");
    expect(c?.extra.kind).toBe("heads-up");
    expect(c?.extra.severity).toBe("high");
    expect(c?.extra.source_count).toBe(1);
    expect(c?.extra.last_seen).toBe(2000);
  });

  test("complaint body contains strike timeline + unshipped task list", async () => {
    const result = await maybeEscalateStrikes({
      db,
      atmuxDir,
      teamName: "team-a",
      symptomHash: etaLiedSymptomHash("team-a"),
      symptomLabel: "eta-lied",
      observableEvidence: "x",
      whipMenusTried: 3,
      unshippedTasks: ["t-aa", "t-bb"],
      // First strike at 800s, now 2000s — Δt = 1200s = 20 min
      record: strikeRecord(3, 800, 2000),
      nowSec: 2000,
    });
    if (result.kind !== "filed") throw new Error("expected filed");
    const repo = new ComplaintsRepo(db);
    const c = repo.getById(result.complaintId);
    expect(c?.rootCause).toContain("strikes 0→3 over Δt=20min");
    expect(c?.rootCause).toContain("unshipped tasks: t-aa, t-bb");
  });

  test("strike record is reset after filing", async () => {
    // Seed a real strike record on disk via incrementStrike (3 strikes
    // worth) — then verify the escalator wipes it.
    const hash = etaLiedSymptomHash("team-a");
    await incrementStrike(atmuxDir, "team-a", hash, "first", 1000);
    await incrementStrike(atmuxDir, "team-a", hash, "second", 1100);
    const final = await incrementStrike(atmuxDir, "team-a", hash, "third", 1200);

    await maybeEscalateStrikes({
      db,
      atmuxDir,
      teamName: "team-a",
      symptomHash: hash,
      symptomLabel: "eta-lied",
      observableEvidence: "x",
      whipMenusTried: 3,
      unshippedTasks: [],
      record: final,
      nowSec: 2000,
    });

    const afterReset = await readStrikeRecord(atmuxDir, "team-a", hash);
    expect(afterReset.count).toBe(0);
    expect(afterReset.firstStrikeSec).toBeNull();
  });
});

// ---------- Dedup bump ----------

describe("maybeEscalateStrikes — dedup bump", () => {
  test("second escalation within window bumps existing complaint", async () => {
    const hash = etaLiedSymptomHash("team-a");

    // First file at t=2000
    const first = await maybeEscalateStrikes({
      db,
      atmuxDir,
      teamName: "team-a",
      symptomHash: hash,
      symptomLabel: "eta-lied",
      observableEvidence: "first",
      whipMenusTried: 3,
      unshippedTasks: [],
      record: strikeRecord(3, 1800, 2000),
      nowSec: 2000,
    });
    if (first.kind !== "filed") throw new Error("first should file");
    expect(first.isNew).toBe(true);

    // Second file 30min later (well within 1h window) at t=3800
    const second = await maybeEscalateStrikes({
      db,
      atmuxDir,
      teamName: "team-a",
      symptomHash: hash,
      symptomLabel: "eta-lied",
      observableEvidence: "second",
      whipMenusTried: 6,
      unshippedTasks: [],
      record: strikeRecord(3, 3600, 3800),
      nowSec: 3800,
    });

    expect(second.kind).toBe("filed");
    if (second.kind === "filed") {
      expect(second.isNew).toBe(false);
      expect(second.complaintId).toBe(first.complaintId);
      expect(second.sourceCount).toBe(2);
    }

    // Only one row exists
    const repo = new ComplaintsRepo(db);
    expect(repo.list().length).toBe(1);
  });

  test("strike record is also reset on a bump (not just fresh files)", async () => {
    const hash = etaLiedSymptomHash("team-a");
    // Pre-existing complaint via direct insert
    await maybeEscalateStrikes({
      db,
      atmuxDir,
      teamName: "team-a",
      symptomHash: hash,
      symptomLabel: "eta-lied",
      observableEvidence: "first",
      whipMenusTried: 3,
      unshippedTasks: [],
      record: strikeRecord(3, 1800, 2000),
      nowSec: 2000,
    });

    // Seed real strikes on disk (simulating another BAD streak after
    // the first complaint was filed)
    await incrementStrike(atmuxDir, "team-a", hash, "fourth", 2500);
    await incrementStrike(atmuxDir, "team-a", hash, "fifth", 2600);
    const sixth = await incrementStrike(atmuxDir, "team-a", hash, "sixth", 2700);

    await maybeEscalateStrikes({
      db,
      atmuxDir,
      teamName: "team-a",
      symptomHash: hash,
      symptomLabel: "eta-lied",
      observableEvidence: "second",
      whipMenusTried: 6,
      unshippedTasks: [],
      record: sixth,
      nowSec: 2700,
    });

    const afterReset = await readStrikeRecord(atmuxDir, "team-a", hash);
    expect(afterReset.count).toBe(0);
  });
});

// ---------- Per-symptom + per-team isolation ----------

describe("maybeEscalateStrikes — per-symptom + per-team isolation", () => {
  test("different symptoms file independent complaints", async () => {
    const etaHash = etaLiedSymptomHash("team-a");
    const csHash = `whip-team-a-classifier-swallow`;

    await maybeEscalateStrikes({
      db,
      atmuxDir,
      teamName: "team-a",
      symptomHash: etaHash,
      symptomLabel: "eta-lied",
      observableEvidence: "x",
      whipMenusTried: 3,
      unshippedTasks: [],
      record: strikeRecord(3, 800, 2000),
      nowSec: 2000,
    });
    await maybeEscalateStrikes({
      db,
      atmuxDir,
      teamName: "team-a",
      symptomHash: csHash,
      symptomLabel: "classifier-swallow",
      observableEvidence: "x",
      whipMenusTried: 3,
      unshippedTasks: [],
      record: strikeRecord(3, 900, 2100),
      nowSec: 2100,
    });

    const repo = new ComplaintsRepo(db);
    expect(repo.list().length).toBe(2);
  });

  test("escalating team A's symptom doesn't reset team B's strikes", async () => {
    const aHash = etaLiedSymptomHash("team-a");
    const bHash = etaLiedSymptomHash("team-b");
    // Seed team-b strikes (independent file)
    await incrementStrike(atmuxDir, "team-b", bHash, "x", 1000);
    await incrementStrike(atmuxDir, "team-b", bHash, "x", 1100);

    // Seed team-a strikes
    await incrementStrike(atmuxDir, "team-a", aHash, "x", 1000);
    await incrementStrike(atmuxDir, "team-a", aHash, "x", 1100);
    const aFinal = await incrementStrike(atmuxDir, "team-a", aHash, "x", 1200);

    await maybeEscalateStrikes({
      db,
      atmuxDir,
      teamName: "team-a",
      symptomHash: aHash,
      symptomLabel: "eta-lied",
      observableEvidence: "x",
      whipMenusTried: 3,
      unshippedTasks: [],
      record: aFinal,
      nowSec: 2000,
    });

    const teamAAfter = await readStrikeRecord(atmuxDir, "team-a", aHash);
    const teamBAfter = await readStrikeRecord(atmuxDir, "team-b", bHash);
    expect(teamAAfter.count).toBe(0);
    expect(teamBAfter.count).toBe(2); // untouched
  });
});

// ---------- Title / body builders ----------

describe("buildComplaintTitle", () => {
  test("formats per Task t-e91fec98 §3", () => {
    expect(
      buildComplaintTitle({
        teamName: "atmux",
        symptomLabel: "eta-lied",
        observableEvidence: "5 standby picks",
        whipMenusTried: 3,
      }),
    ).toBe("atmux: eta-lied · 5 standby picks · whip-tried-3-menus");
  });

  test("preserves the · separator even with zero menus", () => {
    expect(
      buildComplaintTitle({
        teamName: "x",
        symptomLabel: "y",
        observableEvidence: "z",
        whipMenusTried: 0,
      }),
    ).toBe("x: y · z · whip-tried-0-menus");
  });
});

describe("buildComplaintBody", () => {
  test("joins timeline + task list with '. '", () => {
    const body = buildComplaintBody({
      record: strikeRecord(3, 800, 2000),
      nowSec: 2000,
      unshippedTasks: ["t-aa", "t-bb"],
    });
    expect(body).toBe(
      "strikes 0→3 over Δt=20min; last reason: BAD: 0 commits in 60min window. unshipped tasks: t-aa, t-bb.",
    );
  });

  test("renders empty unshipped list as 'no unshipped tasks tracked'", () => {
    const body = buildComplaintBody({
      record: strikeRecord(3, 800, 2000),
      nowSec: 2000,
      unshippedTasks: [],
    });
    expect(body).toContain("no unshipped tasks tracked");
  });

  test("renders empty strike record as 'no strikes recorded'", () => {
    const body = buildComplaintBody({
      record: strikeRecord(0, 0, 0),
      nowSec: 2000,
      unshippedTasks: ["t-aa"],
    });
    expect(body).toContain("no strikes recorded");
  });
});

// ---------- Result type discrimination ----------

describe("MaybeEscalateResult — discriminated union", () => {
  test("below-threshold result carries strikes + threshold (no complaintId)", async () => {
    const result: MaybeEscalateResult = await maybeEscalateStrikes({
      db,
      atmuxDir,
      teamName: "team-a",
      symptomHash: etaLiedSymptomHash("team-a"),
      symptomLabel: "eta-lied",
      observableEvidence: "x",
      whipMenusTried: 0,
      unshippedTasks: [],
      record: strikeRecord(1, 1000, 1000),
      nowSec: 1000,
    });
    expect(result.kind).toBe("below-threshold");
    if (result.kind === "below-threshold") {
      expect(typeof result.strikes).toBe("number");
      expect(typeof result.threshold).toBe("number");
    }
  });
});
