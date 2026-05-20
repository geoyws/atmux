// ADR-179 §Decision-3 W2 (Task t-e7724527) — `atmux merge-member` verb.
//
// Wraps the W1 primitive (`abstractions/branch-merge.ts::mergeMember`)
// with the policy + surfacing layer:
//
//   1. Team resolution — `requireTeam(...)`.
//   2. Effective merger config — `resolveMergerConfig(team, repoPath)`
//      resolves `baseBranch` (either `team.merger.baseBranch` or the
//      parent worktree's current HEAD).
//   3. wtBranch derivation — `${baseBranch}-${sanitizeBranchSegment(member)}`.
//   4. W1 primitive call.
//   5. Outcome handling:
//      - `merged` + `--push` → `guardPushTarget` (CLAUDE.md push-policy
//        gate on `<product>-staging`-shape branches) → if allowed,
//        `git push origin <base>`; if refused, raise flag + still exit
//        0 (the merge succeeded; deferred push is not a verb failure).
//      - `no-op` → success exit + informational stdout.
//      - `MergeConflictError` → raise flag with severity-high context +
//        non-zero exit (1).
//
// Push policy: reuses `isPushAllowed` from `src/core/auto-push.ts` so
// the single set of staging-pattern regexes (`-staging$`, `^main$`,
// `^master$`, `^production$`) governs both `atmux done` auto-push +
// merger fan-in push. Refusal is logged + flagged; the merge itself
// stays committed locally (operator can `scripts/push-staging.sh
// staging` manually).
//
// Flag surface: `<atmuxDir>/flags.md` via the same one-line markdown
// bullet convention `lane-drift-check.ts` uses. ADR-179 W5/W6 will
// upgrade these into Discord pings once the flag verb has structured
// severity routing.

import { join } from "node:path";
import {
  defaultGitSpawn,
  type GitSpawn,
  MergeConflictError,
  type MergeMemberResult,
  mergeMember as primitiveMergeMember,
} from "../abstractions/branch-merge.ts";
import { appendText } from "../abstractions/fs.ts";
import { sanitizeBranchSegment } from "../abstractions/worktree.ts";
import { isPushAllowed } from "../core/auto-push.ts";
import { getAtmuxDir, type ResolveDirOpts, requireTeam } from "../core/common.ts";
import { resolveMergerConfig } from "../core/merger-config.ts";
import { UsageError } from "../errors.ts";

const USAGE = "atmux merge-member <member> [--push] [--team-dir <dir>]";

// ---------- Parser ----------

export interface ParsedMergeMemberArgs {
  member: string;
  push: boolean;
  teamDir?: string;
}

export function parseMergeMemberArgs(argv: ReadonlyArray<string>): ParsedMergeMemberArgs {
  let member: string | undefined;
  let push = false;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--push") {
      push = true;
      i += 1;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "merge-member: --team-dir requires a value",
          hint: USAGE,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a !== undefined && a.startsWith("-")) {
      throw new UsageError({
        what: `merge-member: unknown flag: ${a}`,
        hint: USAGE,
      });
    }
    if (member !== undefined) {
      throw new UsageError({
        what: "merge-member: only one <member> positional accepted",
        hint: USAGE,
      });
    }
    member = a ?? "";
    i += 1;
  }
  if (member === undefined || member.length === 0) {
    throw new UsageError({
      what: "merge-member: <member> argument is required",
      hint: USAGE,
    });
  }
  const out: ParsedMergeMemberArgs = { member, push };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Dependency injection ----------

export interface MergeMemberDeps {
  /** Override the W1 primitive — defaults to the real `mergeMember`. */
  primitive?: typeof primitiveMergeMember;
  /** Override git spawn — defaults to `defaultGitSpawn`. Used for the
   *  `resolveMergerConfig` branch-detect call + the post-merge push. */
  git?: GitSpawn;
  /** Override flag-raise — defaults to appendText against
   *  `<atmuxDir>/flags.md`. */
  raiseFlag?: (atmuxDir: string, body: string) => Promise<void>;
  /** Override stdout writer — defaults to `process.stdout.write`. */
  log?: (msg: string) => void;
}

/** Default flag-raise — append a one-line markdown bullet to
 *  `<atmuxDir>/flags.md`. Mirrors the convention at
 *  `lane-drift-check.ts::defaultRaiseFlag`. */
