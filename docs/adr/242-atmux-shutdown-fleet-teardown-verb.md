# ADR-242: `atmux shutdown` — single-verb whole-fleet teardown

**Status**: Accepted (operator-direct 2026-05-25 *"we need a atmux shutdown as well"* + *"let's do the recommended"*)

**Date**: 2026-05-25

**Driver-ref**: 2026-05-25 conversation:
- *"and we need a atmux shutdown as well wdyt"*
- *"let's do the recommended"* (greenlighting the proposal in the prior response)

**Cross-refs**:
- [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) §D2 — *"if the cockpit is dead I will manually recreate it"*. `atmux shutdown` makes the inverse path (cockpit-explicit-teardown) a first-class verb so the operator isn't reaching for `tmux kill-server` directly.
- [ADR-077](adr/077-superdoctor-cockpit-role.md) / `docs/medic.md` — cockpit-window layout (`superdriver`, `medic`); shutdown's scope-boundary question is "does it kill operator-REPL windows?" and the answer is yes (D2 below).
- [ADR-191](191-vendored-tmux-binary.md) — vendored-tmux pinning makes the `kill-server` target unambiguous; shutdown invokes `tmux -L atmux kill-server` against the atmux-pinned socket only, never the operator's personal `tmux`.
- [ADR-240](240-drop-superorchd-orchd-self-supervises.md) — sibling cleanup-pass ADR (same operator-direct session, *"simpler is better"*). `atmux shutdown` exists in part because there's no longer a superorchd / external supervisor that would re-spawn things behind the operator's back.
- [ADR-241](241-atmux-start-preflight-deps-wizard.md) — sibling start-side ADR. Symmetric pair: `atmux start` brings the fleet up; `atmux shutdown` takes it down.

## Context

Today, tearing the whole atmux fleet down on a host is a multi-step ritual:

1. `atmux stop <team>` for each enabled team in `~/.atmux/cockpit.json` (per-team verb already exists).
2. Kill the per-team tmux session if it didn't fully clean up.
3. Kill the cockpit tmux session (`superdriver` + `medic` + any other cockpit-scope windows).
4. Optionally: `tmux -L atmux kill-server` to be sure no atmux-pinned socket is left lingering.

There's no single verb that does all of this. The operator either runs steps 1-4 manually or reaches for `tmux kill-server`, which is over-broad (would kill operator-personal tmux sessions too if the socket weren't pinned per ADR-191).

The asymmetry with `atmux start` is glaring: one verb brings up the whole fleet, four steps tear it down. ADR-241 makes `atmux start` a single-command boot. This ADR makes `atmux shutdown` its single-command inverse.

## Decision

### D1 — `atmux shutdown` verb at `src/verbs/shutdown.ts`

New verb. Default invocation `atmux shutdown` does the following, in order:

1. **Enumerate teams** — read `~/.atmux/cockpit.json`, filter to `type: "team"` entries with `enabled: true`. Order doesn't matter (no inter-team ordering constraint after ADR-240's superorchd drop).
2. **Per-team stop** — `atmux stop <team>` for each. Best-effort: failures on a single team log a warning and the sweep continues to the next team. (Failure-modes: tmux session already gone, state.db locked, etc. — none of these block the rest of the teardown.)
3. **Kill cockpit windows** — `tmux -L atmux kill-session -t cockpit` (atmux-pinned socket per ADR-162 / ADR-191). Tears down `superdriver`, `medic`, and any other cockpit-scope windows in one shot.
4. **Kill the atmux tmux server** — `tmux -L atmux kill-server`. Guarantees no atmux-pinned socket leftovers. Operator's personal tmux (default socket) is untouched.
5. **Stop the orchd processes** if any survived the per-team stop (orchd's `PR_SET_PDEATHSIG(SIGTERM)` should already have fired when its tmux pane was killed in step 3, but a paranoid `pkill -f 'atmux-orchd .atmux/state.db'` sweep catches any orphans). Log each killed pid for the operator's audit trail.
6. **Emit a one-line summary** — `[atmux shutdown] N teams stopped, cockpit torn down, M orphan orchds reaped (Xs)` — written to stdout, also persisted to `~/.atmux/state/shutdown.log` (append-only, last 10 entries; operator can `tail` for post-mortem if a shutdown looked weird).

### D2 — Scope boundary: shutdown kills EVERYTHING atmux

`atmux shutdown` kills the operator's `superdriver` REPL window too. Rationale: "shutdown" means the whole atmux footprint goes away. If the operator wanted to keep the REPL alive while tearing down teams, that's `atmux stop <team>` per team — the verb already exists. `atmux shutdown` is the nuclear option; partial shutdown isn't a use case this verb exists to serve.

The operator's *personal* tmux sessions (default socket, `tmux ls` on the operator's PATH-resolved tmux binary) are NOT touched. ADR-191's socket pinning + the explicit `-L atmux` socket name in steps 3-4 guarantee this. The boundary is at the atmux-pinned socket, not at the binary.

