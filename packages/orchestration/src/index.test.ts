import { describe, expect, it } from "vitest";

import { createOrchestrationEngine } from "./index.js";

describe("@idea-finder/orchestration", () => {
  it("wires harvest and intelligence scaffolds", async () => {
    const engine = createOrchestrationEngine({
      harvest: { runHarvest: async () => undefined },
      intelligence: { run: async () => undefined },
    });
    await expect(engine.startResearchRun("run_1" as never)).resolves.toBeUndefined();
  });

  it("startResearchRun awaits harvest before intelligence", async () => {
    const order: string[] = [];

    const engine = createOrchestrationEngine({
      harvest: {
        runHarvest: async () => {
          order.push("harvest");
        },
      },
      intelligence: {
        run: async () => {
          order.push("intelligence");
        },
      },
    });

    await engine.startResearchRun("run_1" as never);
    expect(order).toEqual(["harvest", "intelligence"]);
  });
});
