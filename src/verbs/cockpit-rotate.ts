// ADR-167: `atmux cockpit rotate <session-name>` — Rung C canonical
// rotation verb for cockpit-level role panes (medic / sentinel / per-
// team driver). Closes the missing rung in /bruh's escalation chain
// (Rung A = member rotate, Rung B = lead rotate via medic, Rung C =
// this verb, Rung D = full cockpit rebuild).
//
// T2 (shipped c376f63): verb dispatch, parser, gate-4 (never-rotate-
// superdriver), caller-scope gate, role classifier, per-role respawn
// stubs.
//
// T3 (this commit): gates 1-3 IO + classifier impl + NDJSON audit-row
// emit + Discord [cockpit-rotate-refused] emit at every gate-refusal
// site. Each gate's pure classifier is extracted (text|mtime → reason-
// or-null) so the test surface is small + exhaustive (T6 t-18bddf4e
// covers each gate × each refusal path × each respawn path).
//
// Exit codes (ADR-167 §Decision + §OQ-5):
//   0   success
//   64  EX_USAGE        — argv parse failure (bubbles via UsageError)
//   65  EX_DATAERR      — pre-flight gate refusal (1-4)
//   70  EX_SOFTWARE     — respawn-step failure (T4)
//   78  EX_CONFIG       — caller-scope gate refusal (ConfigError; mirrors
//                         spawn-epic / dissolve-epic per ADR-033)

import { join } from "node:path";
import { resolveClaudeWrapper } from "../abstractions/claude-account-wrapper.ts";
import {
  type CockpitRotateRefusedOpts,
  type DiscordSendOpts,
  send as discordSendDefault,
  renderCockpitRotateRefused,
} from "../abstractions/discord.ts";
import { appendText as appendTextDefault, statOrNull } from "../abstractions/fs.ts";
import { now as nowMsDefault } from "../abstractions/time.ts";
import {
  createTmux,
  type SendTarget,
  type Target,
  type TmuxConfig,
  type TmuxNamespace,
} from "../abstractions/tmux.ts";
import {
  type LoadCockpitOpts,
  type LoadedCockpit,
  loadCockpit as loadCockpitDefault,
} from "../core/cockpit.ts";
import { resolveCallerScope } from "../core/common.ts";
import { type CaptureFn, classifyText, type PaneState } from "../core/pane-state.ts";
import {
  type PaneVerifier,
  type SendKeysFn,
  safeSendKeysWithVerify as safeSendKeysWithVerifyDefault,
} from "../core/safe-send.ts";
import { getCockpitSocketName } from "../core/tmux-paths.ts";
import type { Logger } from "../core/tui.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type {
  CockpitClaudeAccount,
  CockpitMedic,
  CockpitSentinel,
  CockpitTeam,
  CockpitTuiOverrides,
} from "../schema/cockpit.ts";
import {
  autoStartSentinelLoop as autoStartSentinelLoopDefault,
  autoStartSuperdoctorLoop as autoStartSuperdoctorLoopDefault,
  buildSentinelWindowCommand,
  buildTeamWindowCommand,
} from "./cockpit.ts";

/** Parsed shape for `atmux cockpit rotate` argv. */
export interface ParsedCockpitRotateArgs {
  /** Canonical session-name: `medic` | `sentinel` | `<team-name>`. */
  sessionName: string;
  /** Operator override for the four pre-flight gates. Gate 4 (never-
   *  rotate-superdriver) ignores this flag — see ADR-167 §Pre-flight
   *  gate matrix row 4. */
  force: boolean;
}

/** Session-names that the verb hard-refuses regardless of `--force`.
 *  Gate 4 fires before all others (cheapest + most load-bearing) — the
 *  superdriver pane (W1 per ADR-135) is the operator REPL; rotating it
 *  would kill the interactive session. */
const RESERVED_NEVER_ROTATE: ReadonlySet<string> = new Set(["superdriver"]);

/** Default cockpit session-name (ADR-135 §D5 post-`atmux_teams` rename).
 *  Operators with bespoke names pass `cockpitSessionName` opt. */
const COCKPIT_SESSION_DEFAULT = "atmux_cockpit";

/** Pre-flight gate 3 minimum uptime — `<60min` since the per-role
 *  session-start marker means "rotated too soon after spawn, lost
 *  context unnecessarily" per ADR-167 §Pre-flight gate matrix row 3. */
const GATE_3_UPTIME_MIN_MIN = 60;

/** Pane states that gate-2 refuses on. BUSY = agent mid-think, COMPACTING
 *  = context-compaction in progress — both per src/core/pane-state.ts
 *  (ADR-155 / ADR-057 §D1). Other states (READY / TYPING / MODAL / RATE-
 *  LIMIT / SHELL / UNKNOWN) pass gate-2; TYPING is gate-1's concern
 *  scoped to the cockpit superdriver pane only. */
const GATE_2_REFUSE_STATES: ReadonlySet<PaneState> = new Set<PaneState>(["BUSY", "COMPACTING"]);

