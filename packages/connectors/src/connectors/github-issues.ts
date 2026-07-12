import type { RawDocument } from "@idea-finder/core";

import type { FetchOptions } from "../lib/fetch.js";
import { createRateLimitedFetcher } from "../lib/fetch.js";
import { resolveGithubToken, type GithubTokenResolver } from "../lib/github-token.js";
import { normalizeDocument } from "../lib/normalize.js";
import { resolveQueryTexts } from "../lib/query-texts.js";
import type { SourceSearchQuery } from "../query-plan.js";
import type { ConnectorHealth, SourceConnector } from "../ports/source-connector.js";
import { GitHubAuthorizationError, GitHubRateLimitError } from "./github.js";

export interface GitHubIssuesConnectorOptions extends FetchOptions {
  readonly baseUrl?: string;
  readonly token?: string;
  readonly tokenResolver?: GithubTokenResolver;
  readonly commentBudget?: number;
}

interface GitHubIssueItem {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly html_url: string;
  readonly user?: { readonly login?: string } | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly state: string;
  readonly labels?: readonly { readonly name?: string }[];
  readonly reactions?: { readonly total_count?: number };
  readonly pull_request?: unknown;
  readonly comments?: number;
  readonly repository_url?: string;
}

interface GitHubCommentItem {
  readonly id: number;
  readonly body: string;
  readonly html_url: string;
  readonly user?: { readonly login?: string } | null;
  readonly created_at: string;
  readonly updated_at: string;
}

async function githubJson<T>(
  fetcher: ReturnType<typeof createRateLimitedFetcher>,
  url: URL,
  token: string | undefined,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "idea-finder",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetcher.fetch(url, { headers });
  if (response.status === 401 || response.status === 403) {
    const retryAfter = response.headers.get("retry-after");
    if (response.status === 403 && (retryAfter || response.headers.get("x-ratelimit-remaining") === "0")) {
      throw new GitHubRateLimitError("GitHub API rate limited", retryAfter ? Number(retryAfter) : null, response.headers.get("x-ratelimit-reset"));
    }
    throw new GitHubAuthorizationError(`GitHub API authorization failed (${response.status})`, response.status);
  }
  if (!response.ok) {
    throw new Error(`GitHub Issues API failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function issueToDocument(issue: GitHubIssueItem, query: SourceSearchQuery): RawDocument {
  const labels = (issue.labels ?? []).map((label) => label.name).filter(Boolean).join(", ");
  const rawBody = [
    issue.title,
    issue.body ?? "",
    labels ? `Labels: ${labels}` : null,
    issue.reactions?.total_count !== undefined ? `Reactions: ${issue.reactions.total_count}` : null,
    `State: ${issue.state}`,
    issue.user?.login ? `Author: ${issue.user.login}` : "Author: anonymous",
  ].filter(Boolean).join("\n\n");
  return normalizeDocument({
    platform: "github_issues",
    externalId: String(issue.id),
    url: issue.html_url,
    rawBody,
    contentType: "issue",
    huntingTaskId: query.huntingTaskId,
    fetchMethod: "api",
    legalBasis: "public_api_tos",
    fetchedAt: issue.updated_at || issue.created_at,
  });
}

function commentToDocument(comment: GitHubCommentItem, issue: GitHubIssueItem, query: SourceSearchQuery): RawDocument {
  const rawBody = [
    `Comment on issue #${issue.number}: ${issue.title}`,
    comment.body,
    comment.user?.login ? `Author: ${comment.user.login}` : "Author: anonymous",
    `Parent-Issue: ${issue.html_url}`,
  ].join("\n\n");
  return normalizeDocument({
    platform: "github_issues",
    externalId: `comment-${comment.id}`,
    url: comment.html_url,
    rawBody,
    contentType: "comment",
    huntingTaskId: query.huntingTaskId,
    fetchMethod: "api",
    legalBasis: "public_api_tos",
    fetchedAt: comment.updated_at || comment.created_at,
  });
}

/** Qualitative GitHub Issues connector (separate from stars/forks quantitative lane). */
export function createGitHubIssuesConnector(options: GitHubIssuesConnectorOptions = {}): SourceConnector {
  const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const fetcher = createRateLimitedFetcher(options);
  const commentBudget = options.commentBudget ?? 3;

  return {
    platform: "github_issues",

    async healthcheck(): Promise<ConnectorHealth> {
      try {
        const token = resolveGithubToken(options.token, options.tokenResolver);
        const url = new URL(`${baseUrl}/rate_limit`);
        await githubJson(fetcher, url, token);
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },

    async *search(query: SourceSearchQuery): AsyncIterable<RawDocument> {
      const token = resolveGithubToken(options.token, options.tokenResolver);
      const limit = query.limit ?? 20;
      for (const searchTerm of resolveQueryTexts(query)) {
        const url = new URL(`${baseUrl}/search/issues`);
        const qParts = [`${searchTerm}`, "is:issue", "is:public"];
        if (query.since) qParts.push(`created:>=${query.since.slice(0, 10)}`);
        url.searchParams.set("q", qParts.join(" "));
        url.searchParams.set("per_page", String(Math.min(limit, 50)));
        url.searchParams.set("sort", "reactions");
        const data = await githubJson<{ items: GitHubIssueItem[] }>(fetcher, url, token);
        let commentsUsed = 0;
        for (const issue of data.items ?? []) {
          if (issue.pull_request !== undefined) continue;
          yield issueToDocument(issue, query);
          if (commentsUsed >= commentBudget || !issue.comments || issue.comments <= 0) continue;
          const repoPath = issue.repository_url?.replace("https://api.github.com/repos/", "")
            ?? issue.html_url.match(/github\.com\/([^/]+\/[^/]+)/)?.[1];
          if (!repoPath) continue;
          const commentsUrl = new URL(`${baseUrl}/repos/${repoPath}/issues/${issue.number}/comments`);
          commentsUrl.searchParams.set("per_page", "5");
          try {
            const comments = await githubJson<GitHubCommentItem[]>(fetcher, commentsUrl, token);
            for (const comment of comments.slice(0, Math.max(0, commentBudget - commentsUsed))) {
              yield commentToDocument(comment, issue, query);
              commentsUsed += 1;
            }
          } catch {
            // Comment fetch failures must not drop the parent issue.
          }
        }
      }
    },

    async fetch(externalId: string): Promise<RawDocument> {
      const token = resolveGithubToken(options.token, options.tokenResolver);
      const url = new URL(`${baseUrl}/issues/${externalId}`);
      const issue = await githubJson<GitHubIssueItem>(fetcher, url, token);
      if (issue.pull_request !== undefined) {
        throw new Error(`GitHub Issues connector excludes pull requests: ${externalId}`);
      }
      return issueToDocument(issue, {
        platform: "github_issues",
        terms: [],
        huntingTaskId: "task_import" as never,
      });
    },
  };
}
