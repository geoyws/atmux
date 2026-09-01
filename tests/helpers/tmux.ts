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
 * baseline. `getAtmuxTmuxConfPath()` still preserves the repo-vs-installed
 * topology split.
 */
export function createCanonicalAtmuxTmux(config: Omit<TmuxConfig, "configFile">): TmuxNamespace {
  return createTmux({ ...config, configFile: CANONICAL_ATMUX_TMUX_CONF_PATH });
}
