// ADR-004: typed tmux subcommand wrapper.
//
// Every method is a thin shell of argv-construction + `spawn()` call +
// parse. All shellouts go through `spawn()` (R4); raw `Bun.spawn` is
// forbidden here as in every other module except `src/abstractions/spawn.ts`.
// Failure → `TmuxError` (per ADR-006) with full argv + stderr captured.
//
// Socket injection (ADR-004 amend, 2026-05-05).
// --------------------------------------------
// Every tmux subprocess is pinned to an explicit socket via `-L <name>`
// or `-S <abspath>` prepended to argv. There is NO top-level `tmux`
// singleton — callers obtain a namespace via `createTmux({ socket })` or
// `createTmux({ socketPath })`, the factory captures the socket flag in a
// closure, every internal `spawn({ cmd: "tmux", argv: [...] })` is built
// from `[...socketArgs, ...subcmdArgv]`. This makes it physically
// impossible for any path through the abstraction to reach the
// operator's daily-driver tmux server (which is what the env-only
// `TMUX_TMPDIR` fix failed to guarantee — incident 2026-05-05 01:44 MYT,
// memory ref `feedback_tmux_test_isolation.md`).

import { TmuxError } from "../errors.ts";
import { type ExpectExitCode, spawn } from "./spawn.ts";

// ---------- Target IDs ----------

export interface PaneId {
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
}

export interface WindowId {
  sessionName: string;
  windowIndex: number;
}

/** tmux's `session:window.pane` target spec, or a structured id we serialize. */
export type Target = PaneId | WindowId | string;

export function serializeTarget(t: Target): string {
  if (typeof t === "string") return t;
  if ("paneIndex" in t) return `${t.sessionName}:${t.windowIndex}.${t.paneIndex}`;
  return `${t.sessionName}:${t.windowIndex}`;
}

// ---------- Output parsing ----------

/** Split stdout into rows, drop blank trailing line, split by `\t`. */
export function parseTabular(
  stdout: string,
  fields: ReadonlyArray<string>,
): Record<string, string>[] {
  const lines = stdout
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.length > 0);
  return lines.map((line) => {
    const cols = line.split("\t");
    const out: Record<string, string> = {};
    fields.forEach((name, i) => {
      out[name] = cols[i] ?? "";
    });
    return out;
  });
}

// ---------- Pure parse helpers (extracted for testability) ----------

/**
 * Parse a single integer from `tmux new-window -P -F '#{window_index}'`
 * stdout. Throws `TmuxError` if tmux returns garbage (defensive branch
 * — shouldn't happen against real tmux, but the parse needs to be safe).
 *
 * Exported for direct unit-testing of the throw branch without needing
 * to reproduce tmux misbehaviour.
 */
export function parseWindowIndexOrThrow(
  stdout: string,
  argv: ReadonlyArray<string>,
  exitCode: number,
): number {
  const windowIndex = Number.parseInt(stdout.trim(), 10);
  if (!Number.isFinite(windowIndex)) {
    throw new TmuxError({
      argv,
      exitCode,
      stderr: `unparseable window_index from new-window: ${JSON.stringify(stdout)}`,
      stdout,
    });
  }
  return windowIndex;
}

/**
 * Parse `{window_index, pane_index}` tab-separated output from
 * `tmux split-window -P -F '#{window_index}\t#{pane_index}'`. Throws
 * `TmuxError` on unparseable input. Exported for the same testability
 * reason as `parseWindowIndexOrThrow`.
 */
export function parseSplitWindowIdsOrThrow(
  stdout: string,
  argv: ReadonlyArray<string>,
  exitCode: number,
): { windowIndex: number; paneIndex: number } {
  const [w, p] = stdout.trim().split("\t");
  const windowIndex = Number.parseInt(w ?? "", 10);
  const paneIndex = Number.parseInt(p ?? "", 10);
  if (!Number.isFinite(windowIndex) || !Number.isFinite(paneIndex)) {
    throw new TmuxError({
      argv,
      exitCode,
      stderr: `unparseable {window_index, pane_index} from split-window: ${JSON.stringify(stdout)}`,
      stdout,
    });
  }
  return { windowIndex, paneIndex };
}

