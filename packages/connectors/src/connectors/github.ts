import { createHash } from "node:crypto";

import type { FetchOptions } from "../lib/fetch.js";
import { createRateLimitedFetcher } from "../lib/fetch.js";
import type {
  CollectedMetricObservation,
  QuantitativeCollectionRequest,
  QuantitativeConnector,
} from "../ports/quantitative-connector.js";

const API_VERSION = "2022-11-28";

export interface GitHubQuantitativeConnectorOptions extends FetchOptions {
  readonly baseUrl?: string;
  readonly token?: string;
  readonly now?: () => Date;
}

interface GitHubRepositoryResponse {
  readonly full_name: string;
  readonly stargazers_count: number;
  readonly forks_count: number;
}

export class GitHubRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number | null,
    readonly resetAt: string | null,
  ) {
    super(message);
    this.name = "GitHubRateLimitError";
  }
}

interface GitHubIssueResponse {
  readonly id: number;
  readonly created_at: string;
  readonly closed_at: string | null;
  readonly pull_request?: unknown;
}

interface GitHubContributorResponse {
  readonly id: number;
  readonly contributions: number;
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`GitHub API source drift: ${path} must be a non-negative number`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`GitHub API source drift: ${path} must be a non-empty string`);
  }
  return value;
}

function parseRepository(value: unknown, expected: string): GitHubRepositoryResponse {
  if (!value || typeof value !== "object") throw new Error("GitHub API source drift: repository response must be an object");
  const row = value as Record<string, unknown>;
  const fullName = requireString(row.full_name, "repository.full_name");
  if (fullName.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`GitHub API source drift: expected ${expected}, received ${fullName}`);
  }
  return {
    full_name: fullName,
    stargazers_count: requireNumber(row.stargazers_count, "repository.stargazers_count"),
    forks_count: requireNumber(row.forks_count, "repository.forks_count"),
  };
}

function parseIssues(value: unknown): GitHubIssueResponse[] {
  if (!Array.isArray(value)) throw new Error("GitHub API source drift: issues response must be an array");
  const unique = new Map<number, GitHubIssueResponse>();
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error("GitHub API source drift: issue must be an object");
    const row = item as Record<string, unknown>;
    if (row.pull_request !== undefined) continue;
    const id = requireNumber(row.id, "issue.id");
    const createdAt = requireString(row.created_at, "issue.created_at");
    if (Number.isNaN(Date.parse(createdAt))) throw new Error("GitHub API source drift: issue.created_at must be ISO date-time");
    if (row.closed_at !== null && row.closed_at !== undefined && (typeof row.closed_at !== "string" || Number.isNaN(Date.parse(row.closed_at)))) {
      throw new Error("GitHub API source drift: issue.closed_at must be ISO date-time or null");
    }
    const parsed = { id, created_at: createdAt, closed_at: (row.closed_at as string | null | undefined) ?? null };
    const existing = unique.get(id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(parsed)) {
      throw new Error(`GitHub API source drift: conflicting duplicate issue.id ${id}`);
    }
    unique.set(id, parsed);
  }
  return [...unique.values()];
}

function parseContributors(value: unknown): GitHubContributorResponse[] {
  if (!Array.isArray(value)) throw new Error("GitHub API source drift: contributors response must be an array");
  const unique = new Map<number, GitHubContributorResponse>();
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error("GitHub API source drift: contributor must be an object");
    const row = item as Record<string, unknown>;
    const id = requireNumber(row.id, "contributor.id");
    const parsed = { id, contributions: requireNumber(row.contributions, "contributor.contributions") };
    const existing = unique.get(id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(parsed)) {
      throw new Error(`GitHub API source drift: conflicting duplicate contributor.id ${id}`);
    }
    unique.set(id, parsed);
  }
  return [...unique.values()];
}

function observationId(subject: string, metric: string, observedAt: string): string {
  return `metric_${createHash("sha256").update(`${subject}\0${metric}\0${observedAt}`).digest("hex").slice(0, 24)}`;
}

function repositoryName(subject: string): string {
  const normalized = subject.replace(/^github:/, "");
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) throw new Error("GitHub subject must be owner/repository or github:owner/repository");
  return normalized;
}

