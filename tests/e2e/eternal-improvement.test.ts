// E2E: ADR-052 §T8 — synthetic 1-cycle eternal-improvement walk.
//
// **Stateful 1x cold-start+walk e2e per CLAUDE.md TestingDiscipline.**
// Seeds an empty kanban + fresh state file, runs `atmux improve --budget
// <N>` to arm, fast-forwards by completing a synthetic improvement Task
// in the kanban, ticks to close the cycle, asserts state/budget/history
// transitions + Discord template firing. A second test() variant runs
// the budget-exhaustion fork (start→tick with low remaining → terminate
// → 🌱 done + active:false + onTerminate hook fires). A third
// test() exercises Mode B (`--idle-fallback`) so the `modeB:true` payload
// on the done ping is asserted.
//
// **NOT streak-runnable.** Each test() seeds + asserts a one-shot walk.
// Re-running drops the prior state file; do NOT loop. Seed dependency:
// kanban.json starts empty; the test mutates it (faking the planner's
// dispatch + member's done) before the close tick.
//
// Discord seam: injected `discordSend` captures rendered DiscordSendOpts
// into an array — no real webhook traffic. Token-spend seam: injected
// `tokensSpentForClose` returns a deterministic delta so budget math is
// reproducible. onTerminate seam: injected closure flips a boolean we
// can assert on the budget-exhaustion path. Clock seam: `nowMs` pinned
// to a fixed epoch so written timestamps are deterministic.
//
// What this proves end-to-end vs the verb-level unit tests:
//   - The full `improve --budget <N>` → `improve --tick` chain works
//     against ONE shared state file (verb unit tests seed mid-state).
//   - The directive-file write side-effect lands beside the kanban /
//     state-file mutations as expected (no missing `improve-directives.md`).
//   - Cycle close re-arms (cycle 2 opens) when budget has room left.
//   - Cycle close terminates when remaining goes negative AND the done
//     template fires + onTerminate hook fires + state.active flips false.
//
// Per CLAUDE.md "pair runbook beats with rehearsal spec steps" — when a
// future HANDOFF.md / RUNBOOK-improve.md documents the loop, beats
// should map 1:1 to the named test sections below.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { improve } from "../../src/verbs/improve.ts";

let teamDir: string;
let atmuxDir: string;
let statePath: string;
let kanbanPath: string;
let directivePath: string;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-improve-e2e-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  // Synthetic team — lead role required for the directive routing.
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({
      name: "ei-e2e",
      members: [
        { name: "lead", role: "team-lead" },
        { name: "alpha", role: "member" },
      ],
    }),
  );
  // Seed an empty legacy kanban.json — the improve verb reads via
  // loadKanban which accepts the JSON path when state.db is absent.
  await writeFile(
    join(atmuxDir, "kanban.json"),
    JSON.stringify({ tasks: [], epics: [], stories: [] }),
  );
  statePath = join(atmuxDir, "state", "eternal-improvement.json");
  kanbanPath = join(atmuxDir, "kanban.json");
  directivePath = join(atmuxDir, "improve-directives.md");
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
});

/** Fast-forward a synthetic improvement Task to `done` so the next
 *  tick sees it as closeable. Mirrors what a member's `atmux done`
 *  would have written via the kanban verbs. The epic id matches the
 *  ADR-052 cycle-scope (`e-a25968cc`) per ADR-052 §"Cycle scoping". */
async function fastForwardTaskDone(taskId: string, completedAt: number): Promise<void> {
  await writeFile(
    kanbanPath,
    JSON.stringify({
      tasks: [
        {
          id: taskId,
          subject: "synth: improvement Task for e2e walk",
          status: "done",
          owner: "alpha",
          deps: [],
          priority: 2,
          lane: null,
          createdAt: completedAt - 100,
          claimedAt: completedAt - 50,
          completedAt,
          epic: "e-a25968cc",
        },
      ],
      epics: [],
      stories: [],
    }),
  );
}

/** After the verb writes the state file, the seeded `tasksDispatched`
 *  list points at the new cycle's expected Task ID. Inject the same id
 *  into the kanban so the tick's closeability check matches. */
async function patchStateDispatched(taskId: string): Promise<void> {
  const raw = await readFile(statePath, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed.currentCycle !== null) {
    parsed.currentCycle.tasksLanded = [taskId];
    parsed.currentCycle.tasksDispatched = [taskId];
  }
  await writeFile(statePath, JSON.stringify(parsed));
}