async function defaultRaiseFlag(atmuxDir: string, body: string): Promise<void> {
  const path = join(atmuxDir, "flags.md");
  await appendText(path, `- ${body}\n`);
}

function defaultLog(msg: string): void {
  process.stdout.write(msg);
}

// ---------- Verb entry ----------

/**
 * `atmux merge-member <member> [--push] [--team-dir <dir>]`.
 *
 * Exit-code contract:
 *   - `0` on merge success (with or without `--push`)
 *   - `0` on no-op (no commits ahead)
 *   - `0` on `--push` refused by policy (merge stays local; flag raised)
 *   - `1` on conflict (flag raised; merge already aborted by W1)
 *   - `1` on push failure (network / authn; flag raised)
 *
 * The "merge succeeded but push refused = exit 0" choice reflects the
 * CLAUDE.md push-policy contract: the operator is the one allowed to
 * push `<product>-staging`, so merger refusing the push is the
 * INTENDED safe behavior — not a verb failure. The flag surfaces the
 * pending push for the operator's manual follow-up.
 */
export async function mergeMember(
  argv: ReadonlyArray<string>,
  deps: MergeMemberDeps = {},
): Promise<number> {
  const parsed = parseMergeMemberArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);
  // `atmuxDir` is `<projectRoot>/.atmux`; strip the trailing segment to
  // get the repoPath the merger operates against. Mirrors the
  // `resolveWorktreePath` precedent in `abstractions/worktree.ts`.
  const repoPath = atmuxDir.replace(/\/?\.atmux\/?$/, "") || "/";

  const primitive = deps.primitive ?? primitiveMergeMember;
  const git = deps.git ?? defaultGitSpawn;
  const raiseFlag = deps.raiseFlag ?? defaultRaiseFlag;
  const log = deps.log ?? defaultLog;

  const merger = await resolveMergerConfig(team, repoPath, { git });
  const wtBranch = `${merger.baseBranch}-${sanitizeBranchSegment(parsed.member)}`;

  let result: MergeMemberResult;
  try {
    result = await primitive(merger.baseBranch, wtBranch, repoPath, { git });
  } catch (e) {
    if (e instanceof MergeConflictError) {
      const paths = e.conflictPaths.length > 0 ? e.conflictPaths.join(",") : "<unknown>";
      const body = `merger-conflict · severity=high · member=${parsed.member} · branch=${wtBranch} · paths=${paths}`;
      await raiseFlag(atmuxDir, body);
      log(
        `merge-member: conflict on ${wtBranch} — flag raised; paths: ${e.conflictPaths.join(", ") || "(unknown)"}\n`,
      );
      return 1;
    }
    throw e;
  }

  if (result.status === "no-op") {
    log(
      `merge-member: no-op — ${parsed.member} (${wtBranch}) has no commits ahead of ${merger.baseBranch}\n`,
    );
    return 0;
  }

  // status === "merged"
  log(`merge-member: merged ${wtBranch} → ${merger.baseBranch} at ${result.sha}\n`);

  if (!parsed.push) {
    return 0;
  }

  // Push policy gate — refuse on staging-shaped branches (CLAUDE.md
  // "Push Policy"). Per-team `allowedPushBranches` override (rare)
  // could go here in a future revision; for now we use the bare-name
  // staging-regex check.
  if (!isPushAllowed(merger.baseBranch)) {
    const body = `merger-push-refused · severity=medium · base=${merger.baseBranch} · sha=${result.sha} · CLAUDE.md push-policy requires operator-manual push for staging-shaped branches`;
    await raiseFlag(atmuxDir, body);
    log(
      `merge-member: push refused — '${merger.baseBranch}' is a staging-shaped branch (operator-manual push required); flag raised\n`,
    );
    return 0; // merge succeeded; push deferred is not a verb failure
  }

  const pr = await git(["-C", repoPath, "push", "origin", merger.baseBranch]);
  if (pr.exitCode !== 0) {
    const body = `merger-push-failed · severity=high · base=${merger.baseBranch} · sha=${result.sha} · stderr=${pr.stderr.trim()}`;
    await raiseFlag(atmuxDir, body);
    log(`merge-member: push failed (rc=${pr.exitCode}) — ${pr.stderr.trim()}\n`);
    return 1;
  }
  log(`merge-member: pushed ${merger.baseBranch} to origin\n`);
  return 0;
}
