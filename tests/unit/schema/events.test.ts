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
  MemberOverloadedPayload,
  MemberRateLimitedPayload,
  MemberUsageSnapshotPayload,
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

describe("member-health telemetry (ADR-258 §D6b — emit-only, no Phase 1 consumer)", () => {
  test("member.rate-limited parses a valid 429 payload via the union", () => {
    const parsed = EventPayload.parse({
      topic: "member.rate-limited",
      eventId: SAMPLE_UUID7,
      emittedAtSec: 1_700_000_000,
      team: "atmux",
      member: "be-1",
      account: "claude-unum",
      httpStatus: 429,
      retryAfterSec: 30,
      h5Util: 0.92,
      wkUtil: 0.7,
      capturedAtSec: 1_700_000_001,
    });
    expect(parsed.topic).toBe("member.rate-limited");
    if (parsed.topic === "member.rate-limited") {
      expect(parsed.httpStatus).toBe(429);
      expect(parsed.retryAfterSec).toBe(30);
      expect(parsed.h5Util).toBe(0.92);
    }
  });

  test("member.rate-limited parses with optionals omitted", () => {
    const parsed = MemberRateLimitedPayload.parse({
      topic: "member.rate-limited",
      eventId: SAMPLE_UUID7,
      emittedAtSec: 1_700_000_000,
      team: "atmux",
      member: "be-1",
      account: "claude-unum",
      httpStatus: 429,
      capturedAtSec: 1_700_000_001,
      // retryAfterSec / h5Util / wkUtil omitted
    });
    expect(parsed.retryAfterSec).toBeUndefined();
    expect(parsed.h5Util).toBeUndefined();
  });

  test("member.rate-limited rejects a malformed payload (missing required account)", () => {
    expect(() =>
      MemberRateLimitedPayload.parse({
        topic: "member.rate-limited",
        eventId: SAMPLE_UUID7,
        emittedAtSec: 1_700_000_000,
        team: "atmux",
        member: "be-1",
        // account missing
        httpStatus: 429,
        capturedAtSec: 1_700_000_001,
      }),
    ).toThrow();
  });

  test("member.rate-limited rejects out-of-range h5Util (>1)", () => {
    expect(() =>
      MemberRateLimitedPayload.parse({
        topic: "member.rate-limited",
        eventId: SAMPLE_UUID7,
        emittedAtSec: 1_700_000_000,
        team: "atmux",
        member: "be-1",
        account: "claude-unum",
        httpStatus: 429,
        h5Util: 1.5,
        capturedAtSec: 1_700_000_001,
      }),
    ).toThrow();
  });

  test("member.overloaded parses a valid 529 payload via the union", () => {
    const parsed = EventPayload.parse({
      topic: "member.overloaded",
      eventId: SAMPLE_UUID7,
      emittedAtSec: 1_700_000_000,
      team: "atmux",
      member: "fe-2",
      account: "claude-icloud",
      httpStatus: 529,
      retryAfterSec: 5,
      capturedAtSec: 1_700_000_002,
    });
    expect(parsed.topic).toBe("member.overloaded");
    if (parsed.topic === "member.overloaded") {
      expect(parsed.httpStatus).toBe(529);
      expect(parsed.retryAfterSec).toBe(5);
    }
  });

  test("member.overloaded rejects a non-529 httpStatus (pinned literal)", () => {
    expect(() =>
      MemberOverloadedPayload.parse({
        topic: "member.overloaded",
        eventId: SAMPLE_UUID7,
        emittedAtSec: 1_700_000_000,
        team: "atmux",
        member: "fe-2",
        account: "claude-icloud",
        httpStatus: 429, // wrong — overloaded is 529 only
        capturedAtSec: 1_700_000_002,
      }),
    ).toThrow();
  });

  test("member.overloaded rejects a malformed payload (missing capturedAtSec)", () => {
    expect(() =>
      MemberOverloadedPayload.parse({
        topic: "member.overloaded",
        eventId: SAMPLE_UUID7,
        emittedAtSec: 1_700_000_000,
        team: "atmux",
        member: "fe-2",
        account: "claude-icloud",
        httpStatus: 529,
        // capturedAtSec missing
      }),
    ).toThrow();
  });

  test("member.usage-snapshot parses a valid payload via the union", () => {
    const parsed = EventPayload.parse({
      topic: "member.usage-snapshot",
      eventId: SAMPLE_UUID7,
      emittedAtSec: 1_700_000_000,
      team: "atmux",
      member: "be-3",
      account: "claude-ifca",
      inputTokens: 12_345,
      outputTokens: 6_789,
      estimatedUsd: 0.42,
      h5Util: 0.5,
      wkUtil: 0.33,
      capturedAtSec: 1_700_000_003,
    });
    expect(parsed.topic).toBe("member.usage-snapshot");
    if (parsed.topic === "member.usage-snapshot") {
      expect(parsed.inputTokens).toBe(12_345);
      expect(parsed.outputTokens).toBe(6_789);
      expect(parsed.estimatedUsd).toBe(0.42);
    }
  });

  test("member.usage-snapshot parses with optionals omitted", () => {
    const parsed = MemberUsageSnapshotPayload.parse({
      topic: "member.usage-snapshot",
      eventId: SAMPLE_UUID7,
      emittedAtSec: 1_700_000_000,
      team: "atmux",
      member: "be-3",
      account: "claude-ifca",
      inputTokens: 100,
      outputTokens: 200,
      capturedAtSec: 1_700_000_003,
      // estimatedUsd / h5Util / wkUtil omitted
    });
    expect(parsed.estimatedUsd).toBeUndefined();
    expect(parsed.h5Util).toBeUndefined();
  });

  test("member.usage-snapshot rejects a malformed payload (missing inputTokens)", () => {
    expect(() =>
      MemberUsageSnapshotPayload.parse({
        topic: "member.usage-snapshot",
        eventId: SAMPLE_UUID7,
        emittedAtSec: 1_700_000_000,
        team: "atmux",
        member: "be-3",
        account: "claude-ifca",
        // inputTokens missing
        outputTokens: 200,
        capturedAtSec: 1_700_000_003,
      }),
    ).toThrow();
  });

  test("member.usage-snapshot rejects negative token counts", () => {
    expect(() =>
      MemberUsageSnapshotPayload.parse({
        topic: "member.usage-snapshot",
        eventId: SAMPLE_UUID7,
        emittedAtSec: 1_700_000_000,
        team: "atmux",
        member: "be-3",
        account: "claude-ifca",
        inputTokens: -1,
        outputTokens: 200,
        capturedAtSec: 1_700_000_003,
      }),
    ).toThrow();
  });

  test("all three member-health topics are in TOPICS + isKnownTopic returns true", () => {
    const set = new Set<string>(TOPICS);
    for (const t of [
      "member.rate-limited",
      "member.overloaded",
      "member.usage-snapshot",
    ] as const) {
      expect(set.has(t)).toBe(true);
      expect(isKnownTopic(t)).toBe(true);
    }
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
    // is the reminder. Current closed set: 5 task + 8 story + 15 epic
    // (4 base + 2 ADR-225 amendment: epic.unblocked/epic.ready;
    //  +2 ADR-226 §D2: epic.merged/epic.merge-blocked;
    //  +1 ADR-227 §D2: epic.dissolve-blocked;
    //  +3 ADR-229 §D3: epic.pushed/epic.push-blocked/epic.push-conflict;
    //  +3 ADR-228 §D5: epic.spawn-queued/epic.spawn-abandoned/epic.added)
    // + 3 commit + 1 gitter + 3 pane + 4 coordination
    // + 1 member.context-high (e-13-04c8b3bf — member context-saturation
    //   signal)
    // + 3 member-health (ADR-258 §D6b Amendment 2026-06-08:
    //   member.rate-limited / member.overloaded / member.usage-snapshot —
    //   emit-only telemetry from the future claude-agent-sdk backend)
    // + 7 cockpit
    // (sentinel.escalated removed per EPIC e-be01fc89) + 4 internal = 54.
    expect(TOPICS.length).toBe(54);
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