/** Exit-code constants. Module-local — cli.ts maps AtmuxError tags via
 *  exitCodeForTag, but gate-1..3 refusals + respawn failures return
 *  numeric codes directly (cleaner than minting new error tags). */
const EX_OK = 0;
const EX_DATAERR = 65;
const EX_SOFTWARE = 70;

/** How many lines back capturePane reads from the bottom. 200 covers the
 *  last ~60s of typical Claude Code output without burning capture-pane
 *  buffer time. Per ADR-167 §Pre-flight gate matrix row 2: "last 60s". */
const CAPTURE_PANE_LINES = 200;

/** NDJSON audit-log location per ADR-167 §Audit log. Operator-fired
 *  rotation → growth is bounded; v1 has no rotation policy (per OQ-6). */
const AUDIT_LOG_RELATIVE = ".atmux/state/cockpit-rotate-audit.log";

/** Per-role session-start marker location per ADR-167 §OQ-1.
 *  `~/.claude/teams/__cockpit__/<role>/session-start.txt`. */
function sessionStartMarkerPath(homeDir: string, role: RoleId): string {
  return join(homeDir, ".claude/teams/__cockpit__", role, "session-start.txt");
}

/** Canonical audit-log path (constructed from homeDir for testability). */
function auditLogPath(homeDir: string): string {
  return join(homeDir, AUDIT_LOG_RELATIVE);
}

/** Parse `cockpit rotate` argv. The positional `<session-name>` is
 *  required; `--force` is the only flag. Unknown flags / extra
 *  positionals throw UsageError → exit 64. */
export function parseCockpitRotateArgs(args: ReadonlyArray<string>): ParsedCockpitRotateArgs {
  let sessionName: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    switch (a) {
      case "--force":
        force = true;
        break;
      default:
        if (a.startsWith("-")) {
          throw new UsageError({
            what: `cockpit rotate: unknown arg: ${a}`,
            hint: "usage: atmux cockpit rotate <medic|sentinel|<team-name>> [--force]",
          });
        }
        if (sessionName !== undefined) {
          throw new UsageError({
            what: `cockpit rotate: unexpected positional arg: ${a}`,
            hint: "only one <session-name> accepted",
          });
        }
        sessionName = a;
    }
  }

  if (sessionName === undefined || sessionName.length === 0) {
    throw new UsageError({
      what: "cockpit rotate: missing <session-name>",
      hint: "usage: atmux cockpit rotate <medic|sentinel|<team-name>> [--force]",
    });
  }

  return { sessionName, force };
}

/** Per-role respawn-path discriminator. `medic` + `sentinel` are
 *  dedicated cockpit roles (W2 + W3 per ADR-135 + ADR-158); anything
 *  else is a team-name → per-team driver pane (W4+). Lead panes are
 *  out of scope — they live in the team cage per ADR-162. */
export type RoleId = "medic" | "sentinel" | "team-driver";

export function classifyRole(sessionName: string): RoleId {
  if (sessionName === "medic") return "medic";
  if (sessionName === "sentinel") return "sentinel";
  return "team-driver";
}

/** Resolve the cockpit window name for a given role + session-name. The
 *  medic + sentinel roles map to fixed `_medic` + `_sentinel` windows
 *  (ADR-135 `_-prefix` convention); team-driver maps to the team's bare
 *  cockpit viewer window (e.g. `atmux`, `sopx`). Joined to the cockpit
 *  session via `<session>:<window>`. */
export function targetWindowForRole(role: RoleId, sessionName: string): string {
  switch (role) {
    case "medic":
      return "_medic";
    case "sentinel":
      return "_sentinel";
    case "team-driver":
      // sessionName here is the team-name passed as the verb arg.
      return sessionName;
  }
}

// ---------- Pre-flight gates: pure classifiers ----------
//
// Each `classifyGateN` takes its input as a pure value (already-fetched
// text or mtime + current time) and returns the structured refusal
// reason — or null if the gate passes. IO happens in `runPreFlightGates`
// below, which composes capture / stat / clock with the pure classifier.

/** Gate 1 — user-not-typing. Refuses when the cockpit `_superdriver`
 *  compose-box is TYPING. Reuses src/core/pane-state.ts (ADR-155) so
 *  the classifier definition stays in one place. */
export function classifyGate1(superdriverCapture: string): string | null {
  const cls = classifyText(superdriverCapture);
  if (cls.state === "TYPING") {
    return `superdriver compose-box has queued text — operator may be about to reference target panes`;
  }
  return null;
}

/** Gate 2 — pane-idle. Refuses when the target pane is BUSY or
 *  COMPACTING (per ADR-167 §Pre-flight gate matrix row 2: refuse on
 *  `✽` / `✻` / `Compacting` markers). */
export function classifyGate2(targetPaneCapture: string): string | null {
  const cls = classifyText(targetPaneCapture);
  if (GATE_2_REFUSE_STATES.has(cls.state)) {
    return `target pane is ${cls.state} (mid-turn marker present); refusing to rotate mid-flight`;
  }
  return null;
}

