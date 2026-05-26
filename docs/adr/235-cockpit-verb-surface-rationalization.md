# ADR-235: Cockpit verb-surface rationalization — `reconcile`/`doctor`/`up`/`start` orthogonality, cage-down banner, plain-English refusals

**Status**: proposed
**Date**: 2026-05-24
**Driver-ref**: 3 operator complaints filed against atmux team — `c-c26773f4` (cockpit fails to initiate teams, status lies), `c-2f491da0` (bare-zsh placeholder + operator-hostile destructive-op refusal), `c-8ecc181f` (verb proliferation `up`/`start`/`cockpit rebuild`/`doctor --fix` overlap without orthogonality).

## Context

The cockpit verb surface accreted four shipped verbs that overlap in scope without explicit precedence: `atmux up` ([ADR-010](010-up-verb.md), [ADR-044](044-up-attach-mode.md)), `atmux start` ([ADR-044](044-up-attach-mode.md), [ADR-082](082-worktree-isolation-per-member.md)), `atmux cockpit rebuild` ([ADR-063](063-cockpit-verb-port.md)), and `atmux doctor [--fix]` ([ADR-019](019-doctor-verb.md), [ADR-077](077-superdoctor-cockpit-role.md)). Each was authored to solve a distinct problem; the seams between them grew increasingly fuzzy as the cockpit topology matured through [ADR-089](089-hierarchical-cockpit.md) (recursive `sessions[]`), [ADR-135](135-cockpit-naming-convention.md) (`atmux_cockpit` + `_role` window prefix), and [ADR-167](167-cockpit-rotate-verb.md) (Rung C role rotation).

Three operator complaints converged on the same underlying gap:

1. **Verb-vs-state contract is opaque.** Operators cannot tell from the verb name whether a call is read-only (safe to run anytime) or mutating (may cycle cages, kill panes, restart cron). `atmux up` and `atmux cockpit rebuild` both bring up cages but with different idempotency guarantees and different blast radii. `atmux doctor --fix` does some mutations but not all the ones `cockpit rebuild` does.
2. **Cockpit windows misrepresent cage state.** When a cage is down (session missing on the per-team socket), the cockpit window for that cage shows as a **bare zsh prompt** rather than a banner pane describing the cage status + the recovery command. Operators see "the window is up" and assume the cage is healthy; in reality the cockpit window is a corpse of a prior attach loop that has bailed.
3. **`atmux status` reports `sessionState=up` despite tmux missing the session.** Per Explore audit of `src/verbs/status.ts:552`, the current implementation IS live (calls `tmux.session.hasSession` per poll, no cache). The operator's complaint c-c26773f4 surfaced from a state where the wrong tmux socket was probed (cockpit socket vs per-cage socket) — the boolean was honest but the socket was wrong. The fix is twofold: document the non-caching invariant + add a regression test, AND audit the socket-selection callsites to ensure `atmux status` per-team probes hit the per-cage socket, not the cockpit one.
4. **Destructive-op refusal messages are operator-hostile.** `src/verbs/cockpit.ts:2010` emits `"target slot ${targetIdx} occupied by '${occupant.name}'; _medic relocation kills it"` when `moveWindow --kill` is refused without `--yes`. The message describes the symptom but not the recovery command — the operator must read source to know whether to pass `--yes`, `--force-cycle`, or `--acknowledge-dangerous-bau-interruption`. Same shape recurs across several refusal sites in `cockpit.ts` and `start.ts`.
5. **`atmux start` does not refuse on degraded cockpit.** If cockpit windows are bare-zsh placeholders and the operator runs `atmux start` for a cage, the verb succeeds (per its narrow contract — spawn a cage session) but leaves the cockpit drift unresolved. Operators interpret the green exit as "everything is fine" and miss the underlying cockpit-vs-cage split state.

## Decision

Rationalize the cockpit verb surface around **four orthogonal verbs** with explicit read/write contracts, add a **cage-down banner contract** for cockpit windows, mandate **plain-English refusal messages** with explicit recovery commands, and codify the **status non-caching invariant** with a regression test.

### (D1) Verb taxonomy — four orthogonal verbs

