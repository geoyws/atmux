// ADR-006: Error handling discipline.
//
// AtmuxError base + tagged subclasses. The single module everyone imports
// from. No incoming dependencies on app code; only TS/zod lib types.
//
// Discriminator: `tag` literal-union string. Switch on `tag` is the
// canonical pattern (instanceof works too but is fragile under bundling).

import type { ZodError, ZodIssue } from "zod";

/** Closed enum of every error tag in the system. Exhaustive switch sites use
 *  `assertNever(tag)` to catch newly-added tags at compile time. */
export type AtmuxErrorTag =
  | "tmux"
  | "spawn"
  | "spawn-timeout"
  | "schema"
  | "lock"
  | "lock-timeout"
  | "fs"
  | "http"
  | "http-timeout"
  | "tracker-rate-limit"
  | "issue-sync-target"
  | "issue-sync-kguard"
  | "discord"
  | "voice-provider"
  | "verb-mutex"
  | "config"
  | "usage";

/** Compile-time exhaustiveness assertion for switch-on-tag. */
export function assertNever(value: never): never {
  throw new Error(`unreachable: ${String(value)}`);
}

/** Base class. Concrete errors set `tag` to a literal. */
export abstract class AtmuxError extends Error {
  abstract readonly tag: AtmuxErrorTag;
  override readonly cause?: unknown;
  readonly context: Record<string, unknown>;

