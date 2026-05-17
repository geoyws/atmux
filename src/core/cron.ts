// Bun-port cron-block render module. Source of truth for what lines an
// atmux team's managed crontab block contains. Mirrors bash
// `lib/cron.sh::_atmux_cron_render_lines` (the bash module is what
// actually installs the block today; this TS module is the spec a future
// bun-port `src/verbs/cron.ts` install verb will render against — see
// the Phase-2 deferral note at `src/verbs/start.ts:63-64`).
//
// Block shape (marker-fenced, idempotent re-install via fence-replace).
// ADR-160 rename: emitted verbs are `poke` + `poke-resume-check`;
// legacy `whip` + `whip-resume-check` cron lines from pre-rename
// installs still route here via the cli.ts deprecation alias for one
// release cycle.
//
//     # >>> atmux:team=<n> — managed by atmux start; do not edit by hand
//     */15 * * * * <atmuxDir prefix> atmux poke                 >> .../poke.log 2>&1
//     */30 * * * * <prefix> atmux report                         >> .../report.log 2>&1
//     0 */4 * * * <prefix> atmux decisions digest                >> .../decisions-digest.log 2>&1
//     0 4 * * * <prefix> atmux groom --quiet                     >> .../groom.log 2>&1
//     */1 * * * * <prefix> atmux poke-resume-check               >> .../poke-resume-check.log 2>&1   ← ADR-053 §D4
//     # <<< atmux:team=<n>
//
// Conditional lines (omitted when the gating condition is false):
//   - `poke-resume-check` (1-min): only when `team.whip.claudeAccount`
//     is set. Teams without budget observability skip the noise.
//     The `team.whip.*` config field name is unchanged (ADR-160
//     §Decision-anchor #1 — config-compat preservation).
//   - `discorder progress` + `discorder heartbeat`: when team has a
//     `role: "discorder"` member; replaces the regular `report` line.
//   - `unblocker tick` (2-min): when team has a `role: "unblocker"`
//     member.
//   - `lane-tick` (2-min, ADR-062 §Decision 4): when ≥1 member has a
//     non-empty `.lane` field AND `team.crons.laneTickEnabled !== false`.
//
// Rendering is pure — no I/O, no flock — so the install verb (when it
// lands) can sandwich the rendering in atomic-rename + flock per its
// own preference.

import type { CrontabIO } from "../abstractions/crontab.ts";
import { ConfigError } from "../errors.ts";
import {
  DEFAULT_AUTO_MERGE_CRON_BACKSTOP_MIN,
  DEFAULT_LANE_STALL_CRON_INTERVAL_MINS,
  DEFAULT_LANE_TICK_CRON_MINS,
  DEFAULT_MERGER_CYCLE_INTERVAL_MINS,
  DEFAULT_OMBUDSMAN_TICK_INTERVAL_MINS,
  type Team,
} from "../schema/team.ts";

/**
 * ADR-079 §A: render a "star-slash-N stars" cron expression for an
 * "every N minutes" line. Throws `ConfigError` when N is outside 1–60
 * OR not a divisor of 60 (per ADR-079 OQ-A1: fail-fast at render time
 * keeps silently-broken schedules out of the wild).
 *
 * Why divisor-of-60: cron's star-slash-N expansion always anchors at
 * minute 0, so e.g. star-slash-7 fires at xx:00, xx:07, xx:14, xx:21,
 * xx:28, xx:35, xx:42, xx:49, xx:56, then xx:00 — final gap is 4
 * minutes, not 7. The operator's intent ("every 7 minutes") doesn't
 * match cron semantics.
 *
 * The doctor's `cron-interval-divisor` check surfaces the same
 * condition as a yellow row at config-load time, so operators see the
 * warning BEFORE `atmux start` trips this throw.
 *
 * @param minutes — must be one of: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20,
 *   30, 60. Other positive ints in 1–59 throw.
 */
export function cronEvery(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 60) {
    throw new ConfigError({
      what: `cronEvery: minutes must be 1–60 (got ${minutes})`,
      hint: "edit team.json — use one of: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60",
    });
  }
  if (minutes === 60) return "0 * * * *";
  if (60 % minutes === 0) return `*/${minutes} * * * *`;
  throw new ConfigError({
    what: `cronEvery: ${minutes} is not a divisor of 60 — cron */${minutes} would skew (cron's */N anchors at xx:00 and the final gap before the next hour is shorter than N)`,
    hint: "use one of: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60",
  });
}

/**
 * ADR-079 §A: render a "0 star-slash-N star star star" cron expression
 * for an "every N hours, on the hour" line. Throws `ConfigError` when
 * N is outside 1–24 OR not a divisor of 24. Same reasoning as
 * `cronEvery` but on the 24-hour cycle: star-slash-5 fires at 00:00,
 * 05:00, 10:00, 15:00, 20:00, then 00:00 — final gap is 4 hours, not 5.
 *
 * @param hours — must be one of: 1, 2, 3, 4, 6, 8, 12, 24.
 */
export function cronEveryHour(hours: number): string {
  if (!Number.isInteger(hours) || hours <= 0 || hours > 24) {
    throw new ConfigError({
      what: `cronEveryHour: hours must be 1–24 (got ${hours})`,
      hint: "edit team.json — use one of: 1, 2, 3, 4, 6, 8, 12, 24",
    });
  }
  if (hours === 24) return "0 0 * * *";
  if (hours === 1) return "0 * * * *";
  if (24 % hours === 0) return `0 */${hours} * * *`;
  throw new ConfigError({
    what: `cronEveryHour: ${hours} is not a divisor of 24 — cron 0 */${hours} would skew`,
    hint: "use one of: 1, 2, 3, 4, 6, 8, 12, 24",
  });
}

