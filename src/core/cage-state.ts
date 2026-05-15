// Per c-8ecd3a61 / t-74273200: canonical 4-state cage-state taxonomy
// shared by `atmux status` + `atmux doctor`.
//
// Before this module landed, status.ts checked `pane_current_command`
// which is empty when a claude TUI is at the welcome screen — so the
// pane reported `(down)` even though `claude` was alive in the pane's
// process tree. The operator + driver got conflicting signals between
// `atmux status` (down) and `atmux doctor` (which already knew better
// via ADR-081 §D's per-member-cage probe).
//
// This module unifies the two probes under a single 4-state vocabulary:
//
//   down          — no tmux session OR pane window missing OR no
//                   `claude` exec in the pane's child-process tree.
//   bootstrapping — claude PID alive in the pane tree, but tokens have
//                   never moved (welcome banner, first-input pending,
//                   or fresh `/clear` mid-render).
//   active        — claude PID alive AND tokens have moved (the pane is
//                   demonstrably running a turn or has produced output).
//   wedged        — claude PID alive AND tokens have moved AT SOME
//                   POINT, but the pane is now stuck: rate-limit
//                   lockout, a heartbeat staler than the 2h ceiling,
//                   or a compaction that hasn't completed inside its
//                   own budget.
//
// `atmux status` surfaces the state per-member (text + JSON). `atmux
// doctor`'s `checkMemberCageStates` delegates to this probe and applies
// its existing yellow/silent row policy (down + wedged always yellow;
// bootstrapping yellow only above the ADR-081 §D staleness threshold;
// active silent).

import type { SpawnResult } from "../abstractions/spawn.ts";
import { spawn as defaultSpawn } from "../abstractions/spawn.ts";
import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import { now } from "../abstractions/time.ts";
import { defaultEmojiForRole, resolveTeamSocket } from "./common.ts";
import { readHeartbeat } from "./heartbeat.ts";
import { classifyText } from "./pane-state.ts";
import type { Team, TeamMember } from "../schema/team.ts";

// ---------- Public type ----------

/**
 * The canonical 4-state cage-state taxonomy per t-74273200 / c-8ecd3a61.
 *
 * Shared between `atmux status` + `atmux doctor` so the operator never
 * sees the two verbs disagreeing on a member's state. Doctor applies a
 * row-surfacing policy on top of this state (e.g. silent `bootstrapping`
 * for transient panes under the 60s `STARVING_THRESHOLD_S`); the state
 * label itself stays identical.
 */
export type CageState = "down" | "bootstrapping" | "active" | "wedged";

/**
 * Wedged-detection threshold — claude PID alive + tokens moved at some
 * point, but the supervisor's per-member heartbeat hasn't been written
 * (or refreshed) within `WEDGED_HEARTBEAT_STALE_SEC` seconds. Matches
 * the task body's "no whip activity >2h" criterion. When no heartbeat
 * file exists at all, the probe falls back on pane-classifier RATE-LIMIT
 * detection — the heartbeat write path is bash-side today (per
 * `core/heartbeat.ts` header) so the file-absent case is the common one.
 */
export const WEDGED_HEARTBEAT_STALE_SEC = 7200;

/**
 * Staleness threshold for the ADR-081 §D bootstrapping → "starving"
 * sub-state. Doctor still applies this gate when deciding row colour
 * (silent vs yellow). The state taxonomy itself does NOT subdivide
 * bootstrapping by uptime — that policy is doctor-specific, not part
 * of the shared vocabulary.
 *
 * Re-exported from this module (rather than only from doctor.ts) so
 * callers reaching for the canonical constant have one import surface.
 */
export const STARVING_THRESHOLD_S = 60;

export interface CageHealth {
  /** Roster member name (`team.members[].name`). */
  member: string;
  /** Resolved tmux window name (post-ADR-017 + ADR-136). */
  windowName: string;
  /** Classifier verdict. */
  state: CageState;
  /** Pane process uptime in seconds, or `null` when `ps` probe failed.
   *  Drives doctor's bootstrapping → starving surfacing decision. */
  paneUptimeSec: number | null;
  /** Last ≤200 chars of the pane capture. Empty when state === "down"
   *  (no pane to capture). */
  evidence: string;
  /** Heartbeat age (seconds since supervisor write), or `null` when
   *  the heartbeat file is absent or unparseable. Surface this for
   *  the operator-visible "why is it wedged" line. */
  heartbeatAgeSec: number | null;
}

// ---------- Public API ----------

/** Spawn injection — defaults to the abstractions/spawn implementation
 *  but tests pass a stub that synthesizes `ps`/`pgrep` output. */
