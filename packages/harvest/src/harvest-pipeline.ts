import type { ResearchRunId } from "@idea-finder/core";
import type { SourceConnector } from "@idea-finder/connectors";
import type { JobQueue } from "@idea-finder/storage";

/** Ingest boundary: connectors → normalize → chunk. Implementation deferred. */
export interface HarvestPipelineDeps {
  readonly connectors: readonly SourceConnector[];
  readonly queue: JobQueue;
}

export interface HarvestPipeline {
  /**
   * Runs harvest for a research run and resolves only after harvest output
   * (normalized chunks/signals) is ready for the intelligence stage.
   * Not a fire-and-forget enqueue — callers may await before intelligence.
   */
  runHarvest(runId: ResearchRunId): Promise<void>;
}

export function createHarvestPipeline(_deps: HarvestPipelineDeps): HarvestPipeline {
  return {
    async runHarvest(_runId: ResearchRunId): Promise<void> {
      // Wave 1 scaffold — resolves when harvest output is ready (no-op for now).
    },
  };
}
