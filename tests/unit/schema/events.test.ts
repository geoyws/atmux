// Unit tests for src/schema/events.ts — Zod payload schemas for the
// Honker substrate (ADR-202 + ADR-203).
//
// Pins:
//   - Discriminated union by `topic` — wrong topic + valid fields fails
//     parse (the load-bearing exhaustiveness property per ADR-203 §D1).
//   - BasePayloadFields are required on every payload (ID + clock +
//     version are not optional).
//   - `.passthrough()` round-trips unknown fields (forward-compat per
//     ADR-203 §D3 + the kanban .passthrough precedent).
//   - TOPICS constant matches ADR-203 §D2 closed set; `isKnownTopic`
//     rejects unknown names.
//   - Reserved `internal.*` namespace is enumerated for substrate
//     self-monitoring topics only.

import { describe, expect, test } from "bun:test";
import {
  EventPayload,
  GitterEscalatedPayload,
  isKnownTopic,
  TaskClaimedPayload,
  TOPICS,
} from "../../../src/schema/events.ts";

const SAMPLE_UUID7 = "01890000-0000-7000-8000-000000000001";

describe("BasePayloadFields shape", () => {
  test("schemaVersion defaults to 1 when omitted", () => {
    const parsed = TaskClaimedPayload.parse({
      topic: "task.claimed",
      eventId: SAMPLE_UUID7,
      emittedAtSec: 1_700_000_000,
      taskId: "t-abcd1234",
      member: "be-1",
      team: "alpha",
      // schemaVersion intentionally omitted
    });
    expect(parsed.schemaVersion).toBe(1);
  });

  test("eventId + topic + emittedAtSec are required", () => {
    expect(() =>
      TaskClaimedPayload.parse({
        // topic missing
        eventId: SAMPLE_UUID7,
        emittedAtSec: 1_700_000_000,
        taskId: "t-abcd1234",
        member: "be-1",
        team: "alpha",
      }),
    ).toThrow();
    expect(() =>
      TaskClaimedPayload.parse({
        topic: "task.claimed",
        // eventId missing
        emittedAtSec: 1_700_000_000,
        taskId: "t-abcd1234",
        member: "be-1",
        team: "alpha",
      }),
    ).toThrow();
    expect(() =>
      TaskClaimedPayload.parse({
        topic: "task.claimed",
        eventId: SAMPLE_UUID7,
        // emittedAtSec missing
        taskId: "t-abcd1234",
        member: "be-1",
        team: "alpha",
      }),
    ).toThrow();
  });
});

describe("EventPayload discriminated union", () => {
  test("parses task.claimed via the union", () => {
    const parsed = EventPayload.parse({
      topic: "task.claimed",
      eventId: SAMPLE_UUID7,
      emittedAtSec: 1_700_000_000,
      taskId: "t-abcd1234",
      member: "be-1",
      team: "alpha",
    });
    expect(parsed.topic).toBe("task.claimed");
    // Discriminator narrows the type — TS knows this is a TaskClaimedPayload
    if (parsed.topic === "task.claimed") {
      expect(parsed.taskId).toBe("t-abcd1234");
    }
  });

  test("parses task.done with optional commitSha", () => {
    const parsed = EventPayload.parse({
      topic: "task.done",
      eventId: SAMPLE_UUID7,
      emittedAtSec: 1_700_000_000,
      taskId: "t-abcd1234",
      member: "be-1",
      team: "alpha",
      doneAtSec: 1_700_000_005,
      commitSha: "abc123",
    });
    expect(parsed.topic).toBe("task.done");
    if (parsed.topic === "task.done") {
      expect(parsed.commitSha).toBe("abc123");
      expect(parsed.doneAtSec).toBe(1_700_000_005);
    }
  });

  test("parses commit.landed payload (ADR-203 §D5 hook contract)", () => {
    const parsed = EventPayload.parse({
      topic: "commit.landed",
      eventId: SAMPLE_UUID7,
      emittedAtSec: 1_700_000_000,
      commitSha: "deadbeef",
      branch: "geoyws",
      author: "george@example.com",
      message: "feat: thing",
    });
    expect(parsed.topic).toBe("commit.landed");
  });

  test("parses gitter.escalated with required fields (ADR-212 §D2 lead-gated handoff)", () => {
    const parsed = EventPayload.parse({
      topic: "gitter.escalated",
      eventId: SAMPLE_UUID7,
      emittedAtSec: 1_700_000_000,
      taskId: "t-abcd1234",
      member: "be-1",
      team: "atmux",
      branch: "atmux-geoyws-foo",
      commitSha: "abc1234",
      failureClass: "merge-conflict",
    });
    expect(parsed.topic).toBe("gitter.escalated");
    if (parsed.topic === "gitter.escalated") {
      // severity defaults to medium when omitted
      expect(parsed.severity).toBe("medium");
      expect(parsed.failureClass).toBe("merge-conflict");
      expect(parsed.conflictFiles).toBeUndefined();
      expect(parsed.suggestedResolution).toBeUndefined();
    }
  });

  test("parses gitter.escalated with optional conflictFiles + suggestedResolution + explicit severity", () => {
    const parsed = EventPayload.parse({
      topic: "gitter.escalated",
      eventId: SAMPLE_UUID7,
      emittedAtSec: 1_700_000_000,
      taskId: "t-xyz",
      member: "be-2",
      team: "atmux",
      branch: "atmux-geoyws-bar",
      commitSha: "def5678",
      conflictFiles: ["src/a.ts", "src/b.ts"],
      suggestedResolution: "rebase",
      severity: "high",
      failureClass: "test-failed-on-trunk",
    });
    if (parsed.topic === "gitter.escalated") {
      expect(parsed.conflictFiles).toEqual(["src/a.ts", "src/b.ts"]);
      expect(parsed.suggestedResolution).toBe("rebase");
      expect(parsed.severity).toBe("high");
      expect(parsed.failureClass).toBe("test-failed-on-trunk");
    }
  });

  test("rejects gitter.escalated with empty body (required fields missing)", () => {
    expect(() => GitterEscalatedPayload.parse({})).toThrow();
  });

  test("rejects gitter.escalated with unknown failureClass", () => {
    expect(() =>
      EventPayload.parse({
        topic: "gitter.escalated",
        eventId: SAMPLE_UUID7,
        emittedAtSec: 1_700_000_000,
        taskId: "t-xyz",
        member: "be-1",
        team: "atmux",
        branch: "atmux-geoyws-baz",
        commitSha: "ffeedd",
        failureClass: "made-up-class",
      }),
    ).toThrow();
  });

  test("rejects gitter.escalated with unknown suggestedResolution", () => {
    expect(() =>
      EventPayload.parse({
        topic: "gitter.escalated",
        eventId: SAMPLE_UUID7,
        emittedAtSec: 1_700_000_000,
        taskId: "t-xyz",
        member: "be-1",
        team: "atmux",
        branch: "atmux-geoyws-baz",
        commitSha: "ffeedd",
        failureClass: "merge-conflict",
        suggestedResolution: "force-push",
      }),
    ).toThrow();
  });

  test("parses internal.honker.loaded substrate event (ADR-203 §D8)", () => {
    const parsed = EventPayload.parse({
      topic: "internal.honker.loaded",
      eventId: SAMPLE_UUID7,
      emittedAtSec: 1_700_000_000,
      extensionPath: "/root/.atmux/extensions/honker.so",
    });
    expect(parsed.topic).toBe("internal.honker.loaded");
  });

  test("parses internal.honker.fallback with nullable extensionPath", () => {
    const parsed = EventPayload.parse({
      topic: "internal.honker.fallback",
      eventId: SAMPLE_UUID7,
      emittedAtSec: 1_700_000_000,
      fallbackReason: "kill-switch off",
      extensionPath: null,
    });
    expect(parsed.topic).toBe("internal.honker.fallback");
    if (parsed.topic === "internal.honker.fallback") {
      expect(parsed.extensionPath).toBeNull();
    }
  });

  test("rejects unknown topic via the discriminator", () => {
    expect(() =>
      EventPayload.parse({
        topic: "not.a.real.topic",
        eventId: SAMPLE_UUID7,
        emittedAtSec: 1_700_000_000,
      }),
    ).toThrow();
  });

  test("rejects task.claimed with wrong-shape payload (missing taskId)", () => {
    expect(() =>
      EventPayload.parse({
        topic: "task.claimed",
        eventId: SAMPLE_UUID7,
        emittedAtSec: 1_700_000_000,
        // taskId missing
        member: "be-1",
        team: "alpha",
      }),
    ).toThrow();
  });
});

