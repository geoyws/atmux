// ADR-131 §D1 / T3: `atmux hygiene-tick` verb — superdoctor's
// kanban-hygiene pass. One drain action per invocation, bounded blast
// radius per ADR-077 §D3 authority gate.
//
// Invocation: the superdoctor agent fires this inside its hourly loop
// after the complaint-file pass and before the structural-fix pass.
// Output is JSON on stdout so the agent can parse + react:
//
//   {
//     "detected": <total fingerprints this tick>,
//     "unfixedAfter": <count of still-unfixed rows>,
//     "drained": { "row": {...}, "result": {...} } | null,
//     "skipReason": "no-unfixed" | "ladder-defer" | "",
//     "phantomPrune": { "detected": N, "prunedIds": [...],
//                       "alreadyPrunedIds": [...], "skipReason": "..." } | null
//   }
//
// Verbs the agent expects to exist (per ADR-131 §D6):
//   - `atmux task assign <id> <member>` (shipped pre-session)
//   - `atmux task lane <id> <lane>` (shipped via T4 / t-93b59741)
//   - `atmux task priority <id> <N>` (shipped via T4 / t-93b59741)
// Each verb is wrapped here as a `FixDeps` callback; tests inject
// recorders.
//
// t-d6fc03a7 (complaint c-368c375b): phantom-claim sub-op. Runs
// alongside (not inside) the 5-class drain — different shape
// (live-pane probe, age filter, status=in-progress only) and
// different sink (`tasks` table flip, not `superdoctor_hygiene` row
// upsert). Sub-op fires AFTER drainTick so the agent's JSON output
// surfaces both passes in one tick. Caller-injectable `liveMembers`
// probe + `nowSec` + `minAgeSec` keep tests deterministic.