export type ChildExecProbe = (panePid: number) => Promise<boolean>;

export interface ProbeCageStateOpts {
  /** Override the tmux client. Default: `createTmux({ socketPath })`. */
  tmux?: TmuxNamespace;
  /** Test override for `tmux.session.hasSession`. */
  hasSession?: (name: string, socketPath: string) => Promise<boolean>;
  /** Probe override: "is `claude` in this pane PID's child tree?"
   *  Default uses `ps --ppid <panePid> -o comm=` and matches `claude`. */
  paneChildIsClaude?: ChildExecProbe;
  /** Wall-clock injection (seconds). Default: `Math.floor(now()/1000)`. */
  nowSec?: () => number;
  /** Heartbeat read override — defaults to {@link readHeartbeat}.
   *  Allows tests to simulate heartbeat staleness without writing
   *  files. */
  readHeartbeat?: (atmuxDir: string, member: string) => Promise<number | null>;
}

/**
 * Probe a single member's cage state. Pure modulo IO — every IO call
 * is gated through `opts` for tests. Returns a `CageHealth` row;
 * callers (status / doctor) decide presentation.
 *
 * Probe order matches the state ladder (cheapest to costliest, fail-
 * fast on the first definitive signal):
 *
 *   1. session missing → `down`
 *   2. pane window missing → `down`
 *   3. no `claude` in pane's child tree → `down`
 *   4. pane classifier text shows RATE-LIMIT → `wedged`
 *   5. tokens NOT moved (no `\d+k tokens` shape) → `bootstrapping`
 *   6. heartbeat age > {@link WEDGED_HEARTBEAT_STALE_SEC} → `wedged`
 *   7. otherwise → `active`
 *
 * The probe deliberately keeps `bootstrapping` undivided by uptime —
 * the doctor-side ADR-081 §D "starving" sub-classification lives in
 * the row-surfacing layer, not here.
 */
export async function probeCageState(
  team: Team,
  member: TeamMember,
  atmuxDir: string,
  opts: ProbeCageStateOpts = {},
): Promise<CageHealth> {
  const socketPath = resolveTeamSocket(team);
  const sessionName = `atmux-${team.name}`;
  const tmux = opts.tmux ?? createTmux({ socketPath });
  const hasSession =
    opts.hasSession ??
    (async (name: string, _sock: string) => tmux.session.hasSession(name));
  const childIsClaude = opts.paneChildIsClaude ?? defaultPaneChildIsClaude;
  const nowSec = opts.nowSec ?? (() => Math.floor(now() / 1000));
  const readHb = opts.readHeartbeat ?? readHeartbeat;

  const emoji = member.emoji ?? defaultEmojiForRole(member.role ?? "member");
  // ADR-135 + ADR-136: hyphen-separator window name with label override.
  const label = (member as { label?: string }).label;
  const windowSuffix = typeof label === "string" && label.length > 0 ? label : member.name;
  const windowName = `${emoji}${windowSuffix}`;
  const target = `${sessionName}:${windowName}`;

  // (1) session present?
  if (!(await hasSession(sessionName, socketPath))) {
    return {
      member: member.name,
      windowName,
      state: "down",
      paneUptimeSec: null,
      evidence: "",
      heartbeatAgeSec: null,
    };
  }

  // (2) pane window present + pane PID?
  let panePid: number | null = null;
  try {
    const panes = await tmux.pane.listPanes(target);
    panePid = panes[0]?.pid ?? null;
  } catch {
    return {
      member: member.name,
      windowName,
      state: "down",
      paneUptimeSec: null,
      evidence: "",
      heartbeatAgeSec: null,
    };
  }
  if (panePid === null) {
    return {
      member: member.name,
      windowName,
      state: "down",
      paneUptimeSec: null,
      evidence: "",
      heartbeatAgeSec: null,
    };
  }

  // (3) claude exec in child tree?
  let hasClaude = false;
  try {
    hasClaude = await childIsClaude(panePid);
  } catch {
    // `ps`/`pgrep` failure → treat as down rather than risking false
    // active / wedged labels on a member whose process tree is opaque.
    hasClaude = false;
  }
  if (!hasClaude) {
    const text = await tryCapture(tmux, target);
    return {
      member: member.name,
      windowName,
      state: "down",
      paneUptimeSec: await readPaneUptimeSec(panePid),
      evidence: text.slice(-200),
      heartbeatAgeSec: null,
    };
  }

  // Capture pane text once for classifier + tokens-moved detection.
  const text = await tryCapture(tmux, target);
  const paneUptimeSec = await readPaneUptimeSec(panePid);
  const evidence = text.slice(-200);

  // (4) rate-limit pane → wedged. The classifier's RATE-LIMIT pattern
  // hits "hit your limit" / "You've hit your limit" — both are
  // deterministic markers of a stuck claude that won't make forward
  // progress until budget reset.
  const classification = classifyText(text);
  if (classification.state === "RATE-LIMIT") {
    const hbEpoch = await readHb(atmuxDir, member.name);
    const heartbeatAgeSec = hbEpoch !== null ? Math.max(0, nowSec() - hbEpoch) : null;
    return {
      member: member.name,
      windowName,
      state: "wedged",
      paneUptimeSec,
      evidence,
      heartbeatAgeSec,
    };
  }

  // (5) tokens not moved → bootstrapping. Same regex as ADR-081 §C
  // boot-claude module — `<int>k tokens` / `tokens · <int>%`.
  if (!TOKENS_MOVED_RE.test(text)) {
    return {
      member: member.name,
      windowName,
      state: "bootstrapping",
      paneUptimeSec,
      evidence,
      heartbeatAgeSec: null,
    };
  }

  // (6) heartbeat stale → wedged. Heartbeat write path is bash-side
  // today; when the file is absent we skip the heartbeat ladder
  // entirely (don't false-flag a healthy team as wedged just because
  // the supervisor never wrote heartbeats).
  const hbEpoch = await readHb(atmuxDir, member.name);
  if (hbEpoch !== null) {
    const ageSec = Math.max(0, nowSec() - hbEpoch);
    if (ageSec > WEDGED_HEARTBEAT_STALE_SEC) {
      return {
        member: member.name,
        windowName,
        state: "wedged",
        paneUptimeSec,
        evidence,
        heartbeatAgeSec: ageSec,
      };
    }
    return {
      member: member.name,
      windowName,
      state: "active",
      paneUptimeSec,
      evidence,
      heartbeatAgeSec: ageSec,
    };
  }

  // (7) active fallthrough.
  return {
    member: member.name,
    windowName,
    state: "active",
    paneUptimeSec,
    evidence,
    heartbeatAgeSec: null,
  };
}

