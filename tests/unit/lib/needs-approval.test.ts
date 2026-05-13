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
import {
  defaultClock,
  defaultScanFs,
  defaultScanKanban,
  type NeedsApprovalReport,
  type ScanFs,
  type ScanKanban,
  scanBlockedTasks,
  scanInboxAsks,
  scanNeedsApproval,
  scanProposedAdrs,
} from "../../../src/lib/needs-approval.ts";
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
});
