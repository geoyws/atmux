// Unit tests for src/core/groom.ts (ADR-068 cutover Tier 1, P0).
//
// Strategy: per-test tmpdir as `<atmuxDir>`, seed the relevant input
// files, run the helper with `nowMs` pinned (deterministic month
// stamps), assert observable side-effects on the archive/ tree + the
// active source files. 100% narrowed coverage of every branch.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ageInboxOpenToArchive,
  archiveDecisions,
  archiveSizeCheck,
  cullBakFiles,
  flushInboxOutboxArchive,
  groomRunStampUtc,
  parseDecisionsMd,
  parseEntryTimestamp,
  parseOpenEntries,
  sliceOpenArchive,
  summarizeKanban,
  ymdStampUtc,
  ymStampUtc,
} from "../../../src/core/groom.ts";

// ---------- Time helpers ----------

// Pin to 2026-05-08 14:55 UTC (epoch 1778338500). YM stamp = "2026-05".
const RUN_MS = Date.UTC(2026, 4, 8, 14, 55, 0);

interface Env {
  atmuxDir: string;
  archiveDir: string;
}

let env: Env;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "atmux-groom-"));
  const atmuxDir = join(root, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  env = { atmuxDir, archiveDir: join(atmuxDir, "archive") };
});

afterEach(async () => {
  await rm(env.atmuxDir, { recursive: true, force: true });
  await rm(join(env.atmuxDir, ".."), { recursive: true, force: true });
});

// ---------- ymStampUtc / ymdStampUtc / groomRunStampUtc ----------

describe("UTC stamp helpers", () => {
  test("ymStampUtc pads single-digit months", () => {
    expect(ymStampUtc(Date.UTC(2026, 0, 15))).toBe("2026-01");
    expect(ymStampUtc(Date.UTC(2026, 11, 1))).toBe("2026-12");
  });

  test("ymdStampUtc pads month + day", () => {
    expect(ymdStampUtc(Date.UTC(2026, 0, 5))).toBe("2026-01-05");
    expect(ymdStampUtc(Date.UTC(2026, 11, 31))).toBe("2026-12-31");
  });

  test("groomRunStampUtc renders YYYY-MM-DD HH:MM:SS UTC", () => {
    expect(groomRunStampUtc(Date.UTC(2026, 4, 8, 7, 4, 9))).toBe("2026-05-08 07:04:09 UTC");
  });
});

// ---------- flushInboxOutboxArchive ----------

