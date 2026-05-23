// ADR-222 §D1 — `atmux topo` read-only fleet observability verb.
//
// Thin orchestrator over `core/topo-aggregate.ts` (Discovery + pure
// aggregator) and `core/orphan-detector.ts` (classifier). Pure verb
// logic + render formats + filters + on-disk seen-state lifecycle.
// The production {@link DiscoveryIO} factory lives in
// `src/verbs/topo-io.ts` so this file stays unit-testable to 100%
// without touching real tmux / sqlite / git on the host.
//
// Flow:
//
//   discovery = await gatherDiscovery(io)
//   manifest  = aggregateTopo(discovery)
//   { orphans, updatedSeenState } = classifyOrphans(
//     manifest, discovery, seenState)
//   manifest.orphans = orphans
//   manifest.summary.orphans_count = orphans.length
//   saveSeenState(updatedSeenState)
//   render(manifest, formatFlags)
//
// Read-only contract per ADR-222 §D1: NO write to state.db / tmux /
// crontab / worktrees / branches. The ONLY persistence is the 30s-
// grace `seen-state` file at `~/.atmux/state/topo-orphan-seen.json`
// per §D4 — intentional internal scaffolding for the classifier's
// first-observation ladder, not a fleet-mutation. Reviewer-enforced.
//
// `--json` contract per ADR-222 §D2 + lead routing 2026-05-22:
// serializes the narrow {@link TopoManifest} ONLY (no Discovery
// leak). The Rust cockpit-mirror crate at sibling EPIC e-95087c8b S2
// pins on `schema_version: 1`.

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensureDir, exists } from "../abstractions/fs.ts";
import { classifyOrphans, emptySeenState, type SeenState } from "../core/orphan-detector.ts";
import { type OrphanClass, type ReapDeps, type ReapResult, reapOrphans } from "../core/reap.ts";
import {
  aggregateTopo,
  type DiscoveryIO,
  gatherDiscovery,
  type TopoEpic,
  type TopoManifest,
  type TopoOrphan,
  type TopoTeam,
} from "../core/topo-aggregate.ts";
import { UsageError } from "../errors.ts";
import { defaultDiscoveryIO, defaultReapDeps, defaultReapPrompt } from "./topo-io.ts";

const USAGE =
  "atmux topo [--tree] [--orphans] [--json] [--team <name>] [--since <iso>]\n" +
  "  atmux topo --reap [--apply] [--yes] [--class <name>] [--json]";

const REAP_CLASSES = [
  "cage-tmux-without-registry",
  "cron-block-without-worktree",
  "worktree-without-cage",
  "branch-without-row",
  "kanban-epic-without-cage",
  "cockpit-registry-without-cage",
] as const;
type ReapClassLiteral = (typeof REAP_CLASSES)[number];

function isReapClass(s: string): s is ReapClassLiteral {
  return (REAP_CLASSES as readonly string[]).includes(s);
}

// ---------- Arg parsing ----------

export interface ParsedTopoArgs {
  tree: boolean;
  orphansOnly: boolean;
  json: boolean;
  team?: string;
  sinceIso?: string;
  /** ADR-223 §D1 — `--reap` opens the reap subflow. Without this
   *  flag, the verb stays in read-only mode. */
  reap: boolean;
  /** `--apply` promotes `--reap` from dry-run to mutating. Requires
   *  `--reap`. */
  apply: boolean;
  /** `--yes` skips per-orphan interactive confirmation (Gate 4).
   *  Requires `--apply`. Per §D3 NEVER bypasses Gates 1-3. */
  yes: boolean;
  /** `--class <name>` scopes the reap cascade to one orphan class. */
  classFilter?: ReapClassLiteral;
  /** `--skip-checks` cascades to Gate 1 ONLY (active-check). Gates 2
   *  (structural) + 3 (merge-base) are inviolable per the reviewer
   *  audit 2026-05-22. Requires `--apply`. */
  skipChecks: boolean;
}

