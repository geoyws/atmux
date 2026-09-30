// ADR-305 — group servers get per-user private sockets too
// (src/verbs/cockpit.ts::ensurePrivateGroupSocket, the create-time step of
// `reconcileGroupServers`). Before ADR-305 every user shared
// `/tmp/atmux-grp-<group>/sock`.

import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { ConfigError } from "../../../src/errors.ts";
import { ensurePrivateGroupSocket } from "../../../src/verbs/cockpit.ts";
import { type FakeNode, type FakeSocketFs, fakeSocketFs } from "../../helpers/fake-socket-fs.ts";

function fakeFs(initial: Record<string, FakeNode>, creatorUid: number): FakeSocketFs {
  return fakeSocketFs(initial, { creatorUid });
}

const logger = (): { log: (m: string) => void; logs: string[] } => {
  const logs: string[] = [];
  return { log: (m) => logs.push(m), logs };
};

describe("ensurePrivateGroupSocket (ADR-305)", () => {
  test("fresh group: /tmp/atmux-<uid>/grp-<group>/ created 0700, per-user socket returned", async () => {
    const fs = fakeFs({ "/tmp": { kind: "dir", uid: 0, mode: 0o1777 } }, 1000);
    const sock = await ensurePrivateGroupSocket("unum", logger(), { uid: 1000, fs });
    expect(sock).toBe("/tmp/atmux-1000/grp-unum/sock");
    expect(fs.nodes.get("/tmp/atmux-1000")).toEqual({ kind: "dir", uid: 1000, mode: 0o700 });
    expect(fs.nodes.get("/tmp/atmux-1000/grp-unum")).toEqual({
      kind: "dir",
      uid: 1000,
      mode: 0o700,
    });
  });

  test("two uids get two different group servers for the same group", async () => {
    const tmp = { "/tmp": { kind: "dir" as const, uid: 0, mode: 0o1777 } };
    const a = await ensurePrivateGroupSocket("g", logger(), { uid: 1000, fs: fakeFs(tmp, 1000) });
    const b = await ensurePrivateGroupSocket("g", logger(), { uid: 1001, fs: fakeFs(tmp, 1001) });
    expect(a).toBe("/tmp/atmux-1000/grp-g/sock");
    expect(b).toBe("/tmp/atmux-1001/grp-g/sock");
  });

  test("dead private pre-ADR-305 group socket → removed, moved to the per-user path", async () => {
    const fs = fakeFs(
      {
        "/tmp": { kind: "dir", uid: 0, mode: 0o1777 },
        "/tmp/atmux-grp-g": { kind: "dir", uid: 1000, mode: 0o700 },
        "/tmp/atmux-grp-g/sock": { kind: "socket", uid: 1000, mode: 0o660 },
      },
      1000,
    );
    const removed: string[] = [];
    const lg = logger();
    const sock = await ensurePrivateGroupSocket("g", lg, {
      uid: 1000,
      fs,
      isListening: async () => false,
      remove: (p) => removed.push(p),
    });
    expect(sock).toBe("/tmp/atmux-1000/grp-g/sock");
    expect(removed).toEqual(["/tmp/atmux-grp-g/sock"]);
    expect(lg.logs[0]).toStartWith("  [atmux] removed dead legacy socket /tmp/atmux-grp-g/sock");
  });

  test("live private pre-ADR-305 group socket → kept (the live server keeps working)", async () => {
    const fs = fakeFs(
      {
        "/tmp/atmux-grp-g": { kind: "dir", uid: 1000, mode: 0o700 },
        "/tmp/atmux-grp-g/sock": { kind: "socket", uid: 1000, mode: 0o660 },
      },
      1000,
    );
    const sock = await ensurePrivateGroupSocket("g", logger(), {
      uid: 1000,
      fs,
      isListening: async () => true,
    });
    expect(sock).toBe("/tmp/atmux-grp-g/sock");
  });

  test("live pre-ADR-305 group socket in a SHARED dir → refused with the adopting chmod", async () => {
    const fs = fakeFs(
      {
        "/tmp/atmux-grp-g": { kind: "dir", uid: 1000, mode: 0o777 },
        "/tmp/atmux-grp-g/sock": { kind: "socket", uid: 1000, mode: 0o777 },
      },
      1000,
    );
    const p = ensurePrivateGroupSocket("g", logger(), {
      uid: 1000,
      fs,
      isListening: async () => true,
    });
    await expect(p).rejects.toBeInstanceOf(ConfigError);
    await expect(
      ensurePrivateGroupSocket("g", logger(), { uid: 1000, fs, isListening: async () => true }),
    ).rejects.toThrow("chmod 700 /tmp/atmux-grp-g — that keeps the server usable");
  });

  test("per-user root squatted by another uid → refused (ConfigError), nothing created", async () => {
    const fs = fakeFs(
      {
        "/tmp": { kind: "dir", uid: 0, mode: 0o1777 },
        "/tmp/atmux-1000": { kind: "dir", uid: 1001, mode: 0o777 },
      },
      1000,
    );
    await expect(ensurePrivateGroupSocket("g", logger(), { uid: 1000, fs })).rejects.toThrow(
      "refusing tmux socket /tmp/atmux-1000/grp-g/sock: /tmp/atmux-1000 is owned by uid 1001, not uid 1000",
    );
    expect(fs.nodes.has("/tmp/atmux-1000/grp-g")).toBe(false);
  });

  test("no POSIX uid → pre-ADR-305 path, plain mkdir -p", async () => {
    const fs = fakeFs({}, 0);
    expect(await ensurePrivateGroupSocket("g", logger(), { uid: null, fs })).toBe(
      "/tmp/atmux-grp-g/sock",
    );
    expect(fs.calls).toEqual(["mkdirp /tmp/atmux-grp-g 700"]);
  });

  test("defaults (real uid, real fs): creates the per-user group dir 0700", async () => {
    const uid = process.getuid?.() ?? 0;
    const g = `adr305-rg-${process.pid}`;
    try {
      const sock = await ensurePrivateGroupSocket(g, logger());
      expect(sock).toBe(`/tmp/atmux-${uid}/grp-${g}/sock`);
      expect(statSync(`/tmp/atmux-${uid}/grp-${g}`).mode & 0o777).toBe(0o700);
      expect(statSync(`/tmp/atmux-${uid}`).mode & 0o077).toBe(0);
    } finally {
      await rm(`/tmp/atmux-${uid}/grp-${g}`, { recursive: true, force: true });
    }
  });
});
