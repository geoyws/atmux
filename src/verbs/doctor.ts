// ADR-010 + ADR-019: CLI dispatcher — `doctor` verb (V-24).
// Bash spec: lib/doctor.sh @ worktree-frozen — IN-SCOPE SUBSET per ADR-019.
//
// Environment health check. Runs the in-scope checks and reports
// green/yellow/red. `atmux start` invokes this in --quiet mode as a
// preflight (planned — V-01 `up` follow-up).
//
// In-scope checks (ADR-019):
//   - deps: tmux/jq/git required + curl/bats/shellcheck optional
//   - team: team.json existence + valid JSON + .name + .members[] +
//     per-member name/role/tui
//   - tuis: each member's TUI binary on PATH (member.command override
//     wins → tuiCommands[tui] override → built-in name)
//   - state-dir: .atmux/ writable
//   - webhook: Discord URL resolvable via `discord.resolveWebhookUrl` +
//     reachable (HTTP 405 from Discord on GET counts as green)
//   - phantom-inboxes: inbox.inProgress entries pointing to a task no
//     longer in kanban.tasks[]
//   - orphan-sessions: singleSession=true team has a stale `atmux-<team>`
//     tmux session
//
// Render: human (stderr, color, glyph table) or JSON (--json, stdout).
// --quiet suppresses output; exit 0 on green, 1 on any red.
// --fix interactively re-runs `atmux init --wizard` when team.json is
//   the red row, and prunes phantom-inbox entries (other fix paths
//   deferred per ADR-019).

import { createTmux } from "../abstractions/tmux.ts";
import {
  buildWindowName,
  defaultEmojiForRole,
  getAtmuxDir,
  type ResolveDirOpts,
  resolveTeamSocket,
  tryLoadTeam,
} from "../core/common.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import { inspectClaudeReadiness } from "../core/pane-readiness.ts";
import { classifyText } from "../core/pane-state.ts";
import {
  findPhantomInProgressClaims,
  formatPruneIso,
  prunePhantomInProgressClaims,
} from "../core/phantom-prune.ts";
import { UsageError } from "../errors.ts";
import type { Team } from "../schema/team.ts";
import {
  checkCockpitOnDefaultSocket,
  checkDeployedBinaryLag,
  checkLegacyWindowNameFormat,
  checkMemberCageStates,
  checkOrphanSessions,
  probeSessionName,
} from "./doctor/cockpit.ts";
import {
  checkCronBlock,
  checkCronIntervalDivisors,
  checkCronOrphans,
  checkReleaseNoteMissing,
  checkWhipConfigDrift,
} from "./doctor/cron.ts";
import { checkDeps } from "./doctor/deps.ts";
import { checkHonker, checkWebhook } from "./doctor/discord.ts";
import { checkDriverPaneState, checkInboxMarks } from "./doctor/driver.ts";
import {
  checkMergerFanIn,
  checkSubmoduleIntegrity,
  checkWorktreeIsolation,
  checkWorktreeNestedStateDb,
} from "./doctor/git.ts";
import { checkClaudeAccountPool, checkHostPressure } from "./doctor/host.ts";
import { checkCursorPluginCache, checkSkillsPlugin } from "./doctor/plugins.ts";
import { renderHuman, renderJson } from "./doctor/render.ts";
import {
  checkLegacyInboxJson,
  checkPhantomInboxes,
  checkPhantomInProgressClaims,
  checkStateDir,
  probeLiveMembers,
} from "./doctor/state.ts";
import {
  checkBotConfig,
  checkMemberLabelCollision,
  checkTeam,
  checkTuiCommandsClaudeOverride,
  checkTuis,
  collectSafeOrphanBranches,
} from "./doctor/team.ts";
import { checkTmuxVersionMismatch, checkVendoredTmuxBinary } from "./doctor/tmux.ts";
import { buildReport, type DoctorRow } from "./doctor/types.ts";

const USAGE = "atmux doctor [--quiet|-q] [--fix] [--json]";

// ---------- Args ----------

