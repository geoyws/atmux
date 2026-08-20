// The cage plan is where the isolation guarantees are actually decided, so
// it is asserted as a pure value: every path under the temp root, every team
// with its own tmuxTmpdir, and the socket shape `resolveTeamSocket` will
// later derive. Testing this after `mkdtemp` and a live tmux server would
// mean testing it never.

import { describe, expect, test } from "bun:test";
import type { TmuxNamespace } from "../../../../../src/abstractions/tmux.ts";
import { resolveTeamSocket } from "../../../../../src/core/common.ts";
import {
  buildCagePlan,
  type CageIo,
  destroyCage,
  materializeCage,
  plannedPaths,
  shellQuote,
} from "../../../../../src/core/vox/e2e/cage.ts";
import { MUTATION_FIXTURES, TEAM_FIXTURES } from "../../../../../src/core/vox/e2e/fixtures.ts";
import { isUnder } from "../../../../../src/core/vox/e2e/isolation.ts";

const TEMP = "/tmp/atmux-vox-e2e-plan";
const UID = 1000;

function plan() {
  return buildCagePlan({ tempRoot: TEMP, uid: UID });
}

interface Recorded {
  sockets: string[];
  sessions: Array<{ socket: string; name: string; window?: string; cmd?: string }>;
  windows: Array<{ socket: string; session: string; name?: string; cmd?: string }>;
  killed: Array<{ socket: string; name: string }>;
}

function fakeIo(opts: { hasSession?: boolean; killThrows?: boolean } = {}): {
  io: CageIo;
  files: Map<string, string>;
  dirs: string[];
  rec: Recorded;
} {
  const files = new Map<string, string>();
  const dirs: string[] = [];
  const rec: Recorded = { sockets: [], sessions: [], windows: [], killed: [] };
  const io: CageIo = {
    mkdir: async (p) => {
      dirs.push(p);
    },
    writeFile: async (p, c) => {
      files.set(p, c);
    },
    tmux: (socketPath) => {
      rec.sockets.push(socketPath);
      return {
        session: {
          newSession: async (o: { name: string; windowName?: string; shellCommand?: string }) => {
            rec.sessions.push({
              socket: socketPath,
              name: o.name,
              ...(o.windowName !== undefined ? { window: o.windowName } : {}),
              ...(o.shellCommand !== undefined ? { cmd: o.shellCommand } : {}),
            });
          },
          hasSession: async () => opts.hasSession ?? true,
          killSession: async (name: string) => {
            if (opts.killThrows === true) throw new Error("tmux exploded");
            rec.killed.push({ socket: socketPath, name });
          },
        },
        window: {
          newWindow: async (o: { sessionName: string; name?: string; shellCommand?: string }) => {
            rec.windows.push({
              socket: socketPath,
              session: o.sessionName,
              ...(o.name !== undefined ? { name: o.name } : {}),
              ...(o.shellCommand !== undefined ? { cmd: o.shellCommand } : {}),
            });
            return { sessionName: o.sessionName, windowIndex: rec.windows.length };
          },
        },
      } as unknown as TmuxNamespace;
    },
  };
  return { io, files, dirs, rec };
}

describe("buildCagePlan — isolation is a property of the plan", () => {
  test("every planned path lives under the temp root", () => {
    for (const p of plannedPaths(plan())) {
      expect(isUnder(TEMP, p)).toBe(true);
    }
  });

  test("each team gets its OWN tmuxTmpdir, so each gets its own socket", () => {
    const tmpdirs = plan().teams.map((t) => t.tmuxTmpdir);
    expect(new Set(tmpdirs).size).toBe(tmpdirs.length);
  });

  test("the planned socket is exactly what resolveTeamSocket will derive", () => {
    // If these ever diverge, the gate would be checking a path the sweep
    // never uses — the most dangerous possible disagreement.
    for (const t of plan().teams) {
      expect(t.socketPath).toBe(
        resolveTeamSocket({ name: t.name, tmuxTmpdir: t.tmuxTmpdir }, { uid: UID }),
      );
    }
  });

  test("team.json carries the tmuxTmpdir and one member per fixture pane", () => {
    const alpha = plan().teams.find((t) => t.kind === "live");
    expect(alpha).toBeDefined();
    const parsed = JSON.parse(alpha?.teamJson ?? "{}") as {
      name: string;
      tmuxTmpdir: string;
      members: Array<{ name: string }>;
    };
    expect(parsed.tmuxTmpdir).toBe(alpha?.tmuxTmpdir ?? "");
    expect(parsed.members.map((m) => m.name)).toEqual(["be-1", "fe-1", "docs"]);
  });

  test("the cockpit lists only the harness's teams, all enabled", () => {
    const p = plan();
    const cockpit = JSON.parse(p.cockpitJson) as {
      sessions: Array<{ type: string; name: string; root: string; enabled: boolean }>;
    };
    expect(cockpit.sessions.map((s) => s.name)).toEqual(p.teams.map((t) => t.name));
    for (const s of cockpit.sessions) {
      expect(s.type).toBe("team");
      expect(s.enabled).toBe(true);
      expect(isUnder(TEMP, s.root)).toBe(true);
    }
  });

  test("the session name is pinned rather than left to the resolver's default", () => {
    for (const t of plan().teams) expect(t.sessionName).toBe(`atmux-${t.name}`);
  });

  test("pane commands exec a holder so pane_current_command is not a shell", () => {
    // A bare shell is what the classifier reads as 'the agent TUI died'.
    for (const t of plan().teams) {
      for (const pane of t.panes) {
        expect(pane.shellCommand).toContain("exec sleep");
        expect(pane.shellCommand).toContain(`cat '${pane.textPath}'`);
      }
    }
  });

  test("a custom fixture list is honoured", () => {
    const only = buildCagePlan({ tempRoot: TEMP, uid: UID, fixtures: [TEAM_FIXTURES[0]!] });
    expect(only.teams.length).toBe(1);
  });
});

