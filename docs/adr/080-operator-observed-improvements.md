# ADR-080: Operator-observed atmux improvements (sopx-driver bundle)

**Status**: accepted
**Date**: 2026-05-09
**Date-accepted**: 2026-05-13 — all seven sub-sections shipped: §A1 `22d7daa` · §A2 `baafb16` · §B1 `0ecaa64` · §B2 `bbd9cef` · §C `17f0abf` · §D `bfb0193` · §E `1877af5`. Per t-bb05b9ba audit + reviewer signoff 2026-05-09 13:53 MYT.
**Driver-ref**: 2026-05-09 07:25 MYT sopx-driver bundle (`/root/work/src/atmux/.atmux/driver-inbox.md` §07:25 entry). Five improvements observed in sopx-guild during demo-week prep — two structural (lead at 67% ctx not rotating; 29 stale `commit t-X` tasks accumulating), one design-coupled (lane-tick mid-think injection defeating rotation), two papercuts (CLI flag normalize, JSON escape).

## Context

### Operator pain (verbatim from sopx-driver)

- **Today's sopx lead was at 67% ctx and `atmux claim --next`-ing instead of rotating; only manual driver intervention triggered rotation.** George's >30% ctx threshold (23:02 MYT 2026-05-08 directive) is documented in prose only — no programmatic enforcement. Whip's lead-rotation logic is uptime-based (45min warn / 60min auto) and **does not read pane ctx-pct**.
- **sopx-guild kanban at 07:14 MYT 2026-05-09 has 29 in-progress `commit t-X` tasks owned by gitter** that should normally close in 1-2min. Commits actually shipped (verified by checking sopx-root + apps/sopx-ui git logs); gitter just never ran `atmux done t-X` after commit. Drives kanban distension (278 in-progress vs only 186 done).
- **Lane-tick injects `atmux claim --next --as lead` into a pane already mid-thought** (e.g. doing `/session preclear`). Message lands in the queued-message queue; after the in-flight thought completes, the queued claim defeats the rotation. Observed today: lead was running `/session preclear` (state save before rotation) with a queued `atmux claim --next` already pending; without manual intervention, lead would have resumed claiming work AT 68% ctx instead of completing rotation.
- **`atmux task list --status in_progress` returns `(no tasks)` silently**; only `--status in-progress` works. Hides bugs in operator scripts.
- **`atmux task list --json | jq` parse-errors** on tasks whose body contains backticks/newlines/quotes.

### Pre-decomp source-state audit (changes scope)

| Improvement | Source-state finding | Scope adjustment |
|---|---|---|
| (1) Programmatic ctx-threshold rotation | `whip.ts:187,239,269,368` has `leadMaxMin` (uptime). No ctx-pct knob exists. | Net-new field + parser + integration. |
| (2) Auto-`atmux done` post-commit | `src/core/auto-push.ts` exists (post-`atmux done` push); no inverse (`atmux done` triggered by commit). | Net-new helper + lane-tick wiring. |
| (3) Lane-tick mid-think guard | `lane-tick.ts:163` already gates on `classification.state !== "READY"`; `pane-state.ts:69-102` classifies TYPING/COMPACTING/MODAL/RATE-LIMIT/SHELL — but **none of the spinner verbs** (`Hullaball`/`Computing`/`Sauté`/`✻`/etc.). Those classify as UNKNOWN, which `lane-tick:158` treats as `skip-capture-error` (not `skip-not-ready`). Bug is **narrower than reported**: the gate exists, the classifier needs more patterns. | Add patterns + new BUSY state. |
| (4) `--status` underscore | `task.ts:431` accepts whatever string; no normalize, no validation against `VALID_STATUSES`. | Per OQ-1 (lead ack): soft normalize + did-you-mean error on unknown. |
| (5) `--json` unescaped strings | `task.ts:167` already uses `JSON.stringify(tasks, null, 2)` — proper escape. Bug repro likely on **bash sopx-side** OR upstream in `core/kanban.ts::listTasks` returning a string field that's already-serialized-once. | Investigation lane: reproduce on bun first. |

## Schema additions

Centralised here (per ADR-079 §A pattern); per-section text references back.

| Field | Default | Used by | Read-site |
|---|---|---|---|
| `team.whip.leadCtxRotateThreshold` | 70 | §A1 (whip policy) + §A2 (lane-tick refusal) | `src/verbs/whip.ts` rotation gate; `src/verbs/lane-tick.ts` lead-injection gate |
| `team.gitter.repoPath` | `<atmuxDir>/..` (atmux-dir parent) | §B2 (lane-tick wire) | `src/verbs/lane-tick.ts` auto-done scan |

