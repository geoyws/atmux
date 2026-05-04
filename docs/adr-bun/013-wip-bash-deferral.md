# ADR-013: WIP-bash deferral (Phase 5 scope)

**Status:** accepted
**Date:** 2026-05-04
**Owner:** lead

## Context

The atmux main checkout at `/root/work/src/atmux/` carries substantial uncommitted WIP that is **not** in the bash codebase at HEAD `2aadc3f` — the commit the Bun port targets for parity. Specifically (enumerated against the working tree at the time of Phase 0 planning):

- **`super-*.sh`** family — `super-arbitrate.sh`, `super-epic.sh`, `super-reply.sh`, `super-status.sh`, `super-tell.sh`, `super-whip.sh`, `superdriver-audit.sh`. The "super" verb namespace is an emerging supervisor-of-supervisors layer on top of the `whip` cron loop.
- **`drive.sh`** — driver-side automation harness for spawning + supervising lead sessions.
- **`team-migrate-to-cage.sh`** — migration script for the cage-socket topology refactor (ADR-016 in bash repo).
- **`team-repair-rename.sh`** — recovery script for renamed teams.
- **`tmux-conf-restore.sh`** — restores user tmux config after atmux mucks with it.
- **`socket-pubsub.sh`** — event-driven pub/sub via the cage socket (ADR-042 in bash repo).

Plus several topology ADRs in flight in the bash repo (016, 026, 044, 045, 046) that have not yet stabilised.

These modules are real work and will eventually need to ship in the TS port. But porting them during Phases 1–4 has three concrete problems:

1. **Moving target.** The bash author is still iterating. Porting an in-progress design means the parity harness diverges (TS says X, bash says Y, not because the port is wrong but because bash changed). Fixing the divergence rewrites the TS port. This loop has no fixed point until bash stabilises.
2. **Spec ambiguity.** Uncommitted WIP often has TODOs, half-implemented branches, and design questions the bash author is still answering. The TS port has no privileged channel to that author's intent (we're a separate worktree) — we'd be guessing.
3. **Phase 1–4 scope inflation.** The committed bash codebase at `2aadc3f` is 30 verbs / ~3500 LOC. Adding ~7 modules + topology refactors before v1 ships could double Phase 2 and push the cutover gate (Phase 4) out by a factor that defeats the side-by-side rollout's whole point.

The CLAUDE.md "structural honesty over demo narrative" rule applies in reverse here: **don't port code that hasn't decided what it is yet**.

## Decision

### Phase 1–4 scope is frozen at bash HEAD `2aadc3f`

The Bun port's parity harness, verb list, and module taxonomy are defined against HEAD `2aadc3f` *only*. The 30 verbs enumerated in PLAN.md §2 are the v1 surface. No `super-*`, no `drive`, no `socket-pubsub`, no migration scripts ship in v1.

### Phase 5 ports the WIP, with its own snapshot rule

Phase 5 begins immediately after Phase 4 cutover (PLAN.md §13.2 anti-pattern guard — no checkpoint deferral, team is not torn down). Phase 5 reads bash WIP **directly from the main checkout's working tree** at `/root/work/src/atmux/lib/` at the moment Phase 5 starts — i.e., it does **not** wait for those files to land in a bash commit. This is intentional:

- The bash author may iterate forever; waiting for "main HEAD has all the WIP" is a no-op constraint that becomes a stall trap.
- Phase 5 picks a single snapshot of the working tree, freezes it as the spec, ports against that.
- Subsequent bash WIP changes after Phase 5's snapshot is taken are a **v3 concern**, tracked as a kanban task post-Phase-6 close. v2 (Phase 6 close) does not include WIP that landed in bash after Phase 5's snapshot.

PLAN.md §11's "Bash WIP keeps moving" risk is accepted at this severity (Medium likelihood, Low impact) because the v3 catch-up loop is bounded by intentional snapshotting, not unbounded chase.

### What Phase 5 actually ports

In order of expected effort (largest first; the porter-foundation + porter-A pair owns Phase 5 per PLAN.md §5):

1. `super-*.sh` family (7 files) — port to `src/verbs/super-*.ts` if the bash author has stabilised the verb names; otherwise port the underlying mechanism and let the v2 redesign (Phase 6) decide whether `super` is a top-level verb namespace or a `super` subcommand.
2. `socket-pubsub.sh` — port carefully; the cage-socket ADRs (016/026/044/045/046) inform the topology. Phase 5's TS implementation must round-trip with the bash version on the wire if both are running side-by-side during the v2 burn-in.
3. `drive.sh` — driver-side, less coupled to atmux internals; lower risk.
4. `team-migrate-to-cage.sh`, `team-repair-rename.sh`, `tmux-conf-restore.sh` — one-shot maintenance scripts. Port last; possibly defer further if they're operator-only and rarely run.

