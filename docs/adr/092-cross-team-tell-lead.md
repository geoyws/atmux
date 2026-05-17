# ADR-092: Cross-team `tell-lead --team <name>` — cockpit-walk lookup + caller-scope gate

**Status**: proposed (2026-05-16, ships in same commit as impl T1 per planner-deferred decomp note in t-5f20ba85 body)
**Date**: 2026-05-16
**Author**: atmux team (parent EPIC t-e576dd43; impl by up-impl)
**Parent task**: t-5f20ba85 (ADR-092 impl)
**Driver-ref**: driver-inbox 14:03 MYT §Pillar — file-mod citation `src/verbs/tell-lead.ts:52-93,108-204`. The ADR-091 conflict-surface story (T12) needed a cross-team driver→lead routing path that didn't fall back to operator-driven flag escalation; this ADR records the call-site decision.
**ADR seq**: 6/6 — last in the ADR-089/090/091/092 chain (recursive sessions[] → epic-team lifecycle → epic-merge state machine → cross-team comms).
**Relates**: ADR-089 (recursive `sessions[]` substrate — cockpit-walk lookup depends on the DFS traversal), ADR-090 (epic-team lifecycle, forward-reference — defines `epicTeam.parent` linkage), ADR-091 (epic-merge, forward-reference — first consumer of the conflict-surface path), ADR-029 (tell-lead bash spec — `--team` is a forward-compat extension of the same shape), ADR-058 (cage tier, forward-reference — cross-team routing crosses cage boundaries; documented at §D5).

## Context

### The cross-cage routing gap

`atmux tell-lead <msg>` is the canonical driver→lead routing path — it appends to `.atmux/driver-inbox.md` AND fires a `tmux send-keys` heads-up to the lead's pane. Today it's **single-team only**: the verb reads `team.json` from the cwd, resolves the lead window via `findLead(team.members)`, and pings the lead in the *current* team's cage socket. There's no way to address the lead of a *different* team in the cockpit tree.

Two surfaces have driven the need:

1. **ADR-091 epic-merge conflict-surface** — when an epic-team's gitter hits a merge conflict on `epic-team-base → parent-trunk`, the epic-lead needs to ping the *parent* team's lead to coordinate resolution. Today that path falls back to `atmux flag add` (operator-mediated) — high latency, breaks the autonomy contract.
2. **Driver-inbox 14:03 MYT pillar** — operator request to be able to write into any team's inbox from the cockpit driver, without `cd`-ing into the target team's worktree to invoke `atmux tell-lead` locally.

### Why a single verb extension, not a new verb

Three options were considered:

- **(A) Status quo + `atmux flag add` fallback**. Operator-mediated. High latency. Breaks autonomy contract.
- **(B) New verb `atmux super-tell <team> <msg>`** mirroring `atmux super-status` / `atmux super-tell` cockpit verb family. Doubles the surface; operators learning two near-identical verbs.
- **(C) `--team <name>` flag on the existing `tell-lead` verb**. Single addition; same verb-name; default behavior unchanged. Cockpit-aware resolution lives behind the flag; same-team path is the untouched fast-path.

(C) wins on three axes: discoverability (operators already know `tell-lead`), backward-compat (no flag → existing behavior verbatim), and ADR-089 substrate reuse (the cockpit-walk lookup is the same DFS that `enabledTeams` / `walkSessions` already drives).

## Decision

### (D1) `tell-lead --team <name>` flag — cockpit-walk resolution

`atmux tell-lead --team <name> "<msg>"` resolves `<name>` against `cockpit.json` via **depth-first match on `node.name`** across the recursive `sessions[]` tree. The first matching `type: "team"` or `type: "epic-team"` node wins. Match resolves to:

- `targetRoot` — for `type: "team"` the node's own `root`; for `type: "epic-team"` the nearest ancestor `team.root` (epic-teams share parent's worktree per ADR-089 §F).
- `targetAtmuxDir` — `<targetRoot>/.atmux`.
- `targetTeam` — `loadTeam({ teamDir: targetRoot })`.
- `targetSocket` — `resolveTeamSocket(targetTeam)`.
- `targetLeadWindow` — `buildWindowName(lead.name, lead.emoji, lead.label)` where `lead = findLead(targetTeam.members)`.

