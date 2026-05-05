# Handoff snapshot — atmux-bun port

**Last driver-session update:** 2026-05-05 ~16:30 MYT
**Status:** Phase 2 ~84% complete. **21 of 25 verbs ported** (V-19 reconfigure, V-23 rotate, V-20 handoff landed this session). 1185 tests pass / 0 fail. Solo-mode (no team agents).

---

## ✅ Working tree state

```
HEAD:   a70cb75 feat(verbs): handoff — two-phase work transfer between members
Tests:  1185 pass / 4 todo / 0 fail across 47 test files
Build:  bunx tsc --noEmit + bun test green
```

**Uncommitted (V-21 partial):**

- `src/verbs/report.ts` — **new, ~270 LOC, typechecks cleanly, no tests yet, NOT wired into cli.ts.** Implements `parseReportArgs`, `selectShipped/InProgress/Blocked/OpenAsks`, `formatTaskRow`, `buildReportBody`, `buildDiscordSections`, `readLastReportEpoch`, `writeLastReportEpoch`, public `report()`. Mirrors `lib/report.sh` — 30-min digest, optional Discord push via `discord.send` with `template: "report-digest"`.
- Note: I started V-21 but ran out of session before tests were written. **Three resume options for next session:**
  - **(A) Finish + commit.** Write `tests/unit/verbs/report.test.ts` covering the pure helpers + public verb against a fixture .atmux/. Inject `discordSend` to capture sections without spinning fetch. Expect ~25 tests to hit 100% coverage. Recommended.
  - **(B) Revert.** `rm src/verbs/report.ts` and re-port from scratch (the current implementation is a fine sketch though).
  - **(C) Commit as-is.** Would fail CI coverage gate. Don't.

---

## 🗺️ Resume protocol — when next driver wakes

The **canonical verb checklist + refactor IDs live in `PLAN.md` §6.2**. That file is the source of truth — this handoff is just the most-recent-state pointer.

1. Read this file (`HANDOFF.md`)
2. Read `PLAN.md` §6.2 for the V-01..V-25 + R-1..R-5 status table
3. **Decide on V-21** per the three options above (default: finish + commit)
4. Continue per recommended order: V-21 → V-22 (cost) → V-24 (doctor) → V-25 (whip) → V-01 (up)
5. Pattern: write code → write tests → wire into cli.ts → typecheck + biome + 100% coverage gate → conventional commit. Flip §6.2 status alongside.

For agent spawns: `CLAUDE_GUARD_AGENT=1 c-ic --permission-mode dontAsk --model claude-opus-4-7`

---

## 📊 This session's progress

- **V-19 reconfigure** (commit `c9461bd`) — re-run wizard against existing team.json, drops tuiCommands defaults, discord webhook handling. 24 tests, 100% coverage.
- **R-3 + R-4** (commit `1fef5a5`) — PLAN.md §6.2 stable verb-ID checklist (V-01..V-25 + R-1..R-5), HANDOFF.md trimmed to point at PLAN.md. **Fixes the post-/clear resume bug** where TaskList #21–#30 references became stale.
- **R-1** (commit `513dd6d`) — `tests/helpers/capture.ts` with `captureStdio` + `captureMain`. cli.test.ts refactored to use it. Saves 6 future verb tests from re-implementing the monkey-patch dance.
- **R-2** (commit `530be94`) — `getDefaultSocket(team)` lifted to `core/common.ts`. Eight verb call sites unchanged via re-export aliases (`defaultSocketPath` in attach.ts + start.ts).
- **V-23 rotate / rotate-lead** (commit `a058073`) — `/clear` + brief re-paste, lead-resolution from roster, non-claude warn-and-continue. 37 tests, 100% coverage.
- **V-20 handoff** (commit `a70cb75`) — two-phase capture (native ask with poll, capture-pane fallback), kanban + inbox migration, target ping, optional `--pause-from`. 57 tests, 100% coverage.

---

## 📈 Tally

- **Verbs:** 21/25 shipped (84%). Remaining: **V-21 report (in-flight WIP)**, V-22 cost, V-24 doctor, V-25 whip, V-01 up.
- **Refactors:** R-1 + R-2 + R-3 + R-4 done. **R-5 pending** — `Writer` interface ADR after V-25 ships.
- **Phase status:** Phase 1 closed. Phase 2 ~84% through. Phase 3 (parity harness) starts after V-25.

Detailed verb listing + LOC counts + bash-source paths: see **`PLAN.md` §6.2**.

---

## 🔥 Cockpit + superdriver — still active

- New tmux session: `cockpit` · Window 0 = `superdriver` running Claude Opus 4.7 with xhigh effort, on the **`c-ic`** account
- Reattach: `tmux attach -t cockpit`

**Account routing for future agent spawns:** see `~/.claude-icloud/CLAUDE.md`. Spawn pattern:
```bash
CLAUDE_GUARD_AGENT=1 c-ic --permission-mode dontAsk --model claude-opus-4-7
```

---

## 📝 Discipline patterns reaffirmed this session

- **Stable verb-IDs in PLAN.md §6.2** > volatile TaskList. Confirmed working — this session resumed from an even older HANDOFF and the §6.2 table made the recommended-next clear.
- **Stub TmuxNamespace via opts.buildTmux injection** (rotate.ts, handoff.ts) — much cheaper than spinning real tmux for unit tests, and the verb still exercises the real `createTmux` path via `defaultBuildTmux` cover tests.
- **Schema gotcha:** kanban.json fixtures must include `epics: []` and `stories: []` keys — Zod schema requires all three top-level arrays. The empty fixtures bash writes via `kanban_normalize` are NOT what bun:test mkdir+writeFile produces.
- **env-var leak between test files** — when a test SETS `process.env.X` and the prior value was undefined, the afterEach must `delete` first then conditionally restore. Caught it leaking from rotate.test.ts → tell-lead.test.ts.
- **`?? namedDefaultFn` over inline `?? ((x) => …)`** — coverage tools count the named-export function once even when the fallback isn't taken in every test. Inline arrows uncoverable without artificial roundtrips.

---

## 🗂️ Recent commits this session

```
a70cb75 feat(verbs): handoff — two-phase work transfer between members
a058073 feat(verbs): rotate, rotate-lead — /clear + brief re-paste
530be94 refactor(core): lift getDefaultSocket → core/common.ts
513dd6d test(helpers): tests/helpers/capture.ts — shared stdio capture
1fef5a5 docs(plan): stable verb-ID checklist in §6.2 + HANDOFF refresh
c9461bd feat(verbs): reconfigure — re-run wizard against existing team.json
```

---

## TL;DR for future driver

You are the **driver** of the atmux-bun port. Solo mode. **21/25 verbs done, 1185 tests pass.** 4 verbs left + 1 WIP (V-21 report sketch uncommitted at `src/verbs/report.ts`).

After `/clear`:
1. Read this file + PLAN.md §6.2 + MEMORY.md
2. **Decide on V-21**: finish+commit (write tests, recommended), or revert. The implementation is sound; just needs tests.
3. Continue per §6.2 recommended order: V-21 → V-22 → V-24 → V-25 → V-01
4. Use `CLAUDE_GUARD_AGENT=1 c-ic …` for any agent spawn
5. Commit per-verb (typecheck + 100% coverage gate before each commit)

*Update this file when major state changes happen. The verb checklist itself lives in PLAN.md §6.2 — keep status flips there.*
