// Unit tests for src/core/lead-stall-watchdog.ts (ADR-247 §D2/D3/D4/D5).
//
// Real-behavior coverage — if the feature were broken these fail:
//   - decideLeadStall W1 (ready-story-no-claimant) fires at/above the
//     threshold, NOT below; not on already-claimed; not on empty kanban.
//   - decideLeadStall W2 (unclaimed task / todo+lane+no-owner) same
//     threshold-boundary behavior; not on owned rows.
//   - Rate-limit: a second evaluation within rateLimitPerCageMin does
//     NOT fire (proves at-least-once re-delivery emits no second ping);
//     fires again after the window.
//   - Ping format contains the REAL ids + the real runnable dispatch
//     verb (`atmux dispatch <member> <id>`), and a no-member flag when
//     the lane has no roster member (NO fabricated targets).
//   - Rate-limit state R/W round-trip (readLastPingSec / recordPing).
//   - Consumer handler: pings on fire, persists the ping epoch, and a
//     SECOND handler invocation within the window emits no second ping.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as nodeChildProcess from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KanbanStory, KanbanTask } from "../../../src/schema/kanban.ts";
import {
  buildLaneTargetMap,
  createLeadStallWatchdogHandler,
  decideLeadStall,
  type DecideLeadStallInput,
  formatLeadStallPing,
  type LeadStallStoryInput,
  type LeadStallTaskInput,
  type LeadStallWatchdogOutcome,
  leadStallStatePath,
  readLastPingSec,
  recordPing,
  storyToInput,
  taskToInput,
} from "../../../src/core/lead-stall-watchdog.ts";

const NOW = 1_780_000_000;
const THRESHOLD_MIN = 5;
const THRESHOLD_SEC = THRESHOLD_MIN * 60;
const RATE_MIN = 5;
const RATE_SEC = RATE_MIN * 60;

const MEMBERS = [
  { name: "lead", lane: null },
  { name: "be-1", lane: "be" },
  { name: "be-2", lane: "be" },
  { name: "fe-1", lane: "fe" },
];

function readyStory(id: string, idleSec: number, owner?: string | null): LeadStallStoryInput {
  return {
    id,
    status: "ready",
    owner: owner ?? null,
    lane: "be",
    title: `story ${id}`,
    readySinceSec: NOW - idleSec,
  };
}

function unclaimedTask(id: string, idleSec: number, owner?: string | null): LeadStallTaskInput {
  return {
    id,
    status: "unclaimed",
    owner: owner ?? null,
    lane: "fe",
    subject: `task ${id}`,
    createdAt: NOW - idleSec,
  };
}

function input(overrides: Partial<DecideLeadStallInput> = {}): DecideLeadStallInput {
  return {
    stories: [],
    tasks: [],
    members: MEMBERS,
    nowSec: NOW,
    idleThresholdMin: THRESHOLD_MIN,
    rateLimitPerCageMin: RATE_MIN,
    lastPingSec: null,
    ...overrides,
  };
}

// ---------- buildLaneTargetMap ----------

describe("buildLaneTargetMap", () => {
  test("resolves lane → lowest-indexed member; skips laneless members", () => {
    const m = buildLaneTargetMap(MEMBERS);
    expect(m.get("be")).toBe("be-1"); // be-1 sorts before be-2
    expect(m.get("fe")).toBe("fe-1");
    expect(m.has("misc")).toBe(false); // no roster member on misc
    expect([...m.keys()]).not.toContain(""); // lead (laneless) skipped
  });
});

// ---------- decideLeadStall: W1 ----------

