// The safety gate. Every refusal branch is driven here, and the headline
// test is the one the operator actually cares about: pointed at a
// real-looking cockpit, `assertIsolated` REFUSES.
//
// A passing gate is worth nothing unless the failing case is proven, so
// these tests are written as attempted escapes rather than as a happy path
// with a few negative cases bolted on.

import { describe, expect, test } from "bun:test";
import {
  type AssertIsolatedInput,
  assertIsolated,
  COCKPIT_ENV,
  defaultTmuxSocketPath,
  FAKE_TEAM_PREFIX,
  formatIsolationReport,
  isUnder,
} from "../../../../../src/core/voice/e2e/isolation.ts";
import { ConfigError } from "../../../../../src/errors.ts";

const TEMP = "/tmp/atmux-voice-e2e-abc123";
const HOME = `${TEMP}/home`;

function base(overrides: Partial<AssertIsolatedInput> = {}): AssertIsolatedInput {
  return {
    tempRoot: TEMP,
    expectedTeams: [
      { name: "voice-e2e-alpha", root: `${TEMP}/alpha`, tmuxTmpdir: `${TEMP}/sock/alpha` },
      { name: "voice-e2e-ghost", root: `${TEMP}/ghost`, tmuxTmpdir: `${TEMP}/sock/ghost` },
    ],
    cockpitTeamNames: ["voice-e2e-alpha", "voice-e2e-ghost"],
    env: { HOME, [COCKPIT_ENV]: `${TEMP}/cockpit.json` },
    uid: 1000,
    realTeamNames: ["atmux", "unum", "px", "mx", "hig"],
    ...overrides,
  };
}

/** Assert the gate refuses, and that the message names the reason. */
function refuses(input: AssertIsolatedInput, needle: string): void {
  let thrown: unknown = null;
  try {
    assertIsolated(input);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as ConfigError).message).toContain(needle);
}

describe("assertIsolated — the escape it must never allow", () => {
  test("REFUSES when pointed at the operator's real cockpit path", () => {
    // The exact mistake this gate exists to stop: HOME left unpinned and
    // the cockpit override absent, so the fleet verbs would read the live
    // 20-team roster.
    refuses(
      base({ env: { HOME: "/root", [COCKPIT_ENV]: "/root/.atmux/cockpit.json" } }),
      "HOME is not under the temp root",
    );
  });

  test("REFUSES a cockpit that resolves to $HOME/.atmux/cockpit.json even inside the temp dir", () => {
    // Subtler: HOME *is* pinned, but the cockpit path is the default
    // relative to it. Structurally harmless here, yet it is the one path
    // that must never be the answer, so it is named explicitly.
    refuses(
      base({ env: { HOME, [COCKPIT_ENV]: `${HOME}/.atmux/cockpit.json` } }),
      "resolves to the default cockpit path",
    );
  });

  test("REFUSES when the cockpit lists a real team alongside the fakes", () => {
    refuses(
      base({ cockpitTeamNames: ["voice-e2e-alpha", "voice-e2e-ghost", "px"] }),
      "cockpit lists",
    );
  });

  test("REFUSES when a fake team name collides with a real one", () => {
    refuses(
      base({
        expectedTeams: [{ name: "voice-e2e-px", root: `${TEMP}/px`, tmuxTmpdir: `${TEMP}/s` }],
        cockpitTeamNames: ["voice-e2e-px"],
        realTeamNames: ["voice-e2e-px"],
      }),
      "collide with the operator's real fleet",
    );
  });

  test("REFUSES a team whose socket would be the DEFAULT tmux socket", () => {
    // Defense in depth: if `resolveTeamSocket` ever stopped honouring
    // tmuxTmpdir, this is the check that catches it before a single tmux
    // command is issued at the operator's live sessions.
    //
    // Driven with TMUX_TMPDIR pointing INTO the temp root, so the default
    // socket is itself under the temp dir — the one arrangement where
    // "inside our sandbox" and "the operator's live socket" coincide, and
    // therefore the only one where this check is the last line of defense.
    const env = { HOME, [COCKPIT_ENV]: `${TEMP}/cockpit.json`, TMUX_TMPDIR: TEMP };
    refuses(
      base({ env, resolveSocket: () => defaultTmuxSocketPath(env, 1000) }),
      "resolves to the DEFAULT tmux socket",
    );
  });

  test("REFUSES a team whose socket lands outside the temp dir", () => {
    refuses(base({ resolveSocket: () => "/tmp/atmux-px/sock" }), "socket outside the temp dir");
  });
});

