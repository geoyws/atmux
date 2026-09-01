# Architecture Decision Records

Short, durable notes on architectural decisions made in atmux — the what, why, and what it costs us.

Format inspired by Michael Nygard's ADR template, kept deliberately short.

## Index

- [ADR-001: Separate planner role from team-lead](001-planner-role.md)
- [ADR-002: Wizard preset modes (perf / default / eco / custom)](002-preset-modes.md)
- [ADR-003: Per-member emoji auto-assignment (static / random / ai)](003-emoji-modes.md)
- [ADR-004: Ephemeral feature specialists via `add-member`](004-ephemeral-specialists.md)
- [ADR-005: `atmux doctor` + silent start preflight](005-doctor-preflight.md)
- [ADR-006: Bare `atmux` as one-stop bring-up](006-bare-atmux.md)

Index above is illustrative — `ls docs/adr/` enumerates the full set (001 through 130 + the 087-092 team-of-teams reservation).

## Historical context — bun port era (2026-04 → 2026-05)

ADRs 095-130 (formerly `docs/adr-bun` 001-032 + 060/062/064/068) were authored during the bash → TypeScript-on-Bun rewrite. They covered runtime choice ([ADR-095](095-why-typescript-on-bun.md)), project layout ([ADR-130](130-project-layout.md)), module taxonomy ([ADR-096](096-module-taxonomy.md)), tmux/JSON/error/spawn/Discord/test/CLI primitives, cutover protocol ([ADR-104](104-cutover-protocol.md)), and per-lane parity matrix work ([ADRs 119-125](119-parity-matrix-iter-1-scope.md)). They lived in a separate `docs/adr-bun` tree during the port to keep numbering independent of the main tree — that split was consolidated into a single tree on 2026-05-13 per [ADR-093](093-adr-bun-to-adr-consolidation.md). All bun-port ADRs preserve their original slugs verbatim; `git log --follow` walks through the rename for each.
