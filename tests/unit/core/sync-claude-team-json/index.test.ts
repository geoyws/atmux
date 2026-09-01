// Unit tests for src/core/sync-claude-team-json/index.ts (ADR-164 T3
// orchestrator + T5 wire-through — t-312fe824 + t-c2b757c1, asserted
// under T7 t-4329b053).
//
// The orchestrator composes:
//   1. tryLoadTeam (reads .atmux/team.json via existing common.ts chain)
//   2. readLooseJson on .claude/team.json (prior) + .claude/team-colors.json (sidecar)
//   3. mapRoster (T3) + mergeBriefs (T4)
//   4. writeSync (T5): detectDrift → log event → DriftAbortError or
//      atomicWrite → log action=synced. Tests use real fs under mkdtemp
//      so the atomicWrite + event-log paths are exercised end-to-end.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeFingerprint,
  DriftAbortError,
  SYNC_MARKER_KEY,
  syncEventsLogPath,
} from "../../../../src/core/sync-claude-team-json/drift.ts";
import { computeMappedTeam, writeSync } from "../../../../src/core/sync-claude-team-json/index.ts";

interface Harness {
  root: string;
  atmuxDir: string;
  claudeDir: string;
}

async function newHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "atmux-sync-index-"));
  const atmuxDir = join(root, ".atmux");
  const claudeDir = join(root, ".claude");
  await mkdir(atmuxDir, { recursive: true });
  return { root, atmuxDir, claudeDir };
}

async function writeAtmuxTeam(h: Harness, body: unknown): Promise<void> {
  await writeFile(join(h.atmuxDir, "team.json"), JSON.stringify(body), "utf8");
}

async function writeClaudeTeam(h: Harness, body: unknown): Promise<void> {
  await mkdir(h.claudeDir, { recursive: true });
  await writeFile(join(h.claudeDir, "team.json"), JSON.stringify(body), "utf8");
}

async function writeSidecar(h: Harness, body: unknown): Promise<void> {
  await mkdir(h.claudeDir, { recursive: true });
  await writeFile(join(h.claudeDir, "team-colors.json"), JSON.stringify(body), "utf8");
}

let h: Harness;
beforeEach(async () => {
  h = await newHarness();
});
afterEach(async () => {
  await rm(h.root, { recursive: true, force: true });
});

describe("computeMappedTeam — happy path", () => {
  test("fresh-file: no prior .claude/team.json, no sidecar — returns prior=null + computed roster", async () => {
    await writeAtmuxTeam(h, {
      name: "fixture",
      description: "test team",
      members: [
        { name: "lead", role: "team-lead", emoji: "🧭" },
        { name: "planner", role: "planner", emoji: "🎯" },
        { name: "fe-1", role: "member", lane: "fe", emoji: "🌸" },
      ],
    });
    const result = await computeMappedTeam({ dir: h.atmuxDir, claudeDir: h.claudeDir });
    expect(result.prior).toBeNull();
    expect(result.sidecar).toBeNull();
    expect(result.computed.name).toBe("fixture");
    expect(result.computed.description).toBe("test team");
    expect(result.computed.members).toHaveLength(3);
    expect(result.computed.members[0]?.name).toBe("team-lead"); // rewritten
    expect(result.computed.members[0]?.agentType).toBe("team-lead");
    expect(result.computed.members[0]?.color).toBe("white"); // 🧭
    expect(result.computed.members[1]?.name).toBe("planner");
    expect(result.computed.members[1]?.color).toBe("magenta"); // 🎯
    expect(result.computed.members[2]?.name).toBe("fe-1");
    expect(result.computed.members[2]?.color).toBe("orange"); // 🌸
  });

  test("description undefined when atmux team has none", async () => {
    await writeAtmuxTeam(h, {
      name: "no-desc-team",
      members: [{ name: "lead", role: "team-lead", emoji: "🧭" }],
    });
    const result = await computeMappedTeam({ dir: h.atmuxDir, claudeDir: h.claudeDir });
    expect(result.computed.description).toBeUndefined();
  });
});

