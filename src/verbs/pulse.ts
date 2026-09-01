// ADR-086: `atmux pulse` — cockpit-wide deterministic verdict probe.
//
// Phase 1: deterministic verdict per team, dedup'd Discord ping on
// transitions + sustained-urgency re-fire. Phase 2 layers an LLM
// observer on top of the same gathered-inputs shape.
//
// Invocation:
//   atmux pulse [--json] [--ping] [--config <path>]
//
// Defaults:
//   - Reads `~/.atmux/cockpit.json` (override via `--config` /
//     `ATMUX_COCKPIT_CONFIG`).
//   - Iterates `enabledTeams(cockpit)`, gathers inputs per team, computes
//     verdict, runs the dedup gate, fires Discord on `didFire` when
//     `--ping` is set OR `ATMUX_DISCORD_WEBHOOK` is present.
//   - `--json` emits `[{team, verdict, commitCount, doctorRed, kanban,
//     driverInboxOpen, didFire, fireReason}, ...]` to stdout instead of
//     the human renderer.
//
// State: `~/.atmux/state/pulse-state.json` (cockpit-scoped, NOT per
// team). Written ONLY when at least one team fired this tick.

import { join } from "node:path";
import {
  send as defaultDiscordSend,
  renderMetaWatchdog,
  renderPulseVerdict,
} from "../abstractions/discord.ts";
import { exists, readTextOrNull } from "../abstractions/fs.ts";
import { tryReadJson } from "../abstractions/json.ts";
import { defaultGitSpawn, type GitSpawn } from "../abstractions/worktree.ts";
import { enabledTeams, loadCockpit } from "../core/cockpit.ts";
import { driverInboxPath, teamJsonPath } from "../core/common.ts";
import { parseEntries } from "../core/driver-inbox.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import { loadKanban } from "../core/kanban.ts";
import { kanbanWorkStateAvailable } from "../core/kanban-backend.ts";
import {
  DEFAULT_PULSE_DEDUP_LADDER,
  DEFAULT_PULSE_WINDOW_MIN,
  PULSE_DRIVER_INBOX_STALE_MIN,
  type PulseDedupLadder,
  type PulseState,
  type PulseStatePathOpts,
  pulseStatePath,
  readPulseState,
  shouldFire,
  writePulseState,
} from "../core/pulse-state.ts";
import {
  computeVerdict,
  describeVerdict,
  type PulseInputs,
  type PulseVerdict,
} from "../core/pulse-verdict.ts";
import {
  decideMetaWatchdogFire,
  gatherSuperdoctorActivity,
  type MetaWatchdogTeam,
} from "../core/superdoctor-activity.ts";
import { UsageError } from "../errors.ts";
import type { CockpitPulse, CockpitTeam } from "../schema/cockpit.ts";
import type { Team } from "../schema/team.ts";
import { Team as TeamSchema } from "../schema/team.ts";
import {
  buildReport,
  type DoctorReport,
  type DoctorRow,
  runAllChecks as defaultRunDoctorChecks,
} from "./doctor.ts";
import { isRenameInProgress } from "./team-rename-fs.ts";

const USAGE = "atmux pulse [--json] [--ping] [--config <path>]";

// ---------- Args ----------

export interface PulseArgs {
  json: boolean;
  /** Force Discord send even when `ATMUX_DISCORD_WEBHOOK` is unset
   *  (test injection path can record via webhookOverride). When false
   *  AND `ATMUX_DISCORD_WEBHOOK` is unset, ping is skipped. */
  ping: boolean;
  configPath?: string;
}

