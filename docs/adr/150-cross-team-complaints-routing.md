# ADR-150: Cross-team complaint storage semantics — target-team-authoritative writes

**Status**: Accepted — ratified by driver 2026-05-21 (`--target-team` becomes authoritative for storage residency; target's state.db gets the complaint row; cockpit-walk lookup per `lookupTeamAtmuxDir`; §OQ recommendations as-written)
**Date**: 2026-05-16
**Author**: atmux team (docs / t-3b65330b)
**Parent EPIC**: t-1ea440e8
**Driver-ref**: 2026-05-15 16:50 MYT driver session — cross-team complaint routing surfaced as a coordination gap during the /bruh sweep planning round.
**Deps**: none (design-leaf entry; no upstream ADRs gate this draft).
**Reviewer**: pre-flag gate before T2–T7 impl tasks dispatch.

## Numbering note

Slot `ADR-150` is the next sequential after [ADR-149](149-eternal-improvement-gating.md) (eternal-improvement gating, proposed). Slots `150-151` were free at planner-decomp time; `152` was reserved for the medic-canary rename (`t-20674483`) and has since been re-allocated to ADR-152 blockers-list per [ADR-152](152-blockers-list-unified-verb.md) §Numbering-shift header; medic-canary moves to next-free-after-155 (likely historical decision number 156 (no surviving ADR file)).

## Context

### The cross-team filing gap

Today every complaint lives in **one** team's `.atmux/state.db::complaints` table — the team where `atmux complaints file` was invoked. When a member on team A files a complaint **about** team B (e.g. team B's reviewer is sitting on a PR that blocks team A's lane), the row lands in team A's DB. Team B's lead can't see it. Team B's ombudsman (per [ADR-147](147-ombudsman-and-release-notes.md)) doesn't drain it. The intended recipient never gets the signal.

The workaround today is **human-routed text** (driver pings team B's lead, "go look at team A's complaints"). That breaks on overnight / cross-timezone gaps and doesn't survive driver rotation.

### The seven-surface coordination fleet (where this ADR fits)

| ADR | Role |
|---|---|
| **ADR-150** (this ADR) | **cross-team complaint storage semantics** — `--target-team` becomes authoritative for row residency |
| ADR-151 unblocker (proposed) | drains the consolidated blocker signal per team |
| ADR-152 blockers list (proposed) | inventory — `complaints` (status=open) is one of 7 surfaces |
| ADR-153 auto-promotion (proposed) | R1 auto-files complaints into local DB; future cross-team R1 reuses ADR-150's primitive |
| ADR-154 storage port (proposed) | substrate for markdown surfaces |
| ADR-155 pane-state verb (proposed) | volatile observability |

ADR-150 is the **routing primitive** for the coordination fleet. Once it ships, ADR-153 R1's "cross-team R1" (currently §Out of scope) becomes a thin wrapper.

### Existing substrate to reuse (don't re-design)

- **Cockpit recursive sessions** ([ADR-089](089-hierarchical-cockpit.md)) — `Cockpit.sessions[]` recursive shape with DFS walk (`src/core/cockpit.ts::walkSessions` + `enabledTeams`). Already operates on every team in the fleet via depth-first traversal. ADR-150 reuses this; no new walker needed.
- **Complaints schema** ([ADR-077](077-superdoctor-cockpit-role.md) §D5 + [ADR-133](133-medic-rename.md) rename) — `complaints` SQLite table is per-team. Existing columns: `id`, `opened_at`, `opened_by`, `summary`, `source_kind`, `target_team`, `status`, `extra`. The `target_team` column already exists for the cross-team RECEIVED side. What's missing is the **storage routing**: a complaint with `target_team='B'` filed from team A's worktree today still lands in team A's DB.

ADR-150 is a **policy decision + schema addition + verb behaviour change** built on top of these primitives. The architectural pieces all exist; the routing rule is what's missing.

## Decision

### (D1) `--target-team` becomes AUTHORITATIVE for storage residency

`atmux complaints file --target-team <t> [--summary …] [--source-kind …] […]`:

- When `--target-team <t>` is set and `<t>` resolves to a team in the cockpit registry:
  - Resolve target's `atmuxDir` via `lookupTeamAtmuxDir(<t>)` (§D5).
  - Open `<atmuxDir>/state.db`.
  - INSERT the complaint row into the TARGET team's `complaints` table.
  - Set `origin_team = <filer-team-name>` on the inserted row (§D3).
- When `--target-team` is absent: **current behaviour preserved** — row lands in the filer's DB, `origin_team` stays `NULL` (column default), `target_team` stays `NULL` (existing semantics). Backward-compat path.

**Pre-flag #1 lock-in (no bidirectional / replication writes)** — the row exists in EXACTLY ONE database (the target's). No mirror copy in the filer's DB. Anyone debugging "where did my complaint go?" uses the `--sent-by-me` selector (§D4) or walks the cockpit registry manually. The filer-side audit-trail is deliberately optional; dual-writes would introduce drift (one DB has the row, the other doesn't, or worse, they have it with different `status` values) and the failure mode is structurally hard to detect. Single source of truth is the cheaper invariant.

### (D2) `origin_team` schema addition

```sql
ALTER TABLE complaints ADD COLUMN origin_team TEXT NULL;
```

- **Nullable** by schema. Existing rows (pre-migration) stay `origin_team=NULL`; backward-compat for `atmux complaints list` reads of legacy data — no `WHERE origin_team IS NOT NULL` predicates added to read paths.
- **Forward-only migration** via the existing `src/abstractions/sqlite-migrations.ts` framework (incremental schema version bump, additive column add). No rollback path required — dropping the column is reversible by hand if ADR-150 ever yanks; row data isn't lost (`origin_team` is leaf-additive).
- **Zod schema** in `src/schema/complaints.ts`: `origin_team: z.string().nullable().optional()` — added at the same leaf strictness level as the existing `target_team` field. Drift detection via `.strict()` at the schema root preserved.

**Pre-flag #4 lock-in (nullable default)**: `origin_team` is NOT required-when-`--target-team`-set at the schema level. Cockpit-aware verb sets it; raw DB writes (test fixtures, manual SQL inserts, future migrations) may not. Schema stays nullable for forward-compat. Reviewer-side gate is: if `--target-team` is set AND `origin_team` is NULL on the inserted row, that's a verb-layer bug (the filer-side wrapper failed to read `team.json::name`); not a schema-rejection case.

### (D3) `origin_team` resolution at filing time

The verb-layer wrapper (`src/verbs/complaints.ts` or sibling) resolves `origin_team` as follows:

1. Read the **filer's** `team.json::name` via the existing `loadTeam(atmuxDir)` helper.
2. If `--target-team` is set: set `origin_team = <filer-team.name>` on the INSERT row.
3. If `--target-team` is absent: set `origin_team = NULL` (column default; explicit-NULL keeps backward-compat for legacy readers).

Edge: filer's `team.json` missing OR `name` unparseable → fall back to `origin_team = NULL` with a `stderr` warning (`origin_team unresolvable: filer team.json missing/malformed; row filed with origin_team=NULL`). Don't refuse the filing — the complaint signal is more valuable than the audit-trail field; degraded audit-trail beats lost signal.

### (D4) Listing semantics — three views

```
atmux complaints list                              # default: received
atmux complaints list --sent-by-me                 # filer audit: outgoing across fleet
atmux complaints list --target-team <t>            # explicit-target filter (existing)
```

- **Default `atmux complaints list`** — reads complaints from CWD's `state.db`. Returns rows REGARDLESS of `origin_team` (rows received by current team — what the local lead / ombudsman cares about).
- **`--sent-by-me` selector** — walks the cockpit registry (per §D5), reads each team's `state.db`, surfaces rows where `origin_team === <current-team-name>`. Operator-debug path for "where did my complaint go?".
  - **Flag-name reservation**: `--sent-by-me` is the v1 canonical. Lane=BE may pick `--outgoing` as a sibling alias when T5 ships; either resolves to the same selector predicate. Avoid `--from-me` (confuses with `--source-kind`).
- **`--target-team <t>` selector** — existing pre-ADR-150 behaviour preserved. Filters rows in CWD's `state.db` by `target_team` value. Post-ADR-150 it remains a local read (it doesn't walk the fleet); operators who want fleet-wide `target_team` view chain with `--sent-by-me` (or wait for the explicit cockpit-aware aggregate view, §Out of scope).

### (D5) Cockpit-registry lookup — new helper

```ts
// src/core/cockpit.ts (or sibling)
export function lookupTeamAtmuxDir(
  cockpit: CockpitShape,
  targetTeamName: string,
): { atmuxDir: string } | { error: "not-found" } | { error: "ambiguous"; matches: number };
```

- Walks `Cockpit.sessions[]` recursively via the existing `walkSessions` DFS (per ADR-089 §B).
- Returns the **first DFS-match** when exactly one team's `name === targetTeamName`.
- **Pre-flag #5 lock-in (refuse-on-multi-match)**: when DFS finds **more than one** team with the same name, return `{error: "ambiguous", matches: N}`. The verb-layer surfaces this as a refusal: `atmux complaints file: target team '<t>' is ambiguous (N matches in cockpit registry); rename one of the duplicates or specify by session path (deferred)`. Silent first-pick is rejected — duplicate team-names across nested sessions is an operator config error; routing to one duplicate while the operator expected the other would silently mis-deliver. Refuse-on-ambiguity is the safer invariant; cost is a clear error message vs a silent mis-route.
- **Not-found path**: returns `{error: "not-found"}`. Verb-layer refuses with `atmux complaints file: target team '<t>' not found in cockpit registry; check ~/.atmux/cockpit.json sessions[].teams[].name`.

**Pre-flag #3 lock-in (O(N) walk is cheap)**: walking N teams (tens-of-N at fleet scale) once per filing is one SQLite-open + one schema-lookup per team. Sub-millisecond at v1 fleet sizes (~20 teams cockpit-wide). If the fleet grows to hundreds of teams, revisit with a fleet-wide complaints index (out of scope; separate EPIC).

### (D6) Resolve-walk semantics

`atmux complaints resolve <id> [--note <n>]`:

1. **First attempt** — read CWD's `state.db` for complaint `<id>`; if found, resolve in place.
2. **Fallback** — walk cockpit registry (DFS via `walkSessions`); for each team, attempt to read `<id>` from that team's `state.db`. First-match wins; resolve in place.
3. **Refuse** if not found in any team's DB: `atmux complaints resolve: complaint '<id>' not found in any team's state.db across cockpit registry`.

**Pre-flag #2 lock-in (no globally-unique-ID-by-prefix)**: do not reserve ID-namespace bits for routing (e.g. `c-A-XXX` for team A, `c-B-XXX` for team B). Resolve-walk is cheap (§D5 rationale); ID uniqueness is preserved by `UUID-v4`-style generation regardless of team residency. Cross-team ID collision probability at v1 scale is negligible; collision detection is the second-match-during-walk path (resolve aborts with `complaint '<id>' present in multiple teams' DBs (N matches); cockpit config error or UUID collision; manual cleanup required`).

### (D7) Permission model — open in v1

**Any team may file against any other team.** No `team.json.complaints.acceptFrom` allowlist in v1. Rationale: the current attack surface is the operator's own multi-team cluster; trust is implicit at the cockpit-registry boundary. A future ADR may add per-team accept-from allowlists when the operator runs multi-tenant clusters with weaker trust assumptions.

### (D8) Singular alias `atmux complaint` — deferred to T7

**Pre-flag #6 lock-in (alias deferred)**: operator typing friction with `atmux complaints file …` (the plural form is awkward for the singular operation) noted in the EPIC body. A singular alias `atmux complaint file …` (delegating to the same verb-layer) is an optional sub-task T7 (lane=BE). **Do not block T1 ADR acceptance on this** — it's UX polish, not load-bearing. The plural canonical name stays; the singular alias is leaf-additive and reversible.

### (D9) Pre-flag synthesis (6 pre-flags folded into above)

For reviewer cross-check:

1. **No bidirectional / replication writes** — §D1 + lock-in paragraph; ✅ folded.
2. **No globally-unique-ID-by-prefix; resolve-walk is the lookup** — §D6 + lock-in paragraph; ✅ folded.
3. **Cockpit-registry walk = O(N) cheap** — §D5 lock-in paragraph; ✅ folded.
4. **`origin_team` nullable; not required-at-schema-level** — §D2 + §D3 + lock-in paragraph; ✅ folded.
5. **Refuse-on-multi-match in cockpit walk** — §D5 lock-in paragraph; ✅ folded.
6. **Singular alias deferred to T7 (UX polish, not load-bearing)** — §D8 explicit deferral; ✅ folded.

## Consequences

**Positive**

- Cross-team complaints route to the **intended recipient's DB** without human relay — team B's ombudsman drains team A's complaints about team B on the next tick.
- Reuses the cockpit recursive-sessions primitive (ADR-089) — zero new walker; one new helper (`lookupTeamAtmuxDir`).
- Backward-compat preserved: filing without `--target-team` works exactly as today; existing rows parse unchanged; `--target-team` selector keeps local-read semantics.
- Single-source-of-truth (no bidirectional writes) means debugging "where is the row?" has a deterministic answer: `--sent-by-me` lists every row this team filed across the fleet.
- Foundation for ADR-153 R1 cross-team extension and any future cross-team coordination ADR.

**Negative**

- Filer no longer has the row in their own DB by default — adds one cockpit-walk operation to the audit-trail UX (`--sent-by-me`). Mitigation: clear flag name + tab-completion (when atmux ships shell completions); operator habit forms within a few uses.
- Refuse-on-multi-match (§D5) refuses filings on duplicate-team-name config errors. Could surprise operators who didn't know they had duplicate names. Mitigation: clear error message naming the duplicate count + cockpit.json file pointer.
- Open permission model (§D7) means a malicious / misconfigured team could spam another team's complaints table. v1 trust posture is "single-operator cluster"; multi-tenant deployments are out of scope. Mitigation: future ADR may add allowlists; spam detection is a higher-layer concern (ombudsman's adjudication step can wontfix the spam class).
- Resolve-walk's "found in multiple teams" refusal (§D6 fallback) is rare but possible on UUID collision or duplicate-cockpit-entry config errors. Manual cleanup path is the v1 answer; auto-merge of duplicates is out of scope.

