// Unit tests for src/verbs/whip.ts (ADR-010 + ADR-022).
// Bash spec ref: lib/whip.sh @ HEAD 2aadc3f — IN-SCOPE SUBSET only.
//
// Coverage strategy
// -----------------
// Pure helpers (parseWhipArgs, readWhipConfig, classifySessionState,
// staleAnchor, selectStaleTasks, accountFromConfigDir, parseEnviron,
// bullet80, lead-marker path helpers) tested directly. Side-effect
// helpers (writeLeadSessionStart / ensureLeadSessionStart /
// readLeadSessionStart / readLeadWindowName) tested with fixture HOME.
// Public verb driven against fixture .atmux/ + injected tmux/clock/env/
// discordSend/readMemberEnv covering: every Check 1..5 outcome,
// per-member crashed/HARD/SOFT/compact/queued/cross-account branches,
// lock-contention skip, --init-lead-marker short-circuit, --no-discord,
// --heartbeat, ConfigError soft-swallow, non-Config discord error stderr.
//
// Default `discordSend` branch covered via ATMUX_DISCORD_RECORDER (same
// pattern as report.test.ts). Default `tmux` factory covered by
// `getDefaultSocket(team.name)` — verified by attempting an unhealthy
// session check against an unreachable socket (returns false; whip
// reports session DOWN). Default `readMemberEnv` (reads /proc/<pid>/environ)
// is exercised on Linux by stamping a known PID 1 (init's environ is
// always readable on Linux); the test skips on non-Linux. Default `now`
// branch covered by omitting `opts.now` and asserting whip exits 0.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscordSendOpts } from "../../../src/abstractions/discord.ts";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { ConfigError, DiscordWebhookError, UsageError } from "../../../src/errors.ts";
import {
  accountFromConfigDir,
  bullet80,
  classifySessionState,
  ensureLeadSessionStart,
  leadSessionStartPath,
  leadWindowNamePath,
  parseEnviron,
  parseWhipArgs,
  readLeadSessionStart,
  readLeadWindowName,
  readWhipConfig,
  selectStaleTasks,
  staleAnchor,
  whip,
  writeLeadSessionStart,
} from "../../../src/verbs/whip.ts";

// ---------- parseWhipArgs ----------

describe("parseWhipArgs", () => {
  test("default — pushDiscord=true, no init/heartbeat/teamDir", () => {
    expect(parseWhipArgs([])).toEqual({
      pushDiscord: true,
      initLeadMarker: false,
      forceHeartbeat: false,
    });
  });
  test("--no-discord flips pushDiscord", () => {
    expect(parseWhipArgs(["--no-discord"]).pushDiscord).toBe(false);
  });
  test("--init-lead-marker captured", () => {
    expect(parseWhipArgs(["--init-lead-marker"]).initLeadMarker).toBe(true);
  });
  test("--heartbeat captured", () => {
    expect(parseWhipArgs(["--heartbeat"]).forceHeartbeat).toBe(true);
  });
  test("--team-dir captured", () => {
    expect(parseWhipArgs(["--team-dir", "/x"]).teamDir).toBe("/x");
  });
  test("--team-dir without value → UsageError", () => {
    expect(() => parseWhipArgs(["--team-dir"])).toThrow(UsageError);
  });
  test("unknown arg → UsageError", () => {
    expect(() => parseWhipArgs(["--bogus"])).toThrow(UsageError);
  });
});

// ---------- readWhipConfig ----------

describe("readWhipConfig", () => {
  const baseTeam = { name: "t", members: [] };

  test("missing whip → defaults", () => {
    const cfg = readWhipConfig(baseTeam as never, {});
    expect(cfg).toEqual({
      staleMin: 90,
      leadMaxMin: 60,
      downConfirmTicks: 2,
      heartbeat: true,
      autoRotate: false,
      budgetPauseThreshold: 90,
      budgetResumeThreshold: 80,
      budgetWarningBands: [0.5, 0.25, 0.15],
      budgetRefreshLeadMins: 30,
      accountFallback: [],
      accountSwapTriggerThreshold: 75,
      accountSwapFallbackHealthThreshold: 50,
      accountSwapExcludeRoles: ["lead", "planner", "reviewer"],
      claudeAccount: "",
      selfHealEnabled: false,
      selfHealRecipes: [],
      selfHealTokenCaps: {},
    });
  });

  test("whip null/non-object → defaults (no throw)", () => {
    const cfg = readWhipConfig({ ...baseTeam, whip: null } as never, {});
    expect(cfg.staleMin).toBe(90);
    const cfg2 = readWhipConfig({ ...baseTeam, whip: 42 } as never, {});
    expect(cfg2.staleMin).toBe(90);
  });

  test("whip sub-fields override defaults", () => {
    const cfg = readWhipConfig(
      {
        ...baseTeam,
        whip: {
          staleMin: 120,
          leadMaxMin: 30,
          downConfirmTicks: 3,
          heartbeat: false,
          autoRotate: true,
        },
      } as never,
      {},
    );
    expect(cfg).toEqual({
      staleMin: 120,
      leadMaxMin: 30,
      downConfirmTicks: 3,
      heartbeat: false,
      autoRotate: true,
      budgetPauseThreshold: 90,
      budgetResumeThreshold: 80,
      budgetWarningBands: [0.5, 0.25, 0.15],
      budgetRefreshLeadMins: 30,
      accountFallback: [],
      accountSwapTriggerThreshold: 75,
      accountSwapFallbackHealthThreshold: 50,
      accountSwapExcludeRoles: ["lead", "planner", "reviewer"],
      claudeAccount: "",
      selfHealEnabled: false,
      selfHealRecipes: [],
      selfHealTokenCaps: {},
    });
  });

  test("non-numeric / negative whip values fall through to defaults", () => {
    const cfg = readWhipConfig(
      { ...baseTeam, whip: { staleMin: -1, leadMaxMin: 0, downConfirmTicks: -2 } } as never,
      {},
    );
    expect(cfg.staleMin).toBe(90);
    expect(cfg.leadMaxMin).toBe(60);
    expect(cfg.downConfirmTicks).toBe(2);
  });

  test("non-finite numerics fall through (Infinity / NaN)", () => {
    const cfg = readWhipConfig(
      {
        ...baseTeam,
        whip: { staleMin: Number.POSITIVE_INFINITY, leadMaxMin: Number.NaN },
      } as never,
      {},
    );
    expect(cfg.staleMin).toBe(90);
    expect(cfg.leadMaxMin).toBe(60);
  });

  test("non-boolean heartbeat / autoRotate ignored", () => {
    const cfg = readWhipConfig(
      { ...baseTeam, whip: { heartbeat: "yes", autoRotate: 1 } } as never,
      {},
    );
    expect(cfg.heartbeat).toBe(true);
    expect(cfg.autoRotate).toBe(false);
  });

  test("env override ATMUX_STALE_MIN beats team config", () => {
    const cfg = readWhipConfig({ ...baseTeam, whip: { staleMin: 120 } } as never, {
      ATMUX_STALE_MIN: "45",
    });
    expect(cfg.staleMin).toBe(45);
  });

  test("env override ATMUX_LEAD_MAX_MIN beats team config", () => {
    const cfg = readWhipConfig({ ...baseTeam, whip: { leadMaxMin: 30 } } as never, {
      ATMUX_LEAD_MAX_MIN: "180",
    });
    expect(cfg.leadMaxMin).toBe(180);
  });

  test("invalid env override falls through (negative / NaN / empty)", () => {
    expect(readWhipConfig(baseTeam as never, { ATMUX_STALE_MIN: "-5" }).staleMin).toBe(90);
    expect(readWhipConfig(baseTeam as never, { ATMUX_STALE_MIN: "0" }).staleMin).toBe(90);
    expect(readWhipConfig(baseTeam as never, { ATMUX_STALE_MIN: "abc" }).staleMin).toBe(90);
    expect(readWhipConfig(baseTeam as never, { ATMUX_STALE_MIN: "" }).staleMin).toBe(90);
  });
});

