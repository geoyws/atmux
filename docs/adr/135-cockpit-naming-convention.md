# ADR-135: Cockpit naming convention — `atmux_cockpit` session, `_role` cockpit windows, `<emoji>-<member>` hyphen separator

**Status**: Accepted (2026-05-15)
**Date**: 2026-05-14
**Author**: atmux team (parity-state-impl / t-b3958ee6)
**Supersedes (naming only)**: ADR-063 §session-name (`atmux_teams`) + ADR-017 buildWindowName format (`<emoji><member>`)

## Context

ADR-063 named the operator cockpit session **`atmux_teams`**. ADR-017 (`buildWindowName`) named per-member windows **`<emoji><member>`** (e.g. `🧭lead`, `📦whip-impl`). Two friction points surfaced once the cockpit topology grew past a single superdriver window:

### Session name conflates container with contents

`atmux_teams` reads as *"the session that contains teams"* — accurate but misleading. The cockpit IS the operator's command surface (per ADR-063 + ADR-046); the per-team viewers are nested-attaches into team cages, not first-class members of this session. As the cockpit accreted opt-in roles (medic per ADR-077/133, martinet per ADR-132), the "_teams" suffix grew less descriptive: medic and martinet are cockpit-level roles, not teams.

`atmux_cockpit` names the surface by its purpose. The session is *the operator's cockpit*; the teams it views are addressable via per-team viewer windows whose names are the team names themselves (no underscore, no prefix).

### Cockpit-level windows mix with team-viewer windows in `tmux list-windows`

Before ADR-132/133 only `superdriver` was cockpit-level; `tmux list-windows` showed `superdriver / atmux / sopx / unum / …` and operator could mentally split at the first non-prefixed name. Post-ADR-132/133 the cockpit grew to three system windows (`superdriver / medic / martinet`) that visually mix with team-viewers (`atmux / sopx / unum / …`) — the split point moved and was no longer self-evident from the names.

Underscore-prefix convention solves this with zero runtime cost:

- `_superdriver`, `_medic`, `_martinet` — cockpit-level system roles, alphabetically-sorted before any plain-named team (ASCII `_` < lowercase). Visual grouping at the top of `tmux list-windows`.
- `atmux`, `sopx`, `unum`, … — per-team viewers, no underscore.

The convention is borrowed from Python/JS leading-underscore-means-private — operators reading the window list immediately see *these are system roles, not teams*. Same pattern as `__home`/`__driver` placeholder windows already used by `start.ts` (which keep the double-underscore convention; cockpit roles use single-underscore to distinguish system-role from placeholder).

### Space-as-separator in `<emoji><member>` is shell-quoting-hazardous and regex-hostile

`buildWindowName(member, emoji)` produced `<emoji><member>` (e.g. `🧭lead`, `📦whip-impl`). Two operational pain points:

1. **Shell quoting**: `tmux send-keys -t atmux:🧭lead` works without quoting, but variation-selector emoji like `🛠️` (U+1F6E0 + U+FE0F) introduce surprising width/escape behavior in some terminal contexts. The no-separator form glues emoji bytes directly onto the member name, making manual targets harder to type and complicating any test fixture that synthesises window names from `(emoji, name)` tuples.
2. **Regex / tab-completion friction**: matchers like `^.<emoji>-<name>$` (the *new* form) are stable; `^.<emoji><name>$` (the old form) requires knowing the emoji byte-width to anchor the name segment. Tab-completion engines tokenise on hyphens cleanly; the no-separator form left no token boundary between emoji and name.

Hyphen separator (`<emoji>-<member>`, e.g. `🧭-lead`, `📦-whip-impl`) is symmetric with existing hyphenated member names (`whip-impl`, `parity-cron-impl`, `up-impl-2`), keeps a single visual rhythm, and removes the parsing cost without consuming the visual breathing room a space would.

## Decision

### (D1) Cockpit session: `atmux_teams` → `atmux_cockpit`

`cockpit.json::cockpitSession` default flips from `atmux_teams` to `atmux_cockpit`. Schema and codebase references update to the new default. Operator workflow uses `tmux attach -t atmux_cockpit` going forward.

### (D2) Cockpit-level window names gain underscore prefix