Both fields default to current-behaviour-preserving values. Existing teams pick them up at next `atmux start` schema-load with no `team.json` migration required.

## Decision

Seven reviewer-gateable sub-sections, each one-member / one-lane / one-commit (per atmux discipline). Two parent-concerns are split (§A → §A1 + §A2; §B → §B1 + §B2) so the schema/helper land separately from the consumer integration.

### §A1 — ctx-threshold rotation policy (whip-impl)

**Lane**: `error-class` → `whip-impl`. **Files**: `src/schema/team.ts` (schema add) + `src/verbs/whip.ts` (rotation gate near `:187`).

Schema field `leadCtxRotateThreshold` (see "Schema additions" block).

**Policy** (`src/verbs/whip.ts` near `:187`):

- Add `parseLeadCtxPct(captureText: string): number | null` helper (exported for §A2 reuse — single regex, single test surface):

  ```ts
  // Pattern: "tok 67k/100" or "tok 67.3k/100" → 67. Returns null when
  // pane has no tok indicator (transient: pane just bootstrapped).
  // Mirror the regex from src/core/pane-state.ts:101 but capture both
  // numerator + denominator, compute pct.
  ```

- In whip's lead-rotation gate: check ctx-pct alongside uptime. Either condition triggers rotate-recommendation:

  ```ts
  const ctxPct = parseLeadCtxPct(leadPaneText);
  const overUptime = uptimeMin >= cfg.leadMaxMin;
  const overCtx = ctxPct !== null && ctxPct >= cfg.leadCtxRotateThreshold;
  if (overUptime || overCtx) {
    // emit [whip-progress] "recommend rotate-lead" with reason
    const reason = overCtx ? `ctx ${ctxPct}% ≥ ${cfg.leadCtxRotateThreshold}%`
                            : `uptime ${uptimeMin}min ≥ ${cfg.leadMaxMin}min`;
  }
  ```

**Tests** (`tests/unit/verbs/whip.test.ts`):
- `parseLeadCtxPct("... tok 67k/100 ...")` → 67.
- `parseLeadCtxPct("...")` (no tok) → null.
- Whip rotate-recommendation: ctx=67 + threshold=30 → emits with "ctx 67% ≥ 30%" reason.
- Whip rotate-recommendation: ctx=null + uptime=70min → emits with uptime reason (regression-pin against ctx-only collapse).

### §A2 — ctx-threshold lane-tick refusal (up-impl) — Blocked by §A1

**Lane**: `lifecycle` → `up-impl`. **Files**: `src/verbs/lane-tick.ts:172-188`.

Consumes `parseLeadCtxPct` (exported by §A1) + the `leadCtxRotateThreshold` schema field.

