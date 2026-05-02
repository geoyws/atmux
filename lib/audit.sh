#!/usr/bin/env bash
# lib/audit.sh — `atmux audit` declarative-vs-live drift detector (ADR-038).
#
# Per-class detector + (Sc/Sd-deferred) fixer pairs. Each detector returns
# 0 (clean / no drift) or 1 (drift) and emits a finding object via
# _atmux_audit_emit. Findings are aggregated into `_atmux_audit_findings`
# (a JSON array) and rendered in human or JSON shape at the end of main.
#
# Sb scope: detect-only. Class A–F detectors land here; class F is a stub
# that always returns 0 (deferred to Sk per AC). The --fix flag is
# accepted but errors out as not-yet-implemented; Sc/Sd land the per-class
# fixer functions and wire dispatch_action to fire them.
#
# Verb surface (per ADR-038 §atmux audit verb surface):
#
#   atmux audit [--quiet] [--fix [--class <a|b|c|d|e|f|all>]] [--json] [--dry-run]
#
#   no flag    → human render of findings; exit 0 always.
#   --quiet    → suppress output; exit 0 on green, 1 on any drift
#                (whip sub-pass shape).
#   --json     → JSON array of finding objects (schema in ADR-038).
#   --fix      → Sc/Sd; Sb errors out.
#   --dry-run  → print fix plan; default for blast≥medium classes.
#
# Reuses: atmux::registry_list, atmux::team_json, atmux::capture_pane,
# tmux list-windows. TMUX_TMPDIR is already exported by bin/atmux from
# team.json:.tmuxTmpdir before this lib sources, so per-team tmux calls
# automatically route to the team's cage socket.

# shellcheck source=registry.sh
. "$ATMUX_LIB_DIR/registry.sh"

# Per-class metadata (severity / blast / auto-fixable). Looked up by the
# emit helper so detectors only need to pass the class letter + detail +
# fix_hint; the rest of the schema is filled in here.
declare -gA _ATMUX_AUDIT_SEVERITY=(
  [A]=medium [B]=high [C]=high [D]=low [E]=low [F]=low
)
declare -gA _ATMUX_AUDIT_BLAST=(
  [A]=medium [B]=high [C]=high [D]=low [E]=low [F]=low
)
declare -gA _ATMUX_AUDIT_AUTO_FIXABLE=(
  # Class A is "conditional" per ADR-038 (gated on driver-pane idle).
  # Schema field is boolean, so the conditional gating lives in the
  # fixer's pre-check; the JSON emits `false` to keep external readers
  # honest about whether the fixer can run unattended.
  [A]=false [B]=false [C]=false [D]=true [E]=true [F]=true
)

# Findings accumulator. Reset on every `main` invocation. Top-level so
# the detect helpers can append without threading a name reference.
declare -ga _atmux_audit_findings=()

