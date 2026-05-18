# Reviewer trunk-signoff — EPIC e-a3077ca0 (promoted from t-dd3316e3)

**Date**: 2026-05-18
**Reviewer**: epic-team reviewer (e-a3077ca0)
**Verdict**: ✅ **APPROVED** — ship to trunk
**EPIC**: e-a3077ca0 — window-name self-heal shim — `atmux start` rename + cross-format resolver
**Source branch**: `origin/geoyws-epic-e-a3077ca0`
**SHA chain** (linear, parent `cc29675` = prior EPIC fan-in):

| Task | SHA | Subject |
|---|---|---|
| T1+T7 | `86c0e4a` | `resolveWindowWithRenameShim` helper + 10 unit tests on the helper |
| T2 | `5f07a60` | wire `rotate.ts` |
| T3 | `1182e66` | wire `send.ts` (single-member + broadcast) |
| T4 | `f1e7744` | wire `dispatch.ts` (try-catch fallback) |
| T5 | `13ad850` | wire `lane-tick.ts` + `poke.ts` (non-lead path; lead I-2 marker preserved) |
| T6 | `0dcffae` | wire `tell-lead.ts` (ADR-029 §F6+F7 byte-equal error preserved) |
| T8 | `22a2df6` | doctor probe `legacy-window-name-format` (warn-class) |
| T9 | `8d6fc73` | CHANGELOG + ADR-161 §Amendment 2026-05-18 |

## AC coverage

EPIC body lists 9 sub-tasks T1–T9 + reviewer-trunk-signoff fire conditions. Coverage table:

| EPIC body clause | Implementation | Status |
|---|---|---|
| T1: `resolveWindowWithRenameShim()` helper at `src/core/common.ts`, accepts `(canonical, legacyVariants[], ops)`, atomic rename, dep-injectable tmux ops | `src/core/common.ts:483-499` — signature matches, `WindowShimOps` interface at `:411-416`, dep-injection covered | ✅ |
| T2: Wire into `src/verbs/rotate.ts` | `src/verbs/rotate.ts:273-302` — replaces `buildWindowName + windowExists + throw` with shim call | ✅ |
| T3: Wire into `src/verbs/send.ts` | `src/verbs/send.ts:267-285` (single-member via `resolveMemberTarget`) + `:402-414` (broadcast catch widens for `ConfigError`) | ✅ |
| T4: Wire into `src/verbs/dispatch.ts` | `src/verbs/dispatch.ts:204-245` — try-catch fallback to canonical preserves `ping failure does NOT abort` test gate | ✅ |
| T5: Wire into `src/verbs/lane-tick.ts` + `poke.ts` | lane-tick `:204-218` (shim ops dep) + `:281-284` (per-member resolution); poke `:416-450` (clarifier) + `:1639-1685` (`checkMember`, non-lead only) | ✅ |
| T6: Wire into `src/verbs/tell-lead.ts` | `src/verbs/tell-lead.ts:216-250` — maps `ConfigError` → ADR-029 §F6+F7 byte-equal `no tmux window for <lead.name> (is the team running?)` | ✅ |
| T7: Unit tests — (a) canonical exists / (b) hyphen-form / (c) no-separator / (d) none → throws | `tests/unit/core/common.test.ts:963-1009` — all 4 mandated cases present + (e) defensive `canonical+hyphen both exist → prefer canonical` at `:1013-1023` + 5 additional (gitter empty-variants × 2, ordering × 3) — **10 total** | ✅ |
| T8: Doctor probe `legacy-window-name-format`, operator-actionable warn-class | `src/verbs/doctor.ts::checkLegacyWindowNameFormat` `:2368-2516`, wired into `runAllChecks` `:2602-2606`, status `"yellow"`, hint `tmux -S <socket> rename-window -t <session>:<from> <canonical>` | ✅ |
| T9: CHANGELOG + ADR-161 §Amendment + memory update | `CHANGELOG.md` new `🟢 Fixed` block at top of `[Unreleased]` + `docs/adr/161-default-member-prefix-and-sort-verbs.md` new `## Amendment 2026-05-18` block | ✅ |

**Reviewer-trunk-signoff fire conditions** (per EPIC body):

| Condition | Status |
|---|---|
| T7 unit tests all green | ✅ Lead-reported `10 unit tests` on helper + per-wire counts (rotate 59/59, send 42/42, dispatch 23/23 + 222 cross-suite, lane-tick 371/371 cross-suite, tell-lead 30/30, doctor 302/302) |
| Production verify-poll `lane-tick: visited >= 6` on atmux parent cage + capture-error drops 2→0 | ⏳ POST-DEPLOY (out-of-scope for trunk signoff per lead message — separate post-merge probe) |
| CHANGELOG + ADR-161 §Amendment land | ✅ `8d6fc73` |

## Audit checklist (cumulative diff `86c0e4a^..8d6fc73`, 15 files, +1296/-72)

