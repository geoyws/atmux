// ADR-272 §Supplement — the voice e2e harness orchestrator.
//
// Order of operations is the safety property, so it is spelled out here
// rather than left to the reader:
//
//   1. mkdtemp                     — nothing exists yet
//   2. read the operator's REAL cockpit, read-only, for the disjointness check
//   3. per CAGE GROUP:
//      a. plan + materialize the cage (files, then tmux on ITS OWN socket)
//      b. pin HOME + ATMUX_COCKPIT_CONFIG into it, on `process.env`
//      c. **assertIsolated** — refuse before anything is spoken to
//      d. start the server on an ephemeral port, at that cage's posture
//      e. per scenario: synthesize → drive → judge → CHECK THE CAGE
//      f. stop the server, tear the cage down
//   4. restore HOME, remove the temp root — always
//
// Step 3b mutates `process.env` deliberately. The cockpit is resolved at
// CALL time by the fleet verbs (`loadCockpit()` defaults to `process.env`),
// not captured at boot, so passing an env object downward would leave the
// real path live for every tool the model invokes. Pinning the process env
// is the only override that actually reaches them.
//
// Step 3c runs AFTER the cage is built and BEFORE the server starts. That
// ordering is intentional: the gate checks what is really on disk (the
// cockpit file's contents, each team's `tmuxTmpdir` and each entry's
// ROOT), which it cannot do before the files exist — and nothing has been
// addressed by then, because `materializeCage` only ever touches sockets
// under the temp root.
//
// ---------------------------------------------------------------------
// Why a cage per GROUP rather than one cage per run (ADR-272 §Supplement E6)
// ---------------------------------------------------------------------
//
// The read-only scenarios could share one cage because none of them
// changed it. The mutating ones cannot, twice over:
//
//   - A scenario that nudges a pane INVALIDATES the ground-truth briefing
//     every later scenario in that cage is graded against. The judge would
//     be marking answers against a description that stopped being true
//     halfway through the run, and the resulting failures would look like
//     model faults.
//   - Two mutating scenarios in one cage each assert a receipt count the
//     other is permitted to move, so neither assertion means anything.
//
// The gate runs afresh for every group. A cage that is built, proven and
// destroyed is a much smaller thing to reason about than one long-lived
// cage whose posture changes underneath it — and the `readonly: false`
// posture is scoped to exactly the group that asked for it, so a later
// read-only group cannot inherit it.

import { join } from "node:path";
import { z } from "zod";
import { tryParseJsonString } from "../../../abstractions/json.ts";
import type { TmuxNamespace } from "../../../abstractions/tmux.ts";
import type { ToolBridge } from "../tool-bridge.ts";
import {
  formatPostconditions,
  type PostconditionContext,
  type PostconditionResult,
  runPostconditions,
} from "./assertions.ts";
import { buildCagePlan, type CageIo, type CagePlan, destroyCage, materializeCage } from "./cage.ts";
import { type DriveResult, driveTurns } from "./drive.ts";
import {
  groundTruthBriefing,
  requiredStaleSec,
  TEAM_FIXTURES,
  type TeamFixture,
} from "./fixtures.ts";
import {
  assertIsolated,
  COCKPIT_ENV,
  formatIsolationReport,
  type IsolationReport,
  isUnder,
} from "./isolation.ts";
import { BASE_CRITERIA, type JudgeCriterion, type JudgeOutcome, runJudge } from "./judge.ts";
import type { ReplayContext } from "./replay.ts";
import {
  checkToolGate,
  MUT_TEAM,
  READ_CAGE,
  type Scenario,
  scenarioCageKey,
  scenarioPostconditions,
  scenarioTurns,
  type ToolGateResult,
} from "./scenarios.ts";
import { synthesize } from "./tts.ts";

/** Minimum token length the voice config enforces (ADR-272 security L2). */
export const HARNESS_TOKEN_MIN = 32;

/** Fixtures a scenario gets when it does not name a set. */
const DEFAULT_FIXTURES = TEAM_FIXTURES;

/**
 * Session id the `protocol` scenarios bind their confirmation tokens to.
 *
 * A constant rather than a uuid: the D7 binding includes the session id,
 * so a value that changed between the issue and the redeem would turn
 * every redemption into a mismatch and the scenario would go green having
 * proven only that mismatches are refused — which is one third of what it
 * exists to prove.
 */
