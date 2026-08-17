# ADR-236: Three-tier orchd supervision — internal retry + cockpit superorchd + medic escalation

**Status**: Superseded by [ADR-240](240-drop-superorchd-orchd-self-supervises.md) on 2026-05-24 — operator-direct *"simpler is better"*; D2 (superorchd binary) and D3 (Discord escalation) dropped, D1 (orchd internal retry) and D5 (remove bash supervisor) preserved by ADR-240. Retained below for historical trace + reversal recovery path.

Original status when written: Proposed (operator-fired 2026-05-24 in conversation after sopx + atmux orchd windows were found absent; ship under driver once D1+D2 land in code).

**Date**: 2026-05-24

**Driver-ref**: 2026-05-24 conversation with operator after manual orchd respawn on atmux + sopx. Operator's standing position in that session, verbatim:
- *"we need to simplify atmux"*
- *"the most robust is never a cron.. pubsub is always best.. we've removed all crons already"*
- *"a pull model for each claude is heavy and wasteful in terms of tokens"* (rebut to the "drop orchd, members poll their lane" simplification; pull model multiplies token spend across N members idling 95% of the time)
- *"option 1 + option 2 with option 2 being a superorchd binary that lives in the cockpit level that makes sure orchds are alive otherwise it should escalate to _medic"*
- *"it loooks like we still need _medic around"* — retention is the operator's call, narrowed specifically to the supervision-escalation role

**Cross-refs**:
- [ADR-202](202-honker-in-db-messaging-substrate.md) §1132 — PIPESTATUS regression in the bash supervisor (the precedent for why TS-emits-bash-watches-Rust is the wrong shape).
- [ADR-224](224-orchd-rename-and-auto-spawn-loop.md) — orchd's auto-spawn loop and the `rust/atmux-orchd` crate this ADR proposes to extend (D1 internal retry) and pair with a new cockpit-level binary (D2 superorchd).
- [ADR-231](231-orchd-auto-spawn-and-solo-worker-dissolve.md) §D4 — orchd's `--sweep` cron backstop, retired by ADR-233; removal of that backstop is what made orchd load-bearing.
- [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) — *"trust orchd to run"* + *"orchd --drain not necessary"*. Eliminating the cron backstop is the load-bearing precondition for this ADR: orchd is now the only path, so its uptime story has to be real.
- [ADR-077](adr/077-superdoctor-cockpit-role.md) — medic (née superdoctor) original spec. This ADR narrows medic's load-bearing role to the supervision-escalation surface defined in D3 below; the broader hourly-`/whip` continues as today.
- [ADR-133](133-medic-rename.md) — superdoctor → medic rename. Identifier surface stays as-is (table `superdoctor_attempts`, member sentinel `__superdoctor__`).
- `docs/medic.md` — operator-facing reference; will pick up a "load-bearing for orchd self-healing escalation" callout in the same commit as D3 implementation per atmux same-commit-doc-update contract.

## Context

ADR-233 retired the cron backstop layer (`orchd --drain` every minute, `orchd --sweep`, `committer --sweep`) on the operator's stated principle: *"trust orchd to run"*. The architectural prerequisite was that orchd is reliable enough to be the only event-delivery path. The supervision surface as it stands today does not actually deliver that:

