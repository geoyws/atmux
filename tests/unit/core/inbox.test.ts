// Unit tests for src/core/inbox.ts (ADR-003 + ADR-005).
// Bash spec refs: lib/claim.sh::_atmux_inbox_move,
// lib/dispatch.sh inbox-push leg @ worktree-frozen.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendDispatched,
  appendPending,
  emptyInbox,
  loadInbox,
  moveInProgressToDone,
  movePendingToInProgress,
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
