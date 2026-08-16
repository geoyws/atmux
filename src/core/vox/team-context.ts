// ADR-272: voice operator interface — team-name index + ASR-tolerant
// resolution over the cockpit roster.
//
// A speech transcript is a noisy channel: "atmux", "Atmux", "atmux
// team", "atmuks" should all land on the same cockpit entry, while a
// genuinely ambiguous utterance must come back as a question, never a
// silent first-pick (same posture as ADR-150 §D5). Resolution is a
// LADDER — the first rung with EXACTLY ONE hit wins; more than one hit
// on a rung is `ambiguous` with the candidate names; falling off the
// last rung is `unknown`.
//
// The index is built from `loadCockpit()` via `enabledTeams` (the
// canonical `walkSessions` flattener), injectable for tests. The local
// Levenshtein is deliberately NOT shared with `src/verbs/task.ts` — the
// one there is module-private in a verbs file, and core must not import
// from `src/verbs/**` (dependency direction stays verbs→core).

import { enabledTeams, type LoadedCockpit, loadCockpit } from "../cockpit.ts";

/** One resolvable team. `root` is the project root (`--team-dir` value
 *  for the verbs the voice bridge invokes); epic-teams inherit the
 *  parent team's root per ADR-089. */
export interface VoxTeamEntry {
  name: string;
  root: string;
  type: "team" | "epic-team";
}

export interface VoxTeamIndex {
  teams: VoxTeamEntry[];
}

export interface BuildTeamIndexDeps {
  /** Cockpit loader override (tests inject a canned roster). */
  loadCockpit?: () => Promise<LoadedCockpit>;
}

/** Build the voice team index from the cockpit roster (enabled `team` +
 *  `epic-team` sessions, DFS order). Propagates the loader's
 *  `ConfigError` / `SchemaError` — a missing cockpit is a boot-time
 *  configuration problem, not a per-tool-call one. */
export async function buildTeamIndex(deps: BuildTeamIndexDeps = {}): Promise<VoxTeamIndex> {
  const load = deps.loadCockpit ?? (() => loadCockpit());
  const cockpit = await load();
  const teams = enabledTeams(cockpit).map(
    (t): VoxTeamEntry => ({ name: t.name, root: t.root, type: t.type }),
  );
  return { teams };
}

export type ResolveTeamResult =
  | { ok: true; team: VoxTeamEntry }
  | { ok: false; reason: "unknown" }
  | { ok: false; reason: "ambiguous"; candidates: string[] };

/** Case-fold for matching: trim + lower-case. */
function fold(s: string): string {
  return s.trim().toLowerCase();
}

/** Strip ONE trailing `-root` / `-team` suffix (repo-naming noise the
 *  operator rarely speaks: "sopx" should hit "sopx-root"). */
function stripSuffix(s: string): string {
  return s.replace(/-(root|team)$/, "");
}

/**
 * Levenshtein edit distance — iterative DP, O(|a|·|b|). Local (small,
 * fully tested) because the existing implementation is module-private
 * in `src/verbs/task.ts` (see file header).
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const curr = new Array<number>(n + 1);
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      curr[j] = Math.min((prev[j - 1] ?? 0) + cost, (prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1);
    }
    prev = curr;
  }
  return prev[n] ?? Math.max(m, n);
}

/** Maximum edit distance the fuzzy rung accepts. */
export const RESOLVE_MAX_EDIT_DISTANCE = 2;

/**
 * Resolve a spoken team name against the index via the ladder (first
 * rung with exactly one hit wins; >1 hits → ambiguous):
 *
 *   1. exact match
 *   2. case-fold match
 *   3. case-fold match after stripping `-root` / `-team` from BOTH sides
 *   4. unique prefix (case-folded spoken prefixes a name)
 *   5. Levenshtein ≤ {@link RESOLVE_MAX_EDIT_DISTANCE} on case-folded names
 */
export function resolveTeamName(index: VoxTeamIndex, spoken: string): ResolveTeamResult {
  const foldedSpoken = fold(spoken);
  if (foldedSpoken.length === 0) return { ok: false, reason: "unknown" };
  const strippedSpoken = stripSuffix(foldedSpoken);

  const rungs: Array<(t: VoxTeamEntry) => boolean> = [
    (t) => t.name === spoken,
    (t) => fold(t.name) === foldedSpoken,
    (t) => stripSuffix(fold(t.name)) === strippedSpoken,
    (t) => fold(t.name).startsWith(foldedSpoken),
    (t) => levenshtein(fold(t.name), foldedSpoken) <= RESOLVE_MAX_EDIT_DISTANCE,
  ];

  for (const matches of rungs) {
    const hits = index.teams.filter(matches);
    if (hits.length === 1) {
      const team = hits[0];
      if (team !== undefined) return { ok: true, team };
    }
    if (hits.length > 1) {
      return { ok: false, reason: "ambiguous", candidates: hits.map((t) => t.name) };
    }
  }
  return { ok: false, reason: "unknown" };
}