/** Gate 3 — uptime. Refuses when the per-role session-start marker is
 *  `<60min` old (premature rotation = lost context). A missing marker
 *  also refuses — the operator should establish the marker via the
 *  cockpit-pane spawner before invoking rotate (per ADR-167
 *  §Consequences "per-role marker location"). */
export function classifyGate3(mtimeMs: number | null, nowMs: number): string | null {
  if (mtimeMs === null) {
    return `session-start marker missing or unreadable — cannot verify uptime (--force to bypass)`;
  }
  const ageMin = (nowMs - mtimeMs) / 60_000;
  if (ageMin < GATE_3_UPTIME_MIN_MIN) {
    return `pane uptime ${ageMin.toFixed(1)}min < ${GATE_3_UPTIME_MIN_MIN}min minimum (--force to bypass)`;
  }
  return null;
}

// ---------- Refusal emit (audit + Discord) ----------

/** ADR-167 §Audit log row schema. NDJSON one-row-per-rotation-attempt;
 *  refusal rows are written at gate-refusal site, success rows at
 *  respawn-end. */
export interface CockpitRotateAuditRow {
  ts: string;
  role: RoleId;
  sessionName: string;
  outcome: AuditOutcome;
  durationMs: number;
  callerScope: "driver" | "member";
  error?: string;
  handoffPath?: string;
}

export type AuditOutcome =
  | "success"
  | "gate-1-refused"
  | "gate-2-refused"
  | "gate-3-refused"
  | "gate-4-refused"
  | "respawn-failed"
  | "handoff-write-failed";

/** Serialize an audit row to a single NDJSON line (trailing newline
 *  included). Pure — `appendText` callers compose IO. */
export function serializeAuditRow(row: CockpitRotateAuditRow): string {
  return `${JSON.stringify(row)}\n`;
}

// ---------- Verb entry ----------

/** Test-injection seams for the rotate verb. Production code passes no
 *  opts → defaults to real IO. */
export interface CockpitRotateOpts {
  env?: NodeJS.ProcessEnv;
  callerScope?: () => string;
  stderr?: (msg: string) => void;
  /** Inject the wall-clock. Defaults to `time.now`. Tests inject
   *  monotonic counters for deterministic durationMs / gate-3 mtime
   *  arithmetic. */
  nowMs?: () => number;
  /** Override `HOME` resolution for session-start marker + audit-log
   *  path. Defaults to `env.HOME ?? "/root"`. */
  homeDir?: string;
  /** Cockpit session-name; gate-1 reads `<session>:_superdriver` and
   *  gate-2 reads `<session>:<target-window>`. Default
   *  `atmux_cockpit` (ADR-135 §D5 post-rename canonical). */
  cockpitSessionName?: string;
  /** Cockpit tmux socket name (used by `createTmux({socket})`). Default
   *  resolves via `getCockpitSocketName(env)` per ADR-162. */
  cockpitSocketName?: string;
  /** Tmux namespace factory; tests inject a stub with capturePane
   *  returning canned strings. Default: real `createTmux`. */
  tmuxFactory?: (cfg: TmuxConfig) => TmuxNamespace;
  /** Stat seam for gate-3 mtime read. Default `statOrNull` (returns
   *  null on ENOENT). */
  stat?: (path: string) => Promise<{ mtimeMs: number } | null>;
  /** NDJSON audit-log appender. Default: `fs.appendText`. */
  appendText?: (path: string, content: string) => Promise<void>;
  /** Discord send seam. Default: `discord.send`. Tests inject a recorder
   *  to assert the refusal template fires. Errors swallow — Discord
   *  visibility is non-fatal (the audit row is the source of truth). */
  discordSend?: (opts: DiscordSendOpts) => Promise<void>;
  /** Override the team identifier in Discord refusal pings. Default
   *  `"atmux"` — cockpit rotation is cockpit-scoped, not per-team. */
  discordTeam?: string;
  /** Cockpit-config loader seam (T4 t-a245bbc8). Default reads + parses
   *  `~/.atmux/cockpit.json` via `core/cockpit.loadCockpit`. Tests
   *  inject a synthesized `LoadedCockpit` to assert per-role
   *  claudeAccount + tuiOverrides flow without touching disk. */
  loadCockpit?: (opts?: LoadCockpitOpts) => Promise<LoadedCockpit>;
  /** Verified send-keys seam (T4 t-a245bbc8). Used to fire Ctrl-C at
   *  the target pane with a verifier that the claude TUI exited. Default
   *  delegates to `src/core/safe-send.ts::safeSendKeysWithVerify` with
   *  tmux capture / sendKeys adapters around the cockpit socket. */
  safeSendKeysWithVerify?: typeof safeSendKeysWithVerifyDefault;
  /** Medic cadence re-arm seam (T4 t-a245bbc8). Default delegates to
   *  `autoStartSuperdoctorLoop` (mirrors cockpit rebuild's auto-start).
   *  Returns void; errors are swallowed inside the default impl (non-
   *  fatal — operator falls back to manual `/loop /medic` if the marker
   *  isn't detected within the timeout). */
  autoStartMedicLoop?: typeof autoStartSuperdoctorLoopDefault;
  /** Sentinel cadence re-arm seam (T4 t-a245bbc8). Same shape + posture
   *  as `autoStartMedicLoop`. Skipped at the call site for cursor-impl
   *  sentinels (per ADR-132 §D4 — no claude TUI to re-arm). */
  autoStartSentinelLoop?: typeof autoStartSentinelLoopDefault;
  /** Logger seam for the re-arm helpers (T4 t-a245bbc8). Default
   *  forwards via stderr; tests inject a recorder to assert the post-
   *  spawn cadence sequence. The autoStart helpers tag every log line
   *  themselves; this seam is a passthrough. Full `Logger` interface
   *  (log/ok/warn/err) per src/core/tui.ts so the autoStart helpers
   *  can call any method without type widening at the call site. */
  cadenceLogger?: Logger;
  /** Auto-start settle timeout (ms) for the re-arm helpers. Default
   *  30_000 — matches cockpit rebuild's `autoStartTimeoutSec=30`. Tests
   *  pass `0` so the helper bails immediately after pane readiness
   *  check. */
  autoStartTimeoutMs?: number;
}

