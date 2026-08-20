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
//
// ADR-273 §Supplement-8: the ladder originally ran exact → case-fold →
// suffix-strip → PREFIX → Levenshtein, so only a team's LEADING segment
// resolved. That is backwards for this fleet: names are
// `<product>-<feature>-<user>[-driver-N]` (CLAUDE.md §Branch naming), so
// the prefix is the SHARED, least distinctive part and the trailing
// segment is the one an operator actually says — "driver 2", "geoyws",
// "alpha". A segment rung now sits between prefix and Levenshtein.

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
 *  operator rarely speaks: "sopx" should hit "sopx-root"). Operates on a
 *  hyphenated NAME and is applied to both sides of rung 3. Its spoken-side
 *  counterpart is {@link normalizeSpoken}; see that doc for why the two are
 *  separate mechanisms rather than one. */
function stripSuffix(s: string): string {
  return s.replace(/-(root|team)$/, "");
}

/** The one leading article an operator puts in front of a team name.
 *  Kept to a single word on purpose — every entry here is a word the
 *  segment rung can no longer match, and a team really can be named
 *  after a common word. */
const SPOKEN_LEADING_ARTICLE = "the";

/** Trailing common nouns an operator appends to a team name ("the alpha
 *  team"). Agrees BY CONSTRUCTION with {@link stripSuffix}'s `-team` arm:
 *  both exist so `alpha`, `alpha-team` and "the alpha team" reduce to the
 *  same thing. `-root` is deliberately NOT duplicated here — it is
 *  repo-naming noise, never an English word an operator speaks. */
const SPOKEN_TRAILING_NOUNS = new Set(["team", "teams"]);

/** Possessive clitic ASR emits on a spoken name ("the alpha team's"). */
const POSSESSIVE_RE = /['’]s(?=\b|$)/g;

/**
 * Normalize the SPOKEN form into a hyphen-joined token string directly
 * comparable to a team name: case-fold, drop a possessive clitic, drop a
 * leading article and a trailing "team"/"teams" noun, then join word
 * breaks with `-` — speech gives spaces where the name has hyphens, so
 * "driver 2" and "driver-2" are the same utterance.
 *
 * DELIBERATELY DISTINCT from {@link stripSuffix}, which it is easy to
 * confuse with: `stripSuffix` rewrites a hyphenated NAME (`mx-root` → `mx`)
 * and runs on BOTH sides of rung 3; this rewrites an UTTERANCE and runs on
 * the SPOKEN side only. One handles repo-naming noise, the other handles
 * English filler. Merging them would apply article-stripping to real team
 * names, which is how a team called `the-hive` stops resolving.
 *
 * Filler is only dropped while something is left to match — a team really
 * can be called `team`, and a normalizer that can return the empty string
 * is a rung that matches everything.
 */
export function normalizeSpoken(spoken: string): string {
  let tokens = fold(spoken)
    .replace(POSSESSIVE_RE, "")
    .split(/[\s-]+/)
    .filter((t) => t.length > 0);
  if (tokens.length > 1 && tokens[0] === SPOKEN_LEADING_ARTICLE) tokens = tokens.slice(1);
  const last = tokens[tokens.length - 1];
  if (tokens.length > 1 && last !== undefined && SPOKEN_TRAILING_NOUNS.has(last)) {
    tokens = tokens.slice(0, -1);
  }
  return tokens.join("-");
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
 * Resolve a spoken team name against the index via the ladder (first rung
 * with exactly one hit wins; >1 hits → ambiguous):
 *
 *   1. exact match
 *   2. case-fold match
 *   3. case-fold match after stripping `-root` / `-team` from BOTH sides
 *   4. unique prefix (case-folded spoken prefixes a name)
 *   5. segment run — the normalized utterance is a contiguous run of the
 *      name's `-`-separated segments (ADR-273 §Supplement-8)
 *   6. Levenshtein ≤ {@link RESOLVE_MAX_EDIT_DISTANCE} on case-folded names
 *
 * Rung 5 sits BELOW prefix because a leading-segment match is the more
 * specific claim and that rung's behaviour is already pinned, and ABOVE
 * Levenshtein because a segment run is an EXACT match on token boundaries
 * — letting a fuzzy whole-string typo match outrank a segment the operator
 * actually pronounced would be strictly worse.
 *
 * ONE segment rung, not two. A separate trailing-segment rung above an
 * any-segment rung would resolve "crm" against both `px-geoyws-crm` and
 * `atmux-crm-tools` by preferring the one where the segment happens to be
 * LAST — breaking a real collision on position alone, a fact the operator
 * never uttered. That is a guess wearing a rung's clothes, and this module
 * asks rather than guesses (see file header, ADR-150 §D5). The cost is
 * accepted deliberately: such a collision comes back `ambiguous` with both
 * names, and the operator says one more word.
 */
export function resolveTeamName(index: VoxTeamIndex, spoken: string): ResolveTeamResult {
  const foldedSpoken = fold(spoken);
  if (foldedSpoken.length === 0) return { ok: false, reason: "unknown" };
  const strippedSpoken = stripSuffix(foldedSpoken);
  // Segment-boundary-anchored needle: wrapping BOTH sides in `-` means a
  // plain substring test can only match whole segments, so "e" never hits
  // `vox-e2e-alpha`. `null` only when normalization leaves NOTHING — a
  // punctuation- or whitespace-only utterance — which must then match
  // nothing rather than everything. Note this is NOT the "the alpha team"
  // case: filler is dropped only while a token remains, so "the team"
  // normalizes to `team` and legitimately resolves a name carrying a
  // `team` segment. Both behaviours are pinned in the test file.
  const spokenRun = normalizeSpoken(spoken);
  const segmentNeedle = spokenRun.length > 0 ? `-${spokenRun}-` : null;

  const rungs: Array<(t: VoxTeamEntry) => boolean> = [
    (t) => t.name === spoken,
    (t) => fold(t.name) === foldedSpoken,
    (t) => stripSuffix(fold(t.name)) === strippedSpoken,
    (t) => fold(t.name).startsWith(foldedSpoken),
    (t) => segmentNeedle !== null && `-${fold(t.name)}-`.includes(segmentNeedle),
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
