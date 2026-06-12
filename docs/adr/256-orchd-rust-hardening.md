# ADR-256: orchd Rust supervisor hardening — bounded subprocess waits, poison-event tripwire, test backfill

**Status**: accepted
**Date**: 2026-06-05
**Driver-ref**: P1 hardening pass on the `atmux-orchd` Rust supervisor (`rust/atmux-orchd/src/main.rs`). Three findings drive this ADR: `rust-orchd-unbounded-blocking-subprocess` (a hung Bun child freezes the whole supervisor thread), `rust-orchd-poison-pill-retry-storm` (one deterministically-failing event retries forever, never advancing the offset), `rust-crates-zero-tests-adr249-coverage-lie` ([ADR-249](249-orchd-singleton-guard.md) claimed "Tests: covered" while `cargo test` ran **0 tests**).

## Context

`atmux-orchd` is the per-team event-router supervisor ([ADR-202](202-honker-in-db-messaging-substrate.md) §VII): it stays subscribed to the Honker `UpdateEvents` waker, drains the `events` table per consumer offset, and spawns a one-shot Bun child (`atmux orchd --handle-one --event-id <id>`) per event plus periodic tick subprocesses (`--sweep-merges` / `--scan-context` / `--scan-budget` / `--housekeep`). It is the single point through which **every** team event flows. Two structural fragilities and one documentation lie:

1. **Unbounded blocking waits** (`rust-orchd-unbounded-blocking-subprocess`). Every nested spawn used `Command::status()`, which blocks the calling thread **until the child exits — with no upper bound**. orchd is single-threaded over its dispatch + tick loop, so a single hung Bun child (a deadlocked `git merge`, a wedged network call inside a handler, an infinite loop) **freezes the entire supervisor**: no further event dispatch, no ticker progress, the team's whole substrate stalls behind one stuck process until the operator notices and kills it by hand. The orphan-on-parent-death guard (`PR_SET_PDEATHSIG`) doesn't help — orchd itself is alive, just blocked.

2. **Poison-event retry storm** (`rust-orchd-poison-pill-retry-storm`). On a non-zero Bun exit, orchd (correctly, for transient faults) does **not** advance the consumer offset — next wake re-drains from the same offset and retries (at-least-once delivery, [ADR-202](202-honker-in-db-messaging-substrate.md) §D7). But a **deterministically poison** event — a corrupt payload, or an input that trips a handler bug every single time — fails identically on every retry. The offset **never** advances, so this one event re-spawns Bun on every commit-wake AND every 60s timeout-drain, **forever**, and worse, **blocks every later event for that consumer behind it** (the drain `break`s on first failure). One bad row wedges a consumer permanently and burns Bun cold-starts in a tight loop. [ADR-231](231-orchd-auto-spawn-and-solo-worker-dissolve.md)'s lesson ("retry storms hide root causes; operator-visible signal beats silent infinite retry") was applied on the Bun side's spawn classifier but **not** on the Rust dispatch loop.

3. **Zero tests behind a "covered" claim** (`rust-crates-zero-tests-adr249-coverage-lie`). [ADR-249](249-orchd-singleton-guard.md) §Consequences asserted "**Tests**: covered in `rust/atmux-orchd`". The crate had **no `#[cfg(test)]` module at all** — `cargo test` printed `running 0 tests`. The singleton-lock-path collision matrix (the load-bearing correctness of the duplicate-orchd guard) was entirely unverified. This is exactly the "fake tests passing when they pass nothing" failure the project's NO-LIES doctrine forbids.

## Decision

### (D1) Bounded nested-subprocess waits — std-only, no new crate

Replace every `Command::status()` with `Command::spawn()` + a bounded `try_wait()` poll loop against a deadline (`wait_bounded(child, deadline, label) -> WaitOutcome`). When the deadline lapses, escalate **SIGTERM → grace → SIGKILL** and reap (`terminate_child`):

- Poll `child.try_wait()` every `WAIT_POLL` (50ms — negligible latency overhead, ~20 idle wakeups/sec only while a child is live).
- On the child exiting first → `WaitOutcome::Exited(code)`.
- On deadline → `SIGTERM` the child PID (`libc::kill`, Linux), wait up to `TERM_GRACE_SECS` (5s) for a clean shutdown (flush logs, release flocks), then `SIGKILL` + a blocking `wait()` to reap (no zombie) → `WaitOutcome::TimedOut`.
- We signal the **child PID directly, not the process group** (`kill(pid)`, not `kill(-pgid)`): the child inherits orchd's own process group, so a group-kill would also signal orchd itself.

