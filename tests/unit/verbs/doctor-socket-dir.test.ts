// ADR-305 — `socket-dir` doctor probe + the `unlessUnsafeSocket` wrapper
// (src/verbs/doctor/socket-dir.ts). Fake filesystem: the red rows need
// another uid's directory, which one test process cannot create for real.

import { describe, expect, test } from "bun:test";
import {
  SOCKET_DIR_FEATURE,
  type SocketDirFs,
  UnsafeSocketPathError,
} from "../../../src/core/socket-dir.ts";
import { ConfigError } from "../../../src/errors.ts";
import type { Team } from "../../../src/schema/team.ts";
import { checkSocketDirs, unlessUnsafeSocket } from "../../../src/verbs/doctor/socket-dir.ts";

type Kind = "dir" | "socket";
function fakeFs(nodes: Record<string, { kind: Kind; uid: number; mode: number }>): SocketDirFs {
  return {
    lstat: (p) => {
      const n = nodes[p];
      if (n === undefined) return null;
      return {
        uid: n.uid,
        mode: n.mode,
        isDirectory: () => n.kind === "dir",
        isSymbolicLink: () => false,
        isSocket: () => n.kind === "socket",
      };
    },
    mkdir: () => {
      throw new Error("doctor must never create");
    },
    mkdirp: () => {
      throw new Error("doctor must never create");
    },
    chmod: () => {
      throw new Error("doctor must never chmod");
    },
  };
}

const A = 1000;
const env = { TMUX_TMPDIR: "/tt" };
const team = (name: string, tmuxTmpdir?: string): Team =>
  ({ name, ...(tmuxTmpdir !== undefined ? { tmuxTmpdir } : {}) }) as unknown as Team;

describe("checkSocketDirs", () => {
  test("no team, nothing created yet → one green row carrying the capability marker", () => {
    const rows = checkSocketDirs(null, { uid: A, env, fs: fakeFs({}) });
    expect(rows).toEqual([
      { status: "green", label: "socket-dir", detail: `${SOCKET_DIR_FEATURE}: /tt/tmux-1000` },
    ]);
  });

  test("team on the per-user default, private → green names both directories", () => {
    const fs = fakeFs({
      "/tt/tmux-1000": { kind: "dir", uid: A, mode: 0o700 },
      "/tmp/atmux-1000": { kind: "dir", uid: A, mode: 0o700 },
      "/tmp/atmux-1000/px": { kind: "dir", uid: A, mode: 0o700 },
    });
    expect(checkSocketDirs(team("px"), { uid: A, env, fs })).toEqual([
      {
        status: "green",
        label: "socket-dir",
        detail: `${SOCKET_DIR_FEATURE}: /tt/tmux-1000, /tmp/atmux-1000/px`,
      },
    ]);
  });

  test("team socket dir shared → red with the chmod hint, no green row", () => {
    const fs = fakeFs({
      "/tmp/atmux-1000": { kind: "dir", uid: A, mode: 0o700 },
      "/tmp/atmux-1000/px": { kind: "dir", uid: A, mode: 0o777 },
    });
    expect(checkSocketDirs(team("px"), { uid: A, env, fs })).toEqual([
      {
        status: "red",
        label: "socket-dir",
        detail:
          "team px socket /tmp/atmux-1000/px/sock: /tmp/atmux-1000/px has mode 0777 (group or world bits set) — atmux refuses it",
        hint: "chmod 700 /tmp/atmux-1000/px",
      },
    ]);
  });

  test("cockpit tmux-<uid> dir owned by another uid → red", () => {
    const fs = fakeFs({ "/tt/tmux-1000": { kind: "dir", uid: 0, mode: 0o700 } });
    const rows = checkSocketDirs(null, { uid: A, env, fs });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.detail).toContain("cockpit socket /tt/tmux-1000/atmux-cockpit");
    expect(rows[0]?.detail).toContain("owned by uid 0, not uid 1000");
  });

  test("pre-ADR-305 socket of ours in a shared dir → yellow, plus the green row", () => {
    const fs = fakeFs({
      "/tmp/atmux-px": { kind: "dir", uid: A, mode: 0o755 },
      "/tmp/atmux-px/sock": { kind: "socket", uid: A, mode: 0o660 },
    });
    const rows = checkSocketDirs(team("px"), { uid: A, env, fs });
    expect(rows.map((r) => [r.status, r.label])).toEqual([
      ["green", "socket-dir"],
      ["yellow", "socket-dir-legacy"],
    ]);
    expect(rows[1]?.hint).toBe(
      "if a cage is live there: chmod 700 /tmp/atmux-px (atmux adopts it until its next restart); otherwise rm /tmp/atmux-px/sock",
    );
  });

  test("tmuxTmpdir team: its leaf is checked, the legacy path is not", () => {
    const fs = fakeFs({
      "/r/.atmux/tmux/tmux-1000": { kind: "dir", uid: A, mode: 0o750 },
      "/tmp/atmux-px": { kind: "dir", uid: A, mode: 0o755 },
      "/tmp/atmux-px/sock": { kind: "socket", uid: A, mode: 0o660 },
    });
    const rows = checkSocketDirs(team("px", "/r/.atmux/tmux"), { uid: A, env, fs });
    expect(rows.map((r) => [r.status, r.label])).toEqual([["red", "socket-dir"]]);
    expect(rows[0]?.hint).toBe("chmod 700 /r/.atmux/tmux/tmux-1000");
  });

  test("no POSIX uid → no rows", () => {
    expect(checkSocketDirs(team("px"), { uid: null })).toEqual([]);
  });

  test("defaults (real uid, real fs, process env) produce a socket-dir row", () => {
    const rows = checkSocketDirs(null);
    expect(rows.some((r) => r.label === "socket-dir")).toBe(true);
  });
});

describe("unlessUnsafeSocket", () => {
  test("passes rows through (sync and async checks)", async () => {
    const row = { status: "yellow" as const, label: "x" };
    expect(await unlessUnsafeSocket(() => [row])).toEqual([row]);
    expect(await unlessUnsafeSocket(async () => [row])).toEqual([row]);
  });

  test("an ADR-305 refusal becomes no rows (socket-dir already reports it)", async () => {
    const refusal = new UnsafeSocketPathError("/s/sock", {
      path: "/s",
      problem: "shared-mode",
      detail: "has mode 0777",
      hint: "chmod 700 /s",
    });
    expect(
      await unlessUnsafeSocket(() => {
        throw refusal;
      }),
    ).toEqual([]);
  });

  test("any other error still propagates", async () => {
    const other = new ConfigError({ what: "unrelated" });
    await expect(
      unlessUnsafeSocket(async () => {
        throw other;
      }),
    ).rejects.toBe(other);
  });
});
