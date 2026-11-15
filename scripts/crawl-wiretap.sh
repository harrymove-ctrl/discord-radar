#!/usr/bin/env bash
set -euo pipefail

# Zero network passive cache crawl wrapper isolating external guilds from @me DMs.
umask 077

export DISCRAWL_NO_UPDATE_CHECK=1
export DISCRAWL_NO_AUTO_UPDATE=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

CONFIG_PATH="${1:-${DISCRAWL_CONFIG:-configs/discrawl-external-wiretap.local.toml}}"
WIRETAP_FLAG="${2:-}"
if [[ -z "${DISCRAWL_BIN:-}" && -f "$REPO_ROOT/.env" ]]; then
  ENV_DISCRAWL_BIN="$(grep -E '^DISCRAWL_BIN=' "$REPO_ROOT/.env" | head -n1 | cut -d= -f2- || true)"
  if [[ -n "$ENV_DISCRAWL_BIN" ]]; then
    DISCRAWL_BIN="$ENV_DISCRAWL_BIN"
  fi
fi
DISCRAWL_EXEC="${DISCRAWL_BIN:-discrawl}"

if [[ ! -x "$DISCRAWL_EXEC" ]]; then
  if command -v discrawl >/dev/null 2>&1; then
    DISCRAWL_EXEC="$(command -v discrawl)"
  else
    echo "Missing discrawl executable at $DISCRAWL_EXEC" >&2
    exit 1
  fi
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "Missing wiretap config at $CONFIG_PATH. Copy configs/discrawl-external-wiretap.example.toml first." >&2
  exit 1
fi

mkdir -p .state
chmod 700 .state
chmod 600 "$CONFIG_PATH"

export DISCRAWL_BIN="$DISCRAWL_EXEC"
EXTRA_ARGS=()
if [[ "$WIRETAP_FLAG" == "--full-cache" ]]; then
  EXTRA_ARGS+=(--full-cache)
fi

exec bun run src/cli.ts ingest-wiretap \
  --wiretap-config "$CONFIG_PATH" \
  "${EXTRA_ARGS[@]}" \
  --db "${RADAR_DB_PATH:-.state/radar.db}" \
  --json
