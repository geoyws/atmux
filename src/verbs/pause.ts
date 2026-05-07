// ADR-010: CLI dispatcher — `pause` and `resume` verbs (shared module).
// Bash spec: lib/pause.sh @ worktree-frozen.
//
// `atmux pause <member>`  — mark member paused (dispatch/claim refuse).
// `atmux resume <member>` — clear the paused flag.
//
// Both are thin wrappers over `core/pause.ts`'s `pauseMember` /
// `resumeMember` primitives. Pure CLI plumbing — flag parsing +
// member-existence check + delegate.
//
// Refusal cases (bash `atmux::die` parity):
//
// - Missing <member>                  → UsageError ("usage: atmux …").
// - Member not in team.json members[] → ConfigError (matches bash
//   `atmux::member_json` die path).

import { getAtmuxDir, type ResolveDirOpts, requireTeam } from "../core/common.ts";
import { pauseMember, resumeMember } from "../core/pause.ts";
import { ConfigError, UsageError } from "../errors.ts";

const USAGE_PAUSE = "atmux pause <member>";
const USAGE_RESUME = "atmux resume <member>";

/** Parsed `pause` / `resume` argv. */
export interface PauseResumeArgs {
  member: string;
  /** Optional reason override; bash uses `$ATMUX_PAUSE_REASON` env, default
   *  `"manual"`. The TS port adds an explicit `--reason` flag for clarity. */
  reason?: string;
  teamDir?: string;
}

/**
 * Pure parser. Throws `UsageError` on bad invocation.
 * `verb` is the verb name used for error messages.
 */
export function parsePauseResumeArgs(
  argv: ReadonlyArray<string>,
  verb: "pause" | "resume",
): PauseResumeArgs {
  const usage = verb === "pause" ? USAGE_PAUSE : USAGE_RESUME;
  let member = "";
  let reason: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--reason") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: `${verb}: --reason requires a value`, hint: usage });
      }
      reason = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: `${verb}: --team-dir requires a value`, hint: usage });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a !== undefined && a.startsWith("-")) {
      throw new UsageError({ what: `${verb}: unknown flag: ${a}`, hint: usage });
    }
    if (member.length > 0) {
      throw new UsageError({ what: `${verb}: too many args`, hint: usage });
    }
    member = a ?? "";
    i += 1;
  }
  if (member.length === 0) {
    throw new UsageError({ what: `usage: ${usage}` });
  }
  const out: PauseResumeArgs = { member };
  if (reason !== undefined) out.reason = reason;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

/** `atmux pause <member>`. Returns 0 on success. */
export async function pause(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parsePauseResumeArgs(argv, "pause");
  const { atmuxDir } = await assertMemberExists(parsed, "pause");
  // Bash uses `$ATMUX_PAUSE_REASON` env, falling back to `"manual"`.
  // Mirror: --reason wins, then env, then default.
  const reason = parsed.reason ?? process.env.ATMUX_PAUSE_REASON ?? "manual";
  await pauseMember(atmuxDir, parsed.member, { reason });
  process.stdout.write(`paused ${parsed.member} (dispatch/claim will refuse)\n`);
  return 0;
}

/** `atmux resume <member>`. Returns 0 on success. */
export async function resume(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parsePauseResumeArgs(argv, "resume");
  const { atmuxDir } = await assertMemberExists(parsed, "resume");
  await resumeMember(atmuxDir, parsed.member);
  process.stdout.write(`resumed ${parsed.member}\n`);
  return 0;
}

// ---------- Internals ----------

async function assertMemberExists(
  parsed: PauseResumeArgs,
  verb: "pause" | "resume",
): Promise<{ atmuxDir: string }> {
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  if (!team.members.some((m) => m.name === parsed.member)) {
    throw new ConfigError({
      what: `${verb}: no such member in team.json: ${parsed.member}`,
    });
  }
  return { atmuxDir: await getAtmuxDir(dirOpts) };
}