/**
 * ADR-079 §A: render a `0 H * * *` cron expression for a "daily at
 * hour H" line. Throws `ConfigError` when H is outside 0–23.
 *
 * @param hour — 0–23 (0 = midnight, 23 = 11pm).
 */
export function cronAtHour(hour: number): string {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new ConfigError({
      what: `cronAtHour: hour must be 0–23 (got ${hour})`,
      hint: "edit team.json::groom.atHour",
    });
  }
  return `0 ${hour} * * *`;
}

export interface RenderCronBlockOpts {
  /** Team config (whip + members shape used to gate conditional lines). */
  team: Team;
  /** Absolute path to the team's `.atmux/` dir; baked into ATMUX_DIR= +
   *  `>> <atmuxDir>/logs/<verb>.log` redirects. */
  atmuxDir: string;
  /** Absolute path to the atmux binary on disk. Cron runs without the
   *  user's PATH; this must be an absolute path or `cron` will silently
   *  refuse the line. */
  atmuxBin: string;
  /** Optional `TMUX_TMPDIR=<value> ` prefix per ADR-018 (cage socket
   *  isolation). Bash equivalent: `lib/cron.sh:46-48`. */
  tmuxTmpdir?: string;
  /** ADR-088 W7 (t-2f12839e) — transient override for the `merge-cycle`
   *  line's cadence (minutes). When set, beats the team.merger
   *  .cycleIntervalMins config for THIS render. Used by `atmux
   *  cron-install --template merge-cycle --interval <N>` so the
   *  operator can pin a one-off cadence without rewriting team.json. */
  mergerIntervalOverride?: number;
  /** ADR-147 T3 (t-94a22bb0) — transient override for the `ombudsman
   *  tick` line's cadence (minutes). When set, beats the team
   *  .ombudsman.tickIntervalMins config for THIS render. Same
   *  cron-install --interval threading pattern as
   *  {@link mergerIntervalOverride}. */
  ombudsmanIntervalOverride?: number;
  /** ADR-148 §D4 / T3 (t-e9424574) — transient override for the
   *  `lane-stall-tick` line's cadence (minutes). When set, beats
   *  {@link DEFAULT_LANE_STALL_CRON_INTERVAL_MINS}. Threaded via
   *  `cron-install --template lane-stall-watch --interval <N>`. */
  laneStallIntervalOverride?: number;
  /** ADR-134 T7 (t-a87a39f1) — transient override for the
   *  `gitter --sweep` cron-backstop line's cadence (minutes). When set,
   *  beats `team.autoMerge.cronBackstopMin` and the
   *  {@link DEFAULT_AUTO_MERGE_CRON_BACKSTOP_MIN} fallback. Threaded
   *  via `cron-install --template gitter-sweep --interval <N>`. */
  gitterSweepIntervalOverride?: number;
  /** ADR-091 §State machine (t-04350614) — transient override for the
   *  `epic-merge tick` line's cadence (minutes). When set, beats
   *  {@link DEFAULT_EPIC_MERGE_CRON_INTERVAL_MINS}. Threaded via
   *  `cron-install --template epic-merge --interval <N>`. The line
   *  is gated on `team.epicTeam !== undefined` (only epic-teams get
   *  the cron line) — normal teams skip the gate-test entirely. */
  epicMergeIntervalOverride?: number;
}

/**
 * Render the marker-fenced crontab block as a single string (final
 * trailing newline included, matching bash `crontab -l` round-trip
 * convention).
 *
 * Idempotence guarantee: passing the SAME opts twice yields a
 * byte-identical string. The bash-side install verb's strip-block
 * + re-append flow remains the only thing that needs to dedupe by
 * marker fence; the renderer here is pure.
 */
export function renderCronBlock(opts: RenderCronBlockOpts): string {
  const lines = renderCronLines(opts);
  const header = `# >>> atmux:team=${opts.team.name} — managed by atmux start; do not edit by hand`;
  const footer = `# <<< atmux:team=${opts.team.name}`;
  return `${header}\n${lines.join("\n")}\n${footer}\n`;
}

/**
 * Render the body lines (no marker fence). Useful for tests + for the
 * install verb to re-fence under different markers.
 */
