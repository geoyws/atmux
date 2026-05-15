# ADR-136: Hot-rename member labels (Option B — id + label + emoji split)

**Status**: Accepted (2026-05-15, operator-batch-flip)
**Date**: 2026-05-14
**Driver-ref**: 2026-05-14 driver session — operator: *"can we have a hot rename feature for members? maybe we can let the emoji be the permanent identifier and the english string afterwards can be renamed to anything else after? wdyt? make sure state keeps sane?"*
**EPIC parent**: `t-13367b7a` · **TR1**: `t-646bc535`
**Reviewer**: gate before TR2 (schema diff) lands.
**Subagent analysis**: 71-call-site code audit at 2026-05-14 grounded the recommendation; cited inline.

## Context

The operator asked for hot-rename of member display names without restarting the team. Two design options surfaced:

- **Option A — emoji as stable ID.** Make the emoji the canonical filesystem / branch / kanban identifier; the English string becomes free-form mutable display.
- **Option B — id + label + emoji split.** Keep `name` as the immutable ASCII identifier; add an optional `label` field for mutable display; emoji remains.

Option A is tempting because emojis are visually durable across a session ("the 🛠️ pane"), but the subagent's audit surfaced two critical hazards:

1. **Variation selector trap.** `🛠️` (`up-impl`) is `U+1F6E0 + U+FE0F` (2 codepoints) in live `.atmux/team.json` files. It renders identical to `🛠` (1 codepoint) in most terminals. Filesystem paths keyed to emoji-as-ID silently create duplicate worktree directories; `git status` truncates variation selectors in some terminals; `grep` with locale drift silently misses entries. Adversarial input class — any operator paste from another machine could split the namespace.
2. **`sanitizeBranchSegment` already gates emoji out.** `src/abstractions/worktree.ts:189–195` defensively strips non-ASCII from branch segments — the comment explicitly says the sanitizer is *"defensive for future emoji-suffixed or unicode-named members"* because *"they would produce branch names git refuses."* Per ADR-084, branches are `<base>-<sanitize(member.name)>`. If `member.name = 🧭`, sanitize collapses to `-` → `geoyws--lead` collisions across emoji-named members.

Option B sidesteps both by keeping `name` ASCII (the immutable ID) and exposing `label` as the mutable display layer. The operator picked Option B on 2026-05-14.

## Decision

Add an optional `label` field to the `TeamMember` schema. `name` remains the immutable ASCII identifier (already validated by `MEMBER_NAME_REGEX = /^[a-z][a-z0-9_-]{0,30}$/` at `src/core/common.ts:316`). Display formatters fall back to `name` when `label` is absent. A new `atmux member rename` verb mutates `label` only; all id-keyed state (worktrees, branches, inboxes, kanban owner, etc.) remains pinned to `name`.

### Schema diff

`TeamMember` schema (`src/schema/team.ts:33-47`):

```diff
 name: z.string().min(1)            // immutable ASCII ID (unchanged)
+label: z.string().optional()       // NEW — mutable display name
 emoji: z.string().optional()       // unchanged
```

The `name` field's validation stays as-is. `label` is unconstrained free-form Unicode — **EXCEPT** for `:` and `.` which are tmux window-name separators; `atmux doctor` adds a warn-class check on those characters.

### New verb: `atmux member rename`

```
atmux member rename <member-id> --label <new-label>
```

Side effects (in order):

