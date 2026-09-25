import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { SpawnResult } from "../../abstractions/spawn.ts";
import {
  cageSocketPath,
  groupSocketPath,
  type LoadedCockpit,
  loadCockpit,
  perTeamCageSocketPath,
  walkSessions,
} from "../../core/cockpit.ts";
import { resolveTeamSocket, tryLoadTeam } from "../../core/common.ts";
import { getCockpitSocketPath } from "../../core/tmux-paths.ts";
import type { Team } from "../../schema/team.ts";
import { type DoctorRow, defaultTmuxSpawn, type TmuxSpawn } from "./types.ts";

// ---------- ADR-294: agent-shell environment frozen into a tmux server ----------

/** One agent-shell fingerprint in a tmux server's GLOBAL environment.
 *  `values` absent means the variable being set at all is the finding. */
export interface AgentEnvMarker {
  readonly name: string;
  readonly values?: ReadonlyArray<string>;
}

/**
 * The variables an agent harness's shell tool exports so captured
 * commands never block, prompt or colour their output — correct for a
 * captured subprocess, wrong for a long-lived interactive cage.
 *
 * A tmux server copies the environment of whatever process started it
 * into its global environment ONCE, and builds every pane it ever
 * creates from that copy (ADR-277 §Context). So a server started from an
 * agent's shell hands these to every pane for its whole life: TUIs render
 * monochrome (`NO_COLOR`), and `git commit` silently takes the default
 * message (`GIT_EDITOR=true`). Found 2026-09-25 on geoywsMBP: three live
 * servers (`reins`, `wedding`, `dotprobe`) had carried omp's set since
 * 2026-09-24 20:53, and nothing flagged it until a human noticed.
 *
 * Sources: omp's `NON_INTERACTIVE_ENV`
 * (`@oh-my-pi/pi-coding-agent/src/exec/non-interactive-env.ts`) and
 * Claude Code's Bash tool (`NO_COLOR`; ADR-277 §Context). Where a human
 * might set the same name on purpose, only the value the harness uses
 * counts (`EDITOR=true`, not any `EDITOR`).
 *
 * Deliberately NOT here:
 *   - `TERM=dumb` — inert: tmux sets `TERM` from `default-terminal` in
 *     every pane and `run-shell` job (measured tmux 3.7c, 2026-09-25), so
 *     the global value never reaches them. The dotfiles tmux conf leaves
 *     it unscrubbed by design, so every agent-born server would keep it
 *     and raise a permanent yellow — crying wolf. `AGENT` is the
 *     harness fingerprint instead.
 *   - `CLAUDECODE` — atmux sets it itself on every claude launch
 *     (`src/core/tui-cmd.ts`), so it is no agent fingerprint in a cage.
 *   - `LESS=FRX`, `PYTHONUNBUFFERED=1`, `DEBIAN_FRONTEND=noninteractive`
 *     and the package-manager knobs — common in human shells too, and
 *     harmless in a pane; flagging them would cry wolf.
 */
export const AGENT_SHELL_ENV_MARKERS: ReadonlyArray<AgentEnvMarker> = Object.freeze([
  { name: "AGENT" },
  { name: "CI" },
  { name: "NO_COLOR" },
  { name: "EDITOR", values: ["true"] },
  { name: "VISUAL", values: ["true"] },
  { name: "GIT_EDITOR", values: ["true"] },
  { name: "PAGER", values: ["cat"] },
  { name: "GIT_PAGER", values: ["cat"] },
  { name: "GIT_TERMINAL_PROMPT", values: ["0"] },
  { name: "SSH_ASKPASS", values: ["/usr/bin/false", "/bin/false", "false"] },
]);

/**
 * Names of the markers set in `tmux show-environment -g` output, in
 * marker order. Returns NAMES ONLY — values are compared and dropped
 * here, and never retained for any name outside the marker set.
 *
 * `NAME=value` is a set variable. `-NAME` is tmux's removal mark (what
 * `atmux.conf`'s `set-environment -gr NO_COLOR` leaves behind) and is
 * the healthy state, not a finding.
 */
export function findAgentEnvMarkers(
  showEnvironmentOutput: string,
  markers: ReadonlyArray<AgentEnvMarker> = AGENT_SHELL_ENV_MARKERS,
): string[] {
  const wanted = new Set(markers.map((m) => m.name));
  const set = new Map<string, string>();
  for (const line of showEnvironmentOutput.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue; // `-NAME` removal mark, or a blank line
    const name = line.slice(0, eq);
    if (wanted.has(name)) set.set(name, line.slice(eq + 1));
  }
  const out: string[] = [];
  for (const m of markers) {
    const value = set.get(m.name);
    if (value === undefined) continue;
    if (m.values !== undefined && !m.values.includes(value)) continue;
    out.push(m.name);
  }
  return out;
}

/** The copy-paste repair for one server: unset each variable from the
 *  global environment. New panes are clean at once; running panes keep
 *  their own environment, which is why the text says so. */
export function agentEnvRemedy(socket: string, names: ReadonlyArray<string>): string {
  const cmds = names.map((n) => `tmux -S ${socket} set-environment -g -u ${n}`).join("; ");
  return `${cmds} — panes already running keep the old environment until their processes restart`;
}

/** One tmux server atmux knows about. */
export interface AtmuxServerSocket {
  /** Absolute socket path — what `tmux -S` takes. */
  readonly socket: string;
  /** The tier that owns it, for the row: `cockpit`, `group <g>`, `team <t>`. */
  readonly owner: string;
}

