#!/usr/bin/env bash
# bau.sh — Business As Usual status report.
#
# Single-shot executable for the /bau skill. Emits final markdown on stdout.
# The skill's SKILL.md is now a thin pointer; all procedure lives here.
#
# Invocation (from SKILL.md):
#   scripts/bau.sh [HOURS] [--no-fix] [--digest|--no-digest]
#
# Exit codes:
#   0 ok (report emitted)
#   1 cockpit.json missing
#   2 bad arg
#
# Env overrides:
#   ATMUX_COCKPIT_CONFIG     cockpit.json path (default ~/.atmux/cockpit.json)
#   BAU_STALE_THRESHOLD_HOURS    velocity-fix trigger threshold (default 4)
#
# Performance shape:
#   - All git/atmux/tmux probes fanned out in parallel inside each team
#   - Teams themselves fan out in parallel
#   - Single bash invocation: Claude only does one tool roundtrip
#
# Maps to old SKILL.md sections:
#   Step 0   → arg-parse + scope detect + roster load
#   Step 1   → collect_team() (parallel fan-out)
#   Step 1b  → analyse_team() (in-memory derivations)
#   Step 2   → verdict()
#   Step 3   → eternal-improvement check (inside analyse_team)
#   Step 3.5 → shipped-features digest (inside emit_team, gated by --digest)
#   Step 4   → emit_team() + emit_report()
#   Step 5   → recommended_action() (inside emit_team)
#   Step 6   → velocity_fix_escalate() (after analyse, before emit)

set -o pipefail

# ────────────────────────────────────────────────────────────────────────────
# Section 0 — Config + arg parse
# ────────────────────────────────────────────────────────────────────────────

HOURS=24
BAU_FIX=1
BAU_DIGEST=auto   # auto = on for HOURS>=24
STALE_THRESHOLD_HOURS="${BAU_STALE_THRESHOLD_HOURS:-4}"
# Don't fire velocity-fix on a freshly-spawned or just-rotated lead — give
# it time to dispatch before nagging. A team standing up has no shipping
# history during the new lead's lifetime, so the trigger (last_ship_age >=
# STALE_THRESHOLD_HOURS) trivially fires. Guard only kicks in when the
# current lead session started after the last ship. Default 120min (2h
# settle-in window). Override via env.
FRESH_LEAD_GUARD_MIN="${BAU_FRESH_LEAD_GUARD_MIN:-120}"
COCKPIT="${ATMUX_COCKPIT_CONFIG:-$HOME/.atmux/cockpit.json}"

# Timezone for user-facing timestamps. Defaults match plugin userConfig.
COORD_TZ="${COORDINATION_TZ:-UTC}"
COORD_TZ_SUFFIX="${COORDINATION_TZ_SUFFIX:-UTC}"

for a in "$@"; do
  case "$a" in
    --no-fix)    BAU_FIX=0 ;;
    --digest)    BAU_DIGEST=on ;;
    --no-digest) BAU_DIGEST=off ;;
    --help|-h)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *[!0-9]*|'') ;;
    *)           HOURS="$a" ;;
  esac
done
if [[ "$BAU_DIGEST" == "auto" ]]; then
  (( HOURS >= 24 )) && BAU_DIGEST=on || BAU_DIGEST=off
fi

NOW_TS="$(TZ="$COORD_TZ" date +"%H:%M ${COORD_TZ_SUFFIX} %Y-%m-%d")"
NOW_EPOCH=$(date +%s)
SINCE_HUMAN="${HOURS} hours ago"

# Note: cockpit.json existence check is deferred until after scope detection
# (Section 1). If scope ends up as a single team discovered via cwd-walk, the
# script can still produce a useful single-team report without a cockpit
# roster — minimax-style external hosts won't always have one set up.

# ────────────────────────────────────────────────────────────────────────────
# Section 1 — Scope detection (any-shell support)
# ────────────────────────────────────────────────────────────────────────────
#
# Priority:
#   1. tmux cage socket `/tmp/atmux-<team>/sock`     → scope=<team>
#   2. cwd-walk finds an `.atmux/team.json` ancestor → scope=<team>
#                                                      (team name read from json)
#   3. Anything else (cockpit pane, plain ssh, external claude host like
#      minimax) → scope=all → cockpit-wide superdriver report.
#
# Rule of thumb: "if I'm sitting inside a team workspace, report on that
# team. Otherwise show me the cockpit." External hosts get superdriver-view
# for free.

BAU_SCOPE=all
SCOPE_FALLBACK=""

# (1) tmux cage socket — operator is explicitly inside a cage pane.
if SOCKPATH=$(tmux display-message -p '#{socket_path}' 2>/dev/null); then
  if [[ "$SOCKPATH" =~ /tmp/atmux-([^/]+)/sock$ ]]; then
    BAU_SCOPE="${BASH_REMATCH[1]}"
  fi
fi

# (2) cwd-walk fallback — only when tmux didn't pin a team scope.
if [[ "$BAU_SCOPE" == "all" ]]; then
  walk_dir="$PWD"
  while [[ -n "$walk_dir" && "$walk_dir" != "/" ]]; do
    if [[ -f "$walk_dir/.atmux/team.json" ]]; then
      cwd_team=$(jq -r '.name // empty' "$walk_dir/.atmux/team.json" 2>/dev/null)
      if [[ -n "$cwd_team" ]]; then
        BAU_SCOPE="$cwd_team"
        # Remember the team-root discovered by cwd walk so we can fall back
        # to it even if cockpit.json doesn't list the team.
        CWD_TEAM_ROOT="$walk_dir"
      fi
      break
    fi
    walk_dir=$(dirname "$walk_dir")
  done
  unset walk_dir
fi

# ────────────────────────────────────────────────────────────────────────────
# Section 2 — Load cockpit roster (or synthesize for cwd-detected team)
# ────────────────────────────────────────────────────────────────────────────

declare -A TEAM_ROOT TEAM_LABEL TEAM_ENABLED
declare -a TEAM_ORDER

