// ADR-010: CLI dispatcher — `up` verb (V-01).
// Bash spec: lib/up.sh @ 2aadc3f.
//
// Composite verb — wizard-if-new → doctor preflight → start (if not running)
// → attach. Bare `atmux` aliases to `up` (bin/atmux:91 in bash;
// `case "":` in src/cli.ts on the TS side).
//
// Two-function shape mirrors `attach.ts:attachWithTmux + attach`. `up()` wires
// production defaults via `resolveDeps()`; `upWith()` is the pure orchestrator
// over an already-resolved dep bundle so unit tests can stub every external
// surface (sub-verbs, hasSession, hasTeam, promptLine) without spawning real
// tmux or hijacking stdin.
//
// Known limitation. `init --wizard` is still a stub (init.ts:188-191): the
// wizard-Y branch invokes `initFn(["--wizard"])` which currently throws
// ConfigError("init: --wizard not yet implemented in atmux-bun"). The
// composite passes that error through verbatim — bash parity for the
// wizard-Y branch only restores when init's wizard ports.

import { createInterface } from "node:readline/promises";
import { createTmux } from "../abstractions/tmux.ts";
import {
  getAtmuxDir,
  getDefaultSocket,
  getSessionName,
  hasTeam,
  type ResolveDirOpts,
  requireTeam,
  type SessionNameOpts,
  teamJsonPath,
} from "../core/common.ts";
import { type AnsiPalette, createLogger, defaultPalette, type Logger } from "../core/tui.ts";
import { ConfigError, UsageError } from "../errors.ts";
import { attach, exactSessionTarget } from "./attach.ts";
import { doctor } from "./doctor.ts";
import { init } from "./init.ts";
import { start } from "./start.ts";

// ---------- Public types ----------

/** Injection points for `up()`. Tests stub the verb fns + tty/env state;
 *  prod path uses real implementations. */
export interface UpOpts {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** `<root>/.atmux` — forwarded to `ResolveDirOpts.teamDir` chain. */
  teamDir?: string;
  isStdinTTY?: boolean;
  isStdoutTTY?: boolean;
  isStderrTTY?: boolean;
  initFn?: typeof init;
  doctorFn?: typeof doctor;
  startFn?: typeof start;
  attachFn?: typeof attach;
  hasTeamFn?: (opts: ResolveDirOpts) => Promise<boolean>;
  /** Probe whether the team's tmux session exists. Default uses
   *  createTmux + getDefaultSocket(team). */
  hasSession?: (sessionName: string) => Promise<boolean>;
  /** Resolve the team's session name (`atmux-<team>`-ish). Default uses
   *  `core/common.getSessionName`. */
  resolveSession?: (opts: SessionNameOpts) => Promise<string>;
  /** Single-line stdin reader. Writes prompt to stderr. EOF/error → "". */
  promptLine?: (prompt: string) => Promise<string>;
  /** Raw stderr writer for the multi-line wizard preamble (the "🧙 atmux"
   *  glyph differs from the standard logger prefix, so it bypasses the
   *  Logger). Default = `process.stderr.write`-bound. */
  stderr?: (s: string) => void;
  logger?: Logger;
  palette?: AnsiPalette;
}

/** Internal — fully-resolved deps after `resolveDeps()`. Not exported because
 *  every external caller goes through `up()` or `upWith()` which take `UpOpts`. */
interface ResolvedDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  teamDir: string | undefined;
  isStdinTTY: boolean;
  isStdoutTTY: boolean;
  isStderrTTY: boolean;
  initFn: NonNullable<UpOpts["initFn"]>;
  doctorFn: NonNullable<UpOpts["doctorFn"]>;
  startFn: NonNullable<UpOpts["startFn"]>;
  attachFn: NonNullable<UpOpts["attachFn"]>;
  hasTeamFn: NonNullable<UpOpts["hasTeamFn"]>;
  hasSession: NonNullable<UpOpts["hasSession"]>;
  resolveSession: NonNullable<UpOpts["resolveSession"]>;
  promptLine: NonNullable<UpOpts["promptLine"]>;
  stderr: NonNullable<UpOpts["stderr"]>;
  logger: Logger;
  palette: AnsiPalette;
}

const USAGE_HINT = "atmux up takes no arguments";

// ---------- Pure helpers ----------

