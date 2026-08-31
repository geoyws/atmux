// Unit tests for src/lib/needs-approval.ts (ADR-085 §Scan API).
//
// Coverage strategy
// -----------------
// Every bucket scanner driven through `ScanDeps` injection — no real fs,
// no real SQLite. The default impls are surfaced too (`defaultScanFs` +
// `defaultClock` + `defaultScanKanban`) so the trio is reachable for any
// integration test that wants the real surface.
//
// Bucket A (ADR): all 4 status keywords + deferred suffix exclusion +
//   no-status passthrough + heading extraction fallback + both adr dirs.
// Bucket B (inbox): 4 triage markers + non-triage emoji rejection +
//   body-window cutoff + undated-entry always-surface + stale-min gate.
// Bucket C (kanban): claimedAt-then-createdAt fallback + stale-min gate
//   + non-blocked exclusion + null-timestamp drop.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultClock,
  defaultScanFs,
  defaultScanKanban,
  type NeedsApprovalReport,
  projectRootFromAtmuxDir,
  type ScanFs,
  type ScanKanban,
  scanBlockedTasks,
  scanInboxAsks,
  scanNeedsApproval,
  scanProposedAdrs,
} from "../../../src/lib/needs-approval.ts";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { KanbanRepo } from "../../../src/core/repositories/kanban-repo.ts";
import type { KanbanTask } from "../../../src/schema/kanban.ts";

// ---------- Test helpers ----------

interface FakeFsSeed {
  /** Map abs path → directory listing (file names). Absent dir → `null`. */
  dirs?: Record<string, string[]>;
  /** Map abs path → file text. Absent file → `null`. */
  files?: Record<string, string>;
  /** Map abs path → mtime epoch seconds. Defaults to NOW - 60min if file
   *  exists but no explicit entry. */
  mtimes?: Record<string, number>;
  /** Reference epoch seconds for mtime defaults. */
  nowSec: number;
}

function fakeFs(seed: FakeFsSeed): ScanFs {
  return {
    async listDir(path: string): Promise<string[] | null> {
      return seed.dirs?.[path] ?? null;
    },
    async readText(path: string): Promise<string | null> {
      return seed.files?.[path] ?? null;
    },
    async mtimeSec(path: string): Promise<number | null> {
      if (seed.mtimes?.[path] !== undefined) return seed.mtimes[path] ?? null;
      if (seed.files?.[path] !== undefined) return seed.nowSec - 3600;
      return null;
    },
  };
}

function fakeKanban(rows: KanbanTask[]): ScanKanban {
  return {
    async listBlocked(): Promise<KanbanTask[]> {
      return rows.filter((t) => t.status === "blocked");
    },
  };
}

const ROOT = "/proj";
const NOW = 1_700_000_000; // 2023-11-14T22:13:20Z — stable test anchor

// ---------- scanProposedAdrs (bucket A) ----------

