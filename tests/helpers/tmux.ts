import { createTmux, type TmuxConfig, type TmuxNamespace } from "../../src/abstractions/tmux.ts";
import { getAtmuxTmuxConfPath } from "../../src/core/tmux-paths.ts";

export const CANONICAL_ATMUX_TMUX_CONF_PATH = getAtmuxTmuxConfPath({
  ...process.env,
  ATMUX_TMUX_CONF: undefined,
} as NodeJS.ProcessEnv);

/**
 * Create a tmux namespace pinned to atmux's canonical conf path.
 *
 * The helper clears `ATMUX_TMUX_CONF` before resolving the path so a test
 * cannot inherit an empty or operator override when it needs the shipped
 * baseline. That alone does not suppress the canonical conf's documented
 * local override source (`~/.config/atmux/tmux.conf.local`), so live tests
 * that need a clean server must also control `HOME` before tmux starts.
 * `getAtmuxTmuxConfPath()` still preserves the repo-vs-installed topology
 * split.
 */
export function createCanonicalAtmuxTmux(config: Omit<TmuxConfig, "configFile">): TmuxNamespace {
  return createTmux({ ...config, configFile: CANONICAL_ATMUX_TMUX_CONF_PATH });
}

/**
 * Point `HOME` at a caller-owned temporary directory for a live tmux test.
 *
 * The returned restore closure is idempotent and restores either the prior
 * `HOME` value or the unset state, whichever existed before the override.
 */
export function setCanonicalAtmuxTmuxHome(homeDir: string): () => void {
  const priorHome = process.env.HOME;
  process.env.HOME = homeDir;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (priorHome !== undefined) process.env.HOME = priorHome;
    else delete process.env.HOME;
  };
}
