# ADR-220: Incremental-mode identity coherence — `ATMUX_MEMBER`-drift detection + auto-promote-to-force

**Status**: Accepted — ratified by driver 2026-05-23 (shipped via docs branch fan-in `b6b1525` + post-fan-in dispatcher fixes `6ca1ff2`/`baa0b8a` close ATMUX_MEMBER-drift wedge structurally).
**Date**: 2026-05-22
**Driver-ref**: 2026-05-22 ~09:50 MYT sopx-driver session — operator dissolved 6 epic-teams and respawned them with a different roster shape; all 6 cages had window-1 successfully renamed to `🐝-lead` via the ADR-135 §D4 + ADR-161 TR2 in-place rename path, but the claude process inside each window still carried `ATMUX_MEMBER=be-2` from its pre-dissolve spawn. Each "lead" window was functionally a `be-2` process reading `templates/briefs/member.md` and posting to `lead-outbox.md` AS `be-2`; the intended lead role was unowned + driver-inbox writes went unread. Operator's manual workaround was `atmux start --force` per cage (6 calls). Filed via ombudsman as `t-67f9061a` from `c-6445c932` (severity=high, kind=safety-gap; 5th sopx-driver complaint of the day on the spawn-dissolve-respawn cycle — capstone of the silent-failure class). Filed via Epic `e-bfa6e62c`.