// ---------- classifySessionState (2-tick gate) ----------

describe("classifySessionState", () => {
  test("session UP wipes lastDown → verdict=up, next={}", () => {
    expect(classifySessionState({ lastDown: { epoch: 1, count: 5 } }, true, 2, 999)).toEqual({
      verdict: "up",
      next: {},
    });
    expect(classifySessionState({}, true, 2, 999)).toEqual({ verdict: "up", next: {} });
  });
  test("first DOWN tick → suppress, count=1", () => {
    expect(classifySessionState({}, false, 2, 1000)).toEqual({
      verdict: "suppress",
      next: { lastDown: { epoch: 1000, count: 1 } },
    });
  });
  test("second DOWN tick (count=2 ≥ threshold=2) → report", () => {
    expect(classifySessionState({ lastDown: { epoch: 800, count: 1 } }, false, 2, 1000)).toEqual({
      verdict: "report",
      next: { lastDown: { epoch: 1000, count: 2 } },
    });
  });
  test("higher threshold suppresses until count crosses", () => {
    const r1 = classifySessionState({ lastDown: { epoch: 800, count: 1 } }, false, 3, 1000);
    expect(r1.verdict).toBe("suppress");
    expect(r1.next.lastDown?.count).toBe(2);
    const r2 = classifySessionState(r1.next, false, 3, 1100);
    expect(r2.verdict).toBe("report");
    expect(r2.next.lastDown?.count).toBe(3);
  });
});

// ---------- staleAnchor + selectStaleTasks ----------

describe("staleAnchor", () => {
  test("max(claimedAt, rotated) when claimed > rotated", () => {
    expect(staleAnchor(500, 100, 200)).toBe(500);
  });
  test("max(rotated, claimed) when rotated > claimed", () => {
    expect(staleAnchor(100, 50, 500)).toBe(500);
  });
  test("falls back to dispatchedAt when claimedAt absent", () => {
    expect(staleAnchor(null, 300, 0)).toBe(300);
    expect(staleAnchor(undefined, 300, 0)).toBe(300);
  });
  test("falls back to 0 when both timestamps absent", () => {
    expect(staleAnchor(null, null, 0)).toBe(0);
    expect(staleAnchor(undefined, undefined, 50)).toBe(50);
  });
});

describe("selectStaleTasks", () => {
  const now = 10_000;
  test("filters tasks whose anchor + threshold < now", () => {
    const tasks = [
      { id: "t-old", claimedAt: 1_000 }, // anchor 1000 + 90*60=5400 → 6400 < 10000 → stale
      { id: "t-fresh", claimedAt: 9_000 }, // 9000 + 5400 = 14400 > 10000 → not stale
      { id: "t-disp", dispatchedAt: 1_000 }, // anchor via dispatchedAt → stale
      { id: "t-no-anchor" }, // anchor=0 → 5400 < 10000 → stale
    ];
    const out = selectStaleTasks(tasks, now, 90, 0);
    expect(out.map((s) => s.id).sort()).toEqual(["t-disp", "t-no-anchor", "t-old"]);
  });
  test("rotated lifts the anchor and suppresses", () => {
    const tasks = [{ id: "t-1", claimedAt: 1_000 }];
    expect(selectStaleTasks(tasks, now, 90, 9_000)).toEqual([]);
  });
  test("per-task staleMin overrides default", () => {
    const tasks = [
      { id: "t-tight", claimedAt: 9_000, staleMin: 1 }, // 9000 + 60 = 9060 < 10000 → stale
      { id: "t-loose", claimedAt: 0, staleMin: 1_000 }, // 0 + 60_000 → not stale
    ];
    const out = selectStaleTasks(tasks, now, 90, 0);
    expect(out.map((s) => s.id)).toEqual(["t-tight"]);
  });
  test("non-positive per-task staleMin falls through to default", () => {
    const tasks = [{ id: "t", claimedAt: 1_000, staleMin: 0 }];
    expect(selectStaleTasks(tasks, now, 90, 0)).toHaveLength(1);
  });
});

// ---------- accountFromConfigDir + parseEnviron ----------

describe("accountFromConfigDir", () => {
  test("matches unum / icloud / default", () => {
    expect(accountFromConfigDir("/root/.claude-unum")).toBe("unum");
    expect(accountFromConfigDir("/Users/x/.claude-icloud/extra")).toBe("icloud");
    expect(accountFromConfigDir("/home/y/.claude")).toBe("default");
  });
  test("returns null for empty / null / undefined", () => {
    expect(accountFromConfigDir(null)).toBeNull();
    expect(accountFromConfigDir(undefined)).toBeNull();
    expect(accountFromConfigDir("")).toBeNull();
  });
  test("returns 'unknown' for unrecognised non-empty path", () => {
    expect(accountFromConfigDir("/tmp/something-else")).toBe("unknown");
  });
});

describe("parseEnviron", () => {
  test("splits NUL-separated key=value tokens", () => {
    const raw = "PATH=/usr/bin\0HOME=/root\0CLAUDE_CONFIG_DIR=/root/.claude-unum\0";
    expect(parseEnviron(raw)).toEqual({
      PATH: "/usr/bin",
      HOME: "/root",
      CLAUDE_CONFIG_DIR: "/root/.claude-unum",
    });
  });
  test("empty input → {}", () => {
    expect(parseEnviron("")).toEqual({});
  });
  test("skips malformed tokens (no =)", () => {
    const raw = "ok=1\0BARE\0=value\0another=2";
    expect(parseEnviron(raw)).toEqual({ ok: "1", another: "2" });
  });
  test("first occurrence wins on dupes", () => {
    expect(parseEnviron("X=1\0X=2")).toEqual({ X: "1" });
  });
  test("tolerates missing trailing NUL", () => {
    expect(parseEnviron("A=B")).toEqual({ A: "B" });
  });
});

// ---------- bullet80 ----------

describe("bullet80", () => {
  test("≤80 graphemes returned unchanged", () => {
    expect(bullet80("📊 short")).toBe("📊 short");
  });
  test(">80 graphemes truncated with ellipsis to ≤80", () => {
    const long = `📊 ${"x".repeat(200)}`;
    const out = bullet80(long);
    expect([...new Intl.Segmenter().segment(out)].length).toBeLessThanOrEqual(80);
    expect(out.endsWith("…")).toBe(true);
  });
});

