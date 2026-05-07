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

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type DiscordSendOpts, send as discordSend } from "../abstractions/discord.ts";
import { appendText, ensureDir, exists, readTextOrNull, writeText } from "../abstractions/fs.ts";
import { tryParseJsonString, tryReadJson } from "../abstractions/json.ts";
import { acquire as acquireLock, type LockHandle } from "../abstractions/lock.ts";
import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  classifyPaneState,
  getAtmuxDir,
  getDefaultSocket,
  getSessionName,
  inboxPathFor,
  type ResolveDirOpts,
  requireTeam,
  stateDir,
  teamJsonPath,
} from "../core/common.ts";
import {
  composeCatastrophicDrift,
  composeDriftReport,
  type DriftReport,
  makeDriftSafeDefaults,
  recordDriftPing,
  shouldFireDriftPing,
} from "../core/whip-config-drift.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import {
  type BudgetCheckCtx,
  type BudgetCheckDeps,
  type BudgetCheckTeamMember,
  runBudgetCheck,
} from "../core/whip-budget-check.ts";
import {
  type AccountSwapCheckCtx,
  type AccountSwapCheckDeps,
  type AccountSwapVerdict,
  type PerMemberSwapDeps,
  runAccountSwapCheck,
  runSwapPass,
} from "../core/account-swap.ts";
import type { BudgetProbeResult } from "../abstractions/budget-probe.ts";
import { checkStaleAnchor } from "../core/stale-anchor.ts";
import { runSelfHealPass } from "../core/cursor-self-heal.ts";
import { fixTeamJsonSchemaDriftRecipe } from "../core/cursor-recipes/fix-team-json-schema-drift.ts";
import { fixCronPollutionRecipe } from "../core/cursor-recipes/fix-cron-pollution.ts";
import { fixSupervisorMissingRecipe } from "../core/cursor-recipes/fix-supervisor-missing.ts";
import type { CursorRecipe } from "../core/cursor-recipes/types.ts";
import { ConfigError, LockTimeoutError, UsageError } from "../errors.ts";
import { Inbox as InboxSchema } from "../schema/inbox.ts";
import { Team, type TeamMember } from "../schema/team.ts";
import { renderWhipConfigDrift } from "../abstractions/discord.ts";

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
}

const DEFAULT_WHIP_CONFIG: WhipConfig = {
  staleMin: 90,
  leadMaxMin: 60,
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
};

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
      const chain = o.accountFallback.filter((s): s is string => typeof s === "string" && s.length > 0);
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

export interface SkillsTeamPathsOpts {
  /** Override `~` for tests. Defaults to `os.homedir()`. */
  home?: string;
}

export function leadSessionStartPath(team: string, opts: SkillsTeamPathsOpts = {}): string {
  const home = opts.home ?? homedir();
  return join(home, ".claude", "teams", team, "lead-session-start.txt");
}

export function leadWindowNamePath(team: string, opts: SkillsTeamPathsOpts = {}): string {
  const home = opts.home ?? homedir();
  return join(home, ".claude", "teams", team, "lead-window-name.txt");
}

/** Force-write the I-1 marker (used by `--init-lead-marker`). */
export async function writeLeadSessionStart(
  team: string,
  epochSec: number,
  opts: SkillsTeamPathsOpts = {},
): Promise<void> {
  const path = leadSessionStartPath(team, opts);
  await ensureDir(dirname(path));
  await writeText(path, `${epochSec}\n`);
}

/** Auto-init the I-1 marker iff missing — keeps Check 5 reads from
 *  failing on first-tick of a fresh team. Returns true on a write. */
export async function ensureLeadSessionStart(
  team: string,
  epochSec: number,
  opts: SkillsTeamPathsOpts = {},
): Promise<boolean> {
  const path = leadSessionStartPath(team, opts);
  if (await exists(path)) return false;
  await writeLeadSessionStart(team, epochSec, opts);
  return true;
}

