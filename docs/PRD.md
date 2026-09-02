# atmux — Product Requirements Document

> **Status:** living document. Reflects HEAD `1d2157d` (2026-05-06) plus
> in-flight Phase 4 RUSH context. Updated on every commit-chain that lands
> new behavior. Owner: `docs` (atmux-bun team).
>
> **Canonical authority:** when this PRD and an ADR or `PLAN.md` diverge,
> the ADR / PLAN.md wins. PRD reflects shipped + planned reality; ADRs
> dictate decisions. Cross-references throughout.
>
> **State storage (atmux-bun, post-merge 2026-05-08).** Kanban + inboxes +
> per-feature state moved to **`.atmux/state.db`** (SQLite, WAL) per
> [ADR-126](adr/126-sqlite-state-store.md). References to `kanban.json`
> below describe the legacy JSON path; the bun port is dual-path with
> `state.db` as source of truth when present.

> **2026-05-24 architecture alignment.** atmux is now event-driven via the
> Rust **`atmux-orchd`** daemon (per-team process, 10 in-process consumers + 4
> tickers) backed by the **Honker** in-DB messaging substrate. atmux NEVER
> writes to crontab — cron auto-install retired per [ADR-233](adr/233-cron-auto-install-disabled-trust-orchd.md);
> orchd is the runtime. Cockpit roles trimmed: **Sentinel retired**
> ([ADR-211](adr/211-retire-sentinel-role-distribute-to-honker-consumers.md)),
> **Medic narrowed to on-demand `atmux medic diagnose <team>`**
> ([ADR-212](adr/212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md)),
> **Jury retired** ([ADR-213](adr/213-retire-jury-reviewer-absorbs-acceptance-criteria.md);
> reviewer absorbs acceptance criteria), **Ombudsman retired**
> ([ADR-214](adr/214-retire-ombudsman-lead-absorbs-complaint-adjudication-via-honker.md);
> `complaint.filed` → consumer → tell-lead). Retired roles ship as safety net
> until cleanup-EPIC ≥30 days after e-honker-observation-watchdogs runs stable.
> Honker topics live at `src/schema/events.ts::TOPICS`; emit via
> `emit(db, payload)` in `src/abstractions/events.ts` (auto-detects honker-loaded
> state per [ADR-202 §Amendment 2026-05-24](adr/202-honker-in-db-messaging-substrate.md)).
>
> ⚠ **The 2026-05-24 note above is superseded on the daemon question.** ADR-260
> (accepted 2026-06-12) made **manual orchestration the fleet default** and orchd
> **opt-in**. See §1.2 principle 3, corrected 2026-08-06, for the current position
> and the full position history.

> ⚠ **2026-08-27 — orchd retired entirely** ([ADR-276](adr/276-orchd-retirement-and-atmux-scope.md)).
> The daemon, verb, window, tickers and epic-machinery consumers are gone; atmux's
> scope is tmux cages + `atmux vox`. The one-shot event drain survives as
> operator-invoked `atmux committer --drain`. Read every "orchd is the runtime"
> sentence in this PRD as history.

> **2026-08-06 — business-intent document upstream of this PRD.**
> [docs/brd/atmux.md](brd/atmux.md) is atmux's **Business Requirements Document**:
> it records WHY atmux exists, who pays when it does not work, what outcome counts
> as the problem being solved, and what atmux refuses to become. Its organising
> thesis is the operator's 2026-08-06 sentence — *"atmux is meant to assist in
> agentic dev."*
>
> **Authority order: BRD → PRD → ADR wins on decisions.** Read that as three
> distinct jobs, not a strict ranking of trust:
> - The **BRD** is the *intent of record*. When this PRD and the BRD disagree about
>   why something exists or for whom, the BRD is right and this PRD is stale — file
>   the PRD correction.
> - This **PRD** is the *map* of shipped + planned surface. It never re-decides
>   mechanism.
> - An **accepted ADR** in `docs/adr/` **overrides both** on any question of
>   mechanism or decision — the pre-existing rule at the top of this header stands
>   unchanged. A business requirement that conflicts with an accepted ADR is
>   resolved by filing a **new superseding ADR** citing the BRD as its driver-ref,
>   never by editing the ADR's Decision section (the tree is append-only) and never
>   by ignoring it.
>
> A BR is not self-executing: business intent becomes binding on the fleet only
> once an ADR ratifies a mechanism and this PRD / a `RUNBOOK-*.md` documents the
> surface. See [docs/brd/atmux.md](brd/atmux.md) §1.2.

---

## 1. Vision

### 1.1 Problem

Multi-agent coding workflows demand orchestration across heterogeneous TUIs
— Claude Code for reasoning-heavy roles, Cursor / OpenCode / Kimi /
MiniMax for parallel cheap workers. Existing solutions either (a) lock
into one AI provider's API, (b) require a daemon + RPC layer that drifts
from the operator's terminal, or (c) reduce to a single-pane Claude REPL
that can't fan out per feature lane.

### 1.2 Solution

**atmux** is a tmux-native multi-TUI agent orchestrator for agentic
development. One tmux session per project team, one tmux window per agent, all
coordination state on disk — canonically SQLite at `.atmux/state.db`
([ADR-126](adr/126-sqlite-state-store.md)), operator-private and symlinked out
of the product repo
([ADR-244](adr/244-per-repo-pre-commit-kanban-decisions-snapshot.md)
§Supersession-2026-05-26). No provider API. No long-lived process required —
manual orchestration is the fleet default and the `atmux-orchd` daemon is
opt-in ([ADR-260](adr/260-manual-orchestration-mode-default.md)). State
survives tmux restarts; restarts survive `/clear` cycles; durable by
construction.

*(Paragraph corrected 2026-08-06. It previously read "all coordination state on
disk in greppable JSON / markdown. No daemon." — both clauses were stale in the
same two ways as principles 2 and 3 below, which carry the full correction and
the position history. The clause corrected here and the principles below now
state one position, not three.)*

Three durable principles (see `docs/ARCHITECTURE.md`):

1. **tmux is the IPC.** `tmux send-keys` writes shell input; `tmux
   capture-pane` reads response. Works with any interactive coding-agent
   TUI, present or future.
2. **State lives on disk, outside every agent process.** *(Corrected
   2026-08-06 — the durability claim still holds; the storage details in the
   original wording were stale.)* **Still true:** no coordination item — task,
   epic, story, claim, dependency, inbox message, decision — exists only inside
   an agent process, a tmux pane's scrollback, or a chat transcript. State
   survives tmux restart and replays on `atmux start`. **Two corrections:**
   (a) the canonical store is **SQLite at `.atmux/state.db`** (WAL) per
   [ADR-126](adr/126-sqlite-state-store.md), not JSON / markdown — JSON is
   archive-only, so `.atmux/` is queried with `sqlite3` rather than being
   greppable end-to-end (`decisions.md`, `flags.md`, and the rendered inbox
   markdown views do remain plain text and diffable). Verified on disk
   2026-08-06: the DB is `.atmux/state.db`, resolved by
   `src/core/kanban.ts:89` (`join(atmuxDir, "state.db")`) — **not**
   `.atmux/state/state.db`. (b) the durable artifacts are **operator-private
   and live outside the product repo**: `.atmux/team.json`,
   `.atmux/decisions.md`, and `.atmux/state.db` belong in the operator's
   dotfile tree at `~/work/journals/.sb/_dotfiles/atmux/<repo-key>/` and are
   symlinked into `.atmux/`, with the managed repo ignoring all of `.atmux/`
   and no `!.atmux/team.json` carve-out
   ([ADR-239](adr/239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md)
   §Supplement-2026-05-26,
   [ADR-244](adr/244-per-repo-pre-commit-kanban-decisions-snapshot.md)
   §Supersession-2026-05-26). Node `fs` follows symlinks transparently, so no
   code changed. Snapshot cadence is `dotfiles push`, operator-driven —
   isolation protects teammates from the operator's artifacts; only
   `dotfiles push` protects the operator from machine death. Enforcement of
   that layout in code is proposed, not shipped — see §3.6 (R2) and
   [ADR-268](adr/268-managed-repo-state-isolation-enforcement.md).
3. **Every verb is idempotent, and no long-lived process is required.**
   *(Corrected 2026-08-06 — the position on daemons moved twice. Both moves are
   recorded below rather than erased, because this PRD previously carried all
   three positions simultaneously with no way to tell which was current.)*
   **Current position (read this one):** manual orchestration is the **fleet
   default** per [ADR-260](adr/260-manual-orchestration-mode-default.md)
   (accepted 2026-06-12). `team.json::orchestration.mode` defaults to
   `"manual"` — an absent block resolves to `"manual"` (ADR-260 §D1) — and in
   manual mode **no `atmux-orchd` window is spawned at all** (ADR-260 §D2
   Gate-1). The lead / driver LLM drives the kanban by hand with the existing
   verbs (`claim` / `done` / `task move` / `dispatch` / `epic-merge` /
   `team spawn-epic`), and members self-report liveness and intent via
   `atmux member status <idle|working|blocked|rate-limited>` (ADR-260 §D3–§D5).
   The Rust **`atmux-orchd`** daemon is **opt-in**: it spawns only for a team
   that explicitly sets `"orchestration": { "mode": "orchd" }`, and even then
   every orchd consumer (auto-merge, auto-push, auto-spawn, solo-worker
   dissolve, lead-stall watchdog, context/budget scanners) becomes opt-in with
   it. `atmux orchd --start / --drain / --sweep` remained manually invocable in
   any mode until ADR-276 removed the verb (the drain is now `atmux committer
   --drain`). The operator's recorded rationale is verbatim in ADR-260: *"LLMs
   can manage their own fleet better than atmux can at the moment."* atmux
   still **NEVER** writes to crontab
   ([ADR-233](adr/233-cron-auto-install-disabled-trust-orchd.md)).
   **Position history, kept deliberately:** (i) **2026-05-06 original** — "No
   daemon"; `whip` (15min default per `team.whip.intervalMins`, bumped from
   5min in `t-dcbff97c` to dial back per-tick LLM burn) and `report` (30min)
   ran on cron, nothing long-lived. (ii) **2026-05-24** — cron auto-install was
   retired and orchd became "the runtime" (ADR-233; see the 2026-05-24 header
   note above), and the hourly LLM whip cadence into Discord was removed by
   [ADR-237](adr/237-no-llm-discord-and-whip-removal.md). (iii) **2026-06-12** —
   ADR-260 reversed the default: manual is the default, orchd is opt-in. Rollback
   in either direction is one line per team; no state migration either way.

### 1.3 Why now

> **Rewritten 2026-08-06.** This section previously argued that
> "mixed-capability worker fleets beat any single-model approach for
> throughput-per-dollar," naming *Cursor Composer 2 + OpenCode (MiniMax) + Kimi*
> as parallel worker lanes with *Claude Opus 4.7* anchoring the staff. **That
> tiering is not the shipped stance and has not been since 2026-05-21.** §1.1's
> "Cursor / OpenCode / Kimi / MiniMax for parallel cheap workers" phrasing is
> stale in exactly the same way and should be read as history, not as current
> staffing. The original pitch is preserved in the bullet list at the end of this
> section.