  constructor(message: string, opts?: { cause?: unknown; context?: Record<string, unknown> }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    if (opts?.cause !== undefined) this.cause = opts.cause;
    this.context = opts?.context ?? {};
    // Restore prototype for instanceof through transpilation (ADR-006).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** tmux subcommand failed (nonzero exit outside the accepted set). */
export class TmuxError extends AtmuxError {
  readonly tag = "tmux" as const;
  constructor(opts: {
    argv: ReadonlyArray<string>;
    exitCode: number;
    stderr: string;
    stdout?: string;
    cause?: unknown;
  }) {
    super(`tmux ${opts.argv[0] ?? ""} failed (exit ${opts.exitCode}): ${opts.stderr.trim()}`, {
      cause: opts.cause,
      context: { ...opts },
    });
  }
}

/** Generic spawn failure (nonzero exit / `Bun.which` miss / aborted). */
export class SpawnError extends AtmuxError {
  readonly tag = "spawn" as const;
  constructor(opts: {
    cmd: string;
    argv: ReadonlyArray<string>;
    exitCode: number;
    stderr: string;
    stdout?: string;
    cause?: unknown;
  }) {
    super(`${opts.cmd} ${opts.argv.join(" ")} failed (exit ${opts.exitCode})`, {
      cause: opts.cause,
      context: { ...opts },
    });
  }
}

/** Spawn timed out before child exited (after SIGTERM→SIGKILL grace). */
export class SpawnTimeoutError extends AtmuxError {
  readonly tag = "spawn-timeout" as const;
  constructor(opts: { cmd: string; argv: ReadonlyArray<string>; timeoutMs: number }) {
    super(`${opts.cmd} ${opts.argv.join(" ")} timed out after ${opts.timeoutMs}ms`, {
      context: { ...opts },
    });
  }
}

/** Schema parse failure on a JSON boundary file. */
export class SchemaError extends AtmuxError {
  readonly tag = "schema" as const;
  constructor(opts: { file: string; issues: ReadonlyArray<ZodIssue>; cause: ZodError }) {
    const first = opts.issues[0];
    const path = first ? first.path.join(".") || "<root>" : "<root>";
    const msg = first ? first.message : "unknown schema error";
    super(`schema mismatch in ${opts.file}: ${path} ${msg}`, {
      cause: opts.cause,
      context: { ...opts },
    });
  }
}

/** Lock acquisition failed for a non-timeout reason. */
export class LockError extends AtmuxError {
  readonly tag = "lock" as const;
  constructor(opts: { path: string; cause?: unknown }) {
    super(`could not acquire lock on ${opts.path}`, {
      cause: opts.cause,
      context: { ...opts },
    });
  }
}

/** Lock acquisition exceeded its timeout budget. */
export class LockTimeoutError extends AtmuxError {
  readonly tag = "lock-timeout" as const;
  constructor(opts: { path: string; timeoutMs: number }) {
    super(`lock on ${opts.path} timed out after ${opts.timeoutMs}ms`, {
      context: { ...opts },
    });
  }
}

/** Filesystem operation failed. */
export class FsError extends AtmuxError {
  readonly tag = "fs" as const;
  constructor(opts: {
    path: string;
    op: "read" | "write" | "stat" | "rename" | "mkdir" | "unlink" | "open";
    cause: unknown;
  }) {
    super(`fs ${opts.op} failed on ${opts.path}`, {
      cause: opts.cause,
      context: { ...opts },
    });
  }
}

/** HTTP failure: either a status outside the caller's accepted range OR a
 *  network-level failure (DNS / refused / TLS / dropped connection). Network
 *  failures set `status: 0` with `cause` carrying the underlying error;
 *  status-rejection sets `status` to the response code with `body` carrying
 *  the response payload. Caller branches on `status === 0` vs status code. */
export class HttpError extends AtmuxError {
  readonly tag = "http" as const;
  readonly url: string;
  readonly method: string;
  readonly status: number;
  readonly body: string;
  constructor(opts: {
    url: string;
    method: string;
    status: number;
    body: string;
    cause?: unknown;
  }) {
    super(`HTTP ${opts.status} from ${opts.method} ${opts.url}`, {
      cause: opts.cause,
      context: { ...opts },
    });
    this.url = opts.url;
    this.method = opts.method;
    this.status = opts.status;
    this.body = opts.body;
  }
}

/** HTTP request exceeded its timeout budget (after AbortController fired). */
export class HttpTimeoutError extends AtmuxError {
  readonly tag = "http-timeout" as const;
  constructor(opts: { url: string; method: string; timeoutMs: number }) {
    super(`http ${opts.method} ${opts.url} timed out after ${opts.timeoutMs}ms`, {
      context: { ...opts },
    });
  }
}

/** External issue-tracker API rate limit exhausted (ADR-261 §D1 rate-limit
 *  hygiene). Adapters surface the provider's 403/429 + `x-ratelimit-remaining:
 *  0` as this typed error carrying the reset epoch — the sync ENGINE decides
 *  whether to checkpoint + bail or wait; adapters never sleep/retry beyond
 *  what `http.ts` already does. `resetAtSec` is `null` when the provider sent
 *  no (or a garbled) reset header — never a fabricated epoch. */
export class TrackerRateLimitError extends AtmuxError {
  readonly tag = "tracker-rate-limit" as const;
  readonly trackerId: string;
  readonly resetAtSec: number | null;
  constructor(opts: {
    trackerId: string;
    url: string;
    status: number;
    resetAtSec: number | null;
    cause?: unknown;
  }) {
    const resetTail = opts.resetAtSec !== null ? `, resets at epoch ${opts.resetAtSec}` : "";
    super(
      `${opts.trackerId} rate limit exhausted (HTTP ${opts.status} from ${opts.url}${resetTail})`,
      {
        cause: opts.cause,
        context: { ...opts },
      },
    );
    this.trackerId = opts.trackerId;
    this.resetAtSec = opts.resetAtSec;
  }
}

/** ADR-261 §D9 target-team resolution refusal (ADR-150 §D5 semantics):
 *  the issue-sync `targetTeam` config must resolve to EXACTLY ONE cockpit
 *  team — zero matches, multiple matches, or a match with no resolvable
 *  project root are all refusals with a clear error, never a silent
 *  first-pick. Thrown by `resolveTargetTeamAtmuxDir`
 *  (src/core/issue-sync.ts). */
export class TargetTeamResolutionError extends AtmuxError {
  readonly tag = "issue-sync-target" as const;
  readonly team: string;
  readonly reason: "not-found" | "ambiguous" | "no-root";
  /** How many cockpit sessions matched the name (0 / 1 / N). */
  readonly matches: number;
  constructor(opts: {
    team: string;
    reason: "not-found" | "ambiguous" | "no-root";
    matches: number;
  }) {
    const detail =
      opts.reason === "ambiguous"
        ? `${opts.matches} cockpit sessions match — refusing the silent first-pick (ADR-150 §D5)`
        : opts.reason === "not-found"
          ? "no cockpit team/epic-team session has this name"
          : "matched an epic-team with no resolvable parent root";
    super(`cannot resolve target team ${JSON.stringify(opts.team)}: ${detail}`, {
      context: { ...opts },
    });
    this.team = opts.team;
    this.reason = opts.reason;
    this.matches = opts.matches;
  }
}

/** ADR-261 §D8 first-sync flood guard: without `--backfill`, one sync
 *  refuses to file more than K new complaints (default 10) — the first
 *  sync of any populated repo IS the backfill case, and an unguarded run
 *  would fire one tell-lead per issue against ADR-214 §D2's
 *  1-complaint/min intent. The engine attaches its partial `SyncReport`
 *  (with `kGuardHit: true`) under `context.report`; pages already
 *  reconciled stay checkpointed, so the `--backfill` re-run resumes
 *  without duplicating rows (the §D4 ledger dedups every filed id). */
export class KGuardExceededError extends AtmuxError {
  readonly tag = "issue-sync-kguard" as const;
  readonly trackerId: string;
  readonly scope: string;
  /** New complaints already filed in this sync when the guard fired. */
  readonly filedCount: number;
  readonly maxNewComplaints: number;
  constructor(opts: {
    trackerId: string;
    scope: string;
    /** The §D3 sourceId of the refused (K+1th) filing candidate. */
    sourceId: string;
    filedCount: number;
    maxNewComplaints: number;
    /** Partial SyncReport (typed in src/core/issue-sync.ts — this module
     *  stays app-code-free per the ADR-006 header rule). */
    report?: unknown;
  }) {
    super(
      `issue-sync K-guard: refusing to file more than ${opts.maxNewComplaints} new complaints ` +
        `in one sync of ${opts.trackerId}:${opts.scope} (${opts.filedCount} already filed; ` +
        `next candidate ${opts.sourceId}) — re-run with --backfill to file everything ` +
        `quietly + send one summary tell-lead`,
      { context: { ...opts } },
    );
    this.trackerId = opts.trackerId;
    this.scope = opts.scope;
    this.filedCount = opts.filedCount;
    this.maxNewComplaints = opts.maxNewComplaints;
  }
}

/** Discord webhook send / format / validation failure. */
export class DiscordWebhookError extends AtmuxError {
  readonly tag = "discord" as const;
  constructor(opts: {
    template: string;
    statusCode?: number;
    body?: string;
    detail?: string;
    cause?: unknown;
  }) {
    const tail = opts.statusCode !== undefined ? ` (HTTP ${opts.statusCode})` : "";
    const detail = opts.detail ? `: ${opts.detail}` : "";
    super(`discord webhook ${opts.template} failed${tail}${detail}`, {
      cause: opts.cause,
      context: { ...opts },
    });
  }
}

/** Realtime voice-provider failure (ADR-272): WebSocket connect/send on the
 *  voice transport, or a provider-protocol breach. Maps to EX_TEMPFAIL (75) —
 *  a provider outage is transient; callers retry cleanly. `provider` names the
 *  adapter ("openai-realtime" / "gemini-live") when known. */
export class VoiceProviderError extends AtmuxError {
  readonly tag = "voice-provider" as const;
  constructor(opts: { what: string; provider?: string; detail?: string; cause?: unknown }) {
    const scope = opts.provider !== undefined ? ` (${opts.provider})` : "";
    const tail = opts.detail !== undefined ? ` — ${opts.detail}` : "";
    super(`voice provider${scope}: ${opts.what}${tail}`, {
      cause: opts.cause,
      context: { ...opts },
    });
  }
}

/**
 * The verb-execution lane refused this call (ADR-272 §Supplement-P7 §R2).
 *
 * Two reasons, both meaning "the lane is occupied", never "the verb
 * failed": `queue_full` (the bounded queue was already at its cap, so
 * NOTHING was run) and `abandoned` (the caller's own response deadline
 * passed while it waited, so running it now would act on a request that
 * already timed out). `blockedBy` names the tool holding the lane — the
 * actionable half, and the reason this carries fields rather than a
 * message alone.
 *
 * EX_TEMPFAIL (75): a busy lane is transient by definition — the same
 * call succeeds once the holder returns. In practice this never reaches
 * the CLI: `createToolBridge` converts it into a `tool_timeout` envelope
 * so the model can speak it. The tag exists so the conversion is checked
 * against a typed error rather than a string match.
 */
export class VerbMutexError extends AtmuxError {
  readonly tag = "verb-mutex" as const;
  readonly reason: "queue_full" | "abandoned";
  /** Label of the function holding the lane, or null if it was idle. */
  readonly blockedBy: string | null;
  /** How long this caller waited before being refused (0 for queue_full). */
  readonly waitedMs: number;
  /** Callers queued at the moment of refusal. */
  readonly queueDepth: number;
  /** The cap `queueDepth` is measured against. */
  readonly queueCap: number;
  constructor(opts: {
    reason: "queue_full" | "abandoned";
    label: string;
    blockedBy: string | null;
    waitedMs: number;
    queueDepth: number;
    queueCap: number;
  }) {
    const behind = opts.blockedBy !== null ? ` behind '${opts.blockedBy}'` : "";
    const what =
      opts.reason === "queue_full"
        ? `verb lane full${behind}: ${opts.queueDepth}/${opts.queueCap} queued — '${opts.label}' was not run`
        : `verb lane: '${opts.label}' abandoned after waiting ${opts.waitedMs}ms${behind}`;
    super(what, { context: { ...opts } });
    this.reason = opts.reason;
    this.blockedBy = opts.blockedBy;
    this.waitedMs = opts.waitedMs;
    this.queueDepth = opts.queueDepth;
    this.queueCap = opts.queueCap;
  }
}

/** Configuration / environment is wrong (missing team.json, bad env var, etc.). */
export class ConfigError extends AtmuxError {
  readonly tag = "config" as const;
  constructor(opts: { what: string; hint?: string; cause?: unknown }) {
    super(opts.hint ? `${opts.what} (hint: ${opts.hint})` : opts.what, {
      cause: opts.cause,
      context: { ...opts },
    });
  }
}

/** User typed something that doesn't match a known verb / arg shape. */
export class UsageError extends AtmuxError {
  readonly tag = "usage" as const;
  constructor(opts: { what: string; hint?: string }) {
    super(opts.hint ? `${opts.what} — ${opts.hint}` : opts.what, {
      context: { ...opts },
    });
  }
}

/** BSD sysexits-aligned exit code for a given tag. */
export function exitCodeForTag(tag: AtmuxErrorTag): number {
  switch (tag) {
    case "usage":
      return 64; // EX_USAGE
    case "config":
    case "issue-sync-target": // operator config must change (ADR-150 §D5 refusal)
      return 78; // EX_CONFIG
    case "lock-timeout":
    case "spawn-timeout":
    case "http-timeout":
    case "tracker-rate-limit":
    case "voice-provider": // voice: provider outage retries cleanly (ADR-272)
    case "verb-mutex": // voice: the verb lane is busy, not broken (ADR-272 §R2)
      return 75; // EX_TEMPFAIL — try again later (after the provider's reset)
    case "schema":
      return 65; // EX_DATAERR
    case "tmux":
    case "spawn":
    case "fs":
    case "http":
    case "discord":
    case "lock":
    // Deliberate refusal that never self-heals on retry — the operator
    // must re-run with --backfill (ADR-261 §D8), so not EX_TEMPFAIL.
    case "issue-sync-kguard":
      return 1;
    default:
      return assertNever(tag);
  }
}

/**
 * Walk the `.cause` chain and render a multi-line diagnostic. Used by the
 * top-level catch in `src/cli.ts` when `ATMUX_DEBUG=1`.
 */
export function formatErrorChain(err: unknown): string {
  const lines: string[] = [];
  let depth = 0;
  let cur: unknown = err;
  while (cur !== undefined && cur !== null && depth < 16) {
    const indent = "  ".repeat(depth);
    if (cur instanceof Error) {
      const tag = cur instanceof AtmuxError ? `[${cur.tag}] ` : "";
      lines.push(`${indent}${tag}${cur.name}: ${cur.message}`);
      if (cur.stack) {
        const stackTail = cur.stack.split("\n").slice(1).join("\n");
        if (stackTail) lines.push(stackTail);
      }
      cur = (cur as { cause?: unknown }).cause;
    } else {
      lines.push(`${indent}${String(cur)}`);
      cur = undefined;
    }
    depth += 1;
  }
  return `${lines.join("\n")}\n`;
}
