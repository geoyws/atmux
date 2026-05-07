// ADR-010: CLI dispatcher — `reconfigure` verb (interactive prompts).
// Bash spec: lib/reconfigure.sh @ worktree-frozen.
//
// `atmux reconfigure [--team-dir <dir>]`
//
// Re-runs the wizard against an existing team.json — preserves `name`
// and `members[]`, prompts for tuiCommands.{claude,opencode,kimi,cursor}
// and discord.webhook. Bash drops tuiCommands entries that match the
// built-in defaults (`claude`, `opencode`, `kimi`, `cursor-agent`); we
// mirror exactly so the resulting team.json stays minimal.
//
// Coverage strategy. Interactive prompts (`readline.question`) can't be
// driven from `bun:test` without a real TTY. We follow the `attach.ts`
// pattern: extract a pure `planReconfigure(team, prompter)` that takes
// an injectable `Prompter` interface; the public `reconfigure()` wires
// the real readline-backed prompter. Tests use a stub prompter that
// returns canned answers — every branch of the "drop defaults" logic +
// the discord-null-vs-webhook branch is asserted directly.

import { createInterface } from "node:readline/promises";
import { updateJson } from "../abstractions/json.ts";
import { getAtmuxDir, type ResolveDirOpts, requireTeam, teamJsonPath } from "../core/common.ts";
import { UsageError } from "../errors.ts";
import { Team, type Team as TeamShape } from "../schema/team.ts";

const USAGE = "atmux reconfigure [--team-dir <dir>]";

// ---------- Args ----------

/** Parsed `reconfigure` argv. */
export interface ReconfigureArgs {
  teamDir?: string;
}

