#!/usr/bin/env bash
# atmux decisions <verb> [args]
#   add  <question> --default <answer> [--reversibility low|medium|high]
#                                      [--note <text>]
#   list [--since <when>] [--reversibility <level>] [--json]
#   show <id>
#
# Per ADR-008. Append-only markdown log at .atmux/decisions.md. Each `add`
# also pings Discord via lib/discord.sh::atmux::discord_ping (no-op if no
# webhook configured — silent, preserves no-webhook flow).
#
# Webhook resolution chain: team.discord.webhook → ATMUX_DISCORD_WEBHOOK env
# → silent no-op. The team.json fallback is wired here (NOT in discord.sh)
# so the shared pinger stays single-purpose.
#
# Entry format (one per `### d-xxxxxxxx` heading) is canonical — `decisions
# show` and `decisions list` parse it directly. Keep field order + bullet
# prefix stable; the awk in _decisions_to_json_array below depends on it.

# shellcheck source=discord.sh
. "$ATMUX_LIB_DIR/discord.sh"

main() {
  atmux::require jq
  atmux::require_team

  local verb="${1:-}"; shift || true
  case "$verb" in
    add)      _atmux_decisions_add "$@" ;;
    list|ls)  _atmux_decisions_list "$@" ;;
    show|get) _atmux_decisions_show "$@" ;;
    "")       atmux::die "decisions: missing verb (add|list|show)" ;;
    *)        atmux::die "decisions: unknown verb: $verb (use add|list|show)" ;;
  esac
}

# ---------- paths + helpers ----------

_decisions_file() { printf '%s/decisions.md\n' "$(atmux::dir)"; }

_decisions_gen_id() {
  printf 'd-%s\n' "$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
}

# Newlines/tabs in user-supplied fields would break the line-oriented markdown
# parser used by show/list. Squash them to spaces before they hit disk.
_decisions_oneline() {
  printf '%s' "$1" | tr '\n\r\t' '   '
}

# Resolve discord webhook from team.json if env var isn't already set.
# Mirrors the chain documented in ADR-008 without modifying lib/discord.sh.
_decisions_export_webhook() {
  [[ -n "${ATMUX_DISCORD_WEBHOOK:-}" ]] && return 0
  local tj; tj="$(atmux::team_json)"
  local hook
  hook="$(jq -r '.discord.webhook // empty' "$tj" 2>/dev/null || true)"
  if [[ -n "$hook" && "$hook" != "null" ]]; then
    export ATMUX_DISCORD_WEBHOOK="$hook"
  fi
  return 0
}

_decisions_rev_emoji() {
  case "$1" in
    low)    printf '🟢' ;;
    medium) printf '🟡' ;;
    high)   printf '🔴' ;;
    *)      printf '⚪' ;;
  esac
}

