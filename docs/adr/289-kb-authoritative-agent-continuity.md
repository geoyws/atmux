# ADR-289 — HAX KB is the sole continuity authority for agent work

Status: accepted (operator-direct 2026-09-03)
Date: 2026-09-03
Supersedes: [ADR-267](267-durable-agent-continuity-contract.md)
Cross-refs: [ADR-275](275-external-private-kanban-authority.md) (HAX KB is the sole work-state authority), [ADR-276](276-orchd-retirement-and-atmux-scope.md) (atmux is cages + vox, not work-state storage), [ADR-287](287-canonical-cockpit-nesting-and-drivers-only-roster.md) (lands separately; this ADR does not fold cockpit nesting into continuity), kanban ADR-004 / ADR-012 / ADR-017 (atomic handoffs, lease transfer, and session continuity; referenced by number only because the files live in the kanban repo)

## Context

ADR-275 already made HAX KB the sole work-state authority. This ADR narrows the continuity contract to the operator-visible boundaries that keep a lane resumable while the pane is still alive, and it treats every other narrative surface as a projection:

- `.atmux/handoff/*.md`
- `~/.agents/handoffs/**/handoff.md`
- tmux pane scrollback

Those files can enrich a resume, but they never own continuity. The source seam in `src/verbs/handoff.ts` already refuses external Kanban mode because `atmux handoff` cannot transfer leases atomically; this ADR only updates the documented contract.

ADR-276 narrows atmux to tmux cages and `atmux vox`. That leaves the continuity boundary as a KB concern, not an atmux daemon concern. ADR-287 lands separately and keeps the cockpit nesting / drivers-only roster shape stable; it is intentionally not absorbed here.

## Decision

### D1 — KB is the continuity record

The continuity record lives in Kanban. Claims, checkpoints, progress breadcrumbs, blockers, and session handoffs are KB rows. Pane scrollback and markdown handoff projections are read-only enrichments.

### D2 — Map the observable boundaries precisely

| Boundary | KB action | Why it exists |
|---|---|---|
| Right after `kb claim --next --as "<agent>"` | `kb note <task-id> "<plan>" --as "<agent>" --kind plan` | Capture intent while the agent is healthy. |
| Each commit | `kb note <task-id> "<sha> <line>" --as "<agent>" --kind progress` | Record the exact change without taking a lease. |
| Any blocker | `kb cp <task-id> --lease "$TOKEN" --as "<agent>" --state blocked --summary "<blocker>" --intent "<intent>" --next-action "<unblock condition>"` | Freeze the blocking condition before context drifts. |
| Before `/clear`, rotation, or expected compaction | `kb cp <task-id> --lease "$TOKEN" --as "<agent>" --state continue --summary "<summary>" --intent "<intent>" --next-action "<next action>"` or `kb h new --as "<agent>" --to "<successor>" --branch "<branch>" --repo "<repo-path>" --reason "<reason>" --summary "<summary>" --intent "<intent>" --next-action "<next action>"` | Leave a resumable point before the pane changes. |

The plan note is the durable floor. `atmux handoff` remains a legacy-mode compatibility path only.

### D3 — Dirty work stays on disk

- Never auto-WIP commit.
- Dirty work remains on disk; checkpoint `dirtySummary` records it.
- A same-host, same-worktree successor inherits the dirty state.
- Cross-host loss of uncommitted work is accepted and explicit.
- On `@@mbp`, the operator spawns successors because no auto-launched agents are allowed there.
- On `@@hax`, later successor dispatch belongs to Kanban, not atmux.

### D4 — Legacy-mode only compatibility

`atmux handoff` stays as legacy-mode only. The projections it writes and reads remain useful for compatibility, but they do not define continuity authority:

- `.atmux/handoff/*.md`
- `~/.agents/handoffs/**/handoff.md`
- tmux scrollback

The current stack resumes from KB checkpoints and KB handoffs. No new capture path, death-bed ask, or runtime behavior is introduced here.

## Consequences

- The current continuity contract is readable in one place and maps directly to KB commands.
- The old death-bed model becomes historical rather than authoritative.
- Legacy handoff surfaces remain available for compatibility, but only in legacy mode.
- The source seam already refuses external Kanban mode, so this ADR stays documentation-only.

## Historical note

ADR-267 remains as the superseded record for the older continuity proposal. Its useful boundary table is now expressed here against the current KB commands.
