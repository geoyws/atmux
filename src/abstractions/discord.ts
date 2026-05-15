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
//   - Posts each chunk via bun-native `fetch` against the resolved webhook
//     URL. (Earlier revisions delegated to `~/.claude/skills/whip/scripts/
//     ping-discord.sh` via spawn(); the script was never installed on this
//     deploy, every cron tick logged a "not found, using direct fetch"
//     warning, and the fallback IS the canonical path. The spawn route was
//     dropped — see ADR-008 §"Routing".)
//   - Honours `ATMUX_DISCORD_RECORDER` for parity-harness JSONL capture
//     (per ADR-009 §3 + tests/parity/intercept-discord.ts).
//
// `template: DiscordTemplate` is a literal-union type, so the central
// "every send is a named template" guarantee (R10) is compile-time
// enforced. Runtime validation covers bullet shape only.

import { appendFile } from "node:fs/promises";
import { ConfigError, DiscordWebhookError } from "../errors.ts";
import { readTextOrNull } from "./fs.ts";
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
  | "whip-defunct-cwd"
  // ADR-086: cockpit-wide pulse verdict probe (Phase 1 deterministic).
  // Renderer below (`renderPulseVerdict`); fired by `src/verbs/pulse.ts`
  // on verdict change OR sustained-urgency dedup expiry. Header emoji is
  // chosen per-verdict (💓 / 📊 / 🛑 / 🚨) — verify the four are in
  // the per-bullet allowlist + the CategoryEmoji union above.
  | "pulse-verdict"
  // ADR-085 §Three surfaces #2: approval-debt watcher. Fired by
  // `src/verbs/whip.ts` §2.5 each tick when `scanNeedsApproval()`
  // returns `total > 0`. Renderer below (`renderWhipNeedsApproval`);
  // skipped entirely when total is 0 (no ✅-all spam). No dedup —
  // operator sees the same proposed ADRs each tick because they're
  // STILL proposed; mitigation is `(deferred: <reason>)` annotation
  // per ADR-085 §Consequences.
  | "whip-needs-approval"
  // ADR-077 §F6: superdoctor self-escalation. Fired when the skill
  // has attempted 3 structural fixes against the same complaint hash
  // and all failed. Renderer below (`renderSelfHealFailed`); dedup
  // state in state_kv (feature `superdoctor-self-heal-escalation`,
  // key = complaint_id) with a 1h re-fire window.
  | "self-heal-failed"
  // t-351318dc: cockpit-pulse meta-watchdog. Fired when superdoctor
  // itself looks dormant (≥1 open complaint anywhere AND no
  // superdoctor_attempts.attempted_at row newer than 2h). Renderer
  // below (`renderMetaWatchdog`); dedup state on `PulseState.metaWatchdog`
  // (paged + dormantSinceSec) — one ping per dormancy streak.
  | "meta-watchdog"
  // ADR-131 §D5 (T5): superdoctor kanban-hygiene blocker. Fired by
  // the drain loop ONLY when (severity===P0) AND (wedgedMin >=240)
  // AND refuse-and-ask escape triggered (zero deterministic
  // candidates per §D3 rule 4). Renderer below
  // (`renderHygieneBlocker`); P0 with a deterministic fix is
  // silently auto-fixed + complaint-box logged, NOT pinged here.
  // No dedup — wedge persists across ticks because no deterministic
  // candidate yet exists; suppression is the caller's gate, not
  // the renderer's.
  | "hygiene-blocker"
  // ADR-142 §D4: modal-cycling detector. Fired when ≥cycleThreshold
  // distinct modal-hashes within windowMin AND 0 commits in
  // commitGracePeriodMin. Renderer below (`renderWhipModalCycling`);
  // dedup state at `<atmuxDir>/state/modal-cycling-dedup-state.json`
  // (per-member, dedupMin window — default 30min).
  | "whip-modal-cycling"
  // ADR-137 §D3: member-forcepush-recent post-hoc surface. Fired when
  // the `checkMemberForcePushRecent` doctor probe surfaces a recent
  // force-push event on a per-member branch — nudges the team toward
  // the ADR-137 merge-over-rebase convention. Renderer below
  // (`renderMemberForcePushWarning`); dedup state at
  // `<atmuxDir>/state/member-forcepush-dedup-state.json` (per-team:
  // per-branch, 30min dedup window — operator may see the same
  // member's force-push twice in 30min only if there's a second one).
  | "member-forcepush-warning"
  // ADR-138 T3: send-keys-failure post-hoc surface. Fired when the
  // `checkSendKeysFailureRecent` doctor probe finds entries in the
  // last hour of `~/.atmux/state/send-keys-failures.log` (written by
  // `safeSendKeysWithVerify`'s escalation path). Renderer below
  // (`renderSendKeysFailureWarning`); dedup state TBD — wire-in is
  // deferred to a follow-up Task per the ADR-137 precedent (probe +
  // template ship in this commit; surfacer wires later).
  | "send-keys-failure";

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
  /**
   * Verdict line — single load-bearing field per the CLAUDE.md §Discord
   * spec (2026-05-13 rewrite). Lands as the FIRST body line, before any
   * bullets/sections. Single-source vocabulary:
   *   🟢 **Shipping** — N commits in window, healthy
   *   🟡 **Cool** — quiet on purpose (between phases, waiting on user)
   *   🟡 **Idle** — quiet by accident (fresh team, dispatch in flight)
   *   🔴 **Stalled** — 0 commits + a symptom (watchdog territory)
   *   🚨 **Need you** — only for blocker / high-priority decisions
   *
   * Optional for back-compat — older renderers can stay verdict-less while
   * being migrated. New renderers MUST set it per the spec.
   */
  verdict?: string;
  /** Optional flat bullet list (non-sectioned body). */
  bullets?: ReadonlyArray<string>;
  /** Optional sectioned body. */
  sections?: ReadonlyArray<DiscordSection>;
  /**
   * Milestone-grade "What's new" bullets — emitted under the verdict line,
   * prose-grade ≤80 chars per bullet, NO emoji-prefix requirement. Used for
   * progress-shaped messages that list 1-3 milestones, e.g.:
   *   "ADR-081 brief-paste lives in TS spawn loop now"
   *   "`task update` subverb shipped (ADR-084 W3)"
   *
   * Differs from `bullets`: those carry the legacy emoji-prefixed-bullet
   * shape; `whatsNew` carries milestone narrative. See CLAUDE.md §Discord
   * "What's new" semantics. Renders under a bold "✨ **What's new**" label.
   */
  whatsNew?: ReadonlyArray<string>;
  /**
   * Single-line footer — emitted as the LAST body line. Carries ambient
   * liveness ("last commit Xmin ago · lead Ymin uptime · K complaints")
   * so body sections stay focused on signal. Optional; skip on bootstrap /
   * lifecycle pings where liveness isn't relevant. Rendered with a 📍 prefix.
   */
  footer?: string;
  /** Override the resolved webhook URL (test injection). */
  webhookOverride?: string;
  /** Override the timestamp (test injection); defaults to time.now(). */
  whenMs?: number;
}

