// Unit tests for src/core/orchd-context-scan.ts (e-13-04c8b3bf / ADR-254
// backfill — finding `test-orchd-context-scan-untested`).
//
// `scanContextAcrossMembers` fires AUTOMATICALLY from Rust orchd's 15-min
// ticker, walks every member pane, parses the Claude TUI context-% bar,
// and EMITS a durable `member.context-high` event when a member is at or
// above the threshold (default 40%) — unless an identical signal was
// already emitted inside the dedup window. Pre-ADR-254 this had 0% test
// coverage. These tests drive it with injected pane-capture stubs above /
// below DEFAULT_CONTEXT_THRESHOLD and inside / outside the dedup window,
// asserting the exact aggregate counts + that the durable event row lands.
//
// Bottom-up check: each assertion below pins a distinct branch (ok /
// unknown / over-threshold-emitted / over-threshold-deduped / errored).
// If the scan emitted nothing (or emitted unconditionally), the counts
// and the events-table row count would flip — so "would this pass if the
// feature were broken?" is NO.

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { openDatabase } from "../../../src/abstractions/sqlite.ts";
import { emit } from "../../../src/abstractions/events.ts";
import {
  type ContextScanDeps,
  DEFAULT_CONTEXT_THRESHOLD,
  DEFAULT_DEDUP_WINDOW_SEC,
  scanContextAcrossMembers,
} from "../../../src/core/orchd-context-scan.ts";
import { Team } from "../../../src/schema/team.ts";

let scratch: string;
let db: Database;

const NOW = 1_800_000_000;
const TEAM = "atmux";

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-orchd-context-scan-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
});

afterEach(async () => {
  db.close();
  await rm(scratch, { recursive: true, force: true });
});

// ---------- stubs ----------

/** Build a team with the given member names (the scan only reads
 *  `team.name` + `team.members[].name`). */
function teamWithMembers(names: string[]): Team {
  return Team.parse({ name: TEAM, members: names.map((name) => ({ name })) });
}

/** A statusline carrying a Claude context bar at `pct`%. The
 *  `████░░ NN%` block-bar segment is what `parseContextPercent` anchors
 *  on (pane-statusline.ts CONTEXT_BAR_RE). */
function statuslineAt(pct: number): string {
  return `geoyws@proton.me max  │  Opus 4.7 ·1M  │  ████░░░░░░ ${pct}%  │  tok 431.0k/855`;
}

/** Build a stub Tmux whose capturePane returns a per-target canned
 *  string from `byTarget` (keyed by the resolved window target), or
 *  throws when the canned value is an Error sentinel. Only `.pane
 *  .capturePane` is exercised by the scan; the rest of the surface is
 *  cast through `unknown` per the goal-injection.test precedent. Typed
 *  to the scan's own `deps.tmux` field so the cast tracks the real
 *  parameter type without naming the (currently sibling-WIP) `Tmux`
 *  alias directly. */
function stubTmux(byTarget: Record<string, string | Error>): ContextScanDeps["tmux"] {
  const ns = {
    pane: {
      capturePane: async ({ target }: { target: string }) => {
        const v = byTarget[target];
        if (v instanceof Error) throw v;
        return v ?? "";
      },
    },
  } as unknown as TmuxNamespace;
  return ns as unknown as ContextScanDeps["tmux"];
}

/** Default target resolver: `atmux:<member>`. */
const resolveWindowTarget = (m: { name: string }): string => `${TEAM}:${m.name}`;

function countContextHighEvents(): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE topic = 'member.context-high'")
      .get() as { n: number }
  ).n;
}

// ---------- happy-path branches ----------

