// Unit tests for src/core/cron.ts — bun-port cron-block render module
// per ADR-053 §D4. Pure rendering (no I/O), so the test harness is a
// straight assertion suite over `renderCronLines` + `renderCronBlock`.

import { describe, expect, test } from "bun:test";
import type { CrontabIO } from "../../../src/abstractions/crontab.ts";
import {
  cronAtHour,
  cronEvery,
  cronEveryHour,
  ensureEnvPreamble,
  findCronOrphans,
  installCronBlock,
  parseCronBlockTargets,
  renderCronBlock,
  renderCronLines,
  stripBlockByTeam,
  stripByAtmuxDir,
  stripOrphanLines,
} from "../../../src/core/cron.ts";
import { ConfigError } from "../../../src/errors.ts";
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
    // whip default schema-side is `intervalMins: 15` (src/schema/team.ts +
    // src/core/cron.ts:185 — bumped from 5min in t-dcbff97c).
    expect(lines).toEqual([
      `*/15 * * * * ${P}ATMUX_DIR=/srv/demo/.atmux /usr/local/bin/atmux whip >> /srv/demo/.atmux/logs/whip.log 2>&1`,
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

  // ---------- ADR-062 §Decision 4: lane-tick line ----------

  test("lane-tick line: ≥1 member with .lane emits `*/2 ... lane-tick` line", () => {
    const team = baseTeam({
      members: [{ name: "fe", role: "fe", lane: "fe", cwd: "/x" } as never],
    });
    const lines = renderCronLines(baseOpts(team));
    const laneLines = lines.filter((l) => l.includes(" lane-tick "));
    expect(laneLines.length).toBe(1);
    expect(laneLines[0]).toBe(
      `*/2 * * * * ${P}ATMUX_DIR=/srv/demo/.atmux /usr/local/bin/atmux lane-tick >> /srv/demo/.atmux/logs/lane-tick.log 2>&1`,
    );
    // Placed last per "least-churn diff" — total 4 base + lane-tick = 5,
    // and lane-tick is the final line.
    expect(lines.length).toBe(5);
    expect(lines.at(-1)).toContain("lane-tick");
  });

  test("lane-tick line: zero members with .lane → no line emitted", () => {
    const team = baseTeam({
      members: [
        { name: "fe", role: "fe", cwd: "/x" } as never, // no .lane
        { name: "be", role: "be", cwd: "/x" } as never, // no .lane
      ],
    });
    const lines = renderCronLines(baseOpts(team));
    expect(lines.some((l) => l.includes("lane-tick"))).toBe(false);
    expect(lines.length).toBe(4);
  });

  test("lane-tick line: empty-string .lane treated as no lane (no emit)", () => {
    const team = baseTeam({
      members: [{ name: "fe", role: "fe", lane: "", cwd: "/x" } as never],
    });
    const lines = renderCronLines(baseOpts(team));
    expect(lines.some((l) => l.includes("lane-tick"))).toBe(false);
  });

  test("lane-tick line: crons.laneTickEnabled=false suppresses even with lane-tagged members", () => {
    const team = baseTeam({
      members: [{ name: "fe", role: "fe", lane: "fe", cwd: "/x" } as never],
      crons: { laneTickEnabled: false } as never,
    });
    const lines = renderCronLines(baseOpts(team));
    expect(lines.some((l) => l.includes("lane-tick"))).toBe(false);
  });

  test("lane-tick line: crons.laneTickEnabled=true (explicit) emits when lane member present", () => {
    const team = baseTeam({
      members: [{ name: "fe", role: "fe", lane: "fe", cwd: "/x" } as never],
      crons: { laneTickEnabled: true } as never,
    });
    const lines = renderCronLines(baseOpts(team));
    expect(lines.some((l) => l.includes("lane-tick"))).toBe(true);
  });

  test("lane-tick line: crons block undefined defaults to enabled (back-compat)", () => {
    const team = baseTeam({
      members: [{ name: "fe", role: "fe", lane: "fe", cwd: "/x" } as never],
      // crons unset — should still emit when lane-tagged member present.
    });
    const lines = renderCronLines(baseOpts(team));
    expect(lines.some((l) => l.includes("lane-tick"))).toBe(true);
  });

  test("lane-tick line: PATH= prefix + tmuxTmpdir flow through (same envelope as other lines)", () => {
    const team = baseTeam({
      members: [{ name: "fe", role: "fe", lane: "fe", cwd: "/x" } as never],
    });
    const lines = renderCronLines({
      ...baseOpts(team),
      tmuxTmpdir: "/tmp/atmux-demo",
    });
    const laneLine = lines.find((l) => l.includes("lane-tick"));
    expect(laneLine).toBeDefined();
    expect(laneLine).toContain(`PATH=${DEFAULT_PATH} `);
    expect(laneLine).toContain("TMUX_TMPDIR=/tmp/atmux-demo ");
    // Ordering: PATH=…TMUX_TMPDIR=…ATMUX_DIR= (matches the other lines'
    // env envelope).
    expect(laneLine!.indexOf("PATH=")).toBeLessThan(laneLine!.indexOf("TMUX_TMPDIR="));
    expect(laneLine!.indexOf("TMUX_TMPDIR=")).toBeLessThan(laneLine!.indexOf("ATMUX_DIR="));
  });

  test("lane-tick line: one lane-tagged member among several non-lane members still emits", () => {
    const team = baseTeam({
      members: [
        { name: "lead", role: "lead", cwd: "/x" } as never,
        { name: "fe", role: "fe", lane: "fe", cwd: "/x" } as never,
        { name: "discord", role: "discorder", cwd: "/x" } as never,
      ],
    });
    const lines = renderCronLines(baseOpts(team));
    expect(lines.some((l) => l.includes("lane-tick"))).toBe(true);
  });
});

