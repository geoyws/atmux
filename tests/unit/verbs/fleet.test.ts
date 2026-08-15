// Unit tests for src/verbs/fleet.ts — ADR-273 D1 sweep IO.
//
// The classifier's own tests live in tests/unit/core/voice/fleet.test.ts.
// What is tested HERE is everything the sweep is responsible for:
// argument parsing, the wall-clock bound, the concurrency cap, the
// never-silently-omit contract, window enumeration, and the tmux probe
// parsing. No real tmux, no real cockpit, no dependence on what the live
// fleet happens to look like — every dep is injected.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import type { FlattenedTeamEntry } from "../../../src/core/cockpit.ts";
import { type PaneObservation, renderUnreadable } from "../../../src/core/voice/fleet.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  CAPTURE_LINES,
  cageIsAbsent,
  EPIC_TEAM_NO_CAGE_REASON,
  type FleetDeps,
  fleet,
  parseFleetArgs,
  parseWindowProbe,
  probeTeamLive,
  readTeamAsks,
  resolveEpicEntry,
  SWEEP_CONCURRENCY_DEFAULT,
  SWEEP_TIMEOUT_MS_DEFAULT,
  sweepFleet,
  type TeamProbeResult,
  WINDOW_PROBE_FORMAT,
} from "../../../src/verbs/fleet.ts";
import { captureStdio } from "../../helpers/capture.ts";

/** Temp project roots created by the on-disk tests, cleaned per test. */
const tempRoots: string[] = [];

afterEach(async () => {
  for (const r of tempRoots.splice(0)) await rm(r, { recursive: true, force: true });
});

/** A real `<root>/.atmux/` tree — the fixture for anything that reads
 *  the roster, the driver inbox, or flags.md from disk. */
async function makeRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atmux-fleet-"));
  tempRoots.push(root);
  await mkdir(join(root, ".atmux"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(root, ".atmux", name), body, "utf8");
  }
  return root;
}

function team(name: string, over: Partial<FlattenedTeamEntry> = {}): FlattenedTeamEntry {
  return { type: "team", name, enabled: true, root: `/w/${name}`, level: 0, ...over };
}

/** A healthy, idle Claude pane's chrome — the default fixture capture,
 *  so a test that means "nothing wrong here" actually says so. */
const HEALTHY_CAPTURE = "❯ \n  ⏵⏵ auto mode on (shift+tab to cycle)\n  tok 12/900000";

function obs(over: Partial<PaneObservation> = {}): PaneObservation {
  return {
    team: "t",
    member: "m",
    windowName: "w",
    sessionUp: true,
    windowPresent: true,
    capture: HEALTHY_CAPTURE,
    paneDead: false,
    currentCommand: "claude",
    activityAgeSec: 1,
    ...over,
  };
}

const EMPTY: TeamProbeResult = { panes: [], asks: null, unreadable: null };

// ---------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------

describe("parseFleetArgs", () => {
  test("defaults: attention view, top 5, text output, shipped bounds", () => {
    expect(parseFleetArgs([])).toEqual({
      view: "attention",
      top: 5,
      json: false,
      timeoutMs: SWEEP_TIMEOUT_MS_DEFAULT,
      concurrency: SWEEP_CONCURRENCY_DEFAULT,
    });
  });

  test("--quiet selects the complement view", () => {
    expect(parseFleetArgs(["--quiet"]).view).toBe("quiet");
  });

  test("--attention after --quiet wins — last flag decides, no silent merge", () => {
    expect(parseFleetArgs(["--quiet", "--attention"]).view).toBe("attention");
  });

  test("--top / --timeout-ms / --concurrency / --json all parse", () => {
    expect(
      parseFleetArgs(["--top", "9", "--timeout-ms", "2500", "--concurrency", "3", "--json"]),
    ).toEqual({ view: "attention", top: 9, json: true, timeoutMs: 2500, concurrency: 3 });
  });

  test("--top outside 1..15 is a UsageError, not a silent clamp", () => {
    // Clamping would let the model ask for 100 and be told 15 without
    // ever learning it asked for the wrong thing.
    expect(() => parseFleetArgs(["--top", "0"])).toThrow(UsageError);
    expect(() => parseFleetArgs(["--top", "16"])).toThrow(UsageError);
    expect(parseFleetArgs(["--top", "1"]).top).toBe(1);
    expect(parseFleetArgs(["--top", "15"]).top).toBe(15);
  });

  test("non-integer / negative / missing numeric values are UsageErrors", () => {
    for (const argv of [
      ["--top"],
      ["--top", "abc"],
      ["--top", "2.5"],
      ["--timeout-ms", "-1"],
      ["--concurrency", "0"],
      ["--concurrency"],
      ["--timeout-ms"],
    ]) {
      expect(() => parseFleetArgs(argv), JSON.stringify(argv)).toThrow(UsageError);
    }
  });

  test("an unknown flag refuses rather than being ignored", () => {
    expect(() => parseFleetArgs(["--reap"])).toThrow(UsageError);
    expect(() => parseFleetArgs(["--"])).toThrow(UsageError);
  });
});