export const PROTOCOL_SESSION_ID = "vox-e2e-protocol";

export interface ServerHandle {
  url: string;
  stop: () => void | Promise<void>;
  /**
   * The RUNNING server's tool bridge — the same instance the websocket
   * sessions call, with the same confirm store.
   *
   * Present so a `protocol` scenario can exercise the D7 gate against the
   * live server rather than against a bridge it built itself. A
   * separately-constructed bridge would test this module's idea of the
   * wiring; the server's own bridge tests the wiring the phone reaches.
   */
  bridge?: ToolBridge;
}

export interface HarnessIo extends CageIo {
  mkdtemp: (prefix: string) => Promise<string>;
  readFile: (path: string) => Promise<string | null>;
  rm: (path: string) => Promise<void>;
  readBytes: (path: string) => Promise<Uint8Array | null>;
  writeBytes: (path: string, bytes: Uint8Array) => Promise<void>;
}

export interface HarnessDeps {
  io: HarnessIo;
  /** Mutable process environment. Pinned in step 2. */
  env: NodeJS.ProcessEnv;
  uid: number;
  openaiKey: string;
  anthropicKey: string;
  /** Injected because core must not import from `src/verbs/**`. */
  startServer: (opts: {
    cockpitPath: string;
    home: string;
    token: string;
    /**
     * The posture for THIS cage's server, and nothing else.
     *
     * Passed as a value rather than read from the environment on purpose
     * — see `isolation.ts` §READONLY_ENV. Each group's server is built
     * fresh, so a `false` here cannot survive into the next group.
     */
    readonly: boolean;
  }) => Promise<ServerHandle>;
  scenarios: ReadonlyArray<Scenario>;
  /** Vox-session auth token; must be ≥ 32 chars. */
  token: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Seams so the unit suite can drive the orchestration without a network. */
  drive?: typeof driveTurns;
  judge?: typeof runJudge;
  tts?: typeof synthesize;
  /**
   * Where synthesized speech is cached. Defaults to a directory INSIDE the
   * temp root, which is fine for tests but defeats the point in production:
   * the temp root is removed on exit, so every run would re-synthesize and
   * re-bill. The script passes a stable path outside it so re-runs are free
   * and byte-identical.
   */
  ttsCacheDir?: string;
  /** Keep the temp dir on exit (debugging). */
  keepTemp?: boolean;
}

export interface ScenarioOutcome {
  scenario: Scenario;
  /** Null for a `protocol` scenario, which speaks to nobody. */
  drive: DriveResult | null;
  toolGate: ToolGateResult;
  judge: JudgeOutcome | null;
  /** What was true of the CAGE afterwards. Empty for the read scenarios. */
  postconditions: PostconditionResult[];
  /** Every gate must hold. */
  pass: boolean;
  failure: string | null;
}

export interface HarnessResult {
  /** One per cage group, in the order the groups ran. */
  isolations: IsolationReport[];
  scenarios: ScenarioOutcome[];
  pass: boolean;
}

/** Scenarios sharing one cage, and the cage they share. */
export interface CageGroup {
  key: string;
  fixtures: ReadonlyArray<TeamFixture>;
  mutations: boolean;
  scenarios: Scenario[];
}

/**
 * Partition scenarios into cage groups, preserving first-seen order.
 *
 * Deliberately NOT a sort: the read cage is expensive to build (its
 * residue fixture must age past `RESIDUE_FRESH_SEC` before it classifies
 * as wedged), so re-ordering scenarios would silently change what a run
 * costs. First-seen order also means `--scenario <id>` builds exactly one
 * cage — the one that scenario asked for.
 *
 * A group's fixtures and posture come from its FIRST member; a later
 * member of the same key declaring different ones is a scenario-table bug
 * and is refused here rather than silently resolved, because "which
 * fixtures did this cage actually get" is not a question a failing run
 * should have to answer.
 */
