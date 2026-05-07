# ADR-038: Declarative-vs-live audit model — class taxonomy + per-class auto-fix gating

**Status**: accepted
**Date**: 2026-05-02
**Related**: [ADR-018](./018-per-team-tmux-socket-isolation.md) (cage-path naming convention), [ADR-026](./026-always-single-session-topology.md) (single-session default), [ADR-027](./027-team-rename-verb-and-topology-invariant.md) (topology invariant + team-repair-rename), [ADR-029](./029-driver-lead-team-scope-superdriver-cross-team.md) (cross-team scope tiers), [ADR-031](./031-aggressive-parallelisation-default.md) (parallelism default)
**Supersedes**: nothing (additive). Convergence path with [t-36ec8c01](../../.atmux/kanban.json) (ELEVATION umbrella) documented in §Convergence.

## Context

After the 4-team cage migration on 2026-04-27 (per ADR-018) and the team-rename + super-attach work on 2026-04-30, the driver did a fleet-wide hand inventory across all 4 atmux teams on hax (`atmux`, `ifca_aix`, `ifca_sopx`, `unum`) and found six distinct anomaly classes where **declarative state** (team.json + CLAUDE.md conventions + ADRs) and **live state** (tmux sessions + windows + cage tmpdirs + cron blocks + tmux runtime config) had diverged.

The drift accumulated despite per-verb safeguards because each verb owns its own narrow correctness invariant; nothing audits across the surface area. `atmux doctor` exists (lib/doctor.sh:1–74) and surfaces some classes (cron-orphan, registry-stale, topology-invariant — ADR-027), but its check set is verb-driven (each new verb adds a `_doctor_check_*`), not convention-driven, so naming convention, window-prefix discipline, and locale handling fall through.

Three forces converge:

1. **Live-state drift is real and accumulating.** Six classes inventoried 2026-04-30; some classes (B cage-path) explicitly carved out as OUT OF SCOPE in ADR-018 amendment 2026-04-30 with the deferral note "driver fires destructive stop/rename/start manually per team in a quiet window."
2. **ELEVATION (t-36ec8c01) proposes a manifest-driven `atmux apply` reconciler** — same conceptual machinery (desired state vs live state, drift detection, gated apply). ELEVATION is multi-week; live drift needs a lever NOW. Two clean shapes existed: (A) standalone Epic; (B) fold into ELEVATION.
3. **Whip cron already runs every 5min per team.** A natural delivery channel for drift surface — the team's existing watchdog can adopt audit as a sub-pass without new infrastructure.

Driver's framing was "audit Epic"; lead noted (A) standalone is the literal read but did not pre-decide.

## Decision

**Stand-alone Epic E14 — `atmux audit` verb + per-class auto-fix gating + whip integration + enforcer agent.** Designed to converge cleanly with ELEVATION when manifest lands (see §Convergence).

### Sources of truth (transient, until manifest lands)

Audit reads from three declarative sources. When ELEVATION's manifest ships, source (1) is replaced by manifest blocks; (2) and (3) stay as ambient invariants.

1. **`<projectRoot>/.atmux/team.json`** — per-team `name`, `tmuxTmpdir`, `members[]` (each with `role`, `name`, optional `emoji`), `singleSession` (assumed true per ADR-026 default).
2. **CLAUDE.md global + project-local conventions** — naming convention (underscore between domains, hyphen within), driver window position invariant, single-session topology, cage-tmpdir form, registry presence.
3. **`~/.tmux.conf`** — operator's tmux config. Cage tmux servers should be sourced from this; drift here = locale-blind tooling regression (class F).

Live state is introspected via tmux on each cage socket, `~/.claude/teams/registry.json`, `crontab -l`, filesystem (`/tmp/atmux-tmux*` + `/tmp/atmux_tmux_*`), and per-cage `tmux show-options` for runtime config comparison.

### Drift class taxonomy

The audit verb classifies each finding into one of six classes. Each class has a **blast radius** (low / medium / high) which gates whether whip auto-fires the fix or surfaces it to the driver. New classes added to this taxonomy require an ADR amendment.

| Class | Name | Detector signal | Blast | Auto-fix? | Fix surface |
|---|---|---|---|---|---|
| **A** | driver-window naming | `tmux list-windows` shows bare `driver` instead of `__<team>__driver` | medium | conditional ✅ | gated on driver-pane idle (see §Pane-state safety gate) |
| **B** | cage path separator | `team.json:.tmuxTmpdir` matches `/tmp/atmux-tmux-*` (old hyphen form) instead of `/tmp/atmux_tmux_*` | high | ❌ surface only | wraps `lib/team-repair-rename.sh`; driver fires |
| **C** | window position drift | driver pane window position ≠ 1 OR team-lead pane window position ≠ 2 | high | ❌ surface only | `tmux swap-window` × N; driver fires |
| **D** | rename residue | window name has trailing-dash or partial-match pattern (e.g. `__ifca_aix__🪄lead-`) | low | ✅ | strip trailing dash via `tmux rename-window` |
| **E** | stray empty cage dirs | `/tmp/atmux-tmux-*` or `/tmp/atmux_tmux_*` exist with no live socket AND no entry in registry | low | ✅ | `rmdir` with `[ -z "$(ls -A)" ]` guard |
| **F** | tmux config glyph mismatch | per-cage `tmux show-option -gv status-left` ≠ `~/.tmux.conf`-derived expansion (e.g. nerd-font glyph downgraded to `_`) | low | ✅ | `atmux tmux-conf-restore <cage-socket>` shared primitive |

