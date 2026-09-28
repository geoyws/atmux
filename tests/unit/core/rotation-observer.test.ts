// e-cc3728bf T1 — rotation observer core over injected snapshots.
// No tmux/git/kanban here: every IO rides ObserveDeps. DB-backed
// emit assertions use a temp state.db via the migrations pattern
// (tests/unit/core/epic-events.test.ts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import {
  DEFAULT_ROTATION_THRESHOLDS,
  STARVING_THRESHOLD_S,
  isCageStarving,
  isMemberNoProgress,
  isPaneStuck,
  observeTeam,
  resolveThresholds,
  type MemberActivity,
  type ObserveDeps,
  type PaneSnapshot,
} from "../../../src/core/rotation-observer.ts";

const MIN = 60_000;
const NOW = 1_787_000_000_000;

function snap(member: string, text: string, ageMs: number): PaneSnapshot {
  return { member, text, lastActivityMs: NOW - ageMs };
}

const STUCK_TEXT = "✻ Baked for 1m 51s\nsome prior output\n❯\n";
const LIVE_TEXT = "✻ Honking…\nthinking hard\n";
const SHELL_STUCK_TEXT = "✻ Cooked for 3m\noutput\ngeoyws@mbp ~ % \n$ \n";

describe("isPaneStuck", () => {
  test("idle READY pane with past-tense residue is stuck", () => {
    const got = isPaneStuck(snap("m1", STUCK_TEXT, 20 * MIN), DEFAULT_ROTATION_THRESHOLDS, NOW);
    expect(got?.member).toBe("m1");
    expect(got?.evidence).toMatch(/for 1m 51s/);
  });
  test("live turn (Honking, no elapsed suffix) is never stuck", () => {
    expect(isPaneStuck(snap("m1", LIVE_TEXT, 20 * MIN), DEFAULT_ROTATION_THRESHOLDS, NOW)).toBeNull();
  });
  test("fresh activity defeats residue", () => {
    expect(isPaneStuck(snap("m1", STUCK_TEXT, 1 * MIN), DEFAULT_ROTATION_THRESHOLDS, NOW)).toBeNull();
  });
  test("SHELL prompt with residue is stuck (TUI crashed mid-residue)", () => {
    const got = isPaneStuck(snap("m1", SHELL_STUCK_TEXT, 20 * MIN), DEFAULT_ROTATION_THRESHOLDS, NOW);
    expect(got?.member).toBe("m1");
  });
  test("residue without any idle prompt (UNKNOWN) is not stuck — missing data, not evidence", () => {
    expect(isPaneStuck(snap("m1", "✻ Baked for 1m 51s\n", 20 * MIN), DEFAULT_ROTATION_THRESHOLDS, NOW)).toBeNull();
  });
  test("idle READY pane without residue is not stuck", () => {
    expect(isPaneStuck(snap("m1", "prior output\n❯\n", 20 * MIN), DEFAULT_ROTATION_THRESHOLDS, NOW)).toBeNull();
  });
  test("MODAL pane with residue is not stuck (waiting on human, not wedged)", () => {
    expect(
      isPaneStuck(snap("m1", "Do you want to proceed?\n[Y/n]: \n✻ Baked for 1m 51s\n", 20 * MIN), DEFAULT_ROTATION_THRESHOLDS, NOW),
    ).toBeNull();
  });
  test("custom stuckAfterMs honored", () => {
    const th = resolveThresholds({ stuckAfterMs: 60 * MIN });
    expect(isPaneStuck(snap("m1", STUCK_TEXT, 20 * MIN), th, NOW)).toBeNull();
    expect(isPaneStuck(snap("m1", STUCK_TEXT, 61 * MIN), th, NOW)?.member).toBe("m1");
  });
});

describe("isMemberNoProgress", () => {
  const oldClaim = [{ taskId: "t-1", claimedAtMs: NOW - 61 * MIN }];
  test("stale claim + stale commit → no-progress with hoursIdle", () => {
    const got = isMemberNoProgress(
      { member: "m1", lastCommitMs: NOW - 31 * MIN, claims: oldClaim },
      DEFAULT_ROTATION_THRESHOLDS,
      NOW,
    );
    expect(got?.member).toBe("m1");
    expect(got?.hoursIdle).toBeCloseTo(61 / 60, 5);
  });
  test("stale claim + never committed → no-progress (lastCommit null)", () => {
    const got = isMemberNoProgress(
      { member: "m1", lastCommitMs: null, claims: oldClaim },
      DEFAULT_ROTATION_THRESHOLDS,
      NOW,
    );
    expect(got?.lastCommitMs).toBeNull();
  });
  test("no claims → null (idle, not stuck)", () => {
    expect(
      isMemberNoProgress({ member: "m1", lastCommitMs: NOW - 90 * MIN, claims: [] }, DEFAULT_ROTATION_THRESHOLDS, NOW),
    ).toBeNull();
  });
  test("fresh claim defeats stale commit", () => {
    expect(
      isMemberNoProgress(
        { member: "m1", lastCommitMs: NOW - 90 * MIN, claims: [{ taskId: "t-1", claimedAtMs: NOW - 5 * MIN }] },
        DEFAULT_ROTATION_THRESHOLDS,
        NOW,
      ),
    ).toBeNull();
  });
  test("fresh commit defeats stale claim", () => {
    expect(
      isMemberNoProgress(
        { member: "m1", lastCommitMs: NOW - 5 * MIN, claims: oldClaim },
        DEFAULT_ROTATION_THRESHOLDS,
        NOW,
      ),
    ).toBeNull();
  });
  test("oldest claim wins with several active", () => {
    const got = isMemberNoProgress(
      {
        member: "m1",
        lastCommitMs: null,
        claims: [{ taskId: "t-new", claimedAtMs: NOW - 5 * MIN }, { taskId: "t-old", claimedAtMs: NOW - 61 * MIN }],
      },
      DEFAULT_ROTATION_THRESHOLDS,
      NOW,
    );
    expect(got?.taskClaimedMs).toBe(NOW - 61 * MIN);
  });
});

