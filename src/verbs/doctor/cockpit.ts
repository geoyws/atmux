import { readlink as fsReadlink } from "node:fs/promises";
import { exists, readTextOrNull } from "../../abstractions/fs.ts";
import { isDefaultMemberRole } from "../../abstractions/member-roles.ts";
import type { SpawnResult } from "../../abstractions/spawn.ts";
import { createTmux } from "../../abstractions/tmux.ts";
import {
  type CageHealth,
  type CageState,
  probeCageState as defaultProbeCageState,
  STARVING_THRESHOLD_S as STARVING_THRESHOLD_S_LOCAL,
} from "../../core/cage-state.ts";
import { type LoadedCockpit, loadCockpit } from "../../core/cockpit.ts";
import {
  buildWindowName,
  buildWindowNameLegacy,
  getAtmuxDir,
  resolveTeamSocket,
  tryLoadTeam,
} from "../../core/common.ts";
import type { Team, TeamMember } from "../../schema/team.ts";
import {
  type DoctorRow,
  type GitSpawn,
  defaultGitSpawn,
  truncateEvidence,
  type TmuxSpawn,
  defaultTmuxSpawn,
} from "./types.ts";

// ---------- Check 7: orphan-sessions ----------

export interface CheckOrphanSessionsOpts {
  /** hasSession override (test injection). */
  hasSession?: (name: string) => Promise<boolean>;
}

export async function checkOrphanSessions(
  team: Team | null,
  opts: CheckOrphanSessionsOpts = {},
): Promise<DoctorRow[]> {
  if (team === null || team.singleSession !== true) return [];
  const rows: DoctorRow[] = [];
  rows.push({
    status: "yellow",
    label: "single-session-discouraged",
    detail: "team has singleSession=true — cage isolation (Phase 5) is the recommended path",
    hint: "set team.json:.singleSession=false; migration helper lands with V-25 + Phase 5",
  });
  const hasSession =
    opts.hasSession ??
    (async (name: string) => {
      const tmux = createTmux({ socketPath: resolveTeamSocket(team) });
      return await tmux.session.hasSession(name);
    });
  const teamSession = `atmux-${team.name}`;
  if (await hasSession(teamSession)) {
    rows.push({
      status: "yellow",
      label: "orphan-session",
      detail: `team is single-session but legacy session '${teamSession}' still exists`,
      hint: `kill it: tmux kill-session -t ${teamSession}`,
    });
  }
  return rows;
}

// ---------- ADR-081 §D: member cage-state ----------

/** Default seconds a pane can sit at the welcome screen before doctor
 *  flags it `starving` (vs the silent `bootstrapping` transient). 60s
 *  matches the ADR-081 §D spec — long enough that a fresh claude TUI
 *  has rendered its banner + had time to consume a same-spawn brief
 *  paste, short enough that a real starvation surfaces before the
 *  operator gives up and ssh's in. */

export const STARVING_THRESHOLD_S = STARVING_THRESHOLD_S_LOCAL;

/** ADR-081 §D classifier output, unified with `atmux status` per
 *  t-74273200 / c-8ecd3a61. The taxonomy is now four states
 *  ({@link CageState}): `down`, `bootstrapping`, `active`, `wedged`.
 *
 *  Doctor's row-surfacing policy still distinguishes "transient
 *  bootstrap" (silent, uptime ≤ {@link STARVING_THRESHOLD_S}) from
 *  "starving" (yellow, uptime > threshold) — but BOTH use the shared
 *  `bootstrapping` state label so `atmux status` + `atmux doctor`
 *  never disagree on a pane's state vocabulary again.
 *
 *  Pre-unification this type included `starving` as a separate state;
 *  that value is removed. Audits searching for "starving" should grep
 *  for the row label `welcome banner persistent` (preserved in the
 *  detail text) or the new shared `wedged` state. */

export type MemberCageState = CageState;

export interface MemberCageHealth extends CageHealth {}

/** Test-side injection points for {@link checkMemberCageStates}. */

