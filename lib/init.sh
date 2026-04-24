#!/usr/bin/env bash
# atmux init [--name <team>] [--wizard] [--force]
#
# Default: non-interactive, scaffolds from templates/team.example.json.
# --wizard: interactive prompts to build a team.json from scratch.

main() {
  atmux::require jq

  local team_name=""
  local force=0
  local wizard=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --name) team_name="$2"; shift 2 ;;
      --force|-f) force=1; shift ;;
      --wizard|-w) wizard=1; shift ;;
      *) atmux::die "init: unknown arg: $1" ;;
    esac
  done

  [[ -z "$team_name" ]] && team_name="$(basename "$PWD")"

  local dir="$PWD/.atmux"
  local tj="$dir/team.json"

  if [[ -f "$tj" && "$force" -ne 1 ]]; then
    atmux::die "already initialized at $tj — pass --force to overwrite"
  fi

  mkdir -p "$dir/inboxes" "$dir/logs" "$dir/state" "$dir/archive"

  if [[ "$wizard" -eq 1 ]]; then
    _atmux_init_wizard "$team_name" "$tj"
  else
    _atmux_init_template "$team_name" "$tj"
  fi

  [[ -f "$(atmux::kanban_json)" ]] || echo '{"tasks":[]}' > "$(atmux::kanban_json)"
  [[ -f "$(atmux::driver_inbox)" ]] || : > "$(atmux::driver_inbox)"

  # Prime per-member inbox files (empty, but present) so inbox/dispatch don't
  # trip on missing files.
  local m
  while IFS= read -r m; do
    [[ -z "$m" ]] && continue
    local ib="$dir/inboxes/$m.json"
    [[ -f "$ib" ]] || echo '{"pending":[],"inProgress":[],"done":[]}' > "$ib"
  done < <(jq -r '.members[].name' "$tj")

  atmux::ok "initialized atmux team '$team_name' at $dir"
  echo ""
  echo "Next:"
  echo "  1. review $tj"
  echo "  2. atmux start"
  echo "  3. atmux tell-lead 'build feature X'"
}

_atmux_init_template() {
  local team_name="$1" tj="$2"
  local tmpl="$ATMUX_ROOT/templates/team.example.json"
  [[ -f "$tmpl" ]] || atmux::die "template missing: $tmpl"
  jq --arg name "$team_name" --arg cwd "$PWD" \
    '.name = $name | (.members[] |= (.cwd = $cwd))' \
    "$tmpl" > "$tj"
}

# ---- wizard ----

_atmux_prompt() {
  # _atmux_prompt <var-name> <prompt> [default]
  local __var="$1" __msg="$2" __default="${3:-}"
  local __input
  if [[ -n "$__default" ]]; then
    printf '%s%s%s [%s]: ' "$atmux_c_cyn" "$__msg" "$atmux_c_rst" "$__default" >&2
  else
    printf '%s%s%s: ' "$atmux_c_cyn" "$__msg" "$atmux_c_rst" >&2
  fi
  IFS= read -r __input
  [[ -z "$__input" ]] && __input="$__default"
  printf -v "$__var" '%s' "$__input"
}

_atmux_prompt_choice() {
  # _atmux_prompt_choice <var> <msg> <default> <choice1> [choice2 ...]
  local __var="$1" __msg="$2" __default="$3"; shift 3
  local __choices=("$@")
  local __input
  local __joined
  __joined="$(printf '%s/' "${__choices[@]}")"
  __joined="${__joined%/}"
  while :; do
    printf '%s%s%s (%s) [%s]: ' "$atmux_c_cyn" "$__msg" "$atmux_c_rst" "$__joined" "$__default" >&2
    IFS= read -r __input
    [[ -z "$__input" ]] && __input="$__default"
    local c
    for c in "${__choices[@]}"; do
      if [[ "$c" == "$__input" ]]; then
        printf -v "$__var" '%s' "$__input"
        return
      fi
    done
    printf '%s  invalid — pick one of: %s%s\n' "$atmux_c_yel" "$__joined" "$atmux_c_rst" >&2
  done
}