/** Map a single `list-clients` parseTabular row to a typed client record.
 *  Extracted so tests can hit the inner-map branch without needing a
 *  TTY-attached client (which is impractical from a non-TTY test process). */
export function clientRowToObject(row: Record<string, string>): {
  name: string;
  session: string;
  tty: string;
} {
  return {
    name: row.name ?? "",
    session: row.session ?? "",
    tty: row.tty ?? "",
  };
}

// ---------- Socket configuration ----------

/**
 * Socket-pinning + (optional) config-pinning for `createTmux`.
 *
 * **Socket** — discriminated by which key is present (TS `?: never`
 * enforces exactly-one at compile time):
 *
 * - `{ socket }` → `tmux -L <name> ...` (resolves under `$TMUX_TMPDIR`
 *   or `/tmp/tmux-<uid>/`); use this for ADR-018-style cage topology
 *   where the team binds a short-name socket under a per-team tmpdir.
 * - `{ socketPath }` → `tmux -S <abs-path> ...` (exact absolute socket
 *   path); use this for tests, ad-hoc isolation, or anywhere the caller
 *   needs full control over the socket file location.
 *
 * Either form makes the socket selection independent of inherited `$TMUX`
 * / `$TMUX_TMPDIR` env state — env-level isolation is belt-and-braces, the
 * socket flag is the load-bearing guarantee.
 *
 * **Config (optional)** — `configFile?: string` adds `-f <path>` after the
 * socket flag on every invocation. Production code omits this to inherit
 * the operator's `~/.tmux.conf`; tests + the parity harness pass
 * `configFile: "/dev/null"` to make tmux behaviour reproducible regardless
 * of operator config (e.g. `base-index`, `pane-base-index`, key-bindings).
 * The same physical-impossibility argument as socket-pinning: with
 * `-f /dev/null` baked into argv, no test path can pick up an out-of-band
 * `~/.tmux.conf` setting.
 */
type SocketConfig =
  | { readonly socket: string; readonly socketPath?: never }
  | { readonly socketPath: string; readonly socket?: never };

export type TmuxConfig = SocketConfig & {
  /** Optional `-f <path>` flag appended after the socket flag. Tests pass
   *  `/dev/null` for reproducibility; production omits to use `~/.tmux.conf`. */
  readonly configFile?: string;
};

// ---------- Public namespace shape ----------

export interface TmuxNamespace {
  readonly session: {
    newSession(opts: {
      name: string;
      detached?: boolean;
      cwd?: string;
      windowName?: string;
      shellCommand?: string;
    }): Promise<void>;
    hasSession(name: string): Promise<boolean>;
    killSession(name: string): Promise<void>;
    listSessions(): Promise<{ name: string; windows: number; created: number }[]>;
    renameSession(oldName: string, newName: string): Promise<void>;
  };
  readonly window: {
    newWindow(opts: {
      sessionName: string;
      name?: string;
      cwd?: string;
      shellCommand?: string;
      detached?: boolean;
    }): Promise<WindowId>;
    killWindow(target: Target): Promise<void>;
    listWindows(sessionName: string): Promise<{ index: number; name: string; active: boolean }[]>;
    renameWindow(target: Target, name: string): Promise<void>;
    selectWindow(target: Target): Promise<void>;
  };
  readonly pane: {
    sendKeys(opts: {
      target: Target;
      keys: string;
      literal?: boolean;
      enter?: boolean;
    }): Promise<void>;
    capturePane(opts: {
      target: Target;
      start?: number;
      end?: number;
      includeAnsi?: boolean;
    }): Promise<string>;
    listPanes(
      target: Target,
    ): Promise<{ index: number; pid: number; title: string; width: number; height: number }[]>;
    displayMessage(opts: { target: Target; format: string; print?: boolean }): Promise<string>;
    killPane(target: Target): Promise<void>;
    splitWindow(opts: {
      target: WindowId | string;
      vertical?: boolean;
      detached?: boolean;
      cwd?: string;
      shellCommand?: string;
    }): Promise<PaneId>;
  };
  readonly buffer: {
    loadBuffer(opts: { name?: string; data: string }): Promise<void>;
    pasteBuffer(opts: { name?: string; target: Target; deleteAfter?: boolean }): Promise<void>;
    deleteBuffer(name: string): Promise<void>;
  };
  readonly client: {
    attachSession(name: string): Promise<void>;
    switchClient(opts: { target: string; clientName?: string }): Promise<void>;
    listClients(): Promise<{ name: string; session: string; tty: string }[]>;
  };
  readonly option: {
    setOption(opts: {
      name: string;
      value: string;
      target?: string;
      global?: boolean;
      window?: boolean;
    }): Promise<void>;
    showOptions(opts?: {
      target?: string;
      global?: boolean;
      window?: boolean;
    }): Promise<Record<string, string>>;
  };
  readonly server: {
    hasServer(): Promise<boolean>;
    killServer(): Promise<void>;
  };
}

