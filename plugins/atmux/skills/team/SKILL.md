---
name: team
description: Unified team lifecycle skill. Verbs — start, stop, add, clear, cleanup, bootstrap, rotate-lead, rotate-member. Use /atmux:team <verb> [args].
argument-hint: <verb> [verb-args…]
---

<!-- carved per ADR-217 §D4 + §D1.5 substrate remediation 2026-05-21 -->

# /atmux:team — Unified Team Lifecycle

Wraps atmux's actual team-lifecycle CLI surface (`atmux start`, `atmux stop`,
`atmux add-member`, `atmux rotate`, `atmux rotate-lead`, `atmux cleanup`,
bare `atmux` for bootstrap). State lives in `.atmux/team.json` (config)
and `.atmux/state.db` (inboxes + tasks + epics per ADR-076). The
plugin.json contract advertises eight verbs (start / stop / add / clear /
cleanup / bootstrap / rotate-lead / rotate-member) — each maps to a
canonical atmux invocation below.

## Shared preamble (every verb)

1. **Parse verb.** First arg = verb. Unknown → error:
   `"Usage: /atmux:team <verb> [args]. Verbs: start|stop|add|clear|cleanup|bootstrap|rotate-lead|rotate-member"`.
2. **Detect team.** Atmux walks up from `$PWD` for `.atmux/team.json`
   (override via `ATMUX_DIR` per `atmux --help` environment). Override the
   team name only when invoking from outside the cage (`ATMUX_TEAM=<name>`).
   If neither resolves, error: `"No team defined. Run atmux init in the
   project root."`
3. **Dispatch to the verb body.**

All examples assume you've already `cd`-ed into the project root that holds
`.atmux/`. Per-cage isolation: each team owns its own tmux session named
`atmux-<team-name>` on its own socket (per ADR-026 + ADR-162); the verbs
below pick up the right session automatically.

---

## Verb — `start`

Bring the team up: create the tmux session, spawn every member, attach
each pane's claude TUI to the brief in `templates/briefs/<role>.md`.
Auto-adds the cockpit viewer window if the team is rostered + enabled in
`~/.atmux/cockpit.json` (per ADR-063).

```bash
atmux start
```

Idempotent on a team that's already up — atmux runs `doctor` first; if
the session exists and panes are healthy, `start` is a no-op + prints
`team is up`. Combine with `atmux doctor --fix` before `start` to clear
known structural issues.

For a brand-new project use `atmux init --name <team>` first to scaffold
`.atmux/team.json` (template lives at `templates/team.example.json`).

---

## Verb — `stop`

Tear down the team. Two flavours per ADR-087:

```bash
atmux stop --soft       # graceful: notice every pane, grace window,
                        # write state/resume.json, NO worktree prune.
atmux stop --force      # hard: kill the tmux session immediately.
```

`--soft` is the default operator path — it lets members commit / push
in-flight work before the session dies. `--force` is for stuck sessions
that didn't respond to the soft path. Both archive the team's state
(`.atmux/state.db` rows + kanban rows in `archive/`) so a later
`atmux start` resumes cleanly.

> **Per ADR-212 §D2** soft-stops are lead-gated for cockpit-tier teardown.
> Operator-side `atmux stop --soft` from inside a team's cage is fine; the
> lead-gating applies to the cockpit driver pane initiating fleet-wide
> teardowns (use the host-pressure playbook from ADR-198 for those).

---

## Verb — `add`

Spawn a new member into a running team. Maps directly to:

```bash
atmux add-member <name> --role <role> --tui <claude|cursor> \
  [--model claude-opus-4-7] [--cwd <project-root>] [--command <override>]
```

`add-member` appends the entry to `.atmux/team.json:.members[]`, creates
the per-member inbox row in `.atmux/state.db`, and spawns the tmux
window. Role values (canonical): `lead`, `planner`, `reviewer`, `member`,
`gitter`, `dba`, `devops`, etc. — see `templates/briefs/*.md` for the
full set.

One-shot add without restarting siblings:

```bash
atmux add-member fe-3 --role member --tui claude --model claude-opus-4-7
```

The member's branch (`<base>-<name>`) is created lazily by their first
commit; nothing to pre-provision.

---

## Verb — `clear`

Soft-reset one member's conversation context AND re-brief them in place.
Their tmux window + branch + worktree survive; only the claude TUI's
in-memory turn history is wiped. Use when a teammate is confused,
holding stale assumptions, or drifting.

```bash
atmux rotate <member>
```

`atmux rotate` (per the top-level verb surface) sends `/clear` to the
target pane, waits for idle, then writes the role brief back through.
Refuses if the pane isn't running claude (won't clobber a shell).

Distinct from `rotate-member` (below): `clear` discards in-flight context;
`rotate-member` is the hygienic refresh that preserves the thread via a
checkpoint. Pick `clear` when past context is actively unhelpful.

---

