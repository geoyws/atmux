# Handoff snapshot — atmux-bun port

**Last driver-session update:** 2026-05-05 ~20:15 MYT
**Status:** Phase 2 complete. **25 of 25 verbs ported** — V-01 `up` shipped this turn (composite wizard→doctor→start→attach), closing the verb-port milestone. 1543 tests pass / 0 fail. Phase 3 (parity harness) is next.

---

## ✅ Working tree state (worktree)

```
HEAD:   ec96c7e feat(verbs): up — composite wizard→doctor→start→attach (V-01)
Tests:  1539 pass / 4 todo / 0 fail across 54 test files (1543 total)
Build:  bunx tsc --noEmit + bun test green
```

Working tree clean post-V-01 commit. No uncommitted state in the bun port worktree.

**Note:** `/root/work/src/atmux/` (parent main checkout) has substantial WIP from George's bash-side work — not touched by this session except for ADR-047 + README install section (committed as `d256b88`).

---

## 🚀 This session's deliverables

### Code commits (worktree branch `worktree-atmux-bun`)

```
ec96c7e feat(verbs): up — composite wizard→doctor→start→attach (V-01)            ← up-impl
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

- **Verbs:** 25/25 shipped (100%) — V-25 whip + V-01 up closed this session. **Phase 2 verb-port milestone closed.**
- **Refactors:** R-1 through R-5 ALL DONE.
- **Integration (§6.3):** I-1 + I-2 (immediate) — landed inside V-25 whip. I-3 + I-4 — resolved by ADR-021 (collapse into V-26 + V-27 post-cutover). I-5 cage-attach (Phase 5). I-6 Discord decision-defence — template added in V-25, invocation site moves to V-27 per ADR-022 amendment.
- **ADRs added this session:** ADR-020, ADR-021, ADR-022, ADR-023, ADR-024 (worktree); ADR-047 (main).
- **Phase status:** Phase 1 closed. Phase 2 closed (verb ports + R-1..R-5). Phase 3 (parity harness) is next.

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

## 🌱 eternal-improvement (ADR-052)

**Verb:** `atmux improve` — kanban-empty fallback to autonomous self-improvement loop. ADR drafted in `docs/adr-bun/052-eternal-improvement.md` (status: proposed, gated on OQ-1 + OQ-2 + reviewer signoff). T1 verb skeleton landed (args + budget-resolve + state-file write); cycle mechanics are T7.

### Verb usage

```
atmux improve [--budget <spec>] [--status] [--dry-run] [--default-budget]
              [--idle-fallback] [--force]

  --budget <spec>      Token budget. Forms: <int> | <int>% | <int>%-5h | <int>%-wk
  --default-budget     Use standing default (30%-wk); resolves at invocation
  --status             Print state-file contents + remaining tokens, exit 0
  --dry-run            Resolve budget + formula, no state writes
  --idle-fallback      Mode B — verb fires `atmux stop` on budget exhaustion
  --force              Override 24h-active idempotence guard
```

### Budget formula

**Default:** `0.3 × min(remaining_wk_tokens_per_active_member)`.

`min(…)` over members prevents pinning the lowest-budget member over their cap. "Active members" = `team.json` members with `paused: false` AND a live pane. If no observability data is available (ADR-049 not probing), `--budget` MUST be passed explicitly — defaults fail closed with USAGE error.

Resolution precedence (first wins): CLI `--budget` → env `ATMUX_IMPROVE_BUDGET` → `team.json::improve.defaultBudget` → built-in `"30%-wk"`.

### State-file location

`.atmux/state/eternal-improvement.json` (single greppable JSON, lock via `.lock` flock pattern matching `whip-idle-state.json.lock`). Schema per ADR-052 §State-file-schema: `active`, `runId`, `startedAt`, `mode`, `budgetSpec`, `budgetTotal`, `budgetRemaining`, `cycleN`, `currentCycle`, `lastCycleClosedAt`, `history` (append-only ring, max 50 entries). Persists across runs for `atmux improve --status` audit reads.

### Mode A vs Mode B (text-form diagram)

```
Mode A — user-invoked
─────────────────────
  driver / operator invokes:
      $ atmux improve [--budget <spec>]
                ↓
  any time, any kanban state — runs alongside whatever else is in flight
                ↓
  cycle loop: ask members → planner scores → dispatch → review → close
                ↓
  budget exhausts (post-cycle accounting) AND no in-flight tasks
                ↓
  set active:false in state file → Discord 🌱 [eternal-improvement-done]
                ↓
  exit 0


