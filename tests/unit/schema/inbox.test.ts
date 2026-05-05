// Unit tests for src/schema/inbox.ts (ADR-005, bash-shared per #12 carve-out + ADR-016).
//
// Coverage strategy: every exported schema's parse path exercised with
// minimal valid shapes + bash-on-disk shapes derived from real inboxes.
// Schemas tracked under ADR-009 §2 narrowed denominator; reviewer's
// 9-check gate enforces 100% lines + funcs.
//
// Coverage map:
//   - Inbox / InboxSchema: minimal-empty, populated, missing-section
//     rejection, forward-compat passthrough
//   - InboxEntry: minimal (id only), fully-populated (mirrors KanbanTask),
//     legacy shapes (pre-ADR-033 entries), nulls on every nullable field,
//     passthrough preserves unknown keys, integer-enforced timestamps,
//     typed-deps array
//   - Realistic inbox.json integration mirroring real bash on-disk state

import { describe, expect, test } from "bun:test";
import { Inbox, InboxEntry, InboxSchema } from "../../../src/schema/inbox.ts";

// ---------- Top-level Inbox ----------

describe("Inbox (top-level)", () => {
  test("normalized empty shape parses cleanly", () => {
    const empty = { pending: [], inProgress: [], done: [] };
    const parsed = Inbox.parse(empty);
    expect(parsed.pending).toEqual([]);
    expect(parsed.inProgress).toEqual([]);
    expect(parsed.done).toEqual([]);
  });

  test("InboxSchema is an alias for Inbox (ergonomic import)", () => {
    expect(InboxSchema).toBe(Inbox);
  });

  test("populated shape with one entry per section parses", () => {
    const populated = {
      pending: [{ id: "t-aaa00001" }],
      inProgress: [{ id: "t-aaa00002" }],
      done: [{ id: "t-aaa00003" }],
    };
    const parsed = Inbox.parse(populated);
    expect(parsed.pending).toHaveLength(1);
    expect(parsed.inProgress).toHaveLength(1);
    expect(parsed.done).toHaveLength(1);
  });

  test("missing pending section fails parse (canonical init guarantees presence)", () => {
    expect(() => Inbox.parse({ inProgress: [], done: [] })).toThrow();
  });

  test("missing inProgress section fails parse", () => {
    expect(() => Inbox.parse({ pending: [], done: [] })).toThrow();
  });

  test("missing done section fails parse", () => {
    expect(() => Inbox.parse({ pending: [], inProgress: [] })).toThrow();
  });

  test("passthrough preserves unknown top-level keys (forward-compat)", () => {
    const input = {
      pending: [],
      inProgress: [],
      done: [],
      // Hypothetical Phase-2 future field bash adds:
      futureSection: "preserved",
    };
    const parsed = Inbox.parse(input) as unknown as { futureSection: string };
    expect(parsed.futureSection).toBe("preserved");
  });
});

// ---------- InboxEntry (mirrors KanbanTask shape) ----------

describe("InboxEntry", () => {
  test("minimal: only id", () => {
    const parsed = InboxEntry.parse({ id: "t-abc12345" });
    expect(parsed.id).toBe("t-abc12345");
  });

  test("rejects empty id", () => {
    expect(() => InboxEntry.parse({ id: "" })).toThrow();
  });

  test("rejects missing id", () => {
    expect(() => InboxEntry.parse({})).toThrow();
  });

  test("fully-populated entry parses (every documented field)", () => {
    const fullEntry = {
      id: "t-864cc7fd",
      subject: "[E1/S1] BE: Extend kanban.json schema",
      body: "long body prose",
      status: "in-progress",
      owner: "gitter",
      deps: ["t-aaa00001"],
      priority: 1,
      epic: "e-cafef00d",
      story: "s-12345678",
      lane: "be",
      deliverable: "ADR-005",
      staleMin: 60,
      driverOnly: false,
      createdAt: 1777088467,
      claimedAt: 1777097207,
      completedAt: 1777102739,
      dispatchedAt: 1777088500,
      claimedFrom: null,
      createdFrom: "dispatch",
      note: "shipped successfully",
    };
    const parsed = InboxEntry.parse(fullEntry);
    expect(parsed.subject).toBe(fullEntry.subject);
    expect(parsed.deps).toEqual(["t-aaa00001"]);
    expect(parsed.lane).toBe("be");
    expect(parsed.driverOnly).toBe(false);
    expect(parsed.createdAt).toBe(1777088467);
    expect(parsed.claimedAt).toBe(1777097207);
    expect(parsed.completedAt).toBe(1777102739);
    expect(parsed.dispatchedAt).toBe(1777088500);
    expect(parsed.note).toBe("shipped successfully");
  });

  test("dispatchedAt set on dispatch-pushed inbox entry (lib/dispatch.sh:95 + siblings)", () => {
    // Inbox-only field — bash stamps it on inbox-push by 4 dispatch
    // sites (dispatch.sh:95, epic.sh:314, story.sh:384, kanban.sh:679).
    // Load-bearing for whip's stale-min anchor at whip.sh:283:
    //   (.claimedAt // .dispatchedAt // 0) as $base
    const dispatched = { id: "t-dispatched", dispatchedAt: 1777200000 };
    expect(InboxEntry.parse(dispatched).dispatchedAt).toBe(1777200000);
  });

  test("dispatchedAt enforces integer (matches claimedAt/completedAt pattern)", () => {
    expect(() => InboxEntry.parse({ id: "t-x", dispatchedAt: 1.5 })).toThrow();
  });

  test("dispatchedAt nullable for entries that haven't been dispatched", () => {
    const parsed = InboxEntry.parse({ id: "t-x", dispatchedAt: null });
    expect(parsed.dispatchedAt).toBeNull();
  });

  test("nulls accepted on every nullable field (matches bash-on-disk)", () => {
    const allNulls = {
      id: "t-null0000",
      body: null,
      owner: null,
      priority: null,
      epic: null,
      story: null,
      lane: null,
      deliverable: null,
      staleMin: null,
      claimedAt: null,
      completedAt: null,
      dispatchedAt: null,
      claimedFrom: null,
      createdFrom: null,
      note: null,
    };
    const parsed = InboxEntry.parse(allNulls);
    expect(parsed.owner).toBeNull();
    expect(parsed.completedAt).toBeNull();
    expect(parsed.note).toBeNull();
  });

  test("legacy shape with missing fields parses (pre-ADR-033, no driverOnly)", () => {
    const legacy = {
      id: "t-legacy01",
      subject: "old task",
      status: "todo",
      createdAt: 1700000000,
    };
    const parsed = InboxEntry.parse(legacy);
    expect(parsed.id).toBe("t-legacy01");
    expect(parsed.driverOnly).toBeUndefined();
  });

  test("status accepts arbitrary strings (read-permissive)", () => {
    const exotic = { id: "t-foo", status: "phase-2-future-state" };
    expect(InboxEntry.parse(exotic).status).toBe("phase-2-future-state");
  });

  test("lane accepts arbitrary strings (legacy entries beyond enum)", () => {
    const legacyLane = { id: "t-foo", lane: "deprecated-lane-name" };
    expect(InboxEntry.parse(legacyLane).lane).toBe("deprecated-lane-name");
  });

  test("passthrough preserves unknown entry keys (forward-compat)", () => {
    const withExtra = { id: "t-foo", futureField: 42 };
    const parsed = InboxEntry.parse(withExtra) as unknown as { futureField: number };
    expect(parsed.futureField).toBe(42);
  });

  test("createdAt enforces integer (bash uses date +%s, never fractional)", () => {
    expect(() => InboxEntry.parse({ id: "t-x", createdAt: 1.5 })).toThrow();
  });

  test("claimedAt enforces integer", () => {
    expect(() => InboxEntry.parse({ id: "t-x", claimedAt: 1.5 })).toThrow();
  });

  test("completedAt enforces integer", () => {
    expect(() => InboxEntry.parse({ id: "t-x", completedAt: 1.5 })).toThrow();
  });

  test("deps must be string array — number deps rejected", () => {
    expect(() => InboxEntry.parse({ id: "t-x", deps: [1, 2] })).toThrow();
  });
});

