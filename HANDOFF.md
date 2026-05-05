# Handoff snapshot — atmux-bun port

**Last driver-session update:** 2026-05-05 ~16:45 MYT
**Status:** Phase 2 ~92% complete. **23 of 25 verbs ported** (V-21 report + V-22 cost shipped this session). 1309 tests pass / 0 fail. Solo-mode (no team agents).

---

## ✅ Working tree state

```
HEAD:   3265f1c feat(verbs): cost — per-member USD + token tracking (V-22)
Tests:  1309 pass / 4 todo / 0 fail across 50 test files
Build:  bunx tsc --noEmit + bun test green
```

Working tree clean. No uncommitted state.

---

## 🗺️ Resume protocol — when next driver wakes

The **canonical verb checklist + refactor IDs live in `PLAN.md` §6.2**. That file is the source of truth — this handoff is just the most-recent-state pointer.

1. Read this file (`HANDOFF.md`)
2. Read `PLAN.md` §6.2 for V-01..V-25 + R-1..R-5 status
3. Read `PLAN.md` §6.3 for I-1..I-4 integration tasks (ADR-018)
4. Continue per recommended order: V-24 (doctor) → V-25 (whip) → V-01 (up). Doctor before whip because whip calls into doctor.
5. Pattern: write code → write tests → wire into cli.ts → typecheck + biome + 100% coverage gate (per-verb file) → conventional commit. Flip §6.2 status alongside in the same commit.

For agent spawns: `CLAUDE_GUARD_AGENT=1 c-ic --permission-mode dontAsk --model claude-opus-4-7`

---

## 📊 This session's progress

- **V-22 cost** (commit `3265f1c`) — per-member USD + token tracking, mirrors `lib/cost.sh`. Parses Claude Code session JSONL files under `~/.claude/projects/<slug-of-cwd>/` for `assistant.message.usage` blocks newer than `--since`, sums tokens × per-model pricing. Caches per-member detail at `.atmux/state/cost-<name>.json`. Text + JSON output. New `src/schema/pricing.ts` (DEFAULT_PRICING + Pricing schema + pricingFor). New `tryParseJsonString` helper in `src/abstractions/json.ts` (JSONL line reader, R3-honouring). Also exports `computeTeamCost` for V-25 whip / V-21 report integration. 60 tests, 100% line + function coverage on cost.ts + pricing.ts.
- **V-21 report** (commit `e88d047`) — 30-min progress digest, mirrors `lib/report.sh`. Shipped/in-progress/blocked filters + open driver-inbox asks, structured Discord sections per ADR-008, soft Discord error handling, last-report.epoch state-tracking. 43 tests, 100% line + function coverage on `src/verbs/report.ts`.
- **ADR-018** (commit `6082a4d`) — `/coordination:*` skills integration contract. Pins window-naming detection helper, `lead-session-start.txt` marker file (immediate items I-1 + I-2), defers driver-inbox path alignment + `/team` shim to V-25 (whip). PLAN.md gains §6.3 integration tasks subsection. Backlog rows for ADR-015/016/017/018 added to §7.

---

## 📈 Tally

- **Verbs:** 23/25 shipped (92%). Remaining: V-24 doctor, V-25 whip, V-01 up.
- **Refactors:** R-1 + R-2 + R-3 + R-4 done. **R-5 pending** — `Writer` interface ADR after V-25 ships.
- **Integration (§6.3):** I-1, I-2 immediate (land alongside V-25); I-3, I-4 deferred to V-25 design.
- **Phase status:** Phase 1 closed. Phase 2 ~92% through. Phase 3 (parity harness) starts after V-25.

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

- **R3 (`json.ts` is the only `JSON.parse` site)** discipline held under V-22 pressure. JSONL line-reading needed per-line parse-or-skip semantics — added `tryParseJsonString<T>(text, schema): T | null` to json.ts rather than punching a hole in the abstraction. Reusable for V-25 whip's session-log reads.
- **ADR-018 split discipline**: immediate vs deferred items got distinct rationales (driver-inbox + `/team` shim deferred until V-25 whip surfaces real read-pattern constraints; window naming + lead-uptime marker resolvable now without waiting). Avoids double-rework.
- **Single source of truth for ID flips** — PLAN.md §6.2 / §6.3 / §7. Status flip and feature commit in the same commit; never split the two (V-20 / V-23 / V-21 / V-22 all followed this).
- **Test injection patterns** for Discord — `discordSend` opt for assertion-grade interception; `ATMUX_DISCORD_RECORDER` env var for the default-branch coverage round-trip. Both kept the test free of real fetches.
- **Test-double for filesystem walks** — V-22 cost.ts exposed `listFiles` + `readFile` opts on `computeMemberCost` so tests inject fake jsonl content without spinning up `~/.claude/projects/` fixtures. Pattern works well for any verb that walks well-known external trees.

---

## 🗂️ Recent commits this session

```
3265f1c feat(verbs): cost — per-member USD + token tracking (V-22)
24930a2 docs(handoff): refresh — V-21 shipped, ADR-018 integration contract
e88d047 feat(verbs): report — 30-min progress digest (V-21)
6082a4d docs(adr,plan): ADR-018 — /coordination skills integration contract
f422f62 docs(handoff): refresh — V-19, V-23, V-20 shipped + V-21 WIP note
a70cb75 feat(verbs): handoff — two-phase work transfer between members
```

---

## TL;DR for future driver

You are the **driver** of the atmux-bun port. Solo mode. **23/25 verbs done, 1309 tests pass.** 2 verbs left + V-01 (up). §6.3 integration tasks (I-1..I-4) land alongside V-25 (whip) per ADR-018.

After `/clear`:
1. Read this file + PLAN.md §6.2 + §6.3 + MEMORY.md
2. Continue per §6.2 recommended order: V-24 (doctor) → V-25 (whip, fold I-1+I-2 in) → V-01 (up)
3. When picking up V-25, fold I-1 + I-2 (immediate integration items) into the same commit chain — they're 10-line marker-file writes the verb needs anyway. I-3 + I-4 design choices land alongside V-25.
4. `computeTeamCost(members, sinceEpoch, opts)` already exported from `src/verbs/cost.ts` — V-25 whip can import it directly for cost-budget heartbeats. V-21 report could similarly cross-link if a Discord cost-line gets requested.
5. Use `CLAUDE_GUARD_AGENT=1 c-ic …` for any agent spawn
6. Commit per-verb (typecheck + 100% file coverage gate before each commit; cli.ts dispatch case branches are tracked but pre-existing tech debt — do not block)

*Update this file when major state changes happen. The verb checklist itself lives in PLAN.md §6.2 — keep status flips there, not here.*