| Before | After | Role |
|---|---|---|
| `superdriver` | `_superdriver` | ADR-063 — operator cross-team REPL |
| `medic` | `_medic` | ADR-077 + ADR-133 — fleet self-healing |
| `martinet` | `_martinet` | ADR-132 — pluggable whip-manager |
| `<teamName>` (e.g. `atmux`, `sopx`) | `<teamName>` (unchanged) | ADR-063 — per-team viewer |

Per-team viewers retain plain team names — no underscore, no prefix. Tradeoff: `tmux send-keys -t atmux_cockpit:_superdriver` reads slightly more "techy" than `:superdriver`. Accepted — window names ARE machine targets first, human-readable second.

### (D3) Member windows: `<emoji><member>` → `<emoji>-<member>`

`buildWindowName(member, emoji)` (in `src/core/common.ts`) now emits `<emoji>-<member>` when emoji is set, falling back to bare `<member>` when not. Examples:

| Before | After |
|---|---|
| `🧭lead` | `🧭-lead` |
| `📦whip-impl` | `📦-whip-impl` |
| `🛠️up-impl` | `🛠️-up-impl` |
| `lead` (no emoji) | `lead` (unchanged) |

`isMemberWindowName` reads the new form transparently — same roster-comparison codepath. Pane-tag captures, `atmux send <member>`, and the whip's `tmux list-windows` walk all use `buildWindowName`, so the change propagates with the function.

### (D4) Backward-compat shim — in-place rename, no destructive ops

`atmux cockpit rebuild` and `atmux start` both grow idempotent rename shims for legacy windows / sessions. The rename uses **in-place** tmux mutations — `rename-session` and `rename-window` preserve pane PIDs, attached clients, and history. No kill+respawn; no operator workflow disruption.

**Cockpit session/window migration** (in `src/verbs/cockpit.ts` rebuild handler):