main() {
  atmux::require jq

  local quiet=0 json=0 fix=0 dry_run=0
  local class_filter="all"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --quiet)   quiet=1; shift ;;
      --json)    json=1; shift ;;
      --fix)     fix=1; shift ;;
      --dry-run) dry_run=1; shift ;;
      --class)
        class_filter="${2:-}"
        [[ -n "$class_filter" ]] || atmux::die "audit: --class requires a value (a|b|c|d|e|f|all)"
        shift 2
        ;;
      --class=*) class_filter="${1#--class=}"; shift ;;
      -h|--help) _atmux_audit_usage; return 0 ;;
      *) atmux::die "audit: unknown arg: $1" ;;
    esac
  done

  case "$class_filter" in
    a|b|c|d|e|f|all) ;;
    *) atmux::die "audit: --class must be one of {a,b,c,d,e,f,all}" ;;
  esac

  # Sb is detect-only. --fix lands in Sc/Sd; refuse early so operators
  # don't think a fix happened when nothing did.
  if [[ "$fix" -eq 1 ]]; then
    atmux::die "audit: --fix is not yet implemented (deferred to Sc/Sd per ADR-038); use detect-only or atmux audit --json | jq for triage"
  fi
  if [[ "$dry_run" -eq 1 ]]; then
    atmux::die "audit: --dry-run is paired with --fix and not yet implemented (Sc/Sd)"
  fi

  _atmux_audit_findings=()

  # Class A–D + F are team-scoped → require a team context. Class E is
  # filesystem-wide → runs even without a team. We tolerate audits run
  # outside any team dir (e.g. enforcer agent's fleet walk) by gating
  # team-scoped detectors on team availability.
  local have_team=0
  if atmux::dir >/dev/null 2>&1 && [[ -f "$(atmux::team_json 2>/dev/null)" ]]; then
    have_team=1
  fi

  if (( have_team )); then
    case "$class_filter" in
      a|all) _atmux_audit_class_a_detect || true ;;
    esac
    case "$class_filter" in
      b|all) _atmux_audit_class_b_detect || true ;;
    esac
    case "$class_filter" in
      c|all) _atmux_audit_class_c_detect || true ;;
    esac
    case "$class_filter" in
      d|all) _atmux_audit_class_d_detect || true ;;
    esac
    case "$class_filter" in
      f|all) _atmux_audit_class_f_detect || true ;;
    esac
  fi

  case "$class_filter" in
    e|all) _atmux_audit_class_e_detect || true ;;
  esac

  # Dispatcher hook — Sc/Sd will route findings to fixers. Today it's
  # render-only.
  _atmux_audit_dispatch_action

  local n=${#_atmux_audit_findings[@]}
  if [[ "$quiet" -eq 1 ]]; then
    (( n == 0 )) && return 0 || return 1
  fi
  if [[ "$json" -eq 1 ]]; then
    _atmux_audit_render_json
  else
    _atmux_audit_render_human
  fi
}

_atmux_audit_usage() {
  cat <<'EOF'
atmux audit [--quiet] [--fix [--class <a|b|c|d|e|f|all>]] [--json] [--dry-run]

  Detect declarative-vs-live drift across class A–F (per ADR-038):

    A  driver-window naming        bare 'driver' instead of '__<team>__driver'
    B  cage path separator         /tmp/atmux-tmux-* (old hyphen form)
    C  window position drift       driver != index 1, lead != index 2
    D  rename residue              window name has trailing dash/underscore
    E  stray empty cage dirs       /tmp/atmux*tmux*<dir> with no socket + no registry entry
    F  tmux config glyph mismatch  per-cage status-left ≠ ~/.tmux.conf expansion (Sk)

  Flags:
    --quiet       suppress output; exit 1 on any drift, 0 on green (whip sub-pass).
    --fix         Sc/Sd (not implemented in Sb).
    --class C     narrow detection / fix scope to one class.
    --json        emit findings array per ADR-038 schema.
    --dry-run     print fix plan; default for blast≥medium classes.
EOF
}

# Append one finding to the accumulator. Caller passes class letter +
# detail + fix_hint; severity / blast / auto_fixable are looked up from
# the per-class metadata maps. team is captured at emit time so a fleet
# walk that switches contexts gets the right value.
_atmux_audit_emit() {
  local class="$1" detail="$2" fix_hint="$3"
  local severity="${_ATMUX_AUDIT_SEVERITY[$class]:-unknown}"
  local blast="${_ATMUX_AUDIT_BLAST[$class]:-unknown}"
  local auto_fixable="${_ATMUX_AUDIT_AUTO_FIXABLE[$class]:-false}"

  local team=""
  if atmux::dir >/dev/null 2>&1 && [[ -f "$(atmux::team_json 2>/dev/null)" ]]; then
    team="$(atmux::team_name 2>/dev/null || echo "")"
  fi

  local obj
  obj="$(jq -nc \
    --arg class "$class" \
    --arg severity "$severity" \
    --arg team "$team" \
    --arg detail "$detail" \
    --arg fix_hint "$fix_hint" \
    --argjson auto_fixable "$auto_fixable" \
    --arg blast_radius "$blast" \
    '{class:$class, severity:$severity, team:$team, detail:$detail,
      fix_hint:$fix_hint, auto_fixable:$auto_fixable, blast_radius:$blast_radius}')"
  _atmux_audit_findings+=("$obj")
}