Default (no `--team` flag): existing behavior — current team's `team.json` + cwd-derived `atmuxDir` + current cage socket. Untouched fast-path; reviewer pre-flag bans drift here.

### (D2) `findTeamByName(cockpit, name): CockpitTeamLookup | null` helper

New pure helper in `src/core/cockpit.ts`. Recursive DFS over `cockpit.sessions[]` using the existing `walkSessions` walker; returns the first `team` / `epic-team` node whose `name` matches. Returns `null` when no match — caller wraps in a `ConfigError` with a clear "no team <name> in cockpit tree" message.

```ts
interface CockpitTeamLookup {
  type: "team" | "epic-team";
  name: string;
  root: string;       // own root (team) or parent root (epic-team)
  level: number;
  parent?: string;    // populated for epic-team
}

export function findTeamByName(
  cockpit: CockpitShape,
  name: string,
): CockpitTeamLookup | null;
```

Pure (no IO). Exported for direct unit-testing without staging a cockpit.

### (D3) Caller-scope gate — driver / parent / parent-of-target

Cross-team routing is **gated** to prevent member-to-member-cross-team chatter. Per reviewer pre-flag (task body), the policy is symmetric:

| Caller scope | Source | Target | Allowed |
|---|---|---|---|
| `driver` (env `ATMUX_CALLER_SCOPE=driver`) | * | * | ✅ master override |
| any | `T` | `T` (same team) | ✅ degenerate — no cross-team |
| epic-team member | `E` with `parent=P` | `P` (parent) | ✅ child → parent |
| team member | `P` | `E` with `parent=P` (child) | ✅ parent → child |
| epic-team member | `E1` with `parent=P` | `E2` with `parent=P` (sibling) | ❌ refused — must route via parent |
| any | `T1` | `T2` (unrelated) | ❌ refused |

Implemented via `callerScopeAllowed(cockpit, sourceName, targetName, callerScope): boolean` — pure, in `src/core/cockpit.ts`. Refusal emits `ConfigError` with body `cross-team tell-lead refused: <src> → <tgt> not allowed (driver / parent / parent-of-target only)` so operator sees both the policy + the offending pair.

