// ADR-064 §4: driver-pane health probe.
//
// Single helper that the status / doctor / dashboard verbs all consume
// to surface the live driver-window's pane state (READY / TYPING /
// COMPACTING / etc.) — without each verb re-implementing the
// list-windows + capture-pane + classify chain.
//
// Resolution:
//   1. configured = `team.driverSession` is a truthy object — set when
//      the team opted into the ADR-044 driver-window topology (driver
//      pane is window 1 in the cage). Teams that don't opt in have
//      no driver pane to probe; helper short-circuits.
//   2. windowExists = the cage's `driver` window is present in the
//      live session. Resolved via `tmux list-windows -t <session>`
//      → name match. Missing post-`atmux start` is config drift
//      (doctor warns).
//   3. state = `classifyPane('<session>:driver', captureFn)` per
//      `core/pane-state.ts:109`. Captures the last 30 lines (same
//      window whip uses for its per-member health probe).
//
// Single I/O at the capture step; everything above is in-memory team
// inspection. Dependencies are injectable so the helper unit-tests
// without a real tmux server.

import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import type { Team } from "../schema/team.ts";
import { getSessionName, resolveTeamSocket } from "./common.ts";
import { resolveDriversList } from "./drivers.ts";
import { type CaptureFn, classifyPane, type PaneState } from "./pane-state.ts";
import { getAtmuxTmuxConfPath } from "./tmux-paths.ts";

/** Snapshot of the driver pane's health at probe time. */
export interface DriverPaneHealth {
  /** Driver window name this snapshot describes. */
  driverName?: string;
  /** True when `team.driverSession` is a truthy object (the team opted
   *  into the ADR-044 driver-window topology). False → driver-pane
   *  surfaces are skipped entirely (not a problem, just unconfigured). */
  configured: boolean;
  /** True when the cage's `driver` window exists in the live tmux
   *  session. False when configured but the window is absent — config
   *  drift (operator should `atmux start`). */
  windowExists: boolean;
  /** Pane classification per `classifyPane`. `null` when the window
   *  doesn't exist (no pane to classify) or the capture call threw
   *  (transient tmux error — surfaces as null + empty evidence). */
  state: PaneState | null;
  /** First-match substring from `classifyPane` — the line / token
   *  that drove the classification. Empty when state is null or the
   *  state is READY (no pattern matched). */
  evidence: string;
}

/** Test injection points for `probeDriverPane`. Production wiring
 *  (no opts) goes through the team-tmux abstraction. */
export interface ProbeDriverPaneDeps {
  /** Pre-built tmux namespace. Defaults to `createTmux({socketPath:
   *  getDefaultSocket(team.name)})`. */
  tmux?: TmuxNamespace;
  /** Override the probed driver name. Defaults to `driver`. */
  driverName?: string;
  /** Window-name lookup. Defaults to `tmux.window.listWindows` then
   *  `.map(w => w.name)`. Fixture injection lets tests skip the
   *  tmux dependency entirely. */
  listWindowNames?: (session: string) => Promise<ReadonlyArray<string>>;
  /** Pane-capture function. Defaults to `tmux.pane.capturePane({target,
   *  start: -30})`. */
  capture?: CaptureFn;
}

/**
 * Probe the driver pane and return a health snapshot.
 *
 * Best-effort I/O — every transient failure (list-windows error,
 * capture-pane error) degrades to a sensible health shape rather
 * than throwing. The caller's surface (status row / doctor finding
 * / dashboard block) renders the snapshot deterministically; "tmux
 * is misbehaving" should look the same as "pane is in unknown state"
 * to the operator.
 */
export async function probeDriverPane(
  team: Team,
  atmuxDir: string,
  deps: ProbeDriverPaneDeps = {},
): Promise<DriverPaneHealth> {
  const driverName = deps.driverName ?? "driver";
  const configured = team.driverSession !== null && team.driverSession !== undefined;
  const withDriverName = (health: Omit<DriverPaneHealth, "driverName">): DriverPaneHealth =>
    deps.driverName === undefined && driverName === "driver" ? health : { driverName, ...health };
  if (!configured) {
    return withDriverName({
      configured: false,
      windowExists: false,
      state: null,
      evidence: "",
    });
  }

  const tmux =
    deps.tmux ??
    createTmux({ socketPath: resolveTeamSocket(team), configFile: getAtmuxTmuxConfPath() });
  const session = await getSessionName({ dir: atmuxDir, team });

  const listWindowNames =
    deps.listWindowNames ??
    (async (s: string): Promise<ReadonlyArray<string>> => {
      const ws = await tmux.window.listWindows(s);
      return ws.map((w) => w.name);
    });

  const names = await listWindowNames(session).catch(() => [] as ReadonlyArray<string>);
  const windowExists = names.includes(driverName);
  if (!windowExists) {
    return withDriverName({
      configured: true,
      windowExists: false,
      state: null,
      evidence: "",
    });
  }

  const capture: CaptureFn =
    deps.capture ?? ((target: string) => tmux.pane.capturePane({ target, start: -30 }));
  const target = `${session}:${driverName}`;

  try {
    const classification = await classifyPane(target, capture);
    return withDriverName({
      configured: true,
      windowExists: true,
      state: classification.state,
      evidence: classification.evidence,
    });
  } catch {
    // expected: tmux capture transient failure (server reload, pane
    // resize). Surface as state=null so the operator-facing renderers
    // know the snapshot is incomplete rather than misclassifying.
    return withDriverName({
      configured: true,
      windowExists: true,
      state: null,
      evidence: "",
    });
  }
}

/** Probe every configured driver window in roster order. */
export async function probeDriverPanes(
  team: Team,
  atmuxDir: string,
  deps: ProbeDriverPaneDeps = {},
): Promise<DriverPaneHealth[]> {
  const roster = resolveDriversList(team as Parameters<typeof resolveDriversList>[0]);
  if (team.driverSession === null || team.driverSession === undefined) {
    return roster.map((driver) => ({
      driverName: driver.name,
      configured: false,
      windowExists: false,
      state: null,
      evidence: "",
    }));
  }

  const tmux =
    deps.tmux ??
    createTmux({ socketPath: resolveTeamSocket(team), configFile: getAtmuxTmuxConfPath() });
  const session = await getSessionName({ dir: atmuxDir, team });
  const listWindowNames =
    deps.listWindowNames ??
    (async (s: string): Promise<ReadonlyArray<string>> => {
      const ws = await tmux.window.listWindows(s);
      return ws.map((w) => w.name);
    });
  const names = await listWindowNames(session).catch(() => null);
  if (names === null) {
    return roster.map((driver) => ({
      driverName: driver.name,
      configured: true,
      windowExists: false,
      state: null,
      evidence: "",
    }));
  }

  const capture: CaptureFn =
    deps.capture ?? ((target: string) => tmux.pane.capturePane({ target, start: -30 }));
  const out: DriverPaneHealth[] = [];
  for (const driver of roster) {
    const windowExists = names.includes(driver.name);
    if (!windowExists) {
      out.push({
        driverName: driver.name,
        configured: true,
        windowExists: false,
        state: null,
        evidence: "",
      });
      continue;
    }
    const target = `${session}:${driver.name}`;
    try {
      const classification = await classifyPane(target, capture);
      out.push({
        driverName: driver.name,
        configured: true,
        windowExists: true,
        state: classification.state,
        evidence: classification.evidence,
      });
    } catch {
      out.push({
        driverName: driver.name,
        configured: true,
        windowExists: true,
        state: null,
        evidence: "",
      });
    }
  }
  return out;
}