export function renderCronLines(opts: RenderCronBlockOpts): string[] {
  const { team, atmuxDir, atmuxBin } = opts;
  const tmuxPrefix =
    opts.tmuxTmpdir !== undefined && opts.tmuxTmpdir !== ""
      ? `TMUX_TMPDIR=${opts.tmuxTmpdir} `
      : "";

  // Bug t-2db59eee: cron's bare env on Ubuntu lacks /root/.bun/bin, so
  // atmux-bun's `#!/usr/bin/env bun` shebang dies with bun-not-found.
  // Bake an inline `PATH=<value> ` prefix into every line so each cron
  // entry resolves bun regardless of cron's narrow env. Honors a
  // `team.cron.path` override; defaults target hax (mise bun layout).
  const cronPath = team.cron?.path ?? "/root/.bun/bin:/usr/local/bin:/usr/bin:/bin";
  const pathPrefix = `PATH=${cronPath} `;

  const baseEnv = `${pathPrefix}${tmuxPrefix}ATMUX_DIR=${atmuxDir} ${atmuxBin}`;
  const logTail = (verb: string) => `>> ${atmuxDir}/logs/${verb}.log 2>&1`;

  const out: string[] = [];

  // ADR-079 §A: cron schedules read from team config, with sensible
  // defaults that reproduce the prior hardcoded literals when no fields
  // are set. cronEvery / cronEveryHour / cronAtHour throw `ConfigError`
  // at render time on out-of-range or non-divisor values; the doctor's
  // `cron-interval-divisor` check surfaces the same warning at
  // config-load time so operators see it before `atmux start` trips.
  // t-dcbff97c §4 (George 08:00 MYT call 2026-05-13): default raised
  // from 5 → 15min. Auto-drain teams (members pull from kanban via
  // `atmux claim --next`) only need the lead awake ~4× / hour; a 5min
  // cadence amplifies whip's rate-limit footprint without commensurate
  // benefit. Operators who want tighter cadence set `team.whip.intervalMins`
  // explicitly (sopx historically pins 5).
  const whipMins = team.whip?.intervalMins ?? 15;
  const reportMins = team.report?.intervalMins ?? 30;
  const heartbeatHours = team.report?.heartbeatHours ?? 1;
  const decisionsHours = team.decisions?.intervalHours ?? 4;
  const groomHour = team.groom?.atHour ?? 4;
  const unblockerMins = team.unblocker?.intervalMins ?? 2;

  // 1. poke — full sweep on team.whip.intervalMins (default 15).
  // ADR-160 rename: the verb is `atmux poke` going forward. The
  // `team.whip.intervalMins` CONFIG field stays (config-compat
  // preservation per ADR-160 §Decision-anchor #1 — source rename is
  // atmux-internal-source scope only). Legacy `atmux whip` cron lines
  // continue to route here via the cli.ts deprecation alias for one
  // release cycle; emit canonical `atmux poke` on every cron-install.
  out.push(`${cronEvery(whipMins)} ${baseEnv} poke ${logTail("poke")}`);

  // 2. report or discorder pair (mutually exclusive per ADR-022 OQ-D4).
  const hasDiscorder = team.members.some((m) => (m as { role?: string }).role === "discorder");
  if (hasDiscorder) {
    out.push(
      `${cronEvery(reportMins)} ${baseEnv} discorder progress ${logTail("discorder-progress")}`,
    );
    out.push(
      `${cronEveryHour(heartbeatHours)} ${baseEnv} discorder heartbeat ${logTail("discorder-heartbeat")}`,
    );
  } else {
    out.push(`${cronEvery(reportMins)} ${baseEnv} report ${logTail("report")}`);
  }

  // 3. decisions digest — every team.decisions.intervalHours (default 4).
  out.push(
    `${cronEveryHour(decisionsHours)} ${baseEnv} decisions digest ${logTail("decisions-digest")}`,
  );

  // 4. groom — daily at team.groom.atHour (default 4 = quietest window).
  out.push(`${cronAtHour(groomHour)} ${baseEnv} groom --quiet ${logTail("groom")}`);

  // 5. poke-resume-check — every 1 minute, gated on claudeAccount.
  // ADR-053 §D4 (Option B): isolated cheap path so post-pause auto-
  // resume latency drops from up-to-5min to up-to-1min without bumping
  // full poke's intervalMins cadence (which would amplify any poke-side
  // bug). Hardcoded 1-min — sub-1-min cadence isn't a tunable, it's the
  // deliberate post-pause latency floor (per ADR-079 §A). ADR-160
  // rename: emits canonical `atmux poke-resume-check`; legacy
  // `whip-resume-check` cron lines route here via cli.ts alias.
  if (team.whip?.claudeAccount !== undefined && team.whip.claudeAccount !== "") {
    out.push(`*/1 * * * * ${baseEnv} poke-resume-check ${logTail("poke-resume-check")}`);
  }

  // 6. unblocker tick — every team.unblocker.intervalMins (default 2),
  // gated on a member with role=unblocker.
  const hasUnblocker = team.members.some((m) => (m as { role?: string }).role === "unblocker");
  if (hasUnblocker) {
    out.push(`${cronEvery(unblockerMins)} ${baseEnv} unblocker tick ${logTail("unblocker")}`);
  }

  // 7. lane-tick — ADR-062 §Decision 4 + ADR-157 §D6 cadence relaxation.
  // Default cadence relaxed from `*/2` to `*/5` (DEFAULT_LANE_TICK_CRON_MINS)
  // because /goal (Claude Code v2.1.139+ skill) drives fast handoff on
  // the happy path via per-turn Haiku evaluator; lane-tick runs at 5min
  // as a structural backstop for failure modes /goal cannot see (wedged
  // panes, rate-lockouts, compaction-wipe). Per-team override via
  // `team.crons.laneTickMins` — divisor of 60 validated by schema-side
  // refinement; `cronEvery` rejects non-divisors as a second line of
  // defense. Lower bound floor is /goal mean-time-to-detect-failure × 2
  // (~5min); ceiling `*/10` acceptable with operator validation.
  //
  // Gated by BOTH:
  //   (a) ≥1 member has a non-empty `.lane` field (no lanes ⇒ nothing
  //       for lane-tick to do; emitting the line would just spin a
  //       no-op cron call), AND
  //   (b) `team.crons.laneTickEnabled !== false` (per-team kill-switch
  //       per ADR-062 §Rollback; default true so existing teams pick
  //       up the line as soon as any member acquires a `.lane`).
  const hasLaneMember = team.members.some((m) => {
    const lane = (m as { lane?: string }).lane;
    return typeof lane === "string" && lane.length > 0;
  });
  const laneTickEnabled = team.crons?.laneTickEnabled !== false;
  if (hasLaneMember && laneTickEnabled) {
    const laneTickMins = team.crons?.laneTickMins ?? DEFAULT_LANE_TICK_CRON_MINS;
    out.push(`${cronEvery(laneTickMins)} ${baseEnv} lane-tick ${logTail("lane-tick")}`);
  }

  // 8. ADR-088 §Decision-5 W7 — merge-cycle: bulk per-member-branch
  // fan-in. Gated on `team.merger.enabled === true`. Cadence:
  // (a) `opts.mergerIntervalOverride` (transient install-time override
  // from `cron-install --template merge-cycle --interval <N>`) wins
  // first, then (b) `team.merger.cycleIntervalMins`, then (c) the
  // module's `DEFAULT_MERGER_CYCLE_INTERVAL_MINS` (15).
  if (team.merger?.enabled === true) {
    const mergerMins =
      opts.mergerIntervalOverride ??
      team.merger.cycleIntervalMins ??
      DEFAULT_MERGER_CYCLE_INTERVAL_MINS;
    out.push(`${cronEvery(mergerMins)} ${baseEnv} merge-cycle --push ${logTail("merge-cycle")}`);
  }

  // 9. ADR-147 §D2 T3 — ombudsman tick: complaint adjudicator wake.
  // Gated on BOTH `team.ombudsman.enabled === true` AND member roster
  // containing a `role: "ombudsman"` entry (mirrors the unblocker
  // precedent — schema doc on `TeamOmbudsman` calls out the dual
  // gate explicitly). Absent either, the line is suppressed.
  //
  // Cadence resolution (same precedence shape as merge-cycle):
  // (a) `opts.ombudsmanIntervalOverride` (transient install-time
  //     override from `cron-install --template ombudsman-tick
  //     --interval <N>`) wins first, then (b)
  //     `team.ombudsman.tickIntervalMins`, then (c) the schema's
  //     `DEFAULT_OMBUDSMAN_TICK_INTERVAL_MINS` (15 per ADR-147 §D2).
  //
  // The verb itself (`atmux ombudsman tick`) is a fast no-op when
  // the sentinel is empty — cron at 15min is cheap; sentinel writes
  // are what trip work. The cron just guarantees worst-case wake
  // latency ≤ tickIntervalMins.
  const hasOmbudsman = team.members.some((m) => (m as { role?: string }).role === "ombudsman");
  if (team.ombudsman?.enabled === true && hasOmbudsman) {
    const ombudsmanMins =
      opts.ombudsmanIntervalOverride ??
      team.ombudsman.tickIntervalMins ??
      DEFAULT_OMBUDSMAN_TICK_INTERVAL_MINS;
    out.push(`${cronEvery(ombudsmanMins)} ${baseEnv} ombudsman tick ${logTail("ombudsman")}`);
  }

  // 10. ADR-148 §D4 / T3 — lane-stall-watch: fires `atmux lane-stall-tick`
  // every N minutes (default DEFAULT_LANE_STALL_CRON_INTERVAL_MINS = 5)
  // to scan stalled `lane=X todo age>30min members-all-idle` Tasks and
  // Enter-push `atmux claim <id>` to the lane's most-recently-active
  // member. Gated on `team.cadence.enabled === true` AND
  // `team.cadence.laneStallEnabled !== false` (opt-in master switch +
  // opt-out sub-switch — matches the merger/ombudsman gate patterns).
  //
  // Cadence resolution (same precedence shape as merge-cycle):
  // (a) `opts.laneStallIntervalOverride` (transient install-time
  //     override from `cron-install --template lane-stall-watch
  //     --interval <N>`) wins first, then (b) the schema default. The
  //     team config does NOT carry a `laneStallCronMins` field today —
  //     5min is operationally sufficient for the safety-net role; a
  //     per-team override can land via a future schema bump if a
  //     concrete demand emerges.
  if (team.cadence?.enabled === true && team.cadence.laneStallEnabled !== false) {
    const laneStallMins = opts.laneStallIntervalOverride ?? DEFAULT_LANE_STALL_CRON_INTERVAL_MINS;
    out.push(`${cronEvery(laneStallMins)} ${baseEnv} lane-stall-tick ${logTail("lane-stall")}`);
  }

  // 11. ADR-134 T7 (t-a87a39f1) — gitter-sweep: cron backstop for the
  // intra-team auto-merger. Walks every `<base>-<member>` branch and
  // re-evaluates the state machine (covers events the gitter member
  // missed while paused / rate-limited). Gated on BOTH
  // `team.autoMerge.enabled === true` AND member roster containing a
  // `role: "gitter"` entry — mirrors the ombudsman-tick dual-gate
  // (line 9 above) since the sweep verb writes into the gitter's own
  // merger-state SQLite repo and there's nothing to back-stop if the
  // role isn't seated.
  //
  // Cadence resolution (same precedence shape as merge-cycle):
  // (a) `opts.gitterSweepIntervalOverride` (transient install-time
  //     override from `cron-install --template gitter-sweep
  //     --interval <N>`) wins first, then (b)
  //     `team.autoMerge.cronBackstopMin`, then (c) the schema's
  //     `DEFAULT_AUTO_MERGE_CRON_BACKSTOP_MIN` (10 per ADR-134 §Config).
  // ADR-159 TR3: schema transforms "gitter" → "committer" at parse, but
  // in-memory Team objects from test fixtures (Zod-bypassed) may still
  // carry the legacy value. Accept both during the grace cycle.
  const hasGitter = team.members.some((m) => {
    const role = (m as { role?: string }).role;
    return role === "committer" || role === "gitter";
  });
  if (team.autoMerge?.enabled === true && hasGitter) {
    const gitterMins =
      opts.gitterSweepIntervalOverride ??
      team.autoMerge.cronBackstopMin ??
      DEFAULT_AUTO_MERGE_CRON_BACKSTOP_MIN;
    out.push(`${cronEvery(gitterMins)} ${baseEnv} gitter --sweep ${logTail("gitter-sweep")}`);
  }

  // 12. ADR-091 §State machine — epic-merge-tick: fires `atmux epic-
  // merge tick` every N minutes (default
  // DEFAULT_EPIC_MERGE_CRON_INTERVAL_MINS = 5) when the team is an
  // epic-team (`team.epicTeam !== undefined` per ADR-090 §Schema).
  // The verb itself runs the state-machine + gate + auto-merge +
  // dissolve-dispatch (`src/core/epic-merge.ts::performEpicMerge`);
  // this line is the sole cron-side wiring. Normal teams (no
  // epicTeam block) skip — the line is purely additive.
  //
  // Cadence resolution (same precedence shape as merger / ombudsman /
  // lane-stall): (a) `opts.epicMergeIntervalOverride` (transient
  // install-time override from `cron-install --template epic-merge
  // --interval <N>`) wins first, then (b) the schema default. The
  // team config does NOT carry a `epicMergeCronMins` field today —
  // 5min matches the operator-default cadence for stall-detection
  // primitives elsewhere in atmux; a per-team override can land via
  // a future schema bump if a concrete demand emerges.
  if (team.epicTeam !== undefined) {
    const epicMergeMins = opts.epicMergeIntervalOverride ?? DEFAULT_EPIC_MERGE_CRON_INTERVAL_MINS;
    out.push(`${cronEvery(epicMergeMins)} ${baseEnv} epic-merge tick ${logTail("epic-merge")}`);
  }

  return out;
}

