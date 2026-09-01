// ADR-261 §D3–§D9 — the issue-sync engine: fetch → reconcile → file → route.
//
// The deterministic heart of issue-sync. NO LLM calls anywhere in this
// module (ADR-261 §D5 / ADR-237 §D1) — the only LLM in the loop is the
// target team's lead reading its inbox on its own turn. One
// `syncTracker(trackerCfg)` call walks every configured scope of one
// tracker:
//
//   1. resolve the TARGET team's `.atmux` dir (§D9): `targetTeam` absent
//      ⇒ the polling team itself; present ⇒ cockpit walk with
//      refuse-on-ambiguous (ADR-150 §D5 semantics — never a silent
//      first-pick);
//   2. repair `pending` ledger rows stranded by a prior kill (§D4
//      crash-window repair — record the existing complaint's id or
//      complete the file from the ledger row's stashed metadata);
//   3. pull pages through the vendor-agnostic adapter cursor loop,
//      reconciling each issue through the §D4 sync-state matrix and
//      checkpointing the cursor PER PAGE so a killed sync RESUMES, not
//      restarts;
//   4. file new open issues as complaints via `fileDedupedComplaint`
//      into the TARGET team's state.db (§D4 ledger-first write
//      ordering: pending → complaint → filed), then route to the
//      target's lead inline when the target is NOT running orchd (§D5a
//      — orchd targets are served by the event-driven
//      `atmux:complaint-consumer`; never both, no double-ping);
//   5. enforce the §D8 first-sync K-guard (refuse to file more than K
//      new complaints without `backfill`) and the backfill quiet mode
//      (file everything, suppress per-row routing, ONE summary
//      tell-lead at the end).
//
// Residency (§D4): the issue_sync ledger + poll cursor live in the
// POLLING team's state.db; the complaint row lives in the TARGET team's
// state.db (ADR-150 §D1 one-row-one-DB) — two different databases with
// no shared transaction when `targetTeam` ≠ the polling team.
//
// Security (§D7): issue titles/bodies are UNTRUSTED input. The
// tell-lead line carries only a truncated, sanitized title + complaint
// id + url — NEVER the body; the body rides only in the complaint's
// `extra.body_excerpt`, read deliberately via `atmux complaints show`.
//
// DI follows the house deps-object discipline (template:
// ComplaintConsumerDeps, src/core/complaint-consumer.ts): every seam
// defaults to the real abstraction; tests inject fakes.

