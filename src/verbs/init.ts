// ADR-010: CLI dispatcher — `init` verb.
// Bash port target: lib/init.sh @ HEAD 2aadc3f.
//
// Scope (Phase 2 MVP — lifecycle lane #1):
//
//   atmux init [--name <team>] [--force|-f]
//
// Creates a `.atmux/` scaffold + `team.json` from
// `templates/team.example.json`, mirroring bash `_atmux_init_template`
// (lib/init.sh:87-107). Per-member inbox stubs, kanban.json, and
// driver-inbox.md are seeded if absent. The non-interactive template
// path is the operator-priority MVP target — `--wizard` is parsed for
// arg-shape parity but throws `ConfigError` (Phase 2 follow-up).
//
// Bash semantics matched 1:1 (cite: lib/init.sh):
//
//   :13      `team_name=""` arg parsing loop, --name/--force/--wizard
//   :25      default team_name to basename($PWD) when --name absent
//   :27-28   dir = "$PWD/.atmux"; tj = "$dir/team.json"
//            (literal $PWD-rooted path; init does NOT walk up. Differs
//            from `atmux::dir` which respects $ATMUX_DIR. This file
//            uses `opts.cwd ?? process.cwd()` directly to match.)
//   :30-32   refuse to overwrite without --force
//   :34      mkdir -p $dir/{inboxes,logs,state,archive}
//   :40-42   --force path: timestamped backup of team.json before write
//   :47      template path (this commit); :45 wizard is the deferred branch
//   :50-51   seed kanban.json + driver-inbox.md if absent (uses
//            $(atmux::kanban_json) / $(atmux::driver_inbox), which honour
//            $ATMUX_DIR — under the parity harness ATMUX_DIR is set so
//            both bash + TS resolve to the same fixture path)
//   :56-60   per-member inbox files seeded from `.members[].name`
//   :87-107  template render — set name, tmuxTmpdir = "/tmp/atmux-tmux_<name>",
//            members[].cwd = $PWD
//   :79      atmux::ok success line → stderr (color-suppressed under
//            non-TTY, matching bash's `[[ -t 1 ]]` gate)
//   :80-84   "Next:" instruction lines → stdout
//
// Deliberate divergences (documented for the parity matrix):
//
//   :8       . "$ATMUX_LIB_DIR/emoji.sh" — wizard-only side effect; the
//            template path doesn't need emoji helpers, so the TS port
//            doesn't import equivalent symbols.
//   :11      atmux::require jq — bash-only dep check; TS uses `bun` +
//            zod, no jq dependency.
//   :44-48   --wizard branch — interactive prompts (~250 LOC of bash);
//            deferred to a Phase 2 follow-up. Throws ConfigError →
//            exit 78 with a clear "not yet implemented" message so
//            operators get an explicit signal rather than a silent
//            template-fallback footgun.
//   :70-77   atmux::registry_upsert — registry abstraction not yet
//            ported in atmux-bun; the registry lives at
//            ~/.claude/teams/registry.json (outside `.atmux/`) so the
//            parity harness's fsState diff is unaffected. Phase 2/5
//            follow-up wires this in. Until then bash will populate the
//            registry under harness invocations and TS won't — which
//            is invisible to the per-fixture comparator.
//
// Parity-fixture coordination: tester authors `tests/parity/init.test.ts`
// against this verb in parallel; the TS verb name + arg shape (`init
// [--name <team>] [--force|-f]`) is the contract.

import { basename, join } from "node:path";
import { KanbanCliAdapter } from "../adapters/kanban-cli.ts";
import { ensureDir, exists, readText, writeText } from "../abstractions/fs.ts";
import { readJson } from "../abstractions/json.ts";
import { now } from "../abstractions/time.ts";
import { driverInboxPath, getAtmuxDir, inboxPathFor, kanbanJsonPath } from "../core/common.ts";
import { externalKanbanEnabled } from "../core/kanban-backend.ts";
import { defaultStdoutWrite, type Writer } from "../core/io.ts";
import { installSkillsPlugin, renderSkillsInstallResult } from "../core/skills-plugin-install.ts";
import { resolveTemplatesDir } from "../core/templates-dir.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { ConfigError, UsageError } from "../errors.ts";
import { Team, type Team as TeamShape } from "../schema/team.ts";