/** ADR-091 §State machine default cron cadence — used by
 *  `renderCronLines` when `opts.epicMergeIntervalOverride` is unset.
 *  5 minutes matches the operator-default for fan-in stall detection
 *  (mirrors {@link DEFAULT_LANE_STALL_CRON_INTERVAL_MINS}); epic-team
 *  fan-in is not latency-critical (the `reviewer-trunk-signoff` Task
 *  gate already throttles velocity), so a 5min cadence keeps cron
 *  load light without blocking ready-to-merge transitions. */
export const DEFAULT_EPIC_MERGE_CRON_INTERVAL_MINS = 5;

// ---------- ADR-083: install transform ----------

const BLOCK_HEADER_PREFIX = "# >>> atmux:team=";
const BLOCK_HEADER_SUFFIX = " — managed by atmux start; do not edit by hand";
const BLOCK_FOOTER_PREFIX = "# <<< atmux:team=";
const ENV_PREAMBLE_MARKER = "TERM=xterm-256color";
const ENV_PREAMBLE = [
  "# ─── env for atmux cron (avoids tmux segfaults from bare cron env) ───",
  "SHELL=/bin/bash",
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "TERM=xterm-256color",
  "",
].join("\n");

/** Atmux verb names that appeared as bare cron lines in pre-marker
 *  installs. Used to scrub pre-marker orphans during install. ADR-160:
 *  both `whip` (legacy alias) and `poke` (canonical) match — legacy
 *  cron lines from pre-rename installs still get scrubbed even after
 *  the alias cycle ends. */
