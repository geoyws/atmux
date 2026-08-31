// ADR-223 §D2-§D5 — pure orphan-reap orchestrator.
//
// `reapOrphans(orphans, opts): Promise<ReapResult>` composes the 5
// canonical per-class reap primitives over the orphan rows emitted by
// `src/core/orphan-detector.ts`. NEVER re-implements destruction —
// every destructive call dispatches through {@link ReapDeps} which
// the verb layer (t-3553f189) wires to the production primitives.
//
// Composition map per ADR-223 §D2 (post-2026-05-22 amendment):
//
//   cage-tmux-without-registry    → killCageServer(socket)
//   cron-block-without-worktree   → cronReaperReap(scope)
//   worktree-without-cage         → rmZombieWorktree(path)         [reapZombieWorktree]
//   branch-without-row            → deleteBranch(repoPath, branch) [gate-3 first]
//   kanban-epic-without-cage      → SURFACE-ONLY (never auto-reaped)
//   cockpit-registry-without-cage → removeRegistryEntry(eid)
//
// `dissolveEpic` is intentionally NOT in the composition map per the
// reviewer audit 2026-05-22 — it always refuses on a cage-tmux-without-
// registry row (orphan IS the missing registry entry, dissolveEpic
// looks up `<eid>` in cockpit, finds nothing, aborts). The two-pass
// cascade replaces it: tmux kill-server first, then next-pass re-
// classifies residue as branch-without-row + worktree-without-cage.
//
// Order per ADR-223 §D2 (cheapest first, biggest blast last):
//   1. cron-block-without-worktree
//   2. cockpit-registry-without-cage
//   3. branch-without-row
//   4. worktree-without-cage
//   5. cage-tmux-without-registry
//   (kanban-epic-without-cage is skipped — surface-only)
//
// Four gates per ADR-223 §D3:
//   - Gate 1 (active-check): bypassed by `--skip-checks` (operator-explicit)
//   - Gate 2 (parent-kind):  STRUCTURAL — compile-time discriminated
//                            union on `TopoOrphan.kind`; never bypassed
//   - Gate 3 (merge-base):   NEVER bypassed per reviewer audit (preserves
//                            ADR-219 §D2 unmerged-work invariant)
//   - Gate 4 (interactive):  deferred to the verb layer (t-3553f189)
//
// Idempotency per §D4: re-running with no new orphans is a no-op
// (underlying primitives are themselves idempotent on missing target).
// Mid-cascade per-orphan failure is collected into `failed[]` without
// blocking remaining orphans.
//
// Reap-log per §OQ5: one append-only JSONL line per reaped orphan to
// `~/.atmux/state/reap-log.jsonl` (`schema_version: 1` stamp per row).
// The verb layer owns the file path; this module receives an injected
// {@link AppendReapLogFn} so unit tests stay pure.

import type { TopoOrphan } from "./topo-aggregate.ts";

// ---------- Orphan class enum (re-exported for ergonomic dispatch) ----------

export type OrphanClass =
  | "cage-tmux-without-registry"
  | "cron-block-without-worktree"
  | "worktree-without-cage"
  | "branch-without-row"
  | "kanban-epic-without-cage"
  | "cockpit-registry-without-cage";

const REAP_ORDER: readonly OrphanClass[] = [
  "cron-block-without-worktree",
  "cockpit-registry-without-cage",
  "branch-without-row",
  "worktree-without-cage",
  "cage-tmux-without-registry",
  // kanban-epic-without-cage intentionally omitted — surface-only.
];

// ---------- Gate-2 narrowing ----------

/** A {@link TopoOrphan} that has passed Gate 2 (kind === "epic").
 *  Compile-time enforced via the discriminated union on `kind`. The
 *  parent-kind branch (`kind === "parent"`) is refused at runtime
 *  with `gate-2-parent-kind` so contrived inputs never reach a
 *  destructive primitive call. */
export type ReapableOrphan = TopoOrphan & { kind: "epic" };

// ---------- Reap-log shape ----------

/** Append-only JSONL row per ADR-223 §OQ5. Stamped with
 *  `schema_version: 1`; additive evolution within the integer. */
export interface ReapLogEntry {
  schema_version: 1;
  timestamp: string;
  orphan_class: OrphanClass;
  ref: string;
  primitive: string;
  result: "ok" | "failed";
  /** Free-form failure reason; omitted on success. */
  error?: string;
}