# Single jq expression that handles both cockpit.json shapes:
#   - Legacy (pre-ADR-089): flat `.teams[]`
#   - Modern (ADR-089): `.sessions[]` with `type` discriminator ("team" / "medic" / "epic-team")
#     Note: the "medic" discriminator value is reserved per back-compat after ADR-212
#     retired the auto-spawned medic role; the cockpit.json schema slot remains.
# Only top-level type=="team" sessions are emitted — medic has root=null
# (would break git ops downstream) and epic-teams roll up to their parent for
# now. If/when bau grows per-epic verdicts, walk into `.sessions[].sessions[]`.
TEAMS_JQ='
  ( if has("teams") then .teams[]
    else .sessions[]? | select(.type == "team")
    end )
  | "\(.name)\t\(.root // "")\t\(.claudeAccount.label // "?")\t\(.enabled)"
'

load_all_teams() {
  TEAM_ORDER=()
  while IFS=$'\t' read -r name root label enabled; do
    [[ -z "$name" ]] && continue
    TEAM_ORDER+=("$name")
    TEAM_ROOT[$name]="$root"
    TEAM_LABEL[$name]="$label"
    TEAM_ENABLED[$name]="$enabled"
  done < <(jq -r "$TEAMS_JQ" "$COCKPIT")
}

COCKPIT_PRESENT=0
[[ -f "$COCKPIT" ]] && COCKPIT_PRESENT=1

if [[ "$BAU_SCOPE" == "all" ]]; then
  # All-teams report — cockpit.json is mandatory.
  if (( COCKPIT_PRESENT == 0 )); then
    echo "# /bau — error" >&2
    echo "cockpit.json not found at $COCKPIT — required for all-teams scope." >&2
    echo "If you meant to report on a single team, cd into a team root (one with .atmux/team.json) and re-run." >&2
    exit 1
  fi
  load_all_teams