## Verb — `cleanup`

Sweep the team's state directories: rotate big log files, prune stale
`done[]` entries in member inboxes (state.db rows), drop aged-out `.bak`
files. Atmux exposes this as the maintenance verb `atmux cleanup`:

```bash
atmux cleanup logs                  # rotate .atmux/logs/*.log only
atmux cleanup inboxes               # prune done[] in per-member inbox rows
atmux cleanup all                   # both
atmux cleanup all --dry-run         # preview without writing
atmux cleanup all --max-age-days 14 # tune the prune window
```

Idempotent + cron-safe. Combined with `atmux groom` (the daily 04:00 cron
sweep) this keeps state.db + logs from growing unbounded. For full
teardown of an unwanted team, use `atmux stop --soft` followed by manual
removal of the project root.

---

## Verb — `bootstrap`

First-run bring-up of a team — equivalent to running bare `atmux`:

```bash
atmux                               # wizard (if no team.json) → doctor → start → attach
```

The bare-verb form routes through the install wizard (per ADR-200) on
first run, runs `atmux doctor` to surface structural issues, then
`atmux start` to spawn members, then `atmux attach` to put the operator
into the lead pane. Use this on a fresh checkout or a new project root.

If the team is already initialized + running, bare `atmux` is equivalent
to `atmux attach` — no destructive side effects.

---

## Verb — `rotate-lead`

Retire the current team-lead cleanly + re-brief a fresh one in place.
The lead's window + PID survive (claude `/clear` + re-bootstrap); only
the in-memory turn history is wiped.

```bash
atmux rotate-lead
```

The verb writes a handoff snapshot to `.atmux/state/lead-handoff-<epoch>.md`
before clearing so the fresh lead has a primer. Use when the lead's
context is heavy (uptime > rotation threshold OR self-compaction banner
visible) but teammates are productive — clearing teammates would lose
their in-flight work; rotating the lead is targeted.

For cockpit-tier role rotation — the `medic` window at W2 (auto-spawn
role retired per ADR-212, but the probe substrate + session-name slot
persist for the host-pressure playbook in ADR-198), `sentinel` at W3,
or team-driver panes at W4+ per ADR-167 — use:

```bash
atmux cockpit rotate <session-name> [--force]
```

That path enforces the four pre-flight gates (user-not-typing /
pane-idle / uptime / never-rotate-superdriver) and refuses
`superdriver` unconditionally. `atmux cockpit rotate` requires
`ATMUX_CALLER_SCOPE=driver`.

> Note on naming: per ADR-133 the cockpit role formerly known as
> `superdoctor` was renamed `medic` (then per ADR-212 the auto-spawn
> retired, probe substrate persisted). ADR-158 renamed the
> uptime-rotation-manager role to `sentinel`. The driver pane retains
> its own lifecycle and is never rotated by these verbs.

---

## Verb — `rotate-member`

Hygienic context refresh for a productive-but-bloated member — same
pane, same branch, fresh claude turn history, but with a checkpoint
preserving in-flight intent.

```bash
atmux rotate <member>
```

Atmux's `rotate` verb covers both `clear` and `rotate-member` at the
substrate level; the operator-intent distinction is in WHEN to invoke:

| Situation | Verb |
|---|---|
| Member confused, drifting, holding stale assumptions | `clear` (state-discarding) |
| Member productive but context past uptime threshold | `rotate-member` (hygienic) |
| Lead specifically heavy; teammates productive | `rotate-lead` |
| Move in-flight work to a different member | `atmux handoff <from> <to>` |

For label / display-name changes (per ADR-136 hot-rename) without
clearing context, use `atmux member rename <id> --label <new>`. The
sentinel cockpit role (per ADR-158) auto-fires rotations on the uptime
threshold for enabled teams — operator-side this verb is the manual
equivalent.

---

## Adjacent atmux verbs (cross-link reference)

The `/atmux:team` skill stays focused on the eight plugin.json-advertised
verbs. For neighboring lifecycle work, reach for these directly:

- `atmux init [--name <team>]` — scaffold `.atmux/team.json` in a fresh
  project (Phase 2 MVP path; `--wizard` deferred per ADR-010).
- `atmux reconfigure` — re-run the wizard against an existing team.json
  (per ADR-200).
- `atmux team spawn-epic <epicId> --from <parent>` — spawn an ephemeral
  epic-team child (driver-scope only per ADR-033).
- `atmux team dissolve-epic <epicId>` — tear down a spawned epic-team.
- `atmux team sweep-epics [--apply]` — classify + dissolve idle epic-teams
  (per ADR-170).
- `atmux team repair-rename` — fix a stale team-rename state.
- `atmux member move <id> --to <pos>` / `atmux member swap <a> <b>` /
  `atmux member sort` — window ordering (per ADR-161 §C + ADR-216).
