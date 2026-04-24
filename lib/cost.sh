#!/usr/bin/env bash
# atmux cost [--member <name>] [--since <iso|epoch>] [--json]
#
# Cost tracking. Best-effort across TUIs:
#   - claude: parse ~/.claude/projects/<slug>/*.jsonl for usage blocks.
#   - others: shows "unknown" (todo: opencode has its own session files, etc.)
#
# Results cached at .atmux/state/cost-<member>.json so repeated runs (whip ticks)
# don't re-parse the full history every time.

# Compute cost for the whole team since <epoch>. Returns JSON with totalUsd + members[].
atmux::compute_team_cost() {
  local since="${1:-0}"
  local results='[]'
  local total_usd=0
  local m name tui cwd detail usd
  while IFS= read -r m; do
    [[ -z "$m" ]] && continue
    name=$(jq -r '.name' <<<"$m")
    tui=$(jq -r '.tui // "claude"' <<<"$m")
    cwd=$(jq -r '.cwd // "."' <<<"$m")
    detail="$(atmux::compute_member_cost "$name" "$tui" "$cwd" "$since")"
    usd="$(jq -r '.usd // 0' <<<"$detail")"
    total_usd=$(awk -v a="$total_usd" -v b="$usd" 'BEGIN{printf "%.6f", a+b}')
    results=$(jq --argjson d "$detail" --argjson r "$results" '$r + [$d]' <<<"null")
  done < <(jq -c '.members[]' "$(atmux::team_json)")
  jq -n --argjson members "$results" --argjson total "$total_usd" \
    '{totalUsd: $total, members: $members}'
}

main() {
  atmux::require jq
  atmux::require_team

  local filter_member="" since="" json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --member) filter_member="$2"; shift 2 ;;
      --since)  since="$2"; shift 2 ;;
      --json)   json=1; shift ;;
      *) atmux::die "cost: unknown arg: $1" ;;
    esac
  done

  local since_epoch=0
  if [[ -n "$since" ]]; then
    if [[ "$since" =~ ^[0-9]+$ ]]; then
      since_epoch="$since"
    else
      since_epoch=$(date -d "$since" +%s 2>/dev/null || echo 0)
    fi
  else
    local sf="$(atmux::state_dir)/session-start.txt"
    [[ -f "$sf" ]] && since_epoch=$(cat "$sf")
  fi

  local results='[]'
  local total_usd=0

  local m name tui cwd usd detail
  while IFS= read -r m; do
    [[ -z "$m" ]] && continue
    name=$(jq -r '.name' <<<"$m")
    if [[ -n "$filter_member" && "$filter_member" != "$name" ]]; then continue; fi
    tui=$(jq -r '.tui // "claude"' <<<"$m")
    cwd=$(jq -r '.cwd // "."' <<<"$m")

    detail="$(atmux::compute_member_cost "$name" "$tui" "$cwd" "$since_epoch")"
    usd="$(jq -r '.usd // 0' <<<"$detail")"
    total_usd=$(awk -v a="$total_usd" -v b="$usd" 'BEGIN{printf "%.4f", a+b}')

    results=$(jq -n --argjson d "$detail" --argjson r "$results" '$r + [$d]')

    # Persist cache.
    local cf="$(atmux::state_dir)/cost-$name.json"
    mkdir -p "$(dirname "$cf")"
    echo "$detail" > "$cf"
  done < <(jq -c '.members[]' "$(atmux::team_json)")

  if [[ "$json" -eq 1 ]]; then
    jq -n --argjson members "$results" --argjson total "$total_usd" \
      '{totalUsd: $total, members: $members}'
  else
    printf '%s💰 cost%s — since %s (epoch %s)\n\n' \
      "$atmux_c_bld$atmux_c_cyn" "$atmux_c_rst" \
      "$(date -d @"$since_epoch" +'%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "-")" \
      "$since_epoch"
    jq -r '.[] | [.member, (.usd | tostring), .tokens.total, .source] | @tsv' <<<"$results" |
      awk -F'\t' 'BEGIN{printf "  %-14s %-10s %-12s %s\n", "MEMBER", "USD", "TOKENS", "SOURCE"}
        {printf "  %-14s $%-9s %-12s %s\n", $1, $2, $3, $4}'
    printf '\n  %sTOTAL%s: $%s\n' "$atmux_c_bld" "$atmux_c_rst" "$total_usd"
  fi
}

