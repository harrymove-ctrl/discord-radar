import { isQuarantinedDm } from "./security.ts";
import type { NormalizedMessage } from "./types.ts";

export interface SnapshotMeta {
  guildId: string;
  channelId: string;
  channelName?: string;
}

const TIMESTAMP_AUTHOR_LINE_RE =
  /^\[([^\]]+)\]\s+([^:]{1,64}):\s+(.+)$/;

interface JsonMessageLike {
  id?: unknown;
  messageId?: unknown;
  guildId?: unknown;
  guild_id?: unknown;
  channelId?: unknown;
  channel_id?: unknown;
  channelName?: unknown;
  channel_name?: unknown;
  author?: unknown;
  authorId?: unknown;
  author_id?: unknown;
  authorName?: unknown;
  author_name?: unknown;
  username?: unknown;
  text?: unknown;
  content?: unknown;
  timestamp?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
  attachments?: unknown;
  attachmentUrls?: unknown;
  attachment_urls?: unknown;
  role?: unknown;
  name?: unknown;
  children?: unknown;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function collectAccessibilityTexts(node: JsonMessageLike, out: string[]): void {
  const role = asString(node.role).toLowerCase();
  const name = asString(node.name);
  if (name && (role === "listitem" || role === "article" || role === "statictext" || role === "text")) {
    out.push(name);
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      if (child && typeof child === "object") {
        collectAccessibilityTexts(child as JsonMessageLike, out);
      }
    }
  }
}

function normalizeJsonItem(item: JsonMessageLike, meta: SnapshotMeta): NormalizedMessage | null {
  const content = asString(item.content) || asString(item.text);
  if (!content) return null;

  const guildId = asString(item.guildId) || asString(item.guild_id) || meta.guildId;
  const channelId = asString(item.channelId) || asString(item.channel_id) || meta.channelId;
  const channelName =
    asString(item.channelName) || asString(item.channel_name) || meta.channelName || channelId;

  if (isQuarantinedDm(guildId, channelName)) {
    return null;
  }

  const authorObj =
    item.author && typeof item.author === "object"
      ? (item.author as { id?: unknown; username?: unknown; global_name?: unknown; name?: unknown })
      : null;

  const authorName =
    asString(item.authorName) ||
    asString(item.author_name) ||
    asString(item.username) ||
    (authorObj ? asString(authorObj.global_name) || asString(authorObj.username) || asString(authorObj.name) : asString(item.author)) ||
    "unknown";

  const authorId =
    asString(item.authorId) ||
    asString(item.author_id) ||
    (authorObj ? asString(authorObj.id) : "") ||
    authorName;

  const rawAttachments = Array.isArray(item.attachmentUrls)
    ? item.attachmentUrls
    : Array.isArray(item.attachment_urls)
      ? item.attachment_urls
      : Array.isArray(item.attachments)
        ? item.attachments
        : [];

  const attachmentUrls = rawAttachments
    .map((entry) => {
      if (typeof entry === "string") return entry.trim();
      if (entry && typeof entry === "object" && "url" in entry) {
        return asString((entry as { url?: unknown }).url);
      }
      return "";
    })
    .filter(Boolean);

  return {
    messageId: asString(item.messageId) || asString(item.id) || undefined,
    guildId,
    channelId,
    channelName,
    authorId,
    authorName,
    content,
    attachmentUrls,
    createdAt: asString(item.createdAt) || asString(item.created_at) || asString(item.timestamp) || new Date().toISOString(),
    sourceTier: "browser_snapshot",
  };
}

/**
 * Parse read only Chrome DevTools or OpenCLI DOM snapshots into normalized messages.
 * Auth keys, cookies, and storage payloads are intentionally ignored.
 */
export function parseBrowserSnapshot(raw: string, meta: SnapshotMeta): NormalizedMessage[] {
  const trimmed = raw.trim();
  if (!trimmed || isQuarantinedDm(meta.guildId, meta.channelName)) {
    return [];
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const results: NormalizedMessage[] = [];

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === "object") {
            const msg = normalizeJsonItem(item as JsonMessageLike, meta);
            if (msg) results.push(msg);
          }
        }
        return results;
      }

      if (parsed && typeof parsed === "object") {
        const obj = parsed as { messages?: unknown; role?: unknown; children?: unknown };
        if (Array.isArray(obj.messages)) {
          for (const item of obj.messages) {
            if (item && typeof item === "object") {
              const msg = normalizeJsonItem(item as JsonMessageLike, meta);
              if (msg) results.push(msg);
            }
          }
          return results;
        }
        if (obj.role || obj.children) {
          const lines: string[] = [];
          collectAccessibilityTexts(obj as JsonMessageLike, lines);
          return parsePlainTextLines(lines, meta);
        }
      }
    } catch {
      // Fall back to line oriented parsing below
    }
  }

  return parsePlainTextLines(trimmed.split(/\r?\n/), meta);
}

function parsePlainTextLines(lines: string[], meta: SnapshotMeta): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  const defaultTs = new Date().toISOString();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(TIMESTAMP_AUTHOR_LINE_RE);
    if (match) {
      out.push({
        guildId: meta.guildId,
        channelId: meta.channelId,
        channelName: meta.channelName ?? meta.channelId,
        authorId: match[2]!.trim(),
        authorName: match[2]!.trim(),
        content: match[3]!.trim(),
        createdAt: match[1]!.trim(),
        sourceTier: "browser_snapshot",
      });
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx > 0 && colonIdx <= 40 && !line.startsWith("http")) {
      const author = line.slice(0, colonIdx).trim();
      const content = line.slice(colonIdx + 1).trim();
      if (author && content) {
        out.push({
          guildId: meta.guildId,
          channelId: meta.channelId,
          channelName: meta.channelName ?? meta.channelId,
          authorId: author,
          authorName: author,
          content,
          createdAt: defaultTs,
          sourceTier: "browser_snapshot",
        });
      }
    }
  }

  return out;
}
