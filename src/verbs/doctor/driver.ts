import { readTextOrNull } from "../../abstractions/fs.ts";
import { driverInboxPath } from "../../core/common.ts";
import {
  type DriverInboxEntry,
  parseEntries as parseDriverInboxEntries,
} from "../../core/driver-inbox.ts";
import {
  type DriverPaneHealth,
  type ProbeDriverPaneDeps,
  probeDriverPane,
} from "../../core/driver-pane-health.ts";
import { loadKanban } from "../../core/kanban.ts";
import { kanbanWorkStateAvailable } from "../../core/kanban-backend.ts";
import type { Team } from "../../schema/team.ts";
import { type DoctorRow, truncateEvidence } from "./types.ts";

// ---------- ADR-064 §4: driver-pane-state ----------

/** Test injection points for `checkDriverPaneState`. The probe layer
 *  itself is already injectable; this just lets the doctor caller
 *  forward those overrides cleanly. */

export interface CheckDriverPaneStateOpts {
  probeDeps?: ProbeDriverPaneDeps;
  /** Override the probe entirely (single-shot fixture for the check). */
  probe?: (team: Team, atmuxDir: string) => Promise<DriverPaneHealth>;
}

/**
 * ADR-064 §4 + §OQ3 — surface the driver pane's live state as a
 * doctor row. Severity mapping:
 *
 *   - configured=false                                  → no row
 *   - configured=true, windowExists=false               → yellow ("config drift")
 *   - configured=true, state ∈ {READY, TYPING}          → green
 *   - configured=true, state ∈ {RATE-LIMIT, MODAL, COMPACTING} → yellow ("driver pane stuck")
 *   - configured=true, state ∈ {SHELL, UNKNOWN, null}   → yellow ("unexpected state")
 *
 * Single label across all rows: `driver-pane-state`.
 */

export async function checkDriverPaneState(
  team: Team | null,
  atmuxDir: string,
  opts: CheckDriverPaneStateOpts = {},
): Promise<DoctorRow[]> {
  if (team === null) return [];
  const probe = opts.probe ?? ((t, dir) => probeDriverPane(t, dir, opts.probeDeps));
  const health = await probe(team, atmuxDir);

  if (!health.configured) return [];

  if (!health.windowExists) {
    return [
      {
        status: "yellow",
        label: "driver-pane-state",
        detail: "team has driverSession set but no live driver window",
        hint: "run atmux start",
      },
    ];
  }

  if (health.state === "READY" || health.state === "TYPING" || health.state === "BUSY") {
    // BUSY is a healthy transient — the agent is mid-think; turn will
    // complete and pane returns to READY. Treated as green alongside
    // READY/TYPING per ADR-080 §C.
    return [
      {
        status: "green",
        label: "driver-pane-state",
        detail: `state=${health.state}`,
      },
    ];
  }

  if (health.state === null) {
    return [
      {
        status: "yellow",
        label: "driver-pane-state",
        detail: "driver pane capture returned no signal",
        hint: "check tmux server health",
      },
    ];
  }

  if (health.state === "RATE-LIMIT" || health.state === "MODAL" || health.state === "COMPACTING") {
    const evidence = truncateEvidence(health.evidence, 60);
    return [
      {
        status: "yellow",
        label: "driver-pane-state",
        detail: `driver pane stuck in ${health.state}${evidence === "" ? "" : ` (${evidence})`}`,
        hint:
          health.state === "RATE-LIMIT"
            ? "wait for budget refresh"
            : health.state === "MODAL"
              ? "answer the modal in the driver pane"
              : "wait for compaction to finish",
      },
    ];
  }

  // SHELL / UNKNOWN — pane fell back to a shell or pattern catalog
  // didn't match anything. Yellow so the operator investigates.
  const evidence = truncateEvidence(health.evidence, 60);
  return [
    {
      status: "yellow",
      label: "driver-pane-state",
      detail: `driver pane in unexpected state=${health.state}${evidence === "" ? "" : ` (${evidence})`}`,
      hint: "check the driver pane manually",
    },
  ];
}

// ---------- ADR-057 §D5c: inbox-mark verification ----------

