# ADR-164: `atmux sync claude-team-json` — materialize `.claude/team.json` from `.atmux/team.json`

**Status**: accepted
**Date**: 2026-05-16
**Driver-ref**: `.atmux/driver-inbox.md` §🚨 16:55 MYT 2026-05-16 — sopx-lead → atmux/lead

## Context

`.atmux/team.json` is the **canonical** team roster atmux reads for every verb (`dispatch`, `send`, `rotate`, `start`, `stop`, etc.). It is fresh, schema-validated (per [ADR-005](005-json-and-lock.md)), and in lock-step with the live cage.

`.claude/team.json` is the **legacy** roster shape consumed by the Claude-side `/team` skill family (`/team rotate-lead`, `/team clear <member>`, bootstrap brief paste-in, `whip-prompt.md` teammate-scan fallback path). Pre-atmux projects used it as the only source of truth; post-atmux projects often keep it around for off-Claude-team-skill migration coverage.

**Failure mode observed 2026-05-16** (sopx-team soft-stop, captured at driver-inbox §16:55 MYT): sopx's `.claude/team.json` was 13 entries stale (old `be-fe/be-fe-stubs/be-so/...` lane layout from a retired guild structure) while `.atmux/team.json` was 20-member fresh. Driver hand-synced by hand-editing the legacy file. The divergence will recur every time someone adds/renames a member via `atmux add-member` or `atmux member rename` (ADR-136) without a parallel manual edit.

The two schemas are not isomorphic:

| Atmux side | Claude side | Mapping |
|---|---|---|
| `name` | `name` | verbatim |
| `description` | `description` | verbatim |
| `members[].name` | `members[].name` | verbatim, EXCEPT `name=lead` + `role=team-lead` → emit as `name=team-lead` (Claude skill convention) |
| `members[].role` enum | `members[].agentType` | when `role=team-lead` → emit `agentType: "team-lead"`; else omit |
| `members[].role` enum | `members[].role` (long-form text) | **orthogonal** — Claude-side `role` is a hand-authored multi-sentence brief; preserve existing on re-sync unless `--overwrite-briefs` |
| `members[].emoji` | `members[].color` | derive via fixed emoji→color table; sidecar `.claude/team-colors.json` override; fallback random-from-pool |
| `members[].model` (`"default"`, `"claude-opus-4-7"`) | `members[].model` | verbatim, with `"default"` → `"claude-opus-4-7"` expansion (matches the spawn-time resolution in [ADR-094](094-c-alias-spawn-convention.md) §"team-members default Opus") |
| `members[].label` (ADR-136) | — | dropped (Claude-side has no display/id split) |
| `members[].lane` / `tui` / `cwd` / `command` / `claudeAccount` | — | dropped (atmux-runtime concerns, not /team-skill concerns) |

Driver framing (verbatim, George chat 16:53 MYT): *"otherwise if it can't sync then complain to the atmux team to design it so that it can be syncable so we can work with people migrating off of claude teams"*. i.e. the ask is design-level — **make the schemas syncable; a verb the operator can run is sufficient; auto-cron sync would be even nicer**. v1 ships the verb; auto-cron + post-write-hook deferred (see §Open questions OQ-6).

## Decision

Add an `atmux sync` verb dispatcher (`src/verbs/sync.ts`), with subverb `claude-team-json` as its first member. Operator surface:

```
atmux sync claude-team-json [--dry-run] [--overwrite-briefs] [--force]
```

### Behavior

1. **Read** `.atmux/team.json` via the existing Zod-validated `tryLoadTeam` loader (`src/core/common.ts`).
2. **Read** `.claude/team.json` if present, parse loosely (no schema validation — the file is hand-authored and may carry operator extensions; preserve unknown fields).
3. **Read** `.claude/team-colors.json` if present (sidecar emoji → color override).
4. **Compute** the mapped roster per the table above.
5. **Drift detection** (per §"Idempotence + drift"):
   - When `.claude/team.json` carries a `_atmuxSync` marker block (`{lastSyncedAt, schemaRev, sourceFingerprint}`) AND the file's current content hash ≠ the last-sync fingerprint, emit a `🔧 [sync-claude-team-json] drift detected` warning to stderr + the lead-events JSONL.
   - When drift is detected AND `--force` is not passed: abort with exit 65 (EX_DATAERR) and a 3-line diff hint. With `--force`: proceed + log the override.
