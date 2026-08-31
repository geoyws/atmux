// Unit tests for src/core/complaints.ts (ADR-177 §T2 / Task t-e91fec98).
//
// Exercises the dedup contract end-to-end against an in-memory SQLite
// database wired up with the same migrations the production verb uses.
// `nowSec` is injected throughout so the dedup window can be walked
// deterministically without sleeping the test runner.

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { DEFAULT_DEDUP_WINDOW_SEC, fileDedupedComplaint } from "../../../src/core/complaints.ts";
import { ComplaintsRepo } from "../../../src/core/repositories/complaints-repo.ts";

let teamDir: string;
let db: Database;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-complaints-core-"));
  db = openDatabase(join(teamDir, "state.db"), migrations);
});

afterEach(async () => {
  closeDatabase(db);
  await rm(teamDir, { recursive: true, force: true });
});

// ---------- Constants ----------

describe("DEFAULT_DEDUP_WINDOW_SEC", () => {
  test("matches Task t-e91fec98 §5 default of 1h", () => {
    expect(DEFAULT_DEDUP_WINDOW_SEC).toBe(3600);
  });
});

// ---------- Fresh-row insert ----------

describe("fileDedupedComplaint — fresh row", () => {
  test("inserts new row when source_id has no prior complaints", () => {
    const result = fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "team-a: eta-lied · 5 standby picks · whip-tried-3-menus",
    });

    expect(result.isNew).toBe(true);
    expect(result.sourceCount).toBe(1);
    expect(result.id).toMatch(/^c-[0-9a-f]{8}$/);
  });

  test("persists complaint with caller-supplied fields", () => {
    const result = fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-process-frozen",
      targetTeam: "team-a",
      incidentSummary: "team-a: process-frozen · 3h no commits",
      rootCause: "lead pane catatonic",
      openedBy: "whip:team-a",
    });

    const repo = new ComplaintsRepo(db);
    const c = repo.getById(result.id);
    expect(c).not.toBeNull();
    expect(c?.sourceKind).toBe("whip");
    expect(c?.sourceId).toBe("whip-team-a-process-frozen");
    expect(c?.targetTeam).toBe("team-a");
    expect(c?.incidentSummary).toBe("team-a: process-frozen · 3h no commits");
    expect(c?.rootCause).toBe("lead pane catatonic");
    expect(c?.openedBy).toBe("whip:team-a");
    expect(c?.status).toBe("open");
    expect(c?.openedAt).toBe(1000);
  });

  test("stamps source_count=1 + last_seen=nowSec in extra", () => {
    const result = fileDedupedComplaint(db, 2025, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "x",
    });

    const repo = new ComplaintsRepo(db);
    const c = repo.getById(result.id);
    expect(c?.extra.source_count).toBe(1);
    expect(c?.extra.last_seen).toBe(2025);
  });

  test("preserves caller-supplied extra keys (kind, severity, etc.)", () => {
    const result = fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "x",
      extra: { kind: "heads-up", severity: "high", custom: 42 },
    });

    const repo = new ComplaintsRepo(db);
    const c = repo.getById(result.id);
    expect(c?.extra.kind).toBe("heads-up");
    expect(c?.extra.severity).toBe("high");
    expect(c?.extra.custom).toBe(42);
    // filer-owned fields still set
    expect(c?.extra.source_count).toBe(1);
    expect(c?.extra.last_seen).toBe(1000);
  });

  test("source_count + last_seen overwrite caller-supplied values for those two keys", () => {
    const result = fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "x",
      // Sneaky caller tries to seed source_count=99 — filer wins.
      extra: { source_count: 99, last_seen: 12345, kind: "heads-up" },
    });

    const repo = new ComplaintsRepo(db);
    const c = repo.getById(result.id);
    expect(c?.extra.source_count).toBe(1);
    expect(c?.extra.last_seen).toBe(1000);
    expect(c?.extra.kind).toBe("heads-up");
  });
});

