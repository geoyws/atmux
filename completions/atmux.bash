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

  local verbs="init start stop attach status send broadcast tell-lead reply outbox task dispatch inbox claim done report whip cost rotate rotate-lead handoff pause resume add-member reconfigure version help"

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

  case "$verb" in
    send|inbox|dispatch|rotate|pause|resume|handoff)
      COMPREPLY=( $(compgen -W "$members" -- "$cur") )
      return 0 ;;
    task)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "add list show move assign rm" -- "$cur") )
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
