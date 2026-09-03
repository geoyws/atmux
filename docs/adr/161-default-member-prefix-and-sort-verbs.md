# ADR-161: default-member `_-prefix` convention + window-name format split + topographic-normalization verbs

**Status**: accepted
**Date**: 2026-05-16
**Driver-ref**: 2026-05-16 driver session — operator: apply ADR-135 D2 `_-prefix` convention from cockpit-roles (`_superdriver` / `_medic` / `_martinet`) to in-team default members. Plus ship the missing topographic-normalization verbs (sort/move/swap).
**Parent EPIC**: t-2d8363f4 (this ADR is the umbrella; TR1-TR4 filed in same session per [[feedback_decomp_same_session_with_deps]]).
**Cross-refs**: ADR-135 (cockpit naming convention — extends D2 `_-prefix` to team-default members; supersedes D3 uniform-hyphen-separator), ADR-136 (hot-rename label-layer split — id vs label vs emoji; this ADR's prefix change lands in the LABEL layer only), ADR-158/159/160 (concurrent role-type renames — `committer` per ADR-159 and any future poke-related default would be affected by this ADR's Part A).

## Context

### Why this convention now

ADR-135 D2 shipped the cockpit `_-prefix` convention 2026-05-15 (`_superdriver` / `_medic` / `_martinet`). The principle: cockpit-role windows get an underscore prefix to mark them as built-in seats, distinguishable at glance from team-viewer windows that don't carry the prefix. The convention worked: operators reading the cockpit tmux list can tell which windows are atmux-managed cockpit roles vs. which are team-viewer panes from a glance.

The same readability problem exists at the in-team layer. Inside any team's tmux session, the window list mixes default members (lead / planner / reviewer / committer / ombudsman — roles that come pre-rostered with the team) and user-added members (whip-impl / up-impl / parity-state-impl — operator-rostered, role=`member`). Today they all share one format (`<emoji>-<name>`), so a glance at the list can't distinguish "built-in" from "user-added."

Operator's chat-time decision applies the cockpit pattern one level down: in-team default members get the `_-prefix` too. Result is the same readability win at the team layer.

### Why hyphen → underscore for defaults specifically

Per ADR-135 D2's reasoning: the underscore is the prefix marker AND the separator at the same time. `_superdriver` (no hyphen, no space) reads as a single token; the underscore IS what marks it. Same logic applied here: `🧭_lead` (no hyphen between emoji and underscore) reads at a glance as "default seat for lead." User-added members keep `<emoji>-<name>` (hyphen separator per ADR-135 D3), so the formats are visually distinct.

The downside is a per-role format check inside `buildWindowName` (per ADR-135 D3) — small added complexity, well-bounded.

### Why label-layer only — no id mutation

Per [[project_member_hot_rename_adr_136]] / ADR-136: members have three layers — `id` (immutable; powers kanban owner field, branch name, worktree path, inbox keys), `label` (display name; can change), `emoji` (display prefix; can change). ADR-161's `_-prefix` change lives entirely in the LABEL layer. Kanban records keyed by `id` ("lead", "planner") are unaffected. Branch names like `<teamBase>-planner` stay verbatim. Inbox paths `.atmux/inboxes/lead.json` (legacy; or the equivalent post-historical decision number 076 (no surviving ADR file) SQLite rows) stay verbatim.

Zero state migration required. The label change is purely cosmetic — pickups happen on next `atmux start` invocation when `buildWindowName` runs against the now-role-aware logic.

### Why the topographic-normalization verbs are part of this ADR

The `_-prefix` change is visual; it lets operators see at-a-glance which seats are default. But the actual ORDER of windows in a team's tmux session is whatever order members got added — defaults at the front (if started by template) followed by user-added in chronological order. That order isn't enforced anywhere. Two operators bootstrapping a similar team can end up with different orderings depending on which template they used or which member they added first.

`atmux member sort --defaults-first` is the one-shot canonical normalize: partitions by role, sorts defaults by canonical order, keeps user-added in their existing relative order. Once shipped, operators can normalize an existing team in one verb without manually `tmux move-window`-ing each pane.