export interface CheckMemberCageStatesOpts {
  /** Override the per-member probe — single-shot fixture covers each
   *  member's classification without spinning up a real tmux server. */
  probe?: (
    team: Team,
    member: TeamMember,
    sessionName: string,
    socketPath: string,
  ) => Promise<MemberCageHealth | null>;
  /** Override `STARVING_THRESHOLD_S`. Tests use a tiny value (e.g. 0s)
   *  to exercise the starving branch without sleeping; operators can
   *  pin a custom threshold via this opt (not yet exposed on the CLI). */
  starvingThresholdSec?: number;
  /** `tmux.session.hasSession` override (test injection). */
  hasSession?: (name: string, socketPath: string) => Promise<boolean>;
}

/**
 * ADR-081 §D: per-member cage-state check. For each declared member,
 * classify into `down` / `starving` / `bootstrapping` / `active` and
 * surface a yellow row only for the operator-actionable states
 * (`down` + `starving`). Mirrors the {@link checkDriverPaneState}
 * cadence — single label across all rows: `member-cage-state:<member>`.
 *
 * Skips silently when:
 *   - `team === null` (other checks already flagged the broken state)
 *   - team session doesn't exist (the session-down state is surfaced
 *     by other checks; per-member rows would just duplicate the noise)
 */

export async function checkMemberCageStates(
  team: Team | null,
  atmuxDir: string,
  opts: CheckMemberCageStatesOpts = {},
): Promise<DoctorRow[]> {
  if (team === null) return [];
  if (team.members.length === 0) return [];

  const socketPath = resolveTeamSocket(team);
  const sessionName = `atmux-${team.name}`;
  const threshold = opts.starvingThresholdSec ?? STARVING_THRESHOLD_S;

  // Skip when the session is down — other checks already cover that.
  const hasSession =
    opts.hasSession ??
    (async (name: string, sock: string) => {
      const tmux = createTmux({ socketPath: sock });
      return await tmux.session.hasSession(name);
    });
  if (!(await hasSession(sessionName, socketPath))) return [];

  const probe = opts.probe ?? defaultProbeMemberCage;

  const rows: DoctorRow[] = [];
  for (const member of team.members) {
    const health = await probe(team, member, sessionName, socketPath);
    if (health === null) continue; // probe declined (e.g. window missing AND member.tui shell-only)

    // t-74273200: row-surfacing policy applied AFTER the unified probe
    // so `atmux status` + `atmux doctor` agree on the underlying state
    // label. Doctor still distinguishes "transient bootstrap" (silent)
    // from "starving" (yellow) via the {@link STARVING_THRESHOLD_S}
    // uptime gate — but that's a PRESENTATION decision; the state
    // taxonomy itself stays 4-way (down / bootstrapping / active /
    // wedged) per the c-8ecd3a61 root cause.
    //
    // Row colours:
    //   - active        → silent (no row)
    //   - bootstrapping → silent when uptime ≤ threshold, yellow above
    //   - down          → always yellow
    //   - wedged        → always yellow (rate-limit / heartbeat stale)
    if (health.state === "active") continue;
    if (
      health.state === "bootstrapping" &&
      health.paneUptimeSec !== null &&
      health.paneUptimeSec < threshold
    ) {
      continue;
    }

    const label = `member-cage-state:${member.name}`;
    const evidence = truncateEvidence(health.evidence, 60);
    if (health.state === "down") {
      rows.push({
        status: "yellow",
        label,
        detail: `pane down — no \`claude\` in window ${health.windowName}`,
        hint: `attach + check the pane manually, or restart via \`atmux start --force\``,
      });
      continue;
    }
    if (health.state === "wedged") {
      // Differentiate the two wedged sub-causes for the operator's
      // first-look triage: rate-limit lockout (pane classifier saw
      // "hit your limit") vs heartbeat staleness (supervisor stopped
      // writing). The detail text reads the heartbeatAgeSec field as
      // the disambiguator — present means heartbeat-stale, absent
      // means rate-limit (probe order in cage-state.ts §4 vs §6).
      const cause =
        health.heartbeatAgeSec !== null && health.heartbeatAgeSec > 0
          ? `no whip activity for ${Math.floor(health.heartbeatAgeSec / 60)}min (heartbeat stale)`
          : "rate-limit / TUI hang (pane shows rate-limit banner)";
      rows.push({
        status: "yellow",
        label,
        detail: `wedged — claude alive in ${health.windowName} but ${cause}${evidence === "" ? "" : ` (${evidence})`}`,
        hint: `attach to investigate; rate-limit waits for budget refresh, hung TUI needs \`atmux rotate ${member.name}\``,
      });
      continue;
    }
    // state === "bootstrapping" AND uptime above threshold (or unknown)
    const upMin =
      health.paneUptimeSec !== null ? `${Math.floor(health.paneUptimeSec / 60)}min` : "unknown";
    rows.push({
      status: "yellow",
      label,
      detail: `welcome banner persistent — claude alive in ${health.windowName} but brief never landed (uptime ${upMin})${evidence === "" ? "" : ` (${evidence})`}`,
      hint: `run \`atmux doctor --fix\` to re-paste the brief, or \`--force\` to override if the member is intentionally idle`,
    });
  }

  return rows;
}

