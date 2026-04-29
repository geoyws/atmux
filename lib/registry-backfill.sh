#!/usr/bin/env bash
# atmux registry-backfill [--dry-run] [--team <name>]
#
# Per ADR-030 §Backfill — for each running team, walk live tmux windows
# and persist any emoji glyphs already present in the window names into
# the registry. Idempotent: atmux::registry_set_emoji is immutable-
# once-written (silent no-op when a slot is already populated), so this
# verb is safe to re-run. Use after upgrading from a pre-ADR-030 atmux
# release where emojis lived only in team.json — running teams keep their
# windows; this verb teaches the registry about them without restarts.

# shellcheck source=registry.sh
. "$ATMUX_LIB_DIR/registry.sh"

main() {
  atmux::require jq tmux

  local dry_run=0 only_team=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) dry_run=1; shift ;;
      --team)    only_team="${2:-}"; shift 2 ;;
      -h|--help)
        cat <<'EOF'
atmux registry-backfill — persist emoji glyphs from live tmux windows into the registry.

Usage: atmux registry-backfill [--dry-run] [--team <name>]

  --dry-run   print what WOULD be persisted; no writes.
  --team <n>  backfill a single team only (default: every running team).

Per ADR-030 §Backfill. Idempotent — already-set emoji slots are preserved.
EOF
        return 0 ;;
      *) atmux::die "registry-backfill: unknown arg: $1" ;;
    esac
  done

  local rj; rj="$(atmux::registry_list --json 2>/dev/null || echo '[]')"
  jq -e . <<<"$rj" >/dev/null 2>&1 || atmux::die "registry-backfill: registry not parseable"
  [[ "$(jq 'length' <<<"$rj")" -gt 0 ]] || { atmux::log "registry-backfill: registry empty, nothing to do"; return 0; }

  local persisted=0 skipped=0 unmatched=0 legacy=0
  local entry team session proj
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    team="$(jq -r '.name'                 <<<"$entry")"
    session="$(jq -r '.sessionName // ""' <<<"$entry")"
    proj="$(jq -r '.projectRoot'          <<<"$entry")"
    [[ -n "$only_team" && "$team" != "$only_team" ]] && continue
    [[ -z "$team" || -z "$session" ]] && continue
    [[ "$(jq -r '.status // ""' <<<"$entry")" == "running" ]] || continue

    if ! tmux has-session -t "=$session" 2>/dev/null; then
      atmux::warn "registry-backfill: $team session=$session absent, skipping"
      continue
    fi

    local tj="$proj/.atmux/team.json"
    if [[ ! -f "$tj" ]]; then
      atmux::warn "registry-backfill: $team has no team.json at $tj, skipping"
      continue
    fi

    # Sort member names longest-first so a short suffix can't shadow a
    # longer one when scanning ('kanban' vs 'kanban-2' sharing the
    # "kanban" tail — longer match wins).
    local members
    members="$(jq -r '[.members[].name] | sort_by(length) | reverse | .[]' "$tj" 2>/dev/null || true)"
    [[ -z "$members" ]] && continue

    local prefix="__${team}__"
    local win rest matched emoji m
    while IFS= read -r win; do
      [[ -z "$win" ]] && continue
      [[ "$win" == "$prefix"* ]] || continue
      # System windows have no emoji and aren't team members.
      [[ "$win" == "${prefix}home" || "$win" == "${prefix}supervisor" ]] && continue
      rest="${win#"$prefix"}"

      matched=""; emoji=""
      while IFS= read -r m; do
        [[ -z "$m" ]] && continue
        if [[ "${rest%"$m"}" != "$rest" ]]; then
          matched="$m"
          emoji="${rest%"$m"}"
          break
        fi
      done <<<"$members"

      if [[ -z "$matched" ]]; then
        atmux::warn "registry-backfill: $win matches no $team member, skipping"
        unmatched=$((unmatched + 1))
        continue
      fi
      if [[ -z "$emoji" ]]; then
        atmux::log "  · $team/$matched: legacy window (no emoji prefix), skipping"
        legacy=$((legacy + 1))
        continue
      fi

      if [[ "$dry_run" -eq 1 ]]; then
        atmux::log "  · [dry-run] $team/$matched: would persist '$emoji'"
        persisted=$((persisted + 1))
        continue
      fi

      # set_emoji is immutable-once-written: returns existing value if set,
      # the new value if it just wrote. Compare to know whether we landed.
      local got
      got="$(atmux::registry_set_emoji "$team" "$matched" "$emoji" 2>/dev/null || echo "")"
      if [[ "$got" == "$emoji" ]]; then
        atmux::log "  · $team/$matched: persisted '$emoji'"
        persisted=$((persisted + 1))
      else
        skipped=$((skipped + 1))
      fi
    done < <(tmux list-windows -t "=$session" -F '#{window_name}' 2>/dev/null)
  done < <(jq -c '.[]' <<<"$rj")

  if [[ "$dry_run" -eq 1 ]]; then
    atmux::ok "registry-backfill: dry-run — would persist=$persisted, legacy=$legacy, unmatched=$unmatched"
  else
    atmux::ok "registry-backfill: persisted=$persisted, already-set=$skipped, legacy=$legacy, unmatched=$unmatched"
  fi
}
