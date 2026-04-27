#!/usr/bin/env bash
# atmux init [--name <team>] [--wizard] [--force]
#
# Default: non-interactive, scaffolds from templates/team.example.json.
# --wizard: interactive prompts to build a team.json from scratch.

# shellcheck source=emoji.sh
. "$ATMUX_LIB_DIR/emoji.sh"

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

  # Per t-2f13a2e4: --force overwrites are the only init path that touches
  # an existing team.json. Capture a timestamped .bak before the write so
  # an accidental --force (from a test fixture or otherwise) leaves a
  # recovery point. Bare init never sees an existing file (gated above).
  if [[ "$force" -eq 1 ]]; then
    ATMUX_DIR="$dir" atmux::team_json_backup >/dev/null
  fi

  if [[ "$wizard" -eq 1 ]]; then
    _atmux_init_wizard "$team_name" "$tj"
  else
    _atmux_init_template "$team_name" "$tj"
  fi

  [[ -f "$(atmux::kanban_json)" ]] || echo '{"tasks":[],"epics":[],"stories":[]}' > "$(atmux::kanban_json)"
  [[ -f "$(atmux::driver_inbox)" ]] || : > "$(atmux::driver_inbox)"

  # Prime per-member inbox files (empty, but present) so inbox/dispatch don't
  # trip on missing files.
  local m
  while IFS= read -r m; do
    [[ -z "$m" ]] && continue
    local ib="$dir/inboxes/$m.json"
    [[ -f "$ib" ]] || echo '{"pending":[],"inProgress":[],"done":[]}' > "$ib"
  done < <(jq -r '.members[].name' "$tj")

  # E10/Sa t-1f2bcb96 (ADR-025) — register the team in the global fleet
  # registry so super-status / cross-team helpers can enumerate without
  # filesystem heuristics. Single-session teams (per ADR-016) use the
  # legacy `atmux-<team>` name as a placeholder here; lib/start.sh's
  # registry_touch hook refreshes the sessionName to the actual driver
  # session once .atmux/state/session.txt is seeded. Best-effort —
  # registry lock contention / perms / missing-helper shouldn't fail
  # init; the team can still operate locally without registry presence.
  if [[ -f "$ATMUX_LIB_DIR/registry.sh" ]]; then
    # shellcheck source=registry.sh
    . "$ATMUX_LIB_DIR/registry.sh"
    if declare -F atmux::registry_upsert >/dev/null 2>&1; then
      atmux::registry_upsert "$team_name" "$PWD" "atmux-$team_name" 2>/dev/null \
        || atmux::warn "registry_upsert failed for '$team_name' — team initialized but not in fleet registry"
    fi
  fi

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
  # tmuxTmpdir defaults to /tmp/atmux-tmux-<name> so a buggy or stress-test
  # team can never wedge the user's daily-driver tmux server. Incident
  # 2026-04-27: a `smoke-stop` scaffold ran on the shared default socket and
  # a SIGCHLD storm from ~30 simultaneous pane teardowns wedged tmux 3.x for
  # every other session on the box. Per-team socket = blast-radius firewall.
  # Pair `atmux-tmux attach` with the field — that wrapper resolves the
  # socket from team.json so operators don't have to remember the path.
  jq --arg name "$team_name" --arg cwd "$PWD" \
    '.name = $name
     | .tmuxTmpdir = "/tmp/atmux-tmux-" + $name
     | (.members[] |= (.cwd = $cwd))' \
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

# Try to figure out what shell command the user's interactive shell uses for a
# given binary. Falls back to the binary name if nothing useful turns up.
_atmux_detect_tui_alias() {
  local bin="$1"
  local alias_line
  # zsh / bash `alias` output. Run an interactive shell so rc files load.
  # Null-route stderr because un-aliased bins print to stderr in some shells.
  if [[ -n "${ZSH_NAME:-}" ]] || [[ "${SHELL:-}" == */zsh ]]; then
    alias_line=$(zsh -ic "alias $bin 2>/dev/null" 2>/dev/null | head -1 || true)
  else
    alias_line=$(bash -ic "alias $bin 2>/dev/null" 2>/dev/null | head -1 || true)
  fi
  # Formats:
  #   zsh:  "alias claude='command claude --plugin-dir=…'"
  #   bash: "alias claude='claude --plugin-dir=…'"
  if [[ -n "$alias_line" ]]; then
    # Strip leading "alias <name>=" and the surrounding quotes, then drop a leading "command ".
    local cmd
    cmd=$(printf '%s' "$alias_line" \
      | sed -E "s/^alias[[:space:]]+${bin}='(.*)'$/\1/" \
      | sed -E 's/^command[[:space:]]+//')
    if [[ -n "$cmd" && "$cmd" != "$alias_line" ]]; then
      printf '%s' "$cmd"
      return
    fi
  fi
  printf '%s' "$bin"
}

