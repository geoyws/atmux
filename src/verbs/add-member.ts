// ADR-010: CLI dispatcher — `add-member` verb (Phase 2 lifecycle MVP).
// ADR-003: src/verbs/add-member.ts — domain verb; imports allowed:
//   src/core/*, src/abstractions/*, src/schema/*, src/errors.
// ADR-004 amend (2026-05-05): every tmux call goes through a
//   `createTmux({ socket } | { socketPath })` namespace — there is no
//   default factory and the socket flag is the load-bearing isolation
//   guarantee (memory ref `feedback_tmux_test_isolation.md`).
//
// Bash port target: lib/add-member.sh @ 2aadc3f. Source-cited per memory
// `feedback_lead_task_desc_source_grep.md`:
//
// - lib/add-member.sh:14-28 — flag parsing (--role / --tui / --model /
//   --cwd / --command) + single positional <name>; default cwd = $PWD;
//   error on unknown flag, too-many-positionals, missing name.
// - lib/add-member.sh:31-35 — duplicate-name refusal via a jq existence
//   probe; fail-loud message "'<name>' is already in team.json".
// - lib/add-member.sh:37-40 — emoji selection. Mode resolved from
//   `ATMUX_EMOJI_MODE` env > `team.emojis.mode` field > `"random"`
//   default (mirror lib/emoji.sh::atmux::emoji_mode lines 44-58). The
//   already-stamped `.emoji` of every existing member is fed in as the
//   "seen" set so the new pick prefers fresh emoji (line 39 + line 65-83).
// - lib/add-member.sh:42-47 — atomic team.json mutation appending a new
//   member entry. Conditionally adds `.command` when the operator passed
//   `--command` (bash conditional jq `+` with `if … then … else …`).
// - lib/add-member.sh:49-51 — prime an empty inbox file at
//   `<atmuxDir>/inboxes/<name>.json` if absent. Body is the bash-shared
//   shape `{"pending":[],"inProgress":[],"done":[]}` (Phase 2 inbox
//   schema, task #24, will type this — for now we write the literal).
// - lib/add-member.sh:53 — log "added member '<emoji> <name>' (role=…,
//   tui=…) to team.json" via atmux::ok.
// - lib/add-member.sh:55-60 + 63-80 — if a tmux session is up at the
//   resolved socket: spawn a new window for the member named via
//   `common.buildWindowName(member, emoji)` (post-2026-05-05 amend, ADR-017
//   — the team prefix was dropped to maximize tmux window-list space).
//   Else: log "run
//   'atmux start' …" pointer.
//
// **Spawn-path scoping (parity with start verb).** Per `src/verbs/start.ts`
// header §"DEFERRED", the TUI launch via `atmux::tui_cmd` (lib/tui.sh) +
// initial-brief paste haven't been ported to TS yet. add-member follows
// the same convention: when the session is up we create the empty pane
// (visible to the operator on next attach) and skip the TUI launch.
// Phase 2 follow-up wires `lib/tui.sh::atmux::tui_cmd` into both verbs in
// one commit so they activate together.

import { updateJson } from "../abstractions/json.ts";
import { createTmux, type TmuxConfig, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  buildWindowName,
  defaultEmojiForRole,
  emojiPoolForRole,
  getAtmuxDir,
  getSessionName,
  loadTeam,
  resolveTeamSocket,
  teamJsonPath,
} from "../core/common.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { ConfigError, UsageError } from "../errors.ts";
import { Team, type TeamMember, type Team as TeamShape } from "../schema/team.ts";

// ---------- Arg parsing ----------

/** Parsed `add-member` argv. Field defaults track lib/add-member.sh:14
 *  (`role=member tui=claude model=default`); cwd defaults to the
 *  caller's `$PWD` (filled at parse time so the parsed value is
 *  observable in the test surface). */
export interface ParsedAddMemberArgs {
  name: string;
  role: string;
  tui: string;
  model: string;
  cwd: string;
  /** Empty string = `--command` not supplied (lib/add-member.sh:14
   *  initialiser). Treated as "no override" downstream. */
  command: string;
  /** -L socket short-name; mutually exclusive with `socketPath`. */
  socket?: string;
  /** -S socket absolute path; mutually exclusive with `socket`. */
  socketPath?: string;
}

const ADD_MEMBER_USAGE =
  "usage: atmux add-member <name> [--role …] [--tui …] [--model …] [--cwd …] [--command …]";

