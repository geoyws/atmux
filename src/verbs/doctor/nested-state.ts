// ADR-245 single-kanban invariant: nested `.atmux/` / stray `state.db`
// detector + confirm-gated remediation (t-a20da986, e-39 items 4/6/7).
//
// Two scans, both read-only:
//   (1) Upward — ancestor teams above the project root. A project whose
//       root sits beneath another team's tree (`<A>/.atmux` + `<A>/sub/…`
//       resolving its own `.atmux/`) is the on-disk shape of the
//       team-inside-team `detectTeamLocation` in src/verbs/init.ts
//       refuses at `init` time. The cockpit home (`~/.atmux`, which
//       carries `cockpit.json` but no `team.json`) never matches.
//   (2) Downward — stray state beneath the team's OWN `.atmux/`: nested
//       `.atmux/` dirs and `state.db` files other than the canonical
//       `<atmuxDir>/state.db`. The quarantine subtree
//       (`<atmuxDir>/archive/`, where remediation lands) never
//       self-flags, and worktree-stub dbs
//       (`<atmuxDir>/worktrees/<m>/.atmux/state.db`) stay owned by
//       `checkWorktreeNestedStateDb` (./git.ts) so one leaked db never
//       surfaces as two rows. A `worktrees/<m>/.atmux` stub WITHOUT a
//       db is the legal identity stub per ADR-245 — silent here.
//
// Detection is refusal-safe: `team === null` (checkTeam already
// surfaced the broken state) yields no rows, and remediation is
// read-only unless explicitly confirmed — without `confirm: true`
// (the `--fix-nested-state-db archive|delete` CLI flag) it returns a
// `refused` receipt without touching the filesystem. Paths outside
// the team's own `.atmux/` (ancestor teams found by the upward scan)
// are never moved or deleted by us — they land in `skipped` for the
// operator to resolve by hand.

import { readdir, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ensureDir, exists, removeRecursive } from "../../abstractions/fs.ts";
import { stateDbPath } from "../../core/common.ts";
import { defaultStderrWrite, type Writer } from "../../core/io.ts";
import type { Team } from "../../schema/team.ts";
import type { DoctorRow } from "./types.ts";

export type NestedStateOffenderKind = "nested-atmux-dir" | "stray-state-db";

export interface NestedStateOffender {
  kind: NestedStateOffenderKind;
  path: string;
}

export interface NestedStateDirEntry {
  name: string;
  isDirectory: boolean;
}

export interface NestedStateScanOpts {
  /** Readdir override (test injection). `null` simulates ENOENT. */
  readDir?: ((path: string) => Promise<ReadonlyArray<NestedStateDirEntry> | null>) | undefined;
  /** Existence override (test injection). Default `abstractions/fs::exists`. */
  existsPath?: ((path: string) => Promise<boolean>) | undefined;
}

export type CheckNestedStateDbOpts = NestedStateScanOpts;

/** Depth cap for the downward walk — `.atmux/` trees are shallow;
 *  the cap bounds pathological depth without hiding real nests. */
const MAX_SCAN_DEPTH = 8;

async function defaultReadDir(path: string): Promise<ReadonlyArray<NestedStateDirEntry> | null> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((e) => ({ name: String(e.name), isDirectory: e.isDirectory() }));
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function stripAtmuxSuffix(atmuxDir: string): string {
  return atmuxDir.replace(/\/?\.atmux\/?$/, "") || "/";
}

/** True when `full` is `root` itself or sits beneath it (pure path
 *  comparison — no filesystem access). */
