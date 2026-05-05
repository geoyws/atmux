# atmux → Bun port — master plan

**Worktree:** `.claude/worktrees/atmux-bun` (branch `worktree-atmux-bun`)
**Source state:** branch cut from main@`7366a1f` (2026-04-25, "planner + dba roles, wizard presets, feature-lane naming, 6 ADRs"). The worktree's checked-in `lib/**` IS the canonical frozen bash reference for parity validation — cite source from this worktree's `lib/`, not main's moving HEAD (per memory `feedback_parity_cite_from_frozen_ref.md`). The earlier `2aadc3f` framing was forward-looking when PLAN.md was drafted; main moved on after the branch was already cut, so the worktree's snapshot is what porters port from.
**Coordination:** Claude Code native team primitives (`TeamCreate` + named background `Agent` spawns + `SendMessage` + shared `TaskList`). NOT atmux — atmux is the thing we're rewriting *because* it's broken.
**Status:** plan; no code yet

---

## 1. Mission

Port atmux from bash+tmux+jq to TypeScript on Bun, with **strict typing, 100% unit coverage (narrowed denominator), e2e parity against the bash reference, dedicated per-commit reviewer, and ADR-driven decisions**. Ship behind a side-by-side flag, burn in for ≥2 weeks across all 4 production teams (atmux, sopx-mvp, ifca_aux, unum), then promote and decommission bash.

Success = TS atmux passes the parity harness on every verb (zero divergence vs bash@worktree-frozen-lib including the WIP modules from main checkout), 100% narrowed unit coverage in CI, v2 verb redesign per ADR-014 shipped. **No calendar/observation gates** — phases are sequential to avoid confusion, not to wait out a clock.

---

## 2. Scope (frozen at the worktree's checked-in `lib/**`, branched from main@`7366a1f`)

**In scope** — what's actually committed at HEAD:

- **30 verbs** (incl. aliases): up, init, start, stop, attach, status, send, broadcast, tell-lead, reply, outbox, task, dispatch, inbox, claim, done, report, whip, cost, rotate, rotate-lead, handoff, pause, resume, add-member, reconfigure, dashboard, doctor, version, help.
- **27 lib/*.sh files**, ~3500 LOC total. No file >355 LOC. No godfiles.
- **24 .bats files** (23 unit + 1 e2e `lifecycle.bats` with 11 sequenced scenarios). 22/27 libs covered, 5 zero-coverage libs: attach, dashboard, inbox, reconfigure, rotate.
- **External tooling surface:** tmux (45 calls / 11 subcommands), jq (157 calls), curl (2 — Discord webhook + doctor health check), flock (2), mktemp (5), date (8), command -v (7). Zero usage of socat, nc, ss, lsof, pgrep, pkill, setsid, nohup, gh, wget, git-as-vcs.
- **6 ADRs** (001–006). Port adds its own series under `docs/adr-bun/`.

**Out of scope (deferred — port later, after they land in bash):**

The atmux main checkout has substantial WIP not committed to HEAD:
- `super-*.sh` (super-arbitrate, super-epic, super-reply, super-status, super-tell, super-whip, superdriver-audit), `drive.sh`, `team-migrate-to-cage.sh`, `team-repair-rename.sh`, `tmux-conf-restore.sh`, `socket-pubsub.sh` (ADR-042 event-driven path), the supervisor model.
- Topology ADRs 016/026/044/045/046 (cage socket variants, default-socket driver, underscore separator, cockpit viewer).

These get ported in **Phase 5** *after* they land in bash. Porting WIP would chase a moving target.

---

## 3. Constraints (inherited from CLAUDE.md)

- **Runtime**: mise-managed Bun (≥1.3.13, currently installed).
- **Package manager**: `bun` (not pnpm — Bun is the runtime + the manager here).
- **Language**: TypeScript strict (`strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- **Commits**: conventional (`feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`).
- **Timezone**: MYT (`Asia/Kuala_Lumpur`) on every user-facing timestamp; never bare `HH:MM`.
- **Duration formatting**: `47min`, `6h45m`, `25h49m` — no day units, no raw minutes.
- **Discord output**: header + bulleted body, named templates (`[whip-progress]`, etc.), 80-char bullets. Route through `~/.claude/skills/whip/scripts/ping-discord.sh` from the TS side too.
- **Hooks discipline**: never `--no-verify` / hook-bypass. Fix env, don't bypass.
- **Reviewer vs auditor split** (CLAUDE.md): per-commit reviewer is narrow + deep on diff; auditor is driver-dispatched, broad + deep, read-only.
- **Test discipline**: tests land in same commit as code. 100% narrowed coverage gate. Stateful e2e specs documented as 1x cold-start in their header docstring.
- **Lowercase Docker/DB/identifier names** if any get added.

---

## 4. Strategy

### 4.1 Side-by-side, never break prod

- TS binary ships as **`atmux-bun`** (separate name), installed alongside `/usr/local/bin/atmux`.
- Cron rewrite is staged: `whip` is the lowest-blast-radius verb to switch first (idempotent, runs every 5 min, output is observable in Discord). Switching one cron line per team per verb, validated for ≥48h before next switch.
- Final cutover (Phase 4) renames `atmux-bun` → `atmux` and moves bash to `/usr/local/bin/atmux-legacy` for 4-week rollback window before deletion.
- **Cutover policy: never delete bash until all 4 teams have run TS for 14 consecutive days with zero divergence.**

### 4.2 Parity harness as the source of truth

- For every verb, a parity test fixture: a sandboxed `.atmux/` directory + a script that runs `atmux <verb> <args>` (bash) and `atmux-bun <verb> <args>` (TS) against identical state, then diffs:
  - stdout (semantic diff — JSON-aware where applicable)
  - exit code
  - resulting `.atmux/` directory state (file contents, file modes)
  - emitted Discord webhook calls (intercepted via env override)
- Parity harness lives in `tests/parity/` and runs in CI on every commit that touches a ported verb.

### 4.3 No silent error-swallowing

The bash code has 31 `2>/dev/null || true` patterns and 50 bare `2>/dev/null`. Porter discipline: **every `Bun.spawn` either throws on nonzero exit, or has an explicit comment justifying the swallow**. Reviewer enforces this.

### 4.4 Schema-first

Every JSON file at the boundary (`team.json`, `kanban.json`, `inboxes/<member>.json`, `flags.md` frontmatter if any) gets a Zod schema in `src/schema/`. All reads validate, all writes serialize through the schema. No raw `JSON.parse(...)` in domain code.

---

## 5. Phases

| Phase | Owner(s) | Duration | Deliverable |
|---|---|---|---|
| **0 — Architecture** | lead + architect | 5–7d | Bun project skeleton, ADRs 001–014, type contracts, parity harness skeleton, CI gates |
| **1 — Foundation** | foundation porter + reviewer + tester | 10–14d | 8 abstraction modules + 4 core libs ported, 100% unit coverage, parity harness operational |
| **2 — Verb porting (parallel, 1:1 parity)** | porter-A + porter-B + reviewer + tester | 21–28d | All 23 domain verbs ported with **identical names + args + behaviour** to bash, each with unit + parity tests, ADRs for non-obvious choices |
| **3 — Functional parity validation** | tester + auditor + lead | — | Parity harness green across **every** cron-fired scenario (whip, report, decisions-digest) and every interactive verb. No production observation gate. |
| **4 — Cutover** | lead | — | `atmux-bun` → `atmux` rename, bash → `atmux-legacy`, cron lines updated, CHANGELOG + Discord announce. **v1 ships here.** |
| **5 — WIP catch-up** | foundation porter + porter-A | — | Port super-*, drive, team-migrate-to-cage, repair-rename, tmux-conf-restore, socket-pubsub. **Source: main checkout's working tree at `/root/work/src/atmux/lib/`** — uncommitted files are fine to port from; no waiting for git commits. |
| **6 — v2 verb redesign** | architect + porter-A + porter-B + reviewer | — | Per ADR-014: subcommand structure (`task <sub>`, `member <sub>`), `member rm/rename` (closes API gap), drop `up`/`reconfigure`, deprecation aliases for ~3 months, then removal in v3. **v2 ships here.** |

**No durations are pinned to calendar weeks.** Each phase advances as soon as its functional gate is met (§14). All 6 phases run back-to-back without driver permission gates — see §14.

---

## 6. Team composition

Coordinated via **Claude Code's native team primitives** (NOT atmux — atmux is what we're rewriting):

- `TeamCreate({team_name: "atmux-bun"})` creates the team + a shared task list at `~/.claude/teams/atmux-bun/` and `~/.claude/tasks/atmux-bun/`.
- Each member is a long-running background `Agent` spawn: `Agent({team_name: "atmux-bun", name: "<role>", subagent_type: "general-purpose", run_in_background: true, prompt: "..."})`.
- Members are addressable by name via `SendMessage({to: "<name>", ...})`. Messages auto-deliver — no inbox polling.
- Members idle between turns; sending a DM wakes them.
- Driver (this session) is the lead's lead — drives the project, asks the in-team lead for status, escalates to the architect when needed.

6 members. All `subagent_type: general-purpose` (full tools — they write code). All on Opus by default.

| Role / `name` | Responsibilities |
|---|---|
| **lead** | In-team driver. Reads PLAN.md, breaks Phase 0 work into tasks (`TaskCreate`), assigns owners (`TaskUpdate.owner`), gates merges via reviewer, reports up to driver session via DM |
| **architect** | Type contracts, foundational ADRs (001–013), module API specs, schema design (Zod), CLI dispatcher choice |
| **porter-foundation** | Phase 1 — 8 abstraction modules + 4 core libs (tmux, json, lock, http, fs, time, spawn, discord) |
| **porter-a** | Phase 2 — lifecycle + state verbs (13 verbs, ~1100 LOC bash equiv) |
| **porter-b** | Phase 2 — messaging + supervisor + diagnostic verbs (10 verbs, ~1450 LOC) |
| **tester** | Parity harness owner, e2e spec ports (lifecycle.bats → bun e2e), coverage gating, fixture maintenance |
| **reviewer** | Per-commit gate: typing, coverage, schema hygiene, no swallowed errors, ADR compliance, conventional commit format |

**Auditor mode** is dispatched on-demand by the driver via a one-shot `Agent` call (NOT a standing team member) when broad read-only review is needed: weekly exhaustive-grep coverage matrix, adjacent vulnerability class checks, parity divergence triage during Phase 3.

### 6.1 Coordination protocol

- **Driver ↔ lead:** DMs via SendMessage. Lead reports progress when it idles after a meaningful work batch. Driver can ask "status" at any time.
- **Lead ↔ members:** lead assigns tasks via `TaskUpdate.owner`. Members claim available tasks (lowest ID first, blockedBy empty) via the same. Lead DMs members to clarify, escalate, or unblock.
- **Member ↔ member:** porters DM `reviewer` when a verb is ready. Reviewer DMs back with merge/revise verdict. Porters DM `tester` when adding a parity fixture. Porters DM `architect` to clarify ADR intent.
- **Idle handling:** members go idle after every turn. Driver and lead DO NOT nag idle members. Idle just means waiting for the next message; if there's no next task, that's intentional.
- **Per-commit reviewer flow:** porter writes code → DMs reviewer with `git diff HEAD` summary + the verb name → reviewer pulls the diff, runs the 8-check gate (§9) → either DMs ✅ merge-ok or ❌ revise-with-reasons → porter merges or fixes.
- **Persistence:** PLAN.md + `docs/adr-bun/` + ADR drafts + the shared task list are the durable record. Member chat history survives within their agent process; if a member is restarted, they re-read PLAN.md + their last completed task to recover context.

### 6.1 Verb split (Phase 2)

**Porter-A (📦, 13 verbs, lifecycle + state):**
up, init, start, stop, attach, add-member, reconfigure, rotate, handoff, pause/resume, task (kanban), claim/done, inbox

**Porter-B (📨, 10 verbs, messaging + supervisor + diag):**
send, broadcast, tell-lead, reply/outbox, dispatch, whip, report, doctor, cost, status, dashboard

Whip is the highest-value verb (96% of cron firings). Porter-B owns it because it's tightly coupled to discord + cost + status, all of which are also B's territory. Doctor (355 LOC) is the largest single file; B can split if needed.

### 6.2 Stable verb checklist (canonical resume reference)

Verb-IDs are **stable across `/clear` cycles** — referenced by HANDOFF.md and TaskList task subjects. TaskList itself is volatile (rebuilt each session); the IDs below are the durable handles.

| Verb-ID | Verb (CLI form) | Bash file | LOC | Status |
|---|---|---|---|---|
| V-01 | `up` | `lib/up.sh` | ~80 | ⏳ pending |
| V-02 | `init` | `lib/init.sh` | — | ✅ shipped |
| V-03 | `start` | `lib/start.sh` | — | ✅ shipped |
| V-04 | `stop` | `lib/stop.sh` | — | ✅ shipped |
| V-05 | `attach` | `lib/attach.sh` | — | ✅ shipped |
| V-06 | `status` | `lib/status.sh` | — | ✅ shipped |
| V-07 | `send` / `broadcast` | `lib/send.sh` | — | ✅ shipped |
| V-08 | `tell-lead` | `lib/tell.sh` | — | ✅ shipped |
| V-09 | `reply` / `outbox` | `lib/reply.sh` | — | ✅ shipped |
| V-10 | `task` (sub-verbs) | `lib/kanban.sh` | — | ✅ shipped |
| V-11 | `dispatch` | `lib/dispatch.sh` | — | ✅ shipped |
| V-12 | `inbox` | `lib/inbox.sh` | — | ✅ shipped |
| V-13 | `claim` / `done` | `lib/claim.sh` | — | ✅ shipped |
| V-14 | `pause` / `resume` | `lib/pause.sh` | — | ✅ shipped |
| V-15 | `add-member` | `lib/add-member.sh` | — | ✅ shipped |
| V-16 | `version` | `lib/common.sh` | — | ✅ shipped |
| V-17 | `help` | `bin/atmux:25-86` | — | ✅ shipped |
| V-18 | `dashboard` | `lib/dashboard.sh` | 41 | ✅ shipped |
| V-19 | `reconfigure` | `lib/reconfigure.sh` | 59 | ✅ shipped |
| V-20 | `handoff` | `lib/handoff.sh` | 135 | ✅ shipped |
| V-21 | `report` | `lib/report.sh` | 84 | ✅ shipped |
| V-22 | `cost` | `lib/cost.sh` | 170 | ✅ shipped |
| V-23 | `rotate` / `rotate-lead` | `lib/rotate.sh` | 81 | ✅ shipped |
| V-24 | `doctor` | `lib/doctor.sh` | 355 | ✅ shipped (in-scope subset per ADR-019) |
| V-25 | `whip` | `lib/whip.sh` | 218 | ⏳ pending |
| V-26 | `session` (sub-verbs: cont / preclear / handoff / stop) | `~/.claude/skills/coordination/skills/session/SKILL.md` | TBD | ⏳ pending (Phase 4 per ADR-021) |
| V-27 | `team` (sub-verbs: start / stop / add / clear / cleanup / bootstrap / rotate-lead / rotate-member) | `~/.claude/skills/coordination/skills/team/SKILL.md` | TBD | ⏳ pending (Phase 4 per ADR-021) |

**Cross-cutting refactor IDs** (R-* — interleave with porting):

| Refactor-ID | Title | Status |
|---|---|---|
| R-1 | Extract `tests/helpers/capture.ts` (`captureStdout` / `captureMain`) | ✅ done |
| R-2 | Lift `getDefaultSocket(team)` → `core/common.ts` | ✅ done |
| R-3 | Add §6.2 stable-ID checklist to PLAN.md | ✅ done |
| R-4 | Drop TaskList refs from HANDOFF.md, link to §6.2 | ⏳ pending |
| R-5 | ADR-020 — `Writer` abstraction + `core/io.ts` (lift duplicated default writers) | ✅ done |

**Recommended next-batch order:** R-3 → R-4 → R-1 → R-2 → V-23 → V-20 → V-21 → V-22 → V-24 → R-5 → V-25 → V-01. Doctor before whip because whip calls into doctor in some flows. R-5 (Writer abstraction, ADR-020) lands before V-25 so whip writes against the canonical signature. **V-26 `session` + V-27 `team` are Phase-4 (post-cutover) per ADR-021** — paths canonicalized in ADR-021 so V-25 + V-01 use them from day one.

When updating this checklist, flip the Status column **only** — never renumber. Stale rows (e.g. V-* shipped but PLAN.md not refreshed) should be amended in a small `docs(plan)` commit alongside the verb's `feat(verbs)` commit.

### 6.3 Integration tasks — atmux ↔ `/coordination:*` skills (ADR-018 + ADR-021)

Pin the contract with the Claude skills plugin (`~/.claude/skills/coordination/`). Immediate items I-1 + I-2 land alongside or before V-25 (whip); items I-3 + I-4 are **resolved by ADR-021** — driver-inbox path canonicalized to `~/.claude/teams/<team>/driver-inbox.md`, and the `/team` shim collapses into V-27 `team` (post-cutover).

| Integration-ID | Title | Wave | Status |
|---|---|---|---|
| I-1 | Lead-uptime marker `~/.claude/teams/<team>/lead-session-start.txt` (write on lead spawn / rotate-lead, clear on stop) | immediate | ⏳ pending |
| I-2 | Window-name detection: marker file `~/.claude/teams/<team>/lead-window-name.txt` + `atmux which <kind> [name]` subcommand | immediate | ⏳ pending |
| I-3 | Driver-inbox path alignment — **resolved by ADR-021**: canonical path is `~/.claude/teams/<team>/driver-inbox.md` (global, lead-scoped); `.atmux/driver-inbox.md` deprecated. Implementation lands with V-27 `team`. | resolved (ADR-021) | ✅ resolved |
| I-4 | `/coordination:team` skill shim — **resolved by ADR-021**: collapses into V-27 `team` verb-ID (sub-verbs start / stop / add / clear / cleanup / bootstrap / rotate-lead / rotate-member). Skill becomes thin shim post-cutover. | resolved (ADR-021) | ✅ resolved |
| I-5 | `atmux cage attach <name>` UX — one-shot attach to a named cage (`unum` / `sopx` / `atmux` / etc.) without remembering the tmpdir socket. Probably `atmux cage <verb>` sub-namespace mirroring how `atmux task <verb>` is structured. **Captured 2026-05-05 — George's request: "make sure there's an easy way for users to attach to the cages."** | deferred (Phase 5 cage) | ⏳ pending |
| I-6 | Discord decision-defence surfacing — every autonomous lead decision (planner-recommended default applied without escalation) posts a context+rationale bullet to Discord (`📋 [autonomous-decision]` named template). Driver/George can react to reverse or amend. Builds on the §"Lead makes its own recommended decisions" rule in CLAUDE.md — currently the rule is followed but the Discord surfacing isn't automated. Lands alongside V-25 whip (whip is already the Discord-pinging supervisor). **Captured 2026-05-05 — George's request: "surface context and decision defence to Discord for all autonomous decisions made so I can go in there to reverse or to add into the decision made."** | deferred (V-25 + new template) | ⏳ pending |

I-* IDs (like R-* and V-*) are stable across `/clear` cycles; flip Status only, never renumber.

---

## 7. ADR backlog (`docs/adr-bun/`)

Numbered separately from bash ADRs to avoid collision. Architect drafts 001–006 in Phase 0; remaining drafted as needs arise.

| # | Title | Phase | Owner |
|---|---|---|---|
| 001 | Why TypeScript on Bun (vs Go, Zig, staying in bash) | 0 | architect |
| 002 | Project layout (`src/`, `tests/`, separate from bash sources) | 0 | architect |
| 003 | Module taxonomy (abstraction layer vs core libs vs domain verbs) | 0 | architect |
| 004 | tmux abstraction interface — one method per subcommand bucket, typed | 0 | architect |
| 005 | JSON + locking model (Zod schemas, atomic write, file-lock with timeout) | 0 | architect |
| 006 | Error handling discipline (no silent swallows, typed error tags, when to throw vs return null) | 0 | architect |
| 007 | Subprocess spawn pattern (`Bun.spawn` wrapper with stderr capture + timeout) | 1 | foundation |
| 008 | Discord webhook + chunking + named-template enforcement | 1 | foundation |
| 009 | Test strategy (`bun:test`, 100% narrowed coverage, parity harness shape) | 0 | tester |
| 010 | CLI dispatcher (citty? hand-roll? port the case statement?) | 0 | architect |
| 011 | Side-by-side cutover protocol (binary names, env flag, burn-in window, rollback) | 0 | lead |
| 012 | Time + timezone handling (MYT discipline, UTC internals) | 0 | architect |
| 013 | WIP-bash deferral (super-*, drive, migrate, socket-pubsub deferred to Phase 5) | 0 | lead |
| **014** | **Verb design debt — deferred v2 redesign (Phase 6)** | 0 | lead |
| 015 | Team members work in isolated git worktrees by default (Phase 6 / v2) | 2 | architect |
| 016 | Schema version field deferred until v2 | 2 | architect |
| 017 | tmux window naming — drop `__<team>__` prefix | 2 | porter-foundation-3 |
| **018** | **`/coordination:*` skills integration contract (window naming / marker files / inbox paths / `/team` shim)** | 2 | driver |
| **019** | **`doctor` verb (V-24) port scope — in-scope subset + deferred bash-only checks** | 2 | driver |
| **020** | **`Writer` abstraction + `core/io.ts` — R-5 (lift duplicated default writers across verbs)** | 2 | driver |
| **021** | **atmux as runtime for `/coordination:session` + `/coordination:team` skills — verb contract** (V-26 + V-27 schedule, path canonicalization, I-3 + I-4 collapse) | 2 | driver |
| 022+ | Per-verb ADRs as non-obvious decisions surface during Phase 2 | 2 | porters |

---

## 8. Testing strategy

### 8.1 Unit tests — `bun:test`, 100% narrowed coverage

**Narrowed denominator** (per CLAUDE.md):
- ✅ in: domain verb handlers, abstraction modules (tmux/json/http/lock/fs/time/spawn/discord), core libs (common/tui/send/pause), schema validators, error helpers.
- ❌ out: generated types, fixture data, barrel re-exports, CLI dispatcher boilerplate (covered by e2e).

CI gate: `bun test --coverage` fails the build at <100% on tracked paths. Reviewer rejects commits that don't add tests for new code.

### 8.2 E2E parity harness

Lives at `tests/parity/`. Per verb:
1. Fixture `.atmux/` dir generated from a Zod-validated factory.
2. Run bash `atmux <verb>` → capture stdout/exit/state/discord.
3. Run TS `atmux-bun <verb>` → same capture.
4. Semantic diff (JSON-aware for state files, byte-exact for stdout where bash emits stable output).
5. CI fails on any divergence.

Bats specs port 1:1 to `tests/e2e/<verb>.test.ts` — every `@test` becomes a `test()`, run sequentially against the parity fixtures.

### 8.3 The `lifecycle.bats` e2e

Ported as `tests/e2e/lifecycle.test.ts`, **10 sequenced beats matching `tests/e2e/lifecycle.bats` block-for-block** (one `test()` per `@test` block). Intra-beat sub-actions (e.g. `task add` / `dispatch` / `done` inside the dispatch+claim+done round-trip beat) are captured as `test.step()` children for atomicity. This is **stateful, non-idempotent — 1x cold-start+walk** (per CLAUDE.md testing discipline). Documented in the spec's header docstring.

### 8.4 Functional parity (Phase 3)

Parity harness exercises every cron-fired scenario (whip, report, decisions-digest, groom) and every interactive verb against fixture `.atmux/` dirs simulating the 4 prod teams' state shapes. Zero divergence required — no production observation period.

---

## 9. Reviewer + auditor protocol

### Reviewer (🔍, per-commit gate, runs in CI):

1. `bun typecheck` (`tsc --noEmit`) — green.
2. `bun test --coverage` — 100% on touched files.
3. `biome lint` + `biome format` — green.
4. `bun test:parity:<verb>` for any verb touched — green vs bash.
5. **No silent error swallows** — regex check for `catch.*{\s*}` and `.catch\(\s*\(\)\s*=>\s*null\)` without an inline `// expected: <reason>` comment.
6. **Schema discipline** — no `JSON.parse` in domain code; all I/O via `src/schema/<file>.ts`.
7. **ADR compliance** — if commit adds a new module under `src/`, must reference an ADR (or open one).
8. **Conventional commit** — title matches `^(feat|fix|chore|refactor|test|docs)(\(.+\))?:`.

Reviewer blocks. Driver overrides only with explicit ack documented in commit body as `Approved exception: <reason>` (CLAUDE.md hooks-bypass discipline applies).

### Auditor (driver-dispatched, broad + read-only):

- **Weekly during Phase 2:** exhaustive-grep coverage matrix (every bash callsite → ts equivalent? state ratio).
- **End of Phase 2:** adjacent vulnerability class check (CLAUDE.md "widen vulnerability class" rule). Examples: did we cover read AND write paths? did we handle pane-state races AND lock contention? Did we preserve every `2>/dev/null` semantic *intentionally* or by accident?
- **Phase 3 daily:** parity divergence triage. Each divergence gets a 5-element bug report (state-snapshot, containment, fix sketch, residue inventory, severity).

---

## 10. Tooling decisions (Phase 0)

| Concern | Decision (provisional, ratify in ADR) | Notes |
|---|---|---|
| Runtime | Bun 1.3.13+ | Already installed on hax + local |
| TS config | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `target: "ES2024"`, `module: "ESNext"` | ADR-001 |
| Linter | biome | Faster than eslint; one-tool config |
| Formatter | biome (same config) | Tabs vs spaces: defer to user pref |
| Test runner | `bun:test` | Vitest-compatible, native to runtime |
| Coverage | `bun test --coverage` (built-in) | Lcov export for CI |
| Schema validation | zod | Mature, tree-shakable |
| CLI framework | TBD — citty vs commander vs hand-roll | ADR-010; bash dispatcher is 47-line case stmt — hand-roll is plausible |
| Lock primitive | `proper-lockfile` or hand-rolled `flock(2)` via `node:fs` | ADR-005 |
| HTTP | Bun's `fetch` | Native, no dep |
| Logger | hand-rolled (atmux's logging is shape-sensitive — preserve `{verb} {team} {member}` prefix conventions) | ADR-008 |

---

## 11. Risks & unknowns

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Parity drift** — bash + TS diverge subtly on edge cases | High | Medium | Parity harness is the gate. No verb merges without parity-green. |
| **Bash WIP keeps moving** — phase 5 target shifts | Medium | Low | Phase 5 reads from `/root/work/src/atmux/lib/` snapshot at the moment Phase 5 starts. Subsequent bash WIP changes are a v3 concern. |
| **tmux subcommand corner cases** — control-protocol output varies by tmux version | Medium | Medium | Pin tmux version in CI; document min-version in package.json `engines`. |
| **JSON-locking semantics** — Bun's lock primitives less battle-tested than `flock(2)` | Medium | Medium | ADR-005; smoke test with concurrent writes (1000 iterations, 4 writers). |
| **Cron startup cost** — Bun cold-start ~20–40ms vs bash ~5ms; ~55 cron firings/hour | Low | Low | Total ~2s extra CPU/day. Noise. Don't pre-optimize. |
| **CLI framework choice locks us in** | Medium | Low | Hand-roll route stays open; case statement is tiny |
| **Lead rotation churn** — atmux-team practices lead-rotate every N hours | Low | Medium | Tag the lead-rotation cadence at slow during Phase 0 (architecture is single-threaded). |
| **Reviewer becomes bottleneck** | Medium | Medium | If reviewer queue >3 commits deep, auto-spawn second reviewer for backlog. |

---

## 12. First steps when team spawns

Driver (this session) does this when ready:

```ts
// 1. Create team + shared task list
TeamCreate({ team_name: "atmux-bun", description: "Port atmux from bash to TS/Bun" })

// 2. Seed the task list with Phase 0 work + dependencies (lead expands later)
TaskCreate({ subject: "ADR-001 — Why TypeScript on Bun", description: "Write rationale capturing Go vs TS vs Zig tradeoffs from PLAN.md research...", ... })
TaskCreate({ subject: "ADR-002 — Project layout", ... })
// ...one TaskCreate per Phase 0 ADR + skeleton tasks

// 3. Spawn ONLY the 4 Phase 0 agents (lead + architect + tester + reviewer).
//    Lead spawns subsequent phases' agents itself per §14 auto-progression rules.
Agent({ team_name: "atmux-bun", name: "lead", subagent_type: "general-purpose",
        run_in_background: true,
        prompt: "<see §14 + spawn-time prompt>" })
Agent({ team_name: "atmux-bun", name: "architect", ... })
Agent({ team_name: "atmux-bun", name: "tester", ... })
Agent({ team_name: "atmux-bun", name: "reviewer", ... })
```

The driver session does NOT micromanage. Lead breaks down work, spawns Phase 1+ agents at gate boundaries per §14, dispatches via SendMessage, gates merges via reviewer. Driver only intervenes on §14 escalation criteria.

### Lead's first internal dispatch beats:

1. Architect → ADR-001 (why Bun)
2. Architect → ADR-003 (module taxonomy) + write `src/` skeleton with empty files matching the taxonomy
3. Architect + tester → ADR-009 (test strategy)
4. Tester → parity harness skeleton at `tests/parity/`
5. Reviewer → CI config (`bunfig.toml`, GH Actions, coverage gate, biome)
6. Foundation porter → blocked on architect ADRs 003+004+005; meanwhile drafts ADR-007 (spawn pattern)

### Shutdown when done

```ts
SendMessage({ to: "lead", message: { type: "shutdown_request" } })
// ...for each member after they ack
TeamDelete()  // removes ~/.claude/teams/atmux-bun + tasks dir
```

---

## 13. Definition of done

Two milestones. Project is NOT closed until **both** are met.

### 13.1 v1 ship (end of Phase 4)

- [ ] All 23 domain verbs ported with 100% narrowed unit coverage, **at 1:1 verb-name + arg parity with bash**
- [ ] All 24 bats specs ported as bun e2e tests, all passing
- [ ] Parity harness green on all verbs vs bash@worktree-frozen-lib
- [ ] ADRs 001–014 written + accepted; per-verb ADRs where non-obvious
- [ ] Parity harness green across every cron-fired and interactive verb (functional, no calendar wait)
- [ ] Bash binary renamed to `/usr/local/bin/atmux-legacy`, TS promoted to `/usr/local/bin/atmux`
- [ ] CHANGELOG entry, Discord announce
- [ ] Phase 5 + 6 tracked as kanban tasks (open) for after promotion

### 13.2 v2 closure (end of Phase 6)

- [ ] WIP-bash modules ported (Phase 5): super-*, drive, team-migrate-to-cage, repair-rename, socket-pubsub — once their bash counterparts have landed at HEAD
- [ ] v2 verb redesign per ADR-014 (Phase 6): subcommand structure, `member` namespace with rm/rename (closes API gap), `up`/`reconfigure` deprecated and removed
- [ ] Deprecation aliases shipped in v2 with warnings; removed in v3 after ~3 months
- [ ] CHANGELOG v2 entry, migration guide for users with cron lines / scripts using old verbs
- [ ] `/usr/local/bin/atmux-legacy` (bash) deleted (now redundant — v2 has feature parity + redesign)

**Anti-pattern guard:** Phase 5 + 6 are committed scope, not "nice-to-have." After Phase 4, lead immediately starts Phase 5 (no waiting), then Phase 6, all back-to-back. Team is NOT torn down (`TeamDelete`) until Phase 6 closes. No checkpoint deferral — phases run continuously until v2 ships.

---

## 14. Auto-progression rules (autonomous mode)

The driver session has authorized the lead to advance phases autonomously when each phase's exit gate is met, **without asking the driver for permission**. Driver only intervenes on (1) gate failures, (2) external triggers, (3) scheduled checkpoints, or (4) **mechanical agent spawns** (see below).

**Spawn mechanics (runtime constraint):** Claude Code's team roster is flat — teammates cannot spawn other teammates via the Agent tool. Therefore: when a phase exit gate is met, **lead DMs driver** with `"ready to spawn <role>"`, and **driver performs the spawn** using the `Agent` tool within ~5 minutes, then DMs lead `"<role> spawned"`. This is NOT a permission gate — driver does NOT evaluate whether to spawn, only mechanically executes the spawn that lead has already approved. Lead is the decision-maker; driver is the spawn-executor for runtime reasons only.

### Exit gates

**Phase 0 → Phase 1**
- ADRs 001–014 in `accepted` status (architect drafts, lead approves, reviewer merges)
- Committed at branch HEAD: `package.json`, `bunfig.toml`, `tsconfig.json`, `biome.json`, `src/` skeleton dirs matching ADR-003 taxonomy, `tests/parity/` runner skeleton, `.github/workflows/ci.yml`
- CI green on empty skeleton (typecheck + biome + bun test all pass)
- Lead DMs driver: `"Phase 0 closed, ready to spawn porter-foundation for Phase 1"` (driver spawns within ~5min — see spawn mechanics above)

**Phase 1 → Phase 2**
- 8 abstraction modules + 4 core libs implemented in `src/`
- 100% narrowed unit coverage (CI green)
- Parity harness operational: can run a real bash verb against a TS verb stub and report semantic diff
- ADRs 007 + 008 accepted
- Lead DMs driver: `"Phase 1 closed, ready to spawn porter-a + porter-b for Phase 2"` (driver spawns within ~5min)

**Phase 2 → Phase 3**
- All 23 domain verbs ported at 1:1 name+arg parity
- 100% narrowed unit coverage on every ported file
- All 24 bats specs ported as bun e2e tests, passing
- Parity harness green on every verb vs bash@worktree-frozen-lib (zero divergence)
- Lead DMs driver: `"Phase 2 closed, beginning Phase 3 production parity on team atmux"`

**Phase 3 → Phase 4** [functional gate only, no calendar wait]
- Parity harness exercises every cron-fired scenario (whip, report, decisions-digest, groom) against fixture `.atmux/` dirs simulating each of the 4 prod teams' state shapes
- Parity harness exercises every interactive verb against fixtures
- All comparisons green (zero divergence on stdout, exit, state, discord webhook calls)
- Lead DMs driver: `"Phase 3 functional parity green, proceeding to Phase 4 cutover"`

**Phase 4 (v1 ship)**
- `/usr/local/bin/atmux-bun` → renamed to `/usr/local/bin/atmux`
- `/usr/local/bin/atmux` (bash) → renamed to `/usr/local/bin/atmux-legacy`
- All 4 teams' cron lines updated to reflect new binary
- CHANGELOG entry committed; Discord announce posted
- Phases 5 + 6 opened as kanban tasks
- Lead DMs driver: `"v1 shipped. Phases 5+6 open. Team idle pending bash WIP for Phase 5."`

**Phase 4 → Phase 5** [no external wait — port from main checkout's working tree]
- Lead reads bash WIP files directly from `/root/work/src/atmux/lib/` (the main checkout, where uncommitted WIP lives): `super-*.sh`, `drive.sh`, `team-migrate-to-cage.sh`, `team-repair-rename.sh`, `tmux-conf-restore.sh`, `socket-pubsub.sh`, `superdriver-audit.sh`
- Treat these as the spec to port from, even though they're uncommitted
- Lead DMs driver: `"Phase 4 done. Beginning Phase 5 (WIP catch-up from main checkout working tree)"`

**Phase 5 → Phase 6**
- All bash WIP modules ported with parity validation green
- Lead DMs driver: `"Phase 5 closed, beginning Phase 6 (v2 verb redesign per ADR-014)"`

**Phase 6 (v2 closure)**
- v2 verb redesign shipped per ADR-014: subcommand structure, `member rm/rename`, `up`/`reconfigure` deprecated
- Deprecation aliases live for 3 months
- `/usr/local/bin/atmux-legacy` deleted
- CHANGELOG v2 entry + migration guide
- Lead DMs driver: `"v2 closure. Project done. Requesting team shutdown."`

### Escalation criteria (driver intervention required)

Lead DMs driver session when:
1. **Gate failure:** an exit gate fails to be met within 1.5× its expected duration. Lead provides diagnosis + options.
2. **Parity divergence in Phase 3:** any divergence in cron output → lead halts, DMs 5-element bug report (CLAUDE.md test discipline).
3. **Phase 4 cutover failure:** binary rename fails, post-rename smoke breaks, or cron update partial → lead reverts and DMs.
4. **Architectural decision needed:** porter encounters undocumented bash behaviour architect can't resolve from existing ADRs.
5. **Reviewer deadlock:** reviewer rejects same diff 3× and porter can't resolve.
6. **Quarterly checkpoint:** 90 days post-v1, lead self-DMs driver with Phase 5/6 status report.
7. **Idle stall:** team idle >7 days with open phase work.

Driver MAY check in proactively by DMing lead `"status?"` — lead replies with current phase, current task, blockers.

### What the driver session does NOT do (autonomous mode)

- Approve phase transitions when gates are green.
- Approve phase-spawn requests (driver mechanically spawns the role lead requests; the decision is lead's).
- TaskCreate / TaskUpdate routine work.
- Review individual commits.

Driver intervention is exception-handling, not steady-state.

---

## 15. Out of plan (intentionally)

- **Daemon supervisor** (ADR-042 socket-pubsub) — defer to Phase 5; bash WIP is unstable.
- **Cross-machine coordination** — atmux is single-host today; multi-host is a separate project.
- **Plugin API** — atmux verbs are closed-set today; opening for plugins is post-cutover.
- **Web UI / dashboard webapp** — out of scope; `atmux dashboard` is TUI-only.
- **i18n beyond MYT** — config knob is a Phase 5 nice-to-have.

---

*Last updated: 2026-05-04 by atmux-bun-driver session at `atmux-bun:1.claude`. Next update: when team spawns and lead takes ownership.*
