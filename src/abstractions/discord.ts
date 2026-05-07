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
import { formatDuration, formatMyt, now, nowIso } from "./time.ts";

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
  // ADR-052 §"Discord templates": three named templates the eternal-
  // improvement verb (T1) emits across a run lifecycle. Renderers live
  // below in this module (`renderEternalImprovement{Start,Progress,Done}`)
  // — adding the literals here is the compile-time R10 enforcement.
  | "eternal-improvement-start"
  | "eternal-improvement-progress"
  | "eternal-improvement-done"
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
  | "autonomous-decision"
  // ADR-054 §D3: surfaced when whip's per-tick team.json validation
  // fails. Renderer below (`renderWhipConfigDrift`); fired by
  // src/verbs/whip.ts after composing a DriftReport. Dedup via
  // <atmuxDir>/state/whip-config-drift-state.json with 24h re-fire window.
  | "whip-config-drift"
  // ADR-053 §D3: budget observability lifecycle templates. R1-T5 wires
  // emission from src/verbs/whip.ts after the per-account probe. Each
  // has a renderer below; dedup state lives in core modules
  // (budget-warning-state / budget-refresh-soon-state) per band/window.
  | "whip-budget-pause"
  | "whip-budget-resume"
  | "whip-budget-warning"
  | "whip-budget-refresh-soon"
  // ADR-056 §D5: account-swap lifecycle templates. T11 (R1-T11) wires
  // emission from src/core/account-swap.ts as the per-member workflow
  // walks decisions[]. Renderers below; bullet shape mirrors ADR-056
  // §D5 verbatim.
  | "whip-account-swap-start"
  | "whip-account-swap-success"
  | "whip-account-swap-fail"
  | "whip-account-swap-pass-complete"
  // ADR-057 §D6 R57-T6: watchdog verb fires when a member's heartbeat
  // is stale. Renderer below (`renderWhipWatchdog`); dedup state at
  // <atmuxDir>/state/watchdog-state.json (one-shot per-member 24h).
  | "whip-watchdog"
  // ADR-055 §D5 R1-T8: cursor self-heal lifecycle templates. Fired
  // by the whip-tick self-heal pass (one attempt + one result per
  // recipe-fire). Renderers below (`renderWhipSelfHealAttempt` +
  // `renderWhipSelfHealResult`); dedup state at <atmuxDir>/state/
  // cursor-self-heal-state.json (24h per recipe).
  | "whip-self-heal-attempt"
  | "whip-self-heal-result"
  // ADR-057 §D4 R57-T4: per-member health probes — drift findings.
  // Renderers below (`renderWhipPermModeDrift` + `renderWhipDefunctCwd`).
  // Dedup state for perm-mode at <atmuxDir>/state/perm-mode-drift-state.
  // json (24h per-member); defunct-cwd fires every tick (no dedup — a
  // defunct cwd is a P1 demand for operator action).
  | "whip-perm-mode-drift"
  | "whip-defunct-cwd";

/** Header category emojis per CLAUDE.md global conventions. */
export type CategoryEmoji =
  | "🚨"
  | "🛑"
  | "⏰"
  | "📋"
  | "📊"
  | "💓"
  | "🚀"
  | "📍"
  | "🛠️"
  | "🌱"
  // ADR-053 §D3 budget observability headers.
  | "⚠️"
  | "🌅"
  // ADR-056 §D5 account-swap lifecycle headers.
  | "🔄"
  // ADR-055 §D5 cursor self-heal lifecycle headers.
  | "🔧";

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
  // ADR-052 §"Discord templates": eternal-improvement bullet emojis.
  // 🌱 (run lifecycle bullet — budget line), 🎯 (mode line),
  // 💰 (tokens spent / consumed), 🔜 (next-cycle line),
  // ⏱️ (run duration), 🛑 (Mode B stop notice).
  "🌱",
  "🎯",
  "💰",
  "🔜",
  "⏱️",
  "🛑",
  // ADR-053 §D3: budget observability bullet emojis.
  // 🪫 (budget-pause team-paused row), 👥 (affected-members count),
  // 🔁 (next-band hint + auto-resume note), ⚠️ (warning prefix when used
  // in body), ▶️ (resume-restart note), 🌅 (refresh-soon window header).
  "🪫",
  "👥",
  "🔁",
  "⚠️",
  "▶️",
  "🌅",
  // ADR-056 §D5: account-swap bullet emojis.
  // 🚨 (trigger account banner), 🎯 (target fallback line), 🆔 (passId),
  // 💼 (in-flight task line), ❌ (per-member abort), 🚩 (flag/reason).
  "🚨",
  "🆔",
  "💼",
  "❌",
  "🚩",
  // ADR-055 §D5: cursor self-heal bullet emojis.
  // 📜 (patch summary line — "patch: N keys updated; pending reviewer").
  "📜",
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

