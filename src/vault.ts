import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { anonymizeExternalText, isQuarantinedDm, validateDiscordCdnUrl } from "./security.ts";
import type { CrawlCursor, IngestSummary, NormalizedMessage, SourceTier, StoredMessage } from "./types.ts";

interface MessageRow {
  dedup_key: string;
  message_id: string;
  guild_id: string;
  channel_id: string;
  thread_id?: string;
  channel_name: string;
  author_ref: string;
  content: string;
  attachments_json: string;
  created_at: string;
  source_tier: SourceTier;
  ingested_at: string;
}

function rowToStored(row: MessageRow): StoredMessage {
  let attachments: string[] = [];
  try {
    const parsed = JSON.parse(row.attachments_json);
    if (Array.isArray(parsed)) {
      attachments = parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    attachments = [];
  }
  const threadId = typeof row.thread_id === "string" ? row.thread_id.trim() : "";
  return {
    dedupKey: row.dedup_key,
    messageId: row.message_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    ...(threadId ? { threadId } : {}),
    channelName: row.channel_name,
    authorRef: row.author_ref,
    content: row.content,
    attachments,
    createdAt: row.created_at,
    sourceTier: row.source_tier,
    ingestedAt: row.ingested_at,
  };
}

function buildFtsQuery(rawQuery: string): string {
  const terms = rawQuery
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[^A-Za-z0-9_]/g, ""))
    .filter(Boolean);
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t}"`).join(" AND ");
}

/** Local SQLite WAL and FTS5 message vault enforcing DM quarantine and 0600 permissions. */
export class RadarVault {
  private readonly db: Database;
  private readonly speakerMap = new Map<string, string>();
  public readonly dbPath: string;

