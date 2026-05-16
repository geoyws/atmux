// ADR-090 §`spawn-epic` verb (t-b430b185).
//
// `atmux team spawn-epic <epicId> --from <parentTeam>
//   [--roster <preset> | --roster-file <path>]
//   [--parent-base <branch>] [--parent-epic-kanban-id <eid>]
//   [--no-init-submodules]`
//
// Creates an epic-team child of `<parentTeam>`. The child is an
// ephemeral, shared-worktree team that lives at the sibling path
// `<parentRoot>-epics/<epicId>/` per ADR-090 §Decision-anchor #2
// disk layout. Members share one worktree (HARD CONFLICT carve-out
// vs ADR-084 per §Decision-anchor #3 — structurally enforced by
// the Team schema's superRefine).
//
// Pipeline (single-commit, single-verb):
//
//   1. Resolve caller-scope. Refuses if not driver (ADR-033 caller-
//      scope gate per Task pre-flag #3).
//   2. Resolve parent via cockpit walk. Refuses if parent team not
//      registered in `~/.atmux/cockpit.json::sessions[]`.
//   3. Compute paths: epicRoot = `<parentRoot>-epics/<epicId>`;
//      branch = `<parentBase>-epic-<epicId>`; cage tmpdir =
//      `/tmp/atmux-<parentTeam>/epics/<epicId>` (ADR-089 §Pillar 1).
//   4. Resolve roster: --roster-file > --roster > default. Mutually
//      exclusive (per ADR-090 §Decision-anchor #4) — refuse if both
//      set.
//   5. provisionWorktree(parentRoot, parentBase, branch, epicRoot,
//      {initSubmodules: true}) — reuses ADR-082/088 primitive
//      verbatim. Side-effect rollback on subsequent failures uses
//      pruneWorktree under the same Provision result handle.
//   6. Synthesize child Team object (roster members + name + tmpdir
//      + epicTeam block) and write `<epicRoot>/.atmux/team.json`.
//      Validate via Team schema BEFORE write — cross-field refusals
//      from superRefine surface as the verb's failure (refuses pre-
//      worktree-cleanup so any partial roster lands without epic-
//      team state.db pollution).
//   7. Initialize child state.db via openDatabase + migrations.
//   8. Register child in parent's cockpit sessions[] (raw read +
//      mutate + write back; loadCockpit's enriched legacy fields
//      would round-trip lossy).
//   9. Log "next: atmux cockpit rebuild" — child cage spawn is the
//      operator's manual step in v1 (matches the existing cockpit
//      verb pattern; auto-spawn lands as a follow-up Task).
//
// Rollback semantics (per Task pre-flag #1, transactional boundary):
// failures in steps 6-8 attempt to undo the worktree (pruneWorktree
// in `--force` mode is acceptable because we authored the worktree
// in step 5 — operator never touched it). Step 9 failure is logged
// + does NOT rollback (the registry append is the LAST mutation;
// the verb exits non-zero with the partial state visible).
//
// Out of scope: child cage start (operator runs cockpit rebuild);
// gh fail-fast assertions for pr-mode (§Decision-anchor #10 — pr-
// mode runtime is deferred per §Decision-anchor #6; the schema
// refuses pr-mode without prTarget.base + prAuthorUser, which
// catches the misconfiguration at schema layer instead).

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { exists, writeText } from "../../abstractions/fs.ts";
import { readJson } from "../../abstractions/json.ts";
import { closeDatabase, type Database, openDatabase } from "../../abstractions/sqlite.ts";
import { migrations } from "../../abstractions/sqlite-migrations.ts";
import {
  defaultGitSpawn,
  type GitSpawn,
  provisionWorktree,
  pruneWorktree,
} from "../../abstractions/worktree.ts";
import { defaultCockpitConfigPath, migrateLegacyShape } from "../../core/cockpit.ts";
import { resolveCallerScope } from "../../core/common.ts";
import { ConfigError, UsageError } from "../../errors.ts";
import { Team, type Team as TeamShape } from "../../schema/team.ts";

