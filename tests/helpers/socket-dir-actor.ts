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
//   bun socket-dir-actor.ts session-name <team.json>  the session doctor probes for a team
//   bun socket-dir-actor.ts doctor-race <json>  {socket, team, n, control}: the review-of-a9f96ac2
//       rename race — `control` dials through a hand copy of the revision-2 doctor gate
//       (negative control), then n runs each of the two real doctor dial sites;
//       counts how many reached a server carrying the planted AGENT marker /
//       legacy window
//
// Refusals are reported, never thrown: `{ ok: false, problem, message }`.

import { readFileSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createTmux } from "../../src/abstractions/tmux.ts";
import { getDefaultSocket } from "../../src/core/common.ts";
import { resolveTmuxBin } from "../../src/core/resolve-tmux-bin.ts";
import {
  ensurePrivateSocketDir,
  socketPathIssue,
  UnsafeSocketPathError,
} from "../../src/core/socket-dir.ts";
import { getAtmuxTmuxConfPath } from "../../src/core/tmux-paths.ts";
import type { Team } from "../../src/schema/team.ts";
import { ensurePrivateGroupSocket } from "../../src/verbs/cockpit.ts";
import { checkAgentShellEnv } from "../../src/verbs/doctor/agent-env.ts";
import { checkLegacyWindowNameFormat, probeSessionName } from "../../src/verbs/doctor/cockpit.ts";

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
      case "session-name": {
        const team = JSON.parse(readFileSync(arg, "utf8")) as Team;
        out({ ok: true, session: await probeSessionName(team, {}) });
        return;
      }
      case "doctor-race": {
        const { socket, team, n, control: controlN } = JSON.parse(arg) as {
          socket: string;
          team: Team;
          n: number;
          control: number;
        };
        // Negative control: revision 2's doctor gate, by hand — the socket
        // file exists, the inspect-only walk finds no issue (a missing
        // directory counts as safe), then a raw dial.
        let control = 0;
        const tmuxBin = resolveTmuxBin();
        for (let i = 0; i < controlN; i++) {
          const isSock = await stat(socket).then(
            (s) => s.isSocket(),
            () => false,
          );
          if (!isSock || socketPathIssue(socket) !== null) continue;
          const r = Bun.spawnSync([tmuxBin, "-S", socket, "show-environment", "-g"]);
          if (r.stdout.toString().includes("AGENT=")) control++;
        }
        // The real doctor dial sites, with every default.
        let agentEnv = 0;
        let legacy = 0;
        for (let i = 0; i < n; i++) {
          agentEnv += (await checkAgentShellEnv(null, { sockets: [{ socket, owner: "race" }] }))
            .length;
          legacy += (await checkLegacyWindowNameFormat(team, { loadCockpitFn: async () => null }))
            .length;
        }
        out({ ok: true, control, agentEnv, legacy });
        return;
      }
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