export function parsePulseArgs(argv: ReadonlyArray<string>): PulseArgs {
  let json = false;
  let ping = false;
  let configPath: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (a === "--ping") {
      ping = true;
      i += 1;
      continue;
    }
    if (a === "--config") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "pulse: --config requires a value", hint: USAGE });
      }
      configPath = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `pulse: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  const out: PulseArgs = { json, ping };
  if (configPath !== undefined) out.configPath = configPath;
  return out;
}

// ---------- Inputs gathering ----------

/** Per-team observation surfaced both to verdict logic + JSON output. */
export interface PulseObservation extends PulseInputs {
  team: string;
  root: string;
  /** Total open driver-inbox entries (any age) — surfaced as a footer
   *  count; the staleness gate is `staleDriverInboxCount` above. */
  driverInboxOpen: number;
}

export interface GatherInputsDeps {
  /** Git spawn override (test injection). Defaults to `defaultGitSpawn`. */
  gitSpawn?: GitSpawn;
  /** Now (epoch seconds, test injection). */
  nowSec: number;
  /** Window minutes from cockpit.pulse.windowMins (or default). */
  windowMin: number;
  /** Override the doctor check runner (test injection). Defaults to
   *  `runAllChecks` from `src/verbs/doctor.ts`. Tests inject a stub
   *  that returns a fixed `red` count without needing a real
   *  environment (tmux / git / claude / etc on PATH). */
  runDoctor?: (atmuxDir: string, team: Team | null) => Promise<DoctorRow[]>;
  /** Writer for kanban-load failures (test injection). When unset,
   *  failures are silently swallowed — pulse is a best-effort probe. */
  stderr?: Writer;
}

/** Gather per-team observation inputs (read-only, no side effects). */
export async function gatherTeamInputs(
  team: CockpitTeam,
  deps: GatherInputsDeps,
): Promise<PulseObservation> {
  const atmuxDir = join(team.root, ".atmux");
  const git = deps.gitSpawn ?? defaultGitSpawn;

  // 1. git log --since=<windowMin>min --oneline | wc -l (root repo only).
  let commitCount = 0;
  try {
    const res = await git(["-C", team.root, "log", `--since=${deps.windowMin}min`, "--oneline"]);
    if (res.exitCode === 0) {
      const lines = res.stdout.split("\n").filter((l) => l.trim().length > 0);
      commitCount = lines.length;
    }
  } catch {
    // expected: not a git repo / git missing / cwd vanished
    commitCount = 0;
  }

  // 2. Load team.json (defensive — missing/invalid team.json yields
  //    null and the doctor probe surfaces a red row anyway).
  let teamShape: Team | null = null;
  try {
    teamShape = await tryReadJson(teamJsonPath(atmuxDir), TeamSchema);
  } catch {
    teamShape = null;
  }

  // 3. Doctor probe — same in-process pipeline as `atmux doctor --json`.
  let doctorRed = 0;
  const runDoctor = deps.runDoctor ?? defaultRunDoctorChecks;
  try {
    const rows: DoctorRow[] = await runDoctor(atmuxDir, teamShape);
    const report: DoctorReport = buildReport(rows);
    doctorRed = report.redCount;
  } catch {
    doctorRed = 0; // collapse on probe failure — surface as Idle, not Stalled.
  }

  // 4. Kanban inProgress + todo counts. Only attempt load if there's
  //    a kanban store on disk (state.db OR kanban.json) — else the
  //    JSON-fallback path's atomicWrite-on-read would create a stub.
  let inProgressCount = 0;
  let todoCount = 0;
  if ((await kanbanWorkStateAvailable(atmuxDir)) && (await exists(atmuxDir))) {
    try {
      const k = await loadKanban(atmuxDir);
      for (const t of k.tasks) {
        if (t.status === "in-progress") inProgressCount += 1;
        else if (t.status === "todo") todoCount += 1;
      }
    } catch (e) {
      // Schema drift / parse failure — log via injected stderr and
      // treat as empty. Pulse is a probe; a malformed kanban shouldn't
      // crash the cockpit-wide tick (doctor surfaces the schema row).
      if (deps.stderr !== undefined) {
        deps.stderr(
          `pulse: kanban load failed for ${team.name}: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }
  }

  // 5. Driver-inbox open + stale counts.
  let driverInboxOpen = 0;
  let staleDriverInboxCount = 0;
  const di = driverInboxPath(atmuxDir);
  const diBody = await readTextOrNull(di);
  if (diBody !== null) {
    const entries = parseEntries(diBody, deps.nowSec);
    for (const e of entries) {
      if (entryHasTriageMarker(e.body)) continue;
      driverInboxOpen += 1;
      const ts = e.tsEpochSec;
      if (ts === null) {
        // Undated entries are always conservative — count as stale so
        // the operator notices the malformed header.
        staleDriverInboxCount += 1;
        continue;
      }
      const ageMin = (deps.nowSec - ts) / 60;
      if (ageMin >= PULSE_DRIVER_INBOX_STALE_MIN) {
        staleDriverInboxCount += 1;
      }
    }
  }

  // 6. Pending-decisions.md — count 🔵 Decisions Needed entries (the
  //    escalation tier, not the auto-resolution tier).
  const pendingDecisionsPath = join(team.root, "docs", "pending-decisions.md");
  const pdBody = await readTextOrNull(pendingDecisionsPath);
  const pendingDecisionsCount = pdBody === null ? 0 : countBluePendingDecisions(pdBody);

  // 7. Window age — anchor on team.json mtime when present, else 0.
  //    Phase 1 keeps this simple; Phase 2 may pull from
  //    `<atmuxDir>/state/session-start.txt` for tighter accuracy.
  const windowAgeMin = deps.windowMin; // assume fully aged in Phase 1

  return {
    team: team.name,
    root: team.root,
    commitCount,
    doctorRed,
    inProgressCount,
    todoCount,
    staleDriverInboxCount,
    pendingDecisionsCount,
    windowMin: deps.windowMin,
    windowAgeMin,
    driverInboxOpen,
  };
}