Mode B — idle-fallback (whip-intercepted)
─────────────────────────────────────────
  whip's ADR-043 idle-stop threshold fires
                ↓
  whip checks: _atmux_improve_is_active ?
                ↓ no
  whip invokes:
      $ atmux improve --idle-fallback --default-budget
                ↓
  verb writes state, dispatches first cycle to lead, EXITS IMMEDIATELY
                ↓
  subsequent whip ticks see active:true + non-idle → auto-stop counter resets
                ↓
  cycles run until: budgetRemaining ≤ 0 AND kanban still empty AND no
  driver-dispatched non-improvement tasks landed during run
                ↓
  verb itself fires `atmux stop` (the path ADR-043 originally took)
```

**Driver preemption.** If the driver dispatches new (non-improvement) Tasks during a Mode-B run: in-flight cycle finishes (no mid-cycle abort per fully-built directive), loop pauses (`currentCycle.paused: true`), driver Tasks proceed normally. When driver Tasks land AND kanban returns to empty AND budget remains → loop resumes from cycle N+1.

### Scope guardrails (improvement Tasks must satisfy)

- Lands on team's working branch — no forks, no greenfield rewrites, no architectural pivots.
- Does NOT touch `_refs/` (frozen reference material) or rewrite ADRs (additive ADRs OK).
- Does NOT modify `staging` / `prod` deploy configs (CLAUDE.md push policy — Demo path off-limits).
- Fully landable in ≤1 cycle (no multi-cycle epics inside an improvement run; planner escalates via `pending-decisions.md` if seen).

Violations escalate via the regular `pending-decisions.md` / `lead-outbox.md` path — never silently ship.

### Cross-references

- ADR: `docs/adr-bun/052-eternal-improvement.md`
- Verb: `src/verbs/improve.ts` (TS), `lib/improve.sh` (bash mirror)
- Discord templates: `🌱 [eternal-improvement-start]` / `[-progress]` / `[-done]` (T3)
- Whip integration: `_atmux_whip_check_auto_stop` modified per ADR-052 §Whip integration (T6)
- Open questions: OQ-1 (first-landing branch), OQ-2 (supergroomer overlap), OQ-3 (budget observability source)

---

## 💰 Budget observability (ADR-053)

R1 wave landed the bun-port of ADR-049's Claude Max budget probe + four extensions: per-band warnings, refresh-soon pings, auto-resume cron precision, durable history log. **Implementation:** `ffad610` (R1-T1 probe + Fix C OAuth refresh) → `65c16f3` (R1-T5 part 1 state primitives) → `65bdcda` (R1-T5 part 2 Discord templates) → `09b8091` (R1-T5 part 3 dedup state) → `df3a08c` (R1-T5 part 4 orchestrator) → `8160d71` (R1-T5 part 5 whip-tick wiring) → `f9ad15b` (R1-T6 e2e walk) → `9c50354` (R1-T7 whip-resume-check verb).

### What it does

- **Per-tick budget probe.** `src/abstractions/budget-probe.ts::probeBudget` (240s cache TTL by default) reads `~/.<account>/credentials.json`, refreshes OAuth on `expiresAt < now+60s`, calls the Anthropic rate-limit endpoint, writes `.atmux/state/budget-probe-<account>.json`. `force: true` skips cache.
- **OAuth-401 silent-stale fix (Fix C).** Refreshes via `https://api.anthropic.com/v1/oauth/token` on expiry or 401-with-valid-token. Refresh failure → `atmux flags add --severity p2 --needs context "OAuth refresh failed for account=<n>; user re-login needed"`.
- **Budget-pause + budget-resume** (`src/core/budget-pause.ts`). Pause when ANY member's `h5_pct_used` or `wk_pct_used` ≥ `team.whip.budgetPauseThreshold` (default 90); resume when ALL ≤ `team.whip.budgetResumeThreshold` (default 80). 10pp hysteresis.
- **Coordination with eternal-improvement Mode B:** budget-pause supersedes Mode B per ADR-053 §D2. Tick order: budget-pause check → kanban-empty (improvement) → per-member regular checks. "Budget-pause is a deliberate hold, not idleness."
- **Auto-resume cron precision** (`src/verbs/whip-resume-check.ts`, USAGE: `atmux whip-resume-check [--no-discord] [--team-dir <dir>]`). 1-min cron line, lock-skipped on contention, ~1 probe call per active account per tick (mostly cache reads). Cost: 1 extra cron line; negligible system load.
- **Warning bands.** `[whip-budget-warning]` Discord ping at `team.whip.budgetWarningBands` (default `[0.50, 0.25, 0.15]` — i.e. when remaining-fraction crosses 50%/25%/15% downward). Dedup state `.atmux/state/budget-warning-state.json` keyed by `<account>:<window>:<band>`. Window-reset wipes entries; bands re-arm.
- **Refresh-soon pings.** `[whip-budget-refresh-soon]` fires when window resets in ≤ `team.whip.budgetRefreshLeadMins` (default 30). Dedup keyed by `<account>:<window>:<resetEpoch>`.
- **Durable probe history** at `.atmux/logs/budget-history.jsonl`. Append-on-every-probe; one JSONL line per probe with `ts / account / h5_util / wk_util / h5_reset / wk_reset / status / source / tokenRefreshed`. Rotated by `groom` when >1MB.

