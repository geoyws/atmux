#!/usr/bin/env bash
# atmux flags <verb> [args]
#   add     <message> --severity p0|p1|p2
#                     --needs    decision|review|context|unblock|rotate
#                     [--as <member>] [--task <id>] [--note <text>]
#   list    [--severity <s>] [--needs <n>] [--status open|resolved]
#           [--since <when>] [--member <m>] [--json]
#   show    <id>
#   resolve <id> [--as <member>] [--note <text>]
#
# Sibling to lib/decisions.sh. Append-only markdown log at .atmux/flags.md;
# each Flag is a `### f-xxxxxxxx` heading; each Resolution is a `### r-xxxxxxxx
# f-xxxxxxxx` heading whose second field is the parent flag id. open = no
# resolution exists referencing the flag id; resolved = at least one does.
#
# Per ADR-008/d-485b965d the message is length-validated (≤60 chars ERROR, no
# silent-truncate) so any future Discord-template path stays inside the
# ≤80-char-per-bullet budget.
#
# OUT OF SCOPE for this Task (E4/S1): Discord pings, tmux integration, kanban
# --task cross-validation. Those land in S2/S3/S4.

main() {
  atmux::require jq
  atmux::require_team

  local verb="${1:-}"; shift || true
  case "$verb" in
    add)            _atmux_flags_add "$@" ;;
    list|ls)        _atmux_flags_list "$@" ;;
    show|get)       _atmux_flags_show "$@" ;;
    resolve)        _atmux_flags_resolve "$@" ;;
    "")             atmux::die "flags: missing verb (add|list|show|resolve)" ;;
    *)              atmux::die "flags: unknown verb: $verb (use add|list|show|resolve)" ;;
  esac
}

# ---------- paths + helpers ----------

_flags_file() { printf '%s/flags.md\n' "$(atmux::dir)"; }

_flags_gen_id()         { printf 'f-%s\n' "$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"; }
_flags_gen_resolution() { printf 'r-%s\n' "$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"; }

_flags_oneline() {
  printf '%s' "$1" | tr '\n\r\t' '   '
}

_flags_validate_severity() {
  case "$1" in p0|p1|p2) ;;
    *) atmux::die "flags: --severity must be p0|p1|p2 (got: $1)" ;;
  esac
}
_flags_validate_needs() {
  case "$1" in decision|review|context|unblock|rotate) ;;
    *) atmux::die "flags: --needs must be decision|review|context|unblock|rotate (got: $1)" ;;
  esac
}

