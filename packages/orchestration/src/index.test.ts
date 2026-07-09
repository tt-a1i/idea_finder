import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { asId } from "@idea-finder/core";
import { openLocalStorage } from "@idea-finder/storage";

import {
  createResearchRunOrchestrator,
  PIPELINE_STEPS,
} from "./index.js";
import { createOrchestrationEngine } from "./orchestration-engine.js";
import {
  createFixtureHarvest,
  createFixtureIntelligence,
  testQueryPlan,
} from "./test-fixtures.js";

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "idea-finder-orchestration-"));
}

describe("@idea-finder/orchestration", () => {
  it("wires harvest and intelligence scaffolds", async () => {
    const plan = testQueryPlan();
    const engine = createOrchestrationEngine({
      harvest: { runHarvest: async () => ({ documents: [], chunks: [], signals: [] }) },
      intelligence: { run: async () => undefined },
    });
    await expect(
      engine.startResearchRun("run_1" as never, plan),
    ).resolves.toBeUndefined();
  });

  it("startResearchRun awaits harvest before intelligence", async () => {
    const order: string[] = [];
    const plan = testQueryPlan();

    const engine = createOrchestrationEngine({
      harvest: {
        runHarvest: async () => {
          order.push("harvest");
          return { documents: [], chunks: [], signals: [] };
        },
      },
      intelligence: {
        run: async () => {
          order.push("intelligence");
        },
      },
    });

    await engine.startResearchRun("run_1" as never, plan);
    expect(order).toEqual(["harvest", "intelligence"]);
  });

  it("creates runs idempotently by huntingTaskId + configHash", () => {
    const dataDir = tempDataDir();
    try {
      const storage = openLocalStorage({ dataDir });
      const orchestrator = createResearchRunOrchestrator({
        stores: storage,
        harvest: createFixtureHarvest(storage),
        intelligence: createFixtureIntelligence(storage),
      });

      const run1 = orchestrator.createOrGetRun({
        huntingTaskId: asId("task-1"),
        configHash: "cfg_v1",
      });
      const run2 = orchestrator.createOrGetRun({
        huntingTaskId: asId("task-1"),
        configHash: "cfg_v1",
      });

      expect(run1.id).toBe(run2.id);
      storage.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("runs full pipeline harvest -> intelligence -> library -> board-ready", async () => {
    const dataDir = tempDataDir();
    try {
      const storage = openLocalStorage({ dataDir });
      const harvestCalls: string[] = [];
      const intelligenceCalls: string[] = [];

      const fixtureHarvest = createFixtureHarvest(storage);
      const fixtureIntelligence = createFixtureIntelligence(storage);
      const plan = testQueryPlan(asId("task-pipeline"));

      const orchestrator = createResearchRunOrchestrator({
        stores: storage,
        harvest: {
          runHarvest: async (runId, queryPlan) => {
            harvestCalls.push(runId);
            await fixtureHarvest.runHarvest(runId, queryPlan);
            return { documents: [], chunks: [], signals: [] };
          },
        },
        intelligence: {
          run: async (runId) => {
            intelligenceCalls.push(runId);
            await fixtureIntelligence.run(runId);
          },
        },
      });

      const run = orchestrator.createOrGetRun({
        huntingTaskId: asId("task-pipeline"),
        configHash: "cfg_pipeline",
      });

      const completed = await orchestrator.runPipeline(run.id, { queryPlan: plan });

      expect(completed.status).toBe("completed");
      expect(harvestCalls).toEqual([run.id]);
      expect(intelligenceCalls).toEqual([run.id]);
      expect(storage.pipelineSteps.isComplete(run.id, PIPELINE_STEPS.harvest)).toBe(
        true,
      );
      expect(
        storage.pipelineSteps.isComplete(run.id, PIPELINE_STEPS.intelligence),
      ).toBe(true);
      expect(
        storage.pipelineSteps.isComplete(run.id, PIPELINE_STEPS.libraryAdmission),
      ).toBe(true);

      const opportunities = storage.opportunities.listByRun(run.id);
      expect(opportunities).toHaveLength(1);
      expect(opportunities[0]?.status).toBe("hypothesis");
      expect(opportunities[0]?.demandStatement).toContain("invoicing");

      storage.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("re-running pipeline is idempotent and skips completed steps", async () => {
    const dataDir = tempDataDir();
    try {
      const storage = openLocalStorage({ dataDir });
      let harvestCount = 0;
      let intelligenceCount = 0;

      const fixtureHarvest = createFixtureHarvest(storage);
      const fixtureIntelligence = createFixtureIntelligence(storage);
      const plan = testQueryPlan(asId("task-idempotent"));

      const orchestrator = createResearchRunOrchestrator({
        stores: storage,
        harvest: {
          runHarvest: async (runId, queryPlan) => {
            harvestCount += 1;
            await fixtureHarvest.runHarvest(runId, queryPlan);
            return { documents: [], chunks: [], signals: [] };
          },
        },
        intelligence: {
          run: async (runId) => {
            intelligenceCount += 1;
            await fixtureIntelligence.run(runId);
          },
        },
      });

      const run = orchestrator.createOrGetRun({
        huntingTaskId: asId("task-idempotent"),
        configHash: "cfg_idem",
      });

      await orchestrator.runPipeline(run.id, { queryPlan: plan });
      await orchestrator.runPipeline(run.id, { queryPlan: plan });

      expect(harvestCount).toBe(1);
      expect(intelligenceCount).toBe(1);
      expect(storage.opportunities.listByRun(run.id)).toHaveLength(1);

      const reloaded = openLocalStorage({ dataDir });
      expect(reloaded.researchRuns.get(run.id)?.status).toBe("completed");
      expect(reloaded.opportunities.listByRun(run.id)).toHaveLength(1);
      reloaded.close();
      storage.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