else
  # Single-team scope. Prefer cockpit.json's entry (has account label etc),
  # but fall back to the cwd-discovered root when the team isn't rostered
  # OR cockpit.json doesn't exist at all (external host, fresh install).
  ROW=""
  if (( COCKPIT_PRESENT == 1 )); then
    ROW=$(jq -r --arg t "$BAU_SCOPE" '
      ( if has("teams") then .teams[]
        else .sessions[]? | select(.type == "team")
        end )
      | select(.name == $t)
      | "\(.name)\t\(.root // "")\t\(.claudeAccount.label // "?")\t\(.enabled)"
    ' "$COCKPIT")
  fi

  if [[ -n "$ROW" ]]; then
    IFS=$'\t' read -r name root label enabled <<< "$ROW"
    TEAM_ORDER+=("$name")
    TEAM_ROOT[$name]="$root"
    TEAM_LABEL[$name]="$label"
    TEAM_ENABLED[$name]="$enabled"
  elif [[ -n "${CWD_TEAM_ROOT:-}" ]]; then
    # cwd-walk found a team but cockpit.json doesn't list it (or doesn't
    # exist). Synthesize a roster entry from the cwd-discovered root so
    # the report still works for that team.
    TEAM_ORDER+=("$BAU_SCOPE")
    TEAM_ROOT[$BAU_SCOPE]="$CWD_TEAM_ROOT"
    TEAM_LABEL[$BAU_SCOPE]="local"
    TEAM_ENABLED[$BAU_SCOPE]="true"
    if (( COCKPIT_PRESENT == 0 )); then
      SCOPE_FALLBACK="no cockpit.json at $COCKPIT — reporting on cwd-detected team '${BAU_SCOPE}' only"
    else
      SCOPE_FALLBACK="team '${BAU_SCOPE}' not in cockpit roster — using cwd-detected root '${CWD_TEAM_ROOT}'"
    fi
  else
    # Cage-socket scope with no matching cockpit entry and no cwd hint.
    # Fall back to all-teams view.
    if (( COCKPIT_PRESENT == 1 )); then
      SCOPE_FALLBACK="scope '${BAU_SCOPE}' not in cockpit.json roster — reverting to all-teams"
      BAU_SCOPE=all
      load_all_teams
    else
      echo "# /bau — error" >&2
      echo "scope '${BAU_SCOPE}' couldn't be resolved and no cockpit.json at $COCKPIT." >&2
      exit 1
    fi
  fi
fi

# ────────────────────────────────────────────────────────────────────────────
# Section 3 — Scratch dir
# ────────────────────────────────────────────────────────────────────────────

TMPDIR_BAU="$(mktemp -d -t bau-XXXXXX)"
trap 'rm -rf "$TMPDIR_BAU"' EXIT

# ────────────────────────────────────────────────────────────────────────────
# Section 4 — Per-team data collection (parallel fan-out)
# ────────────────────────────────────────────────────────────────────────────

collect_team() {
  local team="$1"
  local root="${TEAM_ROOT[$team]}"
  local dir="$TMPDIR_BAU/$team"
  mkdir -p "$dir"

  # Resolve cage socket — try both conventions:
  #   1) legacy: /tmp/atmux-<team>/sock
  #   2) current: <team-root>/.atmux/tmux/tmux-0/default
  local sock=""
  if [[ -S "/tmp/atmux-${team}/sock" ]]; then
    sock="/tmp/atmux-${team}/sock"
  elif [[ -S "${root}/.atmux/tmux/tmux-0/default" ]]; then
    sock="${root}/.atmux/tmux/tmux-0/default"
  fi
  echo "$sock" > "$dir/sock_path.txt"

  cd "$root" 2>/dev/null || { echo "ROOT_MISSING" > "$dir/error.txt"; return; }

  # git root log + submodules + shortstat + last-ship — all parallel
  ( git log --all --since="$SINCE_HUMAN" --format='%h|%ci|%an|%s' 2>/dev/null > "$dir/root.txt" ) &
  ( git log --all --since="$SINCE_HUMAN" --shortstat 2>/dev/null \
      | awk '/files? changed/ { ins+=$4; del+=$6 } END { print (ins+0)"|"(del+0) }' \
      > "$dir/stat.txt" ) &
  ( git log -1 --all --format='%ci' 2>/dev/null > "$dir/last_ship.txt" ) &
  if [[ -f .gitmodules ]]; then
    ( git submodule foreach --quiet 'echo $sm_path' 2>/dev/null \
        | xargs -r -P8 -I{} sh -c 'cd "{}" 2>/dev/null && git log --all --since="'"$SINCE_HUMAN"'" --format="{}|%h|%ci|%an|%s" 2>/dev/null' \
        > "$dir/subs.txt" ) &
  else
    : > "$dir/subs.txt"
  fi

  # atmux state — SQLite-backed, fast
  ( atmux task list --json 2>/dev/null > "$dir/tasks.json" || echo "[]" > "$dir/tasks.json" ) &
  ( atmux complaints list --status open --json 2>/dev/null > "$dir/complaints.json" || echo "[]" > "$dir/complaints.json" ) &

  # tmux pane captures — one per window
  if [[ -n "$sock" && -S "$sock" ]]; then
    local session
    session=$(tmux -S "$sock" list-sessions -F '#{session_name}' 2>/dev/null | head -1)
    if [[ -n "$session" ]]; then
      echo "$session" > "$dir/session.txt"
      tmux -S "$sock" list-windows -t "$session" -F '#{window_index}|#{window_name}' 2>/dev/null > "$dir/windows.txt"
      while IFS='|' read -r w wname; do
        [[ -z "$w" ]] && continue
        ( tmux -S "$sock" capture-pane -p -t "${session}:${w}" -S -30 2>/dev/null > "$dir/pane-${w}.txt" ) &
      done < "$dir/windows.txt"
    fi
  fi

  wait
}

for team in "${TEAM_ORDER[@]}"; do
  [[ "${TEAM_ENABLED[$team]}" == "true" ]] || continue
  ( collect_team "$team" ) &
done
wait

# ────────────────────────────────────────────────────────────────────────────
# Section 5 — Helpers (formatters, lookups)
# ────────────────────────────────────────────────────────────────────────────

# Duration formatter: minutes → "Nmin" / "HhMm" / "Hh"
fmt_dur() {
  local m="${1:-0}"
  if (( m < 60 )); then printf "%dmin" "$m"
  else
    local h=$(( m / 60 )) r=$(( m % 60 ))
    (( r == 0 )) && printf "%dh" "$h" || printf "%dh%dm" "$h" "$r"
  fi
}

# Relative-time formatter from ISO-8601 → "Xmin ago" / "Xh ago"
rel_time() {
  local iso="$1"
  [[ -z "$iso" ]] && { echo "—"; return; }
  local then_epoch
  then_epoch=$(date -d "$iso" +%s 2>/dev/null) || { echo "—"; return; }
  local age_s=$(( NOW_EPOCH - then_epoch ))
  local age_m=$(( age_s / 60 ))
  if (( age_m < 1 )); then echo "just now"
  elif (( age_m < 60 )); then echo "${age_m}min ago"
  else
    local h=$(( age_m / 60 )) r=$(( age_m % 60 ))
    (( r == 0 )) && echo "${h}h ago" || echo "${h}h${r}m ago"
  fi
}

# ISO timestamp → user-tz HH:MM with suffix
iso_to_local() {
  local iso="$1"
  [[ -z "$iso" ]] && { echo "—"; return; }
  TZ="$COORD_TZ" date -d "$iso" +"%H:%M ${COORD_TZ_SUFFIX}" 2>/dev/null || echo "—"
}

# t-0a4fc7f6: cross-check whip-velocity-gate.log to disambiguate the
# bau Stuck-input verdict from a transient pane-snapshot blind spot.
# Loaded from a sibling lib so the function is bats-testable in isolation
# without booting the rest of the bau pipeline.
#
# shellcheck source=./lib-velocity-gate.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib-velocity-gate.sh"

# Resolve ADR title from a team root + ADR number
resolve_adr() {
  local team_root="$1" adr_num="$2"
  for adr_dir in "$team_root/docs/adr" "$team_root/doc/adr" "$team_root/adr"; do
    [[ -d "$adr_dir" ]] || continue
    local adr_file
    adr_file=$(ls "$adr_dir"/${adr_num}-*.md 2>/dev/null | head -1)
    if [[ -n "$adr_file" ]]; then
      head -1 "$adr_file" | sed 's/^#\s*//' | head -c 120
      return
    fi
  done
}

# ────────────────────────────────────────────────────────────────────────────
# Section 6 — Per-team analysis (verdict, metrics, member states)
# ────────────────────────────────────────────────────────────────────────────
#
# Writes per-team variables into /tmp/bau-<TMPDIR>/$team/analysis.env so the
# emit step can source them. Cleaner than global arrays-of-strings.

analyse_team() {
  local team="$1"
  local root="${TEAM_ROOT[$team]}"
  local dir="$TMPDIR_BAU/$team"

  # --- Commits in window (root + subs) ---
  local root_n=0 subs_n=0 total=0
  [[ -s "$dir/root.txt" ]] && root_n=$(wc -l < "$dir/root.txt" 2>/dev/null | tr -d ' \n')
  [[ -s "$dir/subs.txt" ]] && subs_n=$(wc -l < "$dir/subs.txt" 2>/dev/null | tr -d ' \n')
  root_n=${root_n:-0}
  subs_n=${subs_n:-0}
  total=$(( root_n + subs_n ))

  # --- Last ship (across submodules + root) — pick newest %ci ---
  local last_ship_iso=""
  if [[ -f "$dir/last_ship.txt" ]]; then
    last_ship_iso=$(cat "$dir/last_ship.txt")
  fi
  # Walk submodules to see if any has a more-recent ship
  if [[ -f .gitmodules || -f "$root/.gitmodules" ]]; then
    while IFS= read -r sm; do
      [[ -z "$sm" ]] && continue
      local sm_iso
      sm_iso=$(cd "$root/$sm" 2>/dev/null && git log -1 --all --format='%ci' 2>/dev/null)
      if [[ -n "$sm_iso" ]]; then
        if [[ -z "$last_ship_iso" ]] \
          || [[ $(date -d "$sm_iso" +%s 2>/dev/null) -gt $(date -d "$last_ship_iso" +%s 2>/dev/null) ]]; then
          last_ship_iso="$sm_iso"
        fi
      fi
    done < <(cd "$root" 2>/dev/null && git submodule foreach --quiet 'echo $sm_path' 2>/dev/null)
  fi

  local last_ship_epoch=0 last_ship_age_min=99999 last_ship_age_h=9999
  if [[ -n "$last_ship_iso" ]]; then
    last_ship_epoch=$(date -d "$last_ship_iso" +%s 2>/dev/null || echo 0)
    last_ship_age_min=$(( (NOW_EPOCH - last_ship_epoch) / 60 ))
    last_ship_age_h=$(( last_ship_age_min / 60 ))
  fi

  # --- Last ship sha (newest commit summary) ---
  local last_ship_sha="" last_ship_subj=""
  if (( total > 0 )); then
    local newest_line
    newest_line=$( (cat "$dir/root.txt" "$dir/subs.txt" 2>/dev/null) \
      | awk -F'|' 'NF>=4 { print $0 }' \
      | sort -t'|' -k2,2r \
      | head -1)
    if [[ -n "$newest_line" ]]; then
      IFS='|' read -r f1 f2 f3 f4 f5 <<< "$newest_line"
      # root.txt is sha|ci|an|subj (4 fields); subs.txt is path|sha|ci|an|subj (5)
      if [[ "$newest_line" =~ ^[a-f0-9]{7,}\| ]]; then
        last_ship_sha="$f1"; last_ship_subj="$f4"
      else
        last_ship_sha="$f2"; last_ship_subj="$f5"
      fi
    fi
  fi

  # --- Eternal-improvement: revert ratio + net churn + authors ---
  local reverts=0 net_ins=0 net_del=0
  if [[ -s "$dir/root.txt" ]]; then
    # grep -c returns exit 1 on zero matches; we don't care, just use the count
    reverts=$(grep -ciE 'revert|undo|rollback' "$dir/root.txt" 2>/dev/null)
  fi
  reverts=${reverts:-0}
  if [[ -f "$dir/stat.txt" ]]; then
    IFS='|' read -r net_ins net_del < "$dir/stat.txt"
    net_ins="${net_ins:-0}"; net_del="${net_del:-0}"
  fi
  local authors=""
  if [[ -f "$dir/root.txt" ]]; then
    authors=$(awk -F'|' 'NF>=3 { print $3 }' "$dir/root.txt" | sort -u | paste -sd ',' -)
  fi

  # --- Conv-commit type breakdown ---
  local types=""
  if (( total > 0 )); then
    types=$( (awk -F'|' 'NF>=4 { msg=$NF; sub(/[(:].*/,"",msg); print msg }' "$dir/root.txt" 2>/dev/null
              awk -F'|' 'NF>=5 { msg=$NF; sub(/[(:].*/,"",msg); print msg }' "$dir/subs.txt" 2>/dev/null) \
            | sort | uniq -c | sort -rn \
            | awk '{ printf "%s:%d ", $2, $1 }')
    types="${types% }"
  fi

  # --- Kanban counts ---
  local todo_n=0 inprog_n=0 done_n=0 blocked_n=0
  if [[ -f "$dir/tasks.json" ]]; then
    todo_n=$(jq    '[.[] | select(.status=="todo")]        | length' "$dir/tasks.json" 2>/dev/null)
    inprog_n=$(jq  '[.[] | select(.status=="in-progress")] | length' "$dir/tasks.json" 2>/dev/null)
    done_n=$(jq    '[.[] | select(.status=="done")]        | length' "$dir/tasks.json" 2>/dev/null)
    blocked_n=$(jq '[.[] | select(.status=="blocked")]     | length' "$dir/tasks.json" 2>/dev/null)
  fi
  todo_n=${todo_n:-0}; inprog_n=${inprog_n:-0}; done_n=${done_n:-0}; blocked_n=${blocked_n:-0}

  # --- Complaints ---
  local complaints_n=0 complaints_top=""
  if [[ -f "$dir/complaints.json" ]]; then
    complaints_n=$(jq 'length' "$dir/complaints.json" 2>/dev/null)
    complaints_n=${complaints_n:-0}
    if (( complaints_n > 0 )); then
      complaints_top=$(jq -r '.[0].summary // .[0].title // ""' "$dir/complaints.json" 2>/dev/null | head -c 120)
    fi
  fi

  # --- Lead pane state (window 2 by ADR-044) ---
  local lead_pane="$dir/pane-2.txt"
  local rate_limited=0 saturated=0 lead_state="unknown" lead_tokens="" lead_ctx=""
  if [[ -f "$lead_pane" ]]; then
    if grep -qE "hit your limit|/extra-usage to finish" "$lead_pane"; then rate_limited=1; fi
    if grep -qE "/clear to save .* tokens" "$lead_pane"; then saturated=1; fi
    if tail -3 "$lead_pane" | grep -qE '^✽|^✻|^✶'; then lead_state="working"
    elif (( rate_limited )); then lead_state="rate-limited"
    else lead_state="idle"
    fi
    # tokens + ctx from footer "Nk tok / X% ctx" patterns
    lead_tokens=$(grep -oE '[0-9]+\.?[0-9]*[kK]?[[:space:]]*tok' "$lead_pane" | tail -1)
    lead_ctx=$(grep -oE '[0-9]+%[[:space:]]*ctx' "$lead_pane" | tail -1)
  fi

  # --- Lead uptime from ~/.claude/teams/<team>/lead-session-start.txt ---
  # Probe the canonical $HOME/.claude/... path first, then expand the glob
  # $HOME/.claude-*/... to catch teams whose lead pane runs under any
  # operator-defined claude-account-suffix dir (configured per-team via
  # team.json :: claudeAccount; see ADR-094). nullglob keeps the literal
  # array empty when no expansions match so the loop's `-f` guard skips.
  local lead_upmin="" lead_start_epoch=""
  shopt -s nullglob
  local lss_paths=(
    "$HOME/.claude/teams/${team}/lead-session-start.txt"
    "$HOME"/.claude-*/teams/"${team}"/lead-session-start.txt
  )
  shopt -u nullglob
  for p in "${lss_paths[@]}"; do
    if [[ -f "$p" ]]; then
      local lss_epoch
      lss_epoch=$(cat "$p" 2>/dev/null)
      if [[ "$lss_epoch" =~ ^[0-9]+$ ]]; then
        lead_upmin=$(( (NOW_EPOCH - lss_epoch) / 60 ))
        lead_start_epoch="$lss_epoch"
      fi
      break
    fi
  done

  # --- Member states from cached pane files (panes 3+) ---
  local working_n=0 queued_n=0 member_n=0
  for f in "$dir"/pane-*.txt; do
    [[ -f "$f" ]] || continue
    local w_idx
    w_idx=$(basename "$f" .txt | sed 's/^pane-//')
    # Skip non-member windows (1=driver, 2=lead)
    case "$w_idx" in 1|2) continue ;; esac
    member_n=$(( member_n + 1 ))
    # working: spinner in last 3 lines
    if tail -3 "$f" | grep -qE '^✽|^✻|^✶'; then
      working_n=$(( working_n + 1 ))
      continue
    fi
    # queued: detect ACTUAL live composer (bracketed by ──── separators above
    # the rate-limit footer), NOT any historical ❯ line in scrollback. Per
    # complaint c-a3c3a42d — the prior heuristic (last ❯ in tail -10) matched
    # rendered-inline ❯ content in model response bodies (e.g. lead-routed
    # dispatch text rendered inside the agent's reply turn that begins with
    # the prompt glyph) + counted them as queued, producing many false
    # positives on idle 19-member teams.
    #
    # Robust position: walk the file bottom-up via tac; the FIRST `❯` line
    # encountered after the FIRST `────────` separator IS the live composer.
    # Claude Code v2.1.141 TUI always brackets the composer this way.
    local compose
    compose=$(tac "$f" | awk '
      /^─{20,}/ { sep_n++; next }
      sep_n >= 1 && /^❯ ?/ { print; exit }
    ' | sed 's/^❯[[:space:]]*//')
    # Strip Claude Code's fresh-pane placeholder hint — it renders as literal
    # `Try "<example>"` inside the compose line on never-used panes and trips
    # the alnum heuristic below. The TUI prefixes the placeholder with a
    # non-breaking-space (U+00A0 = 0xC2 0xA0) before `Try`, which sed
    # `[[:space:]]*` does not strip under POSIX locale — so trim NBSP +
    # regular whitespace before matching. Real queued input never wraps in
    # quotation-marks-around-an-example-sentence, so the regex is safe.
    local compose_trimmed
    compose_trimmed=$(printf '%s' "$compose" | sed $'s/^[[:space:]\xc2\xa0]*//; s/[[:space:]]*$//')
    if [[ "$compose_trimmed" =~ ^Try\ \".*\"$ ]]; then
      compose=""
    fi
    local clean
    clean=$(echo "$compose" | grep -oE '[A-Za-z0-9]' | head -1)
    # Belt-and-braces: canonical Claude Code TUI indicator for queued input.
    # `Press up to edit queued messages` appears in the rate-limit footer
    # whenever a typed-but-unsubmitted message is buffered. Treat its
    # presence as queued even if the composer-position heuristic misses
    # (e.g. future TUI rev changing separator glyph).
    local press_up_n
    press_up_n=$(tail -20 "$f" | grep -cF 'Press up to edit queued messages' || true)
    if [[ -n "$clean" ]] || (( press_up_n > 0 )); then
      queued_n=$(( queued_n + 1 ))
    fi
  done

  # --- Cage liveness — sock_path.txt was written by collect_team using
  #     the same resolver (legacy or .atmux/tmux/ convention).
  local cage_alive=0 sock_path=""
  [[ -f "$dir/sock_path.txt" ]] && sock_path=$(cat "$dir/sock_path.txt")
  [[ -n "$sock_path" && -S "$sock_path" ]] && cage_alive=1

  # --- Verdict ---
  #
  # t-0a4fc7f6: the Stuck-input verdict (queued_n >= 3) is gated by a
  # cross-check against whip-velocity-gate.log. If the velocity-gate
  # has recorded velocity=OK in any of the team's last 3 readings (=
  # last ~15min at 5min cadence), the team is demonstrably shipping —
  # the queued-pane snapshot caught a mid-spinner gap and Stuck-input
  # would be a false-positive. Downgrade to the normal BAU ladder.
  #
  # Commits-in-window weighted higher than pane-snapshot when they
  # disagree: total >= 1 with recent commit-age picks BAU regardless
  # of pane-snapshot readings further down.
  local verdict_emoji verdict_label
  if (( cage_alive == 0 )); then
    verdict_emoji="💤"; verdict_label="Down"
  elif (( rate_limited )); then
    verdict_emoji="🚫"; verdict_label="Rate-Limited"
  elif (( saturated )); then
    verdict_emoji="💀"; verdict_label="Saturated"
  elif (( total >= 1 && last_ship_age_h < STALE_THRESHOLD_HOURS )); then
    # Commit-cadence wins. A team that shipped a commit inside the
    # stale-threshold window cannot be Stuck-input regardless of what
    # the pane-snapshot says — false positives on this verdict have
    # historically come from misreading fresh / placeholder panes as
    # queued, and the cost of mis-flagging a demonstrably-shipping team
    # is worse than missing a transient pane jam (which the next bau
    # cycle catches).
    verdict_emoji="🟢"; verdict_label="BAU"
  elif (( queued_n >= 3 )) && ! team_recent_velocity_ok "$team"; then
    # Both signals (pane-snapshot AND velocity-gate AND no recent
    # commits in window) agree teams are idle → Stuck-input fires.
    verdict_emoji="⚙️"; verdict_label="Stuck-input"
  elif (( last_ship_age_h < HOURS )); then
    verdict_emoji="🟡"; verdict_label="Quiescent-fresh"
  elif (( last_ship_age_h < HOURS * 2 )); then
    verdict_emoji="🟡"; verdict_label="Quiescent-stale"
  else
    verdict_emoji="🔴"; verdict_label="Dormant"
  fi

  # --- Velocity-fix trigger (Step 6) ---
  local trigger_fix=0
  if (( last_ship_age_h >= STALE_THRESHOLD_HOURS )); then
    # Skip cases where the lead can't act
    case "$verdict_label" in
      Rate-Limited|Saturated|Down|Stuck-input) trigger_fix=0 ;;
      *) trigger_fix=1 ;;
    esac
  fi

  # Persist for emit step — write each value as printf %q so sourcing is safe
  # against parens / quotes / spaces / Unicode in commit subjects.
  {
    printf 'team=%q\n'              "$team"
    printf 'root=%q\n'              "$root"
    printf 'label=%q\n'             "${TEAM_LABEL[$team]:-}"
    printf 'total=%q\n'             "$total"
    printf 'root_n=%q\n'            "$root_n"
    printf 'subs_n=%q\n'            "$subs_n"
    printf 'last_ship_iso=%q\n'     "$last_ship_iso"
    printf 'last_ship_age_min=%q\n' "$last_ship_age_min"
    printf 'last_ship_age_h=%q\n'   "$last_ship_age_h"
    printf 'last_ship_sha=%q\n'     "${last_ship_sha:-}"
    printf 'last_ship_subj=%q\n'    "${last_ship_subj:-}"
    printf 'reverts=%q\n'           "$reverts"
    printf 'net_ins=%q\n'           "$net_ins"
    printf 'net_del=%q\n'           "$net_del"
    printf 'authors=%q\n'           "${authors:-}"
    printf 'types=%q\n'             "${types:-}"
    printf 'todo_n=%q\n'            "$todo_n"
    printf 'inprog_n=%q\n'          "$inprog_n"
    printf 'done_n=%q\n'            "$done_n"
    printf 'blocked_n=%q\n'         "$blocked_n"
    printf 'complaints_n=%q\n'      "$complaints_n"
    printf 'complaints_top=%q\n'    "${complaints_top:-}"
    printf 'lead_state=%q\n'        "$lead_state"
    printf 'lead_tokens=%q\n'       "${lead_tokens:-}"
    printf 'lead_ctx=%q\n'          "${lead_ctx:-}"
    printf 'lead_upmin=%q\n'        "${lead_upmin:-}"
    printf 'lead_start_epoch=%q\n'  "${lead_start_epoch:-}"
    printf 'last_ship_epoch=%q\n'   "${last_ship_epoch:-}"
    printf 'rate_limited=%q\n'      "$rate_limited"
    printf 'saturated=%q\n'         "$saturated"
    printf 'working_n=%q\n'         "$working_n"
    printf 'queued_n=%q\n'          "$queued_n"
    printf 'member_n=%q\n'          "$member_n"
    printf 'cage_alive=%q\n'        "$cage_alive"
    printf 'verdict_emoji=%q\n'     "$verdict_emoji"
    printf 'verdict_label=%q\n'     "$verdict_label"
    printf 'trigger_fix=%q\n'       "$trigger_fix"
  } > "$dir/analysis.env"
}

for team in "${TEAM_ORDER[@]}"; do
  [[ "${TEAM_ENABLED[$team]}" == "true" ]] || continue
  ( analyse_team "$team" ) &
done
wait

# ────────────────────────────────────────────────────────────────────────────
# Section 7 — Velocity-fix escalation (Step 6)
# ────────────────────────────────────────────────────────────────────────────

declare -a ESCALATED SKIPPED

velocity_fix_escalate() {
  local team="$1"
  local root="${TEAM_ROOT[$team]}"
  local dir="$TMPDIR_BAU/$team"

  # Source analysis vars (scoped to this fn via subshell at caller)
  local team_v root_v verdict_emoji verdict_label total last_ship_age_h last_ship_age_min
  local working_n queued_n member_n inprog_n blocked_n todo_n lead_state lead_tokens
  local trigger_fix
  # shellcheck source=/dev/null
  source "$dir/analysis.env"

  (( trigger_fix == 1 )) || return

  # Fresh-lead guard — skip velocity-fix when the current lead session
  # started AFTER the last ship AND the lead is still within its grace
  # window. This catches two cases:
  #   • freshly-stood-up team (no shipping in current lead's lifetime)
  #   • just-rotated lead (previous lead's dormancy isn't the new lead's
  #     fault yet — give it a chance to dispatch)
  # Always fires for a long-running lead that's letting a healthy team
  # drift, because lead_start < last_ship there.
  if [[ -n "$lead_upmin" && "$lead_upmin" =~ ^[0-9]+$ ]] \
     && (( lead_upmin < FRESH_LEAD_GUARD_MIN )) \
     && [[ -n "${lead_start_epoch:-}" && -n "${last_ship_epoch:-}" ]] \
     && (( lead_start_epoch > last_ship_epoch )); then
    SKIPPED+=("$team:fresh lead (uptime ${lead_upmin}min < ${FRESH_LEAD_GUARD_MIN}min, started after last ship)")
    return
  fi
  # Always skip on a never-shipped team during the grace window — a team
  # with zero history can't be "dormant" yet.
  if [[ -z "${last_ship_epoch:-}" || "${last_ship_epoch}" == "0" ]] \
     && [[ -n "$lead_upmin" && "$lead_upmin" =~ ^[0-9]+$ ]] \
     && (( lead_upmin < FRESH_LEAD_GUARD_MIN )); then
    SKIPPED+=("$team:never-shipped + fresh lead (uptime ${lead_upmin}min)")
    return
  fi

  # Dedup gate — check state file written on prior successful fire.
  # State file is preferred over grep'ing the inbox markdown because the
  # inbox's outer timestamp is added by atmux tell-lead (in its own TZ),
  # not by bau, so a regex-on-inbox approach would have to know two TZs.
  local dedup_min=$(( HOURS * 60 / 2 ))
  (( dedup_min < 60 )) && dedup_min=60
  (( dedup_min > 360 )) && dedup_min=360
  local statefile="$root/.atmux/state/bau-velocity-fix.epoch"
  local skip_reason=""
  if [[ -f "$statefile" ]]; then
    local last_epoch
    last_epoch=$(cat "$statefile" 2>/dev/null)
    if [[ "$last_epoch" =~ ^[0-9]+$ ]] && (( NOW_EPOCH - last_epoch < dedup_min * 60 )); then
      local age_min=$(( (NOW_EPOCH - last_epoch) / 60 ))
      skip_reason="recent /bau velocity-fix ${age_min}min ago (<${dedup_min}min dedup window)"
    fi
  fi

  if [[ -n "$skip_reason" ]]; then
    SKIPPED+=("$team:$skip_reason")
    return
  fi

  # Compose directive
  local body
  body=$(cat <<EOM
[/bau velocity-fix · $NOW_TS] Verdict: ${verdict_emoji} ${verdict_label}. Commits in ${HOURS}h: ${total}. Last ship $(fmt_dur "$last_ship_age_min") ago. Members: ${working_n}/${member_n} working, ${queued_n} queued.

FIX THE TEAM. Concrete steps this whip cycle:
  1. Triage ${blocked_n} blocked + ${inprog_n} in-progress: which are stalled, which need operator decision? Surface decisions to driver-inbox under 🔵 Decisions Needed.
  2. Dispatch top P1 todos to lane-correct members (${todo_n} todo). Lead-lane empty is fine; OTHER lanes idle is not — give them work.
  3. Rotate members with >150k tokens or 60min+ "Crunched for" streaks. Three-at-once is fine, staggered is fine, but don't defer.
  4. If kanban empty AND planner queue empty → surface "Need direction" to driver-inbox (🔵). Do NOT set adaptive-slow-mode.

DO NOT accept dormancy as legitimate. Overnight without an explicit budget-pause means the lead is failing to dispatch, not a legitimate standdown. Members run continuously under auto-mode + rate-limit gates only.
EOM
)

  if ( cd "$root" 2>/dev/null && atmux tell-lead "$body" >/dev/null 2>&1 ); then
    # Persist epoch for dedup on next /bau run.
    mkdir -p "$root/.atmux/state" 2>/dev/null
    echo "$NOW_EPOCH" > "$root/.atmux/state/bau-velocity-fix.epoch" 2>/dev/null
    ESCALATED+=("$team:$NOW_TS")
  else
    SKIPPED+=("$team:tell-lead failed")
  fi
}

if (( BAU_FIX == 1 )); then
  for team in "${TEAM_ORDER[@]}"; do
    [[ "${TEAM_ENABLED[$team]}" == "true" ]] || continue
    velocity_fix_escalate "$team"
  done
fi

# ────────────────────────────────────────────────────────────────────────────
# Section 8 — Emit markdown report
# ────────────────────────────────────────────────────────────────────────────

emit_team_section() {
  local team="$1"
  local dir="$TMPDIR_BAU/$team"

  # Disabled teams render as one-liner stub
  if [[ "${TEAM_ENABLED[$team]}" != "true" ]]; then
    printf '### 💤 `%s` — Disabled · %s · not collected\n\n' \
      "$team" "${TEAM_LABEL[$team]}"
    return
  fi

  # Source analysis
  # shellcheck source=/dev/null
  source "$dir/analysis.env"

  local last_ship_rel
  last_ship_rel=$(rel_time "$last_ship_iso")

  printf '### %s `%s` — %s · %s\n\n' "$verdict_emoji" "$team" "$verdict_label" "${TEAM_LABEL[$team]}"

  # Commits
  printf -- '- **Commits**: %s in %sh' "$total" "$HOURS"
  if [[ -n "$last_ship_sha" ]]; then
    printf ' (last: `%s` %s)' "$last_ship_sha" "$last_ship_rel"
  fi
  [[ -n "$types" ]] && printf ' · types: %s' "$types"
  printf '\n'

  # Churn — net insertions/deletions for the window. Always shown when there
  # were any commits; the "Eternal-improvement" framing only makes sense when
  # reverts > 0 (eternal-improvement = revert-driven self-correction, NOT
  # ordinary forward-progress shipping). Calling forward work "eternal-
  # improvement" implies all commits are improvements over a prior surface,
  # which is misleading on green-field / feature commits.
  if (( total > 0 )); then
    printf -- '- **Churn**: net +%s/-%s' "$net_ins" "$net_del"
    [[ -n "$authors" ]] && printf ' · authors: %s' "$authors"
    printf '\n'
  fi
  # Eternal-improvement — only when actual reverts exist
  if (( reverts > 0 )); then
    local revert_ratio
    revert_ratio=$(( total > 0 ? (reverts * 100) / total : 0 ))
    printf -- '- **Eternal-improvement**: %s reverts (%s%% of %s)\n' \
      "$reverts" "$revert_ratio" "$total"
  fi

  # Lead
  printf -- '- **Lead** (w2): %s' "$lead_state"
  [[ -n "$lead_upmin" ]] && printf ' · uptime %s' "$(fmt_dur "$lead_upmin")"
  [[ -n "$lead_ctx" ]]   && printf ' · %s' "$lead_ctx"
  [[ -n "$lead_tokens" ]] && printf ' · %s' "$lead_tokens"
  printf '\n'

  # Members
  printf -- '- **Members** (w3+): %s working · %s queued (of %s)\n' \
    "$working_n" "$queued_n" "$member_n"

  # Kanban
  printf -- '- **Kanban**: %s todo / %s in-progress / %s done / %s blocked\n' \
    "$todo_n" "$inprog_n" "$done_n" "$blocked_n"

  # Complaints
  if (( complaints_n > 0 )); then
    printf -- '- **Open complaints**: %s' "$complaints_n"
    [[ -n "$complaints_top" ]] && printf ' — top: "%s"' "$complaints_top"
    printf '\n'
  fi

  # Recommended action
  local action
  case "$verdict_label" in
    Rate-Limited)    action="decide: swap account / \`/extra-usage\` / wait for reset" ;;
    Saturated)       action="\`/team rotate-lead\` from cockpit window for \`$team\`" ;;
    Stuck-input)     action="push Enter on $queued_n queued member panes (CLAUDE.md L193)" ;;
    Down)            action="\`atmux start\` in $root + \`atmux cockpit rebuild --no-cycle\`" ;;
    Dormant|Quiescent-stale)
                     if (( BAU_FIX == 1 )); then
                       action="lead escalation queued via \`atmux tell-lead\` — see Step-6 section below for outcome"
                     else
                       action="would escalate to lead — re-run without \`--no-fix\` to fire \`atmux tell-lead\`"
                     fi ;;
    Quiescent-fresh) action="none — let it cook; lead just shipped" ;;
    BAU)             action="none — team shipping" ;;
    *)               action="—" ;;
  esac
  printf -- '- **Action needed**: %s\n' "$action"
  printf '\n'

  # Shipped-features digest (Step 3.5) — only when --digest=on and we have commits
  if [[ "$BAU_DIGEST" == "on" && "$total" -gt 0 ]]; then
    emit_digest "$team"
  fi
}

