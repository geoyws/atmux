# atmux audit — operator guide

`atmux audit` is the declarative-vs-live drift detector. Each tick reads three sources of truth — `team.json`, `~/.claude/teams/registry.json`, `~/.tmux.conf` — and compares them to live tmux + filesystem state. Findings are classified into one of six **drift classes**; each class has a documented blast radius, an auto-fix gating policy, and a runbook below.

This file is the operator-facing companion to:

- [ADR-038](adr/038-declarative-live-audit-model.md) — audit model + class taxonomy + per-class detector/fixer pair pattern.
- [ADR-039](adr/039-enforcer-agent-role.md) — fleet-level enforcer agent that aggregates per-team audit findings.
- [ADR-040](adr/040-audit-whip-integration.md) — whip's 5-min sub-pass that auto-fires safe classes.

When a new drift class lands, the planner amends ADR-038's class table; this file's per-class runbook gets a new entry to match.

## How to read `[whip-audit]` Discord output

Whip ships a `[whip-audit]` Discord template every tick (per ADR-040) when audit detects drift. The template follows the canonical `~/.claude/CLAUDE.md` Discord-format rule (header + bulleted body + per-bullet emoji):

```
🔧 [whip-audit] · `<team>` · HH:MM MYT

🛠️ **Auto-fixed** (low-blast, fired this tick):
  • 🛠️ class D — stripped trailing `-` from window `__atmux__🪄lead-`
  • 🛠️ class E — `rmdir` on /tmp/atmux_tmux_atmux_old (empty + no socket)

⚠️ **Surfaced** (medium/high-blast, idle gate failed OR never auto-fires):
  • ⚠️ class A — driver pane named `driver` (expected `__atmux__driver`); claude REPL active, gate failed
    → atmux audit --fix --class a (after `claude /quit`)
  • ⚠️ class B — team.json:.tmuxTmpdir on legacy `/tmp/atmux-tmux-aix` (use `_` separator)
    → atmux team rename aix aix --tmuxTmpdir /tmp/atmux_tmux_aix --migrate-cage

🟢 **Clean** (no drift detected): classes C, F
```

**Header anatomy.** `🔧` is the audit-template emoji (distinct from `📊 [whip-progress]` and `💓 [whip-heartbeat]`). Team name is backticked; HH:MM MYT is the standard timezone-explicit timestamp.

**Section discipline.** `🛠️ Auto-fixed` lists every low-blast fix that fired this tick — informational, no operator action needed. `⚠️ Surfaced` lists every medium-blast finding that failed its idle gate AND every high-blast finding (B and C never auto-fire) — each bullet ends with the ready-to-fire command in arrow-prefixed form. `🟢 Clean` is a one-line list of classes that detected no drift; helps confirm the detectors ran (vs. silently skipped).

If a tick produces zero findings across all six classes, no `[whip-audit]` ping fires (silent-on-clean). The whip's `[whip-progress]` digest will still mention "audit: clean" in its team-state section.

## Manual `atmux audit` invocations

### Detect-only — see what's drifting

```bash
atmux audit                       # human render, one row per finding
atmux audit --json                # findings array; pipe to jq for filtering
```

Sample human output:

```
class severity team       detail                                                fix-hint
----- -------- ---------- ----------------------------------------------------- ------------------------------------------
A     medium   atmux      driver window named 'driver' (expected '__atmux__driver')  atmux audit --fix --class a (gated)
D     low      atmux      window __atmux__🪄lead- has trailing dash            atmux audit --fix --class d (auto)
E     low      —          /tmp/atmux_tmux_oldteam empty + no socket + no registry  atmux audit --fix --class e (auto)
```

Sample `--json` schema (one object per finding):

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

`auto_fixable` reflects the **dynamic** safety gate (e.g. class A on a busy pane is `false` even though the class itself is `auto-fix conditional`). Whip + the enforcer agent both consume this field.

### Apply fixes — `--fix`

```bash
atmux audit --fix                 # apply safe classes (D, E, F) only
atmux audit --fix --class a       # narrow to one class
atmux audit --fix --class all     # apply every class auto-fixable right now;
                                  # high-blast (B, C) still refused
```

`--fix` defaults to **safe-only** (D, E, F). To fire a medium-blast (A), pass `--class a` explicitly — the idle gate still applies. **High-blast (B, C) cannot be fixed via `atmux audit --fix`** at all; they always require the dedicated verbs (see §Driver-only manual fixes below).

### Dry-run — print fix plan, no mutations

```bash
atmux audit --dry-run                  # default behavior for blast≥medium
atmux audit --fix --class a --dry-run  # explicit dry-run on a specific class
```

Dry-run is the **default** for any class with blast≥medium when invoked via `--fix --class <c>` without an explicit `--apply` flag — the verb prints the planned action and exits. To actually mutate, pass `--apply` (or rely on the idle gate to fire automatically via whip).

