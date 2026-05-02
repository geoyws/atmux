#!/usr/bin/env bash
# lib/groom.sh — periodic state hygiene.
#
# Why this exists: driver-inbox.md, lead-outbox.md, decisions.md and
# kanban.json grow without bound. Lead/whip turns + member context loads
# re-read these files; once they pass ~100 KB each, every cycle pays
# substantial token cost for ancient archived material the active flow
# never references.
#
# Sub-operations (all idempotent):
#   1. inbox/outbox archive flush — extract the `## Archive` section body
#      from driver-inbox.md + lead-outbox.md into
#      .atmux/archive/<file>-YYYY-MM.md and leave the active file with
#      just the header + `## Open` + empty `## Archive`. Lead is still
#      responsible for moving Open→Archive as today; this verb only
#      garbage-collects the archived tail off the hot file.
#   2. decisions archive — entries older than --decisions-days
#      (default 30) move into .atmux/archive/decisions-YYYY-MM.md
#      (grouped by the entry's own timestamp month, not "now").
#   3. kanban summarize — done/cancelled cards older than --kanban-days
#      (default 30) get a one-line summary appended to
#      .atmux/archive/kanban-log-YYYY-MM.md and are removed from
#      kanban.json. Preserves a permanent greppable log of shipped work.
#   4. bak cull — keep newest --keep-bak (default 5) of each
#      kanban.json.bak.* / team.json.bak.*; delete the rest.
#   5. size guard — warn if archive/ total or kanban-log-*.md total
#      exceeds threshold, surfacing growth that warrants attention.
#
# Concurrency: flock on .atmux/groom.lock. Cron + on-activate may both
# fire near-simultaneously; second runner sees lock and exits cleanly.
#
# Activation hook: lib/start.sh fires `atmux groom --quiet` after cron
# install so every team start does a passive sweep — most days a no-op,
# but covers the hosts that run cron-less or whose crontab expired.

main() {
  atmux::require jq
  atmux::require_team
  atmux::ensure_dirs

  local dry_run=0 quiet=0
  local inbox_days=7 kanban_days=30 decisions_days=30 keep_bak=5
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) dry_run=1; shift ;;
      --quiet)   quiet=1;   shift ;;
      --inbox-days)     inbox_days="$2";     shift 2 ;;
      --kanban-days)    kanban_days="$2";    shift 2 ;;
      --decisions-days) decisions_days="$2"; shift 2 ;;
      --keep-bak)       keep_bak="$2";       shift 2 ;;
      -h|--help) _groom_usage; return 0 ;;
      *) atmux::die "groom: unknown arg: $1" ;;
    esac
  done

  # ATMUX_NO_GROOM=1 disables the verb entirely. Used by sandbox tests
  # that don't want the on-activate hook firing during start.bats runs;
  # also a kill-switch operators can flip if a future bug surfaces.
  case "${ATMUX_NO_GROOM:-}" in
    ''|0|false|FALSE|False) ;;
    *)
      [[ -n "${ATMUX_DEBUG:-}" ]] && atmux::log "groom: ATMUX_NO_GROOM set — no-op"
      return 0
      ;;
  esac

  local d adir
  d="$(atmux::dir)"
  adir="$d/archive"
  mkdir -p "$adir"

  # Single-flight lock — cron + on-activate might race. Second arrival
  # exits clean rather than block; daily cadence makes "skip this run"
  # the right outcome.
  exec 9>"$d/groom.lock"
  if ! command -v flock >/dev/null 2>&1; then
    [[ $quiet -eq 0 ]] && atmux::warn "groom: flock not available — proceeding without lock"
  elif ! flock -n 9; then
    [[ $quiet -eq 0 ]] && atmux::log "groom: another run holds the lock — skipping"
    return 0
  fi

  # Each sub-op is wrapped in `|| ...` so a single failure doesn't abort
  # the remaining steps — periodic sweeps must be resilient. The overall
  # verb still returns 0 if any sub-op recovers; warns are surfaced
  # individually.
  _groom_inbox_outbox "$d" "$adir" "$dry_run" "$quiet" \
    || atmux::warn "groom: inbox/outbox sub-op failed (continuing)"
  _groom_decisions    "$d" "$adir" "$decisions_days" "$dry_run" "$quiet" \
    || atmux::warn "groom: decisions sub-op failed (continuing)"
  _groom_kanban       "$d" "$adir" "$kanban_days" "$dry_run" "$quiet" \
    || atmux::warn "groom: kanban sub-op failed (continuing)"
  _groom_cull_bak     "$d" "$keep_bak" "$dry_run" "$quiet" \
    || atmux::warn "groom: bak-cull sub-op failed (continuing)"
  _groom_size_check   "$adir" "$quiet" \
    || atmux::warn "groom: size-check sub-op failed (continuing)"
}

