// Unit tests for src/verbs/epic-merge.ts `advance` sub-verb (ADR-144
// §Operator bypass T2 / t-49bd4fe1).
//
// Strategy:
//   - parser tests run pure on parseEpicMergeArgs (no fixtures)
//   - advance-verb tests fixture a tmp team.json with epicTeam block
//     + a real SQLite state.db, then call epicMergeAdvanceVerb with
//     `callerScope` + `homeDir` + `now` injected.
//
// Decision tree:
//   (A) parser — sub-verb dispatch, --to validation, --skip-test-gate
//       requires --reason, unknown flag refuses
//   (B) advance — driver-only gate refuses --skip-test-gate for member
//   (C) advance — illegal transition refused
//   (D) advance — tested → merging without pass outcome refused
//   (E) advance — tested → merging with pass outcome succeeds, no log
//   (F) advance — tested → merging with --skip-test-gate writes bypass +
//       appends to ~/.atmux/state/test-gate-bypasses.log
//   (G) advance — test_failed → in_progress clears prior outcome

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import { openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { MergerStateRepo } from "../../../src/core/repositories/merger-state-repo.ts";
import { UsageError } from "../../../src/errors.ts";
import { epicMergeAdvanceVerb, parseEpicMergeArgs } from "../../../src/verbs/epic-merge.ts";

let teamDir: string;
let atmuxDir: string;
let scratchHome: string;

function ok(stdout = ""): SpawnResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    argv: [],
    cmd: "git",
    signalled: null,
    durationMs: 0,
  };
}

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-epic-advance-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({
      name: "test-epic",
      members: [{ name: "lead", role: "lead" }],
      epicTeam: {
        parent: "atmux",
        parentEpicKanbanId: "e-aabb0001",
        parentBase: "geoyws",
        mergeMode: "auto",
      },
    }),
  );
  scratchHome = await mkdtemp(join(tmpdir(), "atmux-epic-advance-home-"));
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
  await rm(scratchHome, { recursive: true, force: true });
});

// Pre-seed merger_state with a given state + optional test_outcome.
function seedRow(state: string, opts: { testOutcome?: "pass" | "fail" | "bypass" } = {}): void {
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  const repo = new MergerStateRepo(db);
  const tx: Parameters<MergerStateRepo["transition"]>[0] = {
    memberBranch: "geoyws-epic-aabb0001",
    next: state as Parameters<MergerStateRepo["transition"]>[0]["next"],
    note: "seed",
    by: "test",
    transitionedAt: 1000,
  };
  if (opts.testOutcome !== undefined) tx.testOutcome = opts.testOutcome;
  repo.transition(tx);
  db.close();
}

function readRow(): {
  state: string;
  testOutcome: string | null;
  note: string | null;
} {
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  const repo = new MergerStateRepo(db);
  const row = repo.getState("geoyws-epic-aabb0001");
  db.close();
  if (row === null) throw new Error("row missing");
  return { state: row.state, testOutcome: row.testOutcome, note: row.note };
}

// stub `git` that returns the epic branch name on rev-parse --abbrev-ref HEAD.
const gitStub = async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
  if (argv.includes("rev-parse") && argv.includes("--abbrev-ref")) {
    return ok("geoyws-epic-aabb0001\n");
  }
  return ok("");
};

// ---------- parser tests ----------

describe("parseEpicMergeArgs — sub-verb dispatch", () => {
  test("tick — bare", () => {
    expect(parseEpicMergeArgs(["tick"]).subverb).toBe("tick");
  });

  test("advance — requires --to", () => {
    expect(() => parseEpicMergeArgs(["advance"])).toThrow(UsageError);
  });

  test("advance --to merging", () => {
    const p = parseEpicMergeArgs(["advance", "--to", "merging"]);
    expect(p.subverb).toBe("advance");
    expect(p.to).toBe("merging");
    expect(p.skipTestGate).toBeUndefined();
  });

  test("advance --to in_progress", () => {
    const p = parseEpicMergeArgs(["advance", "--to", "in_progress"]);
    expect(p.to).toBe("in_progress");
  });

  test("advance --to <bad state> refuses", () => {
    expect(() => parseEpicMergeArgs(["advance", "--to", "frobulate"])).toThrow(UsageError);
  });

  test("advance --skip-test-gate without --reason refuses", () => {
    expect(() => parseEpicMergeArgs(["advance", "--to", "merging", "--skip-test-gate"])).toThrow(
      UsageError,
    );
  });

  test("advance --skip-test-gate --reason captures both", () => {
    const p = parseEpicMergeArgs([
      "advance",
      "--to",
      "merging",
      "--skip-test-gate",
      "--reason",
      "release-day emergency",
    ]);
    expect(p.skipTestGate).toBe(true);
    expect(p.reason).toBe("release-day emergency");
  });

  test("--team-dir threads through", () => {
    const p = parseEpicMergeArgs(["tick", "--team-dir", "/foo/bar"]);
    expect(p.teamDir).toBe("/foo/bar");
  });

  test("unknown flag refuses", () => {
    expect(() => parseEpicMergeArgs(["advance", "--unknown"])).toThrow(UsageError);
  });

  test("no sub-verb refuses", () => {
    expect(() => parseEpicMergeArgs([])).toThrow(UsageError);
  });
});

