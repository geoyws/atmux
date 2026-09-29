# RUNBOOK — `atmux budget` usage tracker

Operator-facing reference for the multi-provider budget tracker: where snapshots live, how to read them, and how to arm the hourly collector. Design authority is [ADR-270](adr/270-budget-usage-tracker.md); the cron-arm idempotency contract is [ADR-192](adr/192-cron-arm-idempotency-contract.md).

## §1 — State + verbs

- Snapshots land in `~/.atmux/state/budget.db`, table `usage_snapshot` — usage numbers only, never keys or tokens (per ADR-270 D6).
- `atmux budget collect` probes all 7 providers in one batch (shared UTC `ts`); a failing provider writes an `ok=0` row and never aborts the batch. It exits 0 even when providers fail.
- `atmux budget report [--json] [--window 24h|7d] [--provider <p>] [--live]` renders the latest snapshot with window deltas and reset times.
- Collector output under cron appends to `~/.atmux/state/budget-collect.log` — never cron mail.

## §2 — Hourly cron (documented one-liners, no scheduler)

Per ADR-270 D7 (T5, operator option 1): no scheduler ships — the operator arms one OS-crontab line. The entry lives in a `# >>> atmux:budget` / `# <<< atmux:budget` sandwich, reusing the `atmux start` marker convention (per ADR-192 §Rule consistency check), so re-install is idempotent by construction: install strips any existing budget block before appending the fresh one.

Install — hourly, idempotent (safe to run twice; preserves every unrelated line; works with no crontab yet):

```cron-install-sh
( (crontab -l 2>/dev/null || true) | grep -v -F -e '# >>> atmux:budget' -e '# <<< atmux:budget' -e 'atmux budget collect' || true; echo '# >>> atmux:budget — managed by operator; do not edit by hand'; echo "7 * * * * PATH=$(dirname "$(command -v bun 2>/dev/null || echo /usr/local/bin/bun)"):/usr/bin:/bin $(command -v atmux 2>/dev/null || echo atmux) budget collect >>$HOME/.atmux/state/budget-collect.log 2>&1"; echo '# <<< atmux:budget') | crontab -
```

Remove — deletes only the budget block, leaving everything else byte-identical:

```cron-remove-sh
( (crontab -l 2>/dev/null || true) | grep -v -F -e '# >>> atmux:budget' -e '# <<< atmux:budget' -e 'atmux budget collect' || true ) | crontab -
```

Notes:

- `$(command -v atmux …)` bakes in the absolute atmux path at install time (falling back to bare `atmux`), and `$HOME` likewise expands at install time. `atmux` is a `#!/usr/bin/env bun` script and cron's `PATH` is only `/usr/bin:/bin`, so the entry also carries an inline `PATH=` with bun's directory, resolved at install time. Without it every tick fails with `env: bun: No such file or directory` (exit 127, measured 2026-09-29). Re-run the install after moving bun. Verify with `crontab -l | grep -B1 -A1 'atmux:budget'`.
- The entry fires at minute 7 past each hour (`7 * * * *`) to stay off the top-of-hour thundering herd.
- The first successful tick appends to `~/.atmux/state/budget-collect.log`; `atmux budget report` then shows fresh rows.
- Executable proof: `tests/unit/verbs/budget-cron.test.ts` extracts these exact fenced lines from this file (and the ADR-270 amendment, asserting both match) and runs them against a fake `crontab`.
