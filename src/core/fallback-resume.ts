// ADR-058 §D5 + §D6: budget-resume continuity brief composer.
//
// On budget-resume tick (called from src/verbs/whip.ts when the resume
// gate fires; T4 wires the call site), this module:
//
//   1. Walks per-lane cage handles registered during pause-entry.
//   2. For each lane: reads the per-tier handoff log
//      (.atmux/tier<N>-handoff/<lane>.log — append-mode with cycle
//      markers per ADR-058 §OQ2).
//   3. For Tier 2: extracts SHAs that landed during cage execution.
//      For Tier 3+: enumerates files modified inside the cage (via
//      a read-only diff) and embeds a pointer to the operator-manual
//      reconcile script.
//   4. Composes a continuity brief for the original Claude member
//      that summarises fallback-tier work + reconciliation status.
//   5. Pastes the brief via the caller-supplied `sendFn` — verb-layer
//      wires this through the existing safe-send gate per ADR-057 D1
//      once it lands; falls through to direct `atmux send` for now.
//   6. Triggers destroyFallbackCage(handle) for each lane — archives
//      + tears down per ADR-058 §OQ3.
//
// This module is pure-orchestration: all IO routes through injected
// abstractions (spawnFn / readFn / sendFn / destroyFn) so the test
// suite can mock without bringing the whole sudo + tmux stack.

import { join } from "node:path";
import { readTextOrNull } from "../abstractions/fs.ts";
import {
  destroyFallbackCage as defaultDestroyFallbackCage,
  type CageHandle,
  type DestroyFallbackCageOpts,
  type FallbackTier,
} from "../abstractions/fallback-cage.ts";
import {
  spawn as defaultSpawn,
  type SpawnOpts,
  type SpawnResult,
} from "../abstractions/spawn.ts";

// ---------- Path helpers ----------

/** Per-tier handoff dir: `<atmuxDir>/tier<N>-handoff/`. Parent of all
 *  per-lane log files for that tier. */
export function tierHandoffDir(atmuxDir: string, tier: FallbackTier): string {
  return join(atmuxDir, `tier${tier}-handoff`);
}

/** Per-lane handoff log path: `<atmuxDir>/tier<N>-handoff/<lane>.log`.
 *  Append-mode per ADR-058 §OQ2 (each cage execution cycle prepends a
 *  `=== cycle <epoch> ===` header). */
export function tierHandoffLogPath(
  atmuxDir: string,
  tier: FallbackTier,
  lane: string,
): string {
  return join(tierHandoffDir(atmuxDir, tier), `${lane}.log`);
}

/** Build the cycle-marker header line a cage-execution caller should
 *  prepend before appending the cycle's stdout. Exposed here so T4's
 *  dispatch path emits the same shape this module reads back. */
export function cycleHeader(epochSec: number): string {
  return `=== cycle ${epochSec} ===\n`;
}

// ---------- Cycle parsing (pure) ----------

const CYCLE_HEADER_RE = /^=== cycle (\d+) ===\s*$/;

export interface CycleBlock {
  epochSec: number;
  body: string;
}

/** Parse a handoff log into per-cycle blocks. Lines preceding the first
 *  cycle marker are silently dropped (legacy entries). Returns an empty
 *  array when the log has no cycle markers (or is empty / null). */
export function parseCycleBlocks(log: string | null | undefined): CycleBlock[] {
  if (!log) return [];
  const lines = log.split("\n");
  const blocks: CycleBlock[] = [];
  let current: CycleBlock | null = null;
  for (const line of lines) {
    const m = CYCLE_HEADER_RE.exec(line);
    if (m) {
      if (current !== null) blocks.push(current);
      current = { epochSec: Number(m[1]), body: "" };
    } else if (current !== null) {
      current.body += current.body.length === 0 ? line : `\n${line}`;
    }
  }
  if (current !== null) blocks.push(current);
  // Strip a single trailing newline-only artefact from each block's
  // body — the source log always has a trailing newline before the
  // next header.
  for (const b of blocks) b.body = b.body.replace(/\n$/, "");
  return blocks;
}

