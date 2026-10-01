// ADR-305 §D2: `atmux socket-dial <socket> <tmux-args…>` — how a shell
// loop dials an atmux tmux socket (the cockpit's viewer retry-loops, the
// bau skill). A shell test such as `[ -S s ] && [ -O s ] && tmux -S s`
// follows symlinks and checks only the socket node, so a directory
// another uid can rename lets that uid swap the path between the test
// and the dial (measured: 80 of 300 guarded dials reached the other
// uid's server). This verb instead walks the socket's whole directory
// chain with descriptors (`core/socket-dir.ts::prepareSocketDial`) and
// hands tmux the path only when no other uid can re-point any component.
//
// Exit codes: tmux's own when it dialled; 1 when there is no socket to
// dial (nothing was run — a viewer loop falls through to its next
// candidate); 78 (EX_CONFIG) when the path is unsafe (nothing was run);
// 64 on bad usage.
//
// Its sibling `atmux socket-rmdir <dir>` (ADR-305 revision 4) is how a
// shell or an agent prompt removes a dead fixture's socket directory:
// `[ -O "$DIR" ] && rm -rf "$DIR"` checks a path, then acts on a path.
// This verb walks the same chain, requires the directory to be ours
// alone, and removes it relative to the held parent descriptor. Exit 0
// removed, 1 absent, 78 unsafe (nothing removed), 64 bad usage.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnInheritStdio } from "../abstractions/spawn.ts";
import { TMUX_CHILD_UNSET_ENV } from "../abstractions/tmux.ts";
import { resolveTmuxBin } from "../core/resolve-tmux-bin.ts";
import { prepareSocketDial, removePrivateTree, type SocketDirOpts } from "../core/socket-dir.ts";
import { posixQuote } from "../core/tui-cmd.ts";
import { UsageError } from "../errors.ts";

/** Exit code when there is no socket of ours to dial. */
export const SOCKET_DIAL_ABSENT = 1;

export interface SocketDialDeps extends SocketDirOpts {
  /** Runs tmux with inherited stdio; resolves to its exit code. */
  spawn?: (cmd: string, argv: string[]) => Promise<number>;
  tmuxBin?: () => string;
}

export async function socketDial(
  argv: ReadonlyArray<string>,
  deps: SocketDialDeps = {},
): Promise<number> {
  const [socket, ...tmuxArgs] = argv;
  if (socket === undefined || socket === "" || socket.startsWith("-") || tmuxArgs.length === 0) {
    throw new UsageError({
      what: "socket-dial needs a socket path and the tmux arguments to run against it",
      hint: "usage: atmux socket-dial <socket> <tmux-args…>",
    });
  }
  // Throws UnsafeSocketPathError (exit 78) before anything is dialled.
  if (!prepareSocketDial(socket, deps)) return SOCKET_DIAL_ABSENT;
  const run = deps.spawn ?? defaultSpawn;
  // t-48cef478: `-u` forces UTF-8 on the client (POSIX-locale TAB→`_`
  // corruption). It is injected here — not in the caller's tmuxArgs string —
  // so every viewer-loop dial (`attach -t …` via socketDialCommand) is
  // covered by this one site; global flags precede the subcommand.
  return run((deps.tmuxBin ?? resolveTmuxBin)(), ["-u", "-S", socket, ...tmuxArgs]);
}

/** `atmux socket-rmdir <dir>` — see the module header. Throws
 *  `UnsafeSocketPathError` (exit 78) when the directory is not ours
 *  alone; nothing is removed then. */
export async function socketRmdir(
  argv: ReadonlyArray<string>,
  deps: SocketDirOpts = {},
): Promise<number> {
  const [dir, ...rest] = argv;
  if (dir === undefined || dir === "" || dir.startsWith("-") || rest.length > 0) {
    throw new UsageError({
      what: "socket-rmdir needs exactly one socket directory",
      hint: "usage: atmux socket-rmdir <dir>",
    });
  }
  return removePrivateTree(dir, deps) ? 0 : SOCKET_DIAL_ABSENT;
}

function defaultSpawn(cmd: string, argv: string[]): Promise<number> {
  return spawnInheritStdio({ cmd, argv, unsetEnv: TMUX_CHILD_UNSET_ENV });
}

export interface AtmuxSelfCommandDeps {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  /** The checkout entry point (`<repo>/bin/atmux`). */
  entry?: string;
  exists?: (path: string) => boolean;
}

/**
 * Shell words that run THIS atmux build, so a long-lived viewer loop
 * never dials through an older atmux on `PATH` that lacks `socket-dial`:
 * `ATMUX_BIN` when set; else `bun <repo>/bin/atmux` from a checkout;
 * else the compiled binary itself (`process.execPath`).
 */
export function atmuxSelfCommand(deps: AtmuxSelfCommandDeps = {}): string {
  const override = (deps.env ?? process.env).ATMUX_BIN?.trim();
  if (override !== undefined && override !== "") return posixQuote(override);
  const execPath = deps.execPath ?? process.execPath;
  const entry = deps.entry ?? join(import.meta.dir, "..", "..", "bin", "atmux");
  return (deps.exists ?? existsSync)(entry)
    ? `${posixQuote(execPath)} ${posixQuote(entry)}`
    : posixQuote(execPath);
}

/** `{ <atmux> socket-dial <sock> <tmuxArgs> 2>/dev/null; }` — one
 *  dial of a shell retry-loop. Exit 1 (no socket) or 78 (unsafe) lets
 *  the loop's `||` fall through without tmux ever running. */
export function socketDialCommand(sock: string, tmuxArgs: string): string {
  return `{ ${atmuxSelfCommand()} socket-dial ${posixQuote(sock)} ${tmuxArgs} 2>/dev/null; }`;
}
