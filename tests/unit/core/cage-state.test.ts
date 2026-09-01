// Unit tests for src/core/cage-state.ts (t-74273200 / c-8ecd3a61).

import { describe, expect, test } from "bun:test";
import type { SpawnOpts, SpawnResult } from "../../../src/abstractions/spawn.ts";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import {
  type CageHealth,
  cageWindowCandidates,
  hasProducedOutput,
  isAgentPane,
  parsePaneChildPsRows,
  probeCageState,
  psOutputHasDirectClaudeChild,
  resolveCageWindowName,
  STARVING_THRESHOLD_S,
  WEDGED_HEARTBEAT_STALE_SEC,
} from "../../../src/core/cage-state.ts";
import { classifyPaneObservation } from "../../../src/core/vox/fleet.ts";
import type { Team, TeamMember } from "../../../src/schema/team.ts";

// ---------- Fixtures ----------

function makeTeam(member: Partial<TeamMember> = {}): Team {
  return {
    name: "demo",
    members: [{ name: "alice", role: "member", tui: "claude", emoji: "🐝", ...member }],
  } as Team;
}

function makeMember(over: Partial<TeamMember> = {}): TeamMember {
  return { name: "alice", role: "member", tui: "claude", emoji: "🐝", ...over } as TeamMember;
}

/** Minimal TmuxNamespace stub — pane.listPanes + pane.capturePane +
 *  session.hasSession are the only methods probeCageState touches. */
interface TmuxStubOpts {
  panes?: ReadonlyArray<{ pid: number }>;
  paneText?: string;
  listPanesThrows?: boolean;
  capturePaneThrows?: boolean;
}

function tmuxStub(opts: TmuxStubOpts = {}): TmuxNamespace {
  return {
    session: {
      async hasSession() {
        return true;
      },
    },
    pane: {
      async listPanes() {
        if (opts.listPanesThrows === true) {
          throw new Error("no such window");
        }
        return opts.panes ?? [{ pid: 12345 }];
      },
      async capturePane() {
        if (opts.capturePaneThrows === true) {
          throw new Error("pane vanished");
        }
        return opts.paneText ?? "";
      },
    },
  } as unknown as TmuxNamespace;
}

const DEFAULT_OPTS = {
  paneChildIsClaude: async () => true,
  nowSec: () => 1_700_000_000,
  readHeartbeat: async () => null,
};

function spawnResult(stdout: string, exitCode = 0): SpawnResult {
  return {
    cmd: "ps",
    argv: [] as string[],
    exitCode,
    signalled: null,
    stdout,
    stderr: "",
    durationMs: 1,
  };
}

function makeSpawnProbe(
  child: () => SpawnResult,
  uptime: () => SpawnResult,
): (opts: SpawnOpts) => Promise<SpawnResult> {
  return async ({ cmd, argv = [] }) => {
    if (cmd !== "ps") throw new Error(`unexpected cmd: ${cmd}`);
    if (argv[0] === "-A") {
      return child();
    }
    if (argv[0] === "-o") {
      return uptime();
    }
    throw new Error(`unexpected argv: ${argv.join(" ")}`);
  };
}

// ---------- (1) session-missing → down ----------

describe("probeCageState — session-missing branch", () => {
  test("hasSession=false → CageHealth.state='down', no further probes fire", async () => {
    let listPanesCalls = 0;
    const tmux = {
      session: {
        async hasSession() {
          return false;
        },
      },
      pane: {
        async listPanes() {
          listPanesCalls++;
          return [];
        },
        async capturePane() {
          return "";
        },
      },
    } as unknown as TmuxNamespace;
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
      hasSession: async () => false,
    });
    expect(h.state).toBe("down");
    expect(h.evidence).toBe("");
    expect(h.paneUptimeSec).toBeNull();
    expect(h.heartbeatAgeSec).toBeNull();
    expect(listPanesCalls).toBe(0);
  });
});

describe("probeCageState — default ps probe failure and uptime parsing", () => {
  test("default child-process probe spawn failure degrades to down", async () => {
    const tmux = tmuxStub({ paneText: "❯ ↑ 5k tokens" });
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
      paneChildIsClaude: undefined,
      spawnProbe: makeSpawnProbe(
        () => {
          throw new Error("ps unavailable");
        },
        () => spawnResult("123\n"),
      ),
    });
    expect(h.state).toBe("down");
    expect(h.inferredFromRender).toBeUndefined();
    expect(h.paneUptimeSec).toBe(123);
  });

  test("default child-process probe returns down on non-zero ps exit", async () => {
    const tmux = tmuxStub({ paneText: "❯ ↑ 5k tokens" });
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
      paneChildIsClaude: undefined,
      spawnProbe: makeSpawnProbe(
        () => spawnResult("", 1),
        () => spawnResult("123\n"),
      ),
    });
    expect(h.state).toBe("down");
    expect(h.inferredFromRender).toBeUndefined();
    expect(h.paneUptimeSec).toBe(123);
  });

  test("malformed uptime output is ignored and leaves paneUptimeSec null", async () => {
    const tmux = tmuxStub({ paneText: "❯ ↑ 5k tokens" });
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
      paneChildIsClaude: undefined,
      spawnProbe: makeSpawnProbe(
        () => spawnResult("12345 claude\n"),
        () => spawnResult("not-a-number\n"),
      ),
    });
    expect(h.state).toBe("active");
    expect(h.paneUptimeSec).toBeNull();
  });

  test("uptime probe spawn failure is swallowed and leaves paneUptimeSec null", async () => {
    const tmux = tmuxStub({ paneText: "❯ ↑ 5k tokens" });
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
      paneChildIsClaude: undefined,
      spawnProbe: makeSpawnProbe(
        () => spawnResult("12345 claude\n"),
        () => {
          throw new Error("ps unavailable");
        },
      ),
    });
    expect(h.state).toBe("active");
    expect(h.paneUptimeSec).toBeNull();
  });

  test("numeric uptime output is parsed as paneUptimeSec", async () => {
    const tmux = tmuxStub({ paneText: "❯ ↑ 5k tokens" });
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
      paneChildIsClaude: undefined,
      spawnProbe: makeSpawnProbe(
        () => spawnResult("12345 claude\n"),
        () => spawnResult("456\n"),
      ),
    });
    expect(h.state).toBe("active");
    expect(h.paneUptimeSec).toBe(456);
  });
});

