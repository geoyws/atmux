# ADR-031: Parity matrix iter-2 — lifecycle lane scope (refs ADR-026, ADR-027)

**Status:** accepted
**Date:** 2026-05-06
**Owner:** up-impl

## Context

Phase 3 iter-2 (ADR-027) shipped channel-mask infrastructure + closed ADR-026 rows 3 + 6 (4 `task add` state-after rows + 4 error-rendering rows for `init` / `start` / `send` / `add-member`). Phase 4a parallelises the remaining matrix expansion across 4 vocabulary lanes — cron (ADR-028), state-mutating UPDATE/DELETE/asymmetric (ADR-029), read-only (ADR-030), error-class (ADR-032) — and **lifecycle** (this ADR), covering verbs that touch tmux session/window state + per-member process lifecycle.

In-scope verbs per the lead's Phase 4a dispatch: `up`, `start`, `stop`, `pause`, `resume`, `attach`, `rotate`, `reconfigure`. Bash spec for each is worktree-frozen at `lib/{up,start,stop,pause,attach,rotate,reconfigure}.sh` (note: `pause.sh` hosts both `pause` and `resume` cases via the verb-dispatch pattern at `lib/pause.sh:19-30`; there is no `lib/resume.sh`). TS ports live at `src/verbs/{up,start,stop,pause,attach,rotate,reconfigure}.ts` (with `pause` and `resume` co-located in `pause.ts` per the same shared-module convention).

PLAN.md §14 defines functional acceptance as "zero divergence on stdout / exit / state / tmux side-effects across every lifecycle scenario × in-scope state-shape presets." The catch: **`tmux side-effects` is not a channel ADR-009 §3 captures today** (5-channel set: stdout / stderr / exit / fs / discord; no `tmux` / `windowList` / `paneContent` channel). Comparing tmux side-effects 1:1 between bash and TS atmux requires either (a) extending the harness with a 6th channel that snapshots `tmux list-windows` / `tmux list-panes` / per-pane PPID chain after each verb run, or (b) folding the tmux state into the `fs` channel via a sidecar JSON snapshot.

Per the iter-1 / iter-2 pattern (ADR-026 §"NOT in scope" + ADR-027 §5), this ADR pins **error-path coverage + a small state-after slice for `pause` / `resume`** as the iter-2 lifecycle lane delivery, and defers tmux-channel infrastructure + happy-path tmux-side-effect comparison to iter-3 with a durable re-enable handle. Mirror the ADR-022 / ADR-026 carve-out craftsmanship: name what ports now, name what defers, attach handles.

This ADR fixes the iter-2 lifecycle scope before code lands — analogous to ADR-026 fixing iter-1 scope before matrix wire-up.

### Per-verb divergence enumeration

The probe below covers every in-scope verb's bash-vs-TS divergence surface. Each row maps to a class label this ADR pins as in-scope (✅) or deferred (❌).

