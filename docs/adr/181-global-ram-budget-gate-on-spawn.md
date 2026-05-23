# ADR 181 — Global RAM-budget gate on epic-team + /team start spawn

**Status:** Accepted — ratified by driver 2026-05-23 (substrate shipped via ADR-184 host-pressure gate in spawn-epic; reviewer-signoff path bypassed after 4 days of no objection + impl evidence). Direct heir [ADR-184](184-host-wide-epic-team-cap-queue-and-dormancy-audit.md) extended this to a host-wide cap + spawn queue; full queue-and-drain landing under orchd lifecycle EPIC [e-a946af69](../tasks/t-0db3f393.md) Phase 5.
**Date:** 2026-05-19
**Driver-ref:** Chat conversation 2026-05-19 ~14:00 MYT — observed live RAM pressure during attempt to spawn unum team (40/61 GB physical used + 41 GB swap utilised + 156 concurrent claude processes); driver direction *"let's make sure we are sensitive to RAM pressure in atmux as well, so we dont' overwhelm the server"* + *"so we have to throttle the epic teams creation"*.
**Related:** ADR-091 (spawn-epic — creates ephemeral epic-teams), ADR-077 (superdoctor → renamed to medic per ADR-133), ADR-132 (sentinel — pluggable whip-manager), ADR-140 (cheap-model-first principle), ADR-162 (cockpit socket isolation).

## Context

Atmux spawns claude TUI instances at two layers:

1. **`/team start <team>`** spawns the configured roster of a team — typically 4–7 members on Opus 4.7 + xhigh. Documented in `~/.claude/skills/team/SKILL.md`.
2. **`atmux spawn-epic <epic-id>`** (ADR-091) creates an ephemeral epic-team with its own worktree, state.db, and roster — typically 4–7 members, again on Opus 4.7 + xhigh. A parent team can have multiple concurrent epic-teams.

Each claude TUI on Opus 4.7 + xhigh has a resident-set size of approximately 0.5–2 GB depending on context growth and plugin load (observed range 350 MB at spawn → 1.5 GB after sustained work; see the top-20 RSS profile from the 2026-05-19 RAM-pressure probe).

The current verbs apply no global resource gate. A `/team start` or `atmux spawn-epic` will fire even when the host is already in RAM-pressure territory. Observed compounding effect on hax (2026-05-19, 14:00 MYT):

- 61 GB physical RAM, **40 GB used (66%)**, only 4 GB free
- 127 GB swap, **41 GB swap utilised** (the host has already overflowed physical into swap)
- 21 GB available including reclaimable cache — honest headroom
- **156 concurrent claude processes** across 9 team-config trees, only 2 live tmux cage sockets visible (cockpit + team-alpha-cage)
- Zero PPID=1 orphan claudes; zero tmux zombie windows — i.e. the 156 processes are *legitimate active work*, not zombies that a cleanup sweep would reap

In that state, firing `/team start unum` (9 members) would add 9–13.5 GB of additional resident memory, consuming most of the reclaimable cache and deepening swap pressure. The action was rational in isolation but would have been globally harmful.

The risk shape:

- **Per-spawn decisions are locally rational.** A lead deciding to spawn an epic-team for a 5-task epic is making the right call for that epic.
- **Global accumulation is what overwhelms the host.** No single spawn caused the 41 GB swap; the accumulation of correct-in-isolation spawns did.
- **No verb in atmux today checks global RAM before spawning.** Neither spawn-epic, nor /team start, nor /team add reads `/proc/meminfo` or refuses on pressure.
- **Recovery requires manual operator intervention** — stop a team, restart the box, or wait for natural compaction. None of these are proactive.

## Decision

Add a **global RAM-budget gate** as a pre-spawn check in `atmux spawn-epic` and `/team start`. The gate reads `/proc/meminfo`, computes available memory and swap pressure, and applies the matrix below before allowing the spawn to proceed.

### Threshold matrix

The gate examines four signals; the worst verdict across them governs the outcome.

| Signal | Threshold | Verdict |
|---|---|---|
| `MemAvailable` (`/proc/meminfo`) | `< 8 GiB` | **REFUSE** |
| `MemAvailable` | `8 GiB ≤ x < 16 GiB` | **WARN + require `--force`** |
| `MemAvailable` | `≥ 16 GiB` | **PASS** |
| Swap utilisation (`SwapTotal − SwapFree`) | `> 50 GiB` | **REFUSE** |
| Swap utilisation | `20 GiB < x ≤ 50 GiB` | **WARN + require `--force`** |
| Swap utilisation | `≤ 20 GiB` | **PASS** |
| Concurrent claude PID count | `> 200` | **REFUSE** |
| Concurrent claude PID count | `120 < x ≤ 200` | **WARN + require `--force`** |
| Concurrent claude PID count | `≤ 120` | **PASS** |
| Per-host team budget (`ATMUX_MAX_TEAMS` env, default `6`) | exceeded | **REFUSE unless `--force`** |

