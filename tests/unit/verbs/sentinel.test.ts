// Unit tests for src/verbs/sentinel.ts (ADR-132 §D3 / T8).
//
// Covers:
//   - parseSentinelArgs — default sub-verb, --once flag, --config, --state
//   - resolveSentinelImplName — per-team > cockpit.defaultSentinel > "claude" fallback
//   - buildSentinel — claude + cursor impl construction (T3 / t-e96d286a wires CursorSentinel)
//   - sentinelTick — fleet-wide iteration writes state snapshot; per-team try/catch isolates failures
//   - sentinelStatus — prints JSON snapshot or empty shape when state absent
//   - resolveStatePath — env / --state / default precedence

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Observation } from "../../../src/abstractions/sentinel.ts";
import { ClaudeSentinel } from "../../../src/abstractions/sentinels/claude.ts";
import { CursorSentinel } from "../../../src/abstractions/sentinels/cursor.ts";
import { createLogger } from "../../../src/core/tui.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  buildSentinel,
  buildStubObservation,
  defaultSentinelStatePath,
  parseSentinelArgs,
  resolveSentinelImplName,
  sentinel,
  sentinelTick,
} from "../../../src/verbs/sentinel.ts";

// ---------- parseSentinelArgs ----------

describe("parseSentinelArgs", () => {
  test("bare invocation defaults to 'tick'", () => {
    expect(parseSentinelArgs([])).toEqual({ subverb: "tick" });
  });
  test("explicit 'tick' parses", () => {
    expect(parseSentinelArgs(["tick"])).toEqual({ subverb: "tick" });
  });
  test("explicit 'status' parses", () => {
    expect(parseSentinelArgs(["status"])).toEqual({ subverb: "status" });
  });
  test("unknown sub-verb throws UsageError", () => {
    expect(() => parseSentinelArgs(["frobnicate"])).toThrow(UsageError);
  });
  test("--once flag is accepted as synonym for tick", () => {
    expect(parseSentinelArgs(["tick", "--once"])).toEqual({ subverb: "tick" });
  });
  test("--once on bare invocation parses (still defaults to tick)", () => {
    expect(parseSentinelArgs(["--once"])).toEqual({ subverb: "tick" });
  });
  test("--config <path> threads configPath", () => {
    expect(parseSentinelArgs(["tick", "--config", "/tmp/x.json"])).toEqual({
      subverb: "tick",
      configPath: "/tmp/x.json",
    });
  });
  test("--state <path> threads statePath", () => {
    expect(parseSentinelArgs(["tick", "--state", "/tmp/s.json"])).toEqual({
      subverb: "tick",
      statePath: "/tmp/s.json",
    });
  });
  test("--config without value throws", () => {
    expect(() => parseSentinelArgs(["tick", "--config"])).toThrow(UsageError);
  });
  test("--state without value throws", () => {
    expect(() => parseSentinelArgs(["tick", "--state"])).toThrow(UsageError);
  });
  test("unknown arg throws", () => {
    expect(() => parseSentinelArgs(["tick", "--frobnicate"])).toThrow(UsageError);
  });
});

// ---------- resolveSentinelImplName ----------

describe("resolveSentinelImplName", () => {
  const logger = createLogger();
  test("per-team override wins over fleet default", () => {
    expect(
      resolveSentinelImplName({
        team: { sentinel: "cursor" },
        cockpit: { defaultSentinel: "claude" },
        logger,
      }),
    ).toBe("cursor");
  });
  test("fleet default applies when per-team unset", () => {
    expect(
      resolveSentinelImplName({
        team: {},
        cockpit: { defaultSentinel: "cursor" },
        logger,
      }),
    ).toBe("cursor");
  });
  test("hard-coded 'claude' fallback when both unset", () => {
    expect(
      resolveSentinelImplName({
        team: {},
        cockpit: {},
        logger,
      }),
    ).toBe("claude");
  });
});

// ---------- buildSentinel ----------

