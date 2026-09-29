// t-eb11cdb4 — read-only planner for `start`'s incremental repairs.
//
// A non-force `start` on an existing session keeps every window but still
// performs two tmux mutations: legacy member-window renames (ADR-135 §D4
// no-separator form, ADR-161 `_-prefix` hyphen form) and the
// `__<team>__home` placeholder kill (step 9). `cockpit reconcile
// --dry-run` used to skip `start` entirely (ADR-300 amendment 2026-09-29),
// so those ops were invisible to the plan. The dry-run branch now probes
// the live window list and records the same ops through the recording
// wrapper.
//
// Single source of truth: `start.ts`'s spawn loop consumes
// `planMemberRenameArms` per member and `shouldKillHomeWindow` for step 9,
// while the dry-run preview loops `planLegacyWindowRenames` (which picks
// the same arms in the same priority) over the same window list. The name
// builders (`buildWindowName` / `buildWindowNameLegacy` /
// `defaultEmojiForRole`) are shared, so the preview cannot drift from
// behaviour without a type error.
//
// Everything here is pure except `previewStartRepairs`, which issues
// `renameWindow` / `killWindow` against the namespace it is handed.
// Dry-run callers hand it the recording wrapper (ops recorded, never
// executed); it performs zero filesystem I/O either way.
import { exactSessionTarget, type TmuxNamespace } from "../abstractions/tmux.ts";
import { buildWindowName, buildWindowNameLegacy, defaultEmojiForRole } from "./common.ts";
import { SUPERDRIVER_WINDOW_NAME } from "./superdriver.ts";
import type { Logger } from "./tui.ts";

/** Structural member slice the planner reads. Compatible with `Team["members"]`. */
export interface RepairMember {
  name: string;
  emoji?: string | undefined;
  label?: string | undefined;
  role?: string | undefined;
}

/** Which legacy convention a planned rename migrates away from. */
export type LegacyMigration = "ADR-161" | "ADR-135";

export interface PlannedWindowRename {
  memberName: string;
  from: string;
  to: string;
  migration: LegacyMigration;
}

/** Effective window emoji — exactly `start.ts` spawnOneMember's
 *  `member.emoji ?? defaultEmojiForRole(role ?? "member")`: an explicit
 *  empty string survives (bare window name), only `undefined` defaults. */
export function repairMemberEmoji(member: RepairMember): string {
  return member.emoji ?? defaultEmojiForRole(member.role ?? "member");
}

/** Canonical window name — identical construction to `start.ts`'s `win`. */
export function canonicalRepairWindowName(member: RepairMember): string {
  return buildWindowName(member.name, repairMemberEmoji(member), member.label, member.role);
}

/** One member's rename arms: the ADR-161 hyphen form and the ADR-135
 *  no-separator form, each present only when that legacy window exists
 *  and the canonical form does not (the caller checks the canonical
 *  early-skip first, matching `start.ts`'s `existingNames.has(win)`
 *  return). Priority is hyphen-first, matching the spawn loop. */
export interface MemberRenameArms {
  /** ADR-161 `_-prefix` migration (`<emoji>-<label>` → `<emoji>_<label>`). */
  hyphen: { from: string; to: string } | undefined;
  /** ADR-135 migration (`<emoji><member>` → `<emoji>-<member>`). */
  legacy: { from: string; to: string } | undefined;
}

export function planMemberRenameArms(
  member: RepairMember,
  has: (name: string) => boolean,
): MemberRenameArms {
  const emoji = repairMemberEmoji(member);
  const win = buildWindowName(member.name, emoji, member.label, member.role);
  const winHyphen = buildWindowName(member.name, emoji, member.label);
  const winLegacy = buildWindowNameLegacy(member.name, emoji);
  return {
    hyphen: winHyphen !== win && has(winHyphen) ? { from: winHyphen, to: win } : undefined,
    legacy: winLegacy !== win && has(winLegacy) ? { from: winLegacy, to: win } : undefined,
  };
}

/** Sequential rename plan over a member roster in spawn order. Mutates
 *  only the local name set (add canonical, drop legacy) so later members
 *  see earlier renames — the same view `start.ts`'s shared
 *  `existingNames` set gives the spawn loop. */
export function planLegacyWindowRenames(
  members: ReadonlyArray<RepairMember>,
  existingNames: Iterable<string>,
): { renames: PlannedWindowRename[]; namesAfter: Set<string> } {
  const live = new Set(existingNames);
  const renames: PlannedWindowRename[] = [];
  for (const member of members) {
    if (live.has(canonicalRepairWindowName(member))) continue;
    const arms = planMemberRenameArms(member, (n) => live.has(n));
    const picked =
      arms.hyphen !== undefined
        ? { ...arms.hyphen, migration: "ADR-161" as const }
        : arms.legacy !== undefined
          ? { ...arms.legacy, migration: "ADR-135" as const }
          : undefined;
    if (picked === undefined) continue;
    renames.push({ memberName: member.name, ...picked });
    live.add(picked.to);
    live.delete(picked.from);
  }
  return { renames, namesAfter: live };
}

