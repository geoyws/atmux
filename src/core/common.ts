// ADR-003: src/core/common.ts — atmux-specific reusables.
//
// Knows about atmux concepts (team, member, .atmux/ root, kanban,
// inbox) but is not itself a verb. Imports allowed: src/abstractions/*,
// src/schema/*, src/errors. Forbidden: src/verbs/*. The bash port
// target is lib/common.sh @ HEAD 2aadc3f. The bash file mixes path /
// team helpers + jq write helpers + tmux probe helpers; per ADR-003
// the jq writes belong to src/abstractions/json.ts (already shipped),
// the tmux probes belong inside the verbs that need them (constructed
// via createTmux per ADR-004 amend). What remains in core: path /
// identity, team.json load, name validation, role→emoji+lane mapping,
// and the prompt-state regex helpers that whip / dispatch / report
// run against `tmux pane.capturePane()` output.
//
// Phase 2 placeholder: getDefaultSocket() — see §"Socket resolver"
// below. ADR-004 amend Consequences §Phase 2 spec is pending.

import { dirname, join, resolve } from "node:path";
import { ensureDir, exists, readTextOrNull } from "../abstractions/fs.ts";
import { readJson, tryReadJson } from "../abstractions/json.ts";
import { ConfigError, UsageError } from "../errors.ts";
import { Team, type Team as TeamShape } from "../schema/team.ts";

// ---------- Path resolution (bash atmux::dir) ----------

