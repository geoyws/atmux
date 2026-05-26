// ADR-179 §Decision-2+3+6: effective-default helper for `team.merger`.
//
// The Zod schema in `src/schema/team.ts` declares the static defaults
// (`enabled: false`, `stalenessHours: 24`); this helper resolves the
// dynamic default for `baseBranch` — when the team omits the field,
// the merger picks up whatever branch the parent worktree currently has
// checked out (mirrors ADR-179 §Decision-3 pseudocode
// `team.merger?.baseBranch ?? currentBranch(repoPath)`). Spawn-injectable
// `git` so the W2/W3/W6 read-sites can stub the branch resolution in
// unit tests.

import { defaultGitSpawn, type GitSpawn } from "../abstractions/worktree.ts";
import { ConfigError } from "../errors.ts";
import { DEFAULT_MERGER_STALENESS_HOURS, type Team } from "../schema/team.ts";

/** Effective merger config — `baseBranch` always resolved (either
 *  explicit `team.merger.baseBranch` or the parent worktree's current
 *  HEAD). Pass-through to the W2/W3 verbs + W6 doctor probe. */
export interface ResolvedMergerConfig {
  enabled: boolean;
  baseBranch: string;
  stalenessHours: number;
}

export interface ResolveMergerOpts {
  /** GitSpawn injection — defaults to the real `git` via
   *  {@link defaultGitSpawn}. Tests pass a mock. */
  git?: GitSpawn;
}

/**
 * Resolve a team's effective merger config. Pure pass-through for the
 * static fields (`enabled`, `stalenessHours`); dynamic resolution for
 * `baseBranch` via `git -C <repoPath> branch --show-current` when the
 * field is unset.
 *
 * Throws `ConfigError` if `git branch --show-current` fails OR returns
 * empty (detached HEAD) AND the team didn't pin `baseBranch` explicitly
 * — the merger cannot proceed without a target branch. ADR-179 W2 /
 * W3 callers surface the error via `atmux reply` to the driver.
 *
 * **Why this exists**: keeps the W2/W3 verbs from each shelling out
 * to `branch --show-current` independently — single resolution path,
 * single error-mode shape, single test injection point.
 */
export async function resolveMergerConfig(
  team: Team,
  repoPath: string,
  opts: ResolveMergerOpts = {},
): Promise<ResolvedMergerConfig> {
  const git = opts.git ?? defaultGitSpawn;
  const enabled = team.merger?.enabled ?? false;
  const stalenessHours = team.merger?.stalenessHours ?? DEFAULT_MERGER_STALENESS_HOURS;

  let baseBranch = team.merger?.baseBranch;
  if (baseBranch === undefined || baseBranch === "") {
    const r = await git(["-C", repoPath, "branch", "--show-current"]);
    if (r.exitCode !== 0) {
      throw new ConfigError({
        what: `resolveMergerConfig: \`git branch --show-current\` failed (rc=${r.exitCode}) at ${repoPath}`,
        hint: r.stderr.trim() || "(no stderr)",
      });
    }
    const detected = r.stdout.trim();
    if (detected === "") {
      throw new ConfigError({
        what: `resolveMergerConfig: cannot resolve baseBranch — repo at ${repoPath} is on detached HEAD`,
        hint: "set `team.merger.baseBranch` explicitly in team.json, or check out a branch in the parent worktree before invoking the merger",
      });
    }
    baseBranch = detected;
  }

  return { enabled, baseBranch, stalenessHours };
}
