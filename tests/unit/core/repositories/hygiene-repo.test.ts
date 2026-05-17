// Unit tests for src/core/repositories/hygiene-repo.ts (ADR-131 T3
// reader/writer / t-247b4b35).
//
// Coverage:
//   - severityToInt / intToSeverity round-trip
//   - upsertFingerprint: insert (new row), update (bumps last_seen_at
//     + refreshes severity/confidence/diagnosis/attempted_fix)
//   - listUnfixed: returns rows where fix_applied_at IS NULL, ordered
//     by severity ASC, detected_at ASC
//   - markFixed: success + failure, both drop the row from listUnfixed
//   - migration v3 schema shape — confirms table + index exist after
//     openDatabase fires the ladder

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, type Database, openDatabase } from "../../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../../src/abstractions/sqlite-migrations.ts";
import {
  HygieneRepo,
  intToSeverity,
  severityToInt,
} from "../../../../src/core/repositories/hygiene-repo.ts";
import type { HygieneIssue } from "../../../../src/core/superdoctor-hygiene/_shared.ts";

let scratch: string;
let db: Database;
let repo: HygieneRepo;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-hygiene-repo-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
  repo = new HygieneRepo(db);
});
afterEach(async () => {
  closeDatabase(db);
  await rm(scratch, { recursive: true, force: true });
});

function mkIssue(over: Partial<HygieneIssue> = {}): HygieneIssue {
  return {
    taskId: "t-001",
    fingerprintClass: "ghost-owner",
    severity: "P0",
    confidence: "high",
    diagnosis: "diag",
    proposedFix: { kind: "reassign", toMember: "fe-1" },
    ...over,
  };
}

// ---------- severity int ⇄ string ----------

describe("severityToInt / intToSeverity", () => {
  test("P0=0, P1=1, P3=3 round-trip", () => {
    expect(severityToInt("P0")).toBe(0);
    expect(severityToInt("P1")).toBe(1);
    expect(severityToInt("P3")).toBe(3);
    expect(intToSeverity(0)).toBe("P0");
    expect(intToSeverity(1)).toBe("P1");
    expect(intToSeverity(3)).toBe("P3");
  });

  test("intToSeverity falls back to P3 for unknown ints (defensive)", () => {
    // P2 reserved + unused per ADR-131 task body; if a hand-edited
    // DB has 2, treat as P3 (lowest known severity) rather than throw.
    expect(intToSeverity(2)).toBe("P3");
    expect(intToSeverity(99)).toBe("P3");
  });
});

// ---------- migration shape ----------

