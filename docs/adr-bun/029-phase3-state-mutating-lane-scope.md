# ADR-029: Phase 3 iter-3 state-mutating lane scope (refs ADR-026 §Iter-3, ADR-027 mask contract)

**Status:** accepted
**Date:** 2026-05-06
**Owner:** parity-state-impl

## Context

Phase 3 iter-2 (ADR-026 + ADR-027) closed two of the deferred ADR-026 rows: row 3 (state-mutating happy-path, INSERT class) via 4 `task add` VARIANT rows + commit `1890278`, and row 6 (error-rendering) via 4 init/start/send/add-member rows + commit `a2fcef6`. The verb-set deviation on row 3 (4 `task add` variants instead of 4 distinct verbs `task add` / `dispatch` / `inbox` / `done`) was accepted at the time as the cleanest way to isolate the INSERT mutation class without dragging UPDATE / channel-asymmetric / multi-file divergence into commit-4 scope; the deferred verb set was captured as ADR-026 §Iter-3 entry 1:

> UPDATE/DELETE/channel-asymmetric state-mutating verbs — `dispatch <member> <id>` (preset extension for pre-seeded task + tmux side effects), `inbox <member>` (channel-asymmetric stderr — bash emits stylistic header, TS doesn't), `done <id>` (UPDATE-with-dependency on dispatch chain or manual seed). Captures `1890278`'s verb-set deviation as durable handle. Adds new mask sub-classes (channel-asymmetric stderr / header-rendering elision) beyond iter-2's vocabulary.

Iter-3 picks up that handle plus the other state-mutating verbs that share its mutation classes — `claim`, `reply`, `tell-lead`, `inbox` (auto-init side-effect). `handoff` is in the same family but its state-after surface is qualitatively different (writes a markdown handoff file at a path that bakes a UTC ISO-8601 timestamp into the filename; tmux capture-pane content as the file body) and demands new harness infrastructure (fs-path-pattern allowlist + body-elision); it carves out to iter-4.

Phase 4a's lead-dispatched mission per `.atmux/lead-outbox.md` (top entry, 2026-05-06): **target ~12–18 rows across INSERT / UPDATE / DELETE mutation classes**, with FUNCTIONAL acceptance per PLAN §14 (zero divergence on state-after JSON-field comparison + stdout / exit / discord) — not row-count.

### Class 3 — UPDATE-class state-after non-determinism (dispatch / claim / done)

Probe at `/tmp/parity-probe-iter3` will confirm, but the bash sources at `lib/dispatch.sh:54-58`, `lib/claim.sh:53-58`, `lib/claim.sh:62-66` show:

- `dispatch` UPDATEs `kanban.tasks[*]`'s `owner` / `status` / `claimedAt`. The `claimedAt` field is `atmux::now_epoch` — Unix epoch seconds, differs on each invocation.
- `claim` UPDATEs the same kanban fields plus the inbox file's `inProgress[]` entry's `claimedAt` (Unix epoch).
- `done` UPDATEs `kanban.tasks[*].completedAt` (Unix epoch) plus the inbox's `done[]` entry's `completedAt`.
- `dispatch` additionally INSERTs into `inboxes/<member>.json`'s `inProgress[]` array with a `dispatchedAt` epoch field.

The state-mutation pattern is the same as iter-2's INSERT class (random / time-varying field on each invocation) — but the field set widens (`claimedAt` / `completedAt` / `dispatchedAt` Unix epoch on top of iter-2's `id` / `createdAt`) AND the file set widens (inbox JSON files keyed by member name, not just `kanban.json`). ADR-027's `stateAfter` mask vocabulary covers it without infra change — globs reference inbox stems by member name (`<member>.inProgress[*].claimedAt`) the same way iter-2 referenced `kanban.tasks[*].id`.

### Class 4 — INSERT-class markdown line-append (reply / tell-lead)

`reply` appends a `- [HH:MM MYT] **<from>**: <msg>` line under `## Open` in `.atmux/lead-outbox.md`. `tell-lead` appends a `- [HH:MM MYT] <msg>` line at the end of `.atmux/driver-inbox.md` plus a tmux send-keys side-effect to the lead's pane (no-op in fixtures with no panes — both sides emit a `warn`).

