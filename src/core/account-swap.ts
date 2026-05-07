// ADR-056 §D1+D2: account-swap state-file primitives + trigger
// detection + fallback selection + per-team flock.
//
// State file: <atmuxDir>/state/account-swap.json. Lock sidecar
// <atmuxDir>/state/account-swap.lock (flock pattern matches
// whip-idle-state.json.lock + budget-pause.json — concurrent
// whip-tick + manual `atmux account-swap` future verb serialize on
// this file).
//
// T10 ships: state-machine helpers + trigger detection + fallback
// pick + excluded-roles filter. T11 ships: per-member swap workflow
// (spawn shadow, handoff, pause original, decisions[]→done) + Discord
// templates.
//
// Schema (ADR-056 §D1 verbatim):
//   {
//     "active": false,
//     "passId": "swap-<8-hex>",
//     "startedAt": <epoch-sec>,
//     "trigger": { "account": "...", "h5_pct_used": ..., "wk_pct_used": ... },
//     "decisions": {
//       "<member-name>": {
//         "from": "<account>", "to": "<account>",
//         "status": "pending|in-progress|done|aborted|excluded",
//         "startedAt": null|<epoch-sec>,
//         "finishedAt": null|<epoch-sec>,
//         "shadowName": null|"<member>-swap"
//       }
//     },
//     "history": [
//       { "passId": "...", "completedAt": ..., "swapped": ..., "excluded": ..., "aborted": ... }
//     ]
//   }

import { join } from "node:path";
import { appendText, atomicWrite, readTextOrNull, removeFile } from "../abstractions/fs.ts";
import { withLock } from "../abstractions/lock.ts";
import type { BudgetProbeResult } from "../abstractions/budget-probe.ts";
import type { DiscordSendOpts } from "../abstractions/discord.ts";
import {
  renderAccountSwapFail,
  renderAccountSwapPassComplete,
  renderAccountSwapSuccess,
} from "../abstractions/discord.ts";
import { driverInboxPath } from "./common.ts";
import { pauseMember as defaultPauseMember } from "./pause.ts";

// ---------- Constants ----------

const STATE_FILENAME = "account-swap.json";

/** History ring cap per ADR-056 §D1 ("last 20 passes"). */
export const HISTORY_RING_MAX = 20;

/** Stale-progress threshold (sec) — whip tick observing `active: true`
 *  with no decision progress in this window treats the pass as crashed
 *  + releases the lock. ADR-056 §"AC: idempotence on tick interruption"
 *  ("active=true + no progress 5min → next tick observes stale"). */
export const STALE_PROGRESS_SEC = 5 * 60;

// ---------- State-file shape ----------

/** Per-member-name decision row. ADR-056 §D1. */
export type SwapDecisionStatus =
  | "pending"
  | "in-progress"
  | "done"
  | "aborted"
  | "excluded";

export interface SwapDecision {
  from: string;
  to: string;
  status: SwapDecisionStatus;
  /** Epoch seconds; null until the per-member workflow starts. */
  startedAt: number | null;
  /** Epoch seconds; null until the per-member workflow ends. */
  finishedAt: number | null;
  /** Shadow's `<original>-swap` name; null until spawned. */
  shadowName: string | null;
}

/** Trigger snapshot — what tipped the pass. ADR-056 §D1. */
export interface SwapTrigger {
  account: string;
  h5_pct_used: number;
  wk_pct_used: number;
}

/** One closed pass entry in the history ring. ADR-056 §D1. */
export interface SwapHistoryEntry {
  passId: string;
  completedAt: number;
  swapped: number;
  excluded: number;
  aborted: number;
}

/** Top-level state-file shape. */
export interface AccountSwapState {
  active: boolean;
  passId: string;
  startedAt: number;
  trigger: SwapTrigger;
  decisions: Record<string, SwapDecision>;
  history: ReadonlyArray<SwapHistoryEntry>;
}

// ---------- Path / lock ----------

/** `<atmuxDir>/state/account-swap.json`. */
export function accountSwapStatePath(atmuxDir: string): string {
  return join(atmuxDir, "state", STATE_FILENAME);
}

/**
 * Run `fn` while holding the per-team account-swap flock. Sidecar
 * `<path>.lock` matches the whip-idle-state.json.lock + budget-pause
 * pattern. Concurrent whip-tick + future `atmux account-swap` manual
 * verb both speak flock(2), so they serialize correctly.
 *
 * `fn` may return any value (passed through unchanged). Lock is
 * released on `fn` resolve OR throw.
 */
export async function withAccountSwapLock<T>(
  atmuxDir: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  return await withLock(accountSwapStatePath(atmuxDir), fn);
}

// ---------- Read / write / clear ----------

/** Read state if present + valid; null on absence or malformed JSON.
 *  Mirrors `loadBudgetPauseState`'s "loose decode" — neither absence nor
 *  corruption throws (next tick rewrites if needed). */
export async function loadAccountSwapState(
  atmuxDir: string,
): Promise<AccountSwapState | null> {
  const path = accountSwapStatePath(atmuxDir);
  const txt = await readTextOrNull(path);
  if (txt === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(txt);
  } catch {
    return null; // corrupt state — caller treats as no-active-pass
  }
  if (!isSwapState(parsed)) return null;
  return parsed;
}

/** True iff a valid state-file is present AND `active === true`. Caller
 *  pairs with `isStaleActiveState` for the idempotence-on-crash path. */