// ---------- driver-scope gate (ADR-033) ----------

describe("epicMergeAdvanceVerb — driver-scope gate", () => {
  test("--skip-test-gate refused for member scope", async () => {
    seedRow("tested", { testOutcome: "fail" });
    await expect(
      epicMergeAdvanceVerb(
        {
          subverb: "advance",
          to: "merging",
          skipTestGate: true,
          reason: "force",
          teamDir,
        },
        {
          git: gitStub,
          callerScope: () => "member",
          homeDir: scratchHome,
          logger: { log: () => {}, ok: () => {}, warn: () => {}, err: () => {} },
        },
      ),
    ).rejects.toThrow(/caller scope is not 'driver'/);
  });

  test("plain advance (no --skip-test-gate) permitted for member scope", async () => {
    // test_failed → in_progress is a recovery edge that doesn't bypass
    // any safety gate; member panes (planner-near, lead) should be able
    // to fire this without ATMUX_CALLER_SCOPE=driver.
    seedRow("test_failed", { testOutcome: "fail" });
    const rc = await epicMergeAdvanceVerb(
      {
        subverb: "advance",
        to: "in_progress",
        teamDir,
      },
      {
        git: gitStub,
        callerScope: () => "member",
        homeDir: scratchHome,
        logger: { log: () => {}, ok: () => {}, warn: () => {}, err: () => {} },
      },
    );
    expect(rc).toBe(0);
    expect(readRow().state).toBe("in_progress");
  });
});

// ---------- transition validation ----------

describe("epicMergeAdvanceVerb — transition validity", () => {
  test("illegal transition refused (open → merged)", async () => {
    seedRow("open");
    await expect(
      epicMergeAdvanceVerb(
        {
          subverb: "advance",
          to: "merged",
          teamDir,
        },
        {
          git: gitStub,
          callerScope: () => "driver",
          homeDir: scratchHome,
          logger: { log: () => {}, ok: () => {}, warn: () => {}, err: () => {} },
        },
      ),
    ).rejects.toThrow(/illegal transition/);
  });

  test("epic-team-less team refuses", async () => {
    // Strip the epicTeam block.
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({ name: "plain", members: [{ name: "lead", role: "lead" }] }),
    );
    await expect(
      epicMergeAdvanceVerb(
        {
          subverb: "advance",
          to: "in_progress",
          teamDir,
        },
        {
          git: gitStub,
          callerScope: () => "driver",
          homeDir: scratchHome,
          logger: { log: () => {}, ok: () => {}, warn: () => {}, err: () => {} },
        },
      ),
    ).rejects.toThrow(/no epicTeam block/);
  });
});

// ---------- test-gate refusal + bypass ----------

