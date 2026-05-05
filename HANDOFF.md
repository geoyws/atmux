# Handoff snapshot — atmux-bun port

**Last driver-session update:** 2026-05-05 ~17:30 MYT
**Status:** Phase 2 ~96% complete. **24 of 25 verbs ported** (V-21 report + V-22 cost + V-24 doctor shipped this session). 1406 tests pass / 0 fail. Solo-mode (no team agents). **Only V-25 whip + V-01 up remain.**

---

## ✅ Working tree state

```
HEAD:   4a6a7b4 feat(verbs): doctor — environment health check (V-24)
Tests:  1406 pass / 4 todo / 0 fail across 51 test files
Build:  bunx tsc --noEmit + bun test green
```

Working tree clean. No uncommitted state.

---

## 🗺️ Resume protocol — when next driver wakes

The **canonical verb checklist + refactor IDs live in `PLAN.md` §6.2**. That file is the source of truth — this handoff is just the most-recent-state pointer.

1. Read this file (`HANDOFF.md`)
2. Read `PLAN.md` §6.2 for V-01..V-25 + R-1..R-5 status
3. Read `PLAN.md` §6.3 for I-1..I-6 integration tasks (ADR-018, plus I-5 cage-attach UX + I-6 Discord decision-defence — both deferred behind V-25/Phase 5)
4. Continue per recommended order: **V-25 (whip)** → V-01 (up). Doctor (V-24) shipped — fold whip-hash + crontab + cron-orphans deferred-doctor checks into V-25 follow-up if relevant.
5. Pattern: write code → write tests → wire into cli.ts → typecheck + biome + 100% coverage gate (per-verb file) → conventional commit. Flip §6.2 status alongside in the same commit.

For agent spawns: `CLAUDE_GUARD_AGENT=1 c-ic --permission-mode dontAsk --model claude-opus-4-7`

---

## 📊 This session's progress

- **V-24 doctor** (commit `4a6a7b4`) — environment health check, IN-SCOPE SUBSET per ADR-019. Ports the docstring-listed core: deps / team / tuis / state-dir / webhook (with HTTP 405-on-GET = green) / phantom-inboxes / orphan-sessions. Render: human (stderr) + JSON (`--json`). `--quiet` for start-preflight; `--fix` surfaces deferred-actions hint. New `src/abstractions/discord.ts::resolveWebhookUrl` (env → team.json → XDG file chain) + `src/abstractions/http.ts::probeStatus` (status code or 0; isReachable's bool loses Discord's 405 signal). doctor.ts at 98.34% (root bypasses writability red branch — covered in non-root CI); discord.ts + http.ts at 100%. **Deferred 15 bash-internal/Phase-5/V-25-coupled checks** with re-enable-when-X handles in ADR-019.
- **ADR-019** (commit `9bfb259`) — `doctor` verb (V-24) port scope decision: in-scope set vs deferred bash-only checks. Each deferred row is the durable handle.
- **V-22 cost** (commit `3265f1c`) — per-member USD + token tracking, mirrors `lib/cost.sh`. Parses Claude Code session JSONL files under `~/.claude/projects/<slug-of-cwd>/` for `assistant.message.usage` blocks newer than `--since`, sums tokens × per-model pricing. Caches per-member detail at `.atmux/state/cost-<name>.json`. Text + JSON output. New `src/schema/pricing.ts` (DEFAULT_PRICING + Pricing schema + pricingFor). New `tryParseJsonString` helper in `src/abstractions/json.ts` (JSONL line reader, R3-honouring). Also exports `computeTeamCost` for V-25 whip / V-21 report integration. 60 tests, 100% line + function coverage on cost.ts + pricing.ts.
- **V-21 report** (commit `e88d047`) — 30-min progress digest, mirrors `lib/report.sh`. Shipped/in-progress/blocked filters + open driver-inbox asks, structured Discord sections per ADR-008, soft Discord error handling, last-report.epoch state-tracking. 43 tests, 100% line + function coverage on `src/verbs/report.ts`.
- **ADR-018** (commit `6082a4d`) — `/coordination:*` skills integration contract. Pins window-naming detection helper, `lead-session-start.txt` marker file (immediate items I-1 + I-2), defers driver-inbox path alignment + `/team` shim to V-25 (whip). PLAN.md gains §6.3 integration tasks subsection. Backlog rows for ADR-015/016/017/018 added to §7.

