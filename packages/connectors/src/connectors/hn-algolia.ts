import type { RawDocument } from "@idea-finder/core";

import type { FetchOptions } from "../lib/fetch.js";
import { createRateLimitedFetcher, fetchJson } from "../lib/fetch.js";
import { normalizeDocument } from "../lib/normalize.js";
import { resolveQueryTexts } from "../lib/query-texts.js";
import type { SourceSearchQuery } from "../query-plan.js";
import type { ConnectorHealth, SourceConnector } from "../ports/source-connector.js";

export interface HnAlgoliaConnectorOptions extends FetchOptions {
  readonly baseUrl?: string;
}

interface HnHit {
  readonly objectID: string;
  readonly title?: string;
  readonly url?: string;
  readonly story_text?: string;
  readonly author?: string;
  readonly created_at?: string;
  readonly comment_text?: string;
  readonly parent_id?: number;
  readonly story_id?: number;
  readonly story_title?: string;
}

interface HnSearchResponse {
  readonly hits: readonly HnHit[];
}

function hnApiUrl(baseUrl: string, path: string): URL {
  const root = baseUrl.replace(/\/$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return new URL(`${root}${suffix}`);
}

export function createHnAlgoliaConnector(options: HnAlgoliaConnectorOptions = {}): SourceConnector {
  const baseUrl = options.baseUrl ?? "https://hn.algolia.com/api/v1";
  const fetcher = createRateLimitedFetcher(options);

  return {
    platform: "hn",

    async healthcheck(): Promise<ConnectorHealth> {
      try {
        const url = hnApiUrl(baseUrl, "/search");
        url.searchParams.set("query", "test");
        url.searchParams.set("tags", "story");
        url.searchParams.set("hitsPerPage", "1");
        await fetchJson<HnSearchResponse>(fetcher, url);
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },

    async *search(query: SourceSearchQuery): AsyncIterable<RawDocument> {
      const limit = query.limit ?? 20;
      const queryTexts = resolveQueryTexts(query);
      for (const searchTerm of queryTexts) {
        const url = hnApiUrl(baseUrl, "/search");
        url.searchParams.set("query", searchTerm);
        url.searchParams.set("tags", query.hnTags ?? "story");
        url.searchParams.set("hitsPerPage", String(limit));
        if (query.since) {
          const sinceEpoch = Math.floor(Date.parse(query.since) / 1000);
          if (!Number.isNaN(sinceEpoch)) {
            url.searchParams.set("numericFilters", `created_at_i>${sinceEpoch}`);
          }
        }

        const data = await fetchJson<HnSearchResponse>(fetcher, url);
        for (const hit of data.hits) {
          yield hitToDocument(hit, query);
        }
      }
    },

    async fetch(externalId: string): Promise<RawDocument> {
      const url = hnApiUrl(baseUrl, `/items/${externalId}`);
      const hit = await fetchJson<HnHit>(fetcher, url);
      return hitToDocument(hit, {
        platform: "hn",
        terms: [],
        huntingTaskId: "task_import" as never,
      });
    },
  };
}

function hitToDocument(hit: HnHit, query: SourceSearchQuery): RawDocument {
  const isComment = (query.hnTags ?? "story") === "comment" || Boolean(hit.comment_text && !hit.story_text);
  const title = hit.title ?? hit.story_title ?? (isComment ? "(comment)" : "(untitled)");
  const body = hit.story_text ?? hit.comment_text ?? "";
  const linkage = isComment
    ? [
        hit.story_id !== undefined ? `Story-ID: ${hit.story_id}` : null,
        hit.parent_id !== undefined ? `Parent-ID: ${hit.parent_id}` : null,
        hit.story_title ? `Story-Title: ${hit.story_title}` : null,
      ].filter(Boolean).join("\n")
    : "";
  const rawBody = [title, body, linkage].filter(Boolean).join("\n\n");
  const url = hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`;

  return normalizeDocument({
    platform: "hn",
    externalId: hit.objectID,
    url,
    rawBody,
    contentType: isComment ? "comment" : "post",
    huntingTaskId: query.huntingTaskId,
    fetchMethod: "api",
    legalBasis: "public_api_tos",
    fetchedAt: hit.created_at,
  });
}