Class F was identified post-base-brief from a 2026-04-30 16:34 MYT incident (driver ADDENDUM 15 Bug #2): `ifca_aux` cage's status-left got nerd-font glyphs replaced with literal `_` after the aux→ifca_aux rename. Root cause is **locale-blind tooling** reading `~/.tmux.conf` without `LC_ALL=en_US.UTF-8` (or equivalent UTF-8 codeset) — a non-utf-8-aware shell pipeline (sed/awk/heredoc) downgrades codepoints to `_`. Class F's audit primitive (`atmux tmux-conf-restore`) is shared with `lib/team-repair-rename.sh` and any future verb that re-sources tmux config; standalone use is `atmux audit --fix --class f`.

### Per-class auto-fix gating policy

**Low-blast classes (D, E, F)** — whip auto-fires the fix on detect. Pane state irrelevant (D/F are tmux metadata; E is filesystem). `🛠️` Discord row notes the autocorrect.

**Medium-blast class (A)** — whip auto-fires ONLY when the driver pane is at shell idle (no claude REPL active, no modal prompt). Detection: `tmux capture-pane -p -t <driver-window> -S -10` matches a bare prompt regex (`\$ $|❯ $|» $`). On not-idle, surface as `⚠️` with the ready-to-fire command for driver review.

**High-blast classes (B, C)** — never auto-fire. Whip surfaces with `⚠️` + the ready-to-fire command. Class B reuses `lib/team-repair-rename.sh` (atomic per team with rollback per ADR-027 ADDENDUM 11). Class C invokes `tmux swap-window` ad-hoc; no atomic wrapper today.

### `atmux audit` verb surface

```
atmux audit [--quiet] [--fix [--class <a|b|c|d|e|f|all>]] [--json] [--dry-run]
```

- **No flag** → detect-only, human render. Each finding is one row: `<class> <severity> <team> <detail> <fix-hint>`.
- `--quiet` → suppress output; exit 0 on green, 1 on any drift. Used by whip sub-pass.
- `--fix` → apply fixes. Defaults to safe classes (D, E, F). `--class <c>` narrows.
- `--json` → emit findings array (one object per drift) for whip / external dashboards. Schema:

```json
[
  {
    "class": "A",
    "severity": "medium",
    "team": "atmux",
    "detail": "driver window named 'driver' (expected '__atmux__driver')",
    "fix_hint": "atmux audit --fix --class a (gated on driver-pane idle)",
    "auto_fixable": false,
    "blast_radius": "medium"
  }
]
```

- `--dry-run` → print fix plan, no mutations. Default for any class with blast≥medium.

**File location**: `lib/audit.sh`. Dispatcher entry in `bin/atmux`. Per-class detector + fixer pairs (`_atmux_audit_class_a_detect` / `_atmux_audit_class_a_fix`) keep the surface uniform.

### Pane-state safety gate (class A)

Per CLAUDE.md global "Always read pane state BEFORE `tmux send-keys`": every auto-fix that touches a teammate-or-driver pane MUST `tmux capture-pane -p -t <pane> -S -10` first and verify idle. The driver-window rename (class A) is unique because it renames the operator's own active session — guard: only fire when driver pane is at shell prompt (no claude REPL banner, no `Press up to edit queued messages`, no `Compacting conversation`, no rate-limit modal). Whip captures + classifies before firing; on any non-idle state, surface to Discord as `⚠️` with the ready-to-fire command instead of acting.

### Fleet scope

`atmux audit` runs per-team (via cron + whip sub-pass) AND fleet-wide (via `atmux super-status` + enforcer agent). Per-team is the default invocation. Fleet aggregation walks `~/.claude/teams/registry.json`, runs the per-team audit on each entry, and rolls up findings. The enforcer role on the superdriver team (ADR-039) is the agent-side consumer.

### Convergence with ELEVATION (t-36ec8c01)

When ELEVATION's manifest + reconciler lands:

- **`atmux audit` becomes a thin wrapper** around `atmux diff --class drift` (detect) + `atmux apply --selected-class <a|b|c|d|e|f>` (fix). Class taxonomy migrates verbatim; gating policy survives.
- **Source (1) team.json** in §Sources of truth is replaced by manifest blocks. Sources (2) and (3) stay as ambient invariants.
- **Detector functions** (`_atmux_audit_class_*_detect`) move into the diff engine's class-handler registry; fixer functions move into the apply engine. No logic rewrite — just relocation.
- **`atmux audit` verb** stays as an alias for backwards-compatibility one minor version, then deprecated.

The class taxonomy is the durable artifact. Whatever shape ELEVATION takes, classes A–F (and any future additions) are the vocabulary.

## Consequences

- **`lib/audit.sh`** (new, ~280 LOC) — class detectors + fixers + dispatcher. Per-class pair pattern keeps each detector ≤30 LOC.
- **`bin/atmux`** — new `audit` verb route.
- **`lib/whip.sh`** gains audit sub-pass (~15 LOC) — calls `atmux audit --json --quiet`, parses findings, classifies, decides auto-fix vs surface (per ADR-040).
- **`lib/discord.sh`** gains `[whip-audit]` template formatter (~30 LOC) — header + per-finding bullet + status emoji per class (per ADR-040).
- **`lib/tmux-conf-restore.sh`** (new, ~40 LOC) — idempotent canonical tmux-conf restore primitive shared by audit class-F fixer + `lib/team-repair-rename.sh` + future verbs. Must invoke `tmux source-file` with `LC_ALL=en_US.UTF-8` env to defend against locale-blind callers.
- **`lib/doctor.sh`** — class A–F detectors invoke audit's detector functions (don't duplicate); doctor row reframes findings as drift classes.
- **`templates/briefs/enforcer.md`** (new, per ADR-039).
- **README.md §Audit** (new) — class taxonomy + remediation table + convergence note.
- **docs/audit.md** (new) — operator guide: how to read whip-audit output, manual `atmux audit --fix` for high-risk classes, escape hatch.
- **ADR-018 amendment 2026-05-02** — replaces the "OUT OF SCOPE" deferral note for live-state cage-path migration with a forward-reference to `atmux audit --fix --class b`.
- **6 bats specs** (one per class) plus `tests/unit/audit_dispatch.bats` for verb surface.
- **Cron line `0 5 * * * atmux audit --quiet`** — daily backstop. Whip handles 5min cadence; cron covers when whip is paused or down.
- **Trade-off accepted**: class F's detection is heuristic (compare expanded status-left bytes — operators with active runtime overrides via `tmux set-option` will look drifted). False-positive surface is `⚠️` only (never auto-fixed without idle gate); operator can mark a team `auditExempt: true` in team.json (out-of-scope for v1).

