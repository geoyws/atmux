// ADR-225 §Events — `epic.unblocked` + `epic.ready` emission tests.
// T6 of EPIC e-cf8a6195 (master design task t-802c468b).
//
// Strategy: open the events table directly via SQL after each
// advanceEpic/setEpicReady call; assert the row count + payload
// shape. The `emit()` abstraction (src/abstractions/events.ts) is
// the source of truth — we exercise the integration through the
// public core/epic.ts API rather than mocking emit so the wiring is
// covered end-to-end.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { addEpic, advanceEpic, setEpicReady } from "../../../src/core/epic.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-epic-events-"));
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  closeDatabase(db);
  // Team-lead member so advanceEpic→review dispatch path succeeds.
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({
      name: "epic-events-test",
      members: [{ name: "lead", role: "team-lead" }],
    }),
  );
});
afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

/** Read every row from the `events` table — used by every test to
 *  assert the post-call emission shape. Returns parsed payloads
 *  sorted by emitted_at_sec to make assertions order-independent. */
function readEvents(): Array<{
  topic: string;
  payload: Record<string, unknown>;
}> {
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  try {
    const rows = db
      .prepare("SELECT topic, payload FROM events ORDER BY emitted_at_sec ASC, event_id ASC")
      .all() as Array<{ topic: string; payload: string }>;
    return rows.map((r) => ({
      topic: r.topic,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }));
  } finally {
    closeDatabase(db);
  }
}

async function walkToDone(id: string): Promise<void> {
  await advanceEpic(atmuxDir, id, "ready");
  await advanceEpic(atmuxDir, id, "in-progress");
  await advanceEpic(atmuxDir, id, "review");
  await advanceEpic(atmuxDir, id, "done");
}

describe("epic.unblocked emission (advanceEpic→done)", () => {
  test("2-epic chain: A deps_on B; advancing B→done emits ONE epic.unblocked for A", async () => {
    const b = await addEpic(atmuxDir, { title: "B" });
    const a = await addEpic(atmuxDir, { title: "A", dependsOn: [b] });
    await walkToDone(b);
    const events = readEvents().filter((e) => e.topic === "epic.unblocked");
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.payload.epicId).toBe(a);
    expect(ev?.payload.byEpicId).toBe(b);
    expect(typeof ev?.payload.transitionedAt).toBe("number");
  });

  test("3-epic chain: A deps_on [B,C], C already done; advancing B→done emits ONE epic.unblocked for A", async () => {
    const b = await addEpic(atmuxDir, { title: "B" });
    const c = await addEpic(atmuxDir, { title: "C" });
    await walkToDone(c);
    // C done now; clear any unblocked event triggered by C's transition
    // (none should fire because A doesn't exist yet — created next).
    const beforeA = readEvents().filter((e) => e.topic === "epic.unblocked").length;
    const a = await addEpic(atmuxDir, { title: "A", dependsOn: [b, c] });
    // Now advance B to done — A's last unmet dep clears.
    await walkToDone(b);
    const events = readEvents().filter((e) => e.topic === "epic.unblocked");
    expect(events.length - beforeA).toBe(1);
    const ev = events[events.length - 1];
    expect(ev?.payload.epicId).toBe(a);
    expect(ev?.payload.byEpicId).toBe(b);
  });

  test("multi-affected: D + A both depend on B; advancing B→done emits TWO epic.unblocked events", async () => {
    const b = await addEpic(atmuxDir, { title: "B" });
    const a = await addEpic(atmuxDir, { title: "A", dependsOn: [b] });
    const d = await addEpic(atmuxDir, { title: "D", dependsOn: [b] });
    await walkToDone(b);
    const events = readEvents().filter((e) => e.topic === "epic.unblocked");
    expect(events).toHaveLength(2);
    const ids = events.map((e) => e.payload.epicId as string).sort();
    expect(ids).toEqual([a, d].sort());
    for (const ev of events) {
      expect(ev.payload.byEpicId).toBe(b);
    }
  });

  test("partial-unblock guard: A deps_on [B,C] both planning; B→done emits NO epic.unblocked", async () => {
    const b = await addEpic(atmuxDir, { title: "B" });
    const c = await addEpic(atmuxDir, { title: "C" });
    await addEpic(atmuxDir, { title: "A", dependsOn: [b, c] });
    // C stays planning; B goes to done.
    await walkToDone(b);
    const events = readEvents().filter((e) => e.topic === "epic.unblocked");
    expect(events).toHaveLength(0);
  });

  test("no downstream: advancing a leaf epic→done emits no epic.unblocked", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    await walkToDone(a);
    const events = readEvents().filter((e) => e.topic === "epic.unblocked");
    expect(events).toHaveLength(0);
  });

  test("non-done transitions (planning→ready, ready→in-progress, in-progress→review) emit no epic.unblocked", async () => {
    const b = await addEpic(atmuxDir, { title: "B" });
    await addEpic(atmuxDir, { title: "A", dependsOn: [b] });
    await advanceEpic(atmuxDir, b, "ready");
    await advanceEpic(atmuxDir, b, "in-progress");
    await advanceEpic(atmuxDir, b, "review");
    const events = readEvents().filter((e) => e.topic === "epic.unblocked");
    expect(events).toHaveLength(0);
  });

  test("epic.unblocked is NOT gated on isReady (dep-graph event regardless of operator kick-off)", async () => {
    const b = await addEpic(atmuxDir, { title: "B" });
    const a = await addEpic(atmuxDir, { title: "A", dependsOn: [b] });
    // A is NOT ready; advancing B should still emit unblocked.
    expect((await readEvents()).filter((e) => e.topic === "epic.unblocked")).toHaveLength(0);
    await walkToDone(b);
    const events = readEvents().filter((e) => e.topic === "epic.unblocked");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.epicId).toBe(a);
  });
});