// ---------------------------------------------------------------------
// parseWindowProbe — the independent activity clock
// ---------------------------------------------------------------------

describe("parseWindowProbe", () => {
  test("the format asks tmux for activity, deadness and the command", () => {
    expect(WINDOW_PROBE_FORMAT).toBe("#{window_activity}\t#{pane_dead}\t#{pane_current_command}");
  });

  test("splits the three fields and turns the epoch into an AGE", () => {
    expect(parseWindowProbe("1786800000\t0\tclaude", 1786800042)).toEqual({
      activityAgeSec: 42,
      paneDead: false,
      currentCommand: "claude",
    });
  });

  test("pane_dead=1 reads as dead", () => {
    expect(parseWindowProbe("1786800000\t1\tsh", 1786800000).paneDead).toBe(true);
  });

  test("a clock in the future clamps to 0 rather than going negative", () => {
    expect(parseWindowProbe("1786800100\t0\tclaude", 1786800000).activityAgeSec).toBe(0);
  });

  test("missing / unparseable fields degrade to null, never to a fake zero", () => {
    // A fabricated age of 0 would say "just active" about a pane nobody
    // could read — the exact lie trap 3 is about.
    expect(parseWindowProbe("", 1)).toEqual({
      activityAgeSec: null,
      paneDead: null,
      currentCommand: null,
    });
    expect(parseWindowProbe("not-a-number\t\t", 1)).toEqual({
      activityAgeSec: null,
      paneDead: null,
      currentCommand: null,
    });
  });
});

// ---------------------------------------------------------------------
// sweepFleet — bounding, concurrency, and the no-silent-omission rule
// ---------------------------------------------------------------------

describe("resolveEpicEntry", () => {
  test("rewrites .root to the ADR-089 in-parent cage, leaving every other field alone", () => {
    const entry = team("8-abc", {
      type: "epic-team",
      root: "/w/mx",
      epicId: "8-abc",
      parent: "mx",
    });
    const got = resolveEpicEntry(entry, (p) => p === "/w/mx/.atmux/worktrees/8-abc");
    expect(got).toEqual({ ...entry, root: "/w/mx/.atmux/worktrees/8-abc" });
  });

  test("rewrites .root to the ADR-090 sibling cage when that is the one on disk", () => {
    const entry = team("8-abc", { type: "epic-team", root: "/w/mx", epicId: "8-abc" });
    expect(resolveEpicEntry(entry, (p) => p === "/w/mx-epics/8-abc")?.root).toBe(
      "/w/mx-epics/8-abc",
    );
  });

  test("falls back to the entry NAME when the cockpit node carries no epicId", () => {
    const entry = team("8-abc", { type: "epic-team", root: "/w/mx" });
    expect(resolveEpicEntry(entry, (p) => p === "/w/mx-epics/8-abc")?.root).toBe(
      "/w/mx-epics/8-abc",
    );
  });

  test("returns null when neither cage path exists — never the parent's root", () => {
    const entry = team("8-abc", { type: "epic-team", root: "/w/mx", epicId: "8-abc" });
    expect(resolveEpicEntry(entry, () => false)).toBeNull();
  });

  test("with no existsSync injected it reads the real filesystem", async () => {
    const parent = await makeRoot({});
    await mkdir(join(parent, ".atmux", "worktrees", "8-real"), { recursive: true });
    const found = team("8-real", { type: "epic-team", root: parent, epicId: "8-real" });
    expect(resolveEpicEntry(found)?.root).toBe(join(parent, ".atmux", "worktrees", "8-real"));
    const missing = team("8-nope", { type: "epic-team", root: parent, epicId: "8-nope" });
    expect(resolveEpicEntry(missing)).toBeNull();
  });
});

describe("cageIsAbsent", () => {
  test("true only when EVERY observation says the session is absent", () => {
    expect(cageIsAbsent({ panes: [obs({ sessionUp: false })], asks: null, unreadable: null })).toBe(
      true,
    );
    expect(cageIsAbsent({ panes: [obs()], asks: null, unreadable: null })).toBe(false);
    expect(
      cageIsAbsent({ panes: [obs({ sessionUp: false }), obs()], asks: null, unreadable: null }),
    ).toBe(false);
  });

  test("false on an EMPTY pane list — no evidence is not evidence of absence", () => {
    // `[].every(...)` is vacuously true, so without the length guard a
    // probe that simply found nothing would be reported as a dead cage.
    expect(cageIsAbsent(EMPTY)).toBe(false);
  });
});