const USAGE =
  "atmux team spawn-epic <epicId> --from <parentTeam>\n" +
  "  [--roster <preset> | --roster-file <path>]\n" +
  "  [--parent-base <branch>] [--parent-epic-kanban-id <eid>]\n" +
  "  [--merge-mode auto|pr] [--no-init-submodules]";

// ---------- Arg parsing ----------

export interface ParsedSpawnEpicArgs {
  epicId: string;
  parentTeam: string;
  roster?: string;
  rosterFile?: string;
  parentBase?: string;
  parentEpicKanbanId?: string;
  mergeMode?: "auto" | "pr";
  initSubmodules: boolean;
}

export function parseSpawnEpicArgs(argv: ReadonlyArray<string>): ParsedSpawnEpicArgs {
  let epicId: string | undefined;
  let parentTeam: string | undefined;
  let roster: string | undefined;
  let rosterFile: string | undefined;
  let parentBase: string | undefined;
  let parentEpicKanbanId: string | undefined;
  let mergeMode: "auto" | "pr" | undefined;
  let initSubmodules = true;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--from") {
      parentTeam = requireValue(argv, i, "--from");
      i += 2;
      continue;
    }
    if (a === "--roster") {
      roster = requireValue(argv, i, "--roster");
      i += 2;
      continue;
    }
    if (a === "--roster-file") {
      rosterFile = requireValue(argv, i, "--roster-file");
      i += 2;
      continue;
    }
    if (a === "--parent-base") {
      parentBase = requireValue(argv, i, "--parent-base");
      i += 2;
      continue;
    }
    if (a === "--parent-epic-kanban-id") {
      parentEpicKanbanId = requireValue(argv, i, "--parent-epic-kanban-id");
      i += 2;
      continue;
    }
    if (a === "--merge-mode") {
      const v = requireValue(argv, i, "--merge-mode");
      if (v !== "auto" && v !== "pr") {
        throw new UsageError({
          what: `spawn-epic: --merge-mode must be 'auto' or 'pr' (got: ${v})`,
          hint: USAGE,
        });
      }
      mergeMode = v;
      i += 2;
      continue;
    }
    if (a === "--no-init-submodules") {
      initSubmodules = false;
      i += 1;
      continue;
    }
    if (a?.startsWith("-") === true) {
      throw new UsageError({
        what: `spawn-epic: unknown flag: ${a}`,
        hint: USAGE,
      });
    }
    if (epicId === undefined) {
      epicId = a;
      i += 1;
      continue;
    }
    throw new UsageError({
      what: `spawn-epic: unexpected positional: ${a}`,
      hint: USAGE,
    });
  }
  if (epicId === undefined || epicId.length === 0) {
    throw new UsageError({
      what: "spawn-epic: <epicId> required",
      hint: USAGE,
    });
  }
  if (parentTeam === undefined || parentTeam.length === 0) {
    throw new UsageError({
      what: "spawn-epic: --from <parentTeam> required",
      hint: USAGE,
    });
  }
  // ADR-090 §Decision-anchor #4: --roster and --roster-file are
  // mutually exclusive. Refuse early so the operator sees the
  // misconfig before any disk mutation.
  if (roster !== undefined && rosterFile !== undefined) {
    throw new UsageError({
      what: "spawn-epic: --roster and --roster-file are mutually exclusive (ADR-090 §Decision-anchor #4)",
      hint: USAGE,
    });
  }
  const out: ParsedSpawnEpicArgs = {
    epicId,
    parentTeam,
    initSubmodules,
  };
  if (roster !== undefined) out.roster = roster;
  if (rosterFile !== undefined) out.rosterFile = rosterFile;
  if (parentBase !== undefined) out.parentBase = parentBase;
  if (parentEpicKanbanId !== undefined) out.parentEpicKanbanId = parentEpicKanbanId;
  if (mergeMode !== undefined) out.mergeMode = mergeMode;
  return out;
}

