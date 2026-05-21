# ADR-217: Bundle atmux skills as a Claude Code plugin shipped with the source tree + installed by the first-run wizard

**Status**: Proposed
**Date**: 2026-05-21
**Driver-ref**: 2026-05-21 operator — *"add this plugin to our docs as well and have it in our source code here so that atmux users can use it too... and guide our users how to set up the skills too... put it in our startup wizard"*. Followup to operator-side dotfiles plugin restructure that surfaced 12 skills tightly coupled to atmux verb/cage/cockpit semantics.
**Cross-refs**: [ADR-200](200-install-wizard-guided-first-run-setup.md) (wizard substrate — this ADR adds a step to it), [ADR-077](077-superdoctor-cockpit-role.md) (superdoctor role → §D2 `/atmux:sweep` skill carve), [ADR-133](133-superdoctor-to-medic-rename.md) (medic rename), [ADR-212](212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md) (medic role retired but probes persist — `/atmux:sweep` is the operator-facing surface for the persisted probes), [ADR-091](091-kanban-driven-auto-merge.md) + [ADR-145](145-atmux-adopts-gitter.md) (gitter/committer — referenced by `/atmux:ghostbuster`), [ADR-087](087-atmux-stop-soft.md) (soft-stop — referenced by `/atmux:session`).

## Context

Atmux operators today drive the system through ~12 Claude Code skills that wrap atmux verbs (`atmux tell-lead`, `atmux start`, `atmux stop --soft`, `atmux cockpit rebuild`, `atmux team rotate-member`, etc.) plus cross-team workflows (cockpit-tier health sweeps, complaint filing, autonomous /loop drivers). These skills live in the driver's private dotfiles tree (`~/work/journals/.sb/claude-skills/plugins/coordination/skills/...`). That's invisible to anyone else trying to use atmux.

Three problems:

1. **Public atmux users can't discover the skills.** The README + RUNBOOKs explain the CLI verbs but never mention the skill-tier workflow (e.g. `/bruh`, `/whip`, `/superdoctor` patterns). Users either reinvent the same wrappers or never adopt the cockpit-tier workflows the tool was designed around.
2. **Operator-flavored references leak in.** SKILL.md files reference Hetzner host paths (`/root/.atmux/...`), IFCA/Unum domain names, and operator dotfiles paths. Even if a new user found the skills they couldn't run them as-is.
3. **No wizard wiring.** ADR-200 (first-run install wizard) provisions cockpit + account pool + Honker extension but doesn't offer the skills plugin. Users finish `atmux init` with a working CLI + no skill surface.

The fix: bundle a *generalized* set of atmux-coupled skills as a Claude Code plugin shipped IN the atmux source tree, and add a wizard step that symlinks it into the user's Claude Code plugin path.

## Decision

### §D1 — Plugin location in atmux source tree

`plugins/atmux/` at the atmux repository root. Layout:

```
plugins/atmux/
├── README.md                       — user-facing install + verb reference
├── .claude-plugin/
│   └── plugin.json                 — Claude Code plugin manifest
└── skills/
    ├── team/SKILL.md               — /atmux:team <verb> [args]
    ├── session/SKILL.md            — /atmux:session <verb> [args]
    ├── tell-lead/SKILL.md          — /atmux:tell-lead <message>
    ├── heads-up/SKILL.md           — /atmux:heads-up <message>
    ├── bruh/SKILL.md                — /atmux:bruh
    ├── bruhloop/SKILL.md           — /atmux:bruhloop
    ├── whip/SKILL.md               — /atmux:whip [run|cadence|watchdog]
    ├── bau/SKILL.md                — /atmux:bau [team]
    ├── ghostbuster/SKILL.md        — /atmux:ghostbuster
    ├── budget/SKILL.md             — /atmux:budget
    ├── sweep/SKILL.md              — /atmux:sweep (was: superdoctor)
    └── cockpit-rebuild/SKILL.md    — /atmux:cockpit-rebuild
```

Plugin namespace: invocations are `/atmux:<skill>` (per Claude Code convention `plugin:skill`).

### §D2 — Skill carve set + naming

12 skills, source → destination:

| Source (operator dotfiles) | Bundled name | Rationale |
|---|---|---|
| `coordination/team` | `/atmux:team` | unified lifecycle (start/stop/add/clear/cleanup/bootstrap/rotate) |
| `coordination/session` | `/atmux:session` | preclear / handoff / cont / stop |
| `coordination/tell-lead` | `/atmux:tell-lead` | driver→lead durable message |
| `coordination/heads-up` | `/atmux:heads-up` | lightweight teammate ping |
| `coordination/bruh` | `/atmux:bruh` | sweep blockers/flags/worktrees |
| `coordination/bruhloop` | `/atmux:bruhloop` | hands-off `/loop` wrapper around bruh |
| `coordination/whip` | `/atmux:whip` | autonomous-work nudge loop |
| `coordination/bau` | `/atmux:bau` | business-as-usual status sweep |
| `coordination/ghostbuster` | `/atmux:ghostbuster` | mergeable-branch sweeper |
| `coordination/budget` | `/atmux:budget` | rate-limit probe across Claude accounts |
| `coordination/superdoctor` | `/atmux:sweep` | **renamed** — see §D2.1 |
| `cockpit/rebuild` | `/atmux:cockpit-rebuild` | deterministic cockpit rebuild |

#### §D2.1 — Why `/atmux:sweep` instead of `/atmux:superdoctor` or `/atmux:medic`

ADR-133 renamed the cockpit role `superdoctor` → `medic` to avoid colliding with the `atmux doctor` verb. ADR-212 then retired the medic *role* (its auto-spawned cockpit window) but kept the probe substrate as a library + the host-pressure playbook (ADR-198) as an on-demand surface.

The skill exposes that surviving substrate as a manually-invoked fleet-wide sweep. Naming targets the *action* (sweep across all teams running `atmux doctor` + `atmux status --json`, file complaints) rather than the retired role. `/atmux:doctor` is rejected because of the `atmux doctor` CLI verb collision (verb runs ONE team; skill runs the fleet). `/atmux:medic` is rejected because the role doesn't exist anymore + future users won't recognize it from any live cockpit window or CLI output. `/atmux:sweep` matches internal language already (`atmux team sweep-epics`).

The persisted host-pressure playbook (ADR-198 §D2 5-step playbook) is one *trigger* inside `/atmux:sweep`. Skill body documents the playbook + the threshold conditions; the skill remains the operator-facing entry point.

### §D3 — Skills NOT carved (stay general-purpose)

Operator's dotfiles ship many domain-general skills (`paste`, `mvp`, `quality`, `wiz`, `deploy`, `journal`, `sync`, `todo`, `test`, `shax`, `infisical`, `push`, `adr`). These work outside atmux + don't reference atmux verbs/state. They stay in their existing per-plugin homes; atmux bundle does not duplicate them. Users adopt them à la carte via the existing plugin layout.

`adr/` is atmux-aware in some conventions (signoff filename pattern) but operates on any `docs/adr/` tree. Stays general; users running atmux + the adr skill side-by-side get the existing UX.

### §D4 — Generalization pass per skill

Each carved SKILL.md needs a pass to strip operator-specific surface:

| Surface | Pattern to strip | Replacement |
|---|---|---|
| Personal paths | `/root/work/journals/...`, `/Users/geoyws/...` | `$HOME/work/...` or remove |
| Personal hosts | `geoy.ws`, `hax`, Hetzner refs | drop (the skill is host-agnostic) |
| Personal domains | `ifca.app`, `u-n-u-m.com`, IFCA/Unum staging refs | drop or replace with generic example.com |
| Personal Claude accounts | `c-u`, `c-ic`, `c-i` | `claudeAccount` is documented per-team; user configures |
| Operator name | `geoyws`, `George` | drop or generalize to `<operator>` |
| Personal whip cadences | hardcoded 270s / 3600s pinned by operator | document the default + how to tune |
| ADR-superseded vocab | `atmux_teams` (pre-[ADR-135](135-cockpit-naming-convention.md) cockpit session name); `superdoctor` (pre-§D2.1 sweep rename); `martinet` (pre-[ADR-158](158-martinet-to-sentinel-rename.md) sentinel rename); any other ADR-flagged retired vocab discovered during the pass | `atmux_cockpit` / `sweep` / `sentinel` / current-canonical per the cited ADR |

Substrate-level coupling (atmux verbs, ADR refs, cage/cockpit semantics) STAYS — those are the public atmux surface. The generalization is removing operator-specific path/host/domain particulars + retired-vocab residue, not atmux particulars.

#### §D4.1 — Per-skill known-leak pre-inventory

Pre-pass audit notes captured from lead's 2026-05-21 sweep (supplement as additional leaks are discovered during the Story 2 passes). Each carve agent reads the row for their target skill BEFORE the pass so the per-pass grep finds the named patterns:

| Skill | Known leaks (pre-pass) |
|---|---|
| `cockpit-rebuild` | operator dotfiles path (`~/work/journals/.sb/...`); `~/bin` symlink reference; `geoy.ws` host-check guard; stale `atmux_teams` session name (pre-ADR-135). Lead-confirmed 2026-05-21. |

