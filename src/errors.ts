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
  | "discord"
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
      return 78; // EX_CONFIG
    case "lock-timeout":
    case "spawn-timeout":
      return 75; // EX_TEMPFAIL — try again later
    case "schema":
      return 65; // EX_DATAERR
    case "tmux":
    case "spawn":
    case "fs":
    case "discord":
    case "lock":
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
