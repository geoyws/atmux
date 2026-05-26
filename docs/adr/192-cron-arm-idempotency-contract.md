# ADR-192: Cron-idempotency contract for "arm a cadence" verbs

**Status**: Accepted — ratified by driver 2026-05-21 (every /Xloop / arm-a-cadence verb runs CronList before CronCreate + skips on match; fuzzy prompt-hash + interval-exact match algorithm; §OQ recommendations as-written)
**Date**: 2026-05-20
**Driver-ref**: driver-2026-05-20-16:09-MYT (cockpit /loop idempotency gap)
**Impl ownership**: claude-skills dotfiles (NOT atmux source) per memory `feedback_claude_skills_dotfiles_territory` — this ADR is the SPEC; impl lives in operator-managed `~/work/journals/.sb/_dotfiles/claude-shared/skills/<skill>.md` or equivalent. atmux contains the ADR + cross-refs only.

## Context

2026-05-20 session: 2 parallel `/bruh` crons fired concurrently within atmux cockpit driver Claude Code session:
- `f5231afd` with cron expression `7,22,37,52 * * * *` (every 15 minutes starting at minute 7)
- `3a23dcd7` with cron expression `*/15 * * * *` (every 15 minutes starting at minute 0)

Both armed via Claude Code `CronCreate` tool with same prompt (`/bruh you are sentinel, make all teams work, unblock everyone`) at different timestamps. Recency-gate inside `/bruh` skill absorbed the overlap cleanly (no double-action observed), but the footgun is real: if any future `/Xloop` skill has weaker recency-gating, two armed crons would double-execute mechanical work.

Operator manually deleted `f5231afd`; `3a23dcd7` remains active. No autonomous detection of the duplicate at arm-time.

### Failure-mode taxonomy

1. **Same-prompt re-arm**: operator runs `/bruhloop` twice (e.g. retry after thinking the first invocation failed); second arm overlaps first.
2. **Fuzzy-prompt re-arm**: operator runs `/bruh you are sentinel` then later `/bruh sentinel mode` — semantically identical intent; today they arm as TWO crons because exact-string match fails.
3. **Interval-drift re-arm**: `/loop 15m /foo` then later `/loop 15min /foo` (different interval string for same minute count) — same scheduling intent; two arms.
4. **ScheduleWakeup re-arm**: `/bruhloop` (dynamic-paced) wakes itself via `ScheduleWakeup`; if the operator manually re-fires `/bruhloop` during the wait, two wake-cascades run in parallel.

### atmux-side OS-crontab prior-art

`atmux start` / `atmux up` already install OS-crontab blocks for whip / report / decisions-digest using sandwich markers:

```
# >>> atmux:team=atmux
*/5 * * * * cd /root/work/src/atmux && atmux whip --auto
*/30 * * * * cd /root/work/src/atmux && atmux report
0 */4 * * * cd /root/work/src/atmux && atmux decisions digest
# <<< atmux:team=atmux
```

The marker-sandwich is the OS-crontab idempotency mechanism: `atmux start` removes any existing `>>> atmux:team=<name>` block before installing the new one. This is the canonical pattern for "arm a cadence" without duplication.

Claude Code's harness `CronCreate` / `CronList` tools do NOT support marker-sandwich. Each `CronCreate` adds a new cron entry with a new id; nothing dedups them. Idempotency must be done by the caller (the skill body) via pre-arm `CronList` query.

## Decision

### Rule 1 — Before arm, list existing arms; skip if match

Every `/Xloop` slash-command (any skill that arms a Claude Code cron via `CronCreate`) MUST run `CronList` before `CronCreate` and check for matching arms. If a matching arm exists, SKIP `CronCreate` and log:

```
ℹ cron already armed (id <X>) — skipping duplicate arm
```

Match algorithm per Rule 2.

### Rule 2 — Match algorithm: fuzzy prompt-hash + interval-exact

A "matching arm" is defined as:

1. **Interval matches exactly**: same cron expression OR same dynamic-pacing interval (e.g. `15m` matches `15min` matches `*/15 * * * *`)
2. **Prompt-hash matches fuzzily**: normalize whitespace + lowercase + drop common-stopword filler; hash; compare. Hashes match within Levenshtein-distance-of-N or similar fuzzy tolerance (operator-configurable, default N=3 normalized-tokens).

Examples that SHOULD match (dedup):
- `/bruh you are sentinel, make all teams work` vs `/bruh sentinel mode — make teams work`
- `/loop 15m /foo` vs `/loop 15min /foo`

Examples that should NOT match (allow both arms):
- `/bruh you are sentinel` vs `/bruh you are gardener` (different roles)
- `/loop 15m /foo` vs `/loop 30m /foo` (different intervals)

Fuzzy implementation: skills can use a normalization-then-Levenshtein library OR a simpler bag-of-words-jaccard. The exact algorithm is impl-team's call; this ADR specifies the CONTRACT (fuzzy + interval-exact), not the algorithm.

### Rule 3 — ScheduleWakeup-driven loops: same check at wake-time

