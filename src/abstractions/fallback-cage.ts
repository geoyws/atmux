// ADR-058 §D3+§D4 + ADR-050 v1 + Task t-706655ee: fallback-cage builder
// + brief generator.
//
// **Scope reduction 2026-05-14** (Task t-706655ee revised body): the
// `createFallbackCage` create-path is **Tier 2 (Cursor) only**. Tier 3
// (Kimi) and Tier 4 (MiniMax) are PERMANENTLY OUT of scope per
// operator evaluation: *"MiniMax + Kimi are unreliable and not smart
// enough"* — spawning a low-quality executor at budget-pause produces
// more cleanup than the saved budget gains. Cursor composer-2-fast is
// the only accepted fallback. The hard gate fires synchronously at
// `createFallbackCage` entry; see {@link FallbackTierDroppedError}.
//
// Tier 2 (Cursor) → operator UID, full git, dedicated cage tmux server
// at TMUX_TMPDIR=/tmp/atmux_fallback_<team>_<lane>/.
// Tier 3 (Kimi)   → **DROPPED** per ADR-050 v1 (formerly: dedicated
//                   `kimi-agent` user, no .git in workspace).
// Tier 4 (MiniMax) → **DROPPED** per ADR-050 v1 (formerly: stubbed
//                    behind MINIMAX_CLI_AVAILABLE env flag).
//
// The Tier 3+ helpers (workspace builder, sudo-tmux spawn path, brief
// composers, archive paths, rsync excludes) remain in this module so
// `destroyFallbackCage` can tear down legacy `CageHandle` rows
// persisted before the 2026-05-14 reduction. New cages of tier !== 2
// are refused at the create path — the destroy path is best-effort
// cleanup, not a re-entry point.
//
// Brief composers are folded into this module per ADR-058 §D4 — the
// brief embeds tier-identity (agent name, workDir, git policy), so
// splitting them across modules introduces an artificial seam.
//
// Hard rule: NO direct git invocation from Tier 3+ cage path. (Now
// moot for new cages — Tier 3+ creation is blocked — but retained as
// a doc-rule for the dead-code teardown path.)

import { resolveTmuxBin } from "../core/resolve-tmux-bin.ts";
import { getAtmuxTmuxConfPath } from "../core/tmux-paths.ts";
import { spawn as defaultSpawn, type SpawnOpts, type SpawnResult } from "./spawn.ts";
import type { TmuxConfig, TmuxNamespace } from "./tmux.ts";
import {
  createTmux as defaultCreateTmux,
  TMUX_CHILD_ENV_ARGV,
  TMUX_CHILD_UNSET_ENV,
} from "./tmux.ts";

// ---------- Public types ----------

/** Tier identifier per ADR-058 §D1. Tier 1 (Claude) is the operator's
 *  primary executor and never enters this module — fallback-cage is
 *  invoked only when budget-pause has fired. */
export type FallbackTier = 2 | 3 | 4;

/** Per-tier agent identity. Tier 2 runs as the operator (no dedicated
 *  user); Tier 3+ run as kernel-isolated dedicated users. */
export type FallbackAgent = "operator" | "kimi-agent" | "minimax-agent";

/** Handle returned by createFallbackCage; consumed by destroyFallbackCage
 *  and by parity-state-impl's reconciliation path (per ADR-058 §D5). */
