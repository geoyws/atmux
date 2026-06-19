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
//   3. Delegate to core/kanban.ts::claimTaskForMember (deps-gated) or
//      markTaskDone — plain task CRUD, no inbox/member-status coupling
//      (per ADR-263: fleet coordination removed, feed-only task model).
//
// Prints "$who claimed $id" / "$who completed $id" to stdout.

import {
  getAtmuxDir,
  type ResolveDirOpts,
  requireTeam,
  resolveCallerScope,
} from "../core/common.ts";
import {
  claimTaskForMember,
  listTasks,
  markTaskDone,
  selectNextClaimable,
  showTask,
} from "../core/kanban.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { Team, TeamMember } from "../schema/team.ts";

// ---------- Shared parser ----------

/** Parsed `claim` / `done` args. */
export interface ClaimDoneArgs {
  id: string;
  who?: string;
  note?: string;
  teamDir?: string;
  /** ADR-062 §1: `claim --next` mode — auto-select the next claimable
   *  Task in the caller's lane (no positional id required). Only valid
   *  for `claim`; rejected on `done`. */
  next?: boolean;
  /** ADR-210 Tier-2 §73: explicit role-tag filter for `claim --next
   *  --role <X>`. Restricts auto-selection to Tasks whose `.lane === X`
   *  (a hard filter — no lane-less fallback / cross-lane). Only valid
   *  with `--next`; rejected otherwise. */
  role?: string;
}

const USAGE_CLAIM =
  "atmux claim <task-id> [--as <member>]\n       atmux claim --next [--as <member>] [--role <fe|be|db|...>]";
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
  let next = false;
  let role: string | undefined;
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
    if (a === "--next") {
      if (verb !== "claim") {
        throw new UsageError({ what: `${verb}: --next is only valid with claim`, hint: usage });
      }
      next = true;
      i += 1;
      continue;
    }
    if (a === "--role") {
      if (verb !== "claim") {
        throw new UsageError({ what: `${verb}: --role is only valid with claim`, hint: usage });
      }
      const v = argv[i + 1];
      if (v === undefined || v.length === 0) {
        throw new UsageError({ what: `${verb}: --role requires a value`, hint: usage });
      }
      role = v;
      i += 2;
      continue;
    }
    if (a?.startsWith("-")) {
      throw new UsageError({ what: `${verb}: unknown flag: ${a}`, hint: usage });
    }
    if (id.length > 0) {
      throw new UsageError({ what: `${verb}: too many args`, hint: usage });
    }
    id = a ?? "";
    i += 1;
  }
  if (next) {
    if (id.length > 0) {
      throw new UsageError({
        what: `${verb} --next: don't pass <task-id> (selection is automatic)`,
        hint: usage,
      });
    }
  } else if (id.length === 0) {
    throw new UsageError({ what: `usage: atmux ${verb} <task-id> [--as <member>]`, hint: usage });
  }
  // ADR-210 §73: --role is a role-tag filter for the auto-select path,
  // so it's meaningless without --next (manual `claim <id>` already names
  // its target). Reject early rather than silently ignore.
  if (role !== undefined && !next) {
    throw new UsageError({ what: `${verb}: --role requires --next`, hint: usage });
  }
  const out: ClaimDoneArgs = { id };
  if (who !== undefined) out.who = who;
  if (note !== undefined) out.note = note;
  if (teamDir !== undefined) out.teamDir = teamDir;
  if (next) out.next = true;
  if (role !== undefined) out.role = role;
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
  if (parsed.next === true) {
    return await claimNext(parsed);
  }
  const { who, dirOpts, atmuxDir } = await resolveContext(parsed, "claim");

  // claimTaskForMember enforces deps + ADR-033 driver-only refuse-gate
  // + the 2026-05-12 race-condition gate (refuses claim of an in-progress
  // task owned by a different member).
  const callerScope = resolveCallerScope();
  await claimTaskForMember(atmuxDir, parsed.id, who, { callerScope });

  process.stdout.write(`${who} claimed ${parsed.id}\n`);
  // Suppress unused-var warning — dirOpts is only needed to thread
  // through the resolveContext call above; the return path doesn't
  // need it again.
  void dirOpts;
  return 0;
}

