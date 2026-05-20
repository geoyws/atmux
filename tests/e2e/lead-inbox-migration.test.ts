// ADR-198 EPIC e-af5650db T7 — cross-verb integration coverage for the
// driver-inbox.md → lead-inbox.md rename. T1's read-shim + T2's walker
// each have dedicated unit suites that prove their internal contracts;
// this file exercises the cross-cutting interactions a real fleet sees:
//
//   - Walker pulls cages out of a real LoadedCockpit shape (teams +
//     nested epic-team) and applies the migration sequentially.
//   - readLeadInbox (T1 shim) sees the same view before AND after the
//     walker runs, with the legacyPresent flag flipping at the right
//     boundary.
//   - The lead-inbox-legacy doctor probe self-clears once the walker
//     completes per cage.
//   - Walker exits 0 on a fully-noop run (idempotent re-application
//     is the steady-state contract).
//
// Per memory `feedback_pause_bun_tests`: integration tests get
// `--timeout 120000` at the harness level; this file's bun-test calls
// run quickly (filesystem-only, no subprocess) but live under
// tests/e2e/ for the broader timeout budget.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadedCockpit } from "../../src/core/cockpit.ts";
import { driverInboxLegacyPath, leadInboxPath } from "../../src/core/common.ts";
import { readLeadInbox } from "../../src/core/lead-inbox.ts";
import { checkLeadInboxLegacy } from "../../src/verbs/doctor.ts";
import { migrateLeadInbox } from "../../src/verbs/migrate-lead-inbox.ts";

// Pin "now" so undated entries don't drift the test across MYT day
// boundaries (mirrors the strategy in tests/unit/core/lead-inbox.test.ts).
// 2026-05-20 12:00 MYT == 2026-05-20 04:00 UTC == epoch 1779336000.
const NOW_EPOCH_SEC = 1779336000;

/**
 * Build a fake on-disk cage layout for an end-to-end migration scenario.
 *
 * Returns three cage roots:
 *   - `parentRoot` — a `type: "team"` cage with **legacy-only** state
 *     (driver-inbox.md present, no canonical). Walker should rename.
 *   - `siblingRoot` — a sibling `type: "team"` cage with **canonical-only**
 *     state. Walker should noop.
 *   - `epicCageRoot` — a `type: "epic-team"` cage under
 *     `<parentRoot>-epics/<epicId>/` with **both files present** (mid-
 *     rollout race). Walker should merge by mtime.
 */
async function buildFleet(): Promise<{
  fleetRoot: string;
  parentRoot: string;
  siblingRoot: string;
  epicCageRoot: string;
  parentAtmux: string;
  siblingAtmux: string;
  epicAtmux: string;
  cockpit: LoadedCockpit;
}> {
  const fleetRoot = await mkdtemp(join(tmpdir(), "atmux-leadinbox-e2e-"));
  const parentRoot = join(fleetRoot, "atmux");
  const siblingRoot = join(fleetRoot, "unum");
  const epicId = "e-deadbeef";
  const epicCageRoot = join(`${parentRoot}-epics`, epicId);

  const parentAtmux = join(parentRoot, ".atmux");
  const siblingAtmux = join(siblingRoot, ".atmux");
  const epicAtmux = join(epicCageRoot, ".atmux");
  for (const d of [parentAtmux, siblingAtmux, epicAtmux]) {
    await mkdir(d, { recursive: true });
  }

  // parentRoot: legacy-only — walker should rename.
  await writeFile(
    driverInboxLegacyPath(parentAtmux),
    "# Driver Inbox\n## Open\n- [09:00 MYT] parent legacy ask\n",
  );

  // siblingRoot: canonical-only — walker should noop.
  await writeFile(
    leadInboxPath(siblingAtmux),
    "# Lead Inbox\n## Open\n- [11:00 MYT] sibling canonical ask\n",
  );

  // epicCageRoot: BOTH files present — walker should merge by mtime.
  // Write legacy first, then canonical, so canonical is newer by mtime.
  // Walker should land canonical-first ordering: canonical block first,
  // legacy block second (newer goes last in append-only stream).
  // Actually per T2 spec: older content goes first (append-only narrative
  // — newer at tail). So mtime(legacy) < mtime(canonical) → legacy-first.
  await writeFile(
    driverInboxLegacyPath(epicAtmux),
    "# Driver Inbox\n## Open\n- [08:00 MYT] epic legacy ask\n",
  );
  // Force a measurable mtime gap so the order is deterministic.
  await new Promise((res) => setTimeout(res, 25));
  await writeFile(
    leadInboxPath(epicAtmux),
    "# Lead Inbox\n## Open\n- [10:00 MYT] epic canonical ask\n",
  );

  const cockpit: LoadedCockpit = {
    schemaVersion: 1,
    cockpitSession: "atmux_cockpit",
    sessions: [
      {
        type: "team",
        name: "atmux",
        root: parentRoot,
        enabled: true,
        sessions: [
          {
            type: "epic-team",
            name: epicId,
            parent: "atmux",
            epicId,
            enabled: true,
            sessions: [],
          },
        ],
      },
      {
        type: "team",
        name: "unum",
        root: siblingRoot,
        enabled: true,
        sessions: [],
      },
    ],
    teams: [
      { name: "atmux", root: parentRoot, enabled: true },
      { name: "unum", root: siblingRoot, enabled: true },
    ],
  };

  return {
    fleetRoot,
    parentRoot,
    siblingRoot,
    epicCageRoot,
    parentAtmux,
    siblingAtmux,
    epicAtmux,
    cockpit,
  };
}