(Other skills add rows as their carve passes complete and surface leaks the strip-list categories didn't pre-anticipate.)

### §D5 — Wizard integration (ADR-200 extension)

`atmux init` gains a step:

```
Step 6/N: Install /atmux: skills plugin? [Y/n]
  This makes 12 cockpit-tier skills (/atmux:bruh, /atmux:team,
  /atmux:tell-lead, etc.) available in Claude Code.
  
  Installs by symlinking <atmux-source>/plugins/atmux/ into
  ~/.claude/plugins/atmux/ (Claude Code's plugin discovery path).
  
  Skip if you've installed atmux skills via your own dotfiles.

  > [Y]es / [n]o / [s]how list of skills
```

Implementation:
- **Symlink not copy** — so atmux upgrades automatically refresh the bundled SKILL.md content. Operator dotfiles override: if `~/.claude/plugins/atmux/` already exists as a real directory (not a symlink), wizard preserves it + prints a notice.
- **`--no-skills` flag** — wizard skips this step under `atmux init --no-skills`.
- **`--skills-only` flag** — runs *only* this step (re-install after manual deletion).
- **Idempotent** — already-correct symlink is a no-op + prints `✓ skills plugin already installed`.

Doctor probe (`atmux doctor`): adds a row `atmux-skills-plugin` — green if symlink exists + plugin.json validates; yellow if symlink missing or plugin.json malformed; info-level when user explicitly opted out via init-time `no` (a marker file at `~/.atmux/state/skills-plugin-opted-out`).

### §D6 — README + per-skill documentation

`plugins/atmux/README.md` covers:

1. What the plugin provides (12 skills, one-line description each)
2. How to install (3 paths — via wizard, manual symlink, override-with-dotfiles)
3. Quick reference table (skill name + most common invocation)
4. Link to per-skill SKILL.md for deeper docs
5. How to uninstall (`rm ~/.claude/plugins/atmux/` symlink)
6. Plugin version + atmux compatibility matrix
7. Note that operator-flavored variants live elsewhere; this is the public surface

Per-skill SKILL.md retains the `--help` body + `description:` frontmatter so Claude Code's discovery surfaces them in `/help` and skill-search.

### §D7 — Main repo README + docs/PRD.md cross-links

The atmux top-level README gains a §"Skills (`/atmux:`)" section pointing to `plugins/atmux/README.md` for skill discovery. `docs/PRD.md` operator-facing section documents that atmux ships with a skills plugin + how to opt in. `docs/RUNBOOK-cockpit.md` cross-links specific skills (`/atmux:cockpit-rebuild`, `/atmux:sweep`) where they replace longer manual workflows.

### §D8 — Plugin manifest (plugin.json)

```json
{
  "name": "atmux",
  "version": "0.1.0",
  "description": "Atmux skills — cockpit-tier workflows for atmux team-of-teams (12 skills: team lifecycle, session continuity, fleet sweeps, etc.)",
  "atmuxCompat": ">=0.8.10",
  "skills": [
    { "name": "team", "path": "skills/team/SKILL.md" },
    { "name": "session", "path": "skills/session/SKILL.md" },
    { "name": "tell-lead", "path": "skills/tell-lead/SKILL.md" },
    { "name": "heads-up", "path": "skills/heads-up/SKILL.md" },
    { "name": "bruh", "path": "skills/bruh/SKILL.md" },
    { "name": "bruhloop", "path": "skills/bruhloop/SKILL.md" },
    { "name": "whip", "path": "skills/whip/SKILL.md" },
    { "name": "bau", "path": "skills/bau/SKILL.md" },
    { "name": "ghostbuster", "path": "skills/ghostbuster/SKILL.md" },
    { "name": "budget", "path": "skills/budget/SKILL.md" },
    { "name": "sweep", "path": "skills/sweep/SKILL.md" },
    { "name": "cockpit-rebuild", "path": "skills/cockpit-rebuild/SKILL.md" }
  ]
}
```

Exact manifest shape conforms to Claude Code's plugin schema in effect at landing time (verify via `/doctor` per memory `feedback_reload_plugins_before_assuming_skill_missing` — schema bumps have broken plugins before).

### §D9 — Out of scope (deferred)

- **Migrating operator's private dotfiles to point at the bundled plugin.** Operator-side choice; this ADR delivers the public surface.
- **Cross-platform skill body variants.** All 12 skills are bash-flavored + reference Linux semantics. macOS/WSL polish is follow-up work; the ADR ships the dominant target (Linux hax-like environments) first.
- **Composer 2.5 / cursor-cli sentinel skills.** Per ADR-201 rejection, no cursor-driven skills bundle in this plugin.
- **Multi-version compatibility shims.** `plugin.json::atmuxCompat` records the requirement; supporting older atmux versions is not in scope.

## Consequences

**Becomes easier:**

- Public atmux users discover + adopt the cockpit-tier workflow without rediscovering it from scratch.
- Documentation has a real home for "how does the operator use atmux day-to-day" beyond the verb reference.
- Skill upgrades ride atmux releases — symlink resolves to the version-current SKILL.md, so users upgrading atmux automatically pick up newer skill bodies.
- Wizard provisions a complete first-run experience (cockpit + skills + Honker, per ADR-200 + this ADR + the ADR-200 substrate steps).

**Becomes harder:**

- 12 SKILL.md files to keep generalized — operator-specific drift in PRs becomes a reviewer concern + needs a recurring sweep.
- Plugin-schema upgrade risk: Claude Code's plugin schema has broken plugins before (memory `feedback_reload_plugins_before_assuming_skill_missing` — `userConfig` schema bump in 2.1.143 broke `coordination/deploy/journal/paste/test`). Atmux releases now coordinate with Claude Code schema changes.
- Two homes for the same skill (operator dotfiles + bundled) creates drift risk. Operator-facing concept: dotfiles version is the working draft + atmux bundle is the released cut.

**Risks + mitigations:**

- **Risk**: User overrides bundled plugin with their own customized SKILL.md (e.g. swaps `/atmux:whip` cadence to 600s); next atmux upgrade clobbers the override via symlink-refresh.  
  **Mitigation**: Wizard documentation explains the symlink behavior + the "delete symlink to override locally" path. `plugins/atmux/README.md` §How to customize covers it explicitly.
- **Risk**: A user with no Claude Code installed gets a yellow doctor probe forever.  
  **Mitigation**: Doctor probe is info-level when the skills-plugin-opted-out marker is set. The opt-out covers users who don't run Claude Code at all.
- **Risk**: Bundled skill body has stale ADR refs once skills mature in their own dotfiles tree.  
  **Mitigation**: ADR refs in SKILL.md treated like other doc-update surfaces — same-commit ADR pointer per project CLAUDE.md §Same-commit doc + ADR-pointer update.

## Implementation phases

Implementation lives in an EPIC that decomposes into approximately:

1. **Scaffold** — `plugins/atmux/.claude-plugin/plugin.json` + `plugins/atmux/README.md` + per-skill empty SKILL.md stubs with frontmatter only. Gets directory tree + plugin discovery wired before any content lands.
2. **Per-skill bring-over + generalization pass** — 12 sub-tasks (1 per skill), each: copy SKILL.md + supporting `*-prompt.md` from operator dotfiles → strip §D4 patterns → cross-link to atmux ADRs. Generalization passes are independent → parallelizable across epic-team members.
3. **Wizard step** — extend `atmux init` per §D5; flag handling; idempotent symlink logic; opt-out marker.
4. **Doctor probe** — add `atmux-skills-plugin` row per §D5 (re-use `checkHonker` pattern landed today).
5. **Docs sweep** — README + PRD + RUNBOOK cross-links per §D7.
6. **Test coverage** — unit tests for wizard step (symlink logic, idempotent, override-detection) + doctor probe row + plugin.json schema validation. 100% on tracked paths.
7. **Plugin-schema regression test** — `tests/integration/skills-plugin-schema.test.ts` validates plugin.json against the published Claude Code schema; surfaces drift before users hit a `/doctor` red row.

EPIC scope size: substantial (~12 SKILL.md generalizations × ~100-line bodies + wizard + docs + tests). Suitable for an epic-team with parallel lanes per skill.

## References

- ADR-200 — install wizard (this ADR adds §D5 step to it)
- ADR-077 + ADR-133 + ADR-212 — superdoctor → medic → retired-role-with-persistent-substrate chain; explains `/atmux:sweep` naming
- ADR-198 — host-pressure playbook (one trigger inside `/atmux:sweep`)
- ADR-091 + ADR-145 — gitter/committer + atmux-adopts-gitter; referenced by `/atmux:ghostbuster`
- ADR-087 — soft-stop (`/atmux:session` consumer)
- memory `feedback_reload_plugins_before_assuming_skill_missing` — plugin-schema drift cautionary
- memory `feedback_claude_skills_dotfiles_territory` — operator-dotfiles vs atmux-bundle distinction
