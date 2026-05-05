// ADR-008: Discord webhook + chunking + named-template enforcement.
//
// Domain code never builds Discord output strings (R9 per ADR-008). Callers
// pass a structured `DiscordSendOpts` (template + category + bullets/sections);
// this module:
//   - Validates bullets (≤80 grapheme clusters, allowed emoji prefix)
//   - Renders the canonical CLAUDE.md format (header + bulleted body)
//   - Chunks at 2000 bytes (Discord webhook hard limit) — section labels
//     stay glued to their first bullet (no orphaned `**Label**` at chunk
//     tails), bullets never split mid-line.
//   - Routes through `~/.claude/skills/whip/scripts/ping-discord.sh` via
//     spawn() (per CLAUDE.md "all whip + whip-watchdog + team skill sends
//     route through ping-discord.sh"), with a direct-fetch fallback for
//     environments without the whip skill installed.
//   - Honours `ATMUX_DISCORD_RECORDER` for parity-harness JSONL capture
//     (per ADR-009 §3 + tests/parity/intercept-discord.ts).
//
// `template: DiscordTemplate` is a literal-union type, so the central
// "every send is a named template" guarantee (R10) is compile-time
// enforced. Runtime validation covers bullet shape only.

import { appendFile } from "node:fs/promises";
import { ConfigError, DiscordWebhookError } from "../errors.ts";
import { readTextOrNull } from "./fs.ts";
import { spawn } from "./spawn.ts";
import { formatMyt, now, nowIso } from "./time.ts";

// ---------- Public types ----------

/** The closed set of named templates. Every Discord send must pick one
 *  (R10 per ADR-008). Adding a template requires editing this union — the
 *  intentional friction CLAUDE.md asks for. */
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
  | "deploy-lifecycle"
  // I-6 per ADR-022 + PLAN.md §6.3: surfaced when the lead applies a
  // recommended default without escalation. V-25 ships the template;
  // invocation site is the lead's tell-discord-shaped flow, deferred to
  // V-27 `team` per ADR-021. Adding the literal here costs nothing and
  // unblocks the V-27 caller from a same-commit discord.ts edit.
  | "autonomous-decision";

/** Header category emojis per CLAUDE.md global conventions. */
export type CategoryEmoji = "🚨" | "🛑" | "⏰" | "📋" | "📊" | "💓" | "🚀" | "📍" | "🛠️";

export interface DiscordSection {
  /** Bold-rendered section label, e.g. "🏗️ Shipped". */
  label: string;
  /** Bullets in this section. Each ≤80 graphemes, must start with an allowed emoji. */
  bullets: ReadonlyArray<string>;
}

export interface DiscordSendOpts {
  /** Named template — the central guarantee (R10). Literal union. */
  template: DiscordTemplate;
  /** Code-formatted in header. */
  team: string;
  /** Header emoji. Literal union. */
  category: CategoryEmoji;
  /** Optional flat bullet list (non-sectioned body). */
  bullets?: ReadonlyArray<string>;
  /** Optional sectioned body. */
  sections?: ReadonlyArray<DiscordSection>;
  /** Override the resolved webhook URL (test injection). */
  webhookOverride?: string;
  /** Override the timestamp (test injection); defaults to time.now(). */
  whenMs?: number;
}

// ---------- Validation ----------

/** Per-bullet emoji prefix allowlist per CLAUDE.md global conventions. */
const ALLOWED_BULLET_PREFIX = new Set<string>([
  "✅",
  "🧪",
  "🛠️",
  "➡️",
  "♻️",
  "🟢",
  "🟡",
  "🔴",
  "🔐",
  "🎨",
  "📦",
  "🙏",
  "📍",
  "📊",
]);

const GRAPHEME_SEG = new Intl.Segmenter("en", { granularity: "grapheme" });

/** CLAUDE.md "≤80 chars per bullet" — measured in grapheme clusters
 *  (multi-byte emojis count as one). */
const MAX_BULLET_GRAPHEMES = 80;

/** Discord webhook hard limit per message. Chunker packs to fit. */
const MAX_CHUNK_BYTES = 2000;

function graphemes(s: string): string[] {
  const out: string[] = [];
  for (const seg of GRAPHEME_SEG.segment(s)) out.push(seg.segment);
  return out;
}

function validateOpts(opts: DiscordSendOpts): void {
  const flat = opts.bullets ?? [];
  const sections = opts.sections ?? [];
  const total = flat.length + sections.reduce((a, s) => a + s.bullets.length, 0);
  if (total === 0) {
    throw new DiscordWebhookError({
      template: opts.template,
      detail: "empty body — at least one bullet or section bullet required",
    });
  }
  for (let i = 0; i < flat.length; i++) {
    validateBullet(opts.template, flat[i] ?? "", `bullets[${i}]`);
  }
  for (let s = 0; s < sections.length; s++) {
    const sec = sections[s];
    if (!sec) continue;
    for (let i = 0; i < sec.bullets.length; i++) {
      validateBullet(opts.template, sec.bullets[i] ?? "", `sections[${s}].bullets[${i}]`);
    }
  }
}

