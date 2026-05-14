# ADR-111: Integration contract with `/coordination:*` Claude skills plugin

**Status:** accepted (immediate items I-1, I-2) + proposed (deferred items I-3, I-4)
**Date:** 2026-05-05
**Owner:** driver

## Context

`/coordination:session`, `/coordination:team`, `/coordination:whip`, and the related Claude skills plugin (`~/.claude/skills/coordination/` and `~/.claude/skills/whip/`) implement the Driver/Lead/Member dance described in `~/.claude-unum/CLAUDE.md` § Team Roles & Driver Mode. They were authored against bash-atmux conventions and assume a small set of filesystem and tmux invariants:

| Invariant | Skills expect | Bash atmux | atmux-bun (post-ADR-110) |
|---|---|---|---|
| Lead window name | `__<team>__team-lead` regex match | `__<team>__<emoji>team-lead` ✅ | `<emoji>team-lead` ❌ |
| Member window name | `__<team>__<member>` regex match | `__<team>__<emoji><member>` ✅ | `<emoji><member>` ❌ |
| Lead-uptime marker | `~/.claude/teams/<team>/lead-session-start.txt` (epoch seconds) | not written ❌ | not written ❌ |
| Driver→Lead inbox | `~/.claude/teams/<team>/driver-inbox.md` | `.atmux/driver-inbox.md` (per-project) ❌ | `.atmux/driver-inbox.md` (per-project) ❌ |
| Lead's own work queue | `~/.claude/teams/<team>/lead-queue.md` | not written ❌ | not written ❌ |
| Last-discord-flush marker | `~/.claude/teams/<team>/last-discord-flush.txt` | not written ❌ | not written ❌ |
| Team lifecycle verbs | `/team start`, `/team stop`, `/team cleanup`, `/team rotate-lead` | n/a (atmux-side) | n/a (atmux-side) |
| Whip cron contract | `*/10 * * * * whip-watchdog.sh <team>` | n/a | unported (V-25) |

The ADR-110 prefix drop is the only **deliberate** divergence. The `~/.claude/teams/<team>/...` family of paths was simply never implemented on the atmux side because atmux predates the Driver Mode skills and chose to keep all coordination state inside `.atmux/` per-project.

The result today: `/coordination:session cont` invoked against an atmux-bun team falls back to `MODE=solo` (because `tmux list-windows | grep -q '^__<team>__team-lead$'` returns nothing), `/session preclear` skips the lead-uptime informational line (no marker file), and `/whip` would key off paths atmux doesn't populate. The skills don't error — they degrade silently — which is worse: the operator believes the integration works.

This ADR pins the contract and resolves the asymmetry in two waves: immediate (I-1, I-2) and V-25-deferred (I-3, I-4). The split is deliberate — items 3 and 4 are the **driver-inbox path** and the **`/team` shim**, both of which are exercised primarily by `/whip`, the verb still unported. Picking the canonical path now risks double-rework when V-25's design surfaces real constraints.

## Decision

### Immediate (I-1 + I-2) — land alongside or before V-25

#### I-1: Lead-uptime marker file

atmux writes `~/.claude/teams/<team>/lead-session-start.txt` containing `<epoch-seconds>\n` whenever a member with `role=team-lead` is spawned by `start`, `add-member`, or `rotate-lead`. atmux clears the file on `stop` (after the session is killed) and on `rotate-lead` (before re-spawning the new lead — so `/whip §0.3` sees the rotation as a fresh start rather than 60+ minutes of accumulated uptime).

Path scoping rationale: per-team-name (NOT per-worktree). `~/.claude/teams/<team>/` matches the existing `/coordination:*` path family, and at-most-one-active-team-per-name is already an atmux invariant (the tmux session name `atmux-<team>` is also globally scoped). Worktrees that want different leads must use different team names — same constraint as today.

Implementation surface (~12 LOC + tests):
- `src/core/common.ts::claudeTeamDir(team)` returning `${HOME}/.claude/teams/${team}` (helper, mirrors existing `getAtmuxDir`).
- `src/core/common.ts::leadSessionStartPath(team)` returning `${claudeTeamDir}/lead-session-start.txt`.
- `start.ts` after the team is up + before returning: if any member has `role=team-lead`, `mkdir -p` the dir, write `${epochSeconds}\n` atomically. Idempotent on incremental restart (re-write same value or skip if file exists with recent ts — the latter is cheaper).
- `add-member.ts` when the new member has `role=team-lead`: same write.
- `rotate.ts` (`rotateLead` flow): clear-then-rewrite around the `/clear` + brief paste.
- `stop.ts` after `tmux kill-session`: best-effort `rm` of the file (ENOENT swallowed).

