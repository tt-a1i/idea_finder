import type {
  CalibrationEvent,
  Chunk,
  EvidenceItem,
  HuntingTaskId,
  MonitorSchedule,
  Opportunity,
  OpportunityDraft,
  RawSignal,
  ResearchRun,
  ValidationExperiment,
} from "@idea-finder/core";
import type { DraftRejection } from "@idea-finder/core";
import type {
  AgentInvocationStatus,
  AgentKind,
  AgentPlannedEffect,
  PolicyDenial,
} from "@idea-finder/agents";
import type { ResearchRunExecution } from "./ports/research-runner.js";

export interface ManualImportConfig {
  readonly text: string;
  readonly url?: string;
  readonly title?: string;
}

export interface BriefSourceSearch {
  readonly platform: string;
  readonly terms: readonly string[];
  readonly limit?: number;
  readonly appId?: string;
  readonly stackExchangeSite?: string;
}

/** Optional harvest plan saved on the brief (manual imports and/or L0 searches). */
export interface BriefQueryPlan {
  readonly harvestMode?: "manual" | "l0";
  readonly searches?: readonly BriefSourceSearch[];
  readonly manualImports?: readonly ManualImportConfig[];
}

/** Local hunting brief — config for a demand research workspace slice. */
export interface HuntingBrief {
  readonly id: HuntingTaskId;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly lenses: readonly string[];
  readonly sourcesEnabled: readonly string[];
  readonly successCriteria: string;
  readonly createdAt: string;
  readonly queryPlan?: BriefQueryPlan;
}

export interface InboxSignalSummary {
  readonly signalType: string;
  readonly count: number;
  readonly sampleQuote: string;
}

export type AgentTaskStatus =
  | "pending"
  | "running"
  | "blocked"
  | "succeeded"
  | "failed";

export interface AgentTaskInvocation {
  readonly invocationId: string;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly policyAllowed: boolean;
  readonly policyDenials: readonly PolicyDenial[];
  readonly resultStatus: AgentInvocationStatus | null;
  readonly dryRun: boolean;
  readonly structured?: Readonly<Record<string, unknown>>;
}

export interface AgentTask {
  readonly id: string;
  readonly kind: AgentKind;
  readonly intent: string;
  readonly status: AgentTaskStatus;
  readonly opportunityId: string | null;
  readonly evidenceIds: readonly string[];
  readonly dryRun: boolean;
  readonly plannedEffects: readonly AgentPlannedEffect[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly invocations: readonly AgentTaskInvocation[];
}

export interface StoredResearchRun {
  readonly execution: ResearchRunExecution;
  readonly run: ResearchRun;
  readonly briefId: HuntingTaskId;
  readonly chunks: readonly Chunk[];
  readonly signals: readonly RawSignal[];
  readonly evidence: readonly EvidenceItem[];
  readonly drafts: readonly OpportunityDraft[];
  readonly rejected: readonly DraftRejection[];
  readonly admittedCount: number;
  readonly inbox: readonly InboxSignalSummary[];
}

export interface WorkspaceState {
  readonly version: 1;
  readonly runs: readonly StoredResearchRun[];
  readonly opportunities: Readonly<Record<string, Opportunity>>;
  readonly calibrationEvents: readonly CalibrationEvent[];
  readonly evidenceById: Readonly<Record<string, EvidenceItem>>;
  readonly chunksById: Readonly<Record<string, Chunk>>;
  readonly signalsById: Readonly<Record<string, RawSignal>>;
  readonly agentTasks: Readonly<Record<string, AgentTask>>;
  readonly validationExperiments: Readonly<Record<string, ValidationExperiment>>;
  readonly monitorSchedules: Readonly<Record<string, MonitorSchedule>>;
}

export function emptyWorkspaceState(): WorkspaceState {
  return {
    version: 1,
    runs: [],
    opportunities: {},
    calibrationEvents: [],
    evidenceById: {},
    chunksById: {},
    signalsById: {},
    agentTasks: {},
    validationExperiments: {},
    monitorSchedules: {},
  };
}
