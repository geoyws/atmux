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

describe("renderCronLines", () => {
  test("vanilla team renders 4-line block: whip / report / decisions / groom", () => {
    const lines = renderCronLines(baseOpts(baseTeam()));
    expect(lines).toEqual([
      "*/5 * * * * ATMUX_DIR=/srv/demo/.atmux /usr/local/bin/atmux whip >> /srv/demo/.atmux/logs/whip.log 2>&1",
      "*/30 * * * * ATMUX_DIR=/srv/demo/.atmux /usr/local/bin/atmux report >> /srv/demo/.atmux/logs/report.log 2>&1",
      "0 */4 * * * ATMUX_DIR=/srv/demo/.atmux /usr/local/bin/atmux decisions digest >> /srv/demo/.atmux/logs/decisions-digest.log 2>&1",
      "0 4 * * * ATMUX_DIR=/srv/demo/.atmux /usr/local/bin/atmux groom --quiet >> /srv/demo/.atmux/logs/groom.log 2>&1",
    ]);
  });

  test("team.whip.claudeAccount adds the */1 whip-resume-check line", () => {
    const team = baseTeam({ whip: { claudeAccount: "icloud" } as never });
    const lines = renderCronLines(baseOpts(team));
    expect(lines).toContain(
      "*/1 * * * * ATMUX_DIR=/srv/demo/.atmux /usr/local/bin/atmux whip-resume-check >> /srv/demo/.atmux/logs/whip-resume-check.log 2>&1",
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

  test("tmuxTmpdir prefix prepends TMUX_TMPDIR= on every line", () => {
    const lines = renderCronLines({
      ...baseOpts(baseTeam()),
      tmuxTmpdir: "/tmp/atmux-demo",
    });
    for (const l of lines) {
      expect(l).toContain("TMUX_TMPDIR=/tmp/atmux-demo ");
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