# ---- Class A: bare 'driver' window without __<team>__ prefix ----------
#
# Per ADR-038 §taxonomy: a window literally named "driver" rather than
# "__<team>__driver" indicates the start.sh hook ran without the
# always-prefix discipline (or someone hand-renamed). This is medium
# blast because a fix is a single tmux rename-window, but it touches the
# operator's own active session — autofix is gated on driver-pane idle
# (Sc/Sd land that gate; Sb just detects).
_atmux_audit_class_a_detect() {
  local session; session="$(atmux::session_name 2>/dev/null || echo "")"
  [[ -n "$session" ]] || return 0

  if ! atmux::tmux_session_exists; then
    return 0
  fi

  local team; team="$(atmux::team_name)"
  local hits
  hits="$(tmux list-windows -t "=$session" -F '#{window_name}' 2>/dev/null \
            | grep -xE 'driver' || true)"
  if [[ -n "$hits" ]]; then
    _atmux_audit_emit A \
      "driver window named 'driver' (expected '__${team}__driver')" \
      "atmux audit --fix --class a (gated on driver-pane idle)"
    return 1
  fi
  return 0
}

# ---- Class B: cage path separator using old hyphen form ---------------
#
# /tmp/atmux-tmux-<team> is the pre-2026-04 form; underscore-separated
# /tmp/atmux_tmux_<team> is canonical (per ADR-018 + ADR-027 ADDENDUM 11).
# Detector reads team.json:.tmuxTmpdir and matches /tmp/atmux-tmux-*.
# Mismatch on convention is high-blast (mv'ing a live cage tmpdir while
# panes are running needs the team-repair-rename verb's atomic flow);
# never auto-fixed.
_atmux_audit_class_b_detect() {
  local tj; tj="$(atmux::team_json 2>/dev/null || true)"
  [[ -f "$tj" ]] || return 0
  local tmpdir
  tmpdir="$(jq -r '.tmuxTmpdir // empty' "$tj" 2>/dev/null || true)"
  [[ -z "$tmpdir" || "$tmpdir" == "null" ]] && return 0
  if [[ "$tmpdir" =~ ^/tmp/atmux-tmux- ]]; then
    local team; team="$(atmux::team_name)"
    _atmux_audit_emit B \
      "team.json:.tmuxTmpdir uses hyphen-form '$tmpdir' (canonical: /tmp/atmux_tmux_${team})" \
      "atmux team repair-rename ${team} (atomic mv + session/window rename + cron rewrite)"
    return 1
  fi
  return 0
}