describe("passthrough for forward-compat", () => {
  test("unknown fields round-trip through parse (kanban precedent)", () => {
    const parsed = TaskClaimedPayload.parse({
      topic: "task.claimed",
      eventId: SAMPLE_UUID7,
      emittedAtSec: 1_700_000_000,
      taskId: "t-abcd1234",
      member: "be-1",
      team: "alpha",
      futureField: "anything goes",
    });
    // The unknown field survives the parse (typed as unknown).
    expect((parsed as Record<string, unknown>).futureField).toBe("anything goes");
  });
});

describe("TOPICS registry + isKnownTopic", () => {
  test("v1 closed topic set has the expected size (ADR-203 §D2 enumeration)", () => {
    // Adding a topic to TOPICS requires an ADR amendment — failing here
    // is the reminder. Current closed set: 5 task + 8 story + 6 epic +
    // 3 commit + 1 gitter + 3 pane + 4 coordination + 8 cockpit + 4
    // internal = 42 (+2 epic post-ADR-226 §D2: epic.merged, epic.merge-blocked).
    expect(TOPICS.length).toBe(42);
  });

  test("known topics across each domain are present", () => {
    const set = new Set<string>(TOPICS);
    // sample one from each domain to assert the registry isn't a stub
    expect(set.has("task.claimed")).toBe(true);
    expect(set.has("story.jury.ratified")).toBe(true);
    expect(set.has("epic.merge-ready")).toBe(true);
    expect(set.has("commit.landed")).toBe(true);
    expect(set.has("gitter.escalated")).toBe(true);
    expect(set.has("pane.wedged")).toBe(true);
    expect(set.has("complaint.filed")).toBe(true);
    expect(set.has("budget.warning")).toBe(true);
    expect(set.has("internal.honker.loaded")).toBe(true);
  });

  test("isKnownTopic accepts every TOPICS entry", () => {
    for (const t of TOPICS) {
      expect(isKnownTopic(t)).toBe(true);
    }
  });

  test("isKnownTopic rejects unknown names", () => {
    expect(isKnownTopic("not.a.topic")).toBe(false);
    expect(isKnownTopic("")).toBe(false);
    expect(isKnownTopic("task.Claimed")).toBe(false); // case-sensitive
    expect(isKnownTopic("TASK.CLAIMED")).toBe(false);
  });

  test("internal.* namespace is enumerated and exclusive to substrate self-monitoring", () => {
    const internalTopics = TOPICS.filter((t) => t.startsWith("internal."));
    expect(internalTopics).toEqual([
      "internal.honker.loaded",
      "internal.honker.fallback",
      "internal.subscriber.crash",
      "internal.smoke.tick",
    ]);
  });
});
