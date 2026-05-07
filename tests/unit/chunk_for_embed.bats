#!/usr/bin/env bats
# Unit tests for _atmux_chunk_for_embed (lib/discord.sh).
#
# The shared chunker packs an ordered list of section blocks into 1..N
# NUL-separated body chunks each fitting within (max_body − header overhead).
# Used by lib/decisions.sh::_decisions_render_discord; future callers
# (whip/flags/dispatch) will share this helper so behavior must be stable.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  # shellcheck source=../../lib/common.sh
  . "$ATMUX_LIB_DIR/common.sh"
  # shellcheck source=../../lib/discord.sh
  . "$ATMUX_LIB_DIR/discord.sh"
}

teardown() {
  atmux_teardown_sandbox
}

# Read NUL-separated chunks into a global array `CHUNKS`. Process substitution
# preserves NULs (which `$(...)` would strip with a warning).
_capture_chunks() {
  CHUNKS=()
  mapfile -d '' CHUNKS < <(_atmux_chunk_for_embed "$@")
}

@test "chunk_for_embed: single small section → 1 chunk, no marker" {
  _capture_chunks "hdr" 1900 5 "↳ marker" "🔵 question: small?"
  [ "${#CHUNKS[@]}" -eq 1 ]
  [[ "${CHUNKS[0]}" =~ "🔵 question" ]]
  ! [[ "${CHUNKS[0]}" =~ "↳ marker" ]]
}

@test "chunk_for_embed: multiple small sections fit in 1 chunk → 1 chunk" {
  _capture_chunks "hdr" 1900 5 "↳ marker" "REQ" "SEC2" "SEC3"
  [ "${#CHUNKS[@]}" -eq 1 ]
  [[ "${CHUNKS[0]}" =~ REQ ]]
  [[ "${CHUNKS[0]}" =~ SEC2 ]]
  [[ "${CHUNKS[0]}" =~ SEC3 ]]
}

@test "chunk_for_embed: empty section list → no output, rc 0" {
  _capture_chunks "hdr" 1900 5 "↳ marker"
  [ "${#CHUNKS[@]}" -eq 0 ]
}

@test "chunk_for_embed: per-section atomic — section bigger than budget drops + marker fires" {
  local huge; huge=$(printf '%.0sH' {1..3000})
  # max_body=1000 → body_budget ≈ 980. The 3000-char section can't fit any
  # chunk. It must drop, marker must appear in chunks[0] (the only survivor).
  _capture_chunks "hdr" 1000 5 "↳ marker" "REQ" "$huge"
  [ "${#CHUNKS[@]}" -ge 1 ]
  [[ "${CHUNKS[0]}" =~ REQ ]]
  local last=$(( ${#CHUNKS[@]} - 1 ))
  [[ "${CHUNKS[$last]}" =~ "↳ marker" ]]
}

@test "chunk_for_embed: cap-hit — max_chunks=2 with 3 packing-needed sections drops + marker fires" {
  local fld; fld=$(printf '%.0sX' {1..900})
  # body_budget at max_body=1000 ≈ 980. Each fld is 900 chars; two together
  # (900+\n\n+900) overflow 980, so each needs its own chunk. With max_chunks=2:
  # chunks[0]=REQ, chunks[1]=fld; the second fld overflows the cap → drop.
  _capture_chunks "hdr" 1000 2 "↳ marker" "REQ" "$fld" "$fld"
  [ "${#CHUNKS[@]}" -eq 2 ]
  local last=$(( ${#CHUNKS[@]} - 1 ))
  [[ "${CHUNKS[$last]}" =~ "↳ marker" ]]
}

@test "chunk_for_embed: empty marker → no marker even on drops" {
  local huge; huge=$(printf '%.0sH' {1..3000})
  _capture_chunks "hdr" 1000 5 "" "REQ" "$huge"
  [ "${#CHUNKS[@]}" -ge 1 ]
  [[ "${CHUNKS[0]}" =~ REQ ]]
  local last=$(( ${#CHUNKS[@]} - 1 ))
  ! [[ "${CHUNKS[$last]}" =~ "↳" ]]
}

@test "chunk_for_embed: section1 always lands in chunks[0] (required block)" {
  local fld; fld=$(printf '%.0sM' {1..1500})
  _capture_chunks "hdr" 1900 5 "↳ marker" "REQUIRED-SENTINEL" "$fld"
  [ "${#CHUNKS[@]}" -ge 1 ]
  [[ "${CHUNKS[0]}" =~ "REQUIRED-SENTINEL" ]]
}

@test "chunk_for_embed: header overhead reserved — large header shrinks budget" {
  # Two sections that JUST fit single-chunk under a small header may spill
  # to two chunks under a long header. Pick sizes near the threshold.
  local fld; fld=$(printf '%.0sX' {1..1400})
  _capture_chunks "hdr" 1900 5 "" "REQ" "$fld"
  local n_short=${#CHUNKS[@]}
  local long_hdr; long_hdr=$(printf '%.0sH' {1..600})
  _capture_chunks "$long_hdr" 1900 5 "" "REQ" "$fld"
  local n_long=${#CHUNKS[@]}
  # Larger header MUST NOT result in fewer chunks (monotone non-decreasing).
  [ "$n_short" -le "$n_long" ]
}

@test "chunk_for_embed: marker only fires on actual drop, not just multi-chunk" {
  local s1; s1=$(printf '%.0sA' {1..1500})
  local s2; s2=$(printf '%.0sB' {1..1500})
  # Each section just fits a chunk's body_budget (~1880) but two together
  # spill → 2-3 chunks, no drops, no marker anywhere.
  _capture_chunks "hdr" 1900 5 "↳ marker" "REQ" "$s1" "$s2"
  [ "${#CHUNKS[@]}" -ge 2 ]
  local i
  for i in "${!CHUNKS[@]}"; do
    ! [[ "${CHUNKS[$i]}" =~ "↳ marker" ]]
  done
}

@test "chunk_for_embed: byte budget floor — degenerate small max_body still produces output" {
  # max_body=10 forces budget=floor(100). Short sections must still emit.
  _capture_chunks "hdr" 10 5 "↳ marker" "small"
  [ "${#CHUNKS[@]}" -ge 1 ]
  [[ "${CHUNKS[0]}" =~ small ]]
}
