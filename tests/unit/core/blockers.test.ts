// Unit tests for src/core/blockers.ts (ADR-152 T1 / Task t-8f3061ef).
//
// Coverage strategy: one focused `describe` block per surface helper +
// an integration block exercising `queryAllBlockers` end-to-end against
// all 7 surfaces seeded in the same temp dir. Helper-level tests use
// in-memory SQLite + tiny markdown fixtures; integration confirms the
// fan-out ordering + cross-surface row-uniqueness contract.

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import {
  BLOCKER_CLASSES,
  BLOCKER_SOURCES,
  isBlockerClass,
  isBlockerSource,
  liftClassFromText,
  parseMytTimestampHHMM,
  queryAllBlockers,
  readBlockedTasks,
  readDriverInboxBlockers,
  readOpenComplaints,
  readOpenFlagsMd,
  readPendingDecisionsMd,
  readStaleInProgressTasks,
  readStuckMergerState,
  truncate,
} from "../../../src/core/blockers.ts";

let teamDir: string;
let db: Database;
const FIXED_NOW = 1_780_000_000;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-blockers-"));
  db = openDatabase(join(teamDir, "state.db"), migrations);
});

afterEach(async () => {
  closeDatabase(db);
  await rm(teamDir, { recursive: true, force: true });
});

// ---------- Taxonomy + helpers ----------

describe("BLOCKER_CLASSES + isBlockerClass", () => {
  test("includes the 8 documented classes per ADR-152 §taxonomy", () => {
    expect(BLOCKER_CLASSES).toContain("decision-pending");
    expect(BLOCKER_CLASSES).toContain("member-stuck");
    expect(BLOCKER_CLASSES).toContain("dep-not-shipped");
    expect(BLOCKER_CLASSES).toContain("push-policy-gate");
    expect(BLOCKER_CLASSES.length).toBe(8);
  });

  test("isBlockerClass narrows to declared union", () => {
    expect(isBlockerClass("decision-pending")).toBe(true);
    expect(isBlockerClass("nonsense")).toBe(false);
  });
});

describe("BLOCKER_SOURCES + isBlockerSource", () => {
  test("enumerates the 7 surfaces", () => {
    expect(BLOCKER_SOURCES.length).toBe(7);
    expect(BLOCKER_SOURCES).toContain("sqlite-tasks-blocked");
    expect(BLOCKER_SOURCES).toContain("md-driver-inbox");
  });
});

describe("truncate", () => {
  test("squashes whitespace + caps length", () => {
    expect(truncate("   hello\n   world  ")).toBe("hello world");
    expect(truncate("a".repeat(150), 10)).toBe(`${"a".repeat(9)}…`);
  });
});

describe("liftClassFromText", () => {
  test("[class:X] explicit token wins", () => {
    expect(liftClassFromText("hello [class:tooling-broken]")).toBe("tooling-broken");
  });
  test("leading 🔵 → decision-pending", () => {
    expect(liftClassFromText("🔵 needs an answer")).toBe("decision-pending");
  });
  test("leading ⏳ → review-pending", () => {
    expect(liftClassFromText("⏳ waiting on reviewer")).toBe("review-pending");
  });
  test("no signal → null", () => {
    expect(liftClassFromText("just plain text")).toBeNull();
  });
});

describe("parseMytTimestampHHMM", () => {
  test("returns 0 on bad shape", () => {
    expect(parseMytTimestampHHMM("nope", FIXED_NOW)).toBe(0);
    expect(parseMytTimestampHHMM("25:00", FIXED_NOW)).toBe(0);
  });
  test("anchors to the same MYT day as nowSec", () => {
    const ts = parseMytTimestampHHMM("12:00", FIXED_NOW);
    expect(ts).toBeGreaterThan(0);
    expect(Math.abs(ts - FIXED_NOW)).toBeLessThan(86_400);
  });
});

// ---------- Surface 1: blocked tasks ----------