The `[HH:MM MYT]` timestamp is the existing `TIMESTAMP_MASK_REGEX` already honoured by `compare.ts:52` for ALL channels including `fs` (markdown decoded via `decode(b.bytes)` then `maskTimestamps`). The success-line stdout — `✅ atmux reply recorded (<from> → driver) in <ob-path>` / `✅ atmux tell-lead → <lead> (appended to <di-path>)` — embeds the per-side fixture-clone path (`.bash` / `.ts`); same path-suffix mask shape iter-2 introduced for error-rendering rows.

### Class 5 — INSERT-class file-creation (inbox auto-init)

`atmux inbox <member>` is a READ verb that, on first access, lazily INSERTs an empty inbox file: `inboxes/<member>.json` with literal content `{"pending":[],"inProgress":[],"done":[]}`. The empty shape is byte-equal across sides — no mask needed for the file body. The stdout render (`inbox — <member>` heading + 3 sections of `(empty)` rows) is deterministic per the bash source at `lib/inbox.sh:30-46` and the TS port; if it diverges stylistically, an `stdout` mask absorbs the divergence per ADR-027 §3.

### Class 6 — Pre-state requirement (UPDATE-class verbs need a seeded task)

`dispatch t-seed` / `claim t-seed` / `done t-seed` need `kanban.tasks[]` to contain `{id:"t-seed",...}` BEFORE `runVerb` fires. The lifecycle preset ships a bare empty kanban (`{"tasks":[],"epics":[],"stories":[]}`) per `factory.ts:167`; iter-2's task-add rows didn't need pre-state because they CREATE the task. Iter-3 needs a uniform mechanism to seed pre-state into a row's cloned fixture without forking the preset.

## Decision

### 1. Seven verbs in scope; one deferred

| # | Verb | Args (representative) | Fixture | State files written | Mutation class | Mask classes used |
|---|------|----------------------|---------|---------------------|----------------|-------------------|
| 1 | `dispatch` | `lead t-seed1` | `lifecycle` + preState seeded task | `kanban.json` UPDATE + `inboxes/lead.json` INSERT/UPDATE | UPDATE+INSERT | state-after class (extended fields + extended stems) |
| 2 | `dispatch` | `lead t-seed2 --no-ping` | `lifecycle` + preState seeded task | same as #1 | UPDATE+INSERT | same as #1 |
| 3 | `claim` | `t-seed1` (cwd-inferred member) | `lifecycle` + preState seeded task | `kanban.json` UPDATE + `inboxes/<who>.json` UPDATE | UPDATE | state-after class (extended fields + extended stems) |
| 4 | `claim` | `t-seed2 --as lead` | `lifecycle` + preState seeded task | same as #3 | UPDATE | same as #3 |
| 5 | `done` | `t-seed3` (cwd-inferred member) | `lifecycle` + preState seeded in-progress task | `kanban.json` UPDATE + `inboxes/<who>.json` UPDATE | UPDATE | state-after class |
| 6 | `done` | `t-seed4 --note "shipped"` | `lifecycle` + preState seeded in-progress task | same as #5 | UPDATE | same as #5 |
| 7 | `reply` | `--from lead "test msg"` | `lifecycle` | `lead-outbox.md` INSERT-line | INSERT (markdown) | path-suffix in stdout (existing); TIMESTAMP_MASK on fs (existing) |
| 8 | `reply` | `--from w1 "test msg from member"` | `lifecycle` | same as #7 | INSERT (markdown) | same as #7 |
| 9 | `tell-lead` | `--from w1 "test ask"` | `lifecycle` | `driver-inbox.md` INSERT-line + tmux side-effect | INSERT (markdown) | path-suffix in stdout (existing); TIMESTAMP_MASK on fs (existing); `warn` mask on stderr if tmux warn diverges |
| 10 | `tell-lead` | `--from w1 "test long ask with 80+ chars to exercise heads-up truncation logic mirror"` | `lifecycle` | same as #9 | INSERT (markdown) | same as #9 |
| 11 | `inbox` | `lead` (auto-init render) | `lifecycle` | `inboxes/lead.json` INSERT (empty shape) | INSERT (file-creation) | possible stdout mask if render diverges (probe-driven) |
| 12 | `inbox` | `lead --json` (auto-init JSON-render) | `lifecycle` | same as #11 | INSERT (file-creation) | none expected (JSON shape byte-equal) |

