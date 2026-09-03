# ADR-267: Durable agent-continuity contract — plan/intent is written as you go, not captured on the death-bed

**Status**: superseded by [ADR-289](289-kb-authoritative-agent-continuity.md)
**Date**: 2026-08-06
**Superseded by**: [ADR-289](289-kb-authoritative-agent-continuity.md)
**Driver-ref**: operator-direct 2026-08-06 — "i need atmux to track plans and todos so that they're never lost even if agents run out of tokens and then another agent can easily take the previous agent's place… i need agents to always use atmux as a way to track todos and to update work done and to keep all plans and intents in atmux". Follow-up: "atmux is meant to assist in agentic dev."
**Cross-refs**: [ADR-007](007-pull-kanban.md) (pull-based kanban — the mechanism by which a fresh agent takes over; this ADR adds the payload it takes over WITH), [ADR-126](126-sqlite-state-store.md) (SQLite state store — the durable substrate `task_notes` joins), [ADR-008](008-decisions-verb.md) (`.atmux/decisions.md` standing-decision log — the retention precedent D1 copies), [ADR-009](009-auto-rotation.md) (auto-rotation on context pressure — the threshold D4 hooks), [ADR-139](139-refusal-pattern-auto-rotate.md) (refusal-pattern auto-rotate — the second rotation trigger D4 must cover), [ADR-167](167-cockpit-rotate-verb.md) (`atmux cockpit rotate` — the third rotation entry point), [ADR-193](193-restore-task-add-epic-story-deliverable-flags.md) (`task add --epic/--story/--deliverable` — the last change to the Task-authoring surface; D1 extends the same verb family), [ADR-263](263-merge-session-preclear-into-handoff.md) (session `preclear` merged into `handoff` — `handoff` is now the single phase-boundary verb D4 amends), [ADR-131](131-superdoctor-kanban-hygiene.md) (kanban-hygiene detector family + `superdoctor_hygiene` table — D2's enforcement seam; this ADR is the amendment that adds a sixth fingerprint class), [ADR-260](260-manual-orchestration-mode-default.md) (manual orchestration is the fleet default — why D4 adds no ticker), [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) / [ADR-237](237-no-llm-discord-and-whip-removal.md) (cron surface retired; no time-driven LLM cycles — why D4 arms no cron. **Both are `Status: proposed` as of 2026-08-06**, so D4(c) and §Out of scope cite them as the standing operator position, not as ratified law), [ADR-192](192-cron-arm-idempotency-contract.md) (cron-arm idempotency — moot here, no arm is created), [ADR-203](203-event-topic-taxonomy.md) (closed topic set — deliberately NOT amended), [ADR-010](010-atmux-flag.md) (member→lead structured surfacing — the escalation path a `plan-missing` finding rides. **Accepted, but the `atmux flag` verb is NOT wired in `src/cli.ts` as of 2026-08-06**; the live surface is the `.atmux/flags.md` file contract — see the caveat block in D2), [ADR-214](214-retire-ombudsman-lead-absorbs-complaint-adjudication-via-honker.md) (lead-gated adjudication — the human end of that path), [ADR-033](033-kanban-driver-only-flag.md) (`driverOnly` — the precedent for a claim-time refuse-gate, and why D2 deliberately does NOT add a second one), [ADR-082](082-worktree-isolation-per-member.md) / [ADR-084](084-worktree-per-member-branch-model.md) (per-member worktrees + branches — the concurrency model that makes read-modify-write on a shared field a clobber hazard), [ADR-137](137-merge-over-rebase.md) (merge, never rebase — the sibling "don't rewrite shared history" instinct D1 applies to Task bodies), [ADR-212](212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md) (Medic narrowed to on-demand — why the hygiene detectors are invoked by a verb, not a role), [ADR-266](266-shim-sunset-policy-and-first-sweep.md) (shim-sunset policy — the discipline that keeps `tasks.note` from becoming permanent dead weight)

Historical note: read ADR-289 for the current continuity contract. D1-D4 below are preserved for trace only.

**Requirement scope**: this ADR addresses **R1 (continuity)** only, of the three requirements in the operator's 2026-08-06 ask. The other two are filed as their own same-day ADRs, both on disk as of 2026-08-06 and both linked here:

- **R2 — host-repo cleanliness** (atmux artifacts stay out of the managed product repo's git history) → [ADR-268](268-managed-repo-state-isolation-enforcement.md).
- **R3 — recursive branch ledger** (record which branch every repo in a monorepo is on) → [ADR-269](269-recursive-branch-ledger.md).

All three carry `Status: proposed` and all three have rows dated 2026-08-06 in [docs/adr/INDEX.md](INDEX.md). The numbers were pinned before authoring and held; had a sibling EPIC fanned in and taken 267 first, the renumber-and-record procedure is the one used for the 2026-05-23 ADR-225/226 collision.

## Context

The operator's problem is not that kanban rows are lost. It is that the **reason** for the rows is lost. Those are two different durability stories in atmux today, and only one of them holds.

### What already survives an agent's death (verified 2026-08-06)

- **Rows are on disk, by construction.** Kanban lives in SQLite at **`.atmux/state.db`** per [ADR-126](126-sqlite-state-store.md) — the DB file sits directly under `.atmux/`, **not** at `.atmux/state/state.db`. The path is derived by `_stateDbPath()` as `join(atmuxDir, "state.db")` (`src/core/kanban.ts:88-90`); `.atmux/state/` is a sibling directory holding per-feature JSON (budget probes, brief versions, debounce markers) and contains no SQLite file. Verified on disk 2026-08-06: `.atmux/state.db` is 6,033,408 bytes and `ls .atmux/state/ | rg 'db$|sqlite'` returns nothing. The `tasks` table is created in the v0→v1 rung of `src/abstractions/sqlite-migrations.ts` (lines 27–49) with `subject` / `body` / `status` / `owner` / `deps` / `priority` / `epic` / `story` / `lane` / `deliverable` / `claimed_at` / `note` / `extra`. An agent losing its pane, its context, or its token budget does not touch a row.
- **A replacement can self-serve the work.** The pull model ([ADR-007](007-pull-kanban.md)) means a fresh agent runs `atmux claim --next --as <member>` and gets the next claimable Task with no dispatch and no operator in the loop. `templates/briefs/member.md:138` also tells a rotated member that an in-progress Task it already owned survives the rotation with `owner` intact, so re-claim is the normal path.
- **Standing decisions are logged.** `.atmux/decisions.md` ([ADR-008](008-decisions-verb.md)), bounded by `atmux groom`'s `archiveDecisions` sub-op (`src/core/groom.ts:498-660`, threshold `--decisions-days`, default 30 at `src/verbs/groom.ts:94`).

### What does NOT survive — the hole this ADR closes

**1. atmux's only narrative-capture mechanism is death-bed and best-effort.** `atmux handoff <from> <to>` (`src/verbs/handoff.ts`) captures the plan prose in two phases, and both degrade at exactly the moment the operator cares about:

- **Phase 1 — native ask.** When the source window still exists, `handoff` sends the source pane a prompt asking for a ≤50-line summary (`buildHandoffNoteAsk`, `src/verbs/handoff.ts:137-143`) and polls for the file for `ATMUX_HANDOFF_WAIT` seconds, **default 30** (`resolveWaitSeconds`, `src/verbs/handoff.ts:360-371`; poll loop `pollForFile`, `:313-327`). This requires the dying agent to be *able to take a turn*. An agent that is out of tokens, rate-limited, or context-dead cannot: it is precisely the agent that will not answer within 30s.
- **Phase 2 — scrollback fallback.** On a poll miss, `handoff` writes a `tmux capture-pane` tail of `ATMUX_HANDOFF_LINES` lines, **default 500** (`resolveCaptureLines`, `:373-385`; capture + write at `:451-477`). 500 lines of raw pane output is not a plan. It is the raw material a plan would have been distilled from, minus the distillation.
- **Phase 3 — the stub.** When the source window is already gone, `buildAbsentSourceNote` (`:184-197`) writes a five-field header and the literal text `(no pane to capture)`. Zero narrative.
- And in every one of those three cases, **step 3 still runs**: `migrateTasks` (`:490`) hands the in-progress rows to the replacement regardless. So the replacement reliably inherits the *work* and unreliably inherits the *plan*. That asymmetry is the operator's complaint, stated mechanically.

**2. Two disjoint handoff artifacts exist, and the resume path reads the wrong one.** `atmux handoff` writes to `join(atmuxDir, "handoff")` — i.e. `.atmux/handoff/<from>-to-<to>-<ts>.md`, **singular `handoff`**, `src/verbs/handoff.ts:414-416` (verified on disk 2026-08-06: `.atmux/handoff` exists; `.atmux/handoffs` does not). But `/atmux:session cont`, the skill a fresh agent actually runs to orient itself, reads a **different** file: `~/.claude/projects/<project-slug>/todo/<branch>/handoff.md` (`plugins/atmux/skills/session/SKILL.md:31-39`, Step 1 at `:120-130`). Neither path probes the other. So the verb that captures the dying agent's narrative and the skill that resumes from a narrative are writing to and reading from disjoint locations.

**3. There is no append-only progress-note seam — so incremental "here is what I just learned / what I am about to do" has nowhere cheap to go.**

- `atmux task update --body <text>` **replaces** the body: parsed at `src/verbs/task.ts:376-387`, applied at `:498-500` as `setTaskBody(atmuxDir, id, body.length === 0 ? null : body)`. An empty `--body ""` **clears** it. `USAGE_UPDATE` (`src/verbs/task.ts:70-71`) offers `--body` / `--deps` / `--owner` / `--unassign` / `--epic` / `--story` / `--deliverable` — and no `--note`, no `--append`.
- `--note` exists on **other** verbs but not on `task update`: `atmux done <id> --note <text>` (`src/verbs/claim.ts:68`, applied at `:319` via `markTaskDone`), `atmux member status <s> --note <text>` (`src/verbs/member.ts:1065`, `:1188`), and `atmux ombudsman work --note`.
- Every one of those existing `--note` sinks is **last-write-wins, not a log**. `tasks.note` is a single scalar TEXT column (`src/abstractions/sqlite-migrations.ts:46`); `markTaskDone` assigns it wholesale (`src/core/kanban.ts:1151-1174`) and `markTaskBlockedWithNote` (reached via `src/verbs/member.ts:1175-1179`) overwrites the same slot. `writeMemberStatus` is an `atomicWrite` of one JSON file per member (`src/core/member-status.ts:61-79`) — the second report erases the first.
- Verified absent 2026-08-06: `rg` across `src/verbs/*.ts` and `src/cli.ts` for `task note`, `append-body`, `appendBody` returns nothing. There is no append surface at all.
- The only way to append today is read-modify-write on `tasks.body`, which is the shared-state clobber class the per-member worktree model ([ADR-082](082-worktree-isolation-per-member.md) / [ADR-084](084-worktree-per-member-branch-model.md)) exists to avoid elsewhere: two lanes appending concurrently means the later writer silently discards the earlier one, with no conflict and no signal.

**4. Nothing detects a Task being worked without a recorded plan.** The reviewer gate blocks code-without-tests and code-without-doc-update (project `CLAUDE.md` §Binding discipline 3). There is no equivalent for "claimed a Task, wrote code, never recorded what the plan was." The obligation exists only as prose in `CLAUDE.md` and `templates/briefs/member.md`, with zero measurement.

### The inversion this ADR makes

Today the durable-plan story is: *hope the dying agent gets one last turn.* This ADR makes it: **plan and intent are written incrementally to `state.db` while the agent is healthy, and `atmux handoff`'s capture becomes a bonus.** The measurement of success is not "handoff produced a good file" — it is "an in-progress Task carries enough recorded intent that a cold agent resumes it without reading pane scrollback."

## Decision

### D1 — `atmux task note`: an append-only progress-note seam backed by a `task_notes` table

**Surface** (new subverb on the existing `task` verb family, `src/verbs/task.ts`):

```
atmux task note <task-id> "<text>" [--as <member>] [--kind plan|progress|blocker|decision|done] [--team-dir <dir>]
atmux task notes <task-id> [--limit N] [--json]        # read-only convenience; `task show` also carries them
```

`--kind` defaults to `progress`. `--as` resolves the author the same way `atmux claim` / `atmux done` already do (`$ATMUX_MEMBER` when unset — `templates/briefs/member.md:6-25` makes that env var the authoritative member identity). The verb is **append-only by construction**: there is no `task note --edit`, no `task note --rm`. Correcting a wrong note means appending a corrective note, exactly as [ADR-137](137-merge-over-rebase.md) forbids rewriting shared history rather than offering a safer rewrite.

**Rejected alternative, named so a future reviewer does not re-propose it: `atmux task update --append-body`.** Three reasons:

1. **Clobber hazard.** Appending to `tasks.body` is read-modify-write on a shared field. Under per-member worktrees and epic-team shared worktrees, two lanes appending concurrently produce a silent last-writer-wins loss — the same failure class that motivated [ADR-082](082-worktree-isolation-per-member.md)'s isolation and that the project's own working notes record as a repeated real-world regression. An `INSERT` into a child table has no such window.
2. **`tasks.body` is the Task's SPEC, not its diary.** `templates/briefs/member.md:94-100` instructs every member that the body carries acceptance criteria, file paths and out-of-scope notes; the mandatory `**ADR**: docs/adr/NNN-*.md` perusal line is a separate rule stated at `templates/briefs/member.md:43` ("read named ADRs in the Task body BEFORE `atmux claim`, not after"). Interleaving running commentary into that destroys the artifact the *next* agent must read first. Spec and log are different documents with different lifetimes.
3. **A note needs an author and a timestamp.** A single TEXT column cannot carry them without inventing an in-band parse format, and in-band formats rot. Columns do not.

**Storage — new `task_notes` table**, appended to the migration ladder in `src/abstractions/sqlite-migrations.ts`. The highest landed rung as of 2026-08-06 is `from: 16, to: 17` (`issue_sync` + `issue_sync_cursor`, `src/abstractions/sqlite-migrations.ts:811-844`, per [ADR-261](261-issue-sync-external-tracker-ingestion.md)), so the natural rung is `from: 17, to: 18` — but **this ADR does not pin the number.** If a sibling ADR lands a rung first, take the next free one; the ladder is append-only and monotonic (that file's header §: "New migrations append-only; never edit a landed migration's `up` body"), and re-deriving the rung at implementation time is one `rg` away.

Indicative shape (implementation fixes the exact DDL; `STRICT` per the house posture used by every recent table):

```sql
CREATE TABLE task_notes (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,  -- append order, monotonic per DB
  task_id    TEXT NOT NULL,
  author     TEXT NOT NULL,                      -- member id (immutable ASCII id, not label — ADR-136)
  kind       TEXT NOT NULL DEFAULT 'progress',   -- free-form TEXT, no CHECK (house passthrough posture)
  body       TEXT NOT NULL,
  created_at_sec INTEGER NOT NULL,
  extra      TEXT                                -- JSON; passthrough for unknown fields
) STRICT;
CREATE INDEX idx_task_notes_task ON task_notes(task_id, created_at_sec);
CREATE INDEX idx_task_notes_kind ON task_notes(task_id, kind);   -- D2's detector hot path
```

`kind` is a **free-form column with a verb-layer allowlist** — same split the tree already uses for `complaints.source_kind` ([ADR-261](261-issue-sync-external-tracker-ingestion.md) §D3: "The DB column is free-form TEXT by design, so no migration; the allowlist append is verb-layer + documented-surface only"). A future `kind` literal costs a verb-layer edit, never an `ALTER`.

Repository access follows `src/core/repositories/` (siblings: `kanban-repo.ts`, `complaints-repo.ts`, `hygiene-repo.ts`, `spawn-queue-repo.ts`). No direct SQL from verbs.

**`tasks.note` is NOT migrated, deprecated, or touched.** It remains the last-write-wins *closing* note that `atmux done --note` and `markTaskBlockedWithNote` write. Breaking `atmux done`'s documented surface buys nothing. Instead: **`atmux done --note` and `atmux member status blocked --note` additionally append a `task_notes` row** (kind `done` / `blocker`) so the log is complete without the caller changing anything. Both writes land in the **same** `state.db` inside one transaction, so unlike [ADR-261](261-issue-sync-external-tracker-ingestion.md) §D4's cross-DB case there is no crash window to repair. Per [ADR-266](266-shim-sunset-policy-and-first-sweep.md)'s discipline, the dual-write is a permanent design choice rather than a shim, so it carries no sunset date — but if `tasks.note` is ever collapsed into `task_notes`, that is a future ADR, not a silent cleanup.

**Rendering.** `atmux task show <id>` today prints the raw task object as JSON (`src/verbs/task.ts:568-582` → `JSON.stringify(t, null, 2)`). It gains a `notes` array, **oldest-first**, so the chronology reads as it was written. Additions only — every existing field keeps its name and position semantics. `--notes-limit N` truncates from the **newest** end backwards (a resuming agent wants the most recent state, and the `plan` note is separately surfaced first regardless of the limit). `atmux task list` is unchanged; a per-row note count would widen a table that is already six columns.

> **Known hazard, made more visible rather than newly created:** `atmux task show` has no `--json` flag and its stdout was never a valid `atmux task update --body` payload — round-tripping it has previously wiped a Task body. Adding `notes` does not create a new break, but implementation MUST verify no script under `scripts/` parses `task show` output positionally. Untested as of 2026-08-06 — verify.

**Retention / bounding.** An append-only log is unbounded by construction, so it gets bounded the same way the rest of `state.db` already is. `atmux groom` documents **eight** idempotent sub-ops — numbered `1a`, `1b`, `2`–`8` in its own usage text (`src/verbs/groom.ts:285-305`). (The "five idempotent sub-ops" line in the module header at `src/core/groom.ts:6` is **stale** — it predates sub-ops 6–8, and the implementing commit fixes that comment since this ADR relies on the count.)

**The retention leg attaches to sub-op 8 (`groomArchive`), not to `summarizeKanban`.** This is the load-bearing correction, so the reasoning is stated in full:

- `summarizeKanban` (`src/core/groom.ts:692`) is **a no-op on every SQLite team.** It resolves `kanbanJsonPath(atmuxDir)` and returns `{ removed: 0, destPaths: [] }` when that file is absent (`src/core/groom.ts:701-702`). Post-[ADR-126](126-sqlite-state-store.md) teams have no `kanban.json` — verified 2026-08-06 in atmux's own `.atmux/`, which carries only a stale `kanban.json.lock`. Pairing the notes flush with it would ship a retention leg that never runs.
- The sub-op that actually **deletes `tasks` rows** is `groomArchive` — sub-op 8, opt-in via `--archive`, invoked last with `days: parsed.kanbanDays` (`src/verbs/groom.ts:677-681`). It `ATTACH`es `archive.db` to the `state.db` connection and, inside one `transact()` (`src/core/groom-archive.ts:134`), runs `INSERT OR IGNORE INTO archive.tasks SELECT * FROM main.tasks WHERE status='done' AND completed_at IS NOT NULL AND completed_at < <cutoff>` (`:140`) followed by the matching `DELETE FROM main.tasks` (`:146`).
- Therefore: **`task_notes` rows move inside `groomArchive`'s existing ATTACH transaction, keyed on `task_id`, in the same transaction as the `tasks` delete.** `INSERT OR IGNORE INTO archive.task_notes SELECT * FROM main.task_notes WHERE task_id IN (<the same archived-task selection>)`, then `DELETE FROM main.task_notes` on the same set. Anchoring anywhere else orphans the notes: once a Task row leaves `main.tasks`, its notes have no parent row left to join `completed_at` against, so they would be neither archived nor deleted — unbounded forever, which is the exact property this paragraph claims to bound, and `archive.db` would hold tasks with no notes.
- **No schema work in `archive.db`.** `groomArchive` materialises the archive schema through the same migration ladder before attaching (`src/core/groom-archive.ts:103-104`), so D1's new `task_notes` rung creates the archive-side table automatically.
- **Threshold: reuse `--kanban-days`** (default 30 — constant at `src/verbs/groom.ts:93`, help row at `:271`) — the same cutoff `groomArchive` already uses — rather than minting a **fifth** numeric threshold flag. There are four today: `--inbox-days`, `--kanban-days`, `--decisions-days`, `--keep-bak` (`src/verbs/groom.ts:91-95`, help rows `:263` + `:271-273`). The notes and the Task they annotate must archive together or the archive is incoherent, which is a second reason the two moves belong in one transaction rather than in two sub-ops with independent thresholds.
- **Hard invariant: notes on a Task that is NOT `done` are never archived, at any age.** This falls out of the anchoring for free — `groomArchive`'s selection is already `status='done' AND completed_at IS NOT NULL AND completed_at < cutoff`, so reusing that selection makes the invariant structural rather than a rule someone must remember. An in-progress Task's notes are the load-bearing resume payload; archiving them re-opens the exact hole this ADR closes. This is the one rule in D1 that a "make groom more aggressive" change may not relax.
- **Honest limit: `--archive` is opt-in, so the flush is opt-in too.** Sub-op 8 runs only when `--archive` is passed (`src/verbs/groom.ts:677`). On a team that never passes it, `task_notes` grows for the DB's lifetime and the only brakes are the per-Task soft cap below and `--notes-limit` on the read side. That is a real ceiling, not a hidden one — see OQ-8.
- The prose-side precedent this copies is `archiveDecisions` (stale `### d-<id>` blocks → `archive/decisions-<YYYY-MM>.md`, `src/core/groom.ts:498-660`, threshold `--decisions-days`). It is cited as the *pattern*; the notes flush is a row move, not a markdown flush, so it lives in `src/core/groom-archive.ts` rather than `src/core/groom.ts`.
- **Per-Task soft cap.** `atmux task note` prints a non-fatal warning above N notes on one Task (recommend **50**) so a looping agent surfaces instead of silently ballooning `task show`. Warning only — never a refusal, because refusing the append is refusing the durability. Untested — verify 50 against real per-Task note counts before pinning it.
- `docs/RUNBOOK-grooming.md` documents the extended `--archive` behaviour (tasks **+ their notes**) in the same commit, and `src/verbs/groom.ts`'s own sub-op-8 usage line (`:305`) updates from "tasks + inbox_messages" to "tasks + task_notes + inbox_messages" — both are documented surfaces per project `CLAUDE.md` §Binding discipline 2.

### D2 — The claim→plan obligation, enforced as a detectable proxy and never as a hard block

**The obligation.** On claiming a Task, before the first code edit, the claiming agent records its intended approach:

```
atmux task note <task-id> --kind plan "<intended approach>"
```

**Content contract** — three bullets, ≤15 lines, pointers not prose:

1. **The approach** — the files/functions to touch, named. `src/core/foo.ts::bar` beats "the parsing layer".
2. **The falsifier** — the specific check that will prove it worked (the test name, the command, the observable). This is the field that makes the note resumable rather than decorative.
3. **The re-verify** — the one thing a replacement should re-check before trusting the note, because it may have gone stale.

**Where the instruction lives.** `templates/briefs/member.md` §Your loop (`:86-112`) gains the plan note as a step between "read the Task body" (`:94-100`, whose mandatory `**ADR**:` perusal rule is stated at `:43`) and starting work. `templates/briefs/member.md` is the base brief that the alias map falls back to, so it is the binding text.

**Role briefs that carry their own loop section need the identical paragraph in the same commit** — a brief amendment that lands in the base brief and not in an overrider is a silent no-op for every member reading the overrider. **The set is derived at implementation time, not hand-listed here**, because a hand-list rots as briefs are added or renamed (there are 15 briefs in `templates/briefs/` as of 2026-08-06). The derivation is two filters:

1. `rg -l '## Your loop' templates/briefs/` — the briefs that own a loop. On 2026-08-06 that returns ten: `committer.md`, `devops.md`, `enforcer.md`, `lead.md`, `member.md`, `merger.md`, `planner.md`, `reviewer.md`, `team-lead.md`, `unblocker.md`.
2. **Minus the never-claim roles**, for whom a claim→plan paragraph is inert by construction: `enforcer.md:105` and `unblocker.md:88` both state `atmux claim` is `✗ — never claim`, and `lead.md:69` / `team-lead.md:69` both state the role "never claims tasks".

That leaves the six briefs whose holders actually reach `in-progress` on a Task: `member.md`, `committer.md`, `devops.md`, `merger.md`, `planner.md`, `reviewer.md`. **`templates/briefs/dba.md` is deliberately NOT in the set** — it has no `## Your loop` section at all (its headings are §0 Identity check, Core commands, What you do, What you DON'T do, Authz + tenancy checklist, State files), so there is no loop for a paragraph to override; giving `dba.md` a loop section is its own follow-up, not this ADR's.

**One stale line the same commit must fix.** `templates/briefs/member.md:138` — the rotation re-claim paragraph D3 step 1 and D4(a) both hang off — still reads "status persists in `kanban.json` across rotations". That has been wrong since [ADR-126](126-sqlite-state-store.md): status persists in `.atmux/state.db`. The sentence is otherwise correct and load-bearing for this ADR, so it is corrected in the same commit that adds the checkpoint line to it.

**The trigger: `atmux claim` prints the reminder on stdout** (promoted out of an open question into a decision on 2026-08-06, because it is the one zero-cost trigger sitting at the exact moment the obligation attaches). Both claim paths already write a one-line confirmation to stdout — `src/verbs/claim.ts:212` for `atmux claim <id>` and `:287` for `atmux claim --next` — so this is one appended line at each, immediately after the existing `<who> claimed <id>` line:

```
  next: atmux task note <id> --kind plan "<approach / falsifier / re-verify>"
```

**Zero enforcement.** It is a print, not a gate — nothing checks that the agent complied, and the exit code is unchanged (see the NOT-a-hard-block reasoning below, which this does not weaken). It lands the instruction where the agent is already looking, which is strictly better than relying on the agent having read a brief section N turns earlier. Cost is one line of stdout and no state. The wording is verb-layer text, so refining it later is not an ADR.

**"Non-trivial" is operationalised away, not judged.** A judgment call about which Tasks deserve a plan is a judgment call every agent will resolve in its own favour. So: **every Task that reaches `in-progress` is plan-obligated.** An agent that considers a Task trivial writes a one-line plan note saying exactly that (`"trivial: one-line fix in src/x.ts:42, verified by existing test y"`). That costs on the order of 15 tokens and removes the judgment entirely.

**Enforcement strength — stated honestly.** atmux cannot force an agent to think. It can only detect the absence of the artifact that thinking produces. So:

**NOT a hard block.** `atmux claim` and `atmux task move <id> in-progress` are **not** gated on the presence of a plan note. Three reasons, all load-bearing:

1. **A claim-gate is self-defeating by Goodhart.** A gate that requires a note is satisfied by any note. Making the measurement the thing to be produced is the same move as raising a coverage threshold to meet coverage — the gate goes green because the measurement was satisfied, not because the underlying thing became true. A soft signal that is honestly weak is worth more than a hard gate that is trivially gamed.
2. **Blocking a claim wedges the pull model.** [ADR-007](007-pull-kanban.md)'s whole point is that a member never waits. A member that cannot claim goes dormant, and a dormant member is strictly worse than an unplanned claim: unplanned work still ships something reviewable. [ADR-033](033-kanban-driver-only-flag.md) added the tree's one claim-time refuse-gate deliberately and narrowly, for a *safety* property (driver-fires Tasks). A second gate for a *documentation* property does not earn the same power.
3. **Some claims happen before any agent is in the loop.** `atmux claim --next` fires from the first-turn bootstrap keystroke (`templates/briefs/member.md:82` explicitly rules that first auto-claim legitimate) and from lane-tick paths. There is no agent present to author a note at that instant, so a gate there would refuse a claim that is by design correct.

**The detectable proxy.** A new detector in the existing kanban-hygiene family ([ADR-131](131-superdoctor-kanban-hygiene.md)):

- **File**: `src/core/superdoctor-hygiene/plan-missing.ts`, alongside `ghost-owner.ts` / `lane-mismatch.ts` / `role-mismatch.ts` / `lane-null-orphan.ts` / `prio-null.ts`.
- **A sixth `HygieneFingerprintClass` literal `"plan-missing"`.** `src/core/superdoctor-hygiene/_shared.ts:37-42` hard-codes five, and its comment at `:34-36` says so verbatim ("The five fingerprint classes from ADR-131 §D2"). **This ADR is the amendment that makes it six**; the comment updates in the same commit, which is what [ADR-131](131-superdoctor-kanban-hygiene.md)'s own hard-coded-enum rationale ("typos surface at compile time") is designed to force.
- **Drained by the existing loop** — `atmux hygiene-tick` (`src/verbs/hygiene-tick.ts` → `drainTick`), persisted to the existing `superdoctor_hygiene` table (`src/abstractions/sqlite-migrations.ts:234-247`, PK `(task_id, fingerprint_class)`, partial index on unfixed rows). **No new migration for the finding itself** — only D1's `task_notes` rung is new. Invocation is verb-driven, not role-driven, per [ADR-212](212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md)'s narrowing of Medic to on-demand.
- **Trip condition — all three, AND:**
  1. `tasks.status = 'in-progress'`;
  2. zero rows in `task_notes` for that `task_id` with `kind = 'plan'`;
  3. `nowSec - tasks.claimed_at > planGraceSec`.
- **`planGraceSec` recommend 900 (15 min)** — long enough that a plan note written a minute into the claim never trips it, short enough that a whole rate-limit window does not elapse unrecorded. The age-gate-then-dedup shape mirrors `decideLaneStall`'s `laneStallMinAgeSec` gate (`src/core/lane-stall.ts:172-180`), so the pattern is already reviewed. Untested — verify against real claim→first-note latency before pinning.
- **`proposedFix` is ALWAYS `{ kind: "escalate", reason: … }`** (`src/core/superdoctor-hygiene/_shared.ts:48-52`). There is deliberately no auto-fix: the missing artifact is judgment, and a machine-authored plan note would be a lie in the file that a replacement agent trusts most. `severity` sits at the family's low end and `confidence: "medium"` — an agent may legitimately have recorded its intent in a commit message instead. **This is by design the weakest finding in the family: it reports an absence, it does not allege misconduct.**
- **Explicitly NOT in v1: the "code diff with zero notes" variant.** The hygiene detectors read the kanban, not git — correlating a diff to a Task needs a git read the family does not do (`src/verbs/doctor/git.ts` is the only probe that shells git today). Recorded as OQ-6, not shipped.

**Reviewer leg — one line, and it is a comment, not a block.** A code-changing commit whose Task has zero `plan` notes earns a reviewer comment. It does **not** join code-without-tests and code-without-doc-update as a fail-state. Adding a third blocking condition — for a soft artifact, on top of two hard ones — devalues the two that are load-bearing. Escalation beyond the comment rides the path that already exists: hygiene finding → an entry in `.atmux/flags.md` → lead adjudication ([ADR-214](214-retire-ombudsman-lead-absorbs-complaint-adjudication-via-honker.md)). **No new event topic** — [ADR-203](203-event-topic-taxonomy.md)'s closed set is untouched.

> **Docs-vs-code gap the implementation must route around, recorded rather than glossed.** [ADR-010](010-atmux-flag.md) is `Status: accepted` and specifies an `atmux flag` verb — **but that verb is not wired in atmux-bun as of 2026-08-06.** Verified: `grep -n -i 'flag' src/cli.ts` returns nothing, and there is no `src/verbs/flag.ts`. What IS live is the **file** contract:
> - **Writers** append markdown to `<atmuxDir>/flags.md` directly, precisely because the verb never ported — `src/verbs/lane-drift-check.ts:434-439` says so in its own comment ("Once the `flag` verb ports, this default can wire into it for severity / dedup / Discord ping"); `src/verbs/merge-cycle.ts:119` and `src/verbs/merge-member.ts:124-130` follow the same convention.
> - **Readers** consume it as blocker surface 6: `readOpenFlagsMd` (`src/core/blockers.ts:377-386`), aggregated by `queryAllBlockers` (`:557`).
>
> So the surfacing leg writes `.atmux/flags.md`, following the `lane-drift-check` precedent. **One shape constraint, because it decides whether the entry is actually read:** `readOpenFlagsMd` matches `### f-XXXXXXXX <member> [pN/<needs>] (HH:MM MYT)` headers and treats a flag as open until a `### r-XXXXXXXX f-YYYYYYYY` resolution header references it (`src/core/blockers.ts:379-395`). The three existing writers append plain `- <body>` bullets, which that parser does not lift into a `BlockerRow`. Implementation MUST emit the `### f-` header form, or the finding lands in a file nobody's aggregator reads — the precise failure this ADR's §Consequences warns about. Untested against a live `flags.md` as of 2026-08-06 — verify. Porting `atmux flag` itself is [ADR-010](010-atmux-flag.md)'s unfinished business and explicitly not in this ADR's scope.

### D3 — The resume contract, stated as a testable invariant

**Invariant (this is the acceptance criterion for R1):**

> **Every Task in status `in-progress` carries at least one `task_notes` row of `kind = 'plan'`, so a cold agent can resume it without reading pane scrollback.**

That is directly measurable, and D2 is its measurement: the invariant holds for a team exactly when `atmux hygiene-tick` reports **zero** `plan-missing` findings. It is a count, not a percentage — there is no threshold anyone can loosen to make it green.

**The ordered sequence a replacement agent runs.** Every verb below exists today except `atmux task note` / the `notes` field in `task show` (D1):

1. `atmux claim --next --as <member>` — or simply re-read the Task already owned in `in-progress`, which survives rotation ([ADR-007](007-pull-kanban.md); `templates/briefs/member.md:138`).
2. `atmux task show <task-id>` — the **spec** (`tasks.body`: acceptance criteria, file paths, plus the `**ADR**:` line whose perusal `templates/briefs/member.md:43` makes mandatory) **plus** the D1 note log, oldest-first, with the `plan` note surfaced first.
3. `ls -t .atmux/handoff/ | head -3` then read the newest `*-to-<member>-*.md` — the `atmux handoff` artifact (`src/verbs/handoff.ts:414-416`). **Now a bonus:** if it is the 500-line scrollback fallback or the `(no pane to capture)` stub, step 2 already carried the plan.
4. `sed -n '1,80p' .atmux/decisions.md` — standing decisions, do not relitigate ([ADR-008](008-decisions-verb.md); bounded by `atmux groom --decisions-days`).
5. `/atmux:session cont` (`plugins/atmux/skills/session/SKILL.md`) — the driver/solo-side resume, which reads its own `~/.claude/projects/<project-slug>/todo/<branch>/handoff.md` and cross-references the task list (`:120-143`).
6. `atmux status` — sibling members' self-reports (`src/core/member-status.ts`, per [ADR-260](260-manual-orchestration-mode-default.md)) so the replacement knows who else is live.

**The ordering is the decision, not decoration.** Steps 1–2 are the **durable floor and must be sufficient on their own.** Steps 3–6 are enrichment. Stated as a rule: **any step after 2 being empty, stale, or a stub must not prevent resume.** That is the inversion — today step 3 carries the plan and degrades to a scrollback tail; after this ADR step 2 carries it and step 3 is a nicety.

**Sub-decision D3a — close the disjoint-handoff gap.** `plugins/atmux/skills/session/SKILL.md` §Handoff-path-convention (`:31-39`) MUST also probe `.atmux/handoff/` for the newest `*-to-<member>-*.md` when invoked from inside a team cage. Today the skill's canonical path set and `atmux handoff`'s output path are disjoint (Context §2), so the resume path never reads the file the handoff verb wrote. This is a one-line skill amendment with **no code change**. Verified disjoint 2026-08-06 by reading both files; untested — verify no other consumer depends on the current path set before editing it.

### D4 — Proactive checkpointing: the write happens under context pressure, while the pane is alive

**The rule: the checkpoint is written when a threshold is crossed, not when the pane is dead.** Rotation already fires at roughly 30% remaining context ([ADR-009](009-auto-rotation.md)), on refusal patterns ([ADR-139](139-refusal-pattern-auto-rotate.md)), and via `atmux cockpit rotate` ([ADR-167](167-cockpit-rotate-verb.md)). At every one of those entry points there is still a live agent capable of taking a turn — which is exactly what phases 1–3 of `handoff` cannot assume.

**Rule:** *before any rotation path sends the rotate keystroke, the rotating agent appends a `--kind plan` checkpoint note to every Task it owns in status `in-progress`.*

Three legs, in order of how much code each costs:

**(a) Instruction leg — zero code, ships first.** `templates/briefs/member.md` §Rotation (`:138`) gains the pre-rotation checkpoint line. The same line goes into `plugins/atmux/skills/session/SKILL.md` §handoff same-session mode, which is *the* phase-boundary verb since [ADR-263](263-merge-session-preclear-into-handoff.md) folded `preclear` into it. This leg alone closes most of the hole, because most rotations today are agent-initiated at a phase boundary.

**(b) Mechanical leg — make the death-bed ask targeted instead of generic.** Before the native ask (`src/verbs/handoff.ts:421`), `atmux handoff` lists the from-member's in-progress Tasks and, for each with **zero** `task_notes` rows written since `claimed_at`, names those Task ids inside `buildHandoffNoteAsk` (`:137-143`). The dying pane is then asked for *the specific missing pieces* rather than a generic 50-line summary — a cheaper request, likelier to complete within the 30s poll. This makes phase 1 better while removing its load-bearing status.

**(c) Cadence leg — a threshold, explicitly NOT a timer, and NO new arm.** **No new daemon, no new cron entry, no new orchd ticker.** [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) (Status: **proposed**) and [ADR-237](237-no-llm-discord-and-whip-removal.md) (Status: **proposed**) are the decisions that retire the cron surface; [ADR-260](260-manual-orchestration-mode-default.md) (accepted 2026-06-12) makes manual mode the fleet default, so a ticker would be dormant on every current team; and a new recurring arm would drag in [ADR-192](192-cron-arm-idempotency-contract.md)'s idempotency discipline for zero gain. The cadence signal already exists: **D2's `planGraceSec` age gate IS the cadence.**

**The on-demand walker is `atmux hygiene-tick`, and it is the only one.** `src/verbs/hygiene-tick.ts` opens `join(atmuxDir, "state.db")`, loads the whole kanban via `new KanbanRepo(db).listTasks()`, and hands it to `drainTick`; its phantom-prune sub-op then filters specifically to `status = 'in-progress'` claims (`findPhantomInProgressClaims`, age-gated at `HYGIENE_TICK_PHANTOM_MIN_AGE_SEC`). So the in-progress walk D2's detector needs is already in the verb, and the detector is one more class inside the drain it already runs.

**There is no `atmux whip` to lean on — do not reintroduce one.** [ADR-266](266-shim-sunset-policy-and-first-sweep.md) §D2 removed the `whip` and `whip-resume-check` CLI aliases from `src/cli.ts` and dropped the `whip` row from `atmux help`, and §D3 deleted `src/core/whip-escalation.ts` as verified-dead code. Verified 2026-08-06: `rg -n -i 'whip' src/cli.ts` returns nothing (rc=1) and `ls src/verbs/ | grep -i whip` returns nothing. The surviving surfaces are `atmux hygiene-tick` (detection), the per-commit reviewer gate (the comment leg in D2), `atmux doctor` probes (`src/verbs/doctor.ts`, dispatched at `src/cli.ts:312`), and the `.atmux/flags.md` file contract → lead adjudication (escalation — see the caveat in D2's reviewer leg, which names what is and is not wired). atmux detects the absence of a checkpoint; the agent authors it.

**Why event boundaries and not "every N turns".** An agent cannot reliably count its own turns, so a turn-count instruction is unfollowable and therefore worthless. Use boundaries the agent can actually observe:

| Boundary | Note | Cost |
|---|---|---|
| Immediately after `atmux claim` | `--kind plan` (D2) | ~60 tok |
| On each commit | `--kind progress` with the SHA + one line | ~25 tok — rides the existing commit-ping-with-SHA habit at `templates/briefs/member.md:63` |
| On any blocker | `--kind blocker` | ~40 tok — `atmux member status blocked --note` already appends one per D1 |
| Before any rotation / `/clear` / handoff | `--kind plan` checkpoint | ~80 tok |

Four observable boundaries, no counting, and two of the four ride habits or verbs the member brief already mandates.

## Out of scope

- **Migrating `tasks.note` into `task_notes`, or deprecating `atmux done --note`** — the tree is append-only and the scalar stays (D1). A future collapse is a future ADR.
- **Any hard gate on `atmux claim` or `atmux task move <id> in-progress`** — rejected with reasons in D2, not deferred.
- **LLM scoring of note quality** — [ADR-237](237-no-llm-discord-and-whip-removal.md) §D1 rules out time-driven LLM cycles ("no hourly whips or crons anymore. remove them all", operator-verbatim, 2026-05-24). That ADR is `Status: proposed`, so it is cited here as the operator's standing position rather than as ratified law; this exclusion holds on its own merit regardless, because a judge on note quality is precisely the measurement that gets gamed next.
- **Diff-correlated `plan-missing` detection** — needs a git read the hygiene family does not do (OQ-6).
- **R2 (host-repo cleanliness) and R3 (recursive branch ledger)** — [ADR-268](268-managed-repo-state-isolation-enforcement.md) and [ADR-269](269-recursive-branch-ledger.md) respectively; see §Requirement scope.
- **New event topics** — [ADR-203](203-event-topic-taxonomy.md)'s closed set is untouched.
- **A new cron arm, ticker, or daemon** — D4(c).

## Consequences

**Positive**

- Plan and intent land in the team's `state.db` at every observable boundary. The durable floor for resume becomes `atmux claim --next` + `atmux task show`, and both of those already work perfectly when the authoring pane no longer exists.
- `atmux handoff`'s capture demotes from load-bearing to enrichment. Its three degradation modes — 30s poll miss → 500-line scrollback → `(no pane to capture)` stub — stop being data-loss events. D4(b) additionally makes the surviving ask more likely to succeed.
- The total surface is small and all of it extends seams that already exist: one migration rung (`src/abstractions/sqlite-migrations.ts`), one subverb on an existing verb (`src/verbs/task.ts`), one detector in an existing family (`src/core/superdoctor-hygiene/`), one extra row-move inside an existing groom sub-op (`src/core/groom-archive.ts`, sub-op 8), one appended stdout line in `src/verbs/claim.ts`, plus brief and skill text. **No daemon, no ticker, no cron arm, no new event topic, no new config block, no new groom flag.**
- The invariant in D3 is measurable and un-loosenable: a `plan-missing` count of zero, not a percentage.
- Notes are author-stamped and timestamped, which makes them useful for a second purpose nobody has today: reconstructing *when* a lane understood something, for post-mortems.

**Negative / risks**

- **Token cost of note-writing — quantified, not hand-waved.** Four notes per Task at ~25–80 tokens each is roughly **200–350 tokens of writes per Task**. On a 30-Task epic that is single-digit thousands of tokens. Weighed against one operator re-explanation turn, that is cheap. But the *read* side grows monotonically: `atmux task show` on a long-running Task returns an ever-longer log, and every resuming agent pays for it. Mitigations: `--notes-limit`, the 50-note soft-cap warning, and the `task_notes` leg of `groomArchive` (all D1 — noting that leg is gated on `--archive`, see OQ-8). **The real cost control is the content contract** (3 bullets, ≤15 lines, pointers not prose). If agents write prose instead of pointers, the cost is unbounded and the note log becomes the scrollback it was designed to replace — the failure is not that the mechanism is expensive, it is that it is misusable.
- **What breaks if agents ignore the obligation: nothing errors.** That is deliberate (D2) and it is also this ADR's principal weakness. The failure mode is a **silent** regression to 2026-08-06 behaviour, visible only as a rising `plan-missing` count. Therefore the finding **must** be surfaced where a human or lead actually reads it — via the hygiene → `.atmux/flags.md` (`### f-` header form) → lead-adjudication path ([ADR-214](214-retire-ombudsman-lead-absorbs-complaint-adjudication-via-honker.md), with the [ADR-010](010-atmux-flag.md) verb-not-ported caveat spelled out in D2) — and not merely persisted to `superdoctor_hygiene`. **If the surfacing leg is skipped, this ADR ships a metric nobody reads and the operator's original problem is unfixed while appearing addressed.** That is the single implementation step most likely to be dropped and most damaging to drop.
- **Goodhart risk on the note content.** `atmux task note t-x --kind plan "will fix it"` satisfies the detector. The detector counts rows; it cannot judge content. There is no v1 mitigation and this ADR does not pretend otherwise. The reviewer reading the note during the per-commit gate is the only quality signal, and it is a comment, not a block.
- **`atmux task show` output shape changes.** Additive, but the round-trip-into-`--body` hazard becomes more consequential. Implementation must grep `scripts/` for positional parsing of `task show`. Untested as of 2026-08-06 — verify.
- **Two disjoint handoff artifacts persist until D3a lands.** Until then a replacement following `/atmux:session cont` still never reads `.atmux/handoff/`.
- **A sixth hygiene fingerprint class widens a deliberately-closed enum.** [ADR-131](131-superdoctor-kanban-hygiene.md)'s five classes were all auto-fixable; `plan-missing` is the first that is escalate-only. Reviewers of `src/core/superdoctor-hygiene/` should expect the family's shape to now include non-fixable findings and not "fix" that by inventing an auto-fix.

**Reversibility: HIGH.** `task_notes` is leaf-additive (no foreign keys, no `tasks` column change). Yanking this ADR = drop the `task note` subverb, the `plan-missing` detector and its enum literal, the `task_notes` row-move from `groomArchive`, the `atmux claim` stdout line, and the brief/skill paragraphs. `tasks.note`, `atmux done --note`, `atmux handoff`, and every existing row behave exactly as they do on 2026-08-06. The orphan table costs one `CREATE TABLE` of disk.

## Open questions

1. **`planGraceSec`** — recommend 900. Untested; measure real claim→first-`plan`-note latency across a live team before pinning.
2. **Per-Task note soft cap** — recommend 50. Should exceeding 3× the cap escalate from a stdout warning to its own hygiene finding, or stay advisory forever?
3. **Should `atmux task note` emit an event?** Lean **no** for v1: [ADR-203](203-event-topic-taxonomy.md)'s set is closed and nothing would consume it. Revisit only if a lead wants live plan visibility, and then via a topic amendment ADR.
4. **RESOLVED 2026-08-06 — promoted into D2, not deferred.** *(Was: should `atmux claim` / `atmux claim --next` print the plan-note reminder on stdout?)* **Yes.** Both claim paths append the one-line reminder after their existing stdout confirmation (`src/verbs/claim.ts:212` / `:287`). Zero enforcement, one line of stdout, no state. Kept as entry 4 rather than deleted so entries 5–7 keep the numbers other documents already cite.
5. **Should `kind` be a closed verb-layer allowlist (`plan|progress|blocker|decision|done`) over a free-form column?** Lean **yes** — matches the `complaints.source_kind` precedent ([ADR-261](261-issue-sync-external-tracker-ingestion.md) §D3).
6. **Diff-correlated `plan-missing`** — a Task that reached `in-progress`, produced a git diff on the member's branch, and has zero `plan` notes is a stronger signal than the age gate. It needs a git read (`src/verbs/doctor/git.ts` is the only probe that shells git today). Own follow-up; explicitly not v1.
7. **Do epic-team cages inherit the invariant? — BLOCKING on the detector leg.** An epic-team's `state.db` is its own, so D3's invariant is per-team by construction — but a parent-team Task whose work happens in a child cage will show zero notes in the parent. Needs a decision: either the parent Task is exempt while a child cage owns it, or the fan-in writes a summarising note back. **Phasing gate, stated as a rule rather than a caution: the `plan-missing` detector MUST NOT ship until OQ-7 is resolved.** Shipping it first means the first `hygiene-tick` run on any team with live epic cages emits a false `plan-missing` finding on every parent Task, and a detector whose first run is mostly false positives is how a probe gets ignored permanently. The instruction legs (D2's brief text, D2's `atmux claim` reminder, D4(a)) and D1's schema + verb carry no such dependency and ship ahead of it. `docs/PRD.md` §5.5 records this as an implementation blocker rather than a nice-to-have, and this entry is the ADR-side statement of the same gate.

8. **Should the `task_notes` leg of `groomArchive` stay gated on `--archive`, or run unconditionally?** As specified in D1 it inherits `--archive`'s opt-in status, so a team that never passes the flag never bounds its note log. Running it unconditionally would change `atmux groom`'s default behaviour to delete rows without an opt-in, which the flag exists to prevent. Third option: leave the row move gated and add an unconditional *warning* when `task_notes` exceeds a row count. Not decided; the per-Task soft cap and `--notes-limit` are the interim brakes. Untested — measure real `task_notes` growth on one team for a full `--kanban-days` window before choosing.

## Decision-anchors

| Anchor | Where |
|---|---|
| Handoff's two-phase capture, 30s poll, 500-line fallback, absent-source stub | `src/verbs/handoff.ts:137-143`, `:184-197`, `:360-371`, `:373-385`, `:421-487` |
| Handoff writes `.atmux/handoff/` (**singular**), verified on disk 2026-08-06 | `src/verbs/handoff.ts:414-416` |
| Tasks migrate regardless of capture quality | `src/verbs/handoff.ts:490` |
| `/atmux:session cont` reads a **different** handoff path | `plugins/atmux/skills/session/SKILL.md:31-39`, `:120-143` |
| `task update --body` REPLACES; `--body ""` clears; no `--note`/`--append` | `src/verbs/task.ts:70-71`, `:376-387`, `:498-500` |
| `--note` sinks that are last-write-wins, not logs | `src/verbs/claim.ts:68`/`:319`; `src/core/kanban.ts:1151-1174`; `src/verbs/member.ts:1065`/`:1175-1179`/`:1188`; `src/core/member-status.ts:61-79` |
| `tasks.note` is one scalar TEXT column | `src/abstractions/sqlite-migrations.ts:46` |
| Migration ladder is append-only; highest landed rung `to: 17` on 2026-08-06 | `src/abstractions/sqlite-migrations.ts:1-15`, `:811-844` |
| Hygiene fingerprint enum hard-codes five classes; D2 makes it six | `src/core/superdoctor-hygiene/_shared.ts:34-42` |
| `escalate` proposed-fix variant (no auto-fix path) | `src/core/superdoctor-hygiene/_shared.ts:48-52` |
| Existing hygiene finding store, PK `(task_id, fingerprint_class)` | `src/abstractions/sqlite-migrations.ts:234-247` |
| Hygiene drain entry point | `src/verbs/hygiene-tick.ts` |
| Age-gate-then-dedup precedent for D2's trip condition | `src/core/lane-stall.ts:172-180` |
| Kanban DB path is `.atmux/state.db` (**not** `.atmux/state/state.db`) | `src/core/kanban.ts:88-90` |
| Groom documents **eight** sub-ops (`1a`, `1b`, `2`–`8`); module header's "five" is stale | `src/verbs/groom.ts:285-305`; stale header `src/core/groom.ts:6` |
| Four numeric threshold flags today; D1 mints no fifth | `src/verbs/groom.ts:91-95`, help rows `:263` + `:271-273` |
| `archiveDecisions` — the markdown-flush retention precedent D1 cites as pattern | `src/core/groom.ts:498-660`; `docs/RUNBOOK-grooming.md` |
| `summarizeKanban` is a **no-op on SQLite teams** (returns early when `kanban.json` is absent) — why D1 does NOT anchor there | `src/core/groom.ts:692`, `:701-702` |
| Sub-op 8 `groomArchive` is what actually DELETEs `tasks` rows — D1's real anchor | `src/verbs/groom.ts:677-681`; `src/core/groom-archive.ts:103-104`, `:134`, `:140`, `:146` |
| `whip` verb + `whip-escalation.ts` are GONE (rg `src/cli.ts` → rc=1, 2026-08-06) — D4(c) leans on `hygiene-tick` only | [ADR-266](266-shim-sunset-policy-and-first-sweep.md) §D2 / §D3 |
| `hygiene-tick` loads the full kanban then filters `in-progress` in its phantom sub-op | `src/verbs/hygiene-tick.ts` (`KanbanRepo.listTasks()` → `drainTick`; `findPhantomInProgressClaims`) |
| `atmux claim` stdout sites the D2 reminder appends to | `src/verbs/claim.ts:212` (`claim <id>`), `:287` (`claim --next`) |
| `atmux flag` verb NOT wired despite ADR-010 being accepted (grep `src/cli.ts` → no match, no `src/verbs/flag.ts`, 2026-08-06) | [ADR-010](010-atmux-flag.md); `src/verbs/lane-drift-check.ts:430-439` states the non-port in-code |
| Live `.atmux/flags.md` contract — writers, reader, and the `### f-` header shape the reader requires | writers `src/verbs/lane-drift-check.ts:434-439`, `merge-cycle.ts:119`, `merge-member.ts:124-130`; reader `src/core/blockers.ts:377-395`, aggregated `:557` |
| Member brief: commit-ping-with-SHA, first-turn claim, loop, body-is-the-spec, mandatory `**ADR**:` perusal, rotation re-claim (`:138` still says `kanban.json` — fix in the same commit) | `templates/briefs/member.md:63`, `:82`, `:86-112`, `:94-100`, `:43`, `:138` |
| Never-claim roles excluded from D2's brief sweep | `templates/briefs/enforcer.md:105`, `unblocker.md:88`, `lead.md:69`, `team-lead.md:69`; `dba.md` has no `## Your loop` |
| Member self-report surface D3 step 6 reads | `src/core/member-status.ts`; `templates/briefs/member.md:203-209` |
| No `task note` / `--append-body` exists (rg, 2026-08-06) | `src/verbs/*.ts`, `src/cli.ts` |
