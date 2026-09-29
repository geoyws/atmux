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

import { createTmux, type PaneInfo, type TmuxNamespace } from "../abstractions/tmux.ts";
import type { Team } from "../schema/team.ts";
import { getSessionName, resolveTeamSocket } from "./common.ts";
import {
  type DriverPane,
  type DriverPanePairPlan,
  type DriverPanePairReasonCode,
  planDriverPanePair,
} from "./driver-pair.ts";
import { isDriverPairMaterialized, resolveDriversList } from "./drivers.ts";
import { type CaptureFn, classifyPane, type PaneState } from "./pane-state.ts";
import { getAtmuxTmuxConfPath } from "./tmux-paths.ts";

/** Pair-planner decision for a live driver window, when observed.
 *  `unavailable` marks observer failure before pair classification. */
export type DriverPanePairDecision = DriverPanePairPlan["decision"] | "unavailable";
/** Stable pair reason code, including observer-only reasons. */
export type DriverPanePairReason =
  | DriverPanePairReasonCode
  | "pair.observer.list_windows_failed"
  | "pair.observer.list_panes_failed"
  | "pair.observer.missing_pane_metadata";

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
  /** Pair-planner decision for the live driver window, when pane
   *  metadata was observed. Absent for missing windows and for
   *  legacy fixtures whose `listPanes` yields no rows (pre-pair
   *  fakes); `unavailable` marks observer failure before pair
   *  classification. */
  pairDecision?: DriverPanePairDecision;
  /** Stable pair reason code, including observer-only reasons. */
  pairReason?: DriverPanePairReason;
  /** Pair planner diagnostics or observer diagnostics. */
  pairDiagnostics?: readonly [string, string];
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
  /** Pane listing for a live driver window. Defaults to
   *  `tmux.pane.listPanes(target)`. Fixtures that predate the pair
   *  return `[]` — the probe then keeps the legacy window-target
   *  capture and leaves pair fields absent. */
  listPanes?: (target: string) => Promise<ReadonlyArray<PaneInfo>>;
  /** Pane-capture function. Defaults to `tmux.pane.capturePane({target,
   *  start: -30})`. */
  capture?: CaptureFn;
}

function observerDiagnostics(problem: string): readonly [string, string] {
  return [problem, "Run atmux doctor to inspect driver-pane roles and geometry."];
}

/** Normalize one listed pane for the pair planner. `null` when the
 *  row lacks the immutable `%N` id or geometry the planner needs —
 *  the caller fails closed instead of guessing. */
function toDriverPane(pane: PaneInfo): DriverPane | null {
  if (typeof pane.id !== "string" || !/^%[0-9]+$/.test(pane.id)) return null;
  if (typeof pane.left !== "number" || !Number.isFinite(pane.left)) return null;
  const normalized: DriverPane = {
    id: pane.id,
    index: pane.index,
    pid: pane.pid,
    left: pane.left,
  };
  if (typeof pane.role === "string") normalized.role = pane.role;
  return normalized;
}

/** Classify listed panes into a pair plan, or `null` when the listing
 *  carries no pair signal at all (legacy `[]` fixture). Pure. */
