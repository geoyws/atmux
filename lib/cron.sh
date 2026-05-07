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

  # E9/Sd t-d2a520d2 (ADR-022 §Decision OQ-D4): teams declaring a
  # `discorder` role member opt out of the legacy `report` cron line and
  # instead get TWO new lines — `*/30 discorder progress` (replaces
  # report's 30-min cadence) + `0 * discorder heartbeat` (hourly fleet
  # heartbeat). Manual `atmux report` invocation still works; only the
  # cron emission switches. jq absent / team.json missing ⇒ legacy
  # 3-line shape (silent fallback, matches the unblocker block below).
  local has_discorder=0
  if command -v jq >/dev/null 2>&1 && [[ -f "$atmux_dir/team.json" ]]; then
    has_discorder=$(jq -r '[.members[]? | select(.role == "discorder")] | length' \
                      "$atmux_dir/team.json" 2>/dev/null || echo 0)
    [[ "$has_discorder" =~ ^[0-9]+$ ]] || has_discorder=0
  fi

  printf '*/5 * * * * %sATMUX_DIR=%s %s whip >> %s/logs/whip.log 2>&1\n'                  "$prefix" "$atmux_dir" "$bin" "$atmux_dir"
  if (( has_discorder > 0 )); then
    printf '*/30 * * * * %sATMUX_DIR=%s %s discorder progress >> %s/logs/discorder-progress.log 2>&1\n'   "$prefix" "$atmux_dir" "$bin" "$atmux_dir"
    printf '0 * * * * %sATMUX_DIR=%s %s discorder heartbeat >> %s/logs/discorder-heartbeat.log 2>&1\n'   "$prefix" "$atmux_dir" "$bin" "$atmux_dir"
  else
    printf '*/30 * * * * %sATMUX_DIR=%s %s report >> %s/logs/report.log 2>&1\n'             "$prefix" "$atmux_dir" "$bin" "$atmux_dir"
  fi
  printf '0 */4 * * * %sATMUX_DIR=%s %s decisions digest >> %s/logs/decisions-digest.log 2>&1\n' "$prefix" "$atmux_dir" "$bin" "$atmux_dir"
  # Daily groom — sweep stale archived inbox/outbox/decisions content +
  # summarize done kanban cards out of the hot file. Fires at 04:00 local
  # to land in the quietest window. Lib/start.sh also fires `atmux groom
  # --quiet` on activation so cron-less hosts (or a brand-new team that
  # hasn't passed its first 04:00 yet) still get a passive sweep.
  printf '0 4 * * * %sATMUX_DIR=%s %s groom --quiet >> %s/logs/groom.log 2>&1\n' "$prefix" "$atmux_dir" "$bin" "$atmux_dir"

  # E9/Sc t-be778e9e (ADR-021): teams with a declared 'unblocker' role
  # member get a 2-min `unblocker tick` cron line. Reads team.json
  # role-list directly so adding/removing the unblocker member via
  # add-member/remove-member surfaces in the next install. jq absent or
  # team.json missing ⇒ silent skip (matches the cron_install
  # best-effort posture). TMUX_TMPDIR prefix inherited so cron-fired
  # ticks see the team's isolated socket per E8/Sc.
  if command -v jq >/dev/null 2>&1 && [[ -f "$atmux_dir/team.json" ]]; then
    local has_unblocker
    has_unblocker=$(jq -r '[.members[]? | select(.role == "unblocker")] | length' \
                      "$atmux_dir/team.json" 2>/dev/null || echo 0)
    [[ "$has_unblocker" =~ ^[0-9]+$ ]] || has_unblocker=0
    if (( has_unblocker > 0 )); then
      printf '*/2 * * * * %sATMUX_DIR=%s %s unblocker tick >> %s/logs/unblocker.log 2>&1\n' \
        "$prefix" "$atmux_dir" "$bin" "$atmux_dir"
    fi
  fi
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

# Drop ANY marker-bounded block whose body contains ATMUX_DIR=<atmux_dir>,
# regardless of team name in the marker. Stream filter; no I/O. Used by
# install to catch rename-orphans (block written under team's PRIOR name,
# pointing at the SAME atmux_dir as the current team) before re-emitting.
# Without this dedupe, a team rename leaves two blocks firing the same
# `atmux whip` concurrently against one cage — observed to crash tmux
# servers under load (2026-05-06).
_atmux_cron_strip_by_atmux_dir() {
  local atmux_dir="$1"
  awk -v dir="$atmux_dir" '
    BEGIN { in_block = 0; buf_count = 0; match_dir = 0 }
    /^# >>> atmux:team=/ {
      in_block = 1; buf_count = 0; match_dir = 0
      buf[buf_count++] = $0
      next
    }
    in_block && /^# <<< atmux:team=/ {
      buf[buf_count++] = $0
      if (!match_dir) {
        for (i = 0; i < buf_count; i++) print buf[i]
      }
      in_block = 0; buf_count = 0; match_dir = 0
      next
    }
    in_block {
      buf[buf_count++] = $0
      if (index($0, "ATMUX_DIR=" dir " ") > 0 || index($0, "ATMUX_DIR=" dir "\t") > 0) {
        match_dir = 1
      }
      next
    }
    { print }
  '
}

# Drop atmux verb lines (whip/report/decisions/groom/discorder/unblocker)
# that are NOT inside a marker block. Pre-marker eras of atmux wrote bare
# cron lines; they remain orphaned forever unless explicitly scrubbed.
_atmux_cron_strip_orphan_lines() {
  awk '
    /^# >>> atmux:team=/ { in_block = 1; print; next }
    /^# <<< atmux:team=/ { in_block = 0; print; next }
    in_block { print; next }
    /atmux (whip|report|decisions|groom|discorder|unblocker)([[:space:]]|$)/ { next }
    { print }
  '
}

# Prepend SHELL/PATH/TERM env preamble if the crontab has any atmux:team=
# block(s) and the preamble is not already present. Cron's bare env (no TERM,
# narrow PATH) causes tmux 3.5a to segfault when invoked from atmux verbs.
_atmux_cron_ensure_env_preamble() {
  local body
  body="$(cat)"
  if grep -q '^# >>> atmux:team=' <<<"$body" && ! grep -q '^TERM=xterm-256color$' <<<"$body"; then
    printf '# ─── env for atmux cron (avoids tmux segfaults from bare cron env) ───\n'
    printf 'SHELL=/bin/bash\n'
    printf 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n'
    printf 'TERM=xterm-256color\n\n'
  fi
  printf '%s' "$body"
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
  # Strip in three passes (order matters):
  #  1. Block matching this team's CURRENT name  — idempotent re-install.
  #  2. Block matching this team's atmux_dir under any OTHER name — catches
  #     rename-orphans (e.g. `ifca_sopx` → `sopx` leaves an `ifca_sopx`
  #     block pointing at the same dir, firing duplicate `atmux whip`).
  #  3. Bare atmux verb lines outside any marker — pre-marker orphans.
  # Compounded by cron's bare env (no TERM/PATH), the resulting concurrent
  # whip storm has been observed to crash cage tmux servers (2026-05-06).
  stripped="$(printf '%s\n' "$current" \
    | _atmux_cron_strip_block "$team" \
    | _atmux_cron_strip_by_atmux_dir "$atmux_dir" \
    | _atmux_cron_strip_orphan_lines)"
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

  # Idempotent env preamble: prepended only if at least one atmux:team=
  # block exists in the new output and the preamble isn't already present.
  # Addresses cron-bare-env tmux segfaults observed 2026-05-06.
  out="$(printf '%s' "$out" | _atmux_cron_ensure_env_preamble)"

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
