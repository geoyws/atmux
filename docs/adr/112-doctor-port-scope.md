# ADR-112: `doctor` verb (V-24) — port scope + deferred bash-only checks

**Status:** accepted
**Date:** 2026-05-05
**Owner:** driver

## Context

Bash `lib/doctor.sh` (1666 LOC at HEAD `2aadc3f`) declares 22 named check functions invoked from `main()`:

```
deps · libs · team · tuis · claude_accounts · state_dir ·
tmux_tmpdir · webhook · crontab · cron_orphans · orphan_sessions ·
topology_invariant · repair_rename_needed · whip_hash ·
phantom_inboxes · logout_kill · supervisor_liveness · wedged_bats_exec ·
caged_windows_outside_cage · orphan_atmux_sessions · cockpit ·
daily_driver_prefix_leak
```

The original PLAN.md §6.2 V-24 LOC estimate (~355) reflected the file's docstring header — deps / team / tuis / state-dir / webhook / phantom-inboxes / orphan-sessions — not the full check battery. The drift between docstring and main() came from incremental bash-side additions (Phase-5 cage isolation, super-driver topology invariants, repair-rename utilities) that landed under emergency-fix umbrellas without ADR coverage on the doctor side.

The TS port can't sensibly mirror many of these checks because:

- They probe **bash-implementation artifacts** (`lib/*.sh` existence via `verify-libs`, wedged-bats process detection) that don't exist in the TS port.
- They detect leaks from **Phase-5-deferred features** (cage-prefix leak, caged-windows-outside-cage, supervisor-liveness, cockpit, daily-driver-prefix-leak) that the TS port doesn't ship per ADR-106 § "Phase 5 deferral."
- They depend on **V-25-coupled features** (whip-hash invariant, cron-orphans tracking) — porting them before V-25 is order-dependent.

Porting all 22 in TS would add hundreds of lines of code that test artifacts the TS port doesn't produce. The bash-side checks aren't going away (atmux-bash stays live during burn-in per ADR-104), so operators who need those checks run `atmux doctor` (bash) on the same machine and get the full report.

## Decision

V-24's TS port scope is the **docstring-listed core set** plus `phantom-inboxes` and `orphan-sessions` (relevant to TS-port-produced state):

| Check | Status | Reason |
|---|---|---|
| `deps` | ✅ ported | tmux/jq/git required; curl/bats/shellcheck optional. Deps the TS port itself relies on (jq is honoured by tests/scripts even when the port itself uses Zod). |
| `team` | ✅ ported | `team.json` validity is a TS-port boundary concern. |
| `tuis` | ✅ ported | TUI binary on PATH — TS port spawns the same TUIs via `core/tui.ts`. |
| `state-dir` | ✅ ported | `.atmux/` writability — TS port writes here too. |
| `webhook` | ✅ ported | Discord reachability — TS port pings via `discord.send`. |
| `phantom-inboxes` | ✅ ported | inbox.inProgress entries pointing to non-existent kanban tasks — TS port writes inboxes. |
| `orphan-sessions` | ✅ ported (subset) | `singleSession=true` + legacy session warning. The full bash version has a Phase-5-cage migration path; the TS subset is just the "you have an orphan tmux session matching `atmux-<team>`" probe. |
| `libs` | ❌ deferred | Probes bash `lib/*.sh` existence via `verify-libs`. Meaningless for TS port (no `lib/*.sh`). |
| `claude-accounts` | ❌ deferred | Probes `~/.claude` account routing — operator-environment concern, not atmux-port concern. |
| `tmux-tmpdir` | ❌ deferred | Phase-5 cage tmpdir invariant. Re-enable when ADR-106 § Phase-5 lands. |
| `crontab` | ❌ deferred | Probes operator's crontab for atmux entries. V-25 whip-watchdog ships with the cron template; doctor check follows. |
| `cron-orphans` | ❌ deferred | Same — V-25-coupled. |
| `topology-invariant` | ❌ deferred | Phase-5 super-driver topology. |
| `repair-rename-needed` | ❌ deferred | Bash-side repair tool for partial-rename mess. TS port doesn't produce the artifact this detects. |
| `whip-hash` | ❌ deferred | V-25 whip-coupled invariant on the whip script's content hash. |
| `logout-kill` | ❌ deferred | systemd logout-kill integration; operator-environment concern. |
| `supervisor-liveness` | ❌ deferred | Phase-5 super-* supervisor health. |
| `wedged-bats-exec` | ❌ deferred | Detects wedged bats test runs — bash test-harness concern. |
| `caged-windows-outside-cage` | ❌ deferred | Phase-5 cage. |
| `orphan-atmux-sessions` | ❌ deferred | Detects `atmux-*` tmux sessions for teams without team.json. Marginal value for the TS port at burn-in scale — re-enable post-cutover when bash and TS are no longer side-by-side. |
| `cockpit` | ❌ deferred | Superdriver tmux session probe — operator-personal. |
| `daily-driver-prefix-leak` | ❌ deferred | Phase-5 cage-prefix leak detection. |

Render: human (stderr, color, glyph table) + JSON (`--json` to stdout).

