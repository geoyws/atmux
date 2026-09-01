import { existsSync as fsExistsSync } from "node:fs";
import { join } from "node:path";
import { resolveWorktreePath, sanitizeBranchSegment } from "../../abstractions/worktree.ts";
import type { Team } from "../../schema/team.ts";
import { type DoctorRow, defaultGitSpawn, type GitSpawn } from "./types.ts";

// ---------- ADR-057 §D5a: submodule pointer integrity ----------

/** Per-submodule status entry parsed from `git submodule status`. */

export interface SubmoduleStatus {
  /** Path relative to repo root (e.g. `vendor/x`). */
  path: string;
  /** SHA recorded in the parent commit. */
  recordedSha: string;
  /** ` ` (clean), `+` (HEAD mismatch), `-` (uninitialized), `U` (conflict). */
  state: " " | "+" | "-" | "U";
}

/**
 * Parse `git submodule status` output. Each line is either:
 *
 *   ` <40-hex> <path> [(<describe>)]`     — clean
 *   `+<40-hex> <path> [(<describe>)]`     — HEAD doesn't match recorded SHA
 *   `-<40-hex> <path>`                    — uninitialized
 *   `U<40-hex> <path>`                    — merge conflict
 *
 * Lines that don't fit the shape are skipped (defensive against future
 * git output changes; we'd rather emit no finding than a false positive).
 */

export function parseSubmoduleStatus(stdout: string): SubmoduleStatus[] {
  const out: SubmoduleStatus[] = [];
  for (const raw of stdout.split("\n")) {
    if (raw.length === 0) continue;
    const prefix = raw[0];
    if (prefix !== " " && prefix !== "+" && prefix !== "-" && prefix !== "U") continue;
    const rest = raw.slice(1);
    const m = rest.match(/^([0-9a-f]{40})\s+(\S+)/);
    if (m === null) continue;
    out.push({
      state: prefix,
      recordedSha: m[1] ?? "",
      path: m[2] ?? "",
    });
  }
  return out;
}

export interface CheckSubmoduleIntegrityOpts {
  /** git spawn override (test injection). */
  git?: GitSpawn;
}

/**
 * D5a: submodule pointer integrity. Runs `git submodule status` from the
 * cwd and emits one P2 (yellow) row per mismatched / uninitialized /
 * conflicted submodule. No submodules → no rows. Non-git cwd → no rows
 * (silent — `git submodule status` exits 0 with no stdout outside a repo
 * with submodules; outside a repo entirely it exits non-zero with stderr
 * which we treat as "skip").
 *
 * The check is on the OUTER repo (atmux's cwd). Submodules-of-submodules
 * are NOT recursed by default — the operator's cron-groom invokes
 * `atmux doctor --json` per tick, and recursion would amplify the noise.
 */

export async function checkSubmoduleIntegrity(
  opts: CheckSubmoduleIntegrityOpts = {},
): Promise<DoctorRow[]> {
  const git = opts.git ?? defaultGitSpawn;
  const r = await git(["submodule", "status"]);
  if (r.exitCode !== 0) return [];
  const statuses = parseSubmoduleStatus(r.stdout);
  const rows: DoctorRow[] = [];
  for (const s of statuses) {
    if (s.state === " ") continue;
    const detail =
      s.state === "+"
        ? `${s.path} HEAD doesn't match recorded ${s.recordedSha.slice(0, 7)}`
        : s.state === "-"
          ? `${s.path} not initialized (recorded ${s.recordedSha.slice(0, 7)})`
          : `${s.path} merge conflict (recorded ${s.recordedSha.slice(0, 7)})`;
    const hint =
      s.state === "+"
        ? `cd ${s.path} && git checkout ${s.recordedSha.slice(0, 7)}  (or commit the bump in the parent)`
        : s.state === "-"
          ? "git submodule update --init --recursive"
          : "resolve the merge conflict in the submodule, then commit the parent";
    rows.push({
      status: "yellow",
      label: "submodule-integrity",
      detail,
      hint,
    });
  }
  return rows;
}