// ---------- (2) pane window missing → down ----------

describe("probeCageState — pane-window-missing branch", () => {
  test("listPanes throws → CageHealth.state='down'", async () => {
    const tmux = tmuxStub({ listPanesThrows: true });
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
    });
    expect(h.state).toBe("down");
    expect(h.windowName).toBe("🐝-alice");
  });

  test("listPanes returns empty array → CageHealth.state='down'", async () => {
    const tmux = tmuxStub({ panes: [] });
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
    });
    expect(h.state).toBe("down");
  });
});

// ---------- (3) no claude in child tree → down ----------

describe("probeCageState — claude-not-running branch", () => {
  test("paneChildIsClaude=false → CageHealth.state='down' (captures evidence)", async () => {
    const tmux = tmuxStub({ paneText: "$ ls -la\n$ " });
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
      paneChildIsClaude: async () => false,
    });
    expect(h.state).toBe("down");
    expect(h.evidence).toContain("$");
  });

  test("paneChildIsClaude throws → degrade to 'down' silently", async () => {
    const tmux = tmuxStub({ paneText: "..." });
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
      paneChildIsClaude: async () => {
        throw new Error("ps not found");
      },
    });
    expect(h.state).toBe("down");
  });
});

describe("parsePaneChildPsRows / psOutputHasDirectClaudeChild — portable PPID+comm parsing", () => {
  test("parses macOS/Linux-shaped rows with leading whitespace and ignores malformed rows", () => {
    const rows = parsePaneChildPsRows(`
       101 /opt/homebrew/bin/node
      202 claude-code
      303 /usr/local/bin/claude
      bad row

      404 /opt/homebrew/bin/python3
    `);
    expect(rows).toEqual([
      { ppid: 101, comm: "/opt/homebrew/bin/node" },
      { ppid: 202, comm: "claude-code" },
      { ppid: 303, comm: "/usr/local/bin/claude" },
      { ppid: 404, comm: "/opt/homebrew/bin/python3" },
    ]);
  });

  test("matches only the exact requested PPID and accepts full-path comm output", () => {
    const stdout = [
      "100 /opt/homebrew/bin/node",
      "101 /opt/homebrew/bin/claude",
      "101 /opt/homebrew/bin/claude-code",
      "102 /opt/homebrew/bin/node",
      "101 /usr/local/bin/python3",
    ].join("\n");
    expect(psOutputHasDirectClaudeChild(101, stdout)).toBe(true);
    expect(psOutputHasDirectClaudeChild(100, stdout)).toBe(true);
    expect(psOutputHasDirectClaudeChild(102, stdout)).toBe(true);
    expect(psOutputHasDirectClaudeChild(103, stdout)).toBe(false);
  });

  test("rejects non-agent commands and empty output", () => {
    expect(psOutputHasDirectClaudeChild(4242, "")).toBe(false);
    expect(
      psOutputHasDirectClaudeChild(
        4242,
        ["4242 /usr/bin/python3", "4242 /usr/bin/bash", "4242 /opt/homebrew/bin/grep"].join("\n"),
      ),
    ).toBe(false);
  });
});

// ---------- (4) RATE-LIMIT pane → wedged ----------

describe("probeCageState — RATE-LIMIT wedged branch", () => {
  test("pane text matches 'hit your limit' → state='wedged'", async () => {
    const tmux = tmuxStub({
      paneText: "❯ ↑ 5k tokens\nYou've hit your limit. Try again in 4h.",
    });
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
    });
    expect(h.state).toBe("wedged");
    expect(h.evidence).toContain("hit your limit");
  });

  test("RATE-LIMIT precedes tokens-moved check (tokens=0 + rate-limit still wedged)", async () => {
    // A claude that hit its limit before producing any tokens is
    // still wedged (not bootstrapping) — the operator-actionable
    // signal is the rate-limit banner.
    const tmux = tmuxStub({ paneText: "You've hit your limit." });
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
    });
    expect(h.state).toBe("wedged");
  });

  test("RATE-LIMIT wedged still surfaces heartbeatAgeSec when heartbeat available", async () => {
    const tmux = tmuxStub({ paneText: "hit your limit" });
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
      nowSec: () => 1_700_000_100,
      readHeartbeat: async () => 1_700_000_000, // 100s ago
    });
    expect(h.state).toBe("wedged");
    expect(h.heartbeatAgeSec).toBe(100);
  });
});

// ---------- (5) tokens not moved → bootstrapping ----------

describe("probeCageState — bootstrapping branch", () => {
  test("welcome screen (no tokens shape, no rate-limit) → state='bootstrapping'", async () => {
    const tmux = tmuxStub({
      paneText: "Welcome to Claude Code\n❯ (try a prompt)",
    });
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
    });
    expect(h.state).toBe("bootstrapping");
    expect(h.evidence).toContain("Welcome");
  });

  test("compose box only (`❯`) with no tokens → bootstrapping (covers fresh /clear)", async () => {
    const tmux = tmuxStub({ paneText: "❯ " });
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
    });
    expect(h.state).toBe("bootstrapping");
  });

  test("bootstrapping does NOT consult heartbeat (heartbeatAgeSec is null)", async () => {
    let hbCalls = 0;
    const tmux = tmuxStub({ paneText: "Welcome to Claude Code" });
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
      readHeartbeat: async () => {
        hbCalls++;
        return 1_700_000_000;
      },
    });
    expect(h.state).toBe("bootstrapping");
    expect(h.heartbeatAgeSec).toBeNull();
    expect(hbCalls).toBe(0);
  });
});