# ---- Class C: window position drift -----------------------------------
#
# Per CLAUDE.md global "Team Roles & Driver Mode": position 1 = driver,
# position 2 = team-lead. Detection runs through tmux list-windows -t
# <session> -F '#{window_index} #{window_name}'. We accept either bare
# 'driver' or '__<team>__driver' for position 1 (class A overlap is fine
# — the driver-window-naming finding is a separate row). Lead detection
# matches '__<team>__*lead' (the emoji glyph between '__' and 'lead' is
# variable per ADR-030 emoji slots).
_atmux_audit_class_c_detect() {
  if ! atmux::tmux_session_exists; then
    return 0
  fi

  local session team
  session="$(atmux::session_name)"
  team="$(atmux::team_name)"

  local windows_tsv
  windows_tsv="$(tmux list-windows -t "=$session" \
                  -F '#{window_index}	#{window_name}' 2>/dev/null || true)"
  [[ -n "$windows_tsv" ]] || return 0

  local drift=0

  # Position 1 must be the driver pane.
  local idx1_name
  idx1_name="$(awk -F'\t' '$1 == "1" {print $2; exit}' <<<"$windows_tsv")"
  if [[ -n "$idx1_name" \
         && "$idx1_name" != "driver" \
         && "$idx1_name" != "__${team}__driver" ]]; then
    _atmux_audit_emit C \
      "window-position 1 is '$idx1_name' (expected driver pane: 'driver' or '__${team}__driver')" \
      "tmux swap-window -s '$session:$idx1_name' -t '$session:1' after relocating driver"
    drift=1
  fi

  # Position 2 must be the team-lead pane. Match '__<team>__<emoji>lead'
  # OR a bare 'lead' suffix without prefix (legacy non-cage'd teams).
  local idx2_name
  idx2_name="$(awk -F'\t' '$1 == "2" {print $2; exit}' <<<"$windows_tsv")"
  if [[ -n "$idx2_name" ]]; then
    if [[ "$idx2_name" != __${team}__*lead && "$idx2_name" != "lead" ]]; then
      _atmux_audit_emit C \
        "window-position 2 is '$idx2_name' (expected lead pane: '__${team}__<emoji>lead')" \
        "tmux swap-window -t '$session:2' (target the lead pane's current index)"
      drift=1
    fi
  fi

  (( drift )) && return 1 || return 0
}

# ---- Class D: window name has trailing dash / underscore --------------
#
# Pattern: __<team>__<rest>(-+|_+)$ — trailing punctuation residue from
# a partial rename or a typo. Cheap to fix (tmux rename-window strips
# the suffix); low-blast because it's pure metadata.
_atmux_audit_class_d_detect() {
  if ! atmux::tmux_session_exists; then
    return 0
  fi

  local session team
  session="$(atmux::session_name)"
  team="$(atmux::team_name)"

  local hits
  hits="$(tmux list-windows -t "=$session" -F '#{window_name}' 2>/dev/null \
           | grep -E "^__${team}__.*[-_]+$" || true)"

  if [[ -z "$hits" ]]; then
    return 0
  fi

  local drift=0 wname stripped
  while IFS= read -r wname; do
    [[ -z "$wname" ]] && continue
    # Strip the team prefix, then peel trailing dashes/underscores from
    # the tail. Portable strip loop (no extglob dep) is fine — names are
    # short.
    local tail="${wname#__"${team}"__}"
    while [[ "$tail" == *[-_] ]]; do tail="${tail%[-_]}"; done
    stripped="__${team}__${tail}"

    _atmux_audit_emit D \
      "window '$wname' has trailing punctuation residue (canonical: '$stripped')" \
      "tmux rename-window -t '$session:$wname' '$stripped'"
    drift=1
  done <<< "$hits"

  (( drift )) && return 1 || return 0
}

# ---- Class E: stray empty cage dirs -----------------------------------
#
# Filesystem-scope detector. Walks /tmp/atmux-tmux-* + /tmp/atmux_tmux_*,
# flags any directory that has NO live tmux socket inside AND does not
# match any registered team's `tmuxTmpdir`. Low-blast — rmdir with a
# `[ -z "$(ls -A)" ]` guard is the fix.
_atmux_audit_class_e_detect() {
  local registered_tmpdirs
  registered_tmpdirs="$(_atmux_audit_registered_tmpdirs)"

  # $ATMUX_AUDIT_TMP_ROOT lets tests + sandboxed callers point the scan
  # at an isolated tmpdir; defaults to /tmp for the operator-facing path.
  local tmp_root="${ATMUX_AUDIT_TMP_ROOT:-/tmp}"

  local drift=0 dir
  for dir in "$tmp_root"/atmux-tmux-* "$tmp_root"/atmux_tmux_*; do
    [[ -d "$dir" ]] || continue

    # Live socket inside? tmux's per-cage socket lives at
    # <tmpdir>/tmux-<uid>/default. If a socket exists we skip — even an
    # idle session with no clients is a live cage.
    local has_socket=0
    local sock
    for sock in "$dir"/tmux-*/default; do
      if [[ -S "$sock" ]]; then
        has_socket=1
        break
      fi
    done
    (( has_socket )) && continue

    # Registered? Compare against each team's declared tmuxTmpdir.
    if grep -qxF -- "$dir" <<<"$registered_tmpdirs"; then
      continue
    fi

    _atmux_audit_emit E \
      "stray cage tmpdir '$dir' (no live socket + no registry entry)" \
      "rmdir --ignore-fail-on-non-empty '$dir' (after manual ls -A check)"
    drift=1
  done

  (( drift )) && return 1 || return 0
}

