# ADR-168: send-keys-failures.log rotation policy — closes ADR-138 §Escalation log open question

**Status**: accepted
**Date**: 2026-05-17
**Supplements**: [ADR-138](138-verified-send-keys.md) §Escalation log
**Closes**: `t-c35e8783` ([ADR-138 §Escalation log rotation policy — decide at T8 dogfood gate])

## Context

[ADR-138](138-verified-send-keys.md) §Escalation log declared rotation policy out-of-scope: *"The log is append-only, MYT-timestamped, and bounded by an operator-managed rotation (`logrotate` config or similar — out of scope for this ADR)."*

Reviewer signoff `t-76bed567` §Adjacent classes flagged this as needing decision at T8 dogfood gate. T8 has now passed (ADR-138 T1-T3 all shipped; in-production usage on hax > 3 days).

**Measured dogfood data on hax at 2026-05-17 03:00 MYT**:

| Metric | Value |
|---|---|
| File path | `~/.atmux/state/send-keys-failures.log` |
| Current size | 511 KB |
| Age | ~3 days of dogfood across `atmux` + `sopx` teams |
| Implied growth rate | ~170 KB/day, ~1.2 MB/week, ~60 MB/year |
| Disk-pressure risk class | bounded; not catastrophic |

The original ADR-138 task body offered three options:
- **(a)** `logrotate` config at `/etc/logrotate.d/atmux-send-keys-failures` with daily + 7-day retention
- **(b)** In-process rotation via `src/core/log-rotation.ts` (size-based 10 MB cap × 5 files)
- **(c)** Hands-off — let operator manage

## Decision

**Option (a) — `logrotate` config primary.** Option (b) in-process rotation deferred to future ADR if cross-OS atmux production deployment becomes a requirement.

### Logrotate config

Drop into `/etc/logrotate.d/atmux-send-keys-failures` on each hax-class production host:

```
/root/.atmux/state/send-keys-failures.log {
    daily
    rotate 7
    missingok
    notifempty
    compress
    delaycompress
    create 0644 root root
    su root root
}
```

`su root root` is intentional — the log is root-owned (atmux runs as root on hax) and the rotation operation must preserve ownership.

### Operator install step (one-time per host)

```sh
sudo tee /etc/logrotate.d/atmux-send-keys-failures > /dev/null <<'EOF'
/root/.atmux/state/send-keys-failures.log {
    daily
    rotate 7
    missingok
    notifempty
    compress
    delaycompress
    create 0644 root root
    su root root
}
EOF

# Verify the config parses cleanly + dry-run
sudo logrotate -d /etc/logrotate.d/atmux-send-keys-failures
```

The `-d` flag is debug-only (no rotation applied); use `sudo logrotate -f /etc/logrotate.d/atmux-send-keys-failures` to force an initial rotation if the log has already grown past the threshold of interest.

## Rationale

1. **OS-canonical** — `logrotate` is the standard Linux log-management surface. Ops engineers and downstream open-source contributors already know it. No bespoke atmux knowledge required.

2. **No atmux code change** — keeps the `safeSendKeysWithVerify` abstraction (per ADR-138) free of rotation responsibility. The log writer at `src/core/safe-send.ts` continues to emit append-only timestamped rows; rotation is an external concern handled by the OS.

3. **Bounded retention matches measured growth** — daily rotation with 7-day retention caps total disk footprint at ~1.2 MB regardless of incident rate. Compression (delaycompress) reduces further to ~200 KB compressed across the rotated set.

4. **Cross-OS portability not required for v1** — atmux runs on hax (Linux) for production cockpit work; macOS dev machines that occasionally run atmux for local testing don't generate enough traffic to need rotation. If atmux deploys to non-Linux production environments in future, option (b) in-process rotation becomes the right path — defer to a future ADR.

5. **Recoverability** — rotated logs land at `~/.atmux/state/send-keys-failures.log.1.gz` (and `.2.gz` ... `.7.gz`); 7 days of history retained for post-incident analysis. The doctor probe `send-keys-failure-recent` (per ADR-138) scans only the current (un-rotated) file — incidents fresher than ~24h are always visible.

## Consequences

- **Operator install required** — the logrotate config is NOT auto-installed by `atmux start` or any other verb. Operator runs the snippet once per host. This is appropriate: atmux should not write to `/etc/logrotate.d/` (system-managed directory) as part of its lifecycle.
- **Disk usage capped** — bounded at ~1.2 MB raw, ~200 KB compressed.
- **No code-side dependency** — ADR-138 implementation surface unchanged.
- **Cross-OS gap noted** — macOS dev machines running atmux locally will see unbounded log growth (no logrotate). Acceptable for v1 since macOS atmux is dev-only; production cockpit work is hax-only.

## Deferred to follow-up

File as separate Tasks if/when needed:

1. **In-process rotation** (option b) — `src/core/log-rotation.ts` with size-based 10 MB cap × 5 files. Defer until atmux deploys to non-Linux production environments OR a doctor probe surfaces the log exceeding bounds despite logrotate being installed.

2. **Doctor probe for log size** — `send-keys-failure-log-stale` warning when:
   - Log file exceeds 10 MB AND
   - `logrotate.d/atmux-send-keys-failures` not installed OR not running daily.
   Cheap probe; nice-to-have. File as P5 backlog if log-growth surprises emerge.

3. **Config-in-repo** — ship the logrotate snippet at `config/logrotate.d/atmux-send-keys-failures` in the atmux repo for reproducibility + onboarding doc citation. Defer until atmux gains a `config/` top-level directory (currently does not exist). When added, document in RUNBOOK.

## Cross-references

- [ADR-138](138-verified-send-keys.md) §Escalation log — the open question this ADR closes.
- Reviewer signoff `t-76bed567` §Adjacent classes — surfaced the rotation-policy gap.
- `t-c35e8783` — original placeholder task ("decide at T8 dogfood gate"); closed concurrent with this ADR.

## Open questions

1. **OQ-1 (RESOLVED, LOW-rev)**: rotation cadence — daily vs hourly vs size-based.
   - **Default**: daily.
   - **Rationale**: measured 170 KB/day; daily rotation gives 7×170KB = ~1.2 MB at peak retention. Hourly would over-rotate; size-based would require operator threshold tuning that doesn't match observed growth.

2. **OQ-2 (RESOLVED, LOW-rev)**: retention window — 7 days vs 14 days vs 30 days.
   - **Default**: 7 days.
   - **Rationale**: the doctor probe `send-keys-failure-recent` (per ADR-138) operates on the current un-rotated file; rotated history is for post-incident analysis only. 7 days covers a full sprint cycle without bloating disk.

3. **OQ-3 (RESOLVED, LOW-rev)**: compression — yes/no.
   - **Default**: yes (`compress` + `delaycompress`).
   - **Rationale**: delaycompress keeps the most-recent rotation uncompressed for grep-friendliness; older rotations compress to ~5-10× smaller. Standard `logrotate` idiom.


## §Amendment 2026-05-20 — promoted to accepted (status-drift audit T4)

Promoted from `proposed` → `accepted` per [docs/audits/adr-status-drift-audit-2026-05-20.md](../audits/adr-status-drift-audit-2026-05-20.md) (sha=a6f1541). Code-refs + git-log refs both present at audit time confirming shipped + dogfooded status; the `proposed` marker was bookkeeping debt. Original Date preserved verbatim. Append-only — see Status field for the canonical flip; this §Amendment carries the audit traceability.

**Filed via** t-45b401c3 (T4 sweep, 2026-05-20).
