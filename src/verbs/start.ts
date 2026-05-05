// ADR-010: CLI dispatcher — `start` verb (lifecycle MVP).
// ADR-003: src/verbs/start.ts — domain verb; imports allowed:
//   src/core/*, src/abstractions/*, src/schema/*, src/errors.
// ADR-004 amend (2026-05-05): every tmux call goes through a
//   `createTmux({ socket } | { socketPath })` namespace — there is no
//   default factory and the socket flag is the load-bearing isolation
//   guarantee (incident 2026-05-05 01:44 MYT,
//   memory ref `feedback_tmux_test_isolation.md`).
//
// Bash port target: lib/start.sh @ 2aadc3f. Source-cited per memory
// `feedback_lead_task_desc_source_grep.md`.
//
// MVP scope (Phase 2 lifecycle wave — operator wants atmux-bun usable):
//
// PORTED:
// - Arg parsing: `--force|-f`, `--doctor`, `--no-doctor`, `--socket`,
//   `--socket-path` (lib/start.sh:19-26 + Phase 2 socket flag per task brief)
// - Team load + ensure-dirs (lib/start.sh:12-14)
// - Live-lead guard: warn-keep on existing session w/o --force; kill on
//   --force (lib/start.sh:140-147)
// - Session creation with `__<team>__home` placeholder window
//   (lib/start.sh:156, 200-204)
// - Per-member window spawn — one window per `team.members[]` entry,
//   named via `common.buildWindowName(member, emoji)` (post-2026-05-05
//   amend, ADR-017 — `__<team>__` prefix dropped) and rooted
//   at the member's `cwd` (lib/start.sh:272-283 + _atmux_spawn_member
//   lib/start.sh:400-440 — minus the TUI launch + brief paste, both of
//   which depend on `lib/tui.sh`'s `atmux::tui_cmd` resolver that has
//   not yet been ported. Operator can attach + manually launch the TUI
//   per-pane until Phase 2 lands the TS port of tui_cmd.)
// - Skip-existing-window incremental restart (lib/start.sh:277-280)
// - Close `__<team>__home` placeholder when other windows exist
//   (lib/start.sh:288-294)
// - Record start timestamp at `state/session-start.txt` (lib/start.sh:354)
//
// DEFERRED — explicit rationale per source line:
// - `singleSession` (lib/start.sh:36-78) — needs cross-socket
//   `tmux display-message` resolution to capture the driver's session
//   name. Phase 2 architectural follow-up; verb refuses with a
//   `ConfigError` pointing at the open issue rather than silently
//   degrading to per-team session.
// - Cage-socket safeguard (lib/start.sh:40-64) — bash guards against
//   bare-tmux fallback honouring `$TMUX` over `$TMUX_TMPDIR`. The TS
//   port has no bare-tmux fallback by construction (createTmux requires
//   explicit `socket` / `socketPath`), so the failure mode the bash
//   block guards against is structurally impossible here. Reviewer
//   check #9 covers ongoing enforcement.
// - Doctor preflight (lib/start.sh:81-93, 95-119, 121-133) — flags are
//   accepted + parsed for arg-shape parity, but `doctor` has not been
//   ported yet. The verb logs a one-line "doctor mode skipped (Phase 2
//   port pending)" notice when doctor mode is `verbose` or `preflight`,
//   and proceeds. ADR-013 §"Phase 5 deferral" governs.
// - Cage tmux prefix override (lib/start.sh:206-236) — aesthetic config
//   for nested tmux topology; Phase 5 with the cage stack.
// - Registry touch (lib/start.sh:238-270) — depends on `lib/registry.sh`
//   which is Phase 5 WIP per ADR-013.
// - Driver auto-spawn paths (lib/start.sh:177-204, 296-327) — depends
//   on `atmux::tui_cmd` resolver (Phase 2).
// - Supervisor auto-spawn (lib/start.sh:329-351) — Phase 5 (ADR-013,
//   socket-pubsub WIP).
// - `spawn-snapshot.json` for reload-config (lib/start.sh:357-364) —
//   Phase 2 follow-up; reload-config verb not yet ported.
// - Cron auto-install (lib/start.sh:368-383) — Phase 2 follow-up;
//   needs `lib/cron.sh` port + the `whip`/`report`/`groom` verbs.
// - On-activate groom (lib/start.sh:391-397) — Phase 2 follow-up;
//   `groom` verb not yet ported.
// - Per-member `_atmux_spawn_member` body: emoji write-through to
//   registry (lib/start.sh:418-421), TUI command resolution + send-keys
//   launch (lib/start.sh:447-448), TUI boot wait + brief paste
//   (lib/start.sh:451-461). All deferred until tui_cmd / registry land.
//   The MVP spawns an empty pane (default shell); operator attaches
//   and launches the TUI manually.
// - Inbox file initialization (lib/start.sh:443-444) — depends on
//   `inbox.json` schema which Phase 2 task #18 (task add) will land.
//
// **Socket resolver — Phase 2 architectural decision pending.**
// Per task brief: accept `--socket <name>` (-L) or `--socket-path <abs>`
// (-S). Default when neither given: `socketPath = /tmp/atmux-<team>/sock`,
// matching the bash cage convention `<TMUX_TMPDIR>/tmux-<uid>/default`
// (paraphrased — see ADR-018 / project_cage_topology_2026_04_27.md).
// The final resolver (env? team.json? cage-derived?) is the open
// question listed in `src/core/common.ts` §"Socket resolver" + ADR-004
// amend Consequences §Phase 2.

