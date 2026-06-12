// ADR-247 §D1 — `story.ready` emission tests (planner emitter).
// Phase-1 task 1 of EPIC e-cage-agile-self-sustain.
//
// Strategy mirrors tests/unit/core/epic-events.test.ts: open the events
// table directly via SQL after each advanceStory call; assert the row
// count + payload shape. The `emit()` abstraction
// (src/abstractions/events.ts) is the source of truth — we exercise the
// integration through the public core/story.ts API rather than mocking
// emit so the planning→ready wiring is covered end-to-end.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { addEpic } from "../../../src/core/epic.ts";
import { addStory, advanceStory } from "../../../src/core/story.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-story-events-"));
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  closeDatabase(db);
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({
      name: "story-events-test",
      members: [
        { name: "lead", role: "team-lead" },
        { name: "reviewer", role: "reviewer" },
        { name: "gitter", role: "gitter" },
      ],
    }),
  );
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

/** Read every row from the `events` table — used by each test to assert
 *  the post-call emission shape. */
function readEvents(): Array<{ topic: string; payload: Record<string, unknown> }> {
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

describe("story.ready emission (advanceStory planning→ready)", () => {
  test("advancing a story planning→ready emits exactly ONE story.ready", async () => {
    const eid = await addEpic(atmuxDir, { title: "Rewards" });
    const sid = await addStory(atmuxDir, { title: "Wire dispatch ping", epic: eid });

    await advanceStory(atmuxDir, sid, "ready");

    const ready = readEvents().filter((e) => e.topic === "story.ready");
    expect(ready).toHaveLength(1);
    const ev = ready[0];
    expect(ev?.payload.storyId).toBe(sid);
    expect(ev?.payload.epicId).toBe(eid);
    expect(ev?.payload.team).toBe("story-events-test");
    // No first-class lane column on a story → "misc" hint per ADR-247 §OQ3.
    expect(ev?.payload.lane).toBe("misc");
    // body carries the title for a concrete dispatch line.
    expect(ev?.payload.body).toBe("Wire dispatch ping");
    expect(typeof ev?.payload.emittedAtSec).toBe("number");
  });

  test("story.ready is fired ONCE — re-issuing --to ready (no-op) does not re-fire", async () => {
    const eid = await addEpic(atmuxDir, { title: "Points" });
    const sid = await addStory(atmuxDir, { title: "Compute points", epic: eid });

    await advanceStory(atmuxDir, sid, "ready");
    // Re-issue the same transition — story is already `ready`, so this is
    // the cur === resolved no-op early-return; no new event must land.
    await advanceStory(atmuxDir, sid, "ready");

    const ready = readEvents().filter((e) => e.topic === "story.ready");
    expect(ready).toHaveLength(1);
  });

  test("story.ready does NOT fire on later transitions (ready→in-progress)", async () => {
    const eid = await addEpic(atmuxDir, { title: "Responsive" });
    const sid = await addStory(atmuxDir, { title: "Mobile layout", epic: eid });

    await advanceStory(atmuxDir, sid, "ready");
    await advanceStory(atmuxDir, sid, "in-progress");

    // Still exactly one story.ready — the planning→ready edge only.
    const ready = readEvents().filter((e) => e.topic === "story.ready");
    expect(ready).toHaveLength(1);
  });

  test("advancing two distinct stories emits one story.ready each", async () => {
    const eid = await addEpic(atmuxDir, { title: "Rewards" });
    const s1 = await addStory(atmuxDir, { title: "Story one", epic: eid });
    const s2 = await addStory(atmuxDir, { title: "Story two", epic: eid });

    await advanceStory(atmuxDir, s1, "ready");
    await advanceStory(atmuxDir, s2, "ready");

    const ready = readEvents().filter((e) => e.topic === "story.ready");
    expect(ready).toHaveLength(2);
    expect(new Set(ready.map((e) => e.payload.storyId))).toEqual(new Set([s1, s2]));
  });
});