describe("sweepFleet", () => {
  test("collects panes, asks and per-team unreadables from the probe", async () => {
    const s = await sweepFleet({
      listTeams: async () => [team("a"), team("b")],
      probeTeam: async (t) => ({
        panes: [obs({ team: t.name })],
        asks: { team: t.name, driverInboxUnread: 1, openFlags: 0, gist: "g" },
        unreadable: null,
      }),
      now: () => 0,
    });
    expect(s.panes.map((p) => p.team)).toEqual(["a", "b"]);
    expect(s.asks.map((a) => a.team)).toEqual(["a", "b"]);
    expect(s.teamsSurveyed).toBe(2);
  });

  test("a probe that THROWS becomes an unreadable row naming the error", async () => {
    const s = await sweepFleet({
      listTeams: async () => [team("ok"), team("boom")],
      probeTeam: async (t) => {
        if (t.name === "boom") throw new Error("socket gone");
        return { panes: [obs({ team: t.name })], asks: null, unreadable: null };
      },
      now: () => 0,
    });
    expect(s.panes.length).toBe(1);
    expect(s.unreadable).toEqual([{ team: "boom", reason: "probe failed: socket gone" }]);
  });

  test("a probe that never returns is bounded and reported, not awaited forever", async () => {
    const s = await sweepFleet(
      {
        listTeams: async () => [team("hangs")],
        probeTeam: () => new Promise<TeamProbeResult>(() => {}),
        now: () => 0,
        // The deadline sleeper is injected, so this resolves instantly.
        sleep: async () => {},
      },
      { timeoutMs: 5000, concurrency: 1 },
    );
    expect(s.unreadable).toEqual([{ team: "hangs", reason: "not read within 5000ms" }]);
    expect(s.panes).toEqual([]);
  });

  test("once the budget is spent, remaining teams are reported as unread — never dropped", async () => {
    // The contract that makes the survey honest: a team the sweep did
    // not reach must still be named.
    let t = 0;
    const s = await sweepFleet(
      {
        listTeams: async () => [team("a"), team("b"), team("c")],
        // Each probe advances the clock past the budget.
        probeTeam: async () => {
          t += 1000;
          return EMPTY;
        },
        now: () => t,
        sleep: async () => {},
      },
      { timeoutMs: 900, concurrency: 1 },
    );
    expect(s.unreadable.map((u) => u.team)).toEqual(["b", "c"]);
    for (const u of s.unreadable) {
      expect(u.reason).toBe("sweep deadline reached before this team was read");
    }
    expect(s.teamsSurveyed).toBe(3);
  });

  test("a LIVE epic-team is swept, and probed at its OWN cage root — not the parent root the entry carries", async () => {
    // The regression this pins: the cockpit entry's `.root` is the
    // PARENT's (the flattener threads parentRoot through), so probing it
    // verbatim reads the parent's cage and reports a confident wrong
    // answer about the child. Before this fix no epic-team was probed at
    // all — every one was reported unreadable.
    const probed: Array<{ name: string; root: string }> = [];
    const s = await sweepFleet({
      listTeams: async () => [
        team("mx", { root: "/w/mx-root" }),
        team("8-abc", { type: "epic-team", root: "/w/mx-root", epicId: "8-abc" }),
      ],
      resolveEpicEntry: (e) => ({ ...e, root: "/w/mx-root-epics/8-abc" }),
      probeTeam: async (t) => {
        probed.push({ name: t.name, root: t.root });
        return { panes: [obs({ team: t.name })], asks: null, unreadable: null };
      },
      now: () => 0,
    });
    expect(probed).toEqual([
      { name: "mx", root: "/w/mx-root" },
      { name: "8-abc", root: "/w/mx-root-epics/8-abc" },
    ]);
    // The whole point: a live epic-team produces PANES and no unreadable
    // row at all — it is an ordinary team once its root is resolved.
    expect(s.panes.map((p) => p.team)).toEqual(["mx", "8-abc"]);
    expect(s.unreadable).toEqual([]);
  });

  test("a live epic-team's asks are collected too — resolution reaches its whole cage, not just its panes", async () => {
    const s = await sweepFleet({
      listTeams: async () => [team("8-abc", { type: "epic-team", epicId: "8-abc" })],
      resolveEpicEntry: (e) => ({ ...e, root: "/w/own" }),
      probeTeam: async (t) => ({
        panes: [obs({ team: t.name })],
        asks: { team: t.name, driverInboxUnread: 2, openFlags: 0, gist: "g" },
        unreadable: null,
      }),
      now: () => 0,
    });
    expect(s.asks).toEqual([{ team: "8-abc", driverInboxUnread: 2, openFlags: 0, gist: "g" }]);
  });

  test("an epic-team with NO cage on disk is reported once, with an ACTIONABLE reason", async () => {
    const s = await sweepFleet({
      listTeams: async () => [team("parent"), team("e-1", { type: "epic-team" })],
      resolveEpicEntry: () => null,
      probeTeam: async () => EMPTY,
      now: () => 0,
    });
    expect(s.unreadable).toEqual([{ team: "e-1", reason: EPIC_TEAM_NO_CAGE_REASON }]);
    expect(s.teamsSurveyed).toBe(2);
    // Actionable means it names the verb that removes it — a reason the
    // operator cannot act on is the noise ADR-273 D3 forbids.
    expect(EPIC_TEAM_NO_CAGE_REASON).toContain("atmux team dissolve-epic");
  });

  test("an epic-team whose cage EXISTS but is not running lands on the unreadable line, not in the attention budget", async () => {
    // An ephemeral cage that ended is chronic bookkeeping, not news
    // (ADR-273 §S3.3's argument, applied to epic-teams). Reporting it as
    // an acute `dead` item would hold a spoken slot on every sweep for a
    // team that finished months ago.
    const s = await sweepFleet({
      listTeams: async () => [team("e-1", { type: "epic-team" })],
      resolveEpicEntry: (e) => ({ ...e, root: "/w/own" }),
      probeTeam: async () => ({
        panes: [obs({ team: "e-1", sessionUp: false, windowPresent: false, capture: null })],
        asks: null,
        unreadable: null,
      }),
      now: () => 0,
    });
    expect(s.unreadable).toEqual([{ team: "e-1", reason: EPIC_TEAM_NO_CAGE_REASON }]);
    // The synthetic session-absent observation is DROPPED rather than
    // double-reported: it must not also become a `dead` attention item.
    expect(s.panes).toEqual([]);
  });

  test("a TOP-LEVEL team whose session is down still reports as a pane — the demotion is epic-only", async () => {
    // The asymmetry IS the decision, so it is pinned in both directions:
    // a standing team being down is news and must keep reaching the
    // attention list.
    const s = await sweepFleet({
      listTeams: async () => [team("orch")],
      probeTeam: async () => ({
        panes: [obs({ team: "orch", sessionUp: false, windowPresent: false, capture: null })],
        asks: null,
        unreadable: null,
      }),
      now: () => 0,
    });
    expect(s.unreadable).toEqual([]);
    expect(s.panes.map((p) => p.sessionUp)).toEqual([false]);
  });

  test("a live epic-team with a broken pane is still swept — only TOTAL cage absence is demoted", async () => {
    // Guards the trade-off from swallowing real findings: a bad pane
    // inside a running epic cage must still reach the operator.
    const s = await sweepFleet({
      listTeams: async () => [team("e-1", { type: "epic-team" })],
      resolveEpicEntry: (e) => ({ ...e, root: "/w/own" }),
      probeTeam: async () => ({
        panes: [obs({ team: "e-1", paneDead: true }), obs({ team: "e-1", member: "be-1" })],
        asks: null,
        unreadable: null,
      }),
      now: () => 0,
    });
    expect(s.unreadable).toEqual([]);
    expect(s.panes).toHaveLength(2);
  });

  test("an epic-team with no cage on disk is NOT probed — a guessed root would read the parent's cage", async () => {
    let probeCalls = 0;
    await sweepFleet({
      listTeams: async () => [team("e-1", { type: "epic-team" })],
      resolveEpicEntry: () => null,
      probeTeam: async () => {
        probeCalls += 1;
        return EMPTY;
      },
      now: () => 0,
    });
    expect(probeCalls).toBe(0);
  });

  test("BOTH no-cage cases share ONE reason string, so the renderer collapses them into one clause", async () => {
    // Per-case reason text would defeat renderUnreadable's group-by-
    // reason and spend one spoken clause per dead entry — the exact noise
    // this change exists to remove. e-1's cage root is gone; e-2 and e-3
    // have roots but no running cage.
    const s = await sweepFleet({
      listTeams: async () => [
        team("e-1", { type: "epic-team" }),
        team("e-2", { type: "epic-team" }),
        team("e-3", { type: "epic-team" }),
      ],
      resolveEpicEntry: (e) => (e.name === "e-1" ? null : { ...e, root: "/w/own" }),
      probeTeam: async (t) => ({
        panes: [obs({ team: t.name, sessionUp: false, windowPresent: false, capture: null })],
        asks: null,
        unreadable: null,
      }),
      now: () => 0,
    });
    expect(s.unreadable.map((u) => u.team)).toEqual(["e-1", "e-2", "e-3"]);
    expect(new Set(s.unreadable.map((u) => u.reason)).size).toBe(1);
    expect(renderUnreadable(s.unreadable).split("\n")).toHaveLength(1);
  });

  test("the default epic resolver is used when none is injected", async () => {
    // Guards the wiring: an injected-only resolver would leave production
    // on the old always-unreadable path with every test still green.
    const s = await sweepFleet({
      listTeams: async () => [
        team("e-gone", { type: "epic-team", root: "/nonexistent/parent-root" }),
      ],
      probeTeam: async () => EMPTY,
      now: () => 0,
    });
    expect(s.unreadable).toEqual([{ team: "e-gone", reason: EPIC_TEAM_NO_CAGE_REASON }]);
  });

  test("teams are swept CONCURRENTLY up to the cap", async () => {
    let live = 0;
    let peak = 0;
    const s = await sweepFleet(
      {
        listTeams: async () => Array.from({ length: 12 }, (_, i) => team(`t${i}`)),
        probeTeam: async () => {
          live += 1;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 5));
          live -= 1;
          return EMPTY;
        },
        now: () => 0,
      },
      { timeoutMs: 60_000, concurrency: 4 },
    );
    expect(peak).toBe(4);
    expect(s.teamsSurveyed).toBe(12);
  });

  test("concurrency 1 really serializes", async () => {
    let live = 0;
    let peak = 0;
    await sweepFleet(
      {
        listTeams: async () => [team("a"), team("b"), team("c")],
        probeTeam: async () => {
          live += 1;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 2));
          live -= 1;
          return EMPTY;
        },
        now: () => 0,
      },
      { timeoutMs: 60_000, concurrency: 1 },
    );
    expect(peak).toBe(1);
  });

  test("an empty fleet does not spawn a worker or hang", async () => {
    const s = await sweepFleet({ listTeams: async () => [], now: () => 0 });
    expect(s).toMatchObject({ teamsSurveyed: 0, panes: [], asks: [], unreadable: [] });
  });

  test("elapsedMs is measured from the injected clock; a fresh sweep has ageMs 0", async () => {
    let t = 100;
    const s = await sweepFleet({
      listTeams: async () => [team("a")],
      probeTeam: async () => {
        t = 450;
        return EMPTY;
      },
      now: () => t,
    });
    expect(s.elapsedMs).toBe(350);
    expect(s.ageMs).toBe(0);
  });

  test("unreadable rows are sorted so the spoken order is deterministic", async () => {
    const s = await sweepFleet({
      listTeams: async () => [team("z"), team("a"), team("m")],
      probeTeam: async (t) => {
        throw new Error(t.name);
      },
      now: () => 0,
    });
    expect(s.unreadable.map((u) => u.team)).toEqual(["a", "m", "z"]);
  });

  test("a probe's own unreadable verdict is carried through", async () => {
    const s = await sweepFleet({
      listTeams: async () => [team("a")],
      probeTeam: async () => ({ panes: [], asks: null, unreadable: { team: "a", reason: "why" } }),
      now: () => 0,
    });
    expect(s.unreadable).toEqual([{ team: "a", reason: "why" }]);
  });
});