describe("assertIsolated — every other refusal branch", () => {
  test("refuses a relative temp root", () => {
    refuses(base({ tempRoot: "relative/path" }), "not a usable absolute path");
  });

  test("refuses the filesystem root as temp root", () => {
    refuses(base({ tempRoot: "/" }), "not a usable absolute path");
  });

  test("refuses an unset HOME", () => {
    refuses(base({ env: { [COCKPIT_ENV]: `${TEMP}/cockpit.json` } }), "HOME is unset");
  });

  test("refuses an empty HOME", () => {
    refuses(base({ env: { HOME: "", [COCKPIT_ENV]: `${TEMP}/c.json` } }), "HOME is unset");
  });

  test("refuses an unset cockpit override", () => {
    refuses(base({ env: { HOME } }), `${COCKPIT_ENV} is unset`);
  });

  test("refuses an empty cockpit override", () => {
    refuses(base({ env: { HOME, [COCKPIT_ENV]: "" } }), `${COCKPIT_ENV} is unset`);
  });

  test("refuses a cockpit outside the temp root", () => {
    refuses(base({ env: { HOME, [COCKPIT_ENV]: "/etc/cockpit.json" } }), "points outside");
  });

  test("refuses duplicate fake team names", () => {
    const t = { name: "voice-e2e-a", root: `${TEMP}/a`, tmuxTmpdir: `${TEMP}/s` };
    refuses(
      base({ expectedTeams: [t, t], cockpitTeamNames: ["voice-e2e-a", "voice-e2e-a"] }),
      "duplicate fake team names",
    );
  });

  test("refuses when no fake teams were declared", () => {
    refuses(base({ expectedTeams: [], cockpitTeamNames: [] }), "no fake teams declared");
  });

  test("refuses a team name without the fake prefix", () => {
    refuses(
      base({
        expectedTeams: [{ name: "alpha", root: `${TEMP}/a`, tmuxTmpdir: `${TEMP}/s` }],
        cockpitTeamNames: ["alpha"],
      }),
      `lacks the ${JSON.stringify(FAKE_TEAM_PREFIX)} prefix`,
    );
  });

  test("refuses when the cockpit is missing a declared team", () => {
    refuses(base({ cockpitTeamNames: ["voice-e2e-alpha"] }), "cockpit lists");
  });

  test("refuses a team root outside the temp dir", () => {
    refuses(
      base({
        expectedTeams: [
          { name: "voice-e2e-alpha", root: "/root/work/src/atmux", tmuxTmpdir: `${TEMP}/s` },
        ],
        cockpitTeamNames: ["voice-e2e-alpha"],
      }),
      "root outside the temp dir",
    );
  });

  test("refuses a team with no tmuxTmpdir", () => {
    refuses(
      base({
        expectedTeams: [{ name: "voice-e2e-alpha", root: `${TEMP}/a`, tmuxTmpdir: null }],
        cockpitTeamNames: ["voice-e2e-alpha"],
      }),
      "no tmuxTmpdir",
    );
  });

  test("refuses a team with an empty tmuxTmpdir", () => {
    refuses(
      base({
        expectedTeams: [{ name: "voice-e2e-alpha", root: `${TEMP}/a`, tmuxTmpdir: "" }],
        cockpitTeamNames: ["voice-e2e-alpha"],
      }),
      "no tmuxTmpdir",
    );
  });

  test("refuses a tmuxTmpdir outside the temp dir", () => {
    refuses(
      base({
        expectedTeams: [{ name: "voice-e2e-alpha", root: `${TEMP}/a`, tmuxTmpdir: "/tmp" }],
        cockpitTeamNames: ["voice-e2e-alpha"],
      }),
      "tmuxTmpdir is outside the temp dir",
    );
  });
});

