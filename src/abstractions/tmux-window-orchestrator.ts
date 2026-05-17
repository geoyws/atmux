// ADR-161 §Part C: shared topographic-normalization primitives consumed
// by `atmux member move | swap | sort`.
//
// The orchestrator wraps the raw `tmux move-window` / `tmux swap-window`
// primitives with member-id-aware lookup + version-safe fallback. Every
// primitive here preserves PIDs + attached clients + claude-process state
// inside each pane — `tmux move-window` and `tmux swap-window` operate on
// the window-index, not the running processes inside the panes (mirrors
// ADR-135 D4 in-place rename pattern; see ADR-161 §Decision-anchor #3).
//
// Why this lives in `abstractions/`: the verbs in `src/verbs/member.ts`
// orchestrate via these primitives but the primitives themselves are
// pure tmux-shape operations with no atmux state coupling. Tests can
// drive the orchestrator with a stubbed `TmuxNamespace` to assert the
// call sequence without spinning up a tmux server.

import { TmuxError } from "../errors.ts";
import type { TmuxNamespace, WindowId } from "./tmux.ts";

/** A team member resolved to its current tmux window index. */
export interface MemberWindow {
  /** Immutable member ID (per ADR-136 — `name` in team.json). */
  readonly id: string;
  /** Tmux window index (1-indexed per ADR-162 base-index). */
  readonly index: number;
  /** Live tmux window name (`<emoji>_<label>` or `<emoji>-<label>`). */
  readonly name: string;
}

/** Resolution error — surfaced to the verb layer for refusal messages. */
export class MemberWindowResolveError extends Error {
  readonly kind: "unknown-id" | "driver-window" | "duplicate-window";
  constructor(opts: { kind: MemberWindowResolveError["kind"]; message: string }) {
    super(opts.message);
    this.name = "MemberWindowResolveError";
    this.kind = opts.kind;
  }
}

/** Membership shape we need for window resolution. Kept structural so
 *  callers don't have to import the full Zod-derived `TeamMember` type
 *  — schema-validation already happened upstream in `loadTeam`. */
export interface MemberShape {
  readonly name: string;
  readonly emoji?: string | undefined;
  readonly label?: string | undefined;
  readonly role?: string | undefined;
}

/** Member-name candidates we accept when matching a tmux window — covers
 *  the canonical post-ADR-161 form, the ADR-135 hyphen fallback, and the
 *  pre-ADR-135 legacy form (no separator). Mirrors the `isMemberWindowName`
 *  acceptance rule in `src/core/common.ts`. */
export function candidateWindowNames(
  member: MemberShape,
  buildWindowName: (
    name: string,
    emoji?: string,
    label?: string,
    role?: string,
  ) => string,
  buildWindowNameLegacy: (name: string, emoji?: string) => string,
): ReadonlyArray<string> {
  const canonical = buildWindowName(member.name, member.emoji, member.label, member.role);
  const adr135Hyphen = buildWindowName(member.name, member.emoji, member.label);
  const legacy = buildWindowNameLegacy(member.name, member.emoji);
  // Deduplicate — defaults render the same for all three when no emoji.
  return [...new Set([canonical, adr135Hyphen, legacy])];
}

/** Resolve a member ID to its current tmux window index. Refuses the
 *  driver window (W1 per convention) and surfaces unknown-id as a
 *  refusal — both flows produce a `MemberWindowResolveError` that the
 *  verb layer translates to a UsageError / ConfigError. */
export async function resolveMemberToWindowIdx(opts: {
  sessionName: string;
  memberId: string;
  members: ReadonlyArray<MemberShape>;
  tmux: TmuxNamespace;
  buildWindowName: (
    name: string,
    emoji?: string,
    label?: string,
    role?: string,
  ) => string;
  buildWindowNameLegacy: (name: string, emoji?: string) => string;
  /** Driver-window index — defaults to 1 per ADR-162 base-index. */
  driverIndex?: number;
}): Promise<MemberWindow> {
  const driverIndex = opts.driverIndex ?? 1;
  const member = opts.members.find((m) => m.name === opts.memberId);
  if (member === undefined) {
    throw new MemberWindowResolveError({
      kind: "unknown-id",
      message: `member id '${opts.memberId}' not found in team.json — run 'atmux status' for the live roster`,
    });
  }
  const names = candidateWindowNames(
    member,
    opts.buildWindowName,
    opts.buildWindowNameLegacy,
  );
  const live = await opts.tmux.window.listWindows(opts.sessionName);
  const matches = live.filter((w) => names.includes(w.name));
  if (matches.length === 0) {
    throw new MemberWindowResolveError({
      kind: "unknown-id",
      message: `member '${opts.memberId}' has no live tmux window in session '${opts.sessionName}' — verify with 'atmux status'`,
    });
  }
  if (matches.length > 1) {
    throw new MemberWindowResolveError({
      kind: "duplicate-window",
      message: `member '${opts.memberId}' resolves to multiple tmux windows (${matches
        .map((m) => `W${m.index}=${m.name}`)
        .join(", ")}) — run 'atmux doctor' to investigate`,
    });
  }
  const hit = matches[0]!;
  if (hit.index === driverIndex) {
    throw new MemberWindowResolveError({
      kind: "driver-window",
      message: `member '${opts.memberId}' resolves to driver window W${driverIndex} — atmux member move/swap/sort refuses to relocate the driver pane`,
    });
  }
  return { id: opts.memberId, index: hit.index, name: hit.name };
}

