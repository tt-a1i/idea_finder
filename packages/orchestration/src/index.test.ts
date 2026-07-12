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
  it("marks mixed source outcomes partial and retries only failed requests to recovery", async () => {
    const dataDir = tempDataDir();
    try {
      const storage = openLocalStorage({ dataDir });
      let attempt = 0;
      let intelligenceCount = 0;
      const skippedKeys: string[][] = [];
      const status = (id: string, source: string, value: "success" | "throttled", reason: string | null) => ({
        id, requestKey: id, source, status: value, itemCount: value === "success" ? 1 : 0,
        reasonCode: value === "success" ? "none" as const : "throttled" as const, reason,
        startedAt: "2026-07-11T00:00:00.000Z", completedAt: "2026-07-11T00:00:01.000Z", retryAt: value === "throttled" ? "2026-07-11T00:01:00.000Z" : null,
      });
      const orchestrator = createResearchRunOrchestrator({
        stores: storage,
        harvest: { async runHarvest(_runId, _plan, options) {
          attempt += 1;
          skippedKeys.push([...options?.completedRequestKeys ?? []]);
          return { documents: [], chunks: [], signals: [], sourceExecutions: attempt === 1
            ? [status("search:0:hn", "hn", "success", null), status("search:1:v2ex", "v2ex", "throttled", "429 rate limited")]
            : [status("search:1:v2ex", "v2ex", "success", null)] };
        } },
        intelligence: { async run() { intelligenceCount += 1; } },
      });
      const run = orchestrator.createRun({ huntingTaskId: asId("task-partial"), configHash: "cfg_partial" });
      const partial = await orchestrator.runPipeline(run.id, { queryPlan: testQueryPlan(run.huntingTaskId) });
      expect(partial).toMatchObject({ status: "partial", errorMessage: "429 rate limited" });
      expect(intelligenceCount).toBe(1);
      expect(storage.pipelineSteps.isComplete(run.id, PIPELINE_STEPS.intelligence)).toBe(false);
      expect(storage.sourceStatuses.listByRun(run.id)).toEqual(expect.arrayContaining([expect.objectContaining({ id: "search:0:hn", status: "success" }), expect.objectContaining({ id: "search:1:v2ex", status: "throttled" })]));
      const recovered = await orchestrator.runPipeline(run.id, { queryPlan: testQueryPlan(run.huntingTaskId) });
      expect(recovered).toMatchObject({ status: "completed", errorMessage: null });
      expect(intelligenceCount).toBe(2);
      expect(storage.pipelineSteps.isComplete(run.id, PIPELINE_STEPS.intelligence)).toBe(true);
      expect(skippedKeys[1]).toEqual(["search:0:hn"]);
      expect(storage.sourceStatuses.listByRun(run.id).find((item) => item.id === "search:1:v2ex")).toMatchObject({ status: "success" });
      storage.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it("re-runs intelligence after partial recovery even if a prior pass marked the step complete", async () => {
    const dataDir = tempDataDir();
    try {
      const storage = openLocalStorage({ dataDir });
      let attempt = 0;
      let intelligenceCount = 0;
      const status = (id: string, value: "success" | "throttled") => ({
        id, requestKey: id, source: "hn", status: value, itemCount: value === "success" ? 1 : 0,
        reasonCode: value === "success" ? "none" as const : "throttled" as const,
        reason: value === "success" ? null : "429",
        startedAt: "2026-07-11T00:00:00.000Z", completedAt: "2026-07-11T00:00:01.000Z",
        retryAt: value === "throttled" ? "2026-07-11T00:01:00.000Z" : null,
      });
      const orchestrator = createResearchRunOrchestrator({
        stores: storage,
        harvest: {
          async runHarvest() {
            attempt += 1;
            return {
              documents: [], chunks: [], signals: [],
              sourceExecutions: attempt === 1
                ? [status("search:0:hn", "success"), status("search:1:v2ex", "throttled")]
                : [status("search:1:v2ex", "success")],
            };
          },
        },
        intelligence: { async run() { intelligenceCount += 1; } },
      });
      const run = orchestrator.createRun({ huntingTaskId: asId("task-legacy-partial"), configHash: "cfg_legacy" });
      await orchestrator.runPipeline(run.id, { queryPlan: testQueryPlan(run.huntingTaskId) });
      // Simulate older builds that marked intelligence complete while still partial.
      storage.pipelineSteps.markComplete(run.id, PIPELINE_STEPS.intelligence);
      storage.pipelineSteps.markComplete(run.id, PIPELINE_STEPS.libraryAdmission);
      expect(intelligenceCount).toBe(1);
      const recovered = await orchestrator.runPipeline(run.id, { queryPlan: testQueryPlan(run.huntingTaskId) });
      expect(recovered.status).toBe("completed");
      expect(intelligenceCount).toBe(2);
      storage.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
  it("wires harvest and intelligence scaffolds", async () => {
    const plan = testQueryPlan();
    const engine = createOrchestrationEngine({
      harvest: { runHarvest: async () => ({ documents: [], chunks: [], signals: [], sourceExecutions: [] }) },
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

  it("creates distinct runs for equal huntingTaskId + configHash", () => {
    const dataDir = tempDataDir();
    try {
      const storage = openLocalStorage({ dataDir });
      const orchestrator = createResearchRunOrchestrator({
        stores: storage,
        harvest: createFixtureHarvest(storage),
        intelligence: createFixtureIntelligence(storage),
      });

      const run1 = orchestrator.createRun({
        huntingTaskId: asId("task-1"),
        configHash: "cfg_v1",
      });
      const run2 = orchestrator.createRun({
        huntingTaskId: asId("task-1"),
        configHash: "cfg_v1",
      });

      expect(run1.id).not.toBe(run2.id);
      expect(run1.configHash).toBe(run2.configHash);
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

      const run = orchestrator.createRun({
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

      const run = orchestrator.createRun({
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

  it("retries a failed run with the same identity and skips completed steps", async () => {
    const dataDir = tempDataDir();
    try {
      const storage = openLocalStorage({ dataDir });
      let harvestCount = 0;
      let intelligenceCount = 0;
      const fixtureHarvest = createFixtureHarvest(storage);
      const fixtureIntelligence = createFixtureIntelligence(storage);
      const plan = testQueryPlan(asId("task-retry"));
      const orchestrator = createResearchRunOrchestrator({
        stores: storage,
        harvest: {
          runHarvest: async (runId, queryPlan) => {
            harvestCount += 1;
            return fixtureHarvest.runHarvest(runId, queryPlan);
          },
        },
        intelligence: {
          run: async (runId) => {
            intelligenceCount += 1;
            if (intelligenceCount === 1) throw new Error("transient intelligence failure");
            return fixtureIntelligence.run(runId);
          },
        },
      });
      const run = orchestrator.createRun({
        huntingTaskId: asId("task-retry"),
        configHash: "cfg_retry",
      });

      await expect(orchestrator.runPipeline(run.id, { queryPlan: plan })).rejects.toThrow("transient intelligence failure");
      expect(orchestrator.getRun(run.id)?.status).toBe("failed");
      const retried = await orchestrator.runPipeline(run.id, { queryPlan: plan });

      expect(retried.id).toBe(run.id);
      expect(retried.status).toBe("completed");
      expect(harvestCount).toBe(1);
      expect(intelligenceCount).toBe(2);
      storage.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