`move` and `swap` are the manual escape hatches for operators who want a specific custom order. All three verbs preserve PIDs + attachments + claude-process state (mirroring `atmux rotate-lead` per ADR-135 D4) — they're `tmux move-window` orchestration, not respawn.

## Decision

Four §Decision-anchor lines first, then prose around each subsystem.

> **§Decision-anchor #1** — **Default-member roles are: `team-lead` / `planner` / `reviewer` / `committer` / `ombudsman`.** These get the `_-prefix` (label-layer only — id unchanged per ADR-136). Any role NOT in this set is treated as user-added (`role: "member"` typically) and gets the existing hyphen separator. The set is closed-by-default — adding a new default role requires an ADR-161 amendment + reviewer signoff. Forward-ref: ADR-159 `committer` rename + any future poke-role default would be affected by this list.

> **§Decision-anchor #2** — **Window-name format is role-aware**: `buildWindowName` checks `member.role` against the default set from §Decision-anchor #1; on match → `${emoji}_${label}` (no hyphen, underscore IS the separator + prefix marker); on miss → `${emoji}-${label}` (existing ADR-135 D3 format). The `_-prefix` is per-window only — the LABEL field on the member object stays without the underscore (e.g. `member.label = "lead"`, not `"_lead"`). Underscore is added at the WINDOW-NAME-rendering layer, not at the data layer.

> **§Decision-anchor #3** — **New verb namespace: `atmux member`** with three sub-verbs: `move <id> --to <position>` / `swap <id-a> <id-b>` / `sort [--defaults-first]`. Mirrors the existing `atmux member rename` (per ADR-136). All three preserve PIDs + claude-process state via `tmux move-window` orchestration (no respawn). After mutation, persists the new ordering to `team.json::members[]` array so the order survives team restarts.

> **§Decision-anchor #4** — **`sort --defaults-first` canonical ordering** is: `team-lead` → `planner` → `reviewer` → `committer` → `ombudsman` → (user-added in existing relative order). The canonical order matches the typical operator-mental-model "what does each role do, in order of how often I look at them." Idempotent — running on an already-sorted team is a no-op. Per-team configurable later if operator-pushback shows up; v1 is hardcoded.

### §Part A — `_-prefix` convention for default members