import { join } from "node:path";
import { writeText } from "../abstractions/fs.ts";
import { now } from "../abstractions/time.ts";
import { createTmux, type TmuxConfig, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  buildWindowName,
  defaultEmojiForRole,
  ensureAtmuxDirs,
  getAtmuxDir,
  getSessionName,
  loadTeam,
  stateDir,
} from "../core/common.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { ConfigError, UsageError } from "../errors.ts";

// ---------- Arg parsing ----------

/** Doctor preflight mode — bash `lib/start.sh:17`. Until `doctor` lands
 *  in TS the modes are accepted for arg-shape parity but only logged. */
export type DoctorMode = "preflight" | "verbose" | "skip";

export interface ParsedStartArgs {
  force: boolean;
  doctorMode: DoctorMode;
  /** -L socket short-name; mutually exclusive with `socketPath`. */
  socket?: string;
  /** -S socket absolute path; mutually exclusive with `socket`. */
  socketPath?: string;
}

/**
 * Parse `start` argv. Mirrors the case-loop at lib/start.sh:19-26 plus
 * the Phase 2 `--socket`/`--socket-path` flag pair.
 *
 * `ATMUX_DOCTOR_ON_START` env override flips the default to `verbose`
 * (lib/start.sh:18). Tests inject `env` rather than mutate `process.env`.
 */
export function parseStartArgs(
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): ParsedStartArgs {
  let force = false;
  const onStart = env.ATMUX_DOCTOR_ON_START;
  let doctorMode: DoctorMode =
    onStart !== undefined && onStart.length > 0 ? "verbose" : "preflight";
  let socket: string | undefined;
  let socketPath: string | undefined;

  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? "";
    switch (a) {
      case "--force":
      case "-f":
        force = true;
        i += 1;
        break;
      case "--doctor":
        doctorMode = "verbose";
        i += 1;
        break;
      case "--no-doctor":
        doctorMode = "skip";
        i += 1;
        break;
      case "--socket": {
        const val = args[i + 1];
        if (val === undefined || val.length === 0) {
          throw new UsageError({
            what: "start: --socket requires a value",
            hint: "usage: atmux start [--force] [--doctor|--no-doctor] [--socket <name> | --socket-path <abspath>]",
          });
        }
        socket = val;
        i += 2;
        break;
      }
      case "--socket-path": {
        const val = args[i + 1];
        if (val === undefined || val.length === 0) {
          throw new UsageError({
            what: "start: --socket-path requires a value",
            hint: "usage: atmux start [--force] [--doctor|--no-doctor] [--socket <name> | --socket-path <abspath>]",
          });
        }
        socketPath = val;
        i += 2;
        break;
      }
      default:
        throw new UsageError({
          what: `start: unknown arg: ${a}`,
          hint: "see lib/start.sh:19-26 for accepted flags",
        });
    }
  }

  if (socket !== undefined && socketPath !== undefined) {
    throw new UsageError({
      what: "start: --socket and --socket-path are mutually exclusive",
      hint: "pick one — short-name (-L) or absolute path (-S)",
    });
  }

  // exactOptionalPropertyTypes: only include socket / socketPath keys
  // when they're actually defined.
  const out: ParsedStartArgs = { force, doctorMode };
  if (socket !== undefined) out.socket = socket;
  if (socketPath !== undefined) out.socketPath = socketPath;
  return out;
}

