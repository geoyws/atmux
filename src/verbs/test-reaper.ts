// ADR-178: reap stale tmux servers left behind by killed test processes.

import { spawnSync } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { UsageError } from "../errors.ts";

const SIDECAR = ".leak-tracker.json";
const USAGE =
  "atmux test-reaper [--max-age-min N] [--dry-run] [--prefix P] [--json]";

export type ReaperStatus =
  | "would-reap"
  | "reaped"
  | "too-young"
  | "parent-alive"
  | "missing-sidecar"
  | "corrupt-sidecar";

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
  const removeDir = deps.removeDir ?? ((dir: string) => rm(dir, { recursive: true, force: true }));
  const results: ReaperResult[] = [];

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !matchesPrefix(entry.name, flags.prefix)) continue;

    const candidateDir = resolve(root, entry.name);
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
    if (flags.dryRun) {
      results.push({ socketDir: candidateDir, status: "would-reap" });
      continue;
    }

    await killServer(tracker.tmuxSocket);
    await removeDir(candidateDir);
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

function usage(what: string): UsageError {
  return new UsageError({ what: `test-reaper: ${what}`, hint: USAGE });
}

function matchesPrefix(name: string, prefix: string): boolean {
  const suffix = name.slice(prefix.length + 1);
  return name.startsWith(`${prefix}-`) && suffix.includes("-") && !suffix.startsWith("-") && !suffix.endsWith("-");
}

function isLeakTracker(value: unknown, candidateDir: string): value is LeakTracker {
  if (typeof value !== "object" || value === null) return false;
  const tracker = value as Record<string, unknown>;
  return (
    typeof tracker.tmuxSocket === "string" &&
    tracker.tmuxSocket.length > 0 &&
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

function defaultKillServer(socket: string): void {
  const env = { ...process.env };
  delete env.TMUX;
  spawnSync("tmux", ["-S", socket, "kill-server"], { env, stdio: "ignore" });
}