**Total: 12 rows.** Hits Phase 4a's lower bound. Each row exercises a discriminative axis (mutation-class boundary, flag variant, stdout-render path) without redundant variants.

**Deferred to iter-4** (durable handle, this ADR is the rationale source):

| Verb | Args (representative) | Why deferred | Re-enable handle |
|------|----------------------|--------------|------------------|
| `handoff` | `lead w1 --reason test` | Writes `handoff/<from>-to-<to>-<UTC-ISO>.md` — filename embeds `date -u +%Y%m%dT%H%M%SZ` (per `lib/handoff.sh:41`), so the filename itself differs across the bash and TS sides. Body contains tmux capture-pane content (which fixture has none of, so falls to a no-pane stub) plus an ISO-8601 timestamp. Needs **fs path-pattern allowlist** mask infra (new field `ChannelMask.fsPathMask?: RegExp` to elide files matching the pattern from `diffFs` entirely) + state-after support for the body's ISO timestamp. | Iter-4 lead-off when ADR-029 amendment OR a successor ADR pins fs-path-pattern + ISO-timestamp mask classes. The `handoff` row + amendment lands together; `handoff` is the canonical motivating case (no other in-flight verb writes path-templated files). |

### 2. NEW mask sub-class label: none required

Iter-3's `stateAfter` masks reference new field names (`claimedAt` / `completedAt` / `dispatchedAt`) and new file stems (`<member>.json` keyed by member-name) but reuse the SAME glob shape ADR-027 §3 codified (`<filename-stem>.<json-path>` with `[*]` wildcards) and the SAME regex shape (`/^\d{10,}$/` for Unix epoch). No new infra. No new class label. Each `mask:` block carries `// reason: ... (ADR-027 state-after class)` per ADR-027 §3 — the "state-after" label spans iter-2's INSERT + iter-3's UPDATE without bifurcation.

The `path-suffix` shape (per-side fixture-clone `.bash` / `.ts` artefact in stdout/stderr) was introduced in iter-2's error-rendering rows for `stderr` (ADR-026 row 6). Iter-3 carries it forward to `stdout` for `reply` / `tell-lead` rows whose success line embeds an outbox / inbox path. Mechanically identical pattern; reviewer's grep target stays "every `mask:` block has adjacent `// reason:`".

### 3. NEW harness extension: `ParityRow.preState` hook

UPDATE-class verbs (`dispatch` / `claim` / `done`) need `kanban.tasks[]` pre-seeded BEFORE `runVerb` fires. Iter-3 adds a row-level pre-state mechanism that mutates the cloned fixtures (BOTH sides identically) AFTER `factory.makeFixture()` clones into `<path>.bash` + `<path>.ts` and BEFORE `runVerb` spawns. This keeps `factory.ts` untouched — important because cron-impl (ADR-028) and up-impl (ADR-031) both flagged factory.ts edits as cross-lane coordination boundaries; ADR-029 sidesteps the coordination dance by pushing the pre-state requirement into row-level metadata.

```ts
export type ParityRow = {
  verb: string;
  args: ReadonlyArray<string>;
  fixturePreset: FixturePreset;
  expect: ParityExpectation;
  label?: string;
  mask?: ChannelMask;
  /**
   * Optional pre-state mutation applied to the cloned fixtures BEFORE
   * `runVerb` fires. Per-relPath: a JSON value (writes/overwrites the file
   * with canonical-stringified JSON) or a string (writes the file with
   * the literal content). Both sides receive identical pre-state.
   *
   * Reviewer rule: every preState entry MUST have an inline `// reason:`
   * comment naming the verb-class need (e.g. `// reason: dispatch needs
   * a pre-seeded task to UPDATE — ADR-029 row 1`).
   */
  preState?: Record<string, unknown | string>;
};
```

Implementation in `index.test.ts`: after the `Promise.all([fs.cp(..., bashFixture), fs.cp(..., tsFixture)])` block, walk `row.preState` entries and write each `<relPath>` into both `bashFixture` and `tsFixture`. JSON values stringify with 2-space indent (matches lifecycle preset's `JSON.stringify(teamJson, null, 2)` shape per `factory.ts:166`). Strings write verbatim.

Pre-state writes are **additive** to the preset's materialised state — they overwrite at the relPath, so the row's preState `{".atmux/kanban.json": {tasks:[seed], epics:[], stories:[]}}` replaces the preset's empty kanban with one that has the seed task. Per-relPath granularity keeps the preset's other shape (team.json, inboxes dir, driver-inbox.md) intact.

### 4. Per-row mask schema convention (carries forward from ADR-027 §3)

Mask additions in matrix rows must:

1. Cite the divergence class inline via `// reason:` comment on each entry.
2. Reference the ADR class — `(ADR-027 state-after class)` for UPDATE-field elision; `(ADR-027 error-rendering class)` for path-suffix in stdout.
3. Be specific — regex must match only the divergent surface, not silently broaden to absorb semantic differences.

