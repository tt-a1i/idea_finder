import type { HuntingTaskId, ResearchRunId } from "@idea-finder/core";
import type {
  Chunk,
  EvidenceItem,
  OpportunityDraft,
  RawSignal,
  ResearchRun,
  RawDocument,
} from "@idea-finder/core";
import type { HuntingBrief } from "../types.js";
import type { LibraryAdmissionRecord, ResearchSourceStatus, StoredResearchRunConfig } from "../types.js";

/** Harvest + intelligence output before library admission. */
export interface ResearchRunOutput {
  readonly execution: ResearchRunExecution;
  readonly run: ResearchRun;
  readonly documents: readonly RawDocument[];
  readonly chunks: readonly Chunk[];
  readonly signals: readonly RawSignal[];
  readonly evidence: readonly EvidenceItem[];
  readonly drafts: readonly OpportunityDraft[];
  readonly opportunities: readonly import("@idea-finder/core").Opportunity[];
  readonly admissionResults: readonly LibraryAdmissionRecord[];
  readonly sourceStatuses: readonly ResearchSourceStatus[];
  readonly config: StoredResearchRunConfig;
}

export type ResearchRunExecution = "new" | "retried" | "resumed";

export interface ResearchRunRequest {
  readonly runId: ResearchRunId;
  readonly taskId: HuntingTaskId;
  readonly execution: ResearchRunExecution;
}

/** Port for running a research pipeline (Bisheng harvest + Ganjiang intelligence). */
export interface ResearchRunner {
  run(
    brief: HuntingBrief,
    request: ResearchRunRequest,
  ): Promise<ResearchRunOutput>;
}

export interface ResearchRunnerFactory {
  createResearchRun(brief: HuntingBrief): ResearchRun;
}
