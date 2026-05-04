# ADR-006: Error handling discipline

**Status:** accepted
**Date:** 2026-05-04
**Owner:** architect

## Context

Bash atmux ships its three most-painful bug class — silent error swallowing — across 110 `2>/dev/null || true` patterns and 414 total `2>/dev/null` redirections (counts at HEAD `2aadc3f`). ADR-001 Pressure 2 documented this as a primary motivation for the port. CLAUDE.md "verify green from the right path" was written about the precise failure mode bash atmux exhibits at scale: the visible signal (no error) does not match the actual signal (call returned nonzero, output discarded).

The TS port has the chance to make error handling **typed and mechanical**:

- Every IO boundary throws a tagged error class. Catching code can branch on tag, never on string-matching.
- Every `try/catch` that intentionally swallows must have an inline justification. Reviewer regex enforces.
- The CLI top-level catch always formats; nothing reaches `process.exit` via uncaught throw without a stack-trace + structured message.

This ADR codifies the error hierarchy, the throw-vs-return-null decision rule, the swallow-comment regex, and the top-level catch in `src/cli.ts`.

## Decision

### Hierarchy: one `AtmuxError` base, tagged subclasses per subsystem

```ts
// src/errors.ts
export abstract class AtmuxError extends Error {
  abstract readonly tag: string;          // discriminator
  readonly cause?: unknown;
  readonly context: Record<string, unknown>;

  constructor(message: string, opts?: { cause?: unknown; context?: Record<string, unknown> }) {
    super(message, { cause: opts?.cause });
    this.cause = opts?.cause;
    this.context = opts?.context ?? {};
    // Restore prototype for instanceof through transpilation
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// One subclass per IO subsystem — tagged for switch-on-tag handling
export class TmuxError extends AtmuxError {
  readonly tag = "tmux" as const;
  constructor(opts: { argv: string[]; exitCode: number; stderr: string;
    stdout?: string; cause?: unknown }) {
    super(`tmux ${opts.argv[0] ?? ""} failed (exit ${opts.exitCode}): ${opts.stderr.trim()}`,
      { cause: opts.cause, context: opts });
  }
}

export class SpawnError extends AtmuxError {
  readonly tag = "spawn" as const;
  constructor(opts: { cmd: string; argv: string[]; exitCode: number; stderr: string;
    stdout?: string; cause?: unknown }) {
    super(`${opts.cmd} ${opts.argv.join(" ")} failed (exit ${opts.exitCode})`,
      { cause: opts.cause, context: opts });
  }
}

export class SpawnTimeoutError extends AtmuxError {
  readonly tag = "spawn-timeout" as const;
  constructor(opts: { cmd: string; argv: string[]; timeoutMs: number }) {
    super(`${opts.cmd} ${opts.argv.join(" ")} timed out after ${opts.timeoutMs}ms`,
      { context: opts });
  }
}

export class SchemaError extends AtmuxError {
  readonly tag = "schema" as const;
  constructor(opts: { file: string; issues: ZodIssue[]; cause: ZodError }) {
    super(`schema mismatch in ${opts.file}: ${opts.issues[0]?.path.join(".")} ${opts.issues[0]?.message}`,
      { cause: opts.cause, context: opts });
  }
}

export class LockError extends AtmuxError {
  readonly tag = "lock" as const;
  constructor(opts: { path: string; cause?: unknown }) {
    super(`could not acquire lock on ${opts.path}`, { cause: opts.cause, context: opts });
  }
}

export class LockTimeoutError extends AtmuxError {
  readonly tag = "lock-timeout" as const;
  constructor(opts: { path: string; timeoutMs: number }) {
    super(`lock on ${opts.path} timed out after ${opts.timeoutMs}ms`, { context: opts });
  }
}

export class FsError extends AtmuxError {
  readonly tag = "fs" as const;
  constructor(opts: { path: string; op: "read" | "write" | "stat" | "rename" | "mkdir";
    cause: unknown }) {
    super(`fs ${opts.op} failed on ${opts.path}`, { cause: opts.cause, context: opts });
  }
}

export class DiscordWebhookError extends AtmuxError {
  readonly tag = "discord" as const;
  constructor(opts: { template: string; statusCode?: number;
    body?: string; cause?: unknown }) {
    super(`discord webhook ${opts.template} failed${opts.statusCode ? ` (HTTP ${opts.statusCode})` : ""}`,
      { cause: opts.cause, context: opts });
  }
}

export class ConfigError extends AtmuxError {
  readonly tag = "config" as const;
  // missing team.json, malformed env var, unresolvable .atmux/ root, etc.
  constructor(opts: { what: string; hint?: string; cause?: unknown }) {
    super(opts.hint ? `${opts.what} (hint: ${opts.hint})` : opts.what,
      { cause: opts.cause, context: opts });
  }
}

export class UsageError extends AtmuxError {
  readonly tag = "usage" as const;
  // bad CLI args / unknown verb / wrong arity. Distinguishes "user typo" from
  // "real failure" so cli.ts can print a friendlier hint.
  constructor(opts: { what: string; hint?: string }) {
    super(opts.hint ? `${opts.what} — ${opts.hint}` : opts.what, { context: opts });
  }
}

export type AtmuxErrorTag =
  | "tmux" | "spawn" | "spawn-timeout"
  | "schema" | "lock" | "lock-timeout"
  | "fs" | "discord" | "config" | "usage";
```