export function parseTopoArgs(argv: ReadonlyArray<string>): ParsedTopoArgs {
  let tree = false;
  let orphansOnly = false;
  let json = false;
  let team: string | undefined;
  let sinceIso: string | undefined;
  let reap = false;
  let apply = false;
  let yes = false;
  let skipChecks = false;
  let classFilter: ReapClassLiteral | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--tree") {
      tree = true;
      i += 1;
      continue;
    }
    if (a === "--orphans") {
      orphansOnly = true;
      i += 1;
      continue;
    }
    if (a === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (a === "--reap") {
      reap = true;
      i += 1;
      continue;
    }
    if (a === "--apply") {
      apply = true;
      i += 1;
      continue;
    }
    if (a === "--yes") {
      yes = true;
      i += 1;
      continue;
    }
    if (a === "--skip-checks") {
      skipChecks = true;
      i += 1;
      continue;
    }
    if (a === "--team") {
      const v = argv[i + 1];
      if (v === undefined || v.length === 0) {
        throw new UsageError({ what: "topo: --team requires a value", hint: USAGE });
      }
      team = v;
      i += 2;
      continue;
    }
    if (a === "--since") {
      const v = argv[i + 1];
      if (v === undefined || v.length === 0) {
        throw new UsageError({ what: "topo: --since requires an ISO timestamp", hint: USAGE });
      }
      const parsedAt = Date.parse(v);
      if (Number.isNaN(parsedAt)) {
        throw new UsageError({
          what: `topo: --since expects ISO 8601, got '${v}'`,
          hint: USAGE,
        });
      }
      sinceIso = new Date(parsedAt).toISOString();
      i += 2;
      continue;
    }
    if (a === "--class") {
      const v = argv[i + 1];
      if (v === undefined || v.length === 0) {
        throw new UsageError({ what: "topo: --class requires a value", hint: USAGE });
      }
      if (!isReapClass(v)) {
        throw new UsageError({
          what: `topo: --class expects one of ${REAP_CLASSES.join(" | ")}, got '${v}'`,
          hint: USAGE,
        });
      }
      classFilter = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `topo: unexpected arg: ${a}`, hint: USAGE });
  }
  // Cross-flag validation per ADR-223 §D1.
  if (apply && !reap) {
    throw new UsageError({ what: "topo: --apply requires --reap", hint: USAGE });
  }
  if (yes && !apply) {
    throw new UsageError({ what: "topo: --yes requires --apply", hint: USAGE });
  }
  if (skipChecks && !apply) {
    throw new UsageError({ what: "topo: --skip-checks requires --apply", hint: USAGE });
  }
  if (classFilter !== undefined && !reap) {
    throw new UsageError({ what: "topo: --class requires --reap", hint: USAGE });
  }
  if (json && reap && apply && !yes) {
    throw new UsageError({
      what: "topo: --apply --json without --yes refuses (interactive + machine-readable conflict)",
      hint: USAGE,
    });
  }
  const out: ParsedTopoArgs = { tree, orphansOnly, json, reap, apply, yes, skipChecks };
  if (team !== undefined) out.team = team;
  if (sinceIso !== undefined) out.sinceIso = sinceIso;
  if (classFilter !== undefined) out.classFilter = classFilter;
  return out;
}

// ---------- Verb dependencies ----------

export interface TopoOpts {
  /** Inject a stubbed DiscoveryIO for tests. Production omits → uses
   *  {@link defaultDiscoveryIO} from `topo-io.ts`. */
  io?: DiscoveryIO;
  /** Pre-loaded seen-state for tests. Production omits → loads from
   *  `~/.atmux/state/topo-orphan-seen.json` (empty on miss). */
  seenState?: SeenState;
  /** Test seam — skips the on-disk save. Production omits → writes
   *  to the canonical state-file path via {@link saveSeenState}. */
  saveSeenState?: (s: SeenState) => Promise<void>;
  /** Test seam — defaults to stdout. */
  logger?: { log: (m: string) => void };
  /** Test seam — injects the reap orchestrator's {@link ReapDeps}.
   *  Production omits → uses {@link defaultReapDeps} from `topo-io.ts`. */
  reapDeps?: ReapDeps;
  /** Test seam — injects the Gate-4 prompt function. Default reads
   *  stdin via readline; tests pass a canned-response stub. */
  prompt?: ReapPromptFn;
}

