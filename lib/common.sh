#!/usr/bin/env bash
# lib/common.sh — shared helpers used by every lib/*.sh.
# Sourced by bin/atmux and re-sourced indirectly by downstream libs.

# Colors (tty-only).
if [[ -t 1 ]]; then
  atmux_c_red=$'\e[31m'
  atmux_c_grn=$'\e[32m'
  atmux_c_yel=$'\e[33m'
  atmux_c_blu=$'\e[34m'
  atmux_c_mag=$'\e[35m'
  atmux_c_cyn=$'\e[36m'
  atmux_c_dim=$'\e[2m'
  atmux_c_bld=$'\e[1m'
  atmux_c_rst=$'\e[0m'
else
  atmux_c_red= atmux_c_grn= atmux_c_yel= atmux_c_blu= atmux_c_mag= atmux_c_cyn= atmux_c_dim= atmux_c_bld= atmux_c_rst=
fi

atmux::log()   { printf '%s🔹 atmux%s %s\n' "$atmux_c_cyn" "$atmux_c_rst" "$*" >&2; }
atmux::ok()    { printf '%s✅ atmux%s %s%s%s\n' "$atmux_c_cyn" "$atmux_c_rst" "$atmux_c_grn" "$*" "$atmux_c_rst" >&2; }
atmux::warn()  { printf '%s⚠️  atmux%s %s%s%s\n' "$atmux_c_cyn" "$atmux_c_rst" "$atmux_c_yel" "$*" "$atmux_c_rst" >&2; }
atmux::die()   { printf '%s💥 atmux%s %s%s%s\n' "$atmux_c_cyn" "$atmux_c_rst" "$atmux_c_red" "$*" "$atmux_c_rst" >&2; exit 1; }

atmux::version() { echo "0.1.0"; }

atmux::require() {
  for dep in "$@"; do
    command -v "$dep" >/dev/null 2>&1 || atmux::die "missing dependency: $dep"
  done
}

# ---------- paths ----------

# atmux state dir. Default: $PWD/.atmux. Override via $ATMUX_DIR.
atmux::dir() {
  if [[ -n "${ATMUX_DIR:-}" ]]; then
    printf '%s\n' "$ATMUX_DIR"
    return
  fi
  # Walk up looking for .atmux/
  local d="$PWD"
  while [[ "$d" != "/" ]]; do
    if [[ -d "$d/.atmux" ]]; then
      printf '%s/.atmux\n' "$d"
      return
    fi
    d="$(dirname "$d")"
  done
  printf '%s/.atmux\n' "$PWD"
}

atmux::team_json()     { printf '%s/team.json\n'     "$(atmux::dir)"; }
atmux::kanban_json()   { printf '%s/kanban.json\n'   "$(atmux::dir)"; }
atmux::inbox_dir()     { printf '%s/inboxes\n'       "$(atmux::dir)"; }
atmux::logs_dir()      { printf '%s/logs\n'          "$(atmux::dir)"; }
atmux::state_dir()     { printf '%s/state\n'         "$(atmux::dir)"; }
atmux::driver_inbox()  { printf '%s/driver-inbox.md\n' "$(atmux::dir)"; }

atmux::ensure_dirs() {
  local d; d="$(atmux::dir)"
  mkdir -p "$d/inboxes" "$d/logs" "$d/state" "$d/archive"
}

# ---------- team.json ----------

atmux::require_team() {
  local tj; tj="$(atmux::team_json)"
  [[ -f "$tj" ]] || atmux::die "no team.json at $tj — run 'atmux init' first"
  command -v jq >/dev/null 2>&1 || atmux::die "jq not installed"
  jq -e . "$tj" >/dev/null 2>&1 || atmux::die "team.json is not valid JSON: $tj"
}

atmux::team_name() {
  atmux::require_team
  jq -r '.name' "$(atmux::team_json)"
}

atmux::session_name() {
  local override="${ATMUX_SESSION:-}"
  if [[ -n "$override" ]]; then
    echo "$override"; return
  fi
  echo "atmux-$(atmux::team_name)"
}

atmux::window_name() {
  # window naming convention: __<team>__<member>
  local member="$1"
  printf '__%s__%s\n' "$(atmux::team_name)" "$member"
}

atmux::team_field() {
  # Usage: atmux::team_field '.members'
  atmux::require_team
  jq -r "$1" "$(atmux::team_json)"
}

atmux::members_names() {
  atmux::team_field '.members[].name'
}

atmux::member_json() {
  # Usage: atmux::member_json <name>
  local name="$1"
  atmux::require_team
  jq -e --arg n "$name" '.members[] | select(.name == $n)' "$(atmux::team_json)" \
    || atmux::die "no such member in team.json: $name"
}

# ---------- tmux helpers ----------

atmux::tmux_session_exists() {
  local s; s="$(atmux::session_name)"
  tmux has-session -t "$s" 2>/dev/null
}

atmux::tmux_window_exists() {
  local s; s="$(atmux::session_name)"
  local w; w="$(atmux::window_name "$1")"
  tmux list-windows -t "$s" -F '#{window_name}' 2>/dev/null | grep -qx "$w"
}

atmux::tmux_target() {
  # returns "<session>:<window>"
  printf '%s:%s\n' "$(atmux::session_name)" "$(atmux::window_name "$1")"
}

# Capture the pane state (last N lines) — always read BEFORE send.
atmux::capture_pane() {
  local member="$1"
  local lines="${2:-30}"
  local target; target="$(atmux::tmux_target "$member")"
  tmux capture-pane -p -S "-$lines" -t "$target" 2>/dev/null || true
}

# ---------- json write helpers ----------

# atomic write of jq edit to a JSON file
atmux::jq_update() {
  # Usage: atmux::jq_update <file> <jq-filter> [--arg k v ...]
  local file="$1"; shift
  local filter="$1"; shift
  local tmp; tmp="$(mktemp "${file}.XXXXXX")"
  if [[ -s "$file" ]]; then
    jq "$@" "$filter" "$file" >"$tmp"
  else
    jq -n "$@" "$filter" >"$tmp"
  fi
  mv "$tmp" "$file"
}

atmux::now_epoch() { date +%s; }
atmux::now_iso()   { date -u +%Y-%m-%dT%H:%M:%SZ; }
atmux::now_myt()   { TZ='Asia/Kuala_Lumpur' date +'%H:%M MYT'; }

# Generate short task id: t-<6 hex>
atmux::gen_id() {
  printf 't-%s\n' "$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
}