export interface CageHandle {
  /** Which tier this cage belongs to. */
  readonly tier: FallbackTier;
  /** Owning team name (matches team.json::name). */
  readonly team: string;
  /** Logical lane name (matches a `team.json::members[].name` or a
   *  budget-pause-snapshot lane id). */
  readonly lane: string;
  /** The Task whose work is being delegated to this cage. */
  readonly taskId: string;
  /** Agent identity running inside the cage. */
  readonly agent: FallbackAgent;
  /** Per-cage TMUX_TMPDIR (ADR-018 isolation pattern). */
  readonly tmuxTmpdir: string;
  /** Per-cage tmux socket short-name (`-L <socket>`). */
  readonly tmuxSocket: string;
  /** Workspace directory the agent operates in:
   *  - Tier 2: project cwd (operator's worktree)
   *  - Tier 3+: /home/<agent>/cages/<team>-<lane>/work/ (rsync'd, no .git) */
  readonly workDir: string;
  /** Tmux session name spawned inside the cage. */
  readonly sessionName: string;
  /** Tmux window name where the agent process runs. */
  readonly windowName: string;
  /** Epoch-seconds at create time. Used by destroy's archive path. */
  readonly createdAt: number;
}

/** Options for createFallbackCage. */
export interface CreateFallbackCageOpts {
  readonly team: string;
  readonly lane: string;
  readonly tier: FallbackTier;
  readonly taskId: string;
  /** Required for Tier 3+ to compute archive paths under .atmux/. Tier 2
   *  uses it for symmetry but Tier 2's workspace is the project cwd. */
  readonly atmuxDir: string;
  /** The project worktree path. Source-of-truth for Tier 2 cwd; Tier 3+
   *  rsyncs FROM this into the agent's home. */
  readonly projectCwd: string;
  /** Override spawn() for tests. */
  readonly spawnFn?: (opts: SpawnOpts) => Promise<SpawnResult>;
  /** Override createTmux factory for tests. */
  readonly tmuxFactory?: (config: TmuxConfig) => TmuxNamespace;
  /** Clock injection for tests; defaults to `Math.floor(Date.now()/1000)`. */
  readonly nowSec?: () => number;
}

/** Options for the brief composers — shared shape across tiers; the
 *  composers diverge on git policy + reconciliation framing. */
export interface ComposeBriefOpts {
  readonly team: string;
  readonly lane: string;
  readonly taskId: string;
  /** The full Task body the agent should execute. Composers wrap this
   *  in tier-specific guardrails. */
  readonly taskBody: string;
  /** Resolved at cage-create time; embedded in the brief. */
  readonly agent: FallbackAgent;
  /** Resolved at cage-create time; embedded in the brief. */
  readonly workDir: string;
}

// ---------- Errors ----------

/** ADR-050 v1 + Task t-706655ee §scope (revised 2026-05-14): Tier 3
 *  (Kimi) and Tier 4 (MiniMax) are PERMANENTLY OUT of scope for
 *  fallback-cage creation. Operator evaluation: *"MiniMax + Kimi are
 *  unreliable and not smart enough"* — spawning a low-quality
 *  executor at budget-pause creates more cleanup than the saved
 *  budget gains. Only Tier 2 (Cursor composer-2) is accepted.
 *
 *  Thrown synchronously from {@link createFallbackCage} on any
 *  `tier !== 2`. Catchable via `instanceof` so the budget-pause path
 *  can route to `atmux flag add --severity high` + a Discord
 *  `[fallback-tier-unavailable]` ping. */
export class FallbackTierDroppedError extends Error {
  readonly tier: FallbackTier;
  constructor(tier: FallbackTier) {
    super(
      `Tier ${tier} fallback cage is permanently out of scope per ADR-050 v1 ` +
        `+ Task t-706655ee (2026-05-14 operator scope reduction). ` +
        `Only Tier 2 (Cursor / composer-2) is accepted. ` +
        `Caller must route Tier ${tier} requests to a flag instead.`,
    );
    this.name = "FallbackTierDroppedError";
    this.tier = tier;
  }
}

/** Thrown when a Tier 3+ provisioned user is missing — operator must run
 *  scripts/provision-fallback-user.sh first per ADR-058 §D2. */
export class FallbackUserMissingError extends Error {
  readonly agent: FallbackAgent;
  constructor(agent: FallbackAgent) {
    super(
      `Tier 3+ user '${agent}' not provisioned. ` +
        `Run: scripts/provision-fallback-user.sh ${agent}`,
    );
    this.name = "FallbackUserMissingError";
    this.agent = agent;
  }
}

