import type { RawDocument } from "@idea-finder/core";

import type { FetchOptions } from "../lib/fetch.js";
import { createRateLimitedFetcher, fetchJson } from "../lib/fetch.js";
import { normalizeDocument } from "../lib/normalize.js";
import type { SourceSearchQuery } from "../query-plan.js";
import type { ConnectorHealth, SourceConnector } from "../ports/source-connector.js";

export interface AppStoreRssConnectorOptions extends FetchOptions {
  readonly baseUrl?: string;
  readonly defaultAppId?: string;
}

interface AppStoreReviewEntry {
  readonly id?: { readonly label: string };
  readonly title?: { readonly label: string };
  readonly content?: { readonly label: string };
  readonly author?: { readonly name?: { readonly label: string } };
  readonly updated?: { readonly label: string };
  readonly link?: { readonly attributes?: { readonly href: string } };
}

interface AppStoreRssResponse {
  readonly feed?: {
    readonly entry?: AppStoreReviewEntry | AppStoreReviewEntry[];
  };
}

export function createAppStoreRssConnector(
  options: AppStoreRssConnectorOptions = {},
): SourceConnector {
  const baseUrl = options.baseUrl ?? "https://itunes.apple.com";
  const defaultAppId = options.defaultAppId;
  const fetcher = createRateLimitedFetcher(options);

  return {
    platform: "app_store",

    async healthcheck(): Promise<ConnectorHealth> {
      if (!defaultAppId) {
        return { ok: true, message: "configured; provide appId in search query" };
      }
      try {
        const url = reviewFeedUrl(baseUrl, defaultAppId, 1);
        await fetchJson<AppStoreRssResponse>(fetcher, url);
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },

    async *search(query: SourceSearchQuery): AsyncIterable<RawDocument> {
      const appId = query.appId ?? defaultAppId;
      if (!appId) {
        throw new Error("App Store RSS search requires appId in query or connector defaultAppId");
      }
      const limit = query.limit ?? 20;
      const terms = query.terms.map((t) => t.toLowerCase());
      const url = reviewFeedUrl(baseUrl, appId, 1);
      const data = await fetchJson<AppStoreRssResponse>(fetcher, url);
      const entries = normalizeEntries(data.feed?.entry);
      let yielded = 0;

      for (const entry of entries) {
        const doc = entryToDocument(entry, appId, query);
        if (terms.length > 0) {
          const haystack = doc.rawBody.toLowerCase();
          if (!terms.some((term) => haystack.includes(term))) continue;
        }
        yield doc;
        yielded++;
        if (yielded >= limit) break;
      }
    },

    async fetch(externalId: string): Promise<RawDocument> {
      const [appId, reviewId] = externalId.split(":");
      if (!appId || !reviewId) {
        throw new Error(`App Store externalId must be appId:reviewId, got ${externalId}`);
      }
      const url = reviewFeedUrl(baseUrl, appId, 1);
      const data = await fetchJson<AppStoreRssResponse>(fetcher, url);
      const entry = normalizeEntries(data.feed?.entry).find((e) => e.id?.label === reviewId);
      if (!entry) {
        throw new Error(`App Store review not found: ${externalId}`);
      }
      return entryToDocument(entry, appId, {
        platform: "app_store",
        terms: [],
        huntingTaskId: "task_import" as never,
      });
    },
  };
}

function reviewFeedUrl(baseUrl: string, appId: string, page: number): string {
  return `${baseUrl}/rss/customerreviews/page=${page}/id=${appId}/sortBy=mostRecent/json`;
}

function normalizeEntries(entry: unknown): AppStoreReviewEntry[] {
  if (!entry) return [];
  if (Array.isArray(entry)) {
    return entry as AppStoreReviewEntry[];
  }
  return [entry as AppStoreReviewEntry];
}

function entryToDocument(
  entry: AppStoreReviewEntry,
  appId: string,
  query: SourceSearchQuery,
): RawDocument {
  const reviewId = entry.id?.label ?? "unknown";
  const title = entry.title?.label ?? "";
  const content = entry.content?.label ?? "";
  const author = entry.author?.name?.label ?? "anonymous";
  const rawBody = [`${title} (${author})`, content].filter(Boolean).join("\n\n");
  const url =
    entry.link?.attributes?.href ??
    `https://apps.apple.com/app/id${appId}#see-all/reviews`;

  return normalizeDocument({
    platform: "app_store",
    externalId: `${appId}:${reviewId}`,
    url,
    rawBody,
    contentType: "review",
    huntingTaskId: query.huntingTaskId,
    fetchMethod: "rss",
    legalBasis: "public_api_tos",
    fetchedAt: entry.updated?.label,
  });
}
