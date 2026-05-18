# ADR-019: Discord domain separator — per-team color palette + emoji glyph

**Status**: accepted
**Date**: 2026-04-27

## Context

Today every atmux team's Discord pings land in a single shared channel as plain `content` posts via `lib/discord.sh::atmux::discord_ping`. Cross-team awareness is preserved (the driver sees everything in one channel), but visual separation is poor:

- The team name lives in backticks inside the header (e.g. `📊 **[whip-progress]** · \`atmux-kanban\` · 14:22 MYT`). Mobile-Discord renders backticks small — under load, three teams' worth of pings blur into a wall.
- The driver mentally re-parses every header to attribute the ping. With 20+ pings/hour across 2–3 teams, that overhead compounds.

Three shapes considered:

- **A (chosen)** — hash team name → fixed 16-color palette index; render as Discord webhook embed with `color` field + leading team-emoji glyph in the embed title. Plain `content` body for backwards-compat where embeds aren't desired (tests, low-quality console renderers). Optional per-team `team.json:.discord.color` hex override + `.discord.emoji` glyph override.
- **B (rejected)** — per-team webhook URL → per-team Discord channel. Full visual isolation, but defeats single-channel cross-team awareness (driver loses the "everything happening" gestalt). Also requires manual webhook provisioning per team.
- **C (rejected)** — Discord forum-channel threads (Discord-native isolation, single channel). Adds Discord-side complexity (threads have their own surfaces, mobile UX is mixed); requires forum-channel webhook variant which our `atmux::discord_ping` doesn't speak today. Bigger lift.

A hash-based palette gives deterministic per-team color without operator config: `atmux-kanban` always renders cyan, `myteam-alpha` always magenta, etc. The `team.json:.discord.color` hex override exists for the "this team's auto-color clashes" escape hatch.

## Decision

**Extend `lib/discord.sh::atmux::discord_ping` to support Discord embed shape.** Add a sibling `atmux::discord_embed_ping <body>` (or a `--embed` flag on the existing function — pick the cleaner refactor at implementation time) that:

1. Resolves team color: `team.json:.discord.color` hex (e.g. `#7287fd`) wins; otherwise hash team name (SHA-256 first byte) mod 16 → palette index → fixed Catppuccin-Frappe-aligned 16-color hex map.
2. Resolves team glyph: `team.json:.discord.emoji` (e.g. `🌊`) wins; otherwise `🤖` default.
3. Emits Discord webhook payload with `embeds[0].color` (decimal-converted hex) + `embeds[0].description` (the body), and an embed `title` prefixed with the glyph: `🌊 atmux-kanban`.
4. Existing callers (`lib/decisions.sh`, `lib/flags.sh`, `lib/whip.sh`, `lib/report.sh`) opt-in by switching their `atmux::discord_ping` calls to `atmux::discord_embed_ping`. Backward compat: plain `discord_ping` keeps current `content`-only shape for tests and low-config use.

**Schema additions to `team.json`** — both optional, both default-absent (today's behaviour preserved):

```json
{
  "discord": {
    "webhook": "https://...",
    "color": "#7287fd",     // optional hex override
    "emoji": "🌊"           // optional glyph override
  }
}
```

**16-color palette** (Catppuccin-Frappe-aligned for visual consistency with the global tooling theme): rosewater, flamingo, pink, mauve, red, maroon, peach, yellow, green, teal, sky, sapphire, blue, lavender, surface2, overlay2. Locked in `lib/discord.sh` as a const array.

## Consequences

- **`lib/discord.sh` gains ~40 LOC** for embed payload assembly + palette table + hash resolution.
- **Existing 4 caller files switch ~1 line each** to use the embed sender (decisions, flags, whip, report — tracked as separate bullets in the BE Task body).
- **`templates/team.example.json` documents the new optional fields.**
- **Backward-compat preserved** — teams without the new fields auto-color via hash; behaviour deterministic.
- **Test-mode**: embed mode is skipped when `ATMUX_DISCORD_PLAINTEXT=1` is set (test fixtures + future CI assertions can avoid embed-shape coupling).
- **Trade-off accepted**: 16-color palette is fixed at decompose time. Adding more colors is a one-line array extension; reducing requires migration awareness (existing teams' hash-derived index might shift). Document this in the README.

## Open questions

1. **OQ A1: hash function?** Resolved: SHA-256 first byte mod 16. Stable across systems (`sha256sum` ubiquitous; `shasum -a 256` macOS fallback). (low-rev — palette index is presentation-only.)
2. **OQ A2: topology — hash+embed vs per-team-webhook vs forum-thread?** Resolved: hash+embed. Single channel preserves cross-team gestalt; zero new infra. (medium-rev — driver flagged alternatives as evaluable; cheap to switch later if hash+embed proves insufficient.)
3. **OQ A3: per-team color/emoji override fields?** Resolved: yes, both optional in `team.json:.discord.{color,emoji}`. (low-rev.)

All resolutions logged to `.atmux/decisions.md`.

---

**Annotation 2026-05-18 — palette brand rename (label-only, no value change)**

The 16-color palette in `lib/discord.sh` was originally sourced from Catppuccin Frappe (per §1 and §"16-color palette" above). The hex values remain unchanged; the operator's working theme has moved off Catppuccin to a tokyonight-night / opencode-dark-vibes aesthetic. Names like `mauve`, `rosewater`, etc. in the palette array are historical labels from the source theme, not load-bearing identifiers — they're stable hex anchors used for hash→color routing and are documented here for reviewer traceability only. Any future palette revision should reference this annotation.
