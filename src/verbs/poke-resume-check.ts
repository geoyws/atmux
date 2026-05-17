// ADR-053 §D4 (4.3 Option B): lightweight 1-min cron verb that watches
// for budget-pause exit conditions. Tighter cadence than full whip (*/5)
// so post-pause auto-resume latency drops from up-to-5min to up-to-1min.
//
// Flow:
//   1. Acquire `<atmuxDir>/state/whip-resume-check.lock` (non-blocking
//      flock; contention skips the tick — full whip + this verb both
//      tap the same probe-cache so a single missed run is harmless).
//   2. Probe `team.whip.claudeAccount` (and any `accountFallback` chain)
//      with `force: false` — most ticks are pure cache reads at the
//      240s TTL; live probes happen ~once per 4 ticks per account.
//   3. If `.atmux/state/budget-pause.json` shows an active pause AND
//      `shouldResume(...)` returns true (ALL probes ≤ resumeThreshold
//      on BOTH 5h+wk windows): execute the resume path —
//        - `resumeMember(...)` for every member in the captured atRisk
//          roster (clears the per-member paused flag)
//        - `clearBudgetPauseState(...)`
//        - append driver-inbox entry
//        - fire Discord [whip-budget-resume]
//   4. Append a per-account history entry (best-effort) so operators
//      can grep `budget-history.jsonl` for resume-tick observations.
//
// What this verb DOES NOT do (intentional):
//   - Per-member status checks (full whip's job; expensive).
//   - Budget-pause ENTRY (R1-T5 / `whip.ts`'s job — pause is a
//     decision tied to the full per-member pass).
//   - Warning-band / refresh-soon Discord pings (full whip too).
//
// Coordination with R1-T5: `src/verbs/whip.ts` will call the same
// `shouldResume + executeResume` helpers via this module's exports
// once the full-whip integration lands.

import { join } from "node:path";
import { type BudgetProbeResult, probeBudget } from "../abstractions/budget-probe.ts";
import { type DiscordSendOpts, send as discordSend } from "../abstractions/discord.ts";
import { appendText, ensureDir, exists, writeText } from "../abstractions/fs.ts";
import { acquire as acquireLock, type LockHandle } from "../abstractions/lock.ts";
import { formatMyt, now as nowMs } from "../abstractions/time.ts";
import { appendHistoryEntry, type BudgetHistoryEntry } from "../core/budget-history.ts";
import {
  type AtRiskMember,
  type BudgetPauseState,
  clearBudgetPauseState,
  loadBudgetPauseState,
} from "../core/budget-pause.ts";
import {
  driverInboxPath,
  getAtmuxDir,
  type ResolveDirOpts,
  requireTeam,
  stateDir,
} from "../core/common.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import { resumeMember as defaultResumeMember } from "../core/pause.ts";
import { ConfigError, LockTimeoutError, UsageError } from "../errors.ts";
import type { Team, TeamWhip } from "../schema/team.ts";

const USAGE = "atmux poke-resume-check [--no-discord] [--team-dir <dir>]";

// Default timing knobs — picked to match `whip.ts`. Long enough for any
// transient FS hiccup; short enough that a wedged peer doesn't drag the
// 1-min cron tick into the next interval.
const LOCK_TIMEOUT_MS = 50;
const LOCK_RETRY_DELAY_MS = 25;

// ---------- Args ----------

export interface PokeResumeCheckArgs {
  pushDiscord: boolean;
  teamDir?: string;
}

export function parsePokeResumeCheckArgs(argv: ReadonlyArray<string>): PokeResumeCheckArgs {
  let pushDiscord = true;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--no-discord") {
      pushDiscord = false;
      i += 1;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "whip-resume-check: --team-dir requires a value",
          hint: USAGE,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({
      what: `whip-resume-check: unknown arg: ${a ?? ""}`,
      hint: USAGE,
    });
  }
  const out: PokeResumeCheckArgs = { pushDiscord };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Pure helpers (exported for tests + R1-T5 reuse) ----------

