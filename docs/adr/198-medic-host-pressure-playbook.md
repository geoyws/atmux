# ADR-198: Medic host-pressure playbook — automated cleanup at load / RAM / swap thresholds

**Status**: Accepted — ratified by driver 2026-05-21 (§D1 3 thresholds + §D2 5-step playbook + §OQ recommendations as-written: v1 hardcoded constants, no auto-rollback, single-host scope, no cgroup-cage caps, permissive stack regex w/ protected-list, 5-min cadence tighten under pressure)
**Date**: 2026-05-21
**Driver-ref**: 2026-05-21 operator manual cleanup of hax (load 82 → 27, RAM 68GB-used/2GB-free → 61GB/29GB, 11 merged epic-teams dissolved, duplicate sopx-staging + sopx-e2e docker stacks stopped) — surfaced via complaints `c-718abae6` (atmux) + `c-f901569f` (ifca-docs sibling).
**Cross-refs**: [ADR-077](077-superdoctor-cockpit-role.md) (medic substrate — fleet self-healing loop at cockpit W2), [ADR-184](184-host-wide-epic-team-cap-queue-and-dormancy-audit.md) (host-wide epic-team cap + spawn queue — same multi-project host-tier surface), [ADR-132](132-pluggable-martinet.SUPERSEDED.md) (sentinel sibling — observe-only counterpart at W3), [ADR-158](158-martinet-to-sentinel-rename.SUPERSEDED.md) (rename), [ADR-189](189-lean-mode-side-project-topology-preset.md) (lean-mode pivot — on-demand-via-medic-verb rather than continuous cron-poll), [ADR-197](197-cron-reaper-teardown-contract.md) (cron-reaper teardown contract — sibling cleanup class for the cron surface), complaint `c-718abae6` (closes), complaint `c-f901569f` (closes — ifca-docs cross-link), Epic `e-a771c03d` (parent — this ADR is its T1 anchor).

## Context

2026-05-21 hax host-pressure incident (captured in `c-718abae6`):

| Metric | Pre-cleanup | Post-cleanup |
|---|---|---|
| Load average | 82 | 27 |
| RAM used | 68 GB (2 GB free) | 61 GB (29 GB free) |
| Swap | (operator-observed elevated; exact GB not captured in complaint) | normal |
| Stale containers | accumulated from 2-3 stacks running in parallel | pruned |
| Stale epic-teams | 11 with 0 unmerged commits + worktree still hot | dissolved |

Recovery required operator manual intervention: `docker container prune` + `docker builder prune` + stop the superseded `sopx-staging` / `sopx-e2e` docker stacks (kept `sopx-geoyws-staging` + prod) + `docker rm` on stale `sopx-test-*` DB containers + `atmux team dissolve-epic <eid> --force-prune --skip-checks` on 11 merged epics. The operator did all of this by hand; no automated loop owned it.

Medic owns fleet self-healing per ADR-077 — host-tier pressure is the next-larger scope of "self-heal what the loop can safely fix without operator." ADR-184 (host-wide epic-team cap + dormancy audit) handles *spawn-time* admission control; this ADR handles *runtime* relief once the host is already under pressure. ADR-197 (cron-reaper) handles the OS-crontab leak surface; this ADR handles the docker / epic-team / RSS leak surface. The three ADRs cover separate inventories at the same multi-project hax-host scope.

### Why automate now, not earlier

Pre-ADR-184 the fleet was small enough that manual cleanup was tolerable (4–8 teams, ~1 RSS-pressure event per month). Post-ADR-091 epic-team proliferation pushed the failure-frequency to multiple events per week; the 2026-05-21 load=82 event is the third manual-cleanup incident in two weeks (per complaint history). Manual cleanup cost is operator-cycles + the latency window where the entire fleet is degraded (every team running on the host slows down until cleanup completes). Both push past the automation-payoff threshold.

## Decision

### §D1 — Pressure thresholds (3 trip conditions; ANY fires the playbook)

Medic's existing cron tick (or its event-driven successor under lean-mode per ADR-189) evaluates three signals at every tick:

| Signal | Threshold | Source |
|---|---|---|
| **Load average (1-min)** | `> 2 × $(nproc)` (e.g. >32 on a 16-core host) | `cat /proc/loadavg \| awk '{print $1}'` |
| **Available RAM** | `< 10%` of total | `free` `MemAvailable / MemTotal` |
| **Swap usage** | `> 20 GB` (host-absolute, NOT percentage) | `free` `SwapUsed` |

Any single signal trips. Thresholds are hardcoded in v1 (per §OQ1 below); env-overridable in v2 via `ATMUX_MEDIC_LOAD_MULT` / `ATMUX_MEDIC_RAM_AVAIL_PCT` / `ATMUX_MEDIC_SWAP_GB`. Per-host tuning lands when a second host joins (currently single-host hax per `~/.claude-personal/CLAUDE.md` §Machines).

