#!/usr/bin/env bun
import fs from "node:fs";
import { assertSafeBotToken, checkVoiceGate, redactSecrets } from "./security.ts";
import {
  loadDemandProfiles,
  parseJsonlMessages,
  runDailyDigest,
} from "./digest.ts";
import {
  ensureDailyScheduleState,
  installCronSchedule,
  previewRandomScheduleDays,
  runScheduleTick,
  uninstallCronSchedule,
} from "./schedule.ts";
import { buildContentBrief, extractSignals } from "./signals.ts";
import { parseBrowserSnapshot } from "./snapshot.ts";
import { translateContentBrief, translateText } from "./translate.ts";
import type { CliEnvelope, NormalizedMessage, SourceTier } from "./types.ts";
import { RadarVault } from "./vault.ts";

interface CliOptions {
  json: boolean;
  dbPath: string;
  outDir: string;
  inboxDir: string;
  guildId: string;
  channelId: string;
  channelName: string;
  tier: SourceTier;
  file: string;
  hours: number;
  limit: number;
  keywords: string[];
  demandId: string;
  demandsFile: string;
  targetChannel: string;
  draft: string;
  text: string;
  lang: string;
  fromLang: string;
  pivotLang: string;
  windowStart: string;
  windowEnd: string;
  timeZone: string;
  stateFile: string;
  tick: boolean;
  force: boolean;
  status: boolean;
  previewDays: number;
  installCron: boolean;
  uninstallCron: boolean;
  noIngest: boolean;
  positionals: string[];
}

function parseFlags(argv: string[]): { command: string; opts: CliOptions } {
  const command = argv[0] ?? "doctor";
  const opts: CliOptions = {
    json: false,
    dbPath: process.env.RADAR_DB_PATH?.trim() || ".state/radar.db",
    outDir: "",
    inboxDir: "",
    guildId: "",
    channelId: "",
    channelName: "",
    tier: "desktop_wiretap",
    file: "",
    hours: 24,
    limit: 50,
    keywords: [],
    demandId: "",
    demandsFile: "",
    targetChannel: "#engineering-notes",
    draft: "",
    text: "",
    lang: process.env.RADAR_TARGET_LANG?.trim() || "",
    fromLang: "auto",
    pivotLang: "",
    windowStart: process.env.RADAR_WINDOW_START?.trim() || "08:00",
    windowEnd: process.env.RADAR_WINDOW_END?.trim() || "18:00",
    timeZone: process.env.RADAR_TIMEZONE?.trim() || "",
    stateFile: "",
    tick: false,
    force: false,
    status: false,
    previewDays: 0,
    installCron: false,
    uninstallCron: false,
    noIngest: false,
    positionals: [],
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--json") opts.json = true;
    else if (arg === "--tick") opts.tick = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--status") opts.status = true;
    else if (arg === "--install-cron") opts.installCron = true;
    else if (arg === "--uninstall-cron") opts.uninstallCron = true;
    else if (arg === "--no-ingest") opts.noIngest = true;
    else if (arg === "--db" && argv[i + 1]) {
      opts.dbPath = argv[++i]!;
    } else if (arg === "--out-dir" && argv[i + 1]) {
      opts.outDir = argv[++i]!;
    } else if (arg === "--inbox-dir" && argv[i + 1]) {
      opts.inboxDir = argv[++i]!;
    } else if (arg === "--guild" && argv[i + 1]) {
      opts.guildId = argv[++i]!;
    } else if (arg === "--channel" && argv[i + 1]) {
      opts.channelId = argv[++i]!;
    } else if (arg === "--channel-name" && argv[i + 1]) {
      opts.channelName = argv[++i]!;
    } else if (arg === "--tier" && argv[i + 1]) {
      opts.tier = argv[++i]! as SourceTier;
    } else if (arg === "--file" && argv[i + 1]) {
      opts.file = argv[++i]!;
    } else if (arg === "--hours" && argv[i + 1]) {
      opts.hours = Number.parseInt(argv[++i]!, 10) || 24;
    } else if (arg === "--limit" && argv[i + 1]) {
      opts.limit = Number.parseInt(argv[++i]!, 10) || 50;
    } else if (arg === "--keywords" && argv[i + 1]) {
      opts.keywords = argv[++i]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === "--demand" && argv[i + 1]) {
      opts.demandId = argv[++i]!;
    } else if (arg === "--demands-file" && argv[i + 1]) {
      opts.demandsFile = argv[++i]!;
    } else if (arg === "--target-channel" && argv[i + 1]) {
      opts.targetChannel = argv[++i]!;
    } else if (arg === "--draft" && argv[i + 1]) {
      opts.draft = argv[++i]!;
    } else if (arg === "--text" && argv[i + 1]) {
      opts.text = argv[++i]!;
    } else if ((arg === "--lang" || arg === "--to") && argv[i + 1]) {
      opts.lang = argv[++i]!;
    } else if (arg === "--from" && argv[i + 1]) {
      opts.fromLang = argv[++i]!;
    } else if (arg === "--pivot" && argv[i + 1]) {
      opts.pivotLang = argv[++i]!;
    } else if (arg === "--window-start" && argv[i + 1]) {
      opts.windowStart = argv[++i]!;
    } else if (arg === "--window-end" && argv[i + 1]) {
      opts.windowEnd = argv[++i]!;
    } else if (arg === "--tz" && argv[i + 1]) {
      opts.timeZone = argv[++i]!;
    } else if (arg === "--state-file" && argv[i + 1]) {
      opts.stateFile = argv[++i]!;
    } else if (arg === "--preview-days" && argv[i + 1]) {
      opts.previewDays = Number.parseInt(argv[++i]!, 10) || 5;
    } else if (!arg.startsWith("-")) {
      opts.positionals.push(arg);
    }
  }

  return { command, opts };
}

