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
import { isDefaultMemberRole } from "../abstractions/member-roles.ts";
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
  /** t-584b5f37 cluster 11: stop the walk-up at this ancestor (inclusive
   *  scan, but do NOT cross above it). Used by tests whose temp dirs
   *  live under `/tmp/` to isolate the walk-up from any pre-existing
   *  `/tmp/.atmux` left by other atmux invocations on the host. Production
   *  callers never set this — the walk-up reaches `/` as before. */
  stopAt?: string;
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
 *      (with the strip-back below if cwd is inside one already)
 *   6. cwd + "/.atmux"                   (last-resort fallback; may not exist)
 *
 * §Strip-back-before-walk (2026-05-26 amendment — t-62/t-63 nested-
 * state.db bug): if cwd is already INSIDE a `.atmux/` (member-worktree
 * subdir, init-from-inside-.atmux footgun, etc.), strip the path back
 * to the segment BEFORE the first `/.atmux/` occurrence and walk up
 * from there. Without this, the verb invoked from
 * `<root>/.atmux/worktrees/<m>/` would resolve to the worktree's stub
 * `.atmux/` instead of the canonical `<root>/.atmux/`, splitting state
 * across diverging databases (per operator complaints t-62-df4e59bd +
 * t-63-7ab429d5; symmetric to orchd-window.ts::resolveCanonicalTeamRoot).
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
  const startRaw = resolve(opts.cwd ?? process.cwd());
  // Strip-back-before-walk: if startRaw is inside a `.atmux/` dir,
  // restart the walk from outside it (the segment before the first
  // `/.atmux/` occurrence). See JSDoc §Strip-back-before-walk above.
  const atmuxIdx = startRaw.indexOf("/.atmux/");
  const start = atmuxIdx >= 0 ? startRaw.slice(0, atmuxIdx) || "/" : startRaw;
  const stopAt = opts.stopAt !== undefined ? resolve(opts.stopAt) : undefined;
  let cur = start;
  while (true) {
    const candidate = join(cur, ".atmux");
    if (await exists(candidate)) return candidate;
    if (stopAt !== undefined && cur === stopAt) break; // test-side floor
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

/** ADR-077 §D4 / §F3 / ADR-133: reserved inbox key for the cockpit-tier
 *  medic role (canonical name). Not a member of any team.json — `atmux send`
 *  recognises it as a special target and writes to the team's
 *  `inbox_messages` table instead of attempting tmux pane delivery.
 *  Medic reads matching rows on its hourly whip turn. */
export const MEDIC_INBOX_KEY = "__medic__";

/** ADR-133 deprecated alias for {@link MEDIC_INBOX_KEY}. Accepted as an
 *  inbox target during the one-release-cycle deprecation window so
 *  in-flight scripts + skill briefs continue routing while operators
 *  migrate. New callers should reference `MEDIC_INBOX_KEY`; this alias
 *  is dropped once the deprecation closes. */
export const SUPERDOCTOR_INBOX_KEY = "__superdoctor__";

/** ADR-133: returns true when `member` matches the canonical medic
 *  inbox key OR its deprecated `__superdoctor__` alias. Use this in
 *  place of bare `=== SUPERDOCTOR_INBOX_KEY` checks so the routing
 *  path stays single-source-of-truth on which keys reach the medic
 *  inbox writer. */
export function isMedicInboxKey(member: string | undefined): boolean {
  return member === MEDIC_INBOX_KEY || member === SUPERDOCTOR_INBOX_KEY;
}

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

/** ADR-008 §S8 D13 — team-scoped decisions log. Append-only markdown
 *  written by `atmux decisions add` (bash today; bun port pending).
 *  Whip-tick watcher reads this to surface new entries to Discord. */
export function decisionsLogPath(atmuxDir: string): string {
  return join(atmuxDir, "decisions.md");
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
 * **ADR-135 form** — `<emoji>-<member>` (hyphen-separated) when
 * emoji is set, `<member>` when not. Concrete examples (5-char team
 * `atmux`):
 *   pre-amend:  `__atmux__🗺️lead`     (12 chars + emoji)
 *   post-amend: `🗺️lead`              (4 chars + emoji)
 *   post-ADR-135: `🗺️-lead`           (4 chars + emoji + hyphen)
 *
 * Why the hyphen (ADR-135 §D3):
 *   - Shell-quoting safety: `tmux send-keys -t atmux:🗺️-lead` works
 *     without quoting; the no-separator form is byte-glued and can
 *     trip variation-selector emoji (🛠️ = U+1F6E0+U+FE0F) on some
 *     terminal/escape paths.
 *   - Regex/tab-completion friendly: matchers like `^.<emoji>-<name>$`
 *     stay simple; tab-completion engines tokenise on hyphens
 *     cleanly.
 *   - Symmetric with existing hyphenated member names
 *     (`whip-impl`, `parity-cron-impl`, `up-impl-2`).
 *
 * Legacy detection helper: {@link buildWindowNameLegacy} produces the
 * pre-ADR-135 no-separator form — used by `start.ts` to detect
 * legacy windows that need in-place renaming on first reboot under
 * the new convention (ADR-135 §D4 migration shim).
 *
 * The bash side at HEAD 2aadc3f still uses the prefixed form
 * (`lib/common.sh::atmux::window_name`); port-back is non-urgent and
 * planned for the next bash atmux window-naming change (ADR-013 §"Phase
 * 5 deferral" governs the cross-language drift while the prefixed form
 * stays live in production bash).
 */
export function buildWindowName(
  member: string,
  emoji?: string,
  label?: string,
  role?: string,
): string {
  // ADR-136 TR4: optional `label` overrides `member` (the ID) for the
  // display segment only. Window name still couples emoji + display
  // string; the underlying tmux window is keyed by name (mutable) but
  // members are addressed by name (the immutable ID) via the
  // worktree / branch / kanban / inbox storage classes — all of which
  // continue to use `member` regardless of label.
  //
  // ADR-135 separator: `<emoji>-<display>` (hyphen-separated) when
  // emoji is set. Two-arg callers (pre-TR4) pass `label === undefined`
  // implicitly → display falls back to `member` (the ID), shape stays
  // `<emoji>-<member>`. The label-fallback happens here so per-callsite
  // migrations can pass `member.label` without each callsite
  // re-implementing `label ?? name`.
  //
  // ADR-161 §Decision-anchor #2 role-aware format split: when `role`
  // matches one of `DEFAULT_MEMBER_ROLES` (team-lead, planner,
  // reviewer, ombudsman), render `_-prefix` (`${emoji}_${display}`).
  // Otherwise — user-added members (role = "member") AND callsites
  // that don't pass a role — keep the existing ADR-135 hyphen form.
  // Backward-compatible: existing two/three-arg callers default to
  // `role: undefined` → hyphen path.
  const display = label !== undefined && label.length > 0 ? label : member;
  if (emoji === undefined || emoji.length === 0) return display;
  if (isDefaultMemberRole(role)) return `${emoji}_${display}`;
  return `${emoji}-${display}`;
}

/**
 * Legacy pre-ADR-135 form of {@link buildWindowName} — `<emoji><member>`
 * (no separator) when emoji is set, `<member>` when not. Used by
 * `start.ts` to detect existing legacy windows that need in-place
 * renaming via `tmux rename-window` per ADR-135 §D4. Idempotent: the
 * shim only fires when a window matching the legacy form is found and
 * the canonical (hyphenated) form does not yet exist.
 *
 * ADR-136 TR4: the legacy detector keys on `member` (the ID) — it's
 * the pre-rename shape, so labels never appeared in legacy windows
 * by construction. No `label` arg here.
 *
 * @deprecated v2-bump per ADR-135 — once the one-release-cycle
 *             deprecation window closes, this helper is removed.
 */
export function buildWindowNameLegacy(member: string, emoji?: string): string {
  if (emoji !== undefined && emoji.length > 0) return `${emoji}${member}`;
  return member;
}

/**
 * Resolve a member's existing tmux window name, tolerating both the
 * canonical ADR-135 hyphenated form (`<emoji>-<member>`) AND the legacy
 * pre-ADR-135 concatenated form (`<emoji><member>`). Returns whichever
 * form actually exists in the live tmux window list; if neither exists,
 * returns the canonical form so the downstream "no tmux window for X"
 * error message names the form the caller would have spawned.
 *
 * Called by addressing verbs (`tell-lead`, `send`) that need to address
 * windows by name and would otherwise miss teams spawned under the
 * pre-ADR-135 binary. Symmetric with {@link isMemberWindowName}, which
 * already accepts both shapes during the deprecation window.
 *
 * Pure-by-injection: takes a `listWindowNames` function so tests can
 * mock tmux without spawning. Production callers pass
 * `(name) => tmux.window.listWindows(name).then((ws) => ws.map((w) => w.name))`.
 *
 * Once `start.ts`'s migration shim renames legacy windows on every
 * fresh team-start, this helper degenerates to "return canonical" and
 * can be removed alongside `buildWindowNameLegacy`.
 */
export async function resolveExistingWindowName(
  sessionName: string,
  member: string,
  emoji: string | undefined,
  label: string | undefined,
  listWindowNames: (sessionName: string) => Promise<ReadonlyArray<string>>,
  role?: string,
): Promise<string> {
  // ADR-161 TR2 interaction: default members canonical = `<emoji>_<member>`,
  // ADR-135 hyphen form `<emoji>-<member>` is the deprecation step BEFORE
  // current canonical (and before pre-ADR-135 `<emoji><member>` legacy).
  // For default-member roles we accept all three live forms; for user-added
  // members the hyphen form IS canonical so the tier collapses to two.
  const canonical = buildWindowName(member, emoji, label, role);
  const adr135Hyphen = buildWindowName(member, emoji, label);
  const legacy = buildWindowNameLegacy(member, emoji);
  if (canonical === legacy && canonical === adr135Hyphen) return canonical;
  let names: ReadonlyArray<string>;
  try {
    names = await listWindowNames(sessionName);
  } catch {
    // Session missing / tmux down — let downstream produce its own
    // "no tmux window" error against the canonical form.
    return canonical;
  }
  const set = new Set(names);
  if (set.has(canonical)) return canonical;
  if (set.has(adr135Hyphen)) return adr135Hyphen;
  if (set.has(legacy)) return legacy;
  return canonical;
}

/**
 * Dep-injectable tmux ops for {@link resolveWindowWithRenameShim}. The
 * helper drives only `list-windows` + `rename-window`; the shape is
 * narrowed from the full {@link Tmux} abstraction so unit tests can
 * stub these two operations directly without spinning a tmux server.
 *
 * Production callers wire as:
 *
 *   ```ts
 *   const ops: WindowShimOps = {
 *     listWindowNames: async (s) =>
 *       (await tmux.window.listWindows(s)).map((w) => w.name),
 *     renameWindow: (s, from, to) =>
 *       tmux.window.renameWindow(`${s}:${from}`, to),
 *   };
 *   ```
 *
 * `renameWindow` uses the `session:window-name` Target string form
 * supported by `tmux.window.renameWindow`; the helper itself stays
 * abstraction-free so the same shape works in pure-bun tests and in
 * production cages.
 */
export interface WindowShimOps {
  /** `tmux list-windows -t <session>` → window names on the session. */
  listWindowNames(sessionName: string): Promise<ReadonlyArray<string>>;
  /** `tmux rename-window -t <session>:<fromName> <toName>` — atomic. */
  renameWindow(sessionName: string, fromName: string, toName: string): Promise<void>;
}

/**
 * Resolve a tmux window to its canonical name, atomically renaming a
 * legacy variant in place if found. Returns the canonical name on
 * success; throws `ConfigError("no tmux window for <canonical>")` if
 * neither canonical nor any legacy variant exists.
 *
 * Per EPIC e-a3077ca0 (window-name self-heal shim) — three window-name
 * formats coexist in production cages during the ADR-135 → ADR-161
 * deprecation window for default-member roles:
 *
 *   1. canonical    e.g. `🦦_docs`   (ADR-161 `_-prefix` for default
 *                                     members — what `buildWindowName`
 *                                     produces today with `role` set)
 *   2. hyphen-form  e.g. `🦦-docs`   (ADR-135 hyphen — pre-ADR-161
 *                                     default-member legacy; also today's
 *                                     canonical for non-default members
 *                                     per ADR-161 §D2)
 *   3. no-separator e.g. `🦦docs`    (pre-ADR-135 legacy — what
 *                                     `buildWindowNameLegacy` produces;
 *                                     what production lane-tick was
 *                                     looking for as of atmux 0.8.4)
 *
 * Behavior:
 *   1. List windows on `sessionName`.
 *   2. If `canonical` is present → return `canonical` (no rename).
 *      Defensive: when both canonical and a legacy variant coexist
 *      (rare — implies a prior rename was interrupted mid-flight),
 *      prefer canonical and skip the rename; the legacy entry stays
 *      as an orphan window that operator-side cleanup (T8 doctor
 *      probe) surfaces separately.
 *   3. Else iterate `legacyVariants` in caller-supplied order; first
 *      hit → atomic `tmux rename-window <legacy> <canonical>` → return
 *      `canonical`.
 *   4. Neither canonical nor any legacy variant matches → throw
 *      `ConfigError` with the canonical `no tmux window for <name>`
 *      string that existing callers (rotate / tell-lead / send) grep
 *      for. The error message names `canonical`, not the variant the
 *      caller spawned with, so operator messages always point at the
 *      target shape.
 *
 * Atomicity: `tmux rename-window` is a single tmux server op — there
 * is no observable intermediate state between legacy and canonical.
 * Concurrent shim calls may race the rename; both win in the sense
 * that the post-rename state is identical regardless of order.
 *
 * Gitter carve-out (per `project_adr_161_tr2_shipped` memory +
 * ADR-159 pending): the gitter member's canonical form stays
 * `🌿-gitter` (hyphen). Callers for gitter pass
 * `canonical="🌿-gitter"` with an EMPTY `legacyVariants` array —
 * there's no hyphen→underscore migration to apply, so the helper
 * either finds canonical or throws (matching ADR-159 intent).
 *
 * Out-of-scope (caller responsibility):
 *   - Epic-viewer windows (`🌳-<eid>`) keep hyphen by spec — never call
 *     this helper for them.
 *   - User-added member names — only the default-role members
 *     (team-lead / planner / reviewer / ombudsman per
 *     {@link isDefaultMemberRole}) need the cross-format resolver.
 *
 * Production failure trail driving this shim: 2026-05-18 03:52 UTC
 * lane-tick.log `lane-tick: docs: capture error — can't find window:
 * 🦦docs` while the actual pane was `🦦_docs` — verify-poll caught
 * the post-deploy regression after ADR-161's default-member rename
 * shipped without back-fill at the per-iteration capture call-sites.
 */
export async function resolveWindowWithRenameShim(
  sessionName: string,
  canonical: string,
  legacyVariants: ReadonlyArray<string>,
  ops: WindowShimOps,
): Promise<string> {
  const names = new Set(await ops.listWindowNames(sessionName));
  if (names.has(canonical)) return canonical;
  for (const legacy of legacyVariants) {
    if (legacy === canonical) continue;
    if (names.has(legacy)) {
      await ops.renameWindow(sessionName, legacy, canonical);
      return canonical;
    }
  }
  throw new ConfigError({ what: `no tmux window for ${canonical}` });
}

/**
 * ADR-136 TR4: display name for a member. Returns `member.label` when
 * set + non-empty, otherwise `member.name`. Use this for operator-
 * facing surfaces (Discord templates, status output, brief
 * substitutions, debug log fields the user reads). Internal lookups
 * (kanban owner column, inbox file path, worktree path, branch name)
 * always use `member.name` — never route through this helper.
 *
 * ID vs label split rationale, mirroring ADR-136 §"Hot-rename
 * concurrency safety":
 *
 *   - `member.name` is the immutable ASCII identifier
 *     (`MEMBER_NAME_REGEX = /^[a-z][a-z0-9_-]{0,30}$/`) that keys
 *     every persistent storage class — change-tracking depends on
 *     this stability.
 *   - `member.label` is the mutable Unicode display field that
 *     `atmux member rename` mutates atomically. Refine rule rejects
 *     `:` and `.` (tmux window-name separators); `displayMemberName`
 *     itself doesn't validate — the schema does on write.
 *
 * Pure: no schema parse, no I/O. Safe to call inside hot loops
 * (per-tick whip surfacing, per-row status renderer, etc.).
 */
export function displayMemberName(member: { name: string; label?: string | undefined }): string {
  return member.label !== undefined && member.label.length > 0 ? member.label : member.name;
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
  members: ReadonlyArray<{
    name: string;
    emoji?: string;
    label?: string | undefined;
    role?: string | undefined;
  }>,
): boolean {
  if (name.startsWith("__")) return false; // pre-amend artifact / non-atmux placeholder
  // ADR-135 + ADR-136 TR4: match against the canonical hyphenated form
  // (label-aware, post-TR4) OR the legacy concatenated form (pre-
  // ADR-135 deprecation window). Three shapes can appear during the
  // one-release-cycle migration window:
  //
  //   - `<emoji>-<label ?? name>`  ← canonical post-ADR-135 + TR4
  //   - `<emoji>-<name>`            ← canonical when label is unset
  //   - `<emoji><name>`             ← legacy pre-ADR-135 (no separator)
  //
  // `buildWindowName(name, emoji, label)` produces the first two; the
  // legacy form needs the dedicated detector. Once start.ts's
  // migration shim renames legacy windows to canonical, the second
  // disjunct falls off.
  return members.some(
    (m) =>
      // ADR-161 TR2: role-aware canonical form; defaults render `_-prefix`.
      name === buildWindowName(m.name, m.emoji, m.label, m.role) ||
      // ADR-135 hyphen-form — pre-ADR-161 legacy for default members
      // that haven't been migrated yet.
      name === buildWindowName(m.name, m.emoji, m.label) ||
      name === buildWindowNameLegacy(m.name, m.emoji),
  );
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

/** CONVENTION-059: canonical lane prefixes for indexed member names.
 *  Mirrors the lane slugs used in `team.json :: members[].lane` and the
 *  superdoctor / watchdog templates. Adding a lane prefix here is the
 *  intentional friction CLAUDE.md asks for — keeps the convention from
 *  drifting. */
export const CONVENTION_059_LANE_PREFIXES = [
  "fe",
  "be",
  "ops",
  "test",
  "review",
  "db",
  "misc",
] as const;
export type Convention059LanePrefix = (typeof CONVENTION_059_LANE_PREFIXES)[number];

/** `^(fe|be|ops|test|review|db|misc)\d+$` — zero-indexed, no separator. */
const INDEXED_MEMBER_NAME_REGEX = new RegExp(`^(${CONVENTION_059_LANE_PREFIXES.join("|")})\\d+$`);

/** CONVENTION-059 soft validator. Returns `null` on a name that matches
 *  the indexed-member shape (`fe0` / `be1` / `ops0` / ...), or a
 *  human-readable reason string otherwise. Advisory-only — never thrown
 *  from. Existing names that don't match (e.g. `whip-impl` on atmux,
 *  `eng-mobile` on unum) are still valid wire names per
 *  `checkMemberName`; this helper captures the *target* shape for new
 *  fungible-slot members + migration-time guidance. */
export function checkIndexedMemberName(name: string): string | null {
  if (!INDEXED_MEMBER_NAME_REGEX.test(name)) {
    return `name '${name}' does not match CONVENTION-059 indexed shape: ${INDEXED_MEMBER_NAME_REGEX.source}`;
  }
  return null;
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
 * All sites (read AND write) MUST use this resolver to reach the actual
 * live socket. The pre-2026-05-13 carve-out for write verbs (send /
 * dispatch / tell-lead / stop) was the root cause of t-f786031f: pinning
 * `/tmp/atmux-<team>/sock` unconditionally meant cage rebuilds on
 * project-local-tmpdir teams routed keystrokes at a non-existent socket,
 * surfacing as "no tmux window for lead" (tell-lead) or queued-but-
 * never-Enter'd compose-box text (send / dispatch). All four verbs were
 * migrated to `resolveTeamSocket(team)` in the same commit — keep the
 * invariant uniform across verbs to avoid the next regression.
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

/** Caller-scope verdict — `driver` or `member`. Default is `member`
 *  (fail-secure per ADR-033 §"Caller scope detection"): only an
 *  explicit `ATMUX_CALLER_SCOPE=driver` env var lets a caller pass the
 *  driver-only refuse-gate. Member panes outnumber driver panes; a
 *  default of `member` ensures auto-claim cron ticks can never bypass
 *  the gate by accident. */
export type CallerScope = "driver" | "member";

/** Test-injection seam for `resolveCallerScope`. */
export interface ResolveCallerScopeOpts {
  /** Override `process.env`. Default: live process env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the current caller's scope per ADR-033 §"Caller scope
 * detection". Interim env-only gate — `ATMUX_CALLER_SCOPE=driver`
 * returns `"driver"`; anything else (unset, empty, "member", garbage)
 * returns `"member"`.
 *
 * The bash port (`lib/common.sh::atmux::resolve_caller_scope`) layered
 * a window-name defense-in-depth check on top of the env read so
 * members couldn't bypass by `export`ing the var themselves. That
 * check keyed on the deprecated `__<team>__*` window prefix (per ADR-
 * 017 atmux teams now use bare `<emoji><member>` names) and is moot
 * post-rename; the TS port re-establishes the prefix-free defense via
 * the team-roster check in a future Task, not this minimal port. The
 * env-only gate still covers the common case: drivers `export
 * ATMUX_CALLER_SCOPE=driver` in their session, members don't.
 */
export function resolveCallerScope(opts: ResolveCallerScopeOpts = {}): CallerScope {
  const env = opts.env ?? process.env;
  return env.ATMUX_CALLER_SCOPE === "driver" ? "driver" : "member";
}
