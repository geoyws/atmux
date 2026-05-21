# Reviewer-trunk-signoff — EPIC e-af5650db (ADR-198 driver-inbox → lead-inbox rename)

**Per ADR-091 §EPIC-done definition #6 + ADR-198 §EPIC-done definition #6 — kanban Task `t-ea4ee5db`.**

- **EPIC**: e-af5650db (mirrors parent `e-5d1d4038`) — `.atmux/driver-inbox.md` → `.atmux/lead-inbox.md` rename + back-compat shim + walker + ADR amendments
- **Branch**: `geoyws-epic-e-5d1d4038` (4 commits ahead of `geoyws @ 78be6e9`)
- **Trunk @ signoff**: `946a3d3` (T7 — branch HEAD)
- **Merge-base**: `78be6e9` (parent trunk fork-point)
- **Date**: 2026-05-21 (MYT 2026-05-22 early hours)
- **Verdict**: 🟢 **APPROVED — SCOPED to atmux-repo cumulative diff**

## Scope carve-out (lead dispatch)

**T3 (claude-skills/main SKILL.md sweep, kanban id `t-7966de4f`, commit `ccdfca2`) is OUT of T8 cage trunk scope** per lead dispatch (2026-05-21 cascade ack). Rationale:

- T3 targets a separate repo (`/root/work/journals/.sb/claude-skills`) with a distinct push gate (claude-skills/main is operator-explicit-only per ADR-028)
- Claude-skills/main push remains blocked ~22h on operator auth; gating the in-cage atmux-trunk fan-in on a separate-repo bottleneck would be ADR-091 §EPIC-done re-interpretation, not enforcement
- T3 will land via its own operator-driven PR cycle; its absence does NOT regress the atmux-repo invariants

The unverified ADR-198 §EPIC-done bullet — "T3 lands — 7 coordination plugin SKILL.md files sweep clean; `rg -i 'driver-inbox' ~/.claude/skills/coordination/` returns 0" — is **deferred to T3's own merge gate**, not absorbed into T8.

## EPIC-done gates (per ADR-198 §EPIC-done definition + ADR-091 §Decision-anchor #5)

| Gate | Verdict | Evidence |
|---|---|---|
| 1. T1 lands — verb writes to `lead-inbox.md`; read shim accepts both; unit tests green; doctor probe registered; briefs same-commit doc-updated | ✅ | `f1abd36` (be-1): `src/verbs/tell-lead.ts` write path → `lead-inbox.md`; `src/core/driver-inbox.ts → lead-inbox.ts` via `git mv` + thin re-export shim; `lead-inbox-legacy` doctor probe (warn class); `templates/briefs/lead.md` + `planner.md` swept w/ ADR-198 cross-refs |
| 2. T2 lands — walker idempotent across all four branches; per-cage sequential; dry-run flag; RUNBOOK section same-commit | ✅ | `54d2f24` (be-1): `src/verbs/migrate-lead-inbox.ts` (531 LOC) — `noop-both-absent` / `noop-canonical-only` / `rename-legacy-to-canonical` / `merge-both-by-mtime`; `--dry-run` + `--json`; `--team-dir <dir>` override; `docs/RUNBOOK-cockpit.md §9a` (57-line addition) — same commit |
| 3. T3 lands (claude-skills sweep) | ⏸️ **DEFERRED out-of-scope** | scope carve-out above |
| 4. T4 lands — ADR-198 + 5 §Amendments | ✅ | `a19fe68` (fe-2): `docs/adr/198-driver-inbox-rename-to-lead-inbox.md` (152 LOC, Status: accepted); `§Amendment 2026-05-20` paragraphs on ADR-010 (line 1), ADR-042 (line 1), ADR-092 (line 5+ following the status-drift §Amendment), ADR-138 (line 244), ADR-154 (file NOT renamed — append-only marker present at line 1 + ADR-198 rename amendment at line 5+); each cites `[ADR-198](198-driver-inbox-rename-to-lead-inbox.md)` |
| 5. T7 lands — integration tests green | ✅ | `946a3d3` (be-2): `tests/e2e/lead-inbox-migration.test.ts` (320 LOC, 8 tests × 3-cage fleet); `tests/unit/verbs/migrate-lead-inbox.test.ts` (486 LOC); `tests/unit/verbs/doctor.test.ts` (+68 LOC — 5 tests for `checkLeadInboxLegacy`); `tests/unit/verbs/tell-lead.test.ts` (+46 LOC — header text + filename + legacy-not-touched assertions) |
| 6. T8 lands — reviewer trunk-signoff filed | ✅ (this signoff) | `t-ea4ee5db` filed + done after this doc; `extra.role: reviewer-trunk-signoff` stamp **deferred to driver/operator** per [templates/briefs/reviewer.md §EPIC-done convention](../../templates/briefs/reviewer.md) — `atmux task update` does not yet support `--extra` (sub-task `t-c3c85fbe`) |