// ---------- Validation ----------

/** Per-bullet emoji prefix allowlist per CLAUDE.md global conventions.
 *  Exported so the structural lint (tests/unit/abstractions/
 *  discord-bullet-prefix-audit.test.ts) can import + cross-check
 *  every `bullet80(\`<emoji>` literal across the src tree against
 *  the allowlist. Bug 1 driver fast-path guards: any new emoji a
 *  caller introduces in code MUST also land here, or the validator
 *  silently rejects the bullet at Discord-emit time → digest stays
 *  blank. The audit test catches that coupling at lint-time. */
export const ALLOWED_BULLET_PREFIX = new Set<string>([
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
  // Bug 1 (driver-auth 19:00 MYT 2026-05-08): emojis silently rejected
  // by the validator that the runtime code already emits OR the driver
  // greenlit for forward-compat. Six-emoji minimum per the dispatch:
  // ⏰ (whip overdue / stale-task bullet — whip.ts:1281),
  // 📋 (perm-mode drift bullet — whip.ts:1297),
  // 🩹 (fix bullet — Bug 2/3 templates ahead),
  // 💓 (heartbeat header / bullet),
  // 🚀 (lifecycle / bootstrap header bullet),
  // ⏳ (waiting / pending state bullet).
  "⏰",
  "📋",
  "🩹",
  "💓",
  "🚀",
  "⏳",
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
  const whatsNew = opts.whatsNew ?? [];
  const verdict = opts.verdict ?? "";
  const sectionBulletCount = sections.reduce((a, s) => a + s.bullets.length, 0);
  const total = flat.length + sectionBulletCount + whatsNew.length + (verdict.length > 0 ? 1 : 0);
  if (total === 0) {
    throw new DiscordWebhookError({
      template: opts.template,
      detail: "empty body — at least one of {verdict, bullets, sections, whatsNew} required",
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
  // whatsNew bullets have a length check but no emoji-prefix requirement —
  // they're prose-grade, not emoji-prefixed. See DiscordSendOpts.whatsNew docs.
  for (let i = 0; i < whatsNew.length; i++) {
    const gs = graphemes(whatsNew[i] ?? "");
    if (gs.length === 0) {
      throw new DiscordWebhookError({
        template: opts.template,
        detail: `whatsNew[${i}] is empty`,
      });
    }
    if (gs.length > MAX_BULLET_GRAPHEMES) {
      throw new DiscordWebhookError({
        template: opts.template,
        detail: `whatsNew[${i}] too long: ${gs.length} graphemes (max ${MAX_BULLET_GRAPHEMES})`,
      });
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
  const whatsNew = opts.whatsNew ?? [];

  // 1. Verdict line first — single load-bearing field per CLAUDE.md spec.
  if (opts.verdict !== undefined && opts.verdict.length > 0) {
    lines.push(opts.verdict);
  }

  // 2. Flat bullets (legacy shape) — pushed under verdict if both present.
  if (flat.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...flat);
  }

  // 3. Sectioned body (legacy shape) — each section gets its bold label + bullets.
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    if (!sec) continue;
    if (lines.length > 0) lines.push("");
    lines.push(`**${sec.label}**`);
    lines.push(...sec.bullets);
  }

  // 4. "✨ What's new" — milestone-grade bullets, prose-grade (no emoji prefix).
  if (whatsNew.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("**✨ What's new**");
    for (const b of whatsNew) lines.push(`- ${b}`);
  }

  // 5. Footer — single line, 📍-prefixed, ambient liveness pointer.
  if (opts.footer !== undefined && opts.footer.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`📍 ${opts.footer}`);
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

/**
 * Send a Discord message per ADR-008.
 *
 * Posts each chunk via bun-native `fetch` against the resolved webhook URL
 * (`webhookOverride` > `ATMUX_DISCORD_WEBHOOK`). The earlier
 * `ping-discord.sh` spawn route was dropped — the script was never present
 * on disk in this deploy and the direct-fetch path was already serving every
 * tick (see ADR-008 §"Routing").
 *
 * @throws DiscordWebhookError on validation failure, network failure, or
 *         non-2xx response.
 * @throws ConfigError when no webhook is resolvable.
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
    await directFetch(c, opts.template, opts.webhookOverride);
  }
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
      hint: "set ATMUX_DISCORD_WEBHOOK",
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
 * env directly today — `resolveWebhookUrl` is the canonical resolution
 * helper for verbs that need to surface webhook state to the user.
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
export function renderEternalImprovementStart(opts: EternalImprovementStartOpts): DiscordSendOpts {
  const out: DiscordSendOpts = {
    template: "eternal-improvement-start",
    team: opts.team,
    category: "🌱",
    verdict: `🟢 **Shipping** — eternal-improvement run starting on ${formatTokens(opts.budgetTotal)} tokens (${opts.mode})`,
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
    verdict: `🟢 **Shipping** — cycle ${opts.cycleN} closed, ${opts.tasksShipped} task${opts.tasksShipped === 1 ? "" : "s"} shipped`,
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
export function renderEternalImprovementDone(opts: EternalImprovementDoneOpts): DiscordSendOpts {
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
  const verdict = opts.modeB
    ? `🟡 **Cool** — eternal-improvement Mode B halted after ${opts.cycleCount} cycle${opts.cycleCount === 1 ? "" : "s"}`
    : `🟢 **Shipping** — eternal-improvement complete: ${opts.cycleCount} cycle${opts.cycleCount === 1 ? "" : "s"}, ${opts.totalTasksShipped} task${opts.totalTasksShipped === 1 ? "" : "s"}`;
  const out: DiscordSendOpts = {
    template: "eternal-improvement-done",
    team: opts.team,
    category: "🌱",
    verdict,
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
  const verdict = opts.catastrophic
    ? `🟡 **Cool** — team.json malformed, using full safe defaults`
    : `🟡 **Cool** — team.json::whip validation failed, using safe defaults`;
  const bullets: string[] = [
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
    verdict,
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
  const n = opts.atRisk.length;
  const verdict = `🔴 **Stalled** — team paused on rate-limit, ${n} at-risk member${n === 1 ? "" : "s"}`;
  const memberBullets = opts.atRisk.map((r) => `🪫 ${r.member} — 5h ${r.h5}% / wk ${r.wk}%`);
  const bullets: string[] = [
    ...memberBullets,
    `🛑 no new dispatches until refresh`,
    `🔁 resume gate: all members > ${opts.resumeThresholdPct}% remaining on 5h AND wk`,
  ];
  const out: DiscordSendOpts = {
    template: "whip-budget-pause",
    team: opts.team,
    category: "🛑",
    verdict,
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
    verdict: `🟢 **Shipping** — budget resumed, team OK to dispatch`,
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
    verdict: `🟡 **Idle** — budget warning on \`${opts.account}\` ${opts.window} (${bandPct}% band crossed)`,
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
export function renderWhipBudgetRefreshSoon(opts: BudgetRefreshSoonDiscordOpts): DiscordSendOpts {
  const bullets: string[] = [
    `⏱️ window resets in: ${opts.resetsIn} (${opts.window})`,
    `💰 account: \`${opts.account}\` — remaining: ${opts.remainingPct}%`,
  ];
  if (opts.pausedNow) {
    bullets.push(`🔁 will auto-resume on refresh`);
  }
  const verdict = opts.pausedNow
    ? `🟡 **Cool** — paused on \`${opts.account}\`, ${opts.window} refreshes in ${opts.resetsIn}`
    : `🟡 **Cool** — \`${opts.account}\` ${opts.window} refreshes in ${opts.resetsIn}`;
  const out: DiscordSendOpts = {
    template: "whip-budget-refresh-soon",
    team: opts.team,
    category: "🌅",
    verdict,
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
    verdict: `🟡 **Cool** — swapping ${opts.candidates} member${opts.candidates === 1 ? "" : "s"} off \`${opts.triggerAccount}\` (at ${opts.triggerPct}% ${opts.triggerWindow})`,
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
    verdict: `🟢 **Shipping** — \`${opts.fromMember}\` swapped to \`${opts.toAccount}\` (${opts.progressDone}/${opts.progressTotal})`,
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
    verdict: `🔴 **Stalled** — \`${opts.member}\` swap aborted (${opts.failureBrief})`,
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
export function renderAccountSwapPassComplete(opts: AccountSwapPassCompleteOpts): DiscordSendOpts {
  const out: DiscordSendOpts = {
    template: "whip-account-swap-pass-complete",
    team: opts.team,
    category: "🔄",
    verdict: `🟢 **Shipping** — swap pass complete, ${opts.swapped} swapped / ${opts.aborted} aborted`,
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
  const n = opts.stale.length;
  const verdict = `🔴 **Stalled** — ${n} member${n === 1 ? "" : "s"} silent for >${formatDuration(opts.staleSec * 1000)}`;
  const bullets: string[] = [];
  for (const s of opts.stale) {
    const ageStr = s.ageSec === null ? "never" : formatDuration(s.ageSec * 1000);
    bullets.push(`📍 ${s.member}: ${ageStr} stale`);
  }
  bullets.push("🛠️ fix: check pane state + restart member if needed");
  const out: DiscordSendOpts = {
    template: "whip-watchdog",
    team: opts.team,
    category: "🛑",
    verdict,
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
export function renderWhipSelfHealAttempt(opts: WhipSelfHealAttemptOpts): DiscordSendOpts {
  const out: DiscordSendOpts = {
    template: "whip-self-heal-attempt",
    team: opts.team,
    category: "🔧",
    verdict: `🟡 **Cool** — self-heal attempt for \`${opts.recipeId}\``,
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
export function renderWhipSelfHealResult(opts: WhipSelfHealResultOpts): DiscordSendOpts {
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
  const verdict = opts.ok
    ? `🟢 **Shipping** — self-heal \`${opts.recipeId}\` patched, pending reviewer`
    : `🔴 **Stalled** — self-heal \`${opts.recipeId}\` failed, operator triage needed`;
  const out: DiscordSendOpts = {
    template: "whip-self-heal-result",
    team: opts.team,
    category: "🔧",
    verdict,
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
  const n = opts.drifted.length;
  const bullets: string[] = [];
  for (const d of opts.drifted) {
    bullets.push(`🟡 ${d.member}: pane in '${d.mode}' mode (expected 'auto')`);
  }
  bullets.push("🛠️ fix: BTab cycle to auto on each drifted pane");
  const out: DiscordSendOpts = {
    template: "whip-perm-mode-drift",
    team: opts.team,
    category: "📋",
    verdict: `🟡 **Cool** — ${n} member${n === 1 ? "" : "s"} drifted off auto-mode, fixable via BTab`,
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
  const n = opts.defunct.length;
  const verdict = `🚨 **Need you** — ${n} member${n === 1 ? "" : "s"} on defunct cwd, dispatch broken`;
  const bullets: string[] = [];
  for (const d of opts.defunct) {
    bullets.push(`📍 ${d.member}: cwd ${d.cwd} does not exist`);
  }
  bullets.push("🛠️ fix: re-spawn member or restore worktree path");
  const out: DiscordSendOpts = {
    template: "whip-defunct-cwd",
    team: opts.team,
    category: "🛑",
    verdict,
    bullets,
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

// ---------- ADR-137 — renderMemberForcePushWarning ----------

export interface MemberForcePushWarningMember {
  /** Member name whose per-member branch surfaced the recent
   *  force-push reflog entry. */
  member: string;
  /** Branch name (typically `<base>-<member>`) carrying the
   *  force-push event. */
  branch: string;
  /** Short reflog message (one line, ≤80 char — truncated upstream). */
  reflogMsg: string;
}

export interface MemberForcePushWarningOpts {
  team: string;
  /** Members + branches that surfaced the doctor probe. */
  events: ReadonlyArray<MemberForcePushWarningMember>;
  whenMs?: number;
}

/**
 * Build the `[member-forcepush-warning]` Discord send opts per
 * ADR-137 §D3. Warn-class (🟡 Cool) — the harness force-push deny
 * rule remains the actual gate; this template is the post-hoc
 * surface for force-pushes that DID land (operator authorized via
 * the prompt, OR the deny rule wasn't engaged because the worktree
 * was outside its scope).
 *
 * Composition:
 *   - Verdict: `🟡 **Cool** — N member(s) force-pushed in last hour`
 *   - Bullet per affected member: `🟡 <member>: <branch> reflog: <msg>`
 *   - Fix bullet: `🛠️ fix: use \`git merge origin/<base>\` for trunk integration (ADR-137 §D1)`
 *
 * Dedup state lives at `<atmuxDir>/state/member-forcepush-dedup-state.json`
 * keyed on `<team>:<branch>` with a 30min window — the doctor probe
 * itself is live-not-cached (re-fires every tick if reflog still
 * matches), but the Discord ping is dedup'd so a single force-push
 * doesn't ping every tick for 12 ticks.
 */
export function renderMemberForcePushWarning(
  opts: MemberForcePushWarningOpts,
): DiscordSendOpts {
  const n = opts.events.length;
  const verdict = `🟡 **Cool** — ${n} member${n === 1 ? "" : "s"} force-pushed within the last hour`;
  const bullets: string[] = [];
  for (const e of opts.events) {
    const short = e.reflogMsg.length > 40 ? `${e.reflogMsg.slice(0, 40)}…` : e.reflogMsg;
    bullets.push(`🟡 ${e.member}: ${e.branch} reflog: ${short}`);
  }
  bullets.push("🛠️ fix: use `git merge origin/<base>` for trunk integration (ADR-137 §D1)");
  const out: DiscordSendOpts = {
    template: "member-forcepush-warning",
    team: opts.team,
    category: "📋",
    verdict,
    bullets,
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

// ---------- ADR-138 T3 — renderSendKeysFailureWarning ----------

export interface SendKeysFailureWarningOpts {
  team: string;
  /** Number of failures observed within the doctor probe's window
   *  (default 1h). Mirrors the `recentCount` returned in the YELLOW
   *  row's `detail`. */
  failureCount: number;
  /** tmux target string of the most-recent failure (`session:window`
   *  or pane id). Surfaced as a footer-style bullet so the operator
   *  knows which member to investigate first. Empty string when the
   *  log was malformed at the `target=` field — bullet is then
   *  omitted. */
  mostRecentTarget?: string;
  /** Minutes since the most-recent failure entry. Rendered when set;
   *  surfaces freshness so the operator can tell whether this is an
   *  active stall vs lingering tail of a now-recovered burst. */
  mostRecentAgeMin?: number;
  whenMs?: number;
}

/**
 * Build the `[send-keys-failure]` Discord send opts per ADR-138 T1's
 * template format. Warn-class (🟡 Cool) — the calling verb has already
 * decided "this send-keys didn't verify"; the Discord ping is the
 * post-hoc surface so the team-lead / driver sees that send-keys is
 * unreliable on at least one member pane.
 *
 * Composition:
 *   - Verdict: `🟡 **Cool** — N send-keys failure(s) in last hour`
 *   - Bullet (target): `🟡 last: <target> (Nmin ago)` — omitted when
 *     `mostRecentTarget` is empty
 *   - Fix bullet: `🛠️ fix: check ADR-138 escalation log at
 *     ~/.atmux/state/send-keys-failures.log`
 *
 * Companion to the `checkSendKeysFailureRecent` doctor probe in
 * `src/verbs/doctor.ts` — same Yellow / same window / same root
 * artifact (the escalation log written by `safeSendKeysWithVerify`'s
 * escalation path).
 */
export function renderSendKeysFailureWarning(
  opts: SendKeysFailureWarningOpts,
): DiscordSendOpts {
  const n = opts.failureCount;
  const verdict = `🟡 **Cool** — ${n} send-keys failure${n === 1 ? "" : "s"} within the last hour`;
  const bullets: string[] = [];
  if (typeof opts.mostRecentTarget === "string" && opts.mostRecentTarget.length > 0) {
    const ageSuffix =
      typeof opts.mostRecentAgeMin === "number" && opts.mostRecentAgeMin >= 0
        ? ` (${opts.mostRecentAgeMin}min ago)`
        : "";
    bullets.push(`🟡 last: ${opts.mostRecentTarget}${ageSuffix}`);
  }
  bullets.push(
    "🛠️ fix: check ADR-138 escalation log at `~/.atmux/state/send-keys-failures.log`",
  );
  const out: DiscordSendOpts = {
    template: "send-keys-failure",
    team: opts.team,
    category: "📋",
    verdict,
    bullets,
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

// ---------- ADR-086 — renderPulseVerdict ----------

/** Closed verdict-literal set the renderer accepts. Mirrors the
 *  PulseVerdict union in `core/pulse-verdict.ts` — kept duplicated here
 *  so this module stays domain-agnostic (no import from core/*). */
export type PulseVerdictLiteral =
  | "🟢 Shipping"
  | "🟡 Cool"
  | "🟡 Idle"
  | "🔴 Stalled"
  | "🚨 Need you";

export interface PulseVerdictOpts {
  team: string;
  /** Pre-computed verdict (e.g. `"🟢 Shipping"`). */
  verdict: PulseVerdictLiteral;
  /** One-line operator-readable body sentence — composed by core's
   *  `describeVerdict` so the branch-to-string mapping stays
   *  co-located with the branch logic. ≤80 chars (verdict-line
   *  budget per CLAUDE.md §Discord). */
  body: string;
  /** Commits observed in the window. Surfaced as a footer pointer. */
  commitCount: number;
  /** Kanban inProgress count. Surfaced as a footer pointer. */
  inProgressCount: number;
  /** Open driver-inbox entry count (any age). Surfaced as a footer
   *  pointer when > 0. */
  driverInboxOpen: number;
  /** Reason string from `shouldFire` — surfaced as a small footer
   *  hint ("transition" / "sustained-urgency" / "first-observation").
   *  When `"deduped"`, the renderer should never be invoked; we treat
   *  it as a programmer error and surface the label anyway. */
  fireReason: "first-observation" | "transition" | "sustained-urgency" | "deduped";
  /** Window minutes used for the cadence number in the footer. */
  windowMin: number;
  whenMs?: number;
}

// ---------- ADR-077 §F6 — renderSelfHealFailed ----------

export interface SelfHealFailedOpts {
  team: string;
  /** One-line symptom — what stayed broken after the attempts. The
   *  skill composes this from the complaint's `incident_summary`. */
  symptom: string;
  /** Count of failed attempts on this complaint hash. The escalation
   *  trigger is N=3 (per ADR-077 §F6); the renderer surfaces the
   *  actual count so a 4th failure that beats dedup still reads
   *  correctly. */
  attempts: number;
  /** Active member count the proposed restart would clear. Surfaced
   *  in option A so the operator sees the blast radius. */
  members: number;
  /** Current account label (e.g. `personal`, `icloud`). Option B
   *  proposes swapping AWAY from this. Null when account info is
   *  unavailable; the option renders without a `from`. */
  fromAccount: string | null;
  /** Proposed swap target (e.g. `icloud`). Same nullability semantics
   *  as `fromAccount`. */
  toAccount: string | null;
  /** Open complaint count for the team — footer signal. */
  complaintsOpen: number;
  /** Whip-strike accumulator from the skill's tracking — footer signal. */
  whipStrikes: number;
  whenMs?: number;
}

/**
 * Build the `[pulse-verdict]` Discord send opts per ADR-086 Phase 1.
 *
 * Header emoji is chosen per-verdict — 💓 for 🟢 Shipping (heartbeat),
 * 📊 for 🟡 Cool / 🟡 Idle (status-ish), 🛑 for 🔴 Stalled, 🚨 for
 * 🚨 Need you. All four are present in `CategoryEmoji`.
 *
 * Body is verdict-only (single load-bearing line) with a 📍 footer
 * carrying ambient liveness. No bullets / sections — keep the message
 * scannable on mobile per the verdict-first spec.
 */
export function renderPulseVerdict(opts: PulseVerdictOpts): DiscordSendOpts {
  const category = pulseCategoryFor(opts.verdict);
  const footerParts: string[] = [
    `${opts.commitCount} commit${opts.commitCount === 1 ? "" : "s"} in ${opts.windowMin}min`,
    `${opts.inProgressCount} inProgress`,
  ];
  if (opts.driverInboxOpen > 0) {
    footerParts.push(`${opts.driverInboxOpen} inbox`);
  }
  footerParts.push(`fire: ${opts.fireReason}`);
  const out: DiscordSendOpts = {
    template: "pulse-verdict",
    team: opts.team,
    category,
    verdict: opts.body,
    footer: footerParts.join(" · "),
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

function pulseCategoryFor(verdict: PulseVerdictLiteral): CategoryEmoji {
  switch (verdict) {
    case "🟢 Shipping":
      return "💓";
    case "🟡 Cool":
    case "🟡 Idle":
      return "📊";
    case "🔴 Stalled":
      return "🛑";
    case "🚨 Need you":
      return "🚨";
  }
}

// ---------- ADR-085 §Three surfaces #2 [whip-needs-approval] ----------

/** Per-entry input shape — mirrors `NeedsApprovalEntry` from
 *  `src/lib/needs-approval.ts` without an import cycle (abstractions
 *  must not import from src/lib/* per ADR-003). The lib's report shape
 *  is structurally compatible; the verb hands us individual entries. */
export interface NeedsApprovalRendererEntry {
  id: string;
  subject: string;
  ageMin: number;
}

export interface WhipNeedsApprovalOpts {
  team: string;
  /** Proposed-ADR bucket entries. Empty array = section dropped. */
  adr: ReadonlyArray<NeedsApprovalRendererEntry>;
  /** Untriaged driver-inbox entries. Empty array = section dropped. */
  inbox: ReadonlyArray<NeedsApprovalRendererEntry>;
  /** Long-blocked kanban entries. Empty array = section dropped. */
  kanban: ReadonlyArray<NeedsApprovalRendererEntry>;
  /** Optional test override of the wall-clock — drives footer + chunk
   *  splits identically to other renderers. */
  whenMs?: number;
}

/** ADR-085 OQ2: hard-cap per bucket. Overflow surfaces as "+N more"
 *  tail per the recommended default — driver reaches for
 *  `atmux status --json | jq .needsApproval` for the full list. */
const NEEDS_APPROVAL_PER_BUCKET_MAX = 5;

/**
 * Build the `[whip-needs-approval]` Discord send opts per CLAUDE.md
 * §Discord message format §6.
 *
 * Caller (whip §2.5) gates emission on `total > 0` — passing a zero-
 * total report through this renderer still produces a valid payload
 * (header + verdict + footer; bullets all empty), but callers
 * shouldn't ship that to Discord. The skip-zero gate lives at the
 * call site, NOT here, so tests of the renderer aren't tangled with
 * call-site policy.
 *
 * Sections in fixed order — ADR / Inbox / Kanban — matching ADR-085
 * §Three surfaces #2. Empty buckets render as label-less skips (no
 * `**Proposed ADRs (0)**` waste).
 */
export function renderWhipNeedsApproval(opts: WhipNeedsApprovalOpts): DiscordSendOpts {
  const total = opts.adr.length + opts.inbox.length + opts.kanban.length;
  const sections: DiscordSection[] = [];
  if (opts.adr.length > 0) {
    sections.push({
      label: `📋 **Proposed ADRs (${opts.adr.length})**`,
      bullets: makeBucketBullets(opts.adr),
    });
  }
  if (opts.inbox.length > 0) {
    sections.push({
      label: `⏳ **Untriaged asks (${opts.inbox.length})**`,
      bullets: makeBucketBullets(opts.inbox),
    });
  }
  if (opts.kanban.length > 0) {
    sections.push({
      label: `🛑 **Blocked tasks (${opts.kanban.length})**`,
      bullets: makeBucketBullets(opts.kanban),
    });
  }
  const out: DiscordSendOpts = {
    template: "whip-needs-approval",
    team: opts.team,
    category: "📋",
    verdict: `📋 ${total} item${total === 1 ? "" : "s"} awaiting triage`,
    sections,
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

/** Render up to NEEDS_APPROVAL_PER_BUCKET_MAX bullets + an overflow
 *  `+N more` tail when the bucket has more. Each bullet is
 *  bullet80-truncated AND emoji-prefixed with 📍 (allowed per ALLOWED_
 *  BULLET_PREFIX) so the validator accepts it. ageMin formatted via
 *  the shared compact-duration grammar (CLAUDE.md §Duration formatting). */
function makeBucketBullets(
  entries: ReadonlyArray<NeedsApprovalRendererEntry>,
): ReadonlyArray<string> {
  const visible = entries.slice(0, NEEDS_APPROVAL_PER_BUCKET_MAX);
  const bullets: string[] = [];
  for (const e of visible) {
    bullets.push(naBullet80(`📍 ${formatAge(e.ageMin)} · ${e.subject}`));
  }
  if (entries.length > NEEDS_APPROVAL_PER_BUCKET_MAX) {
    const overflow = entries.length - NEEDS_APPROVAL_PER_BUCKET_MAX;
    bullets.push(`📍 +${overflow} more`);
  }
  return bullets;
}

/** Compact-duration formatter matching CLAUDE.md §Duration formatting:
 *  <60min → `Nmin`; ≥60min → `HhMm` or `Hh` on the hour. */
function formatAge(ageMin: number): string {
  if (ageMin < 60) return `${ageMin}min`;
  const hours = Math.floor(ageMin / 60);
  const rem = ageMin % 60;
  return rem === 0 ? `${hours}h` : `${hours}h${rem}m`;
}

/** Inline 80-grapheme truncation — same shape as the bullet80 helper
 *  exported from whip.ts but kept here to avoid a discord → whip import
 *  cycle (per ADR-003 abstractions must not import from verbs). Reuses
 *  the module-private GRAPHEME_SEG segmenter declared near `graphemes()`. */
function naBullet80(s: string): string {
  const max = 80;
  const segs: string[] = [];
  for (const seg of GRAPHEME_SEG.segment(s)) segs.push(seg.segment);
  if (segs.length <= max) return s;
  return `${segs.slice(0, max - 1).join("")}…`;
}

/**
 * Build the `[self-heal-failed]` Discord send opts per ADR-077 §F6.
 * Verdict-first, milestone-grade, ask-loudly per CLAUDE.md §Discord —
 * the operator should be able to reply with a single letter from a
 * phone and have the skill apply the named action.
 *
 * Bullets:
 *   - `🚨 self-heal failed: <symptom> — N=<attempts> attempts`
 *   - `🙏 reply A/B/C — one letter pivots cheaply`
 *   - `🛠️ A) /team stop + start <team> — restarts <members> member(s) ~30s`
 *   - `🔁 B) swap account <from> → <to> — wk budget reset` (or generic
 *     swap line when account labels are unavailable)
 *   - `⏳ C) park <team> for the night — re-engage at session start`
 *   - `⏰ default at <HH:MM MYT>: A — cheap to pivot if you redirect`
 *   - `📍 <complaintsOpen> open · <whipStrikes> strikes`
 *
 * The "default at HH:MM MYT" deadline is 30 minutes after the ping's
 * own timestamp — gives the operator enough phone-time to triage
 * without sitting on a broken team overnight. Derived from `whenMs`
 * (or `now()`) so test injection threads through cleanly.
 */
export function renderSelfHealFailed(opts: SelfHealFailedOpts): DiscordSendOpts {
  const whenMs = opts.whenMs ?? now();
  const defaultAtMs = whenMs + 30 * 60 * 1000;
  const swapLine =
    opts.fromAccount !== null && opts.toAccount !== null
      ? `🔁 B) swap account ${opts.fromAccount} → ${opts.toAccount} — wk budget reset`
      : "🔁 B) swap account — wk budget reset";
  const bullets: string[] = [
    `🚨 self-heal failed: ${opts.symptom} — N=${opts.attempts} attempts`,
    "🙏 reply A/B/C — one letter pivots cheaply",
    `🛠️ A) /team stop + start ${opts.team} — restarts ${opts.members} member(s) ~30s`,
    swapLine,
    `⏳ C) park ${opts.team} for the night — re-engage at session start`,
    `⏰ default at ${formatMyt(defaultAtMs)}: A — cheap to pivot if you redirect`,
    `📍 ${opts.complaintsOpen} open · ${opts.whipStrikes} strikes`,
  ];
  const out: DiscordSendOpts = {
    template: "self-heal-failed",
    team: opts.team,
    category: "🚨",
    bullets,
    whenMs,
  };
  return out;
}

// ---------- t-351318dc — renderMetaWatchdog ----------

export interface MetaWatchdogOpts {
  /** Cockpit identifier — code-formatted in header. The probe is
   *  cockpit-scoped (one superdoctor across all teams), so we surface
   *  the cockpit name here rather than a team. */
  cockpit: string;
  /** Aggregate count of open complaints across every cockpit-enabled
   *  team's complaint box. The dormancy gate is `> 0`. */
  openComplaints: number;
  /** Seconds since the latest `superdoctor_attempts.attempted_at` row
   *  across every cockpit-enabled team. Null when no attempt rows
   *  exist anywhere (cold cockpit — superdoctor never acted). */
  dormantSec: number | null;
  /** Brief one-line summary of the oldest open complaint — surfaces
   *  in the footer so the operator can triage on phone without
   *  opening the cockpit. Empty string when no complaints exist
   *  (degenerate; shouldn't happen given the dormancy gate). */
  oldestComplaintSummary: string;
  /** Team that owns the oldest open complaint — also surfaced in the
   *  footer. Empty string when no complaints. */
  oldestComplaintTeam: string;
  /** Age of the oldest open complaint, in seconds. */
  oldestComplaintAgeSec: number;
  whenMs?: number;
}

/**
 * Build the `[meta-watchdog]` Discord send opts per t-351318dc.
 * Verdict-first, milestone-grade, ask-loudly per CLAUDE.md §Discord —
 * one letter (A or B) from a phone resolves the page.
 *
 * Bullets:
 *   - `🚨 superdoctor dormant — <N> open complaints, no attempts in <Hh:Mm>`
 *     (or `... no attempts on record` when `dormantSec === null`)
 *   - `🙏 reply A/B — one letter pivots cheaply`
 *   - `🛠️ A) check superdoctor pane (cockpit w2) — likely saturated / wedged`
 *   - `♻️ B) restart superdoctor — kill+respawn`
 *   - `⏰ default at <HH:MM MYT>: A — cheap to pivot if you redirect`
 *   - `📍 oldest: <team> · <summary> · <Hh:Mm> ago`
 *
 * Default deadline is +30min (same operator-window as
 * `renderSelfHealFailed`) — phone-triage time without sitting on
 * a broken cockpit overnight.
 */
export function renderMetaWatchdog(opts: MetaWatchdogOpts): DiscordSendOpts {
  const whenMs = opts.whenMs ?? now();
  const defaultAtMs = whenMs + 30 * 60 * 1000;
  const dormantStr =
    opts.dormantSec === null ? "no attempts on record" : `no attempts in ${formatDuration(opts.dormantSec * 1000)}`;
  const oldestAge = formatDuration(opts.oldestComplaintAgeSec * 1000);
  const bullets: string[] = [
    `🚨 superdoctor dormant — ${opts.openComplaints} open complaints, ${dormantStr}`,
    "🙏 reply A/B — one letter pivots cheaply",
    "🛠️ A) check superdoctor pane (cockpit w2) — likely saturated / wedged",
    "♻️ B) restart superdoctor — kill+respawn",
    `⏰ default at ${formatMyt(defaultAtMs)}: A — cheap to pivot if you redirect`,
    `📍 oldest: ${opts.oldestComplaintTeam} · ${opts.oldestComplaintSummary} · ${oldestAge} ago`,
  ];
  const out: DiscordSendOpts = {
    template: "meta-watchdog",
    team: opts.cockpit,
    category: "🚨",
    bullets,
    whenMs,
  };
  return out;
}

// ---------- ADR-131 §D5 T5 — renderHygieneBlocker ----------
//
// **Sibling-branch type-dep**: `HygieneFingerprintClass` is canonical
// in `src/core/superdoctor-hygiene/_shared.ts` (landed in T2 commit
// 38a9338 on geoyws-parity-state-impl, not yet on this worktree's
// trunk). Per the no-self-merge policy (2026-05-14 16:40 MYT pivot,
// memory `feedback_atmux_no_gitter_worker_commits`), this file
// re-declares the same literal-union as a LOCAL type — the drain-
// loop call site in T3 holds the cross-module type alignment when
// gitter merges the branches. Adding a new fingerprint class
// requires editing BOTH this literal-union AND the canonical one
// in `_shared.ts` in lockstep.
//
// Layering note: abstractions/ MUST NOT import from core/ per
// ADR-003. Even after gitter fan-in, this stays a local literal-
// union to preserve the direction.

/** Local mirror of `src/core/superdoctor-hygiene/_shared.ts`'s
 *  `HygieneFingerprintClass`. See block-comment above for the
 *  lockstep-update rule. */
export type HygieneFingerprintClass =
  | "ghost-owner"
  | "lane-mismatch"
  | "role-mismatch"
  | "lane-null-orphan"
  | "prio-null";

/** Optional ask block — emitted only when the drain loop's refuse-
 *  and-ask escape triggered (§D3 rule 4: zero deterministic
 *  candidates). Caller composes the question + 2-3 lettered
 *  options + the recommended default tagged with a silent-default
 *  deadline (MYT). */
export interface HygieneBlockerNeedFromGeorge {
  /** One-line ask (≤60 graphemes for the on-bullet shape — the
   *  validator caps at 80 across the board; 60 leaves headroom for
   *  the `🙏 ` prefix). */
  question: string;
  /** 2-3 lettered options (`"A) reassign manually"`, `"B) leave wedged"`).
   *  Optional — when omitted, only the question + default-deadline
   *  pair renders. */
  options?: ReadonlyArray<string>;
  /** Recommended default option text — referenced in the
   *  silent-default line as `**Default at <deadline> if silent:**
   *  <default>`. */
  default: string;
  /** MYT-formatted deadline (e.g. `"HH:MM MYT"`) at which the
   *  default applies if no operator response. The renderer does
   *  NOT compute this — caller composes per the drain-loop's tick
   *  budget. */
  deadline: string;
}

export interface HygieneBlockerOpts {
  team: string;
  /** Wedged kanban task id (e.g. `"t-aaaa1111"`). Rendered inside
   *  backticks in the verdict line. */
  taskId: string;
  /** Hygiene fingerprint class — surfaces in the verdict line's
   *  root-cause clause via the canonical human-readable label. */
  fingerprintClass: HygieneFingerprintClass;
  /** Minutes the wedge has persisted. ADR-131 §D5 caller-side gate:
   *  >=240 (4h) is the threshold for Discord surfacing. Compact-
   *  duration grammar (CLAUDE.md §Duration formatting) used for
   *  the verdict-line rendering. */
  wedgedMin: number;
  /** Human-readable description of the fix superdoctor wants to
   *  apply (or already applied). Surfaces as the single ✨ What's
   *  new milestone — prose-grade ≤80 graphemes, no emoji prefix. */
  proposedFix: string;
  /** Monotonic tick counter (ADR-077 §D3 hourly-tick id). Surfaced
   *  in the footer so operator can correlate across ticks. */
  superdoctorTick: number;
  /** Count of hygiene fixes applied this tick across all teams.
   *  Operator-side density signal: high values = busy hygiene cycle. */
  fixesThisTick: number;
  /** Count of complaints filed this tick (ADR-077 §D5 complaint box).
   *  Independent counter; not necessarily ==`fixesThisTick`. */
  complaintsFiled: number;
  /** Optional ask block — supplied when refuse-and-ask escape
   *  triggered. Absent ⇒ pure-blocker shape (no Need-from-George
   *  section); the wedge is still surfaced for operator awareness. */
  needFromGeorge?: HygieneBlockerNeedFromGeorge;
  whenMs?: number;
}

/** Canonical human-readable label per fingerprint class. Surfaces in
 *  the verdict-line root-cause clause. Co-located here (not in the
 *  detector files) because the wording is Discord-output-shaped — it
 *  belongs with the renderer, not the detection logic. */
const HYGIENE_CLASS_LABEL: Record<HygieneFingerprintClass, string> = {
  "ghost-owner": "owner not in roster",
  "lane-mismatch": "owner lane ≠ task lane",
  "role-mismatch": "non-execution role on execution task",
  "lane-null-orphan": "lane=null orphan",
  "prio-null": "priority unset",
};

/**
 * Build the `[hygiene-blocker]` Discord send opts per ADR-131 §D5.
 *
 * **Caller-side gate** (drain loop in T3): emission fires ONLY when
 *
 *   1. severity === P0 (ghost-owner zero-candidates / lane-mismatch P0)
 *   2. wedgedMin >= 240 (4h wedge threshold)
 *   3. refuse-and-ask escape triggered (zero deterministic candidates
 *      per §D3 rule 4)
 *
 * The renderer enforces NONE of these — passing a payload that fails
 * the call-site gates still produces a valid `DiscordSendOpts`, so
 * tests can exercise the renderer in isolation without simulating
 * the drain-loop policy.
 *
 * Body shape per ADR-131 §D5:
 *
 *   - Header: 🔧 [hygiene-blocker] · `{team}` · HH:MM MYT
 *   - Verdict: 🔴 Stalled — \`{taskId}\` wedged {duration}, {label}
 *   - ✨ What's new: 1 bullet — `proposedFix`
 *   - 🙏 Need from George (only when `needFromGeorge` present):
 *       question + lettered options + silent-default line
 *   - 📍 footer: `superdoctor tick #N · K fixes applied · C complaints`
 */
export function renderHygieneBlocker(opts: HygieneBlockerOpts): DiscordSendOpts {
  const duration = formatDuration(opts.wedgedMin * 60_000);
  const label = HYGIENE_CLASS_LABEL[opts.fingerprintClass];
  const verdict = `🔴 **Stalled** — \`${opts.taskId}\` wedged ${duration}, ${label}`;

  // ✨ What's new — single milestone bullet (prose-grade, no emoji prefix).
  const whatsNew: string[] = [opts.proposedFix];

  // 🙏 Need from George — optional section. Bullets ARE emoji-prefixed
  // (sections use the emoji-prefix validator), so each bullet leads
  // with 🙏 / 🛠️ / 📍 per the ALLOWED_BULLET_PREFIX set.
  const sections: DiscordSection[] = [];
  if (opts.needFromGeorge !== undefined) {
    const nfg = opts.needFromGeorge;
    const bullets: string[] = [`🙏 ${nfg.question}`];
    if (nfg.options !== undefined) {
      for (const opt of nfg.options) {
        bullets.push(`📍 ${opt}`);
      }
    }
    bullets.push(`📍 **Default at ${nfg.deadline} if silent:** ${nfg.default}`);
    sections.push({
      label: "🙏 **Need from George** (zero deterministic candidates)",
      bullets,
    });
  }

  const footer =
    `superdoctor tick #${opts.superdoctorTick} · ` +
    `${opts.fixesThisTick} fixes applied · ` +
    `${opts.complaintsFiled} complaints`;

  const out: DiscordSendOpts = {
    template: "hygiene-blocker",
    team: opts.team,
    category: "🔧",
    verdict,
    whatsNew,
    footer,
  };
  if (sections.length > 0) out.sections = sections;
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}

// ---------- ADR-142 §D4 — renderWhipModalCycling ----------

export interface WhipModalCyclingSeen {
  /** Coarse modal class label — `choice-prompt` / `numbered-prompt` /
   *  `confirm-prompt` / `enter-prompt`. */
  modalClass: string;
  /** First line of the modal text, truncated for the bullet (the full
   *  modalText already lives on disk in modal-history-<member>.json). */
  firstLine: string;
}

export interface WhipModalCyclingOpts {
  team: string;
  /** Cycling member. */
  member: string;
  /** Member's currently-claimed task id — surfaced in the verdict so
   *  operator can correlate the cycling with kanban state. */
  taskId: string;
  /** Distinct modal-class count within the window. */
  distinctCount: number;
  /** Window size in minutes (matches `modalCycling.windowMin`). */
  windowMin: number;
  /** Last 3 modals observed within the window — renderer truncates if
   *  caller passes more. */
  modalsSeen: ReadonlyArray<WhipModalCyclingSeen>;
  whenMs?: number;
}

/**
 * Build the `[whip-modal-cycling]` Discord send opts per ADR-142 §D4.
 *
 * Verdict: `🟡 Modal-cycling — <member> thrashed N modal-classes in
 *           Wmin, 0 commits on claimed <taskId>`.
 *
 * Bullets (last-3 modals truncated to 80 graphemes each):
 *   - `📋 <modalClass>: <first-line-truncated>` per modal
 *   - `🙏 Auto-action — clarifier dispatched + flag filed`
 *   - `📍 detector fires once per 30min dedup window`
 *
 * Category emoji `🔄` — sibling to ADR-056's lifecycle headers; the
 * modal-cycling event is a re-classification of the member, same
 * "circling back" visual semantic.
 */
export function renderWhipModalCycling(opts: WhipModalCyclingOpts): DiscordSendOpts {
  const verdict = `🟡 **Modal-cycling** — \`${opts.member}\` thrashed ${opts.distinctCount} modal-classes in ${opts.windowMin}min, 0 commits on \`${opts.taskId}\``;
  const seen = opts.modalsSeen.slice(-3);
  const bullets: string[] = [];
  for (const s of seen) {
    bullets.push(naBullet80(`📋 ${s.modalClass}: ${s.firstLine}`));
  }
  bullets.push("🙏 Auto-action — clarifier dispatched + flag filed");
  bullets.push("📍 detector fires once per dedup window");
  const out: DiscordSendOpts = {
    template: "whip-modal-cycling",
    team: opts.team,
    category: "🔄",
    verdict,
    bullets,
  };
  if (opts.whenMs !== undefined) out.whenMs = opts.whenMs;
  return out;
}
