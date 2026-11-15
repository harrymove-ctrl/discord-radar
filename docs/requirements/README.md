# Discord Radar: Product Requirements & 4 PRDs

1. **Status**: `active`
2. **Last Updated**: `2026-11-15`
3. **Target Audience**: Developers, technical writers, and community operators running Discord servers or following ecosystem channels
4. **Repository Scope**: Open reusable CLI, SQLite FTS5 signal vault, Google Translate + de-slop layer, and content workflow templates

## 1. Core Objective

Collect questions, bug reports, workflow friction, and comparison discussions across two sets of Discord communities on demand: channels inside servers you own or administer, and external community servers where you participate as a member without bot invite permissions. Convert external signal clusters into verified, anonymized, original posts written in your own voice (and optionally localized or cleaned through a Google Translate layer) for your own Discord channels without risking account bans or leaking private messages.

## 2. Non Negotiable Safety Rules

1. **R1 (Zero User Token Extraction)**: Never extract, save, or automate `localStorage.token`, Discord Desktop LevelDB tokens, or browser cookies.
2. **R2 (Strict `@me` DM Isolation)**: Quarantine and drop `@me`, `dm`, and `direct_message` entries during ingest and enforce `lower(guild_id) != '@me'` across every SQLite search and signal query.
3. **R3 (Attachment URL SSRF Boundary)**: Accept attachment links strictly over `https://` port `443` targeting `cdn.discordapp.com`, `media.discordapp.net`, or `images-ext-<digits>.discordapp.net` with no embedded credentials or IP literals.
4. **R4 (External Anonymization & Anti Plagiarism)**: Replace external usernames and `@mentions` with `Participant_N` before clustering and reject drafts matching more than `12` consecutive normalized words from external messages or containing AI filler, dash slop, or zero width artifacts.
5. **R5 (Local Config Hygiene)**: Keep `*.local.json`, `*.local.toml`, `.env`, `.state/`, and SQLite DB files gitignored with `0600` file permissions and `0700` directory permissions.

## 3. PRD Breakdown (`PRD-01` through `PRD-04`)

### `PRD-01`: Safe Owned & Non Owned Channel Capture

1. **Owned Channels (`bot_api`)**: Enforce official `Bot ` token validation (`assertSafeBotToken`), scope pulls to configured `ownedGuilds` and channel IDs, and index full metadata into SQLite.
2. **External Desktop Cache (`desktop_wiretap`)**: Run [`scripts/crawl-wiretap.sh`](../../scripts/crawl-wiretap.sh) with `DISCRAWL_NO_UPDATE_CHECK=1`, reading only local Discord Desktop caches on disk with zero Discord API calls and strict `@me` exclusion.
3. **External Browser Tab (`browser_snapshot`)**: Parse read only DOM/accessibility snapshots exported via `OpenCLI` (`opencli browser state --source ax`) or Chrome DevTools MCP (`take_snapshot`) in [`src/snapshot.ts`](../../src/snapshot.ts).

### `PRD-02`: Local `bun:sqlite` FTS5 Vault & Anonymizer

1. **Storage Schema**: Persist deduplicated records (`msg:<id>` or `sha:<hash>`) in SQLite WAL mode with synchronized `messages_fts` FTS5 virtual tables inside [`src/vault.ts`](../../src/vault.ts).
2. **Cross Tier Idempotency**: Switching between `desktop_wiretap`, `browser_snapshot`, and `bot_api` never duplicates identical messages when `messageId` is present or normalized fallback hashes match.
3. **PII Scrubbing**: Strip emails, 17 to 20 digit IDs, invite URLs, `@mentions`, Bearer/Bot credentials, and external usernames before persistence for all non owned tiers (`sourceTier !== "bot_api"`).

### `PRD-03`: Demand Driven Signal Engine, Google Translate Layer & VoiceGate Content Briefs

1. **Demand Profiles**: Load structured topic interests from untracked `configs/demands.local.json` (falling back to [`configs/demands.example.json`](../../configs/demands.example.json)), linking topic keywords to target channels in the operator's Discord server.
2. **Signal Classification & Weighting**: Group indexed messages across `recurring_bug`, `unanswered_question`, `feature_demand`, and `comparison_thread` in [`src/signals.ts`](../../src/signals.ts), boosting clusters matching active demand keywords.
3. **Google Translate & Anti Slop Layer**: Provide [`src/translate.ts`](../../src/translate.ts) supporting single target translation (`--lang` / `--to`) and two hop pivot back-translation (`--pivot`) across keyless `google_gtx` and `GOOGLE_TRANSLATE_API_KEY` Cloud v2 while masking fenced code, inline code, URLs, and `#channel` tags verbatim before running `stripContentSlop`.
4. **VoiceGate Draft Synthesis**: Generate original headlines, numbered outlines, and draft starters tailored for the configured owned channel and verify every draft passes [`checkVoiceGate`](../../src/security.ts).

### `PRD-04`: Scheduled Daily Digest, Local MCP Server & Approved Bot Publisher

1. **Local Stdio MCP Server**: Expose `search_radar`, `list_demands`, `get_top_signals`, `generate_brief`, `translate_text`, and `check_voice_gate` tools so Kiro, Claude Code, Cursor, and Codex can query signals interactively without shell boilerplate.
2. **Morning Demand Digest**: Schedule a read only daily cron compiling yesterday's highest weighted signals and staged preview briefs into `.state/digests/`.
3. **Explicitly Approved Bot Publishing**: Require `--live --approvedBy <operator>` (and valid `checkVoiceGate`) before calling the official Discord Bot REST endpoint to publish approved posts to owned channels, honoring `429` `Retry-After` and daily post quotas.
