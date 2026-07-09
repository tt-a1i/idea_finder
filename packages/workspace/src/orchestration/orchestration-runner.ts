import { join } from "node:path";

import {
  createL0ConnectorPack,
  createManualImportConnector,
  type SourceConnector,
} from "@idea-finder/connectors";
import { createHarvestPipeline } from "@idea-finder/harvest";
import { createIntelligencePipeline } from "@idea-finder/intelligence";
import {
  createResearchRunOrchestrator,
  createStorageHarvestRepository,
} from "@idea-finder/orchestration";
import { openLocalStorage } from "@idea-finder/storage";

import type { HuntingBrief } from "../types.js";
import type { ResearchRunner } from "../ports/research-runner.js";
import {
  buildQueryPlanFromBrief,
  queryTermsFromBrief,
  resolveHarvestMode,
} from "./query-plan-builder.js";

export interface OrchestrationRunnerOptions {
  readonly workspaceRoot: string;
  readonly harvestMode?: "manual" | "l0";
}

function createConnectors(
  brief: HuntingBrief,
  overrideMode?: "manual" | "l0",
): SourceConnector[] {
  const mode = overrideMode ?? resolveHarvestMode(brief);
  if (mode === "l0") {
    return createL0ConnectorPack();
  }
  return [createManualImportConnector()];
}

export function createOrchestrationResearchRunner(
  options: OrchestrationRunnerOptions,
): ResearchRunner {
  const pipelineDataDir = join(options.workspaceRoot, "pipeline");

  return {
    async run(brief, _runId, taskId) {
      const storage = openLocalStorage({ dataDir: pipelineDataDir });
      try {
        const harvestRepo = createStorageHarvestRepository(storage);
        const harvestMode = options.harvestMode ?? resolveHarvestMode(brief);
        const harvest = createHarvestPipeline({
          connectors: createConnectors(brief, harvestMode),
          repository: harvestRepo,
        });

        const intelligence = createIntelligencePipeline({
          documents: storage.rawDocuments,
          chunks: storage.chunks,
          signals: storage.rawSignals,
          evidence: storage.evidenceItems,
          drafts: storage.opportunityDrafts,
        });

        const orchestrator = createResearchRunOrchestrator({
          stores: storage,
          harvest,
          intelligence: {
            run: (runId) =>
              intelligence.run(runId, { queryTerms: queryTermsFromBrief(brief) }),
          },
        });

        const queryPlan = buildQueryPlanFromBrief(brief, taskId);
        const configHash = `cfg_${brief.slug}`;

        const run = orchestrator.createOrGetRun({
          huntingTaskId: taskId,
          configHash,
        });

        const completed = await orchestrator.runPipeline(run.id, { queryPlan });

        return {
          run: completed,
          chunks: storage.chunks.listByRun(run.id),
          signals: storage.rawSignals.listByRun(run.id),
          evidence: storage.evidenceItems.listByRun(run.id),
          drafts: storage.opportunityDrafts.listByRun(run.id),
        };
      } finally {
        storage.close();
      }
    },
  };
}
