# ADR-233: Disable cron auto-install — orchd is the runtime, not cron

**Status**: Proposed (operator-driver-fired 2026-05-24 post-boot-storm; ship under driver in a single commit since the surface is bounded).
**Date**: 2026-05-24
**Driver-ref**: 2026-05-24 boot-storm incident on hax (1m loadavg 27 on 16-core box at uptime+90s) — root cause: 122 `unless-stopped` containers + k0s + 23 active `atmux:*` cron sandwich blocks all racing concurrently after reboot. Operator stance same session: *"atmux should never start when the server restarts. it is way too heavy"* + *"totally remove CRON if possible in favor of orchd"* + *"trust orchd to run, and orchd sweep should also go"* + *"kill atmux pulse, no need. if the cockpit is dead I will manually recreate it"*.

**Supersedes (in scope)**:
- [ADR-083](083-cron-install-port-scope.SUPERSEDED.md) — auto-install in `atmux start` retired; the verb itself stays for explicit operator use.
- [ADR-086](086-atmux-pulse.SUPERSEDED.md) — `atmux:cockpit` block install in `atmux cockpit rebuild` retired; cockpit-pulse helper stays exported but uncalled.
- [ADR-143](143-external-lead-rotation.SUPERSEDED.md) — cron-fired lead-rotation enforcer retired; on-demand `atmux rotate-lead` is the path forward. Stopgap shell script `cron-check-lead-rotate.sh` deleted.
- [ADR-134](134-in-team-auto-merger.md) §Triggers cron-backstop half — `committer --sweep` cron retired; `committer --daemon` + Honker events are the canonical path.
- [ADR-231](231-orchd-auto-spawn-and-solo-worker-dissolve.md) §D4 cron-backstop half — `orchd --sweep` retired; event-driven subscribers are sufficient.

**Cross-refs**: [ADR-202](202-honker-in-db-messaging-substrate.md) (Honker substrate — orchd's event source; replaces polling at ~1ms p50 wake latency), [ADR-211](211-retire-sentinel-role-distribute-to-honker-consumers.md) (sentinel retirement — same trajectory: continuous-observation pattern retired in favor of event-driven consumers), [ADR-224](224-orchd-rename-and-auto-spawn-loop.md) §D3 (cron-line sandwich-block idempotency — the surface this ADR mostly removes), [ADR-138](138-verified-send-keys.md) (paste-submit — superseded the send-keys-drop stopgap that `cron-resubmit-stuck-queue.sh` was patching), memory `feedback_no_ephemeral_containers_on_boot` (boot-storm root cause), memory `project_hax_reboot_bootstorm_2026_05_24` (incident timeline), memory `feedback_adr_atomicity_and_supersession` (the discipline this ADR + its supersession banners follow).

## Context

On 2026-05-24, hax rebooted into a multi-minute boot-storm: SSH appeared dead (auth stalled past default `ConnectTimeout`), nginx returned 502 (upstreams not ready), 1m loadavg peaked at **27 on a 16-core box** for ~3 min. Forensic teardown identified three concurrent stressors:

1. **122 docker containers** all on `restart: unless-stopped`, fan-out resurrected by dockerd.
2. **k0s controller** (single-node Kubernetes) enabled at boot — kube-apiserver + kine + controller-manager fan-up.
3. **23 active `atmux:*` cron sandwich blocks** in root crontab, each firing 5–13 lines per team, every 1–30 min — including `* * * * * atmux orchd --drain` for the atmux team (every minute, every team).

The operator's standing position across the post-incident debrief, in their own words:
- *"atmux should never start when the server restarts. it is way too heavy"*
- *"totally remove CRON if possible in favor of orchd running things"*
- *"there's no need for a CRON to unstuck or recreate anything because atmux is pretty stable and a rogue CRON doing things is more dangerous and unstable (like killing sopx from time to time)"*
- *"kill atmux pulse, no need. if the cockpit is dead I will manually recreate it"*
- *"orchd --drain not necessary. trust orchd to run. and orchd sweep should also go"*

The cron pile is a fossil layer from before Honker (ADR-202, 2026-05-21) and orchd (ADR-224, 2026-05-22) landed. Every line that orchd subsumes is now duplicative, and the duplication has gone from "harmless backstop" to "boot-storm amplifier + unwanted side-effect vector" (cron-check-lead-rotate killing sopx leads on 60-min rotation cadence is the canonical example).

The architectural prerequisites for this ADR are already on trunk:
- **Honker substrate** ships in-DB pub/sub at ~1ms p50 wake latency (ADR-202).
- **orchd Rust binary** subscribes via Honker `Database::listen`, idle RSS ~5 MB, kernel-blocked on the subscription iterator (ADR-224 §rust/atmux-orchd/src/main.rs).
- **`PR_SET_PDEATHSIG(SIGTERM)`** ties orchd's lifecycle to its parent tmux pane — kill the pane, orchd dies; no parent, no orchd. The tmux pane existence is the runtime arming signal (cleaner than a file sentinel — see ADR-211 trajectory for why we don't reintroduce file-sentinel patterns).
- **Cron-driven backstops** (`orchd --drain`, `orchd --sweep`, `committer --sweep`, `lane-tick`, `ombudsman tick`, `poke`, `pulse`) all have event-driven equivalents either shipped or designed under ADR-202 §D12 + ADR-211 §D2 + ADR-226/227/228.