/** Pure parser. Throws `UsageError` on bad invocation. */
export function parseReconfigureArgs(argv: ReadonlyArray<string>): ReconfigureArgs {
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "reconfigure: --team-dir requires a directory argument",
          hint: USAGE,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `reconfigure: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  const out: ReconfigureArgs = {};
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Prompter abstraction ----------

/** Interactive prompt contract — `ask` shows `message` (with the
 *  bracketed default), reads one line, returns the input or `defaultValue`
 *  if empty. The real readline-backed implementation lives in
 *  `realPrompter`; tests inject a stub returning canned answers. */
export interface Prompter {
  ask(message: string, defaultValue: string): Promise<string>;
}

/** Streams accepted by `createReadlinePrompter` — defaults to
 *  `process.stdin` / `process.stderr` when omitted. The injection point
 *  exists for tests (drive the prompter from a `Readable.from([...])`
 *  pair) and future scripted reconfigure paths. */
export interface PrompterStreams {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** Build a `Prompter` backed by `node:readline/promises`. Prompts are
 *  written to stderr (bash parity with `_atmux_prompt_local` —
 *  reconfigure.sh:24-30 redirects to `>&2` so stdout stays clean for
 *  pipeable callers, even though the verb has no stdout output today). */
export function createReadlinePrompter(streams: PrompterStreams = {}): Prompter {
  return {
    async ask(message: string, defaultValue: string): Promise<string> {
      const rl = createInterface({
        input: streams.input ?? process.stdin,
        output: streams.output ?? process.stderr,
      });
      try {
        const answer = await rl.question(`${message} [${defaultValue}]: `);
        return answer.length > 0 ? answer : defaultValue;
      } finally {
        rl.close();
      }
    },
  };
}

// ---------- Reconfigure plan ----------

/** Built-in TUI launch commands (lib/tui.sh:21-37 + reconfigure.sh:19-22).
 *  Reconfigure drops tuiCommands entries that match these — the bash
 *  jq filter at reconfigure.sh:42-50 mirrors. */
export const TUI_BUILTIN_DEFAULTS = {
  claude: "claude",
  opencode: "opencode",
  kimi: "kimi",
  cursor: "cursor-agent",
} as const;

type TuiKey = keyof typeof TUI_BUILTIN_DEFAULTS;

/** Computed reconfigure outcome. `discord` is `null` when the operator
 *  cleared the webhook (parity with bash reconfigure.sh:50: `if $h ==
 *  "" then .discord = null else .discord = {webhook: $h}`). */
export interface ReconfigurePlan {
  /** Sparse map — only keys whose new value differs from the built-in
   *  default. Empty object when every TUI uses the default. */
  tuiCommands: Record<string, string>;
  /** `null` when the webhook was cleared, otherwise the new shape. */
  discord: { webhook: string } | null;
}

/**
 * Read the current tuiCommands.<tui> from team.json or fall back to the
 * built-in default. Values that aren't strings (Phase 0 schema has
 * `tuiCommands: z.unknown()`) are coerced — same loose shape bash's
 * `jq -r '.tuiCommands.X // "default"'` produces.
 */
function readCurrentTuiCommand(team: TeamShape, key: TuiKey): string {
  const tc = team.tuiCommands;
  if (tc !== undefined && tc !== null && typeof tc === "object") {
    const v = (tc as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return TUI_BUILTIN_DEFAULTS[key];
}

/** Read `discord.webhook` if present, else "". */
function readCurrentWebhook(team: TeamShape): string {
  const d = team.discord;
  if (d !== undefined && d !== null && typeof d === "object") {
    const w = (d as Record<string, unknown>).webhook;
    if (typeof w === "string") return w;
  }
  return "";
}

/**
 * Pure planner — given the existing team + a prompter, drive the same
 * five prompts bash issues, then assemble the sparse `tuiCommands` +
 * `discord` shapes. Tests inject a stub prompter to drive every
 * branch of the "drop defaults" logic.
 */
export async function planReconfigure(
  team: TeamShape,
  prompter: Prompter,
): Promise<ReconfigurePlan> {
  const tuiCommands: Record<string, string> = {};
  for (const key of ["claude", "opencode", "kimi", "cursor"] as const) {
    const current = readCurrentTuiCommand(team, key);
    const next = await prompter.ask(`${key} launch command`, current);
    if (next.length > 0 && next !== TUI_BUILTIN_DEFAULTS[key]) {
      tuiCommands[key] = next;
    }
  }

  const currentWebhook = readCurrentWebhook(team);
  const nextWebhook = await prompter.ask(
    "Discord webhook URL (Enter to keep/skip)",
    currentWebhook,
  );

  const plan: ReconfigurePlan = {
    tuiCommands,
    discord: nextWebhook.length > 0 ? { webhook: nextWebhook } : null,
  };
  return plan;
}

/**
 * Apply a `ReconfigurePlan` to a team object, returning the new shape.
 * Pure — does not touch the filesystem. Mirrors bash reconfigure.sh's
 * jq filter exactly: replaces `tuiCommands` with the sparse map (or
 * removes it when empty), and sets `discord` to `null` or the new
 * webhook shape.
 */
export function applyPlan(team: TeamShape, plan: ReconfigurePlan): Record<string, unknown> {
  // Spread into a plain object so `passthrough` keys (operator comments,
  // experimental fields) are preserved verbatim.
  const next: Record<string, unknown> = { ...(team as Record<string, unknown>) };
  if (Object.keys(plan.tuiCommands).length === 0) {
    // Bash filter: `tuiCommands = ({})`. Result is an empty object,
    // NOT a removed key. Mirror — keeps the JSON shape comparable to
    // a freshly-initted template (which also has tuiCommands: {} on
    // disk per templates/team.example.json structure).
    next.tuiCommands = {};
  } else {
    next.tuiCommands = plan.tuiCommands;
  }
  next.discord = plan.discord;
  return next;
}

// ---------- Public verb entry ----------

/**
 * `atmux reconfigure [--team-dir <dir>]`. Returns 0 on a successful
 * write. Throws `ConfigError` (no team.json) / `UsageError` (bad args)
 * before entering any prompts.
 *
 * Optional `prompter` injection point exists for tests + future
 * non-interactive scripted reconfigure (e.g. `--from-file`, not yet
 * implemented). Defaults to the readline-backed `createReadlinePrompter`.
 */
export async function reconfigure(
  argv: ReadonlyArray<string>,
  deps: { prompter?: Prompter } = {},
): Promise<number> {
  const parsed = parseReconfigureArgs(argv);

  const dirOpts: ResolveDirOpts = {};
  if (parsed.teamDir !== undefined) dirOpts.teamDir = parsed.teamDir;

  // Bash reconfigure.sh:7 — `atmux::require_team`. Failing here yields
  // ConfigError → exit 78 before any prompt fires.
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);
  const tj = teamJsonPath(atmuxDir);

  process.stderr.write("\n");
  process.stderr.write("╭──────────────────────────────────────────────────────╮\n");
  process.stderr.write("│       atmux — reconfigure TUI launch commands         │\n");
  process.stderr.write("╰──────────────────────────────────────────────────────╯\n");
  process.stderr.write(`(edits ${tj} in place. Ctrl-C to abort.)\n`);
  process.stderr.write("\n");

  const prompter = deps.prompter ?? createReadlinePrompter();
  const plan = await planReconfigure(team, prompter);

  // updateJson handles the lock + read + mutate + validate + atomic-write
  // round-trip per ADR-005 "the only mutation path verbs should use".
  // Re-reads the file inside the lock so a concurrent edit between our
  // initial requireTeam() and the actual write doesn't get clobbered.
  await updateJson(tj, Team, (current) => applyPlan(current, plan) as TeamShape);
  process.stderr.write(`reconfigured ${tj}\n`);
  return 0;
}
