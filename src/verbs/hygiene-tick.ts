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
//     "skipReason": "no-unfixed" | "ladder-defer" | ""
//   }
//
// Verbs the agent expects to exist (per ADR-131 §D6):
//   - `atmux task assign <id> <member>` (shipped pre-session)
//   - `atmux task lane <id> <lane>` (shipped via T4 / t-93b59741)
//   - `atmux task priority <id> <N>` (shipped via T4 / t-93b59741)
// Each verb is wrapped here as a `FixDeps` callback; tests inject
// recorders.

import { spawn as defaultSpawn, type SpawnResult } from "../abstractions/spawn.ts";
import { closeDatabase, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { type ResolveDirOpts, getAtmuxDir, requireTeam } from "../core/common.ts";
import { HygieneRepo } from "../core/repositories/hygiene-repo.ts";
import { KanbanRepo } from "../core/repositories/kanban-repo.ts";
import { type DrainTickResult, drainTick } from "../core/superdoctor-hygiene/drain.ts";
import type { FixDeps, TeamState } from "../core/superdoctor-hygiene/_shared.ts";
import { UsageError } from "../errors.ts";
import { join } from "node:path";

const USAGE = "atmux hygiene-tick [--team-dir <dir>] [--json]";

interface HygieneTickArgs {
  teamDir?: string;
  json: boolean;
}

export function parseHygieneTickArgs(argv: ReadonlyArray<string>): HygieneTickArgs {
  let teamDir: string | undefined;
  let json = true; // default to JSON output (agent-consumer assumption)
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
  const out: HygieneTickArgs = { json };
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

/** `atmux hygiene-tick` entry point. Returns the drain result so
 *  callers (other verbs, tests) can chain; the CLI dispatcher
 *  ignores the return value (process exit code 0). */
export async function hygieneTick(
  argv: ReadonlyArray<string>,
  opts: HygieneTickOpts = {},
): Promise<DrainTickResult> {
  const parsed = parseHygieneTickArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);
  const now = (opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();

  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  let result: DrainTickResult;
  try {
    const kanban = new KanbanRepo(db).listTasks();
    const repo = new HygieneRepo(db);
    // Narrow Team → TeamState for the drain-loop signature.
    const teamState: TeamState = { members: team.members };
    result = await drainTick({
      team: teamState,
      kanban,
      repo,
      deps: opts.fixDeps ?? defaultFixDeps(),
      now,
    });
  } finally {
    closeDatabase(db);
  }

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(formatHuman(result));
  }
  return result;
}

function formatHuman(result: DrainTickResult): string {
  const lines: string[] = [];
  lines.push(`hygiene-tick: ${result.detected} detected, ${result.unfixedAfter} unfixed`);
  if (result.drained !== null) {
    const r = result.drained;
    const fix = r.result.applied ? "applied" : `skipped (${r.result.reason ?? "?"})`;
    lines.push(
      `  drained: ${r.row.taskId} [${r.row.fingerprintClass}/${r.row.severity}] → ${fix}`,
    );
  } else if (result.skipReason !== "") {
    lines.push(`  drain skipped: ${result.skipReason}`);
  }
  return lines.join("\n") + "\n";
}
