// ADR-009: Test strategy — parity harness runner.
//
// Entry point: takes a verb name + args + fixture path, spawns one side
// (bash or TS atmux), captures the five parity channels (stdout, stderr,
// exit code, post-state fs snapshot, intercepted Discord webhook calls),
// and returns a `ParityRun`. The comparator (`compare.ts`) takes two
// `ParityRun` captures (one bash, one TS) and emits `Divergence[]`.
//
// This file is the harness — it gets the explicit ADR-009 §3.5 carve-out
// for raw `Bun.spawn` (the spawn-wrapper rule applies to `src/`, not to
// test infrastructure). See `docs/adr-bun/009-test-strategy.md` §3.5.

import * as fs from "node:fs/promises";
import { resolve } from "node:path";
import { prepareInterceptor } from "./intercept-discord.ts";

/**
 * Repo root resolved from this file's location. The harness runs from
 * `tests/parity/runner.ts`; repo root is two dirs up. Used to resolve
 * `bin/atmux` (bash) and `bin/atmux-bun` (TS) consistently regardless
 * of `process.cwd()` — the spawned child's cwd is the fixture path,
 * not the repo, so absolute resolution is required.
 */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/**
 * Bash reference binary — frozen at HEAD per PLAN.md §2 (parity target).
 *
 * Defaults to the worktree-local `bin/atmux`, which CI checks out at
 * the branch's HEAD commit (clean by definition; any operator WIP in
 * the working tree never reaches CI). Operators whose main checkout
 * has unstaged WIP can pin to a known-clean binary via the env var
 * `ATMUX_PARITY_BASH_BIN` — typically pointing at the main atmux
 * checkout's `/root/work/src/atmux/bin/atmux`.
 *
 * Resolved once at module load; tests that need a different bash for
 * the same process should re-import via dynamic import (rare).
 */
const BIN_BASH = process.env.ATMUX_PARITY_BASH_BIN || resolve(REPO_ROOT, "bin", "atmux");

/**
 * TS dispatcher entrypoint — `bin/atmux-bun`. The shim imports `main`
 * from `src/cli.ts` and calls `process.exit(await main(...))`. Per
 * ADR-009 §2 + commit `bda7941`, `src/cli.ts` is a pure library with no
 * module-level side effects; running `bun run src/cli.ts <verb>` does
 * nothing. The bin shim is the canonical TS invocation path — the same
 * one cron and human operators will use post-cutover (PLAN.md §4.1).
 */
const BIN_TS = resolve(REPO_ROOT, "bin", "atmux-bun");

/**
 * Which atmux binary this run targets.
 * - `"bash"` — `bin/atmux` (frozen reference at HEAD 2aadc3f).
 * - `"ts"`   — `bin/atmux-bun` (canonical TS entrypoint shim).
 */
export type ParitySide = "bash" | "ts";

/**
 * Captured filesystem snapshot of `.atmux/` after a verb returns.
 *
 * Per ADR-009 §3:
 *   - JSON files diffed via canonical form (parsed + key-sorted in the
 *     comparator; Zod validation lives in the fixture factory once
 *     ADR-005 publishes `src/schema/`).
 *   - Markdown / text files byte-equal after timestamp mask.
 *   - Inbox files match by `(member, lineCount, lastMsgID)` tuple to
 *     allow stable append-only ordering without losing append semantics.
 */
export type FsSnapshot = {
  [relativePath: string]: {
    bytes: Uint8Array;
    mode: number;
    isJson: boolean;
    parsed?: unknown;
  };
};

/**
 * One Discord webhook call captured by the recording stub.
 *
 * Mechanism: env-override `ATMUX_DISCORD_RECORDER` per ADR-008 §"Test
 * interception". ADR-009 contracts the SHAPE — both bash and TS sides
 * MUST emit each outbound webhook call as a JSONL line in this form.
 *
 * For verbs that emit no Discord (e.g. `version`), `discordCalls` is
 * always `[]` on both sides.
 */
export type DiscordCall = {
  /** ISO-8601 timestamp at intercept time. Masked during diff. */
  ts: string;
  /** Webhook payload, e.g. `{ content: string, username?: string }`. */
  payload: {
    content: string;
    [k: string]: unknown;
  };
  /** Which side emitted the call — populated by the runner. */
  runner: ParitySide;
};

/**
 * Result of a single bash- or TS-side verb invocation against a fixture.
 *
 * The comparator (`compare.ts`) consumes two `ParityRun` instances and
 * returns `Divergence[]`. Empty array = parity-green for that row.
 */
export type ParityRun = {
  side: ParitySide;
  verb: string;
  args: ReadonlyArray<string>;
  /** Absolute path to the fixture root (the dir containing `.atmux/`). */
  fixturePath: string;
  stdout: string;
  stderr: string;
  exit: number;
  fsState: FsSnapshot;
  discordCalls: ReadonlyArray<DiscordCall>;
  durationMs: number;
};

/**
 * Options accepted by `runVerb` — kept extensible for Phase 1 additions
 * (env overrides, working-dir overrides, signal handling).
 */
export type RunVerbOptions = {
  /** Hard timeout in ms. Defaults to 30_000. Caller responsibility on long verbs. */
  timeoutMs?: number;
  /** Extra env vars merged on top of the harness's sandbox env. */
  env?: Record<string, string>;
};

