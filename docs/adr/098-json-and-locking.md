# ADR-098: JSON + locking model

**Status:** accepted — **narrowed by [ADR-126](126-sqlite-state-store.md)**: kanban (`tasks/epics/stories`), inboxes, and per-feature state moved to `.atmux/state.db` (SQLite, WAL). This ADR remains authoritative for `team.json`, JSONL append-logs, the markdown surface, and bash atmux's full state surface.
**Date:** 2026-05-04
**Owner:** architect

## Context

atmux's durable state is JSON files in `.atmux/`. Concurrent-write hazards are real: a `whip` cron tick and a driver-typed `claim` can race on `kanban.json`; two members claiming the same task can race on their inbox files. The bash code addresses this with `flock(2)` (2 call sites, both in `lib/common.sh`) and `jq` for read+mutate (172 `jq` invocations across the worktree's `lib/`).

The bash atomic-update primitive looks like this:

```bash
atmux::jq_update() {
  local file="$1"; shift
  local filter="$1"; shift
  exec {lockfd}>"${file}.lock"
  flock "$lockfd"
  local tmp; tmp="$(mktemp "${file}.XXXXXX")"
  if [[ -s "$file" ]]; then
    jq "$@" "$filter" "$file" >"$tmp"
  else
    jq -n "$@" "$filter" >"$tmp"
  fi
  mv "$tmp" "$file"
  exec {lockfd}>&-
}
```

The pattern is sound: exclusive lock on a sidecar `.lock` file, write to a temp file, atomic rename. This ADR preserves the pattern semantics in TS while closing three weaknesses:

1. **No schema.** `jq "$filter" "$file"` accepts whatever shape comes back. A typo in one verb's filter that produces malformed JSON is silently persisted; the next reader's `jq` call fails with a generic parse error far from the origin.
2. **No timeout.** `flock` here is blocking. A bug where one writer hangs locks the file forever; cron ticks queue indefinitely.
3. **No structured error.** Lock acquisition failures, parse failures, and write failures all surface as bash exit codes and `2>/dev/null || true` patterns.

## Decision

### Schema validation at every JSON boundary

Every JSON file atmux reads or writes has a Zod schema in `src/schema/<file>.ts`. Reads validate via `schema.parse()`; writes serialize values that have already been validated.

```ts
// src/schema/kanban.ts
import { z } from "zod";

export const Kanban = z.object({
  schemaVersion: z.literal(1),
  tasks: z.array(z.object({
    id: z.string().regex(/^t-[a-f0-9]{8}$/),
    subject: z.string().min(1),
    status: z.enum(["todo", "in-progress", "done", "blocked"]),
    assignee: z.string().nullable(),
    createdAt: z.number().int().positive(),    // epoch ms
    deps: z.array(z.string()).default([]),
    body: z.string().optional(),
  })),
}).strict();          // <-- reject unknown keys; schema drift surfaces immediately

export type Kanban = z.infer<typeof Kanban>;
```

**Reviewer rule:** `JSON.parse(...)` is forbidden in `src/core/*` and `src/verbs/*`. The only place `JSON.parse` is allowed is `src/abstractions/json.ts`. Custom lint enforces (per ADR-096).

**Schema-mismatch policy:** parse failures throw `SchemaError` (ADR-099) carrying:
- `file: string` — the path being validated
- `issues: ZodIssue[]` — the Zod issue tree
- `cause: ZodError` — the original error

Never silent fallback to defaults. Never partial-parse. If the file shape doesn't match, we crash loudly so the operator knows their state is corrupt.