describe("buildSentinel", () => {
  test("'claude' constructs ClaudeSentinel", () => {
    const observeFn = (_t: string) => buildStubObservation("x");
    const m = buildSentinel("claude", { observeFn, logger: createLogger() });
    expect(m).toBeInstanceOf(ClaudeSentinel);
    expect(m.name).toBe("claude");
  });
  test("'cursor' constructs CursorSentinel (T3 / t-e96d286a)", () => {
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
    const m = buildSentinel("cursor", { observeFn, logger });
    expect(m).toBeInstanceOf(CursorSentinel);
    expect(m.name).toBe("cursor");
    // No warn — cursor is now production-default per ADR-140.
    expect(warns).toEqual([]);
  });

  test("'cursor' honors cockpit.sentinel override of binPath + model", async () => {
    const observeFn = (_t: string) => buildStubObservation("x");
    const seenArgs: string[][] = [];
    const m = buildSentinel("cursor", {
      observeFn,
      logger: createLogger(),
      cockpit: {
        schemaVersion: 1,
        cockpitSession: "atmux_cockpit",
        sessions: [],
        sentinel: {
          impl: "cursor",
          enabled: true,
          cursorBinPath: "/opt/cursor-agent",
          model: "composer-2",
          cageTier: "tier-2",
        },
      },
      runCursorAgent: async (args) => {
        seenArgs.push(args);
        return JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1500,
          result: "[]",
          usage: { inputTokens: 10, outputTokens: 5 },
        });
      },
    });
    expect(m).toBeInstanceOf(CursorSentinel);
    await m.decide(await buildStubObservation("x"));
    const args = seenArgs[0];
    expect(args).toBeDefined();
    if (args === undefined) throw new Error("unreachable");
    expect(args[args.indexOf("--model") + 1]).toBe("composer-2");
  });

  test("buildSentinel exhaustive fallback — unknown impl literal warns + falls back to claude", () => {
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
    // Cast to bypass the literal-union narrowing — the fallback branch
    // is reachable via a deliberate forward-compat literal that lands
    // in cockpit.json from a future version.
    const m = buildSentinel("future-impl" as "claude" | "cursor", {
      observeFn,
      logger,
    });
    expect(m).toBeInstanceOf(ClaudeSentinel);
    expect(warns.length).toBeGreaterThanOrEqual(1);
    expect(warns[0]).toContain("future-impl");
    expect(warns[0]).toContain("not recognised");
  });
});

// ---------- sentinelTick — fleet iteration ----------

