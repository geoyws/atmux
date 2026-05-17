// ADR-083: Host crontab DI seam.
//
// The ONLY module that shells `crontab -l` / `crontab <file>`. Verbs +
// core/cron.ts consume the `CrontabIO` interface so unit tests can drop
// in an in-memory pair without touching the operator's real crontab.
//
// Reads return `null` for "no crontab installed yet" (errno 1 from
// `crontab -l` with the canonical "no crontab for <user>" message);
// callers treat that identically to an empty crontab. `available()`
// gates non-fatal posture per ADR-083 §IN — when crontab isn't on PATH
// the install verb logs a warning and exits 0 without raising.
//
// Writes go through mktemp + `crontab <tmpfile>` so `crontab -l` never
// observes a torn state. The tmp file is cleaned on either success or
// failure (best-effort) — bash equivalent at lib/cron.sh:267-274.

import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as defaultSpawn } from "./spawn.ts";

/** DI surface — tests inject a fake to avoid touching the host crontab.
 *  Default impl is `defaultCrontabIO()`. */
export interface CrontabIO {
  /** `crontab -l`. Resolves to `null` when the user has no crontab
   *  (errno 1 "no crontab for <user>"). Other shell errors also resolve
   *  to `null` — install treats unreadable identically to empty; the
   *  strip passes are no-ops + the new block is appended fresh. */
  read(): Promise<string | null>;
  /** Atomic swap: write `body` to a temp file, run `crontab <tmpfile>`,
   *  unlink the temp file. Throws when the swap subprocess exits
   *  non-zero — callers in non-fatal contexts wrap this in try/catch. */
  write(body: string): Promise<void>;
  /** True iff `crontab` is on PATH. Resolves to `false` on any spawn
   *  error so the install verb can gracefully skip on hosts without
   *  cron. */
  available(): Promise<boolean>;
}

/** Default production implementation — shells out via the centralized
 *  `spawn()` primitive (per ADR-007, the ONLY module besides
 *  `src/abstractions/spawn.ts` itself allowed to invoke subprocesses). */
export function defaultCrontabIO(): CrontabIO {
  return {
    read: defaultRead,
    write: defaultWrite,
    available: defaultAvailable,
  };
}

async function defaultRead(): Promise<string | null> {
  try {
    const r = await defaultSpawn({
      cmd: "crontab",
      argv: ["-l"],
      timeoutMs: 5_000,
      expectExitCode: "any",
    });
    if (r.exitCode !== 0) return null;
    return r.stdout;
  } catch {
    return null;
  }
}

async function defaultWrite(body: string): Promise<void> {
  const rand = Math.random().toString(36).slice(2, 10);
  const tmp = join(tmpdir(), `atmux-cron-${process.pid}-${rand}`);
  try {
    await writeFile(tmp, body, { mode: 0o600 });
    await defaultSpawn({
      cmd: "crontab",
      argv: [tmp],
      timeoutMs: 5_000,
      expectExitCode: 0,
    });
  } finally {
    await unlink(tmp).catch(() => {
      /* best-effort cleanup; tmp may be gone if /tmp was swept mid-op */
    });
  }
}

async function defaultAvailable(): Promise<boolean> {
  try {
    const r = await defaultSpawn({
      cmd: "command",
      argv: ["-v", "crontab"],
      timeoutMs: 2_000,
      expectExitCode: "any",
    });
    return r.exitCode === 0 && r.stdout.trim().length > 0;
  } catch {
    // `command -v` runs as a shell builtin on some hosts; if invoking
    // it as a standalone fails (no `command` on PATH outside the
    // shell), fall back to a direct `crontab --version`-style probe.
    try {
      const r = await defaultSpawn({
        cmd: "crontab",
        argv: ["-l"],
        timeoutMs: 2_000,
        expectExitCode: "any",
      });
      // exit 0 = has crontab; exit 1 = "no crontab for user" (binary
      // exists). Anything else (e.g. spawn ENOENT thrown above) = no
      // crontab binary at all.
      return r.exitCode === 0 || r.exitCode === 1;
    } catch {
      return false;
    }
  }
}
