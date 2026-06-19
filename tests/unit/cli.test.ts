// Unit tests for src/cli.ts (ADR-010 + ADR-006 top-level catch).
//
// `src/cli.ts` is in the tracked coverage denominator per architect's
// review-verdict refinement (commit `64898c7`) and the bunfig.toml
// comment ratifies it: cli.ts dispatch logic IS unit-testable
// (alias routing, unknown-verb exit code, reportError tag → exit
// mapping) and SHOULD be tracked, not excluded. 100% required.
//
// ADR-263 (the great simplification) cut the fleet-coordination verbs
// from the dispatcher. The dispatch keep-set this file covers is exactly
// the lean spine (ADR-263 §D2): version · help · init · start · stop ·
// status · attach · send · broadcast · task · claim · done · sync ·
// cleanup · reconfigure · doctor · up. Cut verbs (add-member, dispatch,
// tell-lead, reply/outbox, inbox, pause/resume, team/member sub-verbs,
// dashboard, rotate/rotate-lead, handoff, report, cost, whip, orchd/
// relayd) no longer have a `case` in the switch — they now fall through
// to the unknown-verb path. Their old dispatch tests were DELETED (a
// test that drives a removed verb into the unknown-verb fallback while
// claiming to exercise that verb is a lie per CLAUDE.md).
//
// Coverage map for the dispatcher + reportError:
//   - "version" / "--version" / "-V" → exit 0 (bash parity, all 3 forms)
//   - unknown verb → exit 64 + "atmux: unknown verb: <verb>" + 2-space
//     hint line. Byte-matches bash `bin/atmux:324-328`.
//   - empty argv → aliased to `up([])` (bin/atmux:91); see the up-verb
//     dispatch describe for that path's coverage
//   - reportError UsageError (no hint) — covers the no-hint branch
//   - reportError other AtmuxError → exitCodeForTag mapping (e.g.
//     FsError → 1, HttpTimeoutError → 75, ConfigError → 78)
//   - reportError AtmuxError + ATMUX_DEBUG=1 → cause chain on stderr
//   - reportError plain Error → exit 99 + stack
//   - reportError Error without `.stack` → falls back to `.message`
//   - reportError non-Error throw (e.g. string) → exit 99 + String(err)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { reportError } from "../../src/cli.ts";
import { ConfigError, FsError, HttpTimeoutError, UsageError } from "../../src/errors.ts";
import { ATMUX_VERSION } from "../../src/verbs/version.ts";
import { captureMain } from "../helpers/capture.ts";

/** Capture only stderr around a synchronous `reportError` call. */
function captureReport(err: unknown): { exit: number; stderr: string } {
  let stderrBuf = "";
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string | Uint8Array) => {
    stderrBuf += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = reportError(err);
    return { exit, stderr: stderrBuf };
  } finally {
    process.stderr.write = origStderrWrite;
  }
}

// ---------- Dispatch — happy paths (bash-parity aliases) ----------

describe("cli.main — version verb (3-form parity with bash)", () => {
  test(`'version' → exit 0, prints 'atmux ${ATMUX_VERSION}'`, async () => {
    const { exit, stdout, stderr } = await captureMain(["version"]);
    expect(exit).toBe(0);
    expect(stdout).toBe(`atmux ${ATMUX_VERSION}\n`);
    expect(stderr).toBe("");
  });

  test(`'--version' alias → exit 0, prints 'atmux ${ATMUX_VERSION}' (bash parity)`, async () => {
    const { exit, stdout, stderr } = await captureMain(["--version"]);
    expect(exit).toBe(0);
    expect(stdout).toBe(`atmux ${ATMUX_VERSION}\n`);
    expect(stderr).toBe("");
  });

  test(`'-V' alias → exit 0, prints 'atmux ${ATMUX_VERSION}' (bash parity)`, async () => {
    const { exit, stdout, stderr } = await captureMain(["-V"]);
    expect(exit).toBe(0);
    expect(stdout).toBe(`atmux ${ATMUX_VERSION}\n`);
    expect(stderr).toBe("");
  });
});

