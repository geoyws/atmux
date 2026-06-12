// ADR-167: `atmux cockpit rotate <session-name>` — Rung C canonical
// rotation verb for cockpit-level role panes (medic / per-team driver).
// Closes the missing rung in /bruh's escalation chain (Rung A = member
// rotate, Rung B = lead rotate via medic, Rung C = this verb, Rung D =
// full cockpit rebuild).
//
// T2 (shipped c376f63): verb dispatch, parser, gate-4 (never-rotate-
// superdriver), caller-scope gate, role classifier, per-role respawn
// stubs.
//
// T3 (shipped 5245e39): gates 1-3 IO + classifier impl + NDJSON
// audit-row emit + Discord [cockpit-rotate-refused] emit at every
// gate-refusal site.
//
// T4 (shipped 771a104): per-role respawn matrix (medic / team-driver),
// c-alias wrapper resolver (load-bearing for medic; skipped for
// team-driver), Ctrl-C via safeSendKeysWithVerify, success NDJSON
// audit row + cadence re-arm via autoStartSuperdoctorLoop.
//
// T5 (this commit): handoff write-path. Assembles per-role Markdown
// payload (medic: audit-log rotation tail + placeholder state markers;
// team-driver: lead-outbox tail + audit-log rotation tail). Atomic-
// writes to `~/.claude/teams/__cockpit__/<role>/
// handoff.md` per ADR-167 §OQ-1 BEFORE Ctrl-C (§Ordering invariant —
// rotation is re-traceable if a later step crashes mid-flight). 100KB
// soft cap per ADR-167 OQ-2 with truncate-with-trailer. Handoff write
// failure → exit 70 + `handoff-write-failed` audit row + pane untouched.
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
import {
  appendText as appendTextDefault,
  atomicWrite as atomicWriteDefault,
  readTextOrNull,
  statOrNull,
} from "../abstractions/fs.ts";
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
  CockpitTeam,
  CockpitTuiOverrides,
} from "../schema/cockpit.ts";
import {
  autoStartSuperdoctorLoop as autoStartSuperdoctorLoopDefault,
  buildTeamWindowCommand,
} from "./cockpit.ts";

/** Parsed shape for `atmux cockpit rotate` argv. */
export interface ParsedCockpitRotateArgs {
  /** Canonical session-name: `medic` | `<team-name>`. */
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
            hint: "usage: atmux cockpit rotate <medic|<team-name>> [--force]",
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
      hint: "usage: atmux cockpit rotate <medic|<team-name>> [--force]",
    });
  }

  return { sessionName, force };
}

/** Per-role respawn-path discriminator. `medic` is the dedicated
 *  cockpit role (W2 per ADR-135); anything else is a team-name →
 *  per-team driver pane (W3+). Lead panes are out of scope — they
 *  live in the team cage per ADR-162. */
export type RoleId = "medic" | "team-driver";

export function classifyRole(sessionName: string): RoleId {
  if (sessionName === "medic") return "medic";
  return "team-driver";
}

/** Resolve the cockpit window name for a given role + session-name. The
 *  medic role maps to fixed `_medic` window (ADR-135 `_-prefix`
 *  convention); team-driver maps to the team's bare cockpit viewer
 *  window (e.g. `atmux`, `sopx`). Joined to the cockpit session via
 *  `<session>:<window>`. */