// ---------- Arg parsing ----------

export interface ParsedInitArgs {
  /** --name <team>; undefined → derive from cwd basename. */
  name?: string;
  /** --force / -f — allow overwrite of an existing team.json. */
  force: boolean;
  /** --wizard / -w — interactive setup (NOT yet implemented in port). */
  wizard: boolean;
  /** t-3866c5b1 / ADR-094: non-interactive equivalent of the wizard's
   *  team-wide claudeAccount prompt. When set + != "default", every
   *  member entry in the rendered team.json is stamped with
   *  `claudeAccount: <value>`. "default" (or absent) leaves the field
   *  unset (schema-default applies). Operators run `atmux reconfigure`
   *  to override per-member after init. */
  claudeAccount?: string;
  /** ADR-217 §D5: --no-skills skips the bundled /atmux: skills plugin
   *  install step (default behavior is to install). */
  noSkills: boolean;
  /** ADR-217 §D5: --skills-only runs ONLY the skills-plugin install
   *  step, skipping the team.json scaffold. Re-install path post manual
   *  delete; valid even on an already-initialized team. */
  skillsOnly: boolean;
}

/**
 * Parse `init` argv. Mirrors the case-loop at lib/init.sh:16-23.
 *
 * Bash exits via `atmux::die "init: unknown arg: $1"` on an unrecognised
 * flag — die exits 1, but ADR-006 maps unknown-arg shape to UsageError →
 * exit 64 (BSD `EX_USAGE`). The tester's parity matrix carries this as
 * an exit-code drift (1 vs 64) for the unknown-init-arg case; the same
 * 1→64 fix applied to the unknown-VERB path (Task #9, commit 7ca2aed)
 * applies symmetrically here.
 */
export function parseInitArgs(args: ReadonlyArray<string>): ParsedInitArgs {
  let name: string | undefined;
  let force = false;
  let wizard = false;
  let claudeAccount: string | undefined;
  let noSkills = false;
  let skillsOnly = false;

  const usageHint =
    "usage: atmux init [--name <team>] [--force|-f] [--no-skills|--skills-only] [--claude-account <suffix>]";

  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? "";
    switch (a) {
      case "--name": {
        const val = args[i + 1];
        if (val === undefined) {
          throw new UsageError({
            what: "init: --name requires a value",
            hint: usageHint,
          });
        }
        name = val;
        i += 2;
        break;
      }
      case "--force":
      case "-f":
        force = true;
        i += 1;
        break;
      case "--wizard":
      case "-w":
        wizard = true;
        i += 1;
        break;
      case "--no-skills":
        noSkills = true;
        i += 1;
        break;
      case "--skills-only":
        skillsOnly = true;
        i += 1;
        break;
      case "--claude-account": {
        // t-3866c5b1 / ADR-094: non-interactive twin of the wizard's
        // team-wide claudeAccount prompt. Validation is value-shape
        // only — refuse empty + non-finite (any operator-defined
        // suffix is otherwise acceptable; the corresponding
        // `$HOME/.claude-<suffix>` dir is operator-maintained).
        const val = args[i + 1];
        if (val === undefined || val.length === 0) {
          throw new UsageError({
            what: "init: --claude-account requires a value",
            hint: "valid: default | personal | icloud | ifca | unum | <custom-suffix>",
          });
        }
        claudeAccount = val;
        i += 2;
        break;
      }
      default:
        throw new UsageError({
          what: `init: unknown arg: ${a}`,
          hint: usageHint,
        });
    }
  }
  // ADR-217 §D5: --no-skills and --skills-only are mutually exclusive.
  // Refusing surfaces the conflict at parse time rather than at runtime
  // (skills-only would silently win since it short-circuits the install).
  if (noSkills && skillsOnly) {
    throw new UsageError({
      what: "init: --no-skills and --skills-only cannot be combined",
      hint: usageHint,
    });
  }
  // exactOptionalPropertyTypes: only set keys when defined (an explicit
  // `name: undefined` is not the same as an absent key under the strict
  // tsconfig). Build the shape conditionally.
  const out: ParsedInitArgs = { force, wizard, noSkills, skillsOnly };
  if (name !== undefined) out.name = name;
  if (claudeAccount !== undefined) out.claudeAccount = claudeAccount;
  return out;
}

