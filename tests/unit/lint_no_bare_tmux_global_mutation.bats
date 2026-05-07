#!/usr/bin/env bats
# Lint guard against re-introducing the cage-prefix-leak class of bug.
#
# Background: pre-b39d9f4, lib/start.sh ran "tmux set-option -g prefix
# 'C-backslash'" as a bare command. When 'atmux start' was invoked from
# inside daily-driver tmux (operator's regular session), $TMUX overrode
# $TMUX_TMPDIR per tmux(1), so the override targeted the daily-driver
# socket — clobbering the operator's prefix while leaving the cage's
# prefix at .tmux.conf default. b39d9f4 fixed this by switching to
# 'env -u TMUX tmux -S "$cage_sock" set-option ...'.
#
# This lint blocks future regressions for the SPECIFIC verb class that
# mutates GLOBAL/SERVER tmux state (no session/window target arg):
#   - set-option -g / set -g  (global option assignment)
#   - set-hook -g            (global hook)
#   - bind-key / bind         (server keytable binding)
#   - unbind-key / unbind     (server keytable unbinding)
#   - source-file             (server-wide config re-source)
#
# These all need explicit socket targeting. Per-session/per-window
# verbs (kill-session, new-window, send-keys, etc.) take target args
# and are NOT linted — they fail loudly if the socket is wrong, vs.
# silently corrupting the wrong server.

setup() {
  ATMUX_ROOT="${ATMUX_ROOT:-${BATS_TEST_DIRNAME}/../..}"
  ATMUX_ROOT="$(cd "$ATMUX_ROOT" && pwd)"
  export ATMUX_ROOT
}

# Regex of mutating verbs that must NEVER appear bare. Anchored to
# avoid prefix-match false positives (e.g. set-environment is OK but
# would match a bare 'set' regex). Each verb is the literal first
# token after 'tmux'.
_lint_pattern='(^|[^a-zA-Z0-9_-])tmux[[:space:]]+(set-option[[:space:]]+-g|set[[:space:]]+-g|set-hook[[:space:]]+-g|bind-key|bind|unbind-key|unbind|source-file)([[:space:]]|$)'

# Scan a file for offending lines. Skips comment lines + lines where
# the match is inside a quoted string (heuristic: literal "tmux or
# 'tmux preceding the match — typical of error-message strings that
# document the bug pattern).
_scan_file() {
  local file="$1" lineno line stripped offending=""

  while IFS=: read -r lineno line; do
    [[ -z "$lineno" ]] && continue
    stripped="${line#"${line%%[![:space:]]*}"}"
    [[ "$stripped" == \#* ]] && continue

    # Heuristic: if the literal "tmux <verb>" appears inside a quoted
    # string (e.g. error-hint text or printf format), skip. Detected
    # via unpaired quote count BEFORE the first 'tmux' on the line:
    # an odd number of " or ' before 'tmux' means we're inside a
    # quoted string at that point.
    local before="${line%%tmux*}"
    if [[ "$before" != "$line" ]]; then
      # Strip backslash-escaped quotes (\" and \') before counting —
      # those don't open/close a string.
      local count_src="${before//\\\"/}"
      count_src="${count_src//\\\'/}"
      local n_double="${count_src//[^\"]/}"
      local n_single="${count_src//[^\']/}"
      if (( ${#n_double} % 2 == 1 )) || (( ${#n_single} % 2 == 1 )); then
        continue
      fi
    fi

    # SAFE forms — skip
    [[ "$line" =~ env[[:space:]]+-u[[:space:]]+TMUX[[:space:]]+tmux ]] && continue
    [[ "$line" =~ tmux[[:space:]]+-[SL][[:space:]] ]] && continue
    offending+="$file:$lineno:$line"$'\n'
  done < <(grep -nE "$_lint_pattern" "$file" 2>/dev/null || true)

  printf '%s' "$offending"
}

@test "lint: no bare tmux global-state mutation in lib/" {
  local hits=""
  for f in "$ATMUX_ROOT"/lib/*.sh; do
    [[ -f "$f" ]] || continue
    hits+="$(_scan_file "$f")"
  done

  if [[ -n "$hits" ]]; then
    echo "Bare tmux global-state mutation found in lib/ — must use env -u TMUX tmux -S <socket> or tmux -S <socket>:"
    echo ""
    printf '%s' "$hits"
    return 1
  fi
}

@test "lint: no bare tmux global-state mutation in bin/" {
  local hits=""
  for f in "$ATMUX_ROOT"/bin/atmux "$ATMUX_ROOT"/bin/atmux-tmux; do
    [[ -f "$f" ]] || continue
    hits+="$(_scan_file "$f")"
  done

  if [[ -n "$hits" ]]; then
    echo "Bare tmux global-state mutation found in bin/ — must use env -u TMUX tmux -S <socket> or tmux -S <socket>:"
    echo ""
    printf '%s' "$hits"
    return 1
  fi
}

@test "lint: scanner detects a bare-tmux violation in a synthetic file" {
  local tmpfile; tmpfile="$(mktemp)"
  cat > "$tmpfile" <<'EOF'
#!/bin/bash
tmux set-option -g prefix 'C-x'
EOF
  local hits; hits="$(_scan_file "$tmpfile")"
  rm -f "$tmpfile"
  [[ -n "$hits" ]] || { echo "scanner missed obvious violation"; return 1; }
}

@test "lint: scanner does not flag the safe env -u TMUX form" {
  local tmpfile; tmpfile="$(mktemp)"
  cat > "$tmpfile" <<'EOF'
#!/bin/bash
env -u TMUX tmux -S "$cage_sock" set-option -g prefix 'C-\\'
EOF
  local hits; hits="$(_scan_file "$tmpfile")"
  rm -f "$tmpfile"
  [[ -z "$hits" ]] || { echo "false positive on safe form: $hits"; return 1; }
}

@test "lint: scanner does not flag commented-out callsites" {
  local tmpfile; tmpfile="$(mktemp)"
  cat > "$tmpfile" <<'EOF'
#!/bin/bash
# tmux set-option -g prefix 'C-x'  -- documented bug pattern, not a callsite
EOF
  local hits; hits="$(_scan_file "$tmpfile")"
  rm -f "$tmpfile"
  [[ -z "$hits" ]] || { echo "false positive on comment: $hits"; return 1; }
}
