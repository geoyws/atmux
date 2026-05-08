// Bun-port cron-block render module. Source of truth for what lines an
// atmux team's managed crontab block contains. Mirrors bash
// `lib/cron.sh::_atmux_cron_render_lines` (the bash module is what
// actually installs the block today; this TS module is the spec a future
// bun-port `src/verbs/cron.ts` install verb will render against — see
// the Phase-2 deferral note at `src/verbs/start.ts:63-64`).
//
// Block shape (marker-fenced, idempotent re-install via fence-replace):
//
//     # >>> atmux:team=<n> — managed by atmux start; do not edit by hand
//     */5 * * * * <atmuxDir prefix> atmux whip                  >> .../whip.log 2>&1
//     */30 * * * * <prefix> atmux report                         >> .../report.log 2>&1
//     0 */4 * * * <prefix> atmux decisions digest                >> .../decisions-digest.log 2>&1
//     0 4 * * * <prefix> atmux groom --quiet                     >> .../groom.log 2>&1
//     */1 * * * * <prefix> atmux whip-resume-check               >> .../whip-resume-check.log 2>&1   ← ADR-053 §D4
//     # <<< atmux:team=<n>
//
// Conditional lines (omitted when the gating condition is false):
//   - `whip-resume-check` (1-min): only when `team.whip.claudeAccount`
//     is set. Teams without budget observability skip the noise.
//   - `discorder progress` + `discorder heartbeat`: when team has a
//     `role: "discorder"` member; replaces the regular `report` line.
//   - `unblocker tick` (2-min): when team has a `role: "unblocker"`
//     member.
//
// Rendering is pure — no I/O, no flock — so the install verb (when it
// lands) can sandwich the rendering in atomic-rename + flock per its
// own preference.

import type { Team } from "../schema/team.ts";

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
  const tmuxPrefix = opts.tmuxTmpdir !== undefined && opts.tmuxTmpdir !== ""
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

  // 1. whip — every 5 minutes (full sweep).
  out.push(`*/5 * * * * ${baseEnv} whip ${logTail("whip")}`);

  // 2. report or discorder pair (mutually exclusive per ADR-022 OQ-D4).
  const hasDiscorder = team.members.some(
    (m) => (m as { role?: string }).role === "discorder",
  );
  if (hasDiscorder) {
    out.push(
      `*/30 * * * * ${baseEnv} discorder progress ${logTail("discorder-progress")}`,
    );
    out.push(`0 * * * * ${baseEnv} discorder heartbeat ${logTail("discorder-heartbeat")}`);
  } else {
    out.push(`*/30 * * * * ${baseEnv} report ${logTail("report")}`);
  }

  // 3. decisions digest — every 4 hours.
  out.push(`0 */4 * * * ${baseEnv} decisions digest ${logTail("decisions-digest")}`);

  // 4. groom — daily at 04:00 (quietest window).
  out.push(`0 4 * * * ${baseEnv} groom --quiet ${logTail("groom")}`);

  // 5. whip-resume-check — every 1 minute, gated on claudeAccount.
  // ADR-053 §D4 (Option B): isolated cheap path so post-pause auto-
  // resume latency drops from up-to-5min to up-to-1min without bumping
  // full whip's */5 cadence (which would amplify any whip-side bug 5×).
  if (team.whip?.claudeAccount !== undefined && team.whip.claudeAccount !== "") {
    out.push(
      `*/1 * * * * ${baseEnv} whip-resume-check ${logTail("whip-resume-check")}`,
    );
  }

  // 6. unblocker tick — every 2 minutes, gated on unblocker role.
  const hasUnblocker = team.members.some(
    (m) => (m as { role?: string }).role === "unblocker",
  );
  if (hasUnblocker) {
    out.push(`*/2 * * * * ${baseEnv} unblocker tick ${logTail("unblocker")}`);
  }

  return out;
}