function requireValue(argv: ReadonlyArray<string>, i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined || v === "") {
    throw new UsageError({
      what: `spawn-epic: ${flag} requires a value`,
      hint: USAGE,
    });
  }
  return v;
}

// ---------- Verb dependencies (test injection) ----------

export interface SpawnEpicOpts {
  git?: GitSpawn;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
  openDb?: (path: string) => Database;
  closeDb?: (db: Database) => void;
  /** Override the templates dir for roster resolution. Production
   *  default reads `<atmuxRepoRoot>/templates/epic-rosters/`; tests
   *  inject a scratch dir with a synthetic roster. */
  templatesDir?: string;
  /** Override cockpit config path (test injection). Defaults to
   *  `defaultCockpitConfigPath(home)` per ADR-089. */
  cockpitPath?: string;
  /** Override caller scope (test injection). Defaults to
   *  `resolveCallerScope()`. */
  callerScope?: () => "driver" | "member";
  /** Override `process.env` (test injection — for $HOME resolution). */
  env?: NodeJS.ProcessEnv;
}

// ---------- Top-level dispatch ----------

/** Bare-minimal raw cockpit shape needed for the sessions[] mutation —
 *  passthrough on every other field so unrelated keys round-trip. */
const RawCockpitForMutation = z
  .object({
    sessions: z.array(z.unknown()).optional(),
  })
  .passthrough();

interface SessionEntry {
  type?: string;
  name?: string;
  root?: string;
  enabled?: boolean;
  sessions?: SessionEntry[];
  parent?: string;
  epicId?: string;
}

