# ADR-002: Wizard preset modes (perf / default / eco / custom)

**Status**: accepted
**Date**: 2026-04-25

## Context

The wizard asked the user to pick a TUI for every worker individually. For a 3-worker team that's three prompts, plus custom launch commands for each TUI family. New users hit decision fatigue before they finished onboarding.

Three well-known tradeoffs dominate real atmux teams:

- **Capability over cost** — running everything on Claude for production work.
- **Balanced** — Claude staff (where reasoning matters) + cheap workers (where parallel throughput matters).
- **Cost over capability** — everything on MiniMax/opencode for throwaway branches.

These are coherent archetypes, not a continuum.

## Decision

Add a preset prompt at the top of the wizard with four tokens:

| Preset    | Staff TUI | Worker TUIs                                      |
|-----------|-----------|--------------------------------------------------|
| `perf`    | claude    | all claude                                       |
| `default` | claude    | cycles cursor → opencode → kimi across workers   |
| `eco`     | opencode  | all opencode (MiniMax default model)             |
| `custom`  | claude    | prompted individually                            |

Preset pre-fills TUI choices but doesn't skip any other prompt — the user still names every worker, picks emoji mode, decides which staff roles to include. Default is `default`.

Naming: we landed on `perf` / `default` / `eco` / `custom` after `premium` / `standard` / `economy` / `custom` — shorter tokens type faster, same semantics.

## Consequences

### What we gain
- First-run wizard goes from ~15 prompts to ~8 for the common case.
- Intent is declared once at the top rather than inferred from a string of individual picks.
- Preset tokens are short enough to pass via env (`ATMUX_PRESET=perf`) for scripted init — future extension.

### What we give up
- One more prompt for users who would have happily clicked through the old per-worker flow.
- Preset names leak a perspective (Claude is "perf", MiniMax is "eco"). If a cheaper model ever matches Claude for coordination, these tokens age.

### Alternatives considered
- **No preset, smarter defaults.** Rejected — doesn't help users who want all-Claude or all-MiniMax; they'd still override every prompt.
- **Preset skips subsequent prompts entirely.** Rejected — removes user consent from team shape (staff includes, worker count, emoji mode). Too opaque.