interface ResolvedDeps {
  env: NodeJS.ProcessEnv;
  callerScope: () => string;
  stderr: (msg: string) => void;
  nowMs: () => number;
  homeDir: string;
  cockpitSessionName: string;
  cockpitSocketName: string;
  tmuxFactory: (cfg: TmuxConfig) => TmuxNamespace;
  stat: (path: string) => Promise<{ mtimeMs: number } | null>;
  appendText: (path: string, content: string) => Promise<void>;
  discordSend: (opts: DiscordSendOpts) => Promise<void>;
  discordTeam: string;
  loadCockpit: (opts?: LoadCockpitOpts) => Promise<LoadedCockpit>;
  safeSendKeysWithVerify: typeof safeSendKeysWithVerifyDefault;
  autoStartMedicLoop: typeof autoStartSuperdoctorLoopDefault;
  autoStartSentinelLoop: typeof autoStartSentinelLoopDefault;
  cadenceLogger: Logger;
  autoStartTimeoutMs: number;
}

function resolveDeps(opts: CockpitRotateOpts): ResolvedDeps {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? env.HOME ?? "/root";
  const stderr = opts.stderr ?? ((msg: string) => process.stderr.write(msg));
  return {
    env,
    callerScope: opts.callerScope ?? (() => resolveCallerScope({ env })),
    stderr,
    nowMs: opts.nowMs ?? nowMsDefault,
    homeDir,
    cockpitSessionName: opts.cockpitSessionName ?? COCKPIT_SESSION_DEFAULT,
    cockpitSocketName: opts.cockpitSocketName ?? getCockpitSocketName(env),
    tmuxFactory: opts.tmuxFactory ?? createTmux,
    stat: opts.stat ?? statOrNull,
    appendText: opts.appendText ?? appendTextDefault,
    discordSend: opts.discordSend ?? discordSendDefault,
    discordTeam: opts.discordTeam ?? "atmux",
    loadCockpit: opts.loadCockpit ?? loadCockpitDefault,
    safeSendKeysWithVerify: opts.safeSendKeysWithVerify ?? safeSendKeysWithVerifyDefault,
    autoStartMedicLoop: opts.autoStartMedicLoop ?? autoStartSuperdoctorLoopDefault,
    autoStartSentinelLoop: opts.autoStartSentinelLoop ?? autoStartSentinelLoopDefault,
    cadenceLogger: opts.cadenceLogger ?? {
      log: (msg: string) => stderr(`${msg}\n`),
      ok: (msg: string) => stderr(`${msg}\n`),
      warn: (msg: string) => stderr(`${msg}\n`),
      err: (msg: string) => stderr(`${msg}\n`),
    },
    autoStartTimeoutMs: opts.autoStartTimeoutMs ?? 30_000,
  };
}

/** Capture a cockpit-session pane's last N lines via the cockpit socket.
 *  Returns the captured text or empty string if the capture fails (tmux
 *  not running, window missing — gate-1/2 then pass on the empty text,
 *  which is the safer default than crashing the verb on a misconfigured
 *  cockpit). */
async function safeCapturePane(deps: ResolvedDeps, windowName: string): Promise<string> {
  try {
    const tmux = deps.tmuxFactory({ socket: deps.cockpitSocketName });
    return await tmux.pane.capturePane({
      target: `${deps.cockpitSessionName}:${windowName}`,
      start: -CAPTURE_PANE_LINES,
    });
  } catch {
    return "";
  }
}

/** Build + emit a refusal audit-row + best-effort Discord ping. Both
 *  emissions are swallow-on-error — observability is non-fatal. */
