# ADR-003: Per-member emoji auto-assignment

**Status**: accepted
**Date**: 2026-04-25

## Context

Members in a running atmux team blur together — especially in `atmux status` and tmux window lists. Role emojis (🧭 🔍 🌿) help but collide when you have multiple workers in the same role (the default case). Operators needed a visual hook to tell `fe-auth` from `be-auth` at a glance.

## Decision

Every member carries an optional `.emoji` field in `team.json`, stamped once at wizard / `add-member` time. Three modes, configurable via `team.emojis.mode` or the `ATMUX_EMOJI_MODE` env override:

- **`static`** — canonical per-role emoji. Deterministic. Everyone with role=member gets 🐝.
- **`random`** (default) — random pick from a curated pool per role. Avoids duplicates within a team for variety.
- **`ai`** — shells out to `claude -p` per member, asking for a single emoji that suits the name + role. Falls back to `random` on any failure (missing claude, rate limit, non-emoji response).

Emojis appear in tmux window names (`__<team>__<emoji><member>` when stamped), `atmux status`, and via `atmux::member_emoji` / `atmux::member_display` helpers for future surfaces.

## Consequences

### What we gain
- Visual identity per member, not just per role.
- Works offline by default (`random` is the default, not `ai`).
- Stamped once, stable thereafter — rotation / restart doesn't reroll.

### What we give up
- tmux window names can now contain non-ASCII characters. Every tmux + terminal we target (iTerm, Ghostty, kitty, Alacritty, tmux 3.x) handles this correctly, but it's one more surface that could surprise obscure configs.
- `ai` mode adds per-member claude calls to wizard time (~3–5s each). Opt-in only, not default.

### Alternatives considered
- **Inline emoji in member `name`.** Rejected — names are identifiers used in file paths (`.atmux/inboxes/<name>.json`), kanban assignees, dispatch targets. Embedding emoji would break a lot and make grep/match fragile.
- **Role-only emojis (no per-member variance).** Rejected — the original problem is distinguishing workers within the same role.