Deadlines are env-tunable, **fail-closed** (non-numeric / zero ⇒ fall back to the default — a 0s deadline would kill every child before it starts; mirrors the `ATMUX_SPAWN_TIMEOUT_MS` fail-closed parsing in `CLAUDE.md`):

| Env | Default | Applies to |
|---|---|---|
| `ATMUX_ORCHD_HANDLER_TIMEOUT_SECS` | `600` (10min) | per-event `--handle-one` Bun handler |
| `ATMUX_ORCHD_TICK_TIMEOUT_SECS` | `900` (15min) | each `--sweep-merges` / `--scan-*` / `--housekeep` tick |

Defaults are generous on purpose — a real git-merge handler or a fleet-wide budget scan can legitimately run for tens of seconds (large rebase, submodule fan-in). The fix bounds **pathological** hangs (minutes→forever), not honest work. Why std-only: the build must not network-fetch a crate, and the `libc` dependency is already Linux-gated for `PR_SET_PDEATHSIG` + `flock`, so `libc::kill` adds nothing. No async runtime, no `tokio`, no `wait-timeout` crate. `Cargo.toml` is unchanged.

### (D2) Poison-event tripwire — dead-letter after N strikes

Add a per-`(consumer, event_id)` consecutive-failure counter (`PoisonStrikes = HashMap<&'static str, (String, u32)>`), lifetime-bound to the supervisor so strikes accumulate across wakes. On the **unexpected-throw path ONLY** — `WaitOutcome::Exited(Some(non-zero))`, i.e. the Bun handler threw or refused on *this* event:

- Below `ATMUX_ORCHD_POISON_STRIKES` (default **5**): existing behavior — don't advance, `break`, retry next wake. Strike count incremented; logged as `strike N/M`.
- At/over the threshold: **dead-letter**. Emit an `orchd.event-dead-lettered` row into the `events` table (`emit_dead_letter`), **advance the offset past the poison event**, clear the strike entry, and `continue` draining the consumer's later events (so the poison row doesn't also stall the backlog behind it).

The counter is **reset** the instant the head event advances (clean exit OR dead-letter) or a different `event_id` becomes the head for that consumer — so a flaky-then-recovering handler never trips the wire; only a deterministically-poison row does.

