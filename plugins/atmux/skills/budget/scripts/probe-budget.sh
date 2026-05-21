#!/usr/bin/env bash
# /atmux:budget — cross-account Claude rate-limit probe.
#
# Auto-discovers ~/.claude-*/.credentials.json, probes each, renders a table or NDJSON.
# Reliability invariants in SKILL.md §"Reliability invariants".
# Carved per ADR-217 §D1.5 (adjacent-asset bundling) + §D4 (generalization).
set -euo pipefail

# ------------------------- arg parse -------------------------
MODE="table"            # table | json
FILTER_ACCOUNT=""        # if non-empty, probe only this label
REFRESH=1                # 0 = --no-refresh
CACHE_ONLY=0             # 1 = --cache-only

while [ $# -gt 0 ]; do
    case "$1" in
        --json)        MODE=json; shift ;;
        --account)     FILTER_ACCOUNT="${2:?--account needs a label}"; shift 2 ;;
        --no-refresh)  REFRESH=0; shift ;;
        --cache-only)  CACHE_ONLY=1; shift ;;
        -h|--help)
            sed -n '/^# \//,/^set/p' "$0" | sed 's/^# \?//' | head -n -2
            exit 0 ;;
        *) echo "unknown arg: $1 (see --help)" >&2; exit 2 ;;
    esac
done

# ------------------------- prereqs -------------------------
for cmd in jq curl flock; do
    command -v "$cmd" >/dev/null 2>&1 || { echo "missing dependency: $cmd" >&2; exit 3; }
done
HOMED="$HOME"
CACHE_DIR="${HOMED}/.atmux/state"
mkdir -p "$CACHE_DIR"

NOW_EPOCH=$(date +%s)
NOW_MS=$((NOW_EPOCH * 1000))
# Output timezone — override via ATMUX_BUDGET_TZ env var (any tz spec accepted
# by `date -d` / TZ=, e.g. 'America/Los_Angeles', 'Europe/London', 'UTC').
# Default UTC for host-agnostic output. Operators on a fixed timezone export
# ATMUX_BUDGET_TZ in their shell rc to get local-time output by default.
BUDGET_TZ="${ATMUX_BUDGET_TZ:-UTC}"
BUDGET_TZ_LABEL=$(TZ="$BUDGET_TZ" date +'%Z' 2>/dev/null || echo "$BUDGET_TZ")

# ------------------------- discover accounts -------------------------
declare -a ACCOUNTS=()
for cdir in "$HOMED"/.claude-*; do
    [ -d "$cdir" ] || continue
    [ -f "$cdir/.credentials.json" ] || continue
    label=$(basename "$cdir" | sed 's/^\.claude-//')
    if [ -n "$FILTER_ACCOUNT" ] && [ "$label" != "$FILTER_ACCOUNT" ]; then
        continue
    fi
    ACCOUNTS+=("$label")
done