| Column | Verdict | Notes |
|---|---|---|
| **AC coverage** | ✅ | Every T1–T9 clause has code path + test. See table above |
| **Schema hygiene** | ✅ N/A | No schema changes |
| **Authz / boundary writes** | ✅ N/A | No tenancy / authz changes |
| **Secrets** | ✅ | No env / credentials / webhook strings introduced |
| **Test coverage on tracked paths** | ✅ | Every wired verb has paired test file changes; T1 helper has dedicated 10-case test block at `tests/unit/core/common.test.ts:935-1085` |
| **No bypass mechanisms** | ✅ | No `--no-verify`, `HUSKY=0`, `core.hooksPath=/dev/null`, `@ts-ignore`, or swallowed errors. Try-catch in T4 (dispatch fallback) + T5 (clarifier best-effort) + T6 (tell-lead error mapping) all explicit + commented with rationale |
| **Vocabulary** | ✅ | Prose uses lowercase `team-lead`/`planner`/`reviewer`/`ombudsman` as JSON literals; doc prose uses ADR-named tokens correctly |
| **ADR alignment** | ✅ | ADR-161 §Amendment 2026-05-18 names EPIC e-a3077ca0 + 6 wire-sites + helper signature + gitter exemption + carve-outs (epic-viewer + user-added members). No contradictions with existing §D2 |
| **`doc-update`** | ✅ | T9 (`8d6fc73`) carries CHANGELOG + ADR-161 amendment as a single atomic docs sweep per EPIC body convention ("T9 sweeps docs at the end"). New exported surface `resolveWindowWithRenameShim` + `WindowShimOps` is internal (consumed only within `src/verbs/*`) — not a package-boundary export, brief inventory exempts; documented anyway via the amendment for posterity |
| **`paneMatchesRegex` justification** | ✅ N/A | No new `paneMatchesRegex` call-sites introduced. All shim ops route through `tmux.window.listWindows` + `tmux.window.renameWindow` — neither is a pane-state classifier |
| **main/master push refuse** | ✅ N/A | No AC clause or commit body mentions push-to-main; merge path is epic-team auto-merge per ADR-091 |

## Lead-named hot-spots — independent verification

1. **T7 unit-test coverage of mandated cases (a/b/c/d) + (e) defensive**
   - `(a)` canonical exists → no rename — `tests/unit/core/common.test.ts:963-973`
   - `(b)` hyphen-form → rename → canonical — `:975-985`
   - `(c)` no-separator-form → rename → canonical — `:987-997`
   - `(d)` none exist → `ConfigError("no tmux window for <canonical>")` — `:999-1009`
   - `(e)` defensive: canonical + hyphen both exist → prefer canonical, no rename — `:1013-1023`
   - Plus 5 extras: gitter empty-variants happy path `:1027-1033`, gitter empty-variants throw `:1035-1042`, forward ordering `:1046-1058`, reversed ordering `:1060-1070`, canonical-in-legacyVariants skipped `:1072-1084`.
   - Coverage ratio: **10/10 helper test cases green** (CHANGELOG prose says "4 cases" — minor undercounting in the prose; actual coverage exceeds documented count, non-blocking).

2. **Gitter-exemption across 6 wires + doctor probe**
   - Mechanism: `buildWindowName(name, emoji, label, role)` returns `<emoji>-<member>` (hyphen) for `role: "gitter"` because gitter is NOT in `DEFAULT_MEMBER_ROLES` (verified at `src/core/common.ts:312` — `isDefaultMemberRole(role)` gate).
   - T2 rotate (`5f07a60`): canonical for gitter = hyphen-form; helper's internal `legacy === canonical → skip` de-dup at `src/core/common.ts:492` zeros out the rename attempt.
   - T3 send (`1182e66`): explicit `legacyVariants.filter((v) => v !== canonical)` at `src/verbs/send.ts:282` collapses `[adr135Hyphen, legacy]` → `[legacy]` for gitter (only no-sep stays as candidate variant; canonical hyphen never gets renamed).
   - T4 dispatch (`f1e7744`): same canonical/hyphen/no-sep build, helper-internal de-dup, plus try-catch fallback to canonical on miss — gitter hyphen preserved.
   - T5 lane-tick (`13ad850`): same de-dup; lead path explicitly NOT shimmed (I-2 marker preserved), non-default-role members hit canonical=hyphen.
   - T5 poke (`13ad850`): clarifier + `checkMember` non-lead path — same de-dup.
   - T6 tell-lead (`0dcffae`): same explicit filter at `:236`.
   - T8 doctor (`22a2df6`): `isDefaultMemberRole(m.role)` continue-gate at `src/verbs/doctor.ts:2493` excludes `gitter` / `committer` / `member` from probing; verified test `committer/member roles exempt` per commit message.
   - **Coverage ratio: 7/7 (6 wires + doctor probe) honor the gitter carve-out** via two independent mechanisms (`buildWindowName` role-aware canonical + caller-side de-dup filter).

