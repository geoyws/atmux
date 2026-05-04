#!/usr/bin/env bash
# atmux report — 30-min progress digest. Intended for cron:
#
#   */30 * * * * cd /path/to/project && /usr/local/bin/atmux report >> .atmux/logs/report.log 2>&1
#
# Generates + prints + (optionally) pings Discord with: shipped tasks since last
# report, in-progress counts per member, blockers, open driver-inbox asks.

# shellcheck source=discord.sh
. "$ATMUX_LIB_DIR/discord.sh"

main() {
  atmux::require jq
  atmux::require_team

  local push_discord=1
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-discord) push_discord=0; shift ;;
      *) atmux::die "report: unknown arg: $1" ;;
    esac
  done

  local team; team="$(atmux::team_name)"
  local ts; ts="$(atmux::now_myt)"

  local last_file="$(atmux::state_dir)/last-report.epoch"
  local last; last=$(cat "$last_file" 2>/dev/null || echo 0)
  local now; now=$(atmux::now_epoch)

  local k; k="$(atmux::kanban_json)"

  local shipped_rows=""
  if [[ -f "$k" ]]; then
    shipped_rows=$(jq -r --argjson last "$last" \
      '.tasks[] | select(.status=="done" and (.completedAt // 0) > $last)
        | "  ✅ \(.id) · \(.owner // "?") · \(.subject)"' "$k")
  fi
  local shipped_n; shipped_n=$(echo -n "$shipped_rows" | grep -c '^' || true)

  # In-progress per member.
  local ip_rows=""
  if [[ -f "$k" ]]; then
    ip_rows=$(jq -r '.tasks[] | select(.status=="in-progress")
      | "  🟡 \(.id) · \(.owner // "?") · \(.subject)"' "$k")
  fi

  local blocked_rows=""
  if [[ -f "$k" ]]; then
    blocked_rows=$(jq -r '.tasks[] | select(.status=="blocked")
      | "  🛑 \(.id) · \(.owner // "?") · \(.subject)"' "$k")
  fi

  local di; di="$(atmux::driver_inbox)"
  local open_asks=""
  if [[ -f "$di" ]]; then
    open_asks=$(awk '/^## Open/{flag=1;next}/^## /{flag=0}flag && /^- /' "$di")
  fi

  # Stdout body — single concatenation for cron log readability. Discord
  # path below pre-batches large row-blocks at row boundaries and feeds the
  # shared chunker (lib/discord.sh _atmux_chunk_for_embed) so giant reports
  # don't hit the 4096-byte embed-description cap (HTTP 400
  # BASE_TYPE_MAX_LENGTH pre-fix).
  local hdr_template="📊 **[atmux-report]** · \`$team\` · $ts"

  local body="$hdr_template"
  body+=$'\n\n'"🏗️ **Shipped** (since last report): $shipped_n"
  [[ -n "$shipped_rows" ]] && body+=$'\n'"$shipped_rows"
  body+=$'\n\n'"🟡 **In-progress**"
  if [[ -n "$ip_rows" ]]; then
    body+=$'\n'"$ip_rows"
  else
    body+=$'\n  (none)'
  fi
  [[ -n "$blocked_rows" ]] && body+=$'\n\n'"🛑 **Blocked**"$'\n'"$blocked_rows"
  [[ -n "$open_asks"    ]] && body+=$'\n\n'"🙏 **Open driver-inbox asks**"$'\n'"$open_asks"
  echo "$body"

  if [[ "$push_discord" -eq 1 ]]; then
    # Pre-batch shipped rows at row boundaries so no single section exceeds
    # the chunker's body_budget. Without this, sections[0] could exceed
    # 4096 bytes and Discord rejects on the first chunk. Each batch fits
    # in ~3500 chars, leaving headroom for the section-header line.
    local row_batch_max=3500
    local sections=()
    sections+=("🏗️ **Shipped** (since last report): $shipped_n")
    _atmux_report_emit_row_batches "$shipped_rows" "$row_batch_max" sections

    sections+=("🟡 **In-progress**")
    if [[ -n "$ip_rows" ]]; then
      _atmux_report_emit_row_batches "$ip_rows" "$row_batch_max" sections
    else
      sections+=("  (none)")
    fi

    if [[ -n "$blocked_rows" ]]; then
      sections+=("🛑 **Blocked**")
      _atmux_report_emit_row_batches "$blocked_rows" "$row_batch_max" sections
    fi

    if [[ -n "$open_asks" ]]; then
      sections+=("🙏 **Open driver-inbox asks**")
      _atmux_report_emit_row_batches "$open_asks" "$row_batch_max" sections
    fi

    # max_body=4000 leaves margin under Discord's 4096 embed-description
    # cap. max_chunks=10 covers ~30-40KB of content; over-cap drops with
    # show-cmd marker.
    local marker="↳ atmux report log for full"
    local chunks=()
    mapfile -d '' chunks < <(_atmux_chunk_for_embed \
      "$hdr_template" 4000 10 "$marker" "${sections[@]}")

    local total=${#chunks[@]} _i
    for (( _i=0; _i<total; _i++ )); do
      local hdr
      if (( total == 1 )); then
        hdr="$hdr_template"
      else
        hdr="📊 **[atmux-report]** [$((_i+1))/$total] · \`$team\` · $ts"
      fi
      ATMUX_DISCORD_TRIGGER="${ATMUX_DISCORD_TRIGGER:-report}" \
        atmux::discord_embed_ping "$hdr"$'\n\n'"${chunks[_i]}"
      (( _i < total - 1 )) && sleep 1
    done
  fi

  echo "$now" > "$last_file"
}

# _atmux_report_emit_row_batches <rows> <max-bytes> <out-array-name>
# Append <rows> to <out-array-name> as one or more batches. Each batch is
# a multi-line block where consecutive rows pack greedily up to
# <max-bytes>; row boundaries are preserved (never split a row mid-field).
# Empty input → no append.
_atmux_report_emit_row_batches() {
  local rows="$1" max="$2" out_name="$3"
  [[ -n "$rows" ]] || return 0
  local batch="" row candidate
  while IFS= read -r row; do
    [[ -z "$row" ]] && continue
    if [[ -z "$batch" ]]; then
      candidate="$row"
    else
      candidate="$batch"$'\n'"$row"
    fi
    if (( ${#candidate} <= max )); then
      batch="$candidate"
      continue
    fi
    [[ -n "$batch" ]] && eval "$out_name+=(\"\$batch\")"
    batch="$row"
  done <<< "$rows"
  [[ -n "$batch" ]] && eval "$out_name+=(\"\$batch\")"
}
