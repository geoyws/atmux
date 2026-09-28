// E2E — `tmux-agent-env` doctor probe (ADR-294) through the REAL CLI.
//
// Real tmux servers on scratch sockets inside one mkdtemp dir, started
// with atmux's shipped conf, then the real `bin/atmux doctor --json` as a
// subprocess. The doctor is pointed at the scratch estate ONLY through
// seams atmux already honours — `ATMUX_COCKPIT_CONFIG` (a scratch
// cockpit.json listing scratch teams), `ATMUX_COCKPIT_SOCKET` +
// `TMUX_TMPDIR` (a cockpit socket path inside the scratch dir), `HOME`,
// `--team-dir` and `ATMUX_TMUX_BIN` — so it never discovers a live
// server. Every name that also lands on a fixed `/tmp/atmux-*` path
// (legacy cage sockets, the group socket) carries a per-run nonce and is
// asserted absent before and after.
//
// Beats (one per test, in order; they share the servers):
//   1. polluted server → one row naming that socket + AGENT, CI, EDITOR
//   2. clean live server → no row
//   3. dead sockets (missing file; stale file with no server) → skipped,
//      and NO server was created on either
//   4. the row's remedy commands, run as written, clear the finding
//
// Scratch servers are started from a minimal environment on purpose: the
// runner is often an agent shell itself, and inheriting it would make the
// "clean" server polluted. ADR-282: env is read only by NAME here, and
// the one value inspected (`NO_COLOR`) is queried by name.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CANONICAL_ATMUX_TMUX_CONF_PATH } from "../helpers/tmux.ts";

setDefaultTimeout(90_000);

const REPO_ROOT = resolve(import.meta.dir, "../..");
const TMUX_BIN = Bun.which("tmux");
const UID = process.getuid?.() ?? 0;
const NONCE = `aenv${process.pid}${Date.now().toString(36)}`;
const LABEL = "tmux-agent-env";

interface TeamFixture {
  name: string;
  root: string;
  socket: string;
}

let work = "";
let home = "";
let polluted: TeamFixture;
let clean: TeamFixture;
let dead: TeamFixture;
let stale: TeamFixture;
let cockpitSocket = "";
const groupSocket = `/tmp/atmux-grp-${NONCE}/sock`;
const startedSockets: string[] = [];
/** Beat 1's hint, run verbatim by beat 4. */
let remedy = "";

