// E2E — ADR-305: a second local uid cannot reach another uid's atmux
// cage or group server, and atmux refuses planted / shared socket dirs.
//
// REAL uids, REAL tmux, REAL atmux code: each actor runs
// tests/helpers/socket-dir-actor.ts under `setpriv --reuid/--regid`, so the
// kernel — not a mock — decides who can reach which socket.
//
// It creates throwaway local users, so it runs ONLY where that is safe
// and intended: Linux, as root, inside a container (`/.dockerenv`), with
// ATMUX_E2E_TWO_UID=1. Anywhere else every test is skipped (the reason
// is printed once).
//
// Beats:
//   1. alice's cage: dir chain 0700; bob's raw tmux client gets EACCES and
//      cannot even see the socket; bob's own default for the same team is
//      a different path under /tmp/atmux-<bob>/.
//   2. alice's group server: same, for /tmp/atmux-<alice>/grp-<group>/.
//   3. root's cage: bob cannot connect to it either.
//   4. negative control: the pre-ADR-305 shape (0777 dir + 0777 socket)
//      IS reachable by bob at the socket layer — the hole this closes —
//      and atmux's guard refuses that socket for both uids.
//   5. refusals: bob squats /tmp/atmux-<carol>/ → carol's cage is refused
//      (foreign owner); a 0777 socket dir is refused (shared mode); a
//      socket root plants in alice's private dir is refused (foreign
//      socket owner).

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, "../..");
const ACTOR = resolve(REPO, "tests/helpers/socket-dir-actor.ts");
const NONCE = `${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
const USERS = { alice: 4201, bob: 4202, carol: 4203 } as const;
type Who = keyof typeof USERS | "root";
/** Primary gid per user, read back after `useradd -U`. */
const GIDS: Record<string, number> = {};

const skipReason = ((): string | null => {
  if (process.platform !== "linux") return "not Linux";
  if (process.getuid?.() !== 0) return "not root";
  if (!existsSync("/.dockerenv")) return "not inside a container";
  if (process.env.ATMUX_E2E_TWO_UID !== "1") return "ATMUX_E2E_TWO_UID!=1";
  for (const bin of ["tmux", "setpriv", "useradd", "userdel"]) {
    if (Bun.which(bin) === null) return `${bin} missing`;
  }
  return null;
})();
const SKIP = skipReason !== null;
if (SKIP) process.stderr.write(`socket-dir-two-uid e2e skipped: ${skipReason}\n`);

function sh(
  argv: string[],
  env: Record<string, string> = {},
): { code: number; out: string; err: string } {
  const p = Bun.spawnSync({
    cmd: argv,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
}

/** Prefix that drops to `who` (a clean env; HOME is that user's scratch). */
function as(who: Who): { argv: string[]; env: Record<string, string> } {
  if (who === "root") return { argv: [], env: { HOME: "/tmp/e2e-home-root" } };
  const uid = USERS[who];
  return {
    argv: ["setpriv", `--reuid=${uid}`, `--regid=${GIDS[who] ?? uid}`, "--clear-groups", "--"],
    env: { HOME: `/tmp/e2e-home-${who}` },
  };
}

function actor(who: Who, verb: string, arg: string): Record<string, unknown> {
  const a = as(who);
  const r = sh([...a.argv, process.execPath, ACTOR, verb, arg], a.env);
  const line = r.out.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error(
      `actor ${who} ${verb} ${arg} → code ${r.code}\nstdout: ${r.out}\nstderr: ${r.err}`,
    );
  }
}

/** A raw tmux CLIENT as `who` (no atmux guard): what the kernel allows. */
function rawTmux(who: Who, sock: string, ...argv: string[]): { code: number; err: string } {
  const a = as(who);
  const r = sh([...a.argv, "tmux", "-S", sock, ...argv], a.env);
  return { code: r.code, err: r.err };
}

/** `test -e` as `who` — can that uid even see the path? */
function canSee(who: Who, p: string): boolean {
  const a = as(who);
  return sh([...a.argv, "test", "-e", p], a.env).code === 0;
}

const started: Array<{ who: Who; sock: string }> = [];
const scratch: string[] = [];

describe.skipIf(SKIP)("e2e: ADR-305 per-user private socket dirs across two real uids", () => {
  beforeAll(() => {
    for (const [name, uid] of Object.entries(USERS)) {
      if (sh(["id", "-u", name]).code !== 0) {
        const r = sh(["useradd", "-M", "-s", "/bin/sh", "-u", String(uid), "-U", name]);
        if (r.code !== 0) throw new Error(`useradd ${name}: ${r.err}`);
      }
      GIDS[name] = Number(sh(["id", "-g", name]).out.trim());
      sh([
        "install",
        "-d",
        "-m",
        "700",
        "-o",
        String(uid),
        "-g",
        String(GIDS[name]),
        `/tmp/e2e-home-${name}`,
      ]);
    }
    sh(["install", "-d", "-m", "700", "/tmp/e2e-home-root"]);
  });

  afterAll(() => {
    for (const { who, sock } of started) {
      const a = as(who);
      sh([...a.argv, "tmux", "-S", sock, "kill-server"], a.env);
    }
    for (const d of scratch) sh(["rm", "-rf", d]);
    for (const [name, uid] of Object.entries(USERS)) {
      sh(["rm", "-rf", `/tmp/atmux-${uid}`, `/tmp/e2e-home-${name}`]);
      sh(["userdel", name]);
    }
    sh(["rm", "-rf", "/tmp/e2e-home-root"]);
  });

  test("beat 1 — alice's cage is private: bob gets EACCES and cannot see the socket", () => {
    const team = `e2e-cage-${NONCE}`;
    const a = actor("alice", "cage", team);
    expect(a).toMatchObject({
      ok: true,
      sock: `/tmp/atmux-4201/${team}/sock`,
      dirMode: "0700",
      rootMode: "0700",
    });
    started.push({ who: "alice", sock: a.sock as string });

    // Positive control: the owner reaches her own server.
    expect(rawTmux("alice", a.sock as string, "has-session", "-t", `=${team}`).code).toBe(0);
    // The hole is closed: bob's client cannot even connect.
    const b = rawTmux("bob", a.sock as string, "has-session", "-t", `=${team}`);
    expect(b.code).not.toBe(0);
    expect(b.err).toContain("Permission denied");
    expect(canSee("bob", a.sock as string)).toBe(false);
    // …and bob's atmux never resolves alice's socket for the same team.
    expect(actor("bob", "resolve", team)).toMatchObject({
      ok: true,
      sock: `/tmp/atmux-4202/${team}/sock`,
    });
    // bob's atmux guard refuses alice's socket outright.
    expect(actor("bob", "probe", a.sock as string)).toMatchObject({ ok: false });
  });

  test("beat 2 — alice's group server is private too", () => {
    const group = `e2e-grp-${NONCE}`;
    const g = actor("alice", "group", group);
    expect(g).toMatchObject({
      ok: true,
      sock: `/tmp/atmux-4201/grp-${group}/sock`,
      dirMode: "0700",
    });
    started.push({ who: "alice", sock: g.sock as string });
    expect(rawTmux("alice", g.sock as string, "has-session", "-t", `=${group}`).code).toBe(0);
    const b = rawTmux("bob", g.sock as string, "has-session", "-t", `=${group}`);
    expect(b.code).not.toBe(0);
    expect(b.err).toContain("Permission denied");
    expect(canSee("bob", g.sock as string)).toBe(false);
  });

  test("beat 3 — root's cage: bob cannot connect", () => {
    const team = `e2e-root-${NONCE}`;
    const r = actor("root", "cage", team);
    expect(r).toMatchObject({
      ok: true,
      sock: `/tmp/atmux-0/${team}/sock`,
      dirMode: "0700",
      rootMode: "0700",
    });
    started.push({ who: "root", sock: r.sock as string });
    scratch.push(`/tmp/atmux-0/${team}`);
    const b = rawTmux("bob", r.sock as string, "has-session", "-t", `=${team}`);
    expect(b.code).not.toBe(0);
    expect(b.err).toContain("Permission denied");
  });

  test("beat 4 — negative control: the pre-ADR-305 shape is reachable, and the guard refuses it", () => {
    const dir = `/tmp/e2e-shared-${NONCE}`;
    const sock = `${dir}/sock`;
    scratch.push(dir);
    sh(["install", "-d", "-m", "777", "-o", "4201", "-g", String(GIDS.alice), dir]);
    // A raw server as alice in the shared dir, socket opened wide the way
    // the measured @@hax servers were (srwxrwxrwx).
    const a = as("alice");
    expect(
      sh([...a.argv, "tmux", "-S", sock, "new-session", "-d", "sleep", "600"], a.env).code,
    ).toBe(0);
    started.push({ who: "alice", sock });
    sh(["chmod", "777", sock]);
    // bob's client gets past the filesystem: no EACCES this time. (tmux's
    // own server-access list may still answer "access not allowed"; the
    // point is the socket was reachable — directory mode was the only
    // wall, and here it is down.)
    const b = rawTmux("bob", sock, "has-session");
    expect(b.err).not.toContain("Permission denied");
    expect(canSee("bob", sock)).toBe(true);
    // atmux refuses it for both uids: shared mode for alice, foreign
    // owner for bob.
    expect(actor("alice", "probe", sock)).toMatchObject({
      ok: false,
      problem: "shared-mode",
      path: dir,
    });
    expect(actor("bob", "probe", sock)).toMatchObject({
      ok: false,
      problem: "foreign-owner",
      path: dir,
    });
  });

  test("beat 5a — bob squats /tmp/atmux-<carol>: carol's cage is refused (foreign owner)", () => {
    sh(["install", "-d", "-m", "777", "-o", "4202", "-g", String(GIDS.bob), "/tmp/atmux-4203"]);
    const c = actor("carol", "cage", `e2e-squat-${NONCE}`);
    expect(c).toMatchObject({ ok: false, problem: "foreign-owner", path: "/tmp/atmux-4203" });
    expect(c.message as string).toContain("is owned by uid 4202, not uid 4203");
    // Nothing of carol's was created inside the squatted directory.
    expect(existsSync(`/tmp/atmux-4203/e2e-squat-${NONCE}`)).toBe(false);
  });

  test("beat 5b — a 0777 socket directory is refused (shared mode), not chmod'ed", () => {
    const dir = `/tmp/e2e-777-${NONCE}`;
    scratch.push(dir);
    sh(["install", "-d", "-m", "777", "-o", "4201", "-g", String(GIDS.alice), dir]);
    expect(actor("alice", "ensure", `${dir}/sock`)).toMatchObject({
      ok: false,
      problem: "shared-mode",
      path: dir,
    });
    expect(sh(["stat", "-c", "%a", dir]).out.trim()).toBe("777");
  });

  test("beat 5c — a socket planted in alice's private dir by another uid is refused", () => {
    const team = `e2e-plant-${NONCE}`;
    const dirReady = actor("alice", "ensure", `/tmp/atmux-4201/${team}/sock`);
    expect(dirReady).toMatchObject({ ok: true, dirMode: "0700" });
    // root (the only uid that can write there) plants a server socket.
    const planted = `/tmp/atmux-4201/${team}/sock`;
    expect(
      sh(["tmux", "-S", planted, "new-session", "-d", "sleep", "600"], {
        HOME: "/tmp/e2e-home-root",
      }).code,
    ).toBe(0);
    started.push({ who: "root", sock: planted });
    expect(actor("alice", "probe", planted)).toMatchObject({
      ok: false,
      problem: "foreign-owner",
      path: planted,
    });
    expect(actor("alice", "cage", team)).toMatchObject({
      ok: false,
      problem: "foreign-owner",
      path: planted,
    });
  });
});