emit_digest() {
  local team="$1"
  local root="${TEAM_ROOT[$team]}"
  local dir="$TMPDIR_BAU/$team"

  # Collect from both root.txt and subs.txt into normalized lines:
  #   "sha|iso|author|subject|submodule_path"
  local all
  all=$(mktemp -p "$TMPDIR_BAU")
  awk -F'|' 'NF>=4 { printf "%s|%s|%s|%s|\n", $1, $2, $3, $4 }' "$dir/root.txt" 2>/dev/null > "$all"
  awk -F'|' 'NF>=5 { printf "%s|%s|%s|%s|%s\n", $2, $3, $4, $5, $1 }' "$dir/subs.txt" 2>/dev/null >> "$all"

  # Bucket
  local feats fixes adrs others
  feats=$(grep -E '\|feat[(:]' "$all" 2>/dev/null || true)
  fixes=$(grep -E '\|fix[(:]'  "$all" 2>/dev/null || true)
  adrs=$(grep -E '\|docs?\([a-z]*adr' "$all" 2>/dev/null || true)
  others=$(grep -vE '\|(feat|fix)[(:]|\|docs?\([a-z]*adr' "$all" 2>/dev/null || true)

  printf '  **🚢 Shipped — what each commit did (operator-memory aid):**\n\n'

  if [[ -n "$feats" ]]; then
    local n
    n=$(echo "$feats" | wc -l)
    printf '  ✨ **Features** (%s):\n' "$n"
    while IFS='|' read -r sha iso author subj sm; do
      [[ -z "$sha" ]] && continue
      local myt
      myt=$(iso_to_local "$iso")
      if [[ -n "$sm" ]]; then
        printf '  - `%s` %s · [%s] `%s`\n' "$sha" "$myt" "$sm" "$subj"
      else
        printf '  - `%s` %s · `%s`\n' "$sha" "$myt" "$subj"
      fi
    done <<< "$feats"
    printf '\n'
  fi

  if [[ -n "$fixes" ]]; then
    local n
    n=$(echo "$fixes" | wc -l)
    printf '  🛠️ **Fixes** (%s):\n' "$n"
    while IFS='|' read -r sha iso author subj sm; do
      [[ -z "$sha" ]] && continue
      local myt
      myt=$(iso_to_local "$iso")
      if [[ -n "$sm" ]]; then
        printf '  - `%s` %s · [%s] `%s`\n' "$sha" "$myt" "$sm" "$subj"
      else
        printf '  - `%s` %s · `%s`\n' "$sha" "$myt" "$subj"
      fi
    done <<< "$fixes"
    printf '\n'
  fi

  if [[ -n "$adrs" ]]; then
    local n
    n=$(echo "$adrs" | wc -l)
    printf '  📚 **ADRs / docs** (%s):\n' "$n"
    while IFS='|' read -r sha iso author subj sm; do
      [[ -z "$sha" ]] && continue
      local adr_num
      adr_num=$(echo "$subj" | grep -oE 'ADR-?[0-9]{3}' | head -1 | grep -oE '[0-9]{3}')
      if [[ -n "$adr_num" ]]; then
        local title
        title=$(resolve_adr "$root" "$adr_num")
        printf '  - `%s` ADR-%s — %s\n' "$sha" "$adr_num" "${title:-$subj}"
      else
        printf '  - `%s` `%s`\n' "$sha" "$subj"
      fi
    done <<< "$adrs"
    printf '\n'
  fi

  if [[ -n "$others" ]]; then
    local n
    n=$(echo "$others" | wc -l)
    # Scope tally
    local tally
    tally=$(echo "$others" \
      | awk -F'|' '{ msg=$4; if (match(msg, /\([^)]+\)/)) print substr(msg, RSTART+1, RLENGTH-2); else print "other" }' \
      | sort | uniq -c | sort -rn \
      | awk '{ printf "%s(%d), ", $2, $1 }')
    tally="${tally%, }"
    printf '  ♻️ **Refactors / chores / tests** (%s) — scope tally: %s\n\n' "$n" "$tally"
  fi

  rm -f "$all"
}