/**
 * Parse `add-member` argv. Mirrors the case-loop at lib/add-member.sh:15-27
 * plus the Phase 2 `--socket`/`--socket-path` flag pair (kept symmetric
 * with `start.ts::parseStartArgs` so a session-up detection at the same
 * socket the operator started on Just Works).
 *
 * `defaultCwd` injection lets tests pass a deterministic cwd without
 * mutating `process.cwd()`; the dispatcher in `src/cli.ts` passes
 * `process.cwd()` for parity with bash `$PWD`.
 */
export function parseAddMemberArgs(
  args: ReadonlyArray<string>,
  defaultCwd: string,
): ParsedAddMemberArgs {
  let name = "";
  let role = "member";
  let tui = "claude";
  let model = "default";
  let cwd = "";
  let command = "";
  let socket: string | undefined;
  let socketPath: string | undefined;

  const requireValue = (flag: string, val: string | undefined): string => {
    if (val === undefined || val.length === 0) {
      throw new UsageError({
        what: `add-member: ${flag} requires a value`,
        hint: ADD_MEMBER_USAGE,
      });
    }
    return val;
  };

  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? "";
    switch (a) {
      case "--role":
        role = requireValue("--role", args[i + 1]);
        i += 2;
        break;
      case "--tui":
        tui = requireValue("--tui", args[i + 1]);
        i += 2;
        break;
      case "--model":
        model = requireValue("--model", args[i + 1]);
        i += 2;
        break;
      case "--cwd":
        cwd = requireValue("--cwd", args[i + 1]);
        i += 2;
        break;
      case "--command":
        command = requireValue("--command", args[i + 1]);
        i += 2;
        break;
      case "--socket":
        socket = requireValue("--socket", args[i + 1]);
        i += 2;
        break;
      case "--socket-path":
        socketPath = requireValue("--socket-path", args[i + 1]);
        i += 2;
        break;
      default:
        if (a.startsWith("-")) {
          // lib/add-member.sh:22 — bash `atmux::die "add-member: unknown flag: $1"`
          throw new UsageError({
            what: `add-member: unknown flag: ${a}`,
            hint: ADD_MEMBER_USAGE,
          });
        }
        // Positional — the single <name>. lib/add-member.sh:23-25.
        if (name.length === 0) {
          name = a;
        } else {
          throw new UsageError({
            what: "add-member: too many positional args",
            hint: ADD_MEMBER_USAGE,
          });
        }
        i += 1;
    }
  }

  // lib/add-member.sh:28 — `[[ -n "$name" ]] || atmux::die "usage: …"`
  if (name.length === 0) {
    throw new UsageError({ what: ADD_MEMBER_USAGE });
  }

  // lib/add-member.sh:29 — `[[ -z "$cwd" ]] && cwd="$PWD"`
  if (cwd.length === 0) cwd = defaultCwd;

  if (socket !== undefined && socketPath !== undefined) {
    throw new UsageError({
      what: "add-member: --socket and --socket-path are mutually exclusive",
      hint: "pick one — short-name (-L) or absolute path (-S)",
    });
  }

  return {
    name,
    role,
    tui,
    model,
    cwd,
    command,
    ...(socket !== undefined ? { socket } : {}),
    ...(socketPath !== undefined ? { socketPath } : {}),
  };
}

// ---------- Emoji selection ----------

/** Mirrors lib/emoji.sh::atmux::emoji_mode resolution order. */
export type EmojiMode = "static" | "random" | "ai";

const VALID_EMOJI_MODES: ReadonlySet<EmojiMode> = new Set(["static", "random", "ai"]);

/**
 * Resolve emoji-assignment mode. Priority (lib/emoji.sh:44-58):
 *   1. ATMUX_EMOJI_MODE env (when non-empty + a recognised mode)
 *   2. team.emojis.mode field (when a recognised mode)
 *   3. "random" default
 *
 * Unrecognised values fall through to the next source (matches bash's
 * `case` block default arm — bash treats anything other than
 * static/ai/random as random via the wildcard, lib/emoji.sh:113).
 */
export function resolveEmojiMode(env: NodeJS.ProcessEnv, teamMode?: string): EmojiMode {
  const e = env.ATMUX_EMOJI_MODE;
  if (e !== undefined && e.length > 0 && VALID_EMOJI_MODES.has(e as EmojiMode)) {
    return e as EmojiMode;
  }
  if (teamMode !== undefined && VALID_EMOJI_MODES.has(teamMode as EmojiMode)) {
    return teamMode as EmojiMode;
  }
  return "random";
}