**Scope guard — what is NOT counted as a strike** (per the finding's "do NOT touch the documented mark/flag/advance handler classes"):
- `WaitOutcome::Exited(Some(0))` — clean exit (the Bun handler's own mark/flag/advance-then-exit-0 classes from [ADR-231](231-orchd-auto-spawn-and-solo-worker-dissolve.md) §D5/§D6) already advances; untouched.
- `WaitOutcome::Exited(None)` — killed by an external signal (OOM / operator kill) or an orchd-side spawn fault — **not the event's fault**; no strike.
- `WaitOutcome::TimedOut` — a hang is transient/environmental (deadlock, slow IO), **not a deterministic poison row**; no strike (and orchd already SIGKILL'd the child via D1).

Only an honest, repeatable non-zero throw on the same row counts. The dead-letter `orchd.event-dead-lettered` topic is **intentionally outside** the closed Zod v1 topic set (`src/schema/events.ts`): no consumer subscribes to it, so the Bun-side `drainSince` Zod parse correctly skipping it as unknown is fine — it exists purely as a durable operator-visible breadcrumb (`SELECT * FROM events WHERE topic = 'orchd.event-dead-lettered'`), carrying `{ consumer, deadEventId, deadTopic, strikes, lastExitCode }` plus the standard `{ topic, eventId, emittedAtSec, schemaVersion }` envelope. Its `eventId` is a real UUIDv7 (`uuidv7_now`, a std-only SplitMix64-seeded port of `src/abstractions/uuidv7.ts`) so it sorts time-ordered alongside Bun-emitted events in the `event_id ASC` drain. The INSERT is best-effort (`INSERT OR IGNORE`, errors logged + swallowed) so a substrate hiccup can't wedge the tripwire itself — the offset still advances to break the storm even if the breadcrumb write fails.

### (D3) Test backfill — `#[cfg(test)] mod tests` in `main.rs`

11 tests, std-only (no `tempfile` crate — unique tmpdirs via `env::temp_dir()` + PID + atomic seq):

- **ADR-249 singleton-lock collision matrix** (makes [ADR-249](249-orchd-singleton-guard.md)'s coverage claim TRUE): `singleton_lock_relative_and_absolute_collide_for_same_db` (same DB, two argv styles ⇒ one canonical lock), `singleton_lock_distinct_teams_never_collide` (two teams ⇒ distinct locks — the naive basename-only key would collide them, which is the duplicate-spawn bug ADR-249 closes), `singleton_lock_path_for_missing_parent_falls_back_without_panicking`, and `singleton_lock_second_acquire_refuses` (a same-process double-`flock` — the deterministic equivalent of "a second orchd against the same DB exits 5": the `Err` it asserts is exactly what `main()` maps to `ExitCode::from(5)` + the refusal log; also proves kernel-releases-on-fd-close self-healing).
- **Bounded-wait**: `wait_bounded_returns_exit_code_for_fast_child`, `wait_bounded_propagates_nonzero_exit`, and `wait_bounded_kills_hung_child_on_deadline` (spawns a `sleep 120`, bounds the deadline to 150ms, asserts `TimedOut` AND that the call returns well under `TERM_GRACE + slack` — proving it does NOT block unboundedly).
- **Dead-letter**: `emit_dead_letter_writes_operator_visible_row` asserts the row's topic + every payload field + that `eventId` is a real UUIDv7.
- **UUIDv7**: `uuidv7_now_has_v7_shape_and_is_unique` (shape + version/variant nibbles + uniqueness) and `uuidv7_now_is_time_ordered_across_milliseconds` (cross-ms lexicographic ordering — the load-bearing property for the `event_id ASC` drain). We deliberately do NOT assert same-millisecond ordering: like the Bun-side `uuidv7.ts`, the 74 low bits are pseudo-random, so within one millisecond the order is undefined (RFC 9562's optional monotonic-random method, which neither half implements). Asserting it would be a NO-LIES violation.
- **Fail-closed env parsing**: `env_u64_or_falls_back_on_bad_or_zero_values` (unset / garbage / zero ⇒ default; trimmed valid ⇒ parsed).

### (D4) ADR-249 coverage reconciliation

[ADR-249](249-orchd-singleton-guard.md) §Consequences "Tests: covered" was a **forward-reference that had not landed** — a false "covered" until this ADR. Now that the collision-matrix + acquire/refuse tests exist (D3), the claim is **true**; ADR-249 is edited to name the specific tests and point at this ADR. (Had the tests proven infeasible, the correct move would have been to *downgrade* ADR-249's claim — never leave a false "covered". They were feasible.)

## Consequences

- **orchd resilience**: a hung Bun child is now killed at the deadline instead of freezing the supervisor; a poison event is dead-lettered after 5 strikes instead of retry-storming forever + wedging its consumer's backlog. Both are operator-visible (timeout log line names the wedged subprocess; dead-letter emits a durable `events` row).
- **Behavior change — `dispatch_to_bun` signature**: returns `WaitOutcome` (was `Option<i32>`). `drain_and_dispatch` gains a `&mut PoisonStrikes` param. These are internal Rust surfaces (not a documented cross-process wire contract — the `atmux orchd --handle-one` CLI protocol in §VII is unchanged), so no Bun-side doc update is required; the wire protocol comment block at the top of `main.rs` still holds.
- **Tick spawns** (`spawn_sweep_merges` / `spawn_scan_budget` / `spawn_housekeep` / `spawn_scan_context`) are de-duplicated through one bounded `run_tick_bounded` helper.
- **Deploy**: takes effect on the next orchd (re)start per cage (`build:install` + restart the `__orchd__` window). Already-running orchd keep the old binary until restarted — matching [ADR-249](249-orchd-singleton-guard.md)'s deploy note.
- **New env knobs**: `ATMUX_ORCHD_HANDLER_TIMEOUT_SECS`, `ATMUX_ORCHD_TICK_TIMEOUT_SECS`, `ATMUX_ORCHD_POISON_STRIKES` (all fail-closed to defaults).
- **`cargo test`**: was 0 tests, now 11 passing. ADR-249's coverage claim is no longer a lie.

## Out of scope

- A first-class Zod topic + typed consumer for `orchd.event-dead-lettered` (`src/schema/events.ts` is owned elsewhere this pass; the breadcrumb row is operator-visible via SQL today). A follow-up may register the topic + a lead-inbox consumer so dead-letters page the operator like complaints do ([ADR-214](214-retire-ombudsman-lead-absorbs-complaint-adjudication-via-honker.md) §D2 routing) — noted, not built.
- RFC 9562 monotonic-random UUIDv7 (same-ms ordering). Neither orchd nor the Bun side needs it; cross-ms ordering suffices for the `event_id ASC` drain.
- Per-handler-class deadline tuning (one handler deadline for all consumers today). If a specific consumer's handler legitimately needs longer than the global default, the operator raises `ATMUX_ORCHD_HANDLER_TIMEOUT_SECS`; per-consumer overrides are deferred until a real need surfaces.
