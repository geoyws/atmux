# ADR-264: Tasks drive development — headless drivers run Workflows in git worktrees; epics/stories fully cut

**Status**: accepted
**Date**: 2026-06-23
**Driver-ref**: George 2026-06-23 — "let's clean up all references to all epics and stories… tasks are sufficient because now agents can manage their own subagents"; "we want to have tasks drive our development moving forward so we can refine tasks and we can have drivers execute headless claudes that run workflows to run things"; "using of course git worktrees". **Decided this session:** the driver loop stays **outside** atmux (a skill / small headless runner), not a new atmux verb — a `drive` verb would re-grow the orchestration brain [ADR-263](263-great-simplification-tmux-harness-and-task-feed.md) just deleted.

**Relates / supersedes**: completes [ADR-263](263-great-simplification-tmux-harness-and-task-feed.md) §D4 — that ADR retired the fleet *behaviour* but left the Epic/Story **data model** (schema, DB tables, `task.epic`/`task.story` tags, the story-branch auto-emit hook, the `epic.*`/`story.*` event taxonomy) physically present as dead residue; this ADR cuts it. Builds on [ADR-260](260-manual-orchestration-mode-default.md) (manual orchestration default). **Supersedes the Epic/Story tiers of** [ADR-007](007-pull-kanban.md) (pull-kanban keeps **Task**; Epic + Story tiers retired) and **retires the epic/story machinery** of ADR-090 / ADR-091 / ADR-134 / ADR-146 / ADR-175 / ADR-193 / ADR-225 / ADR-231 / ADR-247. Keeps the worktree-per-unit isolation of [ADR-082](082-per-member-branches.md) + [ADR-084](084-long-lived-member-branches.md) — re-aimed at one worktree per *task*.

## Context

[ADR-263](263-great-simplification-tmux-harness-and-task-feed.md) ("the great simplification") cut ~80% of atmux — the orchd daemon, Honker, cockpit, lanes, epic-teams, mergers, roles/briefs — and re-aimed what remained at **a tmux harness + a git/sqlite task feed**. But the cut stopped at *behaviour*: the **Epic and Story data model** survived as inert residue —

- `KanbanEpic` / `KanbanStory` Zod schemas + the top-level `{tasks, epics, stories}` shape (`src/schema/kanban.ts`);
- the `epics` / `stories` SQLite tables + the `tasks.epic` / `tasks.story` columns + their indexes (migration v1);
- `--epic` / `--story` flags on `atmux task add` / `update` (ADR-193), shape-validated but pointing at nothing creatable;
- the ADR-146 **story-branch trunk-merge auto-emit hook** in `core/kanban.ts` + its `team.json::autoEmitTrunkMerge` config;
- the `epic.*` / `story.*` topic taxonomy + `Epic*Payload` / `Story*Payload` schemas in the (otherwise orphaned) Honker `src/schema/events.ts`.

None of it is reachable as a feature — there is no `atmux epic` / `atmux story` verb — but the references litter the schema, DB, and verb surface.

**Why Task alone is now sufficient.** The Epic→Story→Task hierarchy existed to *decompose* large work so a fleet of narrow-context workers could each hold one slice, and so a daemon could track roll-up state. Two things made that obsolete, recorded as the operator's bet across ADR-260 + ADR-263:

1. **1M-context frontier models** hold a whole subsystem at once — the throughput argument for decomposing across workers collapsed.
2. **Claude Workflows + subagents + `/goal`** do the decomposition *in-context, on demand* — "agents can manage their own subagents" (operator, 2026-06-23). The hierarchy is now something the *executing agent* materialises transiently, not something atmux persists.

So a single **Task** is the right unit of durable state: refine it (body / deps / priority), claim it, execute it (fanning out internally as needed), close it.

## Decision

### D1 — Task is the only persistent work unit

No Epic, no Story. `state.db` carries one flat `tasks` list (ADR-060), fed by two sources per ADR-263 §D2 (manual `task add`, git `issues sync`). Decomposition is the executing agent's transient concern (a Workflow fan-out), never persisted as Epic/Story rows.

### D2 — The driver model

A **driver** is one pull of the work loop:

