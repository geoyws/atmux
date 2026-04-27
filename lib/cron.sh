#!/usr/bin/env bash
# lib/cron.sh — managed crontab block for an atmux team.
#
# Public API consumed by lib/start.sh / lib/stop.sh / lib/doctor.sh:
#   atmux::cron_install <team> <atmux_dir>
#   atmux::cron_remove  <team>
#   atmux::cron_orphans
#
# Marker scheme: each team's three managed lines (whip, report, decisions
# digest) are bounded by a header `# >>> atmux:team=<name>` and footer
# `# <<< atmux:team=<name>`. Install replaces any existing block for the
# same team — idempotent: re-running yields byte-identical crontab.
# Removal nukes the block. Both ops route through a mktemp + `crontab
# <tmpfile>` swap so we never invoke interactive `crontab -e`.
#
# Webhook intentionally NOT inlined in the cron lines — runtime resolution
# via team.discord.webhook keeps the secret out of `crontab -l` dumps and
# lets webhook rotation work without re-installing the cron block.
#
# E6/Sc t-7dab9a96.

# Resolve the atmux binary path baked into cron lines. Per-host: cron runs
# without the user's PATH, so we capture the absolute path now and lock it
# in. ATMUX_BIN env override wins (test sandboxes, multi-version setups);
# `command -v atmux` is the production fallback. Empty result ⇒ caller
# must install atmux first; cron_install warns + bails.
_atmux_cron_resolve_bin() {
  if [[ -n "${ATMUX_BIN:-}" ]] && [[ -x "$ATMUX_BIN" ]]; then
    printf '%s\n' "$ATMUX_BIN"
    return 0
  fi
  local bin
  bin="$(command -v atmux 2>/dev/null || true)"
  [[ -n "$bin" ]] && printf '%s\n' "$bin"
}

# Render the 3-line cron block (no markers) for a team rooted at <atmux_dir>.
# Schedules are baked here; future ADR can plumb team.json overrides.
#
# E8/Sc t-d49032e2 (ADR-018): when <tmuxTmpdir> is non-empty, the cron
# lines prepend `TMUX_TMPDIR=<value> ` so cron-fired whip/report/decisions
# digest invocations land on the team's isolated tmux socket. Without
# this, `atmux::session_name`-resolved sessions live on a different
# socket than what cron sees, and whip reports session DOWN forever.
_atmux_cron_render_lines() {
  local atmux_dir="$1" bin="$2" tmuxtmpdir="${3:-}"
  local prefix=""
  [[ -n "$tmuxtmpdir" ]] && prefix="TMUX_TMPDIR=$tmuxtmpdir "
  printf '*/5 * * * * %sATMUX_DIR=%s %s whip >> %s/logs/whip.log 2>&1\n'                  "$prefix" "$atmux_dir" "$bin" "$atmux_dir"
  printf '*/30 * * * * %sATMUX_DIR=%s %s report >> %s/logs/report.log 2>&1\n'             "$prefix" "$atmux_dir" "$bin" "$atmux_dir"
  printf '0 */4 * * * %sATMUX_DIR=%s %s decisions digest >> %s/logs/decisions-digest.log 2>&1\n' "$prefix" "$atmux_dir" "$bin" "$atmux_dir"
}

# Drop the marker-bounded block (header + body + footer) for <team> from
# stdin, echoing the residual crontab on stdout. Pure stream filter — no
# I/O. Used by both install (to dedupe before append) and remove.
_atmux_cron_strip_block() {
  local team="$1"
  awk -v team="$team" '
    BEGIN { in_block = 0 }
    {
      if ($0 == "# >>> atmux:team=" team " — managed by atmux start; do not edit by hand") {
        in_block = 1
        next
      }
      if (in_block && $0 == "# <<< atmux:team=" team) {
        in_block = 0
        next
      }
      if (!in_block) print
    }
  '
}

