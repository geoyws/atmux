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
    digest)   _atmux_decisions_digest "$@" ;;
    "")       atmux::die "decisions: missing verb (add|list|show|digest)" ;;
    *)        atmux::die "decisions: unknown verb: $verb (use add|list|show|digest)" ;;
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
#
# E2/S9 added 4 optional fields (context, impact, decided-by, options).
# Old entries written before S9 don't have those bullets — awk inits each
# field to "" on every entry boundary so missing → empty TSV cell → null
# in the resulting JSON. options is a nested `  - <text>` sub-list; we
# join entries with "|" inside the TSV cell and split() back in jq. The
# pipe-separator caveat: an `--option` value containing a literal "|"
# survives the validators but corrupts re-parse. T3 may surface this as
# a follow-up if it bites.
_decisions_to_json_array() {
  local f="$1"
  [[ -f "$f" ]] || { echo '[]'; return; }
  awk '
    function flush() {
      if (id != "") {
        printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", \
          id, ts, rev, q, d, note, ctx, imp, dby, opts
      }
    }
    /^### / && $2 ~ /^d-/ {
      flush()
      id=$2
      ts=0; q=""; d=""; rev=""; note=""; ctx=""; imp=""; dby=""; opts=""
      in_opts=0
    }
    # Any top-level field bullet ends the options sub-list (rule order:
    # this fires first, then specific field rules — and crucially before
    # the **options** rule that re-arms in_opts).
    /^- \*\*[^*]+\*\*:/ { in_opts=0 }
    /^- \*\*timestamp\*\*:/      { v=$0; sub(/^- \*\*timestamp\*\*: */,"",v);      ts=v+0 }
    /^- \*\*question\*\*:/       { v=$0; sub(/^- \*\*question\*\*: */,"",v);       q=v }
    /^- \*\*default\*\*:/        { v=$0; sub(/^- \*\*default\*\*: */,"",v);        d=v }
    /^- \*\*reversibility\*\*:/  { v=$0; sub(/^- \*\*reversibility\*\*: */,"",v);  rev=v }
    /^- \*\*note\*\*:/           { v=$0; sub(/^- \*\*note\*\*: */,"",v);           note=v }
    /^- \*\*context\*\*:/        { v=$0; sub(/^- \*\*context\*\*: */,"",v);        ctx=v }
    /^- \*\*impact\*\*:/         { v=$0; sub(/^- \*\*impact\*\*: */,"",v);         imp=v }
    /^- \*\*decided-by\*\*:/     { v=$0; sub(/^- \*\*decided-by\*\*: */,"",v);     dby=v }
    /^- \*\*options\*\*:/ { in_opts=1 }
    in_opts && /^  - / {
      v=$0; sub(/^  - */,"",v)
      opts = (opts == "") ? v : opts "|" v
    }
    END { flush() }
  ' "$f" | jq -R '
    select(length > 0) | split("\t") | {
      id:            .[0],
      timestamp:     (.[1] | tonumber),
      reversibility: .[2],
      question:      .[3],
      default:       .[4],
      note:          (if (.[5] // "") == "" then null else .[5] end),
      context:       (if (.[6] // "") == "" then null else .[6] end),
      impact:        (if (.[7] // "") == "" then null else .[7] end),
      "decided-by":  (if (.[8] // "") == "" then null else .[8] end),
      options:       (if (.[9] // "") == "" then [] else (.[9] | split("|")) end)
    }
  ' | jq -s '.'
}

# Accept a raw epoch (`1777125613`), ISO date (`2026-04-25`), full ISO
# timestamp, or relative `Nh`/`Nd`. Returns epoch seconds on stdout.
# Errors out on garbage.
#
# Epoch handling lives here so whip's S8 inline-preview path (lib/whip.sh
# reads the cursor file — an epoch — and pipes it via --since) never
# falls through to the GNU `date -d` parser, which silently misreads
# bare integers and would empty the preview body.
_decisions_parse_since() {
  local s="$1"
  if [[ "$s" =~ ^[0-9]+$ ]]; then
    echo "$s"
  elif [[ "$s" =~ ^([0-9]+)h$ ]]; then
    echo $(( $(atmux::now_epoch) - BASH_REMATCH[1] * 3600 ))
  elif [[ "$s" =~ ^([0-9]+)d$ ]]; then
    echo $(( $(atmux::now_epoch) - BASH_REMATCH[1] * 86400 ))
  else
    if ! date -d "$s" +%s 2>/dev/null; then
      atmux::die "decisions list: bad --since format '$s' (use epoch, ISO date, or Nh/Nd)"
    fi
  fi
}

# ---------- add ----------

_atmux_decisions_add() {
  local question="" default="" reversibility="low" note=""
  local context="" impact="" decided_by=""
  local options=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --default)       default="$2"; shift 2 ;;
      --reversibility) reversibility="$2"; shift 2 ;;
      --note)          note="$2"; shift 2 ;;
      --context)       context="$2"; shift 2 ;;
      --option)        options+=("$2"); shift 2 ;;
      --impact)        impact="$2"; shift 2 ;;
      --decided-by)    decided_by="$2"; shift 2 ;;
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

  # E6/Sd context-richness gate (driver ASK-2 / 2026-04-26).
  # high/medium reversibility decisions interrupt the driver in real
  # time via the Discord rich ping; the ping inlines --context /
  # --impact / --note. Without at least one prose field, the ping
  # collapses to question + default + show-pointer, forcing the driver
  # to shell in to read the actual call. One prose line is the bar;
  # --context is canonical, --note acceptable as the lighter
  # reviewer-style annotation. low reversibility unaffected (digest-
  # batched path tolerates terse entries).
  case "$reversibility" in
    high|medium)
      if [[ -z "$context" && -z "$note" ]]; then
        atmux::die "decisions add: --context (or --note) required for $reversibility-reversibility decisions.

  Rationale: $reversibility-rev decisions interrupt the driver in real-time via Discord. The ping shows your --context/--impact/--note inline; without them, the ping is just question + default + show-pointer, forcing the driver to shell in to read your decision. One prose line is the bar.

  Example:
    atmux decisions add \"<question>\" --default \"<answer>\" \\
      --reversibility $reversibility \\
      --context \"<the constraint or design fork that forced the question>\" \\
      --option \"<alternative A>\" --option \"<alternative B>\" \\
      --impact \"<what migrates if driver overrides>\""
      fi
      ;;
  esac

  question="$(_decisions_oneline "$question")"
  default="$(_decisions_oneline "$default")"
  note="$(_decisions_oneline "$note")"
  context="$(_decisions_oneline "$context")"
  impact="$(_decisions_oneline "$impact")"
  decided_by="$(_decisions_oneline "$decided_by")"

  local _i
  for _i in "${!options[@]}"; do
    options[_i]="$(_decisions_oneline "${options[_i]}")"
  done

  # E2/S10 (was S9): per-field byte caps removed. Long fields are now
  # accepted at the data layer; T2 (compose-time chunker) handles
  # Discord's per-message 2000-char and per-line ≤80-char budgets at
  # render time so users can write rich context once + have it chunked
  # into multiple bullets/posts automatically.
  #
  # The ONE structural constraint that survives: max 5 --option
  # occurrences. That's a UX shape limit on the options sub-list (a
  # decision with 20 options isn't a decision; rewrite as a longer
  # context block) — not a byte cap, so it stays here.
  if (( ${#options[@]} > 5 )); then
    atmux::die "decisions add: --option max 5 occurrences (got ${#options[@]})"
  fi
  # TODO(T2): wire compose-time chunker — long fields are now legal at
  # data layer; renderer + Discord ping must split into multiple
  # bullets/posts per ADR-008 §S10.

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

  # _decisions_append signature: f id q d rev note epoch hhmm context impact
  # decided_by options_count [options...]. Pass-through on the empty arrays
  # is fine — `"${options[@]}"` expands to nothing when length is 0.
  atmux::with_lock "$f" _decisions_append \
    "$f" "$id" "$question" "$default" "$reversibility" "$note" "$epoch" "$hhmm" \
    "$context" "$impact" "$decided_by" "${#options[@]}" "${options[@]}"

  # Reversibility gate (E6/S1 §S11): `high` AND `medium` interrupt the
  # driver in real time with the rich, section-by-section chunked render.
  # `low` stays whip-batched (markdown already appended above; the whip
  # tick's inline preview surfaces the count + 1-line gist + digest
  # pointer) for noise control. Medium decisions are typical demo-
  # shaping calls where override windows matter — driver explicitly
  # opted into the higher channel volume to gain real-time visibility.
  if [[ "$reversibility" =~ ^(high|medium)$ ]]; then
    _decisions_export_webhook
    local team; team="$(atmux::team_name)"
    # E2/S10: renderer emits 1..5 NUL-separated chunks (single-message
    # path stays as 1 chunk, no `[N/M]` tag). Mirrors digest's
    # mapfile-then-loop pattern from _atmux_decisions_digest. 1s sleep
    # between chunks honors Discord's rate-limit margin.
    local chunks=()
    mapfile -d '' chunks < <(_decisions_render_discord \
      "$id" "$question" "$default" "$reversibility" "$note" "$team" "$hhmm" \
      "$context" "$impact" "$decided_by" "${#options[@]}" "${options[@]}")
    local total=${#chunks[@]} _i
    for (( _i=0; _i<total; _i++ )); do
      atmux::discord_ping "${chunks[_i]}"
      if (( _i < total - 1 )); then sleep 1; fi
    done
  fi

  atmux::ok "decisions: recorded $id"
  printf '%s\n' "$id"
}

_decisions_append() {
  local f="$1" id="$2" question="$3" default="$4" rev="$5" note="$6" epoch="$7" hhmm="$8"
  local context="${9:-}" impact="${10:-}" decided_by="${11:-}"
  local options_count="${12:-0}"
  shift 12 || shift $#
  local options=("$@")

  if [[ ! -f "$f" ]]; then
    cat > "$f" <<'EOF'
# atmux decisions — append-only log

Lead/planner auto-resolutions, one entry per recommended-default applied.
Override window: see each entry's `override` line. Discord ping fires per
add (ADR-008).

EOF
  fi

  # Optional E2/S9 fields are emitted only when non-empty so an entry with
  # no new flags is bit-identical to today's format (backward compat with
  # any external readers + greppers that rely on the old field shape).
  {
    printf '\n### %s — %s [%s] (%s)\n\n' "$id" "$question" "$rev" "$hhmm"
    printf -- '- **timestamp**: %s\n' "$epoch"
    printf -- '- **question**: %s\n' "$question"
    printf -- '- **default**: %s\n' "$default"
    printf -- '- **reversibility**: %s\n' "$rev"
    if [[ -n "$note" ]]; then
      printf -- '- **note**: %s\n' "$note"
    fi
    if [[ -n "$context" ]]; then
      printf -- '- **context**: %s\n' "$context"
    fi
    if (( options_count > 0 )); then
      printf -- '- **options**:\n'
      local _opt
      for _opt in "${options[@]}"; do
        printf -- '  - %s\n' "$_opt"
      done
    fi
    if [[ -n "$impact" ]]; then
      printf -- '- **impact**: %s\n' "$impact"
    fi
    if [[ -n "$decided_by" ]]; then
      printf -- '- **decided-by**: %s\n' "$decided_by"
    fi
    printf -- '- **override**: `atmux send lead "override %s: <new>"`\n' "$id"
  } >> "$f"
}

_decisions_render_discord() {
  local id="$1" question="$2" default="$3" rev="$4" note="$5" team="$6" hhmm="$7"
  local context="${8:-}" impact="${9:-}" decided_by="${10:-}"
  local options_count="${11:-0}"
  shift 11 || shift $#
  local options=("$@")

  local emoji; emoji="$(_decisions_rev_emoji "$rev")"
  local truncation_marker="↳ atmux decisions show $id for full"

  # E2/S10 (was S9 truncate-pattern). Renderer now emits 1..N NUL-
  # separated chunks. Caller (mapfile -d '' chunks < <(...)) loops with
  # a 1s sleep between to stay under Discord's rate-limit margin.
  #
  # Richness gate (E9/Sb, ADR-020): rev=="high" gets full optional-
  # section expansion (multi-chunk if needed). rev=="medium"|"low" gets
  # COMPACT mode — only the required block; optional sections are
  # SKIPPED from the ping body. _decisions_append still records full
  # fields to decisions.md regardless of rev; show-pointer is the
  # recovery surface for compact-mode pings.
  #
  # Single-message path: ≤1900 chars total ⇒ 1 chunk, no [N/M] tag,
  # bit-identical to today's body shape (modulo the 'question:' prefix
  # added in S9 T2).
  #
  # Multi-message path (high-rev only): chunk-1 ALWAYS holds required
  # fields (question, default, decided-by, reversibility, show/
  # override). Optional sections (context, options, impact, note) flow
  # into chunks 2..5 in keep-order (context→options→impact→note); each
  # section is atomic (option list stays whole). Per chunk header gets
  # the `[N/M]` tag mirroring digest's pattern.
  #
  # Per-field truncation (high-rev only): each of context/impact/
  # individual option/note is capped at ~400 chars BEFORE chunker
  # assembly. `truncated` flips on first cap-hit; on emit the
  # truncation marker is appended once to the last surviving chunk.
  #
  # Last-resort drop: if even at 5 chunks some sections still don't
  # fit, drop in S9 order — note → impact → options → context — and
  # append the truncation marker to the LAST surviving chunk so the
  # human can recover the dropped detail via `atmux decisions show`.

  # Build the section blocks (each a multi-line string, no leading/
  # trailing blank lines).
  local req=""
  req+="🔵 question: $question"$'\n'
  req+="✅ default: $default"$'\n'
  [[ -n "$decided_by" ]] && req+="👤 decided-by: $decided_by"$'\n'
  req+="$emoji reversibility: $rev"$'\n'
  req+="📍 atmux decisions show $id"$'\n'
  req+="↪ atmux send lead \"override $id: <new>\""

  # Compact mode (medium/low): emit only the required block, single
  # chunk, no [N/M] tag. Optional sections are intentionally omitted
  # from the wire — show-pointer recovers the full record.
  if [[ "$rev" != "high" ]]; then
    local hdr_compact="📋 **[atmux-decisions]** · \`$team\` · $hhmm"
    printf '%s\0' "$hdr_compact"$'\n\n'"$req"
    return 0
  fi

  # High-rev: build optional sections with ~400-char per-field cap.
  local field_cap=400
  local truncated=0
  local sec_ctx=""  sec_opts=""  sec_imp=""  sec_note=""
  if [[ -n "$context" ]]; then
    if (( ${#context} > field_cap )); then
      sec_ctx="🌐 context: ${context:0:field_cap}"
      truncated=1
    else
      sec_ctx="🌐 context: $context"
    fi
  fi
  if (( options_count > 0 )); then
    sec_opts="⚖️ options:"
    local _o
    for _o in "${options[@]}"; do
      if (( ${#_o} > field_cap )); then
        sec_opts+=$'\n'"  - ${_o:0:field_cap}"
        truncated=1
      else
        sec_opts+=$'\n'"  - $_o"
      fi
    done
  fi
  if [[ -n "$impact" ]]; then
    if (( ${#impact} > field_cap )); then
      sec_imp="💥 impact: ${impact:0:field_cap}"
      truncated=1
    else
      sec_imp="💥 impact: $impact"
    fi
  fi
  if [[ -n "$note" ]]; then
    if (( ${#note} > field_cap )); then
      sec_note="📝 note: ${note:0:field_cap}"
      truncated=1
    else
      sec_note="📝 note: $note"
    fi
  fi

  # ---- single-message try ----
  local hdr_single="📋 **[atmux-decisions]** · \`$team\` · $hhmm"
  local single="$hdr_single"$'\n\n'"$req"
  local s
  for s in "$sec_ctx" "$sec_opts" "$sec_imp" "$sec_note"; do
    [[ -n "$s" ]] && single+=$'\n\n'"$s"
  done
  if (( ${#single} <= 1900 )); then
    (( truncated > 0 )) && single+=$'\n\n'"$truncation_marker"
    printf '%s\0' "$single"
    return 0
  fi

  # ---- multi-message allocation ----
  # Header overhead reserve: '📋 **[atmux-decisions]** [9/9] · `<team>` · HH:MM MYT'
  # plus a trailing '\n\n' (separator). 80 chars covers any reasonable
  # team name; bigger names just compress the body budget proportionally.
  local hdr_overhead=80
  local body_budget=$(( 1900 - hdr_overhead ))
  local max_chunks=5

  # Parallel arrays: section content (in keep-order — context first,
  # note last). Drop order is the reverse so we evict tail-first.
  local sections=()
  [[ -n "$sec_ctx"  ]] && sections+=("$sec_ctx")
  [[ -n "$sec_opts" ]] && sections+=("$sec_opts")
  [[ -n "$sec_imp"  ]] && sections+=("$sec_imp")
  [[ -n "$sec_note" ]] && sections+=("$sec_note")

  # chunks[0] = required block (always present). chunks[1..] = optional
  # sections, packed in order — each new section either appends to the
  # current optional chunk (if it fits) or opens a fresh chunk.
  local chunks=("$req")
  local current=""           # in-progress optional chunk content
  local skipped=0            # count of sections we couldn't fit anywhere

  local sec
  for sec in "${sections[@]}"; do
    local candidate
    if [[ -z "$current" ]]; then
      candidate="$sec"
    else
      candidate="$current"$'\n\n'"$sec"
    fi
    if (( ${#candidate} <= body_budget )); then
      current="$candidate"
      continue
    fi
    # Doesn't fit appended — flush current to chunks[] (if any) and
    # try opening a fresh chunk for this section.
    if [[ -n "$current" ]]; then
      chunks+=("$current")
      current=""
    fi
    if (( ${#chunks[@]} >= max_chunks )); then
      skipped=$((skipped + 1))
      continue
    fi
    if (( ${#sec} <= body_budget )); then
      current="$sec"
    else
      # Single section bigger than a fresh chunk's body budget — drop.
      skipped=$((skipped + 1))
    fi
  done
  [[ -n "$current" ]] && chunks+=("$current")

  # If anything dropped OR per-field truncation hit the 400-char cap,
  # append the recovery pointer to the last chunk so the reader can
  # `atmux decisions show <id>` for the full record. One marker covers
  # both conditions.
  if (( skipped > 0 || truncated > 0 )); then
    local last=$(( ${#chunks[@]} - 1 ))
    chunks[last]="${chunks[last]}"$'\n\n'"$truncation_marker"
  fi

  # ---- emit each chunk with [N/M] header, NUL-separated ----
  local total=${#chunks[@]} i
  for (( i=0; i<total; i++ )); do
    local hdr="📋 **[atmux-decisions]** [$((i+1))/$total] · \`$team\` · $hhmm"
    local body="$hdr"$'\n\n'"${chunks[i]}"
    printf '%s\0' "$body"
  done
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

# ---------- digest ----------
#
# Posts a single consolidated Discord digest of all decisions logged since
# `.atmux/state/decisions-digest-cursor`. Designed for periodic crons that
# want a low-noise "what got auto-resolved this hour/day?" recap, separate
# from per-add high-rev pings (gated by `_atmux_decisions_add`) and from
# whip's pointer-only cursor.
#
# Cursor advances only when ≥1 decision was emitted — empty window leaves
# the cursor untouched so the next digest catches the first new decision.
# Discord ping is fire-and-warn: cursor moves whether the ping succeeded
# or not (discord_ping swallows curl rc per ADR-008).

_atmux_decisions_digest() {
  local f; f="$(_decisions_file)"
  local cursor_file; cursor_file="$(atmux::state_dir)/decisions-digest-cursor"
  local cursor=0
  if [[ -f "$cursor_file" ]]; then
    local raw; raw="$(cat "$cursor_file" 2>/dev/null || echo 0)"
    [[ "$raw" =~ ^[0-9]+$ ]] && cursor="$raw"
  fi

  local entries; entries="$(_decisions_to_json_array "$f")"
  local filtered
  filtered="$(jq --argjson c "$cursor" \
                 '[.[] | select(.timestamp > $c)] | sort_by(.timestamp)' \
                 <<<"$entries")"
  local n; n="$(jq 'length' <<<"$filtered")"

  if [[ "$n" -eq 0 ]]; then
    echo "no new decisions since digest cursor"
    return 0
  fi

  local bullets=() emoji
  local id rev question default
  while IFS=$'\t' read -r id rev question default; do
    emoji="$(_decisions_rev_emoji "$rev")"
    bullets+=("$emoji $id $question → $default")
  done < <(jq -r '.[] | [.id, .reversibility, .question, .default] | @tsv' \
              <<<"$filtered")

  local team; team="$(atmux::team_name)"
  local hhmm; hhmm="$(atmux::now_myt)"
  local since_str
  if (( cursor > 0 )); then
    since_str="$(date -d "@$cursor" +'%Y-%m-%d %H:%M' 2>/dev/null \
              || date -r "$cursor"  +'%Y-%m-%d %H:%M' 2>/dev/null \
              || echo "$cursor")"
  else
    since_str="beginning"
  fi
  local header
  header="$(printf '📋 **[atmux-digest]** · `%s` · %s · %s decisions since %s' \
            "$team" "$hhmm" "$n" "$since_str")"

  # Reserve 16 chars of headroom in the chunker budget so the per-chunk
  # `[N/M] ` prefix (6 chars at typical M<10) never tips us over 2000.
  local budget=1984
  local groups=()
  mapfile -d '' groups < <(_decisions_chunk_for_discord "$header" "$budget" \
                            "${bullets[@]}")
  local total=${#groups[@]}

  _decisions_export_webhook
  local i body
  for (( i=0; i<total; i++ )); do
    if (( total > 1 )); then
      body="[$((i + 1))/$total] $header"$'\n\n'"${groups[$i]}"
    else
      body="${header}"$'\n\n'"${groups[$i]}"
    fi
    atmux::discord_ping "$body"
    if (( i < total - 1 )); then sleep 1; fi
  done

  mkdir -p "$(dirname "$cursor_file")"
  atmux::now_epoch > "$cursor_file"

  if (( total > 1 )); then
    atmux::ok "decisions: digest sent ($n decisions, $total chunks)"
  else
    atmux::ok "decisions: digest sent ($n decisions)"
  fi
}

# Group bullets into chunks such that `<header>\n\n<chunk>` fits within
# $max chars. Bullets are atomic — never split mid-decision. Emits each
# chunk's bullet block (header NOT included; caller composes per-chunk) on
# stdout, NUL-separated for safe `mapfile -d ''` ingestion.
_decisions_chunk_for_discord() {
  local header="$1" max="$2"; shift 2
  local hlen=$(( ${#header} + 2 ))   # +2 for the \n\n header→body separator
  local group="" started=0 bullet candidate
  for bullet in "$@"; do
    if (( started == 0 )); then
      candidate="$bullet"
    else
      candidate="${group}"$'\n'"${bullet}"
    fi
    if (( hlen + ${#candidate} > max )); then
      printf '%s\0' "$group"
      group="$bullet"
    else
      group="$candidate"
    fi
    started=1
  done
  if (( started == 1 )); then
    printf '%s\0' "$group"
  fi
}
