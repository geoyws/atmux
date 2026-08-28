// ADR-273 §Supplement-4 V1 — the doctor's cage probes resolve the tmux
// session name from each team's ANCHOR, never from a hand-built
// `atmux-<team>` literal.
//
// The defect these pin is the one `cage-state.ts` already carried:
// `unum` anchors its session to `atmux_unum` (underscore) and `atmux` to
// bare `atmux`, and neither name is producible from the literal. In
// `cage-state.ts` that made every member of both live teams read as
// `down`. Here it was quieter and therefore worse to find: BOTH probes
// GATE on the name, so an anchored team produced no rows at all. Blind,
// not lying — and blind on exactly the teams worth looking at.
//
// Every fixture is a real temp `.atmux/` tree plus injected tmux, so no
// test depends on the live fleet, on cwd, or on which cages happen to be
// running.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import type { Team, TeamMember } from "../../../src/schema/team.ts";
import type { MemberCageHealth } from "../../../src/verbs/doctor/cockpit.ts";
import {
  checkLegacyWindowNameFormat,
  checkMemberCageStates,
  checkOrphanSessions,
  probeSessionName,
} from "../../../src/verbs/doctor/cockpit.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const r of tempRoots.splice(0)) await rm(r, { recursive: true, force: true });
  delete process.env.ATMUX_SESSION;
});

/** A real project root. `anchor` writes `.atmux/state/session.txt` — the
 *  file every session-name resolver in atmux reads. */
async function makeRoot(anchor?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atmux-doctor-session-"));
  tempRoots.push(root);
  await mkdir(join(root, ".atmux", "state"), { recursive: true });
  if (anchor !== undefined) {
    await writeFile(join(root, ".atmux", "state", "session.txt"), `${anchor}\n`, "utf8");
  }
  return root;
}

function member(name: string, over: Partial<TeamMember> = {}): TeamMember {
  return { name, role: "member", tui: "claude", ...over } as TeamMember;
}

function healthy(windowName: string): MemberCageHealth {
  return {
    state: "active",
    windowName,
    evidence: "",
    paneUptimeSec: 600,
    heartbeatAgeSec: null,
  } as MemberCageHealth;
}

function down(windowName: string): MemberCageHealth {
  return {
    state: "down",
    windowName,
    evidence: "no claude",
    paneUptimeSec: 600,
    heartbeatAgeSec: null,
  } as MemberCageHealth;
}

// ---------------------------------------------------------------------
// probeSessionName — the shared resolver
// ---------------------------------------------------------------------

describe("probeSessionName", () => {
  test("{ root } reads that team's own anchor — the underscore form the literal cannot build", async () => {
    const root = await makeRoot("atmux_unum");
    expect(await probeSessionName({ name: "unum", members: [] }, { root })).toBe("atmux_unum");
  });

  test("{ root } with no anchor falls back to the bare form start.ts creates (e-419553c6)", async () => {
    const root = await makeRoot();
    expect(await probeSessionName({ name: "sopx", members: [] }, { root })).toBe("sopx");
  });

  test("{ root } — the atmux team is bare like every other team now", async () => {
    const root = await makeRoot();
    expect(await probeSessionName({ name: "atmux", members: [] }, { root })).toBe("atmux");
  });

  test("{ root } IGNORES the ATMUX_SESSION env pin — it would name one team's session for every team", async () => {
    // The bug this forbids: `ATMUX_SESSION` is a process-level override
    // for the CURRENT team. Honouring it inside a cockpit walk would
    // point every team's probe at whichever cage the operator's shell
    // happened to be pinned to.
    process.env.ATMUX_SESSION = "atmux_something_else";
    const root = await makeRoot("atmux_unum");
    expect(await probeSessionName({ name: "unum", members: [] }, { root })).toBe("atmux_unum");
  });

  test("{ atmuxDir } reads the anchor at that directory", async () => {
    const root = await makeRoot("atmux_unum");
    expect(
      await probeSessionName({ name: "unum", members: [] }, { atmuxDir: join(root, ".atmux") }),
    ).toBe("atmux_unum");
  });

  test("{ atmuxDir } DOES honour the ATMUX_SESSION env pin — there it really is this team", async () => {
    // Mirror of the { root } case above. Same env, opposite answer, and
    // both are correct: the pin refers to the current team, which is
    // what this arm addresses.
    process.env.ATMUX_SESSION = "atmux_pinned";
    const root = await makeRoot("atmux_unum");
    expect(
      await probeSessionName({ name: "unum", members: [] }, { atmuxDir: join(root, ".atmux") }),
    ).toBe("atmux_pinned");
  });

  test("no source at all resolves the current team from the environment", async () => {
    process.env.ATMUX_SESSION = "atmux_current";
    expect(await probeSessionName({ name: "whatever", members: [] }, {})).toBe("atmux_current");
  });

  test("a singleSession team with no anchor fails SOFT to the bare name, never throws", async () => {
    // getSessionName raises ConfigError here. One misconfigured team must
    // not take down the whole `atmux doctor` run, and the bare name is
    // what an unanchored team's session is actually called (e-419553c6).
    const root = await makeRoot();
    const team: Team = { name: "legacy", members: [], singleSession: true };
    expect(await probeSessionName(team, { atmuxDir: join(root, ".atmux") })).toBe("legacy");
  });
});

