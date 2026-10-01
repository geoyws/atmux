// ADR-306: `cockpit attach --live` — fast attach to whichever cockpit is LIVE.
//
// Ports the operator dotfiles `acl` shell function (dotfiles ADR-021,
// amended 2026-10-01: `aco` = fast attach to the live cockpit, never
// creates a tmux server, refuses when ambiguous; `aca` keeps ensure-up
// then attach) into the atmux CLI so the behaviour is testable,
// documented, and shared by every machine — not just the operator's
// shell.
//
// Semantics (all read-only until the final attach exec):
//
//   1. Candidates: the socket named by `ATMUX_COCKPIT_SOCKET` when set
//      (only that one), else `atmux-cockpit` + `atmux-vendored-cockpit`.
//   2. Each candidate is probed WITHOUT starting a server: the socket
//      node must exist AND be a socket, and a connect() dial must be
//      accepted, before any tmux client runs. A `has-session` probe
//      against a dead/absent socket would make tmux START a server
//      (implicit server creation applies to every subcommand, not just
//      `new-session`) — the stat+dial gates exist to make that
//      impossible.
//   3. Missing socket + a matching server process (found by its own
//      argv `-L <name> ... new-session`, so attach clients are never
//      matched): recreate the 0700 parent dir when absent, SIGUSR1 the
//      server so tmux re-binds the socket, poll the dial up to ~2s.
//   4. Client fallback: the binary that runs the server (when readable
//      from its argv), then /opt/homebrew/bin/tmux, then
//      /opt/atmux/current/bin/tmux, then PATH tmux — the first whose
//      `has-session -t =<session>` succeeds owns the attach. Every
//      client runs with `-S <absolute socket path>` so an exported
//      TMUX_TMPDIR cannot redirect it.
//   5. Exactly one live candidate → attach. None → one-line hint naming
//      `aca`, exit 1. Several → list them, refuse, exit 1 (the operator
//      disambiguates with ATMUX_COCKPIT_SOCKET).
//
// Every process/fs/tmux side effect is an injectable seam on
// {@link LiveCockpitAttachOpts} so unit tests never touch the host's
// real sockets, servers, or tmux binaries.

import { accessSync, constants, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, spawnInheritStdio } from "../abstractions/spawn.ts";
import { VENDORED_TMUX_PATH } from "./resolve-tmux-bin.ts";
import { currentUid, probeUnixSocket, type SocketProbe } from "./socket-dir.ts";
import { createLogger, type Logger } from "./tui.ts";
/** Default live-cockpit socket candidates, in probe order. */
export const LIVE_COCKPIT_SOCKET_NAMES: ReadonlyArray<string> = [
  "atmux-cockpit",
  "atmux-vendored-cockpit",
];

/** macOS Homebrew tmux — the binary that runs the legacy cockpit the
 *  `acl` shell function was written against. Existence-gated, so it is
 *  inert on machines without Homebrew. */
export const HOMEBREW_TMUX_PATH = "/opt/homebrew/bin/tmux";

/** SIGUSR1 re-bind poll: 20 × 100ms ≈ 2s (mirrors the `acl` loop). */
export const LIVE_REBIND_POLL_ATTEMPTS = 20;
export const LIVE_REBIND_POLL_MS = 100;

/** One server process candidate for the SIGUSR1 re-bind. `bin` is the
 *  argv0 the process was started with, or null when it is not a path
 *  (tmux rewrites its own process title to `tmux: server …`, so argv0
 *  is only sometimes a usable binary). */
export interface LiveServerProcess {
  pid: number;
  bin: string | null;
}

/** A probed-live cockpit: everything `attach` + the ambiguous
 *  listing need. */
export interface LiveCockpitProbe {
  /** Client binary whose `has-session` answered. */
  bin: string;
  socketName: string;
  socketPath: string;
  session: string;
  windows: number;
  version: string;
}

/** Piped tmux-client run: success + captured stdout. */
export interface LiveRunResult {
  ok: boolean;
  stdout: string;
}

/** Filesystem kind of a candidate socket path (lstat, no follow). */
export type LiveNodeKind = "socket" | "missing" | "other";

