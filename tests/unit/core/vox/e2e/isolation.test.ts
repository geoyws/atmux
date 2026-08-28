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
  READONLY_ENV,
} from "../../../../../src/core/vox/e2e/isolation.ts";
import { ConfigError } from "../../../../../src/errors.ts";

const TEMP = "/tmp/atmux-vox-e2e-abc123";
const HOME = `${TEMP}/home`;

/**
 * Cockpit entries as they would be READ BACK OFF DISK — name and root.
 *
 * The root is derived by the same rule `buildCagePlan` uses (suffix under
 * `<temp>/`), so a well-formed fixture agrees with the plan by
 * construction and the disagreement cases below have to be written
 * deliberately rather than arrived at by accident.
 */
function cockpit(...names: string[]): Array<{ name: string; root: string }> {
  return names.map((n) => ({ name: n, root: `${TEMP}/${n.replace(FAKE_TEAM_PREFIX, "")}` }));
}

function base(overrides: Partial<AssertIsolatedInput> = {}): AssertIsolatedInput {
  return {
    tempRoot: TEMP,
    expectedTeams: [
      { name: "vox-e2e-alpha", root: `${TEMP}/alpha`, tmuxTmpdir: `${TEMP}/sock/alpha` },
      { name: "vox-e2e-ghost", root: `${TEMP}/ghost`, tmuxTmpdir: `${TEMP}/sock/ghost` },
    ],
    cockpitTeams: cockpit("vox-e2e-alpha", "vox-e2e-ghost"),
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
      base({ cockpitTeams: cockpit("vox-e2e-alpha", "vox-e2e-ghost", "px") }),
      "cockpit lists",
    );
  });

  test("REFUSES when a fake team name collides with a real one", () => {
    refuses(
      base({
        expectedTeams: [{ name: "vox-e2e-px", root: `${TEMP}/px`, tmuxTmpdir: `${TEMP}/s` }],
        cockpitTeams: cockpit("vox-e2e-px"),
        realTeamNames: ["vox-e2e-px"],
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

  test("REFUSES a cockpit whose NAMES match but whose ROOT points at the real checkout", () => {
    // The hole a name-only gate left open, and the one that matters most
    // once mutations are on: `loadCockpit` hands each entry's `root` to
    // the fleet verbs as `--team-dir`, so this cockpit would have passed
    // every name check and then addressed the operator's repository.
    refuses(
      base({
        cockpitTeams: [
          { name: "vox-e2e-alpha", root: "/root/work/src/atmux" },
          { name: "vox-e2e-ghost", root: `${TEMP}/ghost` },
        ],
      }),
      "has root outside the temp dir",
    );
  });

  test("REFUSES a cockpit root that is ours but is NOT the one the plan chose", () => {
    // Both roots are inside the sandbox, so the first check is satisfied.
    // They still disagree, which means the file on disk is not the file
    // the harness believes it wrote — and the harness's own assertions
    // are all written against the plan.
    refuses(
      base({
        cockpitTeams: [
          { name: "vox-e2e-alpha", root: `${TEMP}/somewhere-else` },
          { name: "vox-e2e-ghost", root: `${TEMP}/ghost` },
        ],
      }),
      "but the harness planned",
    );
  });

  test("REFUSES a cockpit entry with no root at all", () => {
    // `extractTeamEntries` yields "" for an entry whose `root` is missing
    // or not a string. Treated as "outside the temp root" rather than as
    // "unset and therefore fine": a cockpit shape the gate cannot account
    // for is exactly when it must not proceed.
    refuses(
      base({
        cockpitTeams: [
          { name: "vox-e2e-alpha", root: "" },
          { name: "vox-e2e-ghost", root: `${TEMP}/ghost` },
        ],
      }),
      "has root outside the temp dir",
    );
  });

  test("REFUSES mutations while ATMUX_VOX_READONLY is set in the environment", () => {
    // The readonly posture must travel as an in-process flag. An env var
    // is inherited by every child process and read at CALL time by the
    // fleet verbs, so it would outlive the cage that wanted it.
    refuses(
      base({
        mutationsEnabled: true,
        env: { HOME, [COCKPIT_ENV]: `${TEMP}/cockpit.json`, [READONLY_ENV]: "0" },
      }),
      `${READONLY_ENV} is set`,
    );
  });

  test("REFUSES mutations even when ATMUX_VOX_READONLY says `1`", () => {
    // The refusal is about the CARRIER, not about the value. A `1` here
    // would be overridden by the flag anyway, and a gate that allowed the
    // safe-looking value would be teaching the next reader that this
    // variable is a legitimate way to express the posture.
    refuses(
      base({
        mutationsEnabled: true,
        env: { HOME, [COCKPIT_ENV]: `${TEMP}/cockpit.json`, [READONLY_ENV]: "1" },
      }),
      `${READONLY_ENV} is set`,
    );
  });

  test("allows ATMUX_VOX_READONLY when mutations are NOT enabled", () => {
    // The read-only cages are unaffected: the new refusal is additive,
    // and an operator who exports the variable for his own server must
    // still be able to run the read half.
    const report = assertIsolated(
      base({ env: { HOME, [COCKPIT_ENV]: `${TEMP}/cockpit.json`, [READONLY_ENV]: "1" } }),
    );
    expect(report.mutationsEnabled).toBe(false);
  });

  test("passes a mutating cage with no readonly env var, and says so loudly", () => {
    const report = assertIsolated(base({ mutationsEnabled: true }));
    expect(report.mutationsEnabled).toBe(true);
    expect(formatIsolationReport(report).join("\n")).toContain("MUTATIONS ENABLED");
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
    const t = { name: "vox-e2e-a", root: `${TEMP}/a`, tmuxTmpdir: `${TEMP}/s` };
    refuses(
      base({ expectedTeams: [t, t], cockpitTeams: cockpit("vox-e2e-a", "vox-e2e-a") }),
      "duplicate fake team names",
    );
  });

  test("refuses when no fake teams were declared", () => {
    refuses(base({ expectedTeams: [], cockpitTeams: [] }), "no fake teams declared");
  });

  test("refuses a team name without the fake prefix", () => {
    refuses(
      base({
        expectedTeams: [{ name: "alpha", root: `${TEMP}/a`, tmuxTmpdir: `${TEMP}/s` }],
        cockpitTeams: cockpit("alpha"),
      }),
      `lacks the ${JSON.stringify(FAKE_TEAM_PREFIX)} prefix`,
    );
  });

  test("refuses when the cockpit is missing a declared team", () => {
    refuses(base({ cockpitTeams: cockpit("vox-e2e-alpha") }), "cockpit lists");
  });

  test("refuses a team root outside the temp dir", () => {
    refuses(
      base({
        expectedTeams: [
          { name: "vox-e2e-alpha", root: "/root/work/src/atmux", tmuxTmpdir: `${TEMP}/s` },
        ],
        cockpitTeams: cockpit("vox-e2e-alpha"),
      }),
      "root outside the temp dir",
    );
  });

  test("refuses a team with no tmuxTmpdir", () => {
    refuses(
      base({
        expectedTeams: [{ name: "vox-e2e-alpha", root: `${TEMP}/a`, tmuxTmpdir: null }],
        cockpitTeams: cockpit("vox-e2e-alpha"),
      }),
      "no tmuxTmpdir",
    );
  });

  test("refuses a team with an empty tmuxTmpdir", () => {
    refuses(
      base({
        expectedTeams: [{ name: "vox-e2e-alpha", root: `${TEMP}/a`, tmuxTmpdir: "" }],
        cockpitTeams: cockpit("vox-e2e-alpha"),
      }),
      "no tmuxTmpdir",
    );
  });

  test("refuses a tmuxTmpdir outside the temp dir", () => {
    refuses(
      base({
        expectedTeams: [{ name: "vox-e2e-alpha", root: `${TEMP}/a`, tmuxTmpdir: "/tmp" }],
        cockpitTeams: cockpit("vox-e2e-alpha"),
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
    expect(text).toContain("vox-e2e-alpha");
    expect(text).toContain("vox-e2e-ghost");
    expect(text).toContain("NOT used — real fleet lives here");
    expect(text).toContain("5 team(s) read from the operator's cockpit");
  });

  test("says so plainly when no operator cockpit was readable", () => {
    const lines = formatIsolationReport(assertIsolated(base({ realTeamNames: [] })));
    expect(lines.join("\n")).toContain("no operator cockpit readable");
  });
});