/**
 * `atmux claim --next [--as <member>]` — ADR-062 §1 lane-aware pull.
 *
 * Resolution sequence:
 *   1. Resolve caller name via the existing `pickMemberName` (--as / env / cwd).
 *   2. Look up caller's `lane` from `team.members[]`.
 *   3. Read `team.kanban.crossLaneClaim` (default `true`).
 *   4. `selectNextClaimable` returns the candidate; null → no-op (exit 0,
 *      empty stdout — orchestrator-friendly so cron ticks don't error).
 *   5. Strict-lane refusal (`crossLaneClaim=false` AND no own-lane work) is
 *      surfaced as `ConfigError` with a clear "no work in <LANE> lane" body
 *      so workers see why the tick refused.
 *   6. On match, delegate to `claimTaskForMember` (deps re-checked
 *      atomically). No inbox mirror (ADR-263: fleet coordination removed).
 */
async function claimNext(parsed: ClaimDoneArgs): Promise<number> {
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const who = pickMemberName(parsed, process.env, process.cwd(), team.members);
  if (who === undefined) {
    throw new UsageError({
      what: "claim --next: can't infer member — set ATMUX_MEMBER or pass --as <member>",
    });
  }
  const atmuxDir = await getAtmuxDir(dirOpts);

  const callerMember = team.members.find((m) => m.name === who);
  const callerLane =
    callerMember?.lane !== undefined && callerMember.lane.length > 0 ? callerMember.lane : null;
  const crossLaneClaim = readCrossLaneClaim(team);

  const tasks = await listTasks(atmuxDir);
  const callerScope = resolveCallerScope();
  // ADR-210 Tier-2 §73: explicit `--role <X>` is a hard lane filter that
  // bypasses callerLane / crossLaneClaim. Pass it through so selection
  // only considers Tasks whose `.lane === role`.
  const roleFilter =
    parsed.role !== undefined && parsed.role.length > 0 ? parsed.role : undefined;
  const candidate = selectNextClaimable(tasks, {
    callerLane,
    crossLaneClaim,
    caller: who,
    callerScope,
    ...(roleFilter !== undefined ? { roleFilter } : {}),
  });

  if (candidate === null) {
    // Under an explicit --role filter, the strict-lane refusal doesn't
    // apply — a dry role queue is a benign no-op (the role just has no
    // ready work), matching the lane-tick no-match semantics.
    if (roleFilter === undefined && callerLane !== null && !crossLaneClaim) {
      throw new ConfigError({
        what: `claim --next: no work in ${callerLane.toUpperCase()} lane (crossLaneClaim=false)`,
      });
    }
    // No-match no-op: exit 0, empty stdout. Orchestrators (cron lane-tick)
    // tick again on the next interval; nothing to surface.
    return 0;
  }

  // claim --next is also member-initiated; route through the gated
  // wrapper so a concurrent member who claimed this candidate between
  // selectNextClaimable + claim still loses the race cleanly.
  await claimTaskForMember(atmuxDir, candidate.id, who);

  process.stdout.write(`${who} claimed ${candidate.id}\n`);
  return 0;
}

/**
 * Read `team.kanban.crossLaneClaim` with bash-parity defaulting. Bash
 * `lib/claim.sh:200` distinguishes missing-key from explicit-false via
 * `if (.kanban // {} | has("crossLaneClaim")) then .kanban.crossLaneClaim
 * else true end`; we mirror via direct field access on the optional
 * `kanban` block.
 */
function readCrossLaneClaim(team: Team): boolean {
  return team.kanban?.crossLaneClaim ?? true;
}

/** `atmux done <task-id> [--as <member>] [--note <text>]`. Returns 0. */
export async function done(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseClaimDoneArgs(argv, "done");
  const { who, atmuxDir } = await resolveContext(parsed, "done");

  // Guard: surface a clear "no such task" before attempting the
  // transition (markTaskDone would otherwise no-op silently on a
  // missing id).
  const pre = await showTask(atmuxDir, parsed.id);
  if (pre === null) {
    throw new ConfigError({ what: `done: no such task: ${parsed.id}` });
  }

  // ADR-033 driver-only refuse-gate. markTaskDone enforces the same
  // predicate as taskMove `done` transitions inside its transaction.
  const callerScope = resolveCallerScope();
  await markTaskDone(atmuxDir, parsed.id, parsed.note, { callerScope });

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
