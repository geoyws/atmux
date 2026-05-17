// Unit tests for src/core/sync-claude-team-json/drift.ts (ADR-164 T5 surface
// — t-c2b757c1, asserted under T7 t-4329b053).
//
// Covers:
//   canonicalize          — implicit (key-order stability of computeFingerprint)
//   computeFingerprint    — sha256 hex, deterministic across permutations,
//                           excludes _atmuxSync (caller responsibility)
//   nextMarker            — shape (lastSyncedAt, schemaRev, sourceFingerprint)
//                           + fingerprint matches the post-write roster
//   detectDrift           — null-no-prior, null-no-marker, null-on-match,
//                           returns DriftDetection on mismatch
//   formatDriftHint       — 3-line hint shape
//   driftWarning          — single-line 🔧-prefixed shape + truncated fingerprints
//   logSyncEvent          — JSONL append + path resolution
//   DriftAbortError       — carries DriftDetection + hint
//   SYNC_MARKER_KEY + EX_DATAERR + CURRENT_SCHEMA_REV — public surface invariants

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_SCHEMA_REV,
  DriftAbortError,
  EX_DATAERR,
  SYNC_MARKER_KEY,
  computeFingerprint,
  detectDrift,
  driftWarning,
  formatDriftHint,
  logSyncEvent,
  nextMarker,
  syncEventsLogPath,
} from "../../../../src/core/sync-claude-team-json/drift.ts";
import type {
  ClaudeTeam,
  ClaudeTeamMember,
} from "../../../../src/core/sync-claude-team-json/types.ts";

const MEMBERS_A: ClaudeTeamMember[] = [
  { name: "team-lead", agentType: "team-lead", color: "white", role: "lead brief" },
  { name: "planner", color: "magenta", role: "planner brief" },
  { name: "fe-1", color: "orange", role: "fe-1 brief" },
];
const MEMBERS_B: ClaudeTeamMember[] = [
  ...MEMBERS_A,
  { name: "fe-2", color: "orange" },
];

describe("public surface invariants", () => {
  test("SYNC_MARKER_KEY is the documented top-level passthrough name", () => {
    expect(SYNC_MARKER_KEY).toBe("_atmuxSync");
  });

  test("EX_DATAERR is the BSD sysexits constant per ADR-164 §step 5", () => {
    expect(EX_DATAERR).toBe(65);
  });

  test("CURRENT_SCHEMA_REV pins v1 — bumping is a coordination event", () => {
    expect(CURRENT_SCHEMA_REV).toBe("v1");
  });
});

