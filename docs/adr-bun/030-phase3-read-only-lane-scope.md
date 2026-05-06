# ADR-030: Phase 4a parity matrix iter-3 read-only lane scope (refs ADR-026, ADR-027)

**Status:** proposed
**Date:** 2026-05-06
**Owner:** parity-read-impl

## Context

Iter-2 (ADR-027) closed ADR-026 rows 3 + 6 — 4 state-mutating happy-path rows (`task add` variants, `lifecycle` preset, INSERT class) + 4 error-rendering rows (`init` / `start` / `send` / `add-member` with the iter-2 3-pattern stderr mask). `PARITY_MATRIX` now has 10 active rows; `compare.ts` channel-mask infrastructure + per-side fixture cloning are operational; iter-2 mask vocabulary covers two divergence classes: error-rendering (style) + state-after (random IDs / epoch).

Phase 4a (per HANDOFF "PHASE 4 RUSH" + lead-outbox 2026-05-06 ~11:16 MYT) parallelises five matrix-expansion lanes: cron-fired (ADR-028), state-mutating UPDATE/DELETE (ADR-029), **read-only (this ADR — ADR-030)**, lifecycle (ADR-031), and error-class (ADR-032). Each lane scopes its own per-verb output channels + mask classes before row commits land, mirroring ADR-026's iter-1 carve-out shape.

This ADR scopes the **read-only lane** — verbs that emit observable output without mutating `.atmux/` state (or whose only state mutation is a lazy-materialise stub that both sides write identically). Target verbs from the dispatch: `status`, `doctor`, `dashboard`, `inbox` (read), `cost`. Dispatch target: ~8–12 rows; PLAN.md §14 acceptance is FUNCTIONAL — zero divergence on stdout / stderr / exit / fs across the in-scope rows, NOT row count.

### Probe-time channel inventory

Reading lib/{status,doctor,dashboard,inbox,cost}.sh ↔ src/verbs/{status,doctor,dashboard,inbox,cost}.ts side-by-side surfaced the following divergence shapes. The runner already sets `NO_COLOR=1` (runner.ts:182), so ANSI is stripped on both sides — no ANSI mask class needed.

| Verb | Mode | Channels | Divergence shape | Class |
|---|---|---|---|---|
| `status` | text | stdout, exit | header column-widths differ (bash `member role tui pane inbox`, TS `member role tui pane inbox` with wider padding); driver-inbox.md present-but-empty → bash emits `📬 driver-inbox  open=0` line, TS only emits when `> 0` (status.ts:258-260) | **read-render** (new) |
| `status` | `--json` | stdout, exit | TS adds `driverInboxOpen` field (status.ts:191) bash does not; `members[]` shape divergence — bash preserves all team.json fields per member via jq `$base + {…}`, TS hand-picks `{name,role,tui,paneCommand,pendingCount}` (status.ts:184-188) | **DEFER iter-4** (needs JSON-canonical-stdout mask) |
| `doctor` | `--quiet` | exit | both sides skip render in quiet mode → stdout/stderr empty; exit code agreement (0 green, 1 any-red) is the contract | none |
| `doctor` | text | stderr (bash + TS render to stderr), exit | path-suffix divergence (`.bash`/`.ts` per-side fixture clone in `state-dir … writable at <path>` row); discord-hint text differs (bash one-liner vs TS XDG-fallback chain); TS adds `single-session-discouraged` + `phantom-inbox` rows bash doesn't emit | **DEFER iter-4** (multi-divergence; row-set carve-out + JSON canonical needed) |
| `doctor` | `--json` | stdout, exit | bash uses `jq -cn` (compact), TS uses `JSON.stringify(., null, 2)` (pretty) → byte-divergent; same row-set divergence as text mode | **DEFER iter-4** (JSON-canonical-stdout mask + row-set carve-out) |
| `dashboard` | interactive loop | stdout (full-screen redraw), exit on signal | screen-clear ANSI (`\e[2J`, `\e[H`), tick-driven sleep, SIGINT-trap exit message → not single-shot testable through current runner contract | **DEFER iter-4+** (separate dashboard-loop harness ADR — analogous to ADR-028 cron-runner) |
| `dashboard` | no-team error | stderr, exit | `requireTeam` dies before render loop; same shape as iter-2 error-rendering rows | **iter-2 error-rendering** (reuse vocabulary) |
| `inbox <member>` | text | stdout, exit, fs (lazy materialise) | both lazy-write `inboxes/<member>.json` first time read; bash echoes compact `{"pending":[],"inProgress":[],"done":[]}` while TS goes through `updateJson` (pretty) — but `compare.ts` JSON-canonicalises fs files so byte-diff is irrelevant; stdout matches byte-for-byte under `NO_COLOR` (header + 3× `(empty)` sections both sides) | none |
| `inbox <member>` | `--json` | stdout, exit, fs | bash `cat "$f"` emits compact, TS `JSON.stringify(., null, 2)` emits pretty | **DEFER iter-4** (JSON-canonical-stdout mask) |
| `inbox` (no args) | usage error | stderr, exit | bash `atmux::die "usage: …"` exit 1 + emoji prefix, TS `UsageError` exit 64 + structured-tag prefix | **iter-2 error-rendering** (reuse 3-pattern mask + exitCode-skip) |
| `inbox <bogus>` | config error | stderr, exit | bash `atmux::member_json` dies, TS `ConfigError` thrown; same prefix divergence + exit 1 vs 78 | **iter-2 error-rendering** (reuse) |
| `cost` | text | stdout, exit, fs (`state/cost-<m>.json` cache) | both write identical zero-shape JSON for `tui:"shell"` lifecycle members → fs canonical-equal; stdout has tz-render divergence — bash `date -d @0 +'%Y-%m-%d %H:%M:%S'` uses LOCAL tz (MYT = UTC+8 → `1970-01-01 08:00:00`), TS `formatEpochUtc` pins UTC (`1970-01-01 00:00:00`) — cost.ts:411-416 cite | **timezone-render** (new) |
| `cost` | `--json` | stdout, exit, fs | both pretty-print 2-space; cache files canonical-equal; no timestamp in JSON shape (`{totalUsd, members}`) → no mask needed | none |
| `cost` (no args) | no-team error | stderr, exit | `requireTeam` dies same as iter-2 error rows | **iter-2 error-rendering** (reuse) |