- `atmux cockpit rebuild` / `atmux cockpit rotate` — cockpit substrate
  ownership (per ADR-063 + ADR-167).

## Driver-inbox + lead-outbox (driver/lead I/O channels)

Operator → lead messages land in the team's driver-inbox via:

```bash
atmux tell-lead "<message>"         # driver-only: writes to .atmux/driver-inbox.md + pings lead
```

Lead/member → driver replies via:

```bash
atmux reply "<message>"             # writes to .atmux/lead-outbox.md
atmux outbox [--ack] [--json]       # driver reads lead-outbox (--ack archives)
```

These channels are persisted markdown (`driver-inbox.md` + `lead-outbox.md`
live inside `.atmux/`), distinct from the kanban + per-member inbox rows
in `state.db`.

## Hard rules

- **Only ever touch `atmux-<team-name>` tmux sessions** — never other
  teams' sessions or unrelated tmux servers.
- **Don't bypass `atmux stop`** with raw `tmux kill-session`. The
  archive step + `state/resume.json` write are load-bearing for the
  next `atmux start`.
- **Inbox + kanban state is in `.atmux/state.db`** (per ADR-076).
  Never grep legacy per-member `.atmux/inboxes/` JSON files — they were
  eliminated at atmux 0.5.0; the per-member markdown views that may
  persist under `.atmux/inboxes/<m>.md` are NOT canonical, just a
  read-only render of the state.db row.
- **Lead is window 2** under Driver Mode; driver lives at window 1; the
  cockpit viewer is added at the end of the window list per ADR-063.
  `atmux member move`/`swap`/`sort` reorder the rest without disturbing
  these two anchors.
- **Lead rotation per ADR-167** uses `atmux cockpit rotate` for cockpit
  roles + bare `atmux rotate-lead` for the in-team lead. The two
  paths are NOT interchangeable; check the role's scope before
  invoking.

## Operator-facing report format (attention + verdict)

Every verb finishes with a one-block summary so the operator knows
whether to act, wait, or move on. Markers (per ADR-086):

- **Top-line** — ✅ clean / ⚠ partial / 🔴 failed.
- **👁** prefix on follow-up lines — operator-action-required.
- **ℹ** — neutral observation.

Per-verb verdict-derivation:

| Verb | ✅ | ⚠ | 🔴 |
|------|---|---|----|
| `start` | every member spawned + lead bootstrap landed + first dispatch fired | some members spawned but ≥1 stuck on welcome-screen / `zsh` after retry | tmux session itself failed to create |
| `stop` | all panes drained clean, archive written, session reaped | some force-killed (count them out) | session couldn't be killed; resume.json missing |
| `add` | new member spawned + first-input absorbed + lane assigned | spawned but first-input retry pending | spawn failed (welcome-screen-stuck, zsh, paste-buffer rejected) |
| `clear` | member /clear'd + re-bootstrap brief delivered + pane shows `❯` | /clear ack'd but bootstrap brief didn't paste cleanly | member pane wedged before /clear could fire |
| `cleanup` | all reported targets rotated / pruned | some rotated but ≥1 file failed (read-only / busy) | state dir not writable, can't enumerate |
| `bootstrap` | wizard → doctor → start → attach all green | start green but doctor surfaced yellows the operator should see | wizard refused (existing team.json without --force) |
| `rotate-lead` | handoff written + /clear + re-bootstrap all landed; lead `❯` with fresh ctx | handoff written + /clear hung; lead pane in transitional state | lead pane wedged, rotate aborted, original state preserved |
| `rotate-member` | /clear + re-brief landed + member acks | /clear fired but brief delivery flaky (retry needed) | member wedged before /clear could fire |

Examples (drop-in for verb summaries):

```
✅ /atmux:team start (myteam) — 6 members + lead up
Roster: lead, planner, reviewer, fe-1, be-1, devops
Lead bootstrap: ack'd in 47s
First dispatch: t-1c7a556b → fe-1
```

```
⚠ /atmux:team rotate-member (planner) — checkpoint written, brief delivery flaky
Checkpoint: .atmux/state/rotate-planner-<epoch>.md
/clear: ack'd
Brief: paste-buffer flushed but pane shows truncation (last line cut at 73 chars)
👁 Re-paste brief manually from checkpoint OR re-run /atmux:team rotate-member planner
```

```
👁 🔴 /atmux:team start (myteam) — atmux start exited 1
Failure: atmux doctor surfaced 2 red rows blocking start
👁 Operator: run atmux doctor --fix, then re-invoke /atmux:team start
Roster: 0 / 6 spawned (no partial state to clean up)
```

**Anti-patterns:**

- ❌ Top-line `✅` while a `👁` line warns operator must do something.
  Worst-marker wins — downgrade.
- ❌ Reporting `✅ team started` after a partial-spawn without naming
  which members failed.
- ❌ Burying force-kill counts at the bottom of a long teardown narration.
  Surface them in the first 3 lines.
