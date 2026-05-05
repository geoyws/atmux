# Handoff snapshot — atmux-bun port

**Last driver-session update:** 2026-05-05 ~14:55 MYT
**Status:** Phase 1 + 2 mostly complete. **19 of 25 verbs ported** (V-19 reconfigure landed this session, commit `c9461bd`). 1084 tests pass / 0 fail. Solo-mode (no team agents).

---

## ✅ Working tree state — clean

```
HEAD:   c9461bd feat(verbs): reconfigure — re-run wizard against existing team.json
Tests:  1084 pass / 4 todo / 0 fail across 44 test files
Build:  bunx tsc --noEmit + bun test green
Biome:  pre-existing warnings on other files (not regressions); shipped files clean
```

You can safely `/clear` after reading this file. No pending edits, no flaky tests.

---

## 🗺️  Resume protocol — when next driver wakes

The **canonical verb checklist + refactor IDs live in `PLAN.md` §6.2**. That file is the source of truth — this handoff is just the most-recent-state pointer.

1. Read this file (`HANDOFF.md`)
2. Read `PLAN.md` (master plan + §6.2 stable verb-ID checklist V-01..V-25 + refactor IDs R-1..R-5)
3. Read `MEMORY.md` (5+ discipline rules from prior sessions)
4. Pick up at the next ⏳ pending row in PLAN.md §6.2 — **recommended order: R-1 → R-2 → V-23 → V-20 → V-21 → V-22 → V-24 → V-25 → V-01**
5. Pattern: write code → write tests → wire into cli.ts → typecheck + biome + 100% coverage gate → conventional commit

For each verb: `feat(verbs): <name> — <one-line>` body explains bash divergences + coverage stats. Land R-3/R-4 status flips alongside the verb commit when applicable.

For agent spawns inside this worktree (subagent exploration / parallel research), use:
```bash
CLAUDE_GUARD_AGENT=1 c-ic --permission-mode dontAsk --model claude-opus-4-7
```

---

## 📊 Quick state pointers

- **Tally:** 19/25 verbs shipped (76%). Remaining: V-01 (up), V-20 (handoff), V-21 (report), V-22 (cost), V-23 (rotate), V-24 (doctor), V-25 (whip).
- **Refactors pending:** R-1 (capture helper), R-2 (socket lift), R-4 (this file's siblings — only minor amends now), R-5 (Writer ADR — between Phase-2 close and Phase-3).
- **Phase status:** Phase 1 closed; Phase 2 ~76% through; Phase 3 (parity harness) starts after V-25.

Detailed verb listing + LOC counts + bash-source paths: see **`PLAN.md` §6.2**.

---

## 🔥 Cockpit + superdriver — still active

Operator directive (prior session): "make sure that we have a cockpit to use, and the superdriver lives in the cockpit as well, window 0".

- New tmux session: `cockpit`
- Window 0 = `superdriver` running Claude Opus 4.7 with xhigh effort, on the **`c-ic`** account
- Reattach: `tmux attach -t cockpit`

**Account routing for future agent spawns:**

| Alias | Account | When to use |
|-------|---------|-------------|
| `c`    | `~/.claude` (geoyws@gmail.com Max) | personal: atmux dev, .sb dotfiles |
| `c-i`  | `~/.claude-ifca` | IFCA work account |
| `c-ic` | `~/.claude-icloud` (IFCA-paid via geoyws@icloud.com) | **IFCA contexts where iCloud account billing applies** — including this atmux-bun port |
| `c-u`  | `~/.claude-unum` | Unum side-project |

All four aliases default to xhigh effort. Per-call override: `CLAUDE_CODE_EFFORT_LEVEL=high c-ic …`.

Spawn pattern:
```bash
CLAUDE_GUARD_AGENT=1 c-ic --permission-mode dontAsk --model claude-opus-4-7
```

---

## 📝 Discipline patterns observed (worth preserving)

- **Path-restricted commits** (`git add <specific-files>`) keep porter lanes from sweeping each other's WIP.
- **Defensive guards that can't fire** were CLAUDE.md-flagged twice; drop them rather than leave 1-2% uncovered.
- **Bash parity over TS idiom** — when bash has a quirk, port the quirk and document it inline. Future-correctness goes in Phase 6.
- **Coverage 100% func is the bar** (lines can be 98–99% if uncovered branches are defensive guards). Never below 95% lines for any shipped file.
- **Stable verb-IDs in PLAN.md §6.2** > volatile TaskList. The bug at the start of this session (referring to TaskList #21–#30 across `/clear`) is fixed by §6.2.
- **Skip flaky-stdin readline driver tests** — coverage tools count `?? createReadlinePrompter()` as covered when ANY test exercises the line, even if the fallback branch isn't taken. Don't fight the tools for a 0%-value branch.

---

## 🗂️ Recent commits this session

```
c9461bd feat(verbs): reconfigure — re-run wizard against existing team.json
```

Prior session (carried forward):
```
d33e7f7 feat(verbs): dashboard — full-screen status panel with redraw loop
0dba15f feat(verbs): help — usage block byte-parity with bash bin/atmux:25-86
fcda2f2 feat(verbs): tell-lead, broadcast — driver→lead + send alias
306aceb feat(verbs): status — read-only team snapshot
9e3d2e8 feat(verbs): reply, outbox — member→driver async messaging
```

External (dotfile submodule, pushed prior session):
```
9a27795 feat(zsh): account guard agent-context bypass + stderr output
        (also bumped c/c-i/c-ic/c-u to default xhigh effort)
```

---

## TL;DR for future driver

You are the **driver** of the atmux-bun port. Solo mode. Working tree clean. **19/25 verbs done, 1084 tests pass.** 6 verbs + 4 refactors left (per PLAN.md §6.2).

After `/clear`:
1. Read this file + PLAN.md (esp. §6.2 verb checklist) + MEMORY.md
2. Pick up at the next ⏳ pending row in §6.2
3. Use `CLAUDE_GUARD_AGENT=1 c-ic …` for any agent spawn
4. Commit per-verb (typecheck + 100% coverage gate before each commit)
5. Pause + handoff at token limits

*Update this file when major state changes happen — phase transition, new operator directive, parity divergence. The verb checklist itself lives in PLAN.md §6.2 — keep status flips there, not duplicated here.*
