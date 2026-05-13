# ADR-083: cron-install port scope — `atmux start` auto-install glue (refs ADR-051)

**Status:** proposed
**Date:** 2026-05-12
**Owner:** parity-cron-impl

## Context

`atmux start` (bash, `lib/start.sh:372-387`) installs a marker-fenced
crontab block as a non-fatal side effect: schedule whip / report (or
discorder pair) / decisions-digest / groom / optional unblocker / optional
whip-resume-check. The bun port has the **renderer** (`src/core/cron.ts`
— `renderCronBlock`, `renderCronLines`, config-driven schedules per
ADR-079§A, inline `PATH=` per bug t-2db59eee) but no **install glue**.

Operational consequence observed 2026-05-12: the atmux team was rebuilt
on hax during overnight dormancy recovery, and the post-rebuild crontab
shows **only** the sopx-root block — the atmux team has zero scheduled
whip/report/groom/decisions firings until `atmux start` is re-run from a
shell where install can actually happen, which is itself blocked
because `start.ts` has the install path stubbed (`src/verbs/start.ts:68-69`
TODO). The team will continue to drift dormant on every restart until
this glue lands.

Bash source totals ~270 LoC across `lib/cron.sh` install/strip helpers +
the `start.sh` call site. Per CLAUDE.md (`feedback_scope_adr_before_maximalist_port`):
> for verbs where bash LOC is >2x PLAN estimate, write scope ADR
> (in vs deferred) BEFORE TS code.

A naive 1:1 port would also drag in stop-side `cron_remove`, the
doctor-feeding `cron_orphans` JSON output, the `team-repair-rename`
Step 5 wiring, and a standalone `atmux cron-install` verb surface for
manual refresh. Stuffing all of those into one story risks the
"maximalist port" failure mode (ADR-040, ADR-080§B). This ADR carves
out a tight first cut.

## Decision

### IN (this story)

1. **`installCronBlock` in `src/core/cron.ts`** — pure-ish function:
   takes (current crontab, team, atmuxDir, atmuxBin, tmuxTmpdir?) →
   returns the new crontab string.
     - Strip 3 passes (bash parity): by team name, by atmux_dir (rename-
       orphan defense — see bash comment "observed to crash tmux
       servers under load 2026-05-06"), by bare pre-marker verb lines.
     - Append the freshly rendered block (re-uses existing
       `renderCronBlock`).
     - Prepend env preamble (SHELL/PATH/TERM) when the result contains
       any `# >>> atmux:team=` block and the preamble is not already
       present — addresses cron-bare-env tmux segfaults (ADR-051).
   No I/O. Pure transform on strings. Trivially testable.

2. **`src/abstractions/crontab.ts`** — DI seam for the host crontab.
   Two functions: `readCrontab(): Promise<string | null>` and
   `writeCrontab(body: string): Promise<void>`. Default impls shell
   `crontab -l` and `crontab <tmpfile>` (atomic swap via mktemp).
   `null` from read = "no crontab installed yet" (errno 1 from
   `crontab -l`). Test fixtures pass an in-memory pair.

3. **`atmux cron-install` verb** (`src/verbs/cron-install.ts`) —
   thin wrapper: load team.json + `kanban.cronAutoInstall` + bin
   resolver + tmuxTmpdir → call `installCronBlock` → write via
   `writeCrontab`. Exit 0 always (non-fatal posture matches bash —
   `crontab` not on PATH / binary unresolvable → warn + exit 0).

4. **Wire into `atmux start`** (`src/verbs/start.ts`) — after the
   team is up + `spawn-snapshot.json` written, call the install glue
   gated by `kanban.cronAutoInstall` (default true). `ATMUX_NO_CRON`
   env override short-circuits to exit-0 silently. Failures stderr a
   one-line warning; **never** abort `start`.

5. **Tests** — unit-test `installCronBlock` against fixture crontab
   inputs covering: idempotent re-install (byte-identical output),
   rename-orphan dedup, pre-marker bare-line strip, env preamble
   injection when absent, env preamble NOT duplicated when present,
   ATMUX_NO_CRON no-op, missing-crontab-binary no-op. Integration
   test for the verb uses the DI seam — no host crontab touched.

6. **`kanban.cronAutoInstall` schema field** — already implied by
   bash; add to `src/schema/team.ts` if not present, optional,
   default true.

### DEFERRED (follow-up stories — explicit handles)

| Item | Reason to defer | Handle |
|------|-----------------|--------|
| `atmux cron-remove` verb + `stop.ts` wiring | Stop-without-cron-remove leaves stale block firing `atmux whip` against a down session — benign (whip exits early on no-session). Add later. | New story `cron-remove port` after install lands. |
| `atmux cron-orphans` JSON output | Doctor consumer in a different lane; install dedup (strip-by-atmux_dir) already prevents the worst rename-orphan failure mode. | New story `cron-orphans for doctor`. |
| ~~`team-repair-rename.ts` Step 5 cron refresh~~ | **LANDED (2026-05-13, t-a126fbbc):** `src/verbs/team-repair-rename.ts` Step 5 now calls `cronInstall(["--quiet", "--team-dir", <dir>])` after step 4. Non-fatal — a thrown `cronInstall` is logged + skipped so step 6 still runs. Stub-injected via `opts.cronInstallFn` for tests. | Closed. |
| Schedule overrides beyond what ADR-079§A already supports | `whip.intervalMins` / `report.intervalMins` / `decisions.intervalHours` / `groom.atHour` / `unblocker.intervalMins` already land via renderer. Extra knobs (e.g. per-line PATH override beyond `team.cron.path`) — not requested. | Open new ADR if requested. |
| Bash bats `tests/unit/team_rename.bats` parity for the rename-orphan scenario | Bash bats parity tracker lives in lane=parity-state per ADR-029; not this story's lane. | Surface to lead for cross-lane parity coverage. |

### NOT IN (out of scope, no future handle)

- Multi-host crontab management — atmux is single-host by design.
- Systemd timer / launchd port — cron is the contract per ADR-018 and
  prior. Alternate schedulers are a separate ADR if ever desired.

## Acceptance

- `atmux start` on a fresh team installs the canonical block.
  Verified by `crontab -l | grep '>>> atmux:team=<name>'` returning the
  expected lines + env preamble.
- Re-running `atmux start` yields byte-identical `crontab -l` output
  (idempotence).
- A team-rename scenario (same atmux_dir, new team name) leaves
  exactly **one** block after install — no rename-orphan.
- `ATMUX_NO_CRON=1 atmux start` does not touch the host crontab.
- A host without `crontab` on PATH warns but does not fail `atmux start`.
- Atmux team on hax: after this lands, running `atmux start` against the
  rebuilt atmux team installs the missing cron block visible via
  `crontab -l | grep atmux:team=atmux`.

## Consequences

Once landed: every `atmux start` (atmux's own team, sopx, future teams)
gets the same scheduled supervision the bash era provided. The drift-on-
restart failure that surfaced this story disappears for any team that
runs `atmux start` post-cutover. Existing sopx-root block — untouched
unless an explicit re-install is fired (strip-by-team-name only matches
the team being installed).

Deferred items above remain *operational footguns* of varying severity:
the most painful is the missing `cron-remove` on `atmux stop` (stale
blocks fire forever until manually scrubbed), but the install-side
strip-by-atmux_dir pass prevents the historical tmux-crash failure mode.
