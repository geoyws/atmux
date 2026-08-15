# ADR-187: Coordination skills plugin — operator-facing Claude Code skills that pair with atmux

**Status**: Accepted — ratified by driver 2026-05-21 (9-skill plugin mapping ↔ atmux verbs; skill-side lives in dotfiles, atmux team owns the verb contract not the skill code; §OQ recommendations as-written)
**Date**: 2026-05-20
**Driver-ref**: 2026-05-20 driver session — operator design call following the [ADR-183](./183-sentinel-scope-includes-epic-teams.SUPERSEDED.md) + [ADR-185](./185-sentinel-dynamic-epic-discovery.md) ship batch. Operator framing: *"document the skills plugin that pairs with atmux — operator-facing surface, lives in dotfiles, atmux team must not touch it."*
**Parent EPIC**: none.
**Cross-refs**: [ADR-185](./185-sentinel-dynamic-epic-discovery.md) (sibling — dynamic-discovery model for high-churn entities; same no-static-registration argument applied to the operator skill surface), [ADR-094](./094-c-alias-spawn-convention.md) (per-account Claude wrappers — `c-u` / `c-ic` / `c-i` — the operator's pre-existing dotfiles surface this plugin lives alongside), [ADR-145](./145-atmux-adopts-gitter.md) (committer scope — explicit no-deploy boundary; the skills plugin's `/team` verb respects the same scope walls), auto-memory `feedback_claude_skills_dotfiles_territory` — operator-mandated 2026-05-15 that atmux team must NOT escalate claude-skills issues as PRs.

## Context

### What this ADR records

The Claude Code skills plugin at `~/work/journals/.sb/claude-skills/plugins/coordination/` ships operator-facing `/slash-commands` that wrap atmux verbs for hands-on cockpit work. It has been in operator use since ~2026-05-10 but has no in-repo documentation — operators discover it via the `~/.claude/plugins.json` reference + dotfiles repo browsing. This ADR records:

1. **What the plugin is + what it ships** (skill list + verb mapping).
2. **The dotfiles-flow ownership boundary** (atmux team must NOT touch it, per the existing memory entry).
3. **The architectural parallel with epic-team dynamic discovery** ([ADR-185](./185-sentinel-dynamic-epic-discovery.md)) — atmux deliberately does not pre-register the skill list; the operator's Claude Code installation discovers it via the plugin manifest at use-time.

### Where the plugin lives

```
~/work/journals/.sb/claude-skills/plugins/coordination/
├── plugin.json                          # Claude Code plugin manifest
├── skills/
│   ├── bau/                              # /bau — status snapshot
│   ├── bruh/                             # /bruh — unblocker sweep
│   ├── budget/                           # /budget — rate-limit probe
│   ├── heads-up/                         # /heads-up — lightweight nudge
│   ├── session/                          # /session — continuity verbs
│   ├── superdoctor/                      # /superdoctor — self-healing loop
│   ├── team/                             # /team — lifecycle
│   ├── tell-lead/                        # /tell-lead — driver→lead ask
│   └── whip/                             # /whip — nudge loop
```

The plugin ships via the operator's dotfiles flow (`~/work/journals/.sb/_dotfiles` → `dotfiles push` writes to `$HOME/.claude/plugins/coordination/`). Claude Code picks up the manifest on launch via the `~/.claude/plugins.json` registration.

### Why this is in atmux's docs tree at all

The plugin is operator-side (dotfiles territory) but architecturally paired with atmux — most skills call `atmux` verbs underneath. Without an ADR here, the pairing is invisible from inside the repo. Two paths could rot:

1. An atmux verb signature change breaks a skill silently (e.g. `atmux send` flag rename); operators only notice when the skill stops working.
2. A new atmux verb that should be skill-exposed (e.g. `atmux release` 2026-05-20) lands without a paired skill update; the operator surface lags.

This ADR is the cross-reference — atmux changes that touch skill-exposed verbs MUST cite this ADR + flag the operator for a dotfiles update (NOT direct-edit the plugin).

## Decision

### D1 — Skill ↔ atmux verb mapping (canonical)

The plugin ships 9 skills; the mapping below is the canonical contract. Verb-side changes to anything in the right column MUST surface a "skills plugin update needed" reply to the driver.