// ---------------------------------------------------------------------
// probeTeamLive — window enumeration against a stub tmux
// ---------------------------------------------------------------------

interface TmuxStubOpts {
  hasSession?: boolean;
  windows?: Array<{ name: string }>;
  probeByWindow?: Record<string, string>;
  captureByWindow?: Record<string, string>;
  captureThrowsFor?: string;
  probeThrowsFor?: string;
  calls?: string[];
}

function tmuxStub(opts: TmuxStubOpts = {}): TmuxNamespace {
  return {
    session: {
      async hasSession(name: string) {
        opts.calls?.push(`hasSession:${name}`);
        return opts.hasSession ?? true;
      },
    },
    window: {
      async listWindows(session: string) {
        opts.calls?.push(`listWindows:${session}`);
        return (opts.windows ?? [{ name: "driver" }]).map((w, i) => ({
          index: i,
          id: `@${i}`,
          name: w.name,
          active: i === 0,
        }));
      },
    },
    pane: {
      async displayMessage({ target, format }: { target: string; format: string }) {
        opts.calls?.push(`probe:${target}:${format}`);
        const win = target.split(":")[1] ?? "";
        if (opts.probeThrowsFor === win) throw new Error("probe blew up");
        return opts.probeByWindow?.[win] ?? "1786800000\t0\tclaude";
      },
      async capturePane({ target, start }: { target: string; start?: number }) {
        opts.calls?.push(`capture:${target}:${String(start)}`);
        const win = target.split(":")[1] ?? "";
        if (opts.captureThrowsFor === win) throw new Error("capture blew up");
        return opts.captureByWindow?.[win] ?? "pane text";
      },
    },
  } as unknown as TmuxNamespace;
}

