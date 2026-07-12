import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { asId } from "@idea-finder/core";

import { createAppStoreRssConnector } from "../src/connectors/app-store-rss.js";
import { createHnAlgoliaConnector } from "../src/connectors/hn-algolia.js";
import { createStackExchangeConnector } from "../src/connectors/stack-exchange.js";
import { createV2exConnector } from "../src/connectors/v2ex.js";
import { createManualImportConnector } from "../src/connectors/manual-import.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const taskId = asId("task_test");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
}

function mockFetch(routes: Record<string, unknown>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [pattern, body] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("L0 connectors (fixture-backed)", () => {
  it("preserves the /api/v1 path when composing HN search URLs and encodes query params", async () => {
    const seen: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify(loadFixture("hn-search.json")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const connector = createHnAlgoliaConnector({
      fetchFn,
      baseUrl: "https://hn.algolia.com/api/v1",
      minIntervalMs: 0,
    });
    const docs = [];
    for await (const doc of connector.search({
      platform: "hn",
      terms: ["agent coding", "context loss"],
      huntingTaskId: taskId,
      limit: 5,
      since: "2026-01-01T00:00:00.000Z",
    })) {
      docs.push(doc);
    }
    expect(docs).toHaveLength(1);
    expect(seen[0]).toMatch(/^https:\/\/hn\.algolia\.com\/api\/v1\/search\?/);
    const url = new URL(seen[0]!);
    expect(url.pathname).toBe("/api/v1/search");
    expect(url.searchParams.get("query")).toBe("agent coding context loss");
    expect(url.searchParams.get("tags")).toBe("story");
    expect(url.searchParams.get("hitsPerPage")).toBe("5");
    expect(url.searchParams.get("numericFilters")).toBe(`created_at_i>${Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000)}`);
  });

  it("normalizes HN Algolia hits to RawDocument with L0 provenance", async () => {
    const connector = createHnAlgoliaConnector({
      fetchFn: mockFetch({ "/search": loadFixture("hn-search.json") }),
      baseUrl: "https://hn.test/api/v1",
    });
    const docs = [];
    for await (const doc of connector.search({
      platform: "hn",
      terms: ["spreadsheet"],
      huntingTaskId: taskId,
      limit: 5,
    })) {
      docs.push(doc);
    }
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      sourceTier: "L0",
      platform: "hn",
      externalId: "12345",
      fetchMethod: "api",
      legalBasis: "public_api_tos",
      retentionClass: "standard",
      contentType: "post",
    });
    expect(docs[0]!.rawBody).toContain("Spreadsheet workaround");
  });

  it("normalizes V2EX search results", async () => {
    const connector = createV2exConnector({
      fetchFn: mockFetch({ "search.json": loadFixture("v2ex-search.json") }),
      baseUrl: "https://v2ex.test/api",
    });
    const docs = [];
    for await (const doc of connector.search({
      platform: "v2ex",
      terms: ["工具"],
      huntingTaskId: taskId,
    })) {
      docs.push(doc);
    }
    expect(docs[0]).toMatchObject({
      platform: "v2ex",
      externalId: "99",
      fetchMethod: "api",
      sourceTier: "L0",
    });
  });

  it("normalizes App Store RSS reviews with term filter", async () => {
    const connector = createAppStoreRssConnector({
      fetchFn: mockFetch({ "customerreviews": loadFixture("app-store-rss.json") }),
      baseUrl: "https://itunes.test",
    });
    const docs = [];
    for await (const doc of connector.search({
      platform: "app_store",
      terms: ["expensive"],
      appId: "123",
      huntingTaskId: taskId,
    })) {
      docs.push(doc);
    }
    expect(docs[0]).toMatchObject({
      platform: "app_store",
      fetchMethod: "rss",
      contentType: "review",
      externalId: "123:review-1",
    });
  });

  it("normalizes Stack Exchange search results", async () => {
    const connector = createStackExchangeConnector({
      fetchFn: mockFetch({ "/search/advanced": loadFixture("stack-exchange-search.json") }),
      baseUrl: "https://api.stackexchange.test/2.3",
    });
    const docs = [];
    for await (const doc of connector.search({
      platform: "stack_exchange",
      terms: ["export"],
      huntingTaskId: taskId,
    })) {
      docs.push(doc);
    }
    expect(docs[0]).toMatchObject({
      platform: "stack_exchange",
      externalId: "stackoverflow:777",
      fetchMethod: "api",
    });
    expect(docs[0]!.rawBody).toContain("Feature request");
  });

  it("imports manual text with user_provided legal basis", () => {
    const connector = createManualImportConnector();
    const doc = connector.importText(
      { text: "This is painful and I would pay for a fix.", url: "https://example.com/note" },
      taskId,
    );
    expect(doc).toMatchObject({
      platform: "manual",
      fetchMethod: "import",
      legalBasis: "user_provided",
      retentionClass: "pinned",
      url: "https://example.com/note",
    });
  });
});
