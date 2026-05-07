// ADR-055 §D3: cursor-agent invocation abstraction.
//
// Spawns the Cursor CLI with a constrained job (prompt + allowlist +
// token cap), captures stdout, parses the --output-json tool-use
// records for token accounting, computes the resulting git diff via
// `git diff` post-invocation, and returns the structured result.
//
// All filesystem reach is bounded by `--cwd`; the recipe's allowlist
// enforcement happens at verify-time (not here), so this module stays
// agnostic of which recipe invoked it. The cursor session log is
// written here — the per-recipe log path is built by the caller and
// passed in (`opts.logPath`).
//
// Failure posture: the abstraction NEVER throws on a Cursor failure
// (non-zero exit, malformed --json, missing binary). It returns a
// CursorInvokeResult with `exitCode != 0` and an empty patch; the
// caller's verify step surfaces the failure as a P2 flag. This
// matches CLAUDE.md's "degrade gracefully" rule for non-critical
// observability layers.

import { join } from "node:path";
import { appendText, ensureDir } from "./fs.ts";
import { spawn, type SpawnResult } from "./spawn.ts";
import type { CursorJob, GitPatch } from "../core/cursor-recipes/types.ts";

// ---------- Public types ----------

export interface CursorInvokeResult {
  /** Exit code from cursor-agent. 0 = success. */
  exitCode: number;
  /** Captured stdout (the --output-json stream). */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
  /** Computed patch (post-cursor `git diff` of the cwd). Empty when
   *  cursor made no edits OR cursor failed before any edit. */
  patch: GitPatch;
  /** Tokens consumed (parsed from --output-json final-message metadata).
   *  -1 when the metadata couldn't be parsed; the caller may treat -1
   *  as "unknown" but should still proceed to verify. */
  tokensUsed: number;
  /** Wall-clock duration of the cursor invocation. */
  durationMs: number;
}

export interface InvokeCursorOpts {
  /** Path the session log (`cursor-self-heal-<recipe>-<ts>.log`) should
   *  be appended to. Caller composes the path; this module owns the
   *  write under flock. Optional — set to undefined to skip log
   *  persistence (tests do). */
  logPath?: string;
  /** Override the cursor-agent binary name/path. Default `cursor-agent`
   *  (resolved via $PATH). Tests inject a stub script path. */
  cursorBinary?: string;
  /** Override the model passed via `--model`. Default `composer-2`
   *  per ADR-055 OQ-1. */
  cursorModel?: string;
  /** Override the spawn function — primarily for tests. Returns the
   *  three fields cursor.ts actually consumes (exitCode + stdout +
   *  stderr); production-side `spawn` returns a wider SpawnResult
   *  which is structurally compatible. */
  spawnFn?: (opts: {
    cmd: string;
    argv: ReadonlyArray<string>;
    stdin?: string;
    cwd?: string;
    timeoutMs?: number;
    expectExitCode?: number | ReadonlyArray<number> | "any";
  }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Override how the post-invocation patch is computed. Defaults to
   *  shelling `git diff` + `git status -s` in the cwd. Tests inject
   *  a fake to avoid needing a git repo + writeable files. */
  computePatch?: (cwd: string) => Promise<GitPatch>;
  /** Hard wall-clock timeout. Default 5min. */
  timeoutMs?: number;
}

// ---------- Public API ----------

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CURSOR_BIN = "cursor-agent";
const DEFAULT_MODEL = "composer-2";

/**
 * Invoke cursor-agent with the given job and return the structured
 * result. Never throws on Cursor failure — returns a result with
 * `exitCode != 0`.
 */
export async function invokeCursor(
  job: CursorJob,
  opts: InvokeCursorOpts = {},
): Promise<CursorInvokeResult> {
  const start = Date.now();
  const cursorBin = opts.cursorBinary ?? DEFAULT_CURSOR_BIN;
  const model = opts.cursorModel ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn = opts.spawnFn ?? spawn;
  const computePatch = opts.computePatch ?? defaultComputePatch;

  const argv: string[] = [
    "--print",
    "--model",
    model,
    "--force",
    "--max-tokens",
    String(job.tokenCap),
    "--output-json",
    "--cwd",
    job.cwd,
  ];

  let result: { exitCode: number; stdout: string; stderr: string };
  try {
    result = await spawnFn({
      cmd: cursorBin,
      argv,
      stdin: job.prompt,
      cwd: job.cwd,
      timeoutMs,
      expectExitCode: "any",
    });
  } catch (e) {
    // Spawn-level failure — cursor binary missing, etc. Return a
    // failure-shaped result rather than throwing.
    const fail: CursorInvokeResult = {
      exitCode: -1,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      patch: { diff: "", files: [] },
      tokensUsed: -1,
      durationMs: Date.now() - start,
    };
    if (opts.logPath !== undefined) {
      await writeSessionLog(opts.logPath, job, fail);
    }
    return fail;
  }

  const tokensUsed = parseTokensFromJsonStream(result.stdout);
  const patch =
    result.exitCode === 0
      ? await computePatch(job.cwd).catch(() => ({ diff: "", files: [] as string[] }))
      : { diff: "", files: [] as string[] };

  const out: CursorInvokeResult = {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    patch,
    tokensUsed,
    durationMs: Date.now() - start,
  };

  if (opts.logPath !== undefined) {
    await writeSessionLog(opts.logPath, job, out);
  }

  return out;
}

// ---------- Internals ----------

/** Parse cursor-agent's `--output-json` stream for the final message's
 *  token count. Cursor emits JSONL (one JSON object per line); the
 *  final tool-use record carries `tokensUsed`. Returns -1 on parse
 *  failure / no record. */
function parseTokensFromJsonStream(stdout: string): number {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  let total = -1;
  for (const line of lines) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof obj !== "object" || obj === null) continue;
    const o = obj as Record<string, unknown>;
    // Cursor's --output-json schema (as of 2026-05): final summary
    // object carries `tokensUsed: number` OR `usage.totalTokens: number`.
    if (typeof o.tokensUsed === "number" && Number.isFinite(o.tokensUsed)) {
      total = o.tokensUsed;
      continue;
    }
    if (
      typeof o.usage === "object" &&
      o.usage !== null &&
      typeof (o.usage as Record<string, unknown>).totalTokens === "number"
    ) {
      const n = (o.usage as Record<string, unknown>).totalTokens;
      if (typeof n === "number" && Number.isFinite(n)) total = n;
    }
  }
  return total;
}

