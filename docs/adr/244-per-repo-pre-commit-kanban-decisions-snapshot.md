# ADR-244: Per-repo pre-commit kanban + decisions snapshot — machine-death backup via git

**Status**: Accepted — ratified by operator 2026-05-26 18:05 MYT (live operator-design session)
**Date**: 2026-05-26
**Driver-ref**: operator-direct 2026-05-26 — "i want a way to store snapshots of our kanban (like a json dump) so that we can persist our kanban on git just in case machines die... sqlite isn't git commited correct?" → iteration through cron / lefthook / husky / bare pre-commit → final ask: "then file that adr and do the recommends"
**Cross-refs**: [ADR-008](008-decisions-add.md) (decisions log + digest), [ADR-060](060-kanban-sqlite-canonical.md) (kanban SQLite as source-of-truth), [ADR-079](079-cron-cadences.md) §A (daily `groom` cron — 30-day default cutoff keeps `.atmux/decisions.md` bounded), [ADR-202](202-honker-in-db-messaging-substrate.md) (DB messaging substrate — same `.atmux/state/` directory), [ADR-239](239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) (5-driver floor — driver worktrees per repo, this ADR fires per-repo too)

## Context

Atmux's runtime state lives at `.atmux/state/` per team-cage — SQLite databases (kanban, complaints, refusal events, merger state), JSON files (account-swap state, budget probes, brief versions), and the append-only markdown `decisions.md` log (ADR-008). All of it is `.gitignore`'d by default — the existing rule is `.atmux/*` with a single carve-out for `!.atmux/team.json` (team config only).

**Failure mode this ADR addresses:** the hax box dies and the on-disk `.atmux/` state for every running team is lost. The team.json roster + ADRs survive (in git); the kanban (epics + tasks + claims + completion timestamps) + the decisions log (lead/planner-recorded rationale at decision points) are GONE. Recovery shape today is "rebuild from scratch + remember what we were working on" — error-prone, lossy.

**Operator goal (2026-05-26 18:05 MYT):** make machine-death recoverable. Periodic git-committed snapshots of kanban + decisions so a fresh box can `git clone + atmux start` and pick up where the dead box left off.

**Constraints surfaced during the design pass:**

1. **Per-repo, not centralized.** Each parent team's kanban + decisions live in that team's repo (`/root/work/ifca/src/sopx-root/.atmux/`, `/root/work/unum/src/root/.atmux/`, etc.). The snapshot logic must fire IN THAT REPO at commit time — atmux's own repo can't centrally know each team's state.
2. **No cron.** Operator-explicit rejection: *"i just don't want cron firing for all epic teams it'll be inefficient"*. Epic-teams are per-cage; a cron per epic-team across N teams ×  K cages = N×K cron lines fighting for the SQLite read lock + emitting noisy commits. Pre-commit fires only on real activity — that's the entire cadence story.
3. **Lean.** Operator-explicit *"is it a lean mean way of doing this or is there a better way?"* — drove the design from "exporter verb + JSON deserializer + recovery verb" (the original pitch) down to "just commit the SQLite binary + the markdown log, no new verbs, no exporters".
4. **No new dependencies.** Husky / lefthook considered + rejected — bare `.git/hooks/pre-commit` + a checked-in install script is leaner. Lefthook is overkill until there are multiple hook stages running in parallel or multiple devs needing synced config; neither applies here.

## Decision

### D1 — Pre-commit hook commits kanban.sqlite + decisions.md alongside whatever else is in the firing commit

A `.git/hooks/pre-commit` shell hook fires on every commit in every parent team's repo. It:

1. Forces a WAL checkpoint on the kanban SQLite so the main `.sqlite` file is self-consistent without the `.sqlite-wal` / `.sqlite-shm` sidecars: `sqlite3 .atmux/state/kanban.sqlite 'PRAGMA wal_checkpoint(TRUNCATE);'`. Best-effort — if sqlite3 is absent or the DB doesn't exist yet, the hook continues (failure to checkpoint must not block commits).
2. Force-adds the checkpointed `.atmux/state/kanban.sqlite` + the current `.atmux/decisions.md` + any rolled archive files under `.atmux/decisions/` to the firing commit: `git add -f .atmux/state/kanban.sqlite .atmux/decisions.md .atmux/decisions/ 2>/dev/null || true`.
3. **Best-effort throughout** — every line ends in `|| true`. A snapshot failure NEVER blocks the underlying commit. The whole feature exists to provide a backup safety net; failing the firing commit because the snapshot has a hiccup would defeat the safety frame (operator loses their actual code change too).

Hook is a single shell script, ~10 lines of executable code total.

### D2 — `.gitignore` carve-outs make the snapshot files git-trackable

