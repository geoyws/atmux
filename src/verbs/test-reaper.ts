// ADR-301 (implements ADR-178 T3): reap stale tmux servers left behind by killed test processes.
// SAFETY invariant (ADR-301 §D1): act only on a direct tmpdir child matching the spinTmux
// prefix pattern whose parseable sidecar's socketDir equals its own dir; never follow symlinks.
// ADR-305 §D2: act only on a directory that is OURS alone (owned by this uid, no group/other
// bit, reached through a chain no other uid can rewrite — `privateDirIssue`, a descriptor
// walk); the kill-server dial runs the connect-time guard right before it spawns, so a
// planted `sock` symlink or another uid's socket is never dialled; and the removal re-walks
// the directory and removes it relative to the held parent descriptor (`removePrivateTree`,
// ADR-305 revision 4). Anything else is `unsafe-skipped`, never touched.
import { spawnSync } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  prepareSocketDial,
  privateDirIssue,
  removePrivateTree,
  type SocketPathIssue,
  socketPathIssue,
  UnsafeSocketPathError,
} from "../core/socket-dir.ts";
import { UsageError } from "../errors.ts";

const SIDECAR = ".leak-tracker.json";
const USAGE = "atmux test-reaper [--max-age-min N] [--dry-run] [--prefix P] [--json]";

export type ReaperStatus =
  | "would-reap"
  | "reaped"
  | "too-young"
  | "parent-alive"
  | "missing-sidecar"
  | "corrupt-sidecar"
  | "symlink-skipped"
  | "unsafe-skipped";

export interface ReaperResult {
  socketDir: string;
  status: ReaperStatus;
}

interface LeakTracker {
  tmuxSocket: string;
  socketDir: string;
  parentPid: number;
  createdAt: number;
}

export interface TestReaperDeps {
  tmpDir?: string;
  nowSeconds?: () => number;
  parentIsDead?: (pid: number) => boolean;
  killServer?: (socket: string) => void | Promise<void>;
  removeDir?: (dir: string) => void | Promise<void>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

interface ParsedArgs {
  maxAgeMin: number;
  dryRun: boolean;
  prefix: string;
  json: boolean;
}

export function parseTestReaperArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const parsed: ParsedArgs = {
    maxAgeMin: 30,
    dryRun: false,
    prefix: "atmux-cockpit",
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--max-age-min" || arg?.startsWith("--max-age-min=")) {
      const value = arg === "--max-age-min" ? argv[++i] : arg.slice("--max-age-min=".length);
      const number = Number(value);
      if (value === undefined || value === "" || !Number.isFinite(number) || number < 0) {
        throw usage("--max-age-min requires a non-negative number");
      }
      parsed.maxAgeMin = number;
    } else if (arg === "--prefix" || arg?.startsWith("--prefix=")) {
      const value = arg === "--prefix" ? argv[++i] : arg.slice("--prefix=".length);
      if (value === undefined || !/^[A-Za-z0-9._-]+$/.test(value)) {
        throw usage("--prefix requires a non-empty filename prefix");
      }
      parsed.prefix = value;
    } else {
      throw usage(`unknown argument: ${arg ?? ""}`);
    }
  }

  return parsed;
}

