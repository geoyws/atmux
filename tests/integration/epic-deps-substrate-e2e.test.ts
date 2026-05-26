// ADR-225 end-to-end smoke — exercises the full v13→v14 substrate
// from migration through CLI verbs through spawn-epic gate through
// Honker events. T7 of EPIC e-cf8a6195 (master design task
// t-802c468b).
//
// Single integration spec covering the canonical 3-epic chain that
// orchd Phase 2 will rely on. Closes the gaps between unit tests
// (which exercise each layer in isolation) and serves as the
// reference fixture for sibling EPIC e-60e16169 (orchd auto-spawn).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSpawn } from "../../src/abstractions/branch-merge.ts";
import type { SpawnResult } from "../../src/abstractions/spawn.ts";
import { closeDatabase, openDatabase } from "../../src/abstractions/sqlite.ts";
import { migrations } from "../../src/abstractions/sqlite-migrations.ts";
import {
  addEpic,
  advanceEpic,
  setEpicReady,
  showEpic,
} from "../../src/core/epic.ts";
import type { HostPressureVerdict } from "../../src/core/host-pressure.ts";
import { epic } from "../../src/verbs/epic.ts";
import {
  type SpawnEpicOpts,
  spawnEpic,
} from "../../src/verbs/team/spawn-epic.ts";

let scratch: string;
let teamDir: string;
let atmuxDir: string;
let cockpitPath: string;
let templatesDir: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-deps-e2e-"));
  teamDir = join(scratch, "parent-team");
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  // Bootstrap v0→v14 ladder.
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  closeDatabase(db);
  // team.json with a lead so advanceEpic→review dispatch succeeds.
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({
      name: "parent-team",
      members: [{ name: "lead", role: "team-lead" }],
    }),
  );
  // Templates dir + a default roster preset (needed by spawn-epic).
  templatesDir = join(scratch, "templates", "epic-rosters");
  await mkdir(templatesDir, { recursive: true });
  await writeFile(
    join(templatesDir, "default.json"),
    JSON.stringify({
      members: [
        { name: "lead", role: "lead", tui: "claude" },
        { name: "planner", role: "planner", tui: "claude" },
        { name: "reviewer", role: "reviewer", tui: "claude" },
        { name: "be-1", role: "member", lane: "be", tui: "claude" },
      ],
    }),
  );
  // Cockpit with the parent-team registered.
  cockpitPath = join(scratch, "cockpit.json");
  await writeFile(
    cockpitPath,
    JSON.stringify({
      schemaVersion: 1,
      sessions: [
        {
          type: "team",
          name: "parent-team",
          enabled: true,
          root: teamDir,
        },
      ],
    }),
  );
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Capture process.stdout into a string for the duration of fn. */
async function captureStdout<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    out += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await fn();
    return { out, result };
  } finally {
    process.stdout.write = orig;
  }
}

/** Permissive host-pressure probe + git stub for the spawn-epic path —
 *  mirrors the unit-test fixtures so we don't repeat the same stubs. */
const permissivePressure: NonNullable<SpawnEpicOpts["probeHostPressure"]> = async () =>
  ({
    ok: true,
    reasons: [],
    probe: null,
    thresholds: null,
    skipped: true,
  }) satisfies HostPressureVerdict;

function makeGitStub(): GitSpawn {
  return async (argv_) => {
    const ok = (stdout: string): SpawnResult => ({
      exitCode: 0,
      stdout,
      stderr: "",
      argv: [],
      cmd: "git",
      signalled: null,
      durationMs: 0,
    });
    if (argv_.includes("rev-parse") && argv_.includes("--abbrev-ref")) {
      return ok("main");
    }
    if (argv_.includes("worktree") && argv_.includes("add")) {
      const wtPath = argv_[argv_.length - 2];
      if (wtPath !== undefined) {
        await mkdir(wtPath, { recursive: true }).catch(() => undefined);
      }
      return ok("");
    }
    return ok("");
  };
}

function makeSpawnOpts(homeDir: string): SpawnEpicOpts {
  return {
    cockpitPath,
    probeHostPressure: permissivePressure,
    templatesDir,
    callerScope: () => "driver",
    env: { ...process.env, HOME: homeDir, ATMUX_MEMBER: "be-1" },
    git: makeGitStub(),
    logger: { log: () => undefined, warn: () => undefined },
    logSpawnOverrideOpts: { homeDir, now: () => 1_700_000_000_000 },
  };
}

