# ADR-032: Phase 4a iter-3 error-class expansion lane scope (refs ADR-026, ADR-027, ADR-029, ADR-030, ADR-031)

**Status:** accepted
**Date:** 2026-05-06
**Owner:** whip-impl

## Context

Phase 4a parallelises Phase 3 iter-3 across five vocabulary lanes — cron-fired
(ADR-028, parity-cron-impl), state-mutating UPDATE/DELETE/asymmetric (ADR-029,
parity-state-impl), read-only (ADR-030, parity-read-impl), lifecycle (ADR-031,
up-impl), and **error-class** (this ADR, whip-impl). Each lane porter owns its
verb-set's happy-path + a small natural error-coverage slice; the error-class
lane mops up the **cross-lane error-path GAPS** the other four don't naturally
pick up while staying inside their happy-path scope.

ADR-027 §1 fixed the mask contract: error-rendering divergences (bash `💥` +
exit 1 vs TS structured-tag + BSD sysexits per ADR-006) mask via `exitCode:
true` + a stderr regex anchored on the prefix divergence; the cite-locality
rule (§4) requires every row's mask block to carry an inline `// reason:`
comment naming the divergence class. ADR-026's iter-2 close shipped 4
error-rendering rows (init / start / send / add-member, all `minimal` preset
no-team variants) demonstrating the pattern; ADR-031's iter-2 lifecycle close
shipped 13 more rows extending it (12 error rows across stop/pause/resume/attach/
rotate/rotate-lead/reconfigure no-team + pause/resume/rotate no-such-member +
pause/rotate usage-error + 1 happy-path pause w1).

The lead's Phase 4a dispatch (`.atmux/lead-outbox.md`, 2026-05-06) names
**~10–15 cross-lane error gap rows** as iter-3's error-class delivery, with
FUNCTIONAL acceptance per PLAN §14 (every error path has a parity row with
reason-cited mask + zero divergence on stdout / stderr / exit / state across
in-scope state-shape presets). The "mop-up" framing means: pick representative
rows per cross-cutting class (task-not-found, no-tmux-window, member-paused,
member-not-in-team, no-team-lead-defined) AND pick verb-specific gaps the
lane porters don't naturally cover (kanban subverb tree depth, dispatch
no-args, handoff no-args).

This ADR fixes iter-3's error-class scope BEFORE row commits — analogous to
ADR-026/027/029/030/031 fixing their lane scopes before row landings.

### State-of-the-matrix survey (HEAD `4c717b8`, 2026-05-06)

`tests/parity/matrix.ts` currently holds 32 rows across 6 commits since
iter-2:

| Commit | Rows | What |
|---|---|---|
| `8e82ed2` | 2 | smoke (version, not-a-verb) |
| `1890278` | 4 | task-add INSERT-class happy (ADR-026 row 3) |
| `a2fcef6` | 4 | error-rendering (ADR-026 row 6 — init/start/send/add-member no-team) |
| `12d3bbf` | 13 | lifecycle error-class (ADR-031 — stop/pause/resume/attach/rotate/rotate-lead/reconfigure no-team + 3 no-such-member + 2 usage-error + 1 happy pause) |
| `b208796` … `03dcaf8` | 8 | state-mutating happy UPDATE+INSERT (ADR-029 — dispatch x2, claim x2, done x2, inbox x2) |

Two lane-porter row sets are in-flight, not yet landed at this HEAD:

- **ADR-029 reply / tell-lead happy-path rows** (4 rows; parity-state-impl mid-flight per `lead-outbox.md` 16:46 MYT — F11 reply newline-trailing fix outstanding before commit F lands; commit G tell-lead in-flight).
- **ADR-030 read-only rows** (10 rows; parity-read-impl staged commit B happy 1–6 + commit C error 7–10 per `lead-outbox.md` 16:42 MYT).

Cross-lane error GAP analysis — what error paths are NOT naturally covered
by ADR-028 / 029 / 030 / 031 even after their row commits all land:

1. **State-mutating error rows** — ADR-029's row table (§Decision row 1–12)
   is exclusively happy-path UPDATE/INSERT. Its 18+ atmux::die / UsageError /
   ConfigError sites across kanban.sh / dispatch.sh / claim.sh / reply.sh /
   tell.sh / handoff.sh have **zero coverage** in matrix today. **Largest
   single gap surface** for this ADR.
2. **Cron-fired error rows** — ADR-028 (scope landed @`20d711e`) covers 4
   verbs but Decision rows are happy `report` + 1 `whip` no-session row +
   golden-file harness primitive + 3 decisions-digest baselines + 3
   `groom --dry-run` baselines (per ADR-028 §Decision after the 2026-05-06
   re-scope). Both bash and TS sides have arg-parse error sites (`report
   --bogus`, `whip --bogus`, `report --team-dir` no-value, `whip
   --team-dir` no-value). NOT in ADR-028 §Decision. Deferred-table entry
   until ADR-028's row commits land (cron-impl mid-flight on commit 2 =
   cron-tasks fixture preset family per `lead-outbox.md`).
3. **Read-only error rows** — ADR-030 §Decision rows 7–10 cover 4 of 5
   read-only verbs' unknown-arg sites (status / doctor / dashboard / cost
   per `lead-outbox.md` 16:45 MYT reviewer reading); inbox too-many-args +
   missing-member NOT in §Decision. Deferred-table entry until ADR-030 row
   commits land (parity-read-impl picks them up if natural).
4. **Send beyond no-team** — ADR-026 row 6 / iter-2 covered `send`'s no-team
   path only. Send has 4 die sites: `:30 unknown-flag` + `:39 missing-args`
   + `:43 empty-message` + `:62 no-tmux-window-for-member`. 3 sites beyond
   no-team — gap.
5. **Add-member beyond no-team** — same shape as send. Iter-2 covered
   no-team only. add-member has 4 die sites: `:22 unknown-flag` + `:24
   too-many-args` + `:28 missing-args` + `:34 already-exists`. 3 sites
   beyond no-team — gap.
6. **handoff verb error rows** — handoff is in ADR-029 §Iter-3 deferral
   table (it's a state-mutating verb, but its state-after surface is a
   path-baked timestamped markdown file requiring new harness infra).
   handoff has 3 atmux::die sites + 2 ConfigError sites that are
   error-rendering pure (no state mutation needed) — fully reachable
   without the path-baked-fs deferral. Gap.

