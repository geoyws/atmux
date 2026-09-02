# atmux skills — Claude Code plugin

Cockpit-tier workflows for atmux team-of-teams, shipped as a Claude Code plugin in the atmux source tree. 11 skills wrap atmux verbs + cross-team workflows that the operator-facing CLI alone can't express in one breath. (`/atmux:bruh` and `/atmux:bruhloop` were retired and deleted per [ADR-288](../../docs/adr/288-superdriver-lane-shortform-and-multi-lane-cockpit.md) §D4.)

Per [ADR-217](../../docs/adr/217-atmux-skills-plugin-bundled-and-wizard-installed.md) §D6.

## What this plugin provides

11 skills, all invoked as `/atmux:<skill>` (Claude Code's `plugin:skill` convention):

| Skill | One-line description |
|---|---|
| `/atmux:team` | Unified team lifecycle — start, stop, add, clear, cleanup, bootstrap, rotate-lead, rotate-member. |
| `/atmux:driver` | Driver-1 consolidation — fetch + merge every sibling driver branch into the base branch. Verbs: `consolidate`, `status`. |
| `/atmux:session` | Session continuity — cont, handoff, stop. |
| `/atmux:tell-lead` | Driver→lead durable message via `atmux tell-lead` (file-backed + best-effort wake-up). |
| `/atmux:heads-up` | Lightweight teammate ping — fold into next idle turn. |
| `/atmux:whip` | Autonomous-work nudge loop — verbs: `run`, `cadence`, `watchdog`. |
| `/atmux:bau` | Business-as-usual sweep — commit cadence, rate-limits, kanban, dormant escalation. |
| `/atmux:ghostbuster` | Mergeable epic-team branch sweeper (current cage only). |
| `/atmux:budget` | Live rate-limit probe across all configured Claude accounts. |
| `/atmux:sweep` | Fleet-wide diagnose + complain sweep (per [ADR-077](../../docs/adr/077-superdoctor-cockpit-role.md) substrate; persisted host-pressure playbook from [ADR-198](../../docs/adr/198-medic-host-pressure-playbook.md) is one trigger). |
| `/atmux:cockpit-rebuild` | Deterministic cockpit + per-team cage rebuild (idempotent). |

## Install

Three install paths — pick whichever fits.

### 1. Via the atmux init wizard (recommended for new users)

`atmux init` offers an opt-in step (per ADR-217 §D5):

```
Step 6/N: Install /atmux: skills plugin? [Y/n]
```

Accepting the default `[Y]es` symlinks `<atmux-source>/plugins/atmux/` into `~/.claude/plugins/atmux/` (Claude Code's plugin discovery path). Skill upgrades ride atmux releases automatically — the symlink always resolves to the current source.

Flags:

- `atmux init --no-skills` skips the skills step entirely.
- `atmux init --skills-only` runs *only* this step (re-install after manual deletion).
- Already-correct symlink is a no-op: `✓ skills plugin already installed`.

### 2. Manual symlink (existing atmux installs)

```bash
ln -s "$(realpath <atmux-source>)/plugins/atmux" ~/.claude/plugins/atmux
```

Restart Claude Code (or run `/reload-plugins`) to surface the skills.

### 3. Override with your own dotfiles

If you already maintain your own atmux skill bodies in a dotfiles tree, drop a real directory at `~/.claude/plugins/atmux/` (not a symlink). The wizard preserves it and prints a notice — your local copy wins. Tradeoff: you opt out of automatic skill-body refreshes on atmux upgrade.

## Quick reference

```bash
/atmux:team start                    # spawn the team named in cwd's .atmux/team.json
/atmux:team rotate-member <id>       # rotate a single member's TUI
/atmux:session cont                  # resume after pane reload
/atmux:session handoff              # safe-to-/clear handoff
/atmux:tell-lead "<message>"         # durable driver→lead ask
/atmux:whip run                      # autonomous-work nudge loop
/atmux:bau                           # business-as-usual status
/atmux:bau 48 --no-fix               # 48h window, no auto-escalation
/atmux:ghostbuster --dry-run         # preview mergeable-branch sweep
/atmux:budget                        # rate-limit probe across accounts
/atmux:sweep                         # fleet-wide diagnose + complain
/atmux:cockpit-rebuild               # deterministic cockpit rebuild
```

Per-skill detail lives in `skills/<name>/SKILL.md` — Claude Code surfaces these via `/help` and skill search.

## Uninstall

```bash
rm ~/.claude/plugins/atmux            # symlink removal
```

If you accepted the wizard's install: also drop the opt-out marker so future `atmux doctor` runs stop flagging the missing plugin:

```bash
touch ~/.atmux/state/skills-plugin-opted-out
```

`atmux init --no-skills` next time you re-init will respect the marker and skip the prompt.

## Compatibility matrix

| Plugin version | atmux version |
|---|---|
| `0.1.0` | `>=0.8.10` |

The active requirement is declared in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) (`atmuxCompat`). Atmux doctor (`atmux doctor`) cross-checks the installed plugin against the running atmux version and surfaces a yellow row on drift.

## Operator-flavored variants — this is the public surface

Some operators maintain their own dotfiles-resident variants of these skills with personal paths, hosts, domains, and Claude account pinnings. That's expected — the bundled plugin is the *generalized* public surface; per-operator overrides live in dotfiles and override the bundle via path-3 above. If you spot personal references (specific hostnames, domains, paths under `/Users/<name>/` or `/root/`) inside this plugin tree, file a bug — those should not appear here.