/** Step-9 placeholder name — identical construction to `start.ts`'s `homeWin`. */
export function homeWindowName(teamName: string): string {
  return `__${teamName}__home`;
}

/** Step-9 kill predicate: the placeholder dies only once real windows
 *  exist beside it. Shared by `start.ts` step 9 and the dry-run preview. */
export function shouldKillHomeWindow(namesAfter: Iterable<string>, homeWin: string): boolean {
  let hasHome = false;
  let others = 0;
  for (const name of namesAfter) {
    if (name === homeWin) hasHome = true;
    else others += 1;
  }
  return hasHome && others > 0;
}

export interface StartRepairPlan {
  session: string;
  homeWindow: string;
  renames: PlannedWindowRename[];
  /** Members whose canonical window is still missing after the renames —
   *  the windows a non-force start would spawn. */
  spawns: string[];
  /** True when start would insert the ADR-296 superdriver seat. */
  seatSpawn: boolean;
  /** Step 9: start kills the placeholder only when it spawned something
   *  AND the placeholder then coexists with real windows. */
  killHome: boolean;
}

/** Pure plan: legacy renames + home-kill decision for one cage session. */
export function planStartRepairs(opts: {
  teamName: string;
  session: string;
  members: ReadonlyArray<RepairMember>;
  existingNames: Iterable<string>;
  /** `resolveSuperdriver(team).enabled` — start inserts the seat when
   *  enabled and no `superdriver` window exists. */
  superdriverEnabled?: boolean;
}): StartRepairPlan {
  const homeWindow = homeWindowName(opts.teamName);
  const { renames, namesAfter } = planLegacyWindowRenames(opts.members, opts.existingNames);
  const postStart = new Set(namesAfter);
  const spawns: string[] = [];
  for (const member of opts.members) {
    const win = canonicalRepairWindowName(member);
    if (postStart.has(win)) continue;
    spawns.push(win);
    postStart.add(win);
  }
  const seatSpawn = opts.superdriverEnabled === true && !namesAfter.has(SUPERDRIVER_WINDOW_NAME);
  if (seatSpawn) postStart.add(SUPERDRIVER_WINDOW_NAME);
  return {
    session: opts.session,
    homeWindow,
    renames,
    spawns,
    seatSpawn,
    // Mirrors start.ts step 9: `(spawned > 0 || superdriverSpawned) &&
    // shouldKillHomeWindow(<post-spawn window list>)`.
    killHome: (spawns.length > 0 || seatSpawn) && shouldKillHomeWindow(postStart, homeWindow),
  };
}

/**
 * Probe one cage session and record its incremental repairs through
 * `tmux`. Read-only against live state (`hasSession` + `listWindows`
 * delegate); the emitted `renameWindow` / `killWindow` calls are real on
 * a live namespace and recorded-not-executed on the dry-run wrapper.
 * Returns `"no-session"` when the session is absent or unreachable —
 * a fresh `start` has no legacy windows to migrate.
 */
export async function previewStartRepairs(
  tmux: TmuxNamespace,
  opts: {
    teamName: string;
    session: string;
    members: ReadonlyArray<RepairMember>;
    superdriverEnabled?: boolean;
  },
  logger?: Logger,
): Promise<StartRepairPlan | "no-session"> {
  let exists = false;
  try {
    exists = await tmux.session.hasSession(exactSessionTarget(opts.session));
  } catch {
    return "no-session";
  }
  if (!exists) return "no-session";
  let names: string[];
  try {
    names = (await tmux.window.listWindows(opts.session)).map((w) => w.name);
  } catch {
    return "no-session";
  }
  const plan = planStartRepairs({
    teamName: opts.teamName,
    session: opts.session,
    members: opts.members,
    existingNames: names,
    ...(opts.superdriverEnabled === undefined
      ? {}
      : { superdriverEnabled: opts.superdriverEnabled }),
  });
  // One failed op must not drop the rest of the plan (start itself warns
  // per arm and carries on), so each op is isolated.
  for (const rename of plan.renames) {
    try {
      await tmux.window.renameWindow(`${opts.session}:${rename.from}`, rename.to);
      logger?.log(
        `  · [dry-run] would rename legacy window '${rename.from}' → '${rename.to}' (${rename.migration} migration)`,
      );
    } catch (error) {
      logger?.warn(`  · [dry-run] rename '${rename.from}' could not be planned: ${String(error)}`);
    }
  }
  if (plan.killHome) {
    try {
      await tmux.window.killWindow(`${opts.session}:${plan.homeWindow}`);
      logger?.log(`  · [dry-run] would kill placeholder window '${plan.homeWindow}'`);
    } catch (error) {
      logger?.warn(`  · [dry-run] placeholder kill could not be planned: ${String(error)}`);
    }
  }
  return plan;
}
