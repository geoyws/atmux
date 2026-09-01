# ADR-057: Stall prevention — D1-D7 mitigations against the 7 silent-stall classes

**Status**: accepted (2026-05-07)
**Date**: 2026-05-07

> **Sibling-ADR gap (annotation 2026-05-17, Epic e-2c1ac890 / Task t-9ff04cab).** ADR-053 (executor budget-pause), ADR-054 (TeamWhip strict schema), ADR-055 (whip Discord template registry), and ADR-056 (account-swap pass) are referenced throughout this document but are NOT yet landed as canonical files in `docs/adr/`. Those decisions shipped via commits + driver-inbox + the retired bun-port ADR tree; porting them to `docs/adr/` is **out-of-scope for this Task** (sibling docs gap — file separately if driver requests). Code cross-references using `ADR-053`/`054`/`055`/`056` remain valid; the rationale is grep-recoverable from the commit history listed under each Decision below.

## Context

George's standing complaint, observed across multiple driver sessions in April–May 2026: *"atmux whip sometimes doesn't wake team leads."* The complaint surfaced a class of **silent stalls** — situations where the kanban + supervisor state read as healthy (`atmux status` showed 🟢, `whip` ran on cron, members appeared in-progress) but no work was actually advancing.

Forensic review of seven incidents (driver-inbox entries 2026-04-28 → 2026-05-06) clustered the root causes into **seven failure-mode classes**:

| Class | Failure mode | Witnessed symptom |
| --- | --- | --- |
| A | `tmux send-keys` silently swallowed during compacting / rate-limit / modal / queued-message / respawned-bash pane states | Lead never woken by whip ping despite cron running |
| B | Driver-inbox unbounded growth + lead anchored on stale view post-`/clear` + mid-plan rotation context loss | Lead re-read 2-week-old entries; missed 17:16 MYT in-flight directive |
| C | Orphan `*.lock` blocks writers indefinitely + partial-write corruption + inbox-side unbounded growth mirroring driver-inbox | `kanban.json.bak.*` files in tree; writers wedged 30+ min |
| D | Per-member health invisibility — permission-mode drift, false-positive idle increment, defunct cwd, individual rate-limits | Member visibly broken in pane; whip-tick reported team healthy |
| E | Coordination semantics drift — submodule pointer mismatch, bare `HH:MM` timestamps, orphan `📤 task <id>` markers, window-name renames breaking supervisor addressability | Build broken on parent-trunk; supervisor send-keys hit wrong window |
| F | `atmux status` cache lies post-budget-pause + no process-tree liveness + cron-groom window-order invariant unenforced | Status reported 🟢 while cage was dead (c-8ecd3a61) |
| G | Push-discipline drift — local commits unpushed, partial-batch push when porter completes mid-batch, multi-porter push-race losing fast-forward | Driver-inbox flagged 7 commits unpushed in real time |

Each class needed a discrete mitigation. The seven classes map one-to-one to **Decisions D1–D7** below. Implementation landed across **eight Tasks (R57-T1 through R57-T8)** between 2026-05-07 and 2026-05-17, plus residual follow-on Tasks tracked in Epic `e-2c1ac890` (this Epic).

The decisions are **additive on top of v1.0.0 primitives** — no breaking change to existing verb signatures or state-file shapes; legacy `team.json` consumers keep current semantics via Zod defaults (per ADR-054). Operators on a staged rollout follow the cross-class dep ordering in the final section.

