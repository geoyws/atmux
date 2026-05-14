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
> [ADR-060](adr/126-sqlite-state-store.md). References to `kanban.json`
> below describe the legacy JSON path; the bun port is dual-path with
> `state.db` as source of truth when present.

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

**atmux** is a tmux-native multi-TUI agent orchestrator. One tmux session
per project team, one tmux window per agent, all coordination state on
disk in greppable JSON / markdown. No daemon. No provider API. State
survives tmux restarts; restarts survive `/clear` cycles; durable by
construction.

Three durable principles (see `docs/ARCHITECTURE.md`):

1. **tmux is the IPC.** `tmux send-keys` writes shell input; `tmux
   capture-pane` reads response. Works with any interactive coding-agent
   TUI, present or future.
2. **State lives on disk in JSON / markdown.** `.atmux/` is greppable,
   diffable, survives tmux restart, replays on `atmux start`.
3. **No daemon.** Every verb is idempotent. `whip` (5min) and `report`
   (30min) run on cron; nothing long-lived.

### 1.3 Why now

The multi-TUI agent ecosystem has crossed the threshold where parallel,
mixed-capability worker fleets beat any single-model approach for
throughput-per-dollar:

- Claude Opus 4.7 anchors the staff (lead / planner / reviewer / gitter
  / devops / dba) — reasoning + judgment + ADR authorship.
- Cursor Composer 2 + OpenCode (MiniMax) + Kimi handle parallel worker
  lanes at a fraction of Opus tokens per output line of code.
- Bash + tmux gives operators a deeply familiar substrate; no new infra
  to learn.

atmux is the orchestration layer that makes these tiers compose, with
budget pressure (ADR-049) and per-tier isolation (kanban task
`t-706655ee` — multi-tier fallback chain) handled deterministically.

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
├── state.db                   # SQLite canonical store (ADR-060 + ADR-076):
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
| **4b — V-26 + V-27 ports** | session-impl + team-impl | `session` (cont/preclear/handoff/stop) + `team` (start/stop/add/clear/cleanup/bootstrap/rotate-lead/rotate-member). **⏳ pending Phase 4a close.** |
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
| Gitter      | 4                    | claude        | Only member allowed to commit + push |
| Devops      | 5                    | claude        | Deploys, env, CI/CD, infra |
| Dba         | 6                    | claude (opt)  | Schema + migrations + data integrity |
| Members     | 7+                   | any           | Parallel throughput per feature lane |

Driver ↔ lead routing: file-based (`~/.claude/teams/<team>/driver-inbox.md`)
to avoid the `SendMessage` self-loop bug per `~/.claude-ifca/CLAUDE.md`
"Driver→Lead routing is via file, not SendMessage."

### 7.2 Pull kanban (ADR-007 + ADR-031, parent repo)

Workers `atmux claim --next --as <member>`. Selection: `priority`
ascending, then `createdAt` ascending. Tasks with non-`done` deps are
skipped automatically. Cross-lane fallback when a lane is dry
(`crossLaneClaim=true` default); REVIEW-lane carve-out (ADR-031).

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
- **ADR-054** — Zod whip-config (TeamWhip schema + per-tick drift detection + `[whip-config-drift]` ping). R1-T3/T4 landed (`4e93746` / `9751f7a`).
- **ADR-055** — Cursor self-heal (recipe-driven; v1 recipes: `fix:team-json-schema-drift` / `fix:cron-pollution` / `fix:supervisor-missing`). R1-T8 chain landed (`0fa4572` → `80d628e` → `9554f70` → `f50e751` → `1ce71c3`). Reviewer-gate, no auto-commit.
- **ADR-056** — Account-swap (preemptive handoff at 75% used; lead/planner excluded; sequential per-team flock; OQ-3 = post-resume reconciliation deferred). R1-T10/T11/T12 landed (`f99519f` / `ffa2bd5` / `22ac16b` / `83115ec`).

### Planned

- **ADR-050** — Multi-tier fallback chain (per kanban `t-706655ee`).
- **ADR-057** — Stall-prevention (R1-T13 follow-up; v1.1.x territory per planner intent).
- **ADR-086** — `atmux pulse` (cockpit-wide deterministic verdict probe, Phase 1 of MiniMax observer). New cron-fired verb; ships verdict-first Discord template `pulse-verdict` + per-cockpit dedup state at `~/.atmux/state/pulse-state.json`. Phase 2 layers an LLM observer onto the same input bundle.

---

## Appendix B: Cross-reference index

| Topic | Source of truth |
|-------|-----------------|
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