### Two new mask classes introduced

ADR-027 §"Out of plan" §"Mask classes beyond error-rendering + state-after" anticipated incremental class additions. This ADR adds two:

1. **`ADR-030 read-render class`** — divergent rendering of read-only output where neither side is "wrong" but the surface bytes differ. Symptoms: column-width disagreement, conditional-emission disagreement (one side always-emits, other side gates on a count). Mask: anchored regex that elides the divergent line/segment on both sides. Banned: regex broad enough to absorb semantic content (per ADR-027 §4).

2. **`ADR-030 timezone-render class`** — divergent timestamp rendering where bash uses host-local tz and TS pins UTC (per ADR-012 + cost.ts:411-416 explicit UTC pin "so test output is deterministic regardless of host timezone"). Symptoms: `YYYY-MM-DD HH:MM:SS` substrings differ by host UTC-offset hours. Mask: regex eliding the `YYYY-MM-DD HH:MM:SS` substring on both sides. Per ADR-027 §4 cite-locality, mask cites this class in inline `// reason:` comment on each entry.

Both classes integrate with existing `ChannelMask` shape (matrix.ts:46-51); no `compare.ts` infrastructure changes required.

## Decision

ADR-030 read-only lane scope is **9 matrix rows** across 4 verbs (`status`, `doctor`, `inbox`, `cost`) — each row carries its mask class inline + `// reason:` cite per ADR-027 §4. `dashboard` contributes ONE error-path row only; the interactive loop is deferred to a separate dashboard-loop harness ADR.

| Row | Verb | Args | Fixture | expect | Channels | Mask classes |
|---|---|---|---|---|---|---|
| 1 | `status` | (none) | `lifecycle` | `exit-zero-stable-stdout` | stdout, exit | **read-render** — strip header line `^member +role +tui +pane +inbox\s*$\n` + `^📬 driver-inbox  open=\d+\n` |
| 2 | `doctor` | `--quiet` | `lifecycle` | `exit-zero-stable-stdout` | exit (stdout/stderr empty) | none — green-path agreement is the contract |
| 3 | `doctor` | `--quiet` | `minimal` | `exit-nonzero-stable-stderr` | exit (stdout/stderr empty) | none — both red on missing team.json, exit 1 vs exit 1 |
| 4 | `inbox` | `lead` | `lifecycle` | `exit-zero-stable-stdout` | stdout, exit, fs | none — `NO_COLOR=1` strips bash ANSI + TS plain; sections match byte-for-byte; fs canonicalised |
| 5 | `cost` | `--json` | `lifecycle` | `exit-zero-stable-stdout` | stdout, exit, fs | none — both pretty 2-space; no tz in JSON shape; cost-cache JSON canonical-equal |
| 6 | `cost` | (none) | `lifecycle` | `exit-zero-stable-stdout` | stdout, exit, fs | **timezone-render** — strip `since \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}` substring |
| 7 | `inbox` | (none) | `lifecycle` | `exit-nonzero-stable-stderr` | stderr, exit | **iter-2 error-rendering** — `exitCode: true` (1 vs 64) + 2-pattern stderr (prefix + path-suffix; no `init` hint phrasing) |
| 8 | `inbox` | `bogus` | `lifecycle` | `exit-nonzero-stable-stderr` | stderr, exit | **iter-2 error-rendering** — `exitCode: true` (1 vs 78) + 2-pattern stderr (prefix + path-suffix) |
| 9 | `dashboard` | (none) | `minimal` | `exit-nonzero-stable-stderr` | stderr, exit | **iter-2 error-rendering** — `exitCode: true` (1 vs 78) + 3-pattern stderr (prefix + path-suffix + hint phrasing — same as `start`/`send` rows) |
| 10 | `cost` | (none) | `minimal` | `exit-nonzero-stable-stderr` | stderr, exit | **iter-2 error-rendering** — same 3-pattern mask as row 9 |