// ---------- Constants ----------

/** Per-tier agent resolution. Exported for parity-state-impl T3 reconcile
 *  + T4 cascade work. */
export const TIER_AGENT: Readonly<Record<FallbackTier, FallbackAgent>> = {
  2: "operator",
  3: "kimi-agent",
  4: "minimax-agent",
};

/** rsync excludes for Tier 3+ workspace — keeps `.git` + credentials +
 *  reference material + transient state out of the agent's view. */
export const TIER3_RSYNC_EXCLUDES: ReadonlyArray<string> = [
  ".git",
  ".gitmodules-credentials",
  "**/credentials*",
  ".atmux/state",
  "_refs/",
];

// ---------- Path helpers ----------

/** Per-cage TMUX_TMPDIR path. Tier 2 uses team+lane only; Tier 3+ adds
 *  agent suffix to keep the operator-tmux blast-radius zero. */
export function cageTmuxTmpdir(team: string, lane: string, agent: FallbackAgent): string {
  return agent === "operator"
    ? `/tmp/atmux_fallback_${team}_${lane}/`
    : `/tmp/atmux_fallback_${team}_${lane}_${agent}/`;
}

/** Per-cage tmux socket short-name; same identifier the operator types
 *  to `atmux-tmux attach -L <socket>`. */
export function cageTmuxSocket(team: string, lane: string): string {
  return `fallback_${team}_${lane}`;
}

/** Per-cage tmux session name; one session per cage. */
export function cageSessionName(team: string, lane: string): string {
  return `fallback-${team}-${lane}`;
}

/** Tier 3+ workspace path inside the agent's home. */
export function tier3WorkDir(agent: FallbackAgent, team: string, lane: string): string {
  return `/home/${agent}/cages/${team}-${lane}/work`;
}

/** Archive root for cage teardown (per OQ3). Auto-pruned by groom at 7d. */
export function cageArchiveRoot(atmuxDir: string, tier: FallbackTier): string {
  return `${atmuxDir}/tier${tier}-handoff/archive`;
}

/** Per-destroy archive path. Includes epoch suffix for collision-free
 *  storage when a cage is re-spawned for the same lane within seconds. */
export function cageArchivePath(
  atmuxDir: string,
  tier: FallbackTier,
  team: string,
  lane: string,
  epochSec: number,
): string {
  return `${cageArchiveRoot(atmuxDir, tier)}/${team}-${lane}-${epochSec}`;
}

// ---------- Brief composers (ADR-058 §D4) ----------

/**
 * Tier 2 brief — Cursor (composer-2). Operator UID, full git, mutative-
 * git allowed per ADR-058 §D1 trust posture. Reviewer-gated through the
 * existing per-commit cycle.
 */
export function composeTier2Brief(opts: ComposeBriefOpts): string {
  return [
    `# Fallback-cage brief — Tier 2 (Cursor / composer-2)`,
    ``,
    `Team: \`${opts.team}\``,
    `Lane: \`${opts.lane}\``,
    `Task: \`${opts.taskId}\``,
    `Workspace: \`${opts.workDir}\` (operator UID — full git access)`,
    ``,
    `## Mission`,
    ``,
    opts.taskBody,
    ``,
    `## Scope guardrails`,
    ``,
    `- Stay within the Task body's scope. No drive-by refactors.`,
    `- Do NOT touch \`_refs/\` (frozen reference material).`,
    `- Do NOT modify other workers' staged files — path-restrict your commits.`,
    ``,
    `## Git policy`,
    ``,
    `- You have full git access (operator UID).`,
    `- Stage + commit + push are fine; reviewer-gated per existing flow.`,
    `- Conventional-commits subject line; co-author trailer per project convention.`,
    ``,
    `## Reconciliation`,
    ``,
    `- On budget-resume, the operator's Claude member resumes via continuity brief.`,
    `- Your commits stay on the working branch — no rsync-back, no manual reconcile.`,
    `- The original member sees your SHAs in git log; that's the handoff record.`,
    ``,
  ].join("\n");
}

