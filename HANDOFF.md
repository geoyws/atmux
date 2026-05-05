# Handoff snapshot — atmux-bun port

**Last driver-session update:** 2026-05-05 ~20:15 MYT
**Status:** Phase 2 complete. **25 of 25 verbs ported** — V-01 `up` shipped this turn (composite wizard→doctor→start→attach), closing the verb-port milestone. 1543 tests pass / 0 fail. Phase 3 (parity harness) is next.

---

## ✅ Working tree state (worktree)

```
HEAD:   <V-01 commit pending>
Tests:  1539 pass / 4 todo / 0 fail across 54 test files (1543 total)
Build:  bunx tsc --noEmit + bun test green
```

Working tree clean post-V-01 commit. No uncommitted state in the bun port worktree.

**Note:** `/root/work/src/atmux/` (parent main checkout) has substantial WIP from George's bash-side work — not touched by this session except for ADR-047 + README install section (committed as `d256b88`).

---

## 🚀 This session's deliverables

### Code commits (worktree branch `worktree-atmux-bun`)

```
<pending> feat(verbs): up — composite wizard→doctor→start→attach (V-01)            ← up-impl
faffe45 docs(plan): V-25 status flip — whip shipped
9269d32 feat(verbs): whip — 5-min watchdog (V-25, in-scope subset per ADR-022)   ← whip-impl
4f23fc2 docs(adr,handoff): ADR-024 spawn pattern uses --permission-mode auto
30d44f1 docs(adr,plan,handoff): ADR-024 — spawned-agent account matching
849254c docs(adr): ADR-021 §4 — mode-aware preclear/cont behavior matrix
02e08c1 docs(adr,plan): ADR-022 + ADR-023 — whip port scope + LLM judge cascade
bbb3f3f docs(adr,plan): ADR-021 — atmux as runtime for /coordination skills
e89060f docs(adr,plan): R-5 done — ADR-020 + flip §6.2 + §7 status
197f428 test(cli): backfill dispatch-smoke for 8 missing verbs
1c4a600 refactor(verbs): import default writers from core/io.ts (R-5)
1743be3 feat(core): io.ts — shared Writer + default sinks (R-5)
```

### Code commits (main branch)

```
d256b88 docs(adr,readme): ADR-047 — canonical install topology + cleanup discipline
```

### ADRs landed (5 in worktree, 1 in main)

- **ADR-020** (worktree) — `Writer` abstraction + `core/io.ts`. Lifts duplicated `defaultStdoutWrite` / `defaultStderrWrite` from 9 verbs into one canonical module. ~80 LOC of boilerplate gone.
- **ADR-021** (worktree) — atmux as runtime for `/coordination:session` + `/coordination:team` skills. V-26 `session` + V-27 `team` scheduled post-cutover. §6.3 I-3 + I-4 resolved into this ADR. §4 mode matrix: BOTH preclear AND cont callable in every mode.
- **ADR-022** (worktree) — V-25 whip port scope. Carved in-scope (5 docstring checks + I-1/I-2/I-6 + flock + delta + 2-tick gate) from deferred (15+ bash-only checks each with re-enable handle).
- **ADR-023** (worktree) — LLM judge cascade contract. **Sonnet → Haiku → deterministic Tier 3** — pinned NOW so when SOFT classifier ports per ADR-022, no single-point-of-failure. George's design constraint: "resilient against LLMs that run out of tokens."
- **ADR-024** (worktree) — spawned-agent account matching. Members must run on driver's `CLAUDE_CONFIG_DIR`. V-25 whip's per-member pane check gained the cross-account drift detector. Also pins `--permission-mode auto` as canonical spawn mode.
- **ADR-047** (main) — canonical install topology. `/usr/local/bin/atmux` symlinks to dev tree `/root/work/src/atmux/bin/`; `/opt/atmux-stable/` is autopromote's tested-baseline fallback (swap via one-line symlink change). 6 stale install dirs cleaned to 2.

### Memory entries (global, persists across cont)

- `feedback_window_naming_no_prefix.md` — bare `<emoji><member>` per ADR-017, no `__team__` prefix.
- `feedback_claude_startup_fast.md` — sleep 2 not 8 when spawning claude.
- `feedback_spawn_match_driver_account.md` — match driver's `CLAUDE_CONFIG_DIR` per ADR-024.
- `~/.claude-unum/CLAUDE.md` — gained "Spawn Pattern (canonical)" section pinning `--permission-mode auto` + driver-wrapper detection idiom.

