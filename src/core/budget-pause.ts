// ADR-053 §D2: budget-pause state-file primitives.
//
// Mirrors bash `lib/whip.sh::_atmux_whip_budget_pause_*` helpers. State
// file lives at `<atmuxDir>/state/budget-pause.json` (bash-byte-
// identical shape so the bash runtime can read pause state during the
// transition window).
//
// Schema:
//   {
//     "paused": true,
//     "pausedAt": <epoch-seconds>,
//     "pausedAtTs": "<HH:MM MYT formatted ts>",
//     "atRisk": [
//       { "member": "<name>", "h5": <pct-used 0..100>, "wk": <pct-used 0..100> }
//     ]
//   }
//
// Lifetime: written on entry, re-read every tick to drive the should-
// resume gate, deleted on resume. The bash version's `paused: false`
// resting state isn't represented here — file absence == not paused.
//
// The verb layer (`src/verbs/whip.ts`) composes these primitives with
// `atmux pause` / `atmux resume` / `atmux handoff` calls; this module
// is pure state I/O.

import { join } from "node:path";
import { atomicWrite, readTextOrNull, removeFile } from "../abstractions/fs.ts";

/** Per-member at-risk record carried in the state file. */
export interface AtRiskMember {
  /** Member name (matches team.json::members[].name). */
  member: string;
  /** 5h utilization, 0–100 integer pct used (NOT remaining). */
  h5: number;
  /** 7d utilization, 0–100 integer pct used. */
  wk: number;
}

/** Full state-file shape per ADR-053 §D2 (bash-compatible). */
export interface BudgetPauseState {
  paused: true;
  /** Epoch seconds. */
  pausedAt: number;
  /** Pre-formatted `HH:MM MYT` timestamp from the firing tick. */
  pausedAtTs: string;
  /** Roster captured at pause-entry — used by the resume Discord ping. */
  atRisk: ReadonlyArray<AtRiskMember>;
}

const STATE_FILENAME = "budget-pause.json";

/** Resolve canonical state-file path. */
export function budgetPauseStatePath(atmuxDir: string): string {
  return join(atmuxDir, "state", STATE_FILENAME);
}

/** Read state if present; returns null when absent OR malformed. The
 *  loose decode mirrors bash's `[[ -f ]] && jq` short-circuit — neither
 *  side throws on absence. */
export async function loadBudgetPauseState(atmuxDir: string): Promise<BudgetPauseState | null> {
  const path = budgetPauseStatePath(atmuxDir);
  const txt = await readTextOrNull(path);
  if (txt === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(txt);
  } catch {
    return null; // corrupt state — treat as not paused; next tick rewrites if needed
  }
  if (!isPauseState(parsed)) return null;
  return parsed;
}

/** True iff a valid pause state file is present and `paused === true`. */
export async function isBudgetPauseActive(atmuxDir: string): Promise<boolean> {
  const s = await loadBudgetPauseState(atmuxDir);
  return s !== null && s.paused === true;
}

/** Atomically write a fresh pause state file. */
export async function writeBudgetPauseState(
  atmuxDir: string,
  state: BudgetPauseState,
): Promise<void> {
  const path = budgetPauseStatePath(atmuxDir);
  await atomicWrite(path, JSON.stringify(state));
}

/** Remove the pause state file (idempotent — absence is fine). */
export async function clearBudgetPauseState(atmuxDir: string): Promise<void> {
  const path = budgetPauseStatePath(atmuxDir);
  await removeFile(path);
}

// ---------- Internal ----------

function isPauseState(v: unknown): v is BudgetPauseState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.paused !== true) return false;
  if (typeof o.pausedAt !== "number") return false;
  if (typeof o.pausedAtTs !== "string") return false;
  if (!Array.isArray(o.atRisk)) return false;
  for (const r of o.atRisk) {
    if (typeof r !== "object" || r === null) return false;
    const m = r as Record<string, unknown>;
    if (typeof m.member !== "string") return false;
    if (typeof m.h5 !== "number") return false;
    if (typeof m.wk !== "number") return false;
  }
  return true;
}