describe("materializeCage", () => {
  test("writes the roster, anchor, pane text, and cockpit", async () => {
    const p = plan();
    const { io, files, dirs } = fakeIo();
    await materializeCage(p, io, () => 12_345);
    expect(files.get(p.cockpitPath)).toBe(p.cockpitJson);
    for (const t of p.teams) {
      expect(files.get(t.teamJsonPath)).toBe(t.teamJson);
      expect(files.get(t.anchorPath)).toBe(`${t.sessionName}\n`);
      expect(dirs).toContain(t.socketDir);
      for (const pane of t.panes) expect(files.get(pane.textPath)).toBe(pane.text);
    }
    expect(dirs).toContain(p.home);
  });

  test("brings the live session up on the team's own socket, one window per pane", async () => {
    const p = plan();
    const { io, rec } = fakeIo();
    await materializeCage(p, io, () => 0);
    const alpha = p.teams.find((t) => t.kind === "live");
    expect(rec.sessions.length).toBe(1);
    expect(rec.sessions[0]?.socket).toBe(alpha?.socketPath);
    expect(rec.sessions[0]?.name).toBe(alpha?.sessionName);
    expect(rec.sessions[0]?.window).toBe("be-1");
    // First pane rides new-session; the rest are new-window.
    expect(rec.windows.map((w) => w.name)).toEqual(["fe-1", "docs"]);
  });

  test("the ghost team gets NO tmux session — that absence is the fixture", async () => {
    const p = plan();
    const { io, rec } = fakeIo();
    await materializeCage(p, io, () => 0);
    const ghost = p.teams.find((t) => t.kind === "ghost");
    expect(rec.sockets).not.toContain(ghost?.socketPath);
  });

  test("mkdirs every directory it writes a file into", async () => {
    // The regression this pins: pane texts live outside the team root, so
    // their directory was never created and the first REAL run died on
    // ENOENT — invisible to a fake `writeFile` that happily accepts any path.
    const p = plan();
    const { io, files, dirs } = fakeIo();
    await materializeCage(p, io, () => 0);
    // `tempRoot` itself is created by mkdtemp before the plan runs.
    const made = new Set([...dirs, TEMP]);
    for (const path of files.keys()) {
      const parent = path.slice(0, path.lastIndexOf("/"));
      const covered = [...made].some((d) => parent === d || parent.startsWith(`${d}/`));
      expect(covered, `no mkdir covers ${parent}`).toBe(true);
    }
  });

  test("reports the paint time — the clock staleness is measured from", async () => {
    const { io } = fakeIo();
    const m = await materializeCage(plan(), io, () => 999);
    expect(m.paintedAtMs).toBe(999);
  });

  test("defaults its clock when none is injected", async () => {
    const { io } = fakeIo();
    const before = Date.now();
    const m = await materializeCage(plan(), io);
    expect(m.paintedAtMs).toBeGreaterThanOrEqual(before);
  });

  test("logs through the injected sink", async () => {
    const lines: string[] = [];
    const { io } = fakeIo();
    await materializeCage(plan(), { ...io, log: (l) => lines.push(l) }, () => 0);
    expect(lines.join("\n")).toContain("no tmux session on purpose");
    expect(lines.join("\n")).toContain("3 pane(s) up");
  });

  test("a live team with no panes creates no session", async () => {
    const p = buildCagePlan({
      tempRoot: TEMP,
      uid: UID,
      fixtures: [{ suffix: "empty", kind: "live", panes: [], truth: "" }],
    });
    const { io, rec } = fakeIo();
    await materializeCage(p, io, () => 0);
    expect(rec.sessions.length).toBe(0);
  });
});