describe("decideLeadStall — W1 (ready story, no claimant)", () => {
  test("does NOT fire on empty kanban", () => {
    const d = decideLeadStall(input());
    expect(d.fire).toBe(false);
    expect(d.items).toHaveLength(0);
    expect(d.conditions).toEqual([]);
  });

  test("does NOT fire below the threshold", () => {
    const d = decideLeadStall(input({ stories: [readyStory("s-1", THRESHOLD_SEC - 1)] }));
    expect(d.fire).toBe(false);
    expect(d.items).toHaveLength(0);
    expect(d.reason).toContain("no actionable work");
  });

  test("FIRES exactly at the threshold boundary", () => {
    const d = decideLeadStall(input({ stories: [readyStory("s-1", THRESHOLD_SEC)] }));
    expect(d.fire).toBe(true);
    expect(d.conditions).toEqual(["W1"]);
    expect(d.items).toHaveLength(1);
    expect(d.items[0]!.id).toBe("s-1");
    expect(d.items[0]!.kind).toBe("story");
    expect(d.items[0]!.targetMember).toBe("be-1");
  });

  test("FIRES above the threshold", () => {
    const d = decideLeadStall(input({ stories: [readyStory("s-1", THRESHOLD_SEC + 600)] }));
    expect(d.fire).toBe(true);
    expect(d.items[0]!.idleForSec).toBe(THRESHOLD_SEC + 600);
  });

  test("does NOT fire on an already-claimed ready story (owner set)", () => {
    const d = decideLeadStall(input({ stories: [readyStory("s-1", THRESHOLD_SEC + 100, "be-1")] }));
    expect(d.fire).toBe(false);
    expect(d.items).toHaveLength(0);
  });

  test("does NOT fire on a non-ready story even when aged", () => {
    const planning: LeadStallStoryInput = {
      ...readyStory("s-1", THRESHOLD_SEC + 100),
      status: "planning",
    };
    const d = decideLeadStall(input({ stories: [planning] }));
    expect(d.fire).toBe(false);
  });
});

// ---------- decideLeadStall: W2 ----------

describe("decideLeadStall — W2 (unclaimed task)", () => {
  test("does NOT fire below the threshold", () => {
    const d = decideLeadStall(input({ tasks: [unclaimedTask("t-1", THRESHOLD_SEC - 1)] }));
    expect(d.fire).toBe(false);
  });

  test("FIRES at the threshold boundary with a real dispatch target", () => {
    const d = decideLeadStall(input({ tasks: [unclaimedTask("t-1", THRESHOLD_SEC)] }));
    expect(d.fire).toBe(true);
    expect(d.conditions).toEqual(["W2"]);
    expect(d.items[0]!.id).toBe("t-1");
    expect(d.items[0]!.targetMember).toBe("fe-1");
  });

  test("fires on a todo task with a concrete lane and no owner (W2 second branch)", () => {
    const todo: LeadStallTaskInput = {
      id: "t-todo",
      status: "todo",
      owner: null,
      lane: "be",
      subject: "concrete todo",
      createdAt: NOW - THRESHOLD_SEC - 10,
    };
    const d = decideLeadStall(input({ tasks: [todo] }));
    expect(d.fire).toBe(true);
    expect(d.items[0]!.targetMember).toBe("be-1");
  });

  test("does NOT fire on an owned unclaimed task (contradictory row, never re-dispatch)", () => {
    const d = decideLeadStall(
      input({ tasks: [unclaimedTask("t-1", THRESHOLD_SEC + 100, "fe-1")] }),
    );
    expect(d.fire).toBe(false);
  });

  test("does NOT fire on a laneless todo (not a W2 candidate)", () => {
    const todo: LeadStallTaskInput = {
      id: "t-nolane",
      status: "todo",
      owner: null,
      lane: null,
      subject: "no lane",
      createdAt: NOW - THRESHOLD_SEC - 10,
    };
    const d = decideLeadStall(input({ tasks: [todo] }));
    expect(d.fire).toBe(false);
  });
});

describe("decideLeadStall — W1 + W2 combined", () => {
  test("reports both conditions when a story and a task both fire", () => {
    const d = decideLeadStall(
      input({
        stories: [readyStory("s-1", THRESHOLD_SEC + 1)],
        tasks: [unclaimedTask("t-1", THRESHOLD_SEC + 1)],
      }),
    );
    expect(d.fire).toBe(true);
    expect(d.conditions).toEqual(["W1", "W2"]);
    expect(d.items.map((i) => i.id).sort()).toEqual(["s-1", "t-1"]);
  });
});