# Parse the markdown log into a JSON array. Empty array when the file is
# missing. Field order in the awk's TSV must match the jq splat below.
_decisions_to_json_array() {
  local f="$1"
  [[ -f "$f" ]] || { echo '[]'; return; }
  awk '
    function flush() {
      if (id != "") {
        printf "%s\t%s\t%s\t%s\t%s\t%s\n", id, ts, rev, q, d, note
      }
    }
    /^### / && $2 ~ /^d-/ {
      flush()
      id=$2
      ts=0; q=""; d=""; rev=""; note=""
    }
    /^- \*\*timestamp\*\*:/   { v=$0; sub(/^- \*\*timestamp\*\*: */,"",v);   ts=v+0 }
    /^- \*\*question\*\*:/    { v=$0; sub(/^- \*\*question\*\*: */,"",v);    q=v }
    /^- \*\*default\*\*:/     { v=$0; sub(/^- \*\*default\*\*: */,"",v);     d=v }
    /^- \*\*reversibility\*\*:/ { v=$0; sub(/^- \*\*reversibility\*\*: */,"",v); rev=v }
    /^- \*\*note\*\*:/        { v=$0; sub(/^- \*\*note\*\*: */,"",v);        note=v }
    END { flush() }
  ' "$f" | jq -R '
    select(length > 0) | split("\t") | {
      id: .[0],
      timestamp: (.[1] | tonumber),
      reversibility: .[2],
      question: .[3],
      default: .[4],
      note: (if (.[5] // "") == "" then null else .[5] end)
    }
  ' | jq -s '.'
}

# Accept ISO date (`2026-04-25`), full ISO timestamp, or relative `Nh`/`Nd`.
# Returns epoch seconds on stdout. Errors out on garbage.
_decisions_parse_since() {
  local s="$1"
  if [[ "$s" =~ ^([0-9]+)h$ ]]; then
    echo $(( $(atmux::now_epoch) - BASH_REMATCH[1] * 3600 ))
  elif [[ "$s" =~ ^([0-9]+)d$ ]]; then
    echo $(( $(atmux::now_epoch) - BASH_REMATCH[1] * 86400 ))
  else
    if ! date -d "$s" +%s 2>/dev/null; then
      atmux::die "decisions list: bad --since format '$s' (use ISO date or Nh/Nd)"
    fi
  fi
}

# ---------- add ----------

_atmux_decisions_add() {
  local question="" default="" reversibility="low" note=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --default)       default="$2"; shift 2 ;;
      --reversibility) reversibility="$2"; shift 2 ;;
      --note)          note="$2"; shift 2 ;;
      --) shift; question="$*"; break ;;
      -*) atmux::die "decisions add: unknown flag: $1" ;;
      *)
        if [[ -z "$question" ]]; then question="$1"; else question="$question $1"; fi
        shift ;;
    esac
  done

  [[ -n "$question" ]] || atmux::die "decisions add: <question> required"
  [[ -n "$default" ]]  || atmux::die "decisions add: --default <answer> required"

  case "$reversibility" in
    low|medium|high) ;;
    *) atmux::die "decisions add: --reversibility must be low|medium|high (got: $reversibility)" ;;
  esac

  question="$(_decisions_oneline "$question")"
  default="$(_decisions_oneline "$default")"
  note="$(_decisions_oneline "$note")"

  # Discord bullets must fit ≤80 chars. Question + default + note all render
  # as raw values prefixed by an emoji + label, so we cap each at 60 chars
  # and ERROR (not silent-truncate) — reviewer flag on ADR-008 signoff:
  # truncation drops context; an error forces the planner to rewrite tight.
  # Note's prefix is `📝 note: ` (~9 chars) so 60+9 = 69 ≤ 80 — comfortable
  # margin and a single mental model across all three fields.
  if (( ${#question} > 60 )); then
    atmux::die "decisions add: question exceeds 60 chars (Discord ≤80 budget); rewrite tighter"
  fi
  if (( ${#default} > 60 )); then
    atmux::die "decisions add: default exceeds 60 chars (Discord ≤80 budget); rewrite tighter"
  fi
  if (( ${#note} > 60 )); then
    atmux::die "decisions add: note exceeds 60 chars (Discord ≤80 budget); rewrite tighter"
  fi

  local f; f="$(_decisions_file)"

  # Idempotency: same question + same default within 60s → skip + warn.
  if [[ -f "$f" ]]; then
    local now_e; now_e="$(atmux::now_epoch)"
    local cutoff=$((now_e - 60))
    local dup
    dup="$(_decisions_to_json_array "$f" \
      | jq -r --argjson c "$cutoff" --arg q "$question" --arg d "$default" \
        '[.[] | select(.timestamp >= $c and .question == $q and .default == $d)] | .[0].id // ""')"
    if [[ -n "$dup" ]]; then
      atmux::warn "decisions add: skipped duplicate of $dup (within 60s window)"
      printf '%s\n' "$dup"
      return 0
    fi
  fi

  local id; id="$(_decisions_gen_id)"
  local epoch; epoch="$(atmux::now_epoch)"
  local hhmm; hhmm="$(atmux::now_myt)"

  atmux::with_lock "$f" _decisions_append \
    "$f" "$id" "$question" "$default" "$reversibility" "$note" "$epoch" "$hhmm"

  _decisions_export_webhook
  local team; team="$(atmux::team_name)"
  local body; body="$(_decisions_render_discord \
    "$id" "$question" "$default" "$reversibility" "$note" "$team" "$hhmm")"
  atmux::discord_ping "$body"

  atmux::ok "decisions: recorded $id"
  printf '%s\n' "$id"
}

_decisions_append() {
  local f="$1" id="$2" question="$3" default="$4" rev="$5" note="$6" epoch="$7" hhmm="$8"

  if [[ ! -f "$f" ]]; then
    cat > "$f" <<'EOF'
# atmux decisions — append-only log

Lead/planner auto-resolutions, one entry per recommended-default applied.
Override window: see each entry's `override` line. Discord ping fires per
add (ADR-008).

EOF
  fi

  {
    printf '\n### %s — %s [%s] (%s)\n\n' "$id" "$question" "$rev" "$hhmm"
    printf -- '- **timestamp**: %s\n' "$epoch"
    printf -- '- **question**: %s\n' "$question"
    printf -- '- **default**: %s\n' "$default"
    printf -- '- **reversibility**: %s\n' "$rev"
    if [[ -n "$note" ]]; then
      printf -- '- **note**: %s\n' "$note"
    fi
    printf -- '- **override**: `atmux send lead "override %s: <new>"`\n' "$id"
  } >> "$f"
}

_decisions_render_discord() {
  local id="$1" question="$2" default="$3" rev="$4" note="$5" team="$6" hhmm="$7"
  local emoji; emoji="$(_decisions_rev_emoji "$rev")"

  # All three user-supplied fields are length-validated in _atmux_decisions_add
  # (≤60 chars each). Renderer just emits — no per-field truncation.
  printf '📋 **[atmux-decisions]** · `%s` · %s\n\n' "$team" "$hhmm"
  printf '🔵 %s\n' "$question"
  printf '✅ default: %s\n' "$default"
  printf '%s reversibility: %s\n' "$emoji" "$rev"
  if [[ -n "$note" ]]; then
    printf '📝 note: %s\n' "$note"
  fi
  # Two bullets — concatenating into one renders ~90 chars, breaking the
  # ≤80-char/bullet Discord template budget (same vulnerability class as the
  # 60-char question/default validators above).
  printf '📍 atmux decisions show %s\n' "$id"
  printf '↪ atmux send lead "override %s: <new>"\n' "$id"
}

# ---------- list ----------

_atmux_decisions_list() {
  local since="" rev_filter="" json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --since)         since="$2"; shift 2 ;;
      --reversibility) rev_filter="$2"; shift 2 ;;
      --json)          json=1; shift ;;
      *) atmux::die "decisions list: unknown arg: $1" ;;
    esac
  done

  if [[ -n "$rev_filter" ]]; then
    case "$rev_filter" in
      low|medium|high) ;;
      *) atmux::die "decisions list: --reversibility must be low|medium|high" ;;
    esac
  fi

  local cutoff=0
  [[ -n "$since" ]] && cutoff="$(_decisions_parse_since "$since")"

  local f; f="$(_decisions_file)"
  local entries; entries="$(_decisions_to_json_array "$f")"

  local filter='.'
  [[ "$cutoff" -gt 0 ]] && filter="$filter | map(select(.timestamp >= $cutoff))"
  if [[ -n "$rev_filter" ]]; then
    filter="$filter | map(select(.reversibility == \"$rev_filter\"))"
  fi
  filter="$filter | sort_by(-.timestamp)"

  if [[ "$json" -eq 1 ]]; then
    jq "$filter" <<<"$entries"
    return
  fi

  local rows
  rows="$(jq -r "$filter | .[] | [.id, .reversibility, (.timestamp | strftime(\"%Y-%m-%d %H:%M\")), .question] | @tsv" <<<"$entries")"
  if [[ -z "$rows" ]]; then
    echo "(no decisions)"
    return
  fi
  printf '%-12s %-8s %-17s %s\n' "ID" "REVERS" "WHEN" "QUESTION"
  echo "$rows" | awk -F'\t' '{printf "%-12s %-8s %-17s %s\n", $1, $2, $3, $4}'
}

# ---------- show ----------

_atmux_decisions_show() {
  local id="${1:-}"
  [[ -n "$id" ]] || atmux::die "decisions show: <id> required"
  local f; f="$(_decisions_file)"
  [[ -f "$f" ]] || atmux::die "decisions show: no decisions log at $f"

  local out
  out="$(awk -v id="$id" '
    /^### / && $2 == id { capture=1; print; next }
    /^### / && capture { capture=0; exit }
    capture { print }
  ' "$f")"

  if [[ -z "$out" ]]; then
    atmux::die "decisions show: no entry with id $id"
  fi
  printf '%s\n' "$out"
}