### How to view history.jsonl

```bash
# tail recent entries
tail -20 .atmux/logs/budget-history.jsonl | jq .

# per-account utilization timeline
jq -c 'select(.account=="icloud") | {ts, h5: .h5_util, wk: .wk_util}' \
  .atmux/logs/budget-history.jsonl

# probe-failure rate
jq -c 'select(.status != "allowed" and .status != "cache-hit") | .status' \
  .atmux/logs/budget-history.jsonl | sort | uniq -c

# OAuth-refresh count this week
jq -c 'select(.tokenRefreshed == true and .ts > (now - 604800)) | .ts' \
  .atmux/logs/budget-history.jsonl | wc -l
```

No dedicated `atmux budget-history` verb in v1; ad-hoc jq is the operator path. If demand emerges, a read-side verb is a follow-up.

### Configuration (team.json::whip)

```jsonc
{
  "whip": {
    "budgetPauseThreshold": 90,
    "budgetResumeThreshold": 80,
    "budgetWarningBands": [0.50, 0.25, 0.15],
    "budgetRefreshLeadMins": 30,
    "claudeAccount": "icloud"
  }
}
```

`claudeAccount` gates whether the cron block includes the `whip-resume-check` line — teams without budget observability skip it. See [Cron-migration runbook](RUNBOOK-cron-migration.md) for the migration path on already-running teams.

---

## 🔧 Whip config validation (ADR-054)

Per-tick Zod validation of `team.json::whip` with safe-default fallback + drift Discord ping. **Implementation:** `4e93746` (R1-T3 TeamWhip Zod schema + per-tick drift detection + `[whip-config-drift]` ping) → `9751f7a` (R1-T4 file organization).

### What it does

- `src/schema/team.ts:78` — `TeamWhip` Zod object (strict mode, unknown-key rejection). All ADR-053 / ADR-055 / ADR-056 fields typed.
- `src/core/whip-config-drift.ts:108` — `composeDriftReport(error, rawText)` extracts up to 5 issues, computes `driftHash` (sha256 over canonical-sorted issue list).
- `src/verbs/whip.ts` per-tick guard: if `Team.safeParse` fails, fall back to `makeDriftSafeDefaults` (drops invalid keys, applies schema defaults), fire `[whip-config-drift]` Discord (24h dedup by `driftHash`), continue tick.
- `src/verbs/doctor.ts` surfaces drift findings at P3 severity for operator triage without waiting for the next whip tick.

### Drift Discord ping example

