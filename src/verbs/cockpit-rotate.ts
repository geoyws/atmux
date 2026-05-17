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
import {
  type CockpitRotateRefusedOpts,
  type DiscordSendOpts,
  send as discordSendDefault,
  renderCockpitRotateRefused,
} from "../abstractions/discord.ts";
import { appendText as appendTextDefault, statOrNull } from "../abstractions/fs.ts";
import { now as nowMsDefault } from "../abstractions/time.ts";
import { createTmux, type TmuxConfig, type TmuxNamespace } from "../abstractions/tmux.ts";
import { resolveCallerScope } from "../core/common.ts";
import { classifyText, type PaneState } from "../core/pane-state.ts";
import { getCockpitSocketName } from "../core/tmux-paths.ts";
import { ConfigError, UsageError } from "../errors.ts";

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
}

function resolveDeps(opts: CockpitRotateOpts): ResolvedDeps {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? env.HOME ?? "/root";
  return {
    env,
    callerScope: opts.callerScope ?? (() => resolveCallerScope({ env })),
    stderr: opts.stderr ?? ((msg: string) => process.stderr.write(msg)),
    nowMs: opts.nowMs ?? nowMsDefault,
    homeDir,
    cockpitSessionName: opts.cockpitSessionName ?? COCKPIT_SESSION_DEFAULT,
    cockpitSocketName: opts.cockpitSocketName ?? getCockpitSocketName(env),
    tmuxFactory: opts.tmuxFactory ?? createTmux,
    stat: opts.stat ?? statOrNull,
    appendText: opts.appendText ?? appendTextDefault,
    discordSend: opts.discordSend ?? discordSendDefault,
    discordTeam: opts.discordTeam ?? "atmux",
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
  //   1. Assemble role-specific handoff payload (T5 t-fe3464df).
  //   2. Atomic-write handoff to ~/.claude/teams/__cockpit__/<role>/
  //      handoff.md (flock per ADR-005).
  //   3. safeSendKeysWithVerify Ctrl-C (ADR-138); 3s grace; HUP fallback.
  //   4. tmux kill-pane -t <cockpit_session>:<window>.
  //   5. Resolve claudeAccount wrapper (ADR-094 c-alias convention).
  //   6. Respawn via tmux new-window / respawn-window.
  //   7. Re-arm role-specific cadence (per-role inline, per OQ-4).
  //   8. Append success audit row to ~/.atmux/state/cockpit-rotate-audit
  //      .log. Audit row writes AFTER respawn so `outcome` reflects
  //      ground truth (per ADR-167 §Ordering invariant).
  switch (role) {
    case "medic":
      // TODO(T4 t-a245bbc8): medic respawn path. Handoff inputs (T5
      //   t-fe3464df): in-flight diagnosis state from src/verbs/medic.ts
      //   runtime + recent medic-source complaints (state.db
      //   complaints WHERE source_kind='medic' last N) + recent
      //   rotation calls (cockpit-rotate-audit.log WHERE role='medic'
      //   tail N).
      deps.stderr(`cockpit rotate: medic respawn — NOT IMPLEMENTED (T4 t-a245bbc8)\n`);
      return EX_SOFTWARE;
    case "sentinel":
      // TODO(T4 t-a245bbc8): sentinel respawn path. Handoff inputs (T5
      //   t-fe3464df): whip-classifier state snapshot + NudgeAction
      //   history (per-team sentinel logs tail N) + recent escalations
      //   (audit log filtered to sentinel-escalated rows).
      deps.stderr(`cockpit rotate: sentinel respawn — NOT IMPLEMENTED (T4 t-a245bbc8)\n`);
      return EX_SOFTWARE;
    case "team-driver":
      // TODO(T4 t-a245bbc8): team-driver respawn path. Handoff inputs
      //   (T5 t-fe3464df): recent tell-lead history (.atmux/lead-outbox
      //   .md or tells SQLite table tail N) + outbox state snapshot at
      //   rotation time. `parsed.sessionName` is the team-name; locate
      //   the W4+ cockpit window of that name.
      deps.stderr(
        `cockpit rotate: team-driver respawn for '${parsed.sessionName}' ` +
          `— NOT IMPLEMENTED (T4 t-a245bbc8)\n`,
      );
      return EX_SOFTWARE;
  }

  // Unreachable — classifyRole returns one of three literals; the
  // switch above is exhaustive. Replaced by a real success path in T4.
  return EX_OK;
}