export async function isAccountSwapActive(atmuxDir: string): Promise<boolean> {
  const s = await loadAccountSwapState(atmuxDir);
  return s !== null && s.active === true;
}

/** Atomic write. Caller wraps in `withAccountSwapLock` when concurrent
 *  writers exist. */
export async function writeAccountSwapState(
  atmuxDir: string,
  state: AccountSwapState,
): Promise<void> {
  await atomicWrite(accountSwapStatePath(atmuxDir), JSON.stringify(state));
}

/** Idempotent — absence is fine. T11 calls this on pass-complete to
 *  archive into `history` (separate write) + then clear. T10 leaves it
 *  exposed for crash-recovery paths. */
export async function clearAccountSwapState(atmuxDir: string): Promise<void> {
  await removeFile(accountSwapStatePath(atmuxDir));
}

// ---------- Idempotence / staleness ----------

/**
 * ADR-056 §"AC: idempotence on tick interruption". Active state with NO
 * decision progress in the last `STALE_PROGRESS_SEC` is presumed
 * crashed. Caller releases the lock + marks in-progress decisions
 * aborted.
 *
 * "Progress" = the most recent `startedAt` OR `finishedAt` across all
 * decisions. Falls back to `state.startedAt` if no decision has fired.
 */
export function isStaleActiveState(
  state: AccountSwapState,
  nowSec: number,
): boolean {
  if (!state.active) return false;
  let lastProgress = state.startedAt;
  for (const d of Object.values(state.decisions)) {
    if (d.startedAt !== null && d.startedAt > lastProgress) lastProgress = d.startedAt;
    if (d.finishedAt !== null && d.finishedAt > lastProgress) lastProgress = d.finishedAt;
  }
  return nowSec - lastProgress > STALE_PROGRESS_SEC;
}

/** Mark in-progress decisions aborted on stale-recovery + return the
 *  next state to persist. Pure — caller does the write. */
export function abortInProgressDecisions(
  state: AccountSwapState,
  nowSec: number,
): AccountSwapState {
  const next: Record<string, SwapDecision> = { ...state.decisions };
  for (const [name, d] of Object.entries(next)) {
    if (d.status === "in-progress") {
      next[name] = { ...d, status: "aborted", finishedAt: nowSec };
    }
  }
  return { ...state, decisions: next, active: false };
}

// ---------- runId / passId ----------

/** `swap-<8-hex>` per ADR-056 §D1. */
export function generatePassId(rng: () => number = Math.random): string {
  const hex = Math.floor(rng() * 0xff_ff_ff_ff)
    .toString(16)
    .padStart(8, "0")
    .slice(0, 8);
  return `swap-${hex}`;
}

// ---------- Trigger detection ----------

export interface AccountProbeMap {
  /** Map of account-name → its latest `BudgetProbeResult`. Caller fills
   *  this from the per-tick probe sweep — `runBudgetCheck` already
   *  probes every account; T10 reuses the same result set. */
  byAccount: ReadonlyMap<string, BudgetProbeResult>;
}

/**
 * Find the FIRST account whose pct-used (either window) ≥ threshold.
 * ADR-056 §D2 (1) — "for each account observed on this team: read
 * latest probe; if h5 OR wk ≥ trigger → swap candidate".
 *
 * Order is deterministic — caller passes accounts in iteration order
 * (typically the order they appear in `team.members`). Returns null
 * when no account is over threshold OR all probes have non-`allowed`
 * status.
 */
export function findTriggerAccount(
  accounts: ReadonlyArray<string>,
  probes: AccountProbeMap,
  threshold: number,
): SwapTrigger | null {
  for (const account of accounts) {
    const r = probes.byAccount.get(account);
    if (r === undefined) continue;
    if (r.status !== "allowed") continue;
    if (r.h5_pct_used >= threshold || r.wk_pct_used >= threshold) {
      return {
        account,
        h5_pct_used: r.h5_pct_used,
        wk_pct_used: r.wk_pct_used,
      };
    }
  }
  return null;
}

/**
 * Walk `fallbackChain` in priority order; return the first account
 * with BOTH `h5_pct_used` AND `wk_pct_used` ≤ `healthThreshold`.
 * Skips the trigger account itself (can't fallback to ourselves).
 *
 * ADR-056 §D2 (2) — "first fallback with BOTH h5 ≤ 50 AND wk ≤ 50
 * wins. (50% threshold for fallback healthiness — half-used is
 * safe-enough; deeper would over-constrain.)"
 *
 * Returns null when no fallback satisfies the health gate; caller
 * falls through to the budget-pause path.
 */
export function pickFallbackAccount(
  fallbackChain: ReadonlyArray<string>,
  triggerAccount: string,
  probes: AccountProbeMap,
  healthThreshold: number,
): string | null {
  for (const candidate of fallbackChain) {
    if (candidate === triggerAccount) continue;
    const r = probes.byAccount.get(candidate);
    if (r === undefined) continue;
    if (r.status !== "allowed") continue;
    if (r.h5_pct_used > healthThreshold) continue;
    if (r.wk_pct_used > healthThreshold) continue;
    return candidate;
  }
  return null;
}

// ---------- Excluded-roles filter ----------

export interface SwapEligibleMember {
  name: string;
  /** Resolved account ID — `claudeAccount` if present, else the
   *  team-default fallback that the caller passes through. */
  account: string;
  role: string;
}

