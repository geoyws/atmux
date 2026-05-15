// ADR-088 §Decision-4 W3 (Task t-d78127c7) — `atmux merge-cycle` verb.
//
// Bulk-merge across every `<base>-<member>` branch in one shot. Used
// by ADR-088 Shape B (driver-fired) and by the cron template (W7).
// Composes on top of the W1 primitive (`mergeMember`) — the per-branch
// safety guards live there, not here.
//
// Flow per-cycle:
//
//   1. `git -C <repoPath> fetch origin` (once; subsequent W1 primitive
//      calls pass `fetch: false` to skip the redundant network round-
//      trip).
//   2. `git -C <repoPath> branch --list "<base>-*"` — enumerate
//      candidates.
//   3. For each candidate:
//      a. Compute commits-ahead via `git rev-list --count
//         <base>..<wtBranch>` — skip with `no-op` marker if 0 (this
//         filter happens before the primitive call to avoid a
//         status-check spin on every cycle).
//      b. If `--dry-run`: record what would merge; no git mutation.
//      c. Otherwise: call W1 primitive (with `fetch: false`). Outcome
//         either `merged` (continue) or `MergeConflictError` (record +
//         flag + continue — per ADR-088 §Decision-4: "On conflict
//         per-branch: continue iteration (don't abort the whole
//         cycle)").
//   4. After iteration: print summary `{ merged: [...], noOp: [...],
//      conflicts: [...] }` and (when `--push`) attempt one push of
//      `<base>` to origin AT THE END (single push regardless of how
//      many merges landed — saves origin network on multi-member
//      cycles; ADR-088 §OQ-3 default "per-merge" was overridden here
//      for cycle mode since the cycle is the atomic unit).
//
// Exit codes:
//   - `0` if every candidate either merged cleanly OR was a no-op OR
//     was dry-run-only.
//   - `1` if ANY candidate conflicted (the conflict count is
//     summarized).
//   - `1` if `--push` succeeded merges but the push itself failed.

import { join } from "node:path";
import {
  defaultGitSpawn,
  type GitSpawn,
  MergeConflictError,
  type MergeMemberResult,
  mergeMember as primitiveMergeMember,
} from "../abstractions/branch-merge.ts";
import { appendText } from "../abstractions/fs.ts";
import { isPushAllowed } from "../core/auto-push.ts";
import { getAtmuxDir, type ResolveDirOpts, requireTeam } from "../core/common.ts";
import { resolveMergerConfig } from "../core/merger-config.ts";
import { ConfigError, UsageError } from "../errors.ts";

const USAGE = "atmux merge-cycle [--push] [--dry-run] [--team-dir <dir>]";

// ---------- Parser ----------

export interface ParsedMergeCycleArgs {
  push: boolean;
  dryRun: boolean;
  teamDir?: string;
}

export function parseMergeCycleArgs(argv: ReadonlyArray<string>): ParsedMergeCycleArgs {
  let push = false;
  let dryRun = false;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--push") {
      push = true;
      i += 1;
      continue;
    }
    if (a === "--dry-run") {
      dryRun = true;
      i += 1;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "merge-cycle: --team-dir requires a value",
          hint: USAGE,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({
      what: `merge-cycle: unknown arg: ${a ?? ""}`,
      hint: USAGE,
    });
  }
  if (push && dryRun) {
    throw new UsageError({
      what: "merge-cycle: --push and --dry-run are mutually exclusive",
      hint: USAGE,
    });
  }
  const out: ParsedMergeCycleArgs = { push, dryRun };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Dependency injection ----------

export interface MergeCycleDeps {
  primitive?: typeof primitiveMergeMember;
  git?: GitSpawn;
  raiseFlag?: (atmuxDir: string, body: string) => Promise<void>;
  log?: (msg: string) => void;
}

async function defaultRaiseFlag(atmuxDir: string, body: string): Promise<void> {
  const path = join(atmuxDir, "flags.md");
  await appendText(path, `- ${body}\n`);
}

function defaultLog(msg: string): void {
  process.stdout.write(msg);
}

// ---------- Public types for downstream cron consumers ----------

