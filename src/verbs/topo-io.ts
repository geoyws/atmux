// ADR-222 §D1 — production {@link DiscoveryIO} factory + helpers.
//
// Wraps existing abstractions (tmux / crontab / sqlite / worktree /
// fs) into the shape `gatherDiscovery(io)` consumes. Per ADR-007 the
// only subprocess calls live in `src/abstractions/*`; this module
// composes those wrappers + adds the few inline fs walks (cage-
// socket enumeration, epic-team worktree walk, crontab marker block
// parse) that don't have a pre-existing helper.
//
// **Tested via dogfood, not unit tests.** Per CLAUDE.md "unit tests
// must NEVER touch real tmux/sqlite/git", the production IO
// factory's behaviour is exercised by the dogfood Tasks
// (t-beff7d62 / t-5fef18bb) against the real hax fleet. The verb's
// own logic (parseArgs / filters / renderers / orchestration) is
// 100% covered against a stubbed IO in
// `tests/integration/verbs/topo.test.ts`. Pure parse helpers
// (`parseCronMarkerBlocks`) are unit-tested here.

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultCrontabIO } from "../abstractions/crontab.ts";
import { exists } from "../abstractions/fs.ts";
import { closeDatabase, type Database, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { createTmux } from "../abstractions/tmux.ts";
import { defaultGitSpawn, type GitSpawn } from "../abstractions/worktree.ts";
import { loadCockpit, resolveCockpitConfigPath } from "../core/cockpit.ts";
import type {
  BranchOnParent,
  CronMarkerBlock,
  DiscoveryIO,
  KanbanEpicRow,
  KanbanProbe,
  TmuxSocketEntry,
  WorktreeOnDisk,
} from "../core/topo-aggregate.ts";

/** Production-default {@link DiscoveryIO}. Tests inject their own;
 *  this default is used by the top-level verb when no `opts.io` is
 *  provided. Per ADR-222 §D5 every fallible probe narrows to
 *  nullable on failure — no throw paths bubble up. */
export function defaultDiscoveryIO(): DiscoveryIO {
  const git: GitSpawn = defaultGitSpawn;
  const crontab = defaultCrontabIO();
  return {
    async readCockpit() {
      try {
        return await loadCockpit();
      } catch {
        return null;
      }
    },
    cockpitRegistryPath() {
      try {
        return resolveCockpitConfigPath();
      } catch {
        const home = process.env.HOME ?? homedir();
        return join(home, ".atmux", "cockpit.json");
      }
    },
    cockpitSocketPath() {
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      return `/tmp/.tmux-${uid}/atmux-cockpit`;
    },
    async cageAlive(socket) {
      try {
        const tx = createTmux({ socketPath: socket });
        return await tx.server.hasServer();
      } catch {
        return false;
      }
    },
    async readKanban(atmuxDir, opts) {
      return probeKanban(atmuxDir, opts.parent);
    },
    async gitCurrentBranch(worktreePath) {
      try {
        const r = await git(["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]);
        if (r.exitCode !== 0) return null;
        const trimmed = r.stdout.trim();
        return trimmed.length > 0 ? trimmed : null;
      } catch {
        return null;
      }
    },
    async gitLastCommitAt(worktreePath) {
      try {
        const r = await git(["-C", worktreePath, "log", "-1", "--format=%cI"]);
        if (r.exitCode !== 0) return null;
        const trimmed = r.stdout.trim();
        if (trimmed.length === 0) return null;
        const d = new Date(trimmed);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
      } catch {
        return null;
      }
    },
    async gitAheadCount(repoPath, base, branch) {
      try {
        const r = await git(["-C", repoPath, "rev-list", "--count", `${base}..${branch}`]);
        if (r.exitCode !== 0) return null;
        const n = Number.parseInt(r.stdout.trim(), 10);
        return Number.isFinite(n) ? n : null;
      } catch {
        return null;
      }
    },
    async gitMergedInto(repoPath, base, branch) {
      try {
        const r = await git(["-C", repoPath, "merge-base", "--is-ancestor", branch, base]);
        if (r.exitCode === 0) return true;
        if (r.exitCode === 1) return false;
        return null;
      } catch {
        return null;
      }
    },
    async listAliveCageSockets() {
      return listCageSocketsOnDisk();
    },
    async listCronMarkerBlocks() {
      const body = await crontab.read();
      if (body === null) return null;
      return parseCronMarkerBlocks(body);
    },
    async listEpicWorktreeDirs(parentRoot, parentName) {
      const epicsRoot = join(parentRoot, "..", "atmux-epics");
      try {
        const entries = await readdir(epicsRoot, { withFileTypes: true });
        const out: WorktreeOnDisk[] = [];
        for (const ent of entries) {
          if (!ent.isDirectory()) continue;
          if (!ent.name.startsWith("e-")) continue;
          out.push({ path: join(epicsRoot, ent.name), parent: parentName, eid: ent.name });
        }
        return out;
      } catch {
        return [];
      }
    },
    async listEpicBranches(repoPath, base, parentName) {
      try {
        const r = await git([
          "-C",
          repoPath,
          "for-each-ref",
          "--format=%(refname:short)",
          `refs/heads/${base}-epic-*`,
        ]);
        if (r.exitCode !== 0) return [];
        const out: BranchOnParent[] = [];
        for (const line of r.stdout.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          const eid = trimmed.slice(`${base}-epic-`.length);
          if (eid.length === 0) continue;
          out.push({ parent: parentName, branch: trimmed, eid });
        }
        return out;
      } catch {
        return [];
      }
    },
    async listKanbanEpicRows(atmuxDir) {
      return probeKanbanEpicRows(atmuxDir);
    },
    now() {
      return new Date();
    },
  };
}

// ---------- Helpers ----------

async function probeKanban(atmuxDir: string, parent: boolean): Promise<KanbanProbe | null> {
  const dbPath = join(atmuxDir, "state.db");
  if (!(await exists(dbPath))) return null;
  let db: Database | null = null;
  try {
    db = openDatabase(dbPath, migrations);
    const openRow = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks WHERE status != 'done'")
      .get();
    const doneRow = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks WHERE status = 'done'")
      .get();
    const maxRow = db
      .query<{ max_updated: number | null }, []>("SELECT MAX(updated_at) AS max_updated FROM tasks")
      .get();
    const lastIso =
      maxRow?.max_updated === null || maxRow?.max_updated === undefined
        ? null
        : new Date(maxRow.max_updated * 1000).toISOString();
    const out: KanbanProbe = {
      tasks_open: openRow?.n ?? 0,
      tasks_done: doneRow?.n ?? 0,
      last_activity: lastIso,
    };
    if (parent) {
      const epicRows = db.query<{ id: string }, []>("SELECT id FROM epics").all();
      out.epics = epicRows.length;
      out.epic_ids = epicRows.map((r) => r.id);
    }
    return out;
  } catch {
    return null;
  } finally {
    if (db !== null) {
      try {
        closeDatabase(db);
      } catch {
        // best-effort
      }
    }
  }
}

async function probeKanbanEpicRows(atmuxDir: string): Promise<KanbanEpicRow[] | null> {
  const dbPath = join(atmuxDir, "state.db");
  if (!(await exists(dbPath))) return null;
  let db: Database | null = null;
  try {
    db = openDatabase(dbPath, migrations);
    const rows = db
      .query<{ id: string; status: string | null }, []>("SELECT id, status FROM epics")
      .all();
    return rows.map((r) => ({ eid: r.id, status: r.status ?? "" }));
  } catch {
    return null;
  } finally {
    if (db !== null) {
      try {
        closeDatabase(db);
      } catch {
        // best-effort
      }
    }
  }
}

async function listCageSocketsOnDisk(): Promise<TmuxSocketEntry[]> {
  const out: TmuxSocketEntry[] = [];
  let topLevel: string[] = [];
  try {
    const ents = await readdir("/tmp", { withFileTypes: true });
    topLevel = ents
      .filter((e) => e.isDirectory() && e.name.startsWith("atmux-"))
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const dir of topLevel) {
    const parent = dir.slice("atmux-".length);
    const parentSocket = `/tmp/${dir}/sock`;
    if (await isLiveCageSocket(parentSocket)) {
      out.push({ socket: parentSocket, parent, eid: null });
    }
    const epicsDir = `/tmp/${dir}/epics`;
    if (await exists(epicsDir)) {
      try {
        const epicEnts = await readdir(epicsDir, { withFileTypes: true });
        for (const epic of epicEnts) {
          if (!epic.isDirectory()) continue;
          const epicSocket = `/tmp/${dir}/epics/${epic.name}/tmux-0/default`;
          if (await isLiveCageSocket(epicSocket)) {
            out.push({ socket: epicSocket, parent, eid: epic.name });
          }
        }
      } catch {
        // skip — directory unreadable
      }
    }
  }
  return out;
}

async function isLiveCageSocket(socketPath: string): Promise<boolean> {
  if (!(await exists(socketPath))) return false;
  try {
    const tx = createTmux({ socketPath });
    return await tx.server.hasServer();
  } catch {
    return false;
  }
}

/** Parse `crontab -l` body into marker-fenced atmux blocks. Each
 *  block emits one {@link CronMarkerBlock} with `atmux_dir_exists`
 *  pre-resolved via stat.
 *
 *  Pure-ish — only does fs stat for the per-block existence check.
 *  Exported for direct unit testing. */
export async function parseCronMarkerBlocks(body: string): Promise<CronMarkerBlock[]> {
  const blocks: CronMarkerBlock[] = [];
  const lines = body.split("\n");
  let currentRef: string | null = null;
  let currentAtmuxDir: string | null = null;
  for (const line of lines) {
    const startMatch = line.match(/^# >>> atmux:team=(\S+)/);
    if (startMatch !== null) {
      currentRef = `atmux:team=${startMatch[1]}`;
      currentAtmuxDir = null;
      continue;
    }
    const endMatch = line.match(/^# <<< atmux:team=(\S+)/);
    if (endMatch !== null && currentRef !== null) {
      if (currentAtmuxDir !== null) {
        const dirExists = await exists(currentAtmuxDir);
        blocks.push({
          ref: currentRef,
          atmux_dir: currentAtmuxDir,
          atmux_dir_exists: dirExists,
        });
      }
      currentRef = null;
      currentAtmuxDir = null;
      continue;
    }
    if (currentRef !== null) {
      const envMatch = line.match(/ATMUX_DIR=(\S+)/);
      if (envMatch !== null && currentAtmuxDir === null) {
        currentAtmuxDir = envMatch[1] ?? null;
      }
    }
  }
  return blocks;
}