export interface DoctorArgs {
  quiet: boolean;
  fix: boolean;
  json: boolean;
  teamDir?: string;
}

/** Pure parser. Throws `UsageError` on bad invocation. */
export function parseDoctorArgs(argv: ReadonlyArray<string>): DoctorArgs {
  let quiet = false;
  let fix = false;
  let json = false;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--quiet" || a === "-q") {
      quiet = true;
      i += 1;
      continue;
    }
    if (a === "--fix") {
      fix = true;
      i += 1;
      continue;
    }
    if (a === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "doctor: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `doctor: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  const out: DoctorArgs = { quiet, fix, json };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Public verb entry ----------

export interface DoctorOpts {
  stdout?: Writer;
  stderr?: Writer;
  /** Inject the underlying check executors (test override). */
  runChecks?: (atmuxDir: string, team: Team | null) => Promise<DoctorRow[]>;
  /** ADR-081 §D: opts threaded into {@link fixStarvingMembers} when
   *  `--fix` finds starving rows. Test fixtures inject a no-op sleep +
   *  tiny verify deadline; production callers omit. */
  fixStarvingOpts?: FixStarvingOpts;
}

/** Default chain — all in-scope checks invoked in bash main() order. */

export async function runAllChecks(atmuxDir: string, team: Team | null): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];
  rows.push(...checkDeps());
  rows.push(...(await checkTeam(atmuxDir)));
  if (team !== null) {
    rows.push(...checkTuis(team));
    rows.push(...checkBotConfig(team));
  }
  rows.push(...(await checkStateDir(atmuxDir)));
  rows.push(...(await checkWebhook(team)));
  rows.push(...(await checkPhantomInboxes(atmuxDir)));
  rows.push(...(await checkLegacyInboxJson(atmuxDir)));
  // ADR-202 §D11: Honker substrate runtime probe. Surfaces extension-
  // load state + fallback reason so operators can see whether the
  // event-driven path is live or whether consumers are in cron-backstop
  // poll mode. Info-level when state.db absent or kill-switch off;
  // yellow on fallback (load failure / smoke fail); green on loaded.
  rows.push(...(await checkHonker(atmuxDir)));
  // ADR-184 §Amendment 2026-05-21: host-pressure probe. Surfaces the
  // /proc/loadavg + /proc/meminfo readings vs configured thresholds
  // (ATMUX_SPAWN_MAX_LOAD_RATIO + ATMUX_SPAWN_MIN_FREE_MB). Green
  // under threshold; yellow over (spawn-epic refuses); info on
  // non-Linux platforms.
  rows.push(...(await checkHostPressure()));
  // ADR-199 §D1 / §Impl-status: claudeAccountPool probe. Green when the
  // pool is populated + every entry has fresh budget probe data; yellow
  // on partial staleness (selector falls back to weight + order for stale
  // entries); red when the pool is empty AND a cockpit team has
  // claudeAccount unset (spawn-epic 401-on-bootstrap class); info when
  // the pool is unconfigured but every team pins its own account.
  rows.push(...(await checkClaudeAccountPool(process.env.HOME)));
  // ADR-217 §D5: installed-state of the /atmux: skills plugin (12
  // cockpit-tier skills shipped via plugins/atmux/, installed by the
  // wizard step in `atmux init`). Green when symlink + plugin.json
  // valid; yellow on missing / malformed; info when user opted out
  // via wizard [n]. $HOME-unset → silent no-row.
  rows.push(...(await checkSkillsPlugin()));
  // t-af159454: phantom in-progress claims (kanban rows with dead
  // owner panes). Distinct vulnerability class from phantom-inbox
  // above (that one scans member inProgress via loadInbox; this scans
  // the live kanban). Cage-only — singleSession teams short-circuit in
  // check itself.
  rows.push(...(await checkPhantomInProgressClaims(atmuxDir, team)));
  // Cursor-plugin-cache parity — only fires when cursor-agent is
  // installed AND there's at least one directory-source marketplace
  // plugin missing its `~/.claude/plugins/cache/<m>/<p>/<v>` entry.
  rows.push(...(await checkCursorPluginCache()));
  rows.push(...(await checkOrphanSessions(team)));
  // ADR-054 §D4: surface whip-config drift so the operator doesn't
  // need to wait for the next whip tick to learn about it.
  rows.push(...(await checkWhipConfigDrift(atmuxDir)));
  // ADR-057 §D5a: submodule pointer integrity (P2 finding per mismatch).
  rows.push(...(await checkSubmoduleIntegrity()));
  // ADR-057 §D5c: inbox-mark verification (P3 finding per orphan id).
  rows.push(...(await checkInboxMarks(atmuxDir)));
  // ADR-064 §4: driver-pane health (no row when team unconfigured).
  rows.push(...(await checkDriverPaneState(team, atmuxDir)));
  // ADR-081 §D: per-member cage-state — surface `starving` panes whose
  // brief never landed, and `down` panes where claude isn't running.
  // Silent on a healthy team (active members emit no row).
  rows.push(...(await checkMemberCageStates(team, atmuxDir)));
  // ADR-079 §A: cron interval values must be divisors of 60 (minutes)
  // or 24 (hours). Yellow per offender; surfaces before atmux start.
  rows.push(...checkCronIntervalDivisors(team));
  // ADR-083 follow-up §DEFERRED row 2: cron-orphans — yellow per
  // marker block whose `ATMUX_DIR=` path no longer exists on disk
  // (moved / deleted projects). Silent on hosts without crontab.
  rows.push(...(await checkCronOrphans()));
  // t-dcbff97c §2: RED when team opts into cron-auto-install but no
  // managed block is present. Catches the failure mode that killed the
  // atmux team three consecutive overnights (cron block silently absent
  // → no whip pulse → lead stalls). Silent on opt-out + cron-less hosts.
  rows.push(...(await checkCronBlock(team)));
  // t-589145dc (c-alias Ask C, ADR-094): YELLOW when tuiCommands.claude
  // pins the DEFAULT CLAUDE_CONFIG_DIR — breaks fresh-spawn TUI auth
  // (forces OAuth re-run in every nested shell). Silent when claude is
  // absent or uses a non-default suffix.
  rows.push(...checkTuiCommandsClaudeOverride(team));
  // ADR-082 §5 W5: per-member worktree-isolation anomalies. Returns
  // empty when team is null (checkTeam already surfaced the broken
  // state) or when isolation is off AND no leftover dirs exist.
  rows.push(...(await checkWorktreeIsolation(team, atmuxDir)));
  // ADR-245 single-kanban invariant (#3 defensive probe; t-62-df4e59bd):
  // RED per nested `<atmuxDir>/worktrees/*/.atmux/state.db`. Worktrees
  // share the team-root kanban; a worktree-local state.db means a verb
  // wrote a diverging kanban instead of resolving UP. Failsafe behind the
  // four preventive hooks (getAtmuxDir strip-back, provisioning team.json-
  // only, orchd-window spawn guard, checkWorktreeIsolation orphan walk).
  rows.push(...(await checkWorktreeNestedStateDb(team, atmuxDir)));
  // ADR-136 TR4: member-label-collision — warn when 2+ members share
  // the same `(emoji, label-or-name)` display tuple. Pure (no I/O);
  // returns [] when team is null OR no collisions exist.
  rows.push(...checkMemberLabelCollision(team));
  // ADR-179 §Decision-6 W6: merger-fan-in anomalies — stale per-member
  // branch + role/feature-flag mismatch. Silent when `team.merger` is
  // unset or `merger.enabled !== true` (the staleness branch); the
  // role-mismatch branch surfaces regardless when a `role: "merger"`
  // member exists with the feature off.
  rows.push(...(await checkMergerFanIn(team, atmuxDir)));
  // ADR-147 §D5 / T6: backstop probe for the release-notes daily
  // log. Warn class only — never blocks; surfaces missed days so
  // ombudsman can backfill. Silent in environments without git
  // (CI agents probing fresh trees, non-repo cages).
  rows.push(...(await checkReleaseNoteMissing()));
  // ADR-162 §Decision-anchor #5: warn-class tmux infrastructure
  // probes. Both surface only when the host tmux drifts (version) or
  // when a legacy cockpit lingers on the default socket. Self-clearing
  // post-migration. Never blocks.
  rows.push(...(await checkTmuxVersionMismatch()));
  // ADR-191: vendored tmux at /opt/atmux/current/bin/tmux. Warn when
  // absent (resolveTmuxBin() falls through to system tmux) or when
  // present-but-version-drift. Self-clearing post-build:install.
  rows.push(...(await checkVendoredTmuxBinary()));
  rows.push(...(await checkCockpitOnDefaultSocket()));
  // t-400a1cad: deployed-binary-lag — warn class.
  // t-400a1cad: deployed-binary-lag — warn class. Compares git HEAD +
  // package.json version against /opt/atmux/current symlink target.
  // Catches the "code-shipped-not-deployed" class that hid t-186d5910
  // for ~30h. Silent on non-system install (no /opt/atmux/current) or
  // missing package.json (probe doesn't apply).
  rows.push(...(await checkDeployedBinaryLag()));
  // EPIC e-a3077ca0 T8: legacy-window-name-format — warn class.
  // Walks every cockpit cage (falls back to currentTeam if cockpit
  // is absent / unreadable) and flags default-member-role windows
  // still on hyphen / no-separator forms. Self-clearing once the
  // operator runs the suggested `tmux rename-window` one-liner OR
  // the shim wires (T2-T6) heal them on the next addressing call.
  rows.push(...(await checkLegacyWindowNameFormat(team)));
  return rows;
}