**Verdict composition:** if any signal returns REFUSE, the spawn is refused (no `--force` override on the hard refuses). If all signals are PASS, the spawn proceeds. If at least one signal returns WARN, the spawn requires explicit `--force`.

### Behaviour on REFUSE

The verb exits non-zero and prints to stderr:

```
🔴 atmux spawn-epic refused — RAM pressure

  MemAvailable:     6.4 GiB  (threshold: 8 GiB)
  Swap utilised:   42.1 GiB  (threshold: 50 GiB)
  Active claudes:  156       (threshold: 200)
  Active teams:    3 / 6

The host is in RAM pressure territory. Spawning a new
roster of 5 members would add an estimated 7.5 GiB resident
memory and likely trigger thrashing.

Options:
  1. Stop an idle team:   atmux stop <name>
  2. Wait for compaction: idle teams free memory over time
  3. Run cleanup sweep:   /team cleanup (kills zombies only)
  4. Override (not recommended): atmux spawn-epic <id> --force-ram
```

### Behaviour on WARN

The verb prints to stderr and exits non-zero unless `--force` was supplied. With `--force`, the spawn proceeds and the warning is logged to `.atmux/state/ram-pressure-log.jsonl` for post-hoc analysis.

### Behaviour on PASS

The verb proceeds normally. No noise.

### Integration with medic role (ADR-077 → ADR-133)

The medic role (cockpit window 2, per ADR-133) gains a new probe: it reads the same signals on its cron tick and, when any cross the WARN threshold, surfaces the state proactively in the cockpit feed and Discord — *before* the operator hits a REFUSE on a spawn attempt. Concrete shape:

- **Probe cadence:** every medic tick (currently 5 min per ADR-077).
- **Surface threshold:** WARN level on any signal.
- **Surface format:** Discord ping with the same matrix shown above + a one-line recommendation (`Consider stopping <idle-team-name> to free ~Y GiB`).
- **Suppression:** the medic does not page on the same threshold within a 30 min window (prevent spam).

This is the cheap-model-first principle (ADR-140) applied to RAM pressure: the medic notices the trend before the lead notices the spawn refusal.

### Implementation surface

| File | Change |
|---|---|
| `src/abstractions/ram-budget.ts` (new) | Pure function reading `/proc/meminfo` + `ps` count, returning verdict |
| `src/verbs/spawn-epic.ts` (existing per ADR-091) | Call `checkRamBudget()` at top; refuse or warn before any side effects |
| `src/verbs/team-start.ts` (or wherever `/team start` is implemented) | Same gate as above |
| `src/verbs/team-add.ts` | Same gate (single-member spawn — gentler thresholds, see Open Questions) |
| `src/medic/probes/ram-pressure.ts` (new) | Reads the same signals; surfaces to cockpit feed + Discord |
| `.atmux/state/ram-pressure-log.jsonl` (new) | Append-only log of WARN-with-force events for post-hoc analysis |

The shared `checkRamBudget()` function is the source of truth; each call site invokes it with a parameter naming the expected member-count of the spawn (so the function can compute "would adding N members tip us over"). The medic probe calls it with `N=0` to get the current state without simulating a spawn.

### Cross-platform note

