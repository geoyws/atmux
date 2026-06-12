# ADR-162: atmux owns its tmux infrastructure — cockpit-socket isolation + canonical tmux.conf + version-check

**Status**: accepted
**Date**: 2026-05-16
**Driver-ref**: 2026-05-16 driver session — operator: "atmux should not clobber the user's default tmux." Audit found 3 gaps in current isolation posture.
**Parent EPIC**: t-0b15d199 (this ADR is the umbrella; sub-tasks TR1-TR6 filed in same session per [[feedback_decomp_same_session_with_deps]]).
**Cross-refs**: ADR-058 (cage-tier isolation — per-team sockets already in place), ADR-135 (cockpit naming convention — `atmux_cockpit` session name; this ADR adds matching socket isolation), ADR-138 (verified send-keys — the version-check protects the verifier contract). ADR-163 (bundled tmux binary) closes the deferred §Part C v2 carve-out.

## Context

### What's already isolated (audit 2026-05-16)

atmux's per-team isolation is already in good shape: `src/abstractions/tmux.ts:347` resolves every team operation through `tmux -S <team-root>/.atmux/tmux/tmux-0/default`. Each team's tmux server lives in its own socket, namespaced under the team's root directory. ADR-058's cage-tier guarantees hold at the team layer — atmux operations against `team-foo` cannot accidentally clobber a session belonging to `team-bar`, and neither can clobber the operator's personal tmux server outside atmux.

### What's NOT isolated — three gaps

Three audit findings, all surface defects the operator hit chat-time:

1. **Cockpit runs on the default socket.** `src/verbs/cockpit.ts:572` (Phase 5 — "cockpit session on default socket"), `src/verbs/status.ts:388`, and `src/verbs/start.ts:965` all factory `{ socket: "default" }` for cockpit-side operations. A first-time user running `atmux cockpit start` walks into windows landing in their **own** tmux server (the default socket their `tmux` invocation talks to). atmux's `atmux_cockpit` session name (per ADR-135) doesn't isolate the socket — it isolates the session-name. If the operator has their own tmux server running on the default socket, atmux's cockpit windows show up alongside their personal windows. Worst-case foot-gun: a `tmux kill-server` from the operator wipes atmux's cockpit alongside their personal state.

2. **No shipped tmux.conf.** atmux's tmux invocations inherit the operator's `~/.tmux.conf` by default. User configs vary wildly — prefix-key rebinds, mouse on/off, status-line formatters, window-name auto-rename, history-limit values, base-index conventions. Some user configs break atmux's window-naming assumptions (e.g. `set -g automatic-rename on` will overwrite atmux's emoji-prefix window names per ADR-135). Some break send-keys assumptions (e.g. a custom escape-time of `0ms` interferes with multi-keystroke sequences). atmux has no canonical baseline that guarantees the runtime contract.

3. **No tmux version-check.** atmux uses whatever `tmux` the operator's system provides — `tmux 3.6a` on hax, but no guarantee elsewhere. The verifier contract in ADR-138 relies on specific `capture-pane` output format + specific `display-message` semantics that have drifted across tmux 3.x. A tmux 3.0 user (Debian buster) gets silent verifier breakage. A future tmux 4.x user could break the `buildWindowName` formatter from ADR-135. No min-version check, no warn-on-drift, no canary surface.

### Why bundle the fix into one ADR

All three gaps share a root cause: **atmux doesn't own enough of its own tmux infrastructure**. They also share remediation primitives — a canonical socket name + a shipped conf file + a version probe land as siblings in the same release cycle. Splitting them into three ADRs creates coordination drag without coordination benefit. ADR-162 bundles the fix; ADR-163 (bundled binary) is the deferred v2 of §Part C below.

### Why NOT bundled-binary in this ADR

The bundled-binary work is heavy: per-platform builds, GitHub-release artifact pipeline, SHA-256 manifest, postinstall fetch, atomic-symlink swap. ADR-162 needs to ship as a foundation for the rest of the operator's bundled-tmux ask — getting the cockpit socket fixed + the canonical conf shipped is the load-bearing part. The version-check warn-probe in §Part C is the canary; ADR-163 promotes it to refusal once the bundled binary lands.

