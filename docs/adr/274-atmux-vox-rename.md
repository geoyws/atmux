# ADR-274 — The voice operator interface is named **atmux vox**

Status: proposed
Date: 2026-08-16
Supersedes: [ADR-272](272-voice-operator-interface.md) **OQ-5** (resolved 2026-08-14 as "`voice` stands as a top-level verb")
Relates: [ADR-266](266-shim-sunset-policy-and-first-sweep.md) (shim sunset policy — this ADR owes one), [ADR-273](273-voice-fleet-triage-and-pane-input.md) (fleet triage, same feature)

## Context

The feature shipped as `atmux voice`. ADR-272 asked whether that was the right name (OQ-5) and answered it on 2026-08-14, deliberately *before* P4 landed, on the reasoning that settling it early avoided owing a shim:

> **RESOLVED 2026-08-14 (operator): `voice` stands as a top-level verb.** Asked and answered before P4 landed, so no shim is owed. Reopening this after P4 ships costs an ADR-266 shim by definition — treat it as closed.

The operator has reopened it. The feature is named **atmux vox**.

**Record the cost plainly rather than quietly re-answering the question.** OQ-5 was closed with an explicit warning about exactly this, and that warning was correct: reopening now costs a shim, a dotfiles edit, a `keys/KEYS.md` change and a redeploy that the 2026-08-14 answer was designed to avoid. Nothing about the earlier reasoning was wrong; the name simply changed, which is a legitimate thing for an operator to decide about their own tool. What would be wrong is pretending the closure never happened, or pretending the rename is free.

## Decision

### D1 — Scope: everything user-visible, plus internal module paths

**Renamed:**

| Surface | From | To |
|---|---|---|
| Verb | `atmux voice` | `atmux vox` |
| Env vars | `ATMUX_VOICE_*` | `ATMUX_VOX_*` |
| tmux session | `atmux-voice` | `atmux-vox` |
| Assets dir | `templates/voice/` | `templates/vox/` |
| Runbook | `docs/RUNBOOK-voice.md` | `docs/RUNBOOK-vox.md` |
| Module paths | `src/core/voice/`, `src/verbs/voice.ts` | `src/core/vox/`, `src/verbs/vox.ts` |
| Transcript dir | `~/.atmux/voice-logs/` | `~/.atmux/vox-logs/` |

**NOT renamed, deliberately:**

- **The hostname `atmux.geoy.ws`.** DNS, the wildcard TLS cert, the nginx vhost and the O2 artifacts all key off it, and the host name is not the feature name. Renaming it would mean a DNS change and a new vhost for zero benefit.
- **The token's VALUE.** Only the variable holding it changes. Rotating a working credential during a rename conflates two changes and makes a failure ambiguous.
- **ADR-272 and ADR-273's filenames or titles.** ADRs are append-only; they are named for what they decided when they decided it. They gain a pointer to this ADR, nothing more.

### D2 — Both old names keep working for one release, and they warn

Per [ADR-266](266-shim-sunset-policy-and-first-sweep.md):

- `atmux voice` remains a working alias for `atmux vox`, printing a deprecation line to stderr.
- `ATMUX_VOICE_*` remains readable as a **fallback** when the `ATMUX_VOX_*` equivalent is unset, also warning.

The env fallback is the load-bearing half and it is not symmetry for its own sake. `ATMUX_VOICE_TOKEN` is already committed to the operator's git-crypt'd dotfiles with a `keys/KEYS.md` pointer row, referenced by `~/.atmux/vox-launch.sh`, and exported in whatever shells are currently open. Without a fallback, the first launch after this lands fails with `ATMUX_VOX_TOKEN is required` — a confusing failure whose real cause is a rename the operator already agreed to and has no reason to connect to a missing-variable error at 2am. **A silent-to-the-cause startup failure is a worse outcome than a deprecation warning**, which is the whole argument for shims and is why ADR-266 exists.

Precedence where both are set: `ATMUX_VOX_*` wins, and the presence of the old one is warned about, because a stale value shadowing a fresh one is the failure that would waste the most time.

### D3 — Sunset is dated, not aspirational

Both shims are removed in the **release after next**, and carry `SUNSET` markers per ADR-266 §D1 naming that release. An undated shim is a permanent second code path pretending to be temporary — ADR-266 exists because this repo has had those before.

The dotfiles and `keys/KEYS.md` are updated to `ATMUX_VOX_TOKEN` in the same change that lands the fallback, so the fallback exists for *other* people's stale shells and open sessions, not as the operator's permanent configuration.

## Consequences

- One ADR-266 shim owed, on two surfaces, with a dated sunset. This is the cost OQ-5's closure was written to avoid, now knowingly paid.
- The operator's dotfiles and `keys/KEYS.md` change. The credential value does not.
- A redeploy: the launcher, the tmux session name, and the assets dir all move.
- 22 files reference `ATMUX_VOICE_*`; 20 modules live under `src/core/voice/`; 36 test files carry `voice` in their path. The mechanical churn is large but low-risk — it is rename-and-recompile, guarded by a suite that is currently 10157 green with a known-red baseline of 4.
- Docs: `docs/PRD.md` §3.7 and `docs/brd/atmux.md` gain the name; `docs/RUNBOOK-voice.md` moves.

## What this ADR does not decide

- **Whether `vox` should also cover the fleet-triage verb** (`atmux fleet`). It reads as a sibling capability rather than part of the voice surface, and nothing forces the question now.
- **The O1→O2 auth path**, unchanged by naming ([ADR-272](272-voice-operator-interface.md) §Security, and the basic-auth alternative in `docs/deploy/O2-oauth2-runbook.md`).
- **Whether `ATMUX_VOICE_READONLY` clears.** Still gated on O2 and still the operator's call; this ADR only renames the flag.