**Cross-refs**: [ADR-135](135-cockpit-naming-convention.md) §D4 (in-place legacy-emoji rename — load-bearing for PID preservation when identity is unchanged; this ADR adds the identity-coherence gate that rename-in-place was implicitly assuming), [ADR-161](161-default-member-prefix-and-sort-verbs.md) §TR2 (`_-prefix` rename-in-place — sibling rename path; same identity-coherence assumption), [ADR-136](136-hot-rename-member-labels.md) (id/label/emoji layer split — drift detection keys off the `id` layer, not label), [ADR-077](077-superdoctor-cockpit-role.md) §doctor probes (the new identity-drift red row lands here), [ADR-090](090-epic-team-lifecycle.md) §`dissolve-epic` + [ADR-219](219-dissolve-epic-completeness.md) (sibling EPIC `e-7a1014f9` — FOUNDATION; this ADR's scenarios are post-clean-dissolve), [ADR-033](033-driver-scope-mutations.md) (driver-scope gate — the auto-promote-to-force runs from `atmux start`, which already inherits caller-scope).

Sibling EPICs (same spawn-dissolve-respawn class, all from 2026-05-22 sopx-driver complaints):
- `e-7a1014f9` — dissolve-epic completeness (FOUNDATION; clean dissolves are pre-condition for clean respawns).
- `c-ca2b6b90` → `t-c56e016e` — spawn-epic `--no-init-submodules` default (ADR-088 alignment).
- `c-800b0a95` → `t-6210e753` — spawn-epic rollback completion when `provisionWorktree` throws.

## Context

`atmux start` runs in two modes:

- **Force mode** (`--force`): kill the existing session entirely + respawn every window from `team.json`. Destructive; preserves no in-flight claude turn state; the operator's hammer.
- **Incremental mode** (default): warn if the session already exists (`src/verbs/start.ts:406`), then per-member, if the canonical window name exists (`:679`), SKIP that member's respawn — preserves pane PIDs and claude process state. Where the existing window name differs from the canonical (legacy `<emoji><member>` no-separator from pre-ADR-135, or hyphen-form `<emoji>-<label>` from pre-ADR-161 TR2 for a now-default role), the in-place `tmux rename-window` rewrites the WINDOW NAME without touching the embedded claude process (`:697` and `:713`).

The incremental path was designed for **visual migration** — the rename converts the operator-visible window label to the new convention while leaving the claude TUI undisturbed, mid-turn-safe and history-preserving. The implicit assumption: window-name rename only fires when the member's IDENTITY is unchanged. ADR-135 §D4's design comment ("preserves pane PID + scroll history") and ADR-161 TR2's design (rename-in-place "PIDs preserved across reorders" — per the `feedback_keep_daily_driver_prefix_unchanged` corpus around ADR-161 amendments) both name this PID-preservation as a feature.

### The drift class

The implicit assumption breaks when `team.json::members[]` has been ROSTER-CHANGED between the in-place rename's window-name match logic and the actual member-identity inside the running pane. Concretely:

1. Cage spawned with roster `[lead, planner, be-1, be-2, fe-1, fe-2, reviewer]`. Window 1 is `🐝-lead` running claude with `ATMUX_MEMBER=lead`.
2. Cage is dissolved (per ADR-090 §`dissolve-epic`); but the embedded claude TUI processes may survive the dissolve (per the dissolve-completeness regression closed by [ADR-219](219-dissolve-epic-completeness.md) — orphan cage server stayed alive even after a clean `dissolve-epic` reported success).
3. Cage is respawned with a DIFFERENT roster `[lead, planner, fe-1, be-1, dba, reviewer, ombudsman]`. `atmux start` enters incremental mode + sees window 1 `🐝-be-2` exists (legacy hyphen form for an existing member) — no, in this scenario the rename converts `🐝-be-2` → `🐝-lead` because the position-1 member is now `lead`. The window-name path successfully renames; the claude inside is STILL running with `ATMUX_MEMBER=be-2`.

The post-condition is silent identity drift: the OS-level pane has the right NAME, the lookup logic (`buildWindowName`) returns the right value, every observability surface ASSUMES `window name = member identity`, but the actual claude process is reading the wrong brief, posting to the wrong outbox, and claiming the wrong kanban Tasks — all under the silent guise of "`window 1 is lead`."

### 2026-05-22 sopx incident

09:50 MYT: 6 epic-teams dissolved + respawned. All 6 had window-1 renamed `🐝-be-2` → `🐝-lead`. None of the 6 actual claude processes inside had `ATMUX_MEMBER=lead`. The "lead" window in each cage was functionally `be-2` — reading `member.md` not `lead.md`, posting to `lead-outbox.md` as `be-2`, claiming `be`-lane Tasks AS the lead role. Driver-inbox.md writes from the actual driver never reached any of the 6 leads (because no `lead` was reading any of them). Cages APPEARED up by every external probe (tmux session alive, windows present, claude TUI rendering); they were functionally dead.

Operator's recovery: `atmux start --force` per cage. Six calls, six destructive respawns. Visually unmissable (window kills + respawns) but only because the operator was looking AT the cages; the upstream BAU verdict ("Idle-but-alive") never flagged the drift.

### Why detection has to be data-driven

The flag-based path (`--force`) exists; the operator can always reach for it. But `--force` is a sledgehammer — it destroys claude turn state on EVERY pane in the session, including the panes whose identity is correct + claude is mid-productive-turn. The right semantic is **identity-drift detection** + per-window auto-promote-to-force: preserve PIDs where identity matches; nuke + respawn where identity has drifted. Asymmetric per-window behavior is not expressible via the existing `--force` flag (which is session-scope).

This ADR makes the `--force` behavior data-driven, not flag-driven: detect identity drift via `ATMUX_MEMBER` probe + escalate to kill-respawn for the drifted windows ONLY.

## Decision

### §D1 — Identity-coherence probe at `atmux start` incremental path

In `src/verbs/start.ts` per-member iteration (`:670` area), before the existing-window-name short-circuit at `:679`, probe the existing window's claude process for `ATMUX_MEMBER`:

1. Resolve the existing window's claude PID — `tmux list-panes -t <session>:<win> -F '#{pane_pid}'` returns the pane shell PID; walk `/proc/<shell-pid>/children` (or its descendants) until a claude process is reached.
2. Read `/proc/<claude-pid>/environ` (NUL-separated; split + filter for `ATMUX_MEMBER=`).
3. Compare to `team.json::members[]` entry for `member.name` (the ID layer per ADR-136 — branch-name + kanban-owner + worktree-path key off this; rename mutations operate on `label`, not `id`).

Outcomes:
- **Match** (probed `ATMUX_MEMBER` === `member.name`): preserve the existing pane. Run the existing rename-in-place logic for label/emoji drift (per ADR-135 §D4 + ADR-161 TR2). PID is preserved. **This is the regression-pin** — the existing rename-in-place behavior is correct for this case + MUST NOT regress.
- **Mismatch** (probed `ATMUX_MEMBER` !== `member.name`): auto-promote to kill-respawn for this window ONLY. `tmux kill-window -t <session>:<win>` + the existing spawn path (`:727` onward) creates a fresh window with the right env. Logged: `· ${member.name}: identity drift detected (window was ${probed}); kill-respawn`.
- **Probe fails** (claude PID unfindable, `/proc` read fails, env line absent): treat as drift (conservative). Log + auto-promote. The probe-fail case is rare on hax (Linux `/proc` is reliable); the conservative default ensures a silent fail doesn't leave a drift in production.

The probe is per-window, not per-session. A cage with 7 windows, 6 of which match + 1 of which drifted, auto-promotes ONLY the drifted window. The 6 matching panes preserve PIDs + claude turn state. This is the data-driven asymmetry that the session-scope `--force` flag cannot express.

### §D2 — `atmux doctor` identity-drift probe

Add a new probe to [ADR-077](077-superdoctor-cockpit-role.md) §doctor probes:

- **Invariant**: for every cage window in every team's tmux session, the embedded claude process's `ATMUX_MEMBER` MUST match the window's corresponding `team.json::members[]` entry (resolved via `buildWindowName` reverse-lookup on the window name).
- **On violation**: emit a RED doctor row (not yellow — this is silent functional death of the member, not a leak). Row body names the cage + window name + claude PID + observed-vs-expected `ATMUX_MEMBER`.
- **`--fix` path**: call into the §D1 kill-respawn logic for the drifted window (same primitive; doctor's `--fix` doesn't duplicate the recovery code, it dispatches to start.ts's per-window respawn).

Red (not yellow) here is deliberate. The §D1 §D3 OQ3 rationale for yellow on dissolve-orphans was "live cage with no roster entry is a leak, not corruption." Identity drift IS corruption — the wrong process is acting AS another member. The probe surfaces as red so superdoctor's auto-fix authority (per ADR-077 §Authority) can act without operator-in-the-loop confirmation; the recovery is bounded (kill-respawn one window), not destructive across the cage.

### §D3 — bau `⚙️ Identity-Drift` verdict

The today bau (`/coordination:bau` skill) classified the 6 drifted sopx cages as "BAU / Idle-but-alive" — the existing verdict logic only checked tmux liveness + commit cadence, both of which are correct on a drifted cage (the wrong-identity claude IS alive + IS running, just not productively in the right role). Add a new verdict:

- **`⚙️ Identity-Drift`** — emitted when any window in the cage has `ATMUX_MEMBER` ≠ the team.json-resolved member ID for that window.
- Surfacing format consistent with existing bau verdicts (verdict-first, ≤80 chars/bullet per CLAUDE.md §Discord pings).
- Consumes the §D2 doctor probe output (no duplicate probing).

The verdict bumps the affected cage above BAU/Idle in the bau output ordering — Identity-Drift is more urgent than Idle-but-alive (silent functional death is worse than silent inactivity).

### §D4 — Operator opt-out flag

`atmux start --no-auto-promote` (or equivalent name; final naming via reviewer): skip the §D1 auto-promote behavior. Identity drift still gets detected + logged, but the kill-respawn is NOT fired. The drifted window stays drifted; the operator can inspect the pane + handle recovery manually.

Use case: forensic preservation. If the operator wants to investigate WHY the drift occurred (e.g. the 2026-05-22 sopx incident — what did the wrong-identity `be-2`-acting-as-`lead` write to `lead-outbox.md`?), `--no-auto-promote` keeps the evidence intact. Otherwise the auto-promote kills the claude turn + the pane state goes with it.

Low-revisit: the flag is operator-explicit + the default is the safe path. Documented in `RUNBOOK-identity-drift.md` (sibling subtask T6) with the forensic-preservation use case as the example.

## Open Questions

### OQ1 — Probe mechanism: `capture-pane` vs `/proc/<pid>/environ` vs per-pane state file?

**Recommendation: `/proc/<pid>/environ`.**

- **`capture-pane`**: read the visible terminal output, grep for an embedded `ATMUX_MEMBER=...` line that claude prints at boot. Cheap but fragile — the boot line scrolls off after the first turn; capture-pane history scan adds latency; claude's boot output is not a stable contract (any TUI redesign could break the probe).
- **`/proc/<pid>/environ`**: read the kernel's env block directly. NUL-separated, stable across claude versions, no scrollback dependency. Linux-only (hax-only is the deploy target per CLAUDE.md), so portability isn't an issue. ~1ms per read; runs per-member at start time + per-cage at doctor cadence.
- **Per-pane state file**: write `ATMUX_MEMBER` to `<atmuxDir>/state/pane-<sessionWindow>.json` at spawn time + read back at probe time. Adds a new state file class + introduces a sync bug class (file lags pane reality if claude is killed externally). Loses the kernel-truth guarantee that `/proc` gives.

Rejected: `capture-pane` (fragility); per-pane state file (lying-state risk). `/proc/<pid>/environ` is the kernel's source-of-truth and the only choice that survives external claude kills + restarts without sync logic.

### OQ2 — Drift recovery semantics: kill-window-respawn vs kill-claude-only (keep window)?

**Recommendation: kill-window-respawn.**

- **Kill-window-respawn**: `tmux kill-window` then spawn through start.ts's existing per-member spawn chain. Matches the `--force` shape verbatim (just at window scope, not session scope). Window-name + pane PID + claude env are all reset together; no half-mutated state.
- **Kill-claude-only**: `kill -TERM <claude-pid>` against the embedded process; let tmux's pane recycle behavior re-run the shell + the configured TUI command. Cheaper (no tmux window mutation) but introduces drift between the pane shell env (carried from the original spawn) and the new claude process inside it. The whole point of identity drift is the env mismatch — kill-claude-only doesn't fix it.

Rejected: kill-claude-only. The full kill-window-respawn is the only recovery that resets the env cleanly.

### OQ3 — Operator opt-out flag: ship now vs defer?

**Recommendation: ship now, low-revisit.**

Rationale:
- The forensic-preservation use case is concrete (the 2026-05-22 sopx incident itself would benefit from `--no-auto-promote` for post-mortem analysis if the drift recurred).
- Ship cost is minimal — one arg-parser line + one boolean check around the §D1 auto-promote.
- Operator agency over destructive auto-actions is a CLAUDE.md / global "Executing actions with care" precedent — the flag preserves that agency for the rare investigation case.

Rejected alternative: defer to a follow-up ADR. Rationale for rejecting: the cost to add is nil vs the value of having it available the next time the drift recurs.

## Consequences

### Positive

- **Identity drift surfaces immediately** at `atmux start` (per-window log line) + `atmux doctor` (red row) + bau (`⚙️ Identity-Drift` verdict). No more silent functional death; the 2026-05-22 sopx 6-cage scenario gets caught at the first `atmux start --force` would-have-been-needed point + auto-recovered without operator intervention.
- **PID preservation regression-pin**. The matching-identity path explicitly preserves PIDs + claude turn state; the existing ADR-135 §D4 + ADR-161 TR2 in-place rename guarantees survive intact. Reviewer-gated.
- **Per-window asymmetry**. The auto-promote affects ONLY drifted windows. A cage with 6 correct + 1 drifted preserves the 6; today's `--force` workaround destroys all 7.
- **No new state files**. Probe via `/proc` keeps the kernel as source-of-truth; no sync bug class introduced.
- **Operator agency preserved**. `--no-auto-promote` (§D4) keeps the forensic-preservation use case unblocked.

### Negative

- **Linux-only probe**. `/proc/<pid>/environ` doesn't exist on macOS. hax is Linux + the production target per CLAUDE.md; macOS-local atmux runs (operator's MBP) would skip the probe + fall through to existing behavior (log + continue, treat as match). Acceptable trade-off — drift detection on the dev box matters less than on the production-shaped hax cages.
- **One claude-process resolution step per window per `atmux start`**. The `tmux list-panes` → walk `/proc/<shell>/children` → claude PID resolution adds ~few-ms per window. Negligible at start-up cadence; doctor probe runs hourly so the doctor cost is also negligible.
- **Auto-kill-respawn vs forensic preservation**. The default kills the drifted claude turn state, which IS the forensic evidence in some incident-recovery paths. Mitigation: `--no-auto-promote` (§D4); RUNBOOK guidance pointing to the flag for post-mortem investigations.

### Migration / compatibility

- No schema changes. No `team.json` field additions. No `cockpit.json` field additions.
- No behavior change for the matching-identity path. The existing ADR-135 §D4 + ADR-161 TR2 in-place rename remains the default code path for the common case (operator runs `atmux start` against an already-running session whose roster hasn't changed).
- Pre-existing drifted cages (today, post-2026-05-22 sopx) are not auto-recovered until the operator runs `atmux start` again + the §D1 probe fires. The doctor red row + bau Identity-Drift verdict surface them in the meantime.
- macOS skip-fallback: `/proc/<pid>/environ` read fails → log "identity-drift probe unsupported on this platform" once per start invocation; falls through to existing rename-in-place behavior. No spurious auto-promotes on dev machines.

## Out of scope

- **Atomic `atmux team respawn-epic` verb** bundling dissolve + spawn (operator's note #5 in c-6445c932). The identity-coherence gate this ADR adds is the load-bearing piece for safe respawn semantics; the verb-level bundling is composition + can layer on top in a separate ADR.
- **Cross-cage identity-drift detection** at the superdoctor / cockpit-rebuild level. The probe lives in `atmux doctor` per-cage today; superdoctor can opt-in by iterating cages, but the cross-cage sweep is a separate territory.
- **Identity drift via mid-turn `team.json` mutation** (operator edits team.json while claude is mid-turn — `member.name` changes underneath the running process). Out of scope; team.json edits during live cages are an operator-discipline issue covered elsewhere (ADR-027 + ADR-136 caveats).
- **Discord ping shape** for the bau Identity-Drift verdict. Inherits the ADR-086 verdict-first pattern; specific template lives in the bau skill + can iterate without an ADR amendment.

## Filed via

- EPIC `e-bfa6e62c` (P2 safety-gap — incremental-mode identity coherence; T1 = this ADR).
- Parent complaint `c-6445c932` (sopx-driver 2026-05-22 09:50 MYT, severity=high, kind=safety-gap; 5th sopx-driver complaint of the day on spawn-dissolve-respawn cycle).
- Ombudsman tracking Task `t-67f9061a`.
- Lead routing 10:18 MYT 2026-05-22. Subtask T1 (docs role, this commit) claimed via `atmux claim --next` 2026-05-22.

Sibling EPIC `e-7a1014f9` (dissolve-epic completeness via [ADR-219](219-dissolve-epic-completeness.md)) is the FOUNDATION — clean dissolves are pre-condition for clean respawns. The identity-coherence gate this ADR adds assumes the dissolve actually completed (cage reaped, branch deleted) so the respawn it gates is starting from a clean substrate.