```
atmux claim --next            # pull one refined Task from the feed (sqlite or git source)
git worktree add <wt> <base>  # isolate — ADR-082/084 worktree model, re-aimed at one worktree per Task
claude -p "<task body>"       # headless Claude; it calls the Workflow tool to fan out / verify / synthesize
…work…
atmux done <id> [--note]      # + push / open PR
```

The headless Claude owns *all* orchestration for its Task — including spawning its own subagents/Workflows. atmux does not see inside.

### D3 — The driver loop lives OUTSIDE atmux

atmux exposes exactly two things the driver loop composes:

1. **the task feed** — `task` / `claim` / `done` (+ `issues sync` for the git source);
2. **worktree provisioning** — the existing `src/abstractions/worktree.ts` seam.

The claim→worktree→headless-claude→done loop itself is a **skill / small headless runner**, not an `atmux drive` verb. Rationale: a built-in driver verb would re-accrete the standing-orchestrator brain ADR-263 deleted (scheduling, dispatch, roll-up, supervision). Keep atmux as **harness + feed**; let the headless Claude — which is strictly better at orchestration than atmux's old consumers were — own the loop.

### D4 — Residual cut (this ADR's code)

Delete, everywhere in live code + tests + live docs (ADRs and historical reviews/handoffs are **preserved** — append-only trace per the project contract):

- **schema** — `KanbanEpic`, `KanbanStory`, the top-level `epics` / `stories` arrays, and `task.epic` / `task.story` / `task.role` (the `role` field's only value was ADR-090's `reviewer-trunk-signoff` epic-done marker) in `src/schema/kanban.ts`; the `epic` / `story` fields in `src/schema/inbox.ts`; the `Epic*Payload` / `Story*Payload` schemas + `epic.*` / `story.*` topics + `epicId` / `storyId` payload fields in `src/schema/events.ts`; `TeamAutoEmitTrunkMerge` + `DEFAULT_AUTO_EMIT_TRUNK_MERGE_CONFIG` in `src/schema/team.ts`.
- **core** — `setTaskEpic` / `setTaskStory`, the ADR-146 story-branch trunk-merge auto-emit hook, the `epicId` / `storyId` enrichment on task-lifecycle events, and snapshot `listEpics` / `listStories` materialisation in `src/core/kanban.ts`; all `*Epic` / `*Story` row mappers + `epics` / `stories` table methods + `KNOWN_STORY_FIELDS` + the `tasks.epic` / `tasks.story` bindings + the `listTasks` epic/story filter in `src/core/repositories/kanban-repo.ts`; reduce `IdScope` to task-only (`"t"`) in `src/core/id-sequence.ts`.
- **verb** — `--epic` / `--story` flags + `EPIC_ID_RE` / `STORY_ID_RE` + `assertEpicShape` / `assertStoryShape` + USAGE strings in `src/verbs/task.ts`.
- **DB** — sqlite-migrations **v18** drops the `epics` + `stories` tables, the `idx_tasks_epic` / `idx_tasks_story` / `idx_stories_epic` indexes, and the `tasks.epic` / `tasks.story` columns (indexes first, then columns — SQLite refuses to drop an indexed column). Append-only; v1–v17 untouched.

### D5 — Prompt-injection note (carried from ADR-263 §D3, unchanged)

Git-sourced Task bodies are attacker-controllable text that a headless driver Claude will read. The body is **data, not instructions**; the driver runner must fence ingested bodies as untrusted. Documented residual risk, not a solved one.

## Consequences

- **The kanban is Task-only** — one flat list, two sources. Refine → claim → drive → done. Nothing to roll up.
- **~10 epic/story-tier ADRs are now fully dead in code** (ADR-007 Epic/Story tiers, 090/091/134/146/175/193/225/231/247). They stay on disk (append-only). The INDEX `Superseded` bookkeeping (the `.SUPERSEDED.md` file-rename dance) for the full ADR-263 fleet families is a **follow-up docs task**, not done in this cut.
- **`state.db` schema shrinks** — two tables + two columns + three indexes gone via v18. Forward-only; recoverable from git history on the `atmux-geoyws-driver-2` branch (and the broader fleet from the `pre-adr-263-simplification` tag).
- **The driver-loop-as-skill is the next build** — out of this ADR's scope, which is design + the residual cut only.