/** All injectable seams for {@link attachLiveCockpit}. Every field is
 *  optional; unset fields use the production default beside them. */
export interface LiveCockpitAttachOpts {
  /** Cockpit session name (from cockpit.json `cockpitSession`). */
  session: string;
  /** Env override (default: process.env). */
  env?: NodeJS.ProcessEnv;
  /** Effective uid for the `tmux-<uid>` dir (default: getuid). */
  uid?: number | null;
  /** `--human` passthrough: final attach inherits stdio (default: piped). */
  inheritStdio?: boolean;
  /** Logger sink (default: createLogger(), stderr). */
  logger?: Logger;
  /** lstat-kind of a path (default: real lstatSync). */
  statNode?: (path: string) => LiveNodeKind;
  /** True when something accepts a connect() on the path (default:
   *  probeUnixSocket). Never starts a server — plain connect(). */
  dialSocket?: (path: string) => Promise<boolean>;
  /** Server processes owning `-L <name>` (default: pgrep argv scan). */
  findServers?: (socketName: string) => Promise<LiveServerProcess[]>;
  /** Ensure the socket's parent dir exists, 0700 (default: mkdirSync). */
  ensureParentDir?: (socketPath: string) => void;
  /** Ask a server to re-bind its socket (default: SIGUSR1). */
  sendRebind?: (pid: number) => void;
  /** Sleep helper for the re-bind poll (default: setTimeout). */
  sleepMs?: (ms: number) => Promise<void>;
  /** Ordered client binaries to try (default: server bin → Homebrew →
   *  vendored → PATH tmux, existence-gated + de-duplicated). */
  resolveClients?: (serverBin: string | null) => string[];
  /** Run `bin argv…` piped, capturing stdout (default: spawn, any exit). */
  runTmux?: (bin: string, argv: ReadonlyArray<string>) => Promise<LiveRunResult>;
  /** Final blocking attach exec (default: piped spawn, or inherit-stdio
   *  spawn with --human). */
  attachTmux?: (bin: string, argv: ReadonlyArray<string>, inheritStdio: boolean) => Promise<number>;
}

// ---------- production defaults (each unit-coverable in isolation) ----------

/** Default {@link LiveCockpitAttachOpts.statNode}: lstat, no follow. */
export function defaultLiveStatNode(
  path: string,
  lstat: (path: string) => { isSocket: () => boolean } = lstatSync,
): LiveNodeKind {
  let st: { isSocket: () => boolean };
  try {
    st = lstat(path);
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "other";
  }
  return st.isSocket() ? "socket" : "other";
}

/** Default {@link LiveCockpitAttachOpts.dialSocket}: connect() only. */
export function defaultLiveDialSocket(
  path: string,
  probe: (path: string) => Promise<SocketProbe> = probeUnixSocket,
): Promise<boolean> {
  return probe(path).then((r) => r === "live");
}

/** Escape a socket name for the pgrep ERE (the override comes from the
 *  operator's env — never let it widen the match). Branchless. */
export function escapePgrepPattern(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse `pgrep -f -a` output (`<pid> <full argv>`) into server
 *  candidates. Keeps only lines that literally contain `-L <name> `
 *  (the ERE already required `new-session`, which attach clients never
 *  carry — the literal check closes over-match from odd argv shapes). */
export function parsePgrepAf(stdout: string, socketName: string): LiveServerProcess[] {
  const needle = `-L ${socketName} `;
  const out: LiveServerProcess[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.includes(needle) || !line.includes("new-session")) continue;
    const m = /^(\d+)\s+(\S+)/.exec(line.trim());
    if (m === null) continue;
    const bin = (m[2] as string).includes("/") ? (m[2] as string) : null;
    out.push({ pid: Number(m[1]), bin });
  }
  return out;
}

/** Raw `pgrep -u <uid> -f -a` stdout for the server-argv pattern. The
 *  leading `[ ]` keeps the ERE from starting with a dash (no `--`
 *  terminator needed) and from matching pgrep's own argv. Resolves to
 *  `""` when pgrep finds nothing (exit 1). */