// ---------- Eternal-improvement template renderers (ADR-052) ----------

/**
 * Format a token count for human display per ADR-052 §"Discord templates".
 *
 * - `n ≥ 1_000_000`  → `<X>M` with up to 2 decimal places, trailing zeros
 *                      trimmed (`1500000` → `"1.5M"`, `1520000` → `"1.52M"`,
 *                      `2000000` → `"2M"`).
 * - `n ≥ 1_000`      → `<X>k` integer (`200000` → `"200k"`, `30500` → `"31k"`).
 * - otherwise        → integer string (`500` → `"500"`).
 *
 * Negative input is normalized to its absolute value.
 */
function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    const m = abs / 1_000_000;
    // Up to 2 decimal places, trim trailing zeros + lone decimal point.
    return `${m.toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (abs >= 1_000) return `${Math.round(abs / 1_000)}k`;
  return `${Math.round(abs)}`;
}

export interface EternalImprovementStartOpts {
  team: string;
  /** Raw spec string as resolved (e.g. `"30%-wk"`). */
  budgetSpec: string;
  /** Token budget total computed at start (e.g. `1_500_000`). */
  budgetTotal: number;
  /** Per ADR-052 §"State-file schema". */
  mode: "user-invoked" | "idle-fallback";
  /** Per ADR-052 §"State-file schema" — `ei-<8-hex>`. */
  runId: string;
  /** Override timestamp (test injection); defaults to `now()`. */
  whenMs?: number;
}

/**
 * Build the `[eternal-improvement-start]` Discord send opts per ADR-052.
 * Caller passes the result to `send()`.
 */
export function renderEternalImprovementStart(
  opts: EternalImprovementStartOpts,
): DiscordSendOpts {
  const out: DiscordSendOpts = {
    template: "eternal-improvement-start",
    team: opts.team,
    category: "🌱",
    bullets: [
      `🌱 budget: ${opts.budgetSpec} = ${formatTokens(opts.budgetTotal)} tokens`,
      `🎯 mode: ${opts.mode}`,
      `📍 runId: ${opts.runId}`,
    ],
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

export interface EternalImprovementProgressOpts {
  team: string;
  /** Cycle that just closed (1-indexed). */
  cycleN: number;
  /** Tasks shipped in this cycle. */
  tasksShipped: number;
  /** Tokens spent in this cycle. */
  tokensSpent: number;
  /** Total token budget. */
  budgetTotal: number;
  /** Tokens remaining post-decrement. */
  budgetRemaining: number;
  whenMs?: number;
}

/**
 * Build the `[eternal-improvement-progress]` Discord send opts per ADR-052
 * (one per cycle close).
 */
export function renderEternalImprovementProgress(
  opts: EternalImprovementProgressOpts,
): DiscordSendOpts {
  const out: DiscordSendOpts = {
    template: "eternal-improvement-progress",
    team: opts.team,
    category: "🌱",
    bullets: [
      `✅ cycle ${opts.cycleN} closed — ${opts.tasksShipped} tasks shipped`,
      `💰 tokens spent: ${formatTokens(opts.tokensSpent)} of ${formatTokens(opts.budgetTotal)}`,
      `📊 budget remaining: ${formatTokens(opts.budgetRemaining)}`,
      `🔜 cycle ${opts.cycleN + 1} starting`,
    ],
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

export interface EternalImprovementDoneOpts {
  team: string;
  /** Total cycles completed during the run. */
  cycleCount: number;
  /** Total tasks shipped across all cycles. */
  totalTasksShipped: number;
  /** Total tokens consumed across the run. */
  tokensConsumed: number;
  /** Original budget total. */
  budgetTotal: number;
  /** Run duration in milliseconds. Rendered via `formatDuration`. */
  durationMs: number;
  /** Whether the run was Mode B (idle-fallback). When true, the template
   *  appends the `🛑 (Mode B) team will now atmux stop` bullet per ADR-052. */
  modeB: boolean;
  whenMs?: number;
}

/**
 * Build the `[eternal-improvement-done]` Discord send opts per ADR-052.
 *
 * Overage handling: when `tokensConsumed > budgetTotal`, the tokens bullet
 * appends ` (X.X% overage, mid-task)` per the ADR's example output. The
 * driver's "feature must be fully built even though a bit more tokens are
 * used" directive (§"Loop mechanics") makes mid-cycle overage expected.
 */
export function renderEternalImprovementDone(
  opts: EternalImprovementDoneOpts,
): DiscordSendOpts {
  const overageBytes =
    opts.tokensConsumed > opts.budgetTotal && opts.budgetTotal > 0
      ? ` (${(((opts.tokensConsumed - opts.budgetTotal) / opts.budgetTotal) * 100).toFixed(1)}% overage, mid-task)`
      : "";
  const tokensBullet = `💰 tokens consumed: ${formatTokens(opts.tokensConsumed)} of ${formatTokens(opts.budgetTotal)}${overageBytes}`;
  const bullets: string[] = [
    `✅ run complete — ${opts.cycleCount} cycles, ${opts.totalTasksShipped} tasks shipped`,
    tokensBullet,
    `⏱️ duration: ${formatDuration(opts.durationMs)}`,
  ];
  if (opts.modeB) {
    bullets.push("🛑 (Mode B) team will now `atmux stop`");
  }
  const out: DiscordSendOpts = {
    template: "eternal-improvement-done",
    team: opts.team,
    category: "🌱",
    bullets,
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

// ---------- ADR-054 §D3 [whip-config-drift] ----------

export interface WhipConfigDriftIssue {
  /** Path components, e.g. ["whip", "budgetPauseThreshold"]. */
  path: string[];
  /** Zod issue code, or "invalid_json" for malformed-JSON drift. */
  code: string;
  /** Human-readable Zod message. */
  message: string;
}

export interface WhipConfigDriftOpts {
  team: string;
  /** sha256 hex; truncated to 8 chars in display. */
  driftHash: string;
  /** Up to 5 issues per ADR-054 §D2 cap. */
  issues: ReadonlyArray<WhipConfigDriftIssue>;
  /** True when the underlying failure was malformed JSON (catastrophic). */
  catastrophic: boolean;
  whenMs?: number;
}

/**
 * Build the `[whip-config-drift]` Discord send opts per ADR-054 §D3.
 *
 * Bullets:
 *   - `⚠️ team.json::whip validation failed — using safe defaults`
 *     (or `team.json malformed — using full safe defaults` for catastrophic)
 *   - `📍 issues: <N> (<count-by-code>)`
 *   - `🔍 first: <path> (<code>, <message>)` — only when ≥1 issue
 *   - `🛠️ fix: edit team.json + re-run atmux doctor`
 *   - `📜 driftHash: <8-hex> (re-pings if changes)`
 *
 * `category: '🛠️'` per CLAUDE.md per-bullet emoji table.
 */
export function renderWhipConfigDrift(opts: WhipConfigDriftOpts): DiscordSendOpts {
  const issuesCount = opts.issues.length;
  const codeCounts = countByCode(opts.issues);
  const codeSummary = formatCodeCounts(codeCounts);
  const headline = opts.catastrophic
    ? `⚠️ team.json malformed — using full safe defaults`
    : `⚠️ team.json::whip validation failed — using safe defaults`;
  const bullets: string[] = [
    headline,
    `📍 issues: ${issuesCount}${codeSummary === "" ? "" : ` (${codeSummary})`}`,
  ];
  const first = opts.issues[0];
  if (first !== undefined) {
    const pathStr = first.path.length === 0 ? "<root>" : first.path.join(".");
    bullets.push(`🔍 first: ${pathStr} (${first.code}, ${first.message})`);
  }
  bullets.push(`🛠️ fix: edit team.json + re-run atmux doctor`);
  bullets.push(`📜 driftHash: ${opts.driftHash.slice(0, 8)} (re-pings if changes)`);
  const out: DiscordSendOpts = {
    template: "whip-config-drift",
    team: opts.team,
    category: "🛠️",
    bullets,
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

function countByCode(issues: ReadonlyArray<WhipConfigDriftIssue>): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of issues) m.set(i.code, (m.get(i.code) ?? 0) + 1);
  return m;
}

function formatCodeCounts(counts: Map<string, number>): string {
  if (counts.size === 0) return "";
  const parts: string[] = [];
  // Sort by code name for stability.
  const entries = [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [code, n] of entries) parts.push(`${n} ${code}`);
  return parts.join(", ");
}

// ---------- ADR-053 §D3 budget observability renderers ----------

/** At-risk member row used by [whip-budget-pause]. Mirrors
 *  `core/budget-pause.ts::AtRiskMember` shape (h5/wk are pct used,
 *  0–100 integer). */
export interface BudgetPauseAtRiskRow {
  member: string;
  /** 5h utilization, 0–100 integer pct used. */
  h5: number;
  /** 7d utilization, 0–100 integer pct used. */
  wk: number;
}

export interface BudgetPauseDiscordOpts {
  team: string;
  /** Team members tripped over the pause threshold. */
  atRisk: ReadonlyArray<BudgetPauseAtRiskRow>;
  /** Resume threshold (% remaining) for the resume-gate hint bullet. */
  resumeThresholdPct: number;
  whenMs?: number;
}

/**
 * Build the `[whip-budget-pause]` Discord send opts per ADR-053 §D3
 * `whip-budget-pause` template. Header is 🛑; body lists each at-risk
 * member with their 5h/wk utilization, then the no-dispatch + resume-
 * gate hint bullets.
 */
export function renderWhipBudgetPause(opts: BudgetPauseDiscordOpts): DiscordSendOpts {
  const memberBullets = opts.atRisk.map(
    (r) => `🪫 ${r.member} — 5h ${r.h5}% / wk ${r.wk}%`,
  );
  const bullets: string[] = [
    `🪫 team paused — ${opts.atRisk.length} at-risk member(s)`,
    ...memberBullets,
    `🛑 no new dispatches until refresh`,
    `🔁 resume gate: all members > ${opts.resumeThresholdPct}% remaining on 5h AND wk`,
  ];
  const out: DiscordSendOpts = {
    template: "whip-budget-pause",
    team: opts.team,
    category: "🛑",
    bullets,
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

export interface BudgetResumeDiscordOpts {
  team: string;
  /** Resume threshold (% remaining) the team cleared. */
  resumeThresholdPct: number;
  whenMs?: number;
}

/**
 * Build the `[whip-budget-resume]` Discord send opts per ADR-053 §D3.
 * Header 🚀, brief 2-bullet body announcing the team is back online.
 */
export function renderWhipBudgetResume(opts: BudgetResumeDiscordOpts): DiscordSendOpts {
  const out: DiscordSendOpts = {
    template: "whip-budget-resume",
    team: opts.team,
    category: "🚀",
    bullets: [
      `🟢 team resumed — all members > ${opts.resumeThresholdPct}% remaining on 5h AND wk`,
      `▶️ dispatches re-enabled`,
    ],
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

export interface BudgetWarningDiscordOpts {
  team: string;
  /** Account whose remaining budget tripped the band. */
  account: string;
  /** Window the band fired on. */
  window: "5h" | "wk";
  /** Remaining percentage at firing time, 0–100 integer. */
  remainingPct: number;
  /** Band that just crossed (e.g. 0.5 → "50%"; ADR-053 §D3 default
   *  bands are 0.5/0.25/0.15). */
  band: number;
  /** Pre-formatted "Hh Mm" string (compact human-readable per
   *  CLAUDE.md duration-formatting rule). */
  resetIn: string;
  /** Number of team members on this account. */
  affectedMembers: number;
  /** Optional "next band: 25%"-shaped hint when one exists below. */
  nextBandPct?: number;
  whenMs?: number;
}

/**
 * Build the `[whip-budget-warning]` Discord send opts per ADR-053 §D3
 * 4.1 (band-crossing). Header ⚠️, account-scoped detail bullets.
 *
 * Caller composes one per (account, window, band) crossing — dedup
 * via `core/budget-warning-state.ts` to ensure each band fires once
 * per window-reset cycle.
 */
export function renderWhipBudgetWarning(opts: BudgetWarningDiscordOpts): DiscordSendOpts {
  const bandPct = Math.round(opts.band * 100);
  const bullets: string[] = [
    `💰 account: \`${opts.account}\` — remaining ${opts.window}: ${opts.remainingPct}% (band: ${bandPct}%)`,
    `⏱️ resets in: ${opts.resetIn}`,
    `👥 affected members: ${opts.affectedMembers}`,
  ];
  if (opts.nextBandPct !== undefined) {
    bullets.push(`🔁 next band: ${opts.nextBandPct}%`);
  }
  const out: DiscordSendOpts = {
    template: "whip-budget-warning",
    team: opts.team,
    category: "⚠️",
    bullets,
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

export interface BudgetRefreshSoonDiscordOpts {
  team: string;
  account: string;
  window: "5h" | "wk";
  /** Pre-formatted "Nmin" / "HhMm" compact-duration string. */
  resetsIn: string;
  /** Remaining percentage at firing time, 0–100 integer. */
  remainingPct: number;
  /** Whether the team is currently in budget-pause (drives the
   *  `🔁 will auto-resume on refresh` hint). */
  pausedNow: boolean;
  whenMs?: number;
}

/**
 * Build the `[whip-budget-refresh-soon]` Discord send opts per
 * ADR-053 §D3 4.2. Header 🌅, fires once per (account, window,
 * resetEpoch) — dedup via `core/budget-refresh-soon-state.ts`.
 */
export function renderWhipBudgetRefreshSoon(
  opts: BudgetRefreshSoonDiscordOpts,
): DiscordSendOpts {
  const bullets: string[] = [
    `⏱️ window resets in: ${opts.resetsIn} (${opts.window})`,
    `💰 account: \`${opts.account}\` — remaining: ${opts.remainingPct}%`,
  ];
  if (opts.pausedNow) {
    bullets.push(`🔁 will auto-resume on refresh`);
  }
  const out: DiscordSendOpts = {
    template: "whip-budget-refresh-soon",
    team: opts.team,
    category: "🌅",
    bullets,
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

// ---------- ADR-056 §D5: account-swap renderers ----------

export interface AccountSwapStartOpts {
  team: string;
  /** Trigger account name. */
  triggerAccount: string;
  /** Trigger window pct-used (the higher of h5/wk that fired). */
  triggerPct: number;
  /** Window label — `5h` or `wk` — for the trigger bullet. */
  triggerWindow: "5h" | "wk";
  /** Total swap candidates (eligible workers). */
  candidates: number;
  /** Excluded count (lead/planner/reviewer on trigger account). */
  excluded: number;
  /** Comma-separated excluded role names (e.g. `"lead/planner/reviewer"`). */
  excludedRoles: string;
  /** Fallback target account name. */
  fallbackAccount: string;
  /** Fallback h5 / wk pct-used at probe time. */
  fallbackH5: number;
  fallbackWk: number;
  /** Pass id — `swap-<8-hex>`. */
  passId: string;
  whenMs?: number;
}

/** Pass-level start ping (ADR-056 §D5). One per pass when the trigger
 *  fires + a viable fallback is selected. */
export function renderAccountSwapStart(opts: AccountSwapStartOpts): DiscordSendOpts {
  const out: DiscordSendOpts = {
    template: "whip-account-swap-start",
    team: opts.team,
    category: "🔄",
    bullets: [
      `🚨 trigger: account \`${opts.triggerAccount}\` at ${opts.triggerPct}% (${opts.triggerWindow})`,
      `👥 candidates: ${opts.candidates} members (${opts.excluded} excluded: ${opts.excludedRoles})`,
      `🎯 target fallback: \`${opts.fallbackAccount}\` (${opts.fallbackH5}%/${opts.fallbackWk}%)`,
      `🆔 passId: ${opts.passId}`,
    ],
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

export interface AccountSwapSuccessOpts {
  team: string;
  /** Original member name. */
  fromMember: string;
  /** Shadow member name (`<original>-swap`). */
  toMember: string;
  /** Target account the shadow runs on. */
  toAccount: string;
  /** In-flight task id handed off, or null when no task in flight. */
  taskId: string | null;
  /** Per-member workflow duration in milliseconds. */
  durationMs: number;
  /** Decisions complete count (numerator). */
  progressDone: number;
  /** Total decisions (denominator). */
  progressTotal: number;
  whenMs?: number;
}

/** Per-member success ping (ADR-056 §D5). Fires after handoff +
 *  pause-original + state-file decision flip → `done`. */
export function renderAccountSwapSuccess(opts: AccountSwapSuccessOpts): DiscordSendOpts {
  const taskBullet =
    opts.taskId !== null
      ? `💼 in-flight task: ${opts.taskId} (handed off cleanly)`
      : `💼 in-flight task: (none — clean handoff)`;
  const out: DiscordSendOpts = {
    template: "whip-account-swap-success",
    team: opts.team,
    category: "🔄",
    bullets: [
      `✅ swapped: \`${opts.fromMember}\` → \`${opts.toMember}\` on \`${opts.toAccount}\``,
      taskBullet,
      `⏱️ duration: ${formatDuration(opts.durationMs)}`,
      `📊 progress: ${opts.progressDone}/${opts.progressTotal}`,
    ],
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

export interface AccountSwapFailOpts {
  team: string;
  /** Member that couldn't be swapped. */
  member: string;
  /** Short failure category (e.g. `target probe 401`, `spawn timeout`,
   *  `deadline exceeded`). Rendered next to the abort bullet. */
  failureBrief: string;
  /** Long-form reason for the operator. */
  reason: string;
  /** Account the member stays on (the original — pause path). */
  fallbackAccount: string;
  /** Optional flag id raised; null when no flag emitted. */
  flagId: string | null;
  /** Severity of the flag (typically p2). */
  flagSeverity: "p0" | "p1" | "p2";
  whenMs?: number;
}

/** Per-member failure ping (ADR-056 §D5). Fires when the per-member
 *  workflow aborts (probe-401 / spawn-fail / deadline-exceeded). */
export function renderAccountSwapFail(opts: AccountSwapFailOpts): DiscordSendOpts {
  const flagBullet =
    opts.flagId !== null
      ? `🚩 flag: ${opts.flagSeverity} raised (${opts.flagId})`
      : `🚩 flag: ${opts.flagSeverity} raised`;
  const out: DiscordSendOpts = {
    template: "whip-account-swap-fail",
    team: opts.team,
    category: "🔄",
    bullets: [
      `❌ swap aborted: \`${opts.member}\` (${opts.failureBrief})`,
      `🚩 reason: ${opts.reason}`,
      `📍 fallback: keeping \`${opts.member}\` on \`${opts.fallbackAccount}\` (will hit pause)`,
      flagBullet,
    ],
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

export interface AccountSwapPassCompleteOpts {
  team: string;
  passId: string;
  /** Members successfully swapped. */
  swapped: number;
  /** Members aborted (probe-fail / deadline / spawn-fail). */
  aborted: number;
  /** Members excluded (lead/planner/reviewer roles). */
  excluded: number;
  /** Trigger account name (for the post-pass utilization bullet). */
  triggerAccount: string;
  /** Trigger account pct-used at pass close — proves the pin lifted. */
  triggerPctPostPass: number;
  /** Pass duration in milliseconds. */
  durationMs: number;
  whenMs?: number;
}

/** Pass-complete ping (ADR-056 §D5). Final ping per pass; archives the
 *  decisions[] tally + lifts the pin. */
export function renderAccountSwapPassComplete(
  opts: AccountSwapPassCompleteOpts,
): DiscordSendOpts {
  const out: DiscordSendOpts = {
    template: "whip-account-swap-pass-complete",
    team: opts.team,
    category: "🔄",
    bullets: [
      `✅ pass \`${opts.passId}\` complete`,
      `📊 swapped: ${opts.swapped} / aborted: ${opts.aborted} / excluded: ${opts.excluded}`,
      `💰 budget on ${opts.triggerAccount} post-pass: ${opts.triggerPctPostPass}% used (no longer pinned)`,
      `⏱️ pass duration: ${formatDuration(opts.durationMs)}`,
    ],
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

// ---------- ADR-057 §D6 R57-T6 — renderWhipWatchdog ----------

export interface WhipWatchdogStaleMember {
  member: string;
  /** Heartbeat age in seconds, or null when no heartbeat exists. */
  ageSec: number | null;
}

export interface WhipWatchdogOpts {
  team: string;
  /** Stalled members + their heartbeat ages. */
  stale: ReadonlyArray<WhipWatchdogStaleMember>;
  /** Configured staleness threshold in seconds (used in the bullet). */
  staleSec: number;
  whenMs?: number;
}

/**
 * Build the `[whip-watchdog]` Discord send opts per ADR-057 §D6.
 *
 * Bullets:
 *   - `🛑 N member(s) stalled — heartbeat older than <threshold>`
 *   - `📍 <member>: <age> stale` per stalled member
 *   - `🛠️ fix: check pane state + restart member if needed`
 */
export function renderWhipWatchdog(opts: WhipWatchdogOpts): DiscordSendOpts {
  const bullets: string[] = [
    `🛑 ${opts.stale.length} member(s) stalled — heartbeat older than ${formatDuration(opts.staleSec * 1000)}`,
  ];
  for (const s of opts.stale) {
    const ageStr = s.ageSec === null ? "never" : formatDuration(s.ageSec * 1000);
    bullets.push(`📍 ${s.member}: ${ageStr} stale`);
  }
  bullets.push("🛠️ fix: check pane state + restart member if needed");
  const out: DiscordSendOpts = {
    template: "whip-watchdog",
    team: opts.team,
    category: "🛑",
    bullets,
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

// ---------- ADR-055 §D5 R1-T8 — cursor self-heal renderers ----------

export interface WhipSelfHealAttemptOpts {
  team: string;
  /** Recipe id, e.g. `"fix:team-json-schema-drift"`. */
  recipeId: string;
  /** Operator-readable reason the recipe fired (e.g.
   *  `"3 invalid keys detected"`). Composed by the recipe's `detect`. */
  reason: string;
  /** Per-recipe token cap (the resolved cap used for this invocation,
   *  not the default). */
  tokenCap: number;
  whenMs?: number;
}

/**
 * Build the `[whip-self-heal-attempt]` Discord send opts per ADR-055 §D5.
 * Fired BEFORE invoking cursor — proves the recipe's detect → propose
 * sequenced cleanly even if cursor fails downstream.
 *
 * Bullets:
 *   - `🛠️ recipe: <recipeId>`
 *   - `📍 reason: <reason>`
 *   - `💰 token cap: <tokenCap formatted>`
 */
export function renderWhipSelfHealAttempt(
  opts: WhipSelfHealAttemptOpts,
): DiscordSendOpts {
  const out: DiscordSendOpts = {
    template: "whip-self-heal-attempt",
    team: opts.team,
    category: "🔧",
    bullets: [
      `🛠️ recipe: ${opts.recipeId}`,
      `📍 reason: ${opts.reason}`,
      `💰 token cap: ${formatTokens(opts.tokenCap)}`,
    ],
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

export interface WhipSelfHealResultOpts {
  team: string;
  /** Recipe id, e.g. `"fix:supervisor-missing"`. */
  recipeId: string;
  /** True iff cursor invocation + recipe verify both succeeded AND the
   *  patch was staged for reviewer. False routes the failure variant
   *  (verify reasons + flag note) per ADR-055 §D5. */
  ok: boolean;
  /** Tokens actually consumed (parsed from cursor's --output-json
   *  metadata). May be -1 when metadata unparseable; renderer treats
   *  -1 as "unknown" and renders as `?`. */
  tokensUsed: number;
  /** Resolved token cap (matches the attempt-ping's value). */
  tokenCap: number;
  /** One-line patch summary from `verify().patchSummary` (success) or
   *  the recipe's failure summary (failure variant). Always present —
   *  the recipe is responsible for composing a reasonable string. */
  patchSummary: string;
  /** Path to the cursor session log on disk, e.g.
   *  `.atmux/logs/cursor-self-heal-fix-team-json-schema-drift-<ts>.log`.
   *  Surfaced as the `📍 see:` bullet. */
  logPath: string;
  /** Failure-variant only: verify-rejection reasons (one rendered as
   *  the headline reasons bullet, others summarised in a count).
   *  Required when `ok: false`; ignored when `ok: true`. */
  reasons?: ReadonlyArray<string>;
  /** Failure-variant only: flag severity raised for operator triage.
   *  Required when `ok: false`; ignored when `ok: true`. */
  flagSeverity?: "p0" | "p1" | "p2";
  whenMs?: number;
}

/**
 * Build the `[whip-self-heal-result]` Discord send opts per ADR-055 §D5.
 *
 * Success bullets:
 *   - `✅ recipe: <recipeId> — patch staged`
 *   - `💰 tokens used: <X> of <cap> cap`
 *   - `📜 patch: <patchSummary>`
 *   - `📍 see: <logPath>`
 *
 * Failure bullets (when `ok: false`):
 *   - `❌ recipe: <recipeId> — verify failed`
 *   - `🛑 reasons: <first reason>` (+`(N more)` when reasons.length > 1)
 *   - `📍 see: <logPath>`
 *   - `🚩 flag: <severity> raised — operator triage needed`
 */
export function renderWhipSelfHealResult(
  opts: WhipSelfHealResultOpts,
): DiscordSendOpts {
  const tokensUsedStr = opts.tokensUsed >= 0 ? formatTokens(opts.tokensUsed) : "?";
  const tokenCapStr = formatTokens(opts.tokenCap);
  const bullets: string[] = [];
  if (opts.ok) {
    bullets.push(`✅ recipe: ${opts.recipeId} — patch staged`);
    bullets.push(`💰 tokens used: ${tokensUsedStr} of ${tokenCapStr} cap`);
    bullets.push(`📜 patch: ${opts.patchSummary}`);
    bullets.push(`📍 see: ${opts.logPath}`);
  } else {
    const reasons = opts.reasons ?? [];
    const first = reasons[0] ?? opts.patchSummary;
    const tail = reasons.length > 1 ? ` (${reasons.length - 1} more)` : "";
    const severity = opts.flagSeverity ?? "p2";
    bullets.push(`❌ recipe: ${opts.recipeId} — verify failed`);
    bullets.push(`🛑 reasons: ${first}${tail}`);
    bullets.push(`📍 see: ${opts.logPath}`);
    bullets.push(`🚩 flag: ${severity} raised — operator triage needed`);
  }
  const out: DiscordSendOpts = {
    template: "whip-self-heal-result",
    team: opts.team,
    category: "🔧",
    bullets,
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

// ---------- ADR-057 §D4 R57-T4 — per-member health-probe renderers ----------

export interface WhipPermModeDriftMember {
  member: string;
  /** Observed mode token (e.g. `"dont-ask"`, `"accept-edits"`). The
   *  parser in `core/perm-mode-drift-state.parsePermissionMode` maps
   *  Claude Code's bottom-row indicator onto this string. */
  mode: string;
}

export interface WhipPermModeDriftOpts {
  team: string;
  /** Members observed in a non-`auto` permission mode this tick. */
  drifted: ReadonlyArray<WhipPermModeDriftMember>;
  whenMs?: number;
}

/**
 * Build the `[whip-perm-mode-drift]` Discord send opts per ADR-057 §D4a.
 * Fired when ≥1 member's pane shows a `⏵⏵ <mode> on` indicator with
 * `mode !== "auto"`. Per-member dedup'd 24h via
 * `<atmuxDir>/state/perm-mode-drift-state.json`.
 *
 * Bullets:
 *   - `📍 N member(s) drifted off auto mode`
 *   - `🟡 <member>: pane in '<mode>' mode (expected 'auto')` per drifted member
 *   - `🛠️ fix: BTab cycle to auto on each drifted pane`
 */
export function renderWhipPermModeDrift(opts: WhipPermModeDriftOpts): DiscordSendOpts {
  const bullets: string[] = [
    `📍 ${opts.drifted.length} member(s) drifted off auto mode`,
  ];
  for (const d of opts.drifted) {
    bullets.push(`🟡 ${d.member}: pane in '${d.mode}' mode (expected 'auto')`);
  }
  bullets.push("🛠️ fix: BTab cycle to auto on each drifted pane");
  const out: DiscordSendOpts = {
    template: "whip-perm-mode-drift",
    team: opts.team,
    category: "📋",
    bullets,
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

export interface WhipDefunctCwdMember {
  member: string;
  /** The cwd path that no longer exists on disk. */
  cwd: string;
}

export interface WhipDefunctCwdOpts {
  team: string;
  /** Members whose pane_current_path doesn't exist on disk. */
  defunct: ReadonlyArray<WhipDefunctCwdMember>;
  whenMs?: number;
}

/**
 * Build the `[whip-defunct-cwd]` Discord send opts per ADR-057 §D4c.
 * Fired when ≥1 member's pane has a `pane_current_path` that doesn't
 * exist on disk (worktree deleted, mount unmounted, etc). P1 — fires
 * every tick (no dedup) until operator resolves; defunct cwd silently
 * destroys all subsequent member work.
 *
 * Bullets:
 *   - `🛑 N member(s) on defunct cwd — pane_current_path missing on disk`
 *   - `📍 <member>: cwd <path> does not exist` per defunct member
 *   - `🛠️ fix: re-spawn member or restore worktree path`
 */
export function renderWhipDefunctCwd(opts: WhipDefunctCwdOpts): DiscordSendOpts {
  const bullets: string[] = [
    `🛑 ${opts.defunct.length} member(s) on defunct cwd — pane_current_path missing on disk`,
  ];
  for (const d of opts.defunct) {
    bullets.push(`📍 ${d.member}: cwd ${d.cwd} does not exist`);
  }
  bullets.push("🛠️ fix: re-spawn member or restore worktree path");
  const out: DiscordSendOpts = {
    template: "whip-defunct-cwd",
    team: opts.team,
    category: "🛑",
    bullets,
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

// ---------- Test hooks ----------

/** Reset the once-per-process fallback warning flag. Test-only. */
export function _resetFallbackWarnedForTest(): void {
  _fallbackWarned = false;
}
