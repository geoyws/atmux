# ADR-209: NEVER-STARTED epic-team detection — liveness handshake distinct from idle

**Status**: Proposed — filed by driver 2026-05-21 during sopx epic-dissolve sweep
**Date**: 2026-05-21
**Driver-ref**: sopx driver (geoyws) 2026-05-21 — `atmux tell-lead` from `/root/work/src/atmux/.atmux/driver-inbox.md` describing 7 sopx epic-teams that sat scaffolded-but-never-started, missed by every existing sweep verdict.
**Extends**: ADR-090 (epic-team spawn/dissolve), ADR-132/158 (sentinel), ADR-170 (`team sweep-epics`), ADR-208 (deploy-completeness probe class — sibling failure mode).
**Relates**: ADR-027 (doctor probe registry — registration target for the new check).

## Context

Eight SOPX cockpit-rostered epic-teams were created via `team spawn-epic`. Each got:

- A worktree at `<parentRoot>-epics/<epicId>` on branch `<parentBase>-epic-<epicId>`
- A populated kanban (`atmux task add` filled with 3–21 todos per epic on initial bring-up)
- A cockpit roster entry under `sessions[parent].sessions[]`
- A `.atmux/team.json` with members + `claudeAccount` resolved from parent

But **no `atmux start` ever fired**. Result:

- 0 tmux sessions on `atmux-<epicId>` socket (verified: `tmux -L atmux-<epicId> ls` → "No such file or directory" for all 7)
- 0 cages up (`atmux status --json` shows `cageState: down` for every member)
- 0 commits ahead of trunk (branch tip = spawn-base SHA for all 7)
- 0 kanban done; total 68 unstarted todos parked
- `.atmux/logs/whip.log` shows recent watchdog activity ticking against state files — watchdog ran, but watchdog doesn't bring up dead cages

The sweep verb `team sweep-epics` classified all 7 as **DRAIN** with `lastCommitHoursAgo: 2` and `reason: "N open task(s)"`. The verdict was wrong: these teams were never alive, not draining.

### Root-cause analysis — three independent bugs surfaced together

**Bug 1 — `lastCommitHoursAgo` reads branch-tip commit date, not branch-LOCAL commit date.**
When a branch has 0 commits ahead of its spawn-base, `git log -1 <branch>` returns the spawn-base commit, whose date equals trunk's recent activity (~2h). The metric reports the team as freshly active. Fix: use `git log $(merge-base trunk branch)..branch --format=%ct -1` or `git rev-list --count` on the same range — if zero, the team has produced no work since spawn regardless of how recent the spawn-base is.

**Bug 2 — no `spawnAt` / `firstCageUpAt` stamp distinguishes never-started from went-idle.**
There's currently no way to ask "was this epic-team ever alive?" The `cageState: down` signal is symmetric — it fires the same whether a team was spawned-and-never-started OR was running and shut down cleanly. The kanban-done count is also symmetric (a team that ran briefly, completed nothing, and stopped looks identical to a team that never ran at all).

**Bug 3 — `atmux up` reports false-positive "already running".**
On the 7 epics: `cd <epic-root> && ATMUX_CALLER_SCOPE=driver atmux up` returns `🔹 atmux session atmux-<epic> already running — reusing` even when no tmux socket exists for that name. The detection logic likely checks something other than the actual tmux socket (probably a stale `.atmux/state/` flag or PID file). This masked the diagnosis until `tmux -L atmux-<epic> ls` was run independently.

## Decision

Add **epic-meta state file** + **NEVER-STARTED sentinel verdict** + **`atmux up` socket-truth gate**.

### 1. `.atmux/state/epic-meta.json` (new)

`team spawn-epic` writes:

```json
{
  "epicId": "e-854194ad",
  "spawnAt": 1716284400,
  "spawnedBy": "lead@sopx",
  "firstCageUpAt": null,
  "firstHeartbeatAt": null,
  "lastHeartbeatAt": null
}
```