// ---------- Dedup within window ----------

describe("fileDedupedComplaint — bump within window", () => {
  test("second file within window bumps existing row (no new insert)", () => {
    const first = fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "first",
    });
    const second = fileDedupedComplaint(db, 1500, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "second",
    });

    expect(second.isNew).toBe(false);
    expect(second.id).toBe(first.id);
    expect(second.sourceCount).toBe(2);

    const repo = new ComplaintsRepo(db);
    const all = repo.list();
    expect(all.length).toBe(1);
  });

  test("third bump increments source_count to 3", () => {
    fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "x",
    });
    fileDedupedComplaint(db, 1500, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "x",
    });
    const third = fileDedupedComplaint(db, 2000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "x",
    });

    expect(third.sourceCount).toBe(3);
  });

  test("bump preserves the original opened_at + incident_summary + caller-supplied extra keys", () => {
    const first = fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "ORIGINAL",
      extra: { kind: "heads-up", severity: "high" },
    });
    fileDedupedComplaint(db, 1500, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "BUMP-WOULD-OVERWRITE",
      extra: { kind: "different", custom: "value" },
    });

    const repo = new ComplaintsRepo(db);
    const c = repo.getById(first.id);
    // Original incident_summary preserved (not overwritten by bump)
    expect(c?.incidentSummary).toBe("ORIGINAL");
    expect(c?.openedAt).toBe(1000);
    // Caller-supplied extra keys preserved from FIRST file
    expect(c?.extra.kind).toBe("heads-up");
    expect(c?.extra.severity).toBe("high");
    // last_seen advanced
    expect(c?.extra.last_seen).toBe(1500);
    expect(c?.extra.source_count).toBe(2);
  });

  test("legacy row without source_count defaults to prev=1, bumps to 2", () => {
    // Simulate a pre-T2 complaint filed manually (no source_count in extra)
    const repo = new ComplaintsRepo(db);
    repo.insert({
      id: "c-legacy01",
      openedAt: 1000,
      openedBy: "operator",
      incidentSummary: "manual legacy complaint",
      rootCause: null,
      preventiveAsk: null,
      status: "open",
      resolvedAt: null,
      resolvedBy: null,
      relatedTaskId: null,
      sourceKind: "operator",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      extra: { kind: "heads-up" }, // no source_count
    });

    const result = fileDedupedComplaint(db, 1500, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "x",
    });

    expect(result.isNew).toBe(false);
    expect(result.id).toBe("c-legacy01");
    expect(result.sourceCount).toBe(2);
  });

  test("last_seen advances on each bump", () => {
    const first = fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "x",
    });
    fileDedupedComplaint(db, 1234, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "x",
    });
    fileDedupedComplaint(db, 2222, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "x",
    });

    const repo = new ComplaintsRepo(db);
    const c = repo.getById(first.id);
    expect(c?.extra.last_seen).toBe(2222);
  });
});

// ---------- Outside window — fresh row ----------

describe("fileDedupedComplaint — outside dedup window", () => {
  test("re-file outside default 1h window inserts a fresh row", () => {
    const first = fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "first",
    });
    // 2h later — outside the 1h default window
    const second = fileDedupedComplaint(db, 1000 + 7201, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "second",
    });

    expect(second.isNew).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(second.sourceCount).toBe(1);

    const repo = new ComplaintsRepo(db);
    expect(repo.list().length).toBe(2);
  });

  test("custom dedupWindowSec respected — tighter window forces fresh insert", () => {
    const first = fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "first",
      dedupWindowSec: 60,
    });
    // 90s later — outside the 60s custom window
    const second = fileDedupedComplaint(db, 1090, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "second",
      dedupWindowSec: 60,
    });

    expect(second.isNew).toBe(true);
    expect(second.id).not.toBe(first.id);
  });

  test("custom dedupWindowSec — within wider window bumps", () => {
    fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "first",
      dedupWindowSec: 7200,
    });
    // 1h15min later — within the 2h custom window
    const second = fileDedupedComplaint(db, 1000 + 4500, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "second",
      dedupWindowSec: 7200,
    });

    expect(second.isNew).toBe(false);
    expect(second.sourceCount).toBe(2);
  });
});