**Schema versioning.** Every schema includes a `schemaVersion: z.literal(N)` field. Migrations live in `src/schema/migrations/<file>-vN-to-vN+1.ts` and run once on read when version mismatches. Migration code is tested. (Phase 2 doesn't need migrations yet — every schema lands at v1 and stays.)

### Atomic write pattern

`src/abstractions/json.ts` exposes:

```ts
export async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T>;
export async function readJsonOr<T>(path: string, schema: z.ZodType<T>, fallback: T): Promise<T>;
export async function writeJson<T>(path: string, schema: z.ZodType<T>, value: T): Promise<void>;
export async function updateJson<T>(path: string, schema: z.ZodType<T>,
  mutator: (current: T) => T | Promise<T>): Promise<T>;
```

- `readJson` — throws `FsError` if file missing, `SchemaError` if shape wrong.
- `readJsonOr` — returns `fallback` if file missing (and only if missing — schema mismatch on existing file still throws). The fallback path replaces bash's "if `[[ -s "$file" ]]`" branch.
- `writeJson` — validates input via `schema.parse(value)` before serializing, writes to `<path>.tmp.<pid>.<rand>`, fsync, rename.
- `updateJson` — read+validate → call mutator → validate → atomic write, all under a lock. **This is the only mutation path verbs should use.**

The atomic-write internals:

```ts
async function writeJsonAtomic<T>(path: string, schema: z.ZodType<T>, value: T): Promise<void> {
  const validated = schema.parse(value);            // throws SchemaError on bad input
  const body = JSON.stringify(validated, null, 2) + "\n";
  const tmp = `${path}.tmp.${process.pid}.${randomId()}`;
  await fs.mkdir(dirname(path), { recursive: true });
  const fh = await fs.open(tmp, "w", 0o644);
  try {
    await fh.writeFile(body);
    await fh.sync();                                // fsync — durability
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, path);                       // atomic on same FS
}
```

`updateJson` wraps the read+mutate+write under `lock.withLock()` (next section).

### Lock primitive — hand-rolled `flock(2)`

**Decision: hand-roll a `flock(2)` wrapper in `src/abstractions/lock.ts`. Reject `proper-lockfile` and the `.lock`-directory-rename approach.**

Reasoning:

| Criterion | `flock(2)` (hand-rolled) | `proper-lockfile` (npm dep) |
|---|---|---|
| Semantics match bash atmux | ✅ identical (bash uses `flock(2)`) | ❌ different (uses `.lock/` directory rename) |
| Cross-platform | macOS + Linux only | macOS + Linux + Windows |
| LOC | ~60–80 in our tree | 0 in our tree, ~600 in deps |
| Stale-lock recovery | OS-managed (lock auto-released on FD close, including process death) | manually managed via lockfile staleness check + cleanup |
| Failure modes we own | All | Most |
| Bun support | ✅ via `node:fs` `fcntl` / Bun ships flock binding | ✅ runs in Bun |
| Dep surface | 0 | +1 dep, +6 transitive |

atmux runs on macOS + Linux only (CLAUDE.md "Machines" table — `Darwin` local + `Linux` hax). Windows portability is not an asset we are buying. `flock(2)` lock auto-release on process death is a strict win over `proper-lockfile`'s staleness heuristic, which has a known race ("did the holder die, or is it just slow?") that we'd rather not own.

Implementation sketch:

```ts
// src/abstractions/lock.ts
import { open, close } from "node:fs/promises";
import * as flock from "<bun-flock-or-fcntl-shim>";   // exact import resolved by porter
import { LockTimeoutError, LockError } from "../errors";

export interface LockHandle { release(): Promise<void> }

export async function acquire(path: string, opts?: {
  timeoutMs?: number;        // default 5_000
  retryDelayMs?: number;     // default 100
}): Promise<LockHandle> {
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  const retryDelayMs = opts?.retryDelayMs ?? 100;
  const lockPath = `${path}.lock`;
  const fd = await openLockFile(lockPath);
  const start = Date.now();
  while (true) {
    const got = tryFlockExclusive(fd);
    if (got) return { release: async () => { /* flock LOCK_UN; close(fd) */ } };
    if (Date.now() - start > timeoutMs) {
      await close(fd);
      throw new LockTimeoutError({ path, timeoutMs });
    }
    await sleep(retryDelayMs);
  }
}

export async function withLock<T>(path: string, fn: () => Promise<T>,
  opts?: { timeoutMs?: number }): Promise<T> {
  const handle = await acquire(path, opts);
  try { return await fn(); }
  finally { await handle.release(); }
}
```

Key properties:

- **Timeout = 5s default.** `LockTimeoutError` thrown on expiry; never silent.
- **Retry every 100ms.** Soft polling; could be replaced with `flock(LOCK_NB)` poll plus event-loop yield.
- **Lock file is the sidecar `<path>.lock`** — same shape as bash. Concurrent bash + TS during cutover (PLAN.md §4.1) lock against each other correctly.
- **Lock auto-released on process death** by the kernel (intrinsic flock(2) semantic).
- **No nested locks of the same file from the same process.** flock is process-level on most BSD implementations; nested `withLock` on same path from same TS process would not actually re-lock. We document "do not nest" rather than implement reentrant logic. Verbs nest by composition (e.g. `claim` updates `kanban.json` AND `inboxes/<member>.json`); rule is "lock each file once at the top of its update; do not call from inside another update of the same file".

### Smoke-test commitment — gates ADR acceptance? **Yes, but at Phase 1 close, not now.**

The 1000-iteration / 4-writer concurrent-write smoke runs as a parity-style integration test in `tests/parity/lock-concurrency.test.ts`. **Acceptance**: this ADR is provisionally accepted on Phase 0 close (so foundation porter can begin); it becomes **finally** accepted at Phase 1 exit gate ONLY after the smoke is green:

- 4 TS workers (subprocesses spawned via `Bun.spawn`)
- Each runs 250 iterations
- Each iteration: `updateJson("kanban.json", schema, k => append-task-with-fresh-id)`
- Final assertion: `kanban.json` has exactly 1000 tasks, all IDs unique, no JSON parse errors mid-run
- Run 5 times; zero failures = pass; any failure = ADR-098 reopened

If the smoke fails, the fallback is to switch to `proper-lockfile` rather than re-engineer our own. We commit to this fallback in writing here so the decision isn't argued mid-bug.

Smoke also runs **bash + TS interleaved** (2 bash workers + 2 TS workers) to validate cross-language lock behaviour during the cutover window (PLAN.md §4.1). This catches subtle cases like "bash holds lock; TS times out after 5s; bash holds lock for 10s". If interleaved smoke is red, we extend timeout in TS verbs that race the cron-fired bash whip.

## Consequences

**Positives:**

- Schema drift becomes a typed crash, not a silent persistence of garbage. Closes one of bash atmux's three most-painful bug classes (per ADR-095 Pressure 3).
- `JSON.parse` outside `json.ts` is a layer violation; reviewer regex makes the rule mechanical.
- Atomic write + flock matches bash semantics exactly; cutover (PLAN.md §4.1) is safe to run bash and TS side-by-side because the on-disk lock primitive is identical.
- 1000-iter/4-writer smoke is a real gate, not a "we tested it once" claim. CI reruns on every commit that touches `lock.ts` or `json.ts`.
- Hand-rolled lock means future failure investigation reads our own code, not deps three transitive levels deep.
- Schema versioning is a first-class field; migration is a designed extension point, not an afterthought.

**Negatives:**

- 60–80 LOC of `flock(2)` wrapping is real implementation work; porter must take care with `node:fs` `fcntl` semantics across macOS + Linux (subtle differences in `flock` vs `fcntl(F_SETLK)`).
- The `flock` import path in Bun is stable as of 1.3.13 but we should pin to the version we test (PLAN.md). Foundation porter to confirm import path.
- Schema files are LOC overhead (~50 LOC per schema × ~10 schemas = ~500 LOC). Trade for crash-on-mismatch is well worth it.
- Mismatched-schema crashes are loud — operators may see them in production during the burn-in window if a hand-written `team.json` violates the schema. Doctor verb (Phase 2) gains a `--validate-schemas` flag to catch this proactively before start.
- Strict schemas (`.strict()`) reject unknown keys. If we ever want forward-compat (older atmux tolerating fields written by newer atmux), we'd switch to `.passthrough()`. Defer that decision to v2 — for v1, strict is the right default.

**Follow-up tickets:**

- ADR-099 (error handling) — `SchemaError`, `LockError`, `LockTimeoutError`, `FsError` defined here.
- Foundation porter (Phase 1) implements `src/abstractions/json.ts` + `src/abstractions/lock.ts`; commits the 1000-iter smoke and runs it 5×.
- Schema porter (Phase 2 architect+porter-A duty) writes one Zod schema per JSON boundary file: `team`, `kanban`, `inbox`, `cost`, `flags`, `decisions` (frontmatter), `lead-outbox` (entries), `driver-inbox`.
- Doctor verb (Phase 2) gains `--validate-schemas` flag; runs every schema's `.parse()` against the corresponding `.atmux/` file and reports mismatches.

## Alternatives considered

### A. `proper-lockfile` npm dep

Pros:
- Battle-tested.
- Cross-platform (we don't need Windows but it's free).
- Built-in stale-lock recovery, retry, jitter.

Cons:
- Different semantics from bash flock — uses `.lock/` directory rename + held-by-pid heuristic. Concurrent bash + TS workers would NOT actually lock against each other (bash holds an `flock`; TS holds a `.lock/` dir). This is a parity-harness break.
- Adds ~600 LOC of dep surface for ~80 LOC of our own equivalent.
- Stale-lock detection has a known race (clock skew, slow processes).

The first cons is decisive: cross-language lock compatibility during cutover is a hard requirement.

### B. Per-process in-memory mutex + write-through

Considered. Acquire an in-memory `Mutex` for path X, then write through to disk. Rejected because cron-fired `whip` is a separate Bun process from operator-typed `claim`; in-memory mutexes don't span processes. Disk-level lock is mandatory.

### C. Use SQLite for state instead of JSON files

Considered (would solve schema + locking in one move). Rejected for v1 because:
- Wholesale state-store migration. Out of scope for a runtime port.
- Bash atmux would no longer work against the state during cutover (PLAN.md §4.1 requires side-by-side).
- atmux's state files are operator-readable plain text today; that's a feature, not a bug.

Revisit at v3 if file-locking continues to bite. v2 (ADR-107) keeps JSON.

### D. Optimistic concurrency (compare-and-swap on file mtime)

Considered. No locks; reader captures mtime, mutator writes only if mtime hasn't changed since read. Rejected:
- Bash side has no equivalent. Cutover needs cross-language compatibility.
- Race on the mtime-check itself (TOCTOU) is a real concern for sub-second writes.
- flock(2) is simpler and we already have it.

### E. Single-writer architecture (one process owns all state writes; verbs send messages to it)

Considered as a v3 idea. Out of scope for v1. Substantial architectural shift; would move atmux from "fork-and-die" CLI tool to "long-running daemon", which is currently being prototyped in bash WIP (`socket-pubsub.sh`, bash-side `docs/adr/042-socket-pubsub.md` — the legacy bash ADR series, distinct from this `docs/adr/` numbering). That whole design space is out of scope per PLAN.md §11 and ADR-106 (WIP-bash deferral, this series).

## References

- PLAN.md §3 (constraints — strict TS), §4.4 (schema-first), §10 (proper-lockfile note)
- ADR-095 Pressure 3 (no static typing across JSON boundary — this ADR closes it)
- ADR-096 (module taxonomy — `json.ts` and `lock.ts` are abstractions)
- ADR-099 (error handling — SchemaError / LockError / LockTimeoutError / FsError)
- ADR-102 (test strategy — fixture factories use the same Zod schemas)
- ADR-104 (cutover — cross-language lock compatibility is a cutover requirement)
- bash `lib/common.sh` lines 187–221 — current atomic-update + with-lock primitives we are matching
