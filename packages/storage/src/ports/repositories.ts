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
  MetricObservation,
  TrendEvent,
  TrendSeries,
  GitHubMetric,
  GoogleTrendsMetric,
  PackageDownloadMetric,
  PackageEcosystem,
  GoogleTrendsNormalizationContext,
  MultiLaneSummaryV1,
  ResearchClaim,
  EvidenceIndependenceRecord,
  FollowUpHuntingTaskProposal,
} from "@idea-finder/core";

export interface ResearchRunRepository {
  get(id: ResearchRunId): ResearchRun | null;
  list(): ResearchRun[];
  listByTask(huntingTaskId: string): ResearchRun[];
  save(run: ResearchRun): void;
}

export interface JsonEntityRepository<T extends { readonly id: string }> {
  get(id: string): T | null;
  list(): T[];
  save(entity: T): void;
}

export interface RunScopedRepository<T extends { id: string }> {
  save(runId: ResearchRunId, entity: T): void;
  get(runId: ResearchRunId, id: string): T | null;
  listByRun(runId: ResearchRunId): T[];
  delete(runId: ResearchRunId, id: string): void;
}

export type RawDocumentRepository = RunScopedRepository<RawDocument>;
export type ChunkRepository = RunScopedRepository<Chunk>;
export type RawSignalRepository = RunScopedRepository<RawSignal>;
export type EvidenceItemRepository = RunScopedRepository<EvidenceItem>;
export type OpportunityDraftRepository = RunScopedRepository<OpportunityDraft>;
export type OpportunityRepository = RunScopedRepository<Opportunity>;
export interface CalibrationEventRepository {
  append(runId: ResearchRunId, event: CalibrationEvent): void;
  get(runId: ResearchRunId, id: string): CalibrationEvent | null;
  listByRun(runId: ResearchRunId): CalibrationEvent[];
}

export interface QuantitativeListFilter {
  readonly source?: MetricObservation["source"];
  readonly subjectExternalId?: string;
  readonly metric?: GitHubMetric | GoogleTrendsMetric | PackageDownloadMetric;
  readonly geography?: string;
  readonly normalizationContextId?: string;
  readonly ecosystem?: PackageEcosystem;
  readonly packageName?: string;
  readonly windowStartAt?: string;
  readonly windowEndAt?: string;
}

export interface NormalizationContextRepository {
  save(context: GoogleTrendsNormalizationContext): void;
  get(id: string): GoogleTrendsNormalizationContext | null;
  list(): GoogleTrendsNormalizationContext[];
}

export interface MetricObservationRepository {
  save(observation: MetricObservation): void;
  get(id: string): MetricObservation | null;
  list(filter?: QuantitativeListFilter): MetricObservation[];
}

export interface TrendSeriesRepository {
  save(series: TrendSeries): void;
  get(id: string): TrendSeries | null;
  list(filter?: QuantitativeListFilter): TrendSeries[];
  delete(id: string): void;
}

export interface TrendEventRepository {
  append(event: TrendEvent): void;
  get(id: string): TrendEvent | null;
  listBySeries(seriesId: string): TrendEvent[];
  deleteBySeries(seriesId: string): void;
}

export interface StoredMultiLaneReportRecord {
  readonly id: string;
  readonly runId: ResearchRunId;
  readonly briefId: string;
  readonly summary: MultiLaneSummaryV1;
  readonly claims: readonly ResearchClaim[];
  readonly candidateIds: readonly string[];
  readonly seriesSnapshots: readonly TrendSeries[];
  readonly observationSnapshots: readonly MetricObservation[];
}

export interface MultiLaneReportRepository {
  save(record: StoredMultiLaneReportRecord): void;
  getByRun(runId: ResearchRunId): StoredMultiLaneReportRecord | null;
  listByClaim(claimId: string): StoredMultiLaneReportRecord[];
}

export interface EvidenceIndependenceRepository {
  saveIndex(runId: ResearchRunId, records: readonly EvidenceIndependenceRecord[]): void;
  save(runId: ResearchRunId, record: EvidenceIndependenceRecord): void;
  getByDocument(runId: ResearchRunId, documentId: string): EvidenceIndependenceRecord | null;
  listByRun(runId: ResearchRunId): EvidenceIndependenceRecord[];
  listByGroup(runId: ResearchRunId, groupId: string): EvidenceIndependenceRecord[];
}

export interface FollowUpProposalRepository {
  save(runId: ResearchRunId, proposal: FollowUpHuntingTaskProposal): void;
  get(runId: ResearchRunId, id: string): FollowUpHuntingTaskProposal | null;
  listByRun(runId: ResearchRunId): FollowUpHuntingTaskProposal[];
}

export interface PipelineStepStore {
  isComplete(runId: ResearchRunId, step: string): boolean;
  markComplete(runId: ResearchRunId, step: string): void;
}