export interface ResolveDirOpts {
  /** Explicit `.atmux/` path. Overrides every other source. */
  dir?: string;
  /** Project root containing `.atmux/`. Resolves to `<root>/.atmux`. */
  teamDir?: string;
  /** cwd to walk up from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Environment hash. Defaults to `process.env`. Test injection point. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the `.atmux/` directory path. Mirrors bash `atmux::dir`.
 *
 * Resolution order, first hit wins:
 *   1. opts.dir                          (explicit override)
 *   2. env.ATMUX_DIR                     (process-level pin)
 *   3. opts.teamDir + "/.atmux"
 *   4. env.ATMUX_TEAM_DIR + "/.atmux"    (cron-friendly project root pin)
 *   5. walk up from cwd until a `.atmux/` directory is found
 *   6. cwd + "/.atmux"                   (last-resort fallback; may not exist)
 *
 * Path-only — does NOT verify existence. Callers that need existence
 * use `hasTeam()` or `requireTeam()`.
 */
export async function getAtmuxDir(opts: ResolveDirOpts = {}): Promise<string> {
  const env = opts.env ?? process.env;
  if (opts.dir !== undefined) return opts.dir;
  const envDir = env.ATMUX_DIR;
  if (envDir !== undefined && envDir.length > 0) return envDir;
  if (opts.teamDir !== undefined) return join(stripTrailingSlash(opts.teamDir), ".atmux");
  const envTeamDir = env.ATMUX_TEAM_DIR;
  if (envTeamDir !== undefined && envTeamDir.length > 0) {
    return join(stripTrailingSlash(envTeamDir), ".atmux");
  }
  const start = resolve(opts.cwd ?? process.cwd());
  let cur = start;
  while (true) {
    const candidate = join(cur, ".atmux");
    if (await exists(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break; // hit / (or volume root) — stop
    cur = parent;
  }
  return join(start, ".atmux");
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/** `<atmuxDir>/team.json`. */
export function teamJsonPath(atmuxDir: string): string {
  return join(atmuxDir, "team.json");
}

export function kanbanJsonPath(atmuxDir: string): string {
  return join(atmuxDir, "kanban.json");
}

export function inboxDir(atmuxDir: string): string {
  return join(atmuxDir, "inboxes");
}

export function inboxPathFor(atmuxDir: string, member: string): string {
  return join(atmuxDir, "inboxes", `${member}.json`);
}

/** ADR-077 §D4 / §F3: reserved inbox key for the cockpit-tier
 *  superdoctor role. Not a member of any team.json — `atmux send`
 *  recognises it as a special target and writes to the team's
 *  `inbox_messages` table instead of attempting tmux pane delivery.
 *  Superdoctor reads matching rows on its hourly whip turn. */
export const SUPERDOCTOR_INBOX_KEY = "__superdoctor__";

export function logsDir(atmuxDir: string): string {
  return join(atmuxDir, "logs");
}

export function stateDir(atmuxDir: string): string {
  return join(atmuxDir, "state");
}

export function archiveDir(atmuxDir: string): string {
  return join(atmuxDir, "archive");
}

export function driverInboxPath(atmuxDir: string): string {
  return join(atmuxDir, "driver-inbox.md");
}

export function leadOutboxPath(atmuxDir: string): string {
  return join(atmuxDir, "lead-outbox.md");
}

export function sessionAnchorPath(atmuxDir: string): string {
  return join(atmuxDir, "state", "session.txt");
}

/** Bash `atmux::ensure_dirs` — mkdir -p for the standard layout. */
export async function ensureAtmuxDirs(atmuxDir: string): Promise<void> {
  await ensureDir(atmuxDir);
  await ensureDir(inboxDir(atmuxDir));
  await ensureDir(logsDir(atmuxDir));
  await ensureDir(stateDir(atmuxDir));
  await ensureDir(archiveDir(atmuxDir));
}

// ---------- Team load ----------

/** True when `team.json` is resolvable + present at the resolved dir. */
export async function hasTeam(opts: ResolveDirOpts = {}): Promise<boolean> {
  const dir = await getAtmuxDir(opts);
  return await exists(teamJsonPath(dir));
}

/**
 * Read `team.json` and validate via the Zod schema.
 * @throws ConfigError if absent (bash `atmux::require_team` parity).
 * @throws SchemaError if malformed (re-thrown from json.ts).
 */
export async function loadTeam(opts: ResolveDirOpts = {}): Promise<TeamShape> {
  const dir = await getAtmuxDir(opts);
  const path = teamJsonPath(dir);
  if (!(await exists(path))) {
    throw new ConfigError({
      what: `no team.json at ${path}`,
      hint: "run 'atmux init' first",
    });
  }
  return await readJson(path, Team);
}

/** Read team.json or return null on absence. Existing-but-malformed
 *  still throws SchemaError (no silent corruption mask, per ADR-005). */
export async function tryLoadTeam(opts: ResolveDirOpts = {}): Promise<TeamShape | null> {
  const dir = await getAtmuxDir(opts);
  return await tryReadJson(teamJsonPath(dir), Team);
}

/** Bash `atmux::require_team` — throws ConfigError if missing,
 *  SchemaError if malformed, otherwise returns the parsed team. */
export async function requireTeam(opts: ResolveDirOpts = {}): Promise<TeamShape> {
  return await loadTeam(opts);
}

/** Convenience accessor for `team.name`. */
export async function getTeamName(opts: ResolveDirOpts = {}): Promise<string> {
  return (await loadTeam(opts)).name;
}

// ---------- Session / window naming ----------

export interface SessionNameOpts extends ResolveDirOpts {
  /** Pre-loaded team (skip the team.json read). */
  team?: TeamShape;
}

/**
 * Mirror of bash `atmux::session_name`.
 *
 * Resolution order:
 *   1. env.ATMUX_SESSION
 *   2. <atmuxDir>/state/session.txt   (single-session anchor file)
 *   3. team.singleSession === true (or env.ATMUX_DRIVER_SESSION) but no anchor
 *      → ConfigError (refuses silent fallback to atmux-<team>; bash invariant)
 *   4. atmux-<team.name>
 */
export async function getSessionName(opts: SessionNameOpts = {}): Promise<string> {
  const env = opts.env ?? process.env;
  const override = env.ATMUX_SESSION;
  if (override !== undefined && override.length > 0) return override;
  const dir = await getAtmuxDir(opts);
  const stored = await readTextOrNull(sessionAnchorPath(dir));
  if (stored !== null) {
    const trimmed = stored.replace(/\s+$/g, "");
    if (trimmed.length > 0) return trimmed;
  }
  const team = opts.team ?? (await loadTeam(opts));
  const driverSession = env.ATMUX_DRIVER_SESSION;
  const driverSessionSet = driverSession !== undefined && driverSession.length > 0;
  if (team.singleSession === true || driverSessionSet) {
    throw new ConfigError({
      what: "single-session enabled but no .atmux/state/session.txt",
      hint: "run 'atmux start' to seed it",
    });
  }
  return `atmux-${team.name}`;
}

/**
 * tmux window name for a member. Operator decision 2026-05-05 (memory
 * `feedback_atmux_window_naming_no_prefix.md`, ADR-017): drop the
 * pre-amend `__<team>__<emoji><member>` prefix to maximize horizontal
 * space in tmux's window-list UI.
 *
 * **New form** — `<emoji><member>` when emoji is set, `<member>` when not.
 * Concrete examples (5-char team `atmux`):
 *   pre-amend:  `__atmux__🗺️lead`     (12 chars + emoji)
 *   post-amend: `🗺️lead`              (4 chars + emoji)
 *
 * The bash side at HEAD 2aadc3f still uses the prefixed form
 * (`lib/common.sh::atmux::window_name`); port-back is non-urgent and
 * planned for the next bash atmux window-naming change (ADR-013 §"Phase
 * 5 deferral" governs the cross-language drift while the prefixed form
 * stays live in production bash).
 */
export function buildWindowName(member: string, emoji?: string): string {
  if (emoji !== undefined && emoji.length > 0) return `${emoji}${member}`;
  return member;
}

/**
 * Roster-based "is this name a member-spawned window?" check.
 *
 * Pre-amend (`__<team>__…` prefix) used a regex on the name alone — the
 * prefix WAS the signal. Post-amend the new form has no prefix, so the
 * check necessarily compares against the team's `members[]` roster.
 *
 * Returns true when `name` matches `buildWindowName(member.name,
 * member.emoji)` for any entry. Names that begin with `__` are
 * explicitly rejected — they're either pre-amend artifacts (cleaned up
 * via `atmux start --force` or its successor) or atmux-internal
 * placeholder windows like `__<team>__home` (start.ts).
 *
 * Used by Phase 2+ verbs (whip, dispatch, scope-refuse paths) to
 * determine whether the calling pane is a member pane vs the driver's.
 */
export function isMemberWindowName(
  name: string,
  members: ReadonlyArray<{ name: string; emoji?: string }>,
): boolean {
  if (name.startsWith("__")) return false; // pre-amend artifact / non-atmux placeholder
  return members.some((m) => name === buildWindowName(m.name, m.emoji));
}

// ---------- Name validation ----------

/** Team-name regex: alnum start + alnum/hyphen/underscore body, ≤63
 *  chars. Excludes `:` (tmux session/window/pane separator), `.`
 *  (window.pane separator), whitespace, slashes (registry / window
 *  collisions). Length cap matches Linux's HOST_NAME_MAX-ish. */
const TEAM_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

/** Reserved names that conflict with tmux defaults / atmux internals. */
const RESERVED_TEAM_NAMES: ReadonlySet<string> = new Set([
  "default",
  "system",
  "atmux",
  "tmux",
  "registry",
]);

/** True when `name` is in the reserved set (case-insensitive). */
export function isReservedTeamName(name: string): boolean {
  return RESERVED_TEAM_NAMES.has(name.toLowerCase());
}

/** Pure check; returns reason string on invalid, null on valid. No throw. */
export function checkTeamName(name: string): string | null {
  if (name.length === 0) return "team name must be non-empty";
  if (!TEAM_NAME_REGEX.test(name)) {
    return `team name must match ${TEAM_NAME_REGEX.source} (alnum start, alnum/_/- body, ≤63 chars)`;
  }
  if (isReservedTeamName(name)) return `team name '${name}' is reserved`;
  return null;
}

/** Throws UsageError on invalid names; returns silently on valid. */
export function assertValidTeamName(name: string): void {
  const reason = checkTeamName(name);
  if (reason !== null) {
    throw new UsageError({
      what: `invalid team name: ${reason}`,
      hint: "see atmux init --help",
    });
  }
}

/** Member-name regex. Lowercase-only because tmux window names
 *  (`__<team>__<member>`) are case-sensitive but mismatched case
 *  silently breaks `tmux list-windows | grep -qx`. ≤31 chars keeps
 *  the rendered window name under tmux's display column budget. */
const MEMBER_NAME_REGEX = /^[a-z][a-z0-9_-]{0,30}$/;

/** Pure check; returns reason string on invalid, null on valid. */
export function checkMemberName(name: string): string | null {
  if (name.length === 0) return "member name must be non-empty";
  if (!MEMBER_NAME_REGEX.test(name)) {
    return `member name must match ${MEMBER_NAME_REGEX.source} (lowercase alnum start, alnum/_/- body, ≤31 chars)`;
  }
  return null;
}

/** Throws UsageError on invalid names. */
export function assertValidMemberName(name: string): void {
  const reason = checkMemberName(name);
  if (reason !== null) {
    throw new UsageError({
      what: `invalid member name: ${reason}`,
      hint: "names must be lowercase alphanumeric, may include - and _",
    });
  }
}

/**
 * Normalize a free-form member name to the canonical wire form:
 *   - lowercase
 *   - whitespace and `/` `\` `:` `.` collapsed to `-`
 *   - run-of-non-allowed chars stripped
 *   - leading non-alpha chars trimmed (must start with [a-z])
 *   - trailing `-` / `_` trimmed
 *   - truncated to 31 chars (re-trimming trailing punctuation post-cut)
 *
 * Empty / unrecoverable input returns "". Caller pipes through
 * `assertValidMemberName` for a hard guarantee.
 */
export function normalizeMemberName(input: string): string {
  let s = input.toLowerCase();
  s = s.replace(/[\s/\\:.]+/g, "-");
  s = s.replace(/[^a-z0-9_-]+/g, "");
  s = s.replace(/^[^a-z]+/, "");
  s = s.replace(/[-_]+$/g, "");
  if (s.length > 31) s = s.slice(0, 31).replace(/[-_]+$/g, "");
  return s;
}

// ---------- Role → emoji / lane mapping ----------

/** Default fallback pool for unknown roles + the canonical "member"
 *  bucket. Defined first so ROLE_EMOJI_POOLS can reference it without
 *  the non-null-assertion dance. */
const MEMBER_POOL: ReadonlyArray<string> = ["🐝", "🦊", "🦉", "🐢", "🦀", "🐙", "🦜"];

/** Curated emoji pool per role. Mirrors bash `lib/emoji.sh::atmux::emoji_pool`.
 *  First entry of each pool is the canonical "static" pick. */
const ROLE_EMOJI_POOLS: Readonly<Record<string, ReadonlyArray<string>>> = {
  driver: ["🎮", "🎬", "🎤", "🕹️", "🎯"],
  "team-lead": ["🧭", "🪄", "🎼", "👷", "🗺️"],
  planner: ["🗺️", "🧠", "🧩", "📐", "🎯"],
  reviewer: ["🔍", "🕵️", "📐", "🧪", "👓"],
  gitter: ["🌿", "📝", "🗃️", "🪢", "🧵"],
  devops: ["⚙️", "🛠️", "🔧", "🧰", "📦"],
  dba: ["🗄️", "💾", "🐘", "🧮", "📊"],
  unblocker: ["🔓", "🪛", "🧯", "🧲", "⚡"],
  member: MEMBER_POOL,
};

/** Pool for a role; falls back to the `member` pool for unknown roles. */
export function emojiPoolForRole(role: string): ReadonlyArray<string> {
  return ROLE_EMOJI_POOLS[role] ?? MEMBER_POOL;
}

/** Canonical static pick for a role (first of its pool). Used by bash
 *  `atmux::emoji_default_for_role`. Pools are statically populated
 *  above and never empty, so the index access is safe — but we still
 *  branch defensively rather than asserting non-null. */
export function defaultEmojiForRole(role: string): string {
  const pool = emojiPoolForRole(role);
  // Pools are static + non-empty; the fallback covers the impossible
  // empty-pool case without a non-null assertion.
  return pool[0] ?? "🐝";
}

/** Lane discriminator. JSON wire form is lowercase; UPPER is display only. */
export type Lane = "fe" | "be" | "db" | "ops" | "test" | "review" | "misc";

const LANE_PREFIXES: ReadonlySet<Lane> = new Set([
  "fe",
  "be",
  "db",
  "ops",
  "test",
  "review",
  "misc",
]);

const LANE_BY_ROLE: Readonly<Record<string, Lane>> = {
  reviewer: "review",
  devops: "ops",
  dba: "db",
};

/**
 * Bash `atmux::lane_for_name`. Name-prefix wins (`be-foo` → `be`); role
 * mapping is the fallback (`reviewer` → `review`); `misc` is the catch-all.
 */
export function laneForName(name: string, role = "member"): Lane {
  const idx = name.indexOf("-");
  const prefix = (idx === -1 ? name : name.slice(0, idx)) as Lane;
  if (LANE_PREFIXES.has(prefix)) return prefix;
  return LANE_BY_ROLE[role] ?? "misc";
}

/** Render a lane in display form (UPPER-CASE). Bash
 *  `atmux::lane_display`: empty / "null" → "MISC". */
export function laneDisplay(lane: string | undefined | null): string {
  if (lane === undefined || lane === null || lane.length === 0 || lane === "null") {
    return "MISC";
  }
  return lane.toUpperCase();
}

// ---------- Pane state detection ----------
//
// Bash whip / dispatch / report shell out:
//
//   atmux::capture_pane "$member" 30 \
//     | grep -qiE '<pattern>'
//
// in many places. The Phase 2 verb code will call `tmux.pane.capturePane()`
// and pipe the returned string through these classifiers. Patterns track
// CLAUDE.md-driven user-facing strings observed in the bash codebase
// (lib/whip.sh §_atmux_whip_pane_busy, lib/dispatch.sh banner detection,
// lib/rotate.sh banner detection).

/** Three-tier rate-limit classification per ADR-023.
 *  `none` = no signal · `soft` = ambiguous (judge consult) ·
 *  `hard` = unrecoverable (rotate immediately on AUTO_ROTATE). */
export type RateLimitTier = "none" | "soft" | "hard";

/** Pane is mid-turn (Claude actively running). Bash equiv:
 *  `lib/whip.sh::_atmux_whip_pane_busy`. Suppresses queued-msg false
 *  positives + gates banner-driven rotates so we don't interrupt
 *  productive work. */
export function paneIsBusy(state: string): boolean {
  return /Esc to interrupt|tokens · esc to interrupt|thinking with/i.test(state);
}

/** Three-tier rate-limit detector. `hard` wins over `soft` when both
 *  match (bash dispatch.sh §rate-limit ladder). */
export function detectRateLimit(state: string): RateLimitTier {
  if (/hit your limit/i.test(state)) return "hard";
  if (/approaching usage limit|\d+%\s+of\s+(?:limit|window)\s+used/i.test(state)) return "soft";
  return "none";
}

/** Compacting-conversation banner. Skip sends until done. */
export function isCompacting(state: string): boolean {
  return /Compacting conversation/i.test(state);
}

/** Claude Code auto-/clear recovery banner. Triggers brief re-paste in
 *  bash dispatch.sh's AUTO-PRECLEAR path. */
export function isContextCleared(state: string): boolean {
  return /Context cleared\.\s*Ready for/i.test(state);
}

/** Queued-but-unsubmitted message indicator. Should be checked together
 *  with `paneIsBusy` to avoid the false-positive ping documented in
 *  bash dispatch.sh:218 (E2/S7 t-1a5205ea). */
export function hasQueuedMessages(state: string): boolean {
  return /Press up to edit queued messages/i.test(state);
}

/** Composite snapshot consumed by every site that classifies a pane. */
export interface PaneStateSnapshot {
  busy: boolean;
  rateLimit: RateLimitTier;
  compacting: boolean;
  contextCleared: boolean;
  queuedMessages: boolean;
}

export function classifyPaneState(state: string): PaneStateSnapshot {
  return {
    busy: paneIsBusy(state),
    rateLimit: detectRateLimit(state),
    compacting: isCompacting(state),
    contextCleared: isContextCleared(state),
    queuedMessages: hasQueuedMessages(state),
  };
}

// ---------- Socket resolver ----------
//
// Lifted from `verbs/start.ts::defaultSocketPath` + `verbs/attach.ts::
// defaultSocketPath` — eight verb files (start, attach, status, send,
// stop, add-member, dispatch, tell-lead) imported the start.ts version;
// attach.ts had a duplicate. The R-2 refactor (PLAN.md §6.2) collapses
// both into this canonical helper so doctor + every future verb has
// one import target.
//
// Returns the cage path `/tmp/atmux-<team>/sock`. Bash mirror: every
// `tmux -S "$socket"` invocation in `lib/start.sh` / `lib/attach.sh`
// uses the same convention.
//
// The richer Phase-2 resolver (env vars, team.json overrides, --socket
// short-name vs path) is still pending per ADR-004 amend §Consequences;
// when it lands, this signature stays compatible — the body just gains
// fallback resolution.

/** Bash cage-socket path: `/tmp/atmux-<team>/sock`. */
export function getDefaultSocket(teamName: string): string {
  return `/tmp/atmux-${teamName}/sock`;
}

/** Options for `resolveTeamSocket` — uid injection for tests. */
export interface ResolveTeamSocketOpts {
  /** Override `process.getuid()`. */
  uid?: number;
}

/**
 * Resolve the live tmux socket for a team. Honors `team.tmuxTmpdir`
 * authoritatively when set; otherwise falls back to the canonical bun
 * cage path `/tmp/atmux-<team>/sock`.
 *
 * When `team.tmuxTmpdir` is set, the socket lives at the standard tmux
 * short-name `default` shape: `<tmuxTmpdir>/tmux-<uid>/default`. This
 * matches the bash convention of exporting `TMUX_TMPDIR=<tmuxTmpdir>`
 * early and letting tmux build its own path. Covers all three cage
 * variants (suffixes `atmux-tmux*`, `atmux_tmux_*`, `.atmux/tmux*`) —
 * pick was 2026-05-08 t-add5976a P1 (`atmux status` reported [down]
 * for live cage when team.json declared a project-local `.atmux/tmux`
 * tmpdir; canonical fallback is wrong when the team was started under
 * bash or a tmpdir-honoring start path).
 *
 * Read-only sites (status, doctor orphan-session probe) MUST use this
 * resolver to reach the actual live socket.
 */
export function resolveTeamSocket(
  team: Pick<TeamShape, "name" | "tmuxTmpdir">,
  opts: ResolveTeamSocketOpts = {},
): string {
  const tmpdir = team.tmuxTmpdir;
  if (typeof tmpdir === "string" && tmpdir.length > 0) {
    const uid = opts.uid ?? process.getuid?.() ?? 0;
    return join(tmpdir, `tmux-${uid}`, "default");
  }
  return getDefaultSocket(team.name);
}