function validateBullet(template: DiscordTemplate, bullet: string, where: string): void {
  const gs = graphemes(bullet);
  if (gs.length === 0) {
    throw new DiscordWebhookError({
      template,
      detail: `${where} is empty`,
    });
  }
  if (gs.length > MAX_BULLET_GRAPHEMES) {
    throw new DiscordWebhookError({
      template,
      detail: `${where} too long: ${gs.length} graphemes (max ${MAX_BULLET_GRAPHEMES})`,
    });
  }
  const first = gs[0] ?? "";
  if (!ALLOWED_BULLET_PREFIX.has(first)) {
    throw new DiscordWebhookError({
      template,
      detail: `${where} missing allowed emoji prefix: got "${first}"`,
    });
  }
}

// ---------- Render ----------

function renderHeader(opts: DiscordSendOpts, time: string): string {
  return `${opts.category} **[${opts.template}]** · \`${opts.team}\` · ${time}`;
}

function renderBody(opts: DiscordSendOpts): string[] {
  const lines: string[] = [];
  const flat = opts.bullets ?? [];
  const sections = opts.sections ?? [];
  if (flat.length > 0) lines.push(...flat);
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    if (!sec) continue;
    if (lines.length > 0) lines.push(""); // blank between body blocks
    lines.push(`**${sec.label}**`);
    lines.push(...sec.bullets);
  }
  return lines;
}

// ---------- Chunk ----------

function byteLen(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

interface AtomicBlock {
  /** 1 line for normal bullets / blank lines; 2 lines for [section-label,
   *  first-bullet] pairs that must not split across chunks. */
  lines: string[];
  bytes: number;
}

/** Glue `**Label**` lines to their next line so they never split. */
function makeBlocks(lines: ReadonlyArray<string>): AtomicBlock[] {
  const blocks: AtomicBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("**") && line.endsWith("**") && i + 1 < lines.length) {
      const next = lines[i + 1] ?? "";
      blocks.push({
        lines: [line, next],
        bytes: byteLen(line) + 1 + byteLen(next) + 1,
      });
      i += 2;
    } else {
      blocks.push({ lines: [line], bytes: byteLen(line) + 1 });
      i += 1;
    }
  }
  return blocks;
}

/**
 * Pack the rendered body into chunks ≤ `MAX_CHUNK_BYTES`. Each chunk
 * carries its own header line; multi-chunk renders get `(N/M)` suffix.
 */
function chunkBody(header: string, body: ReadonlyArray<string>): string[] {
  // Per-chunk header overhead: header line + blank line + worst-case
  // " (NN/NN)" suffix (~10 bytes pad).
  const headerBudget = byteLen(header) + 2 + 10;
  const blocks = makeBlocks(body);
  // Body is always non-empty here — `validateOpts` upstream rejects
  // any send with zero bullets across both `bullets` and `sections`.

  const groups: AtomicBlock[][] = [];
  let group: AtomicBlock[] = [];
  let groupBytes = 0;
  for (const block of blocks) {
    if (group.length > 0 && groupBytes + block.bytes + headerBudget > MAX_CHUNK_BYTES) {
      groups.push(group);
      group = [];
      groupBytes = 0;
    }
    group.push(block);
    groupBytes += block.bytes;
  }
  if (group.length > 0) groups.push(group);

  const total = groups.length;
  return groups.map((g, idx) => {
    const headerWithSuffix = total > 1 ? `${header} (${idx + 1}/${total})` : header;
    const lines: string[] = [headerWithSuffix, ""];
    for (const b of g) lines.push(...b.lines);
    return lines.join("\n");
  });
}

// ---------- Send ----------

/** Once-per-process flag for the "ping-discord.sh not found" stderr warning.
 *  Reset via `_resetFallbackWarnedForTest()` in unit tests. */
let _fallbackWarned = false;

/**
 * Send a Discord message per ADR-008.
 *
 * @throws DiscordWebhookError on validation failure, spawn failure, fallback
 *         network failure, or fallback non-2xx response.
 * @throws ConfigError if `ATMUX_DISCORD_PING_SCRIPT` is set but the script
 *         doesn't exist, or if no webhook is resolvable for the fallback path.
 */
export async function send(opts: DiscordSendOpts): Promise<void> {
  validateOpts(opts);
  const ts = opts.whenMs ?? now();
  const header = renderHeader(opts, formatMyt(ts));
  const chunks = chunkBody(header, renderBody(opts));

  // Test interception path (ADR-009 §3): record JSONL `{ts, payload}` per
  // chunk and skip the real send.
  const recorder = process.env.ATMUX_DISCORD_RECORDER;
  if (recorder !== undefined && recorder !== "") {
    for (const c of chunks) {
      const line = `${JSON.stringify({ ts: nowIso(ts), payload: { content: c } })}\n`;
      await appendFile(recorder, line);
    }
    return;
  }

  for (const c of chunks) {
    await postChunk(c, opts.template, opts.webhookOverride);
  }
}