export async function defaultPgrepAf(
  socketName: string,
  uid: number,
  run: (argv: ReadonlyArray<string>) => Promise<{ exitCode: number; stdout: string }> = (argv) =>
    spawn({ cmd: "pgrep", argv: [...argv], expectExitCode: "any" }).then((r) => ({
      exitCode: r.exitCode,
      stdout: r.stdout,
    })),
): Promise<string> {
  const pattern = `[ ]-L ${escapePgrepPattern(socketName)} .*new-session`;
  const r = await run(["-u", String(uid), "-f", "-a", pattern]);
  return r.exitCode === 0 ? r.stdout : "";
}

/** Default {@link LiveCockpitAttachOpts.findServers}: pgrep argv scan.
 *  Never throws — pgrep missing / no match both read as "no server". */
export async function defaultFindLiveServers(
  socketName: string,
  uid: number | null,
  pgrepAf: (socketName: string, uid: number) => Promise<string> = defaultPgrepAf,
): Promise<LiveServerProcess[]> {
  if (uid === null) return [];
  try {
    return parsePgrepAf(await pgrepAf(socketName, uid), socketName);
  } catch {
    return [];
  }
}

/** Default {@link LiveCockpitAttachOpts.ensureParentDir}: `mkdir -m 700 -p`. */
export function defaultEnsureLiveParentDir(
  socketPath: string,
  mkdir: (dir: string) => void = (dir) => mkdirSync(dir, { mode: 0o700, recursive: true }),
): void {
  mkdir(dirname(socketPath));
}

/** Default {@link LiveCockpitAttachOpts.sendRebind}: SIGUSR1. */
export function defaultSendLiveRebind(
  pid: number,
  kill: (pid: number, signal: NodeJS.Signals) => void = (p, s) => {
    process.kill(p, s);
  },
): void {
  kill(pid, "SIGUSR1");
}

