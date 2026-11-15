/** Supported message capture paths enforcing read only non owned isolation. */
export type SourceTier = "bot_api" | "desktop_wiretap" | "browser_snapshot";

/** Supported intent categories emitted by the local signal clusterer. */
export type SignalCategory =
  | "unanswered_question"
  | "recurring_bug"
  | "feature_demand"
  | "comparison_thread";

/** Configures what external topics and target channels a user monitors. */
export interface DemandCaptureSource {
  tier: SourceTier;
  guildId: string;
  channelId: string;
  channelName?: string;
  url?: string;
}

export interface DemandProfile {
  id: string;
  label: string;
  keywords: string[];
  ownedTargetChannel: string;
  captureSources: DemandCaptureSource[];
}

/** Raw normalized record emitted by Bot sync, wiretap JSONL, or browser snapshots. */
export interface NormalizedMessage {
  messageId?: string;
  guildId: string;
  channelId: string;
  channelName?: string;
  authorId?: string;
  authorName: string;
  content: string;
  attachmentUrls?: string[];
  createdAt: string;
  sourceTier: SourceTier;
}

/** Durable row stored inside local SQLite WAL and FTS5 tables. */
export interface StoredMessage {
  dedupKey: string;
  messageId: string;
  guildId: string;
  channelId: string;
  channelName: string;
  authorRef: string;
  content: string;
  attachments: string[];
  createdAt: string;
  sourceTier: SourceTier;
  ingestedAt: string;
}

export interface IngestSummary {
  inserted: number;
  skippedDuplicates: number;
  quarantinedDmCount: number;
  rejectedAttachmentCount: number;
}

export interface SignalCluster {
  id: string;
  category: SignalCategory;
  title: string;
  score: number;
  messageCount: number;
  matchedKeywords: string[];
  channelNames: string[];
  sampleSnippets: string[];
  latestAt: string;
}

export interface VoiceGateResult {
  ok: boolean;
  reasons: string[];
  maxConsecutiveOverlap: number;
}

export type TranslationProvider = "google_gtx" | "google_cloud_v2";

export interface TranslateOptions {
  to: string;
  from?: string;
  pivot?: string;
  apiKey?: string;
  endpointUrl?: string;
  deSlop?: boolean;
  fetchFn?: typeof fetch;
}

export interface TranslateResult {
  originalText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  pivotLang?: string;
  provider: TranslationProvider;
  protectedTokens: number;
  slopRemoved: string[];
}

export interface ContentBrief {
  headline: string;
  targetChannel: string;
  demandLabel: string;
  topSignals: SignalCluster[];
  outlinePoints: string[];
  draftStarter: string;
  voiceGate: VoiceGateResult;
  translation?: {
    targetLang: string;
    sourceLang: string;
    pivotLang?: string;
    provider: TranslationProvider;
  };
}

export type SignalTrend = "new" | "rising" | "steady" | "cooling";

export interface TracedSignalCluster extends SignalCluster {
  previousMessageCount: number;
  deltaCount: number;
  trend: SignalTrend;
}

export interface InboxIngestReport {
  processedFiles: string[];
  inserted: number;
  skippedDuplicates: number;
  quarantinedDmCount: number;
  wiretapStatus: "ingested" | "skipped_not_configured" | "failed";
}

export interface DemandDigestSection {
  demandId: string;
  demandLabel: string;
  targetChannel: string;
  tracedSignals: TracedSignalCluster[];
  brief: ContentBrief;
}

export interface DailyDigestReport {
  date: string;
  generatedAt: string;
  timeZone: string;
  hoursWindow: number;
  totalVaultMessages: number;
  recentMessageCount: number;
  previousDigestDate: string | null;
  ingest: InboxIngestReport;
  sections: DemandDigestSection[];
  markdownPath: string;
  jsonPath: string;
}

export interface DailyScheduleState {
  date: string;
  timeZone: string;
  windowStart: string;
  windowEnd: string;
  targetMinute: number;
  targetTime: string;
  completedAt: string | null;
  lastDigestMarkdownPath: string | null;
  lastDigestJsonPath: string | null;
}

export interface ScheduleTickResult {
  action: "executed" | "waiting_for_slot" | "outside_window" | "already_completed_today";
  nowDate: string;
  nowTime: string;
  state: DailyScheduleState;
  digest?: DailyDigestReport;
}

export interface ParsedDiscordChannelUrl {
  guildId: string;
  channelId: string;
  messageId?: string;
  canonicalUrl: string;
}

export interface DemoChannelCoverage {
  alias: string;
  messageCount: number;
}

export interface DemoInsightsPack {
  demandId: string;
  demandLabel: string;
  generatedAt: string;
  hoursWindow: number;
  totalMatchedMessages: number;
  channelCoverage: DemoChannelCoverage[];
  topSignals: SignalCluster[];
  demoTalkingPoints: string[];
  brief: ContentBrief;
  voiceGate: VoiceGateResult;
  markdownPath: string;
  jsonPath: string;
}

/** Structured CLI output envelope aligned with SCHEMA.md agent tooling conventions. */
export interface CliEnvelope<T = unknown> {
  ok: boolean;
  schema_version: "1";
  data?: T;
  error?: {
    code: string;
    message: string;
    hint?: string;
  };
}
