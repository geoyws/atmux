#!/usr/bin/env bash
# atmux verify-libs [--quiet] [--json]
#
# Source-time + function-presence sanity check for every lib/*.sh. Used as
# a preflight by lib/doctor.sh and as a standalone CI gate after edits to
# the lib tree. Exits 0 only when every file sources cleanly under strict
# mode AND every `atmux::*` / `_atmux_*` function it declares is actually
# defined post-source.
#
# Output modes:
#   default → one line per lib + summary footer (operator-friendly).
#   --quiet → silent on green; on failure prints the first ❌/⚠️ + summary.
#   --json  → structured `{summary:{...}, libs:[...]}` for doctor consumption.

main() {
  local quiet=0 json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --quiet) quiet=1; shift ;;
      --json)  json=1;  shift ;;
      *) atmux::die "verify-libs: unknown flag: $1" ;;
    esac
  done

  local lib_dir="${ATMUX_LIB_DIR:-}"
  [[ -n "$lib_dir" && -d "$lib_dir" ]] \
    || atmux::die "verify-libs: ATMUX_LIB_DIR unset or not a directory"

  local total=0 ok=0 source_fail=0 missing_fail=0
  local results=()

  local lib_file libname
  for lib_file in "$lib_dir"/*.sh; do
    [[ -f "$lib_file" ]] || continue
    libname="$(basename "$lib_file")"
    total=$((total + 1))

    # Step 1: source in a clean subshell under strict mode. Capture stderr
    # + rc independently so we can distinguish "wouldn't even parse" from
    # "parsed but a top-level statement failed".
    local source_err source_rc
    source_err="$(_atmux_verify_libs_source_check "$lib_dir" "$lib_file" 2>&1)"
    source_rc=$?

    if (( source_rc != 0 )); then
      source_fail=$((source_fail + 1))
      local first_err; first_err="$(printf '%s' "$source_err" | head -1)"
      results+=("FAIL|$libname|source failed: ${first_err:-rc=$source_rc}")
      continue
    fi

    # Step 2: find declared function names + verify presence post-source.
    local decls
    decls="$(grep -E '^(atmux::|_atmux_)[[:alnum:]_:]+[[:space:]]*\(\)' "$lib_file" \
              | sed -E 's/[[:space:]]*\(\).*//' || true)"
    local fn_count=0
    [[ -n "$decls" ]] && fn_count="$(printf '%s\n' "$decls" | wc -l | tr -d ' ')"

    if (( fn_count == 0 )); then
      ok=$((ok + 1))
      results+=("OK|$libname|0 functions (no declarations)")
      continue
    fi

    local missing
    missing="$(_atmux_verify_libs_check_fns "$lib_dir" "$lib_file" "$decls" 2>/dev/null || true)"

    if [[ -z "$missing" ]]; then
      ok=$((ok + 1))
      results+=("OK|$libname|$fn_count functions")
    else
      missing_fail=$((missing_fail + 1))
      local csv; csv="$(printf '%s' "$missing" | tr '\n' ',' | sed 's/,$//')"
      results+=("MISSING|$libname|$fn_count declared; not found: $csv")
    fi
  done

  if (( json == 1 )); then
    _atmux_verify_libs_render_json "$total" "$ok" "$source_fail" "$missing_fail" "${results[@]}"
  else
    _atmux_verify_libs_render_text "$total" "$ok" "$source_fail" "$missing_fail" "$quiet" "${results[@]}"
  fi

  if (( source_fail > 0 || missing_fail > 0 )); then
    return 1
  fi
  return 0
}

# Source the lib in a clean subshell under strict mode. Echoes nothing on
# success; stderr carries the first failure line on rc != 0.
_atmux_verify_libs_source_check() {
  local lib_dir="$1" lib_file="$2"
  bash --noprofile --norc -c "
    set -euo pipefail
    export ATMUX_LIB_DIR='$lib_dir'
    . '$lib_file'
  "
}

# Source + run \`type -t\` on every declared function. Echoes the names of
# functions that did NOT resolve to function|builtin (one per line).
_atmux_verify_libs_check_fns() {
  local lib_dir="$1" lib_file="$2" decls="$3"
  bash --noprofile --norc <<EOF 2>/dev/null
set +e
export ATMUX_LIB_DIR='$lib_dir'
. '$lib_file' >/dev/null 2>&1
$(while IFS= read -r fn; do
    [[ -z "$fn" ]] && continue
    printf 'kind=$(type -t %q 2>/dev/null || echo missing); '\
'[[ "$kind" != function && "$kind" != builtin ]] && echo %q\n' "$fn" "$fn"
  done <<<"$decls")
EOF
}

# JSON output for doctor consumption.
_atmux_verify_libs_render_json() {
  local total="$1" ok="$2" source_fail="$3" missing_fail="$4"; shift 4
  local libs_json=()
  local r status name detail
  for r in "$@"; do
    IFS='|' read -r status name detail <<<"$r"
    libs_json+=("$(jq -n --arg s "$status" --arg n "$name" --arg d "$detail" \
                       '{status:$s, name:$n, detail:$d}')")
  done
  local libs_array
  libs_array="$(printf '%s\n' "${libs_json[@]}" | jq -s '.')"
  jq -n \
    --argjson summary "{\"total\":$total,\"ok\":$ok,\"sourceFail\":$source_fail,\"missingFail\":$missing_fail}" \
    --argjson libs "$libs_array" \
    '{summary:$summary, libs:$libs}'
}

# Plain-text rendering. quiet=1 ⇒ silent on green, first failure + summary
# otherwise.
_atmux_verify_libs_render_text() {
  local total="$1" ok="$2" source_fail="$3" missing_fail="$4" quiet="$5"
  shift 5
  local r status name detail emitted_first=0
  for r in "$@"; do
    IFS='|' read -r status name detail <<<"$r"
    if (( quiet == 1 )); then
      if [[ "$status" != "OK" && "$emitted_first" -eq 0 ]]; then
        case "$status" in
          FAIL)    echo "❌ $name ($detail)" ;;
          MISSING) echo "⚠️  $name ($detail)" ;;
        esac
        emitted_first=1
      fi
    else
      case "$status" in
        OK)      echo "✅ $name ($detail)" ;;
        FAIL)    echo "❌ $name ($detail)" ;;
        MISSING) echo "⚠️  $name ($detail)" ;;
      esac
    fi
  done
  if (( quiet == 0 || source_fail > 0 || missing_fail > 0 )); then
    echo
    echo "Summary: $ok/$total OK · $source_fail source-fail · $missing_fail missing-fns"
  fi
}
