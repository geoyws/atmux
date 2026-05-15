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

  test("--no-phantom-prune → phantomPrune=false (t-d6fc03a7)", () => {
    expect(parseHygieneTickArgs(["--no-phantom-prune"]).phantomPrune).toBe(false);
  });

  test("phantomPrune defaults to true (sub-op on by default per t-d6fc03a7)", () => {
    expect(parseHygieneTickArgs([]).phantomPrune).toBe(true);
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

// ---------- hygieneTick — phantom-prune sub-op (t-d6fc03a7) ----------

describe("hygieneTick — phantom-prune sub-op (t-d6fc03a7)", () => {
  /** Stage a team.json + state.db with one in-progress task
   *  claimed by `owner` at `claimedAt` epoch seconds. */
  async function stageInProgress(opts: {
    owner: string;
    claimedAt: number;
    taskId?: string;
    singleSession?: boolean;
  }): Promise<string> {
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "phantom-test",
        members: [
          { name: "fe-1", role: "member", lane: "fe" },
          { name: opts.owner, role: "member", lane: "fe" },
        ],
        ...(opts.singleSession === true ? { singleSession: true } : {}),
      }),
    );
    const taskId = opts.taskId ?? "t-phantom-1";
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    try {
      const repo = new KanbanRepo(db);
      repo.upsertTask({
        id: taskId,
        subject: "in-flight",
        status: "in-progress",
        owner: opts.owner,
        lane: "fe",
        createdAt: opts.claimedAt - 60,
        claimedAt: opts.claimedAt,
      });
    } finally {
      closeDatabase(db);
    }
    return taskId;
  }

  test("happy path — phantom past age window + owner dead-pane → pruned", async () => {
    const claimedAt = 1_700_000_000;
    const id = await stageInProgress({ owner: "ghost", claimedAt });
    // nowSec = claimedAt + 25h (well past the 24h default window).
    const { result, stdout } = await captureStdout(() =>
      hygieneTick(["--team-dir", teamDir, "--json"], {
        fixDeps: recorderDeps(),
        nowSeconds: () => claimedAt + 90_000,
        liveMembersProbe: async () => new Set(), // every pane dead
      }),
    );
    expect(result.phantomPrune).not.toBeNull();
    const p = result.phantomPrune;
    if (p === null) throw new Error("phantomPrune is null");
    expect(p.detected).toBe(1);
    expect(p.prunedIds).toEqual([id]);
    expect(p.alreadyPrunedIds).toEqual([]);
    expect(p.skipReason).toBe("");
    // JSON-on-stdout carries the sub-op result.
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.phantomPrune.prunedIds).toEqual([id]);
  });

  test("fresh claim within age window → skipped (no-candidates)", async () => {
    const claimedAt = 1_700_000_000;
    await stageInProgress({ owner: "ghost", claimedAt });
    // nowSec = claimedAt + 100s (well inside the 24h window).
    const { result } = await captureStdout(() =>
      hygieneTick(["--team-dir", teamDir, "--json"], {
        fixDeps: recorderDeps(),
        nowSeconds: () => claimedAt + 100,
        liveMembersProbe: async () => new Set(),
      }),
    );
    expect(result.phantomPrune).not.toBeNull();
    const p = result.phantomPrune;
    if (p === null) throw new Error("phantomPrune is null");
    expect(p.detected).toBe(0);
    expect(p.prunedIds).toEqual([]);
    expect(p.skipReason).toBe("no-candidates");
  });

  test("--no-phantom-prune → skipReason='disabled'", async () => {
    const claimedAt = 1_700_000_000;
    await stageInProgress({ owner: "ghost", claimedAt });
    const { result } = await captureStdout(() =>
      hygieneTick(["--team-dir", teamDir, "--no-phantom-prune", "--json"], {
        fixDeps: recorderDeps(),
        nowSeconds: () => claimedAt + 90_000,
        liveMembersProbe: async () => new Set(),
      }),
    );
    expect(result.phantomPrune).not.toBeNull();
    const p = result.phantomPrune;
    if (p === null) throw new Error("phantomPrune is null");
    expect(p.skipReason).toBe("disabled");
    expect(p.prunedIds).toEqual([]);
  });

  test("singleSession team → skipReason='singleSession' (ADR-026 — no cage to probe)", async () => {
    const claimedAt = 1_700_000_000;
    await stageInProgress({ owner: "ghost", claimedAt, singleSession: true });
    const { result } = await captureStdout(() =>
      hygieneTick(["--team-dir", teamDir, "--json"], {
        fixDeps: recorderDeps(),
        nowSeconds: () => claimedAt + 90_000,
        liveMembersProbe: async () => new Set(),
      }),
    );
    expect(result.phantomPrune).not.toBeNull();
    const p = result.phantomPrune;
    if (p === null) throw new Error("phantomPrune is null");
    expect(p.skipReason).toBe("singleSession");
  });

  test("liveMembersProbe throws → skipReason='probe-failed' (no writes)", async () => {
    const claimedAt = 1_700_000_000;
    const id = await stageInProgress({ owner: "ghost", claimedAt });
    const { result } = await captureStdout(() =>
      hygieneTick(["--team-dir", teamDir, "--json"], {
        fixDeps: recorderDeps(),
        nowSeconds: () => claimedAt + 90_000,
        liveMembersProbe: async () => {
          throw new Error("tmux down");
        },
      }),
    );
    expect(result.phantomPrune).not.toBeNull();
    const p = result.phantomPrune;
    if (p === null) throw new Error("phantomPrune is null");
    expect(p.skipReason).toBe("probe-failed");
    // The row MUST still be in-progress — probe-failed paths cannot write.
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    try {
      const after = new KanbanRepo(db).getTask(id);
      expect(after?.status).toBe("in-progress");
    } finally {
      closeDatabase(db);
    }
  });

  test("second tick after prune → row no longer surfaced (steady-state idempotent)", async () => {
    const claimedAt = 1_700_000_000;
    const id = await stageInProgress({ owner: "ghost", claimedAt });
    const liveMembersProbe = async () => new Set<string>();
    // First tick — prunes the row to blocked.
    const first = await captureStdout(() =>
      hygieneTick(["--team-dir", teamDir, "--json"], {
        fixDeps: recorderDeps(),
        nowSeconds: () => claimedAt + 90_000,
        liveMembersProbe,
      }),
    );
    expect(first.result.phantomPrune?.prunedIds).toEqual([id]);

    // Second tick on the same kanban state. The row is now
    // `status=blocked`, so `findPhantomInProgressClaims`
    // (status-scope='in-progress') doesn't surface it. Sub-op reports
    // no-candidates — there's nothing to act on. This is the
    // steady-state idempotent shape: once a row is auto-pruned, the
    // in-progress sweep stops seeing it, and the underlying note
    // stays unchanged.
    const { result: second } = await captureStdout(() =>
      hygieneTick(["--team-dir", teamDir, "--json"], {
        fixDeps: recorderDeps(),
        nowSeconds: () => claimedAt + 90_000,
        liveMembersProbe,
      }),
    );
    expect(second.phantomPrune).not.toBeNull();
    const p = second.phantomPrune;
    if (p === null) throw new Error("phantomPrune is null");
    expect(p.detected).toBe(0);
    expect(p.skipReason).toBe("no-candidates");

    // Verify the kanban row stayed in `blocked` with the
    // `auto-pruned … via hygiene-tick` note from tick 1.
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    try {
      const after = new KanbanRepo(db).getTask(id);
      expect(after?.status).toBe("blocked");
      expect(after?.note ?? "").toContain("auto-pruned");
      expect(after?.note ?? "").toContain("hygiene-tick");
    } finally {
      closeDatabase(db);
    }
  });

  test("owner with live pane → no prune even past age window", async () => {
    const claimedAt = 1_700_000_000;
    await stageInProgress({ owner: "ghost", claimedAt });
    const { result } = await captureStdout(() =>
      hygieneTick(["--team-dir", teamDir, "--json"], {
        fixDeps: recorderDeps(),
        nowSeconds: () => claimedAt + 90_000,
        liveMembersProbe: async () => new Set(["ghost"]), // owner alive
      }),
    );
    expect(result.phantomPrune).not.toBeNull();
    const p = result.phantomPrune;
    if (p === null) throw new Error("phantomPrune is null");
    expect(p.skipReason).toBe("no-candidates");
    expect(p.prunedIds).toEqual([]);
  });

  test("phantomMinAgeSec=0 override → no age filter (any dead-pane in-progress pruned)", async () => {
    const claimedAt = 1_700_000_000;
    const id = await stageInProgress({ owner: "ghost", claimedAt });
    // nowSec = claimedAt + 1s (would normally be inside any age window).
    const { result } = await captureStdout(() =>
      hygieneTick(["--team-dir", teamDir, "--json"], {
        fixDeps: recorderDeps(),
        nowSeconds: () => claimedAt + 1,
        liveMembersProbe: async () => new Set(),
        phantomMinAgeSec: 0,
      }),
    );
    const p = result.phantomPrune;
    if (p === null) throw new Error("phantomPrune is null");
    expect(p.prunedIds).toEqual([id]);
  });

  test("human-readable output surfaces the sub-op line", async () => {
    const claimedAt = 1_700_000_000;
    await stageInProgress({ owner: "ghost", claimedAt });
    const { stdout } = await captureStdout(() =>
      hygieneTick(["--team-dir", teamDir, "--no-json"], {
        fixDeps: recorderDeps(),
        nowSeconds: () => claimedAt + 90_000,
        liveMembersProbe: async () => new Set(),
      }),
    );
    expect(stdout).toContain("phantom-prune:");
    expect(stdout).toContain("1 detected");
    expect(stdout).toContain("1 pruned");
  });
});
