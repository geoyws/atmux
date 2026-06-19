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
//   inside `atmux attach`. ADR-263 §D4: applied inline via
//   `tmux.option.setOption` (the cockpit prefix-chain ladder is gone
//   with the cockpit).
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
//   registry (lib/start.sh:418-421) is deferred until lib/registry.sh
//   lands. TUI launch (lib/start.sh:447-448) + brief paste
//   (lib/start.sh:451-481 / _atmux_paste_brief) are PORTED — see
//   ADR-081 §C. Brief paste fires after ATMUX_SPAWN_WAIT (default 6s)
//   per non-shell-only member; failures are best-effort warned and the
//   rest of the team still spawns.
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
import { ensureDir, exists, writeText } from "../abstractions/fs.ts";
import { now } from "../abstractions/time.ts";
import {
  createTmux,
  type SendTarget,
  type TmuxConfig,
  type TmuxNamespace,
} from "../abstractions/tmux.ts";
import {
  defaultGitSpawn,
  type GitSpawn,
  provisionWorktree,
  resolveWorktreePath,
  sanitizeBranchSegment,
} from "../abstractions/worktree.ts";
import {
  type BootClaudeOpts,
  type BootResult,
  bootClaudeMember,
} from "../core/boot-claude.ts";
import {
  buildWindowName,
  buildWindowNameLegacy,
  defaultEmojiForRole,
  ensureAtmuxDirs,
  getAtmuxDir,
  getDefaultSocket,
  getSessionName,
  loadTeam,
  resolveTeamSocket,
  stateDir,
  teamJsonPath,
} from "../core/common.ts";
import { getAtmuxTmuxConfPath } from "../core/tmux-paths.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { CLAUDE_TUI_SCRUB_VARS, resolveTuiCommand } from "../core/tui-cmd.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { Team } from "../schema/team.ts";
// ADR-233 §D1: cron auto-install retired; the `cronInstall` import is gone.
//   Operators who want crons run `atmux cron-install` explicitly.
// ADR-263 §D4: brief paste fully removed — start panes are flat (no roles,
//   no briefs). `pasteBriefForMember` + the rotate.ts brief renderer + the
//   paste-submit helper are gone with the fleet layer.

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
  // ADR-083 §IN §4 (superseded by ADR-233 §D1): the `cronInstallFn`
  // injection field is gone — `start` no longer touches the crontab.
  /** ADR-082 W3: inject the git spawner for the worktree provisioning
   *  step. Default = the real `git` via `defaultGitSpawn` from
   *  `abstractions/worktree.ts`. Tests pass a mock so the start path
   *  doesn't shell out to git against the live repo. */
  gitSpawn?: GitSpawn;
  /** ADR-081 §C completion (t-94d7ad60): override the boot-claude
   *  knobs for claude-TUI members. Tests inject a no-op
   *  sleep + a fake capture-pane via a wrapped tmux to keep the
   *  readiness/post-boot polls deterministic. The `tmux`, `sendTarget`,
   *  `paneTargetString`, `team`, `member` fields are always overwritten
   *  by start.ts — the override is just for the tunable subset
   *  (timeouts, sleep, etc.). */
  bootClaude?: Partial<BootClaudeOpts>;
  /** t-eb0887fe: cap on concurrent member spawns. Panes fan out via
   *  `Promise.all` honouring this cap (default 6, env override via
   *  `ATMUX_SPAWN_CONCURRENCY`). Tests pass `1` to force serial
   *  behaviour or a larger value to exercise N-in-flight. */
  spawnConcurrency?: number;
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

  // 4. Resolve tmux socket. Honours `team.tmuxTmpdir` via resolveTeamSocket
  //    (t-b37c8f4f — write-side parity with the read-side fix in t-add5976a:
  //    a team declaring tmuxTmpdir must get its socket created under that
  //    path so subsequent status/doctor reads find the same socket).
  const tmuxConfig: TmuxConfig = resolveTmuxConfig(team, parsed);
  // ADR-162 §Decision-anchor #2: thread the canonical atmux.conf so
  // every `tmux ...` invocation runs with `-f <path>`. Operator's
  // ~/.tmux.conf is NEVER inherited; override via ATMUX_TMUX_CONF.
  const tmux = factory({ ...tmuxConfig, configFile: getAtmuxTmuxConfPath() });

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
  //    ADR-263 §D1: flat-pane model — the session seeds with the
  //    `__<team>__home` placeholder window and the member loop (step 8)
  //    populates one window per `team.members[]` entry, then `__home` is
  //    killed once any real window exists. There is no driver fan-out,
  //    no role-based topology, no lead-first ordering — panes are a plain
  //    list the operator drives.
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

  // 7-env-scrub. Strip operator-shell artefacts from the cage tmux
  //              session's environment BEFORE any pane spawn. The tmux
  //              server inherits the calling process env at session-
  //              creation time; without this scrub, a parent shell with
  //              ANTHROPIC_API_KEY set flips every claude pane into env-
  //              key bearer mode + triggers the "Do you want to use this
  //              API key?" dialog (operator 2026-05-14 incident).
  //              tuiClaude's `env -u …` prefix (src/core/tui-cmd.ts)
  //              already protects the claude binary's process env; this
  //              setenv -u layer is defense-in-depth for non-claude TUIs
  //              + member.command overrides that bypass tuiClaude.
  //              Best-effort: failures logged + ignored (the tuiClaude
  //              prefix is the primary protection).
  for (const v of CLAUDE_TUI_SCRUB_VARS) {
    try {
      await tmux.session.setEnvironment({ target: session, name: v, unset: true });
    } catch (err) {
      logger.warn(
        `session env scrub: tmux set-environment -u ${v} failed (${err instanceof Error ? err.message : String(err)}) — tuiClaude prefix still protects claude TUIs`,
      );
    }
  }

  // 7a. ADR-263 §D1 (slimmed from ADR-089 §C): apply a fixed cage prefix
  //     on the cage tmux server so the nested cage's prefix never
  //     collides with the operator's outer-tmux prefix (typically
  //     C-b/C-a). The cockpit-derived prefix-chain ladder is gone with
  //     the cockpit; the harness uses the historical hardcoded `C-\`.
  //     Best-effort/cosmetic — a setOption failure never wedges start.
  try {
    await tmux.option.setOption({ name: "prefix", value: "C-\\", global: true });
    logger.log("cage prefix: C-\\");
  } catch {
    // ignored — cage prefix is cosmetic, not a precondition for operation
  }

  // 7b. ADR-082 W3 — per-member git worktree provisioning. Only fires
  //     when team.json sets `worktreeIsolation: true`; legacy teams take
  //     no git invocations and no behavioral change. Per-member spawn
  //     loop below threads `worktreeCwd` so a successfully-provisioned
  //     member's pane lands in the worktree path; failures are warned +
  //     fall back to the shared-tree cwd for THAT member (the rest of
  //     the team still spawns).
  const worktreeCwd: Map<string, string> = new Map();
  if (team.worktreeIsolation === true) {
    const gitSpawn = opts.gitSpawn ?? defaultGitSpawn;
    // The project root is the directory containing `.atmux/`. Match
    // the strip logic in `resolveWorktreePath` (regex over a trailing
    // `/.atmux/?`) rather than bare `dirname()`, which would lop off
    // the atmux-dir name on test fixtures whose atmuxDir doesn't end
    // in `/.atmux`. Both `git rev-parse --show-toplevel` and
    // `git branch --show-current` run there ONCE — the result holds
    // for every member.
    const projectRoot = dir.replace(/\/?\.atmux\/?$/, "") || "/";
    const rootR = await gitSpawn(["-C", projectRoot, "rev-parse", "--show-toplevel"]);
    const branchR = await gitSpawn(["-C", projectRoot, "branch", "--show-current"]);
    const branch = branchR.stdout.trim();
    if (rootR.exitCode !== 0) {
      logger.warn(
        `worktree: cannot detect repo root at ${projectRoot} — falling back to shared cwd for all members`,
      );
    } else if (branchR.exitCode !== 0 || branch.length === 0) {
      // Empty branch == detached HEAD. We refuse to provision worktrees
      // off a detached state — `git worktree add <path> ""` would error
      // and there's no sensible default branch name to substitute.
      logger.warn(
        "worktree: detached HEAD (no current branch) — falling back to shared cwd for all members",
      );
    } else {
      const repoPath = rootR.stdout.trim();
      logger.log(`worktree: provisioning under ${repoPath} off base branch ${branch}`);
      for (const member of team.members) {
        const wtPath = resolveWorktreePath(team, member.name, dir);
        // ADR-084: per-member branch `${branch}-${sanitize(memberName)}`.
        // Git refuses concurrent worktrees on the same branch, so each
        // member gets its own fork off the team's current branch.
        const wtBranch = `${branch}-${sanitizeBranchSegment(member.name)}`;
        try {
          // ADR-088 §"Implementation surface": pass `initSubmodules` through
          // when team opts in. Opt-out (default) means `git submodule update`
          // is never invoked — teams without submodules pay zero cost.
          const provOpts: Parameters<typeof provisionWorktree>[4] = {
            git: gitSpawn,
          };
          if (team.worktreeInitSubmodules === true) provOpts.initSubmodules = true;
          const r = await provisionWorktree(repoPath, branch, wtBranch, wtPath, provOpts);
          worktreeCwd.set(member.name, wtPath);
          logger.log(
            `  · worktree ${r.created ? "created" : "reused"}: ${member.name} → ${wtPath} [${wtBranch}]`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(
            `worktree: ${member.name} provision failed — falling back to shared cwd (${msg})`,
          );
          // Intentional: do NOT set worktreeCwd[member]. The spawn loop's
          // `worktreeCwd.get(member.name) ?? member.cwd ?? opts.cwd ?? cwd()`
          // chain falls through to the existing shared-tree resolution.
        }
      }
    }
  }

  // 8. Spawn each member as a window (lib/start.sh:272-283 +
  //    _atmux_spawn_member lib/start.sh:400-440 — minus deferred
  //    TUI launch + brief paste).
  //
  // t-eb0887fe (2026-05-16): the lead is spawned sequentially FIRST so
  // the handshake (window create + claude launch + bootClaudeMember
  // readiness poll + brief paste) completes before any teammate starts
  // — the lead's brief sets the team contract that teammates' briefs
  // reference. Teammates then fan out via {@link runWithConcurrency}
  // with a {@link resolveSpawnConcurrency} cap (default 6 in flight).
  // 20-member teams previously cost ~5min wall-clock spawning serially
  // through `bootClaudeMember`'s readiness probe (~15s per claude TUI);
  // with the fan-out the wall-clock collapses to lead-handshake plus
  // teammate-handshake-max, target <60s.
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

  // Per-member spawn closure. Iterates EVERY closure-state field via
  // direct read; mutations are scoped to fields each member touches
  // uniquely (`win` names are unique-per-member so the `existingNames`
  // Set's reads/writes never contend, and `stampedEmoji` is
  // write-only-to-true). The function body is byte-equivalent to the
  // prior inline loop body for reviewer-diff readability — only the
  // `for (const member of team.members) {` wrapper was replaced.
  const spawnOneMember = async (member: (typeof team.members)[number]): Promise<void> => {
    const role = member.role ?? "member";
    const emoji = member.emoji ?? defaultEmojiForRole(role);
    if (member.emoji === undefined || member.emoji.length === 0) {
      // Mutate in-memory so this start invocation's later branches
      // (TUI launch send-keys target, placeholder cleanup) see the
      // resolved emoji too. Persisted to disk in step 9b below.
      (member as { emoji?: string }).emoji = emoji;
      stampedEmoji = true;
    }
    // ADR-161 TR2: pass member.role so default-role members render
    // `_-prefix`; user-added (role = "member") keep hyphen.
    const win = buildWindowName(member.name, emoji, member.label, member.role);
    if (existingNames.has(win)) {
      logger.log(`  · ${member.name}: window exists, skipping (use --force to reset)`);
      return;
    }
    // ADR-135 §D4 — legacy member-window migration. Pre-ADR-135
    // teams have windows named `<emoji><member>` (no separator);
    // ADR-135 §D3 flipped buildWindowName to `<emoji>-<member>`. If
    // a window with the legacy form exists for this member and the
    // canonical form does not, rename it in-place via
    // `tmux rename-window` (preserves pane PID + scroll history).
    // Idempotent: re-running start after the rename is a no-op
    // because `existingNames.has(win)` short-circuits above.
    // ADR-161 TR2: pre-`_-prefix` teams have default-role windows
    // named `<emoji>-<label>` (hyphen). Detect via buildWindowName
    // with `role: undefined` (hyphen path) and rename to the new
    // `_-prefix` shape.
    const winHyphen = buildWindowName(member.name, emoji, member.label);
    const winLegacy = buildWindowNameLegacy(member.name, emoji);
    if (winHyphen !== win && existingNames.has(winHyphen)) {
      try {
        await tmux.window.renameWindow(`${session}:${winHyphen}`, win);
        logger.log(
          `  · ${member.name}: renamed legacy window '${winHyphen}' → '${win}' (ADR-161 _-prefix migration)`,
        );
        existingNames.add(win);
        existingNames.delete(winHyphen);
        return;
      } catch (e) {
        const cause = e instanceof Error ? e.message : String(e);
        logger.warn(
          `  · ${member.name}: rename '${winHyphen}' → '${win}' failed (${cause}); continuing — manual fix via 'tmux rename-window'`,
        );
      }
    }
    if (winLegacy !== win && existingNames.has(winLegacy)) {
      try {
        await tmux.window.renameWindow(`${session}:${winLegacy}`, win);
        logger.log(
          `  · ${member.name}: renamed legacy window '${winLegacy}' → '${win}' (ADR-135 migration)`,
        );
        existingNames.add(win);
        existingNames.delete(winLegacy);
        return;
      } catch (e) {
        const cause = e instanceof Error ? e.message : String(e);
        logger.warn(
          `  ⚠ ${member.name}: failed to rename legacy window '${winLegacy}' → '${win}': ${cause} — falling through to spawn`,
        );
      }
    }
    // ADR-082 W3: worktree-isolation cwd wins when provisioning
    // succeeded for this member. Empty `worktreeCwd` (legacy team or
    // provision-fail) falls through to the existing chain.
    const memberCwd = worktreeCwd.get(member.name) ?? member.cwd ?? opts.cwd ?? process.cwd();
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
      const memberTarget: SendTarget = {
        kind: "member",
        member: member.name,
        team: team.name,
        target: { sessionName: session, windowIndex: winId.windowIndex },
      };
      await tmux.pane.sendKeys({
        target: memberTarget,
        keys: cmd,
        enter: true,
      });
      // ADR-263 §D1: claude TUIs go through the readiness-poll +
      // single-line boot-prompt path (boot-claude) so a slow cold-start
      // settles before the operator drives the pane. There is no brief
      // paste and no /goal injection — panes are flat. Non-claude TUIs
      // just launch via the send-keys above with no follow-up.
      if (tuiKind === "claude") {
        const bootOpts: BootClaudeOpts = {
          tmux,
          sendTarget: memberTarget,
          paneTargetString: `${session}:${win}`,
          team: team.name,
          member: member.name,
        };
        if (opts.bootClaude !== undefined) {
          Object.assign(bootOpts, opts.bootClaude);
        }
        let bootResult: BootResult;
        try {
          bootResult = await bootClaudeMember(bootOpts);
        } catch (e) {
          const cause = e instanceof Error ? e.message : String(e);
          logger.warn(`  · ${member.name}: bootClaudeMember threw (${cause})`);
          bootResult = { status: "failed", attempts: 0, reason: "capture-error" };
        }
        if (bootResult.status === "booted") {
          logger.log(`  · ${member.name}: bootstrapped (${bootResult.attempts} attempt(s))`);
        } else if (bootResult.status === "already-booted") {
          logger.log(`  · ${member.name}: already booted — boot prompt skipped`);
        } else {
          logger.warn(
            `  · ${member.name}: bootstrap FAILED after ${bootResult.attempts} attempt(s) (${bootResult.reason ?? "?"})`,
          );
        }
      }
    }
  };

  // ADR-263 §D1: flat-pane spawn — no lead-first ordering, no role-based
  // sequencing. Every member is just a pane; they fan out up to the
  // configured concurrency cap.
  const spawnCap = resolveSpawnConcurrency(opts.spawnConcurrency, env);
  await runWithConcurrency(team.members, spawnCap, spawnOneMember);

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

  // 10a. ADR-263 §D4: cron auto-install, resume-manifest surfacing,
  //      epic-viewer bridge, and cockpit reconcile are all gone with the
  //      fleet-coordination layer. `atmux start` writes ZERO crontab
  //      lines, does not auto-restore claims, and never touches a cockpit
  //      session. The harness's job ends once the panes are up.

  logger.ok(`team '${team.name}' is up. attach with: atmux attach`);

  return 0;
}