// ---------- (6) heartbeat stale → wedged ----------

describe("probeCageState — heartbeat-stale wedged branch", () => {
  test("tokens moved + heartbeat older than 2h ceiling → state='wedged'", async () => {
    const tmux = tmuxStub({ paneText: "❯ ↑ 12k tokens" });
    const nowSec = 1_700_000_000;
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
      nowSec: () => nowSec,
      readHeartbeat: async () => nowSec - (WEDGED_HEARTBEAT_STALE_SEC + 1),
    });
    expect(h.state).toBe("wedged");
    expect(h.heartbeatAgeSec).toBe(WEDGED_HEARTBEAT_STALE_SEC + 1);
  });

  test("tokens moved + heartbeat exactly AT 2h threshold → state='active' (strictly >)", async () => {
    const tmux = tmuxStub({ paneText: "❯ ↑ 12k tokens" });
    const nowSec = 1_700_000_000;
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
      nowSec: () => nowSec,
      readHeartbeat: async () => nowSec - WEDGED_HEARTBEAT_STALE_SEC,
    });
    expect(h.state).toBe("active");
    expect(h.heartbeatAgeSec).toBe(WEDGED_HEARTBEAT_STALE_SEC);
  });

  test("tokens moved + fresh heartbeat → state='active'", async () => {
    const tmux = tmuxStub({ paneText: "tokens · 42%" });
    const nowSec = 1_700_000_000;
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
      nowSec: () => nowSec,
      readHeartbeat: async () => nowSec - 60,
    });
    expect(h.state).toBe("active");
    expect(h.heartbeatAgeSec).toBe(60);
  });
});

// ---------- (7) active fallthrough ----------

describe("probeCageState — active branch (no heartbeat file)", () => {
  test("tokens moved + heartbeat absent (null) → state='active' (don't false-flag)", async () => {
    // Heartbeat write path is bash-side today; absence is the COMMON
    // case. We must NOT flag every active member as wedged just
    // because nobody wrote a heartbeat file.
    const tmux = tmuxStub({ paneText: "❯ ↑ 5k tokens ↓ 1k" });
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
      readHeartbeat: async () => null,
    });
    expect(h.state).toBe("active");
    expect(h.heartbeatAgeSec).toBeNull();
  });

  test("active state carries evidence (pane capture tail)", async () => {
    const tail = "tokens · 12% remaining\n❯ some prompt";
    const tmux = tmuxStub({ paneText: tail });
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
    });
    expect(h.state).toBe("active");
    expect(h.evidence).toContain("12%");
  });
});

// ---------- Composite invariants ----------

describe("probeCageState — composite + invariants", () => {
  test("windowName uses ADR-135 hyphen separator for user-added members (role=member)", async () => {
    const tmux = tmuxStub({ paneText: "❯ ↑ 5k tokens" });
    const h = await probeCageState(
      makeTeam(),
      makeMember({ name: "lead", emoji: "🧭" }),
      "/tmp/x",
      {
        ...DEFAULT_OPTS,
        tmux,
      },
    );
    expect(h.windowName).toBe("🧭-lead");
  });

  test("windowName uses ADR-161 _-prefix for default-member roles (team-lead/planner/reviewer/ombudsman)", async () => {
    // The bug this test guards against: the probe used to manually build
    // `${emoji}${name}` (no separator), so for a real `role: "team-lead"`
    // member named `lead` with emoji `🧭` it would look up window `🧭lead`
    // while spawn-side `start.ts` (via `buildWindowName`) wrote `🧭_lead`
    // → probe reported `down` on a perfectly healthy pane.
    const tmux = tmuxStub({ paneText: "❯ ↑ 5k tokens" });
    const h = await probeCageState(
      makeTeam({ name: "lead", role: "team-lead", emoji: "🧭" }),
      makeMember({ name: "lead", role: "team-lead", emoji: "🧭" }),
      "/tmp/x",
      { ...DEFAULT_OPTS, tmux },
    );
    expect(h.windowName).toBe("🧭_lead");
  });

  test("windowName uses label override when member.label is set (ADR-136 TR4)", async () => {
    const tmux = tmuxStub({ paneText: "❯ ↑ 5k tokens" });
    const h = await probeCageState(
      makeTeam({ label: "renamed-alice" }),
      makeMember({ label: "renamed-alice" }),
      "/tmp/x",
      { ...DEFAULT_OPTS, tmux },
    );
    expect(h.windowName).toBe("🐝-renamed-alice");
  });

  test("member without explicit emoji → defaultEmojiForRole picks one based on role", async () => {
    const tmux = tmuxStub({ paneText: "❯ ↑ 5k tokens" });
    const h = await probeCageState(
      makeTeam({ emoji: undefined, role: "reviewer" }),
      makeMember({ emoji: undefined, role: "reviewer" }),
      "/tmp/x",
      { ...DEFAULT_OPTS, tmux },
    );
    // role=reviewer → some emoji prefix from common.ts; we don't
    // pin the exact glyph (would tie us to common.ts internals),
    // just assert the suffix is the member name.
    expect(h.windowName.endsWith("alice")).toBe(true);
  });

  test("evidence truncated to ≤200 chars (tail of capture)", async () => {
    const longText = "x".repeat(500) + "TAIL_MARKER";
    const tmux = tmuxStub({ paneText: longText });
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
      paneChildIsClaude: async () => false, // forces evidence path on down state
    });
    expect(h.evidence.length).toBeLessThanOrEqual(200);
    expect(h.evidence).toContain("TAIL_MARKER");
  });

  test("STARVING_THRESHOLD_S constant is re-exported (60s — matches ADR-081 §D)", () => {
    expect(STARVING_THRESHOLD_S).toBe(60);
  });

  test("WEDGED_HEARTBEAT_STALE_SEC constant is 7200 (2h per task body)", () => {
    expect(WEDGED_HEARTBEAT_STALE_SEC).toBe(7200);
  });

  test("CageHealth shape — all fields present on every branch", async () => {
    const cases: Array<{ paneText?: string; childClaude: boolean; expected: CageHealth["state"] }> =
      [
        { childClaude: false, expected: "down" },
        { paneText: "Welcome", childClaude: true, expected: "bootstrapping" },
        { paneText: "❯ ↑ 5k tokens", childClaude: true, expected: "active" },
        { paneText: "hit your limit", childClaude: true, expected: "wedged" },
      ];
    for (const c of cases) {
      const tmux = tmuxStub({ paneText: c.paneText ?? "" });
      const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
        ...DEFAULT_OPTS,
        tmux,
        paneChildIsClaude: async () => c.childClaude,
      });
      expect(h.state).toBe(c.expected);
      expect(h.member).toBe("alice");
      expect(h.windowName).toBe("🐝-alice");
      expect(typeof h.evidence).toBe("string");
      // paneUptimeSec may be null when /proc has no record for the
      // stub PID — accept null OR number.
      expect(h.paneUptimeSec === null || typeof h.paneUptimeSec === "number").toBe(true);
      expect(h.heartbeatAgeSec === null || typeof h.heartbeatAgeSec === "number").toBe(true);
    }
  });
});

