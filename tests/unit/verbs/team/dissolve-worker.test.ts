// Unit tests for src/verbs/team/dissolve-worker.ts (ADR-221 §v2).
//
// Strategy: arg parsing + worker-id gating runs pure. The dissolveEpic
// delegation is stubbed via the opts.dissolve seam — we only assert
// what was passed through, not that the full dissolve-epic pipeline
// works (that has its own test file).

import { describe, expect, test } from "bun:test";
import type { DissolveEpicOpts } from "../../../../src/verbs/team/dissolve-epic.ts";
import {
  type DissolveWorkerOpts,
  dissolveWorker,
  parseDissolveWorkerArgs,
} from "../../../../src/verbs/team/dissolve-worker.ts";

// ---------- Arg parsing ----------

describe("parseDissolveWorkerArgs", () => {
  test("minimal — worker-id only", () => {
    const r = parseDissolveWorkerArgs(["t-abc"]);
    expect(r.workerOrTaskId).toBe("t-abc");
    expect(r.skipChecks).toBe(false);
    expect(r.forcePrune).toBe(false);
  });

  test("--skip-checks + --force-prune both honored", () => {
    const r = parseDissolveWorkerArgs(["w-abc", "--skip-checks", "--force-prune"]);
    expect(r.skipChecks).toBe(true);
    expect(r.forcePrune).toBe(true);
  });

  test("missing arg refuses", () => {
    expect(() => parseDissolveWorkerArgs([])).toThrow(/required/);
  });

  test("unknown flag refuses", () => {
    expect(() => parseDissolveWorkerArgs(["t-x", "--bogus"])).toThrow(/unknown flag/);
  });

  test("extra positional refuses", () => {
    expect(() => parseDissolveWorkerArgs(["t-x", "extra"])).toThrow(/unexpected positional/);
  });
});

// ---------- Caller-scope gate ----------

describe("dissolveWorker — caller-scope gate (ADR-033)", () => {
  test("refuses when caller is member", async () => {
    let dispatchCalls = 0;
    const opts: DissolveWorkerOpts = {
      callerScope: () => "member",
      dissolve: async () => {
        dispatchCalls += 1;
        return 0;
      },
    };
    await expect(dissolveWorker(["t-abc"], opts)).rejects.toThrow(
      /refused.*caller scope is not 'driver'/,
    );
    expect(dispatchCalls).toBe(0);
  });
});

// ---------- Worker-id gate ----------

describe("dissolveWorker — worker-id prefix gate", () => {
  test("refuses generic 'e-' epic ids with hint to dissolve-epic", async () => {
    const opts: DissolveWorkerOpts = {
      callerScope: () => "driver",
      dissolve: async () => 0,
    };
    await expect(dissolveWorker(["e-deadbeef"], opts)).rejects.toThrow(
      /looks like a generic epic-team id.*refusing/,
    );
  });

  test("normalises 't-' prefix to 'w-' before delegating", async () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const opts: DissolveWorkerOpts = {
      callerScope: () => "driver",
      dissolve: async (argv) => {
        calls.push(argv);
        return 0;
      },
    };
    const rc = await dissolveWorker(["t-abc123"], opts);
    expect(rc).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("w-abc123");
  });

  test("passes through 'w-' prefix unchanged", async () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const opts: DissolveWorkerOpts = {
      callerScope: () => "driver",
      dissolve: async (argv) => {
        calls.push(argv);
        return 0;
      },
    };
    const rc = await dissolveWorker(["w-deadbeef"], opts);
    expect(rc).toBe(0);
    expect(calls[0]?.[0]).toBe("w-deadbeef");
  });

  test("accepts bare id form, prefixes with 'w-'", async () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const opts: DissolveWorkerOpts = {
      callerScope: () => "driver",
      dissolve: async (argv) => {
        calls.push(argv);
        return 0;
      },
    };
    const rc = await dissolveWorker(["abc999"], opts);
    expect(rc).toBe(0);
    expect(calls[0]?.[0]).toBe("w-abc999");
  });

  test("passes through --skip-checks + --force-prune flags", async () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const opts: DissolveWorkerOpts = {
      callerScope: () => "driver",
      dissolve: async (argv) => {
        calls.push(argv);
        return 0;
      },
    };
    const rc = await dissolveWorker(["w-abc", "--skip-checks", "--force-prune"], opts);
    expect(rc).toBe(0);
    expect(calls[0]).toEqual(["w-abc", "--skip-checks", "--force-prune"]);
  });

  test("forwards opts to dissolveEpic delegate (e.g. cockpitPath)", async () => {
    let receivedOpts: DissolveEpicOpts | null = null;
    const opts: DissolveWorkerOpts = {
      callerScope: () => "driver",
      cockpitPath: "/tmp/test-cockpit.json",
      dissolve: async (_argv, opts) => {
        receivedOpts = opts;
        return 0;
      },
    };
    await dissolveWorker(["w-abc"], opts);
    expect(receivedOpts).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: closure assignment defeats TS narrowing
    expect(receivedOpts!.cockpitPath).toBe("/tmp/test-cockpit.json");
  });

  test("propagates exit code from delegate", async () => {
    const opts: DissolveWorkerOpts = {
      callerScope: () => "driver",
      dissolve: async () => 7,
    };
    expect(await dissolveWorker(["w-abc"], opts)).toBe(7);
  });
});