// ---------- Result shape ----------

export interface ReapEntry {
  orphan: TopoOrphan;
  primitive?: string;
  /** Why this orphan was placed in the corresponding bucket. */
  reason?: string;
  /** Subset of {@link ReapLogEntry.error}. */
  error?: string;
}

export interface ReapResult {
  /** Orphans whose primitive call returned ok. */
  reaped: ReapEntry[];
  /** Skipped intentionally — surface-only classes (class 5), `--dry-run`,
   *  or `--class` filter excludes them. */
  skipped: ReapEntry[];
  /** Refused by a safety gate (1 / 2 / 3). */
  refused: ReapEntry[];
  /** Primitive call threw / returned an error mid-cascade. Remaining
   *  orphans in the cascade continue. */
  failed: ReapEntry[];
  /** Pretty `bypassed: <gate-name>` rows per ADR-223 §D3 logging
   *  convention — used by the verb-layer to print a footer. */
  bypassed: Array<{ gate: string; ref: string }>;
}

// ---------- Injectable primitives ----------

/** The 5 canonical reap primitives + the 3 gate probes. All injected;
 *  tests stub each with a recorded mock. */
export interface ReapDeps {
  killCageServer(socket: string): Promise<void>;
  cronReaperReap(scope: string): Promise<void>;
  rmZombieWorktree(path: string): Promise<void>;
  deleteBranch(repoPath: string, branch: string): Promise<void>;
  removeRegistryEntry(eid: string): Promise<void>;

  /** Gate 1: returns true iff the cage socket has any session with
   *  attached_clients>0 OR last-output within 5 minutes. */
  isCageActive(socket: string): Promise<boolean>;
  /** Gate 1: returns true iff the worktree has uncommitted changes
   *  OR a commit within 5 minutes. */
  isWorktreeActive(worktreePath: string): Promise<boolean>;
  /** Gate 3: returns true iff `branch` is fully merged into `base`. */
  isBranchMerged(repoPath: string, base: string, branch: string): Promise<boolean>;

  appendReapLog(entry: ReapLogEntry): Promise<void>;
  now(): Date;
}

// ---------- Reap options ----------

export interface ReapOpts {
  deps: ReapDeps;
  /** Default true. `false` only when `--apply` was passed. */
  dryRun?: boolean;
  /** `--skip-checks`: cascade to Gate 1 ONLY (active-check). Per the
   *  reviewer audit 2026-05-22 the bypass NEVER cascades to Gate 2
   *  (structural) or Gate 3 (merge-base / ADR-219 §D2 invariant). */
  skipChecks?: boolean;
  /** `--class <name>` filter: when set, only orphans matching this
   *  class enter the cascade; others go to `skipped[]` with reason
   *  `class-filter`. */
  classFilter?: OrphanClass;
  /** Per-class extras the primitives need (passed through verbatim).
   *  Branch-delete needs the trunk base name + repo path lookup; the
   *  verb layer threads this in. */
  repoPathForBranch?(branch: string): string;
  baseBranchForBranch?(branch: string): string;
  worktreePathForOrphan?(orphan: ReapableOrphan): string;
  cageSocketForOrphan?(orphan: ReapableOrphan): string;
}

// ---------- Entry point ----------

/** Pure orchestrator — same `(orphans, opts)` → same {@link ReapResult}
 *  given deterministic `deps`. Throws ONLY on a programmer-bug input
 *  (e.g., orphan with an unknown class); per-primitive failures land
 *  in `failed[]` and the cascade continues. */
export async function reapOrphans(
  orphans: ReadonlyArray<TopoOrphan>,
  opts: ReapOpts,
): Promise<ReapResult> {
  const result: ReapResult = {
    reaped: [],
    skipped: [],
    refused: [],
    failed: [],
    bypassed: [],
  };

  // Order the cascade per §D2 + filter on --class.
  const ordered: TopoOrphan[] = [];
  for (const cls of REAP_ORDER) {
    if (opts.classFilter !== undefined && opts.classFilter !== cls) continue;
    for (const o of orphans) {
      if (o.class === cls) ordered.push(o);
    }
  }
  // Class 5 surface-only — emit into skipped[].
  for (const o of orphans) {
    if (o.class === "kanban-epic-without-cage") {
      result.skipped.push({
        orphan: o,
        reason: "surface-only (ADR-223 §D2 row 5 — never auto-reaped)",
      });
    }
  }
  // Orphans excluded by --class filter (other than class 5 above).
  if (opts.classFilter !== undefined) {
    for (const o of orphans) {
      if (o.class === opts.classFilter) continue;
      if (o.class === "kanban-epic-without-cage") continue; // already in skipped above
      result.skipped.push({ orphan: o, reason: `class-filter excludes ${o.class}` });
    }
  }

  // Cascade.
  for (const orphan of ordered) {
    await reapOne(orphan, opts, result);
  }

  return result;
}

