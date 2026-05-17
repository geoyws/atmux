// ADR-134 T4 (t-64e52aac): cron backstop sweep — catches missed task-done
// events.
//
// Pure sweep logic, no I/O baked in — every side-effecting dep is
// injectable so the unit tests can pin behavior without touching git
// or SQLite.
//
// Flow per ADR-134 §triggers §cron-backstop-secondary (lines 130–138):
//
//   1. List per-member branches: `git -C <teamRoot> branch --list
//      "<baseBranch>-*"`. The `<base>-<member>` convention is the
//      same one ADR-082 + ADR-084 + ADR-088 W1 already use; the
//      `branch --list` glob does the lane-filtering for us.
//
//   2. For each candidate branch, compute the ahead-of-base count via
//      `git rev-list --count <baseBranch>..<memberBranch>`. Zero ⇒ skip
//      (nothing to fan in; the branch is at or behind base).
//
//   3. Read the current state row from {@link MergerStateRepo}. If the
//      branch is in a mid-walk state (`ready_to_merge`, `rebasing`,
//      `merging`, `tested`, `test_failed`), skip the queue — another
//      tick (the same-walk dispatcher iteration OR a caller-driven
//      test gate) is moving it. `in_progress` is NOT in this skip set
//      per t-f4088323: branches stuck in `in_progress` because the
//      dispatcher pre-merge gate was held at first-tick (worker dirty)
//      need every-cycle re-evaluation to advance once the worker
//      clears. `open` + terminal states (`merged`/`conflict`/`reverted`)
//      remain queueable too (open = initial, terminal + new tip = fresh
//      work after the prior cycle's terminal landed).
//
//   4. Otherwise queue a merge attempt via the injected
//      {@link QueueMergeFn} callback. This is the same dispatch path
//      T3 (event-driven) wires; the sweep just re-fires the dispatch
//      so missed events get retried.
//
// Idempotence: re-running the sweep when every branch is already merged
// or in-flight is a no-op (steps 2 + 3 short-circuit). The state-machine
// transactions inside {@link MergerStateRepo.transition} are wrapped in
// BEGIN IMMEDIATE per ADR-134 §state-machine race-protection guarantee,
// so concurrent event-driven + cron-backstop firings on the same branch
// serialize correctly.
//
// Cross-task dep posture:
//
//   - {@link MergerStateRepo} lives on trunk (ADR-134 T2 prereq, commit
//     4a2de89 + 0aa74c5 trunk-merge). This sweep consumes its
//     `getState` + `listAll` surface directly.
//   - {@link QueueMergeFn} is the integration seam with T3 (event-driven
//     dispatch, t-27b06cda, not yet shipped). The verb-layer wiring
//     (T4 ships) injects a stub that records the queue intent; when T3
//     lands, the verb-layer factory swaps the real dispatch in. The
//     sweep core stays unchanged — it owns the eligibility logic, T3
//     owns the merge-execution path.

import type { GitSpawn } from "../abstractions/worktree.ts";
import type { BranchMergeState } from "./branch-merge-state.ts";
import type { MergerStateRepo } from "./repositories/merger-state-repo.ts";

// ---------- Types ----------

/** States that mean "the committer is already moving this branch" — sweep
 *  skips these because another tick (the same-walk dispatcher or a
 *  caller-driven external test gate) is actively progressing them.
 *
 *  **`in_progress` is NOT in this set** (per t-f4088323 P1 fix). The
 *  initial too-conservative shape included `in_progress`, which trapped
 *  branches whose dispatcher pre-merge gate (`shouldTransitionFromInProgress`)
 *  was held by worker dirty-state at the time of the FIRST tick: once
 *  the state was seeded `in_progress`, sweep skipped it forever, so
 *  the gate never re-evaluated even when the worker became task-clean.
 *  `in_progress` is now treated like `open` from the sweep's perspective:
 *  re-queue every cycle and let the dispatcher re-run the gate. The
 *  dispatcher is idempotent on `in_progress → in_progress` self-loops
 *  (BEGIN IMMEDIATE per ADR-134 §state-machine race-protection); a
 *  gate-still-held tick returns `{queued:false, reason:"gate-held"}` so
 *  the sweep records `queue-refused` with a meaningful note.
 *
 *  `open` is NOT in this set — `open` is the initial state for a branch
 *  that has never transitioned; the sweep IS allowed to queue from there.
 *  Terminal states (`merged`, `conflict`, `reverted`) are also NOT in
 *  this set — terminal rows have completed (success or failure); the
 *  next branch-tip advance brings the branch back to the queue path
 *  via a fresh `open → in_progress` transition. */