# Parse the markdown log into {flags:[], resolutions:[]}. Same TSV-via-awk
# pattern as lib/decisions.sh's _decisions_to_json_array.
_flags_to_json() {
  local f="$1"
  if [[ ! -f "$f" ]]; then
    echo '{"flags":[],"resolutions":[]}'
    return
  fi
  awk '
    function flush_flag() {
      if (kind == "f" && id != "") {
        printf "F\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
          id, ts, member, severity, needs, task, message, note
      } else if (kind == "r" && id != "") {
        printf "R\t%s\t%s\t%s\t%s\t%s\n",
          id, flag, ts, by, note
      }
    }
    /^### f-/ {
      flush_flag()
      kind="f"; id=$2
      ts=0; member=""; severity=""; needs=""; task=""; message=""; note=""; flag=""; by=""
    }
    /^### r-/ {
      flush_flag()
      kind="r"; id=$2; flag=$3
      ts=0; member=""; severity=""; needs=""; task=""; message=""; note=""; by=""
    }
    /^- \*\*timestamp\*\*:/ { v=$0; sub(/^- \*\*timestamp\*\*: */,"",v); ts=v+0 }
    /^- \*\*member\*\*:/    { v=$0; sub(/^- \*\*member\*\*: */,"",v);    member=v }
    /^- \*\*severity\*\*:/  { v=$0; sub(/^- \*\*severity\*\*: */,"",v);  severity=v }
    /^- \*\*needs\*\*:/     { v=$0; sub(/^- \*\*needs\*\*: */,"",v);     needs=v }
    /^- \*\*task\*\*:/      { v=$0; sub(/^- \*\*task\*\*: */,"",v);      task=v }
    /^- \*\*message\*\*:/   { v=$0; sub(/^- \*\*message\*\*: */,"",v);   message=v }
    /^- \*\*note\*\*:/      { v=$0; sub(/^- \*\*note\*\*: */,"",v);      note=v }
    /^- \*\*by\*\*:/        { v=$0; sub(/^- \*\*by\*\*: */,"",v);        by=v }
    END { flush_flag() }
  ' "$f" | jq -Rn '
    [inputs | select(length > 0) | split("\t")] as $rows
    | {
        flags: [
          $rows[] | select(.[0] == "F") | {
            id: .[1],
            timestamp: (.[2] | tonumber),
            member: .[3],
            severity: .[4],
            needs: .[5],
            task: (if (.[6] // "") == "" or .[6] == "null" then null else .[6] end),
            message: .[7],
            note: (if (.[8] // "") == "" or .[8] == "null" then null else .[8] end)
          }
        ],
        resolutions: [
          $rows[] | select(.[0] == "R") | {
            id: .[1],
            flag: .[2],
            timestamp: (.[3] | tonumber),
            by: .[4],
            note: (if (.[5] // "") == "" or .[5] == "null" then null else .[5] end)
          }
        ]
      }
  '
}

# Accept ISO date / Nh / Nd. Same shape as lib/decisions.sh's _decisions_parse_since.
_flags_parse_since() {
  local s="$1"
  if [[ "$s" =~ ^([0-9]+)h$ ]]; then
    echo $(( $(atmux::now_epoch) - BASH_REMATCH[1] * 3600 ))
  elif [[ "$s" =~ ^([0-9]+)d$ ]]; then
    echo $(( $(atmux::now_epoch) - BASH_REMATCH[1] * 86400 ))
  else
    if ! date -d "$s" +%s 2>/dev/null; then
      atmux::die "flags list: bad --since format '$s' (use ISO date or Nh/Nd)"
    fi
  fi
}

_flags_resolve_member() {
  local who="$1"
  if [[ -z "$who" ]]; then
    who="${ATMUX_MEMBER:-}"
    if [[ -z "$who" ]]; then
      who="$(jq -r --arg cwd "$PWD" '.members[]? | select(.cwd == $cwd) | .name' "$(atmux::team_json)" | head -1)"
    fi
  fi
  [[ -n "$who" ]] || atmux::die "flags: can't infer member — pass --as <member> or set ATMUX_MEMBER"
  printf '%s\n' "$who"
}

# ---------- add ----------

_atmux_flags_add() {
  local message="" severity="" needs="" who="" task="" note=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --severity) severity="$2"; shift 2 ;;
      --needs)    needs="$2"; shift 2 ;;
      --as)       who="$2"; shift 2 ;;
      --task)     task="$2"; shift 2 ;;
      --note)     note="$2"; shift 2 ;;
      --) shift; message="$*"; break ;;
      -*) atmux::die "flags add: unknown flag: $1" ;;
      *)
        if [[ -z "$message" ]]; then message="$1"; else message="$message $1"; fi
        shift ;;
    esac
  done
  [[ -n "$message"  ]] || atmux::die "flags add: <message> required"
  [[ -n "$severity" ]] || atmux::die "flags add: --severity <p0|p1|p2> required"
  [[ -n "$needs"    ]] || atmux::die "flags add: --needs <decision|review|context|unblock|rotate> required"
  _flags_validate_severity "$severity"
  _flags_validate_needs "$needs"

  message="$(_flags_oneline "$message")"
  note="$(_flags_oneline "$note")"

  # ≤60-char message gate — same Discord-budget framing as decisions add even
  # though Discord wiring is deferred to S2 (per ADR-008 / d-485b965d).
  if (( ${#message} > 60 )); then
    atmux::die "flags add: message exceeds 60 chars (Discord ≤80 budget); rewrite tighter"
  fi

  local member; member="$(_flags_resolve_member "$who")"
  local id; id="$(_flags_gen_id)"
  local epoch; epoch="$(atmux::now_epoch)"
  local hhmm; hhmm="$(atmux::now_myt)"

  local f; f="$(_flags_file)"
  atmux::with_lock "$f" _flags_append_entry \
    "$f" "$id" "$epoch" "$hhmm" "$member" "$severity" "$needs" "$task" "$message" "$note"

  atmux::ok "flags: recorded $id"
  printf '%s\n' "$id"
}

_flags_append_entry() {
  local f="$1" id="$2" epoch="$3" hhmm="$4" member="$5" severity="$6" \
        needs="$7" task="$8" message="$9" note="${10}"

  if [[ ! -f "$f" ]]; then
    cat > "$f" <<'EOF'
# atmux flags — append-only operator log

Members raise flags via `atmux flags add` for things that need driver/lead
attention but aren't a decision (use `atmux decisions` for those). Resolve
with `atmux flags resolve <id>`.

EOF
  fi

  {
    printf '\n### %s %s [%s/%s] (%s)\n\n' "$id" "$member" "$severity" "$needs" "$hhmm"
    printf -- '- **timestamp**: %s\n' "$epoch"
    printf -- '- **member**: %s\n'    "$member"
    printf -- '- **severity**: %s\n'  "$severity"
    printf -- '- **needs**: %s\n'     "$needs"
    if [[ -n "$task" ]]; then
      printf -- '- **task**: %s\n' "$task"
    else
      printf -- '- **task**: null\n'
    fi
    printf -- '- **message**: %s\n' "$message"
    if [[ -n "$note" ]]; then
      printf -- '- **note**: %s\n' "$note"
    else
      printf -- '- **note**: null\n'
    fi
  } >> "$f"
}

# ---------- list ----------

_atmux_flags_list() {
  local fsev="" fneeds="" fstatus="" fsince="" fmember="" json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --severity) fsev="$2"; shift 2 ;;
      --needs)    fneeds="$2"; shift 2 ;;
      --status)   fstatus="$2"; shift 2 ;;
      --since)    fsince="$2"; shift 2 ;;
      --member)   fmember="$2"; shift 2 ;;
      --json)     json=1; shift ;;
      *) atmux::die "flags list: unknown arg: $1" ;;
    esac
  done

  [[ -n "$fsev"   ]] && _flags_validate_severity "$fsev"
  [[ -n "$fneeds" ]] && _flags_validate_needs "$fneeds"
  if [[ -n "$fstatus" ]]; then
    case "$fstatus" in open|resolved) ;;
      *) atmux::die "flags list: --status must be open|resolved" ;;
    esac
  fi
  local cutoff=0
  [[ -n "$fsince" ]] && cutoff="$(_flags_parse_since "$fsince")"

  local f; f="$(_flags_file)"
  local model; model="$(_flags_to_json "$f")"

  # Tag each flag with .resolved + .resolutions before applying filters.
  local enriched; enriched="$(jq '
    .flags as $flags
    | .resolutions as $rs
    | $flags | map(
        . as $fl
        | . + { resolutions: ($rs | map(select(.flag == $fl.id)) | sort_by(.timestamp)),
                resolved:    ($rs | any(.flag == $fl.id)) }
      )
  ' <<<"$model")"

  local filt='.'
  [[ -n "$fsev"     ]] && filt="$filt | map(select(.severity == \"$fsev\"))"
  [[ -n "$fneeds"   ]] && filt="$filt | map(select(.needs    == \"$fneeds\"))"
  [[ -n "$fmember"  ]] && filt="$filt | map(select(.member   == \"$fmember\"))"
  [[ "$cutoff" -gt 0 ]] && filt="$filt | map(select(.timestamp >= $cutoff))"
  if [[ "$fstatus" == "open" ]]; then
    filt="$filt | map(select(.resolved | not))"
  elif [[ "$fstatus" == "resolved" ]]; then
    filt="$filt | map(select(.resolved))"
  fi
  filt="$filt | sort_by(-.timestamp)"

  if [[ "$json" -eq 1 ]]; then
    jq "$filt" <<<"$enriched"
    return
  fi

  local rows
  rows="$(jq -r "$filt | .[] | [
    .id, .severity, .needs,
    (if .resolved then \"resolved\" else \"open\" end),
    .member,
    (.timestamp | strftime(\"%Y-%m-%d %H:%M\")),
    .message
  ] | @tsv" <<<"$enriched")"
  if [[ -z "$rows" ]]; then
    echo "(no flags)"
    return
  fi
  printf '%-12s %-4s %-9s %-9s %-12s %-17s %s\n' "ID" "SEV" "NEEDS" "STATUS" "MEMBER" "WHEN" "MESSAGE"
  echo "$rows" | awk -F'\t' '{printf "%-12s %-4s %-9s %-9s %-12s %-17s %s\n", $1, $2, $3, $4, $5, $6, $7}'
}

# ---------- show ----------

_atmux_flags_show() {
  local id="${1:-}"
  [[ -n "$id" ]] || atmux::die "flags show: <id> required"
  local f; f="$(_flags_file)"
  [[ -f "$f" ]] || atmux::die "flags show: no flags log at $f"

  # Print the flag's `### f-id ... ` block until the next `### ` heading,
  # then print every `### r-rid f-id ...` block whose second field matches.
  local flag_block
  flag_block="$(awk -v id="$id" '
    /^### / && $2 == id { capture=1; print; next }
    /^### / && capture { capture=0; exit }
    capture { print }
  ' "$f")"
  if [[ -z "$flag_block" ]]; then
    atmux::die "flags show: no entry with id $id"
  fi
  printf '%s\n' "$flag_block"

  local resolutions
  resolutions="$(awk -v id="$id" '
    /^### r-/ {
      if ($3 == id) { capture=1; print; next } else { capture=0 }
      next
    }
    /^### / && capture { capture=0 }
    capture { print }
  ' "$f")"
  if [[ -n "$resolutions" ]]; then
    printf '\n%s\n' "$resolutions"
  fi
}

# ---------- resolve ----------

_atmux_flags_resolve() {
  local id="" who="" note=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --as)   who="$2"; shift 2 ;;
      --note) note="$2"; shift 2 ;;
      -*) atmux::die "flags resolve: unknown flag: $1" ;;
      *)
        if [[ -z "$id" ]]; then id="$1"; shift
        else atmux::die "flags resolve: too many args"; fi ;;
    esac
  done
  [[ -n "$id" ]] || atmux::die "flags resolve: <id> required"

  note="$(_flags_oneline "$note")"

  local f; f="$(_flags_file)"
  [[ -f "$f" ]] || atmux::die "flags resolve: no flags log at $f"

  # Verify the flag exists before appending a resolution that points to it.
  if ! awk -v id="$id" 'BEGIN{found=0} /^### / && $2 == id { found=1; exit } END{ exit !found }' "$f"; then
    atmux::die "flags resolve: no entry with id $id"
  fi

  local member; member="$(_flags_resolve_member "$who")"
  local rid; rid="$(_flags_gen_resolution)"
  local epoch; epoch="$(atmux::now_epoch)"
  local hhmm; hhmm="$(atmux::now_myt)"

  atmux::with_lock "$f" _flags_append_resolution \
    "$f" "$rid" "$id" "$epoch" "$hhmm" "$member" "$note"

  atmux::ok "flags: $id resolved by $member ($rid)"
  printf '%s\n' "$rid"
}

_flags_append_resolution() {
  local f="$1" rid="$2" fid="$3" epoch="$4" hhmm="$5" member="$6" note="$7"
  {
    printf '\n### %s %s (%s)\n\n' "$rid" "$fid" "$hhmm"
    printf -- '- **timestamp**: %s\n' "$epoch"
    printf -- '- **flag**: %s\n'      "$fid"
    printf -- '- **by**: %s\n'        "$member"
    if [[ -n "$note" ]]; then
      printf -- '- **note**: %s\n' "$note"
    else
      printf -- '- **note**: null\n'
    fi
  } >> "$f"
}