// ADR-263 §D4: `autoReconcileCockpitForTeam` removed with the cockpit.
//   `atmux start` brings up the team's panes and stops — it never
//   reconciles a cockpit viewer session.

// ADR-083 §IN §4 (superseded by ADR-233 §D1): the `shouldAutoInstallCron`
// helper is gone. `atmux start` no longer auto-installs crons; the
// `kanban.cronAutoInstall` schema field stays for back-compat surface
// but is never read.

/**
 * Resolve the tmux config from parsed args. Pure helper so the verb's
 * happy path stays readable; exported for test directness.
 *
 * Precedence: `--socket-path` > `--socket` > `team.tmuxTmpdir`-derived
 * socket (via {@link resolveTeamSocket}) > canonical fallback
 * `/tmp/atmux-<team>/sock`. The `team.tmuxTmpdir` honour is the
 * write-side companion to t-add5976a's read-side resolveTeamSocket
 * fix — without it, a team.json declaring a project-local cage path
 * gets a socket at the canonical fallback anyway, and subsequent
 * status/doctor (which DO honour tmuxTmpdir) report [down] for a live
 * session (t-b37c8f4f).
 */
export function resolveTmuxConfig(
  team: Pick<Team, "name" | "tmuxTmpdir">,
  parsed: ParsedStartArgs,
): TmuxConfig {
  if (parsed.socketPath !== undefined) return { socketPath: parsed.socketPath };
  if (parsed.socket !== undefined) return { socket: parsed.socket };
  return { socketPath: resolveTeamSocket(team) };
}