/** Read every row from the `events` table for assertions. */
function readEvents(): Array<{
  topic: string;
  payload: Record<string, unknown>;
}> {
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  try {
    const rows = db
      .prepare("SELECT topic, payload FROM events ORDER BY emitted_at_sec ASC, event_id ASC")
      .all() as Array<{ topic: string; payload: string }>;
    return rows.map((r) => ({
      topic: r.topic,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }));
  } finally {
    closeDatabase(db);
  }
}

describe("ADR-225 substrate — 3-epic chain end-to-end", () => {
  test("happy path: chain A→B→C; epic.ready + epic.unblocked fire as deps clear; spawn-epic gate refuses then succeeds", async () => {
    // ---------- 1. Build the chain: A deps_on [B], B deps_on [C], C leaf.
    const c = await addEpic(atmuxDir, { title: "C" });
    const b = await addEpic(atmuxDir, { title: "B", dependsOn: [c] });
    const a = await addEpic(atmuxDir, { title: "A", dependsOn: [b] });

    // ---------- 2. `atmux epic list` shows R + D columns correctly.
    const { out: listOut } = await captureStdout(async () => {
      return await epic(["list", "--team-dir", teamDir]);
    });
    // C has no deps → D=`-`. B has 1 dep (c, planning) → D=0/1. A
    // has 1 dep (b, planning) → D=0/1. R=0 for all (none ready).
    const cLine = listOut.split("\n").find((l) => l.startsWith(c));
    const bLine = listOut.split("\n").find((l) => l.startsWith(b));
    const aLine = listOut.split("\n").find((l) => l.startsWith(a));
    expect(cLine).toMatch(/\s0\s+-\s/);
    expect(bLine).toMatch(/\s0\s+0\/1\s/);
    expect(aLine).toMatch(/\s0\s+0\/1\s/);

    // ---------- 3. `atmux epic deps A` renders the 3-level tree.
    const { out: depsOut } = await captureStdout(async () => {
      return await epic(["deps", a, "--team-dir", teamDir]);
    });
    expect(depsOut).toContain(a);
    expect(depsOut).toContain(`  ${b}`);
    expect(depsOut).toContain(`    ${c}`);

    // ---------- 4. spawn-epic A — refused (is_ready=0 AND unmet deps).
    const homeDir = join(scratch, "home");
    await mkdir(homeDir, { recursive: true });
    await expect(spawnEpic(["a-spawn", "--from", "parent-team"], {
      ...makeSpawnOpts(homeDir),
      // Use the real predicate against the seeded chain.
    })).rejects.toThrow();

    // ---------- 5. `epic ready A` → epic.ready event lands.
    await setEpicReady(atmuxDir, a, true);
    const eventsAfterReady = readEvents().filter((e) => e.topic === "epic.ready");
    expect(eventsAfterReady).toHaveLength(1);
    expect(eventsAfterReady[0]?.payload.epicId).toBe(a);

    // spawn-epic A still refused (deps unmet even though is_ready=1).
    // Re-shape the spawn-epic arg shape: pass the epic kanban id.
    // The verb keys off `--parent-epic-kanban-id` (defaults to `e-<id>`)
    // — use that to point at `a`.
    await expect(
      spawnEpic(
        ["a-spawn", "--from", "parent-team", "--parent-epic-kanban-id", a],
        makeSpawnOpts(homeDir),
      ),
    ).rejects.toThrow(/not eligible/);

    // ---------- 6. Advance C to done — at THIS layer, A's deps include
    //              only B (not C); B is still planning + B's own deps
    //              just cleared. So no epic.unblocked for A. Per the
    //              ADR §OQ-4: emit only on the LAST unmet dep transition.
    //              The chain's transitive substrate cares about A's
    //              direct deps only.
    await advanceEpic(atmuxDir, c, "ready");
    await advanceEpic(atmuxDir, c, "in-progress");
    await advanceEpic(atmuxDir, c, "review");
    await advanceEpic(atmuxDir, c, "done");
    // B's deps just cleared (C went done) → emit epic.unblocked FOR B
    // (byEpicId=C). A is NOT yet unblocked because B is still planning.
    const evsAfterC = readEvents().filter((e) => e.topic === "epic.unblocked");
    expect(evsAfterC).toHaveLength(1);
    expect(evsAfterC[0]?.payload.epicId).toBe(b);
    expect(evsAfterC[0]?.payload.byEpicId).toBe(c);

    // ---------- 7. `epic ready B` → epic.ready for B.
    await setEpicReady(atmuxDir, b, true);
    const readyEvents = readEvents().filter((e) => e.topic === "epic.ready");
    expect(readyEvents.length).toBe(2);
    expect(readyEvents.map((e) => e.payload.epicId as string).sort()).toEqual([a, b].sort());

    // ---------- 8. Advance B to done — A's last unmet dep clears.
    //              epic.unblocked fires for A with byEpicId=B.
    await advanceEpic(atmuxDir, b, "ready");
    await advanceEpic(atmuxDir, b, "in-progress");
    await advanceEpic(atmuxDir, b, "review");
    await advanceEpic(atmuxDir, b, "done");
    const evsAfterB = readEvents().filter((e) => e.topic === "epic.unblocked");
    expect(evsAfterB.length).toBe(2);
    const aUnblocked = evsAfterB.find((e) => e.payload.epicId === a);
    expect(aUnblocked).toBeDefined();
    expect(aUnblocked?.payload.byEpicId).toBe(b);

    // ---------- 9. `spawn-epic A` now succeeds (eligible: is_ready=1 +
    //              all direct deps done).
    const rc = await spawnEpic(
      ["a-spawn", "--from", "parent-team", "--parent-epic-kanban-id", a],
      makeSpawnOpts(homeDir),
    );
    expect(rc).toBe(0);
    // Verify the spawn produced a child team.json.
    const childTeamRaw = await readFile(
      join(scratch, "parent-team-epics", "a-spawn", ".atmux", "team.json"),
      "utf8",
    );
    expect(JSON.parse(childTeamRaw).name).toBe("a-spawn");
  });

  test("`--force` on ineligible epic spawns + writes override log line with blockers", async () => {
    // Create an epic that's NOT ready + has no deps. Eligibility predicate
    // refuses on is_ready=0; --force overrides + logs.
    const e = await addEpic(atmuxDir, { title: "draft" });
    expect((await showEpic(atmuxDir, e))?.isReady).toBe(false);

    const homeDir = join(scratch, "home2");
    await mkdir(homeDir, { recursive: true });

    const rc = await spawnEpic(
      [
        "forced-spawn",
        "--from",
        "parent-team",
        "--parent-epic-kanban-id",
        e,
        "--force",
      ],
      makeSpawnOpts(homeDir),
    );
    expect(rc).toBe(0);

    // Override log line landed.
    const logPath = join(homeDir, ".atmux", "state", "spawn-overrides.log");
    const raw = await readFile(logPath, "utf8");
    const lines = raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    const line = lines[0] as {
      epicId: string;
      team: string;
      blockers: string[];
      callerMember: string;
      callerScope: string;
    };
    expect(line.epicId).toBe(e);
    expect(line.team).toBe("parent-team");
    expect(line.blockers).toContain("is_ready=0");
    expect(line.callerMember).toBe("be-1");
    expect(line.callerScope).toBe("driver");
  });
});

describe("ADR-225 validation matrix smoke", () => {
  test("`atmux epic add --depends-on e-NONEXISTENT` refused with typo-protection message", async () => {
    await expect(
      epic(["add", "--team-dir", teamDir, "X", "--depends-on", "e-nonexistent"]),
    ).rejects.toThrow(/does not exist/);
  });

  test("self-dep refused via `atmux epic set-depends-on`", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    await expect(epic(["set-depends-on", a, a, "--team-dir", teamDir])).rejects.toThrow(
      /cannot depend on itself/,
    );
  });

  test("2-cycle refused via `atmux epic set-depends-on`", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    const b = await addEpic(atmuxDir, { title: "B", dependsOn: [a] });
    // Closing the loop A→B via set-depends-on creates a 2-cycle.
    await expect(epic(["set-depends-on", a, b, "--team-dir", teamDir])).rejects.toThrow(/cycle/);
  });
});
