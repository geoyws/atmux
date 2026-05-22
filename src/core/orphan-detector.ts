// ADR-222 §D4 — pure orphan classifier.
//
// `classifyOrphans(manifest, discovery, seenState)` consumes the
// cockpit-anchored manifest + the raw discovery bag from
// `topo-aggregate.ts` and emits zero-or-more orphan rows along with
// the updated seen-state record. Pure: no IO, no clock reads
// (anchors on `discovery.generated_at`), deterministic for fixed
// inputs.
//
// Six orphan classes per ADR-222 §D4 table:
//   1. `cage-tmux-without-registry`    — alive cage socket, no
//                                        cockpit/kanban entry
//   2. `cron-block-without-worktree`   — marker cron block, ATMUX_DIR
//                                        gone
//   3. `worktree-without-cage`         — worktree on disk, no cage +
//                                        no cockpit entry
//   4. `branch-without-row`            — branch `<base>-epic-<eid>`
//                                        exists, no kanban + no
//                                        cockpit + no worktree
//   5. `kanban-epic-without-cage`      — kanban epic in-progress, no
//                                        cage + no worktree
//   6. `cockpit-registry-without-cage` — registry lists eid, cage
//                                        gone ≥5 min
//
// Carve-outs (NEVER emitted as orphans):
//   - Soft-stopped teams (ADR-087): `cage_alive: false` AS-INTENDED;
//     classes 5 + 6 skip when `soft_stopped: true`.
//   - 30s grace: every candidate must be observed in seenState for
//     ≥30s before being emitted (class 6 raises this to 5min per the
//     §D4 table threshold).
//   - Pre-spawn race: same 30s grace mechanism — the classifier never
//     emits on first observation.
//
// State file at `~/.atmux/state/topo-orphan-seen.json` per §D4 + DoD.
// Shape:
//   { schema_version: 1, generated_at: ISO, entries: { "<class>::<ref>":
//     ISO } }
// TTL eviction at 7d: any entry whose key is no longer a candidate
// AND whose timestamp is >7d behind `discovery.generated_at` is
// dropped from the returned `updatedSeenState`.
//
// Output ordering: deterministic `(class, ref)` sort per the DoD —
// the cockpit-mirror diff loop pins on stable orphan order.

import type {
  Discovery,
  ParentDiscovery,
  TopoEpic,
  TopoManifest,
  TopoOrphan,
  TopoTeam,
} from "./topo-aggregate.ts";

// ---------- Seen-state shape (~/.atmux/state/topo-orphan-seen.json) ----------

/** Persistent first-observation record. Loaded outside the classifier
 *  by the verb-layer composer; the classifier returns an updated copy
 *  that the verb writes back. */
export interface SeenState {
  schema_version: 1;
  /** ISO 8601 UTC of last classifier run. */
  generated_at: string;
  /** Map of `<class>::<ref>` → ISO of first observation. */
  entries: Record<string, string>;
}

/** Initial empty seen-state. Returned by the verb-layer composer when
 *  no seen-state file exists yet. */
export function emptySeenState(generatedAt: Date): SeenState {
  return {
    schema_version: 1,
    generated_at: generatedAt.toISOString(),
    entries: {},
  };
}

// ---------- Orphan class enum (the §D4 stable literal set) ----------

export type OrphanClass =
  | "cage-tmux-without-registry"
  | "cron-block-without-worktree"
  | "worktree-without-cage"
  | "branch-without-row"
  | "kanban-epic-without-cage"
  | "cockpit-registry-without-cage";

// ---------- Grace ladder (§D4 carve-outs) ----------

/** Default 30s grace — applies to every class unless overridden. */
const DEFAULT_GRACE_MS = 30_000;

/** Class-6 carve-out: cage absent for ≥5 min before flagging. */
const CLASS_6_GRACE_MS = 5 * 60 * 1000;

/** TTL eviction window for seenState entries no longer candidates. */
const SEEN_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function graceForClass(cls: OrphanClass): number {
  return cls === "cockpit-registry-without-cage" ? CLASS_6_GRACE_MS : DEFAULT_GRACE_MS;
}

// ---------- Internal candidate shape ----------

interface OrphanCandidate {
  cls: OrphanClass;
  ref: string;
  atmux_dir: string | undefined;
  details: string;
  reap_hint: string | undefined;
}

// ---------- Public entry ----------

/** Pure orphan classifier. Same `(manifest, discovery, seenState)` →
 *  same `(orphans, updatedSeenState)`. Per ADR-222 §D4 + DoD. */