6. **Brief preservation**: for every `members[i]` that exists in both files, if Claude-side has a non-empty `role` (long-form text), keep it. Without `--overwrite-briefs`, the sync verb NEVER overwrites a non-empty Claude-side `role`. With `--overwrite-briefs`, the sync verb replaces `role` with the atmux-side `role` enum value (e.g. `"team-lead"`, `"planner"`, `"reviewer"`, `"member"`) — operators use this when restructuring from scratch.
7. **Write** `.claude/team.json` atomically via `updateJson` (flock per ADR-005). Include the `_atmuxSync` marker block at the file's top level (passthrough — does not break the Claude-side skill which ignores unknown keys).
8. **Dry-run**: `--dry-run` SKIPS step 7; instead prints a unified-diff-style preview to stdout (`+`/`-`/space prefix, per member + per field). Exit 0 regardless of whether changes would land.

### File shape after sync

```json
{
  "_atmuxSync": {
    "lastSyncedAt": "2026-05-16T16:55:00+08:00",
    "schemaRev": "v1",
    "sourceFingerprint": "sha256:..."
  },
  "name": "atmux",
  "description": "...",
  "members": [
    {
      "name": "team-lead",
      "agentType": "team-lead",
      "color": "white",
      "role": "<preserved long-form brief OR atmux role-enum on first sync>",
      "model": "claude-opus-4-7"
    },
    ...
  ]
}
```

JSON does not allow comments; the driver-suggested `// last-synced:` line is replaced by a `_atmuxSync` top-level passthrough field. This keeps the file pure-JSON-valid while still being grep-able + script-detectable.

### Color mapping (emoji → color)

Fixed table in `src/core/sync-claude-team-json/color-map.ts`. Initial seed (operator-overridable via `.claude/team-colors.json`):

| Emoji band | Color |
|---|---|
| 🧭 ⚙️ 🛠️ | white (coordinator) |
| 🎯 🦊 🐺 | magenta (planner) |
| 🔍 🦉 👁️ | cyan (reviewer) |
| 📦 🦔 🦫 | green (BE-impl) |
| 🌸 🌷 🎨 | orange (FE-impl) |
| 🦦 📚 📝 | yellow (docs) |
| 🌿 🌱 🍃 | green (gitter / committer) |
| ⚖️ 👮 | red (ombudsman / enforcer) |
| (unmapped) | random-from-pool (deterministic seed = `member.name`) |

The table is **not** a closed enum — the sidecar `.claude/team-colors.json` lets an operator paint specific emoji-or-member combos without recompiling atmux. Sidecar shape:

```json
{
  "🧭": "white",
  "_byMemberName": {
    "lead": "white",
    "planner-near": "magenta"
  }
}
```

`_byMemberName` wins over the emoji band when both match.

### Name rewrite: `lead` → `team-lead`

The atmux convention is `members[0].name = "lead"` (short, one-word, single-quote-friendly). The Claude `/team` skill family expects `members[].name = "team-lead"` when `agentType == "team-lead"` — this is hard-coded in `/team rotate-lead` + the bootstrap brief paste-in. The sync verb performs the rewrite unconditionally for any member with `role: "team-lead"`. Other role names (`planner`, `reviewer`, `member`, `gitter`, `dba`, `unblocker`, `discorder`, etc.) pass through verbatim.

### Verb registration + CLI shape

- `src/verbs/sync.ts` — top-level dispatcher (mirrors `src/verbs/team.ts` + `src/verbs/member.ts` subverb pattern). Throws `UsageError` on unknown subverb so future sync targets (`cockpit-json`, `inbox-mirror`, etc.) can land without breaking parity.
- `src/cli.ts` adds `case "sync":` → `await sync(args)`.
- `atmux sync` (bare) lists known subverbs.

## Consequences

