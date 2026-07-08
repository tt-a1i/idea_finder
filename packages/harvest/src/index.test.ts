import { describe, expect, it } from "vitest";

import { createHarvestPipeline } from "./index.js";

describe("@idea-finder/harvest", () => {
  it("creates a no-op harvest pipeline scaffold", async () => {
    const pipeline = createHarvestPipeline({
      connectors: [],
      queue: { enqueue: async () => ({ id: "1", type: "t", payload: {}, idempotencyKey: "k", status: "pending" }) },
    });
    await expect(pipeline.runHarvest("run_1" as never)).resolves.toBeUndefined();
  });
});
