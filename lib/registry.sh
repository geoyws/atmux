#!/usr/bin/env bash
# lib/registry.sh — atmux team registry helpers (E10/Sa t-4339ca7c, ADR-025 + ADR-030).
#
# Single source of truth for "what teams exist" lives at
# `~/.claude/teams/registry.json` (override via $ATMUX_REGISTRY for test
# sandboxes). Schema:
#
#   [
#     {
#       "name":         "<team>",
#       "projectRoot":  "<realpath-canonical>",
#       "sessionName":  "<tmux-session>",
#       "createdAt":    <epoch>,           # seconds, OQ G7
#       "lastSeen":     <epoch>,           # seconds
#       "status":       "running" | "stopped" | "stale",
#       "members":      [{"name":"<m>","emoji":"<e>"}, ...]   # ADR-030
#     }
#   ]
#
# Public API (all flock-guarded on writes via atmux::jq_update — the
# kanban.json.lock pattern, per ADR-013 + user memory
# feedback_destructive_worktree_overwrite.md; bare `jq | mv` is the
# foot-gun this layer exists to avoid):
#
#   atmux::registry_upsert <name> <projectRoot> [<sessionName>]
#   atmux::registry_touch <name>
#   atmux::registry_deregister <name>
#   atmux::registry_list [--json]
#   atmux::registry_set_emoji <team> <member> <emoji>   # ADR-030
#   atmux::registry_get_emoji <team> <member>           # ADR-030
#
# Sourced via lib/common.sh-aware callers (start.sh, init.sh, stop.sh,
# super-* verbs); relies on atmux::jq_update / atmux::now_epoch /
# atmux::die already being defined upstream. No main() — this is a
# library file, not a verb.

# Resolve the registry path. Honors $ATMUX_REGISTRY for sandbox isolation;
# defaults to ~/.claude/teams/registry.json (out-of-repo, fleet-wide).
atmux::registry_path() {
  printf '%s\n' "${ATMUX_REGISTRY:-$HOME/.claude/teams/registry.json}"
}

# Ensure the registry file exists and is a valid empty JSON array. Idempotent.
# Called by every write-side helper before atmux::jq_update so the seed step
# can't race with a concurrent reader staring at a half-created file.
atmux::_registry_seed() {
  local r; r="$(atmux::registry_path)"
  mkdir -p "$(dirname "$r")"
  if [[ ! -s "$r" ]]; then
    printf '[]\n' > "$r"
  fi
}

