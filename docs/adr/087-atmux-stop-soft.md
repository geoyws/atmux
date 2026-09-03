# ADR-087: `atmux stop --soft` + resume manifest

**Status**: Accepted (2026-05-15, operator-batch-flip)
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

---

## §D4 — Cron quiescence (amendment, 2026-05-16, t-ccabd763)

**Status**: Accepted (2026-05-16, operator-driven)

**Source**: George 2026-05-16 — *"soft stop has to stop whips that are firing as well in the individual teams if there are whips and loops"*.

### The race §D4 closes

The original §Decision pipeline above defines six steps: capture → notify → grace → manifest → archive → kill-session. The team's marker-fenced cron block is stripped AFTER kill-session (per the post-§Consequences `cron-remove` invocation in `src/verbs/stop.ts`). Between steps 2 and the post-kill `cron-remove`, the whip + watchdog cron lines remain installed:

- `*/15 * * * * ... ATMUX_DIR=<atmuxDir> atmux whip` (default cadence; configurable via `team.whip.intervalMins`)
- `*/1 * * * * ... ATMUX_DIR=<atmuxDir> atmux whip-resume-check` (gated on `team.whip.claudeAccount`)
- `*/2 * * * * ... ATMUX_DIR=<atmuxDir> atmux watchdog` (operator-installed in some teams; not part of the default block)

If a tick lands inside the soft-stop window — typical 5-second grace plus archive plus kill-session latency on a sizeable kanban — the firing tick re-pokes panes that are shutting down / re-spawns dead members / fires Discord pings against a stopping team. Phantom in-progress rows, half-written resume manifests, and post-stop ghost pings accumulate.

### Decision

Add a `quiesceCron({ atmuxDir, crontab?, dryRun?, clock? })` helper to `src/core/soft-stop.ts`. Wire it into `src/verbs/stop.ts` BEFORE the `softStop()` invocation in the `--soft` branch — between the cage probe and the orchestration call.

The helper:

1. Reads the user's crontab via the existing `CrontabIO` abstraction.
2. Walks lines; matches `\batmux\s+(whip|watchdog)\b` (regex word-boundary catches `whip` + `whip-resume-check` + `watchdog`).
3. For each matching line that ALSO carries `ATMUX_DIR=<this-team-atmuxDir>`, prefixes it with `# ATMUX-QUIESCED <epoch> ` — making it a comment-only line cron will ignore.
4. Writes back via the atomic `crontab <tmpfile>` swap.
5. Idempotent: re-runs against an already-quiesced crontab are no-ops (already-tagged lines counted as `alreadySuspended`, no re-write).
6. Non-fatal: crontab unavailable / no installed crontab returns a clean zero result; the verb surfaces a stderr warn and proceeds with soft-stop.

The next `atmux start` re-installs the team's cron block via the existing `cron-install` path, which renders fresh lines without the quiesce comment — no companion `unquiesceCron` is needed for the standard in-block lifecycle.

### Scope is whip + watchdog only

Other team-scoped cron verbs (gitter-sweep / lane-stall-watch / ombudsman-tick / epic-merge-tick / groom / report / decisions-digest / unblocker-tick) are deliberately LEFT running through the soft-stop window. They don't poke panes — they manage trunk state / sweep state.db / fire scheduled audits — and keeping them ticking until the post-kill `cron-remove` does not interact with the panes that are winding down. This matches the Task body's explicit scope and keeps the §D4 patch minimal.

### /loop processes (Claude Code self-scheduled wakeups)

A `/loop` runs as a Claude `ScheduleWakeup` re-invocation: when fired it spawns inside the existing TUI process tree. The TUI dies on `tmux kill-session` (step 6 of the original §Decision pipeline); `/loop` processes die with it implicitly.

A 5-second grace-window race is theoretically possible if a `/loop` interval lands inside the 5s — but the practical floor is `ScheduleWakeup`'s 60s clamp, so any realistic `/loop` cadence (60s–3600s) is >> the grace window. §D4 does NOT add explicit `C-c` pre-kill for `/loop` cancellation — see §D4-OQ1 below for the deferred option.

### Test coverage

`tests/unit/core/soft-stop.test.ts` adds 8 `describe("quiesceCron")` tests:

- happy path (whip + watchdog suspended; unrelated lines untouched)
- other-team isolation (lines with different ATMUX_DIR left alone)
- idempotent re-run (already-quiesced lines stay quiesced; no second write)
- `whip-resume-check` matched via word-boundary regex
- dryRun reports counts without writing
- no crontab installed / crontab unavailable → clean zero, no read attempted
- unrelated verbs (groom / report / decisions / gitter) NOT matched
- crontab structure preservation (marker fence + non-atmux lines + line-count invariance)

### Cron-remove interaction

The existing post-kill `cron-remove` strips the team's whole marker-fenced block, including any quiesced lines that were inside it. Net result with quiesce + cron-remove is identical to cron-remove alone on the in-block path. Operator-managed out-of-block whip/watchdog lines (rare; not part of `cron-install` output) stay quiesced; re-enabling them requires `crontab -e` cleanup.

### Open questions

1. **§D4-OQ1**: Explicit `/loop` cancellation pre-kill — should soft-stop's notify step also send `C-c` to break any in-flight `/loop` wait BEFORE the TUI gets the comment notice? Recommended default: **no, keep implicit teardown** — the 60s `ScheduleWakeup` floor makes the 5s grace-window race vanishingly small, and `C-c` is the bare-`stop` semantics §D4 is deliberately avoiding. Revisit if production logs show a `/loop`-class race post-quiesce. (reversibility: low)
2. **§D4-OQ2**: Move the existing post-kill `cron-remove` invocation EARLIER (pre-softStop) to subsume `quiesceCron`'s scope? Recommended default: **no, keep separate** — `cron-remove` strips the whole block; `quiesceCron`'s narrow whip+watchdog scope leaves the rest of the team's cron lines (groom + gitter-sweep + ...) running through the soft-stop window. Subsuming would also disable those. The two-step shape preserves operator intent. (reversibility: low)

### Refs (§D4 addendum)

- Task kanban entry: t-ccabd763 (claimed 2026-05-16 by up-impl-3)
- Complaint pointer: c-cef89cfd → adjudicated as duplicate-of t-ccabd763 (commit 2ffb9c2)
- `src/core/soft-stop.ts::quiesceCron` — implementation
- `src/verbs/stop.ts` — invocation site (pre-`softStop()` in the `--soft` branch)
- `src/abstractions/crontab.ts` — `CrontabIO` DI surface (re-used)
- historical decision number 053 (no surviving ADR file) — whip advisory locking (eases reaping if explicit `pkill` ever added)
- historical decision number 076 (no surviving ADR file) — per-team cron isolation (scoping via `ATMUX_DIR=<dir>` env marker)
- ADR-083 — `cron-remove` verb (companion post-kill step)