describe("flushInboxOutboxArchive", () => {
  test("returns empty when neither file exists", async () => {
    const got = await flushInboxOutboxArchive(env.atmuxDir, { nowMs: RUN_MS });
    expect(got).toEqual([]);
  });

  test("skips file with no `## Archive` section", async () => {
    await writeFile(join(env.atmuxDir, "driver-inbox.md"), "# driver-inbox\n\n## Open\n\nstuff\n");
    const got = await flushInboxOutboxArchive(env.atmuxDir, { nowMs: RUN_MS });
    expect(got).toEqual([]);
  });

  test("skips file whose archive body is blank-only", async () => {
    await writeFile(
      join(env.atmuxDir, "driver-inbox.md"),
      "# driver-inbox\n\n## Open\n\n## Archive\n\n\n",
    );
    const got = await flushInboxOutboxArchive(env.atmuxDir, { nowMs: RUN_MS });
    expect(got).toEqual([]);
  });

  test("flushes body and rebuilds active file (driver-inbox.md)", async () => {
    const src = join(env.atmuxDir, "driver-inbox.md");
    await writeFile(
      src,
      [
        "# driver-inbox",
        "",
        "## Open",
        "",
        "live entry",
        "",
        "## Archive",
        "",
        "## 13:00 MYT — old item 1",
        "body",
        "## 12:00 MYT — old item 2",
        "more body",
        "",
      ].join("\n"),
    );

    const got = await flushInboxOutboxArchive(env.atmuxDir, { nowMs: RUN_MS });
    expect(got).toHaveLength(1);
    const [r] = got;
    expect(r?.file).toBe("driver-inbox.md");
    expect(r?.destPath).toContain("driver-inbox-2026-05.md");
    expect((r?.bodyLineCount ?? 0) > 0).toBe(true);

    // Active file rebuilt — header through `## Archive` line, plus
    // a single trailing blank.
    const activeNow = await readFile(src, "utf8");
    expect(activeNow).toContain("# driver-inbox");
    expect(activeNow).toContain("## Open");
    expect(activeNow).toContain("live entry");
    expect(activeNow).toContain("## Archive");
    expect(activeNow).not.toContain("old item 1");
    expect(activeNow).not.toContain("more body");

    // Archive file received header + groom-run line + body.
    const archive = await readFile(r?.destPath ?? "", "utf8");
    expect(archive).toContain("# driver-inbox archive — 2026-05");
    expect(archive).toContain("_groom run: 2026-05-08");
    expect(archive).toContain("old item 1");
    expect(archive).toContain("old item 2");
  });

  test("appends with --- separator on second flush of same month", async () => {
    const src = join(env.atmuxDir, "driver-inbox.md");
    await writeFile(src, "# driver-inbox\n\n## Open\n\n## Archive\n\nfirst-batch\n");
    await flushInboxOutboxArchive(env.atmuxDir, { nowMs: RUN_MS });

    // Re-seed archive with new content.
    await writeFile(src, "# driver-inbox\n\n## Open\n\n## Archive\n\nsecond-batch\n");
    await flushInboxOutboxArchive(env.atmuxDir, { nowMs: RUN_MS });

    const archivePath = join(env.archiveDir, "driver-inbox-2026-05.md");
    const archive = await readFile(archivePath, "utf8");
    expect(archive.match(/first-batch/g) ?? []).toHaveLength(1);
    expect(archive.match(/second-batch/g) ?? []).toHaveLength(1);
    expect(archive).toContain("---");
  });

  test("dry-run reports without writing", async () => {
    const src = join(env.atmuxDir, "driver-inbox.md");
    await writeFile(src, "# h\n\n## Archive\n\nold\n");
    const before = await readFile(src, "utf8");
    const got = await flushInboxOutboxArchive(env.atmuxDir, {
      nowMs: RUN_MS,
      dryRun: true,
    });
    expect(got).toHaveLength(1);
    const after = await readFile(src, "utf8");
    expect(after).toBe(before);
    // archive/ is created by ensureDir but should be empty
    const entries = await readdir(env.archiveDir).catch(() => []);
    expect(entries.filter((e) => e.startsWith("driver-inbox-"))).toHaveLength(0);
  });

  test("processes both driver-inbox + lead-outbox", async () => {
    await writeFile(join(env.atmuxDir, "driver-inbox.md"), "# driver\n\n## Archive\n\nA\n");
    await writeFile(join(env.atmuxDir, "lead-outbox.md"), "# lead\n\n## Archive\n\nB\n");
    const got = await flushInboxOutboxArchive(env.atmuxDir, { nowMs: RUN_MS });
    expect(got.map((r) => r.file).sort()).toEqual(["driver-inbox.md", "lead-outbox.md"]);
  });
});

// ---------- parseDecisionsMd ----------

describe("parseDecisionsMd", () => {
  test("preamble + zero blocks", () => {
    const got = parseDecisionsMd("# atmux decisions\n\nno blocks here\n");
    expect(got.blocks).toHaveLength(0);
    expect(got.preamble).toContain("atmux decisions");
  });

  test("captures timestamp from `- **timestamp**:` line", () => {
    const text = [
      "# header",
      "",
      "### d-aaaa1111",
      "- **timestamp**: 1700000000",
      "body",
      "",
      "### d-bbbb2222",
      "- **timestamp**: 1800000000 (extra suffix tolerated)",
      "more body",
      "",
    ].join("\n");
    const got = parseDecisionsMd(text);
    expect(got.blocks).toHaveLength(2);
    expect(got.blocks[0]?.epochSec).toBe(1700000000);
    expect(got.blocks[1]?.epochSec).toBe(1800000000);
  });

  test("blocks without parseable timestamp keep epochSec=null", () => {
    const text = "### d-cccc3333\nno-timestamp body\n";
    const got = parseDecisionsMd(text);
    expect(got.blocks[0]?.epochSec).toBe(null);
  });
});

// ---------- archiveDecisions ----------