For dynamic-paced loops (e.g. `/bruhloop`) that use `ScheduleWakeup` to self-schedule:

- At wake-time, BEFORE re-arming the next `ScheduleWakeup` call, run the same dedup check
- If a parallel `/bruhloop` was manually armed during the wait, detect via current-process metadata OR cron-state file
- Skip re-arm if another instance is already mid-flight

This is harder than Rule 1 because `ScheduleWakeup` is process-internal — no `CronList` equivalent. Implementation likely uses a state-file marker (`~/.atmux/state/loop-arm-<hash>.json`) written at arm-time + cleaned at exit; pre-arm check reads the marker.

### Rule consistency check

| Surface | Mechanism | Marker storage |
|---|---|---|
| OS crontab (atmux start) | sandwich markers `# >>> atmux:team=<name>` | OS crontab itself |
| Claude Code cron (CronCreate) | pre-arm CronList + fuzzy-match | Claude Code cron list |
| ScheduleWakeup (dynamic /Xloop) | pre-arm state-file marker | `~/.atmux/state/loop-arm-<hash>.json` (or similar; impl-team's call) |

All three converge on the same contract: "before adding a cadence, check if it already exists; skip if so."

## Consequences

### What changes for which lanes

**SKILLS lane (dotfiles, NOT atmux)** — primary impl surface:
- `/loop` skill body: pre-arm `CronList` + fuzzy-match
- `/bruhloop` skill body: pre-arm `CronList` + state-file marker for ScheduleWakeup path
- `/whip-loop` (if exists) + any future `/Xloop` skill: same pattern
- Shared utility (skill or atmux-helper): the fuzzy-match algorithm

**ATMUX lane** — supporting role only:
- This ADR (the spec)
- Optional future: `atmux cron-check --prompt-hash <X> --interval <Y>` helper verb that queries OS crontab + (if exposed) Claude Code cron list. Probably NOT worth shipping — Claude Code cron list is in-process tool, not externally exposed. Defer.

**DOCS lane**:
- Cross-link from CLAUDE.md (atmux) §Cron discipline (new section if absent) → ADR-192
- Operator dotfiles documentation: skills implementing the contract reference ADR-192 in their header comments

### What we give up

- **Per-arm uniqueness**: today every `/loop` invocation creates a new arm even when redundant. Rule 1 collapses redundant arms.
- **Manual de-dup overhead**: operator no longer needs to manually `CronList` + `CronDelete` parallel arms.

### Rollback path

If the dedup proves too aggressive (false-positives — operator WANTS two parallel arms with same prompt), skills can:
1. Add a `--force` flag to bypass dedup (operator opts-in to duplicate)
2. Loosen the fuzzy threshold (default N=3 → N=1 only-exact)

## Open questions

1. **(LOW reversibility) Fuzzy-match algorithm**: Levenshtein on normalized tokens vs Jaccard bag-of-words vs LLM-embedding-similarity. Recommendation: Levenshtein on normalized tokens (deterministic, fast, no LLM dep, sufficient for the failure-mode taxonomy). Skills can opt-in to LLM-embedding-similarity if their match quality demands it — out of this ADR's recommendation.

2. **(LOW reversibility) Fuzzy threshold default**: N=3 tokens of distance. Recommendation: 3 (allows "sentinel mode" vs "you are sentinel" to match while disallowing "sentinel" vs "gardener"). Skills can override via env or skill-config.

3. **(LOW reversibility) ScheduleWakeup marker storage**: `~/.atmux/state/` vs `~/.cache/atmux-claude/` vs Claude Code state. Recommendation: `~/.atmux/state/loop-arm-<hash>.json` — sibling to existing atmux state files; operator can grep + inspect. Atomic write + cleanup at exit per ADR-005.

4. **(LOW reversibility) atmux helper verb**: ship `atmux cron-check` OR leave entirely in skills? Recommendation: leave in skills. Claude Code's `CronList` is harness-internal; atmux CLI can't access it. OS crontab idempotency is already covered by `atmux start` sandwich markers. No utility for atmux verb. Defer indefinitely.

5. **(LOW reversibility) Failure mode if check fails**: if `CronList` query fails (Claude Code harness bug), should `CronCreate` proceed anyway OR refuse? Recommendation: PROCEED with warn (operator can manually clean up later); refusing would block legitimate arms on transient errors. Conservative: log the warn loudly.

## Cross-refs

- Memory `feedback_claude_skills_dotfiles_territory` (impl ownership — claude-skills is operator-managed via dotfiles flow; atmux team does not author skill code)
- ADR-086 (atmux pulse — cron substrate prior-art; OS-crontab marker sandwich pattern)
- ADR-008 (decisions verb — sibling cron-managed surface)
- ADR-132 §Amendment 2026-05-20 (cron-polling deprecation under lean-mode — sibling cost-curve theme)
- ADR-189 (lean-mode topology — same cron-deprecation theme; orthogonal but adjacent)
- Memory `project_atmux_install_topology` (atmux state-file location conventions; relevant for Rule 3 marker storage)
- 2026-05-20 16:09 MYT driver-inbox entry (canonical incident report)
