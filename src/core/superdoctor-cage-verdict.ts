// t-72a6b7d7 / c-a99bf461: cage-presence verdict classifier for medic /
// superdoctor sweeps.
//
// Pre-flag: medic interpreted "team enabled but cage socket missing"
// as universal anomaly — couldn't distinguish "operator intentionally
// torn the cage down (direct mode)" from "cage crashed".
//
// Post-flag (this module): the verdict is a cross-product of
// `cageMode` (operator intent declared in cockpit.json) × `sessionAlive`
// (live tmux socket probe). The pre-flag behaviour is preserved for
// configs without `cageMode` (defaults to `autonomous`) — every legacy
// roster keeps reporting the same colours.
//
// Consumed by the medic skill (~/.claude/skills/medic/) via
// `atmux audit --json` output; the audit verb wires this classifier
// when surfacing per-team cage state. Pure modulo no IO — given the
// inputs, returns a deterministic verdict; tests cover the 6-cell
// cross-product.

import type { CockpitTeamCageMode } from "../schema/cockpit.ts";

/** Verdict colours, mirroring the green/yellow/red taxonomy the
 *  medic skill writes to its sweep summary + Discord pings. */
export type CageVerdict = "green" | "yellow" | "red";

export interface CageVerdictResult {
  /** Colour bucket for the row. */
  verdict: CageVerdict;
  /** One-line operator-readable reason. Stable strings — the medic
   *  skill's regex-based deduper keys on these. */
  reason: string;
  /** True iff the operator (or supervisor) should act on this row.
   *  Drives medic's "escalate to driver?" gate — `false` means the
   *  row is informational only. */
  actionable: boolean;
}

/**
 * Classify a team's cage-presence as green / yellow / red given:
 *
 *   - `cageMode` (default `"autonomous"` when undefined — matches the
 *     schema default + back-compat with pre-t-72a6b7d7 cockpit.json files)
 *   - `sessionAlive` — live probe result: did the team's cage tmux
 *     session respond to `hasSession()`?
 *
 * Cross-product (defaults to `"autonomous"` when `cageMode` is missing):
 *
 *   | cageMode    | sessionAlive=true        | sessionAlive=false               |
 *   |-------------|--------------------------|----------------------------------|
 *   | autonomous  | 🟢 cage healthy          | 🔴 cage missing (anomaly)        |
 *   | direct      | 🟡 unexpected cage       | 🟢 direct-driver mode (intent)   |
 *   | paused      | 🟡 paused-but-running    | 🟡 paused (informational)        |
 *
 * The verdict is deterministic; tests cover all 6 cells. Reason
 * strings are stable contract — the medic skill's stderr / Discord
 * dedup keys on these literals.
 */
export function verdictForCage(
  cageMode: CockpitTeamCageMode | undefined,
  sessionAlive: boolean,
): CageVerdictResult {
  const mode: CockpitTeamCageMode = cageMode ?? "autonomous";
  switch (mode) {
    case "autonomous":
      return sessionAlive
        ? { verdict: "green", reason: "cage healthy (autonomous)", actionable: false }
        : {
            verdict: "red",
            reason: "cage missing — autonomous team expected a live socket",
            actionable: true,
          };
    case "direct":
      return sessionAlive
        ? {
            verdict: "yellow",
            reason: "direct-driver team has an unexpected live cage — confirm intent",
            actionable: false,
          }
        : { verdict: "green", reason: "direct-driver mode (no cage by design)", actionable: false };
    case "paused":
      return sessionAlive
        ? {
            verdict: "yellow",
            reason: "paused team has a live cage — clear pause or tear down",
            actionable: false,
          }
        : {
            verdict: "yellow",
            reason: "paused — restart on next `atmux cockpit rebuild`",
            actionable: false,
          };
  }
}