const ORPHAN_VERB_RE = /\batmux\s+(whip|poke|report|decisions|groom|discorder|unblocker)([\s]|$)/;

export interface InstallCronBlockOpts extends RenderCronBlockOpts {
  /** Current crontab contents (from `CrontabIO.read()`) — `null` /
   *  empty means "no crontab yet". */
  current: string | null;
}

/**
 * ADR-083 IN §1: pure transform that returns the new crontab contents.
 *
 * Pipeline (order matters — see bash `lib/cron.sh::atmux::cron_install`
 * lines 232-265):
 *   1. Strip the marker-bounded block matching this team's CURRENT name
 *      (idempotent re-install case).
 *   2. Strip ANY marker block whose body references the same
 *      `ATMUX_DIR=<atmuxDir>` — catches rename-orphans (block written
 *      under team's PRIOR name, pointing at the same dir, observed to
 *      fire concurrent `atmux whip` against one cage and crash tmux
 *      under load 2026-05-06).
 *   3. Strip bare atmux verb lines OUTSIDE any marker block —
 *      pre-marker eras left orphans that remain forever unless
 *      explicitly scrubbed.
 *   4. Append the freshly rendered block (re-uses `renderCronBlock`).
 *   5. Prepend env preamble (SHELL/PATH/TERM) when at least one
 *      `# >>> atmux:team=` is present AND the preamble is not already
 *      there — addresses cron-bare-env tmux segfaults (ADR-051).
 *
 * No I/O. Trivially testable; caller threads the result through
 * `CrontabIO.write()`.
 */
export function installCronBlock(opts: InstallCronBlockOpts): string {
  const { team, atmuxDir, current } = opts;
  const body = current ?? "";
  const stripped = stripOrphanLines(stripByAtmuxDir(stripBlockByTeam(body, team.name), atmuxDir));
  const block = renderCronBlock(opts);
  // Bash trims exactly ONE trailing newline (`${stripped%$'\n'}`) — match
  // that so a crontab with a deliberate trailing blank line stays
  // byte-identical when no atmux content needs to move.
  const trimmed = stripped.endsWith("\n") ? stripped.slice(0, -1) : stripped;
  const joined = trimmed === "" ? block : `${trimmed}\n${block}`;
  return ensureEnvPreamble(joined);
}

