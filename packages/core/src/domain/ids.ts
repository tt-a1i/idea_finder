/** Branded identifier strings for domain entities. */
export type EntityId = string & { readonly __brand: "EntityId" };

export type RawDocumentId = EntityId;
export type ChunkId = EntityId;
export type RawSignalId = EntityId;
export type EvidenceItemId = EntityId;
export type OpportunityId = EntityId;
export type OpportunityDraftId = EntityId;
export type CalibrationEventId = EntityId;
export type ResearchRunId = EntityId;
export type HuntingTaskId = EntityId;
export type SignalClusterId = EntityId;
export type AgentRunId = EntityId;
export type ValidationExperimentId = EntityId;
export type MonitorScheduleId = EntityId;
export type MetricObservationId = EntityId;
export type TrendSeriesId = EntityId;
export type TrendEventId = EntityId;

export function asId<T extends EntityId>(value: string): T {
  return value as T;
}