/**
 * @deprecated ADR-050 v1 + Task t-706655ee (2026-05-14 scope
 * reduction) — Tier 3 (Kimi) is permanently dropped. New callers
 * must NOT compose Tier 3 briefs; `createFallbackCage` rejects
 * `tier === 3` synchronously. This function is retained only so
 * existing test fixtures + the `destroyFallbackCage` teardown path
 * for legacy persisted Tier 3 handles keep compiling. Slated for
 * removal once the deprecation cycle closes.
 *
 * Original spec: Tier 3 brief — Kimi (kimi-cli). Dedicated
 * `kimi-agent` user, NO .git in workspace, kernel-isolated.
 * Operator manually reconciled via scripts/fallback-reconcile.sh
 * per ADR-058 §D5.
 */
export function composeTier3Brief(opts: ComposeBriefOpts): string {
  return [
    `# Fallback-cage brief — Tier 3 (Kimi / kimi-cli)`,
    ``,
    `Team: \`${opts.team}\``,
    `Lane: \`${opts.lane}\``,
    `Task: \`${opts.taskId}\``,
    `You are: \`${opts.agent}\` (dedicated user — kernel-isolated)`,
    `Workspace: \`${opts.workDir}\` (read-write — your only writeable path)`,
    ``,
    `## Mission`,
    ``,
    opts.taskBody,
    ``,
    `## Scope guardrails`,
    ``,
    `- Stay within the Task body's scope. No drive-by refactors.`,
    `- Do NOT touch \`_refs/\` (excluded from your workspace by rsync).`,
    `- Greenfield code is fine; reconciler will integrate.`,
    ``,
    `## Git policy — HARD CONSTRAINT`,
    ``,
    `- You have NO \`.git\` in your workspace and NO write access to the project's \`.git\`.`,
    `- Do NOT attempt \`git\` operations of any kind. There is no git binary in your PATH within the cage.`,
    `- Do NOT attempt \`sudo\` — you do not have sudo rights.`,
    `- Write your output as plain files inside \`${opts.workDir}\`. The operator will diff + reconcile + commit on Tier 1/2.`,
    ``,
    `## Workspace context`,
    ``,
    `- Project history snapshot: \`${opts.workDir}/_history.log\` (last 50 commits, read-only reference).`,
    `- Project status snapshot: \`${opts.workDir}/_status.log\` (capture-time \`git status\`).`,
    `- Project branch: \`${opts.workDir}/_branch.log\` (capture-time \`git branch --show-current\`).`,
    `- Use these for context; do NOT try to update them.`,
    ``,
    `## Reconciliation expectation`,
    ``,
    `- The operator runs \`scripts/fallback-reconcile.sh ${opts.team} ${opts.lane}\` after your work lands.`,
    `- That diffs your workspace against the project worktree, presents per-file deltas, and the operator selects which to bring back.`,
    `- Selected deltas rsync into the operator-owned worktree under operator UID; commits go through Tier 1/2.`,
    ``,
  ].join("\n");
}

/**
 * @deprecated ADR-050 v1 + Task t-706655ee (2026-05-14 scope
 * reduction) — Tier 4 (MiniMax) is permanently dropped, not "not
 * GA". `createFallbackCage` rejects `tier === 4` synchronously
 * without checking the legacy `MINIMAX_CLI_AVAILABLE` env flag.
 * This function is retained only so test fixtures + the
 * `destroyFallbackCage` teardown path for legacy persisted Tier 4
 * handles keep compiling. Slated for removal once the deprecation
 * cycle closes.
 *
 * Original spec: Tier 4 brief — MiniMax (CLI when GA). Same as
 * Tier 3 isolation + additional 'CLI may be unavailable' guard per
 * parent task body.
 */
