#!/usr/bin/env bash
# scripts/check-adr-links.sh — ADR cross-reference link linter.
#
# Walks every docs/adr/*.md and resolves two kinds of ADR reference
# against the files actually on disk:
#
#   1. Markdown links whose target ends in a `NNN-...md` ADR filename,
#      e.g. `[ADR-219](219-dissolve-epic-completeness.md)` or
#      `[ADR-233](./233-cron-auto-install-disabled-trust-orchd.md)`.
#      Both the literal filename AND the `NNN` it encodes must exist.
#
#   2. Bare `ADR-NNN` references in prose (no markdown link), e.g.
#      "per ADR-219 §D2". The `NNN` must correspond to some ADR file
#      on disk (either `NNN-*.md` or `NNN-*.SUPERSEDED.md`).
#
# A target is satisfied if a file `docs/adr/NNN-*.md` OR
# `docs/adr/NNN-*.SUPERSEDED.md` exists. Markdown-link targets ALSO
# require the exact basename to resolve (catches a stale slug or a
# `.md` ↔ `.SUPERSEDED.md` mismatch).
#
# Rooted at docs/adr/ relative to this script — NEVER scans `/`.
#
# Exit code: 0 = every target resolves; 1 = one or more dangling
# targets (listed on stderr, grouped by source file).

set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
adr_dir="$(cd "$script_dir/../docs/adr" && pwd)" || {
  echo "ERR: cannot resolve docs/adr/ relative to $script_dir" >&2
  exit 2
}

cd "$adr_dir" || { echo "ERR: cannot cd $adr_dir" >&2; exit 2; }

# ---- Build the set of ADR numbers that exist on disk ----
# Keyed by zero-padded 3-digit number; value is the canonical filename.
declare -A num_exists
declare -A basename_exists
for f in *.md; do
  [ "$f" = "INDEX.md" ] && continue
  [ "$f" = "README.md" ] && continue
  basename_exists["$f"]=1
  # Extract leading NNN- prefix.
  if [[ "$f" =~ ^([0-9]{3})- ]]; then
    num_exists["${BASH_REMATCH[1]}"]=1
  fi
done

dangling=0

# ---- Scan each ADR file ----
for src in *.md; do
  [ "$src" = "INDEX.md" ] && continue
  [ "$src" = "README.md" ] && continue

  file_findings=()

  # (1) Markdown-link targets ending in an ADR `.md` filename.
  # Match `](...NNN-....md)` — capture the basename. Allow an optional
  # leading `./` or path prefix; we only care about the final segment.
  while IFS= read -r target; do
    [ -z "$target" ] && continue
    # Strip any anchor (#...) and leading path components.
    base="${target##*/}"
    base="${base%%#*}"
    # Only consider basenames that look like an ADR file.
    [[ "$base" =~ ^[0-9]{3}- ]] || continue
    if [ -z "${basename_exists[$base]:-}" ]; then
      file_findings+=("  dangling md-link: $base")
    fi
  done < <(grep -oE '\]\([^)]*[0-9]{3}-[^)]*\.md[^)]*\)' "$src" \
            | sed -E 's/^\]\(//; s/\)$//')

  # (2) Bare `ADR-NNN` references (prose). Resolve the NNN to disk.
  # Exclude the file's OWN header line (`# ADR-NNN: ...`) — self-ref.
  # Only 2-3 digit forms are atmux-tree ADRs; 4-digit `ADR-NNNN` forms
  # (e.g. ADR-0067) are GLOBAL ~/.claude CLAUDE.md doctrine ADRs in a
  # different tree and are intentionally NOT resolved here.
  self_num=""
  if [[ "$src" =~ ^([0-9]{3})- ]]; then self_num="${BASH_REMATCH[1]}"; fi
  while IFS= read -r n; do
    [ -z "$n" ] && continue
    # Normalize to 3-digit zero-pad for the lookup.
    pad="$(printf '%03d' "$((10#$n))")"
    [ "$pad" = "$self_num" ] && continue
    if [ -z "${num_exists[$pad]:-}" ]; then
      file_findings+=("  dangling ADR-ref: ADR-$n (no docs/adr/$pad-*.md)")
    fi
  done < <(grep -oE 'ADR-[0-9]{2,3}([^0-9]|$)' "$src" \
            | grep -oE 'ADR-[0-9]{2,3}' \
            | sed -E 's/^ADR-//' \
            | sort -u)

  if [ "${#file_findings[@]}" -gt 0 ]; then
    dangling=$((dangling + ${#file_findings[@]}))
    {
      echo "✗ $src"
      # Deduplicate findings within the file.
      printf '%s\n' "${file_findings[@]}" | sort -u
    } >&2
  fi
done

if [ "$dangling" -gt 0 ]; then
  echo >&2
  echo "✗ check-adr-links: $dangling dangling ADR target(s) across docs/adr/" >&2
  exit 1
fi

echo "✓ check-adr-links: all ADR cross-references resolve in docs/adr/"
exit 0