export function targetWindowForRole(role: RoleId, sessionName: string): string {
  switch (role) {
    case "medic":
      return "_medic";
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
  /** Read the audit-log file (entire body). Default reads via
   *  `fs.readTextOrNull` from `<homeDir>/.atmux/state/cockpit-rotate-
   *  audit.log`. Tests inject a recorder returning canned NDJSON for
   *  the handoff payload's `recent rotations` section. */
  readAuditLog?: (path: string) => Promise<string | null>;
  /** Read the lead-outbox tail for team-driver handoff. Default reads
   *  the last `lines` lines of `<atmuxDir>/lead-outbox.md`. The
   *  per-team `atmuxDir` is derived from the team's `root` in
   *  cockpit.json. */
  readLeadOutboxTail?: (atmuxDir: string, lines: number) => Promise<string>;
  /** Atomic write seam for the handoff payload. Default
   *  `fs.atomicWrite` (tmp + rename per ADR-005). Tests inject a
   *  recorder. */
  atomicWrite?: (path: string, content: string) => Promise<void>;
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
  cadenceLogger: Logger;
  autoStartTimeoutMs: number;
  readAuditLog: (path: string) => Promise<string | null>;
  readLeadOutboxTail: (atmuxDir: string, lines: number) => Promise<string>;
  atomicWrite: (path: string, content: string) => Promise<void>;
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
    cadenceLogger: opts.cadenceLogger ?? {
      log: (msg: string) => stderr(`${msg}\n`),
      ok: (msg: string) => stderr(`${msg}\n`),
      warn: (msg: string) => stderr(`${msg}\n`),
      err: (msg: string) => stderr(`${msg}\n`),
    },
    autoStartTimeoutMs: opts.autoStartTimeoutMs ?? 30_000,
    readAuditLog: opts.readAuditLog ?? readTextOrNull,
    readLeadOutboxTail: opts.readLeadOutboxTail ?? defaultReadLeadOutboxTail,
    atomicWrite: opts.atomicWrite ?? atomicWriteDefault,
  };
}

/** Default lead-outbox tail reader — mirrors src/core/fallback-brief.ts.
 *  Returns last `lines` lines of `<atmuxDir>/lead-outbox.md`, or empty
 *  when file missing. */
async function defaultReadLeadOutboxTail(atmuxDir: string, lines: number): Promise<string> {
  const path = join(atmuxDir, "lead-outbox.md");
  const text = await readTextOrNull(path);
  if (text === null || text.length === 0) return "";
  const all = text.split("\n");
  const start = Math.max(0, all.length - lines);
  return all.slice(start).join("\n");
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

// ---------- T5: handoff payload + atomic write ----------

/** Per-role handoff Markdown soft cap per ADR-167 OQ-2 — payloads
 *  larger than this are truncated with the trailer below. 100KB is
 *  brief-paste-ready (claude-code paste buffer + first-input quirks
 *  per ADR-081 stay well clear of this threshold); larger payloads
 *  are pathological. */
const HANDOFF_SOFT_CAP_BYTES = 100_000;

/** Trailer appended when truncation fires — operator gets a pointer
 *  to the audit log for the full inputs. */
const HANDOFF_TRUNCATION_TRAILER =
  "\n\n---\n*[truncated at 100KB; see audit log for full assembly inputs]*\n";

/** Per-role audit-log tail size — handoff renders the last-N rotation
 *  attempts for the same role. Bounded to keep handoffs small + brief-
 *  paste-ready. */
const HANDOFF_AUDIT_TAIL_N = 5;

/** Per-role lead-outbox tail size for team-driver handoff. Mirrors the
 *  fallback-brief reader convention (`50 lines` per ADR-050 brief
 *  generator step 5). */
const HANDOFF_LEAD_OUTBOX_TAIL_LINES = 50;

/** Resolve the per-role handoff payload path per ADR-167 §OQ-1.
 *  `~/.claude/teams/__cockpit__/<role>/handoff.md`. */
export function handoffPayloadPath(homeDir: string, role: RoleId): string {
  return join(homeDir, ".claude/teams/__cockpit__", role, "handoff.md");
}

/** Parse the cockpit-rotate audit log + return the last `n` rows
 *  matching `role`. Pure modulo IO (the read happens in the caller via
 *  `deps.readAuditLog`). Malformed lines are silently skipped — the
 *  audit log is best-effort observability, never a correctness gate. */
export function parseAuditTailForRole(
  ndjson: string | null,
  role: RoleId,
  n: number,
): CockpitRotateAuditRow[] {
  if (ndjson === null || ndjson.length === 0) return [];
  const matched: CockpitRotateAuditRow[] = [];
  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as CockpitRotateAuditRow;
      if (parsed.role === role) matched.push(parsed);
    } catch {
      // Skip malformed lines — corrupt audit-row entries do not
      // block handoff assembly.
    }
  }
  if (matched.length <= n) return matched;
  return matched.slice(matched.length - n);
}

/** Render a tail of audit rows as Markdown bullets. Each row → one
 *  line; readable in the brief-paste-ready handoff payload. */