/** Return the most-recent cycle block by epoch (stable: ties yield
 *  the LAST occurrence since cycle blocks are append-ordered). */
export function latestCycleBlock(log: string | null | undefined): CycleBlock | null {
  const blocks = parseCycleBlocks(log);
  if (blocks.length === 0) return null;
  let best = blocks[0]!;
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.epochSec >= best.epochSec) best = b;
  }
  return best;
}

// ---------- SHA extraction (Tier 2) ----------

// Conservative SHA matcher: 7-40 hex digits at a word boundary,
// optionally preceded by `[<member>] t-xxx commit` (the exact
// commit-ping shape from the brief at .claude/teams/.../briefs)
// or any "commit <sha>" prefix git emits.
const SHA_RE = /\b(?:commit\s+)?([0-9a-f]{7,40})\b/g;

/** Extract candidate commit SHAs from a Tier 2 cage execution log.
 *  Greedy on prefixes that look git-emitted ("commit <sha>") and on
 *  bare SHA-shaped tokens. Caller dedupes and surfaces in the brief. */
export function extractShasFromCageLog(log: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Reset regex state per call — module-level RegExp w/ /g.
  SHA_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SHA_RE.exec(log)) !== null) {
    const sha = m[1]!;
    // Filter out "decimal-only" matches — the regex already enforces
    // hex, but a 7-digit decimal like "1778131" would match. Require at
    // least one a-f character to bias toward real SHAs.
    if (!/[a-f]/.test(sha)) continue;
    if (seen.has(sha)) continue;
    seen.add(sha);
    out.push(sha);
  }
  return out;
}

// ---------- Cage delta enumeration (Tier 3+, async) ----------

const CAGE_CONTEXT_FILES = new Set<string>(["_history.log", "_status.log", "_branch.log"]);

export interface CageDelta {
  kind: "added" | "modified" | "deleted";
  relpath: string;
}

export interface EnumerateCageDeltasOpts {
  /** Cage workspace root — handle.workDir. */
  cageDir: string;
  /** Project worktree root the cage was rsync'd from. */
  projectCwd: string;
  /** The agent UID to invoke `sudo -u <agent> diff` under. */
  agent: string;
  /** Spawn override; defaults to abstractions/spawn.ts spawn(). */
  spawnFn?: (opts: SpawnOpts) => Promise<SpawnResult>;
}

/** Enumerate file-level deltas between cage workspace and project
 *  worktree. Read-only (uses `diff -rq` only). The actual reconcile
 *  is a separate operator-manual step (scripts/fallback-reconcile.sh).
 *  Cage-context files (_history.log etc.) are filtered. */
export async function enumerateCageDeltas(
  opts: EnumerateCageDeltasOpts,
): Promise<CageDelta[]> {
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const r = await spawnFn({
    cmd: "sudo",
    argv: ["-u", opts.agent, "diff", "-rq", opts.cageDir, opts.projectCwd],
    timeoutMs: 60_000,
    // diff exits 1 when there are differences; treat 0 + 1 as success.
    expectExitCode: "any",
  });
  // diff with rc >= 2 means a real failure (file-not-found etc.).
  if (r.exitCode > 1) {
    throw new Error(
      `diff -rq failed (rc=${r.exitCode}) for cageDir=${opts.cageDir}: ${r.stderr.trim()}`,
    );
  }
  return parseDiffRqOutput(r.stdout, opts.cageDir, opts.projectCwd);
}

/** Pure parser for `diff -rq <cage> <project>` stdout. Exposed for
 *  unit-testing without spawning a real diff. */