describe("ADR-052 T8 — eternal-improvement 1x cold-start+walk e2e", () => {
  test("cycle 1 close → cycle 2 re-arm (budget has room)", async () => {
    // ----- Beat 1: cold start with explicit budget -----
    const sent: Array<Record<string, unknown>> = [];
    let armExit = -1;
    armExit = await improve(["--budget", "1000000", "--team-dir", teamDir], {
      discordSend: (async (opts: Record<string, unknown>) => {
        sent.push(opts);
      }) as never,
      nowMs: () => 1_800_000_000_000, // 2027-01-15 14:13:20 UTC
      runIdFactory: () => "ei-e2e-run-1",
    });
    expect(armExit).toBe(0);

    // ----- Beat 2: 🌱 start ping fired -----
    expect(sent).toHaveLength(1);
    expect(sent[0]?.template).toBe("eternal-improvement-start");

    // ----- Beat 3: state file shape post-arm -----
    const armed = JSON.parse(await readFile(statePath, "utf8"));
    expect(armed.active).toBe(true);
    expect(armed.runId).toBe("ei-e2e-run-1");
    expect(armed.mode).toBe("user-invoked");
    expect(armed.budgetTotal).toBe(1_000_000);
    expect(armed.budgetRemaining).toBe(1_000_000);
    expect(armed.cycleN).toBe(1);
    expect(armed.currentCycle).not.toBeNull();
    expect(armed.history).toEqual([]);

    // ----- Beat 4: synthetic fast-forward — Task done in kanban -----
    // The verb's --tick reads tasksDispatched from state, then for each
    // dispatched id looks up the kanban entry. We thread one synthetic
    // dispatched-then-done Task through both files.
    const taskId = "t-e2e0001";
    await patchStateDispatched(taskId);
    await fastForwardTaskDone(taskId, 1_800_000_500);

    // ----- Beat 5: tick close → cycle 2 re-arm + Discord pings -----
    sent.length = 0;
    const tickExit = await improve(["--tick", "--team-dir", teamDir], {
      discordSend: (async (opts: Record<string, unknown>) => {
        sent.push(opts);
      }) as never,
      tokensSpentForClose: async () => 5_000,
      nowMs: () => 1_800_001_000_000,
    });
    expect(tickExit).toBe(0);

    // ----- Beat 6: state shows cycle close + cycle 2 open + history -----
    const post = JSON.parse(await readFile(statePath, "utf8"));
    expect(post.active).toBe(true);
    expect(post.cycleN).toBe(2);
    expect(post.currentCycle).not.toBeNull();
    expect(post.history).toHaveLength(1);
    expect(post.history[0].cycleN).toBe(1);
    expect(post.history[0].tasksDone).toBe(1);
    expect(post.history[0].tokensSpent).toBe(5_000);
    expect(post.budgetRemaining).toBe(995_000);

    // ----- Beat 7: progress + start templates fired in order -----
    expect(sent).toHaveLength(2);
    expect(sent[0]?.template).toBe("eternal-improvement-progress");
    expect(sent[1]?.template).toBe("eternal-improvement-start");

    // ----- Beat 8: directive file got the cycle-2 re-arm entry -----
    const directives = await readFile(directivePath, "utf8");
    expect(directives).toContain("cycle 2 requested");
  });

  test("budget exhaustion at close → terminate (🌱 done + active:false + onTerminate)", async () => {
    // ----- Beat 1: cold start with LOW budget so the first tick exhausts -----
    const sent: Array<Record<string, unknown>> = [];
    let onTerminateFired = false;
    const armExit = await improve(["--budget", "5000", "--team-dir", teamDir], {
      discordSend: (async (opts: Record<string, unknown>) => {
        sent.push(opts);
      }) as never,
      nowMs: () => 1_800_000_000_000,
      runIdFactory: () => "ei-e2e-low-budget",
    });
    expect(armExit).toBe(0);
    expect(sent[0]?.template).toBe("eternal-improvement-start");

    // ----- Beat 2: fast-forward + tick with overage -----
    const taskId = "t-e2e0002";
    await patchStateDispatched(taskId);
    await fastForwardTaskDone(taskId, 1_800_000_500);
    sent.length = 0;
    const tickExit = await improve(["--tick", "--team-dir", teamDir], {
      discordSend: (async (opts: Record<string, unknown>) => {
        sent.push(opts);
      }) as never,
      tokensSpentForClose: async () => 10_000, // pushes remaining negative
      onTerminate: async () => {
        onTerminateFired = true;
      },
      nowMs: () => 1_800_001_000_000,
    });
    expect(tickExit).toBe(0);

    // ----- Beat 3: state flipped to terminated -----
    const post = JSON.parse(await readFile(statePath, "utf8"));
    expect(post.active).toBe(false);
    expect(post.budgetRemaining).toBeLessThan(0);
    expect(onTerminateFired).toBe(true);

    // ----- Beat 4: progress (close) + done (terminate) templates fired -----
    expect(sent).toHaveLength(2);
    expect(sent[0]?.template).toBe("eternal-improvement-progress");
    expect(sent[1]?.template).toBe("eternal-improvement-done");
  });

  test("Mode B (idle-fallback) — done ping carries modeB:true on termination", async () => {
    // ----- Beat 1: arm with --idle-fallback to set mode='idle-fallback' -----
    const sent: Array<Record<string, unknown>> = [];
    const armExit = await improve(
      ["--budget", "5000", "--idle-fallback", "--team-dir", teamDir],
      {
        discordSend: (async (opts: Record<string, unknown>) => {
          sent.push(opts);
        }) as never,
        nowMs: () => 1_800_000_000_000,
        runIdFactory: () => "ei-e2e-modeb",
      },
    );
    expect(armExit).toBe(0);
    const armed = JSON.parse(await readFile(statePath, "utf8"));
    expect(armed.mode).toBe("idle-fallback");

    // ----- Beat 2: fast-forward + tick with overage to exit through Mode B -----
    const taskId = "t-e2e0003";
    await patchStateDispatched(taskId);
    await fastForwardTaskDone(taskId, 1_800_000_500);
    sent.length = 0;
    const tickExit = await improve(["--tick", "--team-dir", teamDir], {
      discordSend: (async (opts: Record<string, unknown>) => {
        sent.push(opts);
      }) as never,
      tokensSpentForClose: async () => 10_000,
      nowMs: () => 1_800_001_000_000,
    });
    expect(tickExit).toBe(0);

    // ----- Beat 3: done ping carries modeB-specific bullet -----
    expect(sent).toHaveLength(2);
    const done = sent[1];
    expect(done?.template).toBe("eternal-improvement-done");
    // `renderEternalImprovementDone` appends a "🛑 (Mode B) ..." bullet
    // when `modeB:true` is threaded through (which the verb sets from
    // state.mode === 'idle-fallback'). Assert the bullet surfaces in
    // the rendered payload.
    const bullets = (done?.bullets as string[] | undefined) ?? [];
    expect(bullets.some((b) => b.includes("Mode B"))).toBe(true);
  });
});