/**
 * Pick a single emoji for `role`, preferring entries not in `seen`
 * (mirrors lib/emoji.sh::atmux::emoji_pick_random:65-83). When every
 * pool entry is already `seen` the full pool becomes the candidate set
 * (lib/emoji.sh:77-79 fallback).
 *
 * Mode handling:
 *   - `static` → first of pool (lib/emoji.sh::atmux::emoji_default_for_role)
 *   - `random` / `ai` → random pick. `ai` mode falls back to random
 *     because the bash AI shellout (lib/emoji.sh:87-103) requires
 *     calling `claude` — the TS port reuses the same fallback path
 *     bash takes when claude is missing (line 89-92), so the operator
 *     who runs ATMUX_EMOJI_MODE=ai without claude installed sees
 *     identical behaviour. Wiring the AI shellout itself is a Phase 2
 *     follow-up (no incident urgency — random is the production default).
 *
 * `rng` is injected to keep tests deterministic; default is `Math.random`.
 */
export function pickEmoji(
  role: string,
  mode: EmojiMode,
  seen: ReadonlySet<string>,
  rng: () => number = Math.random,
): string {
  if (mode === "static") return defaultEmojiForRole(role);
  const pool = emojiPoolForRole(role);
  // Filter against the seen set; fall back to full pool when every
  // entry is already used (matches bash line 77-79).
  const candidates = pool.filter((e) => !seen.has(e));
  const finalPool = candidates.length > 0 ? candidates : pool;
  // `pool` is statically populated + non-empty (see common.ts MEMBER_POOL),
  // so `finalPool[0]` is always a string. The `?? "🐝"` keeps the type
  // narrowed without a non-null assertion.
  const idx = Math.floor(rng() * finalPool.length);
  return finalPool[idx] ?? finalPool[0] ?? "🐝";
}

/** Read `team.emojis.mode` defensively — the schema field is
 *  `z.unknown()`-shaped in passthrough territory (Phase 2 close will
 *  tighten it). Returns undefined when the field isn't a string. */
function teamEmojiMode(team: { emojis?: unknown }): string | undefined {
  const e = team.emojis;
  if (e === undefined || e === null || typeof e !== "object") return undefined;
  const mode = (e as { mode?: unknown }).mode;
  return typeof mode === "string" ? mode : undefined;
}

// ---------- Verb entry ----------

export interface AddMemberOpts {
  /** Override `process.env`. Tests pass a curated subset. */
  env?: NodeJS.ProcessEnv;
  /** Override cwd — used both as the `getAtmuxDir` walk-up root AND as
   *  the default for `--cwd` parsing (matches bash `$PWD` semantics). */
  cwd?: string;
  /** Inject the tmux factory for tests (default: `createTmux`). Same
   *  pattern as `start.ts` — tests close over a per-test socket. */
  tmuxFactory?: (cfg: TmuxConfig) => TmuxNamespace;
  /** Logger sink override (default: stderr-bound `createLogger()`). */
  logger?: Logger;
  /** RNG injection for the random-mode emoji pick. Default: `Math.random`.
   *  Tests supply a fixed-output stub for deterministic assertions. */
  rng?: () => number;
}

/**
 * `atmux add-member <name> [--role …] [--tui …] [--model …] [--cwd …]
 * [--command …] [--socket … | --socket-path …]` — append a member to
 * `team.json` and (when a session is up) spawn their window.
 *
 * Returns the process exit code (0 on success). Errors propagate as
 * tagged `AtmuxError`s; the dispatcher in `src/cli.ts` maps to BSD
 * sysexits per ADR-006.
 */
export async function addMember(
  args: ReadonlyArray<string>,
  opts: AddMemberOpts = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const logger = opts.logger ?? createLogger();
  const factory = opts.tmuxFactory ?? createTmux;
  const rng = opts.rng ?? Math.random;

  const parsed = parseAddMemberArgs(args, cwd);

  // 1. Resolve atmux dir + load team. `loadTeam` throws ConfigError
  //    when team.json is absent (parity with bash atmux::require_team
  //    "no team.json — run 'atmux init' first").
  const dir = await getAtmuxDir({ env, cwd });
  const team = await loadTeam({ env, cwd });

  // 2. Duplicate-name refusal (lib/add-member.sh:31-35).
  if (team.members.some((m) => m.name === parsed.name)) {
    throw new ConfigError({
      what: `add-member: '${parsed.name}' is already in team.json`,
    });
  }

  // 3. Emoji pick. The "seen" set excludes empty/missing emoji entries
  //    so a freshly-init team (no stamped emojis) doesn't tank the
  //    candidate pool — matches lib/add-member.sh:39's
  //    `map(select(. != ""))` filter.
  const seen = new Set<string>();
  for (const m of team.members) {
    if (typeof m.emoji === "string" && m.emoji.length > 0) seen.add(m.emoji);
  }
  const mode = resolveEmojiMode(env, teamEmojiMode(team));
  const emoji = pickEmoji(parsed.role, mode, seen, rng);

  // 4. Append to team.json under a flock + atomic rename
  //    (json.updateJson — lib/add-member.sh:42-47 parity).
  const tjPath = teamJsonPath(dir);
  await updateJson(tjPath, Team, (current) => {
    const newMember: TeamMember = {
      name: parsed.name,
      role: parsed.role,
      tui: parsed.tui,
      model: parsed.model,
      cwd: parsed.cwd,
      emoji,
      ...(parsed.command.length > 0 ? { command: parsed.command } : {}),
    };
    return { ...current, members: [...current.members, newMember] };
  });

  // 5. Log success (lib/add-member.sh:53).
  logger.ok(
    `added member '${emoji} ${parsed.name}' (role=${parsed.role}, tui=${parsed.tui}) to team.json`,
  );

  // 7. Optional spawn (lib/add-member.sh:55-60). Probe via the same
  //    socket convention the start verb uses (`start.ts::defaultSocketPath`
  //    + `--socket`/`--socket-path` overrides). When the session is up,
  //    create the new window — TUI launch deferred to the Phase 2 tui_cmd
  //    port (file header §"Spawn-path scoping" + start.ts header §DEFERRED).
  await maybeSpawn(parsed, emoji, factory, env, cwd, logger, team);

  return 0;
}