export interface ShouldResumeArgs {
  /** Current pause state — `null` short-circuits to false. */
  pauseState: BudgetPauseState | null;
  /** Probe results for every account the team uses. Empty array also
   *  short-circuits to false (we can't gate on no data). */
  probes: ReadonlyArray<BudgetProbeResult>;
  /** `team.whip.budgetResumeThreshold`. Default 80 — i.e., ≥20%
   *  remaining on BOTH 5h+wk for ALL probed accounts. */
  resumeThresholdPctUsed: number;
}

/**
 * Pure resume-gate check per ADR-053 §D2 ("ALL members `h5_pct_used`
 * AND `wk_pct_used` ≤ threshold"). Operates on probe results because
 * the team's account is the per-member budget shared by all members on
 * that account — gating on probe data is identical to gating on every
 * member's headroom.
 *
 * Probes whose status isn't `allowed`/`rejected` (e.g. probe-error,
 * probe-401, no-credentials) carry no valid headroom data — we treat
 * them as fail-the-gate rather than silently resuming on stale info.
 */
export function shouldResume(args: ShouldResumeArgs): boolean {
  if (args.pauseState === null) return false;
  if (args.probes.length === 0) return false;
  const ceil = args.resumeThresholdPctUsed;
  for (const p of args.probes) {
    if (p.status !== "allowed" && p.status !== "rejected") return false;
    if (p.h5_pct_used > ceil) return false;
    if (p.wk_pct_used > ceil) return false;
  }
  return true;
}

/**
 * Resolve the ordered list of accounts to probe. Primary first, then
 * any `accountFallback` entries. De-duplicated, empty-strings dropped.
 */
export function resolveProbeAccounts(whip: TeamWhip | undefined): string[] {
  if (whip === undefined) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (a: string | undefined) => {
    if (a === undefined || a === "") return;
    if (seen.has(a)) return;
    seen.add(a);
    out.push(a);
  };
  push(whip.claudeAccount);
  for (const a of whip.accountFallback ?? []) push(a);
  return out;
}

// ---------- Public entrypoint ----------

export interface PokeResumeCheckOpts {
  stdout?: Writer;
  stderr?: Writer;
  /** Clock — defaults to `time.now()` (epoch ms). */
  now?: () => number;
  /** Override `probeBudget` (test injection). */
  probe?: typeof probeBudget;
  /** Override `resumeMember` (test injection). */
  resumeMember?: typeof defaultResumeMember;
  /** Override Discord send (test injection). */
  discordSend?: (opts: DiscordSendOpts) => Promise<void>;
  /** Override resolved webhook URL (forwarded to discord.send). */
  webhookOverride?: string;
  /** Lock acquirer override — same posture as `whip.ts`. */
  lockAcquire?: (path: string) => Promise<LockHandle>;
}

/** `atmux poke-resume-check [--no-discord] [--team-dir <dir>]`.
 *
 * ADR-160 rename: this verb was previously named `whipResumeCheck`. The
 * `atmux whip-resume-check` cli surface still routes here via a
 * deprecation alias for one release cycle. */