/** Default per-member probe. Delegates to the unified
 *  {@link defaultProbeCageState} in `core/cage-state.ts` so `atmux
 *  status` and `atmux doctor` never disagree on the state label (per
 *  c-8ecd3a61 / t-74273200). The wrapper threads `atmuxDir` through
 *  from `checkMemberCageStates`'s outer scope (where it's already
 *  known — we don't re-derive it inside the per-member loop).
 *
 *  Exposed as a named const so tests can stub it via
 *  {@link CheckMemberCageStatesOpts.probe}. */

const defaultProbeMemberCage = async (
  team: Team,
  member: TeamMember,
  _sessionName: string,
  _socketPath: string,
): Promise<MemberCageHealth | null> => {
  // The shared probe re-derives sessionName + socketPath from the team
  // config, so we don't need to pass them through. Tests inject the
  // probe directly via opts.probe and bypass this default.
  void _sessionName;
  void _socketPath;
  // `atmuxDir` is needed for heartbeat reads in the wedged ladder.
  // checkMemberCageStates threads it in via the outer scope; the
  // default-probe shape doesn't carry it, so we resolve it inline
  // from common.ts. Best-effort: heartbeat absence collapses to the
  // pane-only signal path.
  const atmuxDir = await getAtmuxDir();
  return defaultProbeCageState(team, member, atmuxDir);
};

export interface CheckCockpitOnDefaultSocketOpts {
  /** tmux spawn override. */
  tmux?: TmuxSpawn;
  /** Cockpit session name to look for on the legacy default socket.
   *  When omitted, the probe flags ANY of the three known literals
   *  (`atx` canonical per ADR-264, plus the `atmux_cockpit` /
   *  `atmux_teams` legacies). An explicit value keeps the old
   *  single-name behavior. */
  cockpitSession?: string;
}

/**
 * ADR-162 §Decision-anchor #5 probe 2 — `cockpit-on-default-socket`.
 * Lists sessions on the legacy `default` socket and emits a yellow row
 * for each cockpit session found there. Without an explicit
 * `cockpitSession` opt, any of the three literals (`atx`,
 * `atmux_cockpit`, `atmux_teams` — ADR-264 §D5) counts as a cockpit
 * session. Self-clearing post-migration (operator runs `atmux cockpit
 * migrate-socket`; subsequent doctor runs return no row).
 *
 * Silent when:
 * - the default socket has no server (tmux `-L default` exits non-zero
 *   with "no server running"),
 * - the default socket runs sessions but none match a cockpit literal.
 */

