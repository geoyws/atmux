# RUNBOOK: Epic-team test-gate (cage / deployed / skip)

> ⚠ **RETIRED 2026-08-27 — [ADR-280](adr/280-epic-team-retirement-and-staged-excision.md).**
> Epic-teams no longer exist. The `epic-team` cage type, the `epicId` cockpit
> field, and every verb this runbook drives — `team spawn-epic`,
> `team dissolve-epic`, `team sweep-epics`, `epic-merge`, and the three
> worker-team verbs built on them — were removed from atmux. **Nothing below is
> runnable.** It is kept as history, not as a playbook.
>
> What SURVIVES is the nesting mechanism itself: a `team` may contain child
> cages to arbitrary depth for any reason, with no epic and no `epicId`
> ([ADR-089 §Amendment 2026-08-27](adr/089-hierarchical-cockpit.md) §(A);
> operator-facing form in [RUNBOOK-cockpit.md §11](RUNBOOK-cockpit.md)).

Operator runbook for the ADR-144 epic-team test-gate. Covers
configuration, mode selection, mid-flight inspection, manual
recovery from `test_failed`, and the operator bypass.

**Cross-refs**: [ADR-090](adr/090-epic-team-lifecycle.md) (epic-team
lifecycle) · [ADR-091](adr/091-kanban-driven-auto-merge.md) (auto-merge
state machine) · [ADR-144](adr/144-epic-team-test-gate.md) (test-gate
extension this runbook operationalises).

## What the test-gate does

Per ADR-144, the epic-team auto-merger refuses `ready_to_merge →
merging` unless the most recent test run on the epic's branch passed.
Without the gate, a broken epic-team's commits can land on
parent-trunk on the next cron tick — a regression that costs every
downstream consumer (sibling epic-teams, demo walks, branch-staging)
until someone notices and reverts.

The gate inserts a `tested` state between `ready_to_merge` and
`merging`:

```
... → ready_to_merge → tested → merging → merged → dissolved
                          └─→ test_failed
```

The `tested` state records the most recent `test_outcome` (`pass` /
`fail` / `bypass`) on the merger_state row; the `canEnterMerging`
guard reads this column on every `tested → merging` attempt.

## Mode selection

Set `team.epicTeam.testGateMode` in `team.json` to one of three values:

| Mode | When | Test isolation | Test command default |
|------|------|----------------|----------------------|
| `skip` | Legacy / no test-gate desired | None — direct `ready_to_merge → merging` | n/a |
| `cage` | Internal tools (atmux self) | Fresh tmpdir at `team.epicTeam.cageTmpdir`, `TMUX_TMPDIR` scoped, `TMUX` env unset | `bun test --timeout 30000` |
| `deployed` | IFCA products (sopx, aix, …) | Long-lived branch-staging URL on `*.ifca.app` | `pnpm e2e` against `E2E_BASE_URL` |

Default is `skip` for backward compatibility — existing epic-teams
created before ADR-144 land continue with their pre-existing
direct-merge flow. New IFCA epic-teams should set `"deployed"`; new
atmux self-team epics should set `"cage"`.

## Cage mode — atmux self-dogfood path

Cage mode provisions a fresh tmpdir per merge attempt, runs the test
command with `TMUX_TMPDIR` scoped to that cage + the parent `TMUX`
env stripped, then tears down. The TMUX unset is mandatory per memory
`feedback_pause_bun_tests`: `bun test` inherits `$TMUX` pointing at
the parent atmux session, and the test's tmux teardown calls
`kill-server` honoring `$TMUX` over `$TMUX_TMPDIR` — which propagates
up to the parent cage. The `env -u TMUX` wrapper breaks that
propagation.

Example config:

```json
{
  "epicTeam": {
    "parent": "atmux",
    "parentBase": "geoyws",
    "testGateMode": "cage",
    "testCommand": "bun test --timeout 30000",
    "cageTmpdir": "/tmp/atmux_${team}_${epic}_test_cage",
    "testTimeoutMin": 30,
    "retryOnFlake": 1
  }
}
```

Mid-flight inspection:

```
sqlite3 .atmux/state.db \
  "SELECT member_branch, state, test_outcome, note FROM merger_state \
   WHERE member_branch LIKE '%-epic-%';"
```

## Deployed mode — IFCA products