# Helper: emit one tmuxTmpdir per line, one for every registered team
# that declares one. Used by class E to identify "registered" dirs.
# Empty / null fields (legacy teams without cage isolation) are skipped.
_atmux_audit_registered_tmpdirs() {
  local r; r="$(atmux::registry_path 2>/dev/null || true)"
  [[ -f "$r" ]] || return 0

  # Walk every registered team's project root → load its team.json →
  # read tmuxTmpdir. Registry doesn't store tmpdir directly so we have
  # to follow projectRoot. Best-effort: missing team.json or unreadable
  # files just skip.
  local proj
  while IFS= read -r proj; do
    [[ -z "$proj" ]] && continue
    local tj="$proj/.atmux/team.json"
    [[ -f "$tj" ]] || continue
    local val
    val="$(jq -r '.tmuxTmpdir // empty' "$tj" 2>/dev/null || true)"
    [[ -z "$val" || "$val" == "null" ]] && continue
    printf '%s\n' "$val"
  done < <(jq -r '.[]?.projectRoot // empty' "$r" 2>/dev/null || true)
}

# ---- Class F: tmux config glyph mismatch (deferred to Sk) -------------
#
# Sk (separate Story per ADR-038 §Consequences) lands the tmux-conf-
# restore primitive + the byte-equality detection logic. Sb stub returns
# clean so the dispatcher can call it unconditionally without erroring.
# When Sk lands, replace this body with the per-cage status-left compare.
_atmux_audit_class_f_detect() {
  return 0
}

# ---- Render: human + JSON --------------------------------------------

_atmux_audit_render_human() {
  local n=${#_atmux_audit_findings[@]}
  if (( n == 0 )); then
    printf '✅ atmux audit: no drift detected\n'
    return 0
  fi
  printf '🩹 atmux audit: %d drift(s)\n\n' "$n"
  printf '  %-5s %-8s %-12s  %s\n' "CLASS" "SEVERITY" "TEAM" "DETAIL — FIX-HINT"
  printf '  %-5s %-8s %-12s  %s\n' "-----" "--------" "----" "-----------------"
  local f
  for f in "${_atmux_audit_findings[@]}"; do
    local class severity team detail fix_hint
    class="$(jq -r '.class' <<<"$f")"
    severity="$(jq -r '.severity' <<<"$f")"
    team="$(jq -r '.team' <<<"$f")"
    detail="$(jq -r '.detail' <<<"$f")"
    fix_hint="$(jq -r '.fix_hint' <<<"$f")"
    printf '  %-5s %-8s %-12s  %s\n' "$class" "$severity" "${team:--}" "$detail"
    printf '  %-5s %-8s %-12s    ↳ %s\n' "" "" "" "$fix_hint"
  done
}

_atmux_audit_render_json() {
  if [[ "${#_atmux_audit_findings[@]}" -eq 0 ]]; then
    printf '[]\n'
    return 0
  fi
  printf '%s\n' "${_atmux_audit_findings[@]}" | jq -s '.'
}

# Dispatcher hook. Sc/Sd land per-class fixer routing here. Today it's a
# no-op so the main flow has a fixed shape regardless of the Story that
# wires the action surface.
_atmux_audit_dispatch_action() {
  return 0
}