// ---------- ADR-273 D3 trap 1: the session name is not `atmux-<team>` ----------

describe("probeCageState — sessionName override (ADR-273 D3 trap 1)", () => {
  /** Capture whatever session name the probe actually asks tmux about. */
  function nameSpy(): {
    asked: string[];
    opts: { hasSession: (n: string) => Promise<boolean> };
  } {
    const asked: string[] = [];
    return {
      asked,
      opts: {
        hasSession: async (n: string) => {
          asked.push(n);
          return false;
        },
      },
    };
  }

  test("without the override it asks for the bare `<team>` form (e-419553c6)", async () => {
    // Pins the fallback as UNCHANGED, so callers that have not been
    // updated behave exactly as they did before this seam landed.
    const spy = nameSpy();
    await probeCageState(makeTeam(), makeMember(), "/tmp/x", { ...DEFAULT_OPTS, ...spy.opts });
    expect(spy.asked).toEqual(["demo"]);
  });

  test("the override is what tmux is asked about — the anchored name wins", async () => {
    // The live failure: `unum` anchors its session to `atmux_unum`
    // (underscore) and `atmux` to bare `atmux`. Rebuilding `atmux-<team>`
    // names a session that does not exist, so step (1) reports every
    // member of a healthy team as `down`.
    for (const anchored of ["atmux_unum", "atmux"]) {
      const spy = nameSpy();
      await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
        ...DEFAULT_OPTS,
        ...spy.opts,
        sessionName: anchored,
      });
      expect(spy.asked).toEqual([anchored]);
      expect(spy.asked).not.toContain("atmux-demo");
    }
  });

  test("with the resolved name a LIVE team stops being reported as down", async () => {
    // Same team, same probe, same tmux — only the resolved name differs,
    // and the verdict flips from `down` to a real state. This is the bug
    // ADR-273 D3 trap 1 names, reproduced and then closed.
    const liveSessions = new Set(["atmux_unum"]);
    const tmux = {
      session: {
        async hasSession(n: string) {
          return liveSessions.has(n);
        },
      },
      pane: {
        async listPanes() {
          return [{ pid: 4242 }];
        },
        async capturePane() {
          return "42k tokens · esc to interrupt";
        },
      },
    } as unknown as TmuxNamespace;
    const opts = {
      ...DEFAULT_OPTS,
      tmux,
      hasSession: async (n: string) => liveSessions.has(n),
    };
    const wrong = await probeCageState(makeTeam(), makeMember(), "/tmp/x", opts);
    expect(wrong.state).toBe("down");
    const right = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...opts,
      sessionName: "atmux_unum",
    });
    expect(right.state).toBe("active");
  });
});

// ---------- Window resolution: probe the window that EXISTS ----------
//
// The defect these cover, in full: `probeCageState` SYNTHESIZED its target
// window name. It took `member.emoji ?? defaultEmojiForRole(role)` — so a
// roster entry carrying no emoji had a `🐝` invented for it — and probed
// `<session>:🐝-be-1`. A cage whose windows are plainly named `be-1` /
// `fe-1` / `docs` answers `can't find window`, the catch under step (2)
// returns `down`, and `atmux status` prints three `down` panes on the line
// directly beneath a session it has just called `[up]`.
//
// `atmux fleet` never had it, off the very same socket, because it
// ENUMERATES windows instead of guessing their names. These tests pin that
// discipline here: the probe must target a window tmux actually reports.

/** A tmux stub that owns a window LIST and records every `listPanes`
 *  target, so a test can assert WHICH window was probed — not merely which
 *  verdict came back. `listPanes` answers only for windows that exist,
 *  exactly as tmux does. */