describe("scanContextAcrossMembers — per-member outcome branches", () => {
  test("member below threshold → ok, no event emitted", async () => {
    const team = teamWithMembers(["alice"]);
    const tmux = stubTmux({ "atmux:alice": statuslineAt(DEFAULT_CONTEXT_THRESHOLD - 1) });

    const res = await scanContextAcrossMembers({
      db,
      team,
      tmux,
      sessionName: TEAM,
      resolveWindowTarget,
      nowSec: () => NOW,
    });

    expect(res.membersConsidered).toBe(1);
    expect(res.membersOverThreshold).toBe(0);
    expect(res.membersEmitted).toBe(0);
    expect(res.perMember[0]?.outcome).toBe("ok");
    expect(countContextHighEvents()).toBe(0);
  });

  test("member at/above threshold (no prior signal) → emits a durable event", async () => {
    const team = teamWithMembers(["alice"]);
    const tmux = stubTmux({ "atmux:alice": statuslineAt(DEFAULT_CONTEXT_THRESHOLD + 25) });

    const res = await scanContextAcrossMembers({
      db,
      team,
      tmux,
      sessionName: TEAM,
      resolveWindowTarget,
      nowSec: () => NOW,
    });

    expect(res.membersOverThreshold).toBe(1);
    expect(res.membersEmitted).toBe(1);
    expect(res.membersDeduped).toBe(0);
    const m = res.perMember[0];
    expect(m?.outcome).toBe("over-threshold");
    if (m?.outcome === "over-threshold") {
      expect(m.emitted).toBe(true);
      expect(m.percent).toBe(DEFAULT_CONTEXT_THRESHOLD + 25);
    }
    // A real, queryable event row landed with the right payload.
    expect(countContextHighEvents()).toBe(1);
    const row = db
      .prepare(
        `SELECT json_extract(payload, '$.member') AS member,
                json_extract(payload, '$.percent') AS percent,
                json_extract(payload, '$.threshold') AS threshold
           FROM events WHERE topic = 'member.context-high'`,
      )
      .get() as { member: string; percent: number; threshold: number };
    expect(row.member).toBe("alice");
    expect(row.percent).toBe(DEFAULT_CONTEXT_THRESHOLD + 25);
    expect(row.threshold).toBe(DEFAULT_CONTEXT_THRESHOLD);
  });

  test("exactly AT threshold counts as over-threshold (>= comparison)", async () => {
    const team = teamWithMembers(["alice"]);
    const tmux = stubTmux({ "atmux:alice": statuslineAt(DEFAULT_CONTEXT_THRESHOLD) });

    const res = await scanContextAcrossMembers({
      db,
      team,
      tmux,
      sessionName: TEAM,
      resolveWindowTarget,
      nowSec: () => NOW,
    });

    expect(res.membersOverThreshold).toBe(1);
    expect(res.membersEmitted).toBe(1);
    expect(countContextHighEvents()).toBe(1);
  });

  test("no context bar in capture → unknown, no event", async () => {
    const team = teamWithMembers(["alice"]);
    // A bash prompt — no Claude statusline bar pattern.
    const tmux = stubTmux({ "atmux:alice": "$ ls -la\ntotal 0\n$ " });

    const res = await scanContextAcrossMembers({
      db,
      team,
      tmux,
      sessionName: TEAM,
      resolveWindowTarget,
      nowSec: () => NOW,
    });

    expect(res.membersUnknown).toBe(1);
    expect(res.membersOverThreshold).toBe(0);
    expect(res.perMember[0]?.outcome).toBe("unknown");
    expect(countContextHighEvents()).toBe(0);
  });
});

// ---------- dedup window ----------

