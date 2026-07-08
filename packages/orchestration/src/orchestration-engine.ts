import type { ResearchRunId } from "@idea-finder/core";
import type { HarvestPipeline } from "@idea-finder/harvest";
import type { IntelligencePipeline } from "@idea-finder/intelligence";

/** Run DAG + human gates. Implementation deferred. */
export interface OrchestrationEngineDeps {
  readonly harvest: HarvestPipeline;
  readonly intelligence: IntelligencePipeline;
}

export interface OrchestrationEngine {
  startResearchRun(runId: ResearchRunId): Promise<void>;
}

export function createOrchestrationEngine(deps: OrchestrationEngineDeps): OrchestrationEngine {
  return {
    async startResearchRun(runId: ResearchRunId): Promise<void> {
      await deps.harvest.runHarvest(runId);
      await deps.intelligence.run(runId);
    },
  };
}
