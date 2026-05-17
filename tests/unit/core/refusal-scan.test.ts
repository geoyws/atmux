// Unit tests for src/core/refusal-scan.ts (ADR-139 T3 / t-841049e4).
//
// The scan orchestrator is pure-of-direct-IO via the `RefusalScanDeps`
// seam: pane-capture, classifier, DB factory, and clock are all
// injected. Tests construct in-memory bun:sqlite handles via
// `openDatabase(":memory:", migrations)` and pin every external
// dimension — there is no tmux dependency in the test path.
//
// Coverage:
//   - recordRefusalEvent inserts on first call + dedupes on same-bucket
//     same-severity re-fire
//   - recordRefusalEvent allows different severities at the same bucket
//   - listRefusalEventsForMember returns newest-first with the JSON
//     phrases array decoded
//   - scanTeamForRefusals walks members, records positives, skips
//     no-detection captures with severity='none' in perMember
//   - scanTeamForRefusals deduped count + recorded count match the
//     classifier outcomes
//   - scanTeamForRefusals handles capture failure (per-member
//     skipReason set; tick does not crash)
//   - scanTeamForRefusals memberFilter excludes members cleanly
//   - guard: recordRefusalEvent rejects when `detected === false`

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import type { RefusalDetectionResult } from "../../../src/core/refusal-classifier.ts";
import {
  listRefusalEventsForMember,
  recordRefusalEvent,
  scanTeamForRefusals,
} from "../../../src/core/refusal-scan.ts";
import type { Team } from "../../../src/schema/team.ts";

function openMem(): { db: Database; close: () => void } {
  const db = openDatabase(":memory:", migrations);
  return { db, close: () => closeDatabase(db) };
}

function detection(
  severity: "soft" | "hard" | "role" | "meta",
  confidence: number,
  phrases: Array<{ phrase: string; class: "soft" | "hard" | "role" | "meta" }>,
): RefusalDetectionResult {
  return { detected: true, severity, confidence, phrases };
}

function none(): RefusalDetectionResult {
  return { detected: false, severity: "none", confidence: 0, phrases: [] };
}

function makeTeam(memberNames: string[]): Team {
  return {
    name: "demo",
    members: memberNames.map((n) => ({ name: n })),
  } as unknown as Team;
}

describe("recordRefusalEvent", () => {
  test("inserts a row on first call + reports recorded=true", () => {
    const { db, close } = openMem();
    try {
      const out = recordRefusalEvent(db, 4200, {
        member: "alice",
        team: "demo",
        result: detection("hard", 0.8, [{ phrase: "refuse-to", class: "hard" }]),
      });
      expect(out.recorded).toBe(true);
      expect(out.minuteBucket).toBe(70);
      expect(out.id).toMatch(/^r-[0-9a-f]{8}$/);
      const rows = listRefusalEventsForMember(db, "alice");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.severity).toBe("hard");
      expect(rows[0]?.minuteBucket).toBe(70);
      expect(rows[0]?.phrases).toEqual([{ phrase: "refuse-to", class: "hard" }]);
    } finally {
      close();
    }
  });

  test("dedupes a same-minute, same-severity re-fire (recorded=false)", () => {
    const { db, close } = openMem();
    try {
      const first = recordRefusalEvent(db, 4200, {
        member: "bob",
        team: "demo",
        result: detection("soft", 0.5, [{ phrase: "fatigue", class: "soft" }]),
      });
      expect(first.recorded).toBe(true);
      // Same minute_bucket (Math.floor(4200/60) === 70 === Math.floor(4255/60))
      const second = recordRefusalEvent(db, 4255, {
        member: "bob",
        team: "demo",
        result: detection("soft", 0.55, [{ phrase: "tired-of", class: "soft" }]),
      });
      expect(second.recorded).toBe(false);
      expect(second.minuteBucket).toBe(70);
      const rows = listRefusalEventsForMember(db, "bob");
      expect(rows).toHaveLength(1);
      // The dedupe-loser's payload does not overwrite the original row.
      expect(rows[0]?.phrases).toEqual([{ phrase: "fatigue", class: "soft" }]);
    } finally {
      close();
    }
  });

  test("different severities at the same minute land as separate rows", () => {
    const { db, close } = openMem();
    try {
      const a = recordRefusalEvent(db, 7200, {
        member: "carol",
        team: "demo",
        result: detection("soft", 0.5, [{ phrase: "fatigue", class: "soft" }]),
      });
      const b = recordRefusalEvent(db, 7200, {
        member: "carol",
        team: "demo",
        result: detection("role", 0.95, [{ phrase: "rotate-me", class: "role" }]),
      });
      expect(a.recorded).toBe(true);
      expect(b.recorded).toBe(true);
      const rows = listRefusalEventsForMember(db, "carol");
      expect(rows).toHaveLength(2);
      const severities = rows.map((r) => r.severity).sort();
      expect(severities).toEqual(["role", "soft"]);
    } finally {
      close();
    }
  });

  test("rejects calls when result.detected === false", () => {
    const { db, close } = openMem();
    try {
      expect(() =>
        recordRefusalEvent(db, 1000, {
          member: "dave",
          team: "demo",
          result: none(),
        }),
      ).toThrow();
    } finally {
      close();
    }
  });

  test("rejects calls when severity === 'none' even if detected=true", () => {
    const { db, close } = openMem();
    try {
      expect(() =>
        recordRefusalEvent(db, 1000, {
          member: "dave",
          team: "demo",
          result: { detected: true, severity: "none", confidence: 0, phrases: [] },
        }),
      ).toThrow();
    } finally {
      close();
    }
  });
});

