// ADR-053 §D2 + §D3: per-tick budget orchestration for whip.
//
// Composes the budget-probe abstraction with budget-pause state I/O,
// the band-warning + refresh-soon dedup states, the Discord renderer
// quartet, and the team's pause/resume verb-core primitives into a
// single `runBudgetCheck` function called from `src/verbs/whip.ts`'s
// runTick — early-return when budget-pause is active so per-member
// regular checks (and ADR-052 Mode B kanban-empty fallback) don't fire
// while the team is in a deliberate hold.
//
// State files driven from this module (all under <atmuxDir>/state/):
//
//   - budget-pause.json           (entry + exit lifecycle)
//   - budget-warning-state.json   (band-crossing dedup, 4.1)
//   - budget-refresh-soon-state.json (refresh-soon dedup, 4.2)
//   - budget-probe-<account>.json (managed by budget-probe abstraction)
//   - logs/budget-history.jsonl   (managed by budget-history helper)
//
// All five files are bash-readable so the bash whip runtime can
// observe TS-side state during the bash→bun transition.
//
// Test surface: every external dependency is injectable via
// `BudgetCheckDeps`. Defaults wire up the production functions.

import {
  type BudgetProbeResult,
  probeBudget as defaultProbeBudget,
} from "../abstractions/budget-probe.ts";
import {
  type DiscordSendOpts,
  renderWhipBudgetPause,
  renderWhipBudgetRefreshSoon,
  renderWhipBudgetResume,
  renderWhipBudgetWarning,
} from "../abstractions/discord.ts";
import type {
  CageHandle,
  createFallbackCage as defaultCreateFallbackCage,
  destroyFallbackCage as defaultDestroyFallbackCage,
} from "../abstractions/fallback-cage.ts";
import { appendText } from "../abstractions/fs.ts";
import { formatDuration, formatMyt, now } from "../abstractions/time.ts";
import type { KanbanTask } from "../schema/kanban.ts";
import {
  type AtRiskMember,
  type BudgetPauseState,
  clearBudgetPauseState,
  isBudgetPauseActive,
  loadBudgetPauseState,
  writeBudgetPauseState,
} from "./budget-pause.ts";
import {
  hasRefreshSoonFired,
  loadRefreshSoonState,
  recordRefreshSoonFire,
  wipeStaleEntries,
  writeRefreshSoonState,
} from "./budget-refresh-soon-state.ts";
import {
  hasBandFired,
  loadWarningState,
  recordBandFire,
  type WarningState,
  wipeForResetWindow,
  writeWarningState,
} from "./budget-warning-state.ts";
import { driverInboxPath } from "./common.ts";
import { pauseMember as defaultPauseMember, resumeMember as defaultResumeMember } from "./pause.ts";
import {
  type DispatchFallbackOpts,
  dispatchFallbackOnPause as defaultDispatchFallbackOnPause,
  walkFallbackOnResume as defaultWalkFallbackOnResume,
  type WalkFallbackOpts,
} from "./whip-budget-fallback.ts";

// ---------- Types ----------

export type BudgetCheckVerdict =
  | "no-pause-not-active" // no probe data / no accounts; fall through to normal tick
  | "active" // probed, all clear → continue normal tick
  | "paused-just-now" // entered pause this tick → stop the tick
  | "paused-still" // already paused, resume gate not met → stop the tick
  | "resumed"; // exited pause this tick → continue normal tick

export interface BudgetCheckTeamMember {
  name: string;
  /** May be unset / null / "default" / "" — those collapse to the
   *  "default" account bucket and skip the probe. */
  claudeAccount?: string;
}