**Why tags as readonly literal strings instead of `instanceof`:** instanceof is fragile under bundling/transpilation (Bun is fine, but tests sometimes reload modules); switch-on-tag is robust and forces explicit handling. Both work — code is welcome to use `instanceof` too — but `tag` is the canonical discriminator.

### Throw vs. return null — the rule

| Situation | Pattern | Why |
|---|---|---|
| **Programmer error** (impossible state, invariant violated, type mismatch that escaped TS) | `throw new Error(...)` (plain) or `throw new AtmuxError(...)` if it fits a tag | Crash; this is a bug. |
| **Unrecoverable IO failure** (tmux nonzero, lock timeout, schema mismatch, file unreadable) | `throw new TmuxError(...)` etc. | Loud; caller decides whether to handle the tag. |
| **Expected absence** (`team.json` doesn't exist on first read by `init` verb; member's inbox is empty on first dispatch) | `return null` (or `T \| null`) with inline `// expected: <reason>` comment | The "absence" is part of the contract; throwing would be noisy. |
| **Optional read with default** | `readJsonOr(path, schema, fallback)` (per ADR-005) | Helper makes intent visible at call site. |

**The `// expected: <reason>` rule.** Any `try/catch` that intentionally swallows an error MUST carry an inline comment of the form `// expected: <reason>` on the catch line or immediately above it. Examples:

```ts
// OK — explicit swallow with reason
try {
  await tmux.session.killSession(name);
} catch {  // expected: session may already be gone (stop is idempotent)
  /* noop */
}

// OK — typed branch on tag, swallow only specific case
try {
  return await readJson(path, schema);
} catch (e) {
  if (e instanceof AtmuxError && e.tag === "fs") return null;  // expected: first-run, file absent
  throw e;
}

// VIOLATION — silent swallow without justification
try { await something(); } catch {}                   // ❌ blocks PR
try { await something(); } catch { /* ignore */ }     // ❌ blocks PR (no "expected:")
.catch(() => null)                                    // ❌ blocks PR
.catch(() => undefined)                               // ❌ blocks PR
```

**Reviewer enforcement (custom lint).** Regex check, run as part of `bun run lint`, blocks PR:

```
catch\s*(?:\([^)]*\))?\s*\{(?![^}]*\bthrow\b)(?![^}]*\bexpected:)
.catch\(\s*\(\s*\)\s*=>\s*(?:null|undefined|void\s*0)\s*\)(?![^\n]*expected:)
```

(Exact regex finalised by foundation porter when implementing the lint; semantics: "any catch block that does not throw OR doesn't carry `expected:` is a violation.")

### Top-level catch in `src/cli.ts`