**Every member role runs Claude Opus.** The project `CLAUDE.md` §"Spawning +
model selection" is binding: team members, driver, and lead always run Opus
(`claude-opus-4-7`) with `CLAUDE_CODE_EFFORT_LEVEL=xhigh`, and **"Never Sonnet
for member roles."** Cheaper models are permitted only for **read-only**
sub-agents (Explore, general-purpose); a sub-agent that writes code runs Opus.

The cheap-worker tiering was unwound decision by decision, and each step is on
the record:

- [ADR-201](adr/201-cursor-cli-composer-25-as-first-class-member-tui.md) proposed
  a first-class cursor-cli composer-2.5 **member** TUI and was **Rejected** by
  driver verdict 2026-05-21. The verdict is not a mere decline-to-add — it states
  the direction as *"REMOVE cursor in favor of Opus across atmux — not just
  decline to add at member tier, but unwind cursor at sentinel (ADR-132) + cancel
  forthcoming jury cursor path."*
- [ADR-207](adr/207-opus-sentinel-supersedes-cursor-sentinel-adr-132.SUPERSEDED.md)
  executed the first half — an Opus sentinel replaced the cursor sentinel of
  [ADR-132](adr/132-pluggable-martinet.SUPERSEDED.md).
- [ADR-211](adr/211-retire-sentinel-role-distribute-to-honker-consumers.md) then
  retired the Sentinel role entirely. That matters here because
  [ADR-140](adr/140-cheap-model-first.md)'s cheap-model-first principle was
  attached to the sentinel role — with the role gone, that principle has **no
  live consumer at the member tier**.
- [ADR-213](adr/213-retire-jury-reviewer-absorbs-acceptance-criteria.md) retired
  the `_jury` role, cancelling the other planned cursor-based gate; the reviewer
  absorbed acceptance-criteria verification.

**What the multi-backend surface is actually for.** atmux stays vendor-agnostic
at the **seam**, not at the member tier. tmux is the IPC (§1.2 principle 1), and
[ADR-258](adr/258-vendor-agnostic-orchestration-agentbackend.md) puts an
`AgentBackend` adapter behind it, demoting tmux to an attach view — so atmux can
drive any interactive coding-agent TUI, including ones that do not exist yet.
The §3.2 TUI matrix therefore documents what atmux **can launch**, not what the
operator's teams **run**.
[ADR-262](adr/262-opencode-headless-backend-port-plugin-orch-safety.md)
(`opencode` headless backend, Status: **proposed**) is the live proposal in that
space and is scoped to a *separate* flat cheap-model-member topology — it does
not reinstate mixed-tier staffing inside an Opus team.

**So "why now", restated to match what ships.** The case for atmux is not
throughput-per-dollar from model mixing. It is that **one operator can drive many
parallel Opus lanes only if each lane's coordination state — plans, todos, claims,
branches — is durable outside every agent process.** Otherwise the operator
becomes the fleet's only durable memory, and therefore its throughput ceiling:
N lanes cost O(N) operator re-explanations, and that number does not grow when the
fleet grows (see [docs/brd/atmux.md](brd/atmux.md) §2.2 items 3–4). tmux + a CLI +
on-disk state is the substrate that makes that cheap, inspectable, and familiar —
no new infrastructure to learn.

**Original 2026-05-06 pitch, retained for trace (superseded — do not staff from
this):**

- Claude Opus 4.7 anchors the staff (lead / planner / reviewer / committer
  / devops / dba) — reasoning + judgment + ADR authorship.
- Cursor Composer 2 + OpenCode (MiniMax) + Kimi handle parallel worker
  lanes at a fraction of Opus tokens per output line of code.
- Bash + tmux gives operators a deeply familiar substrate; no new infra
  to learn.

The multi-tier fallback chain that made that pitch operational (budget pressure
per ADR-049; per-tier isolation per kanban task `t-706655ee`) is still described
in §5.3 as planned scope, and remains unbuilt as of 2026-08-06.

---

## 2. Audience + use cases

### 2.1 Solo dev driving a Claude Code REPL with parallel cheap workers

The driver runs a Claude Code REPL outside the tmux session. They
`atmux tell-lead "implement auth flow"`, then `atmux outbox` to read
async replies. Lead routes to planner; planner decomposes into kanban
tasks; workers (Cursor / Kimi / MiniMax) pull `atmux claim --next` per
their lane.

### 2.2 Team lead coordinating multi-agent feature lanes

Lead never plans; lead dispatches. Per the doctrine in `~/.claude-ifca/CLAUDE.md`
("team-lead never plans"), task decomposition belongs to a dedicated
planner. The lead's cognitive budget goes to dispatch + status tracking
+ rotation + Discord. atmux's pull-kanban model (per ADR-031 in parent
atmux repo) lets the lead mark tasks `ready` and step away — workers
self-claim by lane priority, skipping deps-unmet work automatically.

### 2.3 Cost-conscious shops trading capability vs throughput

Preset modes (see `README.md` "Preset modes") let a team toggle
capability-vs-cost in one wizard prompt:

| Preset    | Staff TUI       | Worker TUI                                 |
|-----------|-----------------|---------------------------------------------|
| `perf`    | all `claude`    | all `claude`                                |
| `default` | all `claude`    | cycles `cursor` → `opencode` → `kimi`      |
| `eco`     | all `opencode`  | all `opencode` (MiniMax)                    |
| `custom`  | prompted        | prompted per worker                         |

### 2.4 Non-goals

Per `PLAN.md` §15:

- **Cross-host coordination.** atmux is single-host today. Multi-host is
  a separate project.
- **Web UI / dashboard webapp.** `atmux dashboard` is TUI-only.
- **Plugin API.** Verbs are closed-set; opening for plugins is
  post-cutover, not committed scope.
- **Daemon supervisor** (ADR-042 socket-pubsub in parent repo) — defer
  to Phase 5; bash WIP is unstable.
- **i18n beyond MYT.** Config knob is a Phase 5 nice-to-have.

---

## 3. Scope (current shipped surface)

> §3.1–§3.5 describe **shipped** surface. §3.6, added 2026-08-06, describes three
> requirement areas that are **ADR-proposed and NOT shipped** — every verb, flag,
> table, and probe named there is a proposal, not an available command.
> §3.7, added 2026-08-15, returns to **shipped** surface: the vox operator
> interface, live and deployed in a deliberately reduced read-only posture.
> ADR-285's `_bot` / `_superbot` offer-and-pull design is **proposed and not
> activated**; the cockpit table below shows its intended order explicitly so a
> source-only proposal is not mistaken for the current live topology.

### 3.1 Verbs (30, including aliases)

Source: `bin/atmux` dispatcher + `lib/*.sh` per `PLAN.md` §6.2.

| Bucket               | Verbs                                                                     |
|----------------------|---------------------------------------------------------------------------|
| Lifecycle            | `up` / `init` / `start` / `stop` / `attach` / `status`                    |
| Messaging            | `send` / `broadcast` / `tell-lead` / `reply` / `outbox`                   |
| Task board           | `task add/list/show/move/assign/lane/priority/update/rm`                  |
| Pull kanban          | `epic` / `story` / `claim` / `done` / `dispatch` / `inbox`                |
| Cron-fired           | `whip` / `report` / `decisions digest` / `groom` / `whip-resume-check` (1-min, ADR-053 §D4) / `watchdog` (2-min, ADR-057 §D6b) / `pulse` (5-min, cockpit-wide, ADR-086) / `check-lead-rotate` (5-min, cockpit-wide, ADR-143) |
| Eternal-improvement  | `improve` (Mode A user-invoked / Mode B idle-fallback) — ADR-052          |
| R1 wave (budget + self-heal) | `whip-resume-check` (ADR-053) — auto-resume; budget-pause + drift surfaced via `whip` (ADR-053/054); cursor self-heal opt-in via `team.json::whip.selfHealEnabled` (ADR-055); account-swap opt-in via `team.json::whip.accountFallback` (ADR-056) |
| Cost + budget        | `cost` / `pause` / `resume`                                               |
| Maintenance          | `rotate` / `rotate-lead` / `handoff` / `add-member` / `reconfigure` / `dashboard` / `doctor` / `cleanup` / `migrate-to-driver-session` |
| Decisions / flags    | `decisions add/list/show/digest` / `flags add/list/show/resolve`          |
| Driver self-state    | `brief-driver` / `driver note` / `reload brief-reload` / `reload config-reload` |
| Superdriver          | `super-attach` (cross-team / fleet — ADR-025 in parent repo)              |
| Cockpit              | `cockpit rebuild / reload` (ADR-063)                                      |

#### Cockpit topology (ADR-063 + ADR-077 + ADR-133 + ADR-135)

The operator cockpit session (`atx` by default per ADR-264, was
`atmux_cockpit` per ADR-135 and `atmux_teams` pre-ADR-135) carries the following window order — opt-in
surface (`_medic`) is gated by a `cockpit.json` block, per-team viewers
shift down by one when enabled. Cockpit-level system roles carry a
single-underscore prefix (sorts before plain team names in `tmux
list-windows`); per-team viewers stay plain. Member windows inside team
cages use `<emoji>-<member>` (hyphen-separated, ADR-135 §D3).

| # | Window | Role | Authorizing ADR |
|---|--------|------|-----------------|
| 1 | `_sd` (was `_superdriver`) | Operator cross-team REPL — superdriver lane `sd` | ADR-063 (renamed per ADR-135 §D2, shortform per ADR-288 §D1) |
| 2..k | `_sd2` … `_sdN` (superdriver lanes; live: `_sd2`, `_sd3`) | Additional superdriver lanes — ADR-279 operator windows placed immediately after `_sd`, in declaration order | ADR-288 §D2 + §D5 |
| k+1 | `_medic` (was `medic`/`superdoctor`) | Fleet self-healing / diagnosis-and-prevention loop — slot is after the last lane | ADR-077 + ADR-133 + ADR-135 §D2 + ADR-288 §D5 |
| k+2 | `_superbot` (proposed; absent while disabled) | Deterministic 30-minute Kanban candidate router; never claims or assigns | ADR-285 |
| k+3..N | other declarative operator windows (e.g. `_misc`), then per-team viewers | Operator workspaces in declaration order, then one viewer per enabled parent team. Lanes (`_sdN`, N ≥ 2, no `_sd1`; `ATMUX_MEMBER=sdN`, kb actor `claude@sdN`, same `superdriver` board, lease-guarded dispatch) are the only operator windows placed ahead of the role windows | ADR-279 + ADR-288 §D2/§D5 + ADR-063 |

