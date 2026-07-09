import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  admitToLibrary,
  asId,
} from "@idea-finder/core";
import {
  createAppStoreRssConnector,
  createHnAlgoliaConnector,
  createManualImportConnector,
  createStackExchangeConnector,
  createV2exConnector,
  type QueryPlan,
} from "@idea-finder/connectors";
import { createHarvestPipeline } from "@idea-finder/harvest";
import {
  createInMemoryIntelligenceStores,
  createIntelligencePipeline,
  seedFromHarvestResult,
} from "@idea-finder/intelligence";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../connectors/test/fixtures",
);
const taskId = asId("task_integration");
const runId = asId("run_integration");

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

describe("harvest -> intelligence -> admitToLibrary", () => {
  it("yields at least one hypothesis without LLM", async () => {
    const fetchFn = mockFetch();
    const connectors = [
      createHnAlgoliaConnector({ fetchFn, baseUrl: "https://hn.test/api/v1" }),
      createV2exConnector({ fetchFn, baseUrl: "https://v2ex.test/api" }),
      createAppStoreRssConnector({ fetchFn, baseUrl: "https://itunes.test" }),
      createStackExchangeConnector({ fetchFn, baseUrl: "https://api.stackexchange.test/2.3" }),
      createManualImportConnector(),
    ];

    const plan: QueryPlan = {
      huntingTaskId: taskId,
      searches: [
        { platform: "hn", terms: ["spreadsheet"], limit: 5 },
        { platform: "v2ex", terms: ["工具"], limit: 5 },
        { platform: "app_store", terms: ["expensive"], appId: "123", limit: 5 },
        { platform: "stack_exchange", terms: ["export"], limit: 5 },
      ],
      manualImports: [
        {
          text: "Painful workaround — would pay for better tooling. Works fine for enterprise though.",
        },
      ],
    };

    const harvest = createHarvestPipeline({ connectors });
    const harvestResult = await harvest.runHarvest(runId, plan);
    expect(harvestResult.signals.length).toBeGreaterThan(0);

    const stores = createInMemoryIntelligenceStores();
    seedFromHarvestResult(stores, runId, harvestResult);

    const intelligence = createIntelligencePipeline(stores);
    const intelResult = await intelligence.run(runId, {
      queryTerms: ["spreadsheet", "tooling"],
    });

    expect(intelResult.evidence.length).toBeGreaterThanOrEqual(3);
    expect(intelResult.drafts.length).toBeGreaterThanOrEqual(1);

    const evidenceById = new Map(intelResult.evidence.map((item) => [item.id, item]));
    const chunksById = new Map(harvestResult.chunks.map((chunk) => [chunk.id, chunk]));
    const signalsById = new Map(harvestResult.signals.map((signal) => [signal.id, signal]));

    const { admitted, rejected } = admitToLibrary(
      intelResult.drafts,
      evidenceById,
      chunksById,
      signalsById,
    );

    expect(admitted.length).toBeGreaterThanOrEqual(1);
    expect(admitted[0]?.status).toBe("hypothesis");
    expect(admitted[0]?.evidenceItemIds.length).toBeGreaterThanOrEqual(3);

    const synthesisDraft = intelResult.drafts.find((draft) =>
      String(draft.clusterId).includes("synthesis"),
    );
    expect(synthesisDraft).toBeDefined();
    if (synthesisDraft && synthesisDraft.disconfirmingSignalIds.length > 0) {
      expect(
        synthesisDraft.disconfirmingSignalIds.every((id) => signalsById.has(id)),
      ).toBe(true);
    }

    expect(rejected.length).toBeLessThan(intelResult.drafts.length);
  });
});
