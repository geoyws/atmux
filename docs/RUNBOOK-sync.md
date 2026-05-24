# RUNBOOK — `atmux sync claude-team-json`

Operator-facing reference for materializing `.claude/team.json` from the canonical `.atmux/team.json`. See [ADR-164](adr/164-sync-claude-team-json.md) for the rationale.

The Claude `/team` skill family (`/team rotate-lead`, `/team clear <member>`, bootstrap brief paste-in, `whip-prompt.md` teammate-scan fallback) reads `.claude/team.json`. atmux owns the canonical roster at `.atmux/team.json`. Without `atmux sync`, the two surfaces drift the moment you `add-member` / `rotate` / `member rename` — operators end up hand-editing the legacy file every cycle. `atmux sync claude-team-json` is the one-shot operator-fired bridge.

## §1 — When to run

Fire the verb after any operation that mutates the atmux roster:

- `atmux add-member` / `atmux remove-member`
- `atmux rotate <member>` (label / brief-curing changes)
- `atmux member rename <member>` ([ADR-136](adr/136-hot-rename-member-labels.md))
- Before paste-in to a fresh cage (so the bootstrap brief reads a fresh `.claude/team.json`)
- After a sibling worker hand-edits `.claude/team.json` with a long-form `role` brief that you want to preserve

Auto-cron + post-write hooks are deferred per ADR-164 §OQ-6 — v1 is operator-fired. Until that lands, treat the verb like `atmux groom`: cheap to invoke, idempotent when nothing changed.

## §2 — Dry-run → review → sync flow

```bash
# 1. Preview the diff (no write). Safe to repeat.
atmux sync claude-team-json --dry-run

# 2. If the diff looks right, write atomically.
atmux sync claude-team-json
```

`--dry-run` renders a unified-diff-style preview to stdout (`+` additions / `-` removals / space unchanged) per ADR-164 §"Behavior" step 8. Exit `0` regardless of whether changes would land. The on-disk `.claude/team.json` is untouched.

Without `--dry-run` the verb writes atomically via `abstractions/fs.atomicWrite` (mktemp + rename per [ADR-098](adr/098-json-and-locking.md), formerly `adr-bun/005-json-and-locking.md` pre-consolidation) and stamps an `_atmuxSync` marker block at the file's top level. Next invocation reads the marker and short-circuits if nothing changed (idempotent — see §3).

### `--overwrite-briefs`

Preserve-by-default protects hand-authored long-form `role` text on the Claude side from accidental wipe (ADR-164 §OQ-4). When you want to restructure from scratch — e.g. after a wholesale role-vocabulary refactor — opt-in:

```bash
atmux sync claude-team-json --overwrite-briefs
```

Replaces every member's Claude-side `role` with the atmux role-enum value (`"team-lead"`, `"planner"`, `"reviewer"`, `"member"`, `"committer"`, etc.). Use sparingly.

## §3 — Drift detection + `--force`

atmux stamps a top-level `_atmuxSync` block on every write:

```json
{
  "_atmuxSync": {
    "lastSyncedAt": "2026-05-17T08:00:00.000Z",
    "schemaRev": "v1",
    "sourceFingerprint": "sha256:…"
  },
  "name": "your-team",
  …
}
```

`sourceFingerprint` is a sha256 over the canonical-serialized member roster (excluding `_atmuxSync` itself). On the next invocation, atmux re-reads the file, recomputes the fingerprint, and compares against the stored value. Mismatch = a hand-edit happened between syncs.

By default the verb refuses to proceed (exit `65`, EX_DATAERR) with a 3-line hint:

```
🔧 [sync-claude-team-json] drift detected — prior=sha256:abcdef0123… current=sha256:fedcba9876…
drift detected — refusing without --force
  prior fingerprint:   sha256:abcdef…
  current fingerprint: sha256:fedcba…
  last synced at:      2026-05-17T08:00:00.000Z
```

Recovery options:

1. **Inspect the hand-edit, decide it was intentional.** Re-run with `--force` to log the override (`action=drift-forced` in `.atmux/logs/sync-events.jsonl`) and proceed:

   ```bash
   atmux sync claude-team-json --force
   ```

   Note: `--force` re-maps from atmux-side, which drops anything the hand-edit added that's not on the atmux side. Combine with `--overwrite-briefs` only when you also want to wipe Claude-side `role` text; without it, the hand-authored briefs are preserved per §2.

2. **Inspect the hand-edit, decide to keep it as the new baseline.** Manually update `_atmuxSync.sourceFingerprint` to the post-edit fingerprint — easier path: re-run `atmux sync claude-team-json --force` (the marker is re-stamped), then your next dry-run will reflect the merged state.

3. **Inspect the hand-edit, decide to discard it.** Delete `.claude/team.json` and re-run `atmux sync claude-team-json` for a clean-slate write.

## §4 — Color sidecar (`.claude/team-colors.json`)

The built-in emoji → color table covers the standard atmux palette (coordinator/planner/reviewer/BE/FE/docs/committer/ombudsman bands per ADR-164 §"Color mapping"). Unmapped emoji fall through to a deterministic random-from-pool fallback seeded on `member.name` (same member → same color across runs).

To override specific emoji-or-member combos without recompiling atmux, drop a sidecar at `.claude/team-colors.json`:

```json
{
  "🧭": "white",
  "🤖": "magenta",
  "_byMemberName": {
    "lead": "white",
    "planner-near": "magenta"
  }
}
```

Resolution priority (highest wins):

1. `_byMemberName[<member.name>]` exact match
2. Top-level `<emoji>` override
3. Built-in fixed table
4. Deterministic FNV-1a-seeded pool fallback

`_byMemberName` wins over the emoji band when both match. Empty-string entries (`""`) are treated as falsy and fall through to the next band.

## §5 — Error modes + exit codes

| Exit | Class | Cause | Recovery |
|---|---|---|---|
| `0` | success | sync completed (or `--dry-run` preview rendered) | none |
| `64` | EX_USAGE | bad flag (typo) or unexpected positional arg | re-run with the documented flags (`--dry-run` / `--overwrite-briefs` / `--force`) |
| `65` | EX_DATAERR | drift detected, `--force` not passed | see §3 — review the hand-edit, then `--force` or rebase manually |

Stderr emits the `🔧 [sync-claude-team-json] drift detected …` warning whenever drift is observed, regardless of whether `--force` was passed. The JSONL log at `.atmux/logs/sync-events.jsonl` records one event per invocation (`action` ∈ `synced` / `drift-abort` / `drift-forced`); grep that file for an audit trail.

Other failure shapes:

- **Missing `.atmux/team.json`** — the verb refuses with a hint to run `atmux init` first. atmux can't materialize the Claude file without the canonical roster.
- **Missing `.claude/` directory** — atmux creates it on first write. No setup needed.
- **Unknown emoji** — falls through to the deterministic pool fallback (color stable across runs). To pin a specific color, add a `_byMemberName` entry to the sidecar (§4).
- **Sibling members with the same `name`** — `mergeBriefs` last-write-wins on the lookup map; reviewer-level lint catches this upstream in atmux. If you see two members with the same name in atmux-side `team.json`, that's the underlying bug.

## §6 — Files touched

- **Read**: `.atmux/team.json` (Zod-validated), `.claude/team.json` (loose, no schema), `.claude/team-colors.json` (loose, optional sidecar).
- **Write**: `.claude/team.json` (atomic, flock-safe), `.atmux/logs/sync-events.jsonl` (append-only event log).

Source: `src/verbs/sync.ts` dispatcher + flag parser + write composer; `src/core/sync-claude-team-json/{index,mapping,color-map,name-rewrite,drift,diff,types}.ts` for the pure compute path. Tests: `tests/unit/core/sync-claude-team-json/*.test.ts` + `tests/unit/sync-claude-team-json.bats`.