Backward-compat: a cockpit.json without a `medic` block retains the
pre-ADR-077 topology (W1 `_sd` + W2..N per-team viewers).
Loader migrates legacy `superdoctor` keys to medic semantics with a
deprecation warning per ADR-133 §D2. Cockpit rebuild detects legacy
`atmux_teams` session + legacy non-underscored cockpit-role windows and
renames them in-place (idempotent) per ADR-135 §D4; the same shim renames
a legacy `superdriver` / `_superdriver` window 1 to `_sd` per ADR-288 §D1,
and both legacy spellings stay preserved for one release. Member windows in
legacy `<emoji><member>` format get the same in-place rename treatment
on next `atmux start`.

**Proposed cooperative bot seat (ADR-285).** Every persistent parent team gains
an exact `_bot` window after all drivers and before members/services, backed by
`<base>-bot` in `.atmux/worktrees/bot`. It is neither a driver nor a member. The
operator may type into it directly; `_superbot` may offer a tagged Kanban task
only after conservative idle/readiness checks and an exact-task claim remains
the first bot action. V1 excludes transient teams and external-issue polling.
Defaults remain disabled + shadow until process and isolated-tmux integration
receipts pass and the operator separately authorizes live activation.

**Cockpit-W3 sentinel retired (EPIC e-be01fc89, 2026-05-23)** — the
pluggable cockpit-W3 whip-manager (ADR-132 / ADR-158 / ADR-183 / ADR-185)
is fully removed. Mechanical observation + Enter-push + `claim-next`
re-fires distribute to Honker event consumers per sibling EPIC
e-a946af69 (orchd Phase 3-5 — these consumers will NOT ship; orchd retired
per ADR-276). Absent them, the lead's
self-driven whip cron (`team.whip.intervalMins`) is the canonical
observe + intervene loop; on-demand audits via `atmux doctor` cover the
gap. Legacy `team.sentinel` / `cockpit.sentinel` / `cockpit.defaultSentinel`
config keys are silently accepted via schema-passthrough but no longer
drive any spawn.

### 3.2 TUI matrix

| TUI         | Binary           | Default model                                  |
|-------------|------------------|------------------------------------------------|
| `claude`    | `claude`         | Claude Code default — Opus / Sonnet            |
| `opencode`  | `opencode`       | `minimax-coding-plan/MiniMax-M2.7-highspeed`  |
| `kimi`      | `kimi`           | `kimi-latest`                                  |
| `cursor`    | `cursor-agent`   | `composer-2`                                   |
| `shell`     | `$SHELL`         | (testing only)                                 |

Custom launch commands via `team.json:.tuiCommands` map per `README.md`
"Custom launch commands". Resolution order: `member.command` →
`team.tuiCommands[<tui>]` → built-in default.

### 3.3 State layout

```
.atmux/
├── team.json                  # source of truth (members, roles, TUIs, models)
├── state.db                   # SQLite canonical store (ADR-126 + ADR-076):
│                              #   tasks (Epics + Stories + Tasks), inbox_messages
│                              #   (per-member), complaints, handoff state.
├── kanban.json                # legacy deprecation stub on post-cutover teams;
│                              #   pre-cutover teams still read here.
├── driver-inbox.md            # legacy stub; use `atmux tell-lead`
├── lead-outbox.md             # lead/member → driver async replies
├── lead-queue.md              # lead's mid-turn deferrals
├── decisions.md               # auto-mode resolutions (markdown, append-only)
├── flags.md                   # operator escalations
├── inboxes/<member>.json      # legacy — writes no-op on SQL-canonical teams
├── logs/                      # send-<member>.log / whip.log / report.log / etc
├── state/
│   ├── session.txt            # captured at `atmux start` (ADR-026 single-session default)
│   ├── session-start.txt      # epoch seconds (whip's lead-uptime source)
│   ├── last-report.epoch      # last `atmux report` fire
│   ├── budget-pause.json      # per ADR-049 (when paused)
│   └── cron-rename-migration.log  # ADR-133 TR6: append-only audit of `atmux superdoctor` → `atmux medic` cron-line rewrites (no-op on installs with no legacy lines)
├── archive/<timestamp>/       # created on atmux stop
└── sockets/                   # ADR-032 socket-pubsub (parent repo) when enabled
```

Cross-reference: `README.md` "State layout"; `docs/ARCHITECTURE.md`.

### 3.4 Configuration

Environment variables documented in `README.md` "Configuration" — not
duplicated here to avoid drift. `team.json` schema is the on-disk
source of truth.

### 3.5 Skills plugin (`/atmux:` namespace, optional)

atmux ships with a Claude Code plugin (`plugins/atmux/`) bundling 11
operator-cockpit-tier skills under the `/atmux:` namespace —
`/atmux:team`, `/atmux:driver`, `/atmux:tell-lead`, `/atmux:session`,
`/atmux:whip`, `/atmux:bau`, `/atmux:budget`, `/atmux:cockpit-rebuild`,
`/atmux:ghostbuster`, `/atmux:heads-up`, `/atmux:sweep` (`/atmux:bruh`
and `/atmux:bruhloop` were retired per ADR-288 §D4). Each wraps a
recurring multi-step atmux workflow that
operators previously either retyped from memory or maintained in
private dotfiles. Bundling them with atmux makes the cockpit-tier
workflow discoverable + survives operator-machine bootstrap.
Source: [ADR-217](adr/217-atmux-skills-plugin-bundled-and-wizard-installed.md).

**Install posture:**

- **Optional** — the install wizard (`atmux init`, per
  [ADR-200](adr/200-install-wizard-guided-first-run-setup.md))
  prompts `[Y/n/s]` (yes / no / show-list). Skip with `--no-skills`;
  re-install later with `--skills-only`.
- **Symlink not copy** — wizard symlinks
  `<atmux-source>/plugins/atmux/` into `~/.claude/plugins/atmux/`
  (Claude Code's plugin discovery path). atmux upgrades automatically
  refresh the bundled SKILL.md bodies — operators don't have to
  re-install the plugin to pick up newer skill behavior.
- **Operator dotfiles override preserved** — if
  `~/.claude/plugins/atmux/` already exists as a real directory
  (not a symlink), the wizard preserves it + prints a notice.
  Operators who maintain their own per-skill customizations keep
  them; the bundle becomes the default for users who don't.
- **Doctor probe** — `atmux doctor` adds an `atmux-skills-plugin`
  row surfacing the install state (green when symlinked +
  `plugin.json` validates; yellow when missing / malformed;
  info-level when opted out at wizard time).

For the full skill list + per-skill invocation reference + uninstall
instructions, see `plugins/atmux/README.md`.

### 3.6 PLANNED — 2026-08-06 operator ask (R1 / R2 / R3). ADR-proposed, NOT shipped.

> ⚠ **Nothing in §3.6 exists yet.** All three ADRs below carry **Status:
> proposed** as of 2026-08-06 and none has reviewer signoff or a
> driver `decisions-add` ratification (project `CLAUDE.md` §Binding-discipline 4).
> Verbs, flags, tables, sub-ops, and probes named here are **proposals**. Running
> them today produces `unknown verb` / `unknown flag`. Business intent for all
> three is in [docs/brd/atmux.md](brd/atmux.md) (BR1, BR4–BR7); the requirement
> decomposition R1 / R2 / R3 traces to one operator ask on 2026-08-06.

Operator ask, 2026-08-06 (verbatim): *"i need atmux to track plans and todos so
that they're never lost even if agents run out of tokens and then another agent
can easily take the previous agent's place. i need agents to always use atmux as
a way to track todos and to update work done and to keep all plans and intents in
atmux so that the git repo can be clean of our artifacts and my team members
won't need to see my todo artifacts. and i need atmux to note the branches that
we're working with across monorepos recursively as well."*

| Area | Requirement | ADR (proposed) | BRD |
|---|---|---|---|
| **R1** | Continuity — plans / todos / intent survive agent token exhaustion; a replacement agent resumes with no operator re-explanation | [ADR-267](adr/267-durable-agent-continuity-contract.md) | [BR1](brd/atmux.md) |
| **R2** | Host-repo cleanliness — atmux artifacts never enter a managed product repo's git history, established and verified by machine rather than operator memory | [ADR-268](adr/268-managed-repo-state-isolation-enforcement.md) | BR4 + BR5 |
| **R3** | Recursive branch ledger — atmux records which branch every repo in a monorepo (root + nested submodules, recursively) is working on, and detects drift | [ADR-269](adr/269-recursive-branch-ledger.md) | BR6 + BR7 |

#### 3.6.1 R1 — durable agent continuity ([ADR-267](adr/267-durable-agent-continuity-contract.md), proposed)

**What is already shipped and needs nothing:** kanban rows are on disk in
`.atmux/state.db` ([ADR-126](adr/126-sqlite-state-store.md)), so *what* was
claimed survives any agent death by construction; a fresh agent self-serves work
via `atmux claim --next --as <member>`
([ADR-007](adr/007-pull-kanban.md)) with no dispatcher; standing decisions live
in `.atmux/decisions.md` ([ADR-008](adr/008-decisions-verb.md)); `atmux handoff`
and `/atmux:session cont` exist
([ADR-263](adr/263-merge-session-preclear-into-handoff.md)).

**The gap ADR-267 addresses:** the *reason* for the rows is not durable. atmux's
only narrative-capture mechanism is `atmux handoff`, which is death-bed and
best-effort — it asks the dying pane for a summary and polls
`ATMUX_HANDOFF_WAIT` seconds (default 30), falls back to a `tmux capture-pane`
tail of `ATMUX_HANDOFF_LINES` lines (default 500), and writes a
`(no pane to capture)` stub when the source window is already gone. And there is
**no append-only progress-note seam**: `atmux task update --body` *replaces* the
body (`--body ""` clears it), and no `--note` flag exists on `atmux task update`
at all.

**Proposed, not shipped** (ADR-267 §D1–§D4):

- `atmux task note <task-id> "<text>" [--as <member>] [--kind plan|progress|blocker|decision|done]`
  plus a read-only `atmux task notes <task-id>`, backed by a new append-only
  `task_notes` table on the next free rung of the
  `src/abstractions/sqlite-migrations.ts` ladder. Append-only by construction —
  no `--edit`, no `--rm`. `tasks.note` and `atmux done --note` are untouched.
- `atmux task show <id>` gains a `notes` array, oldest-first.
- A sixth `atmux groom` sub-op `archiveTaskNotes`, reusing `--kanban-days`, with
  the hard invariant that **notes on a non-`done` Task are never archived at any
  age**.
- A claim→plan obligation in `templates/briefs/member.md`, enforced as a
  **detectable proxy and deliberately not a hard block** — a sixth kanban-hygiene
  detector `plan-missing` in the existing
  [ADR-131](adr/131-superdoctor-kanban-hygiene.md) family, drained by the
  existing `atmux hygiene-tick`, stored in the existing `superdoctor_hygiene`
  table (no extra migration), always `escalate` and never auto-fixed.
- The resume invariant, stated so it is measurable: *every Task in status
  `in-progress` carries at least one `plan` note, so a cold agent resumes without
  reading pane scrollback* — which holds exactly when `plan-missing` reports zero.

**No new daemon, ticker, cron arm, or event topic** — ADR-267 §D4(c) declines all
four, consistent with §1.2 principle 3 as corrected above.

#### 3.6.2 R2 — managed-repo state isolation ([ADR-268](adr/268-managed-repo-state-isolation-enforcement.md), proposed)

**Already decided, not re-decided:** all atmux state lives in the operator's
dotfile tree and is symlinked into each managed repo's `.atmux/`
([ADR-239](adr/239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md)
§Supplement-2026-05-26,
[ADR-244](adr/244-per-repo-pre-commit-kanban-decisions-snapshot.md)
§Supersession-2026-05-26). See §1.2 principle 2 as corrected.

**The gap:** that guarantee is carried by a four-step **manual operator recipe**
and zero lines of code. `src/verbs/init.ts` scaffolds `.atmux/` and writes a real
`.atmux/team.json`; it never touches an ignore file and never creates the dotfiles
symlink. ADR-268 records a fleet audit of the 13 `type: "team"` roots in
`~/.atmux/cockpit.json`: **5 of 13 do not ignore `.atmux/team.json` at all**, and
**1 (`/root/work/ifca/src/tx-root`) has already committed and pushed
`.atmux/team.json`** to an IFCA-org remote — a topology disclosure that no ignore
line can undo, because gitignore has no effect on already-tracked paths.

**Proposed, not shipped** (ADR-268 §D1–§D4):

- An idempotent **isolation step inside `atmux init`**: derive `<repo-key>` from
  the repo-root basename with an inadmissible set forcing `--state-key`, record it
  in a manifest at `~/.atmux/state-keys.json`, and symlink exactly three entries
  — `team.json`, `decisions.md`, `state.db` — into the dotfile tree. `.atmux/`
  itself **stays a real directory** (measured 144 MB `worktrees/` + 184 MB
  `logs/`; a whole-directory symlink would put product-repo git worktrees inside
  the dotfiles repo). **Fails closed** (exit 78) when the dotfile tree is absent —
  it never falls back to writing state into the repo.
- The ignore pattern goes to the **machine-global** `${XDG_CONFIG_HOME}/git/ignore`,
  **not** a product repo's tracked `.gitignore` — because a `.atmux/` line in a
  tracked ignore file is itself a committed, teammate-visible statement that the
  operator runs atmux. `.git/info/exclude` is rejected: verified 2026-08-06 not to
  propagate into linked worktrees, which is exactly where the drivers work.
- A doctor probe **`managed-repo-state-untracked`** in `src/verbs/doctor/git.ts`,
  sibling to `checkWorktreeNestedStateDb`, with two assertions —
  `git check-ignore -q -- .atmux/team.json` exits 0 (asserted on a **concrete
  child path**, never bare `.atmux`, which the shipped `.atmux/*` pattern does not
  match) and `git ls-files -- .atmux` is empty.
- `atmux doctor --sweep-isolation` (read-only, `--apply` to fix), enumerating team
  roots from `~/.atmux/cockpit.json` — explicitly **not**
  `~/.claude/teams/registry.json`, which is stale at 2 entries because
  `init.ts` never upserts it.

#### 3.6.3 R3 — recursive branch ledger ([ADR-269](adr/269-recursive-branch-ledger.md), proposed)

**Already shipped:** the recursive *ops* — `scripts/recursive-{checkout,pull,push,reset}.sh`
surfaced as the `/rcheckout` `/rpull` `/rpush` `/rreset` skills.

**The gap, diagnosed but not filled by
[ADR-035](adr/035-per-member-branch-recursive-ops.md) (accepted 2026-04-29):**
ADR-035 §1 makes `<branch>` mandatory on every recursive script, and its
§Context failure-mode 2 rejects `.gitmodules` as the working-state source of
truth — *"`.gitmodules` cannot capture which member is currently working — it's
a fixed declaration"* — with §4 demoting `branch = ` to a remote-tracking hint
for `git submodule update --remote` SHA bumps, never a checkout target. And then
it **names no replacement**. Confirmed absent 2026-08-06: nothing in `src/schema/` or
`src/core/` records a per-submodule branch. The working state lives in the
operator's head plus the branch string typed into `/rcheckout`.

**Proposed, not shipped** (ADR-269 §D1–§D6):

- Two STRICT tables in the team's `.atmux/state.db` — `branch_ledger` (per-repo
  **observation**: root-relative `repo_path`, `depth`, `head_state` ∈
  `{attached, detached, unborn, uninitialised, absent}`, `branch`, `head_sha`,
  `dirty`, `upstream`, `ahead`/`behind`, `observed_at_sec`) and
  `branch_ledger_intent` (per-lane **intent**: `intended_branch` +
  `trunk_branch`, written only from an explicit source). Current-state upsert, not
  a history log.