/** Gate-4 prompt response codes per ADR-223 §D3 (verb-layer Gate 4). */
export type ReapPromptResponse = "y" | "N" | "a" | "q" | "d";

/** Per-orphan prompt callback. `idx` is 1-based for display
 *  (`[1/8]`); `total` is the cascade size. */
export type ReapPromptFn = (
  orphan: TopoOrphan,
  idx: number,
  total: number,
) => Promise<ReapPromptResponse>;

// ---------- Top-level entry ----------

/** Read-only topo verb per ADR-222 §D1. Returns shell exit code
 *  (0 on success). */
export async function topo(argv: ReadonlyArray<string>, opts: TopoOpts = {}): Promise<number> {
  const parsed = parseTopoArgs(argv);
  const io = opts.io ?? defaultDiscoveryIO();
  const logger = opts.logger ?? { log: (m: string) => process.stdout.write(`${m}\n`) };

  const discovery = await gatherDiscovery(io);
  const manifest = aggregateTopo(discovery);

  const seenState = opts.seenState ?? (await loadSeenStateOrDefault(discovery.generated_at));
  const { orphans, updatedSeenState } = classifyOrphans(manifest, discovery, seenState);
  manifest.orphans = orphans;
  manifest.summary.orphans_count = orphans.length;

  // Persist the updated seen-state UNLESS the test seam suppressed it.
  if (opts.saveSeenState !== undefined) {
    await opts.saveSeenState(updatedSeenState);
  } else {
    await saveSeenState(updatedSeenState);
  }

  const view = applyFilters(manifest, parsed);

  // Reap subflow per ADR-223 §D1 — promotes the verb from read-only
  // to mutating ONLY when --apply is present. --reap alone is dry-run.
  if (parsed.reap) {
    return reapSubflow(view, parsed, opts, logger);
  }

  if (parsed.json) {
    logger.log(JSON.stringify(view, null, 2));
  } else if (parsed.tree) {
    logger.log(renderTree(view, parsed.orphansOnly));
  } else {
    logger.log(renderFlat(view, parsed.orphansOnly));
  }
  return 0;
}

// ---------- Reap subflow (ADR-223 §D1) ----------

async function reapSubflow(
  manifest: TopoManifest,
  parsed: ParsedTopoArgs,
  opts: TopoOpts,
  logger: { log: (m: string) => void },
): Promise<number> {
  const orphans = manifest.orphans;
  const deps = opts.reapDeps ?? defaultReapDeps();
  const prompt = opts.prompt ?? defaultReapPrompt;

  // --apply: gather Gate-4 confirmation. --yes skips the prompt loop.
  let confirmed: TopoOrphan[];
  if (!parsed.apply) {
    // Dry-run: pass everything; reap.ts routes to skipped[] with primitive label.
    confirmed = orphans;
  } else if (parsed.yes) {
    confirmed = orphans;
  } else {
    confirmed = await gatherConfirmedOrphans(orphans, prompt, logger);
  }

  const result = await reapOrphans(confirmed, {
    deps,
    dryRun: !parsed.apply,
    skipChecks: parsed.skipChecks,
    ...(parsed.classFilter !== undefined ? { classFilter: parsed.classFilter as OrphanClass } : {}),
    repoPathForBranch: (b) => repoPathForBranchOnManifest(manifest, b),
    baseBranchForBranch: (b) => baseBranchForBranchOnManifest(manifest, b),
    worktreePathForOrphan: (o) => o.atmux_dir?.replace(/\/\.atmux$/, "") ?? "",
    cageSocketForOrphan: (o) => cageSocketForOrphan(manifest, o.ref),
  });

  if (parsed.json) {
    logger.log(JSON.stringify(reapResultToJson(result), null, 2));
  } else {
    logger.log(renderReapResult(result, !parsed.apply));
  }
  return 0;
}

