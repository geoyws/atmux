// ADR-057 §D7 R57-T7: auto-push on `atmux done` — policy + rebase +
// audit log. Wires into `src/verbs/claim.ts::done` after a successful
// kanban transition.
//
// CLAUDE.md push-policy enforcement: refuse on staging-shaped branches
// (`*-staging`, `main`, `master`, `production`) — auto-push only
// targets non-staging branches. Per-team override via
// team.json::stallPrevention.allowedPushBranches (rare; for non-standard
// branch names that look staging-shaped but aren't).
//
// Flow:
//   1. Resolve current branch via `git symbolic-ref --short HEAD`.
//   2. Check policy: refuse on staging match (audit-log "skipped-staging").
//   3. Rebase: `git fetch origin <branch> && git rebase origin/<branch>`.
//      Conflict → flag P1, abort push (audit "abort-rebase-conflict").
//   4. Push: `git push origin <branch>`. Failure → flag P3 (audit
//      "fail-push"). Success → audit "success".
//
// Audit log: `<atmuxDir>/logs/auto-push.jsonl` — append per attempt.

import { join } from "node:path";
import { appendText, ensureDir } from "../abstractions/fs.ts";
import { spawn as defaultSpawn, type SpawnResult } from "../abstractions/spawn.ts";
import { now } from "../abstractions/time.ts";
import type { TeamWhip } from "../schema/team.ts";

// ---------- Policy ----------

/** Branch-name patterns that REFUSE auto-push by default. CLAUDE.md
 *  push policy: every IFCA product staging deploy + main/master + prod
 *  are George-manual ONLY. */
export const STAGING_PATTERNS: ReadonlyArray<RegExp> = [
  /-staging$/,
  /^main$/,
  /^master$/,
  /^production$/,
];

/**
 * True when `branch` is allowed for auto-push per CLAUDE.md policy.
 *
 * `allowedOverride` is a per-team escape hatch (rare): team.json::
 * stallPrevention.allowedPushBranches. When the branch matches an
 * override entry, auto-push proceeds even if it matches a staging
 * pattern. Use sparingly — overrides defeat the safety net.
 */
export function isPushAllowed(
  branch: string,
  allowedOverride: ReadonlyArray<string> = [],
): boolean {
  if (allowedOverride.includes(branch)) return true;
  for (const re of STAGING_PATTERNS) {
    if (re.test(branch)) return false;
  }
  return true;
}

// ---------- Audit log ----------

export type AutoPushOutcome =
  | "success"
  | "skipped-staging"
  | "skipped-disabled"
  | "abort-rebase-conflict"
  | "fail-push"
  | "fail-fetch"
  | "fail-branch-resolve";

export interface AutoPushAuditEntry {
  ts: number;
  branch: string | null;
  outcome: AutoPushOutcome;
  /** Free-form detail (error message / SHA / etc). */
  detail?: string;
  /** Flag id (when a flag was raised). */
  flagId?: string;
}

export function autoPushLogPath(atmuxDir: string): string {
  return join(atmuxDir, "logs", "auto-push.jsonl");
}

export async function appendAuditEntry(atmuxDir: string, entry: AutoPushAuditEntry): Promise<void> {
  const path = autoPushLogPath(atmuxDir);
  await ensureDir(join(atmuxDir, "logs"));
  await appendText(path, `${JSON.stringify(entry)}\n`);
}

// ---------- Spawn-injected git wrappers ----------

export type GitSpawn = (argv: ReadonlyArray<string>) => Promise<SpawnResult>;

/** Default git spawner — wraps `abstractions/spawn.spawn` with `git`
 *  prefix + 30s timeout + accept-any-status (caller branches on rc). */
export const defaultGitSpawn: GitSpawn = async (argv) =>
  await defaultSpawn({
    cmd: "git",
    argv,
    timeoutMs: 30_000,
    expectExitCode: "any",
  });

/** Resolve the current branch via `git symbolic-ref --short HEAD`.
 *  Returns null on detached HEAD or git-not-a-repo. */
export async function getCurrentBranch(git: GitSpawn = defaultGitSpawn): Promise<string | null> {
  const r = await git(["symbolic-ref", "--short", "HEAD"]);
  if (r.exitCode !== 0) return null;
  const name = r.stdout.trim();
  return name.length > 0 ? name : null;
}

// ---------- Public API ----------

export interface AutoPushOpts {
  /** When false, the entire flow is a no-op (still audit-logs
   *  "skipped-disabled" so the operator can see auto-push is off). */
  enabled?: boolean;
  /** When true, fetch + rebase before pushing. Default true. */
  rebase?: boolean;
  /** Per-team allowlist override for staging-shaped branch names. */
  allowedPushBranches?: ReadonlyArray<string>;
  /** Git spawn override (test injection). */
  git?: GitSpawn;
  /** Flag-raise hook (test injection); receives severity + body. */
  raiseFlag?: (severity: "p0" | "p1" | "p2" | "p3", body: string) => Promise<{ flagId: string }>;
  /** Logger; defaults to no-op. */
  log?: (msg: string) => void;
  /** Clock override; defaults to time.now. */
  nowMs?: () => number;
}

export interface AutoPushResult {
  outcome: AutoPushOutcome;
  branch: string | null;
  detail?: string;
}

/**
 * Run the post-`atmux done` auto-push pipeline. Always returns; never
 * throws. Audit-logs every attempt. Caller doesn't gate on the result
 * — `atmux done` succeeds whether the push lands or not (per
 * §D7a "DO NOT block done transition").
 */
