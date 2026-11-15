import type { VoiceGateResult } from "./types.ts";

const ALLOWED_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const EXT_IMAGE_CDN_HOST_RE = /^images-ext-\d+\.discordapp\.net$/;
const IPV4_LITERAL_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const DISCORD_USER_TOKEN_RE = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}\b/g;
const DISCORD_MFA_TOKEN_RE = /\bmfa\.[A-Za-z0-9_-]{20,}\b/g;

const AI_SLOP_PATTERNS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: "lets_dive_in", regex: /\blet(?:'s|s)? dive in(?:to)?\b/gi },
  { label: "delve_into", regex: /\bdelve into\b/gi },
  { label: "fast_paced_world", regex: /\bin today(?:'s|s)? fast[- ]paced\b/gi },
  { label: "game_changer", regex: /\bgame[- ]changer\b/gi },
  { label: "without_guesswork", regex: /\bwithout guesswork\b/gi },
  { label: "unlock_the_power", regex: /\bunlock the power(?: of)?\b/gi },
  { label: "important_to_note", regex: /\bit(?:'s| is) important to note(?: that)?\b/gi },
  { label: "a_testament_to", regex: /\ba testament to\b/gi },
  { label: "seamlessly_integrate", regex: /\bseamless(?:ly)? integrat(?:e|es|ed|ing|ion)\b/gi },
  { label: "ever_evolving_landscape", regex: /\bever[- ]evolving landscape\b/gi },
  { label: "supercharge_your", regex: /\bsupercharge your\b/gi },
  { label: "at_the_end_of_the_day", regex: /\bat the end of the day\b/gi },
];

/** Detect canned AI cliché phrases inside outbound content or documentation. */
export function detectAiSlopPhrases(input: string): string[] {
  const matched: string[] = [];
  for (const rule of AI_SLOP_PATTERNS) {
    rule.regex.lastIndex = 0;
    if (rule.regex.test(input)) {
      matched.push(rule.label);
    }
  }
  return matched;
}

/** Remove AI slop phrases, dash punctuation, and zero width Unicode artifacts line by line. */
export function stripContentSlop(input: string): { cleanText: string; removed: string[] } {
  const removed: string[] = [];
  let working = input.replace(/[\u200B-\u200D\uFEFF]/g, () => {
    if (!removed.includes("zero_width_artifact")) removed.push("zero_width_artifact");
    return "";
  });

  working = working.replace(/[\u2013\u2014]/g, () => {
    if (!removed.includes("forbidden_dash_punctuation")) removed.push("forbidden_dash_punctuation");
    return ", ";
  });

  working = working.replace(/ - /g, () => {
    if (!removed.includes("spaced_hyphen_slop")) removed.push("spaced_hyphen_slop");
    return ": ";
  });

  for (const rule of AI_SLOP_PATTERNS) {
    rule.regex.lastIndex = 0;
    working = working.replace(rule.regex, () => {
      if (!removed.includes(rule.label)) removed.push(rule.label);
      return "";
    });
  }

  const cleanText = working
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^[,;:\s]+/, "")
        .replace(/\s+([,.;:!?])/g, "$1")
        .replace(/[ \t]{2,}/g, " ")
        .trimEnd()
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { cleanText, removed };
}

/** Scrub authorization headers, Discord tokens, and secret query values from text. */
export function redactSecrets(input: string): string {
  return input
    .replace(/\b(Bot|Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(DISCORD_MFA_TOKEN_RE, "[redacted-mfa-token]")
    .replace(DISCORD_USER_TOKEN_RE, "[redacted-token]")
    .replace(/([?&](?:token|secret|key|auth|signature|password)=)[^&\s]+/gi, "$1[redacted]");
}

/** Validate official Discord Bot tokens and reject personal mfa user tokens. */
export function assertSafeBotToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const withoutPrefix = trimmed.replace(/^Bot\s+/i, "");
  if (!withoutPrefix || /\s/.test(withoutPrefix)) {
    throw new Error("Invalid Discord Bot token format: token must not contain whitespace.");
  }
  if (/^mfa\./i.test(withoutPrefix) || /^Bearer\s+/i.test(trimmed)) {
    throw new Error("Rejected non Bot user session token: configure an official Discord Bot token only.");
  }
  if (withoutPrefix.length < 24 || !withoutPrefix.includes(".")) {
    throw new Error("Invalid Discord Bot token structure.");
  }
  return `Bot ${withoutPrefix}`;
}

/** Identify personal DM rows that must stay quarantined from external radar storage. */
export function isQuarantinedDm(guildId: string, channelName?: string): boolean {
  const g = guildId.trim().toLowerCase();
  const c = (channelName ?? "").trim().toLowerCase();
  if (!g || g === "@me" || g === "dm" || g === "direct_message") {
    return true;
  }
  if (c === "@me" || c === "dm" || c === "direct_message") {
    return true;
  }
  return false;
}

/** Allow attachment fetches only over HTTPS port 443 to verified Discord CDN hosts. */
export function validateDiscordCdnUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") {
    return false;
  }
  if (parsed.port !== "" && parsed.port !== "443") {
    return false;
  }
  if (parsed.username || parsed.password) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (!host || host === "localhost" || IPV4_LITERAL_RE.test(host) || host.includes(":")) {
    return false;
  }
  return ALLOWED_CDN_HOSTS.has(host) || EXT_IMAGE_CDN_HOST_RE.test(host);
}

/** Replace external speaker identities, mentions, IDs, emails, and invite links. */
export function anonymizeExternalText(
  text: string,
  speakerMap: Map<string, string>,
  authorKey: string
): { speakerLabel: string; cleanText: string } {
  const normalizedAuthor = authorKey.trim() || "unknown_author";
  let speakerLabel = speakerMap.get(normalizedAuthor);
  if (!speakerLabel) {
    speakerLabel = `Participant_${speakerMap.size + 1}`;
    speakerMap.set(normalizedAuthor, speakerLabel);
  }

  const cleanText = redactSecrets(text)
    .replace(/<@!?\d+>/g, "@member")
    .replace(/<@&\d+>/g, "@role")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/(^|\s)@[A-Za-z0-9_.-]{2,32}\b/g, "$1@member")
    .replace(/https?:\/\/(?:discord\.gg|discord\.com\/invite)\/[A-Za-z0-9-]+/gi, "[invite-link]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[ip]")
    .replace(/\b\d{17,20}\b/g, "[id]");

  return { speakerLabel, cleanText };
}

function tokenizeWords(input: string): string[] {
  return input.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function longestContiguousOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let maxLen = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1]! + 1;
        if (curr[j]! > maxLen) {
          maxLen = curr[j]!;
        }
      }
    }
    prev = curr;
  }
  return maxLen;
}

