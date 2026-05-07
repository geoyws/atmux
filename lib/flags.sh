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

# shellcheck source=discord.sh
. "$ATMUX_LIB_DIR/discord.sh"
# shellcheck source=socket-pubsub.sh
. "$ATMUX_LIB_DIR/socket-pubsub.sh"

# Resolve the Discord webhook from team.json into the env var
# atmux::discord_ping expects. Mirrors lib/decisions.sh::_decisions_export_webhook
# (intentional duplication — keeps the shared lib/discord.sh single-purpose
# per ADR-008).
_flags_export_webhook() {
  [[ -n "${ATMUX_DISCORD_WEBHOOK:-}" ]] && return 0
  local tj; tj="$(atmux::team_json)"
  local hook
  hook="$(jq -r '.discord.webhook // empty' "$tj" 2>/dev/null || true)"
  if [[ -n "$hook" && "$hook" != "null" ]]; then
    export ATMUX_DISCORD_WEBHOOK="$hook"
  fi
  return 0
}

# Build the [atmux-flags] Discord template per ADR-008 + driver's E4 split.
# Header line + per-bullet emoji body (≤80 chars per bullet — message is
# ≤60-char gated upstream so 🛑 + member + ": " + message ≈ ≤72 worst case).
_flags_render_discord() {
  local id="$1" member="$2" severity="$3" needs="$4" task="$5" \
        message="$6" note="$7" team="$8" hhmm="$9"
  printf '📍 **[atmux-flags]** · `%s` · %s\n\n' "$team" "$hhmm"
  printf '🛑 %s: %s\n' "$member" "$message"
  printf '📋 needs: %s\n' "$needs"
  if [[ -n "$task" ]]; then
    printf '📍 task: %s\n' "$task"
  fi
  if [[ -n "$note" ]]; then
    printf '📝 %s\n' "$note"
  fi
  printf '↪ atmux flags resolve %s\n' "$id"
}

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

# Accept raw epoch / ISO date / Nh / Nd. Mirrors lib/decisions.sh's
# _decisions_parse_since (epoch path added in t-2b81aa76 there + here so
# whip's per-cursor shellout can pass an epoch directly without going
# through GNU `date -d`'s @ prefix dance — bare integers like 1777125613
# fail `date -d` parsing).
_flags_parse_since() {
  local s="$1"
  if [[ "$s" =~ ^[0-9]+$ ]]; then
    echo "$s"
  elif [[ "$s" =~ ^([0-9]+)h$ ]]; then
    echo $(( $(atmux::now_epoch) - BASH_REMATCH[1] * 3600 ))
  elif [[ "$s" =~ ^([0-9]+)d$ ]]; then
    echo $(( $(atmux::now_epoch) - BASH_REMATCH[1] * 86400 ))
  else
    if ! date -d "$s" +%s 2>/dev/null; then
      atmux::die "flags list: bad --since format '$s' (use epoch, ISO date, or Nh/Nd)"
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

# ---------- dedup gate (t-1c8b9e85) ----------

# _flags_dedup_open_within <flags-file> <member> <message> <ttl-sec>
# Returns 0 (true) iff at least one OPEN flag exists in the file with
# the same (member, message) tuple AND a timestamp within the last
# `ttl-sec` seconds. "Open" = no resolution entry references the
# flag's id (same definition as `flags list --status open`).
#
# Used by `_atmux_flags_add` to suppress duplicate firings during
# retry loops (e.g. budget-probe OAuth-401 chains that surface the
# same flag once per tick). Returns 1 (no match) when the file is
# absent or no qualifying flag exists.
_flags_dedup_open_within() {
  local f="$1" member="$2" message="$3" ttl="$4"
  [[ -f "$f" ]] || return 1
  local now; now="$(atmux::now_epoch)"
  local cutoff=$(( now - ttl ))
  local model; model="$(_flags_to_json "$f")"
  local n
  n="$(jq -r --arg m "$member" --arg msg "$message" --argjson cutoff "$cutoff" '
    .flags as $flags
    | .resolutions as $rs
    | $flags
    | map(. as $fl | select(
        $fl.member == $m and
        $fl.message == $msg and
        $fl.timestamp >= $cutoff and
        ($rs | any(.flag == $fl.id) | not)
      ))
    | length
  ' <<<"$model")"
  (( n > 0 ))
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

  # --task linkage: validate the kanban task exists BEFORE writing the
  # markdown record so the log doesn't capture dangling references.
  if [[ -n "$task" ]]; then
    local _k; _k="$(atmux::kanban_json)"
    local _texists
    _texists="$(jq --arg id "$task" '[.tasks[]? | select(.id == $id)] | length' "$_k" 2>/dev/null || echo 0)"
    (( _texists == 1 )) || atmux::die "flags add: --task $task does not exist in kanban"
  fi

  local member; member="$(_flags_resolve_member "$who")"

  # t-1c8b9e85: 5-min TTL dedup gate — same (member, message) tuple
  # within the last 300s, still open (no resolution recorded) → skip
  # append + skip lead notify. Prevents probe-401 retry loops from
  # flooding flags.md / lead-pane with identical entries.
  local f; f="$(_flags_file)"
  if _flags_dedup_open_within "$f" "$member" "$message" 300; then
    atmux::log "flags: dedup'd — same (member=$member, message) fired within last 5min; skipped"
    return 0
  fi

  local id; id="$(_flags_gen_id)"
  local epoch; epoch="$(atmux::now_epoch)"
  local hhmm; hhmm="$(atmux::now_myt)"

  atmux::with_lock "$f" _flags_append_entry \
    "$f" "$id" "$epoch" "$hhmm" "$member" "$severity" "$needs" "$task" "$message" "$note"

  # --task linkage: append a one-line back-reference to the task's `.note`
  # so `atmux task show` carries the cross-link. When --needs unblock,
  # additionally flip the task to `blocked` so claim --next skips it until
  # the flag is resolved.
  if [[ -n "$task" ]]; then
    atmux::task_append_note "$task" "flag $id ($severity/$needs): $message"
    if [[ "$needs" == "unblock" ]]; then
      atmux::jq_update "$(atmux::kanban_json)" \
        '.tasks |= map(if .id == $id then .status = "blocked" else . end)' \
        --arg id "$task"
      atmux::ok "flags: task $task → blocked (linked to $id)"
    fi
  fi

  _flags_notify_lead "$id" "$member" "$message"

  # p0 → Discord ping. p1/p2 stay silent on Discord (kanban + tmux ping only)
  # to keep the channel for genuine emergencies. Webhook chain inherited from
  # decisions.sh: team.discord.webhook → ATMUX_DISCORD_WEBHOOK env → silent.
  if [[ "$severity" == "p0" ]]; then
    _flags_export_webhook
    local team; team="$(atmux::team_name)"
    local body; body="$(_flags_render_discord \
      "$id" "$member" "$severity" "$needs" "$task" "$message" "$note" "$team" "$hhmm")"
    atmux::discord_embed_ping "$body"
  fi

  # E13/Sc: real-time signal to the lead's supervisor — member-side
  # blocker surfacing reaches the lead in <1s vs the 5-min cron-whip
  # baseline. Solo Mode (no team-lead) skips silently.
  local _lead; _lead="$(atmux::find_lead_member 2>/dev/null || true)"
  if [[ -n "$_lead" ]]; then
    local _evt
    _evt="$(jq -cn \
      --arg id "$id" --arg sev "$severity" --arg from "$member" \
      --argjson ts "$epoch" \
      '{type:"flag-add", ts:$ts, from:$from,
        payload:{id:$id, severity:$sev}}')"
    atmux::sock_publish "$_lead" "$_evt"
  fi

  atmux::ok "flags: recorded $id"
  printf '%s\n' "$id"
}