export interface CycleEntry {
  /** Member name extracted from `<base>-<member>` — `wtBranch.slice(base.length + 1)`. */
  member: string;
  /** Full branch name as it appears in `git branch --list`. */
  wtBranch: string;
}

export interface CycleSummary {
  merged: Array<{ member: string; wtBranch: string; sha: string }>;
  noOp: Array<{ member: string; wtBranch: string }>;
  conflicts: Array<{ member: string; wtBranch: string; conflictPaths: ReadonlyArray<string> }>;
  /** Dry-run-only — populated when `--dry-run` listed prospective merges. */
  wouldMerge: Array<{ member: string; wtBranch: string; commitsAhead: number }>;
}

// ---------- Branch enumeration ----------

/** Parse `git branch --list <base>-*` porcelain output into member names.
 *  Each line is either `  <branch>` or `* <branch>`; we strip the
 *  leading 2 chars + trim, then check the `<base>-` prefix. Returned
 *  entries are in the order git emitted (which is alphabetical for
 *  --list). Exported for unit testing. */
export function parseBranchList(rawOut: string, base: string): CycleEntry[] {
  const prefix = `${base}-`;
  const out: CycleEntry[] = [];
  for (const line of rawOut.split("\n")) {
    if (line.length < 2) continue;
    // git branch output: "* <branch>" or "  <branch>"
    const wtBranch = line.slice(2).trim();
    if (wtBranch.length === 0) continue;
    if (!wtBranch.startsWith(prefix)) continue;
    if (wtBranch === base) continue; // defensive
    const member = wtBranch.slice(prefix.length);
    if (member.length === 0) continue; // skip bare "<base>-"
    out.push({ member, wtBranch });
  }
  return out;
}

/** Count commits on `wtBranch` not on `base`. Reused by both the
 *  per-candidate pre-filter (skip 0-ahead branches before primitive
 *  call) and the dry-run reporter. Exported for unit testing. */
async function countCommitsAhead(
  git: GitSpawn,
  repoPath: string,
  base: string,
  wtBranch: string,
): Promise<number> {
  const r = await git(["-C", repoPath, "rev-list", "--count", `${base}..${wtBranch}`]);
  if (r.exitCode !== 0) {
    throw new ConfigError({
      what: `merge-cycle: 'git rev-list --count ${base}..${wtBranch}' failed (exit ${r.exitCode}): ${r.stderr.trim()}`,
    });
  }
  return Number.parseInt(r.stdout.trim(), 10);
}

// ---------- Verb entry ----------

