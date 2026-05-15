// ADR-010 + ADR-022: CLI dispatcher — `whip` verb (V-25).
// Bash spec: lib/whip.sh @ HEAD 2aadc3f (1324 LOC) — IN-SCOPE SUBSET only.
//
// 5-min watchdog intended for cron:
//
//   */5 * * * * cd /path/to/project && /usr/local/bin/atmux whip \
//                                       >> .atmux/logs/whip.log 2>&1
//
// Checks performed each tick (per ADR-022 in-scope table):
//   1. tmux session liveness, with a 2-tick session-DOWN gate to suppress
//      false alerts during transient tmux hiccups (origin: 2026-04-25
//      incident — 5 false alerts under cron+swap pressure with single-tick).
//   2. per-member pane TUI verification (claude / opencode / kimi /
//      cursor-agent). Crashed = pane_current_command falls back to a shell.
//      Plus the ADR-024 cross-account drift detector (~10 LOC): read each
//      member's CLAUDE_CONFIG_DIR via /proc/<pid>/environ, compare to
//      driver's; mismatch surfaces a 🛑 cross-account spawn finding.
//   3. per-member idle-with-in-progress-task threshold. Stale = anchor
//      (max(claimedAt, dispatchedAt, <member>-rotated.epoch)) older than
//      `whip.staleMin`-minutes (env override → team config → 90 default).
//   4. per-member Claude Code banner deterministic detection — HARD
//      rate-limit ("hit your limit"), Compacting conversation, queued
//      messages (suppressed when pane is busy). SOFT rate-limit
//      classifier is DEFERRED per ADR-022 (cascade contract pinned in
//      ADR-023; observed-but-not-acted-on this tick).
//   5. lead uptime warning. Reads
//      `~/.claude/teams/<team>/lead-session-start.txt` (I-1 marker, also
//      writeable here when missing so reads never fail). ≥45min warn,
//      ≥leadMaxMin (default 60) recommend rotate. Auto-rotate execute is
//      V-26-deferred per ADR-021; this verb only recommends.
//
// Operational hygiene:
//   - Single-instance flock on `<atmuxDir>/state/whip.lock`. Non-blocking;
//     contention skips the tick (cron will retry next interval).
//   - `<atmuxDir>/state/whip-last.hash` epoch write at end of every tick
//     so a future delta-since-last-tick computation has its anchor (full
//     delta-block content is deferred per ADR-022).
//
// DEFERRED per ADR-022 (durable handles in the ADR — re-enable when):
//   - SOFT rate-limit classifier + LLM-judge cascade (ADR-023 implementation)
//   - brief-version cache + decisions/flags cursors (ADR-041 TS draft)
//   - `_atmux_whip_check_audit` + auto-fix dispatch (TS port of `audit`)
//   - phantom-inbox sweep (V-24 doctor reads only; sweep needs --fix)
//   - `_atmux_whip_check_auto_stop` (Phase-5 super-driver cost-budget policy)
//   - `_atmux_whip_attempt_failover` (Phase-5 super-driver peer lookup)
//   - rename.lock skip (Phase-5 cage rename)
//
// All shellouts go through `tmux.*` and `fs.*` abstractions per ADR-003;
// no raw `Bun.spawn` / `child_process.exec`. The `/proc/<pid>/environ` read
// is a plain `readTextOrNull` (FS abstraction, R6-compliant) so MacOS
// (no /proc) gracefully degrades to "no cross-account check possible".

import { dirname, join } from "node:path";
import { z } from "zod";
import type { BudgetProbeResult } from "../abstractions/budget-probe.ts";
import {
  type DiscordSendOpts,
  send as discordSend,
  renderWhipConfigDrift,
  renderWhipDefunctCwd,
  renderWhipModalCycling,
  renderWhipNeedsApproval,
  renderWhipPermModeDrift,
} from "../abstractions/discord.ts";
import type { CageHandle } from "../abstractions/fallback-cage.ts";
import { appendText, ensureDir, exists, readTextOrNull, writeText } from "../abstractions/fs.ts";
import { tryParseJsonString } from "../abstractions/json.ts";
import { acquire as acquireLock, type LockHandle } from "../abstractions/lock.ts";
import { spawn } from "../abstractions/spawn.ts";
import { createTmux, type SendTarget, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  type AccountSwapCheckCtx,
  type AccountSwapCheckDeps,
  type AccountSwapVerdict,
  type PerMemberSwapDeps,
  runAccountSwapCheck,
  runSwapPass,
} from "../core/account-swap.ts";
import {
  buildWindowName,
  classifyPaneState,
  displayMemberName,
  getAtmuxDir,
  getSessionName,
  logsDir,
  type ResolveDirOpts,
  requireTeam,
  resolveTeamSocket,
  stateDir,
  teamJsonPath,
} from "../core/common.ts";
import { fixCronPollutionRecipe } from "../core/cursor-recipes/fix-cron-pollution.ts";
import { fixSupervisorMissingRecipe } from "../core/cursor-recipes/fix-supervisor-missing.ts";
import { fixTeamJsonSchemaDriftRecipe } from "../core/cursor-recipes/fix-team-json-schema-drift.ts";
import type { CursorRecipe } from "../core/cursor-recipes/types.ts";
import { runSelfHealPass } from "../core/cursor-self-heal.ts";
import { loadInbox } from "../core/inbox.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import { listTasks } from "../core/kanban.ts";
import {
  ensureLeadSessionStart,
  readLeadSessionStart,
  readLeadWindowName,
  type SkillsTeamPathsOpts,
  writeLeadSessionStart,
} from "../core/lead-marker.ts";
import {
  appendHistory,
  classifyPaneAsModal,
  computeModalHash,
  type ModalHistoryEntry,
  shouldFireCycleDetection,
} from "../core/modal-cycling-detector.ts";
import {
  loadDedupState as loadModalCyclingDedupState,
  loadModalHistory,
  recordDedup as recordModalCyclingDedup,
  saveDedupState as saveModalCyclingDedupState,
  saveModalHistory,
  shouldFireDedup as shouldFireModalCyclingDedup,
} from "../core/modal-cycling-state.ts";
import { classifyText } from "../core/pane-state.ts";
import { PASTE_SUBMIT_SETTLE_FLOOR_MS, submitAfterPaste } from "../core/paste-submit.ts";
import {
  loadPermModeDriftState,
  parsePermissionMode,
  recordDrift,
  savePermModeDriftState,
  shouldFireDrift,
} from "../core/perm-mode-drift-state.ts";
import { checkStaleAnchor } from "../core/stale-anchor.ts";
import {
  type BudgetCheckCtx,
  type BudgetCheckDeps,
  type BudgetCheckTeamMember,
  runBudgetCheck,
} from "../core/whip-budget-check.ts";
import {
  composeCatastrophicDrift,
  composeDriftReport,
  type DriftReport,
  makeDriftSafeDefaults,
  recordDriftPing,
  shouldFireDriftPing,
} from "../core/whip-config-drift.ts";
import { advanceDecisionsCursor, checkDecisions } from "../core/whip-decisions-check.ts";
import {
  hashFindingBullets,
  loadWhipFindingState,
  recordFindingFire,
  saveWhipFindingState,
  shouldFireFinding,
  type WhipFindingState,
} from "../core/whip-finding-state.ts";
import { ConfigError, LockTimeoutError, UsageError } from "../errors.ts";
import {
  type NeedsApprovalEntry,
  type NeedsApprovalReport,
  scanNeedsApproval,
} from "../lib/needs-approval.ts";
import { Team, type TeamMember } from "../schema/team.ts";

const USAGE = "atmux whip [--no-discord] [--init-lead-marker] [--heartbeat] [--team-dir <dir>]";

// ---------- Args ----------

export interface WhipArgs {
  pushDiscord: boolean;
  initLeadMarker: boolean;
  /** Force-emit a 💓 [whip-heartbeat] this tick even when findings are
   *  empty AND the team's heartbeat is suppressed. Useful for smoke-
   *  testing the cron line wired into Discord. */
  forceHeartbeat: boolean;
  teamDir?: string;
}