`preState` entries follow the same `// reason:` discipline (see §3) — reviewer rejects pre-state writes lacking a one-liner cite.

### 5. NOT in scope of THIS commit

- **Mask infrastructure additions.** §2 confirms iter-3 reuses ADR-027 vocabulary; `compare.ts` is unchanged. No mask infra commit needed.
- **`ParityRow.preState` implementation.** This ADR pins the contract; the type extension + `index.test.ts` apply-loop + harness self-tests land in commit B (`feat(parity): ParityRow.preState — row-level pre-state hook (ADR-029)`).
- **`factory.ts` edits.** Out of scope. ADR-029 deliberately routes around factory extensions. If iter-3 needs a structurally different fixture (e.g. a 2-team setup) the answer is a new preset, NOT a `lifecycle` extension — and that's an iter-4 conversation with cron-impl + up-impl, not iter-3.
- **`handoff` row.** Deferred to iter-4 per §1 deferred table. ADR-029 does NOT carve handoff infra — that's iter-4 lead-off material.
- **Cron-fired verbs (whip / report / decisions-digest / groom).** ADR-028 lane (parity-cron-impl).
- **Read-only verbs (status / outbox / dashboard / version).** ADR-030 lane (parity-read-impl).
- **Lifecycle verbs (up / start / stop).** ADR-031 lane (up-impl).
- **Error-class harness (cross-lane).** ADR-032 lane (whip-impl).
- **ADR-021 / ADR-026 amendments.** ADR-026 §Iter-3 entry 1 closes through this ADR's commit chain — a separate commit at chain-close updates ADR-026 with iter-3 actual delivery.

## Migration plan (this ADR's commit chain)

1. **Commit A — `docs(adr,plan): ADR-029 — phase4a state-mutating iter-3 scope (refs ADR-026 §Iter-3, ADR-027 mask contract)`**: this ADR file + PLAN.md §7 backlog row.
2. **Commit B — `feat(parity): ParityRow.preState — row-level pre-state hook (ADR-029)`**: `ParityRow.preState?` field added; `index.test.ts` walks entries after fixture clone and writes JSON / string content into both per-side dirs; harness self-tests (≥3 cases — JSON write, string write, no-preState passthrough).
3. **Commit C — `test(parity): 2 dispatch rows with seeded task (UPDATE+INSERT, ADR-029 rows 1-2)`**: rows 1 + 2 land. Reviewer-gated.
4. **Commit D — `test(parity): 2 claim rows with seeded task (UPDATE, ADR-029 rows 3-4)`**: rows 3 + 4 land.
5. **Commit E — `test(parity): 2 done rows with seeded in-progress task (UPDATE, ADR-029 rows 5-6)`**: rows 5 + 6 land.
6. **Commit F — `test(parity): 2 reply rows with markdown line-append (INSERT, ADR-029 rows 7-8)`**: rows 7 + 8 land.
7. **Commit G — `test(parity): 2 tell-lead rows with markdown + tmux side-effect (INSERT, ADR-029 rows 9-10)`**: rows 9 + 10 land.
8. **Commit H — `test(parity): 2 inbox auto-init rows (INSERT file-creation, ADR-029 rows 11-12)`**: rows 11 + 12 land.
9. **Commit I — `docs(adr-bun): ADR-026 §Iter-3 entry 1 closed; ADR-029 §Consequences extended with iter-3 actual delivery`**: closes the ADR-026 deferred handle; mirrors the `33125ec`-shape commit pattern.

