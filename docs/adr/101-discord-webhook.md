# ADR-101: Discord webhook + chunking + named-template enforcement

**Status:** accepted
**Date:** 2026-05-04
**Owner:** architect (drafted to gate Phase 0 exit; foundation porter implements)

## Context

atmux posts to Discord from three primary cron-fired verbs (`whip`, `report`, decisions-digest) plus on-demand from `tell-lead`, `dispatch`, and lifecycle events (`team-bootstrap`, `deploy`). CLAUDE.md global conventions specify a tight format:

> **Discord message format — header + bulleted body + per-bullet emoji**:
> - Header: `<emoji> **[category]** · \`{team}\` · HH:MM MYT`
> - Blank line, then bulleted body — no prose walls. Every fact is its own bullet, every bullet starts with a status emoji, ≤80 chars per bullet.
> - Section labels in bold (`🏗️ **Shipped**`, `📨 **Dispatched**`, etc.), content under them is bullets, not more prose.
> - Code-format (backticks) for member names, SHAs, file paths, task IDs, URLs.
> - **Banned**: unprefixed `[whip]` ad-hoc catch-all, single-paragraph status walls, run-on sentences. Every send is a *named template* — no unnamed prose dumps.
> - All whip + whip-watchdog + team skill sends route through `~/.claude/skills/whip/scripts/ping-discord.sh` (thin webhook passthrough).

Bash atmux complies via convention + a single shared `lib/discord.sh` helper. The TS port hardens compliance into types: a Discord send that doesn't carry a named template is a compile error.

The other concerns:
- Discord enforces a 2000-char-per-message limit. atmux's progress digests routinely exceed it.
- Webhook URL is a secret (env var `ATMUX_DISCORD_WEBHOOK`). Routing through `ping-discord.sh` keeps secret handling in one place; the TS abstraction defers to the script.

## Decision

### One-method API — `discord.send(opts)`

```ts
// src/abstractions/discord.ts
import { DiscordWebhookError } from "../errors";
import { formatMyt } from "./time";

export type DiscordTemplate =
  | "whip-progress"
  | "whip-blocker"
  | "whip-heartbeat"
  | "whip-decisions"
  | "whip-overdue"
  | "whip-budget"
  | "report-digest"
  | "team-bootstrap"
  | "team-shipped"
  | "team-rotation"
  | "dispatch-task"
  | "tell-lead"
  | "deploy-lifecycle";

export type CategoryEmoji =
  | "🚨"   // critical / P0
  | "🛑"   // blocked
  | "⏰"   // overdue
  | "📋"   // decisions
  | "📊"   // progress digest
  | "💓"   // heartbeat
  | "🚀"   // lifecycle (bootstrap / deploy)
  | "📍"   // context pointer
  | "🛠️";  // fix / repair

export interface DiscordSection {
  label: string;             // bold-rendered, e.g. "🏗️ Shipped"
  bullets: string[];         // each ≤80 chars; emoji prefix MANDATORY (validated)
}

export interface DiscordSendOpts {
  template: DiscordTemplate;          // discriminator — required, no default
  team: string;                       // rendered as code-formatted in header
  category: CategoryEmoji;            // header emoji
  bullets?: string[];                 // optional flat bullet list (non-sectioned)
  sections?: DiscordSection[];        // optional sectioned body
  // Either bullets OR sections (or both) — enforced at runtime
  webhookOverride?: string;           // defaults to ATMUX_DISCORD_WEBHOOK env
  whenMs?: number;                    // override timestamp (test injection); default = time.now()
}

export async function send(opts: DiscordSendOpts): Promise<void>;
```

The caller passes structured data; the abstraction renders the canonical format. Domain code never builds the string itself.

### Renderer

