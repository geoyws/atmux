// ADR-010: CLI dispatcher — `claim` and `done` verbs (shared module).
// Bash spec: lib/claim.sh @ worktree-frozen.
//
// Bash routes `atmux claim <id>` → `atmux claim --claim <id>` and
// `atmux done <id>` → `atmux claim --done <id>` via bin/atmux argv
// rewrite (lib/claim.sh:5-6). Both go through one shared module.
//
// The TS port keeps the shared module + exposes two verb entrypoints
// (`claim`, `done`) so cli.ts can route directly without alias-rewrite
// gymnastics. The internal flow is identical to bash:
//
//   1. Parse `<task-id>` + optional `--as <member>` + `--note <text>`.
//   2. If `--as` not given, infer member from `$ATMUX_MEMBER` env, else
//      from cwd lookup against team.json members[].cwd. If neither
//      yields a name, throw UsageError.
//   3. Delegate to core/kanban.ts::claimTask (deps-gated) or
//      markTaskDone, then mirror to the member's inbox via
//      core/inbox.ts::movePendingToInProgress / moveInProgressToDone.
//
// Bash uses `atmux::ok` to print "$who claimed $id" / "$who completed
// $id"; TS prints to stdout for byte-parity at the verb layer.

import {
  appendDispatched,
  loadInbox,
  moveInProgressToDone,
  movePendingToInProgress,
} from "../core/inbox.ts";
import { claimTask, markTaskDone, nowEpoch, showTask } from "../core/kanban.ts";
import {
  getAtmuxDir,
  type ResolveDirOpts,
  requireTeam,
} from "../core/common.ts";
import type { TeamMember } from "../schema/team.ts";
import { ConfigError, UsageError } from "../errors.ts";

// ---------- Shared parser ----------

/** Parsed `claim` / `done` args. */
export interface ClaimDoneArgs {
  id: string;
  who?: string;
  note?: string;
  teamDir?: string;
}

const USAGE_CLAIM = "atmux claim <task-id> [--as <member>]";
const USAGE_DONE = "atmux done <task-id> [--as <member>] [--note <text>]";

/**
 * Parse argv for both claim and done. `verb` is the verb name used
 * for error messages; arg surface is otherwise identical except
 * `--note` is only meaningful for `done` (still accepted by `claim`
 * for forward-compat — bash mirrors).
 */
export function parseClaimDoneArgs(
  argv: ReadonlyArray<string>,
  verb: "claim" | "done",
): ClaimDoneArgs {
  let id = "";
  let who: string | undefined;
  let note: string | undefined;
  let teamDir: string | undefined;
  const usage = verb === "claim" ? USAGE_CLAIM : USAGE_DONE;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--as") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: `${verb}: --as requires a member name`, hint: usage });
      }
      who = v;
      i += 2;
      continue;
    }
    if (a === "--note") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: `${verb}: --note requires a value`, hint: usage });
      }
      note = v;
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
    if (id.length > 0) {
      throw new UsageError({ what: `${verb}: too many args`, hint: usage });
    }
    id = a ?? "";
    i += 1;
  }
  if (id.length === 0) {
    throw new UsageError({ what: `usage: atmux ${verb} <task-id> [--as <member>]`, hint: usage });
  }
  const out: ClaimDoneArgs = { id };
  if (who !== undefined) out.who = who;
  if (note !== undefined) out.note = note;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

/**
 * Pure: pick a member name from `--as`, env, or cwd. Returns the name
 * or undefined. Bash sequence (lib/claim.sh:29-31): explicit `--as`
 * wins, then `$ATMUX_MEMBER`, then cwd-vs-members[].cwd grep.
 */
export function pickMemberName(
  args: ClaimDoneArgs,
  env: NodeJS.ProcessEnv,
  cwd: string,
  members: ReadonlyArray<TeamMember>,
): string | undefined {
  if (args.who !== undefined && args.who.length > 0) return args.who;
  const envMember = env.ATMUX_MEMBER;
  if (envMember !== undefined && envMember.length > 0) return envMember;
  const match = members.find((m) => m.cwd !== undefined && m.cwd === cwd);
  return match?.name;
}

// ---------- Verb entrypoints ----------

/** `atmux claim <task-id> [--as <member>]`. Returns 0 on success. */
export async function claim(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseClaimDoneArgs(argv, "claim");
  const { who, dirOpts, atmuxDir } = await resolveContext(parsed, "claim");

  const claimedAt = nowEpoch();
  // claimTask enforces deps + writes the kanban side. Returns the
  // post-mutation snapshot for the inbox-mirror write.
  const claimed = await claimTask(atmuxDir, parsed.id, who);
  await movePendingToInProgress(atmuxDir, who, claimed, claimedAt);

  process.stdout.write(`${who} claimed ${parsed.id}\n`);
  // Suppress unused-var warning — dirOpts is only needed to thread
  // through the resolveContext call above; the return path doesn't
  // need it again.
  void dirOpts;
  return 0;
}

/** `atmux done <task-id> [--as <member>] [--note <text>]`. Returns 0. */
export async function done(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseClaimDoneArgs(argv, "done");
  const { who, atmuxDir } = await resolveContext(parsed, "done");

  // Bash done flow does NOT enforce deps (lib/claim.sh:61-69). We
  // also need the pre-mutation task body for the inbox mirror — read
  // BEFORE markTaskDone in case the schema strips fields.
  const pre = await showTask(atmuxDir, parsed.id);
  if (pre === null) {
    throw new ConfigError({ what: `done: no such task: ${parsed.id}` });
  }

  const completedAt = nowEpoch();
  await markTaskDone(atmuxDir, parsed.id, parsed.note);

  // Inbox mirror: bash does this only if the task is already in the
  // member's inbox.inProgress; if missing, it's a no-op-on-pending +
  // append-to-done. Mirror exactly.
  await moveInProgressToDone(atmuxDir, who, pre, completedAt);

  process.stdout.write(`${who} completed ${parsed.id}\n`);
  return 0;
}

// ---------- Internals ----------

/** Member resolution + atmuxDir construction shared by claim + done. */
async function resolveContext(
  parsed: ClaimDoneArgs,
  verb: "claim" | "done",
): Promise<{ who: string; dirOpts: ResolveDirOpts; atmuxDir: string }> {
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const who = pickMemberName(parsed, process.env, process.cwd(), team.members);
  if (who === undefined) {
    throw new UsageError({
      what: `${verb}: can't infer member — set ATMUX_MEMBER or pass --as <member>`,
    });
  }
  const atmuxDir = await getAtmuxDir(dirOpts);
  return { who, dirOpts, atmuxDir };
}

// Re-export inbox helper for tests that want to stage a "task already
// in inbox" state without going through dispatch verb. Keeps the test
// file from importing two paths for what's conceptually one helper.
export { appendDispatched, loadInbox };
