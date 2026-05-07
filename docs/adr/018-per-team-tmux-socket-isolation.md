# ADR-018: Per-team tmux socket isolation — opt-in via `team.tmuxTmpdir`

**Status**: accepted
**Date**: 2026-04-27

## Context

Today every atmux team shares the user's main tmux server at `/tmp/tmux-$UID/default`. Both `myteam-alpha` and `atmux-kanban` ran on the same socket as the driver's daily-driver shell sessions and worktree windows. Two failure modes this exposes:

- **Blast radius on dangerous tmux ops.** atmux is in active development; a buggy `tmux kill-session -a` from a malformed `lib/stop.sh` change, or `atmux start --force` against the wrong team, can nuke unrelated sessions (other worktree shells, myteam-alpha, the user's daily REPL).
- **Pre-existing precedent in the test sandbox.** `tests/helpers/setup.bash` already exports `TMUX_TMPDIR=$ATMUX_TEST_TMP/tmux` so test churn never touches `/tmp/tmux-$UID/default` — incident 2026-04-25 (mass per-pane teardown wedged tmux 3.x). The same pattern applies one level up: the dev-on-itself team that's editing atmux internals deserves the same blast-radius firewall.

Three implementation shapes considered:

- **A (chosen)** — opt-in `team.tmuxTmpdir` field in `team.json`. `bin/atmux` reads it before any verb dispatch and exports `TMUX_TMPDIR` early. `lib/cron.sh` includes the env var in every emitted cron line. Default: unset → shared socket (today's behaviour).
- **B (rejected)** — make per-team isolation the default. Breaks every existing user's mental model + tmux-attach workflow (they'd have to `tmux -S /tmp/atmux-tmux_<team>/default attach` instead of `tmux attach`). Aggressive flip-default change for a benefit only the dev-on-itself team needs.
- **C (rejected)** — auto-isolate based on a heuristic (e.g. team name == repo dir basename → dogfooding team). Magic detection that's almost always wrong; explicit opt-in is clearer.

The interaction with ADR-016 (single-session topology) is benign: `singleSession=true` + `tmuxTmpdir` set means windows live in the driver's session **on the team's isolated socket**. Driver who opts into both attaches via `tmux -S <tmpdir>/tmux-$UID/default attach`. The two flags are orthogonal; neither implies the other.

## Decision

**Add OPTIONAL `tmuxTmpdir` field to team.json schema.** When set:

- `bin/atmux` exports `TMUX_TMPDIR=<value>` immediately after team-dir resolution, BEFORE sourcing `lib/common.sh` or invoking any verb that touches tmux. `mkdir -p "$value"` runs first; missing directory is auto-created (consistent with how `atmux_setup_sandbox` operates). Precedence: existing `$TMUX_TMPDIR` env > team.json `.tmuxTmpdir`.
- `lib/cron.sh::_atmux_cron_render_lines` prepends `TMUX_TMPDIR=<value>` to each `whip` / `report` / `decisions digest` line when the field is non-empty. Otherwise cron lines are unchanged. Without this, whip cron looks at the wrong server and reports session DOWN forever.
- `lib/doctor.sh` adds `_doctor_check_tmux_tmpdir`: when the field is set, asserts the directory is writable + (if a session exists) `tmux -S <tmpdir>/tmux-$UID/default ls` succeeds. Yellow on writable-but-no-session (cold start), green on healthy, red on unwritable / wrong-socket-detected.
- `lib/init.sh` wizard does NOT prompt for `tmuxTmpdir`. Opt-in is manual `team.json` edit; documented in README. (Wizard bloat avoided; the field is for advanced/dogfooding setups.)

After this Epic ships, set `tmuxTmpdir: "/tmp/atmux-tmux_atmux-kanban"` in `/root/work/src/atmux/.atmux/team.json` (the dev-on-itself team) + restart atmux-kanban on its own socket. `myteam-alpha` stays on the main socket (it's not the dev-on-itself team).

## Consequences

- **One new schema field.** Optional, ignored when absent — zero impact on existing teams.
- **bin/atmux gains ~12 LOC** for the early TMUX_TMPDIR resolution.
- **lib/cron.sh::_atmux_cron_render_lines gains ~4 LOC** to prepend the env var conditionally.
- **lib/doctor.sh gains one row + ~30 LOC.**
- **README** documents the opt-in: when to use, how the cron lines change, how to attach (`tmux -S /tmp/<tmpdir>/tmux-$UID/default attach`).
- **Driver attach UX changes** for opted-in teams: bare `tmux attach` no longer reaches the team. `atmux attach` (lib/attach.sh) already routes through `atmux::session_name`; we extend it to also honour `TMUX_TMPDIR` (no change needed if the env var is set globally before attach runs — which it is, via bin/atmux).
- **Rollback path**: remove the field from team.json + restart. Cron lines re-render without the env var on next `atmux start`. No data migration; tmux state is ephemeral.

## Open questions

1. **OQ3: auto-create `tmuxTmpdir` if missing?** Resolved: yes — `mkdir -p` in bin/atmux. Consistent with `atmux_setup_sandbox`. (low-rev.)
2. **OQ4: should init wizard prompt for tmuxTmpdir?** Originally resolved NO. **Reversed 2026-04-27** (see amendment below). Wizard now defaults to cage isolation with explicit prompt + opt-out; `bin/atmux-tmux` ships as a sibling binary that resolves the socket from team.json so operators never type the path. Original reasoning ("advanced dogfooding only") was invalidated by 6 daily-driver tmux deaths in 5 days from teams sharing the operator's default socket.
3. **Out-of-scope carve-out**: `lib/attach.sh` does NOT need a `-S <socket>` plumbing change because bin/atmux exports `TMUX_TMPDIR` globally before attach runs. If a future ADR allows attaching to a team WITHOUT going through the bin/atmux entrypoint (e.g. systemd user service), revisit this.

All resolutions logged to `.atmux/decisions.md` via `atmux decisions add`.

## Amendment — 2026-04-27 (cage-isolation as wizard default)

After 6 daily-driver tmux deaths (2026-04-22 through 2026-04-27), the original "advanced dogfooding only" framing is wrong. Every actively-iterated team — not just dogfooding — benefits from the blast-radius firewall. Concrete change set:

- **Wizard prompts for cage isolation, default `y`** (`lib/init.sh` adds `_atmux_prompt_choice cage_isolation` after the singleSession block). Auto-derives path as `/tmp/atmux-tmux_<team>` (note the naming change from the OQ3-era `/tmp/atmux-tmpdir-<team>` for consistency with the `atmux-tmux` binary name; separator between prefix and team is underscore — see addendum 2026-04-30).
- **Template-init code path** (`atmux init` non-wizard) also uses `/tmp/atmux-tmux_<team>` by default. No opt-out at template-init level — too rare a use case to warrant a flag.
- **`bin/atmux-tmux` ships as a sibling binary.** Walks up from CWD to find `.atmux/team.json`, reads `.tmuxTmpdir`, exec's `tmux -S <tmpdir>/tmux-$UID/default "$@"`. Falls back to bare `tmux` outside any atmux project, so it's a transparent drop-in. `install.sh` symlinks it alongside `atmux`.
- **Wizard tip-block** on completion shows the cage path, the `atmux-tmux attach` command, and a one-line note that all atmux verbs invoked from the project dir auto-target the cage.
- **Naming convention**: `/tmp/atmux-tmux_<team>` — `<team>` is the team.json `.name` field verbatim, joined with an underscore (separator convention: underscore between domains, hyphen reserved for within-name compounds; see addendum 2026-04-30). The existing `atmux` dogfooding team uses the bare `/tmp/atmux-tmux` (no suffix) because the team is literally named `atmux` and the doubled `atmux-tmux_atmux` was awkward; this is the only allowed deviation from the convention.
- **Opt-out path stays**: declining the wizard prompt omits `tmuxTmpdir` from team.json entirely → bin/atmux's `_atmux_resolve_tmux_tmpdir` early-returns (operator-empty TMUX_TMPDIR) → team falls back to default socket. For observer-only teams that never run destructive verbs, this is fine.

The 4-team migration that motivated this amendment (`atmux`, `myteam-beta`, `myteam-alpha`, `myteam-c` all moved from default socket to per-team cages on 2026-04-27) is the canonical rollout reference.

## Amendment — 2026-04-30 (separator convention: underscore between prefix and team)

The 2026-04-27 amendment introduced the cage-tmpdir path but used a hyphen between the multi-word prefix (`atmux-tmux`) and the team name (`myteam-c`, `myteam-beta`), producing `/tmp/atmux-tmux-myteam-c` — three separators of mixed type in one path. Driver flagged this on 2026-04-28 as a convention violation; canonical convention (memory: `feedback_path_separator_convention.md`) is **underscore between domains, hyphen within a name**:

- `atmux-tmux` is one domain (compound name, internal hyphens).
- `<team>` is another domain (own internal compound: `myteam-c`, `ifca-myteam-beta`, etc).
- The boundary between them is a domain boundary → underscore.

Canonical form going forward: `/tmp/atmux-tmux_<team>` (e.g. `/tmp/atmux-tmux_myteam-c`, `/tmp/atmux-tmux_ifca-myteam-beta`). Code change set (this ADR's amendment commit):

- `lib/init.sh:100` (template default) — `"/tmp/atmux-tmux-" + $name` → `"/tmp/atmux-tmux_" + $name`.
- `lib/init.sh:236` (wizard cage path) — `"/tmp/atmux-tmux-$team_name"` → `"/tmp/atmux-tmux_$team_name"`.
- `templates/team.example.json:4` — `/tmp/atmux-tmux-my-team` → `/tmp/atmux-tmux_my-team`.
- README §Per-team tmux socket isolation — example + raw-tmux fallback now show underscore form.

**Live-state migration was deferred** in the original 2026-04-30 amendment landing — see "Live-state migration is now executable" amendment 2026-05-02 below. Existing on-disk cages at amendment time (`/tmp/atmux-tmux-aux`, `/tmp/atmux-tmux-myteam-beta`, `/tmp/atmux-tmux-myteam-alpha`, `/tmp/atmux-tmux-myteam-c`) were left intact pending tooling. Future-team scaffolds + wizard runs naturally produce the corrected form starting from this amendment.

**Dogfood `atmux` carve-out unchanged.** Bare `/tmp/atmux-tmux` (no suffix) for the literally-named-`atmux` team stays — the corrected path would be `/tmp/atmux-tmux_atmux` which still has the doubled-name awkwardness the original carve-out avoided. Hand-edited team.json continues to maintain the bare path; wizard default for a hypothetical new `atmux` team would now produce `/tmp/atmux-tmux_atmux` (acceptable; less awkward than the old `/tmp/atmux-tmux-atmux` because the underscore visually separates the doubling).

Test coverage: `tests/unit/init_cage_tmpdir_separator.bats` asserts both code paths (template + wizard) emit the underscore form for a multi-word team name.

## Amendment — 2026-05-02 (live-state migration is now executable via `atmux audit`)

The 2026-04-30 amendment deferred live-state cage-tmpdir migration to the driver's manual quiet-window invocation. With ADR-038 (declarative-vs-live audit model) and ADR-040 (whip-audit integration) landing, the migration is now executable as a verb:

- **Class B** in the audit class taxonomy (ADR-038 §Drift class taxonomy) is exactly this drift: `team.json:.tmuxTmpdir` matching the old hyphen form `/tmp/atmux-tmux-*` instead of the canonical `/tmp/atmux_tmux_*`.
- **Detection**: `atmux audit --json` lists each drifted team as a class-B finding.
- **Fix**: `atmux audit --fix --class b` wraps `lib/team-repair-rename.sh` (ADR-027 ADDENDUM 11). Atomic per team with rollback log at `.atmux/state/repair-rename-rollback.log`.
- **Gating**: class B is HIGH blast radius. Whip surfaces with `⚠️` + ready-to-fire command; **never auto-fires**. Driver invokes manually per team.

Operator runbook for the four pending hyphen-form cages:

```bash
# Inspect drift (no mutation)
atmux audit --class b

# Per-team manual fix (driver invokes; high-blast)
cd /root/work/src/atmux/teams/<team>
atmux audit --fix --class b --dry-run   # review plan
atmux audit --fix --class b              # apply
```

The wizard + template paths from the 2026-04-30 amendment continue producing the underscore form for new teams; the audit verb addresses the live-state legacy. The ADR-038 class taxonomy is the durable home for this drift class; future cage-path naming changes amend ADR-038's class table rather than this ADR.