```
🔧 [whip-config-drift] · `atmux` · 09:42 MYT
  • ⚠️ team.json::whip validation failed — using safe defaults
  • 📍 issues: 3 (1 unknown_key, 2 invalid_type)
  • 🔍 first: whip.budgetPauseTreshold (unknown_key, did you mean budgetPauseThreshold?)
  • 🛠️ fix: edit team.json + re-run atmux doctor
  • 📜 driftHash: a3f2c814 (re-pings if changes)
```

### How to fix common team.json typos

| Drift symptom | Fix |
|---|---|
| `unknown_key: budgetPauseTreshold` (typo) | Rename to `budgetPauseThreshold`. |
| `invalid_type: budgetWarningBands expected array<number 0..1>, got string` | Use `[0.50, 0.25, 0.15]` not `"50,25,15"`. |
| `unknown_key: autoStop` | Field is `autoStopAfterIdleTicks`; preserved for back-compat (default 0) but eternal-improvement Mode B + budget-pause supersede the auto-stop path. Set to 0 or remove. |
| `unknown_key: accountFallbacks` | Field is `accountFallback` (singular). Array of account names in priority order. |
| Whole-block invalid JSON (trailing comma, etc.) | Falls back to full schema defaults; fix syntax + re-run `atmux doctor`. |

`atmux doctor` surfaces drift immediately. After fixing team.json, re-run doctor to confirm clean. The next whip tick re-arms drift detection if a new issue appears (different `driftHash`).

### ADR-054 §OQ-3 — pre-existing team.json migration

Live `team.json` files in fleet teams (sopx, atmux, unum) may use `z.unknown()`-era shapes that don't pass strict validation. Migration is operator-driven: dispatch a fleet-wide `atmux doctor` after this ADR lands; the drift findings name the exact paths needing edits. NOT a code concern — see ADR-054 §OQ-3.

---

## 🩹 Cursor self-heal (ADR-055)

Recipe-driven `cursor-agent` invocations for whitelisted problem classes. **Implementation:** `0fa4572` (state file + 2 Discord templates) → `80d628e` (self-heal pass orchestrator + `stagePatchForReviewer`) → `9554f70` (whip-tick wiring) → `f50e751` (`fix:cron-pollution` + `fix:supervisor-missing` recipes) → `1ce71c3` (e2e self-heal walk).

### What it does

- `src/abstractions/cursor.ts` — typed `invokeCursor(job)` wrapper around the `cursor-agent` CLI (`/root/.local/bin/cursor-agent`), parses `--json` output, returns `{exitCode, stdout, stderr, patch, tokensUsed, durationMs}`.
- `src/core/cursor-recipes/types.ts` — `CursorRecipe` interface: `detect(ctx) → RecipeContext | null`, `propose(ctx) → CursorJob`, `verify(job, patch) → VerifyResult`. Per-recipe `tokenCap` (default 5_000) + `fileAllowlist` (e.g. `["team.json", ".atmux/state/*"]`).
- **v1 default-enabled recipes:**
  1. `fix:team-json-schema-drift` (`fix-team-json-schema-drift.ts`) — restores missing optional fields per ADR-054 drift report.
  2. `fix:cron-pollution` (`fix-cron-pollution.ts`) — scrubs stale cron entries detected by ADR-051's `cron_install` invariants.
  3. `fix:supervisor-missing` (`fix-supervisor-missing.ts`) — re-spawns supervisor window when `tmux list-windows` shows it absent.
- **Whip-tick integration** runs AFTER per-member checks AND AFTER budget-pause (never invoke cursor during budget-pause). 24h dedup per recipe via `.atmux/state/cursor-self-heal-state.json`.
- **Reviewer-gate, NOT auto-commit.** Patches stage at `.atmux/state/cursor-self-heal-pending/<recipe>-<ts>.patch` + a kanban Task is created addressed to the `reviewer` member with the patch path in body. Reviewer reads + applies + commits via the existing flow.
- Cursor session log per attempt at `.atmux/logs/cursor-self-heal-<recipe>-<ts>.log`.
- Discord pings at start (`[whip-self-heal-attempt]`) and result (`[whip-self-heal-result]`).

### How to enable self-heal

Self-heal is **opt-in** per team via `team.json`:

```jsonc
{
  "whip": {
    "selfHealEnabled": true,
    "selfHealRecipes": [
      "fix:team-json-schema-drift",
      "fix:cron-pollution",
      "fix:supervisor-missing"
    ]
  }
}
```