1. Validate `<member-id>` exists in `.atmux/team.json`. Error if not.
2. Validate `<new-label>` is free-form Unicode without `:` or `.` characters.
3. Atomic JSON rewrite of `.atmux/team.json` — same backup + jq-edit pattern as `atmux rename` (team rename) per existing convention (ADR-027 sibling).
4. If the team session is live: `tmux rename-window -t <session>:<emoji><old-label> <emoji><new-label>` (or `<emoji>-<new-label>` post-ADR-135 hyphen-separator).
5. If the renamed member is the current lead: update `lead-window-name.txt` per `src/core/lead-marker.ts:28`.
6. **NO kanban migration** — `tasks.owner` stays as `member.name` (the ID).
7. **NO branch migration** — branches use `sanitizeBranchSegment(member.name)` which is unchanged.
8. **NO inbox-file migration** — `.atmux/inboxes/<member.name>.json` unchanged.
9. **NO worktree-path migration** — `.atmux/worktrees/<member.name>/` unchanged.

Idempotent: renaming to the same label is a no-op (equality check before writing). Running when the team is stopped: step 4 is skipped with notice *"team not running, window rename applies on next start."*

### Hot-rename concurrency safety

- **During in-flight task claim.** Safe — `tasks.owner` in SQLite is `member.name` (the ID), not `label`. The rename only changes the display.
- **During lane-tick injection.** `lane-tick` builds `atmux claim --next --as ${member.name}` (the ID). Window-target rendering on the next tick uses the NEW window name (`<emoji><label>`); the previous tmux send-keys may fail gracefully against the stale target name for one tick, then auto-recover. Single-tick stale window target is acceptable per the subagent's analysis.
- **During lead rotation.** If the rename happens mid-rotation, `lead-window-name.txt` is updated atomically with the rename op (step 5). Whip §1a reads the updated value on its next pane-capture.
- **Worktree path collision.** Impossible. Path stays keyed to `member.name`.
- **Two members same label, different IDs.** Allowed at the config layer. Window names differ if the emoji differs. `atmux doctor` adds a warn-class check on `(emoji + label)` collision via a new probe.

### Display layer updates