# atmux::compute_member_cost <name> <tui> <cwd> <since-epoch>
# Returns JSON: {member, tui, usd, tokens:{input,output,cacheWrite,cacheRead,total}, source, files}
atmux::compute_member_cost() {
  local name="$1" tui="$2" cwd="$3" since="$4"
  case "$tui" in
    claude) _atmux_cost_claude "$name" "$cwd" "$since" ;;
    *) jq -n --arg m "$name" --arg tui "$tui" \
         '{member: $m, tui: $tui, usd: 0, tokens: {input:0, output:0, cacheWrite:0, cacheRead:0, total:0}, source: "unknown", files: []}' ;;
  esac
}

_atmux_cost_claude() {
  local name="$1" cwd="$2" since="$3"

  # Resolve projects directory for this cwd. Claude Code stores sessions at
  # ~/.claude/projects/<slug-of-abspath>/<uuid>.jsonl where slug replaces / with -.
  local abs; abs=$(cd "$cwd" 2>/dev/null && pwd || echo "$cwd")
  local slug="${abs//\//-}"
  local proj_dir="$HOME/.claude/projects/$slug"

  local files=()
  if [[ -d "$proj_dir" ]]; then
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      local mt; mt=$(stat -c '%Y' "$f" 2>/dev/null || stat -f '%m' "$f" 2>/dev/null || echo 0)
      if [[ "$mt" -ge "$since" ]]; then
        files+=("$f")
      fi
    done < <(find "$proj_dir" -maxdepth 2 -name '*.jsonl' -type f 2>/dev/null)
  fi

  local pricing_file="${ATMUX_PRICING_FILE:-$ATMUX_ROOT/lib/pricing.json}"
  local pricing; pricing=$(cat "$pricing_file" 2>/dev/null || echo '{"default":{"input":3,"output":15,"cacheWrite":3.75,"cacheRead":0.3}}')

  local in=0 out=0 cw=0 cr=0 usd=0
  local f
  for f in "${files[@]}"; do
    local chunk
    chunk=$(jq --argjson pr "$pricing" -s '
      map(select(.type == "assistant" and (.message.usage != null))) |
      map(.message.usage as $u | (.message.model // "default") as $model |
          ($pr[$model] // $pr.default) as $p |
          {
            input:      ($u.input_tokens // 0),
            output:     ($u.output_tokens // 0),
            cacheWrite: ($u.cache_creation_input_tokens // 0),
            cacheRead:  ($u.cache_read_input_tokens // 0),
            usd: (
              (($u.input_tokens // 0)              * $p.input      / 1000000) +
              (($u.output_tokens // 0)             * $p.output     / 1000000) +
              (($u.cache_creation_input_tokens // 0) * $p.cacheWrite / 1000000) +
              (($u.cache_read_input_tokens // 0)   * $p.cacheRead  / 1000000)
            )
          }) |
      reduce .[] as $x ({input:0,output:0,cacheWrite:0,cacheRead:0,usd:0};
        .input += $x.input | .output += $x.output |
        .cacheWrite += $x.cacheWrite | .cacheRead += $x.cacheRead |
        .usd += $x.usd)
    ' "$f" 2>/dev/null || echo '{"input":0,"output":0,"cacheWrite":0,"cacheRead":0,"usd":0}')
    in=$(( in  + $(jq -r '.input'      <<<"$chunk") ))
    out=$(( out + $(jq -r '.output'     <<<"$chunk") ))
    cw=$(( cw  + $(jq -r '.cacheWrite' <<<"$chunk") ))
    cr=$(( cr  + $(jq -r '.cacheRead'  <<<"$chunk") ))
    usd=$(awk -v a="$usd" -v b="$(jq -r '.usd' <<<"$chunk")" 'BEGIN{printf "%.6f", a+b}')
  done

  local total=$(( in + out + cw + cr ))
  jq -n \
    --arg m "$name" --arg tui claude --argjson usd "$usd" \
    --argjson in "$in" --argjson out "$out" --argjson cw "$cw" --argjson cr "$cr" --argjson total "$total" \
    --argjson files "$(printf '%s\n' "${files[@]}" | jq -R . | jq -s .)" \
    '{member:$m, tui:$tui, usd:$usd,
      tokens:{input:$in, output:$out, cacheWrite:$cw, cacheRead:$cr, total:$total},
      source: "claude-jsonl",
      files:$files}'
}
