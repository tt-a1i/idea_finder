import type { EvidenceItem, OpportunityDraft, ResearchRunId } from "@idea-finder/core";

/** Persist intelligence outputs per research run. */
export interface RunScopedWriter<T extends { id: string }> {
  save(runId: ResearchRunId, entity: T): void;
  listByRun(runId: ResearchRunId): readonly T[];
}

export interface IntelligenceWritePorts {
  readonly evidence: RunScopedWriter<EvidenceItem>;
  readonly drafts: RunScopedWriter<OpportunityDraft>;
}
