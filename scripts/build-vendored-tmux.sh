#!/usr/bin/env bash
# scripts/build-vendored-tmux.sh — fetch + verify + build the pinned tmux.
#
# ADR-191 (vendored tmux at /opt/atmux/<v>/bin/tmux, pinned per
# tmux/PINNED_VERSION) + ADR-241 D1 (package.json build:install runs
# this). Builds as the invoking user into --stage (default
# dist-vendored/); the caller sudo-installs the staged binary, so no
# privilege lives in this script. Idempotent: a staged binary already
# reporting the pinned version short-circuits.
#
#   bash scripts/build-vendored-tmux.sh [--version V] [--stage DIR]
#       [--jobs N] [--force] [--no-smoke]
#
# Build deps: curl, shasum (or sha256sum), tar, make, C toolchain,
# bison, pkg-config, libevent + ncurses dev files. macOS: brew
# install libevent (ncurses ships with the SDK); Linux: distro
# libevent-dev + libncurses-dev. Fails closed when anything is absent.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION=""
STAGE="$ROOT/dist-vendored"
JOBS=""
FORCE=0
SMOKE=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --stage) STAGE="$2"; shift 2 ;;
    --jobs) JOBS="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --no-smoke) SMOKE=0; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "build-vendored-tmux: unknown flag $1" >&2; exit 2 ;;
  esac
done

if [ -z "$VERSION" ]; then
  VERSION="$(tr -d '[:space:]' < "$ROOT/tmux/PINNED_VERSION")"
fi
TARBALL="tmux-${VERSION}.tar.gz"
URL="https://github.com/tmux/tmux/releases/download/${VERSION}/${TARBALL}"
STAGED_BIN="$STAGE/bin/tmux"

if [ "$FORCE" -eq 0 ] && [ -x "$STAGED_BIN" ]; then
  if "$STAGED_BIN" -V 2>/dev/null | grep -q "tmux ${VERSION}\$"; then
    echo "build-vendored-tmux: staged $STAGED_BIN already at $VERSION — skip (pass --force to rebuild)"
    exit 0
  fi
fi

for bin in curl tar make; do
  command -v "$bin" >/dev/null 2>&1 || { echo "build-vendored-tmux: missing required tool: $bin" >&2; exit 1; }
done
if command -v shasum >/dev/null 2>&1; then
  SHASUM="shasum -a 256"
elif command -v sha256sum >/dev/null 2>&1; then
  SHASUM="sha256sum"
else
  echo "build-vendored-tmux: need shasum or sha256sum" >&2; exit 1
fi

if [ -z "$JOBS" ]; then
  if command -v nproc >/dev/null 2>&1; then JOBS="$(nproc)";
  elif [ "$(uname -s)" = "Darwin" ]; then JOBS="$(sysctl -n hw.ncpu)";
  else JOBS=4; fi
fi

# Apple-Silicon Homebrew libevent lands outside the default search path.
if [ "$(uname -s)" = "Darwin" ] && [ -d /opt/homebrew/opt/libevent/lib/pkgconfig ]; then
  export PKG_CONFIG_PATH="/opt/homebrew/opt/libevent/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
fi
WORK="$(mktemp -d "${TMPDIR:-/tmp}/vendored-tmux.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "build-vendored-tmux: fetching $URL"
curl -fSL --retry 3 --max-time 300 -o "$WORK/$TARBALL" "$URL"

echo "build-vendored-tmux: verifying SHA256 against tmux/SHA256SUMS"
EXPECTED="$(grep -F "  $TARBALL" "$ROOT/tmux/SHA256SUMS" | awk '{print $1}')"
if [ -z "$EXPECTED" ]; then
  echo "build-vendored-tmux: no checksum entry for $TARBALL in tmux/SHA256SUMS — refusing" >&2; exit 1
fi
ACTUAL="$(cd "$WORK" && $SHASUM "$TARBALL" | awk '{print $1}')"
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "build-vendored-tmux: CHECKSUM MISMATCH for $TARBALL" >&2
  echo "  expected $EXPECTED" >&2
  echo "  actual   $ACTUAL" >&2
  exit 1
fi

echo "build-vendored-tmux: building tmux $VERSION (jobs=$JOBS)"
tar -xzf "$WORK/$TARBALL" -C "$WORK"
cd "$WORK/tmux-${VERSION}"
# tmux 3.6+ forces an explicit utf8proc choice. --disable-utf8proc keeps
# the vendored binary dependency-free (matches the --disable-utempter
# minimize-surface posture); reviewer signs off per ADR-191 OQ4.
./configure --prefix="$WORK/prefix" --disable-utempter --disable-utf8proc >/dev/null
make -j "$JOBS" >/dev/null
mkdir -p "$STAGE/bin"
cp tmux "$STAGED_BIN"
chmod 755 "$STAGED_BIN"

if ! "$STAGED_BIN" -V 2>/dev/null | grep -q "tmux ${VERSION}\$"; then
  echo "build-vendored-tmux: staged binary failed version check:" >&2
  "$STAGED_BIN" -V >&2 || true
  exit 1
fi

if [ "$SMOKE" -eq 1 ]; then
  SOCK="$WORK/smoke/sock"
  mkdir -p "$WORK/smoke"
  "$STAGED_BIN" -S "$SOCK" new-session -d -s smoke -x 80 -y 24
  "$STAGED_BIN" -S "$SOCK" kill-session -t smoke
  echo "build-vendored-tmux: smoke ok (new-session + kill-session round-trip)"
fi

echo "build-vendored-tmux: staged $STAGED_BIN ($("$STAGED_BIN" -V))"
