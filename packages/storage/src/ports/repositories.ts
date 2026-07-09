import type {
  CalibrationEvent,
  Chunk,
  EvidenceItem,
  Opportunity,
  OpportunityDraft,
  RawDocument,
  RawSignal,
  ResearchRun,
  ResearchRunId,
} from "@idea-finder/core";

export interface ResearchRunRepository {
  get(id: ResearchRunId): ResearchRun | null;
  findByTaskAndConfig(
    huntingTaskId: string,
    configHash: string,
  ): ResearchRun | null;
  save(run: ResearchRun): void;
}

export interface RunScopedRepository<T extends { id: string }> {
  save(runId: ResearchRunId, entity: T): void;
  get(id: string): T | null;
  listByRun(runId: ResearchRunId): T[];
}

export type RawDocumentRepository = RunScopedRepository<RawDocument>;
export type ChunkRepository = RunScopedRepository<Chunk>;
export type RawSignalRepository = RunScopedRepository<RawSignal>;
export type EvidenceItemRepository = RunScopedRepository<EvidenceItem>;
export type OpportunityDraftRepository = RunScopedRepository<OpportunityDraft>;
export type OpportunityRepository = RunScopedRepository<Opportunity>;
export type CalibrationEventRepository = RunScopedRepository<CalibrationEvent>;

export interface PipelineStepStore {
  isComplete(runId: ResearchRunId, step: string): boolean;
  markComplete(runId: ResearchRunId, step: string): void;
}