function windowedTmux(opts: { windows: ReadonlyArray<string>; paneText?: string }): {
  tmux: TmuxNamespace;
  targets: string[];
} {
  const targets: string[] = [];
  const live = new Set(opts.windows);
  const tmux = {
    session: {
      async hasSession() {
        return true;
      },
    },
    window: {
      async listWindows() {
        return opts.windows.map((name, index) => ({ index, id: `@${index}`, name, active: false }));
      },
    },
    pane: {
      async listPanes(target: string) {
        targets.push(target);
        const win = target.slice(target.indexOf(":") + 1);
        if (!live.has(win)) throw new Error(`can't find window: ${win}`);
        return [{ pid: 4242 }];
      },
      async capturePane() {
        return opts.paneText ?? "42k tokens · esc to interrupt";
      },
    },
  } as unknown as TmuxNamespace;
  return { tmux, targets };
}

describe("isAgentPane / hasProducedOutput — which renders count as evidence", () => {
  test("only SHELL and UNKNOWN carry no agent signal", () => {
    for (const s of ["BUSY", "MODAL", "TYPING", "COMPACTING", "RATE-LIMIT", "READY"] as const) {
      expect(isAgentPane(s)).toBe(true);
    }
    expect(isAgentPane("SHELL")).toBe(false);
    expect(isAgentPane("UNKNOWN")).toBe(false);
  });

  test("READY is NOT proof of output — a bare compose prompt IS bootstrapping", () => {
    // The load-bearing exclusion: fold READY in here and the
    // `bootstrapping` state stops existing.
    expect(hasProducedOutput("READY")).toBe(false);
    expect(hasProducedOutput("SHELL")).toBe(false);
    expect(hasProducedOutput("UNKNOWN")).toBe(false);
    expect(hasProducedOutput("RATE-LIMIT")).toBe(false);
  });

  test("a spinner, a modal, queued text or a compaction all prove a turn ran", () => {
    for (const s of ["BUSY", "MODAL", "TYPING", "COMPACTING"] as const) {
      expect(hasProducedOutput(s)).toBe(true);
    }
  });
});

describe("probeCageState — a working session is not called 'bootstrapping'", () => {
  test("a modal pane with no token footer reads active, not bootstrapping", async () => {
    // `TOKENS_MOVED_RE` reads the status-line footer, and a permission
    // modal pushes it out of the captured window. The session has plainly
    // produced output; calling it "tokens have never moved" is false.
    const { tmux } = windowedTmux({
      windows: ["alice"],
      paneText: "● Read 240 lines\n\n│ Do you want to make this edit?\n│ ❯ 1. Yes\n",
    });
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", { ...DEFAULT_OPTS, tmux });
    expect(h.state).toBe("active");
  });

  test("a genuine welcome banner still reads bootstrapping", async () => {
    // The complement: no footer AND no proof-of-output render.
    const { tmux } = windowedTmux({
      windows: ["alice"],
      paneText: "Welcome to Claude Code\n❯ (try a prompt)",
    });
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", { ...DEFAULT_OPTS, tmux });
    expect(h.state).toBe("bootstrapping");
  });
});

describe("cageWindowCandidates — the naming forms a live window may carry", () => {
  test("an emoji-less roster offers the BARE window name, not only an invented-emoji one", () => {
    const { canonical, all } = cageWindowCandidates(makeMember({ name: "be-1", emoji: undefined }));
    // Canonical stays the form `start.ts` would have spawned…
    expect(canonical).toBe("🐝-be-1");
    // …but the bare name the roster literally describes is offered too.
    // Its absence was the whole bug: nothing ever probed `be-1`.
    expect(all).toContain("be-1");
    expect(all[0]).toBe("🐝-be-1");
  });

  test("a pinned roster emoji offers canonical, ADR-135 hyphen and pre-ADR-135 legacy forms", () => {
    const { canonical, all } = cageWindowCandidates(
      makeMember({ name: "lead", role: "team-lead", emoji: "🧭" }),
    );
    expect(canonical).toBe("🧭_lead"); // ADR-161 `_` for default roles
    expect(all).toContain("🧭-lead"); // ADR-135 hyphen
    expect(all).toContain("🧭lead"); // pre-ADR-135 no separator
    expect(all).toContain("lead"); // bare id
  });

  test("a hot-renamed member (ADR-136 label) still offers its immutable id", () => {
    const { canonical, all } = cageWindowCandidates(
      makeMember({ name: "be-1", label: "backend", emoji: "🐝" }),
    );
    expect(canonical).toBe("🐝-backend");
    expect(all).toContain("be-1");
  });

  test("candidates are deduped — one form is never offered twice", () => {
    const { all } = cageWindowCandidates(makeMember({ name: "alice", emoji: "🐝" }));
    expect(new Set(all).size).toBe(all.length);
  });

  test("a roster entry with no role at all falls back to the default-member shape", () => {
    // `role` is optional in the schema; an entry omitting it must not be
    // read as a default-member role (which would render `_`, not `-`).
    const { canonical, all } = cageWindowCandidates(
      makeMember({ name: "solo", role: undefined, emoji: undefined }),
    );
    expect(canonical).toBe("🐝-solo");
    expect(all).toContain("solo");
  });
});

describe("resolveCageWindowName — first LIVE candidate wins", () => {
  test("resolves the bare window an emoji-less roster actually occupies", async () => {
    const name = await resolveCageWindowName(
      "atmux-vox",
      makeMember({ name: "be-1", emoji: undefined }),
      async () => ["be-1", "fe-1", "docs"],
    );
    expect(name).toBe("be-1");
  });

  test("prefers the atmux-spawned form when a legacy window coexists with it", async () => {
    const name = await resolveCageWindowName("s", makeMember(), async () => [
      "🐝alice",
      "🐝-alice",
    ]);
    expect(name).toBe("🐝-alice");
  });

  test("falls back to the spawn form when NO candidate is live", async () => {
    const name = await resolveCageWindowName("s", makeMember({ emoji: undefined }), async () => [
      "someone-else",
    ]);
    // Names the shape the operator would go looking for — the same
    // convention `resolveExistingWindowName` already follows.
    expect(name).toBe("🐝-alice");
  });

  test("falls back to the spawn form when the window list cannot be read at all", async () => {
    const name = await resolveCageWindowName("s", makeMember(), async () => {
      throw new Error("tmux server gone");
    });
    expect(name).toBe("🐝-alice");
  });
});

