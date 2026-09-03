export const VENDORED_TMUX_VERSION = "3.7c";
export const VENDORED_TMUX_SOURCE_URL =
  "https://github.com/tmux/tmux/releases/download/3.7c/tmux-3.7c.tar.gz";
export const VENDORED_TMUX_SOURCE_SHA256 =
  "7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf";

export const VENDORED_TMUX_INSTALL_ROOT = "/opt/atmux";
export const VENDORED_TMUX_CURRENT_LINK = "/opt/atmux/current";
export const VENDORED_TMUX_BIN = "/opt/atmux/current/bin/tmux";

export function vendoredTmuxVersionTag(): string {
  return `tmux ${VENDORED_TMUX_VERSION}`;
}

export function vendoredTmuxArchiveRoot(): string {
  return `tmux-${VENDORED_TMUX_VERSION}`;
}