describe("readBlockedTasks", () => {
  test("dep-not-shipped when any dep is not done", () => {
    db.exec(
      "INSERT INTO tasks (id, subject, status, deps, created_at) VALUES ('t-x', 'subj', 'blocked', json_array('t-dep'), 100)",
    );
    db.exec(
      "INSERT INTO tasks (id, subject, status, created_at) VALUES ('t-dep', 'dep-subj', 'todo', 90)",
    );
    const rows = readBlockedTasks(db, FIXED_NOW);
    expect(rows.length).toBe(1);
    expect(rows[0]?.blocker_class).toBe("dep-not-shipped");
    expect(rows[0]?.suggested_action).toContain("t-dep");
    expect(rows[0]?.related_task_id).toBe("t-x");
  });

  test("member-stuck when deps are empty or all done", () => {
    db.exec(
      "INSERT INTO tasks (id, subject, status, deps, created_at) VALUES ('t-y', 'subj-y', 'blocked', json_array(), 200)",
    );
    db.exec(
      "INSERT INTO tasks (id, subject, status, deps, created_at) VALUES ('t-z', 'subj-z', 'blocked', json_array('t-done'), 200)",
    );
    db.exec(
      "INSERT INTO tasks (id, subject, status, created_at) VALUES ('t-done', 'done-subj', 'done', 90)",
    );
    const rows = readBlockedTasks(db, FIXED_NOW);
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.blocker_class).toBe("member-stuck");
    }
  });
});

// ---------- Surface 2: stale in-progress tasks ----------

describe("readStaleInProgressTasks", () => {
  test("emits row when claim age exceeds default", () => {
    const claimedAt = FIXED_NOW - 25 * 3600;
    db.exec(
      `INSERT INTO tasks (id, subject, status, owner, claimed_at) VALUES ('t-stale', 'sleepy', 'in-progress', 'foo', ${claimedAt})`,
    );
    const rows = readStaleInProgressTasks(db, FIXED_NOW, 24 * 3600);
    expect(rows.length).toBe(1);
    expect(rows[0]?.blocker_class).toBe("stale-claim");
    expect(rows[0]?.suggested_action).toContain("foo");
  });

  test("respects per-task stale_min override", () => {
    const claimedAt = FIXED_NOW - 30 * 60;
    db.exec(
      `INSERT INTO tasks (id, subject, status, owner, claimed_at, stale_min) VALUES ('t-tight', 'tight', 'in-progress', 'bar', ${claimedAt}, 15)`,
    );
    const rows = readStaleInProgressTasks(db, FIXED_NOW, 24 * 3600);
    expect(rows.length).toBe(1);
  });

  test("suppresses fresh claims", () => {
    const claimedAt = FIXED_NOW - 60;
    db.exec(
      `INSERT INTO tasks (id, status, owner, claimed_at) VALUES ('t-fresh', 'in-progress', 'foo', ${claimedAt})`,
    );
    const rows = readStaleInProgressTasks(db, FIXED_NOW, 24 * 3600);
    expect(rows.length).toBe(0);
  });
});

// ---------- Surface 3: open complaints ----------

describe("readOpenComplaints", () => {
  test("default class tooling-broken; lifts from extra.blocker_class", () => {
    db.exec(
      `INSERT INTO complaints (id, opened_at, incident_summary, status, source_kind) VALUES ('c-1', ${FIXED_NOW - 100}, 'pipeline broke', 'open', 'medic')`,
    );
    db.exec(
      `INSERT INTO complaints (id, opened_at, incident_summary, status, extra) VALUES ('c-2', ${FIXED_NOW - 200}, 'review backlog', 'open', '{"blocker_class":"review-pending"}')`,
    );
    const rows = readOpenComplaints(db, FIXED_NOW);
    expect(rows.length).toBe(2);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("complaint:c-1")?.blocker_class).toBe("tooling-broken");
    expect(byId.get("complaint:c-2")?.blocker_class).toBe("review-pending");
  });

  test("ignores resolved complaints", () => {
    db.exec(
      `INSERT INTO complaints (id, opened_at, incident_summary, status) VALUES ('c-r', ${FIXED_NOW - 100}, 'fixed', 'resolved')`,
    );
    expect(readOpenComplaints(db, FIXED_NOW).length).toBe(0);
  });
});