describe("probeTeamLive", () => {
  test("enumerates tmux WINDOWS, not the roster — a driver-only team still reports panes", async () => {
    // The live fleet's regression: 14 of 15 teams carry `members: []`
    // while their sessions hold live driver windows. A roster-driven
    // sweep would report "0 panes, all clear" across working agents.
    const calls: string[] = [];
    const r = await probeTeamLive(team("solo", { root: "/nonexistent-root" }), 1786800030, {
      tmux: () => tmuxStub({ windows: [{ name: "driver" }, { name: "driver-2" }], calls }),
    });
    expect(r.panes.map((p) => p.member)).toEqual(["driver", "driver-2"]);
    expect(r.panes[0]?.activityAgeSec).toBe(30);
    expect(r.panes[0]?.currentCommand).toBe("claude");
    expect(r.panes[0]?.sessionUp).toBe(true);
    expect(calls.some((c) => c.startsWith(`capture:`) && c.endsWith(`:-${CAPTURE_LINES}`))).toBe(
      true,
    );
  });

  test("a session that is DOWN yields exactly one dead observation, not one per member", async () => {
    const r = await probeTeamLive(team("gone", { root: "/nonexistent-root" }), 0, {
      tmux: () => tmuxStub({ hasSession: false }),
    });
    expect(r.panes.length).toBe(1);
    expect(r.panes[0]).toMatchObject({ sessionUp: false, windowPresent: false, capture: null });
  });

  test("a VIEWER window (tmux attached into another session) is excluded, not double-counted", async () => {
    const r = await probeTeamLive(team("v", { root: "/nonexistent-root" }), 0, {
      tmux: () =>
        tmuxStub({
          windows: [{ name: "driver" }, { name: "e-abc" }],
          probeByWindow: { "e-abc": "1786800000\t0\ttmux" },
        }),
    });
    expect(r.panes.map((p) => p.member)).toEqual(["driver"]);
  });

  test("a failed CAPTURE still yields an observation (capture null), never a dropped pane", async () => {
    const r = await probeTeamLive(team("c", { root: "/nonexistent-root" }), 0, {
      tmux: () => tmuxStub({ windows: [{ name: "driver" }], captureThrowsFor: "driver" }),
    });
    expect(r.panes.length).toBe(1);
    expect(r.panes[0]?.capture).toBeNull();
  });

  test("a failed PROBE degrades the clock to null but still captures the pane", async () => {
    const r = await probeTeamLive(team("p", { root: "/nonexistent-root" }), 0, {
      tmux: () => tmuxStub({ windows: [{ name: "driver" }], probeThrowsFor: "driver" }),
    });
    expect(r.panes[0]).toMatchObject({
      activityAgeSec: null,
      paneDead: null,
      currentCommand: null,
      capture: "pane text",
    });
  });

  test("asks are null for a team with no inbox or flags on disk", async () => {
    const r = await probeTeamLive(team("clean", { root: "/nonexistent-root" }), 0, {
      tmux: () => tmuxStub(),
    });
    expect(r.asks).toBeNull();
    expect(r.unreadable).toBeNull();
  });

  test("a KNOWN roster member is named by its member id, not its window name", async () => {
    // The roster is enrichment, not enumeration: window `🐝-gitter` is
    // reported as `gitter`, while a window nobody declared keeps its own
    // name rather than vanishing.
    const root = await makeRoot({
      "team.json": JSON.stringify({
        name: "roster",
        members: [{ name: "gitter", role: "member", tui: "claude", emoji: "🐝" }],
      }),
    });
    const r = await probeTeamLive(team("roster", { root }), 0, {
      tmux: () => tmuxStub({ windows: [{ name: "🐝-gitter" }, { name: "driver-9" }] }),
    });
    expect(r.panes.map((p) => p.member)).toEqual(["gitter", "driver-9"]);
    expect(r.panes[0]?.windowName).toBe("🐝-gitter");
  });
});