export function createGitHubQuantitativeConnector(options: GitHubQuantitativeConnectorOptions = {}): QuantitativeConnector {
  const apiRoot = new URL(options.baseUrl ?? "https://api.github.com");
  if (apiRoot.protocol !== "https:") throw new Error("GitHub API baseUrl must use HTTPS");
  const fetcher = createRateLimitedFetcher(options);
  const token = options.token ?? process.env.GITHUB_TOKEN;
  const now = options.now ?? (() => new Date());
  const headers = (): Headers => {
    const value = new Headers({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION });
    if (token) value.set("Authorization", `Bearer ${token}`);
    return value;
  };
  let exhaustedUntil: string | null = null;
  const assertAuthorizedUrl = (url: URL): void => {
    if (url.protocol !== "https:" || url.origin !== apiRoot.origin) {
      throw new Error(`GitHub API pagination rejected cross-origin URL: ${url}`);
    }
  };
  const request = async (url: URL): Promise<Response> => {
    assertAuthorizedUrl(url);
    if (exhaustedUntil && exhaustedUntil !== "unknown" && now().getTime() >= Date.parse(exhaustedUntil)) exhaustedUntil = null;
    if (exhaustedUntil) throw new GitHubRateLimitError(`GitHub API rate limit exhausted; reset at ${exhaustedUntil}`, null, exhaustedUntil);
    const response = await fetcher.fetch(url, { headers: headers() });
    const retryRaw = response.headers.get("retry-after");
    const retryAfter = retryRaw !== null && /^\d+$/.test(retryRaw) ? Number(retryRaw) : null;
    const resetRaw = response.headers.get("x-ratelimit-reset");
    const resetAt = resetRaw !== null && /^\d+$/.test(resetRaw) ? new Date(Number(resetRaw) * 1000).toISOString() : null;
    if (!response.ok) {
      if (response.status === 429 || response.status === 403 || retryAfter !== null || response.headers.get("x-ratelimit-remaining") === "0") {
        exhaustedUntil = resetAt
          ?? (retryAfter !== null ? new Date(now().getTime() + retryAfter * 1000).toISOString() : "unknown");
        throw new GitHubRateLimitError(
          `GitHub API rate limited (HTTP ${response.status}); retry-after=${retryAfter ?? "unknown"}; reset=${resetAt ?? "unknown"}`,
          retryAfter,
          resetAt,
        );
      }
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    if (response.headers.get("x-ratelimit-remaining") === "0") exhaustedUntil = resetAt ?? "unknown";
    return response;
  };
  const get = async <T>(url: URL): Promise<T> => {
    const response = await request(url);
    return await response.json() as T;
  };
  const getAllPages = async (initialUrl: URL): Promise<unknown[]> => {
    const items: unknown[] = [];
    let next: URL | null = initialUrl;
    const visited = new Set<string>();
    while (next) {
      if (visited.has(next.toString())) throw new Error(`GitHub API pagination loop: ${next}`);
      visited.add(next.toString());
      const response = await request(next);
      const page: unknown = await response.json();
      if (!Array.isArray(page)) throw new Error("GitHub API source drift: paginated response must be an array");
      items.push(...page);
      const match = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/);
      if (match?.[1]) {
        const candidate: URL = new URL(match[1], next.toString());
        assertAuthorizedUrl(candidate);
        next = candidate;
      } else {
        next = null;
      }
    }
    return items;
  };

  return {
    source: "github",
    async healthcheck() {
      try {
        await get<unknown>(new URL("/rate_limit", apiRoot));
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    async collect(request: QuantitativeCollectionRequest) {
      const repoName = repositoryName(request.subject);
      const sinceMs = request.since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(request.since);
      if (request.since !== undefined && Number.isNaN(sinceMs)) throw new Error("GitHub collection since must be ISO date-time");
      const subject = `github:${repoName.toLowerCase()}`;
      const observedAt = now().toISOString();
      const repoUrl = new URL(`/repos/${repoName}`, apiRoot);
      const issuesUrl = new URL(`/repos/${repoName}/issues`, apiRoot);
      issuesUrl.searchParams.set("state", "all");
      issuesUrl.searchParams.set("per_page", "100");
      const contributorsUrl = new URL(`/repos/${repoName}/contributors`, apiRoot);
      contributorsUrl.searchParams.set("per_page", "100");

      // Deliberately serial: one shared rate-limit budget, no burst of concurrent API calls.
      const repoRaw = await get<unknown>(repoUrl);
      const issuesRaw = await getAllPages(issuesUrl);
      const contributorsRaw = await getAllPages(contributorsUrl);
      const repo = parseRepository(repoRaw, repoName);
      const issues = parseIssues(issuesRaw);
      const contributors = parseContributors(contributorsRaw);
      const values: ReadonlyArray<readonly [string, number, URL, string]> = [
        ["github.repository.stars", repo.stargazers_count, repoUrl, "/repos/{owner}/{repo}"],
        ["github.repository.forks", repo.forks_count, repoUrl, "/repos/{owner}/{repo}"],
        ["github.repository.open_issues", issues.filter((issue) => issue.closed_at === null).length, issuesUrl, "/repos/{owner}/{repo}/issues"],
        ["github.issue.opened", issues.filter((issue) => Date.parse(issue.created_at) >= sinceMs).length, issuesUrl, "/repos/{owner}/{repo}/issues"],
        ["github.issue.closed", issues.filter((issue) => issue.closed_at !== null && Date.parse(issue.closed_at) >= sinceMs).length, issuesUrl, "/repos/{owner}/{repo}/issues"],
        ["github.repository.contributors", contributors.length, contributorsUrl, "/repos/{owner}/{repo}/contributors"],
      ];
      return values.map(([metric, value, url, endpoint]): CollectedMetricObservation => ({
        id: observationId(subject, metric, observedAt), subject, source: "github", metric,
        geography: null, observedAt, rawValue: value, normalizedValue: value, unit: "count",
        collectionMethod: "authorized_public_api",
        provenance: { url: url.toString(), endpoint, apiVersion: API_VERSION, retrievedAt: observedAt },
      }));
    },
  };
}