`selfHealEnabled: false` (default) bypasses the entire self-heal pass at whip-tick. Operators dogfood-cautious teams should opt-in one recipe at a time + monitor reviewer-gate hit rate before broadening.

### How to add a new recipe (smoke-test path)

1. Author the recipe at `src/core/cursor-recipes/<recipe>.ts` mirroring `fix-team-json-schema-drift.ts` shape: `detect` predicate, `propose` (cursor prompt + file allowlist + `tokenCap`), `verify` (check patch is in-bounds).
2. Land the recipe behind `team.json::whip.selfHealRecipes` opt-in (operators must explicitly enable).
3. Synthetic e2e test at `tests/e2e/cursor-self-heal-<recipe>.test.ts` — seed broken state, run recipe, assert patch shape + reviewer-gate path.
4. Dogfood on one team for ~1 week. If no incidents: a follow-up ADR flips it to default-enabled.

**Hard guardrails (per ADR-055):**
- Cursor invocations scoped to `.atmux/` and `team.json` only. NEVER `lib/` or `bin/`.
- All patches go through `git diff` reviewer-gate before commit.
- Per-recipe budget cap (default 5_000 tokens). Abort on overrun.
- No open-ended "look for any issues" prompts — recipe-driven scope only.

---

## 🔀 Account-swap (ADR-056)

Preemptive handoff at high utilization — instead of pausing the team at 90% used, swap members to a healthier account at 75% used. **Implementation:** `f99519f` (R1-T10 trigger detection + state machine + fallback selection) → `ffa2bd5` (R1-T11 part 1 Discord templates) → `22ac16b` (R1-T11 part 2 perMemberSwap workflow + `runSwapPass` orchestrator + whip-tick advancement) → `83115ec` (R1-T12 state-file lifecycle tests).

### What it does

- **Trigger.** When ANY active account's `h5_pct_used >= team.whip.accountSwapTriggerThreshold` (default 75) OR `wk_pct_used >= same`, AND any candidate member has a viable fallback (account in `team.whip.accountFallback` with BOTH `h5 ≤ 50%` AND `wk ≤ 50%`): enter swap pass.
- **Eligibility.** Only `role: worker` (or absent role). Roles in `team.whip.accountSwapExcludeRoles` (default `["lead", "planner", "reviewer"]`) are excluded — lead + planner hold cross-conversation memory that handoff doesn't carry.
- **Per-member swap workflow** (`src/core/account-swap.ts::perMemberSwap`):
  1. Force-fresh probe of target account.
  2. Spawn shadow member `<original>-swap` (collision: `-2`, `-3`) with same `role/lane/cwd/tui/model`, target `claudeAccount`. Programmatic spawn into the team's tmux server (not full `atmux start`).
  3. Wait for shadow's prompt (poll ≤ 10s).
  4. `atmux handoff <original> <shadow>` — moves inbox + claimed task + per-member kanban-cursor.
  5. Confirm shadow ack (poll inbox ≤ 10s).
  6. `atmux pause <original>` (NOT kill — preserves rollback).
  7. Mark `done` in state file; Discord `[whip-account-swap-success]`.
  8. Dispatch next member.
- **Concurrency.** Sequential, one-at-a-time. Per-team flock at `.atmux/state/account-swap.lock` prevents thrash.
- **Hard cap per-member: 5min.** Aborts a single swap if it overruns; doesn't kill original; logs + flags; moves on.
- **Worst-case math validation:** 8 members × 5min = 40min. At 75% used on 5h window = 75min remaining → fits with healthy buffer. At 90%, 10% remaining = 30min → DOESN'T fit (mid-swap exhaustion). 75% is the recommended default (per ADR-056 §"Push-back").

### Configuration (team.json::whip)

```jsonc
{
  "whip": {
    "accountFallback": ["ifca", "unum", "personal"],   // priority order
    "accountSwapTriggerThreshold": 75,
    "accountSwapExcludeRoles": ["lead", "planner", "reviewer"]
  },
  "members": [
    { "name": "worker-1", "claudeAccount": "icloud", ... }
  ]
}
```

Empty `accountFallback` (default `[]`) disables account-swap entirely — falls through to ADR-053 budget-pause behavior.