Each commit standalone-passes typecheck + 100% coverage gate. Reviewer (atmux:5) gates each per the 8-check protocol (PLAN.md §9). Commit B's harness self-tests are particularly important — `index.test.ts` is the harness integration boundary, and a broken `preState` apply-loop silently false-greens every downstream row commit.

## Out of plan / future work

- **Iter-4 lead-off entry list** (durable handles created by this ADR):
  1. `handoff` row + `ChannelMask.fsPathMask?: RegExp` mask infra extension. Filename-embedded UTC ISO-8601 + tmux capture-pane body content. Likely a new ADR (ADR-029-amendment OR a fresh number) given the new mask sub-class.
  2. Multi-team fixture preset (atmux / sopx-mvp / ifca_aux / unum) — original ADR-026 row 5 deferral. Iter-4+ when CI surfaces 4-team-divergence demand or a tenant-isolation verb lands.
  3. Cron-fired scenarios (whip / report / decisions-digest / groom) — ADR-028 lane scope.
  4. Remaining 16 verbs not yet in matrix — ADR-030 lane scope (read-only verbs first).
  5. CI gate wiring per PLAN.md §9 reviewer-gate item 4 — `bun test:parity:<verb>` script entries OR a single `bun test:parity` with path-filter regex. ADR-009 §6 CI-flow update.

- **`preState` deduplication.** Once 6 UPDATE-class rows ship with similar pre-seeded `kanban.json` shapes, evaluate extracting a `SEED_TASK_KANBAN` constant (`tests/parity/fixtures/seeds.ts`). Today's per-row inline `preState` cite-locality is honest about each row's pre-state contract; deduplication centralises but at cost of cite-locality. Neutral until duplication grows.

- **`preState` per-side asymmetry.** This ADR pins both sides identical. If iter-4+ needs side-specific pre-state (e.g. testing a migration path where bash and TS see different starting state), extend to `preState: { both?: ..., bash?: ..., ts?: ... }`. Not yet — iter-3 doesn't motivate it.

- **`tmux side-effect` capture.** Current harness doesn't capture tmux send-keys outputs — ADR-009 §3 doesn't list a `tmux` channel. State-mutating verbs that ping panes (`dispatch`, `tell-lead`) emit `atmux::send_to_member` calls that BOTH sides resolve the same way against a fixture (no panes → both `warn` and continue). If iter-4+ surfaces a divergence in tmux behaviour, an ADR-009 §3 amendment opens a tmux channel. Not yet — fixture-no-pane symmetry is the iter-3 assumption.

## Consequences

- **Iter-3 ships ~120 LOC of matrix-row entries + ~40 LOC of harness `preState` infra** (commit B) across 9 commits. Each row pair lands as a discrete reviewer-gated unit so divergence triage is per-commit.
- **ADR-026 §Iter-3 entry 1 closes.** The verb-set deviation captured by `1890278` is resolved — `dispatch` / `claim` / `done` (the deferred 3) plus the broader UPDATE/INSERT/file-creation sweep.
- **Phase 4a meets PLAN §14 functional acceptance for the state-mutating lane** — zero divergence on every row's stateAfter JSON-field comparison + stdout / exit / discord, with each divergence-class hit by at least 2 rows. The lower bound (12 rows) clears the "one-row-per-class" sanity floor.
- **Factory-side coordination boundary respected.** ADR-029 explicitly avoids `factory.ts` edits — cron-impl + up-impl can land their own iter-2 work without merge conflict on the preset. The `preState` row-level hook is the cleanest carve-out; if a future ADR motivates a structurally new preset, that's a separate negotiation.
- **Mask vocabulary stays additive.** No new class labels; ADR-027 §3 vocabulary widens by reuse, not by extension. Reviewer's grep target ("every `mask:` block has adjacent `// reason:`") catches every iter-3 addition without rule churn.
- **Iter-4 has a clean handoff row + handle.** The `handoff` deferral isolates a genuinely novel mask sub-class (fs-path-pattern allowlist + ISO-8601 elision) into its own iter, where it gets dedicated infra design rather than smuggling into iter-3.