export async function pokeResumeCheck(
  argv: ReadonlyArray<string>,
  opts: PokeResumeCheckOpts = {},
): Promise<number> {
  const parsed = parsePokeResumeCheckArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);

  const stdout = opts.stdout ?? defaultStdoutWrite;
  const stderr = opts.stderr ?? defaultStderrWrite;
  const clock = opts.now ?? nowMs;
  const probe = opts.probe ?? probeBudget;
  const resume = opts.resumeMember ?? defaultResumeMember;
  const send = opts.discordSend ?? discordSend;

  const team = await requireTeam(dirOpts);

  // Single-instance flock — contention skips this tick. cron's next
  // 1-min interval retries cleanly; missing one tick is a sub-second
  // delay on resume detection, far below the */5 floor we replaced.
  await ensureDir(stateDir(atmuxDir));
  const lockBase = join(stateDir(atmuxDir), "whip-resume-check");
  const lockFn =
    opts.lockAcquire ??
    ((p: string) =>
      acquireLock(p, { timeoutMs: LOCK_TIMEOUT_MS, retryDelayMs: LOCK_RETRY_DELAY_MS }));

  let handle: LockHandle;
  try {
    handle = await lockFn(lockBase);
  } catch (e) {
    if (e instanceof LockTimeoutError) {
      stderr("whip-resume-check: another instance is running — skipping this tick\n");
      return 0;
    }
    throw e;
  }

  try {
    return await runCheck(parsed, {
      team,
      atmuxDir,
      stdout,
      stderr,
      nowMsec: clock(),
      probe,
      resume,
      send,
      ...(opts.webhookOverride !== undefined ? { webhookOverride: opts.webhookOverride } : {}),
    });
  } finally {
    await handle.release();
  }
}

// ---------- Tick body ----------

interface TickCtx {
  team: Team;
  atmuxDir: string;
  stdout: Writer;
  stderr: Writer;
  nowMsec: number;
  probe: typeof probeBudget;
  resume: typeof defaultResumeMember;
  send: (opts: DiscordSendOpts) => Promise<void>;
  webhookOverride?: string;
}

async function runCheck(parsed: PokeResumeCheckArgs, ctx: TickCtx): Promise<number> {
  const { team, atmuxDir, stdout } = ctx;
  const whip = team.whip;
  const accounts = resolveProbeAccounts(whip);

  // No accounts configured — nothing to do. Verb is a no-op on teams
  // without budget observability opted in. Cheap exit; cron line is
  // gated on `claudeAccount` in lib/cron.sh anyway, so this branch
  // mostly catches the manual-invocation case.
  if (accounts.length === 0) {
    stdout(
      `whip-resume-check: no team.whip.claudeAccount configured — skipping (team=${team.name})\n`,
    );
    return 0;
  }

  // 1. Probe each configured account (force=false — cache wins when fresh).
  //    ADR-078 — daemon caller owns the credentials lifecycle, opts in to
  //    the Fix-C OAuth refresh path.
  const probes: BudgetProbeResult[] = [];
  for (const account of accounts) {
    const r = await ctx.probe(account, {
      force: false,
      atmuxDir,
      refreshOnNearExpiry: true,
    });
    probes.push(r);
  }

  // 2. Read pause state. Absent → not paused → return 0.
  const pauseState = await loadBudgetPauseState(atmuxDir);

  if (pauseState === null) {
    stdout(
      `whip-resume-check: no active pause (team=${team.name}, accounts=${accounts.join(",")})\n`,
    );
    return 0;
  }

  // 3. Resume-gate.
  const resumeThreshold = whip?.budgetResumeThreshold ?? 80;
  const should = shouldResume({
    pauseState,
    probes,
    resumeThresholdPctUsed: resumeThreshold,
  });

  if (!should) {
    const summary = probes
      .map((p) => `${p.account}=${p.status}/h5:${p.h5_pct_used}%/wk:${p.wk_pct_used}%`)
      .join(", ");
    stdout(
      `whip-resume-check: pause active; gate not met (threshold=${resumeThreshold}%, ${summary})\n`,
    );
    return 0;
  }

  // 4. Execute resume.
  await executeResume(ctx, parsed, pauseState, probes);
  return 0;
}

// ---------- Resume execution ----------

