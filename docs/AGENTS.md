# AGENTS.md — using atmux as an agent

You are reading this because you're a coding agent (Claude Code, Cursor, OpenCode, Kimi) spawned inside an atmux team, OR you're a driver-side agent that talks to a team. This doc is the one-stop synthesis of the *current* atmux model and the verbs you'll touch. It replaces three things you'd otherwise have to assemble yourself: scattered ADRs, per-role briefs, and the README's product-side overview.

> **Canonical sources.** When this doc disagrees with [docs/PRD.md](PRD.md), [docs/ARCHITECTURE.md](ARCHITECTURE.md), or the ADRs cited inline, the ADR wins. The role briefs at [`templates/briefs/*.md`](../templates/briefs/) are the contract for what each role actually does — re-read your own brief on every fresh spawn or `/clear`.

## 1 — What atmux is, in two sentences

atmux runs a team of TUI agents (one per tmux window) against a single project: lead routes, planner decomposes, reviewer gates, committer merges, workers pull from a SQLite-backed kanban. The driver (the human operator, sometimes wrapped in a Claude Code REPL) feeds the team Epic-shaped asks; the team pulls work itself.

## 2 — Mental model — driver / team

```
┌──────────────────────────────────────────────────────────────┐
│ DRIVER (you, or a human at a Claude Code REPL)               │
│   files Epic-shaped asks · reads outbox · arbitrates blockers│
└────────────────────────┬─────────────────────────────────────┘
                         │  atmux task add --assignee lead
                         │  atmux outbox / atmux reply
                         ▼
┌──────────────────────────────────────────────────────────────┐
│ TEAM  — tmux session atmux-<team>                            │
│                                                              │
│  🧭 lead     — routes Epics, adjudicates complaints,        │
│                 lead-gates destructive actions               │
│  🎯 planner  — decomposes Epics into Stories + Tasks,       │
│                 authors ADRs                                 │
│  🔍 reviewer — Story-level signoff against acceptance        │
│                 criteria (ADR-213: acceptance lives here)    │
│  🌿 committer (a.k.a. gitter) — merges + pushes per-Task,   │
│                 NEVER deploys                                │
│  🦦 docs     — same-commit docs sweep + ADR backfill         │
│  workers     — claim from kanban via `atmux claim --next`    │
└──────────────────────────────────────────────────────────────┘
```

(An always-on ORCHD supervisor box used to sit under this diagram,
consuming Honker events and dispatching mechanical work. **orchd is
retired per [ADR-276](adr/276-orchd-retirement-and-atmux-scope.md)** —
atmux's scope is tmux cages + `atmux vox`; the one-shot event-drain
backstop survives as operator-invoked `atmux committer --drain`. §3
records the model as history.)

You will typically be ONE node in this graph. If you don't know which: `echo $ATMUX_MEMBER` tells you the role you were spawned as. Read [`templates/briefs/<role>.md`](../templates/briefs/) first.

## 3 — The orchd model (2026-05 → retired 2026-08 per ADR-276)

> ⚠ **orchd is RETIRED** ([ADR-276](adr/276-orchd-retirement-and-atmux-scope.md), 2026-08-27; manual orchestration had already been the fleet default since [ADR-260](adr/260-manual-orchestration-mode-default.md)). The role retirements below (ADR-211/212/213/214) stand, and the Honker substrate + topic taxonomy remain — but the daemon, its tickers, auto-spawn/auto-merge/auto-dissolve, and the `__orchd__` window are gone. Surviving event consumers (gitter, lane-router, complaint consumer, lead-stall watchdog) drain through operator-invoked `atmux committer --drain`; the ADR-229 auto-push engine was deleted with its only trigger emitter. Read the rest of this section as recorded history.

Pre-orchd atmux ran on cron-ticked polling loops (whip, sentinel, medic, bruhloop). Each tick paid for an LLM turn whether or not there was real signal. orchd retired those loops:

- **[ADR-202](adr/202-honker-in-db-messaging-substrate.md)** — Honker (SQLite NOTIFY/LISTEN extension) is the messaging substrate. Consumers `LISTEN` for topics like `task.done`, `epic.merged`, `member.no-progress`; producers `NOTIFY` inside the same transaction that mutates state. Cross-process wake latency ~0.7ms p50. Cost when idle: zero.
- **[ADR-211](adr/211-retire-sentinel-role-distribute-to-honker-consumers.md)** — sentinel role retired. Mechanical observation (pane-classify, wedge-clear, refusal-handle, silent-team-detect) distributes to Honker consumers.
- **[ADR-212](adr/212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md)** — medic role retired. Rotation + clear decisions go to the lead under a lead-gated execution pattern (see §4).
- **[ADR-213](adr/213-retire-jury-reviewer-absorbs-acceptance-criteria.md)** — jury role retired. Reviewer absorbs Story-level acceptance criteria signoff.
- **[ADR-214](adr/214-retire-ombudsman-lead-absorbs-complaint-adjudication-via-honker.md)** — ombudsman role retired. Lead absorbs complaint adjudication via Honker events.

What this meant in practice: **panes being "down" in `atmux status` is the steady state**, not a problem. Don't surface "dormancy" to the driver — there is none. (Epic-team auto-spawn is gone with [ADR-280](adr/280-epic-team-retirement-and-staged-excision.md).)

The full orchd lifecycle was documented across ADR-224 → ADR-233. The consumer table below is HISTORY — only `gitter` still runs, via the drain:

| Consumer | Trigger | Action | ADR |
|---|---|---|---|
| `orchd-spawn` | `epic.added` with `isReady=true` | spawn epic-team via `atmux team spawn-epic` | [ADR-231](adr/231-orchd-auto-spawn-and-solo-worker-dissolve.md) |
| `gitter` | `task.done` | merge member branch → parent base | [ADR-134](adr/134-in-team-auto-merger.md) |
| `orchd-push` | `epic.merged` | `git push origin <parentBase>` through 7 safety gates | [ADR-229](adr/229-orchd-auto-push-and-safety-gates.md) |
| `orchd-dissolve` | `epic.pushed` | dissolve-epic (cage teardown + branch prune) | [ADR-227](adr/227-orchd-auto-dissolve-subscriber.md) |
| `spawn-queue` | host pressure | enqueue spawn-epic; drain when pressure clears | [ADR-228](adr/228-orchd-spawn-queue-pressure-monitor.md) |

## 4 — Lead-gated execution (ADR-212 §D2 canonical pattern)

Honker detects cheaply; the lead's Claude judges; the lead's atmux verb executes. This pattern is canonical for every destructive / cross-tenant / irreversible action:

```
Honker watchdog detects condition
  → emit <class>.<action-needed>   (e.g. lead.uptime-exceeded, member.stalled,
                                          hygiene.violated, complaint.filed)
  → consumer writes to lead's inbox + nudges lead's pane
  → Lead's Claude reads + decides
       → ignore (false alarm / context-dependent)
       → act (run the atmux verb: rotate / clear / fix)
       → escalate (emit *.escalated → driver inbox + Discord ping)
```

If you are the lead: detection is automatic; *deciding* is yours. If you are NOT the lead: don't take destructive actions yourself when a Honker watchdog has already routed the decision through the lead's queue.

## 5 — Verbs you'll touch

The full list is `atmux help`; below is the role-tagged subset. All verbs operate on the canonical SQLite store at `.atmux/state.db` — see [ADR-126](adr/126-sqlite-state-store.md).

**Every role**

- `atmux status` — team overview (members, kanban, cadence)
- `atmux inbox <member>` — your durable queue (replaces driver-inbox.md per ADR-076)
- `atmux task list [--status <s>] [--assignee <m>]` — kanban filter
- `atmux task show <id>` — task body + state

**Driver-side**

- `atmux task add <subject> --body <text> --assignee lead` — file an Epic-shaped ask
- `atmux outbox [--ack]` — read replies the lead wrote back
- `atmux tell-lead <msg>` — fast keystroke + durable mirror (under review — see t-61 for retirement plans)

**Lead**