async function reapOne(orphan: TopoOrphan, opts: ReapOpts, result: ReapResult): Promise<void> {
  // Gate 2 (structural / parent-kind) — fires BEFORE any other gate.
  if (orphan.kind !== "epic") {
    result.refused.push({
      orphan,
      reason: "gate-2-parent-kind (kind !== 'epic'; parent teardown is `atmux team rm`, not reap)",
    });
    return;
  }
  // Now narrowed to ReapableOrphan.
  const reapable = orphan as ReapableOrphan;

  // Dry-run short-circuit — Gate 4 deferred (verb-layer owns prompt);
  // dryRun: true means "list what WOULD be reaped" so we route into
  // skipped[] with the primitive that would have fired.
  if (opts.dryRun === true) {
    result.skipped.push({
      orphan,
      primitive: primitiveLabel(reapable.class as Exclude<OrphanClass, "kanban-epic-without-cage">),
      reason: "dry-run",
    });
    return;
  }

  // Gate 1 (active-check) — applies to cage + worktree classes.
  if (reapable.class === "cage-tmux-without-registry") {
    const socket = opts.cageSocketForOrphan?.(reapable);
    if (socket !== undefined && (await opts.deps.isCageActive(socket))) {
      if (opts.skipChecks === true) {
        result.bypassed.push({ gate: "gate-1-active-check", ref: reapable.ref });
      } else {
        result.refused.push({ orphan, reason: "gate-1-active-check (cage has active session)" });
        return;
      }
    }
  }
  if (reapable.class === "worktree-without-cage") {
    const wt = opts.worktreePathForOrphan?.(reapable);
    if (wt !== undefined && (await opts.deps.isWorktreeActive(wt))) {
      if (opts.skipChecks === true) {
        result.bypassed.push({ gate: "gate-1-active-check", ref: reapable.ref });
      } else {
        result.refused.push({
          orphan,
          reason: "gate-1-active-check (worktree dirty or recent commit)",
        });
        return;
      }
    }
  }

  // Per-class dispatch. REAP_ORDER + the entry-point class-5 sweep
  // guarantee only the 5 reapable classes reach this switch.
  switch (reapable.class as Exclude<OrphanClass, "kanban-epic-without-cage">) {
    case "cron-block-without-worktree":
      return dispatchCronBlock(reapable, opts, result);
    case "cockpit-registry-without-cage":
      return dispatchRegistry(reapable, opts, result);
    case "branch-without-row":
      return dispatchBranch(reapable, opts, result);
    case "worktree-without-cage":
      return dispatchWorktree(reapable, opts, result);
    case "cage-tmux-without-registry":
      return dispatchCage(reapable, opts, result);
  }
}

// ---------- Per-class dispatchers ----------

async function dispatchCronBlock(
  orphan: ReapableOrphan,
  opts: ReapOpts,
  result: ReapResult,
): Promise<void> {
  await invoke(orphan, opts, result, "cronReaperReap", async () =>
    opts.deps.cronReaperReap(orphan.ref),
  );
}

async function dispatchRegistry(
  orphan: ReapableOrphan,
  opts: ReapOpts,
  result: ReapResult,
): Promise<void> {
  await invoke(orphan, opts, result, "removeRegistryEntry", async () =>
    opts.deps.removeRegistryEntry(orphan.ref),
  );
}