// ---------- decideLeadStall: rate-limit (§D5) ----------

describe("decideLeadStall — rate-limit (§D5)", () => {
  test("SUPPRESSES a fire within the rate-limit window (re-delivery emits no second ping)", () => {
    const d = decideLeadStall(
      input({
        stories: [readyStory("s-1", THRESHOLD_SEC + 100)],
        lastPingSec: NOW - (RATE_SEC - 1), // pinged less than a window ago
      }),
    );
    expect(d.fire).toBe(false);
    expect(d.reason).toContain("rate-limited");
    // items still surfaced for inspection, but the gate (fire) is false.
    expect(d.items).toHaveLength(1);
  });

  test("ALLOWS a fire once the rate-limit window has elapsed", () => {
    const d = decideLeadStall(
      input({
        stories: [readyStory("s-1", THRESHOLD_SEC + 100)],
        lastPingSec: NOW - RATE_SEC, // exactly the window → allowed
      }),
    );
    expect(d.fire).toBe(true);
  });

  test("first-run (lastPingSec=null) is never rate-limited", () => {
    const d = decideLeadStall(
      input({ stories: [readyStory("s-1", THRESHOLD_SEC + 100)], lastPingSec: null }),
    );
    expect(d.fire).toBe(true);
  });
});

// ---------- formatLeadStallPing (§D4) ----------

describe("formatLeadStallPing — concrete dispatch (§D4)", () => {
  test("contains the 🔔 marker, real ids, and the real runnable dispatch verb", () => {
    const d = decideLeadStall(
      input({
        stories: [readyStory("s-1", THRESHOLD_SEC + 100)],
        tasks: [unclaimedTask("t-9", THRESHOLD_SEC + 100)],
      }),
    );
    const ping = formatLeadStallPing(d.items);
    expect(ping).toContain("🔔 [lead-stall-watchdog]");
    expect(ping).toContain("Ready stories (W1):");
    expect(ping).toContain("Unclaimed tasks (W2):");
    // Real ids + real verb (member-first, per the shipped dispatch verb
    // signature — NOT the ADR's illustrative `--to` form).
    expect(ping).toContain("s-1");
    expect(ping).toContain("atmux dispatch be-1 s-1");
    expect(ping).toContain("t-9");
    expect(ping).toContain("atmux dispatch fe-1 t-9");
    expect(ping).toContain("[lane=be]");
    expect(ping).toContain("[lane=fe]");
  });

  test("flags a no-member lane instead of fabricating a dispatch target", () => {
    // misc lane has no roster member in MEMBERS → targetMember null.
    const story: LeadStallStoryInput = {
      ...readyStory("s-misc", THRESHOLD_SEC + 100),
      lane: "misc",
    };
    const d = decideLeadStall(input({ stories: [story] }));
    expect(d.items[0]!.targetMember).toBeNull();
    const ping = formatLeadStallPing(d.items);
    expect(ping).toContain("no misc member; assign one then dispatch");
    expect(ping).not.toContain("atmux dispatch null");
  });
});

// ---------- rate-limit state R/W ----------

describe("rate-limit state file R/W", () => {
  let atmuxDir: string;
  beforeEach(async () => {
    atmuxDir = await mkdtemp(join(tmpdir(), "atmux-lead-stall-"));
  });
  afterEach(async () => {
    await rm(atmuxDir, { recursive: true, force: true });
  });

  test("returns null on a missing state file (first run)", async () => {
    expect(await readLastPingSec(atmuxDir)).toBeNull();
  });

  test("round-trips the last-ping epoch", async () => {
    await recordPing(atmuxDir, NOW);
    expect(await readLastPingSec(atmuxDir)).toBe(NOW);
    expect(leadStallStatePath(atmuxDir)).toContain("/state/lead-stall-watchdog.json");
  });

  test("returns null on a malformed state file (re-arm fresh)", async () => {
    const { atomicWrite, ensureDir } = await import("../../../src/abstractions/fs.ts");
    await ensureDir(join(atmuxDir, "state"));
    await atomicWrite(leadStallStatePath(atmuxDir), "{not json");
    expect(await readLastPingSec(atmuxDir)).toBeNull();
  });
});