_atmux_init_wizard() {
  local default_team="$1" tj="$2"

  echo ""
  echo "╭──────────────────────────────────────────────────────╮"
  echo "│         atmux — team setup wizard                     │"
  echo "╰──────────────────────────────────────────────────────╯"
  echo ""

  local team_name; _atmux_prompt team_name "Team name" "$default_team"

  # Preset mode determines default TUI assignment for staff + workers.
  #   perf     → every member on claude (highest capability, most expensive)
  #   default  → staff claude + workers spread across cursor/opencode/kimi   [DEFAULT]
  #   eco      → every member on opencode (MiniMax) — cheapest, lowest capability
  #   custom   → each worker prompted for its TUI individually
  local preset
  _atmux_prompt_choice preset \
    "Preset (perf=all-claude / default=staff-claude+cheap-workers / eco=all-MiniMax / custom=prompt each)" \
    "default" perf default eco custom

  local staff_tui="claude"
  [[ "$preset" == "eco" ]] && staff_tui="opencode"

  local include_planner include_reviewer include_gitter include_devops include_dba include_unblocker include_discorder
  _atmux_prompt_choice include_planner    "Include planner member (owns decomposition + ADRs)" "y" y n
  _atmux_prompt_choice include_reviewer   "Include reviewer member"  "y" y n
  _atmux_prompt_choice include_gitter     "Include gitter member (git commits + push)" "y" y n
  _atmux_prompt_choice include_devops     "Include devops member"    "n" y n
  _atmux_prompt_choice include_dba        "Include dba member (schema / migrations / SQL)" "n" y n
  _atmux_prompt_choice include_unblocker  "Include unblocker member (jam-buster — pulls stuck Tasks across lanes)" "n" y n
  _atmux_prompt_choice include_discorder  "Include discorder member (scheduled Discord pings — progress digest + heartbeat)" "n" y n

  local n_workers; _atmux_prompt n_workers "Number of worker members" "3"
  [[ "$n_workers" =~ ^[0-9]+$ ]] || { atmux::warn "wizard: bad count, defaulting to 3"; n_workers=3; }

  local emoji_mode
  _atmux_prompt_choice emoji_mode \
    "Emoji mode (static=fixed per role / random=varied per role / ai=claude picks per member)" \
    "random" static random ai

  local discord_hook; _atmux_prompt discord_hook "Discord webhook URL (optional, Enter to skip)" ""

  # ADR-026: every team defaults to singleSession=true (supersedes the
  # ADR-016 opt-in prompt). The wizard no longer asks; team.json gets
  # `singleSession: true` unconditionally below. The `singleSession=false`
  # legacy mode (dedicated `atmux-<team>` session) is retained as a
  # declared (not prompted) escape hatch — operators set it by hand in
  # team.json for non-human-driven teams or detached observer setups.

  # ADR-018: cage tmux socket isolation. Default y after the 2026-04-27
  # incident — 6 daily-driver tmux deaths in 5 days because the dogfood
  # team shared the operator's default socket. Opt-out for shared-socket
  # mode (where attach is `tmux attach`, no need to remember the cage
  # path) is rare — typically observer-only teams that never run
  # destructive verbs. Most users want y. The `atmux-tmux` sibling binary
  # auto-resolves the socket from team.json, so the operator never has
  # to type the path themselves.
  local cage_isolation
  _atmux_prompt_choice cage_isolation \
    "Run team on its own isolated tmux socket? (recommended — protects your daily-driver tmux from buggy kill-session calls; attach via 'atmux-tmux attach')" \
    "y" y n
  local cage_tmpdir=""
  [[ "$cage_isolation" == "y" ]] && cage_tmpdir="/tmp/atmux-tmux-$team_name"

  # ---- TUI launch commands ----
  # Ask the user for custom launch commands for every TUI we'll end up using.
  # This is how users plug in aliases like `claude --plugin-dir=/path` or a
  # wrapper script. Detect a few common candidates to use as defaults.
  echo ""
  echo "Register TUI launch commands. Press Enter to accept the default binary,"
  echo "or paste a full command (e.g. \`claude --plugin-dir=\$HOME/work/journals/.sb/claude-skills\`)."
  echo ""

  local tui_cmd_claude tui_cmd_opencode tui_cmd_kimi tui_cmd_cursor
  local claude_default; claude_default="$(_atmux_detect_tui_alias claude)"
  local opencode_default; opencode_default="$(_atmux_detect_tui_alias opencode)"
  local kimi_default; kimi_default="$(_atmux_detect_tui_alias kimi)"
  local cursor_default; cursor_default="$(_atmux_detect_tui_alias cursor-agent)"
  _atmux_prompt tui_cmd_claude   "  claude launch command"    "$claude_default"
  _atmux_prompt tui_cmd_opencode "  opencode launch command"  "$opencode_default"
  _atmux_prompt tui_cmd_kimi     "  kimi launch command"      "$kimi_default"
  _atmux_prompt tui_cmd_cursor   "  cursor launch command"    "$cursor_default"

  # Mode resolution during the wizard reads from this env — team.json doesn't
  # exist yet, so ATMUX_EMOJI_MODE is the only signal emoji.sh can see.
  export ATMUX_EMOJI_MODE="$emoji_mode"

  # Build members array. Each appended member gets an emoji stamped in,
  # picked so duplicates within the team are avoided when possible.
  local members_json='[]'
  local emojis_seen=""
  _append_member() {
    local mj="$1"
    local mname mrole memoji mlane
    mname="$(jq -r '.name' <<<"$mj")"
    mrole="$(jq -r '.role' <<<"$mj")"
    memoji="$(atmux::emoji_assign "$mname" "$mrole" "$emojis_seen")"
    emojis_seen="$emojis_seen $memoji"
    mlane="$(atmux::lane_for_name "$mname" "$mrole")"
    mj="$(jq --arg e "$memoji" --arg l "$mlane" '. + {lane: $l, emoji: $e}' <<<"$mj")"
    members_json=$(jq --argjson add "$mj" '. + [$add]' <<<"$members_json")
  }

  [[ "$emoji_mode" == "ai" ]] && atmux::log "emoji mode=ai — asking claude to pick per member (slower)"

  _append_member "$(jq -n --arg cwd "$PWD" --arg tui "$staff_tui" \
    '{name:"lead", role:"team-lead", tui:$tui, model:"default", cwd:$cwd}')"

  if [[ "$include_planner" == "y" ]]; then
    _append_member "$(jq -n --arg cwd "$PWD" --arg tui "$staff_tui" \
      '{name:"planner", role:"planner", tui:$tui, model:"default", cwd:$cwd}')"
  fi
  if [[ "$include_reviewer" == "y" ]]; then
    _append_member "$(jq -n --arg cwd "$PWD" --arg tui "$staff_tui" \
      '{name:"reviewer", role:"reviewer", tui:$tui, model:"default", cwd:$cwd}')"
  fi
  if [[ "$include_gitter" == "y" ]]; then
    _append_member "$(jq -n --arg cwd "$PWD" --arg tui "$staff_tui" \
      '{name:"gitter", role:"gitter", tui:$tui, model:"default", cwd:$cwd}')"
  fi
  if [[ "$include_devops" == "y" ]]; then
    _append_member "$(jq -n --arg cwd "$PWD" --arg tui "$staff_tui" \
      '{name:"devops", role:"devops", tui:$tui, model:"default", cwd:$cwd}')"
  fi
  if [[ "$include_dba" == "y" ]]; then
    _append_member "$(jq -n --arg cwd "$PWD" --arg tui "$staff_tui" \
      '{name:"dba", role:"dba", tui:$tui, model:"default", cwd:$cwd}')"
  fi
  if [[ "$include_unblocker" == "y" ]]; then
    _append_member "$(jq -n --arg cwd "$PWD" --arg tui "$staff_tui" \
      '{name:"unblocker", role:"unblocker", tui:$tui, model:"default", cwd:$cwd}')"
  fi
  if [[ "$include_discorder" == "y" ]]; then
    _append_member "$(jq -n --arg cwd "$PWD" --arg tui "$staff_tui" \
      '{name:"discorder", role:"discorder", tui:$tui, model:"default", cwd:$cwd}')"
  fi

  # Preset-driven worker TUI picker.
  # Returns the TUI for worker index $i under the active preset, or "" if the
  # caller should prompt (custom preset). Standard cycles cursor/opencode/kimi
  # to spread workers across TUIs for cost + latency variety.
  _preset_worker_tui() {
    local idx="$1"
    case "$preset" in
      perf)    echo "claude" ;;
      eco)     echo "opencode" ;;
      default)
        local cycle=(cursor opencode kimi)
        echo "${cycle[$(( (idx - 1) % 3 ))]}"
        ;;
      *) echo "" ;;  # custom: caller prompts
    esac
  }

  # Suggested name for a worker: feature-lane prefix by default. User always
  # gets a prompt so they can rename to "fe-auth" / "be-invoice" / etc.
  _suggested_worker_name() {
    local idx="$1" tui="$2"
    case "$tui" in
      claude)   echo "claude-$idx" ;;
      opencode) echo "minimax-$idx" ;;
      kimi)     echo "kimi-$idx" ;;
      cursor)   echo "cursor-$idx" ;;
      shell)    echo "shell-$idx" ;;
    esac
  }

  local i
  for ((i=1; i<=n_workers; i++)); do
    echo ""
    echo "  — worker #$i —"
    local tui
    local preset_tui; preset_tui="$(_preset_worker_tui "$i")"
    if [[ -n "$preset_tui" ]]; then
      tui="$preset_tui"
      printf '    tui:   %s  %s(preset=%s)%s\n' \
        "$tui" "$atmux_c_dim" "$preset" "$atmux_c_rst"
    else
      _atmux_prompt_choice tui "  TUI" "cursor" claude opencode kimi cursor shell
    fi
    local model; _atmux_prompt model "  model (default uses atmux default for this TUI)" "default"
    local suggested_name; suggested_name="$(_suggested_worker_name "$i" "$tui")"
    local mname; _atmux_prompt mname "  member name (e.g. fe-auth, be-invoice, db-orders)" "$suggested_name"

    _append_member "$(jq -n \
      --arg name "$mname" --arg tui "$tui" --arg model "$model" --arg cwd "$PWD" \
      '{name:$name, role:"member", tui:$tui, model:$model, cwd:$cwd}')"
  done

  # Only register tuiCommands entries that differ from the bare binary name
  # (otherwise the built-in default is already perfect and we'd just add noise).
  local tui_commands
  tui_commands="$(jq -n \
    --arg claude   "$tui_cmd_claude" \
    --arg opencode "$tui_cmd_opencode" \
    --arg kimi     "$tui_cmd_kimi" \
    --arg cursor   "$tui_cmd_cursor" \
    '{}
     + (if $claude   != "" and $claude   != "claude"        then {claude:   $claude}   else {} end)
     + (if $opencode != "" and $opencode != "opencode"      then {opencode: $opencode} else {} end)
     + (if $kimi     != "" and $kimi     != "kimi"          then {kimi:     $kimi}     else {} end)
     + (if $cursor   != "" and $cursor   != "cursor-agent"  then {cursor:   $cursor}   else {} end)')"

  # tmuxTmpdir from the wizard prompt above — empty string means user opted
  # out of cage isolation (shared default-socket mode). See _atmux_init_template
  # comment for the 2026-04-27 incident that motivated default-on isolation.
  # singleSession hardcoded true per ADR-026 — escape hatch is manual
  # team.json edit, not a wizard prompt.
  jq -n \
    --arg name "$team_name" \
    --arg desc "atmux team — created via wizard" \
    --argjson members "$members_json" \
    --argjson tuis "$tui_commands" \
    --arg hook "$discord_hook" \
    --arg emoji_mode "$emoji_mode" \
    --arg cage "$cage_tmpdir" \
    '{
       name: $name,
       description: $desc,
       tuiCommands: $tuis,
       members: $members,
       emojis: {mode: $emoji_mode},
       whip:   {intervalMins: 5, staleMin: 90, leadMaxMin: 60},
       report: {intervalMins: 30},
       singleSession: true
     }
     + (if $cage == "" then {} else {tmuxTmpdir: $cage}              end)
     + (if $hook == "" then {} else {discord: {webhook: $hook}}      end)' > "$tj"

  echo ""
  atmux::ok "wizard complete — wrote $tj"
  if [[ -n "$cage_tmpdir" ]]; then
    echo ""
    echo "  Cage tmux socket: $cage_tmpdir"
    echo "  Attach with:        atmux-tmux attach"
    echo "                      (or:  tmux -S $cage_tmpdir/tmux-\$UID/default attach)"
    echo "  All atmux verbs invoked from this dir auto-target the cage."
  fi
  if [[ -n "$discord_hook" ]]; then
    echo ""
    echo "  Tip: export your webhook so whip/report can ping it:"
    echo "    export ATMUX_DISCORD_WEBHOOK='$discord_hook'"
  fi
}