if [ ${#ACCOUNTS[@]} -eq 0 ]; then
    echo "no accounts discovered under ${HOMED}/.claude-*/.credentials.json${FILTER_ACCOUNT:+ matching '$FILTER_ACCOUNT'}" >&2
    exit 4
fi

# ------------------------- per-account probe -------------------------
# Emit a NDJSON line per account to a tempfile, then render.
NDJSON=$(mktemp)
trap 'rm -f "$NDJSON"' EXIT

probe_one() {
    local label="$1"
    local cdir="${HOMED}/.claude-${label}"
    local creds="${cdir}/.credentials.json"
    local cache="${CACHE_DIR}/budget-probe-${label}.json"

    # --cache-only path
    if [ "$CACHE_ONLY" = "1" ]; then
        if [ -f "$cache" ]; then
            local probed_at h5u wku h5r wkr sta
            read -r probed_at h5u wku h5r wkr sta < <(
                jq -r '[.probedAt, .h5_util, .wk_util, .h5_reset, .wk_reset, .status] | @tsv' "$cache"
            )
            local age=$((NOW_EPOCH - probed_at))
            jq -n -c \
                --arg label "$label" \
                --argjson h5u "${h5u:-null}" \
                --argjson wku "${wku:-null}" \
                --argjson h5r "${h5r:-0}" \
                --argjson wkr "${wkr:-0}" \
                --arg sta "$sta" \
                --argjson probed "$probed_at" \
                --argjson age "$age" \
                '{label:$label, h5_util:$h5u, wk_util:$wku, h5_reset:$h5r, wk_reset:$wkr, status:$sta, probedAt:$probed, cacheAgeSec:$age, source:"cache"}'
        else
            jq -n -c --arg label "$label" '{label:$label, error:"no_cache", source:"cache"}'
        fi
        return
    fi

    # Read credentials under shared lock (atomic vs claude's refresh-write).
    if ! { flock -s 9; jq -r '.claudeAiOauth | "\(.accessToken)\t\(.refreshToken // "")\t\(.expiresAt // 0)"' < "$creds"; } 9< "$creds" > /tmp/budget-creds-$$.tsv 2>/dev/null; then
        jq -n -c --arg label "$label" '{label:$label, error:"creds_unreadable"}'
        return
    fi
    IFS=$'\t' read -r access refresh expires_at_ms < /tmp/budget-creds-$$.tsv
    rm -f /tmp/budget-creds-$$.tsv
    if [ -z "$access" ] || [ "$access" = "null" ]; then
        jq -n -c --arg label "$label" '{label:$label, error:"no_access_token"}'
        return
    fi

    # Pre-refresh if expired or within 60s of expiry, and --no-refresh not set.
    local expires_s=$(( expires_at_ms / 1000 ))
    if [ "$REFRESH" = "1" ] && [ "$expires_s" -le $((NOW_EPOCH + 60)) ]; then
        refresh_via_claude "$label" || true
        # Re-read credentials after the warmup.
        IFS=$'\t' read -r access refresh expires_at_ms < <(
            flock -s "$creds" jq -r '.claudeAiOauth | "\(.accessToken)\t\(.refreshToken // "")\t\(.expiresAt // 0)"' "$creds" 2>/dev/null
        )
    fi

    # Do the probe.
    local hdrfile body http
    hdrfile=$(mktemp)
    http=$(curl -sS -o /dev/null -D "$hdrfile" -w '%{http_code}' \
        -X POST https://api.anthropic.com/v1/messages \
        -H "authorization: Bearer ${access}" \
        -H "anthropic-version: 2023-06-01" \
        -H "anthropic-beta: oauth-2025-04-20" \
        -H "content-type: application/json" \
        --data '{"model":"claude-haiku-4-5","max_tokens":1,"messages":[{"role":"user","content":"."}]}' \
        --max-time 15 2>/dev/null || echo "0")

    # If 401 and refresh is enabled and we haven't refreshed yet this call, refresh + retry once.
    if [ "$http" = "401" ] && [ "$REFRESH" = "1" ]; then
        rm -f "$hdrfile"; hdrfile=$(mktemp)
        refresh_via_claude "$label" || true
        IFS=$'\t' read -r access refresh expires_at_ms < <(
            flock -s "$creds" jq -r '.claudeAiOauth | "\(.accessToken)\t\(.refreshToken // "")\t\(.expiresAt // 0)"' "$creds" 2>/dev/null
        )
        http=$(curl -sS -o /dev/null -D "$hdrfile" -w '%{http_code}' \
            -X POST https://api.anthropic.com/v1/messages \
            -H "authorization: Bearer ${access}" \
            -H "anthropic-version: 2023-06-01" \
            -H "anthropic-beta: oauth-2025-04-20" \
            -H "content-type: application/json" \
            --data '{"model":"claude-haiku-4-5","max_tokens":1,"messages":[{"role":"user","content":"."}]}' \
            --max-time 15 2>/dev/null || echo "0")
    fi

    local h5u wku h5r wkr sta err=""
    h5u=$(grep -i '^anthropic-ratelimit-unified-5h-utilization:' "$hdrfile" | awk '{print $2}' | tr -d '\r' | head -1)
    wku=$(grep -i '^anthropic-ratelimit-unified-7d-utilization:' "$hdrfile" | awk '{print $2}' | tr -d '\r' | head -1)
    h5r=$(grep -i '^anthropic-ratelimit-unified-5h-reset:'       "$hdrfile" | awk '{print $2}' | tr -d '\r' | head -1)
    wkr=$(grep -i '^anthropic-ratelimit-unified-7d-reset:'       "$hdrfile" | awk '{print $2}' | tr -d '\r' | head -1)
    sta=$(grep -i '^anthropic-ratelimit-unified-status:'         "$hdrfile" | awk '{print $2}' | tr -d '\r' | head -1)
    rm -f "$hdrfile"

    # Set error flag for non-2xx without rate-limit headers (true failure).
    case "$http" in
        200|429)
            : ;;
        401)
            err="token_invalid" ;;
        0)
            err="network_or_timeout" ;;
        *)
            err="http_${http}" ;;
    esac

    # Fallback to cache if true error AND cache exists.
    if [ -n "$err" ] && [ -f "$cache" ]; then
        local stale_h5u stale_wku stale_h5r stale_wkr stale_sta stale_probed
        read -r stale_probed stale_h5u stale_wku stale_h5r stale_wkr stale_sta < <(
            jq -r '[.probedAt, .h5_util, .wk_util, .h5_reset, .wk_reset, .status] | @tsv' "$cache"
        )
        local age=$((NOW_EPOCH - stale_probed))
        jq -n -c \
            --arg label "$label" \
            --argjson h5u "${stale_h5u:-null}" \
            --argjson wku "${stale_wku:-null}" \
            --argjson h5r "${stale_h5r:-0}" \
            --argjson wkr "${stale_wkr:-0}" \
            --arg sta "$stale_sta" \
            --argjson probed "$stale_probed" \
            --argjson age "$age" \
            --arg err "$err" \
            '{label:$label, h5_util:$h5u, wk_util:$wku, h5_reset:$h5r, wk_reset:$wkr, status:$sta, probedAt:$probed, cacheAgeSec:$age, source:"cache", error:$err, stale:true}'
        return
    fi

    if [ -n "$err" ]; then
        jq -n -c --arg label "$label" --arg err "$err" '{label:$label, error:$err}'
        return
    fi

    # Success path: persist to cache (atomic write).
    local payload
    payload=$(jq -n -c \
        --argjson h5u "${h5u:-null}" \
        --argjson wku "${wku:-null}" \
        --argjson h5r "${h5r:-0}" \
        --argjson wkr "${wkr:-0}" \
        --arg sta "${sta:-unknown}" \
        --argjson probed "$NOW_EPOCH" \
        '{h5_util:$h5u, wk_util:$wku, h5_reset:$h5r, wk_reset:$wkr, status:$sta, probedAt:$probed}')

    local tmp="${cache}.tmp.$$"
    printf '%s\n' "$payload" > "$tmp"
    flock -x "$cache".lock -c "mv \"$tmp\" \"$cache\"" 2>/dev/null || mv "$tmp" "$cache"

    jq -n -c \
        --arg label "$label" \
        --argjson h5u "${h5u:-null}" \
        --argjson wku "${wku:-null}" \
        --argjson h5r "${h5r:-0}" \
        --argjson wkr "${wkr:-0}" \
        --arg sta "${sta:-unknown}" \
        --argjson probed "$NOW_EPOCH" \
        '{label:$label, h5_util:$h5u, wk_util:$wku, h5_reset:$h5r, wk_reset:$wkr, status:$sta, probedAt:$probed, source:"live"}'
}