// ---------- snapshot adapters ----------

describe("storyToInput / taskToInput", () => {
  test("storyToInput pulls lane/owner from passthrough extra, prefers advancedAt", () => {
    const story = {
      id: "s-x",
      status: "ready",
      title: "t",
      advancedAt: 100,
      createdAt: 50,
      lane: "be",
      owner: "be-1",
    } as unknown as KanbanStory;
    const inp = storyToInput(story);
    expect(inp.readySinceSec).toBe(100);
    expect(inp.lane).toBe("be");
    expect(inp.owner).toBe("be-1");
  });

  test("storyToInput falls back to createdAt when advancedAt absent, null owner when unset", () => {
    const story = { id: "s-y", status: "ready", createdAt: 42 } as unknown as KanbanStory;
    const inp = storyToInput(story);
    expect(inp.readySinceSec).toBe(42);
    expect(inp.owner).toBeNull();
    expect(inp.lane).toBeNull();
  });

  test("taskToInput maps the kanban task fields", () => {
    const task = {
      id: "t-z",
      status: "unclaimed",
      owner: null,
      lane: "fe",
      subject: "subj",
      createdAt: 77,
    } as unknown as KanbanTask;
    const inp = taskToInput(task);
    expect(inp).toEqual({
      id: "t-z",
      status: "unclaimed",
      owner: null,
      lane: "fe",
      subject: "subj",
      createdAt: 77,
    });
  });
});

// ---------- consumer handler ----------

