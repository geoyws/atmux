// ADR-148 §D2 / T5 (t-ac95b267): commit-cadence classifier.
//
// The load-bearing truth signal for "is this member shipping?". T2
// (t-1d370b04) inlined `classifyCadence` + `CadenceObservation` inside
// `src/verbs/status.ts`; this module lifts them into a shared core
// module so future consumers (medic event-driven pickup, doctor probes,
// orchd event consumers per EPIC e-a946af69) all consume the same
// contract.
//
// Verdict semantics per ADR-148 §D2 table (verbatim):
//
//   shipping         — commitsInWindow ≥ 1 AND ageOfLastCommitSec
//                      < shippingMaxAgeSec.
//   idle             — commitsInWindow === 0 AND
//                      ageOfLastCommitSec < idleMaxAgeSec (member
//                      could resume soon).
//   ship-zero-window — commitsInWindow === 0 AND
//                      ageOfLastCommitSec >= shipZeroWindowSec AND
//                      < dormantMaxAgeSec. **Escalation flag** —
//                      fires ADR-132 §D5 E6 mandatory gate.
//   dormant          — commitsInWindow === 0 AND
//                      ageOfLastCommitSec >= dormantMaxAgeSec
//                      (terminal state; operator intervention or
//                      rotation required).
//   exempt           — appended by the renderer when the member's
//                      name is in `team.cadence.exemptMembers`; the
//                      classifier itself never emits `exempt`.
//
// Source-of-truth note: the inline `CadenceThresholds` shape here
// mirrors the schema-level `TeamCadenceThresholds` from
// `src/schema/team.ts`. Co-located here as a plain-object shape so
// callers can pass arbitrary numbers without the Zod-default exact-
// match literal-type constraint. The schema is canonical for
// team.json validation; this interface is canonical for runtime
// classification.

import type { SpawnResult } from "../abstractions/spawn.ts";
import { spawn as defaultSpawn } from "../abstractions/spawn.ts";

// ---------- Public types ----------

/** ADR-148 §D2 verdict literal set. `exempt` is renderer-only — the
 *  classifier never emits it (status.ts's gather loop assigns it
 *  before invoking the classifier when the member is in the team's
 *  `cadence.exemptMembers` list). */
export type CadenceVerdict = "shipping" | "idle" | "dormant" | "ship-zero-window" | "exempt";

/** Per-member cadence-classifier output. Returned by
 *  {@link classifyMemberCadence} (async wrapper) and by
 *  {@link classifyCadence} (pure synchronous, gitLog already done). */
export interface CadenceObservation {
  /** Configured window-back for `commitsInWindow`. */
  windowSec: number;
  /** Commits authored by this member within `windowSec`. */
  commitsInWindow: number;
  /** Epoch seconds of the most recent commit by this member, or
   *  null when the member has never committed in this worktree. */
  lastCommitAt: number | null;
  /** Short (7-char) SHA of the most recent commit, or null. */
  lastCommitSha: string | null;
  /** Age (seconds) since `lastCommitAt`. Null when no commits ever. */
  ageOfLastCommitSec: number | null;
  /** Verdict per the ADR-148 §D2 table. */
  verdict: CadenceVerdict;
}

/** Plain-object threshold shape — non-`as const` so callers can build
 *  from arbitrary numbers without literal-exact-match constraints.
 *  Mirrors the schema's {@link TeamCadenceThresholds} fields. */
export interface CadenceThresholds {
  shippingMaxAgeSec: number;
  idleMaxAgeSec: number;
  dormantMaxAgeSec: number;
  shipZeroWindowSec: number;
}

/** Async gitLog probe — returns parsed `"<sha> <epoch-sec>"` lines for
 *  commits authored by `author` within `sinceSec` of now. Defaults to
 *  {@link defaultGitLog} which shells `git -C <path> log
 *  --since=<sec>s --author=<author> --format=%H %ct`. Tests inject a
 *  deterministic stub. */
export type GitLogFn = (
  worktreePath: string,
  sinceSec: number,
  author: string,
) => Promise<string[] | null>;

/** Construct-time deps for {@link classifyMemberCadence}. */
export interface ClassifyMemberCadenceDeps {
  /** Git-log probe. Defaults to {@link defaultGitLog}. */
  gitLog?: GitLogFn;
  /** Clock injection for tests — defaults to `Date.now()` in
   *  seconds. */
  nowSec?: () => number;
}

/** Per-call config for {@link classifyMemberCadence}. */
export interface ClassifyMemberCadenceConfig {
  /** Window-back in seconds for `commitsInWindow` (default 1800 at
   *  the consumer site; the classifier itself does not assume a
   *  default — caller passes the resolved value). */
  windowSec: number;
  /** Resolved verdict thresholds. */
  thresholds: CadenceThresholds;
}

// ---------- Pure classifier (lifted from status.ts T2 inline) ----------

/**
 * Pure classifier. Inputs are a list of `"<sha> <epoch-sec>"` log
 * lines + the current time + window/threshold config. No I/O.
 *
 * Lifted verbatim from `src/verbs/status.ts::classifyCadence` per
 * the T2 source-comment guarantee ("The shape is the durable
 * contract — T5 refactors location, not fields."). status.ts now
 * re-exports from this module so existing importers stay valid.
 *
 * Verdict precedence (matches §D2 §"ship-zero-window is a subset of
 * dormant when dormantMaxAgeSec > shipZeroWindowSec — surface the
 * escalation classification FIRST"):
 *
 *   1. ≥1 commit + age < shippingMaxAgeSec → `shipping`.
 *   2. 0 commits + age ≥ shipZeroWindowSec:
 *      a. AND age ≥ dormantMaxAgeSec      → `dormant`.
 *      b. OTHERWISE (between window/dormant) → `ship-zero-window`
 *         (escalation flag).
 *   3. age === null OR age < idleMaxAgeSec → `idle`.
 *   4. ELSE                                 → `dormant`.
 */
