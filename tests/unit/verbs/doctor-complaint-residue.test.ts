// Unit tests for the t-a1f9e37e `complaint-row-residue` doctor probe
// (src/verbs/doctor/complaint-row-residue.ts): flags rows whose
// target_team differs from the DB-owning team with no --no-route
// record; silent on clean fleets. Pattern mirror:
// tests/unit/verbs/doctor-claude-accounts.test.ts — same pure/I-O
// describe split, same scratch-via-mkdtemp + cleanup.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { ComplaintsRepo } from "../../../src/core/repositories/complaints-repo.ts";
import type { Complaint } from "../../../src/schema/complaints.ts";
import {
  type ComplaintResidueCandidate,
  checkComplaintResidue,
  complaintResidueStateRows,
} from "../../../src/verbs/doctor/complaint-row-residue.ts";

function candidate(over: Partial<ComplaintResidueCandidate>): ComplaintResidueCandidate {
  return {
    id: "c-00000001",
    targetTeam: "team-b",
    noRoute: false,
    ownerTeam: "team-a",
    atmuxDir: "/tmp/x/.atmux",
    ...over,
  };
}

describe("complaintResidueStateRows (pure)", () => {
  test("foreign target without no-route marker → single yellow row naming the id", () => {
    const rows = complaintResidueStateRows([candidate({})]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("complaint-row-residue");
    expect(rows[0]?.detail).toContain("c-00000001");
    expect(rows[0]?.detail).toContain("team-b");
  });

  test("clean: target == owner, null target, and no-route rows stay silent", () => {
    expect(
      complaintResidueStateRows([
        candidate({ id: "c-1", targetTeam: "team-a", ownerTeam: "team-a" }),
        candidate({ id: "c-2", targetTeam: null, ownerTeam: "team-a" }),
        candidate({ id: "c-3", targetTeam: "team-b", ownerTeam: "team-a", noRoute: true }),
      ]),
    ).toEqual([]);
  });

  test("empty input → silent", () => {
    expect(complaintResidueStateRows([])).toEqual([]);
  });
});

describe("checkComplaintResidue (I/O wrapper)", () => {
  let scratch: string;
  let dirA: string;
  let dirB: string;

  function complaint(id: string, targetTeam: string | null, noRoute: boolean): Complaint {
    return {
      id,
      openedAt: 1700000000,
      openedBy: null,
      incidentSummary: `row ${id}`,
      rootCause: null,
      preventiveAsk: null,
      status: "open",
      resolvedAt: null,
      resolvedBy: null,
      relatedTaskId: null,
      sourceKind: null,
      sourceId: null,
      targetTeam,
      originTeam: null,
      extra: noRoute ? { no_route: true } : {},
    };
  }

  function seedDb(dir: string, rows: Complaint[]): void {
    const db = openDatabase(join(dir, ".atmux", "state.db"), migrations);
    try {
      const repo = new ComplaintsRepo(db);
      for (const c of rows) repo.insert(c);
    } finally {
      closeDatabase(db);
    }
  }

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-residue-"));
    dirA = join(scratch, "team-a-root");
    dirB = join(scratch, "team-b-root");
    for (const d of [dirA, dirB]) await mkdir(join(d, ".atmux"), { recursive: true });
    await writeFile(
      join(scratch, "cockpit.json"),
      JSON.stringify({
        sessions: [
          { type: "team", name: "team-a", root: dirA },
          { type: "team", name: "team-b", root: dirB },
        ],
      }),
    );
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("flags pre-routing residue; ignores routed + no-route + own-team rows", async () => {
    seedDb(dirA, [
      complaint("c-residue1", "team-b", false),
      complaint("c-noroute1", "team-b", true),
      complaint("c-own1", "team-a", false),
    ]);
    seedDb(dirB, [complaint("c-routed1", "team-b", false)]);
    const rows = await checkComplaintResidue({
      cockpit: { path: join(scratch, "cockpit.json") },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("complaint-row-residue");
    expect(rows[0]?.detail).toContain("c-residue1");
    expect(rows[0]?.detail).not.toContain("c-noroute1");
    expect(rows[0]?.detail).not.toContain("c-own1");
    expect(rows[0]?.detail).not.toContain("c-routed1");
  });

  test("clean fleet → silent", async () => {
    seedDb(dirA, [complaint("c-own1", "team-a", false)]);
    seedDb(dirB, [complaint("c-routed1", "team-b", false)]);
    await expect(
      checkComplaintResidue({ cockpit: { path: join(scratch, "cockpit.json") } }),
    ).resolves.toEqual([]);
  });

  test("missing cockpit registry → silent", async () => {
    await expect(
      checkComplaintResidue({ cockpit: { path: join(scratch, "no-such-cockpit.json") } }),
    ).resolves.toEqual([]);
  });
});
