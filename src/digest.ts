import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkVoiceGate,
  parseDiscordChannelUrl,
  scrubSnowflakeIds,
  stripContentSlop,
} from "./security.ts";
import { buildContentBrief, extractSignals } from "./signals.ts";
import { parseBrowserSnapshot } from "./snapshot.ts";
import { translateContentBrief } from "./translate.ts";
import type {
  DailyDigestReport,
  DemoChannelCoverage,
  DemoInsightsPack,
  DemandCaptureSource,
  DemandDigestSection,
  DemandProfile,
  InboxIngestReport,
  NormalizedMessage,
  SignalCluster,
  SignalTrend,
  SourceTier,
  TracedSignalCluster,
} from "./types.ts";
import { RadarVault } from "./vault.ts";

export interface DigestOptions {
  dbPath?: string;
  outDir?: string;
  inboxDir?: string;
  demandsFile?: string;
  wiretapConfigPath?: string;
  discrawlBin?: string;
  hours?: number;
  lang?: string;
  fromLang?: string;
  pivotLang?: string;
  timeZone?: string;
  dateOverride?: string;
  autoIngest?: boolean;
  now?: Date;
  fetchFn?: typeof fetch;
}

export function resolveLocalTimeZone(explicit?: string): string {
  return (
    explicit?.trim() ||
    process.env.RADAR_TIMEZONE?.trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC"
  );
}

export function getZonedNow(
  now = new Date(),
  timeZone = resolveLocalTimeZone()
): { dateStr: string; timeStr: string; minuteOfDay: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const year = byType.get("year") ?? "1970";
  const month = byType.get("month") ?? "01";
  const day = byType.get("day") ?? "01";
  const hour = (Number.parseInt(byType.get("hour") ?? "0", 10) || 0) % 24;
  const minute = (Number.parseInt(byType.get("minute") ?? "0", 10) || 0) % 60;
  const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  return {
    dateStr: `${year}-${month}-${day}`,
    timeStr,
    minuteOfDay: hour * 60 + minute,
  };
}

export function resolveDemandsPath(explicitPath = ""): string {
  if (explicitPath.trim()) return path.resolve(explicitPath.trim());
  const localPath = path.resolve("configs/demands.local.json");
  if (fs.existsSync(localPath)) return localPath;
  return path.resolve("configs/demands.example.json");
}

function normalizeCaptureSource(src: DemandCaptureSource): DemandCaptureSource {
  if (src.url?.trim()) {
    const needGuild = !src.guildId?.trim() || src.guildId.startsWith("REPLACE_");
    const needChannel = !src.channelId?.trim() || src.channelId.startsWith("REPLACE_");
    if (needGuild || needChannel) {
      const parsed = parseDiscordChannelUrl(src.url);
      return {
        ...src,
        guildId: needGuild ? parsed.guildId : src.guildId,
        channelId: needChannel ? parsed.channelId : src.channelId,
      };
    }
  }
  return src;
}

export function loadDemandProfiles(
  explicitPath = ""
): { configPath: string; demands: DemandProfile[] } {
  const configPath = resolveDemandsPath(explicitPath);
  if (!fs.existsSync(configPath)) return { configPath, demands: [] };
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  const demands = Array.isArray(parsed)
    ? (parsed as DemandProfile[]).map((profile) => ({
        ...profile,
        captureSources: Array.isArray(profile.captureSources)
          ? profile.captureSources.map(normalizeCaptureSource)
          : [],
      }))
    : [];
  return { configPath, demands };
}

export function parseJsonlMessages(
  raw: string,
  defaults: {
    guildId?: string;
    channelId?: string;
    channelName?: string;
    tier: SourceTier;
  }
): NormalizedMessage[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line) => {
    const obj = JSON.parse(line) as Record<string, unknown>;
    return {
      messageId:
        typeof obj.message_id === "string"
          ? obj.message_id
          : typeof obj.messageId === "string"
            ? obj.messageId
            : typeof obj.id === "string"
              ? obj.id
              : undefined,
      guildId: String(obj.guild_id ?? obj.guildId ?? defaults.guildId ?? ""),
      channelId: String(obj.channel_id ?? obj.channelId ?? defaults.channelId ?? ""),
      channelName:
        typeof obj.channel_name === "string"
          ? obj.channel_name
          : typeof obj.channelName === "string"
            ? obj.channelName
            : defaults.channelName || undefined,
      authorId:
        typeof obj.author_id === "string"
          ? obj.author_id
          : typeof obj.authorId === "string"
            ? obj.authorId
            : undefined,
      authorName: String(obj.author_name ?? obj.authorName ?? "unknown"),
      content: String(obj.content ?? ""),
      attachmentUrls: Array.isArray(obj.attachmentUrls) ? (obj.attachmentUrls as string[]) : [],
      createdAt: String(
        obj.sent_at ?? obj.created_at ?? obj.createdAt ?? new Date().toISOString()
      ),
      sourceTier:
        (typeof obj.sourceTier === "string" ? (obj.sourceTier as SourceTier) : undefined) ??
        defaults.tier,
    };
  });
}

function ensurePrivateDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // Ignore chmod failures only on restricted virtual filesystems
  }
  const parent = path.dirname(dirPath);
  if (path.basename(parent) === ".state") {
    try {
      fs.chmodSync(parent, 0o700);
    } catch {
      // Best effort .state hardening
    }
  }
}

function writePrivateFile(filePath: string, content: string): void {
  ensurePrivateDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort file permission hardening
  }
}

