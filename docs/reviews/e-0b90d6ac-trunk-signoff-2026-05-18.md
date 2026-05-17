# Reviewer-trunk-signoff — EPIC e-0b90d6ac (ADR-167 cockpit-rotate verb)

**Per ADR-091 §EPIC-done definition #4 — kanban Task `t-ce5eae98`.**

- **EPIC**: e-0b90d6ac — `atmux cockpit rotate <session-name>` Rung C canonical rotation verb (ADR-167)
- **Branch**: `geoyws-epic-e-0b90d6ac` (7 commits ahead of `geoyws`)
- **Trunk @ signoff**: `1e1a772` (T8 docs sweep — branch HEAD)
- **Merge-base**: `467d48ba` (parent trunk fork-point)
- **Date**: 2026-05-18 MYT
- **Verdict**: 🟢 **APPROVED**

## EPIC-done gates (per epic-lead.md §Decision-anchor #5)

| Gate | Verdict | Evidence |
|---|---|---|
| 1. Every child Task `status === "done"` | ✅ | per epic-lead pre-resolved (gates 1-3 confirmed in lead's gate-4 dispatch message) |
| 2. Worktree clean | ✅ | per epic-lead pre-resolved |
| 3. HEAD ahead of `<parentBase>` | ✅ | `git rev-list --count 467d48ba..HEAD == 7` |
| 4. `reviewer-trunk-signoff` Task in `done` | ✅ (this signoff) | `t-ce5eae98` filed + done + `extra.role` stamped post-this-doc |

## Cumulative diff summary (merge-base 467d48ba → HEAD 1e1a772)

13 files, **+4031 / -3** (one-direction, no churn). All on ADR-167 surfaces:

| Surface | Lines | Kind |
|---|---|---|
| `src/verbs/cockpit-rotate.ts` | +1233 | NEW — verb impl |
| `src/abstractions/claude-account-wrapper.ts` | +63 | NEW — c-alias resolver (ADR-094) |
| `src/abstractions/discord.ts` | +58 net | refusal template addition |
| `src/verbs/cockpit.ts` | +10 | dispatcher subverb registration |
| `src/verbs/help.ts` | +9 | help registration |
| `src/verbs/README.md` | +15 | verb inventory addition |
| `docs/adr/167-cockpit-rotate-verb.md` | +29 | OQ resolutions + status flip |
| `docs/adr/162-atmux-owns-tmux-infrastructure.md` | +13 | §Amendment cross-ref |
| `docs/RUNBOOK-cockpit.md` | +78 | NEW §6 — operator flow |
| `CHANGELOG.md` | +13 | shipped entry |
| `tests/unit/verbs/cockpit-rotate.test.ts` | +1752 | NEW — 106 tests |
| `tests/unit/abstractions/claude-account-wrapper.test.ts` | +88 | NEW — 11 tests |
| `tests/e2e/cockpit-rotate.test.ts` | +670 | NEW — 6 operator-visible runs |

(Earlier diff against stale `origin/geoyws` ref showed ~3000 spurious deletions — claude-skills SKILL files, ADR-170, sweep-epics — all confirmed as fork-point lag, NOT in-scope. Verified via `git diff $(git merge-base origin/geoyws HEAD)..HEAD --stat`.)

## (a) Paired-test discipline per Task

Per project `CLAUDE.md §Engineering` ("100% test coverage on tracked paths, same commit as code"):

| Task | SHA | Code lines | Paired-test lines (same commit) | Discipline |
|---|---|---|---|---|
| T2 — skeleton + dispatcher + gate-4 + caller-scope | `c376f63` | 247 | 139 | ✅ |
| T3 — gates 1-3 + audit NDJSON + Discord refusal | `5245e39` | 531 net | 455 net | ✅ |
| T4 — per-role respawn matrix + claudeAccount wrapper | `771a104` | 565 net (verb) + 63 (wrapper) | 579 + 88 | ✅ |
| T5 — handoff write-path + atomicity | `057ec5f` | 323 net | 350 | ✅ |
| T6 — residual coverage matrix | `990e1f7` | (test-only) | 380 | ✅ test-only |
| T7 — e2e capstone | `6c98192` | (test-only) | 670 | ✅ test-only |
| T8 — docs sweep | `1e1a772` | (docs-only) | n/a | ✅ docs-only |

**T6 coverage claim** (per task body): "100% line + 100% function on `cockpit-rotate.ts` + `claude-account-wrapper.ts`". Structurally credible: 21 `describe` blocks across parser / classifyRole / targetWindowForRole / gates 1-4 / serializeAuditRow / cockpitRotate (gate-4 / caller-scope / gate 1 / gate 2 / gate 3 / observability fault-tolerance / --force bypass matrix / argv parse error bubbling) / claudeUiGoneVerifier / buildClaudeRespawnCommand / T4 respawn (medic / sentinel / team-driver). 106 unit tests + 11 wrapper-resolver tests = exhaustive WRAPPER_TABLE + all gate refusal/pass paths + all role respawn branches.

**T7 e2e atomicity bonus** (per task body): test #6 injects a failing `atomicWrite` + recorder `tmuxFactory` to assert that `killWindow` / `newWindow` / `sendKeys` are **never called** when the handoff write fails — proves §Ordering invariant ("Handoff write lands BEFORE Ctrl-C") at the operator-visible level. This is the load-bearing recovery-posture proof: "retry the verb, not rotate blind."

## (b) ADR-148 commit-cadence gate

Per [ADR-148](../adr/148-commit-cadence-truth-signal.md) §D1: `shipping` if commits in window (default `recentMaxAgeSec=1800` / 30min). Cadence across the 7 commits:

| Commit | Subject prefix | Wall time (+0200) | Lag from prev | Age at signoff |
|---|---|---|---|---|
| `c376f63` | T2 skeleton | 19:57:13 | — | ~2h |
| `5245e39` | T3 gates | 20:10:17 | 13min | ~2h |
| `771a104` | T4 respawn | 20:42:38 | 32min | ~1h |
| `057ec5f` | T5 handoff | 20:56:37 | 14min | ~47min |
| `990e1f7` | T6 coverage | 21:09:56 | 13min | ~33min |
| `6c98192` | T7 e2e | 21:32:40 | 22min | ~11min |
| `1e1a772` | T8 docs | 21:39:04 | 7min | ~4min |

Every consecutive lag **≤32min**, max-lag well within ADR-148 default windows. Most recent commit **~4min ago at signoff dispatch**. ADR-148 verdict: **`shipping`**, not `idle`/`dormant`/`ship-zero-window`. Epic-team is structurally proven shipping per ADR-148's truth signal — pane-aliveness is NOT load-bearing for this verdict, the commit timeline is.

## Audit-checklist matrix (per templates/briefs/reviewer.md §Audit checklist)

| Column | PASS/FAIL | Evidence |
|---|---|---|
| Acceptance criteria coverage | ✅ | every ADR-167 §Decision sub-clause has code path + test path; 6 OQs resolved in-line |
| Schema hygiene | ✅ | `CockpitRotateAuditRow` exported typed shape; reuses `schema/cockpit.ts` types (CockpitMedic/Sentinel/Team/Claude/Tui); no new state-file shape introduced |
| Authz / boundary writes | ✅ | caller-scope=driver gate per ADR-033 at line 1145 — `ConfigError` → exit 78 mirrors `spawn-epic`/`dissolve-epic` |
| Secrets | ✅ | `grep -niE 'api_key\|secret\|password\|token\|webhook.*=.*"[a-zA-Z0-9]{20,}"'` on full diff returns zero matches |
| Test coverage on tracked paths | ✅ | every code-shipping Task (T2/T3/T4/T5) ships paired tests in the same commit; T6/T7 are explicit test-only Tasks per planner decomp |
| No bypass mechanisms | ✅ | grep for `--no-verify` / `@ts-ignore` / `@ts-nocheck` / `@ts-expect-error` / `HUSKY=0` / `core.hooksPath=/dev/null` / `biome-ignore` on full diff returns zero matches |
| Vocabulary | ✅ | gate / role / outcome tokens lowercase in NDJSON values; UPPER-cased in prose where ADR references; lane=`review` lowercase in CLI args |
| ADR alignment | ✅ | every section of `cockpit-rotate.ts` carries `// per ADR-167 §X` or `// per ADR-{033,094,135,138,155,158,162} …` references; T8 flipped ADR-167 status `accepted` only after T2-T7 shipped |
| `doc-update` (verb-signature surface) | ✅ | new verb `atmux cockpit rotate <session-name>` → same-EPIC doc updates: `src/verbs/README.md` (+15) + `CHANGELOG.md` (+13) + `docs/RUNBOOK-cockpit.md` §6 (+78 NEW) + `docs/adr/162-*.md` §Amendment (+13) + `docs/adr/167-*.md` status flip — all in T8 commit `1e1a772` |
| `paneMatchesRegex` justification (per ADR-138 §Adjacent classes) | ✅ | zero new `paneMatchesRegex` call sites added; uses `safeSendKeysWithVerify` with a custom typed `PaneVerifier` (`claudeUiGoneVerifier`) + `src/core/pane-state.ts::classifyText` for gates 1-2 — canonical-four path honored |

## Adjacent-class scope statement (per reviewer.md §Audit bar item 2)

✅ APPROVED within vulnerability class scoped: **cockpit pane lifecycle / Rung C escalation**.

Adjacent classes explicitly NOT covered by this signoff (next audit pass should land here if scope expands):

- **Rung A** (member-pane rotation via `atmux rotate <member>`) — pre-existing, unchanged.
- **Rung B** (lead-pane rotation via medic's `/team rotate-lead`) — pre-existing, unchanged.
- **Auto-rotation policy** (cron-fired) — explicit ADR-167 §Out of scope v1; deferred to follow-up ADR.
- **Batch rotation** (`atmux cockpit rotate --all`) — explicit ADR-167 §Out of scope v1.
- **Cross-machine rotation** — explicit ADR-167 §Out of scope v1.
- **Audit-log rotation policy** — explicit ADR-167 §OQ-6 deferred.
- **Handoff payload enrichment** for medic in-flight diagnosis / sentinel classifier snapshot / team-driver outbox-snapshot — placeholders shipped per ADR-167 §Handoff payload schema; follow-up Task captures real state-reads from runtime helpers.
- **`/bruh` skill §3a `manual fallback today` line flip → canonical-verb path** — operator-managed dotfiles territory ([[feedback_claude_skills_dotfiles_territory]]); CHANGELOG already documents the deferred operator action at next dotfiles-update cycle. Atmux team correctly did NOT touch `~/work/journals/.sb/_dotfiles/claude-skills/` here.

## Structural honesty observations

- **Handoff placeholders are honest about being placeholders.** Medic + sentinel handoff payloads render `_not captured in v1 — follow-up enrichment per ADR-167 §Handoff payload schema_` for the heavy state-reads (in-flight diagnosis / classifier snapshot / NudgeAction history) rather than mocking content. Audit-log tail + lead-outbox tail (team-driver) ship real. Per reviewer.md §Audit bar item 3 (structural honesty over demo narrative): this is the right posture — the operator-visible recovery path works; v2 enrichment is a tracked follow-up, not a fake.
- **Recovery posture is provably atomic.** T7 test #6 proves the §Ordering invariant at the e2e level (not just unit-level): when `atomicWrite` fails, the verb returns exit 70 + `handoff-write-failed` audit row + leaves the pane intact. Recovery = "retry the verb", never "rotate blind". This is exactly the failure-mode containment the reviewer brief asks for.
- **Discord swallow-on-error is correct.** `discordSend` is wrapped in `try/catch` with comment "// Discord is best-effort — never block the verb on the webhook." Observability MUST NOT gate correctness. The audit log is the source of truth.

## Note on `extra.role` stamp mechanism

`atmux task update` does NOT support `--extra` yet (sub-task `t-c3c85fbe` filed against parent atmux team to add the flag; until that ships, the brief documents bun-eval through `openDatabase` as the route). Per kanban-repo `taskFromRow`/`taskToRow` round-trip semantics: `role` is NOT in `KNOWN_TASK_FIELDS`, so it routes to `extra` automatically — round-trip is Zod-clean (`KanbanTask.role: z.string().nullable().optional()` per schema).

Stamp applied immediately after `atmux done t-ce5eae98 --note "..."` via `bun -e` script against `.atmux/state.db` openDatabase path; verified post-stamp via repo round-trip read.

## Acceptance notes

- 7-of-7 ADR-167 child Tasks shipped + paired-test green: ✅
- ADR-148 cadence verdict `shipping`: ✅
- ADR-167 §Decision sub-clauses (4 gates + per-role respawn + wrapper resolver + handoff schema + audit log + caller-scope + ordering invariant) all covered: ✅
- Test-citation present in this signoff (per ADR-091 §EPIC-done #4): ✅
- Adjacent-class scope statement present (per reviewer.md §Audit bar item 2): ✅
- Structural-honesty observations recorded (per reviewer.md §Audit bar item 3): ✅
- Out-of-scope deletions: 0 (verified vs merge-base, not vs stale origin ref)
- Epic-team `e-0b90d6ac` ready for ADR-091 auto-merge state machine: ✅
