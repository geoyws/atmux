// Unit tests for the ADR-169 OQ-6 `migration-state-incomplete` doctor
// probe (src/verbs/doctor/migration-state.ts): red on migrated leftovers
// and unclassified files, silent on archived / KEEP-AS-JSON / clean.
// Pattern mirror: tests/unit/verbs/doctor-claude-accounts.test.ts —
// same pure/I-O describe split, same scratch-via-mkdtemp + cleanup.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkMigrationStateIncomplete,
  classifyMigrationStateFile,
  migrationStateIncompleteRows,
} from "../../../src/verbs/doctor/migration-state.ts";

describe("classifyMigrationStateFile (pure)", () => {
  test("flags-phase stems classify as migrated", () => {
    for (const name of [
      "paused.json",
      "resume.json",
      "pulse-state.json",
      "sentinel-state.json",
      "eternal-improvement.json",
      "whip-config-drift-state.json",
    ]) {
      expect(classifyMigrationStateFile(name)).toBe("migrated");
    }
  });

  test("role-state stems and globs classify as migrated", () => {
    for (const name of [
      "heads-up-cursor.json",
      "brief-versions.json",
      "ombudsman-pending.json",
      "cost-lead.json",
      "modal-history-driver.json",
    ]) {
      expect(classifyMigrationStateFile(name)).toBe("migrated");
    }
  });

  test("budget-phase stems classify as migrated", () => {
    for (const name of [
      "budget-pause.json",
      "budget-refresh-soon-state.json",
      "budget-warning-state.json",
    ]) {
      expect(classifyMigrationStateFile(name)).toBe("migrated");
    }
  });

  test("KEEP-AS-JSON entries classify as keep", () => {
    for (const name of ["cockpit.json", "team.json", "budget-probe-grok.json"]) {
      expect(classifyMigrationStateFile(name)).toBe("keep");
    }
  });

  test("unclassified state classifies as unknown", () => {
    expect(classifyMigrationStateFile("operator-scratch.json")).toBe("unknown");
  });
});

describe("migrationStateIncompleteRows (pure)", () => {
  test("migrated leftover → red row naming the migrate-state target", () => {
    const rows = migrationStateIncompleteRows(["paused.json"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.label).toBe("migration-state-incomplete");
    expect(rows[0]?.detail).toContain("state/paused.json");
    expect(rows[0]?.hint).toContain("--target=flags");
  });

  test("role-state glob leftover hints the role-state target", () => {
    const rows = migrationStateIncompleteRows(["cost-lead.json"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hint).toContain("--target=role-state");
  });

  test("unclassified file → red row without a migrate target", () => {
    const rows = migrationStateIncompleteRows(["operator-scratch.json"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.detail).toContain("state/operator-scratch.json");
  });

  test("KEEP-AS-JSON entries → silent", () => {
    expect(
      migrationStateIncompleteRows(["cockpit.json", "team.json", "budget-probe-grok.json"]),
    ).toEqual([]);
  });

  test("empty input → silent", () => {
    expect(migrationStateIncompleteRows([])).toEqual([]);
  });
});

describe("checkMigrationStateIncomplete (I/O wrapper)", () => {
  let scratch: string;
  let atmuxDir: string;
  let stateDir: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-migration-state-"));
    atmuxDir = join(scratch, ".atmux");
    stateDir = join(atmuxDir, "state");
    await mkdir(stateDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function writeState(name: string, body = "{}"): Promise<void> {
    await writeFile(join(stateDir, name), body);
  }

  test("migrated file present in state/ flags red", async () => {
    await writeState("paused.json");
    const rows = await checkMigrationStateIncomplete(atmuxDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.label).toBe("migration-state-incomplete");
    expect(rows[0]?.detail).toContain("state/paused.json");
  });

  test("archived copy outside state/ stays silent", async () => {
    const archived = join(atmuxDir, "archive", "json-pre-sqlite-123", "state");
    await mkdir(archived, { recursive: true });
    await writeFile(join(archived, "paused.json"), "{}");
    await expect(checkMigrationStateIncomplete(atmuxDir)).resolves.toEqual([]);
  });

  test("KEEP-AS-JSON cache file stays silent", async () => {
    await writeState("budget-probe-grok.json");
    await expect(checkMigrationStateIncomplete(atmuxDir)).resolves.toEqual([]);
  });

  test("unknown json file flags red", async () => {
    await writeState("operator-scratch.json");
    const rows = await checkMigrationStateIncomplete(atmuxDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("red");
  });

  test("missing state dir → silent", async () => {
    await expect(checkMigrationStateIncomplete(join(scratch, "no-such-team"))).resolves.toEqual([]);
  });

  test("non-json files are ignored", async () => {
    await writeState("notes.md", "# scratch");
    await expect(checkMigrationStateIncomplete(atmuxDir)).resolves.toEqual([]);
  });
});
