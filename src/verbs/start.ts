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
// - Cage tmux prefix override (lib/start.sh:206-236) — `C-\` global
//   prefix on the cage server so the operator's outer-tmux prefix
//   (typically C-b/C-a) doesn't conflict with the nested cage tmux
//   inside `atmux attach`. Reuses `applyCagePrefix` from cockpit.ts.
//   Origin: 2026-05-09 bisection — `atmux start unum` produced a cage
//   on default `C-b` because only `atmux cockpit rebuild` Phase 3 was
//   applying the prefix; standalone `atmux start <team>` skipped it.
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

import { dirname, join } from "node:path";
import { ensureDir, writeText } from "../abstractions/fs.ts";
import { now } from "../abstractions/time.ts";
import { createTmux, type TmuxConfig, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  buildWindowName,
  defaultEmojiForRole,
  ensureAtmuxDirs,
  getAtmuxDir,
  getDefaultSocket,
  getSessionName,
  loadTeam,
  stateDir,
  teamJsonPath,
} from "../core/common.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { resolveTuiCommand } from "../core/tui-cmd.ts";
import { ConfigError, UsageError } from "../errors.ts";
import { applyCagePrefix } from "./cockpit.ts";

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
 * Re-export of `core/common.ts::getDefaultSocket` under the old name.
 * R-2 (PLAN.md §6.2) lifted the canonical implementation to common.ts;
 * eight verb files imported `defaultSocketPath` from here historically,
 * so the alias keeps that import surface stable. New code imports
 * `getDefaultSocket` from `core/common.ts` directly.
 */
