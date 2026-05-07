// ADR-057 §D2c (Class B): pre-rotate handoff file composer.
//
// When the team-lead's pane is rotated (via `atmux rotate-lead` or
// `atmux rotate <lead-name>`), the OUTGOING lead's session context is
// wiped by `/clear`. Without a handoff snapshot, the incoming lead
// reloads from cold state — re-reads driver-inbox + kanban + decisions
// + state files. That cold reload misses *recent in-flight context*:
// who's working on what right now, what decisions just got applied,
// what state the team is in (Mode B / budget-pause / account-swap).
//
// This module composes a markdown snapshot at
// `<atmuxDir>/state/lead-handoff-<epoch>.md` BEFORE /clear fires. The
// incoming lead's brief (R57-T8 docs Task) extends to read this file
// first; the file is also greppable for postmortems.
//
// Snapshot contents per ADR-057 §D2c:
//   - In-flight Task IDs (kanban scan, status=in-progress)
//   - Last N pending decisions (decisions.md tail)
//   - Last 3 driver-inbox entries summarized (head line only)
//   - Current Mode B / budget-pause / account-swap state (state files)
//
// R3 (no JSON.parse outside abstractions) is honored: the kanban + state
// reads route through their canonical core helpers; decisions.md is a
// markdown file (no schema-gated read) so a tail-N parse via simple
// regex is the right primitive (decisions add-side already gates writes).

import { join } from "node:path";
import { readTextOrNull, writeText } from "../abstractions/fs.ts";
import { formatMyt } from "../abstractions/time.ts";
import { loadAccountSwapState } from "./account-swap.ts";
import { loadBudgetPauseState } from "./budget-pause.ts";
import { driverInboxPath, stateDir } from "./common.ts";
import {
  type DriverInboxEntry,
  lastNEntries,
  parseEntries,
} from "./driver-inbox.ts";
import { readState as readEternalImprovementState } from "./eternal-improvement.ts";
import { listTasks } from "./kanban.ts";

const HANDOFF_FILENAME_PREFIX = "lead-handoff-";
const HANDOFF_FILENAME_SUFFIX = ".md";
const RECENT_DRIVER_INBOX_N = 3;
const RECENT_DECISIONS_N = 5;

/** Resolve `<atmuxDir>/state/lead-handoff-<epochSec>.md`. */
export function leadHandoffPath(atmuxDir: string, epochSec: number): string {
  return join(
    stateDir(atmuxDir),
    `${HANDOFF_FILENAME_PREFIX}${epochSec}${HANDOFF_FILENAME_SUFFIX}`,
  );
}

/**
 * Compose the handoff body. Pure-ish: takes pre-collected ingredients
 * so the writer (`writeLeadHandoff`) is the only side-effecting layer.
 * Exported for direct unit-testing of the markdown shape.
 */
export interface ComposeHandoffArgs {
  team: string;
  /** ISO-ish display timestamp for the file header (formatted MYT). */
  generatedAtMyt: string;
  /** Outgoing lead member name (audit trail). */
  outgoingLead: string;
  /** Tasks currently `in-progress` across the kanban. */
  inFlightTasks: ReadonlyArray<{ id: string; subject: string; owner: string | null }>;
  /** Last N decisions by file order (the most recently appended). */
  recentDecisions: ReadonlyArray<{ id: string; question: string; tsLine: string }>;
  /** Last N driver-inbox entries by file order (head line only — body
   *  excerpts would balloon the handoff size). */
  recentDriverInbox: ReadonlyArray<DriverInboxEntry>;
  /** Mode B (eternal-improvement) snapshot — empty when not active. */
  eternalImprovement?:
    | { active: boolean; budget?: string | undefined; mode?: string | undefined }
    | undefined;
  /** Budget-pause snapshot — empty when not active. */
  budgetPause?:
    | { paused: boolean; pausedAtTs: string; atRiskCount: number }
    | undefined;
  /** Account-swap snapshot — empty when no active swap. */
  accountSwap?: { triggerAccount: string; passId: string; active: boolean } | undefined;
}