describe("readTeamAsks", () => {
  test("counts unread driver-inbox entries and open flags, with the newest as evidence", async () => {
    const root = await makeRoot({
      "driver-inbox.md": [
        "## 10:17 MYT — first ask",
        "body one",
        "",
        "## 11:02 MYT — second ask",
        "body two",
        "",
      ].join("\n"),
      "flags.md":
        "### f-11111111 be-1 [p1/unblock] (09:00 MYT)\n**needs**: unblock\nstuck on the migration\n",
    });
    const asks = await readTeamAsks(team("t", { root }), Math.floor(Date.now() / 1000));
    expect(asks).not.toBeNull();
    expect(asks?.driverInboxUnread).toBe(2);
    expect(asks?.openFlags).toBe(1);
    expect(asks?.gist).toContain("second ask");
  });

  test("a RESOLVED flag is not counted as open", async () => {
    const root = await makeRoot({
      "flags.md": [
        "### f-22222222 be-1 [p1/unblock] (09:00 MYT)",
        "**needs**: unblock",
        "stuck",
        "",
        "### r-33333333 f-22222222",
        "unblocked",
      ].join("\n"),
    });
    expect(await readTeamAsks(team("t", { root }), Math.floor(Date.now() / 1000))).toBeNull();
  });

  test("flags with no inbox still produce an ask, and the flag summary is the evidence", async () => {
    const root = await makeRoot({
      "flags.md":
        "### f-44444444 fe-2 [p2/decision] (09:00 MYT)\n**needs**: decision\npick a schema\n",
    });
    const asks = await readTeamAsks(team("t", { root }), Math.floor(Date.now() / 1000));
    expect(asks?.driverInboxUnread).toBe(0);
    expect(asks?.openFlags).toBe(1);
    expect(asks?.gist.length).toBeGreaterThan(0);
  });

  test("a team with neither file has nothing to say", async () => {
    const root = await makeRoot({});
    expect(await readTeamAsks(team("t", { root }), 0)).toBeNull();
  });

  test("a BROKEN inbox read does not take the flags down with it, or vice versa", async () => {
    // Fail-soft, independently: losing an ask must never cost the caller
    // the other surface — and neither may throw out of the team probe,
    // which would turn one bad file into a whole team going unreadable.
    const asks = await readTeamAsks(team("t", { root: "/w/t" }), 0, {
      readInbox: async () => {
        throw new Error("inbox unreadable");
      },
      readFlags: async () => [
        {
          id: "flag:f-1",
          source: "md-flags",
          opened_at: 0,
          age_sec: 0,
          summary: "stuck on the migration",
          blocker_class: "member-stuck",
          suggested_action: "unblock",
        },
      ],
    });
    expect(asks).toMatchObject({ driverInboxUnread: 0, openFlags: 1 });
    expect(asks?.gist).toBe("stuck on the migration");

    const flagsBroken = await readTeamAsks(team("t", { root: "/w/t" }), 0, {
      readInbox: async () => ({
        all: [],
        delta: [{ head: "## 10:00 MYT — ask", body: "b", tsEpochSec: 1 }],
        priorCursor: null,
        tipTs: 1,
        fileMtimeSec: 1,
      }),
      readFlags: async () => {
        throw new Error("flags unreadable");
      },
    });
    expect(flagsBroken).toMatchObject({ driverInboxUnread: 1, openFlags: 0 });
  });
});

