# ADR-057: atmux stall prevention — pane-state, heartbeat, lock-TTL, inbox-bounding, push-discipline

**Status:** proposed
**Date:** 2026-05-07
**Owner:** planner
**Driver-ref:** driver-inbox.md 09:44 MYT 2026-05-07 — 7-class failure-mode taxonomy
**Release scope:** v1.1.x (post-v1.0.0; deferred per planner's earlier ADR-057+ defer call which lead confirmed; this ADR codifies the v1.1.x roadmap for the deferred work)

## Context

George surfaced in chat: *"atmux whip sometimes doesn't wake team leads and things get stuck... any other way things can get stuck and we can address it?"* Driver enumerated a 7-class failure-mode taxonomy in driver-inbox 09:44 MYT 2026-05-07. Each class has 3-7 sub-points + a mitigation sketch. Total: 25 distinct failure modes, ~7 mitigation surfaces.

Driver gave planner full latitude on ADR shape. Three options were considered:

1. **Single mega-ADR-057** — one document, 7 sections, complete narrative.
2. **Split per class (ADR-057 through ADR-063)** — independent dispatchability; cross-class dep tax.
3. **Fold into existing ADRs** (Mode B in 052, doctor in 054, groom-area, etc) — zero new ADRs but scope-creep on stable ADRs.

**Decision: single ADR-057 with per-class Decision sections + per-class Tasks for decomp.** Reasoning: the 7 classes share a meta-pattern (*observability + verification at coordination boundaries*) — that's one architectural decision, not seven. Cross-class dependencies are real and intentional:

- F's heartbeat infrastructure is the substrate for D's per-member health check.
- C's lock-TTL handler uses F's heartbeat freshness to determine "is the writer alive?".
- A's pane-state classifier uses E's window-ID-not-name addressability.
- B's bounded driver-inbox uses C's archive path.

Splitting per class would surface these deps as ADR-cross-references, which obscures the single-design intent. Folding into existing ADRs would either (a) scope-creep ADR-052/054/055 with material that doesn't belong, or (b) lose the failure-mode-coverage framing that makes this work auditable.

The ADR carries the coherent narrative; the Tasks land independently with their own reviewer gates. That gives both the design clarity AND the dispatch atomicity.

### Driver pre-decided Open items folded in

- 🚨 P1 supervisor send-keys: **option (b) emoji-prefix glob** decided. Folds into D1 (Class A7) + D5 (Class E4).
- 🟡 P2 cron-groom missing window-order invariant: fold into **parity-cron-impl golden-file work** (~10 LOC). Folds into D6 (Class F).
- 🟡 P3 atmux status cache lies post-budget-pause: fold into **supervisor revive** (D6 Class F1).
- 🆕 G1 7-commits-unpushed: deferred to next porter task-end push (no design change; just enforcement). Folds into D7 (Class G).

### What this ADR is NOT

- **Not** a re-architecture of supervisor / whip / coordination. The existing primitives (atmux send / dispatch / claim / done / reply / handoff / pause / resume) stay. This ADR adds verification + bounding + recovery layers ON TOP.
- **Not** v1.0.0 work. Per planner's earlier ADR-057+ defer call (confirmed by lead 09:44 MYT), all 7 classes land post-v1.0.0.
- **Not** a one-shot landing. Each class lands as its own Task with its own reviewer gate; partial v1.1.x releases (e.g., A+F+G first, B+C+D+E later) are acceptable.

## Decision

### D1 — Class A: Pane-state classifier as pre-flight gate for all `tmux send-keys`

**Failure modes addressed:** A1 compacting state · A2 rate-limit banner · A3 auto-mode permission prompt · A4 queued-message state · A5 Anthropic feedback modal · A6 pane respawned to bash · A7 window-name drift (folded with D5).

**Mitigation:** introduce `src/core/pane-state.ts` as the single source of truth for pane-state classification. Before every `tmux send-keys` call (across `src/abstractions/tmux.ts`, supervisor, whip, dispatch, send), gate via `classifyPane(target) → READY | TYPING | MODAL | RATE-LIMIT | COMPACTING | SHELL | UNKNOWN`. Send only when `READY`; other states route to escalation:

| State | Escalation |
|---|---|
| `READY` | proceed |
| `TYPING` | retry after configurable delay (default 2s, max 3 retries) |
| `MODAL` | log + flag P3 (operator dismisses) |
| `RATE-LIMIT` | log + ADR-053 budget-pause path takes over |
| `COMPACTING` | retry after configurable delay (default 5s, max 6 retries — 30s total) |
| `SHELL` | flag P2: pane respawned; needs operator re-spawn or `atmux team rotate-member` |
| `UNKNOWN` | log + flag P2 (defensive: don't send into unknown state) |

Classification rules (single regex pass over `tmux capture-pane -p -t <target>` output):

- `Compacting conversation` → COMPACTING
- `You've hit your limit` / `extra usage` → RATE-LIMIT
- `Bad / Fine / Good / Dismiss` (Anthropic feedback) → MODAL
- `Press up to edit queued messages` → MODAL (queued state)
- Permission-prompt patterns (`Do you want to ...?`) → MODAL
- `pane_current_command` ≠ `claude|opencode|kimi|cursor-agent` → SHELL
- prompt-ready glyphs (cursor in expected position, no banners) → READY
- otherwise → TYPING (mid-response, will become READY)

`tmux send-keys` callers MUST go through `safeSendKeys(target, text)` which gates on classifyPane + applies retry policy. Direct `tmux.send_keys` calls without the gate become a lint violation (eslint custom rule); reviewer-gate enforces.

**Out of scope:** Bash-side `lib/whip.sh` / `lib/super-status.sh` / `lib/dispatch.sh` callers. Per ADR-013, the bash WIP doesn't get retroactive port-forward; this ADR is bun-side only.

### D2 — Class B: Bounded driver-inbox + delta-only reads

**Failure modes addressed:** B1 lead mid-long-tool-call · B2 lead just `/clear`'d · B3 anchored on stale view · B4 lead rotation mid-plan.

**Mitigation:** four sub-decisions.

**D2a — Driver-inbox auto-archive at 1MB or N=200 entries.** When `wc -c .atmux/driver-inbox.md > 1_048_576` OR entry count > 200: groom moves entries older than 24h to `.atmux/archive/driver-inbox-<YYYYMMDD>.md` (atomic rename + truncate + re-prepend frontmatter). Active inbox stays ≤200 entries. **Hard min retention: 24h** (no entry younger than 24h is archived, regardless of size — ensures lead can always read the recent context).

**D2b — Delta-only loads via cursor file.** `.atmux/state/last-driver-inbox-read.txt` (epoch). Lead reads driver-inbox via `atmux outbox` (existing) but the verb's read-side now slices by `mtime > cursor`. Returns only entries newer than cursor. Cursor updates on read. Recovery path: `atmux outbox --since <ts>` overrides cursor for backfill.

**D2c — Pre-rotate handoff file.** When lead's rotation triggers (60min auto-rotate per existing flow), the outgoing lead writes `.atmux/state/lead-handoff-<epoch>.md` with: in-flight Task IDs, pending decisions, last 3 driver-inbox entries summarized, current Mode B / budget-pause / account-swap state. Incoming lead reads this BEFORE re-loading driver-inbox. `atmux team rotate-lead` extends to do this write.

**D2d — Stale-view detection.** Whip checks `last-driver-inbox-read.txt` cursor freshness vs driver-inbox `mtime`. If lead's cursor is >2h behind driver-inbox's tip AND driver-inbox has new content: emit `[whip-stale-anchor]` finding (single ping per stale window; dedup by hash of the unread tip's first line).

### D3 — Class C: Lock-TTL + partial-write recovery + size-cap auto-archive

**Failure modes addressed:** C1 orphan locks · C2 partial-write corruption · C3 inbox unbounded growth · C4 multi-driver race.

**Mitigation:** four sub-decisions.

**D3a — Lock-TTL of 5min.** Every `*.lock` file in `.atmux/` gets a TTL. When `acquire(lockPath)` fails to flock AND the existing lock's `mtime > now - 5min` AND no PID in the lock file is alive (via `kill -0`): force-release with audit log to `.atmux/logs/lock-recovery.log` (single line per recovery: epoch + path + previous PID + reason). Live PID = lock stays held (real contention; wait policy applies). `src/abstractions/lock.ts` extends with `acquireWithTTL(path, ttlSec)`.

**D3b — Lock files carry PID.** Every lock acquire writes `<pid>` to the lock file (atomic write before flock). Lock-recovery reads the PID for liveness check. Existing flock-only callers migrate as part of this ADR.

**D3c — Partial-write recovery via fsync + tmp+rename.** Every state-file writer (kanban.json, decisions.md, flags.md, paused.json, etc.) MUST use `writeAtomic(path, content)` which writes to `<path>.tmp.<pid>`, fsync, rename. Race-safe + crash-safe. Existing callers audit'd; non-atomic writers replaced. The 5+ `kanban.json.bak.*` files visible in driver-inbox are evidence this currently fails; this Decision closes it.

**D3d — Inbox size-cap auto-archive at 1MB.** Same pattern as D2a but for `.atmux/lead-outbox.md` and `.atmux/inboxes/<member>.json`. Groom moves entries >24h old to `.atmux/archive/<file>-<YYYYMMDD>`. Hard min retention 24h.

### D4 — Class D: Per-member health probes

**Failure modes addressed:** D1 wrong permission-mode · D2 false-positive idle auto-stop · D3 defunct cwd · D4 individual rate-limit.

**Mitigation:** four sub-decisions.

**D4a — Permission-mode probe.** On every whip-tick, check each member's pane status-line for permission-mode indicator (`⏵⏵ <mode> on` glyph). If not `auto`: emit `[whip-perm-mode-drift]` finding with the recovery hint "BTab cycle to auto"; per-member dedup 24h.

**D4b — Idle false-positive guard.** Cross-reference D6's heartbeat freshness against ADR-043's idle-tick counter. If member's heartbeat < 5min old AND inbox.inProgress is non-empty: idle counter must NOT increment for that member. ADR-043's body-hash idle-tick stays as the team-level signal; this fix is per-member.

**D4c — Defunct cwd probe.** Cron-groom checks each member's pane `pane_current_path` exists on disk. If gone (worktree deleted): emit P1 flag + Discord `[whip-defunct-cwd]`.

**D4d — Per-member rate-limit detection.** Already captured by Class A's pane-state classifier (RATE-LIMIT state). When ANY member shows RATE-LIMIT: surface in whip findings even if the member has no in-progress task (today: silent dark member is invisible).

### D5 — Class E: Coordination semantics drift

**Failure modes addressed:** E1 submodule pointer mismatch · E2 TZ drift · E3 inbox-mark drift · E4 window-name drift (folded with D1 A7).

**Mitigation:** four sub-decisions.

**D5a — Submodule pointer integrity check.** `atmux doctor` adds a finding when `git diff --submodule=log` shows a pointer mismatch + the submodule's HEAD doesn't match the parent's recorded SHA. Cron-groom invokes `atmux doctor --json` per tick; new submodule findings raise P2 flag.

**D5b — Supervisor uses tmux window IDs (`@N`), not names.** Today: supervisor addresses `__<team>__lead` by name; rename + drift breaks dispatch (P1 from inbox). Window IDs are immutable across renames. `src/core/tmux.ts` `resolveWindow(team, member) → windowId` stamps + caches the ID at first lookup; subsequent dispatches use ID. Cache invalidates on tmux session restart. Solves emoji-prefix glob (option b decided) AND future window-name drift uniformly.

**D5c — Inbox-mark verification.** Lead writes `✅ done` markers in driver-inbox; today nothing checks the marked work actually shipped. Doctor adds a finding: scan driver-inbox `## Open` for entries marked `📤 task <id>` AND check that task is in kanban (status: any) AND completed/in-flight. Emits P3 for orphans.

**D5d — TZ-explicit timestamp lint.** All atmux verbs that emit timestamps to user-facing files (driver-inbox, lead-outbox, decisions.md, flags.md, history-log) MUST format with explicit MYT suffix per CLAUDE.md "Timezone" rule. New eslint rule + bash linter (whichever ports first) blocks bare `HH:MM` strings without timezone in those files. Reviewer-gate enforces.

### D6 — Class F: Heartbeat + watchdog + verified status

**Failure modes addressed:** F1 status cache lies · F2 no process-tree liveness check · F3 heartbeat absent · F4 kanban shows in-progress but member stalled.

**Mitigation:** four sub-decisions.

**D6a — Per-member heartbeat file.** `.atmux/heartbeats/<member>.epoch` written by each member's claude-code process every 60s (via a hook on tool-return or a periodic writer). Cron-groom reads + checks freshness; >5min stale = pane is genuinely stuck.

How members write heartbeats: simplest path = supervisor reads each pane's `pane_active` + `pane_last_activity` (existing tmux state) and writes the heartbeat file ON BEHALF of each member. Cleaner than every claude session running a hook. Implementation in supervisor, not member.

**D6b — Watchdog as separate cron.** New cron line installed by `atmux start` (extends D2 of ADR-053's cron-block):

```cron
*/2 * * * * cd <project> && atmux watchdog
```

`atmux watchdog` is lightweight: read all heartbeats, check freshness, fire `[whip-watchdog]` Discord on stale members, exit. Independent of whip's body-hash logic so a stuck whip doesn't blind the watchdog.

**D6c — `atmux status` reads heartbeats, not cache.** Today: `atmux status` reads tmux pane attributes which can stale post-budget-pause. After this Decision: status reads heartbeat files for liveness AND falls back to pane-current-command for TUI state. Heartbeat-fresh + TUI-correct = (up); heartbeat-stale OR TUI-wrong = (down). Eliminates the false-down cascade reported on driver-inbox 13:02 + 17:16 MYT.

**D6d — cron-groom window-order invariant** (P2 decision per driver). On each groom tick: `tmux list-windows -t <session> | tail -1 | grep -q supervisor || warn` style check. Folded into parity-cron-impl golden-file work (~10 LOC).

### D7 — Class G: Push-discipline + remote-coordination

**Failure modes addressed:** G1 local commits not pushed · G2 partial-batch push · G3 multi-porter push race.

**Mitigation:** three sub-decisions.

**D7a — Auto-push at task-end (claim → done transitions).** When `atmux done <task>` succeeds AND the team's branch is non-staging (per CLAUDE.md push policy): immediately push origin. New verb `atmux done` extends to call `git push --no-verify=false origin <branch>` after the kanban transition. Failure → flag P3 + log; do NOT block the done transition.

**D7b — Pre-push rebase-on-fetch.** Multi-porter race: 2+ porters complete tasks simultaneously, both push, second loses fast-forward. Mitigation: `atmux done` does `git fetch origin <branch> && git rebase origin/<branch>` before the push. Conflicts → flag P1 + log + abort push (porter resolves manually).

**D7c — Reviewer notification via PR webhook.** Today: reviewer runs `git log` to see commits. After this: PR webhook (configured at PR creation time) notifies reviewer via Discord on each push. PRs without webhook configured (e.g. internal branches) get a manual `[whip-pr-update]` Discord ping fired by `atmux done` after push.

### Cross-class dependencies (intentional, not accidental)

```
D6 (heartbeat) ← D4 (member-health uses heartbeat freshness)
D6 (heartbeat) ← D3 (lock-TTL uses live-PID check + heartbeat-as-substrate)
D5b (window IDs) ← D1 (pane-state classifier uses window IDs for addressability)
D3d (size-cap) ← D2a (auto-archive shares the archive path)
```

Implementation ordering MUST respect these. D6 lands first (foundational); D1 + D5b can land in parallel; D2 + D3 + D4 + D7 land in any order after their deps clear.

### Configuration surface

All knobs land in `team.json::stallPrevention` block (typed in ADR-054's TeamWhip — but as a sibling block, not under `whip`):

```jsonc
{
  "stallPrevention": {
    "paneStateRetryDelays": { "TYPING": 2, "COMPACTING": 5 },
    "paneStateMaxRetries": { "TYPING": 3, "COMPACTING": 6 },
    "driverInboxArchiveSizeBytes": 1048576,
    "driverInboxArchiveMaxEntries": 200,
    "driverInboxMinRetentionHours": 24,
    "lockTtlSec": 300,
    "heartbeatIntervalSec": 60,
    "heartbeatStaleSec": 300,
    "watchdogCronInterval": "*/2",
    "autoPushOnDone": true,
    "rebaseBeforePush": true,
    "submoduleIntegrityCheck": true
  }
}
```

ADR-054's `TeamWhip` extends to include `stallPrevention` Zod schema. Drift detection covers it.

### Test coverage

Per CLAUDE.md TestingDiscipline (100% on tracked paths, tests in same commit):

- `tests/unit/core/pane-state.test.ts` — 7 state classifications + edge cases (empty pane / no claude / stale capture).
- `tests/unit/abstractions/tmux.test.ts` (extend) — safeSendKeys gating.
- `tests/unit/verbs/watchdog.test.ts` — heartbeat-stale detection + Discord ping.
- `tests/unit/abstractions/lock.test.ts` (extend) — TTL + live-PID + recovery audit.
- `tests/unit/abstractions/fs.test.ts` (extend) — writeAtomic happy + crash mid-rename.
- `tests/unit/state/heartbeat.test.ts` — supervisor write path; staleness threshold.
- `tests/e2e/stall-prevention.test.ts` — synthetic stall scenarios per class (1 e2e per class).

## Consequences

- **George's original complaint resolved.** A1-A6 (wake-up delivery) gated by D1 pane-state classifier. Send-keys into compacting / rate-limit / modal / shell never silently swallows input again.
- **Supervisor send-keys P1 (window-name drift) closed.** D5b's window-ID approach makes emoji-prefix renames a no-op — supervisor caches @N, doesn't care about the name. Replaces option (b) emoji-prefix glob with a strictly stronger fix.
- **False-down `atmux status` cascade fixed.** D6c reads heartbeats for liveness; cache lies eliminated.
- **Orphan locks self-recover.** D3a + D3b unblock writers without operator intervention. Audit log preserves recovery history for postmortems.
- **Driver-inbox stays readable.** D2a + D2d + D3d cap growth + surface stale-anchor cases. Lead never skim-skips a 1500-line inbox unknowingly.
- **Push race + missing pushes closed.** D7a-c keep `origin/<branch>` up-to-date with each porter task-end; reviewer never wonders why kanban shows progress but PR is silent.
- **Member-side stalls become visible.** D4 + D6 turn currently-invisible cases (defunct cwd, individual rate-limit, stuck post-`/clear`) into Discord findings + flags.
- **Cron noise increases by 1 line per team** (D6b watchdog `*/2`). Negligible system cost; major UX win.
- **`team.json` schema grows by ~12 fields.** Manageable; ADR-054's drift-ping covers typo cases.
- **Reviewer load increases** during v1.1.x rollout (7 Tasks each with reviewer gate). Mitigated by sequential dispatch + per-class scope keeping reviews short (~50-100 LOC each).
- **No backwards-compat shims required.** All Decisions are additive; existing primitives keep current semantics. Operators on old `team.json` get safe defaults via Zod (per ADR-054).

## Considered alternatives

### A. Split into 7 ADRs (ADR-057 through ADR-063)

Discarded per §Context — cross-class dependencies are real and would surface as ADR-cross-references, obscuring the single-design intent. 7 reviewer-gates on near-identical scopes wastes reviewer cycles.

### B. Fold all 7 classes into existing ADRs (Mode B in 052, doctor in 054, groom in some other)

Discarded — would scope-creep ADR-052 (eternal-improvement) and ADR-054 (zod-whip-config) with material that doesn't belong. Also loses the failure-mode-coverage framing that makes this work auditable as a coherent v1.1.x release.

### C. Defer to v1.2.x

Discarded — driver explicitly asked for ADR-shape + Tasks NOW. v1.1.x defer is appropriate (post-v1.0.0); v1.2.x defer would be over-cautious and lets known stalls keep happening for another release cycle.

### D. Per-class ADRs INSIDE a single epic (ADR-057-A through ADR-057-G)

Considered. Discarded — non-standard ADR shape; reviewer tooling expects single-file ADRs; no precedent in `docs/adr-bun/`.

### E. Skip Class G (push-discipline) — porter task-end push is "operator discipline"

Discarded — G1 (7 commits unpushed RIGHT NOW per driver-inbox) is exactly the failure mode that proves operator-discipline isn't enough. Auto-push at task-end is cheap (3 LOC + 1 fetch+rebase) and closes the silent-stall class.

### F. Mode B absorbs Class B (bounded driver-inbox)

Considered. Discarded — Mode B's preemption logic reads driver-inbox to detect new asks; the bounding policy is independent. Different concerns; coupling them would entangle Mode B's lifecycle with archive scheduling.

## Open questions

### OQ-1 — Heartbeat write path: supervisor vs claude-code hook (medium reversibility)

**Recommended default:** supervisor writes on behalf of members (D6a). Cleaner; doesn't require every claude session to run a hook; works for non-claude TUIs.

**Alternative:** each claude pane runs a `Stop`-event hook that writes the heartbeat. Requires Claude Code hook config + works only for claude TUIs (kimi/cursor/opencode would need parallel impl).

**Override window:** until D6 implementation Task lands. After, the supervisor write-path is the canonical SoT; switching costs a refactor.

### OQ-2 — Lock-TTL value: 5min vs longer (low reversibility)

**Recommended default:** 5min. Long enough to never falsely-recover during legitimate slow ops (large kanban writes ~50ms; 5min is 6000× headroom). Short enough that orphan-lock impact on stalled writers is bounded.

**Alternative:** 15min (more conservative). Cost: longer stalls when writers genuinely crash.

**Override window:** flippable in code (single constant) + runtime via `team.json::stallPrevention.lockTtlSec`.

### OQ-3 — Auto-push policy edge cases (medium reversibility)

**Recommended default:** auto-push on every `atmux done` for non-staging branches. Per CLAUDE.md push policy, staging branches are George-manual ONLY — auto-push respects that gate.

**Alternative:** auto-push only when N done-events accumulate (batched). Cost: longer windows of un-pushed commits.

**Override window:** `team.json::stallPrevention.autoPushOnDone = false` disables; cheap flip.

### OQ-4 — Watchdog cron interval (low reversibility)

**Recommended default:** `*/2`. Faster than whip's `*/5`; slower than whip-resume-check's `*/1` (which is account-scope). Adequate for member-stall detection.

**Alternative:** merge into whip-resume-check (same `*/1` line). Cost: couples concerns.

**Override window:** `team.json::stallPrevention.watchdogCronInterval` flippable.

### OQ-5 — Submodule integrity check action (low reversibility)

**Recommended default:** doctor finding only (no auto-fix). Submodule pointer mismatches are usually intentional WIP; auto-fix would clobber work.

**Alternative:** cursor self-heal recipe `fix:submodule-pointer-drift` (per ADR-055). Out of scope for v1.1.x; surface in ADR-055's future-recipes section if demand emerges.

### OQ-6 — Pane-state classifier vendor: bash regex vs library (low reversibility)

**Recommended default:** custom regex per state (~50 LOC total). Anthropic banner shapes are stable; library would be over-engineering.

**Alternative:** screen-scraping library (e.g. `ansi-escapes`-aware parser). Cost: dependency + maintenance.

**Override window:** code-level flip; cheap.

### OQ-7 — Inbox-mark verification depth (low reversibility)

**Recommended default:** scan for `📤 task <id>` markers in `## Open` AND check kanban presence. Don't verify the *correctness* of the mark (that the task done actually addresses the marked Open).

**Alternative:** semantic verification (lead's mark must reference the same intent). Out of scope; would need LLM judge.

**Override window:** flippable in doctor's check.

## Termination signals

`proposed → accepted` flip is gated on:

- v1.0.0 PR merged (ADR-053/054/055/056 + eternal-improvement Epic close).
- Per-class Tasks (R57-T1 through R57-T7) reach reviewer-gate signoff individually; ADR can be partial-accepted (e.g. "D1 accepted, D2-D7 pending" for staged v1.1.x rollout).
- One real-fire test on a non-critical team showing each Decision's mitigation kicks in correctly.

## v1.1.x rollout strategy

The 7 Tasks (R57-T1 through R57-T7, one per class A-G mapping to D1-D7) decompose for independent dispatch. Suggested order respects cross-class deps:

1. **Wave 0 — D6 heartbeat + watchdog** (R57-T6) — foundational; D3 + D4 depend.
2. **Wave 1 — D1 pane-state + D5 semantics drift** (R57-T1, R57-T5) — parallel; both surface immediate UX wins (the original George complaint + supervisor send-keys P1).
3. **Wave 1' — D7 push-discipline** (R57-T7) — independent; can run parallel with Wave 1.
4. **Wave 2 — D2 inbox-bounding** (R57-T2) — gates on Wave 0 archive infra.
5. **Wave 2' — D3 lock-TTL + D4 member-health** (R57-T3, R57-T4) — depend on Wave 0; parallel with each other.

Reviewer-gate per Task. Partial v1.1.x releases (e.g., x.1.0 = D1+D5+D6+D7; x.1.1 = D2+D3+D4) are acceptable per the "ADR can be partial-accepted" termination signal.
