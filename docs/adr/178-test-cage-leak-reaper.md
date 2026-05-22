# ADR-178: Test-cage leak reaper — spinTmux sidecar + `atmux test-reaper` verb

**Status**: proposed (deferred: impl not yet shipped; `atmux test-reaper` verb absent + no `src/core/leak-tracker*` module as of 2026-05-22 audit. Original ratification 2026-05-21 was bookkeeping-batch — see §Amendment 2026-05-22 below for the surface-vs-impl audit context.)
**Date**: 2026-05-18
**Driver-ref**: complaint c-27a1c8f4 (filed 2026-05-17 by medic; adjudicated by ombudsman 2026-05-17 to atmux team for in-process half; dotfiles half scoped out per `[[feedback_claude_skills_dotfiles_territory]]`).
**Relates**: ADR-018 (per-team tmux socket isolation — same isolation pattern), ADR-058 (cage tiering — test cage is ephemeral Tier-1), ADR-162 (atmux owns its tmux infrastructure — cockpit-socket isolation; same defensive-cleanup discipline applied to tests).

## Context

`tests/unit/verbs/cockpit.test.ts:307-315` (`spinTmux`) `mkdtemps` `/tmp/atmux-cockpit-<prefix>-XXXXXX` and spawns a real tmux server inside. Cleanup contract relies on three JS-level hooks (per inline comment at lines 269-282):

1. Per-test `try/finally` — happy-path cleanup;
2. File-level `afterAll(tearDownFixtureSurvivors)` — catches thrown / rejected paths;
3. `process.on('exit', tearDownFixtureSurvivors)` — catches normal-shutdown paths.

**All three are userland-only.** None fire when:

- `bun test` parent receives SIGKILL (BashTool 2-min timeout per `~/.claude-personal/CLAUDE.md` "bun test orphans survive BashTool timeouts");
- Harness kill (claude pane reset, atmux cage tear-down);
- OS OOM killer (Hetzner box under load).

Result: orphan tmux servers + their zombie claude children survive across test runs. Medic observed 6 orphan servers at `/tmp/atmux-cockpit-cockpit-{reb-sd-depr,reb-sd-nudge×4,sd-autostart-timeout}-XXXXXX` over the 2026-05-14 → 2026-05-16 window, holding ~700MB combined RSS until manual sweep.

The leak is structural to the SIGKILL gap, not a bug in the existing hooks. The fix is an **out-of-process reaper** that doesn't rely on the test process surviving long enough to clean up its own state.

This ADR covers the **in-process half** of complaint c-27a1c8f4:

- (1) `spinTmux` writes a `.leak-tracker.json` sidecar on spawn so an out-of-process reaper can identify orphans without parsing live process state.
- (2) `atmux test-reaper` verb scans the sidecar registry, identifies orphans, and reaps them.

The **out-of-process half** (medic §0-prelude shell sweep at `/root/work/journals/.sb/claude-skills/plugins/coordination/skills/medic/medic-prompt.md`) is dotfiles territory per `[[feedback_claude_skills_dotfiles_territory]]` and is scoped out. The in-process half alone closes the leak; medic prelude is belt-and-suspenders per complaint body.

## Decision

### Sidecar file shape

`spinTmux` writes `<socketDir>/.leak-tracker.json` synchronously after `mkdtemp` returns and before `createTmux` is called:

```jsonc
{
  "tmuxSocket": "<absolute path to socketDir/sock>",
  "socketDir":  "<absolute path to socketDir>",
  "parentPid":  <process.pid at spawn time>,
  "createdAt":  <epoch seconds at spawn time>,
  "testFile":   "<__filename or process.argv[1]>",
  "testName":   "<current bun test name if discoverable, else null>",
  "prefix":     "<prefix arg passed to spinTmux>"
}
```

Sidecar lives **beside the socket** (not under `/tmp/atmux-state/` or similar). Rationale: the reaper globs the socket dirs directly; locating the sidecar via the same path avoids a separate registry-file invariant. `tearDownFixtureSurvivors` deletes the sidecar along with the socket dir (idempotent `rm -rf`), so happy-path runs leave no trail.

### `atmux test-reaper` verb

```
atmux test-reaper [--max-age-min N] [--dry-run] [--prefix P] [--json]
```

