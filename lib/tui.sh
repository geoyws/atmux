#!/usr/bin/env bash
# lib/tui.sh — TUI launch command abstraction.
#
# Each TUI type maps to a shell command that, when run in a pane, brings up
# an interactive REPL we can drive via `tmux send-keys`. Members declare their
# `tui` in team.json; atmux::tui_cmd composes the actual launch command.
#
# Supported TUIs:
#   claude      — Claude Code (default model)
#   opencode    — OpenCode (default model: MiniMax M2.7 highspeed; switchable via model field)
#   kimi        — Kimi CLI (Moonshot; default: latest/fastest)
#   cursor      — Cursor CLI agent (Composer 2 default; switchable via model field)

# atmux::tui_cmd <tui-type> <model> <cwd> <name> <role>
# Returns the shell command to exec in the pane.
atmux::tui_cmd() {
  local tui="$1" model="$2" cwd="$3" name="$4" role="$5"
  case "$tui" in
    claude)    atmux::tui_claude   "$model" "$cwd" "$name" "$role" ;;
    opencode)  atmux::tui_opencode "$model" "$cwd" "$name" "$role" ;;
    kimi)      atmux::tui_kimi     "$model" "$cwd" "$name" "$role" ;;
    cursor)    atmux::tui_cursor   "$model" "$cwd" "$name" "$role" ;;
    shell|bash|zsh) echo "cd $(printf '%q' "$cwd") && exec \$SHELL" ;;
    *) atmux::die "unknown tui type: $tui (use one of: claude, opencode, kimi, cursor, shell)" ;;
  esac
}

atmux::tui_claude() {
  local model="$1" cwd="$2" name="$3" role="$4"
  local model_flag=""
  [[ -n "$model" && "$model" != "default" ]] && model_flag="--model $(printf '%q' "$model")"
  printf 'cd %q && CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=%s claude --permission-mode %s %s\n' \
    "$cwd" \
    "${ATMUX_CLAUDE_EFFORT:-xhigh}" \
    "${ATMUX_CLAUDE_PERMISSION:-dontAsk}" \
    "$model_flag"
}

atmux::tui_opencode() {
  local model="$1" cwd="$2" name="$3" role="$4"
  # opencode reads model from ~/.config/opencode/opencode.json by default.
  # `--model` overrides per-session. Default here: MiniMax M2.7 highspeed.
  local m="${model:-default}"
  if [[ "$m" == "default" || -z "$m" ]]; then
    m="${ATMUX_OPENCODE_DEFAULT_MODEL:-minimax-coding-plan/MiniMax-M2.7-highspeed}"
  fi
  printf 'cd %q && opencode --model %q\n' "$cwd" "$m"
}

atmux::tui_kimi() {
  local model="$1" cwd="$2" name="$3" role="$4"
  # Kimi CLI (Moonshot). Default command is `kimi`; model passed via env or flag.
  local bin="${ATMUX_KIMI_BIN:-kimi}"
  local m="${model:-default}"
  if [[ "$m" == "default" || -z "$m" ]]; then
    m="${ATMUX_KIMI_DEFAULT_MODEL:-kimi-latest}"
  fi
  printf 'cd %q && %s --model %q\n' "$cwd" "$bin" "$m"
}

atmux::tui_cursor() {
  local model="$1" cwd="$2" name="$3" role="$4"
  # Cursor CLI agent. `cursor-agent` is the TUI binary; Composer 2 is default model.
  local bin="${ATMUX_CURSOR_BIN:-cursor-agent}"
  local m="${model:-default}"
  if [[ "$m" == "default" || -z "$m" ]]; then
    m="${ATMUX_CURSOR_DEFAULT_MODEL:-composer-2}"
  fi
  printf 'cd %q && %s --model %q\n' "$cwd" "$bin" "$m"
}

# Returns the brief file path for a role. Used by `atmux start` to paste an
# initial brief into each member's pane after launch.
atmux::brief_path() {
  local role="$1"
  local custom="$ATMUX_ROOT/templates/briefs/${role}.md"
  if [[ -f "$custom" ]]; then
    printf '%s\n' "$custom"
  else
    printf '%s/templates/briefs/member.md\n' "$ATMUX_ROOT"
  fi
}