import { join } from "node:path";
import { spawn as defaultSpawn, type SpawnResult } from "../abstractions/spawn.ts";
import { closeDatabase, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { createTmux } from "../abstractions/tmux.ts";
import { defaultGitSpawn, type GitSpawn } from "../abstractions/worktree.ts";
import {
  buildWindowName,
  getAtmuxDir,
  getSessionName,
  type ResolveDirOpts,
  requireTeam,
  resolveTeamSocket,
} from "../core/common.ts";
import { resolveMergerConfig } from "../core/merger-config.ts";
import {
  findPhantomInProgressClaims,
  formatPruneIso,
  type LiveMembersProbe,
  type PruneResult,
  prunePhantomInProgressClaims,
} from "../core/phantom-prune.ts";
import {
  type ReleaseNotesSweepResult,
  runReleaseNotesAutoAppend,
} from "../core/release-notes-sweep.ts";
import { HygieneRepo } from "../core/repositories/hygiene-repo.ts";
import { KanbanRepo } from "../core/repositories/kanban-repo.ts";
import type { FixDeps, TeamState } from "../core/superdoctor-hygiene/_shared.ts";
import { type DrainTickResult, drainTick } from "../core/superdoctor-hygiene/drain.ts";
import { UsageError } from "../errors.ts";

/** Default minimum age (seconds) before a phantom is opportunistically
 *  pruned by hygiene-tick. 24h matches t-d6fc03a7's spec — spares fresh
 *  claims that race the cron tick + only collects long-lived corpses
 *  the stop hook couldn't capture (session died non-gracefully). */
export const HYGIENE_TICK_PHANTOM_MIN_AGE_SEC = 86_400;

const USAGE =
  "atmux hygiene-tick [--team-dir <dir>] [--json] [--no-phantom-prune] [--no-release-notes]";

interface HygieneTickArgs {
  teamDir?: string;
  json: boolean;
  /** Skip the t-d6fc03a7 phantom-prune sub-op. Default = on. Operator
   *  opt-out for the rare diagnosis where the auto-prune is the
   *  suspect and they want the 5-class drain only. */
  phantomPrune: boolean;
  /** Skip the ADR-147 T8 release-notes auto-append sub-op. Default =
   *  on. Operator opt-out for the rare diagnosis where the append
   *  itself is the suspect; the drain + phantom-prune passes still
   *  fire normally. The sub-op is also short-circuited internally on
   *  any error (probe-failed) so explicit opt-out is mainly for
   *  symmetry with `--no-phantom-prune`. */
  releaseNotes: boolean;
}

export function parseHygieneTickArgs(argv: ReadonlyArray<string>): HygieneTickArgs {
  let teamDir: string | undefined;
  let json = true; // default to JSON output (agent-consumer assumption)
  let phantomPrune = true;
  let releaseNotes = true;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (a === "--no-json") {
      json = false;
      i += 1;
      continue;
    }
    if (a === "--no-phantom-prune") {
      phantomPrune = false;
      i += 1;
      continue;
    }
    if (a === "--no-release-notes") {
      releaseNotes = false;
      i += 1;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "hygiene-tick: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `hygiene-tick: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  const out: HygieneTickArgs = { json, phantomPrune, releaseNotes };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

/** Verb-injection surface for tests — production callers omit, get
 *  the real shell + system clock. */
export interface HygieneTickOpts {
  /** Override the FixDeps verb callbacks. Tests pass recorders;
   *  production shells through `atmux task <assign|lane|priority>`. */
  fixDeps?: FixDeps;
  /** Override `now` (epoch seconds). Tests freeze time for
   *  deterministic detected_at / last_seen_at assertions. */
  nowSeconds?: () => number;
  /** Override the live-pane probe for the t-d6fc03a7 phantom-prune
   *  sub-op. Tests inject a fixture Set; production defaults to a
   *  tmux probe via `team.tmuxTmpdir`-resolved socket + session
   *  enumeration (mirror of stop.ts's `runStopPhantomPrune`). */
  liveMembersProbe?: LiveMembersProbe;
  /** Override the minimum-age window (seconds) for the phantom-prune
   *  sub-op. Defaults to 24h (`HYGIENE_TICK_PHANTOM_MIN_AGE_SEC`).
   *  Tests pass `0` to disable filtering for fixture simplicity. */
  phantomMinAgeSec?: number;
  /** ADR-147 T8 release-notes auto-append sub-op overrides. Tests
   *  inject a stub `git` + an epoch-ms anchor for deterministic
   *  "today" boundaries. Production uses `defaultGitSpawn` + real
   *  clock. */
  releaseNotesGit?: GitSpawn;
  /** Epoch-ms anchor for the release-notes sub-op's "today" boundary.
   *  Defaults to `Date.now()`. Distinct from `nowSeconds` (which is
   *  the drain-loop's epoch-seconds clock) — the two clocks share no
   *  contract and tests routinely freeze one without the other. */
  releaseNotesNowMs?: number;
}

/** Output shape for the t-d6fc03a7 phantom-prune sub-op. Distinct
 *  from `DrainTickResult` because the prune writes to `tasks`, not
 *  `superdoctor_hygiene`. */
export interface HygieneTickPhantomResult {
  /** Phantoms detected this tick (post age + live-pane filter). */
  detected: number;
  /** Task IDs flipped to `blocked` this tick. */
  prunedIds: string[];
  /** Task IDs the helper saw but were already auto-pruned
   *  (idempotent re-call) — distinct from `prunedIds` so the JSON
   *  output can show "0 new, N already pruned". */
  alreadyPrunedIds: string[];
  /** When non-empty: a hint at why the sub-op short-circuited.
   *  Values:
   *    - `"disabled"` — `--no-phantom-prune` passed.
   *    - `"singleSession"` — team.singleSession is true (ADR-026,
   *       same skip the stop hook applies — there's no cage to
   *       probe against).
   *    - `"probe-failed"` — live-pane probe threw; sub-op aborted
   *       without writes.
   *    - `"no-candidates"` — every in-progress claim has a live
   *       pane (and/or claimedAt within the age window). */
  skipReason: "" | "disabled" | "singleSession" | "probe-failed" | "no-candidates";
}

/** ADR-147 T8 release-notes auto-append sub-op output. `null` when the
 *  sub-op short-circuits (skipReason populated). */
export interface HygieneTickReleaseNotesResult {
  /** Day-file path the sweep wrote to (or would have, in skip cases). */
  dayFilePath: string;
  /** Per-section append-vs-skip breakdown. `appended[]` lists the
   *  natural-key ids of entries that landed THIS tick; `skipped[]`
   *  lists ids the sweep saw but found already-recorded (idempotent
   *  re-fire). */
  shipped: { appended: string[]; skipped: string[] };
  merges: { appended: string[]; skipped: string[] };
  adrsLanded: { appended: string[]; skipped: string[] };
  /** Non-empty when the sub-op short-circuited:
   *    - `"disabled"` — `--no-release-notes` flag.
   *    - `"probe-failed"` — git or fs probe threw; sub-op aborted
   *      without writes. */
  skipReason: "" | "disabled" | "probe-failed";
}

/** Verb-level output — extends the drain-loop result with the
 *  t-d6fc03a7 phantom-prune sub-op outcome AND the ADR-147 T8
 *  release-notes auto-append sub-op outcome. */
export interface HygieneTickResult extends DrainTickResult {
  phantomPrune: HygieneTickPhantomResult | null;
  releaseNotes: HygieneTickReleaseNotesResult | null;
}

/** Default verb shells. Each invokes the atmux CLI in a subprocess so
 *  the fix routes through the same atomic SQL writes the operator
 *  would do manually. Failures throw — `fix()` catches and surfaces
 *  as `verb-failed` per the detector contract. */
function defaultFixDeps(): FixDeps {
  const run = async (sub: string, ...args: string[]): Promise<void> => {
    const r: SpawnResult = await defaultSpawn({
      cmd: "atmux",
      argv: ["task", sub, ...args],
      timeoutMs: 15_000,
      expectExitCode: "any",
    });
    if (r.exitCode !== 0) {
      throw new Error(
        `atmux task ${sub} ${args.join(" ")} failed (rc=${r.exitCode}): ${r.stderr.trim() || "(no stderr)"}`,
      );
    }
  };
  return {
    assignVerb: async (taskId, member) => run("assign", taskId, member),
    laneVerb: async (taskId, lane) => run("lane", taskId, lane),
    priorityVerb: async (taskId, priority) => run("priority", taskId, String(priority)),
  };
}

/** `atmux hygiene-tick` entry point. Returns the verb-level result
 *  (drain result + optional phantom-prune sub-op result) so callers
 *  (other verbs, tests) can chain; the CLI dispatcher ignores the
 *  return value (process exit code 0). */
export async function hygieneTick(
  argv: ReadonlyArray<string>,
  opts: HygieneTickOpts = {},
): Promise<HygieneTickResult> {
  const parsed = parseHygieneTickArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);
  const now = (opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();

  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  let drain: DrainTickResult;
  try {
    const kanban = new KanbanRepo(db).listTasks();
    const repo = new HygieneRepo(db);
    // Narrow Team → TeamState for the drain-loop signature.
    const teamState: TeamState = { members: team.members };
    drain = await drainTick({
      team: teamState,
      kanban,
      repo,
      deps: opts.fixDeps ?? defaultFixDeps(),
      now,
    });
  } finally {
    closeDatabase(db);
  }

  const phantomPrune = await runPhantomPrune({
    parsed,
    opts,
    team,
    atmuxDir,
    nowSec: now,
    dirOpts,
  });

  const releaseNotes = await runReleaseNotesAppend({
    parsed,
    opts,
    team,
    atmuxDir,
  });

  const result: HygieneTickResult = { ...drain, phantomPrune, releaseNotes };
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(formatHuman(result));
  }
  return result;
}

/** ADR-147 T8 release-notes auto-append sub-op. Polls kanban + git for
 *  today's done-tasks / merges / new-ADRs and appends a per-section
 *  entry to today's `docs/release-notes/<Y>/<M>/<Y-M-D>.md` (creating
 *  the skeleton if absent). Each append is idempotency-checked against
 *  the current day-file body — re-runs are no-op on already-recorded
 *  events.
 *
 *  Best-effort: any probe failure (git unreachable, fs error) degrades
 *  to `skipReason: "probe-failed"` rather than aborting the verb.
 *  `--no-release-notes` opt-outs short-circuit to
 *  `skipReason: "disabled"` — symmetric with `runPhantomPrune`'s
 *  posture. */
async function runReleaseNotesAppend(args: {
  parsed: HygieneTickArgs;
  opts: HygieneTickOpts;
  team: Awaited<ReturnType<typeof requireTeam>>;
  atmuxDir: string;
}): Promise<HygieneTickReleaseNotesResult> {
  const { parsed, opts, team, atmuxDir } = args;
  // The repoRoot we write release-notes into is the team's primary
  // worktree (i.e. parent of `.atmux/`). Mirror gitter.ts's resolution
  // so both verbs land notes at the same location.
  const repoRoot = atmuxDir.endsWith("/.atmux")
    ? atmuxDir.slice(0, -"/.atmux".length)
    : join(atmuxDir, "..");

  if (!parsed.releaseNotes) {
    return emptyReleaseNotesResult(repoRoot, "disabled");
  }

  const git: GitSpawn = opts.releaseNotesGit ?? defaultGitSpawn;
  const nowMs = opts.releaseNotesNowMs ?? Date.now();

  // baseBranch resolution: prefer the merger-config helper (same path
  // as gitter.ts), so `git log --merges <baseBranch>` reads the same
  // line of trunk operators reason about. Fall back to "HEAD" on
  // resolution failure — the merge probe still works, just scoped to
  // whichever branch is currently checked out.
  let baseBranch = "HEAD";
  try {
    const merger = await resolveMergerConfig(team, repoRoot, { git });
    baseBranch = merger.baseBranch;
  } catch {
    // Leave baseBranch as "HEAD" — degraded but functional.
  }

  // Re-open the kanban repo specifically for the sweep so the snapshot
  // is fresh post-drain (drainTick may have flipped task statuses).
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  let sweepResult: ReleaseNotesSweepResult;
  try {
    const kanban = new KanbanRepo(db).listTasks();
    sweepResult = await runReleaseNotesAutoAppend({
      repoRoot,
      baseBranch,
      kanban,
      git,
      nowMs,
    });
  } catch {
    closeDatabase(db);
    return emptyReleaseNotesResult(repoRoot, "probe-failed");
  }
  closeDatabase(db);

  return {
    dayFilePath: sweepResult.dayFilePath,
    shipped: sweepResult.shipped,
    merges: sweepResult.merges,
    adrsLanded: sweepResult.adrsLanded,
    skipReason: "",
  };
}

function emptyReleaseNotesResult(
  repoRoot: string,
  skipReason: HygieneTickReleaseNotesResult["skipReason"],
): HygieneTickReleaseNotesResult {
  // The sweep was skipped; expose a path-shaped placeholder for the
  // JSON output's consumer-side stability (path field is non-nullable).
  // We don't compute the real MYT path here to keep the skip branch
  // fully I/O-free.
  return {
    dayFilePath: `${repoRoot}/docs/release-notes/<skipped>`,
    shipped: { appended: [], skipped: [] },
    merges: { appended: [], skipped: [] },
    adrsLanded: { appended: [], skipped: [] },
    skipReason,
  };
}

/** t-d6fc03a7 phantom-prune sub-op. Idempotent, best-effort: probe
 *  failures degrade to `skipReason: "probe-failed"` rather than
 *  aborting the verb. Disabled paths (singleSession teams, opt-out
 *  flag) short-circuit to a structured skip so the agent-consumer
 *  can distinguish "nothing to do" from "fell through". */
async function runPhantomPrune(args: {
  parsed: HygieneTickArgs;
  opts: HygieneTickOpts;
  team: Awaited<ReturnType<typeof requireTeam>>;
  atmuxDir: string;
  nowSec: number;
  dirOpts: ResolveDirOpts;
}): Promise<HygieneTickPhantomResult> {
  const { parsed, opts, team, atmuxDir, nowSec } = args;
  if (!parsed.phantomPrune) {
    return emptyPhantomResult("disabled");
  }
  if (team.singleSession === true) {
    return emptyPhantomResult("singleSession");
  }

  const minAgeSec = opts.phantomMinAgeSec ?? HYGIENE_TICK_PHANTOM_MIN_AGE_SEC;
  const liveMembers: LiveMembersProbe =
    opts.liveMembersProbe ?? (() => defaultLiveMembersProbe(team, args.dirOpts));

  let phantoms: Awaited<ReturnType<typeof findPhantomInProgressClaims>>;
  try {
    phantoms = await findPhantomInProgressClaims({
      atmuxDir,
      team,
      liveMembers,
      minAgeSec,
      nowSec,
    });
  } catch {
    return emptyPhantomResult("probe-failed");
  }

  if (phantoms.length === 0) {
    return emptyPhantomResult("no-candidates");
  }

  const asOfIso = formatPruneIso(nowSec * 1000);
  let prune: PruneResult;
  try {
    prune = await prunePhantomInProgressClaims({
      atmuxDir,
      phantoms,
      asOfIso,
      source: "hygiene-tick",
    });
  } catch {
    return emptyPhantomResult("probe-failed");
  }

  return {
    detected: phantoms.length,
    prunedIds: prune.prunedIds,
    alreadyPrunedIds: prune.alreadyPrunedIds,
    skipReason: "",
  };
}

function emptyPhantomResult(
  skipReason: HygieneTickPhantomResult["skipReason"],
): HygieneTickPhantomResult {
  return { detected: 0, prunedIds: [], alreadyPrunedIds: [], skipReason };
}

/** Production live-members probe — mirror of stop.ts's same logic:
 *  resolve the cage socket from `team.tmuxTmpdir`, list windows on the
 *  team's session, intersect with the team roster's expected window
 *  names. Any failure (no session, tmux unreachable) short-circuits
 *  to an empty Set — the caller treats that as "no live members" and
 *  reports all in-progress claims as phantoms (subject to the age
 *  filter), matching the stop hook's fail-safe stance. */
async function defaultLiveMembersProbe(
  team: Awaited<ReturnType<typeof requireTeam>>,
  dirOpts: ResolveDirOpts,
): Promise<ReadonlySet<string>> {
  try {
    const sessionName = await getSessionName({ ...dirOpts, team });
    const socketPath = resolveTeamSocket(team);
    const tmux = createTmux({ socketPath });
    if (!(await tmux.session.hasSession(`=${sessionName}`))) return new Set();
    const windows = await tmux.window.listWindows(sessionName);
    const liveNames = new Set(windows.map((w) => w.name));
    const live = new Set<string>();
    for (const m of team.members) {
      // ADR-161 TR2: role-aware expected name (defaults → `_-prefix`).
      const expected = buildWindowName(m.name, m.emoji, m.label, m.role);
      if (liveNames.has(expected)) live.add(m.name);
    }
    return live;
  } catch {
    return new Set();
  }
}

function formatHuman(result: HygieneTickResult): string {
  const lines: string[] = [];
  lines.push(`hygiene-tick: ${result.detected} detected, ${result.unfixedAfter} unfixed`);
  if (result.drained !== null) {
    const r = result.drained;
    const fix = r.result.applied ? "applied" : `skipped (${r.result.reason ?? "?"})`;
    lines.push(`  drained: ${r.row.taskId} [${r.row.fingerprintClass}/${r.row.severity}] → ${fix}`);
  } else if (result.skipReason !== "") {
    lines.push(`  drain skipped: ${result.skipReason}`);
  }
  if (result.phantomPrune !== null) {
    const p = result.phantomPrune;
    if (p.skipReason !== "") {
      lines.push(`  phantom-prune skipped: ${p.skipReason}`);
    } else {
      lines.push(
        `  phantom-prune: ${p.detected} detected, ${p.prunedIds.length} pruned, ${p.alreadyPrunedIds.length} already pruned`,
      );
    }
  }
  if (result.releaseNotes !== null) {
    const rn = result.releaseNotes;
    if (rn.skipReason !== "") {
      lines.push(`  release-notes skipped: ${rn.skipReason}`);
    } else {
      const total =
        rn.shipped.appended.length + rn.merges.appended.length + rn.adrsLanded.appended.length;
      const skipped =
        rn.shipped.skipped.length + rn.merges.skipped.length + rn.adrsLanded.skipped.length;
      lines.push(
        `  release-notes: ${total} appended (${rn.shipped.appended.length} shipped, ${rn.merges.appended.length} merges, ${rn.adrsLanded.appended.length} adrs), ${skipped} skipped`,
      );
    }
  }
  return lines.join("\n") + "\n";
}