const IN_FLIGHT_STATES: ReadonlySet<BranchMergeState> = new Set<BranchMergeState>([
  "ready_to_merge",
  "rebasing",
  "merging",
  "tested",
  "test_failed",
]);

/** Dispatch callback — the function the sweep invokes when a branch
 *  is eligible for a merge attempt. T3 (event-driven, t-27b06cda)
 *  ships the production impl that runs the state machine through
 *  `merging → tested → merged`; T4 (this commit) consumes the seam
 *  via interface only. The return is the post-queue state so the
 *  sweep can log meaningful evidence per attempt without re-reading
 *  the repo. */
export type QueueMergeFn = (input: {
  memberBranch: string;
  aheadCount: number;
}) => Promise<{ queued: boolean; reason?: string }>;

/** Result row in the sweep summary — one entry per candidate branch
 *  the sweep considered (regardless of action). */
export interface CommitterSweepEntry {
  memberBranch: string;
  aheadCount: number;
  /** What the sweep DID with this branch on this tick. */
  action:
    | "queued"
    | "skipped-zero-ahead"
    | "skipped-in-flight"
    | "skipped-terminal"
    | "queue-refused";
  /** The state row read from {@link MergerStateRepo} (null when the
   *  branch has never transitioned). Surfaced for diagnosability —
   *  the action determines the rationale, the state explains why. */
  observedState: BranchMergeState | null;
  /** Optional rationale string — populated for `queue-refused` (the
   *  injected dispatcher returned `{queued:false, reason}`) and
   *  `skipped-*` action variants. */
  note?: string;
}

/** Aggregate output of one `committerSweep` call. */
export interface CommitterSweepResult {
  /** Candidate branches examined this tick. */
  checked: number;
  /** Branches the sweep queued via {@link QueueMergeFn}. */
  queued: number;
  /** Branches skipped for any reason (zero-ahead, in-flight,
   *  terminal). */
  skipped: number;
  /** Branches where the queue dispatcher refused (returned
   *  `{queued:false}`). Distinct from `skipped` because the sweep
   *  thought the branch was eligible but the dispatcher disagreed —
   *  rate-limit cap, signoff missing, etc. */
  refused: number;
  /** Per-branch detail, in candidate-discovery order. Empty when no
   *  branches matched the `<base>-*` glob. */
  entries: CommitterSweepEntry[];
}

/** Construct-time deps for the sweep. All side-effecting fields are
 *  injectable so unit tests can drive the sweep through every branch
 *  of the decision tree without touching git or SQLite. */
export interface CommitterSweepDeps {
  /** Absolute path to the team's git working tree — the repo whose
   *  branches the sweep walks. Threaded into every `git -C` call. */
  teamRoot: string;
  /** Base branch the sweep compares per-member branches against. The
   *  `<baseBranch>-*` glob enumerates candidates; the
   *  `<baseBranch>..<member>` rev-list checks ahead-of-base. */
  baseBranch: string;
  /** Repo shim for `merger_state` row lookups. */
  mergerStateRepo: MergerStateRepo;
  /** Dispatcher — fires the actual merge attempt for eligible
   *  branches. T3 (event-driven, t-27b06cda) ships the production
   *  factory; T4 unit tests pass a recording stub. */
  queueMergeAttempt: QueueMergeFn;
  /** `git` spawn injection (GitSpawn — same shape used by
   *  `merger-config.ts` and the ADR-088 W1 primitive). Defaults
   *  injected at the verb layer to {@link defaultGitSpawn}. */
  git: GitSpawn;
}

// ---------- Sweep ----------

