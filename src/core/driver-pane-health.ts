// ADR-064 §4: driver-pane health probe.
//
// Single helper that the status / doctor / dashboard verbs all consume
// to surface the live driver-window's pane state (READY / TYPING /
// COMPACTING / etc.) — without each verb re-implementing the
// list-windows + list-panes + capture-pane + classify chain.
//
// Resolution:
//   1. configured = the resolved driver roster is non-empty. In
//      production, `resolveDriversList(team)` resolves the canonical
//      roster for every driver probe; `configured=false` only survives
//      through legacy injected fixtures in doctor tests. The legacy
//      `team.driverSession` marker is not the source of truth.
//   2. windowExists = the cage's `driver` window is present in the
//      live session. Resolved via `tmux list-windows -t <session>`
//      → name match. Missing post-`atmux start` is config drift
//      (doctor warns).
//   3. pair = `tmux list-panes -t <session>:driver` metadata classified
//      through `planDriverPanePair`. The worker pane is captured by
//      immutable `%pane_id`; attention is never the health target.
//   4. state = `classifyPane(<worker-pane-id>, captureFn)` when the
//      pair is valid or a safe singleton. Pair failures never capture.
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
import { type CaptureFn, classifyPane, type PaneState } from "./pane-state.ts";

type DriverPanePairDecision = DriverPanePairPlan["decision"] | "unavailable";
type DriverPanePairReason =
  | DriverPanePairReasonCode
  | "pair.observer.list_windows_failed"
  | "pair.observer.list_panes_failed"
  | "pair.observer.missing_pane_metadata";

/** Snapshot of the driver pane's health at probe time. */
export interface DriverPaneHealth {
  /** True when the resolved driver roster is non-empty. */
  configured: boolean;
  /** True when the cage's `driver` window exists in the live tmux
   *  session. False means either a confirmed absence or an unavailable
   *  window observation; `pairReason` distinguishes those cases. */
  windowExists: boolean;
  /** Pair-planner decision for the live `driver` window, when present.
   *  `unavailable` marks observer failure before pair classification. */
  pairDecision?: DriverPanePairDecision;
  /** Stable pair reason code, including observer-only reasons. */
  pairReason?: DriverPanePairReason;
  /** Pair planner diagnostics or observer diagnostics. */
  pairDiagnostics?: readonly [string, string];
  /** Pane classification per `classifyPane`. `null` when the window
   *  doesn't exist, pair observation failed, or the capture call threw
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
  /** Window-name lookup. Defaults to `tmux.window.listWindows` then
   *  `.map(w => w.name)`. Fixture injection lets tests skip the
   *  tmux dependency entirely. */
  listWindowNames?: (session: string) => Promise<ReadonlyArray<string>>;
  /** Pane listing for the live driver window. Defaults to
   *  `tmux.pane.listPanes(target)`. */
  listPanes?: (target: string) => Promise<ReadonlyArray<PaneInfo>>;
  /** Pane-capture function. Defaults to `tmux.pane.capturePane({target,
   *  start: -30})`. */
  capture?: CaptureFn;
}

function observerDiagnostics(problem: string): readonly [string, string] {
  return [problem, "Run atmux doctor to inspect driver-pane roles and geometry."];
}

function observerHealth(
  reason:
    | "pair.observer.list_windows_failed"
    | "pair.observer.list_panes_failed"
    | "pair.observer.missing_pane_metadata",
  windowExists: boolean,
): DriverPaneHealth {
  const decision = reason === "pair.observer.missing_pane_metadata" ? "fail-closed" : "unavailable";
  return {
    configured: true,
    windowExists,
    state: null,
    evidence: "",
    pairDecision: decision,
    pairReason: reason,
    pairDiagnostics:
      reason === "pair.observer.list_windows_failed"
        ? observerDiagnostics("Driver window metadata could not be read from tmux.")
        : reason === "pair.observer.list_panes_failed"
          ? observerDiagnostics("Driver pane metadata could not be read from tmux.")
          : observerDiagnostics("Driver pane metadata is incomplete."),
  };
}

function healthFromPlan(
  plan: DriverPanePairPlan,
  classification: { state: PaneState; evidence: string } | null,
): DriverPaneHealth {
  return {
    configured: true,
    windowExists: true,
    state: classification?.state ?? null,
    evidence: classification?.evidence ?? "",
    pairDecision: plan.decision,
    pairReason: plan.reasonCode,
    pairDiagnostics: plan.diagnostics,
  };
}

function toDriverPane(pane: PaneInfo): DriverPane | null {
  if (typeof pane.id !== "string" || !/^%\d+$/.test(pane.id)) return null;
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

/**
 * Probe the driver pane and return a health snapshot.
 *
 * Best-effort I/O — every transient failure (list-windows error,
 * list-panes error, capture-pane error) degrades to a sensible health
 * shape rather than throwing. The caller's surface (status row /
 * doctor finding / dashboard block) renders the snapshot
 * deterministically.
 */
export async function probeDriverPane(
  team: Team,
  atmuxDir: string,
  deps: ProbeDriverPaneDeps = {},
): Promise<DriverPaneHealth> {
  const tmux = deps.tmux ?? createTmux({ socketPath: resolveTeamSocket(team) });
  const session = await getSessionName({ dir: atmuxDir, team });

  const listWindowNames =
    deps.listWindowNames ??
    (async (s: string): Promise<ReadonlyArray<string>> => {
      const ws = await tmux.window.listWindows(s);
      return ws.map((w) => w.name);
    });

  const names = await listWindowNames(session).catch(() => null as ReadonlyArray<string> | null);
  if (names === null) {
    return observerHealth("pair.observer.list_windows_failed", false);
  }

  const windowExists = names.includes("driver");
  if (!windowExists) {
    return { configured: true, windowExists: false, state: null, evidence: "" };
  }

  const listPanes =
    deps.listPanes ??
    ((target: string): Promise<ReadonlyArray<PaneInfo>> => tmux.pane.listPanes(target));
  const panes = await listPanes(`${session}:driver`).catch(
    () => null as ReadonlyArray<PaneInfo> | null,
  );
  if (panes === null) {
    return observerHealth("pair.observer.list_panes_failed", true);
  }

  const driverPanes: DriverPane[] = [];
  for (const pane of panes) {
    const normalized = toDriverPane(pane);
    if (normalized === null) {
      return observerHealth("pair.observer.missing_pane_metadata", true);
    }
    driverPanes.push(normalized);
  }

  const plan = planDriverPanePair(driverPanes);
  if (plan.decision === "fail-closed") {
    return healthFromPlan(plan, null);
  }

  const captureTarget = plan.decision === "noop" ? plan.workerPane.id : plan.keepPane.id;
  const capture: CaptureFn =
    deps.capture ?? ((target: string) => tmux.pane.capturePane({ target, start: -30 }));

  try {
    const classification = await classifyPane(captureTarget, capture);
    return healthFromPlan(plan, classification);
  } catch {
    // expected: tmux capture transient failure (server reload, pane
    // resize). Pair metadata is still valid; the observation just
    // lacks state signal.
    return healthFromPlan(plan, null);
  }
}