`--fix`: in-scope subset is **team.json wizard re-run** (when team.json is the red row) + **phantom-inbox prune** (delete stale inProgress entries). Deferred fix paths (`cleanup`, `cron-orphans`, `logout-kill`, `daily-driver-prefix-leak`, `webhook`) follow the corresponding check status.

Also added in this commit:

- **`src/abstractions/discord.ts::resolveWebhookUrl(opts)`** — env → team.json → XDG file resolution chain. Mirrors bash `atmux::discord_resolve_webhook`. Used by doctor's webhook check; also available to V-25 whip + future report cross-link.
- **`src/abstractions/http.ts::probeStatus(url, opts)`** — returns the HTTP status code (or 0 on network/timeout failure). Mirrors bash `curl -w '%{http_code}' || echo 000`. Doctor needs the status code (not a boolean) because Discord returns 405 on GET — that's "reachable but rejected method," a green signal.

## Consequences

### Positive

- **V-24 ships in one focused commit** rather than turning into a 1666-LOC bash-translation marathon. Operators get the practical "is my env set up?" check on day one of the TS port.
- **Deferred set is clearly scoped** — re-enabling each deferred check is a tracked follow-up tied to its enabling feature (V-25, Phase 5, cage migration). No surprise gaps.
- **Bash atmux remains the authority** for the bash-only checks during burn-in (ADR-104). Operators run `atmux doctor` (bash) for the full battery; `atmux-bun doctor` (TS) for the in-scope set. Both work side-by-side.
- **`resolveWebhookUrl` + `probeStatus`** are reusable beyond doctor — V-25 whip will need both for its cost-budget heartbeat + URL-reachability monitoring.

### Negative / accepted

- **Operator-facing diff in check counts** between `atmux doctor` (full) and `atmux-bun doctor` (scoped). Documented in this ADR + linked from `atmux-bun doctor --help`. Operator who wants the full battery during burn-in runs `atmux doctor` on the same machine — both binaries can coexist.
- **Some deferred checks may surface real bugs in TS-port-produced state** that doctor can't catch. `orphan-atmux-sessions` is the most likely candidate — TS port creates `atmux-<team>` tmux sessions same as bash, and a stale one after `stop` would go undetected by the in-scope set. Mitigation: `phantom-inboxes` + `state-dir` cover the storage-side leaks; tmux-side leaks are detectable manually via `tmux list-sessions`. Re-enable in V-25 follow-up if pain surfaces.
- **Discord-file-mode warning (>600 chmod) deferred** — bash's webhook check warns when the per-user XDG webhook file is world-readable. The TS port's `resolveWebhookUrl` reads it but doesn't surface a mode warning. Add when operator pain surfaces (low-likelihood given operators are typically the only user on their machines).

### Cascade

- `src/verbs/doctor.ts` (new, ~400 LOC)
- `src/abstractions/discord.ts` (+ `resolveWebhookUrl`)
- `src/abstractions/http.ts` (+ `probeStatus`)
- `tests/unit/verbs/doctor.test.ts` (new, ~30+ tests)
- `tests/unit/abstractions/{discord,http}.test.ts` (+ tests for the new helpers)
- `src/cli.ts` (+ `case "doctor"`)
- `PLAN.md` §6.2: V-24 ⏳ → ✅
- Deferred-check follow-ups tracked under V-25 + Phase 5 ADRs (no new ID needed; each deferred row in this ADR's table is the durable handle).

## Alternatives considered

### A. Port all 22 checks now

Rejected. Most check the bash-implementation surface that the TS port doesn't ship. Translating them is busywork that doesn't improve the operator's environmental health visibility — bash atmux is still installed and runs them.

### B. Skip `doctor` entirely (operator runs bash version)

Rejected. The in-scope checks (deps / team / tuis / state-dir / webhook / phantom-inboxes / orphan-sessions) are genuinely useful from the TS port's perspective — they probe state the TS port writes / consumes. Skipping doctor leaves a gap in the cli surface that operators muscle-memorise.

### C. Per-check opt-in via `--check <name>` flag

Considered. Lets operators run only the checks they want. Rejected as premature — the in-scope set is small enough that "run them all" is the right default; per-check filtering is a follow-up for when the battery grows.

### D. Re-enable deferred checks via `--full` flag that shells out to bash atmux

Considered. `atmux-bun doctor --full` would invoke `atmux doctor` (bash) and merge results. Rejected — adds dependency on bash atmux being installed (breaks the "TS port can stand alone" goal), and the merged output would be confusing (two tools' verdicts intermixed).

## References

- ADR-102 (test strategy) — coverage gate applies to in-scope checks; deferred checks aren't tracked code at all.
- ADR-104 (cutover protocol) — bash atmux is the authority during burn-in.
- ADR-106 (WIP-bash deferral) — Phase 5 super-* / cage / cockpit are deferred; doctor checks for those features follow.
- ADR-111 (`/coordination:*` integration) — V-25 whip-watchdog cron integration; the deferred `crontab` + `cron-orphans` doctor checks land alongside.
- `lib/doctor.sh` HEAD `2aadc3f` — bash source.
- PLAN.md §6.2 V-24 row — flipped to ✅ shipped on the implementation commit.
