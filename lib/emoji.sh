#!/usr/bin/env bash
# lib/emoji.sh — curated emoji pools + mode-aware assignment.
#
# Each member in team.json carries an optional `.emoji` field, stamped once at
# wizard / add-member time. Downstream display (status, whip, report, tmux
# window names) prefix the member name with it.
#
# Assignment mode — ATMUX_EMOJI_MODE env var > team.json .emojis.mode > default:
#   static  → canonical per-role emoji, deterministic (the first of each pool).
#   random  → random pick from the role's pool. No LLM, just variety.         [DEFAULT]
#   ai      → claude -p picks based on name+role. Falls back to `random` on
#             any failure (missing claude, rate limit, empty response, etc.).

# ---------- pools (per role) ----------
# First entry in each pool is the canonical "static" pick. The rest add variety
# for `random` mode. Keep them visually distinct + office-safe.

atmux::emoji_pool() {
  case "$1" in
    driver)        echo "🎮 🎬 🎤 🕹️ 🎯" ;;
    team-lead)     echo "🧭 🪄 🎼 👷 🗺️" ;;
    planner)       echo "🗺️ 🧠 🧩 📐 🎯" ;;
    reviewer)      echo "🔍 🕵️ 📐 🧪 👓" ;;
    gitter)        echo "🌿 📝 🗃️ 🪢 🧵" ;;
    devops)        echo "⚙️ 🛠️ 🔧 🧰 📦" ;;
    dba)           echo "🗄️ 💾 🐘 🧮 📊" ;;
    unblocker)     echo "🔓 🪛 🧯 🧲 ⚡" ;;
    member|*)      echo "🐝 🦊 🦉 🐢 🦀 🐙 🦜 🐿️ 🦩 🦥 🐺 🦦 🦝 🦙 🦔 🦄 🐉 🦋 🐞 🦒 🐧 🦘 🦡 🦨 🦚 🌱 🌵 🌷 🌸 🌹 🌻 🌺 🍄 🍕 🍔 🍣 🍜 🍪 🍩 🧁 🍰 🍓 🥑 🌮 🥐 ☀️ 🌙 ⭐ ⚡ ❄️ 🔥 🌈 ☄️ 🪐 🎈 🎁 💎 🔮 🚀 🛸 🪁 🎏 🎨 🎭 🎤 🎧 🎮 🎲 🎯 🪀 ⚓ 🎩 🎀 🥁 🎷 🎸 🎺 🎻 🪄 🛼 🏹" ;;
  esac
}

# Default (static mode) picks — always the first entry of the pool.
atmux::emoji_default_for_role() {
  local role="$1"
  local pool; pool="$(atmux::emoji_pool "$role")"
  # shellcheck disable=SC2086
  set -- $pool
  printf '%s' "$1"
}

# ---------- mode resolution ----------

# Usage: atmux::emoji_mode
# Resolves: ATMUX_EMOJI_MODE > team.json .emojis.mode > "random"
atmux::emoji_mode() {
  if [[ -n "${ATMUX_EMOJI_MODE:-}" ]]; then
    printf '%s' "$ATMUX_EMOJI_MODE"
    return
  fi
  local tj; tj="$(atmux::team_json 2>/dev/null)"
  if [[ -f "$tj" ]]; then
    local m; m="$(jq -r '.emojis.mode // ""' "$tj" 2>/dev/null)"
    if [[ -n "$m" && "$m" != "null" ]]; then
      printf '%s' "$m"
      return
    fi
  fi
  printf 'random'
}

# ---------- assignment ----------