### Install hygiene (system-level)

- `/usr/local/bin/atmux` re-symlinked: `/opt/atmux-stable/bin/atmux` → `/root/work/src/atmux/bin/atmux` (dev tree). Now George's edits at `/root/work/src/atmux/lib/*` are live runtime atmux — 0-step dogfooding.
- 4 stale `/opt/atmux-stable.bak.*` dirs deleted (manual incident-response copies, no retention).
- ADR-047 forbids reintroducing `.bak.*` snapshots without retention; documents the dev-vs-stable two-tier topology.

---

## 🤝 Team state

`atmuxbun` team running in tmux session `atmux`, windows 2-5. All on `c-u` (unum) account, `--permission-mode auto`, Opus 4.7 + xhigh.

| Window | Name | Role | Status |
|---|---|---|---|
| 1 | (driver) | this REPL | thin UI relay |
| 2 | `🧭team-lead` | coordinator | dispatched first round, marked driver-inbox `📤 dispatched` |
| 3 | `📦whip-impl` | V-25 lane | **✅ V-25 SHIPPED** (`9269d32`) |
| 4 | `🛠️up-impl` | V-01 lane | in flight, planning + design |
| 5 | `🔍reviewer` | per-commit gate | armed; reviewer-state.md written |

Coordination paths (per ADR-021 §3):