// ---------- Dispatch — help verb (3-form parity with bash) ----------

describe("cli.main — help verb (3-form parity with bash)", () => {
  test("'help' → exit 0, writes ADR-263 lean usage block to stdout", async () => {
    const { exit, stdout, stderr } = await captureMain(["help"]);
    expect(exit).toBe(0);
    // ADR-263 rewrote the USAGE header — atmux is now a tmux harness +
    // task feed, no longer "agent teams multiplexer". Assert the stable
    // new header line + the (unchanged) Docs footer rather than a
    // byte-exact block so cosmetic verb-line edits don't churn the test.
    expect(stdout).toContain("atmux — tmux agent harness + task feed");
    expect(stdout).toContain("Docs:  https://github.com/geoyws/atmux");
    expect(stderr).toBe("");
  });

  test("'--help' alias → exit 0, writes lean usage block (bash parity)", async () => {
    const { exit, stdout, stderr } = await captureMain(["--help"]);
    expect(exit).toBe(0);
    expect(stdout).toContain("atmux — tmux agent harness + task feed");
    expect(stderr).toBe("");
  });

  test("'-h' alias → exit 0, writes lean usage block (bash parity)", async () => {
    const { exit, stdout, stderr } = await captureMain(["-h"]);
    expect(exit).toBe(0);
    expect(stdout).toContain("atmux — tmux agent harness + task feed");
    expect(stderr).toBe("");
  });
});

// ---------- Dispatch — init verb route (smoke; deep behaviour is in
//                       tests/unit/verbs/init.test.ts) ----------

describe("cli.main — init verb dispatch", () => {
  test("'init --bogus-flag' dispatches into init (UsageError on unknown flag)", async () => {
    // Drive the dispatcher into the `case "init"` branch. parseInitArgs
    // throws UsageError on unknown flags — exit 64. Pins the dispatch
    // line; deep verb behaviour lives in tests/unit/verbs/init.test.ts.
    const { exit, stderr } = await captureMain(["init", "--bogus-flag"]);
    expect(exit).toBe(64);
    expect(stderr).toContain("atmux:");
  });
});

// ---------- Dispatch — send verb route (smoke; deep behaviour is in
//                       tests/unit/verbs/send.test.ts) ----------

describe("cli.main — send verb dispatch", () => {
  test("'send' with no args dispatches into send (UsageError)", async () => {
    // parseSendArgs throws UsageError when the member positional is
    // missing — exit 64. Pins the `case "send":` line; deep verb
    // behaviour lives in tests/unit/verbs/send.test.ts.
    const { exit, stderr } = await captureMain(["send"]);
    expect(exit).toBe(64);
    expect(stderr).toContain("atmux:");
  });
});

// ---------- Dispatch — task verb route (smoke; deep behaviour is in
//                       tests/unit/verbs/task.test.ts) ----------

describe("cli.main — task verb dispatch", () => {
  test("'task bogus' dispatches into task (UsageError on unknown subverb)", async () => {
    // task verb throws UsageError on unknown subverb — exit 64. Pins
    // the `case "task":` line; deep verb behaviour lives in
    // tests/unit/verbs/task.test.ts.
    const { exit, stderr } = await captureMain(["task", "bogus"]);
    expect(exit).toBe(64);
    expect(stderr).toContain("atmux:");
  });
});

// ---------- Dispatch — claim / done verb routes (smoke; deep behaviour
//                       in tests/unit/verbs/claim.test.ts) ----------

describe("cli.main — claim verb dispatch", () => {
  test("'claim' with no args dispatches into claim (UsageError)", async () => {
    const { exit, stderr } = await captureMain(["claim"]);
    expect(exit).toBe(64);
    expect(stderr).toContain("atmux:");
  });
});

describe("cli.main — done verb dispatch", () => {
  test("'done' with no args dispatches into done (UsageError)", async () => {
    const { exit, stderr } = await captureMain(["done"]);
    expect(exit).toBe(64);
    expect(stderr).toContain("atmux:");
  });
});