describe("computeFingerprint — deterministic + sha256-prefixed", () => {
  test("output is sha256:<64 hex chars>", () => {
    const fp = computeFingerprint(MEMBERS_A);
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("same input → same fingerprint (cross-call stability)", () => {
    expect(computeFingerprint(MEMBERS_A)).toBe(computeFingerprint(MEMBERS_A));
  });

  test("different rosters → different fingerprints", () => {
    expect(computeFingerprint(MEMBERS_A)).not.toBe(computeFingerprint(MEMBERS_B));
  });

  test("key-order INSIDE a member does not affect fingerprint (canonical key sort)", () => {
    const reordered: ClaudeTeamMember[] = MEMBERS_A.map((m) => {
      const entries = Object.entries(m).reverse();
      return Object.fromEntries(entries) as ClaudeTeamMember;
    });
    expect(computeFingerprint(reordered)).toBe(computeFingerprint(MEMBERS_A));
  });

  test("member ORDER does matter (per ADR-164 — preserves intent order)", () => {
    const swapped = [MEMBERS_A[1], MEMBERS_A[0], MEMBERS_A[2]] as ClaudeTeamMember[];
    expect(computeFingerprint(swapped)).not.toBe(computeFingerprint(MEMBERS_A));
  });

  test("empty roster has a stable fingerprint distinct from any non-empty roster", () => {
    const emptyFp = computeFingerprint([]);
    expect(emptyFp).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(emptyFp).not.toBe(computeFingerprint(MEMBERS_A));
  });
});

describe("nextMarker — shape + round-trip", () => {
  const TS = "2026-05-17T08:00:00.000Z";

  test("emits {lastSyncedAt, schemaRev=v1, sourceFingerprint=sha256:…}", () => {
    const got = nextMarker(MEMBERS_A, TS);
    expect(got.lastSyncedAt).toBe(TS);
    expect(got.schemaRev).toBe("v1");
    expect(got.sourceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("fingerprint matches computeFingerprint of the same roster", () => {
    expect(nextMarker(MEMBERS_A, TS).sourceFingerprint).toBe(
      computeFingerprint(MEMBERS_A),
    );
  });

  test("different lastSyncedAt with same roster → same fingerprint, different timestamp", () => {
    const a = nextMarker(MEMBERS_A, "2026-01-01T00:00:00.000Z");
    const b = nextMarker(MEMBERS_A, "2026-12-31T23:59:59.000Z");
    expect(a.sourceFingerprint).toBe(b.sourceFingerprint);
    expect(a.lastSyncedAt).not.toBe(b.lastSyncedAt);
  });
});

describe("detectDrift — branches per ADR-164 §step 5", () => {
  test("prior===null → null (fresh file, drift undefined)", () => {
    expect(detectDrift(null)).toBeNull();
  });

  test("prior with no _atmuxSync marker → null (never-synced)", () => {
    const prior: ClaudeTeam = { name: "fixture", members: MEMBERS_A };
    expect(detectDrift(prior)).toBeNull();
  });

  test("prior with malformed marker (no sourceFingerprint) → null", () => {
    const prior: ClaudeTeam = {
      name: "fixture",
      members: MEMBERS_A,
      [SYNC_MARKER_KEY]: { lastSyncedAt: "2026-01-01T00:00:00Z" } as never,
    };
    expect(detectDrift(prior)).toBeNull();
  });

  test("marker matches roster fingerprint → null (no drift)", () => {
    const fp = computeFingerprint(MEMBERS_A);
    const prior: ClaudeTeam = {
      name: "fixture",
      members: MEMBERS_A,
      [SYNC_MARKER_KEY]: {
        lastSyncedAt: "2026-05-01T00:00:00.000Z",
        schemaRev: "v1",
        sourceFingerprint: fp,
      },
    };
    expect(detectDrift(prior)).toBeNull();
  });

  test("marker mismatches roster fingerprint → DriftDetection", () => {
    const wrongFp = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const prior: ClaudeTeam = {
      name: "fixture",
      members: MEMBERS_A,
      [SYNC_MARKER_KEY]: {
        lastSyncedAt: "2026-05-01T00:00:00.000Z",
        schemaRev: "v1",
        sourceFingerprint: wrongFp,
      },
    };
    const det = detectDrift(prior);
    expect(det).not.toBeNull();
    expect(det?.priorMarker.sourceFingerprint).toBe(wrongFp);
    expect(det?.currentFingerprint).toBe(computeFingerprint(MEMBERS_A));
  });

  test("prior.members absent → treated as empty roster (still match-detection works)", () => {
    const fpEmpty = computeFingerprint([]);
    const prior: ClaudeTeam = {
      name: "fixture",
      // members intentionally omitted
      [SYNC_MARKER_KEY]: {
        lastSyncedAt: "2026-05-01T00:00:00.000Z",
        schemaRev: "v1",
        sourceFingerprint: fpEmpty,
      },
    };
    expect(detectDrift(prior)).toBeNull();
  });
});

describe("formatDriftHint — 3-line shape", () => {
  test("renders prior + current + lastSyncedAt", () => {
    const det = {
      priorMarker: {
        lastSyncedAt: "2026-05-01T00:00:00.000Z",
        schemaRev: "v1",
        sourceFingerprint: "sha256:dead",
      },
      currentFingerprint: "sha256:beef",
    };
    const hint = formatDriftHint(det);
    const lines = hint.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("prior fingerprint");
    expect(lines[0]).toContain("sha256:dead");
    expect(lines[1]).toContain("current fingerprint");
    expect(lines[1]).toContain("sha256:beef");
    expect(lines[2]).toContain("last synced at");
    expect(lines[2]).toContain("2026-05-01T00:00:00.000Z");
  });
});

describe("driftWarning — single-line stderr shape", () => {
  test("starts with 🔧 prefix + names the verb + truncates fingerprints", () => {
    const det = {
      priorMarker: {
        lastSyncedAt: "2026-05-01T00:00:00.000Z",
        schemaRev: "v1",
        sourceFingerprint: "sha256:abcdef0123456789aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      currentFingerprint:
        "sha256:fedcba9876543210bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };
    const line = driftWarning(det);
    expect(line.startsWith("🔧 [sync-claude-team-json]")).toBe(true);
    expect(line).toContain("drift detected");
    expect(line).toContain("abcdef012345"); // truncated prior
    expect(line).toContain("fedcba987654"); // truncated current
    // Single line — no embedded newlines.
    expect(line.includes("\n")).toBe(false);
  });
});

describe("logSyncEvent — JSONL append + path resolution", () => {
  test("syncEventsLogPath joins atmuxDir + logs/sync-events.jsonl", () => {
    expect(syncEventsLogPath("/tmp/x/.atmux")).toBe("/tmp/x/.atmux/logs/sync-events.jsonl");
  });

  test("logs are JSONL: one event per line, atomic-append, parent dir created", async () => {
    const root = await mkdtemp(join(tmpdir(), "atmux-drift-log-"));
    const atmuxDir = join(root, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    try {
      await logSyncEvent(atmuxDir, {
        ts: "2026-05-17T00:00:00.000Z",
        verb: "sync.claude-team-json",
        action: "synced",
      });
      await logSyncEvent(atmuxDir, {
        ts: "2026-05-17T00:01:00.000Z",
        verb: "sync.claude-team-json",
        action: "drift-forced",
      });
      const raw = await readFile(syncEventsLogPath(atmuxDir), "utf8");
      const lines = raw.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0] as string).action).toBe("synced");
      expect(JSON.parse(lines[1] as string).action).toBe("drift-forced");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("DriftAbortError — carries detection + hint", () => {
  test("exposes detection + hint + descriptive message", () => {
    const det = {
      priorMarker: {
        lastSyncedAt: "2026-05-01T00:00:00.000Z",
        schemaRev: "v1",
        sourceFingerprint: "sha256:aaa",
      },
      currentFingerprint: "sha256:bbb",
    };
    const err = new DriftAbortError(det);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DriftAbortError");
    expect(err.detection).toBe(det);
    expect(err.hint).toContain("sha256:aaa");
    expect(err.hint).toContain("sha256:bbb");
    expect(err.message).toContain("drift detected");
    expect(err.message).toContain("--force");
  });
});