async function dispatchBranch(
  orphan: ReapableOrphan,
  opts: ReapOpts,
  result: ReapResult,
): Promise<void> {
  const branch = orphan.ref;
  const repoPath = opts.repoPathForBranch?.(branch);
  const base = opts.baseBranchForBranch?.(branch);
  if (repoPath === undefined || base === undefined) {
    result.refused.push({
      orphan,
      reason: "gate-3-merge-base (repoPathForBranch / baseBranchForBranch not provided)",
    });
    return;
  }
  // Gate 3 — NEVER bypassed by --skip-checks.
  const merged = await opts.deps.isBranchMerged(repoPath, base, branch);
  if (!merged) {
    result.refused.push({
      orphan,
      reason: `gate-3-merge-base (${branch} not fully merged into ${base})`,
    });
    return;
  }
  await invoke(orphan, opts, result, "deleteBranch", async () =>
    opts.deps.deleteBranch(repoPath, branch),
  );
}

async function dispatchWorktree(
  orphan: ReapableOrphan,
  opts: ReapOpts,
  result: ReapResult,
): Promise<void> {
  const path = opts.worktreePathForOrphan?.(orphan);
  if (path === undefined) {
    result.refused.push({
      orphan,
      reason: "gate-1-active-check (worktreePathForOrphan not provided)",
    });
    return;
  }
  await invoke(orphan, opts, result, "rmZombieWorktree", async () =>
    opts.deps.rmZombieWorktree(path),
  );
}

async function dispatchCage(
  orphan: ReapableOrphan,
  opts: ReapOpts,
  result: ReapResult,
): Promise<void> {
  const socket = opts.cageSocketForOrphan?.(orphan);
  if (socket === undefined) {
    result.refused.push({
      orphan,
      reason: "gate-1-active-check (cageSocketForOrphan not provided)",
    });
    return;
  }
  await invoke(orphan, opts, result, "killCageServer", async () =>
    opts.deps.killCageServer(socket),
  );
}

// ---------- Common primitive-invoke wrapper ----------

async function invoke(
  orphan: ReapableOrphan,
  opts: ReapOpts,
  result: ReapResult,
  primitive: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
    result.reaped.push({ orphan, primitive });
    await opts.deps.appendReapLog({
      schema_version: 1,
      timestamp: opts.deps.now().toISOString(),
      orphan_class: orphan.class as OrphanClass,
      ref: orphan.ref,
      primitive,
      result: "ok",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.failed.push({ orphan, primitive, error: message });
    await opts.deps.appendReapLog({
      schema_version: 1,
      timestamp: opts.deps.now().toISOString(),
      orphan_class: orphan.class as OrphanClass,
      ref: orphan.ref,
      primitive,
      result: "failed",
      error: message,
    });
  }
}

function primitiveLabel(cls: Exclude<OrphanClass, "kanban-epic-without-cage">): string {
  switch (cls) {
    case "cron-block-without-worktree":
      return "cronReaperReap";
    case "cockpit-registry-without-cage":
      return "removeRegistryEntry";
    case "branch-without-row":
      return "deleteBranch";
    case "worktree-without-cage":
      return "rmZombieWorktree";
    case "cage-tmux-without-registry":
      return "killCageServer";
  }
}

// ---------- reapZombieWorktree helper (ADR-223 §D2 row 3) ----------

/** The one NEW destructive primitive this EPIC adds — the
 *  `worktree-without-cage` class lacks an existing canonical reaper.
 *  Small helper (under §D3 active-check + merge-base posture) that
 *  delegates to `rm -rf` via the injected {@link RmRecursiveFn}.
 *
 *  Production wiring lives in the verb layer (t-3553f189); this
 *  module exports the pure helper for testability. NOT a general-
 *  purpose worktree-rm — gated to the `worktree-without-cage` class
 *  via the {@link reapOrphans} dispatch. */
export type RmRecursiveFn = (path: string) => Promise<void>;

export function makeReapZombieWorktree(rm: RmRecursiveFn): (path: string) => Promise<void> {
  return async (path: string) => {
    if (path.length === 0) throw new Error("reapZombieWorktree: empty path refused");
    // Defensive root-guard — a misrouted call with `/` or `~` would
    // be catastrophic. The verb-layer always passes an absolute
    // <parentRoot>/../atmux-epics/<eid> path; this guard surfaces a
    // programmer-bug before the destructive call.
    if (path === "/" || path === process.env.HOME) {
      throw new Error(`reapZombieWorktree: refusing root-like path: ${path}`);
    }
    if (!path.includes("atmux-epics/")) {
      throw new Error(`reapZombieWorktree: refusing non-epic-team path: ${path}`);
    }
    await rm(path);
  };
}

// Re-exports for ergonomic verb-layer + test imports.
export type { TopoOrphan };