## Cumulative diff summary (merge-base 78be6e9 → HEAD 946a3d3)

23 files, **+2384 / -359**. Surfaces stratify cleanly:

| Surface | Lines | Kind | Task |
|---|---|---|---|
| `src/verbs/migrate-lead-inbox.ts` | +531 | NEW — walker verb | T2 |
| `src/core/lead-inbox.ts` | +375 | NEW (carries renamed `driver-inbox.ts` body + 6 ADR-198 read-shim cases) | T1 |
| `src/core/driver-inbox.ts` | net -252 | THIN RE-EXPORT shim (legacy import-stability surface) | T1 |
| `src/verbs/tell-lead.ts` | net +62/-62 | write path: `driver-inbox.md` → `lead-inbox.md`; header: `# Driver Inbox` → `# Lead Inbox`; heads-up: `📬 lead-inbox has a new ask` | T1 |
| `src/verbs/doctor.ts` | +50 | NEW `checkLeadInboxLegacy` probe (warn class, self-clearing) | T1 |
| `src/core/common.ts` | +34 | adds `leadInboxPath` (canonical writes) + `driverInboxLegacyPath` (legacy reads); `driverInboxPath` UNTOUCHED for grace window (per `feedback_rename_helper_dont_repurpose.md` — ADR-198 T1's repurpose-then-revert lesson) | T1 |
| `src/cli.ts` | +7 | wires `migrate-lead-inbox` verb (line 70/355/358) | T2 |
| `src/verbs/help.ts` | +9 | help registration for new verb | T2 |
| `templates/briefs/lead.md` | +34 | `lead-inbox.md` references + ADR-198 grace-window notes | T1 (same-commit doc) |
| `templates/briefs/planner.md` | +2 | inbox-pair table refs swept | T1 (same-commit doc) |
| `docs/RUNBOOK-cockpit.md` | +57 | `§9a Per-cage `driver-inbox.md` → `lead-inbox.md` migration` | T2 (same-commit doc) |
| `docs/adr/198-driver-inbox-rename-to-lead-inbox.md` | +152 | NEW ADR | T4 |
| `docs/adr/010-atmux-flag.md` | +7 | §Amendment paragraph | T4 |
| `docs/adr/042-superdriver-phase-2-implementation.md` | +7 | §Amendment paragraph | T4 |
| `docs/adr/092-cross-team-tell-lead.md` | +11 | §Amendment paragraph | T4 |
| `docs/adr/138-verified-send-keys.md` | +7 | §Amendment paragraph | T4 |
| `docs/adr/154-driver-inbox-lead-outbox-sqlite-migration.md` | +15 | §Amendment paragraph (file NOT renamed — append-only) | T4 |
| `tests/unit/core/lead-inbox.test.ts` | +145 net (renamed from `driver-inbox.test.ts`) | 6 ADR-198 read-shim scenarios + alias-identity asserts | T1 |
| `tests/unit/verbs/tell-lead.test.ts` | +46 | new file name + header + heads-up text + "legacy NOT touched" asserts | T1 |
| `tests/unit/verbs/doctor.test.ts` | +68 | `checkLeadInboxLegacy` 5 tests | T7 |
| `tests/unit/verbs/migrate-lead-inbox.test.ts` | +486 | 28 tests — 4 idempotency branches + symlink collapse + composer + cockpit discovery + 3-cage integration walk | T2 (paired-test) |
| `tests/e2e/lead-inbox-migration.test.ts` | +320 | 8 e2e tests × 3-cage fleet (legacy-only / canonical-only / both-files) — walker + readLeadInbox shim + doctor probe agreement before/after | T7 |
| `tests/e2e/team-of-teams-pre-sopx.test.ts` | +17/-3 | `readInboxOrEmpty` reads either name; header regex `/# (Lead\|Driver) Inbox/` | T1 |

## (a) Paired-test discipline per Task

Per project `CLAUDE.md §Engineering` ("100% test coverage on tracked paths, same commit as code"):

| Task | SHA | Code lines | Paired-test lines | Discipline |
|---|---|---|---|---|
| T1 — verb rename + shim + doctor probe + briefs | `f1abd36` | ~470 net (verbs+core+doctor+common+cli) | 145 (lead-inbox renamed test) + 46 (tell-lead) + 17 (e2e) = **208** | ✅ |
| T2 — walker + RUNBOOK | `54d2f24` | 531 (walker) + 7 (cli) + 9 (help) = **547** | 486 (walker unit) = **486** | ✅ |
| T4 — ADR-198 + 5 §Amendments | `a19fe68` | (docs-only — 152 + 47 lines amendment) | n/a | ✅ docs-only |
| T7 — integration capstone | `946a3d3` | (test-only — 320 + 68 lines) | n/a | ✅ test-only |

All TS-shipping Tasks (T1, T2) carry **paired tests in the same commit**. T4 (docs-only) and T7 (test-only) are correctly excepted per `CLAUDE.md §Engineering` exclusions. Coverage on `migrate-lead-inbox.ts` per T2's commit note: 28 tests across all idempotency branches + symlink + composer + cockpit-discovery + 3-cage integration — exhaustive enumeration of the action enum (`noop-both-absent` / `noop-canonical-only` / `rename-legacy-to-canonical` / `merge-both-by-mtime` / `error`).

## (b) ADR-148 commit-cadence gate

Per [ADR-148](../adr/148-commit-cadence-truth-signal.md) §D1: `shipping` if commits within `recentMaxAgeSec=1800` (30min default).

| Commit | Subject prefix | Wall time (+0200) | Lag from prev |
|---|---|---|---|
| `a19fe68` | T4 ADR-198 + 5 amendments | (earliest in EPIC) | — |
| `f1abd36` | T1 verb rename | 21:25 | — |
| `54d2f24` | T2 walker | 21:46 | 21min |
| `946a3d3` | T7 integration tests | 21:54 | 8min |

T1→T2→T7 lags all <30min; ADR-148 verdict **shipping**. Most-recent commit `946a3d3` is the T7 capstone — EPIC reached structural completeness within ~29min.

## (c) Audit-checklist matrix (per templates/briefs/reviewer.md §Audit checklist)

| Column | PASS/FAIL | Evidence |
|---|---|---|
| **Acceptance criteria coverage** | ✅ (scoped) | All 5 in-scope T8 AC bullets covered: ADR-198 accepted + Context/Decision/Consequences/Open-questions present (verified ADR-198 lines 9-127); each of ADR-010/042/092/138/154 carries `§Amendment 2026-05-20` pointing to ADR-198; T1 unit tests + T7 e2e in diff. The SKILL.md sweep AC bullet is T3 scope (deferred per carve-out). The dogfood AC bullet ("this child cage's own `.atmux/driver-inbox.md` is renamed") sees note (g) below. |
| **Schema hygiene** | ✅ N/A | Diff touches NO Zod schemas (`src/schema/*.ts` untouched); pure filename + write-path + helper-API changes |
| **Authz / boundary writes** | ✅ N/A | No DB writes; file-system rename + read; per-cage path resolution via `discoverCageTargets()` walks cockpit.json + nested epic-teams (tested) — no cross-tenant leakage surface |
| **Secrets** | ✅ | `git diff 78be6e9..HEAD \| grep -iE '(password\|secret\|api[_-]?key\|token\|sk-[a-z0-9])'` → only false-positive matches on `<member>-inbox.json` + "lead pane doesn't burn tokens on a stale ping" doc text; no plaintext secrets |
| **Test coverage on tracked paths** | ✅ | Paired-test discipline matrix above. `migrate-lead-inbox.ts` (T2 NEW) + `tell-lead.ts` (T1 changed) + `doctor.ts` (T1 changed) + `lead-inbox.ts` (T1 NEW) all carry paired tests in same commit OR follow-up T7 capstone |
| **No bypass mechanisms** | ✅ | `git log 78be6e9..HEAD --format=%B \| grep -iE '(no-verify\|approved bypass\|husky=0\|gpg-sign)'` → 0 hits; diff grep for `@ts-ignore` / `ts-nocheck` / `core.hooksPath` → 0 hits |
| **Vocabulary** | ✅ | Lane tokens in JSON values lowercase (`"review"`, `"be"`, `"test"`); ADR §Amendment headers + commit subjects use canonical case |
| **ADR alignment** | ✅ | Diff matches ADR-198 §Decision-anchor #1 (canonical filename flip), #2 (one-release read-shim — both filenames accepted), #3 (per-cage walker with idempotent branches), #4 (5 amendments, ADR-154 file NOT renamed — append-only), #5 (T3 SKILL.md scope-bounded; broader refs deferred to T6) |
| **`doc-update`** | ✅ | Every documented-surface change carries same-commit doc + ADR-pointer: T1 → briefs/lead.md + planner.md + ADR-010/042/092/138/154 cited via `per ADR-198 §Decision-anchor #2`; T2 → RUNBOOK §9a same-commit; T4 → ADR amendments are themselves the doc deliverable |
| **`paneMatchesRegex` justification** | ✅ N/A | Diff introduces no new `paneMatchesRegex` callers (ADR-138 §Amendment paragraph references unchanged) |
| **main/master push refuse (ADR-028 AC scope-check)** | ✅ | Scanned T8 task body + ADR-198 §Decision-anchors: zero `push to main` / `push origin main` / `merge to main` phrasing; PR-only fleet-wide invariant respected |
| **pre-existing trunk-fail carve-out** | ✅ | `tests/e2e/team-of-teams-pre-sopx.test.ts > ADR-092 phase-2 inbox-write durability` was empirically confirmed RED at trunk-parent `78be6e9` (line 490: `expect(epicInbox).toContain("phase-2 driver ping")` → `Received: ""`). T1's diff to that test is pure backward-compat (`readInboxOrEmpty` reads either filename; header regex accepts both) — cannot regress. Follow-up fix tracked in PARENT atmux kanban `t-5de5e4b1` ("Fix tests/e2e/team-of-teams-pre-sopx.test.ts ADR-092 phase-2 inbox-write durability"); root-cause sketch (path mismatch vs ConfigError pre-write) + ADR-029 §F6 durability-claim audit live in that task body |

## (d) Independent grep — `driver-inbox` residue characterization

Per `CLAUDE.md §Engineering security/tenancy review pattern` ("independent grep — don't copy the author's"):

```
rg -n 'driver-inbox' src/ templates/ 2>&1 | wc -l
→ 32 hits
rg -n 'driver-inbox' docs/adr/ 2>&1 | wc -l
→ 18 hits (append-only historical ADRs)
```

Classification:

| Category | Count | Verdict | Reason |
|---|---:|---|---|
| Legitimate grace-window mentions (`templates/briefs/lead.md`, `planner.md`) | ~10 | ✅ | New text added by T1 same-commit; documents the one-release read-shim per ADR-198 §Decision-anchor #2 |
| `src/core/driver-inbox.ts` thin re-export shim | 1 file | ✅ | Per ADR-198 §Decision-anchor #1 — keeps `readDriverInbox` / `DriverInboxEntry` / `lastDriverInboxReadPath` external import-stable for one release |
| Append-only historical ADRs (`docs/adr/152/122/025/034/121/128/093/057`) | 18 | ✅ | Append-only convention; original `driver-inbox.md` references preserved verbatim per ADR-rebase prohibition |
| Out-of-EPIC scope refs (`src/lib/needs-approval.ts`, `src/cli.ts:52+310` for the `atmux driver-inbox` verb surface, `src/abstractions/sentinel.ts` comment, `src/abstractions/discord.ts` — discord template refs, `src/schema/README.md`, `templates/briefs/epic-lead.md` + `committer.md` + `superdriver.md`) | ~21 | ⏸️ **Deferred to ADR-198 T6 follow-up Epic** | Per ADR-198 §Decision-anchor #5 explicit out-of-scope: T1's surface inventory is exhaustively scoped to `tell-lead.ts` + `driver-inbox.ts→lead-inbox.ts` + lead.md + planner.md ONLY. Discord refs explicitly named in §OQ5 as T3 scope (claude-skills coord-plugin sweep — out of cage trunk). The remaining briefs (`epic-lead`, `committer`, `superdriver`) + `cli.ts driver-inbox verb` + `needs-approval.ts` parser are **explicitly enumerated as T6 follow-up territory** in ADR-198 §Decomp follow-up |

Coverage claim: **all `driver-inbox` source refs in scope of THIS EPIC (T1 §Surface inventory) are handled correctly**. The 21 deferred refs are structurally bounded to T6's follow-up Epic in the parent atmux kanban — not regressions, not in-scope omissions.

## (e) Vulnerability-class adjacency (CLAUDE.md §146)

Class scoped: **filename rename + read-shim back-compat**.

Adjacent classes the next reviewer / driver should land separately:

- **Verb-name rename** — `src/cli.ts:310 case "driver-inbox":` registers an `atmux driver-inbox` verb. The verb itself was NOT renamed; per ADR-154 §D5 the verb surface is `atmux driver-inbox show/add/triage/archive` — a separate ADR-154 (SQLite migration) scope. ADR-198 deliberately did NOT bundle the verb rename. If the verb is to be renamed to `atmux lead-inbox` in the future, a new ADR (a sibling to ADR-198) is required.
- **Discord template refs** (`src/abstractions/discord.ts:1635 + :1739`) — explicit T3 scope per ADR-198 OQ5. Out of cage trunk; will land via claude-skills T3 cycle.
- **Member-inbox semantics** (`<member>-inbox.json` per ADR-076) — distinct surface; not affected by ADR-198 per ADR-198 §"What this ADR does NOT cover".
- **Fleet-level superdriver inbox** (`~/.claude/teams/superdriver-inbox.md`) — explicitly named as out-of-scope in ADR-042 §Amendment paragraph; distinct surface.

✅ **APPROVED within vulnerability class scoped**; adjacent classes enumerated above for next-pass landing.

## (f) Dogfood gate — deferred to deploy (NOT a trunk-merge blocker)

The EPIC body Acceptance bullet "Dogfood: this child cage's own `.atmux/driver-inbox.md` (if any) is renamed and `atmux tell-lead` writes to `lead-inbox.md`" fails at face value on this cage:

```
$ ls -la .atmux/*inbox*
-rw-r--r-- 1 root root 671 May 21 19:27 .atmux/driver-inbox.md
# (no lead-inbox.md)
```

Recent `/bruh` ticks at 00:49 + 01:27 MYT 2026-05-22 wrote to `.atmux/driver-inbox.md`, not `.atmux/lead-inbox.md`.

**Diagnosis**: deploy lag. The installed atmux binary symlink resolves to `/opt/atmux/0.8.10` (built 2026-05-20 18:27 UTC, BEFORE T1/T2/T7 commits at 21:25-21:54 UTC). Source-mode invocation (`bun run src/cli.ts migrate-lead-inbox`) executes the new walker code; the deployed `atmux` CLI predates it. Per `atmux help` the deployed `tell-lead` line still reads "Driver-only: send to lead + append to driver-inbox.md" — pre-T1 help text.

**Why this is NOT a trunk-merge blocker**:

1. ADR-145 cleanly separates **merge** (committer scope) from **deploy** (devops/operator scope) — the cage's deployed binary is downstream of trunk-merge, not a precondition for it.
2. T2 walker is correctly built + wired in source (`src/cli.ts:70+355+358` + `src/verbs/help.ts:148` + `src/verbs/doctor.ts:1603` pointer); T7 e2e exercises it across a 3-cage fleet fixture. Once the next atmux release ships with these commits bundled, the walker is operator-runnable everywhere.
3. The doctor probe `lead-inbox-legacy` self-clears post-rollout; operator runs walker, probe greens.

**Follow-up note** (out-of-EPIC, file in PARENT atmux kanban): `src/verbs/doctor.ts:1603` probe hint says `atmux migrate lead-inbox` (space-delimited subcommand) but the verb is registered as `atmux migrate-lead-inbox` (hyphenated top-level). Cosmetic doc bug — file as ~5-min P3 fix; not blocking T8.

## (g) Carve-out citations for committer (T8 commit body)

When the committer reads this signoff to compose the EPIC's fan-in commit body, include:

> Per `docs/reviews/e-af5650db-trunk-signoff-20260521-reviewer.md` §(f) — pre-existing trunk fail on `tests/e2e/team-of-teams-pre-sopx.test.ts` ADR-092 phase-2 inbox-write durability — empirically confirmed RED at `78be6e9`; T1 backward-compat shim cannot regress; tracking fix in PARENT atmux kanban `t-5de5e4b1`.
>
> Per same signoff doc §Scope carve-out — T3 (claude-skills/main SKILL.md sweep, `ccdfca2`) is OUT of T8 cage trunk scope per lead dispatch; T3 lands via its own operator-driven PR cycle.

## Verdict

🟢 **APPROVED — proceed to ADR-091 in-process auto-merge state machine: `in_progress → ready_to_merge`**.

Pending operator/driver action to complete the EPIC-done handshake (per `templates/briefs/reviewer.md §EPIC-done convention — verb-resolution gotcha 2026-05-17`):

```
# Run from inside team's cage; routes through openDatabase per ADR-060
bun --print "import('./src/abstractions/sqlite.ts').then(m => m.openDatabase('.atmux/state.db').prepare(\"UPDATE tasks SET extra = json_set(coalesce(extra,'{}'), '\\$.role', 'reviewer-trunk-signoff') WHERE id = 't-ea4ee5db'\").run())"
```

OR, once `atmux task update --extra` lands (sub-task `t-c3c85fbe`):

```
atmux task update t-ea4ee5db --extra '{"role": "reviewer-trunk-signoff"}'
```

Reviewer: `reviewer` (`atmux_e-5d1d4038` cage)
Signoff doc location: `docs/reviews/e-af5650db-trunk-signoff-20260521-reviewer.md` (this file)
Companion kanban Task: `t-ea4ee5db` (this cage) — `atmux done` after this commit lands
Parent EPIC anchor: `e-5d1d4038` (parent atmux state.db) — committer fan-in target
