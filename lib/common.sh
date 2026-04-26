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

# atmux state dir. Resolution order:
#   1. $ATMUX_DIR              — explicit `.atmux/` path (most specific)
#   2. $ATMUX_TEAM_DIR/.atmux  — project root override (cron-friendly)
#   3. walk up from $PWD looking for `.atmux/`
#   4. $PWD/.atmux             — last-resort fallback (may not exist)
#
# ATMUX_TEAM_DIR + the bin/atmux `--team-dir` flag exist so cron jobs and
# subdirectory invocations can pin atmux at a known project root without
# relying on cwd: `*/5 * * * * ATMUX_TEAM_DIR=/path/to/repo atmux whip`
# or `atmux --team-dir /path/to/repo whip`. Without this, cron's $HOME-rooted
# cwd makes verbs that depend on team.json silently fail.
atmux::dir() {
  if [[ -n "${ATMUX_DIR:-}" ]]; then
    printf '%s\n' "$ATMUX_DIR"
    return
  fi
  if [[ -n "${ATMUX_TEAM_DIR:-}" ]]; then
    printf '%s/.atmux\n' "${ATMUX_TEAM_DIR%/}"
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

# atmux::team_json_backup
#
# Capture a timestamped copy of the existing team.json before a
# subsequent write touches it. Called by every code path that mutates
# team.json (init --force, add-member, reconfigure, reload, …) so a
# botched write — wrong cwd, runaway test fixture, broken jq filter,
# unintended `--force` — leaves a recoverable `team.json.bak.<epoch>`
# behind. Echoes the backup path on success; silent no-op when
# team.json doesn't exist (first-ever init has nothing to back up).
#
# Errors are non-fatal: refusing the write because cp failed would
# wedge legitimate flows in low-disk / read-only edge cases. Backups
# are best-effort safety net, not a precondition.
#
# Per t-2f13a2e4 (2026-04-25 production incident): a test fixture
# overwrote a live team.json without sandboxing; recovery required
# rebuilding from observed reality. This helper makes that recovery
# automatic next time.
atmux::team_json_backup() {
  local tj; tj="$(atmux::team_json)"
  [[ -f "$tj" ]] || return 0
  local bak="${tj}.bak.$(atmux::now_epoch)"
  cp -p "$tj" "$bak" 2>/dev/null || return 0
  printf '%s\n' "$bak"
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

# Resolve the team-lead member's name from team.json. Empty stdout when no
# member has role=="team-lead" (Solo Mode / single-member teams).
atmux::find_lead_member() {
  jq -r 'first(.members[] | select(.role == "team-lead") | .name) // empty' \
     "$(atmux::team_json)"
}

# atmux::brief_version <role>
#
# Read the brief-version marker from the first line of
# templates/briefs/<role>.md (`<!-- brief-version: vN -->`). Echoes the
# captured version. Falls back to `v0` when:
#   - the brief file is missing
#   - the marker line is absent
#   - the marker doesn't match the expected shape
#
# `v0` is reserved for legacy briefs predating the marker convention so
# downstream consumers (lib/start.sh's spawn-time recorder, the brief-
# version delta check in whip) can treat all members uniformly.
atmux::brief_version() {
  local role="$1"
  local brief_path; brief_path="$(atmux::brief_path "$role")"
  [[ -f "$brief_path" ]] || { printf 'v0\n'; return 0; }
  local first; first="$(head -1 "$brief_path" 2>/dev/null || true)"
  if [[ "$first" =~ ^\<!--[[:space:]]*brief-version:[[:space:]]*(v[0-9]+)[[:space:]]*--\>$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  else
    printf 'v0\n'
  fi
}

# atmux::record_brief_version <member> <role>
#
# Stamp the just-pasted brief's version + epoch into
# .atmux/state/brief-versions.json. Called by lib/start.sh (initial paste),
# lib/rotate.sh (post-/clear re-paste), and lib/reload.sh (brief-reload
# subcommand) so whip's brief-version delta check (T3.4) can compare
# currently-pasted vs on-disk versions across all three paste paths.
atmux::record_brief_version() {
  local member="$1" role="$2"
  local version; version="$(atmux::brief_version "$role")"
  local now; now="$(atmux::now_epoch)"
  local f; f="$(atmux::state_dir)/brief-versions.json"
  mkdir -p "$(dirname "$f")"
  [[ -s "$f" ]] || echo '{}' > "$f"
  atmux::jq_update "$f" \
    '. + { ($m): { role: $r, version: $v, pastedAt: ($t | tonumber) } }' \
    --arg m "$member" --arg r "$role" --arg v "$version" --arg t "$now"
}

# atmux::task_append_note <task_id> <line>
#
# Append a single line to the task's `.note` field, newline-separated.
# Idempotent: if the line is already present in `.note`, the call is a
# no-op. Errors when the task id doesn't exist. Lives here (not in
# lib/kanban.sh) so cross-module callers — currently lib/flags.sh's
# --task linkage — can reach it without sourcing kanban.sh's main().
atmux::task_append_note() {
  local id="$1" line="$2"
  [[ -n "$id"   ]] || atmux::die "task_append_note: <id> required"
  [[ -n "$line" ]] || atmux::die "task_append_note: <line> required"
  local k; k="$(atmux::kanban_json)"
  local exists
  exists="$(jq --arg id "$id" '[.tasks[]? | select(.id == $id)] | length' "$k")"
  (( exists == 1 )) || atmux::die "task_append_note: no such task: $id"
  atmux::jq_update "$k" \
    '.tasks |= map(
       if .id == $id then
         if (.note // "") == "" then
           .note = $line
         elif ((.note | split("\n")) | index($line)) then
           .
         else
           .note = (.note + "\n" + $line)
         end
       else . end
     )' \
    --arg id "$id" --arg line "$line"
}

# atmux::find_phantom_inbox_ids
#
# Pure introspection — scans every `<member>.json` in .atmux/inboxes/ and
# returns a JSON array of `{member, id, subject}` objects for inProgress
# entries whose `id` is NOT present in `kanban.tasks[]`. These "phantom"
# entries arise when a concurrent bare `jq … | mv` writer clobbers a
# parallel `atmux::jq_update` write — the inbox keeps a claim whose
# kanban-side task was rolled back. Helper is the safety-net detector;
# whip's auto-prune sweep + doctor's diagnostic both consume this output.
#
# No side effects: read-only on inboxes/ + kanban.json. Echoes `[]` when
# kanban.json is absent or no inbox files exist (cold-start / fresh-init
# edge cases) so callers can branch on `length == 0` uniformly.
atmux::find_phantom_inbox_ids() {
  local k; k="$(atmux::kanban_json)"
  local idir; idir="$(atmux::inbox_dir)"
  [[ -f "$k" && -d "$idir" ]] || { printf '[]\n'; return 0; }

  # Build the canonical task-id set once so per-inbox jq calls don't
  # re-read kanban.json. `[.tasks[]?.id]` tolerates a kanban with no
  # tasks key (legacy shape pre-S1) — `?` swallows the type-error.
  local task_ids_json
  task_ids_json="$(jq -c '[.tasks[]?.id]' "$k" 2>/dev/null || echo '[]')"

  local out='[]' inbox member entries
  for inbox in "$idir"/*.json; do
    [[ -f "$inbox" ]] || continue
    member="$(basename "$inbox" .json)"
    # Bind the entry to `$e` before the kanban-membership test — without
    # the binding, `$kanban | index(.id)` pipes the array into `index(...)`
    # and `.id` resolves against the array itself (jq error: "Cannot index
    # array with string"). The `as $e` capture pins the entry context.
    entries="$(jq -c --argjson kanban "$task_ids_json" --arg m "$member" \
      '[.inProgress[]?
        | . as $e
        | select($kanban | index($e.id) | not)
        | {member: $m, id: $e.id, subject: ($e.subject // "")}]' \
      "$inbox" 2>/dev/null || echo '[]')"
    out="$(jq -c --argjson new "$entries" '. + $new' <<<"$out")"
  done
  printf '%s\n' "$out"
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

# ---------- brief rendering ----------

# Read a brief template + substitute {{TEAM}}/{{MEMBER}}/{{ROLE}}/{{ATMUX_DIR}}.
# Echoes the rendered content on stdout. Used by lib/start.sh (initial paste),
# lib/rotate.sh (post-/clear repaste), and lib/reload.sh (mid-session reload).
# Caller owns paste mechanics + tmpfile management.
atmux::render_brief() {
  local member="$1" role="$2" brief_path="$3"
  [[ -f "$brief_path" ]] || return 1
  local team; team="$(atmux::team_name)"
  sed \
    -e "s|{{TEAM}}|$team|g" \
    -e "s|{{MEMBER}}|$member|g" \
    -e "s|{{ROLE}}|$role|g" \
    -e "s|{{ATMUX_DIR}}|$(atmux::dir)|g" \
    "$brief_path"
}

# ---------- kanban schema ----------

# Idempotently ensure kanban.json has the expected top-level shape:
#   {"tasks":[], "epics":[], "stories":[]}
# Auto-creates the file if missing. Safe to call before any mutation; uses
# `//=` so existing keys keep their data. Legacy kanbans that only have
# `tasks` get `epics` and `stories` added on first call.
atmux::kanban_normalize() {
  local k; k="$(atmux::kanban_json)"
  [[ -f "$k" ]] || echo '{"tasks":[],"epics":[],"stories":[]}' > "$k"
  atmux::jq_update "$k" '.tasks //= [] | .epics //= [] | .stories //= []'
}

# ---------- member lane ----------

# Infer a team-member's lane from its name + role.
# Lanes (lowercase in JSON, UPPER-CASE only in display): fe / be / db / ops /
# test / review / misc. Role overrides win when the name has no lane prefix:
#   reviewer → review · devops → ops · dba → db · team-lead/planner/gitter → misc.
# Otherwise a name like "<lane>-<rest>" (e.g. fe-kanban, be-foo, db-bar) yields
# the prefix; anything else falls back to "misc".
atmux::lane_for_name() {
  local name="${1:-}"
  local role="${2:-member}"
  local prefix="${name%%-*}"
  case "$prefix" in
    fe|be|db|ops|test|review|misc)
      printf '%s\n' "$prefix"
      return ;;
  esac
  case "$role" in
    reviewer)               printf 'review\n' ;;
    devops)                 printf 'ops\n' ;;
    dba)                    printf 'db\n' ;;
    team-lead|planner|gitter|*) printf 'misc\n' ;;
  esac
}

# Render a lane in display form (UPPER-CASE). JSON values stay lowercase;
# call this only at the rendering boundary.
atmux::lane_display() {
  local lane="${1:-misc}"
  [[ -z "$lane" || "$lane" == "null" ]] && lane="misc"
  printf '%s\n' "$lane" | tr '[:lower:]' '[:upper:]'
}
