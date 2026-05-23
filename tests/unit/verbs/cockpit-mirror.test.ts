// Unit tests for `atmux cockpit-mirror` Bun verb (ADR-219 T-S2-9 /
// t-7b7257f5). Coverage:
//   - parseCockpitMirrorArgs surface (bare sub-verbs, flag matrix,
//     missing-value rejection, unknown-flag rejection)
//   - cockpitMirror dispatch routing per topic (handler resolution,
//     unknown-topic warn-and-pass, handler-throw → exit 1)

import { describe, expect, test } from "bun:test";
import { UsageError } from "../../../src/errors.ts";
import {
  cockpitMirror,
  parseCockpitMirrorArgs,
} from "../../../src/verbs/cockpit-mirror.ts";

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
      parseCockpitMirrorArgs([
        "handle-one",
        "--event-id",
        "01900xyz",
        "--topic",
        "team.spawned",
      ]),
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
    expect(() =>
      parseCockpitMirrorArgs(["--handle-one", "--topic", "team.spawned"]),
    ).toThrow(UsageError);
  });

  test("--handle-one without --topic throws", () => {
    expect(() =>
      parseCockpitMirrorArgs(["--handle-one", "--event-id", "x"]),
    ).toThrow(UsageError);
  });

  test("--event-id without value throws", () => {
    expect(() => parseCockpitMirrorArgs(["--handle-one", "--event-id"])).toThrow(
      UsageError,
    );
  });

  test("--topic without value throws", () => {
    expect(() => parseCockpitMirrorArgs(["--handle-one", "--topic"])).toThrow(
      UsageError,
    );
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
  });

  test("known topic + no injected handler: falls through to default stub, returns 0 + logs", async () => {
    const logs: string[] = [];
    const rc = await cockpitMirror(
      ["--handle-one", "--event-id", "e-1", "--topic", "team.spawned"],
      { log: (m) => logs.push(m) },
    );
    expect(rc).toBe(0);
    expect(logs.some((l) => l.includes("team.spawned eventId=e-1"))).toBe(true);
    expect(logs.some((l) => l.includes("log-only"))).toBe(true);
  });

  test("unknown topic: log-warn + return 0 (do NOT block Rust drain)", async () => {
    const logs: string[] = [];
    const rc = await cockpitMirror(
      ["--handle-one", "--event-id", "e-1", "--topic", "totally.fictional"],
      { log: (m) => logs.push(m) },
    );
    expect(rc).toBe(0);
    expect(logs.some((l) => l.includes("unknown topic 'totally.fictional'"))).toBe(true);
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
    expect(logs.some((l) => l.includes("handler threw"))).toBe(true);
    expect(logs.some((l) => l.includes("simulated handler fault"))).toBe(true);
  });

  test("--status surfaces the topic whitelist", async () => {
    const logs: string[] = [];
    const rc = await cockpitMirror(["--status"], { log: (m) => logs.push(m) });
    expect(rc).toBe(0);
    expect(logs.some((l) => l.includes("known-topics"))).toBe(true);
    // All 7 ADR-219 D3 topics must surface (sorted).
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