async function executeResume(
  ctx: TickCtx,
  parsed: PokeResumeCheckArgs,
  pauseState: BudgetPauseState,
  probes: ReadonlyArray<BudgetProbeResult>,
): Promise<void> {
  const { atmuxDir, team, stdout, stderr, nowMsec, resume, send, webhookOverride } = ctx;
  const ts = formatMyt(nowMsec);

  // Resume each member in the captured at-risk roster. We use the
  // pause state's roster (not the live team roster) so a member added
  // mid-pause doesn't get a spurious resume call (they were never
  // paused in the first place).
  for (const m of pauseState.atRisk) {
    try {
      await resume(atmuxDir, m.member);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      stderr(`whip-resume-check: resume member=${m.member} failed: ${reason}\n`);
    }
  }

  // Clear pause state — idempotent, safe even if a peer cleared it
  // first.
  await clearBudgetPauseState(atmuxDir);

  // Driver-inbox entry — operator-visible audit trail.
  await appendDriverInboxResume(atmuxDir, ts, pauseState.atRisk, probes);

  // Discord ping — best-effort. Build inline; the canonical renderer
  // (R1-T5 part 2) will consolidate into discord.ts later.
  if (parsed.pushDiscord) {
    await tryDiscord(send, stderr, {
      template: "whip-budget-resume",
      team: team.name,
      category: "📊",
      bullets: composeResumeBullets(pauseState, probes),
      whenMs: nowMsec,
      ...(webhookOverride !== undefined ? { webhookOverride } : {}),
    });
  }

  // Write a synthesized history entry per resumed account so
  // operators grepping `budget-history.jsonl` for "what triggered
  // resume" find the exact-tick row. Best-effort — log failures don't
  // mask resume.
  const tsSec = Math.floor(nowMsec / 1000);
  for (const p of probes) {
    const entry: BudgetHistoryEntry = {
      ts: tsSec,
      account: p.account,
      h5_util: p.h5_pct_used / 100,
      wk_util: p.wk_pct_used / 100,
      h5_reset: p.h5_reset_epoch,
      wk_reset: p.wk_reset_epoch,
      status: p.status,
      source: p.source,
      tokenRefreshed: false,
    };
    await appendHistoryEntry(atmuxDir, entry);
  }

  stdout(
    `whip-resume-check: resumed ${pauseState.atRisk.length} member(s) (team=${team.name}, ts=${tsSec})\n`,
  );
}

function composeResumeBullets(
  pauseState: BudgetPauseState,
  probes: ReadonlyArray<BudgetProbeResult>,
): string[] {
  const bullets: string[] = [];
  bullets.push(`▶️ resumed ${pauseState.atRisk.length} member(s)`);
  for (const p of probes) {
    bullets.push(
      `📊 \`${p.account}\` headroom: 5h ${100 - p.h5_pct_used}% · wk ${100 - p.wk_pct_used}%`,
    );
  }
  bullets.push(`🔁 paused at ${pauseState.pausedAtTs} → cleared`);
  return bullets;
}

async function appendDriverInboxResume(
  atmuxDir: string,
  ts: string,
  atRisk: ReadonlyArray<AtRiskMember>,
  probes: ReadonlyArray<BudgetProbeResult>,
): Promise<void> {
  const path = driverInboxPath(atmuxDir);
  const headroom = probes
    .map((p) => `${p.account}=5h:${100 - p.h5_pct_used}%/wk:${100 - p.wk_pct_used}%`)
    .join(", ");
  const members = atRisk.map((m) => m.member).join(", ");
  const line = `- [${ts}] 📊 budget-resume: ${atRisk.length} member(s) resumed (${members}); headroom ${headroom}\n`;

  if (!(await exists(path))) {
    await writeText(path, line);
    return;
  }
  await appendText(path, line);
}

async function tryDiscord(
  send: (opts: DiscordSendOpts) => Promise<void>,
  stderr: Writer,
  opts: DiscordSendOpts,
): Promise<void> {
  try {
    await send(opts);
  } catch (e) {
    if (e instanceof ConfigError) {
      // No webhook — soft-skip. Mirrors whip.ts's posture.
      return;
    }
    const reason = e instanceof Error ? e.message : String(e);
    stderr(`atmux: warn: whip-resume-check: discord ping failed: ${reason}\n`);
  }
}