// ---------- Realistic integration ----------

describe("realistic inbox.json (parity-style integration)", () => {
  test("a member's inbox mirroring real bash on-disk state parses cleanly", () => {
    // Shape mirrors `/root/work/src/atmux/.atmux/inboxes/lead.json` with
    // representative entries: empty pending, empty inProgress, populated
    // done section (the typical post-burn-in shape for an active member).
    const realistic = {
      pending: [],
      inProgress: [],
      done: [
        {
          id: "t-864cc7fd",
          subject: "[E1/S1] BE: Extend kanban.json schema",
          body: "**LANE**: BE  ·  **STORY**: S1 schema foundations",
          status: "in-progress",
          owner: "gitter",
          deps: [],
          priority: 1,
          createdAt: 1777088467,
          claimedAt: 1777097207,
          completedAt: 1777102739,
          note: "feat(kanban): extend schema with epics/stories arrays",
        },
        {
          id: "t-2nd00001",
          subject: "another done task",
          status: "done",
          owner: "be-kanban",
          deps: ["t-864cc7fd"],
          priority: null,
          createdAt: 1777102800,
          claimedAt: 1777102900,
          completedAt: 1777103000,
        },
      ],
    };
    const parsed = Inbox.parse(realistic);
    expect(parsed.pending).toHaveLength(0);
    expect(parsed.inProgress).toHaveLength(0);
    expect(parsed.done).toHaveLength(2);
    expect(parsed.done[0]?.id).toBe("t-864cc7fd");
    expect(parsed.done[1]?.deps).toEqual(["t-864cc7fd"]);
  });

  test("post-claim transition shape (entry moved pending→inProgress with claimedAt set)", () => {
    // Simulates the state immediately after `claim.sh::_atmux_inbox_move`
    // on `pending->inProgress`: pending is now empty, inProgress has the
    // entry with claimedAt set.
    const postClaim = {
      pending: [],
      inProgress: [
        {
          id: "t-new00001",
          subject: "fresh claim",
          status: "in-progress",
          owner: "worker-be",
          deps: [],
          createdAt: 1777200000,
          claimedAt: 1777200500, // set by _atmux_inbox_move
          completedAt: null,
        },
      ],
      done: [],
    };
    const parsed = Inbox.parse(postClaim);
    expect(parsed.inProgress[0]?.claimedAt).toBe(1777200500);
    expect(parsed.inProgress[0]?.completedAt).toBeNull();
  });

  test("post-done transition shape (entry moved inProgress→done with completedAt set)", () => {
    const postDone = {
      pending: [],
      inProgress: [],
      done: [
        {
          id: "t-shipped",
          subject: "shipped",
          status: "done",
          owner: "worker-be",
          deps: [],
          createdAt: 1777200000,
          claimedAt: 1777200500,
          completedAt: 1777201000, // set by _atmux_inbox_move
          note: "completion note",
        },
      ],
    };
    const parsed = Inbox.parse(postDone);
    expect(parsed.done[0]?.completedAt).toBe(1777201000);
    expect(parsed.done[0]?.note).toBe("completion note");
  });
});