export interface BudgetCheckCtx {
  atmuxDir: string;
  /** Used for header timestamps in Discord renders. */
  nowMs: number;
  /** Used for state-file dedup epochs (epoch seconds). */
  nowSec: number;
  /** Project working directory — passed through to the ADR-058 fallback
   *  dispatch when `team.fallback.enabled === true`. Optional for
   *  pre-ADR-058 callers; required when the fallback gate is active. */
  projectCwd?: string;
  team: {
    name: string;
    members: ReadonlyArray<BudgetCheckTeamMember>;
    /** ADR-058 §D2 default-OFF fallback gate. Undefined OR
     *  `enabled === false` keeps the legacy budget-pause behavior; only
     *  `enabled === true` activates the cage-fallback dispatch on
     *  pause-entry / continuity walk on resume. */
    fallback?: { enabled: boolean };
  };
  config: {
    /** Pause when ANY member's pct-used ≥ this threshold (default 90 — i.e., 10% remaining). */
    budgetPauseThreshold: number;
    /** Resume when ALL members' pct-used ≤ this threshold (default 80 — i.e., 20% remaining). */
    budgetResumeThreshold: number;
    /** Bands as remaining-fraction descending (default [0.5, 0.25, 0.15]). */
    budgetWarningBands: ReadonlyArray<number>;
    /** Lead-time minutes for refresh-soon ping (default 30). */
    budgetRefreshLeadMins: number;
  };
}

export interface BudgetCheckDeps {
  /** Probe one account's budget. Default: production `probeBudget` with
   *  `refreshOnNearExpiry: true` (ADR-078 — daemon-owned credentials
   *  lifecycle, Fix-C-on). Tests inject a fake to capture the opts and
   *  pin the daemon-on-fix-C contract. */
  probeBudget?: (
    account: string,
    opts?: { refreshOnNearExpiry?: boolean },
  ) => Promise<BudgetProbeResult>;
  /** Pause a member. Default: `core/pause.ts::pauseMember`. */
  pauseMember?: (atmuxDir: string, member: string, opts: { reason: string }) => Promise<void>;
  /** Resume a member. Default: `core/pause.ts::resumeMember`. */
  resumeMember?: (atmuxDir: string, member: string) => Promise<void>;
  /** Create a fallback cage. Default: `fallback-cage.ts::createFallbackCage`. */
  createFallbackCage?: typeof defaultCreateFallbackCage;
  /** Destroy a fallback cage. Default: `fallback-cage.ts::destroyFallbackCage`. */
  destroyFallbackCage?: typeof defaultDestroyFallbackCage;
  /** Send a Discord message. Default: `discord.ts::send`. */
  discordSend?: (opts: DiscordSendOpts) => Promise<void>;
  /** Append to driver-inbox. Default: `appendText` to driver-inbox.md. */
  appendDriverInbox?: (atmuxDir: string, content: string) => Promise<void>;
  /** Logger for per-tick activity. Default: stderr-shaped no-op (caller
   *  may inject ctx.stderr-equivalent). */
  log?: (msg: string) => void;

  // ---------- ADR-058 fallback chain (default-OFF; only active when
  //            ctx.team.fallback?.enabled === true) ----------

  /** Snapshot in-flight tasks at pause-entry. The verb wires this to
   *  `core/kanban.ts::listTasks(atmuxDir, { status: "in-progress" })`.
   *  Required when fallback is enabled; ignored otherwise. */
  listInFlightTasks?: () => Promise<ReadonlyArray<KanbanTask>>;
  /** Paste the entry brief into a freshly-spawned cage's tmux pane.
   *  Required when fallback is enabled; ignored otherwise. */
  sendCageBrief?: (handle: CageHandle, body: string) => Promise<void>;
  /** Paste the resume continuity brief into the original Claude member's
   *  pane. Required when fallback is enabled; ignored otherwise. */
  sendContinuityBrief?: (member: string, body: string) => Promise<void>;
  /** Override the default `dispatchFallbackOnPause` orchestration. Tests
   *  inject this to count invocations / fake the cage-spawn loop without
   *  touching tmux. */
  dispatchFallback?: (opts: DispatchFallbackOpts) => Promise<CageHandle[]>;
  /** Override the default `walkFallbackOnResume` orchestration. Tests
   *  inject this to capture walk calls without invoking `destroyCage`. */
  walkFallback?: (opts: WalkFallbackOpts) => Promise<void>;
}

// ---------- Public API ----------

