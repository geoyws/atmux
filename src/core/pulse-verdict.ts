// ADR-086: pure verdict function for the `atmux pulse` cockpit-wide probe.
//
// Single switch on the gathered inputs. Phase 1 deterministic-only —
// Phase 2 will swap an LLM observer in, consuming the SAME input shape
// (so this file's `PulseInputs` interface is the stable contract).
//
// The vocabulary mirrors the verdict vocabulary in CLAUDE.md §Discord:
//   🟢 Shipping   — N commits in window, healthy
//   🟡 Cool       — quiet on purpose (no in-progress, no todos)
//   🟡 Idle       — quiet by accident (todos/in-progress exist, no commits yet)
//   🔴 Stalled    — 0 commits + in-progress ≥1 + window aged past windowMin
//   🚨 Need you   — driver-asks > 0 OR open decisions > 0
//
// Pure. No IO. Every branch reachable from the tests.

/** Discriminated verdict tags returned by `computeVerdict`. */
export type PulseVerdict = "🟢 Shipping" | "🟡 Cool" | "🟡 Idle" | "🔴 Stalled" | "🚨 Need you";

/** Inputs gathered per team by the pulse verb. Stable contract; Phase 2's
 *  LLM observer reads the same shape. */
export interface PulseInputs {
  /** Commits observed in the window. Root repo only, Phase 1. */
  commitCount: number;
  /** RED doctor checks for the team. >0 ≠ catastrophic; we only use it
   *  to decide whether commits "count" as healthy. */
  doctorRed: number;
  /** Kanban inProgress count for the team. */
  inProgressCount: number;
  /** Kanban todo count for the team. */
  todoCount: number;
  /** Open driver-inbox entries older than the stale-driver-ask threshold
   *  (default 30min — see PULSE_DRIVER_INBOX_STALE_MIN). */
  staleDriverInboxCount: number;
  /** Count of pending-decisions.md entries flagged 🔵 Decisions Needed
   *  (the "irreversible / high-blast-radius" tier — the auto-resolution
   *  🟡 tier is not counted here). */
  pendingDecisionsCount: number;
  /** Window minutes that produced commitCount, used to gate "Idle"
   *  vs "Stalled" via `windowAgeMin`. */
  windowMin: number;
  /** How long the team has actually been alive (epoch-seconds delta).
   *  When < windowMin, prefer Idle over Stalled (insufficient window to
   *  call it stalled). When ≥ windowMin, Stalled is in play. */
  windowAgeMin: number;
}

/**
 * Pure verdict from the gathered pulse inputs.
 *
 * Precedence (top wins):
 *   1. 🚨 Need you   — operator action required (asks or open decisions).
 *   2. 🟢 Shipping   — commits landed AND no red doctor finding.
 *   3. 🔴 Stalled    — 0 commits + in-progress ≥1 + window aged past `windowMin`.
 *   4. 🟡 Cool       — 0 commits + nothing in-progress + nothing todo.
 *   5. 🟡 Idle       — 0 commits + (todos OR in-progress) + window too young
 *                       (or unable to determine staleness).
 *
 * "Commits but doctor red" falls through to Stalled/Idle — we don't
 * announce 🟢 over a broken environment.
 */
export function computeVerdict(inputs: PulseInputs): PulseVerdict {
  // 1. Operator-action precedence — wins regardless of commit signal.
  if (inputs.pendingDecisionsCount > 0 || inputs.staleDriverInboxCount > 0) {
    return "🚨 Need you";
  }
  // 2. Healthy shipping — commits + green doctor.
  if (inputs.commitCount >= 1 && inputs.doctorRed === 0) {
    return "🟢 Shipping";
  }
  // 3. Stall — 0 commits AND something queued AND window has aged enough.
  if (
    inputs.commitCount === 0 &&
    inputs.inProgressCount >= 1 &&
    inputs.windowAgeMin >= inputs.windowMin
  ) {
    return "🔴 Stalled";
  }
  // 4. Deliberate quiet — nothing in flight at all.
  if (inputs.commitCount === 0 && inputs.inProgressCount === 0 && inputs.todoCount === 0) {
    return "🟡 Cool";
  }
  // 5. Default — work exists, no commits yet, window too young to stall.
  return "🟡 Idle";
}

/**
 * One-line operator-readable verdict body string, ≤80 chars per the
 * Discord verdict-first spec (CLAUDE.md §Discord). The renderer at
 * `src/abstractions/discord.ts` consumes this verbatim as the verdict
 * line; this module keeps the strings co-located with the branch
 * logic so a new branch can't ship without its label.
 *
 * Examples:
 *   computeVerdict + describeVerdict({verdict:"🟢 Shipping", commitCount:3, ...}) →
 *     "🟢 **Shipping** — 3 commits in 30min, doctor green"
 *   describeVerdict({verdict:"🚨 Need you", staleDriverInboxCount:2, pendingDecisionsCount:1, ...}) →
 *     "🚨 **Need you** — 2 stale driver-ask(s), 1 open decision(s)"
 */
export function describeVerdict(inputs: PulseInputs, verdict: PulseVerdict): string {
  switch (verdict) {
    case "🟢 Shipping": {
      const noun = inputs.commitCount === 1 ? "commit" : "commits";
      return `🟢 **Shipping** — ${inputs.commitCount} ${noun} in ${inputs.windowMin}min, doctor green`;
    }
    case "🟡 Cool":
      return `🟡 **Cool** — quiet on purpose (kanban empty, no commits in ${inputs.windowMin}min)`;
    case "🟡 Idle": {
      const totalQueued = inputs.todoCount + inputs.inProgressCount;
      return `🟡 **Idle** — ${totalQueued} task(s) queued, 0 commits in ${inputs.windowMin}min`;
    }
    case "🔴 Stalled":
      return `🔴 **Stalled** — ${inputs.inProgressCount} in-progress, 0 commits in ${inputs.windowMin}min`;
    case "🚨 Need you": {
      const parts: string[] = [];
      if (inputs.staleDriverInboxCount > 0) {
        parts.push(`${inputs.staleDriverInboxCount} stale driver-ask(s)`);
      }
      if (inputs.pendingDecisionsCount > 0) {
        parts.push(`${inputs.pendingDecisionsCount} open decision(s)`);
      }
      return `🚨 **Need you** — ${parts.join(", ")}`;
    }
  }
}
