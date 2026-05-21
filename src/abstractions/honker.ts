// ADR-202: Honker as the in-DB messaging substrate.
//
// Thin wrapper around the Honker SQLite loadable extension. Owns:
//   - Kill-switch env reading (`ATMUX_HONKER=on|off`, default `off`).
//   - Extension load with poll-mode fallback on failure.
//   - Mac dev `Database.setCustomSQLite()` indirection per §D5/§D7.
//   - Smoke probe verifying NOTIFY/LISTEN round-trip post-load.
//   - Runtime state surface (`isHonkerLoaded(db)`) for consumers to
//     pick event-driven vs poll-mode code path at handler-dispatch
//     time.
//
// Phase-1 substrate scope per ADR-202 §D12 e-honker-substrate:
//   load helper + kill-switch + smoke probe + doctor probe surface.
//   No consumers wired here. Each consumer EPIC (jury, gitter, etc.)
//   owns its own subscribe call sites + idempotency tracking.
//
// **Extension binary not yet distributed.** Until the install wizard
// (ADR-200 §D6) provisions `~/.atmux/extensions/honker.{so,dylib}`,
// `loadHonkerOrFallback()` returns `{loaded: false}` cleanly and
// consumers fall through to their cron-backstop / direct-INSERT
// paths. Defense-in-depth per ADR-202 §D6.

import type { Database } from "bun:sqlite";

/** Runtime state for a single DB connection's Honker substrate. */
export interface HonkerRuntimeState {
  /** `true` if the extension loaded AND the smoke probe passed. */
  loaded: boolean;
  /** Last failure reason if `loaded === false`. `null` when kill-switch is off. */
  fallbackReason: string | null;
  /** Resolved extension path (or `null` if kill-switch off). */
  extensionPath: string | null;
}

/** Default extension path. Overridable via `ATMUX_HONKER_PATH`. */
function defaultExtensionPath(env: NodeJS.ProcessEnv, platform: string): string {
  const explicit = env.ATMUX_HONKER_PATH?.trim();
  if (explicit && explicit.length > 0) return explicit;
  const home = env.HOME ?? "/root";
  const ext = platform === "darwin" ? "dylib" : "so";
  return `${home}/.atmux/extensions/honker.${ext}`;
}

/** Resolve the Homebrew sqlite library path on macOS. */
function macSqlitePath(env: NodeJS.ProcessEnv): string {
  const explicit = env.ATMUX_HONKER_MAC_SQLITE?.trim();
  if (explicit && explicit.length > 0) return explicit;
  // Apple Silicon (default) before Intel Mac path
  return "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";
}

/** Test-injection seam for the smoke probe + DB methods. */
export interface HonkerHooks {
  /** Optional override for the `setCustomSQLite` static call. */
  setCustomSQLite?: (path: string) => void;
  /** Optional override for the extension-load call. */
  loadExtension?: (db: Database, path: string) => void;
  /** Optional override for the post-load smoke probe. */
  smokeProbe?: (db: Database) => boolean;
  /** Process platform string. Defaults to `process.platform`. */
  platform?: string;
  /** Process env. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Returns `true` when `ATMUX_HONKER` env var enables the substrate. */
export function isHonkerEnabled(env?: NodeJS.ProcessEnv): boolean {
  const raw = (env ?? process.env).ATMUX_HONKER?.toLowerCase().trim() ?? "";
  return raw === "on" || raw === "1" || raw === "true";
}

/**
 * Attempt to load the Honker SQLite extension into `db`. Returns
 * runtime state describing success / failure mode. Never throws —
 * callers rely on the `loaded` flag to decide event-driven vs
 * poll-mode behavior.
 *
 * On macOS, calls `Database.setCustomSQLite()` first to point bun:sqlite
 * at Homebrew sqlite (Apple's bundled sqlite has extension loading
 * disabled). Failure here falls through to poll-mode.
 *
 * On Linux, no preamble — distro sqlite supports `enable_load_extension`
 * out of the box.
 *
 * @param db    Open `bun:sqlite` Database to attach the extension to.
 * @param hooks Test-injection seam — production callers pass `{}`.
 */
export function loadHonkerOrFallback(db: Database, hooks: HonkerHooks = {}): HonkerRuntimeState {
  const env = hooks.env ?? process.env;
  const platform = hooks.platform ?? process.platform;

  if (!isHonkerEnabled(env)) {
    return { loaded: false, fallbackReason: null, extensionPath: null };
  }

  const extensionPath = defaultExtensionPath(env, platform);

  // Mac dev preamble: setCustomSQLite() before loadExtension(). Apple's
  // bundled sqlite has loadable-extension support compiled out.
  if (platform === "darwin") {
    const sqlitePath = macSqlitePath(env);
    try {
      // bun:sqlite exposes Database.setCustomSQLite as a static — tests
      // inject the hook because the real call has process-wide side
      // effects.
      if (hooks.setCustomSQLite) {
        hooks.setCustomSQLite(sqlitePath);
      } else {
        // Late-bound import — only resolves on darwin where the API is
        // actually needed. Untested in production until Mac dev path
        // ships per ADR-202 §D7.
        const sqliteModule = (db.constructor as unknown) as {
          setCustomSQLite?: (path: string) => void;
        };
        if (typeof sqliteModule.setCustomSQLite === "function") {
          sqliteModule.setCustomSQLite(sqlitePath);
        } else {
          return {
            loaded: false,
            fallbackReason: `darwin: Database.setCustomSQLite not available (sqlite path: ${sqlitePath})`,
            extensionPath,
          };
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        loaded: false,
        fallbackReason: `darwin setCustomSQLite failed (${sqlitePath}): ${msg}`,
        extensionPath,
      };
    }
  }

  // Load the extension. Failure → fall back, log reason, no throw.
  try {
    if (hooks.loadExtension) {
      hooks.loadExtension(db, extensionPath);
    } else {
      db.loadExtension(extensionPath);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      loaded: false,
      fallbackReason: `loadExtension(${extensionPath}) failed: ${msg}`,
      extensionPath,
    };
  }

  // Smoke probe — verify the extension is actually live, not just loaded.
  // Phase-1 probe is intentionally minimal: a `SELECT honker_version()`
  // round-trip. Future EPICs may extend with NOTIFY/LISTEN round-trip.
  try {
    const probePassed = hooks.smokeProbe
      ? hooks.smokeProbe(db)
      : defaultSmokeProbe(db);
    if (!probePassed) {
      return {
        loaded: false,
        fallbackReason: "smoke probe returned false (extension loaded but unresponsive)",
        extensionPath,
      };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      loaded: false,
      fallbackReason: `smoke probe threw: ${msg}`,
      extensionPath,
    };
  }

  return { loaded: true, fallbackReason: null, extensionPath };
}

/** Default smoke probe: `SELECT honker_version()` must return a string. */
function defaultSmokeProbe(db: Database): boolean {
  const row = db.query("SELECT honker_version() AS v").get() as { v?: unknown } | null;
  return typeof row?.v === "string" && row.v.length > 0;
}
