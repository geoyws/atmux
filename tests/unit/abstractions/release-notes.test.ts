// Unit tests for src/abstractions/release-notes.ts (ADR-147 §D4 / T5).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSection,
  ensureDayFile,
  resolveDayFilePath,
  SECTION_ORDER,
  spliceEntry,
} from "../../../src/abstractions/release-notes.ts";

// ---------- Path resolution ----------

describe("resolveDayFilePath", () => {
  // 2026-05-15 12:00 MYT (= 04:00Z). The MYT-day must roll cleanly even
  // when the UTC clock is on the prior day.
  const NOON_MYT_2026_05_15 = Date.UTC(2026, 4, 15, 4, 0);

  test("anchors path on MYT day, not UTC day", () => {
    // 19:00Z on 2026-05-14 = 03:00 MYT on 2026-05-15.
    const justAfterMytMidnight = Date.UTC(2026, 4, 14, 19, 0);
    expect(resolveDayFilePath(justAfterMytMidnight, { repoRoot: "/repo" })).toBe(
      "/repo/docs/release-notes/2026/05/2026-05-15.md",
    );
  });

  test("builds YYYY/MM/YYYY-MM-DD.md under repoRoot/docs/release-notes", () => {
    expect(resolveDayFilePath(NOON_MYT_2026_05_15, { repoRoot: "/proj" })).toBe(
      "/proj/docs/release-notes/2026/05/2026-05-15.md",
    );
  });

  test("falls back to process.cwd() when repoRoot omitted", () => {
    const out = resolveDayFilePath(NOON_MYT_2026_05_15);
    expect(out.endsWith("/docs/release-notes/2026/05/2026-05-15.md")).toBe(true);
    expect(out.startsWith("/")).toBe(true); // absolute
  });
});

// ---------- ensureDayFile ----------

describe("ensureDayFile", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-relnotes-"));
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const NOON_MYT_2026_05_15 = Date.UTC(2026, 4, 15, 4, 0);

  test("first call creates file with full skeleton (every H2 from SECTION_ORDER)", async () => {
    const path = await ensureDayFile(NOON_MYT_2026_05_15, { repoRoot: scratch });
    expect(path).toBe(join(scratch, "docs/release-notes/2026/05/2026-05-15.md"));
    const body = await readFile(path, "utf8");
    expect(body).toContain("# 2026-05-15");
    for (const section of SECTION_ORDER) {
      expect(body).toContain(`## ${section}`);
    }
    // Section count equals SECTION_ORDER length (no extras).
    const h2Matches = body.match(/^## /gm);
    expect(h2Matches?.length).toBe(SECTION_ORDER.length);
  });

  test("second call is a no-op — does NOT overwrite existing body", async () => {
    const path = await ensureDayFile(NOON_MYT_2026_05_15, { repoRoot: scratch });
    // Mutate the file with a marker.
    const marker = "<!-- preserved across re-ensure -->";
    const original = await readFile(path, "utf8");
    await Bun.write(path, `${original}\n${marker}\n`);
    // Re-ensure must NOT clobber.
    await ensureDayFile(NOON_MYT_2026_05_15, { repoRoot: scratch });
    const after = await readFile(path, "utf8");
    expect(after).toContain(marker);
  });

  test("returns the same absolute path on both calls", async () => {
    const a = await ensureDayFile(NOON_MYT_2026_05_15, { repoRoot: scratch });
    const b = await ensureDayFile(NOON_MYT_2026_05_15, { repoRoot: scratch });
    expect(a).toBe(b);
  });
});

// ---------- appendSection (single-team) ----------