- `atmux branches record | show | verify`. `verify`'s exit code is the **number of
  drifting repos**; six named drift classes with `missing-branch` highest, because
  that is the silent one the shipped scripts report as one `WARN:` line inside a
  17-repo sweep and then forget.
- **Detached HEAD is a first-class recorded state, not an error** — ADR-035 §3 is
  explicit that detached-at-the-pinned-SHA after
  `git submodule update --init --recursive` is the *correct* read-only state.
  Detachment is drift only against a recorded intent.
- Write points at the moments branch state actually changes: the four recursive
  scripts (guarded, unable to change their exit code) and after
  `provisionWorktree` in `src/verbs/start.ts` / `spawn-epic.ts` — in the **verb**
  layer, never inside `src/abstractions/worktree.ts`
  ([ADR-096](adr/096-module-taxonomy.md) layering).
- **The anti-inference rule:** the ledger records observations and **never infers
  a checkout target.** No read path from the ledger into any recursive op;
  `<branch>` stays mandatory; replay is deferred to its own decision.
- Naming rule, adopted to avoid load-bearing ambiguity: the new failure class is
  **"branch drift"**, never "lane drift" — `atmux lane-drift-check`
  ([ADR-176](adr/176-epic-aware-lane-drift-revert.md)) is a *different* failure
  class (claimed-but-not-progressing kanban lanes, root-repo-only). The ledger
  sits beside it and does not extend it.

### 3.7 Vox operator interface — `atmux vox` (SHIPPED; deployed read-only)

Design and rationale: [ADR-272](adr/272-voice-operator-interface.md) (Status:
proposed). The name is [ADR-274](adr/274-atmux-vox-rename.md): the feature
shipped as `atmux voice` and was renamed to **vox** on 2026-08-16, which is why
ADR-272 and ADR-273 still carry the old word in their titles — the ADR tree is
append-only and an ADR is named for what it decided when it decided it.
Operating surface + acceptance checklist:
[docs/RUNBOOK-vox.md](RUNBOOK-vox.md).

**What it is.** A spoken operator interface for the fleet. The chain is
**phone PWA → WebSocket relay on the operator's box → realtime AI provider →
`atmux` verbs**. The provider is a transducer between speech and the CLI: it
holds the conversation and decides *which* tool to call, and the server decides
what is permitted and runs it. Every tool the model can call is an `atmux` verb
invocation built as an argv array — never a composed shell string, never
`sh -c`, and there is no `run_command` or `eval` in the catalog ([ADR-272](adr/272-voice-operator-interface.md)
§D2). Deleting the vox subsystem removes a microphone, not a capability:
everything it exposes is already reachable from the operator's terminal.

**Who it is for.** One person — the operator — away from the desk, often
one-handed: walking, in a lift, in a car. It is deliberately not a multi-user
surface. Exactly one vox session is active at a time, takeover is
latest-wins, and a dropped phone parks the provider leg for 90 seconds so
walking into a lift does not end the conversation (§D8). The motivation is
coordination, not convenience: under manual orchestration
([ADR-260](adr/260-manual-orchestration-mode-default.md)) the operator and the
lead LLMs *are* the scheduler, so an operator who cannot be reached is a
missing scheduler rather than a missing luxury.

**What it can do today.** The catalog is **16 tools — 12 read + 4
messaging** (§D6 plus [ADR-273](adr/273-voice-fleet-triage-and-pane-input.md) D1):

| Class | Tools | Gate |
|---|---|---|
| Read (12) | `list_teams` · `fleet_overview` · **`fleet_attention`** · **`fleet_quiet`** · `team_status` · `team_health` · `list_tasks` · `member_pane` · `driver_inbox` · `lead_outbox` · `cost_report` · `list_blockers` | none — no side effects |
| Messaging (2) | `tell_lead` · `add_task` | none — append-only and visible |
| Messaging (2) | `dispatch_task` · `claim_task` | **confirm-gated** (§D7) |

**The triage pair is what makes it usable day to day.** The other reads answer
*point* questions; the operator's actual question — "what needs my attention
across everything, and what doesn't?" — used to cost roughly twenty teams times
several panes in spoken round trips, and still came back as state labels rather
than what an agent is stuck on. `fleet_attention` returns every pane that needs
him, ranked, each carrying the evidence that classified it; `fleet_quiet`
returns the aggregated all-clear, which exists so an empty attention list is
*checkable* rather than indistinguishable from a broken sweep. Both are
read-only, so both survive the read-only deployment below — that is why the
survey half ships before any ability to type into a pane. A full sweep of the
real fleet takes about a tenth of a second.

**What it cannot do today — the deployed posture is read-only.** The live
deployment runs with `ATMUX_VOX_READONLY=1`, so **only the 12 read tools
exist as far as the model is concerned**: the 4 messaging tools are filtered
out of the catalog handed to the provider (`src/verbs/vox.ts`), and the tool
bridge independently refuses any mutating call with a `readonly_mode` error
(`src/core/vox/tool-bridge.ts`) as a second layer. **Vox can therefore read
the fleet and change nothing.** Clearing the flag is phase P7 and is a
deliberate, separate step — the flag carries an [ADR-266](adr/266-shim-sunset-policy-and-first-sweep.md)
sunset marker.

Also absent by design in v1: **no `spawn` / `stop` / `kill` and no git verb**
(a misheard word there is unrecoverable — deferred to their own ADR with a
second factor); **no wake word** — turn-taking is **push-to-talk**, not
continuous VAD, so the microphone is not always-on; **no proactive narration**
— the assistant speaks when spoken to; **no service worker**, so the PWA
installs to the home screen but has no offline mode (§D11 — a cached client
speaking a stale binary protocol is the failure it refuses to buy).

**Privilege, stated plainly.** The server sets `ATMUX_CALLER_SCOPE=driver` on
every verb it invokes (§D3), so **whoever reaches the WebSocket is the
driver.** That is why authentication is layered — an `oauth2-proxy` vhost, a
`≥32`-char `ATMUX_VOX_TOKEN` compared timing-safely *before* the WebSocket
upgrade, a `hello` re-assertion plus an `Origin` allowlist (the CSRF defense —
browsers do not apply same-origin policy to WebSocket handshakes), a loopback
bind so only nginx can reach the port, and the read-only kill switch above.
API keys never leave the box: the transport is a server-side relay
specifically so provider credentials are never placed on a phone.

