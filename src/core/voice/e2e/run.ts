// ADR-272 §Supplement — the voice e2e harness orchestrator.
//
// Order of operations is the safety property, so it is spelled out here
// rather than left to the reader:
//
//   1. mkdtemp                     — nothing exists yet
//   2. pin HOME + ATMUX_COCKPIT_CONFIG into it, on `process.env`
//   3. read the operator's REAL cockpit, read-only, for the disjointness check
//   4. plan + materialize the cage (files, then tmux on ITS OWN socket)
//   5. **assertIsolated** — refuse before anything is spoken to
//   6. start the server on an ephemeral port
//   7. per scenario: synthesize → drive → judge
//   8. tear down, always
//
// Step 2 mutates `process.env` deliberately. The cockpit is resolved at CALL
// time by the fleet verbs (`loadCockpit()` defaults to `process.env`), not
// captured at boot, so passing an env object downward would leave the real
// path live for every tool the model invokes. Pinning the process env is the
// only override that actually reaches them.
//
// Step 5 runs AFTER the cage is built and BEFORE the server starts. That
// ordering is intentional: the gate checks what is really on disk (the
// cockpit file's contents, each team's `tmuxTmpdir`), which it cannot do
// before the files exist — and nothing has been addressed by then, because
// `materializeCage` only ever touches sockets under the temp root.

import { join } from "node:path";
import { z } from "zod";
import { tryParseJsonString } from "../../../abstractions/json.ts";
import type { TmuxNamespace } from "../../../abstractions/tmux.ts";
import { buildCagePlan, type CageIo, destroyCage, materializeCage } from "./cage.ts";
import { type DriveResult, driveUtterance } from "./drive.ts";
import { groundTruthBriefing, requiredStaleSec } from "./fixtures.ts";
import {
  assertIsolated,
  COCKPIT_ENV,
  formatIsolationReport,
  type IsolationReport,
  isUnder,
} from "./isolation.ts";
import { BASE_CRITERIA, type JudgeCriterion, type JudgeOutcome, runJudge } from "./judge.ts";
import { checkToolGate, type Scenario, type ToolGateResult } from "./scenarios.ts";
import { synthesize } from "./tts.ts";

/** Minimum token length the voice config enforces (ADR-272 security L2). */
export const HARNESS_TOKEN_MIN = 32;

export interface ServerHandle {
  url: string;
  stop: () => void | Promise<void>;
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
  }) => Promise<ServerHandle>;
  scenarios: ReadonlyArray<Scenario>;
  /** Voice-session auth token; must be ≥ 32 chars. */
  token: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Seams so the unit suite can drive the orchestration without a network. */
  drive?: typeof driveUtterance;
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
  drive: DriveResult;
  toolGate: ToolGateResult;
  judge: JudgeOutcome | null;
  /** Both gates must hold. */
  pass: boolean;
  failure: string | null;
}

export interface HarnessResult {
  isolation: IsolationReport;
  scenarios: ScenarioOutcome[];
  pass: boolean;
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
      `voice-e2e: refusing to kill a tmux session on ${socketPath} — outside ${tempRoot}`,
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
  if (raw === null) return [];
  const parsed = tryParseJsonString(raw, LooseCockpit);
  if (parsed === null) return [];
  const names: string[] = [];
  const walk = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (typeof node !== "object" || node === null) continue;
      const rec = node as Record<string, unknown>;
      if (typeof rec.name === "string") names.push(rec.name);
      if (Array.isArray(rec.sessions)) walk(rec.sessions);
    }
  };
  walk(parsed.sessions ?? []);
  walk(parsed.teams ?? []);
  return names;
}

/** Criteria for a scenario: the shared base plus its own. */
export function criteriaFor(scenario: Scenario): JudgeCriterion[] {
  return [...BASE_CRITERIA, ...scenario.criteria];
}

/** Fold a scenario's two gates into one outcome. */
export function decideScenario(
  scenario: Scenario,
  drive: DriveResult,
  toolGate: ToolGateResult,
  judge: JudgeOutcome | null,
): ScenarioOutcome {
  let failure: string | null = null;
  if (!drive.ok) failure = `session failed: ${drive.failure ?? "unknown"}`;
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
  return { scenario, drive, toolGate, judge, pass: failure === null, failure };
}

/**
 * Run the harness. Always tears the cage down, including on failure.
 *
 * @throws ConfigError from `assertIsolated` when isolation cannot be proven,
 *         before anything is spoken to and before any provider is dialed.
 */