/** Marker pattern emitted by lead in driver-inbox: `📤 task <id>`.
 *  ID is whatever the kanban issued (current shape `t-<8 hex>`); we
 *  match conservatively on `t-` + word-chars to tolerate id-shape
 *  evolution without rewriting the regex. */

const INBOX_TASK_MARKER_RE = /📤\s+task\s+(t-[A-Za-z0-9]+)/g;

/** One orphan finding — a task id mentioned in driver-inbox that the
 *  kanban no longer knows about. */

export interface InboxMarkOrphan {
  /** The mentioned task id. */
  id: string;
  /** Snippet of the entry head where the marker appeared. */
  entryHead: string;
}

/**
 * Scan a driver-inbox body for `📤 task <id>` markers and return the set
 * of (id, entry-head) pairs. Used by checkInboxMarks; pure for testability.
 */

export function findInboxTaskMarks(body: string, nowEpochSec: number): InboxMarkOrphan[] {
  const entries = parseDriverInboxEntries(body, nowEpochSec);
  const found: InboxMarkOrphan[] = [];
  for (const e of entries) {
    if (!isInOpenSection(e, body)) continue;
    for (const m of e.body.matchAll(INBOX_TASK_MARKER_RE)) {
      const id = m[1];
      if (id === undefined) continue;
      found.push({ id, entryHead: e.head });
    }
  }
  return found;
}

/** True when the entry head appears under `## Open` and BEFORE any
 *  `## Archive` section. The driver-inbox convention is a top-level
 *  Open / Archive split; archived entries are out of scope per the
 *  brief ("scans driver-inbox `## Open`"). */

function isInOpenSection(entry: DriverInboxEntry, body: string): boolean {
  const headIdx = body.indexOf(entry.head);
  if (headIdx === -1) return true; // defensive — surface rather than skip
  const openIdx = body.search(/^##\s+Open\b/m);
  const archiveIdx = body.search(/^##\s+Archive\b/m);
  // No section markers at all → treat the whole file as Open.
  if (openIdx === -1 && archiveIdx === -1) return true;
  // Archive starts before Open OR no Open marker → only entries before
  // archiveIdx count.
  if (openIdx === -1) return archiveIdx === -1 ? true : headIdx < archiveIdx;
  // Standard layout: Open then Archive. Entry must be after Open marker
  // AND (no Archive yet OR before Archive).
  if (headIdx < openIdx) return false;
  if (archiveIdx === -1) return true;
  return headIdx < archiveIdx;
}

export interface CheckInboxMarksOpts {
  /** epoch-seconds for resolving undated entry heads. Default `Date.now()`. */
  nowEpochSec?: number;
}

/**
 * D5c: scan `## Open` for `📤 task <id>` markers; emit one P3 (yellow)
 * row per id NOT present in kanban.tasks[] (orphan). Absent inbox /
 * absent kanban → no rows (the precondition for orphan detection isn't
 * met, not a finding).
 */

export async function checkInboxMarks(
  atmuxDir: string,
  opts: CheckInboxMarksOpts = {},
): Promise<DoctorRow[]> {
  const inboxBody = await readTextOrNull(driverInboxPath(atmuxDir));
  if (inboxBody === null || inboxBody.length === 0) return [];
  if (!(await kanbanWorkStateAvailable(atmuxDir))) return [];
  const kanban = await loadKanban(atmuxDir);
  const knownIds = new Set(kanban.tasks.map((t) => t.id));
  const nowEpochSec = opts.nowEpochSec ?? Math.floor(Date.now() / 1000);
  const marks = findInboxTaskMarks(inboxBody, nowEpochSec);
  const rows: DoctorRow[] = [];
  const seen = new Set<string>();
  for (const m of marks) {
    if (knownIds.has(m.id)) continue;
    if (seen.has(m.id)) continue; // dedup multiple mentions of the same orphan id
    seen.add(m.id);
    rows.push({
      status: "yellow",
      label: "inbox-mark-orphan",
      detail: `driver-inbox marks ${m.id} done but it's not in kanban (entry: ${truncate(m.entryHead, 60)})`,
      hint: "remove the 📤 marker if the entry is no longer relevant, or restore the task",
    });
  }
  return rows;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