describe("archiveDecisions", () => {
  test("returns 0 when decisions.md absent", async () => {
    const got = await archiveDecisions(env.atmuxDir, { nowMs: RUN_MS });
    expect(got.staleBlocks).toBe(0);
    expect(got.destPaths).toEqual([]);
  });

  test("stale blocks route to month bucket; recent blocks kept", async () => {
    const oldEpoch = Math.floor(RUN_MS / 1000) - 60 * 86400; // 60d old
    const recentEpoch = Math.floor(RUN_MS / 1000) - 5 * 86400;
    // Map epoch back to YYYY-MM for archive bucket assertion.
    const oldYm = ymStampUtc(oldEpoch * 1000);
    const text = [
      "# atmux decisions",
      "",
      "### d-aaaa1111",
      `- **timestamp**: ${oldEpoch}`,
      "old block body",
      "",
      "### d-bbbb2222",
      `- **timestamp**: ${recentEpoch}`,
      "recent block body",
      "",
    ].join("\n");
    await writeFile(join(env.atmuxDir, "decisions.md"), text);

    const got = await archiveDecisions(env.atmuxDir, {
      nowMs: RUN_MS,
      days: 30,
    });
    expect(got.staleBlocks).toBe(1);
    expect(got.destPaths).toEqual([join(env.archiveDir, `decisions-${oldYm}.md`)]);

    const updated = await readFile(join(env.atmuxDir, "decisions.md"), "utf8");
    expect(updated).toContain("recent block body");
    expect(updated).not.toContain("old block body");

    const archive = await readFile(got.destPaths[0] ?? "", "utf8");
    expect(archive).toContain("# decisions archive — ");
    expect(archive).toContain("old block body");
  });

  test("blocks without timestamp are NEVER archived (defensive)", async () => {
    const text = "### d-aaaa1111\n(no timestamp)\nbody\n";
    await writeFile(join(env.atmuxDir, "decisions.md"), text);
    const got = await archiveDecisions(env.atmuxDir, {
      nowMs: RUN_MS,
      days: 1,
    });
    expect(got.staleBlocks).toBe(0);
  });

  test("dry-run reports without writing", async () => {
    const oldEpoch = Math.floor(RUN_MS / 1000) - 60 * 86400;
    const text = `### d-x\n- **timestamp**: ${oldEpoch}\nbody\n`;
    await writeFile(join(env.atmuxDir, "decisions.md"), text);
    const before = await readFile(join(env.atmuxDir, "decisions.md"), "utf8");
    const got = await archiveDecisions(env.atmuxDir, {
      nowMs: RUN_MS,
      days: 30,
      dryRun: true,
    });
    expect(got.staleBlocks).toBe(1);
    const after = await readFile(join(env.atmuxDir, "decisions.md"), "utf8");
    expect(after).toBe(before);
  });
});

// ---------- summarizeKanban ----------

