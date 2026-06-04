// ADR-250 §D2 + ADR-251 — production enumerator + liveness seams that
// `atmux orchd --reap-stale` injects into the reaper core. Tests inject
// every IO seam (cockpit load, child team.json read, session-name resolve,
// uid, tmux factory) so they are filesystem- + tmux-free and deterministic.
//
//   listSpawnedEpicTeamsForTeam:
//     (a) collects ONLY epic-teams whose parent team root matches this team
//     (b) epicId == cockpit node name (the id performDissolveEpic matches on)
//     (c) cageSocket resolved via resolveTeamSocket(tmuxTmpdir) — ADR-251
//     (d) absent team.json ⇒ cageSocket "" (fail-closed)
//     (e) team.json without tmuxTmpdir ⇒ cageSocket "" (fail-closed)
//   isCageAliveForTeam:
//     (f) empty cageSocket ⇒ ALIVE, tmux never probed (fail-closed)
//     (g) live session ⇒ true; probes with exact-match `=` prefix
//     (h) no session ⇒ false (dead-cage orphan signal)
//     (i) probe throws ⇒ ALIVE (fail-closed)

import { describe, expect, test } from "bun:test";
import type { TmuxConfig, TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import type { LoadedCockpit } from "../../../src/core/cockpit.ts";
import {
  isCageAliveForTeam,
  listSpawnedEpicTeamsForTeam,
} from "../../../src/core/orchd-reap-enum.ts";
import type { SpawnedEpicTeam } from "../../../src/core/orchd-reap.ts";

function cockpitWithEpics(): LoadedCockpit {
  return {
    schemaVersion: 1,
    cockpitSession: "atmux_cockpit",
    sessions: [
      {
        type: "team",
        name: "demo",
        root: "/srv/demo",
        enabled: true,
        sessions: [
          { type: "epic-team", name: "e-alive", enabled: true, parent: "demo", epicId: "e-alive" },
          { type: "epic-team", name: "e-dead", enabled: true, parent: "demo", epicId: "e-dead" },
        ],
      },
      {
        type: "team",
        name: "other",
        root: "/srv/other",
        enabled: true,
        sessions: [
          { type: "epic-team", name: "e-other", enabled: true, parent: "other", epicId: "e-other" },
        ],
      },
    ],
    teams: [],
  } as unknown as LoadedCockpit;
}

describe("listSpawnedEpicTeamsForTeam — cockpit walk + socket resolution", () => {
  test("collects only this team's epic-teams; epicId == node name; socket via tmuxTmpdir (ADR-251)", async () => {
    const teams = await listSpawnedEpicTeamsForTeam("/srv/demo/.atmux", {
      loadCockpitFn: async () => cockpitWithEpics(),
      readEpicTeamJson: async (p) => {
        // path is `/srv/demo-epics/<epicId>/.atmux/team.json`
        const id = p.includes("e-alive") ? "e-alive" : "e-dead";
        return { name: id, tmuxTmpdir: `/tmp/atmux-demo/epics/${id}` };
      },
      resolveSessionName: async ({ name }) => `atmux-${name}`,
      uid: 0,
    });

    // e-other (parent root /srv/other) is excluded.
    expect(teams.map((t) => t.epicId).sort()).toEqual(["e-alive", "e-dead"]);

    const alive = teams.find((t) => t.epicId === "e-alive");
    expect(alive).toBeDefined();
    expect(alive?.cageSocket).toBe("/tmp/atmux-demo/epics/e-alive/tmux-0/default");
    expect(alive?.cageSessionName).toBe("atmux-e-alive");
  });

  test("absent child team.json ⇒ cageSocket '' (fail-closed)", async () => {
    const teams = await listSpawnedEpicTeamsForTeam("/srv/demo/.atmux", {
      loadCockpitFn: async () => cockpitWithEpics(),
      readEpicTeamJson: async () => null, // remnant: worktree/team.json gone
      resolveSessionName: async ({ name }) => `atmux-${name}`,
      uid: 0,
    });
    expect(teams.length).toBe(2);
    for (const t of teams) expect(t.cageSocket).toBe("");
  });

  test("team.json without tmuxTmpdir ⇒ cageSocket '' (fail-closed)", async () => {
    const teams = await listSpawnedEpicTeamsForTeam("/srv/demo/.atmux", {
      loadCockpitFn: async () => cockpitWithEpics(),
      readEpicTeamJson: async (p) => ({ name: p.includes("e-alive") ? "e-alive" : "e-dead" }),
      resolveSessionName: async ({ name }) => `atmux-${name}`,
      uid: 0,
    });
    for (const t of teams) expect(t.cageSocket).toBe("");
  });

  test("trailing-slash atmuxDir still matches the team root", async () => {
    const teams = await listSpawnedEpicTeamsForTeam("/srv/demo/.atmux/", {
      loadCockpitFn: async () => cockpitWithEpics(),
      readEpicTeamJson: async (p) => ({
        name: p.includes("e-alive") ? "e-alive" : "e-dead",
        tmuxTmpdir: "/tmp/atmux-demo/epics/x",
      }),
      resolveSessionName: async ({ name }) => `atmux-${name}`,
      uid: 0,
    });
    expect(teams.map((t) => t.epicId).sort()).toEqual(["e-alive", "e-dead"]);
  });
});

/** Fake tmux exposing just the session.hasSession path the probe uses. */
function fakeTmux(
  hasSessionImpl: (name: string) => Promise<boolean>,
  seen: { name?: string },
): (config: TmuxConfig) => TmuxNamespace {
  return () =>
    ({
      session: {
        async hasSession(name: string) {
          seen.name = name;
          return hasSessionImpl(name);
        },
      },
    }) as unknown as TmuxNamespace;
}

describe("isCageAliveForTeam — fail-closed liveness probe (ADR-251)", () => {
  const team = (over: Partial<SpawnedEpicTeam> = {}): SpawnedEpicTeam => ({
    epicId: "e-1",
    cageSessionName: "atmux-e-1",
    cageSocket: "/tmp/atmux-demo/epics/e-1/tmux-0/default",
    ...over,
  });

  test("empty cageSocket ⇒ ALIVE and tmux never probed", async () => {
    let factoryCalled = false;
    const r = await isCageAliveForTeam(team({ cageSocket: "" }), {
      tmuxFactory: () => {
        factoryCalled = true;
        return {} as unknown as TmuxNamespace;
      },
    });
    expect(r).toBe(true);
    expect(factoryCalled).toBe(false);
  });

  test("live session ⇒ true; probes with exact-match '=' prefix", async () => {
    const seen: { name?: string } = {};
    const r = await isCageAliveForTeam(team(), {
      tmuxFactory: fakeTmux(async () => true, seen),
    });
    expect(r).toBe(true);
    expect(seen.name).toBe("=atmux-e-1");
  });

  test("no live session ⇒ false (dead-cage orphan signal)", async () => {
    const seen: { name?: string } = {};
    const r = await isCageAliveForTeam(team(), {
      tmuxFactory: fakeTmux(async () => false, seen),
    });
    expect(r).toBe(false);
  });

  test("probe throws ⇒ ALIVE (fail-closed — never reap an unprobeable cage)", async () => {
    const seen: { name?: string } = {};
    const r = await isCageAliveForTeam(team(), {
      tmuxFactory: fakeTmux(async () => {
        throw new Error("tmux: connect failed");
      }, seen),
    });
    expect(r).toBe(true);
  });
});
