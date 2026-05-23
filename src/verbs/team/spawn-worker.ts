// ADR-221 §v2 — `spawn-worker` verb.
//
// `atmux team spawn-worker <task-id> --from <parentTeam>
//   [--roster <preset>]   (default: solo)
//   [--parent-base <branch>] [--no-init-submodules] [--force-spawn]`
//
// Thin wrapper around `spawn-epic` that codifies the worker-team
// convention from ADR-221:
//
//   1. The worker-team's `epicId` is derived from a task-id: any of
//      `t-<tail>`, `<tail>`, or `w-<tail>` normalises to `w-<tail>`.
//   2. A wrapper kanban EPIC row is auto-created in the parent team's
//      state.db so `dissolve-worker` (or `dissolve-epic`) has a real
//      row to mark done at teardown time.
//   3. Roster defaults to `solo` (per ADR-221 §v1 §Decision) instead
//      of the heavier `default` (7-member) preset that `spawn-epic`
//      assumes.
//
// Pipeline:
//
//   1. Parse args; normalise the worker-id from the task-id positional.
//   2. Resolve the parent team's `.atmux/` (cockpit-lookup by --from).
//   3. Create the wrapper kanban EPIC via `addEpic` — title carries
//      the task-id for forensic traceability; `driverRef` pins the
//      origin task-id for downstream tooling.
//   4. Synthesize the spawn-epic argv (worker-id, --roster=solo by
//      default, --parent-epic-kanban-id = newly-created epic id, plus
//      any pass-through flags) and delegate to `spawnEpic`.
//
// Carve-out: this verb does NOT roll back the wrapper kanban EPIC if
// `spawnEpic` fails mid-pipeline. The row is small + harmless; the
// operator can `atmux epic advance <id> --to wontfix` if needed.
// Aligning with spawn-epic's own "partial state on failure" philosophy
// (it leaves the cockpit-mutate step un-rolled-back too).
//
// Auto-dissolve on `task.done` — explicitly NOT in this verb. ADR-221
// §v2 §Carve-outs delegates that to EPIC e-a946af69 Phase 4 (orchd
// lifecycle); this verb only handles spawn.

import { join } from "node:path";
import { z } from "zod";
import { readJson } from "../../abstractions/json.ts";
import { defaultCockpitConfigPath } from "../../core/cockpit.ts";
import { resolveCallerScope } from "../../core/common.ts";
import { addEpic } from "../../core/epic.ts";
import { ConfigError, UsageError } from "../../errors.ts";
import { type SpawnEpicOpts, spawnEpic } from "./spawn-epic.ts";

const USAGE =
  "atmux team spawn-worker <task-id> --from <parentTeam>\n" +
  "  [--roster <preset>]                       (default: solo)\n" +
  "  [--parent-base <branch>] [--no-init-submodules] [--force-spawn]";

// ---------- Arg parsing ----------

export interface ParsedSpawnWorkerArgs {
  /** Raw task-id positional as the operator typed it. */
  taskId: string;
  parentTeam: string;
  /** Roster preset; defaults to `solo` per ADR-221. */
  roster: string;
  parentBase?: string;
  initSubmodules: boolean;
  forceSpawn: boolean;
}

export function parseSpawnWorkerArgs(argv: ReadonlyArray<string>): ParsedSpawnWorkerArgs {
  let taskId: string | undefined;
  let parentTeam: string | undefined;
  let roster: string | undefined;
  let parentBase: string | undefined;
  let initSubmodules = true;
  let forceSpawn = false;
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
    if (a === "--parent-base") {
      parentBase = requireValue(argv, i, "--parent-base");
      i += 2;
      continue;
    }
    if (a === "--no-init-submodules") {
      initSubmodules = false;
      i += 1;
      continue;
    }
    if (a === "--force-spawn") {
      forceSpawn = true;
      i += 1;
      continue;
    }
    if (a?.startsWith("-") === true) {
      throw new UsageError({
        what: `spawn-worker: unknown flag: ${a}`,
        hint: USAGE,
      });
    }
    if (taskId === undefined) {
      taskId = a;
      i += 1;
      continue;
    }
    throw new UsageError({
      what: `spawn-worker: unexpected positional: ${a}`,
      hint: USAGE,
    });
  }
  if (taskId === undefined || taskId.length === 0) {
    throw new UsageError({
      what: "spawn-worker: <task-id> required",
      hint: USAGE,
    });
  }
  if (parentTeam === undefined || parentTeam.length === 0) {
    throw new UsageError({
      what: "spawn-worker: --from <parentTeam> required",
      hint: USAGE,
    });
  }
  const out: ParsedSpawnWorkerArgs = {
    taskId,
    parentTeam,
    roster: roster ?? "solo",
    initSubmodules,
    forceSpawn,
  };
  if (parentBase !== undefined) out.parentBase = parentBase;
  return out;
}

function requireValue(argv: ReadonlyArray<string>, i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined || v === "") {
    throw new UsageError({
      what: `spawn-worker: ${flag} requires a value`,
      hint: USAGE,
    });
  }
  return v;
}

// ---------- Worker-id normalisation ----------