## Decision

Five §Decision-anchor lines first, then prose around each subsystem.

> **§Decision-anchor #1** — **Cockpit moves to a dedicated socket: `tmux -L atmux-cockpit`.** Every `factory({ socket: "default" })` call-site for cockpit-side operations refactors to `factory({ socket: "atmux-cockpit" })`. The `-L <name>` socket form (named socket; tmux resolves to `/tmp/tmux-<UID>/atmux-cockpit`) is preferred over `-S <path>` for the cockpit because operators can reach it via `tmux -L atmux-cockpit attach` without remembering a custom path. Matches ADR-135's `cockpitSession: "atmux_cockpit"` naming — socket + session both bear the `atmux-cockpit`/`atmux_cockpit` brand. Per-team sockets stay on the existing `-S <team-root>/.atmux/tmux/tmux-0/default` path (no change to ADR-058 cage-tier topology).

> **§Decision-anchor #2** — **Canonical `templates/tmux/atmux.conf` loaded via `-f <path>` on EVERY atmux session creation.** Both cockpit (atmux-cockpit socket) and per-team (per-team-root socket) sessions load this file as their tmux.conf. The operator's personal `~/.tmux.conf` is NEVER loaded by atmux invocations — explicit `-f` flag closes the inheritance path. Operator override: `ATMUX_TMUX_CONF=<path>` env var points at a custom conf file. The conf ships in the npm package at `templates/tmux/atmux.conf` and is installed alongside the binary per ADR-047 install topology — resolution at runtime walks `/opt/atmux/current/templates/tmux/atmux.conf` (or the dev-checkout path during development).

> **§Decision-anchor #3** — **Canonical tmux.conf settings** (8 baseline options):
> - `set -g status on` — atmux owns the status-line.
> - `set -g mouse on` — operator convenience.
> - `set -g history-limit 100000` — capture-pane scrollback for whip / poke / sentinel observation per ADR-138.
> - `set -g default-terminal "tmux-256color"` — color stability across operator terminals.
> - `set -g allow-rename off` AND `set -g automatic-rename off` — atmux OWNS window names per ADR-135's `buildWindowName` formatter; no tmux-side override.
> - `set -g base-index 1` — consistent with current ADR-082/084 worktree-isolation conventions.
> - `set -g escape-time 50` — responsive but doesn't break esc-sequence emoji rendering on cockpit window-name display.
> - Prefix key: keep tmux default `C-b` (no surprise for operators who attach directly via `tmux -L atmux-cockpit attach`).
>
> The conf intentionally LOADS NOTHING from `~/.tmux.conf` (no `source-file` line). Operator override comes via `ATMUX_TMUX_CONF`, not via opportunistic inclusion. A `source-file -q <user-override>` extension is reserved for ADR-163 when the user-override path becomes part of the bundled-binary story.