export function composeTier4Brief(opts: ComposeBriefOpts): string {
  return [
    `# Fallback-cage brief — Tier 4 (MiniMax)`,
    ``,
    `Team: \`${opts.team}\``,
    `Lane: \`${opts.lane}\``,
    `Task: \`${opts.taskId}\``,
    `You are: \`${opts.agent}\` (dedicated user — kernel-isolated)`,
    `Workspace: \`${opts.workDir}\` (read-write — your only writeable path)`,
    ``,
    `> ⚠️  MiniMax CLI may be unavailable — Tier 4 ships as a stub until the CLI is GA per ADR-058 §OQ6.`,
    `> If you can read this brief, the operator wired the CLI manually; same kernel-isolation rules as Tier 3 apply.`,
    ``,
    `## Mission`,
    ``,
    opts.taskBody,
    ``,
    `## Scope guardrails`,
    ``,
    `- Stay within the Task body's scope. No drive-by refactors.`,
    `- Do NOT touch \`_refs/\` (excluded from your workspace by rsync).`,
    `- Greenfield code is fine; reconciler will integrate.`,
    ``,
    `## Git policy — HARD CONSTRAINT`,
    ``,
    `- You have NO \`.git\` in your workspace and NO write access to the project's \`.git\`.`,
    `- Do NOT attempt \`git\` operations of any kind. There is no git binary in your PATH within the cage.`,
    `- Do NOT attempt \`sudo\` — you do not have sudo rights.`,
    `- Write your output as plain files inside \`${opts.workDir}\`. The operator will diff + reconcile + commit on Tier 1/2.`,
    ``,
    `## Reconciliation expectation`,
    ``,
    `- Same as Tier 3: \`scripts/fallback-reconcile.sh ${opts.team} ${opts.lane}\` after your work lands.`,
    `- Operator selects deltas; commits go through Tier 1/2.`,
    ``,
  ].join("\n");
}

// ---------- Cage create / destroy ----------

/**
 * Verify a Tier 3+ provisioned user exists. Throws
 * FallbackUserMissingError on miss.
 */
async function verifyAgentProvisioned(
  agent: FallbackAgent,
  spawnFn: (opts: SpawnOpts) => Promise<SpawnResult>,
): Promise<void> {
  if (agent === "operator") return;
  const r = await spawnFn({
    cmd: "getent",
    argv: ["passwd", agent],
    timeoutMs: 5_000,
    expectExitCode: "any",
  });
  if (r.exitCode !== 0) throw new FallbackUserMissingError(agent);
}

/**
 * Tier 3+ workspace builder — sudo + mkdir + rsync + git-context dump
 * + chown. NO direct git calls inside the agent's workspace
 * (reviewer-gated lint rule per ADR-058 §D4 hard rule). Git context
 * dumps are written via spawnFn in the OPERATOR's UID context, then
 * rsync'd in (which is the only place a `git` invocation appears in
 * this module — and it runs OUTSIDE the agent's cage, against the
 * operator's worktree).
 */
