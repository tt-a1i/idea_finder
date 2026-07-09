import { describe, expect, it } from "vitest";

import { asId } from "@idea-finder/core";

import {
  createInMemoryIntelligenceStores,
  createIntelligencePipeline,
} from "./index.js";

describe("@idea-finder/intelligence", () => {
  it("creates deterministic intelligence pipeline without LLM", async () => {
    const stores = createInMemoryIntelligenceStores();
    const pipeline = createIntelligencePipeline(stores);
    const result = await pipeline.run(asId("run_empty"));
    expect(result.evidence).toEqual([]);
    expect(result.drafts).toEqual([]);
  });
});