# ────────────────────────────────────────────────────────────────────────────
# Section 9 — Compose final report
# ────────────────────────────────────────────────────────────────────────────

printf '# /bau — last %sh · %s · scope=%s\n\n' "$HOURS" "$NOW_TS" "$BAU_SCOPE"

if [[ -n "$SCOPE_FALLBACK" ]]; then
  printf '> note: %s\n\n' "$SCOPE_FALLBACK"
fi

if [[ "$BAU_SCOPE" == "all" ]]; then
  # Cockpit-wide verdict — one sentence
  local_summary_parts=()
  for team in "${TEAM_ORDER[@]}"; do
    if [[ "${TEAM_ENABLED[$team]}" != "true" ]]; then
      local_summary_parts+=("$team: disabled")
      continue
    fi
    if [[ -f "$TMPDIR_BAU/$team/analysis.env" ]]; then
      ( source "$TMPDIR_BAU/$team/analysis.env"
        printf '%s: %s (%s commits)\n' "$team" "$verdict_label" "$total"
      )
    fi
  done > "$TMPDIR_BAU/summary.txt"

  printf '## Cockpit-wide verdict\n\n'
  if [[ -s "$TMPDIR_BAU/summary.txt" ]]; then
    while IFS= read -r line; do
      printf -- '- %s\n' "$line"
    done < "$TMPDIR_BAU/summary.txt"
  fi
  printf '\n## Per team\n\n'
