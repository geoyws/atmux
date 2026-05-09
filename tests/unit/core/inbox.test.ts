// Unit tests for src/core/inbox.ts (ADR-003 + ADR-005).
// Bash spec refs: lib/claim.sh::_atmux_inbox_move,
// lib/dispatch.sh inbox-push leg @ worktree-frozen.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUPERDOCTOR_INBOX_KEY } from "../../../src/core/common.ts";
import {
  appendDispatched,
  appendInboxMessage,
  appendPending,
  emptyInbox,
  loadInbox,
  loadInboxMessages,
  moveInProgressToDone,
  movePendingToInProgress,
  removeFromInProgress,
} from "../../../src/core/inbox.ts";
import type { InboxEntry } from "../../../src/schema/inbox.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-inbox-"));
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

const task = (id: string): InboxEntry => ({
  id,
  subject: `${id}-subject`,
  status: "todo",
  deps: [],
});

// ---------- Pure helpers ----------

describe("emptyInbox", () => {
  test("has empty pending/inProgress/done arrays", () => {
    expect(emptyInbox()).toEqual({ pending: [], inProgress: [], done: [] });
  });
});

// ---------- loadInbox ----------

describe("loadInbox", () => {
  test("missing file → empty shape", async () => {
    const i = await loadInbox(atmuxDir, "alpha");
    expect(i).toEqual({ pending: [], inProgress: [], done: [] });
  });

  test("returns parsed inbox after a write", async () => {
    await appendPending(atmuxDir, "alpha", task("t-aaaaaaaa"));
    const i = await loadInbox(atmuxDir, "alpha");
    expect(i.pending).toHaveLength(1);
    expect(i.pending[0]?.id).toBe("t-aaaaaaaa");
  });
});

// ---------- appendDispatched ----------

describe("appendDispatched — lead-side push to inProgress", () => {
  test("appends to inProgress with dispatchedAt stamped", async () => {
    await appendDispatched(atmuxDir, "alpha", task("t-aaaaaaaa"), 1_700_000_000);
    const i = await loadInbox(atmuxDir, "alpha");
    expect(i.inProgress).toHaveLength(1);
    expect(i.inProgress[0]?.dispatchedAt).toBe(1_700_000_000);
  });

  test("preserves prior inProgress entries (append, not replace)", async () => {
    await appendDispatched(atmuxDir, "alpha", task("t-aaaaaaaa"), 1);
    await appendDispatched(atmuxDir, "alpha", task("t-bbbbbbbb"), 2);
    const i = await loadInbox(atmuxDir, "alpha");
    expect(i.inProgress).toHaveLength(2);
  });
});

// ---------- appendPending ----------

describe("appendPending", () => {
  test("appends to pending without dispatchedAt by default", async () => {
    await appendPending(atmuxDir, "alpha", task("t-aaaaaaaa"));
    const i = await loadInbox(atmuxDir, "alpha");
    expect(i.pending).toHaveLength(1);
    expect(i.pending[0]?.dispatchedAt).toBeUndefined();
  });

  test("optional dispatchedAt is stamped when provided", async () => {
    await appendPending(atmuxDir, "alpha", task("t-aaaaaaaa"), 1_700_000_000);
    const i = await loadInbox(atmuxDir, "alpha");
    expect(i.pending[0]?.dispatchedAt).toBe(1_700_000_000);
  });
});

// ---------- movePendingToInProgress ----------

describe("movePendingToInProgress", () => {
  test("removes from pending + appends to inProgress with claimedAt", async () => {
    const t = task("t-aaaaaaaa");
    await appendPending(atmuxDir, "alpha", t);
    await movePendingToInProgress(atmuxDir, "alpha", t, 1_700_000_111);
    const i = await loadInbox(atmuxDir, "alpha");
    expect(i.pending).toHaveLength(0);
    expect(i.inProgress).toHaveLength(1);
    expect(i.inProgress[0]?.claimedAt).toBe(1_700_000_111);
  });

  test("idempotence: skips append when task id already in inProgress (bash claim.sh:92 parity)", async () => {
    const t = task("t-aaaaaaaa");
    // Stage: task IS in inProgress already, AND has a stale pending entry.
    await appendDispatched(atmuxDir, "alpha", t, 1);
    await appendPending(atmuxDir, "alpha", t);
    await movePendingToInProgress(atmuxDir, "alpha", t, 2);
    const i = await loadInbox(atmuxDir, "alpha");
    // Pending is cleared (so the stale entry can't re-trigger), but
    // inProgress did NOT double-up.
    expect(i.pending).toHaveLength(0);
    expect(i.inProgress).toHaveLength(1);
    // Original dispatchedAt preserved — the idempotence guard skipped
    // the append, so the original entry is untouched.
    expect(i.inProgress[0]?.dispatchedAt).toBe(1);
  });

  test("missing pending entry still appends to inProgress (defensive)", async () => {
    const t = task("t-aaaaaaaa");
    // No prior pending — claim happens against a phantom entry. Mirror
    // bash: `.pending |= map(select(.id != $id))` is a no-op on miss,
    // and the inProgress append still fires.
    await movePendingToInProgress(atmuxDir, "alpha", t, 1);
    const i = await loadInbox(atmuxDir, "alpha");
    expect(i.inProgress).toHaveLength(1);
  });
});