/** `atmux doctor [--quiet|-q] [--fix] [--json]`. Returns 0 on green, 1 on red. */

export async function doctor(argv: ReadonlyArray<string>, opts: DoctorOpts = {}): Promise<number> {
  const parsed = parseDoctorArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  // Try to load the team — if it's missing/invalid, checkTeam will emit
  // the red row; downstream checks that need team handle null defensively.
  let team: Team | null = null;
  try {
    team = await tryLoadTeam(dirOpts);
  } catch {
    team = null;
  }

  const stdout = opts.stdout ?? defaultStdoutWrite;
  const stderr = opts.stderr ?? defaultStderrWrite;
  const runChecks = opts.runChecks ?? runAllChecks;

  const rows = await runChecks(atmuxDir, team);
  const report = buildReport(rows);

  if (parsed.json) {
    stdout(renderJson(report));
  } else if (!parsed.quiet) {
    stderr(renderHuman(report));
  }

  // --fix runs three actions, in order of operator value:
  //   1. ADR-081 §D — re-paste the role brief on every starving member
  //      so the operator doesn't have to ssh in + run the manual
  //      recovery sequence captured in the ADR's audit trail.
  //   2. ADR-084 W2 (branch-orphan) — dry-run summary of safe-to-delete
  //      orphan branches; actual deletion stays deferred per ADR-019.
  //   3. t-af159454 — phantom in-progress prune (operator can collapse
  //      cited phantom claim IDs in one shot).
  // Other --fix paths (branch-orphan deletion, team.json wizard re-run)
  // remain stubbed pending ADR-019 §"Fix" resolution; the trailing
  // hint below covers the residual.
  if (parsed.fix && !parsed.quiet) {
    // ADR-081 §D: real --fix action — re-paste the brief on starving
    // members so the operator doesn't have to ssh in + run the manual
    // recovery sequence captured in the ADR's audit trail. Runs BEFORE
    // the dry-run report so any successful re-pastes flip rows to active
    // in the user's mental model.
    if (team !== null) {
      const starving = collectStarvingMembers(report.rows);
      if (starving.length > 0) {
        await fixStarvingMembers(team, atmuxDir, starving, opts.fixStarvingOpts ?? {}, stderr);
      }
    }
    const safeOrphans = collectSafeOrphanBranches(report.rows);
    if (safeOrphans.length > 0) {
      stderr(
        `\natmux doctor --fix (dry-run): would delete ${safeOrphans.length} orphan branch(es):\n`,
      );
      for (const branch of safeOrphans) {
        stderr(`  - ${branch}\n`);
      }
    }
    if (team !== null && team.singleSession !== true) {
      const phantoms = await findPhantomInProgressClaims({
        atmuxDir,
        team,
        liveMembers: () => probeLiveMembers(team, atmuxDir),
      });
      if (phantoms.length > 0) {
        const asOfIso = formatPruneIso(Date.now());
        const result = await prunePhantomInProgressClaims({
          atmuxDir,
          phantoms,
          asOfIso,
          source: "doctor-fix",
        });
        stderr(
          `\natmux doctor --fix: pruned ${result.prunedIds.length} phantom in-progress claim(s)` +
            (result.alreadyPrunedIds.length > 0
              ? ` (+${result.alreadyPrunedIds.length} already-pruned)`
              : "") +
            ":\n",
        );
        for (const id of result.prunedIds) stderr(`  - ${id} → blocked (${asOfIso})\n`);
      }
    }
    // Other --fix paths (branch-orphan deletion, team.json wizard
    // re-run) remain deferred per ADR-019 V-24. Phantom-prune above
    // ships in t-af159454; the residual hint covers the rest.
    stderr(
      "\natmux doctor --fix: V-24 ships read-only checks; --fix actions deferred per ADR-019.\n",
    );
  }

  return report.redCount === 0 ? 0 : 1;
}

