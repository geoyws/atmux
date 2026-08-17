# ADR-264: Cockpit tmux session renamed `atmux_cockpit` → `atx` — "cockpit" stays the prose name

**Status**: accepted
**Date**: 2026-07-28
**Driver-ref**: George 2026-07-28 — "let's clean up atmux for future use... let's make the cockpit in tmux be named atx but we'll refer to it as the cockpit. note this down to adrs."
**Supersedes (naming only)**: [ADR-135](135-cockpit-naming-convention.md) §D1 — the session-name literal `atmux_cockpit`. Every other ADR-135 decision (§D2 `_role` cockpit windows, §D3 `<emoji>-<member>` format, §D4 in-place-rename migration shape, §D5 coercion-shim shape) stays operative and is *reused* here.
**Relates**: [ADR-162](162-atmux-owns-tmux-infrastructure.md) (socket isolation — the `atmux-cockpit` **socket** name is unchanged), [ADR-063](063-cockpit-verb-port.md) (cockpit verb — unchanged), [ADR-235](235-cockpit-verb-surface-rationalization.md) (verb surface — unchanged).

## Context

ADR-135 renamed the cockpit session `atmux_teams` → `atmux_cockpit`; ADR-162 then moved it onto a dedicated named socket `atmux-cockpit`. The result is a near-identical socket/session pair that differs only by hyphen vs underscore:

```
tmux -L atmux-cockpit attach -t atmux_cockpit
```

That pair is easy to mistype, annoying to explain, and the session literal is the thing operators type most. Meanwhile "cockpit" is the *concept* — the verb group (`atmux cockpit …`), the roles ("cockpit-tier"), the docs — and none of that needs to change. Only the tmux session literal is plumbing.

A short, distinctly-shaped literal also fixes a second ambiguity: team sessions are `atmux_<team>`, and `atmux_cockpit` sits one character away from that pattern. `atx` is visually unambiguous in `tmux list-sessions` — it cannot be confused with a team cage.

## Decision

### (D1) Canonical session literal: `atx`

`cockpit.json::cockpitSession` default flips `atmux_cockpit` → `atx` (`src/schema/cockpit.ts`). Operator attach flow becomes:

```
tmux -L atmux-cockpit attach -t atx
```

(or `atmux cockpit attach`, which reads the config value).

The prose term **"cockpit" is unchanged everywhere** — docs, CLI help, verb names, role descriptions, ADR prose. We still say "the cockpit"; only the tmux session literal is `atx`.

### (D2) Socket name unchanged

The dedicated socket stays `atmux-cockpit` per ADR-162. This ADR touches the session-on-that-socket literal only. No socket migration, no `ATMUX_COCKPIT_SOCKET` semantics change.

### (D3) Backward-compat coercion — both legacy literals accepted-with-warning

Same shape as ADR-135 §D5, extended one generation. `migrateCockpitSessionLegacyLiteral` (`src/core/cockpit.ts`) coerces **both** historical literals to `atx` at load time with a one-line deprecation warning:

- `cockpitSession: "atx"` (canonical) — no warning.
- `cockpitSession: "atmux_cockpit"` or `"atmux_teams"` (deprecated literals) — warning + coerce to `atx`; rebuild proceeds.
- Operator-chosen arbitrary names (e.g. `geoyws_cockpit`) pass through untouched — the coercion fires only on the two historical literals.

### (D4) In-place tmux migration — `rename-session`, no kill+respawn

Same shape as ADR-135 §D4, extended one generation. `reconcileCockpitSession` (`src/verbs/cockpit.ts`) detects a live `atmux_cockpit` or `atmux_teams` session on the cockpit socket when the resolved target is `atx`, and renames it in place via `tmux rename-session` — pane PIDs, attached clients, and scroll history preserved. Idempotent: subsequent rebuilds find `atx` and do nothing. If both a legacy session AND `atx` exist, warn and leave it to the operator (kill the legacy session manually).

### (D5) migrate-socket + doctor follow the rename

- `LEGACY_COCKPIT_SESSION_NAMES` (`src/verbs/cockpit.ts`) is now all-legacy — `["atmux_cockpit", "atmux_teams"]` — and the `atmux cockpit migrate-socket` target session literal becomes `atx`.
- The `atmux doctor` `cockpit-on-default-socket` probe (ADR-162 §Decision-anchor #5) detects **any** of the three literals (`atx`, `atmux_cockpit`, `atmux_teams`) on the default socket.
- `COCKPIT_SESSION_DEFAULT` in `src/verbs/cockpit-rotate.ts` flips to `atx`.

### (D6) Docs + templates updated at machine-target granularity

Runbooks, ARCHITECTURE.md, and `templates/briefs/*.md` are updated **where they name the tmux session as a machine target** (`session=atmux_cockpit`, attach one-liners). Prose occurrences of "cockpit" stay. Historical ADRs and release notes keep their period-accurate literals (append-only convention).

## Consequences

- **One-commit-family change set** — `src/schema/cockpit.ts` (default), `src/core/cockpit.ts` (coercion shim), `src/verbs/cockpit.ts` (rebuild migration shim + migrate-socket target + LEGACY list comment), `src/verbs/cockpit-rotate.ts` (default), `src/verbs/doctor.ts` (probe), `templates/briefs/*.md`, `docs/RUNBOOK-cockpit.md`, `docs/ARCHITECTURE.md`, tests for the above.
- **Operator zero-disruption** — in-place `rename-session` on the next `atmux cockpit rebuild`; attached clients survive. Configs pinning the old literal keep working through the coercion shim with a warning.
- **Reversibility** — flip back is one schema default + one shim list; the migration shim's idempotency makes "what's the current name" the source of truth.
- **Out of scope** — renaming the `atmux-cockpit` socket, the `atmux cockpit` verb group, any prose "cockpit" usage, and historical doc literals.

## Cross-references

- [ADR-135](135-cockpit-naming-convention.md) — naming convention this ADR amends (§D1 only). Gains an amendment note pointing here.
- [ADR-162](162-atmux-owns-tmux-infrastructure.md) — socket isolation; socket name unchanged.
- [ADR-133](133-medic-rename.md) — the original backward-compat shim precedent (TR2/TR3) reused by ADR-135 and again here.

## Amendments

### 2026-07-28 — `atx` promoted to canonical project shorthand (ADR-265)

[ADR-265](265-atx-canonical-shorthand.md) generalises this ADR's session literal into the canonical prose shorthand for atmux itself. The session name chosen here is now doubly motivated: the cockpit is the canonical `atx` surface. This ADR's decisions are unchanged — per ADR-265 §D3, "the cockpit" remains the prose name for the operator surface, and `atx`-the-session-literal appears only in tmux-targeting commands.