async function emitRefusal(
  deps: ResolvedDeps,
  args: {
    role: RoleId;
    sessionName: string;
    outcome: AuditOutcome;
    durationMs: number;
    error: string;
    gate:
      | "gate-1-user-not-typing"
      | "gate-2-pane-idle"
      | "gate-3-uptime"
      | "gate-4-never-rotate-superdriver";
    force: boolean;
  },
): Promise<void> {
  const tsIso = new Date(deps.nowMs()).toISOString();
  const callerScope = deps.callerScope() === "driver" ? "driver" : "member";
  const row: CockpitRotateAuditRow = {
    ts: tsIso,
    role: args.role,
    sessionName: args.sessionName,
    outcome: args.outcome,
    durationMs: args.durationMs,
    callerScope,
    error: args.error,
  };
  try {
    await deps.appendText(auditLogPath(deps.homeDir), serializeAuditRow(row));
  } catch {
    // Observability is non-fatal — refusal is already surfaced via
    // stderr + exit code; the operator can re-run with --force.
  }
  try {
    const renderArgs: CockpitRotateRefusedOpts = {
      team: deps.discordTeam,
      sessionName: args.sessionName,
      gate: args.gate,
      reason: args.error,
      force: args.force,
      whenMs: deps.nowMs(),
    };
    await deps.discordSend(renderCockpitRotateRefused(renderArgs));
  } catch {
    // Discord is best-effort — never block the verb on the webhook.
  }
}

// ---------- T4: respawn-path helpers ----------

/** Pane-state verifier used after Ctrl-C: returns true when the claude
 *  TUI is no longer visible (no `❯` compose prompt, no `✻`/`✽` thinking
 *  spinners, no `Compacting conversation` banner). Slot into the safe-
 *  send retry loop via {@link sendCtrlCWithVerify}; exported for direct
 *  unit testing of the regex contract. */
export const claudeUiGoneVerifier: PaneVerifier = (text: string) =>
  !/❯|Cooked|Schlepping|Honking|Compacting/.test(text);

/** Build the claude-respawn shell command for medic + sentinel-claude.
 *  Invokes the c-alias wrapper by name (per ADR-167 §Decision wrapper
 *  resolver) so the wrapper's shell init exports the canonical c-alias
 *  env (CLAUDE_CONFIG_DIR + CLAUDECODE + CLAUDE_CODE_EFFORT_LEVEL +
 *  CLAUDE_GUARD_AGENT) before exec'ing claude. Unknown configDir
 *  throws ConfigError (refused upstream of any pane mutation).
 *
 *  Differs from cockpit rebuild's `buildClaudeWindowCommand` (which
 *  uses an inline env-set + bare `claude` binary): rotate respawn
 *  honors the literal ADR-167 spec text + lets fe-2's T7 hermetic
 *  fixtures exercise the resolver by stubbing the wrapper name on
 *  PATH (Plan A per the T6/T7 design handoff). */
export function buildClaudeRespawnCommand(
  account: CockpitClaudeAccount | undefined,
  tuiOverrides: CockpitTuiOverrides | undefined,
): string {
  const configDir = account?.configDir ?? "/root/.claude";
  const wrapper = resolveClaudeWrapper(configDir);
  const permission = tuiOverrides?.permissionMode ?? "auto";
  const pluginFlag =
    tuiOverrides?.pluginDir !== undefined ? ` --plugin-dir=${tuiOverrides.pluginDir}` : "";
  // CLAUDE_GUARD_AGENT explicit on the line (the wrapper exports it
  // too, but belt-and-suspenders matches global CLAUDE.md §Spawn
  // Pattern verbatim).
  return `CLAUDE_GUARD_AGENT=1 ${wrapper}${pluginFlag} --permission-mode ${permission} --model claude-opus-4-7`;
}

/** Emit a success-outcome audit row. Mirrors `emitRefusal` but without
 *  the Discord ping — success is quiet (Discord noise budget is
 *  reserved for refusals + p0-class incidents). The audit row is the
 *  source of truth for post-incident "when did medic last rotate?"
 *  forensics. */
async function emitSuccess(
  deps: ResolvedDeps,
  args: {
    role: RoleId;
    sessionName: string;
    durationMs: number;
    handoffPath?: string;
  },
): Promise<void> {
  const tsIso = new Date(deps.nowMs()).toISOString();
  const callerScope = deps.callerScope() === "driver" ? "driver" : "member";
  const row: CockpitRotateAuditRow = {
    ts: tsIso,
    role: args.role,
    sessionName: args.sessionName,
    outcome: "success",
    durationMs: args.durationMs,
    callerScope,
  };
  if (args.handoffPath !== undefined) row.handoffPath = args.handoffPath;
  try {
    await deps.appendText(auditLogPath(deps.homeDir), serializeAuditRow(row));
  } catch {
    // Observability is non-fatal — respawn already succeeded. Operator
    // can re-grep tmux server state to verify the new pane.
  }
}

/** Emit a respawn-failure audit row (NDJSON). No Discord — respawn
 *  failures are surfaced via stderr + exit 70; the audit row carries
 *  forensic detail for post-incident analysis. */