// ---------- Lead-marker path helpers + ensure / read / write ----------

describe("lead-marker helpers", () => {
  let homeDir: string;
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "atmux-whip-home-"));
  });
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  test("leadSessionStartPath / leadWindowNamePath build under HOME/.claude/teams/<team>/", () => {
    expect(leadSessionStartPath("demo", { home: homeDir })).toBe(
      join(homeDir, ".claude", "teams", "demo", "lead-session-start.txt"),
    );
    expect(leadWindowNamePath("demo", { home: homeDir })).toBe(
      join(homeDir, ".claude", "teams", "demo", "lead-window-name.txt"),
    );
  });

  test("writeLeadSessionStart creates parent dir + content", async () => {
    await writeLeadSessionStart("demo", 12345, { home: homeDir });
    const got = await readFile(leadSessionStartPath("demo", { home: homeDir }), "utf8");
    expect(got).toBe("12345\n");
  });

  test("ensureLeadSessionStart writes when missing → true", async () => {
    expect(await ensureLeadSessionStart("demo", 1, { home: homeDir })).toBe(true);
    expect(await readLeadSessionStart("demo", { home: homeDir })).toBe(1);
  });

  test("ensureLeadSessionStart no-ops when present → false", async () => {
    await writeLeadSessionStart("demo", 7, { home: homeDir });
    expect(await ensureLeadSessionStart("demo", 100, { home: homeDir })).toBe(false);
    expect(await readLeadSessionStart("demo", { home: homeDir })).toBe(7);
  });

  test("readLeadSessionStart returns null when absent / malformed / negative", async () => {
    expect(await readLeadSessionStart("demo", { home: homeDir })).toBeNull();
    await mkdir(join(homeDir, ".claude", "teams", "demo"), { recursive: true });
    await writeFile(leadSessionStartPath("demo", { home: homeDir }), "not-a-number\n");
    expect(await readLeadSessionStart("demo", { home: homeDir })).toBeNull();
    await writeFile(leadSessionStartPath("demo", { home: homeDir }), "-42\n");
    expect(await readLeadSessionStart("demo", { home: homeDir })).toBeNull();
  });

  test("readLeadWindowName falls back to bash convention when marker absent", async () => {
    expect(await readLeadWindowName("demo", { home: homeDir })).toBe("__demo__team-lead");
  });

  test("readLeadWindowName trims + returns marker text when present", async () => {
    await mkdir(join(homeDir, ".claude", "teams", "demo"), { recursive: true });
    await writeFile(leadWindowNamePath("demo", { home: homeDir }), "  🧭lead  \n");
    expect(await readLeadWindowName("demo", { home: homeDir })).toBe("🧭lead");
  });

  test("readLeadWindowName falls back when marker file is whitespace-only", async () => {
    await mkdir(join(homeDir, ".claude", "teams", "demo"), { recursive: true });
    await writeFile(leadWindowNamePath("demo", { home: homeDir }), "   \n");
    expect(await readLeadWindowName("demo", { home: homeDir })).toBe("__demo__team-lead");
  });

  test("readLeadWindowName: opts.fallback wins when marker absent", async () => {
    // Caller-supplied fallback (the ADR-017-style `<emoji><name>` derived
    // from the team-lead member's schema entry) must take precedence over
    // the legacy `__<team>__team-lead` default. This is what stops whip
    // from emitting false `🛑 lead: window missing` findings on freshly-
    // started teams that haven't rotated the lead yet.
    expect(
      await readLeadWindowName("demo", { home: homeDir, fallback: "🧭lead" }),
    ).toBe("🧭lead");
  });

  test("readLeadWindowName: marker text wins over fallback when present", async () => {
    // Auto-rotate scenario: the lead pane was renamed mid-cycle, marker
    // file holds the new name. Even if a fallback is supplied, the
    // marker is authoritative — a stale fallback derived from the
    // pre-rotate schema must NOT mask the rename.
    await mkdir(join(homeDir, ".claude", "teams", "demo"), { recursive: true });
    await writeFile(leadWindowNamePath("demo", { home: homeDir }), "🧭lead-v2\n");
    expect(
      await readLeadWindowName("demo", { home: homeDir, fallback: "🧭lead" }),
    ).toBe("🧭lead-v2");
  });

  test("readLeadWindowName: empty fallback string falls through to legacy default", async () => {
    // Edge: caller passes fallback="". Should NOT short-circuit on the
    // empty string — drops to the legacy `__<team>__team-lead` form.
    expect(await readLeadWindowName("demo", { home: homeDir, fallback: "" })).toBe(
      "__demo__team-lead",
    );
  });

  test("path helpers default to os.homedir() when no opts.home given", () => {
    // Real homedir() returns a string — assert prefix without binding to
    // a specific value so the test is portable across CI / dev hosts.
    const p = leadSessionStartPath("demo");
    expect(p.endsWith("/.claude/teams/demo/lead-session-start.txt")).toBe(true);
    const w = leadWindowNamePath("demo");
    expect(w.endsWith("/.claude/teams/demo/lead-window-name.txt")).toBe(true);
  });
});

// ---------- whip() — public verb ----------

interface FakePane {
  paneCmd: string;
  state: string;
  pid: number;
  /** ADR-057 §D4c: optional cwd for the defunct-cwd probe. When unset
   *  or empty, the probe skips (matches the "cwd unknown → skip" path
   *  in src/verbs/whip.ts checkMember). */
  cwd?: string;
}

interface FakeTmuxSetup {
  /** session.hasSession returns this. */
  sessionUp: boolean;
  /** Map of windowName → FakePane (`undefined` = window missing). */
  panes: Record<string, FakePane | undefined>;
  /** Throw on the FIRST listWindows call (probes the catch-fallback). */
  failListWindows?: boolean;
  /** Throw on capture-pane (probes the empty-state fallback branch). */
  failCapturePane?: boolean;
  /** Throw on listPanes / displayMessage (probes the `pane probe failed` branch). */
  failPaneProbe?: boolean;
}

