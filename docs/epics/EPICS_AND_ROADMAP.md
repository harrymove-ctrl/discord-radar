# Discord Radar: Epics, Milestones & 16 Issue Roadmap

1. **Sync Target**: Resolved from `--repo <owner/name>` or `git remote get-url origin`
2. **Requirements Spec**: [`../requirements/README.md`](../requirements/README.md)
3. **Sync Script**: [`../../scripts/sync-github-epics.mjs`](../../scripts/sync-github-epics.mjs)

## 1. Milestones (`M1` through `M3`)

| Milestone | Due Date | Epics | Objective |
| :--- | :--- | :--- | :--- |
| **M1: Local Vault & Safe Crawlers** | `2026-11-22` | `EPIC-01`, `EPIC-02` | Hardened TypeScript/Bun SQLite WAL FTS5 vault, `@me` quarantine, CDN allowlist, `wiretap` wrapper, and `OpenCLI`/Chrome snapshot parser. |
| **M2: Demand Profiles, Translation & VoiceGate Briefs** | `2026-11-29` | `EPIC-03`, `EPIC-04` | Custom demand config profiles, weighted signal clustering, style indexer, Google Translate + `--pivot` layer (`src/translate.ts`), and strict anti slop / overlap `voiceGate`. |
| **M3: Daily Digest, MCP & Approved Bot Publisher** | `2026-12-06` | `EPIC-05` | Local `stdio` MCP server, daily delta trace digest + randomized `08:00` to `18:00` scheduler (`src/digest.ts`, `src/schedule.ts`), and explicitly approved official Bot publisher. |

## 2. Epic & Issue Backlog (5 Epics, 16 Issues)

### `EPIC-01`: Core Vault, Privacy Quarantine & Security Boundaries (`M1`)

| ID | Title | Entry Points & Acceptance Summary |
| :--- | :--- | :--- |
| **RAD-01** | Harden `bun:sqlite` WAL + FTS5 schema with `0600` file permissions | Initialize `messages` + `messages_fts` triggers inside [`src/vault.ts`](../../src/vault.ts), chmod parent `.state` to `0700` and DB to `0600`, verify `bm25` FTS5 search latency `< 15 ms`. |
| **RAD-02** | Enforce `@me` DM quarantine and credential secret redaction | Reject `@me` / `dm` / `direct_message` rows before ingest and filter them from all queries; strip `Bot`/`Bearer`/`mfa.` tokens in [`src/security.ts`](../../src/security.ts). |
| **RAD-03** | Enforce strict HTTPS port `443` Discord CDN attachment allowlist | Drop any non `https://` URL, custom port, credential URL, IP literal, or non Discord host before storing attachments. |

### `EPIC-02`: Tier 1, Tier 2 & Tier 3 Multi Source Ingestion (`M1`)

| ID | Title | Entry Points & Acceptance Summary |
| :--- | :--- | :--- |
| **RAD-04** | Add official `Bot ` REST collector for owned channels | Poll or sync configured channel IDs in servers you own via `DISCORD_BOT_TOKEN` with strict `Retry-After` handling and channel scope filters. |
| **RAD-05** | Harden passive `discrawl wiretap` local cache wrapper | Run `discrawl` with `DISCRAWL_NO_UPDATE_CHECK=1` and `source = "wiretap"`, piping filtered `guild_id != '@me'` JSONL rows into `ingest-jsonl`. |
| **RAD-06** | Support `OpenCLI` accessibility trees and Chrome DevTools snapshots | Parse Chrome accessibility JSON, message array exports, and timestamped chat text cleanly inside [`src/snapshot.ts`](../../src/snapshot.ts). |
| **RAD-07** | Guarantee cross tier deduplication and deterministic anonymization | Deduplicate by `messageId` or normalized SHA-256 across all 3 tiers and map external authors cleanly to `Participant_N`. |

### `EPIC-03`: Demand Profiles & Anonymized Signal Radar (`M2`)

| ID | Title | Entry Points & Acceptance Summary |
| :--- | :--- | :--- |
| **RAD-08** | Support local untracked `configs/demands.local.json` profiles | Load custom topic keywords, external capture sources, and target owned channels cleanly while keeping local IDs gitignored. |
| **RAD-09** | Improve signal clustering across bugs, questions, features, and comparisons | Tune scoring weights, timeframe decay, and multi channel trend detection inside [`src/signals.ts`](../../src/signals.ts). |
| **RAD-10** | Add structured `--json` analytics subcommands (`stats`, `top`, `export`) | Expand CLI reporting aligned to `schema_version: "1"` JSON envelopes inside [`src/cli.ts`](../../src/cli.ts). |

### `EPIC-04`: VoiceGate, Google Translate & Content Brief Synthesis (`M2`)

| ID | Title | Entry Points & Acceptance Summary |
| :--- | :--- | :--- |
| **RAD-11** | Build channel owner style indexer from owned channel history | Measure sentence cadence, greeting habits, and markdown formatting solely from `RADAR_OWNER_AUTHOR_ID` posts in owned channels. |
| **RAD-12** | Enforce AI slop stripping, dash punctuation, and `> 12` word overlap gates | Verify [`checkVoiceGate`](../../src/security.ts) and `stripContentSlop` block hidden Unicode, em/en dashes, spaced hyphens, AI buzzwords, HTML tags, and copied external sentences. |
| **RAD-13** | Generate multilingual briefs with Google Translate and `--pivot` | Support `translateText`, `translateContentBrief`, `bun run translate`, and `brief --lang` / `--pivot` in [`src/translate.ts`](../../src/translate.ts) while masking code spans, URLs, and `#channel` names before `stripContentSlop`. |

### `EPIC-05`: Daily Digest, MCP Server & Approved Bot Publisher (`M3`)

| ID | Title | Entry Points & Acceptance Summary |
| :--- | :--- | :--- |
| **RAD-14** | Implement `discord-radar-mcp` `stdio` server for AI coding agents | Expose `search_radar`, `get_top_signals`, `generate_brief`, `translate_brief`, and `check_voice_gate` over MCP `stdio` for Kiro, Claude Code, and Cursor. |
| **RAD-15** | Add daily content trace digest and randomized `08:00` to `18:00` scheduler | Auto ingest `.state/inbox/` + passive wiretap, trace `new`/`rising`/`steady`/`cooling` topic deltas into `.state/digests/YYYY-MM-DD.{md,json}`, and run once daily at a randomized window minute via [`src/digest.ts`](../../src/digest.ts) and [`src/schedule.ts`](../../src/schedule.ts). |
| **RAD-16** | Add dry run first official Bot publisher with explicit approval gate | Require `--live --approvedBy <operator>` plus passing `voiceGate` before sending any brief draft to an owned channel via Bot REST API. |