- **Off-Claude-team-skill migrators**: gain a one-shot operator-fired verb to keep their legacy `.claude/team.json` honest. The two files remain non-equivalent (atmux carries fields Claude doesn't and vice versa) but the syncable surface is now mechanical, not manual.
- **Existing atmux projects** (atmux, sopx, unum): no behavior change unless the verb is fired. The atmux project itself has no `.claude/team.json` at HEAD; firing the verb here creates one.
- **`.claude/team.json` shape grows** a `_atmuxSync` top-level field. The Claude `/team` skill family ignores unknown keys (verified pre-write); no skill-side change needed.
- **Brief preservation** is the default — operators who hand-author long-form role text are protected from accidental overwrite. The opt-in `--overwrite-briefs` flag lets a clean-room restructure proceed.
- **Drift detection** surfaces hand-edits between syncs (operator added a brief; sync detects file changed; refuses without `--force`). This is the same shape as [ADR-054](054-typed-whip-config-with-zod.md) §"drift detection" — pattern reuse, not new mechanism.
- **Coverage**: `src/verbs/sync.ts` + `src/core/sync-claude-team-json/*.ts` ship with 100% unit coverage (per the testing discipline in CLAUDE.md). One bats integration test covers the round-trip (atmux team.json fixture → run verb → assert .claude/team.json shape).
- **Auto-cron + post-write hook**: deferred to follow-up (see OQ-6). v1 is operator-fired only.

## Open questions

1. **OQ-1 (RESOLVED, LOW-rev)**: idempotence marker — JSON-comment-line vs top-level `_atmuxSync` field.
   - **Default**: `_atmuxSync` top-level passthrough field (`{lastSyncedAt, schemaRev, sourceFingerprint}`).
   - **Rationale**: JSON spec rejects comments; sidecar files double the failure surface; passthrough field is grep-able + the Claude `/team` skill ignores it.

2. **OQ-2 (RESOLVED, MEDIUM-rev)**: name rewrite — `lead` → `team-lead` conditional vs unconditional.
   - **Default**: unconditional rewrite whenever `member.role == "team-lead"`.
   - **Rationale**: `/team rotate-lead` skill hard-codes `team-lead` as the lead identifier; conditional rewrite would surprise migrators who happen to use `name=lead` in their atmux config (most do per convention).
   - **Reversibility**: medium — operators can override the rewrite via the sidecar `.claude/team-colors.json` `_byMemberName` field (extended to cover name aliases) in a follow-up patch if the unconditional rewrite ever proves wrong.

3. **OQ-3 (RESOLVED, LOW-rev)**: color-mapping strategy — fixed table, sidecar override, random-from-pool, or AI-assigned.
   - **Default**: fixed table primary, `.claude/team-colors.json` sidecar override secondary, deterministic random-from-pool fallback (seed = `member.name`) for unmapped emoji.
   - **Rationale**: deterministic + operator-overridable + survives emoji additions without crashing.

4. **OQ-4 (RESOLVED, MEDIUM-rev)**: brief preservation — preserve-by-default vs overwrite-by-default.
   - **Default**: preserve-by-default; `--overwrite-briefs` flag for explicit replace.
   - **Rationale**: long-form briefs are expensive to author and frequently hand-curated; an unexpected wipe is a worse failure than a stale brief. Operators who restructure rosters from scratch can pass `--overwrite-briefs` explicitly.

5. **OQ-5 (RESOLVED, LOW-rev)**: drift detection on re-sync — refuse vs warn-and-proceed.
   - **Default**: refuse without `--force` when drift detected; `--force` proceeds + logs the override.
   - **Rationale**: hand-edits between syncs are likely intentional; silently overwriting them recreates the failure mode the verb was built to prevent. `--force` is the explicit override path.

6. **OQ-6 (RESOLVED, LOW-rev — deferred to follow-up)**: auto-cron sync + post-write hooks.
   - **Default**: defer — v1 is operator-fired only.
   - **Rationale**: the driver framing names a verb as sufficient; auto-cron is "even nicer". Auto-cron + post-write hooks on `add-member` / `member rename` / `rotate` / `team set` introduce coupling that's better designed once the verb is in production. Follow-up filed as a P5 Task on this Epic.

## Related

- ADR-005 — JSON + flock writer discipline.
- ADR-054 — typed-config + drift detection pattern reused here.
- ADR-094 — c-alias spawn convention (model default resolution).
- ADR-136 — display label vs immutable name (informs why `label` is dropped from the sync surface).
- ADR-145 — atmux adopts gitter (drives current 20-member team layouts that surfaced this divergence).


## §Amendment 2026-05-20 — promoted to accepted (status-drift audit T4)

Promoted from `proposed` → `accepted` per [docs/audits/adr-status-drift-audit-2026-05-20.md](../audits/adr-status-drift-audit-2026-05-20.md) (sha=a6f1541). Code-refs + git-log refs both present at audit time confirming shipped + dogfooded status; the `proposed` marker was bookkeeping debt. Original Date preserved verbatim. Append-only — see Status field for the canonical flip; this §Amendment carries the audit traceability.

**Filed via** t-45b401c3 (T4 sweep, 2026-05-20).