## 🆕 Captured this session — added to PLAN.md §6.3

- **I-5 cage-attach UX** — `atmux cage attach <name>` (`unum` / `sopx` / `atmux` / etc.) one-shot attach to a named cage without remembering the tmpdir socket. Likely a `atmux cage <verb>` sub-namespace mirroring `atmux task <verb>`. Deferred behind Phase 5 cage support. **Captured as George's request** — surface it to whoever picks up Phase 5 cage work.
- **I-6 Discord decision-defence surfacing** — every autonomous lead decision (planner-recommended default applied without escalation) posts a context+rationale bullet to Discord (`📋 [autonomous-decision]` named template). George can react to reverse or amend. Builds on the §"Lead makes its own recommended decisions" rule in CLAUDE.md — currently followed but not surfaced. Lands alongside V-25 whip (already the Discord-pinging supervisor). **Captured as George's request** — fold into V-25 design.

---

## 📈 Tally

- **Verbs:** 24/25 shipped (96%). Remaining: V-25 whip, V-01 up.
- **Refactors:** R-1 + R-2 + R-3 + R-4 done. **R-5 pending** — `Writer` interface ADR after V-25 ships.
- **Integration (§6.3):** I-1, I-2 immediate (land alongside V-25); I-3, I-4 deferred to V-25 design; **I-5 cage-attach + I-6 Discord decision-defence** — captured this session, deferred to Phase 5 / V-25 respectively.
- **ADRs added this session:** ADR-018 (skills integration contract), ADR-019 (doctor port scope).
- **Phase status:** Phase 1 closed. Phase 2 ~96% through. Phase 3 (parity harness) starts after V-25.

Detailed verb listing + LOC counts + bash-source paths: see **`PLAN.md` §6.2**.

---

## 🔥 Cockpit + superdriver — still active

- New tmux session: `cockpit` · Window 0 = `superdriver` running Claude Opus 4.7 with xhigh effort, on the **`c-ic`** account
- Reattach: `tmux attach -t cockpit`

**Account routing for future agent spawns — match the driver's account per ADR-024.** Each cont detects the driver's `CLAUDE_CONFIG_DIR` and substitutes the matching wrapper. Spawn pattern (driver substitutes its own wrapper):

```bash
# Detect driver wrapper:
case "${CLAUDE_CONFIG_DIR:-$(realpath ~/.claude 2>/dev/null)}" in
  */.claude-unum*)    DRIVER_WRAPPER="c-u" ;;
  */.claude-icloud*)  DRIVER_WRAPPER="c-ic" ;;
  *)                  DRIVER_WRAPPER="claude" ;;
esac

# Spawn:
CLAUDE_GUARD_AGENT=1 ${DRIVER_WRAPPER} --permission-mode dontAsk --model claude-opus-4-7
```

Never copy a hardcoded `c-ic` or `c-u` from a stale handoff — cross-account spawn trips Anthropic ToS flags + breaks cost/session-state observability. See ADR-024 for the full rule + V-25 whip-side enforcement.

---

## 📝 Discipline patterns reaffirmed this session

