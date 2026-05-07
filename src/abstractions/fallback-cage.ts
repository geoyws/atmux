// ADR-058 §D3+§D4: multi-tier fallback-cage builder + brief generator.
//
// Tier 2 (Cursor) → operator UID, full git, dedicated cage tmux server
// at TMUX_TMPDIR=/tmp/atmux_fallback_<team>_<lane>/.
// Tier 3 (Kimi)   → dedicated `kimi-agent` user, NO .git in workspace,
// rsync'd workspace at /home/kimi-agent/cages/<team>-<lane>/work/.
// Tier 4 (MiniMax) → CLI not GA; stub returns Tier4_NOT_AVAILABLE error
// per OQ6 until the binary lands.
//
// Brief composers are folded into this module per ADR-058 §D4 — the
// brief embeds tier-identity (agent name, workDir, git policy), so
// splitting them across modules introduces an artificial seam.
//
// Hard rule: NO direct git invocation from Tier 3+ cage path. Reviewer-
// gated. The whole point of the kernel-isolated user is that the agent
// has no .git in its workspace — invoking git from THIS module's T3+
// path would defeat the design (operator-side reconciliation is the
// only mutative-git surface for T3+).
//
// SPLIT NOTE: this module ships in two commits per ADR-058 T2 plan —
// (a) types + errors + path helpers + brief composers + paired tests
//     (this commit; unblocks parity-state-impl T3 reconcile work)
// (b) createFallbackCage + destroyFallbackCage + lifecycle tests
//     (follow-up; full cage lifecycle + 100% coverage).

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

/** Thrown when Tier 4 (MiniMax) is requested but the CLI isn't GA yet
 *  per ADR-058 OQ6. Catchable via instanceof for the budget-pause path
 *  to fall back to Tier 3 or surface a flag. */
export class Tier4NotAvailableError extends Error {
  constructor() {
    super(
      "Tier 4 (MiniMax) CLI is not yet GA — see ADR-058 §OQ6. " +
        "Use Tier 2 (Cursor) or Tier 3 (Kimi) until the CLI lands.",
    );
    this.name = "Tier4NotAvailableError";
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
 * Tier 3 brief — Kimi (kimi-cli). Dedicated `kimi-agent` user, NO .git
 * in workspace, kernel-isolated. Operator manually reconciles via
 * scripts/fallback-reconcile.sh per ADR-058 §D5.
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
 * Tier 4 brief — MiniMax (CLI when GA). Same as Tier 3 isolation +
 * additional 'CLI may be unavailable' guard per parent task body.
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