/** Reject any argv — bash `lib/up.sh` takes no flags. */
export function parseUpArgs(args: ReadonlyArray<string>): void {
  if (args.length > 0) {
    throw new UsageError({
      what: `up: unexpected argument: ${args[0] ?? ""}`,
      hint: USAGE_HINT,
    });
  }
}

/**
 * Build a single-line prompt reader. Writes `prompt` to `errOutput`, then
 * reads one line from `input` via `node:readline/promises`. Rejections
 * (closed/destroyed stream) propagate up to the caller; `runWizardGate`
 * wraps its `promptLine` invocation in a try/catch that maps any rejection
 * to "" — this is where bash's `IFS= read -r ans || ans=""` parity lives.
 *
 * Exported so tests cover the body without going through `up()`'s full env
 * wiring (prod `up()` calls this with `process.stdin` / `process.stderr`;
 * tests pass `Readable.from([…])` + a write-capture stub).
 */
export function createPromptLineReader(
  input: NodeJS.ReadableStream = process.stdin,
  errOutput: { write: (s: string) => unknown } = process.stderr,
): (prompt: string) => Promise<string> {
  return async (prompt: string) => {
    errOutput.write(prompt);
    const rl = createInterface({ input });
    try {
      return await rl.question("");
    } finally {
      rl.close();
    }
  };
}

// ---------- Default-deps resolver ----------

