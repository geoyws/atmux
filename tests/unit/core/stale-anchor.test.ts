// Unit tests for src/core/stale-anchor.ts (ADR-057 §D2d).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCursor } from "../../../src/core/driver-inbox.ts";
import { checkStaleAnchor } from "../../../src/core/stale-anchor.ts";

const NOW_EPOCH_SEC = 1778126400; // 2026-05-07 12:00 MYT

const setMtime = async (path: string, epochSec: number): Promise<void> => {
  await utimes(path, epochSec, epochSec);
};

describe("checkStaleAnchor", () => {
  let teamDir: string;
  let atmuxDir: string;
  let inboxPath: string;

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-stale-anchor-"));
    atmuxDir = join(teamDir, ".atmux");
    inboxPath = join(atmuxDir, "driver-inbox.md");
    await mkdir(atmuxDir, { recursive: true });
    await mkdir(join(atmuxDir, "state"), { recursive: true });
  });
  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true });
  });

  test("absent driver-inbox → no fire", async () => {
    const v = await checkStaleAnchor({ atmuxDir, nowEpochSec: NOW_EPOCH_SEC });
    expect(v.fire).toBe(false);
    expect(v.bullet).toBeNull();
  });

  test("absent cursor → no fire (lead never opened)", async () => {
    await writeFile(inboxPath, "## 09:00 MYT — entry\nbody");
    const v = await checkStaleAnchor({ atmuxDir, nowEpochSec: NOW_EPOCH_SEC });
    expect(v.fire).toBe(false);
  });

  test("cursor caught up to mtime → no fire", async () => {
    await writeFile(inboxPath, "## 09:00 MYT — entry\nbody");
    // mtime = now-1h → lag is 1h, threshold 2h → not stale
    await setMtime(inboxPath, NOW_EPOCH_SEC - 3600);
    await writeCursor(atmuxDir, NOW_EPOCH_SEC - 3600);
    const v = await checkStaleAnchor({ atmuxDir, nowEpochSec: NOW_EPOCH_SEC });
    expect(v.fire).toBe(false);
    expect(v.cursorLagSec).toBe(0);
  });

  test("cursor stale, but no unread entries after the gate → no fire", async () => {
    const statePath = join(atmuxDir, "state", "whip-stale-anchor-state.json");

    // Cursor at 09:00 MYT today (1778115600). The inbox tip is older than the cursor,
    // but the file mtime is 12:00 MYT, so lag = 3h > staleSec and the stale gate opens.
    await writeFile(inboxPath, "## 08:30 MYT — already read\nbody");
    await setMtime(inboxPath, NOW_EPOCH_SEC);
    await writeCursor(atmuxDir, 1778115600); // 09:00 MYT today

    const v = await checkStaleAnchor({ atmuxDir, nowEpochSec: NOW_EPOCH_SEC });
    expect(v).toEqual({
      fire: false,
      bullet: null,
      tipHash: null,
      unreadCount: 0,
      cursorLagSec: 3 * 3600,
    });
    await expect(Bun.file(statePath).exists()).resolves.toBe(false);
  });

  test("cursor stale + unread entries → fires once with bullet", async () => {
    const text = `## 09:00 MYT — old entry
old body
## 11:00 MYT — newer entry
newer body`;
    await writeFile(inboxPath, text);
    // mtime = now (12:00 MYT) → freshly written
    await setMtime(inboxPath, NOW_EPOCH_SEC);
    // cursor 4h behind → stale (>2h threshold)
    await writeCursor(atmuxDir, NOW_EPOCH_SEC - 4 * 3600);

    const v = await checkStaleAnchor({ atmuxDir, nowEpochSec: NOW_EPOCH_SEC });
    expect(v.fire).toBe(true);
    expect(v.bullet).toContain("📍");
    expect(v.bullet).toContain("4h behind tip");
    expect(v.bullet).toContain("2 unread");
    expect(v.tipHash).not.toBeNull();
    expect(v.cursorLagSec).toBeGreaterThanOrEqual(4 * 3600);
  });

  test("dedup: re-firing with same tip hash → no fire on second tick", async () => {
    const text = `## 09:00 MYT — old\n## 11:00 MYT — newer`;
    await writeFile(inboxPath, text);
    await setMtime(inboxPath, NOW_EPOCH_SEC);
    await writeCursor(atmuxDir, NOW_EPOCH_SEC - 4 * 3600);

    const v1 = await checkStaleAnchor({ atmuxDir, nowEpochSec: NOW_EPOCH_SEC });
    expect(v1.fire).toBe(true);

    const v2 = await checkStaleAnchor({ atmuxDir, nowEpochSec: NOW_EPOCH_SEC + 60 });
    expect(v2.fire).toBe(false); // dedup
    expect(v2.tipHash).toBe(v1.tipHash);
    expect(v2.unreadCount).toBe(2);
  });

  test("re-fires when tip hash changes (new tip arrived)", async () => {
    await writeFile(inboxPath, "## 09:00 MYT — old\n## 11:00 MYT — first tip");
    await setMtime(inboxPath, NOW_EPOCH_SEC);
    await writeCursor(atmuxDir, NOW_EPOCH_SEC - 4 * 3600);
    const v1 = await checkStaleAnchor({ atmuxDir, nowEpochSec: NOW_EPOCH_SEC });
    expect(v1.fire).toBe(true);

    // Add a new tip — hash changes.
    await writeFile(
      inboxPath,
      "## 09:00 MYT — old\n## 11:00 MYT — first tip\n## 11:30 MYT — second tip",
    );
    await setMtime(inboxPath, NOW_EPOCH_SEC);
    const v2 = await checkStaleAnchor({ atmuxDir, nowEpochSec: NOW_EPOCH_SEC + 60 });
    expect(v2.fire).toBe(true);
    expect(v2.tipHash).not.toBe(v1.tipHash);
  });

  test("staleSec override (e.g. 5min) tightens the gate", async () => {
    await writeFile(inboxPath, "## 09:00 MYT — old\n## 11:55 MYT — newer");
    await setMtime(inboxPath, NOW_EPOCH_SEC);
    // cursor 30min behind file mtime → 30min > 5min threshold → stale.
    // 11:55 MYT epoch = 1778126100 — newer than the cursor below.
    await writeCursor(atmuxDir, NOW_EPOCH_SEC - 30 * 60);
    const v = await checkStaleAnchor({
      atmuxDir,
      nowEpochSec: NOW_EPOCH_SEC,
      staleSec: 300,
    });
    expect(v.fire).toBe(true);
  });

  test("staleSec override (e.g. 24h) loosens the gate", async () => {
    await writeFile(inboxPath, "## 09:00 MYT — old");
    await setMtime(inboxPath, NOW_EPOCH_SEC);
    await writeCursor(atmuxDir, NOW_EPOCH_SEC - 3 * 3600); // 3h behind
    const v = await checkStaleAnchor({
      atmuxDir,
      nowEpochSec: NOW_EPOCH_SEC,
      staleSec: 24 * 3600, // 24h threshold → not stale yet
    });
    expect(v.fire).toBe(false);
  });

  test("empty file → no fire", async () => {
    await writeFile(inboxPath, "");
    await setMtime(inboxPath, NOW_EPOCH_SEC);
    await writeCursor(atmuxDir, NOW_EPOCH_SEC - 4 * 3600);
    const v = await checkStaleAnchor({ atmuxDir, nowEpochSec: NOW_EPOCH_SEC });
    expect(v.fire).toBe(false);
  });

  test("corrupt state file ignored (treated as 'never fired')", async () => {
    await writeFile(inboxPath, "## 09:00 MYT — old\n## 11:00 MYT — newer");
    await setMtime(inboxPath, NOW_EPOCH_SEC);
    await writeCursor(atmuxDir, NOW_EPOCH_SEC - 4 * 3600);
    await writeFile(join(atmuxDir, "state", "whip-stale-anchor-state.json"), "garbage{");
    const v = await checkStaleAnchor({ atmuxDir, nowEpochSec: NOW_EPOCH_SEC });
    expect(v.fire).toBe(true);
  });

  test("partial state file (missing fields) ignored", async () => {
    await writeFile(inboxPath, "## 09:00 MYT — old\n## 11:00 MYT — newer");
    await setMtime(inboxPath, NOW_EPOCH_SEC);
    await writeCursor(atmuxDir, NOW_EPOCH_SEC - 4 * 3600);
    await writeFile(
      join(atmuxDir, "state", "whip-stale-anchor-state.json"),
      JSON.stringify({ lastFiredHash: 42 }), // wrong type
    );
    const v = await checkStaleAnchor({ atmuxDir, nowEpochSec: NOW_EPOCH_SEC });
    expect(v.fire).toBe(true);
  });
});
