// ADR-272: voice operator interface — env/flag config resolution for
// the voice server.
//
// Precedence per knob: explicit flag > env var > default. Numeric knobs
// fail CLOSED to their defaults on non-numeric / non-positive /
// non-finite values (mirrors `resolveGitTimeoutMs` in
// `src/abstractions/spawn.ts` — a fat-fingered export must degrade to a
// sane default, never disable a timeout or move a port to NaN).
//
// `provider` is kept as a RAW string here on purpose: alias parsing and
// API-key selection happen at boot wiring (P4), which is the only place
// allowed to touch `src/abstractions/voice/**`. Importing the provider
// seam from core config would put every config consumer on the wrong
// side of the ADR-272 D1 import fence.
//
// `token` is the one hard-required knob (ADR-272 §Security layer 2):
// missing or <32 chars refuses with `ConfigError` — no default, no
// generated-and-printed fallback.

import { ConfigError } from "../../errors.ts";
import { readVoxEnv, type VoxEnvWarn } from "./env-compat.ts";
import { DEFAULT_TRANSCRIPT_RETENTION_DAYS } from "./transcript.ts";

/** CLI-flag overrides (P4 wires these from `atmux vox` argv). Every
 *  field optional at the callsite via `Partial<VoxFlags>`. */
export interface VoxFlags {
  token: string;
  provider: string;
  model: string;
  port: number;
  host: string;
  origins: string[];
  toolTimeoutMs: number;
  maxResultChars: number;
  readonly: boolean;
  resumeGraceMs: number;
  confirmTtlMs: number;
  assetsDir: string;
  transcripts: boolean;
  transcriptRetentionDays: number;
}

/** Resolved voice-server configuration. */
export interface VoxConfig {
  /** ATMUX_VOX_TOKEN — required, ≥32 chars (ADR-272 §Security). */
  token: string;
  /** ATMUX_VOX_PROVIDER — raw string; parsed at P4 boot wiring. */
  provider: string;
  /** ATMUX_VOX_MODEL — optional provider-model override. */
  model?: string;
  /** ATMUX_VOX_PORT — default 4390. */
  port: number;
  /** ATMUX_VOX_HOST — default loopback (ADR-272 §Security layer 4). */
  host: string;
  /** ATMUX_VOX_ORIGINS — comma-separated allowlist → string[]. */
  origins: string[];
  /** ATMUX_VOX_TOOL_TIMEOUT_MS — default 20_000. */
  toolTimeoutMs: number;
  /** ATMUX_VOX_MAX_RESULT_CHARS — default 2000. */
  maxResultChars: number;
  /** ATMUX_VOX_READONLY — "1"/"true" (case-insensitive) → true. */
  readonly: boolean;
  /** ATMUX_VOX_RESUME_GRACE_MS — default 90_000 (ADR-272 D8). */
  resumeGraceMs: number;
  /** ATMUX_VOX_CONFIRM_TTL_MS — default 120_000 (ADR-272 D7). */
  confirmTtlMs: number;
  /** ATMUX_VOX_ASSETS_DIR — optional PWA-assets dir override. */
  assetsDir?: string;
  /**
   * ATMUX_VOX_TRANSCRIPTS — "1"/"true" ⇒ write session transcripts to
   * `~/.atmux/vox-logs/`. **Default false** (ADR-272 OQ-4: a transcript
   * is a durable record of everything said near the microphone, so the
   * operator opts IN). Note this gates WRITING only — the retention sweep
   * runs either way, since it only deletes.
   */
  transcripts: boolean;
  /** ATMUX_VOX_TRANSCRIPT_RETENTION_DAYS — default 7 (ADR-272 OQ-4).
   *  Shortening is the operator's call; lengthening wants a reason. */
  transcriptRetentionDays: number;
}

/** Shipped defaults (ADR-272 D6/D7/D8 + OQ-1 provider recommendation). */
export const VOX_DEFAULTS = Object.freeze({
  provider: "openai-realtime",
  port: 4390,
  host: "127.0.0.1",
  toolTimeoutMs: 20_000,
  maxResultChars: 2000,
  resumeGraceMs: 90_000,
  confirmTtlMs: 120_000,
  transcriptRetentionDays: DEFAULT_TRANSCRIPT_RETENTION_DAYS,
} as const);

/** Minimum accepted token length (ADR-272 §Security layer 2). */
export const VOX_TOKEN_MIN_CHARS = 32;

const TOKEN_HINT = "generate one: openssl rand -hex 32";

/** Flag > env > default for a numeric knob; both override layers fail
 *  closed to `dflt` on non-numeric / non-positive / non-finite values
 *  (mirrors `resolveGitTimeoutMs`). */
