# ADR-121: Phase 4a parity matrix — cron-fired lane scope (refs ADR-119, ADR-120)

**Status:** proposed
**Date:** 2026-05-06
**Owner:** parity-cron-impl

## Context

Phase 4a expands the parity matrix into the four lane-buckets the planner
carved out: cron-fired (this ADR), state-mutating (ADR-122, owned by
parity-state-impl), read-only (ADR-123, owned by parity-read-impl), and
lifecycle (ADR-124, owned by up-impl). Error-class (ADR-125, whip-impl)
soft-waits on these four landing.

This ADR pins iter-1 of the **cron-fired** lane. The verbs in scope per
PLAN §14 + the dispatched task body: `whip`, `report`, `decisions-digest`,
`groom`. Target as briefed: ~12–16 rows × 4 prod-team state-shape presets
(atmux / sopx-mvp / ifca_aux / unum). PLAN §14 acceptance is FUNCTIONAL
parity (zero divergence on stdout / exit / state / discord webhook calls),
not row-count — the brief explicitly says optimize for COVERAGE, lane-trim
if velocity stalls.

ADR-119 row 5 already deferred this whole class:

> Cron-fired scenario parity (whip / report / decisions-digest / groom) —
> ❌ iter-2+ — these verbs run from cron with an implicit time-of-day
> argument; parity testing them requires a cron-aware test runner that
> injects a frozen clock. Re-enable handle: when `tests/parity/cron-runner.ts`
> lands (separate ADR; not scoped here).

ADR-120 §"Out of plan / future work" echoes the same: a cron-aware mask
harness is on the iter-3+ list.

This ADR closes that durable handle for what's reachable TODAY using only
the existing harness primitives (per-row channel masks per ADR-120,
fixture preset materialisation per ADR-119 + factory.ts), and re-defers
what remains with sharper handles than ADR-119 row 5 had room for.

### Survey findings (HEAD `1d2157d`, 2026-05-06)

The dispatched body listed 4 cron-fired verbs. Survey of `src/verbs/` +
worktree-frozen `lib/` shows these state-of-port facts:

| Verb | TS port | Bash worktree spec | Reachable for iter-1? |
|---|---|---|---|
| `whip` | ✅ `src/verbs/whip.ts` (952 LOC) | ✅ `lib/whip.sh` (218 LOC, frozen-subset per ADR-115 carve-out) | Partial — only the no-session fast-path is reachable without a tmux-shim fixture extension (see §Decision row 2). |
| `report` | ✅ `src/verbs/report.ts` (313 LOC) | ✅ `lib/report.sh` (84 LOC) | ✅ Reachable — but a content-shape divergence surfaces (see §Surfaced findings). |
| `decisions-digest` | ❌ Not a verb in `src/verbs/`. The original survey missed `lib/decisions.sh` on the bash side; correction landed 2026-05-06 (see §F2-corrected). | ✅ `lib/decisions.sh` (684 LOC, multi-subcommand: `add` / `list` / `show` / `digest`). Cron-fired every 4h via `lib/cron.sh:71` (`0 */4 * * * atmux decisions digest`). | ⚠️ Deferred — TS port absent. Bash-only output capture is feasible NOW for fixture-shape pinning; full parity blocks on TS port at `src/verbs/decisions.ts`. |
| `groom` | ❌ Not ported. `src/verbs/start.ts:64-66` explicit comment: "groom verb not yet ported". The original survey missed `lib/groom.sh` on the bash side; correction landed 2026-05-06 (see §F2-corrected). | ✅ `lib/groom.sh` (503 LOC, top-level verb: `groom [--dry-run] [--quiet] [--kanban-days N] [--decisions-days N] [--keep-bak N]`). Cron-fired daily via `lib/cron.sh:77` (`0 4 * * * atmux groom --quiet`); also fired on every `atmux start` per `lib/start.sh:398`. | ⚠️ Deferred — TS port absent. Bash-only output capture is feasible NOW for fixture-shape pinning; full parity blocks on TS port at `src/verbs/groom.ts`. |

Two harness facts that bound the iter-1 row design:

1. **Discord channel is structurally broken for cron-fired today.**
   `tests/parity/intercept-discord.ts:14-20` documents that bash-side
   support for `ATMUX_DISCORD_RECORDER` is a porter-B Phase 2 follow-up
   per ADR-101. The runner sets `ATMUX_DISCORD_WEBHOOK=""` so the bash
   side's `atmux::discord_ping` early-returns with zero captured calls;
   the TS side's `discord.send` honours the recorder env var and
   captures structured calls. **Result:** for any row that exercises a
   discord-emitting code path with bash-recorder still absent, bash
   captures `[]` and TS captures the call → divergence. Iter-1
   sidesteps this with `--no-discord` on every report row (both sides
   skip → empty discord parity is honest). When bash recorder lands,
   iter-2 enables discord-side rows.