The list maps cleanly to the pre-research notes at `.atmux/notes-adr-032-research.md`
(2026-05-06 ~11:35 MYT + 21 probe captures); refer to that doc for the full
lib/*.sh error-site inventory + Pattern A/B/C/D/E mask families.

## Decision

### 1. In-scope error rows: 12 rows across 4 verb-families + Pattern A/B/C mask families

Per the survey's gap #1 (state-mutating, the largest gap), gaps #4 + #5
(send / add-member beyond no-team), and gap #6 (handoff). Cron-fired (#2)
+ read-only (#3) defer to follow-up commits behind their lane-porters.

**ROW TABLE — final (post-probe verification 2026-05-06 ~17:05 MYT).** 21 fresh
probes against `bin/atmux` + `bin/atmux-bun` on a `lifecycle` fixture (full
listing in `.atmux/notes-adr-032-research.md` §"Probe-rerun for ADR-032
amendments") drove three corrections from this ADR's first draft (now
deferred-row entries D15–D17): row 8 reclassified from family B → A
(`task show` no id has no TS hint-tail); row 9 substituted (`send lead
--bogus` is Pattern D semantic divergence — bash hits no-tmux-window,
TS hits tmux-socket-not-found — substituted with `add-member lead`
already-exists which is clean Pattern A); row 12 substituted (`claim
--as no-such-member` is a parity-CONSISTENT non-validation bug — both
sides accept the bogus name and write `inboxes/no-such-member.json` —
substituted with `dispatch no-such-member t-seed1 --no-ping` which
probes clean Pattern A with optional TS-side `dispatch:` verb-tag).

| # | Verb | Args (representative) | Fixture + preState | Error class | Mask family | ADR-027 class |
|---|------|-----------------------|--------------------|-------------|-------------|---------------|
| 1 | `claim` | `t-deadbeef --as lead` (no such task) | `lifecycle` | task-not-found ConfigError | A pure prefix | error-rendering |
| 2 | `dispatch` | `lead t-deadbeef --no-ping` (no such task) | `lifecycle` | task-not-found ConfigError | A prefix + bash-only `dispatch:` verb-tag + ` id` word | error-rendering |
| 3 | `tell-lead` | (no args) | `lifecycle` | UsageError missing-msg | A pure prefix (both sides keep `usage:` body) | error-rendering |
| 4 | `dispatch` | (no args) | `lifecycle` | UsageError missing-args | C per-side (TS adds ` [--no-ping]` flag suffix; bash uses `usage:` body but TS uses tag-only) | error-rendering |
| 5 | `handoff` | (no args) | `lifecycle` | UsageError missing-args | C per-side (TS adds ` [--no-native] [--pause-from]` flag suffix) | error-rendering |
| 6 | `task` | `bogus` (unknown subverb) | `lifecycle` | unknown-subverb UsageError | B prefix + TS hint-line tail | error-rendering |
| 7 | `task` | `add` (missing subject) | `lifecycle` | UsageError missing-subject | B prefix + TS hint-line tail | error-rendering |
| 8 | `task` | `show` (missing id) | `lifecycle` | UsageError missing-id | A pure prefix (TS doesn't emit hint here per probe) | error-rendering |
| 9 | `add-member` | `lead` (already in team.json) | `lifecycle` | already-exists ConfigError | A pure prefix | error-rendering |
| 10 | `add-member` | `--bogus` | `lifecycle` | UsageError unknown-flag | B prefix + TS hint-line tail | error-rendering |
| 11 | `dispatch` | `lead t-seed1 --no-ping` (paused-member) | `lifecycle` + preState `kanban.json` (seeded) + `state/paused.json` (lead paused) | member-paused ConfigError | A pure prefix (both sides emit `dispatch:` verb-tag in body) | error-rendering |
| 12 | `dispatch` | `no-such-member t-seed1 --no-ping` | `lifecycle` + preState `kanban.json` (seeded) | member-not-in-team ConfigError | A prefix + TS-only `dispatch:` verb-tag (mirrors ADR-031 family-c at line 454) | error-rendering |

Coverage by mask family (post-probe):

- **Family A (prefix divergence with optional narrow body absorption)** —
  7 rows (#1, #3, #8, #9, #11 = pure prefix; #2 + #12 = prefix + bash-only
  or TS-only word/verb-tag elision). Pattern A is the canonical
  ADR-027 error-rendering shape; the variant rows reuse the existing
  ADR-031 family-c precedent at `tests/parity/matrix.ts:454`
  (`(?:pause: |resume: |rotate: )?` for verb-tag absorption).
- **Family B (prefix + TS-only hint-line tail)** — 3 rows (#6, #7, #10).
  Mask shape: `exitCode: true` + `stderr: /(💥 atmux |atmux: \S+: )|\n  (?:atmux|usage:) [^\n]+/g`
  per-verb-narrowed. Extends ADR-031 row 14 family-d to verbs beyond
  pause/rotate.
- **Family C (per-side usage-line literal divergence — TS-only flag suffix)**
  — 2 rows (#4, #5). Mask shape: `exitCode: true` + a per-row stderr
  regex tuned to the specific verb's TS-side `[--<flag>]` flag-suffix
  divergence (bash atmux::die "usage:" pre-rendered without the flag
  decoration; TS UsageError USAGE constant carries it). Narrow per
  ADR-027 §4 cite-locality.

Total: 7 + 3 + 2 = 12 rows ✓.

### 2. Mask vocabulary verdict — no new classes

Pre-research's Pattern A/B/C/E all map cleanly to ADR-027's existing
`error-rendering` class. Pattern D (semantic check-order divergence) is the
only one that doesn't fit — but per the verdict in the research notes
(§"Mask vocabulary verdict") it is a **deferred-row class, not a new mask
class**. The matrix should NOT mask Pattern D divergences (they represent
real semantic differences in check-order between bash and TS); they record
in this ADR's deferred table with re-enable triggers.

**Implication:** no commit-2 mask vocabulary infrastructure extension.
ADR-027's two classes (`error-rendering` + `state-after`) plus the
ADR-029-introduced `preState` channel suffice for all 12 in-scope rows.
Reviewer's grep gate (`mask:` blocks adjacent to `// reason:` cites)
already enforces cite-locality across the new rows.

### 3. Fixture preset reuse

All 12 rows use existing presets:

- 8 rows on `lifecycle` (no preState — task-not-found / unknown-arg / missing-arg sites need a real team but no specific seeded state).
- 1 row on `lifecycle` + preState `paused.json` (#11, member-paused — reuses preState mechanism from ADR-029 row 1).
- No rows need `multi-team` for iter-3 (multi-team error rendering is
  shape-identical to lifecycle; deferred to iter-4+ if a multi-team-specific
  error path surfaces).

No fixture factory changes needed.

### 4. Commit chain

| Commit | Subject | Rows |
|---|---|---|
| A (this) | `docs(adr-bun): ADR-032 — phase4a iter-3 error-class expansion lane scope` | 0 (this ADR + the deferred table) |
| B | `test(parity): 4 error rows — task-not-found + member errors (ADR-032 family A)` | rows 1, 2, 11, 12 |
| C | `test(parity): 5 error rows — kanban subverb + arg-parse (ADR-032 family B)` | rows 6, 7, 8, 9, 10 |
| D | `test(parity): 3 error rows — usage-line divergence (ADR-032 family C)` | rows 3, 4, 5 |

Each row commit standalone-passes typecheck + 100% coverage gate. Reviewer
gates each per the 8-check protocol (PLAN.md §9).

## Out of plan / future work

### Deferred-row table — error paths not in iter-3

Each deferred entry carries (a) the verb + error site (file:line), (b)
reason for deferral, (c) re-enable trigger.

| # | Verb + site | Why deferred | Re-enable trigger |
|---|-------------|--------------|-------------------|
| D1 | `report --bogus` (lib/report.sh:20 + src/verbs/report.ts:58) | ADR-028 cron-fired lane scope, parity-cron-impl owns; matrix row would step on cron-impl turf | When ADR-028 row commits land. Add row using mask family B. |
| D2 | `report --team-dir` (no value; src/verbs/report.ts:52 UsageError) | Same as D1 | Same as D1. |
| D3 | `whip --bogus` (src/verbs/whip.ts:122 UsageError) | Same as D1; bash side `lib/whip.sh` is body-driven (no atmux::die) so this is a TS-only error path requiring careful single-side mask | When ADR-028 row commits land + cron-impl confirms TS-only stance via probe. May need new mask class for TS-only-error if mask-family-B insufficient. |
| D4 | `whip --team-dir` (no value; src/verbs/whip.ts:116 UsageError) | Same as D3 | Same as D3. |
| D5 | `decisions digest` (any error) | TS port absent (`src/verbs/decisions.ts` does not exist per ADR-028 §Survey); lib/decisions.sh has 684 LOC of multi-subcommand bash. Full parity divergence by construction | When TS port lands at `src/verbs/decisions.ts`. ADR-028's deferred-row table for the verb already names this trigger. |
| D6 | `groom` (any error) | Same as D5 — TS port absent (`src/verbs/groom.ts`). Bash 503 LOC | When TS port lands at `src/verbs/groom.ts`. Same as D5. |
| D7 | `inbox` (no args; lib/inbox.sh:16 missing-member) | ADR-030 read-only lane scope, parity-read-impl owns | When ADR-030 row commits land. If parity-read-impl picks it up, no follow-up needed; otherwise add row using mask family C (inbox usage-line). |
| D8 | `inbox a b c` (lib/inbox.sh:13 too-many-args) | Same as D7 | Same as D7. |
| D9 | `dispatch lead t-seed --no-ping` blocked-by-deps (`lifecycle` + preState seeded task with unresolved dep) | Pattern A class, but preState shape needs nested-task-array seeding (deps array on a task that points at a non-`done` upstream task) — beyond iter-3 row budget | When iter-4+ extends preState shape OR when a porter needs blocked-by-deps coverage for a different reason. |
| D10 | `claim t-seed --as <member>` blocked-by-deps (same shape as D9) | Same as D9 | Same as D9. |
| D11 | `send <member> hi` no-tmux-window-for-member (`lifecycle` no session up) | Pattern D semantic check-order divergence per probe-11 of pre-research notes (bash hits no-window code path; TS hits member-not-in-team code path; different errors emitted for same input). Masking Pattern D would absorb a real semantic divergence. | When bash-side patch lands unifying check order with TS, OR when ADR amendment carves out a semantic-divergence class that explicitly elides the body. |
| D12 | `task move <id> <bad-status>` (lib/kanban.sh:112 bad-status validation) | Subverb-tree gap — covered by row #6 `task bogus` representative; full subverb error-tree depth is iter-4+ per ADR-026 §Iter-3 row-budget convention | When iter-4 takes subverb-tree depth coverage. |
| D13 | bash-only assertions (claim.sh:15, reply.sh:16, pause.sh:29) | Internal-routing assertions on the bash side; TS has no equivalent (the routing is type-enforced via the cli-dispatcher per ADR-010). One-sided emission means total channel divergence by construction; mask would be `.*`-broad which ADR-027 §4 bans | When/if TS surfaces an equivalent assertion path (no plan to). Skip-rows entry — likely permanent. |
| D14 | `lib/reconfigure.sh` empty body | Bash-side verb is empty (no error sites); TS side `src/verbs/reconfigure.ts` is real. Per ADR-031 §"reconfigure" already noted | When bash port lands. Already tracked by ADR-031. |
| D15 | `send <member> --bogus` (lib/send.sh:30 unknown-flag site) | **Pattern D semantic check-order divergence** — probe-confirmed 2026-05-06 ~17:05 MYT: bash hits `:62 no-tmux-window-for-member` BEFORE arg-parse (the `--bogus` is consumed as msg body); TS hits a tmux-socket-not-found error at the lower-level tmux binding before arg-parse. Different error categories on the two sides; masking would absorb a real semantic divergence per ADR-027 §4 anti-broad-mask rule | When a fixture preset materialises an actual tmux session (iter-4+ tmux-channel infra per ADR-031 §"tmux-channel infrastructure" durable handle) so both sides reach the arg-parse layer. |
| D16 | `claim <task-id> --as <bogus-member>` (lib/claim.sh + claim.ts non-validating `--as`) | **parity-CONSISTENT non-validation finding** — probe-confirmed 2026-05-06 ~17:05 MYT: BOTH `lib/claim.sh` and `src/verbs/claim.ts` accept any string as `--as` value without checking it against `team.json`. Both write `inboxes/<bogus>.json` and exit 0 with success message. This is parity-CONSISTENT (both agree, both miss the validation), not a divergence. Therefore not a parity-row candidate; it's a behavioural-quality bug captured here as a porter-cross-lane finding for the team-lead's pending-decisions queue. Substitution: row 12 uses `dispatch no-such-member` (which DOES validate in dispatch.sh + dispatch.ts — Pattern A clean) | When the team-lead's pending-decisions queue triages this as a non-iter-3 quality fix and lands a validation patch on both sides; a parity row could then be added testing the new error path. |
| D17 | `task show` (no id), `task list` (with bad args), other UsageError sites with TS lacking hint-line tail | Subset of family-A reclassifications surfaced by post-probe verification 2026-05-06 — TS USAGE constants for some sub-paths don't include a `\n  ` continuation line, collapsing back to Pattern A (already covered for `task show` as row 8). Other subverb depth (move, assign, rm, list) NOT in iter-3 scope per row-budget convention | Iter-4 subverb-tree depth scope (paired with D12). |

### Out of scope (durable)

- **No `tmuxAfter` channel.** Same restraint as ADR-029 / ADR-030 / ADR-031.
  Tmux side-effect comparison is iter-4+ per ADR-031 §"tmux-channel
  infrastructure" durable handle.
- **No mask-family-D infrastructure.** Per §2 — Pattern D divergences are
  deferred-row entries, not masked.
- **No bash-side error-rendering changes.** ADR-006 stands; ADR-027 Option B
  (mask the noise, don't reconcile the rendering). Bash atmux::die output
  is unchanged.
- **No multi-team error rows.** Error-rendering shape is identical across
  preset state-shapes; multi-team coverage adds no new divergence surface
  per probe-13 (handoff lead bogus-target on minimal vs lifecycle:
  identical Pattern A shape). Iter-4+ if ever needed.
- **No new ADR-027 mask classes.** Per §2 verdict.

### Iter-4+ handles

When this ADR's deferred table is consumed:

- **D1–D6** auto-trigger on ADR-028 row commits (scope-ADR already landed
  @`20d711e`) + decisions/groom TS port arrivals.
- **D7–D8** auto-trigger on ADR-030 row commits.
- **D9–D10** auto-trigger on iter-4 preState shape extension OR a porter's
  natural pickup of blocked-by-deps coverage in another lane.
- **D11** parks until either bash patch OR ADR amendment.
- **D12** auto-triggers on iter-4 subverb-tree-depth scope ADR.
- **D13** parks indefinitely (likely permanent skip).
- **D14** already tracked by ADR-031.
- **D15** auto-triggers on iter-4+ tmux-channel infrastructure (ADR-031
  durable handle) — once both sides reach the arg-parse layer with a real
  tmux session present, `send --bogus` becomes a clean parity row.
- **D16** lands in pending-decisions queue for team-lead triage as a
  non-iter-3 behavioural-quality finding; not a parity-row candidate
  until both sides validate `--as`.
- **D17** auto-triggers on iter-4 subverb-tree depth (paired with D12).

## Consequences

- **Cross-lane error coverage closes.** ADR-029 / ADR-030 / ADR-031 happy
  + natural-error coverage + ADR-032's 12 cross-lane gap rows leave the
  matrix with a coherent error-class footprint across state-mutating /
  read-only / lifecycle verbs.
- **Mask vocabulary stays at 2 classes (error-rendering + state-after).**
  Pattern D semantic divergence stays out of mask vocabulary by deliberate
  choice — masking it would absorb real semantic differences.
- **Cron-fired error coverage is the next iter-3 follow-up commit.** Once
  ADR-028 row commits land, D1–D4 fold in via amendment to this ADR's row
  table + a single follow-up commit (likely 2–3 rows; whip's body-driven
  side may need probe-driven mask family choice).
- **Bash side stays frozen.** No bash sources touched. ADR-006 + ADR-027
  Option B held.
- **Reviewer grep gate continues to enforce cite-locality.** Every mask
  block in commits B/C/D carries an inline `// reason:` cite naming
  ADR-027 error-rendering class.
- **Deferred-row table is the durable-handle artefact.** 14 rows captured
  with explicit re-enable triggers; no rot risk because each entry names a
  specific event (ADR landing, port arrival, scope-ADR amendment) that
  fires its re-enable.
- **Iter-3 closes the matrix's iter-1/iter-2/iter-3 deliverable arc.**
  ADR-026's §Iter-3 list is fully consumed across ADR-028/029/030/031/032
  scope-ADRs + their row commits; iter-4 picks up tmux-channel infra +
  preState extensions + subverb-tree depth.