# Post-add side-effect: nudge the lead pane via tmux send-keys with a
# one-line summary so the lead sees the flag in their conversation stream
# without polling flags.md. The markdown record is the source of truth —
# this is best-effort. Skip silently when (a) tmux isn't running, (b) the
# lead isn't defined, (c) the lead window is missing, OR (d) the pane has
# a banner that would swallow the keystrokes (compaction/limit) — that
# last case is logged so the operator knows the nudge was withheld.
_flags_notify_lead() {
  local id="$1" member="$2" message="$3"
  command -v tmux >/dev/null 2>&1 || return 0

  local lead; lead="$(atmux::find_lead_member 2>/dev/null || true)"
  [[ -n "$lead" ]] || return 0
  atmux::tmux_window_exists "$lead" 2>/dev/null || return 0

  local pane_state
  pane_state="$(atmux::capture_pane "$lead" 30 2>/dev/null || true)"
  if echo "$pane_state" | grep -qi 'Compacting conversation\|hit your limit'; then
    atmux::log "flags: lead pane busy (banner) — skipped tmux send-keys for $id"
    return 0
  fi

  # Truncate the summary at 80 chars including the prefix to stay inside the
  # one-line ping budget. Prefix `📍 flag from <member>: ` ≈ 18+len(member),
  # so for typical 8–10-char member names the message body gets ~50–55 chars.
  local prefix="📍 flag from $member: "
  local pingline="${prefix}${message}"
  if (( ${#pingline} > 80 )); then
    pingline="${pingline:0:77}..."
  fi

  # CAGE/Sa t-466b164b: cage-aware send via atmux::tmux_cage so the
  # lead-pane ping reaches the right socket on cage'd teams.
  atmux::tmux_cage send-keys -t "$(atmux::tmux_target "$lead")" "$pingline" Enter 2>/dev/null \
    || atmux::log "flags: tmux send-keys to lead failed for $id"
  return 0
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

  # --task linkage surfaced on resolve: if the original flag carried a
  # --task reference, echo it AND surface a "consider task move" hint when
  # the task is currently `blocked` (likely flipped here by --needs unblock
  # at add time). We deliberately do NOT auto-flip — re-claiming after a
  # resolved blocker is a member/lead judgment call, not an automation.
  local linked_task
  linked_task="$(awk -v id="$id" '
    /^### / && $2 == id { capture=1; next }
    /^### / && capture { exit }
    capture && /^- \*\*task\*\*:/ { v=$0; sub(/^- \*\*task\*\*: */,"",v); print v; exit }
  ' "$f")"
  if [[ -n "$linked_task" && "$linked_task" != "null" ]]; then
    local linked_status
    linked_status="$(jq -r --arg id "$linked_task" \
                       '.tasks[]? | select(.id == $id) | .status // empty' \
                       "$(atmux::kanban_json)" 2>/dev/null || true)"
    atmux::log "flags: $id linked to task $linked_task (status=${linked_status:-unknown})"
    if [[ "$linked_status" == "blocked" ]]; then
      atmux::log "flags: consider \`atmux task move $linked_task in-progress\` now that $id is resolved"
    fi
  fi

  # E13/Sc: signal the lead's supervisor of the resolution. Mirrors flag-
  # add — Solo Mode skips silently; sock_publish is non-fatal on absent
  # listener.
  local _lead; _lead="$(atmux::find_lead_member 2>/dev/null || true)"
  if [[ -n "$_lead" ]]; then
    local _evt
    _evt="$(jq -cn \
      --arg id "$id" --arg from "$member" --argjson ts "$epoch" \
      '{type:"flag-resolve", ts:$ts, from:$from, payload:{id:$id}}')"
    atmux::sock_publish "$_lead" "$_evt"
  fi

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
