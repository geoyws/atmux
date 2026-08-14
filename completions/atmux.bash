# atmux(1) bash completion. Source this file from your .bashrc:
#
#   . /path/to/atmux/completions/atmux.bash
#
# or copy into /etc/bash_completion.d/.

_atmux_complete() {
  local cur prev words cword
  _init_completion 2>/dev/null || {
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    words=("${COMP_WORDS[@]}")
    cword=$COMP_CWORD
  }

  local verbs="up init start stop attach status send broadcast tell-lead reply outbox task epic story decisions dispatch inbox claim done report whip cost rotate rotate-lead handoff pause resume add-member reconfigure doctor dashboard voice version help"

  if [[ $cword -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$verbs" -- "$cur") )
    return 0
  fi

  local verb="${words[1]}"

  local team_json
  team_json="$(_atmux_find_team_json 2>/dev/null)"
  local members=""
  if [[ -n "$team_json" ]]; then
    members=$(jq -r '.members[].name' "$team_json" 2>/dev/null | tr '\n' ' ')
  fi

  # Lane + state enums (kept aligned with lib/kanban.sh + lib/epic.sh + lib/story.sh).
  local lanes="fe be db ops test review misc"
  local epic_states="planning ready in-progress review done"
  local story_states="planning ready in-progress testing review merging done"
  local reversibilities="low medium high"

  # Per-flag completions: handle when the previous token is a flag expecting an enum.
  case "$prev" in
    --lane)          COMPREPLY=( $(compgen -W "$lanes" -- "$cur") );          return 0 ;;
    --reversibility) COMPREPLY=( $(compgen -W "$reversibilities" -- "$cur") ); return 0 ;;
    --to)
      # --to value depends on which verb chain we're in; epic vs story.
      if [[ "$verb" == "epic" ]]; then
        COMPREPLY=( $(compgen -W "$epic_states" -- "$cur") )
      elif [[ "$verb" == "story" ]]; then
        COMPREPLY=( $(compgen -W "$story_states" -- "$cur") )
      fi
      return 0 ;;
    --status)
      if [[ "$verb" == "epic" ]]; then
        COMPREPLY=( $(compgen -W "$epic_states" -- "$cur") )
      elif [[ "$verb" == "story" ]]; then
        COMPREPLY=( $(compgen -W "$story_states" -- "$cur") )
      else
        COMPREPLY=( $(compgen -W "todo in-progress done blocked" -- "$cur") )
      fi
      return 0 ;;
    --assignee|--as)
      COMPREPLY=( $(compgen -W "$members" -- "$cur") )
      return 0 ;;
  esac

  case "$verb" in
    send|inbox|dispatch|rotate|pause|resume|handoff)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "$members" -- "$cur") )
        return 0
      fi
      ;;
    task)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "add list show move assign rm" -- "$cur") )
        return 0
      fi
      # task add flags
      if [[ "${words[2]}" == "add" && "$cur" == --* ]]; then
        COMPREPLY=( $(compgen -W "--body --epic --story --lane --deliverable --assignee --deps --priority" -- "$cur") )
        return 0
      fi
      if [[ "${words[2]}" == "list" && "$cur" == --* ]]; then
        COMPREPLY=( $(compgen -W "--status --assignee --json" -- "$cur") )
        return 0
      fi
      ;;
    epic)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "add list show advance" -- "$cur") )
        return 0
      fi
      if [[ "$cur" == --* ]]; then
        case "${words[2]}" in
          add)     COMPREPLY=( $(compgen -W "--body --driver-ref" -- "$cur") );    return 0 ;;
          list)    COMPREPLY=( $(compgen -W "--status --json" -- "$cur") );        return 0 ;;
          show)    COMPREPLY=( $(compgen -W "--json" -- "$cur") );                 return 0 ;;
          advance) COMPREPLY=( $(compgen -W "--to" -- "$cur") );                   return 0 ;;
        esac
      fi
      ;;
    story)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "add list show advance" -- "$cur") )
        return 0
      fi
      if [[ "$cur" == --* ]]; then
        case "${words[2]}" in
          add)     COMPREPLY=( $(compgen -W "--epic --ac --body" -- "$cur") );      return 0 ;;
          list)    COMPREPLY=( $(compgen -W "--epic --status --json" -- "$cur") );  return 0 ;;
          show)    COMPREPLY=( $(compgen -W "--json" -- "$cur") );                  return 0 ;;
          advance) COMPREPLY=( $(compgen -W "--to" -- "$cur") );                    return 0 ;;
        esac
      fi
      ;;
    decisions)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "add list show" -- "$cur") )
        return 0
      fi
      if [[ "$cur" == --* ]]; then
        case "${words[2]}" in
          add)  COMPREPLY=( $(compgen -W "--default --reversibility --note" -- "$cur") );    return 0 ;;
          list) COMPREPLY=( $(compgen -W "--since --reversibility --json" -- "$cur") );      return 0 ;;
        esac
      fi
      ;;
    claim)
      # `claim --next [--lane <l>] [--as <m>]` or `claim <task-id> [--as <m>]`
      if [[ "$cur" == --* ]]; then
        COMPREPLY=( $(compgen -W "--next --lane --as" -- "$cur") )
        return 0
      fi
      ;;
    done)
      if [[ "$cur" == --* ]]; then
        COMPREPLY=( $(compgen -W "--as --note" -- "$cur") )
        return 0
      fi
      ;;
    init)
      if [[ "$cur" == --* ]]; then
        COMPREPLY=( $(compgen -W "--name --wizard --force" -- "$cur") )
        return 0
      fi
      ;;
    voice)
      if [[ "$prev" == "--provider" ]]; then
        COMPREPLY=( $(compgen -W "openai openai-realtime gemini gemini-live" -- "$cur") )
        return 0
      fi
      if [[ "$cur" == --* ]]; then
        COMPREPLY=( $(compgen -W "--serve --supervise --status --stop --port --provider --model --readonly --max-frames --print-assets-dir" -- "$cur") )
        return 0
      fi
      ;;
  esac
  COMPREPLY=()
}

_atmux_find_team_json() {
  local d="$PWD"
  while [[ "$d" != "/" ]]; do
    if [[ -f "$d/.atmux/team.json" ]]; then
      echo "$d/.atmux/team.json"; return 0
    fi
    d="$(dirname "$d")"
  done
  return 1
}

complete -F _atmux_complete atmux
