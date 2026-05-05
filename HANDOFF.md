# Handoff snapshot — atmux-bun port

**Last driver-session update:** 2026-05-05 ~16:15 MYT
**Status:** Phase 2 ~88% complete. **22 of 25 verbs ported** (V-21 report shipped this session). 1228 tests pass / 0 fail. Solo-mode (no team agents).

---

## ✅ Working tree state

```
HEAD:   e88d047 feat(verbs): report — 30-min progress digest (V-21)
Tests:  1228 pass / 4 todo / 0 fail across 48 test files
Build:  bunx tsc --noEmit + bun test green
```

Working tree clean. No uncommitted state.

---

## 🗺️ Resume protocol — when next driver wakes

The **canonical verb checklist + refactor IDs live in `PLAN.md` §6.2**. That file is the source of truth — this handoff is just the most-recent-state pointer.

1. Read this file (`HANDOFF.md`)
2. Read `PLAN.md` §6.2 for V-01..V-25 + R-1..R-5 status
3. Read `PLAN.md` §6.3 for I-1..I-4 integration tasks (new this session — ADR-018)
4. Continue per recommended order: V-22 (cost) → V-24 (doctor) → V-25 (whip) → V-01 (up). Doctor before whip because whip calls into doctor.
5. Pattern: write code → write tests → wire into cli.ts → typecheck + biome + 100% coverage gate (per-verb file) → conventional commit. Flip §6.2 status alongside in the same commit.

For agent spawns: `CLAUDE_GUARD_AGENT=1 c-ic --permission-mode dontAsk --model claude-opus-4-7`

---

## 📊 This session's progress

- **V-21 report** (commit `e88d047`) — 30-min progress digest, mirrors `lib/report.sh`. Shipped/in-progress/blocked filters + open driver-inbox asks, structured Discord sections per ADR-008, soft Discord error handling, last-report.epoch state-tracking. 43 tests, 100% line + function coverage on `src/verbs/report.ts`.
- **ADR-018** (commit `6082a4d`) — `/coordination:*` skills integration contract. Pins window-naming detection helper, `lead-session-start.txt` marker file (immediate items I-1 + I-2), defers driver-inbox path alignment + `/team` shim to V-25 (whip). PLAN.md gains §6.3 integration tasks subsection. Backlog rows for ADR-015/016/017/018 added to §7.

---

## 📈 Tally

- **Verbs:** 22/25 shipped (88%). Remaining: V-22 cost, V-24 doctor, V-25 whip, V-01 up.
- **Refactors:** R-1 + R-2 + R-3 + R-4 done. **R-5 pending** — `Writer` interface ADR after V-25 ships.
- **Integration (new §6.3):** I-1, I-2 immediate (land alongside V-25); I-3, I-4 deferred to V-25 design.
- **Phase status:** Phase 1 closed. Phase 2 ~88% through. Phase 3 (parity harness) starts after V-25.

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

- **ADR-018 split discipline**: immediate vs deferred items got distinct rationales (driver-inbox + `/team` shim deferred until V-25 whip surfaces real read-pattern constraints; window naming + lead-uptime marker resolvable now without waiting). Avoids double-rework.
- **Single source of truth for ID flips** — PLAN.md §6.2 / §6.3 / §7. Status flip and feature commit in the same commit; never split the two (V-20 / V-23 / V-21 all followed this).
- **Test injection patterns** for Discord — `discordSend` opt for assertion-grade interception; `ATMUX_DISCORD_RECORDER` env var for the default-branch coverage round-trip. Both kept the test free of real fetches.

---

## 🗂️ Recent commits this session

```
e88d047 feat(verbs): report — 30-min progress digest (V-21)
6082a4d docs(adr,plan): ADR-018 — /coordination skills integration contract
f422f62 docs(handoff): refresh — V-19, V-23, V-20 shipped + V-21 WIP note
a70cb75 feat(verbs): handoff — two-phase work transfer between members
a058073 feat(verbs): rotate, rotate-lead — /clear + brief re-paste
530be94 refactor(core): lift getDefaultSocket → core/common.ts
```

---

## TL;DR for future driver

You are the **driver** of the atmux-bun port. Solo mode. **22/25 verbs done, 1228 tests pass.** 3 verbs left + 1 deferred (V-01 up). New §6.3 integration tasks (I-1..I-4) land alongside V-25 (whip) per ADR-018.

After `/clear`:
1. Read this file + PLAN.md §6.2 + §6.3 + MEMORY.md
2. Continue per §6.2 recommended order: V-22 → V-24 → V-25 → V-01
3. When picking up V-25, fold I-1 + I-2 (immediate integration items) into the same commit chain — they're 10-line marker-file writes the verb needs anyway. I-3 + I-4 design choices land alongside V-25.
4. Use `CLAUDE_GUARD_AGENT=1 c-ic …` for any agent spawn
5. Commit per-verb (typecheck + 100% file coverage gate before each commit; cli.ts dispatch case branches are tracked but pre-existing tech debt — do not block)

*Update this file when major state changes happen. The verb checklist itself lives in PLAN.md §6.2 — keep status flips there, not here.*