| Flag | Default | Meaning |
|---|---|---|
| `--max-age-min N` | 30 | Minimum age before a candidate is reaped. Same-test-run survives; cross-run orphans (>30 min) die. |
| `--dry-run` | false | List candidate reaps without acting. Returns exit 0 + a table to stdout. |
| `--prefix P` | `atmux-cockpit` | Glob `<tmpdir>/${P}-*-*`. Lets future test-cage shapes plug in without changing the verb. |
| `--json` | false | Machine-readable output (used by CI scripts + tests). |

**Reap conditions** (BOTH must hold):

1. `parentPid` from sidecar is **dead** — `kill(pid, 0)` returns `ESRCH` (or the process exists but the cmdline no longer contains `bun test` / `bun run test`, defending against PID reuse).
2. `createdAt` < `now - (max-age-min × 60)`.

**Reap action**:

1. `tmux -S <tmuxSocket> kill-server` (idempotent — exits 0 even if server already dead);
2. `rm -rf <socketDir>` (idempotent).

**Sidecar absent**: dir matches the glob but no `.leak-tracker.json` present → log warn, skip. Reaper does not act on dirs it didn't trace; this is a one-way invariant (sidecar may be deleted before dir; if dir survives without sidecar, it's likely operator-manual fixture).

**Sidecar corrupt** (JSON parse error or missing `parentPid`/`createdAt`): log warn, skip. Surfacing via `--json` output as `status: "corrupt-sidecar"` so a follow-up sweep can decide.

### Invocation paths

| Path | When | Responsibility |
|---|---|---|
| `bunfig.toml` preload | Before each `bun test` run | T4 wires it; auto-reap stale orphans before the new run starts. |
| `scripts/test-ci.sh` step | Before / after CI test ladder | T5 wires it; belt-and-suspenders for SIGKILL-during-CI paths. |
| Manual operator | Ad-hoc sweep | Already covered by the verb signature; documented in `docs/RUNBOOK-tests.md`. |

The verb is **self-sufficient** — no daemon, no cron, no state file beyond the sidecar JSON. Each invocation is a stateless O(N) scan.

### Schema decision: sidecar file vs registry-table

Rejected alternative: write to a single `~/.atmux/state/test-fixture-registry.json` (registry-table shape; sibling to `send-keys-failures.log`).

**Why sidecar wins**:

- Sidecar dies with the dir on happy-path cleanup — zero state-file invariant to maintain.
- No registry-write race when N parallel `bun test` workers spawn fixtures (each writes to its own dir).
- Reaper logic is "glob + parse + decide" — no transactional registry semantics needed.
- Aligns with ADR-058 cage-tiering principle: ephemeral test cages own their own state lifecycle.

## Consequences

| Lane | What changes |
|---|---|
| **test** | `spinTmux` writes `.leak-tracker.json` on spawn (synchronous `writeFileSync`); `tearDownFixtureSurvivors` deletes sidecar alongside socket dir. ~10 LOC delta in `tests/unit/verbs/cockpit.test.ts`. |
| **be** | New verb `src/verbs/test-reaper.ts` + paired test `tests/unit/verbs/test-reaper.test.ts`. ~80-120 LOC + ~150-200 LOC test. |
| **be** | Verb registration: `src/verbs/index.ts` (or wherever the verb-router lives) gains `test-reaper` entry. |
| **ops** | `bunfig.toml` gains `[test] preload = ["./tests/_test-reaper-preload.ts"]` (or equivalent — Bun preload semantics). T4 nails the exact wire. |
| **ops** | `scripts/test-ci.sh` (or wherever the CI test ladder lives) gains a pre-test `atmux test-reaper --max-age-min 30 --prefix atmux-cockpit` call. |
| **docs** | `docs/RUNBOOK-tests.md` (or `RUNBOOK-superdoctor.md`) gains a §test-cage-leaks section pointing at the verb + `--dry-run` for diagnosis. CHANGELOG entry. |
| **db** | None — no state.db schema change. Sidecar is on-disk JSON owned by the test directory. |

**Forward enablement**:

- Other test files using `mkdtemp` + tmux-spawn shapes (TBD — needs T6 audit) can adopt the same sidecar contract.
- The verb's `--prefix` flag means the future "atmux self-test-cage" pattern (mode B from t-97044284 body) can reuse the reaper unchanged.

**Rollback**: drop `bunfig.toml` preload line + remove the verb from CI. Sidecar files become inert; `tearDownFixtureSurvivors` keeps cleaning up on happy paths. No state migration.

## Open questions

1. **OQ1: PID-reuse defense — kill(pid,0) only, or also cmdline-check?** Default: **both** — `kill(pid, 0)` first (fast); if process exists, read `/proc/<pid>/cmdline` and confirm `bun test` substring before SKIPPING reap. Closes the 1-in-32k PID-reuse hole at ~negligible cost. Linux-only (macOS reaper still works, just without cmdline-check — falls back to PID-only on Darwin). Reversibility: **low** — pure-defense add.

2. **OQ2: Sidecar write — sync or async?** Default: **sync `writeFileSync`** at spawn time. spinTmux is already `await mkdtemp` (async), so adding `await writeFile` would compose; but the sidecar must exist before the next test crash window opens. Sync write is one fewer await + closes the race for free. Reversibility: **low**.

3. **OQ3: Max-age default — 30 min, or shorter?** Default: **30 min**. Same-run survives even slow tests (cockpit suite runs <5 min); cross-run orphans die promptly. Operators with shorter test cycles can pass `--max-age-min 5` ad-hoc. Reversibility: **low**.

4. **OQ4: Audit other test files for spinTmux-shape leaks?** Default: **out-of-scope for this ADR**; folded into T6 audit Task (separate scope). Reversibility: **medium** — affects whether the v1 verb deploys with sidecars only at `cockpit.test.ts`, or across the codebase. Recommended decomp: ship the verb + cockpit.test.ts sidecar in v1; audit + roll out to other sites in a fast-follow Task.

5. **OQ5: Verb name — `test-reaper` or `test-cleanup`?** Default: **`test-reaper`** per complaint body's naming. `cleanup` is overloaded (cron, kanban, etc.). `reaper` matches the zombie-process metaphor + is unique in the verb namespace. Reversibility: **low** — rename via deprecation shim if operators push back.

## Sub-tasks (decomposed by planner)

- **T1** — Draft ADR-178 + cross-refs + acceptance criteria *(this file)*. Lane: `misc`. Deps: none.
- **T2** — Extend `spinTmux` in `tests/unit/verbs/cockpit.test.ts` to write `.leak-tracker.json`; update `tearDownFixtureSurvivors` to delete sidecar alongside dir. Lane: `test`. Deps: T1.
- **T3** — New verb `src/verbs/test-reaper.ts` + unit tests `tests/unit/verbs/test-reaper.test.ts` covering: dry-run, age-gate, parent-alive-skip, parent-dead+age-pass, sidecar-missing, sidecar-corrupt, exit codes, `--json` shape. Lane: `be`. Deps: T1.
- **T4** — Wire `bunfig.toml` preload (or equivalent Bun pre-test hook) to invoke `atmux test-reaper --max-age-min 30 --prefix atmux-cockpit`. Lane: `ops`. Deps: T3.
- **T5** — Wire `scripts/test-ci.sh` (or current CI ladder) to call `atmux test-reaper` before + after the test suite. Lane: `ops`. Deps: T3.
- **T6** — Manual e2e: spin a test, `kill -9` the bun process mid-run, run `atmux test-reaper --max-age-min 0 --dry-run` + then real reap; assert socket + dir gone. Also: audit `tests/` for other `mkdtemp(... 'atmux-')` shapes that should adopt the sidecar (out-of-scope for v1 but file follow-up Tasks). Lane: `test`. Deps: T2 + T4 + T5.
- **T7** — Same-commit docs: `CHANGELOG.md` entry; `docs/RUNBOOK-tests.md` §test-cage-leaks (creates the file if absent); cross-link from `docs/superdoctor.md` (or `docs/RUNBOOK-medic.md` if renamed) §0-prelude pointing at the in-process half. Lane: `misc`. Deps: T6.

## Acceptance

