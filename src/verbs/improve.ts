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

import {
  renderEternalImprovementDone,
  renderEternalImprovementProgress,
  renderEternalImprovementStart,
  send as sendDiscord,
} from "../abstractions/discord.ts";
import { withLock } from "../abstractions/lock.ts";
import { now } from "../abstractions/time.ts";
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
  type ResolvedBudget,
  readBudgetProbe,
  resolveBudget,
  resolveBudgetSpec,
} from "../core/improve.ts";
import {
  armCycle,
  type CommitChecker,
  closeCycle,
  defaultCommitChecker,
  isCycleClosable,
  isDriverPreempt,
  openCycle,
  pauseCycle,
  shouldTerminate,
} from "../core/improve-cycle.ts";
import { defaultStdoutWrite, type Writer } from "../core/io.ts";
import { loadKanban } from "../core/kanban.ts";
import { UsageError } from "../errors.ts";
import type {
  EternalImprovementHistoryEntry,
  EternalImprovementState,
} from "../schema/eternal-improvement.ts";

const USAGE =
  "atmux improve [--budget <spec>] [--status] [--tick] [--dry-run] [--default-budget] [--idle-fallback] [--force]";

// ---------- Args ----------

export interface ImproveArgs {
  budget?: string;
  status: boolean;
  /** ADR-052 T7: poll one iteration of the cycle loop — detect close,
   *  decide terminate vs re-arm, fire pings. Idempotent; safe to call
   *  on a quiescent state. */
  tick: boolean;
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
  let tick = false;
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
    if (a === "--tick") {
      tick = true;
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
  const out: ImproveArgs = { status, tick, dryRun, defaultBudget, idleFallback, force };
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
  /** ADR-052 T7 — Discord send override (test injection). Defaults to
   *  `abstractions/discord.ts::send`. Tests override to capture the
   *  rendered DiscordSendOpts without hitting the network. */
  discordSend?: typeof sendDiscord;
  /** ADR-052 T7 — commit-checker override. Defaults to
   *  `defaultCommitChecker` (proxies on `completedAt !== null`). T8 / e2e
   *  may inject an explicit `git log` probe. */
  commitChecker?: CommitChecker;
  /** ADR-052 T7 — token-spend snapshot for the just-closed cycle.
   *  Wiring lands in T7-side helpers; verb accepts the value via this
   *  hook so unit tests can pin a deterministic delta without mocking
   *  the budget-probe filesystem. Defaults to `0` (no decrement) — the
   *  verb still ticks `tokensSpent` from anywhere it has accounting. */
  tokensSpentForClose?: () => Promise<number>;
  /** ADR-052 T7 — Mode B termination hook. Mode A returns; Mode B fires
   *  `atmux stop`. Verb provides the hook; default is a no-op so unit
   *  tests don't shell out. T6's whip-hook integration wires the real
   *  `atmux stop` invocation. */
  onTerminate?: (state: EternalImprovementState) => Promise<void>;
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
  const discord = opts.discordSend ?? sendDiscord;
  const commitChecker = opts.commitChecker ?? defaultCommitChecker;
  const tokensSpentForClose = opts.tokensSpentForClose ?? (async () => 0);
  const onTerminate = opts.onTerminate ?? (async () => {});

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

  // --tick — poll one cycle iteration. Reads state + kanban, decides
  // pause / close / terminate / re-arm. ADR-052 T7 §"Loop mechanics".
  if (parsed.tick) {
    return await tickCycle({
      atmuxDir,
      teamName: team.name,
      nowSec: Math.floor(nowFn() / 1000),
      nowMs: nowFn,
      idleFallback: parsed.idleFallback,
      commitChecker,
      tokensSpentForClose,
      discord,
      onTerminate,
      stderr,
    });
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

    const initial = buildInitialState({
      mode: parsed.idleFallback ? "idle-fallback" : "user-invoked",
      spec,
      resolved,
      runId: runIdFactory(),
      nowSec,
      previous: existing,
    });
    // ADR-052 T7: open cycle 1 immediately on arm. cycleN goes 0 → 1.
    const armed = openCycle(initial, nowSec);
    await writeState(atmuxDir, armed);
    return armed;
  });