function emit<T>(opts: CliOptions, envelope: CliEnvelope<T>): void {
  const forceJson = opts.json || !process.stdout.isTTY;
  if (forceJson) {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }
  if (!envelope.ok) {
    console.error(`ERROR [${envelope.error?.code}]: ${envelope.error?.message}`);
    if (envelope.error?.hint) console.error(`Hint: ${envelope.error.hint}`);
    return;
  }
  console.log(JSON.stringify(envelope.data, null, 2));
}

async function run(): Promise<void> {
  const { command, opts } = parseFlags(process.argv.slice(2));
  let vault: RadarVault | null = null;

  try {
    if (command === "doctor") {
      const botToken = process.env.DISCORD_BOT_TOKEN?.trim() || "";
      let botTokenValid = "not_configured";
      if (botToken) {
        assertSafeBotToken(botToken);
        botTokenValid = "valid_bot_format";
      }
      const discrawlBin = process.env.DISCRAWL_BIN?.trim() || "discrawl";
      const { configPath: demandsPath, demands } = loadDemandProfiles(opts.demandsFile);

      emit(opts, {
        ok: true,
        schema_version: "1",
        data: {
          dbPath: opts.dbPath,
          botTokenStatus: botTokenValid,
          discrawlBinaryPresent: fs.existsSync(discrawlBin) || Boolean(Bun.which(discrawlBin)),
          discrawlBinPath: discrawlBin,
          demandsConfigPath: demandsPath,
          demandCount: demands.length,
        },
      });
      return;
    }

    if (command === "targets") {
      const { configPath, demands } = loadDemandProfiles(opts.demandsFile);
      emit(opts, {
        ok: true,
        schema_version: "1",
        data: {
          configPath,
          demands,
        },
      });
      return;
    }

    if (command === "voice-check") {
      const draftText = opts.draft || (opts.file ? fs.readFileSync(opts.file, "utf8") : "");
      if (!draftText.trim()) {
        emit(opts, {
          ok: false,
          schema_version: "1",
          error: {
            code: "missing_draft",
            message: "Provide --draft <text> or --file <path> to run voice-check.",
          },
        });
        process.exitCode = 1;
        return;
      }
      const result = checkVoiceGate(draftText, []);
      emit(opts, {
        ok: result.ok,
        schema_version: "1",
        data: result,
        ...(result.ok
          ? {}
          : {
              error: {
                code: "voice_gate_failed",
                message: `Draft rejected by voiceGate: ${result.reasons.join(", ")}`,
              },
            }),
      });
      if (!result.ok) process.exitCode = 1;
      return;
    }

    if (command === "translate") {
      const inputText =
        opts.text ||
        opts.draft ||
        (opts.file ? fs.readFileSync(opts.file, "utf8") : opts.positionals.join(" ").trim());
      if (!inputText.trim() || !opts.lang.trim()) {
        emit(opts, {
          ok: false,
          schema_version: "1",
          error: {
            code: "missing_arguments",
            message: "translate requires text (--text, --draft, --file, or positional) and --to <lang>.",
          },
        });
        process.exitCode = 1;
        return;
      }
      const translated = await translateText(inputText, {
        to: opts.lang,
        from: opts.fromLang,
        pivot: opts.pivotLang || undefined,
      });
      const gate = checkVoiceGate(translated.translatedText, []);
      emit(opts, {
        ok: gate.ok,
        schema_version: "1",
        data: { ...translated, voiceGate: gate },
        ...(gate.ok
          ? {}
          : {
              error: {
                code: "voice_gate_failed",
                message: `Translated text rejected by voiceGate: ${gate.reasons.join(", ")}`,
              },
            }),
      });
      if (!gate.ok) process.exitCode = 1;
      return;
    }

    if (command === "digest") {
      const report = await runDailyDigest({
        dbPath: opts.dbPath,
        outDir: opts.outDir || undefined,
        inboxDir: opts.inboxDir || undefined,
        demandsFile: opts.demandsFile,
        hours: opts.hours,
        lang: opts.lang || undefined,
        fromLang: opts.fromLang,
        pivotLang: opts.pivotLang || undefined,
        timeZone: opts.timeZone || undefined,
        autoIngest: !opts.noIngest,
      });
      emit(opts, { ok: true, schema_version: "1", data: report });
      return;
    }

    if (command === "schedule") {
      if (opts.uninstallCron) {
        const res = uninstallCronSchedule();
        emit(opts, { ok: true, schema_version: "1", data: res });
        return;
      }
      if (opts.installCron) {
        const res = installCronSchedule({
          windowStart: opts.windowStart,
          windowEnd: opts.windowEnd,
          timeZone: opts.timeZone || undefined,
          statePath: opts.stateFile || undefined,
        });
        emit(opts, { ok: true, schema_version: "1", data: res });
        return;
      }
      if (opts.previewDays > 0) {
        const slots = previewRandomScheduleDays(opts.previewDays, {
          windowStart: opts.windowStart,
          windowEnd: opts.windowEnd,
          timeZone: opts.timeZone || undefined,
        });
        emit(opts, { ok: true, schema_version: "1", data: { count: slots.length, slots } });
        return;
      }
      if (opts.tick || opts.force) {
        const tickResult = await runScheduleTick({
          windowStart: opts.windowStart,
          windowEnd: opts.windowEnd,
          timeZone: opts.timeZone || undefined,
          statePath: opts.stateFile || undefined,
          force: opts.force,
          digestOpts: {
            dbPath: opts.dbPath,
            outDir: opts.outDir || undefined,
            inboxDir: opts.inboxDir || undefined,
            demandsFile: opts.demandsFile,
            hours: opts.hours,
            lang: opts.lang || undefined,
            fromLang: opts.fromLang,
            pivotLang: opts.pivotLang || undefined,
            autoIngest: !opts.noIngest,
          },
        });
        emit(opts, { ok: true, schema_version: "1", data: tickResult });
        return;
      }

      const state = ensureDailyScheduleState({
        windowStart: opts.windowStart,
        windowEnd: opts.windowEnd,
        timeZone: opts.timeZone || undefined,
        statePath: opts.stateFile || undefined,
      });
      emit(opts, { ok: true, schema_version: "1", data: state });
      return;
    }

    vault = new RadarVault(opts.dbPath);

    if (command === "ingest-snapshot") {
      if (!opts.file || !opts.guildId || !opts.channelId) {
        emit(opts, {
          ok: false,
          schema_version: "1",
          error: {
            code: "missing_arguments",
            message: "ingest-snapshot requires --file, --guild, and --channel.",
          },
        });
        process.exitCode = 1;
        return;
      }
      const raw = fs.readFileSync(opts.file, "utf8");
      const items = parseBrowserSnapshot(raw, {
        guildId: opts.guildId,
        channelId: opts.channelId,
        channelName: opts.channelName || opts.channelId,
      });
      const summary = vault.ingestMessages(items);
      emit(opts, { ok: true, schema_version: "1", data: { parsed: items.length, ...summary } });
      return;
    }

    if (command === "ingest-jsonl") {
      const raw = opts.file ? fs.readFileSync(opts.file, "utf8") : fs.readFileSync(0, "utf8");
      const items: NormalizedMessage[] = parseJsonlMessages(raw, {
        guildId: opts.guildId,
        channelId: opts.channelId,
        channelName: opts.channelName,
        tier: opts.tier,
      });
      const summary = vault.ingestMessages(items);
      emit(opts, { ok: true, schema_version: "1", data: { parsed: items.length, ...summary } });
      return;
    }

    if (command === "today") {
      const messages = vault.recentMessages(opts.hours, {
        guildId: opts.guildId || undefined,
        channelId: opts.channelId || undefined,
        limit: opts.limit,
      });
      emit(opts, {
        ok: true,
        schema_version: "1",
        data: { count: messages.length, stats: vault.getStats(), messages },
      });
      return;
    }

    if (command === "search") {
      const query = opts.positionals.join(" ").trim();
      const messages = vault.searchMessages(query, {
        guildId: opts.guildId || undefined,
        channelId: opts.channelId || undefined,
        limit: opts.limit,
      });
      emit(opts, { ok: true, schema_version: "1", data: { query, count: messages.length, messages } });
      return;
    }

    if (command === "signals" || command === "brief") {
      const { demands } = loadDemandProfiles(opts.demandsFile);
      const selectedDemand =
        demands.find((d) => d.id === opts.demandId) ??
        (demands.length > 0 && !opts.keywords.length ? demands[0] : undefined);
      const keywords = opts.keywords.length > 0 ? opts.keywords : selectedDemand?.keywords ?? [];
      const demandLabel = selectedDemand?.label ?? (keywords.join(", ") || "General Topics");
      const targetChannel = opts.targetChannel || selectedDemand?.ownedTargetChannel || "#general";

      const messages = vault.recentMessages(opts.hours, {
        guildId: opts.guildId || undefined,
        channelId: opts.channelId || undefined,
        limit: Math.max(opts.limit, 200),
      });
      const clusters = extractSignals(messages, keywords);

      if (command === "signals") {
        emit(opts, {
          ok: true,
          schema_version: "1",
          data: { demandLabel, keywordCount: keywords.length, clusterCount: clusters.length, clusters },
        });
        return;
      }

      let brief = buildContentBrief(clusters, demandLabel, targetChannel);
      if (opts.lang.trim()) {
        const externalSnippets = clusters.flatMap((c) => c.sampleSnippets);
        brief = await translateContentBrief(
          brief,
          {
            to: opts.lang,
            from: opts.fromLang,
            pivot: opts.pivotLang || undefined,
          },
          externalSnippets
        );
      }
      emit(opts, { ok: true, schema_version: "1", data: brief });
      return;
    }

    emit(opts, {
      ok: false,
      schema_version: "1",
      error: {
        code: "unknown_command",
        message: `Unknown command "${command}".`,
        hint: "Use doctor, targets, ingest-snapshot, ingest-jsonl, today, search, signals, brief, digest, schedule, translate, or voice-check.",
      },
    });
    process.exitCode = 1;
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    emit(opts, {
      ok: false,
      schema_version: "1",
      error: {
        code: "cli_execution_error",
        message: redactSecrets(rawMsg),
      },
    });
    process.exitCode = 1;
  } finally {
    vault?.close();
  }
}

void run();