### D3 — Flags

- `--keep-cockpit` — runs steps 1+2 (stop teams) and 5 (orphan-orchd sweep) but SKIPS steps 3+4 (cockpit + tmux server). Use case: operator wants to drain all teams but keep `superdriver` / `medic` alive for diagnostic work. The cockpit is then idle (no team windows in it) but still attachable.
- `--force` — skip the per-team `atmux stop` (D1 step 2) and go straight to tmux-kill (D1 steps 3+4). Use case: a team's `atmux stop` is hanging on a wedged orchd or honker substrate; operator wants to short-circuit. Tradeoff: bypasses team-state-cleanup that `atmux stop` does (e.g. flushing kanban writes, releasing locks). Operator's call.
- `--dry-run` — enumerate + log what WOULD happen, take no action. Safe to run anywhere; exit 0 regardless. For "is this going to do what I expect" verification before pulling the trigger.

`--keep-cockpit` and `--force` are independent; both can be set (drain teams, skip per-team-stop, leave cockpit alive).

### D4 — Reversal: `atmux start`

There is no "atmux startup-from-shutdown-state" verb. The reversal of `atmux shutdown` is `atmux start` (with the ADR-241 preflight already shipped). Same enumeration of `cockpit.json`, same per-team bring-up, fresh cockpit windows. The cockpit-state-recovery path is just "the cockpit is freshly minted" — there's no in-flight work to recover because shutdown is a graceful drain (per D1 step 2 calling `atmux stop` which flushes kanban writes).

This means cockpit.json is the **only** persisted state across a shutdown→start cycle. Everything else (tmux windows, orchd processes, in-flight panes, scratch buffers) is ephemeral by design. Confirmed alignment with ADR-233's *"trust orchd to run"* — orchd's substrate is `.atmux/state.db` per team, which survives shutdown trivially because it's just a SQLite file on disk.

### D5 — Out of scope

- **Multi-host shutdown** (kill atmux on every host the operator owns). Single-host scope; if you have atmux on hax + local, that's two `atmux shutdown` invocations, one per host. Per-host scope keeps the verb's blast radius bounded and predictable.
- **Selective shutdown by tag / label** (`atmux shutdown --tag prod`). Not a use case today. If operator wants to stop a subset, that's `atmux stop <team>` per team in the subset. Tags/labels can be added later without disturbing this ADR.
- **Operator-confirmation prompt before the kill**. `atmux shutdown` is the nuclear verb; if the operator typed it, they meant it. No `[y/N]` prompt. (Sibling reasoning to `rm` not prompting before delete; the `--dry-run` flag is the safety valve for "I wasn't sure what this would do".)

## Consequences

- One new verb at `src/verbs/shutdown.ts`. CLI surface gains `atmux shutdown [--keep-cockpit] [--force] [--dry-run]`. Verb registry / help text update at the usual entry point.
- `tests/unit/verbs/shutdown.test.ts` — new file. Coverage for: empty-cockpit (no teams) → just kills cockpit + server; multi-team → all stopped + cockpit gone; `--force` skips per-team-stop; `--keep-cockpit` skips cockpit kill; `--dry-run` enumerates without acting; orphan-orchd reap works. Injectable seams for `cockpit.json` read, `atmux stop` invocation, tmux spawn.
- README picks up a §"Tearing down the fleet" section with the verb + flag table. Same commit as the verb lands.
- CHANGELOG `[Unreleased] §Added` — `atmux shutdown` verb.
- No docs/ARCHITECTURE.md change required; shutdown is a verb-level addition, not an architectural one. (If reviewer disagrees, fold in same-commit.)

## Reversal

If the verb proves to be a footgun (e.g. operator runs it expecting per-team scope, kills cockpit + loses REPL state):

- Add an interactive confirmation prompt as a non-breaking change in a follow-up. D5 deliberately omits this; reversal is "add it back if real operator-experience says so."
- For full revert, delete `src/verbs/shutdown.ts` + registry entry + tests. Operator goes back to the 4-step manual ritual described in §Context. No persisted-state migration needed (the verb writes only the append-only `shutdown.log`, which is harmless leftover).

The verb is additive; nothing depends on it. Reversal cost is minimal.
