import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { asId } from "@idea-finder/core";
import {
  createAppStoreRssConnector,
  createHnAlgoliaConnector,
  createL0ConnectorPack,
  createManualImportConnector,
  createStackExchangeConnector,
  createV2exConnector,
  type QueryPlan,
} from "@idea-finder/connectors";

import { createHarvestPipeline } from "../src/harvest-pipeline.js";
import { InMemoryHarvestRepository } from "../src/in-memory-harvest-repository.js";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../connectors/test/fixtures",
);
const taskId = asId("task_harvest");
const runId = asId("run_harvest_test");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
}

function mockFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("hn.test") && url.includes("/search")) {
      return json(loadFixture("hn-search.json"));
    }
    if (url.includes("v2ex.test") && url.includes("search.json")) {
      return json(loadFixture("v2ex-search.json"));
    }
    if (url.includes("itunes.test") && url.includes("customerreviews")) {
      return json(loadFixture("app-store-rss.json"));
    }
    if (url.includes("stackexchange.test") && url.includes("/search/advanced")) {
      return json(loadFixture("stack-exchange-search.json"));
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("harvest pipeline", () => {
  it("runs connectors, chunks, detects signals, and persists via repository", async () => {
    const fetchFn = mockFetch();
    const connectors = [
      createHnAlgoliaConnector({ fetchFn, baseUrl: "https://hn.test/api/v1" }),
      createV2exConnector({ fetchFn, baseUrl: "https://v2ex.test/api" }),
      createAppStoreRssConnector({ fetchFn, baseUrl: "https://itunes.test" }),
      createStackExchangeConnector({ fetchFn, baseUrl: "https://api.stackexchange.test/2.3" }),
      createManualImportConnector(),
    ];
    const repository = new InMemoryHarvestRepository();
    const pipeline = createHarvestPipeline({ connectors, repository });

    const plan: QueryPlan = {
      huntingTaskId: taskId,
      searches: [
        { platform: "hn", terms: ["spreadsheet"], limit: 5 },
        { platform: "v2ex", terms: ["工具"], limit: 5 },
        { platform: "app_store", terms: ["expensive"], appId: "123", limit: 5 },
        { platform: "stack_exchange", terms: ["export"], limit: 5 },
      ],
      manualImports: [{ text: "Manual note: feature request please add export." }],
    };

    const result = await pipeline.runHarvest(runId, plan);
    expect(result.documents.length).toBeGreaterThanOrEqual(4);
    expect(result.chunks.length).toBeGreaterThanOrEqual(result.documents.length);
    expect(result.signals.length).toBeGreaterThan(0);

    const stored = await repository.getResult(runId);
    expect(stored?.documents).toHaveLength(result.documents.length);

    for (const doc of result.documents) {
      expect(doc.sourceTier).toBe("L0");
      expect(doc.huntingTaskId).toBe(taskId);
    }
  });

  it("createL0ConnectorPack registers all default platforms", () => {
    const pack = createL0ConnectorPack({ fetch: { fetchFn: mockFetch() } });
    expect(pack.map((c) => c.platform).sort()).toEqual(
      ["app_store", "hn", "manual", "stack_exchange", "v2ex"].sort(),
    );
  });
});

describe.skip("live smoke (optional)", () => {
  it("hits HN Algolia with real network", async () => {
    const connector = createHnAlgoliaConnector();
    const docs = [];
    for await (const doc of connector.search({
      platform: "hn",
      terms: ["saas"],
      huntingTaskId: taskId,
      limit: 1,
    })) {
      docs.push(doc);
    }
    expect(docs.length).toBeGreaterThan(0);
  });
});