// ---------- moveInProgressToDone ----------

describe("moveInProgressToDone", () => {
  test("removes from inProgress + appends to done with completedAt", async () => {
    const t = task("t-aaaaaaaa");
    await appendDispatched(atmuxDir, "alpha", t, 1);
    await moveInProgressToDone(atmuxDir, "alpha", t, 999);
    const i = await loadInbox(atmuxDir, "alpha");
    expect(i.inProgress).toHaveLength(0);
    expect(i.done).toHaveLength(1);
    expect(i.done[0]?.completedAt).toBe(999);
  });

  test("done bucket accumulates (no idempotence guard, bash parity)", async () => {
    const t = task("t-aaaaaaaa");
    await appendDispatched(atmuxDir, "alpha", t, 1);
    await moveInProgressToDone(atmuxDir, "alpha", t, 100);
    // Re-add to inProgress + move-to-done again — shouldn't happen in
    // practice, but bash doesn't gate. Mirror: done has TWO entries.
    await appendDispatched(atmuxDir, "alpha", t, 2);
    await moveInProgressToDone(atmuxDir, "alpha", t, 200);
    const i = await loadInbox(atmuxDir, "alpha");
    expect(i.done).toHaveLength(2);
  });
});

// ---------- removeFromInProgress (t-e452296b drift fix) ----------

describe("removeFromInProgress", () => {
  test("removes entry by id and leaves the rest of inProgress intact", async () => {
    const a = task("t-aaaaaaaa");
    const b = task("t-bbbbbbbb");
    await appendDispatched(atmuxDir, "alpha", a, 1);
    await appendDispatched(atmuxDir, "alpha", b, 2);
    await removeFromInProgress(atmuxDir, "alpha", a.id);
    const i = await loadInbox(atmuxDir, "alpha");
    expect(i.inProgress.map((t) => t.id)).toEqual([b.id]);
  });

  test("absent id is a no-op (idempotent)", async () => {
    await appendDispatched(atmuxDir, "alpha", task("t-aaaaaaaa"), 1);
    await removeFromInProgress(atmuxDir, "alpha", "t-deadbeef");
    const i = await loadInbox(atmuxDir, "alpha");
    expect(i.inProgress).toHaveLength(1);
  });

  test("does not touch pending or done buckets", async () => {
    const t = task("t-aaaaaaaa");
    await appendPending(atmuxDir, "alpha", t);
    await appendDispatched(atmuxDir, "alpha", task("t-bbbbbbbb"), 1);
    await moveInProgressToDone(atmuxDir, "alpha", task("t-bbbbbbbb"), 1);
    // Re-add a fresh inProgress entry, then drain it.
    const c = task("t-cccccccc");
    await appendDispatched(atmuxDir, "alpha", c, 2);
    await removeFromInProgress(atmuxDir, "alpha", c.id);
    const i = await loadInbox(atmuxDir, "alpha");
    expect(i.pending.map((p) => p.id)).toEqual([t.id]);
    expect(i.inProgress).toEqual([]);
    expect(i.done.map((d) => d.id)).toEqual(["t-bbbbbbbb"]);
  });

  test("missing inbox file → empty inbox materialized, no throw", async () => {
    await removeFromInProgress(atmuxDir, "ghost", "t-aaaaaaaa");
    const i = await loadInbox(atmuxDir, "ghost");
    expect(i).toEqual({ pending: [], inProgress: [], done: [] });
  });
});