2. **Existing `compare.ts:52` mask covers `\d{2}:\d{2} MYT` (bash's
   `now_myt` shape) but does NOT cover `formatMytFull`'s
   `YYYY-MM-DD HH:MM:SS MYT` shape.** `report.ts:264` calls
   `formatMytFull(nowMs)`. This is **a divergence the parity matrix
   should surface, not paper over** — see §Surfaced findings below.

## Decision

Iter-1 of the cron-fired lane lands `report` rows + a single `whip`
no-session fast-path row, on a new lifecycle-extension fixture preset
(`cron-tasks`). All multi-team variants + decisions-digest + groom + the
discord-emitting rows + the live-tmux whip rows defer with explicit
re-enable handles.

| Item | Status | Reason |
|---|---|---|
| `report --no-discord` row on `lifecycle` preset (empty kanban) | ✅ iter-1 | Exercises the `Shipped:0` + `In-progress (none)` branches of report's body builder. No factory.ts edit needed — `lifecycle` preset already ships an empty kanban. `--no-discord` sidesteps the bash-recorder gap. |
| `report --no-discord` row on `cron-tasks` preset (mixed shape — 1 done + 1 in-progress + 1 blocked + 1 driver-inbox open ask) | ✅ iter-1 | Exercises ALL 4 body sections (Shipped + In-progress + Blocked + Open asks) in one row. Realistic atmux-team-style shape per the dispatched body's first variant (the body said "1 done + 4 in-progress, 4 active members"; we ship 1-of-each so each section is exercised — the count differential is parity-irrelevant since both sides iterate identically). Existing `HH:MM MYT` global mask + ADR-120 `stateAfter` mask for `last-report.epoch` cover the noise channels. |
| `whip` no-session fast-path row on `minimal` preset — no tmux session live, no team.json → bash + TS both refuse with `atmux::require_team` / `requireTeam` | ✅ iter-1 (cheap sanity row) | Single-row deterministic test that whip's pre-team-validation path matches across sides. Useful as harness-shape sanity check + regression guard against future `requireTeam` drift. |
| Golden-file harness primitive (`runBashOnly` mode + `tests/parity/golden/<row-id>.txt` snapshot convention + `ATMUX_PARITY_UPDATE_GOLDENS=1` capture flag) | ✅ iter-1 | Required by the 6 baseline rows below. Per lead verdict (2026-05-06): bash-only-side capture mode for verbs whose TS port is absent. When TS port lands, parity row auto-flips bash↔TS without re-baselining (golden serves as the bash truth). New code at `runner.ts` (~30 LOC for `runBashOnly`-style spawn that skips TS), new helper at `compare.ts` (`compareGolden`), new dir `tests/parity/golden/`, new field `ParityRow.bashOnly?: true` + `ParityRow.bashBin?: string` (per-row `BIN_BASH` override). See §Golden-file harness mode below for the full spec. |
| `decisions digest` baseline rows on `cron-tasks-decisions` preset (parent atmux as bash bin via per-row `bashBin` override pointing at `/root/work/src/atmux/bin/atmux`) — 3 scenarios: empty pending-decisions / 1-entry / over-threshold (5+ entries) | ✅ iter-1 (per re-scope) | Bash side exists at parent `lib/decisions.sh` (684 LOC); cron fires `decisions digest 0 */4` per parent `lib/cron.sh:71`. Worktree-bun's `lib/` does NOT have `decisions.sh` (ADR-115/026 carve-out preserved); per-row `bashBin: "/root/work/src/atmux/bin/atmux"` override fires the parent binary against the fixture's `.atmux/`. Each row captures bash stdout + `stateAfter` snapshot to `tests/parity/golden/decisions-digest-<scenario>.txt`. When `src/verbs/decisions.ts` lands (Phase 4b), the rows auto-promote from bash-only to bash↔TS parity by removing `bashOnly: true` — golden is then redundant or kept as historical baseline. |
| `groom --dry-run` baseline rows on `cron-tasks-groom` preset (per-row `bashBin` override pointing at parent atmux) — 3 scenarios: clean kanban (nothing to sweep) / orphaned-task kanban (orphan parent epic) / over-threshold archived inbox tail | ✅ iter-1 (per re-scope) | Bash side exists at parent `lib/groom.sh` (764 LOC; lead's 503 was off — verified 2026-05-06); cron fires `groom --quiet 0 4` per parent `lib/cron.sh:77`; also fires on every `atmux start` per `lib/start.sh:398`. `--dry-run` flag is mandatory on every row to keep golden capture deterministic (no state mutation; sweep targets are reported but not executed). Fixture preset variants pre-seed the kanban / archive tails / .bak.* files needed to exercise each sweep branch. Each row captures bash stdout + `stateAfter` snapshot to `tests/parity/golden/groom-<scenario>.txt`. Auto-promotes when `src/verbs/groom.ts` ships. |
| Per-row scenario expansion using `ParityRow.preState` hook (state-impl's ADR-122 mechanism at `tests/parity/pre-state.ts::applyPreState`) — adds 3-4 sub-scenario rows on `lifecycle` preset: shipped-only / in-progress-only / blocked+ask-only / nothing-to-report-after-recent-`last-report.epoch` | ❌ deferred to iter-2 (after ADR-122 lands) | Requires `ParityRow.preState` field added to matrix.ts type — owned by parity-state-impl per ADR-122. Cannot depend on unmerged work in iter-1. **Re-enable handle:** when ADR-122 + state-impl's preState commits land in main, this lane adds the expansion rows mechanically (no factory.ts churn — all per-row JSON injection on top of the existing `lifecycle` preset). Each sub-scenario exercises ONE body-section branch in isolation, giving sharper divergence-attribution than the mixed-shape row alone. |
| `cron-tasks` fixture preset extension to `factory.ts` — extends `lifecycle` materialisation with deterministic pre-seeded kanban entries (1 done w/ fixed `completedAt`, 1 in-progress, 1 blocked, 1 driver-inbox open ask) | ✅ iter-1 | Required by report rows. Coordinated cross-lane: up-impl confirmed (lead-outbox 11:46 MYT) iter-2 plan does NOT touch factory.ts; parity-state-impl coord ping pre-fixture-edit. Lands as commit 2 (after ADR), reviewer-gated before commit 3 (rows). Pre-seeded IDs are deterministic literals (`t-cron0001` / `t-cron0002` / etc.) so byte-equal post-mask. |
| `whip` live-tmux rows (per-member pane checks, idle threshold, lead uptime, banner detection) | ❌ deferred to iter-2 | Bash whip calls `tmux list-panes -t <session> -F #{pane_current_command}` and `atmux::capture_pane "$name" 30`. Reproducing pane state requires actually spawning a tmux session with windows + panes for each preset member. **Re-enable handle:** new harness primitive `tests/parity/fixtures/tmux-shim.ts` OR a `cron-tmux` preset that materialises a real tmux session (use `tmux -L atmux-parity-XXX new-session -d` with a deterministic socket name to isolate from the operator's live sessions). Estimated complexity: ~150 LOC + cleanup discipline. Separate ADR worth-it. |
| `report` discord-emitting rows (with `ATMUX_DISCORD_RECORDER` honoured by both sides) | ❌ deferred to iter-2 | `intercept-discord.ts:14-20` documents the bash-side recorder support is a porter-B Phase 2 follow-up per ADR-101. Until that lands, bash captures `[]` while TS captures structured calls → discord-channel divergence is hardcoded. **Re-enable handle:** porter-B's bash-side `atmux::discord_ping` recorder branch (one `if [[ -n "$ATMUX_DISCORD_RECORDER" ]]; then jq -n ... >> "$ATMUX_DISCORD_RECORDER"; return 0; fi` early-return at the top of `lib/discord.sh:7`). Once that ships, drop `--no-discord` from the iter-1 rows + add ChannelMask `discord?: true` for the `ts` field that the existing comparator already masks per `intercept-discord.ts:121`. |
| `decisions digest` parity rows | ⚠️ deferred to iter-2 (TS-port-blocking, not both-sides-absent) — **CORRECTED 2026-05-06** | Bash side EXISTS: `lib/decisions.sh` (684 LOC) implements `decisions add/list/show/digest`. Cron-fired every 4h via `lib/cron.sh:71`. The TS side is what's missing — no `src/verbs/decisions.ts`. **Re-enable handle:** TS port of `decisions` verb with at minimum the `digest` subcommand (consumes `decisions.json` cursor, posts Discord digest). Once `src/verbs/decisions.ts` lands, parity rows are mechanical adds against a `cron-tasks` extension preset that pre-seeds `decisions.json` with mixed pending/resolved entries. **Iter-1 partial path:** bash-only output snapshot rows (compare bash stdout/state against a frozen golden fixture, not against TS) are feasible NOW for shape pinning + regression catch on the bash side; flag as `bashOnly: true` in matrix.ts if parity-cron-impl elects to land them ahead of the TS port. |
| `groom` parity rows | ⚠️ deferred to iter-2 (TS-port-blocking, not both-sides-absent) — **CORRECTED 2026-05-06** | Bash side EXISTS: `lib/groom.sh` (503 LOC) implements `groom [--dry-run] [--quiet] [--kanban-days N] [--decisions-days N] [--keep-bak N]`. Cron-fired daily at 04:00 via `lib/cron.sh:77`; also fires on every `atmux start` per `lib/start.sh:398`. The TS side is what's missing — no `src/verbs/groom.ts` (the comment at `src/verbs/start.ts:64-66` confirms this). **Re-enable handle:** TS port of `groom` verb (top-level cron-fired hygiene sweep — flushes driver-inbox/lead-outbox `## Archive` tails into dated archives, summarizes done/cancelled kanban cards >N days, archives old decisions, culls `.bak.*` families). Once `src/verbs/groom.ts` lands, parity rows mechanically extend the existing `lifecycle` preset with seeded stale state (old archive tails, decisions older than `--decisions-days`, bak-files past `--keep-bak`) and assert post-state divergence-free. **Iter-1 partial path:** same bash-only snapshot path as `decisions digest` — flag as `bashOnly: true` if parity-cron-impl elects to land ahead of the TS port. |
| 4 prod-team state-shape variants (atmux / sopx-mvp / ifca_aux / unum) | ❌ deferred to iter-2 | `factory.ts:80-90` `multi-team` case throws `not yet implemented`; ADR-119 row 4 documents the deferral with a "CI surfaces 4-team-divergence demand" re-enable trigger. Iter-1 does NOT lift that trigger — the report verb's surface area doesn't visibly vary by team-name (it reads `team.name`, not tenant-isolated state-dirs). The `cron-tasks` preset implements the **atmux-team** state shape (the dispatched body's first variant: "kanban with 1 done + 4 in-progress, 4 active members, mid-iter") and that's sufficient for iter-1's coverage goal. **Re-enable handle:** iter-2 follow-up implements `multi-team` preset variants when (a) a verb's behaviour visibly varies by team-name OR (b) live-tmux whip rows want sopx-mvp's 6-member shape vs ifca_aux's 2-member-idle shape to exercise pane-count branches. |
| Cron-runner with frozen-clock injection (`tests/parity/cron-runner.ts`) | ❌ deferred to iter-2+ (per ADR-119 row 5 + ADR-120 out-of-plan) | Iter-1 doesn't need it — the existing `compare.ts:52` `HH:MM MYT` mask + ADR-120 `stateAfter` epoch mask cover all wallclock-derived divergences in `report` (and for the whip no-session fast-path, time isn't read at all). **Re-enable handle:** unchanged from ADR-119 row 5. When live-tmux whip rows land in iter-2, evaluate whether per-row timestamp masks suffice or whether a frozen-clock injector becomes cheaper; until then, mask-vocabulary path stays preferred. |

Rendering: matrix-driven `bun:test` rows produce one row label per
`(verb, args, fixturePreset)` tuple per ADR-102 §3. Iter-1 adds 9 rows
total + 1 fixture preset extension + 2 fixture preset additions + 1
harness primitive:

- **3 full bash↔TS parity rows**: 1 report on lifecycle-empty + 1
  report on cron-tasks-mixed + 1 whip no-session on minimal.
- **6 bash-only baseline rows** (per re-scope verdict 2026-05-06):
  3 `decisions digest` scenarios (empty / 1-entry / over-threshold)
  on `cron-tasks-decisions` preset + 3 `groom --dry-run` scenarios
  (clean / orphaned / over-threshold archive) on `cron-tasks-groom`
  preset. All use per-row `bashBin` override → parent atmux's
  `/root/work/src/atmux/bin/atmux`. Capture bash stdout +
  `stateAfter` to `tests/parity/golden/<row-id>.txt`.

Comparator output is `Divergence[]`. Bash-only rows compare against
the checked-in golden snapshot; full-parity rows compare bash↔TS as
existing.

The 9-row count is honest about the harness primitives reachable
today. The dispatched body's ~12-16 row target presumed (a) cron-runner
+ multi-team variants + (b) decisions-digest + groom existing on both
sides + (c) a per-row state-injection mechanism. (a) defers; (b) is
partial — bash exists, TS port absent, so iter-1 lands bash-only
baselines that auto-promote when TS ports land; (c) lands via
state-impl's ADR-122 and unblocks iter-2's per-row scenario expansion
(deferred row in the table above).

Exit codes:
- `0` — all rows green (zero divergences post-mask).
- nonzero — ≥1 row's `compare()` returned `Divergence[].length > 0`. Reviewer triages per ADR-102 §3.

## Golden-file harness mode (per re-scope verdict 2026-05-06)

This section pins the spec for the new harness primitive that unblocks
the 6 bash-only baseline rows above. Lead's verdict (2026-05-06): Q1=(a)
per-row `ATMUX_PARITY_BASH_BIN` env override pointing at
`/root/work/src/atmux/bin/atmux` for the groom + decisions rows
(preserves ADR-115 carve-out cleanly; runner.ts:39 change only); Q2=
golden-file snapshot harness (capture bash output now, check into
`tests/parity/golden/<row-id>.txt`, parity row reads golden + compares;
when TS port lands, parity row auto-flips bash↔TS without re-baselining
— golden serves as the bash truth).

### Spec

**`ParityRow` extensions (matrix.ts):**

```ts
export type ParityRow = {
  verb: string;
  args: ReadonlyArray<string>;
  fixturePreset: FixturePreset;
  expect: ParityExpectation;
  label?: string;
  mask?: ChannelMask;
  /**
   * When `true`, only the bash side runs. Output is compared against
   * a checked-in golden snapshot at `tests/parity/golden/<row-id>.txt`
   * (id = `label` slugified, falls back to `<verb>-<args.join("-")>`).
   * Use for verbs whose TS port is absent (per ADR-121: `decisions`,
   * `groom`); auto-promotes to full bash↔TS parity when this field is
   * removed AND the TS verb dispatcher routes the verb.
   */
  bashOnly?: true;
  /**
   * Per-row override for the bash binary. Defaults to runner.ts's
   * `BIN_BASH` (worktree's `bin/atmux`). Use to point at parent
   * atmux's `/root/work/src/atmux/bin/atmux` for verbs that exist on
   * the parent's lib/ but were intentionally excluded from worktree-bun's
   * carve-out per ADR-115 / ADR-119 (e.g. `decisions`, `groom`, `cron`).
   */
  bashBin?: string;
};
```

**Golden-file convention (tests/parity/golden/):**

- One file per bash-only row, named `<row-id>.txt`. Format: bash stdout
  exactly, post-mask (timestamp regex applied at write time so the
  golden is mask-stable across captures).
- Optional companion `<row-id>.state.json` for `stateAfter` snapshots
  of fixture's `.atmux/` shape (only when the row mutates state — most
  bash-only rows here use `--dry-run` so state-after is empty).
- Goldens are committed to git. `git diff` on a golden in code review =
  bash behaviour drift signal.

**Capture / update flag:**

- `ATMUX_PARITY_UPDATE_GOLDENS=1 bun test tests/parity/` writes/overwrites
  golden files with the bash side's current output. No comparison; the
  capture pass exits 0 unconditionally.
- Without the env var, golden-file rows compare bash output against the
  checked-in golden via `compareGolden(bash: ParityRun, golden: string):
  Divergence[]`. Empty array = green. Mismatch = `Divergence` row with
  `channel: "stdout"` and `detail: "golden mismatch at <row-id>"`.

**Runner extension (runner.ts):**

- New function `runVerbBashOnly(row: ParityRow, fixturePath: string)`
  OR fold into `runVerb` with `side: "bash" | "ts"` parameter and let
  `index.test.ts` decide which side to spawn based on `row.bashOnly`.
  Prefer the latter (less surface area).
- Per-row `bashBin` override: when set, pass to spawn instead of
  `BIN_BASH`. Existing global `ATMUX_PARITY_BASH_BIN` env-var path
  remains as a fallback (operator override).

**index.test.ts dispatch:**

- For each row: if `row.bashOnly === true`, spawn bash side only,
  read golden, call `compareGolden`. Else: existing bash+TS spawn +
  `compare`. Same outer test wrapper; just two branches inside.

**Update flag handling at test time:**

- When `ATMUX_PARITY_UPDATE_GOLDENS=1` is set, after the bash spawn
  and before the comparison, write the captured stdout to the golden
  path with `mkdir -p` for the directory. Skip the comparison; emit a
  `console.log("[parity] updated golden: <path>")` so the operator
  has audit trail. Test passes unconditionally.

**Auto-promotion path (when TS port lands):**

1. Verb-source porter ships `src/verbs/<verb>.ts` + cli.ts dispatch.
2. Parity-cron-impl (or whoever owns the cron-fired lane in iter-N)
   removes `bashOnly: true` from the matrix row.
3. Test runs full bash↔TS parity. Golden file becomes redundant; can
   be deleted in the same commit OR retained as a historical baseline
   in `tests/parity/golden/archive/`.

### NOT in scope of THIS commit (golden-file mode)

- **Per-side `bashBin` for bash↔TS rows.** The current full-parity rows
  use the harness's default `BIN_BASH` (worktree's `bin/atmux`). The
  `bashBin` field exists on `ParityRow` but is wired only on bash-only
  rows in iter-1; allowing per-side overrides for bash↔TS rows is
  iter-2 if a use case emerges.
- **Golden-file diffing UX (e.g. `bun test:parity --update-goldens`
  alias, side-by-side diff renderer).** Iter-1 ships the env-var flag
  + raw `Divergence` output. CLI ergonomics defer to operator demand.
- **Golden-file state-after snapshots beyond the 6 baseline rows.**
  All 6 rows in iter-1 use `--dry-run` (groom) or are read-only
  (decisions digest), so `stateAfter` is empty. When iter-2+ adds
  state-mutating bash-only rows, extend `compareGolden` to read
  `<row-id>.state.json` companion files.

## Surfaced findings (independent of rows landing)

The survey turned up two facts that warrant team-lead attention before
iter-1 rows land. These are **finding-class** observations per CLAUDE.md
"Test finding report pattern", not blockers:

### F1 — TS report.ts uses `formatMytFull` while bash report.sh uses `now_myt`

- **State:** `src/verbs/report.ts:264` calls `formatMytFull(nowMs)` →
  produces `"2026-05-04 11:44:00 MYT"`. `lib/report.sh:25` calls
  `atmux::now_myt` → produces `"11:44 MYT"`.
- **Containment:** Both timestamps go into the report header
  `📊 **[atmux-report]** · \`<team>\` · <ts>` which is the FIRST line
  of stdout AND the first segment of the discord body. Existing
  `compare.ts:52` global mask handles `\d{2}:\d{2} MYT` (the bash
  shape) but NOT the TS shape's `YYYY-MM-DD HH:MM:SS MYT` prefix.
  Without action, every iter-1 report row diverges on stdout line 1.
- **Fix sketch:** Either (a) `report.ts:264` swap `formatMytFull` →
  `formatMyt` (one-line fix, restores bash parity); (b) add a per-row
  stdout mask covering both shapes (`/(?:\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}(?::\d{2})? MYT/g`);
  (c) treat as a deliberate TS upgrade and amend `compare.ts` global
  mask to cover both shapes (bash-frozen per ADR-115 means bash can't
  catch up).
- **Residue:** None — the divergence has not landed in any green test
  yet because no report row exists in `PARITY_MATRIX`.
- **Severity:** P2. Blocks iter-1 row 1's first parity-green pass but
  not destructive. Recommended path: (a) swap the helper — TS report's
  cron-line context (`>> .atmux/logs/report.log 2>&1`) already has
  date+time from the log's own append-mode; the body itself only needs
  the time. Aligns with bash and CLAUDE.md "user-facing timestamps in
  MYT" canonical short form.
- **Recommended action:** Surface to lead via `atmux reply`; defer the
  swap to whip-impl or whoever owns `report.ts`-side commits (this lane
  is parity testing, not verb-source edits per the dispatched body's
  "DO NOT touch other lanes' files"). Once swapped, iter-1 rows land
  with the existing global mask. If the lead chooses path (b) or (c),
  iter-1 rows ship with a wider mask and the TS shape stays.

### F2-corrected — `decisions digest` and `groom` exist as bash verbs; only the TS port is missing (CORRECTED 2026-05-06)

> **Original F2 premise was WRONG.** The original survey claimed both verbs
> were absent on both sides. Reality (verified by `atmux help` + `ls
> /root/work/src/atmux/lib/`): bash side is fully implemented and
> cron-fired today; only the TS port is absent. The corrected text below
> supersedes the original. Documenting the correction inline rather than
> rewriting silently — future readers should see both the original
> miscategorisation and the correction so the same survey error isn't
> re-made on iter-2 lanes.

- **State (corrected):**
  - **`groom`:** `lib/groom.sh` (503 LOC) IS the bash impl. Top-level
    verb: `atmux groom [--dry-run] [--quiet] [--kanban-days N]
    [--decisions-days N] [--keep-bak N]`. Cron-fired daily at 04:00
    via `lib/cron.sh:77` (`0 4 * * * atmux groom --quiet`). Also fires
    on every `atmux start` per `lib/start.sh:398`. TS port absent —
    no `src/verbs/groom.ts`. The comment at `src/verbs/start.ts:64-66`
    ("groom verb not yet ported") is correct about the TS side, but
    misled the original survey into assuming bash-side absence too.
  - **`decisions digest`:** `lib/decisions.sh` (684 LOC) IS the bash
    impl. Multi-subcommand verb: `atmux decisions {add,list,show,digest}`.
    `decisions digest` cron-fires every 4h via `lib/cron.sh:71`
    (`0 */4 * * * atmux decisions digest`). TS port absent — no
    `src/verbs/decisions.ts`. The original survey conflated bash-whip's
    `_atmux_whip_check_decisions` helper (a different code path —
    inline whip nag) with the standalone `decisions digest` verb (a
    cron-fired Discord digest of the pending-decisions cursor since
    last run). They are NOT the same code; the standalone verb exists
    independently of whip.
- **Containment:** Original F2 led to two deferred-rows entries with
  re-enable handles pointing to "verb-port belongs to whoever owns the
  verb's lane in PLAN §6.2 (currently unassigned)." That handle was
  too pessimistic — bash exists, so the work is a TS-port assignment,
  NOT a from-scratch verb-design. The corrected deferred-rows entries
  (above) point at `src/verbs/{decisions,groom}.ts` as the concrete
  blocker file. No green parity row exists for either verb yet, so no
  golden-output regression risk from the correction.
- **Fix sketch:** Out of scope for THIS lane (parity-cron-impl writes
  parity rows, not verb-source). The TS port belongs to whichever
  Phase 4b lane owns verb-port assignment per PLAN §6.2 — likely
  folded into the V-26+V-27 sub-phase per HANDOFF.md "PHASE 4 RUSH".
  Lead routes the verb-ID assignment.
- **Iter-1 partial path (new option opened by the correction):**
  bash-only output capture rows that compare bash stdout/state against
  a **frozen golden fixture** (instead of against the TS side) are now
  feasible. Pattern: `runner.ts` invokes `bash side only`, captures
  stdout + `stateAfter`, compares against a checked-in
  `tests/parity/fixtures/golden/groom-clean.json` etc. This pins the
  bash-side shape so the eventual TS port has a concrete target. Cost:
  ~1 row each for `groom --dry-run` (clean kanban) + `decisions
  digest --dry-run` (empty cursor); +~80 LOC golden fixtures. Adds
  regression catch for accidental bash-side drift before the cutover.
  parity-cron-impl decides whether to take this path; flag in matrix.ts
  as `bashOnly: true` per ADR-120 channel-mask conventions.
- **Severity:** P2 (was P3). The original premise being wrong meant
  the deferred-rows handle pointed at the wrong work; downstream
  porters reading ADR-121 would have wasted effort searching for a
  non-existent bash spec. Corrected text reconciles brief vs reality.
- **Recommended action:** Surface to lead via `atmux reply` so
  parity-cron-impl can decide whether to (a) hold both rows in iter-2+
  pending TS port (status quo + corrected handles), OR (b) land
  bash-only golden-fixture rows in iter-1 as a TS-port forcing
  function. Lead routes verb-port assignment in parallel.

Both findings are surfaced via `atmux reply` to the lead alongside this
ADR draft. F1 has a one-line fix path; F2 is a planning-vocabulary
reconciliation.

## NOT in scope of THIS commit

- **Matrix row authoring.** This ADR pins the iter-1 row set; the
  actual `PARITY_MATRIX = [...]` entries land in commits 3+ after
  reviewer gates the ADR + the `cron-tasks` preset.
- **`cron-tasks` preset implementation.** This ADR pins the shape; the
  `factory.ts` extension lands as commit 2 (`feat(parity): cron-tasks
  fixture preset (lifecycle + pre-seeded kanban for cron-fired rows)`).
  Coordination ping to parity-state-impl + up-impl precedes the edit.
- **TS report.ts `formatMytFull` → `formatMyt` swap (per F1).** Belongs
  to the verb-source owner, not this lane. ADR-121 surfaces; lead
  routes.
- **Bash-side `ATMUX_DISCORD_RECORDER` honour.** Porter-B Phase 2
  follow-up per ADR-101 / `intercept-discord.ts:14-20`. Iter-1 sidesteps
  with `--no-discord`.
- **Live-tmux whip rows / `tmux-shim` harness primitive.** Iter-2
  scope. Separate ADR if the implementation surface justifies.
- **`multi-team` fixture preset implementation.** ADR-119 row 4 stays
  deferred until a verb's behaviour visibly varies by team-name OR
  iter-2 live-tmux whip rows want member-count variation.
- **`decisions` and `groom` verb TS ports.** Bash side already exists
  (`lib/decisions.sh` + `lib/groom.sh`); only the TS-side ports are
  missing. Belongs to PLAN §6.2 verb-ID assignment + a verb-source
  porter, not this parity lane. Likely folded into Phase 4b per
  HANDOFF.md "PHASE 4 RUSH" lane decomposition. Lead routes.

## Migration plan (this ADR's commit chain)

1. **Commit 1 — `docs(adr-bun): ADR-121 — phase 4a parity cron-fired
   lane scope + golden-file harness mode (refs ADR-119, ADR-120)`**:
   this ADR file (re-scoped 2026-05-06 for groom + decisions baseline
   inclusion + golden-file harness mode spec). Reviewer at `atmux:5`
   gates BEFORE commit 2 lands.
2. **Commit 2 — `feat(parity): cron-tasks fixture preset family
   (lifecycle + pre-seeded kanban for cron-fired rows)`**: extends
   `factory.ts` with 3 new preset cases — `cron-tasks` (mixed shape,
   for report row 2), `cron-tasks-decisions` (pre-seeded
   `decisions.json` + driver-inbox; for the 3 decisions baseline rows),
   `cron-tasks-groom` (kanban + archive tails + .bak.* families; for
   the 3 groom baseline rows). Coordination ping to `parity-state-impl`
   + `up-impl` via `atmux reply` PRECEDES the commit (already issued +
   acked: up-impl confirmed additive-only, state-impl using harness-side
   preState path — clean separation). Reviewer-gated before commit 3.
3. **Commit 3 — `feat(parity): golden-file harness mode (runBashOnly +
   per-row bashBin override + ATMUX_PARITY_UPDATE_GOLDENS capture)`**:
   the new harness primitive per §Golden-file harness mode above.
   `ParityRow.{bashOnly,bashBin}` fields; `runner.ts` per-row `bashBin`
   override; `compare.ts::compareGolden`; `index.test.ts` two-branch
   dispatch; new `tests/parity/golden/` dir with `.gitkeep`. Standalone
   typecheck + 100% coverage on new helpers. Reviewer-gated before
   commits 4 + 5.
4. **Commit 4 — `test(parity): 3 cron-fired full-parity rows
   (closes ADR-121 rows 1-3)`**: the 3 bash↔TS parity rows
   (report-lifecycle-empty + report-cron-tasks-mixed + whip-no-session).
5. **Commit 5 — `test(parity): 6 bash-only baseline rows for groom +
   decisions (closes ADR-121 rows 5-6, golden capture pass)`**: the 6
   bash-only rows + their checked-in golden snapshots under
   `tests/parity/golden/`. Capture pass: `ATMUX_PARITY_UPDATE_GOLDENS=1
   bun test tests/parity/` to seed the goldens, then commit goldens +
   matrix entries together.
6. **Commit 6 — `docs(adr-bun): ADR-121 — iter-1 close + iter-2 lead-off
   list`** (only if findings warrant ADR refresh; otherwise close via
   commit message body in commit 5).

Each commit standalone-passes typecheck + 100% coverage gate. Reviewer
gates each per the 8-check protocol (PLAN §9). Reviewer scans this ADR
against ADR-119 + ADR-120 to verify it's a scope carve-out, NOT a shape
redesign.

## Out of plan / future work

- **Iter-2 cron-fired lane expansion** — drives the deferred-row table:
  bash-side `ATMUX_DISCORD_RECORDER` honour → enables discord-side
  parity → drop `--no-discord` from report rows. Live-tmux whip rows
  via `tmux-shim` primitive. Multi-team variant rows when a verb's
  behaviour varies by team-name. `cron-runner.ts` evaluation if mask
  vocabulary stops scaling.
- **`decisions` and `groom` verb TS ports** — bash impls already exist
  (`lib/decisions.sh` 684 LOC, `lib/groom.sh` 503 LOC; both cron-fired
  today). Phase 4b verb-ID + porter assignment per PLAN §6.2. Once
  `src/verbs/{decisions,groom}.ts` land, parity rows are mechanical
  adds: `decisions digest` rows against a `cron-tasks` extension that
  pre-seeds `decisions.json` cursor + mixed entries; `groom` rows
  against the existing `lifecycle` preset extended with stale archive
  tails / old kanban dones / .bak.* families to exercise each sweep
  branch. Optional iter-1 forcing function: bash-only golden-fixture
  rows (see §F2-corrected, "Iter-1 partial path") to pin bash-side
  shape before cutover.
- **F1 follow-up** — once lead routes the report timestamp helper
  decision, either (a) `report.ts` one-line swap unblocks iter-1 rows
  with no mask change, or (b) widen `compare.ts:52` mask to cover both
  shapes, or (c) ADR-120 amendment for a new "wallclock timestamp
  class" with explicit per-row regex.

## Consequences

- **Iter-1 ships 9 rows + 3 fixture presets + 1 harness primitive**
  vs the brief's ~12–16 row target. Re-scope on 2026-05-06 lifted the
  groom + decisions baseline rows from deferred → in-scope (lead's
  Q1=parent-bin / Q2=golden-file verdict), absorbing the F2 correction
  that bash side IS implemented for both verbs — iter-1 captures the
  bash truth as golden snapshots that auto-promote to bash↔TS parity
  when `src/verbs/{decisions,groom}.ts` ship in Phase 4b. Remaining
  brief deltas: whip live-tmux needs new harness primitive (4 rows ×
  4 variants); discord channel needs bash-recorder port (every row ×
  discord variant); per-row scenario expansion needs state-impl's
  ADR-122 preState hook (3-4 rows). The reachable-today surface is 9
  rows: 3 full-parity + 6 bash-only-baseline.
- **Each deferred row carries a sharper handle than ADR-119 row 5 had
  room for** — bash-recorder branch one-liner pinned, tmux-shim LOC
  estimate pinned, multi-team preset re-enable trigger pinned, and
  decisions/groom verb-port routing named.
- **F1 finding gives the verb-source lane a one-line fix path** that
  unblocks iter-1 rows without harness mask churn. Lead's routing
  decision dictates iter-1 commit cadence.
- **`cron-tasks` preset becomes the hub for cron-fired parity** —
  iter-2 live-tmux whip rows extend it with tmux-session materialisation;
  iter-2 discord-side rows reuse it as-is once bash recorder lands.
- **Honest scope discipline preserved per
  `feedback_scope_adr_before_maximalist_port.md`** — the dispatched
  body asked for 12–16 rows × 4 presets; ADR-121 names what's actually
  reachable, defers the rest with sharper handles, and surfaces the
  one finding (F1) that has a cheap fix path.
