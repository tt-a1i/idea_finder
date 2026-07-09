import type { ResearchRunId } from "@idea-finder/core";
import type { QueryPlan } from "@idea-finder/connectors";
import type { HarvestPipeline } from "@idea-finder/harvest";
import type { IntelligencePipeline } from "@idea-finder/intelligence";

/** Run DAG + human gates. Implementation deferred. */
export interface OrchestrationEngineDeps {
  readonly harvest: HarvestPipeline;
  readonly intelligence: IntelligencePipeline;
}

export interface OrchestrationEngine {
  startResearchRun(runId: ResearchRunId, queryPlan: QueryPlan): Promise<void>;
}

export function createOrchestrationEngine(deps: OrchestrationEngineDeps): OrchestrationEngine {
  return {
    async startResearchRun(runId: ResearchRunId, queryPlan: QueryPlan): Promise<void> {
      await deps.harvest.runHarvest(runId, queryPlan);
      await deps.intelligence.run(runId);
    },
  };
}