/** Bash `_atmux_cron_strip_block`: drop the marker-bounded block for
 *  `<team>` from `body`. Stream filter; no I/O. Used by install (to
 *  dedupe before append) and by the deferred `cron-remove` verb. */
export function stripBlockByTeam(body: string, team: string): string {
  if (body === "") return "";
  const header = `${BLOCK_HEADER_PREFIX}${team}${BLOCK_HEADER_SUFFIX}`;
  const footer = `${BLOCK_FOOTER_PREFIX}${team}`;
  const lines = body.split("\n");
  const out: string[] = [];
  let inBlock = false;
  for (const ln of lines) {
    if (ln === header) {
      inBlock = true;
      continue;
    }
    if (inBlock && ln === footer) {
      inBlock = false;
      continue;
    }
    if (!inBlock) out.push(ln);
  }
  return out.join("\n");
}

/** Bash `_atmux_cron_strip_by_atmux_dir`: drop ANY marker-bounded block
 *  whose body contains `ATMUX_DIR=<atmuxDir>` (followed by space or
 *  tab, so a longer path isn't a false prefix match). Catches
 *  rename-orphans the team-name strip can't see. */
export function stripByAtmuxDir(body: string, atmuxDir: string): string {
  if (body === "") return "";
  const lines = body.split("\n");
  const out: string[] = [];
  let buf: string[] = [];
  let inBlock = false;
  let matchDir = false;
  const needleSpace = `ATMUX_DIR=${atmuxDir} `;
  const needleTab = `ATMUX_DIR=${atmuxDir}\t`;
  for (const ln of lines) {
    if (ln.startsWith(BLOCK_HEADER_PREFIX)) {
      inBlock = true;
      buf = [ln];
      matchDir = false;
      continue;
    }
    if (inBlock && ln.startsWith(BLOCK_FOOTER_PREFIX)) {
      buf.push(ln);
      if (!matchDir) {
        for (const b of buf) out.push(b);
      }
      inBlock = false;
      buf = [];
      matchDir = false;
      continue;
    }
    if (inBlock) {
      buf.push(ln);
      if (ln.includes(needleSpace) || ln.includes(needleTab)) {
        matchDir = true;
      }
      continue;
    }
    out.push(ln);
  }
  // Unterminated block (corrupt crontab): flush buf as-is so we don't
  // lose lines. Bash awk silently drops them at EOF; we keep them so
  // operators can recover.
  if (inBlock) {
    for (const b of buf) out.push(b);
  }
  return out.join("\n");
}

/** Bash `_atmux_cron_strip_orphan_lines`: drop atmux verb lines that
 *  appear OUTSIDE any marker block. Pre-marker eras of atmux wrote
 *  bare cron lines that survive forever unless scrubbed. */
export function stripOrphanLines(body: string): string {
  if (body === "") return "";
  const lines = body.split("\n");
  const out: string[] = [];
  let inBlock = false;
  for (const ln of lines) {
    if (ln.startsWith(BLOCK_HEADER_PREFIX)) {
      inBlock = true;
      out.push(ln);
      continue;
    }
    if (ln.startsWith(BLOCK_FOOTER_PREFIX)) {
      inBlock = false;
      out.push(ln);
      continue;
    }
    if (inBlock) {
      out.push(ln);
      continue;
    }
    if (ORPHAN_VERB_RE.test(ln)) continue;
    out.push(ln);
  }
  return out.join("\n");
}

/** Bash `_atmux_cron_ensure_env_preamble`: prepend SHELL/PATH/TERM
 *  preamble iff the crontab contains at least one `# >>> atmux:team=`
 *  block AND the preamble isn't already present. Cron's bare env (no
 *  TERM, narrow PATH) caused tmux 3.5a segfaults when invoked from
 *  atmux verbs (ADR-051). Idempotent. */
export function ensureEnvPreamble(body: string): string {
  // ADR-086: cockpit-scoped block also needs the env preamble — cron's
  // bare env hits the same tmux/term issues regardless of which atmux
  // verb fires.
  if (!body.includes(BLOCK_HEADER_PREFIX) && !body.includes(COCKPIT_BLOCK_HEADER)) return body;
  if (body.includes(ENV_PREAMBLE_MARKER)) return body;
  return `${ENV_PREAMBLE}\n${body}`;
}

// ---------- ADR-086: cockpit-scoped cron block (pulse) ----------
//
// Distinct namespace from per-team blocks — uses `atmux:cockpit` markers
// so per-team strip-by-name + strip-by-atmux-dir passes never touch it.
// Idempotent on re-install (same strip → render → append pattern as
// `installCronBlock`).
//
// Phase 1 content: just `atmux pulse`. Phase 2 may add other cockpit-
// tier crons (LLM observer, multi-channel routing).

const COCKPIT_BLOCK_HEADER =
  "# >>> atmux:cockpit — managed by atmux cockpit rebuild; do not edit by hand";
const COCKPIT_BLOCK_FOOTER = "# <<< atmux:cockpit";

export interface RenderCockpitCronBlockOpts {
  /** Absolute path to the atmux binary. Cron's bare env can't resolve
   *  PATH-relative names. */
  atmuxBin: string;
  /** Absolute path to the cockpit config (defaults to `~/.atmux/cockpit.json`
   *  when the verb is invoked; we don't bake the default into the cron line
   *  so the operator can pass `--config <path>` overrides via env later). */
  cockpitConfigPath?: string;
  /** Absolute path for the log tail. Defaults to `~/.atmux/logs/pulse.log`. */
  logPath?: string;
  /** Optional cockpit.pulse.intervalMins (default 5). Must be a 60-divisor. */
  pulseIntervalMins?: number;
  /** Optional PATH prefix for the cron env (defaults to a sensible set
   *  covering mise + system bins). */
  cronPath?: string;
}

