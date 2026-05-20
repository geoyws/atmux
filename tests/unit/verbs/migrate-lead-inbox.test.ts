// Unit tests for src/verbs/migrate-lead-inbox.ts (ADR-198 §Decision-anchor #3).
//
// Coverage of:
//   - parseMigrateLeadInboxArgs (flag shape)
//   - migrateCageInbox idempotency branches (4 cases per AC §3)
//   - composeMergedInbox (legacy-first / canonical-first ordering,
//     header preservation, no-header fallback)
//   - discoverCageTargets (cockpit walk)
//   - migrateLeadInbox integration over 3 fake teams (per AC §6)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadedCockpit } from "../../../src/core/cockpit.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  composeMergedInbox,
  discoverCageTargets,
  migrateCageInbox,
  migrateLeadInbox,
  parseMigrateLeadInboxArgs,
} from "../../../src/verbs/migrate-lead-inbox.ts";

// ---------- parseMigrateLeadInboxArgs ----------

describe("parseMigrateLeadInboxArgs", () => {
  test("default — no flags", () => {
    expect(parseMigrateLeadInboxArgs([])).toEqual({ dryRun: false, json: false });
  });
  test("--dry-run", () => {
    expect(parseMigrateLeadInboxArgs(["--dry-run"])).toMatchObject({ dryRun: true });
  });
  test("--json", () => {
    expect(parseMigrateLeadInboxArgs(["--json"])).toMatchObject({ json: true });
  });
  test("--team-dir <dir>", () => {
    expect(parseMigrateLeadInboxArgs(["--team-dir", "/x"])).toMatchObject({ teamDir: "/x" });
  });
  test("--team-dir without value → UsageError", () => {
    expect(() => parseMigrateLeadInboxArgs(["--team-dir"])).toThrow(UsageError);
  });
  test("unknown flag → UsageError", () => {
    expect(() => parseMigrateLeadInboxArgs(["--bogus"])).toThrow(UsageError);
  });
  test("flag combinations", () => {
    expect(parseMigrateLeadInboxArgs(["--dry-run", "--json", "--team-dir", "/x"])).toEqual({
      dryRun: true,
      json: true,
      teamDir: "/x",
    });
  });
});

// ---------- migrateCageInbox: 4 idempotency branches ----------