describe("scanProposedAdrs", () => {
  test("surfaces all 4 status keywords (proposed/draft/wip/pending)", async () => {
    const adrDir = `${ROOT}/docs/adr`;
    const fs = fakeFs({
      nowSec: NOW,
      dirs: { [adrDir]: ["001-a.md", "002-b.md", "003-c.md", "004-d.md"] },
      files: {
        [`${adrDir}/001-a.md`]: "# Title A\n\n**Status**: proposed\n",
        [`${adrDir}/002-b.md`]: "# Title B\n\n**Status**: draft\n",
        [`${adrDir}/003-c.md`]: "# Title C\n\n**Status**: wip\n",
        [`${adrDir}/004-d.md`]: "# Title D\n\n**Status**: pending\n",
      },
    });
    const rows = await scanProposedAdrs(ROOT, fs, () => NOW);
    expect(rows.map((r) => r.id).sort()).toEqual(["001-a", "002-b", "003-c", "004-d"]);
    for (const r of rows) {
      expect(r.bucket).toBe("adr");
      expect(r.subject).toMatch(/^Title /);
    }
  });

  test("excludes `(deferred: <reason>)` suffix entries", async () => {
    const adrDir = `${ROOT}/docs/adr`;
    const fs = fakeFs({
      nowSec: NOW,
      dirs: { [adrDir]: ["live.md", "deferred.md"] },
      files: {
        [`${adrDir}/live.md`]: "# Live\n\n**Status**: proposed\n",
        [`${adrDir}/deferred.md`]:
          "# Deferred\n\n**Status**: proposed (deferred: needs UX review)\n",
      },
    });
    const rows = await scanProposedAdrs(ROOT, fs, () => NOW);
    expect(rows.map((r) => r.id)).toEqual(["live"]);
  });

  test("ignores ADRs with `accepted` / `superseded` / no-status", async () => {
    const adrDir = `${ROOT}/docs/adr`;
    const fs = fakeFs({
      nowSec: NOW,
      dirs: { [adrDir]: ["a.md", "b.md", "c.md"] },
      files: {
        [`${adrDir}/a.md`]: "# A\n\n**Status**: accepted\n",
        [`${adrDir}/b.md`]: "# B\n\n**Status**: superseded by ADR-099\n",
        [`${adrDir}/c.md`]: "# C\n\n(no status field)\n",
      },
    });
    const rows = await scanProposedAdrs(ROOT, fs, () => NOW);
    expect(rows).toEqual([]);
  });

  test("scans BOTH docs/adr and docs/adr-bun", async () => {
    const fs = fakeFs({
      nowSec: NOW,
      dirs: {
        [`${ROOT}/docs/adr`]: ["001-main.md"],
        [`${ROOT}/docs/adr-bun`]: ["001-bun.md"],
      },
      files: {
        [`${ROOT}/docs/adr/001-main.md`]: "# Main\n\n**Status**: proposed\n",
        [`${ROOT}/docs/adr-bun/001-bun.md`]: "# Bun\n\n**Status**: proposed\n",
      },
    });
    const rows = await scanProposedAdrs(ROOT, fs, () => NOW);
    expect(rows.map((r) => r.id).sort()).toEqual(["001-bun", "001-main"]);
  });

  test("missing adr-bun dir doesn't break the scan", async () => {
    const adrDir = `${ROOT}/docs/adr`;
    const fs = fakeFs({
      nowSec: NOW,
      dirs: { [adrDir]: ["001-x.md"] }, // no adr-bun entry — listDir → null
      files: {
        [`${adrDir}/001-x.md`]: "# X\n\n**Status**: proposed\n",
      },
    });
    const rows = await scanProposedAdrs(ROOT, fs, () => NOW);
    expect(rows.map((r) => r.id)).toEqual(["001-x"]);
  });

  test("ageMin computed from mtime when present", async () => {
    const adrDir = `${ROOT}/docs/adr`;
    const fs = fakeFs({
      nowSec: NOW,
      dirs: { [adrDir]: ["aged.md"] },
      files: { [`${adrDir}/aged.md`]: "# Aged\n\n**Status**: proposed\n" },
      mtimes: { [`${adrDir}/aged.md`]: NOW - 7200 }, // 2 hours old
    });
    const rows = await scanProposedAdrs(ROOT, fs, () => NOW);
    expect(rows[0]?.ageMin).toBe(120);
  });

  test("falls back to filename slug when no `# ` heading present", async () => {
    const adrDir = `${ROOT}/docs/adr`;
    const fs = fakeFs({
      nowSec: NOW,
      dirs: { [adrDir]: ["099-no-heading.md"] },
      files: { [`${adrDir}/099-no-heading.md`]: "**Status**: proposed\n(body...)\n" },
    });
    const rows = await scanProposedAdrs(ROOT, fs, () => NOW);
    expect(rows[0]?.subject).toBe("no-heading");
  });

  test("truncates subject to ≤80 chars with ellipsis", async () => {
    const adrDir = `${ROOT}/docs/adr`;
    const longTitle = `Z${"a".repeat(120)}`;
    const fs = fakeFs({
      nowSec: NOW,
      dirs: { [adrDir]: ["long.md"] },
      files: { [`${adrDir}/long.md`]: `# ${longTitle}\n\n**Status**: proposed\n` },
    });
    const rows = await scanProposedAdrs(ROOT, fs, () => NOW);
    expect(rows[0]?.subject.length).toBeLessThanOrEqual(80);
    expect(rows[0]?.subject.endsWith("…")).toBe(true);
  });
});