export async function testReaper(
  argv: ReadonlyArray<string>,
  deps: TestReaperDeps = {},
): Promise<number> {
  const flags = parseTestReaperArgs(argv);
  const root = resolve(deps.tmpDir ?? tmpdir());
  const now = (deps.nowSeconds ?? (() => Date.now() / 1000))();
  const cutoff = now - flags.maxAgeMin * 60;
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const parentIsDead = deps.parentIsDead ?? defaultParentIsDead;
  const killServer = deps.killServer ?? defaultKillServer;
  const removeDir = deps.removeDir ?? removeOwnedDir;
  const results: ReaperResult[] = [];

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!matchesPrefix(entry.name, flags.prefix)) continue;
    const candidateDir = resolve(root, entry.name);
    // ADR-301 §D1(d): never follow symlinks — check first, because a symlink
    // to a dir reports isDirectory() false and would otherwise slip past
    // silently. lstat (no follow) also catches a link swapped in after
    // readdir. Symlinks are warned on and skipped: no sidecar read, no rm.
    if (entry.isSymbolicLink() || (await lstat(candidateDir)).isSymbolicLink()) {
      results.push({ socketDir: candidateDir, status: "symlink-skipped" });
      stderr(`test-reaper: warning: ${entry.name}: symlink-skipped\n`);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const sidecarPath = resolve(candidateDir, SIDECAR);
    let tracker: LeakTracker;
    try {
      const decoded: unknown = JSON.parse(await readFile(sidecarPath, "utf8"));
      if (!isLeakTracker(decoded, candidateDir)) throw new Error("invalid sidecar shape");
      tracker = decoded;
    } catch (error) {
      const missing = isMissingFile(error);
      const status: ReaperStatus = missing ? "missing-sidecar" : "corrupt-sidecar";
      results.push({ socketDir: candidateDir, status });
      stderr(`test-reaper: warning: ${entry.name}: ${status}\n`);
      continue;
    }

    if (tracker.createdAt >= cutoff) {
      results.push({ socketDir: candidateDir, status: "too-young" });
      continue;
    }
    if (!parentIsDead(tracker.parentPid)) {
      results.push({ socketDir: candidateDir, status: "parent-alive" });
      continue;
    }
    // ADR-305: another uid's directory, a shared one, or a planted `sock`
    // symlink / foreign socket is reported and left alone — in a dry run too.
    const unsafe = privateDirIssue(candidateDir) ?? socketPathIssue(tracker.tmuxSocket);
    if (unsafe !== null) {
      results.push(unsafeSkipped(candidateDir, entry.name, unsafe, stderr));
      continue;
    }
    if (flags.dryRun) {
      results.push({ socketDir: candidateDir, status: "would-reap" });
      continue;
    }

    try {
      await killServer(tracker.tmuxSocket);
      await removeDir(candidateDir);
    } catch (error) {
      // The guards re-check right before the dial and the removal; a
      // directory swapped after the check above lands here.
      if (!(error instanceof UnsafeSocketPathError)) throw error;
      results.push(unsafeSkipped(candidateDir, entry.name, error.issue, stderr));
      continue;
    }
    results.push({ socketDir: candidateDir, status: "reaped" });
  }

  if (flags.json) {
    stdout(`${JSON.stringify({ dryRun: flags.dryRun, results })}\n`);
  } else {
    for (const result of results) {
      if (result.status === "would-reap" || result.status === "reaped") {
        stdout(`${result.status}\t${result.socketDir}\n`);
      }
    }
  }
  return 0;
}

function unsafeSkipped(
  socketDir: string,
  name: string,
  issue: SocketPathIssue,
  stderr: (text: string) => void,
): ReaperResult {
  stderr(`test-reaper: warning: ${name}: unsafe-skipped (${issue.path} ${issue.detail})\n`);
  return { socketDir, status: "unsafe-skipped" };
}

function usage(what: string): UsageError {
  return new UsageError({ what: `test-reaper: ${what}`, hint: USAGE });
}

function matchesPrefix(name: string, prefix: string): boolean {
  const suffix = name.slice(prefix.length + 1);
  return (
    name.startsWith(`${prefix}-`) &&
    suffix.includes("-") &&
    !suffix.startsWith("-") &&
    !suffix.endsWith("-")
  );
}

function isLeakTracker(value: unknown, candidateDir: string): value is LeakTracker {
  if (typeof value !== "object" || value === null) return false;
  const tracker = value as Record<string, unknown>;
  return (
    typeof tracker.tmuxSocket === "string" &&
    tracker.tmuxSocket.length > 0 &&
    // ADR-301 D1: the kill target must live inside the dir being reaped, so a
    // planted sidecar can never aim kill-server at a cockpit or cage socket.
    dirname(resolve(tracker.tmuxSocket)) === candidateDir &&
    tracker.socketDir === candidateDir &&
    Number.isSafeInteger(tracker.parentPid) &&
    (tracker.parentPid as number) > 0 &&
    typeof tracker.createdAt === "number" &&
    Number.isFinite(tracker.createdAt)
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function defaultParentIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return isEsrch(error);
  }

  const command = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  if (command.status !== 0 || command.error) return false;
  return !/\bbun(?:\s+run)?\s+test\b/.test(command.stdout);
}

function isEsrch(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ESRCH"
  );
}

/** kill-server through the ADR-305 connect-time guard, run right before
 *  the dial: an unsafe path throws {@link UnsafeSocketPathError}; no
 *  socket of ours there means nothing to kill. */
function defaultKillServer(socket: string): void {
  if (!prepareSocketDial(socket)) return;
  const env = { ...process.env };
  delete env.TMUX;
  spawnSync("tmux", ["-S", socket, "kill-server"], { env, stdio: "ignore" });
}

/** Remove a reaped directory only when a descriptor walk, run right
 *  before the removal, shows it is ours alone; the removal runs relative
 *  to the parent descriptor that walk holds, so no rename after the
 *  check can redirect it. Throws {@link UnsafeSocketPathError}. */
async function removeOwnedDir(dir: string): Promise<void> {
  removePrivateTree(dir);
}
