# ADR-234: 2026-05-24 hax boot-storm + sopx-team-death incident post-mortem

**Status**: Post-mortem (informational; corrective decisions tracked in [ADR-233](233-cron-auto-install-disabled-trust-orchd.md)).
**Date**: 2026-05-24
**Driver-ref**: 2026-05-24 operator-fired diagnostic session — *"try to ssh to hax please and help me troubleshoot"*. Same session resolution + corrective architecture surfaced in [ADR-233](233-cron-auto-install-disabled-trust-orchd.md).
**Cross-refs**: [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) (corrective decisions — cron auto-install retired), [ADR-202](202-honker-in-db-messaging-substrate.md) (Honker substrate — the architecture that makes cron redundant), [ADR-224](224-orchd-rename-and-auto-spawn-loop.md) (orchd lifecycle — PR_SET_PDEATHSIG-gated, no parent → no daemon), [ADR-143](143-external-lead-rotation.SUPERSEDED.md) (the suspected sopx-killer cron — superseded by ADR-233), memory `feedback_no_ephemeral_containers_on_boot`, memory `project_hax_reboot_bootstorm_2026_05_24`, memory `feedback_adr_atomicity_and_supersession`.

## What happened — boot-storm

Operator rebooted hax (Hetzner AX42-U, 16 cores, 124 GiB RAM, Ubuntu 24.04). For ~3–5 minutes after the reboot the box appeared dead from the operator's MacBook:

- `ssh hax` timed out with the default `ConnectTimeout=15`. (TCP :22 actually accepted connections — the SSH key-exchange completed — but session auth stalled past the timeout.)
- `curl https://geoy.ws/` returned **HTTP 502 Bad Gateway** from nginx (the proxy was up; the upstream backend pool was not).
- ICMP was filtered (Hetzner default), reinforcing the "box is dead" impression.

Actual state, surfaced after raising `ConnectTimeout=60`:

- Uptime: ~1–2 minutes when the operator first reported "can't connect".
- 1-minute load average: **27.04** on a 16-core box (i.e. ~1.7× per core, all runnable).
- Zero failed systemd units.
- Disk 64 % used, 153 GiB free — not a resource exhaustion issue.
- Memory 14 GiB / 124 GiB used, 0 B / 127 GiB swap — also not an exhaustion issue.
- 122 docker containers, all reporting `(healthy)` once they finished starting.

Recovery: load fell from 27 → 16 → 13 → 7 → 5 → ~2 over the first ~5 minutes. SSH worked normally once load dropped below ~per-nproc. nginx 502s cleared as upstreams finished warming.

## Root cause

Three concurrent stressors fanned out simultaneously at boot:

1. **122 docker containers** all carrying `restart: unless-stopped`. dockerd brings them up in parallel. Container families:
   - `unum-prod-*` (Unum prod stack)
   - `unum-geoyws-staging-*` (operator's per-dev Unum staging)
   - `sopx-staging-*` (canonical SOPX staging)
   - `sopx-geoyws-staging-*` (operator's per-dev SOPX staging)
   - `sopx-geoyws-e2e-*` + `sopx-geoyws-epic-e-*-e2e-*` (**ephemeral e2e test stacks that had no business surviving a reboot** — 19 containers)
   - `sopx-test-*` (5 scratch test DBs, also ephemeral)
   - `zdd-blue-*` / `zdd-green-*` (zero-downtime deploy)
   - `webhooks`, Outline, Dify, Strimzi/Kafka operator.
2. **k0s controller** enabled at boot — kube-apiserver + kine + controller-manager fan-up.
3. **23 active `atmux:*` cron sandwich blocks** in root's crontab — 5 to 13 cron lines per team, every 1–30 minutes, all eligible to fire within the first 5 minutes of boot. Including `* * * * * atmux orchd --drain` for the atmux team itself (the most aggressive cadence in the file).

The single boot was triggering ~150 service start-ups in parallel on a 16-core machine.

## SSH appeared dead — why the false signal?

Default `ssh` `ConnectTimeout` is 15 seconds. The TCP handshake on port 22 succeeded immediately (no firewall drop), and `OpenSSH_9.6p1` advertised its banner and completed key exchange. The stall was in **`sshd`'s post-KEX session setup** (pam, fork to privsep child, exec the user's shell) — all of which were starved for CPU under load 27. The session never got past `SSH2_MSG_KEX_ECDH_REPLY received` before the client gave up.

Fix-on-the-spot: `ssh -o ConnectTimeout=60 -o ServerAliveInterval=10`. Session completed in ~30–40 s under load and ran normally thereafter. The box was never down — just overloaded.

## sopx-team-dying — what we suspect, why

Operator: *"CRONs … like to kill my sopx team from time to time"*. No on-the-fly evidence captured this session (no fresh kill observed), but the strongest suspect is `/root/.atmux/bin/cron-check-lead-rotate.sh`:

- Cadence: every 5 minutes via cron.
- Behavior: for each enabled team in `~/.atmux/cockpit.json`, reads `~/.claude/teams/<team>/lead-session-start.txt`, computes `uptime = now - lead-start`, compares to `team.json::whip.leadMaxMin` (default **60 min**), and fires `atmux rotate-lead --team <team>` if exceeded.
- `atmux rotate-lead` kills the lead pane and respawns it.
- For an operator working in sopx with lead uptime past 60 minutes, this script reaches in every 5 minutes and restarts the lead. From outside it feels like "sopx randomly dies."

The script is a stopgap for ADR-143's `atmux check-lead-rotate --all-teams` verb that hadn't been ported to TS yet. Per [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) §D4, the script is deleted; rotation cadence becomes operator-on-demand. If/when team uptime gating becomes load-bearing again, the path forward is an orchd subscriber on a `team.uptime.exceeded` event — not a cron walker.

Secondary suspects (less likely but possible contributors):

- `cron-resubmit-stuck-queue.sh` (every 5 min) — touches member panes via `atmux send`. If timing races with a member starting work, could feel like "the team is broken." Also deleted per ADR-233 §D4 (root-cause fix in ADR-138 paste-submit.ts has shipped).
- `atmux:cockpit` block invoking `atmux pulse --config /root/.atmux/cockpit.json` every 5 min — pulse signal generator, no destructive side effects expected, but a stable target for "what is touching my team every 5 min?" diagnostics. Also retired per ADR-233 §D2.

## Recovery / cleanup performed in-session

In order, ~2026-05-24 00:14–00:30 MYT:

1. **24 ephemeral e2e/test containers** force-removed (`docker rm -f -v` via `xargs`). Container total: 122 → 98.
2. **All atmux runtime killed** — cockpit tmux, 5 per-team tmux servers, 29 `claude` processes, supervisor `while true` bash loops, daemon stubs.
3. **Stale `/tmp/atmux-*` sockets** removed.
4. **4 disabled-by-default crons** commented out in root crontab (`atmux-cockpit-watchdog`, `auto-resurrect-save`, `cron-resubmit-stuck-queue`, `cron-check-lead-rotate`).
5. **23 `atmux:*` cron sandwich blocks** stripped via `awk` (215 → 49 crontab lines). Backup at `/tmp/crontab.before-strip.<unix-ts>.bak`. Post-strip `crontab -l | grep -c "atmux:"` returns `0`.
6. Final load 1.91; full cleanup verified.

## What we learned

1. **`restart: unless-stopped` is a Chesterton's-fence for ephemeral containers.** It was put there because compose templates default to it. It survives reboots that the container's purpose does not. See memory `feedback_no_ephemeral_containers_on_boot` — the rule is: ephemeral containers (e2e, cdev, branch-testing, scratch) get `restart: "no"` explicitly; persistent ones get `unless-stopped`.
2. **`ssh -o ConnectTimeout=60`** when triaging a recently-rebooted box. The default 15-second timeout is shorter than the post-reboot CPU starvation window on a saturated host, producing a "box is dead" false signal.
3. **HTTP 502 immediately after a reboot is "upstreams starting", not "nginx broken".** Wait, observe load. Don't restart nginx.
4. **Cron is the wrong tier for "self-healing" architecture once you have event-driven substrate.** A cron-driven backstop is fine when it's a Chesterton's-fence for a missing event topic; it becomes a load-bearing rogue when it both (a) duplicates an event-driven path that's already working, and (b) carries destructive side effects (kill-and-respawn). The remediation is to delete the cron, not gate it more carefully. Codified in [ADR-233](233-cron-auto-install-disabled-trust-orchd.md).
5. **Boot-storm risk scales with `parallelism × per-service-cost`.** A 16-core box can absorb ~16 simultaneous "start the service" events comfortably. ~150 saturated it for ~5 minutes. The remediation is to reduce the number, not buy more cores.
