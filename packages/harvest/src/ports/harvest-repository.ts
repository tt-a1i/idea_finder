import type { Chunk, RawDocument, RawSignal, ResearchRunId } from "@idea-finder/core";

export interface HarvestResult {
  readonly documents: readonly RawDocument[];
  readonly chunks: readonly Chunk[];
  readonly signals: readonly RawSignal[];
  readonly sourceExecutions: readonly SourceExecutionResult[];
}

export type SourceExecutionOutcome = "success" | "failure" | "skipped" | "unauthorized" | "throttled" | "unavailable";

export interface SourceExecutionResult {
  readonly id: string;
  readonly source: string;
  readonly requestKey: string;
  readonly status: SourceExecutionOutcome;
  readonly itemCount: number;
  readonly reasonCode: "none" | "zero_results" | "unauthorized" | "throttled" | "unavailable" | "failed" | "connector_missing";
  readonly reason: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly retryAt: string | null;
}

/** Persistence port for harvest output until storage integration lands. */
export interface HarvestRepository {
  saveResult(runId: ResearchRunId, result: HarvestResult): Promise<void>;
  saveSourceResult(runId: ResearchRunId, result: Omit<HarvestResult, "sourceExecutions">, execution: SourceExecutionResult): Promise<void>;
  getResult(runId: ResearchRunId): Promise<HarvestResult | null>;
}
