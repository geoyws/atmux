// Unit tests for src/verbs/report.ts (ADR-010).
// Bash spec ref: lib/report.sh @ worktree-frozen.
//
// Coverage strategy
// -----------------
// Pure helpers (parseReportArgs, selectShipped/InProgress/Blocked,
// selectOpenAsks, formatTaskRow, buildReportBody, buildDiscordSections)
// tested directly. Side-effect helpers (readLastReportEpoch /
// writeLastReportEpoch) tested against fixture .atmux/. Public verb
// driven against fixture team.json + injected discordSend + clock,
// plus one ATMUX_DISCORD_RECORDER pass to cover the default discordSend
// branch without spinning a real fetch.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscordSection, DiscordSendOpts } from "../../../src/abstractions/discord.ts";
import { ConfigError, DiscordWebhookError, UsageError } from "../../../src/errors.ts";
import type { KanbanTask } from "../../../src/schema/kanban.ts";
import {
  buildDiscordSections,
  buildReportBody,
  defaultStderrWrite,
  defaultStdoutWrite,
  formatTaskRow,
  parseReportArgs,
  readLastReportEpoch,
  report,
  selectBlocked,
  selectInProgress,
  selectOpenAsks,
  selectShipped,
  writeLastReportEpoch,
} from "../../../src/verbs/report.ts";

// ---------- parseReportArgs ----------

describe("parseReportArgs", () => {
  test("default — pushDiscord=true, no teamDir", () => {
    expect(parseReportArgs([])).toEqual({ pushDiscord: true });
  });

  test("--no-discord flips pushDiscord to false", () => {
    expect(parseReportArgs(["--no-discord"])).toEqual({ pushDiscord: false });
  });

  test("--team-dir captured", () => {
    expect(parseReportArgs(["--team-dir", "/tmp/proj"])).toEqual({
      pushDiscord: true,
      teamDir: "/tmp/proj",
    });
  });

  test("--no-discord + --team-dir combine", () => {
    expect(parseReportArgs(["--no-discord", "--team-dir", "/x"])).toEqual({
      pushDiscord: false,
      teamDir: "/x",
    });
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseReportArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseReportArgs(["--bogus"])).toThrow(UsageError);
  });
});

// ---------- Pure selection helpers ----------

const mkTask = (overrides: Partial<KanbanTask>): KanbanTask => ({
  id: overrides.id ?? "t-1",
  ...overrides,
});

