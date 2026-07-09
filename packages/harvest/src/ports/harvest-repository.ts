import type { Chunk, RawDocument, RawSignal, ResearchRunId } from "@idea-finder/core";

export interface HarvestResult {
  readonly documents: readonly RawDocument[];
  readonly chunks: readonly Chunk[];
  readonly signals: readonly RawSignal[];
}

/** Persistence port for harvest output until storage integration lands. */
export interface HarvestRepository {
  saveResult(runId: ResearchRunId, result: HarvestResult): Promise<void>;
  getResult(runId: ResearchRunId): Promise<HarvestResult | null>;
}
