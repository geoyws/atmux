# ADR-020: Decisions renderer richness gate — high-rev gets full expansion, medium/low gets compact

**Status**: accepted
**Date**: 2026-04-27

## Context

`d-bccdc154` enforced a minimum `--context` length on high/medium reversibility decisions (per ADR-008 §Sd). The motivation was that high-rev pings interrupt the driver in real time; a terse one-liner forces the driver to shell into the-host + run `atmux decisions show <id>` to read the full reasoning — friction at the worst possible moment (driver on phone, mid-walk, etc).

Field-length enforcement helped, but it's only half the answer:

- Callers who pass `--context "..."` get the field rendered as a `🌐 context: <body>` section — but the renderer treats high/medium identically, so a low-rev decision with rich fields still gets the full multi-chunk expansion (overkill for routine code-shape calls), and a high-rev decision with terse fields still feels under-detailed against the interrupt cost.
- The `_decisions_render_discord` chunker (ADR-008 §S10) already supports up to 5 chunks — but it doesn't differentiate. Callers can't predict whether their ping will be one compact message or five rich ones.

Three shapes considered:

- **A (chosen)** — gate richness on reversibility tier. **High-rev: full expansion** (context + impact + options + note inlined, multi-chunk if needed, ~400 chars per field cap). **Medium/low-rev: compact** (question + default + decided-by + reversibility + show-pointer + override; context/impact/options/note OMITTED from the ping body — show-pointer is the recovery path). One renderer, one branch on rev.
- **B (rejected)** — add structured `--tradeoffs` / `--options` fields and render only those. Driver explicitly leaning against (already have `--option` repeatable). More verb surface area for marginal gain.
- **C (rejected)** — brief-teach callers to write longer `--context`. Already attempted via ADR-008 §Sd's enforcement. Insufficient without renderer-side reinforcement.

The driver's stated UX goal is "self-sufficient ping for high-rev." Show-pointer is a recovery, not a primary surface, when the decision can derail the next hour of work.

## Decision

**Modify `lib/decisions.sh::_decisions_render_discord` to gate optional-section rendering on `$rev`:**

- **`rev == "high"`** — current behaviour preserved. Sections (`sec_ctx`, `sec_opts`, `sec_imp`, `sec_note`) flow through the chunker; multi-chunk allocation as today; per-field truncation cap raised to ~400 chars (was effectively unbounded — this is a soft-cap to keep multi-message bursts under control).
- **`rev == "medium"` OR `rev == "low"`** — compact mode. Render only the required block (`question`, `default`, `decided-by`, `reversibility`, `📍 show-pointer`, `↪ override`). Optional sections SKIPPED entirely from the ping body. The decisions.md file still records full fields (no change to `_decisions_append_md`); the show-pointer remains the recovery path.

**No CLI changes.** Callers pass `--context`/`--impact`/`--option`/`--note` as today; renderer decides what to inline. Backward-compat preserved for low-rev (no Discord ping fires anyway per ADR-008 reversibility ladder).

**Per-field truncation cap**: ~400 chars per inlined field on high-rev. Beyond that, truncate inline + append `↳ atmux decisions show $id for full` once at the end of the LAST chunk. Note the existing chunker's "drop-in-order" path (note → impact → options → context) still applies as the last-resort fallback when 5 chunks aren't enough.

## Consequences

- **`lib/decisions.sh::_decisions_render_discord` gains ~10 LOC** for the rev gate + per-field truncation.
- **Compact-mode high-rev pings** stay below 1900 chars in the typical case (one chunk, no `[N/M]` tag).
- **Medium-rev pings shrink** — driver gets less detail on the wire, which is the intent. Rationale: medium-rev pings shouldn't interrupt with full expansion if the decision is recoverable.
- **`tests/unit/decisions_richness.bats`** adds rev-gate coverage: high with all fields → multi-section; medium with all fields → compact-only; low → no ping (existing behaviour).
- **briefs/planner.md + briefs/lead.md** add a one-bullet reminder: high-rev decisions should pass `--context` AND `--impact` AND ≥2 `--option` flags so the inlined body is self-sufficient. (The enforcement gate for context-length stays in place via `d-bccdc154`.)
- **PII guard**: context/impact/options come from caller `--flags` only (already enforced per ADR-008 §S10); no body-text scraping. No PII surface change.
- **Trade-off accepted**: medium-rev callers lose visible context in the ping. Show-pointer is the recovery; the tier was never meant to interrupt the way high-rev does.

## Open questions

1. **OQ B1: per-field truncation cap?** Resolved: ~400 chars per inlined field on high-rev, with a single `↳ atmux decisions show` marker on the last chunk if any field truncated. (low-rev — easy to retune.)
2. **OQ B2: which tiers expand?** Resolved: high only. Medium/low compact. (low-rev — matches driver default.)
3. **OQ B3: PII guard?** Resolved: no transform — fields come from caller `--flags`, never from decisions.md body. Existing trust model preserved. (low-rev.)

All resolutions logged to `.atmux/decisions.md`.
