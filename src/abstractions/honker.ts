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

/**
 * Returns `true` when the Honker substrate should attempt to load.
 *
 * Default flipped to ON 2026-05-21 (driver-initiated dogfood). Operators
 * disable explicitly via `ATMUX_HONKER=off|0|false`; the substrate is
 * graceful — when the binary isn't present, `loadHonkerOrFallback`
 * returns `{loaded: false, fallbackReason: "..."}` cleanly and consumers
 * fall through to their cron-backstop / direct-INSERT paths (ADR-202
 * §D6). So flipping default ON before the binary is universally
 * distributed is safe; it just enables the load-attempt + the doctor
 * probe's yellow `fallback` row when the binary is missing.
 */
export function isHonkerEnabled(env?: NodeJS.ProcessEnv): boolean {
  const raw = (env ?? process.env).ATMUX_HONKER?.toLowerCase().trim() ?? "";
  if (raw === "off" || raw === "0" || raw === "false") return false;
  // Default ON — empty string, unset, or any positive form.
  return true;
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

// ---------- Boot helper + state accessor ----------

/** Per-Database runtime state, keyed weakly so DB GC reclaims it. */
const HONKER_STATE = new WeakMap<Database, HonkerRuntimeState>();

/** Optional emitter so the boot can announce its state without coupling
 *  honker.ts to events.ts (avoids the circular schema/events ↔ honker
 *  import). Callers supply this from src/abstractions/events.ts. */
export type AnnounceFn = (db: Database, state: HonkerRuntimeState) => void;

/**
 * Boot the Honker substrate against `db`: loads the extension (or
 * falls back), stashes the runtime state for later retrieval via
 * `getHonkerState(db)`, and (when an `announce` callback is provided)
 * publishes an `internal.honker.{loaded,fallback}` event.
 *
 * Call once per process / per DB handle, ideally right after
 * `openDatabase()` returns. Subsequent calls on the same db return
 * the cached state without re-running the load. Tests that want a
 * fresh boot should reset their fixture DB rather than re-call.
 *
 * Per ADR-202 §D5: never throws. On any failure (kill-switch off,
 * load throw, smoke fail), the returned state has `loaded: false`
 * and consumers branch on the flag.
 *
 * @param db       Open Database (per-team state.db or cockpit-events.db).
 * @param hooks    Test-injection seam — production callers pass `{}`.
 * @param announce Optional callback invoked with the resulting state.
 *                 src/abstractions/events.ts provides the canonical
 *                 emit-based announcer; consumers call bootHonker with
 *                 the bound version.
 */
export function bootHonker(
  db: Database,
  hooks: HonkerHooks = {},
  announce?: AnnounceFn,
): HonkerRuntimeState {
  const cached = HONKER_STATE.get(db);
  if (cached) return cached;

  const state = loadHonkerOrFallback(db, hooks);
  HONKER_STATE.set(db, state);
  if (announce) {
    try {
      announce(db, state);
    } catch {
      // Announce failure must not block boot — the substrate is the
      // critical path; observability is best-effort.
    }
  }
  return state;
}

/** Read the cached runtime state for a previously-booted db.
 *  Returns `null` when bootHonker() hasn't been called for this db. */
export function getHonkerState(db: Database): HonkerRuntimeState | null {
  return HONKER_STATE.get(db) ?? null;
}

/** Reset the cache for `db`. Test-only — production code must not call. */
export function resetHonkerStateForTest(db: Database): void {
  HONKER_STATE.delete(db);
}