// ---------------------------------------------------------------------
// checkMemberCageStates — the check that GATED on the literal
// ---------------------------------------------------------------------

describe("checkMemberCageStates — session name resolution", () => {
  test("probes the ANCHORED session name, not atmux-<team>", async () => {
    const root = await makeRoot("atmux_unum");
    const asked: string[] = [];
    await checkMemberCageStates({ name: "unum", members: [member("be-1")] }, join(root, ".atmux"), {
      hasSession: async (name) => {
        asked.push(name);
        return false;
      },
    });
    expect(asked).toEqual(["atmux_unum"]);
  });

  test("an anchored team now produces ROWS — before the fix the gate returned none", async () => {
    // This is the whole behaviour change. The stub answers only to the
    // anchored name, exactly as a real tmux server does, so with the old
    // `atmux-<team>` literal the gate short-circuits and no row can be
    // emitted no matter how broken the pane is.
    const root = await makeRoot("atmux_unum");
    const rows = await checkMemberCageStates(
      { name: "unum", members: [member("be-1")] },
      join(root, ".atmux"),
      {
        hasSession: async (name) => name === "atmux_unum",
        probe: async () => down("🐝-be-1"),
      },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("member-cage-state:be-1");
    expect(rows[0]?.status).toBe("yellow");
  });

  test("the literal really would have been blind — same fixture, hard-coded name, zero rows", async () => {
    // The refutation half: if the resolver were wrong, this would pass
    // too. Answering only to the literal (as a mis-anchored probe would
    // see it) must now produce nothing, proving the check follows the
    // resolved name rather than accepting either.
    const root = await makeRoot("atmux_unum");
    const rows = await checkMemberCageStates(
      { name: "unum", members: [member("be-1")] },
      join(root, ".atmux"),
      {
        hasSession: async (name) => name === "atmux-unum",
        probe: async () => down("🐝-be-1"),
      },
    );
    expect(rows).toEqual([]);
  });

  test("the resolved name is THREADED to the per-member probe, not re-derived there", async () => {
    const root = await makeRoot("atmux_unum");
    const seen: string[] = [];
    await checkMemberCageStates({ name: "unum", members: [member("be-1")] }, join(root, ".atmux"), {
      hasSession: async () => true,
      probe: async (_t, _m, sessionName) => {
        seen.push(sessionName);
        return healthy("🐝-be-1");
      },
    });
    expect(seen).toEqual(["atmux_unum"]);
  });

  test("an unanchored team probes the bare name (e-419553c6)", async () => {
    const root = await makeRoot();
    const asked: string[] = [];
    await checkMemberCageStates({ name: "sopx", members: [member("be-1")] }, join(root, ".atmux"), {
      hasSession: async (name) => {
        asked.push(name);
        return false;
      },
    });
    expect(asked).toEqual(["sopx"]);
  });
});

// ---------------------------------------------------------------------
// checkLegacyWindowNameFormat — the multi-team walk
// ---------------------------------------------------------------------

/** tmux spawn stub that answers `list-windows` only for `session`. */
function tmuxFor(
  session: string,
  windows: string[],
): {
  spawn: (argv: ReadonlyArray<string>) => Promise<SpawnResult>;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    spawn: async (argv) => {
      calls.push([...argv]);
      const target = argv[argv.indexOf("-t") + 1];
      if (target !== session) {
        return { exitCode: 1, stdout: "", stderr: "no such session" } as SpawnResult;
      }
      return { exitCode: 0, stdout: `${windows.join("\n")}\n`, stderr: "" } as SpawnResult;
    },
  };
}