function buildFakeTmux(setup: FakeTmuxSetup): TmuxNamespace {
  const tmuxNs: Partial<TmuxNamespace> = {
    session: {
      hasSession: async () => setup.sessionUp,
      newSession: async () => {},
      killSession: async () => {},
      listSessions: async () => [],
      renameSession: async () => {},
    },
    window: {
      listWindows: async (_session: string) => {
        if (setup.failListWindows === true) throw new Error("list-windows boom");
        return Object.entries(setup.panes)
          .filter(([, p]) => p !== undefined)
          .map(([name], i) => ({ index: i, id: `@${i}`, name, active: false }));
      },
      newWindow: async () => ({ sessionName: "x", windowIndex: 0 }),
      killWindow: async () => {},
      renameWindow: async () => {},
      selectWindow: async () => {},
    },
    pane: {
      displayMessage: async (opts: { target: unknown; format: string }) => {
        if (setup.failPaneProbe === true) throw new Error("display boom");
        const target = String(opts.target);
        const wn = target.split(":")[1] ?? "";
        const p = setup.panes[wn];
        // ADR-057 §D4c: per-format dispatch — pane_current_path lookups
        // return the per-pane `cwd` field (or "" when unset; "" skips
        // the defunct-cwd check). Anything else returns paneCmd.
        if (opts.format.includes("pane_current_path")) {
          return p?.cwd ?? "";
        }
        return p?.paneCmd ?? "";
      },
      listPanes: async (target: unknown) => {
        if (setup.failPaneProbe === true) throw new Error("list-panes boom");
        const wn = String(target).split(":")[1] ?? "";
        const p = setup.panes[wn];
        if (p === undefined) return [];
        return [{ index: 0, pid: p.pid, title: "", width: 80, height: 24 }];
      },
      capturePane: async (opts: { target: unknown }) => {
        if (setup.failCapturePane === true) throw new Error("capture boom");
        const wn = String(opts.target).split(":")[1] ?? "";
        return setup.panes[wn]?.state ?? "";
      },
      sendKeys: async () => {},
      killPane: async () => {},
      splitWindow: async () => ({ sessionName: "x", windowIndex: 0, paneIndex: 0 }),
    },
    buffer: {
      loadBuffer: async () => {},
      pasteBuffer: async () => {},
      deleteBuffer: async () => {},
    },
    client: {
      attachSession: async () => {},
      switchClient: async () => {},
      listClients: async () => [],
    },
    option: {
      setOption: async () => {},
      showOptions: async () => ({}),
    },
    server: {
      hasServer: async () => true,
      killServer: async () => {},
    },
  };
  return tmuxNs as TmuxNamespace;
}

const seedTeam = async (
  atmuxDir: string,
  data: { name: string; members: unknown[]; whip?: unknown },
): Promise<void> => {
  await mkdir(atmuxDir, { recursive: true });
  await writeFile(join(atmuxDir, "team.json"), JSON.stringify(data));
};