Each Phase 5 port still goes through the parity harness (against the snapshot) and the per-commit reviewer gate.

### Re-snapshot policy

Phase 5 takes its WIP snapshot **once**, at the moment Phase 5 lead spawns the porter pair. Subsequent bash main-checkout edits during Phase 5's run do **not** retro-update the snapshot. If the bash author asks "did you incorporate my latest super-tell change?" the answer is "Phase 5 froze on commit `<snapshot-sha>`; that change rides v3 unless escalated."

If a critical bug fix lands in bash WIP during Phase 5 (e.g., security issue), lead rolls a new snapshot via explicit ADR amendment, not silent re-sync.

## Consequences

**Positives:**
- Phase 1–4 has bounded scope. The 30-verb surface is stable for the parity harness.
- Phase 5 ports a defined snapshot, not a moving target — divergence in the harness during Phase 5 is a real bug, not WIP drift.
- The bash author keeps iterating freely without coordination overhead with the port team during Phases 1–4.
- v2 (Phase 6) closure has a clear definition: WIP-as-of-Phase-5-snapshot ported + verb redesign per ADR-014 done.

**Negatives:**
- v1 ships missing modules that some operators may already use in unfinished form on their bash atmux installs. Mitigation: bash binary stays as `atmux-legacy` for the 4-week rollback window (ADR-011), and operators using WIP-bash modules just keep using `atmux-legacy <verb>` until v2.
- A subset of bash WIP may never get ported if it's been deleted/reverted by the time Phase 5 takes its snapshot. Acceptable — that's bash author's prerogative.
- v3 backlog accumulates (post-Phase-5 bash WIP). Tracked as a post-v2 kanban task, not a v2 blocker.

**Follow-up tickets:**
- Phase 5 spawn ADR (lead writes when Phase 5 starts) records the snapshot SHA + the working-tree state at that moment, so v3 has a clear delta to chase.
- Operator FAQ entry (Phase 4 release notes): "I'm using `super-whip` on bash atmux — what happens at v1 cutover?" Answer: keep using `atmux-legacy super-whip`; v1's cutover doesn't remove `atmux-legacy`. v2 ships TS `super-whip` (Phase 5 port).
- Watch `/root/work/src/atmux/lib/` for new WIP files added between Phase 0 and Phase 5 start. Lead does a "WIP inventory delta" check at Phase 5 spawn so the snapshot list isn't stale.

## Alternatives considered

### A. Port everything (committed + WIP) in Phase 2

Rejected. Doubles Phase 2 LOC (~3500 → ~6000+ when WIP modules are accounted for), turns the parity harness into a chase-the-tail exercise, and binds the port's release to whenever the bash author finishes the "super" experiment. Bash WIP isn't even self-consistent at this moment (`super-status` references functions that don't exist in `super-tell` yet), so a port would be guessing at intent.

### B. Wait for bash WIP to land at HEAD before starting any of Phase 5

Rejected for the symmetric reason: this could mean Phase 5 waits indefinitely (the "super" namespace has been WIP for ~6 months at the time of this ADR). The snapshot rule resolves this by letting Phase 5 freeze whatever's there *when it's ready* and treating subsequent drift as v3 work.

### C. Coordinate with the bash author to land all WIP before the port starts

Rejected. The Bun port team is internal to the project but the bash author's roadmap is independent — atmux is single-author + assistants, and "land everything" isn't a meaningful coordination event. The author iterates as new patterns emerge.

### D. Port WIP as a parallel side branch from day 1, merge in Phase 5

Considered. Would let the "super" namespace mature alongside Phase 1–4. Rejected because: (1) it doubles porter-foundation's load (they'd be tracking two specs), (2) the parity harness can only validate against committed bash, so the side-branch couldn't be properly gated, (3) merging in Phase 5 would need conflict resolution against whatever Phase 1–4 produced — not a clean rebase. Cleaner to sequence the work.

## References

- PLAN.md §2 (in-scope vs out-of-scope at HEAD `2aadc3f`)
- PLAN.md §5 (Phase 5 owners + Phase 5→6 sequencing)
- PLAN.md §11 (risk row: "Bash WIP keeps moving")
- PLAN.md §13.2 (v2 closure definition; anti-pattern guard against tearing team down at v1)
- PLAN.md §14 (Phase 4 → Phase 5 transition: "no external wait — port from main checkout's working tree")
- ADR-011 (cutover protocol — `atmux-legacy` rollback window covers operators using WIP-bash modules)
- ADR-014 (verb design debt — Phase 6 sequencing depends on Phase 5 finishing first)
- CLAUDE.md "structural honesty over demo narrative"