// ---------- Factory ----------

interface RawResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Build a tmux namespace pinned to the given socket. Every method on the
 * returned namespace prepends `-L <name>` (if `config.socket`) or
 * `-S <abs-path>` (if `config.socketPath`) to its tmux invocation.
 *
 * There is intentionally no zero-arg or default factory — every consumer
 * MUST decide which socket they're driving. See module header for the
 * incident motivation.
 */
export function createTmux(config: TmuxConfig): TmuxNamespace {
  // Build the global-flag prefix (socket + optional config-file) exactly
  // once; closure-captured below. `-L`/`-S` MUST come before any subcommand
  // — and `-f` is documented in tmux(1) as a global flag in the same slot.
  const socketArgs: ReadonlyArray<string> = (() => {
    const flags: string[] =
      typeof config.socket === "string" ? ["-L", config.socket] : ["-S", config.socketPath];
    if (typeof config.configFile === "string") {
      flags.push("-f", config.configFile);
    }
    return flags;
  })();

  async function tmuxRun(subArgv: ReadonlyArray<string>): Promise<RawResult> {
    return tmuxRunRaw(subArgv, 0);
  }

  async function tmuxRunRaw(
    subArgv: ReadonlyArray<string>,
    expect: ExpectExitCode,
  ): Promise<RawResult> {
    const argv = [...socketArgs, ...subArgv];
    try {
      const r = await spawn({ cmd: "tmux", argv, expectExitCode: expect });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    } catch (e) {
      // Map any thrown error → TmuxError so ADR-006 §tag-by-subsystem holds.
      // SpawnError / SpawnTimeoutError carry a `context` object with the
      // detailed stderr/stdout/exitCode; non-spawn-shaped errors (which
      // shouldn't happen against the spawn abstraction but the catch is
      // type-`unknown`) fall back to message-as-stderr. Single throw path
      // — both shape branches collapse into one wrap so coverage tracks
      // them uniformly.
      const ctx: Record<string, unknown> | null =
        typeof e === "object" &&
        e !== null &&
        "context" in e &&
        typeof (e as { context?: unknown }).context === "object" &&
        (e as { context: unknown }).context !== null
          ? (e as { context: Record<string, unknown> }).context
          : null;
      // Non-spawn-shaped throws collapse `stderr` to `String(e)` —
      // `Error.toString()` already prepends "Error: " to the message, so
      // information is preserved without an extra `instanceof Error`
      // branch (which would be untestable without mocking `spawn` to
      // reject with a plain Error, and `spawn` always wraps in SpawnError).
      throw new TmuxError({
        argv,
        exitCode: ctx && typeof ctx.exitCode === "number" ? ctx.exitCode : -1,
        stderr: ctx && typeof ctx.stderr === "string" ? ctx.stderr : String(e),
        stdout: ctx && typeof ctx.stdout === "string" ? ctx.stdout : "",
        cause: e,
      });
    }
  }

  return {
    // ============== session ==============

    session: {
      /** `tmux new-session -d -s <name> [-c <cwd>] [-n <window>]`. */
      async newSession(opts) {
        const argv = ["new-session"];
        if (opts.detached ?? true) argv.push("-d");
        argv.push("-s", opts.name);
        if (opts.cwd) argv.push("-c", opts.cwd);
        if (opts.windowName) argv.push("-n", opts.windowName);
        if (opts.shellCommand) argv.push(opts.shellCommand);
        await tmuxRun(argv);
      },

      /** `tmux has-session -t <name>` — exits 0 if exists, 1 if not, >1 on error. */
      async hasSession(name) {
        const r = await tmuxRunRaw(["has-session", "-t", name], [0, 1]);
        return r.exitCode === 0;
      },

      /** `tmux kill-session -t <name>`. */
      async killSession(name) {
        await tmuxRun(["kill-session", "-t", name]);
      },

      /** `tmux list-sessions -F '#{session_name}\t#{session_windows}\t#{session_created}'`. */
      async listSessions() {
        const fmt = "#{session_name}\t#{session_windows}\t#{session_created}";
        // tmux returns exit 1 with no stdout when no sessions exist; treat as []
        const r = await tmuxRunRaw(["list-sessions", "-F", fmt], [0, 1]);
        if (r.exitCode === 1 && r.stdout.length === 0) return [];
        return parseTabular(r.stdout, ["name", "windows", "created"]).map((row) => ({
          name: row.name ?? "",
          windows: Number.parseInt(row.windows ?? "0", 10) || 0,
          created: Number.parseInt(row.created ?? "0", 10) || 0,
        }));
      },

      /** `tmux rename-session -t <oldName> <newName>`. */
      async renameSession(oldName, newName) {
        await tmuxRun(["rename-session", "-t", oldName, newName]);
      },
    },

    // ============== window ==============

    window: {
      /** `tmux new-window -t <session>: [-n <name>] [-c <cwd>] [-d] -P -F '#{window_index}' [<shellCommand>]`.
       *  Returns the new window's `WindowId` (resolved via `-P -F`); avoids
       *  a list-windows race with concurrent window creation. */
      async newWindow(opts) {
        const argv = ["new-window", "-t", `${opts.sessionName}:`];
        if (opts.detached ?? true) argv.push("-d");
        if (opts.name) argv.push("-n", opts.name);
        if (opts.cwd) argv.push("-c", opts.cwd);
        argv.push("-P", "-F", "#{window_index}");
        if (opts.shellCommand) argv.push(opts.shellCommand);
        const r = await tmuxRun(argv);
        const windowIndex = parseWindowIndexOrThrow(r.stdout, [...socketArgs, ...argv], r.exitCode);
        return { sessionName: opts.sessionName, windowIndex };
      },

      /** `tmux kill-window -t <target>`. */
      async killWindow(target) {
        await tmuxRun(["kill-window", "-t", serializeTarget(target)]);
      },

      /** `tmux list-windows -t <session> -F '#{window_index}\t#{window_name}\t#{window_active}'`. */
      async listWindows(sessionName) {
        const fmt = "#{window_index}\t#{window_name}\t#{window_active}";
        const r = await tmuxRunRaw(["list-windows", "-t", sessionName, "-F", fmt], [0, 1]);
        if (r.exitCode === 1 && r.stdout.length === 0) return [];
        return parseTabular(r.stdout, ["index", "name", "active"]).map((row) => ({
          index: Number.parseInt(row.index ?? "0", 10) || 0,
          name: row.name ?? "",
          active: row.active === "1",
        }));
      },

      /** `tmux rename-window -t <target> <name>`. */
      async renameWindow(target, name) {
        await tmuxRun(["rename-window", "-t", serializeTarget(target), name]);
      },

      /** `tmux select-window -t <target>`. */
      async selectWindow(target) {
        await tmuxRun(["select-window", "-t", serializeTarget(target)]);
      },
    },

    // ============== pane ==============

    pane: {
      /** `tmux send-keys -t <target> [-l] <keys> [Enter]`. */
      async sendKeys(opts) {
        const argv = ["send-keys", "-t", serializeTarget(opts.target)];
        if (opts.literal) argv.push("-l");
        argv.push(opts.keys);
        if (opts.enter ?? true) argv.push("Enter");
        await tmuxRun(argv);
      },

      /** `tmux capture-pane -p -t <target> [-S start] [-E end] [-e]`. */
      async capturePane(opts) {
        const argv = ["capture-pane", "-p", "-t", serializeTarget(opts.target)];
        if (opts.start !== undefined) argv.push("-S", String(opts.start));
        if (opts.end !== undefined) argv.push("-E", String(opts.end));
        if (opts.includeAnsi) argv.push("-e");
        const r = await tmuxRun(argv);
        return r.stdout;
      },

      /**
       * `tmux list-panes -t <target> -F '#{pane_index}\t#{pane_pid}\t#{pane_title}\t#{pane_width}\t#{pane_height}'`.
       */
      async listPanes(target) {
        const fmt = "#{pane_index}\t#{pane_pid}\t#{pane_title}\t#{pane_width}\t#{pane_height}";
        const r = await tmuxRunRaw(
          ["list-panes", "-t", serializeTarget(target), "-F", fmt],
          [0, 1],
        );
        if (r.exitCode === 1 && r.stdout.length === 0) return [];
        return parseTabular(r.stdout, ["index", "pid", "title", "width", "height"]).map((row) => ({
          index: Number.parseInt(row.index ?? "0", 10) || 0,
          pid: Number.parseInt(row.pid ?? "0", 10) || 0,
          title: row.title ?? "",
          width: Number.parseInt(row.width ?? "0", 10) || 0,
          height: Number.parseInt(row.height ?? "0", 10) || 0,
        }));
      },

      /** `tmux display-message [-p] -t <target> '<format>'`. */
      async displayMessage(opts) {
        const argv = ["display-message"];
        if (opts.print ?? true) argv.push("-p");
        argv.push("-t", serializeTarget(opts.target), opts.format);
        const r = await tmuxRun(argv);
        return r.stdout.replace(/\n$/, "");
      },

      /** `tmux kill-pane -t <target>`. */
      async killPane(target) {
        await tmuxRun(["kill-pane", "-t", serializeTarget(target)]);
      },

      /** `tmux split-window -t <target> [-v|-h] [-d] [-c <cwd>] -P -F '#{window_index}\t#{pane_index}' [<shellCommand>]`.
       *  Returns the new pane's `PaneId`. tmux defaults to horizontal (`-h`,
       *  side-by-side); pass `vertical: true` for top/bottom (`-v`). */
      async splitWindow(opts) {
        const argv = ["split-window"];
        if (opts.detached ?? true) argv.push("-d");
        argv.push(opts.vertical ? "-v" : "-h");
        argv.push("-t", serializeTarget(opts.target));
        if (opts.cwd) argv.push("-c", opts.cwd);
        argv.push("-P", "-F", "#{window_index}\t#{pane_index}");
        if (opts.shellCommand) argv.push(opts.shellCommand);
        const r = await tmuxRun(argv);
        const { windowIndex, paneIndex } = parseSplitWindowIdsOrThrow(
          r.stdout,
          [...socketArgs, ...argv],
          r.exitCode,
        );
        // sessionName resolution: if target is structured, take its sessionName;
        // otherwise (raw string), parse the leading session segment.
        const sessionName =
          typeof opts.target === "string"
            ? (opts.target.split(":")[0] ?? "")
            : opts.target.sessionName;
        return { sessionName, windowIndex, paneIndex };
      },
    },

    // ============== buffer ==============

    buffer: {
      /** `tmux load-buffer [-b <name>] -` (data piped via stdin).
       *  Calls `spawn` directly (rather than via `tmuxRun`) because we need
       *  to pipe stdin. Socket prefix is hand-prepended so this path
       *  carries the same socket-pinning guarantee as the rest. */
      async loadBuffer(opts) {
        const subArgv = ["load-buffer"];
        if (opts.name) subArgv.push("-b", opts.name);
        subArgv.push("-");
        const argv = [...socketArgs, ...subArgv];
        try {
          await spawn({ cmd: "tmux", argv, stdin: opts.data, expectExitCode: 0 });
        } catch (e) {
          const ctx =
            typeof e === "object" && e !== null && "context" in e
              ? ((e as { context: Record<string, unknown> }).context ?? {})
              : {};
          throw new TmuxError({
            argv,
            exitCode: typeof ctx.exitCode === "number" ? ctx.exitCode : -1,
            stderr: typeof ctx.stderr === "string" ? ctx.stderr : "",
            cause: e,
          });
        }
      },

      /** `tmux paste-buffer [-b <name>] [-d] -t <target>`. */
      async pasteBuffer(opts) {
        const argv = ["paste-buffer"];
        if (opts.name) argv.push("-b", opts.name);
        if (opts.deleteAfter) argv.push("-d");
        argv.push("-t", serializeTarget(opts.target));
        await tmuxRun(argv);
      },

      /** `tmux delete-buffer -b <name>`. */
      async deleteBuffer(name) {
        await tmuxRun(["delete-buffer", "-b", name]);
      },
    },

    // ============== client ==============

    client: {
      /** `tmux attach-session -t <name>`. Note: blocks until detached. */
      async attachSession(name) {
        await tmuxRun(["attach-session", "-t", name]);
      },

      /** `tmux switch-client [-c <client>] -t <target>`. */
      async switchClient(opts) {
        const argv = ["switch-client"];
        if (opts.clientName) argv.push("-c", opts.clientName);
        argv.push("-t", opts.target);
        await tmuxRun(argv);
      },

      /** `tmux list-clients -F '#{client_name}\t#{client_session}\t#{client_tty}'`. */
      async listClients() {
        const fmt = "#{client_name}\t#{client_session}\t#{client_tty}";
        const r = await tmuxRunRaw(["list-clients", "-F", fmt], [0, 1]);
        if (r.exitCode === 1 && r.stdout.length === 0) return [];
        return parseTabular(r.stdout, ["name", "session", "tty"]).map(clientRowToObject);
      },
    },

    // ============== option ==============

    option: {
      /** `tmux set-option [-g|-w] [-t <target>] <name> <value>`. */
      async setOption(opts) {
        const argv = ["set-option"];
        if (opts.global) argv.push("-g");
        if (opts.window) argv.push("-w");
        if (opts.target) argv.push("-t", opts.target);
        argv.push(opts.name, opts.value);
        await tmuxRun(argv);
      },

      /** `tmux show-options [-g|-w] [-t <target>]` → `Record<name, value>`. */
      async showOptions(opts) {
        const argv = ["show-options"];
        if (opts?.global) argv.push("-g");
        if (opts?.window) argv.push("-w");
        if (opts?.target) argv.push("-t", opts.target);
        const r = await tmuxRun(argv);
        const out: Record<string, string> = {};
        for (const line of r.stdout.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const sp = trimmed.indexOf(" ");
          if (sp === -1) continue;
          const name = trimmed.slice(0, sp);
          let value = trimmed.slice(sp + 1).trim();
          // Unwrap surrounding quotes (tmux's option-format quotes string values)
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
          }
          out[name] = value;
        }
        return out;
      },
    },

    // ============== server ==============

    server: {
      /** True if a tmux server is responsive on this socket and has at
       *  least one session. tmux semantics: the server exits when its last
       *  session closes, so "has session(s)" is equivalent to "server up"
       *  for atmux's usage (every team always has at least its lead
       *  window). Probed via `list-sessions` exit code — `tmux info`
       *  was the original ADR sketch but exits 1 in non-TTY contexts
       *  even with a healthy server (empirically validated, tmux 3.4). */
      async hasServer() {
        const r = await tmuxRunRaw(["list-sessions"], "any");
        return r.exitCode === 0;
      },

      /** `tmux kill-server`. Scoped to this namespace's socket — by
       *  construction, cannot reach the operator's daily-driver server. */
      async killServer() {
        await tmuxRunRaw(["kill-server"], "any");
      },
    },
  };
}
