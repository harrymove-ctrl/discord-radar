import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RadarVault,
  assertSafeBotToken,
  buildContentBrief,
  checkVoiceGate,
  ensureDailyScheduleState,
  extractSignals,
  isQuarantinedDm,
  parseBrowserSnapshot,
  pickDailyTargetMinute,
  redactSecrets,
  runDailyDigest,
  runScheduleTick,
  stripContentSlop,
  translateContentBrief,
  translateText,
  validateDiscordCdnUrl,
} from "../src/index.ts";

describe("discord-radar safety and signal pipeline", () => {
  test("quarantines @me DMs from ingest, search, and stats", () => {
    const vault = new RadarVault(":memory:");
    const summary = vault.ingestMessages([
      {
        messageId: "dm-1",
        guildId: "@me",
        channelId: "dm-chan-1",
        channelName: "dm",
        authorName: "alice",
        content: "Private secret billing note that must never leak",
        createdAt: new Date().toISOString(),
        sourceTier: "desktop_wiretap",
      },
      {
        messageId: "pub-1",
        guildId: "guild-ext-1",
        channelId: "chan-help",
        channelName: "remotion-help",
        authorName: "bob",
        content: "How do I fix audio sync during remotion render?",
        createdAt: new Date().toISOString(),
        sourceTier: "desktop_wiretap",
      },
    ]);

    expect(summary.quarantinedDmCount).toBe(1);
    expect(summary.inserted).toBe(1);
    expect(isQuarantinedDm("@me")).toBe(true);
    expect(isQuarantinedDm("guild-ext-1", "general")).toBe(false);
    expect(vault.searchMessages("Private secret billing")).toHaveLength(0);
    expect(vault.searchMessages("remotion render")).toHaveLength(1);
    expect(vault.getStats().totalMessages).toBe(1);
    vault.close();
  });

  test("enforces strict HTTPS port 443 Discord CDN allowlist and scrubs SSRF URLs", () => {
    expect(validateDiscordCdnUrl("https://cdn.discordapp.com/attachments/1/2/log.png")).toBe(true);
    expect(validateDiscordCdnUrl("https://media.discordapp.net/attachments/1/2/frame.webp")).toBe(true);
    expect(validateDiscordCdnUrl("https://images-ext-1.discordapp.net/external/abc/img.jpg")).toBe(true);

    expect(validateDiscordCdnUrl("http://cdn.discordapp.com/attachments/1/2/log.png")).toBe(false);
    expect(validateDiscordCdnUrl("https://cdn.discordapp.com:8443/attachments/1/2/log.png")).toBe(false);
    expect(validateDiscordCdnUrl("https://127.0.0.1/latest/meta-data")).toBe(false);
    expect(validateDiscordCdnUrl("https://localhost:3000/secret")).toBe(false);
    expect(validateDiscordCdnUrl("https://user:pass@cdn.discordapp.com/test.png")).toBe(false);
    expect(validateDiscordCdnUrl("https://evil.example.com/cdn.discordapp.com")).toBe(false);
  });

  test("anonymizes external speakers and deduplicates across wiretap and browser snapshot", () => {
    const vault = new RadarVault(":memory:");
    const nowIso = new Date().toISOString();

    const firstPass = vault.ingestMessages([
      {
        messageId: "9988776655",
        guildId: "guild-ext-2",
        channelId: "chan-mcp",
        channelName: "mcp-servers",
        authorId: "123456789012345678",
        authorName: "real_dev_handle",
        content: "Ping @real_dev_handle or email dev@example.com for mcp timeout 123456789012345678",
        attachmentUrls: ["https://cdn.discordapp.com/a.png", "http://169.254.169.254/latest"],
        createdAt: nowIso,
        sourceTier: "desktop_wiretap",
      },
    ]);

    expect(firstPass.inserted).toBe(1);
    expect(firstPass.rejectedAttachmentCount).toBe(1);

    const parsedSnapshot = parseBrowserSnapshot(
      JSON.stringify([
        {
          id: "9988776655",
          authorName: "real_dev_handle",
          content: "Ping @real_dev_handle or email dev@example.com for mcp timeout 123456789012345678",
          timestamp: nowIso,
        },
        {
          authorName: "second_member",
          content: "Anyone comparing kiro hooks vs manual scripts?",
          timestamp: nowIso,
        },
      ]),
      { guildId: "guild-ext-2", channelId: "chan-mcp", channelName: "mcp-servers" }
    );

    const secondPass = vault.ingestMessages(parsedSnapshot);
    expect(secondPass.skippedDuplicates).toBe(1);
    expect(secondPass.inserted).toBe(1);

    const stored = vault.recentMessages(24);
    expect(stored).toHaveLength(2);
    const firstRow = stored.find((m) => m.messageId === "9988776655");
    expect(firstRow?.authorRef).toBe("Participant_1");
    expect(firstRow?.content).not.toContain("real_dev_handle");
    expect(firstRow?.content).not.toContain("dev@example.com");
    expect(firstRow?.content).not.toContain("123456789012345678");
    expect(firstRow?.attachments).toEqual(["https://cdn.discordapp.com/a.png"]);
    vault.close();
  });

  test("extracts demand weighted signal clusters and builds voiceGated briefs", () => {
    const vault = new RadarVault(":memory:");
    const nowIso = new Date().toISOString();
    vault.ingestMessages([
      {
        messageId: "sig-1",
        guildId: "guild-ext-3",
        channelId: "c1",
        channelName: "remotion-help",
        authorName: "u1",
        content: "Why does ffmpeg audio render fail with timeout on long captions?",
        createdAt: nowIso,
        sourceTier: "desktop_wiretap",
      },
      {
        messageId: "sig-2",
        guildId: "guild-ext-3",
        channelId: "c1",
        channelName: "remotion-help",
        authorName: "u2",
        content: "Seeing the same remotion render error when captions overlap audio",
        createdAt: nowIso,
        sourceTier: "browser_snapshot",
      },
    ]);

    const rows = vault.recentMessages(24);
    const clusters = extractSignals(rows, ["remotion", "audio", "render"]);
    expect(clusters.length).toBeGreaterThan(0);
    expect(clusters[0]!.category).toBe("recurring_bug");
    expect(clusters[0]!.matchedKeywords).toContain("remotion");

    const brief = buildContentBrief(clusters, "AI Video Maker", "#video-tips");
    expect(brief.targetChannel).toBe("#video-tips");
    expect(brief.voiceGate.ok).toBe(true);
    expect(brief.outlinePoints.length).toBeGreaterThan(0);
    vault.close();
  });

  test("blocks AI dashes, zero width chars, HTML, and external copying in voiceGate", () => {
    const ext = [
      "This exact troubleshooting sentence lists every single workaround step cleanly for local setups",
    ];
    expect(checkVoiceGate("This has an em dash \u2014 reject it.", ext).reasons).toContain(
      "forbidden_dash_punctuation"
    );
    expect(checkVoiceGate("This has a spaced - hyphen.", ext).reasons).toContain(
      "spaced_hyphen_slop"
    );
    expect(checkVoiceGate("Hidden\u200Bspace", ext).reasons).toContain("zero_width_artifact");
    expect(checkVoiceGate("<p>HTML block</p>", ext).reasons).toContain("html_markup_detected");

    const copied =
      "This exact troubleshooting sentence lists every single workaround step cleanly for local setups today";
    expect(checkVoiceGate(copied, ext).reasons).toContain("plagiarism_overlap_exceeded");

    const clean = checkVoiceGate(
      "Here is our original setup checklist for running local audio diagnostics cleanly.",
      ext
    );
    expect(clean.ok).toBe(true);
    expect(clean.reasons).toHaveLength(0);
  });

  test("rejects personal mfa user tokens and scrubs secret values", () => {
    expect(() => assertSafeBotToken("mfa.abcdefghijklmnopqrstuvwxyz0123456789")).toThrow();
    expect(assertSafeBotToken("MTExMTEx.AAAAAA.BBBBBBBBBBBBBBBBBBBBBBBB")).toMatch(/^Bot /);
    expect(redactSecrets("Authorization: Bot secretTokenValue1234567890")).toContain("[redacted]");
  });

  test("rejects AI slop phrases and strips slop plus dash punctuation cleanly", () => {
    const sloppy = "Let's dive in to this game changer setup without guesswork \u2014 supercharge your workflow.";
    const gate = checkVoiceGate(sloppy, []);
    expect(gate.ok).toBe(false);
    expect(gate.reasons).toContain("ai_slop_phrase_detected");
    expect(gate.reasons).toContain("forbidden_dash_punctuation");

    const cleaned = stripContentSlop(sloppy);
    expect(cleaned.removed).toContain("lets_dive_in");
    expect(cleaned.removed).toContain("game_changer");
    expect(cleaned.removed).toContain("without_guesswork");
    expect(cleaned.removed).toContain("forbidden_dash_punctuation");
    expect(cleaned.cleanText).not.toContain("\u2014");
    expect(checkVoiceGate(cleaned.cleanText, []).ok).toBe(true);
  });

  test("translates text via google_gtx and google_cloud_v2 while protecting code, channels, and URLs", async () => {
    const gtxCalls: string[] = [];
    const mockGtxFetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      gtxCalls.push(url);
      const parsed = new URL(url);
      const masked = parsed.searchParams.get("q") || "";
      const simulated = masked.replace("Fix audio timeout using", "Sua loi audio bang \u2014");
      return new Response(JSON.stringify([[[simulated, masked]], null, "en"]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const gtxResult = await translateText(
      "Fix audio timeout using `bun run search` in #video-tips via https://cdn.discordapp.com/attachments/1/2/log.txt",
      { to: "vi", from: "en", fetchFn: mockGtxFetch }
    );
    expect(gtxCalls).toHaveLength(1);
    expect(gtxResult.provider).toBe("google_gtx");
    expect(gtxResult.protectedTokens).toBe(3);
    expect(gtxResult.translatedText).toContain("`bun run search`");
    expect(gtxResult.translatedText).toContain("#video-tips");
    expect(gtxResult.translatedText).toContain("https://cdn.discordapp.com/attachments/1/2/log.txt");
    expect(gtxResult.translatedText).not.toContain("\u2014");

    let sawV2Post = false;
    const mockV2Fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      sawV2Post = init?.method === "POST";
      const parsed = JSON.parse(String(init?.body || "{}")) as { q: string };
      return new Response(
        JSON.stringify({
          data: {
            translations: [
              {
                translatedText: parsed.q.replace("Run", "Chay"),
                detectedSourceLanguage: "en",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    const v2Result = await translateText("Run `bun test` today", {
      to: "vi",
      apiKey: "test-cloud-key",
      fetchFn: mockV2Fetch,
    });
    expect(sawV2Post).toBe(true);
    expect(v2Result.provider).toBe("google_cloud_v2");
    expect(v2Result.translatedText).toBe("Chay `bun test` today");
  });

  test("executes two hop pivot back-translation and translates ContentBrief cleanly", async () => {
    const hops: string[] = [];
    const mockPivotFetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url);
      const sl = parsed.searchParams.get("sl") || "";
      const tl = parsed.searchParams.get("tl") || "";
      const q = parsed.searchParams.get("q") || "";
      hops.push(`${sl}->${tl}`);
      const out = tl === "vi" ? `[vi] ${q}` : q.replace(/^\[vi\]\s*/, "Localized: ");
      return new Response(JSON.stringify([[[out, q]], null, sl || "en"]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const pivoted = await translateText("Let's dive in and debug `sqlite` queries", {
      from: "en",
      to: "en",
      pivot: "vi",
      fetchFn: mockPivotFetch,
    });
    expect(hops).toEqual(["en->vi", "vi->en"]);
    expect(pivoted.pivotLang).toBe("vi");
    expect(pivoted.translatedText).toContain("`sqlite`");
    expect(pivoted.slopRemoved).toContain("lets_dive_in");

    const baseBrief = buildContentBrief([], "Video CLI", "#video-tips");
    const localized = await translateContentBrief(baseBrief, {
      from: "en",
      to: "en",
      pivot: "vi",
      fetchFn: mockPivotFetch,
    });
    expect(localized.translation?.targetLang).toBe("en");
    expect(localized.translation?.pivotLang).toBe("vi");
    expect(localized.headline).toContain("Localized:");
    expect(localized.outlinePoints[0]).toMatch(/^1\. Localized:/);
    expect(localized.voiceGate.ok).toBe(true);
  });

  test("runDailyDigest ingests inbox files, traces new to rising deltas, translates, and passes voiceGate", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-radar-digest-"));
    try {
      const dbPath = path.join(tmpDir, "radar.db");
      const inboxDir = path.join(tmpDir, "inbox");
      const outDir = path.join(tmpDir, "digests");
      const demandsFile = path.join(tmpDir, "demands.json");
      const missingWiretap = path.join(tmpDir, "missing-wiretap.toml");
      fs.mkdirSync(inboxDir, { recursive: true });
      fs.writeFileSync(
        demandsFile,
        JSON.stringify([
          {
            id: "video-ops",
            label: "Video Pipeline",
            keywords: ["remotion", "timeout"],
            ownedTargetChannel: "#video-tips",
            captureSources: [
              {
                tier: "browser_snapshot",
                guildId: "g-ext-1",
                channelId: "c-ext-1",
                channelName: "remotion-help",
              },
            ],
          },
        ])
      );

      const t1 = new Date(Date.now() - 20 * 60_000).toISOString();
      fs.writeFileSync(
        path.join(inboxDir, "g-ext-1__c-ext-1__remotion-help.json"),
        JSON.stringify([
          {
            messageId: "m-day1",
            authorId: "u-1",
            authorName: "builder1",
            content: "Why does remotion timeout during ffmpeg audio merge?",
            createdAt: t1,
          },
        ])
      );

      const mockFetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const parsed = new URL(url);
        const q = parsed.searchParams.get("q") || "";
        return new Response(JSON.stringify([[[`[vi] ${q}`, q]], null, "en"]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const day1 = await runDailyDigest({
        dbPath,
        outDir,
        inboxDir,
        demandsFile,
        wiretapConfigPath: missingWiretap,
        dateOverride: "2026-11-14",
        timeZone: "Asia/Ho_Chi_Minh",
        lang: "vi",
        fetchFn: mockFetch,
      });

      expect(day1.ingest.processedFiles).toEqual(["g-ext-1__c-ext-1__remotion-help.json"]);
      expect(day1.ingest.inserted).toBe(1);
      expect(day1.ingest.wiretapStatus).toBe("skipped_not_configured");
      expect(fs.existsSync(path.join(inboxDir, "g-ext-1__c-ext-1__remotion-help.json"))).toBe(false);
      expect(fs.readdirSync(path.join(inboxDir, "processed"))).toHaveLength(1);
      expect(day1.previousDigestDate).toBeNull();
      expect(day1.sections[0]?.tracedSignals[0]?.trend).toBe("new");
      expect(day1.sections[0]?.tracedSignals[0]?.deltaCount).toBe(1);
      expect(day1.sections[0]?.brief.translation?.targetLang).toBe("vi");

      const t2 = new Date(Date.now() - 5 * 60_000).toISOString();
      fs.writeFileSync(
        path.join(inboxDir, "remotion-help.json"),
        JSON.stringify([
          {
            messageId: "m-day2",
            authorId: "u-2",
            authorName: "builder2",
            content: "How to prevent remotion timeout error on batch captions?",
            createdAt: t2,
          },
        ])
      );

      const day2 = await runDailyDigest({
        dbPath,
        outDir,
        inboxDir,
        demandsFile,
        wiretapConfigPath: missingWiretap,
        dateOverride: "2026-11-15",
        timeZone: "Asia/Ho_Chi_Minh",
      });

      expect(day2.previousDigestDate).toBe("2026-11-14");
      expect(day2.ingest.inserted).toBe(1);
      expect(day2.sections[0]?.tracedSignals[0]?.trend).toBe("rising");
      expect(day2.sections[0]?.tracedSignals[0]?.deltaCount).toBe(1);

      const mdBody = fs.readFileSync(day2.markdownPath, "utf8");
      const snippets = day2.sections[0]?.tracedSignals.flatMap((s) => s.sampleSnippets) ?? [];
      expect(checkVoiceGate(mdBody, snippets).ok).toBe(true);
      expect(mdBody).toContain("`rising`");
      expect(mdBody).toContain("`+1`");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("enforces 08:00 to 18:00 randomized daily window, single run per day, and next day rollover", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-radar-sched-"));
    try {
      const draws = new Set<number>();
      for (let i = 0; i < 100; i += 1) {
        const minute = pickDailyTargetMinute(8 * 60, 18 * 60);
        expect(minute).toBeGreaterThanOrEqual(8 * 60);
        expect(minute).toBeLessThanOrEqual(17 * 60 + 50);
        draws.add(minute);
      }
      expect(draws.size).toBeGreaterThan(1);

      const statePath = path.join(tmpDir, "schedule-state.json");
      const dbPath = path.join(tmpDir, "radar.db");
      const inboxDir = path.join(tmpDir, "inbox");
      const outDir = path.join(tmpDir, "digests");
      const demandsFile = path.join(tmpDir, "demands.json");
      const missingWiretap = path.join(tmpDir, "missing-wiretap.toml");
      fs.writeFileSync(demandsFile, "[]");

      const baseOpts = {
        windowStart: "08:00",
        windowEnd: "18:00",
        timeZone: "Asia/Ho_Chi_Minh",
        statePath,
        rng: () => 9 * 60 + 10,
        digestOpts: {
          dbPath,
          outDir,
          inboxDir,
          demandsFile,
          wiretapConfigPath: missingWiretap,
        },
      };

      const earlyTick = await runScheduleTick({
        ...baseOpts,
        now: new Date("2026-11-15T07:55:00+07:00"),
      });
      expect(earlyTick.action).toBe("outside_window");

      const lateTick = await runScheduleTick({
        ...baseOpts,
        now: new Date("2026-11-15T18:05:00+07:00"),
      });
      expect(lateTick.action).toBe("outside_window");

      const waitingTick = await runScheduleTick({
        ...baseOpts,
        now: new Date("2026-11-15T08:15:00+07:00"),
      });
      expect(waitingTick.action).toBe("waiting_for_slot");
      expect(waitingTick.state.targetTime).toBe("09:10");

      const execTick = await runScheduleTick({
        ...baseOpts,
        now: new Date("2026-11-15T09:10:00+07:00"),
      });
      expect(execTick.action).toBe("executed");
      expect(execTick.state.completedAt).toBeTruthy();
      expect(fs.existsSync(execTick.digest!.markdownPath)).toBe(true);

      const repeatTick = await runScheduleTick({
        ...baseOpts,
        now: new Date("2026-11-15T09:15:00+07:00"),
      });
      expect(repeatTick.action).toBe("already_completed_today");

      const nextDayState = ensureDailyScheduleState({
        windowStart: "08:00",
        windowEnd: "18:00",
        timeZone: "Asia/Ho_Chi_Minh",
        statePath,
        now: new Date("2026-11-16T08:30:00+07:00"),
        rng: () => 14 * 60 + 25,
      });
      expect(nextDayState.date).toBe("2026-11-16");
      expect(nextDayState.targetTime).toBe("14:25");
      expect(nextDayState.completedAt).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
