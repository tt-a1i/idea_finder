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

import type { HuntingBrief, SearchPlan } from "../types.js";
import type { ResearchRunner } from "../ports/research-runner.js";
import { runBroadResearchRounds } from "./broad-research-rounds.js";
import {
  buildQueryPlanFromBrief,
  effectiveResearchConfig,
  effectiveResearchConfigHash,
  queryTermsFromBrief,
  resolveHarvestMode,
} from "./query-plan-builder.js";

export interface OrchestrationRunnerOptions {
  readonly workspaceRoot: string;
  readonly harvestMode?: "manual" | "l0";
  readonly connectors?: readonly SourceConnector[];
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
    async run(brief, request) {
      const storage = openLocalStorage({ dataDir: pipelineDataDir });
      try {
        const harvestRepo = createStorageHarvestRepository(storage);
        const harvestMode = options.harvestMode ?? resolveHarvestMode(brief);
        const harvest = createHarvestPipeline({
          connectors: options.connectors ?? createConnectors(brief, harvestMode),
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

        const searchPlan = brief.searchPlanId
          ? (storage.searchPlans.get(brief.searchPlanId) as SearchPlan | null)
          : null;
        const effectiveConfig = effectiveResearchConfig(brief);
        const configHash = effectiveResearchConfigHash(brief);

        const run = request.execution === "new"
          ? orchestrator.createRun({
              runId: request.runId,
              huntingTaskId: request.taskId,
              configHash,
            })
          : orchestrator.getRun(request.runId);
        if (!run) {
          throw new Error(`ResearchRun not found: ${request.runId}`);
        }
        if (run.huntingTaskId !== request.taskId || run.configHash !== configHash) {
          throw new Error(`ResearchRun configuration mismatch: ${request.runId}`);
        }

        let researchLedger = undefined;
        let completed = run;
        const priorConfig = storage.researchRunConfigs.get(run.id) as import("../types.js").StoredResearchRunConfig | null;

        if (searchPlan?.status === "confirmed" && searchPlan.queries.length > 0 && harvestMode === "l0") {
          const roundResult = await runBroadResearchRounds({
            deps: { storage, harvest, intelligence, queryTermsFromBrief },
            brief,
            runId: run.id,
            plan: searchPlan,
            execution: request.execution,
            effectiveConfig,
            existingLedger: request.execution === "new" ? null : (priorConfig?.researchLedger ?? null),
          });
          researchLedger = roundResult.ledger;
          storage.searchPlans.save({
            ...searchPlan,
            queries: roundResult.queries,
            updatedAt: new Date().toISOString(),
          } as { readonly id: string });

          const queryPlan = buildQueryPlanFromBrief(brief, request.taskId, roundResult.queries);
          try {
            completed = await orchestrator.runPipeline(run.id, {
              queryPlan,
              skipHarvest: true,
              skipIntelligence: true,
            });
          } catch {
            completed = orchestrator.getRun(run.id) ?? run;
          }
        } else {
          const queryPlan = buildQueryPlanFromBrief(brief, request.taskId, searchPlan?.queries);
          try {
            completed = await orchestrator.runPipeline(run.id, { queryPlan });
          } catch {
            completed = orchestrator.getRun(run.id) ?? run;
          }
        }

        storage.researchRunConfigs.save({
          id: run.id,
          effectiveConfig,
          execution: request.execution,
          researchLedger: researchLedger ?? priorConfig?.researchLedger,
        });

        const documents = storage.rawDocuments.listByRun(run.id);
        const sourceStatuses = storage.sourceStatuses.listByRun(run.id) as never;

        return {
          execution: request.execution,
          run: completed,
          documents,
          chunks: storage.chunks.listByRun(run.id),
          signals: storage.rawSignals.listByRun(run.id),
          evidence: storage.evidenceItems.listByRun(run.id),
          drafts: storage.opportunityDrafts.listByRun(run.id),
          opportunities: storage.opportunities.listByRun(run.id),
          admissionResults: storage.libraryAdmissionResults.listByRun(run.id) as never,
          sourceStatuses,
          config: {
            id: run.id,
            effectiveConfig,
            execution: request.execution,
            researchLedger,
          },
        };
      } finally {
        storage.close();
      }
    },
  };
}
