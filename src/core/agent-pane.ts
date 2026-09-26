// Two-stage agent-pane lifecycle (operator directive 2026-09-22).
//
// Every agent pane starts as an interactive login zsh. Before a TUI is
// launched, atmux sends an inert printf probe to the immutable pane ID and
// waits until capture-pane contains the probe's output. This proves that
// the fresh shell accepts and executes input; process names are not a
// readiness signal (`sh` is also reported by healthy Claude panes).

import type { PaneId, SendTarget, Target, TmuxNamespace } from "../abstractions/tmux.ts";

export type LaunchAgentPaneIntent =
  | { readonly kind: "member"; readonly member: string; readonly team: string }
  | { readonly kind: "lead"; readonly team: string }
  | { readonly kind: "service"; readonly team: string }
  | { readonly kind: "bot"; readonly team: string }
  | { readonly kind: "driver"; readonly team: string };

export interface LaunchAgentPaneOpts {
  tmux: TmuxNamespace;
  /** Immutable, exact pane created for this launch. */
  paneId: PaneId;
  /** ADR-025 intent metadata; the helper pins its target to paneId. */
  intent: LaunchAgentPaneIntent;
  /** The resolved TUI launch command line. */
  command: string;
  /** Poll budget for the readiness probe. Default 15s total. */
  timeoutMs?: number;
  /** Poll interval. Default 250ms. */
  pollMs?: number;
  /** How often the inert probe is re-sent while waiting. Default 2s. */
  reprobeMs?: number;
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Unique token source; called once per probe attempt. */
  readinessToken?: () => string;
}

export type LaunchAgentPaneOutcome =
  | "launched"
  /** The exact pane never executed the shell probe; the TUI was not sent. */
  | "no-prompt";

function pinnedTarget(intent: LaunchAgentPaneIntent, paneId: PaneId): SendTarget {
  switch (intent.kind) {
    case "member":
      return { ...intent, target: paneId };
    case "lead":
    case "service":
    case "bot":
    case "driver":
      return { ...intent, target: paneId };
  }
}

/** Resolve a window to its sole pane. Refuses split/empty windows rather
 * than guessing which pane should receive input. */
export async function resolveOnlyPane(
  tmux: TmuxNamespace,
  windowTarget: Target,
  sessionName: string,
  windowIndex: number,
): Promise<PaneId> {
  const panes = await tmux.pane.listPanes(windowTarget);
  if (panes.length !== 1) {
    throw new Error(
      `agent window ${sessionName}:${windowIndex} must contain exactly one pane (found ${panes.length})`,
    );
  }
  const pane = panes[0];
  if (pane === undefined) throw new Error("unreachable: sole pane missing");
  return { sessionName, windowIndex, paneIndex: pane.index };
}

function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Encode the expected output so the literal token is absent from the
 * command line. capture-pane can therefore match only executed output,
 * never an unevaluated command sitting in a TUI composer. */
function readinessProbe(token: string): string {
  const octal = [...Buffer.from(token, "utf8")]
    .map((byte) => `\\${byte.toString(8).padStart(3, "0")}`)
    .join("");
  return `printf '${octal}\\n'`;
}

/** Probe the exact fresh pane, then launch the TUI into the same pane.
 *
 * The probe is RE-SENT on a cadence inside the poll budget. A pane that
 * was just created can still be exec'ing its shell when the first
 * keystrokes arrive, and a single lost line would otherwise turn a
 * recoverable startup race into a full-budget stall with no TUI.
 *
 * Each re-send carries a NEW unique token and only the most recently
 * sent token is accepted. That is what proves no probe is still queued
 * when the TUI command goes out: a shell consumes its tty in order, so
 * observing token N means probes 1..N have already executed. */
export async function launchAgentInPane(
  opts: LaunchAgentPaneOpts,
): Promise<LaunchAgentPaneOutcome> {
  const pollMs = opts.pollMs ?? 250;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const reprobeMs = opts.reprobeMs ?? 2_000;
  const sleep = opts.sleep ?? defaultSleep;
  const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
  const reprobeEvery = Math.max(1, Math.round(reprobeMs / pollMs));
  const nextToken =
    opts.readinessToken ??
    (() => `ATMUX_READY_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`);
  const target = pinnedTarget(opts.intent, opts.paneId);
  const sendLine = async (keys: string): Promise<void> => {
    await opts.tmux.pane.sendKeys({ target, keys, literal: true, enter: false });
    await opts.tmux.pane.sendKeys({ target, keys: "C-m", enter: false });
  };

  let token = "";
  for (let i = 0; i < attempts; i++) {
    if (i % reprobeEvery === 0) {
      token = nextToken();
      await sendLine(readinessProbe(token));
    }
    try {
      const capture = await opts.tmux.pane.capturePane({ target: opts.paneId });
      if (capture.includes(token)) {
        await sendLine(opts.command);
        return "launched";
      }
    } catch {
      // Pane startup and capture can race. Keep polling within the bound.
    }
    if (i + 1 < attempts) await sleep(pollMs);
  }
  return "no-prompt";
}
