import type { Chunk, RawDocument, RawSignal, ResearchRunId } from "@idea-finder/core";

/** Read run-scoped harvest entities for intelligence. */
export interface RunScopedReader<T extends { id: string }> {
  listByRun(runId: ResearchRunId): readonly T[];
  get(id: string): T | null;
}

export interface IntelligenceReadPorts {
  readonly documents: RunScopedReader<RawDocument>;
  readonly chunks: RunScopedReader<Chunk>;
  readonly signals: RunScopedReader<RawSignal>;
}