/** True iff the entry body contains any triage marker — same set as
 *  ADR-085's needs-approval scan. */
export function entryHasTriageMarker(body: string): boolean {
  return body.includes("✅") || body.includes("📤") || body.includes("⏳") || body.includes("❌");
}

/** Count `🔵 Decisions Needed` entries in pending-decisions.md. Matches
 *  any line starting (after optional whitespace) with `🔵`. */
export function countBluePendingDecisions(body: string): number {
  let n = 0;
  for (const line of body.split("\n")) {
    if (/^\s*🔵/.test(line)) n += 1;
  }
  return n;
}

// ---------- Verb entry ----------

export interface PulseTickResult {
  team: string;
  verdict: PulseVerdict;
  body: string;
  commitCount: number;
  doctorRed: number;
  inProgressCount: number;
  todoCount: number;
  driverInboxOpen: number;
  pendingDecisionsCount: number;
  staleDriverInboxCount: number;
  didFire: boolean;
  fireReason: "first-observation" | "transition" | "sustained-urgency" | "deduped";
}

export interface PulseOpts {
  stdout?: Writer;
  stderr?: Writer;
  /** Clock injection (epoch ms). */
  now?: () => number;
  /** Override env (cockpit.json resolution + HOME for state path). */
  env?: NodeJS.ProcessEnv;
  /** Override the state path resolution (test injection). */
  statePathOpts?: PulseStatePathOpts;
  /** Override the gather-step git spawn. */
  gitSpawn?: GitSpawn;
  /** Discord send override. */
  discordSend?: typeof defaultDiscordSend;
  /** Doctor runner override (test injection). */
  runDoctor?: (atmuxDir: string, team: Team | null) => Promise<DoctorRow[]>;
}