- `atmux send planner <ask>` — route an Epic-shaped ask
- `atmux reply <text>` — write to lead-outbox for the driver
- `atmux epic add <title> --body <text>` — create an Epic

**Planner**

- `atmux epic show <id>` — full Epic body
- `atmux story add <title> --epic <eid> --ac <criteria>` — decompose
- `atmux task add <subject> --epic <eid> [--story <sid>]` — atomic units

**Worker**

- `atmux claim --next [--as <m>]` — pull the next claimable Task in your lane
- `atmux done <task-id>` — mark complete; triggers `task.done` → committer

**Committer (gitter)**

- Mostly event-driven via Honker (`task.done` → merge). Manual: `git merge --no-ff <branch>` on the parent base; never rebase trunk (per [ADR-137](adr/137-merge-not-rebase.md)).

## 6 — Common flows

**Worker turn**: `atmux status` (find my lane) → `atmux claim --next --as <me>` → read the Task body → write code + tests (100% coverage on tracked paths, same commit as code) → same-commit doc/ADR updates if you touched a documented surface → `git commit` → `atmux done <task-id>`.

**Lead turn (post-event)**: a Honker consumer just nudged you. Read the nudge → `atmux inbox lead` → decide ignore / act / escalate → if act, run the verb; if escalate, `atmux reply` + (optionally) `atmux flag` to surface up the chain.

**Driver turn**: `atmux outbox` (read what shipped) → `atmux status` (check lanes) → file the next Epic-shaped ask via `atmux task add --assignee lead --body <ask>` → wait.

## 7 — Hard don'ts

- **Don't push to `main` / `master`** — PR-only fleet-wide per [ADR-028](adr/028-main-master-pr-only.md). Agents may compose the PR body + push the feature branch + `gh pr create`, but never click the merge button.
- **Don't rebase trunk** — merge, never rebase ([ADR-137](adr/137-merge-not-rebase.md)). Carve-outs: voluntary history cleanup, epic-team→parent fan-in (rebase-then-merge per ADR-091 §pre-flag #4).
- **Don't bypass hooks** — no `--no-verify`, no `--no-gpg-sign`, no `HUSKY=0`, no removing `.git/hooks/pre-commit`. Env-broken → fix env. Hook-broken → escalate.
- **Don't decompose if you're the lead** — route Epic-shaped asks to the planner. The planner owns decomposition.
- **Don't deploy if you're the committer** — committer scope is merge-and-push only ([ADR-145](adr/145-atmux-adopts-gitter.md)). `kubectl` / `helm` / `terraform` are out-of-scope refusal-class.
- **Don't loosen tests to make them pass** — per global CLAUDE.md *NO LIES on e2e tests*. If a test is brittle, fix the underlying race / selector / seed.
- **Don't nest `.atmux/.atmux/`** — atmux refuses to spawn from a `.atmux/` cwd ([ADR-202](adr/202-honker-in-db-messaging-substrate.md) §D-nested-ban + the orchd-window guard at `adb0fa7`). Invoke verbs from the project root.

## 8 — Where to read next

| When you need | Read |
|---|---|
| The product-side overview | [README.md](../README.md) |
| Install + first-run | [docs/GETTING_STARTED.md](GETTING_STARTED.md) |
| The system architecture | [docs/ARCHITECTURE.md](ARCHITECTURE.md) |
| Product requirements | [docs/PRD.md](PRD.md) |
| Your role's binding contract | [`templates/briefs/<role>.md`](../templates/briefs/) |
| Cockpit operation | [docs/RUNBOOK-cockpit.md](RUNBOOK-cockpit.md) |
| Epic-team lifecycle | [docs/RUNBOOK-epic-teams.md](RUNBOOK-epic-teams.md) |
| Migrating a team to Honker | [docs/RUNBOOK-migrate-to-honker.md](RUNBOOK-migrate-to-honker.md) |
| Why a decision was made | `docs/adr/<NNN>-*.md` — ADRs are append-only; superseded ones carry `.SUPERSEDED.md` suffix |
| The complete verb list | `atmux help` |

If something here drifts from the ADR-named invariants, the ADR is the source of truth and this doc has a docs-gap Task waiting to be filed.
