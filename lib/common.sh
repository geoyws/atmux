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

# atmux::kanban_json_backup
#
# Snapshot kanban.json to '<path>.bak.<epoch>' before risky multi-step
# writes (E6/S2 t-48874db7 / F2-extension). Pairs with F12's post-write
# JSON sanity probe in atmux::jq_update — sanity catches corruption
# immediately, this backup makes recovery painless. Same shape as
# atmux::team_json_backup so the existing recovery muscle generalises.
#
# Errors are non-fatal: refusing the write because cp failed would wedge
# legitimate flows in low-disk / read-only edge cases. Echoes the backup
# path on success; silent no-op when kanban.json doesn't exist (cold-
# start before any task add). Cleanup of stale .bak files is out of
# scope here (followup task can sweep .bak.<old-epoch> > 7d).
atmux::kanban_json_backup() {
  local kj; kj="$(atmux::kanban_json)"
  [[ -f "$kj" ]] || return 0
  local bak="${kj}.bak.$(atmux::now_epoch)"
  cp -p "$kj" "$bak" 2>/dev/null || return 0
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

  # Single-session mode (E7/Sa t-8b801474): atmux start writes the
  # captured driver-tmux session name to .atmux/state/session.txt. When
  # that state file is present, EVERY atmux verb resolves the same
  # session name without needing to re-detect $TMUX. Tooling running
  # outside the driver tmux (cron, --team-dir invocations, scripts)
  # picks up the session via the file, not the env. The flag-set-but-
  # state-missing case is fatal-by-design — silently falling through
  # to "atmux-<team>" would leak two divergent session names across the
  # same team's processes.
  local stored; stored="$(atmux::dir)/state/session.txt"
  if [[ -f "$stored" ]]; then
    cat "$stored"
    return
  fi

  local single
  single="$(jq -r '.singleSession // false' "$(atmux::team_json)" 2>/dev/null || echo false)"
  if [[ "$single" == "true" || -n "${ATMUX_DRIVER_SESSION:-}" ]]; then
    atmux::die "single-session enabled but no .atmux/state/session.txt — run 'atmux start' to seed it"
  fi

  echo "atmux-$(atmux::team_name)"
}

