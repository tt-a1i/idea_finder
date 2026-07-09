import type { RawDocument } from "@idea-finder/core";

import type { FetchOptions } from "../lib/fetch.js";
import { createRateLimitedFetcher, fetchJson } from "../lib/fetch.js";
import { normalizeDocument } from "../lib/normalize.js";
import type { SourceSearchQuery } from "../query-plan.js";
import type { ConnectorHealth, SourceConnector } from "../ports/source-connector.js";

export interface StackExchangeConnectorOptions extends FetchOptions {
  readonly baseUrl?: string;
  readonly defaultSite?: string;
}

interface StackExchangeItem {
  readonly question_id: number;
  readonly title?: string;
  readonly body?: string;
  readonly link: string;
  readonly creation_date?: number;
  readonly tags?: readonly string[];
}

interface StackExchangeSearchResponse {
  readonly items: readonly StackExchangeItem[];
}

export function createStackExchangeConnector(
  options: StackExchangeConnectorOptions = {},
): SourceConnector {
  const baseUrl = options.baseUrl ?? "https://api.stackexchange.com/2.3";
  const defaultSite = options.defaultSite ?? "stackoverflow";
  const fetcher = createRateLimitedFetcher(options);

  return {
    platform: "stack_exchange",

    async healthcheck(): Promise<ConnectorHealth> {
      try {
        const url = new URL(`${baseUrl}/info`);
        url.searchParams.set("site", defaultSite);
        await fetchJson(fetcher, url);
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },

    async *search(query: SourceSearchQuery): AsyncIterable<RawDocument> {
      const site = query.stackExchangeSite ?? defaultSite;
      const limit = query.limit ?? 20;
      const searchTerm = query.terms.join(" ");
      const url = new URL(`${baseUrl}/search/advanced`);
      url.searchParams.set("order", "desc");
      url.searchParams.set("sort", "activity");
      url.searchParams.set("q", searchTerm);
      url.searchParams.set("site", site);
      url.searchParams.set("pagesize", String(Math.min(limit, 100)));
      url.searchParams.set("filter", "withbody");

      const data = await fetchJson<StackExchangeSearchResponse>(fetcher, url);
      for (const item of data.items) {
        yield itemToDocument(item, site, query);
      }
    },

    async fetch(externalId: string): Promise<RawDocument> {
      const [site, questionId] = externalId.includes(":")
        ? externalId.split(":", 2)
        : [defaultSite, externalId];
      const url = new URL(`${baseUrl}/questions/${questionId}`);
      url.searchParams.set("site", site!);
      url.searchParams.set("filter", "withbody");
      const data = await fetchJson<{ readonly items: readonly StackExchangeItem[] }>(fetcher, url);
      const item = data.items[0];
      if (!item) {
        throw new Error(`Stack Exchange question not found: ${externalId}`);
      }
      return itemToDocument(item, site!, {
        platform: "stack_exchange",
        terms: [],
        huntingTaskId: "task_import" as never,
      });
    },
  };
}

function itemToDocument(
  item: StackExchangeItem,
  site: string,
  query: SourceSearchQuery,
): RawDocument {
  const tags = item.tags?.length ? `Tags: ${item.tags.join(", ")}` : "";
  const rawBody = [item.title ?? "", stripHtml(item.body ?? ""), tags].filter(Boolean).join("\n\n");

  return normalizeDocument({
    platform: "stack_exchange",
    externalId: `${site}:${item.question_id}`,
    url: item.link,
    rawBody,
    contentType: "post",
    huntingTaskId: query.huntingTaskId,
    fetchMethod: "api",
    legalBasis: "public_api_tos",
    fetchedAt: item.creation_date
      ? new Date(item.creation_date * 1000).toISOString()
      : undefined,
  });
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
