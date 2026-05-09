// Unit tests for src/verbs/pane-state.ts (ADR-062 §Decision (2)).
//
// Coverage:
//   - parsePaneStateArgs: every flag branch + UsageError paths.
//   - resolveMemberWindowTarget: lead I-2 marker fallback chain.
//   - paneStateWithTmux: every PaneState classification round-trips via
//     stubbed TmuxNamespace returning fixture pane captures
//     (8 patterns from src/core/pane-state.ts:69 PATTERNS array).
//   - paneState verb: --json shape; member-not-found ConfigError lists
//     valid member names.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { leadWindowNamePath } from "../../../src/core/lead-marker.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import type { Team, TeamMember } from "../../../src/schema/team.ts";
import {
  paneState,
  paneStateWithTmux,
  parsePaneStateArgs,
  resolveMemberWindowTarget,
} from "../../../src/verbs/pane-state.ts";

let teamDir: string;
let atmuxDir: string;
let homeDir: string;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-pane-state-team-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  homeDir = await mkdtemp(join(tmpdir(), "atmux-pane-state-home-"));
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
});

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    out += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await fn();
    return { out, result };
  } finally {
    process.stdout.write = orig;
  }
}

/** Stub `TmuxNamespace` whose `capturePane` returns a fixed text. Other
 *  namespaces are unused by `paneStateWithTmux`; cast through unknown. */
function stubTmuxWithCapture(text: string, opts?: { throwOnCapture?: boolean }): TmuxNamespace {
  return {
    pane: {
      async capturePane(_args: { target: string; start?: number; end?: number }) {
        if (opts?.throwOnCapture === true) {
          throw new Error("simulated tmux failure");
        }
        return text;
      },
    },
  } as unknown as TmuxNamespace;
}

// ---------- parsePaneStateArgs ----------