/** Run tmux against `socket` with a minimal, agent-free environment. */
function tmuxAt(socket: string, argv: string[]): { exitCode: number; stdout: string } {
  const proc = Bun.spawnSync({
    cmd: [TMUX_BIN ?? "tmux", "-S", socket, ...argv],
    env: { PATH: process.env.PATH ?? "", HOME: home, TERM: "xterm-256color" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout?.toString() ?? "" };
}

async function makeTeam(tag: string): Promise<TeamFixture> {
  const name = `${NONCE}-${tag}`;
  const root = join(work, tag);
  const tmuxTmpdir = join(root, ".atmux", "tmux");
  await mkdir(join(tmuxTmpdir, `tmux-${UID}`), { recursive: true });
  await writeFile(
    join(root, ".atmux", "team.json"),
    JSON.stringify({ name, tmuxTmpdir, members: [] }),
  );
  return { name, root, socket: join(tmuxTmpdir, `tmux-${UID}`, "default") };
}

function startServer(t: TeamFixture): void {
  const r = tmuxAt(t.socket, [
    "-f",
    CANONICAL_ATMUX_TMUX_CONF_PATH,
    "new-session",
    "-d",
    "-s",
    t.name,
    "-x",
    "80",
    "-y",
    "24",
    "while :; do sleep 86400; done",
  ]);
  expect(r.exitCode).toBe(0);
  startedSockets.push(t.socket);
}

interface DoctorJsonRow {
  status: string;
  label: string;
  detail: string;
  hint: string;
}

/** The real CLI entrypoint, pointed at the scratch estate only. The env
 *  is built from scratch (not merged onto the runner's), so no live
 *  `ATMUX_*` / `TMUX` pointer can steer it at a real server. */
function runDoctor(): DoctorJsonRow[] {
  const proc = Bun.spawnSync({
    cmd: [
      process.execPath,
      join(REPO_ROOT, "bin/atmux"),
      "doctor",
      "--json",
      "--team-dir",
      clean.root,
    ],
    cwd: clean.root,
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      HOME: home,
      TMUX_TMPDIR: join(work, "tt"),
      ATMUX_COCKPIT_SOCKET: "ck",
      ATMUX_COCKPIT_CONFIG: join(work, "cockpit.json"),
      ATMUX_TMUX_BIN: TMUX_BIN ?? "",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  // 0 = green, 1 = some unrelated red row in the scratch estate; anything
  // else is a crash, and the JSON parse below would fail on it anyway.
  expect([0, 1]).toContain(proc.exitCode ?? -1);
  const parsed = JSON.parse(proc.stdout?.toString() ?? "") as { checks: DoctorJsonRow[] };
  return parsed.checks.filter((c) => c.label === LABEL);
}

describe.skipIf(TMUX_BIN === null)(
  "e2e: atmux doctor flags agent-shell env in tmux servers",
  () => {
    beforeAll(async () => {
      // Short root: unix socket paths cap at ~104 bytes on macOS.
      work = await mkdtemp("/tmp/aenv-");
      home = join(work, "home");
      await mkdir(home, { recursive: true });
      polluted = await makeTeam("p");
      clean = await makeTeam("c");
      dead = await makeTeam("d");
      stale = await makeTeam("s");
      cockpitSocket = join(work, "tt", `tmux-${UID}`, "ck");
      await writeFile(
        join(work, "cockpit.json"),
        JSON.stringify({
          schemaVersion: 1,
          sessions: [
            {
              type: "group",
              name: NONCE,
              sessions: [{ type: "team", name: polluted.name, root: polluted.root }],
            },
            { type: "team", name: clean.name, root: clean.root },
            { type: "team", name: dead.name, root: dead.root },
            { type: "team", name: stale.name, root: stale.root },
          ],
        }),
      );

      startServer(polluted);
      startServer(clean);
      // Stale: a real socket file whose server has exited.
      startServer(stale);
      expect(tmuxAt(stale.socket, ["kill-server"]).exitCode).toBe(0);

      for (const [name, value] of [
        ["AGENT", "1"],
        ["CI", "true"],
        ["EDITOR", "true"],
      ] as const) {
        expect(tmuxAt(polluted.socket, ["set-environment", "-g", name, value]).exitCode).toBe(0);
      }
    });

    afterAll(async () => {
      for (const sock of startedSockets) tmuxAt(sock, ["kill-server"]);
      if (work !== "") await rm(work, { recursive: true, force: true });
    });

    test("beat 1 — a polluted server is reported by socket and variable NAMES", () => {
      const rows = runDoctor();
      // Exactly one row: the scratch estate has one polluted server, and
      // nothing outside it was discovered.
      expect(rows).toHaveLength(1);
      const row = rows[0] as DoctorJsonRow;
      expect(row.status).toBe("yellow");
      expect(row.detail).toBe(
        `team ${polluted.name} server ${polluted.socket} carries agent-shell env: AGENT, CI, EDITOR`,
      );
      for (const v of ["AGENT", "CI", "EDITOR"]) {
        expect(row.hint).toContain(`tmux -S ${polluted.socket} set-environment -g -u ${v}`);
      }
      expect(row.hint).toContain(
        "panes already running keep the old environment until their processes restart",
      );
      remedy = row.hint;
    });

    test("beat 2 — a clean live server (conf's `-NO_COLOR` mark included) is not reported", () => {
      // Live, so silence is a verdict and not a skipped probe.
      expect(tmuxAt(clean.socket, ["has-session"]).exitCode).toBe(0);
      // The shipped conf leaves `-NO_COLOR` (removal mark), which must read as healthy.
      expect(tmuxAt(clean.socket, ["show-environment", "-g", "NO_COLOR"]).stdout.trim()).toBe(
        "-NO_COLOR",
      );
      const rows = runDoctor();
      expect(rows.some((r) => r.detail.includes(clean.socket))).toBe(false);
    });

    test("beat 3 — missing and stale sockets are skipped, and no server is created on them", () => {
      const neverThere = [dead.socket, cockpitSocket, groupSocket, `/tmp/atmux-${dead.name}/sock`];
      for (const p of neverThere) expect(existsSync(p)).toBe(false);
      expect(existsSync(stale.socket)).toBe(true);

      const rows = runDoctor();
      for (const p of [...neverThere, stale.socket]) {
        expect(rows.some((r) => r.detail.includes(p))).toBe(false);
      }
      // Probing created nothing: missing paths are still missing, and the
      // stale socket still has no server behind it.
      for (const p of neverThere) expect(existsSync(p)).toBe(false);
      expect(tmuxAt(stale.socket, ["has-session"]).exitCode).not.toBe(0);
    });

    test("beat 4 — running the row's remedy commands verbatim clears the finding", () => {
      // `<cmd>; <cmd>; <cmd> — <caveat>`: run each command as written, with
      // the leading `tmux` resolved to the binary the servers run on.
      const cmds = remedy.split(" — ")[0]?.split("; ") ?? [];
      expect(cmds).toHaveLength(3);
      for (const cmd of cmds) {
        const [bin, flag, socket, ...rest] = cmd.split(" ");
        expect([bin, flag, socket]).toEqual(["tmux", "-S", polluted.socket]);
        expect(tmuxAt(polluted.socket, rest).exitCode).toBe(0);
      }
      expect(runDoctor()).toEqual([]);
    });
  },
);
