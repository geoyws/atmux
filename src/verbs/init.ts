// ADR-010: CLI dispatcher — `init` verb.
// Bash port target: lib/init.sh @ HEAD 2aadc3f.
//
// Scope (Phase 2 MVP — lifecycle lane #1):
//
//   atmux init [--name <team>] [--force|-f] [--wizard|-w] [--no-skills]
//
// Creates a `.atmux/` scaffold + `team.json` from
// `templates/team.example.json`, mirroring bash `_atmux_init_template`
// (lib/init.sh:87-107). Per-member inbox stubs, kanban.json, and
// driver-inbox.md are seeded if absent. `--wizard` runs the ADR-200
// guided flow instead (prereq probe → cockpit scaffold → team.json →
// account pool → skills plugin); see `runInitWizard` below.
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
// ADR-287 §D5 (2026-09-02): the template now ships `members: []` — the
// default roster is drivers-only (`drivers[]` + the ADR-285 `bot`
// block). On the default scaffold the per-member inbox loop (bash
// :56-60) therefore runs over an empty list and seeds nothing under
// `inboxes/`; `--claude-account` stamps `drivers[]` as well as
// `members[]` so the flag stays meaningful; and the third "Next:" hint
// is drivers-first instead of `atmux tell-lead` (which fails closed on
// a team with no declared `team-lead` — ADR-287 §D6). A template that
// still declares `members[]` renders its members exactly as before
// (cwd rewrite + stamp / strip / passthrough); the only addition for
// such a template is that its `drivers[]` are stamped / stripped too.
//
// Deliberate divergences (documented for the parity matrix):
//
//   :8       . "$ATMUX_LIB_DIR/emoji.sh" — wizard-only side effect; the
//            template path doesn't need emoji helpers, so the TS port
//            doesn't import equivalent symbols.
//   :11      atmux::require jq — bash-only dep check; TS uses `bun` +
//            zod, no jq dependency.
//   :44-48   --wizard branch — ADR-200 guided flow (`runInitWizard`):
//            prereq probe (bun/tmux/git/jq/sqlite3 + platform hints) →
//            cockpit scaffold → team.json (drivers-only roster per
//            ADR-287 §D5) → account pool → skills plugin. Piped-stdin
//            safe; `--force` overwrites team.json, `--no-skills` skips
//            the plugin step.
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

import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { claudeAccountsConfigPath } from "../abstractions/claude-accounts-config.ts";
import { ensureDir, exists, readText, readTextOrNull, writeText } from "../abstractions/fs.ts";
import { readJson } from "../abstractions/json.ts";
import { now } from "../abstractions/time.ts";
import { KanbanCliAdapter } from "../adapters/kanban-cli.ts";
import { driverInboxPath, getAtmuxDir, inboxPathFor, kanbanJsonPath } from "../core/common.ts";
import { defaultStdoutWrite, type Writer } from "../core/io.ts";
import { externalKanbanEnabled } from "../core/kanban-backend.ts";
import type { SkillsInstallResult } from "../core/skills-plugin-install.ts";
import { installSkillsPlugin, renderSkillsInstallResult } from "../core/skills-plugin-install.ts";
import { resolveTemplatesDir } from "../core/templates-dir.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { probePrereqs, scaffoldCockpit } from "../core/wizard-prereq.ts";
import {
  installSkillsPlugin as installSkillsPluginStep,
  scaffoldClaudeAccounts,
  scaffoldTeamJson,
  setupAccountPool,
} from "../core/wizard-scaffold.ts";
import {
  renderWizardHeader,
  renderWizardStep,
  shouldUseWizardColor,
  WIZARD_STEP_COUNT,
} from "../core/wizard-ui.ts";
import { ConfigError, UsageError } from "../errors.ts";
import { Team, type Team as TeamShape } from "../schema/team.ts";
import { checkStateDir } from "./doctor/state.ts";
import { checkTeam } from "./doctor/team.ts";
import { buildReport, type DoctorRow } from "./doctor/types.ts";
import { ATMUX_VERSION } from "./version.ts";

// ---------- Arg parsing ----------

