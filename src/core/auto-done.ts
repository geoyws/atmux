// ADR-080 §B1: auto-done detection helper.
//
// `findCommitForTask` scans `repoDir`'s git history for a commit whose
// message references `taskId` and that landed since `sinceMs`. Returns
// the SHA on match; null on miss. Wired by §B2 (lane-tick poll) to
// back-fill `atmux done` for gitter tasks whose commit landed but
// never closed the kanban entry (operator-observed sopx-driver pain:
// 29 stale `commit t-X` tasks at 07:14 MYT 2026-05-09).
//
// Per OQ-2 (lead ack): lane-tick poll first; post-commit hook variant
// deferred to ADR-069 (auto-routing protocol). This module is the
// helper only — caller (§B2) handles enumeration + idempotence + the
// `atmux done` transition.
//
// Spawn injection follows the auto-push.ts pattern: `GitSpawn` type +
// `defaultGitSpawn` reusable across helpers; tests pass mocks.

import { statOrNull } from "../abstractions/fs.ts";
import { spawn as defaultSpawn, type SpawnResult } from "../abstractions/spawn.ts";
import { ConfigError } from "../errors.ts";

// ---------- Spawn-injected git wrapper ----------

export type GitSpawn = (argv: ReadonlyArray<string>) => Promise<SpawnResult>;

/** Default git spawner — wraps `abstractions/spawn.spawn` with `git`
 *  prefix + 30s timeout + accept-any-status (caller branches on rc).
 *  Mirrors `auto-push.ts::defaultGitSpawn` to keep the two helpers
 *  symmetric (one closes kanban, the other pushes after close). */
export const defaultGitSpawn: GitSpawn = async (argv) =>
  await defaultSpawn({
    cmd: "git",
    argv,
    timeoutMs: 30_000,
    expectExitCode: "any",
  });

// ---------- Public API ----------

export interface FindCommitOpts {
  /** Git spawn override (test injection). */
  git?: GitSpawn;
}

/**
 * Find a commit in `repoDir` whose message references `taskId`,
 * landed since `sinceMs`. Returns the full SHA on match; null on miss.
 *
 * `taskId` is interpreted as a literal substring (passed via
 * `--grep=`); git treats `--grep` patterns as POSIX BREs by default,
 * but for typical task ids (`t-<8-hex>`) the BRE interpretation is
 * effectively literal — no escaping needed at the call site.
 *
 * Throws ConfigError when `repoDir` doesn't exist, isn't a directory,
 * or isn't a git repository (`git log` exit != 0).
 */
export async function findCommitForTask(
  repoDir: string,
  taskId: string,
  sinceMs: number,
  opts: FindCommitOpts = {},
): Promise<string | null> {
  const git = opts.git ?? defaultGitSpawn;

  // Pre-flight: repoDir must exist + be a directory. Caught here so
  // the operator gets a precise error message rather than git's
  // generic "fatal: could not change directory" fallback.
  const s = await statOrNull(repoDir);
  if (s === null || !s.isDirectory) {
    throw new ConfigError({
      what: `findCommitForTask: repoDir does not exist or is not a directory: ${repoDir}`,
      hint: "ensure team.gitter.repoPath points to an existing git repository",
    });
  }

  // git -C <repoDir> log --grep=<taskId> --since=<iso> -1 --format=%H
  const isoSince = new Date(sinceMs).toISOString();
  const r = await git([
    "-C",
    repoDir,
    "log",
    `--grep=${taskId}`,
    `--since=${isoSince}`,
    "-1",
    "--format=%H",
  ]);
  if (r.exitCode !== 0) {
    throw new ConfigError({
      what: `findCommitForTask: git log failed in ${repoDir}: ${r.stderr.trim() || `exit ${r.exitCode}`}`,
      hint: "ensure repoDir is a git repository (git rev-parse --git-dir succeeds)",
    });
  }
  const sha = r.stdout.trim();
  if (sha.length === 0) return null;
  return sha;
}