| Verb | Bash side | TS side | Divergence class | Iter-2? |
|---|---|---|---|---|
| `up` (no-team, non-TTY) | `💥 atmux no team.json at <p> and not on a TTY — run 'atmux init --wizard' first` / exit 1 | `atmux: config: no team.json at <p> and not on a TTY (hint: run 'atmux init --wizard' first)` / exit 78 | error-rendering (ADR-027) | ✅ |
| `up` (no-team, ATMUX_NO_WIZARD set) | `💥 atmux no team.json here and ATMUX_NO_WIZARD is set …` / exit 1 | `atmux: config: no team.json here and ATMUX_NO_WIZARD is set …` / exit 78 | error-rendering (ADR-027) | ✅ |
| `up` (happy path, attached) | composite — wizard prompt OR session-create + tmux attach (blocks) | composite — same shape; `attach()` blocks until detach | tmux-side-effect + interactive — not testable in `bun:test` without controlling-tty | ❌ iter-3 |
| `start` (no-team) | already covered by ADR-026 row 6 | already covered by ADR-026 row 6 | error-rendering (ADR-027) | ✅ already in matrix |
| `start --bad-flag` | `💥 atmux start: unknown arg: --bad-flag` / exit 1 | `atmux: usage: start: unknown arg: --bad-flag` / exit 64 (UsageError) | error-rendering (ADR-027) | ✅ |
| `start` (lifecycle, happy path) | spawns tmux session + member windows; runs doctor; logs `created tmux session: …` | TS port spawns same windows but logs `doctor mode 'preflight' requested — preflight body deferred …` (start.ts:264-266) — divergent stderr line; tmux side-effects identical post-ADR-017 | tmux-side-effect (NEW class) + harness-only stderr drift | ❌ iter-3 |
| `stop` (no-team) | `💥 atmux no team.json …` / exit 1 | `atmux: config: no team.json …` / exit 78 | error-rendering (ADR-027) | ✅ |
| `stop` (lifecycle, session-doesn't-exist) | `⚠️ atmux session <s> does not exist — nothing to stop` / exit 0 | `atmux: warn: session <s> does not exist — nothing to stop` / exit 0 | warn-rendering (NEW sub-class of error-rendering — exit 0 path) | ✅ |
| `stop --force` (lifecycle, happy path) | `kill-session` + archive `<atmux-dir>/archive/<UTC-ts>/{inboxes,kanban.json,driver-inbox.md}` | same archive shape via TS `archiveState()` (stop.ts:185-223) | tmux-side-effect + fs state-after with timestamped path | ❌ iter-3 |
| `pause` (no args) | `💥 atmux usage: atmux pause <member>` / exit 1 | `atmux: usage: usage: atmux pause <member>` / exit 64 | error-rendering (ADR-027) | ✅ |
| `pause unknown-foo` (no-team) | `💥 atmux no team.json …` / exit 1 | `atmux: config: no team.json …` / exit 78 | error-rendering (ADR-027) | ✅ |
| `pause unknown-foo` (lifecycle, no-such-member) | bash dies via `atmux::member_json` lookup ("ERR: no such member: foo") / exit 1 | `atmux: config: pause: no such member in team.json: foo` / exit 78 | error-rendering (ADR-027) | ✅ |
| `pause w1` (lifecycle, happy path) | writes `state/paused.json` `{"w1":{"at":<epoch>,"reason":"manual"}}`; stderr `✅ atmux paused w1 (dispatch/claim will refuse)` / exit 0 | writes same JSON shape; stdout `paused w1 (dispatch/claim will refuse)` (TS uses stdout, not stderr `atmux::ok` line) / exit 0 | state-after (mask `at` epoch per ADR-027 state-after class) + channel-asymmetric stderr-vs-stdout (NEW sub-class for ADR-029 vocab) | ✅ partial — happy-path state-after with noise mask; channel-asymmetric class deferred to ADR-029 |
| `resume` (no args) | same shape as `pause (no args)` | same shape as `pause (no args)` | error-rendering (ADR-027) | ✅ |
| `resume unknown-foo` (lifecycle, no-such-member) | same shape as `pause unknown-foo` lifecycle | same shape | error-rendering (ADR-027) | ✅ |
| `resume w1` (lifecycle, happy path — requires pre-seeded `paused.json`) | requires `state/paused.json` with `w1` entry; clears via `del(.[$m])` | requires same pre-seed; clears via `resumeMember` | state-after + fixture-preset extension (`lifecycle-paused` or seeded variant) | ❌ iter-3 |
| `attach` (no-team) | `💥 atmux no team.json …` / exit 1 | `atmux: config: no team.json …` / exit 78 | error-rendering (ADR-027) | ✅ |
| `attach` (lifecycle, session-doesn't-exist) | `💥 atmux session <s> does not exist — run 'atmux start' first` / exit 1 | `atmux: config: session <s> does not exist (hint: run 'atmux start' first)` / exit 78 | error-rendering (ADR-027) | ✅ |
| `attach` (happy path) | blocks on `tmux attach-session` | blocks identically | not testable without controlling tty | ❌ iter-3 |
| `rotate` (no args) | `💥 atmux usage: atmux rotate <member>  \|  atmux rotate-lead` / exit 1 | `atmux: usage: usage: atmux rotate <member>  \|  atmux rotate-lead` / exit 64 | error-rendering (ADR-027) | ✅ |
| `rotate unknown-foo` (lifecycle, no-such-member) | bash dies via `atmux::member_json` / exit 1 | `atmux: config: rotate: no such member in team.json: foo` / exit 78 | error-rendering (ADR-027) | ✅ |
| `rotate-lead` (lifecycle, has-lead, no-window — session not started) | `💥 atmux no tmux window for lead` / exit 1 | `atmux: config: no tmux window for lead` / exit 78 (note: same "no tmux window" phrasing — only prefix differs) | error-rendering (ADR-027) | ✅ |
| `rotate w1` (lifecycle, happy path) | tmux `send-keys /clear` + buffer paste (claude TUI only); warns + brief-paste otherwise | identical via TS rotate (rotate.ts:226-258) | tmux-side-effect (pane keystroke history) | ❌ iter-3 |
| `reconfigure` (no-team) | `💥 atmux no team.json …` / exit 1 | `atmux: config: no team.json …` / exit 78 | error-rendering (ADR-027) | ✅ |
| `reconfigure --bad-flag` | `💥 atmux reconfigure: unknown arg: --bad-flag` / exit 1 | `atmux: usage: reconfigure: unknown arg: --bad-flag` / exit 64 | error-rendering (ADR-027) | ✅ |
| `reconfigure` (interactive happy path) | reads stdin via `read -r`; writes mutated team.json | reads stdin via `node:readline/promises`; writes same shape | not testable in `bun:test` without controllable stdin (covered by unit tests, not parity) | ❌ out of scope |

**Process-spawn checks** (per task-body acceptance — PID, PPID): bash `start` spawns members via `_atmux_spawn_member` → `tmux send-keys "$cmd"` (lib/start.sh:111-125), but the TS port ships an empty pane (default shell) per its file header §"DEFERRED — TUI launch + brief paste" (start.ts:67-72). PPID-chain comparison is therefore structurally divergent in iter-2 and meaningless to assert until the TS port lands `tui_cmd` resolution. **Defer per-pane PPID chain trace to iter-3** with re-enable handle: when `src/core/tui.ts::tuiCmd` ports + `start.ts` invokes it.

## Decision

V-31 lifecycle iter-2 scope is **error-path matrix-row population** (~13 rows) + **a 2-row state-after slice for `pause` happy path** (lifecycle preset, no factory.ts extension). Tmux-side-effect channel infrastructure + happy-path tmux comparison + `resume` happy-path (which needs a `lifecycle-paused` preset extension) defer to iter-3 with explicit re-enable handles.

**This ADR does NOT extend `tests/parity/fixtures/factory.ts`.** Coordination ping went out to `parity-cron-impl` (atmux:6) + `parity-state-impl` (atmux:7) at 2026-05-06 ~11:38 MYT; if either of their lanes needs `lifecycle-cron-aware` / `lifecycle-with-task` / `lifecycle-paused` preset variants, they own those edits. Iter-2 lifecycle rows reuse `minimal` (for pure no-team errors) and `lifecycle` (for in-team error paths + `pause` happy path).

**This ADR does NOT extend `tests/parity/compare.ts`.** The 4-channel mask vocabulary established by ADR-027 (exitCode / stdout / stderr / stateAfter) is sufficient for every ✅ row below. Tmux-channel addition is the gate on iter-3 lifecycle expansion — separate ADR-031 amendment OR separate ADR.

| Item | Status | Reason |
|---|---|---|
| ~13 error-path rows for `up` / `start --bad-flag` / `stop` (no-team + warn-exit-0) / `pause` (no args + no-team + no-such-member) / `resume` (no args + no-such-member) / `attach` (no-team + session-doesn't-exist) / `rotate` (no args + no-such-member) / `rotate-lead` (no-window) / `reconfigure` (no-team + bad-flag) | ✅ iter-2 | All fit ADR-027 error-rendering class with the existing 3-pattern stderr mask shape (prefix divergence + per-side fixture-clone path suffix + bash/TS hint phrasing). exitCode masked per ADR-006. Reuse the row-template from `a2fcef6` (start/send/add-member error rows). |
| 2 state-after rows for `pause w1` happy path on lifecycle preset (`pause w1` bare + `pause w1 --reason custom`) | ✅ iter-2 | `state/paused.json` is single-key state-after; `at` field is Unix epoch — ADR-027 state-after-class mask `^\d{10,}$` glob `paused.<key>.at` (single-level, no array wildcard needed — paused.json is `{<member>: {at, reason}}` shape). Channel-asymmetric stderr-vs-stdout (`atmux::ok` bash side / stdout TS side) covered with a `stderr` mask that absorbs the bash `✅ atmux paused …` line — same pattern as the 4 task-add rows from `1890278`. NO factory.ts extension needed (lifecycle preset has `w1` already). |
| `stop (lifecycle, session-doesn't-exist)` warn-rendering row | ✅ iter-2 | exit-0 path with stderr divergence: bash `⚠️ atmux session …`, TS `atmux: warn: session …`. New 2-pattern mask shape (warn-prefix divergence — tag this `ADR-027 error-rendering class` since the underlying class is the same; the "error" label covers all stylistic stderr divergences regardless of exit code). NO `exitCode: true` (both sides exit 0; the assertion is the stable-stderr+exit-0 contract). |
| Tmux-side-effect channel addition (6th channel: `tmuxAfter`) | ❌ iter-3 | PLAN.md §14 calls it the "primary signal for this lane" but iter-2 ships error-path coverage + `pause` state-after first (cheaper, already-deduped vocabulary) and unblocks the lead's downstream rows. **Re-enable handle:** ADR-031 amendment OR new ADR (likely ADR-033) when iter-3 ports `start` / `stop --force` / `rotate` happy paths. Channel shape sketch: `runner.ts` post-verb hook captures `tmux list-windows -t <session> -F '#{window_name}\t#{window_id}\t#{pane_pid}'` into a serialised snapshot; `compare.ts` adds `tmuxAfter?: TmuxSnapshotMask` mask config (window-name set diff + pane-PPID-chain trace) parallel to `stateAfter`. |
| `start --no-doctor` happy path on lifecycle preset (window-list comparison) | ❌ iter-3 | Requires the tmux-channel addition above + suppression of TS-only `doctor mode … deferred` log line via stderr mask. **Re-enable handle:** when (a) tmux-channel addition lands AND (b) start.ts:264-266's deferred log either (i) ships the doctor body OR (ii) becomes a quiet log gated on a verbose flag. |
| `stop --force` happy path on lifecycle preset (post-condition: archive dir created with masked timestamp) | ❌ iter-3 | Requires `stateAfter` glob-shape extension to traverse `archive/<masked-ts>/inboxes/<...>` (nested wildcards — ADR-027 §"Out of plan" §1 explicitly defers nested globs to iter-3+). Plus tmux-channel addition for the kill-session signal. **Re-enable handle:** glob-parser nested-wildcard support per ADR-027 §"Out of plan" §1. |
| `pause w1` then `resume w1` (happy path on `lifecycle-paused` preset) | ❌ iter-3 | Per-side fixture cloning means each row gets a fresh fixture (no inter-row state). To exercise `resume` happy path we need a fixture preset that pre-seeds `state/paused.json` — `lifecycle-paused` or a parameter on `lifecycle`. **Re-enable handle:** parity-state-impl OR up-impl in iter-3 extends `factory.ts` with the variant; or `makeFixture` accepts an `extra: {pausedMembers?: string[]}` shape that callers compose into the existing lifecycle preset (additive — no new top-level preset name). Coordinate with state-impl who is also touching factory.ts in their iter. |
| `up` happy path (composite: wizard / doctor / start / attach) | ❌ iter-3+ | Composite verb — wizard requires controllable stdin, attach blocks on tmux. Already has 1x cold-start+walk e2e coverage (`tests/e2e/lifecycle.test.ts`). Parity contribution would be marginal vs the cost of a controllable-stdin harness. **Re-enable handle:** if/when a parity-time controllable-stdin shim lands (separate ADR if pursued). Likely never — e2e already gates the integration shape. |
| `attach` happy path | ❌ never (deliberate) | Blocks on tmux's tty-bound `attach-session`; impossible to assert in `bun:test` for either side. Existing unit tests (`attach.test.ts`) exercise the abstraction-level rejection on missing tty. Parity gives nothing here. |
| `reconfigure` interactive happy path | ❌ out of scope | Wizard-style stdin readline; covered by unit tests (`reconfigure.test.ts`'s prompter-stub pattern) which aren't parity-shaped. Cross-side parity adds nothing — both sides delegate to interactive readline. |
| Per-pane PPID chain trace | ❌ iter-3+ | Bash `start` spawns the configured TUI; TS port ships an empty shell (start.ts:67-72 §"DEFERRED — TUI launch"). PPID chain is structurally divergent until `tui_cmd` resolver ports. **Re-enable handle:** when `src/core/tui.ts::tuiCmd` lands AND `start.ts` invokes it. |

Rendering: matrix-driven `bun:test` rows produce one row label per `(verb, args, fixturePreset, label)` tuple; comparator output is `Divergence[]` per ADR-009 §3 with masks applied per ADR-027.

Exit codes: `0` — all lifecycle rows green (zero divergences); nonzero — any row's `compare()` returned `Divergence[].length > 0`.

## NOT in scope of THIS commit

- **Matrix row authoring** — this ADR pins the iter-2 lifecycle row set; the actual `PARITY_MATRIX = [...]` lines land in commit 2 (`test(parity): N error-path lifecycle rows (closes ADR-031 ✅ rows)`) and commit 3 (`test(parity): 2 pause-happy-path state-after rows (closes ADR-031 ✅ pause)`). Reviewer gates each per the 8-check protocol (PLAN.md §9).
- **Tmux-side-effect channel design.** Re-enable handle named in §Decision; channel shape sketch is non-binding. Iter-3 ADR (likely ADR-033) ratifies the actual `tmuxAfter` mask schema.
- **Fixture preset extensions** (`lifecycle-paused`, `lifecycle-cron-aware`, `lifecycle-with-task`). State-impl + cron-impl own their own extensions per their iter-2 ADRs (ADR-029 / ADR-028 respectively); up-impl coordinates via `atmux send` to confirm boundaries before any factory.ts edit.
- **`compare.ts` upgrades.** The 4-channel mask vocabulary is sufficient. Reviewer's `// reason:` cite-locality discipline (ADR-027 §4) applies to every new row.
- **ADR-006 amendment.** ADR-006 stands. TS keeps BSD sysexits (`exit 64` UsageError, `exit 78` ConfigError) + structured-tag stderr. Bash side stays frozen. Iter-2 lifecycle rows mask the divergence harness-side per ADR-027 Option B.
- **ADR-009 §3 amendment.** The 5-channel contract stands for iter-2. Iter-3 will amend with the 6th (`tmuxAfter`) channel under separate ADR.

## Migration plan (this ADR's commit chain)

1. **Commit A — `docs(adr-bun): ADR-031 — parity matrix iter-2 lifecycle lane scope (refs ADR-026, ADR-027)`**: this ADR file. Reviewer gates the scope shape BEFORE row commits per the lead's dispatch.
2. **Commit B — `test(parity): 13 error-path lifecycle rows (closes ADR-031 ✅ error-class)`**: rows for `up` (×2: ATMUX_NO_WIZARD + non-TTY paths — both share the no-team-config error class), `start --bad-flag`, `stop` (no-team + session-doesn't-exist warn-exit-0), `pause` (no args + no-team + no-such-member), `resume` (no args + no-such-member), `attach` (no-team + session-doesn't-exist), `rotate` (no args + no-such-member), `rotate-lead` (no-window), `reconfigure` (no-team + bad-flag). All reuse the 3-pattern stderr regex shape from `a2fcef6` (`start`/`send`/`add-member` error rows).
3. **Commit C — `test(parity): 2 pause-happy-path state-after rows (closes ADR-031 ✅ pause)`**: rows for `pause w1` (bare) + `pause w1 --reason custom`. Lifecycle preset. Mask: `stateAfter: {"paused.<member>.at": /^\d{10,}$/}` + `stderr: /✅ atmux paused.../` (bash-only `atmux::ok` confirmation line not emitted by TS — channel-asymmetric pattern from `1890278` task-add rows).
4. **Commit D — `docs(adr-bun): ADR-031 update — iter-2 lifecycle delivery summary`**: post-landing — capture actual SHAs of B + C in §Consequences "Iter-2 actual delivery", relabel completed rows ✅ done, append iter-3 entry list.

Each commit standalone-passes typecheck + 100% coverage gate. Reviewer at atmux:5 gates each per PLAN.md §9 8-check protocol.

## Out of plan / future work

- **Iter-3 tmux-channel ADR (likely ADR-033).** Adds 6th channel `tmuxAfter` to ADR-009 §3; defines `TmuxSnapshotMask` shape (window-name set diff + per-pane PPID-chain trace + buffer-content elision); upgrades `compare.ts` + `runner.ts`. Unblocks `start --no-doctor` happy path, `stop --force` happy path, `rotate w1` happy path.
- **Iter-3 lifecycle row expansion** (post-tmux-channel): `start --no-doctor` happy path, `stop --force` happy path with archive dir state-after (requires nested-wildcard glob per ADR-027 §"Out of plan" §1), `rotate w1` happy path with pane-content elision, `pause`+`resume` round-trip via `lifecycle-paused` preset extension (coordinate with state-impl).
- **Per-pane PPID chain trace** (deferred per §Decision): re-enable handle when TS `tui_cmd` resolver ports.
- **`up` composite happy path** likely never — e2e already covers; parity adds marginal value vs controllable-stdin harness cost.
- **CI gate wiring** for lifecycle lane (`bun test:parity:lifecycle` script entry OR path-filter). Iter-2 of CI gate per ADR-026 §row 8 (deferred to iter-2+ in ADR-026; no ADR-031-specific blocker).

## Consequences

- **Iter-2 ships ~15 lifecycle matrix rows + 0 LOC of harness change** (no factory.ts edit, no compare.ts edit). Each row ~12-20 LOC of matrix entry. Total touched: `tests/parity/matrix.ts` only.
- **Each deferred row carries a durable re-enable handle** tied to a specific iter-3 trigger (tmux-channel ADR, factory.ts preset extension, `tui_cmd` port). No "TODO" rot.
- **ADR-027's mask vocabulary scales** — error-rendering + state-after handle every iter-2 lifecycle row without new mask classes. Reviewer's `// reason:` discipline + greppability stay intact.
- **Parity coverage for lifecycle-class verbs lifts from 0 → ~15 rows** (zero rows in iter-1; this iter contributes the entire lane). Combined with cron / state / read / error-class lanes (Phase 4a parallel), the matrix expands ~50+ rows iter-2 across all 5 lanes.
- **Tmux-side-effect comparison stays explicit-deferred** rather than implicit-missing. Iter-3 ADR adds the channel cleanly; iter-2 doesn't paint over the gap with brittle `fs`-channel hacks.
- **No factory.ts contention with parity-state-impl + parity-cron-impl.** Coordination ping at 2026-05-06 ~11:38 MYT clarified up-impl owns zero factory.ts edits this iter; state-impl + cron-impl own their lane's preset extensions independently.
- **Reviewer gate hardens at scope-ADR layer.** Per the lead's dispatch, ADR-031 lands as commit 1 with reviewer pre-row-commit verification — same craftsmanship pattern as ADR-026 (commits 1 → 2 → 3 → 4) and ADR-027 (commits A → B → C → D → E → F). Catches scope drift at the cheapest layer.
- **ADR-048** (bare-window-names, accepted 2026-05-06 in `/root/work/src/atmux/docs/adr/048-bare-window-names.md` — parent atmux repo, uncommitted) governs window-name shape on bare-mode teams. Lifecycle parity rows use the lifecycle preset's default (no `bareWindowNames` flag → legacy `__<team>__<emoji><member>` prefix on bash side; post-ADR-017 `<emoji><member>` on TS side). The TS-vs-bash window-name-shape divergence is a tmux-side-effect-class concern and only matters for happy-path rows — all iter-2 rows are error-path or state-after (`paused.json`-only), so the window-name divergence doesn't surface. Iter-3 happy-path rows will need a bareWindowNames-aligned preset to assert apples-to-apples.

### Iter-2 actual delivery (placeholder — fill on commit D)

To be appended on commit D landing — capture SHAs of B + C, confirm row counts match the 13 + 2 plan, note any per-row rework + verb-set deviations.