  if (written === null) return 0; // idempotent skip

  // ADR-052 T7: arm directive to lead (file-based, mirrors tell-lead's
  // append-to-driver-inbox + tmux ping pattern). The bash mirror in
  // lib/improve.sh sends the actual tmux keystroke; the TS verb writes
  // the durable file entry only — keeps the verb spawn-free + safely
  // testable end-to-end without a live tmux.
  await armCycle(atmuxDir, written);

  // Fire 🌱 [eternal-improvement-start] Discord ping (best-effort —
  // any send failure soft-degrades via `safeFireDiscord` with stderr WARN).
  await firePingStart(written, team.name, discord, nowFn, stderr);

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

// ---------- Discord pings (T3 templates wired by T7) ----------

/** Run a Discord-send under soft-degrade: any send failure (missing
 *  webhook, HTTP non-2xx like 429 rate-limit, network blip) emits a
 *  single stderr WARN and resolves — the verb continues. Discord pings
 *  are observability, not load-bearing state; an unwrap-and-throw on
 *  the caller side would make `atmux improve` exit non-zero whenever
 *  the webhook flapped, which broke the test suite under rate-limit
 *  pressure (HTTP 429 from concurrent test runs) and any production
 *  outage with the webhook upstream. Matches the documented intent of
 *  the per-fire JSDocs ("best-effort: missing webhook URL is a no-op
 *  inside `send`") — extended now to cover ALL send failures, not just
 *  the unconfigured-webhook branch.
 *
 *  `stderr` defaults to a process-level write so legacy callers that
 *  don't thread the sink down still surface the warning. */
async function safeFireDiscord(
  label: string,
  send: () => Promise<void>,
  stderr: Writer = (s) => process.stderr.write(s),
): Promise<void> {
  try {
    await send();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    stderr(`atmux improve: discord ping ${label} skipped (best-effort): ${msg}\n`);
  }
}

/** 🌱 [eternal-improvement-start] — fired once per `atmux improve`
 *  invocation that successfully writes initial state. Uses T3's
 *  `renderEternalImprovementStart` builder + the `send()` boundary.
 *  Best-effort: any send failure (missing webhook, HTTP 4xx/5xx,
 *  network) is swallowed by `safeFireDiscord` + warned on stderr. */
async function firePingStart(
  state: EternalImprovementState,
  teamName: string,
  discord: typeof sendDiscord,
  nowFn: () => number,
  stderr?: Writer,
): Promise<void> {
  await safeFireDiscord(
    "eternal-improvement-start",
    () =>
      discord(
        renderEternalImprovementStart({
          team: teamName,
          budgetSpec: state.budgetSpec,
          budgetTotal: state.budgetTotal,
          mode: state.mode,
          runId: state.runId,
          whenMs: nowFn(),
        }),
      ),
    stderr,
  );
}

/** 🌱 [eternal-improvement-progress] — fired on each cycle close
 *  per ADR-052 §"Discord templates". Caller passes the just-closed
 *  cycle's deltas. */
async function firePingProgress(
  state: EternalImprovementState,
  teamName: string,
  closedCycleN: number,
  tasksShipped: number,
  tokensSpent: number,
  discord: typeof sendDiscord,
  nowFn: () => number,
  stderr?: Writer,
): Promise<void> {
  await safeFireDiscord(
    "eternal-improvement-progress",
    () =>
      discord(
        renderEternalImprovementProgress({
          team: teamName,
          cycleN: closedCycleN,
          tasksShipped,
          tokensSpent,
          budgetTotal: state.budgetTotal,
          budgetRemaining: state.budgetRemaining,
          whenMs: nowFn(),
        }),
      ),
    stderr,
  );
}

/** 🌱 [eternal-improvement-done] — fired on run termination. */
async function firePingDone(
  state: EternalImprovementState,
  teamName: string,
  discord: typeof sendDiscord,
  nowFn: () => number,
  stderr?: Writer,
): Promise<void> {
  // Total tasks shipped across history.
  const totalTasksShipped = state.history.reduce((a, h) => a + h.tasksDone, 0);
  // Total tokens consumed across the run = budgetTotal - budgetRemaining
  // (clamped to 0 if budgetRemaining accidentally exceeded total).
  const consumed = Math.max(0, state.budgetTotal - state.budgetRemaining);
  const durationMs = nowFn() - state.startedAt * 1000;
  await safeFireDiscord(
    "eternal-improvement-done",
    () =>
      discord(
        renderEternalImprovementDone({
          team: teamName,
          cycleCount: state.cycleN,
          totalTasksShipped,
          tokensConsumed: consumed,
          budgetTotal: state.budgetTotal,
          durationMs: Math.max(0, durationMs),
          modeB: state.mode === "idle-fallback",
          whenMs: nowFn(),
        }),
      ),
    stderr,
  );
}

// ---------- --tick handler (ADR-052 T7 §"Loop mechanics") ----------

interface TickCycleOpts {
  atmuxDir: string;
  teamName: string;
  nowSec: number;
  nowMs: () => number;
  idleFallback: boolean;
  commitChecker: CommitChecker;
  tokensSpentForClose: () => Promise<number>;
  discord: typeof sendDiscord;
  onTerminate: (state: EternalImprovementState) => Promise<void>;
  stderr: Writer;
}

/**
 * One cycle-loop iteration. Idempotent — safe to call on a quiescent
 * state (no current cycle, or run already inactive). Returns 0 always;
 * tick failures are non-fatal (state is the source of truth).
 *
 * Flow:
 *   1. Read state. If null or `active: false` → no-op, return 0.
 *   2. Read kanban tasks.
 *   3. If `isDriverPreempt(kanban)` → pause cycle (write + return).
 *   4. If `isCycleClosable(state, kanban, commitChecker)`:
 *      a. Snap tokensSpent (caller-provided), tickTokens then close.
 *      b. Fire 🌱 [eternal-improvement-progress].
 *      c. If `shouldTerminate(closed)` → set inactive, fire done ping,
 *         invoke onTerminate (Mode B: `atmux stop`), return.
 *      d. Otherwise open cycleN+1, write, arm directive, fire start ping.
 */
async function tickCycle(opts: TickCycleOpts): Promise<number> {
  const {
    atmuxDir,
    teamName,
    nowSec,
    nowMs,
    commitChecker,
    tokensSpentForClose,
    discord,
    onTerminate,
    stderr,
  } = opts;
  const state = await readState(atmuxDir);
  if (state === null || state.active !== true) return 0;
  if (state.currentCycle === null) return 0; // nothing to tick
  const kanban = await loadKanban(atmuxDir);
  const tasks = kanban.tasks;

  // Mid-run preemption: driver Task in-progress with epic !== improvement
  if (isDriverPreempt(tasks)) {
    if (state.currentCycle.paused !== true) {
      const paused = pauseCycle(state);
      await writeState(atmuxDir, paused);
      stderr("🌱 eternal-improvement: driver Task in-flight — pausing cycle\n");
    }
    return 0;
  }

  if (!isCycleClosable(state, tasks, commitChecker)) return 0;

  // Snap token-spend delta, fold into currentCycle.tokensSpent, then close.
  const delta = Math.max(0, await tokensSpentForClose());
  const cur = state.currentCycle;
  const totalSpent = cur.tokensSpent + delta;
  const closed = closeCycle(
    {
      ...state,
      currentCycle: { ...cur, tokensSpent: totalSpent },
    },
    nowSec,
  );

  // Fire 🌱 [eternal-improvement-progress].
  await firePingProgress(
    closed,
    teamName,
    state.cycleN,
    cur.tasksDone.length,
    totalSpent,
    discord,
    nowMs,
    stderr,
  );

  if (shouldTerminate(closed)) {
    const terminated: EternalImprovementState = { ...closed, active: false };
    await writeState(atmuxDir, terminated);
    await firePingDone(terminated, teamName, discord, nowMs, stderr);
    await onTerminate(terminated);
    return 0;
  }

  // Re-arm: open the next cycle + write + arm directive + start ping.
  const next = openCycle(closed, nowSec);
  await writeState(atmuxDir, next);
  await armCycle(atmuxDir, next);
  await firePingStart(next, teamName, discord, nowMs, stderr);
  return 0;
}