Today's `.gitignore` excludes `.atmux/*` with a single `!.atmux/team.json` exception. This ADR extends the exception list:

```gitignore
.atmux/*
!.atmux/team.json
!.atmux/state/kanban.sqlite
!.atmux/decisions.md
!.atmux/decisions/
!.atmux/decisions/**
```

**Specifically NOT carved out:** transient state (lock files, JSON caches like `account-swap.json`, `budget-probe-*.json`, debounce state, cost telemetry, `.json.lock` siblings). Those churn constantly + carry no recovery value — leaking them into git would produce torrents of pre-commit noise without any backup benefit. The strict allowlist above keeps the noise floor at zero.

### D3 — Bounded growth via existing `groom` mechanism (no new code)

`.atmux/decisions.md` is append-only — it grows monotonically. Without a bound, the file would balloon over project lifetime + every pre-commit would diff a growing file.

**Atmux already solves this via ADR-079's daily `groom` cron** (`src/core/groom.ts:594`): decisions older than `--decisions-days N` (default 30) are MOVED to monthly archive buckets at `.atmux/decisions/decisions-YYYY-MM.md`. The live `.atmux/decisions.md` stays bounded at "last ~30 days of entries" — small + recent + churns often (ideal git case: tiny diffs per commit). Archives are also markdown + git-friendly + COLD (only touched once per groom run, so most commits don't touch them at all).

Same pattern for kanban via ADR-079 + `groom.ts:663` sub-op (done/cancelled tasks roll into `kanban-summary.md` on a per-month basis). `.atmux/state/kanban.sqlite` therefore grows in WORKING-SET (rows-in-flight) terms, not lifetime-history terms — bounded by team velocity, not by elapsed time.

**Tune verification (2026-05-26):** the existing default `decisionsDays: 30` (`src/verbs/groom.ts:94`) is the right cut. Smaller (e.g. 7) would archive too aggressively + lose recent context inside the live file; larger (e.g. 90) would let the live file accumulate ~270 entries (~2700 lines) before rotation, which is still git-fine but starts to feel heavy in editors. **No change needed.**

### D4 — Installation via checked-in `scripts/install-hooks.sh`

`.git/hooks/` is NOT tracked by git — it's per-clone local. Therefore the hook must be checked in elsewhere (under `scripts/` or `hooks/` in the repo root) and a one-line install script symlinks/copies it into `.git/hooks/pre-commit` on a fresh clone.

This ADR ships:

1. `scripts/atmux-snapshot-pre-commit.sh` — the actual hook source, checked-in + reviewable. Idempotent.
2. `scripts/install-hooks.sh` — one-shot installer. Symlinks (preferred) or copies (fallback) `scripts/atmux-snapshot-pre-commit.sh` to `.git/hooks/pre-commit` + `chmod +x`. Refuses if `.git/hooks/pre-commit` already exists with non-matching content (operator-managed hook present — refuse rather than clobber).

Each parent team's repo runs `bash <atmux-repo>/scripts/install-hooks.sh` once per fresh clone. Future enhancement (deferred): `atmux init` runs the installer automatically as part of bootstrap. For this ADR the install is manual + explicit (operator knows when the hook arms).

### D5 — Scope: parent teams only; epic-teams ride on parent

Per ADR-090 epic-teams (`src/<product>-epics/e-*/`) are separate cages with their own `.atmux/state/`. But their worktrees live UNDER the parent repo's tree — commits made inside an epic-team's worktree are commits TO THE PARENT REPO. Therefore:

- Parent repo's `.git/hooks/pre-commit` fires on every commit, regardless of which worktree (parent or epic-team) the commit was authored from.
- The hook captures the PARENT repo's `.atmux/state/kanban.sqlite` + `.atmux/decisions.md` — which is the parent team's state, not the epic-team's.
- **Epic-team's own kanban + decisions are NOT snapshotted by this ADR.** Their state-files (under `src/<product>-epics/e-*/.atmux/`) remain gitignored + ephemeral.

**Operator-accepted gap:** epic-teams are ephemeral by design (ADR-090 §dissolve-epic). When an epic-team dissolves, its state goes anyway. Persistent state belongs at the parent level. If a long-running epic-team needs its own backup, this ADR's pattern is trivially copyable into the epic-team worktree's own `.git/hooks/pre-commit` — but that's a per-epic-team operator decision, not a default.

### D6 — Restore path: `cp` + `atmux start`

No new "import" verb. Restore is:

```bash
# On fresh box:
git clone <repo>
cd <repo>
# .atmux/state/kanban.sqlite + .atmux/decisions.md restored automatically.
atmux start <team>  # cage comes up, reads existing state, continues from snapshot.
```

