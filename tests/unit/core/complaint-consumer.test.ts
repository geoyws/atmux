// Unit tests for src/core/complaint-consumer.ts (ADR-214 §D2 wire,
// e-92b8fa97).
//
// The consumer is the event-subscription registry subscriber for
// `complaint.filed` (drained by `committer --drain` since ADR-276). It
// routes complaints to the target team's lead via `atmux tell-lead`
// per ADR-214's lead-gated adjudication pattern.

import { describe, expect, mock, test } from "bun:test";
import * as nodeChildProcess from "node:child_process";
import {
  type ComplaintConsumerOutcome,
  createComplaintConsumerHandler,
  formatComplaintMessage,
} from "../../../src/core/complaint-consumer.ts";
import type { ComplaintFiledPayload } from "../../../src/schema/events.ts";

const childProcessSnapshot = { ...nodeChildProcess };
const realSpawn = nodeChildProcess.spawn;

function makeEvent(overrides: Partial<ComplaintFiledPayload> = {}): ComplaintFiledPayload {
  return {
    topic: "complaint.filed",
    eventId: "00000000-0000-7000-8000-000000000001",
    emittedAtSec: 1779600000,
    schemaVersion: 1,
    complaintId: "c-deadbeef",
    targetTeam: "atmux",
    sourceKind: "operator",
    sourceId: "test-001",
    incidentSummary: "test summary",
    openedBy: "operator",
    severity: "warn",
    sourceCount: 1,
    bumped: false,
    filedAtSec: 1779600000,
    ...overrides,
  };
}

describe("createComplaintConsumerHandler — routing", () => {
  test("routes a fresh complaint via atmux tell-lead with --team and message", async () => {
    const captured: string[][] = [];
    const handler = createComplaintConsumerHandler({
      spawnTellLead: async (args) => {
        captured.push([...args]);
        return 0;
      },
      env: {},
    });
    const outcome = await handler(makeEvent());
    expect(outcome).toBe("routed" satisfies ComplaintConsumerOutcome);
    expect(captured).toHaveLength(1);
    const first = captured[0]!;
    expect(first[0]).toBe("tell-lead");
    expect(first[1]).toBe("--team");
    expect(first[2]).toBe("atmux");
    const msg = first[3]!;
    expect(msg).toContain("c-deadbeef");
    expect(msg).toContain("test summary");
    expect(msg).toContain("severity=warn");
    expect(msg).toContain("source=operator");
  });

  test.serial("falls back to the real spawn path when deps.spawnTellLead is omitted", async () => {
    const calls: Array<{
      command: string;
      args: ReadonlyArray<string>;
      options: { stdio?: string; env?: NodeJS.ProcessEnv };
    }> = [];
    let installed = false;

    try {
      mock.module("node:child_process", () => ({
        ...childProcessSnapshot,
        spawn: mock(
          (
            command: string,
            args: ReadonlyArray<string>,
            options: { stdio?: string; env?: NodeJS.ProcessEnv },
          ) => {
            const callIndex = calls.push({ command, args: [...args], options });
            const child = {
              on(
                event: "error" | "exit",
                handler: (code?: number | Error) => void,
              ) {
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

      const routedEvent = makeEvent({ complaintId: "c-fallback-ok", targetTeam: "sopx" });
      const routedHandler = createComplaintConsumerHandler({ env: {} });
      const routedOutcome = await routedHandler(routedEvent);
      expect(routedOutcome).toBe("routed" satisfies ComplaintConsumerOutcome);

      const failedEvent = makeEvent({ complaintId: "c-fallback-fail", targetTeam: "opsx" });
      const failedHandler = createComplaintConsumerHandler({ env: {} });
      const failedOutcome = await failedHandler(failedEvent);
      expect(failedOutcome).toBe("tell-lead-failed" satisfies ComplaintConsumerOutcome);

      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual({
        command: "atmux",
        args: ["tell-lead", "--team", "sopx", formatComplaintMessage(routedEvent)],
        options: {
          stdio: "inherit",
          env: process.env,
        },
      });
      expect(calls[1]).toEqual({
        command: "atmux",
        args: ["tell-lead", "--team", "opsx", formatComplaintMessage(failedEvent)],
        options: {
          stdio: "inherit",
          env: process.env,
        },
      });
    } finally {
      if (installed) {
        mock.module("node:child_process", () => ({
          ...childProcessSnapshot,
        }));
        mock.restore();
        expect(nodeChildProcess.spawn).toBe(realSpawn);
      }
    }
  });

  test("cross-team complaints pass the target team name to tell-lead", async () => {
    const captured: string[][] = [];
    const handler = createComplaintConsumerHandler({
      spawnTellLead: async (args) => {
        captured.push([...args]);
        return 0;
      },
      env: {},
    });
    await handler(makeEvent({ targetTeam: "sopx", complaintId: "c-cafe" }));
    expect(captured[0]).toEqual(["tell-lead", "--team", "sopx", expect.any(String) as never]);
    expect(captured[0]![3]).toContain("c-cafe");
  });

  test("bumped complaints skip routing by default (dedup re-arm)", async () => {
    const captured: string[][] = [];
    const handler = createComplaintConsumerHandler({
      spawnTellLead: async (args) => {
        captured.push([...args]);
        return 0;
      },
      env: {},
    });
    const outcome = await handler(makeEvent({ bumped: true, sourceCount: 3 }));
    expect(outcome).toBe("skipped-bump" satisfies ComplaintConsumerOutcome);
    expect(captured).toHaveLength(0);
  });

  test("ATMUX_COMPLAINT_ROUTE_BUMPS=1 routes bumped complaints too", async () => {
    const captured: string[][] = [];
    const handler = createComplaintConsumerHandler({
      spawnTellLead: async (args) => {
        captured.push([...args]);
        return 0;
      },
      env: { ATMUX_COMPLAINT_ROUTE_BUMPS: "1" },
    });
    const outcome = await handler(makeEvent({ bumped: true, sourceCount: 3 }));
    expect(outcome).toBe("routed" satisfies ComplaintConsumerOutcome);
    expect(captured).toHaveLength(1);
  });

  test("non-zero spawn exit returns tell-lead-failed (Rust retries)", async () => {
    const handler = createComplaintConsumerHandler({
      spawnTellLead: async () => 1,
      env: {},
    });
    const outcome = await handler(makeEvent());
    expect(outcome).toBe("tell-lead-failed" satisfies ComplaintConsumerOutcome);
  });
});

describe("formatComplaintMessage", () => {
  test("includes id, severity, source, summary, and adjudication hint", () => {
    const msg = formatComplaintMessage(makeEvent());
    expect(msg).toContain("[complaint]");
    expect(msg).toContain("c-deadbeef");
    expect(msg).toContain("severity=warn");
    expect(msg).toContain("source=operator");
    expect(msg).toContain("test summary");
    expect(msg).toContain("atmux complaints resolve c-deadbeef");
  });

  test("annotates source_count for bumped complaints (×N)", () => {
    const msg = formatComplaintMessage(makeEvent({ sourceCount: 5 }));
    expect(msg).toContain("c-deadbeef (×5)");
  });

  test("falls back to 'unrated' / 'unknown' for null severity / sourceKind", () => {
    const msg = formatComplaintMessage(makeEvent({ severity: null, sourceKind: null }));
    expect(msg).toContain("severity=unrated");
    expect(msg).toContain("source=unknown");
  });
});