```ts
// Pseudo-implementation
function render(opts: DiscordSendOpts, time: { hhmm: string }): string[] {
  validateBullets(opts);
  const header = `${opts.category} **[${opts.template}]** · \`${opts.team}\` · ${time.hhmm}`;
  const body: string[] = [header, ""];
  if (opts.bullets) body.push(...opts.bullets);
  if (opts.sections) {
    for (const sec of opts.sections) {
      if (body.length > 2) body.push("");
      body.push(`**${sec.label}**`);
      body.push(...sec.bullets);
    }
  }
  return chunk(body.join("\n"), 2000);
}
```

`time.hhmm` is `formatMyt(opts.whenMs ?? time.now())` per ADR-105.

### Validation (runtime — throws `DiscordWebhookError` with tag-equivalent context)

- Bullet length ≤80 chars (CLAUDE.md rule). Violation → throw at send time with `{ template, bulletIndex, length }` context.
- Each bullet must start with a per-bullet emoji from CLAUDE.md's allowed set (`✅`/`🧪`/`🛠️`/`➡️`/`♻️`/`🟢🟡🔴`/`🔐`/`🎨`/`📦`/`🙏`/`📍`/`📊`). Validated by regex against the first grapheme cluster.
- At least one of `bullets` or `sections` non-empty. Empty body → throw.

The validation is intentionally strict — CLAUDE.md describes this as a discipline, not a suggestion. Early failure beats Discord seeing an unprefixed wall of prose.

### Chunking — split on bullet boundaries

```ts
function chunk(body: string, maxBytes: number): string[] {
  // Split body on bullet boundaries (lines starting with `-` or `**`).
  // Pack greedy; never split a bullet across messages; never split a section
  // header (the `**Label**` line) from its first bullet.
  // Add `(N/M)` suffix to header on every message after the first.
}
```

Properties:
- Multi-message renders share an identical leading header except for `(N/M)` suffix.
- Section labels stay paired with their first bullet.
- Bullets never split mid-line.
- If a single bullet > maxBytes (rare but possible for code blocks), it's emitted as its own message; chunker logs a warning to stderr.

### Routing — bun-native `fetch` against the resolved webhook URL

```ts
// src/abstractions/discord.ts (continued)