Files to touch (per the subagent's findings):

- `src/core/common.ts:240-243` — `buildWindowName(name, emoji, label?)` returns `<emoji><label ?? name>` (or `<emoji>-<label ?? name>` post-ADR-135).
- `src/verbs/status.ts` — member rows render `label ?? name`.
- `src/abstractions/discord.ts` — every member-name reference in Discord templates renders `label ?? name`.
- `src/verbs/whip.ts` — debug logs + Discord bullets use `label ?? name`.
- `src/verbs/doctor.ts` — same (display only; validation still uses `name`).
- `templates/briefs/*.md` — any `{{MEMBER}}` substitution renders the label-fallback.

ID-using paths NOT touched (intentional):

- Worktree paths (`.atmux/worktrees/<name>/`)
- Branch names (`geoyws-<sanitize(name)>`)
- Inbox files (`.atmux/inboxes/<name>.json`)
- Cost cache (`.atmux/state/cost-<name>.json`)
- Kanban owner column (`tasks.owner = member.name`)
- Lane-tick send-keys arg (`atmux claim --next --as ${member.name}`)
- `paused.json` keys
- `resume.json` name field

### Doctor probe

New warn-class check: `member-label-collision`. Fires when two members share the same `(emoji + label)` tuple after fallback. Operator misconfiguration warning — doesn't block, just surfaces in `atmux doctor --json`.

## Resolved open questions

- **OQ-1 — label character set**: free-form Unicode but forbid `:` and `.` (tmux separator chars). Same gate shape as `checkTeamName` in `src/core/common.ts`. Subagent's recommendation.
- **OQ-2 — ADR-030 registry mirror**: registry stays at `{name, emoji}` for now. Adding a `label` mirror later is cheap; drift between `team.json` and registry on label-only changes is acceptable. Registry is for cross-team aggregation; label is per-team display.
- **OQ-3 — branch-name surprise messaging**: `atmux member rename` prints a one-line note: *"branch name `geoyws-<sanitize(name)>` is permanently keyed to the immutable member ID; the label rename is display-only."* Surfaces the invariant to the operator at the point of action.
- **OQ-4 — display split**: `atmux status` + Discord pings render `label ?? name`. Internal logs (debug output, error messages) keep `name` for greppability.

(Operator may override any of these in TR1 review.)

## Sub-tasks (per EPIC `t-13367b7a`)

| ID | Subject | Lane | Deps |
|----|---------|------|------|
| TR1 (this) | Draft ADR-136 spec | docs/planner | — |
| TR2 (`t-69e8b05a`) | `TeamMember.label` field + Zod validation + same-commit unit tests | be | TR1 |
| TR3 (`t-ef185bb7`) | `atmux member rename` verb + 6 unit tests | be | TR2 |
| TR4 (`t-6d39e595`) | Display-layer label-fallback (`buildWindowName` + status + Discord + briefs + doctor probe) | be | TR2 |
| TR5 (`t-b02395d9`) | e2e — synthetic team + 6 rename paths | test | TR3 + TR4 |

## Consequences

**Positive**:

- Hot-rename works without restarting the team. Operators can re-label `whip-impl → reviewer-prime` (or similar) mid-session.
- Zero state migration risk — every storage class stays keyed to `name`. The rename is a pure display-layer mutation.
- Backward-compatible — existing `team.json` files without `label` keep working; display falls back to `name`.
- Sidesteps the variation-selector + branch-sanitize hazards that Option A would have inherited.

**Negative**:

- Display drift across surfaces if some renderers miss the `label ?? name` update — partly mitigated by the doctor probe and partly by the EPIC enumerating every touch point.
- Two members with the same `(emoji, label)` tuple are allowed at the config layer (only the warn probe surfaces the collision). Acceptable: it's operator misconfiguration, not a state corruption.
- Lane-tick has a one-tick stale-target window after a rename. Recoverable; documented in §"Hot-rename concurrency safety."

**Reversibility**: medium. Remove `label` from the schema + revert the display callers + remove the `atmux member rename` verb. The kanban / worktree / branch state is unaffected by either direction of the change.

## Out of scope

- Renaming `member.name` (the immutable ID) — that's a different feature; would require full state migration across the 6 storage classes listed in §"Display layer updates"; defer to a future ADR if the operator needs it.
- Hot-renaming the emoji — possible in v1 (no validation against emoji change) but a doctor warn on emoji change is deferred.
- Multi-language label support — labels are free-form Unicode, no special i18n machinery.

## Cross-references

- **ADR-027** ([`docs/adr/027-team-rename-verb-and-topology-invariant.md`](027-team-rename-verb-and-topology-invariant.md)) — team rename verb; sibling pattern at the team layer (rename the display, keep the underlying identity stable).
- **ADR-030** ([`docs/adr/030-registry-emoji-immutability.md`](030-registry-emoji-immutability.md)) — registry / emoji immutability; this ADR settles OQ-2 (registry accepts label drift; mirror deferred).
- **ADR-082** ([`docs/adr/082-worktree-isolation-per-member.md`](082-worktree-isolation-per-member.md)) — worktree-per-member substrate; uses `member.name`, NOT label.
- **ADR-084** ([`docs/adr/084-worktree-per-member-branch-model.md`](084-worktree-per-member-branch-model.md)) — per-member branch naming `<base>-<sanitize(member.name)>`; the rename does NOT mutate branch names.
- **ADR-135** — cockpit naming (uses `<emoji>-<label ?? name>` post-hyphen-separator); not yet authored at the time of this ADR — forward-reference.
- **Subagent analysis 2026-05-14** — 71-call-site code audit grounded the Option-B recommendation; the analysis is the implicit appendix.
- **CONVENTION-059** ([`docs/CONVENTION-059-indexed-member-naming.md`](../CONVENTION-059-indexed-member-naming.md)) — `<lane><index>` naming for fungible members. CONVENTION-059 governs the ID layer (`name`); ADR-136 governs the display layer (`label`). They compose: a member can be `name=fe0`, `label=Frontend (Sarah)`, `emoji=🎨`.