refresh_via_claude() {
    local label="$1"
    # claude refreshes OAuth at the start of any API-touching command.
    # --print "." is the cheapest (1 cheap-model request, counts against the
    # budget being probed). Cheap-model choice aligns with ADR-140.
    CLAUDE_CONFIG_DIR="${HOMED}/.claude-${label}" timeout 20 \
        claude --print "." --model claude-haiku-4-5 \
        < /dev/null > /dev/null 2>&1 || return 1
    return 0
}

# ------------------------- run probes -------------------------
for label in "${ACCOUNTS[@]}"; do
    probe_one "$label"
done > "$NDJSON"

# ------------------------- render -------------------------
if [ "$MODE" = "json" ]; then
    cat "$NDJSON"
    exit 0
fi

# Pretty table — sort by wk_util ascending (best headroom first), errors last.
NOW_PRETTY=$(TZ="$BUDGET_TZ" date +"%Y-%m-%d %H:%M ${BUDGET_TZ_LABEL}")

# Color helpers (only if stdout is a tty).
if [ -t 1 ]; then
    C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
    C_DIM=$'\033[2m'
else
    C_GREEN=""; C_YELLOW=""; C_RED=""; C_BOLD=""; C_RESET=""; C_DIM=""
fi

fmt_pct() {
    local v="$1"
    if [ "$v" = "null" ] || [ -z "$v" ]; then echo "—"; return; fi
    awk -v v="$v" 'BEGIN{printf "%d%%", v*100}'
}