> **§Decision-anchor #4** — **One-shot cockpit-socket migration via `atmux cockpit migrate-socket` verb.** Existing operators have cockpit sessions on the default socket today; the migration must NOT require them to lose context. The verb:
> 1. Discovers existing cockpit windows on default socket (filter by `atmux_cockpit` session name OR window-name prefix).
> 2. Detaches each window's running process (atmux's lead/canary/martinet panes); does NOT kill the processes — they keep running.
> 3. Creates a fresh atmux-cockpit-socket session.
> 4. Re-attaches each running process to its new home on the atmux-cockpit socket via tmux's pane-respawn primitive.
> 5. Cleans up the legacy default-socket windows (after confirming the re-attach succeeded).
>
> Idempotent — re-running on an already-migrated cockpit is a no-op. Operator runs once at upgrade time; doctor probes warn if migration is needed (§Decision-anchor #5).

> **§Decision-anchor #5** — **Two new doctor probes** (warn-class, non-blocking):
> - `tmux-version-mismatch` — runs `tmux -V` (via the version-pinned tmux when bundled per ADR-163, otherwise PATH-resolved). Compares against atmux's tested range (currently min 3.2, tested-against 3.6a). Warn-class `🟡 host tmux version X.Y below minimum 3.2` or `🟡 host tmux version Z.W untested above 3.6a`. Doesn't block atmux operations; surfaces the drift before it bites.
> - `cockpit-on-default-socket` — discovers any session matching `atmux_cockpit` on the default socket (legacy state). Warn-class `🟡 legacy cockpit session detected on default socket; run 'atmux cockpit migrate-socket' to move it to the dedicated socket`. Self-clearing after migration completes.
>
> Both probes emit JSON-structured findings on `atmux doctor --json`; both warn-class only (operator can ignore). Doctor's existing red-class gates are untouched.

### §Part A — cockpit socket isolation

**Call-sites to refactor** (per audit):

| File | Site | Current | After |
|------|------|---------|-------|
| `src/verbs/cockpit.ts` | Phase 5 session create (~L572) | `factory({ socket: "default" })` | `factory({ socket: "atmux-cockpit" })` |
| `src/verbs/status.ts` | cockpit-pane queries (~L388) | `factory({ socket: "default" })` | `factory({ socket: "atmux-cockpit" })` |
| `src/verbs/start.ts` | cockpit-bootstrap path (~L965) | `factory({ socket: "default" })` | `factory({ socket: "atmux-cockpit" })` |
| Plus any other `factory({ socket: "default" })` call-site that touches cockpit (locate via grep `socket: "default"` in `src/verbs/`) | — | — | — |

The refactor is mechanical but exhaustive — grep + verify. Any default-socket call-site that ISN'T cockpit-related stays (e.g. operator-facing diagnostic verbs that intentionally probe the operator's default socket).

**Socket choice — `-L atmux-cockpit` vs `-S <path>`**:

- `-L <name>` resolves to `/tmp/tmux-<UID>/<name>` per tmux convention; operator-discoverable via `tmux -L atmux-cockpit attach`.
- `-S <path>` requires the operator to remember the full path.
- Cockpit is operator-facing (operator attaches into it to drive); `-L` wins on discoverability.
- Per-team sockets stay on `-S` because they're cage-tier (operator rarely attaches directly; ADR-058's isolation model expects explicit path).

### §Part B — canonical tmux.conf

