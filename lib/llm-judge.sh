#!/usr/bin/env bash
# lib/llm-judge.sh — generic Sonnet-by-default LLM judge wrapper.
#
# Per ADR-023 §Decision: small read-only-text-judgment helper used by
# whip's SOFT-tier rate-limit classifier (E9/Sb) and unblocker's
# wedged/idle/slow tick (E9/Sc). Stdout is the model's verbatim output;
# callers parse the expected JSON contract themselves. Every invocation
# appends one JSONL row to .atmux/state/llm-judge-cost.jsonl so operators
# can audit cost out-of-band (`cat` / future `atmux cost --judge`).
#
# Failure path is "judge unavailable" by design — `claude` CLI absent,
# non-zero exit, or empty stdout all collapse to a single canonical
# `{decision:"unavailable",...}` JSON line. Callers branch on that to
# pick a conservative deterministic fallback (whip: rotate; unblocker:
# skip).

# atmux::llm_judge <prompt-file> [--model <m>] [--caller <name>] [--member <name>]
#
# Reads <prompt-file> on stdin to `claude --print --no-conversation`.
# Defaults: model=claude-sonnet-4-6, caller=unknown, member=-.
# Honors ATMUX_CLAUDE_BIN (consistent with lib/tui.sh:87 + lib/super-attach.sh:41).
atmux::llm_judge() {
  local prompt_file="${1:-}"
  shift || true
  [[ -n "$prompt_file" && -f "$prompt_file" ]] \
    || { atmux::warn "llm_judge: prompt file required"; printf '%s\n' '{"decision":"unavailable","reason":"prompt file missing"}'; return 0; }

  local model="claude-sonnet-4-6"
  local caller="unknown"
  local member="-"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --model)  model="$2";  shift 2 ;;
      --caller) caller="$2"; shift 2 ;;
      --member) member="$2"; shift 2 ;;
      *) atmux::warn "llm_judge: unknown arg: $1"; shift ;;
    esac
  done

  local bin="${ATMUX_CLAUDE_BIN:-claude}"
  local input_chars; input_chars=$(wc -c <"$prompt_file" 2>/dev/null | tr -d ' ')
  [[ "$input_chars" =~ ^[0-9]+$ ]] || input_chars=0

  local output="" rc=0 decision="unavailable" reason="judge invocation failed"
  if ! command -v "$bin" >/dev/null 2>&1; then
    atmux::warn "llm_judge: claude CLI not found ($bin)"
    output='{"decision":"unavailable","reason":"judge invocation failed"}'
  else
    output="$("$bin" --print --model "$model" --no-conversation <"$prompt_file" 2>/dev/null)" || rc=$?
    if (( rc != 0 )) || [[ -z "$output" ]]; then
      atmux::warn "llm_judge: $bin exit=$rc, output_len=${#output}"
      output='{"decision":"unavailable","reason":"judge invocation failed"}'
    else
      decision="$(jq -r '.decision // "unknown"' <<<"$output" 2>/dev/null || echo unknown)"
      reason="$(jq -r '.reason // ""' <<<"$output" 2>/dev/null || echo "")"
    fi
  fi

  local output_chars=${#output}
  local ledger="$(atmux::state_dir)/llm-judge-cost.jsonl"
  mkdir -p "$(dirname "$ledger")"
  local ts; ts="$(atmux::now_epoch)"
  jq -cn \
    --arg ts "$ts" --arg member "$member" --arg caller "$caller" \
    --arg model "$model" --arg input_chars "$input_chars" \
    --arg output_chars "$output_chars" --arg decision "$decision" \
    --arg reason "$reason" \
    '{ts: ($ts|tonumber), member: $member, caller: $caller, model: $model,
      input_chars: ($input_chars|tonumber), output_chars: ($output_chars|tonumber),
      decision: $decision, reason: $reason}' >>"$ledger" 2>/dev/null || true

  printf '%s\n' "$output"
}