### §D2 — 5-step playbook (ordered, idempotent, monotonic-effect)

When ≥1 threshold trips, medic fires the playbook in order. Each step is idempotent (re-runs are no-ops if already done); each step's effect is monotonic (frees more resources, never consumes); abort-mid-playbook leaves the host in a strictly-better state than where it started.

```
Step 1: docker container prune --filter "until=24h" --force
        docker builder prune --filter "until=24h" --force
        — Reclaim ephemeral build caches + stopped containers older than 24h.
        — 24h cutoff preserves any in-flight retry/debug workflow.

Step 2: For each docker-compose stack on host:
          if matches /(.*)-(staging|e2e)$/ AND NOT in protected-list
          AND last-activity > 6h:
            docker compose -f <path>/docker-compose.yml down
        — Protected list (v1 hardcoded): sopx-geoyws-staging, sopx-prod,
          ifca-prod, any stack referenced in operator's active *.ifca.app
          DNS (per ~/.claude-personal/CLAUDE.md §DNS / infra).
        — Stops superseded per-branch staging stacks that accumulated
          from earlier dev branches.

Step 3: docker ps -a --filter "name=sopx-test-" --filter "status=exited"
          --format "{{.ID}}" | xargs -r docker rm
        — Pattern-match stale per-test DB containers (sopx-test-<sha>
          shape). Exited-only — never touches live test runs.

Step 4: For each epic-team in `~/.atmux/cockpit.json::sessions[type=epic-team]`:
          if state == "dissolved" OR
          (parent_kanban_epic.status == "done" AND git_state_clean(epic-team)
            AND unmerged_commits == 0):
            ATMUX_CALLER_SCOPE=driver atmux team dissolve-epic <eid>
              --force-prune --skip-checks
        — Reaps merged epic-team cages whose work is already in trunk.
        — Inherits ADR-197 cron-reaper teardown-hook → cron blocks cleared
          as part of dissolve.
        — Worktree-clean check prevents reaping mid-flight work; --skip-checks
          covers the cockpit-state-vs-disk-state edge.

Step 5: For orphan tmux cages (sockets under `/tmp/atmux-*/sock` whose
        cockpit entry is gone OR whose `tmux ls` returns 0 sessions):
          tmux -S <sock> kill-server 2>/dev/null
          rm -rf <tmpdir>
        — Picks up the residue from operator-killed cages + crash-orphaned
          processes that bypassed JS-level teardown hooks.
        — Sibling pattern to ADR-178 test-cage leak reaper at the
          production-cage scope.
```

Step ordering matters: Step 1 is cheapest (typically frees the most disk-cache RAM); Step 2–3 free docker RAM; Step 4 is the heaviest (forks `atmux team dissolve-epic` per epic — O(seconds) each) but has the largest payoff under accumulated epic-team scenarios; Step 5 is final cleanup at the OS level.

### §D3 — Safe-skip rules (HARD INVARIANTS — refuse to reap)

Medic NEVER reaps any of the following, regardless of pressure level:

1. **Main team drivers / leads** — never `kill -9` a cockpit driver or any team's lead pane. Operator-cycles cost to recover dwarfs any RAM saved.
2. **Epic-team cages with unmerged commits** (`git log <base>..HEAD` non-empty). Reaping these loses work.
3. **Epic-team cages with worktree-dirty status** (`git status --porcelain` non-empty). Same reason — uncommitted work in flight.
4. **Docker stacks in the protected-list** (sopx-geoyws-staging, sopx-prod, ifca-prod — see §D2 step 2). Operator's customer-visible surfaces.
5. **Test runs mid-flight** (any `sopx-test-<sha>` container in `running` state, any `bun test` PID alive). Catches the in-progress test that hasn't reached `exited` yet.

A trip threshold that ONLY clears against protected resources falls through to surface-to-operator (see §D5) without reaping anything.

### §D4 — Close-out receipt (Discord [medic-host-cleanup] template per ADR-086)

After each playbook run, medic emits a single Discord pulse per the ADR-086 vocabulary:

```
🟢 [medic-host-cleanup] hax — load 82→27, RAM 68→29GB free, swap NGB→MGB
   - Step 1: docker prune freed 12.3 GB
   - Step 2: stopped 3 stacks (sopx-staging-feature-x / sopx-e2e-old / ...)
   - Step 3: removed 18 sopx-test-* exited containers
   - Step 4: dissolved 11 epic-teams (e-aa01 / e-bb02 / ... / no unmerged commits)
   - Step 5: cleaned 2 orphan tmux cages
   Receipt: ~/.atmux/state/medic-cleanups/<ts>.json
```