# atmux::registry_upsert <name> <projectRoot> [<sessionName>]
#
# Idempotent registration. Existing entry → update projectRoot (canonicalised
# via realpath), sessionName (only if a non-empty value was passed; preserves
# prior on empty arg), lastSeen=now, status=running, members preserved.
# Missing → append with createdAt=now, lastSeen=now, status=running,
# members=[].
atmux::registry_upsert() {
  local name="${1:-}"
  local root="${2:-}"
  local sess="${3:-}"
  [[ -n "$name" ]] || atmux::die "registry_upsert: <name> required"
  [[ -n "$root" ]] || atmux::die "registry_upsert: <projectRoot> required"

  # realpath canonicalisation per ADR-025 risk register: symlink-farm
  # worktrees would otherwise create duplicate registry entries. realpath
  # without -e tolerates a not-yet-existing path; fall back to the raw
  # value if realpath itself isn't on PATH (extreme edge — keeps the
  # registry usable rather than die'ing on a corner-case env).
  local canonical
  canonical="$(realpath "$root" 2>/dev/null || printf '%s' "$root")"

  local now; now="$(atmux::now_epoch)"

  atmux::_registry_seed
  local r; r="$(atmux::registry_path)"

  atmux::jq_update "$r" '
    if any(.[]?; .name == $name) then
      map(
        if .name == $name then
            .projectRoot = $root
          | .sessionName = (if $sess == "" then (.sessionName // "") else $sess end)
          | .lastSeen    = ($now | tonumber)
          | .status      = "running"
          | .members     = (.members // [])
        else . end
      )
    else
      . + [{
        name:        $name,
        projectRoot: $root,
        sessionName: $sess,
        createdAt:   ($now | tonumber),
        lastSeen:    ($now | tonumber),
        status:      "running",
        members:     []
      }]
    end
  ' --arg name "$name" --arg root "$canonical" --arg sess "$sess" --arg now "$now"
}

# atmux::registry_touch <name>
#
# Bump lastSeen on an existing entry. No-op if registry is missing/empty
# or the name isn't registered — no auto-create here, that's upsert's job.
atmux::registry_touch() {
  local name="${1:-}"
  [[ -n "$name" ]] || atmux::die "registry_touch: <name> required"

  local r; r="$(atmux::registry_path)"
  [[ -s "$r" ]] || return 0

  local now; now="$(atmux::now_epoch)"
  atmux::jq_update "$r" '
    map(if .name == $name then .lastSeen = ($now | tonumber) else . end)
  ' --arg name "$name" --arg now "$now"
}

# atmux::registry_deregister <name>
#
# Mark the team stopped. Preserves the entry per ADR-025 §Decision —
# history matters; super-status liveness check distinguishes
# stopped (graceful) from stale (process-died-without-stop).
atmux::registry_deregister() {
  local name="${1:-}"
  [[ -n "$name" ]] || atmux::die "registry_deregister: <name> required"

  local r; r="$(atmux::registry_path)"
  [[ -s "$r" ]] || return 0

  atmux::jq_update "$r" '
    map(if .name == $name then .status = "stopped" else . end)
  ' --arg name "$name"
}

# atmux::registry_list [--json]
#
# Read-only enumeration. --json emits the file verbatim for downstream
# pipelines (super-status --json, dashboards, tests). Default is a
# human-readable powerline-flavor table.
atmux::registry_list() {
  local mode="human"
  if [[ "${1:-}" == "--json" ]]; then mode="json"; fi

  local r; r="$(atmux::registry_path)"
  if [[ ! -s "$r" ]]; then
    if [[ "$mode" == "json" ]]; then printf '[]\n'; else printf '(no teams registered)\n'; fi
    return 0
  fi

  if [[ "$mode" == "json" ]]; then
    cat "$r"
    return 0
  fi

  printf '%-20s  %-44s  %-18s  %-8s  %s\n' "NAME" "PROJECT-ROOT" "SESSION" "STATUS" "LAST-SEEN"
  local now; now="$(atmux::now_epoch)"
  jq -r '.[] | [.name, .projectRoot, (.sessionName // ""), (.status // "?"), (.lastSeen // 0)] | @tsv' "$r" \
    | while IFS=$'\t' read -r n p s st ls; do
        local age
        if ! [[ "$ls" =~ ^[0-9]+$ ]] || (( ls == 0 )); then
          age="?"
        else
          age="$(( now - ls ))s ago"
        fi
        printf '%-20s  %-44s  %-18s  %-8s  %s\n' "$n" "$p" "$s" "$st" "$age"
      done
}

# atmux::registry_set_emoji <team> <member> <emoji>            # ADR-030
#
# STRICT immutable: only writes when the member's emoji slot is empty/
# missing. If already set, the existing value is preserved silently —
# this is the load-bearing invariant that makes random-on-first-spawn
# durable across restarts.
#
# Side-effect: if the member entry is absent, it's created with the
# provided emoji. If the team itself isn't registered, this is a no-op
# (registration is upsert's job; set_emoji isn't an auto-create path).
#
# Echoes the resolved emoji (existing or newly-written) on stdout for
# the caller's lookup-priority chain.
atmux::registry_set_emoji() {
  local team="${1:-}"
  local member="${2:-}"
  local emoji="${3:-}"
  [[ -n "$team"   ]] || atmux::die "registry_set_emoji: <team> required"
  [[ -n "$member" ]] || atmux::die "registry_set_emoji: <member> required"

  atmux::_registry_seed
  local r; r="$(atmux::registry_path)"

  atmux::jq_update "$r" '
    map(
      if .name == $team then
        .members = (
          (.members // []) as $m
          | if any($m[]?; .name == $member) then
              $m | map(
                if .name == $member then
                  if (.emoji // "") == "" then .emoji = $emoji else . end
                else . end
              )
            else
              $m + [{name: $member, emoji: $emoji}]
            end
        )
      else . end
    )
  ' --arg team "$team" --arg member "$member" --arg emoji "$emoji"

  atmux::registry_get_emoji "$team" "$member"
}

# atmux::registry_get_emoji <team> <member>                     # ADR-030
#
# Pure lookup. Echoes the persisted emoji or empty string. No-flock —
# this is read-mostly and on every spawn; flocking would serialise
# spawns unnecessarily. Step 1 of the spawn-time lookup priority chain
# (registry → team.json → random fallback per ADR-030 §Decision).
atmux::registry_get_emoji() {
  local team="${1:-}"
  local member="${2:-}"
  [[ -n "$team"   ]] || atmux::die "registry_get_emoji: <team> required"
  [[ -n "$member" ]] || atmux::die "registry_get_emoji: <member> required"

  local r; r="$(atmux::registry_path)"
  [[ -s "$r" ]] || { printf '\n'; return 0; }

  jq -r --arg team "$team" --arg member "$member" '
    [ .[]
      | select(.name == $team)
      | (.members // [])[]
      | select(.name == $member)
      | .emoji // ""
    ] | first // ""
  ' "$r"
}