// ---------- Surface 4: stuck merger_state ----------

describe("readStuckMergerState", () => {
  test("conflict → tooling-broken; reverted → push-policy-gate", () => {
    db.exec(
      `INSERT INTO merger_state (member_branch, state, transitioned_at) VALUES ('geoyws-foo', 'conflict', ${FIXED_NOW - 50})`,
    );
    db.exec(
      `INSERT INTO merger_state (member_branch, state, transitioned_at) VALUES ('geoyws-bar', 'reverted', ${FIXED_NOW - 100})`,
    );
    const rows = readStuckMergerState(db, FIXED_NOW);
    expect(rows.length).toBe(2);
    const byBranch = new Map(rows.map((r) => [r.id, r]));
    expect(byBranch.get("merger:geoyws-foo")?.blocker_class).toBe("tooling-broken");
    expect(byBranch.get("merger:geoyws-bar")?.blocker_class).toBe("push-policy-gate");
  });

  test("ignores merged state", () => {
    db.exec(
      `INSERT INTO merger_state (member_branch, state, transitioned_at) VALUES ('geoyws-clean', 'merged', ${FIXED_NOW - 50})`,
    );
    expect(readStuckMergerState(db, FIXED_NOW).length).toBe(0);
  });
});

// ---------- Surface 5: decisions.md ----------

describe("readPendingDecisionsMd", () => {
  test("surfaces unstruck decision rows", async () => {
    const md = `# decisions

### d-1e549002 — OQ-1: which branch first? [high] (22:55 MYT)

- **timestamp**: 1778079356
- **default**: atmux-bun

### ~~d-43da9530 — already resolved [low] (22:56 MYT)~~

- decided
`;
    await writeFile(join(teamDir, "decisions.md"), md);
    const rows = await readPendingDecisionsMd(teamDir, FIXED_NOW);
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe("decision:d-1e549002");
    expect(rows[0]?.blocker_class).toBe("decision-pending");
  });

  test("missing file returns empty", async () => {
    const rows = await readPendingDecisionsMd(teamDir, FIXED_NOW);
    expect(rows).toEqual([]);
  });
});

// ---------- Surface 6: flags.md ----------

describe("readOpenFlagsMd", () => {
  test("surfaces open flags + lifts class from --needs", async () => {
    const md = `# flags

### f-aaaaaaaa alice [p1/decision] (10:00 MYT)

- **timestamp**: 100
- **member**: alice
- **severity**: p1
- **needs**: decision
- **task**: t-deadbe01
- **message**: should we ship?

### f-bbbbbbbb bob [p2/unblock] (11:00 MYT)

- **timestamp**: 200
- **member**: bob
- **severity**: p2
- **needs**: unblock
- **task**: null
- **message**: env hosed

### f-cccccccc carol [p2/context] (12:00 MYT)

- **timestamp**: 300
- **member**: carol
- **severity**: p2
- **needs**: context
- **task**: null
- **message**: pre-rotation lost ctx

### r-1234abcd f-cccccccc (12:05 MYT)

- **timestamp**: 350
- **flag**: f-cccccccc
- **by**: lead
`;
    await writeFile(join(teamDir, "flags.md"), md);
    const rows = await readOpenFlagsMd(teamDir, FIXED_NOW);
    expect(rows.length).toBe(2);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("flag:f-aaaaaaaa")?.blocker_class).toBe("decision-pending");
    expect(byId.get("flag:f-aaaaaaaa")?.related_task_id).toBe("t-deadbe01");
    expect(byId.get("flag:f-bbbbbbbb")?.blocker_class).toBe("member-stuck");
    expect(byId.has("flag:f-cccccccc")).toBe(false);
  });
});

// ---------- Surface 7: driver-inbox.md ----------