// ---------- Internals ----------

/** Matches the `<int>k tokens` / `tokens · <int>%` status-line shape
 *  claude renders once a turn has produced output. Identical to
 *  ADR-081 §C `TOKENS_MOVED_RE` (kept in sync — both flow from the
 *  same TUI rendering contract). */
const TOKENS_MOVED_RE = /(?<![0-9])\d+k\s*(?:tokens|↓)|tokens\s*·\s*\d+%/i;

/** Default child-exec probe: `ps --ppid <panePid> -o comm=` and match
 *  `claude` (or `claude-code`) in the comm column. Pure-ish (single
 *  spawn call), portable across Linux + macOS. */
async function defaultPaneChildIsClaude(panePid: number): Promise<boolean> {
  let r: SpawnResult;
  try {
    r = await defaultSpawn({
      cmd: "ps",
      argv: ["-o", "comm=", "--ppid", String(panePid)],
      expectExitCode: "any",
      timeoutMs: 2_000,
    });
  } catch {
    return false;
  }
  if (r.exitCode !== 0) return false;
  // `comm` is the command name (basename of argv[0]) — typically
  // truncated to 16 chars on Linux but `claude` fits. Match any line
  // whose first token is `claude` (handles `claude-code` variant).
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .some((l) => l === "claude" || l.startsWith("claude") || l === "node");
  // `node` accepted as a Claude Code wrapper exec name on some
  // installs (npm-shim path); the alternative is false-negative
  // `down` reports on dev installs.
}

/** Wrap a capture-pane call in a try/catch — the pane may have died
 *  between listPanes + capturePane (e.g. operator killed it). */
async function tryCapture(tmux: TmuxNamespace, target: string): Promise<string> {
  try {
    return await tmux.pane.capturePane({ target, start: -30 });
  } catch {
    return "";
  }
}

/** Read pane process uptime via `ps -o etimes= -p <pid>`. Mirrors
 *  doctor.ts's `readPaneUptimeSec` — kept local rather than exported
 *  so this module stays self-contained. */
async function readPaneUptimeSec(pid: number): Promise<number | null> {
  let r: SpawnResult;
  try {
    r = await defaultSpawn({
      cmd: "ps",
      argv: ["-o", "etimes=", "-p", String(pid)],
      expectExitCode: "any",
      timeoutMs: 2_000,
    });
  } catch {
    return null;
  }
  if (r.exitCode !== 0) return null;
  const trimmed = r.stdout.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}