export interface MemberLike {
  name: string;
  role?: string;
  /** `passthrough()` lets `claudeAccount` ride on TeamMember rows
   *  without an explicit schema field. T10 reads it loosely. */
  claudeAccount?: string;
}

/**
 * Members eligible for swap on this trigger. Filters:
 *  1. Member's effective account === trigger.account.
 *  2. Member's role NOT in `excludeRoles` (default lead/planner/reviewer).
 *  3. Member without an explicit role is treated as worker → eligible.
 *
 * `defaultAccount` is `team.whip.claudeAccount` (per-team default).
 * When a member's row has no `claudeAccount` field, this default is
 * used. Pass empty string to mean "no team default".
 */
export function eligibleMembersForSwap(
  members: ReadonlyArray<MemberLike>,
  triggerAccount: string,
  excludeRoles: ReadonlyArray<string>,
  defaultAccount: string,
): SwapEligibleMember[] {
  const exclude = new Set(excludeRoles);
  const out: SwapEligibleMember[] = [];
  for (const m of members) {
    const acc = resolveAccount(m, defaultAccount);
    if (acc !== triggerAccount) continue;
    const role = m.role ?? "worker";
    if (exclude.has(role)) continue;
    out.push({ name: m.name, account: acc, role });
  }
  return out;
}

function resolveAccount(member: MemberLike, defaultAccount: string): string {
  const a = member.claudeAccount;
  if (a !== undefined && a !== null && a !== "" && a !== "null") return a;
  return defaultAccount;
}

// ---------- Pass builder ----------

export interface BuildPassOpts {
  trigger: SwapTrigger;
  candidates: ReadonlyArray<SwapEligibleMember>;
  fallbackAccount: string;
  /** All members on the trigger account whose role lands them in the
   *  excluded set. Populates `decisions[].status = "excluded"` so the
   *  pass-complete tally has visibility into who was skipped. */
  excludedMembers: ReadonlyArray<{ name: string; from: string }>;
  passId: string;
  startedAt: number;
  /** History ring carried forward from a prior pass (capped on write). */
  priorHistory?: ReadonlyArray<SwapHistoryEntry>;
}

/**
 * Compose the initial `AccountSwapState` for a fresh pass. T10 writes
 * this to disk; T11 reads it + walks `decisions` in insertion order to
 * fire per-member workflows.
 */
export function buildSwapPass(opts: BuildPassOpts): AccountSwapState {
  const decisions: Record<string, SwapDecision> = {};
  for (const m of opts.candidates) {
    decisions[m.name] = {
      from: m.account,
      to: opts.fallbackAccount,
      status: "pending",
      startedAt: null,
      finishedAt: null,
      shadowName: null,
    };
  }
  for (const m of opts.excludedMembers) {
    decisions[m.name] = {
      from: m.from,
      to: opts.fallbackAccount,
      status: "excluded",
      startedAt: null,
      finishedAt: null,
      shadowName: null,
    };
  }
  return {
    active: true,
    passId: opts.passId,
    startedAt: opts.startedAt,
    trigger: opts.trigger,
    decisions,
    history: (opts.priorHistory ?? []).slice(-HISTORY_RING_MAX),
  };
}

/** Members on the trigger account whose role lands them in the
 *  exclusion set. Used to populate `decisions[].status = "excluded"`. */
export function excludedMembersForSwap(
  members: ReadonlyArray<MemberLike>,
  triggerAccount: string,
  excludeRoles: ReadonlyArray<string>,
  defaultAccount: string,
): Array<{ name: string; from: string }> {
  const exclude = new Set(excludeRoles);
  const out: Array<{ name: string; from: string }> = [];
  for (const m of members) {
    const acc = resolveAccount(m, defaultAccount);
    if (acc !== triggerAccount) continue;
    const role = m.role ?? "worker";
    if (!exclude.has(role)) continue;
    out.push({ name: m.name, from: acc });
  }
  return out;
}

// ---------- Per-tick orchestrator ----------

/** Verdict returned by `runAccountSwapCheck`. The caller (whip.ts) uses
 *  this to decide whether to skip the budget-pause-fire path. */
export type AccountSwapVerdict =
  /** No `accountFallback` configured OR no probes available — feature
   *  is dormant for this team; caller proceeds to budget-pause path. */
  | "disabled"
  /** A pass is already active + non-stale; T11's per-member workflow
   *  owns the next action. Caller skips budget-pause for the trigger
   *  account but lets the rest of the tick proceed normally. */
  | "active-pass"
  /** A previous active pass was stale (> 5min no progress); state was
   *  cleaned up + in-progress decisions marked aborted. Caller treats
   *  as "no swap fired this tick" — proceeds to budget-pause. */
  | "stale-recovered"
  /** No account is over the trigger threshold this tick. */
  | "no-trigger"
  /** Trigger fired but no fallback satisfied the health threshold —
   *  caller falls through to budget-pause per ADR-056 §D2. */
  | "no-viable-fallback"
  /** A new pass was entered this tick; state-file written, decisions
   *  populated. Caller skips budget-pause for the trigger account. */
  | "pass-entered";

export interface AccountSwapCheckCtx {
  atmuxDir: string;
  /** Epoch seconds — used for staleness + state.startedAt + per-decision
   *  startedAt. */
  nowSec: number;
  /** All members of the team; per-member `claudeAccount` is read loosely
   *  (TeamMember row passes through unknown fields). */
  members: ReadonlyArray<MemberLike>;
  /** Per-team `whip` config — only the swap-related knobs are consumed
   *  here. */
  config: AccountSwapConfig;
}

