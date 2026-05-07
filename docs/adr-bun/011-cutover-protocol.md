# ADR-011: Side-by-side cutover protocol

**Status:** accepted
**Date:** 2026-05-04
**Owner:** lead

## Context

The atmux Bun port replaces a tool that is in active production use across **4 teams** (atmux self-bootstrap, sopx-mvp, ifca_aux, unum). Cron lines, operator muscle memory, dispatch scripts, supervisor prompts, and the Discord webhook plumbing all depend on the bash binary at `/usr/local/bin/atmux`. A "rip and replace" cutover that swaps the binary in one shot would compound several unrelated risks at the same instant: runtime change (bash → Bun), language change (shell → TS), serialization layer change (raw `jq` → Zod), and lock-primitive change (`flock(2)` shell → `node:fs.flock`). Any of those can hide a regression that only manifests on a specific verb after a specific cron firing in a specific team's `.atmux/` state shape.

The Bun port has therefore committed (PLAN.md §4.1) to a side-by-side rollout with explicit policy gates, not a calendar countdown. This ADR codifies the protocol so it cannot drift between Phase 1 onset and the Phase 4 cutover gate (PLAN.md §14).

## Decision

### Binary names through each phase

| Phase | `/usr/local/bin/atmux` | `/usr/local/bin/atmux-bun` | `/usr/local/bin/atmux-legacy` |
|---|---|---|---|
| 0–1 (architecture, foundation) | bash (in use) | not installed yet | — |
| 2 (verb porting) | bash (in use) | TS (installed, off-cron) | — |
| 3 (functional parity) | bash (in use) | TS (parity harness driver) | — |
| **4 cutover** | **TS (renamed from `-bun`)** | **(absent — same inode is now plain `atmux`)** | **bash (renamed from `atmux`)** |
| 5–6 (WIP catch-up + v2) | TS | — | bash (rollback fallback) |
| Post-Phase-6 | TS (v2) | — | (deleted in v2 release commit) |

Phase 4 cutover is two `mv(1)` operations in sequence, atomic per-file:

```sh
mv /usr/local/bin/atmux /usr/local/bin/atmux-legacy
mv /usr/local/bin/atmux-bun /usr/local/bin/atmux
```

(Both writes hit the same directory inode, so the window in which `/usr/local/bin/atmux` is missing is one filesystem rename — sub-millisecond, unobservable to cron.)

### Cron rewrite stages — verb-by-verb, team-by-team

After Phase 4 binary rename, the binary path is the same (`/usr/local/bin/atmux`), so cron lines do not need updating for the rename itself. The "cron rewrite" instead applies to **the burn-in window before Phase 4**: during Phase 3 we rewrite cron lines on each team to call `/usr/local/bin/atmux-bun <verb>` instead of `/usr/local/bin/atmux <verb>`, one verb at a time, watching for divergence in Discord output.

Stage order (lowest blast radius first):

1. **`whip`** — fires every 5 minutes per team, idempotent (re-running produces same Discord state), output is observable directly in Discord. **96% of all cron firings** by volume. First to switch because divergence shows up fastest and bash fallback is one cron edit away.
2. **`report`** — fires hourly per team, writes a digest to Discord. Idempotent. Switch second.
3. **`decisions-digest`** / **`groom`** — fire daily per team. Lower frequency but still observable. Switch third.
4. **Interactive verbs** (`send`, `dispatch`, `tell-lead`, etc.) — never cron-fired but operators type them. No mass switch needed; the renamed binary at Phase 4 picks them up.

### Burn-in window per stage

- **≥48 h per stage per team** with zero parity divergence in Discord output before advancing to the next stage.
- "Zero divergence" = the parity harness (PLAN.md §8.2) reports no diff on stdout, exit code, `.atmux/` state, or intercepted Discord webhook calls for any firing observed during the window.
- If divergence appears: revert that team's cron line for that verb to bash, file a parity-divergence bug with the 5-element report (CLAUDE.md test discipline), fix in TS, restart the 48 h window from zero.

### Rollback window after Phase 4 cutover

- Bash binary stays at `/usr/local/bin/atmux-legacy` for **4 weeks** post-cutover as a manual rollback fallback. Any operator can `mv /usr/local/bin/atmux-legacy /usr/local/bin/atmux` to revert.
- Phase 5 (WIP catch-up) and Phase 6 (v2 verb redesign) ship in this window without deleting `atmux-legacy`.
- `atmux-legacy` is deleted only when **v2 ships** (Phase 6 close, PLAN.md §13.2). v2's `member rm/rename` and subcommand restructure are large enough changes that operators get one final chance to sanity-check by side-by-side spot-checking a verb against the legacy binary.

### Hard rule: 14-day-zero-divergence-per-team gate

**Bash is never deleted (renamed `atmux-legacy` → `rm`) until all 4 teams have run TS for 14 consecutive days with zero parity divergence**, where divergence includes:

- Discord output content or formatting drift
- `.atmux/` state file content drift (validated against Zod schema baseline)
- Exit code drift
- Stderr-visible error drift
- Crash / unhandled exception in TS that bash didn't exhibit

The 14-day window resets to 0 on any divergence. This rule supersedes Phase 6's release schedule — if v2 is "ready" at day 10 of a 14-day window and a divergence resets it, v2 holds.

### CHANGELOG + Discord announce at cutover

Phase 4 ships a `CHANGELOG.md` entry under header `## v1.0.0 — TS port` listing:
- Verbs ported with parity (link to parity harness summary)
- ADRs accepted (link to `docs/adr-bun/`)
- Migration notes for operators (none expected — verb names + args identical to bash by ADR-014)
- Known deferrals (Phase 5 WIP modules — link to ADR-013)

Discord announce uses the named template `[lifecycle-cutover]` per CLAUDE.md format (header + bulleted body, ≤80-char bullets, code-format for paths). Posted to the atmux-bun team channel and to each of the 4 production team channels.

## Consequences

**Positives:**
- No "big bang" risk. Each verb gets observed independently before promotion.
- Rollback is one `mv` away for 4 weeks post-cutover.
- The 14-day-zero-divergence-per-team rule turns "is it safe to delete bash?" from a judgement call into a passing-or-not gate.
- Operators see no path change at Phase 4 — `/usr/local/bin/atmux` keeps working, the implementation flips underneath. Cron lines need no edits at the cutover instant (only during Phase 3 burn-in pre-cutover).

**Negatives:**
- Phase 3 burn-in is the longest implicit duration in the plan: 4 stages × 4 teams × ≥48 h = at minimum **32 stage-days**, more if any divergence resets a stage. PLAN.md §5 declines to pin Phase 3 to a calendar; this is honest about the cost.
- During Phase 2–3, two binaries co-exist on each host. Disk + image-build paths must accommodate both (~5 MB extra per host — noise).
- The 14-day-zero gate can in principle stall v2 release indefinitely if some edge case keeps recurring. Mitigation: parity divergence in Phase 3 *should* be hunted to extinction before Phase 4; if a divergence shows up post-cutover it indicates the parity harness missed a class. Auditor gets dispatched to widen the harness (CLAUDE.md "widen vulnerability class" rule).

**Follow-up tickets:**
- Update `install.sh` to detect existing bash atmux on the system and refuse to overwrite without an explicit `--upgrade` flag (Phase 4 prep).
- Doctor verb (Phase 2 porter-B) gets a check for "is `/usr/local/bin/atmux-legacy` present and older than 4 weeks?" → suggest deletion only when v2 is shipped (per the hard rule above).
- Document the rollback procedure (`mv` back) in `docs/runbook-cutover.md` (Phase 4 deliverable, lead writes alongside CHANGELOG).

## Alternatives considered

### A. Big-bang swap — rename at Phase 2 close, no burn-in

Rejected. Compounds runtime + language + serialization + lock-primitive changes at the same instant. CLAUDE.md "verify green from the right path" demands process-level evidence; we'd be flying blind at the moment of swap.

### B. Feature-flag inside one binary (TS shell-out to bash for unported verbs)

Rejected. Doubles the abstraction surface (TS must speak both its own and bash's calling convention), creates ambiguous error paths (which side failed?), and the parity harness can't diff a hybrid against pure bash. Worse, the feature-flag becomes permanent technical debt — once shipped, ripping it out is its own cutover.

### C. Run TS in CI / staging only until full parity, no production exposure

Rejected. Production state shapes (4 teams, accumulated `.atmux/` history, real Discord webhook URLs, real cron scheduling) cannot be fully simulated in fixtures. The fixtures aim to be close but the burn-in *is* the validation. CLAUDE.md "stateful e2e specs are not repeatable smokes" — fixtures cover the deterministic 1x walks; the burn-in covers the long-tail.

### D. Calendar-pinned cutover (e.g., "Phase 4 = day 60")

Rejected. Calendar gates create pressure to skip burn-in to hit a date. PLAN.md §1 explicitly states "no calendar/observation gates — phases are sequential to avoid confusion, not to wait out a clock." This ADR aligns: gates are functional (zero divergence per stage), not temporal.

## References

- PLAN.md §4.1 (side-by-side strategy), §5 (phase table), §13.1 (v1 ship), §14 (Phase 4 exit gate + Phase 4→5 wait)
- ADR-009 (parity harness shape — the source of "zero divergence" verdict)
- ADR-013 (WIP-bash deferral — keeps Phase 5 separate from cutover)
- ADR-014 (verb design debt — confirms v1 ships at 1:1 verb parity, so cutover doesn't surprise operators with renames)
- CLAUDE.md "verify green from the right path", "widen vulnerability class"