async function emitRespawnFailure(
  deps: ResolvedDeps,
  args: {
    role: RoleId;
    sessionName: string;
    durationMs: number;
    error: string;
  },
): Promise<void> {
  const tsIso = new Date(deps.nowMs()).toISOString();
  const callerScope = deps.callerScope() === "driver" ? "driver" : "member";
  const row: CockpitRotateAuditRow = {
    ts: tsIso,
    role: args.role,
    sessionName: args.sessionName,
    outcome: "respawn-failed",
    durationMs: args.durationMs,
    callerScope,
    error: args.error,
  };
  try {
    await deps.appendText(auditLogPath(deps.homeDir), serializeAuditRow(row));
  } catch {
    // Observability is non-fatal — exit code + stderr already surface
    // the failure to the operator.
  }
}

/** Send Ctrl-C to the target pane with the claude-UI-gone verifier
 *  (3s grace per ADR-167 §Per-role respawn matrix step 3). The HUP
 *  fallback in ADR-167 is implicit in the subsequent `killWindow` call
 *  — tmux delivers SIGHUP to the pane's process group on kill, so a
 *  C-c-resistant claude process gets HUP'd anyway. The verifier
 *  outcome is logged but not gating (we kill the pane regardless to
 *  reach the desired end-state). */
async function sendCtrlCWithVerify(
  deps: ResolvedDeps,
  windowName: string,
  role: RoleId,
): Promise<{ success: boolean; attempts: number }> {
  const tmux = deps.tmuxFactory({ socket: deps.cockpitSocketName });
  const paneTarget: Target = `${deps.cockpitSessionName}:${windowName}`;
  const sendTarget: SendTarget = {
    kind: "member",
    member: role,
    team: deps.cockpitSessionName,
    target: paneTarget,
  };
  const captureFn: CaptureFn = (t: string) => tmux.pane.capturePane({ target: t });
  const sendKeysFn: SendKeysFn = async (_t: string, text: string) => {
    await tmux.pane.sendKeys({
      target: sendTarget,
      keys: text,
      enter: false,
    });
  };
  const result = await deps.safeSendKeysWithVerify({
    target: paneTarget as string,
    keys: "C-c",
    expectVerifier: claudeUiGoneVerifier,
    timeoutMs: 3000,
    retries: 0,
    onFail: "escalate",
    capture: captureFn,
    sendKeys: sendKeysFn,
  });
  return { success: result.success, attempts: result.attempts };
}

/** Resolve the cockpit's per-role config block (claudeAccount +
 *  tuiOverrides) for medic / sentinel from `LoadedCockpit`. Returns
 *  null when the block isn't declared — the caller defaults to the
 *  bare-`claude` wrapper resolution (`/root/.claude` → `claude`). */
function readMedicConfig(cockpit: LoadedCockpit): CockpitMedic | null {
  return cockpit.medic ?? null;
}
function readSentinelConfig(cockpit: LoadedCockpit): CockpitSentinel | null {
  return cockpit.sentinel ?? null;
}
function readTeamConfig(cockpit: LoadedCockpit, teamName: string): CockpitTeam | null {
  return cockpit.teams.find((t) => t.name === teamName) ?? null;
}

/** Per-role respawn flow: kill the target window, build the per-role
 *  command, new-window, re-arm cadence, emit success audit row.
 *  Returns the verb's exit code. */