| Verb | Reads? | Writes? | Scope | Replaces / aliases |
|---|---|---|---|---|
| `atmux cockpit doctor` | yes | NO | Whole cockpit: diff `cockpit.json` roster vs live tmux state + per-cage session state. Structured JSON via `--json`; human-readable diff by default. | New verb. Folds the cockpit-relevant probes from `atmux doctor` (cockpit-on-default-socket, tmux-version-mismatch, phantom-inboxes-for-cockpit-cages). `atmux doctor` retains the broader fleet probes. |
| `atmux cockpit reconcile` | yes | yes (idempotent) | Bring live tmux state into agreement with `cockpit.json`: ensure cockpit session, ensure cockpit windows, ensure per-cage sessions, prefix-chain, reapply tuiOverrides. | **Rename of `atmux cockpit rebuild`**. `rebuild` becomes a deprecation alias for one release cycle, emitting `[deprecated] use 'atmux cockpit reconcile'` to stderr on every call (per [ADR-159](159-gitter-to-committer-rename.md) gitter→committer rename precedent). |
| `atmux up` | yes | yes (composite) | First-time bring-up — wizard gate → cockpit doctor preflight → cockpit reconcile → attach. The composite is narrowed: `up` no longer duplicates reconcile logic; it calls reconcile. | Behaviour preserved; implementation narrowed. No alias. |
| `atmux start` | yes | yes | Spawn a single per-team cage session (the **team** verb). Refuses silent no-op on degraded cockpit per (D5) below. | Behaviour preserved + (D5) refusal added. No rename. |

`atmux doctor [--fix]` is **unchanged** for non-cockpit probes (deps, state-dir, webhook, host-pressure, skills-plugin, cron-config) but its cockpit-relevant probes are split:

- `atmux doctor` retains a **summary** of cockpit drift (one line per drifted cage) with a pointer to `atmux cockpit doctor` for the full diff. This keeps the existing `doctor` UX (operators know to run it on suspect-fleet-health) while routing detailed cockpit work to the dedicated verb.
- `atmux doctor --fix` retains its current scope (prune phantom-inboxes + rerun init --wizard) and does **NOT** call `cockpit reconcile`. Cockpit mutation requires the explicit `atmux cockpit reconcile` invocation. Rationale: separating doctor's lightweight fix-list from cockpit reconcile's heavier mutation surface gives operators a graduated escalation path — doctor for the small stuff, cockpit reconcile for the structural stuff.

### (D2) Cage-down banner contract for cockpit windows

When `atmux cockpit reconcile` (or `atmux up`) creates a cockpit window for a cage whose per-team session is absent, the window MUST display a **banner pane** instead of falling back to bare zsh. The banner pane:

- Renders via a deterministic `cat /tmp/atmux-cockpit-banner-<team>.txt; sleep 60; exec $0` loop that re-renders every 60s by re-`cat`-ing the banner file (banner is mutable; reconcile rewrites it on each pass).
- Shows: cage name, current cage status (one of `down` / `stopped` / `starting` / `unknown`), last-known cause if available (from `.atmux/state/cage-status-<team>.json`), and **the exact recovery command** — typically `atmux start --team <name>` for cold start, or `atmux cockpit reconcile` for orchestrated bring-up.
- Auto-replaces itself with the real cage-attach loop on the next reconcile pass once the cage session comes up — no operator intervention needed to "convert" the banner pane to the live attach.

The banner is the new **default placeholder**; bare-zsh fallback is deleted. If banner-write fails (disk full, permission), the placeholder degrades to a single-line `echo "atmux: cockpit banner write failed; see logs"` pane — never to an interactive shell that could mask the real state.

Implementation site: extend the existing `shellPlaceholder()` / `cageRetryLoop()` helpers in `src/verbs/cockpit.ts` (per Explore audit §3). Test fixture: a cage with no per-team session present, run `atmux cockpit reconcile`, assert window content matches banner pattern.

### (D3) Plain-English refusal-message contract

Every refusal message emitted by cockpit-adjacent verbs (`cockpit.ts`, `start.ts`, `up.ts`, `cockpit-rotate.ts`) MUST contain three named elements, in this order:

1. **What action was refused** — imperative verb + target (e.g. "Cannot move window from slot 5 to slot 2").
2. **Why it was refused** — the specific state that blocks the action, with all relevant IDs/names inlined (e.g. "slot 2 is occupied by '_medic' (window id 12345, pane id 67890)").
3. **What to run next** — the exact recovery command, including all flags the operator would need to pass (e.g. "To proceed, run: `atmux cockpit reconcile --yes --force-cycle --acknowledge-dangerous-bau-interruption`"). If there is no single recovery command (e.g. operator must inspect and decide), state that explicitly + name the inspection command (e.g. "Inspect with: `atmux cockpit doctor --json` then choose: (a) ... (b) ...").