/**
 * ADR-081 §D: scan doctor rows for starving-member yellow rows.
 * Returns the member names extracted from the `member-cage-state:<name>`
 * label suffix. The "starving" branch of {@link checkMemberCageStates}
 * is identified by the row's `detail` text containing `welcome banner
 * persistent` — stable substring per the row composer.
 *
 * Exported for direct unit-testing without spinning the full doctor
 * pipeline. Pure scan; no IO.
 */

export function collectStarvingMembers(rows: ReadonlyArray<DoctorRow>): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.status !== "yellow") continue;
    if (!r.label.startsWith("member-cage-state:")) continue;
    if (r.detail === undefined) continue;
    if (!r.detail.includes("welcome banner persistent")) continue;
    out.push(r.label.slice("member-cage-state:".length));
  }
  return out;
}

/**
 * ADR-081 §D: re-paste the role brief on each starving member via the
 * same path `atmux start` uses (`pasteBriefForMember` exported from
 * `verbs/start.ts`), with `spawnWaitMs=0` because the TUI is already
 * alive — no welcome-screen settle needed.
 *
 * After paste, probes each pane for up to 30s (ADR-081 §D acceptance)
 * to confirm ctx > 0 OR welcome banner cleared. Surfaces the result to
 * stderr; failures degrade gracefully (no throw) — best-effort matches
 * the rest of the doctor verb's behaviour.
 */

