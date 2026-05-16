# RUNBOOK — atmux groom

Operator-facing reference for the `atmux groom` daily housekeeping verb. Pairs the implementation in `src/verbs/groom.ts` + `src/core/groom.ts` with the cron line `0 4 * * * <prefix> atmux groom --quiet` (per [RUNBOOK-cron-migration.md](RUNBOOK-cron-migration.md)).

## Sub-ops (in invocation order)

All sub-ops are **idempotent + error-contained** — one failing sub-op never aborts the remaining ones; failures surface as `warn` lines + populate `result.errors[]`.

| # | Sub-op | Source | Threshold | Opt-in flag |
|---|---|---|---|---|
| 1 | Inbox / outbox `## Archive` flush | `flushInboxOutboxArchive` | — | default-on |
| 2 | `decisions.md` block archive | `archiveDecisions` | `--decisions-days 30` | default-on |
| 3 | `kanban.json` done/cancelled summary | `summarizeKanban` | `--kanban-days 30` | default-on |
| 4 | `.bak.*` cull | `cullBakFiles` | `--keep-bak 5` | default-on |
| 5 | `archive/` size warn | `archiveSizeCheck` | 50MB / 5MB caps | default-on |
| 6 | Lane-drift catch-the-stragglers | `runLaneDriftCheck` (via groom) | `team.json::groom.laneDriftCheck` | auto-on for lane-tagged teams |
| 7 | `state.db` → `archive.db` row move | `groomArchive` | `--kanban-days` | `--archive` (opt-in) |
| 8 | Zombie tmux socket sweep | `sweepZombieTmuxSockets` | 6h default | `--zombie-sweep` (opt-in) |

## Sub-op 8 — zombie tmux socket sweep (`--zombie-sweep`)

Defense-in-depth for SIGKILL'd `bun test` orphans (complaint `c-4698c603` arm (b); [t-0027eec3](../docs/adr/) — no dedicated ADR, scope is housekeeping). Pairs with the primary fix shipped in [t-88b60ca7](../docs/adr/) (`tests/unit/verbs/cockpit.test.ts` module-level fixture registry + `process.on('exit')` + `afterAll` sweep).

**What the (a) primary fix covers**: throw / unhandled-rejection escape paths inside bun-test's own process lifecycle — userland exit hooks fire and the fixture's tmux server + socket dir are reclaimed.

**What it does NOT cover (arm b)**: SIGKILL on the bun-test process itself (e.g. `BashTool` wrapper timeout per CLAUDE.md §`bun test` orphan rule). No userland exit hook fires under SIGKILL, so the fixture's `mkdtemp`-allocated tmux socket dir leaks at `<os.tmpdir()>/atmux-<name>-<random>/`.

### Operator usage

```bash
# One-shot sweep with default 6h threshold:
atmux groom --zombie-sweep

# Dry-run to preview what would be cleaned:
atmux groom --dry-run --zombie-sweep

# Quiet (cron-friendly):
atmux groom --quiet --zombie-sweep
```

### Pattern matching

The sub-op walks `os.tmpdir()` and matches directories against `^atmux-(cockpit-)?[^/]+-[^/]+$`. The **trailing `-<suffix>`** is the mkdtemp random tail; production cage dirs like `/tmp/atmux-<teamname>/sock` lack this suffix and are deliberately excluded.

Two socket shapes are detected inside a matched dir:

- `<dir>/sock` — atmux default cage convention (per `getDefaultSocket` in `src/core/common.ts`).
- `<dir>/tmux-<uid>/default` — `resolveTeamSocket` convention when `team.tmuxTmpdir` is set (e2e fixtures pin `tmuxTmpdir` at the fixture root).

For each socket found, `tmux -S <sock> kill-server` is attempted (idempotent — no-server errors are expected and swallowed). Then `rm -rf <dir>` finalizes the cleanup.

### Threshold (`minAgeMs`)

Default 6h. Short enough to drain typical CI rounds; long enough that a stale-looking fixture at minute 5h59 of an actively-running spec is NOT nuked mid-test. The threshold is the dir's `mtime` (parent dir, not socket file — `mkdtemp` sets parent mtime at creation, fresh test runs bump it via inner writes).

### Cron policy

`--zombie-sweep` is **opt-in (default-off)** in v1 for two reasons:

1. False-positive deletes against an actively-running long-lived test fixture would corrupt the in-flight test. The regex + 6h threshold are conservative; opt-in adds a third gate (explicit operator approval).
2. The (a) primary fix already covers the common case. Defense-in-depth is housekeeping, not load-bearing — operator should observe N weeks of opt-in production before flipping cron-default-on.

To enable on cron, either: (a) edit the cron line to include `--zombie-sweep`, or (b) wait for a follow-up Task to migrate the flag to a `groom.zombieSweep: true` `team.json` config knob with cron auto-respect.

### Return shape

`result.zombieSweep` is populated when `--zombie-sweep` is passed:

```ts
interface ZombieSweepResult {
  scanned: number;           // matched + old-enough fixture dirs found
  killed: number;            // dirs where at least one tmux kill-server succeeded
  removed: number;           // dirs where the rm -rf succeeded
  errors: {                  // per-dir errors (kill-server unexpected failures, rm failures)
    path: string;
    message: string;
  }[];
}
```

Idempotent re-runs are a no-op (cleaned dirs are absent; `tmux kill-server` against a missing socket returns expected-class errors that are swallowed).

## Cross-references

- **ADR-068** (groom umbrella — ghost ADR file; code references it; cleanup tracked at `t-75a79d7c`).
- **Complaint `c-4698c603`** (resolved) — the original 2026-05-12 demo-prep incident where a cockpit fixture's tmux server leaked.
- **`t-88b60ca7`** (shipped, `20fccb1`) — primary (a) defense: in-process exit hooks.
- **`t-0027eec3`** (this Task) — secondary (b) defense: out-of-process sweep.
- **CLAUDE.md §`bun test` orphan rule** — root cause of the SIGKILL-bypass class.
- **`docs/RUNBOOK-cron-migration.md`** — cron line registration for `atmux groom --quiet`.
- **`src/core/groom.ts::sweepZombieTmuxSockets`** + **`tests/unit/core/groom-zombie-sweep.test.ts`** — implementation + coverage.