export const defaultSocketPath = getDefaultSocket;

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

  // 4a. tmux's `-S <abspath>/sock new-session` does NOT auto-create the
  //     parent directory — it prints `error creating <path>` to stderr
  //     but exits 0, leaving us with a false-positive newSession + a
  //     socket-less session that every subsequent verb will fail to reach.
  //     Bash bin/atmux's `_atmux_resolve_tmux_tmpdir` did `mkdir -p`
  //     before any tmux call (.archive-bash-atmux-20260507/bin-atmux:227);
  //     port that pre-create here so atmux start actually starts.
  if ("socketPath" in tmuxConfig && typeof tmuxConfig.socketPath === "string") {
    await ensureDir(dirname(tmuxConfig.socketPath));
  }

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

  // 7. Create session if missing.
  //
  //    Default path (lib/start.sh:156, 200-204): seed with the
  //    `__<team>__home` placeholder window and let the member loop
  //    populate, then kill `__home` once any real window exists.
  //
  //    ADR-044 path (lib/start.sh:177-214): when `team.driverSession`
  //    is configured, seed the session with a `driver` window at index 1
  //    running the resolved TUI command instead of the placeholder.
  //    Members append after as windows 2..N+1, matching the bash
  //    `driver → lead → members` declarative topology. The legacy
  //    `__home` cleanup in step 9 is skipped when this path fires
  //    (no placeholder was ever created).
  //
  //    `team.driverSession === null` is treated the same as missing —
  //    matches the existing wizard's "explicitly disabled" output and
  //    keeps `null` round-trip-safe for teams that opted out.
  const homeWin = `__${team.name}__home`;
  const stillExists = sessionExisted && !parsed.force;
  const projectRoot = dirname(dir);
  const driverSession = (team as { driverSession?: { tui?: string | null } | null }).driverSession;
  const driverSessionConfigured = driverSession !== undefined && driverSession !== null;
  let driverInitial = false;
  if (!stillExists) {
    if (driverSessionConfigured) {
      // Resolve the driver TUI: driverSession.tui → driverTui → "claude".
      // Match bash precedence (lib/start.sh:193): the first non-null,
      // non-empty string wins.
      const legacyDriverTui = (team as { driverTui?: string | null }).driverTui;
      const drvTuiRaw =
        (driverSession?.tui !== undefined && driverSession.tui !== null
          ? driverSession.tui
          : undefined) ??
        (legacyDriverTui !== undefined && legacyDriverTui !== null ? legacyDriverTui : undefined) ??
        "claude";
      const drvTui = drvTuiRaw.length > 0 ? drvTuiRaw : "claude";
      const drvCwd = projectRoot;
      // Synthetic member shape for the resolver — driver isn't in
      // team.members[], so build the minimal entry tui-cmd needs.
      // `model: "default"` mirrors lib/start.sh:197's positional arg.
      const synthDriver = {
        name: "driver",
        role: "driver",
        tui: drvTui,
        model: "default",
        cwd: drvCwd,
      } as const;
      let drvCmd: string | undefined;
      try {
        drvCmd = resolveTuiCommand(synthDriver, team, { env, cwd: drvCwd });
      } catch (err) {
        // Match bash fallthrough (lib/start.sh:206): warn and degrade to
        // the __home placeholder rather than blocking session creation.
        logger.warn(
          `driver-initial: could not resolve command for tui='${drvTui}' — falling back to __home placeholder (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      if (drvCmd !== undefined) {
        await tmux.session.newSession({
          name: session,
          windowName: "driver",
          cwd: drvCwd,
        });
        // Shell-only TUIs (`shell|bash|zsh`) skip send-keys for the same
        // reason member spawn does (step 8 below): the pane already starts
        // in `$SHELL`, and `exec $SHELL` re-execs for no observable
        // benefit. Real TUIs (claude/opencode/etc.) get the launch via
        // send-keys so the pane stays a shell when the TUI exits.
        const driverIsShellOnly = drvTui === "shell" || drvTui === "bash" || drvTui === "zsh";
        if (!driverIsShellOnly) {
          // newSession returns void — target the freshly-created driver
          // window by its `<session>:driver` string (Target's string form,
          // serializeTarget pass-through). The window-name is unique
          // because it's the only window in the session at this point.
          await tmux.pane.sendKeys({
            target: {
              kind: "member",
              member: "driver",
              team: team.name,
              target: `${session}:driver`,
            },
            keys: drvCmd,
            enter: true,
          });
        }
        logger.ok(`created tmux session: ${session} (driver at window 1, ${drvTui})`);
        driverInitial = true;
      }
    }
    if (!driverInitial) {
      await tmux.session.newSession({
        name: session,
        windowName: homeWin,
        cwd: opts.cwd ?? process.cwd(),
      });
      logger.ok(`created tmux session: ${session}`);
    }
  }

  // 7a. Apply the C-\ cage prefix on the cage tmux server (lib/start.sh:
  //     206-236). Server-level option — once-per-start is sufficient and
  //     idempotent on the incremental-restart path. Best-effort: failures
  //     swallow inside `applyCagePrefix` (the prefix is cosmetic, not a
  //     precondition for cage operation). Lifted from cockpit.ts so
  //     standalone `atmux start <team>` matches `atmux cockpit rebuild`
  //     Phase 3 — the bisection that motivated this port (2026-05-09)
  //     showed unum cages started outside cockpit landing on default C-b.
  await applyCagePrefix(tmux);

  // 8. Spawn each member as a window (lib/start.sh:272-283 +
  //    _atmux_spawn_member lib/start.sh:400-440 — minus deferred
  //    TUI launch + brief paste).
  const existing = await tmux.window.listWindows(session);
  const existingNames = new Set(existing.map((w) => w.name));
  let spawned = 0;
  // Track whether any auto-emoji fallback fired so we can persist
  // `member.emoji` back into team.json once at the end (single rewrite,
  // not per-member). The `tests/e2e/lifecycle.test.ts:100-103` comment
  // ("Pin the emoji here so spawn + send + capture all agree. Without
  // persistence, start spawns 🐝w1 while send looks for w1") names the
  // exact bug this persistence closes for default-scaffold teams.
  let stampedEmoji = false;
  for (const member of team.members) {
    const role = member.role ?? "member";
    const emoji = member.emoji ?? defaultEmojiForRole(role);
    if (member.emoji === undefined || member.emoji.length === 0) {
      // Mutate in-memory so this start invocation's later branches
      // (TUI launch send-keys target, placeholder cleanup) see the
      // resolved emoji too. Persisted to disk in step 9b below.
      (member as { emoji?: string }).emoji = emoji;
      stampedEmoji = true;
    }
    const win = buildWindowName(member.name, emoji);
    if (existingNames.has(win)) {
      logger.log(`  · ${member.name}: window exists, skipping (use --force to reset)`);
      continue;
    }
    const memberCwd = member.cwd ?? opts.cwd ?? process.cwd();
    const winId = await tmux.window.newWindow({
      sessionName: session,
      name: win,
      cwd: memberCwd,
      detached: true,
    });
    logger.log(`  · ${member.name} (role=${role}): spawned window ${win}`);
    spawned += 1;

    // Launch the configured TUI in the new pane via send-keys. Mirrors
    // bash `_atmux_spawn_member` (lib/start.sh:447-448) which built the
    // command via `atmux::tui_cmd` and `tmux send-keys`-ed it. The TS
    // resolver lives in `core/tui-cmd.ts` (ADR-063 port).
    //
    // Gate: launch ONLY when `member.tui` is explicitly set. Test fixtures
    // omit `tui` and rely on the historical "empty shell pane" behaviour;
    // every real team scaffolded by `atmux init` has `tui` set per
    // member, so production gets the launch and tests get the bare pane.
    // Real-shell members (`tui: shell|bash|zsh`) skip the send entirely
    // — the pane already starts in `$SHELL` and `exec $SHELL` re-execs
    // for no observable benefit.
    const tuiKind = member.tui;
    const isShellOnly = tuiKind === "shell" || tuiKind === "bash" || tuiKind === "zsh";
    if (typeof tuiKind === "string" && tuiKind.length > 0 && !isShellOnly) {
      const cmd = resolveTuiCommand(member, team, { env, cwd: memberCwd });
      // Target the window without a pane index — tmux routes to the
      // active pane, which avoids `pane-base-index 1` configs (the user's
      // ~/.tmux.conf often sets it) erroring with "can't find pane: 0".
      // Bash mirror also uses `<session>:<window>` form (lib/start.sh:447).
      await tmux.pane.sendKeys({
        target: {
          kind: "member",
          member: member.name,
          team: team.name,
          target: { sessionName: session, windowIndex: winId.windowIndex },
        },
        keys: cmd,
        enter: true,
      });
    }
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

  // 9b. Persist the resolved per-member emoji back to team.json so
  //     downstream verbs (send/dispatch/tell-lead/handoff/rotate/stop/
  //     whip) build the SAME `<emoji><name>` window targets we just
  //     spawned. Skipped when nothing fell back to a default — file
  //     stays byte-identical for teams that already pin emoji explicitly.
  if (stampedEmoji) {
    await writeText(teamJsonPath(dir), `${JSON.stringify(team, null, 2)}\n`);
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