describe("whip() — public verb", () => {
  let teamDir: string;
  let atmuxDir: string;
  let homeDir: string;
  let stdoutBuf: string;
  let stderrBuf: string;
  const stdout = (s: string): void => {
    stdoutBuf += s;
  };
  const stderr = (s: string): void => {
    stderrBuf += s;
  };

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-whip-verb-"));
    atmuxDir = join(teamDir, ".atmux");
    homeDir = await mkdtemp(join(tmpdir(), "atmux-whip-home-"));
    stdoutBuf = "";
    stderrBuf = "";
  });

  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  test("UsageError on unknown arg", async () => {
    await expect(whip(["--bogus"])).rejects.toBeInstanceOf(UsageError);
  });

  test("ConfigError when team.json missing", async () => {
    await expect(whip(["--team-dir", teamDir])).rejects.toBeInstanceOf(ConfigError);
  });

  test("--init-lead-marker writes the I-1 marker + early-returns 0", async () => {
    await seedTeam(atmuxDir, { name: "demo", members: [] });
    const exit = await whip(["--team-dir", teamDir, "--init-lead-marker"], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
    });
    expect(exit).toBe(0);
    expect(await readLeadSessionStart("demo", { home: homeDir })).toBe(1_700_000_000);
    expect(stdoutBuf).toContain("whip: lead marker written");
  });

  test("session UP, no members → all clean → heartbeat (default config.heartbeat=true)", async () => {
    await seedTeam(atmuxDir, { name: "demo", members: [] });
    const sent: DiscordSendOpts[] = [];
    const exit = await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    expect(exit).toBe(0);
    expect(stdoutBuf).toContain("whip: all clean");
    expect(sent.map((s) => s.template)).toEqual(["whip-heartbeat"]);
    // I-1 marker was auto-init'd
    expect(await readLeadSessionStart("demo", { home: homeDir })).toBe(1_700_000_000);
    // whip-last.hash anchor written
    const hash = await readFile(join(atmuxDir, "state", "whip-last.hash"), "utf8");
    expect(hash.trim()).toBe("1700000000");
  });

  test("session UP + heartbeat suppressed (config.heartbeat=false) → no Discord", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [],
      whip: { heartbeat: false },
    });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    expect(sent).toHaveLength(0);
  });

  test("--heartbeat forces 💓 even when team config suppresses", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [],
      whip: { heartbeat: false },
    });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir, "--heartbeat"], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    expect(sent.map((s) => s.template)).toEqual(["whip-heartbeat"]);
  });

  test("--no-discord skips every Discord send", async () => {
    await seedTeam(atmuxDir, { name: "demo", members: [] });
    let called = false;
    await whip(["--team-dir", teamDir, "--no-discord"], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
      discordSend: async () => {
        called = true;
      },
    });
    expect(called).toBe(false);
  });

  test("session DOWN — first tick suppressed, second tick reports", async () => {
    await seedTeam(atmuxDir, { name: "demo", members: [] });
    const tmux = buildFakeTmux({ sessionUp: false, panes: {} });

    // Tick 1: suppress (count=1 < threshold 2)
    let exit = await whip(["--team-dir", teamDir, "--no-discord"], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux,
    });
    expect(exit).toBe(0);
    expect(stdoutBuf).toContain("session DOWN (tick 1/2)");
    stdoutBuf = "";
    stderrBuf = "";

    // Tick 2: count=2 ≥ 2 → report. Run with discord pings to verify
    // a 🛑 [whip-blocker] is dispatched + a 📊 [whip-progress] digest.
    const sent: DiscordSendOpts[] = [];
    exit = await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_300_000,
      home: homeDir,
      env: {},
      tmux,
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    expect(exit).toBe(0);
    expect(stdoutBuf).toContain("session atmux-demo is DOWN");
    const templates = sent.map((s) => s.template);
    expect(templates).toContain("whip-blocker");
    expect(templates).toContain("whip-progress");
  });

  test("missing window finding (sessionUp=true, member roster empty in panes map)", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", role: "member", tui: "claude", emoji: "🐝" }],
    });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    const blocker = sent.find((s) => s.template === "whip-blocker");
    const blockerBullets = (blocker?.bullets ?? []) as string[];
    expect(blockerBullets.some((b) => b.includes("alice") && b.includes("window missing"))).toBe(
      true,
    );
  });

  test("crashed TUI finding (paneCmd=zsh != claude)", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
    });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🐝alice": { paneCmd: "zsh", state: "", pid: 0 } },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    const blocker = sent.find((s) => s.template === "whip-blocker");
    const bullets = (blocker?.bullets ?? []) as string[];
    expect(
      bullets.some((b) => b.includes("alice") && b.includes("zsh") && b.includes("claude")),
    ).toBe(true);
  });

  test("HARD rate-limit + compacting + queued-but-busy banners", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [
        { name: "rl", tui: "claude", emoji: "🐝" },
        { name: "compact", tui: "claude", emoji: "🦊" },
        { name: "queued", tui: "claude", emoji: "🦉" },
        { name: "busyq", tui: "claude", emoji: "🐢" },
        { name: "soft", tui: "claude", emoji: "🦜" },
      ],
    });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: {
          "🐝rl": { paneCmd: "claude", state: "you hit your limit\n", pid: 11 },
          "🦊compact": {
            paneCmd: "claude",
            state: "Compacting conversation...\n",
            pid: 12,
          },
          "🦉queued": {
            paneCmd: "claude",
            state: "Press up to edit queued messages\n",
            pid: 13,
          },
          "🐢busyq": {
            paneCmd: "claude",
            state: "Press up to edit queued messages\n thinking with 8k tokens\n",
            pid: 14,
          },
          "🦜soft": {
            paneCmd: "claude",
            state: "approaching usage limit (90% of window used)\n",
            pid: 15,
          },
        },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    const blocker = sent.find((s) => s.template === "whip-blocker");
    const bullets = (blocker?.bullets ?? []) as string[];
    expect(bullets.some((b) => b.includes("rl") && b.includes("HARD rate-limit"))).toBe(true);
    expect(bullets.some((b) => b.includes("compact") && b.includes("compacting"))).toBe(true);
    expect(bullets.some((b) => b.includes("queued") && b.includes("messages queued"))).toBe(true);
    // busyq: queued AND busy → must NOT produce a 'queued' bullet
    expect(bullets.some((b) => b.includes("busyq") && b.includes("messages queued"))).toBe(false);
    // SOFT lands as informational on the digest, not on the blocker channel.
    const progress = sent.find((s) => s.template === "whip-progress");
    const progressBullets = (progress?.bullets ?? []) as string[];
    expect(progressBullets.some((b) => b.includes("soft") && b.includes("SOFT rate-limit"))).toBe(
      true,
    );
  });

  test("ADR-024 cross-account drift detector — mismatch surfaces blocker", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
    });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: { CLAUDE_CONFIG_DIR: "/root/.claude-unum" },
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🐝alice": { paneCmd: "claude", state: "", pid: 1234 } },
      }),
      readMemberEnv: async () => ({ CLAUDE_CONFIG_DIR: "/Users/x/.claude-icloud" }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    const blocker = sent.find((s) => s.template === "whip-blocker");
    const bullets = (blocker?.bullets ?? []) as string[];
    expect(
      bullets.some(
        (b) => b.includes("alice") && b.includes("cross-account") && b.includes("icloud"),
      ),
    ).toBe(true);
  });

  test("ADR-024 cross-account drift — matching account → no finding", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
    });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: { CLAUDE_CONFIG_DIR: "/root/.claude-unum" },
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🐝alice": { paneCmd: "claude", state: "", pid: 1234 } },
      }),
      readMemberEnv: async () => ({
        CLAUDE_CONFIG_DIR: "/root/.claude-unum/agents",
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    // Heartbeat fires (no findings).
    expect(sent.map((s) => s.template)).toEqual(["whip-heartbeat"]);
  });

  test("cross-account skipped when driver has no CLAUDE_CONFIG_DIR", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
    });
    const sent: DiscordSendOpts[] = [];
    let envReadCount = 0;
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🐝alice": { paneCmd: "claude", state: "", pid: 1234 } },
      }),
      readMemberEnv: async () => {
        envReadCount += 1;
        return { CLAUDE_CONFIG_DIR: "/root/.claude-icloud" };
      },
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    // The cross-account check short-circuits when driver tag is null,
    // so readMemberEnv is never invoked.
    expect(envReadCount).toBe(0);
    expect(sent.map((s) => s.template)).toEqual(["whip-heartbeat"]);
  });

  test("cross-account skipped when /proc unreadable (readMemberEnv returns null)", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
    });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: { CLAUDE_CONFIG_DIR: "/root/.claude-unum" },
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🐝alice": { paneCmd: "claude", state: "", pid: 1234 } },
      }),
      readMemberEnv: async () => null,
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    expect(sent.map((s) => s.template)).toEqual(["whip-heartbeat"]);
  });

  test("cross-account skipped when readMemberEnv throws", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
    });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: { CLAUDE_CONFIG_DIR: "/root/.claude-unum" },
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🐝alice": { paneCmd: "claude", state: "", pid: 1234 } },
      }),
      readMemberEnv: async () => {
        throw new Error("EACCES");
      },
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    expect(sent.map((s) => s.template)).toEqual(["whip-heartbeat"]);
  });

  test("cross-account skipped when member tag unparseable / null", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
    });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: { CLAUDE_CONFIG_DIR: "/root/.claude-unum" },
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🐝alice": { paneCmd: "claude", state: "", pid: 1234 } },
      }),
      readMemberEnv: async () => ({}),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    expect(sent.map((s) => s.template)).toEqual(["whip-heartbeat"]);
  });

  test("stale-task scan — anchor + per-task overrides + rotated.epoch lift", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
      // Drop heartbeat so empty case doesn't compete with the overdue-only
      // assertion that follows.
      whip: { staleMin: 1, heartbeat: false },
    });
    // Inbox: t-old claimed long ago → stale; t-fresh just claimed → not stale
    await mkdir(join(atmuxDir, "inboxes"), { recursive: true });
    await writeFile(
      join(atmuxDir, "inboxes", "alice.json"),
      JSON.stringify({
        pending: [],
        inProgress: [
          { id: "t-old", claimedAt: 100 },
          { id: "t-fresh", claimedAt: 1_700_000_000 - 30 },
        ],
        done: [],
      }),
    );
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🐝alice": { paneCmd: "claude", state: "", pid: 0 } },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    const overdue = sent.find((s) => s.template === "whip-overdue");
    const bullets = (overdue?.bullets ?? []) as string[];
    expect(bullets.some((b) => b.includes("alice") && b.includes("1 task(s)"))).toBe(true);
  });

  test("stale-task scan tolerates missing inbox file", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
      whip: { staleMin: 1 },
    });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🐝alice": { paneCmd: "claude", state: "", pid: 0 } },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    expect(sent.find((s) => s.template === "whip-overdue")).toBeUndefined();
  });

  test("rotated.epoch lifts the staleness anchor", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
      whip: { staleMin: 1, heartbeat: false },
    });
    await mkdir(join(atmuxDir, "inboxes"), { recursive: true });
    await writeFile(
      join(atmuxDir, "inboxes", "alice.json"),
      JSON.stringify({
        pending: [],
        inProgress: [{ id: "t-old", claimedAt: 100 }],
        done: [],
      }),
    );
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    await writeFile(join(atmuxDir, "state", "alice-rotated.epoch"), `${1_700_000_000 - 10}\n`);
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🐝alice": { paneCmd: "claude", state: "", pid: 0 } },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    expect(sent.find((s) => s.template === "whip-overdue")).toBeUndefined();
  });

  test("rotated.epoch malformed → treated as 0 (no lift)", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
      whip: { staleMin: 1, heartbeat: false },
    });
    await mkdir(join(atmuxDir, "inboxes"), { recursive: true });
    await writeFile(
      join(atmuxDir, "inboxes", "alice.json"),
      JSON.stringify({
        pending: [],
        inProgress: [{ id: "t-old", claimedAt: 100 }],
        done: [],
      }),
    );
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    await writeFile(join(atmuxDir, "state", "alice-rotated.epoch"), "not-a-number\n");
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🐝alice": { paneCmd: "claude", state: "", pid: 0 } },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    expect(sent.find((s) => s.template === "whip-overdue")).toBeDefined();
  });

  test("Check 5: lead uptime ≥ leadMaxMin → recommend rotate (autoRotate=false)", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "lead", role: "team-lead", tui: "claude", emoji: "🧭" }],
      whip: { leadMaxMin: 1, heartbeat: false },
    });
    // Pre-stage I-1 marker with an epoch 5 min ago so uptime > 1min.
    await writeLeadSessionStart("demo", 1_700_000_000 - 300, { home: homeDir });
    // Pre-stage I-2 marker so the lead-window probe targets a known name.
    await mkdir(join(homeDir, ".claude", "teams", "demo"), { recursive: true });
    await writeFile(leadWindowNamePath("demo", { home: homeDir }), "🧭lead\n");
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🧭lead": { paneCmd: "claude", state: "", pid: 0 } },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    const overdue = sent.find((s) => s.template === "whip-overdue");
    const bullets = (overdue?.bullets ?? []) as string[];
    expect(bullets.some((b) => b.includes("lead uptime") && b.includes("rotate-lead"))).toBe(true);
  });

  test("Check 5: autoRotate=true changes recommend tail", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "lead", role: "team-lead", tui: "claude", emoji: "🧭" }],
      whip: { leadMaxMin: 1, autoRotate: true, heartbeat: false },
    });
    await writeLeadSessionStart("demo", 1_700_000_000 - 300, { home: homeDir });
    await mkdir(join(homeDir, ".claude", "teams", "demo"), { recursive: true });
    await writeFile(leadWindowNamePath("demo", { home: homeDir }), "🧭lead\n");
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🧭lead": { paneCmd: "claude", state: "", pid: 0 } },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    const overdue = sent.find((s) => s.template === "whip-overdue");
    const bullets = (overdue?.bullets ?? []) as string[];
    expect(bullets.some((b) => b.includes("V-26-deferred"))).toBe(true);
  });

  test("Check 5: skipped when start-epoch missing / negative-uptime", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "lead", role: "team-lead", tui: "claude", emoji: "🧭" }],
      whip: { leadMaxMin: 1, heartbeat: false },
    });
    // Marker absent — auto-init will stamp nowSec, so uptime computes as 0.
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🧭lead": { paneCmd: "claude", state: "", pid: 0 } },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    expect(sent.find((s) => s.template === "whip-overdue")).toBeUndefined();
  });

  test("Check 5: zero start-epoch (file present but content '0') → skipped", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "lead", role: "team-lead", tui: "claude", emoji: "🧭" }],
      whip: { leadMaxMin: 1, heartbeat: false },
    });
    await writeLeadSessionStart("demo", 0, { home: homeDir });
    await mkdir(join(homeDir, ".claude", "teams", "demo"), { recursive: true });
    await writeFile(leadWindowNamePath("demo", { home: homeDir }), "🧭lead\n");
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🧭lead": { paneCmd: "claude", state: "", pid: 0 } },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    expect(sent.find((s) => s.template === "whip-overdue")).toBeUndefined();
  });

  test("Check 5: future-clock skew (nowSec < startEpoch) → skipped", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "lead", role: "team-lead", tui: "claude", emoji: "🧭" }],
      whip: { leadMaxMin: 1, heartbeat: false },
    });
    // Marker stamps 5 min IN THE FUTURE — `nowSec - startEpoch` is negative.
    await writeLeadSessionStart("demo", 1_700_000_000 + 300, { home: homeDir });
    await mkdir(join(homeDir, ".claude", "teams", "demo"), { recursive: true });
    await writeFile(leadWindowNamePath("demo", { home: homeDir }), "🧭lead\n");
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🧭lead": { paneCmd: "claude", state: "", pid: 0 } },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    expect(sent.find((s) => s.template === "whip-overdue")).toBeUndefined();
  });

  test("listWindows throwing degrades gracefully (treated as no windows → missing-window finding)", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
    });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🐝alice": { paneCmd: "claude", state: "", pid: 0 } },
        failListWindows: true,
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    const blocker = sent.find((s) => s.template === "whip-blocker");
    expect((blocker?.bullets ?? []).some((b) => String(b).includes("window missing"))).toBe(true);
  });

  test("displayMessage / listPanes throw → 'pane probe failed' finding", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
    });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🐝alice": { paneCmd: "claude", state: "", pid: 0 } },
        failPaneProbe: true,
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    const blocker = sent.find((s) => s.template === "whip-blocker");
    expect((blocker?.bullets ?? []).some((b) => String(b).includes("pane probe failed"))).toBe(
      true,
    );
  });

  test("capture-pane throwing degrades to empty-state (no banner findings)", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
    });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🐝alice": { paneCmd: "claude", state: "", pid: 0 } },
        failCapturePane: true,
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    expect(sent.map((s) => s.template)).toEqual(["whip-heartbeat"]);
  });

  test("ConfigError discordSend → soft-swallow (no stderr warn)", async () => {
    await seedTeam(atmuxDir, { name: "demo", members: [] });
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
      discordSend: async () => {
        throw new ConfigError({ what: "no Discord webhook resolved" });
      },
    });
    expect(stderrBuf).toBe("");
  });

  test("non-Config discord error → stderr warn, still exit 0", async () => {
    await seedTeam(atmuxDir, { name: "demo", members: [] });
    const exit = await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
      discordSend: async () => {
        throw new DiscordWebhookError({ template: "whip-heartbeat", detail: "boom" });
      },
    });
    expect(exit).toBe(0);
    expect(stderrBuf).toContain("whip: discord ping failed");
    expect(stderrBuf).toContain("boom");
  });

  test("non-Error rejection routes through String(e) fallback", async () => {
    await seedTeam(atmuxDir, { name: "demo", members: [] });
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
      discordSend: async () => {
        // biome-ignore lint/suspicious/noExplicitAny: deliberately exercise the String(e) fallback
        throw "string-rejection" as any;
      },
    });
    expect(stderrBuf).toContain("string-rejection");
  });

  test("webhookOverride forwarded to discordSend opts", async () => {
    await seedTeam(atmuxDir, { name: "demo", members: [] });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      webhookOverride: "https://hook.example/x",
      env: {},
      tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    expect(sent[0]?.webhookOverride).toBe("https://hook.example/x");
  });

  test("default discordSend exercised via ATMUX_DISCORD_RECORDER", async () => {
    await seedTeam(atmuxDir, { name: "rec-demo", members: [] });
    const recorder = join(teamDir, "discord-recorder.jsonl");
    const prior = process.env.ATMUX_DISCORD_RECORDER;
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    try {
      const exit = await whip(["--team-dir", teamDir], {
        stdout,
        stderr,
        now: () => 1_700_000_000_000,
        home: homeDir,
        env: {},
        tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
      });
      expect(exit).toBe(0);
      const recorded = await readFile(recorder, "utf8");
      expect(recorded).toContain("[whip-heartbeat]");
      expect(recorded).toContain("rec-demo");
    } finally {
      if (prior === undefined) delete process.env.ATMUX_DISCORD_RECORDER;
      else process.env.ATMUX_DISCORD_RECORDER = prior;
    }
  });

  test("default stdout/stderr sinks engaged when opts omit them", async () => {
    await seedTeam(atmuxDir, { name: "demo", members: [] });
    let captured = "";
    const origStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => {
      captured += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stdout.write;
    try {
      await whip(["--team-dir", teamDir, "--no-discord"], {
        now: () => 1_700_000_000_000,
        home: homeDir,
        env: {},
        tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
      });
      expect(captured).toContain("whip: all clean");
    } finally {
      process.stdout.write = origStdout;
    }
  });

  test("default clock engaged when `now` omitted", async () => {
    await seedTeam(atmuxDir, { name: "demo", members: [] });
    const exit = await whip(["--team-dir", teamDir, "--no-discord"], {
      stdout,
      stderr,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
    });
    expect(exit).toBe(0);
  });

  test("default tmux factory engaged — falls through with cage socket; session-DOWN gate suppresses", async () => {
    await seedTeam(atmuxDir, { name: "demo", members: [] });
    // No `tmux` injection — whip resolves the default cage socketPath
    // `/tmp/atmux-demo/sock`, which doesn't exist; hasSession returns
    // false; classifySessionState verdict='suppress' on the first DOWN
    // tick. Just asserting the call completes without hitting the
    // defaultReadMemberEnv branch is enough — that path is covered by
    // the next test.
    const exit = await whip(["--team-dir", teamDir, "--no-discord"], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
    });
    expect(exit).toBe(0);
    expect(stdoutBuf).toContain("session DOWN");
  });

  test("defaultReadMemberEnv exercised against PID 1 on Linux (degrades on non-Linux)", async () => {
    if (process.platform !== "linux") return;
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
    });
    // The fake tmux returns pid=1 — defaultReadMemberEnv reads
    // /proc/1/environ which is always readable on Linux (even when
    // running as a low-priv user, init's environ is world-readable).
    // We don't assert on the env contents (depends on host); we just
    // assert that the read path was exercised without crashing.
    const sent: DiscordSendOpts[] = [];
    const exit = await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: { CLAUDE_CONFIG_DIR: "/root/.claude-unum" },
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🐝alice": { paneCmd: "claude", state: "", pid: 1 } },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    expect(exit).toBe(0);
  });

  test("corrupt whip-session-state.json → treated as fresh, first DOWN tick suppressed", async () => {
    await seedTeam(atmuxDir, { name: "demo", members: [] });
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    // Write an invalid-JSON state file so readSessionState's catch fires.
    await writeFile(join(atmuxDir, "state", "whip-session-state.json"), "{not valid json");
    const exit = await whip(["--team-dir", teamDir, "--no-discord"], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({ sessionUp: false, panes: {} }),
    });
    expect(exit).toBe(0);
    expect(stdoutBuf).toContain("session DOWN (tick 1/2)");
  });

  test("session state file with non-object lastDown / wrong field types → reset to fresh", async () => {
    await seedTeam(atmuxDir, { name: "demo", members: [] });
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    // Cover the early-return branches inside readSessionState's
    // structural validation: non-object root / non-object lastDown /
    // non-numeric epoch+count.
    const cases = [
      "null",
      JSON.stringify({ lastDown: null }),
      JSON.stringify({ lastDown: { epoch: "x", count: 1 } }),
    ];
    for (const c of cases) {
      await writeFile(join(atmuxDir, "state", "whip-session-state.json"), c);
      stdoutBuf = "";
      const exit = await whip(["--team-dir", teamDir, "--no-discord"], {
        stdout,
        stderr,
        now: () => 1_700_000_000_000,
        home: homeDir,
        env: {},
        tmux: buildFakeTmux({ sessionUp: false, panes: {} }),
      });
      expect(exit).toBe(0);
      expect(stdoutBuf).toContain("session DOWN (tick 1/2)");
    }
  });

  test("non-LockTimeout lock acquire error propagates (covers re-throw branch)", async () => {
    await seedTeam(atmuxDir, { name: "demo", members: [] });
    const explosion = new Error("flock library missing");
    await expect(
      whip(["--team-dir", teamDir, "--no-discord"], {
        stdout,
        stderr,
        now: () => 1_700_000_000_000,
        home: homeDir,
        env: {},
        tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
        lockAcquire: async () => {
          throw explosion;
        },
      }),
    ).rejects.toBe(explosion);
  });

  test("expectedTuiCmd: opencode / kimi / cursor map to the right pane_current_command", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [
        { name: "ocgood", tui: "opencode", emoji: "🦊" },
        { name: "ocbad", tui: "opencode", emoji: "🦉" },
        { name: "kgood", tui: "kimi", emoji: "🐢" },
        { name: "kbad", tui: "kimi", emoji: "🦀" },
        { name: "cgood", tui: "cursor", emoji: "🐙" },
        { name: "cbad", tui: "cursor", emoji: "🦜" },
        { name: "exotic", tui: "myshell", emoji: "🐝" },
      ],
    });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: {
          "🦊ocgood": { paneCmd: "opencode", state: "", pid: 0 },
          "🦉ocbad": { paneCmd: "zsh", state: "", pid: 0 },
          "🐢kgood": { paneCmd: "kimi", state: "", pid: 0 },
          "🦀kbad": { paneCmd: "bash", state: "", pid: 0 },
          "🐙cgood": { paneCmd: "cursor-agent", state: "", pid: 0 },
          "🦜cbad": { paneCmd: "fish", state: "", pid: 0 },
          // Unknown tui → expectedTuiCmd returns null → pass-through (no
          // mismatch finding even when paneCmd is something else entirely).
          "🐝exotic": { paneCmd: "fish", state: "", pid: 0 },
        },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    const blocker = sent.find((s) => s.template === "whip-blocker");
    const bullets = (blocker?.bullets ?? []) as string[];
    expect(bullets.some((b) => b.includes("ocbad") && b.includes("opencode"))).toBe(true);
    expect(bullets.some((b) => b.includes("kbad") && b.includes("kimi"))).toBe(true);
    expect(bullets.some((b) => b.includes("cbad") && b.includes("cursor-agent"))).toBe(true);
    expect(bullets.some((b) => b.includes("ocgood"))).toBe(false);
    expect(bullets.some((b) => b.includes("kgood"))).toBe(false);
    expect(bullets.some((b) => b.includes("cgood"))).toBe(false);
    expect(bullets.some((b) => b.includes("exotic"))).toBe(false);
  });

  // ---------- ADR-054 §D2 — config-drift detection in whip tick ----------

  test("ADR-054: valid team.json passes validation; no drift fires", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [],
      whip: { staleMin: 60, leadMaxMin: 45 }, // valid sub-shape
    });
    const sent: DiscordSendOpts[] = [];
    const exit = await whip(["--team-dir", teamDir, "--heartbeat"], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
    });
    expect(exit).toBe(0);
    // No drift template in any send.
    expect(sent.every((s) => s.template !== "whip-config-drift")).toBe(true);
  });

  test("ADR-054: team.json with extra unknown key → drift fires + safe defaults", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [],
      whip: { unknownTypoKey: 1, staleMin: 60 },
    });
    const sent: DiscordSendOpts[] = [];
    const exit = await whip(["--team-dir", teamDir, "--heartbeat"], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
    });
    expect(exit).toBe(0);
    const drift = sent.find((s) => s.template === "whip-config-drift");
    expect(drift).toBeDefined();
    expect(drift?.bullets?.some((b: string) => b.includes("safe defaults"))).toBe(true);
  });

  test("ADR-054: team.json with type mismatch → drift fires + safe default applied", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [],
      whip: { budgetPauseThreshold: "ninety" },
    });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir, "--heartbeat"], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
    });
    const drift = sent.find((s) => s.template === "whip-config-drift");
    expect(drift).toBeDefined();
    // The drift bullets should reference the type mismatch.
    expect(
      drift?.bullets?.some(
        (b: string) => b.includes("budgetPauseThreshold") || b.includes("invalid_type"),
      ),
    ).toBe(true);
  });

  test("ADR-054: malformed JSON → catastrophic drift + full-defaults fallback", async () => {
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(join(atmuxDir, "team.json"), "{not valid json");
    const sent: DiscordSendOpts[] = [];
    const exit = await whip(["--team-dir", teamDir, "--heartbeat"], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
    });
    expect(exit).toBe(0);
    const drift = sent.find((s) => s.template === "whip-config-drift");
    expect(drift).toBeDefined();
    expect(
      drift?.bullets?.some((b: string) => b.includes("malformed") || b.includes("full safe defaults")),
    ).toBe(true);
  });

  test("ADR-054: dedup — same drift on consecutive ticks → only 1 ping in 24h", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [],
      whip: { unknownTypoKey: 1 },
    });
    const sent: DiscordSendOpts[] = [];
    const sharedOpts = {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
    };
    await whip(["--team-dir", teamDir, "--heartbeat"], sharedOpts);
    await whip(["--team-dir", teamDir, "--heartbeat"], sharedOpts);
    const driftPings = sent.filter((s) => s.template === "whip-config-drift");
    // Only 1 drift ping despite 2 ticks with the same drift.
    expect(driftPings).toHaveLength(1);
  });

  test("ADR-054: --no-discord suppresses drift pings entirely", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [],
      whip: { unknownTypoKey: 1 },
    });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir, "--no-discord"], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
    });
    expect(sent.find((s) => s.template === "whip-config-drift")).toBeUndefined();
  });

  test("flock contention skips the tick (second concurrent invocation hits LockTimeoutError → 0)", async () => {
    await seedTeam(atmuxDir, { name: "demo", members: [] });
    const slowSend =
      (delayMs: number) =>
      async (_: DiscordSendOpts): Promise<void> => {
        await new Promise((res) => setTimeout(res, delayMs));
      };
    // Run two whip ticks racing for the same lock. Only one will
    // succeed in acquiring; the other will skip-tick + return 0 + log.
    const opts1 = {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
      discordSend: slowSend(150),
    } as const;
    const opts2 = {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
      discordSend: slowSend(150),
    } as const;
    const [r1, r2] = await Promise.all([
      whip(["--team-dir", teamDir, "--heartbeat"], opts1),
      whip(["--team-dir", teamDir, "--heartbeat"], opts2),
    ]);
    expect(r1).toBe(0);
    expect(r2).toBe(0);
    expect(stderrBuf).toContain("another instance is running");
  });

  test("ADR-057 §D2d: stale-anchor finding fires when lead's cursor >2h behind tip", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [],
      whip: { heartbeat: false },
    });
    // Pin "now" at 12:00 MYT today (epoch 1778126400 → ms 1778126400000).
    const nowMs = 1778126400 * 1000;
    const nowSec = 1778126400;
    // Seed driver-inbox.md with a tip 4h behind cursor.
    const inboxPath = join(atmuxDir, "driver-inbox.md");
    await writeFile(
      inboxPath,
      "## 09:00 MYT — old\n## 11:00 MYT — newer tip",
    );
    // Bump file mtime to "now" so cursor lag = 4h.
    const { utimes } = await import("node:fs/promises");
    await utimes(inboxPath, nowSec, nowSec);
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    await writeFile(
      join(atmuxDir, "state", "last-driver-inbox-read.txt"),
      String(nowSec - 4 * 3600),
    );

    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => nowMs,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({ sessionUp: true, panes: {} }),
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
    });
    const overdue = sent.find((s) => s.template === "whip-overdue");
    const bullets = (overdue?.bullets ?? []) as string[];
    expect(bullets.some((b) => b.includes("driver-inbox cursor") && b.includes("behind tip"))).toBe(
      true,
    );
  });

  // ---------- ADR-057 §D4 R57-T4 — per-member health probes ----------

  test("D4a perm-mode-drift: dont-ask member fires drift Discord ping", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
    });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: {
          "🐝alice": { paneCmd: "claude", state: "⏵⏵ don't ask on", pid: 1 },
        },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    const drift = sent.find((s) => s.template === "whip-perm-mode-drift");
    expect(drift).toBeDefined();
    const bullets = (drift?.bullets ?? []) as string[];
    expect(bullets.some((b) => b.includes("alice") && b.includes("dont-ask"))).toBe(true);
  });

  test("D4a perm-mode-drift: auto mode → no drift ping", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
    });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: {
          "🐝alice": { paneCmd: "claude", state: "⏵⏵ auto mode on", pid: 1 },
        },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    expect(sent.find((s) => s.template === "whip-perm-mode-drift")).toBeUndefined();
  });

  test("D4a perm-mode-drift: 24h dedup — second tick same day → no second ping", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
    });
    const tickOpts = (sent: DiscordSendOpts[]) => ({
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: {
          "🐝alice": { paneCmd: "claude", state: "⏵⏵ accept edits on", pid: 1 },
        },
      }),
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
    });
    const sent1: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], tickOpts(sent1));
    const sent2: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], tickOpts(sent2));
    expect(sent1.filter((s) => s.template === "whip-perm-mode-drift")).toHaveLength(1);
    expect(sent2.filter((s) => s.template === "whip-perm-mode-drift")).toHaveLength(0);
  });

  test("D4c defunct-cwd: pane_current_path missing → fires Discord ping", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
    });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: {
          "🐝alice": {
            paneCmd: "claude",
            state: "",
            pid: 1,
            cwd: "/tmp/this-path-does-not-exist-atmux-d4c-test",
          },
        },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    const defunct = sent.find((s) => s.template === "whip-defunct-cwd");
    expect(defunct).toBeDefined();
    const bullets = (defunct?.bullets ?? []) as string[];
    expect(bullets.some((b) => b.includes("alice") && b.includes("does not exist"))).toBe(true);
  });

  test("D4c defunct-cwd: existing path → no defunct ping", async () => {
    await seedTeam(atmuxDir, {
      name: "demo",
      members: [{ name: "alice", tui: "claude", emoji: "🐝" }],
    });
    const sent: DiscordSendOpts[] = [];
    await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: {
          "🐝alice": { paneCmd: "claude", state: "", pid: 1, cwd: atmuxDir },
        },
      }),
      discordSend: async (o) => {
        sent.push(o);
      },
    });
    expect(sent.find((s) => s.template === "whip-defunct-cwd")).toBeUndefined();
  });
});