describe("computeMappedTeam — prior .claude/team.json present", () => {
  test("returns parsed prior + brief-preservation seeds atmux role on first match miss", async () => {
    await writeAtmuxTeam(h, {
      name: "t",
      members: [{ name: "lead", role: "team-lead", emoji: "🧭" }],
    });
    await writeClaudeTeam(h, {
      name: "t",
      members: [
        { name: "team-lead", agentType: "team-lead", color: "white", role: "preserved-text" },
      ],
    });
    const result = await computeMappedTeam({ dir: h.atmuxDir, claudeDir: h.claudeDir });
    expect(result.prior).not.toBeNull();
    expect(result.prior?.members?.[0]?.role).toBe("preserved-text");
    // Default overwriteBriefs=false → preserve prior text
    expect(result.computed.members[0]?.role).toBe("preserved-text");
  });

  test("overwriteBriefs=true threads through to mergeBriefs (atmux role wins)", async () => {
    await writeAtmuxTeam(h, {
      name: "t",
      members: [{ name: "lead", role: "team-lead", emoji: "🧭" }],
    });
    await writeClaudeTeam(h, {
      name: "t",
      members: [{ name: "team-lead", role: "previously-handauthored" }],
    });
    const result = await computeMappedTeam({
      dir: h.atmuxDir,
      claudeDir: h.claudeDir,
      overwriteBriefs: true,
    });
    expect(result.computed.members[0]?.role).toBe("team-lead");
  });

  test("default opts (overwriteBriefs unset) → preserve-by-default", async () => {
    await writeAtmuxTeam(h, {
      name: "t",
      members: [{ name: "fe-1", role: "member", emoji: "🌸" }],
    });
    await writeClaudeTeam(h, {
      members: [{ name: "fe-1", role: "kept" }],
    });
    const result = await computeMappedTeam({ dir: h.atmuxDir, claudeDir: h.claudeDir });
    expect(result.computed.members[0]?.role).toBe("kept");
  });
});

describe("computeMappedTeam — sidecar present", () => {
  test("sidecar._byMemberName beats fixed-table color resolution", async () => {
    await writeAtmuxTeam(h, {
      name: "t",
      members: [{ name: "fe-1", role: "member", emoji: "🌸" }],
    });
    await writeSidecar(h, { _byMemberName: { "fe-1": "blue" } });
    const result = await computeMappedTeam({ dir: h.atmuxDir, claudeDir: h.claudeDir });
    expect(result.sidecar).not.toBeNull();
    expect(result.computed.members[0]?.color).toBe("blue");
  });

  test("sidecar top-level emoji override engaged", async () => {
    await writeAtmuxTeam(h, {
      name: "t",
      members: [{ name: "fe-1", role: "member", emoji: "🌸" }],
    });
    await writeSidecar(h, { "🌸": "yellow" });
    const result = await computeMappedTeam({ dir: h.atmuxDir, claudeDir: h.claudeDir });
    expect(result.computed.members[0]?.color).toBe("yellow");
  });

  test("sidecar present but empty → falls through to fixed table", async () => {
    await writeAtmuxTeam(h, {
      name: "t",
      members: [{ name: "fe-1", role: "member", emoji: "🌸" }],
    });
    await writeSidecar(h, {});
    const result = await computeMappedTeam({ dir: h.atmuxDir, claudeDir: h.claudeDir });
    expect(result.computed.members[0]?.color).toBe("orange");
  });
});

