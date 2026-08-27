# ADR-209: Epic-team hold-posture deadlock + cage-state probe false-negative + sweep `lastCommitHoursAgo` semantic

> **CORRECTION 2026-05-21 (post-filing).** Original Context + Bug 3 were based on an incorrect socket-probe (used `tmux -L atmux-<epic>` against the default socket dir, but sopx epic-team sockets live at `/tmp/atmux-sopx/epics/<epicId>/tmux-0/default` via `tmux -S`). After verification at the real socket path: tmux sessions ARE up, all 7 windows exist, claude processes ARE running at prompts (Opus 4.7 1M xhigh, auto mode on). The bug class is NOT "bring-up never fired" — it's "leads + members got stuck in hold posture; nobody dispatched". Original Bug 3 ("atmux up lies about session existence") is RETRACTED; replaced by the real Bug 3 (`atmux status --json` cage-state probe false-negative) + new Bug 4 (hold-posture deadlock). See revised body below; the original "NEVER-STARTED" framing is retained in the title for traceability against the filing commit `a7fec9f` and the prior driver-inbox message, but the diagnosis underneath is the corrected one.

**Status**: Proposed — filed by driver 2026-05-21 during sopx epic-dissolve sweep; diagnosis corrected same day after `tmux -S` probe
**Date**: 2026-05-21
**Driver-ref**: sopx driver (geoyws) 2026-05-21 — `atmux tell-lead` from `/root/work/src/atmux/.atmux/driver-inbox.md` describing 7 sopx epic-teams that ran but shipped nothing.
**Extends**: ADR-090 (epic-team spawn/dissolve), ADR-132/158 (sentinel), ADR-170 (`team sweep-epics`), ADR-208 (deploy-completeness probe class — sibling failure mode for spawn-vs-deploy split).
**Relates**: ADR-027 (doctor probe registry).

> ⚠ **SUPERSEDED 2026-08-27 by [ADR-280](280-epic-team-retirement-and-staged-excision.md).** Epic-teams are retired: the `epic-team` cage type, the `epicId` cockpit field and the epic verbs no longer exist. This ADR is kept as history — the decision it records was true when made. Do not implement from it.

## Context

Eight SOPX cockpit-rostered epic-teams were created via `team spawn-epic`. Each got the conventional payload (worktree + branch + kanban with 3–21 todos + cockpit roster entry + `team.json` with `claudeAccount` resolved). For 7 of them, **bring-up did fire** — tmux sessions exist at `/tmp/atmux-sopx/epics/<epicId>/tmux-0/default`, all 7 windows are present, claude is running in each pane. Despite that, the teams shipped zero commits past spawn-base.

Observable state at the time of investigation:

- ✅ tmux sessions up on per-tier sockets (`tmux -S /tmp/atmux-sopx/epics/<epicId>/tmux-0/default ls` → `atmux-<epicId>: 7 windows`)
- ✅ claude processes alive in every member pane (`capture-pane` shows Opus 4.7, `geoyws@icloud.com max`, `⏵⏵ auto mode on`, idle at `❯` prompt)
- ✅ kanban populated (3–21 todos each, 68 total across 7)
- ❌ 0 commits past spawn-base for every epic branch
- ❌ 0 kanban `done` / 0 `inProgress` per epic
- ❌ `atmux status --json` reports `cageState: down` for every member of every epic — DESPITE the panes being alive (probe false-negative)
- ❌ `team sweep-epics` verdict: DRAIN with `lastCommitHoursAgo: 2` (misleading — the "recent commit" is trunk's spawn-base; the branch itself produced nothing)

Pane content snapshots reveal the actual failure mode. Lead pane (e-2df34086) shows: `Sautéed for 1m 5s` (last turn finished 1m ago) followed by free-text `"Holding for planner activity."` Member pane (be-1, same epic) shows: `"Held posture per [[feedback_bootstrap_into_closed_session_hold_posture.md]]; readiness ping sent to lead. Awaiting Task dispatch or kanban population."`

**The deadlock:** lead holds for planner, members hold for lead dispatch, planner holds for ambient signal that never comes. The kanban is populated but nobody is claiming or dispatching. Watchdog tick + sentinel scan against state files (`whip.log` shows activity) — but neither mechanism kicks the deadlock; they observe state, they don't unstick agents.

Driver applied an out-of-band fix: `atmux send <epic-root> lead '/bruh — stop holding. Your kanban has N todos. Dispatch NOW.'` — all 7 leads consumed budget (`5h 57%` → `5h 5%` in seconds) and started dispatching. The mechanism works; the system just doesn't auto-fire it.

### Root-cause analysis — four independent bugs

**Bug 1 — `lastCommitHoursAgo` reads branch-tip commit date, not branch-LOCAL commit date.**
When a branch has 0 commits past its merge-base with trunk, `git log -1 <branch>` returns the merge-base commit, whose date equals trunk's recent activity (~2h). The metric reports a never-progressed team as freshly active. Fix: use `git log $(git merge-base <branch> <trunk>)..<branch> --format=%ct -1` or `git rev-list --count` on the same range — if zero, the team has produced nothing since spawn regardless of how recent the merge-base is.

**Bug 2 — no spawn-aware liveness state distinguishes "never-shipped" from "actively-shipping".**
The existing `cageState` + `heartbeat_age_s` per member are bimodal (up vs down) but don't capture "alive but not productive". A team can be `cageState: up` for every member yet have 0 commits, 0 kanban-done, 0 dispatched tasks — exactly the case here. The sweep needs a *productivity* signal alongside the *liveness* signal.

**Bug 3 — `atmux status --json` cage-state probe false-negative.**
For all 7 sopx epics, every member's `cageState` reported as `down` in `atmux status --json`, despite every pane being demonstrably alive (claude running, idle prompt, recent `Sautéed` turn marker, model + account + permission-mode displayed). The probe likely checks a stale file-based flag (`.atmux/state/`) or PID file rather than tmux's actual pane process tree. Replacement: probe the tmux socket's pane PIDs (`tmux -S <socket> list-panes -F '#{pane_pid}'`) and walk the descendant tree for a `claude` (or other registered TUI) process — true = alive, false = dead, no third state.

**Bug 4 — hold-posture deadlock has no auto-unstick.**
Once lead enters "holding for planner activity" + members enter "awaiting dispatch", nothing in the existing watchdog / sentinel / whip stack unsticks them. They idle through ticks; ticks observe but don't intervene. The driver-side `/bruh` fix works manually but has to be operator-initiated. Auto-fire should trigger when:

```
(every member cage alive) AND (kanban.todo > 0) AND (kanban.inProgress == 0)
  AND (lastDispatchHeartbeat == null OR > 30min ago)
  → emit /bruh-class kick to lead pane
```

Cadence: every 30 min after the team has been idle-with-todos. Debounce: once per `(team, kanban-todo-count)` tuple so a kick doesn't re-fire if the count hasn't changed (= operator already saw the prior kick and chose to leave it).

## Decision

Four targeted fixes, three orthogonal to each other (1, 3, 4) and one supporting (2 supplies state for the others).

### 1. `lastCommitHoursAgo` uses merge-base-aware count

`team sweep-epics` classifier replaces tip-commit-date lookup with:

```bash
commits_ahead=$(git rev-list --count "$(git merge-base "$branch" "$trunk")".."$branch")
if [ "$commits_ahead" -eq 0 ]; then
  last_commit_hours_ago=99999  # explicit "no branch-local progress" sentinel
fi
```

Closes Bug 1.

### 2. `.atmux/state/team-meta.json` (new — supports 3, 4, 8)

`team spawn-epic` writes:

```json
{
  "teamId": "e-854194ad",
  "spawnAt": 1716284400,
  "spawnedBy": "lead@sopx",
  "lastDispatchHeartbeatAt": null,
  "lastCommitOnBranchAt": null,
  "lastKickAt": null,
  "lastKickKanbanCount": null
}
```

`lastDispatchHeartbeatAt` — updated by lead on every member-dispatch action (when lead's `claim-next` or `assign` verb fires).
`lastCommitOnBranchAt` — updated by post-commit hook in the epic worktree.
`lastKickAt` + `lastKickKanbanCount` — debounce for Bug 4 auto-unstick.

### 3. Cage-state probe uses tmux truth

Replace whatever `atmux status --json` currently reads for `cageState` with a tmux socket pane-PID probe:

```typescript
function cageStateForMember(member: TeamMember, socket: string, sessionName: string): "up" | "down" {
  const result = spawnSync("tmux", ["-S", socket, "list-panes",
    "-t", `${sessionName}:${member.windowName}`,
    "-F", "#{pane_pid}"
  ]);
  if (result.status !== 0) return "down";
  const panePid = parseInt(result.stdout.toString().trim(), 10);
  if (!panePid || !isFinite(panePid)) return "down";
  // Walk pgrep -P / pstree to find a registered TUI (claude, cursor-agent, opencode)
  const tuiAlive = hasRegisteredTuiDescendant(panePid, member.tui);
  return tuiAlive ? "up" : "down";
}
```

Closes Bug 3.

### 4. Hold-posture auto-unstick

Sentinel tick (W3 / ADR-132 §D2) adds new check per rostered epic-team:

```
if every-member-cageState-up
  and team-meta.lastCommitOnBranchAt is null
  and team-meta.lastDispatchHeartbeatAt is null OR now - it > 30min
  and kanban.todo > 0
  and (team-meta.lastKickAt is null OR team-meta.lastKickKanbanCount != kanban.todo):
    emit "/bruh — kanban has $N todos, dispatch NOW (driver auto-kick via sentinel)" to lead pane
    update team-meta.lastKickAt = now, lastKickKanbanCount = kanban.todo
```

Closes Bug 4. Operator can disable per-team via `.atmux/state/team-meta.json::autoKickEnabled: false` if a particular team intentionally holds (e.g., planning-phase epic).

### 5. New `team sweep-epics` verdict — `IDLE-WITH-TODOS`

Replaces the misclassified DRAIN verdict for teams in this state:

```
verdict = "IDLE-WITH-TODOS"
reason  = f"alive but no commits + no dispatch in {hours}h (kanban.todo={n})"
auto    = false  # surfaces to driver, doesn't auto-dissolve
```

Distinct from STALE-IDLE (which fires when commits were happening but stopped) and from DRAIN (which is for teams legitimately working through tasks). Auto-action: no auto-dissolve; sentinel kick fires per Bug 4 fix instead.

### 6. `atmux team sweep-epics --apply` only auto-dissolves SAFE-DISSOLVE

Preserve current behavior. The new IDLE-WITH-TODOS verdict is surfaced, kicked, but not auto-dissolved — they have real planning to execute.

## Implementation slices

| Slice | What | Effort | Order |
|---|---|---|---|
| S1 | `.atmux/state/team-meta.json` schema + writer in `team spawn-epic` + post-commit hook | M | first |
| S2 | Lead-side `lastDispatchHeartbeatAt` stamp on dispatch-class actions | S | first |
| S3 | Fix `lastCommitHoursAgo` to use merge-base-aware count (Bug 1) | S | independent |
| S4 | Fix `cageState` probe to use tmux pane-PID truth (Bug 3) | M | independent |
| S5 | New `IDLE-WITH-TODOS` verdict in `team sweep-epics` | S | after S1+S3 |
| S6 | Sentinel auto-kick + debounce (Bug 4) | M | after S1+S2+S5 |
| S7 | Verdict surfacing in dashboard / driver-inbox-summary | S | after S5+S6 |

S3 + S4 are quick wins and independent — ship them first to stop reporting wrong cageState and wrong lastCommitHoursAgo immediately. S1, S2, S5, S6 close the auto-unstick.

## Open questions

- **OQ1 — kick cadence + escalation.** First kick at 30min idle; if kanban-todo-count unchanged at next tick + still no dispatch heartbeat, kick again at 60min, then 2h? Or single-shot and escalate to driver-inbox after? Driver pref: kick at 30min, kick again at 2h if unchanged, then driver-inbox after 4h.
- **OQ2 — kick payload.** Should sentinel inject the kanban-scope summary into the kick (so lead doesn't need to read the kanban to know what to dispatch), or just the bare `/bruh` skill invocation? Driver pref: include todo-count + first 3 todo titles for context, since /bruh alone may not bias toward dispatch.
- **OQ3 — opt-out vs opt-in.** Default behavior: auto-kick on, override per-team via `autoKickEnabled: false`. Or default off, opt-in via `autoKickEnabled: true` at spawn time? Driver pref: default ON — the dominant failure mode is "operator forgot to kick", not "team intentionally idling".

## Consequences

**Positive:**
- Closes the "I have N alive-but-idle epic-teams in my cockpit and didn't notice" failure class
- Reuses existing sentinel + state-file + ADR-126 dedup infrastructure; new surface is one state file + one verdict + one sentinel check
- Bug 1 + Bug 3 fixes also improve diagnostic accuracy for non-deadlock cases (every operator who relies on `atmux status` or `sweep-epics` benefits)

**Negative:**
- `team-meta.json` adds write-amplification (post-commit hook fires on every commit); negligible (one small JSON write per commit)
- Auto-kick risks waking a team that legitimately wants to hold (e.g., epic awaiting an upstream blocker). Mitigated by `autoKickEnabled: false` per-team override + 30min cadence (not aggressive)
- Cage-state probe replacement (Bug 3 fix) needs careful test coverage to avoid the inverse false-positive (claiming cage up when claude has crashed but tmux pane is still alive)

**Neutral:**
- Operators who previously relied on the (broken) `cageState: down` signal to mean "team is parked" lose that signal. The IDLE-WITH-TODOS verdict surfaces the same information more accurately.

## Evidence / repro

Sopx project, 2026-05-21:

```bash
# 1. Confirm cage IS up despite atmux saying down:
tmux -S /tmp/atmux-sopx/epics/e-2df34086/tmux-0/default capture-pane \
  -t atmux-e-2df34086:1 -p | tail -8
# → shows claude alive, Opus 4.7, ❯ prompt, "Holding for planner activity"

cd /root/work/ifca/src/sopx-root-epics/e-2df34086 && atmux status --json \
  | jq '.members[] | select(.name=="lead") | .cageState'
# → "down"  (Bug 3 false-negative)

# 2. Confirm Bug 1 — sweep claims fresh activity:
atmux team sweep-epics --parent sopx --json | jq '.verdicts[] | select(.epicId=="e-2df34086")'
# → verdict: "DRAIN", lastCommitHoursAgo: 2, reason: "3 open task(s)"

# 3. Verify Bug 1 root cause:
git rev-list --count $(git merge-base sopx-geoyws-epic-e-2df34086 origin/sopx-geoyws)..sopx-geoyws-epic-e-2df34086
# → 0  (branch has produced nothing — sweep should have caught this)

# 4. Apply driver-side /bruh kick (workaround for Bug 4):
cd /root/work/ifca/src/sopx-root-epics/e-2df34086
ATMUX_CALLER_SCOPE=driver atmux send lead "/bruh — dispatch your kanban NOW"
# → budget meter drops 5h 57% → 5h 5% in seconds (lead consumed prompt + processed)
```

All 7 sopx epics (e-854194ad, e-c1c7766a, e-33cf85a3, e-4c19dbdb, e-dea743ec, e-2df34086, e-c1e36aec) reproduce all four bugs identically.
