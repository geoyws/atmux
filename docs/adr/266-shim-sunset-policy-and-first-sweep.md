# ADR-266: Shim sunset policy + first expired-shim sweep and retired-role dead-code removal

**Status**: accepted
**Date**: 2026-07-28
**Driver-ref**: George 2026-07-28 — "let's try to keep atx short and sweet and not bloated... yes do all" (retired-role audit → delete pass; shim sunset policy + first sweep).
**Relates**: [ADR-133](133-medic-rename.md), [ADR-135](135-cockpit-naming-convention.md), [ADR-159](159-gitter-to-committer-rename.md), [ADR-160](160-whip-to-poke-rename.md), [ADR-213](213-retire-jury-reviewer-absorbs-acceptance-criteria.md), [ADR-224](224-orchd-rename-and-auto-spawn-loop.md), [ADR-235](235-cockpit-verb-surface-rationalization.md), [ADR-239](239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) — all established one-release deprecation windows that were never enforced. [ADR-264](264-cockpit-session-atx-rename.md) shims are brand new and explicitly **kept**.

## Context

atx accumulated deprecation shims that never got sunset: 81 src files mention legacy/deprecated/migration-shim, and multiple shims say *"Accepting this release; will fail next release"* — written 2026-05-14→24, still present at v0.8.30, ~25 releases past expiry. A full audit (2026-07-28, import-chain-traced from `src/cli.ts`) also found genuinely dead modules with zero live importers. Historical shims cost concept-load ("which name is real?"), test surface, and read-time friction — the opposite of "short and sweet".

Two false alarms the audit ruled OUT (kept, load-bearing): the `src/core/whip-*.ts` modules (except `whip-escalation.ts`) are live via `poke`/`orchd`/`doctor`; the `_medic` window + `medic` cockpit block + ombudsman verb remain live because their retirement ADRs (212/214/237) never completed cutover conditions or are still Proposed.

## Decision

### (D1) Sunset policy — going forward

Every deprecation shim MUST ship with an explicit expiry — a version or date — and a `SUNSET(<version-or-date>):` marker comment at the shim site so sweeps can grep for it. A shim without a marker is a bug. When the expiry passes, the shim is deleted in the next release; parse-affecting shims become a hard, actionable error first (naming this ADR) where the expired contract already promised failure. "Multi-release migration window" without a number is not an expiry — authors must pick one.

### (D2) First sweep — expired shim removal (all 8–25 releases past expiry)

- **CLI aliases**: `gitter` (ADR-159), `relayd` (ADR-224), `whip` + `whip-resume-check` (ADR-160) removed from `src/cli.ts`; `whip` row dropped from `atmux help`; committer `--daemon`/`--drain` aliases (ADR-224) removed from `src/verbs/orchd.ts`.
- **`cockpit rebuild` alias** (ADR-235 §OQ4) removed; canonical subverb stands.
- **ADR-133 superdoctor→medic shims**: `migrateSuperdoctorBlockToMedic` + dual-key legacy-shape branch (`src/core/cockpit.ts`), `CockpitSuperdoctor`/`SuperdoctorSession`/`Cockpit.superdoctor` (`src/schema/cockpit.ts`), `status.ts` `superdoctor` JSON mirrors and aliases. The two live legacy readers (`src/verbs/start.ts`, `src/verbs/status.ts` — `cockpit.medic ?? cockpit.superdoctor`) drop the `?? superdoctor` fallback. Configs still carrying a `superdoctor` block now fail with an actionable error pointing here.
- **`gitter`→`committer` role-literal Zod transform** (`src/schema/team.ts`) removed (ADR-159 window long past).
- **`Tier4NotAvailableError`** (`src/abstractions/fallback-cage.ts`) removed (ADR-050 one-cycle retention, expired).
- **Legacy `driverSession`/`driverTui` fallback** (`src/core/drivers.ts`, `src/verbs/start.ts`) removed (ADR-239 §D7 window past).

### (D3) Dead-code removal (zero live importers, audit-verified)

- `src/core/whip-escalation.ts` — ADR-177's wire-up landed via `velocity-gate.ts`; `maybeEscalateStrikes` never called.
- `src/core/superdoctor-cage-verdict.ts` — claimed consumer (`audit.ts`) never referenced it.
- `src/core/repositories/superdoctor-attempts-repo.ts` + `src/schema/superdoctor-attempts.ts` — no importers; the underlying SQL tables stay (raw-SQL readers in live `superdoctor-activity.ts`).
- `story.jury.ratified|pending|verdict|escalated` orphan event topics (`src/schema/events.ts`) — ADR-213 §D5 ordered removal; no emitters/consumers.
- Tests covering the above are deleted with them; stale comments pointing at deleted modules are fixed.

### (D4) Explicitly kept

- **All ADR-264 `atx` shims** (cockpitSession coercion, rename-session migration, doctor probe literals) — brand new, sunset marker per D1 set to **v0.9.0**.
- `src/core/common.ts` window-name legacy-form acceptance (`buildWindowNameLegacy`, `resolveExistingWindowName`, `renameToCanonical`) — live sessions can still carry pre-ADR-135/161 window names; reviewed separately, not this sweep.
- `__superdoctor__` inbox alias (`send.ts`, `common.ts`) — data-coupled (in-flight rows in existing state.dbs); needs a migration story, not a blunt delete.
- `--by superdoctor` complaint literal — reads of historic rows keep working forever (TEXT column); write-side allowlist entry stays until a data audit shows no live filers.
- Everything §KEEP of the audit: live `whip-*` modules, `_medic` window + config, ombudsman verb + schema, superdoctor storage tables + hygiene + activity.

### (D5) Doc-drift fixes in the same pass

- `CHANGELOG.md` `[Unreleased]` entry claiming "Medic narrowed to on-demand `atmux medic diagnose <team>` per ADR-212" describes never-implemented code (`src/verbs/medic.ts` does not exist) — corrected to describe actual state.
- `src/verbs/help.ts` stops advertising `whip`.

## Consequences

- ~700 LOC of verified-dead modules + several hundred more of expired shim code removed; concept surface shrinks (no more "is it whip or poke / gitter or committer / rebuild or reconcile").
- Breaking for configs/aliases past their promised expiry — by design; each removal's error or changelog line names this ADR.
- The sunset policy makes this the last ad-hoc sweep: future shims carry machine-greppable expiry.
- **Out of scope**: the `_medic`/ombudsman retirements proper (blocked on ADR-212/214/237 cutover conditions), the `__superdoctor__` inbox data migration, the window-name legacy-form review, and the 102 bash-era `tests/unit/*.bats` harnesses.

## Cross-references

- The eight ADRs listed in the header (their unenforced windows are executed here).
- [ADR-264](264-cockpit-session-atx-rename.md) — its shims are the first to carry a D1-style sunset marker (v0.9.0).
