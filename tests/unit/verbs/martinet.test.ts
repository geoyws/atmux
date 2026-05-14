// Unit tests for src/verbs/martinet.ts (ADR-132 §D3 / T8).
//
// Covers:
//   - parseMartinetArgs — default sub-verb, --once flag, --config, --state
//   - resolveMartinetImplName — per-team > cockpit.defaultMartinet > "claude" fallback
//   - buildMartinet — claude impl construction; unknown impl falls back to claude with warn
//   - martinetTick — fleet-wide iteration writes state snapshot; per-team try/catch isolates failures
//   - martinetStatus — prints JSON snapshot or empty shape when state absent
//   - resolveStatePath — env / --state / default precedence

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeMartinet } from "../../../src/abstractions/martinets/claude.ts";
import type { Observation } from "../../../src/abstractions/martinet.ts";
import { createLogger } from "../../../src/core/tui.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  buildMartinet,
  buildStubObservation,
  defaultMartinetStatePath,
  martinet,
  martinetTick,
  parseMartinetArgs,
  resolveMartinetImplName,
} from "../../../src/verbs/martinet.ts";

// ---------- parseMartinetArgs ----------

describe("parseMartinetArgs", () => {
  test("bare invocation defaults to 'tick'", () => {
    expect(parseMartinetArgs([])).toEqual({ subverb: "tick" });
  });
  test("explicit 'tick' parses", () => {
    expect(parseMartinetArgs(["tick"])).toEqual({ subverb: "tick" });
  });
  test("explicit 'status' parses", () => {
    expect(parseMartinetArgs(["status"])).toEqual({ subverb: "status" });
  });
  test("unknown sub-verb throws UsageError", () => {
    expect(() => parseMartinetArgs(["frobnicate"])).toThrow(UsageError);
  });
  test("--once flag is accepted as synonym for tick", () => {
    expect(parseMartinetArgs(["tick", "--once"])).toEqual({ subverb: "tick" });
  });
  test("--once on bare invocation parses (still defaults to tick)", () => {
    expect(parseMartinetArgs(["--once"])).toEqual({ subverb: "tick" });
  });
  test("--config <path> threads configPath", () => {
    expect(parseMartinetArgs(["tick", "--config", "/tmp/x.json"])).toEqual({
      subverb: "tick",
      configPath: "/tmp/x.json",
    });
  });
  test("--state <path> threads statePath", () => {
    expect(parseMartinetArgs(["tick", "--state", "/tmp/s.json"])).toEqual({
      subverb: "tick",
      statePath: "/tmp/s.json",
    });
  });
  test("--config without value throws", () => {
    expect(() => parseMartinetArgs(["tick", "--config"])).toThrow(UsageError);
  });
  test("--state without value throws", () => {
    expect(() => parseMartinetArgs(["tick", "--state"])).toThrow(UsageError);
  });
  test("unknown arg throws", () => {
    expect(() => parseMartinetArgs(["tick", "--frobnicate"])).toThrow(UsageError);
  });
});

// ---------- resolveMartinetImplName ----------

describe("resolveMartinetImplName", () => {
  const logger = createLogger();
  test("per-team override wins over fleet default", () => {
    expect(
      resolveMartinetImplName({
        team: { martinet: "cursor" },
        cockpit: { defaultMartinet: "claude" },
        logger,
      }),
    ).toBe("cursor");
  });
  test("fleet default applies when per-team unset", () => {
    expect(
      resolveMartinetImplName({
        team: {},
        cockpit: { defaultMartinet: "cursor" },
        logger,
      }),
    ).toBe("cursor");
  });
  test("hard-coded 'claude' fallback when both unset", () => {
    expect(
      resolveMartinetImplName({
        team: {},
        cockpit: {},
        logger,
      }),
    ).toBe("claude");
  });
});

// ---------- buildMartinet ----------

describe("buildMartinet", () => {
  test("'claude' constructs ClaudeMartinet", () => {
    const observeFn = (_t: string) => buildStubObservation("x");
    const m = buildMartinet("claude", { observeFn, logger: createLogger() });
    expect(m).toBeInstanceOf(ClaudeMartinet);
    expect(m.name).toBe("claude");
  });
  test("'cursor' falls back to ClaudeMartinet with warn (T3 follow-up)", () => {
    const warns: string[] = [];
    const logger = {
      log: () => {},
      ok: () => {},
      warn: (s: string) => {
        warns.push(s);
      },
      err: () => {},
    };
    const observeFn = (_t: string) => buildStubObservation("x");
    const m = buildMartinet("cursor", { observeFn, logger });
    expect(m).toBeInstanceOf(ClaudeMartinet);
    expect(warns.length).toBeGreaterThanOrEqual(1);
    expect(warns[0]).toContain("cursor");
    expect(warns[0]).toContain("falling back");
  });
});