async function fixStarvingMembers(
  team: Team,
  atmuxDir: string,
  starving: ReadonlyArray<string>,
  opts: FixStarvingOpts,
  stderr: Writer,
): Promise<void> {
  // Lazy import — keeps the import surface of doctor.ts narrow and
  // avoids the verb-to-verb cycle risk if start.ts ever ends up
  // importing doctor symbols.
  const { pasteBriefForMember } = await import("./start.ts");
  const { defaultBriefsDir } = await import("./rotate.ts");

  const socketPath = resolveTeamSocket(team);
  // Anchor-aware, bare-name default (e-419553c6): the rows being fixed
  // came from checkMemberCageStates, which resolved the session the
  // same way — a hand-built literal here would re-paste into a session
  // that may not exist under that name.
  const sessionName = await probeSessionName(team, { atmuxDir });
  const tmux = createTmux({ socketPath });
  const briefsDir = opts.briefsDir ?? defaultBriefsDir();
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const verifyDeadlineMs = opts.verifyDeadlineMs ?? 30_000;
  const verifyPollIntervalMs = opts.verifyPollIntervalMs ?? 1_000;

  stderr(`\natmux doctor --fix: re-pasting brief on ${starving.length} starving member(s)\n`);

  for (const memberName of starving) {
    const member = team.members.find((m) => m.name === memberName);
    if (member === undefined) {
      stderr(`  ✗ ${memberName}: not in roster — skipping\n`);
      continue;
    }
    const emoji = member.emoji ?? defaultEmojiForRole(member.role ?? "member");
    // Use the spawn-side window-name builder so re-paste targets the same
    // window names start.ts created — honours ADR-135 (hyphen) for
    // user-added members AND ADR-161 (`_`-prefix) for default-member roles
    // (team-lead/planner/reviewer/ombudsman). The legacy `${emoji}${name}`
    // shape predated both ADRs and silently no-ops on every modern team.
    const memberLabel = (member as { label?: string }).label;
    const windowName = buildWindowName(member.name, emoji, memberLabel, member.role);
    const target = `${sessionName}:${windowName}`;
    const role = typeof member.role === "string" ? member.role : "member";
    const sendTarget =
      role === "team-lead"
        ? ({ kind: "lead" as const, team: team.name, target } as const)
        : ({ kind: "member" as const, member: member.name, team: team.name, target } as const);

    // The fix call mirrors start.ts's spawn-time invocation but with
    // `spawnWaitMs=0` — the TUI is already up, no welcome-screen
    // settle is required.
    try {
      await pasteBriefForMember({
        tmux,
        target: sendTarget,
        member: member.name,
        role,
        team: team.name,
        atmuxDir,
        briefsDir,
        spawnWaitMs: 0,
        sleep,
        logger: {
          log: (s: string) => stderr(`    ${s}\n`),
          warn: (s: string) => stderr(`    ${s}\n`),
          ok: (s: string) => stderr(`    ${s}\n`),
          err: (s: string) => stderr(`    ${s}\n`),
        },
      });
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      stderr(`  ✗ ${memberName}: paste failed — ${cause}\n`);
      continue;
    }

    // Verify within deadline that the pane transitioned to active.
    const verified = await verifyStarvingResolved(
      tmux,
      target,
      verifyDeadlineMs,
      verifyPollIntervalMs,
      sleep,
    );
    if (verified) {
      stderr(`  ✅ ${memberName}: brief re-pasted + pane reached active state\n`);
    } else {
      stderr(
        `  ⚠ ${memberName}: brief re-pasted but pane did NOT reach active within ${verifyDeadlineMs}ms — inspect manually\n`,
      );
    }
  }
}

