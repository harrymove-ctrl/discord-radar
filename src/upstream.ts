import fs from "node:fs";
import path from "node:path";
import { stripContentSlop } from "./security.ts";
import type {
  UpstreamItem,
  UpstreamItemCategory,
  UpstreamRadarReport,
  UpstreamRadarState,
  UpstreamRepoSummary,
  UpstreamRepoTarget,
  UpstreamSafetyDisposition,
} from "./types.ts";

export interface UpstreamRadarOptions {
  targets?: UpstreamRepoTarget[];
  limit?: number;
  outDir?: string;
  statePath?: string;
  dateOverride?: string;
  onlyNew?: boolean;
  now?: Date;
  fetchFn?: typeof fetch;
}

export const DEFAULT_UPSTREAM_TARGETS: UpstreamRepoTarget[] = [
  { repo: "jackwener/OpenCLI", query: "discord", trackMainCommits: true },
  { repo: "jackwener/discord-cli", query: "", trackMainCommits: true },
];

const UNSAFE_CREDENTIAL_HARVEST_RE =
  /\b(extract|dump|steal|grab|read)\s+(?:user\s+)?(token|localstorage|leveldb|cookies)\b|\bself[- ]?bot\b|\banti[- ]?bot\s+bypass\b/i;

function ensurePrivateDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // Ignore chmod failures on restricted virtual filesystems
  }
}

function writePrivateFile(filePath: string, content: string): void {
  ensurePrivateDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort permission hardening
  }
}

function sanitizeTitle(raw: string): string {
  const withoutDashes = stripContentSlop(raw).cleanText.replace(/--+/g, " ");
  return withoutDashes.replace(/\s+/g, " ").trim().slice(0, 140);
}

function classifyUpstreamItem(title: string, body = ""): {
  category: UpstreamItemCategory;
  safetyDisposition: UpstreamSafetyDisposition;
  localMappingHint: string;
} {
  const combined = `${title} ${body}`;
  if (UNSAFE_CREDENTIAL_HARVEST_RE.test(combined)) {
    return {
      category: "cli_contract_and_ux",
      safetyDisposition: "blocked_by_r1_policy",
      localMappingHint: "Blocked by PRD-01 R1 (never extract user tokens or bypass anti-bot controls)",
    };
  }

  const lower = combined.toLowerCase();
  if (/\b(embed|reply|quoted|attachment|sticker|messagecontent)\b/.test(lower)) {
    return {
      category: "embed_and_reply_parsing",
      safetyDisposition: "safe_engineering",
      localMappingHint: "Harden src/snapshot.ts embed fallback and reply preview isolation",
    };
  }
  if (/\b(forum|thread|guild|channel|virtualis|mounted|scroll)\b/.test(lower)) {
    return {
      category: "forum_and_thread_sync",
      safetyDisposition: "safe_engineering",
      localMappingHint: "Verify wiretap threadId + Forum parent matching in src/digest.ts",
    };
  }
  if (/\b(empty|login|auth|error|timeout|typed|fail)\b/.test(lower)) {
    return {
      category: "typed_error_handling",
      safetyDisposition: "safe_engineering",
      localMappingHint: "Return clean typed CliEnvelope errors in src/cli.ts and src/snapshot.ts",
    };
  }
  if (/\b(selector|dom|cdp|anchor|navigation|draft\.js)\b/.test(lower)) {
    return {
      category: "selector_resilience",
      safetyDisposition: "safe_engineering",
      localMappingHint: "Update resilient accessibility/DOM extractors in src/snapshot.ts",
    };
  }
  return {
    category: "cli_contract_and_ux",
    safetyDisposition: "safe_engineering",
    localMappingHint: "Review workflow ergonomics against src/cli.ts and SKILL patterns",
  };
}

function buildGithubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "discord-radar-upstream-monitor/0.1",
  };
  const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function loadUpstreamState(statePath: string): UpstreamRadarState {
  if (!fs.existsSync(statePath)) {
    return { lastRunAt: "", seenItems: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<UpstreamRadarState>;
    return {
      lastRunAt: typeof parsed.lastRunAt === "string" ? parsed.lastRunAt : "",
      seenItems:
        parsed.seenItems && typeof parsed.seenItems === "object"
          ? (parsed.seenItems as Record<string, string>)
          : {},
    };
  } catch {
    return { lastRunAt: "", seenItems: {} };
  }
}

/** Render a concise dash-free Markdown report for tracked upstream CLI changes. */
export function renderUpstreamMarkdown(report: UpstreamRadarReport): string {
  const lines: string[] = [
    `# Upstream CLI Radar Report (\`${report.date}\`)`,
    "",
    `1. **Generated At**: \`${report.generatedAt}\``,
    `2. **Previous Run**: \`${report.previousRunAt ?? "none"}\``,
    `3. **Tracked Repositories**: \`${report.repos.map((r) => r.repo).join(", ")}\``,
    "",
    "## 1. Repository Status Summary",
    "",
    "| Repository | Status | Issues | PRs | Main Commits | New or Updated | Blocked by R1 |",
    "| :--- | :--- | :--- | :--- | :--- | :--- | :--- |",
  ];

  for (const repo of report.repos) {
    lines.push(
      `| \`${repo.repo}\` | \`${repo.status}\` | ${repo.issueCount} | ${repo.prCount} | ${repo.commitCount} | ${repo.newOrUpdatedCount} | ${repo.blockedByR1Count} |`
    );
  }
  lines.push("");

  lines.push("## 2. Tracked Discord Issues, Pull Requests & Main Commits", "");
  if (report.items.length === 0) {
    lines.push("1. No new or updated upstream items detected in this crawl.", "");
  } else {
    report.items.forEach((item, idx) => {
      const deltaBadge = item.isNewOrUpdated ? "[NEW/UPDATED]" : "[KNOWN]";
      const policyNote =
        item.safetyDisposition === "blocked_by_r1_policy" ? " [BLOCKED_BY_R1]" : "";
      lines.push(
        `${idx + 1}. ${deltaBadge}${policyNote} \`${item.repo}\` (${item.kind} \`${item.ref}\`, \`${item.state}\`): [${item.title}](${item.url}) (Category: \`${item.category}\`, Mapping: ${item.localMappingHint})`
      );
    });
    lines.push("");
  }

  lines.push("## 3. Actionable Optimization Checklist", "");
  if (report.actionableRecommendations.length === 0) {
    lines.push("1. No safe engineering optimizations pending from upstream changes.", "");
  } else {
    report.actionableRecommendations.forEach((rec, idx) => {
      lines.push(`${idx + 1}. ${rec}`);
    });
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Poll official public GitHub REST APIs for upstream CLI Discord issues, PRs, and main commits,
 * track delta changes locally, and filter out unsafe credential harvesting suggestions.
 */
export async function runUpstreamRadar(
  opts: UpstreamRadarOptions = {}
): Promise<UpstreamRadarReport> {
  const now = opts.now ?? new Date();
  const dateStr = opts.dateOverride?.trim() || now.toISOString().slice(0, 10);
  const limit = Math.max(1, Math.min(25, opts.limit ?? 8));
  const outDir = path.resolve(opts.outDir?.trim() || ".state/upstream");
  const statePath = path.resolve(opts.statePath?.trim() || ".state/upstream-radar-state.json");
  const targets = opts.targets && opts.targets.length > 0 ? opts.targets : DEFAULT_UPSTREAM_TARGETS;
  const fetchFn = opts.fetchFn ?? fetch;
  const headers = buildGithubHeaders();

  const prevState = loadUpstreamState(statePath);
  const nextSeen: Record<string, string> = { ...prevState.seenItems };
  const repos: UpstreamRepoSummary[] = [];
  const items: UpstreamItem[] = [];

  for (const target of targets) {
    const repoSummary: UpstreamRepoSummary = {
      repo: target.repo,
      status: "ok",
      issueCount: 0,
      prCount: 0,
      commitCount: 0,
      newOrUpdatedCount: 0,
      blockedByR1Count: 0,
    };

    try {
      const issueUrl = target.query?.trim()
        ? `https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${target.repo} ${target.query.trim()}`)}&sort=updated&order=desc&per_page=${limit}`
        : `https://api.github.com/repos/${target.repo}/issues?state=all&sort=updated&direction=desc&per_page=${limit}`;

      const issueRes = await fetchFn(issueUrl, {
        headers,
        signal: AbortSignal.timeout(8000),
      });

      if (!issueRes.ok) {
        repoSummary.status =
          issueRes.status === 403 || issueRes.status === 429 ? "rate_limited" : "error";
        repoSummary.httpStatus = issueRes.status;
        repoSummary.errorMessage = `GitHub HTTP ${issueRes.status} while reading issues`;
      } else {
        const json = (await issueRes.json()) as unknown;
        const rawList = Array.isArray(json)
          ? json
          : json && typeof json === "object" && Array.isArray((json as { items?: unknown }).items)
            ? ((json as { items: unknown[] }).items)
            : [];

        for (const raw of rawList) {
          if (!raw || typeof raw !== "object") continue;
          const row = raw as Record<string, unknown>;
          const num = row.number;
          const ref = typeof num === "number" ? `#${num}` : String(num ?? "");
          const isPr = Boolean(row.pull_request);
          const kind: UpstreamItem["kind"] = isPr ? "pull_request" : "issue";
          const title = sanitizeTitle(String(row.title ?? ""));
          const bodySnippet = typeof row.body === "string" ? row.body.slice(0, 300) : "";
          const state = String(row.state ?? "open");
          const htmlUrl = String(row.html_url ?? "");
          const updatedAt = String(row.updated_at ?? row.created_at ?? now.toISOString());
          if (!title || !htmlUrl) continue;

          const fingerprint = `${state}|${updatedAt}|${title}`;
          const stateKey = `${target.repo}::${kind}::${ref}`;
          const isNewOrUpdated = prevState.seenItems[stateKey] !== fingerprint;
          nextSeen[stateKey] = fingerprint;

          const classification = classifyUpstreamItem(title, bodySnippet);
          if (isPr) repoSummary.prCount += 1;
          else repoSummary.issueCount += 1;
          if (isNewOrUpdated) repoSummary.newOrUpdatedCount += 1;
          if (classification.safetyDisposition === "blocked_by_r1_policy") {
            repoSummary.blockedByR1Count += 1;
          }

          items.push({
            repo: target.repo,
            kind,
            ref,
            title,
            state,
            url: htmlUrl,
            updatedAt,
            isNewOrUpdated,
            ...classification,
          });
        }
      }

      if (target.trackMainCommits !== false && repoSummary.status === "ok") {
        const commitUrl = `https://api.github.com/repos/${target.repo}/commits?sha=main&per_page=${Math.min(limit, 8)}`;
        const commitRes = await fetchFn(commitUrl, {
          headers,
          signal: AbortSignal.timeout(8000),
        });
        if (commitRes.ok) {
          const commits = (await commitRes.json()) as unknown;
          if (Array.isArray(commits)) {
            const filterNeedle = target.query?.trim().toLowerCase() || "";
            for (const rawCommit of commits) {
              if (!rawCommit || typeof rawCommit !== "object") continue;
              const c = rawCommit as {
                sha?: string;
                html_url?: string;
                commit?: { message?: string; author?: { date?: string }; committer?: { date?: string } };
              };
              const fullMsg = String(c.commit?.message ?? "");
              const firstLine = fullMsg.split("\n")[0] ?? "";
              if (
                filterNeedle &&
                !fullMsg.toLowerCase().includes(filterNeedle) &&
                commits.length > 3 &&
                repoSummary.commitCount >= 3
              ) {
                continue;
              }
              const shaShort = String(c.sha ?? "").slice(0, 7);
              const title = sanitizeTitle(firstLine);
              const url = String(c.html_url ?? "");
              const updatedAt = String(
                c.commit?.committer?.date ?? c.commit?.author?.date ?? now.toISOString()
              );
              if (!shaShort || !title || !url) continue;

              const stateKey = `${target.repo}::commit::${shaShort}`;
              const fingerprint = `${updatedAt}|${title}`;
              const isNewOrUpdated = prevState.seenItems[stateKey] !== fingerprint;
              nextSeen[stateKey] = fingerprint;

              const classification = classifyUpstreamItem(title, "");
              repoSummary.commitCount += 1;
              if (isNewOrUpdated) repoSummary.newOrUpdatedCount += 1;
              if (classification.safetyDisposition === "blocked_by_r1_policy") {
                repoSummary.blockedByR1Count += 1;
              }

              items.push({
                repo: target.repo,
                kind: "commit",
                ref: shaShort,
                title,
                state: "main",
                url,
                updatedAt,
                isNewOrUpdated,
                ...classification,
              });
            }
          }
        } else if (commitRes.status === 403 || commitRes.status === 429) {
          repoSummary.status = "rate_limited";
          repoSummary.httpStatus = commitRes.status;
          repoSummary.errorMessage = `GitHub HTTP ${commitRes.status} while reading main commits`;
        }
      }
    } catch (err) {
      repoSummary.status = "error";
      repoSummary.errorMessage = err instanceof Error ? err.message : String(err);
    }

    repos.push(repoSummary);
  }

  const visibleItems = opts.onlyNew ? items.filter((i) => i.isNewOrUpdated) : items;

  const actionableRecommendations = Array.from(
    new Set(
      visibleItems
        .filter((i) => i.safetyDisposition === "safe_engineering")
        .map((i) => `${i.localMappingHint} (${i.repo} ${i.ref})`)
    )
  ).slice(0, 8);

  const jsonPath = path.join(outDir, `${dateStr}.json`);
  const markdownPath = path.join(outDir, `${dateStr}.md`);
  const latestJsonPath = path.join(outDir, "latest.json");
  const latestMarkdownPath = path.join(outDir, "latest.md");

  const report: UpstreamRadarReport = {
    date: dateStr,
    generatedAt: now.toISOString(),
    previousRunAt: prevState.lastRunAt || null,
    repos,
    items: visibleItems,
    actionableRecommendations,
    markdownPath,
    jsonPath,
  };

  const md = renderUpstreamMarkdown(report);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  writePrivateFile(jsonPath, serialized);
  writePrivateFile(latestJsonPath, serialized);
  writePrivateFile(markdownPath, md);
  writePrivateFile(latestMarkdownPath, md);
  writePrivateFile(
    statePath,
    `${JSON.stringify({ lastRunAt: now.toISOString(), seenItems: nextSeen }, null, 2)}\n`
  );

  return report;
}
