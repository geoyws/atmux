#!/usr/bin/env bash
# atmux inbox <member> [--json]
# Show the member's inbox (pending / in-progress / done).

main() {
  atmux::require jq
  atmux::require_team

  local member="" json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json) json=1; shift ;;
      *) if [[ -z "$member" ]]; then member="$1"; shift; else atmux::die "inbox: too many args"; fi ;;
    esac
  done
  [[ -n "$member" ]] || atmux::die "usage: atmux inbox <member>"

  local f="$(atmux::inbox_dir)/$member.json"
  if [[ ! -f "$f" ]]; then
    # Verify the member at least exists in team.json; then lazily materialise.
    atmux::member_json "$member" >/dev/null
    mkdir -p "$(dirname "$f")"
    echo '{"pending":[],"inProgress":[],"done":[]}' > "$f"
  fi

  if [[ "$json" -eq 1 ]]; then
    cat "$f"; return
  fi

  printf '%sinbox — %s%s\n\n' "$atmux_c_bld" "$member" "$atmux_c_rst"

  _atmux_inbox_section() {
    local key="$1" label="$2" color="$3"
    printf '%s%s%s\n' "$color" "$label" "$atmux_c_rst"
    local rows; rows=$(jq -r ".${key}[] | [.id, (.subject // \"\")] | @tsv" "$f" 2>/dev/null)
    if [[ -z "$rows" ]]; then
      printf '  (empty)\n'
    else
      echo "$rows" | awk -F'\t' '{printf "  %-10s %s\n", $1, $2}'
    fi
    echo ""
  }
  _atmux_inbox_section pending    "pending"     "$atmux_c_yel"
  _atmux_inbox_section inProgress "in-progress" "$atmux_c_cyn"
  _atmux_inbox_section done       "done"        "$atmux_c_grn"
}