# atmux::cron_install <team> <atmux_dir>
#
# Idempotent: re-running on an already-installed team yields a byte-identical
# crontab. Atomic: writes the new crontab to a tmpfile and swaps via
# `crontab <file>` so `crontab -l` never observes a torn state.
atmux::cron_install() {
  local team="$1" atmux_dir="$2"
  [[ -n "$team"      ]] || atmux::die "cron_install: <team> required"
  [[ -n "$atmux_dir" ]] || atmux::die "cron_install: <atmux_dir> required"

  # ATMUX_NO_CRON=1 (or any non-empty truthy value) disables cron writes
  # entirely. Used by test sandboxes + operators who manage cron out-of-band.
  # Quiet by default — surfaces only when ATMUX_DEBUG is set so test runs
  # don't get spammed. Companion atmux::cron_remove still runs unconditionally
  # (cleanup ops are the safety-net path; gating them would leave residue).
  case "${ATMUX_NO_CRON:-}" in
    ''|0|false|FALSE|False) ;;
    *)
      [[ -n "${ATMUX_DEBUG:-}" ]] && \
        printf 'cron_install: ATMUX_NO_CRON set, no-op\n' >&2
      return 0
      ;;
  esac

  if ! command -v crontab >/dev/null 2>&1; then
    atmux::warn "cron_install: crontab not on PATH — skipping (install crond to enable scheduled whip/report/digest)"
    return 0
  fi

  local bin
  bin="$(_atmux_cron_resolve_bin)"
  if [[ -z "$bin" ]]; then
    atmux::warn "cron_install: cannot resolve atmux binary path — skipping"
    return 0
  fi

  # E8/Sc t-d49032e2 (ADR-018): if team.json declares an isolated tmux
  # socket, propagate it into every emitted cron line. Empty / missing /
  # malformed team.json → no prefix (legacy behaviour). jq absent ⇒
  # silent no-op for the same reason cron_install tolerates a bare
  # crontab missing — schedule features are best-effort.
  local tmuxtmpdir=""
  if command -v jq >/dev/null 2>&1 && [[ -f "$atmux_dir/team.json" ]]; then
    tmuxtmpdir="$(jq -r '.tmuxTmpdir // empty' "$atmux_dir/team.json" 2>/dev/null)"
    [[ "$tmuxtmpdir" == "null" ]] && tmuxtmpdir=""
  fi

  local current
  current="$(crontab -l 2>/dev/null || true)"

  local stripped
  stripped="$(printf '%s\n' "$current" | _atmux_cron_strip_block "$team")"
  # `crontab -l` returning empty produces a single newline through printf;
  # collapse to truly empty so the assembled output doesn't lead with one.
  [[ "$stripped" == $'\n' ]] && stripped=""

  local block
  block="# >>> atmux:team=$team — managed by atmux start; do not edit by hand"$'\n'
  block+="$(_atmux_cron_render_lines "$atmux_dir" "$bin" "$tmuxtmpdir")"$'\n'
  block+="# <<< atmux:team=$team"

  local out
  if [[ -n "$stripped" ]]; then
    # Ensure exactly one trailing newline on the prior body before appending.
    out="${stripped%$'\n'}"$'\n'"$block"$'\n'
  else
    out="$block"$'\n'
  fi

  local tmp; tmp="$(mktemp /tmp/atmux-cron-XXXXXX)"
  printf '%s' "$out" > "$tmp"
  if ! crontab "$tmp"; then
    rm -f "$tmp"
    atmux::warn "cron_install: crontab swap failed — manual install required"
    return 1
  fi
  rm -f "$tmp"
}

# atmux::cron_remove <team>
#
# Drop the marker-bounded block for <team>. No-op if the block is absent.
# Atomic via mktemp + `crontab <file>` (no `crontab -e`). Returns 0 even
# when crontab is missing (consistent with install — schedule features are
# best-effort overall).
atmux::cron_remove() {
  local team="$1"
  [[ -n "$team" ]] || atmux::die "cron_remove: <team> required"

  if ! command -v crontab >/dev/null 2>&1; then
    return 0
  fi

  local current
  current="$(crontab -l 2>/dev/null || true)"
  [[ -z "$current" ]] && return 0

  local stripped
  stripped="$(printf '%s\n' "$current" | _atmux_cron_strip_block "$team")"

  # Nothing changed → no-op (avoids a needless crontab swap which can
  # bump the mtime + trip cron-config detectors).
  if [[ "$stripped" == "$current"$'\n' || "$stripped" == "$current" ]]; then
    return 0
  fi

  local tmp; tmp="$(mktemp /tmp/atmux-cron-XXXXXX)"
  printf '%s' "$stripped" > "$tmp"
  if ! crontab "$tmp"; then
    rm -f "$tmp"
    atmux::warn "cron_remove: crontab swap failed"
    return 1
  fi
  rm -f "$tmp"
}

# atmux::cron_orphans
#
# Walk every marker-bounded block in the current crontab and return a
# JSON array of `{team, atmux_dir}` records for blocks whose ATMUX_DIR
# path doesn't exist on disk. Doctor consumes this to surface
# `cron-config` yellow rows for projects that have moved or been deleted.
# Empty array when crontab missing / empty / all live.
atmux::cron_orphans() {
  if ! command -v crontab >/dev/null 2>&1; then
    printf '[]\n'
    return 0
  fi
  local current
  current="$(crontab -l 2>/dev/null || true)"
  if [[ -z "$current" ]]; then
    printf '[]\n'
    return 0
  fi

  # Walk header lines, capture team name + first ATMUX_DIR=<path> in the
  # block body, emit only when the path doesn't resolve. Keeps state
  # entirely in awk — bash glue only formats the JSON tail.
  local rows
  rows="$(awk '
    /^# >>> atmux:team=/ {
      # Header: "# >>> atmux:team=<name> — managed by atmux start; do not edit by hand"
      # Capture <name> verbatim — survives spaces/dashes by anchoring on the suffix.
      header = $0
      sub(/^# >>> atmux:team=/, "", header)
      sub(/ — managed by atmux start; do not edit by hand$/, "", header)
      team = header
      atmux_dir = ""
      in_block = 1
      next
    }
    in_block && /^# <<< atmux:team=/ {
      if (team != "" && atmux_dir != "") {
        printf "%s\t%s\n", team, atmux_dir
      }
      team = ""; atmux_dir = ""; in_block = 0
      next
    }
    in_block && /ATMUX_DIR=/ {
      if (atmux_dir == "") {
        line = $0
        sub(/^.*ATMUX_DIR=/, "", line)
        sub(/[[:space:]].*$/, "", line)
        atmux_dir = line
      }
    }
  ' <<<"$current")"

  if [[ -z "$rows" ]]; then
    printf '[]\n'
    return 0
  fi

  local jq_in='[]' team atmux_dir
  while IFS=$'\t' read -r team atmux_dir; do
    [[ -z "$team" ]] && continue
    if [[ ! -d "$atmux_dir" ]]; then
      jq_in="$(jq -c --arg t "$team" --arg d "$atmux_dir" \
        '. + [{team: $t, atmux_dir: $d}]' <<<"$jq_in")"
    fi
  done <<< "$rows"
  printf '%s\n' "$jq_in"
}