Harness updates:

- `firstCageUpAt` — set once on first pane attach for any member (idempotent — null → epoch, then never overwritten)
- `firstHeartbeatAt` — set once on first heartbeat from any member
- `lastHeartbeatAt` — updated on every heartbeat (per-team aggregate)

The two-tuple `(firstCageUpAt, lastHeartbeatAt)` covers both failure modes:

- `firstCageUpAt == null` after N hours since spawn → **NEVER-STARTED**
- `firstCageUpAt != null` AND `lastHeartbeatAt > 24h ago` → **WENT-DARK** (separate verdict, future ADR)

Per-member heartbeats already exist in `.atmux/heartbeats/<member>.json` — the new file is a team-aggregate convenience surface; sentinel reads this rather than scanning every member.

### 2. `team sweep-epics` verdict — `NEVER-STARTED`

Add new branch to classifier:

```python
if epic_meta["firstCageUpAt"] is None and (now - epic_meta["spawnAt"]) > 6*3600:
    verdict = "NEVER-STARTED"
    reason  = f"spawned {hours_since_spawn}h ago, no cage ever booted"
elif commits_ahead_of_spawn_base == 0 and epic_meta["firstCageUpAt"] is None:
    # belt-and-braces — even if the time check above doesn't fire,
    # 0-ahead + never-up is a strong NEVER-STARTED signal
    verdict = "NEVER-STARTED"
    reason  = "0 commits since spawn + no cage boot record"
```

The `commits_ahead_of_spawn_base` computation **must use the merge-base**, not the branch tip:

```bash
git rev-list --count "$(git merge-base "$branch" "$trunk")".."$branch"
```

Fixes Bug 1 above (replaces the misleading `lastCommitHoursAgo: tip-commit-date` lookup).

`--apply` mode: NEVER-STARTED is auto-dissolve-eligible — same as SAFE-DISSOLVE. Operator override via `--skip-checks` for cases where the operator wants to preserve the planning todos.

### 3. Sentinel escalation

Sentinel tick (W3 / ADR-132 §D2) on every iteration:

- For each rostered epic-team, read `.atmux/state/epic-meta.json`
- If NEVER-STARTED at the >6h threshold, escalate to driver inbox **once** (debounce via `.atmux/state/sentinel-escalations.json` per ADR-126 file-based dedup pattern)
- Escalation copy: `"epic-team <epicId> spawned <Nh> ago — no cage has ever booted. likely missing 'atmux start' from spawn pipeline. dissolve via 'atmux team dissolve-epic <epicId> --skip-checks' OR bring up via 'cd <epic-root> && atmux start'."`

### 4. `atmux up` socket-truth gate

The false-positive "already running" detection (Bug 3) needs a socket-truth check before claiming idempotency:

```typescript
function isSessionAlive(sessionName: string): boolean {
  // Current (buggy): probably reads .atmux/state/session.json or PID file
  // Replacement: actually probe the tmux socket
  const probe = spawnSync("tmux", ["-L", sessionName, "has-session", "-t", sessionName]);
  return probe.status === 0;
}
```

If the socket-probe says dead but the state file says alive, the state file is stale — clear it and proceed with fresh `atmux start`. This prevents the "atmux up lies, watchdog runs, nothing actually started" trap.

### 5. spawn-epic pipeline includes `atmux start` (regression-pin)

Per ADR-208 deploy-completeness pattern — this is the same shape: code ships (spawn-epic writes the team), but the deploy-side wire-up (`atmux start` to actually boot the cages) never fires. `team spawn-epic` should be all-or-nothing: spawn the team AND start the session in the same command, with the cron line + sentinel verdict as the regression-pin.

Add a `deploy-completeness` probe per ADR-208:

- Probe name: `epic-team-bring-up`
- Severity: P1
- Check: for every rostered epic-team in cockpit.json, `firstCageUpAt != null` within 6h of `spawnAt`
- Auto-cron: every 15 minutes via `atmux start`-installed cron block (so a stale install of atmux that pre-dates this ADR auto-acquires the probe on next `atmux start`)

## Implementation slices

| Slice | What | Effort | Order |
|---|---|---|---|
| S1 | `.atmux/state/epic-meta.json` schema + writer in `team spawn-epic` | S | first |
| S2 | Harness stamp `firstCageUpAt` on first pane attach | M | first |
| S3 | Fix `lastCommitHoursAgo` to use merge-base-aware count (Bug 1) | S | first |
| S4 | Add `NEVER-STARTED` verdict to `team sweep-epics` | M | after S1+S3 |
| S5 | Sentinel escalation + dedup | M | after S4 |
| S6 | Fix `atmux up` socket-truth probe (Bug 3) | S | independent |
| S7 | `deploy-completeness` probe `epic-team-bring-up` | M | after S5 |
| S8 | spawn-epic auto-fires `atmux start` (regression-pin) | M | after S6 |

S1–S5 alone closes the sopx-style diagnosis gap. S6–S8 close the regression surface so it cannot recur.

## Open questions

- **OQ1 — backfill `spawnAt` for existing rostered epic-teams.** The 7 sopx epics don't have an epic-meta.json — they pre-date this ADR. Should the sentinel write `spawnAt: <now>` on first encounter and start the 6h clock from there, or read git's branch-creation date as a proxy? Driver pref: write `spawnAt: <now>` with a `backfilled: true` flag so the verdict is clearly conservative.

- **OQ2 — sentinel escalation cadence.** Once-per-team-per-day, or once-per-team-per-spawn? Recommend once-per-spawn (debounce by `(epicId, spawnAt)` tuple) so a dissolve-and-respawn cycle gets a fresh notification.

- **OQ3 — should NEVER-STARTED auto-dissolve without operator approval?** Driver pref: NO — `--apply` mode surfaces the verdict but requires operator `--skip-checks` to dissolve, same as DRAIN with stale kanban. Auto-dissolve is too easy to weaponize against a team that's just slow to bring up.

## Consequences

**Positive:**
- Closes the "I have 7 ghost epic-teams in my cockpit and didn't notice" failure class
- Symmetric to ADR-208 deploy-completeness pattern (spawn ≠ deploy; same regression-pin shape)
- Reuses existing sentinel + state-file + ADR-126 dedup infrastructure — no new surface

**Negative:**
- Adds a state file (`epic-meta.json`) per epic-team — small write amplification; one file per team is fine
- Requires migration step for pre-existing rostered teams (OQ1)
- `atmux up` socket-truth fix risks correctness regression if some teams legitimately use non-default tmux socket naming — needs careful test coverage

**Neutral:**
- Operators who liked the "scaffold + leave parked" pattern lose it after 6h; they get an inbox ping. Acceptable.

## Evidence / repro

Reproducer from sopx project, 2026-05-21:

```bash
cd /root/work/ifca/src/sopx-root-epics/e-854194ad
atmux status --json | jq '{kanban, members: [.members[] | {name, cageState, heartbeat_age_s}]}'
# → kanban: {todo: 21, inProgress: 0, done: 0}
# → every member cageState: down
git log $(git merge-base HEAD origin/sopx-geoyws)..HEAD --oneline
# → empty (0 commits ahead)
tmux -L atmux-e-854194ad ls
# → error connecting to /tmp/tmux-0/atmux-e-854194ad (No such file or directory)
ATMUX_CALLER_SCOPE=driver atmux up
# → 🔹 atmux session atmux-e-854194ad already running — reusing  (FALSE POSITIVE — Bug 3)
```

All 7 sopx epic-teams (e-854194ad, e-c1c7766a, e-33cf85a3, e-4c19dbdb, e-dea743ec, e-2df34086, e-c1e36aec) reproduce identically.