// ---------- ADR-082 W5: worktree-isolation check (4 anomaly classes) ----------

export interface CheckWorktreeOpts {
  /** Git spawn override (test injection). Default uses `defaultGitSpawn`
   *  from `abstractions/worktree.ts`. */
  gitSpawn?: GitSpawn;
  /** Readdir override (test injection). Default `node:fs/promises::readdir`
   *  with `withFileTypes: true`. Returning `null` simulates ENOENT — the
   *  worktrees directory not existing yet. */
  readWorktreeDir?: (
    path: string,
  ) => Promise<ReadonlyArray<{ name: string; isDirectory: boolean }> | null>;
}

interface PorcelainWorktree {
  /** Absolute path of the worktree, as reported by `git worktree list --porcelain`. */
  path: string;
  /** Checked-out branch (without `refs/heads/` prefix). Empty when detached HEAD. */
  branch: string;
}

/**
 * ADR-082 §5 — surface 4 anomaly classes for `worktreeIsolation: true`
 * teams + 1 cleanup-suggestion for legacy teams with leftover state.
 *
 * Classes:
 *   1. `worktree-missing`         — isolation on; member has no worktree dir.
 *                                    RED. Auto-fix hint: re-run `atmux start` (the
 *                                    W3 provisioning step is idempotent — reruns
 *                                    create the missing worktree only).
 *   2. `worktree-orphan`           — isolation on; dir under `<atmuxDir>/worktrees/`
 *                                    isn't matched by any `team.members[].name`.
 *                                    YELLOW. Hint: `git worktree remove` (or
 *                                    `atmux doctor --fix` once V-24 wires the
 *                                    auto-fix branch).
 *   3. `worktree-wrong-branch`     — worktree on a different branch than its
 *                                    per-member fork `${base}-${member}` (ADR-084).
 *                                    YELLOW. Surface only — no auto-checkout
 *                                    (operator-edited state may carry unstashed
 *                                    work; same rule as W1's `provisionWorktree`
 *                                    wrong-branch throw).
 *   4. `worktree-disabled-but-present` — isolation OFF (or unset) but
 *                                    `<atmuxDir>/worktrees/` has entries. Single
 *                                    YELLOW (not per-orphan — the cleanup is
 *                                    a batch operation). Hint: flip
 *                                    `worktreeIsolation: true` to resume
 *                                    management, OR `rm -rf` to discard.
 *   5. `worktree-branch-orphan`    — isolation on; a `${base}-*` branch exists
 *                                    whose suffix matches no current
 *                                    `team.members[].name` (sanitized). INFO
 *                                    (no count toward pass/fail). Hint: safe
 *                                    auto-delete via `--fix` when 0 commits
 *                                    ahead of base; surface-only with manual
 *                                    review when commits are unmerged. ADR-084
 *                                    §"Doctor probe update" — branches are left
 *                                    in place by `stop --force` per OQ-2
 *                                    default; over time they accumulate.
 *
 * Pure modulo IO — every IO call gated through `opts` for tests. When
 * `team === null` (team.json failed to load), returns empty: the
 * `checkTeam` row already surfaced the broken state.
 */

