#!/usr/bin/env bash
# atmux reply <msg...>     — any member writes to lead-outbox.md (driver reads)
# atmux outbox             — driver reads the outbox (prints open entries, archives on --ack)
#
# Invoked via bin/atmux dispatcher. For `outbox`, the dispatcher passes
# "--outbox" as first arg; for `reply`, the dispatcher passes "--reply".

# shellcheck source=socket-pubsub.sh
. "$ATMUX_LIB_DIR/socket-pubsub.sh"

main() {
  atmux::require jq
  atmux::require_team

  local mode="${1:-}"; shift || true
  case "$mode" in
    --reply)  _atmux_reply "$@" ;;
    --outbox) _atmux_outbox "$@" ;;
    *) atmux::die "reply.sh called without --reply|--outbox (internal routing error)" ;;
  esac
}

_atmux_outbox_path() {
  printf '%s/lead-outbox.md\n' "$(atmux::dir)"
}

_atmux_reply() {
  local from=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --from) from="$2"; shift 2 ;;
      --) shift; break ;;
      -*) atmux::die "reply: unknown flag: $1" ;;
      *) break ;;
    esac
  done
  local msg="$*"
  [[ -n "$msg" ]] || atmux::die "usage: atmux reply [--from <member>] <msg...>"

  if [[ -z "$from" ]]; then
    from="${ATMUX_MEMBER:-lead}"
  fi

  local ob; ob="$(_atmux_outbox_path)"
  atmux::with_lock "$ob" _atmux_outbox_write "$ob" "$from" "$msg"

  # E13/Sc: signal the lead's supervisor of the new reply so the lead picks
  # it up in real time (vs the 5-min cron-whip baseline). lead-outbox.md is
  # the durable source of truth — this publish is only a wake-up nudge.
  # Solo Mode (no team-lead) skips silently; absent listener is non-fatal.
  local _lead; _lead="$(atmux::find_lead_member 2>/dev/null || true)"
  if [[ -n "$_lead" ]]; then
    local _evt
    _evt="$(jq -cn \
      --arg from "$from" \
      --arg snip "${msg:0:100}" \
      --argjson ts "$(atmux::now_epoch)" \
      '{type:"reply", ts:$ts, from:$from, payload:{snippet:$snip}}')"
    atmux::sock_publish "$_lead" "$_evt"
  fi

  atmux::ok "reply recorded ($from → driver) in $ob"
}

_atmux_outbox_write() {
  local ob="$1" from="$2" msg="$3"
  if [[ ! -f "$ob" ]]; then
    cat > "$ob" <<'EOF'
# Lead Outbox — replies back to the driver

Any team member writes here via `atmux reply <msg>`. The driver reads via
`atmux outbox`. Entries default to the `## Open` section; `atmux outbox --ack`
archives everything there to `## Archive`.

## Open
EOF
  fi

  # Insert under "## Open" (create the section if it's gone missing).
  if ! grep -q '^## Open' "$ob"; then
    printf '\n## Open\n' >> "$ob"
  fi
  local tmp; tmp="$(mktemp)"
  awk -v entry="- [$(atmux::now_myt)] **$from**: $msg" '
    { print }
    $0 == "## Open" { print entry }
  ' "$ob" > "$tmp"
  mv "$tmp" "$ob"
}

_atmux_outbox() {
  local ack=0 json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ack)  ack=1; shift ;;
      --json) json=1; shift ;;
      *) atmux::die "outbox: unknown arg: $1" ;;
    esac
  done

  local ob; ob="$(_atmux_outbox_path)"
  if [[ ! -f "$ob" ]]; then
    if [[ "$json" -eq 1 ]]; then echo '{"open":[]}'; else echo "(outbox empty)"; fi
    return 0
  fi

  # Collect open entries.
  local entries
  entries="$(awk '/^## Open/{flag=1;next}/^## /{flag=0}flag && /^- \[/' "$ob")"

  if [[ "$json" -eq 1 ]]; then
    jq -n --arg text "$entries" '{open: ($text | split("\n") | map(select(length>0)))}'
  else
    if [[ -z "$entries" ]]; then
      echo "📭 outbox empty"
    else
      printf '%s📬 lead-outbox%s — open messages:\n\n' "$atmux_c_cyn" "$atmux_c_rst"
      echo "$entries"
    fi
  fi

  if [[ "$ack" -eq 1 && -n "$entries" ]]; then
    atmux::with_lock "$ob" _atmux_outbox_archive "$ob"
    atmux::ok "archived $(echo "$entries" | wc -l) entries"
  fi
}

_atmux_outbox_archive() {
  local ob="$1"
  local tmp; tmp="$(mktemp)"
  local ts; ts="$(atmux::now_myt)"
  awk -v ts="$ts" '
    BEGIN {in_open=0; arch=""; has_arch=0}
    /^## Archive/ {has_arch=1}
    /^## Open/ {
      in_open=1
      print
      print ""
      next
    }
    /^## / && in_open {in_open=0}
    in_open && /^- \[/ {
      arch = arch "\n" $0 "  _(archived " ts ")_"
      next
    }
    {print}
    END {
      if (!has_arch) print "\n## Archive"
      print arch
    }
  ' "$ob" > "$tmp"
  mv "$tmp" "$ob"
}