function buildResolveDirOpts(
  env: NodeJS.ProcessEnv,
  cwd: string,
  teamDir: string | undefined,
): ResolveDirOpts {
  const out: ResolveDirOpts = { env, cwd };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

function buildSessionNameOpts(
  env: NodeJS.ProcessEnv,
  cwd: string,
  teamDir: string | undefined,
): SessionNameOpts {
  const out: SessionNameOpts = { env, cwd };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

function defaultHasSession(
  env: NodeJS.ProcessEnv,
  cwd: string,
  teamDir: string | undefined,
): (sessionName: string) => Promise<boolean> {
  return async (sessionName: string) => {
    const team = await requireTeam(buildResolveDirOpts(env, cwd, teamDir));
    const tmux = createTmux({ socketPath: getDefaultSocket(team.name) });
    return await tmux.session.hasSession(exactSessionTarget(sessionName));
  };
}

function resolveDeps(opts: UpOpts): ResolvedDeps {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const isStdinTTY = opts.isStdinTTY ?? process.stdin.isTTY === true;
  const isStdoutTTY = opts.isStdoutTTY ?? process.stdout.isTTY === true;
  const isStderrTTY = opts.isStderrTTY ?? process.stderr.isTTY === true;
  const palette = opts.palette ?? defaultPalette({ isTty: isStderrTTY, env });
  return {
    env,
    cwd,
    teamDir: opts.teamDir,
    isStdinTTY,
    isStdoutTTY,
    isStderrTTY,
    initFn: opts.initFn ?? init,
    doctorFn: opts.doctorFn ?? doctor,
    startFn: opts.startFn ?? start,
    attachFn: opts.attachFn ?? attach,
    hasTeamFn: opts.hasTeamFn ?? hasTeam,
    hasSession: opts.hasSession ?? defaultHasSession(env, cwd, opts.teamDir),
    resolveSession: opts.resolveSession ?? getSessionName,
    promptLine: opts.promptLine ?? createPromptLineReader(),
    stderr: opts.stderr ?? ((s: string) => process.stderr.write(s)),
    logger: opts.logger ?? createLogger({ palette }),
    palette,
  };
}

// ---------- Orchestrator ----------

/**
 * Resolve `UpOpts` into a fully-defaulted dep bundle and run the four
 * bash steps in order: wizard gate → doctor preflight → start-or-reuse
 * → attach gate. Errors throw `AtmuxError` subclasses; the top-level
 * dispatcher in `src/cli.ts` maps to sysexits per ADR-006.
 *
 * Exported as the primary unit-test entry — tests inject every external
 * surface (sub-verb fns, hasTeam, hasSession, promptLine) via `opts` and
 * assert observable behaviour on the returned promise. The thin
 * `up(args, opts)` wrapper adds argv parsing.
 */
export async function upWith(opts: UpOpts = {}): Promise<number> {
  const deps = resolveDeps(opts);
  const dirOpts = buildResolveDirOpts(deps.env, deps.cwd, deps.teamDir);

  // ---- 1. wizard gate (lib/up.sh:16-19) ----
  if (!(await deps.hasTeamFn(dirOpts))) {
    await runWizardGate(deps, dirOpts);
  }

  // ---- 2. doctor preflight (lib/up.sh:21-26) ----
  const quietRc = await deps.doctorFn(["--quiet"], {});
  if (quietRc !== 0) {
    // Re-run verbosely so the user sees the red rows; ignore its outcome.
    try {
      await deps.doctorFn([], {});
    } catch {
      // swallow — die-message below is the operator-facing signal
    }
    throw new ConfigError({
      what: "preflight failed",
      hint: "fix the red items above, then re-run 'atmux'",
    });
  }

  // ---- 3. start if not up (lib/up.sh:28-34) ----
  const session = await deps.resolveSession(buildSessionNameOpts(deps.env, deps.cwd, deps.teamDir));
  if (await deps.hasSession(session)) {
    deps.logger.log(`session ${session} already running — reusing`);
  } else {
    await deps.startFn([], {});
  }

  // ---- 4. attach (TTY-gated, lib/up.sh:36-45) ----
  const tmuxEnv = deps.env.TMUX;
  if (tmuxEnv !== undefined && tmuxEnv.length > 0) {
    deps.logger.ok(`already inside tmux — switch with: tmux switch-client -t ${session}`);
    return 0;
  }
  if (!deps.isStdinTTY || !deps.isStdoutTTY) {
    deps.logger.log(`not on a TTY — skipping attach (session: ${session})`);
    return 0;
  }
  return await deps.attachFn([]);
}

/** Wizard-prompt gate (`_up_prompt_wizard` in lib/up.sh:50-74). On Y →
 *  runs `init --wizard` and returns; on N / declined → throws ConfigError. */
async function runWizardGate(deps: ResolvedDeps, dirOpts: ResolveDirOpts): Promise<void> {
  const noWizard = deps.env.ATMUX_NO_WIZARD;
  if (noWizard !== undefined && noWizard.length > 0) {
    throw new ConfigError({
      what: "no team.json here and ATMUX_NO_WIZARD is set",
      hint: "run 'atmux init --wizard' manually",
    });
  }
  if (!deps.isStdinTTY || !deps.isStderrTTY) {
    const dir = await getAtmuxDir(dirOpts);
    throw new ConfigError({
      what: `no team.json at ${teamJsonPath(dir)} and not on a TTY`,
      hint: "run 'atmux init --wizard' first",
    });
  }

  const p = deps.palette;
  // Multi-line preamble — bash printf '\n%s🧙 atmux%s …' >&2 (lib/up.sh:58-62).
  // Raw stderr write because the wizard glyph (🧙) differs from the standard
  // logger prefix (🔹/✅/⚠️).
  deps.stderr(`\n${p.cyn}🧙 atmux${p.rst}  no team.json found in this directory:\n`);
  deps.stderr(`            ${p.bld}${deps.cwd}${p.rst}\n\n`);
  const prompt = `  ${p.cyn}Set up a new atmux team here?${p.rst} ${p.dim}[Y/n]${p.rst}: `;

  let ans: string;
  try {
    ans = await deps.promptLine(prompt);
  } catch {
    // Defensive — `createPromptLineReader` already swallows EOF, but a
    // user-injected prompter might not. Match bash `IFS= read || ans=""`.
    ans = "";
  }

  if (/^(|y|Y|yes|YES)$/.test(ans)) {
    await deps.initFn(["--wizard"], {});
    return;
  }

  deps.logger.warn(
    "ok — cd into your project dir and re-run 'atmux', or run 'atmux init --wizard' when ready",
  );
  throw new ConfigError({
    what: "no team.json here and wizard declined",
    hint: "cd into your project dir, or run 'atmux init --wizard'",
  });
}

// ---------- Public entry ----------

/**
 * `atmux up` — composite bring-up. Returns 0 on clean attach (or 0 when
 * skipped due to TMUX-env / non-tty); throws `AtmuxError` subclasses on
 * failure (mapped to sysexits by `src/cli.ts::reportError`).
 */
export async function up(args: ReadonlyArray<string>, opts: UpOpts = {}): Promise<number> {
  parseUpArgs(args);
  return await upWith(opts);
}