export async function checkWorktreeIsolation(
  team: Team | null,
  atmuxDir: string,
  opts: CheckWorktreeOpts = {},
): Promise<DoctorRow[]> {
  if (team === null) return [];
  const readDir = opts.readWorktreeDir ?? defaultReadWorktreeDir;
  const worktreesDir = join(atmuxDir, "worktrees");
  const entries = await readDir(worktreesDir);

  const isolation = team.worktreeIsolation === true;
  const memberNames = new Set(team.members.map((m) => m.name));
  const subdirs = entries === null ? [] : entries.filter((e) => e.isDirectory).map((e) => e.name);

  // Class 4 — isolation off but entries present. Single row.
  if (!isolation) {
    if (subdirs.length === 0) return [];
    return [
      {
        status: "yellow",
        label: "worktree:disabled-but-present",
        detail: `${subdirs.length} dir(s) under ${worktreesDir} despite worktreeIsolation !== true`,
        hint: "flip team.json `worktreeIsolation: true` to resume management, or `rm -rf` to discard",
      },
    ];
  }

  // Classes 1 + 2 — present-set delta against the team roster.
  const presentSet = new Set(subdirs);
  const rows: DoctorRow[] = [];

  // Class 1 — missing per member.
  for (const member of team.members) {
    if (!presentSet.has(member.name)) {
      const expected = resolveWorktreePath(team, member.name, atmuxDir);
      rows.push({
        status: "red",
        label: `worktree:missing:${member.name}`,
        detail: `expected ${expected}`,
        hint: "re-run `atmux start` (W3 provisioning is idempotent — creates only the missing worktrees)",
      });
    }
  }

  // Class 2 — orphan per directory not in the roster.
  for (const name of subdirs) {
    if (!memberNames.has(name)) {
      rows.push({
        status: "yellow",
        label: `worktree:orphan:${name}`,
        detail: `${join(worktreesDir, name)} not in team.members[].name`,
        hint: "remove via `git worktree remove` (or wait on `atmux doctor --fix` per V-24)",
      });
    }
  }

  // Class 3 — wrong-branch per managed worktree. ONE shared `git worktree
  // list --porcelain` + `git branch --show-current` invocation pair
  // services every member; if either git call fails the entire wrong-
  // branch detection degrades to a yellow advisory rather than blocking
  // the rest of the doctor pass. Members whose worktrees we couldn't
  // resolve (missing — class 1) are skipped naturally.
  const present = team.members.filter((m) => presentSet.has(m.name));
  if (present.length > 0) {
    const git = opts.gitSpawn ?? defaultGitSpawn;
    // Match start.ts / stop.ts projectRoot resolution: regex-strip
    // a trailing `/.atmux/?`.
    const projectRoot = atmuxDir.replace(/\/?\.atmux\/?$/, "") || "/";
    const branchR = await git(["-C", projectRoot, "branch", "--show-current"]);
    const expectedBranch = branchR.exitCode === 0 ? branchR.stdout.trim() : "";
    const listR = await git(["-C", projectRoot, "worktree", "list", "--porcelain"]);
    if (branchR.exitCode !== 0 || listR.exitCode !== 0 || expectedBranch.length === 0) {
      rows.push({
        status: "yellow",
        label: "worktree:branch-probe-skipped",
        detail:
          branchR.exitCode !== 0 || listR.exitCode !== 0
            ? `git probe failed (rc=${branchR.exitCode}/${listR.exitCode})`
            : "operator on detached HEAD — no current branch to compare against",
        hint: "wrong-branch detection skipped; manually verify worktree branches if isolation is critical",
      });
    } else {
      const parsed = parsePorcelainWorktrees(listR.stdout);
      for (const member of present) {
        const wt = resolveWorktreePath(team, member.name, atmuxDir);
        const found = parsed.find((p) => p.path === wt);
        if (found === undefined) {
          // Directory exists on disk but isn't a managed git worktree.
          // Could be a stale dir from a prior abort. Surface as yellow.
          rows.push({
            status: "yellow",
            label: `worktree:not-managed:${member.name}`,
            detail: `${wt} exists on disk but isn't registered with git worktree list`,
            hint: "remove the directory or re-provision via `atmux start`",
          });
          continue;
        }
        // ADR-084: each member's worktree is provisioned on its own
        // per-member branch `${baseBranch}-${sanitize(memberName)}`.
        // Anything else (a different branch, detached HEAD, or operator-
        // attached state) is drift.
        const expectedWtBranch = `${expectedBranch}-${sanitizeBranchSegment(member.name)}`;
        if (found.branch !== expectedWtBranch) {
          const stateLabel = found.branch === "" ? "detached HEAD" : `branch '${found.branch}'`;
          rows.push({
            status: "yellow",
            label: `worktree:wrong-branch:${member.name}`,
            detail: `on ${stateLabel}, expected branch '${expectedWtBranch}' (per-member fork off '${expectedBranch}')`,
            hint: `reconcile via \`git -C <wt> checkout ${expectedWtBranch}\` — auto-checkout disabled per ADR-082 §3 (unstashed work at risk)`,
          });
        }
      }
    }
  }

  // Class 5 (ADR-084 W2 / branch-orphan) — surface stranded `${base}-*`
  // branches whose suffix isn't a current member. Independent from the
  // worktree state above: branches outlive worktrees (per ADR-084 OQ-2
  // default, `stop --force` prunes the worktree but keeps the branch).
  // Resolves baseBranch independently so the probe runs even when no
  // managed worktrees are present (the worktree might already be gone;
  // it's the leftover BRANCH we're surfacing).
  const git2 = opts.gitSpawn ?? defaultGitSpawn;
  const projectRoot2 = atmuxDir.replace(/\/?\.atmux\/?$/, "") || "/";
  const baseR = await git2(["-C", projectRoot2, "branch", "--show-current"]);
  const baseBranch = baseR.exitCode === 0 ? baseR.stdout.trim() : "";
  if (baseBranch.length > 0) {
    const listR = await git2(["-C", projectRoot2, "branch", "--list", `${baseBranch}-*`]);
    if (listR.exitCode === 0) {
      const sanitizedMembers = new Set(team.members.map((m) => sanitizeBranchSegment(m.name)));
      const prefix = `${baseBranch}-`;
      // `git branch --list <pat>` rows are 2-space indented; current
      // branch (impossible for an orphan but defensive) prefixes `* `.
      const branchNames = listR.stdout
        .split("\n")
        .map((line) => line.replace(/^[\s*+]+/, "").trim())
        .filter((line) => line.length > 0 && line.startsWith(prefix));
      for (const branchName of branchNames) {
        const suffix = branchName.slice(prefix.length);
        if (sanitizedMembers.has(suffix)) continue;
        // Orphan: count unmerged commits relative to base.
        const countR = await git2([
          "-C",
          projectRoot2,
          "rev-list",
          "--count",
          `${baseBranch}..${branchName}`,
        ]);
        const aheadRaw = countR.exitCode === 0 ? countR.stdout.trim() : "";
        const aheadCount = /^\d+$/.test(aheadRaw) ? parseInt(aheadRaw, 10) : null;
        if (aheadCount === null) {
          rows.push({
            status: "info",
            label: `worktree:branch-orphan:${suffix}`,
            detail: `${branchName} — unmerged-count probe failed (rc=${countR.exitCode})`,
            hint: `manually verify before deletion: \`git log ${baseBranch}..${branchName}\``,
          });
        } else if (aheadCount === 0) {
          rows.push({
            status: "info",
            label: `worktree:branch-orphan:${suffix}`,
            detail: `${branchName} — 0 commits ahead of ${baseBranch} (safe to delete)`,
            hint: `\`atmux doctor --fix\` would prune it (dry-run today); manual: \`git branch -d ${branchName}\``,
          });
        } else {
          rows.push({
            status: "info",
            label: `worktree:branch-orphan:${suffix}`,
            detail: `${branchName} — ${aheadCount} commit(s) ahead of ${baseBranch} (unmerged work)`,
            hint: `review before deletion: \`git log ${baseBranch}..${branchName}\``,
          });
        }
      }
    }
  }

  return rows;
}

