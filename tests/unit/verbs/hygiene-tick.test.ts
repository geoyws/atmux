// Unit tests for src/verbs/hygiene-tick.ts (ADR-131 T3 verb /
// t-247b4b35).
//
// Coverage:
//   parseHygieneTickArgs — defaults, --team-dir, --no-json, unknown arg.
//   hygieneTick integration — wires team.json + state.db; injects
//     mock FixDeps + nowSeconds; verifies JSON output shape on
//     stdout AND the side-effect (kanban row reassigned via the
//     mock assignVerb).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { KanbanRepo } from "../../../src/core/repositories/kanban-repo.ts";
import type { FixDeps } from "../../../src/core/superdoctor-hygiene/_shared.ts";
import { UsageError } from "../../../src/errors.ts";
import { hygieneTick, parseHygieneTickArgs } from "../../../src/verbs/hygiene-tick.ts";

let teamDir: string;
let atmuxDir: string;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-hygiene-tick-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
});

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string }> {
  let stdout = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    stdout += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await fn();
    return { result, stdout };
  } finally {
    process.stdout.write = orig;
  }
}

function recorderDeps(): FixDeps & { calls: { verb: string; args: string[] }[] } {
  const calls: { verb: string; args: string[] }[] = [];
  return {
    calls,
    assignVerb: async (id, m) => {
      calls.push({ verb: "assign", args: [id, m] });
    },
    laneVerb: async (id, lane) => {
      calls.push({ verb: "lane", args: [id, lane] });
    },
    priorityVerb: async (id, p) => {
      calls.push({ verb: "priority", args: [id, String(p)] });
    },
  };
}

// ---------- parser ----------

describe("parseHygieneTickArgs", () => {
  test("empty argv → defaults (json=true, no teamDir)", () => {
    const args = parseHygieneTickArgs([]);
    expect(args.json).toBe(true);
    expect(args.teamDir).toBeUndefined();
  });

  test("--json explicit → json=true", () => {
    expect(parseHygieneTickArgs(["--json"]).json).toBe(true);
  });

  test("--no-json → json=false", () => {
    expect(parseHygieneTickArgs(["--no-json"]).json).toBe(false);
  });

  test("--team-dir <path> consumed", () => {
    expect(parseHygieneTickArgs(["--team-dir", "/x"]).teamDir).toBe("/x");
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseHygieneTickArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown arg → UsageError", () => {
    expect(() => parseHygieneTickArgs(["--bogus"])).toThrow(UsageError);
  });
});

// ---------- hygieneTick integration ----------

describe("hygieneTick — integration", () => {
  /** Stage a team.json + state.db with one ghost-owner task. */
  async function stageGhostOwner(): Promise<void> {
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "test-team",
        members: [
          { name: "fe-1", role: "member", lane: "fe" },
          { name: "fe-2", role: "member", lane: "fe" },
        ],
      }),
    );
    // Seed state.db with one ghost-owned task.
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    try {
      const repo = new KanbanRepo(db);
      repo.upsertTask({
        id: "t-ghost",
        subject: "ghost",
        status: "todo",
        owner: "fe-ghost",
        lane: "fe",
        createdAt: 100,
      });
    } finally {
      closeDatabase(db);
    }
  }

  test("happy path — detects ghost-owner, drains, JSON output on stdout, recorder verbs invoked", async () => {
    await stageGhostOwner();
    const deps = recorderDeps();
    const { result, stdout } = await captureStdout(() =>
      hygieneTick(["--team-dir", teamDir, "--json"], {
        fixDeps: deps,
        nowSeconds: () => 1000,
      }),
    );
    expect(result.detected).toBe(1);
    expect(result.drained?.row.fingerprintClass).toBe("ghost-owner");
    expect(result.drained?.result.applied).toBe(true);
    // fe-1 wins alphabetical tiebreak
    expect(deps.calls).toEqual([{ verb: "assign", args: ["t-ghost", "fe-1"] }]);
    // JSON-on-stdout shape
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.detected).toBe(1);
    expect(parsed.drained.row.taskId).toBe("t-ghost");
  });

  test("--no-json → human-readable output", async () => {
    await stageGhostOwner();
    const { stdout } = await captureStdout(() =>
      hygieneTick(["--team-dir", teamDir, "--no-json"], {
        fixDeps: recorderDeps(),
        nowSeconds: () => 1000,
      }),
    );
    expect(stdout).toContain("hygiene-tick:");
    expect(stdout).toContain("detected");
    expect(stdout).toContain("drained");
    expect(stdout).toContain("t-ghost");
    expect(stdout).toContain("ghost-owner");
  });

  test("empty kanban → detected=0, drained=null, skipReason='no-unfixed'", async () => {
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({ name: "empty-team", members: [{ name: "fe-1", lane: "fe" }] }),
    );
    // Pre-create the state.db (migrations) so the openDatabase call
    // succeeds without preexisting tasks.
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    closeDatabase(db);
    const { result } = await captureStdout(() =>
      hygieneTick(["--team-dir", teamDir, "--json"], {
        fixDeps: recorderDeps(),
        nowSeconds: () => 1000,
      }),
    );
    expect(result.detected).toBe(0);
    expect(result.drained).toBeNull();
    expect(result.skipReason).toBe("no-unfixed");
  });
});
