import type { RawDocument } from "@idea-finder/core";

import type { FetchOptions } from "../lib/fetch.js";
import { createRateLimitedFetcher, fetchJson } from "../lib/fetch.js";
import { normalizeDocument } from "../lib/normalize.js";
import type { SourceSearchQuery } from "../query-plan.js";
import type { ConnectorHealth, SourceConnector } from "../ports/source-connector.js";

export interface V2exConnectorOptions extends FetchOptions {
  readonly baseUrl?: string;
}

interface V2exTopic {
  readonly id: number;
  readonly title: string;
  readonly url: string;
  readonly content: string;
  readonly content_rendered?: string;
  readonly member?: { readonly username: string };
  readonly created?: number;
  readonly node_title?: string;
}

interface V2exSearchResponse {
  readonly result: readonly V2exTopic[];
}

export function createV2exConnector(options: V2exConnectorOptions = {}): SourceConnector {
  const baseUrl = options.baseUrl ?? "https://www.v2ex.com/api";
  const fetcher = createRateLimitedFetcher(options);

  return {
    platform: "v2ex",

    async healthcheck(): Promise<ConnectorHealth> {
      try {
        await fetchJson<readonly V2exTopic[]>(fetcher, `${baseUrl}/topics/hot.json`);
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },

    async *search(query: SourceSearchQuery): AsyncIterable<RawDocument> {
      const limit = query.limit ?? 20;
      const searchTerm = query.terms.join(" ");
      const url = new URL(`${baseUrl}/search.json`);
      url.searchParams.set("q", searchTerm);
      url.searchParams.set("from", "0");
      url.searchParams.set("size", String(limit));

      const data = await fetchJson<V2exSearchResponse>(fetcher, url);
      for (const topic of data.result) {
        yield topicToDocument(topic, query);
      }
    },

    async fetch(externalId: string): Promise<RawDocument> {
      const url = `${baseUrl}/topics/show.json?id=${encodeURIComponent(externalId)}`;
      const topics = await fetchJson<readonly V2exTopic[]>(fetcher, url);
      const topic = topics[0];
      if (!topic) {
        throw new Error(`V2EX topic not found: ${externalId}`);
      }
      return topicToDocument(topic, {
        platform: "v2ex",
        terms: [],
        huntingTaskId: "task_import" as never,
      });
    },
  };
}

function topicToDocument(topic: V2exTopic, query: SourceSearchQuery): RawDocument {
  const rawBody = [topic.title, topic.content || stripHtml(topic.content_rendered ?? "")].filter(Boolean).join("\n\n");
  const url = topic.url.startsWith("http") ? topic.url : `https://www.v2ex.com${topic.url}`;

  return normalizeDocument({
    platform: "v2ex",
    externalId: String(topic.id),
    url,
    rawBody,
    contentType: "post",
    huntingTaskId: query.huntingTaskId,
    fetchMethod: "api",
    legalBasis: "public_api_tos",
    fetchedAt: topic.created ? new Date(topic.created * 1000).toISOString() : undefined,
  });
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