**Behaviour** (`src/verbs/lane-tick.ts:172-188`):
- Before `await sendFn(windowTarget, claimText, sendOpts)` for the **lead member**: re-read pane ctx via `parseLeadCtxPct`, refuse to inject `claim --next` when ctx-pct ≥ threshold. Inject rotation nudge instead (a one-line tmux send-keys to the lead's `/team rotate-lead`).
- For non-lead members: no change (ctx-threshold only meaningful for the lead per the operator's directive).

**Tests** (`tests/unit/verbs/lane-tick.test.ts`):
- Lead pane at ctx=80, threshold=70 → injects rotation nudge, not `claim --next`.
- Lead pane at ctx=50, threshold=70 → injects `claim --next` as today (regression-pin).
- Non-lead member at ctx=80, threshold=70 → injects `claim --next` (threshold ignored for non-leads).

### §B1 — auto-done detection helper (parity-state-impl)

**Lane**: `state-mutating` → `parity-state-impl`. **Files**: `src/core/auto-done.ts` (new).

Per OQ-2 (lead ack): **lane-tick poll first, post-commit hook deferred**.

```ts
/**
 * Find a commit in `repoDir` whose message references `taskId`,
 * landed since `sinceMs`. Returns SHA on match; null on miss.
 *
 * Used by lane-tick poll (§B2) to back-fill `atmux done` for gitter
 * tasks whose commit landed but never closed the kanban entry.
 * Idempotent: a task that's already `done` is skipped at the caller.
 */
export async function findCommitForTask(
  repoDir: string,
  taskId: string,
  sinceMs: number,
): Promise<string | null> {
  // git log --grep="${taskId}" --since="<iso>" -1 --format=%H
  // Repo must exist + be a git repo; caller validates.
}
```

**Tests** (`tests/unit/core/auto-done.test.ts`):
- Helper: commit present in `git log --grep` → returns SHA.
- Helper: commit absent → returns null.
- Helper: malformed repoDir → throws ConfigError.
- Helper: `sinceMs` filter works (commit older than window → returns null).

### §B2 — auto-done lane-tick wire (up-impl) — Blocked by §B1

**Lane**: `lifecycle` → `up-impl`. **Files**: `src/verbs/lane-tick.ts`.

Consumes `findCommitForTask` (exported by §B1) + the `team.gitter.repoPath` schema field.

**Behaviour** (`src/verbs/lane-tick.ts`):

- Per tick (after the existing claim-injection loop): scan kanban for in-progress `commit t-X` tasks owned by gitter (or any member with a `commit` task pattern in their subject). For each:
  - Resolve repo via `team.gitter.repoPath` (defaults to atmux-dir's parent per OQ-B1).
  - Call `findCommitForTask(repo, taskId, taskCreatedAtMs)`.
  - On match: `await moveTask(atmuxDir, taskId, "done")` + log `lane-tick: auto-done ${taskId} via ${shortSha}`.
- One-shot back-fill: same logic, surfaced via `atmux lane-tick --backfill-done` flag for the 29-stale recovery path (operator runs once after §B2 lands).

**Tests** (`tests/unit/verbs/lane-tick.test.ts`):
- Lane-tick integration: kanban has 3 in-progress `commit t-X` tasks; mock helper returns SHA for 2, null for 1 → kanban after tick has 2 done, 1 still in-progress.
- Idempotence: re-running tick with all 3 done → no kanban writes, no log.
- `--backfill-done` flag: scans all in-progress commit-tasks regardless of recency; returns count of resolved.

**Deferred (OQ-2)**: post-commit git hook variant — addresses non-gitter commits + sub-tick latency. Defer until ADR-069 (auto-routing protocol) drafts; not blocking demo-week.

### §C — pane-state BUSY (spinner verbs) + lane-tick refusal

**Lane**: `lifecycle` → `up-impl`. (`src/core/pane-state.ts:34-102` + `src/verbs/lane-tick.ts:163`.)

Per OQ-3 (lead ack): **BUSY as separate state from TYPING**. TYPING semantics = user-text-queued (operator hasn't hit Enter); BUSY semantics = agent-mid-think (Claude Code is processing). Different recovery paths (TYPING resolves on submit; BUSY resolves when turn completes).

**Pattern catalog additions** (`src/core/pane-state.ts:69-102` `PATTERNS`):

```ts
export type PaneState =
  | "READY" | "TYPING" | "MODAL" | "RATE-LIMIT" | "COMPACTING"
  | "BUSY"        // ← new
  | "SHELL" | "UNKNOWN";

// Inserted between COMPACTING and MODAL (priority order). BUSY beats
// MODAL because a busy pane that ALSO shows a modal hint is mid-think
// — the modal will resolve when the turn completes.
{ state: "BUSY", regex: /✻\s+\w+(\.\.\.|…)/ },           // "✻ Cooked for Ns"
{ state: "BUSY", regex: /✽\s+\w+/ },                     // "✽ Honking…"
{ state: "BUSY", regex: /(Hullaball|Honking|Cogitat|Sauté|Ruminat|Computing|Thinking|Working|Cooked)(ing|ed|s)?\s*(\.\.\.|…)/i },
{ state: "BUSY", regex: /esc to interrupt/i },           // generic working banner
```

The `tokens.*esc to interrupt` READY pattern at `pane-state.ts:99` overlaps — narrow it to require the prompt char or token-counter shape rather than the interrupt marker alone.

**Lane-tick gate** (`src/verbs/lane-tick.ts:163`):
- Already skips on non-READY. BUSY classifies as non-READY → automatic skip via existing path.
- Add to the log line so operators can distinguish causes: `lane-tick: <member>: state=BUSY (evidence=<verb>) — skip`.

**Tests** (`tests/unit/core/pane-state.test.ts` + `tests/unit/verbs/lane-tick.test.ts`):
- Per-spinner-verb fixture: each pattern in the catalog matches exactly one canonical capture sample, none cross-match (e.g., "Hullaball" doesn't match RATE-LIMIT).
- `✻` glyph fixture matches BUSY.
- Lane-tick integration: pane shows "✻ Cooked for 12s" → lane-tick logs `state=BUSY` and skips injection.

### §D — `task list --status` normalize + did-you-mean (parity-read-impl)

Per OQ-1 (lead ack): **PATCH-mode soft normalize**. Underscore→hyphen silently; unknown status → UsageError with did-you-mean.

**Site** (`src/verbs/task.ts:417-484` `parseListArgs`):

```ts
if (a === "--status") {
  const v = argv[i + 1];
  if (v === undefined) throw new UsageError({ what: "task list: --status requires a value", hint: USAGE_LIST });
  const normalized = v.replace(/_/g, "-");           // soft normalize
  if (!VALID_STATUSES.has(normalized)) {
    const suggest = closestStatus(normalized);       // levenshtein-ish over VALID_STATUSES
    throw new UsageError({
      what: `task list: unknown status "${v}"${suggest ? ` — did you mean "${suggest}"?` : ""}`,
      hint: USAGE_LIST,
    });
  }
  status = normalized;
  i += 2;
  continue;
}
```

`closestStatus(s: string): string | null` — small helper, prefer in same file (not worth a `core/` module).

**Tests** (`tests/unit/verbs/task.test.ts`):
- `--status in_progress` → equivalent to `in-progress` (normalized).
- `--status in-progress` → unchanged.
- `--status nonsense` → UsageError, message includes did-you-mean (or omits cleanly if no near match).
- `--status ` (empty after strip) → UsageError "requires a value".

### §E — `task list --json` escape audit (parity-read-impl)

`src/verbs/task.ts:167` uses `JSON.stringify(tasks, null, 2)` — standard library, properly escapes. **Bug repro is unverified on bun**; sopx-side runs may be hitting bash atmux (which has its own jq pipeline).

**Investigation step** (~30min):
- Add a fixture task to a test team via `addTask(... { subject: "test", body: "```ts\nconst x = `quote`;\n```" })`.
- Run `await taskList(["--json"])` capturing stdout.
- Parse via `JSON.parse(out)` and assert no exception.

**Outcomes**:
- **(a) Bun-side reproduces**: bug is in `core/kanban.ts::listTasks` — likely a string field that's already JSON-encoded-once. Fix at the upstream emit site; same-commit unit test.
- **(b) Bun-side does NOT reproduce**: bug is bash-sopx-side. Document as known-issue in `docs/INVESTIGATION-bash-task-list-json.md`; surface to sopx-driver as "pull bun-port main resolves it"; close §E with the regression fixture as a forward-pin.

**Tests** (`tests/unit/verbs/task-json-list.test.ts`):
- Fixture task with backticks/newlines/quotes/`$` in body → `JSON.parse(taskList(["--json"]))` succeeds.
- Round-trip: `JSON.parse(out)[0].body === fixture.body`.

## Caller migration

| Caller | Before | After | Section |
|---|---|---|---|
| `whip.ts` rotate-recommendation gate | uptime-only | uptime OR ctx-pct | §A1 |
| `lane-tick.ts` lead injection | always inject claim | refuse + nudge rotate when ctx≥threshold | §A2 |
| (new) `core/auto-done.ts` | — | `findCommitForTask` helper | §B1 |
| `lane-tick.ts` (new path) | none | scan in-progress commit-tasks, auto-done on match | §B2 |
| `pane-state.ts` PATTERNS | 5 states | +BUSY = 6 states | §C |
| `task.ts:431` `--status` parser | accepts any | normalize + validate | §D |
| `task.ts:167` `--json` emit | already escapes | regression-pin fixture | §E |

`team.json` migration: see "Schema additions" block. All defaults preserve current behaviour.

## Test plan summary

- §A1: 1 ctx parser pass + 1 ctx parser null + 2 whip gate (ctx-only / uptime-only) = 4 unit tests.
- §A2: 1 lead+over-threshold + 1 lead+under-threshold regression + 1 non-lead-bypass = 3 unit tests.
- §B1: 4 helper cases (present / absent / malformed / sinceMs filter) = 4 unit tests.
- §B2: 1 lane-tick integration + 1 idempotence + 1 `--backfill-done` flag = 3 unit tests.
- §C: 1 per-pattern fixture × ~6 patterns + 1 lane-tick integration = 7 unit tests.
- §D: 4 normalize/validate cases = 4 unit tests.
- §E: 1 fixture round-trip + 1 conditional source-fix test = 1–2 unit tests.

100% coverage on new code. Same-commit-as-code per CLAUDE.md "Testing Discipline".

## Commit strategy

Single commit per sub-section (7 impl commits + 1 ADR-doc commit). §E's commit count is conditional (0 or 1, see below). Conventional:

```
feat(whip): ctx-pct rotation policy (ADR-080§A1)
feat(lane-tick): ctx-threshold lead refusal (ADR-080§A2)
feat(core): findCommitForTask helper for auto-done (ADR-080§B1)
feat(lane-tick): auto-done commit-task back-fill (ADR-080§B2)
feat(pane-state): BUSY state for spinner verbs (ADR-080§C)
fix(task): normalize --status underscores + did-you-mean error (ADR-080§D)
fix(task): JSON escape regression fixture (ADR-080§E)         # 0 or 1 commit, see §E
docs(adr): ADR-080 — operator-observed atmux improvements
```

**§E commit count**: 0 or 1 depending on investigation outcome. If bun-side reproduces the escape bug → 1 fix-commit. If bun-side does NOT reproduce → 0 commits (close §E with the regression-pin fixture as a forward-trip-wire and document outcome in `docs/INVESTIGATION-bash-task-list-json.md`; the fixture itself ships under §D's commit or as a docs-only commit).

ADR doc lands first; impl commits in dispatch order. Suggested wave: §D + §E (smallest, parity-read-impl) → §B1 (parity-state-impl) → §A1 (whip-impl) + §C (up-impl) parallel → §A2 + §B2 (up-impl, blocked on §A1/§B1) last.

## Branch + push policy

- All on `geoyws` (NON-staging — auto-push fine per Push Policy).

## Open questions

- **OQ-A1** [recommended: **`leadCtxRotateThreshold` is per-team, not per-member**] — only the lead has the ctx pressure pattern; non-lead members rotate at uptime only. Override by reply.
- **OQ-B1** [recommended: **`team.gitter.repoPath` defaults to atmux-dir's parent**] — most teams have one repo. Multi-repo teams (rare) override per-team. Override by reply.
- **OQ-C1** [recommended: **BUSY beats MODAL in pattern priority**] — a busy pane showing a modal will self-resolve when the turn completes; MODAL is for steady-state stuck panes. Override by reply.

## Coverage / negative-space

This ADR addresses **rotation policy + kanban hygiene + injection guards + CLI papercuts**. **Not in scope, not orphaned**:

- **Auto-routing protocol (ADR-069 forward-ref)** — sibling-task auto-creation on member-done; design-coupled to §B's hook variant. Defer to its own ADR; §B's lane-tick poll is sufficient for the 29-stale recovery + future demo-week.
- **Member-side ctx rotation** — non-lead members are rotated by lead at lead's discretion; not a programmatic gate. Operator can manually `atmux rotate <member>` per ADR-021.
- **Cross-team auto-done** — same-team only (§B's `repoPath` is per-team). Cross-team commit referencing another team's task is a coordination edge — surface via complaint-box (ADR-077) if observed.
- **Sopx-side fixes** — bash atmux on sopx is sopx-team work; this ADR is bun-side only.

## Dispatch table

| Section | Lane            | Member             | Window | Primary files                                                  | Blocked by |
|---------|-----------------|--------------------|--------|----------------------------------------------------------------|------------|
| §A1     | error-class     | whip-impl          | W5     | `src/schema/team.ts`, `src/verbs/whip.ts:~187`                 | —          |
| §A2     | lifecycle       | up-impl            | W6     | `src/verbs/lane-tick.ts:172-188`                               | §A1        |
| §B1     | state-mutating  | parity-state-impl  | W8     | `src/core/auto-done.ts` (new)                                  | —          |
| §B2     | lifecycle       | up-impl            | W6     | `src/verbs/lane-tick.ts`, `src/schema/team.ts` (gitter block)  | §B1        |
| §C      | lifecycle       | up-impl            | W6     | `src/core/pane-state.ts:69-102`, `src/verbs/lane-tick.ts:163`  | —          |
| §D      | read-only       | parity-read-impl   | W9     | `src/verbs/task.ts:417-484` (parseListArgs)                    | —          |
| §E      | read-only       | parity-read-impl   | W9     | `src/verbs/task.ts:167`, `src/core/kanban.ts` (if repro on bun) | —          |

**Parallel-safe bands**: {§A1, §B1, §C, §D, §E} can dispatch in parallel (no cross-deps). {§A2, §B2} dispatch after their respective §X1 lands. up-impl owns 3 sections (§A2, §B2, §C); §C is independent so up-impl can pick it up first while waiting on §A1 + §B1.
