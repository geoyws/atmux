# ADR-286: Eternal-improvement is retired — the loop, the `improve` verb, and its three Discord templates

**Status**: accepted — operator-direct (George 2026-09-01: *"lets retire or improve the eternal improvement discord msgs"*, then selected full retirement of verb + templates over the ping-only strip and the message-shape fix).

**Date**: 2026-09-01

**Supersedes**: [ADR-052](052-eternal-improvement-loop.SUPERSEDED.md) (the loop substrate), [ADR-149](149-eternal-improvement-gating.SUPERSEDED.md) (the config + backlog gates on that substrate), [ADR-257](257-eternal-improvement-burndown-first-worktree-isolated.SUPERSEDED.md) (burndown-first cycle arming).

**Amends**: [ADR-238](238-orchd-drives-discord.md) §D4, whose verb table reads `atmux improve | KEEP, manual only`. That row was written 2026-05-24, while atmux still owned work-state and orchd was still the planned Discord funnel. Both premises are gone (ADR-275, ADR-276); the row is superseded by §D1 here. ADR-238 itself stays `Proposed` and otherwise untouched.

**Relates**: [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) (cron auto-install retired — removed the `--tick` caller), [ADR-237](237-no-llm-discord-and-whip-removal.md) (whip removal — removed the Mode B caller), [ADR-266](266-shim-sunset-policy-and-first-sweep.md) (§D3 dead-code-removal precedent this follows), [ADR-275](275-external-private-kanban-authority.md) (external kanban is sole work-state authority), [ADR-276](276-orchd-retirement-and-atmux-scope.md) (atmux narrows to tmux cages + `atmux vox`), [ADR-280](280-epic-team-retirement-and-staged-excision.md) (epic-team retirement).

## Context

ADR-052 built an autonomous self-improvement loop: when a team's kanban went empty, instead of letting whip's ADR-043 auto-stop tear the cage down and waste the rest of the Claude budget window, `atmux improve` would arm a run, the planner would decompose "what can we improve on?" into kanban Tasks, members would claim and ship them, gitter would merge, the cycle would close, and the loop would re-arm until the token budget was exhausted. Three Discord templates narrated it: `🌱 [eternal-improvement-{start,progress,done}]`.

**Every input to that design has since been retired.**

Both of its callers are gone:

- `src/core/cron.ts` is a no-op shim whose own header reads `// ADR-233 §retired — cron auto-install retired (orchd, the runtime that replaced it, was itself retired per ADR-276)`. `installCockpitCronBlock` returns immediately. Nothing fires `atmux improve --tick`, so no cycle ever closes, re-arms, or terminates on its own.
- Mode B was armed by whip's auto-stop intercept (ADR-052 §Whip-integration, ported into `_atmux_whip_check_auto_stop` per ADR-115). Whip was removed by ADR-237 §D1. Nothing fires `atmux improve --idle-fallback --default-budget`.

And its premise is gone:

- ADR-275 makes the external `kanban` CLI the sole authority for tasks, epics, stories and claims. The loop's core move — planner lands improvement Tasks into atmux's own kanban, `isCycleClosable` reads them back to decide the cycle is done — assumes atmux owns that state.
- ADR-280 retires epic-teams; ADR-257 had pinned the loop to `IMPROVEMENT_EPIC_ID = "e-a25968cc"` and worktree-isolated epic dispatch.
- ADR-276 narrows atmux's scope to tmux cages and `atmux vox`. An autonomous work-generating loop is not in that scope.

What remains is a verb reachable only by hand, and three Discord templates that fire only when it is run by hand. The operator does not run it by hand.

**The messages were also defective on their own terms**, which is what surfaced this. Two, measured in `src/verbs/improve.ts::tickCycle` before removal:

1. **Two messages per cycle close, one of them false.** The tick fired `firePingProgress` — whose last bullet already reads `🔜 cycle N+1 starting` — and then, on the re-arm path, immediately fired `firePingStart` again. The start renderer's verdict is `🟢 **Shipping** — eternal-improvement run starting on 1.5M tokens (user-invoked)`. On a re-arm that sentence is wrong: it is a cycle start, not a run start, and the run started cycles ago.
2. **Static bullets re-sent every cycle.** That same re-armed start ping restated `🌱 budget:`, `🎯 mode:` and `📍 runId:` unchanged on every iteration — three bullets of zero new signal per cycle.

Fixing those was the alternative considered (§Alternatives). It was rejected because polishing the narration of a loop with no caller and no premise buys nothing.

## Decision

### D1 — Delete the verb and its supporting modules

Removed outright, with no deprecation shim and no CLI alias:

| Path | Lines | Role |
|---|---|---|
| `src/verbs/improve.ts` | 599 | verb — args, budget resolve, state write, tick loop, ping fires |
| `src/core/improve-cycle.ts` | 404 | cycle mechanics — open/close/pause/resume, closability, arming |
| `src/core/improve.ts` | 192 | budget spec grammar + resolution + runId |
| `src/core/eternal-improvement.ts` | 137 | state-file IO + staleness/active predicates |
| `src/schema/eternal-improvement.ts` | 122 | Zod state schema |

The `case "improve"` dispatch and its import leave `src/cli.ts`; the `improve` row leaves `atmux help`. Invoking `atmux improve` now takes the standard unknown-verb path.

No shim, because ADR-266 §D1 requires every shim to carry an expiry and this one would have no consumer to serve during its window: the verb has had no automated caller since ADR-233, and an alias exists to protect scripts and muscle memory that here do not exist.

### D2 — Delete the three Discord templates

