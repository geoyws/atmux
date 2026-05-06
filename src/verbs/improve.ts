// ADR-052 T1: `atmux improve` verb skeleton — args + budget-resolve +
// state-file write. Does NOT yet run cycles; T7 lands the loop. This
// verb ARMS the loop (writes initial state, fires Discord 🌱 start
// ping when the typed template lands in T3, exits 0).
//
// State-file IO + idempotence-detector primitives come from T2's
// `src/core/eternal-improvement.ts`. T1 layers the args parser, budget
// spec/resolver, and the verb's control-flow on top.
//
// Bash mirror: lib/improve.sh. Both sides match on stdout / exit /
// state-file shape.

import { now } from "../abstractions/time.ts";
import { withLock } from "../abstractions/lock.ts";
import { getAtmuxDir, type ResolveDirOpts, requireTeam } from "../core/common.ts";
import {
  eternalImprovementStatePath,
  isActive,
  isStale,
  readState,
  writeState,
} from "../core/eternal-improvement.ts";
import {
  generateRunId,
  HISTORY_RING_MAX,
  parseBudgetSpec,
  readBudgetProbe,
  resolveBudget,
  resolveBudgetSpec,
  type ResolvedBudget,
} from "../core/improve.ts";
import { defaultStdoutWrite, type Writer } from "../core/io.ts";
import { UsageError } from "../errors.ts";
import type {
  EternalImprovementState,
  EternalImprovementHistoryEntry,
} from "../schema/eternal-improvement.ts";

const USAGE =
  "atmux improve [--budget <spec>] [--status] [--dry-run] [--default-budget] [--idle-fallback] [--force]";

// ---------- Args ----------

export interface ImproveArgs {
  budget?: string;
  status: boolean;
  dryRun: boolean;
  defaultBudget: boolean;
  idleFallback: boolean;
  force: boolean;
  teamDir?: string;
}

/** Pure parser. Throws `UsageError` on bad invocation. */
export function parseImproveArgs(argv: ReadonlyArray<string>): ImproveArgs {
  let budget: string | undefined;
  let status = false;
  let dryRun = false;
  let defaultBudget = false;
  let idleFallback = false;
  let force = false;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--budget") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "improve: --budget requires a value", hint: USAGE });
      }
      budget = v;
      i += 2;
      continue;
    }
    if (a === "--status") {
      status = true;
      i += 1;
      continue;
    }
    if (a === "--dry-run") {
      dryRun = true;
      i += 1;
      continue;
    }
    if (a === "--default-budget") {
      defaultBudget = true;
      i += 1;
      continue;
    }
    if (a === "--idle-fallback") {
      idleFallback = true;
      i += 1;
      continue;
    }
    if (a === "--force") {
      force = true;
      i += 1;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "improve: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `improve: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  const out: ImproveArgs = { status, dryRun, defaultBudget, idleFallback, force };
  if (budget !== undefined) out.budget = budget;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Verb entry ----------

export interface ImproveOpts {
  /** stdout sink. Defaults to `process.stdout.write`. */
  stdout?: Writer;
  /** stderr sink. Defaults to `process.stderr.write`. */
  stderr?: Writer;
  /** ENV override (test injection). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Clock override (test injection). Defaults to `time.now()` in ms. */
  nowMs?: () => number;
  /** runId factory override (test injection). */
  runIdFactory?: () => string;
}

/**
 * `atmux improve [--budget <spec>] [--status] [--dry-run] [--default-budget]
 *                [--idle-fallback] [--force]`.
 *
 * Modes:
 *   --status    Read existing state-file, emit JSON to stdout, exit 0.
 *   --dry-run   Resolve budget, print formula + state path, exit 0; no writes.
 *   (default)   Write state-file (idempotent on second invocation), exit 0.
 */
export async function improve(
  argv: ReadonlyArray<string>,
  opts: ImproveOpts = {},
): Promise<number> {
  const parsed = parseImproveArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);

  const stdout = opts.stdout ?? defaultStdoutWrite;
  const stderr = opts.stderr ?? ((s: string) => process.stderr.write(s));
  const env = opts.env ?? process.env;
  const nowFn = opts.nowMs ?? now;
  const runIdFactory = opts.runIdFactory ?? generateRunId;

  const statePath = eternalImprovementStatePath(atmuxDir);

  // --status — read-only.
  if (parsed.status) {
    const existing = await readState(atmuxDir);
    if (existing === null) {
      // Match bash `--status` (lib/improve.sh:24-27): print `{}` on miss.
      stdout(`{}\n`);
      return 0;
    }
    stdout(`${JSON.stringify(existing, null, 2)}\n`);
    return 0;
  }

  // Resolve budget spec via ADR-052 precedence cascade.
  const specArgs: { cliBudget?: string } = {};
  if (parsed.budget !== undefined) specArgs.cliBudget = parsed.budget;
  const spec = resolveBudgetSpec(specArgs, env, team);
  const parsedSpec = parseBudgetSpec(spec);
  if (parsedSpec === null) {
    throw new UsageError({
      what: `improve: invalid budget spec: ${spec}`,
      hint: "forms: <int> | <int>% | <int>%-5h | <int>%-wk",
    });
  }
  const probe = await readBudgetProbe(atmuxDir, team.name);
  const resolved = resolveBudget(parsedSpec, { probe });
  if (resolved === null) {
    // pct-* without a probe + no raw --budget passed → fail-closed per
    // ADR-052 §"Budget formula" fail-closed rule.
    throw new UsageError({
      what: "improve: budget cannot be resolved; pass --budget explicitly",
      hint: `no .atmux/state/budget-probe-${team.name}.json available`,
    });
  }

  // --dry-run — print resolution + path, no writes.
  if (parsed.dryRun) {
    stdout(`improve: dry-run\n`);
    stdout(`  spec:    ${spec}\n`);
    stdout(`  formula: ${resolved.formula}\n`);
    stdout(`  total:   ${resolved.total} tokens\n`);
    stdout(`  state:   ${statePath}\n`);
    return 0;
  }

  const nowSec = Math.floor(nowFn() / 1000);

  // Idempotence guard: read existing state under the file's flock,
  // refuse if active (unless --force). Stale runs (>24h + >6h since last
  // cycle) are clearable per ADR-052 §Idempotence — log + continue.
  const written = await withLock(statePath, async () => {
    const existing = await readState(atmuxDir);

    if (existing !== null && !parsed.force) {
      if (isActive(existing, nowSec)) {
        stderr(
          `🌱 eternal-improvement: already active (runId=${existing.runId}, cycle=${existing.cycleN}) — pass --force to start a parallel run\n`,
        );
        return null;
      }
      if (isStale(existing, nowSec)) {
        stderr("🌱 stale improvement run — clearing state\n");
      }
    }

    const next = buildInitialState({
      mode: parsed.idleFallback ? "idle-fallback" : "user-invoked",
      spec,
      resolved,
      runId: runIdFactory(),
      nowSec,
      previous: existing,
    });
    await writeState(atmuxDir, next);
    return next;
  });

  if (written === null) return 0; // idempotent skip

  // Discord 🌱 start ping (T3 owns templates; gated until they land).
  await firePingIfWired(written, env);

  return 0;
}

