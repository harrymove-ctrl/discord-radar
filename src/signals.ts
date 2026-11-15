import { checkVoiceGate } from "./security.ts";
import type { ContentBrief, SignalCategory, SignalCluster, StoredMessage } from "./types.ts";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "what", "when", "where",
  "which", "your", "about", "into", "more", "some", "there", "they", "would", "could",
  "should", "been", "being", "their", "just", "like", "does", "cant", "dont", "help",
  "anyone", "know", "how", "why", "issue", "problem", "using", "need", "want",
]);

function classifyMessage(content: string): SignalCategory {
  const lower = content.toLowerCase();
  if (/\b(vs|versus|compare|comparison|alternative|better than)\b/.test(lower)) {
    return "comparison_thread";
  }
  if (/\b(error|bug|crash|broken|fail|failed|exception|429|timeout|ban)\b/.test(lower)) {
    return "recurring_bug";
  }
  if (/\b(feature|wish|support|missing|roadmap|plugin|integration|add )\b/.test(lower)) {
    return "feature_demand";
  }
  if (content.includes("?") || /\b(how|why|anyone|where|can i)\b/.test(lower)) {
    return "unanswered_question";
  }
  return "feature_demand";
}

function pickTopicKey(content: string, matchedKeywords: string[]): string {
  if (matchedKeywords.length > 0) {
    return matchedKeywords[0]!.toLowerCase();
  }
  const tokens = (content.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter(
    (t) => !STOPWORDS.has(t)
  );
  return tokens.slice(0, 2).join(" ") || "general workflow";
}

function cleanSnippet(content: string): string {
  return content.replace(/[\u2013\u2014]/g, ",").replace(/\s+-\s+/g, ": ").replace(/\s+/g, " ").trim().slice(0, 160);
}

const SNOWFLAKE_RE = /^\d{15,22}$/;

/** Construct a direct Discord message or thread link when numeric Snowflake IDs are available. */
export function buildDiscordMessageLink(
  msg: Pick<StoredMessage, "guildId" | "channelId" | "threadId" | "messageId">
): string | null {
  const guildId = msg.guildId.trim();
  const threadId = (msg.threadId ?? "").trim();
  const channelId = msg.channelId.trim();
  const messageId = (msg.messageId ?? "").trim();

  if (!SNOWFLAKE_RE.test(guildId)) return null;
  const targetChan = SNOWFLAKE_RE.test(threadId) ? threadId : channelId;
  if (!SNOWFLAKE_RE.test(targetChan)) return null;

  if (SNOWFLAKE_RE.test(messageId) && messageId !== targetChan) {
    return `https://discord.com/channels/${guildId}/${targetChan}/${messageId}`;
  }
  return `https://discord.com/channels/${guildId}/${targetChan}`;
}

/** Cluster local vault messages into ranked demand weighted content opportunities. */
export function extractSignals(
  messages: StoredMessage[],
  demandKeywords: string[]
): SignalCluster[] {
  const normalizedKeywords = demandKeywords
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

  interface Bucket {
    category: SignalCategory;
    topicKey: string;
    score: number;
    messageCount: number;
    matchedKeywords: Set<string>;
    channelNames: Set<string>;
    sampleSnippets: string[];
    sourceLinks: Set<string>;
    latestAt: string;
  }

  const buckets = new Map<string, Bucket>();

  for (const msg of messages) {
    if (msg.guildId.trim().toLowerCase() === "@me") {
      continue;
    }
    const lower = msg.content.toLowerCase();
    const matched = normalizedKeywords.filter((kw) => lower.includes(kw));
    const category = classifyMessage(msg.content);
    const topicKey = pickTopicKey(msg.content, matched);
    const key = `${category}::${topicKey}`;

    const baseScore = category === "recurring_bug" ? 3 : category === "unanswered_question" ? 2.5 : 2;
    const msgScore = baseScore + matched.length * 4;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        category,
        topicKey,
        score: 0,
        messageCount: 0,
        matchedKeywords: new Set<string>(),
        channelNames: new Set<string>(),
        sampleSnippets: [],
        sourceLinks: new Set<string>(),
        latestAt: msg.createdAt,
      };
      buckets.set(key, bucket);
    }

    bucket.score += msgScore;
    bucket.messageCount += 1;
    for (const kw of matched) bucket.matchedKeywords.add(kw);
    bucket.channelNames.add(msg.channelName);
    if (bucket.sampleSnippets.length < 3) {
      bucket.sampleSnippets.push(cleanSnippet(msg.content));
    }
    if (bucket.sourceLinks.size < 5) {
      const link = buildDiscordMessageLink(msg);
      if (link) {
        bucket.sourceLinks.add(link);
      }
    }
    if (msg.createdAt > bucket.latestAt) {
      bucket.latestAt = msg.createdAt;
    }
  }

  const clusters: SignalCluster[] = [];
  let idx = 1;
  for (const bucket of buckets.values()) {
    const categoryLabel = bucket.category.replace(/_/g, " ");
    clusters.push({
      id: `SIG-${String(idx).padStart(2, "0")}`,
      category: bucket.category,
      title: `${bucket.topicKey} (${categoryLabel})`,
      score: Math.round(bucket.score * 10) / 10,
      messageCount: bucket.messageCount,
      matchedKeywords: Array.from(bucket.matchedKeywords),
      channelNames: Array.from(bucket.channelNames),
      sampleSnippets: bucket.sampleSnippets,
      sourceLinks: Array.from(bucket.sourceLinks),
      latestAt: bucket.latestAt,
    });
    idx += 1;
  }

  clusters.sort((a, b) => b.score - a.score || b.messageCount - a.messageCount);
  return clusters;
}

/** Synthesize a voice gated content brief ready to review and publish in your owned channel. */
export function buildContentBrief(
  clusters: SignalCluster[],
  demandLabel: string,
  targetChannel: string
): ContentBrief {
  const topSignals = clusters.slice(0, 3);
  const topicSummary =
    topSignals.length > 0
      ? topSignals.map((s) => s.matchedKeywords[0] || s.title).join(", ")
      : demandLabel;

  const headline = `${demandLabel}: Common questions and fixes (${topicSummary})`;
  const outlinePoints =
    topSignals.length > 0
      ? topSignals.map(
          (sig, idx) =>
            `${idx + 1}. Cover ${sig.title} (${sig.messageCount} report(s) in ${sig.channelNames.join(", ")})`
        )
      : [`1. Share a working ${demandLabel} example for ${targetChannel}.`];

  const draftLines = [
    `Notes for ${targetChannel} covering ${demandLabel}.`,
    topSignals.length > 0
      ? `Recent threads highlight repeated questions on ${topSignals.map((s) => s.title).join(" and ")}.`
      : `Members asked for clearer examples covering ${demandLabel}.`,
    `Key points to cover:`,
    ...outlinePoints,
  ];

  const draftStarter = draftLines.join("\n");
  const allExternalSnippets = topSignals.flatMap((s) => s.sampleSnippets);
  const voiceGate = checkVoiceGate(draftStarter, allExternalSnippets);

  return {
    headline,
    targetChannel,
    demandLabel,
    topSignals,
    outlinePoints,
    draftStarter,
    voiceGate,
  };
}