/** Reject hidden Unicode artifacts, AI dash punctuation, HTML, and external text copying. */
export function checkVoiceGate(draft: string, externalMessages: string[]): VoiceGateResult {
  const reasons: string[] = [];

  if (/[\u200B-\u200D\uFEFF]/.test(draft)) {
    reasons.push("zero_width_artifact");
  }
  if (/[\u2013\u2014]/.test(draft)) {
    reasons.push("forbidden_dash_punctuation");
  }
  if (/ - /.test(draft)) {
    reasons.push("spaced_hyphen_slop");
  }
  if (/<\/?[a-zA-Z][^>]*>/.test(draft)) {
    reasons.push("html_markup_detected");
  }
  if (detectAiSlopPhrases(draft).length > 0) {
    reasons.push("ai_slop_phrase_detected");
  }

  const draftWords = tokenizeWords(draft);
  let maxConsecutiveOverlap = 0;
  for (const ext of externalMessages) {
    const extWords = tokenizeWords(ext);
    const overlap = longestContiguousOverlap(draftWords, extWords);
    if (overlap > maxConsecutiveOverlap) {
      maxConsecutiveOverlap = overlap;
    }
  }
  if (maxConsecutiveOverlap > 12) {
    reasons.push("plagiarism_overlap_exceeded");
  }

  return {
    ok: reasons.length === 0,
    reasons,
    maxConsecutiveOverlap,
  };
}