// ---------- Builders ----------

interface BuildInitialOpts {
  mode: "user-invoked" | "idle-fallback";
  spec: string;
  resolved: ResolvedBudget;
  runId: string;
  nowSec: number;
  previous: EternalImprovementState | null;
}

/** Build the initial state-file shape. Carries forward `history` from a
 *  previous run (capped at HISTORY_RING_MAX). */
function buildInitialState(opts: BuildInitialOpts): EternalImprovementState {
  const prev = opts.previous?.history ?? [];
  const history: EternalImprovementHistoryEntry[] =
    prev.length > HISTORY_RING_MAX ? prev.slice(-HISTORY_RING_MAX) : [...prev];
  return {
    active: true,
    runId: opts.runId,
    startedAt: opts.nowSec,
    mode: opts.mode,
    budgetSpec: opts.spec,
    budgetTotal: opts.resolved.total,
    budgetRemaining: opts.resolved.total,
    cycleN: 0,
    currentCycle: null,
    lastCycleClosedAt: opts.previous?.lastCycleClosedAt ?? null,
    history,
  };
}

// ---------- Discord ping (T3 placeholder) ----------

/**
 * Fire the 🌱 [eternal-improvement-start] Discord ping when the
 * template is wired (T3 lands the literal-union extension + the
 * typed call site). Today this is a no-op gated on
 * ATMUX_DISCORD_TRIGGER env presence — keeps T1's AC unblocked
 * without committing to a template name T3 may rename.
 */
async function firePingIfWired(
  _state: EternalImprovementState,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const trigger = env.ATMUX_DISCORD_TRIGGER;
  if (trigger !== "eternal-improvement-start") return;
  // T3 fills this in. Keeping it a no-op until the typed template lands
  // avoids both `as DiscordTemplate` casts (would fail R10) and a
  // half-wired ping site that confuses T7's loop wiring.
  return;
}