import { join } from "node:path";
import type { IssueTracker, NormalizedIssue } from "../abstractions/issue-tracker.ts";
import { spawn } from "../abstractions/spawn.ts";
import { closeDatabase, type Database, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { createGithubTracker, GITHUB_TRACKER_ID } from "../abstractions/trackers/github.ts";
import {
  ConfigError,
  KGuardExceededError,
  TargetTeamResolutionError,
  TrackerRateLimitError,
} from "../errors.ts";
import type { IssueSyncRecord } from "../schema/issue-sync.ts";
import { resolveOrchestrationMode, type Team, type TeamIssueSyncTracker } from "../schema/team.ts";
import { type LoadCockpitOpts, loadCockpit, walkSessions } from "./cockpit.ts";
import { getAtmuxDir, loadTeam } from "./common.ts";
import { DEFAULT_DEDUP_WINDOW_SEC, fileDedupedComplaint } from "./complaints.ts";
import { ComplaintsRepo } from "./repositories/complaints-repo.ts";
import { IssueSyncRepo } from "./repositories/issue-sync-repo.ts";

// ---------- Tuning constants ----------

/** §D8 first-sync guard default — refuse to file more than K new
 *  complaints in one un-backfilled sync. */
export const DEFAULT_MAX_NEW_COMPLAINTS = 10;

/** §D7.1 — tell-lead lines + `incidentSummary` carry at most this many
 *  title characters (sanitized first). */
export const MAX_TITLE_CHARS = 120;

/** §D7 — the untrusted body never leaves the complaint's `extra` bag,
 *  and even there it is capped to this excerpt length. */
export const MAX_BODY_EXCERPT_CHARS = 500;

// ---------- Report ----------

/** Outcome surface of one `syncTracker` run — one counter per §D4
 *  matrix action class, plus the §D8 guard flag and the per-scope
 *  cursor checkpoints. */
export interface SyncReport {
  /** Issues received from the adapter across all pages + scopes. */
  scanned: number;
  /** Fresh complaints filed for never-seen sourceIds (§D4 row 1 + the
   *  crash-repair completions that created a new row). */
  filed: number;
  /** `fileDedupedComplaint` coalesced into an existing open row inside
   *  its 1h window (no new row, no tell-lead — bump suppression). */
  bumpedWithinWindow: number;
  /** Complaints auto-resolved as an upstream-close mirror
   *  (`resolvedBy: "tracker:<id>"`, §D4 row 5). */
  autoResolved: number;
  /** Mirror-resolved complaints re-filed after an upstream REOPEN
   *  (§D4 row 6 symmetry). */
  refiled: number;
  /** Upstream-open issues skipped because the LEAD resolved/wontfixed
   *  the complaint — never re-litigated by a poll (§D4 row 7). */
  skippedLeadResolved: number;
  /** True when the §D8 K-guard fired (the run then ABORTS with
   *  `KGuardExceededError`, which carries this report in its
   *  `context.report`). */
  kGuardHit: boolean;
  /** Last cursor checkpoint written per scope (`null` = walk completed
   *  / listing exhausted). Scopes never reached are absent. */
  cursorAdvancedTo: Record<string, string | null>;
  /** Non-fatal failures (tell-lead rc≠0, per-scope IO errors,
   *  rate-limit bails) — the sync keeps whatever progress it made. */
  errors: string[];
}

function emptyReport(): SyncReport {
  return {
    scanned: 0,
    filed: 0,
    bumpedWithinWindow: 0,
    autoResolved: 0,
    refiled: 0,
    skippedLeadResolved: 0,
    kGuardHit: false,
    cursorAdvancedTo: {},
    errors: [],
  };
}

// ---------- Deps (test-injection seams; production callers omit) ----------

/** Minimal logger shape (matches ComplaintConsumerDeps). */
export interface IssueSyncLogger {
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

const NOOP_LOGGER: IssueSyncLogger = { log: () => {}, warn: () => {} };

/** What the engine needs from a loaded `team.json` — name (complaint
 *  `targetTeam` stamp + tell-lead routing) and orchestration mode (the
 *  §D5a inline-delivery gate). `loadTeam` satisfies this. */
export type LoadTeamForDir = (opts: {
  dir: string;
}) => Promise<Pick<Team, "name" | "orchestration">>;

/** Injection seams for {@link createIssueSyncEngine} — every field
 *  defaults to the real abstraction (house deps-object discipline). */
export interface IssueSyncEngineDeps {
  /** Adapter map keyed by tracker id (§D2). Default:
   *  {@link defaultTrackers} — the Phase 1 GitHub adapter. */
  trackers?: Readonly<Record<string, IssueTracker>>;
  /** Open a team's state.db from its `.atmux` dir. The engine OWNS the
   *  returned handle and closes it when the sync finishes — inject an
   *  opener that returns fresh connections, never a shared handle.
   *  Default: {@link defaultOpenStateDb}. */
  openDb?: (atmuxDir: string) => Database;
  /** Spawn `atmux <args...>` for the §D5a inline tell-lead leg; resolves
   *  to the subprocess exit code. Default:
   *  {@link createDefaultTellLeadSpawner} over the house spawn
   *  abstraction (ADR-007 — never Bun.spawn directly). */
  spawnTellLead?: (args: ReadonlyArray<string>) => Promise<number>;
  /** Clock (epoch seconds). Default {@link defaultNowSec}. */
  nowSec?: () => number;
  /** Logger. Default no-op (matches complaint-consumer). */
  logger?: IssueSyncLogger;
  /** Cockpit loader for the §D9 target-team walk. Default: the real
   *  `loadCockpit` (src/core/cockpit.ts). */
  loadCockpitFn?: typeof loadCockpit;
  /** Options forwarded to the cockpit loader (path/env/home injection —
   *  lets tests exercise the DEFAULT loader against a fixture file). */
  loadCockpitOpts?: LoadCockpitOpts;
  /** team.json loader (target-mode probe + own-team name). Default:
   *  the real `loadTeam` (src/core/common.ts). */
  loadTeamForDir?: LoadTeamForDir;
  /** The POLLING team's `.atmux` dir (ledger + cursor residency, §D4).
   *  Default: the real `getAtmuxDir` cwd walk (src/core/common.ts). */
  ownAtmuxDir?: () => Promise<string>;
}

/** The engine surface — one verb. The Phase 1 `atmux issues sync` CLI
 *  verb and the Phase 2 orchd `--poll-issues` ticker both drive it. */
export interface IssueSyncEngine {
  syncTracker(trackerCfg: TeamIssueSyncTracker, opts?: SyncTrackerOpts): Promise<SyncReport>;
}

/** Per-run knobs (the verb's flags map 1:1 onto these). */
export interface SyncTrackerOpts {
  /** §D8 quiet mode: file ALL new complaints, suppress per-row
   *  routing, send ONE summary tell-lead. Default false (K-guard on). */
  backfill?: boolean;
  /** §D8 K override. Non-finite / non-positive values fail closed to
   *  {@link DEFAULT_MAX_NEW_COMPLAINTS} (house knob discipline). */
  maxNewComplaints?: number;
}

// ---------- Default-real seams ----------

/** Default adapter registry — the Phase 1 GitHub adapter (§D11).
 *  Phase 2 adds azure-devops here. */
export function defaultTrackers(): Readonly<Record<string, IssueTracker>> {
  return Object.freeze({ [GITHUB_TRACKER_ID]: createGithubTracker() });
}

/** Default DB opener — `<atmuxDir>/state.db` through the house sqlite
 *  abstraction with the full migration ladder. */
export function defaultOpenStateDb(atmuxDir: string): Database {
  return openDatabase(join(atmuxDir, "state.db"), migrations);
}

/** Default clock — epoch seconds. */
export function defaultNowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Build the default tell-lead spawner over the ADR-007 spawn
 *  abstraction (`atmux` resolved from PATH). `expectExitCode: "any"`
 *  because the engine surfaces non-zero codes into `report.errors`
 *  rather than throwing; spawn-layer failures (missing binary /
 *  timeout) map to 127, shell convention for command-not-found. */
export function createDefaultTellLeadSpawner(
  spawnFn: typeof spawn = spawn,
): (args: ReadonlyArray<string>) => Promise<number> {
  return async (args) => {
    try {
      const res = await spawnFn({ cmd: "atmux", argv: [...args], expectExitCode: "any" });
      return res.exitCode;
    } catch {
      return 127; // expected: atmux missing from PATH / spawn timeout
    }
  };
}

// ---------- §D7 sanitization + §D10 severity mapping ----------

/** §D7.1 — sanitize an UNTRUSTED issue title for inbox prose: strip
 *  the C0 control characters plus DEL (`\x00`-`\x1f` + `\x7f`) — newline
 *  injection into the lead's inbox is the guarded attack — collapse
 *  whitespace runs, trim, and cap at `maxLen` (ellipsis when truncated,
 *  total length still ≤ maxLen). Ordinary printable text is preserved
 *  verbatim; only the control range is replaced. */
export function sanitizeIssueTitle(raw: string, maxLen: number = MAX_TITLE_CHARS): string {
  const collapsed = raw
    // C0 controls + DEL, as hex escapes. NEVER the raw bytes: a literal
    // NUL makes this file test as *binary* to grep/rg/ugrep (`-I`), which
    // silently drops it from the CLAUDE.md `rg '<topic>' src/` look-up order.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars IS the point (§D7 newline-injection guard)
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen - 1)}…`;
}

/** Binding severity vocabulary rank (the `extractSeverity` convention,
 *  src/core/complaints.ts — per the §D10 schema comment). */
const SEVERITY_RANK: Readonly<Record<string, number>> = {
  info: 0,
  warn: 1,
  urgent: 2,
  critical: 3,
};

/** §D10 label→severity mapping: case-insensitive label match against
 *  the tracker's `labelSeverityMap`; when several labels match, the
 *  MOST severe wins. `null` when no map / no match (complaint files
 *  unrated — `extractSeverity` reads absent as null). */
export function severityFromLabels(
  labels: readonly string[],
  map: Readonly<Record<string, string>> | undefined,
): string | null {
  if (map === undefined) return null;
  const lowered = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  let best: string | null = null;
  for (const label of labels) {
    const sev = lowered.get(label.toLowerCase());
    if (sev === undefined) continue;
    if (best === null || (SEVERITY_RANK[sev] ?? -1) > (SEVERITY_RANK[best] ?? -1)) best = sev;
  }
  return best;
}

/** §D5a/§D7.1 — the inline tell-lead line: truncated sanitized title +
 *  complaint id + url. NEVER the body (it rides only in
 *  `extra.body_excerpt`). Shape mirrors
 *  `complaint-consumer.ts::formatComplaintMessage` so leads see one
 *  vocabulary regardless of delivery leg. */
export function formatIssueSyncTellLeadLine(opts: {
  complaintId: string;
  trackerId: string;
  severity: string | null;
  summary: string;
  url: string;
}): string {
  return (
    `[issue-sync] ${opts.complaintId} severity=${opts.severity ?? "unrated"} ` +
    `source=${opts.trackerId}: ${opts.summary} — ${opts.url}`
  );
}

/** §D8 K resolution — opt wins, failing closed to the default on
 *  non-finite / non-positive values (house knob discipline, cf.
 *  `resolveGitTimeoutMs`). */
export function resolveMaxNewComplaints(raw?: number): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_NEW_COMPLAINTS;
  return Math.floor(raw);
}

// ---------- §D9 target-team resolution (net-new — ADR-150 §D5 was never shipped) ----------

/** Seams for {@link resolveTargetTeamAtmuxDir} (subset of the engine
 *  deps so verbs can reuse the resolver standalone). */
export interface ResolveTargetTeamDeps {
  loadCockpitFn?: typeof loadCockpit;
  loadCockpitOpts?: LoadCockpitOpts;
}

/**
 * Resolve a target team name to its `.atmux` dir via the cockpit
 * registry walk (ADR-261 §D9 — the storage-routing leg ADR-150 §D1
 * designed but never shipped). EXACTLY ONE `team` session
 * must match the name: zero, multiple, or a match with no resolvable
 * root all throw the typed {@link TargetTeamResolutionError} (ADR-150
 * §D5 refuse-on-ambiguous — never a silent first-pick). Nested teams
 * resolve to their own `root` like any other, so depth does not change
 * the answer.
 */
export async function resolveTargetTeamAtmuxDir(
  deps: ResolveTargetTeamDeps,
  name: string,
): Promise<string> {
  const load = deps.loadCockpitFn ?? loadCockpit;
  const cockpit = await load(deps.loadCockpitOpts);
  const roots: string[] = [];
  walkSessions(cockpit.sessions ?? [], 0, (node, _level, parentRoot) => {
    if (node.type !== "team") return;
    if (node.name !== name) return;
    roots.push(node.root);
  });
  if (roots.length === 0) {
    throw new TargetTeamResolutionError({ team: name, reason: "not-found", matches: 0 });
  }
  if (roots.length > 1) {
    throw new TargetTeamResolutionError({ team: name, reason: "ambiguous", matches: roots.length });
  }
  const root = roots[0] ?? "";
  if (root === "") {
    throw new TargetTeamResolutionError({ team: name, reason: "no-root", matches: 1 });
  }
  return join(root, ".atmux");
}

// ---------- Internal shapes ----------

/** Everything the §D4 file action needs about one issue, normalized
 *  once — built from a live {@link NormalizedIssue} on the poll path
 *  and re-hydrated from the ledger row's stashed `extra` on the
 *  crash-repair path. */
interface FilingInput {
  sourceId: string;
  /** Sanitized, ≤{@link MAX_TITLE_CHARS} (§D7.1). Falls back to the
   *  sourceId when the title sanitizes to empty (schema-min guard). */
  summary: string;
  url: string;
  labels: readonly string[];
  author: string | null;
  bodyExcerpt: string | null;
  severity: string | null;
  upstreamState: string;
  upstreamUpdatedAtSec: number;
}

/** One sync run's shared context — threaded through the per-scope /
 *  per-issue helpers instead of a long parameter list. */
interface SyncCtx {
  cfg: TeamIssueSyncTracker;
  tracker: IssueTracker;
  ledger: IssueSyncRepo;
  complaints: ComplaintsRepo;
  targetDb: Database;
  targetTeamName: string;
  /** §D5a delivery gate — `"orchd"` targets get NO inline tell-lead. */
  targetMode: "manual" | "orchd";
  backfill: boolean;
  maxNew: number;
  /** Running tally of new complaint rows (filed + refiled) — the §D8
   *  K-guard counter. */
  newFiled: number;
  report: SyncReport;
  nowSec: () => number;
  spawnTellLead: (args: ReadonlyArray<string>) => Promise<number>;
  logger: IssueSyncLogger;
}

/** The complaint-row `extra` bag (§D3/§D7): tracker metadata only —
 *  the body capped to an excerpt, never in any routed message. */
function buildComplaintExtra(input: FilingInput, trackerCfgId: string): Record<string, unknown> {
  const extra: Record<string, unknown> = {
    url: input.url,
    labels: [...input.labels],
    author: input.author,
    upstream_state: input.upstreamState,
    tracker_id: trackerCfgId,
  };
  if (input.bodyExcerpt !== null) extra.body_excerpt = input.bodyExcerpt;
  if (input.severity !== null) extra.severity = input.severity;
  return extra;
}

function filingInputFromIssue(issue: NormalizedIssue, severity: string | null): FilingInput {
  const summary = sanitizeIssueTitle(issue.title) || issue.sourceId;
  return {
    sourceId: issue.sourceId,
    summary,
    url: issue.url,
    labels: issue.labels,
    author: issue.author,
    bodyExcerpt: issue.body === null ? null : issue.body.slice(0, MAX_BODY_EXCERPT_CHARS),
    severity,
    upstreamState: issue.state,
    upstreamUpdatedAtSec: issue.updatedAtSec,
  };
}

/** Re-hydrate a {@link FilingInput} from a stranded `pending` ledger
 *  row's stashed extra (§D4 crash repair — no adapter round-trip; the
 *  upsert stashed everything filing needs). Defensive reads: the extra
 *  bag is JSON from disk, so every field is shape-checked. */
function filingInputFromLedgerRow(rec: IssueSyncRecord): FilingInput {
  const ex = rec.extra;
  const title = typeof ex.title === "string" ? ex.title : rec.sourceId;
  return {
    sourceId: rec.sourceId,
    summary: sanitizeIssueTitle(title) || rec.sourceId,
    url: typeof ex.url === "string" ? ex.url : "",
    labels: Array.isArray(ex.labels)
      ? ex.labels.filter((l): l is string => typeof l === "string")
      : [],
    author: typeof ex.author === "string" ? ex.author : null,
    bodyExcerpt: typeof ex.body_excerpt === "string" ? ex.body_excerpt : null,
    severity: typeof ex.severity === "string" ? ex.severity : null,
    upstreamState: rec.upstreamState,
    upstreamUpdatedAtSec: rec.upstreamUpdatedAtSec,
  };
}

/** §D7.2 allowlist scopes for one tracker config: github polls its
 *  `repos[]`; azure-devops polls the single `org/project` coordinate. */
function scopesForTracker(cfg: TeamIssueSyncTracker): string[] {
  return cfg.id === "github" ? [...cfg.repos] : [`${cfg.org}/${cfg.project}`];
}

// ---------- The engine ----------

/**
 * Build the issue-sync engine over the injected seams. Stateless across
 * calls — all durable state lives in the two state.dbs (§D4 ledger +
 * cursor in the poller's; complaint rows in the target's), so a fresh
 * engine after a tick kill resumes exactly where the checkpoints left
 * off.
 */
export function createIssueSyncEngine(deps: IssueSyncEngineDeps = {}): IssueSyncEngine {
  const trackers = deps.trackers ?? defaultTrackers();
  const openDb = deps.openDb ?? defaultOpenStateDb;
  const spawnTellLead = deps.spawnTellLead ?? createDefaultTellLeadSpawner();
  const nowSec = deps.nowSec ?? defaultNowSec;
  const logger = deps.logger ?? NOOP_LOGGER;
  const loadCockpitFn = deps.loadCockpitFn ?? loadCockpit;
  const loadCockpitOpts = deps.loadCockpitOpts;
  const loadTeamForDir = deps.loadTeamForDir ?? loadTeam;
  const ownAtmuxDir = deps.ownAtmuxDir ?? getAtmuxDir;

  /**
   * §D4 file action — the ledger-first write ordering:
   *   1. `upsertPending` in the POLLER's DB (a kill after this leaves a
   *      repairable `pending` row, never an absent one);
   *   2. `fileDedupedComplaint` into the TARGET's DB;
   *   3. `markFiled` with the cross-DB back-pointer.
   * Guarded by the §D8 K-counter BEFORE any write; routed inline per
   * §D5a AFTER (new rows only — bumps are suppressed exactly as the
   * orchd consumer suppresses `bumped: true` events).
   */
  async function fileIssue(
    ctx: SyncCtx,
    scope: string,
    input: FilingInput,
    kind: "new" | "refile",
  ): Promise<void> {
    const now = ctx.nowSec();
    // §D8 K-guard: peek whether this filing would mint a NEW row (a
    // within-window bump coalesces — no flood contribution) and refuse
    // BEFORE the ledger write so an aborted candidate leaves no state.
    const wouldBeNew =
      ctx.complaints.findOpenBySourceId(input.sourceId, now - DEFAULT_DEDUP_WINDOW_SEC) === null;
    if (wouldBeNew && !ctx.backfill && ctx.newFiled >= ctx.maxNew) {
      ctx.report.kGuardHit = true;
      throw new KGuardExceededError({
        trackerId: ctx.cfg.id,
        scope,
        sourceId: input.sourceId,
        filedCount: ctx.newFiled,
        maxNewComplaints: ctx.maxNew,
        report: ctx.report,
      });
    }
    const complaintExtra = buildComplaintExtra(input, ctx.cfg.id);
    // The ledger stashes the complaint extra PLUS the sanitized title so
    // the crash-repair path can complete the file without re-fetching.
    ctx.ledger.upsertPending({
      sourceId: input.sourceId,
      trackerId: ctx.cfg.id,
      scope,
      targetTeam: ctx.cfg.targetTeam ?? null,
      upstreamState: input.upstreamState,
      upstreamUpdatedAtSec: input.upstreamUpdatedAtSec,
      firstSeenSec: now,
      lastSyncedSec: now,
      extra: { ...complaintExtra, title: input.summary },
    });
    const res = fileDedupedComplaint(ctx.targetDb, now, {
      sourceKind: ctx.cfg.id, // §D3 — sourceKind IS the adapter id
      sourceId: input.sourceId,
      targetTeam: ctx.targetTeamName,
      incidentSummary: input.summary,
      openedBy: `issue-sync:${ctx.cfg.id}`,
      extra: complaintExtra,
    });
    ctx.ledger.markFiled(input.sourceId, res.id);
    if (!res.isNew) {
      ctx.report.bumpedWithinWindow += 1;
      return; // bump suppression — the lead already saw the original
    }
    ctx.newFiled += 1;
    if (kind === "refile") ctx.report.refiled += 1;
    else ctx.report.filed += 1;
    // §D4 reopen symmetry note: on the refile arm the ledger's stale
    // `local_resolution` ("tracker:<id>") is SUPERSEDED rather than
    // cleared — the back-pointer now references an OPEN complaint, and
    // every later dispatch derives provenance from the live row's
    // `resolvedBy` first (the frozen ledger repo preserves the column on
    // conflict by design, so there is no clear primitive to call).
    if (ctx.backfill) return; // §D8 quiet mode — ONE summary at the end
    if (ctx.targetMode === "orchd") return; // §D5a — consumer delivers; never both
    const line = formatIssueSyncTellLeadLine({
      complaintId: res.id,
      trackerId: ctx.cfg.id,
      severity: input.severity,
      summary: input.summary,
      url: input.url,
    });
    const code = await ctx.spawnTellLead(["tell-lead", "--team", ctx.targetTeamName, line]);
    if (code !== 0) {
      ctx.report.errors.push(
        `tell-lead exited rc=${code} for complaint ${res.id} (target ${ctx.targetTeamName})`,
      );
    }
  }

  /**
   * §D4 crash-window repair — runs BEFORE the page loop for each scope.
   * A `pending` row with upstream `open` is a kill victim (steps 2/3 of
   * the write ordering never confirmed): record the existing complaint's
   * id when the target DB already has an open row for the sourceId, else
   * complete the file from the stashed ledger extra. Rows with upstream
   * `closed` are NOT victims — they are the §D4 absent+closed
   * "record-only, never file" arm and stay untouched.
   */
  async function repairPending(ctx: SyncCtx, scope: string): Promise<void> {
    for (const row of ctx.ledger.listPending(ctx.cfg.id, scope)) {
      if (row.upstreamState !== "open") continue;
      // Look up by sourceId across the FULL history (sinceSec 0) — the
      // dedup window doesn't apply here: a manual verb can easily be
      // re-run >1h after the kill, and re-filing then would mint exactly
      // the duplicate the ledger exists to prevent.
      const existing = ctx.complaints.findOpenBySourceId(row.sourceId, 0);
      if (existing !== null) {
        ctx.ledger.markFiled(row.sourceId, existing.id);
        continue;
      }
      await fileIssue(ctx, scope, filingInputFromLedgerRow(row), "new");
    }
  }

  /** Dispatch ONE fetched issue through the §D4 sync-state matrix. */
  async function reconcileIssue(
    ctx: SyncCtx,
    scope: string,
    issue: NormalizedIssue,
  ): Promise<void> {
    ctx.report.scanned += 1;
    const now = ctx.nowSec();
    const severity = severityFromLabels(issue.labels, ctx.cfg.labelSeverityMap);
    const input = filingInputFromIssue(issue, severity);
    const rec = ctx.ledger.getBySourceId(issue.sourceId);

    // ----- Ledger ABSENT -----
    if (rec === null) {
      if (issue.state === "open") {
        await fileIssue(ctx, scope, input, "new"); // §D4 row 1
        return;
      }
      // §D4 row 2 — record only; NEVER file for an already-closed issue.
      // The row deliberately stays `pending` + upstream `closed`: the
      // repair scan skips closed rows, and a later upstream reopen takes
      // the "no live complaint + open" arm below and files then.
      ctx.ledger.upsertPending({
        sourceId: issue.sourceId,
        trackerId: ctx.cfg.id,
        scope,
        targetTeam: ctx.cfg.targetTeam ?? null,
        upstreamState: "closed",
        upstreamUpdatedAtSec: issue.updatedAtSec,
        firstSeenSec: now,
        lastSyncedSec: now,
        extra: { ...buildComplaintExtra(input, ctx.cfg.id), title: input.summary },
      });
      return;
    }

    // ----- Ledger PRESENT — read the live complaint row (cross-DB) -----
    const complaint = rec.complaintId !== null ? ctx.complaints.getById(rec.complaintId) : null;

    if (complaint === null) {
      // No live complaint behind the ledger row: the §D4 absent+closed
      // record (complaintId null) or cross-DB drift (back-pointer to a
      // vanished target row). The ledger's cached `local_resolution` is
      // the only provenance left to consult.
      if (issue.state === "closed") {
        ctx.ledger.updateUpstream(issue.sourceId, "closed", issue.updatedAtSec, now);
        return;
      }
      if (rec.localResolution === "lead") {
        // §D4 row 7 — the lead's resolution is never re-litigated.
        ctx.report.skippedLeadResolved += 1;
        ctx.ledger.updateUpstream(issue.sourceId, "open", issue.updatedAtSec, now);
        return;
      }
      // Open upstream + nothing surfaced locally ⇒ surface it now. A
      // dangling back-pointer counts as a re-file (it WAS filed once).
      await fileIssue(ctx, scope, input, rec.complaintId !== null ? "refile" : "new");
      return;
    }

    if (complaint.status === "open") {
      if (issue.state === "closed") {
        // §D4 row 5 — auto-resolve: a deterministic state mirror, not
        // adjudication (the first non-actor resolvedBy; see the runbook).
        ctx.complaints.resolve({
          id: complaint.id,
          status: "resolved",
          resolvedAt: now,
          resolvedBy: `tracker:${ctx.cfg.id}`,
        });
        ctx.ledger.recordLocalResolution(issue.sourceId, `tracker:${ctx.cfg.id}`);
        ctx.ledger.updateUpstream(issue.sourceId, "closed", issue.updatedAtSec, now);
        ctx.report.autoResolved += 1;
        return;
      }
      if (issue.updatedAtSec > rec.upstreamUpdatedAtSec) {
        // §D4 row 4 — refresh the existing row's extra via the
        // back-pointer: no new row, no new tell-lead. (Within the 1h
        // dedup window the bump path is fileDedupedComplaint's job;
        // OUTSIDE it the ledger prevents the re-file — this arm is why.)
        ctx.complaints.mergeExtra(complaint.id, buildComplaintExtra(input, ctx.cfg.id));
        ctx.ledger.updateUpstream(issue.sourceId, "open", issue.updatedAtSec, now);
        return;
      }
      // §D4 row 3 — no-op: advance last_synced only.
      ctx.ledger.updateUpstream(issue.sourceId, "open", rec.upstreamUpdatedAtSec, now);
      return;
    }

    // ----- Complaint resolved/wontfix locally -----
    if (issue.state === "closed") {
      // Both sides closed — mirror is settled; advance the ledger.
      ctx.ledger.updateUpstream(issue.sourceId, "closed", issue.updatedAtSec, now);
      return;
    }
    // Upstream REOPENED. Provenance decides (§D4 rows 6/7): prefer the
    // live row's `resolvedBy`; fall back to the ledger's cached
    // provenance only when the row carries none.
    const provenance = complaint.resolvedBy ?? rec.localResolution ?? "";
    if (provenance.startsWith("tracker:")) {
      // §D4 row 6 — the mirror must be symmetric: what it auto-closed on
      // upstream-close it surfaces again on upstream-reopen.
      await fileIssue(ctx, scope, input, "refile");
      return;
    }
    // §D4 row 7 — lead-authored resolve/wontfix: do NOT re-file. Cache
    // the provenance in the ledger so even a complaint-row loss keeps
    // the no-re-litigate behavior.
    if (rec.localResolution !== "lead") {
      ctx.ledger.recordLocalResolution(issue.sourceId, "lead");
    }
    ctx.ledger.updateUpstream(issue.sourceId, "open", issue.updatedAtSec, now);
    ctx.report.skippedLeadResolved += 1;
  }

  /** Adapter cursor loop for one scope — reconcile each page, then
   *  checkpoint the cursor (§D4: a killed sync RESUMES from the last
   *  completed page, never restarts). */
  async function walkScope(ctx: SyncCtx, scope: string): Promise<void> {
    let cursor: string | null = ctx.ledger.getCursor(ctx.cfg.id, scope)?.cursor ?? null;
    while (true) {
      const page = await ctx.tracker.listIssues({ scope, cursor });
      for (const issue of page.issues) {
        await reconcileIssue(ctx, scope, issue);
      }
      ctx.ledger.setCursor(ctx.cfg.id, scope, page.nextCursor, ctx.nowSec());
      ctx.report.cursorAdvancedTo[scope] = page.nextCursor;
      if (page.nextCursor === null) return; // listing exhausted
      if (page.nextCursor === cursor) {
        // Defensive: an adapter bug echoing the same cursor would spin
        // this loop forever inside a 900s tick — bail loudly instead.
        ctx.report.errors.push(
          `scope ${scope}: cursor did not advance (${page.nextCursor}) — aborting walk`,
        );
        return;
      }
      cursor = page.nextCursor;
    }
  }

  return {
    async syncTracker(trackerCfg, opts = {}) {
      const tracker = trackers[trackerCfg.id];
      if (tracker === undefined) {
        throw new ConfigError({
          what: `no "${trackerCfg.id}" tracker adapter registered with the issue-sync engine`,
          hint: "Phase 1 ships github; azure-devops lands in Phase 2 (ADR-261 §D11)",
        });
      }
      const report = emptyReport();
      const ownDir = await ownAtmuxDir();

      // §D9 routing — targetTeam absent ⇒ the polling team itself;
      // present ⇒ cockpit walk with refuse-on-ambiguous.
      let targetDir: string;
      let targetTeamName: string;
      let targetMode: "manual" | "orchd";
      if (trackerCfg.targetTeam !== undefined) {
        targetDir = await resolveTargetTeamAtmuxDir(
          {
            loadCockpitFn,
            // exactOptionalPropertyTypes: forward the loader opts only when
            // the caller actually set them — an explicit `undefined` is not
            // assignable to an optional property.
            ...(loadCockpitOpts !== undefined ? { loadCockpitOpts } : {}),
          },
          trackerCfg.targetTeam,
        );
        targetTeamName = trackerCfg.targetTeam;
        // §D5a delivery gate: probe the TARGET's orchestration mode. An
        // unreadable target team.json falls back to manual (the ADR-260
        // fleet default) so the lead still gets pinged.
        try {
          targetMode = resolveOrchestrationMode(await loadTeamForDir({ dir: targetDir }));
        } catch (e) {
          targetMode = "manual";
          logger.warn(
            `issue-sync: could not read target team.json under ${targetDir} — assuming manual mode (ADR-260 default): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      } else {
        // Own team — its team.json must load (the complaint's targetTeam
        // stamp + tell-lead routing need the name), so no fallback here.
        targetDir = ownDir;
        const ownTeam = await loadTeamForDir({ dir: ownDir });
        targetTeamName = ownTeam.name;
        targetMode = resolveOrchestrationMode(ownTeam);
      }

      // §D4 residency: ledger+cursor in the POLLER's DB, complaints in
      // the TARGET's. Same team ⇒ one shared handle, not two.
      const ledgerDb = openDb(ownDir);
      const targetIsOwn = targetDir === ownDir;
      const targetDb = targetIsOwn ? ledgerDb : openDb(targetDir);
      try {
        const ctx: SyncCtx = {
          cfg: trackerCfg,
          tracker,
          ledger: new IssueSyncRepo(ledgerDb),
          complaints: new ComplaintsRepo(targetDb),
          targetDb,
          targetTeamName,
          targetMode,
          backfill: opts.backfill === true,
          maxNew: resolveMaxNewComplaints(opts.maxNewComplaints),
          newFiled: 0,
          report,
          nowSec,
          spawnTellLead,
          logger,
        };
        const scopes = scopesForTracker(trackerCfg);
        walk: for (const scope of scopes) {
          try {
            await repairPending(ctx, scope);
            await walkScope(ctx, scope);
          } catch (e) {
            // The K-guard is the run's verdict, not a per-scope hiccup —
            // propagate so the verb exits non-zero (§D8).
            if (e instanceof KGuardExceededError) throw e;
            report.errors.push(`scope ${scope}: ${e instanceof Error ? e.message : String(e)}`);
            // Rate limits are tracker-global — no point hitting the next
            // scope on the same exhausted budget. Cursor checkpoints are
            // already durable per page; the next run resumes (§D1/§D4).
            if (e instanceof TrackerRateLimitError) break walk;
          }
        }
        // §D8 backfill quiet mode: per-row routing was suppressed above —
        // send ONE summary tell-lead (manual-mode targets only, §D5a).
        const newCount = report.filed + report.refiled;
        if (ctx.backfill && newCount > 0 && targetMode !== "orchd") {
          const line =
            `issue-sync backfill: ${newCount} issues from ${scopes.join(", ")} filed as ` +
            `complaints — atmux complaints list --source-kind ${trackerCfg.id}`;
          const code = await spawnTellLead(["tell-lead", "--team", targetTeamName, line]);
          if (code !== 0) {
            report.errors.push(
              `backfill summary tell-lead exited rc=${code} (target ${targetTeamName})`,
            );
          }
        }
        return report;
      } finally {
        closeDatabase(ledgerDb);
        if (!targetIsOwn) closeDatabase(targetDb);
      }
    },
  };
}