### `--quiet` — whip's sub-pass shape

```bash
atmux audit --quiet                # exit 0 green / 1 any drift; no output
```

Used by whip's 5-min sub-pass. Same exit-code shape as `atmux doctor --quiet`.

## Per-class runbook

### Class A — driver-window naming

**Symptom**: `tmux list-windows` shows a bare `driver` window instead of the expected `__<team>__driver`.

**Detection**: `tmux list-windows -t "$cage_session" -F '#{window_name}'` produces a row that's exactly `driver` (no team prefix). The detector compares against the team-name-derived expected pattern from `team.json:.name`.

**Remediation**: `tmux rename-window -t <cage>:driver __<team>__driver`.

**Auto-fix gating**. Medium-blast — gated on the **driver pane being at shell idle**. Whip captures `tmux capture-pane -p -t <driver-window> -S -10` and verifies:
- No `claude` REPL banner / token-counter line.
- No `Compacting conversation` banner.
- No `Press up to edit queued messages` banner.
- No rate-limit modal (`Approaching usage limit` / `You've hit your limit`).
- Prompt regex matches a bare shell idle line (`\$ $|❯ $|» $`).

When the gate passes, whip auto-fires. When it fails, whip surfaces `⚠️` with the ready-to-fire command for driver to invoke after `claude /quit` (or whatever ends the active REPL).

**Safety notes**. The rename touches the operator's *active session*. Pane-state preflight is non-negotiable — auto-firing a rename into an active REPL would scramble the queued buffer.

### Class B — cage path separator

**Symptom**: `team.json:.tmuxTmpdir` matches the **old hyphen form** `/tmp/atmux-tmux-*` instead of the current underscore form `/tmp/atmux_tmux_*`.

**Detection**: regex match on `.tmuxTmpdir`. The convention shift happened during the 2026-04-27 cage migration ([ADR-018](adr/018-per-team-tmux-socket-isolation.md)) — every team created before that should have been migrated, but stragglers persist.

**Remediation**: NEVER auto-fire. Drives the operator to:

```bash
atmux team rename <team> <team> --tmuxTmpdir /tmp/atmux_tmux_<team> --migrate-cage
```

Wraps `lib/team-repair-rename.sh` (atomic per team with rollback per [ADR-027](adr/027-team-rename-verb-and-topology-invariant.md) ADDENDUM 11). The rename verb handles: stop team → rewrite `team.json` → move state files → re-spawn cage on new socket → re-issue cron lines.

**Auto-fix gating**. **High-blast — never auto-fires.** Schema mutation + cage migration is too coordination-heavy for a 5-min cron tick to own. Driver fires the rename during a quiet window.

**Safety notes**. The migrate path requires the team to be **stopped** first. Whip will refuse to fire, but a hand-invoked `atmux audit --fix --class b` ALSO refuses — surface only.

### Class C — window position drift

**Symptom**: driver pane window position ≠ 1 OR team-lead pane window position ≠ 2.

**Detection**: `tmux list-windows -t "$cage_session" -F '#{window_index} #{window_name}'`. Driver should be index 1 (first); team-lead should be index 2 (second). Other members fill 3+.

**Remediation**: `tmux swap-window -s <current-index> -t <target-index>` × N.

**Auto-fix gating**. **High-blast — never auto-fires.** A swap-window mid-session can scramble pane focus + tmux's own choose-tree ordering, and on a busy session the driver may be looking at the very window being swapped. Surface with `⚠️` + the ready-to-fire command.

**Safety notes**. Position drift is rare — usually a hand-invoked `atmux start --no-doctor` after a partial stop, or a rename that left the spawn order ambiguous. When it happens, fix during a quiet window: `atmux stop && atmux start` is often cleaner than incremental `swap-window`s.

### Class D — rename residue

**Symptom**: window name has a trailing dash or partial-match pattern (e.g. `__ifca_aix__🪄lead-`).

**Detection**: regex match on window names — looks for trailing `-` or other malformed suffix from a previous rename that didn't complete cleanly.

**Remediation**: `tmux rename-window` to strip the trailing dash.

**Auto-fix gating**. **Low-blast — auto-fires.** Tmux metadata only; no pane-state interaction. Whip fires every tick a residue is detected.

**Safety notes**. None — the rename only touches the window name, not contents.

### Class E — stray empty cage dirs

**Symptom**: `/tmp/atmux-tmux-*` or `/tmp/atmux_tmux_*` directories exist with no live socket AND no registry entry.

**Detection**: filesystem walk + `tmux -S <sock> ls` probe + `~/.claude/teams/registry.json` lookup. Three conditions must all hold for the dir to be "stray":
1. Directory exists in `/tmp/atmux-tmux-*` or `/tmp/atmux_tmux_*`.
2. No live tmux socket (or socket exists but no session inside).
3. No registry entry whose `tmuxTmpdir` matches.

