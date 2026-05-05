// Unit tests for src/verbs/up.ts (V-01, ADR-010).
// Bash spec: lib/up.sh @ 2aadc3f.
//
// Coverage strategy
// -----------------
// `up()` and `upWith()` orchestrate four sub-verbs (init, doctor, start,
// attach) plus a wizard-prompt gate. Tests inject every external surface
// via `UpOpts` (initFn / doctorFn / startFn / attachFn / hasTeamFn /
// hasSession / resolveSession / promptLine / stderr / logger / palette
// + tty booleans + env + cwd) so the orchestrator runs without spawning
// real tmux or hijacking stdin.
//
// `createPromptLineReader` is tested directly with `Readable.from(...)`
// streams (no real stdin).
//
// The default-deps wiring inside `resolveDeps()` is partially covered by
// tests that omit specific opts so the `??` right-hand side is taken; the
// real-default verb fns (init / doctor / start / attach) are never invoked
// in unit tests — every reachable test path lands in the wizard-or-error
// branch before they would be called.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  createPromptLineReader,
  parseUpArgs,
  type UpOpts,
  up,
  upWith,
} from "../../../src/verbs/up.ts";

// ---------- pure helpers ----------

describe("parseUpArgs", () => {
  test("empty argv → no-op", () => {
    expect(() => parseUpArgs([])).not.toThrow();
  });

  test("any positional → UsageError", () => {
    expect(() => parseUpArgs(["foo"])).toThrow(UsageError);
  });

  test("any flag → UsageError", () => {
    expect(() => parseUpArgs(["--bogus"])).toThrow(UsageError);
  });

  test("UsageError carries the offending arg + 'takes no arguments' hint", () => {
    try {
      parseUpArgs(["--foo"]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      const msg = (err as Error).message;
      expect(msg).toContain("--foo");
      expect(msg).toContain("takes no arguments");
    }
  });
});

describe("createPromptLineReader", () => {
  test("writes prompt to errOutput and returns the read line (newline trimmed)", async () => {
    const writes: string[] = [];
    const errOut = {
      write: (s: string) => {
        writes.push(s);
        return true;
      },
    };
    const reader = createPromptLineReader(Readable.from(["yes\n"]), errOut);
    const ans = await reader("Confirm? ");
    expect(ans).toBe("yes");
    expect(writes).toEqual(["Confirm? "]);
  });

  // Note: rejection / EOF parity (bash `IFS= read || ans=""`) is asserted at
  // the orchestrator layer in `upWith — wizard gate W10` — that test stubs
  // promptLine to throw and verifies the wrapper falls back to "" → Y branch.

  test("default factory call (no args) returns a function — covers default-arg branch", () => {
    // Just constructs the reader bound to process.stdin/process.stderr;
    // we never invoke it (would block on real stdin). The `?? process.*`
    // default branches in the factory's parameter list get evaluated at
    // construction time.
    const reader = createPromptLineReader();
    expect(typeof reader).toBe("function");
  });
});

// ---------- upWith — orchestrator branches ----------

interface CallLog {
  init: number;
  doctorQuiet: number;
  doctorVerbose: number;
  start: number;
  attach: number;
  promptLine: number;
}

interface StubKit {
  log: CallLog;
  baseOpts: UpOpts;
  loggerLines: string[];
  stderrChunks: string[];
}

/** Build a fully-injected `UpOpts` bundle with sensible spy defaults.
 *  Per-test overrides go in via `{ ...baseOpts, X: ... }`. */
function makeStubs(overrides: Partial<UpOpts> = {}): StubKit {
  const log: CallLog = {
    init: 0,
    doctorQuiet: 0,
    doctorVerbose: 0,
    start: 0,
    attach: 0,
    promptLine: 0,
  };
  const loggerLines: string[] = [];
  const stderrChunks: string[] = [];
  const baseOpts: UpOpts = {
    env: {},
    cwd: "/test/cwd",
    teamDir: "/test/cwd",
    isStdinTTY: true,
    isStdoutTTY: true,
    isStderrTTY: true,
    initFn: async () => {
      log.init++;
      return 0;
    },
    doctorFn: async (argv) => {
      if (argv.length === 1 && argv[0] === "--quiet") log.doctorQuiet++;
      else log.doctorVerbose++;
      return 0;
    },
    startFn: async () => {
      log.start++;
      return 0;
    },
    attachFn: async () => {
      log.attach++;
      return 0;
    },
    hasTeamFn: async () => true,
    hasSession: async () => false,
    resolveSession: async () => "atmux-test",
    promptLine: async () => {
      log.promptLine++;
      return "";
    },
    stderr: (s) => {
      stderrChunks.push(s);
    },
    logger: {
      log: (m) => loggerLines.push(`log:${m}`),
      ok: (m) => loggerLines.push(`ok:${m}`),
      warn: (m) => loggerLines.push(`warn:${m}`),
      err: (m) => loggerLines.push(`err:${m}`),
    },
    ...overrides,
  };
  return { log, baseOpts, loggerLines, stderrChunks };
}

describe("upWith — wizard gate (lib/up.sh:16-19, _up_prompt_wizard:50-74)", () => {
  test("W1: hasTeam=false + ATMUX_NO_WIZARD set → ConfigError, no initFn", async () => {
    const { log, baseOpts } = makeStubs({
      env: { ATMUX_NO_WIZARD: "1" },
      hasTeamFn: async () => false,
    });
    await expect(upWith(baseOpts)).rejects.toThrow(ConfigError);
    await expect(upWith(baseOpts)).rejects.toThrow(/ATMUX_NO_WIZARD/);
    expect(log.init).toBe(0);
  });

  test("W2: hasTeam=false + isStdinTTY=false → ConfigError 'not on a TTY'", async () => {
    const { log, baseOpts } = makeStubs({
      hasTeamFn: async () => false,
      isStdinTTY: false,
    });
    await expect(upWith(baseOpts)).rejects.toThrow(/not on a TTY/);
    expect(log.init).toBe(0);
  });

  test("W3: hasTeam=false + isStderrTTY=false (stdin tty, stderr not) → ConfigError", async () => {
    const { log, baseOpts } = makeStubs({
      hasTeamFn: async () => false,
      isStderrTTY: false,
    });
    await expect(upWith(baseOpts)).rejects.toThrow(/not on a TTY/);
    expect(log.init).toBe(0);
  });

  test("W4: hasTeam=false + prompt returns '' (default Y) → initFn(['--wizard']) called once", async () => {
    const initArgs: ReadonlyArray<string>[] = [];
    const { log, baseOpts } = makeStubs({
      hasTeamFn: async () => false,
      promptLine: async () => "",
      initFn: async (argv) => {
        initArgs.push(argv);
        log.init++;
        return 0;
      },
    });
    // After init runs, hasTeam is still mocked to false → wizard would re-trip;
    // but the orchestrator doesn't loop — it falls through to doctor.
    await upWith(baseOpts);
    expect(log.init).toBe(1);
    expect(initArgs[0]).toEqual(["--wizard"]);
  });

  test("W5-W8: prompt returns 'y'/'Y'/'yes'/'YES' → initFn called once each", async () => {
    for (const ans of ["y", "Y", "yes", "YES"] as const) {
      const { log, baseOpts } = makeStubs({
        hasTeamFn: async () => false,
        promptLine: async () => ans,
      });
      await upWith(baseOpts);
      expect(log.init).toBe(1);
    }
  });

  test("W9: prompt returns 'n' → ConfigError 'wizard declined' + warn line emitted", async () => {
    const { log, baseOpts, loggerLines } = makeStubs({
      hasTeamFn: async () => false,
      promptLine: async () => "n",
    });
    await expect(upWith(baseOpts)).rejects.toThrow(/wizard declined/);
    expect(log.init).toBe(0);
    expect(loggerLines.some((l) => l.startsWith("warn:") && l.includes("re-run 'atmux'"))).toBe(
      true,
    );
  });

  test("W10: prompter rejects → caught → empty answer → defaults to Y → initFn called", async () => {
    const { log, baseOpts } = makeStubs({
      hasTeamFn: async () => false,
      promptLine: async () => {
        throw new Error("simulated EOF / read failure");
      },
    });
    await upWith(baseOpts);
    expect(log.init).toBe(1);
  });

  test("W11: hasTeam=true → wizard skipped, no promptLine, no initFn, falls through", async () => {
    const { log, baseOpts } = makeStubs({ hasTeamFn: async () => true });
    await upWith({ ...baseOpts, env: { TMUX: "/tmp/x,1,0" } });
    expect(log.promptLine).toBe(0);
    expect(log.init).toBe(0);
  });

  test("W-stderr-preamble: writes the multi-line wizard preamble to opts.stderr", async () => {
    const { baseOpts, stderrChunks } = makeStubs({
      hasTeamFn: async () => false,
      promptLine: async () => "y",
    });
    await upWith(baseOpts);
    const joined = stderrChunks.join("");
    expect(joined).toContain("🧙 atmux");
    expect(joined).toContain("no team.json found");
    expect(joined).toContain("/test/cwd");
  });

  test("W-no-team-path: ATMUX_DIR honored when building the no-tty error path", async () => {
    const { baseOpts } = makeStubs({
      env: { ATMUX_DIR: "/synthetic/.atmux" },
      hasTeamFn: async () => false,
      isStdinTTY: false,
    });
    // Drop `teamDir` so getAtmuxDir() falls back to env.ATMUX_DIR
    // (exactOptionalPropertyTypes forbids passing undefined explicitly).
    const { teamDir: _drop, ...rest } = baseOpts;
    await expect(upWith(rest)).rejects.toThrow(/\/synthetic\/\.atmux\/team\.json/);
  });
});

describe("upWith — doctor gate (lib/up.sh:21-26)", () => {
  test("D1: quiet doctor returns 0 → falls through, no second doctor call", async () => {
    const { log, baseOpts } = makeStubs();
    await upWith({ ...baseOpts, env: { TMUX: "/tmp/x,1,0" } });
    expect(log.doctorQuiet).toBe(1);
    expect(log.doctorVerbose).toBe(0);
  });

  test("D2: quiet doctor returns 1 → second doctor([]) called → ConfigError 'preflight failed'", async () => {
    const { log, baseOpts } = makeStubs({
      doctorFn: async (argv) => {
        if (argv.length === 1 && argv[0] === "--quiet") {
          // first call: red
          return 1;
        }
        // verbose re-run: also red, but rc ignored
        return 1;
      },
    });
    await expect(upWith(baseOpts)).rejects.toThrow(/preflight failed/);
    // Counts incremented inside the stub above won't reflect because we
    // overrode doctorFn. Instead spy via a fresh closure:
    let qN = 0;
    let vN = 0;
    const opts: UpOpts = {
      ...baseOpts,
      doctorFn: async (argv) => {
        if (argv.length === 1 && argv[0] === "--quiet") {
          qN++;
          return 1;
        }
        vN++;
        return 1;
      },
    };
    await expect(upWith(opts)).rejects.toThrow(ConfigError);
    expect(qN).toBe(1);
    expect(vN).toBe(1);
    expect(log.start).toBe(0);
  });

  test("D3: quiet=1 + verbose throws → swallowed, ConfigError still thrown", async () => {
    const { log, baseOpts } = makeStubs({
      doctorFn: async (argv) => {
        if (argv.length === 1 && argv[0] === "--quiet") return 1;
        throw new Error("verbose doctor blew up");
      },
    });
    await expect(upWith(baseOpts)).rejects.toThrow(/preflight failed/);
    expect(log.start).toBe(0);
  });
});

describe("upWith — start / session gate (lib/up.sh:28-34)", () => {
  test("S1: hasSession=true → startFn NOT called + 'reusing' log line", async () => {
    const { log, baseOpts, loggerLines } = makeStubs({
      hasSession: async () => true,
    });
    await upWith({ ...baseOpts, env: { TMUX: "/tmp/x,1,0" } });
    expect(log.start).toBe(0);
    expect(loggerLines.some((l) => l.includes("already running — reusing"))).toBe(true);
  });

  test("S2: hasSession=false → startFn([]) called once", async () => {
    const startArgs: ReadonlyArray<string>[] = [];
    const { baseOpts } = makeStubs({
      hasSession: async () => false,
      startFn: async (argv) => {
        startArgs.push(argv);
        return 0;
      },
    });
    await upWith({ ...baseOpts, env: { TMUX: "/tmp/x,1,0" } });
    expect(startArgs.length).toBe(1);
    expect(startArgs[0]).toEqual([]);
  });
});

describe("upWith — attach gate (lib/up.sh:36-45)", () => {
  test("A1: env.TMUX set → 'already inside tmux' ok-line + return 0 + attachFn NOT called", async () => {
    const { log, baseOpts, loggerLines } = makeStubs();
    const rc = await upWith({ ...baseOpts, env: { TMUX: "/tmp/tmux-1000/default,1,0" } });
    expect(rc).toBe(0);
    expect(log.attach).toBe(0);
    expect(loggerLines.some((l) => l.startsWith("ok:already inside tmux"))).toBe(true);
    expect(loggerLines.some((l) => l.includes("tmux switch-client -t atmux-test"))).toBe(true);
  });

  test("A2: TMUX unset + isStdoutTTY=false → 'not on a TTY' log + return 0 + attachFn NOT called", async () => {
    const { log, baseOpts, loggerLines } = makeStubs({ isStdoutTTY: false });
    const rc = await upWith(baseOpts);
    expect(rc).toBe(0);
    expect(log.attach).toBe(0);
    expect(loggerLines.some((l) => l.includes("not on a TTY") && l.includes("atmux-test"))).toBe(
      true,
    );
  });

  test("A3: TMUX unset + isStdinTTY=false (stdout tty) → 'not on a TTY' branch", async () => {
    const { log, baseOpts, loggerLines } = makeStubs({ isStdinTTY: false });
    const rc = await upWith(baseOpts);
    expect(rc).toBe(0);
    expect(log.attach).toBe(0);
    expect(loggerLines.some((l) => l.includes("not on a TTY"))).toBe(true);
  });

  test("A4: TMUX unset + both ttys true → attachFn([]) called once + return its rc", async () => {
    const attachArgs: ReadonlyArray<string>[] = [];
    const { baseOpts } = makeStubs({
      attachFn: async (argv) => {
        attachArgs.push(argv);
        return 0;
      },
    });
    const rc = await upWith(baseOpts);
    expect(rc).toBe(0);
    expect(attachArgs.length).toBe(1);
    expect(attachArgs[0]).toEqual([]);
  });

  test("A4b: TMUX env empty string treated as unset (tty path taken)", async () => {
    const { log, baseOpts } = makeStubs();
    const rc = await upWith({ ...baseOpts, env: { TMUX: "" } });
    expect(rc).toBe(0);
    expect(log.attach).toBe(1);
  });
});

// ---------- up — outer wrapper ----------

describe("up — outer wrapper", () => {
  test("up(['--bogus']) rejects with UsageError before any orchestration", async () => {
    let any = 0;
    await expect(
      up(["--bogus"], {
        initFn: async () => {
          any++;
          return 0;
        },
        doctorFn: async () => {
          any++;
          return 0;
        },
        startFn: async () => {
          any++;
          return 0;
        },
        attachFn: async () => {
          any++;
          return 0;
        },
      }),
    ).rejects.toThrow(UsageError);
    expect(any).toBe(0);
  });

  test("up([], opts) routes through parseUpArgs → upWith → returns 0 on TMUX-set fast path", async () => {
    const { baseOpts, loggerLines } = makeStubs();
    const rc = await up([], { ...baseOpts, env: { TMUX: "/tmp/x,1,0" } });
    expect(rc).toBe(0);
    expect(loggerLines.some((l) => l.startsWith("ok:already inside tmux"))).toBe(true);
  });
});

// ---------- default-deps coverage ----------

describe("up — default-deps fallback (covers `??` right-hand sides in resolveDeps)", () => {
  let scratch: string;
  let priorAtmuxDir: string | undefined;
  let priorAtmuxNoWizard: string | undefined;
  let priorTmux: string | undefined;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-up-test-"));
    priorAtmuxDir = process.env.ATMUX_DIR;
    priorAtmuxNoWizard = process.env.ATMUX_NO_WIZARD;
    priorTmux = process.env.TMUX;
    // Point at a definitely-empty dir so hasTeam returns false.
    process.env.ATMUX_DIR = join(scratch, ".atmux");
    process.env.ATMUX_NO_WIZARD = "1";
    delete process.env.TMUX;
  });

  afterEach(async () => {
    if (priorAtmuxDir === undefined) delete process.env.ATMUX_DIR;
    else process.env.ATMUX_DIR = priorAtmuxDir;
    if (priorAtmuxNoWizard === undefined) delete process.env.ATMUX_NO_WIZARD;
    else process.env.ATMUX_NO_WIZARD = priorAtmuxNoWizard;
    if (priorTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = priorTmux;
    await rm(scratch, { recursive: true, force: true });
  });

  test("upWith({}) with all defaults + no team.json + ATMUX_NO_WIZARD=1 → ConfigError", async () => {
    // This test exercises every `??` right-hand side in resolveDeps:
    // env defaults to process.env, cwd to process.cwd(), tty booleans to
    // process.std*.isTTY, palette/logger/stderr/sub-verb fns/hasTeam/
    // hasSession/resolveSession/promptLine all assigned from defaults.
    // We bail out at the wizard gate's ATMUX_NO_WIZARD branch before any
    // real verb fn is invoked, so the side-effect-free defaults run only.
    await expect(upWith({})).rejects.toThrow(ConfigError);
    await expect(upWith({})).rejects.toThrow(/ATMUX_NO_WIZARD/);
  });

  test("up([]) with no opts → same default-deps path → ConfigError", async () => {
    await expect(up([])).rejects.toThrow(ConfigError);
  });

  test("default opts.stderr fallback writes wizard preamble to process.stderr", async () => {
    // Specifically exercises the `opts.stderr ?? (s => process.stderr.write(s))`
    // closure body. Reaches it by omitting opts.stderr while routing through
    // the wizard-Y path; we capture process.stderr to assert the preamble
    // bytes land there, then restore in finally.
    delete process.env.ATMUX_NO_WIZARD; // override beforeEach so wizard runs
    let captured = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: unknown) => boolean }).write = (s: unknown) => {
      captured += typeof s === "string" ? s : new TextDecoder().decode(s as Uint8Array);
      return true;
    };
    try {
      let initCalled = 0;
      const rc = await upWith({
        env: {},
        cwd: "/test/wiz-cwd",
        teamDir: "/test/wiz-cwd",
        isStdinTTY: true,
        isStdoutTTY: true,
        isStderrTTY: true,
        hasTeamFn: async () => false,
        promptLine: async () => "y",
        initFn: async () => {
          initCalled++;
          return 0;
        },
        doctorFn: async () => 0,
        startFn: async () => 0,
        attachFn: async () => 0,
        hasSession: async () => true, // skip start
        resolveSession: async () => "atmux-w",
        logger: { log() {}, ok() {}, warn() {}, err() {} },
        // stderr NOT injected — exercises default closure
      });
      expect(rc).toBe(0);
      expect(initCalled).toBe(1);
      expect(captured).toContain("🧙 atmux");
      expect(captured).toContain("/test/wiz-cwd");
    } finally {
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    }
  });
});