# atmux::emoji_pick_random <role> [<seen-emojis-space-separated>]
# Random pick from the role's pool, preferring emojis not in the "seen" list
# so a team gets variety.
atmux::emoji_pick_random() {
  local role="$1" seen="${2:-}"
  local pool; pool="$(atmux::emoji_pool "$role")"
  # shellcheck disable=SC2086
  set -- $pool
  local candidates=() e
  for e in "$@"; do
    if [[ -z "$seen" ]] || ! grep -qF " $e " <<<" $seen "; then
      candidates+=("$e")
    fi
  done
  # If all emojis in the pool are already seen, fall back to the full pool.
  if [[ ${#candidates[@]} -eq 0 ]]; then
    candidates=("$@")
  fi
  local n=${#candidates[@]}
  local idx=$(( RANDOM % n ))
  printf '%s' "${candidates[$idx]}"
}

# atmux::emoji_pick_ai <name> <role> [<seen-emojis>]
# Ask claude for a single emoji. Fall back to random on any failure.
atmux::emoji_pick_ai() {
  local name="$1" role="$2" seen="${3:-}"
  if ! command -v claude >/dev/null 2>&1; then
    atmux::emoji_pick_random "$role" "$seen"
    return
  fi
  local prompt
  prompt="Pick ONE single emoji glyph (no text, no explanation) that best represents a team member whose role is '$role' and whose name is '$name'. Reply with only the emoji — nothing else, no quotes, no surrounding whitespace."
  local raw
  raw="$(timeout 20s claude -p --permission-mode dontAsk "$prompt" 2>/dev/null | tr -d '[:space:]"' || true)"
  # Validate: non-empty and looks emoji-ish (first char is outside ASCII).
  if [[ -z "$raw" ]] || [[ "${raw:0:1}" =~ [[:ascii:]] ]]; then
    atmux::emoji_pick_random "$role" "$seen"
    return
  fi
  printf '%s' "$raw"
}

# atmux::emoji_assign <name> <role> [<seen-emojis>]
# The public entry point. Resolves the current mode and dispatches.
atmux::emoji_assign() {
  local name="$1" role="$2" seen="${3:-}"
  local mode; mode="$(atmux::emoji_mode)"
  case "$mode" in
    static) atmux::emoji_default_for_role "$role" ;;
    ai)     atmux::emoji_pick_ai "$name" "$role" "$seen" ;;
    random|*) atmux::emoji_pick_random "$role" "$seen" ;;
  esac
}

# ---------- display helpers ----------

# atmux::member_emoji <name>
# Reads the .emoji field for a member from team.json. Empty string if unset
# or if team.json is missing.
atmux::member_emoji() {
  local name="$1"
  local tj; tj="$(atmux::team_json 2>/dev/null)"
  [[ -f "$tj" ]] || { printf ''; return; }
  jq -r --arg n "$name" '.members[] | select(.name == $n) | .emoji // ""' "$tj" 2>/dev/null | head -1
}

# atmux::member_display <name>
# Returns "<emoji> <name>" if an emoji is stamped, else just "<name>".
# Use this everywhere a member is shown to the user.
atmux::member_display() {
  local name="$1"
  local e; e="$(atmux::member_emoji "$name")"
  if [[ -n "$e" ]]; then
    printf '%s %s' "$e" "$name"
  else
    printf '%s' "$name"
  fi
}

# ---------- ADR-030: spawn-time emoji resolution ----------
#
# atmux::resolve_member_emoji <team> <member> [<role>]
#
# Single entry point for "what emoji should this member display, NOW".
# Implements the ADR-030 §Decision lookup priority chain:
#
#   1. Registry (~/.claude/teams/registry.json :: members[].emoji) —
#      durable, immutable-once-written. Hits return verbatim.
#   2. team.json (.members[name=$member].emoji) — cold-start seed.
#      On hit, write through to registry so subsequent spawns hit step 1.
#   3. Random fallback via atmux::emoji_assign — mode-aware (random / static
#      / ai). Persists to registry with the same write-through.
#
# The persist-back step is the load-bearing one: it converts the first-spawn
# random pick into a durable assignment that survives every future restart.
# atmux::registry_set_emoji is strict-immutable (silent no-op when already
# set), so the chain is race-safe across concurrent spawn paths.
#
# <role> is optional — when omitted, it's read from team.json. Pass it
# explicitly from add-member, where the member doesn't yet exist in
# team.json at the time of resolution.
#
# Echoes the resolved emoji on stdout. Empty stdout only if every step
# turns up empty — pathological in practice.
atmux::resolve_member_emoji() {
  local team="${1:-}"
  local member="${2:-}"
  local role="${3:-}"
  [[ -n "$team"   ]] || atmux::die "resolve_member_emoji: <team> required"
  [[ -n "$member" ]] || atmux::die "resolve_member_emoji: <member> required"

  # Lazy-source registry helpers. Keeps emoji.sh usable in environments where
  # registry.sh hasn't shipped yet (degraded fallback to old emoji_assign
  # behavior — no immutability, but no breakage either).
  if [[ -f "${ATMUX_LIB_DIR:-}/registry.sh" ]] \
     && ! declare -f atmux::registry_get_emoji >/dev/null 2>&1; then
    # shellcheck source=registry.sh
    . "$ATMUX_LIB_DIR/registry.sh"
  fi

  # Step 1: registry hit — return verbatim, no write needed.
  if declare -f atmux::registry_get_emoji >/dev/null 2>&1; then
    local from_reg
    from_reg="$(atmux::registry_get_emoji "$team" "$member" 2>/dev/null || true)"
    if [[ -n "$from_reg" && "$from_reg" != "null" ]]; then
      printf '%s' "$from_reg"
      return 0
    fi
  fi

  # Step 2: team.json seed — write through to registry, return.
  local from_tj=""
  from_tj="$(atmux::member_emoji "$member" 2>/dev/null || true)"
  if [[ -n "$from_tj" && "$from_tj" != "null" ]]; then
    if declare -f atmux::registry_set_emoji >/dev/null 2>&1; then
      atmux::registry_set_emoji "$team" "$member" "$from_tj" >/dev/null 2>&1 || true
    fi
    printf '%s' "$from_tj"
    return 0
  fi

  # Step 3: random fallback via mode-aware atmux::emoji_assign.
  # Resolve the role from team.json if the caller didn't pass one.
  if [[ -z "$role" ]]; then
    local mj; mj="$(atmux::member_json "$member" 2>/dev/null || printf '{}')"
    role="$(jq -r '.role // "member"' <<<"$mj" 2>/dev/null)"
    [[ -z "$role" || "$role" == "null" ]] && role="member"
  fi

  # Build a "seen" list across team.json + the registry's known members for
  # this team so the random pick favors variety.
  local seen=""
  local tj; tj="$(atmux::team_json 2>/dev/null)"
  if [[ -f "$tj" ]]; then
    seen="$(jq -r '[.members[].emoji // ""] | map(select(. != "")) | join(" ")' "$tj" 2>/dev/null)"
  fi
  if declare -f atmux::registry_path >/dev/null 2>&1; then
    local _r; _r="$(atmux::registry_path)"
    if [[ -s "$_r" ]]; then
      local _from_reg
      _from_reg="$(jq -r --arg t "$team" '
        [ .[]? | select(.name == $t) | (.members // [])[]? | .emoji // "" ]
        | map(select(. != ""))
        | join(" ")
      ' "$_r" 2>/dev/null)"
      [[ -n "$_from_reg" ]] && seen="${seen} ${_from_reg}"
    fi
  fi

  local picked
  picked="$(atmux::emoji_assign "$member" "$role" "$seen")"
  if [[ -n "$picked" ]] && declare -f atmux::registry_set_emoji >/dev/null 2>&1; then
    atmux::registry_set_emoji "$team" "$member" "$picked" >/dev/null 2>&1 || true
  fi
  printf '%s' "$picked"
}
