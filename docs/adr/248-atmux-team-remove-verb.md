# ADR-248: `atmux team remove` verb — symmetric decommission with safety gates + audit receipt

**Status**: proposed
**Date**: 2026-05-24
**Driver-ref**: `c-04db5b96` (operator complaint — atmux lacks a clean team-removal verb; ifca-docs decommission 2026-05-24 lost an open complaint, shifted cockpit indices killing the wrong window, required ~10 ad-hoc steps with ~3 footguns).

## Context

`atmux` ships several verbs for **bringing teams up**: `atmux init`, `atmux up`, `atmux start`, `atmux cockpit reconcile` (per [ADR-235](235-cockpit-verb-surface-rationalization.md)). For **bringing teams down**, the surface is asymmetric:

- `atmux stop` ([ADR-026](026-always-single-session-topology.md)) — kills the cage tmux session for ONE team but leaves cockpit window, cockpit.json roster entry, team root directory, legacy `/tmp/atmux-<team>/` socket dir, child epic-teams, open complaints, in-flight kanban tasks all untouched.
- `atmux team dissolve-epic` ([ADR-090](090-epic-team-lifecycle.md), [ADR-219](219-dissolve-epic-completeness.md)) — exists for **epic-teams** only with strong safety gates (worktree clean + all tasks done + branch fan-in landed). NO equivalent for regular teams.

The result: decommissioning a regular team (e.g. ifca-docs on 2026-05-24) requires the operator to manually walk **ten distinct cleanup steps**:

1. `atmux stop` inside the team root → kills the cage tmux session
2. `tmux -L atmux-cockpit kill-window -t atmux_cockpit:<n>` → removes the cockpit viewer window (cockpit window indices SHIFT — easy to kill the wrong window)
3. `jq` edit `~/.atmux/cockpit.json` → delete the `sessions[]` entry
4. `rm -rf` the team root directory
5. `rm -rf /tmp/atmux-<team>/` → clean the legacy-conv socket dir (per-team-conv teams have `<root>/.atmux/tmux/tmux-<uid>/` which goes with the root rm)
6. Check for nested git worktrees inside the team root
7. Check for unpushed commits / dirty working tree
8. Check the team's `.atmux/state.db` for open complaints (silently nuked on `rm`)
9. Check for kanban tasks in-flight
10. Check for epic-team children in cockpit.json that orphan when the parent dies

Steps 6-10 are check-only; the operator must **remember** them. Steps 1-5 are act-on-state with no rollback. There is no `--dry-run` to preview, no audit receipt to recover from, and no safety gate against the common footguns.

Per [project_atmux_team_decomposed_to_core](memory) the team is on a simplification arc. Adding ONE proper verb removes ~10 ad-hoc steps and ~3 footguns; it pairs with `atmux team add` ([ADR-090](090-epic-team-lifecycle.md) §`atmux team spawn-epic` is the epic-team analog; the regular-team analog is `atmux init` today, which is wizard-shaped and not symmetric to `remove`).

## Decision

Add **`atmux team remove <name>`** with safety gates, `--dry-run` preview, atomic cleanup orchestration, and a recoverable audit receipt. Pair with **`atmux team add <name> --root <path> [--enabled true]`** as the inverse roster-management verb.

### (D1) `atmux team remove <name>` — verb shape

```
atmux team remove <name> [--force] [--dry-run] [--keep-root] [--keep-receipt-only]
```

| Flag | Effect |
|---|---|
| (no flag) | Refuse-with-list if any safety gate fails; print recovery commands; non-zero exit |
| `--dry-run` | Print the full removal plan (what gets killed, deleted, edited) WITHOUT acting; zero exit |
| `--force` | Bypass safety gates but STILL print the full plan before acting (operator sees what will happen even when bypassing) |
| `--keep-root` | Skip step 4 (rm team root) — useful when operator wants to archive the root manually |
| `--keep-receipt-only` | Print the receipt JSON, skip all cleanup steps. Equivalent to `--dry-run --json`. |

### (D2) Safety gates — refuse-with-list

Default-mode refuses (non-zero exit) with a **structured list** if any of these are true:

1. **Uncommitted / unpushed git state** in the team root or any registered worktree (per `git status --porcelain` + `git log @{u}..HEAD` per worktree)
2. **Open complaints** in the team's `.atmux/state.db` complaints table (`status='open'`)
3. **In-progress kanban tasks** (`tasks.status IN ('in-progress','testing','review','merging')`)
4. **Child epic-teams** present in `cockpit.json::sessions` whose `parentTeam` field references `<name>` (orphan risk per [ADR-089](089-hierarchical-cockpit.md))
5. **Running cage sessions OTHER than the team's own** — i.e. live tmux sessions on the team's `tmuxTmpdir` socket whose name is not the expected `atmux[-_]<name>` (residual state, may indicate manual intervention)

Each refusal lists the offending state and the exact command to resolve it (per [ADR-235](235-cockpit-verb-surface-rationalization.md) §(D3) plain-English refusals contract). Example:

```
atmux: team remove: refusing — 3 safety gates failed.

(1) Uncommitted git state in /root/work/src/ifca-docs (4 files modified).
    To inspect: cd /root/work/src/ifca-docs && git status
    To proceed anyway: pass --force (uncommitted state will be lost)

(2) 1 open complaint in .atmux/state.db (c-04db5b96, opened 2026-05-24).
    To inspect: atmux complaints list --status open
    To proceed anyway: pass --force (complaint will be lost; consider exporting first)

(3) 2 in-progress kanban tasks (t-foo, t-bar).
    To inspect: atmux task list --status in-progress
    To proceed anyway: pass --force
```

`--force` still prints the plan but skips refusal. Operator sees every action before it lands.

### (D3) Atomic cleanup orchestration

When safety gates pass (or `--force` is set), `atmux team remove` performs these steps **in order**, with rollback guarantees described per-step:

1. **Stop cage session** — equivalent to `atmux stop` against the team root. Non-fatal if already down.
2. **Kill cockpit window** — resolve the cockpit window for `<name>` via the cockpit.json `sessions[]` index (NOT by tmux window index — indices shift, [ADR-089](089-hierarchical-cockpit.md) labels via `_role` suffix per [ADR-135](135-cockpit-naming-convention.md)). Use `tmux kill-window -t atmux_cockpit:<emoji><name>` style lookup.
3. **Edit `cockpit.json`** — remove the `sessions[]` entry for `<name>`. Preserve formatting (read → splice → write with same indent/newlines as input; do NOT round-trip through unconfigured stringify).
4. **Write removal receipt** — `~/.atmux/state/removals/<name>-<ts>.json` containing: timestamp, team name, root path, cockpit window resolved, list of complaints / tasks / worktrees observed at remove time, the safety-gate decisions, and an `atmux team add ...` inverse-command stub that would re-add this team with the same shape.
5. **Remove team root** (unless `--keep-root`) — `rm -rf <root>`. Operator-visible footprint: the receipt is the only durable record of what was removed.
6. **Remove legacy `/tmp/atmux-<name>/`** — only if it exists. Per-team-conv teams have their socket dir inside the team root and are removed by step 5.

Steps 1-3 are **idempotent**: re-running the verb after a partial failure picks up wherever the previous run stopped. Step 4 is **atomic** (write to `<receipt>.tmp` then `rename`). Step 5 is **non-reversible** by design.

If step 2 or 3 fails (cockpit.json malformed, tmux server unreachable), the verb aborts before step 5 — the team root remains intact for retry. Receipt is still written so the partial state is recoverable.

### (D4) Audit receipt schema

`~/.atmux/state/removals/<team>-<unix_ts>.json`:

```json
{
  "schema": 1,
  "team": "ifca-docs",
  "removedAt": 1779580670,
  "removedBy": "operator",
  "root": "/root/work/src/ifca-docs",
  "cockpitWindow": { "session": "atmux_cockpit", "windowName": "📚ifca-docs" },
  "tmuxTmpdir": "/root/work/src/ifca-docs/.atmux/tmux",
  "safetyGates": {
    "git": "clean",
    "openComplaints": 0,
    "inProgressTasks": 0,
    "childEpicTeams": 0,
    "residualCageSessions": 0
  },
  "forced": false,
  "inverse": "atmux team add ifca-docs --root /root/work/src/ifca-docs --enabled true"
}
```