describe("cli.main — broadcast alias dispatch", () => {
  test("'broadcast' with no msg dispatches into send (UsageError)", async () => {
    const { exit, stderr } = await captureMain(["broadcast"]);
    expect(exit).toBe(64);
    expect(stderr).toContain("atmux:");
  });
});

describe("cli.main — status verb dispatch", () => {
  test("'status bogus' dispatches into status (UsageError)", async () => {
    const { exit, stderr } = await captureMain(["status", "bogus"]);
    expect(exit).toBe(64);
    expect(stderr).toContain("atmux:");
  });
});

describe("cli.main — stop verb dispatch", () => {
  test("'stop bogus' dispatches into stop (UsageError on unknown arg)", async () => {
    const { exit, stderr } = await captureMain(["stop", "bogus"]);
    expect(exit).toBe(64);
    expect(stderr).toContain("atmux:");
  });
});

// ---------- Dispatch — start verb route (smoke; deep behaviour is in
//                       tests/unit/verbs/start.test.ts) ----------

describe("cli.main — start verb dispatch", () => {
  test("'start' dispatches into the start verb (ConfigError when no team.json)", async () => {
    // Drive the dispatcher into the `case "start"` branch without
    // staging a real team. Pin ATMUX_DIR at a guaranteed-empty path so
    // getAtmuxDir doesn't walk up and find a real .atmux somewhere in
    // the worktree's parent tree. loadTeam then ConfigErrors on the
    // missing team.json (config tag → exit 78). This pins the dispatch
    // line; deep verb behaviour lives in tests/unit/verbs/start.test.ts.
    const SAVED_DIR = process.env.ATMUX_DIR;
    process.env.ATMUX_DIR = "/tmp/atmux-cli-test-nonexistent-dir";
    try {
      const { exit, stderr } = await captureMain(["start", "--no-doctor"]);
      expect(exit).toBe(78);
      expect(stderr).toContain("atmux: config:");
      expect(stderr).toContain("no team.json");
    } finally {
      if (SAVED_DIR === undefined) delete process.env.ATMUX_DIR;
      else process.env.ATMUX_DIR = SAVED_DIR;
    }
  });
});

// ---------- Dispatch — attach verb route (smoke; deep behaviour is in
//                       tests/unit/verbs/attach.test.ts) ----------

describe("cli.main — attach verb dispatch", () => {
  test("'attach' dispatches into the attach verb (ConfigError when no team.json)", async () => {
    // Same shape as the start dispatch test: pin ATMUX_DIR at a
    // guaranteed-empty path so loadTeam ConfigErrors on the missing
    // team.json (config tag → exit 78). Pins the `case "attach":` line
    // in cli.ts; deep verb behaviour (arg parsing, session-existence
    // check, TmuxError surfacing) lives in tests/unit/verbs/attach.test.ts.
    const SAVED_DIR = process.env.ATMUX_DIR;
    process.env.ATMUX_DIR = "/tmp/atmux-cli-attach-test-nonexistent-dir";
    try {
      const { exit, stderr } = await captureMain(["attach"]);
      expect(exit).toBe(78);
      expect(stderr).toContain("atmux: config:");
      expect(stderr).toContain("no team.json");
    } finally {
      if (SAVED_DIR === undefined) delete process.env.ATMUX_DIR;
      else process.env.ATMUX_DIR = SAVED_DIR;
    }
  });
});

// ---------- Dispatch — reconfigure verb route (smoke; deep behaviour is in
//                       tests/unit/verbs/reconfigure.test.ts) ----------

describe("cli.main — reconfigure verb dispatch", () => {
  test("'reconfigure --bogus-flag' dispatches into reconfigure (UsageError)", async () => {
    const { exit, stderr } = await captureMain(["reconfigure", "--bogus-flag"]);
    expect(exit).toBe(64);
    expect(stderr).toContain("atmux:");
  });
});

// ---------- Dispatch — doctor verb route (smoke; deep behaviour is in
//                       tests/unit/verbs/doctor.test.ts) ----------