async function defaultReadWorktreeDir(
  path: string,
): Promise<ReadonlyArray<{ name: string; isDirectory: boolean }> | null> {
  const { readdir } = await import("node:fs/promises");
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((e) => ({ name: String(e.name), isDirectory: e.isDirectory() }));
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function parsePorcelainWorktrees(stdout: string): PorcelainWorktree[] {
  // `git worktree list --porcelain` emits blocks separated by blank lines:
  //   worktree <path>
  //   HEAD <sha>
  //   branch refs/heads/<name>    (or `detached`)
  const out: PorcelainWorktree[] = [];
  for (const block of stdout.split("\n\n")) {
    const lines = block.split("\n");
    const wtLine = lines.find((l) => l.startsWith("worktree "));
    if (wtLine === undefined) continue;
    const path = wtLine.slice("worktree ".length);
    const branchLine = lines.find((l) => l.startsWith("branch "));
    const branch = branchLine === undefined ? "" : branchLine.slice("branch refs/heads/".length);
    out.push({ path, branch });
  }
  return out;
}

// ---------- ADR-245 single-kanban invariant: nested-state.db probe ----------

export interface CheckWorktreeNestedStateDbOpts {
  /** Readdir override (test injection). Same shape as
   *  `CheckWorktreeOpts.readWorktreeDir`: returns dir entries, or `null`
   *  to simulate ENOENT (the `worktrees/` dir not existing yet). */
  readWorktreeDir?: (
    path: string,
  ) => Promise<ReadonlyArray<{ name: string; isDirectory: boolean }> | null>;
  /** `existsSync` override (test injection). Default `node:fs::existsSync`. */
  existsSync?: (path: string) => boolean;
}

/**
 * ADR-245 single-`.atmux`-per-project invariant — defensive doctor probe
 * (#3 of the worktree single-kanban hook set; t-62-df4e59bd addendum).
 *
 * Architectural invariant (operator-direct 2026-05-26, t-62-df4e59bd):
 * worktrees share the parent team's ONE kanban. A member worktree at
 * `<team-root>/.atmux/worktrees/<member>/` MAY carry a per-worktree
 * `team.json` (identity / cwd-pin) but MUST NOT contain a `state.db` —
 * the kanban lives ONLY at the team root's `.atmux/state.db`. A nested
 * `state.db` means some verb wrote a worktree-local kanban instead of
 * resolving UP, splitting state across diverging databases.
 *
 * The four other invariant hooks (verb path resolution `getAtmuxDir`
 * strip-back-before-walk, provisioning writing `team.json`-only, the
 * orchd-window spawn guard, and `checkWorktreeIsolation`'s orphan walk)
 * are preventive. This probe is the failsafe: it directly scans
 * `<atmuxDir>/worktrees/*\/.atmux/state.db` and emits a RED fail row per
 * planted nested db with an `rm <path>` cleanup hint, so a leaked stub
 * surfaces even when every preventive hook was bypassed.
 *
 * Returns [] when `team === null` (checkTeam already surfaced the broken
 * state) or when the `worktrees/` dir doesn't exist (no isolation in use).
 */

export async function checkWorktreeNestedStateDb(
  team: Team | null,
  atmuxDir: string,
  opts: CheckWorktreeNestedStateDbOpts = {},
): Promise<DoctorRow[]> {
  if (team === null) return [];
  const readDir = opts.readWorktreeDir ?? defaultReadWorktreeDir;
  const existsSync = opts.existsSync ?? fsExistsSync;
  const worktreesDir = join(atmuxDir, "worktrees");
  const entries = await readDir(worktreesDir);
  if (entries === null) return [];

  const rows: DoctorRow[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const nested = join(worktreesDir, entry.name, ".atmux", "state.db");
    if (existsSync(nested)) {
      rows.push({
        status: "red",
        label: `worktree:nested-state-db:${entry.name}`,
        detail: `nested kanban at ${nested} — worktrees MUST share the team-root kanban (ADR-245; t-62-df4e59bd)`,
        hint: `rm ${nested} (then re-run verbs from the worktree — they resolve UP to <team-root>/.atmux/state.db)`,
      });
    }
  }
  return rows;
}

// ---------- ADR-179 W6: merger-fan-in probe class ----------

/** ADR-179 §Decision-2+3+6: `team.merger` block, mirrored locally because
 *  this branch (geoyws-up-impl-2) implements W6 in parallel with sibling
 *  branches that own W3 (`merge-cycle` verb) and W4 (the canonical Zod
 *  block on `team.ts`). When the trunk merge lands, the schema-level
 *  `team.merger` is the source of truth; `Team.passthrough()` carries
 *  the runtime payload either way. This local type is the
 *  literal-union sibling-branch pattern from
 *  `feedback_test_impl_session_pattern_2026_05_14.md`. */

interface MergerConfig {
  enabled?: boolean;
  baseBranch?: string;
  stalenessHours?: number;
}

/** ADR-179 §Decision-6 default. The W4 Zod default lives at the schema
 *  layer; this constant is the read-site fallback so the probe runs
 *  identically pre- and post-trunk-merge. */

const DEFAULT_MERGER_STALENESS_HOURS = 24;

/** Extract `team.merger` via runtime cast — schema definition lives on
 *  the W4 sibling branch and merges in via trunk. Until then, `Team`'s
 *  `.passthrough()` carries the field but the static type omits it. */

function readMergerConfig(team: Team): MergerConfig | undefined {
  const raw = (team as unknown as { merger?: unknown }).merger;
  if (raw === undefined || raw === null || typeof raw !== "object") return undefined;
  return raw as MergerConfig;
}

export interface CheckMergerFanInOpts {
  /** Git spawn override (test injection). */
  gitSpawn?: GitSpawn;
  /** Wall-clock "now" in epoch seconds. Default: `Date.now() / 1000`.
   *  Injected by tests so the staleness probe runs deterministically. */
  nowEpochSec?: () => number;
}

/**
 * ADR-179 §Decision-6 — surface 2 anomaly classes for the merger fan-in
 * policy. Both are pre-emptive: they flag misconfiguration / drift before
 * unattended fan-in silently stops working.
 *
 * Classes:
 *   1. `merger-branch-stale` — `team.merger.enabled === true` AND a
 *                              `${base}-<m>` branch has commits older
 *                              than `merger.stalenessHours`
 *                              (default 24h). YELLOW. Hint: run
 *                              `atmux merge-member <m>` manually. The
 *                              ADR-179 §Decision-6 auto-fix path (clean
 *                              base worktree + clean fast-forward) is
 *                              wired into `--fix` once the W3
 *                              `merge-cycle` verb merges into trunk;
 *                              until then the probe surfaces only.
 *   2. `merger-disabled-but-member-present` — `team.members[]` contains
 *                              a member with `role: "merger"` but
 *                              `team.merger.enabled !== true`. YELLOW.
 *                              Surface only — operator intent ambiguous
 *                              (might be a forgotten flip, might be an
 *                              opt-out keeping the brief for later).
 *                              Never auto-fixable.
 *
 * Pure modulo IO — every IO call gated through `opts` for tests. When
 * `team === null` (team.json failed to load), returns empty: the
 * `checkTeam` row already surfaced the broken state.
 */

export async function checkMergerFanIn(
  team: Team | null,
  atmuxDir: string,
  opts: CheckMergerFanInOpts = {},
): Promise<DoctorRow[]> {
  if (team === null) return [];
  const merger = readMergerConfig(team);
  const enabled = merger?.enabled === true;

  // Class 2 always evaluates — independent of enabled flag (the whole
  // point is to flag the inconsistency between role-present and
  // feature-off).
  const rows: DoctorRow[] = [];
  for (const member of team.members) {
    if (member.role !== "merger") continue;
    if (enabled) continue;
    rows.push({
      status: "yellow",
      label: `merger:disabled-but-member-present:${member.name}`,
      detail: `member '${member.name}' declares role=merger but team.merger.enabled !== true`,
      hint: "either flip `team.merger.enabled: true` to activate fan-in, or drop the role from team.json",
    });
  }

  // Class 1 only evaluates when the feature is opted in — staleness is
  // meaningless when fan-in is disabled by design.
  if (!enabled) return rows;

  const stalenessHours =
    typeof merger?.stalenessHours === "number" && merger.stalenessHours > 0
      ? merger.stalenessHours
      : DEFAULT_MERGER_STALENESS_HOURS;
  const nowSec = (opts.nowEpochSec ?? (() => Math.floor(Date.now() / 1000)))();
  const staleCutoffSec = nowSec - stalenessHours * 3600;

  const git = opts.gitSpawn ?? defaultGitSpawn;
  const projectRoot = atmuxDir.replace(/\/?\.atmux\/?$/, "") || "/";

  // Resolve base — `merger.baseBranch` wins if set; otherwise fall back
  // to current branch in the project root (matches ADR-179 §Decision-3
  // resolution order in `mergeMember`).
  let baseBranch = typeof merger?.baseBranch === "string" ? merger.baseBranch : "";
  if (baseBranch.length === 0) {
    const baseR = await git(["-C", projectRoot, "branch", "--show-current"]);
    baseBranch = baseR.exitCode === 0 ? baseR.stdout.trim() : "";
  }
  if (baseBranch.length === 0) return rows; // detached HEAD — can't probe.

  const listR = await git(["-C", projectRoot, "branch", "--list", `${baseBranch}-*`]);
  if (listR.exitCode !== 0) return rows; // degrade silently.

  const prefix = `${baseBranch}-`;
  const branchNames = listR.stdout
    .split("\n")
    .map((line) => line.replace(/^[\s*+]+/, "").trim())
    .filter((line) => line.length > 0 && line.startsWith(prefix));

  // For each member-suffixed branch, probe its tip-commit time and
  // commits-ahead count. We only surface branches that are:
  //   (a) suffixed to a current team member (not a leftover orphan —
  //       that's already handled by class 5 of checkWorktreeIsolation),
  //   (b) have ≥1 commit ahead of base (a no-op merge would be silent),
  //   (c) tip-commit older than the staleness cutoff.
  const sanitizedToMember = new Map<string, string>();
  for (const m of team.members) {
    sanitizedToMember.set(sanitizeBranchSegment(m.name), m.name);
  }

  for (const branchName of branchNames) {
    const suffix = branchName.slice(prefix.length);
    const memberName = sanitizedToMember.get(suffix);
    if (memberName === undefined) continue; // not a current member; class 5 surfaces this.

    // Commits-ahead count gate.
    const countR = await git([
      "-C",
      projectRoot,
      "rev-list",
      "--count",
      `${baseBranch}..${branchName}`,
    ]);
    if (countR.exitCode !== 0) continue;
    const aheadRaw = countR.stdout.trim();
    if (!/^\d+$/.test(aheadRaw)) continue;
    const ahead = parseInt(aheadRaw, 10);
    if (ahead === 0) continue;

    // Tip-commit author/commit time.
    const timeR = await git(["-C", projectRoot, "log", "-1", "--format=%ct", branchName]);
    if (timeR.exitCode !== 0) continue;
    const tipRaw = timeR.stdout.trim();
    if (!/^\d+$/.test(tipRaw)) continue;
    const tipSec = parseInt(tipRaw, 10);
    if (tipSec >= staleCutoffSec) continue; // fresh — not stale.

    const ageHours = Math.floor((nowSec - tipSec) / 3600);
    rows.push({
      status: "yellow",
      label: `merger:branch-stale:${memberName}`,
      detail: `${branchName} — ${ahead} commit(s) ahead of ${baseBranch}, tip is ~${ageHours}h old (threshold ${stalenessHours}h)`,
      hint: `run \`atmux merge-member ${memberName}\` to fan in — or wait for the merger loop / cron if installed`,
    });
  }

  return rows;
}
