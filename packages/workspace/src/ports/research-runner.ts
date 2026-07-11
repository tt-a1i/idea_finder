import type { HuntingTaskId, ResearchRunId } from "@idea-finder/core";
import type {
  Chunk,
  EvidenceItem,
  OpportunityDraft,
  RawSignal,
  ResearchRun,
} from "@idea-finder/core";
import type { HuntingBrief } from "../types.js";

/** Harvest + intelligence output before library admission. */
export interface ResearchRunOutput {
  readonly execution: ResearchRunExecution;
  readonly run: ResearchRun;
  readonly chunks: readonly Chunk[];
  readonly signals: readonly RawSignal[];
  readonly evidence: readonly EvidenceItem[];
  readonly drafts: readonly OpportunityDraft[];
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