describe("appendSection — single-team mode", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-relnotes-append-"));
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const T = Date.UTC(2026, 4, 15, 4, 0);

  test("first write creates the file via the skeleton path + inserts entry under target section", async () => {
    await appendSection(T, "Shipped (kanban→done)", "- t-aaa — first ship", {
      repoRoot: scratch,
    });
    const path = resolveDayFilePath(T, { repoRoot: scratch });
    const body = await readFile(path, "utf8");
    expect(body).toContain("# 2026-05-15");
    expect(body).toContain("## Shipped (kanban→done)");
    expect(body).toContain("- t-aaa — first ship");
    // Other sections present (skeleton applied).
    for (const s of SECTION_ORDER) {
      expect(body).toContain(`## ${s}`);
    }
  });

  test("second append to same section adds, doesn't duplicate skeleton", async () => {
    await appendSection(T, "Shipped (kanban→done)", "- t-aaa — first", { repoRoot: scratch });
    await appendSection(T, "Shipped (kanban→done)", "- t-bbb — second", { repoRoot: scratch });
    const path = resolveDayFilePath(T, { repoRoot: scratch });
    const body = await readFile(path, "utf8");
    expect(body).toContain("- t-aaa — first");
    expect(body).toContain("- t-bbb — second");
    // Exactly ONE skeleton — the H1 + each H2 appears once.
    const h1Count = (body.match(/^# 2026-05-15$/gm) ?? []).length;
    expect(h1Count).toBe(1);
    for (const s of SECTION_ORDER) {
      const re = new RegExp(`^## ${escapeRegex(s)}$`, "gm");
      expect((body.match(re) ?? []).length).toBe(1);
    }
  });

  test("entries land in target section (between its header and the next H2)", async () => {
    await appendSection(T, "Merges (branch→trunk)", "- alice → trunk @ deadbeef", {
      repoRoot: scratch,
    });
    const body = await readFile(resolveDayFilePath(T, { repoRoot: scratch }), "utf8");
    const mergesIdx = body.indexOf("## Merges (branch→trunk)");
    const entryIdx = body.indexOf("alice → trunk");
    const adrsIdx = body.indexOf("## ADRs landed");
    expect(mergesIdx).toBeGreaterThanOrEqual(0);
    expect(entryIdx).toBeGreaterThan(mergesIdx);
    expect(entryIdx).toBeLessThan(adrsIdx);
  });

  test("concurrent appends to DIFFERENT sections of same file — no corruption (race acceptance)", async () => {
    // ADR-147 §D4 §"Auto-create + idempotency" + T5 acceptance: race
    // writes must be append-safe. Drive 6 sections × 5 entries each
    // through Promise.all; afterwards every entry must be present
    // exactly once + the file must be syntactically intact.
    const tasks: Promise<void>[] = [];
    const sections = SECTION_ORDER;
    const perSection = 5;
    for (const s of sections) {
      for (let i = 0; i < perSection; i++) {
        tasks.push(appendSection(T, s, `- ${s}#${i}`, { repoRoot: scratch }));
      }
    }
    await Promise.all(tasks);
    const body = await readFile(resolveDayFilePath(T, { repoRoot: scratch }), "utf8");
    for (const s of sections) {
      for (let i = 0; i < perSection; i++) {
        const marker = `- ${s}#${i}`;
        const count = body.split(marker).length - 1;
        expect(count).toBe(1);
      }
    }
    // Skeleton still well-formed: each H2 appears exactly once.
    for (const s of sections) {
      const re = new RegExp(`^## ${escapeRegex(s)}$`, "gm");
      expect((body.match(re) ?? []).length).toBe(1);
    }
  });

  test("entries preserve insertion order within a section across serial appends", async () => {
    await appendSection(T, "ADRs landed", "- ADR-145 line", { repoRoot: scratch });
    await appendSection(T, "ADRs landed", "- ADR-146 line", { repoRoot: scratch });
    await appendSection(T, "ADRs landed", "- ADR-147 line", { repoRoot: scratch });
    const body = await readFile(resolveDayFilePath(T, { repoRoot: scratch }), "utf8");
    const idxA = body.indexOf("ADR-145 line");
    const idxB = body.indexOf("ADR-146 line");
    const idxC = body.indexOf("ADR-147 line");
    expect(idxA).toBeGreaterThan(0);
    expect(idxB).toBeGreaterThan(idxA);
    expect(idxC).toBeGreaterThan(idxB);
  });
});

// ---------- appendSection (multi-team, §D6) ----------

describe("appendSection — multi-team mode (ADR-147 §D6)", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-relnotes-multi-"));
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const T = Date.UTC(2026, 4, 15, 4, 0);

  test("two teamName-tagged appends to same section → ### atmux + ### sopx sub-sections", async () => {
    await appendSection(T, "Complaints adjudicated", "- c-aaa → epic t-eee", {
      repoRoot: scratch,
      teamName: "atmux team",
    });
    await appendSection(T, "Complaints adjudicated", "- c-bbb → wontfix", {
      repoRoot: scratch,
      teamName: "sopx team",
    });
    const body = await readFile(resolveDayFilePath(T, { repoRoot: scratch }), "utf8");
    expect(body).toContain("## Complaints adjudicated");
    expect(body).toContain("### atmux team");
    expect(body).toContain("### sopx team");
    // Entries appear under their respective sub-sections.
    const atmuxIdx = body.indexOf("### atmux team");
    const sopxIdx = body.indexOf("### sopx team");
    const cAaaIdx = body.indexOf("c-aaa");
    const cBbbIdx = body.indexOf("c-bbb");
    expect(cAaaIdx).toBeGreaterThan(atmuxIdx);
    expect(cAaaIdx).toBeLessThan(sopxIdx);
    expect(cBbbIdx).toBeGreaterThan(sopxIdx);
  });

  test("second append to same teamName subsection appends (no duplicate ### header)", async () => {
    await appendSection(T, "Shipped (kanban→done)", "- e1", {
      repoRoot: scratch,
      teamName: "atmux",
    });
    await appendSection(T, "Shipped (kanban→done)", "- e2", {
      repoRoot: scratch,
      teamName: "atmux",
    });
    const body = await readFile(resolveDayFilePath(T, { repoRoot: scratch }), "utf8");
    const subHeaderCount = (body.match(/^### atmux$/gm) ?? []).length;
    expect(subHeaderCount).toBe(1);
    expect(body).toContain("- e1");
    expect(body).toContain("- e2");
  });

  test("single-team default (no teamName) does NOT emit ### sub-section prefix", async () => {
    await appendSection(T, "Shipped (kanban→done)", "- e1", { repoRoot: scratch });
    const body = await readFile(resolveDayFilePath(T, { repoRoot: scratch }), "utf8");
    expect(body).not.toContain("###");
    expect(body).toContain("- e1");
  });

  test("mixing single-team + multi-team writes on the same section stays append-safe", async () => {
    // Realistic transition scenario: legacy single-team writes already
    // in the file, new multi-team writes adding ### subsections after.
    await appendSection(T, "Notes (optional)", "- legacy line", { repoRoot: scratch });
    await appendSection(T, "Notes (optional)", "- atmux note", {
      repoRoot: scratch,
      teamName: "atmux",
    });
    const body = await readFile(resolveDayFilePath(T, { repoRoot: scratch }), "utf8");
    expect(body).toContain("- legacy line");
    expect(body).toContain("### atmux");
    expect(body).toContain("- atmux note");
    // The legacy line lands BEFORE the new ### sub-section
    // (single-team writes target section-tail; multi-team writes
    // append AFTER existing body).
    expect(body.indexOf("- legacy line")).toBeLessThan(body.indexOf("### atmux"));
  });
});

// ---------- spliceEntry (pure) ----------

describe("spliceEntry — pure splice", () => {
  test("missing target section → appends `## <section>` block at EOF", () => {
    const body = "# 2026-05-15\n\n## Shipped (kanban→done)\n";
    const out = spliceEntry(body, "Notes (optional)", "- new note");
    expect(out).toContain("## Notes (optional)");
    expect(out).toContain("- new note");
    expect(out.indexOf("## Shipped")).toBeLessThan(out.indexOf("## Notes"));
  });

  test("multi-team + missing target section → emits `## <section>` then `### <team>` then entry", () => {
    const body = "# 2026-05-15\n";
    const out = spliceEntry(body, "Complaints adjudicated", "- c-zzz", "atmux");
    expect(out).toContain("## Complaints adjudicated");
    expect(out).toContain("### atmux");
    expect(out).toContain("- c-zzz");
    expect(out.indexOf("### atmux")).toBeGreaterThan(out.indexOf("## Complaints adjudicated"));
    expect(out.indexOf("- c-zzz")).toBeGreaterThan(out.indexOf("### atmux"));
  });

  test("section header at EOF (no trailing blank) → entry inserts below header cleanly", () => {
    const body = "# 2026-05-15\n\n## Shipped (kanban→done)";
    const out = spliceEntry(body, "Shipped (kanban→done)", "- e1");
    expect(out).toContain("- e1");
    expect(out.indexOf("## Shipped")).toBeLessThan(out.indexOf("- e1"));
  });

  test("does NOT collapse `### ` siblings into the `## ` boundary (h3 stays inside its h2)", () => {
    const body =
      "# 2026-05-15\n\n## Complaints adjudicated\n\n### atmux\n\n- c-aaa\n\n## Notes (optional)\n";
    const out = spliceEntry(body, "Complaints adjudicated", "- c-bbb", "atmux");
    // The new entry lands inside the atmux subsection, BEFORE the next H2.
    const atmuxIdx = out.indexOf("### atmux");
    const cBbbIdx = out.indexOf("c-bbb");
    const notesIdx = out.indexOf("## Notes");
    expect(cBbbIdx).toBeGreaterThan(atmuxIdx);
    expect(cBbbIdx).toBeLessThan(notesIdx);
  });
});

// ---------- helpers ----------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
