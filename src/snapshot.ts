import { isQuarantinedDm } from "./security.ts";
import type { NormalizedMessage } from "./types.ts";

export interface SnapshotMeta {
  guildId: string;
  channelId: string;
  channelName?: string;
}

const TIMESTAMP_AUTHOR_LINE_RE =
  /^\[([^\]]+)\]\s+([^:]{1,64}):\s+(.+)$/;

interface EmbedFieldLike {
  name?: unknown;
  value?: unknown;
}

interface EmbedLike {
  title?: unknown;
  description?: unknown;
  fields?: unknown;
}

interface JsonMessageLike {
  id?: unknown;
  messageId?: unknown;
  message_id?: unknown;
  guildId?: unknown;
  guild_id?: unknown;
  channelId?: unknown;
  channel_id?: unknown;
  threadId?: unknown;
  thread_id?: unknown;
  channelName?: unknown;
  channel_name?: unknown;
  author?: unknown;
  Author?: unknown;
  authorId?: unknown;
  author_id?: unknown;
  authorName?: unknown;
  author_name?: unknown;
  username?: unknown;
  text?: unknown;
  content?: unknown;
  Message?: unknown;
  timestamp?: unknown;
  Time?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
  embeds?: unknown;
  reply_to?: unknown;
  referenced_message?: unknown;
  replyPreview?: unknown;
  attachments?: unknown;
  attachmentUrls?: unknown;
  attachment_urls?: unknown;
  role?: unknown;
  name?: unknown;
  children?: unknown;
}

const DATE_DIVIDER_AUTHOR_RE =
  /^\[\d{1,2}:\d{2}\]\s*(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)|^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2}$/i;

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function sanitizeAuthorCandidate(raw: string): string {
  const cleaned = raw.trim();
  if (!cleaned || DATE_DIVIDER_AUTHOR_RE.test(cleaned)) {
    return "";
  }
  return cleaned;
}

function extractEmbedText(rawEmbeds: unknown): string {
  if (!Array.isArray(rawEmbeds)) return "";
  const parts: string[] = [];
  for (const raw of rawEmbeds) {
    if (!raw || typeof raw !== "object") continue;
    const embed = raw as EmbedLike;
    const title = asString(embed.title);
    const description = asString(embed.description);
    if (title) parts.push(title);
    if (description) parts.push(description);
    if (Array.isArray(embed.fields)) {
      for (const f of embed.fields) {
        if (!f || typeof f !== "object") continue;
        const field = f as EmbedFieldLike;
        const name = asString(field.name);
        const value = asString(field.value);
        if (name && value) parts.push(`${name}: ${value}`);
        else if (value) parts.push(value);
      }
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function isErrorEnvelope(obj: Record<string, unknown>): boolean {
  if (obj.ok === false) return true;
  const err = asString(obj.error);
  if (err && !Array.isArray(obj.messages)) {
    return true;
  }
  return false;
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
  let content = asString(item.content) || asString(item.text) || asString(item.Message);
  const replyPreview =
    asString(item.replyPreview) ||
    (item.reply_to && typeof item.reply_to === "object"
      ? asString((item.reply_to as { content?: unknown; text?: unknown }).content) ||
        asString((item.reply_to as { text?: unknown }).text)
      : "") ||
    (item.referenced_message && typeof item.referenced_message === "object"
      ? asString((item.referenced_message as { content?: unknown }).content)
      : "");

  if (!content) {
    content = extractEmbedText(item.embeds);
  } else if (replyPreview && content === replyPreview) {
    // OpenCLI Issue #2768: guard when reply row extraction accidentally captures only quoted preview
    const embedFallback = extractEmbedText(item.embeds);
    if (embedFallback) {
      content = embedFallback;
    }
  }
  if (!content) return null;

  const guildId = asString(item.guildId) || asString(item.guild_id) || meta.guildId;
  const channelId = asString(item.channelId) || asString(item.channel_id) || meta.channelId;
  const threadId = asString(item.threadId) || asString(item.thread_id) || undefined;
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
    sanitizeAuthorCandidate(asString(item.authorName)) ||
    sanitizeAuthorCandidate(asString(item.author_name)) ||
    sanitizeAuthorCandidate(asString(item.username)) ||
    sanitizeAuthorCandidate(asString(item.Author)) ||
    sanitizeAuthorCandidate(
      authorObj
        ? asString(authorObj.global_name) || asString(authorObj.username) || asString(authorObj.name)
        : asString(item.author)
    ) ||
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
    messageId: asString(item.messageId) || asString(item.message_id) || asString(item.id) || undefined,
    guildId,
    channelId,
    ...(threadId ? { threadId } : {}),
    channelName,
    authorId,
    authorName,
    content,
    attachmentUrls,
    createdAt:
      asString(item.createdAt) ||
      asString(item.created_at) ||
      asString(item.Time) ||
      asString(item.timestamp) ||
      new Date().toISOString(),
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
        const obj = parsed as Record<string, unknown>;
        if (isErrorEnvelope(obj)) {
          return [];
        }
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