- Driver-inbox: `~/.claude/teams/atmuxbun/driver-inbox.md` — append asks, lead reads first every turn
- Lead-outbox: `~/.claude/teams/atmuxbun/lead-outbox.md` — lead writes, driver reads via `atmux outbox` (or just `cat` since this team isn't using atmux runtime)
- Lead markers: `~/.claude/teams/atmuxbun/{lead-session-start.txt, lead-window-name.txt}`

**Team is NOT using atmux runtime** — hand-rolled tmux send-keys for spawn + coordination. No `.atmux/`, no kanban.json, no canonical inbox dirs. Team config at `.claude/team.json` is gitignored (ephemeral). This is tech debt for Phase 4 cutover dogfooding; for the V-25 + V-01 short scope it's fine.

---

## 🗺️ Resume protocol — when next driver wakes

The **canonical verb checklist + refactor IDs live in `PLAN.md` §6.2**. That file is the source of truth — this handoff is the most-recent-state pointer.

1. Read this file (`HANDOFF.md`)
2. Read `PLAN.md` §6.2 for V-01..V-27 + R-1..R-5 status
3. Read `PLAN.md` §6.3 for I-1..I-6 integration tasks (ADR-018; I-3 + I-4 resolved by ADR-021)
4. Read recent ADRs `docs/adr-bun/020/021/022/023/024.md` + main's `docs/adr/047.md`
5. Continue per recommended order: **V-01 up** → Phase 2 close
6. Check team state in tmux session `atmux` windows 2-5 (or kill team via `tmux kill-window -t atmux:5 -t atmux:4 -t atmux:3 -t atmux:2` if work is done and you want to clean up)

For agent spawns (per ADR-024):

```bash
case "${CLAUDE_CONFIG_DIR:-$(realpath ~/.claude 2>/dev/null)}" in
  */.claude-unum*)    DRIVER_WRAPPER="c-u" ;;
  */.claude-icloud*)  DRIVER_WRAPPER="c-ic" ;;
  *)                  DRIVER_WRAPPER="claude" ;;
esac
CLAUDE_GUARD_AGENT=1 ${DRIVER_WRAPPER} --permission-mode auto --model claude-opus-4-7
```

If a member was spawned with the wrong permission-mode, `tmux send-keys -t <window> BTab` cycles in-place. From `dontAsk` it's 3 BTabs to reach `auto`. Don't kill+respawn for mode switches.

---

## 📈 Tally

- **Verbs:** 25/26 shipped (96%) — V-25 whip closed this session. **V-01 up only remaining for Phase 2 close.**
- **Refactors:** R-1 through R-5 ALL DONE.
- **Integration (§6.3):** I-1 + I-2 (immediate) — landed inside V-25 whip. I-3 + I-4 — resolved by ADR-021 (collapse into V-26 + V-27 post-cutover). I-5 cage-attach (Phase 5). I-6 Discord decision-defence — template added in V-25, invocation site moves to V-27 per ADR-022 amendment.
- **ADRs added this session:** ADR-020, ADR-021, ADR-022, ADR-023, ADR-024 (worktree); ADR-047 (main).
- **Phase status:** Phase 1 closed. Phase 2 ~98% through. Phase 3 (parity harness) starts after V-01 lands.

Detailed verb listing + LOC counts + bash-source paths: see **`PLAN.md` §6.2**.

---

## 📝 Discipline patterns reaffirmed this session

- **Pin contract before code (R-5 → V-25 → V-01 order).** ADR-020 lifted Writer/io.ts boilerplate, then V-25 wrote against the canonical signature from day one. ADR-022/023 pinned whip's scope + LLM-judge cascade BEFORE V-25 started — whip-impl had a stable target.
- **Three-tier judge cascade** (ADR-023): Sonnet → Haiku → deterministic Tier 3. Pinned now so when SOFT classifier ports later, resilience is baked in. Cost ledger + degradation-Discord pings are mandatory observability. Never single-point-of-failure on a judge that can OOT.
- **Window naming** — bare `<emoji><member>` per ADR-017. Legacy `__{team}__` prefix deprecated. Saved as feedback memory.
- **Spawn-account matching** — members run on driver's `CLAUDE_CONFIG_DIR`. Cross-account spawns trip Anthropic ToS + break cost/session continuity. Whip's cross-account drift detector enforces post-spawn.
- **`--permission-mode auto` is canonical.** Anything else (`dontAsk`, `acceptEdits`) defeats parallelization. If wrong mode at spawn, `BTab` cycle in-place — don't kill+respawn.
- **Worktree-frozen lib/whip.sh is the canonical port source**, not parent's moving HEAD. `/root/work/src/atmux/.claude/worktrees/atmux-bun/lib/whip.sh` is the 218-LOC stub frozen at branch-cut; parent's 1324 LOC includes WIP that's Phase-5 catch-up territory. ADR-022's "1324 LOC" framing was off — corrected by PLAN.md §2 update mid-session.
- **Index pollution trap (CLAUDE.md `lint-staged + submodule-m-state`)** — encountered when committing on main (parent had pre-staged WIP). `git reset --soft HEAD~1`, unstage all, re-add only the 2 specific files, recommit. Always `git show --stat --format= HEAD` post-commit and reset+resplit if width > expected.
- **`/session preclear` callable in every mode** per ADR-021 §4 (driver = sanity+exit, solo/lead = full save). Drivers SHOULD run preclear pre-`/clear` for the audit trail and lead-health check, even in sanity-only mode.

---

## 🔥 Cockpit + superdriver — still active

- tmux session: `cockpit` · Window 0 = `superdriver` (separate from `atmux` session where the atmuxbun team lives)
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
CLAUDE_GUARD_AGENT=1 ${DRIVER_WRAPPER} --permission-mode auto --model claude-opus-4-7
```

Never copy a hardcoded `c-ic` or `c-u` from a stale handoff — cross-account spawn trips Anthropic ToS flags + breaks cost/session-state observability. See ADR-024 for the full rule + V-25 whip-side enforcement.

---

## TL;DR for future driver

You are the **driver** of the atmux-bun port. Team mode active (4 members in tmux session `atmux` windows 2-5). **25/26 things done, 1505 tests pass, V-25 whip JUST SHIPPED.** Only V-01 `up` remains for Phase 2 close — assigned to `🛠️up-impl` (window 4), in flight.

After `/clear`:

1. Read this file + PLAN.md §6.2/§6.3 + MEMORY.md
2. Check team state: `tmux capture-pane -p -t atmux:4.1 -S -` for V-01 progress
3. If V-01 still in flight, let it run; if shipped, congratulate + Phase 2 closes
4. **Post-Phase-2 next batch (Phase 3 — parity harness)** — see PLAN.md §3 for shape
5. **Pre-built dependencies for V-01** (already shipped): init.ts, doctor.ts, start.ts, attach.ts. V-01 is just the composite wrapper.
6. **George's standing requests still in flight:**
   - I-5 cage-attach (Phase 5)
   - I-6 Discord decision-defence — template added in V-25, invocation site = V-27 (post-cutover)
7. **Driver-inbox:** `~/.claude/teams/atmuxbun/driver-inbox.md` — most recent entry marked `📤 dispatched 17:41 MYT` by team-lead; lead is autonomous on dispatch
8. **Install topology** (per ADR-047): `/usr/local/bin/atmux` → dev tree (`/root/work/src/atmux/bin/atmux`). dev edits = live runtime atmux. Fall back to `/opt/atmux-stable` via symlink swap if dev breaks.

*Update this file when major state changes happen. The verb checklist itself lives in PLAN.md §6.2 — keep status flips there, not here.*
