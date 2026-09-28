// e-cc3728bf T2 — rotation consumer: correlate → suggest → nudge.
// Emit path uses temp state.db via the migrations pattern; sender is
// an injected recorder (no tell-lead wiring in core).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emit } from "../../../src/abstractions/events.ts";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import {
  CONSUMER_NAME,
  CORRELATION_WINDOW_MS,
  consumeTeam,
  correlateSignals,
  renderSuggestionMessage,
} from "../../../src/core/rotation-consumer.ts";
import type { EventPayload } from "../../../src/schema/events.ts";

const NOW = 1_787_000_100_000;
const SEC = Math.floor(NOW / 1000);

type EmitInput = Parameters<typeof emit>[1];

function stuck(team: string, member: string, atSec: number): EmitInput {
  return {
    topic: "pane.stuck",
    team,
    member,
    lastActivitySec: atSec - 1200,
    captureExcerpt: "Baked for 20m",
    observedAtSec: atSec,
  };
}

function noProgress(team: string, member: string, atSec: number): EmitInput {
  return {
    topic: "member.no-progress",
    team,
    member,
    lastCommitSec: atSec - 5400,
    taskClaimedSec: atSec - 4000,
    hoursIdle: 1.1,
    observedAtSec: atSec,
  };
}

function asEvents(inputs: EmitInput[]): EventPayload[] {
  return inputs as unknown as EventPayload[];
}
describe("correlateSignals", () => {
  test("stuck + no-progress same member within window → high", () => {
    const { suggestions } = correlateSignals(asEvents([stuck("atx", "m1", SEC), noProgress("atx", "m1", SEC - 60)]), NOW);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.confidence).toBe("high");
    expect(suggestions[0]?.reasons).toHaveLength(2);
  });
  test("signals 6 minutes apart → medium (window is 5)", () => {
    expect(CORRELATION_WINDOW_MS).toBe(5 * 60_000);
    const { suggestions } = correlateSignals(asEvents([stuck("atx", "m1", SEC), noProgress("atx", "m1", SEC - 360)]), NOW);
    expect(suggestions[0]?.confidence).toBe("medium");
  });
  test("lone stuck → medium single-reason", () => {
    const { suggestions } = correlateSignals(asEvents([stuck("atx", "m1", SEC)]), NOW);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.confidence).toBe("medium");
    expect(suggestions[0]?.reasons).toHaveLength(1);
  });
  test("different members do not correlate", () => {
    const { suggestions } = correlateSignals(asEvents([stuck("atx", "m1", SEC), noProgress("atx", "m2", SEC)]), NOW);
    expect(suggestions).toHaveLength(2);
    expect(suggestions.every((s) => s.confidence === "medium")).toBe(true);
  });
  test("different teams do not correlate", () => {
    const { suggestions } = correlateSignals(asEvents([stuck("a", "m1", SEC), noProgress("b", "m1", SEC)]), NOW);
    expect(suggestions).toHaveLength(2);
  });
  test("empty input → no suggestions", () => {
    expect(correlateSignals([], NOW)).toEqual({ suggestions: [], starving: [] });
  });
});

describe("renderSuggestionMessage", () => {
  test("carries verbatim rotate-member verb + lead gate", () => {
    const msg = renderSuggestionMessage({
      team: "atx",
      member: "m1",
      confidence: "high",
      reasons: ["stuck: x"],
      evidence: "x",
      observedAtMs: NOW,
    });
    expect(msg).toContain("atmux rotate-member m1 --reason stuck-pane");
    expect(msg).toContain("lead-gated");
  });
});

describe("consumeTeam", () => {
  let dir = "";
  let db: Database | null = null;
  const sent: Array<{ team: string; message: string }> = [];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-rotation-consume-"));
    db = openDatabase(join(dir, "state.db"), migrations);
    sent.length = 0;
  });
  afterEach(async () => {
    if (db !== null) closeDatabase(db);
    db = null;
    await rm(dir, { recursive: true, force: true });
  });

  async function seed(): Promise<void> {
    const d = db as Database;
    emit(d, stuck("atx", "m1", SEC));
    emit(d, noProgress("atx", "m1", SEC - 60));
    emit(d, stuck("atx", "m2", SEC));
  }

  test("high nudges lead, medium emits without nudge, offset advances", async () => {
    await seed();
    const got = await consumeTeam(db as Database, "atx", {
      sendToLead: (team, message) => { sent.push({ team, message }); },
      nowMs: () => NOW,
    });
    expect(got.suggestions).toHaveLength(2);
    expect(got.nudged).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.team).toBe("atx");
    expect(sent[0]?.message).toContain("rotate-member m1");
    const rows = (db as Database).query("SELECT topic FROM events WHERE topic = 'coordination.rotate-suggested'").all() as Array<{ topic: string }>;
    expect(rows).toHaveLength(2);
  });

  test("second pass over same backlog suggests nothing (offset held)", async () => {
    await seed();
    const d = db as Database;
    await consumeTeam(d, "atx", { sendToLead: () => {}, nowMs: () => NOW });
    const again = await consumeTeam(d, "atx", { sendToLead: () => { throw new Error("must not nudge"); }, nowMs: () => NOW });
    expect(again.suggestions).toHaveLength(0);
    expect(again.nudged).toBe(0);
  });

  test("other-team signals ignored, offset still advances past them", async () => {
    const d = db as Database;
    emit(d, stuck("other", "mx", SEC));
    const got = await consumeTeam(d, "atx", { sendToLead: () => {}, nowMs: () => NOW });
    expect(got.suggestions).toHaveLength(0);
    const repeat = await consumeTeam(d, "atx", { sendToLead: () => {}, nowMs: () => NOW });
    expect(repeat.suggestions).toHaveLength(0);
  });

  test("consumer name is stable for offset continuity", () => {
    expect(CONSUMER_NAME).toBe("rotation-consumer");
  });
});