export interface DiscoverAtmuxServerSocketsOpts {
  /** Env for the cockpit socket path + cockpit.json location. */
  env?: NodeJS.ProcessEnv;
  /** Cockpit reader override; default `loadCockpit`, `null` when absent. */
  loadCockpitFn?: () => Promise<LoadedCockpit | null>;
  /** team.json reader for a cockpit team root; `null` when absent/invalid. */
  loadTeamForRoot?: (root: string) => Promise<Team | null>;
}

/**
 * Every socket path atmux itself would put a server on: the cockpit, one
 * per group, and per team every convention a cage may be on
 * (`resolveTeamSocket` when team.json loads, plus the legacy
 * `/tmp/atmux-<team>/sock` and the per-team `.atmux/tmux` path that
 * `resolveCageSocket` also walks), then the current team. Deduplicated by
 * path, in that order.
 *
 * Paths only — nothing here touches tmux. Disabled teams and groups are
 * listed too: disabled is a cockpit flag, not proof no server is running.
 */
export async function discoverAtmuxServerSockets(
  currentTeam: Team | null,
  opts: DiscoverAtmuxServerSocketsOpts = {},
): Promise<AtmuxServerSocket[]> {
  const env = opts.env ?? process.env;
  const loadCockpitFn =
    opts.loadCockpitFn ??
    (async (): Promise<LoadedCockpit | null> => {
      try {
        return await loadCockpit({ env });
      } catch {
        return null; // no cockpit / unreadable — the current team still gets probed
      }
    });
  const loadTeamForRoot =
    opts.loadTeamForRoot ??
    (async (root: string): Promise<Team | null> => {
      try {
        // `dir`, not `teamDir`: `getAtmuxDir` ranks `ATMUX_DIR` above
        // `teamDir`, which would load the CURRENT team for every root.
        return await tryLoadTeam({ dir: join(root, ".atmux") });
      } catch {
        return null;
      }
    });

  const out: AtmuxServerSocket[] = [];
  const seen = new Set<string>();
  const add = (socket: string, owner: string): void => {
    if (seen.has(socket)) return;
    seen.add(socket);
    out.push({ socket, owner });
  };

  add(getCockpitSocketPath(env), "cockpit");
  const cockpit = await loadCockpitFn();
  if (cockpit !== null) {
    const teams: Array<{ name: string; root: string }> = [];
    walkSessions(cockpit.sessions, 0, (node) => {
      if (node.type === "group") add(groupSocketPath(node.name), `group ${node.name}`);
      else if (node.type === "team") teams.push({ name: node.name, root: node.root });
    });
    for (const t of teams) {
      const roster = await loadTeamForRoot(t.root);
      if (roster !== null) add(resolveTeamSocket(roster), `team ${t.name}`);
      add(cageSocketPath(t.name), `team ${t.name}`);
      add(perTeamCageSocketPath(t.root), `team ${t.name}`);
    }
  }
  if (currentTeam !== null) add(resolveTeamSocket(currentTeam), `team ${currentTeam.name}`);
  return out;
}

export interface CheckAgentShellEnvOpts extends DiscoverAtmuxServerSocketsOpts {
  /** tmux spawn override. */
  tmux?: TmuxSpawn;
  /** `[ -S <path> ]` override — true only for an existing socket file. */
  isSocket?: (path: string) => Promise<boolean>;
  /** Probe exactly these sockets instead of discovering them. */
  sockets?: ReadonlyArray<AtmuxServerSocket>;
}

/** `[ -S <path> ]`: follows symlinks, false for anything missing. */
async function defaultIsSocket(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isSocket();
  } catch {
    return false;
  }
}

/**
 * ADR-294 — `tmux-agent-env` warn-class probe. One yellow row per live
 * atmux tmux server whose global environment carries an
 * {@link AGENT_SHELL_ENV_MARKERS} entry, naming the socket and the
 * variable NAMES (never values), with the per-variable unset as hint.
 *
 * Strictly read-only, and never creates a server: the socket FILE is
 * checked first, then only `has-session` and `show-environment -g` run,
 * neither of which starts a server. Skipped silently: a missing path, a
 * stale socket file with no server behind it, a server with no session,
 * or a tmux spawn failure (the deps probe covers tmux-on-PATH).
 */
export async function checkAgentShellEnv(
  currentTeam: Team | null,
  opts: CheckAgentShellEnvOpts = {},
): Promise<DoctorRow[]> {
  const tmux = opts.tmux ?? defaultTmuxSpawn;
  const isSocket = opts.isSocket ?? defaultIsSocket;
  const sockets = opts.sockets ?? (await discoverAtmuxServerSockets(currentTeam, opts));
  const rows: DoctorRow[] = [];
  for (const { socket, owner } of sockets) {
    if (!(await isSocket(socket))) continue;
    let shown: SpawnResult;
    try {
      const alive = await tmux(["-S", socket, "has-session"]);
      if (alive.exitCode !== 0) continue;
      shown = await tmux(["-S", socket, "show-environment", "-g"]);
    } catch {
      continue;
    }
    if (shown.exitCode !== 0) continue;
    const names = findAgentEnvMarkers(shown.stdout);
    if (names.length === 0) continue;
    rows.push({
      status: "yellow",
      label: "tmux-agent-env",
      detail: `${owner} server ${socket} carries agent-shell env: ${names.join(", ")}`,
      hint: agentEnvRemedy(socket, names),
    });
  }
  return rows;
}