// ---------- default hasSession integration ----------

/**
 * Exercises the default `hasSession` closure body (the inline factory in
 * `resolveDeps()` that calls `requireTeam` → `createTmux` →
 * `tmux.session.hasSession`). Without this test, those lines stay
 * uncovered because every other test injects `opts.hasSession` directly.
 *
 * Strategy: write a real team.json fixture, leave `hasSession` unset, and
 * stub the surrounding sub-verbs so the orchestrator reaches the
 * `await deps.hasSession(session)` call. With no tmux server running on
 * `getDefaultSocket(team.name)`, the real `tmux.session.hasSession` returns
 * `false` (per `tests/unit/verbs/attach.test.ts:184` precedent — the
 * abstraction surfaces "no server" as `false`, not as a throw). That
 * drives the orchestrator into the `startFn(...)` branch, then the
 * stubbed attachFn returns 0.
 */
describe("upWith — default hasSession closure (no opts.hasSession)", () => {
  let scratch: string;
  let atmuxDir: string;
  let priorAtmuxDir: string | undefined;
  let priorAtmuxTeamDir: string | undefined;
  let priorAtmuxSession: string | undefined;
  let priorTmux: string | undefined;
  const teamName = `up${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-up-int-"));
    atmuxDir = join(scratch, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: teamName, members: [] }));

    priorAtmuxDir = process.env.ATMUX_DIR;
    priorAtmuxTeamDir = process.env.ATMUX_TEAM_DIR;
    priorAtmuxSession = process.env.ATMUX_SESSION;
    priorTmux = process.env.TMUX;
    process.env.ATMUX_DIR = atmuxDir;
    delete process.env.ATMUX_TEAM_DIR;
    delete process.env.ATMUX_SESSION;
    delete process.env.TMUX;
  });

  afterEach(async () => {
    if (priorAtmuxDir === undefined) delete process.env.ATMUX_DIR;
    else process.env.ATMUX_DIR = priorAtmuxDir;
    if (priorAtmuxTeamDir === undefined) delete process.env.ATMUX_TEAM_DIR;
    else process.env.ATMUX_TEAM_DIR = priorAtmuxTeamDir;
    if (priorAtmuxSession === undefined) delete process.env.ATMUX_SESSION;
    else process.env.ATMUX_SESSION = priorAtmuxSession;
    if (priorTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = priorTmux;
    await rm(scratch, { recursive: true, force: true });
  });

  test("default hasSession invokes requireTeam + createTmux + tmux.hasSession (no server → false → start path)", async () => {
    let startCalls = 0;
    let attachCalls = 0;
    const rc = await upWith({
      doctorFn: async () => 0,
      startFn: async () => {
        startCalls++;
        return 0;
      },
      attachFn: async () => {
        attachCalls++;
        return 0;
      },
      isStdinTTY: true,
      isStdoutTTY: true,
      isStderrTTY: true,
      // hasSession NOT overridden → default closure runs.
    });
    expect(rc).toBe(0);
    expect(startCalls).toBe(1); // hasSession returned false → start called
    expect(attachCalls).toBe(1); // tty path → attach called
  });
});