/** Pure: render the cockpit-scoped cron block (header + body + footer). */
export function renderCockpitCronBlock(opts: RenderCockpitCronBlockOpts): string {
  const interval = opts.pulseIntervalMins ?? 5;
  const cronPath = opts.cronPath ?? "/root/.bun/bin:/usr/local/bin:/usr/bin:/bin";
  const logPath = opts.logPath ?? "/root/.atmux/logs/pulse.log";
  const configFlag =
    opts.cockpitConfigPath !== undefined && opts.cockpitConfigPath !== ""
      ? ` --config ${opts.cockpitConfigPath}`
      : "";
  const line = `${cronEvery(interval)} PATH=${cronPath} ${opts.atmuxBin} pulse${configFlag} >> ${logPath} 2>&1`;
  return `${COCKPIT_BLOCK_HEADER}\n${line}\n${COCKPIT_BLOCK_FOOTER}\n`;
}

export interface InstallCockpitCronBlockOpts extends RenderCockpitCronBlockOpts {
  /** Current crontab contents (`null`/empty == no crontab yet). */
  current: string | null;
}

/** Pure transform: strip any existing cockpit block + append a fresh one.
 *  Idempotent — re-running with the same opts yields byte-identical output. */
export function installCockpitCronBlock(opts: InstallCockpitCronBlockOpts): string {
  const stripped = stripCockpitBlock(opts.current ?? "");
  const block = renderCockpitCronBlock(opts);
  const trimmed = stripped.endsWith("\n") ? stripped.slice(0, -1) : stripped;
  const joined = trimmed === "" ? block : `${trimmed}\n${block}`;
  return ensureEnvPreamble(joined);
}

/** Strip the `# >>> atmux:cockpit` ... `# <<< atmux:cockpit` block, if
 *  present. Bash-equivalent helper (no bash counterpart yet — cockpit
 *  cron is new ground per ADR-086). */
export function stripCockpitBlock(body: string): string {
  if (body === "") return "";
  const lines = body.split("\n");
  const out: string[] = [];
  let inBlock = false;
  for (const ln of lines) {
    if (ln === COCKPIT_BLOCK_HEADER) {
      inBlock = true;
      continue;
    }
    if (inBlock && ln === COCKPIT_BLOCK_FOOTER) {
      inBlock = false;
      continue;
    }
    if (!inBlock) out.push(ln);
  }
  return out.join("\n");
}

// ---------- ADR-133 TR6: superdoctor → medic cron-line migration ----------
//
// Defensive idempotent rewrite: any `atmux superdoctor [args]` invocation
// inside an atmux-managed block (`# >>> atmux:team=...` or
// `# >>> atmux:cockpit`) is rewritten to `atmux medic [args]`. Lines
// OUTSIDE managed blocks are preserved verbatim — operators may have
// hand-installed superdoctor invocations and we never touch those.
//
// Note on premise: atmux today does NOT write `atmux superdoctor` cron
// lines (cockpit's superdoctor runs via tmux pane keystroke `/loop /
// superdoctor`, not crontab). This migration is a forward-compat hygiene
// pass that:
//   - no-ops on every current install (no legacy lines to rewrite)
//   - rewrites cleanly if ADR-133 TR3 (verb routing) ships an
//     `atmux superdoctor` legacy alias for some path
//   - rewrites any operator-hand-installed legacy invocation inside an
//     atmux-managed block (rare; defensive)
//
// Idempotent: re-running on already-migrated body yields byte-identical
// output. Safe to run on every cron-install invocation.

const SUPERDOCTOR_VERB_RE = /\batmux superdoctor\b/g;

/** Pure: rewrite `atmux superdoctor` → `atmux medic` on every line
 *  inside an atmux-managed block. Returns the new body + the number of
 *  rewrites applied (caller can decide whether to log the migration).
 *
 *  Idempotent: running on a body with zero matches returns the input
 *  unchanged with `{ migrated: 0 }`. Running again on a body that
 *  ALREADY contains `atmux medic` (no `atmux superdoctor` left) is a
 *  no-op. */
export function migrateSuperdoctorToMedicCronLines(body: string): {
  body: string;
  migrated: number;
} {
  if (body === "") return { body, migrated: 0 };
  if (!body.includes("atmux superdoctor")) return { body, migrated: 0 };
  const lines = body.split("\n");
  const out: string[] = [];
  let inManagedBlock = false;
  let migrated = 0;
  for (const ln of lines) {
    if (ln.startsWith(BLOCK_HEADER_PREFIX) || ln === COCKPIT_BLOCK_HEADER) {
      inManagedBlock = true;
      out.push(ln);
      continue;
    }
    if (inManagedBlock && (ln.startsWith(BLOCK_FOOTER_PREFIX) || ln === COCKPIT_BLOCK_FOOTER)) {
      inManagedBlock = false;
      out.push(ln);
      continue;
    }
    if (inManagedBlock && SUPERDOCTOR_VERB_RE.test(ln)) {
      SUPERDOCTOR_VERB_RE.lastIndex = 0;
      const rewritten = ln.replace(SUPERDOCTOR_VERB_RE, "atmux medic");
      const count = (ln.match(SUPERDOCTOR_VERB_RE) ?? []).length;
      SUPERDOCTOR_VERB_RE.lastIndex = 0;
      migrated += count;
      out.push(rewritten);
      continue;
    }
    SUPERDOCTOR_VERB_RE.lastIndex = 0;
    out.push(ln);
  }
  return { body: out.join("\n"), migrated };
}