describe("scanContextAcrossMembers — dedup window", () => {
  test("a prior over-threshold event INSIDE the window → deduped, no second emit", async () => {
    const team = teamWithMembers(["alice"]);
    const tmux = stubTmux({ "atmux:alice": statuslineAt(DEFAULT_CONTEXT_THRESHOLD + 10) });

    // Seed a prior signal 10 min ago — well inside the 30-min default window.
    const priorAt = NOW - 600;
    emit(
      db,
      {
        topic: "member.context-high",
        team: TEAM,
        member: "alice",
        percent: 55,
        threshold: DEFAULT_CONTEXT_THRESHOLD,
        matchedSegment: "████░░ 55%",
        capturedAtSec: priorAt,
        emittedAtSec: priorAt,
      },
      { honkerLoaded: false },
    );
    expect(countContextHighEvents()).toBe(1);

    const res = await scanContextAcrossMembers({
      db,
      team,
      tmux,
      sessionName: TEAM,
      resolveWindowTarget,
      nowSec: () => NOW,
    });

    expect(res.membersOverThreshold).toBe(1);
    expect(res.membersEmitted).toBe(0);
    expect(res.membersDeduped).toBe(1);
    const m = res.perMember[0];
    expect(m?.outcome).toBe("over-threshold");
    if (m?.outcome === "over-threshold") {
      expect(m.emitted).toBe(false);
      expect(m.dedupReason).toContain("already emitted");
    }
    // No NEW event was inserted — still exactly the one seeded.
    expect(countContextHighEvents()).toBe(1);
  });

  test("a prior over-threshold event OUTSIDE the window → re-emits", async () => {
    const team = teamWithMembers(["alice"]);
    const tmux = stubTmux({ "atmux:alice": statuslineAt(DEFAULT_CONTEXT_THRESHOLD + 10) });

    // Seed a prior signal just PAST the dedup window (older than 30 min).
    const priorAt = NOW - DEFAULT_DEDUP_WINDOW_SEC - 60;
    emit(
      db,
      {
        topic: "member.context-high",
        team: TEAM,
        member: "alice",
        percent: 55,
        threshold: DEFAULT_CONTEXT_THRESHOLD,
        matchedSegment: "████░░ 55%",
        capturedAtSec: priorAt,
        emittedAtSec: priorAt,
      },
      { honkerLoaded: false },
    );

    const res = await scanContextAcrossMembers({
      db,
      team,
      tmux,
      sessionName: TEAM,
      resolveWindowTarget,
      nowSec: () => NOW,
    });

    expect(res.membersDeduped).toBe(0);
    expect(res.membersEmitted).toBe(1);
    // The stale prior + the fresh emit = 2 rows.
    expect(countContextHighEvents()).toBe(2);
  });

  test("dedup is per-member: a prior signal for a DIFFERENT member does not suppress", async () => {
    const team = teamWithMembers(["alice"]);
    const tmux = stubTmux({ "atmux:alice": statuslineAt(DEFAULT_CONTEXT_THRESHOLD + 10) });

    // Recent signal exists, but for 'bob' — must NOT dedup alice.
    emit(
      db,
      {
        topic: "member.context-high",
        team: TEAM,
        member: "bob",
        percent: 55,
        threshold: DEFAULT_CONTEXT_THRESHOLD,
        matchedSegment: "████░░ 55%",
        capturedAtSec: NOW - 60,
        emittedAtSec: NOW - 60,
      },
      { honkerLoaded: false },
    );

    const res = await scanContextAcrossMembers({
      db,
      team,
      tmux,
      sessionName: TEAM,
      resolveWindowTarget,
      nowSec: () => NOW,
    });

    expect(res.membersEmitted).toBe(1);
    expect(res.membersDeduped).toBe(0);
    expect(countContextHighEvents()).toBe(2);
  });

  test("custom dedupWindowSec override is honored", async () => {
    const team = teamWithMembers(["alice"]);
    const tmux = stubTmux({ "atmux:alice": statuslineAt(DEFAULT_CONTEXT_THRESHOLD + 10) });

    // Prior signal 100s ago. With a 60s window it is OUTSIDE → re-emit.
    emit(
      db,
      {
        topic: "member.context-high",
        team: TEAM,
        member: "alice",
        percent: 55,
        threshold: DEFAULT_CONTEXT_THRESHOLD,
        matchedSegment: "████░░ 55%",
        capturedAtSec: NOW - 100,
        emittedAtSec: NOW - 100,
      },
      { honkerLoaded: false },
    );

    const res = await scanContextAcrossMembers({
      db,
      team,
      tmux,
      sessionName: TEAM,
      resolveWindowTarget,
      dedupWindowSec: 60,
      nowSec: () => NOW,
    });

    expect(res.membersEmitted).toBe(1);
    expect(res.membersDeduped).toBe(0);
  });
});