Therefore: cron is no longer a load-bearing tier. It's a duplicative tier that adds boot-storm risk + the occasional rogue side effect.

## Decision

### D1 — `atmux start` no longer auto-installs the team cron block

Remove the `shouldAutoInstallCron(team, env)` gate + the `cronInstall(["--quiet", "--team-dir", cronTeamDir])` call from `src/verbs/start.ts` (currently at lines 1026–1037, ADR-083 §IN §4). The `kanban.cronAutoInstall` schema field stays (back-compat for one release; doctor surfaces dead config) but the runtime never reads it.

**Consequence**: After this ADR ships, running `atmux start <team>` writes zero crontab lines. The team comes up with cockpit, members, orchd window — and nothing in cron. orchd handles event-driven work; everything else is operator-on-demand (`atmux report`, `atmux groom --quiet`, etc. are still invokable manually).

### D2 — `atmux cockpit rebuild` no longer installs `atmux:cockpit` block

Remove the Phase 6 `installCockpitCron(opts, cockpit, logger, env)` call from `src/verbs/cockpit.ts` (currently at line 802, ADR-086 §Phase 6). The `installCockpitCronBlock` helper in `core/cron.ts` stays exported (for an explicit-opt-in `atmux cron-install --template cockpit-pulse` path if ever desired) but is no longer called by `cockpit rebuild`.

**Consequence**: After this ADR ships, no `atmux pulse` cron line is installed by anything. Cockpit liveness is observable through `atmux cockpit-mirror` (the Rust binary, ADR-230, which the operator runs interactively) — and through the cockpit tmux session being attachable. If the cockpit dies, the operator notices via attach-fails and manually runs `atmux cockpit rebuild`.

### D3 — `core/cron.ts` template drops `orchd --drain`, `orchd --sweep`, and `committer --sweep` emissions

In `src/core/cron.ts`, the `renderTeamBlock` function removes:
- The `orchd --drain` line emitted inside the `hasGitter` + `team.autoMerge.enabled` block (around line 421).
- The `orchd --sweep` line emitted after the `hasGitter` block (around line 452 — ADR-231 §D4 auto-spawn backstop).
- The `committer --sweep` line paired with `orchd --drain` (around line 414) — `atmux committer --daemon` covers the same surface event-driven; cron backstop is now operator-on-demand if the daemon dies.

