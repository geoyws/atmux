#!/usr/bin/env bash
# atmux driver <subcommand> [args]    (also: atmux brief-driver — alias)
#
#   brief-driver
#       Single-screen driver state recovery. Prints ≤30 lines of context a
#       fresh driver session needs to take over with no prior conversation
#       history: kanban counts, branch ahead-of-origin, active /loop status,
#       open driver-inbox entries, latest 3 lead-outbox entries, currently
#       in-progress Tasks, plus a deterministic recovery command sequence.
#
#       Read-only. NO Discord ping, NO state mutation, NO network. Single
#       jq + git pass; budget is <500ms.
#
#   note <message> [--reversibility low|medium|high] [--note <text>]
#       Append a driver self-note to .atmux/driver-state.md. The file is a
#       single-author append-only log (driver only) used as the durable
#       layer behind brief-driver — handoffs, ad-hoc decisions, observations
#       that future driver sessions need to recover. Each call:
#         1) appends a `### dn-xxxxxxxx` entry (timestamp/reversibility/
#            message/note bullets, mirrors lib/decisions.sh shape so the
#            existing awk/jq parsers transfer);
#         2) auto-rewrites the `### Digest (last 5)` block at the top of
#            the file as one-line summaries (newest first).
#       60-char ceilings on `<message>` and `--note` are an ERROR (per
#       d-485b965d / ADR-008 — truncation drops context, force tight).
#
#       NO Discord ping (driver is human, doesn't need to ping itself) and
#       NO tmux send. Just a markdown-file mutation under flock.
#
# Per ADR-009 addendum (S6): driver rotation parity with member rotation.
# Symmetric to the team-lead post-/clear bootstrap — actor recovers from
# durable state files instead of in-memory context.

main() {
  atmux::require jq git
  atmux::require_team

  local sub="${1:-}"; shift || true
  case "$sub" in
    brief-driver) _atmux_driver_brief "$@" ;;
    note)         _atmux_driver_note  "$@" ;;
    "") atmux::die "driver: missing subcommand (use brief-driver|note)" ;;
    *)  atmux::die "driver: unknown subcommand: $sub (use brief-driver|note)" ;;
  esac
}

# ---------- brief-driver ----------