describe("cli.main — doctor verb dispatch", () => {
  test("'doctor --bogus-flag' dispatches into doctor (UsageError)", async () => {
    const { exit, stderr } = await captureMain(["doctor", "--bogus-flag"]);
    expect(exit).toBe(64);
    expect(stderr).toContain("atmux:");
  });
});

// ---------- Dispatch — unknown verb (bash parity exit 64) ----------

describe("cli.main — unknown-verb path (bash bin/atmux:324-328 byte-parity)", () => {
  test("unknown verb 'bogus' → exit 64 + bash-format two-line stderr", async () => {
    const { exit, stdout, stderr } = await captureMain(["bogus"]);
    // Exit code: bash bats spec `tests/unit/cli.bats:42` asserts 64.
    expect(exit).toBe(64);
    // No stdout — entire output is on stderr.
    expect(stdout).toBe("");
    // Byte-match bash's two-line format.
    expect(stderr).toBe("atmux: unknown verb: bogus\n  run 'atmux help' for the list of verbs\n");
  });

  test("unknown verb 'fake' → exit 64 + verb name interpolated", async () => {
    const { exit, stderr } = await captureMain(["fake"]);
    expect(exit).toBe(64);
    expect(stderr).toContain("atmux: unknown verb: fake");
  });

  // Note: empty argv no longer hits the unknown-verb path — V-01 wired
  // `case "":` → `up([])` so `atmux` (bare) bring-up matches bash
  // `bin/atmux:91`. Coverage of the bare-argv → up alias lives in the
  // `cli.main — up verb dispatch` describe below.
});

// ---------- Dispatch — up verb route (V-01) + bare-argv alias ----------