export async function spawnEpic(
  argv: ReadonlyArray<string>,
  opts: SpawnEpicOpts = {},
): Promise<number> {
  const parsed = parseSpawnEpicArgs(argv);
  const logger = opts.logger ?? {
    log: (m: string) => process.stderr.write(`${m}\n`),
    warn: (m: string) => process.stderr.write(`WARN: ${m}\n`),
  };
  const git = opts.git ?? defaultGitSpawn;
  const env = opts.env ?? process.env;
  const callerScope = opts.callerScope ?? (() => resolveCallerScope({ env }));
  const openDb = opts.openDb ?? ((p: string) => openDatabase(p, migrations));
  const closeDb = opts.closeDb ?? closeDatabase;
  const home = env.HOME ?? "/root";
  const cockpitPath = opts.cockpitPath ?? defaultCockpitConfigPath(home);

  // 1. Caller-scope gate. ADR-033 fail-secure: members can't spawn
  //    epic-teams — they'd race with the parent lead's coordination.
  if (callerScope() !== "driver") {
    throw new ConfigError({
      what: "spawn-epic: refused — caller scope is not 'driver'. Set ATMUX_CALLER_SCOPE=driver in the calling shell (ADR-033 §Caller-scope gate).",
      hint: "from a driver pane: ATMUX_CALLER_SCOPE=driver atmux team spawn-epic ...",
    });
  }

  // 2. Resolve parent via cockpit walk (raw read so we can mutate +
  //    write back later in step 8). Pre-ADR-089 cockpits carry flat
  //    `teams[]` instead of `sessions[]`; run the migrateLegacyShape
  //    shim so the verb works against either shape. The migrated
  //    object is what we mutate + write back in step 8, so post-spawn
  //    the on-disk cockpit.json lands fully on the new sessions[]
  //    shape (operators get a free migration as a side effect).
  const cockpitRaw = await readJson(cockpitPath, RawCockpitForMutation);
  const cockpitMigrated = migrateLegacyShape(
    cockpitRaw,
    cockpitPath,
    logger.warn,
  ) as typeof cockpitRaw;
  const parentEntry = findTeamSession(
    (cockpitMigrated.sessions as SessionEntry[] | undefined) ?? [],
    parsed.parentTeam,
  );
  if (parentEntry === null) {
    throw new ConfigError({
      what: `spawn-epic: parent team '${parsed.parentTeam}' not found in cockpit ${cockpitPath}`,
      hint: "register the parent in cockpit.json::sessions[] first",
    });
  }
  if (parentEntry.root === undefined || parentEntry.root.length === 0) {
    throw new ConfigError({
      what: `spawn-epic: parent team '${parsed.parentTeam}' has no 'root' in cockpit.json`,
      hint: "every team session entry must carry an absolute root path",
    });
  }
  const parentRoot = parentEntry.root;

  // 3. Compute paths.
  const epicsDir = `${parentRoot}-epics`;
  const epicRoot = join(epicsDir, parsed.epicId);
  // ADR-090 §Disk layout: branch = `<parentBase>-epic-<epicId>`.
  // The parent's current HEAD is the operator-declared default base;
  // --parent-base lets the operator pin a different one.
  const parentBase = parsed.parentBase ?? (await currentBranch(parentRoot, git));
  const epicBranch = `${parentBase}-epic-${parsed.epicId}`;

  // Refuse if the epic-team is already spawned (the worktree exists).
  // Operators who want to re-spawn must dissolve-epic first.
  if (await exists(epicRoot)) {
    throw new ConfigError({
      what: `spawn-epic: epic-team root already exists at ${epicRoot}`,
      hint: `dissolve-epic '${parsed.epicId}' first, OR remove the directory manually`,
    });
  }

  // 4. Resolve roster.
  const templatesDir = opts.templatesDir ?? defaultTemplatesDir();
  const rosterMembers = await resolveRosterMembers(parsed, templatesDir, cockpitPath);

  // 5. provisionWorktree. Side-effect tracker for rollback.
  await mkdir(epicsDir, { recursive: true });
  const provision = await provisionWorktree(parentRoot, parentBase, epicBranch, epicRoot, {
    git,
    initSubmodules: parsed.initSubmodules,
    warn: logger.warn,
  });
  let needsRollback = provision.created;

  try {
    // 6. Synthesize + write child team.json. Validate BEFORE write.
    const childTeam: TeamShape = Team.parse({
      name: parsed.epicId,
      members: rosterMembers,
      worktreeIsolation: false,
      worktreeInitSubmodules: parsed.initSubmodules,
      // Per ADR-089 §Pillar 1: child tmpdir nests under parent's
      // cage tmpdir at `/tmp/atmux-<parent>/epics/<epicId>/sock`.
      // The Team schema's `tmuxTmpdir` is the directory (atmux init's
      // pattern: `/tmp/atmux-tmux_<team>`); here we follow the
      // ADR-089 nesting convention literally.
      tmuxTmpdir: `/tmp/atmux-${parsed.parentTeam}/epics/${parsed.epicId}`,
      epicTeam: {
        parent: parsed.parentTeam,
        parentEpicKanbanId: parsed.parentEpicKanbanId ?? `e-${parsed.epicId}`,
        parentBase,
        mergeMode: parsed.mergeMode ?? "auto",
      },
    });
    const childAtmuxDir = join(epicRoot, ".atmux");
    await mkdir(childAtmuxDir, { recursive: true });
    await writeText(join(childAtmuxDir, "team.json"), `${JSON.stringify(childTeam, null, 2)}\n`);

    // 7. Init child state.db (creates file + runs migrations).
    const db = openDb(join(childAtmuxDir, "state.db"));
    closeDb(db);

    // 8. Register child in parent's cockpit sessions[]. Write the
    //    MIGRATED object back (not the raw read) so pre-ADR-089
    //    cockpits land on the new sessions[] shape post-spawn —
    //    `parentEntry` is a ref into `cockpitMigrated.sessions[]`
    //    so the mutation is visible through either handle.
    appendChildToSessions(parentEntry, parsed);
    await writeText(cockpitPath, `${JSON.stringify(cockpitMigrated, null, 2)}\n`);

    // 9. Success log + next-step hint.
    logger.log(
      `epic-team spawned: ${parsed.epicId} at ${epicRoot} (parent=${parsed.parentTeam}, branch=${epicBranch})`,
    );
    logger.log(
      "next: `atmux cockpit rebuild` to spawn the child cage (v1 — auto-spawn lands in a follow-up Task)",
    );
    needsRollback = false;
    return 0;
  } finally {
    if (needsRollback) {
      // Best-effort: tear down the worktree we created so the
      // operator's filesystem stays clean. Force-mode is safe here —
      // we authored the worktree this turn; no operator data lives
      // inside it.
      try {
        await pruneWorktree(parentRoot, epicRoot, {
          git,
          dirty: "force",
        });
        logger.warn(`spawn-epic: rolled back worktree at ${epicRoot} after a mid-pipeline failure`);
      } catch (e) {
        logger.warn(
          `spawn-epic: rollback failed for ${epicRoot}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
}

// ---------- Helpers ----------

function findTeamSession(sessions: ReadonlyArray<SessionEntry>, name: string): SessionEntry | null {
  for (const s of sessions) {
    if (s.type === "team" && s.name === name) return s;
    if (Array.isArray(s.sessions)) {
      const inner = findTeamSession(s.sessions, name);
      if (inner !== null) return inner;
    }
  }
  return null;
}

function appendChildToSessions(parentEntry: SessionEntry, parsed: ParsedSpawnEpicArgs): void {
  const child: SessionEntry = {
    type: "epic-team",
    name: parsed.epicId,
    parent: parsed.parentTeam,
    epicId: parsed.epicId,
  };
  if (parentEntry.sessions === undefined) parentEntry.sessions = [];
  // Refuse if already registered — pipeline already checked exists()
  // on the worktree path, but the cockpit registration is independent.
  const existing = parentEntry.sessions.find(
    (s) => s.type === "epic-team" && s.name === parsed.epicId,
  );
  if (existing !== undefined) {
    throw new ConfigError({
      what: `spawn-epic: cockpit already has epic-team '${parsed.epicId}' under parent '${parsed.parentTeam}'`,
      hint: "remove the entry manually if you intend to re-spawn",
    });
  }
  parentEntry.sessions.push(child);
}

async function currentBranch(repoPath: string, git: GitSpawn): Promise<string> {
  const r = await git(["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (r.exitCode !== 0) {
    throw new ConfigError({
      what: `spawn-epic: failed to read HEAD branch at ${repoPath} (exit ${r.exitCode})`,
      hint: r.stderr.trim() || "(no stderr)",
    });
  }
  return r.stdout.trim();
}

async function resolveRosterMembers(
  parsed: ParsedSpawnEpicArgs,
  templatesDir: string,
  cockpitPath: string,
): Promise<TeamShape["members"]> {
  // Schema for roster JSON — minimal shape, just `members: [...]`.
  // We parse the file directly without validating against the full
  // Team schema (the Team schema's superRefine fires later on the
  // synthesised team).
  const RosterShape = z
    .object({
      members: z.array(z.unknown()),
    })
    .passthrough();
  let path: string;
  if (parsed.rosterFile !== undefined) {
    path = parsed.rosterFile;
  } else {
    const preset = parsed.roster ?? "default";
    path = join(templatesDir, `${preset}.json`);
  }
  if (!(await exists(path))) {
    throw new ConfigError({
      what: `spawn-epic: roster file not found at ${path}`,
      hint: `cockpit=${cockpitPath} — verify the preset name or use --roster-file <abs-path>`,
    });
  }
  const raw = await readJson(path, RosterShape);
  // Cast through unknown — the Team schema validates each member
  // shape downstream when the full team object is parsed.
  return raw.members as TeamShape["members"];
}

function defaultTemplatesDir(): string {
  // Resolve relative to the source file at compile + runtime. atmux
  // ships templates/ next to src/ in the dev tree; the compiled
  // binary embeds the templates path via a different mechanism (not
  // relevant for this verb's typical cron-free operator invocation).
  // Falls back to process.cwd() + relative path if absolute resolve
  // fails — the dev-tree happy path covers `pnpm dev` / bun run.
  const cwd = process.cwd();
  return join(cwd, "templates", "epic-rosters");
}