// ADR-079 §A: cron-expression helpers.
describe("cronEvery", () => {
  test("divisors of 60 render `*/N * * * *`", () => {
    expect(cronEvery(1)).toBe("*/1 * * * *");
    expect(cronEvery(2)).toBe("*/2 * * * *");
    expect(cronEvery(5)).toBe("*/5 * * * *");
    expect(cronEvery(10)).toBe("*/10 * * * *");
    expect(cronEvery(15)).toBe("*/15 * * * *");
    expect(cronEvery(30)).toBe("*/30 * * * *");
  });

  test("60 renders the on-the-hour form `0 * * * *`", () => {
    expect(cronEvery(60)).toBe("0 * * * *");
  });

  test("non-divisor of 60 throws ConfigError (e.g. 7, 11, 25)", () => {
    expect(() => cronEvery(7)).toThrow(ConfigError);
    expect(() => cronEvery(11)).toThrow(ConfigError);
    expect(() => cronEvery(25)).toThrow(ConfigError);
    expect(() => cronEvery(7)).toThrow(/divisor of 60/);
  });

  test("out-of-range values throw ConfigError (0, -1, 61, 120)", () => {
    expect(() => cronEvery(0)).toThrow(ConfigError);
    expect(() => cronEvery(-1)).toThrow(ConfigError);
    expect(() => cronEvery(61)).toThrow(ConfigError);
    expect(() => cronEvery(120)).toThrow(ConfigError);
    expect(() => cronEvery(0)).toThrow(/1.{1,3}60/);
  });

  test("non-integer values throw ConfigError (3.5, NaN)", () => {
    expect(() => cronEvery(3.5)).toThrow(ConfigError);
    expect(() => cronEvery(Number.NaN)).toThrow(ConfigError);
  });
});

describe("cronEveryHour", () => {
  test("1 renders the on-the-hour form `0 * * * *`", () => {
    expect(cronEveryHour(1)).toBe("0 * * * *");
  });

  test("divisors of 24 render `0 */N * * *`", () => {
    expect(cronEveryHour(2)).toBe("0 */2 * * *");
    expect(cronEveryHour(3)).toBe("0 */3 * * *");
    expect(cronEveryHour(4)).toBe("0 */4 * * *");
    expect(cronEveryHour(6)).toBe("0 */6 * * *");
    expect(cronEveryHour(8)).toBe("0 */8 * * *");
    expect(cronEveryHour(12)).toBe("0 */12 * * *");
  });

  test("24 renders `0 0 * * *` (daily at midnight)", () => {
    expect(cronEveryHour(24)).toBe("0 0 * * *");
  });

  test("non-divisor of 24 throws ConfigError (5, 7, 11)", () => {
    expect(() => cronEveryHour(5)).toThrow(ConfigError);
    expect(() => cronEveryHour(7)).toThrow(ConfigError);
    expect(() => cronEveryHour(11)).toThrow(ConfigError);
    expect(() => cronEveryHour(5)).toThrow(/divisor of 24/);
  });

  test("out-of-range values throw ConfigError (0, -1, 25)", () => {
    expect(() => cronEveryHour(0)).toThrow(ConfigError);
    expect(() => cronEveryHour(-1)).toThrow(ConfigError);
    expect(() => cronEveryHour(25)).toThrow(ConfigError);
  });

  test("non-integer values throw ConfigError", () => {
    expect(() => cronEveryHour(2.5)).toThrow(ConfigError);
    expect(() => cronEveryHour(Number.NaN)).toThrow(ConfigError);
  });
});

describe("cronAtHour", () => {
  test("each hour 0..23 renders `0 H * * *`", () => {
    expect(cronAtHour(0)).toBe("0 0 * * *");
    expect(cronAtHour(4)).toBe("0 4 * * *");
    expect(cronAtHour(12)).toBe("0 12 * * *");
    expect(cronAtHour(23)).toBe("0 23 * * *");
  });

  test("out-of-range hour throws ConfigError (-1, 24, 25)", () => {
    expect(() => cronAtHour(-1)).toThrow(ConfigError);
    expect(() => cronAtHour(24)).toThrow(ConfigError);
    expect(() => cronAtHour(25)).toThrow(ConfigError);
  });

  test("non-integer hour throws ConfigError", () => {
    expect(() => cronAtHour(4.5)).toThrow(ConfigError);
    expect(() => cronAtHour(Number.NaN)).toThrow(ConfigError);
  });
});