/**
 * Run the per-tick budget-pause orchestration. Call EARLY in the whip
 * tick, after session-up + lock acquisition, BEFORE per-member checks.
 * The verdict signals whether the caller should continue the tick:
 *
 *   - `"paused-just-now"` / `"paused-still"` → caller returns 0
 *      (skip the rest of the tick).
 *   - `"resumed"` / `"active"` / `"no-pause-not-active"` → caller
 *      continues normal tick.
 *
 * Side effects on the relevant state files are isolated per verdict —
 * "active" never writes to budget-pause.json; "resumed" never writes
 * a fresh budget-warning-state entry; etc.
 */
export async function runBudgetCheck(
  ctx: BudgetCheckCtx,
  deps: BudgetCheckDeps = {},
): Promise<BudgetCheckVerdict> {
  const probe =
    deps.probeBudget ??
    ((account: string, opts?: { refreshOnNearExpiry?: boolean }) =>
      defaultProbeBudget(account, opts ?? {}));
  const pauseMem = deps.pauseMember ?? defaultPauseMember;
  const resumeMem = deps.resumeMember ?? defaultResumeMember;
  const send = deps.discordSend;
  const appendDi = deps.appendDriverInbox ?? defaultAppendDriverInbox;
  const log = deps.log ?? (() => {});

  const accounts = uniqueAccounts(ctx.team.members);
  if (accounts.length === 0) return "no-pause-not-active";

  // ADR-078 — daemon caller owns the credentials lifecycle, opts in to
  // the Fix-C OAuth refresh path.
  const probes = await Promise.all(accounts.map((a) => probe(a, { refreshOnNearExpiry: true })));
  // Stitch into [{account, result}] for downstream filtering.
  const results = accounts.map((a, i) => ({ account: a, result: probes[i] as BudgetProbeResult }));

  // Branch 1 — already paused: gate on resume threshold.
  if (await isBudgetPauseActive(ctx.atmuxDir)) {
    if (allClearForResume(results, ctx.config.budgetResumeThreshold)) {
      await exitPause(ctx, results, send, resumeMem, appendDi, log, deps);
      return "resumed";
    }
    log("whip: budget-pause still active — resume gate not met");
    return "paused-still";
  }

  // Branch 2 — not paused: check pause threshold.
  const tripped = atRiskMembers(ctx.team.members, results, ctx.config.budgetPauseThreshold);
  if (tripped.length > 0) {
    await enterPause(ctx, tripped, send, pauseMem, appendDi, log, deps);
    return "paused-just-now";
  }

  // Branch 3 — active, no pause needed: emit observability pings.
  await maybeFireBandWarnings(ctx, results, send);
  await maybeFireRefreshSoon(ctx, results, send);

  return "active";
}

// ---------- Internals ----------