function resolveNumber(flag: number | undefined, raw: string | undefined, dflt: number): number {
  if (flag !== undefined && Number.isFinite(flag) && flag > 0) return flag;
  if (raw === undefined || raw === "") return dflt;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return dflt;
  return parsed;
}

/** Flag > env > default for a string knob; empty strings read as unset. */
function resolveString(flag: string | undefined, raw: string | undefined, dflt: string): string {
  if (flag !== undefined && flag.length > 0) return flag;
  if (raw !== undefined && raw.length > 0) return raw;
  return dflt;
}

/** Optional string knob: flag > env > absent. Empty reads as unset. */
function resolveOptionalString(
  flag: string | undefined,
  raw: string | undefined,
): string | undefined {
  if (flag !== undefined && flag.length > 0) return flag;
  if (raw !== undefined && raw.length > 0) return raw;
  return undefined;
}

/** Comma-separated env value → trimmed entries, empties dropped. */
export function parseOriginsList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** "1" / "true" (case-insensitive) → true; anything else → false. */
export function parseBooleanEnv(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const folded = raw.trim().toLowerCase();
  return folded === "1" || folded === "true";
}

/**
 * Resolve the full voice-server config from `env` + optional flag
 * overrides. Throws `ConfigError` when the token is missing or shorter
 * than {@link VOX_TOKEN_MIN_CHARS}; every other knob degrades to its
 * default rather than refusing.
 */
export function resolveVoxConfig(
  env: NodeJS.ProcessEnv,
  flags?: Partial<VoxFlags>,
  warn?: VoxEnvWarn,
): VoxConfig {
  // SUNSET(v0.9.1): every read goes through the ADR-274 D2 legacy fallback.
  const e = (suffix: string): string | undefined =>
    warn === undefined ? readVoxEnv(env, suffix) : readVoxEnv(env, suffix, warn);

  const token = resolveOptionalString(flags?.token, e("TOKEN"));
  if (token === undefined) {
    throw new ConfigError({
      what: `ATMUX_VOX_TOKEN is required (≥${VOX_TOKEN_MIN_CHARS} chars) — the voice server refuses to start without one`,
      hint: TOKEN_HINT,
    });
  }
  if (token.length < VOX_TOKEN_MIN_CHARS) {
    throw new ConfigError({
      what: `ATMUX_VOX_TOKEN too short: ${token.length} chars (need ≥${VOX_TOKEN_MIN_CHARS})`,
      hint: TOKEN_HINT,
    });
  }

  const origins =
    flags?.origins !== undefined
      ? flags.origins.map((s) => s.trim()).filter((s) => s.length > 0)
      : parseOriginsList(e("ORIGINS"));

  const model = resolveOptionalString(flags?.model, e("MODEL"));
  const assetsDir = resolveOptionalString(flags?.assetsDir, e("ASSETS_DIR"));

  const out: VoxConfig = {
    token,
    provider: resolveString(flags?.provider, e("PROVIDER"), VOX_DEFAULTS.provider),
    port: resolveNumber(flags?.port, e("PORT"), VOX_DEFAULTS.port),
    host: resolveString(flags?.host, e("HOST"), VOX_DEFAULTS.host),
    origins,
    toolTimeoutMs: resolveNumber(
      flags?.toolTimeoutMs,
      e("TOOL_TIMEOUT_MS"),
      VOX_DEFAULTS.toolTimeoutMs,
    ),
    maxResultChars: resolveNumber(
      flags?.maxResultChars,
      e("MAX_RESULT_CHARS"),
      VOX_DEFAULTS.maxResultChars,
    ),
    readonly: flags?.readonly ?? parseBooleanEnv(e("READONLY")),
    resumeGraceMs: resolveNumber(
      flags?.resumeGraceMs,
      e("RESUME_GRACE_MS"),
      VOX_DEFAULTS.resumeGraceMs,
    ),
    confirmTtlMs: resolveNumber(
      flags?.confirmTtlMs,
      e("CONFIRM_TTL_MS"),
      VOX_DEFAULTS.confirmTtlMs,
    ),
    // OFF unless the operator says otherwise (ADR-272 OQ-4).
    transcripts: flags?.transcripts ?? parseBooleanEnv(e("TRANSCRIPTS")),
    transcriptRetentionDays: resolveNumber(
      flags?.transcriptRetentionDays,
      e("TRANSCRIPT_RETENTION_DAYS"),
      VOX_DEFAULTS.transcriptRetentionDays,
    ),
  };
  if (model !== undefined) out.model = model;
  if (assetsDir !== undefined) out.assetsDir = assetsDir;
  return out;
}