_atmux_init_wizard() {
  local default_team="$1" tj="$2"

  echo ""
  echo "╭──────────────────────────────────────────────────────╮"
  echo "│         atmux — team setup wizard                     │"
  echo "╰──────────────────────────────────────────────────────╯"
  echo ""

  local team_name; _atmux_prompt team_name "Team name" "$default_team"

  local include_reviewer include_gitter include_devops
  _atmux_prompt_choice include_reviewer "Include reviewer member" "y" y n
  _atmux_prompt_choice include_gitter   "Include git-committer member" "y" y n
  _atmux_prompt_choice include_devops   "Include devops member" "n" y n

  local n_workers; _atmux_prompt n_workers "Number of worker members" "3"
  [[ "$n_workers" =~ ^[0-9]+$ ]] || { atmux::warn "wizard: bad count, defaulting to 3"; n_workers=3; }

  local discord_hook; _atmux_prompt discord_hook "Discord webhook URL (optional, Enter to skip)" ""

  # Build members array.
  local members_json='[]'
  _append_member() {
    members_json=$(jq --argjson add "$1" '. + [$add]' <<<"$members_json")
  }

  _append_member "$(jq -n --arg cwd "$PWD" \
    '{name:"lead", role:"team-lead", tui:"claude", model:"default", cwd:$cwd}')"

  if [[ "$include_reviewer" == "y" ]]; then
    _append_member "$(jq -n --arg cwd "$PWD" \
      '{name:"reviewer", role:"reviewer", tui:"claude", model:"default", cwd:$cwd}')"
  fi
  if [[ "$include_gitter" == "y" ]]; then
    _append_member "$(jq -n --arg cwd "$PWD" \
      '{name:"gitter", role:"git-committer", tui:"claude", model:"default", cwd:$cwd}')"
  fi
  if [[ "$include_devops" == "y" ]]; then
    _append_member "$(jq -n --arg cwd "$PWD" \
      '{name:"devops", role:"devops", tui:"claude", model:"default", cwd:$cwd}')"
  fi

  local i
  for ((i=1; i<=n_workers; i++)); do
    echo ""
    echo "  — worker #$i —"
    local tui; _atmux_prompt_choice tui "  TUI" "cursor" claude opencode kimi cursor shell
    local default_model
    case "$tui" in
      claude)   default_model="default" ;;
      opencode) default_model="default" ;;
      kimi)     default_model="default" ;;
      cursor)   default_model="default" ;;
      shell)    default_model="default" ;;
    esac
    local model; _atmux_prompt model "  model (default uses atmux default for this TUI)" "$default_model"
    local suggested_name
    case "$tui" in
      claude)   suggested_name="claude-$i" ;;
      opencode) suggested_name="minimax-$i" ;;
      kimi)     suggested_name="kimi-$i" ;;
      cursor)   suggested_name="cursor-$i" ;;
      shell)    suggested_name="shell-$i" ;;
    esac
    local mname; _atmux_prompt mname "  member name" "$suggested_name"

    _append_member "$(jq -n \
      --arg name "$mname" --arg tui "$tui" --arg model "$model" --arg cwd "$PWD" \
      '{name:$name, role:"member", tui:$tui, model:$model, cwd:$cwd}')"
  done

  jq -n \
    --arg name "$team_name" \
    --arg desc "atmux team — created via wizard" \
    --argjson members "$members_json" \
    --arg hook "$discord_hook" \
    '{
       name: $name,
       description: $desc,
       members: $members,
       whip:   {intervalMins: 5, staleMin: 30, leadMaxMin: 60},
       report: {intervalMins: 30}
     }
     + (if $hook == "" then {} else {discord: {webhook: $hook}} end)' > "$tj"

  echo ""
  atmux::ok "wizard complete — wrote $tj"
  if [[ -n "$discord_hook" ]]; then
    echo ""
    echo "  Tip: export your webhook so whip/report can ping it:"
    echo "    export ATMUX_DISCORD_WEBHOOK='$discord_hook'"
  fi
}