// ---------- Status filter ----------

describe("fileDedupedComplaint — status filter", () => {
  test("resolved complaint does not block fresh insert on same source_id", () => {
    const first = fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "first",
    });
    // Manually resolve the first row (simulating superdoctor closing it out)
    const repo = new ComplaintsRepo(db);
    repo.resolve({
      id: first.id,
      status: "resolved",
      resolvedAt: 1200,
      resolvedBy: "superdoctor",
    });

    // Second file within the 1h window — should insert fresh, not bump
    const second = fileDedupedComplaint(db, 1500, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "second",
    });

    expect(second.isNew).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(second.sourceCount).toBe(1);
  });

  test("wontfix complaint also does not block fresh insert", () => {
    const first = fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "first",
    });
    const repo = new ComplaintsRepo(db);
    repo.resolve({ id: first.id, status: "wontfix", resolvedAt: 1100 });

    const second = fileDedupedComplaint(db, 1500, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "second",
    });
    expect(second.isNew).toBe(true);
  });
});

// ---------- Per-source_id isolation ----------

describe("fileDedupedComplaint — per-source_id isolation", () => {
  test("different source_id always inserts fresh, never dedups", () => {
    const a = fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "eta",
    });
    const b = fileDedupedComplaint(db, 1100, {
      sourceKind: "whip",
      sourceId: "whip-team-a-classifier-swallow",
      targetTeam: "team-a",
      incidentSummary: "classifier",
    });

    expect(a.isNew).toBe(true);
    expect(b.isNew).toBe(true);
    expect(a.id).not.toBe(b.id);

    const repo = new ComplaintsRepo(db);
    expect(repo.list().length).toBe(2);
  });

  test("per-team isolation via source_id (whip-<team>-* convention)", () => {
    fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "x",
    });
    const teamB = fileDedupedComplaint(db, 1100, {
      sourceKind: "whip",
      sourceId: "whip-team-b-eta-lied",
      targetTeam: "team-b",
      incidentSummary: "x",
    });
    expect(teamB.isNew).toBe(true);
    expect(teamB.sourceCount).toBe(1);
  });
});

// ---------- Boundary cases ----------

describe("fileDedupedComplaint — window boundary", () => {
  test("re-file at exactly sinceSec boundary bumps (inclusive lower bound)", () => {
    // First file at t=1000 with windowSec=60. Second at t=1060 — exactly
    // at the boundary. Since `opened_at >= sinceSec` where sinceSec = 1060
    // - 60 = 1000, the original row IS still in scope.
    fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "first",
      dedupWindowSec: 60,
    });
    const second = fileDedupedComplaint(db, 1060, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "second",
      dedupWindowSec: 60,
    });
    expect(second.isNew).toBe(false);
  });

  test("re-file 1s past window forces fresh", () => {
    fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "first",
      dedupWindowSec: 60,
    });
    const second = fileDedupedComplaint(db, 1061, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "second",
      dedupWindowSec: 60,
    });
    expect(second.isNew).toBe(true);
  });
});

// ---------- ComplaintsRepo.findOpenBySourceId + bumpSourceCount ----------

describe("ComplaintsRepo.findOpenBySourceId", () => {
  test("returns null when source_id unknown", () => {
    const repo = new ComplaintsRepo(db);
    expect(repo.findOpenBySourceId("nope", 0)).toBeNull();
  });

  test("returns null when matching row pre-dates sinceSec", () => {
    fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "x",
    });
    const repo = new ComplaintsRepo(db);
    expect(repo.findOpenBySourceId("whip-team-a-eta-lied", 2000)).toBeNull();
  });

  test("returns most recent open row matching source_id at or after sinceSec", () => {
    fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "first",
    });
    const repo = new ComplaintsRepo(db);
    const found = repo.findOpenBySourceId("whip-team-a-eta-lied", 500);
    expect(found?.openedAt).toBe(1000);
    expect(found?.incidentSummary).toBe("first");
  });
});

