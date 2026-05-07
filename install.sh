#!/usr/bin/env bash
# atmux one-shot installer. Clones to ~/.atmux and symlinks bin/atmux +
# bin/atmux-tmux → /usr/local/bin/.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/geoyws/atmux/main/install.sh | bash
#
# Or from a local clone:
#   ./install.sh
set -euo pipefail

REPO_URL="${ATMUX_REPO_URL:-https://github.com/geoyws/atmux.git}"
INSTALL_DIR="${ATMUX_HOME:-$HOME/.atmux-src}"
BIN_TARGET="${ATMUX_BIN:-/usr/local/bin/atmux}"

have() { command -v "$1" >/dev/null 2>&1; }

for dep in tmux jq git; do
  if ! have "$dep"; then
    echo "atmux: missing dependency: $dep" >&2
    echo "  install it first — on macOS: brew install $dep  — on Ubuntu: apt install $dep" >&2
    exit 1
  fi
done

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "atmux: updating existing install at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "atmux: cloning $REPO_URL → $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

chmod +x "$INSTALL_DIR/bin/atmux" "$INSTALL_DIR/bin/atmux-tmux" "$INSTALL_DIR"/lib/*.sh 2>/dev/null || true

# Link bin/atmux + bin/atmux-tmux into the same parent dir as $BIN_TARGET.
# atmux-tmux (ADR-018) is the cage-aware tmux wrapper — paired binary so
# `attach` lands on the right socket without operators having to remember
# `tmux -S /tmp/atmux-tmux-<team>/tmux-$UID/default attach`.
_bin_target_dir="$(dirname "$BIN_TARGET")"
_atmuxtmux_target="$_bin_target_dir/atmux-tmux"

if [[ -w "$_bin_target_dir" ]]; then
  ln -sf "$INSTALL_DIR/bin/atmux"      "$BIN_TARGET"
  ln -sf "$INSTALL_DIR/bin/atmux-tmux" "$_atmuxtmux_target"
else
  echo "atmux: $_bin_target_dir is not writable; trying sudo ln"
  sudo ln -sf "$INSTALL_DIR/bin/atmux"      "$BIN_TARGET"
  sudo ln -sf "$INSTALL_DIR/bin/atmux-tmux" "$_atmuxtmux_target"
fi

echo "atmux: installed. Run 'atmux --help' to get started."