describe("summarizeKanban", () => {
  const baseTask = (over: Record<string, unknown>) => ({
    id: "t-x",
    subject: "task",
    status: "todo",
    owner: null,
    deps: [],
    priority: null,
    epic: null,
    story: null,
    lane: null,
    deliverable: null,
    staleMin: null,
    driverOnly: false,
    createdAt: 1700000000,
    claimedAt: null,
    completedAt: null,
    claimedFrom: null,
    createdFrom: "test",
    note: null,
    ...over,
  });

  test("returns 0 when kanban.json absent", async () => {
    const got = await summarizeKanban(env.atmuxDir, { nowMs: RUN_MS });
    expect(got.removed).toBe(0);
  });

  test("removes done/cancelled tasks past threshold; keeps fresh + non-terminal", async () => {
    const cutoffMs = RUN_MS - 30 * 86400 * 1000;
    const oldDoneEpoch = Math.floor((cutoffMs - 86400 * 1000) / 1000);
    const oldYm = ymStampUtc(oldDoneEpoch * 1000);
    const recentDoneEpoch = Math.floor(RUN_MS / 1000) - 5 * 86400;
    const kanban = {
      tasks: [
        baseTask({
          id: "t-old-done",
          status: "done",
          completedAt: oldDoneEpoch,
          subject: "old done",
          owner: "alice",
        }),
        baseTask({
          id: "t-old-cancel",
          status: "cancelled",
          completedAt: oldDoneEpoch,
          subject: "old cancel",
        }),
        baseTask({
          id: "t-recent-done",
          status: "done",
          completedAt: recentDoneEpoch,
          subject: "recent done",
        }),
        baseTask({
          id: "t-todo",
          status: "todo",
          subject: "open todo",
        }),
      ],
      epics: [],
      stories: [],
    };
    await writeFile(join(env.atmuxDir, "kanban.json"), JSON.stringify(kanban, null, 2));

    const got = await summarizeKanban(env.atmuxDir, {
      nowMs: RUN_MS,
      days: 30,
    });
    expect(got.removed).toBe(2);
    expect(got.destPaths.map((p) => p.endsWith(`kanban-log-${oldYm}.md`))).toEqual([true]);

    const after = JSON.parse(await readFile(join(env.atmuxDir, "kanban.json"), "utf8"));
    const ids = (after.tasks as { id: string }[]).map((t) => t.id);
    expect(ids).toContain("t-recent-done");
    expect(ids).toContain("t-todo");
    expect(ids).not.toContain("t-old-done");
    expect(ids).not.toContain("t-old-cancel");

    const log = await readFile(got.destPaths[0] ?? "", "utf8");
    expect(log).toContain("`t-old-done`");
    expect(log).toContain("owner=alice");
    expect(log).toContain("`t-old-cancel`");
    expect(log).toContain("# kanban summary — ");

    // Backup file landed (exists before rewrite).
    const backups = (await readdir(env.atmuxDir)).filter((n) => n.startsWith("kanban.json.bak."));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  test("tasks with completedAt=0 / null are kept (defensive)", async () => {
    const kanban = {
      tasks: [
        baseTask({
          id: "t-amb",
          status: "done",
          completedAt: null,
          subject: "ambiguous",
        }),
      ],
      epics: [],
      stories: [],
    };
    await writeFile(join(env.atmuxDir, "kanban.json"), JSON.stringify(kanban));
    const got = await summarizeKanban(env.atmuxDir, { nowMs: RUN_MS });
    expect(got.removed).toBe(0);
  });

  test("dry-run reports counts without writing", async () => {
    const oldEpoch = Math.floor(RUN_MS / 1000) - 60 * 86400;
    const kanban = {
      tasks: [
        baseTask({
          id: "t-old",
          status: "done",
          completedAt: oldEpoch,
        }),
      ],
      epics: [],
      stories: [],
    };
    await writeFile(join(env.atmuxDir, "kanban.json"), JSON.stringify(kanban));
    const before = await readFile(join(env.atmuxDir, "kanban.json"), "utf8");
    const got = await summarizeKanban(env.atmuxDir, {
      nowMs: RUN_MS,
      dryRun: true,
    });
    expect(got.removed).toBe(1);
    const after = await readFile(join(env.atmuxDir, "kanban.json"), "utf8");
    expect(after).toBe(before);
  });
});

// ---------- cullBakFiles ----------

describe("cullBakFiles", () => {
  async function touch(p: string, mtimeMs: number, content = ""): Promise<void> {
    await writeFile(p, content);
    const sec = mtimeMs / 1000;
    await utimes(p, sec, sec);
  }

  test("returns [] when no bak files exist", async () => {
    const got = await cullBakFiles(env.atmuxDir, { keep: 5 });
    expect(got).toEqual([]);
  });

  test("removes oldest beyond keep=N (newest-first ordering)", async () => {
    const base = RUN_MS;
    for (let i = 0; i < 7; i++) {
      // Older mtime for higher i.
      const mt = base - i * 1000 * 60 * 60; // hourly older
      await touch(join(env.atmuxDir, `kanban.json.bak.${i}`), mt);
    }
    const got = await cullBakFiles(env.atmuxDir, { keep: 3 });
    expect(got).toHaveLength(1);
    expect(got[0]?.removed).toHaveLength(4);
    const remaining = (await readdir(env.atmuxDir)).filter((n) => n.startsWith("kanban.json.bak."));
    expect(remaining).toHaveLength(3);
    // Newest 3 (lowest i) survive.
    expect(remaining.sort()).toEqual([
      "kanban.json.bak.0",
      "kanban.json.bak.1",
      "kanban.json.bak.2",
    ]);
  });

  test("dry-run does not delete", async () => {
    for (let i = 0; i < 7; i++) {
      const mt = RUN_MS - i * 60_000;
      await touch(join(env.atmuxDir, `team.json.bak.${i}`), mt);
    }
    const got = await cullBakFiles(env.atmuxDir, {
      keep: 2,
      dryRun: true,
      families: ["team.json"],
    });
    expect(got[0]?.removed).toHaveLength(5);
    const remaining = (await readdir(env.atmuxDir)).filter((n) => n.startsWith("team.json.bak."));
    expect(remaining).toHaveLength(7);
  });

  test("skips families with count <= keep", async () => {
    await touch(join(env.atmuxDir, "kanban.json.bak.0"), RUN_MS);
    await touch(join(env.atmuxDir, "kanban.json.bak.1"), RUN_MS - 1);
    const got = await cullBakFiles(env.atmuxDir, { keep: 5 });
    expect(got).toEqual([]);
  });

  test("only operates on configured families", async () => {
    await touch(join(env.atmuxDir, "other.json.bak.0"), RUN_MS);
    await touch(join(env.atmuxDir, "other.json.bak.1"), RUN_MS - 1);
    const got = await cullBakFiles(env.atmuxDir, {
      keep: 0,
      families: ["kanban.json"],
    });
    expect(got).toEqual([]);
  });
});

// ---------- archiveSizeCheck ----------

describe("archiveSizeCheck", () => {
  test("returns [] when archive/ absent", async () => {
    const got = await archiveSizeCheck(env.atmuxDir);
    expect(got).toEqual([]);
  });

  test("returns [] when sizes are well below threshold", async () => {
    await mkdir(env.archiveDir, { recursive: true });
    await writeFile(join(env.archiveDir, "tiny-2026-05.md"), "x".repeat(100));
    const got = await archiveSizeCheck(env.atmuxDir);
    expect(got).toEqual([]);
  });

  test("warns when total exceeds archiveCap", async () => {
    await mkdir(env.archiveDir, { recursive: true });
    await writeFile(join(env.archiveDir, "big.md"), "x".repeat(5 * 1024 + 1));
    const got = await archiveSizeCheck(env.atmuxDir, {
      archiveCapBytes: 5 * 1024,
      kanbanLogCapBytes: 999_999_999,
    });
    expect(got).toHaveLength(1);
    expect(got[0]?.scope).toBe("archive");
  });

  test("warns when kanban-log total exceeds kanbanLogCap", async () => {
    await mkdir(env.archiveDir, { recursive: true });
    await writeFile(join(env.archiveDir, "kanban-log-2026-04.md"), "y".repeat(2 * 1024));
    await writeFile(join(env.archiveDir, "kanban-log-2026-05.md"), "y".repeat(2 * 1024));
    const got = await archiveSizeCheck(env.atmuxDir, {
      archiveCapBytes: 999_999_999,
      kanbanLogCapBytes: 3 * 1024,
    });
    expect(got).toHaveLength(1);
    expect(got[0]?.scope).toBe("kanban-log");
    expect(got[0]?.fileCount).toBe(2);
  });
});

// ---------- ageInboxOpenToArchive (t-82b6aed9 / c-7a308f7f) ----------
//
// Helper fixtures for the inbox-aging sub-op. RUN_MS = 2026-05-08
// 14:55 UTC = 2026-05-08 22:55 MYT. 7-day cutoff: 2026-05-01 22:55
// MYT (entries older are aged, newer are kept).

describe("sliceOpenArchive", () => {
  test("returns null when no `## Open` header present", () => {
    const text = "# title\n\nsome preamble\n\n## Archive\n- old\n";
    expect(sliceOpenArchive(text)).toBeNull();
  });

  test("slices HEAD + OPEN + ARCHIVE on canonical file", () => {
    const text = "# title\n\n## Open\n- [00:01 MYT 2026-05-08] fresh\n## Archive\n- aged\n";
    const got = sliceOpenArchive(text);
    expect(got).not.toBeNull();
    expect(got?.head).toBe("# title\n\n");
    expect(got?.openHeader).toBe("## Open\n");
    expect(got?.openBody).toBe("- [00:01 MYT 2026-05-08] fresh\n");
    expect(got?.archiveHeader).toBe("## Archive\n");
    expect(got?.archiveBody).toBe("- aged\n");
  });

  test("synthesizes archive section when missing", () => {
    const text = "## Open\n- [00:01 MYT] fresh\n";
    const got = sliceOpenArchive(text);
    expect(got).not.toBeNull();
    expect(got?.archiveHeader).toBeNull();
    expect(got?.archiveBody).toBe("");
  });
});

describe("parseEntryTimestamp", () => {
  test("parses `- [HH:MM MYT YYYY-MM-DD]` to MYT epoch seconds", () => {
    // 2026-05-08 12:00 MYT = 2026-05-08 04:00 UTC = epoch 1778299200
    const got = parseEntryTimestamp("- [12:00 MYT 2026-05-08] hi", RUN_MS);
    expect(got).toBe(1778299200);
  });

  test("today-implicit form uses nowMs MYT date", () => {
    const got = parseEntryTimestamp("- [12:00 MYT] hi", RUN_MS);
    // Same as above — RUN_MS is 2026-05-08 22:55 MYT, so today = 2026-05-08.
    expect(got).toBe(1778299200);
  });

  test("returns null on shape mismatch", () => {
    expect(parseEntryTimestamp("just plain text", RUN_MS)).toBeNull();
    expect(parseEntryTimestamp("- [bogus] hi", RUN_MS)).toBeNull();
    expect(parseEntryTimestamp("- [25:99 MYT] hi", RUN_MS)).toBeNull();
  });

  test("tolerates trailing `**member**:` suffix (lead-outbox shape)", () => {
    const got = parseEntryTimestamp("- [12:00 MYT] **whip-impl**: hi", RUN_MS);
    expect(got).toBe(1778299200);
  });
});

describe("parseOpenEntries", () => {
  test("returns [] on empty body", () => {
    expect(parseOpenEntries("", RUN_MS)).toEqual([]);
  });

  test("splits on entry-start prefix; continuation lines attach", () => {
    const body =
      "- [12:00 MYT 2026-05-08] first\n" +
      "continuation line of first\n" +
      "- [13:00 MYT 2026-05-08] second\n";
    const got = parseOpenEntries(body, RUN_MS);
    expect(got).toHaveLength(2);
    expect(got[0]?.text).toBe("- [12:00 MYT 2026-05-08] first\ncontinuation line of first\n");
    expect(got[1]?.text).toBe("- [13:00 MYT 2026-05-08] second\n");
  });

  test("entry-start without parseable timestamp records null epochSec", () => {
    const body = "- [malformed] hi\n- [12:00 MYT] ok\n";
    const got = parseOpenEntries(body, RUN_MS);
    expect(got).toHaveLength(2);
    expect(got[0]?.epochSec).toBeNull();
    expect(got[1]?.epochSec).not.toBeNull();
  });
});

describe("ageInboxOpenToArchive", () => {
  test("no files present → empty result", async () => {
    const got = await ageInboxOpenToArchive(env.atmuxDir, 7, { nowMs: RUN_MS });
    expect(got).toEqual([]);
  });

  test("file without `## Open` is skipped (no entry returned)", async () => {
    await writeFile(
      join(env.atmuxDir, "driver-inbox.md"),
      "# title\n\nfree-form preamble\n",
    );
    const got = await ageInboxOpenToArchive(env.atmuxDir, 7, { nowMs: RUN_MS });
    expect(got).toEqual([]);
  });

  // Fixture A: all-fresh — every entry stays in ## Open; no writes.
  test("all-fresh fixture: no aging, file unchanged", async () => {
    const src = join(env.atmuxDir, "driver-inbox.md");
    const original =
      "# driver-inbox\n\n## Open\n" +
      "- [22:00 MYT 2026-05-08] fresh-A\n" +
      "- [10:00 MYT 2026-05-08] fresh-B\n" +
      "## Archive\n" +
      "- [00:00 MYT 2026-01-01] old-archive-row\n";
    await writeFile(src, original);
    const got = await ageInboxOpenToArchive(env.atmuxDir, 7, { nowMs: RUN_MS });
    expect(got).toHaveLength(1);
    expect(got[0]?.file).toBe("driver-inbox.md");
    expect(got[0]?.agedCount).toBe(0);
    expect(got[0]?.remainingOpen).toBe(2);
    // No aged entries → no write triggered.
    expect(await readFile(src, "utf8")).toBe(original);
  });

  // Fixture B: all-stale — every entry ages.
  test("all-stale fixture: every entry → ## Archive (newest-at-top)", async () => {
    const src = join(env.atmuxDir, "lead-outbox.md");
    await writeFile(
      src,
      "# lead-outbox\n\n## Open\n" +
        "- [09:00 MYT 2026-04-01] **whip-impl**: stale-A\n" +
        "- [10:00 MYT 2026-04-02] **lead**: stale-B\n" +
        "## Archive\n" +
        "- [12:00 MYT 2026-03-01] **gitter**: existing-archive\n",
    );
    const got = await ageInboxOpenToArchive(env.atmuxDir, 7, { nowMs: RUN_MS });
    expect(got[0]?.agedCount).toBe(2);
    expect(got[0]?.remainingOpen).toBe(0);
    const after = await readFile(src, "utf8");
    expect(after).toContain("## Open\n## Archive\n");
    // Aged entries prepended to existing archive content; OPEN ordering preserved.
    expect(after.indexOf("stale-A")).toBeLessThan(after.indexOf("stale-B"));
    expect(after.indexOf("stale-B")).toBeLessThan(after.indexOf("existing-archive"));
  });

  // Fixture C: mixed + entries-without-timestamps.
  test("mixed fixture: only stale-with-timestamp ages; unparseable kept", async () => {
    const src = join(env.atmuxDir, "driver-inbox.md");
    await writeFile(
      src,
      "## Open\n" +
        "- [22:00 MYT 2026-05-08] fresh\n" +
        "- [09:00 MYT 2026-04-01] stale\n" +
        "- no-timestamp-prefix\n" +
        "- [malformed] also-no-timestamp\n" +
        "## Archive\n",
    );
    const got = await ageInboxOpenToArchive(env.atmuxDir, 7, { nowMs: RUN_MS });
    // 4 entry-start matches by the `- [` prefix parser; only 1 has stale timestamp.
    // "- no-timestamp-prefix" does NOT start with `- [` so it's treated as
    // a continuation of the preceding entry (the stale one), not its own row.
    expect(got[0]?.agedCount).toBe(1);
    const after = await readFile(src, "utf8");
    expect(after).toContain("fresh");
    expect(after.indexOf("stale")).toBeGreaterThan(after.indexOf("## Archive"));
    // Unparseable-timestamp row stays in ## Open (conservative rule).
    expect(after.indexOf("- [malformed]")).toBeLessThan(after.indexOf("## Archive"));
  });

  // Fixture D: aggressive (--inbox-days 0).
  test("aggressive (days=0) ages everything in ## Open regardless of timestamp", async () => {
    const src = join(env.atmuxDir, "driver-inbox.md");
    await writeFile(
      src,
      "## Open\n" +
        "- [22:00 MYT 2026-05-08] today\n" +
        "- [malformed] no-time\n" +
        "## Archive\n",
    );
    const got = await ageInboxOpenToArchive(env.atmuxDir, 0, { nowMs: RUN_MS });
    expect(got[0]?.agedCount).toBe(2);
    expect(got[0]?.remainingOpen).toBe(0);
    const after = await readFile(src, "utf8");
    expect(after).toContain("## Open\n## Archive\n");
    expect(after.indexOf("today")).toBeGreaterThan(after.indexOf("## Archive"));
    expect(after.indexOf("no-time")).toBeGreaterThan(after.indexOf("## Archive"));
  });

  test("aggressive option flag matches days=0 behaviour", async () => {
    const src = join(env.atmuxDir, "lead-outbox.md");
    await writeFile(
      src,
      "## Open\n- [22:00 MYT 2026-05-08] **lead**: today\n## Archive\n",
    );
    const got = await ageInboxOpenToArchive(env.atmuxDir, 7, {
      aggressive: true,
      nowMs: RUN_MS,
    });
    expect(got[0]?.agedCount).toBe(1);
    const after = await readFile(src, "utf8");
    expect(after.indexOf("today")).toBeGreaterThan(after.indexOf("## Archive"));
  });

  test("dryRun does not mutate file", async () => {
    const src = join(env.atmuxDir, "driver-inbox.md");
    const original =
      "## Open\n- [09:00 MYT 2026-04-01] stale\n## Archive\n";
    await writeFile(src, original);
    const got = await ageInboxOpenToArchive(env.atmuxDir, 7, {
      dryRun: true,
      nowMs: RUN_MS,
    });
    expect(got[0]?.agedCount).toBe(1);
    expect(await readFile(src, "utf8")).toBe(original);
  });

  test("synthesizes `## Archive` header when missing", async () => {
    const src = join(env.atmuxDir, "driver-inbox.md");
    await writeFile(src, "## Open\n- [09:00 MYT 2026-04-01] stale\n");
    const got = await ageInboxOpenToArchive(env.atmuxDir, 7, { nowMs: RUN_MS });
    expect(got[0]?.agedCount).toBe(1);
    const after = await readFile(src, "utf8");
    expect(after).toContain("## Archive\n");
    expect(after.indexOf("stale")).toBeGreaterThan(after.indexOf("## Archive"));
  });
});