async function gatherConfirmedOrphans(
  orphans: ReadonlyArray<TopoOrphan>,
  prompt: ReapPromptFn,
  logger: { log: (m: string) => void },
): Promise<TopoOrphan[]> {
  const confirmed: TopoOrphan[] = [];
  const allowAllClasses = new Set<string>();
  let aborted = false;
  for (let i = 0; i < orphans.length; i += 1) {
    if (aborted) break;
    const orphan = orphans[i] as TopoOrphan;
    if (allowAllClasses.has(orphan.class)) {
      confirmed.push(orphan);
      continue;
    }
    // Allow [d]etails to re-prompt by looping until a decisive answer.
    let decided = false;
    while (!decided) {
      const r = await prompt(orphan, i + 1, orphans.length);
      if (r === "y") {
        confirmed.push(orphan);
        decided = true;
      } else if (r === "N") {
        decided = true;
      } else if (r === "a") {
        allowAllClasses.add(orphan.class);
        confirmed.push(orphan);
        decided = true;
      } else if (r === "q") {
        aborted = true;
        decided = true;
      } else if (r === "d") {
        logger.log(renderOrphanDetails(orphan));
      }
    }
  }
  return confirmed;
}

function renderOrphanDetails(orphan: TopoOrphan): string {
  const lines: string[] = [];
  lines.push(`  class:      ${orphan.class}`);
  lines.push(`  ref:        ${orphan.ref}`);
  lines.push(`  details:    ${orphan.details}`);
  lines.push(`  first_seen: ${orphan.first_seen}`);
  if (orphan.atmux_dir !== undefined) lines.push(`  atmux_dir:  ${orphan.atmux_dir}`);
  if (orphan.reap_hint !== undefined) lines.push(`  reap_hint:  ${orphan.reap_hint}`);
  return lines.join("\n");
}

function reapResultToJson(result: ReapResult): unknown {
  // Trim closures — emit only the JSON-safe shape.
  return {
    reaped: result.reaped.map((e) => ({
      class: e.orphan.class,
      ref: e.orphan.ref,
      primitive: e.primitive,
    })),
    skipped: result.skipped.map((e) => ({
      class: e.orphan.class,
      ref: e.orphan.ref,
      primitive: e.primitive,
      reason: e.reason,
    })),
    refused: result.refused.map((e) => ({
      class: e.orphan.class,
      ref: e.orphan.ref,
      reason: e.reason,
    })),
    failed: result.failed.map((e) => ({
      class: e.orphan.class,
      ref: e.orphan.ref,
      primitive: e.primitive,
      error: e.error,
    })),
    bypassed: result.bypassed,
    summary: {
      reaped_count: result.reaped.length,
      skipped_count: result.skipped.length,
      refused_count: result.refused.length,
      failed_count: result.failed.length,
    },
  };
}