/** t-eb0887fe: resolve the cap on concurrent non-lead member spawns.
 *  Precedence: explicit `opts.spawnConcurrency` > `ATMUX_SPAWN_CONCURRENCY`
 *  env > 6 (default).
 *
 *  6 is the operating point in the brief's "5-8 in-flight, tune
 *  empirically" sketch — high enough that 20-member teams complete
 *  inside one bootClaude readiness-window (~15s) instead of cascading
 *  20 × 15s = 5min, low enough that tmux's per-session window-create
 *  serialisation doesn't bottleneck (we observe one new-window per
 *  cap-slot, not 20 in-flight). Cap of 0 or negative falls through to
 *  the default — never silently disables parallelism. Cap of 1
 *  legitimately restores the sequential pre-t-eb0887fe behaviour and
 *  is used by tests that assert ordering. */
export function resolveSpawnConcurrency(
  override: number | undefined,
  env: NodeJS.ProcessEnv,
): number {
  if (override !== undefined && Number.isFinite(override) && override >= 1) {
    return Math.floor(override);
  }
  const raw = env.ATMUX_SPAWN_CONCURRENCY;
  if (raw !== undefined && raw.length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed);
  }
  return 6;
}

/** t-eb0887fe: bounded-concurrency Promise.all. Runs `fn(item)` for
 *  each `items[i]` with at most `cap` in flight at any moment. Errors
 *  propagate (a member spawn failure aborts the team — matching the
 *  pre-t-eb0887fe behaviour where any `await` in the for-loop would
 *  throw out of `start`). Cap is clamped to `[1, items.length]` so a
 *  cap higher than the roster degenerates to plain `Promise.all`. */
