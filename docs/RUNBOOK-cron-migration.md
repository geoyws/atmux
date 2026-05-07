# Runbook — cron migration for ADR-053 / R1 wave

**Audience:** operators upgrading already-running atmux teams to the R1
wave (ADRs 053–056). The new `whip-resume-check` cron line (1-min cadence)
replaces the manual budget-resume polling pattern, but it doesn't install
itself on existing teams — operators must trigger a re-render of the
team's managed crontab block.

**Why it matters:** without `whip-resume-check`, budget-pause auto-resume
defers to the regular 5-min `whip` tick. That's correct behavior, just
slower — the resume window can be up to 5min off from the actual budget
refresh. R1's 1-min cadence narrows that to ~1min.

> **Status note (2026-05-07):** the bun-port `cron-install` verb is
> Phase-2 deferred per `src/verbs/start.ts:63-64`. Today the bash-side
> `lib/cron.sh` is the canonical installer (lives in `atmux-geoyws`,
> NOT this worktree). The TS-side `src/core/cron.ts::renderCronBlock`
> is the spec the bun-port install verb will render against (commit
> `9c50354`). Until the install verb lands, follow the bash-side
> migration path below.

---

## What changes in the cron block

The new managed block (per `src/core/cron.ts::renderCronBlock`) is up to
**5 lines**, marker-fenced, idempotent re-install:

```cron
# >>> atmux:team=<n> — managed by atmux start; do not edit by hand
*/5  * * * * <prefix> atmux whip                  >> .../whip.log 2>&1
*/30 * * * * <prefix> atmux report                >> .../report.log 2>&1
0 */4 * * *  <prefix> atmux decisions digest      >> .../decisions-digest.log 2>&1
0 4 * * *    <prefix> atmux groom --quiet         >> .../groom.log 2>&1
*/1  * * * * <prefix> atmux whip-resume-check     >> .../whip-resume-check.log 2>&1   ← NEW (R1-T7)
# <<< atmux:team=<n>
```

`<prefix>` is the cage-tmux + atmux-dir bake (`TMUX_TMPDIR=… ATMUX_DIR=…
/usr/local/bin/atmux`).

**Conditional lines** (omitted when the gate condition is false):

| Line | Gate |
|---|---|
| `whip-resume-check` (1-min) | `team.whip.claudeAccount` is set. Teams without budget observability skip. |
| `discorder progress` + `discorder heartbeat` | Team has a `role: "discorder"` member. Replaces the regular `report` line. |
| `unblocker tick` (2-min) | Team has a `role: "unblocker"` member. |

The 4 base lines (`whip` / `report` / `decisions digest` / `groom`)
remain regardless.

---

## Migration path — manual (today)

For each fleet team you want to upgrade:

### Option A — recycle via `atmux stop` + `atmux start` (cleanest)

```bash
cd /path/to/team-project    # the team's project root (where .atmux/ lives)
atmux stop                  # graceful shutdown — flushes inbox + lead-outbox + tears down windows
atmux start                 # re-spawns members + re-installs the cron block via lib/cron.sh
```

`atmux stop` followed by `atmux start` re-renders the cron block from
scratch via the bash-side `lib/cron.sh::_atmux_cron_install` (or the
bun-side install verb when it ships) and includes the new
`whip-resume-check` line if `team.whip.claudeAccount` is set.

**When to pick this:** lowest-risk path; idempotent; zero handcrafting.
Acceptable when team is at a phase boundary (no critical in-flight
work) — the stop/start cycle preserves kanban state but does
`/clear` member panes.

### Option B — surgical `crontab -e` edit (skip stop/start)

If the team has critical in-flight work and you don't want to recycle,
edit the managed block directly:

```bash
crontab -e
# Find the team's marker-fenced block:
#     # >>> atmux:team=<n> ...
#     ...
#     # <<< atmux:team=<n>
# Add the new line BEFORE the closing `# <<<` marker:
*/1 * * * * TMUX_TMPDIR=<your-tmpdir> ATMUX_DIR=<your-atmux-dir> /usr/local/bin/atmux whip-resume-check >> <your-atmux-dir>/logs/whip-resume-check.log 2>&1
```

Copy the `TMUX_TMPDIR=...` + `ATMUX_DIR=...` prefix verbatim from one of
the existing lines in the same block — they MUST match for the verb to
find your team's state files.

After saving, verify:

```bash
crontab -l | grep -A1 "whip-resume-check"
ls -la /path/to/.atmux/logs/whip-resume-check.log    # should appear within 1min
```

**When to pick this:** team is mid-flight on a deliverable; recycle is
not worth the risk. Trade-off: slightly more error-prone (typos in the
prefix silently break the verb).

---

## Migration path — Phase-2 (planned)

Once `src/verbs/cron.ts` (the bun-port install verb) ships, the
operator command becomes a single line:

```bash
atmux team reconfigure --cron-only
```

This consumes `src/core/cron.ts::renderCronBlock` to produce the
canonical block, replaces the existing fence-marked block in
`crontab -l`, and writes back via `crontab -`. Idempotent by
construction (the renderer is pure).

**Tracking:** see the deferral note at `src/verbs/start.ts:63-64`. No
ADR has been opened yet for the install verb's port; expected to fold
into the broader Phase 5 WIP-bash catch-up plan or to land as a
small standalone ADR alongside the next R1 sub-wave.

---

## Verification checklist (per team)

After migrating, on the cron host (typically hax):

- [ ] `crontab -l | grep "atmux:team=<n>"` shows the marker-fenced block.
- [ ] `crontab -l | grep "atmux whip-resume-check"` shows the new line within the team's block (or absent — that's correct — if `team.whip.claudeAccount` is unset).
- [ ] `ls -la /path/to/.atmux/logs/whip-resume-check.log` exists and grows after 1min.
- [ ] First `whip-resume-check` log entry has `lock acquired` or `skipping (lock contended)` line — both are healthy. Errors mean misconfigured prefix.
- [ ] `atmux doctor` reports green on the team. ADR-054 drift detection will fire `[whip-config-drift]` if the team.json is out of sync with the new schema.
- [ ] `tail -f .atmux/logs/budget-history.jsonl` shows JSONL probe entries arriving (not necessarily every minute — cache TTL governs probe vs cache-hit rate).

If any check fails: revert the block to its pre-migration shape and
ping the docs / lead in `lead-outbox.md` with the failure mode + log
excerpt.

---

## Reference

- **Verb:** `src/verbs/whip-resume-check.ts` (`9c50354`).
- **Block renderer (TS spec):** `src/core/cron.ts::renderCronBlock` (`9c50354`).
- **Block installer (bash, live today):** `lib/cron.sh` in `atmux-geoyws` branch — NOT in `worktree-atmux-bun`.
- **Phase-2 deferral note:** `src/verbs/start.ts:63-64`.
- **Stall-prevention follow-up (v1.1.x):** ADR-057 (planner intent; not in this R1 wave).

---

## v1.1.x cron-block migration — `watchdog` line (ADR-057 §D6b)

The R57-T6 wave (`3fc6651`) adds a sixth managed cron line — `*/2 atmux
watchdog` — that runs the heartbeat-staleness detector independently of
the regular `*/5 atmux whip` tick. Reasoning (ADR-057 §D6b): "Watchdog as
separate cron — independent of whip's body-hash logic so a stuck whip
doesn't blind the watchdog." Every team that wants member-stall detection
needs this line.

### What gets added

```cron
*/2 * * * * <prefix> atmux watchdog                >> .../watchdog.log 2>&1   ← NEW (R57-T6)
```

`<prefix>` matches the existing block — `TMUX_TMPDIR=… ATMUX_DIR=…
/usr/local/bin/atmux`. The line lives inside the team's `# >>>
atmux:team=<n>` marker fence alongside `whip` / `report` /
`decisions digest` / `groom` / `whip-resume-check`.

The full managed block after migration is up to **6 lines**:

```cron
# >>> atmux:team=<n> — managed by atmux start; do not edit by hand
*/5  * * * * <prefix> atmux whip                  >> .../whip.log 2>&1
*/30 * * * * <prefix> atmux report                >> .../report.log 2>&1
0 */4 * * *  <prefix> atmux decisions digest      >> .../decisions-digest.log 2>&1
0 4 * * *    <prefix> atmux groom --quiet         >> .../groom.log 2>&1
*/1  * * * * <prefix> atmux whip-resume-check     >> .../whip-resume-check.log 2>&1
*/2  * * * * <prefix> atmux watchdog              >> .../watchdog.log 2>&1   ← NEW
# <<< atmux:team=<n>
```

The watchdog line is unconditional — every team gets it. Without
heartbeat files (no D6a write-path enabled yet), the watchdog still
runs but just reports "all heartbeats fresh" or "all heartbeats null"
on each tick; cost is one process spawn per 2min.

### Migration — recommended path

```bash
cd /path/to/team-project
atmux team reconfigure --cron-only
```

Once the bun-port `cron-install` verb ships (per the Phase-2
deferral note above), this single command re-renders the managed
block from `src/core/cron.ts::renderCronBlock`, drops in the new
`watchdog` line, and writes back via `crontab -`. Idempotent.

For fleet teams (multiple projects), repeat the command in each
team's project root. Order doesn't matter; each team's marker-fence
is independent.

### Migration — interim path (today)

The bun-port install verb is still Phase-2 deferred (`src/verbs/start.ts:63-64`),
so today operators use one of:

**Option A — recycle (cleanest):**

```bash
cd /path/to/team-project
atmux stop && atmux start
```

The bash-side `lib/cron.sh::_atmux_cron_install` (in `atmux-geoyws`
branch) re-renders the block and includes the watchdog line if your
bash-side `lib/cron.sh` is at the version that includes the v1.1.x
`watchdog` rendering. Confirm with:

```bash
which atmux                                         # → /usr/local/bin/atmux
ls -la /usr/local/bin/atmux                         # symlink target
grep -c "atmux watchdog" "$(readlink -f /usr/local/bin/atmux | sed 's/bin/lib/;s/atmux$/cron.sh/')"
```

If the bash-side renderer doesn't yet emit the watchdog line, fall
back to Option B until your bash branch catches up.

**Option B — surgical `crontab -e` edit:**

```bash
crontab -e
# Find the team's marker-fenced block:
#     # >>> atmux:team=<n> ...
#     ...
#     # <<< atmux:team=<n>
# Add BEFORE the closing `# <<<` marker:
*/2 * * * * TMUX_TMPDIR=<your-tmpdir> ATMUX_DIR=<your-atmux-dir> /usr/local/bin/atmux watchdog >> <your-atmux-dir>/logs/watchdog.log 2>&1
```

Copy the `TMUX_TMPDIR=...` + `ATMUX_DIR=...` prefix verbatim from one
of the existing lines in the same block — they MUST match for the
verb to find your team's heartbeat files.

After saving:

```bash
crontab -l | grep -A1 "atmux watchdog"
ls -la /path/to/.atmux/logs/watchdog.log    # should appear within 2min
```

### Verification — watchdog line healthy

After migrating, on the cron host:

- [ ] `crontab -l | grep "atmux watchdog"` shows the new line in the team's block.
- [ ] `ls -la /path/to/.atmux/logs/watchdog.log` exists and grows after ≤2min.
- [ ] First few entries say `watchdog: all heartbeats fresh` (or `… N stale member(s) flagged this tick` if heartbeats are absent — both are healthy; the absence path indicates D6a heartbeat-writer hasn't started yet).
- [ ] No errors in `tail -20 .atmux/logs/watchdog.log` (a misconfigured prefix surfaces as `team.json not found` or similar).
- [ ] `atmux doctor` reports green; ADR-054 drift detection picks up any `team.json::whip.stallPrevention` typos.

### Reference (R57-T6)

- **Verb:** `src/verbs/watchdog.ts` (`3fc6651`).
- **Heartbeat reader:** `src/core/heartbeat.ts::readHeartbeatAges`.
- **Dedup state:** `.atmux/state/watchdog-state.json` (per-member 24h re-fire window).
- **Audit log:** `.atmux/logs/watchdog.log` (one line per stale member per tick).
- **Config knob:** `team.json::whip.stallPrevention.heartbeatStaleSec` (default 300s).
- **Discord template:** `[whip-watchdog]` (per-member dedup; quiet on hourly cron).
- **Operator playbook:** [`RUNBOOK-stall-recovery.md`](RUNBOOK-stall-recovery.md) — what to do when a watchdog ping fires.
