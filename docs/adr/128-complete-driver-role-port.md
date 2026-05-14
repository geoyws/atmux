# ADR-128: Complete the driver-role port

**Status**: accepted (George 14:13 MYT 2026-05-08 — paperwork catch-up; T1/T2/T4 already shipped, T3+T5 in flight)
**Date**: 2026-05-08

## Context

The bash atmux modeled the *driver* as a first-class role with its own
verb surface (`atmux driver brief-driver` / `atmux driver note`), its
own canonical brief, and explicit awareness in every coordination
verb (status / doctor / dashboard / cockpit). The bun rewrite stripped
most of that — only the schema field (`team.driverSession`) survived
the cutover, and even that was inert until commit
`e624592 feat(start): port ADR-044 driverSession to bun` (2026-05-08)
restored the window-1 spawn behavior.

Five gaps remain after e624592:

1. **`atmux driver` verb is missing.** The bash version
   (`lib/driver.sh`, archived) had two subcommands: `brief-driver`
   (≤30-line single-screen state recovery — kanban counts, branch
   ahead, /loop status, driver-inbox open count, latest 3 lead-outbox
   entries, in-progress Tasks, recovery sequence) and `note` (durable
   single-author append-only log to `.atmux/driver-state.md`,
   symmetric to `decisions.md`'s shape). Neither exists in bun.
2. **No canonical `templates/briefs/driver.md`.** The team-lead /
   planner / member / reviewer / discorder / gitter / dba / devops /
   enforcer / superdriver / unblocker briefs all exist; the *driver*
   brief — the most-loaded role on every team — does not.
3. **`atmux cockpit` (ADR-063) doesn't consult `driverSession` when
   establishing per-team windows.** It builds one viewer window per
   team but doesn't know whether each team's cage actually has a
   driver pane to attach to.
4. **`status` / `doctor` / `dashboard` don't surface driver-pane
   health.** All three iterate `team.members[]` for per-pane probes
   (READY / MODAL / RATE-LIMIT etc. via the ADR-057 health probes)
   but skip the driver window — even though the driver is the most
   coordination-critical pane in any team.
5. **`team.driverSession.command` is dead code.** Confirmed via
   `grep -rn 'driverSession\.command'` — referenced exactly nowhere
   outside `src/schema/team.ts:258`. The active code path uses only
   `driverSession.tui`. Schema lint should refuse drift.

The driver is operationally central: every team has one (the human
operator), it's window 1 in every cage by ADR-044, every dispatch
ultimately routes through it. Leaving the role half-ported means
recovery (post-`/clear` brief), self-notes (driver-state for handoffs),
and observability (pane health in status surfaces) all lose continuity
with the bash semantics teams have been operating under since 2025-Q3.

## Decision

Close the five gaps with parallel-able Tasks. Five concrete pieces:

1. **Port `lib/driver.sh` → `src/verbs/driver.ts`**. Two subcommands:
   - `brief-driver` — read-only ≤30-line state recovery. Single
     SQLite read against `state.db` for kanban counts + in-progress
     task list (ADR-126: bash's `jq <kanban.json>` becomes a typed
     `listTasks` call). Single `git rev-list --count @{u}..HEAD` for
     branch-ahead. Optional `loop.json` / `loop.pid` parse for active
     /loop. Awk-equivalent (in TS) for driver-inbox open-count + last
     3 lead-outbox entries. <500ms budget.
   - `note <message> [--reversibility low|medium|high] [--note <text>]`
     — single-author append-only log to `.atmux/driver-state.md`.
     File shape: header + auto-rolling "Digest (last 5)" newest-first +
     full chronological body. Each entry stamped `dn-xxxxxxxx`,
     reversibility emoji (🟢/🟡/🔴), MYT timestamp, message,
     optional note. 60-char ceilings on `<message>` and `--note` are
     errors (matches the bash gate, keeps digest readable). flock-
     guarded full-file rewrite (driver is single-author, low write rate).
     **No Discord ping, no tmux send-keys** — driver is human, doesn't
     ping itself.

2. **Author `templates/briefs/driver.md`**. Canonical brief in the
   same shape as `lead.md` / `planner.md`. Content: who-you-are
   (you're George, the human operator at window 1), thin-relay
   discipline (members → lead → driver; lead does NO work itself;
   members + driver never talk directly), driver-scoped skills (which
   verbs the driver MAY run vs. which are member-only), recovery
   sequence (`atmux driver brief-driver` first, then
   `cat .atmux/driver-inbox.md`, then `atmux task list`). Stamped at
   the top with `<!-- brief-version: v1 -->` per the existing
   convention. Wired from `src/verbs/start.ts` so the driver pane
   spawned at window 1 receives this brief on first activation, the
   same way member panes receive `member.md`.

3. **Extend `src/verbs/cockpit.ts` to consult `driverSession`**. When
   building per-team viewer windows (`cockpit.ts:405-430`), the
   cockpit currently treats every team uniformly. Update the loop:
   if `team.driverSession` is configured (truthy object), the viewer
   window attaches to the team's existing `driver` window via
   `tmux link-window` (read-only-ish observability) or `tmux switch-
   client -t <team>:driver` semantics — pick whichever fits the
   cockpit's existing pattern. If `driverSession` is null/missing,
   show a small placeholder pane noting "no driver configured for
   <team>". Decision criteria for which mechanism (link-window vs.
   new pane) is OQ4 below.

4. **Update `status` / `doctor` / `dashboard` to surface driver-pane
   health**. Add a small reusable module
   `src/core/driver-pane-health.ts` that:
   - resolves the driver window target (team-tmux abstraction; `driver`
     window if it exists, else `__home`).
   - captures + classifies the pane via the existing `classifyPane()`
     at `src/core/pane-state.ts:109`.
   - returns `{configured: boolean, windowExists: boolean, state:
     PaneState | null, evidence: string}`.

   `status` adds a row above the per-member table: `🚗 driver
   <state>  evidence=<truncated>`. `doctor` adds a check ID
   `driver-pane-state` that flags non-READY/non-TYPING states as
   warnings (driver pane being MODAL or RATE-LIMIT is operationally
   notable). `dashboard` adds a `─── driver pane ───` block above
   the existing `─── driver-inbox open ───` block.

5. **Drop `team.driverSession.command`**. Remove the field from
   `src/schema/team.ts:258`. Verify zero call sites first (already
   done — confirmed dead in grep). Update tests if any reference the
   shape (none found). Schema-version bump is NOT triggered (the
   schema is `.strict()` on the inner object but the outer Team is
   `.passthrough()`, so removing an inner field of an optional
   nullable object is a clean cut for the wizard's existing output).

## Driver-discipline note (encoded in T2 brief)

Lead is a thin relay. Members route through lead; lead routes Epic-
level summaries + asks to driver via `lead-outbox.md`; driver routes
intent to lead via `driver-inbox.md`. **Lead does NO implementation
work itself.** **Members and driver never talk directly** — every
member↔driver exchange is mediated by lead. This is the same
discipline encoded in `lead.md` ("driver is a thin UI relay" from
George's perspective; from lead's perspective, lead is the work-
synthesis layer). The driver brief mirrors the inverse: "you don't
dispatch, you don't ack — lead does. You write asks; lead reads and
acts."

## Consequences

**FE / docs lane**: new `templates/briefs/driver.md` (T2). Existing
briefs unchanged.

**BE lane**: three new modules — `src/verbs/driver.ts` (T1),
`src/core/driver-pane-health.ts` (T4 helper), changes to
`src/verbs/cockpit.ts` / `status.ts` / `doctor.ts` / `dashboard.ts`
(T3 + T4 wiring).

**DB lane**: no schema changes to `state.db`. T1 reads existing
tables only.

**OPS lane**: no cron change (driver verbs are not cron-fired —
`brief-driver` is invoked interactively at session start; `note` is
invoked when the driver records a self-note). T2 brief is wired into
`atmux start`'s window-1 first-activation hook (already exists for
member panes; extend to driver pane).

**TEST lane**: each Task ships unit tests in the same Task. Coverage:
T1 brief-driver against fixture state.db + driver-inbox.md +
lead-outbox.md + loop.json; T1 note against tmpdir
`driver-state.md` round-trip (write → read → digest re-render); T3
cockpit gating logic (driverSession=null vs configured); T4 health
probe state matrix (8 PaneState values × 2 windowExists). T2 has no
tests (it's a markdown brief).

**REVIEW lane**: reviewer gates each Task at commit time per the
review brief. ADR-128 itself is in scope for review-pre-land sweep.

**What we give up**: the bash `lib/driver.sh` jq+awk implementation
disappears. Operators who had the bash atmux installed alongside
need to migrate (the bash tree is already archived at
`.archive-bash-atmux-20260507/lib/driver.sh` per ADR-106). The
driverSession.command field disappears — but it had no production
consumers, so the loss is purely cosmetic.

**Rollback path**: each Task is independently revertable. T1 revert
removes the verb (no callers in core code); T2 revert removes the
brief (start.ts already has the "no brief found, skip" path); T3
revert restores the uniform cockpit layout; T4 revert removes the
driver-pane row (status/doctor/dashboard fall back to member-only);
T5 revert restores the schema field.

## Open questions

Resolved at decompose-time with recommended defaults inline. All
overrideable until the relevant Task lands.

1. **OQ1 — `driver-state.md` path helper placement**. Default: add
   `driverStatePath(atmuxDir)` to `src/core/common.ts` alongside the
   existing `driverInboxPath` symbol. *Why*: keeps all driver-scoped
   path helpers in one module so future verbs can grep `driver*Path`.
2. **OQ2 — 60-char message ceiling on `driver note`**. Default: keep
   the bash gate (>60 chars = error, not silent truncation). *Why*:
   tight messages keep the digest scannable; force the driver to
   condense; mirrors decisions.md's discipline (ADR-101).
3. **OQ3 — driver-pane health probe placement**. Default: new module
   `src/core/driver-pane-health.ts` called from status / doctor /
   dashboard, NOT inlined in each. *Why*: avoids drift between three
   call sites; tests target one module.
4. **OQ4 — cockpit per-team window mechanism**. Default: when
   `driverSession` is configured, the cockpit's per-team window does
   `tmux switch-client -t <team>:driver` on focus (read-only attach
   to the live driver pane); when `driverSession` is null/missing,
   the per-team window shows a placeholder pane with the message
   "no driver configured for `<team>` — set
   `team.json::driverSession` to enable". *Why*: attaching to the
   live driver pane gives the cockpit operator real-time visibility
   into what George is doing in each team without spawning a
   duplicate TUI. The placeholder makes misconfiguration obvious
   instead of silent.
5. **OQ5 — `driverSession.command` removal cadence**. Default: drop
   immediately (no deprecation cycle). *Why*: confirmed zero call
   sites via grep across `src/`, `tests/`, `templates/`. The wizard
   does NOT emit `command` (only emits `tui`). No teams in the wild
   set it. A deprecation cycle for code that nobody is using is
   pure ceremony.
