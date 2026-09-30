// ADR-305 — `atmux topo` discovery walks the per-user socket tree
// (`/tmp/atmux-<uid>/<team>/sock`) for live cages and skips group servers
// (`grp-<group>`), which are not cages. REAL tmux server, real /tmp paths
// under this uid's own private root; everything created is removed.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import {
  ensurePrivateSocketDir,
  userCageSocketPath,
  userGroupSocketPath,
} from "../../../src/core/socket-dir.ts";
import { defaultDiscoveryIO } from "../../../src/verbs/topo-io.ts";
import {
  createCanonicalAtmuxTmux,
  PORTABLE_KEEPALIVE_COMMAND,
  setCanonicalAtmuxTmuxHome,
} from "../../helpers/tmux.ts";

setDefaultTimeout(30_000);

const HAS_TMUX = Bun.which("tmux") !== null;
const UID = process.getuid?.() ?? 0;
const TEAM = `topo305-${process.pid.toString(36)}`;
const cageSock = userCageSocketPath(TEAM, UID);
const groupSock = userGroupSocketPath(TEAM, UID);
let cage: TmuxNamespace;
let group: TmuxNamespace;
let restoreHome: (() => void) | null = null;
let home = "";

describe.skipIf(!HAS_TMUX)(
  "defaultDiscoveryIO().listAliveCageSockets — ADR-305 per-user tree",
  () => {
    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), "atmux-topo305-home-"));
      restoreHome = setCanonicalAtmuxTmuxHome(home);
      ensurePrivateSocketDir(cageSock);
      ensurePrivateSocketDir(groupSock);
      cage = createCanonicalAtmuxTmux({ socketPath: cageSock });
      group = createCanonicalAtmuxTmux({ socketPath: groupSock });
      await cage.session.newSession({
        name: TEAM,
        detached: true,
        shellCommand: PORTABLE_KEEPALIVE_COMMAND,
      });
      await group.session.newSession({
        name: TEAM,
        detached: true,
        shellCommand: PORTABLE_KEEPALIVE_COMMAND,
      });
    });

    afterAll(async () => {
      for (const t of [cage, group]) {
        try {
          await t.server.killServer();
        } catch {
          // already gone
        }
      }
      restoreHome?.();
      await rm(join(`/tmp/atmux-${UID}`, TEAM), { recursive: true, force: true });
      await rm(join(`/tmp/atmux-${UID}`, `grp-${TEAM}`), { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    });

    test("a live per-user cage is listed under its team name; its group server is not", async () => {
      const alive = await defaultDiscoveryIO().listAliveCageSockets();
      expect(alive).toContainEqual({ socket: cageSock, parent: TEAM, eid: null });
      expect(alive.some((e) => e.socket === groupSock)).toBe(false);
    });
  },
);