describe("migrateCageInbox — 4 idempotency branches (ADR-198 AC §3)", () => {
  let teamDir: string;
  let atmuxDir: string;

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-migrate-cage-"));
    atmuxDir = join(teamDir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true });
  });

  test("branch 1: both files absent → noop", async () => {
    const r = await migrateCageInbox(atmuxDir, "test-cage", false);
    expect(r.action).toBe("noop-both-absent");
    expect(r.dryRun).toBe(false);
    expect(await Bun.file(join(atmuxDir, "lead-inbox.md")).exists()).toBe(false);
    expect(await Bun.file(join(atmuxDir, "driver-inbox.md")).exists()).toBe(false);
  });

  test("branch 2: only canonical present → noop", async () => {
    await writeFile(join(atmuxDir, "lead-inbox.md"), `# Lead Inbox\n## Open\n- [10:00 MYT] hi`);
    const r = await migrateCageInbox(atmuxDir, "test-cage", false);
    expect(r.action).toBe("noop-canonical-only");
    expect(await Bun.file(join(atmuxDir, "driver-inbox.md")).exists()).toBe(false);
  });

  test("branch 3: only legacy present → rename to canonical", async () => {
    const body = `# Driver Inbox\n## Open\n- [09:00 MYT] legacy ask`;
    await writeFile(join(atmuxDir, "driver-inbox.md"), body);
    const r = await migrateCageInbox(atmuxDir, "test-cage", false);
    expect(r.action).toBe("rename-legacy-to-canonical");
    expect(await Bun.file(join(atmuxDir, "driver-inbox.md")).exists()).toBe(false);
    const renamed = await Bun.file(join(atmuxDir, "lead-inbox.md")).text();
    expect(renamed).toBe(body);
    // Migration log row landed.
    const log = await Bun.file(join(atmuxDir, "logs", "migration.log")).text();
    expect(log).toContain('"action":"rename"');
  });

  test("branch 4a: both present, legacy older → legacy-first merge + delete legacy", async () => {
    const legacy = `# Driver Inbox\n## Open\n- [08:00 MYT] legacy old`;
    const canonical = `# Lead Inbox (ADR-198)\n## Open\n- [10:00 MYT] canonical newer`;
    await writeFile(join(atmuxDir, "driver-inbox.md"), legacy);
    await writeFile(join(atmuxDir, "lead-inbox.md"), canonical);
    // Bump canonical mtime forward so legacy is provably older.
    const fs = await import("node:fs/promises");
    const farPast = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    await fs.utimes(join(atmuxDir, "driver-inbox.md"), farPast, farPast);

    const r = await migrateCageInbox(atmuxDir, "test-cage", false);
    expect(r.action).toBe("merge-both-by-mtime");
    expect(r.mergeOrder).toBe("legacy-first");
    expect(await Bun.file(join(atmuxDir, "driver-inbox.md")).exists()).toBe(false);
    const merged = await Bun.file(join(atmuxDir, "lead-inbox.md")).text();
    // Both entries surface in merged content.
    expect(merged).toContain("legacy old");
    expect(merged).toContain("canonical newer");
    // Migration log row landed.
    const log = await Bun.file(join(atmuxDir, "logs", "migration.log")).text();
    expect(log).toContain('"action":"merge-delete"');
    expect(log).toContain('"mergeOrder":"legacy-first"');
  });

  test("branch 4b: both present, canonical older → canonical-first merge", async () => {
    const legacy = `# Driver Inbox\n## Open\n- [10:00 MYT] legacy newer`;
    const canonical = `# Lead Inbox\n## Open\n- [08:00 MYT] canonical older`;
    await writeFile(join(atmuxDir, "lead-inbox.md"), canonical);
    await writeFile(join(atmuxDir, "driver-inbox.md"), legacy);
    const fs = await import("node:fs/promises");
    const farPast = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(join(atmuxDir, "lead-inbox.md"), farPast, farPast);

    const r = await migrateCageInbox(atmuxDir, "test-cage", false);
    expect(r.action).toBe("merge-both-by-mtime");
    expect(r.mergeOrder).toBe("canonical-first");
    expect(await Bun.file(join(atmuxDir, "driver-inbox.md")).exists()).toBe(false);
  });

  test("dry-run: branch 3 plans rename without touching disk", async () => {
    await writeFile(join(atmuxDir, "driver-inbox.md"), `# Driver Inbox\n## Open\n- [09:00 MYT] x`);
    const r = await migrateCageInbox(atmuxDir, "test-cage", true);
    expect(r.action).toBe("rename-legacy-to-canonical");
    expect(r.dryRun).toBe(true);
    // No disk change.
    expect(await Bun.file(join(atmuxDir, "driver-inbox.md")).exists()).toBe(true);
    expect(await Bun.file(join(atmuxDir, "lead-inbox.md")).exists()).toBe(false);
  });

  test("dry-run: branch 4 plans merge without touching disk", async () => {
    await writeFile(join(atmuxDir, "driver-inbox.md"), `# Driver Inbox\n## Open\n- [10:00 MYT] x`);
    await writeFile(join(atmuxDir, "lead-inbox.md"), `# Lead Inbox\n## Open\n- [11:00 MYT] y`);
    const r = await migrateCageInbox(atmuxDir, "test-cage", true);
    expect(r.action).toBe("merge-both-by-mtime");
    expect(r.dryRun).toBe(true);
    expect(await Bun.file(join(atmuxDir, "driver-inbox.md")).exists()).toBe(true);
    expect(await Bun.file(join(atmuxDir, "lead-inbox.md")).exists()).toBe(true);
    // Log NOT written for dry-run.
    expect(await Bun.file(join(atmuxDir, "logs", "migration.log")).exists()).toBe(false);
  });

  test("ADR-198 OQ#1: symlink — legacy file symlinked to canonical → realpath collapses → noop", async () => {
    // Operator pre-created a `driver-inbox.md` symlink pointing at the
    // canonical file; both stat-as-regular but realpath sees the same
    // inode. Walker treats as already-migrated (noop).
    const canonical = join(atmuxDir, "lead-inbox.md");
    await writeFile(canonical, `# Lead Inbox\n## Open\n- [10:00 MYT] both same inode`);
    await symlink(canonical, join(atmuxDir, "driver-inbox.md"));
    const r = await migrateCageInbox(atmuxDir, "test-cage", false);
    expect(r.action).toBe("noop-canonical-only");
    // Symlink is preserved (no error); canonical untouched.
    const text = await Bun.file(canonical).text();
    expect(text).toContain("both same inode");
  });
});