describe("isCageStarving", () => {
  test("stale clock + cpu pressure → starving with sinceMs", () => {
    const got = isCageStarving(NOW - 61_000, { cpuPressure: 0.9, memPressure: 0.1 }, NOW);
    expect(got?.sinceMs).toBe(NOW - 61_000);
  });
  test("stale clock + low pressures → null", () => {
    expect(isCageStarving(NOW - 61_000, { cpuPressure: 0.2, memPressure: 0.3 }, NOW)).toBeNull();
  });
  test("fresh clock + pressure → null", () => {
    expect(isCageStarving(NOW - 10_000, { cpuPressure: 0.95, memPressure: 0.95 }, NOW)).toBeNull();
  });
  test("null load + stale clock → starving (idle duration is the signal)", () => {
    expect(isCageStarving(NOW - 61_000, null, NOW)?.cpuPressure).toBeNull();
  });
  test("boundary honors STARVING_THRESHOLD_S export (not a redefined copy)", () => {
    expect(STARVING_THRESHOLD_S).toBe(60);
    expect(isCageStarving(NOW - 59_000, { cpuPressure: 1, memPressure: 1 }, NOW)).toBeNull();
    expect(isCageStarving(NOW - 61_000, { cpuPressure: 1, memPressure: 1 }, NOW)).not.toBeNull();
  });
});

describe("resolveThresholds", () => {
  test("absent block → defaults", () => {
    expect(resolveThresholds(undefined)).toEqual(DEFAULT_ROTATION_THRESHOLDS);
  });
  test("partial block fills the rest", () => {
    expect(resolveThresholds({ stuckAfterMs: 1 }).stuckAfterMs).toBe(1);
    expect(resolveThresholds({ stuckAfterMs: 1 }).noProgressClaimMs).toBe(DEFAULT_ROTATION_THRESHOLDS.noProgressClaimMs);
  });
});

describe("observeTeam", () => {
  const depsFor = (over: Partial<ObserveDeps> = {}): ObserveDeps => ({
    capturePanes: () => [snap("m1", STUCK_TEXT, 20 * MIN)],
    readActivity: () => ({ member: "m1", lastCommitMs: NOW - 31 * MIN, claims: [{ taskId: "t-1", claimedAtMs: NOW - 61 * MIN }] }),
    readLoad: () => ({ cpuPressure: 0.9, memPressure: 0.1 }),
    nowMs: () => NOW,
    ...over,
  });

  test("classifies without db (no emit, findings returned)", async () => {
    const got = await observeTeam("atx", DEFAULT_ROTATION_THRESHOLDS, depsFor());
    expect(got.stuck.map((s) => s.member)).toEqual(["m1"]);
    expect(got.noProgress.map((n) => n.member)).toEqual(["m1"]);
    expect(got.starving?.sinceMs).toBe(NOW - 20 * MIN);
  });

  test("empty cage: no findings, no crash", async () => {
    const got = await observeTeam(
      "atx",
      DEFAULT_ROTATION_THRESHOLDS,
      depsFor({ capturePanes: () => [], readLoad: () => null }),
    );
    expect(got).toEqual({ stuck: [], noProgress: [], starving: null });
  });

  let dir = "";
  let db: Database | null = null;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-rotation-observe-"));
    db = openDatabase(join(dir, "state.db"), migrations);
  });
  afterEach(async () => {
    if (db !== null) closeDatabase(db);
    db = null;
    await rm(dir, { recursive: true, force: true });
  });

  test("emits all three topics with pinned clock", async () => {
    const got = await observeTeam("atx", DEFAULT_ROTATION_THRESHOLDS, depsFor(), db as Database);
    expect(got.stuck).toHaveLength(1);
    const rows = (db as Database).query("SELECT topic, payload FROM events ORDER BY topic").all() as Array<{
      topic: string;
      payload: string;
    }>;
    expect(rows.map((r) => r.topic)).toEqual(["cage.starving", "member.no-progress", "pane.stuck"]);
    const stuck = JSON.parse(rows[2]?.payload ?? "{}") as { member: string; observedAtSec: number };
    expect(stuck.member).toBe("m1");
    expect(stuck.observedAtSec).toBe(Math.floor(NOW / 1000));
  });

  test("clean cage emits nothing", async () => {
    await observeTeam(
      "atx",
      DEFAULT_ROTATION_THRESHOLDS,
      depsFor({ capturePanes: () => [snap("m1", LIVE_TEXT, 30_000)], readActivity: () => ({ member: "m1", lastCommitMs: NOW - 30_000, claims: [] } as MemberActivity), readLoad: () => null }),
      db as Database,
    );
    const rows = (db as Database).query("SELECT COUNT(*) AS n FROM events").all() as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(0);
  });
});