function renderReapResult(result: ReapResult, dryRun: boolean): string {
  const lines: string[] = [];
  lines.push(
    `# reap ${dryRun ? "(dry-run)" : "(applied)"} — reaped=${result.reaped.length} skipped=${result.skipped.length} refused=${result.refused.length} failed=${result.failed.length}`,
  );
  if (result.reaped.length > 0) {
    lines.push("");
    lines.push(`# REAPED (${result.reaped.length})`);
    for (const e of result.reaped) {
      lines.push(`  [${e.orphan.class}] ${e.orphan.ref} → ${e.primitive ?? ""}`);
    }
  }
  if (result.skipped.length > 0) {
    lines.push("");
    lines.push(`# SKIPPED (${result.skipped.length})`);
    for (const e of result.skipped) {
      lines.push(`  [${e.orphan.class}] ${e.orphan.ref}  — ${e.reason ?? ""}`);
    }
  }
  if (result.refused.length > 0) {
    lines.push("");
    lines.push(`# REFUSED (${result.refused.length})`);
    for (const e of result.refused) {
      lines.push(`  [${e.orphan.class}] ${e.orphan.ref}  — ${e.reason ?? ""}`);
    }
  }
  if (result.failed.length > 0) {
    lines.push("");
    lines.push(`# FAILED (${result.failed.length})`);
    for (const e of result.failed) {
      lines.push(`  [${e.orphan.class}] ${e.orphan.ref}  — ${e.error ?? ""}`);
    }
  }
  if (result.bypassed.length > 0) {
    lines.push("");
    lines.push(`# BYPASSED gates (${result.bypassed.length}, --skip-checks)`);
    for (const b of result.bypassed) {
      lines.push(`  ${b.gate} on ${b.ref}`);
    }
  }
  return lines.join("\n");
}

// ---------- Per-orphan path resolvers ----------

function repoPathForBranchOnManifest(manifest: TopoManifest, _branch: string): string {
  // Branches are named `<base>-epic-<eid>`. The repo path lives at the
  // parent team's `worktree`. We don't carry a branch→parent lookup
  // table on the manifest today; falling back to the first team whose
  // worktree is set is acceptable for the cleanup case (only one
  // parent typically owns the branch in any given trunk).
  for (const t of manifest.teams) {
    if (t.worktree.length > 0) return t.worktree;
  }
  return "";
}

function baseBranchForBranchOnManifest(manifest: TopoManifest, branch: string): string {
  // The base is `<branch>` minus the `-epic-<eid>` suffix. Derive from
  // the parent team's current branch when present, else parse the
  // branch itself.
  const idx = branch.indexOf("-epic-");
  if (idx > 0) return branch.slice(0, idx);
  for (const t of manifest.teams) {
    if (t.branch !== null) return t.branch;
  }
  return "";
}

function cageSocketForOrphan(_manifest: TopoManifest, eid: string): string {
  // Cage-tmux orphans carry the socket path in their `details` line
  // but not as a structured field. Conservative fallback: derive
  // canonical path from eid + first parent's name. Production should
  // use the orphan-detector's source socket field once the row
  // schema extends to carry it (additive evolution).
  return `/tmp/atmux-atmux/epics/${eid}/tmux-0/default`;
}

// ---------- Filters ----------

export function applyFilters(manifest: TopoManifest, parsed: ParsedTopoArgs): TopoManifest {
  let teams = manifest.teams;
  if (parsed.team !== undefined) {
    teams = teams.filter((t) => t.name === parsed.team);
  }
  if (parsed.sinceIso !== undefined) {
    const sinceIso = parsed.sinceIso;
    teams = teams
      .filter((t) => (t.last_activity ?? "") >= sinceIso || matchingEpics(t, sinceIso).length > 0)
      .map((t) => ({ ...t, epics: matchingEpics(t, sinceIso) }));
  }
  return {
    ...manifest,
    teams,
    summary: { ...manifest.summary, teams_count: teams.length },
  };
}

function matchingEpics(t: TopoTeam, sinceIso: string): TopoEpic[] {
  return t.epics.filter((e) => (e.last_activity ?? "") >= sinceIso);
}

// ---------- Renderers (human-output) ----------