**File location**: `templates/tmux/atmux.conf` (in-repo, shipped via npm `files` array — coordinate with ADR-163 T2's install-path resolver). At runtime, atmux resolves to:

```
${atmuxRoot}/templates/tmux/atmux.conf
```

where `${atmuxRoot}` is `/opt/atmux/current/` per ADR-047 install topology, or the dev checkout's repo root during development.

**Load mechanism**: every session-creation call passes `-f <conf-path>`:

```sh
tmux -L atmux-cockpit -f ${atmuxRoot}/templates/tmux/atmux.conf new-session -d -s atmux_cockpit ...
tmux -S <team-root>/.atmux/tmux/tmux-0/default -f ${atmuxRoot}/templates/tmux/atmux.conf new-session ...
```

The `-f` flag is per-invocation; tmux DOES NOT load it as a default for future invocations. Every atmux call-site that creates a session or window MUST pass `-f` — this is enforced via the `TmuxConfig.configFile` field per ADR-097's discriminated union (already exists; this ADR pins it for production callers).

**Operator override** via `ATMUX_TMUX_CONF`:
- When set, the resolver returns the env-var value verbatim.
- When unset, returns the canonical `${atmuxRoot}/templates/tmux/atmux.conf` path.
- Override is for operators with legitimate need (e.g. wanting `mouse off`); shipped conf is the supported default.

**Why no `source-file ~/.tmux.conf`**:
- Opportunistic loading is unpredictable — operator configs vary too widely.
- An override env var gives operators a clean opt-in path; opportunistic load gives them an opt-OUT they can't easily exercise.
- ADR-163 may eventually layer a `source-file -q ~/.config/atmux/tmux.conf.local` line for user overrides; ADR-162's conf doesn't include it (forward-compat — ADR-163 wires that path).

### §Part C — tmux version-check (warn) + bundled-binary deferred to ADR-163

**v1 — warn-probe** (this ADR):

`atmux doctor` adds the `tmux-version-mismatch` probe. Reads `tmux -V`, parses the version string, compares against the tested-range constants:

```ts
const TMUX_MIN_VERSION = "3.2";       // below this: warn
const TMUX_TESTED_VERSION = "3.6a";   // exact tested-against; above triggers untested-version warn
```

Warn-class emit shape (mirrors existing doctor JSON output):

```json
{
  "kind": "tmux-version-mismatch",
  "severity": "warn",
  "actual": "3.0a",
  "min": "3.2",
  "tested": "3.6a",
  "hint": "Below minimum; atmux's send-keys verifier (ADR-138) may break. Bundled tmux available via ADR-163."
}
```

Doctor doesn't block atmux operations; just surfaces the drift on every `atmux doctor` run. Operator decides whether to act.

**v2 — bundled binary deferred to ADR-163** (forward-ref):

The proper fix is shipping atmux's own tmux binary so the version is pinned by atmux. ADR-163 closes this gap with vendored binaries (linux-x64/arm64 + darwin-x64/arm64) + version-lock v2 refusal at team-spawning verbs. ADR-162's warn-probe is the canary that motivates ADR-163's enforcement; once ADR-163 lands, the warn-probe stays (for operators using the `ATMUX_USE_HOST_TMUX=1` escape hatch).

The carve-out boundary: ADR-162 ships the audit-finding fix + warn surface. ADR-163 ships the structural fix (own binary). No overlap; clean handoff.

### §EPIC-done definition (canonical for this ADR's decomp)

ADR-162 completes when ALL of:

1. TR1 lands — this ADR commits + pushes (greenfield-verified pre-flight).
2. TR2 lands — every cockpit-side `factory({ socket: "default" })` call-site refactored to `"atmux-cockpit"`; unit tests cover the new socket threading.
3. TR3 lands — `atmux cockpit migrate-socket` verb shipped + e2e proves migration preserves window contents.
4. TR4 lands — `templates/tmux/atmux.conf` shipped + loaded via `-f` flag on every session creation (cockpit + per-team) + unit tests verify the load.
5. TR5 lands — `tmux-version-mismatch` + `cockpit-on-default-socket` doctor probes + unit tests.
6. TR6 lands — RUNBOOK + ARCHITECTURE + CHANGELOG doc sweep + ADR-135 §Amendment annotation citing this ADR.

## Consequences

### What this ADR enables

- **First-time-user UX**: `atmux cockpit start` on a fresh machine creates the session on the dedicated socket. The operator's personal default-socket tmux is untouched. The OSS-contributor foot-gun closes.
- **Deterministic baseline**: every atmux session loads atmux.conf. Operator config drift can't break atmux's window-name + send-keys contracts. ADR-138 verifier contracts hold across hosts.
- **Migration path for existing operators**: `atmux cockpit migrate-socket` preserves running processes; no need to nuke + restart cockpit panes.
- **Canary for ADR-163**: the warn-probe surfaces version drift before it bites. ADR-163 promotes it to refusal once the bundled binary makes refusal actionable.

### What this ADR does NOT cover

- **Bundled tmux binary**: deferred to ADR-163 §Decision-anchor #1.
- **Version-lock refusal** (not just warn): deferred to ADR-163 §Decision-anchor #4.
- **User-override conf path** (`~/.config/atmux/tmux.conf.local`): deferred to ADR-163 §Decision-anchor #2 — ADR-162's atmux.conf intentionally doesn't `source-file` it.
- **Per-team socket name changes**: out of scope. Per-team sockets stay on the existing `-S <team-root>/.atmux/tmux/tmux-0/default` path (ADR-058 cage-tier). Only cockpit moves.
- **Tmux 4.x feature-flag detection**: out of scope. The version-mismatch probe is integer-version range; nuanced feature-flag detection ships separately if needed.

### Rollback path

- **Cockpit socket**: set `ATMUX_COCKPIT_SOCKET=default` env var (NEW — escape hatch for operators who explicitly want the old behavior). Doctor warn-probe still fires; operator acknowledges + ignores.
- **tmux.conf override**: `ATMUX_TMUX_CONF=/dev/null` returns to stock tmux defaults. Window-naming may break (ADR-135 contract requires `automatic-rename off`); operator-acknowledged risk.
- **Doctor probes**: warn-class only; no doctor flag exists to suppress them. Operators ignore the warning.

### Reuse statement

Per ADR-090's reuse-statement pattern — minimal new abstractions:

- Tmux socket abstraction: `TmuxConfig.socket` field (ADR-097 — already exists; this ADR adds a new literal value `"atmux-cockpit"`).
- Tmux configFile threading: `TmuxConfig.configFile` (ADR-097 — already exists; this ADR pins it for production callers).
- Migration verb pattern: mirrors ADR-135 D4 in-place rename pattern (preserves PIDs + attachments).
- Doctor probe shape: existing JSON output convention; two new probes additive.
- NEW abstraction: `src/core/tmux-paths.ts` (or similar — locate via grep) — resolves `getAtmuxTmuxConfPath()` + `getCockpitSocketName()` from one place.

### What breaks (nothing in v1)

- Existing operators on legacy cockpit-on-default-socket setups keep working until they run `atmux cockpit migrate-socket`. Doctor warns; no force-migration.
- Existing scripts that attach to `tmux attach -t atmux_cockpit` (no `-L` flag) on the default socket continue to find the legacy session until migration. Post-migration, those scripts need `tmux -L atmux-cockpit attach`.
- Operator personal `~/.tmux.conf` no longer leaks into atmux sessions. If an operator relied on a personal binding from `~/.tmux.conf` (e.g. a custom prefix), they need to set `ATMUX_TMUX_CONF=~/.tmux.conf` to keep that behavior — or migrate the binding into the dotfiles flow per [[feedback_claude_skills_dotfiles_territory]] (if it touches the atmux skill set).

## Open questions

1. **Backward-compat for the legacy cockpit on default socket** — how long do we keep the migrate-socket verb + the warn-probe? **Planner recommendation**: keep both for at least one minor-version cycle (0.8.x → 0.9.x). Doctor's warn-probe self-clears after migration, so cost is low. Reviewer can flip at signoff if they prefer faster deprecation.

2. **`-L` vs `-S` for cockpit** — could go either way (operator-attachability vs path-explicit). **Planner recommendation**: `-L atmux-cockpit` for cockpit operator-discoverability (`tmux -L atmux-cockpit attach` is muscle memory). `-S` stays for per-team cage-tier sockets where path-explicit is the safety contract.

3. **Should `cockpit-on-default-socket` probe also detect partial migrations** — i.e. cockpit windows split across both sockets? **Planner recommendation**: NO for v1. The probe checks "any session matching `atmux_cockpit` on default" — that's the canary; partial-migration recovery is operator-handed via the migrate-socket verb (which is idempotent). If partial migrations become common, file a follow-up Task to deepen the probe.

4. **tmux.conf prefix key** — should we change from `C-b` default? **Planner recommendation**: NO. Changing the prefix surprises operators who attach directly. If operators want a custom prefix, they set `ATMUX_TMUX_CONF` to a custom conf.

## Cross-references

- [ADR-047](047-canonical-install-topology.md) — install topology (`/opt/atmux/<version>/`); atmux.conf path resolved against `${atmuxRoot}`.
- [ADR-058](058-cage-tier-isolation.md) — cage-tier isolation; per-team sockets already on cage-tier; this ADR adds cockpit-level socket isolation.
- [ADR-097](097-tmux-abstraction.md) — `TmuxConfig` discriminated union with `socket` + `configFile` fields; both consumed here.
- [ADR-135](135-cockpit-naming-convention.md) — `cockpitSession: "atmux_cockpit"` + `_-prefix` window naming; this ADR adds the matching socket. Append a §Amendment annotation citing ADR-162.
- [ADR-138](138-verified-send-keys.md) — verified send-keys; the version-check protects the verifier contract from tmux-version drift.
- [ADR-163](163-bundled-tmux-binary.md) — bundled tmux binary + version-lock v2; closes the deferred §Part C v2 carve-out. Forward-ref; ADR-163 ships in the same release cycle or the next.
- Driver-ref: 2026-05-16 driver session — operator chat-time decision on cockpit-socket isolation + canonical tmux.conf.
- Memory [[project_atmux_socket_isolation_state.md]] — current-state audit findings.
- Project [CLAUDE.md](../../CLAUDE.md) §Docs Discipline + §Testing Discipline.

## Amendments

### 2026-05-18 — `atmux cockpit rotate <session-name>` formalizes Rung C (ADR-167)

[ADR-167](167-cockpit-rotate-verb.md) lands `atmux cockpit rotate medic|sentinel|<team-name>` as the canonical Rung C verb of the `/bruh` escalation chain — closing the previously manual handoff + Ctrl-C + canonical-respawn protocol. Sits within ADR-162's scope (atmux owns cockpit tmux infrastructure): the verb operates exclusively on `tmux -L atmux-cockpit` per §Decision-anchor #1, and uses the existing cockpit window topology (`_medic` / `_sentinel` / `<team-name>` per ADR-135) as its target surface. Lead panes are untouched (they live in per-team cages per ADR-162) — lead rotation continues to use Rung B (medic's `/team rotate-lead`).