function inferInboxMeta(
  stem: string,
  validSources: DemandCaptureSource[]
): { guildId: string; channelId: string; channelName: string; tier: SourceTier } {
  const parts = stem.split("__").filter((part) => part.length > 0);
  if (parts.length >= 3) {
    return {
      guildId: parts[0]!,
      channelId: parts[1]!,
      channelName: parts.slice(2).join("__"),
      tier: "browser_snapshot",
    };
  }

  const lowerStem = stem.toLowerCase();
  const matched = validSources.find(
    (src) => src.channelName?.toLowerCase() === lowerStem || src.channelId === stem
  );
  if (matched) {
    return {
      guildId: matched.guildId,
      channelId: matched.channelId,
      channelName: matched.channelName || matched.channelId,
      tier: matched.tier,
    };
  }

  return {
    guildId: "inbox-guild",
    channelId: stem || "inbox-channel",
    channelName: stem || "inbox-channel",
    tier: "browser_snapshot",
  };
}

function resolveDiscrawlDbPath(tomlBody: string, wiretapConfigPath: string): string {
  const match = /^\s*db_path\s*=\s*["']([^"']+)["']/m.exec(tomlBody);
  const raw = match?.[1]?.trim() || ".state/discrawl-external.db";
  if (raw.startsWith("~/")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  if (path.isAbsolute(raw)) return raw;
  const cwdCandidate = path.resolve(raw);
  if (fs.existsSync(cwdCandidate) || raw.startsWith(".state/")) {
    return cwdCandidate;
  }
  return path.resolve(path.dirname(wiretapConfigPath), raw);
}

// Read discrawl SQLite tables directly in readonly mode so schema and parent threads match cleanly.
function readWiretapDatabaseRows(
  discrawlDbPath: string,
  wiretapGuilds: string[],
  wiretapChannels: string[]
): NormalizedMessage[] {
  if (!fs.existsSync(discrawlDbPath)) return [];
  const extDb = new Database(discrawlDbPath);
  try {
    extDb.exec("PRAGMA query_only = ON;");
    const msgColRows = extDb.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    const msgCols = new Set(msgColRows.map((c) => c.name));
    if (!msgCols.has("guild_id") || !msgCols.has("channel_id") || !msgCols.has("content")) {
      return [];
    }

    const chanColRows = extDb.prepare("PRAGMA table_info(channels)").all() as Array<{ name: string }>;
    const chanCols = new Set(chanColRows.map((c) => c.name));

    const idExpr = msgCols.has("message_id")
      ? "m.message_id"
      : msgCols.has("id")
        ? "m.id"
        : "''";
    const timeExpr = msgCols.has("created_at")
      ? "m.created_at"
      : msgCols.has("sent_at")
        ? "m.sent_at"
        : "''";
    const contentExpr = msgCols.has("normalized_content")
      ? "COALESCE(NULLIF(m.content, ''), m.normalized_content, '')"
      : "m.content";
    const authorIdExpr = msgCols.has("author_id") ? "m.author_id" : "''";
    const authorNameExpr = msgCols.has("author_name")
      ? "m.author_name"
      : msgCols.has("author_id")
        ? "COALESCE(m.author_id, 'unknown')"
        : "'unknown'";
    const hasChannels = chanCols.has("id");
    const hasChannelName = hasChannels && chanCols.has("name");
    const hasKind = hasChannels && chanCols.has("kind");
    const hasParentId = hasChannels && chanCols.has("parent_id");
    const hasThreadParentId = hasChannels && chanCols.has("thread_parent_id");

    const conditions = ["lower(m.guild_id) != '@me'", `trim(${contentExpr}) != ''`];
    const params: string[] = [];

    if (wiretapGuilds.length > 0) {
      conditions.push(`m.guild_id IN (${wiretapGuilds.map(() => "?").join(", ")})`);
      params.push(...wiretapGuilds);
    }

    const channelSet = new Set(wiretapChannels);
    if (wiretapChannels.length > 0) {
      const chPh = wiretapChannels.map(() => "?").join(", ");
      const channelClauses = [`m.channel_id IN (${chPh})`];
      params.push(...wiretapChannels);
      if (hasParentId) {
        channelClauses.push(`c.parent_id IN (${chPh})`);
        params.push(...wiretapChannels);
      }
      if (hasThreadParentId) {
        channelClauses.push(`c.thread_parent_id IN (${chPh})`);
        params.push(...wiretapChannels);
      }
      if (hasKind) {
        const noParentChecks: string[] = [];
        if (hasParentId) noParentChecks.push("COALESCE(c.parent_id, '') = ''");
        if (hasThreadParentId) noParentChecks.push("COALESCE(c.thread_parent_id, '') = ''");
        const unparentedExpr =
          noParentChecks.length > 0
            ? `(c.kind LIKE 'thread_%' AND ${noParentChecks.join(" AND ")})`
            : "c.kind LIKE 'thread_%'";
        channelClauses.push(unparentedExpr);
      }
      conditions.push(`(${channelClauses.join(" OR ")})`);
    }

    const joinParent = hasParentId || hasThreadParentId;
    const parentLookupExpr =
      hasThreadParentId && hasParentId
        ? "COALESCE(NULLIF(c.thread_parent_id, ''), NULLIF(c.parent_id, ''))"
        : hasThreadParentId
          ? "NULLIF(c.thread_parent_id, '')"
          : "NULLIF(c.parent_id, '')";

    const sql = `
      SELECT
        ${idExpr} AS message_id,
        m.guild_id AS guild_id,
        m.channel_id AS channel_id,
        ${hasChannelName ? "COALESCE(c.name, m.channel_id)" : "m.channel_id"} AS channel_name,
        ${hasKind ? "COALESCE(c.kind, '')" : "''"} AS channel_kind,
        ${joinParent && hasChannelName ? "COALESCE(pc.name, c.name, m.channel_id)" : hasChannelName ? "COALESCE(c.name, m.channel_id)" : "m.channel_id"} AS parent_channel_name,
        ${hasParentId ? "COALESCE(c.parent_id, '')" : "''"} AS parent_id,
        ${hasThreadParentId ? "COALESCE(c.thread_parent_id, '')" : "''"} AS thread_parent_id,
        ${authorIdExpr} AS author_id,
        ${authorNameExpr} AS author_name,
        ${contentExpr} AS content,
        ${timeExpr} AS created_at
      FROM messages m
      ${hasChannels ? "LEFT JOIN channels c ON c.id = m.channel_id" : ""}
      ${joinParent ? `LEFT JOIN channels pc ON pc.id = ${parentLookupExpr}` : ""}
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT 1000
    `;

    const rawRows = extDb.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rawRows.map((row) => {
      const threadParentId =
        typeof row.thread_parent_id === "string" ? row.thread_parent_id.trim() : "";
      const parentId = typeof row.parent_id === "string" ? row.parent_id.trim() : "";
      const rawChannelId = String(row.channel_id ?? "").trim();
      const effectiveChannelId =
        threadParentId && channelSet.has(threadParentId)
          ? threadParentId
          : parentId && channelSet.has(parentId)
            ? parentId
            : rawChannelId;
      const msgId = typeof row.message_id === "string" ? row.message_id.trim() : "";
      const channelKind =
        typeof row.channel_kind === "string" ? row.channel_kind.trim().toLowerCase() : "";
      const isUnparentedThread =
        channelKind.startsWith("thread_") &&
        !threadParentId &&
        !parentId &&
        wiretapChannels.length > 0 &&
        !channelSet.has(rawChannelId);
      const rawChannelLabel = String(row.channel_name ?? "").trim();
      const rawBody = String(row.content ?? "");
      const mergedContent =
        isUnparentedThread && rawChannelLabel && !rawBody.includes(rawChannelLabel)
          ? `${rawChannelLabel}. ${rawBody}`
          : rawBody;
      const finalChannelName = isUnparentedThread
        ? "forum-threads"
        : (effectiveChannelId !== rawChannelId
            ? String(row.parent_channel_name ?? row.channel_name ?? effectiveChannelId)
            : String(row.channel_name ?? effectiveChannelId)
          ).trim() || effectiveChannelId;
      return {
        messageId: msgId || undefined,
        guildId: String(row.guild_id ?? "").trim(),
        channelId: effectiveChannelId,
        channelName: finalChannelName,
        authorId: typeof row.author_id === "string" ? row.author_id : undefined,
        authorName: String(row.author_name ?? "unknown"),
        content: mergedContent,
        attachmentUrls: [],
        createdAt: String(row.created_at || new Date().toISOString()),
        sourceTier: "desktop_wiretap",
      };
    });
  } finally {
    extDb.close();
  }
}

/** Ingest queued snapshots in .state/inbox/ and optional local discrawl wiretap cache. */
export function ingestPendingSources(
  vault: RadarVault,
  demands: DemandProfile[],
  opts: {
    inboxDir?: string;
    wiretapConfigPath?: string;
    discrawlBin?: string;
  } = {}
): InboxIngestReport {
  const inboxDir = path.resolve(opts.inboxDir?.trim() || ".state/inbox");
  const processedDir = path.join(inboxDir, "processed");
  ensurePrivateDir(inboxDir);
  ensurePrivateDir(processedDir);

  const validSources = demands
    .flatMap((d) => d.captureSources)
    .filter((s) => !s.guildId.startsWith("REPLACE_") && !s.channelId.startsWith("REPLACE_"));

  const files = fs
    .readdirSync(inboxDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(json|jsonl|txt)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const processedFiles: string[] = [];
  let inserted = 0;
  let skippedDuplicates = 0;
  let quarantinedDmCount = 0;

  for (const fileName of files) {
    const fullPath = path.join(inboxDir, fileName);
    const raw = fs.readFileSync(fullPath, "utf8");
    const ext = path.extname(fileName).toLowerCase();
    const stem = path.basename(fileName, ext);
    const meta = inferInboxMeta(stem, validSources);

    const items =
      ext === ".jsonl"
        ? parseJsonlMessages(raw, {
            guildId: validSources[0]?.guildId ?? meta.guildId,
            channelId: validSources[0]?.channelId ?? meta.channelId,
            channelName: validSources[0]?.channelName ?? meta.channelName,
            tier: validSources[0]?.tier ?? "desktop_wiretap",
          })
        : parseBrowserSnapshot(raw, {
            guildId: meta.guildId,
            channelId: meta.channelId,
            channelName: meta.channelName,
          });

    const summary = vault.ingestMessages(items);
    inserted += summary.inserted;
    skippedDuplicates += summary.skippedDuplicates;
    quarantinedDmCount += summary.quarantinedDmCount;

    const archivedPath = path.join(processedDir, `${Date.now()}-${fileName}`);
    fs.renameSync(fullPath, archivedPath);
    try {
      fs.chmodSync(archivedPath, 0o600);
    } catch {
      // Best effort chmod on archived snapshot
    }
    processedFiles.push(fileName);
  }

  let wiretapStatus: InboxIngestReport["wiretapStatus"] = "skipped_not_configured";
  const wiretapConfigPath = path.resolve(
    opts.wiretapConfigPath?.trim() ||
      process.env.DISCRAWL_CONFIG?.trim() ||
      "configs/discrawl-external-wiretap.local.toml"
  );
  const discrawlBin = opts.discrawlBin?.trim() || process.env.DISCRAWL_BIN?.trim() || "discrawl";
  const hasDiscrawlBin = fs.existsSync(discrawlBin) || Boolean(Bun.which(discrawlBin));

  if (fs.existsSync(wiretapConfigPath) && hasDiscrawlBin) {
    const wiretapSources = validSources.filter((s) => s.tier === "desktop_wiretap");
    const wiretapGuilds = Array.from(
      new Set(wiretapSources.map((s) => s.guildId.trim()).filter(Boolean))
    );
    const wiretapChannels = Array.from(
      new Set(wiretapSources.map((s) => s.channelId.trim()).filter(Boolean))
    );
    const tomlBody = fs.readFileSync(wiretapConfigPath, "utf8");
    if (wiretapGuilds.length === 0 && /REPLACE_/.test(tomlBody)) {
      wiretapStatus = "skipped_not_configured";
    } else {
      try {
        const discrawlDbPath = resolveDiscrawlDbPath(tomlBody, wiretapConfigPath);
        ensurePrivateDir(path.dirname(discrawlDbPath));
        const hadDbBefore = fs.existsSync(discrawlDbPath);
        const spawnEnv = {
          ...process.env,
          DISCRAWL_NO_UPDATE_CHECK: "1",
          DISCRAWL_NO_AUTO_UPDATE: "1",
        };
        const tapArgs = [
          "--config",
          wiretapConfigPath,
          "wiretap",
          ...(hadDbBefore ? [] : ["--full-cache"]),
        ];
        const tap = spawnSync(discrawlBin, tapArgs, { encoding: "utf8", env: spawnEnv });
        if (tap.status !== 0) {
          wiretapStatus = "failed";
        } else {
          const rows = readWiretapDatabaseRows(discrawlDbPath, wiretapGuilds, wiretapChannels);
          const summary = vault.ingestMessages(rows);
          inserted += summary.inserted;
          skippedDuplicates += summary.skippedDuplicates;
          quarantinedDmCount += summary.quarantinedDmCount;
          wiretapStatus = "ingested";
        }
      } catch {
        wiretapStatus = "failed";
      }
    }
  }

  return {
    processedFiles,
    inserted,
    skippedDuplicates,
    quarantinedDmCount,
    wiretapStatus,
  };
}

function loadPreviousDigestBaseline(
  outDir: string,
  currentDate: string
): { previousDigestDate: string | null; prevCounts: Map<string, number> } {
  const prevCounts = new Map<string, number>();
  if (!fs.existsSync(outDir)) {
    return { previousDigestDate: null, prevCounts };
  }

  const priorFiles = fs
    .readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(entry.name);
      return match ? { fileName: entry.name, dateStr: match[1]! } : null;
    })
    .filter((item): item is { fileName: string; dateStr: string } => item !== null && item.dateStr < currentDate)
    .sort((a, b) => b.dateStr.localeCompare(a.dateStr));

  if (priorFiles.length === 0) {
    return { previousDigestDate: null, prevCounts };
  }

  const latest = priorFiles[0]!;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(outDir, latest.fileName), "utf8")
    ) as Partial<DailyDigestReport>;
    for (const section of parsed.sections ?? []) {
      const signals = section.tracedSignals ?? section.brief?.topSignals ?? [];
      for (const sig of signals) {
        prevCounts.set(`${section.demandId}::${sig.id}`, sig.messageCount);
      }
    }
    return { previousDigestDate: parsed.date ?? latest.dateStr, prevCounts };
  } catch {
    return { previousDigestDate: null, prevCounts };
  }
}