export function parseDiffRqOutput(
  stdout: string,
  cageDir: string,
  projectCwd: string,
): CageDelta[] {
  const out: CageDelta[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let delta: CageDelta | null = null;
    if (line.startsWith(`Only in ${cageDir}`)) {
      const rel = parseOnlyInLine(line, cageDir);
      if (rel !== null) delta = { kind: "added", relpath: rel };
    } else if (line.startsWith(`Only in ${projectCwd}`)) {
      const rel = parseOnlyInLine(line, projectCwd);
      if (rel !== null) delta = { kind: "deleted", relpath: rel };
    } else if (line.startsWith(`Files ${cageDir}/`)) {
      // "Files <cage>/path and <project>/path differ"
      const stripped = line.slice(`Files ${cageDir}/`.length);
      const idx = stripped.indexOf(" and ");
      if (idx >= 0) {
        const relpath = stripped.slice(0, idx);
        delta = { kind: "modified", relpath };
      }
    }
    if (delta === null) continue;
    if (CAGE_CONTEXT_FILES.has(delta.relpath)) continue;
    out.push(delta);
  }
  return out;
}

function parseOnlyInLine(line: string, prefix: string): string | null {
  // Format: "Only in <prefix>: filename"   (file at prefix root)
  //     OR: "Only in <prefix>/sub: filename" (file in subdir of prefix)
  const rest = line.slice(`Only in ${prefix}`.length);
  // rest is either ": file" or "/sub: file"
  const colonIdx = rest.indexOf(": ");
  if (colonIdx < 0) return null;
  const subRaw = rest.slice(0, colonIdx);
  const fname = rest.slice(colonIdx + 2);
  const sub = subRaw.startsWith("/") ? subRaw.slice(1) : subRaw;
  return sub.length === 0 ? fname : `${sub}/${fname}`;
}

// ---------- Lane summary ----------

export type ReconcileStatus = "n/a" | "pending" | "reconciled" | "archived";

export interface LaneSummary {
  /** The cage handle this summary was built from — kept attached so
   *  the orchestrator can pass it to destroyFn without re-lookup. */
  handle: CageHandle;
  /** Most-recent cycle epoch parsed from the handoff log; null when
   *  no cycle markers were found. */
  lastCycleEpochSec: number | null;
  /** Body of the most-recent cycle (raw stdout the cage emitted). */
  cageOutput: string;
  /** Tier 2: candidate commit SHAs. Empty for Tier 3+. */
  tier2Shas: ReadonlyArray<string>;
  /** Tier 3+: file-level deltas the operator must reconcile. Empty for
   *  Tier 2. */
  tier3Deltas: ReadonlyArray<CageDelta>;
  /** Per-tier reconcile state. Tier 2 → "n/a"; Tier 3+ → "pending"
   *  unless the orchestrator overrides post-reconcile (future). */
  reconcileStatus: ReconcileStatus;
}

export interface BuildLaneSummaryOpts {
  atmuxDir: string;
  /** Project worktree root, needed for Tier 3+ delta enumeration. The
   *  caller (T4 verb wiring) has it in scope from the same source the
   *  cage builder used at create time. */
  projectCwd: string;
  readFn?: (path: string) => Promise<string | null>;
  spawnFn?: (opts: SpawnOpts) => Promise<SpawnResult>;
}

/** Build a per-lane summary by reading the handoff log + (Tier 3+)
 *  enumerating workspace deltas. Pure-async — no sends, no destroys. */
export async function buildLaneSummary(
  handle: CageHandle,
  opts: BuildLaneSummaryOpts,
): Promise<LaneSummary> {
  const readFn = opts.readFn ?? readTextOrNull;
  const logPath = tierHandoffLogPath(opts.atmuxDir, handle.tier, handle.lane);
  const log = await readFn(logPath);
  const latest = latestCycleBlock(log);
  const cageOutput = latest?.body ?? "";

  if (handle.tier === 2) {
    return {
      handle,
      lastCycleEpochSec: latest?.epochSec ?? null,
      cageOutput,
      tier2Shas: extractShasFromCageLog(cageOutput),
      tier3Deltas: [],
      reconcileStatus: "n/a",
    };
  }

  // Tier 3+
  const deltaOpts: EnumerateCageDeltasOpts = {
    cageDir: handle.workDir,
    projectCwd: opts.projectCwd,
    agent: handle.agent,
    ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
  };
  const deltas = await enumerateCageDeltas(deltaOpts);
  return {
    handle,
    lastCycleEpochSec: latest?.epochSec ?? null,
    cageOutput,
    tier2Shas: [],
    tier3Deltas: deltas,
    reconcileStatus: deltas.length === 0 ? "reconciled" : "pending",
  };
}