| Skill | Trigger | Behavior | atmux verb(s) it wraps |
|---|---|---|---|
| `/bau [hours] [--no-fix]` | Start-of-session, status snapshot | Per-team commit cadence / rate-limits / kanban / churn. Default 24h window. Escalates Dormant teams to lead via `atmux send`. | `atmux status / report` (read-only); `atmux send <lead>` for escalation |
| `/bruh` | End-of-day unblocker pass | Sweeps pending decisions / blockers / flags / worktrees in one pass. Unblock all, approve all, flip all. | `atmux flags / decisions / inbox` (read + write) |
| `/budget` | Diagnostic | 5h + weekly rate-limit utilization + reset times across every Claude account. Auto-refreshes expired OAuth tokens. | Pure-shell (Anthropic API direct) |
| `/heads-up <message>` | Cross-pane nudge | Lightweight notification — atmux supervisor pings teammates about new tasks, cascade unblocks, inbox updates. | `atmux send` (best-effort) |
| `/session [verb]` | Phase boundary | Session continuity (`cont` / `preclear` / `handoff` / `stop`). | `atmux handoff` + native shell |
| `/superdoctor` | Hourly cockpit-level self-healing | Diagnosis-and-prevention loop. Detects anomalies via `atmux doctor` + `atmux status` JSON; files complaints; rotates lead / clears member as needed. | `atmux doctor / status` (read); `atmux complaints / rotate-lead / clear` (write) |
| `/team <verb>` | Lifecycle | `start / stop / add / clear / cleanup / bootstrap / rotate-lead / rotate-member`. | `atmux team` (start / stop / add-member / rotate / rotate-lead) |
| `/tell-lead <message>` | Driver → lead durable ask | Writes to `.atmux/driver-inbox.md` + best-effort pane wake-up. Explains the two listener-absent warnings as expected output. | `atmux tell-lead` |
| `/whip [verb]` | Autonomous-work nudge loop | `run` (default, autonomous-work nudge) / `cadence` (tune re-arm interval) / `watchdog` (liveness one-shot). | `atmux whip` |

### D2 — Ownership boundary: dotfiles territory

Per the existing memory auto-memory `feedback_claude_skills_dotfiles_territory` (2026-05-15) — the atmux team **MUST NOT** touch `~/work/journals/.sb/claude-skills/plugins/coordination/`. Specifically:

- Lead must not escalate "skill X broken" as an atmux PR or atmux-side fix Task.
- Members must not direct-edit the plugin from inside an atmux cage.
- The escalation path is **always** driver / operator with a dotfiles-flow ask (`atmux reply` from member → driver → operator pushes dotfiles).

The reverse boundary holds too — the skills plugin is documented here, but its development happens in the dotfiles repo, not in this one.

### D3 — No-static-registration parallel with ADR-185

ADR-185 (sentinel dynamic epic-team discovery) argues that high-churn entities should be discovered at use-time, not pre-registered. The skills plugin applies the same principle on the operator side:

- atmux does NOT keep an authoritative list of which skills exist.
- The operator's Claude Code installation reads the plugin manifest at launch time and registers the skill surface itself.
- New skills land in the dotfiles repo; operators redeploy via `dotfiles push`; Claude Code picks them up next launch.

Both surfaces — atmux's dynamic epic-team discovery + the operator's plugin manifest — sit at the same architectural boundary: the cockpit/operator seam. Cross-side coordination is via the documentation cross-reference (this ADR ↔ ADR-185 ↔ the dotfiles README), not via shared state. Keeps the cross-side coupling thin.

### D4 — Updates to this ADR when the skill surface changes

When a skill is added / renamed / removed in the dotfiles repo:

1. Operator updates this ADR's §D1 mapping table in the same dotfiles-push cycle (ADR sits in atmux repo; cross-repo coordination via PR or commit pairing).
2. README §Coordination skills plugin table mirrors the §D1 contents — kept in sync via the same PR.

When an atmux verb that a skill wraps changes signature / semantics:

1. The atmux-side change cites this ADR + flags "skills plugin pairing affected" in the commit body.
2. Reviewer surfaces the pairing risk via `atmux reply` to driver.
3. Driver coordinates the dotfiles-side fix; atmux-side change does NOT block on it (skills are operator-surface; atmux verb semantics ship independently).

## Consequences

### Positive

- **Documented pairing surface.** The atmux ↔ skill-plugin contract is now visible from inside the repo; verb-change reviews can cite this ADR + flag affected skills.
- **Codifies the dotfiles boundary.** The 2026-05-15 memory rule (atmux must not direct-edit claude-skills) is now an ADR; future agents won't relearn it the hard way.
- **Architectural parallel with ADR-185.** The "discover at use-time, not pre-register" principle is articulated once and applied on both sides of the cockpit/operator seam.