fmt_reset() {
    # Args: epoch_s
    local ep="$1"
    if [ -z "$ep" ] || [ "$ep" = "0" ]; then echo "—"; return; fi
    local now=$NOW_EPOCH
    local delta=$((ep - now))
    local abs=${delta#-}
    local sign="+"; [ $delta -lt 0 ] && sign="-"
    local hours=$((abs / 3600))
    local mins=$(( (abs % 3600) / 60 ))
    local timestr
    if [ $((ep - now)) -gt 86400 ]; then
        timestr=$(TZ="$BUDGET_TZ" date -d @"$ep" +"%b %d %H:%M ${BUDGET_TZ_LABEL}")
    else
        timestr=$(TZ="$BUDGET_TZ" date -d @"$ep" +"%H:%M ${BUDGET_TZ_LABEL}")
    fi
    if [ $abs -lt 60 ]; then
        printf "%s %s%ds" "$timestr" "$sign" "$abs"
    elif [ $hours -eq 0 ]; then
        printf "%s %s%dmin" "$timestr" "$sign" "$mins"
    else
        printf "%s %s%dh%dm" "$timestr" "$sign" "$hours" "$mins"
    fi
}

color_status() {
    local sta="$1"
    case "$sta" in
        allowed)         printf "%s%s%s" "$C_GREEN" "$sta" "$C_RESET" ;;
        allowed_warning) printf "%s%s%s" "$C_YELLOW" "$sta" "$C_RESET" ;;
        rejected)        printf "%s%s%s" "$C_RED" "$sta" "$C_RESET" ;;
        *)               printf "%s%s%s" "$C_DIM" "$sta" "$C_RESET" ;;
    esac
}

echo
echo "${C_BOLD}=== Account budgets — ${NOW_PRETTY} ===${C_RESET}"
echo
printf "%-12s %-8s %-25s %-8s %-25s %s\n" "Account" "5h util" "5h reset" "wk util" "wk reset" "Status"
printf "%-12s %-8s %-25s %-8s %-25s %s\n" "----------" "------" "------------------------" "------" "------------------------" "----------------"

# Read NDJSON, sort by wk_util (nulls → end), render rows.
jq -s -r 'sort_by(if (.wk_util // -1) < 0 then 99 else .wk_util end) | .[] | @json' "$NDJSON" | while read -r line; do
    label=$(echo "$line" | jq -r '.label')
    err=$(echo "$line" | jq -r '.error // ""')
    if [ -n "$err" ] && [ "$err" != "null" ]; then
        cache_age=$(echo "$line" | jq -r '.cacheAgeSec // empty')
        stale=$(echo "$line" | jq -r '.stale // false')
        if [ "$stale" = "true" ]; then
            h5u=$(fmt_pct "$(echo "$line" | jq -r '.h5_util')")
            wku=$(fmt_pct "$(echo "$line" | jq -r '.wk_util')")
            h5r=$(fmt_reset "$(echo "$line" | jq -r '.h5_reset')")
            wkr=$(fmt_reset "$(echo "$line" | jq -r '.wk_reset')")
            sta=$(echo "$line" | jq -r '.status')
            stamark="${C_DIM}[stale ${cache_age}s] ${err}${C_RESET}"
            printf "%-12s %-8s %-25s %-8s %-25s %s\n" "$label" "$h5u" "$h5r" "$wku" "$wkr" "$stamark"
        else
            printf "%-12s %s%s%s\n" "$label" "$C_RED" "error: $err" "$C_RESET"
        fi
        continue
    fi
    h5u=$(fmt_pct "$(echo "$line" | jq -r '.h5_util')")
    wku=$(fmt_pct "$(echo "$line" | jq -r '.wk_util')")
    h5r=$(fmt_reset "$(echo "$line" | jq -r '.h5_reset')")
    wkr=$(fmt_reset "$(echo "$line" | jq -r '.wk_reset')")
    sta_raw=$(echo "$line" | jq -r '.status')
    sta=$(color_status "$sta_raw")
    src=$(echo "$line" | jq -r '.source // "live"')
    src_mark=""; [ "$src" = "cache" ] && src_mark=" ${C_DIM}[cache]${C_RESET}"
    printf "%-12s %-8s %-25s %-8s %-25s %s%s\n" "$label" "$h5u" "$h5r" "$wku" "$wkr" "$sta" "$src_mark"
done
echo