describe("destroyCage", () => {
  test("kills only the live team's session, on its own socket", async () => {
    const p = plan();
    const { io, rec } = fakeIo();
    await destroyCage(p, io, () => {});
    const alpha = p.teams.find((t) => t.kind === "live");
    expect(rec.killed).toEqual([
      { socket: alpha?.socketPath ?? "", name: alpha?.sessionName ?? "" },
    ]);
  });

  test("the guard can veto, and a veto propagates", async () => {
    // This is the teardown half of the safety property: a kill aimed at the
    // wrong socket must never happen quietly.
    const { io } = fakeIo();
    await expect(
      destroyCage(plan(), io, (s) => {
        throw new Error(`refusing ${s}`);
      }),
    ).rejects.toThrow("refusing");
  });

  test("skips a session that is already gone", async () => {
    const { io, rec } = fakeIo({ hasSession: false });
    await destroyCage(plan(), io, () => {});
    expect(rec.killed).toEqual([]);
  });

  test("a tmux failure during teardown is logged, not thrown", async () => {
    // Teardown must never mask the run's own outcome.
    const lines: string[] = [];
    const { io } = fakeIo({ killThrows: true });
    await destroyCage(plan(), { ...io, log: (l) => lines.push(l) }, () => {});
    expect(lines.join("\n")).toContain("teardown of atmux-vox-e2e-alpha failed");
  });

  test("works without a log sink", async () => {
    const { io } = fakeIo();
    const { log: _drop, ...noLog } = io;
    await destroyCage(plan(), noLog, () => {});
  });
});

describe("the INTERACTIVE panes the mutating scenarios need", () => {
  function mutPlan() {
    return buildCagePlan({ tempRoot: TEMP, uid: UID, fixtures: MUTATION_FIXTURES });
  }

  test("a pane with an `after` runs a read loop that records every Enter", () => {
    const pane = mutPlan().teams[0]?.panes.find((p) => p.member === "be-1");
    expect(pane?.receiptPath).toBe(`${TEMP}/panes/vox-e2e-bravo/be-1.enters`);
    expect(pane?.afterPath).toBe(`${TEMP}/panes/vox-e2e-bravo/be-1.after.txt`);
    // The receipt append must precede the repaint: the count is the
    // evidence, and a repaint that could happen without one would let a
    // pane look nudged while proving nothing was consumed.
    const cmd = pane?.shellCommand ?? "";
    expect(cmd).toContain("while IFS= read -r _line");
    expect(cmd.indexOf("be-1.enters")).toBeLessThan(cmd.indexOf("be-1.after.txt"));
  });

  test("a pane with no `after` is unchanged — plain cat then exec sleep", () => {
    const lead = mutPlan().teams[0]?.panes.find((p) => p.member === "lead");
    expect(lead?.receiptPath).toBeNull();
    expect(lead?.afterPath).toBeNull();
    expect(lead?.shellCommand).toContain("exec sleep");
    expect(lead?.shellCommand).not.toContain("read -r");
  });

  test("the roster carries each pane's declared role, so tell_lead finds a lead", () => {
    const json = JSON.parse(mutPlan().teams[0]?.teamJson ?? "{}") as {
      members: Array<{ name: string; role: string }>;
    };
    expect(json.members.find((m) => m.name === "lead")?.role).toBe("team-lead");
    expect(json.members.find((m) => m.name === "be-1")?.role).toBe("member");
  });

  test("every interactive path — after text AND receipt — stays under the temp root", () => {
    // The receipt is written by the PANE rather than by the plan, so it
    // would be the easiest path to leave out of this assertion and the
    // only one written by a process the harness does not control.
    for (const p of plannedPaths(mutPlan())) expect(isUnder(TEMP, p)).toBe(true);
    const paths = plannedPaths(mutPlan());
    expect(paths.some((p) => p.endsWith("be-1.enters"))).toBe(true);
    expect(paths.some((p) => p.endsWith("be-1.after.txt"))).toBe(true);
  });

  test("materializeCage writes the repaint text but NOT the receipt", () => {
    // Absence is the assertion the decline and refusal scenarios rest on.
    // A pre-created empty receipt would make "absent" and "present but
    // empty" two spellings of the same evidence.
    const { io, files } = fakeIo();
    const p = mutPlan();
    return materializeCage(p, io).then(() => {
      expect(files.has(`${TEMP}/panes/vox-e2e-bravo/be-1.after.txt`)).toBe(true);
      expect(files.has(`${TEMP}/panes/vox-e2e-bravo/be-1.enters`)).toBe(false);
    });
  });
});

describe("shellQuote", () => {
  test("wraps in single quotes", () => {
    expect(shellQuote("/tmp/a b")).toBe("'/tmp/a b'");
  });

  test("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});