## Open questions (resolved auto-mode per driver greenlight)

1. **OQ A1 (medium): standalone Epic vs fold into ELEVATION (t-36ec8c01)?** Resolved: standalone E14. Live drift needs a lever now; ELEVATION is multi-week. Class taxonomy is the durable artifact and migrates verbatim into ELEVATION's reconciler. Convergence path documented in §Convergence. Reversible by promoting Stories under E14 to t-36ec8c01 children once manifest lands. (medium-rev)
2. **OQ A2 (medium): class taxonomy — A–E (driver inventory) vs A–F (add tmux-config-glyph as class)?** Resolved: A–F. Class F shares the audit framework cleanly + uses the same primitive (`tmux-conf-restore`) as class A's fix. Folding it in keeps the vocabulary unified. (medium-rev)
3. **OQ A3 (medium): per-class auto-fix gating — by blast radius (chosen) or by class (alt)?** Resolved: blast radius. Three tiers (low auto-fix; medium gated on pane-state; high surface only). Predictable for operators. Same policy survives ELEVATION migration. (medium-rev)
4. **OQ A4 (low): JSON schema field names — `class`/`severity` vs `kind`/`level`?** Resolved: `class`/`severity`. Matches doctor.sh convention. (low-rev)
5. **OQ A5 (low): cron backstop schedule — daily 0 5 vs hourly?** Resolved: daily 0 5. Whip's 5min cadence covers normal-running case; backstop is for whip-down windows (rare). Hourly cron noise outweighs benefit. (low-rev)
6. **OQ A6 (medium): class F detection — strict byte equality vs expanded format**? Resolved: byte equality after `tmux format-expand` to resolve any conditionals in status-left. Strict equality false-positives on operator runtime `tmux set-option` overrides; mitigated by `auditExempt` opt-out (deferred to v2). (medium-rev)

All resolutions logged via `atmux decisions add` per ADR-008 protocol.

## References

- [ADR-018](./018-per-team-tmux-socket-isolation.md) — cage-path naming + live-state migration deferral (this ADR retires the deferral)
- [ADR-027](./027-team-rename-verb-and-topology-invariant.md) — `lib/team-repair-rename.sh` reused by class B fixer
- [ADR-039](./039-enforcer-agent-role.md) — fleet-level enforcer agent on superdriver team
- [ADR-040](./040-whip-audit-integration.md) — whip sub-pass + `[whip-audit]` Discord template
- [ADR-031](./031-aggressive-parallelisation-default.md) — Story decomposition follows parallelisation default
- [t-36ec8c01](../../.atmux/kanban.json) — ELEVATION umbrella (convergence target)
