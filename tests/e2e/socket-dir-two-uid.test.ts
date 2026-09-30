// E2E — ADR-305: a second local uid cannot reach another uid's atmux
// cage or group server, and atmux refuses planted / shared socket dirs.
//
// REAL uids, REAL tmux, REAL atmux code: beats 1–5 run library calls
// through tests/helpers/socket-dir-actor.ts, beats 6–11 run the real CLI
// (`bin/atmux start`, `cockpit reconcile`, `socket-dial`, and the
// `bin/atmux-tmux` shell wrapper), each under `setpriv --reuid/--regid`,
// so the kernel — not a mock — decides who can reach which socket.
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
//   6. real CLI: `atmux start` as alice and as bob for ONE team name →
//      two private servers; each uid's `socket-dial` of the other's socket
//      is refused before tmux runs.
//   7. cockpit: `atmux cockpit reconcile` as alice — her viewer window
//      attaches to HER cage (never bob's same-named one), and her cockpit
//      `-L atmux-cockpit` socket is private to her.
//   8. review of 35ea2c3, item 1: a tmuxTmpdir parent another uid
//      pre-planted (0777) stops `atmux start`, `socket-dial` and
//      `bin/atmux-tmux`; nothing is created inside, and the other uid's
//      server planted there is never dialled.
//   9. review item 2: a swap of a directory another uid can rename. The
//      35ea2c3 viewer guard (`[ -S ] && [ -O ] && tmux -S`) is raced into
//      the other uid's server (negative control); `socket-dial` refuses
//      every dial, even while the path points at root's own server.
//  10. review item 4: a missing /tmp/atmux-<uid> is created 0700 before a
//      dial; a squatted one refuses `socket-dial` and `start`.
//  11. cockpit socket: another uid's /tmp/tmux-<uid> stops
//      `cockpit reconcile` with exit 78.
//  12. review of a9f96ac2, item 1: carol squats /tmp/atmux-<erin> with a
//      server and renames it away and back in a loop. A hand copy of the
//      revision-2 doctor gate (check, then dial) is raced into carol's
//      server (negative control); the real doctor dial sites never are.
//  13. review of a9f96ac2, item 2: carol plants a test-reaper fixture whose
//      `sock` links to root's live server. Root's `atmux test-reaper`
//      leaves both alone; root's own fixture is still reaped.
//  14. review of ccd9f275 (HIGH), the reviewer's repro: frank has a live
//      server at /tmp/atmux-<journal>/sock; carol creates /tmp/atmux-<frank>
//      (0755) with `<team> -> /tmp/atmux-<journal>`. frank's `atmux start`
//      of a tmuxTmpdir team must NOT read the guard's refusal as "dead" and
//      unlink his own live socket through carol's link.
//  15. review of ccd9f275 (LOW): `bin/atmux-tmux` checks each component
//      before following a symlink (it used to `cd -P` first): carol's link
//      in her own directory, or in the sticky /tmp, is refused and nothing
//      is made behind it.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

setDefaultTimeout(120_000);