export async function runHarness(deps: HarnessDeps): Promise<HarnessResult> {
  const { io, env, uid } = deps;
  const log = deps.log ?? ((): void => {});
  const now = deps.now ?? ((): number => Date.now());
  const sleep = deps.sleep ?? realSleep;

  if (deps.token.length < HARNESS_TOKEN_MIN) {
    throw new Error(
      `voice-e2e: session token must be at least ${HARNESS_TOKEN_MIN} chars (got ${deps.token.length})`,
    );
  }

  // 1 + 3. Capture the REAL home before pinning, so the disjointness check
  // can read the operator's roster. Read-only; never written, never listed
  // to the model.
  const realHome = env.HOME ?? null;
  const tempRoot = await io.mkdtemp("atmux-voice-e2e-");
  const realCockpitRaw =
    realHome !== null ? await io.readFile(join(realHome, ".atmux", "cockpit.json")) : null;
  const realTeamNames = extractTeamNames(realCockpitRaw);

  const plan = buildCagePlan({ tempRoot, uid });

  // 2. Pin. Both variables must live on `process.env` — the tool runners
  // resolve them at call time.
  env.HOME = plan.home;
  env[COCKPIT_ENV] = plan.cockpitPath;

  let materialized: Awaited<ReturnType<typeof materializeCage>> | null = null;
  try {
    // 4.
    materialized = await materializeCage(plan, io, now);

    // 5. THE GATE. Read the cockpit back from disk rather than trusting the
    // plan: what protects the fleet is what is actually on disk.
    const cockpitOnDisk = await io.readFile(plan.cockpitPath);
    const isolation = assertIsolated({
      tempRoot,
      expectedTeams: plan.teams.map((t) => ({
        name: t.name,
        root: t.root,
        tmuxTmpdir: t.tmuxTmpdir,
      })),
      cockpitTeamNames: extractTeamNames(cockpitOnDisk),
      env,
      uid,
      realTeamNames,
    });
    for (const line of formatIsolationReport(isolation)) log(line);

    // 6.
    const server = await deps.startServer({
      cockpitPath: plan.cockpitPath,
      home: plan.home,
      token: deps.token,
    });
    log(`server: ${server.url}`);

    const scenarios: ScenarioOutcome[] = [];
    try {
      const cacheDir = deps.ttsCacheDir ?? join(tempRoot, "tts-cache");
      await io.mkdir(cacheDir);
      const doTts = deps.tts ?? synthesize;
      const doDrive = deps.drive ?? driveUtterance;
      const doJudge = deps.judge ?? runJudge;

      for (const scenario of deps.scenarios) {
        log(`--- scenario ${scenario.id}: "${scenario.utterance}"`);
        const speech = await doTts(
          { text: scenario.utterance },
          {
            apiKey: deps.openaiKey,
            cacheDir,
            readCache: io.readBytes,
            writeCache: io.writeBytes,
            log,
          },
        );

        // 7a. Age the residue fixture. Done once per scenario because the
        // wait is a top-up: after the first scenario it is already zero.
        const waitMs = computeStaleWaitMs(materialized.paintedAtMs, now(), requiredStaleSec());
        if (waitMs > 0) {
          log(
            `waiting ${Math.ceil(waitMs / 1000)}s so the residue pane reads as wedged, not typed`,
          );
          await sleep(waitMs);
        }

        const drive = await doDrive({
          args: { url: server.url, token: deps.token, pcm: speech.pcm },
          log,
        });
        const toolGate = checkToolGate(scenario, drive.toolNames);

        let judge: JudgeOutcome | null = null;
        if (drive.ok) {
          judge = await doJudge(
            {
              utterance: scenario.utterance,
              groundTruth: groundTruthBriefing(),
              toolsInvoked: drive.toolNames,
              transcript: drive.transcript,
              criteria: criteriaFor(scenario),
            },
            { apiKey: deps.anthropicKey, log },
          );
        }
        scenarios.push(decideScenario(scenario, drive, toolGate, judge));
      }
    } finally {
      await server.stop();
    }

    return { isolation, scenarios, pass: scenarios.every((s) => s.pass) };
  } finally {
    // 8. Teardown, always. The guard is the point: assert WHICH socket is
    // being killed. A stray session on a stray socket is untidy; a kill on
    // the default socket would be the accident this harness exists to
    // preclude.
    await destroyCage(plan, io, (socketPath) => {
      assertKillableSocket(tempRoot, socketPath);
    });
    if (realHome !== null) env.HOME = realHome;
    if (deps.keepTemp === true) log(`temp dir kept at ${tempRoot}`);
    else await io.rm(tempRoot);
  }
}

/** Render the run's outcome for stderr. */
export function formatHarnessResult(result: HarnessResult): string[] {
  const lines: string[] = ["", `voice-e2e: ${result.pass ? "PASS" : "FAIL"}`];
  for (const s of result.scenarios) {
    lines.push(`  ${s.pass ? "PASS" : "FAIL"}  ${s.scenario.id}`);
    if (s.failure !== null) lines.push(`        ${s.failure}`);
  }
  return lines;
}

/** Types re-exported so the script shim needs one import. */
export type { TmuxNamespace };