describe("epicMergeAdvanceVerb — ADR-144 §Decision test-gate", () => {
  test("tested → merging refused when outcome is FAIL", async () => {
    seedRow("tested", { testOutcome: "fail" });
    await expect(
      epicMergeAdvanceVerb(
        {
          subverb: "advance",
          to: "merging",
          teamDir,
        },
        {
          git: gitStub,
          callerScope: () => "driver",
          homeDir: scratchHome,
          logger: { log: () => {}, ok: () => {}, warn: () => {}, err: () => {} },
        },
      ),
    ).rejects.toThrow(/test_outcome on row is 'fail'/);
  });

  test("tested → merging refused when outcome is NULL (test never ran)", async () => {
    seedRow("tested");
    await expect(
      epicMergeAdvanceVerb(
        {
          subverb: "advance",
          to: "merging",
          teamDir,
        },
        {
          git: gitStub,
          callerScope: () => "driver",
          homeDir: scratchHome,
          logger: { log: () => {}, ok: () => {}, warn: () => {}, err: () => {} },
        },
      ),
    ).rejects.toThrow(/test_outcome on row is 'null'/);
  });

  test("tested → merging succeeds when outcome is PASS, preserves outcome", async () => {
    seedRow("tested", { testOutcome: "pass" });
    const rc = await epicMergeAdvanceVerb(
      {
        subverb: "advance",
        to: "merging",
        teamDir,
      },
      {
        git: gitStub,
        callerScope: () => "driver",
        homeDir: scratchHome,
        logger: { log: () => {}, ok: () => {}, warn: () => {}, err: () => {} },
      },
    );
    expect(rc).toBe(0);
    const row = readRow();
    expect(row.state).toBe("merging");
    expect(row.testOutcome).toBe("pass");
    // Bypass log should NOT have been written (no bypass fired).
    await expect(
      readFile(join(scratchHome, ".atmux/state/test-gate-bypasses.log"), "utf8"),
    ).rejects.toThrow();
  });

  test("--skip-test-gate writes bypass outcome + appends to log", async () => {
    seedRow("tested", { testOutcome: "fail" });
    // ADR-144 T5: inject a no-op Discord stub so this test does not
    // hit the real `ATMUX_DISCORD_WEBHOOK` set in the operator env.
    const discordCalls: unknown[] = [];
    const rc = await epicMergeAdvanceVerb(
      {
        subverb: "advance",
        to: "merging",
        skipTestGate: true,
        reason: "release-day emergency — flaky e2e known issue",
        teamDir,
      },
      {
        git: gitStub,
        callerScope: () => "driver",
        homeDir: scratchHome,
        now: () => 1779_999_000_000,
        user: "george",
        discordSend: async (o) => {
          discordCalls.push(o);
        },
        logger: { log: () => {}, ok: () => {}, warn: () => {}, err: () => {} },
      },
    );
    expect(rc).toBe(0);
    const row = readRow();
    expect(row.state).toBe("merging");
    expect(row.testOutcome).toBe("bypass");
    // Log file lands at ~/.atmux/state/test-gate-bypasses.log
    const logTxt = await readFile(join(scratchHome, ".atmux/state/test-gate-bypasses.log"), "utf8");
    const lines = logTxt.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}");
    expect(parsed.epicId).toBe("e-aabb0001");
    expect(parsed.epicBranch).toBe("geoyws-epic-aabb0001");
    expect(parsed.targetState).toBe("merging");
    expect(parsed.reason).toContain("release-day emergency");
    expect(parsed.by).toBe("george");
    // ADR-144 T5: Discord [test-gate-bypass] fires exactly once paired
    // with the JSONL log entry.
    expect(discordCalls).toHaveLength(1);
  });

  test("--skip-test-gate fires Discord [test-gate-bypass] with structured payload (ADR-144 T5)", async () => {
    seedRow("tested", { testOutcome: "fail" });
    const captured: Array<Record<string, unknown>> = [];
    const rc = await epicMergeAdvanceVerb(
      {
        subverb: "advance",
        to: "merging",
        skipTestGate: true,
        reason: "demo prep — known flake under retry, will fix after demo",
        teamDir,
      },
      {
        git: gitStub,
        callerScope: () => "driver",
        homeDir: scratchHome,
        now: () => 1779_999_000_000,
        user: "george",
        discordSend: async (o) => {
          captured.push(o as unknown as Record<string, unknown>);
        },
        logger: { log: () => {}, ok: () => {}, warn: () => {}, err: () => {} },
      },
    );
    expect(rc).toBe(0);
    expect(captured).toHaveLength(1);
    const payload = captured[0]!;
    expect(payload.template).toBe("test-gate-bypass");
    expect(payload.team).toBe("test-epic");
    expect(payload.category).toBe("⚠️");
    expect(String(payload.verdict)).toContain("e-aabb0001");
    expect(String(payload.verdict)).toContain("BYPASSED");
    expect(String(payload.verdict)).toContain("merging");
    const bullets = (payload.bullets as ReadonlyArray<string>) ?? [];
    expect(bullets.some((b) => b.startsWith("🆔") && b.includes("george"))).toBe(true);
    expect(bullets.some((b) => b.startsWith("🚩") && b.includes("demo prep"))).toBe(true);
  });

  test("non-bypass advance does NOT fire Discord (passive recovery)", async () => {
    seedRow("test_failed", { testOutcome: "fail" });
    const captured: Array<unknown> = [];
    await epicMergeAdvanceVerb(
      {
        subverb: "advance",
        to: "in_progress",
        reason: "fixed",
        teamDir,
      },
      {
        git: gitStub,
        callerScope: () => "driver",
        homeDir: scratchHome,
        discordSend: async (o) => {
          captured.push(o);
        },
        logger: { log: () => {}, ok: () => {}, warn: () => {}, err: () => {} },
      },
    );
    expect(captured).toHaveLength(0);
  });
});

// ---------- recovery transition ----------

describe("epicMergeAdvanceVerb — test_failed recovery", () => {
  test("test_failed → in_progress clears prior outcome", async () => {
    seedRow("test_failed", { testOutcome: "fail" });
    const rc = await epicMergeAdvanceVerb(
      {
        subverb: "advance",
        to: "in_progress",
        reason: "operator fixed flaky test",
        teamDir,
      },
      {
        git: gitStub,
        callerScope: () => "driver",
        homeDir: scratchHome,
        logger: { log: () => {}, ok: () => {}, warn: () => {}, err: () => {} },
      },
    );
    expect(rc).toBe(0);
    const row = readRow();
    expect(row.state).toBe("in_progress");
    // Outcome explicitly cleared so the next test cycle starts fresh.
    expect(row.testOutcome).toBeNull();
  });

  test("conflict → in_progress (operator manual recovery) succeeds", async () => {
    seedRow("conflict");
    const rc = await epicMergeAdvanceVerb(
      {
        subverb: "advance",
        to: "in_progress",
        reason: "merge conflict resolved",
        teamDir,
      },
      {
        git: gitStub,
        callerScope: () => "driver",
        homeDir: scratchHome,
        logger: { log: () => {}, ok: () => {}, warn: () => {}, err: () => {} },
      },
    );
    expect(rc).toBe(0);
    expect(readRow().state).toBe("in_progress");
  });
});