// ---------- martinetTick — fleet iteration ----------

describe("martinetTick", () => {
  let tmpDir: string;
  let cockpitPath: string;
  let statePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "atmux-martinet-test-"));
    cockpitPath = join(tmpDir, "cockpit.json");
    statePath = join(tmpDir, "state.json");
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("empty cockpit (no enabled teams) writes empty snapshot + returns 0", async () => {
    await writeFile(
      cockpitPath,
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "atmux_teams",
        sessions: [],
      }),
    );
    const rc = await martinetTick(
      { subverb: "tick", configPath: cockpitPath, statePath },
      { env: { HOME: tmpDir }, logger: createLogger() },
    );
    expect(rc).toBe(0);
    const state = JSON.parse(await readFile(statePath, "utf-8"));
    expect(state.teams).toEqual({});
    expect(typeof state.lastTickAt).toBe("number");
  });

  test("iterates enabled teams, writes per-team outcome", async () => {
    await writeFile(
      cockpitPath,
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "atmux_teams",
        sessions: [
          { type: "team", name: "alpha", root: "/a", enabled: true },
          { type: "team", name: "beta", root: "/b", enabled: true },
        ],
      }),
    );
    const rc = await martinetTick(
      { subverb: "tick", configPath: cockpitPath, statePath },
      { env: { HOME: tmpDir }, logger: createLogger() },
    );
    expect(rc).toBe(0);
    const state = JSON.parse(await readFile(statePath, "utf-8"));
    expect(Object.keys(state.teams).sort()).toEqual(["alpha", "beta"]);
    // ClaudeMartinet always emits one escalate-to-claude-lead action.
    expect(state.teams.alpha.actions).toEqual(["escalate-to-claude-lead"]);
    expect(state.teams.alpha.escalated).toBe(true);
    expect(state.teams.alpha.impl).toBe("claude");
  });

  test("disabled teams are skipped", async () => {
    await writeFile(
      cockpitPath,
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "atmux_teams",
        sessions: [
          { type: "team", name: "alpha", root: "/a", enabled: true },
          { type: "team", name: "ghost", root: "/g", enabled: false },
        ],
      }),
    );
    await martinetTick(
      { subverb: "tick", configPath: cockpitPath, statePath },
      { env: { HOME: tmpDir }, logger: createLogger() },
    );
    const state = JSON.parse(await readFile(statePath, "utf-8"));
    expect(Object.keys(state.teams).sort()).toEqual(["alpha"]);
  });

  test("per-team failures are isolated — fleet pass continues + records error", async () => {
    await writeFile(
      cockpitPath,
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "atmux_teams",
        sessions: [
          { type: "team", name: "alpha", root: "/a", enabled: true },
          { type: "team", name: "beta", root: "/b", enabled: true },
        ],
      }),
    );
    let calls = 0;
    const observeFn = async (team: string): Promise<Observation> => {
      calls += 1;
      if (team === "alpha") {
        throw new Error("synthetic observe failure");
      }
      return buildStubObservation(team);
    };
    await martinetTick(
      { subverb: "tick", configPath: cockpitPath, statePath },
      {
        env: { HOME: tmpDir },
        logger: createLogger(),
        observeFn,
      },
    );
    expect(calls).toBe(2); // both teams attempted despite alpha's throw
    const state = JSON.parse(await readFile(statePath, "utf-8"));
    expect(state.teams.alpha.error).toContain("synthetic observe failure");
    expect(state.teams.beta.error).toBeUndefined();
    expect(state.teams.beta.actions).toEqual(["escalate-to-claude-lead"]);
  });

  test("--state CLI flag overrides default state path", async () => {
    await writeFile(
      cockpitPath,
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "atmux_teams",
        sessions: [{ type: "team", name: "alpha", root: "/a", enabled: true }],
      }),
    );
    const override = join(tmpDir, "custom-state.json");
    await martinetTick(
      { subverb: "tick", configPath: cockpitPath, statePath: override },
      { env: { HOME: tmpDir }, logger: createLogger() },
    );
    const state = JSON.parse(await readFile(override, "utf-8"));
    expect(state.teams.alpha).toBeDefined();
  });

  test("respects cockpit.defaultMartinet (impl resolution surfaces in snapshot)", async () => {
    await writeFile(
      cockpitPath,
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "atmux_teams",
        defaultMartinet: "cursor",
        sessions: [{ type: "team", name: "alpha", root: "/a", enabled: true }],
      }),
    );
    await martinetTick(
      { subverb: "tick", configPath: cockpitPath, statePath },
      { env: { HOME: tmpDir }, logger: createLogger() },
    );
    const state = JSON.parse(await readFile(statePath, "utf-8"));
    // v1 only ships ClaudeMartinet — cursor falls back to claude. Snapshot
    // records the RESOLVED impl name (`cursor` per cockpit config) even
    // though the actual instance is ClaudeMartinet under the hood.
    expect(state.teams.alpha.impl).toBe("cursor");
  });
});