// ---------- threshold override ----------

describe("scanContextAcrossMembers — threshold override", () => {
  test("custom threshold flips a member from ok to over-threshold", async () => {
    const team = teamWithMembers(["alice"]);
    const tmux = stubTmux({ "atmux:alice": statuslineAt(50) });

    // With default 40 this would be over; with threshold 60 it is under.
    const res = await scanContextAcrossMembers({
      db,
      team,
      tmux,
      sessionName: TEAM,
      resolveWindowTarget,
      threshold: 60,
      nowSec: () => NOW,
    });

    expect(res.membersOverThreshold).toBe(0);
    expect(res.perMember[0]?.outcome).toBe("ok");
    expect(countContextHighEvents()).toBe(0);
  });
});

// ---------- error containment ----------

describe("scanContextAcrossMembers — error containment", () => {
  test("resolveWindowTarget throwing → errored, scan continues to next member", async () => {
    const team = teamWithMembers(["alice", "bob"]);
    const tmux = stubTmux({ "atmux:bob": statuslineAt(DEFAULT_CONTEXT_THRESHOLD + 5) });

    const logged: string[] = [];
    const res = await scanContextAcrossMembers({
      db,
      team,
      tmux,
      sessionName: TEAM,
      resolveWindowTarget: (m) => {
        if (m.name === "alice") throw new Error("window not found");
        return `atmux:${m.name}`;
      },
      nowSec: () => NOW,
      log: (msg) => logged.push(msg),
    });

    expect(res.membersConsidered).toBe(2);
    expect(res.membersErrored).toBe(1);
    // bob still scanned + emitted despite alice's resolve failure.
    expect(res.membersEmitted).toBe(1);
    const alice = res.perMember.find((p) => p.member === "alice");
    expect(alice?.outcome).toBe("errored");
    if (alice?.outcome === "errored") expect(alice.reason).toContain("window not found");
    expect(logged.some((l) => l.includes("target resolve failed"))).toBe(true);
  });

  test("capturePane throwing → errored, no event", async () => {
    const team = teamWithMembers(["alice"]);
    const tmux = stubTmux({ "atmux:alice": new Error("tmux: no such pane") });

    const logged: string[] = [];
    const res = await scanContextAcrossMembers({
      db,
      team,
      tmux,
      sessionName: TEAM,
      resolveWindowTarget,
      nowSec: () => NOW,
      log: (msg) => logged.push(msg),
    });

    expect(res.membersErrored).toBe(1);
    const m = res.perMember[0];
    expect(m?.outcome).toBe("errored");
    if (m?.outcome === "errored") expect(m.reason).toContain("no such pane");
    expect(logged.some((l) => l.includes("capture failed"))).toBe(true);
    expect(countContextHighEvents()).toBe(0);
  });

  test("emit throwing → errored (INSERT violates a CHECK; dedup SELECT still works)", async () => {
    const team = teamWithMembers(["alice"]);
    const tmux = stubTmux({ "atmux:alice": statuslineAt(DEFAULT_CONTEXT_THRESHOLD + 5) });
    // Recreate `events` with a CHECK that rejects member.context-high
    // rows. The dedup SELECT (no rows yet) succeeds, so the scan reaches
    // emit(); the emit INSERT then violates the CHECK and throws → the
    // per-member emit catch fires. This isolates the emit-failure branch
    // without breaking the dedup query (dropping the table would throw
    // earlier, in the un-caught dedup SELECT).
    db.exec("DROP TABLE events");
    db.exec(`
      CREATE TABLE events (
        event_id TEXT PRIMARY KEY NOT NULL,
        topic TEXT NOT NULL CHECK(topic <> 'member.context-high'),
        payload TEXT NOT NULL,
        emitted_at_sec INTEGER NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1
      )
    `);

    const logged: string[] = [];
    const res = await scanContextAcrossMembers({
      db,
      team,
      tmux,
      sessionName: TEAM,
      resolveWindowTarget,
      nowSec: () => NOW,
      log: (msg) => logged.push(msg),
    });

    expect(res.membersOverThreshold).toBe(1);
    expect(res.membersEmitted).toBe(0);
    expect(res.membersErrored).toBe(1);
    expect(res.perMember[0]?.outcome).toBe("errored");
    expect(logged.some((l) => l.includes("emit failed"))).toBe(true);
  });
});