export function classifyOrphans(
  manifest: TopoManifest,
  discovery: Discovery,
  seenState: SeenState,
): { orphans: TopoOrphan[]; updatedSeenState: SeenState } {
  const now = discovery.generated_at;
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  const candidates: OrphanCandidate[] = [];
  candidates.push(...detectCageWithoutRegistry(manifest, discovery));
  candidates.push(...detectCronBlockWithoutWorktree(discovery));
  candidates.push(...detectWorktreeWithoutCage(manifest, discovery));
  candidates.push(...detectBranchWithoutRow(manifest, discovery));
  candidates.push(...detectKanbanEpicWithoutCage(manifest, discovery));
  candidates.push(...detectCockpitRegistryWithoutCage(manifest));

  // Update seenState + emit only candidates past their per-class grace.
  const newEntries: Record<string, string> = {};
  const orphans: TopoOrphan[] = [];

  // First pass: record + emit per candidate.
  const candidateKeys = new Set<string>();
  for (const c of candidates) {
    const key = `${c.cls}::${c.ref}`;
    candidateKeys.add(key);
    const prevIso = seenState.entries[key];
    const firstSeenIso = prevIso ?? nowIso;
    newEntries[key] = firstSeenIso;

    const firstSeenMs = new Date(firstSeenIso).getTime();
    const ageMs = nowMs - firstSeenMs;
    if (ageMs >= graceForClass(c.cls)) {
      const row: TopoOrphan = {
        class: c.cls,
        ref: c.ref,
        details: c.details,
        first_seen: firstSeenIso,
      };
      if (c.atmux_dir !== undefined) row.atmux_dir = c.atmux_dir;
      if (c.reap_hint !== undefined) row.reap_hint = c.reap_hint;
      orphans.push(row);
    }
  }

  // Second pass: TTL-evict stale seen-state entries that are no longer
  // candidates AND have aged out of the 7d window.
  for (const [key, iso] of Object.entries(seenState.entries)) {
    if (candidateKeys.has(key)) continue; // already preserved above
    const ageMs = nowMs - new Date(iso).getTime();
    if (ageMs < SEEN_STATE_TTL_MS) {
      newEntries[key] = iso;
    }
  }

  // Deterministic ordering: (class, ref).
  orphans.sort((a, b) => a.class.localeCompare(b.class) || a.ref.localeCompare(b.ref));

  return {
    orphans,
    updatedSeenState: {
      schema_version: 1,
      generated_at: nowIso,
      entries: newEntries,
    },
  };
}

// ---------- Class 1: cage-tmux-without-registry ----------

function detectCageWithoutRegistry(
  manifest: TopoManifest,
  discovery: Discovery,
): OrphanCandidate[] {
  const out: OrphanCandidate[] = [];
  const parentNames = new Set(manifest.teams.map((t) => t.name));
  const knownEpics = new Set<string>();
  for (const t of manifest.teams) {
    for (const e of t.epics) {
      knownEpics.add(`${t.name}::${e.eid}`);
    }
  }
  for (const s of discovery.global.sockets_alive) {
    if (s.eid === null) {
      // Parent-cage socket.
      if (!parentNames.has(s.parent)) {
        out.push({
          cls: "cage-tmux-without-registry",
          ref: s.parent,
          atmux_dir: undefined,
          details: `parent cage tmux alive at ${s.socket}; '${s.parent}' not in cockpit teams[]`,
          reap_hint: `tmux -S ${s.socket} kill-server`,
        });
      }
    } else {
      // Epic-cage socket.
      const key = `${s.parent}::${s.eid}`;
      if (!knownEpics.has(key)) {
        out.push({
          cls: "cage-tmux-without-registry",
          ref: s.eid,
          atmux_dir: undefined,
          details: `epic-team cage tmux alive at ${s.socket}; ${s.eid} not in cockpit sessions[] under '${s.parent}'`,
          reap_hint: `atmux team dissolve-epic ${s.eid} --skip-checks`,
        });
      }
    }
  }
  return out;
}

// ---------- Class 2: cron-block-without-worktree ----------

function detectCronBlockWithoutWorktree(discovery: Discovery): OrphanCandidate[] {
  if (discovery.global.cron_marker_blocks === null) return [];
  const out: OrphanCandidate[] = [];
  for (const b of discovery.global.cron_marker_blocks) {
    if (!b.atmux_dir_exists) {
      out.push({
        cls: "cron-block-without-worktree",
        ref: b.ref,
        atmux_dir: b.atmux_dir,
        details: `marker-fenced cron block for ${b.ref}; ATMUX_DIR=${b.atmux_dir} no longer exists on disk`,
        reap_hint: `atmux cron-reaper --scope ${b.ref} --apply`,
      });
    }
  }
  return out;
}

// ---------- Class 3: worktree-without-cage ----------