// ---------- scanInboxAsks (bucket B) ----------

describe("scanInboxAsks", () => {
  const INBOX = `${ROOT}/.atmux/driver-inbox.md`;

  /** Build a heading 45 min ago, so it's past the 30-min stale threshold. */
  function staleTime(now: number): string {
    const ms = (now - 45 * 60) * 1000;
    const d = new Date(ms + 8 * 3600 * 1000); // shift to MYT
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  test("missing inbox file → empty", async () => {
    const fs = fakeFs({ nowSec: NOW });
    const rows = await scanInboxAsks(ROOT, fs, () => NOW);
    expect(rows).toEqual([]);
  });

  test("untriaged stale heading surfaces", async () => {
    const t = staleTime(NOW);
    const body = `## ${t} MYT — needs review please\nbody line one\n`;
    const fs = fakeFs({ nowSec: NOW, files: { [INBOX]: body } });
    const rows = await scanInboxAsks(ROOT, fs, () => NOW);
    expect(rows.length).toBe(1);
    expect(rows[0]?.bucket).toBe("inbox");
    expect(rows[0]?.subject).toContain("needs review");
    expect(rows[0]?.ageMin).toBeGreaterThanOrEqual(INBOX_STALE_TRIPWIRE);
  });

  test.each([
    ["✅", "check-mark"],
    ["📤", "dispatched"],
    ["⏳", "in-flight"],
    ["❌", "rejected"],
  ])("triage marker %s in heading suppresses entry (%s)", async (marker) => {
    const t = staleTime(NOW);
    const body = `## ${t} MYT — old ask ${marker}\nbody\n`;
    const fs = fakeFs({ nowSec: NOW, files: { [INBOX]: body } });
    const rows = await scanInboxAsks(ROOT, fs, () => NOW);
    expect(rows).toEqual([]);
  });

  test.each([
    ["✅", "check"],
    ["📤", "dispatched"],
    ["⏳", "inflight"],
    ["❌", "rejected"],
  ])("triage marker %s in first 20 body lines suppresses entry (%s)", async (marker) => {
    const t = staleTime(NOW);
    const body = `## ${t} MYT — old ask\nfirst line\n${marker} triaged\n`;
    const fs = fakeFs({ nowSec: NOW, files: { [INBOX]: body } });
    const rows = await scanInboxAsks(ROOT, fs, () => NOW);
    expect(rows).toEqual([]);
  });

  test("🚨 and 🪫 do NOT count as triage", async () => {
    const t = staleTime(NOW);
    const body = `## ${t} MYT — emergency 🚨\n🪫 budget pause\n`;
    const fs = fakeFs({ nowSec: NOW, files: { [INBOX]: body } });
    const rows = await scanInboxAsks(ROOT, fs, () => NOW);
    expect(rows.length).toBe(1);
  });

  test("triage marker beyond 20 non-blank body lines still surfaces (window cutoff)", async () => {
    const t = staleTime(NOW);
    // Build 22 non-blank lines with NO triage marker, then a triage line.
    // Within the INBOX_BODY_WINDOW (=20), no marker → entry surfaces.
    const padding = Array.from({ length: 22 }, (_, i) => `line ${i}`).join("\n");
    const body = `## ${t} MYT — buried\n${padding}\n✅ way down here\n`;
    const fs = fakeFs({ nowSec: NOW, files: { [INBOX]: body } });
    const rows = await scanInboxAsks(ROOT, fs, () => NOW);
    expect(rows.length).toBe(1);
  });

  test("fresh untriaged entry (≤30min) is NOT stale", async () => {
    // 10 minutes ago, no triage marker — under threshold, suppress.
    const ts = NOW - 10 * 60;
    const d = new Date((ts + 8 * 3600) * 1000);
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    const body = `## ${hh}:${mm} MYT — fresh ask\nbody\n`;
    const fs = fakeFs({ nowSec: NOW, files: { [INBOX]: body } });
    const rows = await scanInboxAsks(ROOT, fs, () => NOW);
    expect(rows).toEqual([]);
  });

  test("bullet-style heading also surfaces when stale + untriaged", async () => {
    const t = staleTime(NOW);
    const body = `- [${t} MYT] tell-lead one-liner\n`;
    const fs = fakeFs({ nowSec: NOW, files: { [INBOX]: body } });
    const rows = await scanInboxAsks(ROOT, fs, () => NOW);
    expect(rows.length).toBe(1);
    expect(rows[0]?.subject).toContain("tell-lead");
  });
});

// `INBOX_STALE_TRIPWIRE` — keep this just under the lib's constant (30)
// so the boundary test is meaningful without re-exporting the private
// const. The lib's INBOX_STALE_MIN is 30 → a stale entry must read >30.
const INBOX_STALE_TRIPWIRE = 31;

// ---------- scanBlockedTasks (bucket C) ----------

describe("scanBlockedTasks", () => {
  function task(overrides: Partial<KanbanTask>): KanbanTask {
    return {
      id: "t-test",
      subject: "test subject",
      status: "blocked",
      ...overrides,
    } as KanbanTask;
  }

  test("blocked >120min using claimedAt surfaces", async () => {
    const kanban = fakeKanban([
      task({ id: "t-old", claimedAt: NOW - 8 * 3600, createdAt: NOW - 10 * 3600 }),
    ]);
    const rows = await scanBlockedTasks(ROOT, kanban, () => NOW);
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe("t-old");
    expect(rows[0]?.bucket).toBe("kanban");
    expect(rows[0]?.ageMin).toBe(8 * 60);
  });

  test("falls back to createdAt when claimedAt is null", async () => {
    const kanban = fakeKanban([
      task({ id: "t-noclaim", claimedAt: null, createdAt: NOW - 4 * 3600 }),
    ]);
    const rows = await scanBlockedTasks(ROOT, kanban, () => NOW);
    expect(rows.length).toBe(1);
    expect(rows[0]?.ageMin).toBe(4 * 60);
  });

  test("blocked but ≤120min does NOT surface", async () => {
    const kanban = fakeKanban([
      task({ id: "t-fresh", claimedAt: NOW - 60 * 60, createdAt: NOW - 60 * 60 }),
    ]);
    const rows = await scanBlockedTasks(ROOT, kanban, () => NOW);
    expect(rows).toEqual([]);
  });

  test("non-blocked tasks excluded by the listBlocked filter", async () => {
    const kanban = fakeKanban([
      task({ id: "t-blocked", status: "blocked", claimedAt: NOW - 8 * 3600 }),
      task({ id: "t-todo", status: "todo", claimedAt: NOW - 8 * 3600 }),
      task({ id: "t-done", status: "done", claimedAt: NOW - 8 * 3600 }),
    ]);
    const rows = await scanBlockedTasks(ROOT, kanban, () => NOW);
    expect(rows.map((r) => r.id)).toEqual(["t-blocked"]);
  });

  test("blocked but no timestamps → drop (can't compute ageMin)", async () => {
    const kanban = fakeKanban([task({ id: "t-bare", claimedAt: null, createdAt: undefined })]);
    const rows = await scanBlockedTasks(ROOT, kanban, () => NOW);
    expect(rows).toEqual([]);
  });
});

// ---------- scanNeedsApproval (top-level) ----------

describe("scanNeedsApproval", () => {
  test("aggregates all three buckets + computes total", async () => {
    const adrDir = `${ROOT}/docs/adr`;
    const inbox = `${ROOT}/.atmux/driver-inbox.md`;
    const fs = fakeFs({
      nowSec: NOW,
      dirs: { [adrDir]: ["a.md"] },
      files: {
        [`${adrDir}/a.md`]: "# A\n\n**Status**: proposed\n",
        [inbox]: `## ${staleHHMM(NOW)} MYT — open question\nbody\n`,
      },
    });
    const kanban = fakeKanban([
      {
        id: "t-blocked",
        subject: "long blocked",
        status: "blocked",
        claimedAt: NOW - 8 * 3600,
      } as KanbanTask,
    ]);
    const report = await scanNeedsApproval({
      fs,
      kanban,
      clock: () => NOW,
      projectRoot: ROOT,
    });
    expect(report.adr.length).toBe(1);
    expect(report.inbox.length).toBe(1);
    expect(report.kanban.length).toBe(1);
    expect(report.total).toBe(3);
  });

  test("empty everywhere → total=0 (whip skips ping)", async () => {
    const fs = fakeFs({ nowSec: NOW });
    const kanban = fakeKanban([]);
    const report = await scanNeedsApproval({
      fs,
      kanban,
      clock: () => NOW,
      projectRoot: ROOT,
    });
    expect(report).toEqual<NeedsApprovalReport>({
      adr: [],
      inbox: [],
      kanban: [],
      total: 0,
    });
  });

  test("per-bucket failure degrades to empty (does not poison report)", async () => {
    // ADR scanner throws on readText — overall scan keeps going.
    const throwingFs: ScanFs = {
      async listDir(): Promise<string[] | null> {
        return ["x.md"];
      },
      async readText(): Promise<string | null> {
        throw new Error("disk on fire");
      },
      async mtimeSec(): Promise<number | null> {
        return null;
      },
    };
    const kanban = fakeKanban([]);
    const report = await scanNeedsApproval({
      fs: throwingFs,
      kanban,
      clock: () => NOW,
      projectRoot: ROOT,
    });
    expect(report.adr).toEqual([]);
    expect(report.total).toBe(0);
  });
});

// Helper for the top-level test — same trick as `staleTime` above but
// inlined to keep the integration block self-contained.
function staleHHMM(now: number): string {
  const ms = (now - 45 * 60) * 1000;
  const d = new Date(ms + 8 * 3600 * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// ---------- Default impls (smoke) ----------

describe("default impls", () => {
  test("defaultClock returns positive integer seconds", () => {
    const t = defaultClock();
    expect(Number.isInteger(t)).toBe(true);
    expect(t).toBeGreaterThan(0);
  });

  test("defaultScanFs.listDir on a missing dir → null (does not throw)", async () => {
    const fs = defaultScanFs();
    const got = await fs.listDir("/does/not/exist/needs-approval-test");
    expect(got).toBeNull();
  });

  test("defaultScanFs.readText on a missing file → null", async () => {
    const fs = defaultScanFs();
    expect(await fs.readText("/does/not/exist/file.md")).toBeNull();
  });

  test("defaultScanFs.mtimeSec on a missing file → null", async () => {
    const fs = defaultScanFs();
    expect(await fs.mtimeSec("/does/not/exist/file.md")).toBeNull();
  });

  test("defaultScanKanban returns the production shape (callable)", () => {
    const k = defaultScanKanban();
    expect(typeof k.listBlocked).toBe("function");
  });

  test("defaultScanKanban.listBlocked reads blocked rows from real SQLite storage", async () => {
    const atmuxDir = await mkdtemp(join(tmpdir(), "atmux-needs-approval-"));
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    try {
      const repo = new KanbanRepo(db);
      repo.addTask({
        id: "t-aaaaaaaa",
        subject: "blocked task",
        body: "",
        status: "blocked",
        owner: null,
        deps: [],
        priority: null,
        epic: null,
        story: null,
        lane: null,
        createdAt: NOW,
        claimedAt: NOW - 3600,
        completedAt: null,
      } as KanbanTask);
      repo.addTask({
        id: "t-bbbbbbbb",
        subject: "todo task",
        body: "",
        status: "todo",
        owner: null,
        deps: [],
        priority: null,
        epic: null,
        story: null,
        lane: null,
        createdAt: NOW,
        claimedAt: null,
        completedAt: null,
      } as KanbanTask);

      const rows = await defaultScanKanban().listBlocked(atmuxDir);
      expect(rows.map((row) => row.id)).toEqual(["t-aaaaaaaa"]);
      expect(rows[0]?.status).toBe("blocked");
    } finally {
      closeDatabase(db);
      await rm(atmuxDir, { recursive: true, force: true });
    }
  });

  test("scanNeedsApproval degrades kanban failures to an empty bucket", async () => {
    const rows = await scanNeedsApproval({
      fs: fakeFs({
        nowSec: NOW,
        dirs: { [`${ROOT}/docs/adr`]: ["a.md"] },
        files: {
          [`${ROOT}/docs/adr/a.md`]: "# ADR A\n\n**Status**: proposed\n",
          [`${ROOT}/.atmux/driver-inbox.md`]: `## 18:30 MYT — open question\nbody\n`,
        },
      }),
      kanban: {
        async listBlocked(): Promise<KanbanTask[]> {
          throw new Error("kanban down");
        },
      },
      clock: () => NOW,
      projectRoot: ROOT,
    });

    expect(rows.adr.map((r) => r.id)).toEqual(["a"]);
    expect(rows.inbox[0]?.subject).toContain("open question");
    expect(rows.kanban).toEqual([]);
    expect(rows.total).toBe(2);
  });
});

// ---------- ADR-085 §Decision acceptance fixtures (t-3516d73a) ----------
//
// The block above tests features one-at-a-time (one status keyword per
// case, one marker per case). These fixtures pin the literal acceptance
// counts from t-3516d73a so a future regression that double-counts /
// off-by-ones any bucket trips here even when the per-feature cases
// stay green. Each fixture mirrors ADR-085 §Decision exactly.

describe("ADR-085 acceptance — bucket A (4 ADR files → 2 entries)", () => {
  test("2 proposed (one deferred) + 1 accepted + 1 wip → 2 entries", async () => {
    const adrDir = `${ROOT}/docs/adr`;
    const fs = fakeFs({
      nowSec: NOW,
      dirs: {
        [adrDir]: ["010-a-proposed.md", "011-b-deferred.md", "012-c-accepted.md", "013-d-wip.md"],
      },
      files: {
        [`${adrDir}/010-a-proposed.md`]: "# Live proposed\n\n**Status**: proposed\n",
        [`${adrDir}/011-b-deferred.md`]:
          "# Deferred proposed\n\n**Status**: proposed (deferred: discussion)\n",
        [`${adrDir}/012-c-accepted.md`]: "# Accepted\n\n**Status**: accepted\n",
        [`${adrDir}/013-d-wip.md`]: "# Wip\n\n**Status**: wip\n",
      },
    });
    const rows = await scanProposedAdrs(ROOT, fs, () => NOW);
    expect(rows.map((r) => r.id).sort()).toEqual(["010-a-proposed", "013-d-wip"]);
    expect(rows.length).toBe(2);
    // Deferred must NOT leak — accidentally surfacing it would re-enable
    // the failure mode ADR-085 §Open questions OQ3 was carved out for.
    expect(rows.some((r) => r.id.includes("deferred"))).toBe(false);
  });
});

describe("ADR-085 acceptance — bucket B (6 headings → 1 entry)", () => {
  // Build a heading at fixed clock-vs-age offset. `ageMin` is computed
  // from (NOW - headingTimestamp) / 60; the heading's own MYT stamp is
  // derived from headingEpoch. Tests fix clock at NOW so ageMin is
  // deterministic.
  function head(ageMin: number, subject: string, headingMarker?: string): string {
    const ts = NOW - ageMin * 60;
    const d = new Date((ts + 8 * 3600) * 1000); // MYT shift
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    const marker = headingMarker !== undefined ? ` ${headingMarker}` : "";
    return `## ${hh}:${mm} MYT — ${subject}${marker}`;
  }

  test("2 inline-marked + 2 body-marked + 1 stale-31min + 1 fresh-29min → 1 entry (only 31min)", async () => {
    const inbox = `${ROOT}/.atmux/driver-inbox.md`;
    const body = [
      // Two with inline marker on the heading itself
      head(45, "ask-1-inline", "✅"),
      "  (already triaged)\n",
      head(60, "ask-2-inline", "📤"),
      "  (already dispatched)\n",
      // Two with marker in section body (within first 20 lines)
      head(50, "ask-3-body-marked"),
      "⏳ pending in flight\n",
      head(55, "ask-4-body-marked"),
      "❌ rejected — see lead-outbox.md\n",
      // One unmarked stale (31min)
      head(31, "ask-5-untriaged-stale"),
      "body line one\n",
      // One unmarked fresh (29min, under threshold)
      head(29, "ask-6-untriaged-fresh"),
      "body line one\n",
    ].join("\n");
    const fs = fakeFs({ nowSec: NOW, files: { [inbox]: body } });
    const rows = await scanInboxAsks(ROOT, fs, () => NOW);
    expect(rows.length).toBe(1);
    expect(rows[0]?.subject).toContain("ask-5-untriaged-stale");
    expect(rows[0]?.ageMin).toBe(31);
  });

  test("clock fixed at 12:00 MYT → ageMin computed correctly from heading timestamp", async () => {
    // 12:00 MYT == 04:00 UTC. Anchor NOW at that exact second.
    const noonMyt = Date.UTC(2026, 4, 14, 4, 0, 0) / 1000; // 2026-05-14 12:00 MYT
    // Heading at 11:00 MYT (60min ago) — past the 30-min threshold.
    const inbox = `${ROOT}/.atmux/driver-inbox.md`;
    const body = `## 11:00 MYT — old untriaged ask\nbody\n`;
    const fs = fakeFs({ nowSec: noonMyt, files: { [inbox]: body } });
    const rows = await scanInboxAsks(ROOT, fs, () => noonMyt);
    expect(rows.length).toBe(1);
    expect(rows[0]?.ageMin).toBe(60);
  });
});

describe("ADR-085 acceptance — bucket C (5 tasks → 2 entries)", () => {
  test("2 blocked >2h + 1 blocked <2h + 2 done → 2 entries", async () => {
    const kanban = fakeKanban([
      // 2 blocked >2h (3h and 4h)
      {
        id: "t-blocked-3h",
        subject: "long-blocked-3h",
        status: "blocked",
        claimedAt: NOW - 3 * 3600,
      } as KanbanTask,
      {
        id: "t-blocked-4h",
        subject: "long-blocked-4h",
        status: "blocked",
        claimedAt: NOW - 4 * 3600,
      } as KanbanTask,
      // 1 blocked <2h (1h, under threshold)
      {
        id: "t-blocked-1h",
        subject: "fresh-blocked",
        status: "blocked",
        claimedAt: NOW - 1 * 3600,
      } as KanbanTask,
      // 2 done (excluded by listBlocked status filter)
      {
        id: "t-done-1",
        subject: "shipped",
        status: "done",
        claimedAt: NOW - 5 * 3600,
      } as KanbanTask,
      {
        id: "t-done-2",
        subject: "shipped-2",
        status: "done",
        claimedAt: NOW - 6 * 3600,
      } as KanbanTask,
    ]);
    const rows = await scanBlockedTasks(ROOT, kanban, () => NOW);
    expect(rows.map((r) => r.id).sort()).toEqual(["t-blocked-3h", "t-blocked-4h"]);
    expect(rows.length).toBe(2);
  });
});

// needsApprovalEnabled=false suppression — verified at the CALLER (whip.ts
// gates `runNeedsApprovalCheck` on `config.needsApprovalEnabled`). The lib
// has no awareness of the team config; testing the gate at the lib level
// would test nothing meaningful. The e2e in tests/e2e/whip-needs-approval
// covers the integrated path; the unit-level assertion is that the lib
// always scans when invoked — there's no escape hatch inside the lib.
describe("ADR-085 acceptance — needsApprovalEnabled gate is caller-side", () => {
  test("lib always returns a non-null report regardless of config", async () => {
    // Sanity: even on a completely empty seed, scanNeedsApproval returns
    // {adr: [], inbox: [], kanban: [], total: 0} — not null/undefined.
    // The caller (whip.ts) is responsible for early-return on the
    // needsApprovalEnabled flag; the lib stays config-unaware.
    const fs = fakeFs({ nowSec: NOW });
    const kanban = fakeKanban([]);
    const report = await scanNeedsApproval({
      fs,
      kanban,
      clock: () => NOW,
      projectRoot: ROOT,
    });
    expect(report).not.toBeNull();
    expect(report.total).toBe(0);
  });
});

// The seam that lets a caller holding a team's `atmuxDir` scope the scan
// to THAT team instead of to whatever repo it happens to be standing in —
// which is how `atmux status --team-dir <other>` came to report the
// caller's own ADR / inbox backlog as the other team's.
describe("projectRootFromAtmuxDir — the dir that OWNS an .atmux", () => {
  test("strips the trailing .atmux segment", () => {
    expect(projectRootFromAtmuxDir("/work/src/atmux/.atmux")).toBe("/work/src/atmux");
  });

  test("tolerates a trailing slash", () => {
    expect(projectRootFromAtmuxDir("/tmp/scratch/.atmux/")).toBe("/tmp/scratch");
  });

  test("an .atmux at the filesystem root yields '/', never the empty string", () => {
    // An empty root would make every `join(projectRoot, "docs/adr")` a
    // RELATIVE path and hand the scan back to the process cwd — the exact
    // leak this helper exists to close.
    expect(projectRootFromAtmuxDir("/.atmux")).toBe("/");
  });

  test("a path that is not an .atmux dir is returned unchanged", () => {
    expect(projectRootFromAtmuxDir("/work/src/atmux")).toBe("/work/src/atmux");
  });

  test("omitting projectRoot still falls back to the cwd walk (documented default)", async () => {
    // Both production callers now pass `projectRoot` explicitly, so the
    // cwd-walk default would otherwise go unexercised — and it is part of
    // the published `ScanDeps` contract, not dead code. Assert it is
    // still reached AND that it resolves somewhere real, by recording the
    // directory the scan actually asked for.
    const asked: string[] = [];
    const fs: ScanFs = {
      async listDir(path: string) {
        asked.push(path);
        return null;
      },
      async readText() {
        return null;
      },
      async mtimeSec() {
        return null;
      },
    };
    const report = await scanNeedsApproval({ fs, kanban: fakeKanban([]), clock: () => NOW });
    expect(report.total).toBe(0);
    // It asked for `<someRoot>/docs/adr` — an absolute path, not a
    // relative one, which is what a failed resolution would produce.
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]?.startsWith("/")).toBe(true);
    expect(asked[0]?.endsWith("/docs/adr")).toBe(true);
  });
});
