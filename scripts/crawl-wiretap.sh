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

if [[ "$WIRETAP_FLAG" == "--full-cache" ]]; then
  "$DISCRAWL_EXEC" --config "$CONFIG_PATH" wiretap --full-cache
else
  "$DISCRAWL_EXEC" --config "$CONFIG_PATH" wiretap
fi

SQL_QUERY="SELECT m.id AS message_id, m.guild_id, m.channel_id, COALESCE(c.name, m.channel_id) AS channel_name, m.author_id, m.content, m.created_at FROM messages m LEFT JOIN channels c ON c.id = m.channel_id WHERE lower(m.guild_id) != '@me' ORDER BY m.created_at DESC LIMIT 500"

"$DISCRAWL_EXEC" --config "$CONFIG_PATH" sql "$SQL_QUERY" --jsonl | \
  bun run src/cli.ts ingest-jsonl --tier desktop_wiretap --db "${RADAR_DB_PATH:-.state/radar.db}" --json