1. **The supervisor is the wrong shape.** It's a bash string generated in TypeScript at `src/core/orchd-window.ts:206-250`, pasted into a tmux pane via `send-keys`, watching a Rust binary. Three languages for one supervision loop. The PIPESTATUS regression in ADR-202 §1132 (where `RC=$?` after the `tee` pipe silently captured tee's 0 exit and disabled all auto-restart) is the canonical example of why this layering is fragile — the bug shipped, ran for an undetermined number of days, and was only caught because someone hand-audited the script. The same class of bug can recur in any future supervisor edit.
2. **No cross-team observability.** Each team's supervisor knows only about its own orchd. If team A's orchd dies and the supervisor's circuit breaker trips (5 crashes in <60s → exit 42 → dead pane), nothing else notices. No alert, no escalation, no automatic recovery. The operator finds out on next attach.
3. **No escalation path.** When a programmatic supervisor is out of options (binary missing from PATH, state.db corrupted, honker substrate fault that doesn't self-heal), there's nowhere to send "I tried, I failed, a human or a Claude needs to look at this". Today that case manifests as a dead tmux window with a CIRCUIT-BREAKER log line — which the operator may or may not see depending on cockpit attach cadence.

Tonight (2026-05-24) the failure mode was even cruder: no `__orchd__` window existed in either the atmux or sopx tmux sessions at all. The supervisor wasn't crashing, it wasn't running. Manual respawn (raw `tmux new-window` + bash supervisor invocation) restored orchd in both teams within ~10 seconds and the pending event queue drained. But the gap between "orchd died" and "operator noticed" was hours, and the only reason it was noticed is the operator opened a conversation about it.

This ADR proposes a three-tier supervision tree: fast programmatic retry inside orchd itself, slower programmatic cross-team supervisor at the cockpit, and slow-but-intelligent escalation to medic (a Claude) for cases the programmatic layers can't reason about. The shape mirrors industrial supervision trees (Erlang OTP, systemd, kubernetes pod → node → control-plane), with medic playing the role that a human operator would otherwise own.

## Decision

### D1 — Move supervision into `atmux-orchd` (Rust internal retry)

`rust/atmux-orchd/src/main.rs` gains an internal retry loop around the failure modes that today cause the supervisor to restart it:

- **`honker::Database::open` failure** — retry with exponential backoff (1s, 2s, 4s, 8s, 16s, 32s, then steady at 60s), logging each attempt. Never exit on db-open failure; the caller (tmux pane) cannot do anything more useful than retry.
- **`UpdateEvents::recv_timeout` → `Err(Error::UpdateClosed)`** — re-subscribe via `db.update_events()` and continue. Today this returns `ExitCode::SUCCESS` and lets the supervisor restart the whole process; that's a heavier hammer than needed.
- **Initial offset load failure** (e.g. `subscriber_offsets` table missing, as observed in `/tmp/orchd-pane.log` from a wrong-cwd invocation tonight) — treat as a recoverable substrate-not-ready signal: backoff + retry, log loudly so the operator sees what's happening, never exit. The table will land when the Bun side runs migrations on next `atmux start`.

The only conditions under which orchd exits are:
- **SIGTERM / SIGINT / SIGHUP from a real signal handler** (Rust-side `signal-hook` crate, not bash trap). Exits with code 0.
- **Genuine panic from a logic bug.** Aborts with code 134. Superorchd (D2) treats this differently from a clean exit — see D2.
- **Parent-death signal** (`PR_SET_PDEATHSIG(SIGTERM)`, already wired in `main.rs:60`) when the tmux pane is killed. Exits cleanly.

Net: the common transient-failure cases become invisible to the supervisor layer because orchd handles them internally. The supervisor (whatever form it takes) only sees process death, never per-iteration restarts.

**Consequence**: The bash supervisor at `orchd-window.ts:206-250` is no longer needed for crash recovery — orchd no longer crashes on transient failures. It is still needed for *process death* recovery (panic, OOM, SIGKILL, PR_SET_PDEATHSIG cascade after pane kill). That's D2's job.

### D2 — `atmux-superorchd` Rust binary at cockpit level

New crate: `rust/atmux-superorchd/`. Single-binary, runs as a long-lived process in a dedicated tmux window at the cockpit session (proposed window name `__superorchd__`, sibling to `superdriver` and `medic` per `docs/medic.md` cockpit layout).

Responsibilities, in priority order:

1. **Discover team orchds.** Read `~/.atmux/cockpit.json`; for each `type: "team"` entry with `enabled: true`, the expected orchd is one process per team root, identified by `atmux-orchd .atmux/state.db` cmdline at cwd `<team-root>`.
2. **Watch for liveness.** Every 30s (proposed; tune in D2 §open-tuning), `pgrep -af` style scan: for each expected orchd, confirm a process exists matching `(cwd=<team-root>, argv0=atmux-orchd)`. Cheap — no per-team file lock, no DB query. Liveness is process-level.
3. **Restart on death, with backoff.** If a team's orchd is dead:
   - First miss → spawn a fresh one (raw `tmux new-window` if `__orchd__` window missing, or `tmux send-keys` to existing window if shell is at prompt). Log to `~/.atmux/state/superorchd.log`.
   - Repeated misses with no successful liveness window between them → backoff (1s, 5s, 30s, 60s, 5m). After 3 failed restart attempts in 5 min → tier-3 escalation (D3).
4. **Distinguish clean exit from death.** A team that was explicitly stopped (`atmux stop <team>` flips cockpit.json `enabled: false`, or its tmux session is gone entirely) is NOT a death — superorchd skips re-spawn. Reads cockpit.json on each scan (cheap; ~1KB JSON) so operator stop-actions are reflected within one tick.
5. **Watch its own parent.** `PR_SET_PDEATHSIG(SIGTERM)` so superorchd dies with the cockpit pane. No nested supervisor for superorchd itself — if it dies, the operator notices (cockpit window 3 is empty) and runs `atmux cockpit rebuild` per ADR-233 §D2 *"if the cockpit is dead I will manually recreate it"*.

What superorchd does NOT do:
- Watch the cockpit's own `superdriver` window — that's the operator's REPL, not a supervised process. If it dies, the operator is the one who notices.
- Try to recover from corrupted state.db, missing binaries, or schema mismatches programmatically. Those go to tier 3.
- Send Discord pings directly. Escalation goes through medic, which already owns the Discord-ping vocabulary (per ADR-077 §complaint-box contract + ADR-133 dedup key `superdoctor-self-heal-escalation`). Single mouth, single dedup key, no double-paging.

**Consequence**: Cockpit gains a new always-on Rust process (~5-10 MB RSS expected; same shape as atmux-orchd). The per-team bash supervisors (`orchd-window.ts:206-250`) are removed from `maybeSpawnOrchdWindow` — superorchd owns the spawn-and-watch responsibility centrally. `atmux start <team>` still creates the `__orchd__` window for the team (no behavior change for operator), but its contents are now just `atmux-orchd .atmux/state.db` directly (no surrounding bash loop).

### D3 — superorchd → operator escalation via direct Discord + complaint-box record

**Revised 2026-05-24 in same session per operator directive *"no hourly whips or crons anymore"* + *"discord messages to boringly come from the kanban itself and not from any LLM anymore because that burns tokens"*** — see [ADR-237](237-no-llm-discord-and-whip-removal.md) for the upstream decision this depends on.

When superorchd hits the 3-failures-in-5-min ceiling on a team's orchd, escalation is **two-step, both deterministic, no LLM in the path**:

1. **Direct Discord ping** via the existing `abstractions/discord.send` surface, with a fixed template `[orchd-supervision-failure]` (sibling to `[whip-progress]`-class deterministic templates from `discorder.ts`). Payload composed in Rust from substrate data only — team name, team root, three exit codes, three log tails (last 5 lines each), state.db path, timestamp. No LLM. Dedup key `superorchd-{team}-{epoch_5min_bucket}` so a wedged team doesn't ping every 30s scan.
2. **Complaint-box record** in `superdoctor_attempts` table (storage identifier preserved per ADR-133 §Out of scope) with the same typed payload as Discord, plus an `operator_acked_at_sec` column that defaults NULL. The record is purely a log entry — nothing polls it, nothing acts on it autonomously. It exists so that **when the operator fires `atmux medic diagnose <team>` on-demand**, medic has structured context to read instead of starting from scratch.

Escalation payload shape (Rust `serde_json::Value`, posted to Discord as a code-block + written verbatim to `superdoctor_attempts.payload`):

```jsonc
{
  "kind": "orchd-supervision-failure",
  "team": "sopx",
  "team_root": "/root/work/ifca/src/sopx-root",
  "attempts": [
    { "ts": "2026-05-24T03:12:00Z", "exit_code": 134, "log_tail_lines": ["...", "...", "...", "...", "..."] },
    { "ts": "2026-05-24T03:12:35Z", "exit_code": 134, "log_tail_lines": ["...", "...", "...", "...", "..."] },
    { "ts": "2026-05-24T03:14:10Z", "exit_code": 134, "log_tail_lines": ["...", "...", "...", "...", "..."] }
  ],
  "last_log_path": "/root/work/ifca/src/sopx-root/.atmux/logs/orchd.log",
  "state_db": "/root/work/ifca/src/sopx-root/.atmux/state.db",
  "superorchd_action": "halt-and-escalate",
  "operator_action_hint": "attach cockpit window 3 (superorchd) for full log; `atmux medic diagnose sopx` for AI-reasoned write-up"
}
```

Latency budget: superorchd's failure window is 5 min. Discord ping is real-time (within one HTTP roundtrip, ~200ms). Operator sees the ping immediately on the device that has Discord notifications. No hourly whip in the path — the previous draft's ~1-hour worst-case escalation latency is gone. Medic-on-demand is the next step *if* the operator wants AI reasoning over the raw payload; otherwise the operator handles it directly.

### D4 — Medic is on-demand only, not always-on

**Revised 2026-05-24 in same session per operator directive *"no hourly whips or crons anymore"* + *"no more /loop /superdoctor startup message for _medic"*** — see [ADR-237](237-no-llm-discord-and-whip-removal.md) for the full medic-mode change.

The original draft of this ADR proposed upgrading medic from opt-in to recommended-on for multi-team setups, on the assumption that medic ran an hourly `/whip` loop and was the natural poll-and-react surface for superorchd's complaint-box escalations. Per the operator directive in the same session, **medic no longer runs any auto loop** — the `/loop /superdoctor` auto-start is removed (ADR-237 §D2), and medic is invoked solely by operator command (`atmux medic diagnose <team>` or interactive cockpit-window-2 paste).

Therefore this ADR's medic dependency reduces to: **medic stays available as a cockpit pane when the operator wants AI-reasoned diagnosis of a superorchd escalation**. The medic window is provisioned by `atmux cockpit rebuild` per ADR-077 (no change), but the cockpit-rebuild path no longer auto-fires `/loop /superdoctor` into it (per ADR-237 §D2). The pane sits at idle with the `/medic` skill loaded, ready for operator `/medic diagnose <team>` invocation.

Cost shift vs original draft:
- **Original (now revised away)**: ~one Opus+xhigh hourly session per host = ~24 medic turns/day per host even when nothing was wrong. Multi-team default flip would have made this universal.
- **Revised**: zero medic turns/day baseline; medic only consumes tokens when operator explicitly invokes it. Per-host cost goes from "always-on Opus tax" to "pay-per-invoke".

The recommended-on policy for multi-team is dropped — medic stays opt-in per `docs/medic.md` `Default state: off`, and even when enabled it does nothing until the operator fires it. Single-team and multi-team configs are now uniform in this regard.

Per the operator directive *"it loooks like we still need _medic around"*: medic's continued existence is justified by the on-demand diagnosis role over the superorchd complaint-box payloads. Without that role, medic would be a candidate for full deprecation; with it, medic remains a useful tool the operator reaches for during incident response. The role narrows but does not disappear.

### D5 — Remove bash supervisor from `orchd-window.ts`

After D1+D2 land in code, `src/core/orchd-window.ts::maybeSpawnOrchdWindow` is simplified:

- The `supervisorCmd` string (lines 206-250) is deleted.
- The send-keys payload becomes a direct invocation: `ATMUX_ORCHD_TEAM_DIR=$(pwd) atmux-orchd .atmux/state.db 2>&1 | tee -a .atmux/logs/orchd.log`. No bash loop, no trap, no circuit breaker, no PIPESTATUS gymnastics. orchd's internal retry (D1) handles transient failures; superorchd (D2) handles process death.
- The fallback `else atmux orchd --start` branch (Bun fallback for hosts without the Rust binary on PATH) is preserved as today — superorchd watches by argv match, so the fallback path is still recognizable. ADR-202 §VII degraded-mode semantics carry forward.

Tee is preserved because the operator-visible log file is still useful for post-mortem and for medic to read (D3 §"medic reads `last_log_path`").

## Consequences

- **One Rust binary owns orchd reliability** (D1) instead of TS-emits-bash-watches-Rust. The PIPESTATUS-class bug surface goes to zero — there's no pipe and no bash.
- **One Rust binary owns cross-team supervision** (D2). Cockpit gains a `__superorchd__` window (proposed; sibling to `superdriver` and `medic`). Per-host process, not per-team; ~5-10 MB RSS amortized across N teams instead of N × bash-supervisor processes.
- **Escalation has a real home** (D3, revised). "I can't fix this programmatically" lands in a direct Discord ping (`[orchd-supervision-failure]` template, deterministic Rust-composed payload, no LLM) + a complaint-box record for medic-on-demand reference. Single dedup key per 5-min epoch bucket prevents ping storms.
- **Medic is on-demand only** (D4, revised). No auto loop, no hourly whip, no `/loop /superdoctor` auto-start. Medic remains opt-in per `docs/medic.md` and is fired by operator via `atmux medic diagnose <team>` when AI-reasoned diagnosis is wanted over the deterministic Discord ping. Per-host token cost goes from "always-on hourly Opus tax" to "pay-per-invoke". See [ADR-237](237-no-llm-discord-and-whip-removal.md) for the full medic-mode change.
- **The bash supervisor goes away** (D5). One fewer language boundary in the per-team startup path. `maybeSpawnOrchdWindow` shrinks by ~40 lines.
- **Tests update.** `tests/unit/core/orchd-window.test.ts` (if it exists; verify on implementation) flips from asserting on supervisor bash content to asserting on direct-invocation payload. New tests for `atmux-superorchd` internal logic (liveness scan, backoff state machine, complaint emission) in `rust/atmux-superorchd/tests/`. medic's complaint-box consumer side gets a test case for `kind: "orchd-supervision-failure"` handling.
- **Doc updates.** `docs/medic.md` picks up a §"Load-bearing role: orchd self-healing escalation" section + the recommended-on policy for multi-team. `docs/ARCHITECTURE.md` (if it has a supervision section) reflects the three-tier shape. Same-commit-with-code per atmux convention.

## Open questions (to settle before D2 implementation lands)

1. **Liveness scan cadence.** Proposed 30s in D2 §2 — tune based on real failure-detection latency vs cockpit CPU cost. 10s is fine on hax (cheap pgrep); 60s is fine for a quieter host. Default and per-host override both desirable.
2. **Backoff curve.** Proposed 1s → 5s → 30s → 60s → 5m in D2 §3. Could be more aggressive (kubernetes-style 10s → 20s → 40s …) or more conservative (1m → 5m → 30m). Tradeoff: aggressive recovers fast from transient causes but burns CPU on persistent failures (which D3 catches anyway).
3. **Should superorchd watch the cockpit's own `medic` window?** Argument for: medic dying silently is itself a tier-3 failure mode this ADR doesn't address. Argument against: medic-down is operator-visible (no hourly Discord summaries), and superorchd watching medic introduces a circular-supervision concern (medic supervises orchd via complaint-box, superorchd supervises medic, what supervises superorchd?). Recommend defer — single-tier-per-process scope keeps the shape clean.
4. **(Resolved) Should `atmux start` prompt to enable medic at the multi-team threshold?** Moot post-D4-revision — medic stays opt-in regardless of team count and does nothing until operator-invoked.
5. **Identifier rename for `superdoctor_attempts` → `medic_attempts`.** Out of scope per ADR-133 §"Out of scope" (table renames require a separate schema-migration ADR). This ADR leaves the storage layer alone; superorchd writes to the existing table with the existing dedup key.
6. **`atmux medic diagnose <team>` verb.** D3 §2 references this as the operator-fired entry point for on-demand AI-reasoned diagnosis. Spec lives in [ADR-237](237-no-llm-discord-and-whip-removal.md) §D3 (verb shape, payload shape, error handling).

## Reversal

If the three-tier shape proves to be wrong:

- **Reverting D1** (orchd internal retry) is safe at any time — restore the bash supervisor's restart-on-crash semantics by re-enabling D5. orchd code stays as-is; internal retry just becomes a no-op path. Cost: the bash-supervisor class of bugs returns.
- **Reverting D2** (superorchd) is the larger reversal. If superorchd proves load-bearing-wrong (e.g., its cross-team scan starves the cockpit, or its complaint-box writes race medic's reads), drop the binary and fall back to per-team bash supervisors. Cost: lose cross-team observability and the typed escalation payload.
- **Reverting D4** (medic recommended-on for multi-team) is opt-in revert by the operator — set `medic.enabled: false` in cockpit.json. The supervision tier still works; failures just don't reach medic's reasoning surface.

Full revert is restoring `orchd-window.ts:206-250` bash supervisor + deleting the superorchd crate. ADR-233's cron-retirement stays as-is regardless — this ADR builds on ADR-233's foundation but doesn't depend on its details.