describe("assertIsolated — the passing case", () => {
  test("passes on a well-formed throwaway cage and reports the evidence", () => {
    const report = assertIsolated(base());
    expect(report.cockpitPath).toBe(`${TEMP}/cockpit.json`);
    expect(report.home).toBe(HOME);
    expect(report.tempRoot).toBe(TEMP);
    expect(report.realTeamsChecked).toBe(5);
    expect(report.teams.length).toBe(2);
    for (const t of report.teams) {
      expect(isUnder(TEMP, t.socketPath)).toBe(true);
      expect(t.socketPath).not.toBe(report.defaultTmuxSocket);
    }
    // The socket really is the tmuxTmpdir-derived one, not a cage default.
    expect(report.teams[0]?.socketPath).toBe(`${TEMP}/sock/alpha/tmux-1000/default`);
  });

  test("passes with no real cockpit readable (structural checks stand alone)", () => {
    const { realTeamNames: _omitted, ...withoutRealTeams } = base();
    const report = assertIsolated(withoutRealTeams);
    expect(report.realTeamsChecked).toBe(0);
  });
});

describe("defaultTmuxSocketPath", () => {
  test("uses /tmp when TMUX_TMPDIR is unset", () => {
    expect(defaultTmuxSocketPath({}, 0)).toBe("/tmp/tmux-0/default");
  });

  test("honours TMUX_TMPDIR when set", () => {
    expect(defaultTmuxSocketPath({ TMUX_TMPDIR: "/run/user/1000" }, 1000)).toBe(
      "/run/user/1000/tmux-1000/default",
    );
  });

  test("ignores an empty TMUX_TMPDIR", () => {
    expect(defaultTmuxSocketPath({ TMUX_TMPDIR: "" }, 7)).toBe("/tmp/tmux-7/default");
  });
});

describe("isUnder", () => {
  test("a path is under itself", () => {
    expect(isUnder("/a/b", "/a/b")).toBe(true);
  });

  test("a child is under its parent", () => {
    expect(isUnder("/a/b", "/a/b/c/d")).toBe(true);
  });

  test("a sibling sharing a name prefix is NOT under it", () => {
    // The off-by-one this helper exists to avoid: a plain startsWith would
    // call `/tmp/atmux-e2e-evil` a child of `/tmp/atmux-e2e`.
    expect(isUnder("/tmp/atmux-e2e", "/tmp/atmux-e2e-evil")).toBe(false);
  });

  test("a parent is not under its child", () => {
    expect(isUnder("/a/b/c", "/a/b")).toBe(false);
  });

  test("traversal out of the parent is not under it", () => {
    expect(isUnder("/a/b", "/a/b/../../etc")).toBe(false);
  });

  test("tolerates a trailing separator on the parent", () => {
    expect(isUnder("/a/b/", "/a/b/c")).toBe(true);
  });
});

describe("formatIsolationReport", () => {
  test("names the fake cockpit, the fake sockets, and the default socket it avoids", () => {
    const lines = formatIsolationReport(assertIsolated(base()));
    const text = lines.join("\n");
    expect(text).toContain("isolation: PASS");
    expect(text).toContain(`${TEMP}/cockpit.json`);
    expect(text).toContain("voice-e2e-alpha");
    expect(text).toContain("voice-e2e-ghost");
    expect(text).toContain("NOT used — real fleet lives here");
    expect(text).toContain("5 team(s) read from the operator's cockpit");
  });

  test("says so plainly when no operator cockpit was readable", () => {
    const lines = formatIsolationReport(assertIsolated(base({ realTeamNames: [] })));
    expect(lines.join("\n")).toContain("no operator cockpit readable");
  });
});
