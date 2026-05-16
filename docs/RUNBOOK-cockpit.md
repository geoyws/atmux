# RUNBOOK — `atmux cockpit` (socket + tmux.conf isolation)

Operator-facing reference for the atmux cockpit: where its tmux server lives, what conf it loads, how to migrate from legacy setups, and which doctor probes guard the topology. See [ADR-162](adr/162-atmux-owns-tmux-infrastructure.md) for the rationale.

The cockpit is the operator's window into every enabled team. It runs on a tmux server isolated from the operator's personal default-socket tmux server; it loads a canonical `atmux.conf` ignoring `~/.tmux.conf`; and atmux ships a one-shot migration verb for operators upgrading from a pre-ADR-162 install.

## §1 — Cockpit socket isolation

The cockpit binds to a dedicated named tmux socket: **`tmux -L atmux-cockpit`**. Per [ADR-162 §Decision-anchor #1](adr/162-atmux-owns-tmux-infrastructure.md), every cockpit factory call-site (`src/verbs/cockpit.ts` reconcile, `src/verbs/status.ts` cockpit-pane queries, `src/verbs/start.ts` cockpit-bootstrap path) builds against this socket. Operators reach the cockpit via:

```bash
tmux -L atmux-cockpit attach -t atmux_cockpit
```

The session name (`atmux_cockpit`) stays consistent with [ADR-135](adr/135-cockpit-naming-convention.md); only the socket moved. Per-team sockets remain on the cage-tier path (`-S <team-root>/.atmux/tmux/tmux-0/default`) per [ADR-058](adr/058-cage-tier-isolation.md) — that layer is untouched.

**Verify isolation:**

```bash
# Default socket should NOT have atmux residue
tmux -L default list-sessions 2>&1 | grep -i atmux  # expect empty

# Cockpit lives on its own socket
tmux -L atmux-cockpit list-sessions  # expect: atmux_cockpit
```

**Why this matters:** before ADR-162, atmux cockpit windows landed in the operator's own tmux server. A stray `tmux kill-server` from the operator wiped both their personal state AND atmux's cockpit. The socket-isolation closes that foot-gun.

## §2 — Migration from legacy default-socket cockpit

Existing operators upgrading from a pre-ADR-162 install have their cockpit on the default socket today. Run the one-shot migration verb:

```bash
# Preview first (no mutation)
atmux cockpit migrate-socket --dry-run

# Commit when the preview looks right
atmux cockpit migrate-socket

# Safety-conscious variant — keep legacy + new in parallel
atmux cockpit migrate-socket --keep-legacy
# (decide when to nuke legacy yourself: tmux kill-session -t atmux_cockpit)
```

**Six phases** ([ADR-162 §Decision-anchor #4 amendment 2026-05-16](adr/162-atmux-owns-tmux-infrastructure.md#2026-05-16--decision-anchor-4-mechanism-graceful-recreate-not-pid-preservation-t-26346aef-tr3-impl)):

1. **Discovery** — list legacy cockpit sessions on the default socket (`atmux_cockpit` canonical + `atmux_teams` pre-ADR-135).
2. **Capture** — snapshot up to 3000 lines of scrollback per window. Non-destructive on the legacy socket.
3. **Recreate session** — `tmux -L atmux-cockpit new-session -d -s atmux_cockpit`. Additive: if the target already exists (partial migration recovery), windows merge by name.
4. **Recreate windows** — preserve names + relative order; empty shell panes (no PID re-bind — see §Process-preservation below).
5. **Breadcrumb** — write scrollback to `/tmp/atmux-cockpit-migrate-<epoch>.log`. `cat` the file to recover visual context.
6. **Cleanup** — `tmux kill-session -t <legacy-name>` on the default socket. Skipped when `--keep-legacy` is set.

**Process-preservation — honest answer.** The chosen mechanism is **graceful-recreate, NOT PID-preservation**. tmux primitives can't transfer a pane's process between servers — the PID is bound to a PTY the source tmux server owns. ptrace-based reparenting tools (e.g. `reptyr`) exist but atmux doesn't bundle them. The operator-side trade-off:

- **What's preserved:** window names, relative window order, [ADR-135](adr/135-cockpit-naming-convention.md) `_-prefix` convention, scrollback (as visual breadcrumb only).
- **What's lost:** live process state in each pane (Claude conversation context, REPL state, mid-edit buffers).

Cron-spawned cockpit roles (medic / martinet / sentinel) re-establish themselves on the next cron tick — they're stateless across ticks, no operator action needed. The only state-bearing panes are operator-driven (a `superdriver` Claude conversation, an ad-hoc shell). Operators re-invoke those in the new panes; the breadcrumb file gives them visual context to recover from.

**Idempotent.** Re-running `atmux cockpit migrate-socket` on an already-migrated cockpit returns 0 with the "no legacy cockpit on default socket" log. The doctor probe [`cockpit-on-default-socket`](#§4--doctor-probes) self-clears after migration completes.

## §3 — Canonical `atmux.conf`

atmux ships a canonical tmux config at `templates/tmux/atmux.conf` (installed under `/opt/atmux/<version>/templates/` per [ADR-047](adr/047-canonical-install-topology.md)). Every cockpit + per-team session creation call-site threads this file via the `-f <path>` flag, so atmux invocations **never inherit the operator's `~/.tmux.conf`**. This closes the inheritance path that previously made atmux behavior depend on the operator's personal config drift (`base-index`, `pane-base-index`, custom key bindings, etc.).

The baseline ships 8 options per [ADR-162 §Decision-anchor #3](adr/162-atmux-owns-tmux-infrastructure.md) — most critically `automatic-rename off` (protects the [ADR-135](adr/135-cockpit-naming-convention.md) `buildWindowName` contract from tmux's auto-rename stomping on `_-prefix` windows).

**Operator override:**

```bash
# Point at a custom conf (e.g. add personal key bindings)
ATMUX_TMUX_CONF=/path/to/your.conf atmux cockpit rebuild

# Inherit your personal conf instead (advisory — may break ADR-135)
ATMUX_TMUX_CONF=~/.tmux.conf atmux cockpit rebuild

# Full opt-out (stock tmux defaults — `automatic-rename on` may break)
ATMUX_TMUX_CONF=/dev/null atmux cockpit rebuild
```

The override is one-shot per invocation; persistent overrides go in shell profile.

## §4 — Doctor probes

Two new warn-class doctor probes ([ADR-162 §Decision-anchor #5](adr/162-atmux-owns-tmux-infrastructure.md)) surface ADR-162 drift before it bites:

**`tmux-version-mismatch`** — compares the host tmux version against atmux's tested range (currently min 3.2, tested-against 3.6a). Warn payloads:

- `🟡 host tmux version X.Y below minimum 3.2` — atmux features may not work; upgrade or pin via [ADR-163](adr/163-bundled-tmux-binary.md) bundled binary.
- `🟡 host tmux version Z.W untested above 3.6a` — atmux ops may still work but haven't been validated.

Warn-class only — doesn't block atmux. Surfaces via `atmux doctor` (human) + `atmux doctor --json` (structured).

**`cockpit-on-default-socket`** — discovers any session matching `atmux_cockpit` (or `atmux_teams`) on the default socket. Warn payload:

```
🟡 legacy cockpit session detected on default socket;
   run 'atmux cockpit migrate-socket' to move it to the dedicated socket
```

**Self-clearing** — re-runs after `atmux cockpit migrate-socket` completes find no legacy session and emit nothing. Stays in the doctor probe set for at least one minor-version cycle (0.8.x → 0.9.x) per [ADR-162 §Open question 1](adr/162-atmux-owns-tmux-infrastructure.md#open-questions).

Both probes are warn-class — they don't block `atmux cockpit rebuild` or any verb. They surface drift; the operator decides when to act.

## §5 — `ATMUX_COCKPIT_SOCKET` escape hatch

The cockpit socket is resolved via `getCockpitSocketName()` in `src/core/tmux-paths.ts`. Resolution chain:

1. `ATMUX_COCKPIT_SOCKET=<name>` env var → returns the override verbatim. Empty string treated as unset.
2. Otherwise → canonical `atmux-cockpit` per [ADR-162 §Decision-anchor #1](adr/162-atmux-owns-tmux-infrastructure.md).

**When to use it:**

- **One more cycle on the legacy socket.** Operators not ready to migrate can set `ATMUX_COCKPIT_SOCKET=default` to keep the old behavior. The `cockpit-on-default-socket` doctor probe still warns; operations proceed against the legacy socket.

  ```bash
  export ATMUX_COCKPIT_SOCKET=default  # in shell profile or per-invocation
  atmux cockpit rebuild  # rebuilds against default socket
  ```

  `atmux cockpit migrate-socket` **refuses** to run when `ATMUX_COCKPIT_SOCKET=default` is in effect (migration target equals legacy source). Unset the env var (or set it to `atmux-cockpit`) to proceed.

- **Custom socket name.** Multi-cockpit setups (rare — typically dev/test) can run multiple cockpits side-by-side under different socket names:

  ```bash
  ATMUX_COCKPIT_SOCKET=atmux-cockpit-dev atmux cockpit rebuild --config ~/atmux-dev.json
  tmux -L atmux-cockpit-dev attach -t atmux_cockpit
  ```

The override is per-invocation; agents that spawn atmux processes inherit the env at fork-time. Production cockpits should NOT set this — the default (`atmux-cockpit`) is what the doctor probes + migration verb assume.

## Cross-references

- [ADR-162](adr/162-atmux-owns-tmux-infrastructure.md) — atmux owns its tmux infrastructure (cockpit socket isolation + canonical atmux.conf + version probes).
- [ADR-135](adr/135-cockpit-naming-convention.md) — cockpit naming convention (`atmux_cockpit` session name, `_-prefix` for default-member windows).
- [ADR-058](adr/058-cage-tier-isolation.md) — cage-tier isolation (per-team socket layer, unchanged by ADR-162).
- [ADR-047](adr/047-canonical-install-topology.md) — install topology (`/opt/atmux/<version>/templates/`).
- [ADR-097](adr/097-tmux-abstraction.md) — `TmuxConfig` discriminated union (`socket` + `configFile` fields consumed here).
- [ADR-163](adr/163-bundled-tmux-binary.md) — bundled tmux binary + version-lock v2 (forward-ref).
- `templates/tmux/atmux.conf` — canonical 8-option baseline.
- `src/core/tmux-paths.ts` — `getCockpitSocketName()` + `getAtmuxTmuxConfPath()` resolvers.
- `src/verbs/cockpit.ts::cockpitMigrateSocket` — the migration verb implementation.
