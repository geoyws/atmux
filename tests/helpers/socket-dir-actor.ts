// ADR-305 two-uid e2e actor — run as a specific uid (via `setpriv`) by
// tests/e2e/socket-dir-two-uid.test.ts. Exercises the REAL atmux socket
// code as that uid and prints exactly one JSON line on stdout.
//
//   bun socket-dir-actor.ts cage <team>        ensure + start a cage server on the team default
//   bun socket-dir-actor.ts group <group>      ensure + start a group server (reconcile's path)
//   bun socket-dir-actor.ts resolve <team>     print the team's default socket
//   bun socket-dir-actor.ts ensure <sockPath>  ensurePrivateSocketDir only
//   bun socket-dir-actor.ts probe <sockPath>   createTmux(...).hasSession through the guard
//   bun socket-dir-actor.ts kill <sockPath>    kill-server through the guard
//
// Refusals are reported, never thrown: `{ ok: false, problem, message }`.

import { statSync } from "node:fs";
import { dirname } from "node:path";
import { createTmux } from "../../src/abstractions/tmux.ts";
import { getDefaultSocket } from "../../src/core/common.ts";
import { ensurePrivateSocketDir, UnsafeSocketPathError } from "../../src/core/socket-dir.ts";
import { getAtmuxTmuxConfPath } from "../../src/core/tmux-paths.ts";
import { ensurePrivateGroupSocket } from "../../src/verbs/cockpit.ts";

function out(v: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ uid: process.getuid?.(), ...v })}\n`);
}

function mode(p: string): string {
  return `0${(statSync(p).mode & 0o777).toString(8)}`;
}

function tmuxAt(socketPath: string) {
  return createTmux({ socketPath, configFile: getAtmuxTmuxConfPath() });
}

async function startServer(sock: string, session: string): Promise<void> {
  await tmuxAt(sock).session.newSession({
    name: session,
    detached: true,
    shellCommand: "sleep 600",
  });
}

async function main(verb: string, arg: string): Promise<void> {
  try {
    switch (verb) {
      case "cage": {
        const sock = getDefaultSocket(arg);
        ensurePrivateSocketDir(sock);
        await startServer(sock, arg);
        out({
          ok: true,
          sock,
          dirMode: mode(dirname(sock)),
          rootMode: mode(dirname(dirname(sock))),
          sockMode: mode(sock),
        });
        return;
      }
      case "group": {
        const sock = await ensurePrivateGroupSocket(arg, { log: () => {} });
        await startServer(sock, arg);
        out({ ok: true, sock, dirMode: mode(dirname(sock)) });
        return;
      }
      case "resolve":
        out({ ok: true, sock: getDefaultSocket(arg) });
        return;
      case "ensure":
        ensurePrivateSocketDir(arg);
        out({ ok: true, dirMode: mode(dirname(arg)) });
        return;
      case "probe":
        out({ ok: true, has: await tmuxAt(arg).session.hasSession("=probe") });
        return;
      case "kill":
        await tmuxAt(arg).server.killServer();
        out({ ok: true });
        return;
      default:
        out({ ok: false, problem: "usage", message: `unknown verb ${verb}` });
    }
  } catch (e) {
    if (e instanceof UnsafeSocketPathError) {
      out({ ok: false, problem: e.issue.problem, path: e.issue.path, message: e.message });
      return;
    }
    out({ ok: false, problem: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

await main(process.argv[2] ?? "", process.argv[3] ?? "");