export async function checkCockpitOnDefaultSocket(
  opts: CheckCockpitOnDefaultSocketOpts = {},
): Promise<DoctorRow[]> {
  const tmux = opts.tmux ?? defaultTmuxSpawn;
  // SUNSET(v0.9.0): ADR-264 legacy-literal shim — the `atmux_cockpit` /
  // `atmux_teams` probe literals are legacy acceptance; drop them after
  // v0.9.0 ships (ADR-266 §D1). `atx` stays.
  const probes =
    opts.cockpitSession !== undefined
      ? [opts.cockpitSession]
      : ["atx", "atmux_cockpit", "atmux_teams"];
  let result: SpawnResult;
  try {
    result = await tmux(["-L", "default", "list-sessions", "-F", "#{session_name}"]);
  } catch {
    // Spawn miss → silent (deps check covers tmux-on-PATH).
    return [];
  }
  if (result.exitCode !== 0) return []; // no server / no permission — silent
  const sessions = result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const rows: DoctorRow[] = [];
  for (const probe of probes) {
    if (!sessions.includes(probe)) continue;
    rows.push({
      status: "yellow",
      label: "cockpit-on-default-socket",
      detail: `legacy '${probe}' session detected on default socket`,
      hint:
        "run 'atmux cockpit migrate-socket' to move it to the dedicated " +
        "atmux-cockpit socket (ADR-162 §Decision-anchor #4).",
    });
  }
  return rows;
}

export interface CheckDeployedBinaryLagOpts {
  /** Git spawn override (test injection). Reads HEAD + the commit that
   *  last touched package.json. Defaults to `defaultGitSpawn`. */
  git?: GitSpawn;
  /** Reader for /opt/atmux/current symlink target. Returns the version
   *  string (e.g. `"0.8.7"`) or null when the symlink is absent /
   *  unreadable. Defaults to readlink on the canonical path. */
  readDeployedVersion?: () => Promise<string | null>;
  /** Reader for the source-tree package.json version. Defaults to
   *  reading `./package.json`. Test injection. */
  readSourceVersion?: () => Promise<string | null>;
}

/**
 * t-400a1cad — `deployed-binary-lag` warn-class probe.
 *
 * Compares the source tree (git HEAD + package.json version) against
 * the deployed binary at `/opt/atmux/current`. Emits yellow when the
 * source has commits past the deployed version — exactly the class
 * that hid t-186d5910 for ~30h (code-shipped-not-deployed).
 *
 * Signals checked, in order:
 *   1. Source package.json version vs deployed `/opt/atmux/current`
 *      symlink target. Mismatch → yellow with `atmux release` hint.
 *   2. When versions match: count commits between HEAD and the SHA
 *      that last bumped package.json. Any commits → yellow (source
 *      ahead of deploy; needs version bump + redeploy).
 *
 * Silent when:
 *   - /opt/atmux/current absent (non-system install — operator runs
 *     from source via `bun run` and doesn't deploy to /opt).
 *   - package.json absent (probe doesn't apply).
 *   - git not on PATH (deps probe covers this surface).
 *   - source ↔ deploy in sync (the green case).
 */