Operationally relevant interactions with ADR-162:

- **Socket isolation honored**: cockpit-rotate's tmux factory call resolves the cockpit socket via `getCockpitSocketName(env)` — same resolver path as `cockpit rebuild`. Operators on a pre-migration legacy cockpit (default socket) must run `atmux cockpit migrate-socket` first; `cockpit rotate` against a legacy-socket cockpit will not find the target window.
- **Audit log**: rotations append NDJSON rows to `~/.atmux/state/cockpit-rotate-audit.log` (operator-fired growth, bounded; no rotation policy in v1).
- **Discord refusal**: pre-flight gate refusals (gates 1-4 per ADR-167) fire the `cockpit-rotate-refused` Discord template; success rotations are quiet (audit row is the source of truth).
- **Caller-scope gate**: cockpit-rotate is driver-only per ADR-033, consistent with `spawn-epic` / `dissolve-epic` / `migrate-socket`. Member-scope callers are refused with `ConfigError` (exit 78 EX_CONFIG).

EPIC `e-0b90d6ac` code-complete 2026-05-18 with full test coverage (T6 unit + T7 e2e). [RUNBOOK-cockpit.md §3](../RUNBOOK-cockpit.md) carries the operator-facing flow.

### 2026-05-16 — §Decision-anchor #4 mechanism: graceful-recreate, NOT PID-preservation (t-26346aef TR3 impl)