/** ADR-081 §D verification step — poll a pane up to `deadlineMs` for
 *  transition from starving → active (ctx > 0 OR banner cleared).
 *  Pure-ish: tmux IO + sleep, no other side effects. */

async function verifyStarvingResolved(
  tmux: ReturnType<typeof createTmux>,
  target: string,
  deadlineMs: number,
  pollIntervalMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    let text = "";
    try {
      text = await tmux.pane.capturePane({ target, start: -30 });
    } catch {
      // Pane vanished mid-verify — caller treats as not-resolved.
      return false;
    }
    const classification = classifyText(text);
    const verdict = inspectClaudeReadiness(text, classification, true);
    if (verdict === "ready") return true;
    await sleep(pollIntervalMs);
  }
  return false;
}

/** Options for `fixStarvingMembers`. Tests inject sleep + verify deadline
 *  to keep unit suites fast; the `verbs/doctor` CLI path passes nothing
 *  (defaults: real setTimeout, 30s deadline, 1s poll). */

export interface FixStarvingOpts {
  /** Override the briefs dir resolution (test injection). */
  briefsDir?: string;
  /** Sleep override — defaults to `setTimeout`-backed promise. */
  sleep?: (ms: number) => Promise<void>;
  /** Wall-clock budget for the post-paste verify probe. Default 30_000ms
   *  per ADR-081 §D acceptance. */
  verifyDeadlineMs?: number;
  /** Poll interval inside the verify loop. Default 1_000ms — balances
   *  responsiveness with not hammering the tmux server. */
  verifyPollIntervalMs?: number;
}