export function groupScenarios(scenarios: ReadonlyArray<Scenario>): CageGroup[] {
  const groups: CageGroup[] = [];
  const byKey = new Map<string, CageGroup>();
  for (const s of scenarios) {
    const key = scenarioCageKey(s);
    const fixtures = s.fixtures ?? undefined;
    const mutations = s.mutations === true;
    const existing = byKey.get(key);
    if (existing === undefined) {
      const group: CageGroup = {
        key,
        fixtures: fixtures ?? DEFAULT_FIXTURES,
        mutations,
        scenarios: [s],
      };
      groups.push(group);
      byKey.set(key, group);
      continue;
    }
    if (existing.mutations !== mutations) {
      throw new Error(
        `vox-e2e: cage '${key}' is claimed by scenarios with different mutation postures — split the cage key`,
      );
    }
    if (fixtures !== undefined && fixtures !== existing.fixtures) {
      throw new Error(
        `vox-e2e: cage '${key}' is claimed by scenarios with different fixtures — split the cage key`,
      );
    }
    existing.scenarios.push(s);
  }
  return groups;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Teardown guard: refuse to kill a tmux session on a socket outside the
 * harness's temp root.
 *
 * Extracted rather than inlined so it can be tested directly. With a
 * well-formed plan every socket is under the temp root, so the refusal is
 * unreachable in production — and an unreachable safety check that is also
 * untested is one nobody will notice has stopped working.
 */
export function assertKillableSocket(tempRoot: string, socketPath: string): void {
  if (!isUnder(tempRoot, socketPath)) {
    throw new Error(
      `vox-e2e: refusing to kill a tmux session on ${socketPath} — outside ${tempRoot}`,
    );
  }
}

/**
 * Milliseconds still to wait before the residue fixture is old enough to
 * classify as a wedge rather than as someone typing.
 *
 * Expressed as a top-up from when the panes were painted, so the time spent
 * synthesizing speech and booting the server counts toward it — on a warm
 * TTS cache this is usually the only real wait, and on a cold one it is
 * often zero.
 */
export function computeStaleWaitMs(
  paintedAtMs: number,
  nowMs: number,
  requiredSec: number,
): number {
  const elapsed = nowMs - paintedAtMs;
  return Math.max(0, requiredSec * 1000 - elapsed);
}

/** Cockpit shape, read tolerantly — we only want names. */
const LooseCockpit = z
  .object({
    sessions: z.array(z.unknown()).optional(),
    teams: z.array(z.unknown()).optional(),
  })
  .passthrough();

/**
 * Team names in the operator's REAL cockpit, read strictly read-only.
 *
 * Best-effort by design: a missing or unparseable operator cockpit must not
 * stop the harness, because the structural checks in `assertIsolated` are
 * what actually guarantee isolation. This only sharpens the evidence.
 */
export function extractTeamNames(raw: string | null): string[] {
  return extractTeamEntries(raw).map((e) => e.name);
}

/**
 * Team NAME and ROOT from a cockpit file.
 *
 * The root is what the fleet verbs actually address (`loadCockpit` hands
 * each entry's `root` to `--team-dir`), so the isolation gate needs both:
 * a name-only read can prove the cockpit lists the right labels while a
 * root underneath one of them points anywhere at all. An entry with no
 * usable `root` string yields `""`, which the gate refuses as "not under
 * the temp root" — the correct answer for a cockpit whose shape we cannot
 * account for.
 */
export function extractTeamEntries(raw: string | null): Array<{ name: string; root: string }> {
  if (raw === null) return [];
  const parsed = tryParseJsonString(raw, LooseCockpit);
  if (parsed === null) return [];
  const entries: Array<{ name: string; root: string }> = [];
  const walk = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (typeof node !== "object" || node === null) continue;
      const rec = node as Record<string, unknown>;
      if (typeof rec.name === "string") {
        entries.push({ name: rec.name, root: typeof rec.root === "string" ? rec.root : "" });
      }
      if (Array.isArray(rec.sessions)) walk(rec.sessions);
    }
  };
  walk(parsed.sessions ?? []);
  walk(parsed.teams ?? []);
  return entries;
}

/** Criteria for a scenario: the shared base plus its own. */
export function criteriaFor(scenario: Scenario): JudgeCriterion[] {
  return [...BASE_CRITERIA, ...scenario.criteria];
}