export async function checkDeployedBinaryLag(
  opts: CheckDeployedBinaryLagOpts = {},
): Promise<DoctorRow[]> {
  const git = opts.git ?? defaultGitSpawn;
  const readDeployedVersion =
    opts.readDeployedVersion ??
    (async (): Promise<string | null> => {
      try {
        const target = await fsReadlink("/opt/atmux/current");
        // /opt/atmux/0.8.7 → "0.8.7"
        const m = target.match(/\/([0-9]+\.[0-9]+\.[0-9]+(?:[.-][A-Za-z0-9.-]+)?)\/?$/);
        return m?.[1] ?? null;
      } catch {
        return null;
      }
    });
  const readSourceVersion =
    opts.readSourceVersion ??
    (async (): Promise<string | null> => {
      const buf = await readTextOrNull("package.json");
      if (buf === null) return null;
      try {
        const parsed = JSON.parse(buf);
        const v = parsed?.version;
        return typeof v === "string" ? v : null;
      } catch {
        return null;
      }
    });

  const [deployed, source] = await Promise.all([readDeployedVersion(), readSourceVersion()]);
  if (deployed === null) return []; // no system install — silent
  if (source === null) return []; // no source-side version — silent

  // Signal 1: version mismatch.
  if (source !== deployed) {
    return [
      {
        status: "yellow",
        label: "deployed-binary-lag",
        detail: `source package.json=${source} but /opt/atmux/current=${deployed}`,
        hint: "run `bun run build:install` (or t-c3f4c418's `atmux release` once landed) to roll forward.",
      },
    ];
  }

  // Signal 2: versions match but commits after the last bump exist.
  let headRes: SpawnResult;
  let lastBumpRes: SpawnResult;
  try {
    headRes = await git(["rev-parse", "HEAD"]);
    lastBumpRes = await git(["log", "-1", "--pretty=%H", "--", "package.json"]);
  } catch {
    return []; // git spawn miss → silent
  }
  if (headRes.exitCode !== 0 || lastBumpRes.exitCode !== 0) return [];

  const headSha = headRes.stdout.trim();
  const lastBumpSha = lastBumpRes.stdout.trim();
  if (headSha === "" || lastBumpSha === "") return [];
  if (headSha === lastBumpSha) return []; // version-bump commit IS HEAD — green

  // Count commits between last-bump and HEAD (exclusive of last-bump,
  // inclusive of HEAD).
  let countRes: SpawnResult;
  try {
    countRes = await git(["rev-list", "--count", `${lastBumpSha}..HEAD`]);
  } catch {
    return [];
  }
  if (countRes.exitCode !== 0) return [];
  const n = Number.parseInt(countRes.stdout.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return [];

  return [
    {
      status: "yellow",
      label: "deployed-binary-lag",
      detail: `${n} commit(s) after v${source} bump — source ahead of /opt/atmux/current`,
      hint: "version bump + `bun run build:install` (or `atmux release patch` per t-c3f4c418) to ship the post-bump commits.",
    },
  ];
}

export interface CheckLegacyWindowNameFormatOpts {
  /** tmux spawn override. */
  tmux?: TmuxSpawn;
  /** Cockpit reader override. Default loads `~/.atmux/cockpit.json` and
   *  returns `null` if absent / unreadable (single-cage fallback). */
  loadCockpitFn?: () => Promise<LoadedCockpit | null>;
  /** Load `team.json` from a cockpit team's root dir. Default uses
   *  `tryLoadTeam({ teamDir: <root> })`; returns `null` on absence so
   *  cockpit entries with missing team.json don't tank the whole probe. */
  loadTeamForRoot?: (root: string) => Promise<Team | null>;
  /** Socket-existence check — skips cages whose socket file isn't on
   *  disk (cage not running). Default uses `fs.exists`. */
  socketExists?: (path: string) => Promise<boolean>;
}

/**
 * EPIC e-a3077ca0 T8 — `legacy-window-name-format` warn-class probe.
 *
 * Lists tmux windows on every live cage (cockpit-walk; falls back to
 * `currentTeam` when cockpit is absent / unreadable) and flags any
 * default-member-role window that's still in a pre-ADR-161 form:
 *
 *   - `<emoji>-<member>` (ADR-135 hyphen — was default-member canonical
 *      pre-ADR-161 TR2)
 *   - `<emoji><member>`  (pre-ADR-135 no-separator)
 *
 * Default-member roles per {@link DEFAULT_MEMBER_ROLES} —
 * `team-lead` / `planner` / `reviewer` / `ombudsman`. The committer
 * role is exempt by definition (its canonical IS the hyphen form per
 * `project_adr_161_tr2_shipped` memory + ADR-159 pending). Members
 * with no role / `role: "member"` are also exempt: the hyphen IS their
 * canonical form so a hyphen-named window isn't a migration miss.
 *
 * Emits one yellow row per flagged window with a `tmux rename-window`
 * one-liner the operator can paste back. Idempotent: once renamed, the
 * canonical form lives in the window list and the probe stops firing.
 *
 * Out-of-scope (skipped silently):
 *   - Epic-viewer windows (`🌳-<eid>`) — hyphen is canonical there by
 *     spec; never default-member-role anyway.
 *   - User-added member names without a default-member role — hyphen
 *     is their canonical (per ADR-161 §D2).
 *   - Cages whose socket file isn't present (cage not running).
 *   - Cages whose `atmux-<team.name>` session isn't on the socket
 *     (non-canonical session name; out of scope for this warn).
 *
 * Driver-ref: 2026-05-18 atmux parent cage (4-day uptime, 6 windows
 * still hyphenated, `rotate-lead` refused with `no tmux window for
 * lead`). The shim wires (T2-T6) self-heal at every reachable call-
 * site, but operators wanting an at-a-glance verdict of "are any cages
 * still on the old format?" get it from this probe.
 */

export async function checkLegacyWindowNameFormat(
  currentTeam: Team | null,
  opts: CheckLegacyWindowNameFormatOpts = {},
): Promise<DoctorRow[]> {
  const tmux = opts.tmux ?? defaultTmuxSpawn;
  const loadCockpitFn =
    opts.loadCockpitFn ??
    (async (): Promise<LoadedCockpit | null> => {
      try {
        return await loadCockpit();
      } catch {
        // No cockpit / unreadable / schema error → single-cage fallback.
        return null;
      }
    });
  const loadTeamForRoot =
    opts.loadTeamForRoot ??
    (async (root: string): Promise<Team | null> => {
      try {
        return await tryLoadTeam({ teamDir: root });
      } catch {
        return null;
      }
    });
  const socketExistsFn = opts.socketExists ?? exists;

  // Build the probe target set: cockpit teams (when loadable) ∪ currentTeam.
  // Dedup by team name so a current-team that's also in cockpit isn't
  // probed twice (would emit duplicate yellow rows per flagged window).
  const targets: Array<{ team: Team }> = [];
  const seenNames = new Set<string>();
  const cockpit = await loadCockpitFn();
  if (cockpit !== null) {
    for (const ct of cockpit.teams) {
      const t = await loadTeamForRoot(ct.root);
      if (t === null) continue;
      if (seenNames.has(t.name)) continue;
      seenNames.add(t.name);
      targets.push({ team: t });
    }
  }
  if (currentTeam !== null && !seenNames.has(currentTeam.name)) {
    seenNames.add(currentTeam.name);
    targets.push({ team: currentTeam });
  }

  const rows: DoctorRow[] = [];
  for (const { team } of targets) {
    const socket = resolveTeamSocket(team);
    if (!(await socketExistsFn(socket))) continue; // cage not running
    const sessionName = `atmux-${team.name}`;
    let result: SpawnResult;
    try {
      result = await tmux([
        "-S",
        socket,
        "list-windows",
        "-t",
        sessionName,
        "-F",
        "#{window_name}",
      ]);
    } catch {
      continue; // tmux spawn failed; deps probe already covers
    }
    if (result.exitCode !== 0) continue; // session missing / non-canonical
    const windowNames = new Set(
      result.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    for (const m of team.members) {
      // Only default-member roles need the cross-format migration.
      // `role` may be undefined on older team.json — `isDefaultMemberRole`
      // already returns false for undefined.
      if (!isDefaultMemberRole(m.role)) continue;
      const canonical = buildWindowName(m.name, m.emoji, m.label, m.role);
      const hyphenForm = buildWindowName(m.name, m.emoji, m.label);
      const legacyForm = buildWindowNameLegacy(m.name, m.emoji);
      // Canonical present → no migration needed. (Defensive: if BOTH
      // canonical AND a legacy variant exist, we still flag the legacy
      // entry — it's an orphan window left behind by an interrupted
      // rename and clutters operator scroll.)
      const offenders: string[] = [];
      if (hyphenForm !== canonical && windowNames.has(hyphenForm)) {
        offenders.push(hyphenForm);
      }
      if (legacyForm !== canonical && legacyForm !== hyphenForm && windowNames.has(legacyForm)) {
        offenders.push(legacyForm);
      }
      for (const legacyName of offenders) {
        rows.push({
          status: "yellow",
          label: "legacy-window-name-format",
          detail: `${team.name} cage: window '${legacyName}' should be '${canonical}' (default-member role '${m.role}')`,
          hint: `tmux -S ${socket} rename-window -t ${sessionName}:${legacyName} ${canonical}`,
        });
      }
    }
  }
  return rows;
}