describe("migration v3 — superdoctor_hygiene table", () => {
  test("table exists with the right columns + types", () => {
    const cols = db.query("PRAGMA table_info(superdoctor_hygiene)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName.task_id?.type).toBe("TEXT");
    expect(byName.task_id?.notnull).toBe(1);
    expect(byName.fingerprint_class?.type).toBe("TEXT");
    expect(byName.severity?.type).toBe("INTEGER");
    expect(byName.confidence?.type).toBe("TEXT");
    expect(byName.diagnosis?.type).toBe("TEXT");
    expect(byName.detected_at?.type).toBe("INTEGER");
    expect(byName.last_seen_at?.type).toBe("INTEGER");
    expect(byName.attempted_fix?.type).toBe("TEXT");
    expect(byName.fix_applied_at?.type).toBe("INTEGER");
    expect(byName.fix_successful?.type).toBe("INTEGER");
    // Composite PK on (task_id, fingerprint_class)
    expect(byName.task_id?.pk).toBe(1);
    expect(byName.fingerprint_class?.pk).toBe(2);
  });

  test("partial index on unfixed exists", () => {
    const idx = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='superdoctor_hygiene'")
      .all() as Array<{ name: string }>;
    expect(idx.some((r) => r.name === "idx_hygiene_unfixed")).toBe(true);
  });
});

// ---------- upsertFingerprint ----------

describe("upsertFingerprint", () => {
  test("INSERT: new row → detected_at + last_seen_at both = now", () => {
    repo.upsertFingerprint(mkIssue(), 1000);
    const row = repo.getFingerprint("t-001", "ghost-owner");
    expect(row).not.toBeNull();
    expect(row!.detectedAt).toBe(1000);
    expect(row!.lastSeenAt).toBe(1000);
    expect(row!.severity).toBe("P0");
    expect(row!.confidence).toBe("high");
    expect(row!.diagnosis).toBe("diag");
    expect(row!.attemptedFix).toEqual({ kind: "reassign", toMember: "fe-1" });
    expect(row!.fixAppliedAt).toBeNull();
    expect(row!.fixSuccessful).toBeNull();
  });

  test("UPDATE on conflict: same (taskId, class) → last_seen_at bumped; detected_at preserved", () => {
    repo.upsertFingerprint(mkIssue(), 1000);
    repo.upsertFingerprint(mkIssue(), 2000);
    const row = repo.getFingerprint("t-001", "ghost-owner")!;
    expect(row.detectedAt).toBe(1000);
    expect(row.lastSeenAt).toBe(2000);
  });

  test("UPDATE refreshes diagnosis / proposed-fix / severity / confidence", () => {
    repo.upsertFingerprint(mkIssue(), 1000);
    repo.upsertFingerprint(
      mkIssue({
        diagnosis: "refreshed",
        severity: "P1",
        confidence: "medium",
        proposedFix: { kind: "reassign", toMember: "fe-2" },
      }),
      2000,
    );
    const row = repo.getFingerprint("t-001", "ghost-owner")!;
    expect(row.severity).toBe("P1");
    expect(row.confidence).toBe("medium");
    expect(row.diagnosis).toBe("refreshed");
    expect(row.attemptedFix).toEqual({ kind: "reassign", toMember: "fe-2" });
  });

  test("composite PK isolates different fingerprint classes on same task", () => {
    repo.upsertFingerprint(mkIssue({ taskId: "t-001", fingerprintClass: "ghost-owner" }), 1000);
    repo.upsertFingerprint(
      mkIssue({
        taskId: "t-001",
        fingerprintClass: "lane-mismatch",
        severity: "P0",
        proposedFix: { kind: "set-lane", lane: "be" },
      }),
      1000,
    );
    expect(repo.getFingerprint("t-001", "ghost-owner")).not.toBeNull();
    expect(repo.getFingerprint("t-001", "lane-mismatch")).not.toBeNull();
    expect(repo.listUnfixed()).toHaveLength(2);
  });
});

// ---------- listUnfixed ordering ----------

describe("listUnfixed", () => {
  test("orders by severity ASC, detected_at ASC", () => {
    // Insert in scrambled order; expect P0 first, oldest first within tier.
    repo.upsertFingerprint(
      mkIssue({
        taskId: "t-003",
        fingerprintClass: "prio-null",
        severity: "P3",
        proposedFix: { kind: "set-priority", priority: 3 },
      }),
      3000,
    );
    repo.upsertFingerprint(
      mkIssue({ taskId: "t-002", fingerprintClass: "role-mismatch", severity: "P1" }),
      1500,
    );
    repo.upsertFingerprint(
      mkIssue({ taskId: "t-001-b", fingerprintClass: "ghost-owner", severity: "P0" }),
      2000,
    );
    repo.upsertFingerprint(
      mkIssue({ taskId: "t-001-a", fingerprintClass: "ghost-owner", severity: "P0" }),
      1000,
    );
    const rows = repo.listUnfixed();
    expect(rows.map((r) => r.taskId)).toEqual(["t-001-a", "t-001-b", "t-002", "t-003"]);
  });

  test("empty after fresh DB", () => {
    expect(repo.listUnfixed()).toEqual([]);
  });
});

// ---------- markFixed ----------

describe("markFixed", () => {
  test("success path drops row from listUnfixed; fixApplied + successful persisted", () => {
    repo.upsertFingerprint(mkIssue(), 1000);
    repo.markFixed("t-001", "ghost-owner", 1500, true);
    expect(repo.listUnfixed()).toHaveLength(0);
    const row = repo.getFingerprint("t-001", "ghost-owner")!;
    expect(row.fixAppliedAt).toBe(1500);
    expect(row.fixSuccessful).toBe(true);
  });

  test("failure path still drops row from listUnfixed; successful=false persisted", () => {
    repo.upsertFingerprint(mkIssue(), 1000);
    repo.markFixed("t-001", "ghost-owner", 1500, false);
    expect(repo.listUnfixed()).toHaveLength(0);
    const row = repo.getFingerprint("t-001", "ghost-owner")!;
    expect(row.fixSuccessful).toBe(false);
  });

  test("no-op when row absent (idempotent)", () => {
    // Doesn't throw; just affects zero rows.
    repo.markFixed("t-missing", "ghost-owner", 1500, true);
    expect(repo.listUnfixed()).toEqual([]);
  });
});

// ---------- getFingerprint ----------

describe("getFingerprint", () => {
  test("returns null for absent (taskId, class)", () => {
    expect(repo.getFingerprint("t-ghost", "ghost-owner")).toBeNull();
  });

  test("returns full row including null fix columns on fresh insert", () => {
    repo.upsertFingerprint(mkIssue(), 1000);
    const row = repo.getFingerprint("t-001", "ghost-owner")!;
    expect(row.fixAppliedAt).toBeNull();
    expect(row.fixSuccessful).toBeNull();
  });
});