_groom_usage() {
  cat <<'EOF'
atmux groom — sweep stale state into .atmux/archive/

Usage: atmux groom [flags]

Flags:
  --dry-run                Show what would change; touch nothing.
  --quiet                  Suppress per-step ok/log lines (cron-friendly).
  --inbox-days N           Reserved for future per-entry inbox parsing
                           (currently flushes whole `## Archive` section).
  --kanban-days N          Threshold for done/cancelled card summary (default 30).
  --decisions-days N       Threshold for decisions.md entry archival (default 30).
  --keep-bak N             Keep newest N of each .bak.* family (default 5).

Sub-operations (all idempotent):
  1. driver-inbox.md / lead-outbox.md: flush `## Archive` body into dated archive.
  2. decisions.md: move entries older than --decisions-days to dated archive.
  3. kanban.json: summarize + remove done/cancelled cards older than --kanban-days.
  4. .bak.* files: keep newest --keep-bak per family.
  5. archive/ size guard: warn if growth exceeds threshold.

Fires daily via cron (04:00) and once on every `atmux start`.
EOF
}

# ---------- inbox/outbox archive flush ----------

# For driver-inbox.md and lead-outbox.md, find the `## Archive` line and
# move everything BELOW it into archive/<file>-YYYY-MM.md (current month
# of the run). Re-emit the active file as: original header + everything
# up to and including the `## Archive` line + a blank line. Active file
# shrinks to just the header + `## Open` body.
_groom_inbox_outbox() {
  local d="$1" adir="$2" dry_run="$3" quiet="$4"
  local file
  for file in driver-inbox.md lead-outbox.md; do
    local src="$d/$file"
    [[ -f "$src" ]] || continue

    # `|| true` because pipefail + grep no-match returns 1, and the file
    # may legitimately have no `## Archive` section (cold-start state).
    local archive_line
    archive_line="$(grep -n '^## Archive' "$src" | head -1 | cut -d: -f1 || true)"
    [[ -z "$archive_line" ]] && continue

    local total_lines
    total_lines="$(wc -l < "$src")"
    # Body = lines AFTER the `## Archive` header. If header is the last
    # line (or only blank lines follow), there's nothing to flush.
    local body_start=$((archive_line + 1))
    if (( body_start > total_lines )); then
      continue
    fi

    # Read just the body and check whether it has any non-blank content.
    local body
    body="$(tail -n +"$body_start" "$src")"
    if [[ -z "$(printf '%s' "$body" | tr -d '[:space:]')" ]]; then
      continue
    fi

    local stamp
    stamp="$(date +%Y-%m)"
    local dest="$adir/${file%.md}-${stamp}.md"

    if [[ "$dry_run" -eq 1 ]]; then
      [[ "$quiet" -eq 0 ]] && \
        atmux::log "groom[dry-run]: would flush ${file} archive → $(basename "$dest") ($(printf '%s\n' "$body" | wc -l) lines)"
      continue
    fi

    {
      if [[ ! -f "$dest" ]]; then
        printf '# %s archive — %s\n\n' "${file%.md}" "$stamp"
      else
        printf '\n---\n\n'
      fi
      printf '_groom run: %s_\n\n' "$(date +'%Y-%m-%d %H:%M:%S %Z')"
      printf '%s\n' "$body"
    } >> "$dest"

    # Rebuild the active file: header through `## Archive` line, then a
    # single trailing newline. atmux::tmp_path keeps writes inside .atmux.
    local tmp; tmp="$(atmux::tmp_path groom-${file%.md} md)"
    head -n "$archive_line" "$src" > "$tmp"
    printf '\n' >> "$tmp"
    mv "$tmp" "$src"

    [[ "$quiet" -eq 0 ]] && atmux::ok "groom: flushed ${file} archive → $(basename "$dest")"
  done
}