**Verb surface.** `atmux vox [--serve|--supervise|--status|--stop]
[--port <n>] [--provider <p>] [--model <m>] [--readonly]`. `--supervise` runs
the server inside a dedicated detached `atmux-vox` tmux session under a
crash-loop wrapper with a circuit breaker; it is operator-started and starts
nothing at boot ([ADR-233](adr/233-cron-auto-install-disabled-trust-orchd.md)).

**Both pre-rename names still work for one release, and they warn**
([ADR-274](adr/274-atmux-vox-rename.md) §D2–§D3, per
[ADR-266](adr/266-shim-sunset-policy-and-first-sweep.md) §D1). `atmux voice` is
a working alias for `atmux vox` that prints a deprecation line to stderr, and
`ATMUX_VOICE_*` is still read as a **fallback** wherever the `ATMUX_VOX_*`
equivalent is unset, also warning; `ATMUX_VOX_*` wins when both are set. Both
carry `SUNSET(v0.9.1)` markers and go in that release. The env fallback is the
load-bearing half — `ATMUX_VOICE_TOKEN` is exported in shells that are already
open, so without it the first launch after the rename fails with
`ATMUX_VOX_TOKEN is required`, a message that does not name its own cause.
Deliberately *not* renamed: the hostname `atmux.geoy.ws` (the host name is not
the feature name) and the token's value (rotating a working credential during a
rename makes a failure ambiguous).

**Half of [ADR-273](adr/273-voice-fleet-triage-and-pane-input.md) is shipped.**
Its survey half — fleet triage (`fleet_attention` / `fleet_quiet`) — is in the
catalog, taking it from 14 to 16; both are read-only, so both work under the
read-only flag, which is why that half went first.

