// t-af159454: phantom in-progress claim auto-prune (was complaint c-368c375b).
//
// A "phantom in-progress claim" is a kanban row where:
//   - status = 'in-progress'
//   - owner is set
//   - the owner's tmux window is NOT present in the team's cage
//
// These pile up when a team session was killed without a clean
// `atmux done` on every claimed task (operator-observed sopx pain on
// 2026-05-08 — 5 stuck phantom IDs surfaced by superdoctor on a fresh
// boot of an unrelated team). Doctor flags them today but doesn't
// fix; this module is the fix.
//
// The detection helper is pure-ish: pane probing is injected so unit
// tests don't need a live tmux. The prune helper is idempotent —
// running it twice across the same set is safe (kanban's
// `markTaskBlockedWithNote` short-circuits on already-`auto-pruned`
// rows).
//
// Caller surfaces:
//   - `atmux doctor --fix` — operator-driven, between sessions.
//   - `atmux stop` — runs at session teardown so phantoms don't
//     survive into the next boot.
//   - `atmux hygiene-tick` — opportunistic cron-fired sweep (t-d6fc03a7)
//     of long-lived phantoms (≥24h by default, via `minAgeSec`) whose
//     owner-member is not currently attached. Catches the "team
//     session died non-gracefully" path the stop hook can't cover.

import { listTasks, markTaskBlockedWithNote } from "./kanban.ts";
import type { KanbanTask } from "../schema/kanban.ts";
import type { Team } from "../schema/team.ts";

// ---------- Live-pane probe ----------

/** Injected probe: returns the set of member names with a live pane
 *  in the team's cage. Implementations are caller-side (doctor wires
 *  `tmux.window.listWindows` against the cage socket; stop verb does
 *  the same against its own resolved socket). Returning a Set is
 *  faster than an array for the membership query that follows. */
export type LiveMembersProbe = () => Promise<ReadonlySet<string>>;

// ---------- Detection ----------

export interface PhantomClaim {
  /** Task id (kanban row id, `t-…`). */
  id: string;
  /** Owner recorded on the in-progress row. Guaranteed non-empty. */
  owner: string;
  /** Subject for surfacing the row to the operator. */
  subject: string;
}

export interface FindPhantomOpts {
  atmuxDir: string;
  team: Team;
  liveMembers: LiveMembersProbe;
  /** Minimum age (seconds) since `claimedAt` before a phantom is
   *  returned. Used by `atmux hygiene-tick` (default 86400s = 24h) to
   *  spare fresh claims that may legitimately race the cron tick.
   *  Stop + doctor callers omit — they're operator-driven and want
   *  every detected phantom flipped immediately.
   *
   *  Rows missing `claimedAt` (legacy / never-set) are treated as
   *  unboundedly old: they fall through the filter and are returned
   *  whenever the filter is active. The fail-safe posture matches the
   *  rest of the module — "owner can't possibly still be working" is
   *  more important than the timestamp's presence. */
  minAgeSec?: number;
  /** Epoch seconds used as `now` for the `minAgeSec` comparison.
   *  Injected by tests for deterministic age arithmetic; omitted by
   *  production callers (defaults to `Math.floor(Date.now() / 1000)`). */
  nowSec?: number;
}

/**
 * Walk the kanban for `status='in-progress'` rows whose owner is not
 * present in the live-pane set. Owners absent from `team.members`
 * count as phantoms too (a member was removed from `team.json` after
 * claiming) — same fail-safe posture: if the owner can't possibly
 * still be working, the claim is dead.
 *
 * Returns an empty array when no in-progress rows exist OR when every
 * in-progress owner has a live pane.
 *
 * When `minAgeSec` is set, rows whose `claimedAt` is within the window
 * are filtered out. Rows with `claimedAt === null` are kept (legacy /
 * pre-claim-stamp rows — fail-safe toward pruning, since the only way
 * a row reaches `in-progress` without a `claimedAt` is data drift).
 */
export async function findPhantomInProgressClaims(
  opts: FindPhantomOpts,
): Promise<PhantomClaim[]> {
  const inProgress = await listTasks(opts.atmuxDir, { status: "in-progress" });
  if (inProgress.length === 0) return [];
  const live = await opts.liveMembers();
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const phantoms: PhantomClaim[] = [];
  for (const t of inProgress) {
    const owner = t.owner;
    if (owner === null || owner === undefined || owner.length === 0) continue;
    if (live.has(owner)) continue;
    if (opts.minAgeSec !== undefined && opts.minAgeSec > 0) {
      const claimedAt = t.claimedAt ?? null;
      if (claimedAt !== null && now - claimedAt < opts.minAgeSec) continue;
    }
    phantoms.push({ id: t.id, owner, subject: t.subject ?? "" });
  }
  return phantoms;
}

// ---------- Prune ----------

export type PruneSource = "doctor-fix" | "session-stop" | "hygiene-tick";

export interface PruneOpts {
  atmuxDir: string;
  phantoms: ReadonlyArray<PhantomClaim>;
  /** ISO-8601 UTC timestamp embedded in the note. Caller-injected so
   *  tests + paired prune calls share a stable string. */
  asOfIso: string;
  /** Which call site triggered the prune. Surfaces in the note for
   *  operator forensics. */
  source: PruneSource;
}

export interface PruneResult {
  /** IDs that were flipped to `blocked`. */
  prunedIds: string[];
  /** IDs that the helper saw but were already auto-pruned (idempotent
   *  re-call); kept distinct from `prunedIds` so callers can render
   *  "0 new, N already pruned" instead of misreporting. */
  alreadyPrunedIds: string[];
}

/**
 * Flip every phantom claim to `status='blocked'` with a note shaped
 * `auto-pruned at <iso> via <source>` — the `auto-pruned` prefix is
 * what `markTaskBlockedWithNote` keys idempotency on.
 *
 * Pure-ish: actual DB writes happen via `markTaskBlockedWithNote`
 * (one transaction per row). Errors on individual rows are NOT
 * swallowed — if a row is unknown (shouldn't happen given the
 * detection just listed it, but races are possible), the caller sees
 * the throw. This is preferable to silent skips: stop-side teardown
 * wants to know if its prune scope drifted.
 */
export async function prunePhantomInProgressClaims(
  opts: PruneOpts,
): Promise<PruneResult> {
  const prunedIds: string[] = [];
  const alreadyPrunedIds: string[] = [];
  const note = `auto-pruned at ${opts.asOfIso} via ${opts.source}`;
  for (const p of opts.phantoms) {
    const mutated = await markTaskBlockedWithNote(opts.atmuxDir, p.id, note);
    if (mutated) prunedIds.push(p.id);
    else alreadyPrunedIds.push(p.id);
  }
  return { prunedIds, alreadyPrunedIds };
}

// ---------- Convenience: format ISO without ms ----------

/** `2026-05-13T15:57:42Z` shape — drops the millisecond component
 *  for cleaner audit-note rendering. Caller-side so tests can pin
 *  the exact stamp. */
export function formatPruneIso(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.toISOString().slice(0, 19)}Z`;
}

// ---------- Re-export domain type for caller convenience ----------

export type { KanbanTask };