describe("cli.main — up verb dispatch (V-01)", () => {
  let priorAtmuxDir: string | undefined;
  let priorAtmuxNoWizard: string | undefined;
  let priorTmux: string | undefined;

  beforeEach(() => {
    priorAtmuxDir = process.env.ATMUX_DIR;
    priorAtmuxNoWizard = process.env.ATMUX_NO_WIZARD;
    priorTmux = process.env.TMUX;
    // Point at a definitely-empty atmux dir so up's wizard-gate fires
    // deterministically; ATMUX_NO_WIZARD short-circuits to ConfigError
    // before any sub-verb runs.
    process.env.ATMUX_DIR = "/nonexistent/atmux-cli-test/.atmux";
    process.env.ATMUX_NO_WIZARD = "1";
    delete process.env.TMUX;
  });

  afterEach(() => {
    if (priorAtmuxDir === undefined) delete process.env.ATMUX_DIR;
    else process.env.ATMUX_DIR = priorAtmuxDir;
    if (priorAtmuxNoWizard === undefined) delete process.env.ATMUX_NO_WIZARD;
    else process.env.ATMUX_NO_WIZARD = priorAtmuxNoWizard;
    if (priorTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = priorTmux;
  });

  test("'up --bogus' → UsageError (exit 64) — parseUpArgs rejects argv", async () => {
    const { exit, stderr } = await captureMain(["up", "--bogus"]);
    expect(exit).toBe(64);
    expect(stderr).toContain("atmux:");
    expect(stderr).toContain("--bogus");
  });

  test("'up' (no args) → routed to up() → ConfigError exit 78 in no-team-json env", async () => {
    const { exit, stderr } = await captureMain(["up"]);
    expect(exit).toBe(78);
    expect(stderr).toContain("atmux: config:");
    expect(stderr).toContain("ATMUX_NO_WIZARD");
  });

  test("bare argv (empty) → aliased to up([]) per bin/atmux:91 → same path", async () => {
    const { exit, stderr } = await captureMain([]);
    expect(exit).toBe(78);
    expect(stderr).toContain("atmux: config:");
    expect(stderr).toContain("ATMUX_NO_WIZARD");
  });
});

// ---------- reportError — branch-direct coverage ----------

describe("reportError — UsageError variants", () => {
  test("UsageError without hint → exit 64, no second line", () => {
    const { exit, stderr } = captureReport(new UsageError({ what: "missing arg" }));
    expect(exit).toBe(64);
    expect(stderr).toBe("atmux: missing arg\n");
  });

  test("UsageError with hint → exit 64, hint on indented second line", () => {
    const { exit, stderr } = captureReport(
      new UsageError({ what: "bad flag", hint: "see 'atmux help'" }),
    );
    expect(exit).toBe(64);
    expect(stderr).toBe("atmux: bad flag\n  see 'atmux help'\n");
  });
});

describe("reportError — non-Usage AtmuxError → exitCodeForTag", () => {
  // Restore ATMUX_DEBUG between tests so the debug-on test doesn't leak.
  const SAVED_DEBUG = process.env.ATMUX_DEBUG;
  beforeEach(() => {
    delete process.env.ATMUX_DEBUG;
  });
  afterEach(() => {
    if (SAVED_DEBUG === undefined) delete process.env.ATMUX_DEBUG;
    else process.env.ATMUX_DEBUG = SAVED_DEBUG;
  });

  test("FsError → exit 1 (default tag mapping)", () => {
    const err = new FsError({ path: "/nope", op: "read", cause: new Error("ENOENT") });
    const { exit, stderr } = captureReport(err);
    expect(exit).toBe(1);
    expect(stderr).toContain("atmux: fs:");
    expect(stderr).toContain("fs read failed on /nope");
  });

  test("HttpTimeoutError → exit 75 (EX_TEMPFAIL)", () => {
    const err = new HttpTimeoutError({
      url: "https://x/y",
      method: "GET",
      timeoutMs: 5000,
    });
    const { exit, stderr } = captureReport(err);
    expect(exit).toBe(75);
    expect(stderr).toContain("atmux: http-timeout:");
  });

  test("ConfigError → exit 78 (EX_CONFIG)", () => {
    const err = new ConfigError({ what: "no team.json", hint: "run atmux init" });
    const { exit, stderr } = captureReport(err);
    expect(exit).toBe(78);
    expect(stderr).toContain("atmux: config:");
  });

  test("ATMUX_DEBUG=1 appends cause chain to stderr", () => {
    process.env.ATMUX_DEBUG = "1";
    const root = new Error("ENOENT: no such file");
    const err = new FsError({ path: "/x", op: "read", cause: root });
    const { exit, stderr } = captureReport(err);
    expect(exit).toBe(1);
    expect(stderr).toContain("atmux: fs:");
    // formatErrorChain output includes the cause's message.
    expect(stderr).toContain("ENOENT: no such file");
  });

  test("ATMUX_DEBUG empty-string is treated as unset (no chain)", () => {
    process.env.ATMUX_DEBUG = "";
    const err = new FsError({ path: "/x", op: "read", cause: new Error("ENOENT") });
    const { exit, stderr } = captureReport(err);
    expect(exit).toBe(1);
    // No chain — only the single header line.
    expect(stderr).toBe("atmux: fs: fs read failed on /x\n");
  });
});

describe("reportError — non-Atmux failures → exit 99", () => {
  test("plain Error with stack → 'atmux: internal error' + stack", () => {
    const e = new Error("kaboom");
    const { exit, stderr } = captureReport(e);
    expect(exit).toBe(99);
    expect(stderr).toContain("atmux: internal error");
    // Stack trace includes the error name + message.
    expect(stderr).toContain("Error: kaboom");
  });

  test("Error without stack falls back to message", () => {
    const e = new Error("no-stack-here");
    // Force `.stack` to undefined (defensive fallback path).
    Object.defineProperty(e, "stack", { value: undefined, configurable: true });
    const { exit, stderr } = captureReport(e);
    expect(exit).toBe(99);
    expect(stderr).toContain("atmux: internal error");
    expect(stderr).toContain("no-stack-here");
  });

  test("non-Error throw (string) → exit 99 + String(err)", () => {
    const { exit, stderr } = captureReport("raw-string-thrown");
    expect(exit).toBe(99);
    expect(stderr).toContain("atmux: internal error");
    expect(stderr).toContain("raw-string-thrown");
  });
});

// ---------- bin/atmux-bun shim integration ----------

describe("cli — bin/atmux-bun entrypoint integration", () => {
  // CLAUDE.md "verify green from the right path" — the bin shim is what
  // cron / users invoke. Testing only the library would miss shim-level
  // regressions (wrong argv slicing, exit-code dropping at process.exit).
  const REPO_ROOT = import.meta.dir.replace(/\/tests\/unit$/, "");

  test(`\`bin/atmux-bun version\` exits 0 + prints 'atmux ${ATMUX_VERSION}'`, async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "bin/atmux-bun", "version"],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exit).toBe(0);
    expect(stdout).toBe(`atmux ${ATMUX_VERSION}\n`);
    expect(stderr).toBe("");
  });

  test("`bin/atmux-bun bogus` exits 64 + prints bash-format unknown-verb stderr", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "bin/atmux-bun", "bogus"],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exit).toBe(64);
    expect(stdout).toBe("");
    expect(stderr).toBe("atmux: unknown verb: bogus\n  run 'atmux help' for the list of verbs\n");
  });
});