// ---------- File-shape assertions (raw JSON inspection) ----------

describe("on-disk shape", () => {
  test("file lives at .atmux/inboxes/<member>.json (bash inbox_dir parity)", async () => {
    await appendPending(atmuxDir, "alpha", task("t-aaaaaaaa"));
    const text = await readFile(join(atmuxDir, "inboxes", "alpha.json"), "utf8");
    const parsed = JSON.parse(text);
    expect(parsed.pending).toHaveLength(1);
    expect(parsed.inProgress).toEqual([]);
    expect(parsed.done).toEqual([]);
  });
});

// ---------- ADR-077 §F3: inbox_messages writer/reader ----------

describe("appendInboxMessage / loadInboxMessages — superdoctor inbox", () => {
  test("appendInboxMessage writes a row + loadInboxMessages reads it back", async () => {
    const id = await appendInboxMessage(atmuxDir, {
      member: SUPERDOCTOR_INBOX_KEY,
      sender: "atmux:lead",
      body: "the cage cycled itself again",
      kind: "heads-up",
    });
    expect(id).toBeGreaterThan(0);
    const rows = await loadInboxMessages(atmuxDir, { member: SUPERDOCTOR_INBOX_KEY });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sender).toBe("atmux:lead");
    expect(rows[0]?.body).toBe("the cage cycled itself again");
    expect(rows[0]?.kind).toBe("heads-up");
    expect(rows[0]?.member).toBe(SUPERDOCTOR_INBOX_KEY);
  });

  test("kind defaults to 'heads-up' when not supplied", async () => {
    await appendInboxMessage(atmuxDir, {
      member: SUPERDOCTOR_INBOX_KEY,
      sender: "atmux:cli",
      body: "no kind set",
    });
    const rows = await loadInboxMessages(atmuxDir, { member: SUPERDOCTOR_INBOX_KEY });
    expect(rows[0]?.kind).toBe("heads-up");
  });

  test("ts override survives round-trip — ordering by ts ASC", async () => {
    await appendInboxMessage(atmuxDir, {
      member: SUPERDOCTOR_INBOX_KEY,
      sender: "atmux:cli",
      body: "third",
      ts: 3000,
    });
    await appendInboxMessage(atmuxDir, {
      member: SUPERDOCTOR_INBOX_KEY,
      sender: "atmux:cli",
      body: "first",
      ts: 1000,
    });
    await appendInboxMessage(atmuxDir, {
      member: SUPERDOCTOR_INBOX_KEY,
      sender: "atmux:cli",
      body: "second",
      ts: 2000,
    });
    const rows = await loadInboxMessages(atmuxDir, { member: SUPERDOCTOR_INBOX_KEY });
    expect(rows.map((r) => r.body)).toEqual(["first", "second", "third"]);
  });

  test("sinceTs watermark filters older rows", async () => {
    await appendInboxMessage(atmuxDir, {
      member: SUPERDOCTOR_INBOX_KEY,
      sender: "x",
      body: "old",
      ts: 100,
    });
    await appendInboxMessage(atmuxDir, {
      member: SUPERDOCTOR_INBOX_KEY,
      sender: "x",
      body: "new",
      ts: 200,
    });
    const rows = await loadInboxMessages(atmuxDir, {
      member: SUPERDOCTOR_INBOX_KEY,
      sinceTs: 100,
    });
    expect(rows.map((r) => r.body)).toEqual(["new"]);
  });

  test("loadInboxMessages on missing state.db returns empty array (no throw)", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "atmux-inbox-fresh-"));
    try {
      const rows = await loadInboxMessages(fresh, { member: SUPERDOCTOR_INBOX_KEY });
      expect(rows).toEqual([]);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  test("messages for different members are isolated", async () => {
    await appendInboxMessage(atmuxDir, {
      member: SUPERDOCTOR_INBOX_KEY,
      sender: "x",
      body: "for superdoctor",
    });
    await appendInboxMessage(atmuxDir, {
      member: "alpha",
      sender: "x",
      body: "for alpha",
    });
    const sd = await loadInboxMessages(atmuxDir, { member: SUPERDOCTOR_INBOX_KEY });
    const alpha = await loadInboxMessages(atmuxDir, { member: "alpha" });
    expect(sd.map((r) => r.body)).toEqual(["for superdoctor"]);
    expect(alpha.map((r) => r.body)).toEqual(["for alpha"]);
  });
});
