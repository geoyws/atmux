#!/usr/bin/env bash
# scripts/provision-fallback-user.sh — ADR-058 §D2: idempotent Tier 3+ user provisioning.
#
# Provisions a dedicated Linux user for fallback executors (Tier 3 Kimi,
# Tier 4 MiniMax). Per ADR-058 §D2, isolation is `setfacl rX` + dedicated
# user (no chroot, no container) — kernel-enforced read-only access to
# the project tree, no .git/credentials leak, no write to source.
#
# OPERATOR-DRIVEN. Run once per agent identity per machine. Re-runs are
# no-ops (idempotent). Safe to re-run during budget-pause incidents.
# NEVER auto-invoked from worker panes — provisioning is policy-gated.
#
# Usage:
#   scripts/provision-fallback-user.sh <agent>
#   scripts/provision-fallback-user.sh --refresh-auth <agent>   # OQ1 path
#   scripts/provision-fallback-user.sh --dry-run <agent>        # print, no side effects
#   scripts/provision-fallback-user.sh --help
#
# Supported agents: kimi-agent (Tier 3), minimax-agent (Tier 4 stub).
#
# Env (test/CI overrides):
#   ATMUX_PROVISION_PROJECT_ROOT  override project root (default: <script>/..)
#   ATMUX_PROVISION_HOME_PREFIX   override /home (default: /home; tests use tmpdir)
#   ATMUX_PROVISION_SUDO          override sudo command (default: sudo)
#   ATMUX_PROVISION_SOURCE_HOME   override $HOME for auth-config source (default: $HOME)

set -euo pipefail

# ---------- defaults ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
PROJECT_ROOT="${ATMUX_PROVISION_PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
readonly PROJECT_ROOT
readonly HOME_PREFIX="${ATMUX_PROVISION_HOME_PREFIX:-/home}"
readonly SUDO_CMD="${ATMUX_PROVISION_SUDO:-sudo}"
readonly SOURCE_HOME="${ATMUX_PROVISION_SOURCE_HOME:-${HOME:-/root}}"

DRY_RUN=0
REFRESH_AUTH=0
AGENT=""

# ---------- helpers ----------
log() {
  printf '[%s] %s\n' "$(TZ='Asia/Kuala_Lumpur' date +'%Y-%m-%d %H:%M:%S MYT')" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit "${EXIT_CODE:-1}"
}

usage() {
  cat <<'EOF'
provision-fallback-user.sh — ADR-058 §D2 idempotent Tier 3+ user provisioning.

USAGE:
  scripts/provision-fallback-user.sh <agent>
  scripts/provision-fallback-user.sh --refresh-auth <agent>
  scripts/provision-fallback-user.sh --dry-run <agent>
  scripts/provision-fallback-user.sh --help

AGENTS:
  kimi-agent       Tier 3 (Kimi CLI)
  minimax-agent    Tier 4 stub (CLI not yet GA)

OPERATOR-DRIVEN. Re-runs are no-ops. Sudo required (use sudo -v first).
EOF
}

# Run a command (or print it under --dry-run).
run() {
  if [[ "$DRY_RUN" == 1 ]]; then
    printf 'DRY-RUN: %s\n' "$*"
    return 0
  fi
  "$@"
}

# ---------- argv parse ----------
while (($#)); do
  case "$1" in
    --dry-run)      DRY_RUN=1; shift ;;
    --refresh-auth) REFRESH_AUTH=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    --)             shift; break ;;
    -*)             EXIT_CODE=2 die "unknown flag: $1" ;;
    *)
      [[ -z "$AGENT" ]] || EXIT_CODE=2 die "extra positional arg: $1 (already have agent=$AGENT)"
      AGENT="$1"
      shift
      ;;
  esac
done

if [[ -z "$AGENT" ]]; then
  usage >&2
  exit 2
fi