/**
 * Default socket path when neither `--socket` nor `--socket-path` is
 * supplied. `/tmp/atmux-<team>/sock` matches the bash cage convention
 * (see file header §"Socket resolver" — Phase 2 final resolver pending).
 *
 * Exported so the `init` verb can mirror the same default when seeding
 * a fresh team's tmpdir, and so tests have a stable expectation.
 */
export function defaultSocketPath(team: string): string {
  return `/tmp/atmux-${team}/sock`;
}

// ---------- Verb entry ----------

export interface StartOpts {
  /** Override `process.env`. Tests pass a curated subset. */
  env?: NodeJS.ProcessEnv;
  /** Override cwd for `getAtmuxDir` walk-up + per-window default cwd. */
  cwd?: string;
  /** Inject the tmux factory for tests (default: `createTmux`). The factory
   *  receives the resolved socket config; tests may close over a per-test
   *  socket to keep isolation per `feedback_tmux_test_isolation.md`. */
  tmuxFactory?: (cfg: TmuxConfig) => TmuxNamespace;
  /** Logger sink override (default: `createLogger()`, stderr). Tests pass
   *  an in-memory sink so output assertions don't go through stderr. */
  logger?: Logger;
}

/**
 * `atmux start` — spawn a tmux session for the team, with one window
 * per `team.members[]` entry. Window names follow
 * `common.buildWindowName(member, emoji)` (ADR-017).
 *
 * Returns the process exit code (0 on success). Errors propagate as
 * tagged `AtmuxError`s; the dispatcher in `src/cli.ts` maps to the
 * BSD sysexit per ADR-006.
 */