/**
 * Normalise a task-id-shaped input into a canonical worker-id (`w-<tail>`).
 *
 *   - `t-abc123` → `w-abc123`  (strip task prefix, swap)
 *   - `w-abc123` → `w-abc123`  (already canonical — pass through)
 *   - `abc123`   → `w-abc123`  (bare id — prefix `w-`)
 *
 * Refuses empty / whitespace-only input. Caller still validates the
 * tail's character set downstream via the Team schema's name field.
 */
export function normaliseWorkerId(taskId: string): string {
  const trimmed = taskId.trim();
  if (trimmed.length === 0) {
    throw new UsageError({
      what: "spawn-worker: <task-id> cannot be empty",
      hint: USAGE,
    });
  }
  if (trimmed.startsWith("w-")) return trimmed;
  if (trimmed.startsWith("t-")) return `w-${trimmed.slice(2)}`;
  return `w-${trimmed}`;
}

// ---------- Verb dependencies ----------

export interface SpawnWorkerOpts extends SpawnEpicOpts {
  /** Test-injection seam for the wrapper-epic creation step. Defaults to
   *  the real `addEpic` from `src/core/epic.ts`. */
  addEpic?: (
    atmuxDir: string,
    opts: { title: string; body?: string; driverRef?: string },
  ) => Promise<string>;
}

// ---------- Cockpit shape (minimal) ----------

const RawCockpitForLookup = z
  .object({
    sessions: z.array(z.unknown()).optional(),
  })
  .passthrough();

interface SessionEntry {
  type?: string;
  name?: string;
  root?: string;
  sessions?: SessionEntry[];
}

function findTeamRoot(sessions: ReadonlyArray<SessionEntry>, name: string): string | null {
  for (const s of sessions) {
    if (s.type === "team" && s.name === name) return s.root ?? null;
    if (Array.isArray(s.sessions)) {
      const inner = findTeamRoot(s.sessions, name);
      if (inner !== null) return inner;
    }
  }
  return null;
}

// ---------- Top-level dispatch ----------

export async function spawnWorker(
  argv: ReadonlyArray<string>,
  opts: SpawnWorkerOpts = {},
): Promise<number> {
  const parsed = parseSpawnWorkerArgs(argv);
  const env = opts.env ?? process.env;
  const callerScope = opts.callerScope ?? (() => resolveCallerScope({ env }));
  const home = env.HOME ?? "/root";
  const cockpitPath = opts.cockpitPath ?? defaultCockpitConfigPath(home);
  const epicCreator = opts.addEpic ?? addEpic;

  // 1. Caller-scope gate. ADR-033: workers are driver-scope-only,
  //    same as spawn-epic. Refuse here BEFORE the wrapper-epic write
  //    so members can't accidentally pollute the parent kanban with
  //    half-formed worker rows.
  if (callerScope() !== "driver") {
    throw new ConfigError({
      what: "spawn-worker: refused — caller scope is not 'driver'. Set ATMUX_CALLER_SCOPE=driver in the calling shell (ADR-033 §Caller-scope gate).",
      hint: "from a driver pane: ATMUX_CALLER_SCOPE=driver atmux team spawn-worker ...",
    });
  }

  const workerId = normaliseWorkerId(parsed.taskId);

  // 2. Resolve parent root from the cockpit. We need this to write
  //    the wrapper kanban EPIC into the parent's state.db. spawn-epic
  //    re-resolves the cockpit again downstream — that double read is
  //    intentional: we only need parentRoot here for the epic-add, and
  //    spawn-epic's own resolution includes the host-pressure + soft-
  //    warn gates that depend on the freshly-read cockpit.
  const cockpitRaw = await readJson(cockpitPath, RawCockpitForLookup);
  const parentRoot = findTeamRoot(
    (cockpitRaw.sessions as SessionEntry[] | undefined) ?? [],
    parsed.parentTeam,
  );
  if (parentRoot === null) {
    throw new ConfigError({
      what: `spawn-worker: parent team '${parsed.parentTeam}' not found in cockpit ${cockpitPath}`,
      hint: "register the parent in cockpit.json::sessions[] first (typically via `atmux start`)",
    });
  }

  // 3. Create the wrapper kanban EPIC in the parent. addEpic returns the
  //    generated `e-XXXXXXXX` id which becomes the worker's parentEpicKanbanId
  //    — so dissolve-worker / dissolve-epic later mark THIS row done at
  //    teardown rather than synthesizing `e-w-<tail>` which doesn't exist.
  const parentAtmuxDir = join(parentRoot, ".atmux");
  const wrapperEpicId = await epicCreator(parentAtmuxDir, {
    title: `worker: ${parsed.taskId}`,
    driverRef: parsed.taskId,
  });

  // 4. Synthesize spawn-epic argv + delegate. Roster defaults to `solo`
  //    per ADR-221 §Decision (small task, no need for the heavier
  //    default 7-member preset). Operator can override via --roster.
  const epicArgv: string[] = [
    workerId,
    "--from",
    parsed.parentTeam,
    "--roster",
    parsed.roster,
    "--parent-epic-kanban-id",
    wrapperEpicId,
  ];
  if (parsed.parentBase !== undefined) {
    epicArgv.push("--parent-base", parsed.parentBase);
  }
  if (!parsed.initSubmodules) {
    epicArgv.push("--no-init-submodules");
  }
  if (parsed.forceSpawn) {
    epicArgv.push("--force-spawn");
  }
  return await spawnEpic(epicArgv, opts);
}