// ---------- Template path resolution ----------

/**
 * Repo-rooted resolve for the template file. Mirrors bash bin/atmux:18-20:
 *
 *   ATMUX_ROOT="$(cd "$ATMUX_BIN_DIR/.." && pwd)"
 *   export ATMUX_TEMPLATES_DIR="$ATMUX_ROOT/templates"
 *
 * Delegates to {@link resolveTemplatesDir} for the dev / installed
 * dual-path resolution (closes c-003a2a4c — compiled binary's
 * `import.meta.dir` walks bun's internal $bunfs to `/templates` which
 * doesn't exist on disk; the shared resolver probes the dev path
 * first, then falls back to `<process.execPath>/../templates`).
 */
function defaultTemplatesDir(env: NodeJS.ProcessEnv): string {
  return resolveTemplatesDir(env);
}

// ---------- Verb entry ----------

export interface InitOptions {
  /** Working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Templates dir override (test injection). */
  templatesDir?: string;
  /** Env hash. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Logger override (test injection); defaults to stderr-bound default. */
  logger?: Logger;
  /** stdout sink override (test injection); defaults to `process.stdout.write`. */
  stdout?: Writer;
  /** External work-ledger adapter override (test injection). */
  kanbanAdapter?: Pick<KanbanCliAdapter, "initialize">;
  /** Backup source reader override for the best-effort `--force` copy. */
  backupReadText?: typeof readText;
}

/**
 * `atmux init` — scaffold a fresh `.atmux/` from the bundled template.
 *
 * Returns 0 on success. Throws `UsageError` (exit 64) on bad args,
 * `ConfigError` (exit 78) on already-initialized-without-force or on
 * the deferred --wizard branch.
 */
