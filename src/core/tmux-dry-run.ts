// Dry-run tmux wrapper for `atmux cockpit reconcile --dry-run`.
//
// Wraps a real TmuxNamespace: read-only operations (list/show/display/
// has-session/capture style queries) delegate to the real namespace so
// the preview reflects live state; every MUTATING operation records its
// intent and does NOT execute, returning a benign success value.
// Classification is conservative — any method not positively known to
// be read-only is treated as mutating.
//
// Categories for the plan summary: `rename*` → rename, `kill*` → kill,
// every other mutation → other.

import { serializeSendTarget, serializeTarget, type TmuxNamespace } from "../abstractions/tmux.ts";
import type { Logger } from "./tui.ts";

export type DryRunOpCategory = "rename" | "kill" | "other";

export interface DryRunOp {
  readonly category: DryRunOpCategory;
  /** One-line tmux-shaped intent, e.g. `kill-window -t atx:old`. */
  readonly description: string;
}

/** Wrap `real` so reads pass through and writes are recorded, never executed. */
export function createDryRunTmux(real: TmuxNamespace, ops: DryRunOp[] = []): TmuxNamespace {
  const record = (category: DryRunOpCategory, description: string): void => {
    ops.push({ category, description });
  };
  return {
    session: {
      newSession: async (opts) => {
        record(
          "other",
          `new-session -s ${opts.name}` +
            (opts.windowName !== undefined ? ` -n ${opts.windowName}` : ""),
        );
      },
      hasSession: (name) => real.session.hasSession(name),
      killSession: async (name) => {
        record("kill", `kill-session -t ${name}`);
      },
      listSessions: () => real.session.listSessions(),
      renameSession: async (oldName, newName) => {
        record("rename", `rename-session ${oldName} → ${newName}`);
      },
      setEnvironment: async (opts) => {
        record(
          "other",
          `set-environment${opts.target !== undefined ? ` -t ${opts.target}` : ""} ` +
            (opts.unset === true ? `-u ${opts.name}` : `${opts.name}=${opts.value ?? ""}`),
        );
      },
    },
    window: {
      newWindow: async (opts) => {
        record(
          "other",
          `new-window -s ${opts.sessionName}${opts.name !== undefined ? ` -n ${opts.name}` : ""}`,
        );
        // Benign synthetic id — reconcile re-lists live state after
        // creation, so this value is never consumed as a real index.
        return { sessionName: opts.sessionName, windowIndex: 0 };
      },
      killWindow: async (target) => {
        record("kill", `kill-window -t ${serializeTarget(target)}`);
      },
      listWindows: (sessionName) => real.window.listWindows(sessionName),
      renameWindow: async (target, name) => {
        record("rename", `rename-window -t ${serializeTarget(target)} ${name}`);
      },
      selectWindow: async (target) => {
        record("other", `select-window -t ${serializeTarget(target)}`);
      },
      moveWindow: async (opts) => {
        // `-k` destroys whatever window occupies the target slot, so it
        // counts as a kill for the ban-lift preflight (t-6a6828f5).
        record(
          opts.kill === true ? "kill" : "other",
          `move-window -s ${serializeTarget(opts.source)} -t ${serializeTarget(opts.target)}` +
            (opts.kill === true ? " -k" : ""),
        );
      },
      swapWindow: async (opts) => {
        record(
          "other",
          `swap-window -s ${serializeTarget(opts.source)} -t ${serializeTarget(opts.target)}`,
        );
      },
    },
    pane: {
      sendKeys: async (opts) => {
        record(
          "other",
          `send-keys -t ${serializeSendTarget(opts.target)} (${opts.keys.length} chars)`,
        );
      },
      capturePane: (opts) => real.pane.capturePane(opts),
      listPanes: (target) => real.pane.listPanes(target),
      displayMessage: (opts) => real.pane.displayMessage(opts),
      killPane: async (target) => {
        record("kill", `kill-pane -t ${serializeTarget(target)}`);
      },
      splitWindow: async (opts) => {
        const target = typeof opts.target === "string" ? opts.target : serializeTarget(opts.target);
        record("other", `split-window -t ${target}`);
        return { sessionName: "", windowIndex: 0, paneIndex: 0 };
      },
    },
    buffer: {
      loadBuffer: async (opts) => {
        record("other", `load-buffer${opts.name !== undefined ? ` -b ${opts.name}` : ""}`);
      },
      pasteBuffer: async (opts) => {
        record(
          "other",
          `paste-buffer -t ${serializeSendTarget(opts.target)}` +
            (opts.name !== undefined ? ` -b ${opts.name}` : ""),
        );
      },
      deleteBuffer: async (name) => {
        record("other", `delete-buffer -b ${name}`);
      },
    },
    client: {
      attachSession: async (name) => {
        record("other", `attach-session -t ${name}`);
      },
      attachSessionInheritStdio: async (name) => {
        record("other", `attach-session -t ${name} (inherit-stdio)`);
      },
      switchClient: async (opts) => {
        record("other", `switch-client -t ${opts.target}`);
      },
      listClients: () => real.client.listClients(),
    },
    option: {
      setOption: async (opts) => {
        record(
          "other",
          `set-option${opts.global === true ? " -g" : ""} ${opts.name} ${opts.value}`,
        );
      },
      showOptions: (opts) => real.option.showOptions(opts),
    },
    server: {
      hasServer: () => real.server.hasServer(),
      killServer: async () => {
        record("kill", "kill-server");
      },
    },
  };
}

/** `dry-run: N rename, M kill, K other operations (nothing executed)`. */
export function formatDryRunSummary(ops: ReadonlyArray<DryRunOp>): string {
  let rename = 0;
  let kill = 0;
  let other = 0;
  for (const op of ops) {
    if (op.category === "rename") rename += 1;
    else if (op.category === "kill") kill += 1;
    else other += 1;
  }
  return `dry-run: ${rename} rename, ${kill} kill, ${other} other operations (nothing executed)`;
}

/** Print one line per recorded op, then the summary line. */
export function printDryRunPlan(logger: Logger, ops: ReadonlyArray<DryRunOp>): void {
  for (const op of ops) {
    logger.log(`  · [dry-run] ${op.description}`);
  }
  logger.log(formatDryRunSummary(ops));
}