/**
 * Fold a scenario's gates into one outcome.
 *
 * Ordering is by DIAGNOSTIC VALUE, not by severity: a dead session
 * explains a missing tool call, which explains a judge failure, so the
 * first thing that broke is the thing reported. The postconditions come
 * LAST for the opposite reason — they are the only gate that describes
 * the fleet rather than the conversation, so when they fail alongside a
 * judge verdict the cage evidence is what the reader needs, and it is
 * still printed in full either way (`formatPostconditions`).
 *
 * A `protocol` scenario has no drive, no tool gate and no judge; its
 * postconditions ARE the scenario, and an empty list would make it pass
 * vacuously — so that case is refused explicitly.
 */
export function decideScenario(
  scenario: Scenario,
  drive: DriveResult | null,
  toolGate: ToolGateResult,
  judge: JudgeOutcome | null,
  postconditions: PostconditionResult[] = [],
): ScenarioOutcome {
  const failedPost = postconditions.filter((p) => !p.pass);
  let failure: string | null = null;
  if (scenario.protocol !== undefined) {
    if (postconditions.length === 0) {
      failure = "protocol scenario produced no assertions at all";
    } else if (failedPost.length > 0) {
      failure = `cage: ${failedPost.map((p) => p.id).join(", ")}`;
    }
    return { scenario, drive, toolGate, judge, postconditions, pass: failure === null, failure };
  }
  if (drive === null) failure = "no session was driven";
  else if (!drive.ok) failure = `session failed: ${drive.failure ?? "unknown"}`;
  else if (!toolGate.ok) failure = `tool gate: ${toolGate.reason ?? "unknown"}`;
  else if (judge === null) failure = "judge did not return a verdict";
  else if (!judge.pass) {
    const failed = judge.verdict.criteria.filter((c) => !c.pass).map((c) => c.id);
    const bits = [failed.length > 0 ? `failed criteria: ${failed.join(", ")}` : ""];
    if (judge.verdict.hallucinations.length > 0) {
      bits.push(`hallucinations: ${judge.verdict.hallucinations.join("; ")}`);
    }
    if (judge.missingCriteria.length > 0) {
      bits.push(`missing criteria: ${judge.missingCriteria.join(", ")}`);
    }
    failure = `judge: ${bits.filter((b) => b.length > 0).join(" | ")}`;
  }
  if (failure === null && failedPost.length > 0) {
    failure = `cage: ${failedPost.map((p) => p.id).join(", ")}`;
  }
  return { scenario, drive, toolGate, judge, postconditions, pass: failure === null, failure };
}

/**
 * Run the harness. Always tears the cage down, including on failure.
 *
 * @throws ConfigError from `assertIsolated` when isolation cannot be proven,
 *         before anything is spoken to and before any provider is dialed.
 */
export async function runHarness(deps: HarnessDeps): Promise<HarnessResult> {
  const { io, env } = deps;
  const log = deps.log ?? ((): void => {});
  const now = deps.now ?? ((): number => Date.now());
  const sleep = deps.sleep ?? realSleep;

  if (deps.token.length < HARNESS_TOKEN_MIN) {
    throw new Error(
      `vox-e2e: session token must be at least ${HARNESS_TOKEN_MIN} chars (got ${deps.token.length})`,
    );
  }

  // 1 + 2. Capture the REAL home before pinning, so the disjointness check
  // can read the operator's roster. Read-only; never written, never listed
  // to the model.
  const realHome = env.HOME ?? null;
  const tempRoot = await io.mkdtemp("atmux-vox-e2e-");
  const realCockpitRaw =
    realHome !== null ? await io.readFile(join(realHome, ".atmux", "cockpit.json")) : null;
  const realTeamNames = extractTeamNames(realCockpitRaw);

  const groups = groupScenarios(deps.scenarios);
  const isolations: IsolationReport[] = [];
  const scenarios: ScenarioOutcome[] = [];
  const cacheDir = deps.ttsCacheDir ?? join(tempRoot, "tts-cache");

  try {
    await io.mkdir(cacheDir);
    for (const group of groups) {
      const outcomes = await runCageGroup({
        deps,
        group,
        tempRoot,
        realTeamNames,
        cacheDir,
        log,
        now,
        sleep,
        isolations,
      });
      scenarios.push(...outcomes);
    }
    return { isolations, scenarios, pass: scenarios.every((s) => s.pass) };
  } finally {
    // 4. Teardown, always. HOME is restored here rather than per group so
    // an exception mid-group cannot leave the process pointed at a temp
    // dir that is about to be deleted.
    if (realHome !== null) env.HOME = realHome;
    if (deps.keepTemp === true) log(`temp dir kept at ${tempRoot}`);
    else await io.rm(tempRoot);
  }
}