`renderEternalImprovementStart`, `renderEternalImprovementProgress` and `renderEternalImprovementDone` leave `src/abstractions/discord.ts`, along with their `*Opts` interfaces and the three `DiscordTemplate` union literals (`"eternal-improvement-start"`, `"eternal-improvement-progress"`, `"eternal-improvement-done"`).

**Emoji allowlists are trimmed to exactly what dies with them, verified by grep, not by assumption:**

- `🌱` — removed from both `CategoryEmoji` and `ALLOWED_BULLET_PREFIX`. It was the category header and budget-bullet prefix for all three retired templates and for no other renderer. It stays a live **member** emoji elsewhere (`src/core/sync-claude-team-json/color-map.ts` maps it to green); the two surfaces are unrelated and that mapping is untouched.
- `🔜` — removed from `ALLOWED_BULLET_PREFIX`. Its only emitter was the progress template's next-cycle bullet.
- `🎯`, `💰`, `⏱️`, `🛑` — **kept**. All four have live emitters outside the retired templates (account-swap target line, budget-cap bullets, duration bullets, and 🛑 across a dozen stalled/blocked/refusal renderers).

Neither removed emoji is pinned by `tests/unit/abstractions/discord-bullet-prefix-audit.test.ts`'s two floor tests, which assert the driver-auth six and the CLAUDE.md load-bearing primaries.

### D3 — Lead handoff drops its eternal-improvement line

`src/core/lead-handoff.ts` was the only live importer of the retired modules outside the verb itself: it read the state file to render a `🌱 eternal-improvement: ACTIVE (mode=…, budget=…)` / `inactive` line under `## Team state`. The import, the `eternalImprovement` field on `ComposeHandoffArgs`, the render branch and the snapshot block are removed. `budgetPause` and `accountSwap` snapshots in the same block are untouched.

The handoff markdown loses one line. This is a documented-surface change and lands in the same commit as this ADR per `/CLAUDE.md` §"Binding discipline" #2.

### D4 — No state migration; stale state files are inert

`.atmux/state/eternal-improvement.json` is not migrated, not read, and not deleted. After D1+D3 nothing reads it, so a file left behind on any host is inert. Teams need no action; `atmux doctor` gains no orphan probe for it, because a probe for a file nothing reads is the same dead weight this ADR is removing.

### D5 — Superseded ADRs are renamed, not deleted

ADR-052, ADR-149 and ADR-257 are renamed to the repo's `NNN-*.SUPERSEDED.md` convention and moved to the INDEX's §Superseded (skip) list, matching how ADR-083/086/132/143/158/183/185/204/206/207/236 were handled. Their bodies stay intact for trace, each gaining a superseded banner above its original status line. Inbound cross-references were repointed at the new filenames in the same pass — ADR-160 §193 (→149) and ADR-258 §Relates (→257) were the only two live ADRs linking in, plus the renamed files' own cross-links. A link sweep over `docs/adr/` confirms zero unresolved references to 052/149/257/286; the 50 pre-existing broken intra-ADR links elsewhere in the tree (wrong slugs against correct numbers) are untouched and out of scope.

## Consequences

- ~1,454 lines of source plus their test suites leave the tree. The `improve` concept leaves `atmux help`, `README.md`, `docs/PRD.md` and `src/verbs/README.md`.
- Three Discord templates stop existing. Since neither auto-caller has existed since ADR-233/237, the observable change to the operator's Discord channel is nil — which is the point: this removes dead emitters, it does not quiet a live one.
- The Discord template surface shrinks by three named templates and two allowlist entries, and `DiscordTemplate`'s compile-time R10 enforcement now covers a smaller, fully-live set.
- Lead handoffs get one line shorter.
- **Breaking**: `atmux improve` no longer exists — it now takes the unknown-verb path (`atmux: unknown verb: improve`, exit 64). No caller was found: a repo-wide grep (excluding worktrees) returns only prose and historical ADR text, the `plugins/atmux/skills` tree has none, and the crontabs on both hosts that run teams were read on 2026-09-01 — `@@hax` carries no `atmux improve` line (its only atmux entries are a commented-out `lane-tick` and two lines disabled 2026-05-24), and `@@mbp` carries no atmux entries at all. Consistent with ADR-233 having retired cron auto-install.
- The Claude-side `♻️ eternal improvement` heuristic in `plugins/atmux/skills/{bruh,whip,sweep}` — which files one `[improve P3]` task per idle cycle — is a **separate mechanism and is out of scope here.** It shares the name and nothing else: no shared code, no state file, and no Discord template. It is untouched by this ADR. Naming collision noted so a future reader does not conclude this ADR retired it.

## Alternatives considered

| Option | Why not |
|---|---|
| Fix the message shape — silence the re-arm start ping, drop the static bullets, keep the loop | Polishes narration for a loop with no caller and no premise. Was on the table and explicitly declined by the operator. |
| Strip the Discord pings, keep `improve` as a silent manual loop | Leaves ~1,450 lines of uncalled subsystem to carry, read past and keep compiling, for a verb the operator does not invoke. |
| Keep it behind ADR-149's `eternalImprovement.enabled: false` | That gate was never implemented — `src/schema/team.ts` has no `eternalImprovement` block, only a stale comment referencing it. Nothing to flip. |
| Deprecation shim + one-release window per ADR-266 §D1 | A window serves callers that need to migrate. There are none. |

## Cross-references

- ADR-052 / ADR-149 / ADR-257 — superseded here; see D5 for their renames.
- ADR-238 §D4 — its `improve | KEEP, manual only` row is amended by D1.
- ADR-266 §D3 — the dead-code-removal precedent (zero live importers, audit-verified) this follows.
- ADR-275 / ADR-276 / ADR-280 — the scope narrowing that removed this loop's premise.
