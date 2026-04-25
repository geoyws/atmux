#!/usr/bin/env bash
# lib/common.sh — shared helpers used by every lib/*.sh.
# Sourced by bin/atmux and re-sourced indirectly by downstream libs.

# Colors (tty-only). Exported so sourced lib/*.sh see them.
if [[ -t 1 ]]; then
  atmux_c_red=$'\e[31m'
  atmux_c_grn=$'\e[32m'
  atmux_c_yel=$'\e[33m'
  atmux_c_cyn=$'\e[36m'
  atmux_c_dim=$'\e[2m'
  atmux_c_bld=$'\e[1m'
  atmux_c_rst=$'\e[0m'
else
  atmux_c_red=''; atmux_c_grn=''; atmux_c_yel=''; atmux_c_cyn=''
  atmux_c_dim=''; atmux_c_bld=''; atmux_c_rst=''
fi
export atmux_c_red atmux_c_grn atmux_c_yel atmux_c_cyn atmux_c_dim atmux_c_bld atmux_c_rst

atmux::log()   { printf '%s🔹 atmux%s %s\n' "$atmux_c_cyn" "$atmux_c_rst" "$*" >&2; }
atmux::ok()    { printf '%s✅ atmux%s %s%s%s\n' "$atmux_c_cyn" "$atmux_c_rst" "$atmux_c_grn" "$*" "$atmux_c_rst" >&2; }
atmux::warn()  { printf '%s⚠️  atmux%s %s%s%s\n' "$atmux_c_cyn" "$atmux_c_rst" "$atmux_c_yel" "$*" "$atmux_c_rst" >&2; }
atmux::die()   { printf '%s💥 atmux%s %s%s%s\n' "$atmux_c_cyn" "$atmux_c_rst" "$atmux_c_red" "$*" "$atmux_c_rst" >&2; exit 1; }

atmux::version() { echo "0.3.0"; }

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

# True if a team.json is resolvable from here.
atmux::has_team() {
  local d; d="$(atmux::dir)"
  [[ -f "$d/team.json" ]]
}

# First-run auto-wizard: if no team.json, we're on a TTY, and not suppressed,
# offer to run `atmux init --wizard` before the caller's verb proceeds.
# Exits the process after a successful wizard run (user re-runs their command).
# Returns 1 without prompting in non-interactive environments so callers can
# surface the normal "no team.json" error.
atmux::maybe_offer_wizard() {
  atmux::has_team && return 0            # team exists — nothing to do
  [[ -n "${ATMUX_NO_WIZARD:-}" ]] && return 1  # opt-out via env
  [[ -t 0 && -t 2 ]] || return 1         # non-interactive (cron, pipes) — fail normally

  printf '\n%s🧙 atmux%s  no team.json found in %s\n' \
    "$atmux_c_cyn" "$atmux_c_rst" "$PWD" >&2
  printf '%satmux%s  this looks like a first run — set up a team now? %s[Y/n]%s: ' \
    "$atmux_c_cyn" "$atmux_c_rst" "$atmux_c_dim" "$atmux_c_rst" >&2

  local ans
  IFS= read -r ans || ans=""
  case "$ans" in
    ""|y|Y|yes|YES)
      exec "$ATMUX_BIN_DIR/atmux" init --wizard
      ;;
    *)
      printf '%satmux%s  ok — run %satmux init --wizard%s (or %satmux init%s for defaults) when ready\n' \
        "$atmux_c_cyn" "$atmux_c_rst" "$atmux_c_bld" "$atmux_c_rst" "$atmux_c_bld" "$atmux_c_rst" >&2
      return 1
      ;;
  esac
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
  # window naming convention: __<team>__<emoji><member> if member has an .emoji
  # stamped in team.json, else __<team>__<member>. The emoji is stamped at
  # wizard / add-member time and stable thereafter.
  local member="$1"
  local team; team="$(atmux::team_name)"
  local tj; tj="$(atmux::team_json)"
  local emoji=""
  if [[ -f "$tj" ]]; then
    emoji="$(jq -r --arg n "$member" '.members[] | select(.name == $n) | .emoji // ""' "$tj" 2>/dev/null)"
    [[ "$emoji" == "null" ]] && emoji=""
  fi
  if [[ -n "$emoji" ]]; then
    printf '__%s__%s%s\n' "$team" "$emoji" "$member"
  else
    printf '__%s__%s\n' "$team" "$member"
  fi
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

# Atomic jq-driven update of a JSON file, under an flock so concurrent
# dispatch / claim calls can't lose data.
# Usage: atmux::jq_update <file> <jq-filter> [jq args...]
atmux::jq_update() {
  local file="$1"; shift
  local filter="$1"; shift
  local dir; dir="$(dirname "$file")"
  mkdir -p "$dir"
  local lockfd
  exec {lockfd}>"${file}.lock"
  flock "$lockfd"
  local tmp; tmp="$(mktemp "${file}.XXXXXX")"
  if [[ -s "$file" ]]; then
    jq "$@" "$filter" "$file" >"$tmp"
  else
    jq -n "$@" "$filter" >"$tmp"
  fi
  mv "$tmp" "$file"
  exec {lockfd}>&-
}

# Run a command with an flock on the given file. Ensures only one writer
# mutates the target at a time across all atmux processes.
# Usage: atmux::with_lock <file> <command...>
atmux::with_lock() {
  local file="$1"; shift
  mkdir -p "$(dirname "$file")"
  local lockfd
  exec {lockfd}>"${file}.lock"
  flock "$lockfd"
  "$@"
  local rc=$?
  exec {lockfd}>&-
  return "$rc"
}

atmux::now_epoch() { date +%s; }
atmux::now_iso()   { date -u +%Y-%m-%dT%H:%M:%SZ; }
atmux::now_myt()   { TZ='Asia/Kuala_Lumpur' date +'%H:%M MYT'; }

# Generate short task id: t-<6 hex>
atmux::gen_id() {
  printf 't-%s\n' "$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
}
