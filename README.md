# Discord Radar

**Archive Discord channels into a local SQLite FTS5 vault, cluster recurring topics, strip AI filler, and translate drafts across languages cleanly.**

Discord Radar works for both servers you administer (via scoped official Bot tokens) and community servers you follow as a normal member (via zero network desktop cache extraction or read only browser snapshots). Every private `@me` direct message stays quarantined out of storage, external member handles are anonymized to `Participant_N`, and every draft passes through an anti slop and Google Translate pipeline before leaving your machine.

```mermaid
flowchart LR
  BOT["Owned Server (Official Bot API)"] --> VAULT
  CACHE["External Server (Desktop Cache Wiretap)"] --> ANON
  DOM["External Server (OpenCLI / Chrome Snapshot)"] --> ANON
  ANON["PII & @me DM Filter (Participant_N)"] --> VAULT[("Local SQLite WAL + FTS5")]
  VAULT --> SIGNALS["Topic Signal Ranker"]
  SIGNALS --> BRIEF["Draft Brief Builder"]
  BRIEF --> XLAT["Google Translate + De-Slop Layer"]
  XLAT --> GATE["voiceGate Quality Check"]
```

## 1. Safe Capture Modes

| Capture Mode | Server Role Needed | Network Activity | Default Privacy Safeguards |
| :--- | :--- | :--- | :--- |
| **Bot API (`bot_api`)** | `Manage Server` | Standard official Discord `Bot ` REST API | Rejects user `mfa.` selfbot tokens; limits attachment URLs to `https://` port `443` Discord CDN hosts. |
| **Desktop Wiretap (`desktop_wiretap`)** | Member only | **Zero** (reads local Discord Desktop cache via [`scripts/crawl-wiretap.sh`](./scripts/crawl-wiretap.sh)) | Drops `@me`, `dm`, and `direct_message` entries before insert; replaces handles and IDs with `Participant_N`. |
| **Browser Snapshot (`browser_snapshot`)** | Member only | Normal interactive Chrome tab viewing | Parses accessibility JSON, message arrays, or timestamps in [`src/snapshot.ts`](./src/snapshot.ts) without touching cookies or `localStorage`. |

## 2. Quick Start (`Bun >= 1.3`)

1. Install dependencies and copy the starter configuration files:

```zsh
bun install
cp .env.example .env
cp configs/demands.example.json configs/demands.local.json
cp configs/discrawl-external-wiretap.example.toml configs/discrawl-external-wiretap.local.toml
chmod 600 .env configs/demands.local.json configs/discrawl-external-wiretap.local.toml
bun run doctor --json
```

2. Edit `configs/demands.local.json` with your topic keywords, source guild or channel IDs, and target channels inside your own server. Every `*.local.*` file stays untracked in [`.gitignore`](./.gitignore).

3. Import only newly cached external discussions passively from your local Discord Desktop cache (`Tier 2`, tracked via `crawl_cursors` in `.state/radar.db`):

```zsh
bash scripts/crawl-wiretap.sh configs/discrawl-external-wiretap.local.toml
```

4. Or import a browser tab snapshot captured via `OpenCLI` (`opencli browser state --source ax`) or Chrome DevTools MCP (`take_snapshot`):

```zsh
bun run ingest:snapshot \
  --file .state/channel-snapshot.json \
  --guild TARGET_EXTERNAL_GUILD_ID \
  --channel TARGET_EXTERNAL_CHANNEL_ID \
  --channel-name remotion-help \
  --json
```

5. Query archived discussions in milliseconds, cluster recurring topics, and build a verified draft brief:

```zsh
bun run today --hours 24 --json
bun run search "audio timeout" --json
bun run signals --demand ai-video-and-remotion --json
bun run brief --demand ai-video-and-remotion --target-channel "#video-tips" --json
```

## 3. Google Translate & Anti Slop Content Layer

Community discussions often contain mixed phrasing, and AI drafts frequently introduce cliché openers, em dashes, or broken spacing. Discord Radar pairs `checkVoiceGate` + `stripContentSlop` in [`src/security.ts`](./src/security.ts) with a token safe Google Translate wrapper in [`src/translate.ts`](./src/translate.ts):

1. **Protected Technical Tokens**: Before sending text to Google Translate, fenced code blocks, inline backticks (`` `bun run search` ``), `https://` URLs, and `#channel` tags are swapped with positional markers and restored verbatim after translation.
2. **Direct Content Brief Translation**: Pass `--lang <code>` (or set `RADAR_TARGET_LANG` in `.env`) on `brief` to translate the headline, numbered outline, and draft starter into your target audience's language and run `checkVoiceGate` automatically:

```zsh
bun run brief \
  --demand ai-video-and-remotion \
  --target-channel "#video-tips" \
  --lang vi \
  --json
```

3. **Standalone Text Translation & Pivot De-Slopping**: Run `bun run translate` directly on drafts or notes. Passing `--pivot <intermediate_lang>` (for example `--from en --to en --pivot vi`) runs a two hop round trip through Google Translate followed by `stripContentSlop` so stiff phrasing flattens out while technical tokens stay intact:

```zsh
bun run translate --text "Step by step fix for \`bun run search\` timeout in #video-tips" --to vi --json
bun run translate --text "Your draft text here" --from en --to en --pivot vi --json
```

4. **Cloud API Key Optional**: Unset `GOOGLE_TRANSLATE_API_KEY` uses the keyless `translate.googleapis.com` `gtx` endpoint by default; setting `GOOGLE_TRANSLATE_API_KEY` in `.env` upgrades requests cleanly to Google Cloud Translation v2.

## 4. Incremental Content Tracing & Every 2 Days Window Automation

Discord Radar tracks new community discussions every 2 days inside a randomized daytime window without re-scanning already indexed rows:

1. **Snapshot Drop Folder (`.state/inbox/`)**: Drop `.json`, `.jsonl`, or `.txt` browser snapshots into `.state/inbox/` (optionally named `<guildId>__<channelId>__<channelName>.json` or matching a configured `channelName`). Every `digest` run ingests queued files, runs `ingestWiretapIncremental` using persisted `crawl_cursors` (`last_rowid` and `last_updated_at`) so previously crawled messages are skipped, and archives processed files under `.state/inbox/processed/`.
2. **Incremental Digest Tracing (`digest --only-new`)**: `bun run digest --only-new --with-upstream` restricts signal extraction, content briefs, and upstream GitHub reporting strictly to newly crawled messages and new or updated upstream items since the previous crawl, tagging topics as `new`, `rising`, `steady`, or `cooling` against `.state/digests/`.

```zsh
bun run digest --only-new --with-upstream --lang vi --json
```

3. **Every 2 Days Randomized Execution Window (`schedule`)**: Instead of hitting the same clock minute or running daily, `src/schedule.ts` enforces `--interval-days 2` (configurable via `RADAR_INTERVAL_DAYS`) and picks one random minute on each eligible day between `--window-start` (`08:00`) and `--window-end` (`18:00`) in your local timezone. Polling every 5 minutes via cron checks `.state/schedule-state.json`, returns `cooldown_interval` at zero LLM cost on off days, executes `digest --only-new` once when the random slot arrives, updates `nextEligibleDate`, and appends `.state/schedule-history.jsonl`:

```zsh
bun run schedule --preview-days 5 --interval-days 2 --window-start 08:00 --window-end 18:00 --json
bun run schedule --install-cron --interval-days 2 --window-start 08:00 --window-end 18:00 --tz Asia/Ho_Chi_Minh --json
```

4. **Channel URL Wiring (`source:add`) & Demo Insights Pack (`demo:pack`)**: Paste full Discord channel URLs (from servers you follow as a member) directly without editing IDs by hand. Discord Radar saves the parsed IDs into gitignored `configs/demands.local.json`, updates your local wiretap TOML, reads Forum threads automatically, scrubs all Discord Snowflake IDs (`[id]`), and verifies `checkVoiceGate` before writing `.state/demo-packs/<demand>.{md,json}`:

```zsh
bun run source:add \
  --demand demo-insights \
  --label "Demo Community Insights" \
  --url "https://discord.com/channels/100000000000000001/200000000000000002" \
  --keywords "mcp,agent,bug,workflow" \
  --json

bun run digest --hours 720 --with-upstream --json
bun run demo:pack --demand demo-insights --json
```

5. **Upstream CLI Radar (`upstream:radar`)**: Track Discord adapter issues, pull requests, and `main` commits in `jackwener/OpenCLI` and `jackwener/discord-cli`, map edge cases (such as `OpenCLI` embed-only bot cards, quoted reply previews, and date-divider authors handled in [`src/snapshot.ts`](./src/snapshot.ts)) into `.state/upstream/latest.{md,json}`, and filter out any token extraction or anti-bot suggestions under `PRD-01 R1`:

