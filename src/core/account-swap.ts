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
import { atomicWrite, readTextOrNull, removeFile } from "../abstractions/fs.ts";
import { withLock } from "../abstractions/lock.ts";
import type { BudgetProbeResult } from "../abstractions/budget-probe.ts";

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
