// Unit tests for `atmux cockpit-mirror` Bun verb (ADR-219 T-S2-9 /
// t-7b7257f5). Coverage:
//   - parseCockpitMirrorArgs surface (bare sub-verbs, flag matrix,
//     missing-value rejection, unknown-flag rejection)
//   - cockpitMirror dispatch routing per topic (handler resolution,
//     unknown-topic warn-and-pass, handler-throw → exit 1)

import { describe, expect, spyOn, test } from "bun:test";
import { UsageError } from "../../../src/errors.ts";
import { cockpitMirror, parseCockpitMirrorArgs } from "../../../src/verbs/cockpit-mirror.ts";

describe("parseCockpitMirrorArgs", () => {
  test("--handle-one + --event-id + --topic parses", () => {
    expect(
      parseCockpitMirrorArgs([
        "--handle-one",
        "--event-id",
        "01900xyz",
        "--topic",
        "epic.merge_ready",
      ]),
    ).toEqual({
      subverb: "handle-one",
      eventId: "01900xyz",
      topic: "epic.merge_ready",
    });
  });

  test("'handle-one' bare form parses identically", () => {
    expect(
      parseCockpitMirrorArgs(["handle-one", "--event-id", "01900xyz", "--topic", "team.spawned"]),
    ).toEqual({
      subverb: "handle-one",
      eventId: "01900xyz",
      topic: "team.spawned",
    });
  });

  test("--status parses as status sub-verb", () => {
    expect(parseCockpitMirrorArgs(["--status"])).toEqual({ subverb: "status" });
  });

  test("'status' bare form parses identically", () => {
    expect(parseCockpitMirrorArgs(["status"])).toEqual({ subverb: "status" });
  });

  test("--handle-one without --event-id throws", () => {
    expect(() => parseCockpitMirrorArgs(["--handle-one", "--topic", "team.spawned"])).toThrow(
      UsageError,
    );
  });

  test("--handle-one without --topic throws", () => {
    expect(() => parseCockpitMirrorArgs(["--handle-one", "--event-id", "x"])).toThrow(UsageError);
  });

  test("--event-id without value throws", () => {
    expect(() => parseCockpitMirrorArgs(["--handle-one", "--event-id"])).toThrow(UsageError);
  });

  test("--topic without value throws", () => {
    expect(() => parseCockpitMirrorArgs(["--handle-one", "--topic"])).toThrow(UsageError);
  });

  test("no sub-verb throws UsageError", () => {
    expect(() => parseCockpitMirrorArgs([])).toThrow(UsageError);
  });

  test("unknown flag throws UsageError", () => {
    expect(() => parseCockpitMirrorArgs(["--frobnicate"])).toThrow(UsageError);
  });

  test("unexpected positional arg throws UsageError", () => {
    expect(() => parseCockpitMirrorArgs(["garbage"])).toThrow(UsageError);
  });
});

describe("cockpitMirror — handle-one dispatch", () => {
  test("default logger writes status diagnostics to stderr", async () => {
    const chunks: string[] = [];
    const write = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      expect(await cockpitMirror(["--status"])).toBe(0);
    } finally {
      write.mockRestore();
    }
    expect(chunks.join("")).toContain("# atmux cockpit-mirror --status\n");
    expect(chunks.join("")).toContain("known-topics\t7\n");
  });

  test("known topic + injected handler: handler called with eventId, returns 0", async () => {
    const calls: Array<{ topic: string; eventId: string }> = [];
    const logs: string[] = [];
    const handlers = {
      "epic.merge_ready": async (eventId: string): Promise<void> => {
        calls.push({ topic: "epic.merge_ready", eventId });
      },
    };
    const rc = await cockpitMirror(
      ["--handle-one", "--event-id", "e-1", "--topic", "epic.merge_ready"],
      { handlers, log: (m) => logs.push(m) },
    );
    expect(rc).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ topic: "epic.merge_ready", eventId: "e-1" });
    expect(logs).toEqual([]);
  });

  test("known topic + no injected handler: every default stub logs and returns 0", async () => {
    const topics = [
      "epic.merge_ready",
      "epic.spawn_blocked",
      "team.spawned",
      "team.dissolved",
      "budget.warning",
      "budget.recovered",
      "gitter.escalated",
    ] as const;
    for (const topic of topics) {
      const logs: string[] = [];
      const rc = await cockpitMirror(["--handle-one", "--event-id", "e-1", "--topic", topic], {
        log: (m) => logs.push(m),
      });
      expect(rc).toBe(0);
      expect(logs).toEqual([`cockpit-mirror: ${topic} eventId=e-1 — log-only (handler follow-up)`]);
    }
  });

  test("unknown topic: log-warn + return 0 (do NOT block Rust drain)", async () => {
    const logs: string[] = [];
    const rc = await cockpitMirror(
      ["--handle-one", "--event-id", "e-1", "--topic", "totally.fictional"],
      { log: (m) => logs.push(m) },
    );
    expect(rc).toBe(0);
    expect(logs).toEqual([
      "cockpit-mirror: unknown topic 'totally.fictional' eventId=e-1 — log-warn, return 0",
    ]);
  });

  test("known topic + handler throws: returns 1 + logs", async () => {
    const logs: string[] = [];
    const handlers = {
      "budget.warning": async (): Promise<void> => {
        throw new Error("simulated handler fault");
      },
    };
    const rc = await cockpitMirror(
      ["--handle-one", "--event-id", "e-1", "--topic", "budget.warning"],
      { handlers, log: (m) => logs.push(m) },
    );
    expect(rc).toBe(1);
    expect(logs).toEqual([
      "cockpit-mirror: handler threw on topic=budget.warning eventId=e-1: simulated handler fault",
    ]);
  });

  test("--status surfaces the topic whitelist and formatting exactly", async () => {
    const logs: string[] = [];
    const rc = await cockpitMirror(["--status"], { log: (m) => logs.push(m) });
    expect(rc).toBe(0);
    expect(logs).toEqual([
      "# atmux cockpit-mirror --status",
      "known-topics\t7",
      "topic\tbudget.recovered\tstub (handler follow-up pending)",
      "topic\tbudget.warning\tstub (handler follow-up pending)",
      "topic\tepic.merge_ready\tstub (handler follow-up pending)",
      "topic\tepic.spawn_blocked\tstub (handler follow-up pending)",
      "topic\tgitter.escalated\tstub (handler follow-up pending)",
      "topic\tteam.dissolved\tstub (handler follow-up pending)",
      "topic\tteam.spawned\tstub (handler follow-up pending)",
    ]);
    for (const topic of [
      "budget.recovered",
      "budget.warning",
      "epic.merge_ready",
      "epic.spawn_blocked",
      "gitter.escalated",
      "team.dissolved",
      "team.spawned",
    ]) {
      expect(logs.some((l) => l.includes(`topic\t${topic}`))).toBe(true);
    }
  });
});
