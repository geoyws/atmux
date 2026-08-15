// Unit tests for src/core/cage-state.ts (t-74273200 / c-8ecd3a61).

import { describe, expect, test } from "bun:test";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import {
  type CageHealth,
  probeCageState,
  STARVING_THRESHOLD_S,
  WEDGED_HEARTBEAT_STALE_SEC,
} from "../../../src/core/cage-state.ts";
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

  test("without the override it still asks for the legacy `atmux-<team>` form", async () => {
    // Pins the fallback as UNCHANGED, so callers that have not been
    // updated behave exactly as they did before this seam landed.
    const spy = nameSpy();
    await probeCageState(makeTeam(), makeMember(), "/tmp/x", { ...DEFAULT_OPTS, ...spy.opts });
    expect(spy.asked).toEqual(["atmux-demo"]);
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
