// Unit tests for src/cli.ts (ADR-010 + ADR-006 top-level catch).
//
// `src/cli.ts` is in the tracked coverage denominator per architect's
// review-verdict refinement (commit `64898c7`) and the bunfig.toml
// comment ratifies it: cli.ts dispatch logic IS unit-testable
// (alias routing, unknown-verb exit code, reportError tag → exit
// mapping) and SHOULD be tracked, not excluded. 100% required.
//
// Coverage map for the dispatcher + reportError:
//   - "version" / "--version" / "-V" → exit 0 (bash parity, all 3 forms)
//   - unknown verb → exit 64 + "atmux: unknown verb: <verb>" + 2-space
//     hint line. Byte-matches bash `bin/atmux:324-328`.
//   - empty argv → unknown-verb path with "<none>" label
//   - reportError UsageError (no hint) — covers the no-hint branch
//   - reportError other AtmuxError → exitCodeForTag mapping (e.g.
//     FsError → 1, HttpTimeoutError → 75, ConfigError → 78)
//   - reportError AtmuxError + ATMUX_DEBUG=1 → cause chain on stderr
//   - reportError plain Error → exit 99 + stack
//   - reportError Error without `.stack` → falls back to `.message`
//   - reportError non-Error throw (e.g. string) → exit 99 + String(err)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { main, reportError } from "../../src/cli.ts";
import { ConfigError, FsError, HttpTimeoutError, UsageError } from "../../src/errors.ts";

// ---------- Test scaffolding ----------

interface CapturedIO {
  exit: number;
  stdout: string;
  stderr: string;
}

/**
 * Capture both `console.log` (the version verb's print) and
 * `process.stderr.write` (reportError's output). Restores both in
 * `finally` even if the assertion throws.
 */
async function captureMain(argv: ReadonlyArray<string>): Promise<CapturedIO> {
  let stdoutBuf = "";
  let stderrBuf = "";
  const origLog = console.log;
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  console.log = (msg: unknown) => {
    stdoutBuf += `${String(msg)}\n`;
  };
  process.stderr.write = ((s: string | Uint8Array) => {
    stderrBuf += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = await main(argv);
    return { exit, stdout: stdoutBuf, stderr: stderrBuf };
  } finally {
    console.log = origLog;
    process.stderr.write = origStderrWrite;
  }
}

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
  test("'version' → exit 0, prints 'atmux 0.3.0'", async () => {
    const { exit, stdout, stderr } = await captureMain(["version"]);
    expect(exit).toBe(0);
    expect(stdout).toBe("atmux 0.3.0\n");
    expect(stderr).toBe("");
  });

  test("'--version' alias → exit 0, prints 'atmux 0.3.0' (bash parity)", async () => {
    const { exit, stdout, stderr } = await captureMain(["--version"]);
    expect(exit).toBe(0);
    expect(stdout).toBe("atmux 0.3.0\n");
    expect(stderr).toBe("");
  });

  test("'-V' alias → exit 0, prints 'atmux 0.3.0' (bash parity)", async () => {
    const { exit, stdout, stderr } = await captureMain(["-V"]);
    expect(exit).toBe(0);
    expect(stdout).toBe("atmux 0.3.0\n");
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

// ---------- Dispatch — add-member verb route (smoke; deep behaviour is in
//                       tests/unit/verbs/add-member.test.ts) ----------

describe("cli.main — add-member verb dispatch", () => {
  test("'add-member' with no args dispatches into addMember (UsageError)", async () => {
    // parseAddMemberArgs throws UsageError when the member-name positional
    // is missing — exit 64. Pins the `case "add-member":` line; deep verb
    // behaviour lives in tests/unit/verbs/add-member.test.ts.
    const { exit, stderr } = await captureMain(["add-member"]);
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

  test("empty argv → exit 64 + '<none>' label in stderr", async () => {
    const { exit, stdout, stderr } = await captureMain([]);
    expect(exit).toBe(64);
    expect(stdout).toBe("");
    expect(stderr).toBe("atmux: unknown verb: <none>\n  run 'atmux help' for the list of verbs\n");
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

  test("`bin/atmux-bun version` exits 0 + prints 'atmux 0.3.0'", async () => {
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
    expect(stdout).toBe("atmux 0.3.0\n");
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