```ts
// src/cli.ts
import { AtmuxError, UsageError } from "./errors";

export async function main(argv: string[]): Promise<number> {
  try {
    const verb = argv[0] ?? "up";
    const handler = await resolveVerb(verb);  // throws UsageError if unknown
    return await handler(argv.slice(1));
  } catch (err) {
    return reportError(err);
  }
}

function reportError(err: unknown): number {
  if (err instanceof UsageError) {
    process.stderr.write(`atmux: ${err.message}\n`);
    if (err.context.hint) process.stderr.write(`       ${err.context.hint}\n`);
    return 64;                                  // EX_USAGE
  }
  if (err instanceof AtmuxError) {
    process.stderr.write(`atmux: ${err.tag}: ${err.message}\n`);
    if (process.env.ATMUX_DEBUG) {
      process.stderr.write(formatErrorChain(err));   // full cause chain + stack
    }
    return exitCodeForTag(err.tag);
  }
  // Unknown / unexpected — include stack, exit 99.
  process.stderr.write(`atmux: internal error\n`);
  process.stderr.write(err instanceof Error ? `${err.stack}\n` : `${String(err)}\n`);
  return 99;
}

function exitCodeForTag(tag: AtmuxErrorTag): number {
  switch (tag) {
    case "usage": return 64;     // EX_USAGE
    case "config": return 78;    // EX_CONFIG
    case "lock-timeout":
    case "spawn-timeout": return 75;   // EX_TEMPFAIL — try again later
    case "schema": return 65;    // EX_DATAERR
    case "tmux":
    case "spawn":
    case "fs":
    case "discord":
    case "lock":
    default: return 1;
  }
}
```

Exit-code convention follows BSD `sysexits.h` for the categories that map cleanly. Verbs that need verb-specific exit codes can return them directly from their `run()` (e.g. `claim` returns 2 if task already claimed). Anything thrown that isn't an `AtmuxError` is a bug — exit 99 + full stack to stderr.

### Reviewer rules summary (per ADR-006 + ADR-003)

- **R1.** No `catch {}` or `catch { /* … */ }` without `// expected: <reason>` comment. (regex above)
- **R2.** No `.catch(() => null)` / `.catch(() => undefined)` without `// expected: <reason>` comment. (regex above)
- **R3.** No `JSON.parse` outside `src/abstractions/json.ts`. (ADR-005)
- **R4.** No `Bun.spawn` outside `src/abstractions/spawn.ts`. (ADR-007)
- **R5.** No `new Date().toLocale*` outside `src/abstractions/time.ts`. (ADR-012)
- **R6.** Every `throw` in `src/abstractions/*` and `src/core/*` throws a subclass of `AtmuxError`. Plain `throw new Error(...)` is allowed only in `src/verbs/*` for programmer-error invariants AND must carry a `// invariant: <reason>` comment.
- **R7.** No `process.exit()` outside `src/cli.ts`. Verbs return exit codes from `run()`.

The custom lint script (`scripts/lint-discipline.ts`, foundation-porter task) bundles R1, R2, R6, R7. Biome's `noRestrictedImports` covers R3, R4, R5.

## Consequences

**Positives:**

- Silent-swallow culture is impossible: every catch either carries `expected:` or throws. Reviewer regex makes the rule mechanical.
- Verbs can branch on `err.tag` and handle subsystem failures explicitly when meaningful (e.g. `whip` retries on `lock-timeout`, treats `tmux` as fatal). No string-matching.
- Top-level catch produces consistent stderr format (`atmux: <tag>: <message>`) — operator pattern-matching across logs is reliable.
- `cause` chain preserved through every wrapper; debug output (`ATMUX_DEBUG=1`) prints full chain for incident triage.
- Unknown-error path always shows stack + exits 99, so internal bugs are loud not silent.
- Exit codes follow BSD sysexits where reasonable, giving operators meaningful signals (cron retry on EX_TEMPFAIL, alert on internal-99).

**Negatives:**