#### I-2: Window-name detection helper — sidecar marker + `atmux which lead-window` subcommand

Two complementary surfaces, both populated by atmux, either of which a skill (or operator script) can consult without grepping tmux:

1. **Marker file** — `~/.claude/teams/<team>/lead-window-name.txt` containing the literal current lead window name (e.g. `🗺️team-lead\n`). Written/cleared in lockstep with I-1's marker. Skills that already do filesystem reads pay no extra cost.
2. **Subcommand** — `atmux which <kind> [name]` where:
   - `atmux which lead-window` → prints the lead window name (file content), exit 0; exit 2 if no team or no lead.
   - `atmux which member-window <member-name>` → prints `<emoji><member>`, exit 0; exit 2 on unknown member.
   - `atmux which session` → prints the tmux session name (`atmux-<team>`).
   - `atmux which lead` → prints the lead member's name (no emoji).

The subcommand is the canonical query for shell scripts; the marker file is the canonical query for in-process tools. Both are kept in sync by atmux — the marker is the cache, the subcommand reads team.json + the marker.

Skills update (out of this ADR's scope but the contract this enables):
- `/coordination:session` mode detection switches from `tmux list-windows | grep -q '^__<team>__team-lead$'` to `[ -f ~/.claude/teams/<team>/lead-window-name.txt ] && tmux list-windows -a -F '#{window_name}' | grep -qFx "$(cat ...)"` — falls back to the existing regex when no marker file exists (preserves non-atmux behaviour).

ADR-110 stands. The operator-stated preference for `<emoji><member>` over `__<team>__<emoji><member>` is explicit and recent; reverting to satisfy the skill would be the wrong tradeoff.

### Deferred to V-25 (I-3 + I-4) — pick canonical path then

#### I-3: Driver-inbox path alignment

Two candidates:

- **(a)** Keep `.atmux/driver-inbox.md` canonical; symlink `~/.claude/teams/<team>/driver-inbox.md → .atmux/driver-inbox.md` so skills find it. Pro: no behaviour change for atmux's `tell-lead`. Con: symlinks across `$HOME` ↔ project tree are fragile (worktree pruning, project moves).
- **(b)** Move canonical to `~/.claude/teams/<team>/driver-inbox.md`; have `tell-lead` write there + remove `.atmux/driver-inbox.md`. Pro: matches the rest of the `/coordination:*` family. Con: breaks the project-locality invariant (operator can't grep their checkout to see active asks; they have to know to look in `~/.claude/teams/`).
- **(c)** Dual-write: `tell-lead` writes both copies; lead reads `~/.claude/teams/<team>/driver-inbox.md`. Pro: belt-and-suspenders. Con: drift risk (two sources of truth).

Decision deferred until V-25's whip + driver-inbox-poll loop is concrete. Whip is the primary driver of inbox reads; the right canonical path is whichever one V-25 finds cheapest to consume.

#### I-4: `/coordination:team` skill shim

`/coordination:team` exposes verbs `start`, `stop`, `add`, `clear`, `cleanup`, `bootstrap`, `rotate-lead`, `rotate-member`. atmux exposes the same surface area under `atmux start`, `atmux stop`, `atmux add-member`, `atmux rotate`, etc.

Two integration paths:

- **(a)** Ship `~/.claude/skills/coordination/team/scripts/dispatch.sh` that detects `command -v atmux && atmux which session > /dev/null` and shells out to `atmux <verb>` instead of running the bash-atmux fallback. Atmux owns the implementation, skill stays the contract.
- **(b)** Update `/coordination:team` skill source to natively support atmux + bash-atmux backends via a `runtime` setting in `.claude/team.json`.

Decision deferred to V-25. The shim approach is cheaper to land; the native approach is cleaner long-term. V-25 will decide based on how invasive whip's `/team`-skill calls turn out to be.

### Whip cron contract (V-25 commitment, no ADR change needed)

V-25's port of `lib/whip.sh` MUST preserve the `*/10 * * * * /path/to/whip-watchdog <team>` cron shape. The `whip-watchdog` binary may be renamed (`atmux whip-watchdog` is fine) but the cron entry, the 10-minute cadence, and the per-team scoping are part of this contract. Any change to that surface needs its own ADR.

## Consequences

### Positive

- **`/coordination:session cont` resumes atmux teams correctly** once I-1 + I-2 land: mode detection finds the lead window via the marker file, preclear's informational uptime line populates, and rotate-lead's 60-min trigger keys off the right epoch.
- **Skills stay drop-in for non-atmux teams** — every change is additive (new files, new subcommand) with backward-compatible fallbacks. No regression risk for users running bash-atmux or no atmux at all.
- **ADR-110 stands** — the operator's window-naming preference is preserved; the integration cost is paid by sidecar files rather than UI ergonomics.
- **Future-proof** — V-25's design lands with full knowledge of which paths are real vs aspirational. No double-rework.

### Negative / accepted

- **Two sources of truth for the lead window name** (the actual tmux window + the marker file). Drift if atmux crashes mid-spawn or if the operator manually `tmux rename-window`s. Mitigation: `atmux doctor` (V-24) gains a check that reconciles the marker against the live window list. Stale markers are caught at the next `atmux start` / `atmux which lead-window` call.
- **Atmux now writes outside `.atmux/`** — the `~/.claude/teams/<team>/` writes are a new dependency. Documented here + in `atmux help`. Cleanup on `atmux stop` is mandatory (best-effort, ENOENT-safe).
- **Skills-side patches needed for full benefit** — the marker file + `which` subcommand are no-ops until the skills are updated to consume them. Risk: atmux ships the producer-side and the consumer-side never lands. Mitigation: ship the skill PR (or in-tree skill override at `~/.claude/skills/coordination/`) in the same week as I-1 + I-2.

### Cascade

- I-1: `start.ts`, `add-member.ts`, `rotate.ts`, `stop.ts`, `core/common.ts` (helpers), tests in `tests/unit/verbs/start.test.ts` + `add-member.test.ts` + `rotate.test.ts` + `stop.test.ts`.
- I-2: new `src/verbs/which.ts`, dispatch in `cli.ts`, marker file writes co-located with I-1, tests in `tests/unit/verbs/which.test.ts`.
- I-3 / I-4: V-25 design doc (a future ADR, likely 019 or 020) + corresponding implementation.

## Alternatives considered

### A. Revert ADR-110's prefix drop

Rejected. The operator's stated preference is explicit and recent (2026-05-05), and the prefix-drop benefit (~80 chars reclaimed in tmux's window-list at 8-member teams) is real. The skill-side cost of consuming a sidecar file is small.

### B. Patch the skills directly to support atmux's existing layout

Rejected as the primary path. The skills are owned by `coordination` (a separate plugin), and changing them to be atmux-aware couples the plugin to atmux. The marker-file approach is a thin contract atmux + skills can both implement without coupling.

(B) is fine as a *supplementary* change once the marker contract is live — the skills can switch to "prefer marker, fall back to regex" without taking an atmux dependency.

### C. Make atmux write the full `~/.claude/teams/<team>/...` family eagerly (lead-queue, last-discord-flush, etc.)

Rejected for now. Only `lead-session-start.txt` and `lead-window-name.txt` are needed for I-1 + I-2's stated benefit (correct mode detection + uptime tracking). The rest are populated by skills as a side effect of normal operation; atmux pre-creating empty files is wasted IO and risks divergence (atmux's empty file racing with the skill's first write).

V-25's whip integration will surface whether `lead-queue.md` or `last-discord-flush.txt` need atmux-side seeding — defer until then.

### D. Ship I-3 + I-4 now (don't defer to V-25)

Tempting (full alignment in one shot) but rejected. V-25 (whip) is the primary consumer of both the driver-inbox path and the `/team` shim. Picking the canonical inbox path before knowing whip's read pattern risks a late re-pick; shimming `/team start` → `atmux start` before V-25 surfaces the actual `/team`-shaped calls whip will make is design-on-faith. The deferral cost is one extra commit later; the wrong-path cost is a refactor.

## References

- ADR-106 (WIP-bash deferral) — governs cross-language drift; the symmetric position to take here.
- ADR-110 (window naming — drop `__<team>__` prefix) — the originating divergence this ADR mediates.
- `~/.claude-unum/CLAUDE.md` § Team Roles & Driver Mode — defines the marker files + driver-inbox conventions skills consume.
- `/coordination:session` skill source — `~/.claude/skills/coordination/session/SKILL.md` (mode detection at Step 0, marker read at preclear Step 1).
- `/coordination:whip` skill source — `~/.claude/skills/coordination/whip/whip-prompt.md` § 0.3 (60-min auto-rotation reads `lead-session-start.txt`).
- PLAN.md §6.3 — integration tasks I-1..I-4.