export function parseWhipArgs(argv: ReadonlyArray<string>): WhipArgs {
  let pushDiscord = true;
  let initLeadMarker = false;
  let forceHeartbeat = false;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--no-discord") {
      pushDiscord = false;
      i += 1;
      continue;
    }
    if (a === "--init-lead-marker") {
      initLeadMarker = true;
      i += 1;
      continue;
    }
    if (a === "--heartbeat") {
      forceHeartbeat = true;
      i += 1;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "whip: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `whip: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  const out: WhipArgs = { pushDiscord, initLeadMarker, forceHeartbeat };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Whip config (sub-shape under team.json::whip) ----------

export interface WhipConfig {
  /** Threshold-min for stale-task pings. Default 90 (raised from 30 in
   *  bash E2/S7 — demo-walk tasks legitimately run 60–90 min). */
  staleMin: number;
  /** Lead uptime cutoff in minutes. ≥this → recommend rotate. */
  leadMaxMin: number;
  /** ADR-080 §A1: lead ctx-pct rotation threshold (0–100). When the
   *  lead pane's `tok N/M` indicator parses to a pct ≥ this, the
   *  rotate-recommendation fires even when uptime is below
   *  `leadMaxMin`. Default 70. */
  leadCtxRotateThreshold: number;
  /** Number of consecutive DOWN ticks before reporting (false-alert
   *  dampener). Default 2 per bash E6/S1. */
  downConfirmTicks: number;
  /** When `false`, suppress 💓 [whip-heartbeat] on clean ticks. */
  heartbeat: boolean;
  /** Recommend-only vs auto-execute. V-25 only recommends; auto-rotate
   *  execution is V-26-deferred per ADR-021. Read here so the recommend
   *  text can vary ("recommend `atmux rotate-lead`" vs "auto-rotate
   *  attempted but execute is V-26-deferred"). */
  autoRotate: boolean;
  /** ADR-053 §D2: pause-entry threshold (% used). Default 90 — i.e.,
   *  pause when ANY member is at ≤10% remaining on either window. */
  budgetPauseThreshold: number;
  /** ADR-053 §D2: resume threshold (% used). Default 80 — i.e., resume
   *  when ALL members are at ≥20% remaining on BOTH windows. 10pp
   *  hysteresis vs pause threshold prevents flap. */
  budgetResumeThreshold: number;
  /** ADR-053 §D3 4.1: band-crossing remainders (descending fractions).
   *  Default [0.5, 0.25, 0.15] — fire warnings at 50% / 25% / 15%
   *  remaining per (account, window) cycle. */
  budgetWarningBands: ReadonlyArray<number>;
  /** ADR-053 §D3 4.2: refresh-soon lead-time minutes. Default 30. */
  budgetRefreshLeadMins: number;
  /** ADR-056 §D8: ordered fallback chain. Empty disables account-swap. */
  accountFallback: ReadonlyArray<string>;
  /** ADR-056 §D8: pct-used threshold at which swap fires. Default 75. */
  accountSwapTriggerThreshold: number;
  /** ADR-056 §D8: fallback-health threshold. A fallback is viable when
   *  BOTH h5 + wk pct-used ≤ this. Default 50. */
  accountSwapFallbackHealthThreshold: number;
  /** ADR-056 §"Lead/planner exclusion": roles excluded from swap.
   *  Default lead/planner/reviewer. */
  accountSwapExcludeRoles: ReadonlyArray<string>;
  /** Per-team default account when a member's row has no
   *  `claudeAccount`. Pulled from `team.whip.claudeAccount`. */
  claudeAccount: string;
  /** ADR-055 §D6: gate for the cursor self-heal pass. Default false
   *  — opt-in only, since it spawns a Cursor agent + writes patches. */
  selfHealEnabled: boolean;
  /** ADR-055 §D6: enabled-recipe whitelist. Empty = no recipes run
   *  even when `selfHealEnabled = true` (defensive — explicit opt-in
   *  per recipe id). */
  selfHealRecipes: ReadonlyArray<string>;
  /** ADR-055 §D6: per-recipe token-cap overrides. Optional map; missing
   *  keys fall through to the recipe's own default. */
  selfHealTokenCaps: Readonly<Record<string, number>>;
  /** ADR-085 §Three surfaces #2: needs-approval scan + ping. Default
   *  true. Set false in team.json to skip scan + Discord + JSONL. */
  needsApprovalEnabled: boolean;
}

const DEFAULT_WHIP_CONFIG: WhipConfig = {
  staleMin: 90,
  leadMaxMin: 60,
  leadCtxRotateThreshold: 70,
  downConfirmTicks: 2,
  heartbeat: true,
  autoRotate: false,
  budgetPauseThreshold: 90,
  budgetResumeThreshold: 80,
  budgetWarningBands: [0.5, 0.25, 0.15],
  budgetRefreshLeadMins: 30,
  accountFallback: [],
  accountSwapTriggerThreshold: 75,
  accountSwapFallbackHealthThreshold: 50,
  accountSwapExcludeRoles: ["lead", "planner", "reviewer"],
  claudeAccount: "",
  selfHealEnabled: false,
  selfHealRecipes: [],
  selfHealTokenCaps: {},
  needsApprovalEnabled: true,
};

// ---------- ADR-142 modal-cycling resolved config ----------

/** Resolved {@link Team.modalCycling} with defaults applied. */
export interface ModalCyclingResolved {
  enabled: boolean;
  cycleThreshold: number;
  windowMin: number;
  commitGracePeriodMin: number;
  dedupMin: number;
  exemptMembers: ReadonlySet<string>;
}

/** Default tunables per ADR-142 §Configuration table. */
export const DEFAULT_MODAL_CYCLING: ModalCyclingResolved = {
  enabled: true,
  cycleThreshold: 3,
  windowMin: 30,
  commitGracePeriodMin: 30,
  dedupMin: 30,
  exemptMembers: new Set(),
};

export function resolveModalCycling(team: Team): ModalCyclingResolved {
  const raw = team.modalCycling;
  if (raw === undefined || raw === null) return DEFAULT_MODAL_CYCLING;
  const out: ModalCyclingResolved = {
    enabled: raw.enabled ?? DEFAULT_MODAL_CYCLING.enabled,
    cycleThreshold:
      raw.cycleThreshold !== undefined && raw.cycleThreshold > 0
        ? raw.cycleThreshold
        : DEFAULT_MODAL_CYCLING.cycleThreshold,
    windowMin:
      raw.windowMin !== undefined && raw.windowMin > 0
        ? raw.windowMin
        : DEFAULT_MODAL_CYCLING.windowMin,
    commitGracePeriodMin:
      raw.commitGracePeriodMin !== undefined && raw.commitGracePeriodMin >= 0
        ? raw.commitGracePeriodMin
        : DEFAULT_MODAL_CYCLING.commitGracePeriodMin,
    dedupMin:
      raw.dedupMin !== undefined && raw.dedupMin >= 0
        ? raw.dedupMin
        : DEFAULT_MODAL_CYCLING.dedupMin,
    exemptMembers: new Set(raw.exemptMembers ?? []),
  };
  return out;
}

// ---------- ADR-142 default surface implementations ----------
//
// `makeDefault*` factories return the production-default DI seam used by
// runWhip when callers don't inject. Tests inject recorders directly via
// the `WhipOpts.*` fields; the factories themselves stay simple +
// best-effort (failure swallowed; tick continues).

interface CommitCountFactoryArgs {
  atmuxDir: string;
}

function makeDefaultCommitCount(
  args: CommitCountFactoryArgs,
): (member: TeamMember, windowMin: number) => Promise<number> {
  return async (member: TeamMember, windowMin: number): Promise<number> => {
    // Member worktree: explicit `member.cwd` if set; otherwise the
    // project root that contains `.atmux/` (mirrors gitter's auto-done
    // scan default).
    const repoPath = member.cwd ?? dirname(args.atmuxDir);
    try {
      const { spawn } = await import("../abstractions/spawn.ts");
      const result = await spawn({
        cmd: "git",
        argv: ["-C", repoPath, "log", `--since=${windowMin}.minutes`, "--pretty=format:%h"],
        timeoutMs: 5_000,
        expectExitCode: "any",
      });
      if (result.exitCode !== 0) return 0;
      const lines = result.stdout.split("\n").filter((l) => l.trim().length > 0);
      return lines.length;
    } catch {
      // git missing / wrong cwd / spawn timeout — treat as 0 commits;
      // detector falls through to fire-on-cycle if threshold met.
      return 0;
    }
  };
}

interface ModalCyclingClarifierArgs {
  team: Team;
  atmuxDir: string;
  tmux: TmuxNamespace;
  nowSec: number;
}

function makeDefaultModalCyclingClarifier(
  args: ModalCyclingClarifierArgs,
): (member: string, message: string) => Promise<void> {
  return async (member: string, message: string): Promise<void> => {
    const session = await getSessionName({ dir: args.atmuxDir, team: args.team });
    const memberEntry = args.team.members.find((m) => m.name === member);
    const windowName = `${memberEntry?.emoji ?? ""}${member}`;
    const target = `${session}:${windowName}`;
    const bufferName = `atmux-modal-cycling-${args.team.name}-${member}-${args.nowSec}`;
    try {
      await args.tmux.buffer.loadBuffer({ name: bufferName, data: message });
      const sendTarget: SendTarget = {
        kind: "member",
        member,
        team: args.team.name,
        target,
      };
      await args.tmux.buffer.pasteBuffer({
        name: bufferName,
        target: sendTarget,
        deleteAfter: true,
      });
      await submitAfterPaste(args.tmux, sendTarget);
    } catch {
      // Clarifier is best-effort — pane may be MODAL-busy or window
      // missing; the flag + Discord surfaces still go out.
    }
  };
}

interface ModalCyclingFlagFilerArgs {
  atmuxDir: string;
}

function makeDefaultModalCyclingFlagFiler(
  args: ModalCyclingFlagFilerArgs,
): (subject: string, body: string) => Promise<void> {
  return async (subject: string, body: string): Promise<void> => {
    try {
      const { spawn } = await import("../abstractions/spawn.ts");
      await spawn({
        cmd: "atmux",
        argv: ["flags", "add", subject, "--body", body, "--severity", "high"],
        cwd: args.atmuxDir,
        timeoutMs: 5_000,
        expectExitCode: "any",
      });
    } catch {
      // Flag filing is best-effort — Discord ping still goes out.
    }
  };
}

/** Pick a sub-field out of `team.whip` (typed as `unknown` — see
 *  src/schema/team.ts comment) coercing through the env override
 *  ladder. Bash mirror: `lib/whip.sh:71-81`. `env` defaults to
 *  `process.env`; tests inject. */
export function readWhipConfig(team: Team, env: NodeJS.ProcessEnv = process.env): WhipConfig {
  const raw = team.whip;
  const cfg: WhipConfig = { ...DEFAULT_WHIP_CONFIG };
  if (raw !== null && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (typeof o.staleMin === "number" && Number.isFinite(o.staleMin) && o.staleMin > 0) {
      cfg.staleMin = o.staleMin;
    }
    if (typeof o.leadMaxMin === "number" && Number.isFinite(o.leadMaxMin) && o.leadMaxMin > 0) {
      cfg.leadMaxMin = o.leadMaxMin;
    }
    if (
      typeof o.leadCtxRotateThreshold === "number" &&
      Number.isFinite(o.leadCtxRotateThreshold) &&
      o.leadCtxRotateThreshold >= 0 &&
      o.leadCtxRotateThreshold <= 100
    ) {
      cfg.leadCtxRotateThreshold = o.leadCtxRotateThreshold;
    }
    if (
      typeof o.downConfirmTicks === "number" &&
      Number.isFinite(o.downConfirmTicks) &&
      o.downConfirmTicks > 0
    ) {
      cfg.downConfirmTicks = Math.floor(o.downConfirmTicks);
    }
    if (typeof o.heartbeat === "boolean") cfg.heartbeat = o.heartbeat;
    if (typeof o.autoRotate === "boolean") cfg.autoRotate = o.autoRotate;
    // ADR-053 §D2 + §D3 budget knobs (T3 TeamWhip schema is the canonical
    // source; reads here are runtime-defensive for the unschemed `unknown`
    // field shape).
    if (
      typeof o.budgetPauseThreshold === "number" &&
      Number.isFinite(o.budgetPauseThreshold) &&
      o.budgetPauseThreshold >= 0 &&
      o.budgetPauseThreshold <= 100
    ) {
      cfg.budgetPauseThreshold = o.budgetPauseThreshold;
    }
    if (
      typeof o.budgetResumeThreshold === "number" &&
      Number.isFinite(o.budgetResumeThreshold) &&
      o.budgetResumeThreshold >= 0 &&
      o.budgetResumeThreshold <= 100
    ) {
      cfg.budgetResumeThreshold = o.budgetResumeThreshold;
    }
    if (Array.isArray(o.budgetWarningBands)) {
      const bands = o.budgetWarningBands.filter(
        (b): b is number => typeof b === "number" && Number.isFinite(b) && b >= 0 && b <= 1,
      );
      if (bands.length > 0) cfg.budgetWarningBands = bands;
    }
    if (
      typeof o.budgetRefreshLeadMins === "number" &&
      Number.isFinite(o.budgetRefreshLeadMins) &&
      o.budgetRefreshLeadMins >= 0
    ) {
      cfg.budgetRefreshLeadMins = Math.floor(o.budgetRefreshLeadMins);
    }
    // ADR-056 account-swap knobs.
    if (Array.isArray(o.accountFallback)) {
      const chain = o.accountFallback.filter(
        (s): s is string => typeof s === "string" && s.length > 0,
      );
      cfg.accountFallback = chain;
    }
    if (
      typeof o.accountSwapTriggerThreshold === "number" &&
      Number.isFinite(o.accountSwapTriggerThreshold) &&
      o.accountSwapTriggerThreshold >= 0 &&
      o.accountSwapTriggerThreshold <= 100
    ) {
      cfg.accountSwapTriggerThreshold = o.accountSwapTriggerThreshold;
    }
    if (
      typeof o.accountSwapFallbackHealthThreshold === "number" &&
      Number.isFinite(o.accountSwapFallbackHealthThreshold) &&
      o.accountSwapFallbackHealthThreshold >= 0 &&
      o.accountSwapFallbackHealthThreshold <= 100
    ) {
      cfg.accountSwapFallbackHealthThreshold = o.accountSwapFallbackHealthThreshold;
    }
    if (Array.isArray(o.accountSwapExcludeRoles)) {
      const roles = o.accountSwapExcludeRoles.filter(
        (s): s is string => typeof s === "string" && s.length > 0,
      );
      cfg.accountSwapExcludeRoles = roles;
    }
    if (typeof o.claudeAccount === "string") cfg.claudeAccount = o.claudeAccount;
    // ADR-055 self-heal knobs.
    if (typeof o.selfHealEnabled === "boolean") cfg.selfHealEnabled = o.selfHealEnabled;
    if (Array.isArray(o.selfHealRecipes)) {
      cfg.selfHealRecipes = o.selfHealRecipes.filter(
        (s): s is string => typeof s === "string" && s.length > 0,
      );
    }
    if (
      o.selfHealTokenCaps !== null &&
      typeof o.selfHealTokenCaps === "object" &&
      !Array.isArray(o.selfHealTokenCaps)
    ) {
      const caps: Record<string, number> = {};
      for (const [k, v] of Object.entries(o.selfHealTokenCaps as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0) caps[k] = v;
      }
      cfg.selfHealTokenCaps = caps;
    }
    // ADR-085 needs-approval opt-out — explicit `false` only; missing
    // OR `true` keeps the default-true.
    if (typeof o.needsApprovalEnabled === "boolean") {
      cfg.needsApprovalEnabled = o.needsApprovalEnabled;
    }
  }
  // Env override ladder. ATMUX_STALE_MIN + ATMUX_LEAD_MAX_MIN are bash
  // parity (`lib/whip.sh:74-75`). Negative / non-finite values fall
  // through to the team-config / default value (already in cfg).
  const staleEnv = parsePositiveInt(env.ATMUX_STALE_MIN);
  if (staleEnv !== null) cfg.staleMin = staleEnv;
  const leadEnv = parsePositiveInt(env.ATMUX_LEAD_MAX_MIN);
  if (leadEnv !== null) cfg.leadMaxMin = leadEnv;
  return cfg;
}

function parsePositiveInt(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// ---------- Session-state 2-tick gate ----------

/** Schema for `<atmuxDir>/state/whip-session-state.json`. Inline rather
 *  than promoted to `src/schema/` because the file is whip-private state
 *  (no other verb reads or writes it). R3 still applies: this is the
 *  one schema gate for the file, not a hand-rolled `JSON.parse` guard. */
const SessionStateSchema = z.object({
  lastDown: z
    .object({
      epoch: z.number(),
      count: z.number(),
    })
    .optional(),
});

export type SessionState = z.infer<typeof SessionStateSchema>;

export type SessionVerdict = "up" | "report" | "suppress";

export interface ClassifyResult {
  verdict: SessionVerdict;
  next: SessionState;
}

/**
 * Pure classifier for the 2-tick session-DOWN gate (mirrors bash
 * `_atmux_whip_session_state_check`). State machine:
 *
 *   prev.lastDown.count + sessionUp     → `up`,       wipe lastDown
 *   prev.lastDown.count + sessionDOWN   → bump count + epoch; if count
 *                                         ≥ threshold → `report`, else
 *                                         `suppress`
 *
 * `nowSec` is the current epoch in seconds (caller's clock). Threshold
 * defaults to 2 — single-tick check would have produced N false alerts
 * during the 2026-04-25 incident, two-tick gate produced 0.
 */
export function classifySessionState(
  prev: SessionState,
  sessionUp: boolean,
  threshold: number,
  nowSec: number,
): ClassifyResult {
  if (sessionUp) {
    return { verdict: "up", next: {} };
  }
  const prevCount = prev.lastDown?.count ?? 0;
  const count = prevCount + 1;
  const next: SessionState = { lastDown: { epoch: nowSec, count } };
  if (count >= threshold) {
    return { verdict: "report", next };
  }
  return { verdict: "suppress", next };
}

const SESSION_STATE_FILE = "whip-session-state.json";

async function readSessionState(atmuxDir: string): Promise<SessionState> {
  const path = join(stateDir(atmuxDir), SESSION_STATE_FILE);
  const text = await readTextOrNull(path);
  if (text === null) return {};
  // `tryParseJsonString` (NOT `tryReadJson`) — the latter throws
  // SchemaError on existing-but-invalid; we want bash-parity "treat
  // corrupt-or-fresh both as empty" semantics (mirrors bash
  // `[[ -s "$sf" ]] || echo '{}' > "$sf"` at lib/whip.sh:1036). R3 is
  // honoured by going through the json.ts abstraction either way.
  return tryParseJsonString(text, SessionStateSchema) ?? {};
}

async function writeSessionState(atmuxDir: string, state: SessionState): Promise<void> {
  const path = join(stateDir(atmuxDir), SESSION_STATE_FILE);
  await writeText(path, `${JSON.stringify(state)}\n`);
}

// ---------- Stale-task selection ----------

/**
 * Compute the staleness anchor for an inProgress entry:
 *
 *   anchor = max(claimedAt ?? dispatchedAt ?? 0, rotatedSec)
 *
 * Bash mirror: the inline jq filter at `lib/whip.sh:283-285` — a recent
 * `<member>-rotated.epoch` lifts the anchor so tasks claimed pre-rotate
 * don't re-trigger a stale ping the moment the member resumes.
 */
export function staleAnchor(
  claimedAt: number | null | undefined,
  dispatchedAt: number | null | undefined,
  rotatedSec: number,
): number {
  const base =
    (claimedAt ?? null) !== null
      ? (claimedAt as number)
      : (dispatchedAt ?? null) !== null
        ? (dispatchedAt as number)
        : 0;
  return base > rotatedSec ? base : rotatedSec;
}

export interface StaleEntry {
  /** Task id; surfaced in the finding text. */
  id: string;
  /** Effective anchor (epoch sec). */
  anchor: number;
  /** Effective threshold (sec) — `(staleMin // defaultMin) * 60`. */
  thresholdSec: number;
}

export function selectStaleTasks(
  inProgress: ReadonlyArray<{
    id: string;
    claimedAt?: number | null | undefined;
    dispatchedAt?: number | null | undefined;
    staleMin?: number | null | undefined;
  }>,
  nowSec: number,
  defaultStaleMin: number,
  rotatedSec: number,
): StaleEntry[] {
  const out: StaleEntry[] = [];
  for (const t of inProgress) {
    const anchor = staleAnchor(t.claimedAt ?? null, t.dispatchedAt ?? null, rotatedSec);
    const min = typeof t.staleMin === "number" && t.staleMin > 0 ? t.staleMin : defaultStaleMin;
    const thresholdSec = min * 60;
    if (anchor + thresholdSec < nowSec) {
      out.push({ id: t.id, anchor, thresholdSec });
    }
  }
  return out;
}

// ---------- Cross-account drift (ADR-024) ----------

/**
 * Tag a CLAUDE_CONFIG_DIR path. `null` = env var absent in the proc env
 * (no spawn-time wrapper detected). Bash equivalent: the case statement
 * in ADR-024 §Detection.
 */
export type AccountTag = "unum" | "icloud" | "default" | "unknown";

export function accountFromConfigDir(path: string | null | undefined): AccountTag | null {
  if (path === null || path === undefined || path === "") return null;
  if (path.includes(".claude-unum")) return "unum";
  if (path.includes(".claude-icloud")) return "icloud";
  if (path.includes(".claude")) return "default";
  return "unknown";
}

/** Parse the NUL-separated key=value text from `/proc/<pid>/environ`.
 *  Trailing NUL is tolerated. Returns the first occurrence per key (env
 *  shouldn't have dupes; if it does, first-wins matches `getenv(3)`). */
export function parseEnviron(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Strip a single trailing NUL byte (common from /proc reads) before
  // splitting so we don't end up with an empty final token.
  const trimmed = text.endsWith("\0") ? text.slice(0, -1) : text;
  if (trimmed.length === 0) return out;
  for (const tok of trimmed.split("\0")) {
    if (tok.length === 0) continue;
    const eq = tok.indexOf("=");
    if (eq <= 0) continue; // leading-`=` or no-`=` → skip
    const k = tok.slice(0, eq);
    if (!(k in out)) out[k] = tok.slice(eq + 1);
  }
  return out;
}

export type ReadMemberEnv = (pid: number) => Promise<Record<string, string> | null>;

const defaultReadMemberEnv: ReadMemberEnv = async (pid) => {
  // /proc is Linux-only. On MacOS / non-Linux this returns null and the
  // cross-account check skips silently — bash side has no equivalent
  // detector either, so degraded-skip is parity-safe.
  const text = await readTextOrNull(`/proc/${pid}/environ`);
  if (text === null) return null;
  return parseEnviron(text);
};

// ---------- I-1 + I-2 markers ----------
//
// Definitions live in `src/core/lead-marker.ts` so non-`whip` verbs
// (e.g. `pane-state`, ADR-062 §Decision (2)) can read the lead window
// name without crossing the verbs/* import boundary. Re-exported here so
// existing callers (whip.test.ts + downstream verbs that historically
// imported from whip.ts) keep working unchanged.

export {
  ensureLeadSessionStart,
  leadSessionStartPath,
  leadWindowNamePath,
  readLeadSessionStart,
  readLeadWindowName,
  type SkillsTeamPathsOpts,
  writeLeadSessionStart,
} from "../core/lead-marker.ts";

// ---------- Findings ----------

export interface Finding {
  /** Tag for category routing in the Discord push step. */
  category: "blocker" | "overdue" | "informational";
  /** Bullet text — must satisfy ADR-008 ≤80 graphemes + emoji prefix. */
  bullet: string;
  /** ADR-057 §D4a: optional perm-mode-drift payload. When present, the
   *  tick aggregates these per-member findings into a single
   *  [whip-perm-mode-drift] Discord ping (24h per-member dedup). */
  permModeDrift?: { member: string; mode: string };
  /** ADR-057 §D4c: optional defunct-cwd payload. When present, the
   *  tick aggregates these per-member findings into a single
   *  [whip-defunct-cwd] Discord ping (no dedup — fires every tick
   *  until the operator restores the path). */
  defunctCwd?: { member: string; cwd: string };
  /** ADR-142 §D4-D5: optional modal-cycling payload. When present, the
   *  tick fires `[whip-modal-cycling]` Discord (per-member dedup via
   *  modalCycling.dedupMin) PLUS best-effort `atmux send` clarifier +
   *  `atmux flags add` flag. Surface dispatch happens at tick-aggregate
   *  time so the dedup state writes once even when a single tick fires
   *  for multiple members. */
  modalCycling?: {
    member: string;
    taskId: string;
    distinctCount: number;
    modalsSeen: ReadonlyArray<ModalHistoryEntry>;
  };
}

// ---------- Public entrypoint ----------

export interface WhipOpts {
  stdout?: Writer;
  stderr?: Writer;
  /** Clock — defaults to `Date.now`. */
  now?: () => number;
  /** Pre-built tmux namespace. Defaults to `createTmux({ socketPath })`
   *  using the cage path for the team (`/tmp/atmux-<team>/sock`). Tests
   *  inject a fake. */
  tmux?: TmuxNamespace;
  /** Discord sender override. Defaults to `discord.send`. Errors caught
   *  + warned, not re-thrown — same posture as report.ts. */
  discordSend?: (opts: DiscordSendOpts) => Promise<void>;
  /** Override the resolved webhook URL (forwarded to discord.send). */
  webhookOverride?: string;
  /** Process env reference for whip-config + driver-account derivation.
   *  Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Per-member env reader for the ADR-024 cross-account check. Defaults
   *  to reading `/proc/<pid>/environ` (Linux-only; non-Linux degrades). */
  readMemberEnv?: ReadMemberEnv;
  /** Override `~` for the I-1 / I-2 marker paths. */
  home?: string;
  /** Lock acquirer override (test injection). Defaults to
   *  `lock.acquire`. Tests use this to drive both the LockTimeoutError
   *  skip-tick path and the rethrow-other-errors branch without
   *  needing concurrent OS-level flock contention. */
  lockAcquire?: (path: string) => Promise<LockHandle>;
  /** Per-tick budget orchestrator override (ADR-053 §D2). Default
   *  delegates to `core/whip-budget-check.ts::runBudgetCheck` with
   *  production probe + pause/resume + Discord wiring. Tests inject
   *  to drive the pause/resume verdict surface deterministically. */
  budgetProbe?: (
    account: string,
    opts?: { force?: boolean; refreshOnNearExpiry?: boolean },
  ) => Promise<BudgetProbeResult>;
  /** ADR-142 DI seam — commit-count cross-check for modal-cycling. */
  commitCountInWindow?: (member: TeamMember, windowMin: number) => Promise<number>;
  /** ADR-142 DI seam — clarifier dispatch surface. */
  dispatchModalCyclingClarifier?: (member: string, message: string) => Promise<void>;
  /** ADR-142 DI seam — flag-add surface. */
  fileModalCyclingFlag?: (subject: string, body: string) => Promise<void>;
}

/** `atmux whip [--no-discord] [--init-lead-marker] [--heartbeat] [--team-dir <dir>]`. */
export async function whip(argv: ReadonlyArray<string>, opts: WhipOpts = {}): Promise<number> {
  const parsed = parseWhipArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);

  const stdout = opts.stdout ?? defaultStdoutWrite;
  const stderr = opts.stderr ?? defaultStderrWrite;
  const clock = opts.now ?? Date.now;
  const env = opts.env ?? process.env;
  const home = opts.home;
  const send = opts.discordSend ?? discordSend;
  const readMemberEnv = opts.readMemberEnv ?? defaultReadMemberEnv;

  const nowMs = clock();
  const nowSec = Math.floor(nowMs / 1000);

  // ADR-054 §D2 — per-tick team.json validation with safe-defaults
  // fallback. On schema/JSON failure we fire a [whip-config-drift]
  // Discord ping (dedup'd via hash + 24h re-fire window) and
  // continue the tick with a parseable shape rather than crashing.
  // requireTeam used to be the team load; it stays as the absent-file
  // gate (the absent-file ConfigError is a hard refusal, not a drift).
  const { team, driftReport } = await loadTeamWithDrift(atmuxDir, dirOpts);
  if (driftReport !== null && parsed.pushDiscord) {
    await maybeFireDriftPing(atmuxDir, team.name, driftReport, send, nowSec, nowMs);
  }

  // I-1 init mode short-circuit. Cron / setup invokes
  // `atmux whip --init-lead-marker` once on lead-spawn or rotate-lead so
  // the next regular whip tick reads a real epoch.
  if (parsed.initLeadMarker) {
    const writeOpts = home !== undefined ? { home } : {};
    await writeLeadSessionStart(team.name, nowSec, writeOpts);
    stdout(`whip: lead marker written for ${team.name} @ ${nowSec}\n`);
    return 0;
  }

  // Single-instance flock — non-blocking. Contention skips the tick
  // entirely; cron's next interval retries.
  const lockBase = join(stateDir(atmuxDir), "whip");
  await ensureDir(stateDir(atmuxDir));
  const lockFn =
    opts.lockAcquire ?? ((p: string) => acquireLock(p, { timeoutMs: 50, retryDelayMs: 25 }));
  let handle: LockHandle;
  try {
    handle = await lockFn(lockBase);
  } catch (e) {
    if (e instanceof LockTimeoutError) {
      stderr("whip: another instance is running — skipping this tick\n");
      return 0;
    }
    throw e;
  }

  const modalCyclingConfig = resolveModalCycling(team);
  const tmuxNs = opts.tmux ?? createTmux({ socketPath: resolveTeamSocket(team) });
  const defaultCommitCount = makeDefaultCommitCount({ atmuxDir });
  const defaultClarifier = makeDefaultModalCyclingClarifier({
    team,
    atmuxDir,
    tmux: tmuxNs,
    nowSec,
  });
  const defaultFlagFiler = makeDefaultModalCyclingFlagFiler({ atmuxDir });
  try {
    return await runTick(parsed, {
      team,
      atmuxDir,
      stdout,
      stderr,
      nowMs,
      nowSec,
      env,
      ...(home !== undefined ? { home } : {}),
      send,
      readMemberEnv,
      ...(opts.webhookOverride !== undefined ? { webhookOverride: opts.webhookOverride } : {}),
      tmux: tmuxNs,
      ...(opts.budgetProbe !== undefined ? { budgetProbe: opts.budgetProbe } : {}),
      modalCyclingConfig,
      commitCountInWindow: opts.commitCountInWindow ?? defaultCommitCount,
      dispatchModalCyclingClarifier:
        opts.dispatchModalCyclingClarifier ?? defaultClarifier,
      fileModalCyclingFlag: opts.fileModalCyclingFlag ?? defaultFlagFiler,
    });
  } finally {
    await handle.release();
  }
}

interface TickCtx {
  team: Team;
  atmuxDir: string;
  stdout: Writer;
  stderr: Writer;
  nowMs: number;
  nowSec: number;
  env: NodeJS.ProcessEnv;
  home?: string;
  tmux: TmuxNamespace;
  send: (opts: DiscordSendOpts) => Promise<void>;
  webhookOverride?: string;
  readMemberEnv: ReadMemberEnv;
  budgetProbe?: (
    account: string,
    opts?: { force?: boolean; refreshOnNearExpiry?: boolean },
  ) => Promise<BudgetProbeResult>;
  /** ADR-142 resolved config — defaults applied at the runWhip seam. */
  modalCyclingConfig: ModalCyclingResolved;
  /** ADR-142 §D3: commit-count cross-check. Returns the number of
   *  commits attributed to `member` within `windowMin` on the member's
   *  worktree (or shared tree, when worktree-isolation is off). Used
   *  to gate cycle-fire on productive ceremony. DI-seam: tests inject
   *  a stub; default implementation shells `git log --since=…min`. */
  commitCountInWindow?: (member: TeamMember, windowMin: number) => Promise<number>;
  /** ADR-142 §D5: clarifier dispatch — `atmux send <member> "[detector]
   *  …"`. Best-effort; failure swallowed (dedup state still records the
   *  fire so the surface action isn't retried until next dedup window).
   *  DI-seam: tests inject a recorder. */
  dispatchModalCyclingClarifier?: (member: string, message: string) => Promise<void>;
  /** ADR-142 §D5: flag-add — `atmux flags add <subject> --body <body>
   *  --severity high`. Best-effort; failure swallowed. DI-seam: tests
   *  inject a recorder. */
  fileModalCyclingFlag?: (subject: string, body: string) => Promise<void>;
}

async function runTick(parsed: WhipArgs, ctx: TickCtx): Promise<number> {
  const { team, atmuxDir, env, stdout, nowSec } = ctx;
  const config = readWhipConfig(team, env);
  const session = await getSessionName({ dir: atmuxDir, team });
  const homeOpts: SkillsTeamPathsOpts = ctx.home !== undefined ? { home: ctx.home } : {};

  // I-1 first-tick auto-init — keeps Check 5 reads from failing on a
  // fresh team. Only writes if absent.
  await ensureLeadSessionStart(team.name, nowSec, homeOpts);

  const findings: Finding[] = [];

  // ---------- Check 0: decisions watcher (SPEC-063, ADR-008 §S8 D13) ----------
  // Runs FIRST so the finding rides every emit path (session-up,
  // account-swap, session-down report) — bash semantics: decisions.md
  // is independent of session liveness (lib/whip.sh:86,91). The
  // cursor advance is deferred to `advancePendingDecisionsCursor`
  // which fires after each emit (fire-and-warn ordering matches bash
  // lib/whip.sh:437-448). Early-returns that skip emit (suppress,
  // budget-pause) also skip the cursor advance, so the finding
  // re-fires next tick — correct, since no ping went out.
  //
  // Inline-preview path (bash lib/whip.sh:404-427) requires the bun
  // `atmux decisions list --since --json` verb which isn't ported
  // yet; the watcher falls back to the flag-only pointer per the
  // module docstring.
  let decisionsNewCursor: number | null = null;
  try {
    const decisionsVerdict = await checkDecisions({ atmuxDir });
    if (decisionsVerdict.fire && decisionsVerdict.bullet !== null) {
      findings.push({ category: "informational", bullet: decisionsVerdict.bullet });
      decisionsNewCursor = decisionsVerdict.newCursor;
    }
  } catch (e) {
    ctx.stderr(`whip: decisions check failed: ${String(e)}\n`);
  }
  const advancePendingDecisionsCursor = async (): Promise<void> => {
    if (decisionsNewCursor === null) return;
    try {
      await advanceDecisionsCursor(atmuxDir, decisionsNewCursor);
    } catch (e) {
      ctx.stderr(`whip: decisions cursor advance failed: ${String(e)}\n`);
    }
  };

  // ---------- Check 1: session liveness with 2-tick gate ----------
  const prevState = await readSessionState(atmuxDir);
  const sessionUp = await ctx.tmux.session.hasSession(session);
  const { verdict, next } = classifySessionState(
    prevState,
    sessionUp,
    config.downConfirmTicks,
    nowSec,
  );
  await writeSessionState(atmuxDir, next);

  if (verdict === "suppress") {
    const count = next.lastDown?.count ?? 0;
    stdout(
      `whip: session DOWN (tick ${count}/${config.downConfirmTicks}) — suppressing pending confirmation\n`,
    );
    await writeLastHash(atmuxDir, nowSec);
    return 0;
  }

  if (verdict === "report") {
    findings.push({
      category: "blocker",
      bullet: `🛑 session ${session} is DOWN`,
    });
  } else {
    // ADR-056 §D2: account-swap fires BEFORE budget-pause. At
    // `accountSwapTriggerThreshold` (default 75% used) AND a viable
    // fallback exists → enter swap pass to preempt the 90%-pause.
    // T11 owns the per-member workflow (spawn shadow, handoff, pause
    // original). T10 just arms the state-file + decisions[]; an
    // active pass means we skip budget-pause-fire for THIS tick (the
    // swap is preempting it). All other verdicts fall through to the
    // budget check below.
    const swapVerdict = await runAccountSwapTickCheck(ctx, config);
    if (swapVerdict === "active-pass" || swapVerdict === "pass-entered") {
      // T11 §D3: advance the active pass by ONE decision per tick
      // (sequential, one-at-a-time per ADR-056). T10 entered the pass;
      // T11's runSwapPass walks pending decisions, calling per-member
      // workflow + persisting decision flips + firing pass-complete on
      // the last decision.
      try {
        await runSwapPassTickCheck(ctx, config);
      } catch (e) {
        ctx.stderr(`whip: account-swap pass advancement failed: ${String(e)}\n`);
      }
      stdout(`whip: account-swap ${swapVerdict} — skipping budget-pause for this tick\n`);
      // Per-member checks still run (lead uptime, idle, banners) — the
      // swap is per-account, not per-team. Skip only the budget gate.
      for (const member of team.members) {
        await checkMember(ctx, member, config, findings);
      }
      const leadUptimeFinding = await checkLeadUptime(ctx, config, homeOpts);
      if (leadUptimeFinding !== null) findings.push(leadUptimeFinding);
      await emitFindings(parsed, ctx, config, findings);
      await advancePendingDecisionsCursor();
      await writeLastHash(atmuxDir, nowSec);
      return 0;
    }

    // ADR-053 §D2: per-tick budget orchestration runs BEFORE per-member
    // checks. Budget-pause supersedes ADR-052 Mode B + auto-stop at the
    // tick level — early-return on `paused-just-now` / `paused-still`
    // so neither the per-member loop nor any future kanban-empty check
    // fires while the team is in a deliberate budget hold.
    const budgetVerdict = await runBudgetTickCheck(ctx, config);
    if (budgetVerdict === "paused-just-now" || budgetVerdict === "paused-still") {
      stdout(`whip: budget ${budgetVerdict} — skipping per-member checks\n`);
      await writeLastHash(atmuxDir, nowSec);
      return 0;
    }

    // session UP — run per-member checks.
    for (const member of team.members) {
      await checkMember(ctx, member, config, findings);
    }

    // ---------- Check 5: lead uptime ----------
    const leadUptimeFinding = await checkLeadUptime(ctx, config, homeOpts);
    if (leadUptimeFinding !== null) findings.push(leadUptimeFinding);

    // ---------- Check 6: stale-anchor (ADR-057 §D2d) ----------
    // Lead's driver-inbox cursor >2h behind file mtime AND new entries
    // exist → fire single ping per stale window (dedup by tip-line hash).
    try {
      const staleVerdict = await checkStaleAnchor({ atmuxDir, nowEpochSec: nowSec });
      if (staleVerdict.fire && staleVerdict.bullet !== null) {
        findings.push({ category: "overdue", bullet: staleVerdict.bullet });
      }
    } catch (e) {
      // Best-effort — a stale-anchor read failure must never block the
      // tick; downgrade to a stderr line.
      ctx.stderr(`whip: stale-anchor check failed: ${String(e)}\n`);
    }

    // ---------- §2.5 ADR-085: needs-approval scan ----------
    // Per ADR-085 §Three surfaces #2 — three buckets of paperwork debt
    // (proposed ADRs / untriaged driver-inbox / long-blocked kanban).
    // Live read, no cache, per ADR-068 §HC#4. Each tick:
    //   1. scanNeedsApproval() — three concurrent bucket reads.
    //   2. Append lead-events JSONL row regardless of total — zero-state
    //      is observable, future dashboards can spot the "fell silent"
    //      pattern.
    //   3. If total > 0: fire ONE Discord ping via the named template
    //      `whip-needs-approval`. Skip entirely on total === 0 (no
    //      ✅-all spam).
    // Gated on `team.json::whip.needsApprovalEnabled` (default true);
    // false skips scan + ping + JSONL outright. Best-effort: a scan
    // exception is logged + the tick continues.
    if (config.needsApprovalEnabled && parsed.pushDiscord) {
      try {
        await runNeedsApprovalCheck(ctx);
      } catch (e) {
        ctx.stderr(`whip: needs-approval scan failed: ${String(e)}\n`);
      }
    }

    // ---------- Check 7: cursor self-heal pass (ADR-055 §D2) ----------
    // Runs AFTER per-member + lead-uptime + stale-anchor (per ADR-055
    // §D2 "after the main per-member checks"). Already gated above
    // against budget-pause (the early-return path skipped this entire
    // arm). Opt-in via `team.json::whip.selfHealEnabled`; skipped
    // silently when disabled OR when no recipes are whitelisted.
    if (config.selfHealEnabled && config.selfHealRecipes.length > 0) {
      try {
        await runSelfHealPass({
          atmuxDir,
          projectCwd: process.cwd(),
          nowSec,
          teamName: team.name,
          ...(session !== "" ? { sessionName: session } : {}),
          reviewerName: resolveReviewerName(team),
          recipes: SELF_HEAL_RECIPES,
          enabledRecipeIds: config.selfHealRecipes,
          tokenCapOverrides: config.selfHealTokenCaps,
          send: ctx.send,
          log: (msg) => ctx.stderr(`whip: ${msg}\n`),
        });
      } catch (e) {
        // Defensive — runSelfHealPass's contract says it never throws,
        // but a runtime bug shouldn't block emitFindings + the rest of
        // the tick. Log + continue.
        ctx.stderr(`whip: self-heal pass failed: ${String(e)}\n`);
      }
    }
  }

  await emitFindings(parsed, ctx, config, findings);
  await advancePendingDecisionsCursor();
  await writeLastHash(atmuxDir, nowSec);
  return 0;
}

// ---------- §2.5 ADR-085: needs-approval scan helper ----------

/**
 * One tick's worth of needs-approval work: scan + JSONL append +
 * conditional Discord ping. Lifted out of `runTick` for readability;
 * the call site is gated on `config.needsApprovalEnabled` AND
 * `parsed.pushDiscord` (the latter so `--no-discord` skips the ping
 * but still appends JSONL — observability stays on even when ops
 * silences the wire).
 *
 * Per ADR-085 §Stale-threshold rationale + OQ2:
 * - Discord fires ONLY when `report.total > 0`.
 * - Lead-events JSONL row appends EVERY tick (kind:
 *   `needs-approval-snapshot`) so future dashboards spot the
 *   "fell silent" pattern.
 * - The renderer's 5-per-bucket hard-cap + "+N more" tail caps body
 *   size regardless of corpus size — operator shells in via
 *   `atmux status --json | jq .needsApproval` for the full list.
 */
async function runNeedsApprovalCheck(ctx: TickCtx): Promise<void> {
  const report = await scanNeedsApproval();
  // Append regardless of total — zero-state is observable. JSONL write
  // failures degrade silently; observability surfaces are best-effort.
  await safeAppendLeadEvent(
    ctx.atmuxDir,
    ctx.nowSec,
    {
      kind: "needs-approval-snapshot",
      report,
    },
    ctx.stderr,
  );
  if (report.total === 0) return;
  // Build renderer entries — strip `bucket` + `path` (the renderer only
  // needs id/subject/ageMin per its WhipNeedsApprovalOpts shape; the
  // full report lives in the JSONL row above for click-through).
  const sendOpts = renderWhipNeedsApproval({
    team: ctx.team.name,
    adr: toRendererEntries(report.adr),
    inbox: toRendererEntries(report.inbox),
    kanban: toRendererEntries(report.kanban),
    whenMs: ctx.nowMs,
  });
  await ctx.send(sendOpts);
}

function toRendererEntries(
  rows: ReadonlyArray<NeedsApprovalEntry>,
): ReadonlyArray<{ id: string; subject: string; ageMin: number }> {
  return rows.map((r) => ({ id: r.id, subject: r.subject, ageMin: r.ageMin }));
}

/** Append one JSONL row to `<atmuxDir>/logs/lead-events.jsonl`. New file
 *  (not bucketed by month — ADR-085 §Three surfaces #3 doesn't specify
 *  bucketing; a follow-up ADR can introduce monthly rotation if size
 *  becomes a concern). Schema: `{ts, kind, ...extra}` — flat, forward-
 *  compatible. Failures are non-fatal (best-effort observability). */
async function safeAppendLeadEvent(
  atmuxDir: string,
  tsEpochSec: number,
  extra: Record<string, unknown>,
  stderr: Writer,
): Promise<void> {
  try {
    const path = join(logsDir(atmuxDir), "lead-events.jsonl");
    const row = { ts: tsEpochSec, ...extra };
    await appendText(path, `${JSON.stringify(row)}\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    stderr(`whip: lead-events: append skipped (best-effort): ${msg}\n`);
  }
}

// `NeedsApprovalReport` is imported but only referenced inside
// `safeAppendLeadEvent`'s `extra` — keep the import lint-quiet via
// a type-level alias used in the helper's signature.
type _NeedsApprovalReportRef = NeedsApprovalReport;

/** Recipe registry for the self-heal pass (ADR-055 §D4). v1 ships
 *  three recipes: schema drift, cron pollution, supervisor missing.
 *  Future candidates (lock-stale, archive-bloat, phantom-inbox) live
 *  in ADR-055's "Future candidates" subsection — require own ADR to
 *  enable. Operator opts-in per recipe via `team.json::whip.
 *  selfHealRecipes`; absence here is a no-op (handled by the
 *  orchestrator's "skipped-unknown-recipe" outcome path). */
const SELF_HEAL_RECIPES: ReadonlyArray<CursorRecipe> = [
  fixTeamJsonSchemaDriftRecipe,
  fixCronPollutionRecipe,
  fixSupervisorMissingRecipe,
];

/** Pick the team's reviewer member name. Falls back to the hardcoded
 *  "reviewer" string if no member has the `reviewer` role — matches
 *  ADR-055 §D2 "kanban Task addressed to `reviewer` member" pattern.
 *  Operator-config: members declared in team.json with role: "reviewer". */
function resolveReviewerName(team: Team): string {
  for (const m of team.members) {
    const role = (m as { role?: unknown }).role;
    if (typeof role === "string" && role === "reviewer") return m.name;
  }
  return "reviewer";
}

/** Adapter: composes an `AccountSwapCheckCtx` from the verb's TickCtx +
 *  the parsed WhipConfig + delegates to
 *  `core/account-swap.ts::runAccountSwapCheck`. Mirrors the
 *  `runBudgetTickCheck` shape — the verb owns the config-shape mapping
 *  so the core module stays agnostic. */
async function runAccountSwapTickCheck(
  ctx: TickCtx,
  config: WhipConfig,
): Promise<AccountSwapVerdict> {
  // Reuse the same `probeBudget` injection as the budget-check. When
  // the caller passes a test fake, both checks share it; otherwise both
  // hit the on-disk 240s probe cache so the double-call cost is one
  // round-trip per account per tick.
  //
  // ADR-078 — opts forwarded through. account-swap leaves
  // `refreshOnNearExpiry` unset (read-only); the upstream
  // `runAccountSwapCheck` only passes `{ force: true }` for the
  // fallback re-probe, so the wrapper relays it without rotating
  // refreshTokens behind any TUI's back.
  const probeBudget =
    ctx.budgetProbe ??
    (async (account: string, opts?: { force?: boolean; refreshOnNearExpiry?: boolean }) => {
      const { probeBudget: defaultProbe } = await import("../abstractions/budget-probe.ts");
      return defaultProbe(account, opts ?? {});
    });
  const swapCtx: AccountSwapCheckCtx = {
    atmuxDir: ctx.atmuxDir,
    nowSec: ctx.nowSec,
    members: ctx.team.members.map((m) => {
      const out: { name: string; role?: string; claudeAccount?: string } = { name: m.name };
      if (typeof m.role === "string") out.role = m.role;
      const acc = (m as { claudeAccount?: unknown }).claudeAccount;
      if (typeof acc === "string" && acc.length > 0) out.claudeAccount = acc;
      return out;
    }),
    config: {
      accountFallback: config.accountFallback,
      accountSwapTriggerThreshold: config.accountSwapTriggerThreshold,
      accountSwapFallbackHealthThreshold: config.accountSwapFallbackHealthThreshold,
      accountSwapExcludeRoles: config.accountSwapExcludeRoles,
      defaultAccount: config.claudeAccount,
    },
  };
  const deps: AccountSwapCheckDeps = {
    probeBudget,
    log: (msg) => ctx.stderr(`${msg}\n`),
  };
  return runAccountSwapCheck(swapCtx, deps);
}

/** Per-tick advancement of an active swap pass. Runs ONE decision per
 *  tick (oneAtATime: true). The orchestrator returns:
 *    - no-active-pass  → nothing to do (caller already gated on
 *                        active-pass/pass-entered, but this guards
 *                        against a race where the pass closed between
 *                        the check + this call).
 *    - advanced        → one decision flipped this tick.
 *    - pass-complete   → final decision flipped + pass-complete ping
 *                        + driver-inbox surface fired.
 *
 *  Concrete deps for spawn / handoff are stubbed here as "not-ready"
 *  fallbacks — landing real spawn/handoff integration is a Part 3
 *  follow-up (touches src/verbs/start.ts internals + atmux handoff
 *  subprocess invocation, beyond T11's scope reservation). The stubs
 *  ensure runSwapPass walks decisions[] without blocking, marking each
 *  as aborted with a "spawn integration not yet wired" flag — which
 *  the operator sees + can resolve manually until T11-Part-3 lands. */
async function runSwapPassTickCheck(ctx: TickCtx, _config: WhipConfig): Promise<void> {
  // ADR-078 — `probeTarget` is a one-shot probe at swap-pass time. The
  // wrapper forwards opts but does NOT inject `refreshOnNearExpiry`;
  // rotating refreshTokens during a swap would 401 the very member we're
  // migrating.
  const probeBudget =
    ctx.budgetProbe ??
    (async (account: string, opts?: { force?: boolean; refreshOnNearExpiry?: boolean }) => {
      const { probeBudget: defaultProbe } = await import("../abstractions/budget-probe.ts");
      return defaultProbe(account, opts ?? {});
    });
  const deps: PerMemberSwapDeps = {
    probeTarget: (account) => probeBudget(account),
    spawnShadow: async (opts) => ({
      shadowName: `${opts.originalName}-swap`,
      ready: false,
      error: "shadow spawn integration pending T11 follow-up",
    }),
    handoff: async () => ({
      taskId: null,
      acked: false,
      error: "handoff integration pending T11 follow-up",
    }),
    pauseMember: async (atmuxDir, member, opts) => {
      const { pauseMember } = await import("../core/pause.ts");
      await pauseMember(atmuxDir, member, opts);
    },
    discordSend: ctx.send,
    log: (msg) => ctx.stderr(`${msg}\n`),
  };
  await runSwapPass(ctx.atmuxDir, deps, { team: ctx.team.name });
}

/** Adapter: composes an `AccountSwapCheckCtx` from the verb's TickCtx +
 *  the parsed WhipConfig + delegates to
 *  `core/account-swap.ts::runAccountSwapCheck`. Mirrors the
 *  `runBudgetTickCheck` shape — the verb owns the config-shape mapping
 *  so the core module stays agnostic. */
// (this comment is the original `runBudgetTickCheck` doc-block; left
// in place for the next function below.)

/** Adapter: composes a `BudgetCheckCtx` from the verb's TickCtx + the
 *  parsed WhipConfig (TeamWhip schema), then delegates to
 *  `core/whip-budget-check.ts::runBudgetCheck`. The verb owns the
 *  config-shape mapping; the core module stays agnostic of WhipConfig
 *  vs TeamWhip vs any future config shape that surfaces these knobs. */
async function runBudgetTickCheck(
  ctx: TickCtx,
  config: WhipConfig,
): Promise<ReturnType<typeof runBudgetCheck>> {
  const team = ctx.team;
  const fallbackEnabled = team.fallback?.enabled === true;

  const teamFallback: BudgetCheckCtx["team"]["fallback"] = fallbackEnabled
    ? { enabled: true }
    : undefined;

  const checkCtx: BudgetCheckCtx = {
    atmuxDir: ctx.atmuxDir,
    nowMs: ctx.nowMs,
    nowSec: ctx.nowSec,
    projectCwd: process.cwd(),
    team: {
      name: team.name,
      members: team.members.map((m) => {
        const out: BudgetCheckTeamMember = { name: m.name };
        if (typeof m.claudeAccount === "string" && m.claudeAccount.length > 0) {
          out.claudeAccount = m.claudeAccount;
        }
        return out;
      }),
      ...(teamFallback !== undefined ? { fallback: teamFallback } : {}),
    },
    config: {
      budgetPauseThreshold: config.budgetPauseThreshold,
      budgetResumeThreshold: config.budgetResumeThreshold,
      budgetWarningBands: config.budgetWarningBands,
      budgetRefreshLeadMins: config.budgetRefreshLeadMins,
    },
  };
  const deps: BudgetCheckDeps = {
    discordSend: ctx.send,
    log: (msg) => ctx.stderr(`${msg}\n`),
  };
  if (ctx.budgetProbe !== undefined) {
    deps.probeBudget = ctx.budgetProbe;
  }
  if (fallbackEnabled) {
    deps.listInFlightTasks = () => listTasks(ctx.atmuxDir, { status: "in-progress" });
    deps.sendCageBrief = (handle, body) => sendCageBrief(handle, body);
    deps.sendContinuityBrief = (member, body) => sendContinuityBrief(ctx, member, body);
  }
  return runBudgetCheck(checkCtx, deps);
}

/**
 * v1 cage-brief sender. Pastes the brief into the cage's tmux pane via
 * raw `tmux -L <socket> send-keys` (Tier 2: operator UID; Tier 3+: sudo
 * -u <agent>). Multi-line briefs use load-buffer + paste-buffer so the
 * brief lands as a single chunk rather than per-line keystrokes (which
 * would race against the agent's startup banner).
 *
 * The cage tmux server is FRESH (just spawned by createFallbackCage),
 * so no pane-state classifier is needed — there's nothing in the pane
 * to preempt the paste.
 */
async function sendCageBrief(handle: CageHandle, body: string): Promise<void> {
  const bufferName = `atmux-fallback-${handle.team}-${handle.lane}-${handle.createdAt}`;
  const target = `${handle.sessionName}:${handle.windowName}`;
  const isOperator = handle.agent === "operator";

  // tmux load-buffer reads from stdin via `-`. Wrap with sudo -u <agent>
  // for Tier 3+ since the cage tmux runs under the dedicated user.
  const tmuxArgv = (rest: string[]): { cmd: string; argv: string[] } =>
    isOperator
      ? { cmd: "tmux", argv: ["-L", handle.tmuxSocket, ...rest] }
      : {
          cmd: "sudo",
          argv: [
            "-u",
            handle.agent,
            "env",
            `TMUX_TMPDIR=${handle.tmuxTmpdir}`,
            "tmux",
            "-L",
            handle.tmuxSocket,
            ...rest,
          ],
        };

  const load = tmuxArgv(["load-buffer", "-b", bufferName, "-"]);
  await spawn({
    cmd: load.cmd,
    argv: load.argv,
    stdin: body,
    timeoutMs: 10_000,
  });
  const paste = tmuxArgv(["paste-buffer", "-b", bufferName, "-d", "-t", target]);
  await spawn({
    cmd: paste.cmd,
    argv: paste.argv,
    timeoutMs: 5_000,
  });
  // ADR-081 §A: settle ≥500ms, then submit via C-m (NOT Enter). This
  // sendCageBrief path uses raw `tmux send-keys` via spawn() rather
  // than the TmuxNamespace abstraction (cage tmux runs under a
  // dedicated fallback user via sudo, see `tmuxArgv` above), so we
  // can't route through `submitAfterPaste`. Same pattern inline —
  // PASTE_SUBMIT_SETTLE_FLOOR_MS is the single source of truth for
  // the settle floor across both code paths.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, PASTE_SUBMIT_SETTLE_FLOOR_MS);
  });
  const submit = tmuxArgv(["send-keys", "-t", target, "C-m"]);
  await spawn({
    cmd: submit.cmd,
    argv: submit.argv,
    timeoutMs: 5_000,
  });
}

/**
 * v1 continuity-brief sender. The original Claude member's pane lives
 * on the TEAM's tmux server (ctx.tmux); we paste the brief via
 * load-buffer + paste-buffer, same shape as `sendCageBrief` but using
 * the team-tmux abstraction directly. A pane-state-aware safe send
 * (ADR-057 §D1) belongs here once the lead reviews this — for v1 we
 * do the simple direct paste.
 */
async function sendContinuityBrief(ctx: TickCtx, member: string, body: string): Promise<void> {
  const session = await getSessionName({ dir: ctx.atmuxDir, team: ctx.team });
  // Members' window names are `<emoji><member>` — but the cage handle
  // stored the lane string (which may already be an emoji-prefixed name
  // OR the bare member name). For v1 we accept both shapes: try the
  // bare member as the window name; if it doesn't exist, the paste
  // surfaces a tmux error which the caller logs (best-effort).
  const target = `${session}:${member}`;
  const bufferName = `atmux-fallback-resume-${ctx.team.name}-${member}-${ctx.nowSec}`;
  await ctx.tmux.buffer.loadBuffer({ name: bufferName, data: body });
  const sendTarget: SendTarget = {
    kind: "member",
    member,
    team: ctx.team.name,
    target,
  };
  await ctx.tmux.buffer.pasteBuffer({
    name: bufferName,
    target: sendTarget,
    deleteAfter: true,
  });
  // ADR-081 §A: settle + C-m (not Enter) — bracketed-paste mode under
  // claude TUIs eats a trailing Enter as a newline inside the pasted
  // continuity brief. submitAfterPaste enforces the ≥500ms settle floor.
  await submitAfterPaste(ctx.tmux, sendTarget);
}

// ---------- Per-member check ----------

async function checkMember(
  ctx: TickCtx,
  member: TeamMember,
  config: WhipConfig,
  findings: Finding[],
): Promise<void> {
  const { team, atmuxDir, tmux, env, nowSec, readMemberEnv } = ctx;
  const session = await getSessionName({ dir: atmuxDir, team });

  // Resolve the window name. Lead window uses the I-2 marker first
  // (auto-rotate may have renamed the lead pane); falls back to the
  // ADR-017 `<emoji><member>` form derived from the schema entry — same
  // shape `start.ts::buildWindowName` spawns. Regular members go straight
  // to that form (memory feedback_window_naming_no_prefix).
  const role = (member.role ?? "member").toString();
  // ADR-135 + ADR-136 TR4: canonical `<emoji>-<label ?? name>` form.
  const memberWindowName = buildWindowName(member.name, member.emoji, member.label);
  // ADR-136 TR4: operator-facing display string. Used in bullet text +
  // any Discord-rendered struct fields; internal storage / lookup
  // paths continue to key on `member.name`.
  const display = displayMemberName(member);
  const homeOpts: SkillsTeamPathsOpts & { fallback?: string } =
    ctx.home !== undefined ? { home: ctx.home } : {};
  if (role === "team-lead") homeOpts.fallback = memberWindowName;
  const windowName =
    role === "team-lead" ? await readLeadWindowName(team.name, homeOpts) : memberWindowName;
  const windowTarget = `${session}:${windowName}`;

  // Window existence — `displayMessage` returns "" + non-zero if absent.
  // Cleaner: `listWindows` + `.some(w => w.name === windowName)`.
  // expected: tmux server transient unreachability (cron-window race against
  // a stop / start) — degrade to "no windows" so the per-member loop surfaces
  // the missing-window finding instead of crashing the whole tick.
  const windows = await tmux.window.listWindows(session).catch(() => []);
  const windowExists = windows.some((w) => w.name === windowName);
  if (!windowExists) {
    findings.push({
      category: "blocker",
      bullet: bullet80(`🛑 ${display}: window missing (role=${role})`),
    });
    return;
  }

  // Pane current command — must match the configured TUI. Crashed pane
  // falls back to the user's shell ($SHELL → zsh / bash).
  let paneCmd = "";
  let panePid = 0;
  try {
    paneCmd = await tmux.pane.displayMessage({
      target: windowTarget,
      format: "#{pane_current_command}",
    });
    const panes = await tmux.pane.listPanes(windowTarget);
    panePid = panes[0]?.pid ?? 0;
  } catch {
    // tmux misbehaved — surface as a blocker, skip further checks for
    // this member. Same posture as bash whip's silent skip.
    findings.push({
      category: "blocker",
      bullet: bullet80(`🛑 ${display}: pane probe failed`),
    });
    return;
  }

  const want = expectedTuiCmd(member.tui ?? "claude");
  if (want !== null && paneCmd !== want) {
    findings.push({
      category: "blocker",
      bullet: bullet80(`🛑 ${display}: pane is \`${paneCmd}\` not \`${want}\``),
    });
    return;
  }

  // ADR-024 cross-account drift detector. Read the member pane's
  // CLAUDE_CONFIG_DIR via /proc/<pid>/environ; compare to driver's. On
  // Linux only — non-Linux degrades to skip.
  if (panePid > 0) {
    const driverDir = env.CLAUDE_CONFIG_DIR ?? "";
    const driverTag = accountFromConfigDir(driverDir);
    if (driverTag !== null) {
      // expected: /proc/<pid>/environ unreadable (EACCES on cross-user pane,
      // ESRCH on pane-died-mid-tick race, ENOENT on non-Linux) — skip the
      // cross-account check for this member instead of crashing the tick.
      const memberEnv = await readMemberEnv(panePid).catch(() => null);
      if (memberEnv !== null) {
        const memberDir = memberEnv.CLAUDE_CONFIG_DIR ?? "";
        const memberTag = accountFromConfigDir(memberDir);
        if (memberTag !== null && memberTag !== driverTag) {
          findings.push({
            category: "blocker",
            bullet: bullet80(
              `🛑 ${display}: cross-account spawn (member=${memberTag}, driver=${driverTag})`,
            ),
          });
        }
      }
    }
  }

  // Banner detection — capture last 30 lines of the pane.
  let state = "";
  try {
    state = await tmux.pane.capturePane({ target: windowTarget, start: -30 });
  } catch {
    // capture-pane occasionally hits a transient failure (pane resizing,
    // server reload). Drop it — we already logged the missing-window
    // class above; reading "" classifies as no-banner this tick.
    state = "";
  }
  const snap = classifyPaneState(state);

  if (snap.rateLimit === "hard") {
    findings.push({
      category: "blocker",
      bullet: bullet80(`🔴 ${display}: HARD rate-limit banner visible`),
    });
  } else if (snap.rateLimit === "soft") {
    // ADR-022 + ADR-023: SOFT classifier is observed-but-not-acted-on
    // until the LLM-judge cascade ports.
    findings.push({
      category: "informational",
      bullet: bullet80(`🟡 ${display}: SOFT rate-limit observed (judge deferred)`),
    });
  }

  if (snap.compacting) {
    findings.push({
      category: "blocker",
      bullet: bullet80(`🟡 ${display}: compacting — skip sends`),
    });
  }

  if (snap.queuedMessages && !snap.busy) {
    findings.push({
      category: "blocker",
      bullet: bullet80(`📍 ${display}: messages queued but not submitted`),
    });
  }

  // ---------- Check 3: stale-task scan ----------
  // ADR-076: read via loadInbox (SQL-canonical when state.db exists; JSON
  // fallback for pre-migration teams). Replaces the direct tryReadJson read
  // that bypassed the cutover — direct JSON read returned stale data on
  // SQL teams whose JSON files froze post-Phase-3 writer-no-op.
  const inbox = await loadInbox(atmuxDir, member.name);
  if (inbox.inProgress.length > 0) {
    const rotatedSec = await readRotatedEpoch(atmuxDir, member.name);
    const stale = selectStaleTasks(inbox.inProgress, nowSec, config.staleMin, rotatedSec);
    if (stale.length > 0) {
      findings.push({
        category: "overdue",
        bullet: bullet80(
          `⏰ ${display}: ${stale.length} task(s) in-progress > ${config.staleMin}min`,
        ),
      });
    }
  }

  // ---------- ADR-057 §D4a: permission-mode drift ----------
  // ` ⏵⏵ <mode> on` lives in the bottom status row. Capture covers
  // it via the same `state` text we already classified above. We
  // collect the (member, mode) pair and let the caller dedup + emit
  // one drift Discord ping per tick (see runTick after the per-member
  // loop). Per-member 24h dedup at the emit site.
  const permMode = parsePermissionMode(state);
  if (permMode !== null && permMode !== "auto") {
    findings.push({
      category: "informational",
      bullet: bullet80(`📋 ${display}: pane in '${permMode}' mode (expected 'auto')`),
      // Discord renderer formats this `member` field as the
      // operator-facing display string — pass label-fallback, not the
      // raw ID (the ID is the immutable key, label is the surface).
      permModeDrift: { member: display, mode: permMode },
    });
  }

  // ---------- ADR-057 §D4c: defunct cwd ----------
  // pane_current_path is what the pane's shell session was launched
  // with. If the worktree was rm'd out from under the member, the
  // path is gone but tmux happily keeps the pane alive. Operator
  // needs to re-spawn or restore the worktree. P1 — fires every tick
  // until resolved.
  let panePath = "";
  try {
    panePath = await tmux.pane.displayMessage({
      target: windowTarget,
      format: "#{pane_current_path}",
    });
  } catch {
    // tmux probe failed for this attribute — treat as unknown, skip
    // (we already logged a generic pane-probe-failed blocker above
    // when displayMessage of pane_current_command threw; a second
    // failure here is the same incident).
    panePath = "";
  }
  if (panePath !== "" && !(await exists(panePath))) {
    findings.push({
      category: "blocker",
      bullet: bullet80(`🛑 ${display}: cwd ${panePath} does not exist`),
      // Discord-bound — uses display string per ADR-136 TR4.
      defunctCwd: { member: display, cwd: panePath },
    });
  }

  // ---------- ADR-057 §D4d: per-member rate-limit visibility ----------
  // The `snap.rateLimit` branch above already fires a finding when ANY
  // member shows a rate-limit banner — including silent (no-in-progress
  // task) members. The visibility property is satisfied by the existing
  // unconditional check. Re-classify via R57-T1's discrete classifier
  // so a future state-driven dedup can key on it; today the side-effect
  // is the finding above.
  const discreteState = classifyText(state, () => nowSec * 1000);
  if (discreteState.state === "RATE-LIMIT" && snap.rateLimit === "none") {
    // Belt-and-braces: discrete classifier caught a banner the legacy
    // flag-classifier missed (different regex catalog). Surface it.
    findings.push({
      category: "blocker",
      bullet: bullet80(`🔴 ${display}: RATE-LIMIT pane state (R57-T1 classifier)`),
    });
  }

  // ---------- ADR-142 §1c modal-cycling detector ----------
  // Sits AFTER the existing static-stuck classifier (`classifyText` ->
  // MODAL bucket). The two checks share the captured pane text but
  // target different signals: static-stuck = hash-equality across ticks
  // (covered by other paths); cycling = ≥N DISTINCT modal-hashes within
  // `windowMin` AND zero commits in `commitGracePeriodMin`.
  //
  // History recording is unconditional (within enabled + non-exempt
  // members); only the SURFACE actions (Discord + clarifier + flag)
  // are dedup'd in the tick aggregator. Per ADR-142 §OQ-2: this is the
  // pre-martinet-ship call-site (lead's whip §1c); martinet's per-tick
  // observer ports the same function post-ADR-140-ship.
  const cyc = ctx.modalCyclingConfig;
  if (cyc.enabled && !cyc.exemptMembers.has(member.name)) {
    const classified = classifyPaneAsModal(state);
    if (
      classified.isModal &&
      classified.modalText !== undefined &&
      classified.modalClass !== undefined
    ) {
      const entry: ModalHistoryEntry = {
        member: member.name,
        paneTextHash: computeModalHash(classified.modalText),
        detectedAt: nowSec,
        modalText: classified.modalText,
        modalClass: classified.modalClass,
      };
      try {
        const history = await loadModalHistory(atmuxDir, member.name);
        const retentionMin = cyc.windowMin * 2;
        const nextHistory = appendHistory(history, entry, retentionMin);
        await saveModalHistory(atmuxDir, member.name, nextHistory);

        // Commits cross-check — caller-injected counter, default reads
        // git log from the member's worktree (see TickCtx defaults at
        // runWhip).
        const commitsInWindow = ctx.commitCountInWindow
          ? await ctx.commitCountInWindow(member, cyc.commitGracePeriodMin).catch(() => 0)
          : 0;

        const verdict = shouldFireCycleDetection(nextHistory, {
          cycleThreshold: cyc.cycleThreshold,
          windowMin: cyc.windowMin,
          commitsInWindow,
          commitGracePeriodMin: cyc.commitGracePeriodMin,
        });
        if (verdict.fire) {
          const claimedTask = inbox.inProgress[0]?.id ?? "<unknown>";
          const distinctCount = new Set(verdict.modalsSeen.map((m) => m.paneTextHash)).size;
          findings.push({
            category: "blocker",
            bullet: bullet80(
              `🔄 ${display}: modal-cycling (${distinctCount} distinct in ${cyc.windowMin}min, 0 commits)`,
            ),
            modalCycling: {
              // Discord-bound — display string (Discord renderer
              // formats this directly into the bullet). Internal
              // modal-history `entry.member` stays as `member.name`
              // (the ID) for SQLite owner-column consistency.
              member: display,
              taskId: claimedTask,
              distinctCount,
              modalsSeen: verdict.modalsSeen,
            },
          });
        }
      } catch (e) {
        // History I/O is best-effort — a corrupt write or transient
        // disk error must not crash the tick. Surface as a low-priority
        // informational so operator sees it in the log.
        ctx.stderr(`whip: modal-cycling state I/O failed: ${String(e)}\n`);
      }
    }
  }
}