`/proc/meminfo` is Linux-only. The hax host (Hetzner AX42-U) is the canonical atmux production target; the gate runs there. On macOS (the driver's local dev machine, per global CLAUDE.md), the gate is a no-op — Mac is for development of atmux itself, not for hosting teams. If the user ever runs cages on macOS, a follow-up ADR will spec the `vm_stat`-based equivalent.

## Consequences

### Unblocked

- **The hax host stops being trivially overrunnable.** A single absent-minded `/team start big-team` cannot push it into 50 GB swap.
- **The medic surfaces pressure trends proactively** — operators see "RAM at 80%" 30 min before they'd otherwise discover it via a spawn refusal.
- **The cost model of operating multiple concurrent teams becomes legible.** When the gate refuses, the operator immediately knows the system is at capacity rather than guessing.
- **Epic-team proliferation is bounded.** A long-running parent team that accidentally spawns 10 concurrent epic-teams (each 5 members = 50 claudes) hits the REFUSE before the 10th, not after.

### Costs

- **First-time spawns may need `--force`.** A fresh host with cold cache might trip the WARN threshold transiently as the kernel allocates buffer-cache. Mitigated by the `MemAvailable` (not `MemFree`) signal, which counts reclaimable cache as available.
- **Operator must learn the verbs to free RAM.** `atmux stop <name>` and `/team cleanup` are the primary tools. Both are documented in their respective skill files.
- **A genuinely-busy host cannot spawn new work.** This is the *intended* behaviour: refusing the spawn is the right answer when the box can't actually serve it. The cost is that the operator may need to make explicit prioritisation calls ("stop X to start Y") rather than letting the host melt.
- **One new probe per medic tick.** Negligible — `/proc/meminfo` read + `ps` count is sub-millisecond.
- **`/team cleanup` does not fix the underlying pressure** when the processes are legitimate active work (as observed 2026-05-19: 156 claudes, zero PPID=1 orphans, zero tmux zombies). The gate must REFUSE in that case; cleanup alone won't help.

### Reversal path

The gate is gated itself by an env var: `ATMUX_RAM_BUDGET_ENABLED=true` (default). Setting to `false` disables all checks. Useful for development of the gate logic itself and for emergency override at the operator level. Not a recommended steady-state.

If the gate proves over-aggressive (refuses too often on healthy hosts), the threshold matrix is a single edit. If it proves under-aggressive (lets through spawns that thrash), tighten the WARN thresholds. The matrix is deliberately conservative; tighten before loosening.

### Reciprocal note to ADR-091 (spawn-epic)

ADR-091 §Implementation does not currently specify any pre-spawn resource check. This ADR is additive — it extends the pre-spawn surface with the RAM gate. ADR-091's other concerns (worktree creation, state.db setup, cockpit registry insertion) are unchanged.

### Reciprocal note to ADR-077 / ADR-133 (medic)

ADR-077 defines the medic role; ADR-133 renamed it from superdoctor. Neither specifies a RAM-pressure probe. This ADR adds one as a named probe under the medic's existing cron-tick model. The medic's reporting surface (Discord + cockpit feed) is unchanged.

## Open questions

1. **OQ1 — Per-verb threshold tuning.** `/team add` (single-member spawn) is gentler than `atmux spawn-epic` (5-member spawn). Should `add` use a softer threshold? **Tentative resolution:** yes — `add` uses thresholds 2 GiB more generous on each side (refuse at `< 6 GiB available` instead of `< 8 GiB`). Worth a follow-up commit; not blocking this ADR.

2. **OQ2 — Force-override audit.** When an operator uses `--force` to bypass a WARN, should the next spawn require a higher level of explicit confirmation (e.g. `--force-twice`)? **Tentative resolution:** no — single `--force` is sufficient; the `.atmux/state/ram-pressure-log.jsonl` audit trail captures the pattern for post-hoc review. Escalation can be revisited if `--force` becomes a habitual default.

3. **OQ3 — Per-member RAM estimate accuracy.** The gate assumes ~1.5 GiB per spawned claude. Observed range is 0.5–2 GiB depending on context growth. Should the gate use the *post-bootstrap steady-state* estimate (closer to 1.0 GiB) or the *fully-contextualised after hours* estimate (closer to 1.8 GiB)? **Tentative resolution:** use 1.5 GiB as a midpoint; revise after one month of `.atmux/state/ram-pressure-log.jsonl` data.

4. **OQ4 — Should the gate also consider CPU load?** Sustained 80%+ CPU might be a similar overload signal. **Tentative resolution:** out of scope for this ADR; file a follow-up if observed. RAM pressure is the load-bearing signal; CPU pressure typically corresponds to a smaller resident memory footprint and shorter recovery cycle.

5. **OQ5 — Coordination with cockpit window count?** A cockpit with 30 team-viewer windows is signalling something. Should the gate read cockpit window count as a fifth signal? **Tentative resolution:** no — window count is not a resource constraint by itself; the underlying claude PID count is the right signal, already covered.

All OQs are low-rev (tunable post-impl). Drivers may flip via the standard ADR-amendment surface.

## Reviewer gate

- [ ] `checkRamBudget()` function is pure (no side effects) and unit-tested with mocked `/proc/meminfo` content covering each verdict transition.
- [ ] `spawn-epic`, `/team start`, `/team add` call the gate at the top of the verb, before any tmux operation, worktree creation, or state mutation.
- [ ] REFUSE verdict exits non-zero with the prescribed stderr format. `--force` flag is recognised on WARN, not on REFUSE for the hard thresholds (MemAvailable < 8, Swap > 50).
- [ ] Medic probe ships in same epic; covers Discord ping format + cockpit feed entry.
- [ ] `.atmux/state/ram-pressure-log.jsonl` append on each `--force` use; format validated as one-line JSON per event.
- [ ] No-op on macOS (kernel detection: `process.platform === 'linux'`).
- [ ] Documentation: `docs/RUNBOOK-ram-budget.md` (new) walks the operator through interpreting the gate's output and choosing between the four options listed in the REFUSE message.

## References

- ADR-091 — `atmux spawn-epic` verb (the primary spawn point this ADR gates)
- ADR-077 — Superdoctor / medic role (the cockpit-level health probe surface this ADR extends)
- ADR-133 — Medic rename (current naming convention)
- ADR-140 — Cheap-model-first principle (the medic probe is exactly this — a non-Claude check that prevents Claude work from being lost)
- ADR-162 — Cockpit socket isolation (the medic lives in the cockpit socket; this ADR's probe runs there)
- Linux kernel docs — [/proc/meminfo](https://www.kernel.org/doc/Documentation/filesystems/proc.txt) (MemAvailable definition)
- Observed event 2026-05-19 14:00 MYT — driver attempting to spawn unum, host at 40/61 GB used + 41 GB swap; the triggering incident for this ADR.