1. Detect existing `atmux_teams` session on the default socket. If found AND `atmux_cockpit` does not exist on that socket, run `tmux rename-session atmux_teams atmux_cockpit`.
2. Inside the (now-renamed) session, rename cockpit-role windows in-place:
   - `superdriver → _superdriver`
   - `medic → _medic` (only if a `medic` window exists post-ADR-133 rename — legacy `superdoctor` window was already renamed to `medic` by ADR-133's TR3 shim)
   - `martinet → _martinet`
3. Per-team viewer windows: no rename (team names stay plain).
4. Log a one-line migration entry to stderr: *"renamed atmux_teams → atmux_cockpit + cockpit-role windows per ADR-135"*.

**Member-window migration** (in `src/verbs/start.ts` reconcile path):

1. On `atmux start` (or `atmux team rebuild --force-cycle`), enumerate existing member windows in the team's cage.
2. For each member whose window matches the legacy `<emoji><member>` form (concatenated, no hyphen between emoji and name), rename in-place to `<emoji>-<member>`.
3. Detection: compare each existing window name against both `legacyBuildWindowName(member, emoji)` and `buildWindowName(member, emoji)`. Match on the legacy form triggers `rename-window`; match on the new form is a no-op; no match leaves the window alone (operator-renamed or atmux-internal placeholder).

Migration is idempotent — re-running rebuild after the rename is a no-op. Same pattern as ADR-133 TR2's `superdoctor → medic` window rename, extended to cockpit-session and member-window scope.

### (D5) Backward-compat: legacy `cockpitSession: "atmux_teams"` accepted-with-warning

Per ADR-133 §D2 precedent, the schema accepts both values during one release cycle:

1. **`cockpitSession: "atmux_cockpit"`** (canonical) — no warning.
2. **`cockpitSession: "atmux_teams"`** (deprecated literal) — emits a deprecation warning at load time: *"cockpit.json::cockpitSession='atmux_teams' is deprecated; rename to 'atmux_cockpit' per ADR-135"*. Rebuild proceeds; the migration shim D4 handles the actual tmux-side rename.
3. **`cockpitSession` unset** — defaults to `atmux_cockpit`.

After one semantic-version bump (timeline in `CHANGELOG.md`), the deprecated literal becomes a hard error pointing at this ADR.

`cockpitSession` accepts arbitrary user-chosen names (e.g. operator pinning to `geoyws_cockpit`) — the deprecation only fires on the historical literal `atmux_teams`.

### (D6) Crontab migration (idempotent rewrite)

`src/verbs/cron-install.ts` updates emitted cron lines that reference cockpit session/window names:

- `tmux send-keys -t atmux_teams:medic …` → `tmux send-keys -t atmux_cockpit:_medic …`
- `tmux send-keys -t atmux_teams:martinet …` → `tmux send-keys -t atmux_cockpit:_martinet …`

Same idempotent-rewrite pattern as ADR-133 TR6 (`superdoctor → medic` cron line migration). Operator's existing crontab gets surgically updated on next `atmux cron-install` run; no manual cron edits required.

## Resolved open questions

| OQ | Resolution | Reversibility |
|---|---|---|
| Underscore-prefix vs space-prefix for cockpit roles | `_` chosen — sorts before lowercase alphabetics in `tmux list-windows`, no shell-quoting hazard, conventional "private" signal | Medium — flip is one constant change + migration shim |
| Why not double-underscore (`__superdriver`) | Reserved for atmux-internal placeholder windows (`__home`, `__driver` in `start.ts`); single-underscore distinguishes "cockpit-role" from "placeholder" | Low — convention bake-in |
| Why hyphen and not space in `<emoji>-<member>` | Shell-quoting safety + regex-friendliness + tab-completion + symmetric with existing hyphenated names; same visual rhythm as space without the parsing cost | Medium — flip is one buildWindowName line + migration shim |
| Why in-place rename and not kill+respawn | Preserves pane PIDs, attached clients, scroll history; operator workflow continues uninterrupted | High — kill+respawn is destructive; in-place is the only safe path |

## Consequences

- **One-commit-family change set** — `src/schema/cockpit.ts` (default + deprecated-alias), `src/verbs/cockpit.ts` (window-name constants + migration shim), `src/core/common.ts` (`buildWindowName` hyphen), `src/verbs/start.ts` (member-window migration shim — uses new buildWindowName transparently), `src/verbs/cron-install.ts` (emitted cron line rewrites). Test fixtures across `tests/unit/verbs/cockpit.test.ts` and `tests/unit/verbs/start.test.ts` update for new naming.
- **Operator zero-disruption** — in-place `rename-session` + `rename-window` preserve attached clients. The cockpit reattach + per-team `atmux start` next-run apply migration silently.
- **No state-file migration** — `~/.atmux/cockpit.json` field is value-level (a string literal), not key-level; legacy value accepted with warning during the deprecation window per D5.
- **Reversibility** — flip back is one default change + one buildWindowName line; the migration shim's idempotency makes "what's the current name" the source of truth, not "what's the config say".
- **Cross-references**: ADR-063 (cockpit verb), ADR-046 (cockpit session naming origin), ADR-077 (medic role), ADR-132 (martinet role), ADR-133 (medic rename precedent for D2 underscore-prefix migration shape), ADR-017 (buildWindowName origin).

## Cross-references

- ADR-063 — cockpit verb port + original `atmux_teams` session naming. Gains annotation header pointing here.
- ADR-077 — medic role (originally superdoctor). Window name `_medic` per D2.
- ADR-132 — pluggable martinet. Window name `_martinet` per D2.
- ADR-133 — medic rename (TR2/TR3 already landed). Same backward-compat shim shape (D5) reused here for session/window scope.
- ADR-017 — buildWindowName naming origin. Hyphen separator per D3 amends the format.
- ADR-046 — original cockpit session naming (historical; pre-dates the docs/adr/ tree's current numbering).
- `src/core/common.ts::buildWindowName` — function the D3 change lands in.
- `src/verbs/cockpit.ts` rebuild handler — D4 migration shim lands here.
- `src/verbs/start.ts` reconcile path — member-window D4 migration shim lands here.
- `src/verbs/cron-install.ts` — D6 emitted cron-line rewrite lands here.

## Out of scope

- **Renumbering colliding ADR-088 files** — ~~two ADR-088 files exist on diverged branches (`088-worktree-submodule-init.md` + `088-per-member-branch-fan-in.md`); separate cleanup Task per atmux CLAUDE.md "Single ADR tree per project" convention. Not blocking this ADR.~~ **Resolved 2026-05-18 via t-88da6978**: per-member-branch fan-in renumbered to ADR-179; submodule-init retains ADR-088. Sibling ADR-087 collision (whip-velocity-gate vs atmux-stop-soft) also resolved same day via t-fe51cf64 (velocity-gate → ADR-177).
- **Operator dotfiles cockpit-skill rename surfaces** — ADR-133 TR8 (`~/.claude/skills/superdoctor/ → medic/`) is the precedent; if a parallel cockpit-skill exists for `cockpit-session` it gets a sibling driver-only TR. Out of repo scope per ADR-133 §D3.
- **Hot-rename of arbitrary member names** — ADR-136 covers the id-vs-label split for live-team member renames. ADR-135 only touches the *format* of `<emoji><member>` window names, not member identity.
- **Window-order changes** — D2 only renames; window indices stay (W1=_superdriver, W2=_medic, W3=_martinet, W4..N=team viewers). Order changes belong to a follow-up ADR if needed.

## Amendments

### 2026-05-16 — Socket isolation added (ADR-162)

[ADR-162](162-atmux-owns-tmux-infrastructure.md) extends the cockpit naming convention from **session-name isolation** to **socket isolation**. The cockpit moves from the operator's default tmux socket (`tmux ...`) to a dedicated named socket (`tmux -L atmux-cockpit ...`). The `cockpitSession: "atmux_cockpit"` session name (this ADR's §Decision) is unchanged — `atmux-cockpit` becomes the SOCKET name AND `atmux_cockpit` stays the SESSION name on that socket.

Per-team sockets remain on the existing cage-tier `-S <team-root>/.atmux/tmux/tmux-0/default` path per [ADR-058](058-cage-tier-isolation.md) — unaffected by ADR-162. The `_-prefix` window-name format from this ADR's §D2 / §D3 is preserved verbatim on the new socket; ADR-162 §Decision-anchor #3's `automatic-rename off` in `templates/tmux/atmux.conf` is what protects the `_-prefix` contract from tmux's auto-rename stomping.

The migration verb `atmux cockpit migrate-socket` (ADR-162 TR3) handles existing operators: it discovers legacy `atmux_cockpit` (or pre-this-ADR `atmux_teams`) sessions on the default socket and recreates them on the dedicated socket. Process state is NOT transferred (tmux primitives can't re-bind PIDs across servers — documented in [ADR-162 §Amendment 2026-05-16](162-atmux-owns-tmux-infrastructure.md#2026-05-16--decision-anchor-4-mechanism-graceful-recreate-not-pid-preservation-t-26346aef-tr3-impl)); scrollback is preserved as a breadcrumb file. Cron-spawned cockpit roles re-establish on the next tick. See [`docs/RUNBOOK-cockpit.md`](../RUNBOOK-cockpit.md) §2 for the operator-facing flow.

This ADR-135 file remains unmodified above the `## Amendments` header (append-only convention). The decisions documented in §D2 (`_-prefix` window names) and §D3 (`<emoji>-<member>` hyphen format) are still operative — ADR-162 layers socket isolation underneath without superseding the naming format.

### 2026-05-17 — ADR-161 supersedes D3 for default in-team members

[ADR-161](161-default-member-prefix-and-sort-verbs.md) §Part B extends this ADR's §D2 `_-prefix` convention one level down — to **in-team default members**. Pre-ADR-161, §D3 specified `<emoji>-<member>` (hyphen separator) for every in-team window. Post-ADR-161:

- **Default in-team members** (`role` in `["team-lead", "planner", "reviewer", "ombudsman"]`; `committer` joins once ADR-159 ships) render `${emoji}_${label}` — underscore as both prefix marker and separator, matching the cockpit-tier convention.
- **User-added in-team members** (any other `role`, typically `"member"`) keep `${emoji}-${label}` (hyphen separator per this ADR's §D3 — still operative for the non-default branch).

§D3 is **partially superseded** for the default-role branch; it remains the canonical form for user-added members. The split lives in `src/core/common.ts::buildWindowName(name, emoji, label, role)` as a role-aware format check (per ADR-161 §Decision-anchor #2). Both shapes coexist in production code — `isMemberWindowName` and `resolveExistingWindowName` accept either form during the multi-release migration window.

ADR-161 §Part C also adds the `atmux member move | swap | sort` verb suite for operator-controlled tmux-window ordering. Each verb preserves PIDs + attached clients + claude-process state via `tmux move-window` / `tmux swap-window` orchestration (mirrors this ADR's §D4 in-place rename pattern). See [ADR-161 §Amendment 2026-05-17](161-default-member-prefix-and-sort-verbs.md#2026-05-17--tr3-shipped-atmux-member-move--swap--sort-verbs-t-2f6c81d3-be-1) for TR3 ship details.