export {
  type CheckCockpitOnDefaultSocketOpts,
  type CheckDeployedBinaryLagOpts,
  type CheckLegacyWindowNameFormatOpts,
  type CheckMemberCageStatesOpts,
  type CheckOrphanSessionsOpts,
  checkCockpitOnDefaultSocket,
  checkDeployedBinaryLag,
  checkLegacyWindowNameFormat,
  checkMemberCageStates,
  checkOrphanSessions,
  type MemberCageHealth,
  type MemberCageState,
  STARVING_THRESHOLD_S,
} from "./doctor/cockpit.ts";
export {
  type CheckCronBlockOpts,
  type CheckCronOrphansOpts,
  type CheckReleaseNoteMissingOpts,
  checkCronBlock,
  checkCronIntervalDivisors,
  checkCronOrphans,
  checkReleaseNoteMissing,
  checkWhipConfigDrift,
} from "./doctor/cron.ts";
export { type CheckDepsOpts, checkDeps, installHint } from "./doctor/deps.ts";
export {
  type CheckWebhookOpts,
  checkHonker,
  checkWebhook,
  honkerStateRows,
} from "./doctor/discord.ts";
export {
  type CheckDriverPaneStateOpts,
  type CheckInboxMarksOpts,
  checkDriverPaneState,
  checkInboxMarks,
  findInboxTaskMarks,
  type InboxMarkOrphan,
} from "./doctor/driver.ts";
export {
  type CheckMergerFanInOpts,
  type CheckSubmoduleIntegrityOpts,
  type CheckWorktreeNestedStateDbOpts,
  type CheckWorktreeOpts,
  checkMergerFanIn,
  checkSubmoduleIntegrity,
  checkWorktreeIsolation,
  checkWorktreeNestedStateDb,
  parseSubmoduleStatus,
  type SubmoduleStatus,
} from "./doctor/git.ts";
export {
  type CheckClaudeAccountPoolDeps,
  type ClaudeAccountPoolVerdict,
  checkClaudeAccountPool,
  checkHostPressure,
  claudeAccountPoolRows,
  hostPressureRows,
} from "./doctor/host.ts";
export {
  type CheckMemberForcePushRecentOpts,
  type CheckSendKeysFailureRecentOpts,
  checkMemberForcePushRecent,
  checkSendKeysFailureRecent,
} from "./doctor/member-ops.ts";
export {
  type CheckCursorPluginCacheOpts,
  type CheckSkillsPluginOpts,
  checkCursorPluginCache,
  checkSkillsPlugin,
  type SkillsPluginState,
  skillsPluginStateRows,
} from "./doctor/plugins.ts";
export { renderHuman, renderJson } from "./doctor/render.ts";
export {
  checkLegacyInboxJson,
  checkPhantomInboxes,
  checkPhantomInProgressClaims,
  checkStateDir,
  findLegacyInboxJson,
  findPhantomInboxes,
  type PhantomEntry,
} from "./doctor/state.ts";
export {
  type CheckTuisOpts,
  checkBotConfig,
  checkMemberLabelCollision,
  checkTeam,
  checkTuiCommandsClaudeOverride,
  checkTuis,
  collectSafeOrphanBranches,
  firstBin,
  resolveMemberBin,
} from "./doctor/team.ts";
export {
  type CheckTmuxVersionOpts,
  type CheckVendoredTmuxBinaryOpts,
  checkTmuxVersionMismatch,
  checkVendoredTmuxBinary,
  compareTmuxVersion,
  type ParsedTmuxVersion,
  parseTmuxVersion,
  TMUX_MIN_VERSION,
  TMUX_TESTED_VERSION,
} from "./doctor/tmux.ts";
// ---------- Re-exports (ADR-266 split: probes live under ./doctor/) ----------
export {
  buildReport,
  type DoctorReport,
  type DoctorRow,
  type DoctorStatus,
  type GitSpawn,
  type TmuxSpawn,
} from "./doctor/types.ts";
