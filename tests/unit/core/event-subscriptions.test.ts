import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapEventSubscriptions,
  COMPLAINT_CONSUMER_ID,
  EVENT_SUBSCRIPTIONS,
  registerEventSubscription,
} from "../../../src/core/event-subscriptions.ts";
import type { KanbanStory, KanbanTask } from "../../../src/schema/kanban.ts";

let atmuxDir: string;

beforeEach(async () => {
  EVENT_SUBSCRIPTIONS.length = 0;
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-event-subscriptions-"));
});

afterEach(async () => {
  EVENT_SUBSCRIPTIONS.length = 0;
  await rm(atmuxDir, { recursive: true, force: true });
});

describe("registry-mutating event-subscriptions coverage", () => {
  test("rejects duplicate consumerIds, bootstraps the canonical topic set, and each wrapper forwards", async () => {
    const expectedTopics = [
      "complaint.filed",
      "story.ready",
      "story.unclaimed",
      "task.unclaimed",
    ];
    const complaintCalls: Array<ReadonlyArray<string>> = [];
    const leadCalls: Array<ReadonlyArray<string>> = [];
    let currentNowSec = 1_780_000_000;
    const storyFixture: KanbanStory = {
      id: "s-1",
      status: "ready",
      title: "wrapper coverage story",
      advancedAt: 1_779_999_700,
      lane: "be",
      mergeMode: "feature-branch",
    };
    const taskFixture: KanbanTask = {
      id: "t-1",
      status: "unclaimed",
      subject: "wrapper coverage task",
      createdAt: 1_779_999_700,
      lane: "be",
    };

    const first = registerEventSubscription({
      topic: "topic.one",
      consumerId: "consumer-1",
      handler: async () => {},
    });
    const sizeAfterFirst = EVENT_SUBSCRIPTIONS.length;
    const duplicateSecond = registerEventSubscription({
      topic: "topic.two",
      consumerId: "consumer-1",
      handler: async () => {},
    });

    expect(first).toBe(true);
    expect(duplicateSecond).toBe(false);
    expect(EVENT_SUBSCRIPTIONS).toHaveLength(sizeAfterFirst);
    expect(EVENT_SUBSCRIPTIONS).toHaveLength(1);
    expect(EVENT_SUBSCRIPTIONS[0]?.topic).toBe("topic.one");

    EVENT_SUBSCRIPTIONS.length = 0;

    const result = bootstrapEventSubscriptions({
      complaintDeps: {
        spawnTellLead: async (args) => {
          complaintCalls.push([...args]);
          return 0;
        },
      },
      leadStallDeps: {
        atmuxDir,
        team: {
          name: "demo",
          members: [{ name: "be-1", lane: "be" }],
        },
        loadSnapshot: async () => ({
          stories: [storyFixture],
          tasks: [taskFixture],
        }),
        spawnTellLead: async (args) => {
          leadCalls.push([...args]);
          return 0;
        },
        nowSec: () => currentNowSec,
      },
    });

    expect(result.registered).toHaveLength(4);
    expect(result.registered.every((entry) => entry.isNew)).toBe(true);
    expect(EVENT_SUBSCRIPTIONS).toHaveLength(4);
    expect([...EVENT_SUBSCRIPTIONS.map((sub) => sub.topic)].sort()).toEqual([...expectedTopics].sort());

    const bootstrapSecond = bootstrapEventSubscriptions({
      complaintDeps: {
        spawnTellLead: async (args) => {
          complaintCalls.push([...args]);
          return 0;
        },
      },
      leadStallDeps: {
        atmuxDir,
        team: {
          name: "demo",
          members: [{ name: "be-1", lane: "be" }],
        },
        loadSnapshot: async () => ({
          stories: [storyFixture],
          tasks: [taskFixture],
        }),
        spawnTellLead: async (args) => {
          leadCalls.push([...args]);
          return 0;
        },
        nowSec: () => currentNowSec,
      },
    });

    expect(bootstrapSecond.registered).toHaveLength(4);
    expect(bootstrapSecond.registered.every((entry) => entry.isNew === false)).toBe(true);
    expect(EVENT_SUBSCRIPTIONS).toHaveLength(4);
    expect([...EVENT_SUBSCRIPTIONS.map((sub) => sub.topic)].sort()).toEqual([...expectedTopics].sort());

    const complaintSub = EVENT_SUBSCRIPTIONS.find((sub) => sub.consumerId === COMPLAINT_CONSUMER_ID);
    expect(complaintSub).toBeDefined();
    await complaintSub!.handler({
      topic: "complaint.filed",
      eventId: "evt-1",
      emittedAtSec: 1_780_000_000,
      schemaVersion: 1,
      complaintId: "c-1",
      targetTeam: "demo",
      sourceKind: "kanban",
      sourceId: "t-1",
      incidentSummary: "wrapper coverage",
      openedBy: "alpha",
      severity: "medium",
      sourceCount: 1,
      bumped: false,
      filedAtSec: 1_780_000_000,
    });
    expect(complaintCalls).toHaveLength(1);
    expect(complaintCalls[0]).toEqual([
      "tell-lead",
      "--team",
      "demo",
      "[complaint] c-1 severity=medium source=kanban: wrapper coverage — adjudicate: atmux complaints resolve c-1 --status resolved|wontfix --note \"<why>\"",
    ]);

    const leadSubs = EVENT_SUBSCRIPTIONS.filter((sub) =>
      sub.consumerId.startsWith("atmux:lead-stall-watchdog:"),
    );
    expect(leadSubs).toHaveLength(3);
    const leadEvent = {
      eventId: "evt-2",
      emittedAtSec: 1_780_000_000,
      schemaVersion: 1,
      team: "demo",
    };
    const expectedLeadMessage =
      "🔔 [lead-stall-watchdog] Idle with actionable work — dispatch these:\n" +
      "Ready stories (W1):\n" +
      "  • s-1 [lane=be] — wrapper coverage story — dispatch: atmux dispatch be-1 s-1\n" +
      "Unclaimed tasks (W2):\n" +
      "  • t-1 [lane=be] — wrapper coverage task — dispatch: atmux dispatch be-1 t-1\n" +
      "Next: dispatch the items above, or unready/unblock any that are not yet actionable.";
    const leadByTopic = new Map(leadSubs.map((sub) => [sub.topic, sub] as const));
    let expectedLeadCalls = leadCalls.length;
    for (const topic of ["story.ready", "story.unclaimed", "task.unclaimed"] as const) {
      const sub = leadByTopic.get(topic);
      expect(sub).toBeDefined();
      currentNowSec =
        topic === "story.ready" ? 1_780_000_000 : topic === "story.unclaimed" ? 1_780_000_300 : 1_780_000_600;
      await sub!.handler({ ...leadEvent, topic });
      expectedLeadCalls += 1;
      expect(leadCalls).toHaveLength(expectedLeadCalls);
    }
    expect(leadCalls).toHaveLength(3);
    expect(leadCalls[0]).toEqual(["tell-lead", "--team", "demo", expectedLeadMessage]);
    expect(leadCalls[1]).toEqual(["tell-lead", "--team", "demo", expectedLeadMessage]);
    expect(leadCalls[2]).toEqual(["tell-lead", "--team", "demo", expectedLeadMessage]);
  });
});