// ---------- composeMergedInbox ----------

describe("composeMergedInbox — merge composer", () => {
  test("legacy-first: legacy content first, canonical header dropped from canonical block", () => {
    const legacy = `# Driver Inbox\n## Open\n- [08:00 MYT] legacy A`;
    const canonical = `# Lead Inbox (ADR-198)\n## Open\n- [10:00 MYT] canonical A`;
    const merged = composeMergedInbox(legacy, canonical, "legacy-first");
    // Single header retained at the start (legacy header).
    expect(merged).toContain("# Driver Inbox");
    // Canonical's own header isn't doubled.
    expect((merged.match(/^#\s+/gm) ?? []).length).toBe(1);
    // Both entries surface.
    expect(merged).toContain("legacy A");
    expect(merged).toContain("canonical A");
    // Legacy entry appears before canonical entry in chronological order.
    expect(merged.indexOf("legacy A")).toBeLessThan(merged.indexOf("canonical A"));
  });

  test("canonical-first: canonical content first, legacy header dropped", () => {
    const legacy = `# Driver Inbox\n## Open\n- [10:00 MYT] legacy newer`;
    const canonical = `# Lead Inbox\n## Open\n- [08:00 MYT] canonical older`;
    const merged = composeMergedInbox(legacy, canonical, "canonical-first");
    // Canonical's header retained.
    expect(merged).toContain("# Lead Inbox");
    expect((merged.match(/^#\s+/gm) ?? []).length).toBe(1);
    // Canonical-first ordering preserved.
    expect(merged.indexOf("canonical older")).toBeLessThan(merged.indexOf("legacy newer"));
  });

  test("neither block has header → prepend LEAD_INBOX_HEADER", () => {
    const a = `- [10:00 MYT] body-only A`;
    const b = `- [11:00 MYT] body-only B`;
    const merged = composeMergedInbox(a, b, "legacy-first");
    expect(merged).toContain("# Lead Inbox");
    expect(merged).toContain("body-only A");
    expect(merged).toContain("body-only B");
  });

  test("empty legacy → returns canonical content (with trailing newline)", () => {
    const canonical = `# Lead Inbox\n## Open\n- [10:00 MYT] only canonical`;
    const merged = composeMergedInbox("", canonical, "legacy-first");
    expect(merged.trim()).toBe(canonical);
  });

  test("empty canonical → returns legacy content (with trailing newline)", () => {
    const legacy = `# Driver Inbox\n## Open\n- [09:00 MYT] only legacy`;
    const merged = composeMergedInbox(legacy, "", "canonical-first");
    expect(merged.trim()).toBe(legacy);
  });
});

// ---------- discoverCageTargets ----------

describe("discoverCageTargets — cockpit walk", () => {
  test("flat team + nested epic-team → both surface", () => {
    const cockpit: LoadedCockpit = {
      version: 1,
      sessions: [
        {
          type: "team",
          name: "parent",
          root: "/work/parent",
          enabled: true,
          sessions: [
            {
              type: "epic-team",
              name: "e-abc123",
              parent: "parent",
              epicId: "e-abc123",
              enabled: true,
            },
          ],
        },
        { type: "team", name: "sibling", root: "/work/sibling", enabled: true },
      ],
      teams: [],
    } as unknown as LoadedCockpit;

    const targets = discoverCageTargets(cockpit);
    const labels = targets.map((t) => t.cageLabel);
    expect(labels).toContain("team:parent");
    expect(labels).toContain("epic-team:parent::e-abc123");
    expect(labels).toContain("team:sibling");
    const epic = targets.find((t) => t.cageLabel === "epic-team:parent::e-abc123");
    expect(epic?.atmuxDir).toBe("/work/parent-epics/e-abc123/.atmux");
  });

  test("disabled teams excluded", () => {
    const cockpit: LoadedCockpit = {
      version: 1,
      sessions: [
        { type: "team", name: "off", root: "/work/off", enabled: false },
        { type: "team", name: "on", root: "/work/on", enabled: true },
      ],
      teams: [],
    } as unknown as LoadedCockpit;
    const targets = discoverCageTargets(cockpit);
    expect(targets.map((t) => t.cageLabel)).toEqual(["team:on"]);
  });

  test("empty cockpit → zero targets", () => {
    const cockpit: LoadedCockpit = {
      version: 1,
      sessions: [],
      teams: [],
    } as unknown as LoadedCockpit;
    expect(discoverCageTargets(cockpit)).toEqual([]);
  });
});

// ---------- migrateLeadInbox: integration over 3 cages (ADR-198 AC §6) ----------

describe("migrateLeadInbox — integration walk over 3 cages", () => {
  let workspace: string;
  let cage1Root: string;
  let cage2Root: string;
  let cage3Root: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "atmux-migrate-walk-"));
    cage1Root = join(workspace, "cage1");
    cage2Root = join(workspace, "cage2");
    cage3Root = join(workspace, "cage3");
    for (const r of [cage1Root, cage2Root, cage3Root]) {
      await mkdir(join(r, ".atmux"), { recursive: true });
    }
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("3 cages, each in a different branch → walker resolves correctly + JSON report green", async () => {
    // cage1: legacy-only → expect rename
    await writeFile(
      join(cage1Root, ".atmux", "driver-inbox.md"),
      `# Driver Inbox\n## Open\n- [08:00 MYT] cage1 legacy`,
    );
    // cage2: canonical-only → expect noop-canonical-only
    await writeFile(
      join(cage2Root, ".atmux", "lead-inbox.md"),
      `# Lead Inbox\n## Open\n- [09:00 MYT] cage2 canonical`,
    );
    // cage3: both present → expect merge
    await writeFile(
      join(cage3Root, ".atmux", "driver-inbox.md"),
      `# Driver Inbox\n## Open\n- [08:00 MYT] cage3 legacy`,
    );
    await writeFile(
      join(cage3Root, ".atmux", "lead-inbox.md"),
      `# Lead Inbox\n## Open\n- [10:00 MYT] cage3 canonical`,
    );

    const cockpit: LoadedCockpit = {
      version: 1,
      sessions: [
        { type: "team", name: "cage1", root: cage1Root, enabled: true },
        { type: "team", name: "cage2", root: cage2Root, enabled: true },
        { type: "team", name: "cage3", root: cage3Root, enabled: true },
      ],
      teams: [],
    } as unknown as LoadedCockpit;

    let jsonOut = "";
    const code = await migrateLeadInbox(["--json"], {
      stdout: (s) => {
        jsonOut += s;
        return true;
      },
      loadCockpitFn: async () => cockpit,
    });
    expect(code).toBe(0);
    const report = JSON.parse(jsonOut);
    expect(report.summary).toEqual({
      total: 3,
      renamed: 1,
      merged: 1,
      skipped: 1,
      errors: 0,
    });

    // Disk state verification.
    expect(await Bun.file(join(cage1Root, ".atmux", "driver-inbox.md")).exists()).toBe(false);
    expect(await Bun.file(join(cage1Root, ".atmux", "lead-inbox.md")).exists()).toBe(true);
    expect(await Bun.file(join(cage2Root, ".atmux", "lead-inbox.md")).exists()).toBe(true);
    expect(await Bun.file(join(cage3Root, ".atmux", "driver-inbox.md")).exists()).toBe(false);
    const cage3Merged = await Bun.file(join(cage3Root, ".atmux", "lead-inbox.md")).text();
    expect(cage3Merged).toContain("cage3 legacy");
    expect(cage3Merged).toContain("cage3 canonical");
  });

  test("dry-run: no disk mutation across 3 cages + report.dryRun=true", async () => {
    await writeFile(
      join(cage1Root, ".atmux", "driver-inbox.md"),
      `# Driver Inbox\n## Open\n- [08:00 MYT] cage1 legacy`,
    );
    await writeFile(
      join(cage2Root, ".atmux", "driver-inbox.md"),
      `# Driver Inbox\n## Open\n- [09:00 MYT] cage2 legacy`,
    );
    await writeFile(
      join(cage3Root, ".atmux", "driver-inbox.md"),
      `# Driver Inbox\n## Open\n- [10:00 MYT] cage3 legacy`,
    );

    const cockpit: LoadedCockpit = {
      version: 1,
      sessions: [
        { type: "team", name: "cage1", root: cage1Root, enabled: true },
        { type: "team", name: "cage2", root: cage2Root, enabled: true },
        { type: "team", name: "cage3", root: cage3Root, enabled: true },
      ],
      teams: [],
    } as unknown as LoadedCockpit;

    let jsonOut = "";
    await migrateLeadInbox(["--dry-run", "--json"], {
      stdout: (s) => {
        jsonOut += s;
        return true;
      },
      loadCockpitFn: async () => cockpit,
    });
    const report = JSON.parse(jsonOut);
    expect(report.dryRun).toBe(true);
    expect(report.summary.renamed).toBe(3);
    // Disk untouched.
    for (const r of [cage1Root, cage2Root, cage3Root]) {
      expect(await Bun.file(join(r, ".atmux", "driver-inbox.md")).exists()).toBe(true);
      expect(await Bun.file(join(r, ".atmux", "lead-inbox.md")).exists()).toBe(false);
    }
  });

  test("re-run after migration is fully idempotent (all noop-canonical-only)", async () => {
    // Walk once to migrate cage1's legacy file.
    await writeFile(
      join(cage1Root, ".atmux", "driver-inbox.md"),
      `# Driver Inbox\n## Open\n- [08:00 MYT] only`,
    );
    const cockpit: LoadedCockpit = {
      version: 1,
      sessions: [{ type: "team", name: "cage1", root: cage1Root, enabled: true }],
      teams: [],
    } as unknown as LoadedCockpit;
    await migrateLeadInbox([], {
      stdout: () => true,
      stderr: () => true,
      loadCockpitFn: async () => cockpit,
    });
    // Second pass — should be noop everywhere.
    let json = "";
    await migrateLeadInbox(["--json"], {
      stdout: (s) => {
        json += s;
        return true;
      },
      loadCockpitFn: async () => cockpit,
    });
    const report = JSON.parse(json);
    expect(report.summary).toMatchObject({ renamed: 0, merged: 0, skipped: 1, errors: 0 });
  });

  test("--team-dir single-cage mode bypasses cockpit walk", async () => {
    await writeFile(
      join(cage1Root, ".atmux", "driver-inbox.md"),
      `# Driver Inbox\n## Open\n- [08:00 MYT] solo`,
    );
    let json = "";
    const code = await migrateLeadInbox(["--team-dir", cage1Root, "--json"], {
      stdout: (s) => {
        json += s;
        return true;
      },
      // No cockpit loader — proves --team-dir skips the walk.
      loadCockpitFn: async () => {
        throw new Error("loadCockpitFn should not be called when --team-dir is set");
      },
    });
    expect(code).toBe(0);
    const report = JSON.parse(json);
    expect(report.summary.renamed).toBe(1);
    expect(await Bun.file(join(cage1Root, ".atmux", "lead-inbox.md")).exists()).toBe(true);
  });

  test("cockpit lists a team whose .atmux/ no longer exists → skipped silently", async () => {
    // Pretend cage2 was deleted out-of-band.
    await rm(join(cage2Root, ".atmux"), { recursive: true, force: true });
    await writeFile(
      join(cage1Root, ".atmux", "driver-inbox.md"),
      `# Driver Inbox\n## Open\n- [08:00 MYT] cage1`,
    );
    const cockpit: LoadedCockpit = {
      version: 1,
      sessions: [
        { type: "team", name: "cage1", root: cage1Root, enabled: true },
        { type: "team", name: "cage2", root: cage2Root, enabled: true },
      ],
      teams: [],
    } as unknown as LoadedCockpit;
    let json = "";
    const code = await migrateLeadInbox(["--json"], {
      stdout: (s) => {
        json += s;
        return true;
      },
      loadCockpitFn: async () => cockpit,
    });
    expect(code).toBe(0);
    const report = JSON.parse(json);
    // Only cage1 was processed; cage2 was skipped (no .atmux/ on disk).
    expect(report.summary.total).toBe(1);
    expect(report.summary.renamed).toBe(1);
  });
});