Variant coverage:
- Happy text: `status` / `inbox <m>` / `cost`.
- Happy JSON: `cost --json` (the only one whose JSON shape doesn't trip a deferred class).
- Quiet exit-only: `doctor --quiet` × 2 fixtures (green path + missing-team red path).
- Error-rendering: `inbox` (2 paths — usage + config-no-such-member), `dashboard` no-team, `cost` no-team. Reuses iter-2 vocabulary; no new patterns.

### Mask schema authoring per ADR-027 §3 + §4

Each row's `mask:` block carries inline `// reason:` cites referencing one of:
- `(ADR-027 error-rendering class)` — for prefix / path / hint masks shared with iter-2 rows.
- `(ADR-027 state-after class)` — N/A for this lane (no state-mutating rows).
- `(ADR-030 read-render class)` — for `status` row 1 header-line + driver-inbox-line elision.
- `(ADR-030 timezone-render class)` — for `cost` row 6 since-render elision.
- `(ADR-006 BSD sysexits)` — for `exitCode: true` skips, identical to iter-2.

Reviewer's grep target stays unchanged: every `mask:` block carries an adjacent `// reason:` line citing one of the above class labels.

### NOT in scope of THIS commit (per ADR-022 / ADR-025 / ADR-026 craftsmanship pattern)

- **`compare.ts` infrastructure changes.** ADR-030's two new mask classes (read-render, timezone-render) are **labels** consumed by the existing `ChannelMask.stdout` / `ChannelMask.stderr` regex infrastructure. No new `ChannelMask` keys; no new helpers in `compare.ts`. ADR-027's `applyChannelMask` already covers both classes.
- **Matrix row authoring.** This ADR pins the 9-row set; the actual `PARITY_MATRIX = [...]` lines land in commit 2 (`test(parity): 4 read-only happy-path rows (status/doctor/inbox/cost, ADR-030 rows 1-6)`) and commit 3 (`test(parity): 4 read-only error rows (inbox/dashboard/cost no-team, ADR-030 rows 7-10)`).
- **Dashboard interactive-loop harness.** Per the deferred-row table; iter-4+ via a separate dashboard-loop ADR (analogous to ADR-028's cron-runner pattern). Re-enable handle: when iter-4+ adds a `tests/parity/dashboard-loop-runner.ts` with `maxFrames` injection + signal-based shutdown probe, `dashboardLoop` becomes parity-testable.
- **JSON-canonical-stdout mask class.** Defers `status --json` / `inbox --json` / `doctor --json` rows. Re-enable handle: when a `ChannelMask.stdoutJson?: true` flag (or equivalent) lands in `compare.ts`, parsing both sides' stdout as JSON + canonical-comparing — analogous to the `fs` channel's existing JSON treatment. ADR-027 amendment + new helper. Iter-4 lead-off candidate.
- **Doctor row-set carve-out.** TS `doctor` emits TS-only check rows (`single-session-discouraged`, `phantom-inbox`). Iter-4 needs either a row-id-set mask (filter rows by label before byte-diff) OR a TS-side flag suppressing TS-only rows in parity mode. Out of scope here.
- **ADR-006 amendment.** TS keeps BSD sysexits + structured-tag stderr; bash side stays frozen. No exit-code reconciliation.
- **Bash-side rendering changes.** Bash status header widths, bash discord-hint phrasing, bash inbox `cat "$f"` JSON shape — all frozen per ADR-026 §"NOT in scope". The mask absorbs the divergence harness-side.

### Re-enable handles for deferred rows

| Deferred | Re-enable trigger |
|---|---|
| `dashboard` interactive loop | iter-4+ dashboard-loop runner ADR + `maxFrames`/signal injection |
| `status --json` / `inbox --json` / `doctor --json` | iter-4 JSON-canonical-stdout mask class (ADR-027 amendment) |
| `doctor` text + JSON full row-set | iter-4 row-set carve-out (filter TS-only check rows) |
| `cost` with non-zero historical jsonl files | iter-4 multi-team preset + `~/.claude/projects/<slug>/` fixture seeding |

## Migration plan (this ADR's commit chain)

1. **Commit A — `docs(adr-bun): ADR-030 — phase3 iter-3 read-only lane scope (refs ADR-026, ADR-027)`**: this ADR file. Reviewer gates against ADR-026 + ADR-027 to verify it's a scope carve-out + mask-class extension (not an infrastructure rewrite). Two new class labels added without `compare.ts` changes.
2. **Commit B — `test(parity): 4 read-only happy rows (status/doctor/inbox/cost, ADR-030 rows 1-6)`**: rows 1–6 added to `PARITY_MATRIX`; new mask classes cited inline. Reviewer's `mask:` grep verifies all class labels present.
3. **Commit C — `test(parity): 4 read-only error rows (inbox/dashboard/cost no-team, ADR-030 rows 7-10)`**: rows 7–10 added; mask vocabulary identical to iter-2 (no new patterns).
4. **Commit D (optional, conditional on iter-3 surface findings) — `docs(adr-bun): ADR-030 update — N rows iter-3 actual delivery`**: post-landing summary mirroring ADR-026 §"Iter-2 actual delivery" shape.

Each commit standalone-passes typecheck + 100% coverage gate (the parity tests themselves are excluded from the lcov denominator per ADR-009 §2). Reviewer gates each commit per the 8-check protocol (PLAN.md §9). Reviewer scans this ADR against ADR-026 + ADR-027 to verify it's a scope + class-label addition, not a shape redesign.

## Out of plan / future work

- **Iter-4 mask-class additions.** JSON-canonical-stdout (defers four `--json` rows here); row-set carve-out (defers full doctor coverage); dashboard-loop runner (defers interactive loop). Each is its own ADR.
- **`status` member[] field-set reconciliation.** TS hand-picks 5 fields per member; bash preserves all team.json fields. Either TS extends to mirror bash (out of scope per ADR-026), bash strips down (out of scope per ADR-026 §Scope — bash frozen), or iter-4 adds a JSON field-elision mask. Neutral until JSON-canonical-stdout class lands.
- **`doctor` row-set unification.** TS adds `single-session-discouraged` + `phantom-inbox` checks bash doesn't have. Either iter-4 adds row-set mask (filter by check-label) or TS-side suppression flag. Decision deferred — current `--quiet` rows prove the green-vs-red contract without comparing render strings.
- **Cost cache invalidation logic.** Both sides currently re-parse on every run — there's no read-side cache hit. Whip-cron porter (V-25) may add invalidation; if so, parity rows for `cost` may need a mtime-mask class to avoid divergence on cache-mtime drift across the parallel `runVerb` pair.

## Consequences

- **9 new matrix rows + 1 dashboard error row land in 2 row commits + 1 ADR commit** (rows 1–6 in commit B, rows 7–10 in commit C) — within dispatch's "~8–12 rows" target. Total `PARITY_MATRIX` size grows from 10 → 19.
- **Two new mask classes (read-render, timezone-render) extend ADR-027 vocabulary** without requiring `compare.ts` changes. Both consumed by the existing `applyChannelMask` regex path. iter-4+ adds JSON-canonical-stdout / row-set when their re-enable handles fire.
- **Three deferred classes carry durable handles** (dashboard loop / JSON-canonical-stdout / doctor row-set). No "TODO" rot — each is a named iter-4 lead-off candidate.
- **`dashboard` interactive loop deferral** preserves PLAN.md §14 functional-parity target without forcing single-shot harness contortions. The error-path row exercises `requireTeam` precondition agreement — sufficient for ADR-019 V-24-style "in-scope subset" coverage.
- **`status` text + `inbox` text are byte-equal under `NO_COLOR`** (the runner already sets it). The read-render class fires only on `status`'s header + driver-inbox conditional, not on `inbox` — narrow-scope mask per ADR-027 §4.
- **`cost` text mode rejects host-tz drift via timezone-render mask** rather than reconciling rendering. ADR-012 (time-and-timezone) keeps TS at UTC for determinism; bash keeps host-local for operator-friendliness; the harness absorbs the divergence.
- **Reviewer's `mask:` grep target stays a single line** — every block has an adjacent `// reason:` cite. Adding read-render + timezone-render labels does not require new grep tooling.
- **Iter-3 ships ~80 LOC of matrix-row entries** (≈ 8 LOC × 10 rows + masks) without `compare.ts` LOC. Compare iter-2's `14644d6` (132 LOC of `compare.ts` infra) — iter-3 is ~5× cheaper because the infrastructure was already paid for.