That's the entire recovery story. The SQLite file is byte-identical to what was checkpointed at last-commit time on the dead box; atmux's existing read path opens it without ceremony.

**Edge case** — if the last commit was mid-transaction, the WAL checkpoint at pre-commit time would have rolled forward any uncommitted SQLite txn into the main file (TRUNCATE mode discards the WAL after merge). So the worst-case data loss is the diff between "last `atmux` operation that committed via SQLite" and "last git commit that fired the hook" — usually seconds to minutes, depending on commit cadence.

## Consequences

### What changes

- `.gitignore` extends carve-outs by 4 lines (D2).
- New files: `scripts/atmux-snapshot-pre-commit.sh` + `scripts/install-hooks.sh` (D4).
- Per-repo manual install once: `bash <atmux-repo>/scripts/install-hooks.sh` in each parent team's repo root.
- Commits in instrumented repos automatically carry the latest kanban.sqlite + decisions.md state.

### What breaks

- **Nothing** in atmux's own behavior — the hook is best-effort, every line is `|| true`, failures never block commits.
- **PR review noise** — kanban.sqlite diffs as "binary file changed" on every commit. Reviewers learn to ignore that line (or use `git log --stat -- '.atmux/state/kanban.sqlite' ':!...'` to filter). decisions.md changes ARE readable + may show up in PR diffs; operators learn to treat them as additive context, not as code-review surface.
- **Repo size growth** — kanban.sqlite is typically <1MB; even 1000 commits worth of binary deltas stays under 100MB pack size with reasonable repacking. Decisions.md + archives grow O(decisions logged) — ~10-30 lines/day per team => ~5-15MB over 5 years, all text, highly compressible.

### What we give up

- **Cross-machine merge.** If two boxes commit kanban.sqlite simultaneously, the resulting merge conflict is unresolvable inline (binary file). Per operator framing this is a single-machine setup; multi-machine sync would need a different design (e.g. periodic JSON export — see ADR-244-followup-if-multi-machine).
- **Diff-readable kanban history.** Cannot `git log -p .atmux/state/kanban.sqlite` to see "what claims happened between SHA1 and SHA2" — must checkout + `sqlite3 ... 'SELECT ...'`. Accepted trade for the leanness win; if this becomes a real workflow, add a derived JSON-snapshot verb later (deferred to future ADR).

### Rollback path

Revert the commits that add the hook + gitignore carve-outs. Existing `.git/hooks/pre-commit` symlinks can be `rm`'d per repo. No code path inside atmux references the snapshots — they're a backup substrate, not a runtime dependency.

## Decision-anchors

- **DA1 ↔ D1**: pre-commit hook commits the snapshot — operator ask "maybe husky pre-commit" + confirmation "per repo definitely"
- **DA2 ↔ D2**: gitignore carve-outs allowlist the recovery-relevant files only — derived from operator concern about noise + the existing `!team.json` pattern
- **DA3 ↔ D3**: bound growth via existing groom — operator question *"wouldn't the log keep growing?"* + verification that ADR-079's 30-day default already solves it
- **DA4 ↔ D4**: bare hook + checked-in install script (no husky/lefthook) — operator ask *"is it a lean mean way of doing this or is there a better way?"* + analysis showing lefthook is overkill for one-line single-stage hooks
- **DA5 ↔ D5**: parent-only scope — operator ask "i just don't want cron firing for all epic teams it'll be inefficient" + structural fact that epic-team commits land in parent repo anyway
- **DA6 ↔ D6**: restore = `cp` + `atmux start` (no import verb) — derivative of D1's "commit the binary directly" choice

## Open questions

1. **OQ1**: Should `atmux init` auto-run `install-hooks.sh` for new teams? **Lean**: yes, after this ADR ships + the hook is proven stable. Deferred to a follow-up — this ADR ships the manual install + the explicit verification path.
2. **OQ2**: Should other SQLite tables (complaints, refusal_events, merger_state) get the same carve-out? **Lean**: no — kanban is the load-bearing state operators actually want to recover; the others are mostly observability + reconcilable from kanban + decisions. Add carve-outs incrementally if + when a specific table's loss becomes a real recovery gap.
3. **OQ3**: Should the hook also fire on `post-merge` (after `git pull`) to refresh the local kanban from a fresh remote snapshot? **Lean**: no — `atmux start` already reads `.atmux/state/kanban.sqlite` at cage bootstrap, so pulling + restarting picks it up naturally. Adding post-merge would create double-read paths.
4. **OQ4**: Should the snapshot include a tiny `.atmux/snapshots/snapshot-meta.json` recording `{ snapshotted_at, sha_before_commit, atmux_version }`? **Lean**: yes for forensics (cheap addition) — deferred to follow-up so this ADR ships minimal-viable. Operator can ask later.
