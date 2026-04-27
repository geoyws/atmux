# E9/Sb Signoff — Decisions richness gate (rev=high full / medium=low compact)

**Reviewer**: reviewer-2
**Date**: 2026-04-27
**Task**: t-b92a2690 (REVIEW)
**Story**: s-82b7d6eb (E9/Sb)
**ADR**: 020 (status: accepted)

**Verdict**: ✅ APPROVED — within rev-gate add-time ping scope. Adjacent class (`digest`) flagged as not-covered, by design.

## Deps verified done

- t-b9dcf15b BE — `lib/decisions.sh::_decisions_render_discord` rev-gate (commit `ad23a89`).
- t-0d6ebf2b TEST — `tests/unit/decisions_richness.bats` (commit `32c6c74`).
- t-d910bca2 FE — briefs alignment for `lead.md` + `planner.md` (commit `da3f9c5`).

## 1. rev=high preserves multi-section expansion + 400-char per-field cap + truncation marker

`lib/decisions.sh:430-553` — High-rev path:

- `field_cap=400` declared `lib/decisions.sh:431`. Each of `context` / each `option` / `impact` / `note` checked against `${#var} > field_cap`; `truncated=1` flips on first cap-hit (`:434-469`).
- Single-chunk ≤1900 chars path emits all 4 sec_* blocks and appends `truncation_marker` if any cap fired (`:478-482`).
- Multi-chunk path (`:484-545`) packs sec_ctx → sec_opts → sec_imp → sec_note in keep-order with `[N/M]` header on each emit; appends `↳ atmux decisions show <id> for full` once on the LAST chunk if `skipped > 0 || truncated > 0`.
- Required block (chunk 1) is pinned regardless of overflow shape.

✅ Verified against ADR-020 §Decision.

## 2. rev=medium / rev=low produces compact-only ping (no optional sections in body)

`lib/decisions.sh:421-428` — Compact branch:

```bash
if [[ "$rev" != "high" ]]; then
  local hdr_compact="📋 **[atmux-decisions]** · \`$team\` · $hhmm"
  printf '%s\0' "$hdr_compact"$'\n\n'"$req"
  return 0
fi
```

- Required block only (question / default / decided-by / reversibility / show-pointer / override).
- Single chunk, no `[N/M]` tag.
- Section blocks (`$sec_ctx` / `$sec_opts` / `$sec_imp` / `$sec_note`) are never built or emitted under medium/low.

Note: rev=low gates upstream at `lib/decisions.sh:281` (`^(high|medium)$`) — no Discord ping fires for low at all. `_decisions_render_discord` is only invoked for high+medium; medium reaches the compact branch.

✅ Verified.

## 3. decisions.md persists full fields for ALL tiers (no data loss)

`lib/decisions.sh::_decisions_append` (`:319-368`):

- Called BEFORE the rev-gate ping path (`:270-272`), inside `atmux::with_lock`.
- Writes `timestamp` / `question` / `default` / `reversibility` / `note` / `context` / `options` / `impact` / `decided-by` / `override` regardless of `rev` value.
- Comment at `:387` explicitly documents: "_decisions_append still records full fields to decisions.md regardless of rev; show-pointer is the recovery surface for compact-mode pings."

AC5 in the test asserts this directly via `grep -q '^- \*\*context\*\*: ...'` and `^- \*\*options\*\*:$` against `.atmux/decisions.md` after a medium-rev (compact ping) call. PASS.

✅ Persistence is rev-agnostic. Show-pointer is the documented recovery surface.

## 4. Tests assert both branches + truncation + persistence

`tests/unit/decisions_richness.bats` — 5 cases:

| AC | Case | Branch covered |
|----|------|----------------|
| AC1 | rev=high + all fields ⇒ ping carries 🌐 ctx + ⚖️ opts + 💥 imp + 📝 note | high, full expansion |
| AC2 | rev=high + 500-char `--context` ⇒ truncated to 400 + recovery marker | high, field-cap + truncation |
| AC3 | rev=medium + all fields ⇒ COMPACT ping (no sec_*); req block intact | medium, compact |
| AC4 | rev=low ⇒ NO ping fires (regression pin on `^(high|medium)$` gate) | low, gate-skip |
| AC5 | rev=medium compact ⇒ decisions.md persists ALL fields | persistence asymmetry |

Curl mocked via PATH shim, payload recovered via NUL-RS awk → jq. Canonical pattern matches `decisions.bats` / `decisions_gating.bats`.

**Local run**: 5/5 PASS.
**Regression**: 59/59 PASS across `decisions.bats` + `decisions_gating.bats` + `decisions_context_gate.bats` + `decisions_richness.bats`. No regression.

✅ Tests cover both branches + truncation + persistence + regression-pin on the low-rev gate.

## 5. Briefs reflect new shape (planner + lead)

- `templates/briefs/planner.md:174` — full Sb section: 400-char cap + ↳ marker + medium/low compact + persistence + implication ("ALWAYS pass `--context` AND `--impact` AND ≥2 `--option` flags" for high-rev).
- `templates/briefs/lead.md:157-160` — same structural guidance with lead-side framing ("ALWAYS pass …flags so the inlined ping is self-sufficient").
- `templates/briefs/team-lead.md` — intentionally untouched. FE Task body documents the carve-out: "lead.md is the canonical decisions-add documentation; AC's 'whichever roles document decisions add' guidance honoured." Confirmed by `grep 'decisions add' templates/briefs/team-lead.md` returning empty before AND after the change.

✅ Briefs aligned. Lead/planner roles get Sb guidance; team-lead role doesn't document `decisions add` per pre-existing convention.

## 6. ADR-020 status remains "accepted"

`docs/adr/020-decisions-renderer-richness-gate.md:3`:

```
**Status**: accepted
**Date**: 2026-04-27
```

✅ Confirmed.

## Vulnerability widening — adjacent classes

**Question**: are there OTHER paths that emit decision content to Discord that bypass the rev gate?

- `lib/decisions.sh:697` — `_atmux_decisions_digest` (digest path) emits a periodic bullet-list aggregation of low-rev decisions. **Does not apply the rev-gate** — by design. Digest is a different shape (1 line per decision, no rich-fields). Sb's rev gate is scoped to `_decisions_render_discord` (the add-time inline ping). Digest already serves as the compact recovery surface for low-rev; no asymmetry to fix.
- `lib/decisions.sh:294` — only call site of `_decisions_render_discord`, gated by `if [[ "$reversibility" =~ ^(high|medium)$ ]]` (`:281`). Single entry-point. No bypass.
- Override path (`atmux send lead "override d-...: ..."`) — does NOT re-render the original decision. Recipient lead reads via `atmux decisions show <id>`. No Discord re-emit; out of richness-gate scope.

✅ APPROVED within scope (add-time ping path). Adjacent class not covered:
- Digest aggregation path — intentionally separate, different shape, no leak.

## Tradeoffs noted

- Per-field cap is 400 chars hard-coded at `lib/decisions.sh:431`. If future tuning needed (per ADR-020 §Open questions), the constant moves to a single locus — small surface.
- Compact mode emits zero optional fields on wire; driver MUST shell into `atmux decisions show` to inspect rich detail on medium-rev override decisions. ADR-020 explicitly accepts this — the show-pointer is the recovery surface and is included in the compact required block. Not a concern.

## Final verdict

**✅ APPROVED** within the rev-gate add-time ping scope.

Adjacent classes flagged as not-covered (digest path, override path) — both by design, neither is a bypass.