describe("selectShipped", () => {
  test("filters status=done with completedAt > sinceEpoch (strict gt)", () => {
    const tasks: KanbanTask[] = [
      mkTask({ id: "t-1", status: "done", completedAt: 100 }),
      mkTask({ id: "t-2", status: "done", completedAt: 50 }),
      mkTask({ id: "t-3", status: "done", completedAt: 50 }), // exactly equal — excluded
      mkTask({ id: "t-4", status: "in-progress", completedAt: 200 }), // wrong status
      mkTask({ id: "t-5", status: "done" }), // missing completedAt → 0 < 50 — excluded
    ];
    expect(selectShipped(tasks, 50).map((t) => t.id)).toEqual(["t-1"]);
  });

  test("sinceEpoch=0 includes every done task with positive completedAt", () => {
    const tasks: KanbanTask[] = [
      mkTask({ id: "a", status: "done", completedAt: 1 }),
      mkTask({ id: "b", status: "done", completedAt: 999_999 }),
      mkTask({ id: "c", status: "done" }), // completedAt missing → 0 → excluded
    ];
    expect(selectShipped(tasks, 0).map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("selectInProgress / selectBlocked", () => {
  const tasks: KanbanTask[] = [
    mkTask({ id: "ip", status: "in-progress" }),
    mkTask({ id: "bl", status: "blocked" }),
    mkTask({ id: "td", status: "todo" }),
    mkTask({ id: "dn", status: "done" }),
  ];

  test("selectInProgress returns only in-progress", () => {
    expect(selectInProgress(tasks).map((t) => t.id)).toEqual(["ip"]);
  });

  test("selectBlocked returns only blocked", () => {
    expect(selectBlocked(tasks).map((t) => t.id)).toEqual(["bl"]);
  });
});

describe("selectOpenAsks", () => {
  test("captures bullets between ## Open and the next ## section", () => {
    const md = [
      "# Driver inbox",
      "",
      "## Open",
      "- ask one",
      "- ask two",
      "",
      "## Archive",
      "- old ask (excluded)",
    ].join("\n");
    expect(selectOpenAsks(md)).toEqual(["- ask one", "- ask two"]);
  });

  test("ignores non-bullet lines inside Open block", () => {
    const md = "## Open\nplain prose (skipped)\n- real ask\n";
    expect(selectOpenAsks(md)).toEqual(["- real ask"]);
  });

  test("returns [] when no Open section present", () => {
    expect(selectOpenAsks("# heading\n- not in open\n")).toEqual([]);
  });

  test("strips CR (\\r) from CRLF-encoded inboxes", () => {
    const md = "## Open\r\n- crlf ask\r\n## Archive\r\n";
    expect(selectOpenAsks(md)).toEqual(["- crlf ask"]);
  });

  test("re-entering Open after a different section is allowed (sticky boundary)", () => {
    // Stops at next `## ` regardless of label. After Archive starts, no
    // further bullets count even if syntactically `- foo`.
    const md = "## Open\n- a\n## Mid\n- b\n## Open\n- c\n";
    expect(selectOpenAsks(md)).toEqual(["- a", "- c"]);
  });
});

describe("formatTaskRow", () => {
  test("renders emoji + id + owner + subject", () => {
    expect(formatTaskRow("✅", mkTask({ id: "t-9", owner: "alpha", subject: "ship it" }))).toBe(
      "  ✅ t-9 · alpha · ship it",
    );
  });

  test("owner defaults to ? when null", () => {
    expect(formatTaskRow("🟡", mkTask({ id: "t-1", owner: null, subject: "x" }))).toBe(
      "  🟡 t-1 · ? · x",
    );
  });

  test("owner defaults to ? when empty string", () => {
    expect(formatTaskRow("🟡", mkTask({ id: "t-1", owner: "", subject: "x" }))).toBe(
      "  🟡 t-1 · ? · x",
    );
  });

  test("missing subject renders as empty string", () => {
    expect(formatTaskRow("🟡", mkTask({ id: "t-1", owner: "a" }))).toBe("  🟡 t-1 · a · ");
  });
});

// ---------- Body builders ----------

describe("buildReportBody", () => {
  test("all-empty state — header + Shipped:0 + In-progress (none)", () => {
    const body = buildReportBody({
      team: "demo",
      timestamp: "2026-05-05 15:00:00 MYT",
      shipped: [],
      inProgress: [],
      blocked: [],
      openAsks: [],
    });
    expect(body).toContain("📊 **[atmux-report]** · `demo` · 2026-05-05 15:00:00 MYT");
    expect(body).toContain("🏗️ **Shipped** (since last report): 0");
    expect(body).toContain("🟡 **In-progress**\n  (none)");
    expect(body).not.toContain("🛑 **Blocked**");
    expect(body).not.toContain("🙏 **Open driver-inbox asks**");
  });

  test("populated state — every section emitted in order", () => {
    const body = buildReportBody({
      team: "demo",
      timestamp: "ts",
      shipped: [mkTask({ id: "s1", owner: "a", subject: "shipped one", status: "done" })],
      inProgress: [mkTask({ id: "i1", owner: "b", subject: "in flight", status: "in-progress" })],
      blocked: [mkTask({ id: "b1", owner: "c", subject: "stuck", status: "blocked" })],
      openAsks: ["- ask one"],
    });
    expect(body).toContain("🏗️ **Shipped** (since last report): 1");
    expect(body).toContain("✅ s1 · a · shipped one");
    expect(body).toContain("🟡 **In-progress**\n  🟡 i1 · b · in flight");
    expect(body).toContain("🛑 **Blocked**\n  🛑 b1 · c · stuck");
    expect(body).toContain("🙏 **Open driver-inbox asks**\n- ask one");
  });
});

describe("buildDiscordSections", () => {
  test("empty state — Shipped placeholder + In-progress placeholder, no blocked/asks", () => {
    const sections = buildDiscordSections({
      team: "t",
      timestamp: "ts",
      shipped: [],
      inProgress: [],
      blocked: [],
      openAsks: [],
    });
    expect(sections.length).toBe(2);
    expect(sections[0]?.label).toBe("🏗️ **Shipped** (since last report): 0");
    expect(sections[0]?.bullets).toEqual(["📊 (none since last report)"]);
    expect(sections[1]?.label).toBe("🟡 **In-progress**");
    expect(sections[1]?.bullets).toEqual(["📊 (none)"]);
  });

  test("populated — bullets carry allowed prefixes + ≤80 graphemes", () => {
    const sections = buildDiscordSections({
      team: "t",
      timestamp: "ts",
      shipped: [mkTask({ id: "s1", owner: "a", subject: "ship it" })],
      inProgress: [mkTask({ id: "i1", owner: "b", subject: "wip" })],
      blocked: [mkTask({ id: "b1", owner: "c", subject: "stuck" })],
      openAsks: ["- need george call"],
    });
    expect(sections.length).toBe(4);
    expect(sections[0]?.bullets).toEqual(["✅ s1 · a · ship it"]);
    expect(sections[1]?.bullets).toEqual(["🟡 i1 · b · wip"]);
    expect(sections[2]?.label).toBe("🛑 **Blocked**");
    expect(sections[2]?.bullets).toEqual(["🛑 b1 · c · stuck"]);
    expect(sections[3]?.label).toBe("🙏 **Open driver-inbox asks**");
    expect(sections[3]?.bullets).toEqual(["🙏 need george call"]);
  });

  test("long subject truncated with ellipsis to fit ≤80 chars", () => {
    const long = "x".repeat(200);
    const sections = buildDiscordSections({
      team: "t",
      timestamp: "ts",
      shipped: [mkTask({ id: "s1", owner: "a", subject: long })],
      inProgress: [],
      blocked: [],
      openAsks: [],
    });
    const bullet = sections[0]?.bullets[0] ?? "";
    expect(bullet.endsWith("…")).toBe(true);
    expect(bullet.length).toBeLessThanOrEqual(80);
    expect(bullet.startsWith("✅ s1 · a · ")).toBe(true);
  });

  test("long open-ask truncated with ellipsis", () => {
    const long = `- ${"y".repeat(200)}`;
    const sections = buildDiscordSections({
      team: "t",
      timestamp: "ts",
      shipped: [],
      inProgress: [],
      blocked: [],
      openAsks: [long],
    });
    // shipped + in-progress placeholders + open-asks (no blocked)
    expect(sections.length).toBe(3);
    const bullet = sections[2]?.bullets[0] ?? "";
    expect(bullet.startsWith("🙏 ")).toBe(true);
    expect(bullet.endsWith("…")).toBe(true);
    expect(bullet.length).toBeLessThanOrEqual(80);
  });
});

// ---------- Side-effect helpers ----------

describe("readLastReportEpoch / writeLastReportEpoch", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-report-epoch-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("read returns 0 when state/last-report.epoch absent", async () => {
    expect(await readLastReportEpoch(dir)).toBe(0);
  });

  test("write creates state dir + persists integer with trailing newline", async () => {
    await writeLastReportEpoch(dir, 1_700_000_000);
    const text = await readFile(join(dir, "state", "last-report.epoch"), "utf8");
    expect(text).toBe("1700000000\n");
    expect(await readLastReportEpoch(dir)).toBe(1_700_000_000);
  });

  test("read returns 0 on malformed contents", async () => {
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(join(dir, "state", "last-report.epoch"), "not-a-number\n");
    expect(await readLastReportEpoch(dir)).toBe(0);
  });

  test("read returns 0 on negative contents", async () => {
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(join(dir, "state", "last-report.epoch"), "-42\n");
    expect(await readLastReportEpoch(dir)).toBe(0);
  });

  test("read trims surrounding whitespace before parse", async () => {
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(join(dir, "state", "last-report.epoch"), "   42  \n");
    expect(await readLastReportEpoch(dir)).toBe(42);
  });
});

// ---------- defaultStdoutWrite / defaultStderrWrite ----------

describe("defaultStdoutWrite / defaultStderrWrite", () => {
  test("forward to process.stdout/stderr.write", () => {
    let stdoutBuf = "";
    let stderrBuf = "";
    const origStdout = process.stdout.write.bind(process.stdout);
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((s: string | Uint8Array) => {
      stdoutBuf += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((s: string | Uint8Array) => {
      stderrBuf += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      defaultStdoutWrite("rep-out\n");
      defaultStderrWrite("rep-err\n");
      expect(stdoutBuf).toBe("rep-out\n");
      expect(stderrBuf).toBe("rep-err\n");
    } finally {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    }
  });
});

// ---------- report() — public verb ----------

const seedTeam = async (atmuxDir: string, name: string): Promise<void> => {
  await mkdir(atmuxDir, { recursive: true });
  await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name, members: [] }));
};

describe("report() — public verb", () => {
  let teamDir: string;
  let atmuxDir: string;
  let stdoutBuf: string;
  let stderrBuf: string;
  const stdout = (s: string): void => {
    stdoutBuf += s;
  };
  const stderr = (s: string): void => {
    stderrBuf += s;
  };

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-report-verb-"));
    atmuxDir = join(teamDir, ".atmux");
    stdoutBuf = "";
    stderrBuf = "";
  });

  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true });
  });

  test("UsageError on unknown arg propagates from parseReportArgs", async () => {
    await expect(report(["--bogus"])).rejects.toBeInstanceOf(UsageError);
  });

  test("ConfigError when no team.json", async () => {
    await expect(report(["--team-dir", teamDir])).rejects.toBeInstanceOf(ConfigError);
  });

  test("happy path — empty kanban + no driver inbox + injected discord", async () => {
    await seedTeam(atmuxDir, "demo");
    const sent: DiscordSendOpts[] = [];
    const exit = await report(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_730_000_000_000,
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    expect(exit).toBe(0);
    expect(stdoutBuf).toContain("📊 **[atmux-report]** · `demo` ·");
    expect(stdoutBuf).toContain("🏗️ **Shipped** (since last report): 0");
    expect(stdoutBuf).toContain("🟡 **In-progress**\n  (none)");
    expect(sent.length).toBe(1);
    expect(sent[0]?.template).toBe("report-digest");
    expect(sent[0]?.team).toBe("demo");
    expect(sent[0]?.category).toBe("📊");
    expect(sent[0]?.whenMs).toBe(1_730_000_000_000);
    // Last-report epoch persisted as nowSec.
    const epoch = await readLastReportEpoch(atmuxDir);
    expect(epoch).toBe(1_730_000_000);
  });

  test("--no-discord skips the send", async () => {
    await seedTeam(atmuxDir, "demo");
    let called = false;
    await report(["--no-discord", "--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_730_000_001_000,
      discordSend: async () => {
        called = true;
      },
    });
    expect(called).toBe(false);
    // Epoch still updated.
    expect(await readLastReportEpoch(atmuxDir)).toBe(1_730_000_001);
  });

  test("kanban tasks → shipped/in-progress/blocked sections feed discord", async () => {
    await seedTeam(atmuxDir, "demo");
    await writeFile(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({
        tasks: [
          { id: "t-1", subject: "shipped fresh", status: "done", owner: "alpha", completedAt: 99 },
          { id: "t-2", subject: "shipped stale", status: "done", owner: "alpha", completedAt: 10 },
          { id: "t-3", subject: "wip", status: "in-progress", owner: "bravo" },
          { id: "t-4", subject: "stuck", status: "blocked", owner: "charlie" },
          { id: "t-5", subject: "todo", status: "todo", owner: "alpha" },
        ],
        epics: [],
        stories: [],
      }),
    );
    // Pre-stage epoch so t-2 falls below the cutoff (50 < completedAt 10
    // is false — t-2 excluded; t-1 included since 50 < 99 is true).
    await writeLastReportEpoch(atmuxDir, 50);
    const sent: DiscordSendOpts[] = [];
    await report(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_730_000_000_000,
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    const sections = (sent[0]?.sections ?? []) as DiscordSection[];
    expect(sections[0]?.label).toBe("🏗️ **Shipped** (since last report): 1");
    expect(sections[0]?.bullets).toEqual(["✅ t-1 · alpha · shipped fresh"]);
    expect(sections[1]?.bullets).toEqual(["🟡 t-3 · bravo · wip"]);
    expect(sections[2]?.label).toBe("🛑 **Blocked**");
    expect(sections[2]?.bullets).toEqual(["🛑 t-4 · charlie · stuck"]);
  });

  test("driver-inbox open asks surface in the sections", async () => {
    await seedTeam(atmuxDir, "demo");
    await writeFile(
      join(atmuxDir, "driver-inbox.md"),
      ["# Driver inbox", "", "## Open", "- decide push policy", "## Archive", "- old"].join("\n"),
    );
    const sent: DiscordSendOpts[] = [];
    await report(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_730_000_000_000,
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    const sections = (sent[0]?.sections ?? []) as DiscordSection[];
    const asksSection = sections.find((s) => s.label.includes("Open driver-inbox asks"));
    expect(asksSection?.bullets).toEqual(["🙏 decide push policy"]);
  });

  test("discord ConfigError → soft-swallowed (no stderr warn)", async () => {
    await seedTeam(atmuxDir, "demo");
    const exit = await report(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_730_000_000_000,
      discordSend: async () => {
        throw new ConfigError({ what: "no Discord webhook resolved", hint: "" });
      },
    });
    expect(exit).toBe(0);
    expect(stderrBuf).toBe("");
  });

  test("non-Config discord error → stderr warn line, still exit 0", async () => {
    await seedTeam(atmuxDir, "demo");
    const exit = await report(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_730_000_000_000,
      discordSend: async () => {
        throw new DiscordWebhookError({ template: "report-digest", detail: "boom" });
      },
    });
    expect(exit).toBe(0);
    expect(stderrBuf).toContain("atmux: warn: report: discord ping failed:");
    expect(stderrBuf).toContain("boom");
  });

  test("non-Error rejection still produces a stderr line via String(e)", async () => {
    await seedTeam(atmuxDir, "demo");
    const exit = await report(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_730_000_000_000,
      discordSend: async () => {
        // biome-ignore lint/suspicious/noExplicitAny: deliberately exercise the String(e) fallback
        throw "string-rejection" as any;
      },
    });
    expect(exit).toBe(0);
    expect(stderrBuf).toContain("string-rejection");
  });

  test("webhookOverride forwarded to discordSend opts", async () => {
    await seedTeam(atmuxDir, "demo");
    const sent: DiscordSendOpts[] = [];
    await report(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_730_000_000_000,
      webhookOverride: "https://hook.example/x",
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    expect(sent[0]?.webhookOverride).toBe("https://hook.example/x");
  });

  test("default discordSend wired — exercised via ATMUX_DISCORD_RECORDER", async () => {
    // Routes through the real `send()` (covering the `?? discordSend`
    // default branch in report.ts) but the recorder env var short-
    // circuits the actual Discord HTTP path — JSONL chunks are written
    // to a tmp file instead.
    await seedTeam(atmuxDir, "rec-demo");
    const recorder = join(teamDir, "discord-recorder.jsonl");
    const prior = process.env.ATMUX_DISCORD_RECORDER;
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    try {
      const exit = await report(["--team-dir", teamDir], {
        stdout,
        stderr,
        now: () => 1_730_000_000_000,
      });
      expect(exit).toBe(0);
      const recorded = await readFile(recorder, "utf8");
      expect(recorded).toContain("[report-digest]");
      expect(recorded).toContain("rec-demo");
    } finally {
      if (prior === undefined) delete process.env.ATMUX_DISCORD_RECORDER;
      else process.env.ATMUX_DISCORD_RECORDER = prior;
    }
  });

  test("default stdout/stderr sinks engaged when opts omit them", async () => {
    await seedTeam(atmuxDir, "demo");
    let captured = "";
    const origStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => {
      captured += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stdout.write;
    try {
      await report(["--no-discord", "--team-dir", teamDir], {
        now: () => 1_730_000_000_000,
      });
    } finally {
      process.stdout.write = origStdout;
    }
    expect(captured).toContain("📊 **[atmux-report]** · `demo`");
  });
});