/** Default {@link LiveCockpitAttachOpts.sleepMs}. */
export function defaultLiveSleepMs(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Default executable gate for the client fallback order. */
export function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Default {@link LiveCockpitAttachOpts.resolveClients}: the `acl`
 *  order — server binary first, then Homebrew, then vendored, then
 *  PATH tmux — existence-gated and de-duplicated. The `has-session`
 *  gate in the probe (not this order) is what proves a client can
 *  actually talk to the server. */
export function defaultResolveLiveClients(
  serverBin: string | null,
  isExecutable: (path: string) => boolean = defaultIsExecutable,
  whichTmux: () => string | null = () => Bun.which("tmux"),
): string[] {
  const pathTmux = whichTmux();
  const ordered = [serverBin, HOMEBREW_TMUX_PATH, VENDORED_TMUX_PATH, pathTmux];
  const out: string[] = [];
  for (const bin of ordered) {
    if (bin === null || out.includes(bin) || !isExecutable(bin)) continue;
    out.push(bin);
  }
  return out;
}

/** Default {@link LiveCockpitAttachOpts.runTmux}: piped spawn, any
 *  exit; spawn failure reads as not-ok (never throws). */
export async function defaultRunLiveTmux(
  bin: string,
  argv: ReadonlyArray<string>,
): Promise<LiveRunResult> {
  try {
    const r = await spawn({ cmd: bin, argv: [...argv], expectExitCode: "any" });
    return { ok: r.exitCode === 0, stdout: r.stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/** Default {@link LiveCockpitAttachOpts.attachTmux}: piped spawn, or
 *  the ADR-180 inherit-stdio spawn with `--human`. */
export async function defaultAttachLiveTmux(
  bin: string,
  argv: ReadonlyArray<string>,
  inheritStdio: boolean,
): Promise<number> {
  if (inheritStdio) return spawnInheritStdio({ cmd: bin, argv: [...argv] });
  const r = await spawn({ cmd: bin, argv: [...argv], expectExitCode: "any" });
  return r.exitCode;
}

// ---------- socket-path + candidate resolution ----------

/** Absolute socket path for one candidate name — the same
 *  `${TMUX_TMPDIR:-/tmp}/tmux-<uid>/<name>` construction tmux's `-L`
 *  uses (mirrors `getCockpitSocketPath`, per-name so `--live` can probe
 *  both candidates). Always absolute: `-S` never consults TMUX_TMPDIR. */
export function liveCandidateSocketPath(
  socketName: string,
  env: NodeJS.ProcessEnv,
  uid: number,
): string {
  const tmpdir = env.TMUX_TMPDIR;
  const base = tmpdir !== undefined && tmpdir.length > 0 ? tmpdir : "/tmp";
  return join(base, `tmux-${uid}`, socketName);
}

/** Candidate socket names: the `ATMUX_COCKPIT_SOCKET` override alone
 *  when set (empty reads as unset, mirroring `getCockpitSocketName`),
 *  else the `atmux-cockpit` + `atmux-vendored-cockpit` pair. */
export function liveCandidateNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.ATMUX_COCKPIT_SOCKET;
  if (override !== undefined && override.length > 0) return [override];
  return [...LIVE_COCKPIT_SOCKET_NAMES];
}

// ---------- probe ----------

/** Resolved seams (defaults applied) shared by probe + attach. Exported
 *  so tests can build one probe-seam bundle and reuse it across
 *  `probeLiveCandidate` calls. */
export interface LiveProbeSeams {
  statNode: (path: string) => LiveNodeKind;
  dialSocket: (path: string) => Promise<boolean>;
  findServers: (socketName: string) => Promise<LiveServerProcess[]>;
  ensureParentDir: (socketPath: string) => void;
  sendRebind: (pid: number) => void;
  sleepMs: (ms: number) => Promise<void>;
  resolveClients: (serverBin: string | null) => string[];
  runTmux: (bin: string, argv: ReadonlyArray<string>) => Promise<LiveRunResult>;
  attachTmux: (bin: string, argv: ReadonlyArray<string>, inheritStdio: boolean) => Promise<number>;
}

function resolveSeams(opts: LiveCockpitAttachOpts, uid: number | null): LiveProbeSeams {
  return {
    statNode: opts.statNode ?? defaultLiveStatNode,
    dialSocket: opts.dialSocket ?? defaultLiveDialSocket,
    findServers: opts.findServers ?? ((name) => defaultFindLiveServers(name, uid)),
    ensureParentDir: opts.ensureParentDir ?? defaultEnsureLiveParentDir,
    sendRebind: opts.sendRebind ?? defaultSendLiveRebind,
    sleepMs: opts.sleepMs ?? defaultLiveSleepMs,
    resolveClients: opts.resolveClients ?? defaultResolveLiveClients,
    runTmux: opts.runTmux ?? defaultRunLiveTmux,
    attachTmux: opts.attachTmux ?? defaultAttachLiveTmux,
  };
}

/** Probe one candidate socket for a live `<session>`. Returns the probe,
 *  or null when the candidate is not live. Never creates a server:
 *  tmux runs only after stat says socket AND dial connects. */
export async function probeLiveCandidate(
  socketName: string,
  socketPath: string,
  session: string,
  seams: LiveProbeSeams,
  serverBinForClients?: (socketName: string) => Promise<string | null>,
): Promise<LiveCockpitProbe | null> {
  if (seams.statNode(socketPath) === "missing") {
    // Deleted socket (or its tmux-<uid> dir) with the server still
    // running: recreate the 0700 dir, SIGUSR1 so tmux re-binds, poll
    // the dial up to ~2s. No server process → not live, stop here
    // (never run a server-creating command).
    const servers = await seams.findServers(socketName);
    if (servers.length === 0) return null;
    seams.ensureParentDir(socketPath);
    for (const s of servers) {
      try {
        seams.sendRebind(s.pid);
      } catch {}
    }
    let rebound = false;
    for (let i = 0; i < LIVE_REBIND_POLL_ATTEMPTS; i++) {
      if (seams.statNode(socketPath) === "socket" && (await seams.dialSocket(socketPath))) {
        rebound = true;
        break;
      }
      await seams.sleepMs(LIVE_REBIND_POLL_MS);
    }
    if (!rebound) return null;
  } else if (seams.statNode(socketPath) !== "socket") {
    // Non-socket node (regular file, dir, …): never hand to tmux — a
    // client dial against it would START a server.
    return null;
  }
  // A socket node with no listener (dead) is refused here too: the dial
  // is a plain connect(), so only a live server gets us to tmux.
  if (!(await seams.dialSocket(socketPath))) return null;

  const target = `=${session}`;
  const serverBin =
    serverBinForClients === undefined ? null : await serverBinForClients(socketName);
  const tried = seams.resolveClients(serverBin);
  for (const bin of tried) {
    // `-u` on every client call (ADR-307): a POSIX locale would otherwise
    // rewrite tabs in tmux output.
    const has = await seams.runTmux(bin, ["-u", "-S", socketPath, "has-session", "-t", target]);
    if (!has.ok) continue;
    const windows = await seams.runTmux(bin, [
      "-u",
      "-S",
      socketPath,
      "list-windows",
      "-t",
      target,
    ]);
    const count = windows.stdout.split("\n").filter((l) => l.length > 0).length;
    // A session always has ≥1 window — 0 means the client is not
    // really answering; try the next binary.
    if (!windows.ok || count === 0) continue;
    const version = await seams.runTmux(bin, [
      "-u",
      "-S",
      socketPath,
      "display-message",
      "-p",
      "-t",
      target,
      "#{version}",
    ]);
    return {
      bin,
      socketName,
      socketPath,
      session,
      windows: count,
      version: version.stdout.trim() || "unknown",
    };
  }
  return null;
}

/** Server binary for the client fallback order: first argv0-looking
 *  path from the matched server processes, else null (the order falls
 *  back to Homebrew → vendored → PATH; `has-session` still gates). */
export async function serverBinForCandidate(
  socketName: string,
  findServers: (socketName: string) => Promise<LiveServerProcess[]>,
): Promise<string | null> {
  const servers = await findServers(socketName);
  for (const s of servers) {
    if (s.bin !== null) return s.bin;
  }
  return null;
}

// ---------- top-level ----------

/**
 * `cockpit attach --live`: attach to whichever candidate cockpit is
 * LIVE — never ensure-up, reconcile, TUI-launch, or server-create.
 * Returns the attach exit code, or 1 with a one-line hint (none live)
 * or a candidate listing (ambiguous).
 */
export async function attachLiveCockpit(opts: LiveCockpitAttachOpts): Promise<number> {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? createLogger();
  const uid = opts.uid !== undefined ? opts.uid : currentUid();
  const seams = resolveSeams(opts, uid);
  const effectiveUid = uid ?? 0;

  const names = liveCandidateNames(env);
  const live: LiveCockpitProbe[] = [];
  for (const name of names) {
    const socketPath = liveCandidateSocketPath(name, env, effectiveUid);
    const hit = await probeLiveCandidate(name, socketPath, opts.session, seams, (n) =>
      serverBinForCandidate(n, seams.findServers),
    );
    if (hit !== null) {
      live.push(hit);
    }
  }

  if (live.length === 1) {
    const only = live[0] as LiveCockpitProbe;
    // Mirror `attachWithTmux`: never inherit the outer $TMUX into the
    // attach (tmux's nesting refusal); the -S path already pins the
    // socket. Always restore.
    const priorTmux = process.env.TMUX;
    if (priorTmux !== undefined) delete process.env.TMUX;
    try {
      return await seams.attachTmux(
        only.bin,
        ["-u", "-S", only.socketPath, "attach-session", "-t", `=${only.session}`],
        opts.inheritStdio === true,
      );
    } finally {
      if (priorTmux !== undefined) process.env.TMUX = priorTmux;
    }
  }

  if (live.length === 0) {
    logger.warn(
      `cockpit --live: no live cockpit on ${names.join(", ")} — start it with 'aca' (atmux cockpit attach)`,
    );
    return 1;
  }

  for (const c of live) {
    logger.warn(
      `cockpit --live: ${c.socketPath} session=${c.session} windows=${c.windows} tmux=${c.version}`,
    );
  }
  logger.warn(
    `cockpit --live: ${live.length} live cockpits — refusing to guess; set ATMUX_COCKPIT_SOCKET to one of: ${live.map((c) => c.socketName).join(", ")}`,
  );
  return 1;
}