describe("readDriverInboxBlockers", () => {
  test("surfaces 🔵 / ⏳ entries; suppresses ✅ / ❌", async () => {
    const md = `# driver-inbox

## 09:00 MYT — needs-decision ask

🔵 should we add gitter for atmux team?

## 09:30 MYT — already-acked ask

✅ acked by lead

## 10:00 MYT — review-pending

⏳ waiting on planner reply
`;
    await writeFile(join(teamDir, "driver-inbox.md"), md);
    const rows = await readDriverInboxBlockers(teamDir, FIXED_NOW, 24 * 3600);
    expect(rows.length).toBe(2);
    const classes = rows.map((r) => r.blocker_class).sort();
    expect(classes).toEqual(["decision-pending", "review-pending"]);
  });

  test("un-triaged entry past stale-age becomes stale-claim", async () => {
    // The HHMM parser anchors to the *current* MYT day (per ADR-152
    // §Decision-anchor #3 — date-aware parsing is a follow-up). So the
    // max apparent age of a markdown entry is just under 24h. Use a
    // shorter stale-threshold for this test to exercise the cls-flip
    // path; the real-world threshold (default 24h) is for entries that
    // *just* turned over the day boundary.
    const md = `# driver-inbox

## 00:01 MYT — un-triaged ask

just sitting here without any glyph
`;
    await writeFile(join(teamDir, "driver-inbox.md"), md);
    // FIXED_NOW lands at MYT 22:13:20; entry parses to MYT 00:01 same
    // day → ~22h12m old. Threshold 1h triggers stale-claim.
    const rows = await readDriverInboxBlockers(teamDir, FIXED_NOW, 3600);
    expect(rows.length).toBe(1);
    expect(rows[0]?.blocker_class).toBe("stale-claim");
  });
});

// ---------- Top-level fan-out ----------

describe("queryAllBlockers — integration across all 7 surfaces", () => {
  test("joins SQLite + markdown rows + preserves source attribution", async () => {
    db.exec(
      "INSERT INTO tasks (id, subject, status, deps, created_at) VALUES ('t-blk', 's', 'blocked', json_array(), 100)",
    );
    const claimedAt = FIXED_NOW - 30 * 3600;
    db.exec(
      `INSERT INTO tasks (id, status, owner, claimed_at) VALUES ('t-stl', 'in-progress', 'mem', ${claimedAt})`,
    );
    db.exec(
      `INSERT INTO complaints (id, opened_at, incident_summary, status) VALUES ('c-q', ${FIXED_NOW - 100}, 'q', 'open')`,
    );
    db.exec(
      `INSERT INTO merger_state (member_branch, state, transitioned_at) VALUES ('geoyws-x', 'conflict', ${FIXED_NOW - 50})`,
    );
    await writeFile(
      join(teamDir, "decisions.md"),
      "### d-deadbeef — pending? [low] (10:00 MYT)\n\n- **timestamp**: 1\n",
    );
    await writeFile(
      join(teamDir, "flags.md"),
      "### f-feed1234 alice [p1/decision] (10:00 MYT)\n\n- **needs**: decision\n- **task**: null\n- **message**: hi\n",
    );
    await writeFile(join(teamDir, "driver-inbox.md"), "## 09:00 MYT — pending\n\n🔵 needs ack\n");

    const rows = await queryAllBlockers(teamDir, db, { nowSec: FIXED_NOW });
    const sources = new Set(rows.map((r) => r.source));
    expect(sources.has("sqlite-tasks-blocked")).toBe(true);
    expect(sources.has("sqlite-tasks-stale")).toBe(true);
    expect(sources.has("sqlite-complaints")).toBe(true);
    expect(sources.has("sqlite-merger-state")).toBe(true);
    expect(sources.has("md-decisions")).toBe(true);
    expect(sources.has("md-flags")).toBe(true);
    expect(sources.has("md-driver-inbox")).toBe(true);
    // Cross-surface row-IDs are unique by surface-prefix construction.
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.size).toBe(rows.length);
  });

  test("empty atmuxDir + empty DB yields empty array", async () => {
    const rows = await queryAllBlockers(teamDir, db, { nowSec: FIXED_NOW });
    expect(rows).toEqual([]);
  });
});