describe("computeMappedTeam — error paths", () => {
  test("missing .atmux/team.json → throws actionable error", async () => {
    // Fresh tmpdir, no team.json written
    await expect(computeMappedTeam({ dir: h.atmuxDir, claudeDir: h.claudeDir })).rejects.toThrow(
      /no \.atmux\/team\.json/,
    );
  });

  test("malformed prior .claude/team.json → SyntaxError surfaces (caller decides UX)", async () => {
    await writeAtmuxTeam(h, {
      name: "t",
      members: [{ name: "fe-1", role: "member", emoji: "🌸" }],
    });
    await mkdir(h.claudeDir, { recursive: true });
    await writeFile(join(h.claudeDir, "team.json"), "{ this is not json", "utf8");
    await expect(
      computeMappedTeam({ dir: h.atmuxDir, claudeDir: h.claudeDir }),
    ).rejects.toBeInstanceOf(SyntaxError);
  });

  test("malformed sidecar JSON → SyntaxError surfaces", async () => {
    await writeAtmuxTeam(h, {
      name: "t",
      members: [{ name: "fe-1", role: "member", emoji: "🌸" }],
    });
    await mkdir(h.claudeDir, { recursive: true });
    await writeFile(join(h.claudeDir, "team-colors.json"), "{ malformed", "utf8");
    await expect(
      computeMappedTeam({ dir: h.atmuxDir, claudeDir: h.claudeDir }),
    ).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe("computeMappedTeam — claudeDir resolution", () => {
  test("defaults to <process.cwd()>/.claude when claudeDir is omitted", async () => {
    await writeAtmuxTeam(h, {
      name: "t",
      members: [{ name: "fe-1", role: "member", emoji: "🌸" }],
    });
    // We can't safely override process.cwd() in-test (Bun's chdir
    // is process-global + would race with sibling tests). Instead
    // verify the default path is exercised by providing `dir` for
    // atmux side + leaving claudeDir unset — the orchestrator will
    // attempt to read `<cwd>/.claude/team.json` which almost certainly
    // doesn't exist under the test runner's cwd, so prior should be
    // null without crashing.
    const result = await computeMappedTeam({ dir: h.atmuxDir });
    // Prior comes from <cwd>/.claude/team.json — typically absent in CI
    // and the repo root (we don't ship a .claude/team.json). Sidecar
    // similarly absent. Both null OR populated (if a dev runs the test
    // with a populated .claude/ next to the repo) is acceptable; the
    // contract under test is "no crash + computed populated."
    expect(result.computed.name).toBe("t");
    expect(result.computed.members).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// writeSync (T5 wire-through — t-c2b757c1)
// ---------------------------------------------------------------------------

const FIXED_TS_DATE = new Date("2026-05-17T10:00:00.000Z");
const FIXED_TS = FIXED_TS_DATE.toISOString();
const FIXED_NOW = () => FIXED_TS_DATE;

async function readJson<T = unknown>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

async function readEvents(atmuxDir: string): Promise<unknown[]> {
  const raw = await readFile(syncEventsLogPath(atmuxDir), "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe("writeSync — fresh file (no prior .claude/team.json)", () => {
  test("writes mapped roster + stamps _atmuxSync marker, logs action=synced", async () => {
    await writeAtmuxTeam(h, {
      name: "fixture",
      description: "fresh-write coverage",
      members: [
        { name: "lead", role: "team-lead", emoji: "🧭" },
        { name: "be-1", role: "member", emoji: "📦" },
      ],
    });

    const stderrBuf: string[] = [];
    const result = await writeSync({
      dir: h.atmuxDir,
      claudeDir: h.claudeDir,
      now: FIXED_NOW,
      stderr: (s) => stderrBuf.push(s),
    });

    expect(result.path).toBe(join(h.claudeDir, "team.json"));
    expect(result.forced).toBe(false);
    expect(stderrBuf).toHaveLength(0); // no drift, no warning

    const written = await readJson<Record<string, unknown>>(result.path);
    expect(written.name).toBe("fixture");
    expect(written.description).toBe("fresh-write coverage");
    expect(Array.isArray(written.members)).toBe(true);
    const members = written.members as Array<{ name: string }>;
    expect(members).toHaveLength(2);
    expect(members[0]?.name).toBe("team-lead"); // rewritten

    // Marker stamped at the supplied timestamp + fingerprint matches the
    // POST-sync roster (the just-written members).
    const marker = written[SYNC_MARKER_KEY] as {
      lastSyncedAt: string;
      schemaRev: string;
      sourceFingerprint: string;
    };
    expect(marker.lastSyncedAt).toBe(FIXED_TS);
    expect(marker.schemaRev).toBe("v1");
    expect(marker.sourceFingerprint).toBe(computeFingerprint(members as never));

    const events = await readEvents(h.atmuxDir);
    expect(events).toHaveLength(1);
    expect((events[0] as { action: string }).action).toBe("synced");
  });

  test("description omitted on atmux side → not written to .claude/team.json", async () => {
    await writeAtmuxTeam(h, {
      name: "no-desc",
      members: [{ name: "lead", role: "team-lead", emoji: "🧭" }],
    });
    await writeSync({
      dir: h.atmuxDir,
      claudeDir: h.claudeDir,
      now: FIXED_NOW,
    });
    const written = await readJson<Record<string, unknown>>(join(h.claudeDir, "team.json"));
    expect(written.name).toBe("no-desc");
    expect("description" in written).toBe(false);
  });
});

describe("writeSync — re-run with marker matching prior (no drift)", () => {
  test("idempotent: second run rewrites with same fingerprint, no warning", async () => {
    await writeAtmuxTeam(h, {
      name: "t",
      members: [{ name: "lead", role: "team-lead", emoji: "🧭" }],
    });
    // First run seeds the file + marker
    await writeSync({
      dir: h.atmuxDir,
      claudeDir: h.claudeDir,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const stderrBuf: string[] = [];
    // Second run with the same atmux roster — no drift, no warning, new ts
    const result = await writeSync({
      dir: h.atmuxDir,
      claudeDir: h.claudeDir,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
      stderr: (s) => stderrBuf.push(s),
    });
    expect(result.forced).toBe(false);
    expect(stderrBuf).toHaveLength(0);
    const written = await readJson<Record<string, unknown>>(result.path);
    const marker = written[SYNC_MARKER_KEY] as { lastSyncedAt: string };
    expect(marker.lastSyncedAt).toBe("2026-06-01T00:00:00.000Z");
    // Both events logged
    const events = await readEvents(h.atmuxDir);
    expect(events.map((e) => (e as { action: string }).action)).toEqual(["synced", "synced"]);
  });
});

describe("writeSync — drift detected", () => {
  async function seedDriftedFixture(opts: { force?: boolean } = {}) {
    await writeAtmuxTeam(h, {
      name: "t",
      members: [{ name: "lead", role: "team-lead", emoji: "🧭" }],
    });
    // Seed the .claude side with a marker that does NOT match its own
    // roster — simulates a hand-edit between syncs.
    await writeClaudeTeam(h, {
      name: "t",
      members: [
        { name: "team-lead", agentType: "team-lead", color: "white" },
        { name: "extra-1", color: "red" }, // hand-added member
      ],
      [SYNC_MARKER_KEY]: {
        lastSyncedAt: "2026-01-01T00:00:00.000Z",
        schemaRev: "v1",
        // Fingerprint that won't match the on-disk roster.
        sourceFingerprint:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      },
    });

    const stderrBuf: string[] = [];
    const promise = writeSync({
      dir: h.atmuxDir,
      claudeDir: h.claudeDir,
      now: FIXED_NOW,
      stderr: (s) => stderrBuf.push(s),
      force: opts.force ?? false,
    });
    return { promise, stderrBuf };
  }

  test("default (no --force) → throws DriftAbortError + logs drift-abort + writes no file", async () => {
    const { promise, stderrBuf } = await seedDriftedFixture();
    await expect(promise).rejects.toBeInstanceOf(DriftAbortError);

    // Drift warning emitted to stderr — exactly one line.
    expect(stderrBuf.join("")).toContain("🔧 [sync-claude-team-json]");
    expect(stderrBuf.join("")).toContain("drift detected");

    // Event log records the abort.
    const events = await readEvents(h.atmuxDir);
    expect(events).toHaveLength(1);
    expect((events[0] as { action: string }).action).toBe("drift-abort");

    // .claude/team.json should be UNCHANGED — re-read + assert the
    // hand-edited 2-member roster is still present.
    const after = await readJson<Record<string, unknown>>(join(h.claudeDir, "team.json"));
    expect((after.members as unknown[]).length).toBe(2);
  });

  test("--force overrides → writes new file + logs drift-forced + synced + result.forced=true", async () => {
    const { promise, stderrBuf } = await seedDriftedFixture({ force: true });
    const result = await promise;
    expect(result.forced).toBe(true);

    // Warning still emitted (transparency).
    expect(stderrBuf.join("")).toContain("drift detected");

    // Two events: drift-forced then synced.
    const events = await readEvents(h.atmuxDir);
    expect(events.map((e) => (e as { action: string }).action)).toEqual(["drift-forced", "synced"]);

    // File written with the atmux-side roster (extra-1 dropped) + fresh marker.
    const after = await readJson<Record<string, unknown>>(join(h.claudeDir, "team.json"));
    const members = after.members as Array<{ name: string }>;
    expect(members.map((m) => m.name)).toEqual(["team-lead"]);
    const marker = after[SYNC_MARKER_KEY] as {
      sourceFingerprint: string;
      lastSyncedAt: string;
    };
    expect(marker.lastSyncedAt).toBe(FIXED_TS);
    expect(marker.sourceFingerprint).toBe(computeFingerprint(members as never));
  });
});

describe("writeSync — unknown top-level fields preserved", () => {
  test("operator-extension keys on prior survive the write", async () => {
    await writeAtmuxTeam(h, {
      name: "t",
      members: [{ name: "lead", role: "team-lead", emoji: "🧭" }],
    });
    // Seed the .claude side with a clean marker that matches its roster,
    // plus a custom top-level field that the verb shouldn't drop.
    const priorMembers = [{ name: "team-lead", agentType: "team-lead", color: "white" }];
    await writeClaudeTeam(h, {
      name: "t",
      members: priorMembers,
      operatorExtension: "preserve-me",
      [SYNC_MARKER_KEY]: {
        lastSyncedAt: "2026-01-01T00:00:00.000Z",
        schemaRev: "v1",
        sourceFingerprint: computeFingerprint(priorMembers as never),
      },
    });

    await writeSync({
      dir: h.atmuxDir,
      claudeDir: h.claudeDir,
      now: FIXED_NOW,
    });

    const after = await readJson<Record<string, unknown>>(join(h.claudeDir, "team.json"));
    expect(after.operatorExtension).toBe("preserve-me");
  });
});