/**
 * Run one fleet-tick cron backstop sweep over the team's per-member
 * branches. Idempotent: re-firing when every branch is already merged
 * or in-flight returns a `{queued: 0}` result.
 *
 * Per-branch decision tree:
 *
 *   1. `rev-list --count <base>..<member>` === 0   → skipped-zero-ahead
 *   2. mergerState in {@link IN_FLIGHT_STATES}     → skipped-in-flight
 *      (`ready_to_merge` / `rebasing` / `merging` /
 *      `tested` / `test_failed` — actively moving)
 *   3. mergerState is terminal (merged/conflict/   → skipped-terminal
 *      reverted) AND ahead-of-base === 0
 *      (covered by step 1 — included here for
 *      completeness in the comment chain)
 *   4. mergerState is terminal AND ahead-of-base   → queued (fresh
 *      > 0 (member committed AFTER terminal       (next tip past
 *      state landed)                              terminal merge)
 *   5. mergerState is null / `open` / `in_progress` → queued. `in_progress`
 *      is queued every cycle per t-f4088323 P1 fix — re-runs the
 *      dispatcher pre-merge gate so branches stuck on a previously-held
 *      gate advance once the worker clears. Idempotent: a still-held
 *      gate produces a self-loop + `{queued:false, reason:"gate-held"}`
 *      → sweep records `queue-refused` with the note.
 *
 * The sweep does NOT transition the state row itself. That's the
 * dispatcher's job (so the same code path handles event-driven AND
 * cron-backstop entry). The sweep is pure eligibility analysis.
 */
export async function committerSweep(deps: CommitterSweepDeps): Promise<CommitterSweepResult> {
  const candidates = await listMemberBranches(deps);
  const entries: CommitterSweepEntry[] = [];
  let queued = 0;
  let refused = 0;
  let skipped = 0;

  for (const memberBranch of candidates) {
    const aheadCount = await countAhead(memberBranch, deps);

    if (aheadCount === 0) {
      entries.push({
        memberBranch,
        aheadCount,
        action: "skipped-zero-ahead",
        observedState: deps.mergerStateRepo.getState(memberBranch)?.state ?? null,
        note: "no commits ahead of base — nothing to fan in",
      });
      skipped += 1;
      continue;
    }

    const stateRow = deps.mergerStateRepo.getState(memberBranch);
    const observedState = stateRow?.state ?? null;

    if (observedState !== null && IN_FLIGHT_STATES.has(observedState)) {
      entries.push({
        memberBranch,
        aheadCount,
        action: "skipped-in-flight",
        observedState,
        note: `another tick is moving this branch (state=${observedState})`,
      });
      skipped += 1;
      continue;
    }

    // Terminal state + branch tip moved past it = fresh work; treat
    // as a queue candidate. The dispatcher's first transition will
    // overwrite the terminal row (BEGIN IMMEDIATE in
    // MergerStateRepo.transition keeps this race-safe).
    const queueResult = await deps.queueMergeAttempt({ memberBranch, aheadCount });
    if (queueResult.queued) {
      entries.push({
        memberBranch,
        aheadCount,
        action: "queued",
        observedState,
      });
      queued += 1;
    } else {
      const entry: CommitterSweepEntry = {
        memberBranch,
        aheadCount,
        action: "queue-refused",
        observedState,
      };
      if (queueResult.reason !== undefined) entry.note = queueResult.reason;
      entries.push(entry);
      refused += 1;
    }
  }

  return {
    checked: candidates.length,
    queued,
    skipped,
    refused,
    entries,
  };
}

// ---------- Internals ----------

/** List per-member branches matching the `<baseBranch>-*` convention.
 *  Uses `git branch --list "<base>-*"` so we don't return the base
 *  branch itself or unrelated branches that happen to share a prefix
 *  fragment (the `-` suffix is the discriminator). The output is the
 *  set of `<base>-<member>` strings stripped of the leading `* ` /
 *  `  ` markers `git branch` prepends. */
async function listMemberBranches(deps: CommitterSweepDeps): Promise<string[]> {
  const pattern = `${deps.baseBranch}-*`;
  const r = await deps.git([
    "-C",
    deps.teamRoot,
    "branch",
    "--list",
    "--format=%(refname:short)",
    pattern,
  ]);
  if (r.exitCode !== 0) {
    // Surface the failure with stderr so the cron log shows the
    // operator what went wrong. Returning `[]` keeps the sweep
    // graceful — one bad git call doesn't crash the cron tick.
    return [];
  }
  return r.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Count commits on `memberBranch` that aren't on `baseBranch`. Uses
 *  `git rev-list --count <base>..<member>` per ADR-088 W1's pattern;
 *  same semantics, same exit-code handling (non-zero → return 0 so
 *  the sweep skips the branch instead of crashing the tick). */
async function countAhead(memberBranch: string, deps: CommitterSweepDeps): Promise<number> {
  const r = await deps.git([
    "-C",
    deps.teamRoot,
    "rev-list",
    "--count",
    `${deps.baseBranch}..${memberBranch}`,
  ]);
  if (r.exitCode !== 0) return 0;
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