export async function init(argv: ReadonlyArray<string>, opts: InitOptions = {}): Promise<number> {
  const parsed = parseInitArgs(argv);

  if (parsed.wizard) {
    // bash lib/init.sh:44-46 routes to `_atmux_init_wizard` here. Wizard
    // is interactive prompts (~250 LOC); deferred to a follow-up commit
    // so this MVP can land the operator-priority template path. Refusing
    // explicitly is safer than silently falling through to the template
    // path with a different observable shape than bash.
    throw new ConfigError({
      what: "init: --wizard not yet implemented in atmux-bun",
      hint: "use 'atmux init --name <team>' for the template path; bash 'atmux init --wizard' still works",
    });
  }

  const env = opts.env ?? process.env;
  const stdout = opts.stdout ?? defaultStdoutWrite;

  // ADR-217 §D5: --skills-only short-circuits scaffold entirely. The
  // re-install path post-manual-delete should NOT require the team.json
  // to be absent (--force) nor risk overwriting it (no --force). Run the
  // plugin step + return.
  if (parsed.skillsOnly) {
    const result = await installSkillsPlugin({ env, force: parsed.force });
    stdout(renderSkillsInstallResult(result));
    return 0;
  }

  const cwd = opts.cwd ?? process.cwd();
  const teamName =
    parsed.name !== undefined && parsed.name.length > 0 ? parsed.name : basename(cwd);

  // Bash lib/init.sh:27-28 — `dir="$PWD/.atmux"`. Literal $PWD path,
  // bypassing atmux::dir's walk-up + env-override resolution. Match
  // exactly so a child-of-existing-.atmux invocation creates the new
  // team in the LOCAL dir, not the ancestor.
  const dir = join(cwd, ".atmux");
  const tj = join(dir, "team.json");

  // Refuse-overwrite gate. Bash :30-32: `atmux::die "already
  // initialized..."`. The bash-side dies with exit 1; the TS port
  // surfaces ConfigError → exit 78 (EX_CONFIG, ADR-006) which is the
  // semantically-correct mapping. Same 1→64/78 alignment as Task #9's
  // unknown-verb fix.
  if ((await exists(tj)) && !parsed.force) {
    throw new ConfigError({
      what: `already initialized at ${tj} — pass --force to overwrite`,
    });
  }

  // Scaffold dirs (bash :34: mkdir -p $dir/{inboxes,logs,state,archive}).
  await ensureDir(join(dir, "inboxes"));
  await ensureDir(join(dir, "logs"));
  await ensureDir(join(dir, "state"));
  await ensureDir(join(dir, "archive"));

  // --force backup. Bash :40-42 calls `atmux::team_json_backup` (lib/
  // common.sh:103-109); inline equivalent here. Best-effort: a copy
  // failure is non-fatal so a low-disk / read-only edge case doesn't
  // wedge the legitimate flow.
  if (parsed.force && (await exists(tj))) {
    const backupReadText = opts.backupReadText ?? readText;
    const epoch = Math.floor(now() / 1000);
    const bak = `${tj}.bak.${epoch}`;
    try {
      const src = await backupReadText(tj);
      await writeText(bak, src);
    } catch {
      // expected: backup is best-effort safety net per bash semantics;
      // we don't fail the init if the bak write fails.
    }
  }

  // Render template. Bash :102-106 jq filter: set name + tmuxTmpdir +
  // members[].cwd. ZodTeam is `.passthrough()` so the template's
  // `_comment_*` keys + Phase-2 sub-shapes survive intact (per
  // src/schema/team.ts header comment).
  const templatesDir = opts.templatesDir ?? defaultTemplatesDir(env);
  const templatePath = join(templatesDir, "team.example.json");
  const team = await readJson(templatePath, Team);
  // t-3866c5b1 / ADR-094: --claude-account triages into three branches.
  // Unset (undefined) → preserve template's field verbatim (the
  // template's lead entry carries demonstration `claudeAccount:
  // "personal"`). Explicit "default" → STRIP any inherited field so
  // schema-default applies (operator opted into the default tier; no
  // disk litter). Non-default suffix → stamp every member with the
  // suffix (CLAUDE_CONFIG_DIR prefix at spawn time). Operators run
  // `atmux reconfigure` post-init to override per-member.
  const explicit = parsed.claudeAccount;
  const stampAccount = explicit !== undefined && explicit.length > 0 && explicit !== "default";
  const stripAccount = explicit === "default";
  const rendered: TeamShape = {
    ...team,
    name: teamName,
    tmuxTmpdir: `/tmp/atmux-tmux_${teamName}`,
    members: team.members.map((m) => {
      if (stampAccount) return { ...m, cwd, claudeAccount: explicit };
      if (stripAccount) {
        const { claudeAccount: _stripped, ...rest } = m;
        return { ...rest, cwd };
      }
      return { ...m, cwd };
    }),
  };
  // Compact serialization to keep team.json human-readable + match the
  // shape jq emits (2-space indent + trailing newline). The parity
  // comparator canonicalises JSON before diffing (tests/parity/
  // README.md §"Layout"), so byte-level key-order drift between bash
  // jq (sorted) and JSON.stringify (insertion-order) is absorbed there.
  await writeText(tj, `${JSON.stringify(rendered, null, 2)}\n`);

  // Seed kanban.json + driver-inbox.md if absent. Bash :50-51 uses
  // `$(atmux::kanban_json)` / `$(atmux::driver_inbox)` which respect
  // $ATMUX_DIR. Match by routing through `getAtmuxDir` (which has the
  // same resolution order). After the scaffold mkdir above, the walk-up
  // path also lands on `<cwd>/.atmux` so all three resolution paths
  // (env-override / walk-up-find-just-created / fallback) coincide.
  const atmuxDir = await getAtmuxDir({ cwd, env });
  const kanban = kanbanJsonPath(atmuxDir);
  const drvInbox = driverInboxPath(atmuxDir);
  if (await externalKanbanEnabled(atmuxDir, env)) {
    // Deliberately NOT `{ env }`: here `env` is `process.env`, and handing it
    // to the adapter as an explicit env would re-admit the ambient
    // `KANBAN_DB` / `KANBAN_DATA_DIR` the adapter strips, at the one call site
    // that creates the board. The adapter inherits the environment itself.
    const adapter = opts.kanbanAdapter ?? new KanbanCliAdapter();
    await adapter.initialize(atmuxDir, teamName);
  } else if (!(await exists(kanban))) {
    // Bash literal: `echo '{"tasks":[],"epics":[],"stories":[]}' > "$kj"`.
    // writeText to byte-match (compact, single-line, trailing newline).
    await writeText(kanban, '{"tasks":[],"epics":[],"stories":[]}\n');
  }
  if (!(await exists(drvInbox))) {
    // Bash literal: `: > "$di"` — empty file, zero bytes.
    await writeText(drvInbox, "");
  }

  // Per-member inbox files (bash :56-60). Iterate over members from the
  // rendered team object directly — equivalent to bash's
  // `jq -r '.members[].name'` re-read of the just-written team.json.
  // The bash side defensively skips empty names (`[[ -z "$m" ]] &&
  // continue`); the TS port's `Team` schema enforces `members[].name`
  // is non-empty (src/schema/team.ts:27 — `z.string().min(1)`), so the
  // empty-name branch is statically unreachable here.
  for (const member of rendered.members) {
    const ib = inboxPathFor(dir, member.name);
    if (!(await exists(ib))) {
      // Bash literal: `echo '{"pending":[],"inProgress":[],"done":[]}' > "$ib"`.
      await writeText(ib, '{"pending":[],"inProgress":[],"done":[]}\n');
    }
  }

  // (Skipped per header comment: bash :70-77 atmux::registry_upsert.
  // Registry abstraction lands in a follow-up; no fsState divergence.)

  // Output. Bash :79-84:
  //   atmux::ok "initialized atmux team '$team_name' at $dir"   → stderr
  //   echo ""                                                    → stdout
  //   echo "Next:"                                               → stdout
  //   echo "  1. review $tj"                                     → stdout
  //   echo "  2. atmux start"                                    → stdout
  //   echo "  3. atmux tell-lead 'build feature X'"              → stdout
  //
  // Under the parity harness `NO_COLOR=1` + non-TTY, both bash + TS
  // emit color-stripped output (bash via `[[ -t 1 ]]`; TS via
  // `defaultPalette`'s isTty + NO_COLOR detection in src/core/tui.ts).
  const logger = opts.logger ?? createLogger();
  logger.ok(`initialized atmux team '${teamName}' at ${dir}`);

  // ADR-217 §D5: install the bundled /atmux: skills plugin by
  // symlinking ~/.claude/plugins/atmux/ → <atmux-source>/plugins/atmux/.
  // Default-install; --no-skills opts out. Real-directory override
  // preserved + opt-out marker honoured + idempotent on already-correct
  // symlink. Output goes to stdout alongside the "Next:" lines so the
  // operator sees the full picture in one block.
  const skillsResult = await installSkillsPlugin({
    env,
    noSkills: parsed.noSkills,
    force: parsed.force,
  });
  stdout(renderSkillsInstallResult(skillsResult));

  stdout("\n");
  stdout("Next:\n");
  stdout(`  1. review ${tj}\n`);
  stdout("  2. atmux start\n");
  stdout("  3. atmux tell-lead 'build feature X'\n");

  return 0;
}