atmux::window_name() {
  # window naming convention: __<team>__<emoji><member> if a stable emoji can be
  # resolved for the member, else __<team>__<member>. ADR-030 changed the
  # source-of-truth ordering: registry first (durable, immutable), team.json
  # second (cold-start seed). The random-fallback step lives in
  # atmux::resolve_member_emoji and is invoked at spawn time only — this
  # read-only resolver never picks new emojis itself.
  local member="$1"
  local team; team="$(atmux::team_name)"
  local emoji=""

  # Step 1: registry. Lazy-source so common.sh remains usable even when
  # registry.sh is genuinely absent (older atmux installs / test sandboxes).
  if [[ -f "${ATMUX_LIB_DIR:-}/registry.sh" ]] \
     && ! declare -f atmux::registry_get_emoji >/dev/null 2>&1; then
    # shellcheck source=registry.sh
    . "$ATMUX_LIB_DIR/registry.sh"
  fi
  if declare -f atmux::registry_get_emoji >/dev/null 2>&1; then
    emoji="$(atmux::registry_get_emoji "$team" "$member" 2>/dev/null || true)"
  fi

  # Step 2: team.json fallback when registry has nothing yet (pre-spawn,
  # cold-start cases).
  if [[ -z "$emoji" || "$emoji" == "null" ]]; then
    local tj; tj="$(atmux::team_json 2>/dev/null)"
    if [[ -f "$tj" ]]; then
      emoji="$(jq -r --arg n "$member" '.members[] | select(.name == $n) | .emoji // ""' "$tj" 2>/dev/null)"
      [[ "$emoji" == "null" ]] && emoji=""
    fi
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

# atmux::resolve_caller_scope
#
# Returns "driver" or "member" on stdout. Default is "member" (fail-secure
# — only an explicit driver-shaped caller gets the "driver" verdict, since
# member panes outnumber driver panes and the driverOnly gate is the
# load-bearing protection per ADR-033).
#
# Resolution order:
#   1. Defense-in-depth window-name check FIRST. Inside tmux, if the
#      current window's name matches the spawn convention `__<team>__*`
#      (the prefix every member pane carries per ADR-030), force scope=
#      "member" regardless of any env var. Members can `export
#      ATMUX_CALLER_SCOPE=driver` from inside their REPL — this kills
#      that bypass before the env-read.
#   2. If we've cleared the window-name check, read the env. Tmux
#      session env (set by `tmux set-environment`) takes precedence over
#      process env, so the driver pane's bootstrap can stamp scope on
#      the session and have it survive shell respawns.
#   3. If env says exactly "driver", return "driver". Anything else
#      (unset, "member", garbage) → "member".
#
# Interim env-gate per ADR-033 §Caller scope detection. Will be replaced
# by the canonical `atmux::resolve_caller_scope` per ADR-029 once E10/Si
# lands; this is the placeholder shape so callers can wire up now.
atmux::resolve_caller_scope() {
  if [[ -n "${TMUX:-}" ]] && command -v tmux >/dev/null 2>&1; then
    local win
    win="$(tmux display-message -p '#{window_name}' 2>/dev/null || true)"
    if [[ "$win" =~ ^__[a-z0-9_-]+__ ]]; then
      printf 'member\n'
      return 0
    fi
  fi

  local env_scope=""
  if [[ -n "${TMUX:-}" ]] && command -v tmux >/dev/null 2>&1; then
    env_scope="$(tmux show-environment ATMUX_CALLER_SCOPE 2>/dev/null \
                  | sed -n 's/^ATMUX_CALLER_SCOPE=//p' || true)"
  fi
  if [[ -z "$env_scope" ]]; then
    env_scope="${ATMUX_CALLER_SCOPE:-}"
  fi

  if [[ "$env_scope" == "driver" ]]; then
    printf 'driver\n'
  else
    printf 'member\n'
  fi
}

# atmux::is_driver_only_blocked <task-id>
#
# Returns 0 (success — "yes, blocked, refuse the action") when:
#   - the Task exists in kanban.json
#   - its `.driverOnly` field is `true` (default `false` via `// false`)
#   - the caller's resolved scope is not `driver`
#
# Returns non-zero (1) in every other case — including the Task not
# existing or the kanban being unreadable. Fail-open at the
# infrastructure layer: missing field / missing kanban shouldn't break
# every claim/move; only the explicit `driverOnly:true` plus non-driver
# scope triggers the refuse.
#
# Callers (lib/claim.sh selection loop + explicit-id form, lib/kanban.sh
# task move) wrap this in their refuse logic per ADR-033 §Refuse-gate
# sites.
atmux::is_driver_only_blocked() {
  local task_id="$1"
  [[ -n "$task_id" ]] || return 1

  local k; k="$(atmux::kanban_json 2>/dev/null)" || return 1
  [[ -f "$k" ]] || return 1

  local driver_only
  driver_only="$(jq -r --arg id "$task_id" \
                   '.tasks[]? | select(.id == $id) | .driverOnly // false' \
                   "$k" 2>/dev/null)"
  [[ "$driver_only" == "true" ]] || return 1

  local scope; scope="$(atmux::resolve_caller_scope)"
  [[ "$scope" != "driver" ]]
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
  # E6/S5 t-7ae355e9 (A11) — propagate jq existence-probe failure.
  # If jq parses the filter but the read fails (corrupt kanban), the
  # exit code surfaces here rather than coercing to 0 via command
  # substitution alone.
  local exists
  if ! exists="$(jq --arg id "$id" '[.tasks[]? | select(.id == $id)] | length' "$k" 2>/dev/null)"; then
    atmux::warn "task_append_note: jq failed reading $k"
    return 1
  fi
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
# atmux::inbox_push_guard <ib_path>
#
# Cheap insurance against runaway dispatch: returns 1 (refuse) when the
# inbox's `.inProgress[]` length is at or above $ATMUX_INBOX_CAP (default
# 20), otherwise 0 (allow). Caller decides what to do on refusal —
# typically `atmux::inbox_cap_warn <member>` + skip the push. Pure
# read-only; the kanban-side mint should land regardless so the task
# isn't lost, only the inbox copy is denied. Missing inbox file ⇒ allow
# (length 0). E6/S2 t-a27f217b.
atmux::inbox_push_guard() {
  local ib="$1"
  local cap="${ATMUX_INBOX_CAP:-20}"
  [[ "$cap" =~ ^[0-9]+$ ]] || cap=20
  [[ -f "$ib" ]] || return 0
  local n
  n="$(jq -r '(.inProgress // []) | length' "$ib" 2>/dev/null || echo 0)"
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  (( n < cap ))
}

# atmux::inbox_cap_warn <member>
#
# Companion to inbox_push_guard. Emits atmux::warn unconditionally + a
# ledger-rate-limited Discord notice (.atmux/state/inbox-cap-warned.json
# `{member: lastWarnEpoch}`, 1h suppression window). The Discord call is
# guarded on `declare -F atmux::discord_ping` so common.sh stays free of
# a hard dep on lib/discord.sh — callers that already source discord.sh
# (whip, kanban, dispatch, decisions, flags) get the ping; cold-path
# callers fall back to atmux::warn alone.
atmux::inbox_cap_warn() {
  local member="$1"
  local cap="${ATMUX_INBOX_CAP:-20}"
  [[ "$cap" =~ ^[0-9]+$ ]] || cap=20

  atmux::warn "inbox full: $member (cap=$cap, push refused)"

  local ledger; ledger="$(atmux::state_dir)/inbox-cap-warned.json"
  mkdir -p "$(dirname "$ledger")"
  [[ -s "$ledger" ]] || echo '{}' > "$ledger"

  local now; now="$(atmux::now_epoch)"
  local last
  last="$(jq -r --arg m "$member" '.[$m] // 0' "$ledger" 2>/dev/null || echo 0)"
  [[ "$last" =~ ^[0-9]+$ ]] || last=0

  if (( now - last < 3600 )); then
    return 0
  fi

  if [[ -z "${ATMUX_DISCORD_WEBHOOK:-}" ]]; then
    local hook
    hook="$(jq -r '.discord.webhook // empty' "$(atmux::team_json)" 2>/dev/null || true)"
    if [[ -n "$hook" && "$hook" != "null" ]]; then
      export ATMUX_DISCORD_WEBHOOK="$hook"
    fi
  fi

  if declare -F atmux::discord_ping >/dev/null 2>&1 \
     && [[ -n "${ATMUX_DISCORD_WEBHOOK:-}" ]]; then
    local team; team="$(atmux::team_name 2>/dev/null || echo unknown)"
    local ts; ts="$(atmux::now_myt)"
    local body="⚠️ **[atmux-inbox-cap]** · \`$team\` · $ts"
    body+=$'\n\n'"- 📥 \`$member\` inbox at cap ($cap) — pushes refused"
    body+=$'\n'"- 📍 inspect: \`atmux inbox $member\`"
    atmux::discord_ping "$body" >/dev/null 2>&1 || true
  fi

  atmux::jq_update "$ledger" \
    '. + {($m): ($t | tonumber)}' \
    --arg m "$member" --arg t "$now"
}

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
  # `=` prefix on target = exact-match (per tmux(1) §SESSIONS, "Names").
  # Bare `-t $s` is prefix-match: 'atmux-k' would falsely succeed
  # against 'atmux-kanban'. SEC sweep t-0dbfe104.
  tmux has-session -t "=$s" 2>/dev/null
}

atmux::tmux_window_exists() {
  local s; s="$(atmux::session_name)"
  local w; w="$(atmux::window_name "$1")"
  # Same prefix-match flaw applies to list-windows' session arg.
  tmux list-windows -t "=$s" -F '#{window_name}' 2>/dev/null | grep -qx "$w"
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
  # E6/S5 t-7ae355e9 (A11) — propagate jq parse / runtime failures.
  # Pre-A11: a malformed filter wrote an empty/partial $tmp then `mv`'d
  # over the live JSON, silently corrupting shared state. Now the jq
  # rc is checked; on failure, drop the lock, scrub the temp, surface
  # a warn, and return nonzero so the caller's `if ! jq_update …` path
  # is reachable. Same shape on both the populated-file and seed (-n)
  # branches.
  if [[ -s "$file" ]]; then
    if ! jq "$@" "$filter" "$file" >"$tmp" 2>/dev/null; then
      rm -f "$tmp"
      exec {lockfd}>&-
      atmux::warn "jq_update: filter failed on $file (left untouched)"
      return 1
    fi
  else
    if ! jq -n "$@" "$filter" >"$tmp" 2>/dev/null; then
      rm -f "$tmp"
      exec {lockfd}>&-
      atmux::warn "jq_update: filter failed seeding $file (left untouched)"
      return 1
    fi
  fi
  mv "$tmp" "$file"
  # E6/S1 t-dd78c8a5 (F12) — post-write sanity. Even when jq exits 0,
  # the bytes that landed on disk may not be valid JSON: disk-full
  # mid-mv, kernel I/O truncation on cheap VPS storage, jq bug
  # emitting incomplete output. atmux::jq_update is the chokepoint
  # for ~75+ shared-state writes (every kanban / inbox / state-file
  # mutation), so three lines here protect every caller that opted
  # into the atomic helper. Returns nonzero on detection so
  # `if ! atmux::jq_update …` paths fire; pairs with F2 (kanban_json
  # backup) for non-traumatic recovery.
  if ! jq -e . "$file" >/dev/null 2>&1; then
    atmux::warn "jq_update: post-write JSON invalid at $file (disk-full / truncation / jq bug?)"
    exec {lockfd}>&-
    return 1
  fi
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

# atmux::tmp_path <prefix> [<ext>]
#
# Mints a per-team-scoped tempfile under .atmux/tmp/. Pre-A9, the four
# main paste/render call sites used /tmp/atmux-*-XXXXXX which shared a
# namespace across all atmux teams on the host (multi-team setups would
# observe each other's transient files). Scoping to the team's .atmux/
# dir gives clean isolation; cleanup remains the caller's responsibility
# (each call site already pairs the mktemp with `rm -f "$tmp"`).
#
# Returns the path on stdout. <ext> is appended after XXXXXX with a `.`
# separator when non-empty; mktemp gets the dotted form so the random
# segment is the suffix-free portion. E6/S5 t-6d1ac10c.
atmux::tmp_path() {
  local prefix="${1:?atmux::tmp_path: <prefix> required}"
  local ext="${2:-}"
  local d; d="$(atmux::dir)/tmp"
  mkdir -p "$d"
  local template
  if [[ -n "$ext" ]]; then
    template="$d/atmux-${prefix}-XXXXXX.$ext"
  else
    template="$d/atmux-${prefix}-XXXXXX"
  fi
  mktemp "$template"
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

# ---------- push-target refuse-gate (ADR-028) ----------

# Hard refuse-gate for git-push targets. Per ADR-028, main/master is the
# exclusive PR-merge target; agents never push directly. Callers wire this
# in BEFORE constructing any `git push` invocation. --force does NOT
# override (intentional — mirrors lib/stop.sh's destructive-op refuse
# pattern). The escape hatch is the human-driven PR path:
#   gh pr create --base main --head <wip-branch>
# followed by human-clicked merge in Github UI (or human-invoked
# `gh pr merge`). No agent flag (--force-push-main) is provided —
# flags drift in autonomous mode.
atmux::guard_push_target() {
  local branch="${1:-}"
  if [[ "$branch" =~ ^(main|master)$ ]]; then
    atmux::die "push-target refuse: $branch is PR-only per ADR-028 — open a PR (gh pr create --base $branch); gh pr merge is human-only"
  fi
}