The `Receipt:` file is a structured audit log per ADR-005 atomic-write convention. Operator can diff receipts across runs to track cleanup effectiveness over time. JSON shape includes `{trippedSignals, freedRamGB, dissolvedEpics, stoppedStacks, durationSec, ...}`.

Per memory `feedback_overnight_reddit_stakes` — receipt commits to a real outcome (numbers + before/after deltas), not just "I ran the playbook". The before/after metric pair is the proof.

### §D5 — Surface-to-operator fallback

If ALL safe-skip rules block reaping AND the host stays in pressure 2 ticks in a row (10 min under lean-mode tick cadence), medic fires a `severity:p0` flag via `atmux flag add` + Discord ping:

```
🚨 [medic-host-cleanup] hax — pressure HELD across 2 ticks, all reapable resources
   protected. Manual intervention required.
   Tripped: load=42 (threshold 32), RAM-avail=8% (threshold 10%)
   Inventory: 4 protected stacks, 7 epic-teams with unmerged work, 0 reapable
```

This catches the "host overloaded by genuinely productive work, not by leak residue" case — operator decides whether to scale up, defer non-critical work, or override safe-skip rules manually.

### What we give up

- **Soft per-stack ownership**. Step 2 hardcodes the protected-list. Adding/removing protected stacks requires an ADR-amendment + code change (or env-override once §OQ1 lands). Wrong call here = downtime on a real stack the playbook stopped.
- **Slower medic ticks under pressure**. Step 4's dissolve-epic forks add ~3-5s per epic; an 11-epic cleanup is ~30-55s of medic-tick time. Acceptable trade — pressure ticks are rare; idle ticks stay fast (the threshold check is `awk`-and-grep cheap).
- **Receipt-file disk usage**. ~1KB per cleanup × ~10 cleanups/month = ~120KB/year. Negligible; cap at 100 receipts via FIFO rotation (lands in T2 impl).

### Rollback path

If the playbook causes more downtime than it relieves:

1. **Env disable** — `ATMUX_MEDIC_HOST_PRESSURE=0` skips the threshold check entirely; medic continues serving its other duties.
2. **Per-step disable** — `ATMUX_MEDIC_HOST_PRESSURE_STEPS=1,4` runs only Steps 1 + 4 (the highest-leverage, lowest-risk pair). Granular bypass.
3. **Full revert** — drop §D1 / §D2 / §D3 wiring from medic; keep §D4 receipt format for any future re-attempt. ADR stays as historical record.

## Sub-tasks (decomposed by planner; impl Tasks land downstream)

- **T1** — ADR-198 draft (this file). Lane=`misc`, deps=none, priority=1. (← *this Task is t-ef4f5367*)
- **T2** — `src/core/medic-host-pressure.ts` — threshold-check + 5-step playbook + receipt-writer + protected-list config. Same-commit unit tests covering each step's idempotency + monotonic-effect property. Lane=`be`, deps=T1, priority=1.
- **T3** — Medic skill / verb integration — wire the host-pressure check into the existing medic event-driven tick path (per ADR-189 / ADR-132 §Amendment 2026-05-20). Lane=`be`, deps=T2, priority=1.
- **T4** — Discord template for `[medic-host-cleanup]` per ADR-086 vocabulary. Lane=`be`, deps=T2, priority=2.
- **T5** — Doctor probe surface — `host-pressure` row in `atmux doctor` output (green / yellow / red mirroring the threshold trip state). Same-commit doctor-output snapshot test. Lane=`be`, deps=T2, priority=2.
- **T6** — Receipt-file FIFO rotation + structured-shape Zod schema. Same-commit schema-roundtrip test. Lane=`be`, deps=T2, priority=2.
- **T7** — e2e integration — synthetic load-shape fixture (cgroup-bound RAM cap + dummy docker stacks + 3 fake epic-teams) walks the trip → playbook → receipt path. Lane=`test`, deps=T2+T3, priority=2.
- **T8** — Docs sweep: CLAUDE.md §Medic discipline (new section), CHANGELOG entry, RUNBOOK-medic.md (new file if absent — currently no RUNBOOK-medic exists), brief templates (medic skill body update). Status flip to `accepted` lands here once T2-T7 ship. Lane=`misc` (docs), deps=T2+T3+T4+T5+T6+T7, priority=3.

## Open questions

1. **(LOW reversibility) Threshold tuning per-host**: hardcode constants in v1 OR env-overridable from the start? Recommend hardcoded in v1 (single-host hax simplifies); env override lands in v2 once a second host joins or the hax workload diverges enough to warrant tuning. The 3 env vars are reserved in §D1 for the v2 surface.