interface CageGroupRun {
  deps: HarnessDeps;
  group: CageGroup;
  tempRoot: string;
  realTeamNames: string[];
  cacheDir: string;
  log: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Appended to as each group's gate passes. */
  isolations: IsolationReport[];
}

/** Build one cage, prove it, run its scenarios against it, tear it down. */
async function runCageGroup(ctx: CageGroupRun): Promise<ScenarioOutcome[]> {
  const { deps, group, tempRoot, log, now } = ctx;
  const { io, env, uid } = deps;

  // 3a. A per-group root under the run's temp dir. Everything the gate
  // checks — HOME, the cockpit, each team root, each socket — is derived
  // from it, so each group is isolated from the next as well as from the
  // fleet.
  const cageRoot = join(tempRoot, `cage-${group.key}`);
  const plan = buildCagePlan({ tempRoot: cageRoot, uid, fixtures: group.fixtures });

  // 3b. Pin. Both variables must live on `process.env` — the tool runners
  // resolve them at call time.
  env.HOME = plan.home;
  env[COCKPIT_ENV] = plan.cockpitPath;

  try {
    const materialized = await materializeCage(plan, io, now);

    // 3c. THE GATE. Read the cockpit back from disk rather than trusting
    // the plan: what protects the fleet is what is actually on disk, and
    // that now includes each entry's ROOT, which is the field the fleet
    // verbs actually address a team by.
    const cockpitOnDisk = await io.readFile(plan.cockpitPath);
    const isolation = assertIsolated({
      tempRoot,
      expectedTeams: plan.teams.map((t) => ({
        name: t.name,
        root: t.root,
        tmuxTmpdir: t.tmuxTmpdir,
      })),
      cockpitTeams: extractTeamEntries(cockpitOnDisk),
      env,
      uid,
      realTeamNames: ctx.realTeamNames,
      mutationsEnabled: group.mutations,
    });
    ctx.isolations.push(isolation);
    log(`=== cage ${group.key} (${group.scenarios.map((s) => s.id).join(", ")})`);
    for (const line of formatIsolationReport(isolation)) log(line);

    // 3d. One server per cage, at that cage's posture. `readonly` is the
    // negation of `mutations` and is passed as a value — never written to
    // the environment, which the gate above has already refused.
    const server = await deps.startServer({
      cockpitPath: plan.cockpitPath,
      home: plan.home,
      token: deps.token,
      readonly: !group.mutations,
    });
    log(`server: ${server.url}  readonly=${!group.mutations}`);

    const outcomes: ScenarioOutcome[] = [];
    try {
      for (const scenario of group.scenarios) {
        outcomes.push(
          await runScenario({ ctx, plan, server, scenario, paintedAtMs: materialized.paintedAtMs }),
        );
      }
    } finally {
      await server.stop();
    }
    return outcomes;
  } finally {
    // 3f. The guard is the point: assert WHICH socket is being killed. A
    // stray session on a stray socket is untidy; a kill on the default
    // socket would be the accident this harness exists to preclude.
    await destroyCage(plan, io, (socketPath) => {
      assertKillableSocket(tempRoot, socketPath);
    });
  }
}

interface ScenarioRun {
  ctx: CageGroupRun;
  plan: CagePlan;
  server: ServerHandle;
  scenario: Scenario;
  paintedAtMs: number;
}

/** Everything the postconditions need to read the cage back. */
function probeFor(run: ScenarioRun, drive: DriveResult | null): PostconditionContext {
  return {
    plan: run.plan,
    readFile: run.ctx.deps.io.readFile,
    tmux: run.ctx.deps.io.tmux,
    now: run.ctx.now,
    sleep: run.ctx.sleep,
    drive,
  };
}