export function composeHandoff(args: ComposeHandoffArgs): string {
  const lines: string[] = [];
  lines.push(`# Lead handoff — \`${args.team}\` — ${args.generatedAtMyt}`);
  lines.push("");
  lines.push(`**outgoing lead:** \`${args.outgoingLead}\``);
  lines.push("");

  // ---- In-flight tasks ----
  lines.push("## In-flight tasks");
  lines.push("");
  if (args.inFlightTasks.length === 0) {
    lines.push("- (none)");
  } else {
    for (const t of args.inFlightTasks) {
      const owner = t.owner ?? "(unassigned)";
      lines.push(`- \`${t.id}\` · ${t.subject} · owner=\`${owner}\``);
    }
  }
  lines.push("");

  // ---- Recent decisions ----
  lines.push("## Recent decisions (last 5)");
  lines.push("");
  if (args.recentDecisions.length === 0) {
    lines.push("- (none)");
  } else {
    for (const d of args.recentDecisions) {
      lines.push(`- \`${d.id}\` · ${d.tsLine} · ${d.question}`);
    }
  }
  lines.push("");

  // ---- Recent driver-inbox tips ----
  lines.push("## Recent driver-inbox entries (last 3)");
  lines.push("");
  if (args.recentDriverInbox.length === 0) {
    lines.push("- (none)");
  } else {
    for (const e of args.recentDriverInbox) {
      lines.push(`- ${e.head}`);
    }
  }
  lines.push("");

  // ---- Team state ----
  lines.push("## Team state");
  lines.push("");
  if (args.eternalImprovement?.active === true) {
    lines.push(
      `- 🌱 eternal-improvement: ACTIVE (mode=\`${args.eternalImprovement.mode ?? "?"}\`, budget=\`${args.eternalImprovement.budget ?? "?"}\`)`,
    );
  } else {
    lines.push("- 🌱 eternal-improvement: inactive");
  }
  if (args.budgetPause?.paused === true) {
    lines.push(
      `- 🪫 budget-pause: ACTIVE (since \`${args.budgetPause.pausedAtTs}\`, ${args.budgetPause.atRiskCount} member(s) at-risk)`,
    );
  } else {
    lines.push("- 💰 budget-pause: inactive");
  }
  if (args.accountSwap?.active === true) {
    lines.push(
      `- ♻️ account-swap: ACTIVE pass=\`${args.accountSwap.passId}\` trigger=\`${args.accountSwap.triggerAccount}\``,
    );
  } else {
    lines.push("- ♻️ account-swap: inactive");
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Side-effect entry point: gather ingredients from disk + state files,
 * compose the handoff body, write to `<atmuxDir>/state/lead-handoff-<epoch>.md`.
 *
 * `nowEpochSec` is used both for the file path AND for resolving
 * undated driver-inbox `HH:MM MYT` heads to absolute epochs (via
 * `parseEntries`).
 */
export async function writeLeadHandoff(args: {
  atmuxDir: string;
  team: string;
  outgoingLead: string;
  nowEpochSec: number;
  /** Override clock for the file header timestamp. Defaults to the
   *  `nowEpochSec` value rendered via `formatMyt`. */
  nowMs?: number;
}): Promise<string> {
  const { atmuxDir, team, outgoingLead, nowEpochSec } = args;
  const nowMs = args.nowMs ?? nowEpochSec * 1000;

  // 1. Kanban scan — in-progress tasks.
  const tasks = await listTasks(atmuxDir, { status: "in-progress" });
  const inFlightTasks = tasks.map((t) => ({
    id: t.id,
    subject: t.subject ?? "(no subject)",
    owner: t.owner ?? null,
  }));

  // 2. Decisions tail (last 5).
  const recentDecisions = await readRecentDecisions(atmuxDir, RECENT_DECISIONS_N);

  // 3. Driver-inbox tail (last 3).
  const inboxText = await readTextOrNull(driverInboxPath(atmuxDir));
  const recentDriverInbox =
    inboxText === null
      ? []
      : lastNEntries(parseEntries(inboxText, nowEpochSec), RECENT_DRIVER_INBOX_N);

  // 4. State snapshots.
  const ei = await readEternalImprovementState(atmuxDir);
  const eternalImprovement =
    ei?.active === true
      ? {
          active: true,
          mode: typeof ei.mode === "string" ? ei.mode : undefined,
          budget:
            typeof ei.budgetSpec === "string" ? ei.budgetSpec : undefined,
        }
      : undefined;

  const bp = await loadBudgetPauseState(atmuxDir);
  const budgetPause =
    bp?.paused === true
      ? {
          paused: true,
          pausedAtTs: bp.pausedAtTs,
          atRiskCount: bp.atRisk.length,
        }
      : undefined;

  const swap = await loadAccountSwapState(atmuxDir);
  const accountSwap =
    swap === null
      ? undefined
      : {
          triggerAccount: swap.trigger.account,
          passId: swap.passId,
          active: swap.active,
        };

  const composeArgs: ComposeHandoffArgs = {
    team,
    generatedAtMyt: formatMyt(nowMs),
    outgoingLead,
    inFlightTasks,
    recentDecisions,
    recentDriverInbox,
  };
  if (eternalImprovement !== undefined) composeArgs.eternalImprovement = eternalImprovement;
  if (budgetPause !== undefined) composeArgs.budgetPause = budgetPause;
  if (accountSwap !== undefined) composeArgs.accountSwap = accountSwap;
  const body = composeHandoff(composeArgs);

  const path = leadHandoffPath(atmuxDir, nowEpochSec);
  await writeText(path, body);
  return path;
}

// ---------- Decisions tail parser (markdown, not schema-gated) ----------

const DECISION_HEAD_RE = /^### (d-[a-z0-9]+) — (.+?) \((\d{2}:\d{2} MYT)\)\s*$/;
const DECISION_HEAD_NO_TS_RE = /^### (d-[a-z0-9]+) — (.+)$/;

/**
 * Read the last N `### d-<id>` decision blocks from `decisions.md`.
 * Pure markdown parse — decisions.md doesn't have a Zod schema (R5
 * doesn't apply), and the format is documented in `lib/decisions.sh` /
 * ADR-008. Robust to either inline-timestamp form (with / without
 * trailing `(HH:MM MYT)`).
 */
export async function readRecentDecisions(
  atmuxDir: string,
  n: number,
): Promise<Array<{ id: string; question: string; tsLine: string }>> {
  const path = join(atmuxDir, "decisions.md");
  const txt = await readTextOrNull(path);
  if (txt === null || n <= 0) return [];
  const entries: Array<{ id: string; question: string; tsLine: string }> = [];
  for (const line of txt.split("\n")) {
    const m = line.match(DECISION_HEAD_RE);
    if (m !== null) {
      entries.push({ id: m[1] ?? "", question: m[2] ?? "", tsLine: m[3] ?? "" });
      continue;
    }
    const m2 = line.match(DECISION_HEAD_NO_TS_RE);
    if (m2 !== null) {
      entries.push({ id: m2[1] ?? "", question: m2[2] ?? "", tsLine: "" });
    }
  }
  if (entries.length <= n) return entries;
  return entries.slice(-n);
}