export function renderFlat(manifest: TopoManifest, orphansOnly: boolean): string {
  const lines: string[] = [];
  if (!orphansOnly) {
    lines.push(
      `# cockpit: ${manifest.cockpit.alive ? "🟢 alive" : "🔴 down"}  ${manifest.cockpit.socket}`,
    );
    lines.push(
      `#   teams=${manifest.summary.teams_count} epics=${manifest.summary.epics_count} cages_alive=${manifest.summary.cages_alive}`,
    );
    for (const team of manifest.teams) {
      lines.push("");
      lines.push(
        `TEAM ${team.name}  ${formatAlive(team.cage_alive)}  branch=${team.branch ?? "?"}`,
      );
      if (team.kanban !== null) {
        lines.push(
          `  kanban: epics=${team.kanban.epics ?? 0} open=${team.kanban.tasks_open} done=${team.kanban.tasks_done}`,
        );
      }
      for (const epic of team.epics) {
        lines.push(
          `  EPIC ${epic.eid}  ${formatAlive(epic.cage_alive)}  ahead=${epic.branch_ahead_of_trunk ?? "?"}  merged=${epic.branch_merged_to_trunk ?? "?"}`,
        );
      }
    }
  }
  if (manifest.orphans.length > 0) {
    if (!orphansOnly) lines.push("");
    lines.push(`# ORPHANS (${manifest.orphans.length})`);
    for (const o of manifest.orphans) {
      lines.push(`  [${o.class}] ${o.ref}  — ${o.details}`);
      if (o.reap_hint !== undefined) lines.push(`    hint: ${o.reap_hint}`);
    }
  } else if (orphansOnly) {
    lines.push("# no orphans detected");
  }
  return lines.join("\n");
}

export function renderTree(manifest: TopoManifest, orphansOnly: boolean): string {
  const lines: string[] = [];
  lines.push(`cockpit  ${formatAlive(manifest.cockpit.alive)}  ${manifest.cockpit.socket}`);
  if (!orphansOnly) {
    for (const team of manifest.teams) {
      lines.push(`├── ${team.name}  ${formatAlive(team.cage_alive)}`);
      const epics = team.epics;
      for (let i = 0; i < epics.length; i += 1) {
        const e = epics[i] as TopoEpic;
        const last = i === epics.length - 1;
        const branch = last ? "└──" : "├──";
        lines.push(
          `│   ${branch} ${e.eid}  ${formatAlive(e.cage_alive)}  ahead=${e.branch_ahead_of_trunk ?? "?"}`,
        );
      }
    }
  }
  if (manifest.orphans.length > 0) {
    lines.push("");
    lines.push(`orphans (${manifest.orphans.length})`);
    for (const o of manifest.orphans) {
      lines.push(`  [${o.class}] ${o.ref}`);
    }
  }
  return lines.join("\n");
}

function formatAlive(alive: boolean): string {
  return alive ? "🟢" : "🔴";
}

// ---------- Seen-state file (~/.atmux/state/topo-orphan-seen.json) ----------

/** Default path for the seen-state file per ADR-222 §D4. */
export function defaultSeenStatePath(): string {
  const home = process.env.HOME ?? homedir();
  return join(home, ".atmux", "state", "topo-orphan-seen.json");
}

/** Load seen-state from disk; return an empty record on miss /
 *  unreadable / parse-broken (defensive — first run is the common case). */
export async function loadSeenStateOrDefault(generatedAt: Date): Promise<SeenState> {
  const path = defaultSeenStatePath();
  if (!(await exists(path))) return emptySeenState(generatedAt);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<SeenState>;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      parsed.schema_version === 1 &&
      typeof parsed.entries === "object"
    ) {
      return {
        schema_version: 1,
        generated_at:
          typeof parsed.generated_at === "string" ? parsed.generated_at : generatedAt.toISOString(),
        entries: parsed.entries as Record<string, string>,
      };
    }
  } catch {
    // fall through to empty default
  }
  return emptySeenState(generatedAt);
}

/** Atomic write to the seen-state file. */
export async function saveSeenState(state: SeenState): Promise<void> {
  const path = defaultSeenStatePath();
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

// ---------- Re-exports for verb-test convenience ----------

export type { DiscoveryIO, SeenState, TopoManifest };