3. **ADR-161 §Amendment cites EPIC e-a3077ca0 + 6 default-member wire-sites**
   - Header: `### 2026-05-18 — Self-heal shim for legacy default-member window names (EPIC e-a3077ca0)` ✅
   - Six wire-sites enumerated under `**Wire-sites**` block: rotate (T2 5f07a60), send (T3 1182e66), dispatch (T4 f1e7744), lane-tick + poke (T5 13ad850), tell-lead (T6 0dcffae) — counting T5 as one wire targeting 2 files = 6 explicit ADR-named clauses; doctor (T8 22a2df6) cited under separate `**Doctor probe**` block. Gitter exemption + carve-outs (epic-viewer + user-added) explicitly named.
   - Three observed formats enumerated correctly (canonical `_-prefix` / ADR-135 hyphen / pre-ADR-135 no-separator) matching the EPIC body's "THREE window-name formats" statement.
   - Cross-references to `[[project_adr_161_tr2_shipped]]` memory + ADR-159 pending preserved.

4. **T8 doctor probe = warn-class (not error) + operator-actionable rename one-liner**
   - `status: "yellow"` at `src/verbs/doctor.ts:2509` — warn-class confirmed.
   - `hint: \`tmux -S ${socket} rename-window -t ${sessionName}:${legacyName} ${canonical}\`` at `:2512` — copy-paste-ready, includes socket + session targeting.
   - Never blocks: not in the red-class gates; runs in `runAllChecks` after deps probe.
   - Idempotent: only flags if `windowNames.has(legacyForm)` AND `legacyForm !== canonical`; post-rename the live tmux state has only canonical, probe goes silent on next run.

## Adjacent vulnerability classes — what this audit does NOT cover

Per reviewer brief §2 (widen vulnerability class before declaring scope complete):

1. **Lead-path I-2 marker resolution** — `src/verbs/poke.ts::checkMember` and `lane-tick`'s lead branch intentionally bypass the shim to preserve `readLeadWindowName`'s post-rotate marker-fallback. **In-scope-by-design exclusion**; the rationale is documented in T5's commit body. The lead path still uses the existing `windowExists` check — not regressed by this EPIC, but a future EPIC could fold lead-path discovery through a marker-aware variant of the resolver.
2. **`atmux start`'s in-place rename shim** (§D2 of ADR-161) — this EPIC's premise is that the start-time shim already exists but doesn't fire on continuously-running cages. Not modified by this EPIC; the self-heal shim is additive.
3. **Cross-cage / cross-team window-name leak** — none of the wired verbs probe other teams' sockets except T8's doctor cockpit-walk (read-only `list-windows`, no rename across cages).
4. **Concurrent shim race** — `tmux rename-window` is a single server op; if two concurrent shim calls both find the legacy form, both will attempt rename — the second is a no-op (tmux silently allows renaming a non-existent window to the same canonical target if canonical already exists post-first-call). Not stress-tested in this EPIC; observed atomicity claim in the JSDoc is unverified at high concurrency but unlikely to be hit in production (single-driver cron cadence).
5. **Post-deploy production verify-poll** — out-of-scope for trunk signoff per lead's message; lead carries the post-merge probe.

## Non-blocking observations

- CHANGELOG prose says "T7 unit ... 4 cases" but `tests/unit/core/common.test.ts` carries 10 cases on `resolveWindowWithRenameShim` (the 4 mandated + 1 defensive + 2 gitter + 3 ordering). Actual coverage exceeds the documented count; consider tightening the CHANGELOG bullet on the next pass to "10 cases" so future readers don't undercount. **Not REJECT-worthy** — the four mandated cases are the floor and they're all present.
- Pre-existing `src/verbs/sync.ts:156` tsc error verified by lead message as orthogonal to this EPIC (be-1 + be-2 + T6 author all flagged independently). Not blocking per lead instruction.

## Decision

**APPROVED**. All EPIC AC clauses covered, hot-spots independently verified, audit checklist clean across 11 columns. Cumulative diff +1296/-72 across 15 files is within scope for a 9-sub-task EPIC (helper + 6 wires + probe + docs). No bypass mechanisms, no secrets, no schema regressions. ADR-161 §Amendment + CHANGELOG land in the same commit (T9) — `doc-update` gate satisfied per EPIC convention.

**Magic-value stamp deferral** (per reviewer brief §EPIC-done convention): `atmux task update` does NOT currently support `--extra` in deployed 0.8.4. The brief instructs epic-team reviewers to defer the `extra.role = 'reviewer-trunk-signoff'` stamp to driver/operator who can run a one-line `bun-eval` against the team's `state.db` (routed through `openDatabase` from `src/abstractions/sqlite.ts` to preserve the Zod boundary). **Driver / operator action**: stamp the EPIC-closing kanban Task (or the EPIC row directly) with `extra.role = 'reviewer-trunk-signoff'` so `src/verbs/epic-merge.ts::defaultResolveGate` advances the auto-merge state machine `in_progress → ready_to_merge`. Until that stamp lands, the EPIC stays in `in_progress` regardless of all other gates being clean — observed pattern per `project_adr_134_t3_t4_wiring_gap` memory.

Reviewer signoff complete. Reply lands at `lead-outbox.md` via `atmux reply`.