describe("probeCageState — a live pane on a live session is never 'down'", () => {
  test("emoji-less roster + bare live windows → active, and `be-1` is what got probed", async () => {
    // The voice-e2e cage shape verbatim: session up, three plainly-named
    // windows, roster carrying no emoji. Pre-fix every row read `down`.
    const { tmux, targets } = windowedTmux({ windows: ["be-1", "fe-1", "docs"] });
    const h = await probeCageState(
      makeTeam({ name: "be-1", emoji: undefined }),
      makeMember({ name: "be-1", emoji: undefined }),
      "/tmp/x",
      { ...DEFAULT_OPTS, tmux },
    );
    expect(h.state).toBe("active");
    expect(h.windowName).toBe("be-1");
    // The invented name must never have been probed at all.
    expect(targets).toEqual(["demo:be-1"]);
    expect(targets).not.toContain("atmux-demo:🐝-be-1");
  });

  test("a window in the pre-ADR-135 legacy form is found, not reported down", async () => {
    const { tmux, targets } = windowedTmux({ windows: ["🐝alice"] });
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", { ...DEFAULT_OPTS, tmux });
    expect(h.state).toBe("active");
    expect(h.windowName).toBe("🐝alice");
    expect(targets).toEqual(["demo:🐝alice"]);
  });

  test("a member with genuinely no window still reports down — absence is not papered over", async () => {
    // The complement, and the reason this is a RESOLUTION fix rather than
    // a "stop saying down" fix: when the member's window really is gone,
    // `down` is still the answer.
    const { tmux } = windowedTmux({ windows: ["someone-else"] });
    const h = await probeCageState(
      makeTeam({ name: "ghost", emoji: undefined }),
      makeMember({ name: "ghost", emoji: undefined }),
      "/tmp/x",
      { ...DEFAULT_OPTS, tmux },
    );
    expect(h.state).toBe("down");
    expect(h.windowName).toBe("🐝-ghost");
  });

  test("a caller-supplied window list is used instead of a per-member list-windows call", async () => {
    // `status` hoists ONE `list-windows` for the whole roster and hands
    // the names down; if the seam were ignored the probe would fall back
    // to its own (here: empty) window namespace and report `down`.
    let listWindowsCalls = 0;
    const { tmux } = windowedTmux({ windows: ["be-1"] });
    const wrapped = {
      ...tmux,
      window: {
        async listWindows() {
          listWindowsCalls += 1;
          return [];
        },
      },
    } as unknown as TmuxNamespace;
    const h = await probeCageState(
      makeTeam({ name: "be-1", emoji: undefined }),
      makeMember({ name: "be-1", emoji: undefined }),
      "/tmp/x",
      { ...DEFAULT_OPTS, tmux: wrapped, listWindowNames: async () => ["be-1"] },
    );
    expect(h.state).toBe("active");
    expect(listWindowsCalls).toBe(0);
  });

  test("session missing → down naming the spawn form, window list never consulted", async () => {
    let listWindowsCalls = 0;
    const tmux = {
      session: {
        async hasSession() {
          return false;
        },
      },
      window: {
        async listWindows() {
          listWindowsCalls += 1;
          return [];
        },
      },
      pane: {
        async listPanes() {
          return [];
        },
        async capturePane() {
          return "";
        },
      },
    } as unknown as TmuxNamespace;
    const h = await probeCageState(makeTeam(), makeMember({ emoji: undefined }), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux,
      hasSession: async () => false,
    });
    expect(h.state).toBe("down");
    expect(h.windowName).toBe("🐝-alice");
    expect(listWindowsCalls).toBe(0);
  });

  test("a live agent pane whose process cannot be identified is NOT called down", async () => {
    // The vox e2e cage: the panes render an unmistakable Claude Code TUI
    // but hold no `claude` process at all, so `ps --ppid` finds nothing.
    // Reporting `down` let the weakest rung in the ladder veto the
    // strongest, and `team_status` spoke it aloud as fact.
    const { tmux } = windowedTmux({
      windows: ["be-1"],
      paneText: "● Reading src/invoice.ts\n\n│ Do you want to make this edit?\n│ ❯ 1. Yes\n",
    });
    const h = await probeCageState(
      makeTeam({ name: "be-1", emoji: undefined }),
      makeMember({ name: "be-1", emoji: undefined }),
      "/tmp/x",
      { ...DEFAULT_OPTS, tmux, paneChildIsClaude: async () => false },
    );
    expect(h.state).not.toBe("down");
    // …and it says so: the state came off the screen, not off `ps`.
    expect(h.inferredFromRender).toBe(true);
  });

  test("a pane with NO agent signal and no claude process is still down", async () => {
    // Both signals agree. This is the case the fix must NOT swallow — it
    // is the difference between a resolution fix and a false green.
    const { tmux } = windowedTmux({ windows: ["be-1"], paneText: "$ ls -la\n$ " });
    const h = await probeCageState(
      makeTeam({ name: "be-1", emoji: undefined }),
      makeMember({ name: "be-1", emoji: undefined }),
      "/tmp/x",
      { ...DEFAULT_OPTS, tmux, paneChildIsClaude: async () => false },
    );
    expect(h.state).toBe("down");
    // A `down` row is a CONFIDENT conclusion — two agreeing observations —
    // so it must not advertise doubt it does not have.
    expect(h.inferredFromRender).toBeUndefined();
  });

  test("a confirmed claude process is never marked inferred", async () => {
    const { tmux } = windowedTmux({
      windows: ["alice"],
      paneText: "42k tokens · esc to interrupt",
    });
    const h = await probeCageState(
      makeTeam({ emoji: undefined }),
      makeMember({ emoji: undefined }),
      "/tmp/x",
      {
        ...DEFAULT_OPTS,
        tmux,
        paneChildIsClaude: async () => true,
      },
    );
    expect(h.state).toBe("active");
    expect(h.inferredFromRender).toBe(false);
  });

  test("the production default reads the live window list off tmux itself", async () => {
    // No `listWindowNames` injected — proves the default seam is wired to
    // `tmux.window.listWindows`, not to a synthesized guess.
    const { tmux, targets } = windowedTmux({ windows: ["docs"] });
    const h = await probeCageState(
      makeTeam({ name: "docs", emoji: undefined }),
      makeMember({ name: "docs", emoji: undefined }),
      "/tmp/x",
      { ...DEFAULT_OPTS, tmux },
    );
    expect(h.state).toBe("active");
    expect(targets).toEqual(["demo:docs"]);
  });
});