export interface AccountSwapConfig {
  /** Ordered fallback chain. Empty = swap disabled. */
  accountFallback: ReadonlyArray<string>;
  /** Default 75 — pct-used at which swap fires. */
  accountSwapTriggerThreshold: number;
  /** Default 50 — fallback is viable when both windows ≤ this. */
  accountSwapFallbackHealthThreshold: number;
  /** Default lead/planner/reviewer. */
  accountSwapExcludeRoles: ReadonlyArray<string>;
  /** Per-team default account when a member's row has no
   *  `claudeAccount`. Pulled from `team.whip.claudeAccount`. */
  defaultAccount: string;
}

export interface AccountSwapCheckDeps {
  /** Probe one account's budget. Caller may share the same dep with
   *  ADR-053's budget-check so the probe cache (240s TTL) absorbs the
   *  double-call. Probes the trigger account for state + each fallback
   *  candidate to gate health. */
  probeBudget: (account: string, opts?: { force?: boolean }) => Promise<BudgetProbeResult>;
  /** Optional logger — caller injects ctx.stderr-equivalent. Default
   *  no-op (state-file is the audit trail). */
  log?: (msg: string) => void;
  /** runId factory override (test injection). */
  passIdFactory?: () => string;
}

/**
 * Orchestrate the per-tick swap-trigger pass. Mirrors
 * `runBudgetCheck` shape so callers can compose them in whip.ts.
 *
 * Steps (ADR-056 §D2):
 *   1. Read existing state under the swap lock.
 *   2. If active + non-stale → return `"active-pass"`.
 *   3. If active + stale → release in-progress decisions, clear active, return `"stale-recovered"`.
 *   4. Probe every observed account.
 *   5. Find first account ≥ trigger threshold.
 *   6. If none → return `"no-trigger"`.
 *   7. Pick fallback (force-fresh probe per ADR-056 §D2).
 *   8. If no viable fallback → return `"no-viable-fallback"`.
 *   9. Build pass + write state-file, return `"pass-entered"`.
 */
export async function runAccountSwapCheck(
  ctx: AccountSwapCheckCtx,
  deps: AccountSwapCheckDeps,
): Promise<AccountSwapVerdict> {
  const log = deps.log ?? (() => {});
  const passIdFactory = deps.passIdFactory ?? generatePassId;

  if (ctx.config.accountFallback.length === 0) return "disabled";

  // Step 1+2+3: serialize on the swap lock.
  return await withAccountSwapLock(ctx.atmuxDir, async () => {
    const existing = await loadAccountSwapState(ctx.atmuxDir);
    if (existing?.active === true) {
      if (isStaleActiveState(existing, ctx.nowSec)) {
        log("whip: account-swap pass stale (>5min no progress) — recovering");
        const recovered = abortInProgressDecisions(existing, ctx.nowSec);
        await writeAccountSwapState(ctx.atmuxDir, recovered);
        return "stale-recovered";
      }
      log(`whip: account-swap pass ${existing.passId} active — skipping trigger detect`);
      return "active-pass";
    }

    // Step 4: gather unique accounts from member roster.
    const accounts = uniqueAccounts(ctx.members, ctx.config.defaultAccount);
    if (accounts.length === 0) return "disabled";

    const probes = new Map<string, BudgetProbeResult>();
    for (const a of accounts) {
      probes.set(a, await deps.probeBudget(a));
    }

    // Step 5: find first account over the trigger.
    const trigger = findTriggerAccount(
      accounts,
      { byAccount: probes },
      ctx.config.accountSwapTriggerThreshold,
    );
    if (trigger === null) return "no-trigger";

    // Step 7: walk the priority list. Re-probe each candidate with
    // force=true (ADR-056 §D2: "Re-probe target with force=true (no
    // stale cache)").
    let fallback: string | null = null;
    for (const candidate of ctx.config.accountFallback) {
      if (candidate === trigger.account) continue;
      const r = await deps.probeBudget(candidate, { force: true });
      probes.set(candidate, r);
      if (r.status !== "allowed") continue;
      if (r.h5_pct_used > ctx.config.accountSwapFallbackHealthThreshold) continue;
      if (r.wk_pct_used > ctx.config.accountSwapFallbackHealthThreshold) continue;
      fallback = candidate;
      break;
    }
    if (fallback === null) {
      log(`whip: account-swap trigger fired for ${trigger.account} but no viable fallback`);
      return "no-viable-fallback";
    }

    // Step 9: build + write the new pass.
    const candidates = eligibleMembersForSwap(
      ctx.members,
      trigger.account,
      ctx.config.accountSwapExcludeRoles,
      ctx.config.defaultAccount,
    );
    const excluded = excludedMembersForSwap(
      ctx.members,
      trigger.account,
      ctx.config.accountSwapExcludeRoles,
      ctx.config.defaultAccount,
    );
    if (candidates.length === 0) {
      // All members on the trigger account were excluded — no work to
      // do, treat as "no-trigger" so caller proceeds to budget-pause.
      log(
        `whip: account-swap trigger fired for ${trigger.account} but all members excluded`,
      );
      return "no-trigger";
    }
    const passOpts: BuildPassOpts = {
      trigger,
      candidates,
      fallbackAccount: fallback,
      excludedMembers: excluded,
      passId: passIdFactory(),
      startedAt: ctx.nowSec,
    };
    if (existing?.history !== undefined) passOpts.priorHistory = existing.history;
    const pass = buildSwapPass(passOpts);
    await writeAccountSwapState(ctx.atmuxDir, pass);
    log(
      `whip: account-swap pass ${pass.passId} entered (${candidates.length} candidates → ${fallback})`,
    );
    return "pass-entered";
  });
}