// ---------------------------------------------------------------------
// The verb entry
// ---------------------------------------------------------------------

function captureLog(): { logger: { log: (m: string) => void }; lines: string[] } {
  const lines: string[] = [];
  return { logger: { log: (m: string) => lines.push(m) }, lines };
}

const TWO_TEAM_DEPS: FleetDeps = {
  listTeams: async () => [team("alpha"), team("beta")],
  probeTeam: async (t) => ({
    panes: [
      obs({ team: t.name, member: "driver", sessionUp: t.name === "beta" }),
      obs({ team: t.name, member: "driver-2" }),
    ],
    asks: null,
    unreadable: null,
  }),
  now: () => 0,
};

describe("fleet verb", () => {
  test("--attention renders the ranked spoken shape and exits 0", async () => {
    const { logger, lines } = captureLog();
    const code = await fleet(["--attention"], { ...TWO_TEAM_DEPS, logger });
    expect(code).toBe(0);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("ATTENTION 1 findings across 4 panes in 2 teams");
    expect(lines[0]).toContain("alpha/driver — session is down");
    expect(lines[0]).toContain("quiet: 3 panes");
  });

  test("--quiet renders the aggregate and names no member", async () => {
    const { logger, lines } = captureLog();
    expect(await fleet(["--quiet"], { ...TWO_TEAM_DEPS, logger })).toBe(0);
    expect(lines[0]).toContain("QUIET 1 of 2 teams nominal");
    expect(lines[0]).not.toContain("driver-2");
  });

  test("--top bounds how many entries are spoken", async () => {
    const deps: FleetDeps = {
      listTeams: async () => Array.from({ length: 8 }, (_, i) => team(`t${i}`)),
      probeTeam: async (t) => ({
        panes: [obs({ team: t.name, member: "d", sessionUp: false })],
        asks: null,
        unreadable: null,
      }),
      now: () => 0,
    };
    const { logger, lines } = captureLog();
    await fleet(["--top", "2"], { ...deps, logger });
    const numbered = (lines[0] ?? "").split("\n").filter((l) => /^\d+\. /.test(l));
    expect(numbered.length).toBe(2);
    expect(lines[0]).toContain("+ 6 more:");
  });

  test("--json emits the full verdict, including everything the speech elides", async () => {
    const { logger, lines } = captureLog();
    await fleet(["--json"], { ...TWO_TEAM_DEPS, logger });
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed.view).toBe("attention");
    expect(parsed.paneCount).toBe(4);
    expect(parsed.teamsSurveyed).toBe(2);
    expect(Array.isArray(parsed.attention)).toBe(true);
    expect(Array.isArray(parsed.quiet)).toBe(true);
    expect(Array.isArray(parsed.unreadable)).toBe(true);
  });

  test("--json --quiet still emits the same machine shape (the view is a label)", async () => {
    const { logger, lines } = captureLog();
    await fleet(["--json", "--quiet"], { ...TWO_TEAM_DEPS, logger });
    expect((JSON.parse(lines[0] ?? "{}") as { view: string }).view).toBe("quiet");
  });

  test("bad argv throws before any sweep runs", async () => {
    let probed = false;
    await expect(
      fleet(["--nope"], {
        ...TWO_TEAM_DEPS,
        probeTeam: async () => {
          probed = true;
          return EMPTY;
        },
      }),
    ).rejects.toThrow(UsageError);
    expect(probed).toBe(false);
  });

  test("with NO seams at all it uses the real cockpit reader, tmux, sleeper and stdout", async () => {
    // Covers the production defaults end to end — the wiring nothing else
    // exercises. The cockpit is a temp file (via ATMUX_COCKPIT_CONFIG),
    // and the team's socket path cannot exist, so the real tmux probe
    // deterministically answers "no session" instead of depending on what
    // the live fleet is doing.
    const cockpitRoot = await mkdtemp(join(tmpdir(), "atmux-fleet-cockpit-"));
    tempRoots.push(cockpitRoot);
    const configPath = join(cockpitRoot, "cockpit.json");
    const teamName = `probe-${process.pid}-${Date.now()}`;
    await writeFile(
      configPath,
      JSON.stringify({
        sessions: [{ type: "team", name: teamName, root: cockpitRoot, enabled: true }],
      }),
      "utf8",
    );
    const prior = process.env.ATMUX_COCKPIT_CONFIG;
    process.env.ATMUX_COCKPIT_CONFIG = configPath;
    try {
      const captured = await captureStdio(() => fleet([]));
      expect(captured.result).toBe(0);
      expect(captured.stdout).toContain(`ATTENTION 1 findings across 1 panes in 1 teams`);
      expect(captured.stdout).toContain(`${teamName}/cage — session is down`);
    } finally {
      if (prior === undefined) delete process.env.ATMUX_COCKPIT_CONFIG;
      else process.env.ATMUX_COCKPIT_CONFIG = prior;
    }
  });

  test("the REAL deadline sleeper bounds a hanging probe and does not pin the loop", async () => {
    // No injected `sleep`: this exercises the production timer, whose
    // `unref()` is what stops a lost race from holding the event loop
    // open for the rest of the budget.
    const started = Date.now();
    const s = await sweepFleet(
      {
        listTeams: async () => [team("hangs")],
        probeTeam: () => new Promise<TeamProbeResult>(() => {}),
      },
      { timeoutMs: 30, concurrency: 1 },
    );
    expect(s.unreadable).toEqual([{ team: "hangs", reason: "not read within 30ms" }]);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("the verb is read-only: it never sends keys or writes state", async () => {
    // Structural, not aspirational — the sweep's tmux surface is
    // hasSession / listWindows / displayMessage / capturePane, all reads.
    const calls: string[] = [];
    await probeTeamLive(team("ro", { root: "/nonexistent-root" }), 0, {
      tmux: () => tmuxStub({ calls }),
    });
    for (const c of calls) {
      expect(c.startsWith("sendKeys"), `mutating tmux call: ${c}`).toBe(false);
      expect(c.startsWith("kill"), `mutating tmux call: ${c}`).toBe(false);
    }
    expect(calls.length).toBeGreaterThan(0);
  });
});