// ADR-079 §A: integration — cron schedules read from team config.
describe("renderCronLines — config-driven schedules (ADR-079 §A)", () => {
  test("team.whip.intervalMins=10 → whip line uses */10", () => {
    const team = baseTeam({ whip: { intervalMins: 10 } as never });
    const lines = renderCronLines(baseOpts(team));
    const whip = lines.find((l) => / whip /.test(l) && !l.includes("whip-resume"));
    expect(whip).toBeDefined();
    expect(whip).toMatch(/^\*\/10 \* \* \* \* /);
  });

  test("team.report.intervalMins=60 → report line uses `0 * * * *`", () => {
    const team = baseTeam({ report: { intervalMins: 60 } as never });
    const lines = renderCronLines(baseOpts(team));
    const report = lines.find((l) => l.includes(" report "));
    expect(report).toBeDefined();
    expect(report).toMatch(/^0 \* \* \* \* /);
  });

  test("discorder + report.intervalMins=15 + heartbeatHours=2 → progress=*/15, heartbeat=0 */2", () => {
    const team = baseTeam({
      members: [{ name: "d", role: "discorder", cwd: "/x" } as never],
      report: { intervalMins: 15, heartbeatHours: 2 } as never,
    });
    const lines = renderCronLines(baseOpts(team));
    const progress = lines.find((l) => l.includes("discorder progress"));
    const heartbeat = lines.find((l) => l.includes("discorder heartbeat"));
    expect(progress).toBeDefined();
    expect(heartbeat).toBeDefined();
    expect(progress).toMatch(/^\*\/15 \* \* \* \* /);
    expect(heartbeat).toMatch(/^0 \*\/2 \* \* \* /);
  });

  test("team.decisions.intervalHours=6 → decisions digest uses `0 */6 * * *`", () => {
    const team = baseTeam({ decisions: { intervalHours: 6 } as never });
    const lines = renderCronLines(baseOpts(team));
    const digest = lines.find((l) => l.includes("decisions digest"));
    expect(digest).toBeDefined();
    expect(digest).toMatch(/^0 \*\/6 \* \* \* /);
  });

  test("team.decisions.intervalHours=1 → decisions digest uses `0 * * * *` (hourly)", () => {
    const team = baseTeam({ decisions: { intervalHours: 1 } as never });
    const lines = renderCronLines(baseOpts(team));
    const digest = lines.find((l) => l.includes("decisions digest"));
    expect(digest).toMatch(/^0 \* \* \* \* /);
  });

  test("team.groom.atHour=2 → groom line uses `0 2 * * *`", () => {
    const team = baseTeam({ groom: { atHour: 2 } as never });
    const lines = renderCronLines(baseOpts(team));
    const groom = lines.find((l) => l.includes("groom --quiet"));
    expect(groom).toBeDefined();
    expect(groom).toMatch(/^0 2 \* \* \* /);
  });

  test("team.groom.atHour=0 → groom line uses `0 0 * * *` (midnight)", () => {
    const team = baseTeam({ groom: { atHour: 0 } as never });
    const lines = renderCronLines(baseOpts(team));
    const groom = lines.find((l) => l.includes("groom --quiet"));
    expect(groom).toMatch(/^0 0 \* \* \* /);
  });

  test("unblocker member + team.unblocker.intervalMins=5 → unblocker line uses */5", () => {
    const team = baseTeam({
      members: [{ name: "u", role: "unblocker", cwd: "/x" } as never],
      unblocker: { intervalMins: 5 } as never,
    });
    const lines = renderCronLines(baseOpts(team));
    const u = lines.find((l) => l.includes("unblocker tick"));
    expect(u).toBeDefined();
    expect(u).toMatch(/^\*\/5 \* \* \* \* /);
  });

  test("whip-resume-check stays hardcoded at */1 even when other intervals change", () => {
    // Per ADR-079 §A: sub-1-min cadence isn't a tunable, it's the
    // ADR-053 §D4 post-pause latency floor.
    const team = baseTeam({
      whip: { intervalMins: 30, claudeAccount: "icloud" } as never,
    });
    const lines = renderCronLines(baseOpts(team));
    const resume = lines.find((l) => l.includes("whip-resume-check"));
    expect(resume).toBeDefined();
    expect(resume).toMatch(/^\*\/1 \* \* \* \* /);
  });

  test("invalid intervalMins (e.g. 7) throws ConfigError at render time", () => {
    const team = baseTeam({ whip: { intervalMins: 7 } as never });
    expect(() => renderCronLines(baseOpts(team))).toThrow(ConfigError);
    expect(() => renderCronLines(baseOpts(team))).toThrow(/divisor of 60/);
  });

  test("invalid heartbeatHours (e.g. 5) throws ConfigError when discorder present", () => {
    const team = baseTeam({
      members: [{ name: "d", role: "discorder", cwd: "/x" } as never],
      report: { heartbeatHours: 5 } as never,
    });
    expect(() => renderCronLines(baseOpts(team))).toThrow(ConfigError);
    expect(() => renderCronLines(baseOpts(team))).toThrow(/divisor of 24/);
  });

  test("invalid groom.atHour throws ConfigError", () => {
    const team = baseTeam({ groom: { atHour: 24 } as never });
    expect(() => renderCronLines(baseOpts(team))).toThrow(ConfigError);
  });

  test("all defaults → behavior unchanged from pre-ADR-079 (4 lines, byte-identical post-t-dcbff97c whip-default raise)", () => {
    const lines = renderCronLines(baseOpts(baseTeam()));
    // t-dcbff97c bumped whip default 5min → 15min; "pre-ADR-079
    // behavior unchanged" still holds — ADR-079 governs the
    // config-driven schedule surface, not the default value itself.
    expect(lines).toEqual([
      `*/15 * * * * ${P}ATMUX_DIR=/srv/demo/.atmux /usr/local/bin/atmux whip >> /srv/demo/.atmux/logs/whip.log 2>&1`,
      `*/30 * * * * ${P}ATMUX_DIR=/srv/demo/.atmux /usr/local/bin/atmux report >> /srv/demo/.atmux/logs/report.log 2>&1`,
      `0 */4 * * * ${P}ATMUX_DIR=/srv/demo/.atmux /usr/local/bin/atmux decisions digest >> /srv/demo/.atmux/logs/decisions-digest.log 2>&1`,
      `0 4 * * * ${P}ATMUX_DIR=/srv/demo/.atmux /usr/local/bin/atmux groom --quiet >> /srv/demo/.atmux/logs/groom.log 2>&1`,
    ]);
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

// ---------- ADR-083 IN §1: installCronBlock + helpers ----------

const ENV_PREAMBLE_FIRST =
  "# ─── env for atmux cron (avoids tmux segfaults from bare cron env) ───";
const ENV_TERM = "TERM=xterm-256color";

const header = (team: string): string =>
  `# >>> atmux:team=${team} — managed by atmux start; do not edit by hand`;
const footer = (team: string): string => `# <<< atmux:team=${team}`;

describe("stripBlockByTeam", () => {
  test("empty input → empty output", () => {
    expect(stripBlockByTeam("", "demo")).toBe("");
  });

  test("removes a single team-named block, leaves surrounding lines", () => {
    const body = [
      "# unrelated comment",
      "OTHER=1",
      header("demo"),
      "*/5 * * * * /bin/atmux whip",
      footer("demo"),
      "# trailing",
    ].join("\n");
    expect(stripBlockByTeam(body, "demo")).toBe(
      ["# unrelated comment", "OTHER=1", "# trailing"].join("\n"),
    );
  });

  test("leaves blocks for OTHER teams untouched", () => {
    const body = [
      header("demo"),
      "*/5 * * * * /bin/atmux whip",
      footer("demo"),
      header("other"),
      "*/5 * * * * /bin/atmux whip",
      footer("other"),
    ].join("\n");
    expect(stripBlockByTeam(body, "demo")).toBe(
      [header("other"), "*/5 * * * * /bin/atmux whip", footer("other")].join("\n"),
    );
  });

  test("no matching block → byte-identical pass-through", () => {
    const body = "OTHER=1\n# nothing here\n";
    expect(stripBlockByTeam(body, "demo")).toBe(body);
  });
});

describe("stripByAtmuxDir", () => {
  test("removes a rename-orphan block (same dir, different team name)", () => {
    const body = [
      header("old"),
      "*/5 * * * * ATMUX_DIR=/srv/demo/.atmux /bin/atmux whip",
      footer("old"),
      "# unrelated",
    ].join("\n");
    expect(stripByAtmuxDir(body, "/srv/demo/.atmux")).toBe("# unrelated");
  });

  test("leaves a block pointing at a different dir untouched", () => {
    const body = [
      header("other"),
      "*/5 * * * * ATMUX_DIR=/srv/other/.atmux /bin/atmux whip",
      footer("other"),
    ].join("\n");
    expect(stripByAtmuxDir(body, "/srv/demo/.atmux")).toBe(body);
  });

  test("does not prefix-match a longer atmux_dir (defensive needle)", () => {
    // ATMUX_DIR=/srv/demo/.atmux-extra would prefix-match /srv/demo/.atmux
    // without the trailing space/tab anchor. Confirm the block survives.
    const body = [
      header("extra"),
      "*/5 * * * * ATMUX_DIR=/srv/demo/.atmux-extra /bin/atmux whip",
      footer("extra"),
    ].join("\n");
    expect(stripByAtmuxDir(body, "/srv/demo/.atmux")).toBe(body);
  });

  test("unterminated block at EOF is preserved (corrupt-input safety)", () => {
    const body = [header("oops"), "ATMUX_DIR=/srv/x/.atmux /bin/atmux whip"].join("\n");
    expect(stripByAtmuxDir(body, "/srv/demo/.atmux")).toBe(body);
  });
});

describe("stripOrphanLines", () => {
  test("removes bare atmux verb lines OUTSIDE any marker block", () => {
    const body = [
      "*/5 * * * * /bin/atmux whip",
      "# unrelated comment",
      "0 4 * * * /bin/atmux groom --quiet",
    ].join("\n");
    expect(stripOrphanLines(body)).toBe("# unrelated comment");
  });

  test("leaves atmux lines INSIDE a marker block alone", () => {
    const body = [header("demo"), "*/5 * * * * /bin/atmux whip", footer("demo")].join("\n");
    expect(stripOrphanLines(body)).toBe(body);
  });

  test("only matches atmux verbs from the orphan-set (whip/report/decisions/groom/discorder/unblocker)", () => {
    const body = ["* * * * * /bin/atmux unknown-verb", "* * * * * /bin/atmux whip"].join("\n");
    expect(stripOrphanLines(body)).toBe("* * * * * /bin/atmux unknown-verb");
  });
});

describe("ensureEnvPreamble", () => {
  test("no atmux block → no preamble injected", () => {
    expect(ensureEnvPreamble("OTHER=1\n")).toBe("OTHER=1\n");
  });

  test("first install (has block, no preamble) → preamble prepended", () => {
    const body = `${header("demo")}\n*/5 * * * * /bin/atmux whip\n${footer("demo")}\n`;
    const out = ensureEnvPreamble(body);
    expect(out.startsWith(ENV_PREAMBLE_FIRST)).toBe(true);
    expect(out.includes(ENV_TERM)).toBe(true);
    expect(out.endsWith(body)).toBe(true);
  });

  test("idempotent: preamble already present → no second copy", () => {
    const preamble = `${ENV_PREAMBLE_FIRST}\nSHELL=/bin/bash\nPATH=/x\n${ENV_TERM}\n\n`;
    const body = `${preamble}${header("demo")}\n*/5 * * * * /bin/atmux whip\n${footer("demo")}\n`;
    expect(ensureEnvPreamble(body)).toBe(body);
  });
});

describe("installCronBlock", () => {
  const opts = (over: { team?: Partial<Team>; current?: string | null } = {}) => ({
    team: baseTeam(over.team ?? {}),
    atmuxDir: "/srv/demo/.atmux",
    atmuxBin: "/usr/local/bin/atmux",
    current: over.current ?? null,
  });

  test("fresh install on empty crontab → preamble + canonical block", () => {
    const out = installCronBlock(opts({ current: null }));
    expect(out.startsWith(ENV_PREAMBLE_FIRST)).toBe(true);
    expect(out.includes(header("demo"))).toBe(true);
    expect(out.includes(footer("demo"))).toBe(true);
    expect(out.includes(`${ENV_TERM}\n\n${header("demo")}`)).toBe(true);
  });

  test("idempotent re-install: same input → byte-identical output", () => {
    const out1 = installCronBlock(opts({ current: null }));
    const out2 = installCronBlock(opts({ current: out1 }));
    expect(out2).toBe(out1);
  });

  test("strips rename-orphan with same atmux_dir + leaves exactly ONE block", () => {
    const orphan = `${header("old-name")}\n*/5 * * * * ATMUX_DIR=/srv/demo/.atmux /usr/local/bin/atmux whip\n${footer("old-name")}\n`;
    const out = installCronBlock(opts({ current: orphan }));
    // After install: no old block, exactly one new block.
    expect(out.includes("old-name")).toBe(false);
    expect(out.includes(header("demo"))).toBe(true);
    const headerCount = out.split(header("demo")).length - 1;
    expect(headerCount).toBe(1);
  });

  test("preserves other teams' blocks", () => {
    const other = `${header("other")}\n*/5 * * * * ATMUX_DIR=/srv/other/.atmux /usr/local/bin/atmux whip\n${footer("other")}\n`;
    const out = installCronBlock(opts({ current: other }));
    expect(out.includes(header("other"))).toBe(true);
    expect(out.includes(footer("other"))).toBe(true);
    expect(out.includes(header("demo"))).toBe(true);
  });

  test("scrubs pre-marker bare atmux lines before install", () => {
    const polluted = "*/5 * * * * /bin/atmux whip\n0 4 * * * /bin/atmux groom --quiet\n";
    const out = installCronBlock(opts({ current: polluted }));
    // Pre-marker bare lines should be gone.
    expect(out.includes("*/5 * * * * /bin/atmux whip\n0 4")).toBe(false);
    // New canonical block should be present.
    expect(out.includes(header("demo"))).toBe(true);
    // The polluted lines should not appear outside the new block — confirm
    // by counting `atmux whip` mentions on cron lines (start with `*/N`
    // or `N`): exactly one, inside the new block.
    const cronWhipLines = out
      .split("\n")
      .filter((l) => /^\s*[\d*/, -]+\s+/.test(l) && /atmux whip(\s|$)/.test(l));
    expect(cronWhipLines.length).toBe(1);
  });

  test("install on crontab with unrelated user content → preserves user content + injects preamble", () => {
    const userCron = "MAILTO=ops@example.com\n0 0 * * * /usr/bin/backup.sh\n";
    const out = installCronBlock(opts({ current: userCron }));
    expect(out.includes("MAILTO=ops@example.com")).toBe(true);
    expect(out.includes("/usr/bin/backup.sh")).toBe(true);
    expect(out.includes(header("demo"))).toBe(true);
    expect(out.startsWith(ENV_PREAMBLE_FIRST)).toBe(true);
  });

  test("re-install with preamble already in place → preamble not duplicated", () => {
    const first = installCronBlock(opts({ current: null }));
    const again = installCronBlock(opts({ current: first }));
    // Count preamble marker occurrences — must be exactly 1.
    expect(again.split(ENV_PREAMBLE_FIRST).length - 1).toBe(1);
    expect(again.split(ENV_TERM).length - 1).toBe(1);
  });
});

// ---------- ADR-083 follow-up §DEFERRED row 2: cron-orphans ----------

describe("parseCronBlockTargets", () => {
  test("empty body → []", () => {
    expect(parseCronBlockTargets("")).toEqual([]);
  });

  test("crontab without any atmux block → []", () => {
    const body = "MAILTO=ops@example.com\n0 0 * * * /usr/bin/backup.sh\n";
    expect(parseCronBlockTargets(body)).toEqual([]);
  });

  test("single block with ATMUX_DIR → returns one target", () => {
    const body = [
      "# >>> atmux:team=demo — managed by atmux start; do not edit by hand",
      "*/5 * * * * PATH=/root/.bun/bin:/usr/bin ATMUX_DIR=/srv/demo/.atmux /usr/local/bin/atmux whip >> /srv/demo/.atmux/logs/whip.log 2>&1",
      "# <<< atmux:team=demo",
    ].join("\n");
    expect(parseCronBlockTargets(body)).toEqual([{ team: "demo", atmuxDir: "/srv/demo/.atmux" }]);
  });

  test("two blocks → two targets", () => {
    const body = [
      "# >>> atmux:team=alpha — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/alpha/.atmux /bin/atmux whip",
      "# <<< atmux:team=alpha",
      "# >>> atmux:team=beta — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/beta/.atmux /bin/atmux whip",
      "# <<< atmux:team=beta",
    ].join("\n");
    expect(parseCronBlockTargets(body)).toEqual([
      { team: "alpha", atmuxDir: "/srv/alpha/.atmux" },
      { team: "beta", atmuxDir: "/srv/beta/.atmux" },
    ]);
  });

  test("block without ATMUX_DIR in body → skipped (bash parity)", () => {
    // Bash awk guards: `team != "" && atmux_dir != ""` before emitting.
    const body = [
      "# >>> atmux:team=stub — managed by atmux start; do not edit by hand",
      "# placeholder, no ATMUX_DIR= yet",
      "# <<< atmux:team=stub",
    ].join("\n");
    expect(parseCronBlockTargets(body)).toEqual([]);
  });

  test("first ATMUX_DIR wins when multiple present in a block", () => {
    const body = [
      "# >>> atmux:team=demo — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/first /bin/atmux whip",
      "*/5 * * * * ATMUX_DIR=/second /bin/atmux report",
      "# <<< atmux:team=demo",
    ].join("\n");
    expect(parseCronBlockTargets(body)).toEqual([{ team: "demo", atmuxDir: "/first" }]);
  });

  test("header without canonical suffix → still captures team verbatim", () => {
    // Bash: sub(/<suffix>$/, "") is a no-op when suffix is missing; the
    // remaining header is the team string.
    const body = [
      "# >>> atmux:team=hand-edited-marker",
      "*/5 * * * * ATMUX_DIR=/srv/hand/.atmux /bin/atmux whip",
      "# <<< atmux:team=hand-edited-marker",
    ].join("\n");
    expect(parseCronBlockTargets(body)).toEqual([
      { team: "hand-edited-marker", atmuxDir: "/srv/hand/.atmux" },
    ]);
  });

  test("ATMUX_DIR value terminates at first whitespace, not newline", () => {
    const body = [
      "# >>> atmux:team=demo — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/demo/.atmux\tTMUX_TMPDIR=/tmp /bin/atmux whip",
      "# <<< atmux:team=demo",
    ].join("\n");
    expect(parseCronBlockTargets(body)).toEqual([{ team: "demo", atmuxDir: "/srv/demo/.atmux" }]);
  });
});

describe("findCronOrphans", () => {
  const fakeIO = (body: string | null): CrontabIO => ({
    read: async () => body,
    write: async () => {
      /* not invoked */
    },
    available: async () => true,
  });

  test("null crontab → []", async () => {
    const out = await findCronOrphans({
      io: fakeIO(null),
      dirExists: async () => false,
    });
    expect(out).toEqual([]);
  });

  test("empty crontab → []", async () => {
    const out = await findCronOrphans({
      io: fakeIO(""),
      dirExists: async () => false,
    });
    expect(out).toEqual([]);
  });

  test("all blocks live → []", async () => {
    const body = [
      "# >>> atmux:team=alpha — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/alpha/.atmux /bin/atmux whip",
      "# <<< atmux:team=alpha",
    ].join("\n");
    const out = await findCronOrphans({
      io: fakeIO(body),
      dirExists: async () => true,
    });
    expect(out).toEqual([]);
  });

  test("one orphan + one live → returns only the orphan", async () => {
    const body = [
      "# >>> atmux:team=alpha — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/alpha/.atmux /bin/atmux whip",
      "# <<< atmux:team=alpha",
      "# >>> atmux:team=ghost — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/ghost/.atmux /bin/atmux whip",
      "# <<< atmux:team=ghost",
    ].join("\n");
    const live = new Set(["/srv/alpha/.atmux"]);
    const out = await findCronOrphans({
      io: fakeIO(body),
      dirExists: async (p: string) => live.has(p),
    });
    expect(out).toEqual([{ team: "ghost", atmuxDir: "/srv/ghost/.atmux" }]);
  });

  test("dirExists checked per-orphan (no batching surprises)", async () => {
    const body = [
      "# >>> atmux:team=alpha — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/alpha/.atmux /bin/atmux whip",
      "# <<< atmux:team=alpha",
      "# >>> atmux:team=beta — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/beta/.atmux /bin/atmux whip",
      "# <<< atmux:team=beta",
    ].join("\n");
    const probed: string[] = [];
    await findCronOrphans({
      io: fakeIO(body),
      dirExists: async (p: string) => {
        probed.push(p);
        return false;
      },
    });
    expect(probed).toEqual(["/srv/alpha/.atmux", "/srv/beta/.atmux"]);
  });
});

// ---------- ADR-086: cockpit-scoped cron block ----------

describe("renderCockpitCronBlock", () => {
  test("renders the canonical pulse line with default interval (5)", async () => {
    const { renderCockpitCronBlock } = await import("../../../src/core/cron.ts");
    const out = renderCockpitCronBlock({ atmuxBin: "/usr/local/bin/atmux" });
    expect(out).toContain("# >>> atmux:cockpit");
    expect(out).toContain("# <<< atmux:cockpit");
    expect(out).toMatch(/^\*\/5 \* \* \* \* PATH=/m);
    expect(out).toContain("/usr/local/bin/atmux pulse");
    expect(out).toContain(">> /root/.atmux/logs/pulse.log 2>&1");
  });

  test("honors intervalMins override (10)", async () => {
    const { renderCockpitCronBlock } = await import("../../../src/core/cron.ts");
    const out = renderCockpitCronBlock({
      atmuxBin: "/u/atmux",
      pulseIntervalMins: 10,
    });
    expect(out).toMatch(/^\*\/10 \* \* \* \* /m);
  });

  test("--config flag baked in when cockpitConfigPath is set", async () => {
    const { renderCockpitCronBlock } = await import("../../../src/core/cron.ts");
    const out = renderCockpitCronBlock({
      atmuxBin: "/u/atmux",
      cockpitConfigPath: "/alt/cockpit.json",
    });
    expect(out).toContain("atmux pulse --config /alt/cockpit.json");
  });

  test("logPath override honored", async () => {
    const { renderCockpitCronBlock } = await import("../../../src/core/cron.ts");
    const out = renderCockpitCronBlock({
      atmuxBin: "/u/atmux",
      logPath: "/var/log/pulse.log",
    });
    expect(out).toContain(">> /var/log/pulse.log 2>&1");
  });

  test("byte-identical output for same opts (idempotence guarantee)", async () => {
    const { renderCockpitCronBlock } = await import("../../../src/core/cron.ts");
    const a = renderCockpitCronBlock({ atmuxBin: "/u/atmux" });
    const b = renderCockpitCronBlock({ atmuxBin: "/u/atmux" });
    expect(a).toBe(b);
  });
});

describe("stripCockpitBlock", () => {
  test("removes the cockpit marker-fenced block", async () => {
    const { stripCockpitBlock } = await import("../../../src/core/cron.ts");
    const body = [
      "FOO=bar",
      "# >>> atmux:cockpit — managed by atmux cockpit rebuild; do not edit by hand",
      "*/5 * * * * /u/atmux pulse",
      "# <<< atmux:cockpit",
      "OTHER=stuff",
    ].join("\n");
    expect(stripCockpitBlock(body)).toBe(["FOO=bar", "OTHER=stuff"].join("\n"));
  });

  test("empty body returns empty", async () => {
    const { stripCockpitBlock } = await import("../../../src/core/cron.ts");
    expect(stripCockpitBlock("")).toBe("");
  });

  test("no cockpit block → body returned verbatim", async () => {
    const { stripCockpitBlock } = await import("../../../src/core/cron.ts");
    expect(stripCockpitBlock("PATH=/bin\n# other\n")).toBe("PATH=/bin\n# other\n");
  });
});

describe("installCockpitCronBlock", () => {
  test("appends fresh block when current is null", async () => {
    const { installCockpitCronBlock } = await import("../../../src/core/cron.ts");
    const out = installCockpitCronBlock({ atmuxBin: "/u/atmux", current: null });
    expect(out).toContain("# >>> atmux:cockpit");
    expect(out).toContain("atmux pulse");
    // ensureEnvPreamble should fire — atmux:cockpit qualifies.
    expect(out).toContain("SHELL=/bin/bash");
  });

  test("re-install is byte-identical (idempotence)", async () => {
    const { installCockpitCronBlock } = await import("../../../src/core/cron.ts");
    const first = installCockpitCronBlock({ atmuxBin: "/u/atmux", current: null });
    const second = installCockpitCronBlock({ atmuxBin: "/u/atmux", current: first });
    expect(second).toBe(first);
  });

  test("does NOT touch per-team blocks", async () => {
    const { installCockpitCronBlock } = await import("../../../src/core/cron.ts");
    const existing = [
      "# >>> atmux:team=alpha — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/x/.atmux /u/atmux whip",
      "# <<< atmux:team=alpha",
    ].join("\n");
    const out = installCockpitCronBlock({ atmuxBin: "/u/atmux", current: existing });
    expect(out).toContain("atmux:team=alpha");
    expect(out).toContain("atmux:cockpit");
  });

  test("replaces an existing cockpit block (different interval)", async () => {
    const { installCockpitCronBlock } = await import("../../../src/core/cron.ts");
    const stale = installCockpitCronBlock({
      atmuxBin: "/u/atmux",
      pulseIntervalMins: 5,
      current: null,
    });
    const fresh = installCockpitCronBlock({
      atmuxBin: "/u/atmux",
      pulseIntervalMins: 10,
      current: stale,
    });
    // Old 5-min line replaced by new 10-min line.
    expect(fresh).not.toContain("*/5 * * * * PATH=");
    expect(fresh).toContain("*/10 * * * * PATH=");
    // Only one cockpit block present.
    expect(fresh.split("# >>> atmux:cockpit").length - 1).toBe(1);
  });

  test("env preamble landing for cockpit-only crontab", async () => {
    const { installCockpitCronBlock } = await import("../../../src/core/cron.ts");
    const out = installCockpitCronBlock({ atmuxBin: "/u/atmux", current: "" });
    expect(out).toContain("SHELL=/bin/bash");
    expect(out).toContain("PATH=/usr/local/sbin");
    expect(out).toContain("TERM=xterm-256color");
  });
});

// ---------- ADR-133 TR6: migrateSuperdoctorToMedicCronLines ----------

describe("migrateSuperdoctorToMedicCronLines", () => {
  test("empty body → no-op", async () => {
    const { migrateSuperdoctorToMedicCronLines } = await import("../../../src/core/cron.ts");
    expect(migrateSuperdoctorToMedicCronLines("")).toEqual({ body: "", migrated: 0 });
  });

  test("body with no superdoctor refs → no-op", async () => {
    const { migrateSuperdoctorToMedicCronLines } = await import("../../../src/core/cron.ts");
    const body = [
      "# >>> atmux:team=alpha — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/x /u/atmux whip",
      "# <<< atmux:team=alpha",
    ].join("\n");
    const result = migrateSuperdoctorToMedicCronLines(body);
    expect(result.body).toBe(body);
    expect(result.migrated).toBe(0);
  });

  test("rewrites atmux superdoctor → atmux medic INSIDE per-team block", async () => {
    const { migrateSuperdoctorToMedicCronLines } = await import("../../../src/core/cron.ts");
    const body = [
      "# >>> atmux:team=alpha — managed by atmux start; do not edit by hand",
      "0 * * * * ATMUX_DIR=/x /u/atmux superdoctor --tick",
      "# <<< atmux:team=alpha",
    ].join("\n");
    const result = migrateSuperdoctorToMedicCronLines(body);
    expect(result.body).toContain("/u/atmux medic --tick");
    expect(result.body).not.toContain("atmux superdoctor");
    expect(result.migrated).toBe(1);
  });

  test("rewrites atmux superdoctor → atmux medic INSIDE cockpit block", async () => {
    const { migrateSuperdoctorToMedicCronLines } = await import("../../../src/core/cron.ts");
    const body = [
      "# >>> atmux:cockpit — managed by atmux cockpit rebuild; do not edit by hand",
      "0 * * * * PATH=/u/bin /u/atmux superdoctor",
      "# <<< atmux:cockpit",
    ].join("\n");
    const result = migrateSuperdoctorToMedicCronLines(body);
    expect(result.body).toContain("/u/atmux medic");
    expect(result.migrated).toBe(1);
  });

  test("PRESERVES operator-manual atmux superdoctor lines outside managed blocks", async () => {
    const { migrateSuperdoctorToMedicCronLines } = await import("../../../src/core/cron.ts");
    const body = [
      "# operator-manual cron entry",
      "0 0 * * * /u/atmux superdoctor --my-custom-flag",
      "# >>> atmux:team=alpha — managed by atmux start; do not edit by hand",
      "0 * * * * /u/atmux superdoctor",
      "# <<< atmux:team=alpha",
    ].join("\n");
    const result = migrateSuperdoctorToMedicCronLines(body);
    // Operator-manual line untouched.
    expect(result.body).toContain("0 0 * * * /u/atmux superdoctor --my-custom-flag");
    // Managed line rewritten.
    expect(result.body).toContain("0 * * * * /u/atmux medic\n");
    expect(result.migrated).toBe(1);
  });

  test("idempotent — re-running on already-migrated body is no-op", async () => {
    const { migrateSuperdoctorToMedicCronLines } = await import("../../../src/core/cron.ts");
    const body = [
      "# >>> atmux:team=alpha — managed by atmux start; do not edit by hand",
      "0 * * * * /u/atmux superdoctor",
      "# <<< atmux:team=alpha",
    ].join("\n");
    const first = migrateSuperdoctorToMedicCronLines(body);
    const second = migrateSuperdoctorToMedicCronLines(first.body);
    expect(second.body).toBe(first.body);
    expect(second.migrated).toBe(0);
  });

  test("rewrites multiple superdoctor lines across multiple blocks", async () => {
    const { migrateSuperdoctorToMedicCronLines } = await import("../../../src/core/cron.ts");
    const body = [
      "# >>> atmux:team=alpha — managed by atmux start; do not edit by hand",
      "0 * * * * /u/atmux superdoctor --once",
      "# <<< atmux:team=alpha",
      "# >>> atmux:cockpit — managed by atmux cockpit rebuild; do not edit by hand",
      "0 0 * * * /u/atmux superdoctor",
      "# <<< atmux:cockpit",
    ].join("\n");
    const result = migrateSuperdoctorToMedicCronLines(body);
    expect(result.migrated).toBe(2);
    expect(result.body).not.toContain("atmux superdoctor");
    expect((result.body.match(/atmux medic/g) ?? []).length).toBe(2);
  });

  test("does NOT rewrite atmux superdoctor inside a comment line in a managed block", async () => {
    // Defensive — we still rewrite within the regex (\b boundary), and
    // commented-out cron entries are intentionally inside the block.
    // This documents the behavior: ALL lines inside a managed block are
    // candidates, including commented ones.
    const { migrateSuperdoctorToMedicCronLines } = await import("../../../src/core/cron.ts");
    const body = [
      "# >>> atmux:team=alpha — managed by atmux start; do not edit by hand",
      "# 0 * * * * /u/atmux superdoctor  (disabled)",
      "0 * * * * /u/atmux whip",
      "# <<< atmux:team=alpha",
    ].join("\n");
    const result = migrateSuperdoctorToMedicCronLines(body);
    // Commented line rewritten too (within managed block).
    expect(result.body).toContain("# 0 * * * * /u/atmux medic");
    expect(result.migrated).toBe(1);
  });
});

// ---------- ADR-148 §D4 / T3: lane-stall-watch cron line ----------

describe("renderCronLines — lane-stall-watch (ADR-148 §D4 / T3)", () => {
  test("absent cadence block → no lane-stall-tick line", () => {
    const lines = renderCronLines(baseOpts(baseTeam()));
    expect(lines.find((l) => l.includes("lane-stall-tick"))).toBeUndefined();
  });

  test("cadence.enabled=false → no lane-stall-tick line", () => {
    const team = baseTeam({
      cadence: { enabled: false, laneStallEnabled: true },
    } as never);
    const lines = renderCronLines(baseOpts(team));
    expect(lines.find((l) => l.includes("lane-stall-tick"))).toBeUndefined();
  });

  test("cadence.enabled=true + laneStallEnabled=true → renders at 5min default", () => {
    const team = baseTeam({
      cadence: { enabled: true, laneStallEnabled: true },
    } as never);
    const lines = renderCronLines(baseOpts(team));
    const ll = lines.find((l) => l.includes("lane-stall-tick"));
    expect(ll).toBeDefined();
    expect(ll).toMatch(/^\*\/5 /);
    expect(ll).toContain("lane-stall-tick");
    expect(ll).toContain("/srv/demo/.atmux/logs/lane-stall.log");
  });

  test("cadence.enabled=true + laneStallEnabled=false → suppressed", () => {
    const team = baseTeam({
      cadence: { enabled: true, laneStallEnabled: false },
    } as never);
    const lines = renderCronLines(baseOpts(team));
    expect(lines.find((l) => l.includes("lane-stall-tick"))).toBeUndefined();
  });

  test("laneStallIntervalOverride beats default 5min", () => {
    const team = baseTeam({
      cadence: { enabled: true, laneStallEnabled: true },
    } as never);
    const lines = renderCronLines({
      ...baseOpts(team),
      laneStallIntervalOverride: 10,
    });
    const ll = lines.find((l) => l.includes("lane-stall-tick"));
    expect(ll).toMatch(/^\*\/10 /);
  });
});

// ---------- ADR-134 T7: gitter-sweep cron line ----------

describe("renderCronLines — gitter-sweep (ADR-134 T7)", () => {
  const withGitter = (overrides: Partial<Team> = {}): Team =>
    baseTeam({
      members: [{ name: "gitter", role: "gitter" }] as never,
      ...overrides,
    });

  test("absent autoMerge block → no gitter --sweep line", () => {
    const lines = renderCronLines(baseOpts(withGitter()));
    expect(lines.find((l) => l.includes("gitter --sweep"))).toBeUndefined();
  });

  test("autoMerge.enabled=false → no gitter --sweep line", () => {
    const team = withGitter({ autoMerge: { enabled: false } } as never);
    const lines = renderCronLines(baseOpts(team));
    expect(lines.find((l) => l.includes("gitter --sweep"))).toBeUndefined();
  });

  test("autoMerge.enabled=true WITHOUT a role:gitter member → suppressed", () => {
    const team = baseTeam({
      autoMerge: { enabled: true } as never,
      members: [{ name: "lead", role: "lead" }] as never,
    });
    const lines = renderCronLines(baseOpts(team));
    expect(lines.find((l) => l.includes("gitter --sweep"))).toBeUndefined();
  });

  test("autoMerge.enabled=true + role:gitter member → renders at 10min default", () => {
    const team = withGitter({ autoMerge: { enabled: true } } as never);
    const lines = renderCronLines(baseOpts(team));
    const gl = lines.find((l) => l.includes("gitter --sweep"));
    expect(gl).toBeDefined();
    expect(gl).toMatch(/^\*\/10 /);
    expect(gl).toContain("gitter --sweep");
    expect(gl).toContain("/srv/demo/.atmux/logs/gitter-sweep.log");
  });

  test("autoMerge.cronBackstopMin overrides the 10min default", () => {
    const team = withGitter({
      autoMerge: { enabled: true, cronBackstopMin: 5 },
    } as never);
    const lines = renderCronLines(baseOpts(team));
    const gl = lines.find((l) => l.includes("gitter --sweep"));
    expect(gl).toMatch(/^\*\/5 /);
  });

  test("gitterSweepIntervalOverride beats team.autoMerge.cronBackstopMin", () => {
    const team = withGitter({
      autoMerge: { enabled: true, cronBackstopMin: 5 },
    } as never);
    const lines = renderCronLines({
      ...baseOpts(team),
      gitterSweepIntervalOverride: 15,
    });
    const gl = lines.find((l) => l.includes("gitter --sweep"));
    expect(gl).toMatch(/^\*\/15 /);
  });

  test("idempotence: same opts yield byte-equal lines", () => {
    const team = withGitter({ autoMerge: { enabled: true } } as never);
    expect(renderCronLines(baseOpts(team))).toEqual(renderCronLines(baseOpts(team)));
  });
});