export async function start(args: ReadonlyArray<string>, opts: StartOpts = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const parsed = parseStartArgs(args, env);
  const logger = opts.logger ?? createLogger();
  const factory = opts.tmuxFactory ?? createTmux;

  // 1. Load team + ensure standard dirs (lib/start.sh:12-14).
  // exactOptionalPropertyTypes: build the resolve-opts conditionally so
  // we never pass `cwd: undefined` (which the strict mode rejects).
  const resolveOpts: { env: NodeJS.ProcessEnv; cwd?: string } = { env };
  if (opts.cwd !== undefined) resolveOpts.cwd = opts.cwd;
  const dir = await getAtmuxDir(resolveOpts);
  const team = await loadTeam(resolveOpts);
  await ensureAtmuxDirs(dir);

  // 2. Single-session refusal (lib/start.sh:36-78). Bash captures $TMUX's
  //    session via `tmux display-message`; the TS port punts on that
  //    cross-socket capture pending Phase 2 spec — see file header.
  const driverSessionEnv = env.ATMUX_DRIVER_SESSION;
  const single =
    team.singleSession === true || (driverSessionEnv !== undefined && driverSessionEnv.length > 0);
  if (single) {
    throw new ConfigError({
      what: "start: single-session mode not yet ported to atmux-bun (lib/start.sh:36-78)",
      hint: "set team.singleSession=false (or unset ATMUX_DRIVER_SESSION) to use the per-team session path",
    });
  }

  // 3. Resolve doctor mode (parsed for arg-shape parity; preflight body
  //    deferred — see file header).
  if (parsed.doctorMode !== "skip") {
    logger.log(
      `doctor mode '${parsed.doctorMode}' requested — preflight body deferred to Phase 2 (lib/start.sh:81-133)`,
    );
  }

  // 4. Resolve tmux socket. Phase 2 spec pending; defaults to
  //    `/tmp/atmux-<team>/sock` per task brief.
  const tmuxConfig: TmuxConfig = resolveTmuxConfig(team.name, parsed);
  const tmux = factory(tmuxConfig);

  // 5. Resolve session name (defaults to `atmux-<team>` per
  //    common.getSessionName — also handles ATMUX_SESSION env override
  //    + state/session.txt anchor if present).
  const sessionOpts: { env: NodeJS.ProcessEnv; cwd?: string; team: typeof team } = { env, team };
  if (opts.cwd !== undefined) sessionOpts.cwd = opts.cwd;
  const session = await getSessionName(sessionOpts);

  // 6. Live-lead guard (lib/start.sh:140-147).
  const sessionExisted = await tmux.session.hasSession(session);
  if (sessionExisted) {
    if (!parsed.force) {
      logger.warn(
        `session ${session} already exists. Running start in incremental mode (existing windows kept).`,
      );
    } else {
      logger.warn(`force: killing existing session ${session}`);
      try {
        await tmux.session.killSession(session);
      } catch {
        // expected: race window between hasSession and killSession;
        // the post-create branch below treats `hasSession=false` as
        // "create fresh"
      }
    }
  }

  // 7. Create session if missing with the `__<team>__home` placeholder
  //    (lib/start.sh:156, 200-204). Always recheck — `--force` may have
  //    just killed an existing session.
  const homeWin = `__${team.name}__home`;
  const stillExists = sessionExisted && !parsed.force;
  if (!stillExists) {
    await tmux.session.newSession({
      name: session,
      windowName: homeWin,
      cwd: opts.cwd ?? process.cwd(),
    });
    logger.ok(`created tmux session: ${session}`);
  }

  // 8. Spawn each member as a window (lib/start.sh:272-283 +
  //    _atmux_spawn_member lib/start.sh:400-440 — minus deferred
  //    TUI launch + brief paste).
  const existing = await tmux.window.listWindows(session);
  const existingNames = new Set(existing.map((w) => w.name));
  let spawned = 0;
  for (const member of team.members) {
    const role = member.role ?? "member";
    const emoji = member.emoji ?? defaultEmojiForRole(role);
    const win = buildWindowName(member.name, emoji);
    if (existingNames.has(win)) {
      logger.log(`  · ${member.name}: window exists, skipping (use --force to reset)`);
      continue;
    }
    const memberCwd = member.cwd ?? opts.cwd ?? process.cwd();
    await tmux.window.newWindow({
      sessionName: session,
      name: win,
      cwd: memberCwd,
      detached: true,
    });
    logger.log(`  · ${member.name} (role=${role}): spawned window ${win}`);
    spawned += 1;
  }

  // 9. Close the `__<team>__home` placeholder if any members spawned
  //    AND non-placeholder windows now exist (lib/start.sh:288-294).
  if (spawned > 0) {
    const after = await tmux.window.listWindows(session);
    const hasHome = after.some((w) => w.name === homeWin);
    const otherCount = after.filter((w) => w.name !== homeWin).length;
    if (hasHome && otherCount > 0) {
      try {
        await tmux.window.killWindow(`${session}:${homeWin}`);
      } catch {
        // expected: race or already-killed; log was best-effort. Bash
        // also swallows here (lib/start.sh:292: `2>/dev/null || true`)
      }
    }
  }

  // 10. Record start timestamp (lib/start.sh:354). Bash writes
  //     `atmux::now_epoch` (seconds since epoch). TS port writes the
  //     same — `time.now()` is ms, divide by 1000 + floor.
  const startSeconds = Math.floor(now() / 1000);
  await writeText(join(stateDir(dir), "session-start.txt"), `${startSeconds}\n`);

  logger.ok(`team '${team.name}' is up. attach with: atmux attach`);
  return 0;
}

/**
 * Resolve the tmux config from parsed args. Pure helper so the verb's
 * happy path stays readable; exported for test directness (asserting
 * the default-socket path is the canonical `/tmp/atmux-<team>/sock`).
 */
export function resolveTmuxConfig(team: string, parsed: ParsedStartArgs): TmuxConfig {
  if (parsed.socketPath !== undefined) return { socketPath: parsed.socketPath };
  if (parsed.socket !== undefined) return { socket: parsed.socket };
  return { socketPath: defaultSocketPath(team) };
}