function formatDeltaBadge(deltaCount: number): string {
  return deltaCount > 0 ? `+${deltaCount}` : String(deltaCount);
}

function renderDigestMarkdown(report: DailyDigestReport): string {
  const lines: string[] = [
    `# Discord Radar Daily Trace (\`${report.date}\`)`,
    "",
    `1. **Generated At**: \`${report.generatedAt}\` (\`${report.timeZone}\`)`,
    `2. **Lookback Window**: \`${report.hoursWindow}\` hours (\`${report.recentMessageCount}\` recent messages out of \`${report.totalVaultMessages}\` archived)`,
    `3. **Previous Baseline**: \`${report.previousDigestDate ?? "none"}\``,
    `4. **Inbox & Wiretap Ingest**: \`${report.ingest.processedFiles.length}\` inbox files, \`${report.ingest.inserted}\` new rows inserted, \`${report.ingest.skippedDuplicates}\` duplicates skipped, wiretap status \`${report.ingest.wiretapStatus}\``,
    "",
  ];

  for (const section of report.sections) {
    lines.push(`## ${section.demandLabel} (\`${section.targetChannel}\`)`, "");
    if (section.tracedSignals.length === 0) {
      lines.push("1. No matching topic signals detected in this window.", "");
    } else {
      lines.push(
        "| Rank | Trend | Delta | Category | Topic | Posts | Channels |",
        "| :--- | :--- | :--- | :--- | :--- | :--- | :--- |"
      );
      section.tracedSignals.forEach((sig, index) => {
        const channels = sig.channelNames.map((ch) => `\`${ch}\``).join(", ") || "`none`";
        const delta = `\`${formatDeltaBadge(sig.deltaCount)}\``;
        lines.push(
          `| ${index + 1} | \`${sig.trend}\` | ${delta} | \`${sig.category}\` | ${sig.title} | ${sig.messageCount} | ${channels} |`
        );
      });
      lines.push("");
    }

    lines.push(
      `### Draft Brief (\`voiceGate\`: \`${section.brief.voiceGate.ok ? "pass" : "fail"}\`)`,
      "",
      `**Headline**: ${section.brief.headline}`,
      "",
      ...section.brief.outlinePoints,
      "",
      "**Starter Notes**:",
      "",
      section.brief.draftStarter,
      ""
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** Run daily ingest, signal delta tracing, brief synthesis, and local Markdown/JSON digest output. */
export async function runDailyDigest(opts: DigestOptions = {}): Promise<DailyDigestReport> {
  const timeZone = resolveLocalTimeZone(opts.timeZone);
  const now = opts.now ?? new Date();
  const date = opts.dateOverride?.trim() || getZonedNow(now, timeZone).dateStr;
  const hoursWindow = opts.hours ?? 24;
  const dbPath = opts.dbPath?.trim() || process.env.RADAR_DB_PATH?.trim() || ".state/radar.db";
  const outDir = path.resolve(opts.outDir?.trim() || ".state/digests");
  ensurePrivateDir(outDir);

  const { demands } = loadDemandProfiles(opts.demandsFile ?? "");
  const effectiveDemands: DemandProfile[] =
    demands.length > 0
      ? demands
      : [
          {
            id: "general",
            label: "General Topics",
            keywords: [],
            ownedTargetChannel: "#general",
            captureSources: [],
          },
        ];

  const { previousDigestDate, prevCounts } = loadPreviousDigestBaseline(outDir, date);
  const vault = new RadarVault(dbPath);

  try {
    const ingest: InboxIngestReport =
      opts.autoIngest === false
        ? {
            processedFiles: [],
            inserted: 0,
            skippedDuplicates: 0,
            quarantinedDmCount: 0,
            wiretapStatus: "skipped_not_configured",
          }
        : ingestPendingSources(vault, effectiveDemands, {
            inboxDir: opts.inboxDir,
            wiretapConfigPath: opts.wiretapConfigPath,
            discrawlBin: opts.discrawlBin,
          });

    const recentMessages = vault.recentMessages(hoursWindow, { limit: 500 });
    const stats = vault.getStats();
    const sections: DemandDigestSection[] = [];

    for (const demand of effectiveDemands) {
      const clusters = extractSignals(recentMessages, demand.keywords);
      const tracedSignals: TracedSignalCluster[] = clusters.map((cluster) => {
        const prev = prevCounts.get(`${demand.id}::${cluster.id}`) ?? 0;
        let trend: SignalTrend;
        let deltaCount: number;
        if (!previousDigestDate || prev === 0) {
          trend = "new";
          deltaCount = cluster.messageCount;
        } else if (cluster.messageCount > prev) {
          trend = "rising";
          deltaCount = cluster.messageCount - prev;
        } else if (cluster.messageCount === prev) {
          trend = "steady";
          deltaCount = 0;
        } else {
          trend = "cooling";
          deltaCount = cluster.messageCount - prev;
        }
        return {
          ...cluster,
          previousMessageCount: prev,
          deltaCount,
          trend,
        };
      });

      let brief = buildContentBrief(
        clusters,
        demand.label,
        demand.ownedTargetChannel || "#general"
      );

      if (opts.lang?.trim()) {
        brief = await translateContentBrief(
          brief,
          {
            to: opts.lang.trim(),
            from: opts.fromLang?.trim() || "auto",
            pivot: opts.pivotLang?.trim() || undefined,
            fetchFn: opts.fetchFn,
          },
          clusters.flatMap((c) => c.sampleSnippets)
        );
      }

      sections.push({
        demandId: demand.id,
        demandLabel: demand.label,
        targetChannel: demand.ownedTargetChannel || "#general",
        tracedSignals,
        brief,
      });
    }

    const markdownPath = path.join(outDir, `${date}.md`);
    const jsonPath = path.join(outDir, `${date}.json`);
    const report: DailyDigestReport = {
      date,
      generatedAt: now.toISOString(),
      timeZone,
      hoursWindow,
      totalVaultMessages: stats.totalMessages,
      recentMessageCount: recentMessages.length,
      previousDigestDate,
      ingest,
      sections,
      markdownPath,
      jsonPath,
    };

    writePrivateFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    writePrivateFile(markdownPath, renderDigestMarkdown(report));
    return report;
  } finally {
    vault.close();
  }
}

export interface UpsertSourceOptions {
  demandsFile?: string;
  wiretapConfigPath?: string;
  demandId: string;
  label?: string;
  urls: string[];
  keywords?: string[];
  ownedTargetChannel?: string;
  channelNames?: string[];
  tier?: SourceTier;
}

/** Add Discord channel URLs to local demand config and update wiretap guild TOML. */
export function upsertLocalCaptureSources(opts: UpsertSourceOptions): {
  demandsFile: string;
  wiretapConfigPath: string;
  profile: DemandProfile;
  wiretapGuildIds: string[];
} {
  if (!opts.urls || opts.urls.length === 0) {
    throw new Error("At least one Discord channel URL (--url) is required.");
  }

  const parsedUrls = opts.urls.map((raw) => parseDiscordChannelUrl(raw));
  const demandsFile = path.resolve(opts.demandsFile?.trim() || "configs/demands.local.json");
  const wiretapConfigPath = path.resolve(
    opts.wiretapConfigPath?.trim() || "configs/discrawl-external-wiretap.local.toml"
  );
  const tier: SourceTier = opts.tier ?? "desktop_wiretap";

  let profiles: DemandProfile[] = [];
  if (fs.existsSync(demandsFile)) {
    const raw = JSON.parse(fs.readFileSync(demandsFile, "utf8")) as unknown;
    if (Array.isArray(raw)) {
      profiles = raw as DemandProfile[];
    }
  }

  const existingIndex = profiles.findIndex((p) => p.id === opts.demandId);
  const baseProfile: DemandProfile =
    existingIndex >= 0
      ? profiles[existingIndex]!
      : {
          id: opts.demandId,
          label: opts.label?.trim() || opts.demandId,
          keywords: [],
          ownedTargetChannel: opts.ownedTargetChannel?.trim() || "#demo-insights",
          captureSources: [],
        };

  const mergedKeywords = Array.from(
    new Set([
      ...baseProfile.keywords,
      ...(opts.keywords ?? []).map((k) => k.trim()).filter(Boolean),
    ])
  );

  const sourceMap = new Map<string, DemandCaptureSource>();
  for (const src of baseProfile.captureSources) {
    const normalized = normalizeCaptureSource(src);
    sourceMap.set(`${normalized.guildId}:${normalized.channelId}`, normalized);
  }
  parsedUrls.forEach((parsed, idx) => {
    const key = `${parsed.guildId}:${parsed.channelId}`;
    const existing = sourceMap.get(key);
    const channelName =
      opts.channelNames?.[idx]?.trim() ||
      existing?.channelName ||
      `channel-${String(idx + 1).padStart(2, "0")}`;
    sourceMap.set(key, {
      tier,
      guildId: parsed.guildId,
      channelId: parsed.channelId,
      channelName,
      url: parsed.canonicalUrl,
    });
  });

  const updatedProfile: DemandProfile = {
    id: opts.demandId,
    label: opts.label?.trim() || baseProfile.label,
    keywords: mergedKeywords,
    ownedTargetChannel: opts.ownedTargetChannel?.trim() || baseProfile.ownedTargetChannel,
    captureSources: Array.from(sourceMap.values()),
  };

  if (existingIndex >= 0) {
    profiles[existingIndex] = updatedProfile;
  } else {
    profiles.push(updatedProfile);
  }

  writePrivateFile(demandsFile, `${JSON.stringify(profiles, null, 2)}\n`);

  const wiretapGuildIds = Array.from(
    new Set(
      profiles
        .flatMap((p) => p.captureSources)
        .filter(
          (s) =>
            s.tier === "desktop_wiretap" &&
            s.guildId &&
            !s.guildId.startsWith("REPLACE_")
        )
        .map((s) => s.guildId.trim())
    )
  );

  if (tier === "desktop_wiretap" || wiretapGuildIds.length > 0) {
    const defaultGuild = wiretapGuildIds[0] || "REPLACE_EXTERNAL_GUILD_ID";
    const guildIdsList = wiretapGuildIds.map((id) => JSON.stringify(id)).join(", ");
    let tomlContent = fs.existsSync(wiretapConfigPath)
      ? fs.readFileSync(wiretapConfigPath, "utf8")
      : [
          "# Local untracked discrawl wiretap config (chmod 600).",
          "",
          "version = 1",
          'db_path = ".state/discrawl-external.db"',
          'cache_dir = ".state/discrawl-cache"',
          'log_dir = ".state/discrawl-logs"',
          `default_guild_id = ${JSON.stringify(defaultGuild)}`,
          `guild_ids = [${guildIdsList}]`,
          "",
          "[sync]",
          'source = "wiretap"',
          "attachment_text = false",
          "attachment_media = false",
          "",
          "[share]",
          "auto_update = false",
          "",
          "[search]",
          'default_mode = "fts"',
          "",
          "[search.embeddings]",
          "enabled = false",
          "",
        ].join("\n");

    tomlContent = tomlContent.replace(
      /^\s*lexical\s*=\s*["'][^"']*["']\s*$/gm,
      'default_mode = "fts"'
    );

    const missingRuntimeDirs: string[] = [];
    if (!/^\s*cache_dir\s*=/m.test(tomlContent)) {
      missingRuntimeDirs.push('cache_dir = ".state/discrawl-cache"');
    }
    if (!/^\s*log_dir\s*=/m.test(tomlContent)) {
      missingRuntimeDirs.push('log_dir = ".state/discrawl-logs"');
    }
    if (missingRuntimeDirs.length > 0) {
      if (/^\s*db_path\s*=.*$/m.test(tomlContent)) {
        tomlContent = tomlContent.replace(
          /^\s*db_path\s*=.*$/m,
          (line) => `${line}\n${missingRuntimeDirs.join("\n")}`
        );
      } else {
        tomlContent = `${missingRuntimeDirs.join("\n")}\n${tomlContent}`;
      }
    }

    if (/^default_guild_id\s*=.*$/m.test(tomlContent)) {
      tomlContent = tomlContent.replace(
        /^default_guild_id\s*=.*$/m,
        `default_guild_id = ${JSON.stringify(defaultGuild)}`
      );
    } else {
      tomlContent = `default_guild_id = ${JSON.stringify(defaultGuild)}\n${tomlContent}`;
    }

    if (/^guild_ids\s*=.*$/m.test(tomlContent)) {
      tomlContent = tomlContent.replace(
        /^guild_ids\s*=.*$/m,
        `guild_ids = [${guildIdsList}]`
      );
    } else {
      tomlContent = `guild_ids = [${guildIdsList}]\n${tomlContent}`;
    }

    writePrivateFile(wiretapConfigPath, tomlContent);
  }

  return {
    demandsFile,
    wiretapConfigPath,
    profile: updatedProfile,
    wiretapGuildIds,
  };
}

export interface DemoPackOptions {
  dbPath?: string;
  demandsFile?: string;
  outDir?: string;
  demandId?: string;
  urls?: string[];
  guildId?: string;
  channelIds?: string[];
  keywords?: string[];
  hours?: number;
  lang?: string;
  fromLang?: string;
  pivotLang?: string;
  fetchFn?: typeof fetch;
}

function sanitizeDemoAlias(rawName: string, index: number): string {
  const cleaned = scrubSnowflakeIds(rawName)
    .replace(/\[id\]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned && !/^channel-?\d*$/.test(cleaned)) {
    return `#${cleaned}`;
  }
  return `#channel-${String(index + 1).padStart(2, "0")}`;
}

function clampDemoSnippet(text: string): string {
  const scrubbed = stripContentSlop(scrubSnowflakeIds(text)).cleanText;
  const words = scrubbed.split(/\s+/).filter(Boolean).slice(0, 10);
  return words.join(" ");
}

function renderDemoPackMarkdown(pack: DemoInsightsPack): string {
  const lines: string[] = [
    `# Hackathon Demo Insights Pack (\`${pack.demandId}\`)`,
    "",
    `1. **Generated At**: \`${pack.generatedAt}\``,
    `2. **Topic Profile**: ${pack.demandLabel}`,
    `3. **Lookback Window**: \`${pack.hoursWindow}\` hours (\`${pack.totalMatchedMessages}\` matched messages)`,
    `4. **VoiceGate Status**: \`${pack.voiceGate.ok ? "pass" : "fail"}\` (\`maxConsecutiveOverlap=${pack.voiceGate.maxConsecutiveOverlap}\`)`,
    "",
    "## 1. Monitored Channel Coverage",
    "",
  ];

  if (pack.channelCoverage.length === 0) {
    lines.push("1. No captured channel messages matched this profile window yet.", "");
  } else {
    lines.push("| Channel Alias | Matched Posts |", "| :--- | :--- |");
    for (const cov of pack.channelCoverage) {
      lines.push(`| \`${cov.alias}\` | ${cov.messageCount} |`);
    }
    lines.push("");
  }

  lines.push("## 2. Ranked Community Signals", "");
  if (pack.topSignals.length === 0) {
    lines.push("1. Add desktop cache captures or `.state/inbox/` snapshots and re-run `demo:pack`.", "");
  } else {
    lines.push("| Rank | Category | Topic | Posts | Score | Channels |", "| :--- | :--- | :--- | :--- | :--- | :--- |");
    pack.topSignals.forEach((sig, idx) => {
      const channels = sig.channelNames.map((c) => `\`${c}\``).join(", ") || "`none`";
      lines.push(
        `| ${idx + 1} | \`${sig.category}\` | ${sig.title} | ${sig.messageCount} | ${sig.score} | ${channels} |`
      );
    });
    lines.push("");
  }

  lines.push("## 3. Hackathon Demo Talking Points", "");
  pack.demoTalkingPoints.forEach((pt, idx) => {
    lines.push(`${idx + 1}. ${pt}`);
  });
  lines.push(
    "",
    "## 4. Verified Draft Starter",
    "",
    `**Headline**: ${pack.brief.headline}`,
    "",
    ...pack.brief.outlinePoints,
    "",
    pack.brief.draftStarter,
    ""
  );

  return `${lines.join("\n").trimEnd()}\n`;
}

/** Export a Snowflake scrubbed, anonymized, voiceGate checked insights pack for demos. */
export async function exportDemoPack(opts: DemoPackOptions = {}): Promise<DemoInsightsPack> {
  const { demands } = loadDemandProfiles(opts.demandsFile ?? "");
  const nonPlaceholderDemand = demands.find((d) =>
    d.captureSources.some((s) => !s.guildId.startsWith("REPLACE_") && !s.channelId.startsWith("REPLACE_"))
  );
  const selectedDemand =
    demands.find((d) => d.id === opts.demandId) ?? nonPlaceholderDemand ?? demands[0];

  const demandId = opts.demandId?.trim() || selectedDemand?.id || "hackathon-demo";
  const demandLabel = stripContentSlop(
    scrubSnowflakeIds(selectedDemand?.label || opts.keywords?.join(", ") || demandId)
  ).cleanText;
  const keywords =
    opts.keywords && opts.keywords.length > 0
      ? opts.keywords
      : selectedDemand?.keywords ?? [];
  const targetChannel = stripContentSlop(
    scrubSnowflakeIds(selectedDemand?.ownedTargetChannel || "#demo-insights")
  ).cleanText;

  const urlTargets = (opts.urls ?? []).map((u) => parseDiscordChannelUrl(u));
  const explicitChannelIds = new Set((opts.channelIds ?? []).map((c) => c.trim()).filter(Boolean));
  const demandSources = (selectedDemand?.captureSources ?? []).filter(
    (s) => !s.guildId.startsWith("REPLACE_") && !s.channelId.startsWith("REPLACE_")
  );

  const dbPath = opts.dbPath?.trim() || process.env.RADAR_DB_PATH?.trim() || ".state/radar.db";
  const outDir = path.resolve(opts.outDir?.trim() || ".state/demo-packs");
  ensurePrivateDir(outDir);
  const hoursWindow = opts.hours ?? 720;

  const vault = new RadarVault(dbPath);
  try {
    const recent = vault.recentMessages(hoursWindow, { limit: 1000 });
    const filtered = recent.filter((msg) => {
      if (msg.guildId.trim().toLowerCase() === "@me") return false;
      if (urlTargets.length > 0) {
        return urlTargets.some(
          (t) => t.guildId === msg.guildId && t.channelId === msg.channelId
        );
      }
      if (opts.guildId || explicitChannelIds.size > 0) {
        if (opts.guildId && msg.guildId !== opts.guildId.trim()) return false;
        if (explicitChannelIds.size > 0 && !explicitChannelIds.has(msg.channelId)) return false;
        return true;
      }
      if (demandSources.length > 0) {
        return demandSources.some(
          (src) =>
            src.guildId === msg.guildId &&
            (src.channelId === msg.channelId || msg.channelName === "forum-threads")
        );
      }
      return true;
    });

    const byChannel = new Map<string, { name: string; count: number }>();
    for (const msg of filtered) {
      const prev = byChannel.get(msg.channelId);
      if (prev) {
        prev.count += 1;
      } else {
        byChannel.set(msg.channelId, { name: msg.channelName || msg.channelId, count: 1 });
      }
    }

    const sortedChannels = Array.from(byChannel.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    );
    const aliasByRawName = new Map<string, string>();
    const channelCoverage: DemoChannelCoverage[] = sortedChannels.map(([chId, info], idx) => {
      const alias = sanitizeDemoAlias(info.name, idx);
      aliasByRawName.set(info.name, alias);
      aliasByRawName.set(chId, alias);
      return { alias, messageCount: info.count };
    });

    const rawClusters = extractSignals(filtered, keywords);
    const sanitizedClusters: SignalCluster[] = rawClusters.slice(0, 8).map((cluster) => ({
      ...cluster,
      title: stripContentSlop(scrubSnowflakeIds(cluster.title)).cleanText,
      channelNames: Array.from(
        new Set(
          cluster.channelNames.map(
            (name) => aliasByRawName.get(name) ?? sanitizeDemoAlias(name, 0)
          )
        )
      ),
      sampleSnippets: cluster.sampleSnippets.map(clampDemoSnippet).filter(Boolean),
    }));

    let brief = buildContentBrief(sanitizedClusters, demandLabel, targetChannel);
    if (opts.lang?.trim()) {
      brief = await translateContentBrief(
        brief,
        {
          to: opts.lang.trim(),
          from: opts.fromLang?.trim() || "auto",
          pivot: opts.pivotLang?.trim() || undefined,
          fetchFn: opts.fetchFn,
        },
        sanitizedClusters.flatMap((c) => c.sampleSnippets)
      );
    }

    const catCounts = new Map<string, number>();
    for (const sig of sanitizedClusters) {
      catCounts.set(sig.category, (catCounts.get(sig.category) ?? 0) + 1);
    }

    const demoTalkingPoints: string[] = [
      `Analyzed ${filtered.length} anonymized messages across ${channelCoverage.length} monitored channel(s) over the last ${hoursWindow} hours.`,
      sanitizedClusters.length > 0
        ? `Top signal cluster: ${sanitizedClusters[0]!.title} with ${sanitizedClusters[0]!.messageCount} posts across ${sanitizedClusters[0]!.channelNames.join(", ")}.`
        : "No channel messages matched this lookback window yet; scroll channels in Discord Desktop or add inbox snapshots and re-run.",
      `Category breakdown: ${catCounts.get("recurring_bug") ?? 0} recurring bugs, ${catCounts.get("unanswered_question") ?? 0} unanswered questions, ${catCounts.get("feature_demand") ?? 0} feature requests, and ${catCounts.get("comparison_thread") ?? 0} comparisons.`,
      `All headlines and notes passed checkVoiceGate with ${brief.voiceGate.maxConsecutiveOverlap} max consecutive overlapping words and zero raw Snowflake IDs.`,
    ];

    const safeSlug = demandId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "hackathon-demo";
    const jsonPath = path.join(outDir, `${safeSlug}.json`);
    const markdownPath = path.join(outDir, `${safeSlug}.md`);

    const pack: DemoInsightsPack = {
      demandId,
      demandLabel,
      generatedAt: new Date().toISOString(),
      hoursWindow,
      totalMatchedMessages: filtered.length,
      channelCoverage,
      topSignals: sanitizedClusters,
      demoTalkingPoints,
      brief,
      voiceGate: brief.voiceGate,
      markdownPath,
      jsonPath,
    };

    const finalMarkdown = renderDemoPackMarkdown(pack);
    const rawExternalContents = filtered.map((m) => m.content);
    const mdVoiceGate = checkVoiceGate(finalMarkdown, rawExternalContents);
    pack.voiceGate = mdVoiceGate;

    writePrivateFile(jsonPath, `${JSON.stringify(pack, null, 2)}\n`);
    writePrivateFile(markdownPath, renderDemoPackMarkdown(pack));
    return pack;
  } finally {
    vault.close();
  }
}
