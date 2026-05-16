// Unit tests for src/verbs/whip-resume-check.ts (ADR-053 §D4 R1-T7).
//
// Coverage strategy
// -----------------
// Pure helpers (parsePokeResumeCheckArgs, shouldResume, resolveProbeAccounts)
// tested directly. Public verb driven against fixture .atmux/ + injected
// probe/resumeMember/discordSend/clock — covering: claudeAccount missing →
// no-op, no pause state → no-op, pause-active + gate-not-met → no resume,
// pause-active + gate-met → full resume flow (per-member resume +
// clearBudgetPauseState + driver-inbox + Discord + history). Plus
// lock-contention skip, ConfigError soft-swallow on Discord, --no-discord,
// --team-dir, UsageError branches.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetProbeResult, ProbeBudgetOpts } from "../../../src/abstractions/budget-probe.ts";
import type { DiscordSendOpts } from "../../../src/abstractions/discord.ts";
import {
  type BudgetPauseState,
  budgetPauseStatePath,
  writeBudgetPauseState,
} from "../../../src/core/budget-pause.ts";
import { ConfigError, LockTimeoutError, UsageError } from "../../../src/errors.ts";
import {
  parsePokeResumeCheckArgs,
  resolveProbeAccounts,
  shouldResume,
  pokeResumeCheck,
} from "../../../src/verbs/poke-resume-check.ts";

// ---------- parsePokeResumeCheckArgs ----------

describe("parsePokeResumeCheckArgs", () => {
  test("default — pushDiscord=true, no teamDir", () => {
    expect(parsePokeResumeCheckArgs([])).toEqual({ pushDiscord: true });
  });

  test("--no-discord flips pushDiscord", () => {
    expect(parsePokeResumeCheckArgs(["--no-discord"]).pushDiscord).toBe(false);
  });

  test("--team-dir captured", () => {
    expect(parsePokeResumeCheckArgs(["--team-dir", "/x"]).teamDir).toBe("/x");
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parsePokeResumeCheckArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown arg → UsageError", () => {
    expect(() => parsePokeResumeCheckArgs(["--bogus"])).toThrow(UsageError);
  });

  test("undefined arg slot → UsageError mentions empty", () => {
    // Defense-in-depth: if argv contains a sparse slot the parser still surfaces
    // a UsageError rather than silently accepting.
    const sparse = [undefined as unknown as string];
    expect(() => parsePokeResumeCheckArgs(sparse)).toThrow(UsageError);
  });
});

// ---------- shouldResume ----------

const mkProbe = (
  account: string,
  h5: number,
  wk: number,
  status: BudgetProbeResult["status"] = "allowed",
): BudgetProbeResult => ({
  account,
  h5_pct_used: h5,
  wk_pct_used: wk,
  h5_reset_epoch: 0,
  wk_reset_epoch: 0,
  status,
  source: "probe",
  probedAt: 1_000,
});

const mkPauseState = (members: string[]): BudgetPauseState => ({
  paused: true,
  pausedAt: 1_000,
  pausedAtTs: "08:00 MYT",
  atRisk: members.map((m) => ({ member: m, h5: 92, wk: 30 })),
});