The §Decision-anchor #4 step 4 ("Re-attaches each running process to its new home on the atmux-cockpit socket via tmux's pane-respawn primitive") **does not match what tmux can actually do**. The TR3 implementation surfaces the honest mechanism + the operator-side acceptance:

**What tmux can't do.** Cross-server pane-process transfer. A pane's PID is bound to a PTY the source tmux server owns; tearing down the pane either SIGHUPs the process or leaves it as a stdio-less orphan. `tmux respawn-pane -k` literally kills the existing process. `tmux move-window` is single-server-only — it can't cross sockets. PTY reparenting tools (e.g. `reptyr` via ptrace) DO exist but are heavy external dependencies atmux doesn't carry; bundling them would multiply the install surface for a one-shot migration verb.

**What the verb DOES** (graceful-recreate):

1. **Discovery** — list sessions on `tmux -L default`; filter to `LEGACY_COCKPIT_SESSION_NAMES = ["atmux_cockpit", "atmux_teams"]`. Zero matches = already migrated, return 0.
2. **Capture** — for each matched session/window, snapshot up to 3000 lines of scrollback via `pane.capturePane`. Non-destructive on the legacy socket.
3. **Recreate session** — `tmux -L atmux-cockpit new-session -d -s atmux_cockpit ...`. Additive: if the target session already exists (partial-migration recovery or sibling cockpit), windows already on the target are preserved; the migration only adds missing windows by name.
4. **Recreate windows** — preserve window names + relative order; empty shell panes (no process re-bind).
5. **Breadcrumb** — write captured scrollback to `/tmp/atmux-cockpit-migrate-<epoch>.log`. Operator `cat`s the file to recover prior visual context (Claude conversation tails, etc.) before re-invoking processes in the new panes.
6. **Cleanup** — `tmux -L default kill-session -t <legacy-name>`. Skipped under `--keep-legacy`; legacy + new cockpit coexist until operator manually nukes.