- Discipline cost: every IO call site has to think about which error tag fires. Foundation porter bears the brunt; porters in Phase 2 mostly compose the existing tags.
- Reviewer regex is a static check; clever escapes are possible (`/* expected */` keyword in code), but those clever escapes are themselves a review red flag. Reviewer can comment.
- `// expected:` comment becomes a search-anchor for audits — "show me every place we accept a swallow" is a 1-line grep. This is positive in disguise.
- Tag enum needs to evolve carefully; renaming a tag breaks any `switch (err.tag)` exhaustive match. Mitigated by TS exhaustiveness checks (`assertNever`) at branch sites.
- Plain `throw new Error("…")` in verbs (allowed by R6 for programmer-error invariants) feels like an escape valve. Reviewer holds the line: invariant comments must explain why a typed error doesn't fit.

**Follow-up tickets:**

- Foundation porter: implement `src/errors.ts` exactly as sketched here; add `formatErrorChain` helper.
- Foundation porter: write `scripts/lint-discipline.ts` (R1, R2, R6, R7).
- Reviewer (Phase 0 close): add the custom lint to `bun run lint` and to CI.
- ADR-007 (spawn): SpawnError + SpawnTimeoutError throw shape consistent with this hierarchy.
- ADR-008 (discord): DiscordWebhookError throw shape consistent.
- ADR-012 (time): no error class needed; abstraction is pure.
- Doctor verb (Phase 2): add `--debug-errors` flag that exercises every tag's emit path (sanity).

## Alternatives considered

### A. Result<T, E> / neverthrow / fp-ts Either

Considered. Compelling in pure functional codebases. Rejected for atmux because:
- Wrapping every IO call in `Result` adds noticeable ceremony to verb code that's already doing flow-heavy orchestration. Imperative `try`/`catch` with typed errors is more readable for our shape.
- TypeScript's exception types aren't part of the type system, but Result's inferred error types interact awkwardly with `async`/`await` and our `Promise`-heavy IO style.
- Top-level catch in `cli.ts` becomes a distributed concern in a Result-everywhere world ("did every callsite unwrap?"). One catch in cli.ts is simpler.
- Existing CLAUDE.md discipline ("no silent swallows") is compatible with throw + explicit catch; doesn't require Result.

We can add `Result` selectively if a future verb has a clear hot path that benefits — not banned, just not the default.

### B. Single `AtmuxError` class with `code: string` field (not subclasses)

Considered. Less code surface. Rejected because subclasses + tag union let `instanceof` narrow types AND give us `.context` shape per subclass (e.g. `TmuxError.context.argv` is `string[]`, `SchemaError.context.issues` is `ZodIssue[]`). A single class would force `context: Record<string, unknown>` everywhere, losing type safety inside catch handlers.

### C. Throw plain `Error` with structured `.cause` everywhere

Rejected. Loses the discriminator. Every catch site would `instanceof Error && err.cause instanceof TmuxCause` — verbose, and `.cause` chain inspection across multiple wraps is unergonomic.

### D. Do nothing — let exceptions propagate naturally and document discipline

Rejected outright. CLAUDE.md "no silent error swallows" requires structural enforcement, not aspirational discipline. Bash atmux had aspirational discipline; bash atmux ships 110 swallows.

### E. Use `panic`-style fatal logger that exits immediately on any error

Rejected. Verbs need to handle subsystem failures (e.g. `whip` on `lock-timeout` retries; `dispatch` on `tmux` failure marks member quarantined). Universal fatal-on-error makes the program a kernel.

## References

- PLAN.md §3 (constraints — strict TS), §4.3 (no silent error-swallowing — reviewer enforces)
- PLAN.md §9 (reviewer 8-check gate, item 5 — "no silent error swallows")
- ADR-001 Pressure 2 (silent error swallow culture, the failure this ADR closes)
- ADR-003 (module taxonomy — `src/errors.ts` is the universally-importable leaf)
- ADR-005 (json+lock — declares SchemaError, LockError, LockTimeoutError)
- ADR-007 (spawn — declares SpawnError, SpawnTimeoutError)
- ADR-008 (discord — declares DiscordWebhookError)
- CLAUDE.md "verify green from the right path" (verification discipline section)
- BSD `sysexits(3)` — exit-code convention