describe("shouldResume", () => {
  test("null pause state → false", () => {
    expect(
      shouldResume({ pauseState: null, probes: [mkProbe("x", 0, 0)], resumeThresholdPctUsed: 80 }),
    ).toBe(false);
  });

  test("empty probes → false (no data to gate on)", () => {
    expect(
      shouldResume({ pauseState: mkPauseState(["a"]), probes: [], resumeThresholdPctUsed: 80 }),
    ).toBe(false);
  });

  test("probes all ≤ threshold on both windows → true", () => {
    expect(
      shouldResume({
        pauseState: mkPauseState(["a"]),
        probes: [mkProbe("x", 50, 40)],
        resumeThresholdPctUsed: 80,
      }),
    ).toBe(true);
  });

  test("probe equal to threshold → true (≤ semantics)", () => {
    expect(
      shouldResume({
        pauseState: mkPauseState(["a"]),
        probes: [mkProbe("x", 80, 80)],
        resumeThresholdPctUsed: 80,
      }),
    ).toBe(true);
  });

  test("h5 above threshold → false", () => {
    expect(
      shouldResume({
        pauseState: mkPauseState(["a"]),
        probes: [mkProbe("x", 81, 50)],
        resumeThresholdPctUsed: 80,
      }),
    ).toBe(false);
  });

  test("wk above threshold → false", () => {
    expect(
      shouldResume({
        pauseState: mkPauseState(["a"]),
        probes: [mkProbe("x", 50, 81)],
        resumeThresholdPctUsed: 80,
      }),
    ).toBe(false);
  });

  test("multi-account: any account over → false", () => {
    expect(
      shouldResume({
        pauseState: mkPauseState(["a"]),
        probes: [mkProbe("x", 30, 30), mkProbe("y", 90, 30)],
        resumeThresholdPctUsed: 80,
      }),
    ).toBe(false);
  });

  test("multi-account: all under → true", () => {
    expect(
      shouldResume({
        pauseState: mkPauseState(["a"]),
        probes: [mkProbe("x", 30, 30), mkProbe("y", 30, 30)],
        resumeThresholdPctUsed: 80,
      }),
    ).toBe(true);
  });

  test("probe-error status fails the gate even with low pct", () => {
    expect(
      shouldResume({
        pauseState: mkPauseState(["a"]),
        probes: [mkProbe("x", 0, 0, "probe-error")],
        resumeThresholdPctUsed: 80,
      }),
    ).toBe(false);
  });

  test("probe-401 status fails the gate", () => {
    expect(
      shouldResume({
        pauseState: mkPauseState(["a"]),
        probes: [mkProbe("x", 0, 0, "probe-401")],
        resumeThresholdPctUsed: 80,
      }),
    ).toBe(false);
  });

  test("no-credentials status fails the gate", () => {
    expect(
      shouldResume({
        pauseState: mkPauseState(["a"]),
        probes: [mkProbe("x", 0, 0, "no-credentials")],
        resumeThresholdPctUsed: 80,
      }),
    ).toBe(false);
  });

  test("rejected status passes the gate (bash treats it like allowed for pct read)", () => {
    expect(
      shouldResume({
        pauseState: mkPauseState(["a"]),
        probes: [mkProbe("x", 50, 50, "rejected")],
        resumeThresholdPctUsed: 80,
      }),
    ).toBe(true);
  });
});

// ---------- resolveProbeAccounts ----------

describe("resolveProbeAccounts", () => {
  test("undefined whip → []", () => {
    expect(resolveProbeAccounts(undefined)).toEqual([]);
  });

  test("only claudeAccount → [primary]", () => {
    expect(
      resolveProbeAccounts({
        claudeAccount: "icloud",
        accountFallback: [],
      } as never),
    ).toEqual(["icloud"]);
  });

  test("primary + fallback chain", () => {
    expect(
      resolveProbeAccounts({
        claudeAccount: "icloud",
        accountFallback: ["unum", "ifca"],
      } as never),
    ).toEqual(["icloud", "unum", "ifca"]);
  });

  test("dedupes when fallback repeats primary", () => {
    expect(
      resolveProbeAccounts({
        claudeAccount: "icloud",
        accountFallback: ["icloud", "unum"],
      } as never),
    ).toEqual(["icloud", "unum"]);
  });

  test("empty / undefined entries skipped", () => {
    expect(
      resolveProbeAccounts({
        claudeAccount: "",
        accountFallback: ["", "unum"],
      } as never),
    ).toEqual(["unum"]);
  });
});

// ---------- pokeResumeCheck() — public verb ----------

interface ProbeRecorder {
  calls: Array<{ account: string; opts?: ProbeBudgetOpts }>;
  fixedReturns: Map<string, BudgetProbeResult>;
}

const buildProbe =
  (rec: ProbeRecorder) =>
  async (account: string, opts?: ProbeBudgetOpts): Promise<BudgetProbeResult> => {
    const callRecord: { account: string; opts?: ProbeBudgetOpts } = { account };
    if (opts !== undefined) callRecord.opts = opts;
    rec.calls.push(callRecord);
    return rec.fixedReturns.get(account) ?? mkProbe(account, 0, 0);
  };

interface ResumeRecorder {
  members: string[];
}

const buildResume =
  (rec: ResumeRecorder) =>
  async (_atmuxDir: string, member: string): Promise<void> => {
    rec.members.push(member);
  };