**Why this is acceptable.** Most cockpit panes are cron-spawned roles (medic / martinet / sentinel) — they're stateless across ticks and re-establish themselves on the next cron firing. The only state-bearing panes are operator-driven (e.g. an active superdriver Claude conversation), and those operators are the same people invoking `atmux cockpit migrate-socket` consciously — they accept the re-invoke cost in exchange for the socket-isolation foot-gun closure. `--dry-run` lets them preview before commit; `--keep-legacy` lets them migrate gradually.

**What's preserved across the migration**: window names, relative window order, ADR-135 `_-prefix` convention, scrollback (as visual breadcrumb only). **What's lost**: live process state in each pane (Claude conversation context, REPL state, mid-edit buffers). Operator-acknowledged trade-off.

**§Decision-anchor #4 step 4 — restated**: *"Recreates each window on the dedicated socket as an empty pane; captured scrollback is written to a breadcrumb file the operator reads to recover visual context. Process state is not transferred (tmux primitives don't support cross-server pane-PID re-binding)."*

The original §Decision-anchor text is preserved as authored (append-only ADR convention). This amendment IS the operative description of TR3's behavior.

### 2026-05-16 — TR3 e2e deferred to follow-up Task

The TR3 task body called for a real-tmux ephemeral-socket e2e (spin up a cockpit on default socket, run migrate-socket, assert windows present on atmux-cockpit + default socket has no residue + scrollback breadcrumb exists). The TR3 ship covers all 6 phases via mock-driven unit tests (~96% line coverage) including the deliberate graceful-recreate mechanism, but defers the real-tmux e2e to a sibling Task. The unit-mock coverage narrows the e2e surface to "happy-path on real tmux" — discovery/capture/recreate/cleanup are all exercised at the abstraction boundary. Reviewer may request the e2e before final signoff.


## §Amendment 2026-05-20 — promoted to accepted (status-drift audit T4)

Promoted from `proposed` → `accepted` per [docs/audits/adr-status-drift-audit-2026-05-20.md](../audits/adr-status-drift-audit-2026-05-20.md) (sha=a6f1541). Code-refs + git-log refs both present at audit time confirming shipped + dogfooded status; the `proposed` marker was bookkeeping debt. Original Date preserved verbatim. Append-only — see Status field for the canonical flip; this §Amendment carries the audit traceability.

**Filed via** t-45b401c3 (T4 sweep, 2026-05-20).

## §Amendment 2026-06-05 — epic-team-children failure mode + structural guard (ADR-252)

This ADR's socket-isolation goal (§Part A) was meant to also protect a parent team's spawned epic-team children, which materialise at `/tmp/atmux-<parent>/epics/<epicId>/tmux-<uid>/default`. A gap surfaced 2026-05-17: when a parent team stayed on the **legacy** socket path (never ran `cockpit migrate-socket`), `/tmp/atmux-<parent>/` existed ONLY because of its children. A cleanup probe that checked only the *parent* socket for liveness found it dead, declared the dir an orphan, and wiped it wholesale — taking the live epic-team children with it (the exact class this ADR was supposed to foreclose for the cockpit, now seen for epic children). See **[ADR-252](252-epic-cage-children-removal-guard.md)** for the structural defense: `hasLiveEpicChildren()` descends into `<parentTmpdir>/epics/*` and refuses any parent-tmpdir removal while a child cage socket is live (fail-SAFE on uncertainty). Resolves P0 **t-65bec10b**. The long-term intent here stands: every team migrating to its dedicated `/tmp/atmux-<team>/` socket makes the legacy-path trap impossible by construction; ADR-252 guards the class until that migration is universal.