**Remediation**: `rmdir` with `[ -z "$(ls -A "$dir")" ]` guard — only removes truly-empty dirs. The guard prevents accidental wipe of an in-flight cage that happens to have no live session at the moment of detection.

**Auto-fix gating**. **Low-blast — auto-fires.** Filesystem-only; no pane interaction.

**Safety notes**. The `ls -A` empty-check is the last-line defense. If a dir contains anything (even hidden lockfiles), the `rmdir` refuses and the finding stays surfaced for manual cleanup.

### Class F — tmux config glyph mismatch

**Symptom**: per-cage `tmux show-option -gv status-left` returns a status-left whose glyphs don't match `~/.tmux.conf`'s declared expansion (e.g. nerd-font glyph downgraded to `_` or `?`).

**Detection**: byte-equality compare after `tmux format-expand` resolves any conditionals. Class F was identified post-base-brief from the **2026-04-30 16:34 MYT incident** (driver ADDENDUM 15 Bug #2): `ifca_aux` cage's status-left got nerd-font glyphs replaced with literal `_` after the `aux→ifca_aux` rename. Root cause: **locale-blind tooling** reading `~/.tmux.conf` without `LC_ALL=en_US.UTF-8` (or equivalent UTF-8 codeset) — a non-utf-8-aware shell pipeline (sed/awk/heredoc) downgrades codepoints to `_`.

**Remediation**: `atmux tmux-conf-restore <cage-socket>` — shared primitive that re-sources `~/.tmux.conf` under an explicit UTF-8 locale. Same primitive used by `lib/team-repair-rename.sh` and any future verb that re-applies tmux config.

**Auto-fix gating**. **Low-blast — auto-fires.** Tmux metadata only.

**Safety notes**. Detection is **heuristic** — operators with active runtime overrides via `tmux set-option` will look drifted (false positive). Mitigation: per-team opt-out via `team.json:.audit.exempt = true` (deferred to v2). For now, the false-positive surface is `⚠️` only — the auto-fire keeps `tmux-conf-restore` idempotent so re-applying the operator's intended config is harmless.

## Driver-only manual fixes (high-blast)

### Class B — cage migration

```bash
# Stop the team first.
atmux stop <team>

# Run the rename — same name, new tmuxTmpdir.
atmux team rename <team> <team> \
  --tmuxTmpdir /tmp/atmux_tmux_<team> \
  --migrate-cage

# Restart on the new cage.
atmux start <team>

# Verify.
atmux audit --json | jq '.[] | select(.class == "B")'   # should be empty
```

The `--migrate-cage` flag triggers the atomic rename + state-file move + cron rewrite per ADR-027 ADDENDUM 11. On any partial failure, the rollback log records what was attempted and where state was left; the operator continues from there.

### Class C — window position swap

```bash
# Inspect current ordering.
tmux -S <cage-socket> list-windows -t <session> -F '#{window_index} #{window_name}'

# Driver should be 1, team-lead 2. If not, swap:
tmux -S <cage-socket> swap-window -t <session>:<current> -t <session>:<target>

# Verify.
atmux audit --json | jq '.[] | select(.class == "C")'   # should be empty
```

Repeat per misplaced pane. **Do this during a quiet window** — swap-window mid-active-pane scrambles focus.

If position drift looks systemic (multiple panes off-by-N), a clean restart is often less painful than incremental swaps:

```bash
atmux stop <team>
atmux start <team>
```

## Escape hatch — opt out of audit

To disable audit entirely for a team:

```bash
jq '.audit.enabled = false' .atmux/team.json | sponge .atmux/team.json
```

Whip's audit sub-pass + manual `atmux audit` both honor `.audit.enabled` (default `true`). Use this for legacy teams that haven't been migrated to the convention conventions yet, or for one-off teams where the drift is intentional.

Per-class exemption (`auditExempt: ["F"]` to silence false-positive class F on a tmux-set-option-customized team) is **deferred to v2** — no tracking issue yet, but consider if false-positive volume becomes painful.

## See also

- [ADR-038](adr/038-declarative-live-audit-model.md) — audit model + class taxonomy + sources of truth.
- [ADR-039](adr/039-enforcer-agent-role.md) — fleet-level enforcer agent.
- [ADR-040](adr/040-audit-whip-integration.md) — whip's 5-min audit sub-pass.
- [ADR-018](adr/018-per-team-tmux-socket-isolation.md) — original cage isolation design (class B's migration target).
- [ADR-027 ADDENDUM 11](adr/027-team-rename-verb-and-topology-invariant.md) — atomic rename verb (class B's fix mechanism).