export function classifyCadence(
  logLines: ReadonlyArray<string>,
  nowSec: number,
  windowSec: number,
  thresholds: CadenceThresholds,
): CadenceObservation {
  let commitsInWindow = 0;
  let lastCommitAt: number | null = null;
  let lastCommitSha: string | null = null;
  for (const line of logLines) {
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const sha = parts[0];
    const ctStr = parts[1];
    if (sha === undefined || ctStr === undefined) continue;
    const ct = Number(ctStr);
    if (!Number.isFinite(ct)) continue;
    if (nowSec - ct <= windowSec) commitsInWindow += 1;
    if (lastCommitAt === null || ct > lastCommitAt) {
      lastCommitAt = ct;
      lastCommitSha = sha.slice(0, 7);
    }
  }
  const ageOfLastCommitSec = lastCommitAt === null ? null : Math.max(0, nowSec - lastCommitAt);

  let verdict: CadenceVerdict;
  if (
    commitsInWindow >= 1 &&
    ageOfLastCommitSec !== null &&
    ageOfLastCommitSec < thresholds.shippingMaxAgeSec
  ) {
    verdict = "shipping";
  } else if (
    commitsInWindow === 0 &&
    ageOfLastCommitSec !== null &&
    ageOfLastCommitSec >= thresholds.shipZeroWindowSec
  ) {
    verdict = ageOfLastCommitSec >= thresholds.dormantMaxAgeSec ? "dormant" : "ship-zero-window";
  } else if (ageOfLastCommitSec === null || ageOfLastCommitSec < thresholds.idleMaxAgeSec) {
    verdict = "idle";
  } else {
    verdict = "dormant";
  }

  return {
    windowSec,
    commitsInWindow,
    lastCommitAt,
    lastCommitSha,
    ageOfLastCommitSec,
    verdict,
  };
}

// ---------- Async wrapper ----------

/**
 * Per-task-body `classifyMemberCadence(member, worktreePath, config,
 * deps)` async surface. Composes {@link GitLogFn} probe + the pure
 * {@link classifyCadence} step so medic + future doctor probes +
 * orchd event consumers call ONE function for the cadence snapshot.
 *
 * `sinceSec` for the git-log probe is `max(windowSec, dormantMax)` —
 * the wider window so the classifier sees the actual last commit
 * even when it falls outside `windowSec` (needed for
 * `ageOfLastCommitSec`). Capped at `dormantMaxAgeSec` because any
 * commit older than that is `dormant` regardless of how far back we
 * read.
 *
 * Fail-soft: the default gitLog returns `[]` on any git error so a
 * missing worktree degrades to "no commits ever" rather than
 * crashing the tick. Callers that need fail-loud inject their own
 * gitLog.
 */
export async function classifyMemberCadence(
  member: string,
  worktreePath: string,
  config: ClassifyMemberCadenceConfig,
  deps: ClassifyMemberCadenceDeps = {},
): Promise<CadenceObservation | null> {
  const gitLog = deps.gitLog ?? defaultGitLog;
  const nowSec = (deps.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
  const sinceSec = Math.max(config.windowSec, config.thresholds.dormantMaxAgeSec);
  const lines = await gitLog(worktreePath, sinceSec, member);
  // `null` is "the probe could not read a repository here" — distinct
  // from `[]` ("a repository with no matching commits"). Only the second
  // supports a verdict; the first must not be turned into one.
  if (lines === null) return null;
  return classifyCadence(lines, nowSec, config.windowSec, config.thresholds);
}

// ---------- Default git-log probe ----------

/**
 * Default `GitLogFn` impl — shells `git -C <path> log --since=<sec>s
 * --author=<author> --format=%H %ct`. Fail-soft on any error
 * (non-zero exit, spawn failure) → returns `[]`. This is the
 * production probe; status.ts's gather loop wires through here.
 *
 * Lifted from status.ts's local `defaultGitLog` so the T2 + T5
 * paths share one canonical implementation — no risk of the two
 * call sites diverging on git-flag shape.
 */
export async function defaultGitLog(
  worktreePath: string,
  sinceSec: number,
  author: string,
  deps: { spawn?: typeof defaultSpawn } = {},
): Promise<string[] | null> {
  const runSpawn = deps.spawn ?? defaultSpawn;
  try {
    const r: SpawnResult = await runSpawn({
      cmd: "git",
      argv: [
        "-C",
        worktreePath,
        "log",
        `--since=${sinceSec}s`,
        `--author=${author}`,
        "--format=%H %ct",
      ],
      expectExitCode: "any",
      timeoutMs: 5000,
    });
    // A non-zero exit is NOT "no commits" — it is "I could not look".
    // `git -C <not-a-repo> log` exits 128, and collapsing that to `[]`
    // made the classifier hand back a confident `🟡 idle (never)` for a
    // directory that has no repository at all. That verdict then reached
    // the operator through `atmux status`, and through `team_status` it
    // reached them SPOKEN: the vox drilldown transcript relayed the word
    // "idle" about panes whose only sin was living outside a git repo.
    // `null` means "no signal" and the caller renders `—`.
    if (r.exitCode !== 0) return null;
    return r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    // Spawn failure / timeout — also "could not look", not "no commits".
    return null;
  }
}
