# ADR-008: `atmux decisions` verb — first-class decision log + Discord ping

**Status**: accepted
**Date**: 2026-04-25

## Context

Per global CLAUDE.md, the lead is supposed to make recommended decisions autonomously and surface them to driver via `pending-decisions.md` under "🟡 Auto-mode resolutions" with **"override by replying — cheap now, expensive once merged"** framing. The driver wants those resolutions ALSO pinged to Discord so they can override on phone without attaching to tmux.

Today the lead/planner does this with a hand-rolled `bash + ping-discord.sh` dance — error-prone, easy to skip, and not visible to other team members. The new pull-based kanban model (ADR-007) amplifies this need: with workers pulling from the kanban, the lead's explicit decisions on ambiguous Stories/Tasks become the **only synchronous signal the driver gets**. Discord is the right channel — async, mobile, already wired (`lib/discord.sh`, `report.sh`, `whip.sh`).

This ADR captures the design + driver-resolved open questions. Folded into the in-flight pull-kanban Epic as Story S10 (NOT a separate Epic).

## Decision

### New verb suite

```
atmux decisions add <question> --default <answer> [--reversibility low|medium|high] [--note <txt>]
atmux decisions list [--since <when>] [--reversibility <level>]
atmux decisions show <id>
```

`add` writes to `.atmux/decisions.md` AND immediately pings Discord with the `[atmux-decisions]` template (per global CLAUDE.md Discord format spec).

### State file

`.atmux/decisions.md` — team-scoped, per-team. Append-only log. One entry per decision with: id, timestamp (MYT), question, recommended default, reversibility, optional note, optional override deadline. Markdown for human-readability + git-diffability (consistent with kanban.json's choice in ADR-007).

### Discord template

Per global CLAUDE.md format (header + bulleted body + per-bullet emoji, ≤80 chars/bullet):

```
📋 **[atmux-decisions]** · `{team}` · HH:MM MYT

🔵 <question — ≤80 chars>
✅ default: <answer — ≤80 chars>
🟢/🟡/🔴 reversibility: low|medium|high
📍 atmux decisions show <id> · override: atmux send lead "override <id>: <new>"
```

Send code reuses `lib/discord.sh::atmux::discord_ping` — no reinvented `curl`. Webhook resolution unchanged: `team.discord.webhook` → `ATMUX_DISCORD_WEBHOOK` env → silent no-op if unset (preserves no-webhook flow).

### Whip integration

When `whip` detects new decision entries since last tick (mtime on `.atmux/decisions.md` + cursor file `.atmux/state/decisions-cursor`), include a one-liner pointer in the whip Discord ping:

```
📋 N new decisions — atmux decisions list
```

Whip does NOT duplicate decision bodies. Whip flags; the decisions verb announces.

### Brief integration

- **lead.md brief**: lead calls `atmux decisions add` for every auto-resolution instead of free-form pending-decisions.md edits.
- **planner.md brief**: planner calls `atmux decisions add` for every resolved open question during Epic decomposition.
- These changes are baked into the existing S6 brief rewrites (T6.1 lead.md + T6.2 planner.md). A separate S10 follow-up Task (T10.4) adds the verb-usage section to BOTH briefs after the S6 rewrites land — single commit, no concurrency conflict with S6.

## Resolutions to driver-flagged open questions

The driver pre-resolved these in the addendum entry:

1. **`.atmux/decisions.md` vs reuse global `pending-decisions.md`?** → **NEW `.atmux/decisions.md`**. Team-scoped state belongs under `.atmux/`. `pending-decisions.md` is a project-level driver-facing doc per global CLAUDE.md; atmux's per-team log is a different concern. Symlink or include-by-reference if a project wants both visible.

2. **Per-add ping vs batch-on-whip?** → **IMMEDIATE per-add ping**. Decisions are low-volume and time-sensitive — driver wants the override window NOW, not in 5min. Whip adds the "N new since last tick" pointer for missed pings; it does not replace immediate sends.

3. **`--severity` P0/P1/P2 flag?** → **NO for MVP**. `--reversibility` already captures the "do I need to override fast?" signal. Add severity in a follow-up Epic if friction emerges.

## Dogfood / meta-test

Once T10.1 ships (the verb is callable), planner uses `atmux decisions add` to record THESE THREE resolutions as the verb's first three real entries. This eats its own dogfood + provides a real Discord-render smoke test of the template before Epic verification §2 runs.

## Consequences

### What we gain

- **Autonomy with override visibility.** Lead/planner make the call; driver sees it within seconds on Discord.
- **Audit trail.** `.atmux/decisions.md` is committed alongside the Epic; future readers see what was decided and when.
- **Standardised template.** No more freelance ping formatting — one template, one verb.
- **Reused Discord plumbing.** No new webhook / curl / retry logic. Failure modes inherited from `lib/discord.sh`.

### What we give up

- **One more lib file** to maintain (`lib/decisions.sh`).
- **One more whip-tick check** (`mtime` + cursor read on `.atmux/decisions.md`). Cost: <1ms per tick.
- **Discord noise risk** if a planner spams `decisions add` for trivial calls. Mitigation: brief explicitly says "use ONLY for genuine recommended-default applications, not free-form notes — that's what `--note` on `task add` is for."

### Alternatives considered

- **Reuse global `pending-decisions.md`** — Rejected per OQ1: scope mismatch, cross-project pollution.
- **Batch-on-whip Discord pings** — Rejected per OQ2: defeats the time-sensitive override window.
- **Generalise into `atmux ping <template> <args>`** — Considered. Rejected: premature abstraction. Each template has different fields (decisions vs progress vs blocker); flat-verb sub-templates are clearer than a meta-verb. Revisit if 3+ similar templates emerge.

## Scope boundary

S10 ships ONLY the verb + state file + Discord wiring + whip pointer + brief supplement + tests. **Out of scope** for this Epic (defer to follow-ups):

- Override-via-Discord-reply integration (driver replies in Discord thread → atmux picks up the override). Today: driver still types `atmux send lead "override ..."` on phone or laptop.
- Decision expiry / auto-archive (>7 days old → move to `.atmux/decisions-archive.md`).
- `--severity` (per OQ3 deferral).
- Aggregation in `atmux epic show` (show resolved decisions per Epic).

These can be a follow-up Epic; not blocking ship.
