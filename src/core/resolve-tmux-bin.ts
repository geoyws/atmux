// ADR-191: resolve the tmux binary atmux should spawn.
//
// Three-tier resolution chain (per Epic e-1-b71bf640/T3 AC):
//
//   1. `ATMUX_TMUX_BIN` env var (operator override) — existsSync-gated.
//      A set-but-missing override throws with an operator-actionable
//      message so a typo or relocated binary surfaces at resolve time
//      instead of as opaque ENOENT at spawn time.
//   2. `/opt/atmux/current/bin/tmux` (vendored binary, present after
//      build:install lands the binary into the install topology per
//      `project_atmux_install_topology`).
//   3. System PATH — actively probed via `which tmux`. Returns the
//      absolute path the OS would resolve. A warn-once fires so the
//      operator notices a missing vendored binary without spamming
//      stderr on every spawn (atmux issues thousands per session).
//
// When all three tiers fail (override unset / vendored absent / no
// tmux on PATH), the helper throws: atmux cannot function without
// tmux somewhere, and a clear "can't find tmux" beats a cryptic
// ENOENT at the first spawn.
//
// Mirrors the injectable-seams shape of `resolveDefaultListenerBinary`
// in `src/abstractions/native-listener.ts` (env + existsSync) plus a
// `pathProbe` seam for the active PATH search. Module-scoped memoization
// (cached path + warn-once flag) lives in a state record; tests pass
// their own state via the optional `state` parameter (or call
// `resetResolveTmuxBinForTesting()`) for full isolation.

import { spawnSync as nativeSpawnSync } from "node:child_process";
import { existsSync as fsExistsSync } from "node:fs";

/** Canonical install topology — mirrors `/opt/atmux/current/bin/atmux`. */
export const VENDORED_TMUX_PATH = "/opt/atmux/current/bin/tmux";

/** Per-process memoization for cached path + warn-once dedup. */
export interface ResolveTmuxBinState {
  cached: string | null;
  warnedFallback: boolean;
}

export function createResolveTmuxBinState(): ResolveTmuxBinState {
  return { cached: null, warnedFallback: false };
}

const moduleState = createResolveTmuxBinState();

/** Default PATH probe — runs `which tmux` synchronously, returns the
 *  trimmed absolute path on success or null when not found. */
function defaultPathProbe(): string | null {
  const r = nativeSpawnSync("which", ["tmux"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const out = (r.stdout ?? "").trim();
  return out.length > 0 ? out : null;
}

/**
 * Resolve the tmux binary path. See module header for the 3-tier chain.
 *
 * @param env — override `process.env` (test seam).
 * @param existsSync — override the filesystem probe (test seam).
 * @param warn — override the warn sink for the tier-3 fallback message.
 * @param state — override the memoization record (test seam).
 * @param pathProbe — override the system-PATH search (test seam).
 * @throws when `ATMUX_TMUX_BIN` is set to a missing path, or when all
 *   three tiers fail to find tmux anywhere.
 */
export function resolveTmuxBin(
  env: NodeJS.ProcessEnv = process.env,
  existsSync: (path: string) => boolean = fsExistsSync,
  warn: (msg: string) => unknown = (s) => process.stderr.write(s),
  state: ResolveTmuxBinState = moduleState,
  pathProbe: () => string | null = defaultPathProbe,
): string {
  if (state.cached !== null) return state.cached;

  const override = env.ATMUX_TMUX_BIN?.trim();
  if (override && override.length > 0) {
    if (!existsSync(override)) {
      throw new Error(
        `[atmux] ATMUX_TMUX_BIN=${override} but no such file — fix the path or unset to fall through to the vendored / system tmux resolution chain (ADR-191).`,
      );
    }
    state.cached = override;
    return state.cached;
  }

  if (existsSync(VENDORED_TMUX_PATH)) {
    state.cached = VENDORED_TMUX_PATH;
    return state.cached;
  }

  const systemPath = pathProbe();
  if (systemPath !== null) {
    if (!state.warnedFallback) {
      warn(
        `[atmux] warn: vendored tmux not found at ${VENDORED_TMUX_PATH} — falling back to system tmux at ${systemPath}. Install /opt/atmux/<v>/bin/tmux per ADR-191 or set ATMUX_TMUX_BIN to silence this warning.\n`,
      );
      state.warnedFallback = true;
    }
    state.cached = systemPath;
    return state.cached;
  }

  throw new Error(
    `[atmux] cannot find tmux: ATMUX_TMUX_BIN unset, ${VENDORED_TMUX_PATH} absent, and no \`tmux\` on PATH. atmux requires a tmux binary — install via \`bun run build:install\` (ADR-191) or via your package manager (apt install tmux / brew install tmux).`,
  );
}

/** Test-only: clear the module-level cache + warn-once state. */
export function resetResolveTmuxBinForTesting(): void {
  moduleState.cached = null;
  moduleState.warnedFallback = false;
}
