# Investigation: bare `[whip]` Discord emitters

**Date**: 2026-05-09
**Driver-ref**: ADR-079 §C / Finding #4 (sopx-driver 2026-05-08 18:35 MYT)
**Scope**: locate every emitter of bare `[whip]` Discord pings (no namespace suffix), correlate with the operator's `sopx/.atmux/logs/discord.log` measurement (~275 pings/24h, 90% bare-`[whip]` boilerplate), recommend a fix path per emitter.

## Method

```bash
# Bash candidates — archived bash atmux + any historic worktrees:
grep -rn '\[whip\]' .archive-bash-atmux-20260507/
grep -rn '"whip"' .archive-bash-atmux-20260507/
ls ~/.claude/worktrees/atmux*    # → no matches (deprecated long ago)
ls /root/work/sopx                # → cross-team, separate audit lane

# Bun candidates — current TS source:
grep -rn 'template:\s*["'\''`]whip["'\''`]' src/
grep -n '"whip"' src/abstractions/discord.ts
```

## Findings

### 1 emitter total (bash; bun is clean)

| # | Host                                         | Site                  | Header literal                      | Triggered by                   |
|---|----------------------------------------------|-----------------------|-------------------------------------|--------------------------------|
| 1 | `.archive-bash-atmux-20260507/lib/whip.sh`   | `:715`                | `💥 **[whip]** · ${team} · ${ts}`   | bash whip aggregator — fires whenever `findings[]` is non-empty after all sub-passes (audit, decisions, flags, budget, …). |

### Bun — clean

- `src/abstractions/discord.ts:34-99` — `DiscordTemplate` union literals are all namespaced (`whip-progress`, `whip-blocker`, `whip-heartbeat`, `whip-decisions`, `whip-overdue`, `whip-budget`, `whip-config-drift`, `whip-budget-pause`, `whip-budget-resume`, `whip-budget-warning`, `whip-budget-refresh-soon`, `whip-account-swap-{start,success,fail,pass-complete}`, `whip-watchdog`, `whip-self-heal-{attempt,result}`, `whip-perm-mode-drift`, `whip-defunct-cwd`).
- `grep -rn 'template:\s*["'\''`]whip["'\''`]' src/` returns **zero hits**. `"whip"` appears at `src/abstractions/discord.ts:650` only as a config-path component (`["whip", "budgetPauseThreshold"]` in a comment), not as a template literal.
- The compile-time R10 invariant (the literal-union type) prevents bun from EVER emitting bare `[whip]` from source.

## Volume attribution (operator measurement)

sopx-driver 2026-05-08 18:30 MYT measured `sopx/.atmux/logs/discord.log` at ~275 pings/24h with ~90% body bytes prefixed `💥 **[whip]** ·`. Crossing this with the find above:

- Origin host: bash atmux installed into `sopx/` (NOT this repo's `.archive-bash-atmux-20260507/` — the archived copy never runs against `sopx`'s discord.log; it's the reference body kept here for the bun-port migration).
- The single emitter line is `lib/whip.sh:715` regardless of installed-copy provenance — same bash source landed on the sopx host pre-archive cutover.
- ADR-079 §D will land per-finding hash dedup (whip-impl lane). Once §D ships, the **bun** whip emits namespaced templates with transition-only hashing — bare-`[whip]` volume only persists for as long as the sopx host runs bash atmux. Operator's pull of the bun-port main is the canonical close-out for sopx.

## Recommended fix paths

Per ADR-079 §C / OQ-4 (lead ack 13:18 MYT, "investigation+lint only — no aggressive bash teardown this round"):

| Emitter site                                  | Recommended fix                                                                                                                   | This commit?                       |
|-----------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------|------------------------------------|
| `.archive-bash-atmux-20260507/lib/whip.sh:715` | **No bash patch this round.** sopx pulls bun-port main → bun's namespaced templates replace the bash aggregator at the source.    | NOT in scope (OQ-4 deferral).      |
| (future) sopx host bash atmux                  | Same as above — bun-port migration on sopx is sopx-team work, not atmux-team work (per ADR-079 §C "Out of scope" §3).             | NOT in scope.                      |
| Future bun src/                                | **Structural lint** (`tests/unit/abstractions/discord-no-bare-whip.test.ts`) fails CI when any contributor adds a bare `template: "whip"` literal. Pre-empts the regression where someone adds `"whip"` to `DiscordTemplate` union and silently bypasses namespacing. | ✅ ships in this commit.            |

## Status

- Bun source: ✅ no bare-whip emitters; lint pinned.
- Bash archive: 1 known emitter, OQ-4-deferred (port-then-disable plan owned by sopx-team).
- Operator volume target (≤80/24h): expected to hit once sopx pulls bun-port main + ADR-079 §D's per-finding dedup ships in whip-impl's lane.