describe("createLeadStallWatchdogHandler — consumer wiring", () => {
  let atmuxDir: string;
  beforeEach(async () => {
    atmuxDir = await mkdtemp(join(tmpdir(), "atmux-lead-stall-h-"));
  });
  afterEach(async () => {
    await rm(atmuxDir, { recursive: true, force: true });
  });

  function makeHandler(opts: {
    stories: ReadonlyArray<KanbanStory>;
    tasks: ReadonlyArray<KanbanTask>;
    captured: string[][];
    now: () => number;
    enabled?: boolean;
  }) {
    return createLeadStallWatchdogHandler({
      atmuxDir,
      team: {
        name: "atmux",
        members: MEMBERS as never,
        ...(opts.enabled !== undefined ? { leadStallWatchdog: { enabled: opts.enabled } } : {}),
      },
      loadSnapshot: async () => ({ stories: opts.stories, tasks: opts.tasks }),
      spawnTellLead: async (args) => {
        opts.captured.push([...args]);
        return 0;
      },
      nowSec: opts.now,
    });
  }

  test("pings the lead with real ids + persists the ping epoch on fire", async () => {
    const captured: string[][] = [];
    const story = {
      id: "s-real",
      status: "ready",
      title: "Build rewards",
      advancedAt: NOW - THRESHOLD_SEC - 100,
      lane: "be",
    } as unknown as KanbanStory;
    const handler = makeHandler({ stories: [story], tasks: [], captured, now: () => NOW });

    const outcome = await handler({ topic: "story.ready", team: "atmux" });
    expect(outcome).toBe("pinged" satisfies LeadStallWatchdogOutcome);
    expect(captured).toHaveLength(1);
    const args = captured[0]!;
    expect(args[0]).toBe("tell-lead");
    expect(args[1]).toBe("--team");
    expect(args[2]).toBe("atmux");
    const msg = args[3]!;
    expect(msg).toContain("s-real");
    expect(msg).toContain("atmux dispatch be-1 s-real");
    expect(msg).toContain("Build rewards");
    // ping epoch persisted
    expect(await readLastPingSec(atmuxDir)).toBe(NOW);
  });

  test("SECOND delivery within the rate-limit window emits no second ping", async () => {
    const captured: string[][] = [];
    const story = {
      id: "s-real",
      status: "ready",
      advancedAt: NOW - THRESHOLD_SEC - 100,
      lane: "be",
    } as unknown as KanbanStory;

    // First delivery → pings.
    const h1 = makeHandler({ stories: [story], tasks: [], captured, now: () => NOW });
    expect(await h1({ topic: "story.ready", team: "atmux" })).toBe("pinged");
    expect(captured).toHaveLength(1);

    // Re-delivery 60s later (still inside the 5-min window) → suppressed.
    const h2 = makeHandler({ stories: [story], tasks: [], captured, now: () => NOW + 60 });
    expect(await h2({ topic: "story.ready", team: "atmux" })).toBe("skip-rate-limited");
    expect(captured).toHaveLength(1); // NO second ping
  });

  test("fires again once the rate-limit window has elapsed", async () => {
    const captured: string[][] = [];
    const story = {
      id: "s-real",
      status: "ready",
      advancedAt: NOW - THRESHOLD_SEC - 100,
      lane: "be",
    } as unknown as KanbanStory;

    const h1 = makeHandler({ stories: [story], tasks: [], captured, now: () => NOW });
    expect(await h1({ topic: "story.ready", team: "atmux" })).toBe("pinged");

    // RATE_SEC later → window elapsed → pings again.
    const h2 = makeHandler({ stories: [story], tasks: [], captured, now: () => NOW + RATE_SEC });
    expect(await h2({ topic: "story.ready", team: "atmux" })).toBe("pinged");
    expect(captured).toHaveLength(2);
  });

  test("skips silently with no actionable work (below threshold)", async () => {
    const captured: string[][] = [];
    const story = {
      id: "s-fresh",
      status: "ready",
      advancedAt: NOW - 10, // way below threshold
      lane: "be",
    } as unknown as KanbanStory;
    const handler = makeHandler({ stories: [story], tasks: [], captured, now: () => NOW });
    expect(await handler({ topic: "story.ready", team: "atmux" })).toBe("skip-no-actionable-work");
    expect(captured).toHaveLength(0);
    expect(await readLastPingSec(atmuxDir)).toBeNull();
  });

  test("surfaces tell-lead-failed when the spawn returns non-zero (still arms rate-limit)", async () => {
    const story = {
      id: "s-real",
      status: "ready",
      advancedAt: NOW - THRESHOLD_SEC - 100,
      lane: "be",
    } as unknown as KanbanStory;
    const handler = createLeadStallWatchdogHandler({
      atmuxDir,
      team: { name: "atmux", members: MEMBERS as never },
      loadSnapshot: async () => ({ stories: [story], tasks: [] }),
      spawnTellLead: async () => 1, // non-zero exit
      nowSec: () => NOW,
    });
    expect(await handler({ topic: "story.ready", team: "atmux" })).toBe(
      "tell-lead-failed" satisfies LeadStallWatchdogOutcome,
    );
    // Ping epoch persisted before the send (fail toward fewer pings).
    expect(await readLastPingSec(atmuxDir)).toBe(NOW);
  });

  test("honors the in-handler enabled=false off-switch", async () => {
    const captured: string[][] = [];
    const story = {
      id: "s-real",
      status: "ready",
      advancedAt: NOW - THRESHOLD_SEC - 100,
      lane: "be",
    } as unknown as KanbanStory;
    const handler = makeHandler({
      stories: [story],
      tasks: [],
      captured,
      now: () => NOW,
      enabled: false,
    });
    expect(await handler({ topic: "story.ready", team: "atmux" })).toBe("skip-disabled");
    expect(captured).toHaveLength(0);
  });
});