_atmux_driver_brief() {
  [[ $# -eq 0 ]] || atmux::die "brief-driver: takes no args"

  local team; team="$(atmux::team_name)"
  local now;  now="$(atmux::now_myt)"
  local d;    d="$(atmux::dir)"
  local k;    k="$(atmux::kanban_json)"
  local di;   di="$d/driver-inbox.md"
  local ob;   ob="$d/lead-outbox.md"
  local loop_json="$d/state/loop.json"
  local loop_pid="$d/state/loop.pid"

  # Single jq pass over kanban + (optional) loop.json. Yields counts +
  # in-progress task list + loop interval/next-fire in one shot. When
  # kanban.json is missing (fresh team pre-init) we substitute zero
  # defaults instead of erroring — brief-driver is a recovery tool, it
  # must work even on partially-initialised state.
  local agg
  if [[ -f "$k" ]]; then
    if [[ -f "$loop_json" ]]; then
      agg="$(jq --slurpfile loop "$loop_json" '
        {
          done:         ([.tasks[]?  | select(.status == "done")]        | length),
          inprogress:   ([.tasks[]?  | select(.status == "in-progress")] | length),
          todo:         ([.tasks[]?  | select(.status == "todo")]        | length),
          epics:        ((.epics // []) | length),
          ipTasks:      [.tasks[]?   | select(.status == "in-progress")
                                     | {id, owner, subject}],
          loopInterval: ($loop[0].intervalMin   // null),
          loopNext:     ($loop[0].nextFireMyt   // null)
        }
      ' "$k")"
    else
      agg="$(jq '
        {
          done:         ([.tasks[]?  | select(.status == "done")]        | length),
          inprogress:   ([.tasks[]?  | select(.status == "in-progress")] | length),
          todo:         ([.tasks[]?  | select(.status == "todo")]        | length),
          epics:        ((.epics // []) | length),
          ipTasks:      [.tasks[]?   | select(.status == "in-progress")
                                     | {id, owner, subject}],
          loopInterval: null,
          loopNext:     null
        }
      ' "$k")"
    fi
  else
    agg='{"done":0,"inprogress":0,"todo":0,"epics":0,"ipTasks":[],"loopInterval":null,"loopNext":null}'
  fi

  local n_done n_ip n_todo n_epic loop_interval loop_next
  n_done="$(jq -r '.done'         <<<"$agg")"
  n_ip="$(jq   -r '.inprogress'   <<<"$agg")"
  n_todo="$(jq -r '.todo'         <<<"$agg")"
  n_epic="$(jq -r '.epics'        <<<"$agg")"
  loop_interval="$(jq -r '.loopInterval // ""' <<<"$agg")"
  loop_next="$(jq     -r '.loopNext     // ""' <<<"$agg")"

  # Branch ahead-of-origin via a single git rev-list call. `@{u}..HEAD`
  # fails (rc!=0) when there's no upstream OR no .git — both collapse to
  # the "no upstream" branch line. We don't fetch; the count is
  # ahead-only against the local upstream cache, matching what the
  # driver sees from `git status` already.
  local branch_line ahead
  # `@{u}..HEAD` is git revspec syntax — quoted to keep shellcheck (SC1083)
  # quiet about the literal braces. Single git invocation.
  if ahead="$(git rev-list --count "@{u}..HEAD" 2>/dev/null)"; then
    branch_line="${ahead} commits ahead of origin"
  else
    branch_line="no upstream"
  fi

  # Active /loop detection — be permissive. loop.json (rich metadata) +
  # loop.pid (live process marker) are written by future loop-runner
  # scaffolding; until that lands the file simply isn't there and we
  # report "none". When only loop.pid is present (metadata file lost),
  # report "active (no metadata)" so the driver knows a loop is alive
  # somewhere.
  local loop_line="none"
  if [[ -n "$loop_interval" ]]; then
    if [[ -n "$loop_next" ]]; then
      loop_line="${loop_interval} min interval, next fire at ${loop_next}"
    else
      loop_line="${loop_interval} min interval"
    fi
  elif [[ -f "$loop_pid" ]]; then
    loop_line="active (no metadata)"
  fi

  # Driver-inbox open-entry count. Bullets under `## Open` start with
  # `- ` (no `[timestamp]` requirement, unlike lead-outbox); the section
  # ends at the next `## ` heading (typically `## Archive`). awk in a
  # single pass.
  local n_di=0
  if [[ -f "$di" ]]; then
    n_di="$(awk '
      /^## Open/        { flag = 1; next }
      /^## /            { flag = 0 }
      flag && /^- /     { c++ }
      END               { print c + 0 }
    ' "$di")"
  fi

  # Latest 3 lead-outbox entries — newest entries are inserted at the
  # top of `## Open` (lib/reply.sh::_atmux_outbox_write), so the first
  # 3 matching `^- \[` lines under `## Open` are the latest 3. Slice
  # inside awk (not `| head -3`) — under `set -o pipefail` an awk that
  # outlives `head -3` gets SIGPIPE and the pipeline exits 141, which
  # errexit then turns into a silent abort.
  local outbox_lines=""
  if [[ -f "$ob" ]]; then
    outbox_lines="$(awk '
      /^## Open/        { flag = 1; next }
      /^## /            { flag = 0 }
      flag && /^- \[/   { print; if (++c >= 3) exit }
    ' "$ob")"
  fi

  # In-progress task summary (id<TAB>owner<TAB>subject). Cap at 8 rows
  # via jq slice — same SIGPIPE rationale as the outbox awk above. @tsv
  # handles tab/newline escaping in subject text.
  local ip_lines
  ip_lines="$(jq -r '.ipTasks | .[0:8] | .[] | [.id, (.owner // "-"), (.subject // "")] | @tsv' \
              <<<"$agg")"
  local n_ip_total; n_ip_total="$n_ip"

  # ---------- render ----------

  printf 'You are the driver for %s. Current state @ %s:\n' "$team" "$now"
  printf '  · Counts: %s done · %s in-progress · %s todo · %s epics\n' \
    "$n_done" "$n_ip" "$n_todo" "$n_epic"
  printf '  · Branch: %s\n' "$branch_line"
  printf '  · Active loop: %s\n' "$loop_line"
  printf '  · Open driver-inbox entries: %s  (run: cat .atmux/driver-inbox.md)\n' "$n_di"

  printf '  · Latest 3 lead-outbox entries:\n'
  if [[ -n "$outbox_lines" ]]; then
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      printf '      %s\n' "$(_atmux_driver_format_outbox_line "$line")"
    done <<<"$outbox_lines"
  else
    printf '      (none)\n'
  fi

  printf '  · In-progress Tasks:\n'
  if [[ -n "$ip_lines" ]]; then
    local id owner subj short_subj
    while IFS=$'\t' read -r id owner subj; do
      [[ -z "$id" ]] && continue
      short_subj="${subj:0:60}"
      printf '      %s  %s  %s\n' "$id" "$owner" "$short_subj"
    done <<<"$ip_lines"
    if (( n_ip_total > 8 )); then
      printf '      … %s more (atmux task list --status in-progress)\n' \
        "$(( n_ip_total - 8 ))"
    fi
  else
    printf '      (none)\n'
  fi

  printf '\nRecovery sequence (run in order):\n'
  printf '  cat .atmux/driver-inbox.md\n'
  printf '  tail -40 .atmux/lead-outbox.md\n'
  printf '  atmux task list\n'
  printf '  atmux epic list\n'
  printf '  git log --oneline | head -10\n'
}

# Format one raw lead-outbox bullet (`- [HH:MM MYT] **member**: text…`)
# into the digest form: `[HH:MM MYT] member: <≤80 chars>…`. Permissive —
# emits the raw line on shape mismatch so a malformed entry never breaks
# the brief.
_atmux_driver_format_outbox_line() {
  local line="$1"
  local ts member msg trunc
  # Regex must live in a var: bash parses `\ ` differently inline (=~ on
  # a literal pattern) vs variable-expanded, and the literal form fails
  # to match `- [HH:MM MYT] **member**: …` shapes.
  local re='^- \[([^]]+)\] \*\*([^*]+)\*\*: (.*)$'
  if [[ "$line" =~ $re ]]; then
    ts="${BASH_REMATCH[1]}"
    member="${BASH_REMATCH[2]}"
    msg="${BASH_REMATCH[3]}"
  else
    printf '%s' "$line"
    return
  fi
  trunc="${msg:0:80}"
  if (( ${#msg} > 80 )); then
    printf '[%s] %s: %s…' "$ts" "$member" "$trunc"
  else
    printf '[%s] %s: %s' "$ts" "$member" "$trunc"
  fi
}

# ---------- note ----------

_driver_state_file() { printf '%s/driver-state.md\n' "$(atmux::dir)"; }

_driver_gen_id() {
  printf 'dn-%s\n' "$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
}

# Newlines/tabs in user-supplied fields would break the line-oriented
# bullet parser (mirrors decisions.sh::_decisions_oneline). Squash to
# single spaces before they hit disk.
_driver_oneline() { printf '%s' "$1" | tr '\n\r\t' '   '; }

_driver_rev_emoji() {
  case "$1" in
    low)    printf '🟢' ;;
    medium) printf '🟡' ;;
    high)   printf '🔴' ;;
    *)      printf '⚪' ;;
  esac
}

# Parse driver-state.md into a JSON array (one element per `### dn-xxx`
# entry). Empty array when file is missing or has no entries yet.
# Field order in the awk's TSV must match the jq splat below. Mirrors
# lib/decisions.sh::_decisions_to_json_array — same parser shape so a
# future generic "atmux log" reader can ingest both files uniformly.
_driver_to_json_array() {
  local f="$1"
  [[ -f "$f" ]] || { echo '[]'; return; }
  awk '
    function flush() {
      if (id != "") {
        printf "%s\t%s\t%s\t%s\t%s\t%s\n", id, ts, rev, msg, note, hhmm
      }
    }
    /^### / && $2 ~ /^dn-/ {
      flush()
      id=$2
      ts=0; rev=""; msg=""; note=""; hhmm=""
    }
    /^- \*\*timestamp\*\*:/     { v=$0; sub(/^- \*\*timestamp\*\*: */,"",v);     ts=v+0 }
    /^- \*\*hhmm\*\*:/          { v=$0; sub(/^- \*\*hhmm\*\*: */,"",v);          hhmm=v }
    /^- \*\*reversibility\*\*:/ { v=$0; sub(/^- \*\*reversibility\*\*: */,"",v); rev=v }
    /^- \*\*message\*\*:/       { v=$0; sub(/^- \*\*message\*\*: */,"",v);       msg=v }
    /^- \*\*note\*\*:/          { v=$0; sub(/^- \*\*note\*\*: */,"",v);          note=v }
    END { flush() }
  ' "$f" | jq -R '
    select(length > 0) | split("\t") | {
      id:            .[0],
      timestamp:     (.[1] | tonumber),
      reversibility: .[2],
      message:       .[3],
      note:          (if (.[4] // "") == "" then null else .[4] end),
      hhmm:          .[5]
    }
  ' | jq -s '.'
}

_atmux_driver_note() {
  local message="" reversibility="low" note=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --reversibility) reversibility="$2"; shift 2 ;;
      --note)          note="$2"; shift 2 ;;
      --) shift; message="$*"; break ;;
      -*) atmux::die "driver note: unknown flag: $1" ;;
      *)
        if [[ -z "$message" ]]; then message="$1"; else message="$message $1"; fi
        shift ;;
    esac
  done

  [[ -n "$message" ]] || atmux::die "driver note: <message> required"
  case "$reversibility" in
    low|medium|high) ;;
    *) atmux::die "driver note: --reversibility must be low|medium|high (got: $reversibility)" ;;
  esac

  message="$(_driver_oneline "$message")"
  note="$(_driver_oneline "$note")"

  # Same 60-char gate as decisions add: tight messages keep the digest
  # readable + force the driver to think before logging.
  if (( ${#message} > 60 )); then
    atmux::die "driver note: message exceeds 60 chars (rewrite tighter)"
  fi
  if (( ${#note} > 60 )); then
    atmux::die "driver note: --note exceeds 60 chars (rewrite tighter)"
  fi

  local id;    id="$(_driver_gen_id)"
  local epoch; epoch="$(atmux::now_epoch)"
  local hhmm;  hhmm="$(atmux::now_myt)"

  local f; f="$(_driver_state_file)"
  atmux::with_lock "$f" _driver_state_rewrite \
    "$f" "$id" "$message" "$reversibility" "$note" "$epoch" "$hhmm"

  atmux::ok "driver: recorded $id"
  printf '%s\n' "$id"
}

# Compute the new entries list (existing + new), then re-render the
# whole file: header + auto-digest (last 5 newest-first) + chronological
# entries (oldest-first). Whole-file rewrite is fine here — driver-state
# is single-author, append-only, low write rate, and the locked region
# is small (jq-bounded).
_driver_state_rewrite() {
  local f="$1" id="$2" message="$3" rev="$4" note="$5" epoch="$6" hhmm="$7"

  local entries; entries="$(_driver_to_json_array "$f")"
  entries="$(jq \
    --arg id "$id" --argjson ts "$epoch" --arg rev "$rev" \
    --arg msg "$message" --arg note "$note" --arg hhmm "$hhmm" \
    '. + [{
      id: $id, timestamp: $ts, reversibility: $rev,
      message: $msg, note: (if $note == "" then null else $note end),
      hhmm: $hhmm
    }]' \
    <<<"$entries")"

  local sorted; sorted="$(jq 'sort_by(.timestamp)' <<<"$entries")"

  local tmp; tmp="$(mktemp "${f}.XXXXXX")"
  cat > "$tmp" <<'EOF'
# atmux driver-state — append-only driver self-note log

Driver writes here via `atmux driver note <msg>`. Single-author,
append-only — symmetric to lib/decisions.sh's decisions.md. Top of
file holds an auto-maintained "Digest (last 5)" rolling window so a
fresh driver session sees recent context first; full entries follow
below in chronological order.

EOF

  # Digest block (last 5 newest-first). jq emits one bullet per line.
  printf '## Digest (last 5)\n\n' >> "$tmp"
  local digest
  digest="$(jq -r '
    sort_by(-.timestamp) | .[0:5] | .[] |
    (if .reversibility == "low" then "🟢"
     elif .reversibility == "medium" then "🟡"
     elif .reversibility == "high" then "🔴"
     else "⚪" end) as $e |
    "- \($e) `\(.id)` [\(.hhmm)] \(.message)"
  ' <<<"$sorted")"
  if [[ -n "$digest" ]]; then
    printf '%s\n' "$digest" >> "$tmp"
  else
    printf '_(no entries yet)_\n' >> "$tmp"
  fi
  printf '\n---\n' >> "$tmp"

  # Body: full entries chronologically. The literal "\n" sequences in
  # the jq -r format string emit real newlines; the `[ ... ] | join("")`
  # shape keeps every entry on the same jq output record so we don't
  # leak a stray `null` from optional .note rendering.
  jq -r '
    .[] |
    [
      "\n### \(.id) — \(.message) [\(.reversibility)] (\(.hhmm))\n\n",
      "- **timestamp**: \(.timestamp)\n",
      "- **hhmm**: \(.hhmm)\n",
      "- **reversibility**: \(.reversibility)\n",
      "- **message**: \(.message)\n",
      (if .note then "- **note**: \(.note)\n" else "" end)
    ] | join("")
  ' <<<"$sorted" >> "$tmp"

  mv "$tmp" "$f"
}