async function buildTier3PlusWorkspace(
  opts: {
    agent: FallbackAgent;
    team: string;
    lane: string;
    projectCwd: string;
    workDir: string;
  },
  spawnFn: (opts: SpawnOpts) => Promise<SpawnResult>,
): Promise<void> {
  const cageDir = `/home/${opts.agent}/cages/${opts.team}-${opts.lane}`;

  await spawnFn({
    cmd: "sudo",
    argv: ["-u", opts.agent, "mkdir", "-p", `${cageDir}/work`],
    timeoutMs: 10_000,
  });

  const rsyncArgv: string[] = ["-av"];
  for (const exclude of TIER3_RSYNC_EXCLUDES) rsyncArgv.push(`--exclude=${exclude}`);
  rsyncArgv.push(`${opts.projectCwd}/`, `${cageDir}/work/`);
  await spawnFn({
    cmd: "rsync",
    argv: rsyncArgv,
    timeoutMs: 5 * 60 * 1000,
  });

  // Git context dump — runs OUTSIDE the cage, against operator's
  // worktree. Output paths land inside the agent's workspace; agent
  // reads them as static reference data.
  const histR = await spawnFn({
    cmd: "git",
    argv: ["log", "--oneline", "-50"],
    cwd: opts.projectCwd,
    timeoutMs: 10_000,
    expectExitCode: "any",
  });
  const statusR = await spawnFn({
    cmd: "git",
    argv: ["status"],
    cwd: opts.projectCwd,
    timeoutMs: 10_000,
    expectExitCode: "any",
  });
  const branchR = await spawnFn({
    cmd: "git",
    argv: ["branch", "--show-current"],
    cwd: opts.projectCwd,
    timeoutMs: 10_000,
    expectExitCode: "any",
  });
  const writeContextFile = async (filename: string, body: string): Promise<void> => {
    await spawnFn({
      cmd: "sudo",
      argv: ["-u", opts.agent, "tee", `${cageDir}/work/${filename}`],
      stdin: body,
      timeoutMs: 10_000,
    });
  };
  await writeContextFile("_history.log", histR.stdout);
  await writeContextFile("_status.log", statusR.stdout);
  await writeContextFile("_branch.log", branchR.stdout);

  // chown the entire cage tree to agent — defence in depth even though
  // sudo -u <agent> mkdir already created with correct ownership; rsync
  // may have produced operator-owned files if running as operator.
  await spawnFn({
    cmd: "sudo",
    argv: ["chown", "-R", `${opts.agent}:${opts.agent}`, cageDir],
    timeoutMs: 30_000,
  });
}

/**
 * Create a fallback cage for a single lane. ADR-050 v1 + Task t-706655ee
 * (2026-05-14 operator scope reduction) restrict creation to **Tier 2
 * (Cursor) only** — Tier 3 (Kimi) and Tier 4 (MiniMax) are permanently
 * out of scope. Tier 2 spawns a cage tmux server in the operator's
 * project cwd; the cage runs `cursor-agent --print --model composer-2
 * --force` against the original member's worktree.
 *
 * Throws {@link FallbackTierDroppedError} synchronously for any
 * `tier !== 2`. The caller (typically `whip-budget-fallback` on a
 * sustained budget-pause) should route dropped-tier requests to
 * `atmux flag add --severity high` + a Discord
 * `[fallback-tier-unavailable]` ping rather than retrying.
 *
 * The brief composers + workspace builders for Tier 3+ remain in this
 * module for the `destroyFallbackCage` teardown path (handles
 * `CageHandle` rows persisted before the 2026-05-14 reduction); the
 * **create** path is the hard gate, not the destroy path.
 */
