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

if [[ "$WIRETAP_FLAG" == "--full-cache" ]]; then
  "$DISCRAWL_EXEC" --config "$CONFIG_PATH" wiretap --full-cache
else
  "$DISCRAWL_EXEC" --config "$CONFIG_PATH" wiretap
fi

DB_PATH="$(grep -E '^\s*db_path\s*=' "$CONFIG_PATH" | head -n1 | sed -E 's/^\s*db_path\s*=\s*["'\'']([^"'\'']+)["'\''].*$/\1/' || true)"
DB_PATH="${DB_PATH:-.state/discrawl-external.db}"

SQL_QUERY="SELECT m.id AS message_id, m.guild_id, m.channel_id, COALESCE(c.name, m.channel_id) AS channel_name, m.author_id, COALESCE(NULLIF(m.content, ''), m.normalized_content, '') AS content, m.created_at FROM messages m LEFT JOIN channels c ON c.id = m.channel_id WHERE lower(m.guild_id) != '@me' AND trim(COALESCE(NULLIF(m.content, ''), m.normalized_content, '')) != '' ORDER BY m.created_at DESC LIMIT 500"

bun -e 'import { Database } from "bun:sqlite"; const db = new Database(process.argv[1]); try { db.exec("PRAGMA query_only = ON;"); for (const r of db.query(process.argv[2]).all()) console.log(JSON.stringify(r)); } finally { db.close(); }' "$DB_PATH" "$SQL_QUERY" | \
  bun run src/cli.ts ingest-jsonl --tier desktop_wiretap --db "${RADAR_DB_PATH:-.state/radar.db}" --json