Similarly, `installCockpitCronBlock` (around line 677) is preserved as a strip-only utility (it's used by `cron-remove` to delete legacy blocks during cleanup); the install function still works if called directly, but no caller in trunk invokes it.

**Consequence**: The remaining template (poke, report, decisions-digest, groom, poke-resume-check, unblocker, lane-tick, merge-cycle, ombudsman, lane-stall-watch) is **also** no longer auto-installed (per D1 above). If an operator chooses to manually `atmux cron-install`, they get the legacy non-orchd cron lines as a one-shot install — but new defaults are zero-cron. Future ADR may strip the remaining template lines too; this ADR's scope is the auto-install vector + the orchd-redundant cron lines, not a full deprecation of the cron-install verb itself.

### D4 — Legacy stopgap shell scripts deleted from dotfiles

These four shell scripts in `/root/work/journals/.sb/_dotfiles/` are deleted (operator runs `dotfiles push` to deploy the deletion):

- `bin/atmux-cockpit-watchdog.sh` — cockpit self-heal on tmux 3.6a copy-mode segfault. Operator stance: manual rebuild is acceptable; the segfault is rare enough.
- `atmux/bin/cron-resubmit-stuck-queue.sh` — send-keys-drop stopgap. Superseded by paste-submit.ts (ADR-138) which has shipped. Stopgap is dead code.
- `~/.atmux/bin/cron-check-lead-rotate.sh` — lead-rotation enforcer stopgap. Per ADR-143; the TS verb is the path forward and rotation cadence will be operator-on-demand or moved to orchd as a `team.uptime.exceeded` subscriber if ever required again. **This script is the prime suspect for "sopx team getting killed from time to time"** — every 5 min it can `atmux rotate-lead --team sopx` if lead uptime > 60 min.
- `tmux/auto-resurrect-save.sh` — tmux-resurrect autosave. Operator stance: no auto-resurrect on reboot wanted, so the save path feeding the restore path is also unwanted.

The cron lines invoking them are already stripped from root crontab (2026-05-24 boot-storm cleanup); this ADR's D4 is the script-file deletion that follows.

### D5 — `atmux stop` and `atmux cron-orphans --prune` behavior unchanged

Both verbs keep working as today. They continue to clean up legacy `atmux:*` sandwich blocks from crontabs of pre-ADR-233 operators (or operators who explicitly opted in to `atmux cron-install`). This is the migration ramp: the strip-side stays robust while the install-side defaults to zero.

## Consequences

- **Boot is provably clean.** After this ADR, `crontab -l | grep -c "atmux:"` returns `0` on any freshly-`atmux start`-ed team. Reboot is no longer a boot-storm contributor.
- **No more rogue side-effects** like cron-check-lead-rotate killing sopx leads or cron-resubmit-stuck-queue re-injecting stale buffer text.
- **Operator owns liveness.** If cockpit dies, operator runs `atmux cockpit rebuild` manually. If a team gets wedged in a way orchd can't recover from, operator does the recovery. The system is no longer trying to self-heal silently.
- **Tests update.** `tests/unit/cron_install.bats`, `tests/unit/verbs/start.test.ts`, `tests/e2e/lifecycle.test.ts`, `tests/e2e/stop-soft.test.ts`, `tests/e2e/cadence-truth-signal.test.ts` — any test that asserts "after `atmux start`, the crontab contains line X" must flip to "after `atmux start`, the crontab does not contain `atmux:team=` markers". The `cron-install` verb itself stays testable as a direct invocation.

## Reversal

If a future incident reveals an event-class orchd cannot cover, the path is:

1. Identify the specific event topic that's missing.
2. Add a Honker consumer for it (preferred), OR
3. Re-introduce a *single* targeted cron line via `atmux cron-install --template <name>`, without re-enabling the bulk auto-install in `atmux start`.

The auto-install vector is gone; targeted re-introduction is fine if motivated by a real, observed gap — not a speculative "what if orchd misses something".