export async function readLeadSessionStart(
  team: string,
  opts: SkillsTeamPathsOpts = {},
): Promise<number | null> {
  const text = await readTextOrNull(leadSessionStartPath(team, opts));
  if (text === null) return null;
  const n = Number.parseInt(text.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** I-2 read side. Falls back to bash convention `__<team>__team-lead`
 *  when the marker file is absent (writer side V-26-deferred per
 *  ADR-021; the verb that knows the lead-window's actual name is
 *  `team rotate-lead` / `team start`). */
export async function readLeadWindowName(
  team: string,
  opts: SkillsTeamPathsOpts = {},
): Promise<string> {
  const text = await readTextOrNull(leadWindowNamePath(team, opts));
  if (text !== null) {
    const trimmed = text.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return `__${team}__team-lead`;
}

// ---------- Findings ----------

export interface Finding {
  /** Tag for category routing in the Discord push step. */
  category: "blocker" | "overdue" | "informational";
  /** Bullet text — must satisfy ADR-008 ≤80 graphemes + emoji prefix. */
  bullet: string;
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
  budgetProbe?: (account: string) => Promise<BudgetProbeResult>;
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
      tmux: opts.tmux ?? createTmux({ socketPath: getDefaultSocket(team.name) }),
      ...(opts.budgetProbe !== undefined ? { budgetProbe: opts.budgetProbe } : {}),
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
  budgetProbe?: (account: string) => Promise<BudgetProbeResult>;
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
  await writeLastHash(atmuxDir, nowSec);
  return 0;
}

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
  const probeBudget =
    ctx.budgetProbe ??
    (async (account: string) => {
      const { probeBudget: defaultProbe } = await import("../abstractions/budget-probe.ts");
      return defaultProbe(account);
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
async function runSwapPassTickCheck(ctx: TickCtx, config: WhipConfig): Promise<void> {
  const probeBudget =
    ctx.budgetProbe ??
    (async (account: string) => {
      const { probeBudget: defaultProbe } = await import("../abstractions/budget-probe.ts");
      return defaultProbe(account);
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
  const checkCtx: BudgetCheckCtx = {
    atmuxDir: ctx.atmuxDir,
    nowMs: ctx.nowMs,
    nowSec: ctx.nowSec,
    team: {
      name: ctx.team.name,
      members: ctx.team.members.map((m) => {
        const out: BudgetCheckTeamMember = { name: m.name };
        if (typeof m.claudeAccount === "string" && m.claudeAccount.length > 0) {
          out.claudeAccount = m.claudeAccount;
        }
        return out;
      }),
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
  return runBudgetCheck(checkCtx, deps);
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

  // Resolve the window name. Lead window uses the I-2 marker (with
  // bash-fallback); regular members use buildWindowName equivalent
  // (`<emoji><member>` per ADR-017 / memory feedback_window_naming_no_prefix).
  const role = (member.role ?? "member").toString();
  const homeOpts: SkillsTeamPathsOpts = ctx.home !== undefined ? { home: ctx.home } : {};
  const windowName =
    role === "team-lead"
      ? await readLeadWindowName(team.name, homeOpts)
      : `${member.emoji ?? ""}${member.name}`;
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
      bullet: bullet80(`🛑 ${member.name}: window missing (role=${role})`),
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
      bullet: bullet80(`🛑 ${member.name}: pane probe failed`),
    });
    return;
  }

  const want = expectedTuiCmd(member.tui ?? "claude");
  if (want !== null && paneCmd !== want) {
    findings.push({
      category: "blocker",
      bullet: bullet80(`🛑 ${member.name}: pane is \`${paneCmd}\` not \`${want}\``),
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
              `🛑 ${member.name}: cross-account spawn (member=${memberTag}, driver=${driverTag})`,
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
      bullet: bullet80(`🔴 ${member.name}: HARD rate-limit banner visible`),
    });
  } else if (snap.rateLimit === "soft") {
    // ADR-022 + ADR-023: SOFT classifier is observed-but-not-acted-on
    // until the LLM-judge cascade ports.
    findings.push({
      category: "informational",
      bullet: bullet80(`🟡 ${member.name}: SOFT rate-limit observed (judge deferred)`),
    });
  }

  if (snap.compacting) {
    findings.push({
      category: "blocker",
      bullet: bullet80(`🟡 ${member.name}: compacting — skip sends`),
    });
  }

  if (snap.queuedMessages && !snap.busy) {
    findings.push({
      category: "blocker",
      bullet: bullet80(`📍 ${member.name}: messages queued but not submitted`),
    });
  }

  // ---------- Check 3: stale-task scan ----------
  const inboxPath = inboxPathFor(atmuxDir, member.name);
  const inbox = await tryReadJson(inboxPath, InboxSchema);
  if (inbox !== null && inbox.inProgress.length > 0) {
    const rotatedSec = await readRotatedEpoch(atmuxDir, member.name);
    const stale = selectStaleTasks(inbox.inProgress, nowSec, config.staleMin, rotatedSec);
    if (stale.length > 0) {
      findings.push({
        category: "overdue",
        bullet: bullet80(
          `⏰ ${member.name}: ${stale.length} task(s) in-progress > ${config.staleMin}min`,
        ),
      });
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

// ---------- Check 5: lead uptime ----------

async function checkLeadUptime(
  ctx: TickCtx,
  config: WhipConfig,
  homeOpts: SkillsTeamPathsOpts,
): Promise<Finding | null> {
  const { team, nowSec } = ctx;
  const startEpoch = await readLeadSessionStart(team.name, homeOpts);
  if (startEpoch === null || startEpoch <= 0) return null;
  const uptimeSec = nowSec - startEpoch;
  if (uptimeSec < 0) return null;
  const uptimeMin = Math.floor(uptimeSec / 60);
  if (uptimeMin >= config.leadMaxMin) {
    // V-26 will execute auto-rotate; V-25 only recommends. The bullet
    // text varies by `autoRotate` so the operator sees the team's
    // posture without having to grep team.json.
    const tail = config.autoRotate
      ? "auto-rotate execute is V-26-deferred per ADR-021"
      : "consider `atmux rotate-lead`";
    return {
      category: "overdue",
      bullet: bullet80(`♻️ lead uptime ${uptimeMin}min ≥ ${config.leadMaxMin}min — ${tail}`),
    };
  }
  return null;
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

  if (blockers.length > 0) {
    await tryDiscord(send, stderr, {
      template: "whip-blocker",
      team: team.name,
      category: "🛑",
      bullets: blockers.map((f) => f.bullet),
      whenMs: nowMs,
      ...(webhookOverride !== undefined ? { webhookOverride } : {}),
    });
  }
  if (overdue.length > 0) {
    await tryDiscord(send, stderr, {
      template: "whip-overdue",
      team: team.name,
      category: "⏰",
      bullets: overdue.map((f) => f.bullet),
      whenMs: nowMs,
      ...(webhookOverride !== undefined ? { webhookOverride } : {}),
    });
  }
  // Always also emit a [whip-progress] digest summarising counts so the
  // operator's standing channel has a single bullet to grep on for
  // "tick happened". Soft / informational signals ride here.
  await tryDiscord(send, stderr, {
    template: "whip-progress",
    team: team.name,
    category: "📊",
    bullets: [
      bullet80(
        `📊 ${blockers.length} blocker(s) · ${overdue.length} overdue · ${informational.length} info`,
      ),
      ...informational.map((f) => f.bullet),
    ],
    whenMs: nowMs,
    ...(webhookOverride !== undefined ? { webhookOverride } : {}),
  });
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