**Not shipped — pane input.** `pane_nudge` / `pane_send` (typing into a wedged
agent's pane) do not exist in the catalog, and would in any case be absent under
the read-only flag. `pane_send` additionally carries an undecided open question
(whether it needs a second factor) that ADR-273 marks as required before it can
ship — typing arbitrary text into an agent with full tool access is an unbounded
capability, unlike every bounded mutating tool in v1.

---

## 4. MVP shipped (v1 = bash atmux pre-cutover)

### 4.1 Committed at branch HEAD

Per `PLAN.md` §2 "Scope (frozen at the worktree's checked-in `lib/**`)":

- **30 verbs**, ~3500 LOC across **27 lib/*.sh files**. No file >355 LOC;
  no godfiles.
- **24 .bats specs** (23 unit + 1 e2e `lifecycle.bats` with 11 sequenced
  scenarios). 22/27 libs covered; 5 zero-coverage libs: `attach`,
  `dashboard`, `inbox`, `reconfigure`, `rotate`.
- **External tooling surface:** `tmux` (45 calls / 11 subcommands), `jq`
  (157 calls), `curl` (2 — Discord webhook + doctor health check),
  `flock` (2), `mktemp` (5), `date` (8), `command -v` (7). Zero usage of
  socat / nc / ss / lsof / pgrep / pkill / setsid / nohup / gh / wget.
- **6 ADRs** (parent repo `docs/adr/001`–`006`); 50 ADRs total in parent
  including the WIP-bash decisions; 32 ADRs in worktree-local
  `docs/adr/` for the Bun port.

### 4.2 In-flight WIP (not yet at HEAD; Phase 5 catch-up scope)

`/root/work/src/atmux/lib/` (main checkout's working tree) contains
substantial WIP not committed to HEAD per `PLAN.md` §2:

- `super-*.sh` (super-arbitrate / super-epic / super-reply / super-status
  / super-tell / super-whip / superdriver-audit)
- `drive.sh`, `socket-pubsub.sh` (the ADR-042 event-driven path),
  `team-migrate-to-cage.sh`, `team-repair-rename.sh`,
  `tmux-conf-restore.sh`
- Topology ADRs 016 / 026 / 044 / 045 / 046 (cage-socket variants,
  default-socket driver, underscore separator, cockpit viewer)

These port in **Phase 5** *after* they land in bash. Porting WIP would
chase a moving target.

---

## 5. Roadmap

Phase ordering verbatim from `PLAN.md` §5; gates from §14 (auto-progression
rules). No calendar-pinned durations — phases advance on functional gate
satisfaction.

| Phase | Owner(s)                                    | Deliverable |
|-------|---------------------------------------------|-------------|
| **0 — Architecture** | lead + architect                | Bun project skeleton, ADRs 001–014, type contracts, parity harness skeleton, CI gates. **✅ shipped.** |
| **1 — Foundation**   | foundation porter + reviewer + tester | 8 abstraction modules + 4 core libs ported, 100% unit coverage, parity harness operational. **✅ shipped.** |
| **2 — Verb porting (parallel, 1:1 parity)** | porter-A + porter-B + reviewer + tester | All 23 domain verbs ported with identical names + args + behaviour. **✅ shipped.** |
| **3 — Functional parity validation** | tester + auditor + lead | Parity harness green across cron-fired + interactive verbs. **🚧 in progress (Phase 3 iter-2 closed; Phase 4 RUSH expansion underway across 5 lanes).** |
| **4a — Phase 3 close (parity matrix expansion)** | 5 lane porters | ADRs 028–032 scoped; rows landing per-lane. **🚧 in progress.** |
| **4b — V-26 + V-27 ports** | session-impl + team-impl | `session` (cont/handoff/stop) + `team` (start/stop/add/clear/cleanup/bootstrap/rotate-lead/rotate-member). **⏳ pending Phase 4a close.** |
| **4c — Cutover** | lead, driver mechanical              | `atmux-bun` → `atmux` rename, bash → `atmux-legacy`, all 4 teams' cron updated, CHANGELOG + Discord announce. **v1 ships here.** |
| **5 — WIP catch-up** | foundation porter + porter-A       | Port super-*, drive, team-migrate-to-cage, repair-rename, tmux-conf-restore, socket-pubsub. |
| **6 — v2 verb redesign** | architect + porter-A + porter-B + reviewer | Per ADR-014: subcommand structure (`task <sub>`, `member <sub>`), `member rm/rename` (closes API gap), drop `up` / `reconfigure`, deprecation aliases for ~3 months, then removal in v3. **v2 ships here.** |

### 5.1 Phase 4 RUSH lane decomposition (NOW)

Per `HANDOFF.md` "PHASE 4 RUSH". Five concurrent lanes; one reviewer
gates all:

| Lane | Owner | Scope ADR (worktree-local) | Verbs / scenarios |
|------|-------|---------------------------|-------------------|
| Cron-fired | parity-cron-impl | `docs/adr/121` | `whip` / `report` / `decisions digest` / `groom` × prod-team state shapes |
| State-mutating | parity-state-impl | `docs/adr/122` | `dispatch` / `inbox-update` / `done` / `claim` / `reply` / `tell-lead` / `handoff` (× INSERT/UPDATE/DELETE classes) |
| Read-only | parity-read-impl | `docs/adr/123` | `status` / `doctor` / `dashboard` / `inbox-read` / `cost` |
| Lifecycle | up-impl | `docs/adr/124` | `up` / `start` / `stop` / `pause` / `resume` / `attach` / `rotate` / `reconfigure` |
| Error-class | whip-impl | `docs/adr/125` | Extends ADR-027 masks across all error paths |

PLAN.md §14 acceptance: zero divergence on stdout / exit / state /
discord webhook calls. Functional gate, not row-count. Lanes optimize
for COVERAGE; lane-trim if velocity stalls.

### 5.2 V-26 + V-27 sequencing — folded into Phase 4b

Per `HANDOFF.md` "V-26 + V-27 sequencing — lead's answer (defended)":
ADR-021 §1 contract ("atmux exposes the full coordination surface;
skill becomes a 1-page shell shim") is hollow without V-26 + V-27
ported. Post-cutover, `/coordination:session` + `/coordination:team`
skills must call atmux verbs that EXIST. Folding into 4b avoids skill
breakage at cutover.

### 5.3 Multi-tier fallback chain (kanban `t-706655ee`)

When all team members hit Claude Max budget (whip's ADR-049 budget-pause
fires), work stops dead until 5h/wk window refresh. Multi-tier fallback
extends throughput by spawning lower-tier executors in caged tmux +
dedicated Linux users:

| Tier | Executor | Model | Linux user | Git access | Write scope |
|------|----------|-------|------------|------------|-------------|
| 1 | Claude Code | claude-opus-4-7 (xhigh) | operator | Full | Anywhere |
| 2 | Cursor | composer-2 | operator | Full | Anywhere |
| 3 | Kimi | kimi-cli | `kimi-agent` (dedicated) | **None — no .git in workspace** | Their workspace dir only (kernel-enforced) |
| 4 | MiniMax | (CLI when available) | `minimax-agent` (dedicated) | Same as Tier 3 | Same as Tier 3 |

Mutative git is reserved for Tiers 1 + 2. Operator reviews Tier 3+ work
and rsyncs files back manually OR routes to Tier 1/2 for commit on
resume. Kernel-enforced isolation (no `.git` in workspace + setfacl-rX
on project) beats a git-shim wrapper because syscall-level perms can't
be PATH-bypassed.

ADR-050 (planned) documents the chain ordering, per-tier policy table,
prior-incident rationale for Kimi/MiniMax isolation, and the resume
reconciliation flow. Implementation owner TBD — likely an ops-lane
porter; not docs-lane.

### 5.4 Post-cutover (Phase 5+)

- Phase 5: WIP-bash catch-up (super-*, drive, socket-pubsub, etc.).
- Phase 6: v2 verb redesign per ADR-014. Subcommand structure;
  `member rm/rename` (closes API gap); deprecation aliases for 3 months
  before removal in v3.

### 5.5 2026-08-06 operator ask — R1 / R2 / R3 (ADR-proposed; not phase-gated)

Added 2026-08-06. These three items do **not** sit in the Phase 0–6 ladder above
— that ladder tracks the bash → Bun port, which is orthogonal. They are
requirement areas from a single operator ask on 2026-08-06, each with its own
ADR at **Status: proposed**. Surface detail is in §3.6; business intent is in
[docs/brd/atmux.md](brd/atmux.md); open questions are in §10.5–§10.7.

| Item | Deliverable | ADR | Status 2026-08-06 |
|---|---|---|---|
| **R1 — durable agent continuity** | `atmux task note` + `task_notes` table + `notes` in `task show` + `archiveTaskNotes` groom sub-op + `plan-missing` hygiene detector + brief/skill amendments | [ADR-267](adr/267-durable-agent-continuity-contract.md) | **proposed.** No reviewer signoff. ADR-267 phases the instruction leg (brief text, zero code) ahead of the schema + detector legs. Blocked on OQ-7 (epic-team cages own their own `state.db`, so the detector would emit false `plan-missing` findings on parent-team Tasks whose work happens in a child cage) — that must be decided before the detector ships. |
| **R2 — managed-repo state isolation** | `atmux init` isolation step + machine-global excludes patterns + `managed-repo-state-untracked` doctor probe + `atmux doctor --sweep-isolation` | [ADR-268](adr/268-managed-repo-state-isolation-enforcement.md) | **proposed.** No reviewer signoff. Carries one **realized leak** to remediate independently of the code: `/root/work/ifca/src/tx-root` has `.atmux/team.json` committed in `c82add0` and pushed to an IFCA-org remote. `git rm -r --cached .atmux` + commit stops future tracking; the blob stays in pushed history, and rewriting a pushed IFCA-org branch is out of scope and needs explicit operator authorization under the push policy. |
| **R3 — recursive branch ledger** | `branch_ledger` + `branch_ledger_intent` tables + `atmux branches record\|show\|verify` + `checkBranchLedgerDrift` doctor probe + write hooks in the four recursive scripts and after `provisionWorktree` | [ADR-269](adr/269-recursive-branch-ledger.md) | **proposed.** No reviewer signoff. ADR-269 §Phasing: Phase 0 is the ADR + `docs/RUNBOOK-branch-ledger.md` + pure types/functions only (no migration, no verb, no behaviour); Phase 1 is the migration + verb + probe + write points, with traversal wall-clock measured on `ix-root` (39 repos — 38 declared submodules + root — at depth 3, the fleet worst case per ADR-269 §OQ-1) **before** any cadence is armed. ADR-269 §Phasing rules `property-root` out as a measurement target: 14 submodules, recursive count equal to top-level, i.e. depth 1. |

**Two cross-cutting sequencing facts, stated once so neither is discovered late:**

1. **Migration-rung collision.** ADR-267 (`task_notes`) and ADR-269
   (`branch_ledger` + `branch_ledger_intent`) both add rungs to the single
   append-only ladder in `src/abstractions/sqlite-migrations.ts`, whose highest
   landed rung as of 2026-08-06 is `to: 17`. Both ADRs explicitly yield to
   whichever lands first and take the next free pair. The ladder stays monotonic;
   no landed `up` body is ever edited. Re-derive the rung at implementation time
   with one `rg` — do not trust a number pinned in an ADR written before its
   sibling landed.
2. **R2 is a prerequisite for R3's output being safe, and R3 needs nothing new
   for it.** ADR-269's ledger rows spell out lane topology and cross-product
   branch names (`px-crm-geoyws-driver-2`, sibling-product submodule paths) —
   precisely the artifact class BR4 forbids a teammate cloning `property-root`
   from seeing. Because the ledger lives in `.atmux/state.db`, it inherits the
   ADR-239 / ADR-244 operator-private residency with **zero new mechanism**. R2's
   enforcement work is therefore what makes R3's output safe by construction
   rather than by convention.

---

## 6. Multi-tier resilience contracts

### 6.1 LLM judge cascade (ADR-116, worktree-local)

Sonnet → Haiku → deterministic fallback. Resilience contract for the
SOFT classifier (whip's rate-limit triage) and future judge call sites
(reviewer / planner judgments).

### 6.2 Claude Max budget watcher (ADR-049, parent repo + 2026-05-06 ADDENDUM)

Layer 1 (OAuth probe via `api.anthropic.com/v1/messages` headers) is the
authoritative source; Layer 2 (status-bar regex parse) is fallback when
probe fails; Layer 3 (banner detection per ADR-023) is the always-on
safety net.

Per the ADDENDUM: status-bar parsing was the original truth source but
was wrong — the bar is repainted on response, not real-time. Live
incident 2026-05-06: panes showed `lead: 5h 4% / wk 0%` while API truth
was `5h 75% / wk 97%` remaining. Layer 1 now leads; Layer 2 fallback;
config under `team.json:.whip.{budgetPauseThreshold,budgetResumeThreshold}`
(default 10/20 percent with hysteresis).

### 6.3 Bare window names (ADR-048, parent repo)

Window naming dropped the `__<team>__` prefix in favor of bare
`<emoji><member>` per ADR-048. Live teams using opt-in flag: `atmux-bun`
(this team) + `ifca_aux`. Hot-reload supported via `atmux reload`.

Cross-reference: `.atmux/notes-adr-048.md` for the branch-owner handoff
detail (lib edits in main checkout's `atmux-geoyws` branch).

---

## 7. Coordination model

### 7.1 Driver / lead / planner / workers

| Position    | Window | Default TUI | Purpose |
|-------------|--------|-------------|---------|
| Driver      | — (external)         | any           | Relays human intent via `atmux tell-lead` + `atmux send` |
| Team-lead   | 1                    | claude        | Routes asks + dispatches; never plans itself |
| Planner     | 2                    | claude        | Decomposes asks into kanban tasks + writes ADRs |
| Reviewer    | 3                    | claude        | Reviews diffs, approves commits |
| Committer      | 4                    | claude        | **Two modes (auto-detected from `team.json`)**: (a) **single-trunk mode** when `worktreeIsolation: false` OR `autoMerge.enabled: false` — only member allowed to commit + push (per pull-model brief); (b) **auto-merge mode** when `worktreeIsolation: true` AND `autoMerge.enabled: true` per [ADR-134](adr/134-in-team-auto-merger.md) — watches `<base>-<member>` branches, auto-merges to base on task-done events via socket-pubsub + 10min cron backstop (`atmux cron-install --template committer-sweep` per ADR-134 T7), runs the 9-state machine (`open → in_progress → ready_to_merge → rebasing? → merging → tested → merged|test_failed → reverted`) with BEGIN IMMEDIATE transactions, 3-way conflict surface (state.db → atmux flag → Discord `[merge-conflict]`), and post-merge test gate via `team.json::autoMerge.testCommand` (default `bun test`). Workers self-commit on their own branches in auto-merge mode; committer owns only the merge layer. |
| Devops      | 5                    | claude        | Deploys, env, CI/CD, infra |
| Dba         | 6                    | claude (opt)  | Schema + migrations + data integrity |
| Ombudsman   | (event-driven)       | claude (opt)  | Per-team complaint adjudicator per [ADR-147](adr/147-ombudsman-and-release-notes.md) §D1. Reads open complaints, triages → epic / wontfix / resolved / defer, appends day-file entry under `docs/release-notes/<Y>/<M>/<Y-M-D>.md`. **Event-driven** (sentinel `.atmux/state/ombudsman-pending.json` + 15min cron tick); NOT in whip cadence (ADR-147 §D2). |
| Members     | 7+                   | any           | Parallel throughput per feature lane |

Driver ↔ lead routing: file-based (`~/.claude/teams/<team>/driver-inbox.md`)
to avoid the `SendMessage` self-loop bug per `~/.claude-ifca/CLAUDE.md`
"Driver→Lead routing is via file, not SendMessage."

### 7.2 Pull kanban (ADR-007 + ADR-031, parent repo)

Workers `atmux claim --next --as <member>`. Selection: `priority`
ascending, then `createdAt` ascending. Tasks with non-`done` deps are
skipped automatically. Cross-lane fallback when a lane is dry
(`crossLaneClaim=true` default); REVIEW-lane carve-out (ADR-031).

EPICs additionally carry `depends_on` (epic-id list) and `is_ready` (0/1
kick-off bit) per [ADR-225](adr/225-epic-dependencies-and-is-ready-toggle.md);
`team spawn-epic <eid>` consults an eligibility predicate (all deps done +
`is_ready=1`) and refuses on unmet deps with a `--force` override. Two
events (`epic.unblocked`, `epic.ready`) ship per ADR-203 §D2 amendment.

### 7.3 Socket-driven messaging (ADR-032, parent repo)

Supervisor-injected keystrokes between turns (event-type prefixed):

- `📨 [task-done-cascade]` — deps-upstream Task landed; new claimable work.
- `📨 [dispatch]` — manual priority-override dispatch to inbox.
- `📨 [send]` — ad-hoc cross-member context.
- `📨 [tell-lead]` / `📨 [reply]` / `📨 [decisions-add]` / `📨 [flag-add]` — channel-specific events.

Migrate-grade preflight gates every injection; mid-turn `Compacting` /
queued-message / rate-limit-banner all defer to the next idle window.
State files (`atmux inbox`, `kanban.json`) remain the source of truth;
events are an optimization.

---

## 8. Quality gates

### 8.1 Per-commit reviewer (PLAN §9)

Eight checks, all green:

1. `bun typecheck` (`tsc --noEmit`).
2. `bun test --coverage` — 100% on touched files.
3. `biome lint` + `biome format`.
4. `bun test:parity:<verb>` for any verb touched.
5. **No silent error swallows** — regex check for `catch.*{\s*}` and
   `.catch(\s*()\s*=>\s*null)` without inline `// expected:` reason.
6. **Schema discipline** — no raw `JSON.parse` in domain code; all I/O
   via `src/schema/<file>.ts`.
7. **ADR compliance** — new modules under `src/` reference an ADR (or
   open one).
8. **Conventional commit** — title matches
   `^(feat|fix|chore|refactor|test|docs)(\(.+\))?:`.

### 8.2 100% narrowed unit coverage (CLAUDE.md test discipline)

Narrowed denominator: domain verb handlers, abstraction modules
(`tmux/json/http/lock/fs/time/spawn/discord`), core libs, schema
validators, error helpers. Excluded: generated types, fixture data,
barrel re-exports, CLI dispatcher boilerplate (e2e covers).

### 8.3 Parity harness (ADR-119 / 027, worktree-local)

Per verb: bash + TS run against identical fixture state; semantic diff
on stdout / exit / `.atmux/` state / Discord webhook calls.
Channel-mask config (ADR-120) handles stylistic divergence
(error-rendering, state-after non-determinism); semantic divergence
gated.

Phase 3 lane scope ADRs:
- `docs/adr/121` — cron-fired (whip / report / decisions-digest / groom)
- `docs/adr/122` — state-mutating (dispatch / inbox-update / done / claim / reply / tell-lead / handoff)
- `docs/adr/123` — read-only (status / doctor / dashboard / inbox-read / cost)
- `docs/adr/124` — lifecycle (up / start / stop / pause / resume / attach / rotate / reconfigure)
- `docs/adr/125` — error-class expansion across all verbs

### 8.4 Stateful e2e specs (CLAUDE.md test discipline)

`tests/e2e/lifecycle.test.ts` ports `lifecycle.bats` block-for-block
(one `test()` per `@test`). Stateful, non-idempotent — 1× cold-start +
walk. Documented in spec header docstring per CLAUDE.md "Testing
Discipline."

---

## 9. Cost + budget tracking

### 9.1 Per-member USD / token attribution

`atmux cost [--member <m>] [--since <t>] [--json]` parses
`~/.claude/projects/<slug>/<uuid>.jsonl` for assistant-message `usage`
blocks, sums against a pricing table, attributes per-member by `cwd`.
Configured in `team.json:.budget`.

### 9.2 Claude Max budget watcher (ADR-049)

See §6.2 above. Lay 1 OAuth probe is authoritative; per-account, not
per-pane. Cache TTL via `ATMUX_BUDGET_PROBE_TTL` (default 240s, just
under 5min cron). Multi-account via `team.json:.members[].claudeAccount`
+ `~/.claude-<account>/.credentials.json`.

---

## 10. Open questions / decisions log

### 10.1 Pending decisions

`.atmux/decisions.json` is the live cursor. `atmux decisions list`
surfaces unresolved entries; `atmux decisions digest` posts the
consolidated Discord digest every 4h via cron.

### 10.2 V-26 + V-27 sequencing

Folded into Phase 4b per `HANDOFF.md` defense. Override path: George
can pin to Phase 5 if he wants a tighter cutover window — costs
dogfooding seamlessness. Lead recommends 4b; default-yes per CLAUDE.md
"lead applies recommended defaults."

### 10.3 Multi-tier fallback chain implementation owner

Kanban task `t-706655ee` is currently un-laned. Implementation spans
`scripts/provision-fallback-user.sh` + `lib/fallback-cage.sh` +
`tests/e2e/fallback-cage.test.ts` + ADR-050. Likely ops-lane porter +
docs-lane (ADR only). Lead routes assignment.

### 10.4 Doc hosting

Planned at `https://atmux.u-n-u-m.com` (per CLAUDE.md DNS table —
u-n-u-m.com co-tenants atmux + Unum). VitePress generator recommended
(TS-friendly, Vite-built, light). Per-host LE cert (no wildcard on
u-n-u-m.com). nginx site at `/etc/nginx/sites-enabled/atmux-docs.conf`;
build pipeline cron-pulled from main HEAD. Awaiting lead green-light;
DNS / TLS / nginx commands driver-coordinated (per docs-lane guardrails:
no flarectl / certbot / nginx without explicit ack).

### 10.5 R1 — how strongly can the claim→plan obligation be enforced? (open)

*Added 2026-08-06 from [ADR-267](adr/267-durable-agent-continuity-contract.md).*

**The core question, unresolved by design in v1:** atmux can create a durable,
cheap plan-recording seam. It **cannot compel an agent to write to it.** ADR-267
§D2 therefore rejects a hard gate on `atmux claim` / `atmux task move <id>
in-progress` outright — not deferred, rejected — for three reasons: (a) a gate
that requires *a* note is satisfied by *any* note, which is Goodhart, the same
move as raising a coverage threshold to meet coverage; (b) blocking a claim wedges
the [ADR-007](adr/007-pull-kanban.md) pull model, and a dormant member is strictly
worse than an unplanned claim; (c) some claims fire before any agent is in the
loop (first-turn bootstrap, lane-tick), where there is nobody present to author a
note. What ships instead is a **detectable proxy** — the `plan-missing` hygiene
finding — plus a **reviewer comment**, explicitly *not* a third fail-state
alongside code-without-tests and code-without-doc-update.

Still open:

1. **Does detection-plus-surfacing actually change behaviour?** The named failure
   mode is a *silent* regression: nothing errors, and the only symptom is a rising
   `plan-missing` count. ADR-267 §Consequences states the sharp version — *"if the
   surfacing leg is skipped, this ADR ships a metric nobody reads and the
   operator's original problem is unfixed while appearing addressed."* The finding
   must reach a lead via the existing
   [ADR-010](adr/010-atmux-flag.md) → [ADR-214](adr/214-retire-ombudsman-lead-absorbs-complaint-adjudication-via-honker.md)
   path, not merely land in `superdoctor_hygiene`. **This is the implementation
   step most likely to be dropped and most damaging to drop.**
2. **`planGraceSec`** — recommended 900 (15 min) as the age gate before
   `plan-missing` trips. Untested; measure real claim→first-note latency on a live
   team before pinning.
3. **Goodhart on note *content* has no v1 mitigation.**
   `atmux task note t-x --kind plan "will fix it"` satisfies the detector, which
   counts rows and cannot judge content. LLM scoring of note quality is out of
   scope ([ADR-237](adr/237-no-llm-discord-and-whip-removal.md) forbids
   time-driven LLM cycles, and a quality judge is the next thing to be gamed). The
   reviewer reading the note is the only quality signal, and it is a comment.
4. **Epic-team cages own their own `state.db`** (ADR-267 OQ-7) — so a parent-team
   Task whose work happens in a child cage shows **zero** notes in the parent, and
   the first `hygiene-tick` run would emit false `plan-missing` findings on every
   such parent Task. Needs a decision — parent Task exempt while a child cage owns
   it, versus fan-in writing a summarising note back — **before the detector
   ships**. This is an implementation blocker, not a nice-to-have.
5. **Two disjoint handoff artifacts exist today.** `atmux handoff` writes
   `.atmux/handoff/<from>-to-<to>-<ts>.md` (singular `handoff`; verified on disk
   2026-08-06 — `.atmux/handoffs` does not exist), while `/atmux:session cont`
   reads `~/.claude/projects/<project-slug>/todo/<branch>/handoff.md`. Neither path
   probes the other, so **the resume path never reads the handoff verb's output.**
   ADR-267 §D3a proposes a one-line skill amendment with no code change; until it
   lands, the gap stands.
6. **Per-Task note soft cap** — recommended 50, warning-only and never a refusal
   (refusing the append is refusing the durability). Should exceeding 3× the cap
   escalate to its own hygiene finding, or stay advisory forever?

### 10.6 R2 — whole `.atmux/` or individual files symlinked into managed repos? (proposed answer: individual)

*Added 2026-08-06 from [ADR-268](adr/268-managed-repo-state-isolation-enforcement.md).*

[ADR-239](adr/239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md)
§Supplement-2026-05-26 left this explicitly out of scope
(*"Out-of-scope for this supplement: kanban.sqlite + decisions.md storage"*).
ADR-268 §D1b proposes resolving it as **per-entry symlinks over a frozen
three-entry set** — `team.json`, `decisions.md`, `state.db` — with `.atmux/`
itself remaining a **real directory**. The reasoning is measured, not aesthetic:
in atmux's own `.atmux/` on 2026-08-06, `worktrees/` is **144 MB** and `logs/` is
**184 MB**, so a whole-directory symlink would place full product-repo git
worktrees *inside the dotfiles git repo* (nested checkouts that `dotfiles push`
would then try to commit) and push roughly 330 MB of churn per team into the
snapshot path. Lock files are machine-local mutexes and must not be shared across
machines through a synced tree.

Still open:

1. **Does the operator's `dotfiles push` bootstrap already deploy
   `_dotfiles/git/ignore` to `${XDG_CONFIG_HOME}/git/ignore`?** ADR-268 §D1d makes
   the machine-global excludes file the load-bearing mechanism (verified
   2026-08-06 to propagate into linked worktrees, where `.git/info/exclude`
   verifiably does **not**), and relocates it into the dotfile tree so it is
   snapshotted. Verified 2026-08-06: `/root/.config/git/ignore` is a plain local
   file, not a symlink, and not tracked in the dotfiles repo — so today the whole
   guarantee dies with the box. If the bootstrap has no hook for `_dotfiles/git/`,
   that is a dotfiles-side change the operator owns, and `atmux init` must degrade
   to warning that the excludes file is not snapshotted rather than silently
   depending on it. **Untested — verify.**
2. **WAL / SHM sidecars for a symlinked `state.db`.** `state.db-wal` and
   `state.db-shm` follow the resolved symlink target and materialize inside the
   dotfile tree. Does a `PRAGMA wal_checkpoint(TRUNCATE)` need to run before
   `dotfiles push`, and does the dotfiles repo already ignore `*-wal` / `*-shm`?
   A push taken mid-write otherwise snapshots a DB whose latest pages exist only
   in an uncommitted WAL. **Untested — verify.**
3. **Explicit `atmux start` is not gated by the probe.** Bare `atmux` / `atmux up`
   runs `doctor --quiet` and throws before starting, so a red isolation row stops
   that path — but `atmux start`'s doctor preflight body is deferred and runs no
   probes. An operator who always types `atmux start` will not see the probe until
   they run `atmux doctor` or the sweep. Wiring that body changes the start path
   for every existing team and ADR-268 declares it out of scope, so it needs its
   own decision.
4. **`dotfiles push` remains the only snapshot cadence and nothing verifies it
   ran.** Isolation protects teammates from the operator's artifacts; only
   `dotfiles push` protects the operator from machine death. No §6 success measure
   in [docs/brd/atmux.md](brd/atmux.md) currently observes snapshot freshness —
   BRD §7.4 records that as a gap, not a solved problem.
5. **A diverged real-file-vs-dotfiles pair is refused, not auto-resolved.**
   Verified 2026-08-06 on atmux's own team: in-repo `.atmux/team.json` (mtime
   2026-07-28, 3 drivers) versus `~/.atmux/atmux/team.json` (mtime 2026-06-12, 5
   drivers). Two sources of truth six weeks apart, with the live one being the copy
   `dotfiles push` does *not* snapshot. ADR-268 refuses and prints both paths
   rather than picking, because an automated pick silently discards six weeks of
   roster edits — so **this one needs an operator action, not a code path.**

### 10.7 R3 — ledger staleness: an observation is not a lock (open)

*Added 2026-08-06 from [ADR-269](adr/269-recursive-branch-ledger.md).*

**The structural limit, stated so nobody designs against a stronger claim:** the
branch ledger records an **observation**, never a lock. Nothing stops a bare
`git checkout` in one submodule one second after `atmux branches record`. The
ledger makes drift *detectable*; it never *prevents* it. Consequently
`observed_at_sec` is **mandatory reading for every consumer** — any code path that
treats a `branch_ledger` row as current state without checking its age is wrong.
[docs/brd/atmux.md](brd/atmux.md) non-goal 7 is the governing principle: if the
ledger and `git` disagree, **git is right and the ledger is stale by definition**;
a ledger trusted as authoritative-by-write becomes a confident liar.

Still open:

1. **What staleness threshold makes the doctor row useful rather than noisy?**
   ADR-269 §D6 splits the surfaces deliberately — the doctor probe
   `checkBranchLedgerDrift` **reads the ledger only and does not re-walk** (keeping
   doctor cheap), and emits a YELLOW *"ledger stale — run `atmux branches
   record`"* row past a threshold; the expensive live re-walk stays
   `atmux branches verify`'s explicit job. The threshold value is unset.
2. **Traversal wall-clock is unmeasured.** A 17-submodule monorepo is 18 repos ×
   roughly four `git -C` spawns ≈ **72 process spawns** per `record` or `verify`.
   This is the direct reason v1 arms **no cadence** (no orchd ticker, no cron) —
   [ADR-260](adr/260-manual-orchestration-mode-default.md) makes manual the
   default anyway. Measure on `property-root` before arming anything; if it
   exceeds a few seconds, `record` grows a `--shallow` mode recording branch + SHA
   only. **Untested — verify.**
3. **`ahead` / `behind` are fetch-stale by construction** — `record` deliberately
   performs no `git fetch`. The numbers are relative to whenever that repo last
   fetched, which the ledger does not currently record, so the `unpushed` drift
   class is warn-only. Should the ledger record a per-repo `last_fetch_sec` so
   those numbers carry their own staleness? One extra call per repo for a real
   honesty gain; ADR-269 leans yes but defers it out of Phase 1.
4. **Script-copy drift silently disables the write points.** Per ADR-035 §2 the
   four `scripts/recursive-*.sh` are **copied per-team** into each managed
   project's `scripts/`, so ADR-269's record hook reaches `property-root` /
   `crm-react` / `sopx` only when the operator re-copies them. Until then that
   repo's `/rcheckout` records nothing and its ledger goes stale silently — the
   staleness doctor row is the *only* signal. A probe diffing a managed repo's
   scripts against the atmux canon would catch it, but ADR-035 §2 deliberately
   permits per-team script adaptation, so a naive hash comparison false-positives.
   Needs its own small decision.
5. **`lane` for work done directly in a team-root repo with no worktree
   isolation** — the literal `operator` sentinel is proposed. Confirm against how
   the operator actually works in `crm-react` before Phase 1 freezes it.

---

## Appendix A: ADR index

### Parent atmux repo (`/root/work/src/atmux/docs/adr/`, 1–49)

Critical ADRs with active behavior:

- **ADR-001** — Planner role (canonical staff role; team-lead never plans).
- **ADR-007** — Pull-kanban hierarchy (epic / story / task).
- **ADR-008** — Decisions verb (cron-fired digest; reversibility tiers).
- **ADR-016** — Single-session topology (driver-shared session default).
- **ADR-018** — Per-team cage tmux servers.
- **ADR-021** — atmux as runtime for `/coordination:*` skills (V-26 + V-27).
- **ADR-023** — LLM judge cascade (Sonnet → Haiku → deterministic).
- **ADR-024** — Spawn account matching.
- **ADR-025** — Superdriver (cross-team / fleet).
- **ADR-026** — Parity matrix iter-1 scope.
- **ADR-027** — Parity channel-mask contract.
- **ADR-031** — Aggressive parallelisation default (REVIEW-lane carve-out).
- **ADR-032** — Socket pubsub messaging layer.
- **ADR-042** — Socket-pubsub event-driven path (WIP, Phase 5).
- **ADR-048** — Bare window names (live in atmux-bun + ifca_aux).
- **ADR-049** — Claude Max budget watcher (with 2026-05-06 LIVE ADDENDUM).

### Worktree-local atmux-bun (`docs/adr/`, 001–032)

- **ADR-095** — Why TypeScript on Bun (vs Go, Zig, staying in bash).
- **ADR-115** — `whip` verb (V-25) port scope — in-scope subset + deferred bash-only checks.
- **ADR-119** — Parity matrix iter-1 scope.
- **ADR-120** — Parity channel-mask contract.
- **ADR-121** — Phase 4a parity cron-fired lane scope (refs ADR-119, ADR-120). **F2-corrected 2026-05-06: bash `groom` + `decisions digest` exist; only TS port absent.**
- **ADR-122** — Phase 3 state-mutating lane scope.
- **ADR-123** — Phase 3 read-only lane scope.
- **ADR-124** — Phase 3 lifecycle lane scope.
- **ADR-125** — (worktree-local — distinct from parent ADR-125) error-class lane scope.
- **ADR-052** — Eternal-improvement (kanban-empty fallback to autonomous self-improvement loop). Status: proposed; gated on OQ-1 / OQ-2 / reviewer signoff. T1–T7 landed (T8 e2e + T9 cross-cage announcement blocked).
- **ADR-053** — Budget observability (probe port + Fix C OAuth refresh + warning bands + refresh-soon + `whip-resume-check` 1-min cron + history.jsonl). R1-T1/T5/T6/T7 landed (`ffad610` / `65c16f3` / `65bdcda` / `09b8091` / `df3a08c` / `8160d71` / `f9ad15b` / `9c50354`).
- **ADR-222 + ADR-223** — Fleet topology via `atmux topo` (read-only manifest + 6-class orphan classifier per ADR-222) + composable reap cascade (`--reap` flag-chain + 4-gate safety ladder per ADR-223). Replaces N × N manual cleanup with a single composer; cockpit-mirror Rust crate (e-95087c8b S2) pins on `schema_version: 1`. Operator runbook at `docs/RUNBOOK-topology.md`.
- **ADR-054** — Zod whip-config (TeamWhip schema + per-tick drift detection + `[whip-config-drift]` ping). R1-T3/T4 landed (`4e93746` / `9751f7a`).
- **ADR-055** — Cursor self-heal (recipe-driven; v1 recipes: `fix:team-json-schema-drift` / `fix:cron-pollution` / `fix:supervisor-missing`). R1-T8 chain landed (`0fa4572` → `80d628e` → `9554f70` → `f50e751` → `1ce71c3`). Reviewer-gate, no auto-commit.
- **ADR-056** — Account-swap (preemptive handoff at 75% used; lead/planner excluded; sequential per-team flock; OQ-3 = post-resume reconciliation deferred). R1-T10/T11/T12 landed (`f99519f` / `ffa2bd5` / `22ac16b` / `83115ec`).

### 2026-08-06 operator-ask batch (Status: proposed — surface in §3.6, roadmap in §5.5, open questions in §10.5–§10.7)

- **[ADR-267](adr/267-durable-agent-continuity-contract.md)** — Durable
  agent-continuity contract: plan/intent is written as you go, not captured on the
  death-bed. Adds `atmux task note` + an append-only `task_notes` table, a `notes`
  array on `atmux task show`, an `archiveTaskNotes` groom sub-op (with the
  invariant that a non-`done` Task's notes are never archived), and a sixth
  kanban-hygiene detector `plan-missing` — escalate-only, never auto-fixed, and
  deliberately **not** a claim gate. Requirement R1.
- **[ADR-268](adr/268-managed-repo-state-isolation-enforcement.md)** —
  Managed-repo state isolation: enforce the ADR-239 / ADR-244 dotfile-tree
  invariant in code instead of operator memory. Adds an idempotent isolation step
  to `atmux init` (three per-entry symlinks; `.atmux/` stays a real directory;
  fails closed when the dotfile tree is absent), writes ignore patterns to the
  machine-global excludes file rather than a product repo's tracked `.gitignore`,
  and adds the `managed-repo-state-untracked` doctor probe plus
  `atmux doctor --sweep-isolation`. Requirement R2.
- **[ADR-269](adr/269-recursive-branch-ledger.md)** — Recursive branch ledger:
  per-repo branch state across a monorepo root and every nested submodule, plus an
  explicitly-supplied per-lane intent, so intended-vs-actual is a diff rather than
  a memory. Adds `branch_ledger` + `branch_ledger_intent` tables,
  `atmux branches record|show|verify`, and a `checkBranchLedgerDrift` doctor probe.
  Fills the replacement [ADR-035](adr/035-per-member-branch-recursive-ops.md)
  §Context failure-mode 2 identified and never named, while preserving ADR-035 §1
  (branch arg mandatory + no `.gitmodules` "smart default"), §3 (detached HEAD is
  correct, not drift) and §4 (`.gitmodules` `branch = ` is a remote-tracking hint,
  not a checkout target) intact. Requirement R3.

### 2026-08-14 voice batch (surface in §3.7)

- **[ADR-272](adr/272-voice-operator-interface.md)** — `atmux vox`, a spoken
  operator interface: mobile PWA → WebSocket relay → provider-neutral realtime
  seam → verb-only tool bridge. **Shipped and deployed read-only**
  (`ATMUX_VOX_READONLY=1`), Status: proposed. Carves out
  `docs/ARCHITECTURE.md` §Principles item 1 for the *operator* seam only, behind
  an enforced import fence (§D1); every tool is an argv-built `atmux` verb call
  (§D2); the server acts with driver scope (§D3); mutation confirmation is
  server-enforced via argument-bound single-use tokens (§D7). OQ-4 (transcripts
  local-only, 7-day retention) and OQ-5 (`voice` stands as a top-level verb) are
  resolved.
- **[ADR-273](adr/273-voice-fleet-triage-and-pane-input.md)** — Voice fleet
  triage + pane input ("what needs me?" + "type that"). **D1–D3 (the survey
  half) are BUILT**: `fleet_attention` / `fleet_quiet` take the catalog from 14
  to 16, with attention classified server-side from evidence and every item
  carrying the marker + pane gist that produced it, bounded in wall-clock, and a
  team that cannot be read reported as unreadable rather than dropped. §Supplement
  records what shipped, the three classifier traps as found live, and the OQ-3
  measurement (~110 ms per sweep — no cache needed). **D4/D5 (`pane_nudge` /
  `pane_send`) are NOT built**; OQ-1 (does `pane_send` need a second factor?) is
  an operator decision required before either can ship, and input would route
  through the verified `atmux send` path rather than raw `tmux send-keys`
  ([ADR-138](adr/138-verified-send-keys.md)).

### Planned

- **ADR-050** — Multi-tier fallback chain (per kanban `t-706655ee`).
- **ADR-057** — Stall-prevention (R1-T13 follow-up; v1.1.x territory per planner intent).
- **ADR-086** — `atmux pulse` (cockpit-wide deterministic verdict probe, Phase 1 of MiniMax observer). New cron-fired verb; ships verdict-first Discord template `pulse-verdict` + per-cockpit dedup state at `~/.atmux/state/pulse-state.json`. Phase 2 layers an LLM observer onto the same input bundle.

---

## Appendix B: Cross-reference index

| Topic | Source of truth |
|-------|-----------------|
| Business intent — why atmux exists, who pays, non-goals, success measures (added 2026-08-06) | [docs/brd/atmux.md](brd/atmux.md) |
| ADR roster + status at a glance | [docs/adr/INDEX.md](adr/INDEX.md) |
| Verbs reference | `README.md` "Commands" |
| State layout | `README.md` "State layout" |
| Configuration env vars | `README.md` "Configuration" |
| Architecture principles | `docs/ARCHITECTURE.md` |
| Phase plan + gates | `PLAN.md` §5 + §14 |
| Phase 4 RUSH lane decomp | `HANDOFF.md` "PHASE 4 RUSH" |
| TUI matrix + custom commands | `README.md` "TUIs supported" |
| Preset modes | `README.md` "Preset modes" |
| Branch-owner handoff (ADR-048) | `.atmux/notes-adr-048.md` |
| Global operator conventions | `~/.claude-ifca/CLAUDE.md` |
| CHANGELOG | `CHANGELOG.md` |

---

## Appendix C: PRD update protocol

This PRD is a living doc, not a frozen artifact. Updates:

- **Trigger:** every commit-chain that lands new behavior, per docs-lane
  guardrail (sync docs as work lands).
- **Pattern:** small `docs(prd):` commits alongside the feature commit;
  reviewer-gated. Don't batch — drift is the failure mode.
- **Owner:** `docs` member in atmux-bun team. Hand off in
  `.atmux/notes-prd.md` if rotation changes ownership.
- **Cross-references:** when an ADR lands, add an Appendix A entry. When
  a verb's surface changes, update §3.1 + cross-link to README.
- **Anti-pattern:** duplicating ADR / PLAN.md / README content into the
  PRD body. Cross-reference the canonical source instead. PRD's job is
  the *map*, not the territory.