**Eligible roles** (per §Decision-anchor #1):

```ts
const DEFAULT_MEMBER_ROLES = [
  "team-lead",
  "planner",
  "reviewer",
  "committer",  // post-ADR-159 rename; legacy: "gitter"
  "ombudsman",
] as const;
```

This set lives in `src/abstractions/member-roles.ts` (NEW module — or extends an existing role-enumeration if one exists; locate via grep `team-lead.*planner.*reviewer` in `src/`).

**Auto-prefix on existing teams**: zero migration. The next `atmux start` invocation renders windows via `buildWindowName`, which now checks role + applies `_-prefix` automatically. ADR-135 D4 in-place rename pattern preserves PIDs — windows are renamed via `tmux rename-window`, not respawned.

**New teams**: template-shipped roster (e.g. `templates/team.example.json`) doesn't need changes — the role values stay verbatim; the rendering does the prefix work. Operators bootstrapping fresh teams get the convention from day one.

### §Part B — window-name format split

**`buildWindowName` logic** (extends ADR-135 D3):

```ts
function buildWindowName(member: Member): string {
  const emoji = member.emoji ?? defaultEmojiForRole(member.role);
  const label = member.label ?? member.id;
  if (DEFAULT_MEMBER_ROLES.includes(member.role)) {
    return `${emoji}_${label}`;       // _-prefix for defaults
  }
  return `${emoji}-${label}`;          // hyphen for user-added (existing ADR-135 D3)
}
```

**Cockpit-role windows** (per ADR-135 D2) keep their existing format — `_superdriver` / `_medic` / `_martinet` are unchanged. ADR-161's change is in-team layer only; cockpit layer was already prefixed.

**Operator-visible example post-convention**:

```
Cockpit (atmux-cockpit socket per ADR-162):
  W1  _superdriver
  W2  _medic
  W3  _martinet
  W4  <team1>           (team-viewer; no prefix per ADR-135)

In-team session (per-team socket):
  W1  driver            (operator's interactive REPL)
  W2  🧭_lead            (default — post-ADR-161)
  W3  🎯_planner         (default — post-ADR-161)
  W4  🔍_reviewer        (default — post-ADR-161)
  W5  📦-whip-impl       (user-added — existing hyphen format)
  W6  🛠️-up-impl         (user-added — existing hyphen format)
  W7  🌿_committer       (default — post-ADR-159 rename + ADR-161 prefix)
  W8  ⚖️_ombudsman       (default — post-ADR-161)
```

### §Part C — topographic-normalization verbs

**`atmux member move <id> --to <position>`** — absolute repositioning:
- Resolve `<id>` to its current window-index.
- `tmux move-window -s <current-idx> -t <position>` — preserves PIDs + attachments + claude-process state.
- Other windows shift to fill the gap (tmux's standard behavior).
- Persist the new ordering to `team.json::members[]` array (via `team-config.ts::writeTeamConfig` per t-2deb17f0 T2 — cross-EPIC dep on the team-set surface; if that hasn't landed, T3 uses the existing team.json write helper).
- Idempotent if `<position>` matches current.

**`atmux member swap <id-a> <id-b>`** — pairwise:
- Resolve both ids to window-indices.
- `tmux move-window -s <idx-a> -t <idx-b>` + `tmux move-window -s <idx-b> -t <idx-a>` (need a temp index to avoid clobber; use `tmux swap-window -s -t` if tmux 3.x+ supports it — locate the version-safe primitive).
- Persist new ordering.

**`atmux member sort [--defaults-first]`** — one-shot normalize:
- Read current member list from `team.json`.
- Partition into defaults + user-added; sort defaults by canonical order (§Decision-anchor #4); keep user-added relative order.
- Compute target index for each member; run `tmux move-window` orchestration in order (left-to-right) — each move preserves PIDs.
- Persist new ordering.
- Idempotent — re-run on already-sorted team produces zero `move-window` calls.
- `--defaults-first` is the only sort mode for v1; future modes (alphabetical, lane-grouped, custom) deferred until operator-pushback.

**All three verbs**: preserve PIDs + attachments + claude-process state. The `tmux move-window` primitive operates on tmux's internal window-index, not the running processes inside the panes.

**Edge cases**:
- Window not found (id doesn't correspond to a tmux window) — refuse with hint.
- Two windows have the same name (shouldn't happen post-ADR-135 D3 + this ADR's format split, but defensive check) — refuse with hint to run `atmux doctor` for the duplicate.
- Driver window (W1, operator's REPL) is OUT of move/swap/sort scope — refuse if `<id>` resolves to W1.
- Cockpit-role windows (if running in a cockpit context) are also out of scope — `atmux member` verbs operate at the team layer, not cockpit.

### §EPIC-done definition (canonical for this ADR's decomp)

ADR-161 completes when ALL of:

1. TR1 lands — this ADR commits (greenfield-verified pre-flight).
2. TR2 lands — `buildWindowName` role-aware; `DEFAULT_MEMBER_ROLES` enumeration in `src/abstractions/member-roles.ts`; unit tests cover the format split.
3. TR3 lands — `atmux member move | swap | sort` verbs; e2e proves PID preservation across all three.
4. TR4 lands — README + ARCHITECTURE + briefs templates + ADR-135 supersession pointer for D3 + memory entries.

## Consequences

### What this ADR enables

- **At-a-glance readability**: operators reading any team's window list can immediately tell defaults from user-added members. Symmetric with ADR-135 D2's cockpit-role convention.
- **Canonical team ordering**: `atmux member sort --defaults-first` gives operators a one-verb normalize for existing teams.
- **Operator control over ordering**: `atmux member move` and `swap` cover the manual escape hatch.
- **Zero state migration**: ADR-161 changes are label-layer only (per ADR-136); existing teams pick up the convention on next `atmux start`.

### What this ADR does NOT cover

- **Cockpit-role windows**: already `_-prefixed` per ADR-135 D2; unchanged.
- **Team-viewer windows (cockpit-side)**: stay no-prefix per ADR-135 D3. ADR-161 doesn't touch them.
- **Per-team custom default-role lists**: out of scope for v1. Future operator pushback could justify a `team.json::defaultRoleOverrides[]` field; not in this ADR.
- **Alphabetical or lane-grouped sort modes**: deferred. `--defaults-first` is the only sort mode for v1.
- **Driver window relocation**: out of scope. Driver is W1 by convention; ADR-161 verbs refuse to move it.
- **Hot-rename to ANOTHER prefix character (e.g. `-` → `.`)**: out of scope. Underscore is the canonical prefix per ADR-135 D2.

### Rollback path

- Remove `_-prefix` rendering: revert `buildWindowName`'s role-check branch (a single conditional). Existing teams render the old hyphen format on next start.
- Remove `atmux member` verbs: unregister from `help.ts`; remove verb file. No state migration (verbs only orchestrate `tmux move-window` against runtime tmux state).
- ADR-135 D3's uniform-hyphen-separator stays the documented default in ADR-135; ADR-161's supersession of that for defaults is documented as an annotation, not an inline edit.

### Reuse statement

- ADR-135 D2 `_-prefix` pattern: reused verbatim, applied one level down (in-team instead of cockpit).
- ADR-135 D4 in-place rename pattern: reused for `move` / `swap` / `sort` PID preservation.
- ADR-136 label-layer split: reused — `_-prefix` lives at rendering layer, not data layer.
- ADR-097 tmux abstraction: `tmux.window.moveWindow()` consumed for orchestration.
- `team.json::members[]` array order: existing persistence path; verbs write to it.
- NEW abstraction: `src/abstractions/member-roles.ts::DEFAULT_MEMBER_ROLES` enumeration (or extends existing role enum).

### What breaks (nothing in v1)

- Existing operator muscle memory: `tmux select-window -t lead` still works (tmux matches by window-name prefix). `tmux select-window -t _lead` works too. Both routes are accessible.
- Existing scripts that grep tmux output for "lead" still match (the substring is preserved; just gains a `_` prefix in the rendered name).
- Any external tool that depends on the EXACT window-name string `lead` (vs `_lead`) breaks. Acceptable — atmux's window-name format isn't a public contract; rename was always possible per ADR-135.

## Open questions

1. **Should ombudsman's `_-prefix` apply when ombudsman isn't rostered on a team?** Most teams have ombudsman optional. **Planner recommendation**: the role-check fires per-member, so absent members get no prefix at all (they don't exist). Non-issue. Reviewer can flip if they want a stricter "if ombudsman exists, it MUST be `_ombudsman`" gate.

2. **Should `--defaults-first` be the default behavior of `atmux member sort` (i.e. no flag required)?** **Planner recommendation**: yes — `atmux member sort` defaults to `--defaults-first`. Flag is for future-proofing when other sort modes ship. Reviewer can flip if they want explicit-only.

3. **`atmux member move` position semantics — 0-indexed or 1-indexed?** tmux's `move-window -t <target>` is 1-indexed (per `base-index 1` per ADR-162). **Planner recommendation**: 1-indexed for operator-mental-model consistency. Reviewer can flip if they want 0-indexed for parity with `members[]` array.

4. **Existing teams running an older `buildWindowName` — do windows get renamed on next `atmux start`?** Per ADR-135 D4 in-place rename pattern, yes — `atmux start` reconciles tmux state against the live `buildWindowName` output. **Planner recommendation**: document the auto-rename behavior in the RUNBOOK (TR4) so operators aren't surprised. Add a `--no-rename` flag to `atmux start` if pushback shows up; not in v1.

## Cross-references

- [ADR-135](135-cockpit-naming-convention.md) — D2 `_-prefix` pattern (cockpit-role); D3 uniform-hyphen-separator (in-team — SUPERSEDED for defaults by this ADR). Append a §Amendment annotation citing ADR-161.
- [ADR-136](136-hot-rename-member-labels.md) — label vs id vs emoji split; ADR-161's prefix change lives in label layer.
- [ADR-097](097-tmux-abstraction.md) — `tmux.window.moveWindow()` consumed by Part C verbs.
- [ADR-158](158-martinet-to-sentinel-rename.SUPERSEDED.md), [ADR-159](159-gitter-to-committer-rename.md), [ADR-160](160-whip-to-poke-rename.md) — sibling vocabulary renames (committer rename + others); cross-coordinated with this ADR's default-member list.
- [ADR-162](162-atmux-owns-tmux-infrastructure.md) — `base-index 1` invariant referenced in §Open question #3.
- Driver-ref: 2026-05-16 driver session — operator chat-time decision on default-member `_-prefix` + sort/move/swap verbs.
- Memory [[project_member_hot_rename_adr_136]] — id vs label vs emoji split; ADR-161 lives in label layer.
- Memory [[project_adr_135_naming_convention]] — D1-D6 conventions shipped 2026-05-15.
- Project [CLAUDE.md](../../CLAUDE.md) §Docs Discipline.

## Amendments

### 2026-05-17 — TR3 shipped: `atmux member move | swap | sort` verbs (t-2f6c81d3, be-1)

Part C verbs landed in `src/verbs/member.ts` (extending the ADR-136 TR3 sub-verb dispatcher) backed by a new shared abstraction at `src/abstractions/tmux-window-orchestrator.ts`. Key shipped semantics:

- **Verb signatures** are exactly as specified in §Part C — `atmux member move <id> --to <position>` (1-indexed per §Open question #3), `atmux member swap <id-a> <id-b>`, `atmux member sort [--defaults-first]` (defaults-on per §Open question #2).
- **Move under occupied target slot** uses `tmux swap-window` rather than `tmux move-window` — `move-window` errors with `index in use` when the destination is occupied, and swap preserves the occupant's PIDs + claude-process state alongside the source's. The orchestrator picks the right primitive based on a live `listWindows` snapshot.
- **Swap fallback** wraps `tmux swap-window` (the version-safe primitive; tmux 1.0+, 2009) with a `TmuxError → three-move temp-index dance` fallback so the verb survives implausibly-old tmux builds without a runtime version check.
- **Sort algorithm** iterates target-order left-to-right, re-fetching `listWindows` each step (swap shuffles sibling indices, so a stale snapshot would mis-resolve). Members rostered in `team.json` but with no live window (paused, pre-spawn) are silently skipped; their canonical position is still persisted to JSON so the next `atmux start` materializes them in order.
- **Cockpit refusal** is a team-name guard against the reserved literals `atmux_cockpit` / legacy `atmux_teams` (per ADR-135 D1). In practice the cockpit lives on its own socket (per ADR-162) and has no `team.json`, so this is defense-in-depth.
- **Driver slot (W1) refusal** lives in `resolveMemberToWindowIdx` + `moveMemberWindow` — both refuse with a structured `MemberWindowResolveError` that the verb layer translates to a `UsageError`. Driver index is derived from the lowest live window index rather than hardcoded `1`, so tests running under `base-index = 0` Just Work alongside production's `base-index = 1` (per ADR-162).
- **Persistence** uses the existing `updateJson(Team)` flock pattern (no new `team-config.ts` helper; ADR-161 §Part C's prefab brief assumed one exists, but `updateJson` already serializes correctly with the rename verb on the same `team.json`).

Test coverage shipped in the same commit:

- `tests/unit/abstractions/tmux-window-orchestrator.test.ts` — 23 tests against a stubbed `TmuxNamespace` covering all four primitives + the pure `sortMembersDefaultsFirst` helper. 100% line + function coverage on the orchestrator file.
- `tests/unit/verbs/member.test.ts` extended with 41 new tests against a real tmux server (per-test absolute socketPath + `base-index 1` config) — happy path / idempotent / unknown-id / W1-refusal / cockpit-refusal / team-stopped / dispatcher routing for each of move + swap + sort.

§EPIC-done item #3 satisfied. TR4 (docs sweep + ADR-135 supersession annotation) remains outstanding.

### 2026-05-18 — Self-heal shim for legacy default-member window names (EPIC e-a3077ca0)

§D2's `atmux start` in-place rename shim (hyphen → underscore for default-member roles) self-heals legacy cages **at next start invocation**. A cage continuously running across the ADR-161 deploy never sees an `atmux start` call and stays on the pre-ADR-161 format indefinitely: `buildWindowName('lead', '🧭', undefined, 'team-lead')` produces `🧭_lead` (post-ADR-161 canonical) while the live cage still has `🧭-lead`. Every addressing verb (`atmux rotate-lead` / `send` / `dispatch` / `lane-tick` / `poke` / `tell-lead`) refused with `no tmux window for lead (is the team running?)` against such cages until an operator manually `tmux rename-window`'d each of the 6 coordination panes.

Observed 2026-05-18 on the atmux parent cage (4-day uptime; `🧭-lead` / `🎯-planner` / `🔍-reviewer` / `🦦-docs` / `🌿-gitter` / `⚖️-ombudsman` all on hyphen form). Cross-format failure also caught at `src/verbs/lane-tick.ts` against the docs window: `lane-tick: docs: capture error — can't find window: 🦦docs` (no-separator pre-ADR-135 variant — captured by t-fabd2528 verify-poll while the actual pane was `🦦_docs`).

**Three observed formats** coexist during the ADR-135 → ADR-161 deprecation window for default-member roles:

1. **Canonical** — `<emoji>_<member>` (ADR-161 default-member `_-prefix` — what `buildWindowName` produces today with `role` set).
2. **ADR-135 hyphen** — `<emoji>-<member>` (pre-ADR-161 default-member legacy; also today's canonical for non-default-member roles per §D2).
3. **Pre-ADR-135 no-separator** — `<emoji><member>` (what `buildWindowNameLegacy` still produces; what production `lane-tick` was looking for as of atmux 0.8.4).

**Resolver helper** — `src/core/common.ts::resolveWindowWithRenameShim(sessionName, canonical, legacyVariants, ops)` (T1 86c0e4a). Lists tmux windows on `sessionName`. Canonical present → return immediately (no rename). Else iterates `legacyVariants` in caller-supplied order; first hit → atomic `tmux rename-window <legacy> <canonical>` → return canonical. Neither present → throw `ConfigError("no tmux window for <canonical>")` so the operator-message names the target shape regardless of which legacy form was probed. Dep-injectable `WindowShimOps` interface narrows the tmux abstraction to two ops (`listWindowNames` + `renameWindow`) so unit tests stub without spinning a tmux server. Atomicity: `tmux rename-window` is a single server op — there is no observable intermediate state between legacy and canonical; concurrent shim calls converge to the same post-rename state.

**Wire-sites** — 6 default-member addressing surfaces, all calling through the same canonical / hyphen / no-sep dedup pattern:

- `src/verbs/rotate.ts` (T2 5f07a60) — highest-frequency call-site; was the original symptom for `rotate-lead` failure on the atmux parent cage.
- `src/verbs/send.ts` (T3 1182e66) — both single-member + broadcast paths via `resolveMemberTarget`. Broadcast catch widens to absorb `ConfigError("no tmux window for X")` into the same warn bucket as paste-buffer failures (bash parity preserved).
- `src/verbs/dispatch.ts` (T4 f1e7744) — kanban Task dispatch.
- `src/verbs/lane-tick.ts` + `src/verbs/poke.ts` (T5 13ad850) — per-member iteration; was the surface that caught the `🦦docs` capture error.
- `src/verbs/tell-lead.ts` (T6 0dcffae) — driver→lead + member→lead paths. Maps the resolver's `ConfigError` to ADR-029 §F6 + F7 byte-equal `no tmux window for <lead.name> (is the team running?)` body (parity-test-gated).

**Doctor probe** — `src/verbs/doctor.ts::checkLegacyWindowNameFormat` (T8 22a2df6). Walks every cockpit cage (`~/.atmux/cockpit.json::teams[]`; falls back to current-team when cockpit absent / unreadable / no schema). For each cage, lists windows on `atmux-<team.name>` session, then for each default-member-role member checks whether canonical is present; flags hyphen / no-separator offenders with copy-paste-ready `tmux -S <socket> rename-window -t <session>:<from> <canonical>` one-liner in the hint. Warn-class only (never blocks). Self-clearing post-rename — whether operator runs the hint OR the shim wires self-heal on the next addressing call. Cages whose socket file isn't on disk silently skip (cage not running); cages whose canonical session name isn't on the socket silently skip (out of scope).

**Gitter exemption** (per [[project_adr_161_tr2_shipped]] memory + ADR-159 pending) — `🌿-gitter` stays canonical-as-hyphen until the gitter → committer schema rename lands. The resolver helper accepts `canonical="🌿-gitter"` with an empty `legacyVariants[]`; the doctor probe filters via `isDefaultMemberRole(role)` which already excludes `role: "committer"` (the committer role is not in `DEFAULT_MEMBER_ROLES`).

**Carve-outs** (probe + shim are out-of-scope for these):

- **Epic-viewer windows** (`🌳-<eid>`) — hyphen stays canonical by spec; never default-member-role anyway.
- **User-added member names without a default-member role** — `role: "member"` keeps hyphen as canonical per §D2; the probe filters them out, and the resolver collapses canonical / hyphen-form to the same string (resolver deduplicates legacy variants against canonical).

**Test coverage** — T7 unit at `tests/unit/core/common.test.ts` (86c0e4a, 4 cases on `resolveWindowWithRenameShim` covering canonical-exists / hyphen-form-renamed / no-separator-renamed / neither-throws). Per-wire shim coverage landed alongside each commit: 5 cases in `send.test.ts` (1182e66), 4 cases in `tell-lead.test.ts` (0dcffae), 11 cases in `doctor.test.ts` (22a2df6 — covering cockpit-walk multi-team, current-team-vs-cockpit dedup, role-undefined silent, exempt-role silent).

§EPIC e-a3077ca0 done items satisfied: T1 helper + T2-T6 wires + T7 unit + T8 probe + this §Amendment + the CHANGELOG bullet + the `feedback_atmux_dispatch_emoji_window_bug` memory cross-link (resolved as of 2026-05-18). Reviewer-trunk-signoff fires when CHANGELOG + Amendment land — both in this commit.


## §Amendment 2026-05-20 — promoted to accepted (status-drift audit T4)

Promoted from `proposed` → `accepted` per [docs/audits/adr-status-drift-audit-2026-05-20.md](../audits/adr-status-drift-audit-2026-05-20.md) (sha=a6f1541). Code-refs + git-log refs both present at audit time confirming shipped + dogfooded status; the `proposed` marker was bookkeeping debt. Original Date preserved verbatim. Append-only — see Status field for the canonical flip; this §Amendment carries the audit traceability.

**Filed via** t-45b401c3 (T4 sweep, 2026-05-20).

## §Amendment 2026-08-17 — the `legacy-window-name-format` probe resolves the session name from the anchor

The **Doctor probe** paragraph above says the probe "lists windows on `atmux-<team.name>` session" and carves out "cages whose canonical session name isn't on the socket silently skip (out of scope)". **Both statements are superseded.**

`atmux-<team.name>` is not the session name. Teams anchor their session in `.atmux/state/session.txt`, and on the live fleet `unum` anchors to `atmux_unum` (underscore) and `atmux` to bare `atmux` — neither producible from that form. Proven directly: `tmux -S <cage socket> has-session -t atmux-unum` exits 1 while `-t atmux_unum` exits 0. The "out of scope" carve-out was therefore not a scoping decision at all; it was the probe silently skipping every anchored cage on the fleet.

`checkLegacyWindowNameFormat` (now `src/verbs/doctor/cockpit.ts`) resolves each cockpit target through `resolveCageSessionName({ name, root })`, keyed on the root the cockpit entry carries — deliberately **not** `getSessionName`, whose `ATMUX_SESSION` env pin is a process-level override for the *current* team and would name one team's session for every team inside a multi-team walk. The `currentTeam` fallback keeps `getSessionName`, where the pin does refer to that team.

Consequences for this ADR: the carve-out list loses its session-name entry, and the `tmux rename-window` hint now names the session that actually exists — so an operator's copy-paste of it works on an anchored cage, where before the probe never got far enough to emit one.

**Filed with** [ADR-273](273-voice-fleet-triage-and-pane-input.md) §Supplement-4, which closes the deferral ADR-273 §S2 recorded. Append-only — the original Doctor-probe paragraph is preserved verbatim above.