When `--force` bypasses gates, the gate value in `safetyGates` shows the count + an inline-truncated list (e.g. `"openComplaints": { "count": 1, "ids": ["c-04db5b96"] }`) so the receipt is self-describing for forensic recovery.

### (D5) Inverse — `atmux team add <name>`

```
atmux team add <name> --root <path> [--enabled true|false] [--from-receipt <path>]
```

Adds an entry to `cockpit.json::sessions[]` with the team's root + enabled flag. Default: `enabled=true`. The `--from-receipt` shortcut reads a removal receipt and re-adds the team using the receipt's `inverse` command (operator can recover from accidental removal by passing the receipt path).

This verb does NOT initialize a fresh `.atmux/` directory inside the team root (that's `atmux init`'s job). It is purely a **roster-management** verb — paired with `atmux team remove` for symmetric add/remove tooling.

### (D6) Docs surface

- `docs/RUNBOOK-team-lifecycle.md` — new runbook covering the add → init → reconcile → remove arc, with `atmux team remove --dry-run` example output and the receipt-recovery flow.
- `templates/briefs/superdriver.md` — update the team-decommission section to point at the new verb (replaces the 10-step manual checklist).
- `README.md` — one-line mention in the verb-surface table.

## Consequences

**Operators** gain a single recoverable verb for decommissioning regular teams. The 10-step checklist + 3 footguns collapse to one safety-gated call with a `--dry-run` preview and a recoverable receipt. Symmetric `atmux team add` lets operators undo accidental removals from the receipt.

**Code** adds: `src/verbs/team/remove.ts`, `src/verbs/team/add.ts`, `src/core/removal-receipt.ts` (receipt write + read), `src/core/cockpit-json.ts` (formatting-preserving edit helper — extract from existing `cockpit.ts` if not already). Receipt directory `~/.atmux/state/removals/` is the new state-file location (per [ADR-126](126-json-to-sqlite-migration.md) §state-file principle — receipts are append-only audit, JSON is fine).

**Tests**: integration covering each safety-gate refusal path; integration covering `--dry-run` no-side-effects; integration covering `--force` bypassing each gate; e2e covering the full remove → receipt-recovery → add round-trip on a synthetic team fixture.

**ADR cross-refs**: this verb supersedes the operator-side cleanup-checklist baked into [ADR-090](090-epic-team-lifecycle.md) for **regular teams** only — epic-teams continue to use `atmux team dissolve-epic` with its existing gates ([ADR-219](219-dissolve-epic-completeness.md)). [ADR-235](235-cockpit-verb-surface-rationalization.md) §(D3) plain-English refusal contract governs all refusal messages emitted by this verb.

**Out of scope**: re-implementing `atmux team rename` ([ADR-027](027-team-rename-verb.md)) on top of this verb — rename is a separate operation with different gates. Out-of-scope also: bulk `atmux team remove --all-stopped` style sweeps — single-team invocation only in this ADR; if a sweep verb is later wanted, supersede here.

## Open questions

1. **Receipt retention** — do receipts in `~/.atmux/state/removals/` get pruned automatically or are they permanent? **Recommended default**: permanent (small JSON files; forensic value high; operator can `rm` manually). Defer auto-prune to a follow-up ADR if disk pressure surfaces.
2. **`atmux team remove --force` against a running cage** — should the verb attempt graceful drain (whip-stop) before kill, or hard-kill via `tmux kill-session`? **Recommended default**: hard-kill (consistent with `atmux stop --force`). Graceful drain is an operator decision before invoking remove.
3. **`atmux team add` vs `atmux init`** — overlap. Recommend: `atmux team add` is **roster-only** (cockpit.json edit), `atmux init` continues to be the **initializer** (creates `.atmux/`, runs wizard, etc.). Operator's mental model: `atmux init` first, `atmux team add` after to roster it into the cockpit. The `atmux team add` verb DOES NOT call `atmux init` — that's a separate explicit step.