function classifyListedPanes(
  panes: ReadonlyArray<PaneInfo>,
): { plan: DriverPanePairPlan } | { observerReason: "pair.observer.missing_pane_metadata" } | null {
  if (panes.length === 0) return null;
  const driverPanes: DriverPane[] = [];
  for (const pane of panes) {
    const normalized = toDriverPane(pane);
    if (normalized === null) return { observerReason: "pair.observer.missing_pane_metadata" };
    driverPanes.push(normalized);
  }
  return { plan: planDriverPanePair(driverPanes) };
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

  // Rollout gate (ADR-288 amendment 2026-09-29): with driverPair.materialize
  // off, never list panes, so the probe runs exactly the pre-pair path
  // (window-target capture, no pair fields) on every live cage.
  const listPanes = isDriverPairMaterialized(team)
    ? (deps.listPanes ??
      ((windowTarget: string): Promise<ReadonlyArray<PaneInfo>> =>
        tmux.pane.listPanes(windowTarget)))
    : async (): Promise<ReadonlyArray<PaneInfo>> => [];
  const windowTarget = `${session}:${driverName}`;
  const listed = await listPanes(windowTarget).catch(() => null as ReadonlyArray<PaneInfo> | null);
  if (listed === null) {
    return withDriverName({
      configured: true,
      windowExists: true,
      state: null,
      evidence: "",
      pairDecision: "unavailable",
      pairReason: "pair.observer.list_panes_failed",
      pairDiagnostics: observerDiagnostics("Driver pane metadata could not be read from tmux."),
    });
  }
  const classified = classifyListedPanes(listed);
  if (classified !== null && "observerReason" in classified) {
    return withDriverName({
      configured: true,
      windowExists: true,
      state: null,
      evidence: "",
      pairDecision: "fail-closed",
      pairReason: classified.observerReason,
      pairDiagnostics: observerDiagnostics("Driver pane metadata is incomplete."),
    });
  }
  const plan = classified?.plan;
  if (plan?.decision === "fail-closed") {
    return withDriverName({
      configured: true,
      windowExists: true,
      state: null,
      evidence: "",
      pairDecision: plan.decision,
      pairReason: plan.reasonCode,
      pairDiagnostics: plan.diagnostics,
    });
  }
  // Pair plan is a healthy shape (noop / plan-add-attention) or the
  // fixture predates pair metadata (`[]`) — capture the worker pane
  // by immutable id when known, else the legacy window target.
  const captureTarget =
    plan === undefined
      ? windowTarget
      : plan.decision === "noop"
        ? plan.workerPane.id
        : plan.keepPane.id;

  const capture: CaptureFn =
    deps.capture ?? ((target: string) => tmux.pane.capturePane({ target, start: -30 }));
  try {
    const classification = await classifyPane(captureTarget, capture);
    return withDriverName({
      configured: true,
      windowExists: true,
      state: classification.state,
      evidence: classification.evidence,
      ...(plan === undefined
        ? {}
        : {
            pairDecision: plan.decision,
            pairReason: plan.reasonCode,
            pairDiagnostics: plan.diagnostics,
          }),
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
      ...(plan === undefined
        ? {}
        : {
            pairDecision: plan.decision,
            pairReason: plan.reasonCode,
            pairDiagnostics: plan.diagnostics,
          }),
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
  // Rollout gate (ADR-288 amendment 2026-09-29): with driverPair.materialize
  // off, never list panes, so the probe runs exactly the pre-pair path
  // (window-target capture, no pair fields) on every live cage.
  const listPanes = isDriverPairMaterialized(team)
    ? (deps.listPanes ??
      ((windowTarget: string): Promise<ReadonlyArray<PaneInfo>> =>
        tmux.pane.listPanes(windowTarget)))
    : async (): Promise<ReadonlyArray<PaneInfo>> => [];
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
    const windowTarget = `${session}:${driver.name}`;
    const listed = await listPanes(windowTarget).catch(
      () => null as ReadonlyArray<PaneInfo> | null,
    );
    if (listed === null) {
      out.push({
        driverName: driver.name,
        configured: true,
        windowExists: true,
        state: null,
        evidence: "",
        pairDecision: "unavailable",
        pairReason: "pair.observer.list_panes_failed",
        pairDiagnostics: observerDiagnostics("Driver pane metadata could not be read from tmux."),
      });
      continue;
    }
    const classified = classifyListedPanes(listed);
    if (classified !== null && "observerReason" in classified) {
      out.push({
        driverName: driver.name,
        configured: true,
        windowExists: true,
        state: null,
        evidence: "",
        pairDecision: "fail-closed",
        pairReason: classified.observerReason,
        pairDiagnostics: observerDiagnostics("Driver pane metadata is incomplete."),
      });
      continue;
    }
    const plan = classified?.plan;
    if (plan?.decision === "fail-closed") {
      out.push({
        driverName: driver.name,
        configured: true,
        windowExists: true,
        state: null,
        evidence: "",
        pairDecision: plan.decision,
        pairReason: plan.reasonCode,
        pairDiagnostics: plan.diagnostics,
      });
      continue;
    }
    const captureTarget =
      plan === undefined
        ? windowTarget
        : plan.decision === "noop"
          ? plan.workerPane.id
          : plan.keepPane.id;
    const pairFields =
      plan === undefined
        ? {}
        : {
            pairDecision: plan.decision,
            pairReason: plan.reasonCode,
            pairDiagnostics: plan.diagnostics,
          };
    try {
      const classification = await classifyPane(captureTarget, capture);
      out.push({
        driverName: driver.name,
        configured: true,
        windowExists: true,
        state: classification.state,
        evidence: classification.evidence,
        ...pairFields,
      });
    } catch {
      out.push({
        driverName: driver.name,
        configured: true,
        windowExists: true,
        state: null,
        evidence: "",
        ...pairFields,
      });
    }
  }
  return out;
}