describe("listRefusalEventsForMember", () => {
  test("returns newest-first ordering with phrases decoded", () => {
    const { db, close } = openMem();
    try {
      recordRefusalEvent(db, 1000, {
        member: "eve",
        team: "demo",
        result: detection("soft", 0.5, [{ phrase: "old", class: "soft" }]),
      });
      recordRefusalEvent(db, 4000, {
        member: "eve",
        team: "demo",
        result: detection("hard", 0.8, [{ phrase: "newer", class: "hard" }]),
      });
      const rows = listRefusalEventsForMember(db, "eve", 10);
      expect(rows.map((r) => r.detectedAt)).toEqual([4000, 1000]);
      expect(rows[0]?.phrases[0]?.phrase).toBe("newer");
    } finally {
      close();
    }
  });

  test("limit parameter caps the returned row count", () => {
    const { db, close } = openMem();
    try {
      for (let i = 0; i < 5; i += 1) {
        recordRefusalEvent(db, 1000 + i * 60, {
          member: "frank",
          team: "demo",
          result: detection("soft", 0.5, [{ phrase: `p${i}`, class: "soft" }]),
        });
      }
      expect(listRefusalEventsForMember(db, "frank", 2)).toHaveLength(2);
      expect(listRefusalEventsForMember(db, "frank", 99)).toHaveLength(5);
    } finally {
      close();
    }
  });
});