// ---------- ADR-083 follow-up §DEFERRED row 2: cron-orphans ----------

/** A marker-fenced block's identity: team name from the header + the
 *  first `ATMUX_DIR=<value>` baked into a body line. JSON serialization
 *  at the verb boundary maps this to snake_case `atmux_dir` for bash
 *  output compat. */
export interface CronBlockTarget {
  team: string;
  atmuxDir: string;
}

/**
 * Pure parser — mirrors bash `lib/cron.sh::atmux::cron_orphans` awk
 * pass (lines 337-364). Walks every marker-fenced block and emits one
 * `{team, atmuxDir}` per block whose body carries an `ATMUX_DIR=`
 * assignment. Blocks lacking that assignment are skipped (matches bash
 * `team != "" && atmux_dir != ""` guard at the footer).
 *
 * Header parse is lenient on the trailing `— managed by atmux start;
 * do not edit by hand` suffix — strip if present, else keep the rest
 * verbatim (bash awk's `sub(/<suffix>$/, "")` behavior). Footer match
 * is prefix-only (`# <<< atmux:team=`) so a corrupt suffix doesn't
 * leave the block hanging.
 *
 * No I/O. Composed with an injected `dirExists` predicate by
 * `findCronOrphans` so unit tests can pin both sides.
 */
export function parseCronBlockTargets(body: string): CronBlockTarget[] {
  if (body === "") return [];
  const out: CronBlockTarget[] = [];
  let team = "";
  let atmuxDir = "";
  let inBlock = false;
  for (const ln of body.split("\n")) {
    if (ln.startsWith(BLOCK_HEADER_PREFIX)) {
      let rest = ln.slice(BLOCK_HEADER_PREFIX.length);
      if (rest.endsWith(BLOCK_HEADER_SUFFIX)) {
        rest = rest.slice(0, rest.length - BLOCK_HEADER_SUFFIX.length);
      }
      team = rest;
      atmuxDir = "";
      inBlock = true;
      continue;
    }
    if (inBlock && ln.startsWith(BLOCK_FOOTER_PREFIX)) {
      if (team !== "" && atmuxDir !== "") {
        out.push({ team, atmuxDir });
      }
      team = "";
      atmuxDir = "";
      inBlock = false;
      continue;
    }
    if (inBlock && atmuxDir === "") {
      // Bash awk: sub(/^.*ATMUX_DIR=/, "") + sub(/[[:space:]].*$/, "")
      // → first occurrence per line, value up to first whitespace.
      const idx = ln.indexOf("ATMUX_DIR=");
      if (idx >= 0) {
        const tail = ln.slice(idx + "ATMUX_DIR=".length);
        const m = tail.match(/^(\S+)/);
        if (m !== null && m[1] !== undefined) atmuxDir = m[1];
      }
    }
  }
  return out;
}

export interface FindCronOrphansOpts {
  /** Crontab IO seam — `read()` returns `null` for no crontab. */
  io: CrontabIO;
  /** Returns true iff `path` resolves to a directory on disk. Injected
   *  so unit tests can simulate moved / deleted paths without touching
   *  the filesystem. */
  dirExists: (path: string) => Promise<boolean>;
}

/**
 * ADR-083 follow-up §DEFERRED row 2: compose `parseCronBlockTargets`
 * with the injected `dirExists` predicate. Returns the rows whose
 * `atmuxDir` is no longer a directory on disk — the "orphan cron block"
 * signal for doctor + cockpit aggregators.
 *
 * Returns empty when the crontab is null / empty (no crontab installed
 * → no orphans possible).
 */
export async function findCronOrphans(opts: FindCronOrphansOpts): Promise<CronBlockTarget[]> {
  const body = await opts.io.read();
  if (body === null || body === "") return [];
  const blocks = parseCronBlockTargets(body);
  const out: CronBlockTarget[] = [];
  for (const b of blocks) {
    if (!(await opts.dirExists(b.atmuxDir))) {
      out.push(b);
    }
  }
  return out;
}

/**
 * t-e1247699: one-shot recovery for bun-test cron leaks. Reads the
 * crontab once, identifies every block whose ATMUX_DIR is missing on
 * disk, strips each via `stripBlockByTeam`, and rewrites atomically via
 * `io.write`. Returns the list of pruned blocks for the verb to surface
 * to the caller.
 *
 * Single-read TOCTOU window: detection + strip share the same `body`
 * snapshot, so an orphan that materialized mid-pass isn't missed and a
 * concurrent `atmux start` install isn't clobbered (the new block lands
 * AFTER our `io.write`'s post-read; bash-level cron mutations don't
 * overlap because `crontab <file>` is itself atomic).
 *
 * No write when there are no orphans — saves a needless `crontab <file>`
 * cycle (and avoids touching mtime on healthy hosts).
 */
export async function pruneCronOrphans(opts: FindCronOrphansOpts): Promise<CronBlockTarget[]> {
  const body = await opts.io.read();
  if (body === null || body === "") return [];
  const blocks = parseCronBlockTargets(body);
  const orphans: CronBlockTarget[] = [];
  let newBody = body;
  for (const b of blocks) {
    if (!(await opts.dirExists(b.atmuxDir))) {
      orphans.push(b);
      newBody = stripBlockByTeam(newBody, b.team);
    }
  }
  if (orphans.length > 0 && newBody !== body) {
    await opts.io.write(newBody);
  }
  return orphans;
}