Existing refusals to audit + rewrite (non-exhaustive — Story acceptance criteria enumerate the full list from `rg -n 'target slot|occupied|refuse|abort|cannot' src/verbs/cockpit.ts src/verbs/start.ts src/verbs/up.ts`):

- `cockpit.ts:2010` — "target slot N occupied by 'X'; _medic relocation kills it" → "Cannot move window to slot N — already occupied by '<name>' (window id <id>). To proceed, run: `atmux cockpit reconcile --yes` (relocates the occupant safely) or `atmux cockpit reconcile --yes --force-cycle` (kills the occupant pane; requires `--acknowledge-dangerous-bau-interruption`)."
- `cockpit.ts:314-318` — destructive-cockpit-reconcile gate refusal needs the same shape.
- `start.ts` cage-already-up refusal, `up.ts` wizard-incomplete refusal.

### (D4) Status non-caching invariant

`atmux status` (and the new `atmux cockpit doctor`) MUST call `tmux.session.hasSession()` per poll for every probed session — no in-process cache, no stale-marker fallback. The current implementation at `src/verbs/status.ts:552` is the canonical reference; this ADR codifies it as a tested invariant.

Codify via:
- Inline comment at `status.ts:552` citing this ADR (`// per ADR-235 §D4 — sessionState MUST reflect live tmux state, no cache`).
- Regression test that mocks a session into existence, captures `sessionState=up`, kills the session, re-runs status, asserts `sessionState=down` with no intermediate sleep.

The operator complaint c-c26773f4 (`status reports sessionState=up despite tmux has-session missing`) surfaced from a different code path — likely a per-team probe hitting the **wrong socket** (cockpit socket vs per-cage socket). Story S2 includes an audit Task: trace every `hasSession()` call in `status.ts` and `cockpit.ts` to confirm it hits the correct socket for its scope (cockpit-level checks → cockpit socket; per-cage checks → per-cage socket). Any drift found → fix in the same Task.

### (D5) `atmux start` refuses silent no-op on degraded cockpit

When `atmux start` is invoked AND `atmux cockpit doctor` would report drift (cockpit windows present without backing cages, banner-pane signature mismatched, prefix-chain misapplied), `atmux start` fails fast with:

```
atmux: cockpit drift detected — start refused.
Run `atmux cockpit doctor` to see the diff, then `atmux cockpit reconcile` to fix.
Bypass (not recommended): re-run with --accept-cockpit-drift.
```

Exit code `65` (EX_DATAERR per ADR-167 §pre-flight gate matrix precedent). The check is in-process — `atmux start` calls the cockpit-doctor diff routine directly, no shell-out.

`--accept-cockpit-drift` is the explicit operator override for "I know the cockpit is in a transitional state, proceed anyway." Recorded to `.atmux/state/cockpit-drift-overrides.log` (NDJSON) for post-incident audit.

### (D6) Docs surface — `docs/RUNBOOK-cockpit.md` §verb-precedence

Add a new section to `docs/RUNBOOK-cockpit.md` (per Explore audit §6, lands cleanly after the existing §4 Doctor probes). The section enumerates:

- The four verbs in the new taxonomy + their read/write contracts (table mirroring D1).
- A decision tree: "I want to ___" → which verb to run (cold first-time bring-up → `atmux up`; routine drift check → `atmux cockpit doctor`; routine bring-into-agreement → `atmux cockpit reconcile`; spawn one cage standalone → `atmux start`).
- The `rebuild` deprecation note pointing to `reconcile`.
- The cage-down banner contract (operators reading the runbook should understand what a banner pane means and what to do about it).
- The refusal-message contract (so operators can recognize a non-compliant refusal and file a complaint if they see one).

CHANGELOG entry per [ADR-147](147-ombudsman-and-release-notes.md) format; README `## What's new` pointer.

## Consequences

**What changes for which lanes:**
- **BE**: new `cockpit doctor` subverb; rename `rebuild → reconcile` with alias; banner pane in `cockpit.ts`; refusal-message rewrite across `cockpit.ts`/`start.ts`/`up.ts`/`cockpit-rotate.ts`; degraded-cockpit gate in `start.ts`.
- **TEST**: regression test for status non-caching invariant; cage-down banner fixture; refusal-message snapshot tests; deprecation-alias coverage; degraded-cockpit refusal e2e.
- **MISC/Docs**: `docs/RUNBOOK-cockpit.md` §verb-precedence, CHANGELOG entry, README pointer.
- **REVIEW**: doc-update column applies to every Task that touches a documented surface (verb signatures, refusal messages, RUNBOOK).