describe("scanTeamForRefusals", () => {
  test("records positives + skips non-detections with severity='none'", async () => {
    const { db, close } = openMem();
    try {
      const team = makeTeam(["alice", "bob"]);
      // Classifier: alice positive (hard), bob negative.
      const classify = (capture: string): RefusalDetectionResult => {
        if (capture.includes("REFUSE")) {
          return detection("hard", 0.8, [{ phrase: "refuse-to-work", class: "hard" }]);
        }
        return none();
      };
      const paneCapture = async (target: string): Promise<string> => {
        if (target.includes("alice")) return "I REFUSE to claim";
        return "happy path output";
      };
      const result = await scanTeamForRefusals(team, "/tmp/x", {
        classify,
        paneCapture,
        openDb: () => ({ db, close: () => {} }),
        nowSec: () => 5000,
        log: () => {},
      });
      expect(result.scanned).toBe(2);
      expect(result.detected).toBe(1);
      expect(result.recorded).toBe(1);
      expect(result.deduped).toBe(0);
      const alice = result.perMember.find((m) => m.member === "alice");
      const bob = result.perMember.find((m) => m.member === "bob");
      expect(alice?.severity).toBe("hard");
      expect(alice?.recorded).toBe(true);
      expect(bob?.severity).toBe("none");
      expect(bob?.recorded).toBe(false);
      // Read-back asserts the row landed.
      expect(listRefusalEventsForMember(db, "alice")).toHaveLength(1);
      expect(listRefusalEventsForMember(db, "bob")).toHaveLength(0);
    } finally {
      close();
    }
  });

  test("idempotent re-scan in the same minute reports deduped=1", async () => {
    const { db, close } = openMem();
    try {
      const team = makeTeam(["alice"]);
      const classify = (): RefusalDetectionResult =>
        detection("soft", 0.5, [{ phrase: "fatigue", class: "soft" }]);
      const paneCapture = async (): Promise<string> => "I'm tired of this";

      const baseDeps = {
        classify,
        paneCapture,
        openDb: () => ({ db, close: () => {} }),
        log: () => {},
      };

      const first = await scanTeamForRefusals(team, "/tmp/x", {
        ...baseDeps,
        nowSec: () => 5000,
      });
      expect(first.recorded).toBe(1);
      expect(first.deduped).toBe(0);

      // Same minute_bucket (5000/60 === 5030/60 === 83).
      const second = await scanTeamForRefusals(team, "/tmp/x", {
        ...baseDeps,
        nowSec: () => 5030,
      });
      expect(second.recorded).toBe(0);
      expect(second.deduped).toBe(1);
      const alice = second.perMember.find((m) => m.member === "alice");
      expect(alice?.recorded).toBe(false);

      // Only one row in the table.
      expect(listRefusalEventsForMember(db, "alice")).toHaveLength(1);
    } finally {
      close();
    }
  });

  test("pane-capture failure surfaces per-member skipReason, scan continues", async () => {
    const { db, close } = openMem();
    try {
      const team = makeTeam(["alice", "bob"]);
      const classify = (): RefusalDetectionResult =>
        detection("hard", 0.8, [{ phrase: "x", class: "hard" }]);
      const paneCapture = async (target: string): Promise<string> => {
        if (target.includes("alice")) throw new Error("tmux pane dead");
        return "I refuse to work";
      };
      const result = await scanTeamForRefusals(team, "/tmp/x", {
        classify,
        paneCapture,
        openDb: () => ({ db, close: () => {} }),
        nowSec: () => 9000,
        log: () => {},
      });
      const alice = result.perMember.find((m) => m.member === "alice");
      const bob = result.perMember.find((m) => m.member === "bob");
      expect(alice?.skipReason).toContain("capture-failed");
      expect(alice?.recorded).toBe(false);
      expect(bob?.severity).toBe("hard");
      expect(bob?.recorded).toBe(true);
      // alice did not contribute to `scanned` (capture failed before
      // classify), but `bob` did.
      expect(result.scanned).toBe(1);
      expect(result.detected).toBe(1);
      expect(result.recorded).toBe(1);
    } finally {
      close();
    }
  });

  test("empty capture short-circuits to skipReason='empty-capture'", async () => {
    const { db, close } = openMem();
    try {
      const team = makeTeam(["alice"]);
      let classifyCalls = 0;
      const classify = (): RefusalDetectionResult => {
        classifyCalls += 1;
        return none();
      };
      const result = await scanTeamForRefusals(team, "/tmp/x", {
        classify,
        paneCapture: async () => "",
        openDb: () => ({ db, close: () => {} }),
        nowSec: () => 1000,
        log: () => {},
      });
      expect(result.scanned).toBe(1);
      expect(result.detected).toBe(0);
      expect(classifyCalls).toBe(0);
      expect(result.perMember[0]?.skipReason).toBe("empty-capture");
    } finally {
      close();
    }
  });

  test("memberFilter excludes members cleanly (skipReason='filtered')", async () => {
    const { db, close } = openMem();
    try {
      const team = makeTeam(["alice", "bob"]);
      const result = await scanTeamForRefusals(team, "/tmp/x", {
        classify: () => detection("hard", 0.8, [{ phrase: "x", class: "hard" }]),
        paneCapture: async () => "REFUSE",
        openDb: () => ({ db, close: () => {} }),
        nowSec: () => 1000,
        log: () => {},
        memberFilter: (m) => m.name !== "bob",
      });
      const bob = result.perMember.find((m) => m.member === "bob");
      expect(bob?.skipReason).toBe("filtered");
      expect(result.scanned).toBe(1);
      expect(result.recorded).toBe(1);
    } finally {
      close();
    }
  });
});