# ---------- agent name validation ----------
if [[ ! "$AGENT" =~ ^[a-z][a-z0-9-]{2,30}$ ]]; then
  EXIT_CODE=2 die "invalid agent name: $AGENT (must match ^[a-z][a-z0-9-]{2,30}\$)"
fi

case "$AGENT" in
  kimi-agent|minimax-agent) ;;
  *) EXIT_CODE=2 die "unsupported agent: $AGENT (supported: kimi-agent, minimax-agent)" ;;
esac

readonly AGENT_HOME="$HOME_PREFIX/$AGENT"
readonly AGENT_CAGES="$AGENT_HOME/cages"

# ---------- preflight ----------
[[ -d "$PROJECT_ROOT" ]] || die "PROJECT_ROOT=$PROJECT_ROOT not a directory"

log "provision-fallback-user: agent=$AGENT project_root=$PROJECT_ROOT dry_run=$DRY_RUN refresh_auth=$REFRESH_AUTH"

# ---------- auth-config copy (shared by step 4 + --refresh-auth) ----------
# Uses `cp -au` for overwrite-on-newer-mtime semantics — idempotent on
# re-run AND satisfies --refresh-auth's update path with no branching.
copy_auth_config() {
  local agent="$1"
  local src dst

  case "$agent" in
    kimi-agent)
      src="$SOURCE_HOME/.config/kimi-cli"
      dst="$AGENT_HOME/.config/kimi-cli"
      if [[ ! -d "$src" ]]; then
        log "step 4: kimi-cli config absent at $src; skipping auth copy (operator may not yet be configured)"
        return 0
      fi
      log "step 4: copy $src → $dst (overwrite-on-newer-mtime)"
      run "$SUDO_CMD" install -d -m 700 -o "$agent" -g "$agent" "$AGENT_HOME/.config"
      run "$SUDO_CMD" install -d -m 700 -o "$agent" -g "$agent" "$dst"
      run "$SUDO_CMD" cp -au "$src/." "$dst/"
      run "$SUDO_CMD" chown -R "$agent:$agent" "$dst"
      run "$SUDO_CMD" chmod -R u=rwX,g=,o= "$dst"
      ;;
    minimax-agent)
      log "step 4: Tier 4 CLI not yet GA — auth-copy skipped"
      ;;
    *)
      die "unreachable: agent $agent"
      ;;
  esac
}

# ---------- --refresh-auth fast path: only step 4 ----------
if [[ "$REFRESH_AUTH" == 1 ]]; then
  if ! getent passwd "$AGENT" >/dev/null 2>&1; then
    die "--refresh-auth requires existing user; $AGENT not provisioned (run without --refresh-auth first)"
  fi
  log "refresh-auth path: skipping steps 1-3, only refreshing auth-config"
  copy_auth_config "$AGENT"
  log "provision-fallback-user: OK ($AGENT, --refresh-auth)"
  exit 0
fi

# ---------- 1. useradd (skip if exists) ----------
if getent passwd "$AGENT" >/dev/null 2>&1; then
  log "step 1: user $AGENT exists; skipping useradd"
else
  log "step 1: useradd -m -s /bin/false -d $AGENT_HOME $AGENT"
  run "$SUDO_CMD" useradd -m -s /bin/false -d "$AGENT_HOME" "$AGENT"
fi

# ---------- 2. cages dir (mkdir -p semantics via install -d) ----------
log "step 2: install -d $AGENT_CAGES (mode 755, owner $AGENT)"
run "$SUDO_CMD" install -d -m 755 -o "$AGENT" -g "$AGENT" "$AGENT_CAGES"

# ---------- 3. setfacl rX (idempotent — re-running rewrites same ACL) ----------
log "step 3: setfacl -R -m u:$AGENT:rX $PROJECT_ROOT"
run "$SUDO_CMD" setfacl -R -m "u:$AGENT:rX" "$PROJECT_ROOT"

# ---------- 4. auth-config copy ----------
copy_auth_config "$AGENT"

log "provision-fallback-user: OK ($AGENT)"
