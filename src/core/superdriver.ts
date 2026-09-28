// ADR-296 — per-team superdriver orchestration seat.
//
// Every team cage gains a `superdriver` window at index 1 (before the
// driver roster) unless the team opts out via
// `team.json::superdriver.enabled=false`. Absent block == enabled with
// defaults, so legacy team.json files gain the seat without migration.
//
// The seat is orchestration-only: it runs `/sync-drivers` from the repo
// root, reads the board, files/assigns kb rows and messages lane
// executors. It writes no product code and owns no branch — its only
// pushes are those `/sync-drivers` makes. It is NOT a `drivers[]` entry
// and NOT a `members[]` entry, so `/sync-drivers` rosters, lane regexes,
// worktree provisioning and driver branches are unchanged. No worktree,
// no branch of its own; cwd is pinned to the repo root (not
// configurable).
//
// Identity: kb actor `@:<owning-team>/<board>/superdriver`, lane field
// `--lane superdriver`. No shortform (`sd` already means the
// cockpit-tier `_sd` lanes per ADR-290).
//
// Distinct from the cockpit-tier `_superdriver` / `_sd` operator windows
// on the `atx` cockpit session (ADR-290): different session, different
// lifecycle — do not conflate or rename those.
//
// Pure utilities only; the spawn lifecycle lives in `src/verbs/start.ts`
// (mirroring the driver two-stage lifecycle: interactive shell first,
// TUI sent into the verified-idle shell second).

/** Canonical tmux window name for the per-team superdriver seat. Bare
 *  name — driver windows are bare too (`driver`, `driver-N`); there is
 *  no emoji/prefix rule for operator seats. */
export const SUPERDRIVER_WINDOW_NAME = "superdriver";

/** Lane field the superdriver files kb rows under. No shortform — `sd`
 *  already means the cockpit `_sd` lanes (ADR-290). */
export const SUPERDRIVER_LANE = "superdriver";

/** Input shape for {@link resolveSuperdriver}. Structural (not the Zod
 *  type) so this module stays consumable from schema-free callers —
 *  same posture as `core/drivers.ts::DriverRosterTeam`. */
export interface SuperdriverTeamShape {
  superdriver?: {
    enabled?: boolean | undefined;
    tui?: string | null | undefined;
  } | undefined;
}

/** Resolved superdriver seat for a team. `cwd` is the pinned repo root
 *  (the caller passes its already-resolved project root). */
export interface ResolvedSuperdriver {
  /** Absent block == true; explicit `{"enabled": false}` opts out. */
  enabled: boolean;
  /** Null / absent leaves the seat in the normal interactive shell. */
  tui: string | null | undefined;
  /** Always {@link SUPERDRIVER_WINDOW_NAME}. */
  windowName: string;
  /** Pinned repo root — never a worktree. */
  cwd: string;
}

/**
 * Resolve the effective superdriver seat for a team.
 *
 *   1. `team.superdriver?.enabled === false` → disabled.
 *   2. Otherwise (absent block, `{}`, `{enabled: true}`) → enabled.
 *
 * `tui` passes through verbatim (null/absent → zsh floor, same as
 * drivers). `windowName` is always `"superdriver"`; `cwd` is always the
 * given project root.
 *
 * Pure. No I/O.
 */
export function resolveSuperdriver(
  team: SuperdriverTeamShape,
  projectRoot = ".",
): ResolvedSuperdriver {
  const block = team.superdriver;
  return {
    enabled: block?.enabled !== false,
    tui: block?.tui,
    windowName: SUPERDRIVER_WINDOW_NAME,
    cwd: projectRoot,
  };
}