// ---------- martinet top-level dispatch + status ----------

describe("martinet", () => {
  let tmpDir: string;
  let cockpitPath: string;
  let statePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "atmux-martinet-disp-"));
    cockpitPath = join(tmpDir, "cockpit.json");
    statePath = join(tmpDir, "state.json");
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("status with no prior tick prints empty-shape JSON + returns 0", async () => {
    // Capture stdout via process.stdout.write injection.
    const stdouts: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => {
      stdouts.push(s);
      return true;
    }) as typeof process.stdout.write;
    try {
      const rc = await martinet(["status", "--state", statePath], {
        env: { HOME: tmpDir },
        logger: createLogger(),
      });
      expect(rc).toBe(0);
      const out = stdouts.join("");
      expect(out).toContain('"teams": {}');
      expect(out).toContain('"lastTickAt": 0');
    } finally {
      process.stdout.write = orig;
    }
  });

  test("status after a tick prints the snapshot", async () => {
    await writeFile(
      cockpitPath,
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "atmux_teams",
        sessions: [{ type: "team", name: "alpha", root: "/a", enabled: true }],
      }),
    );
    // First: run a tick to populate the state file.
    await martinet(["tick", "--config", cockpitPath, "--state", statePath], {
      env: { HOME: tmpDir },
      logger: createLogger(),
    });
    // Then: status reads it.
    const stdouts: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => {
      stdouts.push(s);
      return true;
    }) as typeof process.stdout.write;
    try {
      const rc = await martinet(["status", "--state", statePath], {
        env: { HOME: tmpDir },
        logger: createLogger(),
      });
      expect(rc).toBe(0);
      const parsed = JSON.parse(stdouts.join(""));
      expect(parsed.teams.alpha).toBeDefined();
      expect(parsed.teams.alpha.actions).toEqual(["escalate-to-claude-lead"]);
    } finally {
      process.stdout.write = orig;
    }
  });

  test("dispatch routes 'tick' + 'status' to the correct subverb", async () => {
    await writeFile(
      cockpitPath,
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "atmux_teams",
        sessions: [],
      }),
    );
    expect(
      await martinet(["tick", "--config", cockpitPath, "--state", statePath], {
        env: { HOME: tmpDir },
        logger: createLogger(),
      }),
    ).toBe(0);
  });
});

// ---------- defaultMartinetStatePath ----------

describe("defaultMartinetStatePath", () => {
  test("composes <home>/.atmux/state/martinet-state.json", () => {
    expect(defaultMartinetStatePath("/Users/alice")).toBe(
      "/Users/alice/.atmux/state/martinet-state.json",
    );
  });
});

// ---------- buildStubObservation ----------

describe("buildStubObservation", () => {
  test("returns degenerate Observation shape with the given team name", async () => {
    const obs = await buildStubObservation("alpha");
    expect(obs.team).toBe("alpha");
    expect(obs.members).toEqual([]);
    expect(obs.kanbanDelta.newClaims).toEqual([]);
    expect(obs.kanbanDelta.completedSinceLastTick).toEqual([]);
    expect(obs.kanbanDelta.wedgedClaims).toEqual([]);
    expect(obs.commitCadence).toEqual({ sinceLastTick: 0, last30min: 0, last2hr: 0 });
    expect(typeof obs.lastTickAt).toBe("number");
  });
});
