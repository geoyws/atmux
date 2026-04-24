#!/usr/bin/env bash
# lib/tui.sh — TUI launch command abstraction.
#
# Resolution order for a member's launch command (highest priority first):
#
#   1. member.command        — full override, used verbatim (atmux still adds `cd <cwd> && `).
#                              Use this when a member needs a totally custom invocation.
#
#   2. team.tuiCommands[tui] — per-team alias: the full launch *prefix* for a TUI.
#                              atmux still appends `--model <model>` unless the prefix
#                              already has a `--model` substring. Perfect place to
#                              encode "claude --plugin-dir=/path" or "cursor-agent --rules=/abs".
#
#   3. built-in default      — the atmux::tui_<name> functions below. Used when neither
#                              override is set.
#
# Supported built-in TUIs (by `tui` field):
#   claude, opencode, kimi, cursor, shell.
#
# Any OTHER value for `tui` is treated as a *name* that MUST have a matching entry in
# team.tuiCommands (or a matching member.command) — this lets users define arbitrary
# TUI types like "claude-fresh" or "opencode-minimax-fast".

# atmux::tui_cmd <tui> <model> <cwd> <name> <role> [<member-json>]
# Prints the command to exec in a pane.
atmux::tui_cmd() {
  local tui="$1" model="$2" cwd="$3" name="$4" role="$5" member_json="${6:-}"

  # 1. member.command full override.
  if [[ -n "$member_json" ]]; then
    local override
    override="$(jq -r '.command // ""' <<<"$member_json")"
    if [[ -n "$override" ]]; then
      printf 'cd %q && %s\n' "$cwd" "$override"
      return
    fi
  fi

  # 2. team.tuiCommands[<tui>] prefix.
  local tj; tj="$(atmux::team_json 2>/dev/null || true)"
  if [[ -n "$tj" && -f "$tj" ]]; then
    local prefix
    prefix="$(jq -r --arg t "$tui" '.tuiCommands[$t] // ""' "$tj" 2>/dev/null || true)"
    if [[ -n "$prefix" ]]; then
      _atmux_compose_custom "$prefix" "$model" "$cwd"
      return
    fi
  fi

  # 3. Built-in defaults.
  case "$tui" in
    claude)    atmux::tui_claude   "$model" "$cwd" "$name" "$role" ;;
    opencode)  atmux::tui_opencode "$model" "$cwd" "$name" "$role" ;;
    kimi)      atmux::tui_kimi     "$model" "$cwd" "$name" "$role" ;;
    cursor)    atmux::tui_cursor   "$model" "$cwd" "$name" "$role" ;;
    shell|bash|zsh) echo "cd $(printf '%q' "$cwd") && exec \$SHELL" ;;
    *)
      atmux::die "unknown tui type: '$tui' (use one of: claude, opencode, kimi, cursor, shell — OR register it in team.json's \"tuiCommands\")"
      ;;
  esac
}

# Compose a launch command given a custom prefix + model + cwd.
# Appends `--model <model>` UNLESS the prefix already contains `--model`.
_atmux_compose_custom() {
  local prefix="$1" model="$2" cwd="$3"
  local model_flag=""
  if [[ -n "$model" && "$model" != "default" ]]; then
    if ! grep -q -- '--model' <<<"$prefix"; then
      model_flag="--model $(printf '%q' "$model")"
    fi
  fi
  printf 'cd %q && %s %s\n' "$cwd" "$prefix" "$model_flag"
}

atmux::tui_claude() {
  local model="$1" cwd="$2" name="$3" role="$4"
  local model_flag=""
  [[ -n "$model" && "$model" != "default" ]] && model_flag="--model $(printf '%q' "$model")"
  local bin="${ATMUX_CLAUDE_BIN:-claude}"
  printf 'cd %q && CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=%s %s --permission-mode %s %s\n' \
    "$cwd" \
    "${ATMUX_CLAUDE_EFFORT:-xhigh}" \
    "$bin" \
    "${ATMUX_CLAUDE_PERMISSION:-dontAsk}" \
    "$model_flag"
}

atmux::tui_opencode() {
  local model="$1" cwd="$2" name="$3" role="$4"
  local bin="${ATMUX_OPENCODE_BIN:-opencode}"
  local m="${model:-default}"
  if [[ "$m" == "default" || -z "$m" ]]; then
    m="${ATMUX_OPENCODE_DEFAULT_MODEL:-minimax-coding-plan/MiniMax-M2.7-highspeed}"
  fi
  printf 'cd %q && %s --model %q\n' "$cwd" "$bin" "$m"
}

atmux::tui_kimi() {
  local model="$1" cwd="$2" name="$3" role="$4"
  local bin="${ATMUX_KIMI_BIN:-kimi}"
  local m="${model:-default}"
  if [[ "$m" == "default" || -z "$m" ]]; then
    m="${ATMUX_KIMI_DEFAULT_MODEL:-kimi-latest}"
  fi
  printf 'cd %q && %s --model %q\n' "$cwd" "$bin" "$m"
}

atmux::tui_cursor() {
  local model="$1" cwd="$2" name="$3" role="$4"
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