function detectWorktreeWithoutCage(
  manifest: TopoManifest,
  discovery: Discovery,
): OrphanCandidate[] {
  const out: OrphanCandidate[] = [];
  for (const pd of discovery.parents) {
    const teamRow = findTeam(manifest, pd.name);
    for (const w of pd.worktrees_on_disk) {
      const epicRow = teamRow?.epics.find((e) => e.eid === w.eid);
      const cageAlive = epicRow?.cage_alive === true;
      const inCockpit = epicRow !== undefined;
      if (!cageAlive && !inCockpit) {
        out.push({
          cls: "worktree-without-cage",
          ref: w.eid,
          atmux_dir: `${w.path}/.atmux`,
          details: `worktree on disk at ${w.path}; no cage tmux alive AND no cockpit entry under parent '${w.parent}'`,
          reap_hint: `rm -rf ${w.path}`,
        });
      }
    }
  }
  return out;
}

// ---------- Class 4: branch-without-row ----------

function detectBranchWithoutRow(manifest: TopoManifest, discovery: Discovery): OrphanCandidate[] {
  const out: OrphanCandidate[] = [];
  for (const pd of discovery.parents) {
    const teamRow = findTeam(manifest, pd.name);
    const cockpitEids = new Set(teamRow?.epics.map((e) => e.eid) ?? []);
    const worktreeEids = new Set(pd.worktrees_on_disk.map((w) => w.eid));
    const kanbanEids = new Set(pd.kanban_epic_rows?.map((r) => r.eid) ?? []);
    for (const b of pd.branches) {
      const inCockpit = cockpitEids.has(b.eid);
      const onDisk = worktreeEids.has(b.eid);
      // When kanban_epic_rows is null we can't tell — conservatively
      // treat that as "kanban-present" to skip false-positives.
      const inKanban = pd.kanban_epic_rows === null ? true : kanbanEids.has(b.eid);
      if (!inCockpit && !onDisk && !inKanban) {
        out.push({
          cls: "branch-without-row",
          ref: b.branch,
          atmux_dir: undefined,
          details: `branch ${b.branch} on '${pd.name}' has no cockpit entry, no worktree, no kanban row`,
          reap_hint: `git -C ${pd.root} branch -D ${b.branch}`,
        });
      }
    }
  }
  return out;
}

// ---------- Class 5: kanban-epic-without-cage ----------

function detectKanbanEpicWithoutCage(
  manifest: TopoManifest,
  discovery: Discovery,
): OrphanCandidate[] {
  const out: OrphanCandidate[] = [];
  for (const pd of discovery.parents) {
    if (pd.kanban_epic_rows === null) continue;
    const teamRow = findTeam(manifest, pd.name);
    const worktreeEids = new Set(pd.worktrees_on_disk.map((w) => w.eid));
    for (const row of pd.kanban_epic_rows) {
      if (row.status !== "in-progress") continue;
      const epicRow = teamRow?.epics.find((e) => e.eid === row.eid);
      // Soft-stopped carve-out (ADR-087 + §D4).
      if (epicRow?.soft_stopped === true) continue;
      const cageAlive = epicRow?.cage_alive === true;
      const onDisk = worktreeEids.has(row.eid);
      if (!cageAlive && !onDisk) {
        out.push({
          cls: "kanban-epic-without-cage",
          ref: row.eid,
          atmux_dir: undefined,
          details: `parent '${pd.name}' kanban epic ${row.eid} in-progress; no cage AND no worktree`,
          reap_hint: "review epic — re-spawn (atmux team spawn-epic) or mark wontfix",
        });
      }
    }
  }
  return out;
}

// ---------- Class 6: cockpit-registry-without-cage ----------

function detectCockpitRegistryWithoutCage(manifest: TopoManifest): OrphanCandidate[] {
  const out: OrphanCandidate[] = [];
  for (const t of manifest.teams) {
    for (const e of t.epics) {
      // Soft-stopped carve-out: cage_alive: false is intended.
      if (e.soft_stopped === true) continue;
      if (e.cage_alive) continue;
      out.push({
        cls: "cockpit-registry-without-cage",
        ref: e.eid,
        atmux_dir: e.atmux_dir,
        details: `cockpit lists ${e.eid} under '${t.name}'; cage socket gone (alive: false)`,
        reap_hint: `atmux team dissolve-epic ${e.eid}`,
      });
    }
  }
  return out;
}

// ---------- Internal helpers ----------

function findTeam(manifest: TopoManifest, name: string): TopoTeam | undefined {
  return manifest.teams.find((t) => t.name === name);
}

// Re-exports for ergonomic test imports / verb-layer composition.
export type { Discovery, ParentDiscovery, TopoEpic, TopoManifest, TopoOrphan, TopoTeam };