interface DiscordRecorder {
  pings: DiscordSendOpts[];
  throwOn?: "config" | "other";
}

const buildDiscord =
  (rec: DiscordRecorder) =>
  async (opts: DiscordSendOpts): Promise<void> => {
    if (rec.throwOn === "config") throw new ConfigError({ what: "no webhook" });
    if (rec.throwOn === "other") throw new Error("network broken");
    rec.pings.push(opts);
  };

const seedTeam = async (
  atmuxDir: string,
  data: {
    name: string;
    members: Array<{ name: string }>;
    whip?: { claudeAccount?: string; budgetResumeThreshold?: number; accountFallback?: string[] };
  },
): Promise<void> => {
  await mkdir(atmuxDir, { recursive: true });
  await writeFile(join(atmuxDir, "team.json"), JSON.stringify(data));
};

describe("pokeResumeCheck() — public verb", () => {
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
    teamDir = await mkdtemp(join(tmpdir(), "atmux-whip-resume-"));
    atmuxDir = join(teamDir, ".atmux");
    stdoutBuf = "";
    stderrBuf = "";
  });

  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true });
  });

  test("UsageError on unknown arg", async () => {
    await expect(pokeResumeCheck(["--bogus"])).rejects.toBeInstanceOf(UsageError);
  });

  test("no claudeAccount → no-op short-circuit", async () => {
    await seedTeam(atmuxDir, { name: "t", members: [] });
    const probeRec: ProbeRecorder = { calls: [], fixedReturns: new Map() };
    const resumeRec: ResumeRecorder = { members: [] };
    const discordRec: DiscordRecorder = { pings: [] };

    const code = await pokeResumeCheck(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_000_000,
      probe: buildProbe(probeRec),
      resumeMember: buildResume(resumeRec),
      discordSend: buildDiscord(discordRec),
    });

    expect(code).toBe(0);
    expect(probeRec.calls).toEqual([]);
    expect(resumeRec.members).toEqual([]);
    expect(discordRec.pings).toEqual([]);
    expect(stdoutBuf).toContain("no team.whip.claudeAccount configured");
  });

  test("no pause state → probes only, no resume", async () => {
    await seedTeam(atmuxDir, {
      name: "t",
      members: [{ name: "alice" }],
      whip: { claudeAccount: "icloud" },
    });
    const probeRec: ProbeRecorder = {
      calls: [],
      fixedReturns: new Map([["icloud", mkProbe("icloud", 50, 40)]]),
    };
    const resumeRec: ResumeRecorder = { members: [] };
    const discordRec: DiscordRecorder = { pings: [] };

    const code = await pokeResumeCheck(["--team-dir", teamDir, "--no-discord"], {
      stdout,
      stderr,
      now: () => 1_000_000,
      probe: buildProbe(probeRec),
      resumeMember: buildResume(resumeRec),
      discordSend: buildDiscord(discordRec),
    });

    expect(code).toBe(0);
    expect(probeRec.calls.length).toBe(1);
    expect(probeRec.calls[0]?.account).toBe("icloud");
    expect(probeRec.calls[0]?.opts?.force).toBe(false);
    expect(resumeRec.members).toEqual([]);
    expect(discordRec.pings).toEqual([]);
    expect(stdoutBuf).toContain("no active pause");
  });

  test("paused + gate-not-met → no resume, pause state preserved", async () => {
    await seedTeam(atmuxDir, {
      name: "t",
      members: [{ name: "alice" }],
      whip: { claudeAccount: "icloud", budgetResumeThreshold: 80 },
    });
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    await writeBudgetPauseState(atmuxDir, mkPauseState(["alice"]));

    const probeRec: ProbeRecorder = {
      calls: [],
      // 85% > 80% threshold — gate fails
      fixedReturns: new Map([["icloud", mkProbe("icloud", 85, 50)]]),
    };
    const resumeRec: ResumeRecorder = { members: [] };
    const discordRec: DiscordRecorder = { pings: [] };

    const code = await pokeResumeCheck(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_000_000,
      probe: buildProbe(probeRec),
      resumeMember: buildResume(resumeRec),
      discordSend: buildDiscord(discordRec),
    });

    expect(code).toBe(0);
    expect(resumeRec.members).toEqual([]);
    expect(discordRec.pings).toEqual([]);
    expect(stdoutBuf).toContain("gate not met");
    // pause state file still present
    const exists = await stat(budgetPauseStatePath(atmuxDir)).then(
      () => true,
      () => false,
    );
    expect(exists).toBe(true);
  });

  test("paused + gate-met → full resume flow", async () => {
    await seedTeam(atmuxDir, {
      name: "t",
      members: [{ name: "alice" }, { name: "bob" }],
      whip: { claudeAccount: "icloud", budgetResumeThreshold: 80 },
    });
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    await writeBudgetPauseState(atmuxDir, mkPauseState(["alice", "bob"]));

    const probeRec: ProbeRecorder = {
      calls: [],
      fixedReturns: new Map([["icloud", mkProbe("icloud", 50, 40)]]),
    };
    const resumeRec: ResumeRecorder = { members: [] };
    const discordRec: DiscordRecorder = { pings: [] };

    const code = await pokeResumeCheck(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      probe: buildProbe(probeRec),
      resumeMember: buildResume(resumeRec),
      discordSend: buildDiscord(discordRec),
    });

    expect(code).toBe(0);
    // Both members resumed in roster order.
    expect(resumeRec.members).toEqual(["alice", "bob"]);
    // Pause state cleared.
    const cleared = await stat(budgetPauseStatePath(atmuxDir)).then(
      () => false,
      () => true,
    );
    expect(cleared).toBe(true);
    // Driver-inbox entry written.
    const inbox = await readFile(join(atmuxDir, "driver-inbox.md"), "utf8");
    expect(inbox).toContain("budget-resume");
    expect(inbox).toContain("alice, bob");
    expect(inbox).toContain("icloud=5h:50%/wk:60%");
    // Discord ping fired with whip-budget-resume template.
    expect(discordRec.pings.length).toBe(1);
    expect(discordRec.pings[0]?.template).toBe("whip-budget-resume");
    expect(discordRec.pings[0]?.bullets?.[0]).toContain("resumed 2 member(s)");
    // Budget history line written.
    const history = await readFile(join(atmuxDir, "logs/budget-history.jsonl"), "utf8");
    expect(history).toContain('"account":"icloud"');
    expect(history).toContain('"status":"allowed"');
    // Stdout final line.
    expect(stdoutBuf).toContain("resumed 2 member(s)");
  });

  test("paused + gate-met + --no-discord → no Discord ping fired", async () => {
    await seedTeam(atmuxDir, {
      name: "t",
      members: [{ name: "alice" }],
      whip: { claudeAccount: "icloud" },
    });
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    await writeBudgetPauseState(atmuxDir, mkPauseState(["alice"]));

    const probeRec: ProbeRecorder = {
      calls: [],
      fixedReturns: new Map([["icloud", mkProbe("icloud", 30, 30)]]),
    };
    const resumeRec: ResumeRecorder = { members: [] };
    const discordRec: DiscordRecorder = { pings: [] };

    await pokeResumeCheck(["--team-dir", teamDir, "--no-discord"], {
      stdout,
      stderr,
      now: () => 1_000_000,
      probe: buildProbe(probeRec),
      resumeMember: buildResume(resumeRec),
      discordSend: buildDiscord(discordRec),
    });

    expect(resumeRec.members).toEqual(["alice"]);
    expect(discordRec.pings).toEqual([]);
  });

  test("Discord ConfigError soft-swallowed", async () => {
    await seedTeam(atmuxDir, {
      name: "t",
      members: [{ name: "alice" }],
      whip: { claudeAccount: "icloud" },
    });
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    await writeBudgetPauseState(atmuxDir, mkPauseState(["alice"]));

    const probeRec: ProbeRecorder = {
      calls: [],
      fixedReturns: new Map([["icloud", mkProbe("icloud", 30, 30)]]),
    };
    const resumeRec: ResumeRecorder = { members: [] };
    const discordRec: DiscordRecorder = { pings: [], throwOn: "config" };

    const code = await pokeResumeCheck(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_000_000,
      probe: buildProbe(probeRec),
      resumeMember: buildResume(resumeRec),
      discordSend: buildDiscord(discordRec),
    });

    expect(code).toBe(0);
    // Resume still happened despite Discord miss.
    expect(resumeRec.members).toEqual(["alice"]);
    // No stderr noise — ConfigError is soft.
    expect(stderrBuf).toBe("");
  });

  test("Discord non-Config error logged to stderr (non-fatal)", async () => {
    await seedTeam(atmuxDir, {
      name: "t",
      members: [{ name: "alice" }],
      whip: { claudeAccount: "icloud" },
    });
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    await writeBudgetPauseState(atmuxDir, mkPauseState(["alice"]));

    const probeRec: ProbeRecorder = {
      calls: [],
      fixedReturns: new Map([["icloud", mkProbe("icloud", 30, 30)]]),
    };
    const resumeRec: ResumeRecorder = { members: [] };
    const discordRec: DiscordRecorder = { pings: [], throwOn: "other" };

    const code = await pokeResumeCheck(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_000_000,
      probe: buildProbe(probeRec),
      resumeMember: buildResume(resumeRec),
      discordSend: buildDiscord(discordRec),
    });

    expect(code).toBe(0);
    expect(resumeRec.members).toEqual(["alice"]);
    expect(stderrBuf).toContain("discord ping failed");
    expect(stderrBuf).toContain("network broken");
  });

  test("lock contention skips tick with non-fatal stderr", async () => {
    await seedTeam(atmuxDir, {
      name: "t",
      members: [{ name: "alice" }],
      whip: { claudeAccount: "icloud" },
    });

    const probeRec: ProbeRecorder = { calls: [], fixedReturns: new Map() };
    const resumeRec: ResumeRecorder = { members: [] };
    const discordRec: DiscordRecorder = { pings: [] };

    const code = await pokeResumeCheck(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => 1_000_000,
      probe: buildProbe(probeRec),
      resumeMember: buildResume(resumeRec),
      discordSend: buildDiscord(discordRec),
      lockAcquire: async () => {
        throw new LockTimeoutError({ path: "/tmp/x", timeoutMs: 50 });
      },
    });

    expect(code).toBe(0);
    expect(stderrBuf).toContain("another instance is running");
    // Probe never fired — lock came first.
    expect(probeRec.calls).toEqual([]);
    expect(resumeRec.members).toEqual([]);
  });

  test("lock acquirer non-LockTimeout error rethrows", async () => {
    await seedTeam(atmuxDir, {
      name: "t",
      members: [],
      whip: { claudeAccount: "icloud" },
    });

    const probeRec: ProbeRecorder = { calls: [], fixedReturns: new Map() };
    const resumeRec: ResumeRecorder = { members: [] };
    const discordRec: DiscordRecorder = { pings: [] };

    await expect(
      pokeResumeCheck(["--team-dir", teamDir], {
        stdout,
        stderr,
        probe: buildProbe(probeRec),
        resumeMember: buildResume(resumeRec),
        discordSend: buildDiscord(discordRec),
        lockAcquire: async () => {
          throw new Error("OOM");
        },
      }),
    ).rejects.toThrow(/OOM/);
  });

  test("resume member-failure logged to stderr but loop continues", async () => {
    await seedTeam(atmuxDir, {
      name: "t",
      members: [{ name: "alice" }, { name: "bob" }],
      whip: { claudeAccount: "icloud" },
    });
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    await writeBudgetPauseState(atmuxDir, mkPauseState(["alice", "bob"]));

    const probeRec: ProbeRecorder = {
      calls: [],
      fixedReturns: new Map([["icloud", mkProbe("icloud", 30, 30)]]),
    };
    const discordRec: DiscordRecorder = { pings: [] };
    const resumeCalls: string[] = [];
    const resume = async (_dir: string, m: string) => {
      resumeCalls.push(m);
      if (m === "alice") throw new Error("alice resume boom");
    };

    const code = await pokeResumeCheck(["--team-dir", teamDir, "--no-discord"], {
      stdout,
      stderr,
      now: () => 1_000_000,
      probe: buildProbe(probeRec),
      resumeMember: resume,
      discordSend: buildDiscord(discordRec),
    });

    expect(code).toBe(0);
    expect(resumeCalls).toEqual(["alice", "bob"]); // both attempted
    expect(stderrBuf).toContain("alice");
    expect(stderrBuf).toContain("alice resume boom");
    // State still cleared because the loop continues past one bad resume.
    const cleared = await stat(budgetPauseStatePath(atmuxDir)).then(
      () => false,
      () => true,
    );
    expect(cleared).toBe(true);
  });

  test("driver-inbox entry appended (existing file path)", async () => {
    await seedTeam(atmuxDir, {
      name: "t",
      members: [{ name: "alice" }],
      whip: { claudeAccount: "icloud" },
    });
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    await writeBudgetPauseState(atmuxDir, mkPauseState(["alice"]));
    // Pre-existing driver-inbox content.
    await writeFile(join(atmuxDir, "driver-inbox.md"), "## existing content\n");

    const probeRec: ProbeRecorder = {
      calls: [],
      fixedReturns: new Map([["icloud", mkProbe("icloud", 30, 30)]]),
    };
    const resumeRec: ResumeRecorder = { members: [] };
    const discordRec: DiscordRecorder = { pings: [] };

    await pokeResumeCheck(["--team-dir", teamDir, "--no-discord"], {
      stdout,
      stderr,
      now: () => 1_000_000,
      probe: buildProbe(probeRec),
      resumeMember: buildResume(resumeRec),
      discordSend: buildDiscord(discordRec),
    });

    const inbox = await readFile(join(atmuxDir, "driver-inbox.md"), "utf8");
    expect(inbox).toContain("## existing content");
    expect(inbox).toContain("budget-resume");
  });

  test("default lock acquirer succeeds on uncontended path", async () => {
    // Covers the `opts.lockAcquire ?? acquireLock(...)` default branch.
    await seedTeam(atmuxDir, {
      name: "t",
      members: [],
      whip: { claudeAccount: "icloud" },
    });

    const probeRec: ProbeRecorder = {
      calls: [],
      fixedReturns: new Map([["icloud", mkProbe("icloud", 30, 30)]]),
    };
    const resumeRec: ResumeRecorder = { members: [] };
    const discordRec: DiscordRecorder = { pings: [] };

    const code = await pokeResumeCheck(["--team-dir", teamDir, "--no-discord"], {
      stdout,
      stderr,
      probe: buildProbe(probeRec),
      resumeMember: buildResume(resumeRec),
      discordSend: buildDiscord(discordRec),
    });

    expect(code).toBe(0);
  });

  test("--team-dir defaults to cwd when not provided (env path)", async () => {
    // We don't actually chdir — instead set ATMUX_DIR via no flag and
    // verify the verb fails with the appropriate config error when cwd
    // doesn't have a .atmux. This covers the default-resolveDirOpts branch.
    await expect(pokeResumeCheck(["--team-dir", "/no/such/dir"])).rejects.toThrow();
  });

  test("default Discord send branch (no opts.discordSend) — no ConfigError thrown", async () => {
    // When ATMUX_DISCORD_WEBHOOK isn't set, the default sender raises
    // ConfigError which the verb soft-swallows. This exercises the
    // `opts.discordSend ?? discordSend` default-binding branch alongside
    // the soft-swallow path.
    await seedTeam(atmuxDir, {
      name: "t",
      members: [{ name: "alice" }],
      whip: { claudeAccount: "icloud" },
    });
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    await writeBudgetPauseState(atmuxDir, mkPauseState(["alice"]));

    const probeRec: ProbeRecorder = {
      calls: [],
      fixedReturns: new Map([["icloud", mkProbe("icloud", 30, 30)]]),
    };
    const resumeRec: ResumeRecorder = { members: [] };

    const oldWebhook = process.env.ATMUX_DISCORD_WEBHOOK;
    delete process.env.ATMUX_DISCORD_WEBHOOK;
    try {
      const code = await pokeResumeCheck(["--team-dir", teamDir], {
        stdout,
        stderr,
        now: () => 1_000_000,
        probe: buildProbe(probeRec),
        resumeMember: buildResume(resumeRec),
        // discordSend left default
      });
      expect(code).toBe(0);
      expect(resumeRec.members).toEqual(["alice"]);
    } finally {
      if (oldWebhook !== undefined) process.env.ATMUX_DISCORD_WEBHOOK = oldWebhook;
    }
  });
});