// ---------- logVerbEvent — events-log envelope (t-91cd050f) ----------
//
// Direct coverage for the helper exported from cli.ts. The smoke tests
// above exercise the happy path indirectly; these pin the edge branches:
//   - skip on `--version` / `-V` / `--help` / `-h` (zero-noise aliases)
//   - skip when atmuxDir does not exist (no team yet, first-run case)
//   - happy path when team.json exists → event lands in
//     <atmuxDir>/logs/<YYYY>/<MM>/events.jsonl with the right shape
//   - team.json absent → event lands with team="" (schema-tolerant)

describe("logVerbEvent — events-log envelope", () => {
  let workDir: string;
  let atmuxDir: string;
  let savedEnvDir: string | undefined;
  let savedTeamDir: string | undefined;

  beforeEach(async () => {
    const { mkdtemp, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    workDir = await mkdtemp(join(tmpdir(), "atmux-cli-eventslog-"));
    atmuxDir = join(workDir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    savedEnvDir = process.env.ATMUX_DIR;
    savedTeamDir = process.env.ATMUX_TEAM_DIR;
    process.env.ATMUX_DIR = atmuxDir;
    delete process.env.ATMUX_TEAM_DIR;
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(workDir, { recursive: true, force: true });
    if (savedEnvDir === undefined) delete process.env.ATMUX_DIR;
    else process.env.ATMUX_DIR = savedEnvDir;
    if (savedTeamDir === undefined) delete process.env.ATMUX_TEAM_DIR;
    else process.env.ATMUX_TEAM_DIR = savedTeamDir;
  });

  test.each([
    ["--version"],
    ["-V"],
    ["--help"],
    ["-h"],
  ])("skips event-log entirely for `%s` alias", async (verb) => {
    const { logVerbEvent } = await import("../../src/cli.ts");
    await logVerbEvent({
      verb,
      args: [],
      startMs: Date.now() - 5,
      exit: 0,
      outcome: "ok",
    });
    // No events.jsonl created anywhere under <atmuxDir>/logs/
    const { readdir } = await import("node:fs/promises");
    const logsExists = await readdir(atmuxDir).then(
      (d) => d.includes("logs"),
      () => false,
    );
    expect(logsExists).toBe(false);
  });

  test("skips when atmuxDir does not exist (first-run, no team)", async () => {
    // Point ATMUX_DIR at a path that does NOT exist on disk.
    const { join } = await import("node:path");
    process.env.ATMUX_DIR = join(workDir, "no-such-dir");
    const { logVerbEvent } = await import("../../src/cli.ts");
    await logVerbEvent({
      verb: "status",
      args: [],
      startMs: Date.now() - 5,
      exit: 0,
      outcome: "ok",
    });
    // No files created at the bogus path.
    const { existsSync } = await import("node:fs");
    expect(existsSync(process.env.ATMUX_DIR ?? "")).toBe(false);
  });

  test("happy path — writes event with team name from team.json", async () => {
    const { writeFile, readFile, readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: "acme", members: [] }));
    const { logVerbEvent } = await import("../../src/cli.ts");
    // Use a kept verb (claim) for the envelope example — ADR-263 cut the
    // old `dispatch` verb. The envelope round-trip is verb-agnostic; this
    // just keeps the sample shape coherent with the lean surface.
    await logVerbEvent({
      verb: "claim",
      args: ["t-123", "--as", "alpha"],
      startMs: Date.now() - 25,
      exit: 0,
      outcome: "ok",
    });
    // Find the monthly events.jsonl file under logs/<YYYY>/<MM>/.
    const logsRoot = join(atmuxDir, "logs");
    const years = await readdir(logsRoot);
    expect(years.length).toBe(1);
    const year = years[0] ?? "";
    const months = await readdir(join(logsRoot, year));
    expect(months.length).toBe(1);
    const eventsPath = join(logsRoot, year, months[0] ?? "", "events.jsonl");
    const body = await readFile(eventsPath, "utf8");
    const parsed = JSON.parse(body.trim());
    expect(parsed.verb).toBe("claim");
    expect(parsed.args).toEqual(["t-123", "--as", "alpha"]);
    expect(parsed.outcome).toBe("ok");
    expect(parsed.exit).toBe(0);
    expect(parsed.team).toBe("acme");
    expect(typeof parsed.ts).toBe("number");
    expect(typeof parsed.duration_ms).toBe("number");
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("team.json absent → event still logs with team=''", async () => {
    // atmuxDir exists (beforeEach mkdir) but no team.json inside it.
    const { logVerbEvent } = await import("../../src/cli.ts");
    await logVerbEvent({
      verb: "init",
      args: ["--name", "alpha"],
      startMs: Date.now() - 5,
      exit: 0,
      outcome: "ok",
    });
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const logsRoot = join(atmuxDir, "logs");
    const years = await readdir(logsRoot);
    const year = years[0] ?? "";
    const months = await readdir(join(logsRoot, year));
    const body = await readFile(join(logsRoot, year, months[0] ?? "", "events.jsonl"), "utf8");
    const parsed = JSON.parse(body.trim());
    expect(parsed.team).toBe("");
    expect(parsed.verb).toBe("init");
  });

  test("malformed team.json → event still logs with team='' (catch path)", async () => {
    const { writeFile, readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    // team.json present but unparseable as Team schema — tryLoadTeam
    // throws SchemaError; the helper's catch branch handles it + falls
    // through with team="" rather than blowing up the events log.
    await writeFile(join(atmuxDir, "team.json"), "{ broken json [");
    const { logVerbEvent } = await import("../../src/cli.ts");
    await logVerbEvent({
      verb: "doctor",
      args: [],
      startMs: Date.now() - 1,
      exit: 0,
      outcome: "ok",
    });
    const logsRoot = join(atmuxDir, "logs");
    const years = await readdir(logsRoot);
    const year = years[0] ?? "";
    const months = await readdir(join(logsRoot, year));
    const body = await readFile(join(logsRoot, year, months[0] ?? "", "events.jsonl"), "utf8");
    const parsed = JSON.parse(body.trim());
    expect(parsed.team).toBe("");
    expect(parsed.verb).toBe("doctor");
  });

  test("non-zero exit (no throw) → outcome='warn'", async () => {
    const { writeFile, readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: "acme", members: [] }));
    const { logVerbEvent } = await import("../../src/cli.ts");
    await logVerbEvent({
      verb: "task",
      args: ["nope"],
      startMs: Date.now() - 5,
      exit: 64,
      outcome: "warn",
    });
    const logsRoot = join(atmuxDir, "logs");
    const years = await readdir(logsRoot);
    const year = years[0] ?? "";
    const months = await readdir(join(logsRoot, year));
    const body = await readFile(join(logsRoot, year, months[0] ?? "", "events.jsonl"), "utf8");
    const parsed = JSON.parse(body.trim());
    expect(parsed.outcome).toBe("warn");
    expect(parsed.exit).toBe(64);
  });
});
