# ADR-087: `atmux stop --soft` + resume manifest

**Status**: proposed
**Date**: 2026-05-13

## Context

Decomposition of t-b038e1ce (team-of-teams Pillar 5, driver-inbox 2026-05-13
14:03 MYT lines 3071-3073). First ADR in the ADR-087…092 sequence — independent,
smallest scope, foundation for the rest.

### The two failure modes today's `atmux stop` ships

`atmux stop` (today) takes one of two paths:

1. **Bare `stop`** — sends `C-c` to every member pane, sleeps 2s, archives
   `inboxes/` + `kanban.json` + `driver-inbox.md` to `archive/<UTC-ts>/`, then
   kills the session. The `C-c` interrupts whatever the member's TUI was doing;
   a member mid-`atmux done` may have its commit Task dispatched but never
   landed in `gitter`'s pane, leaving staged work uncommitted in the worktree
   and a phantom `in-progress` row in the kanban.
2. **`stop --force`** — skips the `C-c` + 2s grace, jumps straight to archive +
   kill (and per ADR-082 W4 also prunes worktrees when `worktreeIsolation=true`).
   Same uncommitted-work risk, but louder.

Neither path gives operators a *graceful* shutdown: "let in-flight members
finish their current commit, capture WHO had WHAT claimed, then kill the
session — and don't prune the worktrees so I can resume tomorrow."

That graceful path is the foundation for two upcoming features:

- **ADR-090 `dissolve-epic`** — when an epic-team auto-merges, the dissolve
  step needs to (a) stop the epic-team gracefully, (b) prune its worktrees
  AFTER all in-flight work has landed, (c) leave a resume manifest if any
  member couldn't wrap up cleanly. The "stop gracefully + write manifest"
  half is identical to what `--soft` ships.
- **Operator-driven session checkpoints** — George wants to be able to
  `atmux stop --soft <team>`, sleep, and `atmux start <team>` next session
  with a clear "this is where you were" hint surfaced in the start log.
  Today's `atmux start` re-spawns members against the existing kanban, but
  there's no manifest pointing operators at "member X had task Y mid-claim
  when you stopped" — the operator has to grep the kanban themselves.

### Scope boundary vs. existing surfaces

What's already durable across `stop` + `start`:

- Kanban state (`status=in-progress`, `owner=member`) persists in `state.db`.
- Worktrees persist on disk (bare `stop` doesn't prune; only `--force` does).
- Member inboxes (`inboxes/<member>.json` / SQLite `inbox_messages`) persist.

What's lost today:

- The set of members who had in-flight Tasks at stop-time — yes, you can
  reconstruct via `SELECT id FROM tasks WHERE status='in-progress'`, but
  operators (and a future `atmux start` resume hint) want a single
  authoritative manifest with `ts` + `reason` so they can tell "this is the
  state at my last soft-stop" from "this is stale in-progress rot."
- A graceful grace window that lets a mid-`atmux done` cycle complete before
  the session dies.

## Decision

Add an `atmux stop --soft` flag plus a `<atmuxDir>/state/resume.json`
manifest file. Soft-stop is **strictly opt-in** — bare `stop` and `stop --force`
keep today's semantics byte-for-byte.

### Soft-stop pipeline

1. **Capture** — read `state.db` for every task where `status='in-progress'`.
   Build a `ResumeManifest` keyed by member name with the in-flight task id
   + claim timestamp + the member's resolved tmux window name.
2. **Notify** — best-effort `tmux send-keys` of a one-line `# soft-stop
   incoming — finish current operation, no new claims` notice to every
   member pane. Sent as a comment-prefixed line (so TUI compose boxes
   show it but won't auto-submit it). NOT a `C-c` — `C-c` is the interrupt
   semantics of bare `stop`; soft-stop wants the opposite. Skipped when the
   pane is shell-only (`tui ∈ {shell,bash,zsh}`) — there's no TUI to
   notify.
3. **Grace** — sleep `team.softStopGraceSeconds ?? 5` seconds (default 5,
   configurable; bash convention is hardcoded 2s for the `C-c` path —
   soft-stop gets a longer default because the member is finishing, not
   being interrupted).
4. **Write manifest** — atomic write to `<atmuxDir>/state/resume.json`
   (temp + rename). Schema below.
5. **Archive** (same as bare `stop` unless `--no-archive`) — copy
   `inboxes/`, `kanban.json`, `driver-inbox.md` to `archive/<ts>/`. Manifest
   is NOT in the archive — it stays at `state/resume.json` so the next
   `atmux start` can find it.
6. **Kill session** — `tmux kill-session`. No worktree prune. Cron-remove
   fires as in bare `stop`.

### Resume manifest schema

`src/schema/resume.ts` — minimal Zod schema, file format `<atmuxDir>/state/resume.json`:

```ts
export const ResumeManifest = z.object({
  version: z.literal(1),
  ts: z.number().int().nonnegative(),         // epoch seconds at stop time
  team: z.string().min(1),                    // team.name at stop time
  reason: z.enum(["soft-stop", "dissolve-epic"]),  // future-proof for ADR-090
  members: z.array(z.object({
    name: z.string().min(1),
    lastClaim: z.string().nullable(),         // task-id or null
    claimedAt: z.number().int().nullable(),   // epoch seconds or null
    windowName: z.string().nullable(),        // post-ADR-017 form: "🧭lead"
  })),
});
```

Hand-readable, greppable, regenerable. The schema is `.strict()` per
`src/schema/README.md` — unknown keys fail-loud. Bump `version` if the shape
changes.

### `atmux start` resume hook

On every start (not just post-soft-stop), check for `state/resume.json`. If
present:

1. Parse via Zod; on parse failure, log a one-line warn + continue (don't
   wedge `start` on a malformed manifest).
2. After the team comes up, log a `resume:` summary line:
   `resume: M members had in-flight Tasks at <ts> stop — see <path>`
   followed by one line per member with a non-null `lastClaim`:
   `  · <member>: t-xxx (claimed <relative-time-ago>)`
3. **Do NOT auto-restore claims.** The kanban already holds `status=in-progress`
   + `owner=<member>`; members re-bootstrap and see their claim via
   `atmux task list --assignee <self>` on the brief. The manifest is an
   operator-visible hint surface, not a state-replay mechanism.
4. After surfacing, rename the manifest to `state/resume.json.<ts>.consumed`
   so subsequent starts don't re-surface it (manifest is once-consumed,
   keep the renamed copy for forensics).

### Why no auto-replay

Kanban + worktree already cover state. Auto-replay would either be (a) a no-op
(the kanban already says X is in-progress) or (b) wrong (re-issuing an
`atmux claim` against a row already owned by the member is a self-race per
the 2026-05-12 race-condition gate, ADR-029 §F1). The manifest's role is
purely informational: tell the operator "this is the state at my last
soft-stop" so they can sanity-check before letting the team resume work.

## Consequences

- **`src/verbs/stop.ts`** — new `--soft` flag in `parseStopArgs`. When set,
  delegate to `core/soft-stop.ts::softStop`. Hard-stop paths untouched.
- **`src/core/soft-stop.ts`** — new module exporting `softStop({team, tmux,
  atmuxDir, ...})` for re-use by ADR-090 `dissolve-epic`. Pure orchestration
  function — its callers compose tmux + kanban deps so unit tests can run
  without spawning a real session.
- **`src/schema/resume.ts`** — new Zod schema, `.strict()`, `version: 1`.
- **`src/verbs/start.ts`** — new resume-hint surface after step 10 (record
  start timestamp). Reads `state/resume.json` if present; logs the summary;
  renames the consumed manifest.
- **`src/verbs/help.ts`** — `stop [--force|--soft]` USAGE update.
- **`team.softStopGraceSeconds`** — new optional `Team` schema field
  (default 5). Reviewer note: `src/schema/team.ts` is `.passthrough()` today,
  so adding the field is forward-compatible.
- **Tests** — `tests/unit/core/soft-stop.test.ts` covers the manifest write
  + grace + per-member notify (mock tmux + clock); `tests/e2e/stop-soft.test.ts`
  exercises the full path against a real tmux socket + verifies the resume
  hint surfaces on subsequent `start`.

## Rollback

Pure-additive. Bare `stop` and `stop --force` keep their semantics; existing
e2e (`tests/e2e/lifecycle.test.ts` beats 7-8) cover them byte-for-byte. The
new manifest file is only ever written when `--soft` is passed; absence is
a no-op in `start`. Setting `softStopGraceSeconds: 0` collapses the grace
window to a single tick but doesn't disable the feature. Reverting the commit
removes the verb path + the schema; the manifest file (if any operator already
wrote one) is ignored by old `start` since the resume hook is in the new
commit.

## Open questions

1. **OQ1**: Should `--soft` also archive state? Recommended default —
   **yes, same as bare `stop`** — archives are cheap, operators expect
   them, and the soft path doesn't add risk. `--no-archive` works on
   either path. (reversibility: low)
2. **OQ2**: Should the per-member notify line be configurable? Recommended
   default — **hardcoded** — keep the soft-stop signal uniform across teams
   so members' bootstrap briefs can match against it later if we want
   structured handoff. (reversibility: low — easy to grow the team.json
   field if demand surfaces)
3. **OQ3**: Should the manifest carry `worktree paths`? Recommended default
   — **no** — paths are deterministic from `resolveWorktreePath(team, member,
   atmuxDir)`, so storing them is pure noise. If ADR-090 dissolve-epic
   needs worktree state captured at stop-time (post-merge), that's a v2
   field. (reversibility: low)

OQ1+OQ2+OQ3 all reversibility:low; recording inline per ADR-085 §"Open
questions" precedent rather than blocking on `atmux decisions add`.

## Refs

- Parent kanban entry: t-b038e1ce (claimed 2026-05-13 by up-impl-2)
- driver-inbox §Pillar 5 — Soft shutdown (14:03 MYT 2026-05-13)
- ADR-082 W4 — worktree prune (deliberately NOT triggered on soft-stop)
- ADR-090 (future) — dissolve-epic, will re-use `core/soft-stop.ts`
- CLAUDE.md §Docs Discipline — ADR-first, same-commit doc updates
- `src/verbs/stop.ts:136-206` — hard-stop pipeline (modification site)
- `src/verbs/start.ts:660-690` — resume-hint insertion site (after step 10)
- `src/schema/team.ts` — `softStopGraceSeconds` field (additive)