function renderAuditTailMarkdown(rows: ReadonlyArray<CockpitRotateAuditRow>): string {
  if (rows.length === 0) {
    return "_no recent rotation attempts recorded_";
  }
  return rows
    .map((r) => {
      const errPart = r.error !== undefined ? ` — ${r.error}` : "";
      return `- \`${r.ts}\` · outcome=\`${r.outcome}\` · durationMs=${r.durationMs}${errPart}`;
    })
    .join("\n");
}

/** Truncate `text` to the soft cap, appending the truncation trailer
 *  when the cap fires. Byte-counted (UTF-8); markdown trailer survives
 *  truncation by reserving its byte count at the head. */
function softCapTruncate(text: string): { content: string; truncated: boolean } {
  const trailerBytes = Buffer.byteLength(HANDOFF_TRUNCATION_TRAILER, "utf8");
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= HANDOFF_SOFT_CAP_BYTES) {
    return { content: text, truncated: false };
  }
  const budget = HANDOFF_SOFT_CAP_BYTES - trailerBytes;
  const buf = Buffer.from(text, "utf8").subarray(0, Math.max(0, budget));
  // Avoid cutting mid-UTF-8 codepoint: re-decode + drop the final
  // partial code unit if any.
  const safeUtf8 = buf.toString("utf8");
  return { content: safeUtf8 + HANDOFF_TRUNCATION_TRAILER, truncated: true };
}

/** Compose the medic-role handoff Markdown per ADR-167 §Handoff
 *  payload schema. Heavy state-reads (in-flight diagnosis + complaints)
 *  are stubbed with placeholder markers — follow-up enrichment
 *  surfaces those once the medic state-snapshot helpers stabilize. */
function renderMedicHandoff(
  whenIso: string,
  recentRotations: ReadonlyArray<CockpitRotateAuditRow>,
): string {
  return [
    `# Medic handoff — ${whenIso}`,
    "",
    "## In-flight diagnosis state",
    "_not captured in v1 — follow-up enrichment per ADR-167 §Handoff payload schema_",
    "",
    "## Recent medic-sourced complaints",
    "_not captured in v1 — follow-up enrichment per ADR-167 §Handoff payload schema_",
    "",
    "## Recent rotation calls (audit log tail)",
    renderAuditTailMarkdown(recentRotations),
    "",
  ].join("\n");
}

/** Compose the team-driver handoff Markdown. Reads the team's lead-
 *  outbox tail (the per-team `<team-root>/.atmux/lead-outbox.md`
 *  convention) — the operator can re-establish driver context by
 *  pasting this section back into the respawned pane. */
function renderTeamDriverHandoff(
  whenIso: string,
  teamName: string,
  recentRotations: ReadonlyArray<CockpitRotateAuditRow>,
  leadOutboxTail: string,
): string {
  const outboxBlock =
    leadOutboxTail.length === 0
      ? "_no lead-outbox content available_"
      : `\`\`\`\n${leadOutboxTail}\n\`\`\``;
  return [
    `# Team-driver handoff — ${teamName} @ ${whenIso}`,
    "",
    "## Recent tell-lead history (lead-outbox tail)",
    outboxBlock,
    "",
    "## Outbox state snapshot",
    "_not captured in v1 — follow-up enrichment per ADR-167 §Handoff payload schema_",
    "",
    "## Recent rotation calls (audit log tail)",
    renderAuditTailMarkdown(recentRotations),
    "",
  ].join("\n");
}

/** Per-role handoff assembly. Reads the audit log tail + (for team-
 *  driver) the lead-outbox tail; composes the Markdown payload; applies
 *  the 100KB soft cap with truncate-with-trailer per ADR-167 OQ-2.
 *  Returns the rendered text + whether truncation fired (audit log
 *  caller can record truncation in the outcome row). */