// ---------- Brief composer (pure) ----------

/** Compose the continuity brief paragraph(s) for a single lane. Pure;
 *  unit-testable without spawning anything. The orchestrator concats
 *  per-lane briefs + a header into the message it pastes via sendFn. */
export function composeContinuityBrief(summary: LaneSummary): string {
  const h = summary.handle;
  const tierLabel = `Tier ${h.tier}`;
  const lines: string[] = [
    `# Continuity brief — fallback work landed for \`${h.lane}\``,
    ``,
    `While Claude budget was paused, ${tierLabel} (${h.agent}) executed`,
    `Task \`${h.taskId}\` in your stead. Summary follows.`,
    ``,
  ];

  if (h.tier === 2) {
    lines.push(`## Tier 2 result (operator-UID cage)`, ``);
    if (summary.tier2Shas.length === 0) {
      lines.push(
        `- Cage workspace: \`${h.workDir}\``,
        `- No commit SHAs detected in cage output.`,
        `- Inspect \`git log\` directly for any work that landed.`,
      );
    } else {
      lines.push(`- Candidate SHAs (parsed from cage stdout):`);
      for (const sha of summary.tier2Shas.slice(0, 20)) {
        lines.push(`    - \`${sha}\``);
      }
      lines.push(`- Verify with: \`git log --oneline ${summary.tier2Shas[0]}^..HEAD\``);
    }
    lines.push(``, `## Reconciliation`, ``, `- Tier 2 work is on the working branch — no manual reconcile needed.`);
  } else {
    lines.push(`## ${tierLabel} result (kernel-isolated cage)`, ``);
    lines.push(`- Cage workspace: \`${h.workDir}\` (NOT integrated yet — operator-manual reconcile)`);
    if (summary.tier3Deltas.length === 0) {
      lines.push(`- No file-level deltas detected vs. project worktree.`);
    } else {
      lines.push(`- Files modified in cage (${summary.tier3Deltas.length} delta(s)):`);
      for (const d of summary.tier3Deltas.slice(0, 30)) {
        lines.push(`    - [${d.kind.toUpperCase()}] \`${d.relpath}\``);
      }
      if (summary.tier3Deltas.length > 30) {
        lines.push(`    - ... +${summary.tier3Deltas.length - 30} more`);
      }
    }
    lines.push(
      ``,
      `## Reconciliation — status: \`${summary.reconcileStatus}\``,
      ``,
      `- Run: \`scripts/fallback-reconcile.sh ${h.team} ${h.lane}\``,
      `- Diffs cage vs. project, prompts you per delta (y/n/d/q),`,
      `  rsyncs accepted deltas into the worktree as your UID.`,
      `- After reconcile, commits go through Tier 1/2 (your normal flow).`,
    );
  }

  if (summary.cageOutput.trim().length > 0) {
    const trimmed = summary.cageOutput.length > 2000
      ? `${summary.cageOutput.slice(0, 2000)}\n... [truncated; full log at the path below]`
      : summary.cageOutput;
    lines.push(
      ``,
      `## Cage output (latest cycle)`,
      ``,
      "```",
      trimmed,
      "```",
    );
  }

  lines.push(``);
  return lines.join("\n");
}

/** Compose a multi-lane brief (header + per-lane sections). Pure. */
export function composeMultiLaneBrief(
  summaries: ReadonlyArray<LaneSummary>,
  opts?: { headerLine?: string },
): string {
  if (summaries.length === 0) return "";
  const header = opts?.headerLine ?? "# Budget pause resumed — fallback continuity";
  const sections = summaries.map((s) => composeContinuityBrief(s));
  return `${header}\n\n${sections.join("\n\n---\n\n")}`;
}

