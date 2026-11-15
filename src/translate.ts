import { checkVoiceGate, stripContentSlop } from "./security.ts";
import type { ContentBrief, TranslateOptions, TranslateResult, TranslationProvider } from "./types.ts";

const FENCED_CODE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const URL_RE = /https?:\/\/[^\s)>\]]+/g;
const CHANNEL_TAG_RE = /(^|[\s(])(#[a-z0-9_-]{2,64})\b/gi;
const PLACEHOLDER_RE = /\[\[\s*ZXQ_TOKEN_(\d+)\s*\]\]/gi;

function maskProtectedTokens(input: string): { maskedText: string; tokens: string[] } {
  const tokens: string[] = [];
  const stash = (value: string): string => {
    const id = tokens.length;
    tokens.push(value);
    return `[[ZXQ_TOKEN_${id}]]`;
  };

  let maskedText = input.replace(FENCED_CODE_RE, (m) => stash(m));
  maskedText = maskedText.replace(INLINE_CODE_RE, (m) => stash(m));
  maskedText = maskedText.replace(URL_RE, (m) => stash(m));
  maskedText = maskedText.replace(CHANNEL_TAG_RE, (_full, prefix: string, tag: string) => {
    return `${prefix}${stash(tag)}`;
  });

  return { maskedText, tokens };
}

function restoreProtectedTokens(input: string, tokens: string[]): string {
  return input.replace(PLACEHOLDER_RE, (_full, idxStr: string) => {
    const idx = Number.parseInt(idxStr, 10);
    return Number.isInteger(idx) && idx >= 0 && idx < tokens.length ? tokens[idx]! : _full;
  });
}

async function callSingleGoogleHop(
  maskedText: string,
  fromLang: string,
  toLang: string,
  opts: TranslateOptions
): Promise<{ text: string; detectedSourceLang: string; provider: TranslationProvider }> {
  const apiKey = opts.apiKey?.trim() || process.env.GOOGLE_TRANSLATE_API_KEY?.trim() || "";
  const fetcher = opts.fetchFn ?? fetch;

  if (apiKey) {
    const baseUrl =
      opts.endpointUrl?.trim() || "https://translation.googleapis.com/language/translate/v2";
    const separator = baseUrl.includes("?") ? "&" : "?";
    const endpoint = `${baseUrl}${separator}key=${encodeURIComponent(apiKey)}`;
    const bodyPayload: Record<string, string> = {
      q: maskedText,
      target: toLang,
      format: "text",
    };
    if (fromLang && fromLang !== "auto") {
      bodyPayload.source = fromLang;
    }

    const res = await fetcher(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bodyPayload),
    });
    if (!res.ok) {
      throw new Error(`Google Cloud Translate v2 request failed with HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
      data?: {
        translations?: Array<{ translatedText?: string; detectedSourceLanguage?: string }>;
      };
    };
    const first = json.data?.translations?.[0];
    if (!first?.translatedText) {
      throw new Error("Google Cloud Translate v2 response did not contain translatedText");
    }
    return {
      text: first.translatedText,
      detectedSourceLang: first.detectedSourceLanguage || fromLang || "auto",
      provider: "google_cloud_v2",
    };
  }

  const baseUrl =
    opts.endpointUrl?.trim() || "https://translate.googleapis.com/translate_a/single";
  const params = new URLSearchParams({
    client: "gtx",
    sl: fromLang || "auto",
    tl: toLang,
    dt: "t",
    q: maskedText,
  });
  const res = await fetcher(`${baseUrl}?${params.toString()}`, { method: "GET" });
  if (!res.ok) {
    throw new Error(`Google Translate gtx request failed with HTTP ${res.status}`);
  }
  const json = (await res.json()) as unknown[];
  const segments = Array.isArray(json[0]) ? json[0] : [];
  const translatedChunks: string[] = [];
  for (const segment of segments) {
    if (Array.isArray(segment) && typeof segment[0] === "string") {
      translatedChunks.push(segment[0]);
    }
  }
  const translated = translatedChunks.join("");
  if (!translated && maskedText.trim()) {
    throw new Error("Google Translate gtx returned an empty translation payload");
  }
  const detectedSourceLang = typeof json[2] === "string" && json[2] ? json[2] : fromLang || "auto";
  return {
    text: translated,
    detectedSourceLang,
    provider: "google_gtx",
  };
}

/**
 * Translate text through Google Translate (Cloud v2 or keyless gtx) while protecting
 * fenced code blocks, inline code, URLs, and #channel names, then removing AI slop.
 */
export async function translateText(
  text: string,
  opts: TranslateOptions
): Promise<TranslateResult> {
  const targetLang = opts.to.trim();
  if (!targetLang) {
    throw new Error("Translation target language (--to / --lang) is required.");
  }
  const fromLang = (opts.from ?? "auto").trim() || "auto";
  const pivotLang = opts.pivot?.trim() || "";
  const { maskedText, tokens } = maskProtectedTokens(text);

  let translatedMasked: string;
  let detectedSourceLang = fromLang;
  let provider: TranslationProvider = "google_gtx";

  if (pivotLang && pivotLang.toLowerCase() !== targetLang.toLowerCase()) {
    const hop1 = await callSingleGoogleHop(maskedText, fromLang, pivotLang, opts);
    detectedSourceLang = hop1.detectedSourceLang;
    const hop2 = await callSingleGoogleHop(hop1.text, pivotLang, targetLang, opts);
    translatedMasked = hop2.text;
    provider = hop2.provider;
  } else {
    const singleHop = await callSingleGoogleHop(maskedText, fromLang, targetLang, opts);
    translatedMasked = singleHop.text;
    detectedSourceLang = singleHop.detectedSourceLang;
    provider = singleHop.provider;
  }

  const restored = restoreProtectedTokens(translatedMasked, tokens);
  const deSlopEnabled = opts.deSlop !== false;
  const cleaned = deSlopEnabled ? stripContentSlop(restored) : { cleanText: restored.trim(), removed: [] };

  return {
    originalText: text,
    translatedText: cleaned.cleanText,
    sourceLang: detectedSourceLang,
    targetLang,
    ...(pivotLang ? { pivotLang } : {}),
    provider,
    protectedTokens: tokens.length,
    slopRemoved: cleaned.removed,
  };
}

/** Translate headline, numbered outline items, and draft starter inside a ContentBrief. */
export async function translateContentBrief(
  brief: ContentBrief,
  opts: TranslateOptions,
  externalSnippets: string[] = []
): Promise<ContentBrief> {
  const headlineRes = await translateText(brief.headline, opts);
  const translatedOutlines: string[] = [];

  for (let idx = 0; idx < brief.outlinePoints.length; idx += 1) {
    const item = brief.outlinePoints[idx]!;
    const strippedNumber = item.replace(/^\d+\.\s*/, "");
    const itemRes = await translateText(strippedNumber, opts);
    translatedOutlines.push(`${idx + 1}. ${itemRes.translatedText}`);
  }

  const draftRes = await translateText(brief.draftStarter, opts);
  const voiceGate = checkVoiceGate(draftRes.translatedText, externalSnippets);

  return {
    ...brief,
    headline: headlineRes.translatedText,
    outlinePoints: translatedOutlines,
    draftStarter: draftRes.translatedText,
    voiceGate,
    translation: {
      targetLang: headlineRes.targetLang,
      sourceLang: headlineRes.sourceLang,
      ...(opts.pivot ? { pivotLang: opts.pivot } : {}),
      provider: headlineRes.provider,
    },
  };
}
