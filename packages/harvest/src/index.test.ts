import { describe, expect, it } from "vitest";

import { asId } from "@idea-finder/core";
import { createManualImportConnector } from "@idea-finder/connectors";

import { createHarvestPipeline } from "./index.js";
import { InMemoryHarvestRepository } from "./in-memory-harvest-repository.js";

describe("@idea-finder/harvest", () => {
  it("harvests manual import without remote connectors", async () => {
    const repository = new InMemoryHarvestRepository();
    const pipeline = createHarvestPipeline({
      connectors: [createManualImportConnector()],
      repository,
    });
    const runId = asId("run_manual");
    const taskId = asId("task_manual");
    const result = await pipeline.runHarvest(runId, {
      huntingTaskId: taskId,
      searches: [],
      manualImports: [{ text: "Painful workaround — would pay for better tooling." }],
    });
    expect(result.documents).toHaveLength(1);
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.signals.length).toBeGreaterThan(0);
    await expect(repository.getResult(runId)).resolves.toEqual(result);
  });
});