describe("sentinelTick", () => {
  let tmpDir: string;
  let cockpitPath: string;
  let statePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "atmux-sentinel-test-"));
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
    const rc = await sentinelTick(
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
    const rc = await sentinelTick(
      { subverb: "tick", configPath: cockpitPath, statePath },
      { env: { HOME: tmpDir }, logger: createLogger() },
    );
    expect(rc).toBe(0);
    const state = JSON.parse(await readFile(statePath, "utf-8"));
    expect(Object.keys(state.teams).sort()).toEqual(["alpha", "beta"]);
    // ClaudeSentinel always emits one escalate-to-claude-lead action.
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
    await sentinelTick(
      { subverb: "tick", configPath: cockpitPath, statePath },
      { env: { HOME: tmpDir }, logger: createLogger() },
    );
    const state = JSON.parse(await readFile(statePath, "utf-8"));
    expect(Object.keys(state.teams).sort()).toEqual(["alpha"]);
  });

  test("ADR-183 / t-186d5910 Part C — sentinel scope includes epic-teams", async () => {
    // Regression: pre-ADR-183, sentinel iterated `cockpit.teams` (parent-
    // team-only synthesis). Epic-teams were silently invisible — the
    // silent-member-death class operator was burned by (gitter / committer
    // dying inside an epic-team with no observation coverage). Post-
    // ADR-183, `enabledTeams(cockpit)` walks both `type: "team"` and
    // `type: "epic-team"` entries.
    await writeFile(
      cockpitPath,
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "atmux_teams",
        sessions: [
          {
            type: "team",
            name: "alpha",
            root: "/a",
            enabled: true,
            sessions: [
              { type: "epic-team", name: "e-aaa", parent: "alpha", epicId: "e-aaa", enabled: true },
              { type: "epic-team", name: "e-bbb", parent: "alpha", epicId: "e-bbb", enabled: true },
            ],
          },
        ],
      }),
    );
    await sentinelTick(
      { subverb: "tick", configPath: cockpitPath, statePath },
      { env: { HOME: tmpDir }, logger: createLogger() },
    );
    const state = JSON.parse(await readFile(statePath, "utf-8"));
    // Pre-ADR-183 path would only tick `alpha`; post-ADR-183 ticks all
    // three (parent team + 2 epic-teams). Sort-compare to keep iteration
    // order off the assertion surface.
    expect(Object.keys(state.teams).sort()).toEqual(["alpha", "e-aaa", "e-bbb"]);
    // Each ticked entry gets a per-team state row with the resolved impl.
    expect(state.teams["e-aaa"].impl).toBe("claude");
    expect(state.teams["e-bbb"].actions).toEqual(["escalate-to-claude-lead"]);
  });

  test("ADR-183 — disabled epic-teams are skipped (consistent with parent-team disabled filter)", async () => {
    await writeFile(
      cockpitPath,
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "atmux_teams",
        sessions: [
          {
            type: "team",
            name: "alpha",
            root: "/a",
            enabled: true,
            sessions: [
              { type: "epic-team", name: "e-live", parent: "alpha", epicId: "e-live", enabled: true },
              { type: "epic-team", name: "e-dead", parent: "alpha", epicId: "e-dead", enabled: false },
            ],
          },
        ],
      }),
    );
    await sentinelTick(
      { subverb: "tick", configPath: cockpitPath, statePath },
      { env: { HOME: tmpDir }, logger: createLogger() },
    );
    const state = JSON.parse(await readFile(statePath, "utf-8"));
    expect(Object.keys(state.teams).sort()).toEqual(["alpha", "e-live"]);
  });

  test("t-70c8b562 — parallel tick: 10 teams with 100ms-each observe stub completes in roughly max(per-team), not sum", async () => {
    // Pre-parallel: 10 × 100ms = ~1000ms sequential. Post-parallel:
    // ~max(100ms) per Promise.allSettled with bounded jitter. Threshold
    // 500ms is generous to absorb event-loop / fs noise but firmly
    // below the sequential lower bound — regression to a serial loop
    // would 2x past the threshold.
    const sessions = Array.from({ length: 10 }, (_, i) => ({
      type: "team" as const,
      name: `t${i}`,
      root: `/r${i}`,
      enabled: true,
    }));
    await writeFile(
      cockpitPath,
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "atmux_teams",
        sessions,
      }),
    );
    const observeFn = async (team: string): Promise<Observation> => {
      await new Promise((r) => setTimeout(r, 100));
      return buildStubObservation(team);
    };
    const t0 = Date.now();
    await sentinelTick(
      { subverb: "tick", configPath: cockpitPath, statePath },
      { env: { HOME: tmpDir }, logger: createLogger(), observeFn },
    );
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500);
    const state = JSON.parse(await readFile(statePath, "utf-8"));
    expect(Object.keys(state.teams)).toHaveLength(10);
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
    await sentinelTick(
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
    await sentinelTick(
      { subverb: "tick", configPath: cockpitPath, statePath: override },
      { env: { HOME: tmpDir }, logger: createLogger() },
    );
    const state = JSON.parse(await readFile(override, "utf-8"));
    expect(state.teams.alpha).toBeDefined();
  });

  test("respects cockpit.defaultSentinel (impl resolution surfaces in snapshot)", async () => {
    await writeFile(
      cockpitPath,
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "atmux_teams",
        defaultSentinel: "cursor",
        sessions: [{ type: "team", name: "alpha", root: "/a", enabled: true }],
      }),
    );
    await sentinelTick(
      { subverb: "tick", configPath: cockpitPath, statePath },
      { env: { HOME: tmpDir }, logger: createLogger() },
    );
    const state = JSON.parse(await readFile(statePath, "utf-8"));
    // v1 only ships ClaudeSentinel — cursor falls back to claude. Snapshot
    // records the RESOLVED impl name (`cursor` per cockpit config) even
    // though the actual instance is ClaudeSentinel under the hood.
    expect(state.teams.alpha.impl).toBe("cursor");
  });
});

