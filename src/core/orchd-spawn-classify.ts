// ADR-231 §D5 — failure recovery classifier for orchd spawn-epic
// invocation results.
//
// Classifies non-zero `atmux team spawn-epic` exits into three classes
// so the spawn handler (Task T-S2.5, separate file) can apply the
// right recovery posture per ADR-231 §D5:
//
//   | Class             | Action                                           |
//   |-------------------|--------------------------------------------------|
//   | hard              | epics.extra.spawnFailed + flag + NO retry        |
//   | host-pressure     | spawnPressureDeferred++; cron --sweep retries    |
//   | eligibility-race  | silent exit; next epic.ready event re-fires      |
//
// Pure regex matching — no I/O, no side effects. Returns the discriminator
// the spawn handler consumes.
//
// Precedence: when BOTH host-pressure AND eligibility-race signatures
// match (rare — a stderr blob that name-checks both substrates), the
// host-pressure verdict wins. Rationale: host-pressure is the more
// severe operator signal (capacity exhausted vs predicate refusal); the
// recovery posture (cron --sweep retry with no extra noise) is also the
// safer fallback when classification is ambiguous. The opposite
// precedence would risk silently dropping a host-pressure event into
// the eligibility-race silent-exit posture, masking capacity issues.
//
// Cross-refs: [ADR-184](docs/adr/184-host-wide-epic-team-cap-queue-and-dormancy-audit.md)
// owns the `host-wide cap (\d+) reached` refusal signature emitted by
// `src/core/host-pressure.ts` (and the spawn-epic refuse path in
// `src/verbs/team/spawn-epic.ts`); [ADR-225](docs/adr/225-epic-dependencies-and-is-ready-toggle.md)
// owns the `eligible=false: …` refusal signature emitted by
// `epicIsEligible` (`src/core/epic.ts:341+`). This classifier is the
// consumer side — both signature shapes are the contract per ADR-231
// §D5.

/** ADR-231 §D5 result classes. Discriminator drives the spawn-handler's
 *  recovery posture (Task T-S2.5). */
export type SpawnFailureClass = "hard" | "host-pressure" | "eligibility-race";

/** ADR-184 host-wide-cap refusal signature (`/host-wide cap \(\d+\) reached/`).
 *  Whitespace-insensitive between `host-wide`, `cap`, and the digit group
 *  so spawn-epic's wrapper-formatted stderr (e.g. an extra space after
 *  `cap`) still matches. */
const HOST_PRESSURE_RE = /host-wide cap\s*\(\d+\)\s*reached/;

/** ADR-225 eligibility-predicate refusal signature (`/eligible=false: /`).
 *  Anchored on `eligible=false` followed by `:` + space — matches the
 *  formatted blocker line `eligible=false: dep eXXXXXXXX not done`
 *  emitted by `epicIsEligible` per ADR-225 §events. */
const ELIGIBILITY_RACE_RE = /eligible=false:\s/;

/**
 * Classify a `spawn-epic` stderr blob per ADR-231 §D5.
 *
 * Empty / unmatched stderr → `"hard"`. Partial-match (e.g. the substring
 * `host-wide cap` without the `(N) reached` suffix) → `"hard"` because
 * the anchored signature is what the ADR commits to; bare prose drift
 * should not silently degrade into a transient class.
 *
 * Precedence: `host-pressure` > `eligibility-race` > `hard`. When both
 * transient signatures are present, host-pressure wins (see module
 * comment for the rationale).
 *
 * Pure — no I/O, no allocation beyond the regex match result objects
 * Bun/V8 cache. Safe to call on every spawn-epic exit without rate-
 * limiting.
 */
export function classifySpawnFailure(stderr: string): SpawnFailureClass {
  if (stderr.length === 0) return "hard";
  if (HOST_PRESSURE_RE.test(stderr)) return "host-pressure";
  if (ELIGIBILITY_RACE_RE.test(stderr)) return "eligibility-race";
  return "hard";
}