// ---------------------------------------------------------------------
// ADR-273 §Supplement-6 — the SECOND verdict, from the SAME evidence
// ---------------------------------------------------------------------
//
// W6: `team_status` said "active" about a pane blocked forever on a
// permission prompt while `fleet_attention`, off the same socket, said
// "waiting on a permission prompt". Both were true in their own
// vocabulary and the operator got two incompatible pictures. The fix is
// not a third taxonomy — it is this probe returning the BEHAVIOURAL
// verdict alongside the process one, computed from the SAME capture, so
// the two cannot drift.
//
// Would these pass if `agentState` were never populated? No: every one
// asserts a specific kind, and the last asserts the probe agrees with
// `classifyPaneObservation` run directly on the same text.

/** tmux stub that also answers the window probe (activity clock etc). */
function probedTmux(opts: {
  windows: ReadonlyArray<string>;
  paneText?: string;
  /** Raw `WINDOW_PROBE_FORMAT` answer. */
  probeRaw?: string;
  capturePaneThrows?: boolean;
}): { tmux: TmuxNamespace; displayCalls: () => number; captureCalls: () => number } {
  const counters = { display: 0, capture: 0 };
  const live = new Set(opts.windows);
  const tmux = {
    session: {
      async hasSession() {
        return true;
      },
    },
    window: {
      async listWindows() {
        return opts.windows.map((name, index) => ({ index, id: `@${index}`, name, active: false }));
      },
    },
    pane: {
      async listPanes(target: string) {
        const win = target.slice(target.indexOf(":") + 1);
        if (!live.has(win)) throw new Error(`can't find window: ${win}`);
        return [{ pid: 4242 }];
      },
      async capturePane() {
        counters.capture += 1;
        if (opts.capturePaneThrows === true) throw new Error("pane vanished");
        return opts.paneText ?? "42k tokens · esc to interrupt";
      },
      async displayMessage() {
        counters.display += 1;
        return opts.probeRaw ?? "1700000000\t0\tclaude";
      },
    },
  } as unknown as TmuxNamespace;
  return {
    tmux,
    displayCalls: () => counters.display,
    captureCalls: () => counters.capture,
  };
}

const BLOCKED_TEXT = [
  "● Reading src/core/billing/invoice.ts",
  "│ Do you want to make this edit?                           │",
  "│ ❯ 1. Yes                                                 │",
].join("\n");

const RESIDUE_TEXT = [
  "● Ran the migration and the suite is green.",
  "✻ Worked for 22s",
  "❯ also add the rollback path before you push",
  "  ⏵⏵ auto mode on                    tok 4821/200000  ctx 12%",
].join("\n");

const WORKING_TEXT = [
  "● Refactoring the scheduler.",
  "✻ Cogitating… (12s · ↑ 1.4k tokens · esc to interrupt)",
  "❯ ",
  "  ⏵⏵ auto mode on                    tok 9102/200000  ctx 21%",
].join("\n");