**Reversibility**: **HIGH for v1**.

- Yanking ADR-150 = remove the `origin_team` column (additive, no data loss when dropped), revert `atmux complaints file --target-team` to its pre-ADR-150 local-write behaviour, remove `lookupTeamAtmuxDir` helper + `--sent-by-me` selector. Existing rows with `origin_team` populated stay parsable (column drop is reversible).
- Once downstream consumers (ADR-153 cross-team R1, future cockpit-aware aggregate view) depend on the cross-team write semantics, reversal cost rises — but those consumers don't exist yet in proposed state.

## Implementation plan

This ADR's commit is doc-only. Impl is staged across T2–T7 per the standard lead-saturation carve-out:

1. **T2 — Schema migration + Zod update**: incremental schema version bump in `sqlite-migrations.ts`; `origin_team TEXT NULL` column add on `complaints`; Zod field `origin_team: z.string().nullable().optional()` in `src/schema/complaints.ts`; same-commit migration test (`bun test --timeout 30000` per CLAUDE.md).
2. **T3 — `atmux complaints file --target-team` write-routing**: verb-layer wrapper opens target's `state.db` when `--target-team` set; sets `origin_team = <filer-team.name>`; falls back to local write when `--target-team` absent; refuses with clear error on `lookupTeamAtmuxDir` not-found / ambiguous. Same-commit unit tests with two-team fixture.
3. **T4 — `atmux complaints resolve` walk-fallback**: CWD-first read, cockpit-walk fallback; same-commit unit tests with two-team fixture + UUID-collision test path.
4. **T5 — `atmux complaints list --sent-by-me` selector**: cockpit-walk reader; aggregates rows where `origin_team === <current-team-name>` from each team's DB. Same-commit unit tests.
5. **T6 — `lookupTeamAtmuxDir` helper**: `src/core/cockpit.ts` (or sibling) export; uses existing `walkSessions` DFS; returns first-match / not-found / ambiguous. Same-commit unit tests covering single-match, not-found, two-match-refuse paths.
6. **T7 — Singular alias `atmux complaint`** (optional UX polish): delegating shim in `src/cli.ts` routing `atmux complaint file/list/resolve` to the existing plural verb-layer. Same-commit unit tests covering arg pass-through.
7. **T8 — e2e**: `tests/e2e/cross-team-complaints.test.ts` — two-team fixture (cockpit.sessions[] with team-A + team-B), file from A targeting B, assert row lands in B's `state.db` with `origin_team='A'`, resolve from A via walk, list `--sent-by-me` from A surfaces the row.