**What breaks:**
- Scripts that shell out to `atmux cockpit rebuild` continue to work for one release cycle (alias), then must migrate to `reconcile`. Operator dotfiles (`~/work/journals/.sb/_dotfiles`) need a one-line update; bundled in the Story.
- Operator muscle memory: `cockpit rebuild` → `cockpit reconcile`. Deprecation warning on every call makes the transition self-documenting.
- Bare-zsh cockpit windows from prior atmux versions: on first `cockpit reconcile` after upgrade, they get replaced by banner panes. No state loss (bare-zsh had no state).

**What we give up:**
- The implicit "doctor --fix can fix anything" model. Going forward, `doctor --fix` is for the small-stuff fix-list; `cockpit reconcile` is the structural fix. Operators must learn which verb to reach for; the runbook decision tree mitigates.
- Single-verb "fix everything" affordance. Replaced by explicit two-step (`doctor` → `reconcile`) — slightly more typing, much higher predictability.

**Rollback path:**
- ADRs are append-only; rollback via supersession ADR.
- Code rollback: revert the rename commit + restore bare-zsh fallback in `cockpit.ts`. Banner contract is additive; refusal-message rewrites are textual; `--accept-cockpit-drift` flag is additive. No schema changes (no migration needed).
- If `cockpit reconcile` semantics turn out to misalign with operator workflow under load (e.g. unexpected cycle behavior on a live cage), the Story-S1 rename can be reverted in isolation while keeping the other Stories.

## Open questions

1. **OQ1 — `cockpit doctor` exit code on detected drift.** Options: (a) always exit 0 (read-only verb, drift is data not failure), (b) exit 0 on no-drift / 1 on drift (shell-script-friendly), (c) `--exit-on-drift` flag. **Recommended default: (b) — exit 1 on drift.** Matches `atmux doctor` precedent (exit 0 green / 1 red). Operators chain `atmux cockpit doctor && do-thing` naturally. `--ignore-drift` opt-out for diff-display-only use. **Reversibility: low** — flag semantics are stable + invertible.

2. **OQ2 — Banner pane refresh cadence.** Options: (a) 60s `sleep`-loop re-`cat`, (b) `inotifywait` on banner file, (c) one-shot render (no auto-refresh). **Recommended default: (a) — 60s sleep loop.** Matches existing `cageRetryLoop()` cadence; no new dependency on `inotifywait` (not present on all hax-target OSes). Trade: 60s lag on banner content updates after a reconcile. Acceptable — banner updates are rare. **Reversibility: medium** — tightening cadence later requires changing every operator's banner-pane process; loose default is safer.

3. **OQ3 — `--accept-cockpit-drift` audit-log retention.** Options: (a) NDJSON append-forever, (b) rotate after 30 days, (c) cap at 1000 entries. **Recommended default: (a) — append-forever.** Override-audit volume is low (operators rarely override); retention helps post-incident analysis. Disk usage trivial. **Reversibility: low** — rotation policy can be added later without breaking readers.

4. **OQ4 — Deprecation window length for `cockpit rebuild` alias.** Options: (a) one release (`0.8.x → 0.9.x` removes alias), (b) two releases, (c) keep alias indefinitely. **Recommended default: (a) — one release.** Matches [ADR-159](159-gitter-to-committer-rename.md) gitter→committer rename precedent. The deprecation warning fires on every call, so operators are loudly informed. **Reversibility: medium** — extending the window mid-deprecation is cheap; shortening it after operators ignore the warning is harder.

5. **OQ5 — Should `atmux doctor` retain its current cockpit-summary line, or punt entirely to `atmux cockpit doctor`?** Options: (a) summary line stays (current decision), (b) full punt — `atmux doctor` no longer mentions cockpit, recommends `atmux cockpit doctor` on first run, (c) summary line + an `--include-cockpit` flag that triggers full diff inline. **Recommended default: (a) — summary line stays.** Operators run `atmux doctor` as a daily-health check; losing the cockpit summary would degrade that UX. Summary is one line per drifted cage; cheap to keep. **Reversibility: low** — adding/removing summary lines is text-only.

All open questions resolved at LOW or MEDIUM reversibility. No HIGH-reversibility forks — design is well-bounded by existing ADR precedent. Resolutions land via `atmux decisions add` at decomposition time (per planner brief §Recording resolved open questions).