/**
 * Hard timeout applied per `runVerb` call when the caller doesn't
 * specify one. 30s matches `src/abstractions/spawn.ts` default and is
 * generous for any single-verb invocation (the longest is `whip` at
 * <5s typical).
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Spawn one side against the fixture and capture the five parity channels.
 *
 * Sandbox env — applied on top of the harness's `process.env` so PATH /
 * HOME / TMPDIR survive, but force-overridden:
 *   - `NO_COLOR=1`               — strip ANSI from both sides
 *   - `ATMUX_SPAWN_WAIT=0`       — disable bash atmux spawn waits (bats convention)
 *   - `ATMUX_DIR=<fixture>/.atmux` — point both sides at the same sandbox state dir
 *   - `ATMUX_DISCORD_WEBHOOK=""` — belt+suspenders against accidental live ping
 *   - `ATMUX_DISCORD_RECORDER=<sink>` — JSONL recorder per ADR-008 §"Test interception"
 *   - any caller-supplied `opts.env` last (so callers can override deliberately)
 *
 * The child's cwd is the fixture path, NOT the repo. This matches how
 * users invoke atmux (cwd is their project root, not atmux's source tree).
 *
 * @throws on timeout, missing binary, or fixture-path nonexistent.
 *         Nonzero exit codes are NOT thrown — that's a captured channel.
 */
export async function runVerb(
  side: ParitySide,
  verb: string,
  args: ReadonlyArray<string>,
  fixturePath: string,
  options?: RunVerbOptions,
): Promise<ParityRun> {
  const fixtureAbs = resolve(fixturePath);

  // Validate fixture exists — fail fast vs spawning into a missing dir.
  try {
    const stat = await fs.stat(fixtureAbs);
    if (!stat.isDirectory()) {
      throw new Error(`runVerb: fixturePath is not a directory: ${fixtureAbs}`);
    }
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT") {
      throw new Error(`runVerb: fixturePath does not exist: ${fixtureAbs}`);
    }
    throw err;
  }

  const interceptor = await prepareInterceptor();
  try {
    const sandboxEnv: Record<string, string> = {
      NO_COLOR: "1",
      ATMUX_SPAWN_WAIT: "0",
      ATMUX_DIR: `${fixtureAbs}/.atmux`,
      ATMUX_DISCORD_WEBHOOK: "",
      ...interceptor.env,
      ...(options?.env ?? {}),
    };

    // Build cmd line per side. ADR-009 §3.5 explicitly carves out raw
    // `Bun.spawn` for this file. Bash side invokes the bash binary
    // directly (it's executable + has its own shebang). TS side goes
    // through `bun run bin/atmux-bun` so we don't depend on the shim's
    // shebang being executable in CI sandboxes.
    const cmdLine: string[] =
      side === "bash" ? [BIN_BASH, verb, ...args] : ["bun", "run", BIN_TS, verb, ...args];

    const start = performance.now();
    const proc = Bun.spawn({
      cmd: cmdLine,
      cwd: fixtureAbs,
      env: { ...process.env, ...sandboxEnv },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeoutMs);

    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timeoutHandle);
    const durationMs = performance.now() - start;

    if (timedOut) {
      throw new Error(
        `runVerb: ${side} ${verb} ${args.join(" ")} exceeded ${timeoutMs}ms timeout (fixture=${fixtureAbs})`,
      );
    }

    const fsState = await snapshotFs(fixtureAbs);
    const discordCalls = await interceptor.readCalls(side);

    return {
      side,
      verb,
      args,
      fixturePath: fixtureAbs,
      stdout: stdoutText,
      stderr: stderrText,
      exit: exitCode,
      fsState,
      discordCalls,
      durationMs,
    };
  } finally {
    await interceptor.cleanup();
  }
}

/**
 * Walk `<fixtureAbs>/.atmux/` recursively and produce an `FsSnapshot`.
 * If `.atmux/` doesn't exist (verbs like `version` that don't touch
 * state), returns an empty snapshot — both sides should match in that
 * case.
 *
 * Paths in the snapshot are relative to `<fixtureAbs>` so two snapshots
 * from runs against different tmpdirs can still be compared key-for-key.
 */
async function snapshotFs(fixtureAbs: string): Promise<FsSnapshot> {
  const snapshot: FsSnapshot = {};
  const atmuxDir = resolve(fixtureAbs, ".atmux");

  let exists = false;
  try {
    const stat = await fs.stat(atmuxDir);
    exists = stat.isDirectory();
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT") {
      exists = false;
    } else {
      throw err;
    }
  }
  if (!exists) return snapshot;

  for await (const entryPath of walk(atmuxDir)) {
    const stat = await fs.stat(entryPath);
    if (!stat.isFile()) continue;
    const bytes = await fs.readFile(entryPath);
    const isJson = entryPath.endsWith(".json");
    let parsed: unknown;
    if (isJson) {
      try {
        // tests/parity/ has the explicit JSON.parse carve-out (ADR-009
        // §3.5 rule applies to src/**, not tests/**). Domain JSON I/O
        // routes through `src/abstractions/json.ts` per ADR-005.
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch {
        // expected: malformed JSON gets compared byte-exact instead
      }
    }
    const rel = entryPath.slice(fixtureAbs.length + 1);
    snapshot[rel] = {
      bytes: new Uint8Array(bytes),
      mode: stat.mode,
      isJson,
      ...(parsed !== undefined ? { parsed } : {}),
    };
  }

  return snapshot;
}

/**
 * Async-generator walker. Skips symlinks (atmux state is files-and-dirs
 * only — symlinks would be a divergence signal of their own).
 */
async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
    // symlinks / sockets / fifos intentionally skipped
  }
}