export interface ParsedInitArgs {
  /** --name <team>; undefined → derive from cwd basename. */
  name?: string;
  /** --force / -f — allow overwrite of an existing team.json. */
  force: boolean;
  /** Explicit escape hatch for creating/using a team inside another team. */
  forceNest: boolean;
  /** --wizard / -w — ADR-200 guided setup (prereq probe → cockpit →
   *  team.json → account pool → skills plugin). */
  wizard: boolean;
  /** -y / --yes — auto-accept every prompt default (ADR-200 §D4 agent /
   *  CI mode). No prompt fires; team name falls back to --name or the
   *  cwd basename and the account-pool step is skipped. */
  yes: boolean;
  /** --no-start — exit after the final step without the `atmux start`
   *  next-command hint (ADR-200 §D4 CI/smoke mode). The wizard never
   *  auto-starts; this only suppresses the hint. */
  noStart: boolean;
  /** --json — emit a single machine-readable result object on stdout
   *  instead of the human step lines. */
  json: boolean;
  /** t-3866c5b1 / ADR-094: non-interactive equivalent of the wizard's
   *  team-wide claudeAccount prompt. When set + != "default", every
   *  member entry AND every `drivers[]` entry in the rendered team.json
   *  is stamped with `claudeAccount: <value>` (drivers added per
   *  ADR-287 §D5 — the default roster has no members, and
   *  `DriverSession.claudeAccount` is what `atmux start` reads when a
   *  driver sets a non-shell `tui`). "default" (or absent) leaves the
   *  field unset (schema-default applies). `bot.claudeAccount` is never
   *  touched by this flag (ADR-285: explicit operator choice). Operators
   *  run `atmux reconfigure` to override per-member after init. */
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
  let forceNest = false;
  let wizard = false;
  let yes = false;
  let noStart = false;
  let json = false;
  let claudeAccount: string | undefined;
  let noSkills = false;
  let skillsOnly = false;