describe("checkLegacyWindowNameFormat — session name resolution", () => {
  test("targets each cockpit cage's ANCHORED session, resolved from that team's own root", async () => {
    const root = await makeRoot("atmux_unum");
    const tmux = tmuxFor("atmux_unum", ["🧭_lead"]);
    await checkLegacyWindowNameFormat(null, {
      tmux: tmux.spawn,
      loadCockpitFn: async () => ({ teams: [{ root }] }) as never,
      loadTeamForRoot: async () => ({ name: "unum", members: [] }),
      socketExists: async () => true,
    });
    expect(tmux.calls).toHaveLength(1);
    expect(tmux.calls[0]).toContain("atmux_unum");
    expect(tmux.calls[0]).not.toContain("atmux-unum");
  });

  test("an anchored cage now yields a legacy-window row — before the fix the walk skipped it", async () => {
    // The behaviour change: the exitCode!==0 skip fired on every
    // anchored cage, so no offender in `unum` or `atmux` could ever be
    // reported. `🧭-lead` is the ADR-135 hyphen form; ADR-161 canonical
    // for a default-member role is `🧭_lead`.
    const root = await makeRoot("atmux_unum");
    const tmux = tmuxFor("atmux_unum", ["🧭-lead"]);
    const rows = await checkLegacyWindowNameFormat(null, {
      tmux: tmux.spawn,
      loadCockpitFn: async () => ({ teams: [{ root }] }) as never,
      loadTeamForRoot: async () => ({
        name: "unum",
        members: [member("lead", { role: "team-lead", emoji: "🧭" })],
      }),
      socketExists: async () => true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("legacy-window-name-format");
    expect(rows[0]?.detail).toContain("🧭-lead");
    // The paste-back hint must name the session that actually exists,
    // or the operator's copy of it fails.
    expect(rows[0]?.hint).toContain("atmux_unum:🧭-lead");
  });

  test("the ATMUX_SESSION pin does NOT leak across the cockpit walk", async () => {
    // Two teams, one env pin: each must be probed under its own anchor.
    // Resolving these through getSessionName would send both probes at
    // the pinned name.
    process.env.ATMUX_SESSION = "atmux_pinned";
    const a = await makeRoot("atmux_one");
    const b = await makeRoot("atmux_two");
    const calls: string[][] = [];
    await checkLegacyWindowNameFormat(null, {
      tmux: async (argv) => {
        calls.push([...argv]);
        return { exitCode: 1, stdout: "", stderr: "" } as SpawnResult;
      },
      loadCockpitFn: async () => ({ teams: [{ root: a }, { root: b }] }) as never,
      loadTeamForRoot: async (r) => ({ name: r === a ? "one" : "two", members: [] }),
      socketExists: async () => true,
    });
    const targets = calls.map((c) => c[c.indexOf("-t") + 1]);
    expect(targets).toEqual(["atmux_one", "atmux_two"]);
  });

  test("the currentTeam fallback resolves from the environment, where the pin IS this team", async () => {
    process.env.ATMUX_SESSION = "atmux_current";
    const tmux = tmuxFor("atmux_current", ["🧭_lead"]);
    await checkLegacyWindowNameFormat(
      { name: "cur", members: [member("lead", { role: "team-lead", emoji: "🧭" })] },
      {
        tmux: tmux.spawn,
        loadCockpitFn: async () => null,
        socketExists: async () => true,
      },
    );
    expect(tmux.calls[0]).toContain("atmux_current");
  });
});

// ---------------------------------------------------------------------
// checkOrphanSessions — bare names are never orphans (e-419553c6)
// ---------------------------------------------------------------------

describe("checkOrphanSessions — bare-name era", () => {
  /** Pin resolution to a temp `.atmux` so the check's getSessionName walk
   *  never reads the repo's own anchor. Restored in afterEach below. */
  let priorAtmuxDir: string | undefined;
  async function pinAtmuxDir(anchor?: string): Promise<void> {
    const root = await makeRoot(anchor);
    priorAtmuxDir = process.env.ATMUX_DIR;
    process.env.ATMUX_DIR = join(root, ".atmux");
  }
  afterEach(() => {
    if (priorAtmuxDir === undefined) delete process.env.ATMUX_DIR;
    else process.env.ATMUX_DIR = priorAtmuxDir;
    priorAtmuxDir = undefined;
  });

  test("a live BARE-named session is not flagged — only the legacy literal is probed", async () => {
    await pinAtmuxDir("legacy-anchor-name");
    const asked: string[] = [];
    const rows = await checkOrphanSessions(
      { name: "sopx", members: [], singleSession: true } as Team,
      {
        hasSession: async (name) => {
          asked.push(name);
          return name === "sopx"; // only the bare session exists
        },
      },
    );
    // The bare name is the CURRENT default — never probed as an orphan.
    expect(asked).toEqual(["atmux-sopx"]);
    expect(rows.filter((r) => r.label === "orphan-session")).toEqual([]);
  });

  test("a genuinely orphaned legacy atmux-<team> session is still flagged", async () => {
    await pinAtmuxDir(); // no anchor → resolution fails soft to bare
    const rows = await checkOrphanSessions(
      { name: "sopx", members: [], singleSession: true } as Team,
      { hasSession: async (name) => name === "atmux-sopx" },
    );
    const orphans = rows.filter((r) => r.label === "orphan-session");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.detail).toContain("atmux-sopx");
    // The paste-back hint quotes the `=` anchor — zsh's =cmd expansion
    // would otherwise break the copied command.
    expect(orphans[0]?.hint).toContain("'=atmux-sopx'");
  });

  test("a team ANCHORED to atmux-<team> is not flagged — that IS its live session", async () => {
    await pinAtmuxDir("atmux-sopx");
    const rows = await checkOrphanSessions(
      { name: "sopx", members: [], singleSession: true } as Team,
      { hasSession: async (name) => name === "atmux-sopx" },
    );
    expect(rows.filter((r) => r.label === "orphan-session")).toEqual([]);
  });
});