function expectedTuiCmd(tui: string): string | null {
  switch (tui) {
    case "claude":
      return "claude";
    case "opencode":
      return "opencode";
    case "kimi":
      return "kimi";
    case "cursor":
      return "cursor-agent";
    default:
      return null;
  }
}

async function readRotatedEpoch(atmuxDir: string, member: string): Promise<number> {
  const text = await readTextOrNull(join(stateDir(atmuxDir), `${member}-rotated.epoch`));
  if (text === null) return 0;
  const n = Number.parseInt(text.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// ---------- Check 5: lead uptime + ctx-pct (ADR-080 §A1) ----------

/**
 * Parse the lead pane's ctx-pct from a captured pane snapshot.
 *
 * Claude Code TUIs render a `tok N(.M)?k/<cap>` indicator near the
 * bottom status line where N is the running token count (in thousands,
 * possibly fractional) and `<cap>` is the per-conversation cap. ADR-080
 * §A1 needs `(N / cap) * 100` rounded — pct of cap consumed — so the
 * whip rotation gate can fire on ctx-pressure even when uptime hasn't
 * tripped `leadMaxMin`.
 *
 * Returns `null` when the indicator is absent (transient: fresh
 * bootstrap, modal-state pane, post-/clear before first prompt). Caller
 * treats null as "no signal — fall through to uptime gate".
 *
 * Pattern examples:
 *   `tok 67k/100`   → 67
 *   `tok 67.3k/100` → 67   (rounded)
 *   `tok 175k/200`  → 88   (rounded)
 *   no `tok …`      → null
 *
 * Exported for §A2 reuse (`src/verbs/lane-tick.ts` consumes the same
 * helper to refuse `claim --next` injection on a high-ctx lead).
 */
const TOK_CTX_RE = /\btok\s+(\d+(?:\.\d+)?)k\/(\d+)k?\b/i;
export function parseLeadCtxPct(captureText: string): number | null {
  const m = captureText.match(TOK_CTX_RE);
  if (m === null) return null;
  const used = Number.parseFloat(m[1] ?? "");
  const cap = Number.parseInt(m[2] ?? "", 10);
  if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return null;
  return Math.round((used / cap) * 100);
}

async function checkLeadUptime(
  ctx: TickCtx,
  config: WhipConfig,
  homeOpts: SkillsTeamPathsOpts,
): Promise<Finding | null> {
  const { team, nowSec, atmuxDir, tmux } = ctx;
  const startEpoch = await readLeadSessionStart(team.name, homeOpts);
  if (startEpoch === null || startEpoch <= 0) return null;
  const uptimeSec = nowSec - startEpoch;
  if (uptimeSec < 0) return null;
  const uptimeMin = Math.floor(uptimeSec / 60);

  // ADR-080 §A1: also probe ctx-pct via a lead-pane capture. A high-ctx
  // lead is at risk of mid-think rotation drift even when uptime hasn't
  // tripped `leadMaxMin`. Best-effort: capture failure / missing window
  // / no-tok-indicator all collapse to null → fall through to uptime.
  let ctxPct: number | null = null;
  try {
    const leadWindowName = await readLeadWindowName(team.name, homeOpts);
    if (leadWindowName !== null && leadWindowName.length > 0) {
      const session = await getSessionName({ dir: atmuxDir, team });
      const captured = await tmux.pane.capturePane({
        target: `${session}:${leadWindowName}`,
        start: -10,
      });
      ctxPct = parseLeadCtxPct(captured);
    }
  } catch {
    ctxPct = null;
  }

  const overUptime = uptimeMin >= config.leadMaxMin;
  const overCtx = ctxPct !== null && ctxPct >= config.leadCtxRotateThreshold;
  if (!overUptime && !overCtx) return null;

  // V-26 will execute auto-rotate; V-25 only recommends. The bullet
  // text varies by `autoRotate` so the operator sees the team's
  // posture without having to grep team.json.
  const tail = config.autoRotate
    ? "auto-rotate execute is V-26-deferred per ADR-021"
    : "consider `atmux rotate-lead`";
  // Prefer the ctx reason when both fire — ctx-pressure is the more
  // actionable signal (uptime can be a side-effect of a quiet
  // long-running session).
  const reason = overCtx
    ? `ctx ${ctxPct}% ≥ ${config.leadCtxRotateThreshold}%`
    : `uptime ${uptimeMin}min ≥ ${config.leadMaxMin}min`;
  return {
    category: "overdue",
    bullet: bullet80(`♻️ lead ${reason} — ${tail}`),
  };
}

// ---------- Findings → Discord push ----------

async function emitFindings(
  parsed: WhipArgs,
  ctx: TickCtx,
  config: WhipConfig,
  findings: Finding[],
): Promise<void> {
  const { team, atmuxDir, stdout, stderr, send, nowMs, nowSec, webhookOverride } = ctx;

  // Local log line — append to <atmuxDir>/logs/whip.log for the
  // operator's tail (parity with bash _atmux_report_and_exit).
  const logf = join(atmuxDir, "logs", "whip.log");
  const ts = new Date(nowMs).toISOString();
  if (findings.length === 0) {
    await ensureDir(dirname(logf));
    await writeLogLine(logf, `[${ts}] whip: all clean\n`);
  } else {
    await ensureDir(dirname(logf));
    const body = findings.map((f) => `  - ${f.bullet}`).join("\n");
    await writeLogLine(logf, `[${ts}] whip: ${findings.length} finding(s)\n${body}\n`);
  }

  // Stdout digest for cron / interactive runs. Same body as the log
  // (operator tails one or the other).
  if (findings.length === 0) {
    stdout(`whip: all clean (team=${team.name}, ts=${nowSec})\n`);
  } else {
    stdout(`whip: ${findings.length} finding(s) (team=${team.name}, ts=${nowSec})\n`);
    for (const f of findings) stdout(`  - ${f.bullet}\n`);
  }

  if (!parsed.pushDiscord) return;

  const blockers = findings.filter((f) => f.category === "blocker");
  const overdue = findings.filter((f) => f.category === "overdue");
  const informational = findings.filter((f) => f.category === "informational");

  // Per ADR-022 §"Rendering": one named template per finding class.
  // 0 findings → 💓 [whip-heartbeat] iff config.heartbeat (suppressible)
  // OR --heartbeat flag.
  if (findings.length === 0) {
    if (!config.heartbeat && !parsed.forceHeartbeat) return;
    await tryDiscord(send, stderr, {
      template: "whip-heartbeat",
      team: team.name,
      category: "💓",
      bullets: ["📊 all clean"],
      whenMs: nowMs,
      ...(webhookOverride !== undefined ? { webhookOverride } : {}),
    });
    return;
  }

  // ADR-079 §D: per-template hash dedup. Without this, an unchanged
  // finding set re-fires the same Discord ping every 5min — sopx
  // measured ~275 pings/24h, 90% boilerplate. Gate each template
  // emit on hash transition + hourly heartbeat re-fire.
  const findingState = await loadWhipFindingState(atmuxDir);
  let nextState: WhipFindingState = findingState;
  const tickHeartbeatSec = config.heartbeat ? 3600 : Number.POSITIVE_INFINITY;

  if (blockers.length > 0) {
    const bullets = blockers.map((f) => f.bullet);
    const hash = hashFindingBullets(bullets);
    const verdict = shouldFireFinding(nextState, "whip-blocker", hash, nowSec, tickHeartbeatSec);
    if (verdict === "suppress") {
      stderr(`whip: whip-blocker: state unchanged, suppressed\n`);
    } else {
      await tryDiscord(send, stderr, {
        template: "whip-blocker",
        team: team.name,
        category: "🛑",
        bullets,
        whenMs: nowMs,
        ...(webhookOverride !== undefined ? { webhookOverride } : {}),
      });
      nextState = recordFindingFire(nextState, "whip-blocker", hash, nowSec);
    }
  }
  if (overdue.length > 0) {
    const bullets = overdue.map((f) => f.bullet);
    const hash = hashFindingBullets(bullets);
    const verdict = shouldFireFinding(nextState, "whip-overdue", hash, nowSec, tickHeartbeatSec);
    if (verdict === "suppress") {
      stderr(`whip: whip-overdue: state unchanged, suppressed\n`);
    } else {
      await tryDiscord(send, stderr, {
        template: "whip-overdue",
        team: team.name,
        category: "⏰",
        bullets,
        whenMs: nowMs,
        ...(webhookOverride !== undefined ? { webhookOverride } : {}),
      });
      nextState = recordFindingFire(nextState, "whip-overdue", hash, nowSec);
    }
  }
  // Always compute a [whip-progress] digest summarising counts so the
  // operator's standing channel has a single bullet to grep on for
  // "tick happened". Soft / informational signals ride here. Same
  // dedup gate — counts are the body, so identical counts + identical
  // info bullets across ticks → suppress (e.g., 12 consecutive
  // auto-preclear-failed ticks → 1 emit + 1 hourly heartbeat).
  {
    const bullets = [
      bullet80(
        `📊 ${blockers.length} blocker(s) · ${overdue.length} overdue · ${informational.length} info`,
      ),
      ...informational.map((f) => f.bullet),
    ];
    const hash = hashFindingBullets(bullets);
    const verdict = shouldFireFinding(nextState, "whip-progress", hash, nowSec, tickHeartbeatSec);
    if (verdict === "suppress") {
      stderr(`whip: whip-progress: state unchanged, suppressed\n`);
    } else {
      await tryDiscord(send, stderr, {
        template: "whip-progress",
        team: team.name,
        category: "📊",
        bullets,
        whenMs: nowMs,
        ...(webhookOverride !== undefined ? { webhookOverride } : {}),
      });
      nextState = recordFindingFire(nextState, "whip-progress", hash, nowSec);
    }
  }
  if (nextState !== findingState) {
    await saveWhipFindingState(atmuxDir, nextState);
  }

  // ADR-057 §D4a: aggregate perm-mode-drift findings into one ping per
  // tick, applying per-member 24h dedup. State file:
  // <atmuxDir>/state/perm-mode-drift-state.json.
  const driftFindings = findings
    .map((f) => f.permModeDrift)
    .filter((p): p is { member: string; mode: string } => p !== undefined);
  if (driftFindings.length > 0) {
    const state = await loadPermModeDriftState(atmuxDir);
    const fireable = driftFindings.filter((p) => shouldFireDrift(state, p.member, nowSec));
    if (fireable.length > 0) {
      await tryDiscord(send, stderr, {
        ...renderWhipPermModeDrift({ team: team.name, drifted: fireable, whenMs: nowMs }),
        ...(webhookOverride !== undefined ? { webhookOverride } : {}),
      });
      let next = state;
      for (const p of fireable) next = recordDrift(next, p.member, nowSec);
      await savePermModeDriftState(atmuxDir, next);
    }
  }

  // ADR-057 §D4c: aggregate defunct-cwd findings into one ping per
  // tick. NO dedup — defunct cwd is a P1 demand for operator action;
  // every tick re-fires until the operator restores or re-spawns.
  const defunctFindings = findings
    .map((f) => f.defunctCwd)
    .filter((p): p is { member: string; cwd: string } => p !== undefined);
  if (defunctFindings.length > 0) {
    await tryDiscord(send, stderr, {
      ...renderWhipDefunctCwd({ team: team.name, defunct: defunctFindings, whenMs: nowMs }),
      ...(webhookOverride !== undefined ? { webhookOverride } : {}),
    });
  }

  // ADR-142 §D4-D5: aggregate modal-cycling findings into per-member
  // dedup'd Discord + clarifier dispatch + flag-add. State file:
  // <atmuxDir>/state/modal-cycling-dedup-state.json.
  type ModalCyclingPayload = NonNullable<Finding["modalCycling"]>;
  const cyclingFindings = findings
    .map((f) => f.modalCycling)
    .filter((p): p is ModalCyclingPayload => p !== undefined);
  if (cyclingFindings.length > 0) {
    const cyc = ctx.modalCyclingConfig;
    let dedupState = await loadModalCyclingDedupState(atmuxDir);
    const dedupSec = cyc.dedupMin * 60;
    for (const f of cyclingFindings) {
      if (!shouldFireModalCyclingDedup(dedupState, f.member, nowSec, dedupSec)) continue;
      // Discord — last 3 modals truncated for the bullet.
      await tryDiscord(send, stderr, {
        ...renderWhipModalCycling({
          team: team.name,
          member: f.member,
          taskId: f.taskId,
          distinctCount: f.distinctCount,
          windowMin: cyc.windowMin,
          modalsSeen: f.modalsSeen.slice(-3).map((m) => ({
            modalClass: m.modalClass,
            firstLine: m.modalText.split("\n")[0]?.trim() ?? "",
          })),
          whenMs: nowMs,
        }),
        ...(webhookOverride !== undefined ? { webhookOverride } : {}),
      });
      // Clarifier — best-effort send to the member's pane.
      const clarifierMsg = `[detector] modal-cycling detected — ${f.distinctCount} prompts in ${cyc.windowMin}min, 0 commits on ${f.taskId}. Recommend: unclaim + retry from clean, or surface blocker via atmux reply if the prompt class is genuinely blocking work.`;
      if (ctx.dispatchModalCyclingClarifier) {
        try {
          await ctx.dispatchModalCyclingClarifier(f.member, clarifierMsg);
        } catch (e) {
          stderr(`whip: modal-cycling clarifier dispatch failed: ${String(e)}\n`);
        }
      }
      // Flag — `atmux flags add ... --severity high`.
      if (ctx.fileModalCyclingFlag) {
        const subject = `modal-cycling detected on ${f.member}`;
        const seenLines = f.modalsSeen
          .slice(-3)
          .map((m) => `${m.modalClass}: ${m.modalText.split("\n")[0]?.trim() ?? ""}`)
          .join(" | ");
        const body = `${f.distinctCount} distinct modals in ${cyc.windowMin}min, 0 commits on ${f.taskId}. Modals: ${seenLines}`;
        try {
          await ctx.fileModalCyclingFlag(subject, body);
        } catch (e) {
          stderr(`whip: modal-cycling flag-add failed: ${String(e)}\n`);
        }
      }
      dedupState = recordModalCyclingDedup(dedupState, f.member, nowSec);
    }
    await saveModalCyclingDedupState(atmuxDir, dedupState);
  }
}

async function tryDiscord(
  send: (opts: DiscordSendOpts) => Promise<void>,
  stderr: Writer,
  opts: DiscordSendOpts,
): Promise<void> {
  try {
    await send(opts);
  } catch (e) {
    if (e instanceof ConfigError) {
      // No webhook resolved — soft-skip. Bash equivalent of the no-op
      // early return at lib/discord.sh:9-11.
      return;
    }
    const reason = e instanceof Error ? e.message : String(e);
    stderr(`atmux: warn: whip: discord ping failed (${opts.template}): ${reason}\n`);
  }
}

// ---------- whip-last.hash (delta-tracking anchor) ----------

async function writeLastHash(atmuxDir: string, epochSec: number): Promise<void> {
  const path = join(stateDir(atmuxDir), "whip-last.hash");
  await writeText(path, `${epochSec}\n`);
}

// ---------- Helpers ----------

/** ≤80-grapheme-safe truncation. Exported via re-use of the same
 *  segmenter pattern as discord.ts; we keep it inline here so this
 *  module stays a leaf consumer of `discord.ts` rather than reaching
 *  into private helpers. */
const GRAPHEME_SEG = new Intl.Segmenter("en", { granularity: "grapheme" });

export function bullet80(s: string): string {
  const max = 80;
  const segs: string[] = [];
  for (const seg of GRAPHEME_SEG.segment(s)) segs.push(seg.segment);
  if (segs.length <= max) return s;
  return `${segs.slice(0, max - 1).join("")}…`;
}

async function writeLogLine(path: string, line: string): Promise<void> {
  await appendText(path, line);
}

// ---------- ADR-054 §D2 — config-drift helpers ----------

/**
 * Read team.json, validate via the strict Team schema, and return either
 * the parsed team OR the safe-defaults fallback + drift report. Never
 * crashes on schema/JSON failure (the whole point of this entry — whip
 * must keep ticking). Throws ConfigError only when team.json is absent
 * (that's a hard refusal — the team itself doesn't exist yet).
 */
async function loadTeamWithDrift(
  atmuxDir: string,
  dirOpts: ResolveDirOpts,
): Promise<{ team: Team; driftReport: DriftReport | null }> {
  const path = teamJsonPath(atmuxDir);
  const raw = await readTextOrNull(path);
  if (raw === null) {
    // Absent — defer to requireTeam's ConfigError (the canonical
    // "no team here" path). Most upstream callers wrap in their own
    // help/init-prompt logic; whip just propagates.
    const team = await requireTeam(dirOpts);
    return { team, driftReport: null };
  }
  // Try JSON-parse first.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const driftReport = composeCatastrophicDrift(e, raw);
    const safeShape = makeDriftSafeDefaults(undefined);
    const team = Team.parse(safeShape);
    return { team, driftReport };
  }
  // Try Zod validation.
  const result = Team.safeParse(parsed);
  if (result.success) {
    return { team: result.data, driftReport: null };
  }
  // Schema failure — compose drift + apply safe defaults.
  const driftReport = composeDriftReport(result.error, raw);
  const safeShape = makeDriftSafeDefaults(parsed);
  // Safe-defaults shape MUST parse — if it doesn't, something's gone
  // very wrong (logic bug in makeDriftSafeDefaults). Re-throw as a
  // catastrophic drift to keep the tick alive with a minimal team.
  const safeResult = Team.safeParse(safeShape);
  const team = safeResult.success
    ? safeResult.data
    : Team.parse({ name: "unknown-team", members: [] });
  return { team, driftReport };
}

/**
 * Maybe fire the [whip-config-drift] Discord ping. Skipped if the
 * dedup state file shows the same hash within the 24h re-fire window.
 * Records the fire epoch on success so the next tick can dedup.
 */
async function maybeFireDriftPing(
  atmuxDir: string,
  teamName: string,
  driftReport: DriftReport,
  send: (opts: DiscordSendOpts) => Promise<void>,
  nowSec: number,
  nowMs: number,
): Promise<void> {
  const should = await shouldFireDriftPing(atmuxDir, driftReport.driftHash, nowSec);
  if (!should) return;
  await send(
    renderWhipConfigDrift({
      team: teamName,
      driftHash: driftReport.driftHash,
      issues: driftReport.issues,
      catastrophic: driftReport.catastrophic,
      whenMs: nowMs,
    }),
  );
  await recordDriftPing(atmuxDir, driftReport.driftHash, nowSec);
}
