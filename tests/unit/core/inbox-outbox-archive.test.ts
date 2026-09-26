// e-77 T1 (t-875eb305): shared archive-cut helper tests.
// Hermetic temp dirs; flock exercised via the real acquire().

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveFile,
  findEntries,
  parseDuration,
  planCut,
} from "../../../src/core/inbox-outbox-archive.ts";

const MYT_OFFSET = 8 * 3_600_000;

function mytEpoch(dayOffsetFromToday: number, hh: number, mm: number): number {
  const now = new Date(Date.now() + MYT_OFFSET);
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return dayStart - dayOffsetFromToday * 86_400_000 - MYT_OFFSET + (hh * 60 + mm) * 60_000;
}

const HEADER = "# Driver Inbox — driver asks for the lead\n\n## Open\n";

function inboxBody(entries: Array<[number, number, string]>): string {
  return (
    HEADER +
    entries.map(([hh, mm, msg]) => `- [${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")} MYT] ${msg}`).join("\n") +
    "\n"
  );
}

describe("parseDuration", () => {
  test("Nm/Nh/Nd", () => {
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("48h")).toBe(48 * 3_600_000);
    expect(parseDuration("7d")).toBe(7 * 86_400_000);
  });

  test("bare numeric + garbage rejected", () => {
    for (const bad of ["30", "48x", "m", "", "-5h"]) {
      expect(() => parseDuration(bad)).toThrow();
    }
  });
});

describe("findEntries", () => {
  test("same-day entries, mtime-anchored", () => {
    const mtime = mytEpoch(0, 20, 0);
    const body = inboxBody([
      [9, 0, "first"],
      [19, 30, "second"],
    ]);
    const spans = findEntries(body, mtime);
    expect(spans[0]?.at).toBe(mytEpoch(0, 9, 0));
    expect(spans[1]?.at).toBe(mytEpoch(0, 19, 30));
  });

  test("midnight rollover walks a day back", () => {
    const mtime = mytEpoch(0, 0, 30); // 00:30 MYT today
    const body = inboxBody([
      [23, 45, "yesterday"],
      [0, 15, "today"],
    ]);
    const spans = findEntries(body, mtime);
    expect(spans[0]?.at).toBe(mytEpoch(1, 23, 45));
    expect(spans[1]?.at).toBe(mytEpoch(0, 0, 15));
  });
});

describe("planCut", () => {
  test("cutoff splits old from new; head preserved verbatim", () => {
    const mtime = mytEpoch(0, 20, 0);
    const body = inboxBody([
      [9, 0, "old"],
      [9, 30, "old too"],
      [19, 0, "recent"],
    ]);
    const cut = planCut(body, mtime, 2 * 3_600_000, mytEpoch(0, 20, 0));
    expect(cut.cutAt).toBe(3);
    expect(cut.head).toBe(HEADER.trimEnd());
    expect(cut.archivedBlock.join("\n")).toContain("old");
    expect(cut.archivedBlock.join("\n")).toContain("old too");
    expect(cut.archivedBlock.join("\n")).not.toContain("recent");
    expect(cut.liveTail.join("\n")).toContain("recent");
  });

  test("nothing old → cutAt null, idempotent shape", () => {
    const mtime = mytEpoch(0, 20, 0);
    const body = inboxBody([[19, 0, "recent"]]);
    const cut = planCut(body, mtime, 48 * 3_600_000, mytEpoch(0, 20, 0));
    expect(cut.cutAt).toBeNull();
    expect(cut.archivedBlock).toHaveLength(0);
  });
});

describe("archiveFile", () => {
  function tempDir(): string {
    return mkdtempSync(join(tmpdir(), "archive-cut-"));
  }

  test("moves old entries to archive; live keeps header+recent; second run no-op", async () => {
    const dir = tempDir();
    const path = join(dir, "driver-inbox.md");
    const body = inboxBody([
      [9, 0, "ancient"],
      [19, 0, "recent"],
    ]);
    writeFileSync(path, body);
    const mtime = mytEpoch(0, 20, 0);
    const stat = async () => ({ mtimeMs: mtime });
    const now = () => mytEpoch(0, 20, 0);

    const r1 = await archiveFile(path, 2 * 3_600_000, { stat, now });
    expect(r1.entriesArchived).toBe(1);
    expect(r1.archivePath).toContain("archive/driver-inbox.md.archive-");

    const live = readFileSync(path, "utf8");
    expect(live).toContain("recent");
    expect(live).not.toContain("ancient");
    expect(live.startsWith("# Driver Inbox")).toBe(true);

    const archived = readFileSync(r1.archivePath as string, "utf8");
    expect(archived).toContain("ancient");

    const r2 = await archiveFile(path, 2 * 3_600_000, { stat, now });
    expect(r2.entriesArchived).toBe(0);
    expect(r2.archivePath).toBeNull();
  });

  test("missing file + empty file are no-ops", async () => {
    const dir = tempDir();
    const r1 = await archiveFile(join(dir, "none.md"), 1000);
    expect(r1.entriesArchived).toBe(0);
    const empty = join(dir, "empty.md");
    writeFileSync(empty, "");
    const r2 = await archiveFile(empty, 1000);
    expect(r2.entriesArchived).toBe(0);
  });
});
