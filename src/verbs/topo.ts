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
import {
  aggregateTopo,
  type DiscoveryIO,
  gatherDiscovery,
  type TopoEpic,
  type TopoManifest,
  type TopoTeam,
} from "../core/topo-aggregate.ts";
import { UsageError } from "../errors.ts";
import { defaultDiscoveryIO } from "./topo-io.ts";

const USAGE = "atmux topo [--tree] [--orphans] [--json] [--team <name>] [--since <iso>]";

// ---------- Arg parsing ----------

export interface ParsedTopoArgs {
  tree: boolean;
  orphansOnly: boolean;
  json: boolean;
  team?: string;
  sinceIso?: string;
}

export function parseTopoArgs(argv: ReadonlyArray<string>): ParsedTopoArgs {
  let tree = false;
  let orphansOnly = false;
  let json = false;
  let team: string | undefined;
  let sinceIso: string | undefined;
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
    throw new UsageError({ what: `topo: unexpected arg: ${a}`, hint: USAGE });
  }
  const out: ParsedTopoArgs = { tree, orphansOnly, json };
  if (team !== undefined) out.team = team;
  if (sinceIso !== undefined) out.sinceIso = sinceIso;
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
}

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

  if (parsed.json) {
    logger.log(JSON.stringify(view, null, 2));
  } else if (parsed.tree) {
    logger.log(renderTree(view, parsed.orphansOnly));
  } else {
    logger.log(renderFlat(view, parsed.orphansOnly));
  }
  return 0;
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