async function defaultComputePatch(cwd: string): Promise<GitPatch> {
  // Production path: shell `git diff` + `git status -s`. Both are
  // bounded to the cwd. The recipe's verify step enforces the file
  // allowlist on the patch's diff content.
  const diffResult = await spawn({
    cmd: "git",
    argv: ["diff"],
    cwd,
    timeoutMs: 30_000,
    expectExitCode: "any",
  }).catch((e) => {
    return { exitCode: -1, stdout: "", stderr: String(e) } as SpawnResult;
  });
  const statusResult = await spawn({
    cmd: "git",
    argv: ["status", "-s"],
    cwd,
    timeoutMs: 30_000,
    expectExitCode: "any",
  }).catch((e) => {
    return { exitCode: -1, stdout: "", stderr: String(e) } as SpawnResult;
  });
  const files: string[] = [];
  if (statusResult.exitCode === 0) {
    for (const line of statusResult.stdout.split("\n")) {
      if (line.length === 0) continue;
      // `git status -s` output: 2-char status + space + path. Trim
      // both columns; rename lines have the form ` ?? old -> new` —
      // we surface the new path.
      const trimmed = line.slice(3).trim();
      const arrowIdx = trimmed.indexOf(" -> ");
      files.push(arrowIdx >= 0 ? trimmed.slice(arrowIdx + 4) : trimmed);
    }
  }
  return {
    diff: diffResult.exitCode === 0 ? diffResult.stdout : "",
    files,
  };
}

async function writeSessionLog(
  logPath: string,
  job: CursorJob,
  result: CursorInvokeResult,
): Promise<void> {
  const lines: string[] = [
    `=== cursor self-heal session log ===`,
    `prompt:`,
    job.prompt,
    `--- result ---`,
    `exitCode: ${result.exitCode}`,
    `tokensUsed: ${result.tokensUsed} (cap: ${job.tokenCap})`,
    `durationMs: ${result.durationMs}`,
    `--- stdout ---`,
    result.stdout,
    `--- stderr ---`,
    result.stderr,
    `--- patch ---`,
    result.patch.diff,
    `--- files touched ---`,
    result.patch.files.join("\n"),
    "",
  ];
  // Best-effort: don't propagate log-write failures to the caller.
  try {
    await ensureDir(dirnameOf(logPath));
    await appendText(logPath, `${lines.join("\n")}\n`);
  } catch {
    // Best-effort — observability layer; never mask invokeCursor's outcome.
  }
}

function dirnameOf(p: string): string {
  // Avoid importing `path.dirname` again at top — keep this module's
  // dep surface narrow. Bun + Node give us `path` already imported
  // via the join used above; reuse:
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "." : p.slice(0, idx);
}

// Reference `join` so the bundler doesn't elide the `node:path` import
// when this module is consumed without the default `defaultComputePatch`
// path (tests inject `computePatch`); we keep the import for callers
// that DO use the default.
void join;