// ---------- Orchestrator ----------

export type SendBriefFn = (member: string, brief: string) => Promise<void>;

export interface ResumeFromBudgetPauseOpts {
  atmuxDir: string;
  /** Project worktree root — same value cage builder used at create. */
  projectCwd: string;
  /** Per-lane cage handles registered during pause-entry. */
  handles: ReadonlyArray<CageHandle>;
  /** Resolver: lane → original Claude member name. Defaults to identity
   *  (lane as member) — most teams have a 1:1 lane↔member mapping; T4
   *  passes the pre-pause-snapshot's lane→member map for the general
   *  case. */
  resolveMember?: (lane: string) => string;
  /** Async fn that pastes the brief to the named member's pane. The
   *  verb-layer caller wires this through `safeSendKeys` per ADR-057
   *  D1 once it lands; this module stays send-mechanism-agnostic. */
  sendFn: SendBriefFn;
  /** Optional teardown override; defaults to destroyFallbackCage from
   *  abstractions/fallback-cage.ts. Tests pass a stub. */
  destroyFn?: (handle: CageHandle, dopts: DestroyFallbackCageOpts) => Promise<void>;
  readFn?: (path: string) => Promise<string | null>;
  spawnFn?: (opts: SpawnOpts) => Promise<SpawnResult>;
  /** Clock injection for tests. */
  nowSec?: () => number;
}

export interface ResumeFromBudgetPauseResult {
  summaries: ReadonlyArray<LaneSummary>;
  /** Count of briefs successfully delivered (sendFn resolved). */
  sent: number;
  /** Count of cages successfully torn down (destroyFn resolved). */
  destroyed: number;
  /** Per-handle error tuples; empty when fully successful. The caller
   *  surfaces these via the lead's flag/decisions surface — we don't
   *  raise from this module so a single lane failure can't block the
   *  resume of every other lane. */
  errors: ReadonlyArray<{ lane: string; phase: "summary" | "send" | "destroy"; message: string }>;
}

/**
 * Walk per-lane handles, build summaries, send continuity briefs, and
 * destroy cages. Best-effort per-lane: one lane's failure does NOT
 * short-circuit the rest.
 */
export async function resumeFromBudgetPause(
  opts: ResumeFromBudgetPauseOpts,
): Promise<ResumeFromBudgetPauseResult> {
  const resolveMember = opts.resolveMember ?? ((lane): string => lane);
  const destroyFn = opts.destroyFn ?? defaultDestroyFallbackCage;

  const summaries: LaneSummary[] = [];
  const errors: { lane: string; phase: "summary" | "send" | "destroy"; message: string }[] = [];
  let sent = 0;
  let destroyed = 0;

  for (const handle of opts.handles) {
    let summary: LaneSummary | null = null;
    try {
      const buildOpts: BuildLaneSummaryOpts = {
        atmuxDir: opts.atmuxDir,
        projectCwd: opts.projectCwd,
        ...(opts.readFn ? { readFn: opts.readFn } : {}),
        ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
      };
      summary = await buildLaneSummary(handle, buildOpts);
      summaries.push(summary);
    } catch (e) {
      errors.push({ lane: handle.lane, phase: "summary", message: errorMsg(e) });
    }

    if (summary !== null) {
      const member = resolveMember(handle.lane);
      const brief = composeContinuityBrief(summary);
      try {
        await opts.sendFn(member, brief);
        sent += 1;
      } catch (e) {
        errors.push({ lane: handle.lane, phase: "send", message: errorMsg(e) });
      }
    }

    try {
      const destroyOpts: DestroyFallbackCageOpts = {
        atmuxDir: opts.atmuxDir,
        ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
        ...(opts.nowSec ? { nowSec: opts.nowSec } : {}),
      };
      await destroyFn(handle, destroyOpts);
      destroyed += 1;
    } catch (e) {
      errors.push({ lane: handle.lane, phase: "destroy", message: errorMsg(e) });
    }
  }

  return { summaries, sent, destroyed, errors };
}

function errorMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