async function performRespawn(
  deps: ResolvedDeps,
  role: RoleId,
  parsed: ParsedCockpitRotateArgs,
  startMs: number,
): Promise<number> {
  // TODO(T5 t-fe3464df): assemble role-specific handoff payload +
  //   atomic-write to ~/.claude/teams/__cockpit__/<role>/handoff.md
  //   per ADR-167 §Ordering invariant (handoff write lands BEFORE
  //   Ctrl-C so the rotation is re-traceable if a later step crashes).
  //   T4 leaves the placeholder here; T5 wires the real payload.

  const windowName = targetWindowForRole(role, parsed.sessionName);
  let cmd: string;
  let cockpit: LoadedCockpit;
  try {
    cockpit = await deps.loadCockpit({ home: deps.homeDir });
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    deps.stderr(
      `cockpit rotate: loadCockpit failed (${cause}); cannot resolve claudeAccount for respawn\n`,
    );
    await emitRespawnFailure(deps, {
      role,
      sessionName: parsed.sessionName,
      durationMs: deps.nowMs() - startMs,
      error: `loadCockpit: ${cause}`,
    });
    return EX_SOFTWARE;
  }

  // Build the respawn command. resolveClaudeWrapper throws ConfigError
  // on unknown configDir — caught here + converted to a respawn-failed
  // audit row so the operator sees a single failure mode (exit 70 +
  // structured stderr + audit row) instead of a raw stack trace.
  try {
    switch (role) {
      case "medic": {
        const m = readMedicConfig(cockpit);
        cmd = buildClaudeRespawnCommand(m?.claudeAccount, m?.tuiOverrides);
        break;
      }
      case "sentinel": {
        const s = readSentinelConfig(cockpit);
        // Cursor-impl sentinel: spawn line is the sentinel verb's bash
        // loop (no claude TUI, no wrapper resolution needed). Reuses
        // cockpit's existing builder for byte-equivalence with rebuild.
        if (s !== null && s.impl === "cursor") {
          cmd = buildSentinelWindowCommand(s);
        } else {
          // Claude-impl sentinel (or undeclared → default to claude
          // wrapper): build the c-alias respawn line.
          const acc = s !== null && s.impl === "claude" ? s.claudeAccount : undefined;
          const ov = s !== null && s.impl === "claude" ? s.tuiOverrides : undefined;
          cmd = buildClaudeRespawnCommand(acc, ov);
        }
        break;
      }
      case "team-driver": {
        const t = readTeamConfig(cockpit, parsed.sessionName);
        if (t === null) {
          const err = `team '${parsed.sessionName}' not found in cockpit.json`;
          deps.stderr(`cockpit rotate: ${err}\n`);
          await emitRespawnFailure(deps, {
            role,
            sessionName: parsed.sessionName,
            durationMs: deps.nowMs() - startMs,
            error: err,
          });
          return EX_SOFTWARE;
        }
        // Team-driver cockpit window is the cage-attach retry loop (per
        // ADR-162); it does NOT spawn a claude TUI. The c-alias wrapper
        // resolver is therefore skipped at this branch — the wrapper
        // table doesn't apply to the cageRetryLoop bash. The team's
        // claudeAccount field rides through cockpit.json for other
        // consumers (cockpit rebuild's lead-pane spawn inside the
        // cage) and is intentionally untouched here.
        cmd = buildTeamWindowCommand(t, "attach");
        break;
      }
    }
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    deps.stderr(`cockpit rotate: respawn command build failed (${cause})\n`);
    await emitRespawnFailure(deps, {
      role,
      sessionName: parsed.sessionName,
      durationMs: deps.nowMs() - startMs,
      error: cause,
    });
    return EX_SOFTWARE;
  }

  // Send Ctrl-C to give claude (or the bash loop) a chance to flush
  // state before kill. Verifier outcome is informational; kill-window
  // is the destructive primitive that guarantees the pane is gone.
  await sendCtrlCWithVerify(deps, windowName, role);

  const tmux = deps.tmuxFactory({ socket: deps.cockpitSocketName });
  try {
    await tmux.window.killWindow(`${deps.cockpitSessionName}:${windowName}`);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    deps.stderr(`cockpit rotate: kill-window failed (${cause})\n`);
    await emitRespawnFailure(deps, {
      role,
      sessionName: parsed.sessionName,
      durationMs: deps.nowMs() - startMs,
      error: `killWindow: ${cause}`,
    });
    return EX_SOFTWARE;
  }

  let windowIndex: number;
  try {
    const winId = await tmux.window.newWindow({
      sessionName: deps.cockpitSessionName,
      name: windowName,
      detached: true,
      shellCommand: cmd,
    });
    windowIndex = winId.windowIndex;
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    deps.stderr(`cockpit rotate: new-window failed (${cause})\n`);
    await emitRespawnFailure(deps, {
      role,
      sessionName: parsed.sessionName,
      durationMs: deps.nowMs() - startMs,
      error: `newWindow: ${cause}`,
    });
    return EX_SOFTWARE;
  }

  // Re-arm role-specific cadence. Non-fatal — the auto-start helpers
  // log + return on failure (the operator falls back to manual
  // `/loop /medic` or `/loop /sentinel`). Team-driver respawn has no
  // cadence to re-arm (cageRetryLoop runs in the shell itself).
  switch (role) {
    case "medic":
      try {
        await deps.autoStartMedicLoop({
          tmux,
          sessionName: deps.cockpitSessionName,
          windowIndex,
          timeoutMs: deps.autoStartTimeoutMs,
          logger: deps.cadenceLogger,
        });
      } catch {
        // autoStart is non-fatal by construction; defensive catch in
        // case a future refactor raises.
      }
      break;
    case "sentinel": {
      const s = readSentinelConfig(cockpit);
      // ADR-132 §D4 discriminated narrowing: only the claude variant
      // gets the post-spawn /loop /sentinel injection. The cursor
      // variant's bash loop is self-starting (the verb IS the loop).
      if (s === null || s.impl === "claude") {
        try {
          await deps.autoStartSentinelLoop({
            tmux,
            sessionName: deps.cockpitSessionName,
            windowIndex,
            timeoutMs: deps.autoStartTimeoutMs,
            logger: deps.cadenceLogger,
          });
        } catch {
          // Non-fatal — see medic branch.
        }
      }
      break;
    }
    case "team-driver":
      // No cadence re-arm — cageRetryLoop is the loop itself.
      break;
  }

  await emitSuccess(deps, {
    role,
    sessionName: parsed.sessionName,
    durationMs: deps.nowMs() - startMs,
  });
  return EX_OK;
}

/** Top-level entry. Returns numeric exit code per ADR-167. Ordering:
 *  parser → gate-4 (cheapest + unconditional) → caller-scope (ADR-033)
 *  → gates 1-3 (with --force bypass) → role classifier → respawn
 *  dispatch (T4 stub). */