export async function mergeCycle(
  argv: ReadonlyArray<string>,
  deps: MergeCycleDeps = {},
): Promise<number> {
  const parsed = parseMergeCycleArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);
  const repoPath = atmuxDir.replace(/\/?\.atmux\/?$/, "") || "/";

  const primitive = deps.primitive ?? primitiveMergeMember;
  const git = deps.git ?? defaultGitSpawn;
  const raiseFlag = deps.raiseFlag ?? defaultRaiseFlag;
  const log = deps.log ?? defaultLog;

  const merger = await resolveMergerConfig(team, repoPath, { git });
  const base = merger.baseBranch;

  // Step 1: fetch once. Tests pass a git mock that handles this; we
  // never skip the fetch even on --dry-run (no mutation, just network)
  // because the rev-list count would be stale otherwise.
  const fr = await git(["-C", repoPath, "fetch", "origin"]);
  if (fr.exitCode !== 0) {
    throw new ConfigError({
      what: `merge-cycle: 'git fetch origin' failed (exit ${fr.exitCode}): ${fr.stderr.trim()}`,
    });
  }

  // Step 2: list candidate branches.
  const br = await git(["-C", repoPath, "branch", "--list", `${base}-*`]);
  if (br.exitCode !== 0) {
    throw new ConfigError({
      what: `merge-cycle: 'git branch --list ${base}-*' failed (exit ${br.exitCode}): ${br.stderr.trim()}`,
    });
  }
  const candidates = parseBranchList(br.stdout, base);

  const summary: CycleSummary = {
    merged: [],
    noOp: [],
    conflicts: [],
    wouldMerge: [],
  };

  // Step 3: iterate, pre-filter on commits-ahead, primitive call per
  // surviving candidate.
  for (const { member, wtBranch } of candidates) {
    const ahead = await countCommitsAhead(git, repoPath, base, wtBranch);
    if (ahead === 0) {
      summary.noOp.push({ member, wtBranch });
      continue;
    }

    if (parsed.dryRun) {
      summary.wouldMerge.push({ member, wtBranch, commitsAhead: ahead });
      continue;
    }

    let result: MergeMemberResult;
    try {
      // fetch: false — we already fetched once at step 1.
      result = await primitive(base, wtBranch, repoPath, { git, fetch: false });
    } catch (e) {
      if (e instanceof MergeConflictError) {
        summary.conflicts.push({
          member,
          wtBranch,
          conflictPaths: e.conflictPaths,
        });
        const paths = e.conflictPaths.length > 0 ? e.conflictPaths.join(",") : "<unknown>";
        await raiseFlag(
          atmuxDir,
          `merger-conflict · severity=high · member=${member} · branch=${wtBranch} · paths=${paths}`,
        );
        // Per ADR-088 §Decision-4: continue iterating; one conflict
        // doesn't abort the cycle. Surface in summary + flags.
        continue;
      }
      throw e;
    }

    if (result.status === "merged") {
      summary.merged.push({ member, wtBranch, sha: result.sha });
    } else {
      // status === "no-op" — could happen if the primitive's own
      // commits-ahead recheck disagreed with ours (e.g., another
      // process merged between our pre-filter + the primitive call).
      // Race window is benign; record as no-op.
      summary.noOp.push({ member, wtBranch });
    }
  }

  // Step 4: optional push (one push at end of cycle covers all
  // merges that landed in this cycle).
  let pushOutcome: "skipped" | "refused-by-policy" | "ok" | "failed" = "skipped";
  if (parsed.push && summary.merged.length > 0 && !parsed.dryRun) {
    if (!isPushAllowed(base)) {
      pushOutcome = "refused-by-policy";
      await raiseFlag(
        atmuxDir,
        `merger-push-refused · severity=medium · base=${base} · cycle-merges=${summary.merged.length} · CLAUDE.md push-policy requires operator-manual push for staging-shaped branches`,
      );
    } else {
      const pr = await git(["-C", repoPath, "push", "origin", base]);
      if (pr.exitCode !== 0) {
        pushOutcome = "failed";
        await raiseFlag(
          atmuxDir,
          `merger-push-failed · severity=high · base=${base} · cycle-merges=${summary.merged.length} · stderr=${pr.stderr.trim()}`,
        );
      } else {
        pushOutcome = "ok";
      }
    }
  }

  // Step 5: summary log.
  renderSummary(log, base, summary, {
    dryRun: parsed.dryRun,
    push: parsed.push,
    pushOutcome,
  });

  // Exit-code resolution.
  if (summary.conflicts.length > 0) return 1;
  if (pushOutcome === "failed") return 1;
  return 0;
}

/** Render summary to the injected log fn. Exported for unit testing. */
export function renderSummary(
  log: (msg: string) => void,
  base: string,
  summary: CycleSummary,
  opts: { dryRun: boolean; push: boolean; pushOutcome: string },
): void {
  log(`merge-cycle: base=${base}\n`);
  if (opts.dryRun) {
    log(`  --dry-run: would merge ${summary.wouldMerge.length} branch(es)\n`);
    for (const w of summary.wouldMerge) {
      log(`    - ${w.wtBranch} (${w.commitsAhead} commit(s) ahead)\n`);
    }
  } else {
    log(`  merged:    ${summary.merged.length}\n`);
    for (const m of summary.merged) {
      log(`    - ${m.wtBranch} → ${m.sha}\n`);
    }
    log(`  no-op:     ${summary.noOp.length}\n`);
    for (const n of summary.noOp) {
      log(`    - ${n.wtBranch}\n`);
    }
    log(`  conflicts: ${summary.conflicts.length}\n`);
    for (const c of summary.conflicts) {
      const paths = c.conflictPaths.length > 0 ? c.conflictPaths.join(", ") : "(paths unknown)";
      log(`    - ${c.wtBranch} — ${paths}\n`);
    }
    if (opts.push) {
      log(`  push:      ${opts.pushOutcome}\n`);
    }
  }
}
