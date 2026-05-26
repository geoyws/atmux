// Unit tests for src/verbs/team/list-workers.ts (ADR-221 §v2).
//
// Strategy: build an in-memory LoadedCockpit so the worker-team filter
// + --parent filter + rendering exercise observably. No real filesystem
// needed since we inject `pathExists` for the worktree presence flag.

import { describe, expect, test } from "bun:test";
import type { LoadedCockpit } from "../../../../src/core/cockpit.ts";
import {
  type ListWorkersOpts,
  listWorkers,
  parseListWorkersArgs,
} from "../../../../src/verbs/team/list-workers.ts";

// ---------- Arg parsing ----------

describe("parseListWorkersArgs", () => {
  test("defaults — no parent filter, table output", () => {
    const r = parseListWorkersArgs([]);
    expect(r.parent).toBeUndefined();
    expect(r.json).toBe(false);
  });

  test("--json + --parent both honored", () => {
    const r = parseListWorkersArgs(["--json", "--parent", "atmux"]);
    expect(r.json).toBe(true);
    expect(r.parent).toBe("atmux");
  });

  test("--parent without value refuses", () => {
    expect(() => parseListWorkersArgs(["--parent"])).toThrow(/--parent requires a value/);
  });

  test("unknown arg refuses", () => {
    expect(() => parseListWorkersArgs(["--bogus"])).toThrow(/unexpected arg/);
  });
});

// ---------- Filter behavior ----------

describe("listWorkers — worker-id prefix filter", () => {
  test("includes only epic-teams whose name starts with 'w-'", async () => {
    const captured = captureLogger();
    const opts: ListWorkersOpts = {
      loadCockpitFn: async () =>
        cockpit([
          { name: "w-abc", parent: "atmux" },
          { name: "e-deadbeef", parent: "atmux" },
          { name: "w-xyz", parent: "atmux" },
        ]),
      pathExists: async () => true,
      logger: captured.logger,
    };
    const rc = await listWorkers(["--json"], opts);
    expect(rc).toBe(0);
    const parsed = JSON.parse(captured.text());
    expect(parsed.workers.map((w: { workerId: string }) => w.workerId).sort()).toEqual([
      "w-abc",
      "w-xyz",
    ]);
  });

  test("--parent filter restricts the result set", async () => {
    const captured = captureLogger();
    const opts: ListWorkersOpts = {
      loadCockpitFn: async () =>
        cockpit([
          { name: "w-a", parent: "atmux" },
          { name: "w-b", parent: "sopx" },
        ]),
      pathExists: async () => true,
      logger: captured.logger,
    };
    const rc = await listWorkers(["--parent", "atmux", "--json"], opts);
    expect(rc).toBe(0);
    const parsed = JSON.parse(captured.text());
    expect(parsed.workers).toHaveLength(1);
    expect(parsed.workers[0].workerId).toBe("w-a");
  });

  test("worktreePresent reflects pathExists", async () => {
    const captured = captureLogger();
    const opts: ListWorkersOpts = {
      loadCockpitFn: async () => cockpit([{ name: "w-gone", parent: "atmux" }]),
      pathExists: async () => false,
      logger: captured.logger,
    };
    const rc = await listWorkers(["--json"], opts);
    expect(rc).toBe(0);
    const parsed = JSON.parse(captured.text());
    expect(parsed.workers[0].worktreePresent).toBe(false);
  });

  test("computes worktreeRoot from parentRoot + epicId", async () => {
    const captured = captureLogger();
    const opts: ListWorkersOpts = {
      loadCockpitFn: async () => cockpit([{ name: "w-abc", parent: "atmux" }]),
      pathExists: async () => true,
      logger: captured.logger,
    };
    await listWorkers(["--json"], opts);
    const parsed = JSON.parse(captured.text());
    expect(parsed.workers[0].worktreeRoot).toBe("/scratch/atmux-epics/w-abc");
  });
});

// ---------- Rendering ----------

describe("listWorkers — table rendering", () => {
  test("empty cockpit renders 'no worker-teams' line", async () => {
    const captured = captureLogger();
    const opts: ListWorkersOpts = {
      loadCockpitFn: async () => cockpit([]),
      pathExists: async () => true,
      logger: captured.logger,
    };
    const rc = await listWorkers([], opts);
    expect(rc).toBe(0);
    expect(captured.text()).toContain("no worker-teams in cockpit");
  });

  test("non-empty result renders a markdown-style table", async () => {
    const captured = captureLogger();
    const opts: ListWorkersOpts = {
      loadCockpitFn: async () =>
        cockpit([
          { name: "w-abc", parent: "atmux" },
          { name: "w-xyz", parent: "atmux" },
        ]),
      pathExists: async () => true,
      logger: captured.logger,
    };
    const rc = await listWorkers([], opts);
    expect(rc).toBe(0);
    const text = captured.text();
    expect(text).toContain("# list-workers — 2 worker-team(s)");
    expect(text).toContain("| worker-id | parent | worktree | present |");
    expect(text).toContain("| w-abc | atmux |");
    expect(text).toContain("| w-xyz | atmux |");
  });
});

// ---------- Helpers ----------

function cockpit(workers: ReadonlyArray<{ name: string; parent: string }>): LoadedCockpit {
  // Group by parent so each parent team carries its own children.
  const byParent = new Map<string, ReadonlyArray<{ name: string; parent: string }>>();
  for (const w of workers) {
    const list = byParent.get(w.parent) ?? [];
    byParent.set(w.parent, [...list, w]);
  }
  // Always have at least one parent so the sessions[] is well-formed
  // even when workers[] is empty.
  if (byParent.size === 0) byParent.set("atmux", []);
  return {
    schemaVersion: 1 as const,
    sessions: Array.from(byParent.entries()).map(([parent, children]) => ({
      type: "team" as const,
      name: parent,
      enabled: true,
      root: `/scratch/${parent}`,
      sessions: children.map((w) => ({
        type: "epic-team" as const,
        name: w.name,
        enabled: true,
        parent: w.parent,
        epicId: w.name,
        sessions: [],
      })),
    })),
    teams: [],
  } as unknown as LoadedCockpit;
}

function captureLogger(): {
  logger: { log: (m: string) => void };
  text: () => string;
} {
  const lines: string[] = [];
  return {
    logger: { log: (m) => lines.push(m) },
    text: () => lines.join("\n"),
  };
}