// ---------- aggregate / mixed roster ----------

describe("scanContextAcrossMembers — mixed roster aggregate", () => {
  test("a roster spanning every branch produces the right aggregate counts", async () => {
    const team = teamWithMembers(["ok-member", "high-member", "unknown-member", "deduped-member"]);
    const tmux = stubTmux({
      "atmux:ok-member": statuslineAt(DEFAULT_CONTEXT_THRESHOLD - 5),
      "atmux:high-member": statuslineAt(DEFAULT_CONTEXT_THRESHOLD + 30),
      "atmux:unknown-member": "$ idle bash shell, no statusline",
      "atmux:deduped-member": statuslineAt(DEFAULT_CONTEXT_THRESHOLD + 5),
    });

    // Pre-seed a recent signal for deduped-member so it dedups.
    emit(
      db,
      {
        topic: "member.context-high",
        team: TEAM,
        member: "deduped-member",
        percent: 50,
        threshold: DEFAULT_CONTEXT_THRESHOLD,
        matchedSegment: "████░░ 50%",
        capturedAtSec: NOW - 120,
        emittedAtSec: NOW - 120,
      },
      { honkerLoaded: false },
    );

    const res = await scanContextAcrossMembers({
      db,
      team,
      tmux,
      sessionName: TEAM,
      resolveWindowTarget,
      nowSec: () => NOW,
    });

    expect(res.membersConsidered).toBe(4);
    expect(res.membersOverThreshold).toBe(2); // high + deduped
    expect(res.membersEmitted).toBe(1); // only high (deduped suppressed)
    expect(res.membersDeduped).toBe(1);
    expect(res.membersUnknown).toBe(1);
    expect(res.membersErrored).toBe(0);
    expect(res.perMember).toHaveLength(4);
    // 1 pre-seeded + 1 fresh emit = 2 total context-high rows.
    expect(countContextHighEvents()).toBe(2);
  });

  test("empty roster → zeroed counts, no work", async () => {
    const team = teamWithMembers([]);
    const tmux = stubTmux({});
    const res = await scanContextAcrossMembers({
      db,
      team,
      tmux,
      sessionName: TEAM,
      resolveWindowTarget,
      nowSec: () => NOW,
    });
    expect(res.membersConsidered).toBe(0);
    expect(res.perMember).toEqual([]);
  });

  test("default nowSec (wall clock) drives the dedup query without throwing", async () => {
    const team = teamWithMembers(["alice"]);
    const tmux = stubTmux({ "atmux:alice": statuslineAt(DEFAULT_CONTEXT_THRESHOLD + 5) });
    // No nowSec injected — exercises the Date.now() default branch.
    const res = await scanContextAcrossMembers({
      db,
      team,
      tmux,
      sessionName: TEAM,
      resolveWindowTarget,
    });
    expect(res.membersEmitted).toBe(1);
    expect(countContextHighEvents()).toBe(1);
  });

  test("default log (NOOP) is used on an error path without crashing", async () => {
    // No `log` injected → the NOOP_LOG default is invoked on the
    // capture-failure log call. Asserts the default-log branch is exercised.
    const team = teamWithMembers(["alice"]);
    const tmux = stubTmux({ "atmux:alice": new Error("boom") });
    const res = await scanContextAcrossMembers({
      db,
      team,
      tmux,
      sessionName: TEAM,
      resolveWindowTarget,
      nowSec: () => NOW,
    });
    expect(res.membersErrored).toBe(1);
    expect(res.perMember[0]?.outcome).toBe("errored");
  });
});