2. **(MEDIUM reversibility) Auto-rollback if playbook makes the host LESS stable**: if pressure metric WORSENS in the 5 min following a playbook run, should medic roll back (re-start stopped stacks, etc.)? Recommend NO in v1 — rollback adds significant complexity (durable pre-run state capture, per-step undo logic) and the protected-list + safe-skip rules already bound the blast radius. If empirical data shows rollback is needed, file as ADR-198a follow-up.

3. **(LOW reversibility) Cross-host coordination**: if/when atmux runs on a second host, do the medic playbooks coordinate? Recommend NO — single-host scope only in v1; cross-host work lives in ADR-184 territory (host-wide cap is also single-host today). If multi-host arrives, both ADRs coordinate through a shared "host-tier registry" surface.

4. **(MEDIUM reversibility) Container-level RAM cap per cage**: should atmux set cgroup RAM limits on each spawned tmux cage to prevent runaway RAM use from any single cage? Recommend NO in v1 — cgroups setup is a sysadmin / Docker-Compose territory; atmux shouldn't take on that surface. If cage-RAM hogs become a pattern, file as new ADR (sibling to ADR-181 global-RAM-budget-gate-on-spawn).

5. **(LOW reversibility) Step-2 stack-match regex**: `(.*)-(staging|e2e)$` is intentionally permissive — catches `sopx-staging-feature-x`, `sopx-e2e-old`, etc. False-positive risk: a stack named `my-prod-staging` would match. Mitigation: protected-list explicitly carries production-equivalent staging surfaces (sopx-geoyws-staging) by name. Operators with non-conforming naming add their stacks to the protected-list.

6. **(LOW reversibility) Tick cadence under pressure**: medic's idle-cadence is hourly (per ADR-077 §D1) post-ADR-189 (event-driven mostly, hourly-ish backstop). Under pressure, should cadence tighten to 5-min for faster relief? Recommend YES — when a tick fires the playbook, the next medic tick re-checks pressure within 5 min (not 1h). De-escalates to hourly once pressure < thresholds for 2 ticks running. Lands as T2 impl detail (the cron / event arming carries a `next-tick-after-playbook` override).

## Cross-refs

- [ADR-077](077-superdoctor-cockpit-role.md) (medic substrate — fleet self-healing loop at cockpit W2; this ADR adds host-tier pressure to medic's remit).
- [ADR-086](086-atmux-pulse.SUPERSEDED.md) (Discord template vocabulary — `[medic-host-cleanup]` follows the verdict-first + bullet-list + receipt-link pattern from §D4).
- [ADR-132](132-pluggable-martinet.SUPERSEDED.md) §Amendment 2026-05-20 (sentinel sibling — observe-only counterpart at W3; medic owns the *act*, sentinel owns the *observe*).
- [ADR-158](158-martinet-to-sentinel-rename.SUPERSEDED.md) (martinet → sentinel rename).
- [ADR-178](178-test-cage-leak-reaper.md) (test-cage leak reaper — Step 5 orphan-cage cleanup is the production-cage sibling of ADR-178's test-cage scope).
- [ADR-181](181-global-ram-budget-gate-on-spawn.md) (global RAM-budget gate at spawn — admission control sibling to this ADR's runtime relief).
- [ADR-184](184-host-wide-epic-team-cap-queue-and-dormancy-audit.md) (host-wide epic-team cap + dormancy audit — same multi-project hax-host scope; this ADR is the *act* arm to ADR-184's *plan + audit* arm).
- [ADR-189](189-lean-mode-side-project-topology-preset.md) (lean-mode pivot — medic's threshold-check fires on event-driven tick under lean-mode, hourly-backstop under fleet-mode).
- [ADR-197](197-cron-reaper-teardown-contract.md) (cron-reaper teardown contract — Step 4 dissolve-epic inherits ADR-197's cron-strip via the teardown hook).
- Complaint `c-718abae6` (closes — 2026-05-21 hax operator manual cleanup).
- Complaint `c-f901569f` (closes — ifca-docs sibling complaint).
- Epic `e-a771c03d` (parent — this ADR is its T1 anchor; sub-tasks T2-T8 above).
- Memory `feedback_hax_128gb_ram_throttling` (CPU is the gating throttle on hax, not RAM; informs §D1 threshold balance — RAM threshold catches leak-RSS, load threshold catches CPU-pegging work, both at multi-of-cores).
- Memory `feedback_overnight_reddit_stakes` (operator threat-mode stakes — receipt commits to outcome metrics so operator can verify medic isn't lying about doing work).
- Project `~/.claude-personal/CLAUDE.md` §Machines (single-host hax; informs §OQ3 cross-host scoping).