describe("createLeadStallWatchdogHandler — default seams", () => {
  test.serial(
    "uses the default spawnTellLead path when omitted and handles exit/error callbacks",
    async () => {
      const childProcessSnapshot = { ...nodeChildProcess };
      const calls: Array<{
        command: string;
        args: Array<string>;
        stdio?: string;
        env?: NodeJS.ProcessEnv;
      }> = [];
      let installed = false;

      const makeStory = (id: string): KanbanStory =>
        ({
          id,
          status: "ready",
          title: `story ${id}`,
          advancedAt: NOW - THRESHOLD_SEC - 100,
          lane: "be",
        }) as unknown as KanbanStory;

      const mkHandler = async (atmuxDir: string, story: KanbanStory) =>
        createLeadStallWatchdogHandler({
          atmuxDir,
          team: { name: "atmux", members: MEMBERS as never },
          loadSnapshot: async () => ({ stories: [story], tasks: [] }),
        });

      const mkDir = async (prefix: string): Promise<string> => mkdtemp(join(tmpdir(), prefix));

      try {
        mock.module("node:child_process", () => ({
          ...childProcessSnapshot,
          spawn: mock(
            (
              command: string,
              args: ReadonlyArray<string>,
              options: { stdio?: string; env?: NodeJS.ProcessEnv },
            ) => {
              const callIndex = calls.length + 1;
              calls.push({
                command,
                args: [...args],
                ...(options.stdio === undefined ? {} : { stdio: options.stdio }),
                ...(options.env === undefined ? {} : { env: options.env }),
              });
              const child = {
                on(event: "error" | "exit", handler: (code?: number | Error) => void) {
                  if (callIndex === 1 && event === "exit") {
                    queueMicrotask(() => handler(0));
                  } else if (callIndex === 2 && event === "error") {
                    queueMicrotask(() => handler(new Error("spawn failed")));
                  }
                  return child;
                },
              };
              return child;
            },
          ),
        }));
        installed = true;

        const okDir = await mkDir("atmux-lead-stall-default-spawn-ok-");
        const failDir = await mkDir("atmux-lead-stall-default-spawn-fail-");
        try {
          const okHandler = await mkHandler(okDir, makeStory("s-ok"));
          expect(await okHandler({ topic: "story.ready", team: "atmux" })).toBe("pinged");

          const failHandler = await mkHandler(failDir, makeStory("s-fail"));
          expect(await failHandler({ topic: "story.ready", team: "atmux" })).toBe(
            "tell-lead-failed",
          );

          expect(calls).toHaveLength(2);
          expect(calls[0]!.command).toBe("atmux");
          expect(calls[0]!.args.slice(0, 3)).toEqual(["tell-lead", "--team", "atmux"]);
          expect(calls[0]!.args[3]).toContain("s-ok");
          expect(calls[0]!.stdio).toBe("inherit");
          expect(calls[0]!.env).toBe(process.env);

          expect(calls[1]!.command).toBe("atmux");
          expect(calls[1]!.args.slice(0, 3)).toEqual(["tell-lead", "--team", "atmux"]);
          expect(calls[1]!.args[3]).toContain("s-fail");
          expect(calls[1]!.stdio).toBe("inherit");
          expect(calls[1]!.env).toBe(process.env);
        } finally {
          await rm(okDir, { recursive: true, force: true });
          await rm(failDir, { recursive: true, force: true });
        }
      } finally {
        if (installed) {
          mock.module("node:child_process", () => ({
            ...childProcessSnapshot,
          }));
          mock.restore();
        }
      }
    },
  );

  test.serial("uses the default Date.now() clock when nowSec is omitted", async () => {
    const atmuxDir = await mkdtemp(join(tmpdir(), "atmux-lead-stall-default-clock-"));
    const realDateNow = Date.now;
    const fakeNowMs = 1_780_000_123_456;
    const expectedNowSec = Math.floor(fakeNowMs / 1000);
    const story = {
      id: "s-clock",
      status: "ready",
      advancedAt: expectedNowSec - THRESHOLD_SEC - 100,
      lane: "be",
    } as unknown as KanbanStory;

    try {
      Date.now = () => fakeNowMs;
      const handler = createLeadStallWatchdogHandler({
        atmuxDir,
        team: { name: "atmux", members: MEMBERS as never },
        loadSnapshot: async () => ({ stories: [story], tasks: [] }),
        spawnTellLead: async () => 0,
      });

      expect(await handler({ topic: "story.ready", team: "atmux" })).toBe("pinged");
      expect(await readLastPingSec(atmuxDir)).toBe(expectedNowSec);
    } finally {
      Date.now = realDateNow;
      await rm(atmuxDir, { recursive: true, force: true });
    }
  });
});