function uniqueAccounts(members: ReadonlyArray<BudgetCheckTeamMember>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of members) {
    const a = m.claudeAccount;
    if (a === undefined || a === null || a === "" || a === "default" || a === "null") continue;
    if (seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

interface AccountResult {
  account: string;
  result: BudgetProbeResult;
}

function allClearForResume(
  results: ReadonlyArray<AccountResult>,
  resumeThreshold: number,
): boolean {
  // ALL accounts (every probe) must have BOTH 5h + wk pct-used ≤ threshold.
  for (const { result } of results) {
    if (result.status !== "allowed") return false;
    if (result.h5_pct_used > resumeThreshold) return false;
    if (result.wk_pct_used > resumeThreshold) return false;
  }
  return true;
}

function atRiskMembers(
  members: ReadonlyArray<BudgetCheckTeamMember>,
  results: ReadonlyArray<AccountResult>,
  pauseThreshold: number,
): AtRiskMember[] {
  const byAccount = new Map<string, BudgetProbeResult>();
  for (const r of results) byAccount.set(r.account, r.result);
  const out: AtRiskMember[] = [];
  for (const m of members) {
    const a = m.claudeAccount;
    if (a === undefined || a === null || a === "") continue;
    const r = byAccount.get(a);
    if (r === undefined) continue;
    if (r.status !== "allowed") continue;
    if (r.h5_pct_used >= pauseThreshold || r.wk_pct_used >= pauseThreshold) {
      out.push({ member: m.name, h5: r.h5_pct_used, wk: r.wk_pct_used });
    }
  }
  return out;
}

async function enterPause(
  ctx: BudgetCheckCtx,
  atRisk: ReadonlyArray<AtRiskMember>,
  send: BudgetCheckDeps["discordSend"],
  pauseMem: NonNullable<BudgetCheckDeps["pauseMember"]>,
  appendDi: NonNullable<BudgetCheckDeps["appendDriverInbox"]>,
  log: (msg: string) => void,
  deps: BudgetCheckDeps,
): Promise<void> {
  const ts = formatMyt(ctx.nowMs);
  const state: BudgetPauseState = {
    paused: true,
    pausedAt: ctx.nowSec,
    pausedAtTs: ts,
    atRisk,
  };
  await writeBudgetPauseState(ctx.atmuxDir, state);

  // Pause every member (NOT just the at-risk subset — the team is a
  // single budget unit; bash mirrors).
  for (const m of ctx.team.members) {
    try {
      await pauseMem(ctx.atmuxDir, m.name, { reason: "budget-low" });
    } catch (e) {
      log(`whip: budget-pause: pause(${m.name}) failed: ${stringifyErr(e)}`);
    }
  }

  // ADR-058 §D2: only fire the cage-fallback chain when the team has
  // explicitly opted in. Default-OFF for pre-ADR-058 teams.
  if (ctx.team.fallback?.enabled === true) {
    try {
      await runFallbackDispatch(ctx, deps, log);
    } catch (e) {
      log(`whip: fallback-dispatch failed: ${stringifyErr(e)}`);
    }
  }

  // Driver-inbox surface.
  const lines: string[] = [
    "",
    `## ${ts} — 🪫 budget-pause entered`,
    "Team paused. At-risk members:",
  ];
  for (const r of atRisk) lines.push(`- ${r.member}: 5h ${r.h5}% / wk ${r.wk}%`);
  lines.push(
    `Resume condition: ALL members ≤ ${ctx.config.budgetResumeThreshold}% used on BOTH 5h AND wk windows.`,
    "No new dispatches until refresh.",
    "",
  );
  await appendDi(ctx.atmuxDir, lines.join("\n"));

  if (send !== undefined) {
    try {
      await send(
        renderWhipBudgetPause({
          team: ctx.team.name,
          atRisk,
          resumeThresholdPct: 100 - ctx.config.budgetResumeThreshold,
          whenMs: ctx.nowMs,
        }),
      );
    } catch (e) {
      log(`whip: budget-pause: discord send failed: ${stringifyErr(e)}`);
    }
  }
  log(`whip: budget-pause entered (${atRisk.length} member(s) at risk)`);
}

async function exitPause(
  ctx: BudgetCheckCtx,
  _results: ReadonlyArray<AccountResult>,
  send: BudgetCheckDeps["discordSend"],
  resumeMem: NonNullable<BudgetCheckDeps["resumeMember"]>,
  appendDi: NonNullable<BudgetCheckDeps["appendDriverInbox"]>,
  log: (msg: string) => void,
  deps: BudgetCheckDeps,
): Promise<void> {
  // Capture pausedAt BEFORE clearing the state file — the fallback walk
  // uses it to identify the matching `fallback-cages-<epoch>.json`.
  const priorState = await loadBudgetPauseState(ctx.atmuxDir);

  // Resume every member.
  for (const m of ctx.team.members) {
    try {
      await resumeMem(ctx.atmuxDir, m.name);
    } catch (e) {
      log(`whip: budget-resume: resume(${m.name}) failed: ${stringifyErr(e)}`);
    }
  }

  // ADR-058 §D2: walk the fallback cages BEFORE clearing pause state, so
  // a mid-walk crash leaves the system in the still-paused-handles-
  // present state (idempotent on retry). Default-OFF gate matches enter.
  if (ctx.team.fallback?.enabled === true && priorState !== null) {
    try {
      await runFallbackWalk(ctx, deps, priorState.pausedAt, log);
    } catch (e) {
      log(`whip: fallback-walk failed: ${stringifyErr(e)}`);
    }
  }

  await clearBudgetPauseState(ctx.atmuxDir);

  const ts = formatMyt(ctx.nowMs);
  const lines = [
    "",
    `## ${ts} — 🟢 budget-pause cleared`,
    "Team resumed. All members back above resume threshold.",
    "",
  ];
  await appendDi(ctx.atmuxDir, lines.join("\n"));

  if (send !== undefined) {
    try {
      await send(
        renderWhipBudgetResume({
          team: ctx.team.name,
          resumeThresholdPct: 100 - ctx.config.budgetResumeThreshold,
          whenMs: ctx.nowMs,
        }),
      );
    } catch (e) {
      log(`whip: budget-resume: discord send failed: ${stringifyErr(e)}`);
    }
  }
  log("whip: budget-pause cleared — team resumed");
}

async function maybeFireBandWarnings(
  ctx: BudgetCheckCtx,
  results: ReadonlyArray<AccountResult>,
  send: BudgetCheckDeps["discordSend"],
): Promise<void> {
  if (send === undefined) return;
  let state = await loadWarningState(ctx.atmuxDir);
  let mutated = false;
  // Bands sorted DESCENDING (highest-remaining first); a probe at 22%
  // remaining (78% used) crosses 50% AND 25% bands — fire each that
  // hasn't fired yet for this window.
  const bandsDesc = [...ctx.config.budgetWarningBands].sort((a, b) => b - a);
  for (const { account, result } of results) {
    if (result.status !== "allowed") continue;
    for (const window of ["5h", "wk"] as const) {
      const pctUsed = window === "5h" ? result.h5_pct_used : result.wk_pct_used;
      const remainingFrac = (100 - pctUsed) / 100;
      const resetEpoch = window === "5h" ? result.h5_reset_epoch : result.wk_reset_epoch;
      // Wipe + restamp sentinel on window-reset advance before checking bands.
      const nextState = wipeForResetWindow(state, account, window, resetEpoch);
      if (nextState !== state) {
        state = nextState;
        mutated = true;
      }
      for (let i = 0; i < bandsDesc.length; i++) {
        const band = bandsDesc[i] as number;
        if (remainingFrac > band) continue; // not crossed yet
        if (hasBandFired(state, account, window, band)) continue; // already fired this window
        // Fire.
        const affected = ctx.team.members.filter((m) => m.claudeAccount === account).length;
        const nextBand = bandsDesc[i + 1];
        const opts: Parameters<typeof renderWhipBudgetWarning>[0] = {
          team: ctx.team.name,
          account,
          window,
          remainingPct: 100 - pctUsed,
          band,
          resetIn: formatResetIn(resetEpoch, ctx.nowSec),
          affectedMembers: affected,
          whenMs: ctx.nowMs,
        };
        if (nextBand !== undefined) opts.nextBandPct = Math.round(nextBand * 100);
        try {
          await send(renderWhipBudgetWarning(opts));
        } catch {
          // Best-effort observability — don't mask the tick.
        }
        state = recordBandFire(state, account, window, band, ctx.nowSec);
        mutated = true;
      }
    }
  }
  if (mutated) await writeWarningState(ctx.atmuxDir, state);
}

async function maybeFireRefreshSoon(
  ctx: BudgetCheckCtx,
  results: ReadonlyArray<AccountResult>,
  send: BudgetCheckDeps["discordSend"],
): Promise<void> {
  if (send === undefined) return;
  let state = await loadRefreshSoonState(ctx.atmuxDir);
  // Sweep stale entries up front (reset epochs that have passed).
  const swept = wipeStaleEntries(state, ctx.nowSec);
  let mutated = swept !== state;
  state = swept;

  const leadSec = ctx.config.budgetRefreshLeadMins * 60;
  const pausedNow = await isBudgetPauseActive(ctx.atmuxDir);

  for (const { account, result } of results) {
    if (result.status !== "allowed") continue;
    for (const window of ["5h", "wk"] as const) {
      const resetEpoch = window === "5h" ? result.h5_reset_epoch : result.wk_reset_epoch;
      const pctUsed = window === "5h" ? result.h5_pct_used : result.wk_pct_used;
      if (resetEpoch <= ctx.nowSec) continue; // stale; sweep handled
      const secsUntil = resetEpoch - ctx.nowSec;
      if (secsUntil > leadSec) continue; // not soon yet
      if (hasRefreshSoonFired(state, account, window, resetEpoch)) continue;
      try {
        await send(
          renderWhipBudgetRefreshSoon({
            team: ctx.team.name,
            account,
            window,
            resetsIn: formatResetIn(resetEpoch, ctx.nowSec),
            remainingPct: 100 - pctUsed,
            pausedNow,
            whenMs: ctx.nowMs,
          }),
        );
      } catch {
        // Best-effort observability.
      }
      state = recordRefreshSoonFire(state, account, window, resetEpoch, ctx.nowSec);
      mutated = true;
    }
  }
  if (mutated) await writeRefreshSoonState(ctx.atmuxDir, state);
}

function formatResetIn(resetEpoch: number, nowSec: number): string {
  const secsLeft = Math.max(0, resetEpoch - nowSec);
  return formatDuration(secsLeft * 1000);
}

function stringifyErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function defaultAppendDriverInbox(atmuxDir: string, content: string): Promise<void> {
  await appendText(driverInboxPath(atmuxDir), content);
}

// ---------- ADR-058 fallback chain helpers ----------

/** Pause-entry leg: snapshot in-flight kanban → dispatchFallback. Caller
 *  has already gated on `ctx.team.fallback?.enabled === true`. */
async function runFallbackDispatch(
  ctx: BudgetCheckCtx,
  deps: BudgetCheckDeps,
  log: (msg: string) => void,
): Promise<void> {
  if (deps.listInFlightTasks === undefined || deps.sendCageBrief === undefined) {
    log("whip: fallback-dispatch: missing listInFlightTasks/sendCageBrief — skipped");
    return;
  }
  const inFlight = await deps.listInFlightTasks();
  if (inFlight.length === 0) {
    log("whip: fallback-dispatch: no in-flight tasks — nothing to delegate");
    return;
  }
  const dispatch = deps.dispatchFallback ?? defaultDispatchFallbackOnPause;
  const dispatchOpts: DispatchFallbackOpts = {
    team: ctx.team.name,
    atmuxDir: ctx.atmuxDir,
    projectCwd: ctx.projectCwd ?? process.cwd(),
    pausedAtSec: ctx.nowSec,
    inFlightTasks: inFlight,
    sendBrief: deps.sendCageBrief,
    log,
    ...(deps.createFallbackCage !== undefined ? { createCage: deps.createFallbackCage } : {}),
  };
  await dispatch(dispatchOpts);
}

/** Resume leg: walk persisted cage handles → continuity briefs + cage
 *  teardown. Caller has already gated on `ctx.team.fallback?.enabled`. */
async function runFallbackWalk(
  ctx: BudgetCheckCtx,
  deps: BudgetCheckDeps,
  pausedAtSec: number,
  log: (msg: string) => void,
): Promise<void> {
  if (deps.sendContinuityBrief === undefined) {
    log("whip: fallback-walk: missing sendContinuityBrief — skipped");
    return;
  }
  const walk = deps.walkFallback ?? defaultWalkFallbackOnResume;
  const walkOpts: WalkFallbackOpts = {
    team: ctx.team.name,
    atmuxDir: ctx.atmuxDir,
    pausedAtSec,
    sendContinuity: deps.sendContinuityBrief,
    log,
    ...(deps.destroyFallbackCage !== undefined ? { destroyCage: deps.destroyFallbackCage } : {}),
  };
  await walk(walkOpts);
}

// ---------- Re-exports for whip.ts ----------

// Tests in tests/unit/core/whip-budget-check.test.ts cover this module
// directly with injected deps; whip.ts integrates by importing
// `runBudgetCheck` only.

// Reference `now` to allow `setNow(...)` test-injection callers to
// confirm the time module is the canonical clock surface for downstream
// callers (band-warning + refresh-soon use `formatMyt(ctx.nowMs)` and
// `ctx.nowSec` which the verb passes in; the `now()` here is a noop
// assertion at compile time that we picked time.ts deliberately).
void now;

// Reference WarningState so the type narrowing at use-sites doesn't get
// elided by the bundler — used by tests to construct seeded states.
export type { WarningState };