const REPO = resolve(import.meta.dir, "../..");
const ACTOR = resolve(REPO, "tests/helpers/socket-dir-actor.ts");
const ATMUX = resolve(REPO, "bin/atmux");
const WRAPPER = resolve(REPO, "bin/atmux-tmux");
const NONCE = `${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
const USERS = {
  alice: 4201,
  bob: 4202,
  carol: 4203,
  dave: 4204,
  erin: 4205,
  frank: 4206,
} as const;
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
  cwd?: string,
): { code: number; out: string; err: string } {
  const p = Bun.spawnSync({
    cmd: argv,
    env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8", ...env },
    ...(cwd !== undefined ? { cwd } : {}),
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

/** The REAL atmux CLI (this checkout) as `who`. */
function atmux(
  who: Who,
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): { code: number; out: string; err: string } {
  const a = as(who);
  return sh(
    [...a.argv, process.execPath, ATMUX, ...argv],
    { ...a.env, ATMUX_NO_CRON: "1", ...opts.env },
    opts.cwd,
  );
}

/** `stat -c '%a %u'` of a path (as root). */
function modeOwner(p: string): string {
  return sh(["stat", "-c", "%a %u", p]).out.trim();
}

const HOME_OF = (who: Who): string =>
  who === "root" ? "/tmp/e2e-home-root" : `/tmp/e2e-home-${who}`;
const uidOf = (who: Who): number => (who === "root" ? 0 : USERS[who]);

/** A team root owned by `who` (0700) with a drivers-only team.json whose
 *  cage the cockpit attaches to (`driverSession` set). */
function teamRoot(who: Who, team: string, extra: Record<string, unknown> = {}): string {
  const root = `/tmp/e2e-proj-${who}-${team}`;
  scratch.push(root);
  const uid = String(uidOf(who));
  const gid = who === "root" ? "0" : String(GIDS[who]);
  sh(["install", "-d", "-m", "700", "-o", uid, "-g", gid, root, `${root}/.atmux`]);
  const tj = `${root}/.atmux/team.json`;
  writeFileSync(
    tj,
    JSON.stringify({
      name: team,
      members: [],
      drivers: [{ name: "driver", cwd: ".", tui: null }],
      superdriver: { enabled: false },
      driverSession: { tui: null },
      ...extra,
    }),
  );
  sh(["chown", `${uid}:${gid}`, tj]);
  return root;
}

/** `atmux start` (no TUIs, no doctor, no preflight) for a team root. */
function startTeam(who: Who, root: string): { code: number; out: string; err: string } {
  return atmux(who, ["start", "--no-launch", "--no-doctor", "--no-preflight"], {
    cwd: root,
    env: { ATMUX_DIR: `${root}/.atmux` },
  });
}

/** Clients attached to a tmux server, as `who` (raw tmux). */
function clients(who: Who, sock: string): number {
  const a = as(who);
  const r = sh([...a.argv, "tmux", "-S", sock, "list-clients", "-F", "#{client_tty}"], a.env);
  return r.code === 0 ? r.out.split("\n").filter(Boolean).length : 0;
}

const roots: Record<string, string> = {};

/** `test -e` as `who` — can that uid even see the path? */
function canSee(who: Who, p: string): boolean {
  const a = as(who);
  return sh([...a.argv, "test", "-e", p], a.env).code === 0;
}

const started: Array<{ who: Who; sock: string }> = [];
const background: Array<{ kill(): void }> = [];
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
    for (const p of background) p.kill();
    for (const { who, sock } of started) {
      const a = as(who);
      sh([...a.argv, "tmux", "-S", sock, "kill-server"], a.env);
    }
    for (const d of scratch) sh(["rm", "-rf", d]);
    for (const [name, uid] of Object.entries(USERS)) {
      sh(["rm", "-rf", `/tmp/atmux-${uid}`, `/tmp/tmux-${uid}`, `/tmp/e2e-home-${name}`]);
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
  test("beat 6 — real CLI: `atmux start` as alice and as bob for one team name → two private servers", () => {
    const team = `e2e-cli-${NONCE}`;
    for (const who of ["alice", "bob"] as const) {
      const root = teamRoot(who, team);
      roots[who] = root;
      const r = startTeam(who, root);
      expect(`${r.code} ${r.err}`).toStartWith("0 ");
      const sock = `/tmp/atmux-${USERS[who]}/${team}/sock`;
      started.push({ who, sock });
      expect(modeOwner(`/tmp/atmux-${USERS[who]}`)).toBe(`700 ${USERS[who]}`);
      expect(modeOwner(`/tmp/atmux-${USERS[who]}/${team}`)).toBe(`700 ${USERS[who]}`);
      // The owner dials her own cage through the CLI.
      expect(atmux(who, ["socket-dial", sock, "has-session", "-t", `=${team}`]).code).toBe(0);
    }
    // Each uid's dial of the other's socket is refused before tmux runs.
    for (const [who, other] of [
      ["alice", "bob"],
      ["bob", "alice"],
    ] as const) {
      const x = atmux(who, [
        "socket-dial",
        `/tmp/atmux-${USERS[other]}/${team}/sock`,
        "has-session",
        "-t",
        `=${team}`,
      ]);
      expect(x.code).toBe(78);
      expect(x.err).toContain(`refusing tmux socket /tmp/atmux-${USERS[other]}/${team}/sock`);
      expect(x.err).toContain(
        `/tmp/atmux-${USERS[other]} is owned by uid ${USERS[other]}, not uid ${USERS[who]}`,
      );
    }
  });

  test("beat 7 — cockpit: alice's `cockpit reconcile` viewer attaches to HER cage, never bob's; her cockpit socket is private", async () => {
    const team = `e2e-cli-${NONCE}`;
    const aliceSock = `/tmp/atmux-4201/${team}/sock`;
    const bobSock = `/tmp/atmux-4202/${team}/sock`;
    expect(roots.alice).toBeDefined();
    const cfgDir = `${HOME_OF("alice")}/.atmux`;
    sh(["install", "-d", "-m", "700", "-o", "4201", "-g", String(GIDS.alice), cfgDir]);
    writeFileSync(
      join(cfgDir, "cockpit.json"),
      JSON.stringify({
        schemaVersion: 1,
        sessions: [{ type: "team", name: team, root: roots.alice, enabled: true }],
      }),
    );
    sh(["chown", `4201:${GIDS.alice}`, join(cfgDir, "cockpit.json")]);
    const r = atmux("alice", ["cockpit", "reconcile", "--no-launch", "--no-cycle"]);
    expect(`${r.code} ${r.err}`).toStartWith("0 ");
    const cockpitSock = "/tmp/tmux-4201/atmux-cockpit";
    started.push({ who: "alice", sock: cockpitSock });
    // The viewer loop dials through `atmux socket-dial`: poll until its
    // client shows up on alice's cage.
    const deadline = Date.now() + 30_000;
    while (clients("alice", aliceSock) === 0 && Date.now() < deadline) await Bun.sleep(250);
    expect(clients("alice", aliceSock)).toBe(1);
    expect(clients("bob", bobSock)).toBe(0);
    // The cockpit server itself: tmux's own private tmux-<uid> dir.
    expect(modeOwner("/tmp/tmux-4201")).toBe("700 4201");
    const b = rawTmux("bob", cockpitSock, "list-sessions");
    expect(b.code).not.toBe(0);
    expect(b.err).toContain("Permission denied");
  });

  test("beat 8 — review item 1: a tmuxTmpdir parent another uid pre-planted (0777) stops start, socket-dial and atmux-tmux", () => {
    const planted = `/tmp/atmux-tmux_rv${NONCE}`;
    scratch.push(planted);
    sh(["install", "-d", "-m", "777", "-o", "4203", "-g", String(GIDS.carol), planted]);
    const team = `e2e-rv-${NONCE}`;
    const root = teamRoot("root", team, { tmuxTmpdir: planted });
    const want = `${planted} is owned by uid 4203, not uid 0`;

    const r = startTeam("root", root);
    expect(r.code).toBe(78);
    expect(r.err).toContain(want);
    // Nothing of root's was created inside carol's directory.
    expect(existsSync(`${planted}/tmux-0`)).toBe(false);

    // The reviewer's exploit, replayed: carol serves her own tmux at the
    // exact path root's team would dial.
    const c = as("carol");
    sh([...c.argv, "mkdir", "-m", "700", `${planted}/tmux-0`], c.env);
    const carolSock = `${planted}/tmux-0/default`;
    expect(
      sh(
        [
          ...c.argv,
          "tmux",
          "-S",
          carolSock,
          "new-session",
          "-d",
          "-s",
          "carolsess",
          "sleep",
          "600",
        ],
        c.env,
      ).code,
    ).toBe(0);
    started.push({ who: "carol", sock: carolSock });
    const d = atmux("root", ["socket-dial", carolSock, "list-sessions", "-F", "#{session_name}"]);
    expect(d.code).toBe(78);
    expect(d.err).toContain(want);
    expect(d.out).not.toContain("carolsess");
    // The atmux library guard (createTmux) refuses it too.
    expect(actor("root", "probe", carolSock)).toMatchObject({
      ok: false,
      problem: "foreign-owner",
      path: planted,
    });
    // …and so does the shell mirror, bin/atmux-tmux.
    const w = sh(["sh", WRAPPER, "list-sessions"], { HOME: HOME_OF("root"), TMUX_TMPDIR: planted });
    expect(w.code).toBe(78);
    expect(w.err).toContain(want);
    expect(w.out).not.toContain("carolsess");
  });

  test("beat 9 — review item 2: a directory another uid can rename never redirects socket-dial (the 35ea2c3 guard is raced)", async () => {
    const base = `/tmp/e2e-swap-${NONCE}`;
    scratch.push(base);
    sh(["install", "-d", "-m", "777", "-o", "4203", "-g", String(GIDS.carol), base]);
    // root's server, reached through a directory carol owns.
    sh(["install", "-d", "-m", "700", `${base}/real`, `${base}/real/tmux-0`]);
    const rootSock = `${base}/real/tmux-0/default`;
    expect(
      sh(["tmux", "-S", rootSock, "new-session", "-d", "-s", "rootsess", "sleep", "600"], {
        HOME: HOME_OF("root"),
      }).code,
    ).toBe(0);
    started.push({ who: "root", sock: rootSock });
    // carol's server at the same relative spot, and the link she flips.
    const c = as("carol");
    sh([...c.argv, "mkdir", "-p", "-m", "700", `${base}/evil/tmux-0`], c.env);
    const carolSock = `${base}/evil/tmux-0/default`;
    expect(
      sh(
        [
          ...c.argv,
          "tmux",
          "-S",
          carolSock,
          "new-session",
          "-d",
          "-s",
          "carolsess",
          "sleep",
          "600",
        ],
        c.env,
      ).code,
    ).toBe(0);
    started.push({ who: "carol", sock: carolSock });
    sh([...c.argv, "ln", "-s", "real", `${base}/cur`], c.env);
    const P = `${base}/cur/tmux-0/default`;

    // Deterministic: even while P points at root's OWN live server, the
    // chain is swappable, so socket-dial refuses (a node-only check dials).
    const det = atmux("root", ["socket-dial", P, "list-sessions", "-F", "#{session_name}"]);
    expect(det.code).toBe(78);
    expect(det.err).toContain(`${base} is owned by uid 4203 (neither root nor uid 0)`);

    // The race: carol flips `cur` between real/ and evil/ as fast as she can.
    const flipper = Bun.spawn(
      [
        ...c.argv,
        "sh",
        "-c",
        "while :; do ln -sfn real cur.n && mv -Tf cur.n cur; ln -sfn evil cur.n && mv -Tf cur.n cur; done",
      ],
      {
        cwd: base,
        env: { PATH: process.env.PATH ?? "", ...c.env },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    background.push(flipper);
    try {
      // Negative control — 35ea2c3's viewer dial, 300 times as root.
      const old = sh(
        [
          "sh",
          "-c",
          `n=0; i=0; while [ $i -lt 300 ]; do i=$((i+1)); o=$({ [ -S "$P" ] && [ -O "$P" ] && tmux -S "$P" list-sessions -F '#{session_name}' 2>/dev/null; }); [ "$o" = carolsess ] && n=$((n+1)); done; echo $n`,
        ],
        { P, HOME: HOME_OF("root") },
      );
      const oldHits = Number(old.out.trim());
      // socket-dial, 60 times as root, same race.
      const now = sh(
        [
          "sh",
          "-c",
          `h=0; r=0; i=0; while [ $i -lt 60 ]; do i=$((i+1)); o=$("$BUN" "$ATMUX" socket-dial "$P" list-sessions -F '#{session_name}' 2>/dev/null); [ $? -eq 78 ] && r=$((r+1)); [ "$o" = carolsess ] && h=$((h+1)); done; echo "$h $r"`,
        ],
        { P, HOME: HOME_OF("root"), BUN: process.execPath, ATMUX, ATMUX_NO_CRON: "1" },
      );
      process.stderr.write(
        `beat 9: 35ea2c3 guard reached carol's server ${oldHits}/300; socket-dial (hits refused) ${now.out.trim()}/60\n`,
      );
      expect(now.out.trim()).toBe("0 60");
      expect(oldHits).toBeGreaterThan(0);
    } finally {
      flipper.kill();
      await flipper.exited;
    }
  });

  test("beat 10 — review item 4: a missing /tmp/atmux-<uid> is made 0700 before a dial; a squatted one refuses socket-dial and start", () => {
    const team = `e2e-miss-${NONCE}`;
    sh(["rm", "-rf", "/tmp/atmux-4204"]);
    const r = atmux("dave", ["socket-dial", `/tmp/atmux-4204/${team}/sock`, "has-session"]);
    expect(r.code).toBe(1);
    expect(modeOwner("/tmp/atmux-4204")).toBe("700 4204");
    expect(existsSync(`/tmp/atmux-4204/${team}`)).toBe(false);

    // bob squats carol's root (same shape as beat 5a, via the CLI now).
    if (!existsSync("/tmp/atmux-4203")) {
      sh(["install", "-d", "-m", "777", "-o", "4202", "-g", String(GIDS.bob), "/tmp/atmux-4203"]);
    }
    const want = "/tmp/atmux-4203 is owned by uid 4202, not uid 4203";
    const d = atmux("carol", ["socket-dial", `/tmp/atmux-4203/${team}/sock`, "has-session"]);
    expect(d.code).toBe(78);
    expect(d.err).toContain(want);
    const s = startTeam("carol", teamRoot("carol", team));
    expect(s.code).toBe(78);
    expect(s.err).toContain(want);
    expect(existsSync(`/tmp/atmux-4203/${team}`)).toBe(false);
  });

  test("beat 11 — cockpit socket: another uid's /tmp/tmux-<uid> stops `cockpit reconcile` (exit 78)", () => {
    const team = `e2e-ck-${NONCE}`;
    const root = teamRoot("dave", team);
    const cfgDir = `${HOME_OF("dave")}/.atmux`;
    sh(["install", "-d", "-m", "700", "-o", "4204", "-g", String(GIDS.dave), cfgDir]);
    writeFileSync(
      join(cfgDir, "cockpit.json"),
      JSON.stringify({
        schemaVersion: 1,
        sessions: [{ type: "team", name: team, root, enabled: true }],
      }),
    );
    sh(["chown", `4204:${GIDS.dave}`, join(cfgDir, "cockpit.json")]);
    sh(["rm", "-rf", "/tmp/tmux-4204"]);
    sh(["install", "-d", "-m", "700", "-o", "4202", "-g", String(GIDS.bob), "/tmp/tmux-4204"]);
    const r = atmux("dave", ["cockpit", "reconcile", "--no-launch", "--no-cycle"]);
    expect(r.code).toBe(78);
    expect(r.err).toContain("/tmp/tmux-4204 is owned by uid 4202, not uid 4204");
    expect(existsSync("/tmp/tmux-4204/atmux-cockpit")).toBe(false);
  });
  test("beat 12 — review item 1: a squatter renaming /tmp/atmux-<uid> away and back never reaches doctor", async () => {
    const team = `e2e-race-${NONCE}`;
    const squat = "/tmp/atmux-4205";
    const away = `/tmp/e2e-away-${NONCE}`;
    scratch.push(squat, away);
    sh(["rm", "-rf", squat]);
    const c = as("carol");
    // carol's server, where erin's cage socket would be, carrying an agent
    // marker and a legacy-form window so either doctor probe shows a hit.
    const teamObj = {
      name: team,
      members: [{ name: "lead", role: "team-lead", emoji: "L", tui: "claude" }],
    };
    const tj = `${HOME_OF("erin")}/race-team.json`;
    writeFileSync(tj, JSON.stringify(teamObj));
    sh(["chown", `4205:${GIDS.erin}`, tj]);
    const session = actor("erin", "session-name", tj).session as string;
    sh([...c.argv, "mkdir", "-m", "777", squat, `${squat}/${team}`], c.env);
    const sock = `${squat}/${team}/sock`;
    for (const argv of [
      ["new-session", "-d", "-s", session, "-n", "L-lead", "sleep", "600"],
      ["set-environment", "-g", "AGENT", "1"],
      ["server-access", "-a", "erin"],
    ]) {
      expect(sh([...c.argv, "tmux", "-S", sock, ...argv], c.env).code).toBe(0);
    }
    started.push({ who: "carol", sock: `${away}/${team}/sock` });
    started.push({ who: "carol", sock });
    sh([...c.argv, "chmod", "777", sock], c.env);
    const flipper = Bun.spawn(
      [
        ...c.argv,
        "sh",
        "-c",
        `while :; do mv -T ${squat} ${away} 2>/dev/null; mv -T ${away} ${squat} 2>/dev/null; done`,
      ],
      { env: { PATH: process.env.PATH ?? "", ...c.env }, stdout: "ignore", stderr: "ignore" },
    );
    background.push(flipper);
    try {
      const r = actor(
        "erin",
        "doctor-race",
        JSON.stringify({ socket: sock, team: teamObj, n: 3000, control: 5000 }),
      );
      process.stderr.write(
        `beat 12: revision-2 gate reached carol's server ${String(r.control)}/5000; doctor tmux-agent-env ${String(r.agentEnv)}/3000, legacy-window ${String(r.legacy)}/3000\n`,
      );
      expect(r.ok).toBe(true);
      expect(r.agentEnv).toBe(0);
      expect(r.legacy).toBe(0);
      // Negative control: the check-then-dial gate IS raced here.
      expect(Number(r.control)).toBeGreaterThan(0);
    } finally {
      flipper.kill();
      await flipper.exited;
    }
    // Once doctor dialled, the name is erin's: carol can no longer put hers back.
    expect(modeOwner(squat)).toBe("700 4205");
  });

  test("beat 13 — review item 2: root's test-reaper never kills through, or removes, carol's planted fixture", () => {
    const prefix = `e2ereap${NONCE}`;
    // root's live server: the target of carol's planted link.
    const victimDir = `/tmp/e2e-victim-${NONCE}`;
    scratch.push(victimDir);
    sh(["install", "-d", "-m", "700", victimDir]);
    const victim = `${victimDir}/sock`;
    expect(
      sh(["tmux", "-S", victim, "new-session", "-d", "-s", "victim", "sleep", "600"], {
        HOME: HOME_OF("root"),
      }).code,
    ).toBe(0);
    started.push({ who: "root", sock: victim });
    const sidecar = (dir: string): string =>
      JSON.stringify({
        tmuxSocket: `${dir}/sock`,
        socketDir: dir,
        parentPid: 999_999_931,
        createdAt: Math.floor(Date.now() / 1000) - 7_200,
      });
    // carol's plant: her dir, a valid sidecar, `sock` -> root's server.
    const planted = `/tmp/${prefix}-plant-x`;
    scratch.push(planted);
    const c = as("carol");
    sh([...c.argv, "mkdir", "-m", "777", planted], c.env);
    writeFileSync(`${planted}/.leak-tracker.json`, sidecar(planted));
    sh(["chown", `4203:${GIDS.carol}`, `${planted}/.leak-tracker.json`]);
    sh([...c.argv, "ln", "-s", victim, `${planted}/sock`], c.env);
    // root's own leaked fixture (positive control): private dir, own server.
    const own = `/tmp/${prefix}-own-x`;
    scratch.push(own);
    sh(["install", "-d", "-m", "700", own]);
    writeFileSync(`${own}/.leak-tracker.json`, sidecar(own));
    expect(
      sh(["tmux", "-S", `${own}/sock`, "new-session", "-d", "-s", "own", "sleep", "600"], {
        HOME: HOME_OF("root"),
      }).code,
    ).toBe(0);
    started.push({ who: "root", sock: `${own}/sock` });

    const r = atmux("root", ["test-reaper", "--max-age-min", "0", "--prefix", prefix, "--json"], {
      env: { TMPDIR: "/tmp" },
    });
    expect(`${r.code} ${r.err}`).toStartWith("0 ");
    const results = (JSON.parse(r.out) as { results: Array<{ socketDir: string; status: string }> })
      .results;
    const status = Object.fromEntries(results.map((x) => [x.socketDir, x.status]));
    expect(status[planted]).toBe("unsafe-skipped");
    expect(status[own]).toBe("reaped");
    // root's server behind carol's link is alive; carol's dir is intact.
    expect(sh(["tmux", "-S", victim, "has-session", "-t", "=victim"]).code).toBe(0);
    expect(existsSync(`${planted}/.leak-tracker.json`)).toBe(true);
    // root's own fixture really was reaped.
    expect(existsSync(own)).toBe(false);
    expect(sh(["tmux", "-S", `${own}/sock`, "has-session"]).code).not.toBe(0);
  });

  test("beat 14 — review of ccd9f275 (HIGH): carol's /tmp/atmux-<frank> + symlink never makes frank's `atmux start` unlink his own live socket", () => {
    const team = `e2e-unl-${NONCE}`;
    const f = as("frank");
    // frank's live server on a pre-ADR-305 path of another team (dir 0700).
    const journal = `/tmp/atmux-e2ej${NONCE}`;
    scratch.push(journal);
    sh(["install", "-d", "-m", "700", "-o", "4206", "-g", String(GIDS.frank), journal]);
    const victim = `${journal}/sock`;
    expect(
      sh(
        [...f.argv, "tmux", "-S", victim, "new-session", "-d", "-s", "victim", "sleep", "600"],
        f.env,
      ).code,
    ).toBe(0);
    started.push({ who: "frank", sock: victim });
    // carol's plant: frank's per-user root (0755, hers) + `<team>` -> journal.
    const squat = "/tmp/atmux-4206";
    sh(["rm", "-rf", squat]);
    const c = as("carol");
    expect(sh([...c.argv, "mkdir", "-m", "755", squat], c.env).code).toBe(0);
    expect(sh([...c.argv, "ln", "-s", journal, `${squat}/${team}`], c.env).code).toBe(0);
    const legacy = `${squat}/${team}/sock`;

    // frank starts a team whose tmuxTmpdir reroutes it away from `legacy`.
    const root = teamRoot("frank", team, {});
    const tmpdir = `${root}/tmux`;
    const tj = `${root}/.atmux/team.json`;
    const obj = JSON.parse(sh(["cat", tj]).out) as Record<string, unknown>;
    writeFileSync(tj, JSON.stringify({ ...obj, tmuxTmpdir: tmpdir }));
    started.push({ who: "frank", sock: `${tmpdir}/tmux-4206/default` });
    const r = startTeam("frank", root);
    process.stderr.write(`beat 14: start exit ${r.code}\n${r.out}${r.err}\n`);
    expect(r.code).toBe(0);
    const log = `${r.out}${r.err}`;
    expect(log).not.toContain("removed stale legacy socket");
    expect(log).toContain(`legacy socket ${legacy} left in place`);
    expect(log).toContain(`${squat} is owned by uid 4203, not uid 4206`);
    // frank's live server still answers; carol's plant is as she left it.
    expect(sh([...f.argv, "tmux", "-S", victim, "has-session", "-t", "=victim"], f.env).code).toBe(
      0,
    );
    expect(sh(["test", "-S", victim]).code).toBe(0);
    expect(modeOwner(squat)).toBe("755 4203");
    expect(sh(["test", "-L", `${squat}/${team}`]).code).toBe(0);
    // …and frank's cage came up on the tmuxTmpdir path.
    expect(
      sh(
        [...f.argv, "tmux", "-S", `${tmpdir}/tmux-4206/default`, "has-session", "-t", `=${team}`],
        f.env,
      ).code,
    ).toBe(0);
  });

  test("beat 15 — review of ccd9f275 (LOW): bin/atmux-tmux checks each component before following a symlink", () => {
    const f = as("frank");
    const c = as("carol");
    const target = `/tmp/e2e-ttt-${NONCE}`;
    scratch.push(target);
    sh(["install", "-d", "-m", "700", "-o", "4206", "-g", String(GIDS.frank), target]);
    // (a) carol's link inside HER OWN directory (not sticky, so the kernel's
    //     protected_symlinks does not stop the follow): the ccd9f275 wrapper
    //     `cd -P`'d through it before checking anything and made
    //     tmux-4206 behind it; each component is now checked first.
    const carolDir = `/tmp/e2e-ttc-${NONCE}`;
    scratch.push(carolDir);
    sh(["install", "-d", "-m", "755", "-o", "4203", "-g", String(GIDS.carol), carolDir]);
    expect(sh([...c.argv, "ln", "-s", target, `${carolDir}/l`], c.env).code).toBe(0);
    const viaDir = sh([...f.argv, "sh", WRAPPER, "-V"], { ...f.env, TMUX_TMPDIR: `${carolDir}/l` });
    expect(viaDir.code).toBe(78);
    expect(viaDir.err).toContain(`${carolDir} is owned by uid 4203 (neither root nor uid 4206)`);
    expect(existsSync(`${target}/tmux-4206`)).toBe(false);
    // (b) carol's link directly in the shared sticky /tmp: refused by the
    //     wrapper's own rule, whatever fs.protected_symlinks says.
    const planted = `/tmp/e2e-ttl-${NONCE}`;
    scratch.push(planted);
    expect(sh([...c.argv, "ln", "-s", target, planted], c.env).code).toBe(0);
    const w = sh([...f.argv, "sh", WRAPPER, "-V"], { ...f.env, TMUX_TMPDIR: planted });
    expect(w.code).toBe(78);
    expect(w.err).toContain(`${planted} is a symlink`);
    expect(existsSync(`${target}/tmux-4206`)).toBe(false);
    // Positive control: frank's own real directory works.
    const ok = sh([...f.argv, "sh", WRAPPER, "-V"], { ...f.env, TMUX_TMPDIR: target });
    expect(`${ok.code} ${ok.err}`).toStartWith("0 ");
    expect(modeOwner(`${target}/tmux-4206`)).toBe("700 4206");
  });
});
