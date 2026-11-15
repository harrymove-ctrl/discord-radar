# Discord Radar: Repository Contributor Rules

Read [`README.md`](./README.md) and [`docs/requirements/README.md`](./docs/requirements/README.md) before editing source files, scripts, or documentation.

## 1. Safety & Capture Invariants

1. **Zero User Token Extraction**: Never extract, persist, or automate Discord `localStorage` or desktop LevelDB user session tokens. Crawl owned channels via official scoped `Bot ` API tokens and external channels strictly via zero network `discrawl wiretap` caches or read only logged in browser snapshots (`OpenCLI` or Chrome DevTools MCP).
2. **Strict `@me` DM Quarantine**: Always tag and skip `@me`, `dm`, and `direct_message` rows before inserting into SQLite or running signal queries.
3. **Attachment SSRF Boundary**: Allow external attachment URLs only over `https://` port `443` matching `cdn.discordapp.com`, `media.discordapp.net`, or `images-ext-<digits>.discordapp.net` without credentials or IP literals.
4. **External Anonymization, Translation & VoiceGate**: Automatically replace external member names and `@mentions` with deterministic labels (`Participant_N`) during `desktop_wiretap` and `browser_snapshot` ingestion, strip AI slop during translation in [`src/translate.ts`](./src/translate.ts), and validate drafts with `checkVoiceGate` before publishing to owned channels.
5. **Secret Hygiene**: Keep `.env`, `.state/`, `.cache/`, `vault/`, `captures/`, `configs/*.local.json`, `configs/*.local.toml`, and `*.db` files gitignored. Never commit guild IDs, tokens, or captured chat exports.

## 2. Writing & Git Hygiene Gate

1. Write 100% plain English across all documentation, PRDs, epics, commit messages, and code comments. Never use em dashes, en dashes, spaced hyphens, horizontal rules, or unordered dash bullets.
2. Keep documentation free of AI filler and run `bun test && bunx tsc --noEmit` before pushing.
3. Verify your local Git author identity and active `gh auth status` login match the target repository owner before pushing commits or syncing GitHub issues, with zero AI attribution trailers.