Deployed mode reuses the wildcard `*.ifca.app → hax` DNS + wildcard
TLS that already exist on hax per global CLAUDE.md §DNS. The deploy
fires ONCE at `spawn-epic` (long-lived branch-staging URL across the
epic's lifetime); the test command runs PER merge attempt against
`E2E_BASE_URL=https://<staging-url>`; teardown fires ONCE at
`dissolve-epic`.

Example config:

```json
{
  "epicTeam": {
    "parent": "sopx",
    "parentBase": "sopx-geoyws",
    "testGateMode": "deployed",
    "testCommand": "pnpm e2e",
    "stagingUrlTemplate": "${product}-${dev-suffix}-${epic-name}-staging.ifca.app",
    "testTimeoutMin": 30,
    "retryOnFlake": 1
  }
}
```

Cross-field constraint (enforced at schema parse time):
`testGateMode: "deployed"` REQUIRES `stagingUrlTemplate` non-null.
`testGateMode: "cage"` works regardless of `stagingUrlTemplate`.

URL composition: the template accepts three placeholders, both
hyphenated and camel-cased forms are honored:

- `${product}` / `${product}` — per-product prefix (e.g. `sopx`)
- `${dev-suffix}` / `${devSuffix}` — per-dev segment (e.g. `geoyws`)
- `${epic-name}` / `${epicName}` — epic slug without `e-` prefix

Unrecognized placeholders are left verbatim — operators may layer
additional shell-expansion placeholders that the per-product
`scripts/deploy.sh` expands.

DNS pre-check: before the test command runs, the gate probes the
composed URL with `dig +short` (falling back to `getent hosts`). A
non-resolving URL fails fast with a clear "wildcard DNS for X did not
resolve" reason rather than a noisy network error from the test runner.

Per-product `scripts/deploy.sh branch-staging` lives in each IFCA
product's repo (not atmux). The atmux test-gate invokes it with
`STAGING_URL=<composed-url>` in the env so the script can bind /
advertise the right hostname. The default deploy command is
`scripts/deploy.sh branch-staging`; per-team override via
`team.epicTeam.deployCommand` (future schema extension).

## Skip mode — back-compat / no test-gate

Default mode. Preserves the pre-ADR-144 direct `ready_to_merge →
merging` flow. Use this for:

- Epic-teams created before ADR-144 land (no test-gate desired).
- Trivial doc-only epic-teams where the reviewer-trunk-signoff Task
  is the only gate.
- Emergency hot-fix epic-teams where a stuck test-gate would block
  the merge.

Skipping is a per-epic-team config — operators can mix cage / deployed
/ skip across sibling epic-teams under the same parent.

## Recovery from `test_failed`

When the test command fails (every attempt across `retryOnFlake`
retries returns non-zero), the gate transitions the row to
`test_failed`. The merger_state.note records the last attempt's
evidence; the cron tick stops re-evaluating until the operator
manually advances the row.

Recovery flow:

1. Inspect the failure:
   ```
   sqlite3 .atmux/state.db \
     "SELECT member_branch, state, test_outcome, note FROM merger_state \
      WHERE state = 'test_failed';"
   ```
2. Fix the failing test on the epic-team's branch. Commits land via
   the epic-team's normal workflow.
3. Reset the row back to `in_progress` so the cron re-evaluates:
   ```
   atmux epic-merge advance --to in_progress
   ```
   The `--to in_progress` flow clears the stale `test_outcome` so the
   next `ready_to_merge → tested` transition starts fresh.
4. Next cron tick re-runs the gate. On pass, the row advances through
   `tested → merging → merged → dissolved` normally.

## Operator bypass — `--skip-test-gate`

For genuine emergencies (broken test infra, urgent rollback, etc.)
the operator can bypass the gate:

```
atmux epic-merge advance --to merging \
  --skip-test-gate --reason "test infra down — urgent rollback"
```

The bypass is **driver-only** (ADR-033 caller-scope gate). Effects:

- Writes `test_outcome="bypass"` to the merger_state row.
- Appends a record to `~/.atmux/state/test-gate-bypasses.log` (JSONL,
  append-only audit trail).
- Fires Discord `[test-gate-bypass]` with who / why / epic-name /
  target-state (T5 — surfaces immediately to the channel).

The `tested → merging` transition is then accepted on the next state
machine evaluation (the `canEnterMerging` guard treats `"bypass"`
identically to `"pass"`).

Use sparingly. The default posture is "tests must pass" — every
bypass shows up in the audit log + Discord, so the team sees both
the WHO and the WHY.

## Discord templates (T5 — landing alongside this runbook)

Three templates fire from the test-gate per global CLAUDE.md
§Discord rules:

- `[epic-test-pass]` — on `tested → merging` with `test_outcome="pass"`.
  Body: epic-name, branch, test command, pass count, total duration.
- `[epic-test-fail]` — on `tested → test_failed`. Body: failed test
  names, last 20 lines of stderr, suggested rework scope.
- `[test-gate-bypass]` — on `advance --to merging --skip-test-gate`.
  Body: who / why / epic-name / target-state.

The templates live in `src/abstractions/discord.ts` and are exercised
by the T5 e2e walks (synthetic epic-team in both modes).

## Troubleshooting

### "DNS not configured" on every merge attempt (deployed mode)

The wildcard `*.ifca.app → hax` A record is missing or the per-product
URL doesn't fall under the configured wildcard zone.

- Verify the wildcard: `dig +short '*.ifca.app'` (returns hax's IP).
- Verify the composed URL: `dig +short sopx-geoyws-<epic>-staging.ifca.app`.
- If the composed URL has trailing whitespace or a malformed
  placeholder substitution, the URL composer surfaces a "would compose
  malformed URL" error at parse time — check `team.epicTeam.stagingUrlTemplate`.

### Cage mode test never starts (atmux self)

The cage's `TMUX_TMPDIR` was set but `$TMUX` wasn't stripped — the
test inherits the parent socket and refuses to start a nested server.

- Verify the cage runner is invoking via `env -u TMUX
  TMUX_TMPDIR=<cage> <testCommand>` (the test-cage module enforces
  this in `runCageTestOnce`).
- If running by hand outside the auto-merger, prefix with `env -u
  TMUX` manually.

### Tests pass locally but fail in the gate

The gate runs in a fresh process tree (cage mode) or against the
deployed URL (deployed mode). Local-only fixtures (e.g. a `bun test
--preload` script bound to your shell session) won't propagate.

- Cage mode: verify the test command works from `env -u TMUX
  TMUX_TMPDIR=/tmp/scratch bun test <test-file>`.
- Deployed mode: walk the deployed URL from your browser first; if
  the URL itself is unhealthy, `pnpm e2e` will fail with cryptic
  network errors that look like test failures.

### `--skip-test-gate` refused with "driver-scope required"

ADR-033 gates the bypass to driver scope. The advance verb only
accepts the bypass when `ATMUX_CALLER_SCOPE=driver` is set (the
driver's pane environment carries this; the lead and members do not).

Run the bypass from the driver pane directly. If the driver pane is
wedged and the operator can't reach it, the recovery path is to fix
the test (the slower-but-safer route) rather than try to bypass.
