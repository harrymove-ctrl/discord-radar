import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildContentBrief, extractSignals } from "./signals.ts";
import { parseBrowserSnapshot } from "./snapshot.ts";
import { translateContentBrief } from "./translate.ts";
import type {
  DailyDigestReport,
  DemandCaptureSource,
  DemandDigestSection,
  DemandProfile,
  InboxIngestReport,
  NormalizedMessage,
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

export function loadDemandProfiles(
  explicitPath = ""
): { configPath: string; demands: DemandProfile[] } {
  const configPath = resolveDemandsPath(explicitPath);
  if (!fs.existsSync(configPath)) return { configPath, demands: [] };
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  const demands = Array.isArray(parsed) ? (parsed as DemandProfile[]) : [];
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
      createdAt: String(obj.sent_at ?? obj.createdAt ?? new Date().toISOString()),
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
    const wiretapGuilds = Array.from(
      new Set(
        validSources
          .filter((s) => s.tier === "desktop_wiretap" && s.guildId)
          .map((s) => s.guildId.trim())
      )
    );
    const tomlBody = fs.readFileSync(wiretapConfigPath, "utf8");
    if (wiretapGuilds.length === 0 && /REPLACE_/.test(tomlBody)) {
      wiretapStatus = "skipped_not_configured";
    } else {
      try {
        const spawnEnv = {
          ...process.env,
          DISCRAWL_NO_UPDATE_CHECK: "1",
          DISCRAWL_NO_AUTO_UPDATE: "1",
        };
        let wiretapOk = true;
        if (wiretapGuilds.length > 0) {
          for (const guildId of wiretapGuilds) {
            const tap = spawnSync(
              discrawlBin,
              ["--config", wiretapConfigPath, "wiretap", "--guild", guildId],
              { encoding: "utf8", env: spawnEnv }
            );
            if (tap.status !== 0) {
              wiretapOk = false;
              break;
            }
          }
        } else {
          const tap = spawnSync(discrawlBin, ["--config", wiretapConfigPath, "wiretap"], {
            encoding: "utf8",
            env: spawnEnv,
          });
          if (tap.status !== 0) wiretapOk = false;
        }

        if (!wiretapOk) {
          wiretapStatus = "failed";
        } else {
          const sqlQuery =
            "SELECT message_id, guild_id, channel_id, author_id, author_name, content, sent_at FROM messages WHERE lower(guild_id) != '@me' ORDER BY sent_at DESC LIMIT 500";
          const dump = spawnSync(
            discrawlBin,
            ["--config", wiretapConfigPath, "sql", sqlQuery, "--jsonl"],
            { encoding: "utf8", env: spawnEnv }
          );
          if (dump.status !== 0) {
            wiretapStatus = "failed";
          } else {
            const rows = parseJsonlMessages(dump.stdout || "", { tier: "desktop_wiretap" });
            const summary = vault.ingestMessages(rows);
            inserted += summary.inserted;
            skippedDuplicates += summary.skippedDuplicates;
            quarantinedDmCount += summary.quarantinedDmCount;
            wiretapStatus = "ingested";
          }
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
