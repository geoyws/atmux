// ADR-191: resolve the tmux binary atmux should spawn.
//
// Legacy/live plane:
//   Two-tier resolution chain (per Epic e-1-b71bf640/T3 AC):
//
//   1. `ATMUX_TMUX_BIN` env var (operator override) — existsSync-gated.
//      A set-but-missing override throws with an operator-actionable
//      message so a typo or relocated binary surfaces at resolve time
//      instead of as opaque ENOENT at spawn time.
//   2. System PATH — actively probed via `which tmux`. Returns the
//      absolute path the OS would resolve.
//
// When both tiers fail (override unset / no tmux on PATH), the helper
// throws: atmux cannot function without tmux somewhere, and a clear
// "can't find tmux" beats a cryptic ENOENT at the first spawn.
//
// Future vendored plane:
//   `resolveVendoredTmuxBin()` is the fail-closed sibling for the
//   future server-only path. It accepts `ATMUX_VENDORED_TMUX_BIN` or
//   the canonical vendored install path, but never falls back to the
//   system tmux on PATH. That keeps the future cockpit/group/team
//   servers from silently re-contacting the legacy Homebrew tmux plane.
//
// Mirrors the injectable-seams shape of `resolveDefaultListenerBinary`
// in `src/abstractions/native-listener.ts` (env + existsSync) plus a
// `pathProbe` seam for the active PATH search. Module-scoped memoization
// (cached path only) lives in a state record; tests pass their own
// state via the optional `state` parameter (or call
// `resetResolveTmuxBinForTesting()`) for full isolation.

import { spawnSync as nativeSpawnSync } from "node:child_process";
import { existsSync as fsExistsSync } from "node:fs";

/** Canonical install topology — mirrors `/opt/atmux/current/bin/atmux`. */
export const VENDORED_TMUX_PATH = "/opt/atmux/current/bin/tmux";

/** Per-process memoization for cached path only. */
export interface ResolveTmuxBinState {
  cached: string | null;
}

export function createResolveTmuxBinState(): ResolveTmuxBinState {
  return { cached: null };
}

const moduleState = createResolveTmuxBinState();

export interface ResolveVendoredTmuxBinState {
  cached: string | null;
}

export function createResolveVendoredTmuxBinState(): ResolveVendoredTmuxBinState {
  return { cached: null };
}

const vendoredModuleState = createResolveVendoredTmuxBinState();

/** Default PATH probe — runs `which tmux` synchronously, returns the
 *  trimmed absolute path on success or null when not found. */
function defaultPathProbe(): string | null {
  const r = nativeSpawnSync("which", ["tmux"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const out = (r.stdout ?? "").trim();
  return out.length > 0 ? out : null;
}

/**
 * Resolve the tmux binary path. See module header for the two-tier
 * live chain and the separate vendored helper.
 *
 * @param env — override `process.env` (test seam).
 * @param existsSync — override the filesystem probe (test seam).
 * @param _warn — compatibility-only warning seam; retained for the
 *   old call signature but unused by the live resolver.
 * @param state — override the memoization record (test seam).
 * @param pathProbe — override the system-PATH search (test seam).
 * @throws when `ATMUX_TMUX_BIN` is set to a missing path, or when no
 *   tmux binary is found on PATH.
 */
export function resolveTmuxBin(
  env: NodeJS.ProcessEnv = process.env,
  existsSync: (path: string) => boolean = fsExistsSync,
  _warn: (msg: string) => unknown = () => {},
  state: ResolveTmuxBinState = moduleState,
  pathProbe: () => string | null = defaultPathProbe,
): string {
  if (state.cached !== null) return state.cached;

  const override = env.ATMUX_TMUX_BIN?.trim();
  if (override && override.length > 0) {
    if (!existsSync(override)) {
      throw new Error(
        `[atmux] ATMUX_TMUX_BIN=${override} but no such file — fix the path or unset to fall through to the legacy host tmux on PATH resolution chain (ADR-191).`,
      );
    }
    state.cached = override;
    return state.cached;
  }

  const systemPath = pathProbe();
  if (systemPath !== null) {
    state.cached = systemPath;
    return state.cached;
  }

  throw new Error(
    `[atmux] cannot find tmux: ATMUX_TMUX_BIN unset and no \`tmux\` on PATH. atmux requires a tmux binary — install via \`bun run build:install\` (ADR-191) or via your package manager (apt install tmux / brew install tmux).`,
  );
}

/**
 * Resolve the tmux binary for the future vendored plane.
 *
 * Unlike {@link resolveTmuxBin}, this helper is fail-closed:
 * - `ATMUX_VENDORED_TMUX_BIN` is the explicit override.
 * - otherwise the canonical vendored path is used.
 * - system PATH is never consulted.
 *
 * That keeps the future server-only cockpit/group/team plane from
 * drifting back to the legacy Homebrew tmux route.
 */
export function resolveVendoredTmuxBin(
  env: NodeJS.ProcessEnv = process.env,
  existsSync: (path: string) => boolean = fsExistsSync,
  state: ResolveVendoredTmuxBinState = vendoredModuleState,
): string {
  if (state.cached !== null) return state.cached;

  const override = env.ATMUX_VENDORED_TMUX_BIN?.trim();
  if (override && override.length > 0) {
    if (!existsSync(override)) {
      throw new Error(
        `[atmux] ATMUX_VENDORED_TMUX_BIN=${override} but no such file — fix the path or unset to fall back to the canonical vendored tmux only (ADR-191/ADR-163).`,
      );
    }
    state.cached = override;
    return state.cached;
  }

  if (existsSync(VENDORED_TMUX_PATH)) {
    state.cached = VENDORED_TMUX_PATH;
    return state.cached;
  }

  throw new Error(
    `[atmux] cannot find vendored tmux: ATMUX_VENDORED_TMUX_BIN unset and ${VENDORED_TMUX_PATH} absent. Future server-only paths must not fall back to the system tmux; install the vendored binary first (ADR-191/ADR-163).`,
  );
}

/** Test-only: clear the module-level cache state. */
export function resetResolveTmuxBinForTesting(): void {
  moduleState.cached = null;
  vendoredModuleState.cached = null;
}