/** `atmux pulse [--json] [--ping] [--config <path>]`. */
export async function pulse(argv: ReadonlyArray<string>, opts: PulseOpts = {}): Promise<number> {
  const parsed = parsePulseArgs(argv);
  const stdout = opts.stdout ?? defaultStdoutWrite;
  const stderr = opts.stderr ?? defaultStderrWrite;
  const clock = opts.now ?? Date.now;
  const env = opts.env ?? process.env;
  const send = opts.discordSend ?? defaultDiscordSend;

  const nowMs = clock();
  const nowSec = Math.floor(nowMs / 1000);

  const loadOpts: { env: NodeJS.ProcessEnv; path?: string } = { env };
  if (parsed.configPath !== undefined) loadOpts.path = parsed.configPath;
  const cockpit = await loadCockpit(loadOpts);

  const pulseCfg: CockpitPulse = cockpit.pulse ?? {};
  const windowMin = pulseCfg.windowMins ?? DEFAULT_PULSE_WINDOW_MIN;
  // ADR-086 §Phase 1.5: resolve the per-verdict ladder. Resolution
  // precedence:
  //   1. Operator-supplied `dedupLadderMins` MERGED OVER the default
  //      (missing verdicts inherit; explicit null disables re-fire).
  //   2. Legacy `dedupMins` flat int (Phase 1 / 1.1) populates the
  //      ladder UNIFORMLY when no ladder is supplied — backward-compat
  //      for operator configs frozen before §Phase 1.5.
  //   3. No operator pulse config at all → DEFAULT_PULSE_DEDUP_LADDER
  //      verbatim.
  const dedupLadderMins = resolveDedupLadder(pulseCfg);

  // Gather inputs per enabled team.
  const teams = enabledTeams(cockpit);
  const observations: PulseObservation[] = [];
  for (const team of teams) {
    // ADR-027 §Consequences — rename.lock guard. team.json + cron
    // markers may be mid-mutation during a rename; gathering inputs
    // (reads team.json + kanban + driver-inbox + cron state) against
    // an in-flight rename surfaces an indeterminate verdict that
    // would resolve correctly on the next tick. Skip silently.
    if (await isRenameInProgress(join(team.root, ".atmux"))) {
      stderr(`pulse: ${team.name}: skipping — rename.lock present (ADR-027)\n`);
      continue;
    }
    const obs = await gatherTeamInputs(team, {
      ...(opts.gitSpawn !== undefined ? { gitSpawn: opts.gitSpawn } : {}),
      ...(opts.runDoctor !== undefined ? { runDoctor: opts.runDoctor } : {}),
      nowSec,
      windowMin,
      stderr,
    });
    observations.push(obs);
  }

  // Read prior state.
  const statePath = pulseStatePath(opts.statePathOpts ?? { env });
  const prior: PulseState = await readPulseState(statePath);
  const nextTeams: PulseState["teams"] = { ...prior.teams };

  const tickResults: PulseTickResult[] = [];
  for (const obs of observations) {
    const verdict = computeVerdict(obs);
    const body = describeVerdict(obs, verdict);
    const priorRow = prior.teams[obs.team] ?? null;
    const fireDecision = shouldFire({
      prior: priorRow,
      current: verdict,
      currentCommitCount: obs.commitCount,
      nowSec,
      dedupLadderMins,
    });

    if (fireDecision.didFire && fireDecision.next !== null) {
      nextTeams[obs.team] = fireDecision.next;
    }

    tickResults.push({
      team: obs.team,
      verdict,
      body,
      commitCount: obs.commitCount,
      doctorRed: obs.doctorRed,
      inProgressCount: obs.inProgressCount,
      todoCount: obs.todoCount,
      driverInboxOpen: obs.driverInboxOpen,
      pendingDecisionsCount: obs.pendingDecisionsCount,
      staleDriverInboxCount: obs.staleDriverInboxCount,
      didFire: fireDecision.didFire,
      fireReason: fireDecision.reason,
    });
  }

  // t-351318dc: meta-watchdog — aggregate superdoctor liveness across
  // every team's complaint box + attempts log, then decide whether to
  // emit a `[meta-watchdog]` page this tick. Failure-isolated: any
  // exception collapses to "skip the meta-watchdog this tick" without
  // crashing the verdict pulse.
  const metaWatchdogTeams: MetaWatchdogTeam[] = teams.map((t) => ({ name: t.name, root: t.root }));
  let metaDecision: ReturnType<typeof decideMetaWatchdogFire> | null = null;
  let metaActivity: ReturnType<typeof gatherSuperdoctorActivity> | null = null;
  try {
    metaActivity = gatherSuperdoctorActivity(metaWatchdogTeams, { nowSec });
    metaDecision = decideMetaWatchdogFire({
      activity: metaActivity,
      prior: prior.metaWatchdog ?? null,
      nowSec,
    });
  } catch (e) {
    stderr(`pulse: meta-watchdog probe failed (continuing): ${stringifyErr(e)}\n`);
  }

  // Persist state if anything fired (verdict OR meta-watchdog).
  const anyFired = tickResults.some((r) => r.didFire);
  const metaStreakChanged =
    metaDecision !== null &&
    (metaDecision.next.paged !== (prior.metaWatchdog?.paged ?? false) ||
      metaDecision.next.dormantSinceSec !== (prior.metaWatchdog?.dormantSinceSec ?? null));
  if (anyFired || metaStreakChanged) {
    const out: PulseState = anyFired ? { teams: nextTeams } : { teams: prior.teams };
    if (metaDecision !== null) {
      out.metaWatchdog = metaDecision.next;
    }
    await writePulseState(statePath, out);
  }

  // Discord — gated behind --ping OR webhook env presence.
  const webhookSet = (env.ATMUX_DISCORD_WEBHOOK ?? "").length > 0;
  const recorderSet = (env.ATMUX_DISCORD_RECORDER ?? "").length > 0;
  const shouldPing = parsed.ping || webhookSet || recorderSet;
  if (shouldPing) {
    for (const r of tickResults) {
      if (!r.didFire) continue;
      try {
        await send(
          renderPulseVerdict({
            team: r.team,
            verdict: r.verdict,
            body: r.body,
            commitCount: r.commitCount,
            inProgressCount: r.inProgressCount,
            driverInboxOpen: r.driverInboxOpen,
            fireReason: r.fireReason,
            windowMin,
            whenMs: nowMs,
          }),
        );
      } catch (e) {
        stderr(`pulse: Discord send failed for ${r.team} (continuing): ${stringifyErr(e)}\n`);
      }
    }

    // Meta-watchdog send — separate emit, separate failure mode.
    if (metaDecision !== null && metaDecision.shouldFire && metaActivity !== null) {
      const oldest = metaActivity.oldest;
      const dormantSec =
        metaActivity.latestAttemptedAtSec === null
          ? null
          : Math.max(0, nowSec - metaActivity.latestAttemptedAtSec);
      try {
        await send(
          renderMetaWatchdog({
            cockpit: cockpit.cockpitSession ?? "cockpit",
            openComplaints: metaActivity.openComplaints,
            dormantSec,
            oldestComplaintSummary: oldest?.summary ?? "",
            oldestComplaintTeam: oldest?.team ?? "",
            oldestComplaintAgeSec: oldest?.ageSec ?? 0,
            whenMs: nowMs,
          }),
        );
      } catch (e) {
        stderr(`pulse: meta-watchdog Discord send failed (continuing): ${stringifyErr(e)}\n`);
      }
    }
  }

  // Output.
  if (parsed.json) {
    stdout(`${JSON.stringify(tickResults, null, 2)}\n`);
    return 0;
  }
  for (const r of tickResults) {
    stdout(
      `${r.verdict}  ${r.team.padEnd(20)} commits=${r.commitCount} doctorRed=${r.doctorRed} inProgress=${r.inProgressCount} todo=${r.todoCount} inbox=${r.driverInboxOpen} decisions=${r.pendingDecisionsCount}  fire=${r.fireReason}\n`,
    );
  }
  return 0;
}

function stringifyErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * ADR-086 §Phase 1.5: resolve the per-verdict dedup ladder from
 * operator config. Three branches:
 *
 *   1. `dedupLadderMins` is set — merge OVER the default ladder
 *      (operator entries win; missing verdicts inherit; explicit
 *      `null` disables re-fire for that verdict).
 *   2. `dedupLadderMins` is unset BUT legacy `dedupMins` is set —
 *      uniform-fill the ladder with the flat int (backward-compat
 *      for pre-§1.5 operator configs).
 *   3. Neither set — return `DEFAULT_PULSE_DEDUP_LADDER` verbatim.
 *
 * Pure helper — testable directly via the unit test fixture without
 * a full verb-tick spin.
 */
export function resolveDedupLadder(pulseCfg: CockpitPulse): PulseDedupLadder {
  // Branch 1: explicit per-verdict overrides.
  if (pulseCfg.dedupLadderMins !== undefined) {
    return { ...DEFAULT_PULSE_DEDUP_LADDER, ...pulseCfg.dedupLadderMins };
  }
  // Branch 2: legacy flat-int populates the ladder uniformly. Note:
  // the legacy semantic only re-fires on URGENT verdicts; we replicate
  // that by uniform-filling 🔴 / 🚨 with the int and keeping 🟡 / 🟢
  // at the default-ladder values. This preserves Phase 1 / 1.1
  // behaviour exactly for configs that hadn't moved to the ladder yet.
  if (pulseCfg.dedupMins !== undefined) {
    return {
      ...DEFAULT_PULSE_DEDUP_LADDER,
      "🔴 Stalled": pulseCfg.dedupMins,
      "🚨 Need you": pulseCfg.dedupMins,
    };
  }
  // Branch 3: vanilla defaults.
  return DEFAULT_PULSE_DEDUP_LADDER;
}