describe("parsePaneStateArgs", () => {
  test("--member <name>", () => {
    expect(parsePaneStateArgs(["--member", "alpha"])).toEqual({ member: "alpha", json: false });
  });

  test("--member + --json", () => {
    const a = parsePaneStateArgs(["--member", "alpha", "--json"]);
    expect(a).toEqual({ member: "alpha", json: true });
  });

  test("--socket / --team-dir consumed", () => {
    const a = parsePaneStateArgs(["--member", "alpha", "--socket", "/s", "--team-dir", "/x"]);
    expect(a.socketPath).toBe("/s");
    expect(a.teamDir).toBe("/x");
  });

  test("missing --member → UsageError", () => {
    expect(() => parsePaneStateArgs([])).toThrow(UsageError);
    expect(() => parsePaneStateArgs(["--json"])).toThrow(UsageError);
  });

  test("--member without value → UsageError", () => {
    expect(() => parsePaneStateArgs(["--member"])).toThrow(UsageError);
  });

  test("--socket without value → UsageError", () => {
    expect(() => parsePaneStateArgs(["--member", "alpha", "--socket"])).toThrow(UsageError);
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parsePaneStateArgs(["--member", "alpha", "--team-dir"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parsePaneStateArgs(["--member", "alpha", "--bogus"])).toThrow(UsageError);
  });
});

// ---------- resolveMemberWindowTarget ----------

describe("resolveMemberWindowTarget", () => {
  const team: Team = {
    name: "demo",
    members: [
      { name: "alpha", emoji: "🐝" },
      { name: "lead", role: "team-lead", emoji: "🧭" },
    ],
  } as Team;

  test("regular member → `<session>:<emoji><name>`", async () => {
    const member = team.members[0] as TeamMember;
    const t = await resolveMemberWindowTarget(team, "atmux-demo", member, { home: homeDir });
    expect(t).toBe("atmux-demo:🐝alpha");
  });

  test("lead with no I-2 marker → falls back to `<emoji><name>` from schema", async () => {
    const member = team.members[1] as TeamMember;
    const t = await resolveMemberWindowTarget(team, "atmux-demo", member, { home: homeDir });
    expect(t).toBe("atmux-demo:🧭lead");
  });

  test("lead with I-2 marker → uses marker text", async () => {
    const member = team.members[1] as TeamMember;
    await mkdir(join(homeDir, ".claude", "teams", "demo"), { recursive: true });
    await writeFile(leadWindowNamePath("demo", { home: homeDir }), "🧭lead-rotated\n");
    const t = await resolveMemberWindowTarget(team, "atmux-demo", member, { home: homeDir });
    expect(t).toBe("atmux-demo:🧭lead-rotated");
  });

  test("regular member without emoji → bare name", async () => {
    const teamNoEmoji: Team = {
      name: "demo",
      members: [{ name: "alpha" }],
    } as Team;
    const member = teamNoEmoji.members[0] as TeamMember;
    const t = await resolveMemberWindowTarget(teamNoEmoji, "atmux-demo", member, {
      home: homeDir,
    });
    expect(t).toBe("atmux-demo:alpha");
  });
});

// ---------- paneStateWithTmux: 7 states + UNKNOWN ----------

const ALPHA: TeamMember = { name: "alpha", emoji: "🐝" } as TeamMember;
const TEAM_ONE: Team = { name: "demo", members: [ALPHA] } as Team;

describe("paneStateWithTmux — every PaneState round-trips via fixture captures", () => {
  test("READY — empty prompt `>`", async () => {
    const tmux = stubTmuxWithCapture("\n>\n");
    const r = await paneStateWithTmux(tmux, TEAM_ONE, "atmux-demo", ALPHA, { home: homeDir });
    expect(r.state).toBe("READY");
  });

  test("READY — tokens-with-esc footer", async () => {
    const tmux = stubTmuxWithCapture("3.4k tokens · esc to interrupt");
    const r = await paneStateWithTmux(tmux, TEAM_ONE, "atmux-demo", ALPHA, { home: homeDir });
    expect(r.state).toBe("READY");
  });

  test("TYPING — queued message indicator", async () => {
    const tmux = stubTmuxWithCapture("draft\nPress up to edit queued messages");
    const r = await paneStateWithTmux(tmux, TEAM_ONE, "atmux-demo", ALPHA, { home: homeDir });
    expect(r.state).toBe("TYPING");
  });

  test("MODAL — `Do you want Claude to` permission prompt", async () => {
    const tmux = stubTmuxWithCapture("Do you want Claude to run rm -rf? [y/N]");
    const r = await paneStateWithTmux(tmux, TEAM_ONE, "atmux-demo", ALPHA, { home: homeDir });
    expect(r.state).toBe("MODAL");
  });

  test("RATE-LIMIT — `hit your limit` banner", async () => {
    const tmux = stubTmuxWithCapture("You've hit your limit. Resets at 09:00.");
    const r = await paneStateWithTmux(tmux, TEAM_ONE, "atmux-demo", ALPHA, { home: homeDir });
    expect(r.state).toBe("RATE-LIMIT");
  });

  test("COMPACTING — `Compacting conversation`", async () => {
    const tmux = stubTmuxWithCapture("● Compacting conversation … this may take a moment");
    const r = await paneStateWithTmux(tmux, TEAM_ONE, "atmux-demo", ALPHA, { home: homeDir });
    expect(r.state).toBe("COMPACTING");
  });

  test("SHELL — pane fell back to `$` shell prompt", async () => {
    const tmux = stubTmuxWithCapture("user@host:~$\n");
    const r = await paneStateWithTmux(tmux, TEAM_ONE, "atmux-demo", ALPHA, { home: homeDir });
    expect(r.state).toBe("SHELL");
  });

  test("UNKNOWN — pattern catalog yields no match", async () => {
    const tmux = stubTmuxWithCapture("some\nrandom\noutput with no banners");
    const r = await paneStateWithTmux(tmux, TEAM_ONE, "atmux-demo", ALPHA, { home: homeDir });
    expect(r.state).toBe("UNKNOWN");
  });

  test("classification carries evidence + capturedAt", async () => {
    const tmux = stubTmuxWithCapture("● Compacting conversation");
    const FIXED = 1_700_000_000_000;
    const r = await paneStateWithTmux(
      tmux,
      TEAM_ONE,
      "atmux-demo",
      ALPHA,
      { home: homeDir },
      () => FIXED,
    );
    expect(r.state).toBe("COMPACTING");
    expect(r.evidence).toBe("Compacting conversation");
    expect(r.capturedAt).toBe(FIXED);
  });

  test("capture failure → UNKNOWN (degrades like whip checkMember)", async () => {
    const tmux = stubTmuxWithCapture("", { throwOnCapture: true });
    const r = await paneStateWithTmux(tmux, TEAM_ONE, "atmux-demo", ALPHA, { home: homeDir });
    expect(r.state).toBe("UNKNOWN");
    expect(r.evidence).toBe("");
  });
});

// ---------- paneState verb — full integration ----------

describe("paneState verb", () => {
  async function stageTeam(
    members: ReadonlyArray<Partial<TeamMember> & { name: string }>,
  ): Promise<void> {
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: "demo", members }));
  }

  test("member-not-found → ConfigError listing valid member names", async () => {
    await stageTeam([{ name: "alpha" }, { name: "beta" }]);
    await expect(paneState(["--member", "ghost", "--team-dir", teamDir])).rejects.toThrow(
      ConfigError,
    );
    try {
      await paneState(["--member", "ghost", "--team-dir", teamDir]);
    } catch (e) {
      const ctx = (e as ConfigError).context as { what: string; hint?: string };
      expect(ctx.what).toContain("ghost");
      expect(ctx.hint).toContain("alpha");
      expect(ctx.hint).toContain("beta");
    }
  });

  test("session-down (no socket) → falls through to UNKNOWN, prints state", async () => {
    await stageTeam([{ name: "alpha" }]);
    const { out } = await captureStdout(() =>
      paneState([
        "--member",
        "alpha",
        "--team-dir",
        teamDir,
        "--socket",
        join(teamDir, "no-such-socket"),
      ]),
    );
    expect(out.trim()).toBe("UNKNOWN");
  });

  test("--json emits PaneClassification shape {state, evidence, capturedAt}", async () => {
    await stageTeam([{ name: "alpha" }]);
    const { out } = await captureStdout(() =>
      paneState([
        "--member",
        "alpha",
        "--json",
        "--team-dir",
        teamDir,
        "--socket",
        join(teamDir, "no-such-socket"),
      ]),
    );
    const parsed = JSON.parse(out) as { state: string; evidence: string; capturedAt: number };
    expect(parsed.state).toBe("UNKNOWN");
    expect(parsed.evidence).toBe("");
    expect(typeof parsed.capturedAt).toBe("number");
  });
});
