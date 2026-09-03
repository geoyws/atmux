# ADR-165: `atmux team set / get / unset` — CLI surface for `team.json` config edits

**Status**: Accepted — ratified by driver 2026-05-21 (`atmux team set/get/unset <dot.path> [value]` — atomic write + Zod-gate + backup + audit; reuses ADR-098 flock+tempfile-rename pattern; §OQ recommendations as-written)
**Date**: 2026-05-16
**Author**: `whip-impl` (T1 draft per `t-85b928a9`, parent EPIC `t-2deb17f0` — `atmux team set <key> <value>` CLI surface)
**Driver-ref**: 2026-05-16 08:07 MYT — driver flag on a sibling team: *"had to bypass atmux to flip `team.json.autoMerge.enabled` (null → true) because no CLI verb exists for it."* Manual JSON edits with hand-written backups are fragile; operators have shipped typos (`autoMerg`, `eternalImprovment`) that survive until the next `atmux start` schema-validation pass.
**Relates**: historical decision number 054 (no surviving ADR file) (strict-mode schema + drift detection — every mutation must round-trip the schema; bare-`proposed` state-rot per the ghost-ADR audit at `t-75a79d7c` style), ADR-098 (JSON + locking model — flock sidecar + tempfile-rename pattern this verb reuses verbatim), historical decision number 076 (no surviving ADR file) (kanban→SQLite migration — boundary-marker for which state-file this verb touches; SQLite-resident state has different mutation primitives), ADR-148 (commit-cadence — config-file edits are NOT git commits and MUST NOT trigger cadence rotation), ADR-097 (tmux abstraction — irrelevant; named because the Task body included it as a stub).

## Context

### What works today

`team.json` is read by every atmux verb (lead spawn, member claim, whip ticks, gitter sweep). Writes happen in two paths:

1. **`atmux start` / `atmux team add-member` / `atmux team rotate-lead`** — purpose-built verbs that mutate specific fields (roster, lead-pointer). They go through `atmux::jq_update` (per ADR-098) → flock → tempfile → rename. Safe.
2. **Operator hand-edits** — `$EDITOR .atmux/team.json` for everything else: flipping `autoMerge.enabled`, setting `whip.budgetPauseThreshold`, adding `eternalImprovement.enabled: false`, tuning `cadence.thresholds.shippingMaxAgeSec`. **No safety rails.**

Path 2 is the failure mode this ADR closes. Concrete symptoms observed across 2026-04-15 → 2026-05-16:

- **Schema typos survive until next read** — `budgetPauseTreshold` (typo) sat in a team.json for ~36h before `atmux whip` next loaded the file and the `.strict()` rejection (per historical decision number 054 (no surviving ADR file)) finally surfaced. By then nobody remembered which field they meant to set.
- **No backup, no audit** — operator edits with `vim`; if vim crashes mid-save the file is truncated; if the operator typos the JSON they discover at next `atmux` invocation that the file no longer parses. Recovery requires `.atmux/team.json.bak.*` from a prior `atmux::jq_update` write, which may be days stale.
- **No locking** — operator edit during a live `atmux whip` tick race-overwrites the whip's pending `lastTickAt` mutation. Whip-tick metadata silently lost.
- **No discoverability** — operators have no `atmux team get autoMerge.enabled` to read the current value, so the only way to confirm a config change is to dump the whole file with `cat` / `jq`.

### Why a CLI verb instead of "just edit the file"

The hand-edit path is bash + `$EDITOR` + `git diff` — it's already a workflow. The question this ADR answers is "what does atmux owe operators on top of that workflow?"

Five things:

1. **Schema gate** — refuse writes that fail Zod validation; surface the error path (e.g. `autoMerge.eanbled: expected boolean`) BEFORE the file gets clobbered.
2. **Atomic write** — operator's edit lands or doesn't; never a half-written file. Same primitive `atmux start` already uses (ADR-098's flock + tempfile + rename).
3. **Backup default-on** — every mutation snapshots the prior file to `.atmux/team.json.bak.<epoch>`; operator can audit-trail / rollback without needing `git` (team.json may be `.gitignore`'d on some setups).
4. **Audit log** — every mutation appends one NDJSON row to `.atmux/logs/team-config-mutations.jsonl` capturing `{ts, key, old, new, caller_scope}`. Closes the "who flipped this 3 days ago?" question.
5. **Discoverability** — `get` + `unset` complete the CRUD triangle. `get autoMerge.enabled` reads ONE field without dumping the whole file. `unset autonomy.gitter.aggression` reverts to schema-default cleanly.

### What this ADR is NOT

- Not a config DSL — values are CLI args (`atmux team set autoMerge.enabled true`), not a config-file format.
- Not a multi-key transaction surface — each `set` is its own atomic write. Batch edits (set 5 fields at once) are out of scope; if operators need them, future ADR can add `set --batch <jsonpatch-file>`.
- Not a secret store — values are CLI args + audit-logged; secrets MUST NOT round-trip through here. Future ADR may add a `--secret` redaction flag if the use case emerges.

## Decision

### D1 — Verb namespace: `atmux team set | get | unset`

Three sub-verbs under the existing `team` namespace:

| Verb | Signature | Semantics |
|---|---|---|
| `atmux team set <dot.path> <value>` | mutate | Set `<dot.path>` to `<value>`; atomic write + Zod-gate + backup + audit. |
| `atmux team get <dot.path>` | read | Print current value (JSON-formatted). Exit 1 + stderr hint if path doesn't resolve. |
| `atmux team unset <dot.path>` | mutate | Remove key at `<dot.path>`; schema-default fills back in on next read. Atomic + backup + audit. |

Sub-verbs sit under `team` (alongside the existing `team add-member` / `team rotate-lead` / etc.); they do NOT pollute the top-level verb namespace.

Flags:

- `--no-backup` — skip the `.atmux/team.json.bak.<epoch>` snapshot. Default off (i.e. backup default-on).
- `--no-audit` — skip the NDJSON audit row. Default off.
- `--force` — bypass the schema gate. **Operator-only escape hatch**; required when migrating a hand-edited file with pre-existing schema drift the schema-gate would reject.
- `--dry-run` — resolve + validate but don't write. Prints the resolved final value + would-write diff.
- `--no-lock` — skip the flock sidecar. NOT exposed in v1; reserved for future test-injection.

### D2 — Schema gate via Zod strict-mode (per historical decision number 054 (no surviving ADR file))

Every `set` / `unset` write:

1. Read current `team.json` into the `Team` Zod schema (strict-mode where applicable, per historical decision number 054 (no surviving ADR file)'s drift-detection convention).
2. Apply the mutation in-memory (set / delete the key at `<dot.path>`).
3. **Re-validate** the post-mutation object against the Zod schema. If validation fails, REFUSE the write — exit 1, stderr the Zod error path, file UNCHANGED.
4. On success, atomic-write the file.

The gate is fail-closed: typos like `budgetPauseTreshold` are rejected BEFORE the tempfile is renamed. The same `Team.parse()` boundary that `atmux start` enforces on the read path now governs the write path.

`--force` bypasses re-validation (writes the post-mutation object regardless). This is the migration escape hatch for files that were ALREADY schema-drifted at the time the operator picked up the verb — refuses without it would leave operators with no programmatic way to fix bad state. Audit-log records `caller_scope: "forced"` so the bypass is traceable.

### D3 — Atomic write semantics — reuse ADR-098 primitive

Write path mirrors `atmux::jq_update` per ADR-098:

```
flock <atmuxDir>/.atmux/team.json.lock
  → write to <atmuxDir>/.atmux/team.json.tmp.<pid>
  → rename(.tmp.<pid>, team.json)
flock release
```

Permissions preserved across the rename (chmod stat'd from the old file, applied to the new). Same lock sidecar that bash whip + ts-side `updateJson` already use — no new lock-ordering concern.

`fs.rename()` is atomic on the same filesystem (POSIX guarantee); cross-filesystem renames degrade to copy+unlink and lose atomicity, which this verb does NOT do (tempfile sits in the SAME `.atmux/` dir as the target).

### D4 — Backup default-on (`.atmux/team.json.bak.<epoch>`)

Pre-mutation snapshot:

```
<atmuxDir>/.atmux/team.json.bak.<epoch-seconds>
```

Created BEFORE the tempfile-rename (so the backup is the pre-mutation state, not the post-mutation state). Skipped only with `--no-backup`.

Backups are NOT pruned by this verb — `atmux groom`'s existing `.bak.*` keep-N family handler (`--keep-bak N`, default 5) sweeps them on the daily cron. Reusing the existing groom path means no new pruning logic; the convention already exists for sibling `.bak.*` files.

### D5 — Audit-log NDJSON to `.atmux/logs/team-config-mutations.jsonl`

Every mutation (including `unset`) appends one row:

```json
{"ts":1778925131,"key":"autoMerge.enabled","op":"set","old":null,"new":true,"caller_scope":"driver","forced":false}
```

Fields:

- `ts` — epoch seconds (UTC).
- `key` — the dot-path as typed.
- `op` — `"set"` or `"unset"`.
- `old` — the pre-mutation value at `key` (JSON-serialized; `null` if path didn't exist).
- `new` — the post-mutation value (omitted for `unset`).
- `caller_scope` — `"driver"` for hand-typed operator invocations, `"forced"` for `--force` bypasses, `"member"` for member-pane invocations (rare but possible). Resolves from `ATMUX_CALLER_SCOPE` env (existing per ADR-099 conventions).
- `forced` — `true` if `--force` was passed.

Append-only; no rotation in v1. If the file grows large enough that operators notice, future ADR adds rotation (similar to ADR-138 §Escalation log rotation policy OQ). Order-of-magnitude estimate: 100 mutations/team/year × N teams × ~150 bytes/row = ~150KB/year/team for a chatty team. Bounded.

Skipped only with `--no-audit`.

### D6 — Dot-path resolution = JSON-Pointer-lite

Dot-separated path segments resolve into the JSON tree:

| Input | Resolves to |
|---|---|
| `autoMerge.enabled` | `team["autoMerge"]["enabled"]` |
| `autonomy.gitter.aggression` | `team["autonomy"]["gitter"]["aggression"]` |
| `members.0.role` | `team["members"][0]["role"]` (numeric segment indexes arrays) |
| `members.-1.role` | REJECTED (negative indices not supported in v1) |
| `whip` | `team["whip"]` (whole sub-object — `get` prints it; `set` requires a full object value as JSON) |

Numeric segments index arrays via `Number.parseInt`. Non-numeric segments on an array value REFUSE (e.g. `members.foo` is an error). Segments are NOT escaped — keys containing `.` literally (which Zod schema doesn't currently produce) are out of v1 scope; future ADR can add escape grammar if needed.

`unset` on a path that doesn't exist is a no-op (exit 0, audit-log row with `old: null`). Idempotent.

### D7 — Type coercion rules

CLI args are strings; values need typing for the Zod gate:

| Input | Parsed as |
|---|---|
| `true` / `false` | boolean |
| `null` | null |
| `<int-regex>` (e.g. `42`, `-7`) | integer |
| `<float-regex>` (e.g. `3.14`) | float |
| `{...}` / `[...]` (starts with `{` or `[`) | JSON object/array (must round-trip `JSON.parse`) |
| `"..."` (starts AND ends with `"`) | string (quote-stripped) |
| Anything else | string |

The Zod-strict gate is the final arbiter — coercion is fail-closed at the schema layer (e.g. `set autoMerge.enabled "true"` coerces to the STRING `"true"`, then Zod rejects because the field expects boolean; operator re-runs without the quotes).

Edge case: setting a key to the literal string `"true"` (rare; the Zod schema would have to permit it). Pass with double-double-quotes: `atmux team set foo.bar '"true"'`. Documented in `--help`.

### D8 — Migration story for direct-edit hand-offs

Existing teams have arbitrary `team.json` state. First-time `atmux team set` on a team where the file is ALREADY drifted (typos, removed fields, manual additions Zod rejects) will REFUSE the write at the gate (D2). Migration path:

1. `atmux team get <path>` — operator inspects current state. (`get` does NOT round-trip Zod; it's a read path. Schema-drifted files still print fields.)
2. Manually edit `team.json` to remove the drift (or run `atmux team set <path> <value> --force` to add a CORRECT key alongside the drift; the gate STILL refuses on the post-mutation state, but `--force` bypasses).
3. Re-run `atmux team set` without `--force` once the file passes the gate.

**No automatic migration** — `set` is not responsible for cleaning up legacy team.json drift. Future ADR can add `atmux team migrate` for known-shape migrations (rename `foo` → `bar` across all teams); out of v1 scope.

## Implementation plan

T1 (this ADR) ships the spec ONLY. Execution slices file separately per the parent EPIC's decomp:

| T | Sub-task | Deps | Lane |
|---|---|---|---|
| T1 | Draft ADR-165 (this ADR) | — | docs |
| T2 | Pure helpers — `resolveDotPath(team, path)` / `applyDotMutation(team, path, value)` / `coerceCliValue(raw)` / `formatAuditRow(...)` in `src/core/team-config.ts`; same-commit unit tests at `tests/unit/core/team-config.test.ts` | T1 | be |
| T3 | Verbs — `atmux team set / get / unset` in `src/verbs/team/set.ts` / `get.ts` / `unset.ts`; same-commit unit tests at `tests/unit/verbs/team/{set,get,unset}.test.ts` | T1, T2 | be |
| T4 | Audit-log writer + dry-run wiring + `--force` plumbing + dispatch from `src/verbs/team.ts` | T1, T2, T3 | be |
| T5 | Same-commit doc sweep — `templates/briefs/lead.md` (operator-self-service note), `docs/RUNBOOK-config.md` (new — config-edit walkthrough), `CHANGELOG.md` (move `📋 Proposed` row to `🟢 Shipped` at T6 close) | T1 | docs |
| T6 | e2e — synthetic team in tmpdir; happy-path set/get/unset round-trip; schema-gate refuse path; --force bypass; backup file landing; audit-row appended | T2, T3, T4 | test |

Sub-task IDs file alongside this commit per `[[feedback_decomp_same_session_with_deps]]` — left to a follow-up session per the planner-routed decomp convention (T1 ships ADR-draft only; sub-task filing is the parent EPIC's responsibility per the Task body's explicit boundary).

## Open questions

**OQ-1 — Should `get` round-trip the Zod schema or print raw JSON?**

`get` today reads + parses + prints the value at `<dot.path>`. If the file is schema-drifted, the question is: print the raw value (helpful for migration; lets operators inspect drift) OR refuse and require `--force`-equivalent for drifted reads (consistent with the write-path's fail-closed gate)?

**Recommended default**: **raw JSON print** (no Zod round-trip on `get`). `get` is a diagnostic surface; the schema gate is for WRITE paths. Operators inspecting drift via `get` is exactly the migration use case D8 contemplates; refusing reads would force `cat .atmux/team.json | jq …` workarounds that defeat the verb's discoverability rationale.

**OQ-2 — Should `unset` of a schema-REQUIRED field refuse or silently drop?**

The Zod schema marks some fields required (e.g. `team.name`). `unset team.name` would produce a post-mutation object that fails the gate.

**Recommended default**: **refuse** (D2 gate fires). `--force` bypass is the escape hatch for operators who really mean to break the schema (mid-migration). Refusing on required-field unset matches the schema-as-source-of-truth posture.

**OQ-3 — Should the audit log live in `.atmux/logs/` or `.atmux/state/`?**

`logs/` is the existing convention for `gitter-sweep.log` + `ombudsman.log` (ADR-147). `state/` is for `eternal-improvement.json`, `whip-idle-state.json`, etc.

**Recommended default**: **`.atmux/logs/`**. The mutations log is append-only NDJSON, semantically a log not a state-file. Matches the existing `logs/` convention shape. Operators looking for "what changed in team.json?" will look in `logs/` by analogy.

## Cross-references

- **historical decision number 054 (no surviving ADR file) — strict-mode schema + drift detection**. The gate (D2) reuses historical decision number 054 (no surviving ADR file)'s `.strict()` posture verbatim. Drift detection on `Team.parse()` is the same boundary that the schema-gate enforces on every `set` / `unset`. (Note: historical decision number 054 (no surviving ADR file) file is not present in the worktree — referenced by code comments + sibling schemas; ghost-ADR similar to the pre-`t-75a79d7c` state of ADR-052. Out-of-scope follow-up: backfill historical decision number 054 (no surviving ADR file) like ADR-052 was just backfilled.)
- **ADR-098 — JSON + locking model**. D3 reuses `atmux::jq_update`'s flock-sidecar + tempfile-rename primitive verbatim. The ts-side `updateJson` helper at `src/abstractions/json.ts` is the ready-made TS port.
- **historical decision number 076 (no surviving ADR file) — kanban→SQLite migration**. Boundary marker: SQLite-resident state (kanban tasks, inboxes per historical decision number 076 (no surviving ADR file)) has different mutation primitives (BEGIN IMMEDIATE transactions per ADR-126); this verb governs the JSON-resident state ONLY (`team.json`, plus future `cockpit.json` if a sibling verb extends).
- **ADR-148 — commit-cadence**. Config-file edits are NOT git commits and MUST NOT advance the cadence verdict. The audit log lives in `.atmux/logs/` (D5), not in git history; cadence classifiers reading `git log --since=…` are unaffected.
- **ADR-097 — tmux abstraction**. Named by the Task body as a "config-surface conventions" cross-ref; the actual ADR-097 is the tmux abstraction layer, not config-surface. Listed here for completeness; not load-bearing.

## Out of scope

- **Cross-team batch edits** — `atmux team set across <team1> <team2>` to flip the same key on multiple teams. Future ADR if super-driver use case emerges.
- **Diff-based edits** — `atmux team set --patch <jsonpatch>` to apply RFC-6902 patches. Future ADR if the multi-key use case emerges.
- **Secret handling** — values are CLI args + audit-logged. Out of v1; future ADR can add `--secret <field>` to redact from audit log if needed.
- **`atmux cockpit set / get / unset`** — sibling verb for `cockpit.json`. Pattern is identical; out of T1 scope. Mirror this ADR's decisions when a sibling Task files.
- **Automated `atmux team migrate` for known-shape renames** — out of v1; manual migration path documented in D8.
- **SQLite-resident state mutations** — kanban / inboxes / state.db rows. Different primitive; not this verb's concern.
- **Schema impl + verb wiring + e2e** — T2-T6 per Implementation plan, separate Tasks.

## Acceptance gates (for T1 specifically)

- [x] `docs/adr/165-atmux-team-config-cli.md` exists with `Status: proposed`.
- [x] Pre-flight verify cited in commit body (`git log --all -- 'docs/adr/165-*'` empty before write; t-846e43dd holds ADR-164 slot; 165+ clean).
- [x] All 6 §Decision-anchors land as numbered prose (D1 verb namespace; D2 schema gate; D3 atomic write; D4 backup; D5 audit log; D6 dot-path) — plus D7 type coercion + D8 migration story as additional anchors per Task body's "Verb signatures + Zod gate + atomic write + backup semantics + audit log NDJSON + dot-path JSON-Pointer-lite + type coercion + migration story" surface enumeration.
- [x] Consumer matrix-equivalent — implementation plan table (T1-T6) with deps + lane assignments.
- [x] Cross-refs to historical decision number 054 (no surviving ADR file) / ADR-098 / historical decision number 076 (no surviving ADR file) / ADR-148 / ADR-097.
- [x] 3 OQs with recommended defaults (get-Zod-roundtrip; unset-required-field; audit-log location).
- [x] Out-of-scope §explicit on batch edits + secrets + cockpit sibling verb + migrate verb + SQLite state.
- [ ] Single commit; reviewer-gated. Reviewer flips Status proposed → accepted in a subsequent commit post-T6 ship.

T2-T6 acceptance gates are out of T1's scope per the Task body's explicit boundary.