/** Unique accounts present on the team's roster. Mirrors
 *  `uniqueAccounts` in whip-budget-check but with the per-team default
 *  threaded through (so a member without an explicit `claudeAccount`
 *  contributes the team default, not silently skipped). */
function uniqueAccounts(
  members: ReadonlyArray<MemberLike>,
  defaultAccount: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of members) {
    const a = resolveAccount(m, defaultAccount);
    if (a === "" || a === "default" || a === "null") continue;
    if (seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

// ---------- Per-member workflow (ADR-056 §D3) ----------

/** Per-swap deadline (sec). Default 300 (ADR-056 §"Push-back" 5-min cap).
 *  Operator overrides via `team.whip.accountSwapPerMemberDeadlineSec`. */
export const DEFAULT_PER_MEMBER_DEADLINE_SEC = 300;

/** Inbox poll budget for shadow ack confirmation (sec). ADR-056 §D3 step 6. */
export const SHADOW_ACK_TIMEOUT_SEC = 10;

/** Pane-prompt poll budget for shadow spawn confirmation (sec). ADR-056 §D3 step 4. */
export const SHADOW_SPAWN_TIMEOUT_SEC = 10;

export interface SpawnShadowResult {
  /** Final shadow name (collision-detect may have rewritten to `<base>-2`). */
  shadowName: string;
  /** True when the shadow's pane reached prompt within timeout. */
  ready: boolean;
  /** Failure detail when `ready === false`. */
  error?: string;
}

export interface HandoffResult {
  /** Task id transferred (or null when source had nothing in-flight). */
  taskId: string | null;
  /** True when the shadow ACK'd within timeout. */
  acked: boolean;
  error?: string;
}

export interface FailureFlag {
  /** Severity per ADR-056 §D6 — typically `p2`. */
  severity: "p0" | "p1" | "p2";
  /** Optional flag id when caller raised one via `atmux flag add`. */
  flagId: string | null;
}

/** Per-member workflow injection surface. Production wiring composes
 *  these from spawn/handoff/pause primitives; tests inject deterministic
 *  fakes to drive every failure-mode branch. */
export interface PerMemberSwapDeps {
  /** Force-fresh probe of the target account. ADR-056 §D3 step 1. */
  probeTarget: (account: string) => Promise<BudgetProbeResult>;
  /** Programmatic shadow spawn: name + role + lane + cwd cloned from
   *  original onto the target account. Returns shadow name (collision-
   *  detect appends `-2` etc.) + readiness. ADR-056 §D3 step 3-4. */
  spawnShadow: (opts: {
    originalName: string;
    targetAccount: string;
    timeoutSec: number;
  }) => Promise<SpawnShadowResult>;
  /** Run `atmux handoff <from> <to>` + poll for shadow ACK. ADR-056
   *  §D3 step 5-6. */
  handoff: (opts: {
    fromMember: string;
    toMember: string;
    timeoutSec: number;
  }) => Promise<HandoffResult>;
  /** Pause the original member. ADR-056 §D3 step 7. */
  pauseMember: (atmuxDir: string, member: string, opts: { reason: string }) => Promise<void>;
  /** Send a Discord ping for per-member success/fail. */
  discordSend?: (opts: DiscordSendOpts) => Promise<void>;
  /** Raise a flag entry (atmux flag add) on per-member abort. Default
   *  no-op so unit tests don't shell out; concrete wiring in T11
   *  follow-up if `atmux flags add` lands a programmatic API. */
  raiseFlag?: (opts: {
    severity: "p0" | "p1" | "p2";
    body: string;
    member: string;
  }) => Promise<FailureFlag>;
  /** Append driver-inbox surfacing on pass-complete. Default writes
   *  to `<atmuxDir>/driver-inbox.md`. */
  appendDriverInbox?: (atmuxDir: string, content: string) => Promise<void>;
  /** Logger. Default no-op. */
  log?: (msg: string) => void;
  /** Clock override (test injection). Returns epoch milliseconds. */
  nowMs?: () => number;
}

export interface PerMemberSwapResult {
  /** Updated decision row reflecting workflow outcome. */
  decision: SwapDecision;
  /** Wall-clock duration of the workflow in milliseconds. */
  durationMs: number;
}

/**
 * Walk the §D3 7-step workflow for a single member. Returns the
 * updated decision row; caller persists state-file changes (so the
 * orchestrator owns transactionality across decisions). Idempotent on
 * already-`done`/`aborted`/`excluded` rows — short-circuits to a no-op
 * with the input row passed through.
 *
 * Failure semantics (ADR-056 §D6):
 *  - `probeTarget` 401 / non-allowed → `aborted` + reason "target probe 401".
 *  - `spawnShadow.ready === false` → `aborted` + reason "shadow spawn timeout/fail".
 *  - `handoff.acked === false` → `aborted` + reason "shadow ack timeout".
 *  - Wall-clock > deadline → `aborted` + reason "deadline exceeded".
 *  - All success steps → `done` + `shadowName` + `finishedAt` set.
 *
 * Per-member success / fail Discord ping is fired here (when `discordSend`
 * is wired); pass-level pings are the runSwapPass orchestrator's job.
 */
export async function perMemberSwap(
  atmuxDir: string,
  memberName: string,
  decision: SwapDecision,
  team: string,
  config: { perMemberDeadlineSec: number; passProgress: { done: number; total: number } },
  deps: PerMemberSwapDeps,
): Promise<PerMemberSwapResult> {
  const log = deps.log ?? (() => {});
  const nowMs = deps.nowMs ?? (() => Date.now());
  const t0 = nowMs();

  if (decision.status === "done" || decision.status === "aborted" || decision.status === "excluded") {
    log(`account-swap: ${memberName} already ${decision.status} — skipping`);
    return { decision, durationMs: 0 };
  }

  const startedAt = Math.floor(t0 / 1000);
  const inProgress: SwapDecision = {
    ...decision,
    status: "in-progress",
    startedAt,
  };

  // Step 1 — probe target.
  const probeResult = await deps.probeTarget(decision.to);
  if (probeResult.status !== "allowed") {
    return await abort(
      atmuxDir,
      memberName,
      inProgress,
      team,
      config.passProgress,
      "target probe 401",
      `refresh failed for \`${decision.to}\` — re-login needed`,
      "p2",
      deps,
      t0,
      nowMs,
    );
  }

  // Deadline check pre-spawn.
  if (Math.floor((nowMs() - t0) / 1000) > config.perMemberDeadlineSec) {
    return await abort(
      atmuxDir,
      memberName,
      inProgress,
      team,
      config.passProgress,
      "deadline exceeded",
      `pre-spawn deadline (>${config.perMemberDeadlineSec}s) on probe`,
      "p2",
      deps,
      t0,
      nowMs,
    );
  }

  // Step 3+4 — spawn shadow.
  const spawn = await deps.spawnShadow({
    originalName: memberName,
    targetAccount: decision.to,
    timeoutSec: SHADOW_SPAWN_TIMEOUT_SEC,
  });
  if (!spawn.ready) {
    return await abort(
      atmuxDir,
      memberName,
      inProgress,
      team,
      config.passProgress,
      "spawn timeout",
      spawn.error ?? "shadow pane never reached prompt",
      "p2",
      deps,
      t0,
      nowMs,
    );
  }
  const withShadow: SwapDecision = { ...inProgress, shadowName: spawn.shadowName };

  // Deadline check post-spawn.
  if (Math.floor((nowMs() - t0) / 1000) > config.perMemberDeadlineSec) {
    return await abort(
      atmuxDir,
      memberName,
      withShadow,
      team,
      config.passProgress,
      "deadline exceeded",
      `post-spawn deadline (>${config.perMemberDeadlineSec}s)`,
      "p2",
      deps,
      t0,
      nowMs,
    );
  }

  // Step 5+6 — handoff + ack.
  const handoff = await deps.handoff({
    fromMember: memberName,
    toMember: spawn.shadowName,
    timeoutSec: SHADOW_ACK_TIMEOUT_SEC,
  });
  if (!handoff.acked) {
    return await abort(
      atmuxDir,
      memberName,
      withShadow,
      team,
      config.passProgress,
      "handoff ack timeout",
      handoff.error ?? "shadow did not ack handoff within timeout",
      "p1",
      deps,
      t0,
      nowMs,
    );
  }

  // Step 7 — pause original.
  await deps.pauseMember(atmuxDir, memberName, {
    reason: `account-swap → ${spawn.shadowName} on ${decision.to}`,
  });

  // Step 8+9 — flip decision + Discord success.
  const finishedAt = Math.floor(nowMs() / 1000);
  const done: SwapDecision = {
    ...withShadow,
    status: "done",
    finishedAt,
  };

  const durationMs = nowMs() - t0;
  if (deps.discordSend !== undefined) {
    try {
      await deps.discordSend(
        renderAccountSwapSuccess({
          team,
          fromMember: memberName,
          toMember: spawn.shadowName,
          toAccount: decision.to,
          taskId: handoff.taskId,
          durationMs,
          progressDone: config.passProgress.done + 1,
          progressTotal: config.passProgress.total,
        }),
      );
    } catch (e) {
      log(`account-swap: discord success ping failed for ${memberName}: ${String(e)}`);
    }
  }

  return { decision: done, durationMs };
}

async function abort(
  _atmuxDir: string,
  memberName: string,
  decisionInProgress: SwapDecision,
  team: string,
  passProgress: { done: number; total: number },
  failureBrief: string,
  reason: string,
  severity: "p0" | "p1" | "p2",
  deps: PerMemberSwapDeps,
  t0: number,
  nowMs: () => number,
): Promise<PerMemberSwapResult> {
  const log = deps.log ?? (() => {});
  const finishedAt = Math.floor(nowMs() / 1000);
  let flagId: string | null = null;
  if (deps.raiseFlag !== undefined) {
    try {
      const f = await deps.raiseFlag({
        severity,
        body: `account-swap aborted for ${memberName}: ${reason}`,
        member: memberName,
      });
      flagId = f.flagId;
    } catch (e) {
      log(`account-swap: raiseFlag failed for ${memberName}: ${String(e)}`);
    }
  }

  if (deps.discordSend !== undefined) {
    try {
      await deps.discordSend(
        renderAccountSwapFail({
          team,
          member: memberName,
          failureBrief,
          reason,
          fallbackAccount: decisionInProgress.from,
          flagId,
          flagSeverity: severity,
        }),
      );
    } catch (e) {
      log(`account-swap: discord fail ping failed for ${memberName}: ${String(e)}`);
    }
  }

  // Suppress unused-var warning for passProgress — pass-progress affects
  // the success-path only; aborts don't decrement the counter (no swap
  // landed). Voiding the unused param keeps the signature symmetric for
  // future extensions (e.g. progress in fail-template body).
  void passProgress;

  return {
    decision: {
      ...decisionInProgress,
      status: "aborted",
      finishedAt,
    },
    durationMs: nowMs() - t0,
  };
}

// ---------- Pass orchestrator (walks decisions[]) ----------

export interface RunPassOpts {
  team: string;
  /** Per-tick progress budget — orchestrator runs ONE decision per tick
   *  (matches ADR-056 §D3 "sequential, one-at-a-time"). When false,
   *  walks all pending decisions in one call (used by tests + the
   *  future `atmux account-swap` manual verb). Default true. */
  oneAtATime?: boolean;
  /** Per-member deadline override; default DEFAULT_PER_MEMBER_DEADLINE_SEC. */
  perMemberDeadlineSec?: number;
  /** Discord send override (test injection); also threaded into PerMemberSwapDeps. */
  discordSend?: (opts: DiscordSendOpts) => Promise<void>;
  /** Append-driver-inbox override (test injection). */
  appendDriverInbox?: (atmuxDir: string, content: string) => Promise<void>;
  /** Clock override (test injection). */
  nowMs?: () => number;
  /** Logger. */
  log?: (msg: string) => void;
}

export interface RunPassResult {
  /** Verdict per tick. */
  verdict:
    | "no-active-pass"
    | "advanced"
    | "pass-complete"
    | "no-pending-decisions";
  /** Names of decisions touched this tick (status flipped). */
  touched: ReadonlyArray<string>;
  /** Updated state-file content (post-write). */
  state: AccountSwapState | null;
}

/**
 * Drive an active pass forward by one decision (or all pending when
 * `oneAtATime: false`). Reads existing state under the swap lock,
 * walks pending decisions in insertion order, calls `perMemberSwap`,
 * persists each decision flip, fires pass-complete ping when the last
 * pending decision lands.
 *
 * Per-tick semantic (ADR-056 §D3 "sequential, one-at-a-time"): default
 * `oneAtATime: true` runs a single decision per call; whip's tick loop
 * fires this once per tick to advance the pass without blocking the
 * tick on a multi-minute walk.
 */
export async function runSwapPass(
  atmuxDir: string,
  deps: PerMemberSwapDeps,
  opts: RunPassOpts,
): Promise<RunPassResult> {
  const oneAtATime = opts.oneAtATime ?? true;
  const perMemberDeadlineSec =
    opts.perMemberDeadlineSec ?? DEFAULT_PER_MEMBER_DEADLINE_SEC;
  const log = opts.log ?? deps.log ?? (() => {});
  const nowMs = opts.nowMs ?? deps.nowMs ?? (() => Date.now());
  const send = opts.discordSend ?? deps.discordSend;
  const appendDi = opts.appendDriverInbox ?? deps.appendDriverInbox ?? defaultAppendDriverInbox;

  const composedDeps: PerMemberSwapDeps = {
    ...deps,
    log,
    nowMs,
  };
  if (send !== undefined) composedDeps.discordSend = send;

  return await withAccountSwapLock(atmuxDir, async () => {
    const state = await loadAccountSwapState(atmuxDir);
    if (state === null || !state.active) {
      return { verdict: "no-active-pass", touched: [], state };
    }

    const pending = pendingDecisionNames(state);
    if (pending.length === 0) {
      // No pending decisions but pass still active → close it.
      const closed = await finalizePass(atmuxDir, state, send, appendDi, log, nowMs, opts.team);
      return { verdict: "pass-complete", touched: [], state: closed };
    }

    const touched: string[] = [];
    let mutating = state;
    const limit = oneAtATime ? 1 : pending.length;
    for (let i = 0; i < limit; i++) {
      const name = pending[i];
      if (name === undefined) break;
      const decision = mutating.decisions[name];
      if (decision === undefined) continue;
      const doneCount = countByStatus(mutating, "done");
      const total = Object.values(mutating.decisions).filter(
        (d) => d.status !== "excluded",
      ).length;
      const result = await perMemberSwap(
        atmuxDir,
        name,
        decision,
        opts.team,
        {
          perMemberDeadlineSec,
          passProgress: { done: doneCount, total },
        },
        composedDeps,
      );
      mutating = {
        ...mutating,
        decisions: { ...mutating.decisions, [name]: result.decision },
      };
      await writeAccountSwapState(atmuxDir, mutating);
      touched.push(name);
    }

    // After advancing, check whether the pass is complete.
    const stillPending = pendingDecisionNames(mutating);
    if (stillPending.length === 0) {
      const closed = await finalizePass(atmuxDir, mutating, send, appendDi, log, nowMs, opts.team);
      return { verdict: "pass-complete", touched, state: closed };
    }
    return { verdict: "advanced", touched, state: mutating };
  });
}

/** Names of `pending` decisions in insertion order. `excluded` skipped
 *  (no work to do); `in-progress` skipped here too (orchestrator's job
 *  is to advance from `pending` only — `in-progress` rows were left
 *  mid-flight and need stale-recovery via `runAccountSwapCheck`). */
function pendingDecisionNames(state: AccountSwapState): string[] {
  const out: string[] = [];
  for (const [name, d] of Object.entries(state.decisions)) {
    if (d.status === "pending") out.push(name);
  }
  return out;
}

function countByStatus(state: AccountSwapState, status: SwapDecisionStatus): number {
  let c = 0;
  for (const d of Object.values(state.decisions)) {
    if (d.status === status) c += 1;
  }
  return c;
}

/** Close the pass: archive into history, set active=false, fire
 *  pass-complete Discord ping, surface to driver-inbox. Returns the
 *  written state. */
async function finalizePass(
  atmuxDir: string,
  state: AccountSwapState,
  send: ((opts: DiscordSendOpts) => Promise<void>) | undefined,
  appendDi: (atmuxDir: string, content: string) => Promise<void>,
  log: (msg: string) => void,
  nowMs: () => number,
  team: string,
): Promise<AccountSwapState> {
  const completedAt = Math.floor(nowMs() / 1000);
  const swapped = countByStatus(state, "done");
  const aborted = countByStatus(state, "aborted");
  const excluded = countByStatus(state, "excluded");
  const historyEntry: SwapHistoryEntry = {
    passId: state.passId,
    completedAt,
    swapped,
    excluded,
    aborted,
  };
  const closed: AccountSwapState = {
    ...state,
    active: false,
    history: [...state.history, historyEntry].slice(-HISTORY_RING_MAX),
  };
  await writeAccountSwapState(atmuxDir, closed);

  if (send !== undefined) {
    try {
      await send(
        renderAccountSwapPassComplete({
          team,
          passId: state.passId,
          swapped,
          aborted,
          excluded,
          triggerAccount: state.trigger.account,
          // Post-pass utilization is the trigger's pre-swap value — a
          // proper post-pass probe would land in T11 follow-up where
          // we re-probe at finalize time. For now reuse the trigger
          // snapshot which proves which account fired (ADR-056 §D5
          // example explicitly shows the same number, "76% used").
          triggerPctPostPass: Math.max(state.trigger.h5_pct_used, state.trigger.wk_pct_used),
          durationMs: (completedAt - state.startedAt) * 1000,
        }),
      );
    } catch (e) {
      log(`account-swap: discord pass-complete ping failed: ${String(e)}`);
    }
  }

  // Driver-inbox surface (ADR-056 §D4 "from→to map at swap-pass-close").
  const lines: string[] = [`### 🔄 account-swap pass \`${state.passId}\` complete`, ""];
  lines.push(
    `- swapped: **${swapped}** / aborted: **${aborted}** / excluded: **${excluded}**`,
  );
  for (const [name, d] of Object.entries(state.decisions)) {
    if (d.status === "done" && d.shadowName !== null) {
      lines.push(`- ✅ \`${name}\` → \`${d.shadowName}\` on \`${d.to}\``);
    } else if (d.status === "aborted") {
      lines.push(`- ❌ \`${name}\` (aborted) — staying on \`${d.from}\``);
    }
  }
  lines.push("");
  try {
    await appendDi(atmuxDir, `${lines.join("\n")}\n`);
  } catch (e) {
    log(`account-swap: driver-inbox append failed: ${String(e)}`);
  }

  return closed;
}

/** Default driver-inbox writer. Uses the shared `appendText` primitive
 *  with R6-compliant typed-error wrapping. */
async function defaultAppendDriverInbox(atmuxDir: string, content: string): Promise<void> {
  await appendText(driverInboxPath(atmuxDir), content);
}

// Keep core/pause.ts import live — concrete dep wire-up below uses it.
void defaultPauseMember;

// ---------- Validation ----------

function isSwapState(v: unknown): v is AccountSwapState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.active !== "boolean") return false;
  if (typeof o.passId !== "string") return false;
  if (typeof o.startedAt !== "number") return false;
  if (!isTrigger(o.trigger)) return false;
  if (typeof o.decisions !== "object" || o.decisions === null) return false;
  for (const d of Object.values(o.decisions as Record<string, unknown>)) {
    if (!isDecision(d)) return false;
  }
  if (!Array.isArray(o.history)) return false;
  for (const h of o.history) if (!isHistoryEntry(h)) return false;
  return true;
}

function isTrigger(v: unknown): v is SwapTrigger {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.account === "string" &&
    typeof o.h5_pct_used === "number" &&
    typeof o.wk_pct_used === "number"
  );
}

function isDecision(v: unknown): v is SwapDecision {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.from !== "string") return false;
  if (typeof o.to !== "string") return false;
  if (
    o.status !== "pending" &&
    o.status !== "in-progress" &&
    o.status !== "done" &&
    o.status !== "aborted" &&
    o.status !== "excluded"
  ) {
    return false;
  }
  if (o.startedAt !== null && typeof o.startedAt !== "number") return false;
  if (o.finishedAt !== null && typeof o.finishedAt !== "number") return false;
  if (o.shadowName !== null && typeof o.shadowName !== "string") return false;
  return true;
}

function isHistoryEntry(v: unknown): v is SwapHistoryEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.passId === "string" &&
    typeof o.completedAt === "number" &&
    typeof o.swapped === "number" &&
    typeof o.excluded === "number" &&
    typeof o.aborted === "number"
  );
}
