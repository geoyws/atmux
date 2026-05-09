// Unit tests for src/core/cron.ts — bun-port cron-block render module
// per ADR-053 §D4. Pure rendering (no I/O), so the test harness is a
// straight assertion suite over `renderCronLines` + `renderCronBlock`.

import { describe, expect, test } from "bun:test";
import { renderCronBlock, renderCronLines } from "../../../src/core/cron.ts";
import type { Team } from "../../../src/schema/team.ts";

const baseTeam = (overrides: Partial<Team> = {}): Team =>
  ({
    name: "demo",
    members: [],
    ...overrides,
  }) as Team;

const baseOpts = (team: Team) => ({
  team,
  atmuxDir: "/srv/demo/.atmux",
  atmuxBin: "/usr/local/bin/atmux",
});

// Bug t-2db59eee: every cron line carries an inline `PATH=...` prefix
// so cron-fired verbs resolve bun even under cron's narrow default env.
const DEFAULT_PATH = "/root/.bun/bin:/usr/local/bin:/usr/bin:/bin";
const P = `PATH=${DEFAULT_PATH} `;

describe("renderCronLines", () => {
  test("vanilla team renders 4-line block: whip / report / decisions / groom", () => {
    const lines = renderCronLines(baseOpts(baseTeam()));
    expect(lines).toEqual([
      `*/5 * * * * ${P}ATMUX_DIR=/srv/demo/.atmux /usr/local/bin/atmux whip >> /srv/demo/.atmux/logs/whip.log 2>&1`,
      `*/30 * * * * ${P}ATMUX_DIR=/srv/demo/.atmux /usr/local/bin/atmux report >> /srv/demo/.atmux/logs/report.log 2>&1`,
      `0 */4 * * * ${P}ATMUX_DIR=/srv/demo/.atmux /usr/local/bin/atmux decisions digest >> /srv/demo/.atmux/logs/decisions-digest.log 2>&1`,
      `0 4 * * * ${P}ATMUX_DIR=/srv/demo/.atmux /usr/local/bin/atmux groom --quiet >> /srv/demo/.atmux/logs/groom.log 2>&1`,
    ]);
  });

  test("team.whip.claudeAccount adds the */1 whip-resume-check line", () => {
    const team = baseTeam({ whip: { claudeAccount: "icloud" } as never });
    const lines = renderCronLines(baseOpts(team));
    expect(lines).toContain(
      `*/1 * * * * ${P}ATMUX_DIR=/srv/demo/.atmux /usr/local/bin/atmux whip-resume-check >> /srv/demo/.atmux/logs/whip-resume-check.log 2>&1`,
    );
    // Total now 5 lines.
    expect(lines.length).toBe(5);
  });

  test("empty claudeAccount string does NOT add the whip-resume-check line", () => {
    const team = baseTeam({ whip: { claudeAccount: "" } as never });
    const lines = renderCronLines(baseOpts(team));
    expect(lines.length).toBe(4);
    expect(lines.some((l) => l.includes("whip-resume-check"))).toBe(false);
  });

  test("undefined whip block → no whip-resume-check line", () => {
    const lines = renderCronLines(baseOpts(baseTeam({ whip: undefined as never })));
    expect(lines.some((l) => l.includes("whip-resume-check"))).toBe(false);
  });

  test("idempotent: same opts produce byte-identical lines", () => {
    const team = baseTeam({ whip: { claudeAccount: "icloud" } as never });
    expect(renderCronLines(baseOpts(team))).toEqual(renderCronLines(baseOpts(team)));
  });

  test("discorder member swaps `report` for discorder progress + heartbeat", () => {
    const team = baseTeam({
      members: [{ name: "d", role: "discorder", cwd: "/x" } as never],
    });
    const lines = renderCronLines(baseOpts(team));
    expect(lines.some((l) => l.includes(" report "))).toBe(false);
    expect(lines.some((l) => l.includes("discorder progress"))).toBe(true);
    expect(lines.some((l) => l.includes("discorder heartbeat"))).toBe(true);
  });

  test("unblocker member adds */2 unblocker tick line", () => {
    const team = baseTeam({
      members: [{ name: "u", role: "unblocker", cwd: "/x" } as never],
    });
    const lines = renderCronLines(baseOpts(team));
    expect(lines.some((l) => l.startsWith("*/2 * * * *") && l.includes("unblocker tick"))).toBe(
      true,
    );
  });

  test("tmuxTmpdir prefix prepends TMUX_TMPDIR= on every line (after PATH=)", () => {
    const lines = renderCronLines({
      ...baseOpts(baseTeam()),
      tmuxTmpdir: "/tmp/atmux-demo",
    });
    for (const l of lines) {
      expect(l).toContain("TMUX_TMPDIR=/tmp/atmux-demo ");
      // PATH= must come before TMUX_TMPDIR= so the inline assignment
      // sets bun-resolution before any tmux-side lookup.
      expect(l.indexOf("PATH=")).toBeLessThan(l.indexOf("TMUX_TMPDIR="));
    }
  });

  // Bug t-2db59eee — cron PATH bake-in (defends against cron's narrow
  // default env breaking the `#!/usr/bin/env bun` shebang).
  test("every line carries inline PATH= prefix with bun bin path (default)", () => {
    const lines = renderCronLines(baseOpts(baseTeam()));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).toContain(`PATH=${DEFAULT_PATH} `);
      // PATH= must precede ATMUX_DIR= so bash sees the inline assignment
      // first and the atmux invocation inherits the patched PATH.
      expect(l.indexOf("PATH=")).toBeLessThan(l.indexOf("ATMUX_DIR="));
    }
  });

  test("team.cron.path overrides the default PATH baked into every line", () => {
    const customPath = "/opt/bun/bin:/usr/bin:/bin";
    const team = baseTeam({ cron: { path: customPath } as never });
    const lines = renderCronLines(baseOpts(team));
    for (const l of lines) {
      expect(l).toContain(`PATH=${customPath} `);
      expect(l).not.toContain(DEFAULT_PATH);
    }
  });

  test("conditional whip-resume-check line also gets PATH= prefix", () => {
    const team = baseTeam({ whip: { claudeAccount: "icloud" } as never });
    const lines = renderCronLines(baseOpts(team));
    const resumeLines = lines.filter((l) => l.includes("whip-resume-check"));
    expect(resumeLines.length).toBe(1);
    for (const l of resumeLines) {
      expect(l).toContain(`PATH=${DEFAULT_PATH} `);
    }
  });

  test("discorder + unblocker conditional lines also get PATH= prefix", () => {
    const team = baseTeam({
      members: [
        { name: "d", role: "discorder", cwd: "/x" } as never,
        { name: "u", role: "unblocker", cwd: "/x" } as never,
      ],
    });
    const lines = renderCronLines(baseOpts(team));
    for (const l of lines) {
      expect(l).toContain(`PATH=${DEFAULT_PATH} `);
    }
  });

  test("empty tmuxTmpdir treated same as undefined (no prefix)", () => {
    const linesEmpty = renderCronLines({
      ...baseOpts(baseTeam()),
      tmuxTmpdir: "",
    });
    const linesUndef = renderCronLines(baseOpts(baseTeam()));
    expect(linesEmpty).toEqual(linesUndef);
  });

  test("full feature mix: discorder + unblocker + claudeAccount + TMUX_TMPDIR", () => {
    const team = baseTeam({
      members: [
        { name: "d", role: "discorder", cwd: "/x" } as never,
        { name: "u", role: "unblocker", cwd: "/x" } as never,
      ],
      whip: { claudeAccount: "icloud" } as never,
    });
    const lines = renderCronLines({
      ...baseOpts(team),
      tmuxTmpdir: "/tmp/atmux-demo",
    });
    // whip + 2 discorder + decisions + groom + whip-resume-check + unblocker = 7
    expect(lines.length).toBe(7);
    expect(lines.every((l) => l.includes("TMUX_TMPDIR=/tmp/atmux-demo "))).toBe(true);
    expect(lines.some((l) => l.includes("whip-resume-check"))).toBe(true);
    expect(lines.some((l) => l.includes("unblocker tick"))).toBe(true);
    expect(lines.some((l) => l.includes("discorder progress"))).toBe(true);
  });
});

describe("renderCronBlock", () => {
  test("wraps lines in marker fence with team name + trailing newline", () => {
    const team = baseTeam({ name: "myteam" });
    const block = renderCronBlock(baseOpts(team));
    expect(
      block.startsWith("# >>> atmux:team=myteam — managed by atmux start; do not edit by hand\n"),
    ).toBe(true);
    expect(block.endsWith("# <<< atmux:team=myteam\n")).toBe(true);
  });

  test("body contains every rendered line exactly once", () => {
    const team = baseTeam({ name: "demo", whip: { claudeAccount: "icloud" } as never });
    const block = renderCronBlock(baseOpts(team));
    const lines = renderCronLines(baseOpts(team));
    for (const l of lines) {
      // Each line should appear exactly once between the markers.
      const occurrences = block.split(l).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  test("idempotent: same input → byte-identical output", () => {
    const team = baseTeam({ name: "demo" });
    expect(renderCronBlock(baseOpts(team))).toBe(renderCronBlock(baseOpts(team)));
  });
});