fi

for team in "${TEAM_ORDER[@]}"; do
  emit_team_section "$team"
done

# Velocity-fix section
printf '## Velocity-fix escalations (Step 6)\n\n'
if (( BAU_FIX == 0 )); then
  printf -- '_no escalations this run (flag: --no-fix)_\n\n'
elif (( ${#ESCALATED[@]} == 0 && ${#SKIPPED[@]} == 0 )); then
  printf -- '_no teams matched velocity-fix triggers — all 🟢 or excluded by guard_\n\n'
else
  for entry in "${ESCALATED[@]:-}"; do
    [[ -z "$entry" ]] && continue
    IFS=':' read -r t ts <<< "$entry"
    printf -- '- 🔴 `%s` — directive landed in `.atmux/driver-inbox.md` at %s\n' "$t" "$ts"
  done
  for entry in "${SKIPPED[@]:-}"; do
    [[ -z "$entry" ]] && continue
    IFS=':' read -r t reason <<< "$entry"
    printf -- '- 🟡 `%s` — skipped: %s\n' "$t" "$reason"
  done
  printf '\n'
fi

# Cross-cutting (only in all-scope)
if [[ "$BAU_SCOPE" == "all" ]]; then
  # Total open complaints
  local_complaints_total=0
  for team in "${TEAM_ORDER[@]}"; do
    if [[ -f "$TMPDIR_BAU/$team/analysis.env" ]]; then
      ( source "$TMPDIR_BAU/$team/analysis.env"
        echo "$complaints_n"
      )
    fi
  done | awk '{ s+=$1 } END { print s+0 }' > "$TMPDIR_BAU/ct.txt"
  local_complaints_total=$(cat "$TMPDIR_BAU/ct.txt")

  printf '## Cross-cutting\n\n'
  printf -- '- **Open complaints across cockpit**: %s\n' "$local_complaints_total"
  printf '\n'
fi