async function assembleHandoffPayload(
  deps: ResolvedDeps,
  role: RoleId,
  sessionName: string,
  cockpit: LoadedCockpit,
): Promise<{ content: string; truncated: boolean }> {
  const whenIso = new Date(deps.nowMs()).toISOString();
  const auditLog = await deps.readAuditLog(auditLogPath(deps.homeDir));
  const recentRotations = parseAuditTailForRole(auditLog, role, HANDOFF_AUDIT_TAIL_N);

  let raw: string;
  switch (role) {
    case "medic":
      raw = renderMedicHandoff(whenIso, recentRotations);
      break;
    case "team-driver": {
      const team = cockpit.teams.find((t) => t.name === sessionName);
      const atmuxDir = team !== undefined ? join(team.root, ".atmux") : "";
      const outboxTail =
        atmuxDir.length > 0
          ? await deps.readLeadOutboxTail(atmuxDir, HANDOFF_LEAD_OUTBOX_TAIL_LINES)
          : "";
      raw = renderTeamDriverHandoff(whenIso, sessionName, recentRotations, outboxTail);
      break;
    }
  }
  return softCapTruncate(raw);
}

// ---------- T4: respawn-path helpers ----------

/** Pane-state verifier used after Ctrl-C: returns true when the claude
 *  TUI is no longer visible (no `❯` compose prompt, no `✻`/`✽` thinking
 *  spinners, no `Compacting conversation` banner). Slot into the safe-
 *  send retry loop via {@link sendCtrlCWithVerify}; exported for direct
 *  unit testing of the regex contract. */
export const claudeUiGoneVerifier: PaneVerifier = (text: string) =>
  !/❯|Cooked|Schlepping|Honking|Compacting/.test(text);

/** Build the claude-respawn shell command for medic.
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

/** Emit a handoff-write-failed audit row (NDJSON). No Discord — the
 *  handoff layer is observability + brief-paste-ready recovery, so a
 *  failed atomic write surfaces via exit 70 + stderr without paging
 *  the operator. The pane is intentionally NOT touched when the
 *  handoff write fails — recovery is "retry the verb" not "rotate
 *  blind". */
async function emitHandoffWriteFailed(
  deps: ResolvedDeps,
  args: {
    role: RoleId;
    sessionName: string;
    durationMs: number;
    error: string;
    handoffPath: string;
  },
): Promise<void> {
  const tsIso = new Date(deps.nowMs()).toISOString();
  const callerScope = deps.callerScope() === "driver" ? "driver" : "member";
  const row: CockpitRotateAuditRow = {
    ts: tsIso,
    role: args.role,
    sessionName: args.sessionName,
    outcome: "handoff-write-failed",
    durationMs: args.durationMs,
    callerScope,
    error: args.error,
    handoffPath: args.handoffPath,
  };
  try {
    await deps.appendText(auditLogPath(deps.homeDir), serializeAuditRow(row));
  } catch {
    // Observability is non-fatal — exit code + stderr surface the
    // failure. The pane is untouched (no rotation occurred); operator
    // re-runs the verb after addressing the underlying cause.
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
 *  tuiOverrides) for medic from `LoadedCockpit`. Returns null when
 *  the block isn't declared — the caller defaults to the bare-`claude`
 *  wrapper resolution (`/root/.claude` → `claude`). */
function readMedicConfig(cockpit: LoadedCockpit): CockpitMedic | null {
  return cockpit.medic ?? null;
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

  // T5: assemble + atomic-write the role-specific handoff payload
  // BEFORE Ctrl-C per ADR-167 §Ordering invariant. If the write fails,
  // the pane is intentionally NOT touched — recovery is "retry the
  // verb" not "rotate blind".
  const handoffPathResolved = handoffPayloadPath(deps.homeDir, role);
  try {
    const { content } = await assembleHandoffPayload(deps, role, parsed.sessionName, cockpit);
    await deps.atomicWrite(handoffPathResolved, content);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    deps.stderr(`cockpit rotate: handoff write failed (${cause})\n`);
    await emitHandoffWriteFailed(deps, {
      role,
      sessionName: parsed.sessionName,
      durationMs: deps.nowMs() - startMs,
      error: `atomicWrite: ${cause}`,
      handoffPath: handoffPathResolved,
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
        cmd = await buildTeamWindowCommand(t, "attach");
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
  // `/loop /medic`). Team-driver respawn has no cadence to re-arm
  // (cageRetryLoop runs in the shell itself).
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
    case "team-driver":
      // No cadence re-arm — cageRetryLoop is the loop itself.
      break;
  }

  await emitSuccess(deps, {
    role,
    sessionName: parsed.sessionName,
    durationMs: deps.nowMs() - startMs,
    handoffPath: handoffPathResolved,
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