export async function cockpitRotate(
  args: ReadonlyArray<string>,
  opts: CockpitRotateOpts = {},
): Promise<number> {
  const parsed = parseCockpitRotateArgs(args);
  const deps = resolveDeps(opts);
  const startMs = deps.nowMs();

  // Gate 4 — never-rotate-superdriver. Fires first; --force does NOT
  // bypass (per ADR-167 §Pre-flight gate matrix row 4 bypass column).
  if (RESERVED_NEVER_ROTATE.has(parsed.sessionName)) {
    const reason = `'${parsed.sessionName}' is the operator REPL pane — rotation is unconditionally refused`;
    deps.stderr(`gate-4-never-rotate-superdriver: ${reason}\n`);
    await emitRefusal(deps, {
      // gate-4 hits before role classification (the session-name IS the
      // role discriminator); record `team-driver` as a defensive default
      // — the audit row's `sessionName: "superdriver"` is the load-
      // bearing field for post-incident filtering.
      role: "team-driver",
      sessionName: parsed.sessionName,
      outcome: "gate-4-refused",
      durationMs: deps.nowMs() - startMs,
      error: reason,
      gate: "gate-4-never-rotate-superdriver",
      force: parsed.force,
    });
    return EX_DATAERR;
  }

  // Caller-scope gate per ADR-033. ConfigError → exit 78 (EX_CONFIG)
  // via exitCodeForTag, matching spawn-epic / dissolve-epic pattern.
  if (deps.callerScope() !== "driver") {
    throw new ConfigError({
      what:
        "cockpit rotate: refused — caller scope is not 'driver'. " +
        "Set ATMUX_CALLER_SCOPE=driver in the calling shell (ADR-033 §Caller-scope gate).",
      hint: "from a driver pane: ATMUX_CALLER_SCOPE=driver atmux cockpit rotate <session-name>",
    });
  }

  const role = classifyRole(parsed.sessionName);

  // Pre-flight gates 1-3. Each refusal exits 65 with structured stderr
  // `gate-N-<name>: <reason>`. --force bypasses these (per ADR-167
  // §Pre-flight gate matrix bypass column for rows 1-3).
  if (!parsed.force) {
    // Gate 1 — user-not-typing on cockpit `_superdriver` pane.
    const sd = await safeCapturePane(deps, "_superdriver");
    const r1 = classifyGate1(sd);
    if (r1 !== null) {
      deps.stderr(`gate-1-user-not-typing: ${r1}\n`);
      await emitRefusal(deps, {
        role,
        sessionName: parsed.sessionName,
        outcome: "gate-1-refused",
        durationMs: deps.nowMs() - startMs,
        error: r1,
        gate: "gate-1-user-not-typing",
        force: parsed.force,
      });
      return EX_DATAERR;
    }

    // Gate 2 — pane-idle on the target window.
    const targetWindow = targetWindowForRole(role, parsed.sessionName);
    const target = await safeCapturePane(deps, targetWindow);
    const r2 = classifyGate2(target);
    if (r2 !== null) {
      deps.stderr(`gate-2-pane-idle: ${r2}\n`);
      await emitRefusal(deps, {
        role,
        sessionName: parsed.sessionName,
        outcome: "gate-2-refused",
        durationMs: deps.nowMs() - startMs,
        error: r2,
        gate: "gate-2-pane-idle",
        force: parsed.force,
      });
      return EX_DATAERR;
    }

    // Gate 3 — uptime on the per-role session-start marker.
    const markerPath = sessionStartMarkerPath(deps.homeDir, role);
    let mtimeMs: number | null = null;
    try {
      const st = await deps.stat(markerPath);
      mtimeMs = st === null ? null : st.mtimeMs;
    } catch {
      mtimeMs = null;
    }
    const r3 = classifyGate3(mtimeMs, deps.nowMs());
    if (r3 !== null) {
      deps.stderr(`gate-3-uptime: ${r3}\n`);
      await emitRefusal(deps, {
        role,
        sessionName: parsed.sessionName,
        outcome: "gate-3-refused",
        durationMs: deps.nowMs() - startMs,
        error: r3,
        gate: "gate-3-uptime",
        force: parsed.force,
      });
      return EX_DATAERR;
    }
  }

  // Per-role respawn matrix (T4 t-a245bbc8). Each path:
  //   1. (T5 t-fe3464df placeholder): assemble + atomic-write handoff.
  //   2. safeSendKeysWithVerify Ctrl-C (ADR-138); 3s grace; HUP-via-
  //      killWindow fallback.
  //   3. tmux kill-window -t <cockpit_session>:<window>.
  //   4. Resolve claudeAccount wrapper (ADR-094 c-alias convention) +
  //      build per-role respawn command.
  //   5. tmux new-window with the respawn command.
  //   6. Re-arm role-specific cadence (per-role inline, per OQ-4).
  //   7. Append success audit row. Audit row writes AFTER respawn so
  //      `outcome` reflects ground truth (per ADR-167 §Ordering
  //      invariant).
  return performRespawn(deps, role, parsed, startMs);
}