describe("probeCageState — agentState is the behavioural verdict, alongside state", () => {
  test("a pane blocked on a permission prompt: process 'active', agent 'permission-prompt'", async () => {
    // The W6 case exactly. `active` stays true — the process IS running —
    // and the row now also says the thing the operator asked about.
    const { tmux } = probedTmux({ windows: ["alice"], paneText: BLOCKED_TEXT });
    const h = await probeCageState(
      makeTeam({ emoji: undefined }),
      makeMember({ emoji: undefined }),
      "/tmp/x",
      { ...DEFAULT_OPTS, tmux },
    );
    expect(h.state).toBe("active");
    expect(h.agentState).toEqual({
      bucket: "attention",
      kind: "permission-prompt",
      marker: "│ Do you want to make this edit?                           │",
    });
  });

  test("a wedged composer reads idle-residue once the window has gone stale", async () => {
    const { tmux } = probedTmux({
      windows: ["alice"],
      paneText: RESIDUE_TEXT,
      // Activity 300s before `nowSec` — past RESIDUE_FRESH_SEC.
      probeRaw: "1699999700\t0\tsleep",
    });
    const h = await probeCageState(
      makeTeam({ emoji: undefined }),
      makeMember({ emoji: undefined }),
      "/tmp/x",
      { ...DEFAULT_OPTS, tmux },
    );
    expect(h.agentState?.bucket).toBe("attention");
    expect(h.agentState?.kind).toBe("idle-residue");
  });

  test("the SAME composer in a freshly-touched window is someone typing, not a wedge", async () => {
    // The complement — and proof the activity clock actually reaches the
    // classifier rather than being dropped on the floor.
    const { tmux } = probedTmux({
      windows: ["alice"],
      paneText: RESIDUE_TEXT,
      probeRaw: "1699999999\t0\tsleep",
    });
    const h = await probeCageState(
      makeTeam({ emoji: undefined }),
      makeMember({ emoji: undefined }),
      "/tmp/x",
      { ...DEFAULT_OPTS, tmux },
    );
    expect(h.agentState).toEqual({ bucket: "quiet", kind: "idle" });
  });

  test("a mid-turn pane reads quiet/working", async () => {
    const { tmux } = probedTmux({ windows: ["alice"], paneText: WORKING_TEXT });
    const h = await probeCageState(
      makeTeam({ emoji: undefined }),
      makeMember({ emoji: undefined }),
      "/tmp/x",
      { ...DEFAULT_OPTS, tmux },
    );
    expect(h.agentState).toEqual({ bucket: "quiet", kind: "working" });
  });

  test("session absent → agent 'dead', in the words fleet_attention uses", async () => {
    const h = await probeCageState(makeTeam(), makeMember(), "/tmp/x", {
      ...DEFAULT_OPTS,
      tmux: tmuxStub(),
      hasSession: async () => false,
    });
    expect(h.state).toBe("down");
    expect(h.agentState).toEqual({
      bucket: "attention",
      kind: "dead",
      marker: "tmux session absent",
    });
  });

  test("window missing → agent 'dead' naming the window, not 'unresponsive'", async () => {
    const { tmux } = probedTmux({ windows: ["someone-else"] });
    const h = await probeCageState(
      makeTeam({ emoji: undefined }),
      makeMember({ emoji: undefined }),
      "/tmp/x",
      { ...DEFAULT_OPTS, tmux },
    );
    expect(h.state).toBe("down");
    expect(h.agentState?.kind).toBe("dead");
    expect(h.agentState?.bucket).toBe("attention");
  });

  test("a capture that FAILED reads 'unreadable', never 'pane is blank'", async () => {
    // `""` and `null` are different claims: "I looked and saw nothing" vs
    // "I could not look". Collapsing them is how a probe manufactures a
    // confident verdict out of a failure.
    const { tmux } = probedTmux({ windows: ["alice"], capturePaneThrows: true });
    const h = await probeCageState(
      makeTeam({ emoji: undefined }),
      makeMember({ emoji: undefined }),
      "/tmp/x",
      { ...DEFAULT_OPTS, tmux, paneChildIsClaude: async () => true },
    );
    expect(h.agentState).toEqual({
      bucket: "attention",
      kind: "unreadable",
      marker: "pane capture failed",
    });
  });

  test("a broken window probe degrades to pane text alone, it does not throw", async () => {
    const { tmux } = probedTmux({ windows: ["alice"], paneText: BLOCKED_TEXT });
    const h = await probeCageState(
      makeTeam({ emoji: undefined }),
      makeMember({ emoji: undefined }),
      "/tmp/x",
      {
        ...DEFAULT_OPTS,
        tmux,
        windowProbe: async () => {
          throw new Error("tmux gone");
        },
      },
    );
    expect(h.agentState?.kind).toBe("permission-prompt");
  });
});

describe("probeCageState — ONE pane, ONE read, TWO verdicts", () => {
  test("an injected windowProbe is used INSTEAD of a second display-message", async () => {
    // The structural half of the W6 fix. Two probes over one pane is
    // exactly how the two classifiers came to disagree; `atmux status`
    // already reads these signals for its own column, so it hands them
    // down and this probe must not re-read them.
    const probed = probedTmux({ windows: ["alice"], paneText: WORKING_TEXT });
    let handed = 0;
    const h = await probeCageState(
      makeTeam({ emoji: undefined }),
      makeMember({ emoji: undefined }),
      "/tmp/x",
      {
        ...DEFAULT_OPTS,
        tmux: probed.tmux,
        windowProbe: async () => {
          handed += 1;
          return { activityAgeSec: 3, paneDead: false, currentCommand: "claude" };
        },
      },
    );
    expect(handed).toBe(1);
    expect(probed.displayCalls()).toBe(0);
    // …and ONE capture feeds both verdicts.
    expect(probed.captureCalls()).toBe(1);
    expect(h.state).toBe("active");
    expect(h.agentState?.kind).toBe("working");
  });

  test("with no injection the default seam reads the window signals off tmux", async () => {
    const probed = probedTmux({ windows: ["alice"], paneText: WORKING_TEXT });
    await probeCageState(
      makeTeam({ emoji: undefined }),
      makeMember({ emoji: undefined }),
      "/tmp/x",
      { ...DEFAULT_OPTS, tmux: probed.tmux },
    );
    expect(probed.displayCalls()).toBe(1);
  });

  test("the probe's verdict IS classifyPaneObservation's — not a parallel reimplementation", async () => {
    // The anti-drift pin. Run the same text through the classifier
    // directly and require byte-equal verdicts. A second copy of the
    // ladder inside this module would fail here the day either moved.
    for (const text of [BLOCKED_TEXT, RESIDUE_TEXT, WORKING_TEXT]) {
      const { tmux } = probedTmux({
        windows: ["alice"],
        paneText: text,
        probeRaw: "1699999700\t0\tsleep",
      });
      const h = await probeCageState(
        makeTeam({ emoji: undefined }),
        makeMember({ emoji: undefined }),
        "/tmp/x",
        { ...DEFAULT_OPTS, tmux },
      );
      const direct = classifyPaneObservation({
        team: "demo",
        member: "alice",
        windowName: "alice",
        sessionUp: true,
        windowPresent: true,
        capture: text,
        paneDead: false,
        currentCommand: "sleep",
        activityAgeSec: 300,
      });
      expect(h.agentState).toEqual(direct);
    }
  });
});