```zsh
bun run upstream:radar --json
```

## 5. CLI Command Reference (`schema_version: "1"`)

All commands support `--json` and emit `{ ok, schema_version, data | error }` automatically when stdout is non TTY:

| Command | Purpose | Key Flags |
| :--- | :--- | :--- |
| `doctor` | Verify DB path, `DISCORD_BOT_TOKEN` Bot prefix format, `discrawl` binary, and active demand config | `--db`, `--demands-file`, `--json` |
| `targets` | Display active topic profiles loaded from `configs/demands.local.json` or `configs/demands.example.json` | `--demands-file`, `--json` |
| `add-source` | Register full Discord channel URLs into gitignored local demand and wiretap configs | `--url`, `--demand`, `--label`, `--keywords`, `--target-channel` |
| `ingest-wiretap` | Run `discrawl wiretap` and ingest only uncrawled SQLite rows beyond `crawl_cursors` | `--wiretap-config`, `--full-cache`, `--demands-file`, `--db` |
| `ingest-snapshot` | Parse browser JSON (including `OpenCLI` `discord-app` embed/reply cards), accessibility trees, or timestamped logs into SQLite | `--file`, `--url`, `--guild`, `--channel`, `--channel-name`, `--db` |
| `ingest-jsonl` | Import JSONL message streams from `discrawl` SQL queries or Bot exporters | `--file`, `--tier`, `--guild`, `--channel`, `--db` |
| `today` | List archived messages from the last `N` hours excluding quarantined `@me` DMs | `--hours`, `--url`, `--guild`, `--channel`, `--limit`, `--db` |
| `search` | Run BM25 ranked SQLite FTS5 full text search across stored discussions | `<query>`, `--url`, `--guild`, `--channel`, `--limit`, `--db` |
| `signals` | Cluster questions, recurring bugs, feature requests, and comparisons with direct thread deep links | `--demand`, `--url`, `--keywords`, `--hours`, `--demands-file` |
| `brief` | Generate a headline, outline, and `voiceGate` checked draft starter with optional `--lang` / `--pivot` translation | `--demand`, `--url`, `--target-channel`, `--lang`, `--pivot`, `--from` |
| `demo-pack` | Export Snowflake scrubbed, anonymized, `voiceGate` checked insights Markdown and JSON for demos | `--demand`, `--url`, `--hours`, `--only-new`, `--out-dir`, `--lang`, `--pivot` |
| `digest` | Ingest `.state/inbox/` + incremental wiretap, trace topic deltas with thread links, and write `.state/digests/YYYY-MM-DD.{md,json}` | `--hours`, `--only-new`, `--with-upstream`, `--inbox-dir`, `--out-dir`, `--lang`, `--pivot` |
| `upstream-radar` | Track `jackwener/OpenCLI` and `jackwener/discord-cli` issues, PRs, and `main` commits into `.state/upstream/latest.{md,json}` | `--repos`, `--limit`, `--only-new`, `--out-dir`, `--state-file`, `--json` |
| `schedule` | Enforce `--interval-days 2` cadence, pick one random run minute inside `08:00` to `18:00`, inspect slots, run ticks, or install crontab | `--install-cron`, `--interval-days`, `--preview-days`, `--tick`, `--with-upstream`, `--window-start`, `--window-end`, `--tz` |
| `translate` | Translate or back translate drafts with protected code/links/channels plus `stripContentSlop` and `checkVoiceGate` | `--text`, `--file`, `--to`, `--from`, `--pivot` |
| `voice-check` | Validate drafts against AI filler phrases, zero width Unicode, HTML tags, dash slop, and verbatim overlap | `--draft`, `--file` |

## 6. Development, PRDs & Privacy Hygiene

1. **Automated Tests & Typecheck**:

```zsh
bun test
bunx tsc --noEmit
```

2. **Local Storage Isolation**: `.env`, `.state/`, `configs/*.local.json`, `configs/*.local.toml`, and `*.db` files are gitignored; local directories are created at `0700` and SQLite databases at `0600`.
3. **Architecture PRDs & Backlog**: Read [`docs/requirements/README.md`](./docs/requirements/README.md) and [`docs/epics/EPICS_AND_ROADMAP.md`](./docs/epics/EPICS_AND_ROADMAP.md).
4. **Sync Backlog to Your GitHub Repository**: Preview planned labels, milestones, and issues via `node scripts/sync-github-epics.mjs --dry-run` before pushing updates to your own repository.