/** Absolute move: relocate `<memberId>` to tmux window index `<target>`.
 *  Idempotent when the member already sits at `<target>` (returns false,
 *  no tmux call).
 *
 *  When `<target>` is already occupied by another window, tmux's
 *  `move-window` errors with "index in use" — the orchestrator picks the
 *  right primitive: `swap-window` to atomically exchange (preserves the
 *  occupant's PIDs + claude-process), or `move-window` when the slot is
 *  empty. Caller passes the live `occupiedIndices` set so we don't issue
 *  a redundant `listWindows` round-trip (the verb layer already has it).
 *  Returns true when a tmux primitive was issued. */
export async function moveMemberWindow(opts: {
  sessionName: string;
  source: MemberWindow;
  target: number;
  tmux: TmuxNamespace;
  /** Set of currently-occupied window indices — caller derives from
   *  `listWindows` before invoking. Pure performance optimization to
   *  avoid a second tmux round-trip inside the orchestrator. */
  occupiedIndices: ReadonlySet<number>;
  /** Driver-window index — defaults to 1. Refusal hits this OR `<source>`
   *  resolving to driver, but the resolve step already gates that. */
  driverIndex?: number;
}): Promise<boolean> {
  const driverIndex = opts.driverIndex ?? 1;
  if (opts.target === driverIndex) {
    throw new MemberWindowResolveError({
      kind: "driver-window",
      message: `cannot move '${opts.source.id}' to W${driverIndex} — slot reserved for the driver pane`,
    });
  }
  if (opts.source.index === opts.target) return false;
  const sourceWid: WindowId = { sessionName: opts.sessionName, windowIndex: opts.source.index };
  const targetWid: WindowId = { sessionName: opts.sessionName, windowIndex: opts.target };
  // Target slot occupied → swap (preserves occupant's PIDs). Empty → plain move.
  if (opts.occupiedIndices.has(opts.target)) {
    await opts.tmux.window.swapWindow({ source: sourceWid, target: targetWid });
  } else {
    await opts.tmux.window.moveWindow({ source: sourceWid, target: targetWid });
  }
  return true;
}

/** Pairwise swap: exchange two members' tmux window indices. Prefers the
 *  atomic `tmux swap-window` primitive (available since tmux 1.0, 2009);
 *  falls back to a temp-index three-move dance if `swap-window` throws
 *  `TmuxError` (defensive — production tmux always supports the primitive,
 *  per ADR-161 §Part C "version-safe primitive — check tmux capability at
 *  runtime"). Idempotent when both ids resolve to the same index. */
export async function swapMemberWindows(opts: {
  sessionName: string;
  a: MemberWindow;
  b: MemberWindow;
  tmux: TmuxNamespace;
  /** Highest live window index — needed to pick a temp index above the
   *  current roster for the fallback dance. Caller computes from
   *  `listWindows` to avoid a second tmux round-trip in the happy path. */
  highestIndex: number;
}): Promise<boolean> {
  if (opts.a.index === opts.b.index) return false;
  const aWid: WindowId = { sessionName: opts.sessionName, windowIndex: opts.a.index };
  const bWid: WindowId = { sessionName: opts.sessionName, windowIndex: opts.b.index };
  try {
    await opts.tmux.window.swapWindow({ source: aWid, target: bWid });
    return true;
  } catch (e) {
    if (!(e instanceof TmuxError)) throw e;
    // Fallback dance: move A → temp, move B → A's old slot, move temp → B's old slot.
    const tempIdx = opts.highestIndex + 1;
    const tempWid: WindowId = { sessionName: opts.sessionName, windowIndex: tempIdx };
    await opts.tmux.window.moveWindow({ source: aWid, target: tempWid });
    await opts.tmux.window.moveWindow({ source: bWid, target: aWid });
    await opts.tmux.window.moveWindow({ source: tempWid, target: bWid });
    return true;
  }
}

/** Sort the team roster by canonical default-role order (ADR-161
 *  §Decision-anchor #4). Returns a new array — does NOT mutate input.
 *  Partition: defaults (by canonical-order index) + user-added (by
 *  existing relative order). Roles not in `canonicalOrder` are treated
 *  as user-added. Stable — equal-priority entries retain input order. */
export function sortMembersDefaultsFirst<M extends MemberShape>(
  members: ReadonlyArray<M>,
  canonicalOrder: ReadonlyArray<string>,
): ReadonlyArray<M> {
  const orderIndex = new Map<string, number>();
  canonicalOrder.forEach((role, idx) => orderIndex.set(role, idx));
  const isDefault = (m: M): boolean =>
    m.role !== undefined && orderIndex.has(m.role);
  const defaults = members
    .map((m, originalIdx) => ({ m, originalIdx }))
    .filter(({ m }) => isDefault(m))
    .sort((x, y) => {
      const xi = orderIndex.get(x.m.role!)!;
      const yi = orderIndex.get(y.m.role!)!;
      if (xi !== yi) return xi - yi;
      // Same canonical role (e.g. duplicate planner) — stable by input order.
      return x.originalIdx - y.originalIdx;
    })
    .map(({ m }) => m);
  const userAdded = members.filter((m) => !isDefault(m));
  return [...defaults, ...userAdded];
}