async function postChunk(chunk: string, webhookOverride: string | undefined): Promise<void> {
  const url = webhookOverride && webhookOverride !== ""
    ? webhookOverride
    : process.env.ATMUX_DISCORD_WEBHOOK;
  if (!url) throw new ConfigError({ what: "no Discord webhook resolved" });
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: chunk }),
  });
  if (!resp.ok) throw new DiscordWebhookError({ statusCode: resp.status, ... });
}
```

The webhook URL resolves from `webhookOverride` > `ATMUX_DISCORD_WEBHOOK` env > `team.discord.webhook` (via `resolveWebhookUrl`) > XDG file. The webhook value is held in process env / config and posted directly — no external script.

### Update — 2026-05-07: spawn route dropped

Earlier revisions of this ADR routed every chunk through `~/.claude/skills/whip/scripts/ping-discord.sh` via `spawn()`, with a direct-fetch fallback when the script was absent. CLAUDE.md still describes the bash-side convention ("All whip + whip-watchdog + team skill sends route through ping-discord.sh") for the bash atmux deployment, but the TS port has dropped the spawn route entirely:

- The script was never installed at the expected path on the bun deploy. Every cron tick of `whip` and `report` logged `discord: ping-discord.sh not found, using direct fetch (set ATMUX_DISCORD_PING_SCRIPT to silence)`.
- The "fallback" was always the canonical path. Discord posts have been landing via direct `fetch` since the abstraction shipped.
- Maintaining a spawn-then-fallback router added two test surfaces, a once-per-process warning flag (`_fallbackWarned`), a `ATMUX_DISCORD_PING_SCRIPT` env knob, and a stderr noise source — all for a code path that wasn't doing useful work.

The `ATMUX_DISCORD_PING_SCRIPT` env var is no longer honoured (setting it has no effect; ignored silently for backward compatibility). The `_resetFallbackWarnedForTest` test hook was removed. `directFetch` is now invoked directly from `send()`.

The bash atmux side is unaffected — its `lib/discord.sh` continues to delegate to `ping-discord.sh` as before.

### Test interception

Parity tests need to capture every Discord send without actually posting. The abstraction respects `ATMUX_DISCORD_RECORDER`:

```ts
const RECORDER = process.env.ATMUX_DISCORD_RECORDER;     // path to a recorder file
if (RECORDER) {
  await fs.appendFile(RECORDER, JSON.stringify({ template, team, category, body }) + "\n");
  return;                                                // no real send
}
```

Parity harness sets `ATMUX_DISCORD_RECORDER` to a fresh tempfile per run, then diffs the JSON-lines from bash side vs TS side. Bash atmux's discord helper has the equivalent env support added in a same-commit follow-up (porter-B's task).

### Forbidden patterns (reviewer rules)

- **R8.** No raw `fetch("https://discord.com/api/webhooks/…")` outside `src/abstractions/discord.ts`. Custom lint regex.
- **R9.** No string-concat of Discord output outside `discord.ts`. Verbs build `bullets: string[]` and `sections: DiscordSection[]`, never raw markdown.
- **R10.** Every `discord.send(...)` call site must pass a `template` from the literal-union type. TypeScript enforces compile-time; no `as DiscordTemplate` casts.

R10 is the central type guarantee. CLAUDE.md "Banned: unprefixed `[whip]` ad-hoc catch-all" becomes a compile error rather than a code-review note.

## Consequences

**Positives:**

- Domain code never builds Discord strings. ADR-099 R8/R9/R10 + the literal-union template type make CLAUDE.md format compliance compile-time-enforced.
- Bullet-length and emoji-prefix validation catches mistakes at send time, in tests, before they hit live channels.
- Webhook URL stays in operator's env; TS abstraction never sees it (when the ping script is in use). One canonical secret-handling path for both bash and TS.
- Chunking handles 2000-char limit consistently across templates; multi-message digests get `(N/M)` suffix.
- Test interception via env recorder enables parity-harness Discord diffing without real network IO.

**Negatives:**

- Adding a new named template requires editing `src/abstractions/discord.ts` (the union type). This is intentional friction — CLAUDE.md "every send is a named template" wants the discipline at the type level. Reviewer can grant a per-template ADR for substantial new categories.
- ~~Ping-script-vs-fetch-fallback creates two code paths to test. Foundation porter writes both unit tests.~~ (Obsolete as of 2026-05-07: spawn route removed, single bun-native `fetch` path remains.)
- Bullet-prefix emoji validation depends on Unicode grapheme cluster handling; foundation porter must use a TS-native grapheme regex (`\p{Emoji}\p{Emoji_Modifier}*` is approximate; `Intl.Segmenter` with `granularity: 'grapheme'` is precise).
- 80-char bullet limit assumes characters not bytes — multi-byte Unicode bullets (e.g. emoji) consume multiple code units. Foundation porter clarifies in implementation: "80 grapheme clusters" not "80 chars" per CLAUDE.md spirit.
- If the ping script signature changes upstream (whip skill bumps), atmux's spawn args may need to change. Loose coupling via stdin + env minimizes the surface.

**Follow-up tickets:**

- Foundation porter (Phase 1) implements `src/abstractions/discord.ts` + tests as part of Phase 1.
- Foundation porter writes `tests/helpers/discordRecorder.ts` for parity-harness consumption.
- Porter-B (Phase 2) extends bash `lib/discord.sh` to support `ATMUX_DISCORD_RECORDER` so parity harness records both sides identically.
- ADR-102 (test strategy) consumes the recorder shape for parity diffing.
- New-template ADRs land as 015+ when added.

## Alternatives considered

### A. Free-form `discord.send(rawMarkdown: string)`

Rejected. Reproduces the bash situation: every caller hand-builds the format. CLAUDE.md compliance becomes a code-review concern instead of a type-system concern. The whole point of typing the API is to make compliance mechanical.

### B. Builder pattern — `discord.message().header(...).section(...).bullet(...).send()`

Considered. Fluent and readable. Rejected because:
- The `send(opts)` shape is just as readable in the call site (verb code) and easier to mock in tests.
- Builder requires more abstraction layer LOC for no behavioural difference.
- Bun's auto-formatting doesn't render fluent builders well; opts object is denser.

### C. Direct `fetch` only, no script routing

Originally rejected on the grounds that CLAUDE.md "All whip + whip-watchdog + team skill sends route through `~/.claude/skills/whip/scripts/ping-discord.sh`" was explicit and direct fetch should be a test-and-fallback path only.

**Re-accepted 2026-05-07** (see "Update" note above): in practice, the script was never installed on this deploy and direct `fetch` was already serving every send. The spawn-route + fallback architecture was paying type/test/warning costs for a code path that never executed. CLAUDE.md's routing rule still governs the bash atmux deployment; the TS port treats `ATMUX_DISCORD_WEBHOOK` (env / team / XDG) as the canonical webhook source.

### D. Embed Discord SDK (`discord.js`)

Rejected. We post webhooks; we don't need a full bot SDK. `discord.js` is ~megabytes; webhook post is one HTTP call. Massive overkill.

### E. Pre-render templates to static strings at compile time

Considered. Templates with mostly-static content could be cached. Rejected because every send has dynamic data (team name, time, bullets). Caching the format-skeleton saves nothing meaningful.

### F. Allow `template: string` (open) instead of literal-union

Rejected. Open string defeats the central guarantee — that every send carries a named template. Closed union forces every new template to make a deliberate addition (and consequently document its purpose).

## References

- CLAUDE.md global conventions §"Discord message format" — the spec this ADR implements
- PLAN.md §10 (logger note — discord renders shape-sensitively, preserve `{verb} {team} {member}`)
- ADR-095 (motivation)
- ADR-096 (module taxonomy — `discord.ts` is one of 8 abstractions)
- ADR-099 (error handling — `DiscordWebhookError`)
- ADR-100 (spawn pattern — `discord.ts` shells out via `spawn`)
- ADR-102 (test strategy — recorder consumed for parity diffing)
- ADR-105 (time + timezone — `formatMyt` for header timestamp)
- `~/.claude/skills/whip/scripts/ping-discord.sh` — operator-installed webhook passthrough (canonical send route)