async function postChunk(
  chunk: string,
  template: DiscordTemplate,
  webhookOverride: string | undefined,
): Promise<void> {
  const explicitScript = process.env.ATMUX_DISCORD_PING_SCRIPT;
  const home = process.env.HOME ?? "";
  const defaultScript = `${home}/.claude/skills/whip/scripts/ping-discord.sh`;
  const script = explicitScript && explicitScript !== "" ? explicitScript : defaultScript;
  const exists = await Bun.file(script).exists();

  if (exists) {
    try {
      const spawnOpts: Parameters<typeof spawn>[0] = {
        cmd: script,
        argv: [],
        stdin: chunk,
        timeoutMs: 10_000,
        expectExitCode: 0,
      };
      if (webhookOverride !== undefined && webhookOverride !== "") {
        spawnOpts.env = { ATMUX_DISCORD_WEBHOOK: webhookOverride };
      }
      await spawn(spawnOpts);
      return;
    } catch (e) {
      throw new DiscordWebhookError({
        template,
        detail: "ping-discord.sh delegation failed",
        cause: e,
      });
    }
  }

  if (explicitScript !== undefined && explicitScript !== "") {
    // Operator pinned a script that doesn't exist — fail loudly, don't
    // silently fall back (would mask their config bug).
    throw new ConfigError({
      what: `ATMUX_DISCORD_PING_SCRIPT='${explicitScript}' does not exist`,
      hint: "unset ATMUX_DISCORD_PING_SCRIPT to use the direct-fetch fallback",
    });
  }

  // Default-path script absent — fall back to direct fetch (test
  // environments, fresh checkouts without whip skill).
  if (!_fallbackWarned) {
    _fallbackWarned = true;
    process.stderr.write(
      "discord: ping-discord.sh not found, using direct fetch (set ATMUX_DISCORD_PING_SCRIPT to silence)\n",
    );
  }
  await directFetch(chunk, template, webhookOverride);
}

async function directFetch(
  chunk: string,
  template: DiscordTemplate,
  webhookOverride: string | undefined,
): Promise<void> {
  const url =
    webhookOverride !== undefined && webhookOverride !== ""
      ? webhookOverride
      : process.env.ATMUX_DISCORD_WEBHOOK;
  if (url === undefined || url === "") {
    throw new ConfigError({
      what: "no Discord webhook resolved",
      hint: "set ATMUX_DISCORD_WEBHOOK or install ~/.claude/skills/whip/scripts/ping-discord.sh",
    });
  }
  // R8 carve-out: discord.ts is the ONE module allowed to call `fetch`
  // directly (ADR-008 §"Routing"). The http abstraction is off-limits per
  // ADR-003 ("no abstraction imports another abstraction" — except spawn).
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: chunk }),
    });
  } catch (e) {
    throw new DiscordWebhookError({
      template,
      detail: "direct-fetch network failure",
      cause: e,
    });
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new DiscordWebhookError({
      template,
      statusCode: resp.status,
      body,
      detail: "direct-fetch non-2xx",
    });
  }
}

// ---------- Webhook resolution ----------

export interface ResolveWebhookOpts {
  /** Process env override (test injection). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Pre-loaded team object — `team.discord.webhook` is consulted second
   *  in the resolution chain. Pass `undefined` to skip the team-json step. */
  team?: { discord?: unknown };
}

/**
 * Resolve the Discord webhook URL per the bash `atmux::discord_resolve_webhook`
 * cascade:
 *
 *   1. `$ATMUX_DISCORD_WEBHOOK` env var
 *   2. `team.discord.webhook` (when caller passes the team)
 *   3. `${XDG_CONFIG_HOME:-$HOME/.config}/atmux/discord-webhook` file (trimmed)
 *
 * Returns `null` when no source resolves a non-empty value. Mirrors the
 * V-24 doctor + V-25 whip + future report cross-link consumers (see
 * ADR-019 + ADR-008 §"Routing"); `discord.send`'s `directFetch` reads
 * env directly today, but that's the lower-level fallback path —
 * `resolveWebhookUrl` is the canonical resolution helper.
 */
export async function resolveWebhookUrl(opts: ResolveWebhookOpts = {}): Promise<string | null> {
  const env = opts.env ?? process.env;

  // 1. env
  const fromEnv = env.ATMUX_DISCORD_WEBHOOK;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;

  // 2. team.discord.webhook
  if (opts.team !== undefined) {
    const d = opts.team.discord;
    if (d !== undefined && d !== null && typeof d === "object") {
      const w = (d as Record<string, unknown>).webhook;
      if (typeof w === "string" && w.length > 0) return w;
    }
  }

  // 3. XDG file
  const xdg = env.XDG_CONFIG_HOME;
  const home = env.HOME ?? "";
  const base = xdg !== undefined && xdg !== "" ? xdg : `${home}/.config`;
  const filePath = `${base}/atmux/discord-webhook`;
  const text = await readTextOrNull(filePath);
  if (text !== null) {
    const trimmed = text.trim();
    if (trimmed.length > 0) return trimmed;
  }

  return null;
}

// ---------- Test hooks ----------

/** Reset the once-per-process fallback warning flag. Test-only. */
export function _resetFallbackWarnedForTest(): void {
  _fallbackWarned = false;
}