function isWithinOrEqual(root: string, full: string): boolean {
  const rel = relative(root, full);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** True when `full` is exactly `<worktreesRoot>/<one-level>/.atmux/state.db`. */
function isWorktreeStubDb(worktreesRoot: string, full: string): boolean {
  const rel = relative(worktreesRoot, full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  const parts = rel.split(sep);
  return parts.length === 3 && parts[1] === ".atmux" && parts[2] === "state.db";
}

/** True when `full` is exactly `<worktreesRoot>/<one-level>/.atmux`. */
function isWorktreeStubDir(worktreesRoot: string, full: string): boolean {
  return dirname(dirname(full)) === worktreesRoot && basename(full) === ".atmux";
}

/**
 * Scan for nested `.atmux/` dirs (ancestor teams above the project
 * root + stray nests beneath our own `.atmux/`) and stray `state.db`
 * files. Read-only; every filesystem access goes through the
 * injectable `readDir` / `existsPath` seams.
 */
export async function findNestedStateOffenders(
  atmuxDir: string,
  opts: NestedStateScanOpts = {},
): Promise<NestedStateOffender[]> {
  const readDir = opts.readDir ?? defaultReadDir;
  const existsPath = opts.existsPath ?? exists;
  const offenders: NestedStateOffender[] = [];

  // (1) Upward: ancestor `.atmux/` dirs carrying a team.json.
  let cur = dirname(stripAtmuxSuffix(atmuxDir));
  while (true) {
    if (await existsPath(join(cur, ".atmux", "team.json"))) {
      offenders.push({ kind: "nested-atmux-dir", path: join(cur, ".atmux") });
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  // (2) Downward: bounded walk beneath our own `.atmux/`.
  const canonicalDb = stateDbPath(atmuxDir);
  const archiveRoot = join(atmuxDir, "archive");
  const worktreesRoot = join(atmuxDir, "worktrees");
  const stack: Array<{ dir: string; depth: number }> = [{ dir: atmuxDir, depth: 0 }];
  while (stack.length > 0) {
    // Non-empty by the loop guard, so pop is defined — named const (not
    // inline access) per the unchecked-cast discipline.
    const top = stack.pop() as { dir: string; depth: number };
    const entries = await readDir(top.dir);
    if (entries === null) continue;
    for (const entry of entries) {
      const full = join(top.dir, entry.name);
      if (entry.isDirectory) {
        if (isWithinOrEqual(archiveRoot, full)) continue;
        if (entry.name === ".atmux") {
          if (!isWorktreeStubDir(worktreesRoot, full)) {
            offenders.push({ kind: "nested-atmux-dir", path: full });
            continue;
          }
          if (top.depth + 1 < MAX_SCAN_DEPTH) stack.push({ dir: full, depth: top.depth + 1 });
          continue;
        }
        if (top.depth + 1 < MAX_SCAN_DEPTH) stack.push({ dir: full, depth: top.depth + 1 });
      } else if (
        entry.name === "state.db" &&
        full !== canonicalDb &&
        !isWithinOrEqual(archiveRoot, full) &&
        !isWorktreeStubDb(worktreesRoot, full)
      ) {
        offenders.push({ kind: "stray-state-db", path: full });
      }
    }
  }
  return offenders;
}

/** Banner naming every offender path — the row detail for the RED
 *  `nested-state-db` row and the `--fix-nested-state-db` preamble. */
export function formatNestedStateBanner(
  atmuxDir: string,
  offenders: ReadonlyArray<NestedStateOffender>,
): string {
  const lines = offenders.map((o) => `  - ${o.path} (${o.kind})`);
  return [
    `nested-state-db: ${offenders.length} offender(s) beneath ${atmuxDir}`,
    ...lines,
    "remediate only with an explicit confirm flag: `atmux doctor --fix-nested-state-db archive` (quarantine) or `atmux doctor --fix-nested-state-db delete` — read-only until then.",
  ].join("\n");
}

/** Pure row builder: one RED banner row naming every path, silent when clean. */
export function nestedStateDbRows(
  atmuxDir: string,
  offenders: ReadonlyArray<NestedStateOffender>,
): DoctorRow[] {
  if (offenders.length === 0) return [];
  return [
    {
      status: "red",
      label: "nested-state-db",
      detail: formatNestedStateBanner(atmuxDir, offenders),
      hint: `review every path above, then re-run with --fix-nested-state-db archive (quarantine under ${join(atmuxDir, "archive")}) or --fix-nested-state-db delete`,
    },
  ];
}

/**
 * Doctor probe — RED banner row per nested-`.atmux`/stray-`state.db`
 * scan hit. Returns [] when `team === null` (checkTeam already
 * surfaced the broken state). Read-only; remediation lives in
 * {@link remediateNestedStateDb} behind an explicit confirm.
 */
export async function checkNestedStateDb(
  team: Team | null,
  atmuxDir: string,
  opts: CheckNestedStateDbOpts = {},
): Promise<DoctorRow[]> {
  if (team === null) return [];
  return nestedStateDbRows(atmuxDir, await findNestedStateOffenders(atmuxDir, opts));
}

// ---------- Confirm-gated remediation ----------

export interface RemediateNestedStateDbOpts {
  /** What to do with owned offenders. No default — the caller names it. */
  mode: "archive" | "delete";
  /** MUST be true (the `--fix-nested-state-db` CLI flag). Any other
   *  value refuses without touching the filesystem. */
  confirm: boolean;
  ensureDir?: ((path: string) => Promise<void>) | undefined;
  movePath?: ((src: string, dest: string) => Promise<void>) | undefined;
  removePath?: ((path: string) => Promise<void>) | undefined;
}

export interface NestedStateRemediation {
  status: "done" | "refused";
  reason?: string;
  acted: Array<{ offender: NestedStateOffender; dest?: string }>;
  skipped: NestedStateOffender[];
}

/** Quarantine destination — flattened with `__` so ancestor-team
 *  paths (outside our `.atmux/`) still map somewhere if ever passed;
 *  remediation only archives owned paths, so the `..` arm documents
 *  the shape rather than firing. */
function archiveDest(atmuxDir: string, o: NestedStateOffender, index: number): string {
  const rel = relative(atmuxDir, o.path);
  const flat =
    rel.startsWith("..") || isAbsolute(rel) ? basename(o.path) : rel.split(sep).join("__");
  return join(atmuxDir, "archive", `nested-state-db-${o.kind}__${index}__${flat}`);
}

/**
 * Archive (quarantine under `<atmuxDir>/archive/`) or delete owned
 * offenders. Refusal-safe: `confirm !== true` refuses before any
 * filesystem access, and paths outside the team's own `.atmux/`
 * (ancestor teams — another team's property) are never moved or
 * deleted; they land in `skipped` for the operator to resolve by hand.
 */
export async function remediateNestedStateDb(
  atmuxDir: string,
  offenders: ReadonlyArray<NestedStateOffender>,
  opts: RemediateNestedStateDbOpts,
): Promise<NestedStateRemediation> {
  if (opts.confirm !== true) {
    return {
      status: "refused",
      reason:
        "refusing nested-state-db remediation without explicit confirm (re-run as `atmux doctor --fix-nested-state-db archive|delete`)",
      acted: [],
      skipped: [],
    };
  }
  const root = resolve(atmuxDir);
  const owned: NestedStateOffender[] = [];
  const skipped: NestedStateOffender[] = [];
  for (const o of offenders) {
    if (isWithinOrEqual(root, resolve(o.path))) owned.push(o);
    else skipped.push(o);
  }
  if (opts.mode === "archive") {
    const ensure = opts.ensureDir ?? ensureDir;
    const move = opts.movePath ?? rename;
    const acted: NestedStateRemediation["acted"] = [];
    let i = 0;
    for (const o of owned) {
      const dest = archiveDest(atmuxDir, o, i);
      await ensure(dirname(dest));
      await move(o.path, dest);
      acted.push({ offender: o, dest });
      i += 1;
    }
    return { status: "done", acted, skipped };
  }
  const remove = opts.removePath ?? removeRecursive;
  const acted: NestedStateRemediation["acted"] = [];
  for (const o of owned) {
    await remove(o.path);
    acted.push({ offender: o });
  }
  return { status: "done", acted, skipped };
}

// ---------- `--fix-nested-state-db` driver ----------

export interface FixNestedStateDbOpts extends NestedStateScanOpts {
  stderr?: Writer;
  ensureDir?: ((path: string) => Promise<void>) | undefined;
  movePath?: ((src: string, dest: string) => Promise<void>) | undefined;
  removePath?: ((path: string) => Promise<void>) | undefined;
  scan?:
    | ((atmuxDir: string, opts: NestedStateScanOpts) => Promise<NestedStateOffender[]>)
    | undefined;
  remediate?:
    | ((
        atmuxDir: string,
        offenders: ReadonlyArray<NestedStateOffender>,
        opts: RemediateNestedStateDbOpts,
      ) => Promise<NestedStateRemediation>)
    | undefined;
}

/**
 * `atmux doctor --fix-nested-state-db <archive|delete>` driver:
 * re-scan, print the banner naming every path, then remediate with
 * `confirm: true`. Skips (read-only) when no team loaded. All IO
 * injectable; production passes nothing.
 */
export async function runFixNestedStateDb(
  atmuxDir: string,
  team: Team | null,
  mode: "archive" | "delete",
  opts: FixNestedStateDbOpts = {},
): Promise<void> {
  const stderr = opts.stderr ?? defaultStderrWrite;
  if (team === null) {
    stderr(
      "atmux doctor --fix-nested-state-db: skipped (no team loaded; the checkTeam row above carries the failure)\n",
    );
    return;
  }
  const scan = opts.scan ?? findNestedStateOffenders;
  const remediate = opts.remediate ?? remediateNestedStateDb;
  const offenders = await scan(atmuxDir, { readDir: opts.readDir, existsPath: opts.existsPath });
  stderr(`${formatNestedStateBanner(atmuxDir, offenders)}\n`);
  const result = await remediate(atmuxDir, offenders, {
    mode,
    confirm: true,
    ensureDir: opts.ensureDir,
    movePath: opts.movePath,
    removePath: opts.removePath,
  });
  if (result.status === "refused") {
    stderr(`nested-state-db: refused — ${result.reason ?? "no reason given"}\n`);
    return;
  }
  for (const a of result.acted) {
    stderr(
      mode === "archive"
        ? `nested-state-db: archived ${a.offender.path} → ${a.dest ?? "(unknown dest)"}\n`
        : `nested-state-db: deleted ${a.offender.path}\n`,
    );
  }
  for (const s of result.skipped) {
    stderr(`nested-state-db: skipped (outside ${atmuxDir}, resolve by hand): ${s.path}\n`);
  }
}
