// Unit tests for src/verbs/fleet.ts — ADR-273 D1 sweep IO.
//
// The classifier's own tests live in tests/unit/core/vox/fleet.test.ts.
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
import { type PaneObservation, renderUnreadable } from "../../../src/core/vox/fleet.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  CAPTURE_LINES,
  cageIsAbsent,
  type FleetDeps,
  fleet,
  parseFleetArgs,
  parseWindowProbe,
  probeTeamLive,
  readTeamAsks,
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

// ADR-280 stage 3 deleted `resolveEpicEntry` and `EPIC_TEAM_NO_CAGE_REASON`
// along with `core/cage-resolver.ts` (ADR-251), whose last consumer was
// exactly this epic branch. The suite that covered them is gone with the
// code. What replaced the branch is simpler and is asserted below in
// `sweepFleet`: a nested team carries its OWN root on its cockpit entry
// (stage 3's walker change), so it is swept as an ordinary team with no
// rewrite step and no epic-shaped demotion.
//
// `cageIsAbsent` SURVIVES as an export but its only production caller
// was that branch, so it is currently caller-less. Reported rather than
// deleted — trimming a live export is not stage 4's call — and kept
// under test so it does not rot while it waits for a verdict.

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

  // ADR-280 stage 4 — the nine cases that stood here drove the
  // epic-team branch `sweepFleet` no longer has: entry-root rewriting via
  // `resolveEpicEntry`, and the demotion of a cage-less epic-team onto the
  // unreadable line under `EPIC_TEAM_NO_CAGE_REASON`. Both are gone with
  // the branch, so the cases that asserted them are gone too. The
  // properties that OUTLIVE the branch are kept, and are stronger now
  // because they hold for every team rather than for one type:

  test("a NESTED team is swept like any other, at the root its own cockpit entry carries", async () => {
    // Stage 3's walker change is what makes this true: a nested entry
    // used to inherit the PARENT's root (which is why probing it verbatim
    // read the parent's cage and reported a confident wrong answer, and
    // why a rewrite step existed at all). A nested `team` node carries its
    // own root, so no rewrite is needed and none happens.
    const probed: Array<{ name: string; root: string }> = [];
    const s = await sweepFleet({
      listTeams: async () => [
        team("mx", { root: "/w/mx-root" }),
        team("mx-child", { root: "/w/mx-root/children/child", level: 1, parent: "mx" }),
      ],
      probeTeam: async (t) => {
        probed.push({ name: t.name, root: t.root });
        return {
          panes: [obs({ team: t.name })],
          asks: { team: t.name, driverInboxUnread: 2, openFlags: 0, gist: "g" },
          unreadable: null,
        };
      },
      now: () => 0,
    });
    expect(probed).toEqual([
      { name: "mx", root: "/w/mx-root" },
      { name: "mx-child", root: "/w/mx-root/children/child" },
    ]);
    // Panes AND asks both come through — the sweep reaches the child's
    // whole cage, not just its panes — and nothing lands unreadable.
    expect(s.panes.map((p) => p.team)).toEqual(["mx", "mx-child"]);
    expect(s.asks.map((a) => a.team)).toEqual(["mx", "mx-child"]);
    expect(s.unreadable).toEqual([]);
  });

  test("a team whose session is DOWN reports as a pane — at every level, with no demotion", async () => {
    // The old behaviour was ASYMMETRIC on purpose: a top-level team being
    // down was news and reached the attention list, while an epic-team in
    // the same state was demoted to the unreadable line as chronic
    // bookkeeping. With epic-teams retired there is no ephemeral class
    // left to demote, so both levels now behave the same way — pinned in
    // both directions so a re-introduced demotion is a visible change.
    const s = await sweepFleet({
      listTeams: async () => [
        team("orch"),
        team("orch-child", { root: "/w/orch/children/c", level: 1, parent: "orch" }),
      ],
      probeTeam: async (t) => ({
        panes: [obs({ team: t.name, sessionUp: false, windowPresent: false, capture: null })],
        asks: null,
        unreadable: null,
      }),
      now: () => 0,
    });
    expect(s.unreadable).toEqual([]);
    expect(s.panes.map((p) => p.team)).toEqual(["orch", "orch-child"]);
    expect(s.panes.map((p) => p.sessionUp)).toEqual([false, false]);
  });

  test("a nested team with a broken pane is still swept in full", async () => {
    // Guards the removed trade-off from coming back by accident: a bad
    // pane inside a running nested cage must reach the operator.
    const s = await sweepFleet({
      listTeams: async () => [team("c-1", { root: "/w/own", level: 1, parent: "p" })],
      probeTeam: async () => ({
        panes: [obs({ team: "c-1", paneDead: true }), obs({ team: "c-1", member: "be-1" })],
        asks: null,
        unreadable: null,
      }),
      now: () => 0,
    });
    expect(s.unreadable).toEqual([]);
    expect(s.panes).toHaveLength(2);
  });

  test("no team type is special-cased out of the probe — every listed team is probed exactly once", async () => {
    // The deleted branch could skip the probe entirely (a cage-less
    // epic-team was never probed). Nothing skips it now, which is the
    // never-silently-omit contract holding without an exception.
    const probeCalls: string[] = [];
    const s = await sweepFleet({
      listTeams: async () => [
        team("a"),
        team("b", { level: 1, parent: "a" }),
        team("c", { level: 2, parent: "b" }),
      ],
      probeTeam: async (t) => {
        probeCalls.push(t.name);
        return { panes: [obs({ team: t.name })], asks: null, unreadable: null };
      },
      now: () => 0,
    });
    expect(probeCalls.sort()).toEqual(["a", "b", "c"]);
    expect(s.teamsSurveyed).toBe(3);
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
      // A down team is reported by TEAM NAME ALONE. This assertion used to
      // read `${teamName}/cage` and so encoded the bug as the contract:
      // `probeTeamLive` stamped the synthetic observation with the literal
      // string `"cage"`, `renderAttention` printed it in the member slot,
      // and the voice model relayed it aloud as "member cage" — scored as
      // a hallucination by the vox e2e judge, correctly, since no such
      // member exists (ADR-273 §Supplement-6). Recorded in place so the
      // next reader does not "restore" the slash.
      expect(captured.stdout).toContain(`${teamName} — session is down`);
      expect(captured.stdout).not.toContain(`${teamName}/cage`);
      expect(captured.stdout).not.toContain("cage —");
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