### Negative

- **Cross-repo coordination cost.** A skill rename in dotfiles requires an ADR amendment + README update in atmux. The two-step is intentional friction — keeps the documented contract in sync — but it's not zero.
- **No automated detection of contract drift.** If a verb's signature changes without flagging the skill side, no test catches it. v1 relies on reviewer discipline + the §D4 flag-on-change rule. Future work could add a lint that grep-checks atmux verb signatures against the skills' command invocations, but that's out of scope.

### Neutral

- **Plugin lifecycle ownership.** The plugin's development cadence (skill additions, bug fixes) lives in the dotfiles repo; atmux releases don't gate on it. The two repos move at independent cadences; this ADR is the synchronization point, not a release dependency.

## Trade-offs considered

### Why not "vendor the skills plugin into atmux/templates/"

Considered. Rejected — the plugin is operator-side configuration (`$HOME/.claude/plugins/`), not a runtime artifact atmux ships. Vendoring would mean every atmux install ships the operator's skill set, even for atmux users who don't use Claude Code. Worse, it would invert the ownership boundary (atmux would suddenly own the operator's skill surface, contradicting the dotfiles-territory memory rule).

### Why not "auto-detect skill presence from `$HOME/.claude/plugins.json`"

Considered (e.g. `atmux doctor` probe `coordination-skills-installed`). Rejected — atmux must NOT probe operator dotfiles. The plugin is optional; some operators use atmux without Claude Code at all (cursor-only / opencode-only setups). A probe would imply atmux cares whether the plugin is installed; this ADR's whole point is that atmux deliberately does NOT care.

### Why not "fold the skill list into README.md without an ADR"

Considered. Rejected — README documents user-facing atmux surface; the skills plugin is a sibling surface, not an atmux surface. README §Coordination skills plugin is a 1-page pointer + table; ADR-187 is the design record (why the surface exists, ownership boundary, change-coordination protocol). Both serve different audiences.

## Implementation plan

This ADR is documentation-only. Same-commit deliverables (per CLAUDE.md docs-discipline):

1. **`docs/adr/187-coordination-skills-plugin.md`** — THIS file (proposed status).
2. **`README.md` §Coordination skills plugin** — operator-facing pointer + skill ↔ verb table. Mirrors §D1.
3. **`docs/RUNBOOK-cockpit.md` §9 Operator coordination skills** — when-to-use cheatsheet + dotfiles install snippet.
4. **`docs/PRD.md`** — no change (PRD is atmux-surface-only; the skills plugin is sibling-surface).
5. **`CHANGELOG.md` [Unreleased]** — entry under the 2026-05-20 release-sweep group naming ADR-187 + cross-refs.

Reviewer flips proposed → accepted on signoff. No code changes; no test changes.

## Out of scope

- **In-repo skill source.** Skills live in the dotfiles repo; this ADR documents the pairing, not the source.
- **`atmux skills install` verb.** Operators install via dotfiles flow; atmux does NOT manage the install lifecycle.
- **Automated drift detection.** Per §Consequences-Negative, deferred to a future Task if reviewer-discipline-only proves insufficient.
- **Skills for non-coordination concerns.** Other plugin surfaces (e.g. `frontend-design`, `adr`, `claude-api`) are out of this ADR's scope — they pair with other tools (general dev, claude-api docs), not with atmux specifically.

## Open questions

None at write time. The ownership boundary is well-established (memory rule from 2026-05-15); the architectural pairing is now documented; reviewer-discipline catches drift via §D4. If verb-signature drift produces a real bug in production, revisit with the automated-lint candidate from §Consequences-Negative.

## Amendments

### 2026-08-07 — D1's `/session` verb set is `cont` / `handoff` / `stop` (ADR-263)

[ADR-263](263-merge-session-preclear-into-handoff.md) merges the `/session preclear` verb into `/session handoff` — one mode-aware verb, no `preclear` alias. D1's skill ↔ atmux verb mapping row for `/session [verb]` reads **"Session continuity (`cont` / `handoff` / `stop`)"** — 4 verbs collapse to 3. The row's atmux-verb backing (`atmux handoff` + native shell) and every other row in the 9-skill mapping are unchanged. This amendment is itself the D4 discipline in action: the skill's verb surface changed, so the canonical mapping is updated in the same wave.