Reviewer-gated at each Task per the standing reviewer audit-bar (§Audit checklist, brief v2 + ADR-138 paneMatchesRegex justification row).

## Out of scope

- **Permission model / `team.json.complaints.acceptFrom` allowlist** — v1 is open per §D7. Future ADR when multi-tenant trust posture surfaces.
- **Bidirectional / replication writes** — explicitly rejected in §D1 lock-in.
- **Globally-unique-ID-by-prefix routing** — explicitly rejected in §D6 lock-in.
- **Cockpit-aware aggregate view** (`atmux complaints list --all-teams` showing every team's complaints in one table) — defer; ADR-152 blockers-list `--cross-team` flag (also deferred per its §Out of scope) is the canonical fleet-wide view path.
- **Cross-team `atmux complaints file` audit-trail in filer's DB** — single source of truth (§D1); audit-trail accessed via `--sent-by-me`.
- **Filer-side notification when target's status changes** — out of scope; ADR-153 R3 (lead-outbox heads-up) is the canonical cross-team notification mechanism for downstream.
- **Cross-team complaint MUTATION beyond resolve** (`atmux complaints reclassify --target-team <t>` etc.) — v1 ships file + resolve + list. Mutation verbs follow if real friction surfaces.
- **Execution slices T2–T8** — staged per lead saturation carve-out; this ADR is design-only.

## Cross-references

- **historical decision number 005 (no surviving ADR file)** — kanban-as-source-of-truth invariant; ADR-150's storage-authority rule mirrors the pattern (one DB owns the row).
- **[ADR-077](077-superdoctor-cockpit-role.md)** — medic + complaints substrate; the `complaints` table this ADR extends.
- **[ADR-089](089-hierarchical-cockpit.md)** — cockpit recursive `sessions[]` + DFS walk; `walkSessions` / `enabledTeams` are the primitives `lookupTeamAtmuxDir` reuses.
- **[ADR-133](133-medic-rename.md)** — medic rename; storage identifiers (`__superdoctor__` sentinel, `superdoctor_attempts` table) unchanged per ADR-133 §Out of scope, so ADR-150's column addition lands on the existing-named `complaints` table without rename collision.
- **[ADR-147](147-ombudsman-and-release-notes.md)** — ombudsman adjudicates complaints; with ADR-150 shipped, ombudsman of team B drains complaints filed against B from team A.
- **[ADR-152](152-blockers-list-unified-verb.md)** — blockers list; `complaints` (open) is surface 2 of 7. ADR-152's deferred cross-team aggregation (per its §Out of scope) lands as a follow-up using ADR-150's `lookupTeamAtmuxDir` primitive.
- **[ADR-153](153-auto-promotion-rules.md)** — auto-promotion R1; current §Out of scope "cross-team R1" lands as a follow-up using ADR-150's write-routing primitive (R1 fires complaints into target-team DB via `--target-team` resolution).
- **[ADR-149](149-eternal-improvement-gating.md)** (proposed) — eternal-improvement gating; sibling `team.json` additive-block pattern.
- **EPIC `t-1ea440e8`** — parent EPIC body has the cross-team complaint routing scope this ADR formalizes.
- `[[feedback_decomp_same_session_with_deps]]` (memory) — sub-tasks T2–T8 to be filed with `deps[]` chain in the same planner-near session.