describe("ADR-198 EPIC e-af5650db T7 — cross-verb integration (walker + read-shim + doctor)", () => {
  let fleet: Awaited<ReturnType<typeof buildFleet>>;
  let stdoutBuf: string[];
  let stderrBuf: string[];

  beforeEach(async () => {
    fleet = await buildFleet();
    stdoutBuf = [];
    stderrBuf = [];
  });
  afterEach(async () => {
    await rm(fleet.fleetRoot, { recursive: true, force: true });
  });

  test("pre-migration: readLeadInbox sees legacy + flags legacyPresent on parent cage", async () => {
    const parentView = await readLeadInbox(fleet.parentAtmux, NOW_EPOCH_SEC);
    expect(parentView.legacyPresent).toBe(true);
    expect(parentView.all.map((e) => e.head).join("\n")).toContain("parent legacy ask");

    const siblingView = await readLeadInbox(fleet.siblingAtmux, NOW_EPOCH_SEC);
    expect(siblingView.legacyPresent).toBe(false);
    expect(siblingView.all.map((e) => e.head).join("\n")).toContain("sibling canonical ask");

    const epicView = await readLeadInbox(fleet.epicAtmux, NOW_EPOCH_SEC);
    expect(epicView.legacyPresent).toBe(true);
    // Both blocks visible via shim.
    const epicAllText = epicView.all.map((e) => e.head).join("\n");
    expect(epicAllText).toContain("epic legacy ask");
    expect(epicAllText).toContain("epic canonical ask");
  });

  test("pre-migration: doctor probe yellow on every cage holding a legacy file", async () => {
    expect(await checkLeadInboxLegacy(fleet.parentAtmux)).toHaveLength(1);
    expect(await checkLeadInboxLegacy(fleet.siblingAtmux)).toHaveLength(0);
    expect(await checkLeadInboxLegacy(fleet.epicAtmux)).toHaveLength(1);
  });

  test("walker runs across cockpit → 3 cages, sequential, idempotent contract holds", async () => {
    const exit = await migrateLeadInbox([], {
      stdout: (s) => stdoutBuf.push(s),
      stderr: (s) => stderrBuf.push(s),
      loadCockpitFn: async () => fleet.cockpit,
    });
    expect(exit).toBe(0);

    // parent: renamed
    expect(await fileExists(driverInboxLegacyPath(fleet.parentAtmux))).toBe(false);
    expect(await fileExists(leadInboxPath(fleet.parentAtmux))).toBe(true);
    const parentText = await readFile(leadInboxPath(fleet.parentAtmux), "utf8");
    expect(parentText).toContain("parent legacy ask");

    // sibling: untouched (canonical was already there)
    expect(await fileExists(driverInboxLegacyPath(fleet.siblingAtmux))).toBe(false);
    expect(await fileExists(leadInboxPath(fleet.siblingAtmux))).toBe(true);

    // epic: merged + legacy deleted
    expect(await fileExists(driverInboxLegacyPath(fleet.epicAtmux))).toBe(false);
    const epicText = await readFile(leadInboxPath(fleet.epicAtmux), "utf8");
    expect(epicText).toContain("epic legacy ask");
    expect(epicText).toContain("epic canonical ask");
    // Older entry first (legacy mtime < canonical mtime → legacy-first).
    expect(epicText.indexOf("epic legacy ask")).toBeLessThan(
      epicText.indexOf("epic canonical ask"),
    );

    // Migration log written for non-noop actions.
    const parentLog = await readFile(join(fleet.parentAtmux, "logs", "migration.log"), "utf8");
    expect(parentLog).toContain('"action":"rename"');
    const epicLog = await readFile(join(fleet.epicAtmux, "logs", "migration.log"), "utf8");
    expect(epicLog).toContain('"action":"merge-delete"');
    // Sibling is noop → no log file should be written.
    expect(await fileExists(join(fleet.siblingAtmux, "logs", "migration.log"))).toBe(false);
  });

  test("post-migration: doctor probe self-clears on all cages", async () => {
    await migrateLeadInbox([], {
      stdout: () => {},
      stderr: () => {},
      loadCockpitFn: async () => fleet.cockpit,
    });
    expect(await checkLeadInboxLegacy(fleet.parentAtmux)).toEqual([]);
    expect(await checkLeadInboxLegacy(fleet.siblingAtmux)).toEqual([]);
    expect(await checkLeadInboxLegacy(fleet.epicAtmux)).toEqual([]);
  });

  test("post-migration: readLeadInbox sees canonical-only view; legacyPresent=false", async () => {
    await migrateLeadInbox([], {
      stdout: () => {},
      stderr: () => {},
      loadCockpitFn: async () => fleet.cockpit,
    });
    const parentView = await readLeadInbox(fleet.parentAtmux, NOW_EPOCH_SEC);
    expect(parentView.legacyPresent).toBe(false);
    expect(parentView.all.map((e) => e.head).join("\n")).toContain("parent legacy ask");

    const epicView = await readLeadInbox(fleet.epicAtmux, NOW_EPOCH_SEC);
    expect(epicView.legacyPresent).toBe(false);
    const epicAllText = epicView.all.map((e) => e.head).join("\n");
    expect(epicAllText).toContain("epic legacy ask");
    expect(epicAllText).toContain("epic canonical ask");
  });

  test("walker re-run after migration is fully idempotent (all noop, exit 0, no new log rows)", async () => {
    // First pass — applies changes.
    await migrateLeadInbox([], {
      stdout: () => {},
      stderr: () => {},
      loadCockpitFn: async () => fleet.cockpit,
    });
    const parentLogBefore = await readFile(
      join(fleet.parentAtmux, "logs", "migration.log"),
      "utf8",
    );
    const epicLogBefore = await readFile(join(fleet.epicAtmux, "logs", "migration.log"), "utf8");

    // Second pass — should noop on every cage.
    const stdout2: string[] = [];
    const stderr2: string[] = [];
    const exit2 = await migrateLeadInbox([], {
      stdout: (s) => stdout2.push(s),
      stderr: (s) => stderr2.push(s),
      loadCockpitFn: async () => fleet.cockpit,
    });
    expect(exit2).toBe(0);

    const parentLogAfter = await readFile(join(fleet.parentAtmux, "logs", "migration.log"), "utf8");
    const epicLogAfter = await readFile(join(fleet.epicAtmux, "logs", "migration.log"), "utf8");
    // Log files must not grow on a noop pass — that's the durable
    // idempotency contract per ADR-198 §Decision-anchor #3.
    expect(parentLogAfter).toBe(parentLogBefore);
    expect(epicLogAfter).toBe(epicLogBefore);
  });

  test("--dry-run across the same fleet: no disk mutation, doctor still yellow", async () => {
    const exit = await migrateLeadInbox(["--dry-run"], {
      stdout: () => {},
      stderr: () => {},
      loadCockpitFn: async () => fleet.cockpit,
    });
    expect(exit).toBe(0);
    // Legacy files still present where they were pre-run.
    expect(await fileExists(driverInboxLegacyPath(fleet.parentAtmux))).toBe(true);
    expect(await fileExists(driverInboxLegacyPath(fleet.epicAtmux))).toBe(true);
    // No log files created on a dry-run pass.
    expect(await fileExists(join(fleet.parentAtmux, "logs", "migration.log"))).toBe(false);
    // Doctor still surfaces the residue.
    expect((await checkLeadInboxLegacy(fleet.parentAtmux)).length).toBe(1);
    expect((await checkLeadInboxLegacy(fleet.epicAtmux)).length).toBe(1);
  });

  test("--json report enumerates every cage with action + cageLabel", async () => {
    await migrateLeadInbox(["--json"], {
      stdout: (s) => stdoutBuf.push(s),
      stderr: (s) => stderrBuf.push(s),
      loadCockpitFn: async () => fleet.cockpit,
    });
    const joined = stdoutBuf.join("");
    const report = JSON.parse(joined);
    expect(report.dryRun).toBe(false);
    // 3 cages discovered (atmux team + unum team + atmux's epic-team).
    expect(report.summary.total).toBe(3);
    expect(report.summary.renamed).toBe(1);
    expect(report.summary.merged).toBe(1);
    expect(report.summary.skipped).toBe(1);
    expect(report.summary.errors).toBe(0);
    const cageLabels = report.results.map((r: { cageLabel: string }) => r.cageLabel);
    expect(cageLabels).toContain("team:atmux");
    expect(cageLabels).toContain("team:unum");
    expect(cageLabels).toContain("epic-team:atmux::e-deadbeef");
  });
});

async function fileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}