export async function createFallbackCage(opts: CreateFallbackCageOpts): Promise<CageHandle> {
  const tier = opts.tier;
  // ADR-050 v1 + Task t-706655ee — refuse-at-entry for dropped tiers.
  // No env override (operator's "permanently out" is binding); legacy
  // MINIMAX_CLI_AVAILABLE env is intentionally ignored.
  if (tier !== 2) {
    throw new FallbackTierDroppedError(tier);
  }

  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const tmuxFactory = opts.tmuxFactory ?? defaultCreateTmux;
  const nowSec = opts.nowSec ?? ((): number => Math.floor(Date.now() / 1000));

  const agent = TIER_AGENT[tier];
  await verifyAgentProvisioned(agent, spawnFn);

  const tmuxTmpdir = cageTmuxTmpdir(opts.team, opts.lane, agent);
  const tmuxSocket = cageTmuxSocket(opts.team, opts.lane);
  const sessionName = cageSessionName(opts.team, opts.lane);
  const windowName = `tier${tier}-${opts.lane}`;
  const workDir =
    agent === "operator" ? opts.projectCwd : tier3WorkDir(agent, opts.team, opts.lane);

  if (agent !== "operator") {
    await buildTier3PlusWorkspace(
      {
        agent,
        team: opts.team,
        lane: opts.lane,
        projectCwd: opts.projectCwd,
        workDir,
      },
      spawnFn,
    );
  }

  // Spawn the cage tmux server. The factory captures the socket flag in
  // a closure so all subsequent invocations reach this server only.
  // ADR-162 §Decision-anchor #2: thread the canonical atmux.conf via
  // `-f` so the Tier-2 cage's tmux server runs with the same baseline
  // as cockpit + per-team sessions. Operator override via
  // `ATMUX_TMUX_CONF`.
  const tmux = tmuxFactory({ socket: tmuxSocket, configFile: getAtmuxTmuxConfPath() });

  // Ensure TMUX_TMPDIR env is honoured by the actual session creation.
  // createTmux's session.newSession spawns through spawn() which inherits
  // process.env unless overridden; for the cage we set it via the spawnFn
  // call directly below using mkdir to materialize the tmpdir, then rely
  // on tmux's `-L <socket>` resolution against $TMUX_TMPDIR.
  //
  // ADR-281: that inheritance is exactly the colour fault. The Tier-2
  // (operator-UID) branch below creates its server through the `tmux`
  // namespace built above — `createTmux` → `spawn()` — so it is ALREADY
  // covered by tmux.ts's TMUX_CHILD_UNSET_ENV.
  // The Tier-3+ `sudo` branch is NOT: sudo's env_reset drops a spawn-level
  // override, so it carries TMUX_CHILD_ENV_ARGV in its `env(1)` prefix.
  await spawnFn({
    cmd: "mkdir",
    argv: ["-p", tmuxTmpdir],
    timeoutMs: 5_000,
  });

  // For Tier 3+ the tmux server itself runs as the dedicated agent —
  // not the operator. We spawn `sudo -u <agent> tmux ...` to create
  // the session; createTmux's namespace is then used by the OPERATOR
  // for read-only inspection (operator can `tmux -L <socket> attach`
  // because the socket is set with permissive group rights via the
  // provisioned user's setfacl grants).
  if (agent === "operator") {
    await tmux.session.newSession({
      name: sessionName,
      detached: true,
      cwd: workDir,
      windowName,
    });
  } else {
    await spawnFn({
      cmd: "sudo",
      argv: [
        "-u",
        agent,
        "env",
        ...TMUX_CHILD_ENV_ARGV,
        `TMUX_TMPDIR=${tmuxTmpdir}`,
        resolveTmuxBin(),
        "-L",
        tmuxSocket,
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-n",
        windowName,
        "-c",
        workDir,
      ],
      timeoutMs: 15_000,
    });
  }

  return {
    tier,
    team: opts.team,
    lane: opts.lane,
    taskId: opts.taskId,
    agent,
    tmuxTmpdir,
    tmuxSocket,
    workDir,
    sessionName,
    windowName,
    createdAt: nowSec(),
  };
}

/** Options for destroyFallbackCage. */
export interface DestroyFallbackCageOpts {
  readonly atmuxDir: string;
  readonly spawnFn?: (opts: SpawnOpts) => Promise<SpawnResult>;
  readonly tmuxFactory?: (config: TmuxConfig) => TmuxNamespace;
  readonly nowSec?: () => number;
}

/**
 * Destroy a fallback cage. Idempotent — re-calls succeed quietly even
 * if the session is already gone or the workspace already archived.
 *
 * Per ADR-058 §OQ3 default: workspace is archived to
 * `<atmuxDir>/tier<tier>-handoff/archive/<team>-<lane>-<epoch>/`
 * before teardown so operators can post-mortem failed cages. Auto-prune
 * at 7d via groom.
 */