`ATMUX_CALLER_SCOPE` env var is the **master override** — driver pane sets it once on cockpit bootstrap. Documented in ADR + RUNBOOK. Member panes do NOT inherit it (per cage tier — Tier-1 cage members don't get cockpit-level env).

### (D4) Heads-up + socket resolution — already nested per ADR-089

The cross-team heads-up reuses the existing `sendToMember(tmux, atmuxDir, ...)` path. The only delta is which `tmux` instance + which `atmuxDir`. Each is resolved from the target team's `team.json` / `resolveTeamSocket`. Nesting works because every cage tmux socket is per-team (`/tmp/atmux-<team>/sock` or `team.tmuxTmpdir`), and the cockpit driver pane has filesystem read access to every team's `.atmux/team.json` per ADR-058 (operator-tier visibility into every cage).

Reviewer pre-flag (task body): socket resolution must NOT leak a parent-cage prefix. The implementation calls `resolveTeamSocket(targetTeam)` directly on the loaded target `team.json` — no path-construction from source-cage state.

### (D5) Cage-tier interaction — Tier-1 boundary respected

Cross-team `tell-lead` from a member pane (rather than the cockpit driver) only crosses cage boundaries when the policy gate (D3) permits. The parent / child relationship in `cockpit.json::epic-team.parent` is the cage-tier boundary marker; allowed transitions never escalate tier (parent and child both run at the cage's Tier-1 from each other's perspective). The driver pane override (D3 row 1) is the *only* path that can cross arbitrary tier boundaries — already true today for `cd <other-team> && atmux tell-lead`, so this is a structural no-change.

### (D6) ADR-091 conflict-surface migration

ADR-091 T12 (epic-merge conflict surface) currently uses `atmux flag add` as the operator-mediated escalation path. Post-ADR-092 acceptance, T12 migrates to `atmux tell-lead --team <parent>` for the in-band path — `flag add` remains the operator-visible secondary surface (per ADR-091 §Conflict surface 3-way reliability).

## Decision-anchor pre-flags (reviewer enforces)

1. **Same-team default fast-path is byte-identical** — `--team` unset MUST resolve via the existing cwd-derived `getAtmuxDir(dirOpts)` + `requireTeam(dirOpts)` path, NOT through `findTeamByName(cockpit, currentTeamName)`. Avoids regressing the hot path on a cockpit-load failure. Reviewer pre-flag every refactor here.

2. **`findTeamByName` returns FIRST match, not all matches** — name collisions across the tree are operator error (cockpit-validation should catch dupes; this is forward-compat). Reviewer reads the cockpit at load-time + warns on dupe names; the lookup itself stays deterministic.

3. **Caller-scope gate is `else if` chain, not policy table** — the four allowed cases (driver / same-team / child→parent / parent→child) compose disjointly; codify as explicit branches with comments per `D3` table. No fancy policy engine.

4. **`ATMUX_CALLER_SCOPE` env-var name is exact-match** — no `ATMUX_SCOPE` shorthand, no `--scope driver` flag-form (env-only). Cockpit boot sets it once; the env-var-as-trust-boundary aligns with `CLAUDE_GUARD_AGENT` convention.

5. **Refusal error text includes both names** — `<src> → <tgt> not allowed`. The operator needs both ends to triage; a generic "scope refused" hides the policy violation root.

6. **Refusal exit code is BSD `EX_NOPERM` (77)** — distinguishes from `EX_USAGE` (64, wrong-flag) and `EX_CONFIG` (78, broken team.json). Per ADR-099 error-handling table — policy-refusal IS a permission error.

## Acceptance gates

- [x] ADR-092 lands at `docs/adr/092-cross-team-tell-lead.md` Status: proposed
- [x] `src/core/cockpit.ts` exports `findTeamByName(cockpit, name): CockpitTeamLookup | null` + `callerScopeAllowed(cockpit, src, tgt, scope): boolean`
- [x] `src/verbs/tell-lead.ts` parses `--team <name>`, routes through cockpit-walk + scope-gate, falls back to existing behavior on no flag
- [x] Tests: caller-scope matrix (driver / sibling / parent-of-target / unrelated / same-team), cockpit-walk lookup with depth-3 fixture, tell-lead `--team` smoke against staged cockpit
- [x] Same-commit doc per docs-discipline (ADR + CHANGELOG)
- [ ] Reviewer pre-flag pass (Anchors 1-6)
- [ ] ADR-091 T12 migration to `tell-lead --team` (separate Task; out of this scope per ADR-091 §Conflict surface — referenced here for traceability)

## Out of scope

- **Member-to-member cross-team messaging** — not in this brief. `atmux send --team <name> <member> <msg>` is a separate Task if needed; explicitly tell-lead scope only.
- **`atmux doctor` D8 / D9 cross-team-routing health checks** — Task t-c2e544b6 (parent ↔ epic-lead round-trip e2e). Belongs to the same EPIC chain; sequenced after this commit.
- **Sibling-epic-team direct routing** — refused per D3 table. Siblings must route through parent (parent is the coordination apex per ADR-090 §epic-lifecycle).
- **Sub-team coordination outside the cockpit tree** — teams not in `cockpit.json` are invisible to this verb (no ad-hoc team-name → root resolution outside the cockpit; that would re-introduce the pre-ADR-089 "where's the team" guesswork ADR-089 explicitly killed).

## Cross-refs

- [ADR-089](089-hierarchical-cockpit.md) — recursive `sessions[]` substrate; the DFS walker (`walkSessions`) is the load-bearing primitive.
- ADR-090 (epic-team lifecycle, forward-reference; in-flight per parent EPIC t-e576dd43) — `epicTeam.parent` linkage drives the caller-scope policy.
- ADR-091 (epic-merge state machine, forward-reference) — conflict-surface first consumer (T12 migrates post-acceptance).
- [ADR-029](029-driver-lead-team-scope-superdriver-cross-team.md) §F-fix series — bash spec for tell-lead heads-up; `--team` is a forward-compat extension respecting the byte-equal contract on the default path.
- ADR-058 (cage-tier naming, forward-reference) — cage tier; cross-team routing respects Tier-1 boundaries (D5).
- Task t-c2e544b6 — sibling e2e (parent ↔ epic-lead round-trip + doctor D8/D9 extends).
- [ADR-099](099-error-handling.md) — `ConfigError` / BSD exit code mapping (`EX_NOPERM=77` for refusal).