  constructor(dbPath = ":memory:") {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") {
      const parent = path.dirname(path.resolve(dbPath));
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(parent, 0o700);
      } catch {
        // Ignore chmod failure only on non standard virtual filesystems
      }
    }

    this.db = new Database(dbPath, { create: true });

    if (dbPath !== ":memory:" && fs.existsSync(dbPath)) {
      try {
        fs.chmodSync(dbPath, 0o600);
      } catch {
        // Best effort permission hardening
      }
    }

    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS messages (
        dedup_key TEXT PRIMARY KEY,
        message_id TEXT NOT NULL DEFAULT '',
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL DEFAULT '',
        channel_name TEXT NOT NULL,
        author_ref TEXT NOT NULL,
        content TEXT NOT NULL,
        attachments_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source_tier TEXT NOT NULL,
        ingested_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_guild_time ON messages(guild_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_channel_time ON messages(channel_id, created_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        channel_name,
        content='messages',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, channel_name)
        VALUES (new.rowid, new.content, new.channel_name);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, channel_name)
        VALUES ('delete', old.rowid, old.content, old.channel_name);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, channel_name)
        VALUES ('delete', old.rowid, old.content, old.channel_name);
        INSERT INTO messages_fts(rowid, content, channel_name)
        VALUES (new.rowid, new.content, new.channel_name);
      END;

      CREATE TABLE IF NOT EXISTS crawl_cursors (
        source_key TEXT PRIMARY KEY,
        last_rowid INTEGER NOT NULL DEFAULT 0,
        last_updated_at TEXT NOT NULL DEFAULT '',
        last_message_id TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
    `);

    const cols = this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "thread_id")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN thread_id TEXT NOT NULL DEFAULT '';");
    }
  }

  /** Ingest normalized messages across Bot, desktop cache wiretap, or browser snapshots. */
  ingestMessages(items: NormalizedMessage[]): IngestSummary {
    let inserted = 0;
    const insertedDedupKeys: string[] = [];
    let skippedDuplicates = 0;
    let quarantinedDmCount = 0;
    let rejectedAttachmentCount = 0;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages (
        dedup_key,
        message_id,
        guild_id,
        channel_id,
        thread_id,
        channel_name,
        author_ref,
        content,
        attachments_json,
        created_at,
        source_tier,
        ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const nowIso = new Date().toISOString();

    const runBatch = this.db.transaction((batch: NormalizedMessage[]) => {
      for (const item of batch) {
        if (isQuarantinedDm(item.guildId, item.channelName)) {
          quarantinedDmCount += 1;
          continue;
        }

        const safeAttachments: string[] = [];
        for (const url of item.attachmentUrls ?? []) {
          if (validateDiscordCdnUrl(url)) {
            safeAttachments.push(url);
          } else {
            rejectedAttachmentCount += 1;
          }
        }

        const trimmedMsgId = (item.messageId ?? "").trim();
        const rawAuthor = item.authorId?.trim() || item.authorName.trim() || "unknown";
        const isExternal = item.sourceTier !== "bot_api";

        let authorRef = rawAuthor;
        let storedContent = item.content.trim();
        if (isExternal) {
          const anonymized = anonymizeExternalText(storedContent, this.speakerMap, rawAuthor);
          authorRef = anonymized.speakerLabel;
          storedContent = anonymized.cleanText;
        }

        const channelId = item.channelId.trim();
        const threadId = (item.threadId ?? "").trim();
        const channelName = (item.channelName ?? channelId).trim();
        const createdAt = item.createdAt.trim() || nowIso;

        const dedupKey = trimmedMsgId
          ? `msg:${trimmedMsgId}`
          : `sha:${crypto
              .createHash("sha256")
              .update(`${channelId}|${createdAt}|${rawAuthor}|${storedContent}`)
              .digest("hex")}`;

        const result = stmt.run(
          dedupKey,
          trimmedMsgId,
          item.guildId.trim(),
          channelId,
          threadId,
          channelName,
          authorRef,
          storedContent,
          JSON.stringify(safeAttachments),
          createdAt,
          item.sourceTier,
          nowIso
        );

        if (result.changes > 0) {
          inserted += 1;
          insertedDedupKeys.push(dedupKey);
        } else {
          skippedDuplicates += 1;
        }
      }
    });

    runBatch(items);

    return {
      inserted,
      insertedDedupKeys,
      skippedDuplicates,
      quarantinedDmCount,
      rejectedAttachmentCount,
    };
  }

  /** Fetch specific newly ingested rows by their dedupKey values excluding @me DMs. */
  getMessagesByDedupKeys(dedupKeys: string[]): StoredMessage[] {
    const uniqueKeys = Array.from(new Set(dedupKeys.map((k) => k.trim()).filter(Boolean)));
    if (uniqueKeys.length === 0) return [];

    const out: StoredMessage[] = [];
    const chunkSize = 400;
    for (let i = 0; i < uniqueKeys.length; i += chunkSize) {
      const chunk = uniqueKeys.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `
          SELECT m.*
          FROM messages m
          WHERE m.dedup_key IN (${placeholders}) AND lower(m.guild_id) != '@me'
          `
        )
        .all(...chunk) as MessageRow[];
      for (const row of rows) {
        out.push(rowToStored(row));
      }
    }

    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Fetch vault messages inserted after a given SQLite rowid watermark. */
  messagesAfterRowid(
    afterRowid: number,
    limit = 1000
  ): { messages: StoredMessage[]; maxRowid: number; cursorReset: boolean } {
    const meta = this.db
      .prepare("SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM messages")
      .get() as { max_rowid: number };
    const maxRowid = meta?.max_rowid ?? 0;
    const cursorReset = afterRowid > 0 && maxRowid < afterRowid;
    const effectiveAfter = cursorReset ? 0 : Math.max(0, afterRowid);
    const rows = this.db
      .prepare(
        `
        SELECT m.*
        FROM messages m
        WHERE m.rowid > ? AND lower(m.guild_id) != '@me'
        ORDER BY m.created_at DESC
        LIMIT ?
        `
      )
      .all(effectiveAfter, Math.max(1, limit)) as MessageRow[];
    return {
      messages: rows.map(rowToStored),
      maxRowid,
      cursorReset,
    };
  }

  /** Read a persisted incremental crawl watermark by source key. */
  getCrawlCursor(sourceKey: string): CrawlCursor | null {
    const row = this.db
      .prepare(
        `
        SELECT source_key, last_rowid, last_updated_at, last_message_id, updated_at
        FROM crawl_cursors
        WHERE source_key = ?
        `
      )
      .get(sourceKey) as
      | {
          source_key: string;
          last_rowid: number;
          last_updated_at: string;
          last_message_id: string;
          updated_at: string;
        }
      | undefined;

    if (!row) return null;
    return {
      sourceKey: row.source_key,
      lastRowid: row.last_rowid,
      lastUpdatedAt: row.last_updated_at,
      lastMessageId: row.last_message_id,
      updatedAt: row.updated_at,
    };
  }

  /** Persist an updated incremental crawl watermark by source key. */
  setCrawlCursor(input: {
    sourceKey: string;
    lastRowid: number;
    lastUpdatedAt?: string;
    lastMessageId?: string;
  }): CrawlCursor {
    const updatedAt = new Date().toISOString();
    const lastUpdatedAt = (input.lastUpdatedAt ?? "").trim();
    const lastMessageId = (input.lastMessageId ?? "").trim();
    const lastRowid = Math.max(0, Math.floor(input.lastRowid));

    this.db
      .prepare(
        `
        INSERT INTO crawl_cursors (source_key, last_rowid, last_updated_at, last_message_id, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source_key) DO UPDATE SET
          last_rowid = excluded.last_rowid,
          last_updated_at = excluded.last_updated_at,
          last_message_id = excluded.last_message_id,
          updated_at = excluded.updated_at
        `
      )
      .run(input.sourceKey, lastRowid, lastUpdatedAt, lastMessageId, updatedAt);

    return {
      sourceKey: input.sourceKey,
      lastRowid,
      lastUpdatedAt,
      lastMessageId,
      updatedAt,
    };
  }

  /** Run FTS5 full text search excluding quarantined @me DMs. */
  searchMessages(
    query: string,
    opts: { guildId?: string; channelId?: string; limit?: number } = {}
  ): StoredMessage[] {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) {
      return [];
    }
    const conditions = ["messages_fts MATCH ?", "lower(m.guild_id) != '@me'"];
    const params: Array<string | number> = [ftsQuery];

    if (opts.guildId) {
      conditions.push("m.guild_id = ?");
      params.push(opts.guildId);
    }
    if (opts.channelId) {
      conditions.push("m.channel_id = ?");
      params.push(opts.channelId);
    }
    params.push(opts.limit ?? 50);

    const rows = this.db
      .prepare(
        `
        SELECT m.*
        FROM messages m
        JOIN messages_fts ON messages_fts.rowid = m.rowid
        WHERE ${conditions.join(" AND ")}
        ORDER BY bm25(messages_fts), m.created_at DESC
        LIMIT ?
        `
      )
      .all(...params) as MessageRow[];

    return rows.map(rowToStored);
  }

  /** Return recent indexed messages within N hours excluding @me DMs. */
  recentMessages(
    hours = 24,
    opts: { guildId?: string; channelId?: string; limit?: number } = {}
  ): StoredMessage[] {
    const cutoff = new Date(Date.now() - Math.max(1, hours) * 3600 * 1000).toISOString();
    const conditions = ["m.created_at >= ?", "lower(m.guild_id) != '@me'"];
    const params: Array<string | number> = [cutoff];

    if (opts.guildId) {
      conditions.push("m.guild_id = ?");
      params.push(opts.guildId);
    }
    if (opts.channelId) {
      conditions.push("m.channel_id = ?");
      params.push(opts.channelId);
    }
    params.push(opts.limit ?? 200);

    const rows = this.db
      .prepare(
        `
        SELECT m.*
        FROM messages m
        WHERE ${conditions.join(" AND ")}
        ORDER BY m.created_at DESC
        LIMIT ?
        `
      )
      .all(...params) as MessageRow[];

    return rows.map(rowToStored);
  }

  /** Return aggregate counts across guilds and capture tiers. */
  getStats(): {
    totalMessages: number;
    tiers: Array<{ sourceTier: SourceTier; count: number }>;
  } {
    const totalRow = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM messages WHERE lower(guild_id) != '@me'")
      .get() as { cnt: number };
    const tiers = this.db
      .prepare(
        `
        SELECT source_tier AS sourceTier, COUNT(*) AS count
        FROM messages
        WHERE lower(guild_id) != '@me'
        GROUP BY source_tier
        ORDER BY count DESC
        `
      )
      .all() as Array<{ sourceTier: SourceTier; count: number }>;

    return {
      totalMessages: totalRow?.cnt ?? 0,
      tiers,
    };
  }

  close(): void {
    this.db.close();
  }
}