/** Drive one scenario and grade it. */
async function runScenario(run: ScenarioRun): Promise<ScenarioOutcome> {
  const { ctx, scenario } = run;
  const { deps, log, now, sleep } = ctx;

  // A protocol scenario speaks to nobody: no TTS, no provider, no judge.
  // See `replay.ts` for why exactly one scenario qualifies.
  if (scenario.protocol !== undefined) {
    log(`--- scenario ${scenario.id} [protocol, no speech]`);
    const bridge = run.server.bridge;
    if (bridge === undefined) {
      return decideScenario(scenario, null, checkToolGate(scenario, []), null, [
        {
          id: `${scenario.id}:no-bridge`,
          pass: false,
          detail: "the server handle exposed no tool bridge, so the confirm gate cannot be driven",
        },
      ]);
    }
    const replayCtx: ReplayContext = {
      ...probeFor(run, null),
      bridge,
      sessionId: PROTOCOL_SESSION_ID,
      team: MUT_TEAM,
      log,
    };
    const results = await scenario.protocol(replayCtx);
    for (const line of formatPostconditions(results)) log(line);
    return decideScenario(scenario, null, checkToolGate(scenario, []), null, results);
  }

  const turns = scenarioTurns(scenario);
  log(`--- scenario ${scenario.id}: ${turns.map((t) => JSON.stringify(t)).join(" → ")}`);
  const doTts = deps.tts ?? synthesize;
  const doDrive = deps.drive ?? driveTurns;
  const doJudge = deps.judge ?? runJudge;

  const pcms: Uint8Array[] = [];
  for (const text of turns) {
    const speech = await doTts(
      { text },
      {
        apiKey: deps.openaiKey,
        cacheDir: ctx.cacheDir,
        readCache: deps.io.readBytes,
        writeCache: deps.io.writeBytes,
        log,
      },
    );
    pcms.push(speech.pcm);
  }

  // Age the residue fixture. A top-up from when the cage was painted, so
  // the time spent synthesizing counts toward it — zero for every cage
  // whose fixtures carry no residue pane, which is all of the mutating
  // ones.
  const waitMs = computeStaleWaitMs(run.paintedAtMs, now(), requiredStaleSec(ctx.group.fixtures));
  if (waitMs > 0) {
    log(`waiting ${Math.ceil(waitMs / 1000)}s so the residue pane reads as wedged, not typed`);
    await sleep(waitMs);
  }

  const drive = await doDrive({
    args: { url: run.server.url, token: deps.token, pcms },
    log,
  });
  const toolGate = checkToolGate(scenario, drive.toolNames);

  let judge: JudgeOutcome | null = null;
  if (drive.ok) {
    judge = await doJudge(
      {
        // Multi-turn conversations are labelled per turn so the judge can
        // tell "the operator said yes" from "the operator said no" —
        // which is the only difference between two of the scenarios.
        utterance:
          turns.length === 1
            ? (turns[0] ?? "")
            : turns.map((t, i) => `operator turn ${i + 1}: ${t}`).join("\n"),
        groundTruth: groundTruthBriefing(ctx.group.fixtures),
        toolsInvoked: drive.toolNames,
        transcript: drive.transcript,
        criteria: criteriaFor(scenario),
      },
      { apiKey: deps.anthropicKey, log },
    );
  }

  // The cage is read AFTER the session closed, so nothing is still in
  // flight — and it is read whatever the judge said, because a scenario
  // the judge failed on wording while the fleet moved correctly (or, far
  // worse, the reverse) is exactly the pair of facts a reader needs.
  const postconditions = await runPostconditions(
    scenarioPostconditions(scenario),
    probeFor(run, drive),
  );
  if (postconditions.length > 0) {
    log(`cage assertions for ${scenario.id}:`);
    for (const line of formatPostconditions(postconditions)) log(line);
  }
  return decideScenario(scenario, drive, toolGate, judge, postconditions);
}

/** Render the run's outcome for stderr. */
export function formatHarnessResult(result: HarnessResult): string[] {
  const lines: string[] = ["", `vox-e2e: ${result.pass ? "PASS" : "FAIL"}`];
  for (const s of result.scenarios) {
    lines.push(`  ${s.pass ? "PASS" : "FAIL"}  ${s.scenario.id}`);
    if (s.failure !== null) lines.push(`        ${s.failure}`);
  }
  return lines;
}

/** Types re-exported so the script shim needs one import. */
export type { TmuxNamespace };
/** Re-exported so the script shim needs one import. */
export { READ_CAGE };