# ---------- decisions.md archival ----------

# Walk decisions.md as a sequence of `### d-<id>` blocks. For each block,
# extract the `- **timestamp**: <epoch>` line; if older than the
# threshold, route the block to a monthly archive file keyed by THE
# ENTRY'S OWN month (not run-time month) so a year-old entry archived
# today still lands in its real month bucket. Younger blocks + any
# pre-block preamble (file header, intro) are kept verbatim.
_groom_decisions() {
  local d="$1" adir="$2" days="$3" dry_run="$4" quiet="$5"
  local src="$d/decisions.md"
  [[ -f "$src" ]] || return 0

  local cutoff_epoch
  cutoff_epoch=$(( $(date +%s) - days * 86400 ))

  # Drive the partition through awk: emit two tab-separated streams to
  # tempfiles — `kept` and `arch`. arch lines carry an extra YYYY-MM
  # prefix so the bash side can group by month. Pure awk keeps the per-
  # block parse single-pass; bash glue does file IO.
  local tmp_dir; tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/atmux-groom-dec-XXXXXX")"
  local kept_f="$tmp_dir/kept.md"
  local arch_f="$tmp_dir/arch.tsv"

  awk -v cutoff="$cutoff_epoch" -v kept_f="$kept_f" -v arch_f="$arch_f" '
    # Per-block partition: stale blocks stream to <arch_f>.<YYYY-MM>.md
    # (one file per entry-month); kept blocks + pre-block preamble
    # stream to kept_f. Awk handles the parse single-pass; bash glue
    # consumes the per-month files after.
    function flush_block(   raw) {
      if (block_text == "") return
      if (is_block && block_epoch_set && block_epoch < cutoff) {
        raw = arch_f "." strftime("%Y-%m", block_epoch) ".md"
        printf "%s", block_text >> raw
      } else {
        printf "%s", block_text >> kept_f
      }
      block_text = ""
      block_epoch_set = 0
      is_block = 0
    }

    BEGIN {
      block_text = ""
      block_epoch_set = 0
      is_block = 0
    }

    /^### d-/ {
      flush_block()
      is_block = 1
      block_text = $0 "\n"
      next
    }

    /^- \*\*timestamp\*\*: [0-9]+/ {
      ts = $0
      sub(/^- \*\*timestamp\*\*: /, "", ts)
      sub(/[^0-9].*$/, "", ts)
      if (ts ~ /^[0-9]+$/) {
        block_epoch = ts + 0
        block_epoch_set = 1
      }
      block_text = block_text $0 "\n"
      next
    }

    {
      block_text = block_text $0 "\n"
    }

    END {
      flush_block()
    }
  ' "$src"

  # If awk produced no per-month archive files, decisions.md has no
  # stale entries — exit clean.
  shopt -s nullglob
  local month_files=( "$arch_f".*.md )
  shopt -u nullglob
  if [[ ${#month_files[@]} -eq 0 ]]; then
    rm -rf "$tmp_dir"
    return 0
  fi

  if [[ "$dry_run" -eq 1 ]]; then
    local total=0 mf
    for mf in "${month_files[@]}"; do
      total=$(( total + $(wc -l < "$mf") ))
    done
    [[ "$quiet" -eq 0 ]] && \
      atmux::log "groom[dry-run]: would archive $total decisions.md lines into ${#month_files[@]} month buckets"
    rm -rf "$tmp_dir"
    return 0
  fi

  # Append each month bucket to its archive file, then atomically swap
  # decisions.md with the kept-only version. Filenames are
  # "<arch_f>.<YYYY-MM>.md" — strip the prefix + .md suffix to recover
  # the YYYY-MM key.
  local mf ym dest
  local arch_base; arch_base="$(basename "$arch_f")"
  for mf in "${month_files[@]}"; do
    ym="$(basename "$mf")"
    ym="${ym#${arch_base}.}"
    ym="${ym%.md}"
    dest="$adir/decisions-${ym}.md"
    {
      if [[ ! -f "$dest" ]]; then
        printf '# decisions archive — %s\n\n' "$ym"
      else
        printf '\n---\n\n'
      fi
      printf '_groom run: %s_\n\n' "$(date +'%Y-%m-%d %H:%M:%S %Z')"
      cat "$mf"
    } >> "$dest"
  done

  # Replace decisions.md with the kept-only stream. If kept_f was never
  # written to (every entry stale), preserve the file header at minimum.
  if [[ -s "$kept_f" ]]; then
    mv "$kept_f" "$src"
  else
    : > "$src"
    printf '# atmux decisions — append-only log\n\n' > "$src"
  fi

  [[ "$quiet" -eq 0 ]] && atmux::ok "groom: archived ${#month_files[@]} decisions month-bucket(s)"

  rm -rf "$tmp_dir"
}

# ---------- kanban summarize ----------

# Done/cancelled tasks older than --kanban-days get one-line summaries
# appended to .atmux/archive/kanban-log-YYYY-MM.md (grouped by the card's
# completedAt month) and are removed from kanban.json.tasks. Tasks
# without parseable completedAt are kept (defensive — never lose a
# card to ambiguous data).
_groom_kanban() {
  local d="$1" adir="$2" days="$3" dry_run="$4" quiet="$5"
  local src="$d/kanban.json"
  [[ -f "$src" ]] || return 0

  local cutoff_epoch
  cutoff_epoch=$(( $(date +%s) - days * 86400 ))

  # First pass: count + extract stale tasks as JSON. Defer the
  # destructive rewrite until we know we have something to do.
  local stale_json
  stale_json="$(jq --argjson cutoff "$cutoff_epoch" '
    def to_epoch:
      if . == null then 0
      elif type == "number" then .
      elif type == "string" then (fromdateiso8601? // (tonumber? // 0))
      else 0 end;
    [ .tasks[]?
      | select((.status == "done" or .status == "cancelled")
               and ((.completedAt // 0) | to_epoch) > 0
               and ((.completedAt // 0) | to_epoch) < $cutoff)
    ]
  ' "$src")"

  local stale_n
  stale_n="$(jq 'length' <<<"$stale_json")"
  [[ "$stale_n" -eq 0 ]] && return 0

  if [[ "$dry_run" -eq 1 ]]; then
    [[ "$quiet" -eq 0 ]] && \
      atmux::log "groom[dry-run]: would summarize+remove $stale_n done/cancelled cards older than ${days}d"
    return 0
  fi

  # Backup before any destructive rewrite — same hook the other kanban
  # writers use; pairs with the bak-cull step below.
  atmux::kanban_json_backup >/dev/null

  # Group stale tasks by completedAt-month → one log file per month.
  # jq emits "<YYYY-MM>\t<id>\t<status>\t<owner>\t<completedAt-iso>\t<subject>"
  # rows; bash redirects each row to its month's archive file.
  local rows
  rows="$(jq -r --argjson cutoff "$cutoff_epoch" '
    def to_epoch:
      if . == null then 0
      elif type == "number" then .
      elif type == "string" then (fromdateiso8601? // (tonumber? // 0))
      else 0 end;
    .tasks[]?
    | select((.status == "done" or .status == "cancelled")
             and ((.completedAt // 0) | to_epoch) > 0
             and ((.completedAt // 0) | to_epoch) < $cutoff)
    | [ ((.completedAt | to_epoch) | strftime("%Y-%m"))
      , .id
      , .status
      , (.owner // "-")
      , ((.completedAt | to_epoch) | strftime("%Y-%m-%d"))
      , ((.subject // "") | gsub("[\n\r\t]"; " "))
      ] | @tsv
  ' "$src")"

  # Bucket rows by month, append to per-month archives.
  declare -A months_seen=()
  while IFS=$'\t' read -r ym id status owner cdate subject; do
    [[ -z "$ym" ]] && continue
    local dest="$adir/kanban-log-${ym}.md"
    if [[ -z "${months_seen[$ym]:-}" ]]; then
      if [[ ! -f "$dest" ]]; then
        printf '# kanban summary — %s\n\n' "$ym" >> "$dest"
      else
        printf '\n---\n\n' >> "$dest"
      fi
      printf '_groom run: %s_\n\n' "$(date +'%Y-%m-%d %H:%M:%S %Z')" >> "$dest"
      months_seen[$ym]=1
    fi
    # `--` terminates printf option parsing — without it, the leading `-`
    # in the format string trips printf with the "invalid option" error.
    printf -- '- `%s` [%s] %s — owner=%s, completed=%s\n' \
      "$id" "$status" "$subject" "$owner" "$cdate" >> "$dest"
  done <<<"$rows"

  # Rewrite kanban.json without the stale tasks. atmux::jq_update is the
  # canonical safe-write entrypoint (post-write JSON sanity probe + warn
  # on corruption).
  # atmux::jq_update signature: <file> <filter> [jq-args...] — filter
  # comes BEFORE --argjson, not after.
  atmux::jq_update "$src" '
    def to_epoch:
      if . == null then 0
      elif type == "number" then .
      elif type == "string" then (fromdateiso8601? // (tonumber? // 0))
      else 0 end;
    .tasks |= map(
      select(
        (.status != "done" and .status != "cancelled")
        or ((.completedAt // 0) | to_epoch) == 0
        or ((.completedAt // 0) | to_epoch) >= $cutoff
      )
    )
  ' --argjson cutoff "$cutoff_epoch" \
    || atmux::warn "groom: kanban.json rewrite failed — backup retained"

  [[ "$quiet" -eq 0 ]] && atmux::ok "groom: summarized + removed $stale_n stale kanban card(s)"
}

# ---------- bak cull ----------

_groom_cull_bak() {
  local d="$1" keep="$2" dry_run="$3" quiet="$4"
  local family
  for family in kanban.json team.json; do
    # ls -t orders newest-first; tail -n +<keep+1> drops the newest N.
    # nullglob avoids "no match" expansion errors when no .bak.* exists.
    shopt -s nullglob
    local baks=( "$d/${family}.bak."* )
    shopt -u nullglob
    [[ ${#baks[@]} -le $keep ]] && continue

    # Sort by mtime newest-first; targets = everything past index `keep`.
    local sorted
    sorted="$(ls -t "${baks[@]}")"
    local stale
    stale="$(printf '%s\n' "$sorted" | tail -n +$((keep + 1)))"
    [[ -z "$stale" ]] && continue

    local stale_n
    stale_n="$(printf '%s\n' "$stale" | wc -l)"

    if [[ "$dry_run" -eq 1 ]]; then
      [[ "$quiet" -eq 0 ]] && \
        atmux::log "groom[dry-run]: would delete $stale_n stale ${family}.bak.* (keeping newest $keep)"
      continue
    fi

    printf '%s\n' "$stale" | xargs rm -f --
    [[ "$quiet" -eq 0 ]] && atmux::ok "groom: culled $stale_n stale ${family}.bak.*"
  done
}

# ---------- size guard ----------

# Warn (non-fatal) when archive/ growth crosses thresholds. Lets the driver
# know if a single team's grooming is producing more log volume than the
# token-saving payoff justifies.
_groom_size_check() {
  local adir="$1" quiet="$2"
  [[ -d "$adir" ]] || return 0

  local total_bytes
  total_bytes="$(du -sb "$adir" 2>/dev/null | awk '{print $1}')"
  [[ -z "$total_bytes" ]] && return 0

  local mb=$(( total_bytes / 1024 / 1024 ))
  # 50 MB total archive — warn. Indicates the team has been very busy
  # OR the kanban-summarize sub-op is mis-tuned (maybe --kanban-days too
  # aggressive, retaining too much detail). operator's call.
  if [[ $mb -ge 50 ]]; then
    atmux::warn "groom: archive/ at ${mb} MB — consider raising --kanban-days or pruning oldest archive files manually"
  fi

  shopt -s nullglob
  local kanban_logs=( "$adir"/kanban-log-*.md )
  shopt -u nullglob
  if [[ ${#kanban_logs[@]} -gt 0 ]]; then
    local klog_bytes
    klog_bytes="$(du -cb "${kanban_logs[@]}" 2>/dev/null | tail -1 | awk '{print $1}')"
    local klog_mb=$(( klog_bytes / 1024 / 1024 ))
    if [[ $klog_mb -ge 5 ]]; then
      atmux::warn "groom: kanban-log archive at ${klog_mb} MB across ${#kanban_logs[@]} months — growth check"
    fi
  fi
}