export async function runWithConcurrency<T>(
  items: ReadonlyArray<T>,
  cap: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const effectiveCap = Math.max(1, Math.min(cap, items.length));
  if (effectiveCap === 0) return;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: effectiveCap }, () => worker()));
}

/** ADR-081 §C: resolve the spawn-wait window between TUI launch and
 *  brief paste, in milliseconds. Precedence: explicit `opts.spawnWaitMs`
 *  > `ATMUX_SPAWN_WAIT` env (seconds, bash parity) > 6000ms default.
 *  Non-numeric / negative env values fall through to the default. */
export function resolveSpawnWaitMs(override: number | undefined, env: NodeJS.ProcessEnv): number {
  if (override !== undefined && Number.isFinite(override) && override >= 0) {
    return override;
  }
  const raw = env.ATMUX_SPAWN_WAIT;
  if (raw !== undefined && raw.length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed * 1000);
  }
  return 6000;
}

// ADR-263 §D4: `pasteBriefForMember` / `PasteBriefArgs` removed — start
//   panes are flat (no role briefs). `surfaceResumeManifest` / `formatAge`
//   (soft-stop resume
//   hint) and `resolveCagePrefixBestEffort` (cockpit prefix-chain) are
//   removed with the fleet layer. The cage prefix is a fixed `C-\`
//   applied inline in `start`; there is no resume manifest to surface.