describe("epic.ready emission (setEpicReady)", () => {
  test("0→1 transition emits ONE epic.ready event", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    await setEpicReady(atmuxDir, a, true);
    const events = readEvents().filter((e) => e.topic === "epic.ready");
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.payload.epicId).toBe(a);
    expect(typeof ev?.payload.transitionedAt).toBe("number");
  });

  test("1→1 noop emits NO epic.ready event", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    await setEpicReady(atmuxDir, a, true);
    const before = readEvents().filter((e) => e.topic === "epic.ready").length;
    await setEpicReady(atmuxDir, a, true);
    const after = readEvents().filter((e) => e.topic === "epic.ready").length;
    expect(after - before).toBe(0);
  });

  test("1→0 downgrade emits NO epic.ready event (silent downgrade per ADR-225)", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    await setEpicReady(atmuxDir, a, true);
    const before = readEvents().filter((e) => e.topic === "epic.ready").length;
    await setEpicReady(atmuxDir, a, false);
    const after = readEvents().filter((e) => e.topic === "epic.ready").length;
    expect(after - before).toBe(0);
  });

  test("0→0 noop emits NO epic.ready event", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    // 0→0 same value path.
    await setEpicReady(atmuxDir, a, false);
    const events = readEvents().filter((e) => e.topic === "epic.ready");
    expect(events).toHaveLength(0);
  });

  test("multiple 0→1 across distinct epics each emit their own epic.ready", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    const b = await addEpic(atmuxDir, { title: "B" });
    await setEpicReady(atmuxDir, a, true);
    await setEpicReady(atmuxDir, b, true);
    const events = readEvents().filter((e) => e.topic === "epic.ready");
    expect(events).toHaveLength(2);
    const ids = events.map((e) => e.payload.epicId as string).sort();
    expect(ids).toEqual([a, b].sort());
  });
});

describe("ADR-225 event payload contract", () => {
  test("epic.unblocked payload carries the required ADR-225 fields", async () => {
    const b = await addEpic(atmuxDir, { title: "B" });
    const a = await addEpic(atmuxDir, { title: "A", dependsOn: [b] });
    await walkToDone(b);
    const ev = readEvents().find((e) => e.topic === "epic.unblocked");
    expect(ev).toBeDefined();
    expect(ev?.payload.topic).toBe("epic.unblocked");
    expect(ev?.payload.epicId).toBe(a);
    expect(ev?.payload.byEpicId).toBe(b);
    expect(ev?.payload.transitionedAt).toBeGreaterThan(0);
    // BasePayloadFields: eventId + emittedAtSec + schemaVersion.
    expect(typeof ev?.payload.eventId).toBe("string");
    expect(typeof ev?.payload.emittedAtSec).toBe("number");
    expect(ev?.payload.schemaVersion).toBe(1);
  });

  test("epic.ready payload carries the required ADR-225 fields", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    await setEpicReady(atmuxDir, a, true);
    const ev = readEvents().find((e) => e.topic === "epic.ready");
    expect(ev).toBeDefined();
    expect(ev?.payload.topic).toBe("epic.ready");
    expect(ev?.payload.epicId).toBe(a);
    expect(ev?.payload.transitionedAt).toBeGreaterThan(0);
    expect(typeof ev?.payload.eventId).toBe("string");
    expect(typeof ev?.payload.emittedAtSec).toBe("number");
    expect(ev?.payload.schemaVersion).toBe(1);
  });
});