- **Scope ADRs before sprawling ports.** V-24 doctor would have ballooned to 1666 LOC if I'd ported all 22 bash check fns. ADR-019 pinned the in-scope core (deps/team/tuis/state-dir/webhook/phantom-inboxes/orphan-sessions) and tabled 15 deferred checks with re-enable handles tied to V-25 / Phase 5 / cutover. Each deferred check is a durable handle in the ADR table, not a "TODO" comment that rots.
- **R3 (`json.ts` is the only `JSON.parse` site)** discipline held under V-22 pressure. JSONL line-reading needed per-line parse-or-skip semantics — added `tryParseJsonString<T>(text, schema): T | null` to json.ts rather than punching a hole in the abstraction. Reusable for V-25 whip's session-log reads.
- **Abstractions added under verb pressure are the most reusable.** V-22 cost added `tryParseJsonString` (json.ts); V-24 doctor added `resolveWebhookUrl` (discord.ts) + `probeStatus` (http.ts). All three are V-25 whip pre-built dependencies.
- **ADR-018 / ADR-019 split discipline**: immediate vs deferred items get distinct rationales. Driver-inbox + `/team` shim deferred until V-25 surfaces real read-pattern constraints. Same posture for ADR-019's 15 deferred doctor checks.
- **Single source of truth for ID flips** — PLAN.md §6.2 / §6.3 / §7. Status flip and feature commit in the same commit; never split the two (V-20 / V-23 / V-21 / V-22 / V-24 all followed this).
- **Test injection patterns** for Discord — `discordSend` opt for assertion-grade interception; `ATMUX_DISCORD_RECORDER` env var for the default-branch coverage round-trip. Both kept the test free of real fetches.
- **Test-double for filesystem walks** — V-22 cost.ts exposed `listFiles` + `readFile` opts on `computeMemberCost`, V-24 doctor exposed `which`/`probe`/`hasSession` injection. Pattern works well for any verb that walks well-known external trees or shells out.
- **Root-bypass coverage gaps acknowledged.** doctor.ts:421-428 (state-dir not-writable red branch) is uncoverable when running as root because root bypasses POSIX write-perm. Tests skip on `process.getuid() === 0`; CI runs as non-root and covers the branch. Same posture as status.ts pre-existing gap.

---

## 🗂️ Recent commits this session

```
4a6a7b4 feat(verbs): doctor — environment health check (V-24)
9bfb259 docs(adr,plan): ADR-019 — doctor verb (V-24) port scope
4259f78 docs(handoff): refresh — V-22 cost shipped
3265f1c feat(verbs): cost — per-member USD + token tracking (V-22)
24930a2 docs(handoff): refresh — V-21 shipped, ADR-018 integration contract
e88d047 feat(verbs): report — 30-min progress digest (V-21)
6082a4d docs(adr,plan): ADR-018 — /coordination skills integration contract
```

---

## TL;DR for future driver

You are the **driver** of the atmux-bun port. Solo mode. **24/25 verbs done, 1406 tests pass.** Only V-25 whip + V-01 up remain. §6.3 integration tasks (I-1..I-6) land alongside V-25 / Phase 5 per ADR-018 + ADR-019.

After `/clear`:
1. Read this file + PLAN.md §6.2 + §6.3 + MEMORY.md
2. **Continue per §6.2 recommended order: V-25 (whip, fold I-1+I-2+I-6 in) → V-01 (up)**
3. **Pre-built dependencies for V-25 (already shipped):**
   - `src/abstractions/discord.ts::resolveWebhookUrl(opts)` — env → team.json → XDG file chain.
   - `src/abstractions/discord.ts::send(opts)` — full ADR-008 sender; whip uses for `[whip-progress]` / `[whip-blocker]` / `[whip-heartbeat]` / `[whip-decisions]` named templates.
   - `src/abstractions/http.ts::probeStatus(url)` — webhook reachability, status-code precision.
   - `src/abstractions/json.ts::tryParseJsonString(text, schema)` — for any JSONL line reading whip needs.
   - `src/verbs/cost.ts::computeTeamCost(members, sinceEpoch, opts)` — for whip's cost-budget heartbeat (`[whip-budget]` template).
   - `src/verbs/doctor.ts::runAllChecks(atmuxDir, team)` — whip-watchdog can call this for periodic env probing.
4. **Defer items I-3 + I-4** still apply (driver-inbox path + `/team` shim) — pick canonical when V-25's read pattern is concrete. **I-5 cage-attach** is Phase 5 (don't bundle). **I-6 Discord decision-defence** is V-25-coupled — fold the `📋 [autonomous-decision]` template into V-25's named-template additions.
5. **George's two captures this session:**
   - I-5: `atmux cage attach <name>` UX (Phase 5 hand-off)
   - I-6: Discord decision-defence surfacing for autonomous lead decisions (V-25 fold-in)
6. Use `CLAUDE_GUARD_AGENT=1 c-ic …` for any agent spawn
7. Commit per-verb (typecheck + 100% file coverage gate before each commit; cli.ts dispatch case branches are tracked but pre-existing tech debt — do not block)

*Update this file when major state changes happen. The verb checklist itself lives in PLAN.md §6.2 — keep status flips there, not here.*