This ADR is the **canonical rationale doc**. Operator-facing usage notes live in [`HANDOFF.md` §🛡️ v1.1.x stall-prevention](../../HANDOFF.md) (now retired — superseded by `.atmux/driver-inbox.md` per commit `2696539`; the operator section was preserved verbatim in commit `dc7fe77`'s diff). The ping-action lookup table lives in [`docs/RUNBOOK-stall-recovery.md`](../RUNBOOK-stall-recovery.md).

## Decisions

### D1 — Pane-state classifier as pre-flight gate (Class A)

**Shipped:** commit `dfe4e26` (R57-T1, 2026-05-07).
**Modules:** [`src/core/pane-state.ts`](../../src/core/pane-state.ts), [`src/core/safe-send.ts`](../../src/core/safe-send.ts).

Every `tmux send-keys` caller now routes through `safeSendKeys(target, text, opts)`, which first calls `classifyPane(target, captureFn)` → discrete `PaneState` union: `READY | TYPING | MODAL | RATE-LIMIT | COMPACTING | SHELL | UNKNOWN`. Pattern priority RATE-LIMIT > COMPACTING > MODAL > TYPING > SHELL > READY > UNKNOWN.

Per-state policy:

- `READY` → send immediately.
- `TYPING` → retry 2s × 3; exhausted → P3 flag + `exhausted-typing` outcome.
- `COMPACTING` → retry 5s × 6 (30s total); exhausted → P3 flag + `exhausted-compacting` outcome.
- `MODAL` → refuse + P3 flag.
- `SHELL` / `UNKNOWN` → refuse + P2 flag.
- `RATE-LIMIT` → refuse, **no flag** (ADR-053 budget-pause owns it).

`safeSendKeys` takes injected `capture` / `sendKeys` / `raiseFlag` / `log` / `sleep` deps — no global state, fully unit-testable. The original ADR-085 §`no-direct-send-keys` lint rule (eslint plugin) was **deferred** — the gate is available; per-callsite adoption rolls out as supervisor / dispatch / send / whip surfaces are touched.

### D2 — Bounded driver-inbox + delta-only reads + pre-rotate handoff + stale-anchor (Class B)

**Shipped:** commit `9c50354` (R57-T2, 2026-05-07).
**Modules:** [`src/core/driver-inbox.ts`](../../src/core/driver-inbox.ts), [`src/verbs/driver-inbox.ts`](../../src/verbs/driver-inbox.ts), [`src/core/lead-handoff.ts`](../../src/core/lead-handoff.ts), [`src/core/stale-anchor.ts`](../../src/core/stale-anchor.ts), [`src/verbs/rotate.ts`](../../src/verbs/rotate.ts), [`src/verbs/whip.ts`](../../src/verbs/whip.ts) (later renamed `poke.ts` per ADR-160).

Four sub-decisions:

- **D2a — auto-archive** at 1 MB OR >200 entries (24 h hard min retention) → `.atmux/archive/driver-inbox-<YYYYMMDD>.md`. *Status:* deferred at R57-T2 ship — gated on the groom-side port; D3d size-cap path (R57-T3) opens the archive directory primitive. Operator-facing notes describe the eventual shape.
- **D2b — delta-only reads** via cursor at `.atmux/state/last-driver-inbox-read.txt`. `atmux outbox` / `atmux driver-inbox` slice by `mtime > cursor`; `--since <ts>` overrides for backfill; `--ack` advances cursor to file tip. MYT-aware roll-back-one-day for undated heads-of-future entries.
- **D2c — pre-rotate handoff** — `composeHandoff` (pure) + `writeLeadHandoff` (in-flight tasks via `listTasks` + last-5 decisions + last-3 driver-inbox heads + eternal-improvement / budget-pause / account-swap state snapshots) fires when `role=team-lead` BEFORE `/clear`. Failure logs to stderr but rotation continues (fail-soft).
- **D2d — stale-view detection** — `checkStaleAnchor` fires `[whip-stale-anchor]` Discord finding when lead cursor is >2 h behind driver-inbox `mtime` AND unread entries exist. FNV-1a tip-line hash dedup; re-fires only when the unread tip changes.

Override knobs in `team.json::stallPrevention`: `driverInboxArchiveSizeBytes`, `driverInboxArchiveMaxEntries`, `driverInboxMinRetentionHours`.

### D3 — Lock-TTL + atomic-write + size-cap (Class C)

**Shipped:** commit `884c068` (R57-T3, 2026-05-07).
**Modules:** [`src/abstractions/lock.ts`](../../src/abstractions/lock.ts), [`src/abstractions/fs.ts`](../../src/abstractions/fs.ts) (pre-existing `atomicWrite`).

- **D3a — `acquireWithTTL`** — on flock contention, reads owner PID + checks liveness (`process.kill(pid, 0)`) + checks age vs `ttlSec` (default 300 s); if dead AND stale, appends one JSONL line to `<auditDir>/lock-recovery.log` and continues normal wait-with-retry. **Force-release is intentionally audit-only**: under POSIX advisory locks, the kernel auto-releases the flock on holder exit — unlinking the file would break flock mutual exclusion if the original holder is still alive. The brief's "force-release" was reframed; R57-T6 heartbeat substrate later enables a safer fence-and-reacquire path if needed.
- **D3b — PID-bearing locks** — `acquire` writes `<pid>\n` to the lock file on every successful flock. Backward-compatible: all existing callsites get PID audit metadata for free; no per-callsite edits required.
- **D3c — atomic writes** — `src/abstractions/fs.ts::atomicWrite` already ships `.tmp.<pid>.<rand>` + `fsync` + `rename` pattern; all state-file writers (kanban, decisions, flags, paused, eternal-improvement, budget-*) already route through it. **No new function, no callsite migration** — D3c is satisfied by the existing primitive; the ADR records the explicit contract.
- **D3d — size-cap groom** for `lead-outbox.md` + `inboxes/<member>.json` at 1 MB / 24 h hard min retention. *Status:* groom-side; surfaces as a follow-up Task in the kanban (cross-lane with the cron-groom port).

Operator note: `.atmux/logs/lock-recovery.log` is the audit trail. Entries appearing in the file mean auto-recovery worked as designed.

### D4 — Per-member health probes (Class D)

**Shipped:** commit `ab7e5a6` (R57-T4, 2026-05-07).
**Modules:** [`src/core/perm-mode-drift-state.ts`](../../src/core/perm-mode-drift-state.ts), [`src/core/idle-skip.ts`](../../src/core/idle-skip.ts), [`src/core/heartbeat.ts`](../../src/core/heartbeat.ts).

Four sub-probes added to the whip-tick:

- **D4a — permission-mode drift** — `parsePermissionMode` reads `⏵⏵ <mode> on` indicator from each member's pane; non-`auto` modes emit `[whip-perm-mode-drift]` Discord ping with `BTab cycle to auto` recovery hint. Per-member 24 h dedup via `.atmux/state/perm-mode-drift-state.json`.
- **D4b — idle false-positive guard** — `shouldSkipIdleIncrement` cross-references heartbeat freshness (D6 substrate) against the per-member idle-tick counter. Fresh heartbeat (<5 min) + non-empty `inbox.inProgress` → SKIP idle increment. The predicate ships ahead of any future revival; tests today, wire-up when consumer code lands (ADR-043 team-level idle is unchanged).
- **D4c — defunct cwd** — per-member `tmux display-message -p '#{pane_current_path}'` probe; missing path → P1 `[whip-defunct-cwd]` Discord ping (no dedup — fires every tick until operator restores or pauses).
- **D4d — per-member rate-limit visibility** — existing `snap.rateLimit` branch surfaces silently rate-limited members (no in-progress task); D1's discrete classifier adds belt-and-braces `RATE-LIMIT` recognition for banner-regex divergence.

Out of scope: auto-recovery (BTab-cycle automation). v1.1.x is surface-only — operator acts on the ping.

### D5 — Coordination semantics drift (Class E)

**Shipped:** commit `6882201` (R57-T5, 2026-05-07).
**Modules:** [`src/verbs/doctor.ts`](../../src/verbs/doctor.ts), [`src/core/window-id.ts`](../../src/core/window-id.ts), [`src/abstractions/tmux.ts`](../../src/abstractions/tmux.ts), [`src/verbs/dispatch.ts`](../../src/verbs/dispatch.ts), [`src/core/tz-lint.ts`](../../src/core/tz-lint.ts), [`scripts/lint-tz.ts`](../../scripts/lint-tz.ts).

- **D5a — submodule integrity** — `atmux doctor` adds a finding when `git diff --submodule=log` shows pointer mismatch AND submodule HEAD ≠ parent's recorded SHA.
- **D5b — window-ID resolution** — `src/core/window-id.ts` is the emoji-prefix-tolerant glob resolver. `src/abstractions/tmux.ts` + `src/verbs/dispatch.ts` route supervisor send-keys through immutable tmux window IDs (`@N`). **Supersedes the earlier P1 emoji-prefix-glob fix** — window IDs are immutable across renames, so they fix a strictly stronger version of the problem (any window rename, not just emoji-prefix divergence). Closes ADR-048's bare-window-names supervisor gap.
- **D5c — inbox-mark verify** — `doctor` cross-checks `.atmux/inboxes/<member>.json` `inProgress` slice vs `kanban.json` status; drift surfaces as a finding (witnessed as the orphan `📤 task t-706655ee` in `docs.json` after kanban owner moved to `whip-impl`).
- **D5d — TZ-explicit timestamp lint** — `src/core/tz-lint.ts` + `scripts/lint-tz.ts` + `package.json::lint:tz`. Catches bare `date` / `new Date()` / non-MYT timestamps in user-facing surfaces (Discord templates, driver-inbox writes, commit-rendered times) per [Global CLAUDE.md §Conventions](https://github.com/anthropics/claude-code) timezone rule. Reviewer-gate enforces on touched code.

### D6 — Heartbeat + watchdog + verified status (Class F) ⭐ FOUNDATIONAL

**Shipped (D6a + D6b foundational):** commit `3fc6651` (R57-T6, 2026-05-07).
**Modules:** [`src/core/heartbeat.ts`](../../src/core/heartbeat.ts), [`src/verbs/watchdog.ts`](../../src/verbs/watchdog.ts), [`src/abstractions/discord.ts`](../../src/abstractions/discord.ts).

D6 is **foundational** — D3a's lock-TTL recovery uses heartbeat freshness as the live-PID substrate; D4b's idle false-positive guard reads heartbeat ages. Operators staging adoption land D6 first.

- **D6a — supervisor-written heartbeats** — supervisor reads each pane's `pane_active` + `pane_last_activity` and writes `.atmux/heartbeats/<member>.epoch` every 60 s on behalf of members. Supervisor-write was chosen over per-claude-pane hooks (see OQ-1 in the retired bun-port ADR-057 history) because it works uniformly for non-Claude TUIs. **R57-T6 landed the file primitives (`writeHeartbeat` / `readHeartbeat` / `isHeartbeatStale` / `readHeartbeatAges`); the supervisor wire landed via Task `t-7e291a53` (commit `de86103`, 2026-05-17) — `atmux heartbeat-write` verb + `poke` per-member wire.**
- **D6b — `atmux watchdog` as separate `*/2` cron** — independent of whip's body-hash logic so a stuck whip doesn't blind the watchdog. Reads heartbeats, checks freshness against `heartbeatStaleSec` (default 300 s), fires `[whip-watchdog]` Discord on stale members with hash-keyed 24 h re-fire dedup (`.atmux/state/watchdog-state.json`), audit-logs every finding to `.atmux/logs/watchdog.log` regardless of dedup gate, exits. Discord send failure is non-fatal. **Cron migration required for existing teams** — see [`docs/RUNBOOK-cron-migration.md`](../RUNBOOK-cron-migration.md).
- **D6c — `atmux status` reads heartbeats (not cache)** — eliminates the false-down cascade (`atmux status` reported 🟢 while cage was dead, c-8ecd3a61). Folds driver pre-decision P3 ("atmux status cache lies → heartbeats-not-cache"). **Shipped via Task `t-302e8ec6` (commit `320fa6e`, 2026-05-17).**
- **D6d — cron-groom window-order invariant** — `tmux list-windows -t <session> | tail -1 | grep -q supervisor` style check + P2 finding on violation. Folds driver pre-decision P2 ("cron-groom window-order → D6d golden-file"). *Status:* todo — sibling Task in this Epic (see §Residual scope below).

### D7 — Push-discipline + remote-coordination (Class G)

**Shipped:** commit `2228e64` (R57-T7, 2026-05-07).
**Module:** [`src/core/auto-push.ts`](../../src/core/auto-push.ts), [`src/verbs/claim.ts`](../../src/verbs/claim.ts) (`done()` wire).

Closes driver pre-decision G1 (7 commits unpushed witnessed in driver-inbox real-time).

- **D7a — auto-push at task-end** — `atmux done <task>` triggers `git fetch origin <branch>` + (optional rebase) + `git push origin <branch>` for non-staging branches. Push failure → P3 flag + `.atmux/logs/auto-push.jsonl` audit entry; **does NOT block the kanban transition**. The done transition is the source of truth; the push is best-effort.
- **D7b — pre-push rebase-on-fetch** — multi-porter race mitigation. Conflicts → P1 flag + `git rebase --abort` + abort-rebase-conflict outcome; porter resolves manually.
- **D7c — reviewer notification** — `[whip-pr-update]` Discord template + renderer is the eventual surface. *Status:* deferred at R57-T7 ship (template scaffolding pending); the audit log captures every push outcome in the interim.

CLAUDE.md global push policy still applies: staging-shaped branches (`*-staging` / `main` / `master` / `production`) refuse auto-push without `team.json::stallPrevention.allowedPushBranches` override. Disable entirely via `autoPushOnDone = false`.

## Cross-class deps

```
D6 (heartbeat)  ← D4 (per-member health uses heartbeat freshness)
D6 (heartbeat)  ← D3 (lock-TTL uses live-PID + heartbeat-as-substrate)
D5b (window-ID) ← D1 (pane-state classifier uses window IDs for addressability)
D3d (size-cap)  ← D2a (auto-archive shares the archive path)
```

**Implementation order followed:** D6 first (foundational); D1 + D5b in parallel (Wave 1); D7 in parallel with Wave 1; D2 after archive infra (Wave 2); D3 + D4 parallel after D6 lands. Operators staging adoption mirror this sequence.

**D5b strictly supersedes D1's window-name approach** — earlier proposals mentioned an emoji-prefix-glob in the supervisor send-keys path; that's stale. Window-ID resolution is the canonical fix and covers the broader rename-class invariant, not just emoji prefixes.

## Folded driver pre-decisions

Four driver pre-decisions surfaced during the design window (2026-04 → 2026-05-06) and were absorbed into the D-section structure rather than spun out as separate ADRs:

- **P1 — supervisor send-keys emoji-prefix glob** → **D5b window-ID resolver**. The glob fix would have papered over a smaller version of the same problem; window-ID resolution is strictly stronger because it survives any window rename, not just the emoji-prefix divergence case.
- **P2 — cron-groom window-order invariant** → **D6d golden-file**. The bun-port `src/core/cron.ts` `renderCronLines` / `renderCronBlock` are pure renderers; the golden-file pin is the parity test that catches drift between bun-port and any future re-implementation, and between gated / ungated cron lines.
- **P3 — `atmux status` cache lies post-budget-pause** → **D6c heartbeats-not-cache**. Status now reads `.atmux/heartbeats/<member>.epoch` for liveness with pane-current-command as TUI-state fallback; the cache-based false-down cascade is eliminated.
- **G1 — 7 commits unpushed** → **D7a auto-push on done**. The kanban transition is the source of truth; auto-push is best-effort and the audit log at `.atmux/logs/auto-push.jsonl` captures every outcome (success / skipped-staging / fail-fetch / abort-rebase-conflict / fail-push).

## Residual v1.1.x scope

The following follow-on items in this Epic (`e-2c1ac890`) carry the v1.1.x design across the finish line:

| Sub-decision | Task ID | Lane | Status (2026-05-17) | Shipped SHA |
| --- | --- | --- | --- | --- |
| D6a supervisor-write wire | `t-7e291a53` | be | done | `de86103` |
| D6c `atmux status` reads heartbeats | `t-302e8ec6` | be | done | `320fa6e` |
| D6d cron-golden-file parity test | `t-bb519494` | test | todo | — |
| TeamWhip.stallPrevention schema extension | `t-fbfb02f8` | db | todo | — |
| REVIEW gate (coverage table + doc-update column) | `t-a2dbdcd1` | review | todo | — |

The TeamWhip schema extension (Task `t-fbfb02f8`) closes the gap flagged in R57-T6's commit body: `watchdog.ts:176` reads `team.whip.stallPrevention` with a defensive `as { stallPrevention?: { heartbeatStaleSec?: unknown } }` cast because the canonical shape was never promoted from `TeamStallPreventionShape` (ad-hoc interface in `src/core/auto-push.ts:280`) into the strict TeamWhip schema. Until that lands, typos in `team.json::whip.stallPrevention.*` are silently ignored.

The D6d golden-file (Task `t-bb519494`) pins the marker-fenced crontab block shape so future cron-line additions or reorderings trip a loud test failure rather than silently breaking crontab parity. ADR-029 §F6 byte-equal bash parity invariant applies.

## Out of scope

- **ADR-053 / 054 / 055 / 056 docs/adr/ landings** — sibling docs gap; the decisions shipped via commits + bun-port adr-bun tree. File separately if driver requests.
- **`eslint-plugin-local::no-direct-send-keys`** rule (D1 §Lint gate) — deferred; per-callsite adoption rolls out as supervisor / dispatch / send / whip surfaces are touched.
- **Auto-recovery for D4a / D4c** — BTab-cycle and worktree-restore automation. v1.1.x is surface-only; operator acts on the ping.
- **D2a auto-archive groom** wire-up — gated on the cron-groom port; primitives shipped, wire pending.
- **D7c `[whip-pr-update]` Discord template** — audit log captures push outcomes in the interim; template scaffolding pending.
- **Cross-host heartbeat semantics** — `acquireWithTTL` default `isAlive` uses POSIX `process.kill(pid, 0)` which is single-host. Multi-host coordination is a v1.2+ concern.
- **ADR renumbering or supersession** — this is the canonical first landing of ADR-057; revisions get a new ADR per the project's append-only convention.

## References

- Shipped commits (chronological): `dfe4e26` (R57-T1, D1) · `9c50354` (R57-T2, D2) · `884c068` (R57-T3, D3) · `ab7e5a6` (R57-T4, D4) · `6882201` (R57-T5, D5) · `3fc6651` (R57-T6, D6 foundational) · `2228e64` (R57-T7, D7) · `dc7fe77` (R57-T8, docs) · `de86103` (D6a wire) · `320fa6e` (D6c status reads heartbeats).
- Operator playbook: [`docs/RUNBOOK-stall-recovery.md`](../RUNBOOK-stall-recovery.md).
- Cron migration: [`docs/RUNBOOK-cron-migration.md`](../RUNBOOK-cron-migration.md).
- Original bun-port rationale is retained, not duplicated here: the retired bun-port ADR-057 was referenced by the retired `HANDOFF.md` operator section. The file is no longer in the tree after bash decommission commit `2696539`, but the rationale is reconstructed verbatim above.
- Related ADRs: ADR-043 (idle counter, D4b interaction) · ADR-048 (window naming, D5b precursor) · ADR-049 (rate-limit windows, D4d / D1 RATE-LIMIT state) · ADR-053 (executor budget-pause, D7 staging-branch carve-out) · ADR-054 (TeamWhip strict schema, residual scope) · ADR-085 (lint / verb-discovery surface, D1 deferred lint).

## §Amendment 2026-05-20 — partial supersession by ADR-126 (D3a `acquireWithTTL` + D3c atomic-write for SQLite-migrated state)

§D3a (`acquireWithTTL` flock-with-TTL + PID-liveness + audit log) and §D3c (atomic-write via `.tmp.<pid>.<rand>` + `fsync` + `rename`) are **mostly obsolete for state-files migrated to SQLite** per [ADR-126](./126-sqlite-state-store.md) (`Supersedes / extends: ADR-098 (JSON+lock model) — narrows the JSON scope; ADR-057 D3a/D3c (lock-TTL + atomic-write) — becomes mostly obsolete for migrated state, retained for the JSON files that stay`). Tasks / epics / stories / inboxes now live in `.atmux/state.db` (SQLite, WAL) and use SQLite's own concurrency primitives (`BEGIN IMMEDIATE` transactions per ADR-091 + ADR-134 §State machine) — the file-level lock-TTL + atomic-write contract no longer governs those paths.

The supersession is **scoped to migrated state**. §D3a + §D3c still stand verbatim for the JSON files that remain post-ADR-126: `team.json`, `cockpit.json`, JSONL append-logs (whip / audit / sentinel state), the markdown surface (`flags.md`, `decisions.md`, `outbox.md`, `driver-inbox.md`), and bash-atmux's full state surface (legacy compatibility shim). The other six §D sections (D1 RATE-LIMIT state, D2 idle false-positive guard, D4 single-task throughput sense, D5 watch-state-not-task, D6 heartbeat substrate, D7 budget-pause staging-branch carve-out) are not touched by ADR-126 and remain canonical for the stall-prevention layer.

**Filed via** t-2d750500 (T2 sweep of [docs/audits/adr-supersession-audit-2026-05-20.md](../audits/adr-supersession-audit-2026-05-20.md) D1 drift #5, 2026-05-20).