/**
 * Resolve the tmux config from parsed args. Symmetric with
 * `start.ts::resolveTmuxConfig` — same precedence ladder:
 * `--socket-path` > `--socket` > `team.tmuxTmpdir`-derived
 * `<tmpdir>/tmux-<uid>/default` > canonical `/tmp/atmux-<team>/sock`.
 *
 * Exported for direct unit-testing of the precedence ladder. The
 * `team.tmuxTmpdir` honour is the write-side companion to
 * t-add5976a's read-side resolveTeamSocket fix; without it,
 * add-member's spawn probe targets the wrong socket on a tmuxTmpdir
 * team and false-negatives the live-session check (t-d0229be5).
 */
export function resolveAddMemberTmuxConfig(
  team: Pick<TeamShape, "name" | "tmuxTmpdir">,
  parsed: ParsedAddMemberArgs,
): TmuxConfig {
  if (parsed.socketPath !== undefined) return { socketPath: parsed.socketPath };
  if (parsed.socket !== undefined) return { socket: parsed.socket };
  return { socketPath: resolveTeamSocket(team) };
}

/**
 * Build the tmux namespace, probe for the session, spawn the window or
 * log the start-pointer. Extracted so the verb body stays linear and
 * the spawn branch is independently testable via the factory injection.
 *
 * The session-name resolution swallows ConfigError (which `getSessionName`
 * throws when single-session is set without an anchor) — for add-member
 * the user-facing fallback is the bash "run 'atmux start' …" pointer,
 * not a hard error. Single-session refusal is the start verb's job.
 */
async function maybeSpawn(
  parsed: ParsedAddMemberArgs,
  emoji: string,
  factory: (cfg: TmuxConfig) => TmuxNamespace,
  env: NodeJS.ProcessEnv,
  cwd: string,
  logger: Logger,
  // The team object — passed through so `getSessionName` skips the
  // already-done team.json reread (perf nit + matches the bash flow
  // where session_name is computed once at top of main) AND so
  // resolveAddMemberTmuxConfig can honour team.tmuxTmpdir.
  team: TeamShape,
): Promise<void> {
  const cfg = resolveAddMemberTmuxConfig(team, parsed);
  const tmux = factory(cfg);
  let session: string | null;
  try {
    session = await getSessionName({ env, cwd, team });
  } catch {
    // expected: getSessionName throws ConfigError on single-session
    // without an anchor — for add-member that's "no live session", same
    // user-facing branch as a missing tmux server.
    session = null;
  }

  let live = false;
  if (session !== null) {
    try {
      live = await tmux.session.hasSession(session);
    } catch {
      // expected: tmux server unreachable / socket missing → treat as
      // no-session. Bash also tolerates `tmux has-session` failures
      // (lib/common.sh:163 `2>/dev/null`).
      live = false;
    }
  }

  if (session === null || !live) {
    // lib/add-member.sh:59
    logger.log("  run 'atmux start' (or 'atmux start --force') to bring the team up");
    return;
  }

  // lib/add-member.sh:56-57 — log + spawn.
  logger.log("  session is up — spawning the member now");
  const win = buildWindowName(parsed.name, emoji);
  // Window name parity with `start.ts`. TUI launch deferred (file
  // header §"Spawn-path scoping").
  await tmux.window.newWindow({
    sessionName: session,
    name: win,
    cwd: parsed.cwd,
    detached: true,
  });
  logger.ok(`spawned ${parsed.name} in ${session}:${win}`);
}