describe("ComplaintsRepo.bumpSourceCount", () => {
  test("returns false when id is unknown", () => {
    const repo = new ComplaintsRepo(db);
    expect(repo.bumpSourceCount("c-nope", 1000, 2)).toBe(false);
  });

  test("preserves other extra keys when bumping", () => {
    const filed = fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-eta-lied",
      targetTeam: "team-a",
      incidentSummary: "x",
      extra: { kind: "heads-up", severity: "high", custom: "preserved" },
    });
    const repo = new ComplaintsRepo(db);
    const ok = repo.bumpSourceCount(filed.id, 2000, 5);
    expect(ok).toBe(true);
    const c = repo.getById(filed.id);
    expect(c?.extra.source_count).toBe(5);
    expect(c?.extra.last_seen).toBe(2000);
    expect(c?.extra.kind).toBe("heads-up");
    expect(c?.extra.severity).toBe("high");
    expect(c?.extra.custom).toBe("preserved");
  });
});

describe("ComplaintsRepo.countByStatus", () => {
  test("counts mixed statuses independently", () => {
    const open = fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-open",
      targetTeam: "team-a",
      incidentSummary: "open",
    });
    const openTwo = fileDedupedComplaint(db, 1050, {
      sourceKind: "whip",
      sourceId: "whip-team-a-open-2",
      targetTeam: "team-a",
      incidentSummary: "open-2",
    });
    const resolved = fileDedupedComplaint(db, 1100, {
      sourceKind: "whip",
      sourceId: "whip-team-a-resolved",
      targetTeam: "team-a",
      incidentSummary: "resolved",
    });
    const wontfix = fileDedupedComplaint(db, 1200, {
      sourceKind: "whip",
      sourceId: "whip-team-a-wontfix",
      targetTeam: "team-a",
      incidentSummary: "wontfix",
    });

    const repo = new ComplaintsRepo(db);
    repo.resolve({ id: resolved.id, status: "resolved", resolvedAt: 1300 });
    repo.resolve({ id: wontfix.id, status: "wontfix", resolvedAt: 1400 });

    expect(repo.countByStatus("open")).toBe(2);
    expect(repo.countByStatus("resolved")).toBe(1);
    expect(repo.countByStatus("wontfix")).toBe(1);
    expect(repo.getById(open.id)?.status).toBe("open");
    expect(repo.getById(openTwo.id)?.status).toBe("open");
  });
});

describe("ComplaintsRepo.mergeExtra", () => {
  test("returns false when id is unknown", () => {
    const repo = new ComplaintsRepo(db);
    expect(repo.mergeExtra("c-nope", { kind: "heads-up" })).toBe(false);
  });

  test("shallow-merges patch onto existing extra while preserving unpatched keys", () => {
    const filed = fileDedupedComplaint(db, 1000, {
      sourceKind: "whip",
      sourceId: "whip-team-a-merge-extra",
      targetTeam: "team-a",
      incidentSummary: "x",
      extra: { kind: "heads-up", severity: "high", custom: "preserved" },
    });

    const repo = new ComplaintsRepo(db);
    const ok = repo.mergeExtra(filed.id, {
      severity: "low",
      patchOnly: "applied",
    });

    expect(ok).toBe(true);
    const c = repo.getById(filed.id);
    expect(c?.extra.kind).toBe("heads-up");
    expect(c?.extra.severity).toBe("low");
    expect(c?.extra.custom).toBe("preserved");
    expect(c?.extra.patchOnly).toBe("applied");
    expect(c?.extra.source_count).toBe(1);
    expect(c?.extra.last_seen).toBe(1000);
  });
});