export async function runAutoPush(
  atmuxDir: string,
  opts: AutoPushOpts = {},
): Promise<AutoPushResult> {
  const enabled = opts.enabled ?? true;
  const rebase = opts.rebase ?? true;
  const git = opts.git ?? defaultGitSpawn;
  const log = opts.log ?? (() => {});
  const nowMs = opts.nowMs ?? now;
  const allowedOverride = opts.allowedPushBranches ?? [];

  const tsSec = (): number => Math.floor(nowMs() / 1000);

  if (!enabled) {
    const entry: AutoPushAuditEntry = {
      ts: tsSec(),
      branch: null,
      outcome: "skipped-disabled",
    };
    await appendAuditEntry(atmuxDir, entry);
    return { outcome: "skipped-disabled", branch: null };
  }

  // 1. Resolve branch.
  const branch = await getCurrentBranch(git);
  if (branch === null) {
    const detail = "could not resolve current branch (detached HEAD or not a git repo)";
    await appendAuditEntry(atmuxDir, {
      ts: tsSec(),
      branch: null,
      outcome: "fail-branch-resolve",
      detail,
    });
    log(`auto-push: ${detail}`);
    return { outcome: "fail-branch-resolve", branch: null, detail };
  }

  // 2. Policy check.
  if (!isPushAllowed(branch, allowedOverride)) {
    const detail = `branch '${branch}' matches staging policy — auto-push refused (CLAUDE.md push-policy)`;
    await appendAuditEntry(atmuxDir, {
      ts: tsSec(),
      branch,
      outcome: "skipped-staging",
      detail,
    });
    log(`auto-push: ${detail}`);
    return { outcome: "skipped-staging", branch, detail };
  }

  // 3. Pre-push rebase (if enabled).
  if (rebase) {
    const fetchR = await git(["fetch", "origin", branch]);
    if (fetchR.exitCode !== 0) {
      const detail = `git fetch origin ${branch} failed: ${fetchR.stderr.trim()}`;
      let flagId: string | undefined;
      if (opts.raiseFlag !== undefined) {
        try {
          const f = await opts.raiseFlag("p3", detail);
          flagId = f.flagId;
        } catch {
          /* best-effort */
        }
      }
      await appendAuditEntry(atmuxDir, {
        ts: tsSec(),
        branch,
        outcome: "fail-fetch",
        detail,
        ...(flagId !== undefined ? { flagId } : {}),
      });
      log(`auto-push: ${detail}`);
      return { outcome: "fail-fetch", branch, detail };
    }
    const rebaseR = await git(["rebase", `origin/${branch}`]);
    if (rebaseR.exitCode !== 0) {
      const detail = `git rebase origin/${branch} conflict: ${rebaseR.stderr.trim()}`;
      // Abort the in-flight rebase so the worktree is clean for the porter.
      await git(["rebase", "--abort"]);
      let flagId: string | undefined;
      if (opts.raiseFlag !== undefined) {
        try {
          const f = await opts.raiseFlag("p1", detail);
          flagId = f.flagId;
        } catch {
          /* best-effort */
        }
      }
      await appendAuditEntry(atmuxDir, {
        ts: tsSec(),
        branch,
        outcome: "abort-rebase-conflict",
        detail,
        ...(flagId !== undefined ? { flagId } : {}),
      });
      log(`auto-push: ${detail}`);
      return { outcome: "abort-rebase-conflict", branch, detail };
    }
  }

  // 4. Push.
  const pushR = await git(["push", "origin", branch]);
  if (pushR.exitCode !== 0) {
    const detail = `git push origin ${branch} failed: ${pushR.stderr.trim()}`;
    let flagId: string | undefined;
    if (opts.raiseFlag !== undefined) {
      try {
        const f = await opts.raiseFlag("p3", detail);
        flagId = f.flagId;
      } catch {
        /* best-effort */
      }
    }
    await appendAuditEntry(atmuxDir, {
      ts: tsSec(),
      branch,
      outcome: "fail-push",
      detail,
      ...(flagId !== undefined ? { flagId } : {}),
    });
    log(`auto-push: ${detail}`);
    return { outcome: "fail-push", branch, detail };
  }

  await appendAuditEntry(atmuxDir, {
    ts: tsSec(),
    branch,
    outcome: "success",
  });
  log(`auto-push: pushed ${branch} → origin successfully`);
  return { outcome: "success", branch };
}

// ---------- team.json config reader ----------

/**
 * Read auto-push opts from `team.json::whip.stallPrevention`. Reads the
 * typed TeamWhip shape directly per ADR-057 schema promotion
 * (t-fbfb02f8) — pre-promotion this site cast `team.whip as { ... }`
 * because the stallPrevention block lived as a defensive shape; the
 * Zod schema now enforces field-level types + .strict() typo rejection
 * at boot, so the call-site simplifies to typed reads + null-coalescing
 * defaults that match the schema's own field-level defaults.
 *
 * Pre-promotion fixtures that passed mixed-type arrays (e.g. `[42, null,
 * "main"]`) are no longer possible — the Zod array-of-string rejects
 * such values at parse time, surfacing via the existing
 * whip-config-drift Discord ping.
 */
export function readAutoPushOptsFromTeam(team: { whip?: TeamWhip | undefined }): {
  enabled: boolean;
  rebase: boolean;
  allowedPushBranches: string[];
} {
  const sp = team.whip?.stallPrevention;
  return {
    enabled: sp?.autoPushOnDone ?? true,
    rebase: sp?.rebaseBeforePush ?? true,
    allowedPushBranches: sp?.allowedPushBranches ?? [],
  };
}