  const usageHint =
    "usage: atmux init [--name <team>] [--force|-f] [--force-nest] [--wizard|-w [--yes|-y] [--no-start] [--json]] [--no-skills|--skills-only] [--claude-account <suffix>]";

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
      case "--force-nest":
        forceNest = true;
        i += 1;
        break;
      case "--wizard":
      case "-w":
        wizard = true;
        i += 1;
        break;
      case "--yes":
      case "-y":
        yes = true;
        i += 1;
        break;
      case "--no-start":
        noStart = true;
        i += 1;
        break;
      case "--json":
        json = true;
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
  const out: ParsedInitArgs = {
    force,
    forceNest,
    wizard,
    yes,
    noStart,
    json,
    noSkills,
    skillsOnly,
  };
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
export type TeamLocation =
  | { kind: "flat" }
  | { kind: "subdir"; atmuxDir: string; teamDir: string; relpath: string }
  | { kind: "nested"; atmuxDir: string; ancestorAtmuxDir: string };

/** Classify cwd against physical (not env-pinned) .atmux ancestors. */
export async function detectTeamLocation(cwd: string): Promise<TeamLocation> {
  const absoluteCwd = resolve(cwd);
  const localAtmuxDir = join(absoluteCwd, ".atmux");
  // An ancestor `.atmux/` counts as a team only when it carries a
  // `team.json` (the convention the doctor nested-state scanner uses —
  // see `findNestedStateOffenders` upward scan). The cockpit home
  // (`~/.atmux`, `cockpit.json` but no `team.json`) must never trip the
  // nest ban. Walk every level manually: `getAtmuxDir` stops at the
  // first existing `.atmux/` it finds, so a team.json-less dir between
  // the team and a real ancestor team would hide the real ancestor.
  const nearestTeamDir = await findAncestorTeamDir(absoluteCwd);
  if (nearestTeamDir === null) {
    return { kind: "flat" };
  }
  const nearest = join(nearestTeamDir, ".atmux");
  if (nearest === localAtmuxDir) {
    const ancestorTeamDir = await findAncestorTeamDir(dirname(absoluteCwd));
    if (ancestorTeamDir !== null) {
      return {
        kind: "nested",
        atmuxDir: localAtmuxDir,
        ancestorAtmuxDir: join(ancestorTeamDir, ".atmux"),
      };
    }
    return { kind: "flat" };
  }

  // Second-level check: the found team itself may sit beneath an
  // ancestor team (cwd deep inside a nested tree). Without this,
  // cwd in <A>/<B>/subdir classifies subdir and misses ancestor A.
  const aboveTeamDir = await findAncestorTeamDir(dirname(nearestTeamDir));
  if (aboveTeamDir !== null) {
    return { kind: "nested", atmuxDir: nearest, ancestorAtmuxDir: join(aboveTeamDir, ".atmux") };
  }
  return {
    kind: "subdir",
    atmuxDir: nearest,
    teamDir: nearestTeamDir,
    relpath: relative(nearestTeamDir, absoluteCwd),
  };
}

/**
 * Nearest ancestor-or-self directory whose `.atmux/team.json` exists,
 * walking from `start` up to the filesystem root. Returns the team
 * directory (the parent of `.atmux/`), or `null` when none qualifies.
 * Team.json-less `.atmux/` dirs (e.g. the cockpit home) are stepped
 * over rather than stopping the walk.
 */
async function findAncestorTeamDir(start: string): Promise<string | null> {
  let cur = resolve(start);
  while (true) {
    if (await exists(join(cur, ".atmux", "team.json"))) {
      return cur;
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export function nestedTeamError(
  verb: "init" | "up" | "start",
  ancestorAtmuxDir: string,
): ConfigError {
  return new ConfigError({
    what: `${verb}: refusing nested atmux team beneath ${ancestorAtmuxDir}`,
    hint: "re-run with --force-nest only if this nested team is intentional",
  });
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
  /** Wizard prompt override (test injection); defaults to readline on stdin. */
  prompter?: (question: string, def: string) => Promise<string>;
  /** Wizard prereq-presence override (test injection); defaults to `Bun.which`. */
  prereqCheck?: (bin: string) => boolean;
  /** Final-verification probe override (test injection). Defaults to the
   *  doctor quiet-path subset for a fresh scaffold: `checkTeam` +
   *  `checkStateDir` read back from `atmuxDir` (no shell-out, no tmux /
   *  cron / network touch). */
  verifyProbe?: (atmuxDir: string) => Promise<DoctorRow[]>;
}
/**
 * `atmux init` — scaffold a fresh `.atmux/` from the bundled template,
 * or run the ADR-200 guided flow with `--wizard`.
 *
 * Returns 0 on success. Throws `UsageError` (exit 64) on bad args,
 * `ConfigError` (exit 78) on already-initialized-without-force or on
 * missing wizard prerequisites.
 */
export async function init(argv: ReadonlyArray<string>, opts: InitOptions = {}): Promise<number> {
  const parsed = parseInitArgs(argv);
  const cwd = opts.cwd ?? process.cwd();
  const location = await detectTeamLocation(cwd);
  if (location.kind === "subdir" && !parsed.forceNest) {
    throw nestedTeamError("init", location.atmuxDir);
  }
  if (location.kind === "nested" && !parsed.forceNest) {
    throw nestedTeamError("init", location.ancestorAtmuxDir);
  }

  if (parsed.wizard) {
    return await runInitWizard(opts, parsed);
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
  // Unset (undefined) → preserve the template's field verbatim (a
  // template that declares members may carry a demonstration
  // `claudeAccount`; the shipped drivers-only template carries none).
  // Explicit "default" → STRIP any inherited field so schema-default
  // applies (operator opted into the default tier; no disk litter).
  // Non-default suffix → stamp every entry with the suffix
  // (CLAUDE_CONFIG_DIR prefix at spawn time). Operators run
  // `atmux reconfigure` post-init to override per-member.
  //
  // ADR-287 §D5: the same three branches apply to `drivers[]`. The
  // shipped template has `members: []`, so without this the flag would
  // be a silent no-op on every fresh scaffold; `drivers[].claudeAccount`
  // is a declared schema field (`src/schema/team.ts` drivers block) that
  // `atmux start`'s driver-spawn loop feeds into `resolveTuiCommand`
  // when a driver sets a `tui`. Driver `cwd` is NOT rewritten — it stays
  // relative (`.` / `.atmux/worktrees/driver-N`) because start.ts
  // anchors it at the project root and keys worktree provisioning off
  // the conventional relative path. `drivers` is optional in the schema;
  // a template without it renders without the key (no `drivers:
  // undefined` litter).
  //
  // `bot.claudeAccount` is deliberately NOT stamped or stripped. ADR-285
  // requires the bot account (and harness) to be chosen explicitly in the
  // durable team.json before automated offers are enabled, so the `bot`
  // block passes through verbatim — the shipped template's `null` stays
  // `null` under every branch of the flag. The `tui: null` driver seats
  // reach `resolveTuiCommand` only once they set a non-shell `tui`.
  const explicit = parsed.claudeAccount;
  const stampAccount = explicit !== undefined && explicit.length > 0 && explicit !== "default";
  const stripAccount = explicit === "default";
  const rendered: TeamShape = {
    ...team,
    name: teamName,
    tmuxTmpdir: `/tmp/atmux-tmux_${teamName}`,
    ...(team.drivers !== undefined
      ? {
          drivers: team.drivers.map((d) => {
            if (stampAccount) return { ...d, claudeAccount: explicit };
            if (stripAccount) {
              const { claudeAccount: _stripped, ...rest } = d;
              return rest;
            }
            return d;
          }),
        }
      : {}),
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
  // ADR-287 §D5 divergence: line 3 is drivers-first. The default roster
  // declares no `team-lead`, so `atmux tell-lead` would fail closed
  // (`no lead defined in team.json`, ADR-287 §D6) on a fresh scaffold;
  // the operator attaches the cage, drives from a driver window, and
  // keeps work state on the kb board. Teams that declare a lead can
  // still use `atmux tell-lead` — the hint just stops assuming one.
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
  stdout(
    "  3. attach the cage and drive from a driver window — work state lives on the kb board (ADR-287 §D5)\n",
  );

  return 0;
}

/**
 * ADR-200 guided `init --wizard` flow. Prompts (piped-stdin safe) then
 * runs the pure wizard steps with real filesystem bindings: prereq
 * probe → cockpit scaffold → team.json scaffold → account pool →
 * claude-accounts bootstrap (ADR-243 defaults when absent, never
 * overwrites) → skills plugin → final verification. Missing prereqs
 * refuse with install hints; existing team.json refuses without --force
 * (same gate as the template path).
 *
 * The persisted team.json goes through the `Team` schema, so the
 * drivers-only roster default (ADR-287 §D5) applies: `members: []` plus
 * the canonical `drivers[]` even though the wizard only asks for a name.
 *
 * Flags (ADR-200 §D4): `--yes` takes every default without prompting
 * (also via `ATMUX_INSTALL_YES=1`); `--no-start` drops the `atmux start`
 * next-command hint (also via `ATMUX_INSTALL_NO_START=1`) — the wizard
 * never auto-starts, the hint is the only start surface; `--json`
 * replaces the human step lines with one machine-readable result object.
 *
 * Verification reuses the doctor quiet-path subset for a fresh scaffold
 * (`checkTeam` + `checkStateDir`, no shell-out): all green prints the
 * ship line, yellow-only prints warnings and continues, red prints the
 * halt recipe and returns 1.
 */
export type WizardVerificationStatus = "ship" | "warnings" | "halt";

export interface WizardJsonResult {
  ok: boolean;
  team: string;
  teamJson: { path: string; kind: "written" | "unchanged" };
  cockpit: { path: string; changed: boolean };
  accountPool: { entries: number } | null;
  claudeAccounts: { path: string; kind: "written" | "unchanged" };
  skills: SkillsInstallResult;
  verification: {
    status: WizardVerificationStatus;
    red: number;
    yellow: number;
    rows: DoctorRow[];
  };
  started: false;
}

async function runInitWizard(opts: InitOptions, parsed: ParsedInitArgs): Promise<number> {
  const env = opts.env ?? process.env;
  const stdout = opts.stdout ?? defaultStdoutWrite;
  const cwd = opts.cwd ?? process.cwd();
  const yes = parsed.yes || env.ATMUX_INSTALL_YES === "1";
  const noStart = parsed.noStart || env.ATMUX_INSTALL_NO_START === "1";
  const jsonMode = parsed.json;
  const color =
    !jsonMode &&
    shouldUseWizardColor({ NO_COLOR: env.NO_COLOR, TERM: env.TERM }, process.stdout.isTTY === true);
  const say = (line: string): void => {
    if (!jsonMode) stdout(`${line}\n`);
  };
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const checkPrereq = opts.prereqCheck ?? ((bin: string) => Bun.which(bin) !== null);
  const probe = probePrereqs(checkPrereq, platform);
  if (probe.missing.length > 0) {
    const lines = probe.missing.map((m) => `  ${m.bin}: ${m.hint}`).join("\n");
    throw new ConfigError({
      what: `init --wizard: missing prerequisites:\n${lines}`,
      hint: "install the above, then re-run 'atmux init --wizard'",
    });
  }
  // Piped stdin (e2e/scripted runs) is slurped up front: sequential
  // rl.question calls race stream-end on pipes in some runtimes.
  // A TTY keeps true interactive prompting. Injected prompters (unit
  // tests) skip stdin entirely so no fd is consumed. --yes skips
  // stdin entirely — every prompt takes its default.
  const pipedAnswers =
    opts.prompter === undefined && !yes && process.stdin.isTTY !== true
      ? (await Bun.stdin.text()).split("\n").map((line) => line.trim())
      : null;
  const rl =
    opts.prompter === undefined && pipedAnswers === null && !yes
      ? createInterface({ input: process.stdin, output: process.stdout })
      : undefined;
  const ask = async (question: string, def: string): Promise<string> => {
    if (yes) return def;
    if (opts.prompter !== undefined) return opts.prompter(question, def);
    if (pipedAnswers !== null) {
      const answer = pipedAnswers.shift() ?? "";
      return answer === "" ? def : answer;
    }
    const answer = (await rl!.question(`${question} [${def}]: `)).trim();
    return answer === "" ? def : answer;
  };
  try {
    // Refuse before any side effect: a refused re-run must not touch
    // cockpit.json either.
    const dir = join(cwd, ".atmux");
    const tj = join(dir, "team.json");
    if ((await exists(tj)) && !parsed.force) {
      throw new ConfigError({
        what: `already initialized at ${tj} — pass --force to overwrite`,
      });
    }
    say(renderWizardHeader({ version: ATMUX_VERSION, color }));
    say(renderWizardStep(1, WIZARD_STEP_COUNT, "Prereq probe", { color }));
    say("prereqs: all required binaries present");
    const teamName = await ask("Team name", parsed.name ?? basename(cwd));
    const home = env.HOME ?? homedir();
    const cockpitFs = {
      cockpitPath: join(home, ".atmux", "cockpit.json"),
      mkdir: (path: string) => ensureDir(path),
      writeFile: (path: string, content: string) => writeText(path, content),
      readFile: (path: string) => readTextOrNull(path),
    };
    say(renderWizardStep(2, WIZARD_STEP_COUNT, "Cockpit init", { color }));
    const cockpitResult = await scaffoldCockpit(cockpitFs, cwd);
    say(`cockpit: ${cockpitResult.changed ? "updated" : "unchanged"} ${cockpitResult.cockpitPath}`);
    say(renderWizardStep(3, WIZARD_STEP_COUNT, "team.json", { color }));
    await ensureDir(dir);
    const teamDeps = {
      path: tj,
      readText: (path: string) => readTextOrNull(path),
      writeText: (path: string, content: string) => writeText(path, content),
    };
    const teamResult = await scaffoldTeamJson(teamDeps, { name: teamName });
    say(`team.json: ${teamResult.kind} ${tj}`);
    say(renderWizardStep(4, WIZARD_STEP_COUNT, "Account pool", { color }));
    const suffixes = await ask("Claude account suffixes (comma-separated, empty skips pool)", "");
    const accounts = suffixes
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((suffix) => ({ configDir: join(home, `.claude-${suffix}`), label: suffix }));
    let poolEntries: number | null = null;
    if (accounts.length > 0) {
      const poolDeps = { ...teamDeps, path: cockpitFs.cockpitPath };
      const poolResult = await setupAccountPool(poolDeps, accounts);
      poolEntries = accounts.length;
      say(`account pool: ${poolResult.kind} (${accounts.length} entries)`);
    } else {
      say("account pool: skipped (no suffixes)");
    }
    const claudeAccountsPath = claudeAccountsConfigPath(home);
    const claudeAccountsResult = await scaffoldClaudeAccounts({
      path: claudeAccountsPath,
      readText: (path: string) => readTextOrNull(path),
      writeText: (path: string, content: string) => writeText(path, content),
    });
    say(`claude-accounts: ${claudeAccountsResult.kind} ${claudeAccountsPath}`);
    say(renderWizardStep(5, WIZARD_STEP_COUNT, "Skills plugin", { color }));
    let skillsResult: SkillsInstallResult;
    if (!parsed.noSkills) {
      skillsResult = await installSkillsPluginStep({
        runner: (stepOpts) =>
          installSkillsPlugin({ env, force: parsed.force, noSkills: parsed.noSkills, ...stepOpts }),
      });
      say(renderSkillsInstallResult(skillsResult).trimEnd());
    } else {
      skillsResult = { kind: "skipped", reason: "--no-skills" };
      say("skills plugin: skipped (--no-skills)");
    }
    // Final verification (ADR-200 Layer 1 step 7 analogue): the doctor
    // quiet-path subset for a fresh scaffold, read back from disk.
    say("Final verification");
    const verify = opts.verifyProbe ?? defaultWizardVerifyProbe;
    const rows = await verify(dir);
    const report = buildReport(rows);
    const status: WizardVerificationStatus =
      report.redCount > 0 ? "halt" : report.yellowCount > 0 ? "warnings" : "ship";
    if (status === "ship") {
      say(`verification: ship it — ${rows.length} doctor checks green, team '${teamName}' ready`);
    } else if (status === "warnings") {
      say(`verification: warnings — ${report.yellowCount} yellow check(s), continuing`);
      for (const row of rows) {
        if (row.status === "yellow") say(`  ! ${row.label}: ${row.detail ?? ""}`);
      }
      say("run 'atmux doctor' for the full report");
    } else {
      say(`verification: halt — ${report.redCount} red check(s)`);
      for (const row of rows) {
        if (row.status === "red") {
          say(`  ✗ ${row.label}: ${row.detail ?? ""}${row.hint ? ` — fix: ${row.hint}` : ""}`);
        }
      }
      say("fix: address the rows above, then re-run 'atmux init --wizard --force'");
      say(`detail: run 'atmux doctor' in ${cwd} for the full report`);
    }
    const result: WizardJsonResult = {
      ok: status !== "halt",
      team: teamName,
      teamJson: { path: tj, kind: teamResult.kind },
      cockpit: { path: cockpitResult.cockpitPath, changed: cockpitResult.changed },
      accountPool: poolEntries === null ? null : { entries: poolEntries },
      claudeAccounts: { path: claudeAccountsPath, kind: claudeAccountsResult.kind },
      skills: skillsResult,
      verification: { status, red: report.redCount, yellow: report.yellowCount, rows },
      started: false,
    };
    if (jsonMode) {
      stdout(`${JSON.stringify(result)}\n`);
      return result.ok ? 0 : 1;
    }
    if (noStart) {
      stdout(`wizard complete: team '${teamName}' ready\n`);
    } else {
      stdout(`wizard complete: team '${teamName}' ready — run 'atmux start' next\n`);
    }
    return result.ok ? 0 : 1;
  } finally {
    if (rl !== undefined) rl.close();
  }
}

/**
 * Default final-verification probe: the doctor quiet-path subset that a
 * fresh scaffold can satisfy — `checkTeam` (team.json parses + roster
 * sane) + `checkStateDir` (`.atmux/` writable). Pure read-back, no
 * shell-out, no tmux / cron / network touch.
 */
async function defaultWizardVerifyProbe(atmuxDir: string): Promise<DoctorRow[]> {
  return [...(await checkTeam(atmuxDir)), ...(await checkStateDir(atmuxDir))];
}