### Recovery flow

After swap, the team has 2× rows for each swapped member: `<original>` (paused) + `<original>-swap` (active). On budget-window-refresh:

- **Today (v1):** the original stays paused. Operator manually resumes via `atmux resume <original>` if/when desired. Then the team has 2× active workers — both can claim, doubling throughput temporarily, but you must remove one before next swap cycle (otherwise shadow-naming collisions cascade).
- **Recommended manual cleanup pattern:**
  ```bash
  # After window-refresh, decide which to keep:
  atmux pause <original>-swap    # keep original
  # OR
  atmux resume <original>-swap   # keep shadow (already active)
  atmux pause <original>         # keep original paused; no-op if already
  # Eventually rotate the unused one out:
  atmux rotate <unused>          # /clear and re-brief if you want to keep around
  ```
- **Future (planned):** explicit `atmux team rotate-back` verb or post-resume reconciliation feature. See ADR-056 §OQ-3 below.

### Lead/planner protection

Even with `selfHealEnabled: true` and a stuck account, the lead + planner are NEVER swapped. Their cross-conversation context is in conversation memory, not state files; swap would wipe it. If the LEAD's account is the one exhausting and no other worker can be swapped to relieve pressure → the team falls through to ADR-053 budget-pause normally.

---

## 🔭 Open question — post-resume reconciliation (ADR-056 §OQ-3)

After an account-swap pass, every swapped member has a duplicate row in `team.json::members[]`: the original (paused) and the shadow (active). On `atmux resume <original>` post-window-refresh, the team has 2× workers for that lane. Operators today must manually choose which to keep + pause the other (see "Recovery flow" above) — there is **no automated swap-back or roster reconciliation** in v1.

**Why it's an open question:** the right shape depends on operational patterns we haven't observed yet. Three candidate solutions surfaced in ADR-056 §OQ-3:

1. **`atmux team rotate-back` verb.** Operator runs explicitly post-refresh; takes a paused-via-swap roster and unwinds the shadows back to originals.
2. **Auto-cleanup at swap-back.** When trigger detection sees the original's account healthy AND no in-flight tasks on the shadow → automatic resume + shadow-pause.
3. **Roster cleanup ADR follow-up.** Larger rework that introduces "swap epochs" with explicit start/end markers.

**For now:** operators manually reconcile post-refresh per the pattern in §"Recovery flow". Discord `[whip-account-swap-pass-complete]` includes a roster summary so the post-refresh state is visible. Driver-inbox entry at swap-pass-close lists from→to map for audit. Track this as ADR-056 OQ-3 — surfacing here so operators know the rough edge exists and don't expect auto-cleanup.

---
## TL;DR for future driver

You are the **driver** of the atmux-bun port. Team mode active (4 members in tmux session `atmux` windows 2-5). **25/25 verbs done, 1543 tests pass, V-01 up SHIPPED @ec96c7e (composite wizard→doctor→start→attach).** Phase 2 closed — verb ports + R-1..R-5 complete.

After `/clear`:

1. Read this file + PLAN.md §6.2/§6.3 + MEMORY.md
2. Check team state via tmux capture-pane on lead window for triage of any in-flight queue items (R-6 + ADR-025 queued post-V-01 per driver-inbox)
3. **Post-Phase-2 next batch (Phase 3 — parity harness)** — see PLAN.md §3 for shape
4. **George's standing requests still in flight:**
   - I-5 cage-attach (Phase 5)
   - I-6 Discord decision-defence — template added in V-25, invocation site = V-27 (post-cutover)
5. **Driver-inbox:** `~/.claude/teams/atmuxbun/driver-inbox.md` — V-01 shipped entry at 18:34 MYT; R-6 + ADR-025 queued by lead post-Phase-2. Lead is autonomous on dispatch.
6. **Install topology** (per ADR-047): `/usr/local/bin/atmux` → dev tree (`/root/work/src/atmux/bin/atmux`). dev edits = live runtime atmux. Fall back to `/opt/atmux-stable` via symlink swap if dev breaks.

*Update this file when major state changes happen. The verb checklist itself lives in PLAN.md §6.2 — keep status flips there, not here.*