export async function destroyFallbackCage(
  handle: CageHandle,
  opts: DestroyFallbackCageOpts,
): Promise<void> {
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const tmuxFactory = opts.tmuxFactory ?? defaultCreateTmux;
  const nowSec = opts.nowSec ?? ((): number => Math.floor(Date.now() / 1000));

  const archivePath = cageArchivePath(
    opts.atmuxDir,
    handle.tier,
    handle.team,
    handle.lane,
    nowSec(),
  );
  await spawnFn({
    cmd: "mkdir",
    argv: ["-p", archivePath],
    timeoutMs: 5_000,
  });

  // Archive the workspace. Tier 2's workspace is the operator's
  // worktree — archiving the whole cwd would be wrong; instead capture
  // a session log + the cage's tmux history. Tier 3+'s workspace is the
  // agent's home dir which is safe to copy.
  if (handle.agent === "operator") {
    // For Tier 2, capture the session's last 1000 lines of pane content
    // as the post-mortem artefact. The operator's worktree is NOT
    // archived (it's the live project tree).
    const captureR = await spawnFn({
      cmd: resolveTmuxBin(),
      // ADR-281: `capture-pane` against a dead socket starts a server, so
      // even this teardown probe carries the child-env policy.
      unsetEnv: TMUX_CHILD_UNSET_ENV,
      argv: [
        "-L",
        handle.tmuxSocket,
        "capture-pane",
        "-t",
        `${handle.sessionName}:${handle.windowName}`,
        "-p",
        "-S",
        "-1000",
      ],
      timeoutMs: 15_000,
      expectExitCode: "any",
    });
    await spawnFn({
      cmd: "tee",
      argv: [`${archivePath}/session.log`],
      stdin: captureR.stdout,
      timeoutMs: 5_000,
    });
  } else {
    // Tier 3+: rsync the agent's workspace into the archive. Run as
    // operator (default uid) — sudo only needed for the read against
    // the agent's chmod 700 home, which we address via the rsync's
    // `--rsync-path='sudo rsync'` form for explicit elevation.
    const cageDir = `/home/${handle.agent}/cages/${handle.team}-${handle.lane}/work`;
    await spawnFn({
      cmd: "sudo",
      argv: ["-u", handle.agent, "rsync", "-a", `${cageDir}/`, `${archivePath}/`],
      timeoutMs: 5 * 60 * 1000,
      expectExitCode: "any",
    });
  }

  // Kill the cage tmux session. Idempotent: ignore non-zero exit
  // (session already gone is fine).
  if (handle.agent === "operator") {
    const tmux = tmuxFactory({ socket: handle.tmuxSocket });
    try {
      await tmux.session.killSession(handle.sessionName);
    } catch {
      // Session already gone — idempotent.
    }
  } else {
    await spawnFn({
      cmd: "sudo",
      argv: [
        "-u",
        handle.agent,
        "env",
        // ADR-281 — sudo's env_reset drops a spawn-level override.
        ...TMUX_CHILD_ENV_ARGV,
        `TMUX_TMPDIR=${handle.tmuxTmpdir}`,
        resolveTmuxBin(),
        "-L",
        handle.tmuxSocket,
        "kill-session",
        "-t",
        handle.sessionName,
      ],
      timeoutMs: 10_000,
      expectExitCode: "any",
    });
  }

  // Tier 3+: remove the cage workspace tree. Tier 2: leave operator's
  // worktree intact (we only archived a session capture).
  if (handle.agent !== "operator") {
    const cageRoot = `/home/${handle.agent}/cages/${handle.team}-${handle.lane}`;
    await spawnFn({
      cmd: "sudo",
      argv: ["-u", handle.agent, "rm", "-rf", cageRoot],
      timeoutMs: 60_000,
      expectExitCode: "any",
    });
  }
}