- [ ] ADR-178 lands (this file) with reviewer-trunk-signoff path queued.
- [ ] `spinTmux` writes valid `.leak-tracker.json` matching the schema above; sidecar deleted on happy-path teardown.
- [ ] `atmux test-reaper` verb ships with full flag matrix; unit tests green.
- [ ] Manual e2e demonstrates SIGKILL-survivor reap (per T6 acceptance).
- [ ] `bunfig.toml` + `scripts/test-ci.sh` wire fire on each `bun test` run.
- [ ] CHANGELOG + RUNBOOK doc updates same-commit-with-impl per `CLAUDE.md` discipline.
- [ ] Reviewer signs off on verb signature + sidecar shape + reap conditions.

## Out of scope

- Medic §0-prelude shell sweep (dotfiles).
- Audit + rollout of sidecar to non-`cockpit.test.ts` test files (T6 produces follow-up Tasks).
- Cross-host reaper (this is local-only — Hetzner box test cages only).
- Reaper as cron / daemon — verb-only invocation per ADR-058 ephemeral-cage discipline.
- LLM-classifier for orphan-cause-of-death (medic territory).

## Cross-refs

- Complaint c-27a1c8f4 (atmux team adjudication by ombudsman, 2026-05-17).
- `tests/unit/verbs/cockpit.test.ts:269-322` — existing fixture-survivor registry (c-4698c603 defense; same problem, different scope — userland-hooks-only).
- ADR-018 (per-team tmux socket isolation).
- ADR-058 (cage tiering — ephemeral Tier-1).
- ADR-162 (atmux owns its tmux infrastructure — cockpit-socket isolation; sibling discipline at the team layer).
- Global CLAUDE.md `bun test --timeout` discipline (`~/.claude-personal/CLAUDE.md` §Engineering "bun test orphans survive BashTool timeouts").


## §Amendment 2026-05-22 — Status demoted to `proposed (deferred:)` after surface-vs-impl audit

Demoted from `Accepted — ratified by driver 2026-05-21` → `proposed (deferred: impl not yet shipped)` per CLAUDE.md §Source-of-truth chain escape hatch ("Intentionally-held → `Status: proposed (deferred: <reason>)` so ADR-085 surfacer doesn't ping").

**Why the demote**: the 2026-05-21 operator ratification batch (commit `b6d634f` "30 ADRs flipped proposed→accepted") was bookkeeping — clearing the `proposed` marker for ADRs whose impl was understood-to-have-shipped. That sweep folded in ADR-178 + 7 sibling ADRs whose impl was still pending. 2026-05-22 docs audit (via Task `t-b1bd0f9c`, lead-routed `d-7b8d444f-batch` decision) confirms `atmux test-reaper` verb does not exist (`atmux test-reaper --help` → `unknown verb`) and no `src/core/leak-tracker*` module is on disk. The decision contract (spinTmux sidecar `.leak-tracker.json` + verb + reaper logic + bunfig integration) is intact + still the right shape; only the impl is pending.

**Why deferred (not retracted)**: the ADR's substance — `spinTmux` sidecar tracker + `atmux test-reaper` verb invoked from `bunfig.toml` / `scripts/test-ci.sh` — is the right answer to the c-27a1c8f4 complaint (ombudsman-adjudicated 2026-05-17 to atmux team for the in-process half). The proposal stands; the schedule slipped. A future impl-EPIC will close the gap; flipping back to `accepted` happens THEN, not before.

**Original ratification context preserved**: `Accepted — ratified by driver 2026-05-21 (spinTmux sidecar .leak-tracker.json + atmux test-reaper verb for test-cage cleanup; §OQ recommendations as-written)`. The §OQ recommendations in §Decision below remain as-ratified; the demote is a *schedule* signal, not a substance reversal.

**Cross-refs**: `t-b1bd0f9c` (Status-vs-Impl drift audit — this ADR is one of 5 in the Path B cluster; siblings ADR-173/174/183/193); `d-7b8d444f-batch` (lead-recorded decision authorizing close-or-§Amendment per gap-class); CLAUDE.md §Source-of-truth chain (deferred-status escape hatch); `b6d634f` (the originating bookkeeping batch).

**Filed via** t-b1bd0f9c (docs role, 2026-05-22). PoC §Amendment for the Path B cluster — lead spot-review the shape before bulk-applying to ADR-173/174/183/193.