// ---------- sentinel top-level dispatch + status ----------

describe("sentinel", () => {
  let tmpDir: string;
  let cockpitPath: string;
  let statePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "atmux-sentinel-disp-"));
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
      const rc = await sentinel(["status", "--state", statePath], {
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
    await sentinel(["tick", "--config", cockpitPath, "--state", statePath], {
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
      const rc = await sentinel(["status", "--state", statePath], {
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
      await sentinel(["tick", "--config", cockpitPath, "--state", statePath], {
        env: { HOME: tmpDir },
        logger: createLogger(),
      }),
    ).toBe(0);
  });
});

// ---------- defaultSentinelStatePath ----------

describe("defaultSentinelStatePath", () => {
  test("composes <home>/.atmux/state/sentinel-state.json", () => {
    expect(defaultSentinelStatePath("/Users/alice")).toBe(
      "/Users/alice/.atmux/state/sentinel-state.json",
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

// ---------- ADR-027 rename.lock guard ----------

describe("sentinelTick — ADR-027 rename.lock guard", () => {
  let tmpDir: string;
  let cockpitPath: string;
  let statePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "atmux-sentinel-rename-"));
    cockpitPath = join(tmpDir, "cockpit.json");
    statePath = join(tmpDir, "state.json");
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("team with rename.lock present is skipped — no observe/decide/apply, .error notes the skip", async () => {
    const teamRoot = join(tmpDir, "team-a");
    await mkdir(join(teamRoot, ".atmux", "state"), { recursive: true });
    await writeFile(
      join(teamRoot, ".atmux", "state", "rename.lock"),
      '{"old":"team-a","new":"team-renamed","epoch":1}',
    );
    await writeFile(
      cockpitPath,
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "atmux_teams",
        sessions: [{ type: "team", name: "team-a", root: teamRoot, enabled: true }],
      }),
    );
    const rc = await sentinelTick(
      { subverb: "tick", configPath: cockpitPath, statePath },
      { env: { HOME: tmpDir }, logger: createLogger() },
    );
    expect(rc).toBe(0);
    const state = JSON.parse(await readFile(statePath, "utf-8"));
    expect(Object.keys(state.teams)).toEqual(["team-a"]);
    expect(state.teams["team-a"].actions).toEqual([]); // no observe/decide ran
    expect(state.teams["team-a"].escalated).toBe(false);
    expect(state.teams["team-a"].error).toContain("rename.lock present");
  });

  test("mixed fleet: locked team skipped, unlocked team ticks normally", async () => {
    const lockedRoot = join(tmpDir, "locked");
    const openRoot = join(tmpDir, "open");
    await mkdir(join(lockedRoot, ".atmux", "state"), { recursive: true });
    await writeFile(join(lockedRoot, ".atmux", "state", "rename.lock"), "{}");
    await writeFile(
      cockpitPath,
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "atmux_teams",
        sessions: [
          { type: "team", name: "locked", root: lockedRoot, enabled: true },
          { type: "team", name: "open", root: openRoot, enabled: true },
        ],
      }),
    );
    await sentinelTick(
      { subverb: "tick", configPath: cockpitPath, statePath },
      { env: { HOME: tmpDir }, logger: createLogger() },
    );
    const state = JSON.parse(await readFile(statePath, "utf-8"));
    expect(state.teams.locked.actions).toEqual([]);
    expect(state.teams.locked.error).toContain("rename.lock present");
    expect(state.teams.open.actions).toEqual(["escalate-to-claude-lead"]);
    expect(state.teams.open.error).toBeUndefined();
  });
});
