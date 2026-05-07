#!/usr/bin/env bash
# atmux reconfigure — re-run the wizard against an existing team.json.
# Preserves `name` and `members`; prompts for tuiCommands + discord.

main() {
  atmux::require jq
  atmux::require_team

  local tj; tj="$(atmux::team_json)"

  echo ""
  echo "╭──────────────────────────────────────────────────────╮"
  echo "│       atmux — reconfigure TUI launch commands         │"
  echo "╰──────────────────────────────────────────────────────╯"
  echo "(edits $tj in place. Ctrl-C to abort.)"
  echo ""

  local claude_cur opencode_cur kimi_cur cursor_cur
  claude_cur=$(jq -r '.tuiCommands.claude   // "claude"'        "$tj")
  opencode_cur=$(jq -r '.tuiCommands.opencode // "opencode"'    "$tj")
  kimi_cur=$(jq -r '.tuiCommands.kimi     // "kimi"'            "$tj")
  cursor_cur=$(jq -r '.tuiCommands.cursor   // "cursor-agent"'  "$tj")

  _atmux_prompt_local() {
    local __var="$1" __msg="$2" __default="$3" __input
    printf '%s%s%s [%s]: ' "$atmux_c_cyn" "$__msg" "$atmux_c_rst" "$__default" >&2
    IFS= read -r __input
    [[ -z "$__input" ]] && __input="$__default"
    printf -v "$__var" '%s' "$__input"
  }

  local claude_new opencode_new kimi_new cursor_new
  _atmux_prompt_local claude_new   "claude launch command"   "$claude_cur"
  _atmux_prompt_local opencode_new "opencode launch command" "$opencode_cur"
  _atmux_prompt_local kimi_new     "kimi launch command"     "$kimi_cur"
  _atmux_prompt_local cursor_new   "cursor launch command"   "$cursor_cur"

  local hook_cur; hook_cur=$(jq -r '.discord.webhook // ""' "$tj")
  local hook_new
  _atmux_prompt_local hook_new "Discord webhook URL (Enter to keep/skip)" "$hook_cur"

  # Per t-2f13a2e4: snapshot before the rewrite so an interrupted/botched
  # reconfigure leaves a recoverable .bak.<epoch>.
  atmux::team_json_backup >/dev/null

  atmux::jq_update "$tj" '
    (.tuiCommands = (
      {}
      + (if $c  != "" and $c  != "claude"       then {claude:   $c}  else {} end)
      + (if $o  != "" and $o  != "opencode"     then {opencode: $o}  else {} end)
      + (if $k  != "" and $k  != "kimi"         then {kimi:     $k}  else {} end)
      + (if $cu != "" and $cu != "cursor-agent" then {cursor:   $cu} else {} end)
    ))
    | (if $h == "" then .discord = null else .discord = {webhook: $h} end)
  ' \
    --arg c  "$claude_new" \
    --arg o  "$opencode_new" \
    --arg k  "$kimi_new" \
    --arg cu "$cursor_new" \
    --arg h  "$hook_new"

  atmux::ok "reconfigured $tj"
}
